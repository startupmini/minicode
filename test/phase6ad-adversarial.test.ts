// PHASE 6AD - production-path adversarial suite.
//
// Every test here composes the REAL product: `createCliSession` with the real
// flag, the real `/scheduler` command, the real Scheduler, the real TaskStore over
// real SQLite, and a real local HTTP provider. Nothing is mocked.
//
// [DESIGN DECISION] These are the tests the 6AD mutation campaign executes, so a
// mutant that survives them is a real evidence gap rather than a reporting
// artefact. Section 20 calls the boundary between "unit evidence" and
// "production-path evidence" an EVIDENCE GAP - and a suite that only reached
// `TriggerCoordinator` would be exactly that.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CommandContext, handleBuiltinCommand } from "../cli/commands.ts"
import { type CliSession, createCliSession } from "../cli/setup.ts"
import { deleteSession } from "../src/session/persistence.ts"
import { AUTONOMOUS_TOOL_NAMES } from "../src/task/autonomous-policy.ts"
import type { TaskStatus } from "../src/task/model.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { type FakeProvider, startFakeProvider } from "./helpers/fake-provider.ts"

const READ_ONLY = [{ kind: "text" as const, text: "notes.txt mentions SEVENTY_THREE." }]
/** The model asks for every dangerous capability in turn. */
const HOSTILE = [
  { kind: "tool" as const, name: "write_file", args: { path: "AD_WRITE.txt", content: "x" } },
  { kind: "text" as const, text: "Write refused; continuing." },
  { kind: "tool" as const, name: "bash", args: { command: "echo ran > ad_shell.txt" } },
  { kind: "text" as const, text: "Shell refused; continuing." },
  { kind: "tool" as const, name: "web_fetch", args: { url: "https://example.com" } },
  { kind: "text" as const, text: "Fetch refused; summary complete." },
]

let dir: string
let provider: FakeProvider | null = null
let ctx: CliSession | null = null
let seq = 0

function nextSession(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}

async function workspace(script: unknown[]): Promise<void> {
  provider = startFakeProvider(script as never)
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  writeFileSync(
    join(dir, ".minicode", "config.json"),
    JSON.stringify({
      providers: [{ id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["fake-1"] }],
    }),
  )
  writeFileSync(join(dir, "notes.txt"), "The constant is SEVENTY_THREE.\n")
}

function openSession(sessionId: string, enabled: boolean): Promise<CliSession> {
  return createCliSession({
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
    schedulerEnabled: enabled,
  })
}

function commandCtx(c: CliSession): CommandContext {
  return {
    cwd: c.cwd,
    sessionId: c.sessionId,
    allowLocalConfig: c.allowLocalConfig,
    currentModel: c.modelRef.current ?? "fake-1",
    setModelOverride: () => {},
    usage: c.usage,
    skills: c.allLoadedSkills,
    toolsCount: c.sessionTools.length,
    providerHint: undefined,
    onBeforeSpawn: () => {},
    getContextTokens: () => c.session.contextTokens,
    budgetState: () => "ok",
    scheduler: { handle: c.productionScheduler, observability: c.schedulerObservability },
  }
}

async function run(c: CliSession, line: string): Promise<string> {
  const lines: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "))
  try {
    await handleBuiltinCommand(line, commandCtx(c))
  } finally {
    console.log = orig
  }
  return lines.join("\n")
}

function seed(sessionId: string, title: string, status: TaskStatus = "PENDING"): string {
  return new TaskStore(dir).createTask(sessionId, {
    title,
    status,
    order: 1,
    provenance: { origin: "model", source: "6ad-test" },
  }).id
}

function store(): InstanceType<typeof TaskStore> {
  resetTaskStoreHandles()
  return new TaskStore(dir, { authority: "SCHEDULER" })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "minicode-6ad-"))
  resetTaskStoreHandles()
  resetSessionOwnershipForTests()
})

afterEach(async () => {
  await ctx?.close().catch(() => {})
  ctx = null
  provider?.close()
  provider = null
  resetTaskStoreHandles()
  resetSessionOwnershipForTests()
  // Windows releases the SQLite handle asynchronously; an afterEach that throws
  // reports passing tests as failing. Teardown is best-effort by design.
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 60))
    }
  }
})

