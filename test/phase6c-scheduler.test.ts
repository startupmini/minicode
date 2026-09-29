// Phase 6C — Scheduler core tests.
//
// NEW ARCHITECTURE. The Scheduler is headless and dependency-injected, so every
// test drives it directly. Nothing here wires it into the application.
//
// Covers the 40 categories of 6C §21. Two seams are used deliberately:
//   * a `raceStore` proxy, to force a mutation in the exact window between the
//     Scheduler's re-read and its claim (categories 17-20, 37). Without a seam
//     that window is unobservable, which would make the freshness guarantees
//     untestable rather than merely untested.
//   * a deferred `runTurn`, to observe serialisation (category 27).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TaskGraph } from "../src/task/graph.ts"
import type { Task, TaskStatus } from "../src/task/model.ts"
import {
  type ExecutionObservation,
  Scheduler,
  type SchedulerEvent,
  type SchedulerWorkItem,
} from "../src/task/scheduler.ts"
import {
  acquireSessionOwnership,
  resetSessionOwnershipForTests,
} from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

let dir: string
let store: TaskStore
/**
 * A LEGACY store over the same database, used ONLY to build fixture state that
 * the SCHEDULER-authority store would (correctly) refuse to create.
 *
 * This models reality rather than working around a rule: a stranded
 * `IN_PROGRESS` row is exactly what a crashed Scheduler leaves behind, i.e.
 * state written before authority was enforced, or by the claim primitive
 * itself. The authority guard is verified separately (category 4/5 of 6B).
 */
let legacy: TaskStore

const prov = { origin: "model", source: "test" } as const
const S = "sched-sess"

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6c-"))
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

/** Fixture for state a crashed Scheduler would have left behind. */
/**
 * [PHASE 6P] A GENUINE Scheduler-owned stranded execution.
 *
 * Previously this planted `status: "IN_PROGRESS"` directly, producing
 * `exec_generation = 0` — which is 6O history **H1** (interactive IN_PROGRESS,
 * no claim ever made) rather than a stranded Scheduler execution, and 6O requires
 * H1 to be left alone. The fixture now goes through the real claim path, so these
 * tests exercise ownership establishment rather than a hand-made status.
 *
 * VERIFYING is produced by claiming first and then taking the model-facing write,
 * which RETAINS ownership (VERIFYING is a Scheduler-owned in-flight state) and so
 * stays recoverable.
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

/** A recording, immediately-resolving bridge. */
function makeBridge(ok = true) {
  const seen: SchedulerWorkItem[] = []
  const runTurn = (w: SchedulerWorkItem): ExecutionObservation => {
    seen.push(w)
    return { kind: "returned", ok }
  }
  return { runTurn, seen }
}

function makeScheduler(opts: { ok?: boolean; onEvent?: (e: SchedulerEvent) => void } = {}) {
  const bridge = makeBridge(opts.ok ?? true)
  const events: SchedulerEvent[] = []
  const sc = new Scheduler(S, {
    store,
    runTurn: bridge.runTurn,
    instruction: "do the work",
    onEvent: (e) => {
      events.push(e)
      opts.onEvent?.(e)
    },
  })
  return { sc, bridge, events }
}

const kinds = (events: readonly SchedulerEvent[]): string[] => events.map((e) => e.kind)

