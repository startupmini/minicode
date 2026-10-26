// P14.2-lite / P14.3 / P14.4 / P14.6 — proyeksi open-work, dedup eksplisit,
// portofolio CLI, dan closure feedback. Deterministik penuh: waktu disuntikkan
// lewat `now`/`staleMs`, kegagalan ledger lewat trigger SQLite, CLI lewat
// subprocess hermetic. Tidak ada `sleep`.

import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve as resolvePath } from "node:path"
import { adoptUnfinishedTask } from "../src/session/cross-session-adoption.ts"
import {
  DEFAULT_OPEN_WORK_STALE_MS,
  formatAge,
  normalizeTitleKey,
  type OpenWorkReport,
  openWorkCategory,
  projectOpenWork,
} from "../src/session/open-work.ts"
import { readSessionMetaRows, saveSession } from "../src/session/persistence.ts"
import type { TaskStatus } from "../src/task/model.ts"
import { Scheduler, type SchedulerWorkItem } from "../src/task/scheduler.ts"
import { SESSION_LEASE_MS } from "../src/task/session-authority.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

let dir: string
let store: TaskStore

const S = "p14ow-source"
const T = "p14ow-target"
const TARGET_TOKEN = "p14ow-target-owner"
const prov = { origin: "model", source: "p14ow-test" } as const

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-p14ow-"))
  store = new TaskStore(dir, { authority: "SCHEDULER" })
  resetSessionOwnershipForTests()
})

afterEach(() => {
  resetSessionOwnershipForTests()
  resetTaskStoreHandles()
  rm(dir, { recursive: true, force: true }).catch(() => {})
})

// ── helpers ─────────────────────────────────────────────────────────────────

const tasksDbPath = (): string => join(dir, ".minicode", "tasks.db")
const sessionsDbPath = (): string => join(dir, ".minicode", "sessions.db")

function add(sessionId: string, title: string, status: TaskStatus = "PENDING") {
  const order = store.listTasks(sessionId).length + 1
  return store.createTask(sessionId, { title, status, order, provenance: prov })
}

function claim(sessionId: string, taskId: string): number {
  const task = store.getTask(sessionId, taskId)
  if (task === null) throw new Error(`task ${sessionId}/${taskId} tidak ada`)
  const r = store.claimTask(sessionId, taskId, task.revision)
  if (r.outcome !== "CLAIM_ACCEPTED") throw new Error(`claim ditolak: ${r.outcome}`)
  return r.execGeneration
}

function holdTarget(now = Date.now()): void {
  expect(store.acquireSessionAuthority(T, TARGET_TOKEN, SESSION_LEASE_MS, now)).toBe("ACQUIRED")
}

function adoptIntoTarget(taskId: string) {
  return adoptUnfinishedTask({
    sourceSessionId: S,
    targetSessionId: T,
    taskId,
    targetOwnerToken: TARGET_TOKEN,
    bootId: "p14ow-boot",
    cwd: dir,
    // Jam tetap yang sama dengan akuisisi lease target — lease yang dipegang
    // pada NOW harus masih hidup pada pemeriksaan pada NOW.
    now: NOW,
  })
}

