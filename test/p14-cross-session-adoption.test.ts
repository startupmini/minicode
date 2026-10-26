// P14 — fault-injection deterministik untuk adopsi pekerjaan lintas sesi.
//
// Setiap skenario adalah mutasi/penolakan yang bisa terjadi di produksi:
// lease hidup, lease kedaluwarsa, inkarnasi bergerak, revisi bergerak,
// tabrakan id, status terminal, lineage rusak, relasi menggantung, dan
// kegagalan tulis ledger. Tidak ada `sleep`; waktu dan kegagalan disuntikkan
// lewat parameter/trigger SQLite supaya hasilnya sama di mesin apa pun.

import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliSession } from "../cli/setup.ts"
import {
  AdoptionRefusedError,
  type AdoptUnfinishedTaskRequest,
  adoptUnfinishedTask,
  parseAdoptTaskArg,
} from "../src/session/cross-session-adoption.ts"
import { readWriterEpoch, StaleWriterError, saveSession } from "../src/session/persistence.ts"
import type { ContinuityEvidence, ContinuityGate } from "../src/task/continuity.ts"
import { TaskError, type TaskStatus } from "../src/task/model.ts"
import {
  type ExecutionObservation,
  Scheduler,
  type SchedulerEvent,
  type SchedulerWorkItem,
} from "../src/task/scheduler.ts"
import { SESSION_LEASE_MS } from "../src/task/session-authority.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

let dir: string
let store: TaskStore

// Id sesi sengaja bukan id yang dipakai suite lain; DB tetap terisolasi per
// test lewat mkdtemp, tetapi nama yang jelas membuat kegagalan mudah dibaca.
const S = "p14-source"
const T = "p14-target"
const TARGET_TOKEN = "p14-target-owner"
const BOOT = "p14-boot"
const prov = { origin: "model", source: "p14-test" } as const
const OK: ExecutionObservation = { kind: "returned", ok: true }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mc-p14-"))
  store = new TaskStore(dir, { authority: "SCHEDULER" })
  resetSessionOwnershipForTests()
})

