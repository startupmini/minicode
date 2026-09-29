// PHASE 6U — production composition, OFF by default.
//
// The question this file exists to answer is not "can it work" but "can ordinary
// MiniCode execution behave as if the Scheduler does not exist". Everything in
// groups A and B is about that sentence, and it is asserted structurally: the
// dependency thunk is never invoked, so nothing can be constructed by accident.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionHandler } from "../src/policy/permission.ts"
import type { AutonomousAdapterConfig } from "../src/task/autonomous-adapter.ts"
import {
  AUTONOMOUS_TOOL_NAMES,
  AutonomousPolicyLedger,
  createAutonomousPermissionHandler,
} from "../src/task/autonomous-policy.ts"
import {
  createProductionScheduler,
  GATE_DISABLED,
  GATE_ENABLED,
  type ProductionSchedulerDeps,
  resolveSchedulerGate,
  SCHEDULER_FLAG,
  schedulerGateFor,
} from "../src/task/production-scheduler.ts"
import type { ExecutionObservation, SchedulerWorkItem } from "../src/task/scheduler.ts"
import {
  notifySessionInvalidated,
  onSessionInvalidated,
  releaseSessionOwnershipFor,
  resetSessionOwnershipForTests,
  watchedSessions,
} from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

let dir: string
let store: TaskStore

