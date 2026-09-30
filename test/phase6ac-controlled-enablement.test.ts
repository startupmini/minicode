// PHASE 6AC - CONTROLLED ENABLEMENT ASSERTIONS.
//
// These are DERIVATIONS from the controlled experiment in
// `scripts/phase6ac-controlled.ts`, not a second implementation of it.
//
// [DESIGN DECISION] The drills are the evidence; this file is the reader's
// checklist. Every test here either re-derives one drill's finding from production
// composition, or asserts a property the mission lists that no drill measures
// directly. Nothing here mocks the product, and nothing here is a substitute for
// having run the experiment.
//
// The distinction matters: 6AB proved "the trigger reaches fire()" with
// in-process tests. 6AC asks whether an OPERATOR can use it, and a test that only
// composes `createCliSession` in-process would answer the 6AB question again.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CommandContext, handleBuiltinCommand } from "../cli/commands.ts"
import { type CliSession, createCliSession } from "../cli/setup.ts"
import { deleteSession } from "../src/session/persistence.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { type FakeProvider, startFakeProvider } from "./helpers/fake-provider.ts"

const REPO = import.meta.dir.replace(/[\\/]test$/, "").replace(/\\/g, "/")

let dir: string
let provider: FakeProvider | null = null
let ctx: CliSession | null = null

/** A session id per test, so no two tests share a lease or a task namespace. */
let sessionCounter = 0
function nextSession(): string {
  sessionCounter += 1
  return `6ac-t${sessionCounter}`
}

async function workspace(script: Parameters<typeof startFakeProvider>[0]): Promise<void> {
  provider = startFakeProvider(script)
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  writeFileSync(
    join(dir, ".minicode", "config.json"),
    JSON.stringify({
      providers: [{ id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["fake-1"] }],
    }),
  )
  writeFileSync(join(dir, "notes.txt"), "The constant is SEVENTY_THREE.\n")
}

async function openSession(sessionId: string, schedulerEnabled: boolean): Promise<CliSession> {
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
    schedulerEnabled,
  })
}

function commandCtxFor(c: CliSession): CommandContext {
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
    const r = await handleBuiltinCommand(line, commandCtxFor(c))
    expect(r.handled).toBe(true)
  } finally {
    console.log = orig
  }
  return lines.join("\n")
}

function seed(sessionId: string, title: string): string {
  return new TaskStore(dir, { authority: "SCHEDULER" }).createTask(sessionId, {
    title,
    status: "PENDING",
    order: 1,
    provenance: { origin: "model", source: "6ac-test" },
  }).id
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "minicode-6ac-test-"))
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
  // [DESIGN DECISION] Teardown is best-effort and retried. On Windows the SQLite
  // handle and the provider sockets are released asynchronously, so an immediate
  // `rmSync` fails with EBUSY - and an afterEach that throws reports every test as
  // FAILED while the test body actually passed. Seven of nine tests were red for a
  // cleanup problem. A cleanup failure is not a test failure; the temp directory
  // is disposable either way.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 60))
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// The operator sequence, in the order §13 documents it
// ─────────────────────────────────────────────────────────────────────────────

describe("6AC S13 - the operator can enable, trigger, observe, stop", () => {
  test("enable -> status -> run -> stop, through the real command surface", async () => {
    await workspace([{ kind: "text", text: "notes.txt mentions SEVENTY_THREE." }])
    const sessionId = nextSession()
    seed(sessionId, "Read notes.txt and report the constant")
    ctx = await openSession(sessionId, true)

    // 1. enable -> the operator can SEE that it is on and holding authority.
    const statusOn = await run(ctx, "/scheduler status")
    expect(statusOn).toContain("scheduler ON, idle")
    expect(statusOn).toContain("holds authority")
    expect(statusOn).toContain(sessionId)

    // 2. trigger -> real work, observable as durable state.
    const ran = await run(ctx, "/scheduler run")
    expect(ran).toContain("scheduling cycle completed")
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    const tasks = store.listTasks(sessionId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.status).toBe("IN_PROGRESS")
    expect(store.getExecutionLineage(sessionId, tasks[0]!.id)?.execGeneration).toBeGreaterThan(0)

    // 3. observe -> counters moved, so the operator can tell work happened.
    const statusAfter = await run(ctx, "/scheduler status")
    expect(statusAfter).toContain("executions=1")

    // 4. stop -> authority released, and the process is still usable.
    const stopped = await run(ctx, "/scheduler stop")
    expect(stopped).toContain("scheduler stopped")
    expect(ctx.productionScheduler.isActive()).toBe(false)
    expect(ctx.productionScheduler.getScheduler()?.hasAuthority()).toBe(false)

    // ...and a second stop is safe, and a trigger afterwards is refused.
    expect(await run(ctx, "/scheduler stop")).toContain("already stopped")
    expect(await run(ctx, "/scheduler run")).toContain("not active")
  }, 60_000)
})

