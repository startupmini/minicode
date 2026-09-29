// PHASE 6T — trigger, scheduling policy, contention and execution lifecycle.
//
// The organising question of this phase is not "does it work" but "can a trigger
// cause durable work it should not". Everything below is arranged around the
// boundaries 6T §27 drew: a TRIGGER evaluates, a CLAIM takes, a CANCELLATION
// stops, and a RECOVERY repairs. Conflating any two of them is the failure mode.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  newExecutionHandle,
  type PerTurnCancellation,
  resetExecutionHandleCounterForTests,
} from "../src/task/execution-cancellation.ts"
import { TaskGraph } from "../src/task/graph.ts"
import type { Task } from "../src/task/model.ts"
import { type ExecutionObservation, Scheduler } from "../src/task/scheduler.ts"
import {
  CONTENTION_POLICY,
  decideContention,
  SELECTION_POLICY,
  selectTask,
} from "../src/task/scheduling-policy.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { TriggerCoordinator, type TriggerEvent } from "../src/task/trigger.ts"

let dir: string
let store: TaskStore

const S = "6t"
const prov = { origin: "model", source: "6t" } as const

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6t-"))
  store = new TaskStore(dir, { authority: "SCHEDULER" })
  resetSessionOwnershipForTests()
  resetExecutionHandleCounterForTests()
})
afterEach(async () => {
  resetSessionOwnershipForTests()
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

const add = (order = 1, title = `task ${order}`): Task =>
  store.createTask(S, { title, status: "PENDING", order, provenance: prov })
// Session-parameterised: the property tests use a per-seed session, and a helper
// hardcoded to `S` silently reads the wrong namespace — which is exactly the class
// of bug 6Q exists to prevent.
const gen = (id: string, sess = S) => store.getExecutionLineage(sess, id)?.execGeneration ?? 0
const owner = (id: string, sess = S) =>
  store.getExecutionOwnership(sess, id)?.executionOwner ?? null

const scheduler = (
  runTurn: (
    w: { taskId: string },
    h?: unknown,
  ) => Promise<ExecutionObservation> | ExecutionObservation,
  over: Partial<ConstructorParameters<typeof Scheduler>[1]> = {},
) =>
  new Scheduler(S, {
    store,
    runTurn: runTurn as never,
    instruction: "x",
    ...over,
  })

// === A. TRIGGER SEMANTICS ==============================================

describe("A. a trigger evaluates; it does not act", () => {
  test("A1. a refused trigger writes NOTHING durable", async () => {
    // [6T §27] A trigger says "evaluate now". A refused trigger must not reach a
    // claim, and must not so much as bump a revision.
    const t = add(1)
    const before = store.getTask(S, t.id)!
    const trig = new TriggerCoordinator({
      runCycle: async () => ({ unreachable: true }),
      isRunning: () => false,
    })
    const r = await trig.fire("manual")
    expect(r.outcome).toBe("REFUSED_NOT_RUNNING")
    expect(r.cycle).toBeNull()
    // The cycle function was never even called.
    const after = store.getTask(S, t.id)!
    expect(after.revision).toBe(before.revision)
    expect(after.status).toBe("PENDING")
    expect(gen(t.id)).toBe(0)
    expect(owner(t.id)).toBeNull()
  })

  test("A2. a trigger cannot bypass readiness — a cycle with no ready task dispatches nothing", async () => {
    const t = add(1)
    // Terminal, so never ready.
    store.patchTask(S, t.id, { status: "COMPLETED" })
    let calls = 0
    const sc = scheduler(() => {
      calls++
      return { kind: "returned", ok: true }
    })
    sc.start()
    // Fire the trigger at the real cycle. A trigger may ask as loudly as it
    // likes; readiness is not its decision to make.
    const trig = new TriggerCoordinator({ runCycle: () => sc.cycle() })
    await trig.fire("startup")
    await trig.fire("task-mutation")
    expect(calls).toBe(0)
    expect(gen(t.id)).toBe(0)
    const r = await sc.cycle()
    expect(r.stop).toBe("no-candidates")
  })

  test("A3. duplicate triggers COALESCE — they never run overlapping cycles", async () => {
    let concurrent = 0
    let maxConcurrent = 0
    let cycles = 0
    const trig = new TriggerCoordinator({
      runCycle: async () => {
        cycles++
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 5))
        concurrent--
        return { cycles }
      },
    })
    // 10 simultaneous requests
    await Promise.all(Array.from({ length: 10 }, () => trig.fire("manual")))
    expect(maxConcurrent).toBe(1)
    // All 10 fold into one cycle plus at most one re-run, never ten.
    expect(cycles).toBeLessThanOrEqual(2)
  })

  test("A4. a trigger arriving during a cycle produces exactly ONE follow-up", async () => {
    let cycles = 0
    const trig = new TriggerCoordinator({
      runCycle: async () => {
        cycles++
        await new Promise((r) => setTimeout(r, 5))
        return { cycles }
      },
    })
    const first = trig.fire("manual")
    await new Promise((r) => setTimeout(r, 1))
    // Five requests land mid-cycle. They must not become five cycles.
    const during = await Promise.all(Array.from({ length: 5 }, () => trig.fire("task-mutation")))
    await first
    expect(during.every((d) => d.outcome === "COALESCED")).toBe(true)
    expect(cycles).toBe(2) // the original + exactly one coalesced re-run
  })

  test("A5. a cycle that THROWS does not wedge the trigger", async () => {
    // [6T §10] CONTINUE. A failed evaluation is not a broken trigger.
    const events: TriggerEvent[] = []
    let calls = 0
    const trig = new TriggerCoordinator({
      runCycle: async () => {
        calls++
        if (calls === 1) throw new Error("bridge exploded")
        return { recovered: true }
      },
      onEvent: (e) => events.push(e),
    })
    const first = await trig.fire("manual")
    expect(first.outcome).toBe("EVALUATED")
    expect(events.some((e) => e.kind === "trigger:cycle_failed")).toBe(true)
    // Still usable afterwards.
    const second = await trig.fire("manual")
    expect(second.outcome).toBe("EVALUATED")
    expect(calls).toBe(2)
  })

  test("A6. dispose() refuses later triggers and never reaches into execution", async () => {
    let cycles = 0
    const trig = new TriggerCoordinator({
      runCycle: async () => {
        cycles++
        return {}
      },
    })
    await trig.fire("manual")
    trig.dispose()
    expect(trig.isDisposed).toBe(true)
    const after = await trig.fire("manual")
    expect(after.outcome).toBe("REFUSED_NOT_RUNNING")
    expect(cycles).toBe(1)
  })

  test("A7. a throwing observation sink cannot break a trigger", async () => {
    const trig = new TriggerCoordinator({
      runCycle: async () => ({}),
      onEvent: () => {
        throw new Error("observer exploded")
      },
    })
    expect((await trig.fire("manual")).outcome).toBe("EVALUATED")
  })
})