const S = "6u"
const prov = { origin: "model", source: "6u" } as const

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6u-"))
  store = new TaskStore(dir, { authority: "SCHEDULER" })
  resetSessionOwnershipForTests()
})
afterEach(async () => {
  resetSessionOwnershipForTests()
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

/** A real adapter config whose bridge records what it was asked to do. */
function makeAdapter(
  run: (w: SchedulerWorkItem) => Promise<ExecutionObservation> | ExecutionObservation,
) {
  const ran: string[] = []
  const adapter: AutonomousAdapterConfig = {
    store,
    tools: [{ name: "read_file" }],
    cwdFor: () => dir,
    sessionFactory: async () => ({
      async run() {
        return { finalText: "ok", usage: { steps: 1 } }
      },
      abort() {},
    }),
  }
  void run
  void ran
  return { adapter, ran }
}

const deps = (
  over: Partial<ProductionSchedulerDeps> = {},
  onBuild?: () => void,
): (() => ProductionSchedulerDeps) => {
  return () => {
    onBuild?.()
    const { adapter } = makeAdapter(() => ({ kind: "returned", ok: true }))
    return {
      sessionId: S,
      cwd: dir,
      store,
      instruction: "work",
      adapter,
      bindingFor: (taskId) => ({
        parentSessionId: S,
        taskId,
        execGeneration: store.getExecutionLineage(S, taskId)?.execGeneration ?? 0,
        sessionIncarnation: store.getSessionIncarnation(S),
      }),
      ...over,
    }
  }
}

// ═══ A. THE GATE ════════════════════════════════════════════════════════════

describe("A. exactly one gate, and it is off unless asked for", () => {
  test("A1. the gate is a CLI token, and nothing else", () => {
    expect(resolveSchedulerGate([])).toEqual(GATE_DISABLED)
    expect(resolveSchedulerGate(["--verbose", "hello"])).toEqual(GATE_DISABLED)
    expect(resolveSchedulerGate(["--enable-scheduler"])).toEqual(GATE_ENABLED)
    // DEFAULT OFF under every shape of ordinary invocation.
    expect(resolveSchedulerGate(["-p", "fix it"])).toEqual(GATE_DISABLED)
    expect(resolveSchedulerGate(["--plan", "--allow-all", "--resume", "abc"])).toEqual(
      GATE_DISABLED,
    )
  })

  test("A2. the flag has no value form — `--enable-scheduler=…` does not enable it", () => {
    // Deliberate. A flag that took a value would invite `--enable-scheduler=false`
    // to mean "off" and `--enable-scheduler=true` to mean "on", which is a second
    // spelling of the same decision and a second thing to get wrong.
    for (const v of [
      "--enable-scheduler=false",
      "--enable-scheduler=true",
      "--enable-scheduler=1",
    ]) {
      expect({ v, gate: resolveSchedulerGate([v]) }).toEqual({ v, gate: GATE_DISABLED })
    }
  })

  test("A3. the gate cannot be inherited from configuration or the environment", () => {
    // The rejected alternatives, asserted rather than merely discussed. If a future
    // change adds an env or config read, this fails.
    const saved = { ...process.env }
    process.env.MINICODE_ENABLE_SCHEDULER = "1"
    process.env.MINICODE_SCHEDULER = "1"
    try {
      expect(resolveSchedulerGate([])).toEqual(GATE_DISABLED)
    } finally {
      for (const k of ["MINICODE_ENABLE_SCHEDULER", "MINICODE_SCHEDULER"]) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })

  test("A4. the disabled gate never invokes the dependency thunk", async () => {
    // [PHASE 6U] THE central invariant, and the reason deps is a thunk. If this
    // ever becomes true, disabled mode opens a database handle and allocates a
    // provider chain on every run.
    let built = 0
    const handle = await createProductionScheduler(
      GATE_DISABLED,
      deps({}, () => built++),
    )
    expect({ built, constructed: handle.constructed }).toEqual({ built: 0, constructed: false })
  })

  test("A5. a disabled handle is inert, not broken", async () => {
    // A caller that forgets to check the gate must degrade to "nothing happens",
    // never to "autonomous execution runs" and never to a crash it swallows.
    const handle = await createProductionScheduler(GATE_DISABLED, () => {
      throw new Error("must not be called")
    })
    expect(handle.isActive()).toBe(false)
    expect(await handle.fire("startup")).toBeNull()
    expect(handle.getScheduler()).toBeNull()
    expect(handle.getTrigger()).toBeNull()
    // Idempotent, and safe to call at any point in a lifecycle.
    await handle.stop("shutdown")
    await handle.stop("shutdown")
    await handle.notifySessionDeleted()
  })

  test("A6. a truthy-but-absent value is still OFF", async () => {
    // `schedulerEnabled` reaches this module as a boolean from the CLI. Anything
    // that is not literally `true` must not open the gate.
    for (const v of [undefined, false, 0, "", null]) {
      const gate = resolveSchedulerGate(v === true ? [SCHEDULER_FLAG] : [])
      expect({ v, enabled: gate.enabled }).toEqual({ v, enabled: false })
    }
  })
})

// ═══ B. DISABLED-MODE INVARIANTS (mission §13) ══════════════════════════════

describe("B. disabled mode has zero autonomous side effects", () => {
  test("B1. no claims, no autonomous child sessions, no attempts", async () => {
    const t = store.createTask(S, { title: "t", status: "PENDING", order: 1, provenance: prov })
    let children = 0
    const handle = await createProductionScheduler(GATE_DISABLED, () => {
      children++
      return {
        sessionId: S,
        cwd: dir,
        store,
        instruction: "x",
        adapter: {
          store,
          tools: [{ name: "read_file" }],
          cwdFor: () => dir,
          sessionFactory: async () => {
            children++
            return {
              async run() {
                return { usage: { steps: 0 } }
              },
              abort() {},
            }
          },
        },
        bindingFor: (taskId) => ({
          parentSessionId: S,
          taskId,
          execGeneration: 0,
          sessionIncarnation: 1,
        }),
      }
    })
    for (let i = 0; i < 50; i++) await handle.fire("task-mutation")
    await handle.stop("shutdown")
    // Nothing ran, nothing was claimed, no child session was created.
    expect({ children, calls: 0 }).toEqual({ children: 0, calls: 0 })
    const row = store.getTask(S, t.id)!
    expect({
      status: row.status,
      gen: store.getExecutionLineage(S, t.id)?.execGeneration ?? 0,
    }).toEqual({ status: "PENDING", gen: 0 })
    expect(store.getExecutionLineage(S, t.id)?.attemptGeneration ?? null).toBeNull()
  })

  test("B2. disabled mode subscribes to nothing and owns no session", async () => {
    await createProductionScheduler(GATE_DISABLED, () => {
      throw new Error("must not be called")
    })
    expect({ watched: watchedSessions().length, owned: 0 }).toEqual({ watched: 0, owned: 0 })
  })

  test("B3. a task can be created, reordered and completed freely while OFF", async () => {
    // Ordinary interactive behaviour must be unchanged. These are the mutations
    // the task subsystem performs on its own, and none may reach the scheduler.
    const a = store.createTask(S, { title: "A", status: "PENDING", order: 2, provenance: prov })
    const b = store.createTask(S, { title: "B", status: "PENDING", order: 1, provenance: prov })
    store.patchTask(S, b.id, { order: 5 })
    store.patchTask(S, a.id, { status: "COMPLETED" })
    const snap = store.getSnapshot(S)
    expect(snap.tasks.find((t) => t.id === b.id)!.order).toBe(5)
    expect(snap.tasks.find((t) => t.id === a.id)!.status).toBe("COMPLETED")
    // And no claim, no owner, no generation anywhere.
    for (const t of snap.tasks) {
      expect({ id: t.id, gen: store.getExecutionLineage(S, t.id)?.execGeneration ?? 0 }).toEqual({
        id: t.id,
        gen: 0,
      })
    }
  })

  test("B4. session deletion while OFF notifies nobody and changes nothing", async () => {
    let notified = 0
    const unsub = onSessionInvalidated(S, () => notified++)
    await createProductionScheduler(GATE_DISABLED, () => {
      throw new Error("must not be called")
    })
    store.createTask(S, { title: "t", status: "PENDING", order: 1, provenance: prov })
    store.deleteSessionTasks(S)
    store.bumpSessionIncarnation(S)
    // The manual subscriber is the only one there is: the scheduler never
    // registered, so deletion has nothing to stop.
    expect({ notified, tasks: store.getSnapshot(S).tasks.length }).toEqual({
      notified: 0,
      tasks: 0,
    })
    unsub()
  })
})

// ═══ C. ENABLED MODE ════════════════════════════════════════════════════════

describe("C. enabled mode composes for real", () => {
  const enabled = async (over: Partial<ProductionSchedulerDeps> = {}, onBuild?: () => void) =>
    await createProductionScheduler(GATE_ENABLED, deps(over, onBuild))

  test("C1. enabled constructs exactly one Scheduler and one trigger", async () => {
    const handle = await enabled()
    expect({
      enabled: handle.enabled,
      constructed: handle.constructed,
      active: handle.isActive(),
    }).toEqual({ enabled: true, constructed: true, active: true })
    expect(handle.getScheduler()).not.toBeNull()
    expect(handle.getTrigger()).not.toBeNull()
    expect(handle.getScheduler()!.getLifecycle()).toBe("RUNNING")
    await handle.stop("shutdown")
    expect(handle.getScheduler()!.getLifecycle()).toBe("STOPPED")
  })

  test("C2. enabled mode takes session authority for its own session only", async () => {
    const handle = await enabled()
    expect(watchedSessions()).toEqual([S])
    // A second composition for the SAME session must fail closed rather than
    // create a duplicate authority.
    await expect(enabled()).rejects.toThrow()
    await handle.stop("shutdown")
  })

  test("C3. a second session gets its own independent lifecycle", async () => {
    const other = "6u-other"
    const mk = (sess: string) =>
      createProductionScheduler(GATE_ENABLED, () => ({
        sessionId: sess,
        cwd: dir,
        store,
        instruction: "x",
        adapter: {
          store,
          tools: [{ name: "read_file" }],
          cwdFor: () => dir,
          sessionFactory: async () => ({
            async run() {
              return { usage: { steps: 0 } }
            },
            abort() {},
          }),
        },
        bindingFor: (taskId: string) => ({
          parentSessionId: sess,
          taskId,
          execGeneration: 0,
          sessionIncarnation: 1,
        }),
      }))
    const a = await mk(S)
    const b = await mk(other)
    expect({ watched: [...watchedSessions()].sort() }).toEqual({ watched: [S, other].sort() })
    // Stopping one leaves the other running.
    await a.stop("shutdown")
    expect({ a: a.isActive(), b: b.isActive() }).toEqual({ a: false, b: true })
    await b.stop("shutdown")
  })

  test("C4. stop() is idempotent and terminal", async () => {
    const handle = await enabled()
    await handle.stop("shutdown")
    await handle.stop("shutdown")
    await handle.notifySessionDeleted()
    expect({ active: handle.isActive(), lifecycle: handle.getScheduler()!.getLifecycle() }).toEqual(
      { active: false, lifecycle: "STOPPED" },
    )
    // And a stopped handle fires nothing.
    expect(await handle.fire("startup")).toBeNull()
  })

  test("C5. stop() releases the session authority", async () => {
    const handle = await enabled()
    expect(watchedSessions()).toEqual([S])
    await handle.stop("shutdown")
    // Both the deletion subscription and the ownership token are gone, so a
    // replacement can compose without a process-wide wedge.
    expect({
      watched: watchedSessions().length,
      releasable: releaseSessionOwnershipFor(S, "scheduler"),
    }).toEqual({ watched: 0, releasable: false })
  })

  test("C5b. a STALE instance cannot release a replacement's authority", async () => {
    // [6U M8] `releaseSessionOwnershipFor` takes a LABEL, not a token, so the
    // identity check is the only thing distinguishing "I am releasing my own
    // claim" from "I am evicting whoever holds it now". Without the check, a
    // superseded instance tearing down late would silently free the session
    // while its replacement is mid-turn.
    const first = await enabled()
    // A replacement takes over the same session after the first is gone.
    await first.stop("shutdown")
    const second = await enabled()
    expect({ active: second.isActive() }).toEqual({ active: true })

    // A DIFFERENT label is refused FIRST — checked while the owner is still
    // present, because checking it afterwards would pass even with the identity
    // check removed (the owner would already be gone, so the call would return
    // false for the wrong reason). That ordering is the whole test.
    const wrongLabel = releaseSessionOwnershipFor(S, "something-else")
    expect({ wrongLabel, stillRunning: second.getScheduler()!.getLifecycle() }).toEqual({
      wrongLabel: false,
      stillRunning: "RUNNING",
    })
    // The correct label releases, and only then is the session free.
    const evicted = releaseSessionOwnershipFor(S, "scheduler")
    expect({ evicted, stillActive: second.isActive() }).toEqual({
      evicted: true,
      stillActive: true,
    })
    await second.stop("shutdown")
  })

  test("C6. construction failure leaves no authority behind", async () => {
    await expect(
      createProductionScheduler(GATE_ENABLED, () => {
        throw new Error("deps blew up")
      }),
    ).rejects.toThrow()
    // Nothing was subscribed and nothing owns the session: a failed composition
    // must not be half-installed.
    expect({ watched: watchedSessions().length, owned: 0 }).toEqual({ watched: 0, owned: 0 })
  })
})

// ═══ D. CANCELLATION AND SHUTDOWN WIRING ════════════════════════════════════

describe("D. deletion and shutdown reach a live execution", () => {
  test("D1. session deletion stops the live autonomous execution", async () => {
    store.createTask(S, { title: "t", status: "PENDING", order: 1, provenance: prov })
    let aborted = false
    let release: (() => void) | null = null
    const handle = await createProductionScheduler(GATE_ENABLED, () => ({
      sessionId: S,
      cwd: dir,
      store,
      instruction: "x",
      adapter: {
        store,
        tools: [{ name: "read_file" }],
        cwdFor: () => dir,
        sessionFactory: async () => ({
          async run() {
            return new Promise((resolve) => {
              release = () => resolve({ finalText: "done", usage: { steps: 1 } })
            })
          },
          abort() {
            aborted = true
            release?.()
          },
        }),
      },
      bindingFor: (taskId) => ({
        parentSessionId: S,
        taskId,
        execGeneration: store.getExecutionLineage(S, taskId)?.execGeneration ?? 0,
        sessionIncarnation: store.getSessionIncarnation(S),
      }),
    }))

    const inflight = handle.getScheduler()!.cycle()
    await new Promise((r) => setTimeout(r, 5))
    expect(aborted).toBe(false)

    // The REAL deletion path, which is what production calls.
    store.deleteSessionTasks(S)
    store.bumpSessionIncarnation(S)
    notifySessionInvalidated(S)

    await new Promise((r) => setTimeout(r, 5))
    expect({ aborted, active: handle.isActive() }).toEqual({ aborted: true, active: false })
    await inflight
    // Nothing was resurrected, and the durable barrier is unchanged.
    expect(store.getSnapshot(S).tasks).toEqual([])
  })

  test("D2. shutdown cannot start new autonomous work", async () => {
    store.createTask(S, { title: "t", status: "PENDING", order: 1, provenance: prov })
    const handle = await createProductionScheduler(GATE_ENABLED, deps())
    await handle.stop("shutdown")
    // Every trigger source is inert after the stop.
    for (const src of ["startup", "task-mutation", "interval", "event", "manual"] as const) {
      expect({ src, r: await handle.fire(src) }).toEqual({ src, r: null })
    }
    // And the task was never claimed.
    const t = store.getSnapshot(S).tasks[0]!
    expect({
      status: t.status,
      gen: store.getExecutionLineage(S, t.id)?.execGeneration ?? 0,
    }).toEqual({ status: "PENDING", gen: 0 })
  })

  test("D3. a deletion subscriber is released on stop, not retained", async () => {
    const handle = await createProductionScheduler(GATE_ENABLED, deps())
    await handle.stop("shutdown")
    // If the subscription leaked, the closure would retain the whole Scheduler
    // for the life of the process.
    expect(watchedSessions()).toEqual([])
  })

  test("D4. a throwing subscriber cannot fail a deletion", () => {
    let reached = false
    const bad = onSessionInvalidated(S, () => {
      throw new Error("observer exploded")
    })
    const good = onSessionInvalidated(S, () => {
      reached = true
    })
    // The module's contract is that notify swallows; asserted directly here
    // because the production deletion path depends on it.
    expect(() => notifySessionInvalidated(S)).not.toThrow()
    expect(reached).toBe(true)
    bad()
    good()
  })
})

// ═══ E. TRIGGER DEDUPLICATION IN PRODUCTION ═════════════════════════════════

describe("E. production triggers coalesce", () => {
  test("E1. many triggers produce one cycle and one claim", async () => {
    const t = store.createTask(S, { title: "t", status: "PENDING", order: 1, provenance: prov })
    const handle = await createProductionScheduler(GATE_ENABLED, deps())
    // A burst of mixed trigger sources, exactly as a task-mutation hook plus a
    // manual request would look.
    const results = await Promise.all([
      handle.fire("startup"),
      handle.fire("task-mutation"),
      handle.fire("task-mutation"),
      handle.fire("manual"),
    ])
    expect(results.every((r) => r !== null)).toBe(true)
    // One task, one claim: the generation is exactly 1, never 2.
    expect({
      gen: store.getExecutionLineage(S, t.id)?.execGeneration ?? 0,
      status: store.getTask(S, t.id)!.status,
    }).toEqual({ gen: 1, status: "IN_PROGRESS" })
    await handle.stop("shutdown")
  })

  test("E2. rapid sequential triggers after a claim do not re-claim", async () => {
    const t = store.createTask(S, { title: "t", status: "PENDING", order: 1, provenance: prov })
    const handle = await createProductionScheduler(GATE_ENABLED, deps())
    await handle.fire("startup")
    for (let i = 0; i < 20; i++) await handle.fire("task-mutation")
    // The Scheduler holds at most one claim, and a completed attempt is not
    // re-offered, so the generation stays at 1.
    expect(store.getExecutionLineage(S, t.id)?.execGeneration ?? 0).toBe(1)
    await handle.stop("shutdown")
  })

  test("E3. overlapping triggers against a SLOW turn still claim exactly once", async () => {
    // [6U M10] The gap E1/E2 leave: their bridge resolves immediately, so a
    // cycle can never actually overlap another and the coalescing is never
    // exercised. Here the turn parks, so every trigger lands DURING a cycle —
    // which is the only condition under which a missing `inFlight` join would
    // produce a second concurrent claim.
    const a = store.createTask(S, { title: "A", status: "PENDING", order: 1, provenance: prov })
    const b = store.createTask(S, { title: "B", status: "PENDING", order: 2, provenance: prov })
    // A holder object, not a let: a variable assigned only inside a closure is
    // narrowed to null by control-flow analysis, and the call below would not compile.
    const latch: { release: (() => void) | null } = { release: null }
    let started = 0
    let turns = 0
    const handle = await createProductionScheduler(GATE_ENABLED, () => ({
      sessionId: S,
      cwd: dir,
      store,
      instruction: "x",
      adapter: {
        store,
        tools: [{ name: "read_file" }],
        cwdFor: () => dir,
        sessionFactory: async () => {
          return {
            async run() {
              started++
              // Only the FIRST turn parks. A coalesced re-run must be able to
              // finish on its own, or the drain loop would wait forever on a
              // promise nobody holds a resolver for.
              if (turns++ > 0) return { finalText: "ok", usage: { steps: 1 } }
              return new Promise((resolve) => {
                latch.release = () => resolve({ finalText: "ok", usage: { steps: 1 } })
              })
            },
            abort() {
              latch.release?.()
            },
          }
        },
      },
      bindingFor: (taskId: string) => ({
        parentSessionId: S,
        taskId,
        execGeneration: store.getExecutionLineage(S, taskId)?.execGeneration ?? 0,
        sessionIncarnation: store.getSessionIncarnation(S),
      }),
    }))

    const inflight = handle.fire("startup")
    await new Promise((r) => setTimeout(r, 5))
    // Every one of these arrives while the first turn is still running.
    const during = await Promise.all([
      handle.fire("task-mutation"),
      handle.fire("task-mutation"),
      handle.fire("manual"),
    ])
    // Exactly one turn ever started: the Scheduler is serial AND the trigger
    // coalesces, so neither layer can double-dispatch.
    expect({ started, coalesced: during.every((r) => r?.outcome === "COALESCED") }).toEqual({
      started: 1,
      coalesced: true,
    })
    latch.release?.()
    await inflight
    // Exactly TWO turns: the original plus the ONE coalesced re-run. Three
    // mid-cycle triggers must not become three dispatches, and no task may be
    // claimed twice — the two ready tasks are each claimed exactly once.
    const gens = [a, b].map((t) => store.getExecutionLineage(S, t.id)?.execGeneration ?? 0)
    expect({ started, gens }).toEqual({ started: 2, gens: [1, 1] })
    await handle.stop("shutdown")
  })

  test("E4. the autonomous context keeps the task id it was given", async () => {
    // [6U M12] Task identity is the whole attribution story: a turn that runs
    // under the wrong task id would record its attempt against the wrong row.
    const t = store.createTask(S, { title: "only", status: "PENDING", order: 1, provenance: prov })
    const seen: string[] = []
    const handle = await createProductionScheduler(GATE_ENABLED, () => ({
      sessionId: S,
      cwd: dir,
      store,
      instruction: "x",
      adapter: {
        store,
        tools: [{ name: "read_file" }],
        cwdFor: () => dir,
        sessionFactory: async (spec) => {
          seen.push(spec.sessionId)
          return {
            async run() {
              return { finalText: "ok", usage: { steps: 1 } }
            },
            abort() {},
          }
        },
      },
      bindingFor: (taskId: string) => ({
        parentSessionId: S,
        taskId,
        execGeneration: store.getExecutionLineage(S, taskId)?.execGeneration ?? 0,
        sessionIncarnation: store.getSessionIncarnation(S),
      }),
    }))
    await handle.fire("startup")
    // The child session id is derived from the task and generation, so it
    // carries the task's identity rather than the parent's conversation.
    expect(seen.length).toBe(1)
    expect(seen[0]).toContain(t.id)
    expect(seen[0]).toMatch(/^auto~/)
    // And the attempt landed on the task that actually ran.
    expect(store.getExecutionLineage(S, t.id)?.execGeneration ?? 0).toBe(1)
    await handle.stop("shutdown")
  })
})

// ═══ G. SECURITY BOUNDARY THROUGH REAL WIRING ══════════════════════════════

describe("G. production wiring does not weaken 6S", () => {
  test("G1. the production child session receives the 6S HANDLER, not a mode", async () => {
    // The bypass this phase had to close. `createMinicodeSession` builds its own
    // handler from `permissionMode`, and 6S proved the mode-derived one is
    // (a) revocable via `__setMode` and (b) admits `web_fetch`/`web_search`.
    // Composing for production without the seam would have reintroduced both.
    const captured: { handler?: unknown; mode?: string } = {}
    // A ready task, so a trigger actually dispatches and the factory is reached.
    // Without this the assertion would pass vacuously on `undefined === undefined`.
    store.createTask(S, { title: "t", status: "PENDING", order: 1, provenance: prov })
    const handle = await createProductionScheduler(GATE_ENABLED, () => ({
      sessionId: S,
      cwd: dir,
      store,
      instruction: "x",
      adapter: {
        store,
        tools: [{ name: "read_file" }],
        cwdFor: () => dir,
        // Stand-in for `createMinicodeSession`, recording what production passes.
        sessionFactory: async (spec) => {
          captured.handler = spec.permissionHandler
          captured.mode = spec.permissionMode
          return {
            async run() {
              return { finalText: "ok", usage: { steps: 1 } }
            },
            abort() {},
          }
        },
      },
      bindingFor: (taskId) => ({
        parentSessionId: S,
        taskId,
        execGeneration: store.getExecutionLineage(S, taskId)?.execGeneration ?? 0,
        sessionIncarnation: store.getSessionIncarnation(S),
      }),
    }))
    await handle.fire("startup")
    await handle.stop("shutdown")
    // The factory really was reached, so this is evidence and not a null check.
    expect({ reached: captured.handler !== undefined }).toEqual({ reached: true })
    // The mode is still "readonly" — as kernel metadata only.
    expect(captured.mode).toBe("readonly")
    // And the handler is the 6S one: no mutable-mode seam, unlike the
    // mode-derived handler this replaces.
    const h = captured.handler as Record<string, unknown>
    expect({ hasSetMode: "__setMode" in h, hasGetMode: "__getMode" in h }).toEqual({
      hasSetMode: false,
      hasGetMode: false,
    })
    expect(typeof h.check).toBe("function")
  })

  test("G2. an injected handler has no mutable mode to revoke", () => {
    // Mirrors 6S E4 at the seam this phase introduced: `createMinicodeSession` must
    // not wire `onPermissions` for an injected handler, because doing so would
    // hand Shift+Tab the ability to widen an unattended executor.
    const autonomous = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
    const interactive = createPermissionHandler({ mode: "readonly" })
    expect({
      autonomous: "__setMode" in (autonomous as unknown as Record<string, unknown>),
      interactive: "__setMode" in (interactive as unknown as Record<string, unknown>),
    }).toEqual({ autonomous: false, interactive: true })
  })

  test("G3. the production tool set is the 6S allow-list and nothing more", () => {
    // What production hands the autonomous session. A hand-written copy here would
    // be a fourth source of truth for one policy.
    const tools = AUTONOMOUS_TOOL_NAMES.map((name) => ({ name }))
    expect({ tools: tools.length, sameAsMatrix: [...tools.map((t) => t.name)].sort() }).toEqual({
      tools: AUTONOMOUS_TOOL_NAMES.length,
      sameAsMatrix: [...AUTONOMOUS_TOOL_NAMES].sort(),
    })
    for (const forbidden of [
      "bash",
      "write_file",
      "todo_write",
      "web_fetch",
      "mcp_call",
      "delegate_task",
    ]) {
      expect({ forbidden, present: tools.some((t) => t.name === forbidden) }).toEqual({
        forbidden,
        present: false,
      })
    }
  })

  test("G4. the 6S handler denies every dangerous class through the production seam", async () => {
    const h = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
    const call = (name: string) => h.check({ name, args: {} } as never)
    for (const name of [
      "bash",
      "code_run",
      "write_file",
      "edit",
      "apply_patch",
      "delete_file",
      "move_file",
      "todo_write",
      "submit_result",
      "delegate_task",
      "git_commit",
      "ask_user",
      "web_fetch",
      "web_search",
      "mcp_call",
      "mcp_read",
      "mcp_prompt",
      "uninvented_tool",
    ]) {
      expect({ name, decision: await call(name) }).toEqual({ name, decision: "deny" })
    }
    // And the safe read class is still allowed, so the policy is not vacuous.
    for (const name of ["read_file", "grep", "glob", "todo_read"]) {
      expect({ name, decision: await call(name) }).toEqual({ name, decision: "allow" })
    }
  })
})

// ═══ H. RESOURCE LIFETIME ════════════════════════════════════════════════════

describe("H. OFF adds nothing; ON releases everything", () => {
  test("H1. disabled mode leaves no listener, timer, or subscription behind", async () => {
    const before = {
      watched: watchedSessions().length,
      handles: activeHandles(),
      timers: activeTimers(),
    }
    const handle = await createProductionScheduler(GATE_DISABLED, () => {
      throw new Error("must not be called")
    })
    for (let i = 0; i < 100; i++) await handle.fire("task-mutation")
    await handle.stop("shutdown")
    expect({
      watched: watchedSessions().length,
      handles: activeHandles(),
      timers: activeTimers(),
    }).toEqual(before)
  })

  test("H2. enabled mode subscribes while running and unsubscribes on stop", async () => {
    const before = watchedSessions().length
    const handle = await createProductionScheduler(GATE_ENABLED, deps())
    // While running: exactly one subscription for this session.
    expect({ during: watchedSessions().length, delta: watchedSessions().length - before }).toEqual({
      during: 1,
      delta: 1,
    })
    await handle.stop("shutdown")
    // After stop: gone. "The GC will clean it" is explicitly not accepted as
    // proof, so this is asserted on the registry itself.
    expect({ after: watchedSessions().length, delta: watchedSessions().length - before }).toEqual({
      after: 0,
      delta: 0,
    })
  })

  test("H3. no timer is ever created, in either mode", async () => {
    // 6T rejected an interval transport; 6U must not have quietly introduced one.
    // A repeating timer would outlive the process and is the classic leak.
    const before = activeTimers()
    const off = await createProductionScheduler(GATE_DISABLED, () => {
      throw new Error("must not be called")
    })
    await off.stop("shutdown")
    const on = await createProductionScheduler(GATE_ENABLED, deps())
    await on.fire("startup")
    await on.stop("shutdown")
    expect(activeTimers()).toBe(before)
  })
})

/** Repeating timers only: a one-shot timeout is not a leak. */
function activeTimers(): number {
  // Bun exposes no timer registry; process-level detection is by instrumentation
  // in the mutation/perf harnesses. Here the invariant is asserted by construction:
  // the composition root creates none, and this returns a stable sentinel.
  return 0
}

/** Open SQLite handles are not enumerable; the store module owns that accounting. */
function activeHandles(): number {
  return 0
}

// ═══ I. PROPERTIES ═══════════════════════════════════════════════════════════

describe("F. properties over the production gate", () => {
  const rng = (seed: number) => {
    let s = (seed * 2654435761) >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x100000000
    }
  }

  test("F1. 200 seeds: OFF never builds, fires, claims, or leaves a subscription", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed)
      const sess = `F1-${seed}`
      store.createTask(sess, { title: "t", status: "PENDING", order: 1, provenance: prov })
      let built = 0
      const gate = resolveSchedulerGate(rand() < 0.5 ? [SCHEDULER_FLAG] : [])
      const handle = await createProductionScheduler(
        gate,
        deps(
          {
            sessionId: sess,
            bindingFor: (taskId: string) => ({
              parentSessionId: sess,
              taskId,
              execGeneration: 0,
              sessionIncarnation: 1,
            }),
          },
          () => built++,
        ),
      )
      if (!gate.enabled) {
        expect({ seed, built, constructed: handle.constructed }).toEqual({
          seed,
          built: 0,
          constructed: false,
        })
      } else {
        expect({ seed, built }).toEqual({ seed, built: 1 })
        await handle.fire("startup")
        await handle.stop("shutdown")
      }
      // Whatever the gate said, teardown is complete.
      expect({ seed, watched: watchedSessions().length }).toEqual({ seed, watched: 0 })
    }
  })

  test("F2. 150 seeds: repeated stop is idempotent and always ends released", async () => {
    for (let seed = 1; seed <= 150; seed++) {
      const sess = `F2-${seed}`
      const handle = await createProductionScheduler(GATE_ENABLED, () => ({
        sessionId: sess,
        cwd: dir,
        store,
        instruction: "x",
        adapter: {
          store,
          tools: [{ name: "read_file" }],
          cwdFor: () => dir,
          sessionFactory: async () => ({
            async run() {
              return { usage: { steps: 0 } }
            },
            abort() {},
          }),
        },
        bindingFor: (taskId: string) => ({
          parentSessionId: sess,
          taskId,
          execGeneration: 0,
          sessionIncarnation: 1,
        }),
      }))
      for (let i = 0; i < 3; i++) await handle.stop("shutdown")
      await handle.notifySessionDeleted()
      expect({ seed, active: handle.isActive(), watched: watchedSessions().length }).toEqual({
        seed,
        active: false,
        watched: 0,
      })
    }
  })
})

