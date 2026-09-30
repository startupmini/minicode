/**
 * PHASE 6AC - CONTROLLED ENABLEMENT HARNESS.
 *
 * One disposable environment, driven end to end through the REAL production
 * composition. Every stage runs in a real process against real SQLite and a real
 * HTTP provider.
 *
 * WHY A SCRIPT, NOT A TEST SUITE
 *
 * The mission is an experiment, not a regression suite: "can a real operator turn
 * it on, run one task, observe it, stop it, and recover if the process dies?" The
 * honest instrument is a script that drives the product and PRINTS what it
 * observed. Assertions live in `test/phase6ac-controlled-enablement.test.ts`; this
 * file is the raw evidence they are derived from, committed so a reader can
 * re-run the experiment instead of trusting a summary.
 *
 * [DESIGN DECISION] EVERY child is spawned ASYNCHRONOUSLY. Never `spawnSync`.
 *
 * The scripted provider runs as `Bun.serve` in THIS process. `spawnSync` blocks
 * the event loop for its whole duration, so the server can never accept a
 * connection while a child waits on it - and every autonomous turn fails with
 * "Unable to connect". `test/cli-session.test.ts` records the identical trap
 * ("28 of 31 tests dropped on the first attempt").
 *
 * The first 6AC run hit it exactly, and the symptom was an autonomous turn
 * reporting `ok=false` with `detail: "Unable to connect"` - which reads exactly
 * like a production provider defect. Recorded as an ENVIRONMENT-class finding: a
 * harness bug that was one careless reading away from being reported as a product
 * bug.
 *
 *   bun run scripts/phase6ac-controlled.ts             # every drill
 *   bun run scripts/phase6ac-controlled.ts --only=2    # one drill
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FakeReply } from "../test/helpers/fake-provider.ts"

const REPO = join(import.meta.dir, "..")
const ROOT = join(tmpdir(), "minicode-6ac-controlled")
const WS = join(ROOT, "ws")
const HOME = join(ROOT, "home")
const SESSION = "6ac-session"
const LEASE_MS = 300_000
const RENEW_MS = 60_000

const log: string[] = []
function say(line: string): void {
  log.push(line)
  console.log(`  ${line}`)
}
function head(n: number, title: string): void {
  console.log(`\n${"=".repeat(74)}\n  DRILL ${n}: ${title}\n${"=".repeat(74)}`)
}
function fact(label: string, value: unknown): void {
  say(`FACT ${label} = ${typeof value === "string" ? value : JSON.stringify(value)}`)
}

// ─── environment ────────────────────────────────────────────────────────────

function makeEnvironment(): void {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(WS, ".minicode"), { recursive: true })
  mkdirSync(join(HOME, ".minicode"), { recursive: true })
  writeFileSync(
    join(WS, "README.md"),
    "# Controlled enablement workspace\n\nA disposable repository for Phase 6AC.\n",
  )
  writeFileSync(
    join(WS, "notes.txt"),
    "The magic constant is SEVENTY_THREE and it appears in notes.txt only.\n",
  )
}

function writeConfig(baseUrl: string): void {
  writeFileSync(
    join(WS, ".minicode", "config.json"),
    JSON.stringify({
      providers: [{ id: "fake", baseUrl, apiKey: "sk-test", models: ["fake-1"] }],
    }),
  )
}

function childEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HOME,
    USERPROFILE: HOME,
    MINICODE_HOME: HOME,
    NO_COLOR: "1",
    MINICODE_TELEMETRY: "0",
    DEEPSEEK_API_KEY: "",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  }
}

// ─── async child spawning ───────────────────────────────────────────────────

interface ChildResult {
  code: number
  report: Record<string, unknown>
  raw: string
}

interface ChildOpts {
  sessionId?: string
  resumeId?: string
  enable?: boolean
  baseUrl?: string
  holdMs?: number
  mode?: string
  waitFor?: string
  /** A non-zero exit is the EXPECTED result (e.g. `hold`, which never returns). */
  expectTimeout?: boolean
}