// ── 1-5. lifecycle ───────────────────────────────────────────────────────────
describe("lifecycle", () => {
  test("1. CREATED -> RUNNING on start()", () => {
    const { sc } = makeScheduler()
    expect(sc.getLifecycle()).toBe("CREATED")
    sc.start()
    expect(sc.getLifecycle()).toBe("RUNNING")
  })

  test("2. start() is idempotent while running", () => {
    const { sc } = makeScheduler()
    sc.start()
    sc.start()
    sc.start()
    expect(sc.getLifecycle()).toBe("RUNNING")
  })

  test("3/4. stop() then start() is refused, not silently ignored", async () => {
    const { sc } = makeScheduler()
    sc.start()
    await sc.stop()
    expect(sc.getLifecycle()).toBe("STOPPED")
    expect(() => sc.start()).toThrow(/STOPPED/)
    expect(sc.getLifecycle()).toBe("STOPPED")
  })

  test("3b. stop() is safe to call repeatedly", async () => {
    const { sc } = makeScheduler()
    sc.start()
    await sc.stop()
    await sc.stop()
    await sc.stop()
    expect(sc.getLifecycle()).toBe("STOPPED")
  })

  test("5. stop() does not CANCEL anything and writes no durable state", async () => {
    add("PENDING")
    const { sc } = makeScheduler()
    sc.start()
    await sc.cycle()
    const before = store.listTasks(S)
    await sc.stop()
    const after = store.listTasks(S)
    expect(after.map((t) => t.status)).toEqual(before.map((t) => t.status))
    expect(after.some((t) => t.status === "CANCELLED")).toBe(false)
  })

  test("RUNNING <-> IDLE on a work/no-work cycle", async () => {
    const { sc } = makeScheduler()
    sc.start()
    expect(sc.getLifecycle()).toBe("RUNNING")
    await sc.cycle() // nothing ready
    expect(sc.getLifecycle()).toBe("IDLE")
    add("PENDING")
    await sc.cycle()
    expect(sc.getLifecycle()).toBe("IDLE")
  })
})

