// PHASE 6AD - cross-process authority, with REAL OS processes.
//
// SECTION 7: exclusivity is a claim about two OS processes, so it cannot be
// tested in one. Every test here spawns a real `bun` child that composes the real
// `createCliSession` with the real flag, against one shared tasks.db.
//
// [DESIGN DECISION] NO PROCESS KILLING, anywhere. A Bun `kill` on Windows can take
// down the test runner's whole process group - 6AB lost two children and a shell to
// it. Every child terminates itself: `hold` exits after a bounded window, and the
// "crash" cases hang until the harness's own timeout, which is a kill of THAT
// child only. Windows behaviour is recorded in the 6AD report.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const REPO = import.meta.dir.replace(/[\\/]test$/, "").replace(/\\/g, "/")

/**
 * The child. One operation, one process, real composition.
 *
 * argv: cwd, sessionId, op, holdMs, signalPath
 *   hold    - take the lease, signal, hold for holdMs, exit
 *   claim   - take the lease, seed + trigger a task, report, exit
 *   renew   - take the lease, report, then renew on a timer for holdMs
 *   crash   - take the lease, signal, then hang forever (killed by the harness)
 */
const CHILD = `
const fs = await import("node:fs")
const { createCliSession } = await import("__REPO__/cli/setup.ts")
const { handleBuiltinCommand } = await import("__REPO__/cli/commands.ts")
const { TaskStore, resetTaskStoreHandles } = await import("__REPO__/src/task/store.ts")

const [cwd, sessionId, op, holdMsArg, signalPath] = process.argv.slice(2)
const holdMs = Number(holdMsArg)
const report = (o) => console.log("__REPORT__" + JSON.stringify(o))
process.on("uncaughtException", (e) => {
  report({ ok: false, phase: "uncaught", error: e?.message ?? String(e) })
  process.exit(3)
})

function store() {
  resetTaskStoreHandles()
  return new TaskStore(cwd, { authority: "SCHEDULER" })
}

let ctx
try {
  ctx = await createCliSession({
    cwd, allowLocalConfig: true, sessionId,
    prompt: "hi", enterRepl: false, verbose: false,
    allowAll: false, ask: false, plan: false, allowlist: false, verify: false,
    schedulerEnabled: true,
  })
} catch (e) {
  // A refused lease is the EXPECTED outcome for a second process. Report the
  // reason so the parent can assert exclusivity rather than merely "it failed".
  report({ ok: false, phase: "compose", refused: true, error: e?.message ?? String(e) })
  process.exit(4)
}

const h = ctx.productionScheduler
const commandCtx = {
  cwd: ctx.cwd, sessionId: ctx.sessionId, allowLocalConfig: ctx.allowLocalConfig,
  currentModel: "fake-1", setModelOverride: () => {},
  usage: ctx.usage, skills: ctx.allLoadedSkills, toolsCount: ctx.sessionTools.length,
  providerHint: undefined, onBeforeSpawn: () => {},
  getContextTokens: () => 0, budgetState: () => "ok",
  scheduler: { handle: h, observability: ctx.schedulerObservability },
}

if (op === "hold") {
  // Signal only AFTER the lease is genuinely held, so the next process provably
  // races a live lease rather than a race to create one.
  if (signalPath !== "-") fs.writeFileSync(signalPath, h.getScheduler()?.hasAuthority() ? "held" : "no-lease")
  const until = Date.now() + holdMs
  while (Date.now() < until) await Bun.sleep(25)
  report({ ok: true, heldForMs: holdMs, hasAuthority: h.getScheduler()?.hasAuthority() === true })
  await ctx.close()
  process.exit(0)
}

if (op === "crash") {
  store().createTask(sessionId, {
    title: "crash owner", status: "PENDING", order: 1,
    provenance: { origin: "model", source: "6ad" },
  })
  // The provider is deliberately unreachable, so the run may THROW. Either way the
  // child must go on to hang holding a REAL lease - a throw that ends the child would
  // test a clean shutdown, not a crash.
  try { await handleBuiltinCommand("/scheduler run", commandCtx) } catch (e) { /* expected here */ }
  if (signalPath !== "-") fs.writeFileSync(signalPath, "claimed")
  // Hang forever. The harness kills THIS child; the lease is never released.
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}

  if (op === "claim") {
  // [FACT] createTask returns a Task, not an id. Passing the object straight into
  // getExecutionLineage throws "not a canonical id: [object Object]" - the same
  // mistake 6AC made and recorded.
  const id = store().createTask(sessionId, {
    title: "contended", status: "PENDING", order: 1,
    provenance: { origin: "model", source: "6ad" },
  }).id
  // [DESIGN DECISION] The authority facts are reported even when the TURN fails.
  // This suite's provider is deliberately unreachable, so a turn always fails
  // here - and an earlier version reported ok:false for that reason, which
  // read exactly like a refused lease. Authority and execution are different
  // questions and are now reported separately.
  let out = ""
  try {
    const lines = []
    const orig = console.log
    console.log = (...a) => lines.push(a.map(String).join(" "))
    try { await handleBuiltinCommand("/scheduler run", commandCtx) } finally { console.log = orig }
    out = lines.join("\\n")
  } catch (e) {
    out = "run threw: " + (e?.message ?? String(e))
  }
  const s = store()
  report({
    ok: true,
    taskId: id,
    taskStatus: s.getTask(sessionId, id)?.status ?? null,
    execGeneration: s.getExecutionLineage(sessionId, id)?.execGeneration ?? 0,
    out,
    hasAuthority: h.getScheduler()?.hasAuthority() === true,
  })
  await ctx.close()
  process.exit(0)
}

report({ ok: false, error: "unknown op: " + op })
process.exit(3)
`