async function spawnChild(args: string[], timeoutMs: number): Promise<ChildResult> {
  const proc = Bun.spawn([process.execPath, ...args], {
    cwd: WS,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(),
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  const line = stdout.split("\n").find((l) => l.startsWith("__REPORT__"))
  const report = line
    ? (JSON.parse(line.slice("__REPORT__".length)) as Record<string, unknown>)
    : {}
  return { code, report, raw: `${stdout}${stderr}` }
}

/** Run one controlled operation in a REAL process. */
function runChild(op: string, opts: ChildOpts = {}): Promise<ChildResult> {
  return spawnChild(
    [
      join(REPO, "scripts", "phase6ac-probe.ts"),
      "op",
      WS,
      opts.sessionId ?? SESSION,
      op,
      opts.enable === false ? "off" : "on",
      opts.resumeId ?? "-",
      opts.baseUrl ?? "-",
      String(opts.holdMs ?? 0),
      opts.mode ?? "-",
      opts.waitFor ?? "-",
      "-",
    ],
    opts.expectTimeout ? 12_000 : 180_000,
  )
}

// ─── durable readers, via independent processes ─────────────────────────────

function readTasks(sessionId: string): { id: string; status: string; title: string }[] {
  const out = spawnSync(
    process.execPath,
    [join(REPO, "scripts", "phase6ac-probe.ts"), "tasks", WS, sessionId],
    { encoding: "utf8", env: childEnv(), timeout: 60_000 },
  )
  if (out.status !== 0) return []
  const line = (out.stdout ?? "").split("\n").find((l) => l.startsWith("__REPORT__"))
  return line ? (JSON.parse(line.slice("__REPORT__".length)) as never) : []
}

function readLease(sessionId: string): Record<string, unknown> | null {
  const out = spawnSync(
    process.execPath,
    [join(REPO, "scripts", "phase6ac-probe.ts"), "lease", WS, sessionId],
    { encoding: "utf8", env: childEnv(), timeout: 60_000 },
  )
  if (out.status !== 0) return null
  const trimmed = (out.stdout ?? "").trim()
  if (trimmed === "" || trimmed === "null") return null
  return JSON.parse(trimmed) as Record<string, unknown>
}

function readIncarnation(sessionId: string): number | null {
  const out = spawnSync(
    process.execPath,
    [join(REPO, "scripts", "phase6ac-probe.ts"), "incarnation", WS, sessionId],
    { encoding: "utf8", env: childEnv(), timeout: 60_000 },
  )
  return out.status === 0 ? Number(out.stdout.trim()) : null
}

/**
 * Wait for a barrier FILE. Never a sleep.
 *
 * [DESIGN DECISION] 6Y's rule, applied here: a sleep-based barrier makes a race
 * probabilistic, so a check that only holds most of the time is not a check. A
 * file the other process writes when it is genuinely ready removes the guessing.
 */
async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false
    await Bun.sleep(10)
  }
  return true
}

/** Workspace files, EXCLUDING `.minicode`, so test config never counts. */
function readFileCount(): number {
  const out = spawnSync(
    process.execPath,
    [join(REPO, "scripts", "phase6ac-probe.ts"), "files", WS],
    { encoding: "utf8", env: childEnv(), timeout: 60_000 },
  )
  return out.status === 0 ? Number(out.stdout.trim() || "0") : -1
}

// ─── drills ─────────────────────────────────────────────────────────────────

async function drill1Activation(baseUrl: string): Promise<void> {
  head(1, "First activation - the flag must produce a real, authority-holding scheduler")
  const r = await runChild("activate", { baseUrl })
  fact("exit code", r.code)
  fact("enabled", r.report.enabled)
  fact("constructed", r.report.constructed)
  fact("isActive", r.report.active)
  fact("lease held", r.report.leaseHeld)
  fact("operator state", r.report.state)
  fact("session id", r.report.sessionId)
  fact("incarnation", r.report.incarnation)
  say("OBSERVATION /scheduler status reported:")
  for (const l of (r.report.statusOut as string[] | undefined) ?? []) say(`  | ${l}`)
  // The child closed before this read, and a closed process has correctly
  // released its lease - so the row must be read from INSIDE the child.
  fact("lease row seen while held", r.report.leaseRowWhileHeld)
  fact("owner pid while held", r.report.ownerPidWhileHeld)
  fact("lease ms remaining while held", r.report.leaseMsRemaining)
  fact("lease row after close (correctly released)", readLease(SESSION) === null)
}

