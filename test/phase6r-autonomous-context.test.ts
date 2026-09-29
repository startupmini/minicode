// PHASE 6R — autonomous execution context isolation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AutonomousAdapterConfig,
  buildAutonomousRunTurn,
  planAutonomousContext,
  toExecutionObservation,
} from "../src/task/autonomous-adapter.ts"
import {
  AUTONOMOUS_TOOL_NAMES,
  AutonomousContextError,
  AutonomousExecutionContext,
  type AutonomousSession,
  type AutonomousSessionSpec,
  assertAutonomousToolScope,
  assertContextBelongsTo,
  autonomousSessionId,
  isAutonomousSessionId,
  parseAutonomousSessionId,
} from "../src/task/autonomous-context.ts"
import type { Task } from "../src/task/model.ts"
import { Scheduler } from "../src/task/scheduler.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

let dir: string
let store: TaskStore

const S = "6r"
const prov = { origin: "model", source: "6r" } as const

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6r-"))
  store = new TaskStore(dir, { authority: "SCHEDULER" })
  resetSessionOwnershipForTests()
})
afterEach(async () => {
  resetSessionOwnershipForTests()
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

const add = (order = 1): Task =>
  store.createTask(S, { title: `task ${order}`, status: "PENDING", order, provenance: prov })
const claim = (t: Task) => {
  const r = store.claimTask(S, t.id, t.revision)
  if (r.outcome !== "CLAIM_ACCEPTED") throw new Error(`claim rejected: ${r.outcome}`)
  return r
}

/** A recording fake child session. */
function fakeSession(behaviour: {
  onRun?: (
    input: string,
    opts: { signal: AbortSignal },
  ) => Promise<{ finalText?: string; usage: { steps: number } }>
  cleanups?: () => number
  aborts?: () => number
}): {
  session: AutonomousSession
  specs: AutonomousSessionSpec[]
  /** The RECORDING factory - use this one so the spec is captured. */
  factory: (spec: AutonomousSessionSpec) => Promise<AutonomousSession>
  aborted: () => number
  cleaned: () => number
} {
  const specs: AutonomousSessionSpec[] = []
  let aborts = 0
  let cleanups = 0
  const session: AutonomousSession = {
    async run(input, opts) {
      return behaviour.onRun
        ? behaviour.onRun(input, opts)
        : { finalText: "done", usage: { steps: 1 } }
    },
    abort() {
      aborts++
    },
    cleanup() {
      cleanups++
    },
  }
  const factory = async (spec: AutonomousSessionSpec): Promise<AutonomousSession> => {
    specs.push(spec)
    return session
  }
  return {
    session,
    specs,
    /** The RECORDING factory - use this one so the spec is captured. */
    factory,
    aborted: () => aborts,
    cleaned: () => cleanups,
  }
}

const readOnlyTools = AUTONOMOUS_TOOL_NAMES.map((name) => ({ name }))

const baseConfig = (
  factory: (spec: AutonomousSessionSpec) => Promise<AutonomousSession>,
  over: Partial<AutonomousAdapterConfig> = {},
): AutonomousAdapterConfig => ({
  store,
  sessionFactory: factory,
  tools: readOnlyTools,
  cwdFor: () => dir,
  ...over,
})

// ═══ A. IDENTITY ════════════════════════════════════════════════════════════

describe("A. autonomous execution identity", () => {
  test("A1. the child session id is derived and recognisable", () => {
    const id = autonomousSessionId(S, "t1", 1)
    expect(isAutonomousSessionId(id)).toBe(true)
    expect(parseAutonomousSessionId(id)).toEqual({
      parentSessionId: S,
      taskId: "t1",
      execGeneration: 1,
    })
  })

  test("A2. an autonomous id can never collide with an interactive session id", () => {
    // production session ids are 8 hex chars
    for (const interactive of ["a1b2c3d4", "deadbeef", "00000000"]) {
      expect(isAutonomousSessionId(interactive)).toBe(false)
    }
    expect(autonomousSessionId(S, "t1", 1)).not.toBe(autonomousSessionId(S, "t1", 2))
    expect(autonomousSessionId(S, "t1", 1)).not.toBe(autonomousSessionId(S, "t2", 1))
    expect(autonomousSessionId("A", "t1", 1)).not.toBe(autonomousSessionId("B", "t1", 1))
  })

  test("A3. two contexts for the same work have the SAME identity (derived, not allocated)", () => {
    const f = fakeSession({})
    const a = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(f.session ? async () => f.session : async () => f.session),
      ),
    )
    const b = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(async () => f.session),
      ),
    )
    expect(a.childSessionId).toBe(b.childSessionId)
  })

  test("A4. a context refuses a session it does not belong to (fail closed)", () => {
    const f = fakeSession({})
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(async () => f.session),
      ),
    )
    expect(() => assertContextBelongsTo(ctx, "other-session", 1)).toThrow(AutonomousContextError)
    expect(() => assertContextBelongsTo(ctx, S, 99)).toThrow(/incarnation/)
    expect(() => assertContextBelongsTo(ctx, S, 1)).not.toThrow()
  })

  test("A5. a non-autonomous child id is refused", () => {
    const f = fakeSession({})
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(async () => f.session),
      ),
    )
    ;(ctx as unknown as { childSessionId: string }).childSessionId = "a1b2c3d4"
    expect(() => assertContextBelongsTo(ctx, S, 1)).toThrow(/not an autonomous id/)
  })
})