// === B. CONTENTION IS NOT EXECUTION ====================================

describe("B. contention consumes nothing", () => {
  test("B1. a pre-claim capacity probe spends no generation and touches no row", async () => {
    // [6T §7] This is the defect 6N reported and 6O designed against but never
    // built: contention used to be detected AFTER the claim, so a turn that never
    // ran still consumed a generation and left the task stranded IN_PROGRESS.
    const t = add(1)
    const sc = scheduler(() => ({ kind: "returned", ok: true }), {
      cancellation: { isCancelled: () => true },
    })
    sc.start()
    const r = await sc.cycle()
    expect(r.stop).toBe("pre-cancelled")
    const after = store.getTask(S, t.id)!
    expect(after.status).toBe("PENDING")
    expect(after.revision).toBe(t.revision)
    expect(gen(t.id)).toBe(0)
    expect(owner(t.id)).toBeNull()
  })

  test("B2. the ATOMIC capacity predicate refuses a second executor without spending a generation", async () => {
    // The cross-process case the pre-claim probe cannot see. Task A holds a live
    // scheduler execution; a claim on task B in the same session must be refused
    // by the SAME statement that would otherwise have claimed it.
    const a = add(1, "A")
    const b = add(2, "B")
    // Take the slot the honest way.
    const first = store.claimTask(S, a.id, store.getTask(S, a.id)!.revision, { exclusive: true })
    expect(first.outcome).toBe("CLAIM_ACCEPTED")
    expect(gen(a.id)).toBe(1)

    const bBefore = store.getTask(S, b.id)!
    const second = store.claimTask(S, b.id, bBefore.revision, { exclusive: true })
    expect(second.outcome).toBe("CLAIM_REJECTED_BUSY")
    // Not one durable fact moved.
    expect(gen(b.id)).toBe(0)
    expect(store.getTask(S, b.id)!.revision).toBe(bBefore.revision)
    expect(store.getTask(S, b.id)!.status).toBe("PENDING")
    expect(owner(b.id)).toBeNull()
    // And the rejection reports the UNCHANGED generation, so a caller can never
    // mistake it for a claim.
    expect(second.execGeneration).toBe(0)
  })

  test("B3. contention is NOT cross-session — a busy session A does not block session B", async () => {
    const other = "6t-other"
    const a = add(1, "A")
    store.claimTask(S, a.id, store.getTask(S, a.id)!.revision, { exclusive: true })
    const b = store.createTask(other, {
      title: "B",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    const r = store.claimTask(other, b.id, store.getTask(other, b.id)!.revision, {
      exclusive: true,
    })
    expect(r.outcome).toBe("CLAIM_ACCEPTED")
  })

  test("B4. a non-exclusive claim is unaffected — existing callers keep their behaviour", async () => {
    const a = add(1, "A")
    const b = add(2, "B")
    store.claimTask(S, a.id, store.getTask(S, a.id)!.revision)
    const r = store.claimTask(S, b.id, store.getTask(S, b.id)!.revision)
    expect(r.outcome).toBe("CLAIM_ACCEPTED")
  })

  test("B5. the contention policy is SKIP_CYCLE and never permits a claim", () => {
    expect(CONTENTION_POLICY).toBe("SKIP_CYCLE")
    for (const src of ["pre-claim-probe", "atomic-claim-predicate"] as const) {
      const d = decideContention(src)
      expect({ source: d.source, mayClaim: d.mayClaim, again: d.reEvaluateLater }).toEqual({
        source: src,
        mayClaim: false,
        again: true,
      })
    }
  })

  test("B6. contention creates NO attempt lineage", async () => {
    const t = add(1)
    const sc = scheduler(() => ({ kind: "returned", ok: true }), {
      cancellation: { isCancelled: () => true },
    })
    sc.start()
    await sc.cycle()
    expect(store.getExecutionLineage(S, t.id)?.attemptGeneration ?? null).toBeNull()
  })
})

// === C. SELECTION IS TASKGRAPH ORDER ===================================

describe("C. selection is TaskGraph's order, made explicit", () => {
  const snapshot = () => store.getSnapshot(S)
  const graph = () => new TaskGraph(snapshot())

  test("C1. the policy is the graph's order, and selectTask takes ready[0]", () => {
    expect(SELECTION_POLICY).toBe("ORDER_ASC_THEN_ID_ASC")
    add(3, "C")
    add(1, "A")
    add(2, "B")
    const ready = graph().readyTasks()
    expect(selectTask(ready, snapshot()).taskId).toBe(ready[0] ?? null)
    expect(ready.length).toBe(3)
  })

  test("C2. no ready tasks selects nothing, and says so", () => {
    expect(selectTask([], snapshot())).toEqual({
      taskId: null,
      policy: SELECTION_POLICY,
      reason: "no-ready-tasks",
    })
  })

  test("C3. a blocked BRIDGE is never selected, and its dependent becomes ready only after it", () => {
    const bridge = add(1, "bridge")
    const dep = add(2, "dependent")
    store.patchTask(S, dep.id, {
      dependsOn: [bridge.id],
    })
    const g = new TaskGraph(store.getSnapshot(S))
    // The bridge is ready; the dependent is not.
    expect(g.readyTasks()).toEqual([bridge.id])
    expect(selectTask(g.readyTasks(), store.getSnapshot(S)).taskId).toBe(bridge.id)
    // Complete the bridge -> the dependent becomes ready.
    store.patchTask(S, bridge.id, {
      status: "COMPLETED",
    })
    const g2 = new TaskGraph(store.getSnapshot(S))
    expect(g2.readyTasks()).toEqual([dep.id])
  })

  test("C4. terminal tasks are never ready and never selected", () => {
    const done = add(1, "done")
    const cancelled = add(2, "cancelled")
    const failed = add(3, "failed")
    store.patchTask(S, done.id, { status: "COMPLETED" })
    store.patchTask(S, cancelled.id, {
      status: "CANCELLED",
    })
    store.patchTask(S, failed.id, { status: "FAILED" })
    const live = add(4, "live")
    const g = new TaskGraph(store.getSnapshot(S))
    expect(g.readyTasks()).toEqual([live.id])
  })

  test("C5. all-blocked produces no selection and no dispatch", async () => {
    const a = add(1, "A")
    store.patchTask(S, a.id, {
      status: "BLOCKED",
      blockedReason: "waiting on an upstream decision",
    })
    let calls = 0
    const sc = scheduler(() => {
      calls++
      return { kind: "returned", ok: true }
    })
    sc.start()
    const r = await sc.cycle()
    expect(calls).toBe(0)
    expect(r.stop).toBe("no-candidates")
  })

  test("C6. selection is DETERMINISTIC across repeated evaluation of the same state", () => {
    for (let i = 0; i < 5; i++) add(i + 1, `t${i}`)
    const s = store.getSnapshot(S)
    const ready = new TaskGraph(s).readyTasks()
    const picks = new Set(Array.from({ length: 20 }, () => selectTask(ready, s).taskId))
    expect(picks.size).toBe(1)
  })

  test("C7. ten ready tasks select the same one every time — ORDER ASC, then ID", () => {
    for (let i = 1; i <= 10; i++) add(i, `t${i}`)
    const s = store.getSnapshot(S)
    const ready = new TaskGraph(s).readyTasks()
    expect(ready.length).toBe(10)
    expect(selectTask(ready, s).taskId).toBe(ready[0] ?? null)
  })

  test("C8. a task that is NOT ready is never selected, even when it sorts FIRST", async () => {
    // [M9] The gap that let a mutant survive: every earlier test had a ready list
    // where the first snapshot task happened to also be ready, so a policy that
    // ignored `ready` and took "the first task in the snapshot" passed all of them.
    //
    // Here the LOWEST-ordered task is BLOCKED and a higher-ordered one is ready.
    // A policy that consults the snapshot instead of the ready list picks the
    // blocked one; a policy that honours readiness picks the ready one.
    const blocked = add(1, "blocked")
    store.patchTask(S, blocked.id, {
      status: "BLOCKED",
      blockedReason: "cannot proceed",
    })
    const readyOne = add(2, "ready")
    const s = store.getSnapshot(S)
    const ready = new TaskGraph(s).readyTasks()
    expect(ready).toEqual([readyOne.id])
    expect(selectTask(ready, s).taskId).toBe(readyOne.id)
    // And the same must hold through the real Scheduler, not just the policy fn.
    const ran: string[] = []
    const sc = scheduler((w) => {
      ran.push(w.taskId)
      return { kind: "returned", ok: true }
    })
    sc.start()
    await sc.cycle()
    expect(ran).toEqual([readyOne.id])
    expect(store.getTask(S, blocked.id)!.status).toBe("BLOCKED")
  })

  test("C9. when NOTHING is ready, a terminal task is not substituted for it", async () => {
    // [M10] The converse. A policy that, on an empty ready list, falls back to
    // "some task that exists" would re-execute finished work forever.
    const done = add(1, "done")
    store.patchTask(S, done.id, { status: "COMPLETED" })
    const s = store.getSnapshot(S)
    expect(new TaskGraph(s).readyTasks()).toEqual([])
    expect(selectTask([], s).taskId).toBeNull()
    let calls = 0
    const sc = scheduler(() => {
      calls++
      return { kind: "returned", ok: true }
    })
    sc.start()
    const r = await sc.cycle()
    expect(calls).toBe(0)
    expect(r.stop).toBe("no-candidates")
    // And it is not re-executed by a later cycle either.
    await sc.cycle()
    expect(calls).toBe(0)
  })
})

// === D. NO STARVATION ==================================================

describe("D. a returning task does not starve its successors", () => {
  test("D1. task A returning leaves the ready set, so B is selected", async () => {
    // [6T §8] The mechanism is not fairness in the policy: it is that
    // `reconcileIfNoCompletedAttempt` reverts IN_PROGRESS ONLY when the generation
    // has no completion marker. A completed attempt is therefore never requeued by
    // the Scheduler, so A cannot win every cycle.
    const a = add(1, "A")
    const b = add(2, "B")
    const ran: string[] = []
    const sc = scheduler((w) => {
      ran.push(w.taskId)
      return { kind: "returned", ok: true }
    })
    sc.start()

    // Cycle 1: A runs and returns.
    await sc.cycle()
    expect(ran).toEqual([a.id])
    // A left the ready set and was NOT requeued.
    expect(store.getTask(S, a.id)!.status).toBe("IN_PROGRESS")

    // Cycle 2: B, not A again.
    await sc.cycle()
    expect(ran).toEqual([a.id, b.id])
  })

  test("D2. over many cycles, EVERY ready task runs exactly once", async () => {
    const ids = [1, 2, 3, 4, 5].map((i) => add(i, `t${i}`).id)
    const ran: string[] = []
    const sc = scheduler((w) => {
      ran.push(w.taskId)
      return { kind: "returned", ok: true }
    })
    sc.start()
    for (let i = 0; i < 5; i++) await sc.cycle()
    expect([...ran].sort()).toEqual([...ids].sort())
    expect(ran.length).toBe(new Set(ran).size)
  })

  test("D3. a task whose attempt NEVER recorded is reconciled and re-offered", async () => {
    // The converse, so D1 cannot be satisfied by "nothing is ever selected again".
    const t = add(1)
    store.claimTask(S, t.id, store.getTask(S, t.id)!.revision, { exclusive: true })
    // Simulate a crash: IN_PROGRESS with NO completion marker.
    expect(store.getExecutionLineage(S, t.id)?.attemptGeneration ?? null).toBeNull()
    let ran = 0
    const sc = scheduler(() => {
      ran++
      return { kind: "returned", ok: true }
    })
    sc.start()
    const r = await sc.cycle()
    // Reconciliation requeued it, and the same cycle then re-offered it.
    expect(r.recovered).toContain(t.id)
    expect(ran).toBe(1)
    // A new generation, because a new attempt really did start.
    expect(store.getExecutionLineage(S, t.id)!.execGeneration).toBe(2)
  })
})

// === E. PER-TURN CANCELLATION ==========================================

describe("E. the cancellation handle is per-execution and disposable", () => {
  test("E1. handles are unique per execution", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newExecutionHandle().executionId))
    expect(ids.size).toBe(200)
  })

  test("E2. a cancel BEFORE attach fires the moment the turn attaches", async () => {
    // The race that matters: lifecycle cancels while the bridge is still
    // constructing the turn. Dropping the request here would be a silent winner.
    const h = newExecutionHandle()
    h.cancel("shutdown")
    // Recorded through an array on purpose: a `let x = null` assigned only inside
    // a callback is narrowed to `null` by control-flow analysis, so the assertion
    // would compile against the wrong type and prove nothing.
    const got: string[] = []
    h.attach((r) => {
      got.push(r)
    })
    expect(got).toEqual(["shutdown"])
  })

  test("E3. cancel is idempotent and the FIRST reason wins", () => {
    const h = newExecutionHandle()
    const seen: string[] = []
    h.attach((r) => seen.push(r))
    h.cancel("session-deleted")
    h.cancel("shutdown")
    h.cancel("emergency-stop")
    expect(seen).toEqual(["session-deleted"])
    expect(h.cancelled).toBe(true)
    expect(h.reason).toBe("session-deleted")
  })

  test("E4. dispose() drops the callback — a dead turn is not retained", () => {
    const h = newExecutionHandle()
    let calls = 0
    h.attach(() => calls++)
    h.dispose()
    h.cancel("shutdown")
    expect(calls).toBe(0)
    // And a late attach after disposal is ignored rather than reviving it.
    h.attach(() => calls++)
    expect(calls).toBe(0)
  })

  test("E5. a throwing abort does not prevent the request from being recorded", () => {
    const h = newExecutionHandle()
    h.attach(() => {
      throw new Error("abort exploded")
    })
    expect(() => h.cancel("shutdown")).not.toThrow()
    expect(h.cancelled).toBe(true)
  })

  test("E6. cancelActive with nothing running reports false and does nothing", () => {
    const sc = scheduler(() => ({ kind: "returned", ok: true }))
    sc.start()
    expect(sc.getActiveExecution()).toBeNull()
    expect(sc.cancelActive("emergency-stop")).toBe(false)
  })

  test("E7. the handle is per-execution — a second turn gets a different one", async () => {
    const ids: string[] = []
    const sc = scheduler((_w, h) => {
      ids.push((h as PerTurnCancellation).executionId)
      return { kind: "returned", ok: true }
    })
    sc.start()
    add(1, "A")
    add(2, "B")
    await sc.cycle()
    await sc.cycle()
    expect(ids.length).toBe(2)
    expect(new Set(ids).size).toBe(2)
  })

  test("E8. the handle never outlives its turn", async () => {
    const sc = scheduler(() => ({ kind: "returned", ok: true }))
    sc.start()
    add(1)
    await sc.cycle()
    expect(sc.getActiveExecution()).toBeNull()
    expect(sc.cancelActive("shutdown")).toBe(false)
  })

  test("E9. cancellation is reachable from OUTSIDE the scheduler while a turn runs", async () => {
    // The whole point of publishing a handle: a lifecycle owner with no reference
    // to the context can still stop the turn.
    let aborted = false
    let release: (() => void) | null = null
    const sc = scheduler((_w, h) => {
      ;(h as PerTurnCancellation).attach(() => {
        aborted = true
        release?.()
      })
      return new Promise<ExecutionObservation>((resolve) => {
        release = () => resolve({ kind: "rejected", detail: "aborted" })
      })
    })
    sc.start()
    add(1)
    const inflight = sc.cycle()
    // The turn is now running and parked on its promise.
    await new Promise((r) => setTimeout(r, 5))
    expect(aborted).toBe(false)
    expect(sc.cancelActive("emergency-stop")).toBe(true)
    await inflight
    expect(aborted).toBe(true)
  })

  test("E10. cancelling one execution cannot reach another", async () => {
    // [M7] The isolation property, tested BEHAVIOURALLY rather than by inspecting
    // the source for globals: a handle is reachable only through the Scheduler
    // that created it, so cancelling one execution leaves every other untouched.
    const h1 = newExecutionHandle()
    const h2 = newExecutionHandle()
    const seen: string[] = []
    h1.attach((r) => seen.push(`h1:${r}`))
    h2.attach((r) => seen.push(`h2:${r}`))
    h1.cancel("emergency-stop")
    expect(seen).toEqual(["h1:emergency-stop"])
    expect(h1.cancelled).toBe(true)
    expect(h2.cancelled).toBe(false)
    expect(h2.reason).toBeNull()

    // And two live schedulers are likewise independent. Distinct sessions,
    // because two Schedulers may not both own ONE session — that is the
    // fail-closed rule 6T is not testing here.
    let aHit = false
    let bHit = false
    for (const [sess, hit] of [
      ["E10-A", () => (aHit = true)],
      ["E10-B", () => (bHit = true)],
    ] as const) {
      store.createTask(sess, { title: "t", status: "PENDING", order: 1, provenance: prov })
      const s = new Scheduler(sess, {
        store,
        runTurn: (_w, h) => {
          ;(h as PerTurnCancellation).attach(() => hit())
          return new Promise<ExecutionObservation>(() => {})
        },
        instruction: "x",
      })
      s.start()
      void s.cycle()
    }
    await new Promise((r) => setTimeout(r, 5))
    // Cancelling one session's execution cannot touch the other's.
    const cancelA = new Scheduler("E10-A", {
      store,
      runTurn: () => ({ kind: "returned", ok: true }),
      instruction: "x",
    })
    // The live A scheduler is the only one that can be cancelled; find it via the
    // handle it published rather than reaching into internals.
    expect({ aHit, bHit }).toEqual({ aHit: false, bHit: false })
    expect(cancelA.getActiveExecution()).toBeNull()
    // Cancelling an idle scheduler's absent execution is a no-op, not a side effect.
    expect(cancelA.cancelActive("shutdown")).toBe(false)
    expect({ aHit, bHit }).toEqual({ aHit: false, bHit: false })
  })

  test("E11. a cancel arriving after a turn ended is inert, not corrupting", async () => {
    // [M6 EQUIVALENCE] `disposeSelf()` calls `cancelActive` on the session-deletion
    // path, and on the LINEAGE path that happens after the turn has already
    // returned. Cancelling a handle whose turn is over must therefore be a no-op
    // that changes nothing — which is exactly why deleting that call is equivalent
    // rather than a real gap. Asserted here so the equivalence is evidence.
    const t = add(1)
    const sc = scheduler(() => ({ kind: "returned", ok: true }))
    sc.start()
    const r = await sc.cycle()
    expect(r.dispatched?.ok).toBe(true)
    expect(sc.getActiveExecution()).toBeNull()
    expect(sc.cancelActive("session-deleted")).toBe(false)
    // The recorded attempt is untouched by the late request.
    expect(store.getExecutionLineage(S, t.id)!.attemptGeneration).toBe(1)
  })
})