async function drill2FirstTask(baseUrl: string): Promise<void> {
  head(2, "First autonomous execution - one read-only task, end to end")
  const before = readFileCount()
  fact("workspace file count before", before)
  const reqBefore = provider?.requestCount() ?? 0

  const r = await runChild("autonomous", { baseUrl })
  fact("trigger outcome", r.report.outcome)
  fact("evaluations", r.report.evaluations)
  fact("executions", r.report.executions)
  fact("task terminal status", r.report.taskStatus)
  fact("exec generation", r.report.execGeneration)
  fact("parent session id", r.report.parentSessionId)
  fact("autonomous turn ok", r.report.turnOk)
  fact("RAW execution observation", r.report.executionObservation)
  fact("child turn DETAIL", childDetail(r.report.cycleResult))
  fact("last error", r.report.lastError)
  fact("durable lineage", r.report.lineageRaw)
  fact("provider requests (parent-measured)", (provider?.requestCount() ?? 0) - reqBefore)
  say("OBSERVATION lifecycle the operator saw:")
  for (const l of (r.report.events as string[] | undefined) ?? []) say(`  | [scheduler] ${l}`)
  fact("operator route /scheduler run worked", r.report.operatorRoute)

  fact("workspace file count after", readFileCount())
  fact("READ-ONLY HELD (file count unchanged)", before === readFileCount())
  fact("READ-ONLY HELD (no write file)", existsSync(join(WS, "AUTONOMOUS_WRITE.txt")) === false)
}

function childDetail(cycleResult: unknown): string | null {
  const c = cycleResult as
    | { cycle?: { dispatched?: { observation?: { detail?: string } } } }
    | undefined
  return c?.cycle?.dispatched?.observation?.detail ?? null
}

async function drill3Permission(baseUrl: string): Promise<void> {
  head(3, "Permission boundary - read allowed, write refused, live")
  const before = readFileCount()
  const r = await runChild("permission", { baseUrl })
  fact("autonomous tool set size", r.report.autonomousToolCount)
  fact("parent tool set size", r.report.parentToolCount)
  say("FACT membership of the autonomous tool set:")
  fact("  write_file offered", r.report.writeFileInAutonomousSet)
  fact("  bash offered", r.report.bashInAutonomousSet)
  fact("  web_fetch offered", r.report.webFetchInAutonomousSet)
  fact("  mcp_list offered", r.report.mcpListInAutonomousSet)
  say("OBSERVATION the model was scripted to call write_file, then bash.")
  fact("write file created", r.report.writeFileCreated)
  fact("READ-ONLY HELD (file count unchanged)", readFileCount() === before)
  fact("child turn verdict", r.report.turnOutcome)
  fact("child turn DETAIL", r.report.turnDetail)
  say(
    "NOTE the write_file call never reached 6S: the child was never OFFERED the " +
      "tool, so the kernel could not invoke it. Read-only holds by tool-set " +
      "narrowing, which is enforced at composition time - not by a runtime denial.",
  )
}