// ═══ B. TOOL / PERMISSION BOUNDARY ══════════════════════════════════════════

describe("B. the autonomous tool scope is structural, not advisory", () => {
  test("B1. the read-only scope is accepted", () => {
    expect(() => assertAutonomousToolScope(AUTONOMOUS_TOOL_NAMES)).not.toThrow()
  })

  test("B2. each forbidden tool is refused by name", () => {
    for (const name of [
      "write_file",
      "edit_file",
      "bash",
      "git_commit",
      "todo_write",
      "delegate_task",
      "submit_result",
      "ask_user",
      "write_memory",
    ]) {
      expect(() => assertAutonomousToolScope([...AUTONOMOUS_TOOL_NAMES, name])).toThrow(
        new RegExp(name),
      )
    }
  })

  test("B3. the error names the explicitly forbidden tools", () => {
    // [PHASE 6S] 6R asserted a literal phrase from the then-current message.
    // The phrase moved when the allow-list became DERIVED from the capability
    // matrix, so the assertion is restated as the property it was protecting:
    // every offending tool is named, whatever the wording around it. Asserting
    // on a fixed string would have pinned 6S to a message it is right to change.
    for (const tool of ["bash", "write_file", "todo_write"]) {
      let msg = ""
      try {
        assertAutonomousToolScope([tool])
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg).toContain(tool)
    }
    // and an unclassified tool is named too, rather than passing silently
    let unknownMsg = ""
    try {
      assertAutonomousToolScope(["brand_new_tool"])
    } catch (e) {
      unknownMsg = (e as Error).message
    }
    expect(unknownMsg).toContain("brand_new_tool")
  })

  test("B4. the factory RECEIVES readonly, never the interactive permission mode", async () => {
    const f = fakeSession({})
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        // an adapter that "inherits" the interactive mode must still be refused
        baseConfig(f.factory, { tools: readOnlyTools }),
      ),
    )
    await ctx.initialize()
    expect(f.specs[0]!.permissionMode).toBe("readonly")
    expect(f.specs[0]!.sessionId).toBe(ctx.childSessionId)
    expect(f.specs[0]!.parentSessionId).toBe(S)
    ctx.dispose()
  })

  test("B5. a wider tool set is refused at ADAPTER construction", () => {
    const f = fakeSession({})
    expect(() =>
      buildAutonomousRunTurn(
        () => ({ parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 }),
        baseConfig(async () => f.session, { tools: [{ name: "bash" }] }),
      ),
    ).toThrow(/read-only/)
  })

  test("B6. the turn prompt never references the user's conversation", async () => {
    let seen = ""
    const f = fakeSession({
      onRun: async (input) => {
        seen = input
        return { finalText: "ok", usage: { steps: 1 } }
      },
    })
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "THE TASK", instruction: "DO THE THING", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(f.factory),
      ),
    )
    const res = await ctx.execute()
    ctx.dispose()
    expect(res.outcome).toBe("returned")
    expect(seen).toContain("DO THE THING")
    // the system extra states the autonomy boundary explicitly
    expect(f.specs[0]!.systemExtra).toContain("AUTONOMOUS execution context")
    expect(f.specs[0]!.systemExtra).toContain("no one to answer a question")
  })
})

// ═══ C. BUSY AND ABORT ISOLATION ════════════════════════════════════════════

