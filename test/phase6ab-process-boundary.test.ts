// PHASE 6AB S19 - PROCESS BOUNDARY.
//
// [DESIGN DECISION] Real `bun` processes, in-process copies, and file barriers -
// never a sleep. 6Y established the rule: a sleep-based barrier makes a race
// probabilistic, and a mutant that only wins half the time is a campaign failure
// dressed as a pass.
//
// The child runs the REAL production composition: `createCliSession` with
// `schedulerEnabled: true`, the real `createProductionScheduler`, the real lease,
// and the real `/scheduler run` command route. Nothing in the child is a mock.
// The only controlled input is the provider base URL, which points at a local
// scripted HTTP endpoint started by the parent.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deleteSession } from "../src/session/persistence.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { type FakeProvider, startFakeProvider } from "./helpers/fake-provider.ts"

const REPO = import.meta.dir.replace(/[\\/]test$/, "").replace(/\\/g, "/")

const LEASE = 300_000

/**
 * The child. argv:
 *   1 cwd            workspace
 *   2 sessionId
 *   3 enabled        "1" | "0"
 *   4 resumeId       "-" for none
 *   5 action         "none" | "fire" | "stop" | "hold" | "crash"
 *   6 barrier        file to wait for before acting, "-" for none
 *   7 signal         file to write once armed, "-" for none
 *   8 providerBaseUrl  "-" for none
 */
const CHILD = `
const fs = await import("node:fs")
const { createCliSession } = await import("__REPO__/cli/setup.ts")
const { handleBuiltinCommand } = await import("__REPO__/cli/commands.ts")

const [cwd, sessionId, enabled, resumeId, action, barrier, signal, providerBaseUrl] =
  process.argv.slice(2)

const report = (o) => console.log("__REPORT__" + JSON.stringify(o))
process.on("uncaughtException", (e) => {
  report({ ok: false, phase: "uncaught", error: e?.message ?? String(e) })
  process.exit(3)
})

async function awaitFile(path, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(path)) {
    if (Date.now() > deadline) throw new Error("barrier timeout: " + path)
    await Bun.sleep(2)
  }
}

/** Build the provider config so the real router has somewhere to go. */
if (providerBaseUrl !== "-") {
  fs.mkdirSync(cwd + "/.minicode", { recursive: true })
  fs.writeFileSync(
    cwd + "/.minicode/config.json",
    JSON.stringify({
      providers: [{ id: "fake", baseUrl: providerBaseUrl, apiKey: "sk-test", models: ["fake-1"] }],
    }),
  )
}

let ctx
try {
  ctx = await createCliSession({
    cwd,
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
    schedulerEnabled: enabled === "1",
    ...(resumeId !== "-" ? { resumeId } : {}),
  })
} catch (e) {
  // A refused lease is a LOUD startup failure (6AA verified this). Report it as
  // a refusal rather than a crash, so the parent can assert on the reason.
  report({ ok: false, phase: "compose", error: e?.message ?? String(e) })
  process.exit(4)
}

const h = ctx.productionScheduler
const base = {
  ok: true,
  sessionId: ctx.sessionId,
  constructed: h.constructed,
  enabled: h.enabled,
  active: h.isActive(),
  hasAuthority: h.getScheduler()?.hasAuthority() ?? false,
  token: h.getScheduler()?.authorityToken ?? null,
  state: ctx.schedulerObservability.state(h),
}

if (action === "hold") {
  // Arm, tell the parent the lease is held, then hold it for a BOUNDED window and
  // exit on our own.
  //
  // [DESIGN DECISION] No kill(9). On Windows a Bun kill can take down the whole
  // process group - including the test runner and the shell that launched it -
  // so every child in this campaign terminates itself. The window is generous
  // (20s) against a second child that only has to start, compose and refuse.
  if (signal !== "-") fs.writeFileSync(signal, "held")
  const until = Date.now() + 20000
  while (Date.now() < until) await Bun.sleep(50)
  report({ ...base, phase: "hold-expired" })
  process.exit(0)
}

if (action === "crash") {
  // Take the lease and die WITHOUT releasing it: a killed process.
  report({ ...base, phase: "crashed" })
  process.exit(9)
}

if (barrier !== "-") await awaitFile(barrier)

const commandCtx = {
  cwd: ctx.cwd,
  sessionId: ctx.sessionId,
  allowLocalConfig: ctx.allowLocalConfig,
  currentModel: "fake-1",
  setModelOverride: () => {},
  usage: ctx.usage,
  skills: ctx.allLoadedSkills,
  toolsCount: ctx.sessionTools.length,
  providerHint: undefined,
  onBeforeSpawn: () => {},
  getContextTokens: () => 0,
  budgetState: () => "ok",
  scheduler: { handle: ctx.productionScheduler, observability: ctx.schedulerObservability },
}

let out = ""
if (action === "fire" || action === "stop") {
  // "fire" is this harness's name for the action; the production command verb is
  // "run". Mapping here keeps the argv vocabulary ("crash"/"hold") separate from
  // the user-facing one, so a change to the command's verbs cannot silently
  // invalidate the campaign.
  const verb = action === "fire" ? "run" : "stop"
  const lines = []
  const orig = console.log
  console.log = (...a) => lines.push(a.map(String).join(" "))
  try {
    await handleBuiltinCommand("/scheduler " + verb, commandCtx)
  } finally {
    console.log = orig
  }
  out = lines.join("\\n")
}

const after = {
  ...base,
  action,
  out,
  evaluations: ctx.schedulerObservability.status(h).counts.evaluations,
  executions: ctx.schedulerObservability.status(h).counts.executions,
  lastCycleStop: ctx.schedulerObservability.lastCycleStopReason,
  stateAfter: ctx.schedulerObservability.state(h),
  activeAfter: h.isActive(),
  authorityAfter: h.getScheduler()?.hasAuthority() ?? false,
}
report(after)
await ctx.close()
process.exit(0)
`