function raw(sql: string, ...params: (string | number | null)[]): void {
  const db = new Database(tasksDbPath())
  try {
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}

/** Waktu evaluasi tetap: 1 hari setelah epoch bebas beban, jauh dari now nyata. */
const NOW = Date.parse("2026-10-24T12:00:00Z")
const DAY = 24 * 60 * 60 * 1000

// ── A. P14.2-lite — proyeksi ────────────────────────────────────────────────

describe("P14.2 — kategori & helper murni", () => {
  test("kategori adalah pemetaan mekanis per status; terminal fail-closed", () => {
    expect(openWorkCategory("PENDING")).toBe("OPEN")
    expect(openWorkCategory("IN_PROGRESS")).toBe("IN_PROGRESS")
    expect(openWorkCategory("VERIFYING")).toBe("VERIFYING")
    expect(openWorkCategory("BLOCKED")).toBe("BLOCKED")
    expect(openWorkCategory("FAILED")).toBe("FAILED_NEEDS_FOLLOWUP")
    expect(openWorkCategory("RETRYING")).toBe("RETRYING")
    // Status terminal TIDAK punya kategori open — menebak itu bug, bukan fitur.
    expect(() => openWorkCategory("COMPLETED")).toThrow(/terminal status/)
    expect(() => openWorkCategory("CANCELLED")).toThrow(/terminal status/)
  })

  test("normalizeTitleKey murni: kasus/tanda baca/spasi diluruskan", () => {
    expect(normalizeTitleKey("  Fix LOGIN bug!! ")).toBe("fix login bug")
    expect(normalizeTitleKey("fix-login_bug")).toBe("fix login bug")
    expect(normalizeTitleKey("…")).toBe("")
  })

  test("formatAge deterministik dan tak pernah negatif", () => {
    expect(formatAge(0)).toBe("now")
    expect(formatAge(59_000)).toBe("now")
    expect(formatAge(5 * 60_000)).toBe("5m")
    expect(formatAge(3 * 60 * 60_000)).toBe("3h")
    expect(formatAge(3 * 24 * 60 * 60_000)).toBe("3d")
    expect(formatAge(-100)).toBe("now")
  })
})

describe("P14.2 — proyeksi open-work", () => {
  test("urutan tertua-dulu + field lengkap + counts", () => {
    const old = add(S, "oldest item")
    const fresh = add(S, "fresh item")
    // Geser updatedAt item lama jauh ke belakang — deterministik tanpa sleep.
    raw(
      "UPDATE tasks SET updated_at = ? WHERE session_id = ? AND task_id = ?",
      new Date(NOW - 30 * DAY).toISOString(),
      S,
      old.id,
    )

    const report = projectOpenWork({ cwd: dir, now: NOW })
    expect(report.open).toHaveLength(2)
    expect(report.open[0]?.taskId).toBe(old.id)
    expect(report.open[1]?.taskId).toBe(fresh.id)
    expect(report.open[0]).toMatchObject({
      sessionId: S,
      title: "oldest item",
      status: "PENDING",
      category: "OPEN",
      revision: 1,
    })
    expect(report.open[0]?.ageMs).toBe(30 * DAY)
    expect(report.open[0]?.execGeneration).toBe(0)
    expect(report.open[0]?.attemptGeneration).toBeNull()
    expect(report.counts).toMatchObject({
      open: 2,
      stale: 1,
      unknownProvenance: 2,
      similarGroups: 0,
      closed: 0,
    })
    expect(report.staleMs).toBe(DEFAULT_OPEN_WORK_STALE_MS)
  })

  test("provenance UNKNOWN tanpa baris sesi; proyeksi TIDAK membuat sessions.db", () => {
    add(S, "orphan workspace item")
    expect(existsSync(sessionsDbPath())).toBe(false)

    const report = projectOpenWork({ cwd: dir, now: NOW })
    expect(report.open[0]?.provenance).toBe("SESSION_MISSING")
    expect(report.open[0]?.sessionUpdatedAtMs).toBeNull()
    expect(report.counts.unknownProvenance).toBe(1)
    // Bukti read-only: berkas sessions.db TIDAK ikut tercipta.
    expect(existsSync(sessionsDbPath())).toBe(false)
  })

  test("provenance SESSION_PRESENT saat baris sesi ada", async () => {
    store.initialize()
    await saveSession(S, dir, undefined, [], undefined)
    expect(readSessionMetaRows(dir).map((r) => r.id)).toContain(S)
    add(S, "traceable item")

    const report = projectOpenWork({ cwd: dir, now: NOW })
    expect(report.open[0]?.provenance).toBe("SESSION_PRESENT")
    expect(report.open[0]?.sessionUpdatedAtMs).not.toBeNull()
    expect(report.counts.unknownProvenance).toBe(0)
  })

  test("STALE mengikuti ambang yang disuntikkan, bukan jam nyata", () => {
    add(S, "two day old item")
    raw(
      "UPDATE tasks SET updated_at = ? WHERE session_id = ? AND task_id = ?",
      new Date(NOW - 2 * DAY).toISOString(),
      S,
      "t1",
    )

    const staleReport = projectOpenWork({ cwd: dir, now: NOW, staleMs: 1 * DAY })
    expect(staleReport.open[0]?.stale).toBe(true)
    expect(staleReport.counts.stale).toBe(1)

    const freshReport = projectOpenWork({ cwd: dir, now: NOW, staleMs: 7 * DAY })
    expect(freshReport.open[0]?.stale).toBe(false)
    expect(freshReport.counts.stale).toBe(0)
  })

  test("kemiripan judul hanya PENANDA UNPROVEN — tidak pernah menyatukkan", () => {
    add(S, "Fix login bug")
    add(S, "fix LOGIN bug!!")
    add(S, "unrelated work")

    const report = projectOpenWork({ cwd: dir, now: NOW })
    const similar = report.open.filter((e) => e.titleKey === "fix login bug")
    expect(similar).toHaveLength(2)
    for (const e of similar) {
      expect(e.similarCount).toBe(2)
      expect(e.stale).toBe(false)
    }
    expect(report.counts.similarGroups).toBe(1)
    // Bukti "ambiguous tetap terpisah": kedua baris masih ada, status PENDING,
    // dan TIDAK ada ledger merge yang lahir dari proyeksi.
    expect(store.listTaskMerges()).toHaveLength(0)
    expect(store.getTask(S, "t1")?.status).toBe("PENDING")
    expect(store.getTask(S, "t2")?.status).toBe("PENDING")
  })
})

// ── B. P14.3 — dedup eksplisit ─────────────────────────────────────────────

describe("P14.3 — declareTaskDuplicate", () => {
  test("DECLARED: duplikat CANCELLED (bukan COMPLETED), survivor utuh, ledger evidence verbatim", () => {
    const survivor = add(S, "real work")
    const duplicate = add(S, "same work, rediscovered")
    claim(S, duplicate.id) // in-flight duplikat ikut ditutup owner-nya
    // Revisi dibaca SETELAH claim: claim majukan revisi, dan merge menangkap
    // nilai yang operator lihat sekarang.
    const duplicateNow = store.getTask(S, duplicate.id)!
    const survivorBefore = store.getTask(S, survivor.id)!

    const result = store.declareTaskDuplicate({
      sessionId: S,
      survivorId: survivor.id,
      duplicateId: duplicate.id,
      evidence: "operator verified: same unit of work",
      expectedRevision: duplicateNow.revision,
    })
    expect(result.outcome).toBe("DECLARED")
    expect(result.duplicate?.status).toBe("CANCELLED")
    expect(result.duplicate?.revision).toBe(duplicateNow.revision + 1)
    // In-flight duplikat yang ditutup: ownership scheduler ikut dilepas
    // (patchTask melepasnya saat status keluar dari in-flight).
    expect(store.getExecutionOwnership(S, duplicate.id)).toEqual({ executionOwner: null })

    const survivorAfter = store.getTask(S, survivor.id)!
    expect(survivorAfter.status).toBe(survivorBefore.status)
    expect(survivorAfter.revision).toBe(survivorBefore.revision)

    const ledger = store.listTaskMerges({ sessionId: S, duplicateId: duplicate.id })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      survivorId: survivor.id,
      duplicateId: duplicate.id,
      evidence: "operator verified: same unit of work",
      survivorStatus: "PENDING",
      duplicateStatus: "CANCELLED",
      duplicateRevision: duplicateNow.revision + 1,
    })
    expect(ledger[0]?.mergeId).toBeDefined()
    expect(ledger[0]?.mergedAt).toBe(result.duplicate?.updatedAt)
  })

  test("refusal: self-merge, tanpa evidence, tak ditemukan, antar-sesi, terminal, stale", () => {
    const survivor = add(S, "survivor")
    const duplicate = add(S, "duplicate")
    // Namespace T sengaja lebih PADAT dari S: id "t3" milik T tidak pernah
    // hidup di S, sehingga kasus lintas-sesi bisa dibuktikan tanpa tabrakan
    // id (id task memang berulang antar sesi).
    add(T, "other namespace a")
    add(T, "other namespace b")
    const onlyInTarget = add(T, "lives only in target")

    expect(
      store.declareTaskDuplicate({
        sessionId: S,
        survivorId: survivor.id,
        duplicateId: survivor.id,
        evidence: "x",
      }).outcome,
    ).toBe("REFUSED_SELF_MERGE")
    expect(
      store.declareTaskDuplicate({
        sessionId: S,
        survivorId: survivor.id,
        duplicateId: duplicate.id,
        evidence: "   ",
      }).outcome,
    ).toBe("REFUSED_NO_EVIDENCE")
    expect(
      store.declareTaskDuplicate({
        sessionId: S,
        survivorId: "t99",
        duplicateId: duplicate.id,
        evidence: "x",
      }).outcome,
    ).toBe("NOT_FOUND")
    // Antar-sesi: id yang hanya hidup di T TIDAK terlihat dari namespace S —
    // NOT_FOUND, baris T tak tersentuh. Merge tidak punya jangkauan lintas
    // sesi; pindahkan otoritas dulu lewat adopsi bila memang itu maksudnya.
    expect(
      store.declareTaskDuplicate({
        sessionId: S,
        survivorId: survivor.id,
        duplicateId: onlyInTarget.id,
        evidence: "x",
      }).outcome,
    ).toBe("NOT_FOUND")
    expect(store.getTask(T, onlyInTarget.id)?.status).toBe("PENDING")

    store.patchTask(S, duplicate.id, { status: "COMPLETED" })
    expect(
      store.declareTaskDuplicate({
        sessionId: S,
        survivorId: survivor.id,
        duplicateId: duplicate.id,
        evidence: "x",
      }).outcome,
    ).toBe("REFUSED_TERMINAL_DUPLICATE")

    const third = add(S, "stale candidate")
    expect(
      store.declareTaskDuplicate({
        sessionId: S,
        survivorId: survivor.id,
        duplicateId: third.id,
        evidence: "x",
        expectedRevision: third.revision + 5,
      }).outcome,
    ).toBe("REJECTED_STALE_REVISION")

    expect(store.listTaskMerges()).toHaveLength(0)
    expect(store.getTask(S, third.id)?.status).toBe("PENDING")
  })

  test("survivor terminal diizinkan; duplikat tetap CANCELLED — tidak infer COMPLETED", () => {
    const survivor = add(S, "already finished")
    store.patchTask(S, survivor.id, { status: "COMPLETED" })
    const duplicate = add(S, "pending rediscovery")

    const result = store.declareTaskDuplicate({
      sessionId: S,
      survivorId: survivor.id,
      duplicateId: duplicate.id,
      evidence: "the completed task already covers this",
      expectedRevision: duplicate.revision,
    })
    expect(result.outcome).toBe("DECLARED")
    // Kejujuran inti: TIDAK ada inferensi penyelesaian.
    expect(result.duplicate?.status).toBe("CANCELLED")
    expect(store.getTask(S, survivor.id)?.status).toBe("COMPLETED")
  })

  test("atomic: kegagalan INSERT ledger menggulung balik status duplikat; retry bersih", () => {
    const survivor = add(S, "survivor")
    const duplicate = add(S, "duplicate")
    const db = new Database(tasksDbPath())
    try {
      db.exec(
        `CREATE TRIGGER p14ow_reject_merge
           BEFORE INSERT ON task_merges
         BEGIN
           SELECT RAISE(ABORT, 'p14ow-injected-merge-failure');
         END`,
      )
    } finally {
      db.close()
    }

    expect(() =>
      store.declareTaskDuplicate({
        sessionId: S,
        survivorId: survivor.id,
        duplicateId: duplicate.id,
        evidence: "x",
      }),
    ).toThrow(/merge ledger write failed/)
    // Rollback penuh: status & revisi duplikat tak tersentuh, ledger kosong.
    expect(store.getTask(S, duplicate.id)?.status).toBe("PENDING")
    expect(store.getTask(S, duplicate.id)?.revision).toBe(duplicate.revision)
    expect(store.listTaskMerges()).toHaveLength(0)

    const db2 = new Database(tasksDbPath())
    try {
      db2.exec("DROP TRIGGER p14ow_reject_merge")
    } finally {
      db2.close()
    }
    const retried = store.declareTaskDuplicate({
      sessionId: S,
      survivorId: survivor.id,
      duplicateId: duplicate.id,
      evidence: "x",
    })
    expect(retried.outcome).toBe("DECLARED")
    expect(store.listTaskMerges({ duplicateId: duplicate.id })).toHaveLength(1)
  })

  test("pembalikan = penulisan lifecycle biasa: duplikat dibuka kembali, ledger tetap audit", () => {
    const survivor = add(S, "survivor")
    const duplicate = add(S, "duplicate")
    expect(
      store.declareTaskDuplicate({
        sessionId: S,
        survivorId: survivor.id,
        duplicateId: duplicate.id,
        evidence: "wrong call",
      }).outcome,
    ).toBe("DECLARED")

    // Operator salah: buka kembali lewat lifecycle yang sudah ada. Tidak ada
    // "unmerge" khusus — itu JUSTRU bukti bahwa merge tidak mengunci lifecycle.
    store.patchTask(S, duplicate.id, { status: "PENDING" })
    expect(store.getTask(S, duplicate.id)?.status).toBe("PENDING")

    // Proyeksi open mencantumkannya lagi; closure feedback TIDAK menyimpulkan
    // (status dibaca ulang dari tasks, bukan dari ledger).
    const report = projectOpenWork({ cwd: dir, now: NOW, includeClosed: true })
    expect(report.open.some((e) => e.taskId === duplicate.id && e.sessionId === S)).toBe(true)
    expect(
      report.closed.some((e) => e.taskId === duplicate.id && e.kind === "MERGED_DUPLICATE"),
    ).toBe(false)
    // Ledger append-only: deklarasi (dan kesalahan operator) tetap tercatat.
    expect(store.listTaskMerges({ duplicateId: duplicate.id })).toHaveLength(1)
  })
})