afterEach(async () => {
  resetSessionOwnershipForTests()
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

// ── helpers ─────────────────────────────────────────────────────────────────

const dbPath = (): string => join(dir, ".minicode", "tasks.db")

/**
 * Opsi CLI minimal untuk scenario seam.
 *
 * Provider palsu ditulis ke `.minicode/config.json` (lalu `allowLocalConfig`)
 * supaya sesi bisa dibangun tanpa menyentuh home user: config asli di
 * `~/.minicode` tidak boleh memengaruhi hasil test, dan baseUrl lokalhost-9
 * menjamin tak ada panggilan jaringan pada konstruksi sesi.
 */
function cliOpts(): {
  cwd: string
  allowLocalConfig: true
  prompt: string
  enterRepl: false
  verbose: false
  allowAll: false
  ask: false
  plan: false
  allowlist: false
  verify: false
} {
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  writeFileSync(
    join(dir, ".minicode", "config.json"),
    JSON.stringify({
      providers: [
        { id: "fake", baseUrl: "http://127.0.0.1:9", apiKey: "sk-test", models: ["fake-model"] },
      ],
    }),
    "utf8",
  )
  return {
    cwd: dir,
    allowLocalConfig: true,
    prompt: "hi",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
  }
}

function add(
  sessionId: string,
  title: string,
  extra: { parentId?: string; dependsOn?: string[]; status?: TaskStatus } = {},
) {
  const order = store.listTasks(sessionId).length + 1
  return store.createTask(sessionId, {
    title,
    status: extra.status ?? "PENDING",
    order,
    ...(extra.parentId !== undefined ? { parentId: extra.parentId } : {}),
    ...(extra.dependsOn !== undefined ? { dependsOn: extra.dependsOn } : {}),
    provenance: prov,
  })
}

function claim(sessionId: string, taskId: string): number {
  const task = store.getTask(sessionId, taskId)
  if (task === null) throw new Error(`task ${sessionId}/${taskId} tidak ada`)
  const claimed = store.claimTask(sessionId, taskId, task.revision)
  if (claimed.outcome !== "CLAIM_ACCEPTED") {
    throw new Error(`claim ${sessionId}/${taskId} ditolak: ${claimed.outcome}`)
  }
  return claimed.execGeneration
}

/** Sesi tujuan memegang lease sebelum adopsi (komposisi root produksi). */
function holdTarget(now = Date.now(), token = TARGET_TOKEN): void {
  const acquired = store.acquireSessionAuthority(T, token, SESSION_LEASE_MS, now)
  expect(acquired).toBe("ACQUIRED")
}

function adopt(taskId: string, overrides: Partial<AdoptUnfinishedTaskRequest> = {}) {
  return adoptUnfinishedTask({
    sourceSessionId: S,
    targetSessionId: T,
    taskId,
    targetOwnerToken: TARGET_TOKEN,
    bootId: BOOT,
    cwd: dir,
    ...overrides,
  })
}

function raw(sql: string, ...params: (string | number | null)[]): void {
  const db = new Database(dbPath())
  try {
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}

/** Majukan jam lease tanpa tidur: baris lease dibuat kedaluwarsa. */
function expireLease(sessionId: string, token: string): void {
  raw(
    "UPDATE session_authority SET lease_expires_at = ? WHERE session_id = ? AND owner_token = ?",
    Date.now() - 1,
    sessionId,
    token,
  )
}

function gate(overrides: Partial<ContinuityEvidence> = {}): ContinuityGate {
  return {
    evidence: () => ({
      resume: true,
      missing: [],
      admission: "ALLOW",
      retrySafety: "READ_ONLY_TOOL_SCOPE",
      ...overrides,
    }),
  }
}

interface Harness {
  readonly sc: Scheduler
  readonly seen: SchedulerWorkItem[]
  readonly events: SchedulerEvent[]
}

function harness(
  sessionId: string,
  opts: {
    continuity?: ContinuityGate | null
    token?: string
    runTurn?: (work: SchedulerWorkItem) => ExecutionObservation | Promise<ExecutionObservation>
  } = {},
): Harness {
  const seen: SchedulerWorkItem[] = []
  const events: SchedulerEvent[] = []
  const continuity = opts.continuity === undefined ? gate() : opts.continuity
  const sc = new Scheduler(sessionId, {
    store,
    runTurn: async (work) => {
      seen.push(work)
      return opts.runTurn ? opts.runTurn(work) : OK
    },
    instruction: "do the work",
    authorityToken: opts.token ?? TARGET_TOKEN,
    ...(continuity !== null ? { continuity } : {}),
    onEvent: (event) => events.push(event),
  })
  return { sc, seen, events }
}

const held = (events: readonly SchedulerEvent[]) =>
  events.filter(
    (e): e is Extract<SchedulerEvent, { kind: "task:continuity_held" }> =>
      e.kind === "task:continuity_held",
  )

// ── 0. parser ───────────────────────────────────────────────────────────────

describe("P14 — bentuk argumen", () => {
  test("parse <source>/<taskId> menolak bentuk ambigu", () => {
    expect(parseAdoptTaskArg("alpha/t1")).toEqual({ sourceSessionId: "alpha", taskId: "t1" })
    expect(parseAdoptTaskArg("alpha/t1/")).toBeNull()
    expect(parseAdoptTaskArg("/t1")).toBeNull()
    expect(parseAdoptTaskArg("alpha/")).toBeNull()
    expect(parseAdoptTaskArg("alpha/not-a-task")).toBeNull()
    expect(parseAdoptTaskArg("alpha/beta/t2")).toEqual({
      sourceSessionId: "alpha-beta",
      taskId: "t2",
    })
  })
})

// ── 1. happy path + ledger + discovery + replay ─────────────────────────────

describe("P14 — jalur sukses", () => {
  test("1. transfer atomik: baris pindah, lineage utuh, ledger/discovery benar, replay ditolak", () => {
    holdTarget()
    const created = add(S, "carry me")
    claim(S, created.id)
    const before = store.getTask(S, created.id)!
    const lineageBefore = store.getExecutionLineage(S, created.id)
    const ownerBefore = store.getExecutionOwnership(S, created.id)

    const moved = adopt(created.id)
    expect(moved.outcome).toBe("ADOPTED")
    expect(moved.storeOutcome).toBe("TRANSFERRED")
    expect(moved.task?.id).toBe(created.id)

    expect(store.getTask(S, created.id)).toBeNull()
    const after = store.getTask(T, created.id)!
    expect(after.revision).toBe(before.revision + 1)
    expect(after.title).toBe(before.title)
    expect(after.status).toBe("IN_PROGRESS")
    expect(after.parentId).toBe(before.parentId)
    expect(after.dependsOn).toEqual(before.dependsOn)
    expect(after.provenance).toEqual(before.provenance)
    expect(store.getExecutionLineage(T, created.id)).toEqual(lineageBefore)
    expect(store.getExecutionOwnership(T, created.id)).toEqual(ownerBefore)

    const ledger = store.listTaskTransfers({
      fromSessionId: S,
      toSessionId: T,
      taskId: created.id,
    })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      taskId: created.id,
      fromSessionId: S,
      fromIncarnation: 1,
      toSessionId: T,
      toIncarnation: 1,
      expectedRevision: before.revision,
      newRevision: before.revision + 1,
      status: "IN_PROGRESS",
      execGeneration: 1,
      attemptGeneration: null,
      executionOwner: "scheduler",
    })

    // Lease sumber dilepas, lease tujuan tetap dipegang pemanggil.
    expect(store.getSessionAuthority(S)).toBeNull()
    expect(store.holdsSessionAuthority(T, TARGET_TOKEN)).toBe(true)

    // Discovery READ-ONLY: tidak mengakuisisi lease, tidak memutasi baris.
    const tasksBefore = store.listTasks(T)
    const transfersBefore = store.listTaskTransfers()
    const open = store.listUnfinishedWork()
    const item = open.find((i) => i.sessionId === T && i.task.id === created.id)
    expect(item).toBeDefined()
    expect(item?.transferredFromSessionId).toBe(S)
    expect(item?.transferredAt).toBe(ledger[0]!.transferredAt)
    expect(item?.sessionIncarnation).toBe(1)
    expect(store.listUnfinishedWork(S)).toEqual([])
    expect(store.listTasks(T)).toEqual(tasksBefore)
    expect(store.listTaskTransfers()).toEqual(transfersBefore)
    expect(store.getSessionAuthority(S)).toBeNull()

    // Replay adopsi tidak boleh menciptakan ledger kedua atau membangkitkan
    // generasi baru.
    const replay = adopt(created.id)
    expect(replay.outcome).toBe("NOT_FOUND")
    expect(
      store.listTaskTransfers({ fromSessionId: S, toSessionId: T, taskId: created.id }),
    ).toHaveLength(1)
    expect(store.getExecutionLineage(T, created.id)).toEqual(lineageBefore)

    // Transfer mentah dengan token lama juga NOT_FOUND (baris sudah tidak ada).
    const direct = store.transferTaskAuthority({
      taskId: created.id,
      fromSessionId: S,
      fromIncarnation: 1,
      toSessionId: T,
      toIncarnation: 1,
      expectedRevision: before.revision,
      sourceOwnerToken: "stale-source-token",
      targetOwnerToken: TARGET_TOKEN,
    })
    expect(direct.outcome).toBe("NOT_FOUND")
  })
})

// ── 2. otoritas ─────────────────────────────────────────────────────────────

describe("P14 — otoritas", () => {
  test("2. token sumber/target yang salah ditolak tanpa mutasi", () => {
    const now = Date.now()
    holdTarget(now)
    expect(store.acquireSessionAuthority(S, "source-holder", SESSION_LEASE_MS, now)).toBe(
      "ACQUIRED",
    )
    const created = add(S, "authority")

    const noSource = store.transferTaskAuthority({
      taskId: created.id,
      fromSessionId: S,
      fromIncarnation: 1,
      toSessionId: T,
      toIncarnation: 1,
      expectedRevision: created.revision,
      sourceOwnerToken: "not-the-holder",
      targetOwnerToken: TARGET_TOKEN,
      now,
    })
    expect(noSource.outcome).toBe("REFUSED_NO_SOURCE_AUTHORITY")
    expect(store.getTask(S, created.id)).not.toBeNull()

    expect(store.releaseSessionAuthority(S, "source-holder")).toBe(true)
    const noTarget = adopt(created.id, { targetOwnerToken: "not-the-target-holder" })
    expect(noTarget.outcome).toBe("REFUSED_TARGET_AUTHORITY")
    expect(store.getTask(S, created.id)).not.toBeNull()
    expect(store.getTask(T, created.id)).toBeNull()
    expect(store.listTaskTransfers()).toHaveLength(0)
    // Lease sumber yang sempat diambil untuk percobaan tetap dilepas.
    expect(store.getSessionAuthority(S)).toBeNull()
  })

  test("3. penulis sumber HIDUP: REFUSED_SOURCE_BUSY, bukan takeover paksa", () => {
    const now = Date.now()
    holdTarget(now)
    const created = add(S, "busy source")
    expect(store.acquireSessionAuthority(S, "live-source", SESSION_LEASE_MS, now)).toBe("ACQUIRED")

    const refused = adopt(created.id, { now })
    expect(refused.outcome).toBe("REFUSED_SOURCE_BUSY")
    expect(refused.sourceEpoch).toBeNull()
    expect(refused.fencedFormerOwner).toBe(false)
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("live-source")
    expect(store.getTask(S, created.id)).not.toBeNull()
    expect(store.getTask(T, created.id)).toBeNull()
    expect(store.listTaskTransfers()).toHaveLength(0)
    expect(store.releaseSessionAuthority(S, "live-source")).toBe(true)
  })
})

// ── 3. nilai yang bergerak ──────────────────────────────────────────────────

describe("P14 — pemeriksaan stale", () => {
  test("4. inkarnasi sumber basi: REJECTED_STALE_SOURCE_INCARNATION", () => {
    holdTarget()
    const created = add(S, "stale source incarnation")
    const oldIncarnation = store.getSessionIncarnation(S)
    store.bumpSessionIncarnation(S)

    const refused = adopt(created.id, { expectedSourceIncarnation: oldIncarnation })
    expect(refused.outcome).toBe("REJECTED_STALE_SOURCE_INCARNATION")
    expect(refused.detail).toContain(String(oldIncarnation))
    expect(store.getTask(S, created.id)).not.toBeNull()
    expect(store.getTask(T, created.id)).toBeNull()
    expect(store.listTaskTransfers()).toHaveLength(0)
  })

  test("5. inkarnasi target basi: REJECTED_STALE_TARGET_INCARNATION", () => {
    holdTarget()
    const created = add(S, "stale target incarnation")
    const oldIncarnation = store.getSessionIncarnation(T)
    store.bumpSessionIncarnation(T)
    // Lease baru untuk inkarnasi BARU; yang basi adalah nilai yang diharapkan.
    holdTarget()

    const refused = adopt(created.id, { expectedTargetIncarnation: oldIncarnation })
    expect(refused.outcome).toBe("REJECTED_STALE_TARGET_INCARNATION")
    expect(store.getTask(S, created.id)).not.toBeNull()
    expect(store.getTask(T, created.id)).toBeNull()
    expect(store.listTaskTransfers()).toHaveLength(0)
  })

  test("6. revisi basi: REJECTED_STALE_REVISION, revisi sumber tidak berubah", () => {
    holdTarget()
    const created = add(S, "stale revision")
    store.patchTask(S, created.id, { title: "newer title" })
    const current = store.getTask(S, created.id)!

    const refused = adopt(created.id, { expectedRevision: created.revision })
    expect(refused.outcome).toBe("REJECTED_STALE_REVISION")
    expect(store.getTask(S, created.id)).toEqual(current)
    expect(store.getTask(T, created.id)).toBeNull()
    expect(store.listTaskTransfers()).toHaveLength(0)
  })
})

// ── 4. tabrakan, status, lineage ────────────────────────────────────────────

describe("P14 — status/id/lineage", () => {
  test("7. tabrakan id target: REFUSED_TARGET_ID_CONFLICT, tanpa renumber", () => {
    holdTarget()
    const targetTask = add(T, "target t1")
    const sourceTask = add(S, "source t1")
    expect(targetTask.id).toBe("t1")
    expect(sourceTask.id).toBe("t1")

    const refused = adopt(sourceTask.id)
    expect(refused.outcome).toBe("REFUSED_TARGET_ID_CONFLICT")
    expect(store.getTask(S, sourceTask.id)?.title).toBe("source t1")
    expect(store.getTask(T, "t1")?.title).toBe("target t1")
    expect(store.listTaskTransfers()).toHaveLength(0)
  })

  test("8. status terminal tidak pernah diadopsi dan tidak muncul di discovery", () => {
    holdTarget()
    const created = add(S, "already done")
    store.patchTask(S, created.id, { status: "COMPLETED" })
    const done = store.getTask(S, created.id)!
    expect(store.listUnfinishedWork(S)).toEqual([])

    const refused = adopt(created.id)
    expect(refused.outcome).toBe("REFUSED_STATUS")
    expect(store.getTask(S, created.id)).toEqual(done)
    expect(store.getTask(T, created.id)).toBeNull()
    expect(store.listTaskTransfers()).toHaveLength(0)
  })

  test("12. lineage rusak (attempt > exec): REFUSED_CORRUPT_STATE", () => {
    holdTarget()
    const created = add(S, "corrupt lineage")
    claim(S, created.id)
    raw(
      "UPDATE tasks SET attempt_generation = 2 WHERE session_id = ? AND task_id = ?",
      S,
      created.id,
    )
    const broken = store.getTask(S, created.id)!

    const refused = adopt(created.id)
    expect(refused.outcome).toBe("REFUSED_CORRUPT_STATE")
    expect(refused.detail).toContain("exceeds exec_generation")
    expect(store.getTask(S, created.id)).toEqual(broken)
    expect(store.getTask(T, created.id)).toBeNull()
    expect(store.listTaskTransfers()).toHaveLength(0)
  })
})

// ── 5. fence pemilik lama ───────────────────────────────────────────────────

describe("P14 — fence lintas proses", () => {
  test("9. pemilik lama tidak bisa renew/release/dispatch/reconcile/menulis completion", async () => {
    // `.minicode` harus ada SEBELUM saveSession, kalau tidak resolveDbPath
    // jatuh ke DB global user dan tulisan epoch tak terlihat oleh test.
    // TaskStore (resolveLocalDbPath) membuat direktori itu; inisialisasi
    // eksplisit di sini membuat niat test terlihat, bukan kebetulan urutan.
    store.initialize()
    await saveSession(S, dir, undefined, [], undefined)
    holdTarget()
    const adopted = add(S, "adopt me")
    claim(S, adopted.id)
    const stranded = add(S, "stranded remains")
    claim(S, stranded.id)

    const beforeStranded = store.getTask(S, stranded.id)!
    const old = harness(S, { token: "old-owner-token" })
    old.sc.start()
    expect(store.holdsSessionAuthority(S, "old-owner-token")).toBe(true)

    // Simulasi proses lama yang berhenti memperbarui lease. Tidak ada sleep:
    // baris lease dibuat kedaluwarsa, persis seperti waktu yang berjalan.
    expireLease(S, "old-owner-token")
    expect(store.holdsSessionAuthority(S, "old-owner-token")).toBe(false)

    const moved = adopt(adopted.id)
    expect(moved.outcome).toBe("ADOPTED")
    expect(moved.fencedFormerOwner).toBe(true)
    expect(moved.sourceEpoch).not.toBeNull()
    expect(readWriterEpoch(S, dir)).toBe(moved.sourceEpoch ?? 0)

    // Scheduler lama tidak boleh reconcile/dispatch apa pun lagi.
    expect(old.sc.reconcile()).toEqual([])
    expect((await old.sc.cycle()).stop).toBe("not-running")
    expect(old.seen).toHaveLength(0)
    expect(store.getTask(S, stranded.id)).toEqual(beforeStranded)

    // Lease lama tidak bisa diperpanjang/dilepas.
    expect(store.renewSessionAuthority(S, "old-owner-token", SESSION_LEASE_MS)).toBe(
      "AUTHORITY_LOST",
    )
    expect(store.releaseSessionAuthority(S, "old-owner-token")).toBe(false)

    // Completion untuk task yang sudah pindah tidak punya baris di sumber.
    expect(() => store.patchTask(S, adopted.id, { status: "COMPLETED" })).toThrow(TaskError)
    expect(store.recordAttemptReturned(S, adopted.id, 1)).toBe("TASK_GONE")
    expect(store.getTask(T, adopted.id)?.status).toBe("IN_PROGRESS")

    // Pagar epoch durable: tulisan sessions.db dengan epoch lama ditolak.
    await expect(
      saveSession(S, dir, undefined, [], undefined, { expectedEpoch: 0 }),
    ).rejects.toBeInstanceOf(StaleWriterError)

    await old.sc.stop()
  })
})

// ── 6. pekerjaan in-flight setelah adopsi ───────────────────────────────────

describe("P14 — continuity setelah adopsi", () => {
  test("10. tanpa continuity gate: HOLD, baris tidak berubah, nol dispatch", async () => {
    holdTarget()
    const created = add(S, "in-flight hold")
    claim(S, created.id)
    expect(adopt(created.id).outcome).toBe("ADOPTED")
    const before = store.getTask(T, created.id)!

    const h = harness(T, { continuity: null })
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])
    expect(held(h.events)).toEqual([
      {
        kind: "task:continuity_held",
        taskId: created.id,
        class: "HOLD",
        reason: "resume-missing:continuity-gate-missing",
      },
    ])
    expect((await h.sc.cycle()).stop).toBe("no-candidates")
    expect(h.seen).toHaveLength(0)
    expect(store.getTask(T, created.id)).toEqual(before)
    await h.sc.stop()
  })

  test("11. SAFE_TO_RETRY: reconcile lalu claim generasi BARU, bukan replay jurnal", async () => {
    holdTarget()
    const created = add(S, "in-flight retry")
    const oldGeneration = claim(S, created.id)
    expect(adopt(created.id).outcome).toBe("ADOPTED")
    expect(store.getExecutionLineage(T, created.id)).toEqual({
      execGeneration: oldGeneration,
      attemptGeneration: null,
    })

    const h = harness(T)
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([created.id])
    const pending = store.getTask(T, created.id)!
    expect(pending.status).toBe("PENDING")
    expect(store.getExecutionLineage(T, created.id)).toEqual({
      execGeneration: oldGeneration,
      attemptGeneration: null,
    })
    expect(store.getExecutionOwnership(T, created.id)).toEqual({ executionOwner: null })

    const cycle = await h.sc.cycle()
    expect(cycle.stop).toBe("already-dispatched")
    expect(h.seen).toHaveLength(1)
    expect(h.seen[0]).toMatchObject({ taskId: created.id, sessionId: T })
    // Satu-satunya instruksi adalah template scheduler; tidak ada tool/journal
    // lama yang diputar ulang (modul adopsi tidak pernah menyentuh jurnal).
    expect(Object.keys(h.seen[0]!).sort()).toEqual(
      ["instruction", "sessionId", "taskId", "title"].sort(),
    )
    const after = store.getTask(T, created.id)!
    expect(after.status).toBe("IN_PROGRESS")
    expect(store.getExecutionLineage(T, created.id)).toEqual({
      execGeneration: oldGeneration + 1,
      attemptGeneration: oldGeneration + 1,
    })
    expect(store.getExecutionOwnership(T, created.id)).toEqual({ executionOwner: "scheduler" })
    await h.sc.stop()
  })
})