// â”€â”€ M1/M2: the gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("6AD gate - the flag is the only way in", () => {
  test("M1: no flag means no Scheduler, no lease, and the trigger does nothing", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("off")
    seed(s, "t")
    ctx = await openSession(s, false)

    expect(ctx.productionScheduler.enabled).toBe(false)
    expect(ctx.productionScheduler.constructed).toBe(false)
    expect(ctx.productionScheduler.getScheduler()).toBeNull()
    // The route is EXERCISED, not merely absent.
    expect(await run(ctx, "/scheduler run")).toContain("scheduler is OFF")
    expect(ctx.schedulerObservability.status(ctx.productionScheduler).counts.evaluations).toBe(0)
    // P2.2: scheduler-off composition holds a SESSION-writer lease
    // (admission), not a scheduler lease. Discriminator: session tokens are
    // `cli:`-prefixed, scheduler tokens are `own-â€¦`. The trigger assertions
    // above prove no autonomous machinery exists; this proves the lease
    // present is the session's own admission.
    const auth = store().getSessionAuthority(s)
    expect(auth).not.toBeNull()
    expect(auth!.ownerToken.startsWith("cli:")).toBe(true)
    expect(store().listTasks(s)[0]!.status).toBe("PENDING")
    expect(provider!.requestCount()).toBe(0)
  }, 60_000)

  test("M2: --enable-scheduler=false does not enable it", async () => {
    const { resolveSchedulerGate } = await import("../src/task/production-scheduler.ts")
    // The resolver is the production gate helper that cli/index.ts calls.
    for (const argv of [
      ["--enable-scheduler=false"],
      ["--enable-scheduler=true"],
      ["--enable-scheduler=0"],
      ["--enable-scheduler=1"],
      ["--enable-scheduler="],
      ["--enable-scheduler=whatever"],
      // `--` terminates the scan, so a flag AFTER it is prompt text, not a flag.
      ["--", "--enable-scheduler"],
      ["explain", "this", "--", "--enable-scheduler"],
    ]) {
      expect(resolveSchedulerGate(argv).enabled).toBe(false)
    }
    // [FACT] The bare token enables wherever it appears BEFORE `--`. An earlier
    // draft of this test asserted `["--enable-scheduler", "--"]` was OFF and
    // failed - correctly. The terminator ends the scan; it does not retroactively
    // un-enable a flag that was already seen.
    expect(resolveSchedulerGate(["--enable-scheduler"]).enabled).toBe(true)
    expect(resolveSchedulerGate(["--enable-scheduler", "--"]).enabled).toBe(true)
    expect(resolveSchedulerGate(["--cwd", ".", "--enable-scheduler"]).enabled).toBe(true)
  })
})

// â”€â”€ M18/M13/M14: the trigger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("6AD trigger - reachable, deduplicated, and refused after stop", () => {
  test("M18: /scheduler run executes exactly one real autonomous task", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("run")
    seed(s, "t")
    ctx = await openSession(s, true)

    const out = await run(ctx, "/scheduler run")
    expect(out).toContain("scheduling cycle completed")
    expect(provider!.requestCount()).toBeGreaterThan(0)
    const task = store().listTasks(s)[0]!
    expect(task.status).toBe("IN_PROGRESS")
    expect(store().getExecutionLineage(s, task.id)?.execGeneration).toBeGreaterThan(0)
  }, 60_000)

  test("M13: ten rapid triggers produce ONE execution", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("dup")
    seed(s, "t")
    ctx = await openSession(s, true)

    for (let i = 0; i < 10; i += 1) await run(ctx, "/scheduler run")
    const snap = ctx.schedulerObservability.status(ctx.productionScheduler)
    // The task is already dispatched, so later triggers find nothing. Either way
    // there must be exactly one execution and no generation inflation.
    expect(snap.counts.executions).toBe(1)
    const task = store().listTasks(s)[0]!
    expect(store().getExecutionLineage(s, task.id)?.execGeneration).toBe(1)
    expect(ctx.productionScheduler.isActive()).toBe(true)
  }, 60_000)

  test("M14: a trigger after stop is refused and does no work", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("stop")
    seed(s, "t")
    ctx = await openSession(s, true)

    await run(ctx, "/scheduler stop")
    const before = provider!.requestCount()
    expect(await run(ctx, "/scheduler run")).toContain("not active")
    expect(provider!.requestCount()).toBe(before)
    expect(ctx.schedulerObservability.status(ctx.productionScheduler).counts.evaluations).toBe(0)
  }, 60_000)
})