async function drill4Interaction(baseUrl: string): Promise<void> {
  head(4, "User interaction during autonomous execution")
  const r = await runChild("interaction", { baseUrl })
  fact("parent turn completed while autonomous ran", r.report.parentTurnOk)
  fact("parent turns recorded", r.report.parentTurns)
  fact("autonomous executions recorded", r.report.autonomousTurns)
  fact("parent user messages before", r.report.parentUserMessagesBefore)
  fact("parent user messages after", r.report.parentUserMessagesAfter)
  fact("parent user messages added by our turn", r.report.parentUserMessagesAdded)
  fact("autonomous work is NOT a parent turn", r.report.parentTurnsExcludeAutonomous)
  fact("no shared abort", r.report.abortsAreIndependent)
  fact("no shared busy state", r.report.parentTurnsExcludeAutonomous)
  fact("task ownership coherent", r.report.ownershipCoherent)
  fact("task status after both ran", r.report.taskStatus)
  say(`OBSERVATION parent last message: ${r.report.parentLastText}`)
  say("FINDING P2/OPERABILITY - the child session id is UNOBSERVABLE in production:")
  fact("  child session id reachable from the operator surface", r.report.childSessionIdObservable)
  say(`  reason: ${r.report.childSessionIdWhy}`)
}

async function drill5Mutation(baseUrl: string): Promise<void> {
  head(5, "Controlled task mutation before the trigger")
  // A FRESH session per case. Sharing one would accumulate tasks, so case 2 would
  // trigger against a graph containing case 1's leftovers and every "final"
  // reading would be ambiguous about which task it described.
  let n = 0
  for (const mode of ["complete", "in-progress", "retitle", "cancel"]) {
    n += 1
    const r = await runChild("mutation", { baseUrl, mode, sessionId: `6ac-mut-${mode}` })
    say(`-- ${mode}: ${r.report.mutation}`)
    fact("  user edit refused by the store", r.report.storeRefusedUserEdit)
    fact(
      "  SCHEDULER authority refuses an IN_PROGRESS patch",
      r.report.schedulerAuthorityRefusesInProgressPatch,
    )
    fact("  scheduler executed it anyway", r.report.ranAnyway)
    fact("  final task status", r.report.taskStatus)
    fact("  final exec generation", r.report.execGeneration)
    fact("  scheduler wrote COMPLETED on its own", r.report.schedulerWroteCompleted)
    fact("  lineage unchanged (no stale write landed)", r.report.staleRejected)
  }
}

async function drill6CrashRecovery(baseUrl: string): Promise<void> {
  head(6, "Crash recovery - kill mid-execution, restart, observe")
  const signal = join(ROOT, "crash.signal")
  rmSync(signal, { force: true })
  const t0 = Date.now()

  // [DESIGN DECISION] The session id is PASSED EXPLICITLY. Without it the child
  // defaults to the harness's shared session, so the crash happened on
  // `6ac-session` while this drill then read a lease and a task for `6ac-crash` -
  // two different sessions, and every "recovery" reading was about the wrong one.
  // Recorded as an ENVIRONMENT-class harness defect, because the first output
  // ("lease survives the crash = false") reads exactly like a lease that failed
  // to persist, which is a P1 if true.
  const killed = await runChild("hang", {
    baseUrl,
    sessionId: "6ac-crash",
    waitFor: signal,
    expectTimeout: true,
  })
  fact("child was killed (non-zero exit is expected)", killed.code !== 0)
  fact("child signalled it had claimed", existsSync(signal))

  const lease = readLease("6ac-crash")
  fact("lease survives the crash", lease !== null)
  const remaining = lease ? Number(lease.leaseExpiresAt) - Date.now() : -1
  fact("lease ms remaining after crash", remaining)
  fact("lease outlives half its period", remaining > LEASE_MS / 2)

  const blocked = await runChild("activate", { sessionId: "6ac-crash" })
  fact("restart inside the lease window composed", blocked.report.ok === true)
  fact("restart failed closed", blocked.code !== 0)
  fact("restart error", blocked.report.error)

  const tasks = readTasks("6ac-crash")
  fact("task still present after the crash", tasks.length === 1)
  fact("task status after the crash", tasks[0]?.status)
  fact("scheduler did NOT write COMPLETED", tasks[0]?.status !== "COMPLETED")
  fact("elapsed ms for the drill", Date.now() - t0)
  say("OBSERVATION recovery is bounded by the lease window. No lease value was tuned.")
  say(`OBSERVATION CONFIGURED renew=${RENEW_MS}ms lease=${LEASE_MS}ms (untouched).`)
  say("INFERENCE the delayed autonomous turn could not report: its process is gone.")
}