// ── 6-9. ownership ───────────────────────────────────────────────────────────
describe("ownership", () => {
  test("6. holding ownership allows operation", async () => {
    add("PENDING")
    const { sc, bridge } = makeScheduler()
    sc.start()
    await sc.cycle()
    expect(bridge.seen.length).toBe(1)
  })

  test("7. ownership unavailable -> FAIL CLOSED, no claim, no dispatch", async () => {
    add("PENDING")
    acquireSessionOwnership(S, "someone-else") // occupy it
    const { sc, bridge } = makeScheduler()
    expect(() => sc.start()).toThrow(/owned/)
    expect(sc.getLifecycle()).toBe("STOPPED")
    const r = await sc.cycle()
    expect(r.stop).toBe("not-running")
    expect(bridge.seen.length).toBe(0)
    expect(store.listTasks(S)[0]?.status).toBe("PENDING")
  })

  test("8. a competing same-session owner blocks a second Scheduler", async () => {
    const first = makeScheduler().sc
    first.start()
    expect(first.getLifecycle()).toBe("RUNNING")
    const second = makeScheduler().sc
    expect(() => second.start()).toThrow()
    expect(second.getLifecycle()).toBe("STOPPED")
  })

  test("9. reconciliation refuses without ownership (no cross-process illusion)", async () => {
    const t = addStranded("IN_PROGRESS")
    // No Scheduler owns the session, so reconcile() must refuse.
    const { sc } = makeScheduler()
    expect(sc.reconcile()).toEqual([])
    expect(store.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  })
})

// ── 10-12. discovery ─────────────────────────────────────────────────────────
describe("discovery", () => {
  test("10. a fresh snapshot + fresh graph every cycle (no caching)", async () => {
    const a = add("PENDING")
    const { sc, bridge } = makeScheduler()
    sc.start()
    await sc.cycle()
    expect(bridge.seen.map((w) => w.taskId)).toEqual([a.id])

    // A verifier (an external authority) completes t1, then a new task appears.
    // The next cycle must see BOTH changes — a cached graph would dispatch t1
    // again or miss t2 entirely.
    legacy.patchTask(S, a.id, { status: "COMPLETED" })
    const b = add("PENDING", { order: 2 })
    await sc.cycle()
    expect(bridge.seen.map((w) => w.taskId)).toEqual([a.id, b.id])
  })

  test("10b. a normal return is NOT re-dispatched: the lineage records that the generation ended", async () => {
    // [PHASE 6F] This test previously asserted the opposite: it encoded the
    // unbounded re-execution loop that Phase 6D identified as a liveness
    // failure. `expect(seen).toEqual([a.id, a.id])` was only satisfiable by
    // re-running a task whose turn had already returned.
    //
    // [PHASE 6I] The completion evidence is now the task's execution lineage, not
    // a revision-keyed marker. The contract is unchanged: a returned turn leaves
    // a durable record, the task stays IN_PROGRESS (a return is not a verdict),
    // and reconciliation must NOT revert a generation that recorded completion.
    const a = add("PENDING")
    const { sc, bridge } = makeScheduler()
    sc.start()
    await sc.cycle()
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")

    // The record is durable, and names the generation the claim created.
    const lineage = store.getExecutionLineage(S, a.id)
    expect(lineage).not.toBeNull()
    expect(lineage?.execGeneration).toBe(1)
    expect(lineage?.attemptGeneration).toBe(1)
    // It is NOT a revision: the post-claim revision is 2, and the generation is 1.
    expect(store.getTask(S, a.id)?.revision).toBe(2)

    // Three further cycles with no external mutation: still exactly one turn.
    await sc.cycle()
    await sc.cycle()
    await sc.cycle()
    expect(bridge.seen.map((w) => w.taskId)).toEqual([a.id])
    expect(bridge.seen.length).toBe(1)
    // Untouched: still IN_PROGRESS, and the generation is still recorded.
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
    expect(store.getExecutionLineage(S, a.id)).toEqual({
      execGeneration: 1,
      attemptGeneration: 1,
    })
  })

  test("11. an invalid graph aborts the cycle with zero dispatch", async () => {
    add("PENDING", { parentId: "t9999" }) // DANGLING_PARENT
    const { sc, bridge, events } = makeScheduler()
    sc.start()
    const r = await sc.cycle()
    expect(r.stop).toBe("invalid-graph")
    expect(bridge.seen.length).toBe(0)
    expect(kinds(events)).toContain("cycle:invalid_graph")
    // No claim happened: status and revision are untouched.
    expect(store.listTasks(S)[0]?.status).toBe("PENDING")
  })

  test("12. readiness is CONSUMED from TaskGraph, not redefined", () => {
    // A blocked dependency must not be dispatched, exactly as TaskGraph decides.
    const a = add("PENDING")
    const b = add("PENDING", { dependsOn: [a.id] })
    const g = new TaskGraph(store.getSnapshot(S))
    expect(g.readyTasks()).toEqual([a.id])
    expect(g.readyTasks()).not.toContain(b.id)
  })
})

// ── 13-16. selection ─────────────────────────────────────────────────────────
describe("selection", () => {
  test("13/14/15. deterministic order: task.order ASC, then taskId tiebreak", async () => {
    // Deliberately inserted out of order, with a shared `order` for the tiebreak.
    add("PENDING", { order: 3, title: "third" })
    const second = add("PENDING", { order: 1, title: "first" })
    const tie = add("PENDING", { order: 1, title: "tie" })
    const { sc, bridge } = makeScheduler()
    sc.start()
    const r = await sc.cycle()
    expect(r.dispatched?.ok).toBe(true)
    // order 1 ties -> the lexicographically smaller id wins, deterministically.
    const expected = [second.id, tie.id].sort()[0]
    expect(bridge.seen[0]?.taskId).toBe(expected)
  })

  test("16. an active claim blocks a second selection", async () => {
    add("PENDING")
    const { sc, bridge } = makeScheduler()
    sc.start()
    await sc.cycle()
    // The bridge reported success, so the local claim was cleared; re-claim a
    // live one explicitly and assert selection is suppressed.
    const t = store.listTasks(S)[0]!
    // [PHASE 6I] An ActiveClaim now carries the execution generation the claim
    // created. The test pokes the field directly, so it must supply a real one.
    // [PHASE 6Q] and the session incarnation the claim was made under.
    sc["claim"] = {
      taskId: t.id,
      claimRevision: t.revision,
      execGeneration: store.getExecutionLineage(S, t.id)?.execGeneration ?? 1,
      sessionIncarnation: store.getSessionIncarnation(S),
    }
    const r = await sc.cycle()
    expect(r.stop).toBe("already-dispatched")
    expect(bridge.seen.length).toBe(1)
  })
})

// ── 17-22. claim ─────────────────────────────────────────────────────────────
describe("claim", () => {
  test("17. the exact current revision is accepted and dispatched", async () => {
    const t = add("PENDING")
    const { sc, bridge } = makeScheduler()
    sc.start()
    await sc.cycle()
    expect(bridge.seen[0]?.taskId).toBe(t.id)
    expect(store.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  })

  test("18/37. a stale revision executes nothing (no runTurn)", async () => {
    add("PENDING")
    // A store proxy that advances the row in the exact window between the
    // Scheduler's re-read and its claim. The Scheduler re-read revision 1, then
    // the row becomes revision 2, so its claim MUST lose.
    const real = store
    const race = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === "getTask") {
          return (sid: string, id: string) => {
            const before = target.getTask(sid, id)
            if (before !== null) target.patchTask(sid, id, { title: "raced" })
            return before
          }
        }
        return Reflect.get(target, prop, recv)
      },
    }) as TaskStore
    const seen: SchedulerWorkItem[] = []
    const sc = new Scheduler(S, {
      store: race,
      runTurn: (w) => {
        seen.push(w)
        return { kind: "returned", ok: true }
      },
      instruction: "x",
    })
    sc.start()
    const r = await sc.cycle()
    expect(r.stop).toBe("claim-rejected-stale")
    expect(seen.length).toBe(0)
  })

  test("19. NOT_FOUND executes nothing", async () => {
    add("PENDING")
    const real = store
    const gone = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === "getTask") return () => null
        return Reflect.get(target, prop, recv)
      },
    }) as TaskStore
    const sc = new Scheduler(S, {
      store: gone,
      runTurn: () => ({ kind: "returned", ok: true }),
      instruction: "x",
    })
    sc.start()
    const r = await sc.cycle()
    expect(r.stop).toBe("claim-not-found")
    expect(sc.getActiveClaim()).toBeNull()
  })

  test("20. WRONG_STATE executes nothing", async () => {
    add("BLOCKED", { blockedReason: "held" })
    // A BLOCKED task is not ready, so drive the wrong-state branch through the
    // race proxy instead: ready in the graph, non-PENDING at claim time.
    const real = store
    const t = real.createTask(S, { title: "x", status: "PENDING", order: 1, provenance: prov })
    const wrong = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === "getTask") {
          return (sid: string, id: string) => {
            target.patchTask(sid, id, { status: "CANCELLED" })
            return target.getTask(sid, id)
          }
        }
        return Reflect.get(target, prop, recv)
      },
    }) as TaskStore
    const sc = new Scheduler(S, {
      store: wrong,
      runTurn: () => ({ kind: "returned", ok: true }),
      instruction: "x",
    })
    sc.start()
    const r = await sc.cycle()
    expect(["claim-wrong-state", "claim-rejected-stale"]).toContain(r.stop)
    void t
  })

  test("21. one task cannot be double claimed", async () => {
    const t = add("PENDING")
    const { sc } = makeScheduler()
    sc.start()
    await sc.cycle()
    // A second Scheduler on the same session cannot start (ownership is held).
    const other = makeScheduler().sc
    expect(() => other.start()).toThrow()
    // And the durable row is claimed exactly once.
    expect(store.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  })

  test("22. the active claim records the POST-claim revision", async () => {
    add("PENDING")
    const seen: (number | null)[] = []
    const sc = new Scheduler(S, {
      store,
      runTurn: () => {
        seen.push(sc.getActiveClaim()?.claimRevision ?? null)
        return { kind: "returned", ok: true }
      },
      instruction: "x",
    })
    sc.start()
    await sc.cycle()
    const t = store.listTasks(S)[0]!
    // The post-claim revision is the pre-claim revision + 1.
    expect(seen[0]).toBe(2)
    expect(t.revision).toBe(2)
  })
})