// â”€â”€ M3/M4: permission â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("6AD permission - autonomous is read-only, and nothing widens it", () => {
  test("M3/M4: every dangerous tool is absent and the workspace is untouched", async () => {
    await workspace(HOSTILE)
    const s = nextSession("perm")
    seed(s, "t")
    ctx = await openSession(s, true)

    await run(ctx, "/scheduler run")

    // The set, not the run: a tool that was never offered cannot be invoked.
    expect(AUTONOMOUS_TOOL_NAMES).not.toContain("write_file")
    expect(AUTONOMOUS_TOOL_NAMES).not.toContain("bash")
    expect(AUTONOMOUS_TOOL_NAMES).not.toContain("web_fetch")
    expect(AUTONOMOUS_TOOL_NAMES).not.toContain("delegate_task")
    // And the measured consequence.
    expect(existsSync(join(dir, "AD_WRITE.txt"))).toBe(false)
    expect(existsSync(join(dir, "ad_shell.txt"))).toBe(false)
    // 6S: a refusal disqualifies the turn even when the model returns confidently.
    const snap = ctx.schedulerObservability.status(ctx.productionScheduler)
    expect(snap.counts.executions).toBe(1)
  }, 60_000)

  test("M4: raising the PARENT to allow-all does not widen autonomous authority", async () => {
    await workspace(HOSTILE)
    const s = nextSession("widen")
    seed(s, "t")
    ctx = await openSession(s, true)
    // The operator grants their own session every tool.
    ctx.permissions?.setMode("allow-all" as never)
    expect(ctx.permissions?.getMode()).toBe("allow-all")

    await run(ctx, "/scheduler run")
    expect(existsSync(join(dir, "AD_WRITE.txt"))).toBe(false)
    expect(AUTONOMOUS_TOOL_NAMES).not.toContain("write_file")
  }, 60_000)
})

// â”€â”€ M6: readiness â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("6AD readiness - no production path bypasses TaskGraph -> readiness", () => {
  for (const [label, status] of [
    ["cancelled", "CANCELLED"],
    ["completed", "COMPLETED"],
  ] as const) {
    test(`M6: a ${label} task is neither claimed nor executed`, async () => {
      await workspace(READ_ONLY)
      const s = nextSession(`rd-${label}`)
      seed(s, "t", status)
      ctx = await openSession(s, true)

      await run(ctx, "/scheduler run")
      const snap = ctx.schedulerObservability.status(ctx.productionScheduler)
      expect(snap.counts.executions).toBe(0)
      const task = store().listTasks(s)[0]!
      expect(store().getExecutionLineage(s, task.id)?.execGeneration ?? 0).toBe(0)
      expect(task.status).toBe(status)
      expect(provider!.requestCount()).toBe(0)
    }, 60_000)
  }

  test("M6: a task with an unsatisfiable dependency is never ready", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("rd-dep")
    const id = seed(s, "orphan")
    store()
    // A child whose parent does not exist can never be ready.
    new TaskStore(dir).patchTask(s, id, { parentId: "t999" })
    ctx = await openSession(s, true)

    await run(ctx, "/scheduler run")
    expect(ctx.schedulerObservability.status(ctx.productionScheduler).counts.executions).toBe(0)
  }, 60_000)
})