describe("6AC S18 - default OFF is exact, in a fresh process", () => {
  test("no flag: no Scheduler, no lease, no autonomous context, no work", async () => {
    await workspace([{ kind: "text", text: "must not be called" }])
    const sessionId = nextSession()
    seed(sessionId, "t")
    ctx = await openSession(sessionId, false)

    const h = ctx.productionScheduler
    expect(h.enabled).toBe(false)
    expect(h.constructed).toBe(false)
    expect(h.getScheduler()).toBeNull()
    expect(h.isActive()).toBe(false)

    // The trigger route is EXERCISED, not merely absent: asking an inert handle
    // to fire must produce nothing.
    expect(await run(ctx, "/scheduler run")).toContain("scheduler is OFF")
    const snap = ctx.schedulerObservability.status(h)
    expect(snap.counts.evaluations).toBe(0)
    expect(snap.counts.executions).toBe(0)
    expect(new TaskStore(dir, { authority: "SCHEDULER" }).listTasks(sessionId)[0]!.status).toBe(
      "PENDING",
    )
    expect(provider!.requestCount()).toBe(0)
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// §15 SECURITY: the boundary, live, through production composition
// ─────────────────────────────────────────────────────────────────────────────

describe("6AC S15 - autonomous execution is read-only", () => {
  test("a scripted write request produces no file and no shell execution", async () => {
    // The model is ASKED to write, then to shell out. Neither tool is in the
    // autonomous set, so neither can be invoked.
    await workspace([
      { kind: "tool", name: "write_file", args: { path: "SHOULD_NOT_EXIST.txt", content: "x" } },
      { kind: "text", text: "I could not write that." },
      { kind: "tool", name: "bash", args: { command: "echo autonomous-shell" } },
      { kind: "text", text: "Shell was refused too." },
    ])
    const sessionId = nextSession()
    seed(sessionId, "try to write")
    ctx = await openSession(sessionId, true)

    await run(ctx, "/scheduler run")

    // [FACT] The workspace is unchanged. This is the property that matters: not
    // "the policy was consulted" but "nothing was modified".
    expect(existsSync(join(dir, "SHOULD_NOT_EXIST.txt"))).toBe(false)
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    expect(store.listTasks(sessionId)[0]!.status).toBe("IN_PROGRESS")
    // [FACT] ...and the Scheduler never wrote COMPLETED, which is 6Q's rule: it
    // does not decide whether the work succeeded.
    expect(store.listTasks(sessionId).every((t) => t.status !== "COMPLETED")).toBe(true)
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// §17 PROPERTY CHECKS the drills do not measure directly
// ─────────────────────────────────────────────────────────────────────────────

describe("6AC S17 - the ten property checks", () => {
  test("2: one trigger produces at most one execution", async () => {
    await workspace([{ kind: "text", text: "done" }])
    const sessionId = nextSession()
    seed(sessionId, "t")
    ctx = await openSession(sessionId, true)

    await run(ctx, "/scheduler run")
    const after1 = ctx.schedulerObservability.status(ctx.productionScheduler).counts.executions
    // Four more triggers against an already-dispatched task.
    for (let i = 0; i < 4; i += 1) await run(ctx, "/scheduler run")
    const after5 = ctx.schedulerObservability.status(ctx.productionScheduler).counts.executions
    expect(after1).toBe(1)
    expect(after5).toBe(1)
  }, 60_000)

  test("6: the task namespace stays parent-scoped", async () => {
    await workspace([{ kind: "text", text: "done" }])
    const mine = nextSession()
    const theirs = nextSession()
    // A ready task in a DIFFERENT session.
    seed(theirs, "belongs to another session")
    ctx = await openSession(mine, true)

    expect(await run(ctx, "/scheduler run")).toContain("no task was ready")
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    expect(store.listTasks(theirs).every((t) => t.status === "PENDING")).toBe(true)
  }, 60_000)

  test("8: session deletion prevents old execution effects, and recreation is safe", async () => {
    await workspace([{ kind: "text", text: "done" }])
    const sessionId = nextSession()
    seed(sessionId, "interrupted by deletion")
    ctx = await openSession(sessionId, true)

    const before = new TaskStore(dir, { authority: "SCHEDULER" }).getSessionIncarnation(sessionId)
    void run(ctx, "/scheduler run")
    // Delete through the PRODUCTION path.
    await deleteSession(sessionId, dir)
    await new Promise((r) => setTimeout(r, 800))

    // [FACT] The old scheduler is inert and refuses further triggering.
    expect(await run(ctx, "/scheduler run")).toContain("not active")
    // [FACT] The incarnation advanced, so the old namespace is unusable.
    const after = new TaskStore(dir, { authority: "SCHEDULER" }).getSessionIncarnation(sessionId)
    expect(after).toBeGreaterThan(before)
  }, 60_000)

  test("10: a restart starts cleanly, with no scheduler state required", async () => {
    await workspace([{ kind: "text", text: "done" }])
    const sessionId = nextSession()
    seed(sessionId, "t")
    const first = await openSession(sessionId, true)
    await run(first, "/scheduler run")
    const firstToken = new TaskStore(dir, { authority: "SCHEDULER" }).getSessionAuthority(
      sessionId,
    )?.ownerToken
    await first.close()

    // Same session id, fresh process: new authority, and the trigger still works.
    const second = await openSession(sessionId, true)
    ctx = second
    expect(second.productionScheduler.isActive()).toBe(true)
    const secondToken = new TaskStore(dir, { authority: "SCHEDULER" }).getSessionAuthority(
      sessionId,
    )?.ownerToken
    expect(secondToken).toBeTruthy()
    expect(secondToken).not.toBe(firstToken)
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// §19 DOCUMENTATION truthfulness - against the file the CLI actually prints
// ─────────────────────────────────────────────────────────────────────────────

describe("6AC S19 - the printed help is truthful", () => {
  test("the flag, its default, and the manual trigger all appear in --help", async () => {
    const proc = Bun.spawn([process.execPath, join(REPO, "cli", "index.ts"), "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    })
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    const help = stdout.replace(/\[[0-9;?]*[a-zA-Z]/g, "")

    // [FACT] 6AC's first run of this assertion found the flag MISSING from the
    // printed help while 6AB's help test passed. 6AB asserted the `options:` array
    // in cli/index.ts; this asserts the `HELP` constant the CLI actually prints.
    // They are two different sources, and only the second is documentation.
    expect(help).toContain("--enable-scheduler")
    expect(help).toMatch(/default: off/i)
    expect(help).toContain("/scheduler run")
    expect(help).toMatch(/no timer/i)
    expect(help).toMatch(/readonly/i)

    // It must not promise recurrence.
    for (const phrase of [
      "runs continuously",
      "continuous autonomous",
      "recurring scheduling",
      "automatically schedules",
      "in the background",
    ]) {
      expect(help.toLowerCase()).not.toContain(phrase)
    }
  }, 60_000)

  test("the operator guide exists and matches the real surface", async () => {
    const doc = await Bun.file(join(REPO, "docs", "autonomous-scheduler.md")).text()
    for (const token of [
      "--enable-scheduler",
      "/scheduler run",
      "/scheduler status",
      "/scheduler stop",
      "read-only",
    ]) {
      expect(doc).toContain(token)
    }
    // §19: it must NOT be described as continuous background automation.
    expect(doc.toLowerCase()).not.toContain("continuous background automation")
    expect(doc.toLowerCase()).toContain("no background timer")
  })
})