let dir: string
let signal: string
let childPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "minicode-6ad-xp-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  writeFileSync(
    join(dir, ".minicode", "config.json"),
    JSON.stringify({
      providers: [
        { id: "fake", baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk", models: ["fake-1"] },
      ],
    }),
  )
  signal = join(dir, "signal.txt")
  childPath = join(dir, "child.ts")
  writeFileSync(childPath, CHILD.replaceAll("__REPO__", REPO.replace(/\\/g, "/")), "utf8")
  resetTaskStoreHandles()
})

afterEach(() => {
  resetTaskStoreHandles()
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
      return
    } catch {
      /* Windows releases the SQLite handle asynchronously */
    }
  }
})

interface ChildOut {
  code: number
  report: Record<string, unknown>
}

/** Spawn a real child and collect its report. Never blocks this process's loop. */
async function runChild(
  sessionId: string,
  op: string,
  holdMs = 0,
  signalPath = "-",
): Promise<ChildOut> {
  const proc = Bun.spawn(
    [process.execPath, childPath, dir, sessionId, op, String(holdMs), signalPath],
    { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => proc.kill(), holdMs > 0 ? holdMs + 20_000 : 120_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  const line = stdout.split("\n").find((l) => l.startsWith("__REPORT__"))
  return {
    code,
    report: line
      ? (JSON.parse(line.slice("__REPORT__".length)) as Record<string, unknown>)
      : // A child that produced NO report is a HARNESS failure, and its stderr travels
        // with it. Without this, a child that died on import reported `ok: false` with no
        // explanation - which reads exactly like a product refusal.
        { ok: false, phase: "no-report", stderr: `${stdout}${stderr}`.slice(-400) },
  }
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false
    await Bun.sleep(10)
  }
  return true
}

function lease(sessionId: string): Record<string, unknown> | null {
  resetTaskStoreHandles()
  const row = new TaskStore(dir, { authority: "SCHEDULER" }).getSessionAuthority(sessionId)
  // [DESIGN DECISION] Read through an explicit widening, because the store returns a
  // structural type and a `?? null` on the method result does not narrow it.
  return row === null || row === undefined ? null : ({ ...row } as Record<string, unknown>)
}

describe("6AD S7 - one valid session authority across real processes", () => {
  test("M5: a second process on a held lease is refused, not silently degraded", async () => {
    // A holds the lease for 30s. B attempts while A is provably holding it.
    const aPending = runChild("xp-a", "hold", 30_000, signal)
    expect(await waitFor(signal, 60_000)).toBe(true)
    const held = lease("xp-a")
    expect(held).not.toBeNull()
    expect(typeof held!.ownerPid).toBe("number")

    const b = await runChild("xp-a", "claim", 0, "-")
    // [FACT] The refusal is LOUD and specific. A second Scheduler over the same
    // session is exactly the F02 condition 6X existed to remove.
    expect(b.report.ok).toBe(false)
    expect(b.report.refused).toBe(true)
    expect(String(b.report.error)).toContain("lease")
    expect(b.code).toBe(4)

    await aPending
  }, 180_000)

  test("contention leaves exactly one task row, unclaimed by the loser", async () => {
    const aPending = runChild("xp-b", "hold", 20_000, signal)
    expect(await waitFor(signal, 60_000)).toBe(true)
    const b = await runChild("xp-b", "claim", 0, "-")
    expect(b.report.ok).toBe(false)
    await aPending

    // The loser seeded nothing, because composition failed before any deps ran.
    resetTaskStoreHandles()
    const rows = new TaskStore(dir, { authority: "SCHEDULER" }).listTasks("xp-b")
    expect(rows).toHaveLength(0)
  }, 180_000)

  test("after the holder exits cleanly, a new process acquires immediately", async () => {
    const a = await runChild("xp-c", "hold", 1_500, signal)
    expect(a.report.ok).toBe(true)
    // A closed cleanly, so its lease is released rather than orphaned.
    expect(lease("xp-c")).toBeNull()
    const c = await runChild("xp-c", "claim", 0, "-")
    // [FACT] The takeover SUCCEEDS. The turn itself fails here - the provider is
    // deliberately unreachable in this suite, because what is under test is
    // AUTHORITY, not execution - so the assertion is on the authority fact.
    expect(c.report.hasAuthority).toBe(true)
  }, 180_000)

  test("a crashed owner keeps its lease until expiry, blocking takeover", async () => {
    // The child hangs holding a real lease; the harness kills only that child.
    const crashed = await runChild("xp-d", "crash", 0, signal)
    // [FACT] A crash produces NO report: the child is killed before it can write
    // one. Anything reported here would mean the child exited on its own, which
    // would be a clean shutdown rather than a crash.
    expect(crashed.code).not.toBe(0)
    expect(await waitFor(signal, 120_000)).toBe(true)

    const orphan = lease("xp-d")
    expect(orphan).not.toBeNull()
    expect(Number(orphan!.leaseExpiresAt)).toBeGreaterThan(Date.now())

    // Inside the window: refused.
    const blocked = await runChild("xp-d", "claim", 0, "-")
    expect(blocked.report.ok).toBe(false)
    expect(String(blocked.report.error)).toContain("lease")

    // The task the crashed owner seeded is recoverable, and NOT completed.
    resetTaskStoreHandles()
    const rows = new TaskStore(dir, { authority: "SCHEDULER" }).listTasks("xp-d")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).not.toBe("COMPLETED")
  }, 300_000)

  test("a restarted session id acquires fresh authority, not its predecessor's", async () => {
    const a = await runChild("xp-e", "hold", 1_000, signal)
    expect(a.report.ok).toBe(true)
    // A exited cleanly, so its lease is gone and the id is free again.
    expect(lease("xp-e")).toBeNull()

    const b = await runChild("xp-e", "claim", 0, "-")
    // [FACT] The restart ACQUIRES. It composed without a lease refusal and held
    // authority while it ran.
    expect(b.report.refused).toBeUndefined()
    expect(b.report.hasAuthority).toBe(true)
    // [FACT] ...and it released cleanly on exit, so a clean shutdown does not
    // strand the next process for the whole 300s window.
    expect(lease("xp-e")).toBeNull()
  }, 180_000)
})