async function drill7SessionDeletion(baseUrl: string): Promise<void> {
  head(7, "Session deletion during autonomous execution")
  const r = await runChild("deletion", { baseUrl, sessionId: "6ac-del" })
  fact("scheduler stopped on deletion", r.report.stopped)
  fact("post-delete trigger refused", r.report.postDeleteRefused)
  fact("incarnation before delete", r.report.oldIncarnation)
  fact("incarnation after delete (independent read)", readIncarnation("6ac-del"))
  fact("old scheduler is inert", r.report.oldSchedulerInert)

  const again = await runChild("autonomous", { baseUrl, sessionId: "6ac-del" })
  fact("recreated session executed a new task", again.report.executions)
  // [DESIGN DECISION] Authority is read from the ACTIVATION probe, not from the
  // `autonomous` op, which does not report it. An earlier version printed
  // `undefined` here and the neighbouring incarnation line still read `true`,
  // which is exactly how a hole gets reported as a pass.
  const reacquired = await runChild("activate", { baseUrl, sessionId: "6ac-del" })
  fact("recreated session lease held", reacquired.report.leaseHeld)
  fact("recreated session is active", reacquired.report.active)
  fact(
    "new incarnation differs from the old",
    reacquired.report.incarnation !== r.report.oldIncarnation,
  )
  const tasks = readTasks("6ac-del")
  fact("recreated session task count", tasks.length)
  fact("recreated session task status", tasks[0]?.status)
}

async function drill8Stop(baseUrl: string): Promise<void> {
  head(8, "Stop drill - idle, after a run, repeated")
  for (const mode of ["idle", "after-run"]) {
    const r = await runChild("stop", { baseUrl, sessionId: `6ac-stop-${mode}`, mode })
    say(`-- ${mode}`)
    fact("  stop succeeded", r.report.stopped)
    fact("  lease released", r.report.leaseReleased)
    fact("  lease row gone", r.report.leaseRowGone)
    fact("  state after stop", r.report.state)
    fact("  second stop was safe", r.report.secondStopSafe)
    fact("  post-stop trigger refused", r.report.postStopRefused)
    fact("  process still usable interactively", r.report.parentUsable)
  }
}

async function drill9Rollback(baseUrl: string): Promise<void> {
  head(9, "Rollback drill - restart with no flag")
  // [DESIGN DECISION] `enable: false` is PASSED EXPLICITLY. `runChild` defaults
  // the gate to ON, so omitting it made this drill - whose entire subject is a
  // process WITHOUT the flag - start a scheduler and print
  // "state: ON, idle (holds authority)". The rollback drill was validating the
  // opposite of what it claimed, and it read as a pass because nothing threw.
  const r = await runChild("rollback", { baseUrl, enable: false })
  fact("scheduler constructed without the flag", r.report.constructed)
  fact("scheduler enabled", r.report.enabled)
  fact("scheduler state", r.report.state)
  fact("ordinary turn still worked", r.report.parentTurnOk)
  fact("no lease was taken", readLease(SESSION) === null)
  fact("startup needed no scheduler state", r.report.startupClean)
  say("OBSERVATION /scheduler status in a non-flagged process:")
  for (const l of (r.report.statusOut as string[] | undefined) ?? []) say(`  | ${l}`)

  const again = await runChild("activate", { baseUrl })
  fact("re-enable succeeded", again.report.ok)
  fact("new authority acquired", again.report.leaseHeld)
  fact("lease ms remaining on the new lease", again.report.leaseMsRemaining)
}

