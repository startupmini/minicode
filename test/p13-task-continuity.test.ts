// P13.3 Stage C — kontinuitas task durable yang AMAN (crash/restart).
//
// File ini TIDAK menguji "scheduler bisa claim lagi". Ia menguji keputusan yang
// lebih ketat: kapan generasi yang tertahan boleh dijalankan ULANG, kapan harus
// ditahan, dan bukti durable apa yang tersisa setelah setiap jalur.
//
// Bukti utama:
//   1. Kebijakan retry runtime (isRedispatchAllowed + produksi
//      production-execution.ts) MENOLAK re-dispatch eksekusi lama; kontinuitas
//      task memakai ATTEMPT BARU (generasi baru), bukan replay jurnal lama.
//   2. Klasifikasi SAFE_TO_RETRY berasal dari cakupan tool read-only 6S —
//      bukan dari "marker tidak ada".
//   3. HOLD/REQUIRES_VERIFIER tidak mengubah baris durable.
//   4. Otoritas/lease/incarnation/revision diperiksa sebelum mutasi.
//   5. Lease kedaluwarsa boleh diambil alih HANYA lewat acquireSessionAuthority;
//      token lama tidak bisa renew/release/dispatch.
//
// Semua pemeriksaan state membaca BARIS DATABASE, bukan log/event.

import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isRedispatchAllowed, type RedispatchSafety } from "../src/runtime/recovery-safety.ts"
import { evaluateResume } from "../src/runtime/runtime-status.ts"
import { AUTONOMOUS_TOOL_NAMES, classifyTool } from "../src/task/autonomous-policy.ts"
import {
  type ContinuityEvidence,
  type ContinuityFacts,
  type ContinuityGate,
  classifyContinuity,
  hasCompletionMarker,
  retrySafetyForToolScope,
} from "../src/task/continuity.ts"
import type { TaskStatus } from "../src/task/model.ts"
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