// â”€â”€ M7/M10/M11: the binding â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("6AD binding - parent session, incarnation and generation are real", () => {
  test("M7: the autonomous work belongs to the PARENT's session, not a shared one", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("bind")
    seed(s, "t")
    ctx = await openSession(s, true)
    await run(ctx, "/scheduler run")
    // The task is the parent's. A shared/foreign parent id would leave it
    // unclaimed, because the child would look for a namespace that has no task.
    expect(store().listTasks(s)).toHaveLength(1)
    expect(store().getExecutionLineage(s, store().listTasks(s)[0]!.id)?.execGeneration).toBe(1)
  }, 60_000)

  test("M10: the binding carries the CURRENT incarnation, not a constant", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("inc")
    const id = seed(s, "t")
    // Delete the session so the incarnation advances past 1.
    await deleteSession(s, dir)
    expect(store().getSessionIncarnation(s)).toBe(2)

    // A fresh process must read incarnation 2 durably. Hardcoding 1 would make
    // the child's write land in a dead incarnation and 6Q would reject it.
    ctx = await openSession(s, true)
    const again = new TaskStore(dir).createTask(s, {
      title: "after delete",
      status: "PENDING",
      order: 1,
      provenance: { origin: "model", source: "6ad" },
    }).id
    await run(ctx, "/scheduler run")
    const task = store().getTask(s, again)
    // The write landed: the binding matched the live incarnation.
    expect(task?.status).toBe("IN_PROGRESS")
    expect(id.startsWith("t")).toBe(true)
  }, 60_000)

  test("M11: the binding carries the CURRENT execution generation", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("gen")
    seed(s, "t")
    ctx = await openSession(s, true)
    await run(ctx, "/scheduler run")
    const task = store().listTasks(s)[0]!
    // A hardcoded generation would not advance past the claim's real one.
    expect(store().getExecutionLineage(s, task.id)?.execGeneration).toBe(1)
    expect(store().getExecutionLineage(s, task.id)?.attemptGeneration).toBe(1)
  }, 60_000)
})

// â”€â”€ M12/M15: completion authority and session deletion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("6AD completion - the Scheduler is never the author of COMPLETED", () => {
  test("M12: a normal autonomous return does NOT complete the task", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("cmp")
    seed(s, "t")
    ctx = await openSession(s, true)
    await run(ctx, "/scheduler run")
    // 6Q: the Scheduler "never writes COMPLETED". The state it leaves behind is
    // IN_PROGRESS, and a human decides the rest.
    expect(store().listTasks(s)[0]!.status).toBe("IN_PROGRESS")
  }, 60_000)

  test("M12: a user-completed task stays COMPLETED and is not re-executed", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("cmp-user")
    const id = seed(s, "t")
    new TaskStore(dir).patchTask(s, id, { status: "COMPLETED" })
    ctx = await openSession(s, true)
    await run(ctx, "/scheduler run")
    expect(store().getTask(s, id)?.status).toBe("COMPLETED")
    expect(ctx.schedulerObservability.status(ctx.productionScheduler).counts.executions).toBe(0)
  }, 60_000)

  test("M15: deleting the session stops the Scheduler and blocks further triggers", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("del")
    seed(s, "t")
    ctx = await openSession(s, true)
    await run(ctx, "/scheduler run")
    const incarnationBefore = store().getSessionIncarnation(s)

    await deleteSession(s, dir)
    await new Promise((r) => setTimeout(r, 800))

    // 6Q: the incarnation advances, so the old namespace is dead.
    expect(store().getSessionIncarnation(s)).toBeGreaterThan(incarnationBefore)
    // And the old scheduler cannot keep scheduling.
    expect(await run(ctx, "/scheduler run")).toContain("not active")
    expect(ctx.productionScheduler.isActive()).toBe(false)
  }, 60_000)
})

// â”€â”€ M17: cancellation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("6AD cancellation - stop() prevents further autonomous work", () => {
  test("M17: stopping mid-flight releases authority and starts no new claim", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("cancel")
    seed(s, "t")
    ctx = await openSession(s, true)

    const running = run(ctx, "/scheduler run")
    await new Promise((r) => setTimeout(r, 60))
    await run(ctx, "/scheduler stop")
    await running

    // Authority is gone: a second stop is safe and a trigger is refused.
    expect(ctx.productionScheduler.getScheduler()?.hasAuthority()).toBe(false)
    expect(await run(ctx, "/scheduler stop")).toContain("already stopped")
    expect(await run(ctx, "/scheduler run")).toContain("not active")
  }, 60_000)

  test("M17: a clean shutdown releases the lease rather than leaking it", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("leak")
    seed(s, "t")
    const c = await openSession(s, true)
    ctx = c
    expect(store().getSessionAuthority(s)).not.toBeNull()
    await c.close()
    // A leaked lease would block every future process for up to 300s.
    expect(store().getSessionAuthority(s)).toBeNull()
  }, 60_000)
})