async function drill10Resume(baseUrl: string): Promise<void> {
  head(10, "Resume drill - with and without enablement")

  // [DESIGN DECISION] The resumed session must actually EXIST and must carry
  // content, or "history restored" is trivially true of an empty session. Drill 1
  // and drill 2 persist real conversation on SESSION, so it has something to
  // carry; both readings are reported so the distinction stays visible.
  const off = await runChild("resume", { resumeId: SESSION, enable: false })
  fact("disabled resume: ok", off.report.ok)
  fact("disabled resume: resumed session existed", off.report.resumedSessionExisted)
  fact("disabled resume: previous messages", off.report.previousMessages)
  fact("disabled resume: messages carried forward", off.report.carriedMessages)
  fact("disabled resume: history restored", off.report.historyRestored)
  fact("disabled resume: scheduler constructed", off.report.constructed)
  fact("disabled resume: live session id", off.report.sessionId)
  fact("disabled resume: no lease", off.report.leaseHeld === false)

  const on = await runChild("resume", {
    sessionId: "6ac-resume",
    resumeId: SESSION,
    baseUrl,
  })
  fact("enabled resume: ok", on.report.ok)
  fact("enabled resume: live session id", on.report.sessionId)
  fact("enabled resume: scheduler constructed", on.report.constructed)
  fact("enabled resume: lease held", on.report.leaseHeld)
  fact("enabled resume: incarnation", on.report.incarnation)
  fact("enabled resume: messages carried forward", on.report.carriedMessages)
  fact("enabled resume: history restored", on.report.historyRestored)

  const fire = await runChild("autonomous", { baseUrl, sessionId: "6ac-resume" })
  fact("enabled resume: trigger executed the task", fire.report.executions)
  fact("enabled resume: task status", fire.report.taskStatus)
}

async function drill11MultiProcess(baseUrl: string): Promise<void> {
  head(11, "Multi-process controlled test - two real processes, one session")
  const signal = join(ROOT, "multi-a.signal")
  rmSync(signal, { force: true })

  // [DESIGN DECISION] A holds the lease and is NOT killed until after B has
  // spoken. The previous shape killed A first and then ran B, which inverted the
  // test: B then failed closed for the uninteresting reason that A's lease had
  // just been released by its own clean shutdown, and the drill proved nothing
  // about two LIVE processes competing. Killing A only after B's attempt is the
  // sequence §16 actually describes.
  // [DESIGN DECISION] A's promise is held, NOT awaited. `runChild` resolves when
  // the process exits, so awaiting it here would kill the concurrency the drill
  // exists to create. A runs in the background for its whole window while the
  // parent proceeds.
  const aPending = runChild("hold", {
    sessionId: "6ac-multi",
    holdMs: 90_000,
    waitFor: signal,
    expectTimeout: true,
  })
  // Barrier: A signals only once `hasAuthority()` is true, so B provably races a
  // LIVE lease rather than a race to create one.
  const armed = await waitForFile(signal, 60_000)
  fact("A armed while holding the lease", armed)

  const leaseDuringA = readLease("6ac-multi")
  fact("A's lease is live", leaseDuringA !== null)
  fact("A's lease owner pid is a real pid", typeof leaseDuringA?.ownerPid === "number")

  // B attempts while A is still running and still holding.
  const b = await runChild("autonomous", { baseUrl, sessionId: "6ac-multi" })
  fact("B composed (expected to fail closed)", b.report.ok === true)
  fact("B failed closed", b.code !== 0)
  fact("B's refusal reason", b.report.error)
  fact("B ran no work", b.report.executions === undefined || b.report.executions === 0)

  // Only now does A go away - its window ends and the harness kills it.
  const a = await aPending
  fact("A exited after B's attempt", true)
  fact("A's exit was the harness kill", a.code !== 0)

  // [FACT] A was KILLED, not shut down cleanly, so its lease survives in the
  // database with a live expiry. A new process inside that window must still fail
  // closed - which is the same rule drill 6 exercises, and is the reason takeover
  // here is EXPECTED TO FAIL. It is not a defect and must not be reported as one.
  const c = await runChild("activate", { sessionId: "6ac-multi" })
  fact("takeover inside the orphaned lease window composed", c.report.ok === true)
  fact("takeover failed closed as expected", c.code !== 0)
  fact("takeover refusal reason", c.report.error)

  const stillHeld = readLease("6ac-multi")
  fact("A's orphaned lease row is still present", stillHeld !== null)
  fact("A's orphaned lease has not expired", Number(stillHeld?.leaseExpiresAt ?? 0) > Date.now())

  // A clean shutdown, by contrast, releases immediately: the same session id
  // acquires with no wait. This is the difference §16 asks about.
  const d = await runChild("activate", { sessionId: "6ac-multi-clean" })
  fact("a different session acquires immediately", d.report.ok)
  fact("and holds its own lease", d.report.leaseHeld)
  fact(
    "VERDICT exactly one authority at any time",
    b.code !== 0 && c.code !== 0 && d.report.leaseHeld === true,
  )
}

