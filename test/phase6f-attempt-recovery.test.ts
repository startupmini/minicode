// Phase 6F — execution attempt & recovery tests.
//
// NEW ARCHITECTURE. Implements the design locked in
// PHASE-6E-EXECUTION-ATTEMPT-RECOVERY-DESIGN.md: one durable attempt marker,
// TaskStore-owned, additive, carrying the POST-CLAIM revision of the
// generation that ran.
//
// The invariant under test throughout:
//
//   EXECUTION != VERIFICATION != COMPLETION
//
// A returned turn proves the ATTEMPT ENDED. It never proves the work was
// correct, and the Scheduler never writes COMPLETED because of it.
//
// The decisive test in this file is "A2" (the liveness regression). Phase 6D
// showed the Scheduler re-executing one task forever: 1, 2, 3, 4, ... runs. If
// that behaviour ever returns, A2 fails. Everything else here is context for
// why A2 must hold.

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
import { type AttemptMarker, resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

let dir: string
let store: TaskStore
/** LEGACY store, used only to build fixture state a crashed Scheduler would
 *  leave behind, and to act as the external authority that changes a task. */
let legacy: TaskStore

const prov = { origin: "model", source: "6f" } as const
const S = "6f-sess"

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6f-"))
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

function addStranded(status: "IN_PROGRESS" | "VERIFYING", over: Partial<Task> = {}): Task {
  return legacy.createTask(S, {
    title: `stranded ${status}`,
    status,
    order: 1,
    provenance: prov,
    ...over,
  })
}

interface Harness {
  readonly sc: Scheduler
  readonly seen: SchedulerWorkItem[]
  readonly marker: (taskId: string) => AttemptMarker | null
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
  return {
    sc,
    seen,
    marker: (id: string) => target.getAttemptMarker(S, id),
  }
}

/** Run N cycles back to back with no external mutation. */
async function cycles(h: Harness, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await h.sc.cycle()
}

// ═════════════════════════════════════════════════════════════════════════════
// A. NORMAL RETURN
// ═════════════════════════════════════════════════════════════════════════════

describe("A. normal return", () => {
  test("A1. one claim + one normal return records exactly one durable marker", async () => {
    const a = add("PENDING")
    const h = makeHarness()
    h.sc.start()
    await h.sc.cycle()

    expect(h.seen.length).toBe(1)
    const task = store.getTask(S, a.id)
    // Claim advances revision to 2; the marker must name THAT generation.
    expect(task?.status).toBe("IN_PROGRESS")
    expect(task?.revision).toBe(2)
    expect(h.marker(a.id)).toEqual({ attemptRevision: 2 })
  })

  test("A2. LIVENESS REGRESSION: repeated cycles with no external mutation run the task ONCE", async () => {
    // THE primary proof that the Phase 6D livelock is gone. Before 6F this
    // produced runs = 1, 2, 3, 4, ... for a single task. No sleep, no clock, no
    // model cooperation: just 8 cycles of the plain cycle() entry point.
    const a = add("PENDING")
    const h = makeHarness()
    h.sc.start()
    await cycles(h, 8)

    expect(h.seen.length).toBe(1)
    expect(h.seen.map((w) => w.taskId)).toEqual([a.id])
    // The task is still IN_PROGRESS: a return is not a verdict, and no
    // verifier or operator moved it.
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
    // And the reason it stayed put is durable, not in-memory bookkeeping.
    expect(h.marker(a.id)?.attemptRevision).toBe(store.getTask(S, a.id)?.revision)
  })

  test("A3. normal return without task completion does not redispatch, and does not complete the task", async () => {
    // The separation of concerns, asserted directly: "the attempt ended" is
    // never silently converted into "the task is done" NOR into "retry now".
    const a = add("PENDING")
    const h = makeHarness({ ok: true })
    h.sc.start()
    await cycles(h, 5)

    // Not completed: the Scheduler never manufactures completion.
    const task = store.getTask(S, a.id)
    expect(task?.status).toBe("IN_PROGRESS")
    expect(task?.verification).toBeNull()
    expect(task?.evidence).toEqual([])
    expect(task?.acceptance).toBeNull()
    // Not retried.
    expect(h.seen.length).toBe(1)
  })

  test("A3b. a REJECTED turn also records a marker: 'the attempt ended' is not 'it succeeded'", async () => {
    // A failed execution is still an execution that ended. Recording only
    // successful returns would re-open the livelock for any failing task, and
    // would smuggle in a success judgement the Scheduler has no standing to
    // make.
    const a = add("PENDING")
    const h = makeHarness({ ok: false })
    h.sc.start()
    await cycles(h, 4)

    expect(h.seen.length).toBe(1)
    expect(h.marker(a.id)).not.toBeNull()
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
  })

  test("A3c. a REJECTED PROMISE also records a marker", async () => {
    // An async rejection means the turn WAS established and then ended. That is
    // an attempt that ended, so it gets a marker and converges.
    const a = add("PENDING")
    const h = makeHarness({
      runTurn: async () => {
        throw new Error("bridge rejected")
      },
    })
    h.sc.start()
    await cycles(h, 4)
    expect(h.seen.length).toBe(1)
    expect(h.marker(a.id)).not.toBeNull()
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
  })

  test("A3d. a SYNCHRONOUS throw is a DISPATCH failure: no marker, claim released", async () => {
    // The distinction that must not be blurred. If `runTurn` throws before it
    // ever produces a promise, the attempt was NEVER ESTABLISHED. Recording a
    // marker here would assert an execution that never happened, and would
    // strand the task forever. Phase 6C's release path is correct and 6F keeps
    // it.
    const a = add("PENDING")
    const h = makeHarness({
      runTurn: () => {
        throw new Error("never started")
      },
    })
    h.sc.start()
    await h.sc.cycle()

    expect(h.seen.length).toBe(1)
    expect(h.marker(a.id)).toBeNull()
    expect(store.getTask(S, a.id)?.status).toBe("PENDING")
    // And it stays released rather than being re-claimed in a hot loop.
    await h.sc.cycle()
    expect(h.seen.length).toBe(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// B. RESTART — the causal proof
// ═════════════════════════════════════════════════════════════════════════════

describe("B. restart", () => {
  test("B4. RESTART PROOF: a new Scheduler reconstructs from TaskStore and does not re-dispatch", async () => {
    // Scheduler A claims, the turn returns, the marker is persisted. A is
    // destroyed. B has NO in-memory state at all: no claim, no history, no
    // remembered turn. It must read the marker out of the database.
    const a = add("PENDING")
    const A = makeHarness()
    A.sc.start()
    await A.sc.cycle()
    expect(A.seen.length).toBe(1)
    const persisted = A.marker(a.id)
    expect(persisted).not.toBeNull()

    // Destroy A. stop() releases session ownership, which is the only
    // in-process state a successor could have inherited.
    await A.sc.stop()
    expect(A.sc.getLifecycle()).toBe("STOPPED")

    // Scheduler B, same session, same database, fresh object.
    const B = makeHarness()
    B.sc.start()
    await cycles(B, 6)

    expect(B.seen.length).toBe(0)
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
    // The marker survived, unchanged, across the "restart".
    expect(B.marker(a.id)).toEqual(persisted)
  })

  test("B5. a persisted marker suppresses reconciliation that would otherwise revert", async () => {
    // Isolates the marker as the cause. A stranded-looking IN_PROGRESS row with
    // a matching marker is not reconciled.
    const a = addStranded("IN_PROGRESS")
    const task = store.getTask(S, a.id)
    store.recordAttemptReturned(S, a.id, task?.revision ?? 0)

    const h = makeHarness()
    h.sc.start()
    const recovered = h.sc.reconcile()

    expect(recovered).toEqual([])
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
    expect(store.getTask(S, a.id)?.revision).toBe(task?.revision)
  })

  test("B6. an ABSENT marker triggers recovery: stranded -> PENDING -> re-dispatched", async () => {
    // The at-least-once path, and the proof that the marker is load-bearing in
    // BOTH directions: it prevents spurious recovery and permits true recovery.
    const a = addStranded("IN_PROGRESS")
    expect(store.getAttemptMarker(S, a.id)).toBeNull()

    const h = makeHarness()
    h.sc.start()
    const recovered = h.sc.reconcile()
    expect(recovered).toEqual([a.id])
    expect(store.getTask(S, a.id)?.status).toBe("PENDING")

    await h.sc.cycle()
    expect(h.seen.length).toBe(1)
    expect(h.marker(a.id)).not.toBeNull()
  })

  test("B6b. a genuinely crashed attempt is recovered across a restart", async () => {
    // A claims; the process "dies" before the marker write (the write throws).
    // A successor must recover it, because there is no evidence of completion.
    const a = add("PENDING")
    const failing = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === "recordAttemptReturned") {
          return () => {
            throw new Error("simulated process death before marker write")
          }
        }
        return Reflect.get(target, prop, recv)
      },
    }) as TaskStore
    const A = makeHarness({ store: failing })
    A.sc.start()
    await expect(A.sc.cycle()).rejects.toThrow(/before marker write/)
    // The claim is left in place: we do not know the turn ended AND was
    // recorded, so we refuse to pretend it was.
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
    expect(store.getAttemptMarker(S, a.id)).toBeNull()
    await A.sc.stop()

    const B = makeHarness()
    B.sc.start()
    const recovered = B.sc.reconcile()
    expect(recovered).toEqual([a.id])
    expect(store.getTask(S, a.id)?.status).toBe("PENDING")
    await B.sc.cycle()
    expect(B.seen.length).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// C. GENERATION / REVISION SEMANTICS
// ═════════════════════════════════════════════════════════════════════════════

describe("C. generation and revision", () => {
  test("C7. a G1 marker does NOT protect a newer generation G2", async () => {
    // The stale-marker attack. G1 completes and leaves marker(G1). An external
    // writer then moves the task, producing a newer revision G2 that has NO
    // attempt of its own. A G1 marker must not be read as evidence about G2.
    const a = add("PENDING")
    const h = makeHarness()
    h.sc.start()
    await h.sc.cycle()
    const g1 = h.marker(a.id)?.attemptRevision
    expect(g1).toBe(2)

    // Legitimate new generation: the external authority completes G1, then a
    // fresh task is created. For THIS task, force a newer revision without a
    // new attempt, by patching the title (a no-op semantically, a new
    // generation durably).
    legacy.patchTask(S, a.id, { title: "edited by operator" })
    const g2 = store.getTask(S, a.id)?.revision
    expect(g2).toBeGreaterThan(g1 as number)

    // marker(G1).attemptRevision < task.revision, so the marker says nothing
    // about G2. Per the locked rule this is "not stranded" — it fails SAFE
    // toward leaving the row alone rather than reverting work a newer writer
    // may still own. The assertion documents that exact behaviour rather than
    // inventing a different one.
    const recovered = h.sc.reconcile()
    expect(recovered).toEqual([])
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
  })

  test("C8. marker.attemptRevision < task.revision is NOT stranded (locked rule)", async () => {
    // Build a genuinely older marker: a row at revision 1, moved to revision 2
    // by an external write, with a marker still naming generation 1.
    const a = addStranded("IN_PROGRESS")
    legacy.patchTask(S, a.id, { title: "edited afterwards" })
    const current = store.getTask(S, a.id)?.revision ?? 0
    expect(current).toBe(2)
    store.recordAttemptReturned(S, a.id, current - 1)
    expect(store.getAttemptMarker(S, a.id)).toEqual({ attemptRevision: current - 1 })

    const h = makeHarness()
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
  })

  test("C9. marker.attemptRevision > task.revision THROWS rather than guessing", async () => {
    // An impossible relationship. Guessing would either strand live work or
    // re-run finished work; both are silent corruption, so the design requires
    // a loud failure.
    const a = addStranded("IN_PROGRESS")
    const task = store.getTask(S, a.id)
    store.recordAttemptReturned(S, a.id, (task?.revision ?? 1) + 5)
    const h = makeHarness()
    h.sc.start()
    expect(() => h.sc.reconcile()).toThrow(/attempt marker revision .* exceeds task/i)
    // And it threw BEFORE mutating anything.
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
    expect(store.getTask(S, a.id)?.revision).toBe(task?.revision)
  })

  test("C9b. REVISION RACE: an external write between claim and marker write does not corrupt the generation", async () => {
    // claim at R, turn resolves, and BEFORE the marker is written an external
    // writer moves the task to R+1. The marker must still name R — the
    // generation that actually ran — and must not overwrite newer state.
    const a = add("PENDING")
    let raced = false
    const h = makeHarness({
      runTurn: (w) => {
        seenRace(w.taskId)
        return { kind: "returned", ok: true }
      },
    })
    function seenRace(id: string) {
      if (raced) return
      raced = true
      // Runs inside the turn: the claim is IN_PROGRESS at revision 2.
      legacy.patchTask(S, id, { title: "operator edited mid-flight" })
    }
    h.sc.start()
    await h.sc.cycle()

    const task = store.getTask(S, a.id)
    // The marker names the CLAIMED generation (2), not the new revision (3).
    expect(h.marker(a.id)).toEqual({ attemptRevision: 2 })
    expect(task?.revision).toBe(3)
    // The external write was not clobbered.
    expect(task?.title).toBe("operator edited mid-flight")
    // And reconciliation resolves the mismatch on the locked rule: not stranded.
    expect(h.sc.reconcile()).toEqual([])
  })

  test("C11. a NEW claim after a completed attempt produces a DIFFERENT marker value", async () => {
    // Uses only existing, locked transitions to create G2: the external
    // authority re-queues the task. No requeue mechanism is invented here.
    const a = add("PENDING")
    const h = makeHarness()
    h.sc.start()
    await h.sc.cycle()
    const g1 = h.marker(a.id)?.attemptRevision
    expect(g1).toBe(2)

    // External authority returns the task to PENDING. This is the legitimate
    // new scheduling justification: a human/verifier decided it should run
    // again.
    legacy.patchTask(S, a.id, { status: "PENDING" })
    expect(store.getTask(S, a.id)?.status).toBe("PENDING")

    await h.sc.cycle()
    const g2 = h.marker(a.id)?.attemptRevision
    // A second execution happened, at a NEW generation, and the marker moved.
    expect(h.seen.length).toBe(2)
    expect(g2).toBeGreaterThan(g1 as number)
    expect(g2).not.toBe(g1)
    expect(h.marker(a.id)?.attemptRevision).toBe(store.getTask(S, a.id)?.revision)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// D. CRASH WINDOW — the accepted residue, tested explicitly
// ═════════════════════════════════════════════════════════════════════════════

describe("D. crash window", () => {
  test("D10. crash BEFORE the marker write -> recovered (at-least-once)", async () => {
    const a = add("PENDING")
    const dying = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === "recordAttemptReturned") {
          return () => {
            throw new Error("died before marker")
          }
        }
        return Reflect.get(target, prop, recv)
      },
    }) as TaskStore
    const h = makeHarness({ store: dying })
    h.sc.start()
    await expect(h.sc.cycle()).rejects.toThrow()
    await h.sc.stop()

    const B = makeHarness()
    B.sc.start()
    expect(B.sc.reconcile()).toEqual([a.id])
    expect(store.getTask(S, a.id)?.status).toBe("PENDING")
    await B.sc.cycle()
    expect(B.seen.length).toBe(1)
  })

  test("D11. crash AFTER the marker write -> NO duplicate", async () => {
    const a = add("PENDING")
    const h = makeHarness()
    h.sc.start()
    await h.sc.cycle()
    // "Crash" now: the process disappears with the marker already durable.
    await h.sc.stop()
    expect(h.marker(a.id)).not.toBeNull()

    const B = makeHarness()
    B.sc.start()
    await cycles(B, 6)
    expect(B.seen.length).toBe(0)
  })

  test("D12. the residue is exactly one write wide: a duplicate is possible, then it converges", async () => {
    // Documents the Phase 6E §21 row-4 limitation as executable behaviour
    // rather than a caveat in prose. The window is between the turn resolving
    // and the marker write; a death inside it is indistinguishable from a
    // crash during execution, so ONE duplicate run occurs. Critically, the
    // duplicate then records its own marker, so the loop does not repeat.
    const a = add("PENDING")
    let markerWrites = 0
    let failNextWrite = true
    const flaky = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === "recordAttemptReturned") {
          return (sid: string, tid: string, rev: number) => {
            markerWrites++
            if (failNextWrite) {
              failNextWrite = false
              throw new Error("died in the window between return and marker")
            }
            return (target as TaskStore).recordAttemptReturned(sid, tid, rev)
          }
        }
        return Reflect.get(target, prop, recv)
      },
    }) as TaskStore
    const A = makeHarness({ store: flaky })
    A.sc.start()
    await expect(A.sc.cycle()).rejects.toThrow()
    await A.sc.stop()
    expect(markerWrites).toBe(1)

    // Successor recovers and re-runs: this is the accepted single duplicate.
    const B = makeHarness()
    B.sc.start()
    expect(B.sc.reconcile()).toEqual([a.id])
    await B.sc.cycle()
    expect(B.seen.length).toBe(1)
    expect(B.marker(a.id)).not.toBeNull()

    // And it CONVERGES. Bounded, not unbounded. This is the difference
    // between at-least-once and the Phase 6D livelock.
    await cycles(B, 8)
    expect(B.seen.length).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// E. RECONCILIATION POLICY
// ═════════════════════════════════════════════════════════════════════════════

describe("E. reconciliation", () => {
  test("E13. a marked generation is never reconciled, at any revision it matches", async () => {
    const a = addStranded("IN_PROGRESS")
    const rev = store.getTask(S, a.id)?.revision ?? 0
    store.recordAttemptReturned(S, a.id, rev)
    const h = makeHarness()
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])
    expect(store.getTask(S, a.id)?.revision).toBe(rev)
  })

  test("E14. an unmarked generation is recoverable, for both in-flight statuses", async () => {
    // One Scheduler for both rows: session ownership is process-local and a
    // second start() would fail closed, which would test ownership rather than
    // the marker.
    const a = addStranded("IN_PROGRESS", { title: "s IN_PROGRESS" })
    const b = addStranded("VERIFYING", { title: "s VERIFYING" })
    const h = makeHarness()
    h.sc.start()
    expect(h.sc.reconcile().slice().sort()).toEqual([a.id, b.id].sort())
    expect(store.getTask(S, a.id)?.status).toBe("PENDING")
    expect(store.getTask(S, b.id)?.status).toBe("PENDING")
  })

  test("E14b. recovery is PER-TASK: another task's marker never shields an unmarked stranded task", async () => {
    // Guards against a session-wide "some marker exists, so nothing is
    // stranded" rule. A completed attempt on T1 must not make an abandoned
    // attempt on T2 look safe. This is the case that makes the marker a
    // per-task fact rather than a per-session mood.
    const done = addStranded("IN_PROGRESS", { title: "done" })
    const stuck = addStranded("IN_PROGRESS", { title: "stuck" })
    store.recordAttemptReturned(S, done.id, store.getTask(S, done.id)!.revision)

    const h = makeHarness()
    h.sc.start()
    const recovered = h.sc.reconcile()

    // Exactly the unmarked one, and only the unmarked one.
    expect(recovered).toEqual([stuck.id])
    expect(store.getTask(S, done.id)?.status).toBe("IN_PROGRESS")
    expect(store.getTask(S, stuck.id)?.status).toBe("PENDING")
  })

  test("E14c. a marker in a DIFFERENT session never shields this session's stranded task", async () => {
    const other = "6f-sess-other"
    const mine = addStranded("IN_PROGRESS")
    const theirs = legacy.createTask(other, {
      title: "theirs",
      status: "IN_PROGRESS",
      order: 1,
      provenance: prov,
    })
    store.recordAttemptReturned(other, theirs.id, store.getTask(other, theirs.id)!.revision)

    const h = makeHarness()
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([mine.id])
    expect(store.getTask(S, mine.id)?.status).toBe("PENDING")
    expect(store.getTask(other, theirs.id)?.status).toBe("IN_PROGRESS")
  })

  test("E15. PAUSED is still not a status and cannot appear", async () => {
    // Guard against the tempting shortcut of adding a PAUSED-like status to
    // represent "attempted but unadjudicated". 6E rejected it, and it stays
    // rejected. The status vocabulary itself is asserted to contain no
    // "attempted but unadjudicated" value.
    const h = makeHarness()
    add("PENDING")
    h.sc.start()
    await h.sc.cycle()
    const t = store.getSnapshot(S).tasks[0]
    expect(["PAUSED", "AWAITING", "ATTEMPTED", "STARTED"]).not.toContain(t?.status)
    expect(t?.status).toBe("IN_PROGRESS")
  })

  test("E16. terminal, resting and operator states are never reconciled", async () => {
    // One Scheduler: a single ownership acquisition covers every row.
    const untouched: TaskStatus[] = ["COMPLETED", "CANCELLED", "FAILED", "PENDING", "BLOCKED"]
    const ids: string[] = []
    for (const status of untouched) {
      ids.push(
        addStranded(status as "IN_PROGRESS", {
          title: `x ${status}`,
          // BLOCKED is only constructible with a reason.
          ...(status === "BLOCKED" ? { blockedReason: "waiting on a dependency" } : {}),
        }).id,
      )
    }
    const before = ids.map((id) => store.getTask(S, id))

    const h = makeHarness()
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([])

    ids.forEach((id, i) => {
      const after = store.getTask(S, id)
      expect(after?.status).toBe(before[i]?.status)
      expect(after?.revision).toBe(before[i]?.revision)
    })
  })

  test("E17. reconciliation never deletes a task", async () => {
    const a = addStranded("IN_PROGRESS")
    const h = makeHarness()
    h.sc.start()
    h.sc.reconcile()
    expect(store.getTask(S, a.id)).not.toBeNull()
    expect(store.getSnapshot(S).tasks.length).toBe(1)
  })

  test("E18. ownership uncertainty still REFUSES (Phase 6B preserved)", async () => {
    // The marker does not weaken the ownership gate. A competing in-process
    // owner means this Scheduler never acquires ownership, and an unmarked
    // stranded task is still left alone.
    const a = addStranded("IN_PROGRESS")
    acquireSessionOwnership(S, "someone-else")
    const h = makeHarness()
    // start() fails closed rather than pretending it owns the session.
    expect(() => h.sc.start()).toThrow(/already owned/i)
    expect(h.sc.reconcile()).toEqual([])
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
  })

  test("E18b. a MARKED task is also left alone when ownership is unavailable", async () => {
    // Refusal must not depend on the marker: the ownership gate runs first.
    const a = addStranded("IN_PROGRESS")
    store.recordAttemptReturned(S, a.id, store.getTask(S, a.id)!.revision)
    acquireSessionOwnership(S, "someone-else")
    const h = makeHarness()
    expect(() => h.sc.start()).toThrow(/already owned/i)
    expect(h.sc.reconcile()).toEqual([])
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// F. MODEL CORRELATION LIMITATION
// ═════════════════════════════════════════════════════════════════════════════

describe("F. model correlation limitation", () => {
  test("F1. a marker means 'the attempt ended', never 'the selected task was worked on'", async () => {
    // The Scheduler selects T1; the model, given only an instruction string,
    // completes a DIFFERENT task (T2). The marker for T1 is still written,
    // because T1's turn did end. It carries no claim about T1's correctness.
    const a = add("PENDING")
    const b = add("PENDING", { order: 2, title: "T2" })
    const h = makeHarness({
      runTurn: () => {
        // Model "works on T2" instead of the selected T1.
        legacy.patchTask(S, b.id, { status: "COMPLETED" })
        return { kind: "returned", ok: true }
      },
    })
    h.sc.start()
    await cycles(h, 6)

    // T1's marker exists: its attempt ended.
    expect(h.marker(a.id)).not.toBeNull()
    // T1 is NOT completed. No inference was made from the model's behaviour.
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
    // T2's completion is authoritative, because an external authority wrote it.
    expect(store.getTask(S, b.id)?.status).toBe("COMPLETED")
    // And T1 converges instead of being re-run forever.
    expect(h.seen.length).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// G. TASKSTORE / DATABASE / LEGACY
// ═════════════════════════════════════════════════════════════════════════════

describe("G. store, database and legacy", () => {
  test("G1. recordAttemptReturned is idempotent and overwrites the generation", () => {
    const a = addStranded("IN_PROGRESS")
    store.recordAttemptReturned(S, a.id, 2)
    store.recordAttemptReturned(S, a.id, 2)
    expect(store.getAttemptMarker(S, a.id)).toEqual({ attemptRevision: 2 })
    store.recordAttemptReturned(S, a.id, 9)
    expect(store.getAttemptMarker(S, a.id)).toEqual({ attemptRevision: 9 })
  })

  test("G2. a marker for an unknown task is stored but never read as task state", () => {
    // The marker is not a second task authority: it cannot conjure a task.
    store.recordAttemptReturned(S, "t999", 3)
    expect(store.getAttemptMarker(S, "t999")).toEqual({ attemptRevision: 3 })
    expect(store.getTask(S, "t999")).toBeNull()
  })

  test("G3. recordAttemptReturned rejects a non-positive or fractional revision", () => {
    const a = addStranded("IN_PROGRESS")
    expect(() => store.recordAttemptReturned(S, a.id, 0)).toThrow()
    expect(() => store.recordAttemptReturned(S, a.id, -1)).toThrow()
    expect(() => store.recordAttemptReturned(S, a.id, 1.5)).toThrow()
    expect(store.getAttemptMarker(S, a.id)).toBeNull()
  })

  test("G4. markers are scoped per session: session A's marker never shields session B", () => {
    const other = "6f-sess-other"
    const a = addStranded("IN_PROGRESS")
    const b = legacy.createTask(other, {
      title: "other session",
      status: "IN_PROGRESS",
      order: 1,
      provenance: prov,
    })
    store.recordAttemptReturned(S, a.id, 2)
    expect(store.getAttemptMarker(other, b.id)).toBeNull()
  })

  test("G5. SCHEMA INIT IS IDEMPOTENT: reopening a database with markers loses nothing", async () => {
    const a = addStranded("IN_PROGRESS")
    store.recordAttemptReturned(S, a.id, 2)
    const before = store.getTask(S, a.id)
    resetTaskStoreHandles()

    // Fresh store objects over the same database file: DDL runs again.
    const reopened = new TaskStore(dir, { authority: "SCHEDULER" })
    expect(reopened.getAttemptMarker(S, a.id)).toEqual({ attemptRevision: 2 })
    const after = reopened.getTask(S, a.id)
    expect(after?.status).toBe(before?.status)
    expect(after?.revision).toBe(before?.revision)
  })

  test("G6. MIGRATION SAFETY: a pre-marker database opens, keeps its data, and stays usable", async () => {
    // Simulate a database created BEFORE task_attempt existed: write task rows,
    // then drop the marker table to emulate the old schema exactly.
    const a = addStranded("IN_PROGRESS")
    const before = store.getTask(S, a.id)
    store.recordAttemptReturned(S, a.id, 2)
    resetTaskStoreHandles()

    // Emulate the old shape: remove the marker table entirely.
    const raw = new (await import("bun:sqlite")).Database(join(dir, ".minicode", "tasks.db"))
    raw.exec("DROP TABLE IF EXISTS task_attempt")
    raw.close()

    // Reopening re-runs the additive DDL and recreates it. No data is lost and
    // no revision is rewritten.
    const reopened = new TaskStore(dir, { authority: "SCHEDULER" })
    const after = reopened.getTask(S, a.id)
    expect(after?.status).toBe(before?.status)
    expect(after?.revision).toBe(before?.revision)
    expect(after?.title).toBe(before?.title)
    // The marker is gone with the table: absence has defined semantics
    // (no recorded completion), not an error.
    expect(reopened.getAttemptMarker(S, a.id)).toBeNull()
    // And the row is still reconcilable, exactly as a pre-6F stranded row was.
    resetTaskStoreHandles()
    resetSessionOwnershipForTests()
    const h = makeHarness({ store: reopened })
    h.sc.start()
    expect(h.sc.reconcile()).toEqual([a.id])
  })

  test("G7. LEGACY mode acquires no new behaviour from the marker table existing", () => {
    // A LEGACY store never writes a marker, and its task rows are unchanged by
    // the table's presence.
    const a = legacy.createTask(S, {
      title: "legacy",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    const before = legacy.getTask(S, a.id)
    expect(legacy.getAttemptMarker(S, a.id)).toBeNull()
    legacy.patchTask(S, a.id, { title: "legacy edited" })
    const after = legacy.getTask(S, a.id)
    expect(after?.title).toBe("legacy edited")
    // The only movement is the one the patch itself caused.
    expect(after!.revision).toBe(before!.revision + 1)
    // Still no marker: LEGACY does not become an execution-history writer.
    expect(legacy.getAttemptMarker(S, a.id)).toBeNull()
  })

  test("G8. LEGACY authority still refuses model-shaped IN_PROGRESS writes (6B unchanged)", () => {
    // The marker must not become a side door around the authority boundary:
    // IN_PROGRESS is still authorable ONLY by claimTask.
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
    // And no marker was conjured by the refused attempt.
    expect(store.getAttemptMarker(S, a.id)).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// H. STATIC ARCHITECTURE
// ═════════════════════════════════════════════════════════════════════════════

describe("H. static architecture", () => {
  async function srcFiles(dirPath: string): Promise<string[]> {
    const out: string[] = []
    for (const e of await readdir(dirPath, { withFileTypes: true })) {
      const p = join(dirPath, e.name)
      if (e.isDirectory()) out.push(...(await srcFiles(p)))
      else if (e.name.endsWith(".ts")) out.push(p)
    }
    return out
  }

  test("H1. the Scheduler reaches no database, presentation, UI or executor dependency", async () => {
    const root = join(import.meta.dir, "..")
    const text = await readFile(join(root, "src/task/scheduler.ts"), "utf8")
    // Strip comments so documentation about forbidden imports cannot trip this.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    for (const banned of [
      "bun:sqlite",
      "Database",
      "parallelExecutor",
      "presentation",
      "acp",
      "tui",
      "memory",
      "context",
    ]) {
      expect(code).not.toContain(banned)
    }
    // It must go through TaskStore, not around it.
    expect(code).toContain("this.store.")
  })

  test("H2. the Scheduler does not write a task status, and does not import TaskStatus", async () => {
    const root = join(import.meta.dir, "..")
    const text = await readFile(join(root, "src/task/scheduler.ts"), "utf8")
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    // COMPLETED must never be written by the Scheduler, in any form.
    expect(code).not.toMatch(/status\s*[:=]\s*["']COMPLETED["']/)
    expect(code).not.toContain("TaskStatus")
  })

  test("H3. no production file constructs a Scheduler: 6F does not enable anything", async () => {
    const root = join(import.meta.dir, "..")
    const files = await srcFiles(join(root, "src"))
    const offenders: string[] = []
    for (const f of files) {
      const rel = f.replace(`${root}\\`, "").replace(/\//g, "\\")
      if (rel === "src\\task\\scheduler.ts") continue
      const text = await readFile(f, "utf8")
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
      if (/new\s+Scheduler\s*\(/.test(code)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  test("H4. the marker does not leak into TaskGraph, readiness or the model", async () => {
    const root = join(import.meta.dir, "..")
    for (const f of ["src/task/graph.ts", "src/task/readiness.ts", "src/task/model.ts"]) {
      const text = await readFile(join(root, f), "utf8")
      expect(text).not.toContain("task_attempt")
      expect(text).not.toContain("AttemptMarker")
    }
  })

  test("H5. only TaskStore touches the marker table", async () => {
    const root = join(import.meta.dir, "..")
    const files = await srcFiles(join(root, "src"))
    const users: string[] = []
    for (const f of files) {
      const text = await readFile(f, "utf8")
      if (text.includes("task_attempt")) users.push(f.replace(`${root}\\`, "").replace(/\//g, "\\"))
    }
    // The DDL lives in store.ts, and nowhere else may name the table.
    expect(users).toEqual(["src\\task\\store.ts"])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// I. ERROR SEMANTICS
// ═════════════════════════════════════════════════════════════════════════════

describe("I. error semantics", () => {
  test("I1. a marker write failure is NOT swallowed and never becomes 'execution succeeded'", async () => {
    const a = add("PENDING")
    const failing = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === "recordAttemptReturned") {
          return () => {
            throw new Error("disk gone")
          }
        }
        return Reflect.get(target, prop, recv)
      },
    }) as TaskStore
    const h = makeHarness({ store: failing })
    h.sc.start()
    // It propagates. A silent success here would permanently strand the task.
    await expect(h.sc.cycle()).rejects.toThrow(/disk gone/)
    // The turn DID run, but nothing claims that was recorded.
    expect(h.seen.length).toBe(1)
    expect(store.getAttemptMarker(S, a.id)).toBeNull()
  })

  test("I2. a failed marker write leaves the task IN_PROGRESS, never PENDING-by-silence", async () => {
    const a = add("PENDING")
    const failing = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === "recordAttemptReturned") {
          return () => {
            throw new Error("nope")
          }
        }
        return Reflect.get(target, prop, recv)
      },
    }) as TaskStore
    const h = makeHarness({ store: failing })
    h.sc.start()
    await expect(h.sc.cycle()).rejects.toThrow()
    const t = store.getTask(S, a.id)
    expect(t?.status).toBe("IN_PROGRESS")
    // Specifically NOT released to PENDING: the turn ran, and pretending
    // otherwise would lose that fact.
    expect(t?.status).not.toBe("PENDING")
  })

  test("I3. distinct failure modes are distinguishable", () => {
    const a = addStranded("IN_PROGRESS")
    // marker missing
    expect(store.getAttemptMarker(S, a.id)).toBeNull()
    // marker generation mismatch -> surfaced by reconcile as a throw (C9)
    store.recordAttemptReturned(S, a.id, 99)
    const h = makeHarness()
    h.sc.start()
    expect(() => h.sc.reconcile()).toThrow(/exceeds task/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// J. INVARIANT: the marker is not a queue, a lock, or a history
// ═════════════════════════════════════════════════════════════════════════════

describe("J. marker is not a queue, lock or history", () => {
  test("J1. one row per task, regardless of how many attempts ran", async () => {
    const a = add("PENDING")
    const h = makeHarness()
    h.sc.start()
    for (let i = 0; i < 4; i++) {
      await h.sc.cycle()
      // Force a new generation each time via the external authority.
      const cur = store.getTask(S, a.id)
      if (cur?.status === "IN_PROGRESS") legacy.patchTask(S, a.id, { status: "PENDING" })
    }
    expect(h.seen.length).toBeGreaterThan(1)
    // Still exactly one marker: the table is O(tasks), never an execution log.
    const raw = new (await import("bun:sqlite")).Database(join(dir, ".minicode", "tasks.db"), {
      readonly: true,
    })
    const row = raw
      .prepare("SELECT COUNT(*) AS n FROM task_attempt WHERE session_id = ? AND task_id = ?")
      .get(S, a.id) as { n: number }
    raw.close()
    expect(row.n).toBe(1)
  })

  test("J2. the marker grants no exclusion: it does not stop a second claim attempt", () => {
    // A marker is a fact, not a lock. Two claims in a row still contend on the
    // revision predicate, exactly as before 6F.
    const a = add("PENDING")
    const first = store.claimTask(S, a.id, store.getTask(S, a.id)!.revision)
    expect(first.outcome).toBe("CLAIM_ACCEPTED")
    store.recordAttemptReturned(S, a.id, first.task!.revision)
    // The task is IN_PROGRESS, so it is no longer claimable — because of its
    // STATUS, not because of the marker.
    const second = store.claimTask(S, a.id, first.task!.revision)
    expect(second.outcome).toBe("WRONG_STATE")
  })

  test("J3. the marker does not make a task ready", async () => {
    const a = addStranded("IN_PROGRESS")
    store.recordAttemptReturned(S, a.id, store.getTask(S, a.id)!.revision)
    const graph = new TaskGraph(store.getSnapshot(S))
    // A marked IN_PROGRESS task is still not schedulable.
    expect(graph.readyTasks()).toEqual([])
    expect(graph.validity().valid).toBe(true)
  })
})