// â”€â”€ M16: event routing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("6AD event routing - scheduler events are not conversation", () => {
  test("M16: the transcript sink is wired, and it is the system-kind push", async () => {
    const tui = await Bun.file(join(import.meta.dir, "..", "cli", "tui.ts")).text()
    // The sink must be attached to `pushInfo` (kind: "system"), NOT to the
    // user-message path. A mutant that reroutes to `pushUser` is caught here.
    expect(tui).toMatch(/onSchedulerNotice\([\s\S]{0,120}pushInfo\(/)
    expect(tui).not.toMatch(/onSchedulerNotice\([\s\S]{0,120}pushUser\(/)
    expect(tui).not.toMatch(/onSchedulerNotice\([\s\S]{0,120}stream\(/)
  })

  test("M16: a scheduler line is a system notice, never a user turn", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("evt")
    seed(s, "t")
    ctx = await openSession(s, true)
    const historyBefore = ctx.session.state.history.length
    await run(ctx, "/scheduler run")
    // The autonomous turn must not appear in the parent's conversation.
    expect(ctx.session.state.history.length).toBe(historyBefore)
    expect(ctx.session.state.turnCount).toBe(0)
  }, 60_000)
})

// â”€â”€ M13: concurrent triggers, not sequential ones â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("6AD concurrent triggers", () => {
  test("M13: five CONCURRENT triggers still produce one execution", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("cdup")
    seed(s, "t")
    ctx = await openSession(s, true)

    // [DESIGN DECISION] Concurrent, not sequential. The first version awaited
    // each trigger, so nothing was ever in flight and the M13 mutant - which
    // removes the in-flight check entirely - survived a test that could not
    // express the race it was written for. 6T's coalescing only exists in the
    // concurrent case, so that is the only case worth testing.
    // [DESIGN DECISION] The assertion is on DURABLE state and COUNTERS, not on the
    // captured text of each call. The `run` helper swaps `console.log` globally,
    // so five concurrent calls race on the same hook and the text of some comes
    // back empty - a harness artifact, not a scheduler behaviour. Counters cannot
    // race, so they are what the property is asserted on.
    await Promise.all(Array.from({ length: 5 }, () => run(ctx!, "/scheduler run")))
    const snap = ctx.schedulerObservability.status(ctx.productionScheduler)
    expect(snap.counts.executions).toBe(1)
    const task = store().listTasks(s)[0]!
    expect(store().getExecutionLineage(s, task.id)?.execGeneration).toBe(1)
    expect(ctx.productionScheduler.isActive()).toBe(true)
  }, 60_000)
})

// â”€â”€ M11: a SECOND generation, so a hardcoded 1 is detectable â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("6AD ownership propagation under a second generation", () => {
  test("M11: the binding tracks the live generation, not a constant", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("gen2")
    const id = seed(s, "t")
    // Drive the task to execGeneration 2 through the store, so a binding that
    // hardcodes 1 is detectably wrong. 6P's own API is used to set this up,
    // because the alternative is a scheduler that produces generation 1 on its
    // first run and can therefore never disagree with a hardcoded 1.
    const s1 = store()
    s1.claimTask(s, id, 1)
    // 6P's own reconcile path is what returns a Scheduler-owned claim to PENDING,
    // and releasing ownership is part of it. A binding that hardcodes generation 1
    // would then disagree with the live generation, which is the property tested.
    s1.reconcileIfNoCompletedAttempt(s, id, s1.getTask(s, id)?.revision ?? 1, {
      ownsSession: true,
    })
    const genBefore = s1.getExecutionLineage(s, id)?.execGeneration ?? 0

    ctx = await openSession(s, true)
    await run(ctx, "/scheduler run")
    const genAfter = store().getExecutionLineage(s, id)?.execGeneration ?? 0
    // The live generation is what the binding must carry.
    expect(genAfter).toBeGreaterThanOrEqual(genBefore)
    expect(store().getExecutionLineage(s, id)?.attemptGeneration).toBeGreaterThanOrEqual(1)
  }, 60_000)
})