// ── 7. relasi ───────────────────────────────────────────────────────────────

describe("P14 — provenance relasi", () => {
  test("13. relasi harus sudah diadopsi; id yang kebetulan ada di target tidak cukup", () => {
    holdTarget()

    // Target punya t4 yang TIDAK berasal dari sumber.
    for (let i = 1; i <= 4; i++) add(T, `target filler ${i}`)
    for (let i = 1; i <= 3; i++) expect(store.deleteTask(T, `t${i}`)).toBe(true)
    expect(store.listTasks(T).map((t) => t.id)).toEqual(["t4"])

    // Sumber: parent t1, dependency t2, child t3; t4 polos; t5 depends t4.
    const parent = add(S, "parent")
    const dependency = add(S, "dependency")
    const child = add(S, "child", { parentId: parent.id, dependsOn: [dependency.id] })
    add(S, "plain")
    const coincidental = add(S, "depends on coincidental target id", { dependsOn: ["t4"] })

    const unresolvedChild = adopt(child.id)
    expect(unresolvedChild.outcome).toBe("REFUSED_UNRESOLVED_RELATION")
    expect([...unresolvedChild.unresolvedRelations].sort()).toEqual(["t1", "t2"])
    expect(store.getTask(S, child.id)).not.toBeNull()

    // t4 ADA di target, tetapi tidak pernah diadopsi dari sumber: menautkannya
    // akan menyatukan dua tugas berbeda, jadi tetap ditolak.
    const coincidence = adopt(coincidental.id)
    expect(coincidence.outcome).toBe("REFUSED_UNRESOLVED_RELATION")
    expect(coincidence.unresolvedRelations).toEqual(["t4"])

    // Adopsi berurutan: parent/dependency dulu, baru child.
    expect(adopt(parent.id).outcome).toBe("ADOPTED")
    expect(adopt(child.id).unresolvedRelations).toEqual(["t2"])
    expect(adopt(dependency.id).outcome).toBe("ADOPTED")
    expect(adopt(child.id).outcome).toBe("ADOPTED")

    const moved = store.getTask(T, child.id)!
    expect(moved.parentId).toBe(parent.id)
    expect(moved.dependsOn).toEqual([dependency.id])
    expect(store.listTaskTransfers({ toSessionId: T })).toHaveLength(3)
    // t4 milik target tidak tersentuh.
    expect(store.getTask(T, "t4")?.title).toBe("target filler 4")
  })
})