describe("C. busy and abort domains are separate from the user's turn", () => {
  test("C1. a user turn and an autonomous turn do not contend", async () => {
    // The kernel's busy slot is per Session object. The user's session and the
    // autonomous child are DIFFERENT objects, so neither can make the other
    // throw `busy`. Proven here with a child that rejects a second concurrent run
    // the way the kernel does.
    let childRunning = false
    const f = fakeSession({
      onRun: async () => {
        if (childRunning) throw new Error("session is already running")
        childRunning = true
        try {
          await new Promise((r) => setTimeout(r, 25))
          return { finalText: "child", usage: { steps: 1 } }
        } finally {
          childRunning = false
        }
      },
    })
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(async () => f.session),
      ),
    )
    // a "user turn" runs concurrently, on its own object, in the same process
    let userDone = false
    const userTurn = new Promise<void>((r) =>
      setTimeout(() => {
        userDone = true
        r()
      }, 5),
    )
    const child = await ctx.execute()
    await userTurn
    ctx.dispose()
    expect(child.outcome).toBe("returned")
    expect(userDone).toBe(true)
  })

  test("C2. cancelling the context does NOT abort anything the caller owns", async () => {
    // [DESIGN DECISION] The context owns its AbortController and exposes no
    // reference to the parent's. A parent's controller is untouched by
    // `cancel()`.
    const parent = new AbortController()
    let childSawAbort = false
    const f = fakeSession({
      onRun: async (_i, opts) =>
        new Promise((resolve) => {
          opts.signal.addEventListener("abort", () => {
            childSawAbort = true
            resolve({ finalText: "cancelled", usage: { steps: 0 } })
          })
        }),
    })
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(async () => f.session),
      ),
    )
    const running = ctx.execute()
    await new Promise((r) => setTimeout(r, 5))
    ctx.cancel("test")
    const res = await running
    ctx.dispose()
    expect(res.outcome).toBe("cancelled")
    expect(res.ok).toBe(false)
    expect(childSawAbort).toBe(true)
    // the parent's abort is untouched - the isolation is real, not nominal
    expect(parent.signal.aborted).toBe(false)
  })

  test("C3. cancellation before the turn is honoured, not raced", async () => {
    const f = fakeSession({})
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(async () => f.session),
      ),
    )
    ctx.cancel("before")
    const res = await ctx.execute()
    ctx.dispose()
    expect(res.outcome).toBe("cancelled")
  })

  test("C4. repeated cancellation is safe and disposal is idempotent", async () => {
    const f = fakeSession({})
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(async () => f.session),
      ),
    )
    ctx.cancel()
    ctx.cancel()
    ctx.cancel()
    ctx.dispose()
    ctx.dispose()
    ctx.dispose()
    expect(ctx.getState()).toBe("disposed")
  })

  test("C5. a turn that RESOLVES after cancellation is reported cancelled", async () => {
    const f = fakeSession({
      onRun: async () => {
        await new Promise((r) => setTimeout(r, 15))
        return { finalText: "late", usage: { steps: 3 } }
      },
    })
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(async () => f.session),
      ),
    )
    const running = ctx.execute()
    await new Promise((r) => setTimeout(r, 5))
    ctx.cancel()
    const res = await running
    ctx.dispose()
    // the late success is NOT reported as success
    expect(res.outcome).toBe("cancelled")
    expect(res.ok).toBe(false)
  })
})

// ═══ D. OUTCOMES ARE DISTINCT ═══════════════════════════════════════════════