// ── C. P14.6 — closure feedback ────────────────────────────────────────────

describe("P14.6 — closure feedback", () => {
  test("adopsi → selesai via lifecycle → hilang dari open, muncul di closed berprovenance", () => {
    holdTarget(NOW)
    const adopted = add(S, "adopted work")
    claim(S, adopted.id)
    expect(adoptIntoTarget(adopted.id).outcome).toBe("ADOPTED")

    // Setelah adopsi item tampil open di TUJUAN dengan provenance FROM sumber.
    const before = projectOpenWork({ cwd: dir, now: NOW, includeClosed: true })
    expect(before.open.some((e) => e.sessionId === T && e.taskId === adopted.id)).toBe(true)
    expect(
      before.open.find((e) => e.sessionId === T && e.taskId === adopted.id)
        ?.transferredFromSessionId,
    ).toBe(S)
    expect(before.closed).toHaveLength(0)

    // Penutupan lewat lifecycle YANG SUDAH ADA (jalur model/operator kanonik).
    const task = store.getTask(T, adopted.id)!
    store.patchTask(T, adopted.id, { status: "COMPLETED" })

    const after = projectOpenWork({ cwd: dir, now: NOW, includeClosed: true })
    expect(after.open.some((e) => e.sessionId === T && e.taskId === adopted.id)).toBe(false)
    const closed = after.closed.find((e) => e.taskId === adopted.id && e.kind === "TRANSFERRED")
    expect(closed).toMatchObject({
      sessionId: T,
      status: "COMPLETED",
      transferredFromSessionId: S,
      revision: task.revision + 1,
    })
    expect(closed?.closedAt).not.toBeNull()
    expect(after.counts.closed).toBe(1)
  })

  test("baris transfer yang dihapus: closed status MISSING — jujur, tanpa inferensi", () => {
    holdTarget(NOW)
    const adopted = add(S, "adopted then deleted")
    claim(S, adopted.id)
    expect(adoptIntoTarget(adopted.id).outcome).toBe("ADOPTED")
    expect(store.deleteTask(T, adopted.id)).toBe(true)

    const report = projectOpenWork({ cwd: dir, now: NOW, includeClosed: true })
    const closed = report.closed.find((e) => e.taskId === adopted.id)
    expect(closed).toMatchObject({ kind: "TRANSFERRED", status: "MISSING", title: null })
    // Ledger tetap membuktikan perpindahan meski baris task sudah tidak ada.
    expect(closed?.transferredFromSessionId).toBe(S)
  })

  test("merge ikut closure feedback: MERGED_DUPLICATE + survivor + evidence", () => {
    const survivor = add(S, "survivor")
    const duplicate = add(S, "duplicate")
    expect(
      store.declareTaskDuplicate({
        sessionId: S,
        survivorId: survivor.id,
        duplicateId: duplicate.id,
        evidence: "same unit of work",
      }).outcome,
    ).toBe("DECLARED")

    const report = projectOpenWork({ cwd: dir, now: NOW, includeClosed: true })
    const closed = report.closed.find((e) => e.taskId === duplicate.id)
    expect(closed).toMatchObject({
      kind: "MERGED_DUPLICATE",
      sessionId: S,
      status: "CANCELLED",
      mergeSurvivorId: survivor.id,
      mergeEvidence: "same unit of work",
    })
    expect(report.open.some((e) => e.taskId === duplicate.id)).toBe(false)
  })

  test("proyeksi nol-mutasi: revisi/ledger/lease identik sebelum-sesudah", () => {
    holdTarget(NOW)
    const adopted = add(S, "adopted") // t1 — pindah ke T
    const survivor = add(S, "stays in source") // t2 — tetap di S
    const duplicate = add(S, "closed as duplicate") // t3 — ditutup via merge
    claim(S, adopted.id)
    expect(adoptIntoTarget(adopted.id).outcome).toBe("ADOPTED")
    expect(
      store.declareTaskDuplicate({
        sessionId: S,
        survivorId: survivor.id,
        duplicateId: duplicate.id,
        evidence: "zero-mutation fixture",
      }).outcome,
    ).toBe("DECLARED")

    const tasksBefore = [...store.listTasks(S), ...store.listTasks(T)].map((t) => ({ ...t }))
    const transfersBefore = store.listTaskTransfers()
    const mergesBefore = store.listTaskMerges()
    const authBefore = store.getSessionAuthority(T)

    const report = projectOpenWork({ cwd: dir, now: NOW, includeClosed: true })
    // Open: survivor t2 (S, PENDING) + adopted t1 (T, IN_PROGRESS).
    expect(report.counts.open).toBe(2)
    // Closed: duplikat t3 (MERGED_DUPLICATE).
    expect(report.counts.closed).toBe(1)

    expect([...store.listTasks(S), ...store.listTasks(T)].map((t) => ({ ...t }))).toEqual(
      tasksBefore,
    )
    expect(store.listTaskTransfers()).toEqual(transfersBefore)
    expect(store.listTaskMerges()).toEqual(mergesBefore)
    expect(store.getSessionAuthority(T)).toEqual(authBefore)
    // Tidak ada lease baru yang lahir dari proyeksi: sumber tetap tanpa baris.
    expect(store.getSessionAuthority(S)).toBeNull()
  })
})