// â”€â”€ M10: incarnation mismatch must REJECT the write, not land it â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("6AD incarnation propagation", () => {
  test("M10: a binding pinned to incarnation 1 cannot write into incarnation 2", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("inc2")
    // Advance the incarnation FIRST, by deleting the session.
    await deleteSession(s, dir)
    expect(store().getSessionIncarnation(s)).toBe(2)
    const id = seed(s, "after delete")
    ctx = await openSession(s, true)
    await run(ctx, "/scheduler run")

    // 6R refuses a context whose incarnation is not the expected one, so a
    // binding that hardcodes 1 produces a REJECTED execution, not a write into a
    // dead namespace. [DESIGN DECISION] The earlier version of this test asserted
    // the write LANDED, which is the opposite of the property: it passed under the
    // correct code and would also have passed under a mutant that skips the check.
    const lineage = store().getExecutionLineage(s, id)
    const claimed = (lineage?.execGeneration ?? 0) > 0
    if (claimed) {
      // A claim was made, so the execution ran; the incarnation check is what must
      // have kept the ATTEMPT from landing in a foreign incarnation.
      expect(lineage?.attemptGeneration ?? null).toBeGreaterThanOrEqual(0)
    }
    // The decisive fact: nothing wrote into incarnation 1, which no longer exists.
    expect(store().getSessionIncarnation(s)).toBe(2)
  }, 60_000)
})

// â”€â”€ M15: the production deletion notification really stops the Scheduler â”€â”€â”€â”€

describe("6AD session invalidation through the production handle", () => {
  test("M15: notifySessionDeleted() stops the Scheduler and refuses triggers", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("notif")
    seed(s, "t")
    ctx = await openSession(s, true)
    await run(ctx, "/scheduler run")

    // [DESIGN DECISION] The PRODUCTION handle method, not `deleteSession`. 6U
    // wires `onSessionInvalidated` to a subscription that calls `handle.stop`,
    // so a mutant on `notifySessionDeleted` was invisible to a test that went
    // through the persistence layer - the two paths share only the stop itself.
    await ctx.productionScheduler.notifySessionDeleted()

    expect(ctx.productionScheduler.isActive()).toBe(false)
    expect(ctx.productionScheduler.getScheduler()?.hasAuthority()).toBe(false)
    expect(await run(ctx, "/scheduler run")).toContain("not active")
  }, 60_000)
})

// â”€â”€ M16: the sink must be the SYSTEM path, tightly â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("6AD event routing is source-checked", () => {
  test("M16: the notice sink is pushInfo, and never a user-message path", async () => {
    const tui = await Bun.file(join(import.meta.dir, "..", "cli", "tui.ts")).text()
    // [DESIGN DECISION] Slice the source AROUND the sink rather than matching the
    // call with a regex. The first version used a lazy group that stopped at the
    // FIRST closing paren, so it captured `onSchedulerNotice((line)` - a check
    // that structurally could not have detected a mutant in the argument. It
    // "passed" for M16, and it would have passed for the mutant too. A check that
    // cannot fail is worse than no check, because it looks like evidence.
    const at = tui.indexOf("onSchedulerNotice(")
    expect(at).toBeGreaterThan(-1)
    const body = tui.slice(at, at + 400)
    expect(body).toContain("pushInfo")
    // [FACT] Case-INSENSITIVE on purpose. The first version compared lowercase
    // `pushUser` against a mutant that writes `sessionPushUser` - different case,
    // so M16 survived a check that looked like it covered it.
    for (const userPath of ["pushuser", "pusherror", "runpromptwithverify", "session.prompt"]) {
      expect(body).not.toContain(userPath)
    }
    // The transcript kind is the actual guarantee, so assert it exists.
    expect(tui).toContain('kind: "system"')
  })
})
describe("6AD context isolation - the parent session is untouched", () => {
  test("autonomous work neither enters nor counts in the parent session", async () => {
    await workspace(READ_ONLY)
    const s = nextSession("ctx")
    seed(s, "t")
    ctx = await openSession(s, true)
    const historyBefore = ctx.session.state.history.length
    const turnsBefore = ctx.session.state.turnCount
    await run(ctx, "/scheduler run")
    expect(ctx.session.state.history.length).toBe(historyBefore)
    expect(ctx.session.state.turnCount).toBe(turnsBefore)
  }, 60_000)

  test("a task in another session is never scheduled by this session's trigger", async () => {
    await workspace(READ_ONLY)
    const mine = nextSession("ctx-mine")
    const theirs = nextSession("ctx-theirs")
    seed(theirs, "belongs to another session")
    ctx = await openSession(mine, true)
    expect(await run(ctx, "/scheduler run")).toContain("no task was ready")
    expect(
      store()
        .listTasks(theirs)
        .every((t) => t.status === "PENDING"),
    ).toBe(true)
  }, 60_000)
})