const S = "p133c-sess"
const prov = { origin: "model", source: "p133c" } as const
const OK: ExecutionObservation = { kind: "returned", ok: true }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mc-p133c-"))
  store = new TaskStore(dir, { authority: "SCHEDULER" })
  resetSessionOwnershipForTests()
})
afterEach(async () => {
  resetSessionOwnershipForTests()
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

// ── durable evidence helpers ────────────────────────────────────────────────

const dbPath = (): string => join(dir, ".minicode", "tasks.db")

interface TaskRow {
  readonly status: TaskStatus
  readonly revision: number
  readonly exec_generation: number
  readonly attempt_generation: number | null
  readonly execution_owner: string | null
}

/** Baca BARIS DATABASE langsung — bukan model/log. */
function row(taskId: string): TaskRow {
  const db = new Database(dbPath())
  try {
    const r = db
      .prepare(
        `SELECT status, revision, exec_generation, attempt_generation, execution_owner
           FROM tasks WHERE session_id = ? AND task_id = ?`,
      )
      .get(S, taskId) as TaskRow | null
    if (r === null) throw new Error(`task ${taskId} tidak ada di database`)
    return r
  } finally {
    db.close()
  }
}

function add(title = "durable"): string {
  return store.createTask(S, { title, status: "PENDING", order: 1, provenance: prov }).id
}

function addAndClaim(title = "durable"): { id: string; execGeneration: number } {
  const id = add(title)
  const claimed = store.claimTask(S, id, store.getTask(S, id)!.revision)
  if (claimed.outcome !== "CLAIM_ACCEPTED") throw new Error(`claim rejected: ${claimed.outcome}`)
  return { id, execGeneration: claimed.execGeneration }
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

/**
 * Scheduler dengan gate eksplisit.
 *
 * `continuity: null` = TIDAK ada gate (menguji default fail-closed), bukan
 * "pakai default aman".
 */
function harness(
  opts: {
    continuity?: ContinuityGate | null
    runTurn?: (w: SchedulerWorkItem) => Promise<ExecutionObservation> | ExecutionObservation
    store?: TaskStore
  } = {},
): Harness {
  const seen: SchedulerWorkItem[] = []
  const events: SchedulerEvent[] = []
  const continuity = opts.continuity === undefined ? gate() : opts.continuity
  const sc = new Scheduler(S, {
    store: opts.store ?? store,
    runTurn: async (w) => {
      seen.push(w)
      return opts.runTurn ? opts.runTurn(w) : OK
    },
    instruction: "do the work",
    ...(continuity !== null ? { continuity } : {}),
    onEvent: (e) => events.push(e),
  })
  return { sc, seen, events }
}

const held = (events: readonly SchedulerEvent[]) =>
  events.filter(
    (e): e is Extract<SchedulerEvent, { kind: "task:continuity_held" }> =>
      e.kind === "task:continuity_held",
  )

// ── 0. Bukti kebijakan: runtime menolak replay, tool otonom read-only ────────

describe("P13.3 Stage C — bukti kebijakan sebelum implementasi", () => {
  test("runtime TIDAK mengizinkan re-dispatch eksekusi yang mungkin sudah ber efek", () => {
    // Angka ini BUKAN karangan: `inspectStartupRecovery` memberi idempotent=true,
    // dedupeKeyPresent=false, verifierAvailable=false (production-execution.ts).
    // Tanpa not-started/dedupe/verifier, predicate kanonis harus menolak.
    const productionFacts: RedispatchSafety = {
      authorityHeld: true,
      budgetRemaining: null,
      deadlineRemainingMs: null,
      effectDefinitelyNotStarted: false,
      idempotent: true,
      dedupeKeyPresent: false,
      dedupeCheckPass: false,
      verifierConfirmedNotExecuted: false,
      evidenceRecorded: false,
    }
    expect(isRedispatchAllowed(productionFacts)).toBe(false)
    // Satu-satunya jalur aman runtime adalah "efek PASTI belum mulai".
    expect(isRedispatchAllowed({ ...productionFacts, effectDefinitelyNotStarted: true })).toBe(true)
  })

  test("evaluateResume menuntut keempat bukti positif", () => {
    const all = {
      runtimeStateCurrent: true,
      storageUsable: true,
      leaseValid: true,
      authorityCurrent: true,
    }
    expect(evaluateResume(all).resume).toBe(true)
    for (const key of Object.keys(all) as Array<keyof typeof all>) {
      const decision = evaluateResume({ ...all, [key]: false })
      expect({ key, resume: decision.resume, missing: decision.missing }).toEqual({
        key,
        resume: false,
        missing: [key],
      })
      // Record tetap dipertahankan secara kontrak.
      expect(decision.recordRetained).toBe(true)
    }
  })

  test("SELURUH tool otonom 6S adalah READ_ONLY; satu tool lain membatalkan bukti", () => {
    expect(AUTONOMOUS_TOOL_NAMES.length).toBeGreaterThan(0)
    for (const name of AUTONOMOUS_TOOL_NAMES) {
      const tool = classifyTool(name)
      expect({ name, autonomous: tool.autonomous, capability: tool.capability }).toEqual({
        name,
        autonomous: true,
        capability: "READ_ONLY",
      })
    }
    expect(retrySafetyForToolScope(AUTONOMOUS_TOOL_NAMES)).toBe("READ_ONLY_TOOL_SCOPE")
    // Fail-closed: satu tool tulis/eksekusi/tak dikenal = UNPROVEN.
    expect(retrySafetyForToolScope([...AUTONOMOUS_TOOL_NAMES, "bash"])).toBe("UNPROVEN")
    expect(retrySafetyForToolScope(["write_file"])).toBe("UNPROVEN")
    expect(retrySafetyForToolScope(["tidak_ada_di_matriks"])).toBe("UNPROVEN")
    expect(retrySafetyForToolScope([])).toBe("UNPROVEN")
  })

  test("classifyContinuity: marker bukan izin; bukti hilang = HOLD", () => {
    const facts: ContinuityFacts = {
      status: "IN_PROGRESS",
      executionOwner: "scheduler",
      execGeneration: 1,
      attemptGeneration: null,
      ownsSession: true,
      authorityHeld: true,
      incarnationMatches: true,
    }
    const safe: ContinuityEvidence = {
      resume: true,
      missing: [],
      admission: "ALLOW",
      retrySafety: "READ_ONLY_TOOL_SCOPE",
    }
    const unproven: ContinuityEvidence = { ...safe, retrySafety: "UNPROVEN" }

    expect(hasCompletionMarker({ execGeneration: 2, attemptGeneration: 2 })).toBe(true)
    expect(hasCompletionMarker({ execGeneration: 2, attemptGeneration: 1 })).toBe(false)
    expect(hasCompletionMarker({ execGeneration: 2, attemptGeneration: null })).toBe(false)
    expect(classifyContinuity(facts, safe).class).toBe("SAFE_TO_RETRY")
    // Marker ada -> attempt sudah berakhir, apa pun cakupan tool-nya.
    expect(classifyContinuity({ ...facts, attemptGeneration: 1 }, safe)).toEqual({
      class: "HOLD",
      reason: "attempt-completed",
      mayReconcile: false,
    })
    // Tanpa bukti keselamatan, bukan "coba saja".
    expect(classifyContinuity(facts, unproven)).toEqual({
      class: "REQUIRES_VERIFIER",
      reason: "retry-safety-unproven",
      mayReconcile: false,
    })
    for (const missing of [
      { ownsSession: false },
      { authorityHeld: false },
      { incarnationMatches: false },
      { executionOwner: null },
      { execGeneration: 0 },
    ] as const) {
      const verdict = classifyContinuity({ ...facts, ...missing }, safe)
      expect({ verdict, missing }).toMatchObject({
        verdict: { class: "HOLD", mayReconcile: false },
      })
    }
    expect(
      classifyContinuity(facts, { ...safe, resume: false, missing: ["storageUsable"] }),
    ).toEqual({
      class: "HOLD",
      reason: "resume-missing:storageUsable",
      mayReconcile: false,
    })
    expect(classifyContinuity(facts, { ...safe, admission: "REFUSE" })).toEqual({
      class: "HOLD",
      reason: "admission-refuse",
      mayReconcile: false,
    })
    expect(classifyContinuity({ ...facts, status: "COMPLETED" }, safe).class).toBe("HOLD")
  })
})

// ── 1/5. Crash setelah claim sebelum dispatch ───────────────────────────────

describe("P13.3 Stage C — crash setelah claim, rekonsiliasi aman", () => {
  test("1/5. satu rekonsiliasi + SATU claim baru (generasi baru), bukan replay", async () => {
    const t = addAndClaim("crash-before-dispatch")
    const claimed = row(t.id)
    expect(claimed).toMatchObject({
      status: "IN_PROGRESS",
      exec_generation: 1,
      attempt_generation: null,
      execution_owner: "scheduler",
    })

    const h = harness()
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([t.id])
    // Revert hanya status/ownership; lineage TIDAK dihapus.
    expect(row(t.id)).toMatchObject({
      status: "PENDING",
      exec_generation: 1,
      attempt_generation: null,
      execution_owner: null,
      revision: claimed.revision + 1,
    })

    const result = await h.sc.cycle()
    expect(result.stop).toBe("already-dispatched")
    expect(h.seen.length).toBe(1)
    expect(h.seen[0]?.taskId).toBe(t.id)

    const after = row(t.id)
    expect(after.status).toBe("IN_PROGRESS")
    expect(after.exec_generation).toBe(2) // claim baru, bukan generasi lama
    expect(after.attempt_generation).toBe(2) // attempt baru mencatat akhirnya
    expect(after.execution_owner).toBe("scheduler")
    expect(after.revision).toBe(claimed.revision + 2) // revert + claim = dua mutasi revisi
    await h.sc.stop()
  })

  test("2. crash setelah kerja mulai: runtime menolak replay; scope non-read-only = HOLD", async () => {
    // Bentuk durable-nya SAMA dengan #1: marker tidak ada. Itulah sebabnya
    // ketiadaan marker tidak boleh dipakai sebagai bukti.
    const t = addAndClaim("crash-mid-work")
    const h = harness({ continuity: gate({ retrySafety: "UNPROVEN" }) })
    h.sc.start()

    expect(h.sc.reconcile()).toEqual([])
    expect(row(t.id)).toMatchObject({
      status: "IN_PROGRESS",
      exec_generation: 1,
      attempt_generation: null,
      execution_owner: "scheduler",
    })
    expect(held(h.events)).toEqual([
      {
        kind: "task:continuity_held",
        taskId: t.id,
        class: "REQUIRES_VERIFIER",
        reason: "retry-safety-unproven",
      },
    ])

    // Siklus berikutnya tetap tidak boleh claim: status bukan PENDING.
    expect((await h.sc.cycle()).stop).toBe("no-candidates")
    expect(h.seen.length).toBe(0)
    await h.sc.stop()
  })

  test("3. marker kompletion ada → tidak ada replay otomatis", async () => {
    const t = addAndClaim()
    expect(store.recordAttemptReturned(S, t.id, t.execGeneration)).toBe("RECORDED")
    const before = row(t.id)
    expect(before).toMatchObject({ attempt_generation: 1, exec_generation: 1 })

    const h = harness()
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])
    expect((await h.sc.cycle()).stop).toBe("no-candidates")
    expect(h.seen.length).toBe(0)
    expect(held(h.events).map((e) => e.reason)).toContain("attempt-completed")
    // Baris tidak berubah sama sekali.
    expect(row(t.id)).toEqual(before)
    await h.sc.stop()
  })
})

// ── 4. VERIFYING ────────────────────────────────────────────────────────────

describe("P13.3 Stage C — VERIFYING", () => {
  test("4a. VERIFYING tanpa marker tetapi tanpa bukti retry-safety → HOLD", async () => {
    const t = addAndClaim("verifying-hold")
    store.patchTask(S, t.id, { status: "VERIFYING" })
    const before = row(t.id)
    expect(before).toMatchObject({ status: "VERIFYING", attempt_generation: null })

    const h = harness({ continuity: gate({ retrySafety: "UNPROVEN" }) })
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])
    expect((await h.sc.cycle()).stop).toBe("no-candidates")
    expect(h.seen.length).toBe(0)
    expect(row(t.id)).toEqual(before)
    await h.sc.stop()
  })

  test("4b. VERIFYING DENGAN marker → HOLD (verifier/operator), bukan replay", async () => {
    const t = addAndClaim("verifying-marker")
    store.patchTask(S, t.id, { status: "VERIFYING" })
    expect(store.recordAttemptReturned(S, t.id, t.execGeneration)).toBe("RECORDED")
    const before = row(t.id)
    expect(before.attempt_generation).toBe(1)

    const h = harness() // read-only pun tidak mengubah aturan marker
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])
    expect(held(h.events).map((e) => e.class)).toContain("HOLD")
    expect(row(t.id)).toEqual(before)
    await h.sc.stop()
  })
})

