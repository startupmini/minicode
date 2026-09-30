// PHASE 6P — durable task execution ownership.
//
// F1 (6N): `IN_PROGRESS` is overloaded between interactive/model work and
// Scheduler-owned execution, so reconciliation reverted the user's plan cursor.
//
// 6O proved the fix cannot live in the existing columns: histories H2 and H5 are
// byte-identical under (status, exec_generation, attempt_generation) and demand
// OPPOSITE actions. This file pins the resolution - a fourth durable fact,
// `execution_owner` - and proves the histories are now separated.

import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Task, TaskStatus } from "../src/task/model.ts"
import { type ExecutionObservation, Scheduler } from "../src/task/scheduler.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import {
  type ExecutionLineage,
  type ExecutionOwner,
  resetTaskStoreHandles,
  TaskStore,
} from "../src/task/store.ts"

let dir: string
let store: TaskStore
/** The interactive/model-facing writer. LEGACY authority by default. */
let legacy: TaskStore

const S = "6p"
const prov = { origin: "model", source: "6p" } as const

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6p-"))
  store = new TaskStore(dir, { authority: "SCHEDULER" })
  legacy = new TaskStore(dir)
  resetSessionOwnershipForTests()
})
afterEach(async () => {
  resetSessionOwnershipForTests()
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

// ── helpers ──────────────────────────────────────────────────────────────────

const add = (status: TaskStatus = "PENDING", over: Partial<Task> = {}): Task =>
  store.createTask(S, { title: `t ${status}`, status, order: 1, provenance: prov, ...over })

/** A real Scheduler claim: IN_PROGRESS, exec=1, execution_owner='scheduler'. */
function claim(t: Task): number {
  const r = store.claimTask(S, t.id, t.revision)
  if (r.outcome !== "CLAIM_ACCEPTED") throw new Error(`claim rejected: ${r.outcome}`)
  return r.execGeneration
}

const lin = (s: TaskStore, id: string): ExecutionLineage | null => s.getExecutionLineage(S, id)
const own = (s: TaskStore, id: string): ExecutionOwner | null =>
  s.getExecutionOwnership(S, id)?.executionOwner ?? null

/** A Scheduler that never dispatches; used only for reconcile(). */
function reconcileOnly(s: TaskStore = store): Scheduler {
  const sc = new Scheduler(S, {
    store: s,
    runTurn: (): ExecutionObservation => ({ kind: "returned", ok: true }),
    instruction: "x",
  })
  sc.start()
  return sc
}

// ═══ A. THE 6O HISTORY TABLE — the whole point of the phase ═════════════════

describe("A. history table: H1/H2/H5 are separated by durable ownership", () => {
  test("H1. interactive IN_PROGRESS (never claimed) is LEFT ALONE", () => {
    const t = add("PENDING")
    // The model writes its plan cursor. No claim, ever.
    legacy.patchTask(S, t.id, { status: "IN_PROGRESS" })
    expect(own(store, t.id)).toBeNull()
    expect(lin(store, t.id)).toEqual({ execGeneration: 0, attemptGeneration: null })

    const sc = reconcileOnly()
    expect(sc.reconcile()).toEqual([])
    expect(store.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  })

  test("H2. a stranded claim IS reverted", () => {
    const t = add("PENDING")
    claim(t)
    expect(own(store, t.id)).toBe("scheduler")
    expect(lin(store, t.id)).toEqual({ execGeneration: 1, attemptGeneration: null })

    const sc = reconcileOnly()
    expect(sc.reconcile()).toEqual([t.id])
    expect(store.getTask(S, t.id)?.status).toBe("PENDING")
    // Reverting RELEASES ownership.
    expect(own(store, t.id)).toBeNull()
  })

  test("H5. claim -> reconcile -> user IN_PROGRESS is LEFT ALONE (the 6O collision)", () => {
    const t = add("PENDING")
    claim(t)

    // crash, then an owner reconciles. The SAME Scheduler reconciles again below:
    // one owner, two cycles, which is the realistic shape.
    const sc = reconcileOnly()
    expect(sc.reconcile()).toEqual([t.id])
    expect(own(store, t.id)).toBeNull()

    // ...and only THEN does the user mark it in progress.
    legacy.patchTask(S, t.id, { status: "IN_PROGRESS" })

    // Under 6P this is distinguishable from a fresh H2: same status, same
    // exec_generation (1, never reset), same attempt_generation (NULL) - but the
    // ownership fact differs, and that is what decides.
    const row = store.getTask(S, t.id)!
    const l = lin(store, t.id)!
    expect([row.status, l.execGeneration, l.attemptGeneration]).toEqual(["IN_PROGRESS", 1, null])
    expect(own(store, t.id)).toBeNull()

    expect(sc.reconcile()).toEqual([])
    expect(store.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  })

  test("H2 and H5 differ ONLY in ownership, and the difference is the decision", () => {
    // ONE owner for the whole test: two Schedulers cannot hold the same session
    // (ownership fails closed), and a single owner reconciling twice is the
    // realistic shape anyway.
    const sc = reconcileOnly()

    // Build H5 FIRST and reconcile it, so that when H2 is created the single
    // reconcile below has nothing left to revert in it.
    const h5 = add("PENDING", { order: 2 })
    claim(h5)
    expect(sc.reconcile()).toEqual([h5.id])
    legacy.patchTask(S, h5.id, { status: "IN_PROGRESS" })

    // Now build H2: a claim that is still stranded.
    const h2 = add("PENDING")
    claim(h2)

    // Same observable triple...
    const trip = (id: string) => {
      const r = store.getTask(S, id)!
      const l = lin(store, id)!
      return `${r.status}/${l.execGeneration}/${l.attemptGeneration}`
    }
    expect(trip(h2.id)).toBe("IN_PROGRESS/1/null")
    expect(trip(h5.id)).toBe(trip(h2.id))
    // ...and one durable field apart.
    expect(own(store, h2.id)).toBe("scheduler")
    expect(own(store, h5.id)).toBeNull()

    // and the difference is exactly what reconciliation acts on
    expect(sc.reconcile()).toEqual([h2.id])
    expect(store.getTask(S, h2.id)?.status).toBe("PENDING")
    expect(store.getTask(S, h5.id)?.status).toBe("IN_PROGRESS")
  })

  test("H6. claim -> crash -> user IN_PROGRESS (no reconcile between) is REVERTED", () => {
    // 6O H3/H6: the plan cursor does not end a stranded execution. Only a
    // legitimate authority may end a Scheduler execution.
    const t = add("PENDING")
    claim(t)
    legacy.patchTask(S, t.id, { status: "IN_PROGRESS" })
    expect(own(store, t.id)).toBe("scheduler")

    const sc = reconcileOnly()
    expect(sc.reconcile()).toEqual([t.id])
    expect(store.getTask(S, t.id)?.status).toBe("PENDING")
  })

  test("H7. H5 shape survives a Scheduler restart and is still left alone", async () => {
    const t = add("PENDING")
    claim(t)
    const first = reconcileOnly()
    first.reconcile()
    legacy.patchTask(S, t.id, { status: "IN_PROGRESS" })
    // [PHASE 6X] A process that exits releases its lease. Stopping is that exit:
    // the successor is then free to acquire, which is what a graceful shutdown
    // does. The CRASH case (no stop, lease held until expiry) is 6X's to test -
    // here we only assert the shape survives a clean handover.
    await first.stop()

    // new store handle + new Scheduler = a fresh process
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const reopened = new TaskStore(dir, { authority: "SCHEDULER" })
    const sc = reconcileOnly(reopened)
    expect(sc.reconcile()).toEqual([])
    expect(reopened.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  })

  test("H8. claim -> external status mutation -> restart -> reconcile", () => {
    const t = add("PENDING")
    claim(t)
    // the user completes it: leaves the in-flight states, so ownership is released
    legacy.patchTask(S, t.id, { status: "COMPLETED" })
    expect(own(store, t.id)).toBeNull()

    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const reopened = new TaskStore(dir, { authority: "SCHEDULER" })
    expect(reconcileOnly(reopened).reconcile()).toEqual([])
    expect(reopened.getTask(S, t.id)?.status).toBe("COMPLETED")
  })

  test("H9. interactive IN_PROGRESS survives restart and is still left alone", () => {
    const t = add("PENDING")
    legacy.patchTask(S, t.id, { status: "IN_PROGRESS" })

    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const reopened = new TaskStore(dir, { authority: "SCHEDULER" })
    expect(reconcileOnly(reopened).reconcile()).toEqual([])
    expect(reopened.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  })
})

// ═══ B. CLAIM SEMANTICS ═════════════════════════════════════════════════════

describe("B. claim establishes ownership atomically", () => {
  test("B1. an accepted claim sets status, generation AND ownership together", () => {
    const t = add("PENDING")
    claim(t)
    expect(store.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
    expect(lin(store, t.id)).toEqual({ execGeneration: 1, attemptGeneration: null })
    expect(own(store, t.id)).toBe("scheduler")
  })

  test("B2. a REJECTED claim advances nothing at all", () => {
    const t = add("PENDING")
    // wrong revision -> stale rejection
    const stale = store.claimTask(S, t.id, t.revision + 99)
    expect(stale.outcome).toBe("CLAIM_REJECTED_STALE")
    expect(stale.execGeneration).toBe(0)
    expect(own(store, t.id)).toBeNull()
    expect(store.getTask(S, t.id)?.status).toBe("PENDING")

    // wrong state -> not claimable
    claim(t)
    const again = store.claimTask(S, t.id, store.getTask(S, t.id)!.revision)
    expect(again.outcome).toBe("WRONG_STATE")
    expect(again.execGeneration).toBe(1) // unchanged current value, not a new one
  })

  test("B3. a re-claim after reconcile re-establishes ownership", () => {
    const t = add("PENDING")
    claim(t)
    reconcileOnly().reconcile()
    expect(own(store, t.id)).toBeNull()

    const r = store.claimTask(S, t.id, store.getTask(S, t.id)!.revision)
    expect(r.outcome).toBe("CLAIM_ACCEPTED")
    expect(r.execGeneration).toBe(2) // generation is monotonic across recovery
    expect(own(store, t.id)).toBe("scheduler")
  })

  test("B4. a completed generation is never reconciled", () => {
    const t = add("PENDING")
    const g = claim(t)
    store.recordAttemptReturned(S, t.id, g)
    expect(lin(store, t.id)).toEqual({ execGeneration: 1, attemptGeneration: 1 })
    expect(reconcileOnly().reconcile()).toEqual([])
    expect(store.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  })
})

// ═══ C. OWNERSHIP TRANSITIONS ════════════════════════════════════════════════

describe("C. ownership transitions", () => {
  test("C1. leaving the in-flight states releases ownership", () => {
    for (const status of ["COMPLETED", "FAILED", "CANCELLED", "BLOCKED", "PENDING"] as const) {
      const t = add("PENDING")
      claim(t)
      expect(own(store, t.id)).toBe("scheduler")
      legacy.patchTask(S, t.id, { status, ...(status === "BLOCKED" ? { blockedReason: "x" } : {}) })
      expect(own(store, t.id)).toBeNull()
    }
  })

  test("C2. staying inside the in-flight states RETAINS ownership", () => {
    const a = add("PENDING")
    claim(a)
    legacy.patchTask(S, a.id, { status: "IN_PROGRESS" })
    expect(own(store, a.id)).toBe("scheduler")

    const b = add("PENDING", { order: 2 })
    claim(b)
    legacy.patchTask(S, b.id, { status: "VERIFYING" })
    expect(own(store, b.id)).toBe("scheduler")
  })

  test("C3. NON-status writes never touch ownership", () => {
    const t = add("PENDING")
    claim(t)
    legacy.patchTask(S, t.id, { title: "renamed" })
    expect(own(store, t.id)).toBe("scheduler")
    legacy.patchTask(S, t.id, { order: 9 })
    expect(own(store, t.id)).toBe("scheduler")
    legacy.patchTask(S, t.id, { evidence: [{ kind: "file.changed", detail: "x" } as never] })
    expect(own(store, t.id)).toBe("scheduler")
    // and the stranded claim is still recoverable afterwards
    expect(reconcileOnly().reconcile()).toEqual([t.id])
  })

  test("C4. a fresh task is never owned", () => {
    // `createTask` enforces authority too, so an in-flight status must be
    // created through the LEGACY writer - which is exactly the real path a
    // model-facing write takes. Either way no ownership is created.
    for (const status of ["PENDING", "IN_PROGRESS", "VERIFYING"] as const) {
      const t = legacy.createTask(S, { title: `n ${status}`, status, order: 1, provenance: prov })
      expect(own(store, t.id)).toBeNull()
    }
  })

  test("C5. reconcileStranded (the dispatch-failure path) also requires ownership", () => {
    const t = add("PENDING")
    // an interactive IN_PROGRESS with no claim must NOT be revertable by it
    legacy.patchTask(S, t.id, { status: "IN_PROGRESS" })
    const r = store.reconcileStranded(S, t.id, store.getTask(S, t.id)!.revision, {
      ownsSession: true,
    })
    expect(r.outcome).toBe("NOT_STRANDED")
    expect(store.getTask(S, t.id)?.status).toBe("IN_PROGRESS")

    // a real claim is revertable, and ownership is released
    const u = add("PENDING", { order: 2 })
    claim(u)
    const r2 = store.reconcileStranded(S, u.id, store.getTask(S, u.id)!.revision, {
      ownsSession: true,
    })
    expect(r2.outcome).toBe("RECONCILED")
    expect(own(store, u.id)).toBeNull()
  })

  test("C6. reconcile fails closed without session ownership", () => {
    const t = add("PENDING")
    claim(t)
    const r = store.reconcileIfNoCompletedAttempt(S, t.id, store.getTask(S, t.id)!.revision, {
      ownsSession: false,
    })
    expect(r.outcome).toBe("REFUSED_NO_OWNERSHIP")
    expect(own(store, t.id)).toBe("scheduler")
    expect(store.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  })
})

// ═══ D. PERSISTENCE / RESTART ═══════════════════════════════════════════════

describe("D. ownership is durable", () => {
  test("D1. ownership survives a TaskStore reopen", () => {
    const t = add("PENDING")
    claim(t)
    resetTaskStoreHandles()
    const reopened = new TaskStore(dir, { authority: "SCHEDULER" })
    expect(reopened.getExecutionOwnership(S, t.id)?.executionOwner).toBe("scheduler")
  })

  test("D2. a stranded owned task is recovered by a NEW Scheduler after restart", () => {
    const t = add("PENDING")
    claim(t)
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const reopened = new TaskStore(dir, { authority: "SCHEDULER" })
    expect(reconcileOnly(reopened).reconcile()).toEqual([t.id])
    expect(reopened.getTask(S, t.id)?.status).toBe("PENDING")
    expect(reopened.getExecutionOwnership(S, t.id)?.executionOwner).toBeNull()
  })

  test("D3. an interactive IN_PROGRESS after restart is still left alone", () => {
    const t = add("PENDING")
    legacy.patchTask(S, t.id, { status: "IN_PROGRESS" })
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const reopened = new TaskStore(dir, { authority: "SCHEDULER" })
    expect(reconcileOnly(reopened).reconcile()).toEqual([])
    expect(reopened.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  })
})

// ═══ E. MIGRATION ════════════════════════════════════════════════════════════

describe("E. schema migration", () => {
  const cols = (d: string): string[] => {
    const db = new Database(join(d, ".minicode", "tasks.db"))
    const n = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(
      (r) => r.name,
    )
    db.close()
    return n
  }

  test("E1. a database created before 6P gains the column on open", async () => {
    // A pre-6I database: lineage columns present, ownership absent.
    const d = await mkdtemp(join(tmpdir(), "minicode-6p-mig-"))
    const s0 = new TaskStore(d, { authority: "SCHEDULER" })
    const t = s0.createTask(S, {
      title: "legacy row",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    s0.claimTask(S, t.id, s0.getTask(S, t.id)!.revision)
    // captured AFTER the claim, so this is the revision the migration must preserve
    const rev = s0.getTask(S, t.id)!.revision
    expect(rev).toBe(2)
    resetTaskStoreHandles()

    const db = new Database(join(d, ".minicode", "tasks.db"))
    db.exec("ALTER TABLE tasks DROP COLUMN execution_owner")
    db.close()
    expect(cols(d)).not.toContain("execution_owner")

    const s1 = new TaskStore(d, { authority: "SCHEDULER" })
    // The constructor is LAZY (store.ts:668): no handle is opened and therefore
    // no migration runs until the first operation. `initialize()` is the explicit
    // "open the database now" entry point, so the migration is observable here.
    s1.initialize()
    expect(cols(d)).toContain("execution_owner")
    // existing row, revision, lineage and relations all preserved
    expect(s1.getTask(S, t.id)?.revision).toBe(rev)
    expect(s1.getExecutionLineage(S, t.id)).toEqual({ execGeneration: 1, attemptGeneration: null })
    // NO backfill: an un-migrated row is not guessed to be owned
    expect(s1.getExecutionOwnership(S, t.id)?.executionOwner).toBeNull()
    await rm(d, { recursive: true, force: true }).catch(() => {})
  })

  test("E2. migration is idempotent across repeated opens", async () => {
    for (let i = 0; i < 3; i++) {
      resetTaskStoreHandles()
      const s = new TaskStore(dir, { authority: "SCHEDULER" })
      expect(
        s.createTask(S, { title: `i${i}`, status: "PENDING", order: i + 1, provenance: prov }).id,
      )
    }
    expect(cols(dir).filter((c) => c === "execution_owner").length).toBe(1)
  })

  test("E3. a NULL-lineage row migrates to a sane ownership default", async () => {
    const d = await mkdtemp(join(tmpdir(), "minicode-6p-mig2-"))
    const s0 = new TaskStore(d, { authority: "SCHEDULER" })
    const t = s0.createTask(S, {
      title: "never claimed",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    resetTaskStoreHandles()
    const db = new Database(join(d, ".minicode", "tasks.db"))
    db.exec("ALTER TABLE tasks DROP COLUMN execution_owner")
    db.close()

    const s1 = new TaskStore(d, { authority: "SCHEDULER" })
    expect(s1.getExecutionLineage(S, t.id)).toEqual({ execGeneration: 0, attemptGeneration: null })
    expect(s1.getExecutionOwnership(S, t.id)?.executionOwner).toBeNull()
    await rm(d, { recursive: true, force: true }).catch(() => {})
  })

  test("E4. dependency and parent relations survive the migration", async () => {
    const d = await mkdtemp(join(tmpdir(), "minicode-6p-mig3-"))
    const s0 = new TaskStore(d, { authority: "SCHEDULER" })
    const p = s0.createTask(S, { title: "parent", status: "PENDING", order: 1, provenance: prov })
    const c = s0.createTask(S, {
      title: "child",
      status: "PENDING",
      order: 2,
      parentId: p.id,
      dependsOn: [p.id],
      provenance: prov,
    })
    resetTaskStoreHandles()
    const db = new Database(join(d, ".minicode", "tasks.db"))
    db.exec("ALTER TABLE tasks DROP COLUMN execution_owner")
    db.close()

    const s1 = new TaskStore(d, { authority: "SCHEDULER" })
    const after = s1.getTask(S, c.id)!
    expect(after.parentId).toBe(p.id)
    expect(after.dependsOn).toEqual([p.id])
    await rm(d, { recursive: true, force: true }).catch(() => {})
  })
})

// ═══ F. TaskAuthorityMode INTERACTION ════════════════════════════════════════

describe("F. authority mode and durable ownership are complementary", () => {
  test("F1. in-memory authority still blocks model IN_PROGRESS under SCHEDULER", () => {
    const t = store.createTask(S, { title: "auth", status: "PENDING", order: 1, provenance: prov })
    expect(() => store.patchTask(S, t.id, { status: "IN_PROGRESS" })).toThrow()
  })

  test("F2. a LEGACY writer in the SAME process is visible to the ownership model", () => {
    // The per-instance authority guard cannot see this write; durable ownership can.
    const t = store.createTask(S, { title: "mixed", status: "PENDING", order: 1, provenance: prov })
    claim(t)
    // the LEGACY store writes the same status the Scheduler already owns
    legacy.patchTask(S, t.id, { status: "IN_PROGRESS" })
    expect(own(store, t.id)).toBe("scheduler")
    expect(reconcileOnly().reconcile()).toEqual([t.id])
  })

  test("F3. durable ownership is what protects interactive work, not authority mode", () => {
    // Nothing is claimed, so a LEGACY writer is perfectly entitled to write.
    const t = store.createTask(S, { title: "free", status: "PENDING", order: 1, provenance: prov })
    legacy.patchTask(S, t.id, { status: "IN_PROGRESS" })
    expect(own(store, t.id)).toBeNull()
    expect(reconcileOnly().reconcile()).toEqual([])
    expect(store.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  })
})

// ═══ G. COMPLETION BOUNDARY + GRAPH COMPATIBILITY ═══════════════════════════

describe("G. no regression to completion or graph semantics", () => {
  test("G1. a returning execution does not complete the task", async () => {
    const t = add("PENDING")
    const sc = new Scheduler(S, {
      store,
      runTurn: (): ExecutionObservation => ({ kind: "returned", ok: true }),
      instruction: "x",
    })
    sc.start()
    await sc.cycle()
    const row = store.getTask(S, t.id)!
    expect(row.status).toBe("IN_PROGRESS")
    expect(row.evidence).toEqual([])
    expect(row.verification).toBeNull()
    // ownership survived the return, and the completed generation is not reconciled
    expect(own(store, t.id)).toBe("scheduler")
    expect(sc.reconcile()).toEqual([])
    await sc.stop()
  })

  test("G2. an external completion is honoured and unrevertable", () => {
    const t = add("PENDING")
    claim(t)
    legacy.patchTask(S, t.id, { status: "COMPLETED" })
    expect(own(store, t.id)).toBeNull()
    expect(reconcileOnly().reconcile()).toEqual([])
    expect(store.getTask(S, t.id)?.status).toBe("COMPLETED")
  })

  test("G3. ownership does not affect readiness, identity or dependencies", async () => {
    const { TaskGraph } = await import("../src/task/graph.ts")
    const dep = store.createTask(S, { title: "dep", status: "PENDING", order: 1, provenance: prov })
    const t = store.createTask(S, {
      title: "needs dep",
      status: "PENDING",
      order: 2,
      dependsOn: [dep.id],
      provenance: prov,
    })
    // claim the DEPENDENCY, then check the dependent is still not ready
    claim(dep)
    const g = new TaskGraph(store.getSnapshot(S))
    expect(g.validity().valid).toBe(true)
    expect(g.notReadyReason(t.id)?.kind).toBe("blocked")
    expect(g.readyTasks()).toEqual([])
    // ownership lives nowhere in the graph
    expect(JSON.stringify(g)).not.toContain("scheduler")
  })
})