describe("D. the autonomous turn contract distinguishes outcomes", () => {
  const run = async (
    behaviour: Parameters<typeof fakeSession>[0]["onRun"] extends undefined
      ? never
      : NonNullable<Parameters<typeof fakeSession>[0]["onRun"]>,
  ) => {
    const f = fakeSession({ onRun: behaviour })
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(f.factory),
      ),
    )
    const res = await ctx.execute()
    ctx.dispose()
    return res
  }

  test("D1. normal return", async () => {
    const r = await run(async () => ({ finalText: "ok", usage: { steps: 2 } }))
    expect(r.outcome).toBe("returned")
    expect(r.ok).toBe(true)
    expect(r.steps).toBe(2)
  })

  test("D2. an error is an error, not a cancellation", async () => {
    const r = await run(async () => {
      throw new Error("provider 503")
    })
    expect(r.outcome).toBe("error")
    expect(r.detail).toContain("provider 503")
    expect(r.ok).toBe(false)
  })

  test("D3. the Scheduler observation mapping is total and honest", () => {
    const returned = toExecutionObservation({
      outcome: "returned",
      ok: true,
      finalText: "text",
      steps: 1,
      childSessionId: "auto~a~t1~1",
    })
    expect(returned).toEqual({ kind: "returned", ok: true, detail: "text" })
    // cancellation is NOT reported as a successful return
    for (const outcome of ["error", "cancelled", "session-superseded"] as const) {
      const obs = toExecutionObservation({
        outcome,
        ok: false,
        detail: "d",
        steps: 0,
        childSessionId: "auto~a~t1~1",
      })
      expect(obs.kind).toBe("rejected")
    }
  })

  test("D4. an adapter refuses to plan without a durable binding", () => {
    const f = fakeSession({})
    const work = { taskId: "t1", title: "T", instruction: "i", sessionId: S }
    for (const bad of [
      { parentSessionId: S, taskId: "t1", execGeneration: 0, sessionIncarnation: 1 },
      { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 0 },
      { parentSessionId: "", taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
    ]) {
      expect(() =>
        planAutonomousContext(
          work,
          bad,
          baseConfig(async () => f.session),
        ),
      ).toThrow(/missing durable binding/)
    }
  })
})

// ═══ E. NAMESPACE: tasks stay in the PARENT session ══════════════════════════

describe("E. the task namespace is the parent session, the conversation is the child", () => {
  test("E1. the child conversation id is never used as a task namespace", async () => {
    const t = add()
    const f = fakeSession({})
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: t.id, title: t.title, instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: t.id, execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(async () => f.session),
      ),
    )
    await ctx.initialize()
    // the task lives under the PARENT
    expect(store.getTask(S, t.id)).not.toBeNull()
    // and NOT under the child conversation id
    expect(store.getTask(ctx.childSessionId, t.id)).toBeNull()
    expect(store.listTasks(ctx.childSessionId)).toEqual([])
    ctx.dispose()
  })

  test("E2. a child id cannot reach another session's tasks", async () => {
    const mine = add()
    const theirs = store.createTask("other-session", {
      title: "theirs",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    const f = fakeSession({})
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: mine.id, title: mine.title, instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: mine.id, execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(async () => f.session),
      ),
    )
    expect(store.getTask("other-session", theirs.id)!.title).toBe("theirs")
    expect(() => assertContextBelongsTo(ctx, "other-session", 1)).toThrow(AutonomousContextError)
    ctx.dispose()
  })
})

// ═══ F. 6Q / 6P REGRESSION THROUGH THE ADAPTER ═════════════════════════════

describe("F. the adapter preserves 6P ownership and 6Q lifetime", () => {
  test("F1. a full Scheduler -> adapter -> context execution records the lineage", async () => {
    const t = add()
    const f = fakeSession({})
    const runTurn = buildAutonomousRunTurn(
      () => ({ parentSessionId: S, taskId: t.id, execGeneration: 1, sessionIncarnation: 1 }),
      baseConfig(async () => f.session),
    )
    const sc = new Scheduler(S, { store, runTurn, instruction: "DO IT" })
    sc.start()
    const res = await sc.cycle()
    await sc.stop()
    expect(res.dispatched?.ok).toBe(true)
    // 6P: ownership established by the claim, and the attempt recorded
    expect(store.getExecutionOwnership(S, t.id)!.executionOwner).toBe("scheduler")
    expect(store.getExecutionLineage(S, t.id)).toEqual({ execGeneration: 1, attemptGeneration: 1 })
    // and completion authority is untouched
    expect(store.getTask(S, t.id)!.status).toBe("IN_PROGRESS")
  })

  test("F2. a session deleted under an autonomous execution is harmless (6Q)", async () => {
    const t = add()
    const c = claim(t)
    const f = fakeSession({
      onRun: async () => {
        // the parent session is deleted while the autonomous turn runs
        store.bumpSessionIncarnation(S)
        store.deleteSessionTasks(S)
        return { finalText: "done", usage: { steps: 1 } }
      },
    })
    const runTurn = buildAutonomousRunTurn(
      () => ({
        parentSessionId: S,
        taskId: t.id,
        execGeneration: c.execGeneration,
        sessionIncarnation: c.sessionIncarnation,
      }),
      baseConfig(async () => f.session),
    )
    const sc = new Scheduler(S, { store, runTurn, instruction: "DO IT" })
    sc.start()
    const res = await sc.cycle()
    // no wedge
    expect(sc.getActiveClaim()).toBeNull()
    expect(sc.getLifecycle()).toBe("STOPPED")
    expect(res.dispatched?.lineage).toBe("SESSION_SUPERSEDED")
    expect(store.listTasks(S)).toEqual([])
  })

  test("F3. disposal happens on the error path too", async () => {
    add() // a ready task, so the Scheduler actually dispatches
    const f = fakeSession({
      onRun: async () => {
        throw new Error("boom")
      },
    })
    const runTurn = buildAutonomousRunTurn(
      () => ({ parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 }),
      baseConfig(async () => f.session),
    )
    const sc = new Scheduler(S, { store, runTurn, instruction: "x" })
    sc.start()
    await sc.cycle()
    await sc.stop()
    expect(f.cleaned()).toBe(1)
  })
})

