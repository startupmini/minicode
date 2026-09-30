// PHASE 6AB - PRODUCTION TRIGGER REACHABILITY, SECURITY AND PROPERTIES.
//
// EVIDENCE QUALITY, stated before any assertion:
//
//   "Do not repeat the 6V/6AA error of proving the helper instead of the caller."
//
// 6AA's blocker was a CALLER problem, not a helper problem. `TriggerCoordinator.fire`
// was correct, `ProductionSchedulerHandle.fire` was correct, and every test that
// existed proved it. The production call site made exactly one method call on the
// handle - `stop()` - and 6AA enumerated that fact from source.
//
// So nothing in this file constructs a Scheduler, a TriggerCoordinator or a
// ProductionSchedulerHandle. Every test here goes through:
//
//   real createCliSession({ schedulerEnabled: true })
//     -> real createProductionScheduler (the ONE production construction site)
//       -> real handle exposed on the real CliSession
//         -> real handleBuiltinCommand("/scheduler run")   <- the 6AB trigger route
//           -> real Scheduler.cycle()
//             -> real TaskStore over real SQLite
//               -> real autonomous turn over real HTTP (test/helpers/fake-provider)
//
// The one seam that cannot be executed here is `cli/tui.ts` building its
// CommandContext, because `runTui` is a fullscreen TTY driver. That seam is
// covered by an explicit SOURCE-ANCHORED assertion at the bottom of this file,
// and the report calls it out rather than letting it pass unnoticed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CommandContext, handleBuiltinCommand } from "../cli/commands.ts"
import { type CliSession, createCliSession } from "../cli/setup.ts"
import { loadSession } from "../src/session/persistence.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { type FakeProvider, type FakeReply, startFakeProvider } from "./helpers/fake-provider.ts"

const REPO = import.meta.dir.replace(/[\\/]test$/, "").replace(/\\/g, "/")

let dir: string
let provider: FakeProvider | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6ab-"))
  resetTaskStoreHandles()
  resetSessionOwnershipForTests()
})

