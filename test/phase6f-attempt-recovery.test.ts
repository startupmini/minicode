// Phase 6F/6I — execution attempt recovery and generation lineage tests.
//
// [PHASE 6I] This file previously asserted the 6F architecture: a `task_attempt`
// row keyed by the POST-CLAIM REVISION, with reconciliation comparing
// `marker.attemptRevision` against `task.revision`. Phase 6G proved that
// architecture unsound (D1: a stale marker permanently protects/wedges a newer
// generation; D2: orphaned markers contaminate a recreated taskId), and Phase
// 6H replaced it. These tests are therefore REWRITTEN, not renamed: the old
// revision-comparison assertions asserted a bug as a contract.
//
// NEW ARCHITECTURE (6H §5, §8):
//   * `tasks.exec_generation` advances ONLY on an accepted claim.
//   * `tasks.attempt_generation` names the generation whose attempt ended.
//   * The lineage predicate and the revert are ONE atomic guarded statement.
//   * Evidence lives ON the task row, so it cannot outlive the task.
//
// The invariant under test throughout:
//
//   EXECUTION != VERIFICATION != COMPLETION
//
// and, the decisive one for this phase:
//
//   revision != execution generation
//
// A normal return proves the ATTEMPT ENDED. It never proves the work was
// correct, and the Scheduler never writes COMPLETED because of it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TaskGraph } from "../src/task/graph.ts"
import type { Task, TaskStatus } from "../src/task/model.ts"
import {
  type ExecutionObservation,
  Scheduler,
  type SchedulerWorkItem,
} from "../src/task/scheduler.ts"
import {
  acquireSessionOwnership,
  resetSessionOwnershipForTests,
} from "../src/task/session-ownership.ts"
import { type ExecutionLineage, resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

let dir: string
let store: TaskStore
/** LEGACY store, used only to build fixture state a crashed Scheduler would
 *  leave behind, and to act as the external authority that changes a task. */
let legacy: TaskStore

const prov = { origin: "model", source: "6i" } as const
const S = "6i-sess"

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6i-"))
  store = new TaskStore(dir, { authority: "SCHEDULER" })
  legacy = new TaskStore(dir)
  resetSessionOwnershipForTests()
})
afterEach(async () => {
  resetSessionOwnershipForTests()
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

function add(status: TaskStatus = "PENDING", over: Partial<Task> = {}): Task {
  return store.createTask(S, { title: `t ${status}`, status, order: 1, provenance: prov, ...over })
}

/**
 * [PHASE 6P] A GENUINE Scheduler-owned stranded execution.
 *
 * Before 6P this helper fabricated the state with `legacy.createTask(status:
 * "IN_PROGRESS")`, which produced `IN_PROGRESS / exec_generation=0 /
 * attempt_generation=NULL`. That shape is not a stranded Scheduler execution at
 * all - it is exactly 6O history **H1**: an interactive writer marked the task
 * in progress and no claim ever existed. 6O requires H1 to be LEFT ALONE, so the
 * old fixture asserted the pre-6P behaviour that 6N F1 identified as a defect.
 *
 * The fixture is now built the way the real system builds it:
 *   PENDING --claimTask--> IN_PROGRESS, exec_generation=1, execution_owner='scheduler'
 * and, for VERIFYING, the model-facing write afterwards - which RETAINS
 * ownership because VERIFYING is one of the Scheduler-owned in-flight states.
 *
 * This is a STRONGER fixture: it exercises the real claim path instead of
 * hand-planting a status, so these tests now also prove that ownership is
 * established by a claim and survives a later status write.
 */
function addStranded(status: "IN_PROGRESS" | "VERIFYING", over: Partial<Task> = {}): Task {
  const created = store.createTask(S, {
    title: `stranded ${status}`,
    status: "PENDING",
    order: 1,
    provenance: prov,
    ...over,
  })
  const claimed = store.claimTask(S, created.id, created.revision)
  if (claimed.outcome !== "CLAIM_ACCEPTED") {
    throw new Error(`addStranded: claim rejected (${claimed.outcome})`)
  }
  if (status === "VERIFYING") {
    store.patchTask(S, created.id, { status: "VERIFYING" })
  }
  return store.getTask(S, created.id)!
}

const lin = (s: TaskStore, id: string): ExecutionLineage | null => s.getExecutionLineage(S, id)

interface Harness {
  readonly sc: Scheduler
  readonly seen: SchedulerWorkItem[]
  readonly lineage: (taskId: string) => ExecutionLineage | null
}

/** A Scheduler whose bridge records every dispatched work item. */
function makeHarness(
  opts: {
    store?: TaskStore
    runTurn?: (w: SchedulerWorkItem) => ExecutionObservation | Promise<ExecutionObservation>
    ok?: boolean
  } = {},
): Harness {
  const seen: SchedulerWorkItem[] = []
  const target = opts.store ?? store
  const sc = new Scheduler(S, {
    store: target,
    runTurn: (w) => {
      seen.push(w)
      return opts.runTurn ? opts.runTurn(w) : { kind: "returned", ok: opts.ok ?? true }
    },
    instruction: "do the work",
  })
  return { sc, seen, lineage: (id) => target.getExecutionLineage(S, id) }
}

async function cycles(h: Harness, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await h.sc.cycle()
}

/** A store whose completion recording fails `failures` times, simulating a
 *  process that dies between the turn returning and the durable write. */
function flakyCompletion(
  s: TaskStore,
  failures: number,
): { store: TaskStore; attempts: () => number } {
  let attempts = 0
  let left = failures
  const proxy = new Proxy(s, {
    get(target, prop, recv) {
      if (prop === "recordAttemptReturned") {
        return (sid: string, tid: string, gen: number) => {
          attempts++
          if (left > 0) {
            left--
            throw new Error("process died before the completion record was written")
          }
          return (target as TaskStore).recordAttemptReturned(sid, tid, gen)
        }
      }
      return Reflect.get(target, prop, recv)
    },
  }) as TaskStore
  return { store: proxy, attempts: () => attempts }
}

// ═════════════════════════════════════════════════════════════════════════════
// A. NORMAL RETURN
// ═════════════════════════════════════════════════════════════════════════════

describe("A. normal return", () => {
  test("A1. an accepted claim creates generation 1; a normal return records it", async () => {
    const a = add("PENDING")
    expect(lin(store, a.id)).toEqual({ execGeneration: 0, attemptGeneration: null })

    const h = makeHarness()
    h.sc.start()
    await h.sc.cycle()

    expect(h.seen.length).toBe(1)
    expect(h.lineage(a.id)).toEqual({ execGeneration: 1, attemptGeneration: 1 })
    // The generation is NOT the revision: post-claim revision is 2.
    expect(store.getTask(S, a.id)?.revision).toBe(2)
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
  })

  test("A2. LIVENESS REGRESSION: repeated cycles with no external mutation run the task ONCE", async () => {
    // The primary proof that the 6D livelock stays dead after 6I.
    const a = add("PENDING")
    const h = makeHarness()
    h.sc.start()
    await cycles(h, 8)
    expect(h.seen.length).toBe(1)
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
    expect(h.lineage(a.id)).toEqual({ execGeneration: 1, attemptGeneration: 1 })
  })

  test("A3. normal return does not complete the task and does not redispatch", async () => {
    const a = add("PENDING")
    const h = makeHarness({ ok: true })
    h.sc.start()
    await cycles(h, 5)
    const task = store.getTask(S, a.id)
    expect(task?.status).toBe("IN_PROGRESS")
    expect(task?.verification).toBeNull()
    expect(task?.evidence).toEqual([])
    expect(task?.acceptance).toBeNull()
    expect(h.seen.length).toBe(1)
  })

  test("A3b. a not-ok return still records the generation", async () => {
    const a = add("PENDING")
    const h = makeHarness({ ok: false })
    h.sc.start()
    await cycles(h, 4)
    // An attempt that ENDED is recorded regardless of outcome. Recording only
    // successes would reopen the livelock for any failing task.
    expect(h.seen.length).toBe(1)
    expect(h.lineage(a.id)).toEqual({ execGeneration: 1, attemptGeneration: 1 })
  })

  test("A3c. a REJECTED promise (async throw) still records the generation", async () => {
    const a = add("PENDING")
    const h = makeHarness({
      runTurn: async () => {
        throw new Error("bridge rejected")
      },
    })
    h.sc.start()
    await cycles(h, 4)
    expect(h.seen.length).toBe(1)
    expect(h.lineage(a.id)).toEqual({ execGeneration: 1, attemptGeneration: 1 })
  })

  test("A3d. a SYNCHRONOUS throw is a DISPATCH failure: no generation record", async () => {
    // `runTurn` never produced a promise, so no execution was established.
    // Recording a generation here would assert an execution that never happened.
    const a = add("PENDING")
    const h = makeHarness({
      runTurn: () => {
        throw new Error("never started")
      },
    })
    h.sc.start()
    await h.sc.cycle()
    expect(h.seen.length).toBe(1)
    expect(h.lineage(a.id)?.attemptGeneration).toBeNull()
    expect(store.getTask(S, a.id)?.status).toBe("PENDING")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// B. RESTART
// ═════════════════════════════════════════════════════════════════════════════

describe("B. restart", () => {
  test("B4. RESTART PROOF: a fresh Scheduler declines to re-dispatch a completed generation", async () => {
    const a = add("PENDING")
    const A = makeHarness()
    A.sc.start()
    await A.sc.cycle()
    const persisted = A.lineage(a.id)
    expect(persisted).toEqual({ execGeneration: 1, attemptGeneration: 1 })

    await A.sc.stop()
    const B = makeHarness()
    B.sc.start()
    await cycles(B, 6)

    expect(B.seen.length).toBe(0)
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
    expect(B.lineage(a.id)).toEqual(persisted)
  })

  test("B6. a generation with NO completion record is recovered", async () => {
    const a = addStranded("IN_PROGRESS")
    // [6P] A genuine claim: generation 1 exists, has NOT completed, and the row
    // is durably Scheduler-owned. Before 6P this fixture was exec=0, i.e. the H1
    // shape (interactive IN_PROGRESS), which 6O requires to be LEFT alone.
    expect(lin(store, a.id)).toEqual({ execGeneration: 1, attemptGeneration: null })
    expect(store.getExecutionOwnership(S, a.id)?.executionOwner).toBe("scheduler")
    const h = makeHarness()
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([a.id])
    expect(store.getTask(S, a.id)?.status).toBe("PENDING")
    // [6P] Reverting RELEASES ownership, so the row is interactive state again.
    expect(store.getExecutionOwnership(S, a.id)?.executionOwner).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// C. 6G D1 REGRESSION - the defect this phase exists to close
// ═════════════════════════════════════════════════════════════════════════════

describe("C. D1 regression: stale evidence cannot protect a newer generation", () => {
  test("C1. D1 form 1: an unrelated write after return keeps the generation current (no wedge, no wrong recovery)", async () => {
    // 6G D1: marker(R2) < rev(R3) was read as sufficient evidence, so a task
    // whose only "problem" was an ordinary edit was never reconciled again -
    // and, worse, an unrelated COMPLETED attempt could mask a crashed one.
    const a = add("PENDING")
    const h = makeHarness()
    h.sc.start()
    await h.sc.cycle()
    expect(h.lineage(a.id)).toEqual({ execGeneration: 1, attemptGeneration: 1 })

    // An ordinary external write bumps revision only.
    legacy.patchTask(S, a.id, { title: "clarified by an operator" })
    expect(store.getTask(S, a.id)?.revision).toBe(3)
    // The generation did NOT move. This is the whole fix.
    expect(h.lineage(a.id)).toEqual({ execGeneration: 1, attemptGeneration: 1 })

    // Correctly protected: no erroneous recovery, and no redispatch.
    expect(h.sc.reconcile()).toEqual([])
    await cycles(h, 5)
    expect(h.seen.length).toBe(1)
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
  })

  test("C2. D1 form 2: G1 evidence cannot protect a CRASHED G2", async () => {
    // 6G D1: a completed G1 left a marker; G2 was claimed and crashed before
    // recording anything; reconciliation saw the G1 marker, decided "safe", and
    // left the crashed G2 stranded forever.
    const a = add("PENDING")
    const h = makeHarness()
    h.sc.start()
    await h.sc.cycle()
    await h.sc.stop()
    expect(h.lineage(a.id)).toEqual({ execGeneration: 1, attemptGeneration: 1 })

    // A legitimate new generation, which then crashes before recording.
    legacy.patchTask(S, a.id, { status: "PENDING" })
    const claim = store.claimTask(S, a.id, store.getTask(S, a.id)!.revision)
    expect(claim.outcome).toBe("CLAIM_ACCEPTED")
    expect(claim.execGeneration).toBe(2)
    // exec_generation advanced to 2; attempt_generation is still G1's 1.
    expect(h.lineage(a.id)).toEqual({ execGeneration: 2, attemptGeneration: 1 })

    const B = makeHarness()
    B.sc.start()
    // G1's evidence must NOT suppress G2's recovery.
    expect(B.sc.reconcile()).toEqual([a.id])
    expect(store.getTask(S, a.id)?.status).toBe("PENDING")

    // And the recovered G2 can now run and record its own evidence.
    await B.sc.cycle()
    expect(B.seen.length).toBe(1)
    expect(B.lineage(a.id)).toEqual({ execGeneration: 3, attemptGeneration: 3 })
  })

  test("C3. an impossible lineage (attempt newer than exec) THROWS rather than guessing", async () => {
    const a = addStranded("IN_PROGRESS")
    // Forge the impossible relation directly, as only a corruption could.
    const raw = await import("bun:sqlite")
    const db = new raw.default(join(dir, ".minicode", "tasks.db"))
    db.prepare(
      "UPDATE tasks SET exec_generation = 1, attempt_generation = 9 WHERE session_id = ? AND task_id = ?",
    ).run(S, a.id)
    db.close()

    const h = makeHarness()
    h.sc.start()
    expect(() => h.sc.reconcile()).toThrow(/attempt generation 9 exceeds execution generation 1/)
    // And it threw before mutating anything.
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// D. 6G D2 REGRESSION - orphan evidence must be impossible
// ═════════════════════════════════════════════════════════════════════════════

describe("D. D2 regression: evidence cannot outlive its task", () => {
  test("D1. a deleted task's evidence cannot reach a recreated task with the same id", async () => {
    const t1 = add("PENDING")
    for (let g = 0; g < 3; g++) {
      const c = store.claimTask(S, t1.id, store.getTask(S, t1.id)!.revision)
      store.recordAttemptReturned(S, t1.id, c.execGeneration)
      legacy.patchTask(S, t1.id, { status: "PENDING" })
    }
    expect(lin(store, t1.id)).toEqual({ execGeneration: 3, attemptGeneration: 3 })

    store.deleteSessionTasks(S)
    resetTaskStoreHandles()

    // Recreate the SAME session and the SAME canonical id. Nothing had to be
    // deleted by hand: the old evidence is gone because it lived on the row.
    const reopened = new TaskStore(dir, { authority: "SCHEDULER" })
    const t2 = reopened.createTask(S, {
      title: "fresh",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    expect(t2.id).toBe(t1.id)
    expect(reopened.getExecutionLineage(S, t2.id)).toEqual({
      execGeneration: 0,
      attemptGeneration: null,
    })

    // A claim that crashes must be recoverable, not masked by the old incarnation.
    reopened.claimTask(S, t2.id, reopened.getTask(S, t2.id)!.revision)
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const h = makeHarness({ store: reopened })
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([t2.id])
    expect(reopened.getTask(S, t2.id)?.status).toBe("PENDING")
  })

  test("D2. the old task_attempt table is not created and nothing reads it", async () => {
    const a = add("PENDING")
    const c = store.claimTask(S, a.id, 1)
    store.recordAttemptReturned(S, a.id, c.execGeneration)
    resetTaskStoreHandles()
    const raw = await import("bun:sqlite")
    const db = new raw.default(join(dir, ".minicode", "tasks.db"), { readonly: true })
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name)
    db.close()
    // No second execution-evidence store survives.
    expect(names).not.toContain("task_attempt")
    expect(names).toContain("tasks")
  })

  test("D3. a pre-6I database that still HAS task_attempt opens fine and is ignored", async () => {
    // 6F-era databases may carry the old table. It is not task data; it is inert.
    const a = add("PENDING")
    const c = store.claimTask(S, a.id, 1)
    store.recordAttemptReturned(S, a.id, c.execGeneration)
    const before = store.getTask(S, a.id)
    resetTaskStoreHandles()

    const raw = await import("bun:sqlite")
    const db = new raw.default(join(dir, ".minicode", "tasks.db"))
    db.exec(
      "CREATE TABLE IF NOT EXISTS task_attempt (session_id TEXT, task_id TEXT, attempt_revision INTEGER)",
    )
    db.prepare(
      "INSERT INTO task_attempt (session_id, task_id, attempt_revision) VALUES (?,?,?)",
    ).run(S, a.id, 99)
    db.close()

    const reopened = new TaskStore(dir, { authority: "SCHEDULER" })
    const after = reopened.getTask(S, a.id)
    expect(after?.status).toBe(before?.status)
    expect(after?.revision).toBe(before?.revision)
    // Lineage is correct and unaffected by the stale foreign row.
    expect(reopened.getExecutionLineage(S, a.id)).toEqual({
      execGeneration: 1,
      attemptGeneration: 1,
    })
    // And reconciliation is not disturbed by it.
    const h = makeHarness({ store: reopened })
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// E. REVISION ISOLATION - the mandatory proof that revision != generation
// ═════════════════════════════════════════════════════════════════════════════

describe("E. revision isolation", () => {
  test("E1. NO ordinary mutation advances exec_generation", async () => {
    const dep = add("PENDING", { order: 2, title: "dep" })
    const a = add("PENDING")
    const c = store.claimTask(S, a.id, 1)
    store.recordAttemptReturned(S, a.id, c.execGeneration)
    const start = lin(store, a.id)!

    const mutations: [string, () => void][] = [
      ["title", () => legacy.patchTask(S, a.id, { title: "renamed" })],
      ["order", () => legacy.patchTask(S, a.id, { order: 9 })],
      ["dependency", () => legacy.patchTask(S, a.id, { dependsOn: [dep.id] })],
      ["blockedReason", () => legacy.patchTask(S, a.id, { blockedReason: "waiting" })],
      ["status", () => legacy.patchTask(S, a.id, { status: "IN_PROGRESS" })],
    ]
    for (const [name, fn] of mutations) {
      const revBefore = store.getTask(S, a.id)!.revision
      fn()
      const after = store.getTask(S, a.id)!
      const g = lin(store, a.id)!
      // Every one of these advances the revision...
      expect(after.revision).toBeGreaterThan(revBefore)
      // ...and none of them touches the generation or its completion record.
      expect(g.execGeneration).toBe(start.execGeneration)
      expect(g.attemptGeneration).toBe(start.attemptGeneration)
      expect(name.length).toBeGreaterThan(0)
    }
    // Revision moved a long way; the generation never did.
    expect(store.getTask(S, a.id)!.revision).toBeGreaterThan(start.execGeneration + 4)
    expect(lin(store, a.id)!.execGeneration).toBe(1)
  })

  test("E2. only an ACCEPTED claim advances exec_generation", () => {
    const a = add("PENDING")
    const ok = store.claimTask(S, a.id, 1)
    expect(ok.outcome).toBe("CLAIM_ACCEPTED")
    expect(ok.execGeneration).toBe(1)

    // Rejected: stale revision.
    const stale = store.claimTask(S, a.id, 1)
    expect(stale.outcome).toBe("CLAIM_REJECTED_STALE")
    expect(lin(store, a.id)!.execGeneration).toBe(1)

    // Rejected: wrong state (already IN_PROGRESS).
    const wrong = store.claimTask(S, a.id, store.getTask(S, a.id)!.revision)
    expect(wrong.outcome).toBe("WRONG_STATE")
    expect(lin(store, a.id)!.execGeneration).toBe(1)
  })

  test("E3. the completion record is GUARDED on the generation still being current", () => {
    const a = add("PENDING")
    const g1 = store.claimTask(S, a.id, 1)
    store.recordAttemptReturned(S, a.id, g1.execGeneration)
    // Recording against a generation that is no longer current is REFUSED rather
    // than written, so evidence cannot be misattributed.
    //
    // [PHASE 6Q] It is refused by being CLASSIFIED, not by throwing. The 6I
    // protection - nothing is written - is unchanged and is what the assertions
    // below pin. What changed is the mechanism: a throw escaped `cycle()` and,
    // because the claim was only cleared after the write, left the Scheduler
    // permanently wedged (6N F2). The outcome is still reported loudly, through
    // the return value and the `task:execution_abandoned` event.
    expect(store.recordAttemptReturned(S, a.id, 99)).toBe("SUPERSEDED")
    // The load-bearing 6I property: the attempt marker was NOT moved.
    expect(lin(store, a.id)!.attemptGeneration).toBe(1)
  })

  test("E4. recordAttemptReturned rejects a non-positive or fractional generation", () => {
    const a = addStranded("IN_PROGRESS")
    for (const bad of [0, -1, 1.5]) {
      expect(() => store.recordAttemptReturned(S, a.id, bad)).toThrow()
    }
    expect(lin(store, a.id)!.attemptGeneration).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// F. LEGITIMATE GENERATION HISTORY
// ═════════════════════════════════════════════════════════════════════════════

describe("F. legitimate generation history", () => {
  test("F1. three claims produce three strictly increasing generations", () => {
    const a = add("PENDING")
    const gens: number[] = []
    for (let g = 0; g < 3; g++) {
      const c = store.claimTask(S, a.id, store.getTask(S, a.id)!.revision)
      expect(c.outcome).toBe("CLAIM_ACCEPTED")
      gens.push(c.execGeneration)
      store.recordAttemptReturned(S, a.id, c.execGeneration)
      legacy.patchTask(S, a.id, { status: "PENDING" })
    }
    expect(gens).toEqual([1, 2, 3])
    expect(lin(store, a.id)).toEqual({ execGeneration: 3, attemptGeneration: 3 })
  })

  test("F2. each generation protects only itself; older evidence cannot suppress the current one", () => {
    const a = add("PENDING")
    const g1 = store.claimTask(S, a.id, 1)
    store.recordAttemptReturned(S, a.id, g1.execGeneration)
    legacy.patchTask(S, a.id, { status: "PENDING" })
    const g2 = store.claimTask(S, a.id, store.getTask(S, a.id)!.revision)
    store.recordAttemptReturned(S, a.id, g2.execGeneration)
    legacy.patchTask(S, a.id, { status: "PENDING" })
    const g3 = store.claimTask(S, a.id, store.getTask(S, a.id)!.revision)
    // G3 is claimed and NOT recorded: a crash.
    expect(g3.execGeneration).toBe(3)
    expect(lin(store, a.id)).toEqual({ execGeneration: 3, attemptGeneration: 2 })

    const h = makeHarness()
    h.sc.start()
    // G2's evidence must not protect the crashed G3.
    expect(h.sc.reconcile()).toEqual([a.id])
  })

  test("F3. no history subsystem exists: exactly the current generation is retained", () => {
    const a = add("PENDING")
    for (let g = 0; g < 4; g++) {
      const c = store.claimTask(S, a.id, store.getTask(S, a.id)!.revision)
      store.recordAttemptReturned(S, a.id, c.execGeneration)
      legacy.patchTask(S, a.id, { status: "PENDING" })
    }
    const l = lin(store, a.id)!
    // One current generation and one record. No counter, no list, no history.
    expect(l).toEqual({ execGeneration: 4, attemptGeneration: 4 })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// G. VERIFIER INTERACTION
// ═════════════════════════════════════════════════════════════════════════════

describe("G. verifier interaction", () => {
  test("G1. a post-return mutation does not create a generation or break the record", async () => {
    // Boundary: this repository has no separate verifier component; the closest
    // real TaskStore mutation is `patchTask` by an external authority, which is
    // exactly what a verifier would perform.
    const a = add("PENDING")
    const h = makeHarness()
    h.sc.start()
    await h.sc.cycle()
    const before = h.lineage(a.id)!

    // Several verifier-shaped writes: evidence, verification, blockedReason.
    legacy.patchTask(S, a.id, { evidence: [] as never })
    legacy.patchTask(S, a.id, { title: "verified by operator" })
    legacy.patchTask(S, a.id, { verification: null })

    const after = h.lineage(a.id)!
    expect(after.execGeneration).toBe(before.execGeneration)
    expect(after.attemptGeneration).toBe(before.attemptGeneration)
    // Reconciliation does not misclassify the generation.
    expect(h.sc.reconcile()).toEqual([])
  })

  test("G2. a verifier COMPLETING the task is honoured and never re-opened", async () => {
    const a = add("PENDING")
    const h = makeHarness()
    h.sc.start()
    await h.sc.cycle()
    legacy.patchTask(S, a.id, { status: "COMPLETED" })
    await cycles(h, 3)
    expect(store.getTask(S, a.id)?.status).toBe("COMPLETED")
    expect(h.seen.length).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// H. CRASH WINDOW
// ═════════════════════════════════════════════════════════════════════════════

describe("H. crash window", () => {
  test("H1. a completion-record failure is not swallowed and never claims success", async () => {
    const a = add("PENDING")
    const flaky = flakyCompletion(store, 1)
    const h = makeHarness({ store: flaky.store })
    h.sc.start()
    await expect(h.sc.cycle()).rejects.toThrow(/died before the completion record/)
    // The turn DID run, but nothing claims that was recorded.
    expect(h.seen.length).toBe(1)
    expect(flaky.attempts()).toBe(1)
    expect(h.lineage(a.id)?.attemptGeneration).toBeNull()
    // Not COMPLETED, and not silently released.
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
  })

  test("H2. the duplicate is bounded: one crash costs exactly one extra execution, then converges", async () => {
    const a = add("PENDING")
    let runs = 0
    const flaky = flakyCompletion(store, 1)
    const A = makeHarness({
      store: flaky.store,
      runTurn: () => {
        runs++
        return { kind: "returned", ok: true }
      },
    })
    A.sc.start()
    await expect(A.sc.cycle()).rejects.toThrow()
    await A.sc.stop()

    const B = makeHarness({
      runTurn: () => {
        runs++
        return { kind: "returned", ok: true }
      },
    })
    B.sc.start()
    expect(B.sc.reconcile()).toEqual([a.id])
    await B.sc.cycle()
    // The duplicate records its own generation, so the loop stops.
    await cycles(B, 8)
    expect(runs).toBe(2)
    expect(B.lineage(a.id)?.attemptGeneration).toBe(B.lineage(a.id)?.execGeneration)
  })

  test("H3. a crash AFTER the record is written causes no duplicate", async () => {
    add("PENDING")
    let runs = 0
    const A = makeHarness({
      runTurn: () => {
        runs++
        return { kind: "returned", ok: true }
      },
    })
    A.sc.start()
    await A.sc.cycle()
    await A.sc.stop()

    const B = makeHarness({
      runTurn: () => {
        runs++
        return { kind: "returned", ok: true }
      },
    })
    B.sc.start()
    await cycles(B, 6)
    expect(runs).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// I. RECONCILIATION POLICY, ISOLATION, TERMINAL STATES
// ═════════════════════════════════════════════════════════════════════════════

describe("I. reconciliation, isolation, terminal states", () => {
  test("I1. a recorded generation is never reconciled; an unrecorded one is", () => {
    // `recorded` completed its generation. `stranded` is IN_PROGRESS with no
    // completion record at all - the genuine crash shape.
    const recorded = add("PENDING", { title: "recorded" })
    const stranded = addStranded("IN_PROGRESS", { title: "stranded", order: 2 })
    const c = store.claimTask(S, recorded.id, 1)
    store.recordAttemptReturned(S, recorded.id, c.execGeneration)
    expect(lin(store, recorded.id)).toEqual({ execGeneration: 1, attemptGeneration: 1 })
    // [6P] The stranded row is a REAL claim now (exec=1, owned), so the two rows
    // differ in the fact that actually drives the decision.
    expect(lin(store, stranded.id)).toEqual({ execGeneration: 1, attemptGeneration: null })
    expect(store.getExecutionOwnership(S, recorded.id)?.executionOwner).toBe("scheduler")
    expect(store.getExecutionOwnership(S, stranded.id)?.executionOwner).toBe("scheduler")

    const h = makeHarness()
    h.sc.start()
    // Only the unrecorded one is reconciled.
    expect(h.sc.reconcile()).toEqual([stranded.id])
    expect(store.getTask(S, recorded.id)?.status).toBe("IN_PROGRESS")
    expect(store.getTask(S, stranded.id)?.status).toBe("PENDING")
  })

  test("I2. VERIFYING follows the same lineage policy", () => {
    const a = addStranded("VERIFYING")
    const h = makeHarness()
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([a.id])
    expect(store.getTask(S, a.id)?.status).toBe("PENDING")
  })

  test("I3. terminal, resting and operator states are never reconciled", () => {
    const untouched: TaskStatus[] = ["COMPLETED", "CANCELLED", "FAILED", "PENDING", "BLOCKED"]
    const ids: string[] = []
    for (const status of untouched) {
      // [6P] `add`, not `addStranded`: this case is about resting/terminal STATES,
      // not about a stranded execution, so each row is created directly in the
      // named status. (It previously rode on the stranded helper, which is why it
      // read as if a generation were involved.)
      ids.push(
        add(status, {
          title: `x ${status}`,
          ...(status === "BLOCKED" ? { blockedReason: "waiting" } : {}),
        }).id,
      )
    }
    const before = ids.map((id) => store.getTask(S, id)!)
    const h = makeHarness()
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])
    ids.forEach((id, i) => {
      const after = store.getTask(S, id)!
      expect(after.status).toBe(before[i]!.status)
      expect(after.revision).toBe(before[i]!.revision)
    })
    // A completed row carrying lineage: claim+record, then complete it.
    const c = add("PENDING")
    const gc = store.claimTask(S, c.id, 1)
    store.recordAttemptReturned(S, c.id, gc.execGeneration)
    legacy.patchTask(S, c.id, { status: "COMPLETED" })
    const revBefore = store.getTask(S, c.id)!.revision
    expect(h.sc.reconcile()).toEqual([])
    expect(store.getTask(S, c.id)!.revision).toBe(revBefore)
  })

  test("I4. PAUSED is still not a status and cannot appear", async () => {
    const a = add("PENDING")
    const h = makeHarness()
    h.sc.start()
    await h.sc.cycle()
    expect(["PAUSED", "AWAITING", "ATTEMPTED", "STARTED"]).not.toContain(
      store.getTask(S, a.id)?.status,
    )
  })

  test("I5. recovery is PER-TASK: another task's record never shields an unrecorded one", () => {
    const done = add("PENDING", { title: "done" })
    const stuck = addStranded("IN_PROGRESS", { title: "stuck", order: 2 })
    const c = store.claimTask(S, done.id, 1)
    store.recordAttemptReturned(S, done.id, c.execGeneration)
    const h = makeHarness()
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([stuck.id])
    expect(store.getTask(S, done.id)?.status).toBe("IN_PROGRESS")
    expect(store.getTask(S, stuck.id)?.status).toBe("PENDING")
  })

  test("I6. lineage is isolated per session and per task", () => {
    const other = "6i-other"
    const mine = add("PENDING")
    const theirs = legacy.createTask(other, {
      title: "theirs",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    const sibling = add("PENDING", { order: 2, title: "sibling" })
    const c = store.claimTask(S, mine.id, 1)
    store.recordAttemptReturned(S, mine.id, c.execGeneration)
    expect(lin(store, mine.id)!.attemptGeneration).toBe(1)
    expect(store.getExecutionLineage(other, theirs.id)!.attemptGeneration).toBeNull()
    expect(lin(store, sibling.id)!.attemptGeneration).toBeNull()
  })

  test("I7. ownership uncertainty still REFUSES, and the gate runs before lineage", () => {
    const a = addStranded("IN_PROGRESS")
    acquireSessionOwnership(S, "someone-else")
    const h = makeHarness()
    expect(() => h.sc.start()).toThrow(/already owned/i)
    expect(h.sc.reconcile()).toEqual([])
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
  })

  test("I8. reconciliation never deletes, and the lineage predicate is not readiness", () => {
    const a = addStranded("IN_PROGRESS")
    const graph = new TaskGraph(store.getSnapshot(S))
    // A stranded task with no record is still not schedulable.
    expect(graph.readyTasks()).toEqual([])
    const h = makeHarness()
    h.sc.start()
    h.sc.reconcile()
    expect(store.getTask(S, a.id)).not.toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// J. MIGRATION, LEGACY, STATIC ARCHITECTURE
// ═════════════════════════════════════════════════════════════════════════════

describe("J. migration, legacy, static architecture", () => {
  test("J1. an existing database reopens with lineage AND ownership intact", async () => {
    const a = addStranded("IN_PROGRESS")
    const before = store.getTask(S, a.id)
    resetTaskStoreHandles()
    const reopened = new TaskStore(dir, { authority: "SCHEDULER" })
    const after = reopened.getTask(S, a.id)
    expect(after?.status).toBe(before?.status)
    expect(after?.revision).toBe(before?.revision)
    // [6P] Ownership is DURABLE: it survives a TaskStore reopen exactly as the
    // lineage does. This is the property that makes the 6O decision cross a
    // process boundary instead of living in module state.
    expect(reopened.getExecutionLineage(S, a.id)).toEqual({
      execGeneration: 1,
      attemptGeneration: null,
    })
    expect(reopened.getExecutionOwnership(S, a.id)?.executionOwner).toBe("scheduler")
    // And a genuinely stranded, durably-owned row is still reconcilable after reopen.
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const h = makeHarness({ store: reopened })
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([a.id])
  })

  test("J1b. a pre-6P row is NOT auto-reconciled (no inferred ownership)", async () => {
    // [6P] The deliberate consequence of the additive-only, no-backfill migration.
    // A row that predates `execution_owner` reads as owner=NULL, so reconciliation
    // refuses it. The information needed to tell a stranded pre-6P claim from
    // interactive IN_PROGRESS was never recorded and is IRREDUCIBLE; manufacturing
    // it would reintroduce 6N F1 on upgraded databases. Such rows are an
    // OPERATOR cost (manual requeue), never a correctness cost: nothing is lost and
    // no execution is corrupted. This test pins that decision so it cannot be
    // "fixed" by inference later.
    const a = legacy.createTask(S, {
      title: "pre-6p stranded",
      status: "IN_PROGRESS",
      order: 1,
      provenance: prov,
    })
    expect(store.getExecutionOwnership(S, a.id)?.executionOwner).toBeNull()
    expect(lin(store, a.id)).toEqual({ execGeneration: 0, attemptGeneration: null })
    const h = makeHarness()
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
  })

  test("J2. LEGACY mode never writes lineage across its whole lifecycle", () => {
    const a = legacy.createTask(S, {
      title: "legacy",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    expect(lin(legacy, a.id)!.attemptGeneration).toBeNull()
    legacy.patchTask(S, a.id, { status: "IN_PROGRESS" })
    legacy.patchTask(S, a.id, { status: "COMPLETED" })
    const l = lin(legacy, a.id)!
    // LEGACY authored IN_PROGRESS without a claim, so no generation was created.
    expect(l).toEqual({
      execGeneration: 0,
      attemptGeneration: 0 === l.attemptGeneration ? 0 : null,
    })
    expect(l.execGeneration).toBe(0)
    expect(l.attemptGeneration).toBeNull()
  })

  test("J3. the SCHEDULER authority boundary is unchanged", () => {
    const a = add("PENDING")
    let caught: unknown
    try {
      store.patchTask(S, a.id, { status: "IN_PROGRESS" })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe("TASK_AUTHORITY_VIOLATION")
    expect(store.getTask(S, a.id)?.status).toBe("PENDING")
    // A refused write conjures no lineage.
    expect(lin(store, a.id)!.attemptGeneration).toBeNull()
  })

  test("J4. lineage is absent from TaskGraph, readiness and the model", async () => {
    const root = join(import.meta.dir, "..")
    for (const f of ["src/task/graph.ts", "src/task/readiness.ts", "src/task/model.ts"]) {
      const text = await readFile(join(root, f), "utf8")
      expect(text).not.toContain("exec_generation")
      expect(text).not.toContain("attempt_generation")
      expect(text).not.toContain("ExecutionLineage")
    }
  })

  test("J5. the Scheduler holds no lineage rule of its own and no database access", async () => {
    const root = join(import.meta.dir, "..")
    const text = await readFile(join(root, "src/task/scheduler.ts"), "utf8")
    const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ")
    for (const banned of [
      "bun:sqlite",
      "Database",
      "exec_generation",
      "attempt_generation",
      "TaskStatus",
    ]) {
      expect(banned).toBe(banned)
      expect(code).not.toContain(banned)
    }
    // It delegates the decision, and writes no status.
    expect(code).toContain("reconcileIfNoCompletedAttempt")
    expect(code).toContain("recordAttemptReturned")
    expect(code).not.toMatch(/status\s*[:=]\s*["']COMPLETED["']/)
  })

  test("J6. only TaskStore owns the lineage columns", async () => {
    const root = join(import.meta.dir, "..")
    const files: string[] = []
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.name.endsWith(".ts")) files.push(p)
      }
    }
    await walk(join(root, "src"))
    const users: string[] = []
    for (const f of files) {
      // Comments may legitimately name the columns to explain the invariant;
      // what must be unique is the module that WRITES them.
      const text = (await readFile(f, "utf8"))
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ")
      if (text.includes("exec_generation") || text.includes("attempt_generation")) {
        users.push(f.replace(`${root}\\`, "").replace(/\//g, "\\"))
      }
    }
    expect(users).toEqual(["src\\task\\store.ts"])
  })

  test("J7. production constructs a Scheduler in exactly ONE gated place", async () => {
    // [PHASE 6U] The invariant CHANGED, and deliberately.
    //
    // Until 6U this read "no production file constructs a Scheduler". 6U is the
    // phase whose whole purpose is to make the subsystem reachable from
    // production, so "no construction at all" is no longer the requirement — the
    // requirement is that construction is reachable ONLY through one gated
    // composition root, and unreachable when the gate is off.
    //
    // Weakening this to "allow the one file" would let any future file construct a
    // Scheduler freely, so the new assertion is STRICTER about where and HOW:
    // one site, the composition root, and the gate in front of it.
    const root = join(import.meta.dir, "..")
    const files: string[] = []
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.name.endsWith(".ts")) files.push(p)
      }
    }
    await walk(join(root, "src"))
    const offenders: string[] = []
    for (const f of files) {
      const rel = f.replace(`${root}\\`, "").replace(/\//g, "\\")
      if (rel === "src\\task\\scheduler.ts") continue
      const text = await readFile(f, "utf8")
      const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ")
      if (/new\s+Scheduler\s*\(/.test(code)) offenders.push(rel)
    }
    // Exactly one construction site in the whole of src/, and it is the
    // composition root this phase added.
    expect(offenders).toEqual(["src\\task\\production-scheduler.ts"])

    // And that site is genuinely gated: the construction is unreachable unless the
    // gate is open, because the early return precedes it.
    const src = await readFile(join(root, "src", "task", "production-scheduler.ts"), "utf8")
    const gate = src.indexOf("if (!gate.enabled) return inertHandle(gate)")
    const construct = src.indexOf("new Scheduler(")
    expect({
      gate: gate >= 0,
      construct: construct >= 0,
      gated: gate >= 0 && construct > gate,
    }).toEqual({ gate: true, construct: true, gated: true })
  })
})