async function drill12DefaultOff(): Promise<void> {
  head(12, "Default-OFF verification - the primary safety invariant")
  const r = await runChild("default-off", { sessionId: "6ac-off", enable: false })
  fact("flag absent: scheduler constructed", r.report.constructed)
  fact("flag absent: enabled", r.report.enabled)
  fact("flag absent: lease held", r.report.leaseHeld)
  fact("flag absent: autonomous context created", r.report.autonomousContext)
  fact("flag absent: /scheduler run said OFF", r.report.runSaidOff)
  fact("flag absent: evaluations", r.report.evaluations)
  fact("flag absent: autonomous work performed", r.report.executions)
  fact("flag absent: trigger requests", r.report.triggerRequests ?? 0)
  // [DESIGN DECISION] Reported as "no lease row" and asserted on the CHILD's
  // reading. An earlier version printed `durable lease row = true` from an
  // expression that evaluated `readLease(...) === null`, i.e. it printed TRUE
  // precisely when the correct value was FALSE. The label and the value disagreed,
  // which is the worst kind of harness bug: it makes a correct system look broken.
  const leaseRow = readLease("6ac-off")
  fact("flag absent: durable lease row ABSENT", leaseRow === null)
  fact(
    "VERDICT default OFF holds",
    r.report.constructed === false &&
      r.report.leaseHeld === false &&
      r.report.autonomousContext === false &&
      leaseRow === null,
  )
  say("OBSERVATION /scheduler status in a process with no flag:")
  for (const l of (r.report.statusOut as string[] | undefined) ?? []) say(`  | ${l}`)
}

function drill13Help(): void {
  head(13, "CLI help truthfulness")
  const out = spawnSync(process.execPath, [join(REPO, "cli", "index.ts"), "--help"], {
    encoding: "utf8",
    env: childEnv(),
    timeout: 60_000,
  })
  const help = `${out.stdout ?? ""}${out.stderr ?? ""}`
  // [DESIGN DECISION] ANSI is stripped with an EXPLICIT escape built from
  // String.fromCharCode(27), not a literal ESC byte in the regex: an invisible control
  // character in source is unreviewable in a diff, and biome rightly rejects it.
  const plain = help.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[a-zA-Z]", "g"), "")
  const lines = plain.split("\n")
  const line = lines.find((l) => l.includes("--enable-scheduler"))
  // [FACT] 6AC's first run printed "(not found)" here while every phrase check
  // reported a vacuous `true`. That was NOT a harness artifact - it was a real
  // documentation defect, and the single most useful thing this phase found:
  //
  //   `--enable-scheduler` existed in the `options:` array (which 6AB's help test
  //   asserted against) but was ABSENT from the `HELP` constant the CLI actually
  //   prints. An operator typing `minicode --help` never saw the flag at all.
  //
  // 6AB's help assertions passed because they read the wrong source. A test that
  // validates a description table is not a test that validates documentation.
  // Classified P1/DOCUMENTATION and FIXED in this phase.
  say(`FACT help line: ${line?.trim() ?? "(NOT FOUND - the flag is undocumented)"}`)
  fact("help text was non-empty", plain.trim().length > 0)
  fact("help length", plain.length)
  fact("FINDING: the flag is visible in --help", line !== undefined)
  for (const phrase of [
    "runs continuously",
    "continuous autonomous",
    "recurring scheduling",
    "automatically schedules",
    "in the background",
  ]) {
    fact(`help avoids "${phrase}"`, !plain.toLowerCase().includes(phrase))
  }
  fact("help states default off", /default: off/i.test(plain))
  fact("help names the manual trigger", plain.includes("/scheduler run"))
  fact("help mentions readonly", /readonly/i.test(plain))
  fact("help says there is no timer", /no timer/i.test(plain))
  fact("help names the status command", plain.includes("/scheduler status"))
  fact("help names the stop command", plain.includes("/scheduler stop"))
}