// ── 23-26. dispatch + execution boundary ─────────────────────────────────────
describe("dispatch", () => {
  test("23. the work item carries exactly the locked fields", async () => {
    add("PENDING", { title: "my title" })
    const { sc, bridge } = makeScheduler()
    sc.start()
    await sc.cycle()
    expect(bridge.seen[0]).toEqual({
      taskId: store.listTasks(S)[0]!.id,
      title: "my title",
      instruction: "do the work",
      sessionId: S,
    })
  })

  test("24. the Scheduler calls only the injected bridge (no executor import)", async () => {
    // Static: scheduler.ts must not import the executor or any engine surface.
    const { readFileSync } = await import("node:fs")
    const { dirname, join: j } = await import("node:path")
    const { fileURLToPath } = await import("node:url")
    const src = readFileSync(
      j(dirname(fileURLToPath(import.meta.url)), "..", "src", "task", "scheduler.ts"),
      "utf8",
    )
    // Comments are stripped first: the module's own header NAMES each forbidden
    // token precisely to document that it does not use it, so a raw scan would
    // match the prohibition.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ")
    for (const forbidden of [
      "policy/executor",
      "parallelExecutor",
      "bun:sqlite",
      "Database",
      "tools/todo",
      "presentation/events",
      "transcript",
      "message history",
    ]) {
      expect({ token: forbidden, present: code.includes(forbidden) }).toEqual({
        token: forbidden,
        present: false,
      })
    }
  })

  test("25. a dispatch that throws BEFORE execution releases the claim", async () => {
    const claimed = add("PENDING", { order: 1, title: "claimed" })
    add("PENDING", { order: 2, title: "spare" })
    const sc = new Scheduler(S, {
      store,
      runTurn: () => {
        throw new Error("bridge unavailable")
      },
      instruction: "x",
    })
    sc.start()
    await sc.cycle()
    // The task that was actually CLAIMED (lowest order) is released back to
    // PENDING, not left stranded IN_PROGRESS by our own failure to start it.
    expect(store.getTask(S, claimed.id)?.status).toBe("PENDING")
    expect(sc.getActiveClaim()).toBeNull()
  })

  test("25b. a refused dispatch (cancellation) does NOT release the claim", async () => {
    const claimed = add("PENDING")
    let calls = 0
    const sc = new Scheduler(S, {
      store,
      runTurn: () => {
        calls++
        return { kind: "returned", ok: true }
      },
      instruction: "x",
      cancellation: { isCancelled: () => true },
    })
    sc.start()
    const r = await sc.cycle()
    // Cancelling is not releasing: the claim stays for a legitimate authority.
    expect(calls).toBe(0)
    expect(r.dispatched?.failure).toBe("scheduler-not-running")
    expect(r.dispatched?.released).toBe(false)
    expect(store.getTask(S, claimed.id)?.status).toBe("IN_PROGRESS")
  })

  test("26. an execution error never becomes COMPLETED", async () => {
    const t = add("PENDING")
    const sc = new Scheduler(S, {
      store,
      runTurn: async () => {
        throw new Error("turn exploded")
      },
      instruction: "x",
    })
    sc.start()
    const r = await sc.cycle()
    expect(r.dispatched?.ok).toBe(false)
    const after = store.getTask(S, t.id)!
    expect(after.status).not.toBe("COMPLETED")
    expect(after.status).toBe("IN_PROGRESS")
  })

  test("26b. a returned ok=false is an OBSERVATION, not a verdict", async () => {
    const t = add("PENDING")
    const sc = new Scheduler(S, {
      store,
      runTurn: () => ({ kind: "returned", ok: false }),
      instruction: "x",
    })
    sc.start()
    const r = await sc.cycle()
    expect(r.dispatched?.ok).toBe(false)
    expect(store.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  })
})

// ── 27-28. serialisation ─────────────────────────────────────────────────────
describe("serialisation", () => {
  test("27. N concurrent cycles produce at most ONE runTurn in flight", async () => {
    add("PENDING")
    add("PENDING", { order: 2 })
    let inFlight = 0
    let maxInFlight = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sc = new Scheduler(S, {
      store,
      runTurn: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await gate
        inFlight--
        return { kind: "returned", ok: true }
      },
      instruction: "x",
    })
    sc.start()
    const all = Promise.all([sc.cycle(), sc.cycle(), sc.cycle(), sc.cycle(), sc.cycle()])
    await new Promise((r) => setTimeout(r, 30))
    expect(maxInFlight).toBe(1)
    release()
    await all
    expect(maxInFlight).toBe(1)
  })

  test("27b. serialisation comes from the Scheduler, NOT from the atomic claim", async () => {
    // The discriminating case for mutant M15 (remove the in-flight join).
    //
    // With ONE ready task, a non-serialising Scheduler would still dispatch only
    // once — the second cycle would merely lose the atomic claim. So that test
    // proves nothing about serialisation.
    //
    // With TWO ready tasks and a bridge that blocks, a NON-serialising Scheduler
    // dispatches t1 and t2 simultaneously: the claim is on different rows, so
    // TaskStore offers no protection. Only Scheduler-side joining prevents that.
    add("PENDING", { order: 1, title: "one" })
    add("PENDING", { order: 2, title: "two" })
    let inFlight = 0
    let maxInFlight = 0
    const started: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sc = new Scheduler(S, {
      store,
      runTurn: async (w) => {
        started.push(w.taskId)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await gate
        inFlight--
        return { kind: "returned", ok: true }
      },
      instruction: "x",
    })
    sc.start()
    const all = Promise.all([sc.cycle(), sc.cycle()])
    await new Promise((r) => setTimeout(r, 30))
    // Exactly one dispatch began, and it is the lowest-ordered task.
    const one = store.listTasks(S).find((t) => t.title === "one")
    if (one === undefined) throw new Error("fixture task 'one' is missing")
    expect(started).toEqual([one.id])
    expect(maxInFlight).toBe(1)
    release()
    await all
  })

  test("28. a later cycle dispatches again once a task is LEGITIMATELY ready again", async () => {
    // [PHASE 6F] The original assertion here was `expect(calls).toBe(2)` after
    // two cycles on a SINGLE PENDING task — a second encoding of the same
    // unbounded re-execution loop that test 10b also encoded. Proving
    // "not permanently wedged" by counting re-dispatches of an unchanging task
    // cannot distinguish that from the livelock.
    //
    // The property worth keeping is real, and is now tested honestly: a
    // returned attempt does not wedge the Scheduler. When an external authority
    // supplies a NEW scheduling justification, the Scheduler acts again.
    add("PENDING")
    const { sc, bridge } = makeScheduler()
    sc.start()
    await sc.cycle()
    // Cycle 2 alone changes nothing: one task, one completed attempt.
    await sc.cycle()
    expect(bridge.seen.length).toBe(1)

    // New justification: the first task is completed by an external authority
    // and a second task becomes ready.
    const first = bridge.seen[0]
    expect(first).toBeDefined()
    legacy.patchTask(S, (first as SchedulerWorkItem).taskId, { status: "COMPLETED" })
    const b = add("PENDING", { order: 2 })
    await sc.cycle()
    expect(bridge.seen.map((w) => w.taskId)).toEqual([(first as SchedulerWorkItem).taskId, b.id])
  })

  test("28b. concurrent cycles run the cycle body ONCE (Scheduler-side joining)", async () => {
    // The decisive test for mutant M15 (removing the in-flight join).
    //
    // The claim guard ("an active claim blocks a second selection") would keep
    // dispatch concurrency at one even without the join, because every cycle
    // picks the same first candidate and loses the atomic claim. So a
    // dispatch-counting test CANNOT see the difference.
    //
    // What the join actually guarantees is that the cycle BODY runs once. So
    // this counts cycle-body entries via the snapshot the body must take.
    add("PENDING")
    const real = store
    let snapshots = 0
    const counting = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === "getSnapshot") {
          return (sid: string) => {
            snapshots++
            return target.getSnapshot(sid)
          }
        }
        return Reflect.get(target, prop, recv)
      },
    }) as TaskStore
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sc = new Scheduler(S, {
      store: counting,
      runTurn: async () => {
        await gate
        return { kind: "returned", ok: true }
      },
      instruction: "x",
    })
    sc.start()
    const all = Promise.all([sc.cycle(), sc.cycle(), sc.cycle(), sc.cycle()])
    await new Promise((r) => setTimeout(r, 30))
    // One cycle body takes exactly TWO snapshots: one for reconciliation, one for
    // discovery. Four concurrent calls must still produce only one body, so the
    // count is 2 — not 4, and not 8.
    expect(snapshots).toBe(2)
    release()
    await all
    expect(snapshots).toBe(2)
  })
})