// ── 6. Stale revision + competing scheduler ─────────────────────────────────

describe("P13.3 Stage C — balapan tidak boleh memutasi/mendispatch", () => {
  test("6a. competing scheduler dalam satu proses → start ditolak, nol dispatch", async () => {
    const t = addAndClaim("competing")
    const before = row(t.id)
    const a = harness()
    const b = harness()
    a.sc.start()
    try {
      expect(() => b.sc.start()).toThrow(/already owned/i)
      expect(b.sc.getLifecycle()).toBe("STOPPED")
      expect(b.sc.reconcile()).toEqual([])
      expect((await b.sc.cycle()).stop).toBe("not-running")
      expect(b.seen.length).toBe(0)
      expect(row(t.id)).toEqual(before)
    } finally {
      await a.sc.stop()
    }
  })

  test("6b. revision bergerak setelah snapshot → REJECTED_STALE, tanpa dispatch", async () => {
    const t = addAndClaim("stale-revision")
    const before = row(t.id)
    const race = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === "getSnapshot") {
          return (sid: string) => {
            const snap = target.getSnapshot(sid)
            // Penulis lain memindahkan baris setelah snapshot diambil.
            for (const task of snap.tasks) target.patchTask(sid, task.id, { title: "newer" })
            return snap
          }
        }
        return Reflect.get(target, prop, recv)
      },
    }) as TaskStore

    const h = harness({ store: race })
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])
    expect(h.seen.length).toBe(0)
    const after = row(t.id)
    expect(after.status).toBe("IN_PROGRESS")
    expect(after.exec_generation).toBe(before.exec_generation)
    expect(after.attempt_generation).toBeNull()
    expect(after.execution_owner).toBe("scheduler")
    expect(after.revision).toBe(before.revision + 1) // hanya tulisan luar
    await h.sc.stop()
  })

  test("6c. otoritas hilang SAAT evidence dibaca → re-check tepat sebelum mutasi menahan", async () => {
    const t = addAndClaim("mid-pass-authority")
    const before = row(t.id)
    const h = harness({
      continuity: {
        evidence: () => {
          // Pengganti mengambil alih DI TENGAH pass, setelah snapshot dan
          // sebelum UPDATE. Gate sudah "lolos" secara isi; yang harus menahan
          // adalah verifikasi ulang tepat sebelum mutasi.
          const db = new Database(dbPath())
          db.prepare(
            "UPDATE session_authority SET lease_expires_at = ? WHERE session_id = ? AND incarnation = ?",
          ).run(Date.now() - 1, S, store.getSessionIncarnation(S))
          db.close()
          expect(store.acquireSessionAuthority(S, "midpass-owner", SESSION_LEASE_MS)).toBe(
            "ACQUIRED",
          )
          return {
            resume: true,
            missing: [],
            admission: "ALLOW",
            retrySafety: "READ_ONLY_TOOL_SCOPE",
          }
        },
      },
    })
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])
    expect(row(t.id)).toEqual(before)
    expect(h.sc.getLifecycle()).toBe("STOPPED")
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("midpass-owner")
    await h.sc.stop()
    // Stop token-guarded: lease pengganti tidak terhapus.
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("midpass-owner")
  })

  test("6d. sesi superseded SAAT evidence dibaca → tidak me-revert task sesi baru", async () => {
    const t = addAndClaim("mid-pass-incarnation")
    const before = row(t.id)
    const h = harness({
      continuity: {
        evidence: () => {
          // Sesi dihapus/dibuat ulang setelah snapshot. ID task bisa sama;
          // incarnation yang membedakan, dan re-check harus menangkapnya.
          store.bumpSessionIncarnation(S)
          return {
            resume: true,
            missing: [],
            admission: "ALLOW",
            retrySafety: "READ_ONLY_TOOL_SCOPE",
          }
        },
      },
    })
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])
    expect(row(t.id)).toEqual(before)
    expect(h.sc.getLifecycle()).toBe("STOPPED")
    await h.sc.stop()
  })
})