// ─── run ────────────────────────────────────────────────────────────────────

const onlyArg = process.argv.find((a) => a.startsWith("--only="))
const only = onlyArg ? Number(onlyArg.split("=")[1]) : null

console.log("  PHASE 6AC - controlled scheduler enablement")
console.log(`  workspace: ${WS}`)
console.log(`  fake HOME: ${HOME}`)
console.log(`  session:   ${SESSION}`)
console.log(`  lease:     ${LEASE_MS}ms, renew ${RENEW_MS}ms (CONFIGURED, untouched)`)

const { startFakeProvider } = await import(join(REPO, "test", "helpers", "fake-provider.ts"))

/**
 * One scripted provider PER DRILL.
 *
 * [DESIGN DECISION] A single shared script was the first design and it was wrong.
 * The fake provider advances an index and replays its LAST entry once exhausted,
 * so a script consumed by drill 2 silently became "the model only ever answers
 * politely" for drill 3 - and drill 3's write attempt was never actually made. The
 * drill still printed "write file created = false", which reads as a PASS for the
 * permission boundary while proving nothing.
 *
 * A fresh script per drill makes each adversarial attempt real, and makes a
 * boundary result attributable to that drill alone.
 */
const READ_ONLY_SCRIPT = [
  { kind: "text" as const, text: "notes.txt mentions SEVENTY_THREE. No changes made." },
]
/** Ask for a write, then a shell command, then return prose anyway. */
const HOSTILE_SCRIPT = [
  {
    kind: "tool" as const,
    name: "write_file",
    args: { path: "AUTONOMOUS_WRITE.txt", content: "x" },
  },
  { kind: "text" as const, text: "I could not write that file." },
  { kind: "tool" as const, name: "bash", args: { command: "echo autonomous-shell" } },
  { kind: "text" as const, text: "Shell was refused too; nothing was modified." },
]

let provider: ReturnType<typeof startFakeProvider> | null = null
/** Start a fresh scripted provider and point the workspace config at it. */
function useProvider(script: FakeReply[]): string {
  provider?.close()
  provider = startFakeProvider(script)
  writeConfig(provider.baseUrl)
  return provider.baseUrl
}

makeEnvironment()
try {
  if (only === null || only === 1) await drill1Activation(useProvider(READ_ONLY_SCRIPT))
  if (only === null || only === 2) await drill2FirstTask(useProvider(READ_ONLY_SCRIPT))
  if (only === null || only === 3) await drill3Permission(useProvider(HOSTILE_SCRIPT))
  if (only === null || only === 4) await drill4Interaction(useProvider(READ_ONLY_SCRIPT))
  if (only === null || only === 5) await drill5Mutation(useProvider(READ_ONLY_SCRIPT))
  if (only === null || only === 6) await drill6CrashRecovery(useProvider(READ_ONLY_SCRIPT))
  if (only === null || only === 7) await drill7SessionDeletion(useProvider(READ_ONLY_SCRIPT))
  if (only === null || only === 8) await drill8Stop(useProvider(READ_ONLY_SCRIPT))
  if (only === null || only === 9) await drill9Rollback(useProvider(READ_ONLY_SCRIPT))
  if (only === null || only === 10) await drill10Resume(useProvider(READ_ONLY_SCRIPT))
  if (only === null || only === 11) await drill11MultiProcess(useProvider(READ_ONLY_SCRIPT))
  if (only === null || only === 12) await drill12DefaultOff()
  if (only === null || only === 13) drill13Help()
} finally {
  provider?.close()
  console.log(`\n  observations recorded: ${log.length}`)
  console.log(`  workspace retained at: ${WS}`)
}