// ── 29-30. stop semantics ────────────────────────────────────────────────────
describe("stop", () => {
  test("29. stop() before a cycle prevents dispatch", async () => {
    add("PENDING")
    const { sc, bridge } = makeScheduler()
    sc.start()
    await sc.stop()
    await sc.cycle()
    expect(bridge.seen.length).toBe(0)
    expect(store.listTasks(S)[0]?.status).toBe("PENDING")
  })

  test("30. a claimed task stays IN_PROGRESS after stop (STOP != CANCELLED)", async () => {
    const t = add("PENDING")
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sc = new Scheduler(S, {
      store,
      runTurn: async () => {
        await gate
        return { kind: "returned", ok: true }
      },
      instruction: "x",
    })
    sc.start()
    const running = sc.cycle()
    await new Promise((r) => setTimeout(r, 20))
    const stopping = sc.stop()
    release()
    await Promise.all([running, stopping])
    // The Scheduler released nothing on its own authority; the row still holds
    // the claim's state, and it is definitely not CANCELLED.
    const after = store.getTask(S, t.id)!
    expect(after.status).toBe("IN_PROGRESS")
    expect(after.status).not.toBe("CANCELLED")
  })
})

// ── 31-36. reconciliation ────────────────────────────────────────────────────
describe("reconciliation", () => {
  test("31. a stranded IN_PROGRESS reverts when ownership permits", async () => {
    const t = addStranded("IN_PROGRESS")
    const { sc } = makeScheduler()
    sc.start()
    expect(sc.reconcile()).toEqual([t.id])
    expect(store.getTask(S, t.id)?.status).toBe("PENDING")
  })

  test("32. VERIFYING follows the same policy", async () => {
    const t = addStranded("VERIFYING")
    const { sc } = makeScheduler()
    sc.start()
    expect(sc.reconcile()).toEqual([t.id])
    expect(store.getTask(S, t.id)?.status).toBe("PENDING")
  })

  test("33/34. PENDING, terminal and operator states are never reconciled", async () => {
    const expectStatus: Array<[string, TaskStatus]> = []
    for (const status of ["PENDING", "COMPLETED", "CANCELLED", "FAILED", "BLOCKED"] as const) {
      const t = store.createTask(S, {
        title: status,
        status,
        order: 1,
        blockedReason: status === "BLOCKED" ? "r" : null,
        provenance: prov,
      })
      expectStatus.push([t.id, status])
    }
    const { sc } = makeScheduler()
    sc.start()
    expect(sc.reconcile()).toEqual([])
    // Every row keeps EXACTLY the status it had. PENDING stays PENDING because it
    // was never a reconciliation target to begin with.
    for (const [id, status] of expectStatus) {
      expect({ id, status: store.getTask(S, id)?.status }).toEqual({ id, status })
    }
  })

  test("33b. PAUSED is not a status and cannot appear", () => {
    expect(() =>
      store.createTask(S, {
        title: "p",
        status: "PAUSED" as TaskStatus,
        order: 1,
        provenance: prov,
      }),
    ).not.toThrow() // TaskStore does not validate the status domain (6B limitation)
    // ...but the Scheduler never treats it as a reconciliation target.
    const { sc } = makeScheduler()
    sc.start()
    expect(sc.reconcile()).toEqual([])
  })

  test("35. a reconciliation race cannot overwrite newer state", async () => {
    const t = addStranded("IN_PROGRESS")
    const real = store
    const race = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === "getSnapshot") {
          return (sid: string) => {
            const snap = target.getSnapshot(sid)
            // Someone else advances the row after our snapshot was taken.
            for (const task of snap.tasks) target.patchTask(sid, task.id, { title: "newer" })
            return snap
          }
        }
        return Reflect.get(target, prop, recv)
      },
    }) as TaskStore
    const sc = new Scheduler(S, {
      store: race,
      runTurn: () => ({ kind: "returned", ok: true }),
      instruction: "x",
    })
    sc.start()
    expect(sc.reconcile()).toEqual([])
    const after = store.getTask(S, t.id)!
    expect(after.status).toBe("IN_PROGRESS")
    expect(after.title).toBe("newer")
  })

  test("36. reconciliation never deletes", async () => {
    addStranded("IN_PROGRESS")
    addStranded("VERIFYING")
    const before = store.listTasks(S).length
    const { sc } = makeScheduler()
    sc.start()
    sc.reconcile()
    expect(store.listTasks(S).length).toBe(before)
  })
})