// ═══ G. CONCURRENT CONTEXTS ═════════════════════════════════════════════════

describe("G. concurrent autonomous contexts cannot cross-talk", () => {
  test("G1. two contexts have separate identity, abort and cleanup", async () => {
    const mk = () => {
      let aborted = 0
      let cleaned = 0
      let running = false
      const s: AutonomousSession = {
        async run(input) {
          if (running) throw new Error("session is already running")
          running = true
          try {
            await new Promise((r) => setTimeout(r, 20))
            return { finalText: input, usage: { steps: 1 } }
          } finally {
            running = false
          }
        },
        abort() {
          aborted++
        },
        cleanup() {
          cleaned++
        },
      }
      return {
        s,
        aborted: () => aborted,
        cleaned: () => cleaned,
      }
    }
    const a = mk()
    const b = mk()
    const t1 = add(1)
    const t2 = add(2)
    const ca = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: t1.id, title: "A", instruction: "work A", sessionId: S },
        { parentSessionId: S, taskId: t1.id, execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(async () => a.s),
      ),
    )
    const cb = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: t2.id, title: "B", instruction: "work B", sessionId: S },
        { parentSessionId: S, taskId: t2.id, execGeneration: 2, sessionIncarnation: 1 },
        baseConfig(async () => b.s),
      ),
    )
    expect(ca.childSessionId).not.toBe(cb.childSessionId)

    const [ra, rb] = await Promise.all([ca.execute(), cb.execute()])
    // cancelling one leaves the other alone
    ca.cancel()
    ca.dispose()
    const rb2 = await cb.execute()
    cb.dispose()
    expect(ra.outcome).toBe("returned")
    expect(rb.outcome).toBe("returned")
    expect(rb2.outcome).toBe("returned")
    expect(ca.childSessionId).not.toBe(cb.childSessionId)
    // attribution is per context
    expect(ra.childSessionId).toBe(ca.childSessionId)
    expect(rb.childSessionId).toBe(cb.childSessionId)
    // each disposes only its own
    expect(a.cleaned()).toBe(1)
    expect(b.cleaned()).toBe(1)
  })
})

// ═══ I. THE PROPERTIES THE MUTANTS FOUND UNOBSERVED ════════════════════════