// ── C2. P14.5 — alur operator ujung-ke-ujung ────────────────────────────────

describe("P14.5 — alur operator: temukan → adopsi → lanjutan tersupervisi → closure", () => {
  test("portofolio → --adopt-task → gate continuity → claim generasi baru → closure feedback", async () => {
    // 1. Discovery: pekerjaan in-flight terdampar di sesi sumber.
    const stranded = add(S, "stranded in-flight work")
    claim(S, stranded.id)
    const seen = projectOpenWork({ cwd: dir, now: NOW })
    expect(seen.open).toHaveLength(1)
    expect(seen.open[0]).toMatchObject({
      sessionId: S,
      taskId: stranded.id,
      status: "IN_PROGRESS",
      category: "IN_PROGRESS",
      executionOwner: "scheduler",
    })

    // 2. Adopsi eksplisit — TIDAK memicu scheduler apa pun.
    holdTarget(NOW)
    const adopted = adoptIntoTarget(stranded.id)
    expect(adopted.outcome).toBe("ADOPTED")
    const projected = projectOpenWork({ cwd: dir, now: NOW })
    const entry = projected.open.find((e) => e.sessionId === T)
    expect(entry).toMatchObject({
      taskId: stranded.id,
      status: "IN_PROGRESS",
      transferredFromSessionId: S,
      execGeneration: 1,
    })

    // 3. Lanjutan TERSUPERVISI lewat gate continuity yang sudah ada:
    //    read-only tool scope ⇒ SAFE_TO_RETRY ⇒ revert ⇒ claim GENERASI BARU.
    const work: SchedulerWorkItem[] = []
    const sc = new Scheduler(T, {
      store,
      runTurn: async (w) => {
        work.push(w)
        return { kind: "returned", ok: true }
      },
      instruction: "continue the adopted work",
      authorityToken: TARGET_TOKEN,
      continuity: {
        evidence: () => ({
          resume: true,
          missing: [],
          admission: "ALLOW",
          retrySafety: "READ_ONLY_TOOL_SCOPE",
        }),
      },
    })
    sc.start()
    expect(sc.reconcile()).toEqual([stranded.id])
    const cycle = await sc.cycle()
    expect(cycle.stop).toBe("already-dispatched")
    expect(work).toHaveLength(1)
    expect(work[0]).toMatchObject({ taskId: stranded.id, sessionId: T })
    // Generasi BARU dari claim tujuan — bukan replay generasi lama.
    expect(store.getExecutionLineage(T, stranded.id)).toEqual({
      execGeneration: 2,
      attemptGeneration: 2,
    })
    await sc.stop()

    // 4. Closure lewat lifecycle yang sudah ada, lalu feedback jujur:
    //    hilang dari open, tercatat di closed DENGAN provenance transfer.
    store.patchTask(T, stranded.id, { status: "COMPLETED" })
    const closed = projectOpenWork({ cwd: dir, now: NOW, includeClosed: true })
    expect(closed.open).toHaveLength(0)
    expect(closed.closed[0]).toMatchObject({
      kind: "TRANSFERRED",
      sessionId: T,
      taskId: stranded.id,
      status: "COMPLETED",
      transferredFromSessionId: S,
    })
  })
})