// ── 7. Expired lease takeover ────────────────────────────────────────────────

describe("P13.3 Stage C — takeover lease kedaluwarsa", () => {
  test("7. expiry diverifikasi + acquire sukses; token lama tak bisa renew/release/dispatch", async () => {
    const t = addAndClaim("lease-takeover")
    const h = harness()
    h.sc.start()
    const oldToken = (h.sc as unknown as { authorityToken: string | null }).authorityToken
    if (oldToken === null) throw new Error("scheduler tidak memegang token")
    expect(store.holdsSessionAuthority(S, oldToken)).toBe(true)

    // Expire baris secara eksplisit (fault injection), lalu ambil alih lewat
    // SATU-SATUNYA primitif yang sah.
    const db = new Database(dbPath())
    db.prepare(
      "UPDATE session_authority SET lease_expires_at = ? WHERE session_id = ? AND incarnation = ?",
    ).run(Date.now() - 1, S, store.getSessionIncarnation(S))
    db.close()
    expect(store.holdsSessionAuthority(S, oldToken)).toBe(false)
    expect(store.acquireSessionAuthority(S, "new-owner", SESSION_LEASE_MS)).toBe("ACQUIRED")

    // Token lama tidak boleh memperpanjang, melepas, atau dianggap sah.
    expect(store.renewSessionAuthority(S, oldToken, SESSION_LEASE_MS)).toBe("AUTHORITY_LOST")
    expect(store.releaseSessionAuthority(S, oldToken)).toBe(false)
    expect(store.holdsSessionAuthority(S, oldToken)).toBe(false)

    // Instance lama tidak boleh mengklaim task setelah otoritasnya hilang.
    expect((await h.sc.cycle()).stop).toBe("authority-lost")
    expect(h.seen.length).toBe(0)
    expect(row(t.id)).toMatchObject({
      status: "IN_PROGRESS",
      exec_generation: 1,
      attempt_generation: null,
      execution_owner: "scheduler",
    })
    await h.sc.stop()
    // Release saat stop juga token-guarded: milik pengganti tidak terhapus.
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("new-owner")
  })
})