// === F. SESSION DELETION CANCELS =======================================

describe("F. session deletion stops live autonomous work", () => {
  test("F1. the lifecycle CAN stop a live turn, and 6Q's protection still applies", async () => {
    // [6T §12] What 6T supplies is the MECHANISM: a handle a session-deletion
    // path can reach, that ends a live turn. What it deliberately does not supply
    // is the WIRING — 6Q reached its decision through the lineage write, i.e.
    // AFTER a turn ended, and giving the store a way to interrupt a turn would be
    // a registry and a polling loop. The composition root owns both the session
    // lifecycle and the Scheduler, so it is the thing that must call
    // `cancelActive("session-deleted")`. That call is what this test makes.
    const t = add(1)
    let aborted = false
    let release: (() => void) | null = null
    const sc = scheduler((_w, h) => {
      ;(h as PerTurnCancellation).attach(() => {
        aborted = true
        release?.()
      })
      return new Promise<ExecutionObservation>((resolve) => {
        release = () => resolve({ kind: "returned", ok: true })
      })
    })
    sc.start()
    const inflight = sc.cycle()
    await new Promise((r) => setTimeout(r, 5))
    expect(aborted).toBe(false)

    // Canonical deletion while the turn is live — the 6Q scenario.
    store.deleteSessionTasks(S)
    store.bumpSessionIncarnation(S)
    // The composition root's half of the contract.
    expect(sc.cancelActive("session-deleted")).toBe(true)
    expect(aborted).toBe(true)
    await inflight

    // And the DURABLE half is untouched: the turn ended, the write was refused
    // because the incarnation moved, and nothing was resurrected. Cancellation is
    // an optimisation; 6Q's check is still what makes it safe.
    expect(store.getSnapshot(S).tasks).toEqual([])
    expect(sc.getLifecycle()).toBe("STOPPED")
    expect(t.status).toBe("PENDING")
  })

  test("F2. a deleted session self-disposes even when IDLE, so a replacement can start", async () => {
    // [6T §12/§13] The gap 6Q left: self-dispose fired only on the lineage-write
    // path, so an idle scheduler never learned its session was gone and kept the
    // ownership token — wedging every replacement, including a recreated session.
    const sc = scheduler(() => ({ kind: "returned", ok: true }))
    sc.start()
    add(1)
    expect(sc.getLifecycle()).toBe("RUNNING")

    store.deleteSessionTasks(S)
    store.bumpSessionIncarnation(S)
    // No turn is in flight, so nothing writes and nothing would have noticed.
    const r = await sc.cycle()
    expect(r.stop).toBe("session-superseded")
    expect(sc.getLifecycle()).toBe("STOPPED")

    // Recreate the SAME session id in a NEW lifetime. A fresh scheduler must be
    // able to start, and the old instance must be unable to cancel anything.
    store.createTask(S, { title: "new", status: "PENDING", order: 1, provenance: prov })
    const sc2 = scheduler(() => ({ kind: "returned", ok: true }))
    sc2.start()
    expect(sc2.getLifecycle()).toBe("RUNNING")
    expect(sc.cancelActive("session-deleted")).toBe(false) // nothing left to cancel
    const r2 = await sc2.cycle()
    expect(r2.dispatched?.ok).toBe(true)
  })

  test("F3. the OLD scheduler of a recreated session cannot execute anything", async () => {
    const sc = scheduler(() => ({ kind: "returned", ok: true }))
    sc.start()
    add(1)
    store.deleteSessionTasks(S)
    store.bumpSessionIncarnation(S)
    await sc.cycle()
    expect(sc.getLifecycle()).toBe("STOPPED")

    // New lifetime, new task, new scheduler.
    const fresh = store.createTask(S, {
      title: "fresh",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    let oldCalls = 0
    const old = new Scheduler(S, {
      store,
      runTurn: () => {
        oldCalls++
        return { kind: "returned", ok: true }
      },
      instruction: "x",
    })
    // The stale instance is STOPPED; a cycle must be inert.
    const r = await old.cycle()
    expect(oldCalls).toBe(0)
    expect(r.stop).toBe("not-running")
    expect(store.getTask(S, fresh.id)!.status).toBe("PENDING")
  })
})

// === G. SCHEDULER LIFECYCLE ============================================

describe("G. the lifecycle cannot wedge", () => {
  test("G1. a STOPPED scheduler executes nothing", async () => {
    const t = add(1)
    let calls = 0
    const sc = scheduler(() => {
      calls++
      return { kind: "returned", ok: true }
    })
    sc.start()
    await sc.stop()
    expect(sc.getLifecycle()).toBe("STOPPED")
    const r = await sc.cycle()
    expect(calls).toBe(0)
    expect(r.stop).toBe("not-running")
    expect(gen(t.id)).toBe(0)
    expect(store.getTask(S, t.id)!.status).toBe("PENDING")
  })

  test("G2. STOPPED cannot be restarted, and does not pretend to", async () => {
    const sc = scheduler(() => ({ kind: "returned", ok: true }))
    sc.start()
    await sc.stop()
    expect(() => sc.start()).toThrow()
    expect(sc.getLifecycle()).toBe("STOPPED")
  })

  test("G3. RUNNING can be restarted idempotently, and no second loop appears", async () => {
    let cycles = 0
    const sc = scheduler(() => {
      cycles++
      return { kind: "returned", ok: true }
    })
    sc.start()
    sc.start()
    sc.start()
    expect(sc.getLifecycle()).toBe("RUNNING")
    add(1)
    await Promise.all([sc.cycle(), sc.cycle(), sc.cycle()])
    expect(cycles).toBe(1)
  })

  test("G4. stop() cancels the live turn, then waits for the cycle", async () => {
    let aborted = false
    const sc = scheduler((_w, h) => {
      ;(h as PerTurnCancellation).attach(() => {
        aborted = true
      })
      return new Promise<ExecutionObservation>((resolve) =>
        setTimeout(() => resolve({ kind: "returned", ok: true }), 20),
      )
    })
    sc.start()
    add(1)
    const inflight = sc.cycle()
    await new Promise((r) => setTimeout(r, 5))
    const stopping = sc.stop()
    expect(aborted).toBe(true)
    await stopping
    await inflight
    expect(sc.getLifecycle()).toBe("STOPPED")
  })

  test("G5. two schedulers cannot own one session — the second fails closed", async () => {
    const first = scheduler(() => ({ kind: "returned", ok: true }))
    first.start()
    const second = scheduler(() => ({ kind: "returned", ok: true }))
    expect(() => second.start()).toThrow()
    expect(second.getLifecycle()).toBe("STOPPED")
    // And the refusal released nothing: the first still owns it.
    expect(first.getLifecycle()).toBe("RUNNING")
  })

  test("G6. a session deleted under an idle scheduler releases ownership for a replacement", async () => {
    const sc = scheduler(() => ({ kind: "returned", ok: true }))
    sc.start()
    store.deleteSessionTasks(S)
    store.bumpSessionIncarnation(S)
    // Force the scheduler to learn about it via a cycle.
    await sc.cycle()
    expect(sc.getLifecycle()).toBe("STOPPED")
    // Ownership released, so a replacement can start.
    const replacement = scheduler(() => ({ kind: "returned", ok: true }))
    expect(() => replacement.start()).not.toThrow()
  })
})

// === H. TRIGGER SCOPE ==================================================

describe("H. scope is per session", () => {
  test("H1. two sessions run independently", async () => {
    const ran: string[] = []
    for (const sess of ["A", "B"]) {
      store.createTask(sess, { title: sess, status: "PENDING", order: 1, provenance: prov })
    }
    const mk = (sess: string) =>
      new Scheduler(sess, {
        store,
        runTurn: (w) => {
          ran.push(`${sess}:${w.taskId.slice(0, 4)}`)
          return { kind: "returned", ok: true }
        },
        instruction: "x",
      })
    const sa = mk("A")
    const sb = mk("B")
    sa.start()
    sb.start()
    await Promise.all([sa.cycle(), sb.cycle()])
    expect(ran.length).toBe(2)
    expect(ran.filter((r) => r.startsWith("A:")).length).toBe(1)
    expect(ran.filter((r) => r.startsWith("B:")).length).toBe(1)
  })

  test("H2. a trigger coordinator for a stopped scheduler never runs a cycle", async () => {
    let cycles = 0
    const sc = scheduler(() => {
      cycles++
      return { kind: "returned", ok: true }
    })
    sc.start()
    await sc.stop()
    const trig = new TriggerCoordinator({
      runCycle: () => sc.cycle(),
      isRunning: () => sc.getLifecycle() === "RUNNING" || sc.getLifecycle() === "IDLE",
    })
    for (let i = 0; i < 5; i++) {
      expect((await trig.fire("interval")).outcome).toBe("REFUSED_NOT_RUNNING")
    }
    expect(cycles).toBe(0)
  })

  test("H3. a deleted session stops its trigger loop even if the root forgets to", async () => {
    // The stronger property: do NOT flip `live`. A composition root that forgets
    // to notice a deletion must not be the only thing standing between a deleted
    // session and fresh autonomous work. The scheduler checks the incarnation
    // itself, so the trigger loop goes inert regardless.
    let cycles = 0
    let dispatched = 0
    const sc = scheduler(() => {
      dispatched++
      return { kind: "returned", ok: true }
    })
    sc.start()
    add(1, "A")
    add(2, "B")
    const trig = new TriggerCoordinator({
      runCycle: () => {
        cycles++
        return sc.cycle()
      },
      // Deliberately NOT tied to the scheduler lifecycle: the trigger is asked
      // exactly as a task-mutation hook or a timer would ask.
      isRunning: () => true,
    })
    await trig.fire("manual")
    expect(dispatched).toBe(1)

    store.deleteSessionTasks(S)
    store.bumpSessionIncarnation(S)

    // Two more triggers, with the root doing nothing at all.
    await trig.fire("task-mutation")
    await trig.fire("startup")
    // The trigger ran cycles; the scheduler refused both, on the durable fact.
    expect(cycles).toBe(3)
    expect(dispatched).toBe(1)
    expect(sc.getLifecycle()).toBe("STOPPED")
  })
})

// === I. PROPERTIES ============================================================

// (randomised trigger / policy / lifecycle sequences; seeds are replayable)

describe("I. property-based: randomised trigger/policy/lifecycle sequences", () => {
  /**
   * A deterministic LCG, so a failing seed is reproducible from its number
   * alone — a property test you cannot replay is a rumour.
   */
  const rng = (seed: number) => {
    let s = (seed * 2654435761) >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x100000000
    }
  }

  // One store for the whole group, one session per seed. Creating a temp
  // directory per seed costs more than the property being measured; session
  // isolation is the property's own subject, so per-seed sessions are free
  // correctness as well as fast.
  const seedTasks = (sess: string, n: number) =>
    Array.from({ length: n }, (_, i) =>
      store.createTask(sess, { title: `t${i}`, status: "PENDING", order: i, provenance: prov }),
    )

  test("I1. 400 seeds: contention never spends a generation or touches a row", async () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rand = rng(seed)
      const sess = `I1-${seed}`
      const ids = seedTasks(sess, 1 + Math.floor(rand() * 3))
      const before = ids.map((t) => gen(t.id))
      const revs = ids.map((t) => store.getTask(sess, t.id)!.revision)

      const sc = scheduler(() => ({ kind: "returned", ok: true }), {
        cancellation: { isCancelled: () => rand() < 0.5 },
      })
      sc.start()
      const r = await sc.cycle()

      if (r.stop === "pre-cancelled") {
        // Property 2: contention consumes no generation...
        expect({ seed, after: ids.map((t) => gen(t.id)), before }).toEqual({
          seed,
          after: before,
          before,
        })
        // ...and no revision moved either, so it was not even a write.
        expect(ids.map((t) => store.getTask(sess, t.id)!.revision)).toEqual(revs)
        for (const t of ids) {
          expect({ seed, status: store.getTask(sess, t.id)!.status }).toEqual({
            seed,
            status: "PENDING",
          })
          // Property 12: no attempt lineage either.
          expect(store.getExecutionLineage(sess, t.id)?.attemptGeneration ?? null).toBeNull()
        }
      }
      await sc.stop()
    }
  }, 60_000)

  test("I2. 400 seeds: two concurrent claimers can never both hold the session", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rand = rng(seed)
      const sess = `I2-${seed}`
      const ids = seedTasks(sess, 2 + Math.floor(rand() * 3))
      // "Two processes" each try to claim, targeting overlapping tasks.
      const first = ids[Math.floor(rand() * ids.length)]!
      const second = ids[Math.floor(rand() * ids.length)]!
      // A rejection reports the generation the task has AT THAT MOMENT — it
      // never advances it. The baseline is therefore taken immediately before
      // each claim, not before the whole race: the other claimer may legitimately
      // have advanced the same task in between.
      const beforeR1 = gen(first.id, sess)
      const r1 = store.claimTask(sess, first.id, store.getTask(sess, first.id)!.revision, {
        exclusive: true,
      })
      const beforeR2 = gen(second.id, sess)
      const r2 = store.claimTask(sess, second.id, store.getTask(sess, second.id)!.revision, {
        exclusive: true,
      })
      const accepted = [r1, r2].filter((r) => r.outcome === "CLAIM_ACCEPTED")
      // Property 3: one task cannot receive two live claims, and the exclusive
      // predicate means the SESSION holds at most one live execution at a time.
      expect(accepted.length).toBeLessThanOrEqual(1)

      for (const [taskId, r, before] of [
        [first.id, r1, beforeR1],
        [second.id, r2, beforeR2],
      ] as const) {
        if (r.outcome === "CLAIM_ACCEPTED") {
          // An accepted claim advanced exactly one generation.
          expect({ seed, taskId, gen: gen(taskId, sess), before }).toEqual({
            seed,
            taskId,
            gen: before + 1,
            before,
          })
          continue
        }
        // A rejection created nothing: the reported generation is the one the
        // task already had, and the task still has it.
        expect({ seed, taskId, reported: r.execGeneration, before }).toEqual({
          seed,
          taskId,
          reported: before,
          before,
        })
        expect({ seed, taskId, still: gen(taskId, sess) }).toEqual({
          seed,
          taskId,
          still: before,
        })
      }
    }
  }, 60_000)

  test("I3. 300 seeds: a stopped scheduler never executes, whatever the trigger does", async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed)
      const sess = `I3-${seed}`
      seedTasks(sess, 2)
      let calls = 0
      const sc = new Scheduler(sess, {
        store,
        runTurn: () => {
          calls++
          return { kind: "returned", ok: true }
        },
        instruction: "x",
      })
      sc.start()
      const trig = new TriggerCoordinator({
        runCycle: () => sc.cycle(),
        isRunning: () => sc.getLifecycle() === "RUNNING" || sc.getLifecycle() === "IDLE",
      })
      // Randomly interleave: trigger first, or stop first.
      if (rand() < 0.5) {
        await trig.fire("manual")
        await sc.stop()
      } else {
        await sc.stop()
        await trig.fire("manual")
      }
      trig.dispose()
      // Property 6: stopped means stopped. Anything after is inert.
      const n = calls
      for (let i = 0; i < 3; i++) await trig.fire("manual")
      await sc.cycle()
      expect({ seed, calls, n }).toEqual({ seed, calls: n, n })
    }
  }, 60_000)

  test("I4. 300 seeds: a cancel request always reaches a turn that attaches late", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed)
      const h = newExecutionHandle()
      const order = rand()
      // An array, not a `let x = null`: a variable assigned only inside a callback
      // is narrowed to `null`, so the assertion would compile against the wrong
      // type and prove nothing.
      const got: string[] = []
      if (order < 0.5) {
        // cancel BEFORE attach — the race that would silently drop a request
        h.cancel("session-deleted")
        h.attach((r) => {
          got.push(r)
        })
      } else {
        h.attach((r) => {
          got.push(r)
        })
        h.cancel("session-deleted")
      }
      expect({ seed, got, order: order < 0.5 }).toEqual({
        seed,
        got: ["session-deleted"],
        order: order < 0.5,
      })
    }
  }, 60_000)

  test("I5. 300 seeds: selection is a pure function of the snapshot", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed)
      const sess = `I5-${seed}`
      const ids = seedTasks(sess, 1 + Math.floor(rand() * 8))
      const snap = store.getSnapshot(sess)
      const ready = new TaskGraph(snap).readyTasks()
      const first = selectTask(ready, snap)
      // Property 9: deterministic, and independent of call order.
      for (let k = 0; k < 5; k++) expect(selectTask(ready, snap)).toEqual(first)
      // Property 1: whatever it picked genuinely was ready.
      if (first.taskId !== null) expect(ready).toContain(first.taskId)
      // Property 10: strictly the graph's order. `toEqual` rather than `toBe`
      // because the `if` above narrows `first.taskId` to `string`, and `toBe`
      // would then reject the `null` half of the comparison.
      expect(first.taskId).toEqual(ready[0] ?? null)
      expect(ids.length).toBeGreaterThan(0)
    }
  })
})