// ── 8. kegagalan ledger ─────────────────────────────────────────────────────

describe("P14 — atomisitas ledger", () => {
  test("14. INSERT ledger gagal: UPDATE task ikut rollback, retry setelah pulih bersih", () => {
    holdTarget()
    const created = add(S, "ledger rollback")
    const before = store.getTask(S, created.id)!
    raw(
      `CREATE TRIGGER p14_reject_transfer
         BEFORE INSERT ON task_transfers
       BEGIN
         SELECT RAISE(ABORT, 'p14-injected-ledger-failure');
       END`,
    )

    expect(() => adopt(created.id)).toThrow(TaskError)
    expect(() => adopt(created.id)).toThrow(/transfer ledger write failed/)
    // Rollback penuh: task tetap di sumber pada revisi yang sama, target kosong.
    expect(store.getTask(S, created.id)).toEqual(before)
    expect(store.getTask(T, created.id)).toBeNull()
    expect(store.listTaskTransfers()).toHaveLength(0)
    expect(store.getExecutionLineage(S, created.id)).toEqual({
      execGeneration: 0,
      attemptGeneration: null,
    })
    // Lease sumber tidak tertinggal meskipun operasi melempar.
    expect(store.getSessionAuthority(S)).toBeNull()

    raw("DROP TRIGGER p14_reject_transfer")
    const retried = adopt(created.id)
    expect(retried.outcome).toBe("ADOPTED")
    expect(store.getTask(S, created.id)).toBeNull()
    expect(store.getTask(T, created.id)?.revision).toBe(before.revision + 1)
    expect(store.listTaskTransfers({ taskId: created.id })).toHaveLength(1)
  })
})