let dir: string
let provider: FakeProvider | null = null
const CHILD_PATH = join(import.meta.dir, "phase6ab-process-child.tmp.ts")

/**
 * Materialise the child exactly once, with `__REPO__` bound to this checkout.
 *
 * Written to a `.tmp.ts` name so `bun test` (which globs `*.test.ts`) never
 * collects it as a suite of its own.
 */
beforeAll(async () => {
  await writeFile(CHILD_PATH, CHILD.replaceAll("__REPO__", REPO), "utf8")
})

afterAll(async () => {
  await rm(CHILD_PATH, { force: true }).catch(() => {})
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6abp-"))
  resetTaskStoreHandles()
  resetSessionOwnershipForTests()
})

afterEach(async () => {
  // [DESIGN DECISION] No process killing anywhere in this file. Every child
  // terminates itself (report-and-exit, or a bounded `hold` window), because a
  // Bun kill on Windows can take down the test runner's whole process group.
  provider?.close()
  provider = null
  resetTaskStoreHandles()
  resetSessionOwnershipForTests()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

function seedTask(sessionId: string, title: string): string {
  return new TaskStore(dir, { authority: "SCHEDULER" }).createTask(sessionId, {
    title,
    status: "PENDING",
    order: 1,
    provenance: { origin: "model", source: "6ab-proc" },
  }).id
}

interface ChildReport {
  ok: boolean
  phase?: string
  error?: string
  sessionId?: string
  constructed?: boolean
  enabled?: boolean
  active?: boolean
  hasAuthority?: boolean
  token?: string | null
  state?: string
  action?: string
  out?: string
  evaluations?: number
  executions?: number
  lastCycleStop?: string | null
  stateAfter?: string
  activeAfter?: boolean
  authorityAfter?: boolean
}

async function runChild(
  sessionId: string,
  opts: {
    enabled?: boolean
    resumeId?: string | null
    action?: string
    barrier?: string
    signal?: string
    withProvider?: boolean
  } = {},
): Promise<{ report: ChildReport; exitCode: number }> {
  if (opts.withProvider) {
    provider = startFakeProvider([{ kind: "text", text: "autonomous work done" }])
    await mkdir(join(dir, ".minicode"), { recursive: true })
    await writeFile(
      join(dir, ".minicode", "config.json"),
      JSON.stringify({
        providers: [
          { id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["fake-1"] },
        ],
      }),
      "utf8",
    )
  }
  const p = Bun.spawn(
    [
      "bun",
      "run",
      `${REPO}/test/phase6ab-process-child.tmp.ts`,
      dir,
      sessionId,
      opts.enabled === false ? "0" : "1",
      opts.resumeId ?? "-",
      opts.action ?? "none",
      opts.barrier ?? "-",
      opts.signal ?? "-",
      opts.withProvider ? (provider as FakeProvider).baseUrl : "-",
    ],
    { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, MINICODE_COMPACT: "1" } },
  )

  const out = await new Response(p.stdout).text()
  const code = await p.exited
  const line = out.split("\n").find((l) => l.startsWith("__REPORT__"))
  if (!line)
    throw new Error(
      "child produced no report. stdout:\n" +
        out +
        "\nstderr:\n" +
        (await new Response(p.stderr).text()),
    )
  return { report: JSON.parse(line.slice("__REPORT__".length)) as ChildReport, exitCode: code }
}

// ---------------------------------------------------------------------------
// P1 / P2
// ---------------------------------------------------------------------------

describe("6AB S19 P1/P2 - the trigger is real, and OFF has no Scheduler", () => {
  test("P1: an enabled process that triggers actually executes work", async () => {
    seedTask("p1", "do the thing")
    const { report } = await runChild("p1", { action: "fire", withProvider: true })
    expect(report.ok).toBe(true)
    expect(report.constructed).toBe(true)
    expect(report.hasAuthority).toBe(true)
    // The trigger ran, a cycle ran, and a turn was executed.
    expect(report.evaluations).toBe(1)
    expect(report.executions).toBe(1)
    expect(report.out).toContain("scheduling cycle completed")
    // Durable effect, read from a SEPARATE store handle in the parent.
    expect(new TaskStore(dir, { authority: "SCHEDULER" }).listTasks("p1")[0]!.status).toBe(
      "IN_PROGRESS",
    )
    expect(provider!.requestCount()).toBeGreaterThan(0)
  }, 120_000)

  test("P2: a disabled process on the SAME trigger path has no Scheduler at all", async () => {
    seedTask("p2", "must not run")
    const { report } = await runChild("p2", { enabled: false, action: "fire", withProvider: true })
    expect(report.ok).toBe(true)
    expect(report.constructed).toBe(false)
    expect(report.enabled).toBe(false)
    expect(report.active).toBe(false)
    expect(report.state).toBe("OFF")
    // The route exists and answers truthfully; nothing was constructed to fire.
    expect(report.out).toContain("scheduler is OFF")
    expect(report.evaluations).toBe(0)
    expect(report.executions).toBe(0)
    expect(provider!.requestCount()).toBe(0)
    expect(new TaskStore(dir, { authority: "SCHEDULER" }).listTasks("p2")[0]!.status).toBe(
      "PENDING",
    )
  }, 120_000)
})

// ---------------------------------------------------------------------------
// P3
// ---------------------------------------------------------------------------

describe("6AB S19 P3 - two enabled processes, one session", () => {
  test("P3: the second process is excluded by the lease", async () => {
    const signal = join(dir, "held.signal")
    const first = Bun.spawn(
      [
        "bun",
        "run",
        `${REPO}/test/phase6ab-process-child.tmp.ts`,
        dir,
        "p3",
        "1",
        "-",
        "hold",
        "-",
        signal,
        "-",
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    )

    // Wait for the child's own signal file: never a sleep.
    const deadline = Date.now() + 60_000
    while (!existsSync(signal)) {
      if (Date.now() > deadline) throw new Error("first child never armed")
      await Bun.sleep(5)
    }

    const second = await runChild("p3", { enabled: true, action: "fire" })
    // [FACT] The lease held by the live process excludes the newcomer LOUDLY:
    // construction throws, it does not silently produce a second Scheduler.
    expect(second.report.ok).toBe(false)
    expect(second.exitCode).toBe(4)
    expect(second.report.error).toContain("lease")

    // The first child exits by itself when its hold window expires; awaiting it
    // here keeps the assertion honest without signalling a process group.
    await first.exited
  }, 120_000)
})

// ---------------------------------------------------------------------------
// P4 / P5
// ---------------------------------------------------------------------------

describe("6AB S19 P4/P5 - deletion and restart", () => {
  test("P4: a session deleted by another process cannot be scheduled", async () => {
    seedTask("p4", "t")
    const first = await runChild("p4", { action: "none", withProvider: true })
    expect(first.report.ok).toBe(true)
    expect(first.report.hasAuthority).toBe(true)

    // Delete the session through the PRODUCTION deletion path, from the parent -
    // exactly what `/sessions` delete does, including the incarnation bump that
    // makes the old namespace unusable.
    await deleteSession("p4", dir)
    const incarnation = new TaskStore(dir, { authority: "SCHEDULER" }).getSessionIncarnation("p4")
    expect(incarnation).toBeGreaterThan(1)

    // A second, fully enabled process must not be able to continue the old
    // lifecycle: the task namespace it would schedule is gone.
    const second = await runChild("p4", { action: "fire" })
    expect(second.report.ok).toBe(true)
    expect(second.report.constructed).toBe(true)
    // A cycle ran and found nothing - no execution was possible.
    expect(second.report.evaluations).toBe(1)
    expect(second.report.executions).toBe(0)
    expect(second.report.lastCycleStop).toBe("no-candidates")
    expect(provider!.requestCount()).toBe(0)
  }, 120_000)

  test("P5: a restarted process cannot continue the old authority", async () => {
    // Child 1 takes the lease and is killed without releasing it.
    const crashed = await runChild("p5", { action: "crash" })
    expect(crashed.report.ok).toBe(true)
    expect(crashed.report.hasAuthority).toBe(true)
    const oldToken = crashed.report.token
    expect(oldToken).toBeTruthy()

    // The lease row survives the crash; a restart inside the lease window must
    // fail closed rather than inherit it.
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    const row = store.getSessionAuthority("p5")
    expect(row?.ownerToken).toBeTruthy()
    expect(row?.ownerToken).toBe(oldToken as string | undefined)
    expect(row!.leaseExpiresAt).toBeGreaterThan(Date.now())

    const restarted = await runChild("p5", { action: "fire" })
    expect(restarted.report.ok).toBe(false)
    expect(restarted.exitCode).toBe(4)
    expect(restarted.report.error).toContain("lease")
    expect(LEASE).toBe(300_000)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// P6
// ---------------------------------------------------------------------------

describe("6AB S19 P6 - resume", () => {
  test("P6: resuming composes a new, valid lifecycle", async () => {
    seedTask("p6-orig", "resumable")
    const first = await runChild("p6-orig", { action: "none", withProvider: true })
    expect(first.report.ok).toBe(true)

    // Resume into a NEW live id: a fork, matching persistCurrent's dual write.
    const resumed = await runChild("p6-2", {
      resumeId: "p6-orig",
      action: "fire",
      withProvider: true,
    })
    expect(resumed.report.ok).toBe(true)
    expect(resumed.report.sessionId).toBe("p6-2")
    expect(resumed.report.constructed).toBe(true)
    expect(resumed.report.hasAuthority).toBe(true)
    expect(resumed.report.token).not.toBe(first.report.token)
    // The live session has no ready task; the resumed session's task is untouched.
    expect(resumed.report.evaluations).toBe(1)
    expect(resumed.report.executions).toBe(0)
    expect(new TaskStore(dir, { authority: "SCHEDULER" }).listTasks("p6-orig")[0]!.status).toBe(
      "PENDING",
    )
  }, 120_000)
})