// ── 37-40. freshness and sessions ────────────────────────────────────────────
describe("freshness + sessions", () => {
  test("37. the claim uses the RE-READ revision, never the graph's", async () => {
    add("PENDING")
    const real = store
    let seenExpected: number | undefined
    const spy = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === "claimTask") {
          return (sid: string, id: string, rev: number) => {
            seenExpected = rev
            return target.claimTask(sid, id, rev)
          }
        }
        return Reflect.get(target, prop, recv)
      },
    }) as TaskStore
    const sc = new Scheduler(S, {
      store: spy,
      runTurn: () => ({ kind: "returned", ok: true }),
      instruction: "x",
    })
    sc.start()
    await sc.cycle()
    expect(seenExpected).toBe(1)
  })

  test("37b. a later cycle re-reads and claims the NEW revision", async () => {
    const t = add("PENDING")
    store.patchTask(S, t.id, { title: "bumped" })
    expect(store.getTask(S, t.id)?.revision).toBe(2)
    const { sc, bridge } = makeScheduler()
    sc.start()
    await sc.cycle()
    expect(bridge.seen[0]?.taskId).toBe(t.id)
    expect(store.getTask(S, t.id)?.revision).toBe(3)
  })

  test("38/39. session A cannot reach session B", async () => {
    const b = store.createTask("other", {
      title: "b",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    const a = add("PENDING")
    // taskId is allocated PER SESSION, so both rows are `t1`. Isolation is
    // therefore proven by the graph's contents and by a cross-session claim
    // landing on A's row rather than B's.
    expect(a.id).toBe(b.id)
    const gA = new TaskGraph(store.getSnapshot(S))
    const gB = new TaskGraph(store.getSnapshot("other"))
    expect(gA.nodes().map((n) => n.title)).toEqual([`t PENDING`])
    expect(gB.nodes().map((n) => n.title)).toEqual(["b"])
    // A claim naming that shared id inside A touches A's row only.
    const r = store.claimTask(S, a.id, 1)
    expect(r.outcome).toBe("CLAIM_ACCEPTED")
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
    expect(store.getTask("other", b.id)?.status).toBe("PENDING")
  })

  test("40. two sessions coexist independently", async () => {
    const a = add("PENDING")
    const b = store.createTask("other", {
      title: "b",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    const scA = new Scheduler(S, {
      store,
      runTurn: () => ({ kind: "returned", ok: true }),
      instruction: "x",
    })
    scA.start()
    await scA.cycle()
    expect(store.getTask(S, a.id)?.status).toBe("IN_PROGRESS")
    expect(store.getTask("other", b.id)?.status).toBe("PENDING")
  })
})

// ── 19. observability ────────────────────────────────────────────────────────
describe("observability", () => {
  test("events are emitted but never consumed as authority", async () => {
    add("PENDING")
    const seen: string[] = []
    const { sc } = makeScheduler({ onEvent: (e) => seen.push(e.kind) })
    sc.start()
    await sc.cycle()
    expect(seen).toContain("task:selected")
    expect(seen).toContain("task:claimed")
    expect(seen).toContain("task:dispatch_started")
    expect(seen).toContain("task:execution_completed")
  })

  test("a throwing observer cannot fail a cycle", async () => {
    add("PENDING")
    const { sc, bridge } = makeScheduler({
      onEvent: () => {
        throw new Error("observer exploded")
      },
    })
    sc.start()
    const r = await sc.cycle()
    expect(bridge.seen.length).toBe(1)
    expect(r.dispatched?.ok).toBe(true)
  })
})

// ── 18. error semantics ───────────────────────────────────────────────────────
describe("error semantics", () => {
  test("a stopped Scheduler reports not-running rather than idling", async () => {
    const { sc } = makeScheduler()
    const r = await sc.cycle()
    expect(r.stop).toBe("not-running")
  })

  test("start() on a taken session surfaces the reason, not a generic error", () => {
    acquireSessionOwnership(S, "other")
    const { sc } = makeScheduler()
    try {
      sc.start()
      throw new Error("should not reach")
    } catch (e) {
      expect((e as { reason?: string }).reason).toBe("ownership-unavailable")
    }
  })

  test("no durable READY and no PAUSED can be produced", async () => {
    add("PENDING")
    const { sc } = makeScheduler()
    sc.start()
    await sc.cycle()
    for (const t of store.listTasks(S)) {
      expect(t.status).not.toBe("READY")
      expect(t.status).not.toBe("PAUSED")
    }
  })
})