// ── 8/9. Identitas sesi: restart vs supersession ────────────────────────────

describe("P13.3 Stage C — identitas sesi persisten", () => {
  test("8. restart sesi yang SAMA mempertahankan kontinuitas (incarnation tetap)", async () => {
    const t = addAndClaim("restart")
    const incarnation = store.getSessionIncarnation(S)

    const a = harness()
    a.sc.start()
    await a.sc.stop() // proses mati tanpa menyentuh task
    expect(row(t.id).status).toBe("IN_PROGRESS")

    const b = harness()
    b.sc.start()
    expect(store.getSessionIncarnation(S)).toBe(incarnation)
    expect(b.sc.reconcile()).toEqual([t.id])
    expect((await b.sc.cycle()).stop).toBe("already-dispatched")
    expect(b.seen.length).toBe(1)
    expect(row(t.id)).toMatchObject({ exec_generation: 2, attempt_generation: 2 })
    await b.sc.stop()
  })

  test("9. sesi yang benar-benar superseded TIDAK boleh menjalankan record lama", async () => {
    const t = addAndClaim("superseded")
    const oldIncarnation = store.getSessionIncarnation(S)
    const old = harness()
    old.sc.start()

    // Sesi dihapus & dibuat ulang dengan id yang sama (lifecycle baru).
    store.deleteSessionTasks(S)
    store.bumpSessionIncarnation(S)
    const recreatedId = add("NEW SESSION WORK")
    expect(recreatedId).toBe(t.id) // id task memang restart; incarnation yang membedakan
    expect(store.getSessionIncarnation(S)).not.toBe(oldIncarnation)

    // Snapshot sebelum cycle: record baru masih PENDING, bukan milik eksekusi lama.
    const before = row(recreatedId)
    expect(before).toMatchObject({
      status: "PENDING",
      exec_generation: 0,
      attempt_generation: null,
      execution_owner: null,
    })

    expect((await old.sc.cycle()).stop).toBe("session-superseded")
    expect(old.seen.length).toBe(0)
    expect(row(recreatedId)).toEqual(before)
    await old.sc.stop()
  })
})