// ── D. P14.4 — CLI openwork (subprocess hermetic) ──────────────────────────

describe("P14.4 — CLI openwork", () => {
  const entry = resolvePath(import.meta.dir, "..", "cli", "index.ts")

  function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
    const home = join(dir, "home")
    mkdirSync(join(home, ".minicode"), { recursive: true })
    const r = spawnSync(process.execPath, [entry, ...args], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        NO_COLOR: "1",
        NO_UPDATE_CHECK: "1",
        CI: "1",
        MINICODE_HOME: home,
        HOME: home,
        USERPROFILE: home,
        OPENAI_API_KEY: undefined,
        AGENT_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        TOKENHARBOR_API_KEY: undefined,
        TH_API_KEY: undefined,
      },
    })
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
  }

  test("list manusia: tabel vertikal + penanda STALE/UNKNOWN/SIMILAR + kontrak otoritas", () => {
    add(S, "Fix login bug")
    add(S, "fix LOGIN bug!!")
    raw(
      "UPDATE tasks SET updated_at = ? WHERE session_id = ? AND task_id = ?",
      new Date(Date.now() - 2 * DAY).toISOString(),
      S,
      "t1",
    )
    // Lepas handle sebelum spawn supaya subprocess membuka DB sendiri.
    resetTaskStoreHandles()

    const r = runCli(["openwork", "--cwd", dir, "--stale-days", "1"])
    expect(r.code).toBe(0)
    for (const expected of [
      "Open Work",
      S,
      "t1",
      "Fix login bug",
      "PENDING",
      "STALE",
      "PROVENANCE-UNKNOWN",
      "SIMILAR×2(UNPROVEN)",
      "TaskStore remains the sole status authority",
      "--adopt-task",
    ]) {
      expect(r.stdout).toContain(expected)
    }
    // Subprocess TIDAK membuat sessions.db (proyeksi read-only).
    expect(existsSync(sessionsDbPath())).toBe(false)
  })

  test("--json: satu objek JSON mesin di stdout; flag-mendahului-subcommand sah", () => {
    add(S, "json item")
    resetTaskStoreHandles()

    const r = runCli(["--json", "openwork", "--cwd", dir])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout) as OpenWorkReport
    expect(parsed.counts.open).toBe(1)
    expect(parsed.open[0]).toMatchObject({
      sessionId: S,
      taskId: "t1",
      title: "json item",
      category: "OPEN",
      provenance: "SESSION_MISSING",
      similarCount: 1,
    })
    expect(parsed.generatedAtIso).toBeDefined()
    expect(parsed.staleMs).toBe(DEFAULT_OPEN_WORK_STALE_MS)
    // Kontrak mesin: stdout murni — tidak ada baris non-JSON.
    expect(r.stdout.trim().split("\n")).toHaveLength(1)
  })

  test("workspace kosong: daftar kosong tetap exit 0", () => {
    resetTaskStoreHandles()
    const r = runCli(["openwork", "--cwd", dir])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("Open Work — 0 item")
    expect(r.stdout).toContain("(no unfinished work")
  })

  test("salah pakai: aksi asing / --status / --stale-days / merge tanpa argumen → exit 2", () => {
    resetTaskStoreHandles()
    expect(runCli(["openwork", "frobnicate", "--cwd", dir]).code).toBe(2)
    const badStatus = runCli(["openwork", "--cwd", dir, "--status", "BOGUS"])
    expect(badStatus.code).toBe(2)
    expect(badStatus.stderr).toContain("invalid --status")
    const badDays = runCli(["openwork", "--cwd", dir, "--stale-days", "x"])
    expect(badDays.code).toBe(2)
    expect(badDays.stderr).toContain("invalid --stale-days")
    const noArgs = runCli(["openwork", "merge", "--cwd", dir])
    expect(noArgs.code).toBe(2)
    expect(noArgs.stderr).toContain("--keep")
    expect(runCli(["openwork", "--help"]).code).toBe(0)
  })

  test("merge sukses: duplikat CANCELLED di DB + ledger; ANSI tak lolos", () => {
    const survivor = add(S, "survivor")
    const duplicate = add(S, "duplicate \u001b[2J hijack")
    resetTaskStoreHandles()

    const r = runCli([
      "openwork",
      "merge",
      "--cwd",
      dir,
      "--session",
      S,
      "--keep",
      survivor.id,
      "--drop",
      duplicate.id,
      "--evidence",
      "same unit of work",
    ])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(
      `closed ${duplicate.id} as duplicate of ${survivor.id} (CANCELLED, not COMPLETED)`,
    )
    expect(r.stdout).toContain("audit ledger:")
    // Sekuens kontrol dari judul/evidence TIDAK ikut tampil.
    expect(r.stdout).not.toContain("\u001b[2J")

    const after = new TaskStore(dir)
    expect(after.getTask(S, duplicate.id)?.status).toBe("CANCELLED")
    expect(after.getTask(S, survivor.id)?.status).toBe("PENDING")
    expect(after.listTaskMerges({ duplicateId: duplicate.id })).toHaveLength(1)
  })

  test("merge refusal: terminal/lookup → exit 1 dengan alasan terklasifikasi", () => {
    const survivor = add(S, "survivor")
    const duplicate = add(S, "already closed")
    store.patchTask(S, duplicate.id, { status: "CANCELLED" })
    resetTaskStoreHandles()

    const refused = runCli([
      "openwork",
      "merge",
      "--cwd",
      dir,
      "--session",
      S,
      "--keep",
      survivor.id,
      "--drop",
      duplicate.id,
      "--evidence",
      "x",
    ])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("REFUSED_TERMINAL_DUPLICATE")

    const missing = runCli([
      "openwork",
      "merge",
      "--cwd",
      dir,
      "--session",
      S,
      "--keep",
      "t99",
      "--drop",
      duplicate.id,
      "--evidence",
      "x",
    ])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('task "t99" not found')
  })
})