afterEach(async () => {
  provider?.close()
  provider = null
  resetTaskStoreHandles()
  resetSessionOwnershipForTests()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

/**
 * A workspace whose ONLY provider is a local scripted HTTP endpoint, so the real
 * provider chain, the real SSE parser and the real tool dispatch all run while
 * nothing leaves the machine. `allowLocalConfig: true` is what lets
 * `createCliSession` read the repo-local config at all.
 */
async function workspaceWithProvider(script: FakeReply[]): Promise<string> {
  provider = startFakeProvider(script)
  await mkdir(join(dir, ".minicode"), { recursive: true })
  await writeFile(
    join(dir, ".minicode", "config.json"),
    JSON.stringify({
      providers: [{ id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["fake-1"] }],
    }),
    "utf8",
  )
  return dir
}

/** Same options the CLI entry uses for a non-interactive probe run. */
function sessionOptions(sessionId: string, schedulerEnabled: boolean) {
  return {
    cwd: dir,
    allowLocalConfig: true,
    sessionId,
    prompt: "hi",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
    schedulerEnabled,
  }
}

/**
 * The CommandContext `cli/tui.ts` builds, assembled from the REAL session.
 *
 * Mirrors `cli/tui.ts` field for field. This is the `/scheduler` half of it; the
 * rest exists only because `handleBuiltinCommand` demands the whole interface.
 */
function commandCtxFor(ctx: CliSession): CommandContext {
  return {
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    allowLocalConfig: ctx.allowLocalConfig,
    currentModel: ctx.modelRef.current ?? "fake-1",
    setModelOverride: () => {},
    usage: ctx.usage,
    skills: ctx.allLoadedSkills,
    toolsCount: ctx.sessionTools.length,
    providerHint: undefined,
    onBeforeSpawn: () => {},
    getContextTokens: () => 0,
    budgetState: () => "ok",
    scheduler: {
      handle: ctx.productionScheduler,
      observability: ctx.schedulerObservability,
    },
  }
}

/** Run a slash command with console.log captured, exactly as the TUI captures it. */
async function runCommand(ctx: CommandContext, line: string): Promise<string> {
  const lines: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "))
  }
  try {
    const r = await handleBuiltinCommand(line, ctx)
    expect(r.handled).toBe(true)
  } finally {
    console.log = orig
  }
  return lines.join("\n")
}

/** A PENDING task with no dependencies: ready for the graph the moment it is read. */
function seedReadyTask(sessionId: string, title: string): string {
  const store = new TaskStore(dir, { authority: "SCHEDULER" })
  return store.createTask(sessionId, {
    title,
    status: "PENDING",
    order: 1,
    provenance: { origin: "model", source: "6ab" },
  }).id
}

function readTasks(sessionId: string): { id: string; status: string }[] {
  return new TaskStore(dir, { authority: "SCHEDULER" }).listTasks(sessionId)
}

// ---------------------------------------------------------------------------
// Sections 1 and 5: the blocker, reproduced and closed
// ---------------------------------------------------------------------------

describe("6AB S1/S5 - production trigger is reachable", () => {
  test("S1: an enabled production session exposes the handle 6AA proved unreachable", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    const ctx = await createCliSession(sessionOptions("ab-handle", true))
    try {
      // 6AA: this object existed but was NOT on the session, so nothing outside
      // cli/setup.ts could name it. It is now.
      const h = ctx.productionScheduler
      expect(h.enabled).toBe(true)
      expect(h.constructed).toBe(true)
      // start() succeeded, which is only possible with a real lease.
      expect(h.isActive()).toBe(true)
      expect(h.getScheduler()?.hasAuthority()).toBe(true)
    } finally {
      await ctx.close()
    }
  })

  test("S5: /scheduler run reaches fire() through real production composition", async () => {
    // ONE scripted reply: the autonomous turn must make exactly one request.
    await workspaceWithProvider([{ kind: "text", text: "autonomous work done" }])
    seedReadyTask("ab-reach", "verify the trigger is reachable")

    const ctx = await createCliSession(sessionOptions("ab-reach", true))
    try {
      const before = provider!.requestCount()
      const out = await runCommand(commandCtxFor(ctx), "/scheduler run")

      // The trigger ran a cycle against the real store and the real autonomous
      // adapter, and the real provider received the request. This is the
      // assertion 6AA could not make: nothing reached fire().
      expect(provider!.requestCount()).toBeGreaterThan(before)
      // ...and the outcome was reported to the operator, not swallowed.
      expect(out).toContain("scheduling cycle completed")

      // The durable row advanced: the task was CLAIMED and the attempt RECORDED.
      //
      // The terminal state asserted is IN_PROGRESS, NOT COMPLETED - and that is
      // the load-bearing part of this test. 6T's scheduler "does not decide
      // whether the work succeeded and never writes COMPLETED"; the cycle's own
      // stop reason here is `already-dispatched`, meaning it handed one item to
      // the autonomous executor and stopped. Asserting COMPLETED would have been
      // asserting behaviour the architecture deliberately forbids, and a green
      // test would have hidden it.
      const after = readTasks("ab-reach")
      expect(after).toHaveLength(1)
      expect(after[0]!.status).toBe("IN_PROGRESS")
      // The lineage is durable, not in-memory: the claim advanced it.
      const store = new TaskStore(dir, { authority: "SCHEDULER" })
      expect(store.getExecutionLineage("ab-reach", after[0]!.id)?.execGeneration).toBeGreaterThan(0)
      // The operator's activity log tells the whole story end to end:
      // trigger -> selection -> claim -> dispatch -> execution -> return.
      expect(
        ctx.schedulerObservability.status(ctx.productionScheduler).recent.map((n) => n.line),
      ).toEqual([
        expect.stringContaining("trigger evaluated (explicit-command)"),
        expect.stringContaining("selected "),
        expect.stringContaining("claimed "),
        expect.stringContaining("dispatch started for "),
        expect.stringContaining("executing "),
        expect.stringContaining("execution finished for "),
      ])
      // And the Scheduler returned to serving: one cycle, not a loop.
      expect(ctx.productionScheduler.isActive()).toBe(true)
    } finally {
      await ctx.close()
    }
  })

  test("S1: the handle's production call surface is no longer {stop} alone", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    seedReadyTask("ab-surface", "enumerate the call surface")
    const ctx = await createCliSession(sessionOptions("ab-surface", true))
    try {
      // Instrument rather than grep. A source scan would prove the string "fire"
      // exists; a Proxy proves the ROUTE CALLS IT.
      const calls: string[] = []
      const real = ctx.productionScheduler
      const proxied = new Proxy(real, {
        get(target, prop, recv) {
          const v = Reflect.get(target, prop, recv)
          if (typeof v !== "function") return v
          return (...args: unknown[]) => {
            calls.push(String(prop))
            return (v as (...a: unknown[]) => unknown).apply(target, args)
          }
        },
      })
      await runCommand(
        {
          ...commandCtxFor(ctx),
          scheduler: { handle: proxied, observability: ctx.schedulerObservability },
        },
        "/scheduler run",
      )
      // 6AA's enumeration of production calls was exactly ["stop"]. The operator
      // trigger is now among them.
      expect(calls).toContain("fire")
      expect(calls).not.toContain("stop")
    } finally {
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Section 16: trigger semantics, observed from the production route
// ---------------------------------------------------------------------------

describe("6AB S16 - trigger semantics from the production route", () => {
  test("trigger with no ready task evaluates and reports no-candidates", async () => {
    await workspaceWithProvider([{ kind: "text", text: "must not be called" }])
    const ctx = await createCliSession(sessionOptions("ab-idle", true))
    try {
      // No seeded task: the graph is empty.
      const out = await runCommand(commandCtxFor(ctx), "/scheduler run")
      // An evaluation genuinely happened...
      expect(ctx.schedulerObservability.status(ctx.productionScheduler).counts.evaluations).toBe(1)
      // ...and it is reported as "nothing was ready", NOT as a success that ran work.
      expect(out).toContain("no task was ready")
      // No provider call: readiness was not bypassed to manufacture work.
      expect(provider!.requestCount()).toBe(0)
    } finally {
      await ctx.close()
    }
  })

  test("trigger after stop is refused, not silently converted to success", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    seedReadyTask("ab-stop", "t")
    const ctx = await createCliSession(sessionOptions("ab-stop", true))
    try {
      const commandCtx = commandCtxFor(ctx)
      expect(await runCommand(commandCtx, "/scheduler stop")).toContain("scheduler stopped")
      const afterStop = await runCommand(commandCtx, "/scheduler run")
      expect(afterStop).toContain("not active")
      // Refused means refused: no evaluation was started at all.
      expect(ctx.schedulerObservability.status(ctx.productionScheduler).counts.evaluations).toBe(0)
      expect(provider!.requestCount()).toBe(0)
    } finally {
      await ctx.close()
    }
  })

  test("an unknown subcommand prints usage instead of guessing", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    const ctx = await createCliSession(sessionOptions("ab-usage", true))
    try {
      const out = await runCommand(commandCtxFor(ctx), "/scheduler nonsense")
      expect(out).toContain("usage: /scheduler")
      expect(provider!.requestCount()).toBe(0)
    } finally {
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Section 10: stop idempotency
// ---------------------------------------------------------------------------

describe("6AB S10 - operator stop is idempotent", () => {
  test("stop, stop: the second stop is a no-op that says so", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    const ctx = await createCliSession(sessionOptions("ab-idem", true))
    try {
      const commandCtx = commandCtxFor(ctx)
      const first = await runCommand(commandCtx, "/scheduler stop")
      const second = await runCommand(commandCtx, "/scheduler stop")
      expect(first).toContain("scheduler stopped")
      expect(second).toContain("already stopped")
      // No duplicate release surfaced as a crash, and the handle is settled.
      expect(ctx.productionScheduler.isActive()).toBe(false)
      // Authority was genuinely given up.
      expect(ctx.productionScheduler.getScheduler()?.hasAuthority()).toBe(false)
    } finally {
      await ctx.close()
    }
  })

  test("stop, run, stop: no execution after stop", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    seedReadyTask("ab-order", "t")
    const ctx = await createCliSession(sessionOptions("ab-order", true))
    try {
      const commandCtx = commandCtxFor(ctx)
      await runCommand(commandCtx, "/scheduler stop")
      await runCommand(commandCtx, "/scheduler run")
      const requests = provider!.requestCount()
      await runCommand(commandCtx, "/scheduler stop")
      expect(provider!.requestCount()).toBe(requests)
    } finally {
      await ctx.close()
    }
  })

  test("close() after a manual stop does not double-release", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    const ctx = await createCliSession(sessionOptions("ab-dbl", true))
    await runCommand(commandCtxFor(ctx), "/scheduler stop")
    // [FACT] close() calls stop("shutdown") on an already-stopped handle. It must
    // complete, not throw, and not release a second time.
    await expect(ctx.close()).resolves.toBeUndefined()
    expect(ctx.productionScheduler.isActive()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Sections 11 and 7: enable lifecycle and observability
// ---------------------------------------------------------------------------

describe("6AB S11/S7 - enable lifecycle and observability", () => {
  test("S11: OFF has no Scheduler and /scheduler says OFF", async () => {
    await workspaceWithProvider([{ kind: "text", text: "must not be called" }])
    seedReadyTask("ab-off", "t")
    const ctx = await createCliSession(sessionOptions("ab-off", false))
    try {
      const h = ctx.productionScheduler
      // 6U's invariant must survive 6AB's wiring.
      expect(h.enabled).toBe(false)
      expect(h.constructed).toBe(false)
      expect(h.getScheduler()).toBeNull()
      expect(h.isActive()).toBe(false)
      const commandCtx = commandCtxFor(ctx)
      expect(await runCommand(commandCtx, "/scheduler status")).toContain("scheduler OFF")
      expect(await runCommand(commandCtx, "/scheduler run")).toContain("scheduler is OFF")
      expect(await runCommand(commandCtx, "/scheduler stop")).toContain("scheduler is OFF")
      // And nothing at all happened.
      expect(provider!.requestCount()).toBe(0)
      expect(readTasks("ab-off")[0]!.status).toBe("PENDING")
    } finally {
      await ctx.close()
    }
  })

  test("S7: an operator can distinguish OFF / ON+idle / ON+stopped", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    const on = await createCliSession(sessionOptions("ab-obs", true))
    try {
      const o = on.schedulerObservability
      const h = on.productionScheduler
      const commandCtx = commandCtxFor(on)
      expect(o.state(h)).toBe("ON_IDLE")
      expect(await runCommand(commandCtx, "/scheduler status")).toContain("idle")

      await runCommand(commandCtx, "/scheduler stop")
      expect(o.state(h)).toBe("ON_STOPPED")
      expect(await runCommand(commandCtx, "/scheduler status")).toContain("STOPPED")
    } finally {
      await on.close()
    }

    const offCtx = await createCliSession(sessionOptions("ab-obs-off", false))
    try {
      expect(offCtx.schedulerObservability.state(offCtx.productionScheduler)).toBe("OFF")
    } finally {
      await offCtx.close()
    }
  })

  test("S7: the observability sink receives real production scheduler events", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    seedReadyTask("ab-events", "t")
    const ctx = await createCliSession(sessionOptions("ab-events", true))
    try {
      const seen: string[] = []
      // Attach the sink the way tui.ts does - AFTER the composition returned.
      ctx.schedulerObservability.onSchedulerNotice((line) => seen.push(line))
      await runCommand(commandCtxFor(ctx), "/scheduler run")
      // 6AA: both sinks were passed by nobody and every event was discarded. Now
      // the operator sees the lifecycle.
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.some((l) => l.includes("claimed") || l.includes("selected"))).toBe(true)
      expect(seen.some((l) => l.includes("executing"))).toBe(true)
      expect(seen.some((l) => l.includes("execution finished"))).toBe(true)

      // A throwing sink cannot take the cycle down.
      ctx.schedulerObservability.onSchedulerNotice(() => {
        throw new Error("renderer exploded")
      })
      await expect(runCommand(commandCtxFor(ctx), "/scheduler run")).resolves.toContain(
        "scheduling cycle",
      )
    } finally {
      ctx.schedulerObservability.onSchedulerNotice(null)
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Section 12: session scope
// ---------------------------------------------------------------------------

describe("6AB S12 - trigger cannot cross a session boundary", () => {
  test("a trigger on session A never schedules session B's tasks", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    // A ready task exists, but in a DIFFERENT session than the one under test.
    seedReadyTask("ab-other", "belongs to another session")

    const ctx = await createCliSession(sessionOptions("ab-mine", true))
    try {
      const out = await runCommand(commandCtxFor(ctx), "/scheduler run")
      expect(out).toContain("no task was ready")
      // The other session's task is untouched and unclaimed.
      expect(readTasks("ab-other").every((t) => t.status === "PENDING")).toBe(true)
      expect(provider!.requestCount()).toBe(0)

      // [FACT] The route retains EXACT session identity: the status an operator
      // reads names the session they are actually in. A trigger routed to another
      // session's Scheduler would be invisible without this.
      const status = await runCommand(commandCtxFor(ctx), "/scheduler status")
      expect(status).toContain(`session: ${ctx.sessionId}`)
      expect(status).toContain("ab-mine")
      expect(status).not.toContain("ab-other")
    } finally {
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Section 13: resume
// ---------------------------------------------------------------------------

describe("6AB S13 - resume integration", () => {
  test("a resumed session composes a scheduler with a correct, distinct identity", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    const live = await createCliSession(sessionOptions("ab-live", false))
    await live.close()
    // Give the earlier session something durable to resume from.
    seedReadyTask("ab-live", "resumable work")

    // `resumeId` forges history; `sessionId` stays the LIVE identity.
    // setup.ts persists to BOTH (persistCurrent), so resume is a fork and the
    // scheduler must follow the live session - which is what this asserts.
    const resumed = await createCliSession({
      ...sessionOptions("ab-live-2", true),
      resumeId: "ab-live",
    })
    try {
      expect(resumed.sessionId).toBe("ab-live-2")
      expect(resumed.productionScheduler.constructed).toBe(true)
      expect(resumed.productionScheduler.isActive()).toBe(true)
      // Authority is on the LIVE id, not the resumed one.
      expect(resumed.productionScheduler.getScheduler()?.hasAuthority()).toBe(true)
      // The trigger route works on a resumed composition, over the LIVE namespace.
      const out = await runCommand(commandCtxFor(resumed), "/scheduler run")
      expect(out).toContain("no task was ready")
      expect(provider!.requestCount()).toBe(0)
      // The resumed session's own tasks are untouched by the live scheduler.
      expect(readTasks("ab-live")[0]!.status).toBe("PENDING")
    } finally {
      await resumed.close()
    }
  })

  test("resume with an explicit --session id puts the scheduler on THAT id", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    // Give the earlier session a real, persisted turn to resume FROM. Without this
    // the resume integration is untested: an id alone would satisfy every
    // assertion below even if `--resume` did nothing at all.
    const seeded = await createCliSession(sessionOptions("ab-same", false))
    await seeded.runPromptWithVerify("a durable marker string")
    await seeded.persistCurrent({})
    expect(loadSession("ab-same", dir)?.messages.length ?? 0).toBeGreaterThan(0)
    await seeded.close()

    seedReadyTask("ab-same", "resumed work")

    // resumeId === sessionId: the operator explicitly continued the same session,
    // so the scheduler MUST govern it and the trigger MUST reach its task.
    const resumed = await createCliSession({
      ...sessionOptions("ab-same", true),
      resumeId: "ab-same",
    })
    try {
      expect(resumed.sessionId).toBe("ab-same")
      // [FACT] The resume actually happened: the earlier turn is in the kernel.
      expect(
        resumed.session.state.history.some((m) =>
          JSON.stringify(m.content ?? "").includes("a durable marker string"),
        ),
      ).toBe(true)
      await runCommand(commandCtxFor(resumed), "/scheduler run")
      expect(provider!.requestCount()).toBeGreaterThan(0)
      expect(readTasks("ab-same")[0]!.status).toBe("IN_PROGRESS")
    } finally {
      await resumed.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Section 17: production security regression - the trigger grants nothing
// ---------------------------------------------------------------------------

describe("6AB S17 - the trigger grants nothing", () => {
  test("S17: an autonomous turn still cannot use a non-readonly tool", async () => {
    // The strongest form of "trigger does not bypass permission": ask the model,
    // through the REAL provider, for a write. If the trigger route had widened the
    // tool set, this file would exist.
    await workspaceWithProvider([
      {
        kind: "tool",
        name: "write_file",
        args: { path: "owned-by-scheduler.txt", content: "pwned" },
      },
      { kind: "text", text: "done" },
    ])
    seedReadyTask("ab-perm", "try to write")
    const ctx = await createCliSession(sessionOptions("ab-perm", true))
    try {
      await runCommand(commandCtxFor(ctx), "/scheduler run")
      // 6S's READ_ONLY allow-list survived the new trigger path.
      expect(existsSync(join(dir, "owned-by-scheduler.txt"))).toBe(false)
      // And the turn itself still ran - the tool was denied, not the work.
      expect(readTasks("ab-perm")[0]!.status).toBe("IN_PROGRESS")
    } finally {
      await ctx.close()
    }
  })

  test("S17: trigger does not bypass the session lease", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    seedReadyTask("ab-lease", "t")
    const ctx = await createCliSession(sessionOptions("ab-lease", true))
    try {
      // Hand the lease to a DIFFERENT owner, exactly as a rival process would.
      // The token is read from DURABLE state, not from the live object: a rival
      // process cannot reach the handle either, and this is what it would see.
      const store = new TaskStore(dir, { authority: "SCHEDULER" })
      store.releaseSessionAuthority(
        "ab-lease",
        store.getSessionAuthority("ab-lease")?.ownerToken ?? "",
      )
      expect(store.acquireSessionAuthority("ab-lease", "rival-token", 300_000, Date.now())).toBe(
        "ACQUIRED",
      )

      const out = await runCommand(commandCtxFor(ctx), "/scheduler run")
      // The trigger DID reach the coordinator and a cycle DID start - but the
      // cycle discovered it no longer held the lease and refused at the first
      // authority check. Nothing was claimed, dispatched or executed.
      //
      // The important part is that this refusal is VISIBLE. An operator sees
      // "authority-lost" and the STOPPED state, rather than a `/scheduler run`
      // that appears to succeed and quietly does nothing.
      expect(ctx.schedulerObservability.status(ctx.productionScheduler).counts.evaluations).toBe(1)
      expect(ctx.schedulerObservability.lastCycleStopReason).toBe("authority-lost")
      expect(ctx.schedulerObservability.state(ctx.productionScheduler)).toBe("ON_STOPPED")
      expect(out).toContain("authority-lost")
      expect(readTasks("ab-lease")[0]!.status).toBe("PENDING")
      expect(provider!.requestCount()).toBe(0)
    } finally {
      await ctx.close()
    }
  })

  test("S17: trigger does not bypass readiness", async () => {
    await workspaceWithProvider([{ kind: "text", text: "must not be called" }])
    seedReadyTask("ab-ready", "not claimable yet")
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    // Cancel it: a cancelled task is never a scheduling candidate.
    store.patchTask("ab-ready", store.listTasks("ab-ready")[0]!.id, { status: "CANCELLED" })

    const ctx = await createCliSession(sessionOptions("ab-ready", true))
    try {
      const out = await runCommand(commandCtxFor(ctx), "/scheduler run")
      // Readiness was evaluated, not assumed. A trigger is not a command to run
      // something - it is a request to LOOK.
      expect(out).toContain("no task was ready")
      expect(provider!.requestCount()).toBe(0)
      expect(readTasks("ab-ready")[0]!.status).toBe("CANCELLED")
    } finally {
      await ctx.close()
    }
  })

  test("S17: a deleted session cannot continue scheduling", async () => {
    await workspaceWithProvider([{ kind: "text", text: "must not be called" }])
    seedReadyTask("ab-del", "t")
    const ctx = await createCliSession(sessionOptions("ab-del", true))
    try {
      // Deleting through the production-owned notification path.
      await ctx.productionScheduler.notifySessionDeleted()
      const out = await runCommand(commandCtxFor(ctx), "/scheduler run")
      expect(out).toContain("not active")
      expect(provider!.requestCount()).toBe(0)
      expect(ctx.productionScheduler.isActive()).toBe(false)
    } finally {
      await ctx.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Section 20: the required properties
// ---------------------------------------------------------------------------

describe("6AB S20 - the required properties, through production", () => {
  test("P1: OFF has zero autonomous work (property 1)", async () => {
    await workspaceWithProvider([{ kind: "text", text: "must not be called" }])
    seedReadyTask("ab-p1", "t")
    const ctx = await createCliSession(sessionOptions("ab-p1", false))
    try {
      await runCommand(commandCtxFor(ctx), "/scheduler run")
      expect(provider!.requestCount()).toBe(0)
      expect(readTasks("ab-p1")[0]!.status).toBe("PENDING")
    } finally {
      await ctx.close()
    }
  })

  test("P2: ON has a reachable trigger (property 2)", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    seedReadyTask("ab-p2", "t")
    const ctx = await createCliSession(sessionOptions("ab-p2", true))
    try {
      const before = provider!.requestCount()
      await runCommand(commandCtxFor(ctx), "/scheduler run")
      expect(provider!.requestCount()).toBeGreaterThan(before)
    } finally {
      await ctx.close()
    }
  })

  test("P6/P7: stop prevents further work and a stopped scheduler cannot trigger", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    seedReadyTask("ab-p6", "t")
    const ctx = await createCliSession(sessionOptions("ab-p6", true))
    try {
      const commandCtx = commandCtxFor(ctx)
      await runCommand(commandCtx, "/scheduler stop")
      const requests = provider!.requestCount()
      await runCommand(commandCtx, "/scheduler run")
      await runCommand(commandCtx, "/scheduler run")
      expect(provider!.requestCount()).toBe(requests)
    } finally {
      await ctx.close()
    }
  })

  test("P8: a deleted session cannot trigger (property 8)", async () => {
    await workspaceWithProvider([{ kind: "text", text: "must not be called" }])
    seedReadyTask("ab-p8", "t")
    const ctx = await createCliSession(sessionOptions("ab-p8", true))
    try {
      await ctx.productionScheduler.notifySessionDeleted()
      await runCommand(commandCtxFor(ctx), "/scheduler run")
      expect(provider!.requestCount()).toBe(0)
    } finally {
      await ctx.close()
    }
  })

  test("P9: a recreated session gets new authority (property 9)", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    const first = await createCliSession(sessionOptions("ab-p9", true))
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    const firstToken = store.getSessionAuthority("ab-p9")?.ownerToken
    expect(firstToken).toBeTruthy()
    await first.close()

    // Re-create the SAME session id: the old token must not be reusable.
    const second = await createCliSession(sessionOptions("ab-p9", true))
    try {
      const secondToken = store.getSessionAuthority("ab-p9")?.ownerToken
      expect(second.productionScheduler.isActive()).toBe(true)
      expect(secondToken).toBeTruthy()
      expect(secondToken).not.toBe(firstToken)
    } finally {
      await second.close()
    }
  })

  test("P11: no duplicate execution from repeated triggers (property 11)", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    seedReadyTask("ab-p11", "t")
    const ctx = await createCliSession(sessionOptions("ab-p11", true))
    try {
      const commandCtx = commandCtxFor(ctx)
      await runCommand(commandCtx, "/scheduler run")
      const store = new TaskStore(dir, { authority: "SCHEDULER" })
      const taskId = store.listTasks("ab-p11")[0]!.id
      const gen1 = store.getExecutionLineage("ab-p11", taskId)?.execGeneration
      // Three more triggers against an already-dispatched task.
      await runCommand(commandCtx, "/scheduler run")
      await runCommand(commandCtx, "/scheduler run")
      await runCommand(commandCtx, "/scheduler run")
      const gen2 = store.getExecutionLineage("ab-p11", taskId)?.execGeneration
      // The task is IN_PROGRESS, not claimable again: no second run.
      expect(gen2).toBe(gen1)
      expect(readTasks("ab-p11")[0]!.status).toBe("IN_PROGRESS")
    } finally {
      await ctx.close()
    }
  })

  test("P12: no lifecycle wedge across enable -> trigger -> stop -> restart", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    for (let i = 1; i <= 3; i += 1) {
      seedReadyTask(`ab-p12-${i}`, "t")
      const ctx = await createCliSession(sessionOptions(`ab-p12-${i}`, true))
      try {
        const cc = commandCtxFor(ctx)
        await runCommand(cc, "/scheduler run")
        await runCommand(cc, "/scheduler stop")
        await runCommand(cc, "/scheduler stop") // idempotent
        await runCommand(cc, "/scheduler status")
        expect(ctx.productionScheduler.isActive()).toBe(false)
      } finally {
        await ctx.close()
      }
    }
  })

  test("P10: resume preserves session/incarnation semantics (property 10)", async () => {
    await workspaceWithProvider([{ kind: "text", text: "ok" }])
    const first = await createCliSession(sessionOptions("ab-p10", true))
    const incarnation1 = new TaskStore(dir, { authority: "SCHEDULER" }).getSessionIncarnation(
      "ab-p10",
    )
    await first.close()

    // Re-creating the same id after a clean close keeps the SAME incarnation:
    // incarnation advances only on session DELETION, not on process exit.
    const second = await createCliSession(sessionOptions("ab-p10", true))
    try {
      const incarnation2 = new TaskStore(dir, { authority: "SCHEDULER" }).getSessionIncarnation(
        "ab-p10",
      )
      expect(incarnation2).toBe(incarnation1)
      expect(second.productionScheduler.isActive()).toBe(true)
    } finally {
      await second.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Section 13, continued: the --resume flag wiring itself
// ---------------------------------------------------------------------------

describe("6AB S13 - the --resume flag reaches the composition root", () => {
  /**
   * [DESIGN DECISION] SOURCE-ANCHORED, and labelled as such.
   *
   * `cli/index.ts` is the top-level entry: it ends in `process.exit`, so it cannot
   * be executed in-process without taking the test runner down with it. The
   * consequence is that the two tests above prove the RESUME BEHAVIOUR (what a
   * resumed composition does) but not the FLAG WIRING (that `--resume` reaches it).
   *
   * This assertion covers the wiring. It is deliberately structural - it requires
   * the shorthand `resumeId,` rather than any value, which is exactly the shape
   * M11 ("--resume is no longer passed to the composition root") destroys.
   */
  test("S13: cli/index.ts forwards the parsed resumeId into createCliSession", async () => {
    const src = await Bun.file(join(REPO, "cli/index.ts")).text()
    // The flag is read...
    expect(src).toContain('getArg("--resume")')
    // ...and forwarded by shorthand into the composition options. `resumeId,
    // in the option object is the load-bearing shape.
    expect(src).toMatch(/createCliSession\(\{[\s\S]{0,400}?\n {4}resumeId,\n/)
    // And it is not neutered on the way in.
    expect(src).not.toContain("resumeId: undefined")
  })
})

describe("6AB S22 - the seam that cannot be executed", () => {
  test("cli/tui.ts routes the real session's scheduler into the command context", async () => {
    const src = await Bun.file(join(REPO, "cli/tui.ts")).text()
    // runTui destructures both objects off the CliSession...
    expect(src).toMatch(/productionScheduler,\s*\n\s*schedulerObservability,/)
    // ...injects them as the command control surface...
    expect(src).toMatch(
      /scheduler:\s*\{\s*\n\s*handle: productionScheduler,\s*\n\s*observability: schedulerObservability,/,
    )
    // ...and attaches the live notice sink to the transcript.
    expect(src).toContain("onSchedulerNotice")
    expect(src).toContain("pushInfo")
  })

  test("cli/setup.ts still calls the gate helper and still exposes the handle", async () => {
    const src = await Bun.file(join(REPO, "cli/setup.ts")).text()
    expect(src).toContain("schedulerGateFor(schedulerEnabled)")
    // Section 26: exactly ONE construction site must survive 6AB.
    expect(src.match(/createProductionScheduler\(/g) ?? []).toHaveLength(1)
    expect(src).toMatch(/^ {4}productionScheduler,$/m)
    // The stop wiring from 6U must also survive.
    expect(src).toContain('productionScheduler.stop("shutdown")')
  })

  test("S14: help text no longer claims background autonomous execution", async () => {
    const src = await Bun.file(join(REPO, "cli/index.ts")).text()
    expect(src).not.toContain("allow autonomous background task execution")
    expect(src).toContain("no background timer")
    expect(src).toContain("/scheduler run")
    // And it must still say the default is off.
    expect(src).toContain("default: off")
    // [FACT] No word may promise recurrence, continuous work, or automatic
    // triggering. The list is PHRASE-level on purpose: the help text legitimately
    // contains negations ("no recurring polling"), so a bare word ban would either
    // fail on the truth or be trivially evaded. Each entry is an affirmative claim
    // an operator could read as a promise.
    for (const phrase of [
      "runs continuously",
      "continuous autonomous",
      "recurring scheduling",
      "automatically runs",
      "automatically schedules",
      "in the background",
      "background scheduling",
    ]) {
      expect(src.toLowerCase()).not.toContain(phrase)
    }
  })

  test("S6: no automatic or recurring trigger was introduced", async () => {
    // [DESIGN DECISION] Assert the ABSENCE of a timer rather than the presence of
    // a comment. `setInterval`/`setTimeout` around fire() would be the accidental
    // automatic triggering section 6 forbids.
    const setup = await Bun.file(join(REPO, "cli/setup.ts")).text()
    const commands = await Bun.file(join(REPO, "cli/commands.ts")).text()
    const tui = await Bun.file(join(REPO, "cli/tui.ts")).text()
    for (const [name, src] of [
      ["cli/setup.ts", setup],
      ["cli/commands.ts", commands],
      ["cli/tui.ts", tui],
    ] as const) {
      expect(`${name}:${src}`).not.toMatch(/setInterval[\s\S]{0,120}fire\(/)
      expect(`${name}:${src}`).not.toMatch(/setTimeout[\s\S]{0,120}fire\(/)
    }
    // Exactly one production fire() call site, in the command handler.
    expect(commands.match(/\.fire\("explicit-command"\)/g) ?? []).toHaveLength(1)
  })
})