// ── 10/11. Bukti hilang + admission refusal ─────────────────────────────────

describe("P13.3 Stage C — bukti hilang menahan, bukan menghapus", () => {
  const cases: Array<{ name: string; evidence: Partial<ContinuityEvidence> }> = [
    {
      name: "storage/journal tidak usable",
      evidence: { resume: false, missing: ["storageUsable"] },
    },
    { name: "runtime state basi", evidence: { resume: false, missing: ["runtimeStateCurrent"] } },
    { name: "lease tidak valid", evidence: { resume: false, missing: ["leaseValid"] } },
    { name: "admission REFUSE", evidence: { admission: "REFUSE" } },
    { name: "admission SCOPED", evidence: { admission: "SCOPED" } },
  ]

  for (const c of cases) {
    test(`10. ${c.name} → HOLD, record utuh`, async () => {
      const t = addAndClaim(c.name)
      const before = row(t.id)
      const h = harness({ continuity: gate(c.evidence) })
      h.sc.start()
      expect(h.sc.reconcile()).toEqual([])
      const result = await h.sc.cycle()
      expect(result.stop).toBe("no-candidates")
      expect(h.seen.length).toBe(0)
      // Nol niat eksekusi: tak ada selection/claim/dispatch.
      expect(
        h.events.filter((e) =>
          [
            "task:selected",
            "task:claimed",
            "task:dispatch_started",
            "task:execution_started",
          ].includes(e.kind),
        ),
      ).toEqual([])
      expect(row(t.id)).toEqual(before)
      await h.sc.stop()
    })
  }

  test("10b. TANPA gate kontinuitas = HOLD (default fail-closed)", async () => {
    const t = addAndClaim("no-gate")
    const before = row(t.id)
    const h = harness({ continuity: null })
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])
    expect((await h.sc.cycle()).stop).toBe("no-candidates")
    expect(h.seen.length).toBe(0)
    expect(held(h.events)[0]).toMatchObject({
      class: "HOLD",
      reason: "resume-missing:continuity-gate-missing",
    })
    expect(row(t.id)).toEqual(before)
    await h.sc.stop()
  })

  test("10c. gate yang MELEMPAR = bukti hilang, bukan izin", async () => {
    const t = addAndClaim("throwing-gate")
    const before = row(t.id)
    const h = harness({
      continuity: {
        evidence: () => {
          throw new Error("runtime probe failed")
        },
      },
    })
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])
    expect(h.seen.length).toBe(0)
    expect(held(h.events)[0]).toMatchObject({
      class: "HOLD",
      reason: "resume-missing:continuity-gate-error",
    })
    expect(row(t.id)).toEqual(before)
    await h.sc.stop()
  })
})