describe("I. gate properties asserted at the CONTEXT, not only at the adapter", () => {
  test("I1. [M4] a context built DIRECTLY with a forbidden tool refuses to initialize", async () => {
    // The adapter checks the tool set too, but the CONTEXT must enforce it on its
    // own: a composition root could construct a context without the adapter, and
    // then the only thing standing between an unattended executor and `bash`
    // would be a convention.
    const f = fakeSession({})
    const ctx = new AutonomousExecutionContext({
      parentSessionId: S,
      taskId: "t1",
      taskTitle: "T",
      instruction: "i",
      execGeneration: 1,
      sessionIncarnation: 1,
      cwd: dir,
      sessionFactory: f.factory,
      tools: [{ name: "bash" }],
    })
    await expect(ctx.initialize()).rejects.toThrow(/read-only/)
    ctx.dispose()
  })

  test("I2. [M7] the ACTUAL session incarnation reaches the context", async () => {
    // A hardcoded 1 would be unobservable while every test used incarnation 1.
    const f = fakeSession({})
    const ctx = new AutonomousExecutionContext({
      parentSessionId: S,
      taskId: "t1",
      taskTitle: "T",
      instruction: "i",
      execGeneration: 3,
      sessionIncarnation: 7,
      cwd: dir,
      sessionFactory: f.factory,
      tools: readOnlyTools,
    })
    expect(ctx.sessionIncarnation).toBe(7)
    expect(ctx.execGeneration).toBe(3)
    // and the adapter path carries it, not a constant
    const t = add()
    const planned = planAutonomousContext(
      { taskId: t.id, title: t.title, instruction: "i", sessionId: S },
      { parentSessionId: S, taskId: t.id, execGeneration: 4, sessionIncarnation: 9 },
      baseConfig(f.factory),
    )
    expect(planned.sessionIncarnation).toBe(9)
    expect(planned.execGeneration).toBe(4)
    ctx.dispose()
  })

  test("I3. [M8] the child runs in the TASK's workspace, not process.cwd()", async () => {
    const workspace = join(dir, "the-project")
    const f = fakeSession({})
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(f.factory, { cwdFor: () => workspace }),
      ),
    )
    await ctx.initialize()
    expect(f.specs[0]!.cwd).toBe(workspace)
    expect(f.specs[0]!.cwd).not.toBe(process.cwd())
    expect(ctx.cwd).toBe(workspace)
    ctx.dispose()
  })

  test("I4. [M12] the turn context carries no interactive conversation", async () => {
    const f = fakeSession({})
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(f.factory),
      ),
    )
    await ctx.initialize()
    const extra = f.specs[0]!.systemExtra
    // exactly the task, the workspace and the autonomy rules - nothing else
    expect(extra).toContain("AUTONOMOUS execution context")
    expect(extra).toContain(dir)
    expect(extra).toContain("Task: T")
    // no history, no memory, no user text, no parent conversation
    for (const leak of [
      "conversation",
      "history",
      "previous user",
      "earlier turn",
      "user said",
      "parent",
    ]) {
      expect(extra.toLowerCase()).not.toContain(leak)
    }
    ctx.dispose()
  })

  test("I5. [M6] context events are child-scoped and there is no parent sink", async () => {
    const seen: string[] = []
    const f = fakeSession({})
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(f.factory, {
          onContextEvent: (e) => seen.push(`${e.kind}:${e.childSessionId}`),
        }),
      ),
    )
    await ctx.execute()
    ctx.dispose()
    expect(seen.length).toBeGreaterThan(0)
    // every event names the CHILD session, never the parent's
    for (const e of seen) expect(e).toContain(ctx.childSessionId)
    for (const e of seen) expect(e).not.toContain(`:${S}`)
    // the config type exposes no parent-presentation sink at all
    const cfg = planAutonomousContext(
      { taskId: "t1", title: "T", instruction: "i", sessionId: S },
      { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
      baseConfig(f.factory),
    )
    expect(Object.keys(cfg).some((k) => k.toLowerCase().includes("presentation"))).toBe(false)
  })
})

describe("H. construct N / execute N / dispose N leaves nothing behind", () => {
  test("H1. 20 contexts, each fully released", async () => {
    let built = 0
    let cleaned = 0
    let aborted = 0
    const factory = async (): Promise<AutonomousSession> => {
      built++
      return {
        async run() {
          return { finalText: "ok", usage: { steps: 1 } }
        },
        abort() {
          aborted++
        },
        cleanup() {
          cleaned++
        },
      }
    }
    for (let i = 0; i < 20; i++) {
      const t = add(i + 1)
      const ctx = new AutonomousExecutionContext(
        planAutonomousContext(
          { taskId: t.id, title: `T${i}`, instruction: "i", sessionId: S },
          { parentSessionId: S, taskId: t.id, execGeneration: 1, sessionIncarnation: 1 },
          baseConfig(factory),
        ),
      )
      await ctx.execute()
      ctx.dispose()
      expect(ctx.getState()).toBe("disposed")
    }
    expect(built).toBe(20)
    expect(cleaned).toBe(20) // every child released exactly once
    expect(aborted).toBe(20) // dispose aborts before cleanup
  })

  test("H2. a failing factory leaves a disposed, reusable-nowhere context", async () => {
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: S },
        { parentSessionId: S, taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        baseConfig(async () => {
          throw new Error("cannot create session")
        }),
      ),
    )
    await expect(ctx.execute()).rejects.toThrow("cannot create session")
    ctx.dispose()
    expect(ctx.getState()).toBe("disposed")
    // a disposed context refuses to run again rather than silently re-creating
    await expect(ctx.execute()).rejects.toThrow(AutonomousContextError)
  })
})