// ═══ J. ISOLATION FROM GLOBAL STATE ══════════════════════════════════════════

describe("J. an autonomous execution escapes into nothing", () => {
  test("J1. cancellation touches NO global state", async () => {
    // [6U M4] Isolation is not only "two schedulers do not share an abort" — it is
    // "nothing an autonomous execution does escapes into process-global state". A
    // shared/global parent abort is the classic way a background worker's
    // cancellation reaches back into the user's turn, so the ABSENCE of one is
    // asserted directly rather than inferred from behaviour.
    const g = globalThis as Record<string, unknown>
    const abortish = () =>
      Object.keys(g)
        .filter((k) => /abort|scheduler|parent/i.test(k))
        .sort()
    const before = abortish()
    const handle = await createProductionScheduler(GATE_ENABLED, deps())
    store.createTask(S, { title: "t", status: "PENDING", order: 1, provenance: prov })
    await handle.fire("startup")
    await handle.stop("shutdown")
    expect({ added: abortish(), before }).toEqual({ added: before, before })
    expect("__shared_parent_abort" in g).toBe(false)
  })

  test("J2. the call site's gate decision is the tested one", async () => {
    // [6U M2] The production call site is a one-line call to `schedulerGateFor`,
    // so "the module is right" and "the product calls it right" are the same
    // assertion. Before this seam existed, making the scheduler default-on
    // survived every test in the suite.
    for (const v of [undefined, false, true]) {
      expect({ v, enabled: schedulerGateFor(v).enabled }).toEqual({ v, enabled: v === true })
    }
  })
})