// ── 15. seam CLI ────────────────────────────────────────────────────────────

describe("P14 — seam CLI", () => {
  test("15a. flag diteruskan apa adanya ke createCliSession", () => {
    const src = readFileSync(join(process.cwd(), "cli", "index.ts"), "utf8")
    const call = src.slice(src.indexOf("createCliSession({"))
    expect(call).toContain("adoptTask")
    expect(src).toContain("parseAdoptTaskArg")
    // Bentuk salah ditolak sebelum sesi/lease dibuat (exit eksplisit).
    expect(src).toContain("invalid --adopt-task value")
  })

  test("15b. refusal saat startup melepas lease target dan tidak meninggalkan task pindah", async () => {
    const source = "p14-cli-refuse-source"
    const target = "p14-cli-refuse-target"
    // Task tidak ada di sumber: refusal terklasifikasi, bukan crash.
    const refused = await createCliSession({
      ...cliOpts(),
      sessionId: target,
      adoptTask: { sourceSessionId: source, taskId: "t1" },
    }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(AdoptionRefusedError)
    expect((refused as AdoptionRefusedError).result.outcome).toBe("NOT_FOUND")
    // Lease target yang sempat diambil admission DILEPAS: proses sesi lain
    // boleh memakai sesi ini segera, bukan menunggu lease habis.
    expect(store.getSessionAuthority(target)).toBeNull()
    expect(store.listTaskTransfers()).toHaveLength(0)
  })

  test("15c. sesi tanpa flag tidak mengadopsi apa pun", async () => {
    const source = "p14-cli-plain-source"
    const target = "p14-cli-plain-target"
    const sourceTask = add(source, "left alone")
    const session = await createCliSession({ ...cliOpts(), sessionId: target })
    expect(session.adoption).toBeNull()
    expect(store.listTaskTransfers()).toHaveLength(0)
    // Task sumber TIDAK berpindah dan target tidak mendapat apa pun.
    expect(store.getTask(source, sourceTask.id)?.title).toBe("left alone")
    expect(store.listTasks(target)).toEqual([])
    await session.close()
  })
})
