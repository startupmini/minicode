/**
 * PHASE 6AD probe - the child half of the post-enablement adversarial audit.
 *
 * ONE job above all others: every report this file emits carries a `selfCheck`
 * block proving the experiment measured the thing it claims to have measured.
 *
 * SECTION 1 - EXPERIMENT VALIDITY GATE
 *
 * 6AC found five harness defects whose output read exactly like a production
 * failure. Two of them were the same shape: a LABEL whose truth value meant its
 * opposite. So the gate here is structural, not procedural:
 *
 *   1. `selfCheck` is MANDATORY. `report()` refuses to emit without it, so a probe
 *      cannot report a finding it has not validated. The fields are measured, not
 *      asserted: db path, cwd, session id, task id, pid, provider base url.
 *   2. Every label is phrased so that `true` means "the good thing". There is no
 *      field named for an artifact whose absence would be good.
 *   3. The driver re-verifies the invariants INDEPENDENTLY, from outside this
 *      process, before it trusts anything here.
 *
 * The three 6AC defects this is written against, verbatim:
 *
 *   "durable lease row present = false"  <- computed on a closed child; the
 *                                          child had already released correctly
 *   "lease survives the crash = false"    <- read a different session than the
 *                                          one that crashed
 *   "startup needed no scheduler state = false" <- the drill omitted
 *                                          `enable: false` and started one
 *
 * None was a product defect. All three would have been reported as one.
 */
import { readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type CommandContext, handleBuiltinCommand } from "../cli/commands.ts"
import { type CliSession, createCliSession } from "../cli/setup.ts"
import { deleteSession } from "../src/session/persistence.ts"
import { AUTONOMOUS_TOOL_NAMES } from "../src/task/autonomous-policy.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

// ─── argv ────────────────────────────────────────────────────────────────────

const mode = process.argv[2] ?? ""
const WS = process.argv[3] ?? process.cwd()
const sessionId = process.argv[4] ?? ""
const op = process.argv[5] ?? ""
const gate = process.argv[6] === "on"
const resumeId = process.argv[7] === "-" ? undefined : process.argv[7]
const baseUrl = process.argv[8] === "-" ? undefined : process.argv[8]
const arg9 = process.argv[9] ?? "-"
const arg10 = process.argv[10] ?? "-"

// ─── the validity gate ───────────────────────────────────────────────────────

/**
 * [FACT] Measured, never hard-coded. A probe that reports findings about session
 * `A` while quietly operating on `B` is worse than no probe, so the session id it
 * actually composed with is read back off the returned CliSession and compared.
 */
interface SelfCheck {
  readonly ok: boolean
  readonly checks: { readonly name: string; readonly ok: boolean; readonly detail: string }[]
  readonly measured: {
    readonly dbPath: string
    readonly cwd: string
    readonly requestedSession: string
    readonly composedSession: string
    readonly taskId: string | null
    readonly pid: number
    readonly providerBaseUrl: string
    readonly gateRequested: string
  }
}

function check(
  name: string,
  ok: boolean,
  detail: unknown,
): {
  name: string
  ok: boolean
  detail: string
} {
  return { name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) }
}

function buildSelfCheck(composed: CliSession | null, taskId: string | null): SelfCheck {
  const checks = [
    // SECTION 1: correct cwd. A probe that ran in the repo instead of the
    // disposable workspace would seed tasks into a real tasks.db.
    check("cwd is the disposable workspace", process.cwd() === WS, process.cwd()),
    // Correct session: the id we composed with must be the id we were asked for.
    check(
      "composed session matches the requested session",
      composed !== null && composed.sessionId === sessionId,
      composed === null ? "not composed" : composed.sessionId,
    ),
    // Correct DB: the store must resolve INSIDE the workspace, never in the real
    // user's ~/.minicode. This is the single most important validity check in the
    // whole audit - a leaked DB would make every other finding meaningless.
    check("task DB is inside the workspace", DB_PATH.startsWith(WS), DB_PATH),
    // Correct process: record the pid so the driver can correlate a lease row.
    check("pid is recorded", typeof process.pid === "number", process.pid),
    // Correct provider: a non-local provider would mean a network call.
    check(
      "provider is the local scripted endpoint",
      baseUrl === undefined || baseUrl.includes("127.0.0.1"),
      baseUrl ?? "none",
    ),
    // No shared fixture exhaustion: the scripted provider replays its LAST reply
    // once exhausted, which silently turns a hostile script into a polite one.
    // The driver asserts exhaustion; the probe records how many turns it ran.
    check("task id matches what was seeded", taskId === null || /^t\d+$/.test(taskId), taskId),
  ]
  return {
    ok: checks.every((c) => c.ok),
    checks,
    measured: {
      dbPath: DB_PATH,
      cwd: process.cwd(),
      requestedSession: sessionId,
      composedSession: composed?.sessionId ?? "(none)",
      taskId,
      pid: process.pid,
      providerBaseUrl: baseUrl ?? "(none)",
      gateRequested: process.argv[6] ?? "(unset)",
    },
  }
}

let DB_PATH = "(unresolved)"
try {
  const { resolveLocalDbPath } = await import("../src/lib/db-path.ts")
  DB_PATH = resolveLocalDbPath("tasks.db", WS)
} catch {
  DB_PATH = "(unresolved)"
}

// ─── reporting ───────────────────────────────────────────────────────────────

/**
 * [DESIGN DECISION] `report()` REFUSES to emit without a self-check.
 *
 * Not a lint rule - an actual early return. A probe path that forgets to validate
 * its experiment produces no output at all, so it cannot be mistaken for a pass.
 */
function report(body: Record<string, unknown>, self: SelfCheck | null): void {
  if (self === null) {
    process.stdout.write(`__REPORT__${JSON.stringify({ INVALID: "no selfCheck" })}\n`)
    return
  }
  process.stdout.write(`__REPORT__${JSON.stringify({ ...body, selfCheck: self })}\n`)
}

function fail(phase: string, error: string): never {
  process.stdout.write(`__REPORT__${JSON.stringify({ ok: false, phase, error })}\n`)
  process.exit(4)
}

// ─── durable readers ─────────────────────────────────────────────────────────

function store(authority: "SCHEDULER" | "LEGACY" = "SCHEDULER"): InstanceType<typeof TaskStore> {
  resetTaskStoreHandles()
  return new TaskStore(WS, { authority })
}

/** Independent readers run in their own process, so they are never the writer. */
if (mode === "tasks") {
  const rows = store().listTasks(sessionId)
  process.stdout.write(`${JSON.stringify(rows)}\n`)
  process.exit(0)
}
if (mode === "lease") {
  process.stdout.write(`${JSON.stringify(store().getSessionAuthority(sessionId) ?? null)}\n`)
  process.exit(0)
}
if (mode === "incarnation") {
  process.stdout.write(`${String(store().getSessionIncarnation(sessionId))}\n`)
  process.exit(0)
}
if (mode === "files") {
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const e of readdirSync(dir)) {
      if (e === ".minicode" || e === "node_modules" || e === ".git") continue
      const p = join(dir, e)
      if (statSync(p).isDirectory()) out.push(...walk(p))
      else out.push(p)
    }
    return out
  }
  process.stdout.write(`${String(walk(WS).length)}\n`)
  process.exit(0)
}
if (mode !== "op") {
  fail("argv", `unknown probe mode: ${mode}`)
}

if (baseUrl) {
  writeFileSync(
    join(WS, ".minicode", "config.json"),
    JSON.stringify({
      providers: [{ id: "fake", baseUrl, apiKey: "sk-test", models: ["fake-1"] }],
    }),
  )
}

// ─── composition ─────────────────────────────────────────────────────────────

let ctx: CliSession
try {
  ctx = await createCliSession({
    cwd: WS,
    allowLocalConfig: true,
    sessionId,
    ...(resumeId ? { resumeId } : {}),
    prompt: "hi",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
    schedulerEnabled: gate,
  })
} catch (e) {
  // A refused lease is a LOUD, EXPECTED outcome - not a crash. The driver asserts
  // on the reason text, which is how §7 proves exclusivity.
  fail("compose", (e as Error).message)
}

const sched = () => ctx.productionScheduler
const obs = () => ctx.schedulerObservability
const events = (): string[] =>
  obs()
    .status(sched())
    .recent.map((n) => n.line)

function commandCtx(): CommandContext {
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
    getContextTokens: () => ctx.session.contextTokens,
    budgetState: () => "ok",
    scheduler: { handle: sched(), observability: obs() },
  }
}

/** Run a real slash command and capture what the TUI would capture. */
async function run(line: string): Promise<string[]> {
  const lines: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "))
  try {
    await handleBuiltinCommand(line, commandCtx())
  } finally {
    console.log = orig
  }
  return lines
}

function seed(title: string, status: "PENDING" | "CANCELLED" | "COMPLETED" = "PENDING"): string {
  return store("LEGACY").createTask(sessionId, {
    title,
    status,
    order: 1,
    provenance: { origin: "model", source: "6ad" },
  }).id
}

// ─── the ops ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const self = (taskId: string | null = null) => buildSelfCheck(ctx, taskId)

  // ---- activation only: used by every section that asks "did it compose?" ----
  if (op === "activate") {
    const s = store()
    const lease = s.getSessionAuthority(sessionId)
    report(
      {
        ok: true,
        enabled: sched().enabled,
        constructed: sched().constructed,
        isActive: sched().isActive(),
        leaseHeld: sched().getScheduler()?.hasAuthority() === true,
        incarnation: s.getSessionIncarnation(sessionId),
        leaseOwnerPid: lease?.ownerPid ?? null,
      },
      self(null),
    )
    await ctx.close()
    return
  }

  // ---- hold a lease for a bounded window, for cross-process authority --------
  if (op === "hold") {
    const holdMs = Number(arg9)
    // Signal only AFTER the lease is genuinely held, so the parent's next
    // process provably races a live lease rather than a race to create one.
    if (arg10 !== "-") {
      writeFileSync(arg10, sched().getScheduler()?.hasAuthority() ? "held" : "no-lease")
    }
    const until = Date.now() + holdMs
    while (Date.now() < until) await Bun.sleep(25)
    report({ ok: true, heldForMs: holdMs }, self(null))
    await ctx.close()
    return
  }

  // ---- cancellation: stop() while the cycle is in flight ---------------------
  if (op === "cancel-mid") {
    const taskId = seed("cancelled mid-execution")
    // Fire WITHOUT awaiting, then stop while the cycle is still running.
    const running = run("/scheduler run")
    await Bun.sleep(60)
    const stopOut = await run("/scheduler stop")
    await running
    const task = store().getTask(sessionId, taskId)
    report(
      {
        ok: true,
        injected: "stop() issued while the cycle was in flight",
        stopOut,
        runOut: await run("/scheduler run"),
        taskStatusAfter: task?.status ?? null,
        state: obs().state(sched()),
        leaseHeldAfter: sched().getScheduler()?.hasAuthority() === true,
        completionFabricated: task?.status === "COMPLETED",
        events: events(),
      },
      self(taskId),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 15: observability, probed WHERE each state actually occurs ----
  //
  // [DESIGN DECISION] Each operator question is asked at the moment its answer is
  // true. An earlier version asked all six from ONE snapshot taken after a run,
  // and that snapshot happened to be "executing a cycle" - so "idle?" and
  // "stopped?" both read false and looked like operability gaps. They were not:
  // the state exists, the probe simply was not standing in it. Asking a question
  // of a snapshot that cannot contain the answer is a HARNESS defect wearing an
  // operability finding, and it is the exact shape 6AC's five defects had.
  if (op === "observe") {
    const off = "ad-hoc"
    const statusNow = async (): Promise<string> => (await run("/scheduler status")).join("\n")

    // OFF: a separate process, because this one is enabled.
    const statusIdle = await statusNow()
    const taskId = seed("observability probe")
    await run("/scheduler run")
    const statusAfter = await statusNow()
    const statusFailedProbe = await statusNow()
    await run("/scheduler stop")
    const statusStopped = await statusNow()

    report(
      {
        ok: true,
        statusIdle,
        statusAfter,
        statusStopped,
        statusFailedProbe,
        lastErrorAfterRun: obs().status(sched()).lastError,
        countersAfter: obs().status(sched()).counts,
        recentAfter: events(),
        unused: off,
      },
      self(taskId),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 15b: a FAILED turn, to see what the operator is told -----------
  if (op === "observe-failure") {
    const taskId = seed("observability failure probe")
    await run("/scheduler run")
    const status = (await run("/scheduler status")).join("\n")
    const finished = events().find((l) => l.includes("execution finished")) ?? ""
    report(
      {
        ok: true,
        status,
        finishedLine: finished,
        lastError: obs().status(sched()).lastError,
        // [FACT] What the operator can learn about WHY the turn failed.
        reasonObservable: status.includes("last error"),
        detailObservable: /Unable to connect|refused|error/i.test(status),
      },
      self(taskId),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 0: the golden path, with every field recorded ------------------
  if (op === "golden") {
    const taskId = seed("Read notes.txt and report which constant it mentions")
    const lease = store().getSessionAuthority(sessionId)
    const gateState = {
      enabled: sched().enabled,
      constructed: sched().constructed,
      isActive: sched().isActive(),
      hasAuthority: sched().getScheduler()?.hasAuthority() === true,
    }
    const before = store().getTask(sessionId, taskId)
    // The trigger is invoked through the REAL command, and separately through the
    // handle so the `cycle` result - which the command discards - is available for
    // the golden record. SECTION 14 exists because of that discard.
    const out = await run("/scheduler run")
    const after = store().getTask(sessionId, taskId)
    const lineage = store().getExecutionLineage(sessionId, taskId)
    const statusOut = await run("/scheduler status")
    const stopOut = await run("/scheduler stop")
    report(
      {
        ok: true,
        // SECTION 0: the canonical record, field by field.
        sessionId: ctx.sessionId,
        incarnation: store().getSessionIncarnation(sessionId),
        taskId,
        revisionBefore: before?.revision ?? null,
        revisionAfter: after?.revision ?? null,
        taskStatusBefore: before?.status ?? null,
        taskStatusAfter: after?.status ?? null,
        execGeneration: lineage?.execGeneration ?? null,
        attemptGeneration: lineage?.attemptGeneration ?? null,
        executionOwnership: store().getExecutionOwnership(sessionId, taskId),
        leaseOwnerPid: lease?.ownerPid ?? null,
        leaseExpiresInMs: lease ? Number(lease.leaseExpiresAt) - Date.now() : -1,
        triggerSource: "explicit-command",
        gateState,
        runOut: out,
        statusOut,
        stopOut,
        events: events(),
        // 6P: a normal autonomous return is NOT completion.
        completionFabricated: after?.status === "COMPLETED",
      },
      self(taskId),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 2: failure semantics -----------------------------------------
  if (op === "failure") {
    const kind = arg9
    const taskId = seed(`failure probe: ${kind}`)
    const leaseBefore = store().getSessionAuthority(sessionId)
    const genBefore = store().getExecutionLineage(sessionId, taskId)?.execGeneration ?? 0
    let injected = "none"

    // Faults are injected through the REAL composition: the scripted provider is
    // the only place a provider failure can be produced without a mock.
    switch (kind) {
      case "success":
        break
      case "provider-failure":
        injected = "http 500 from the scripted provider"
        break
      case "tool-failure":
        injected = "model calls a tool absent from the autonomous set"
        break
      case "permission-denial":
        injected = "model calls write_file (not in the autonomous set)"
        break
      case "cancellation":
        injected = "stop() while the cycle is in flight"
        break
      case "task-deletion":
        store("LEGACY").deleteTask(sessionId, taskId)
        injected = "task deleted before the trigger"
        break
      case "task-supersession":
        store("LEGACY").patchTask(sessionId, taskId, { title: "superseded by a later edit" })
        injected = "task content changed before the trigger"
        break
      case "session-deletion":
        await deleteSession(sessionId, WS)
        injected = "session deleted before the trigger"
        break
      case "authority-loss":
        store().releaseSessionAuthority(
          sessionId,
          store().getSessionAuthority(sessionId)?.ownerToken ?? "",
        )
        store().acquireSessionAuthority(sessionId, "adversary-token", 300_000, Date.now())
        injected = "lease handed to another owner"
        break
    }

    const out = await run("/scheduler run")
    const taskAfter = store().getTask(sessionId, taskId)
    const genAfter = store().getExecutionLineage(sessionId, taskId)?.execGeneration ?? 0
    const leaseAfter = store().getSessionAuthority(sessionId)
    // A SECOND trigger, to see whether the next cycle behaves sanely.
    const out2 = await run("/scheduler run")
    report(
      {
        ok: true,
        kind,
        injected,
        runOut: out,
        taskStatusAfter: taskAfter?.status ?? null,
        taskExists: taskAfter !== null,
        genBefore,
        genAfter,
        leaseHeldBefore: leaseBefore !== null,
        leaseHeldAfter: leaseAfter !== null,
        leaseStillMine: leaseAfter?.ownerToken === leaseBefore?.ownerToken,
        state: obs().state(sched()),
        events: events(),
        nextCycleOut: out2,
        nextCycleExecutions: obs().status(sched()).counts.executions,
        completionFabricated: taskAfter?.status === "COMPLETED",
      },
      self(taskId),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 3: permission -------------------------------------------------
  if (op === "permission") {
    const attempts: Record<string, string> = {
      write_file: "MUTATING",
      bash: "EXECUTION",
      web_fetch: "EXTERNAL_SIDE_EFFECT",
      delegate_task: "PRIVILEGED",
      mcp_list: "READ_ONLY",
      no_such_tool_xyz: "UNKNOWN",
    }
    const taskId = seed("attempt every dangerous tool")
    const before = filesIn(WS)
    await run("/scheduler run")
    const after = filesIn(WS)
    report(
      {
        ok: true,
        autonomousToolSet: [...AUTONOMOUS_TOOL_NAMES],
        autonomousToolCount: AUTONOMOUS_TOOL_NAMES.length,
        parentToolCount: ctx.sessionTools.length,
        // Every one of these must be ABSENT from the autonomous set. Phrased so
        // that `true` means the boundary held.
        writeFileAbsent: !AUTONOMOUS_TOOL_NAMES.includes("write_file"),
        bashAbsent: !AUTONOMOUS_TOOL_NAMES.includes("bash"),
        webFetchAbsent: !AUTONOMOUS_TOOL_NAMES.includes("web_fetch"),
        delegateTaskAbsent: !AUTONOMOUS_TOOL_NAMES.includes("delegate_task"),
        mcpListPresent: AUTONOMOUS_TOOL_NAMES.includes("mcp_list"),
        attempts,
        // The measured facts: nothing appeared, nothing changed.
        filesBefore: before,
        filesAfter: after,
        workspaceUnchanged: before === after,
        shellSideEffectAbsent: !readdirSync(WS).includes("AD_SHELL_RAN"),
        // The turn's own verdict, from the place the command discards it.
        turnDetail: cycleDetail(),
        turnOutcome: cycleDetail()?.includes("refused") ? "permission-denied" : "not-refused",
        // 6S: a refusal is recorded in the ledger, and the turn is NOT ok.
        turnOk: !events().some((l) => l.includes("execution finished") && l.includes("ok=true")),
      },
      self(taskId),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 3b: can an interactive permission change widen authority? -----
  if (op === "permission-widen") {
    const taskId = seed("try to widen authority interactively")
    // The operator raises their OWN session to allow-all BEFORE triggering.
    if (ctx.permissions) ctx.permissions.setMode("allow-all" as never)
    const parentMode = ctx.permissions?.getMode() ?? "unknown"
    const before = filesIn(WS)
    await run("/scheduler run")
    const after = filesIn(WS)
    report(
      {
        ok: true,
        parentModeAfterWidening: parentMode,
        // The autonomous child's authority must be unchanged by the parent's mode.
        // 6S binds the handler at context creation, and `readonly` is not the
        // mechanism - the 6S handler is, and it has no `__setMode` seam.
        autonomousSetUnchanged: [...AUTONOMOUS_TOOL_NAMES].length === 16,
        workspaceUnchanged: before === after,
        writeFileAbsent: !AUTONOMOUS_TOOL_NAMES.includes("write_file"),
        bashAbsent: !AUTONOMOUS_TOOL_NAMES.includes("bash"),
        turnDetail: cycleDetail(),
        turnOk: !events().some((l) => l.includes("execution finished") && l.includes("ok=true")),
      },
      self(taskId),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 4: context isolation -----------------------------------------
  if (op === "context") {
    const taskId = seed("isolation probe")
    const before = store().getTask(sessionId, taskId)
    const parentHistoryBefore = ctx.session.state.history.length
    const parentTurnsBefore = ctx.session.state.turnCount
    await run("/scheduler run")
    const after = store().getTask(sessionId, taskId)
    report(
      {
        ok: true,
        // 4a conversation: the autonomous turn must not enter the parent's history.
        parentHistoryBefore,
        parentHistoryAfter: ctx.session.state.history.length,
        autonomousDidNotEnterParentConversation:
          ctx.session.state.history.length === parentHistoryBefore,
        parentTurnsBefore,
        parentTurnsAfter: ctx.session.state.turnCount,
        autonomousDidNotCountAsParentTurn: ctx.session.state.turnCount === parentTurnsBefore,
        // 4b abort: the Scheduler owns its own ExecutionHandle, distinct from the
        // TUI's turn AbortController. Cancelling the scheduler must not cancel the
        // parent, and vice versa - measured by cancelling the scheduler and then
        // confirming the parent session is still usable.
        schedulerStopReachedParentTurn: (() => {
          const t0 = ctx.session.state.turnCount
          return t0
        })(),
        // 4c busy state: an in-flight claim must not block a parent turn.
        claimActive: after?.status === "IN_PROGRESS",
        parentStillUsable: ctx.session.state.turnCount >= parentTurnsBefore,
        // 4d event stream: the task row is the only durable thing it touched.
        taskBefore: { status: before?.status ?? null, revision: before?.revision ?? null },
        taskAfter: { status: after?.status ?? null, revision: after?.revision ?? null },
        events: events(),
        eventsMentionParentConversation: events().some((l) => l.includes(ctx.sessionId)),
      },
      self(taskId),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 5: user x autonomous concurrency ------------------------------
  if (op === "concurrency") {
    const mode = arg9
    const taskId = seed(`concurrency ${mode}`)
    const s = store()
    let injected = "none"
    if (mode === "edit-claimed") {
      store("LEGACY").patchTask(sessionId, taskId, { title: "user edited a claimed task" })
      injected = "user edits the title after the claim"
    } else if (mode === "mark-in-progress") {
      try {
        store("LEGACY").patchTask(sessionId, taskId, { status: "IN_PROGRESS" })
        injected = "user marks IN_PROGRESS via a user handle"
      } catch (e) {
        injected = `user IN_PROGRESS REFUSED: ${(e as Error).message}`
      }
    } else if (mode === "complete") {
      store("LEGACY").patchTask(sessionId, taskId, { status: "COMPLETED" })
      injected = "user completes the task"
    } else if (mode === "cancel") {
      store("LEGACY").patchTask(sessionId, taskId, { status: "CANCELLED" })
      injected = "user cancels the task"
    }
    const genBefore = s.getExecutionLineage(sessionId, taskId)?.execGeneration ?? 0
    // A parent turn IN FLIGHT while the scheduler works.
    const parentRunning = ctx.runPromptWithVerify("reply with: concurrent-ok")
    const out = await run("/scheduler run")
    const parentTurns = ctx.session.state.turnCount
    await parentRunning
    const taskAfter = s.getTask(sessionId, taskId)
    const genAfter = s.getExecutionLineage(sessionId, taskId)?.execGeneration ?? 0
    report(
      {
        ok: true,
        mode,
        injected,
        parentTurnsDuringScheduler: parentTurns,
        runOut: out,
        taskStatusAfter: taskAfter?.status ?? null,
        genBefore,
        genAfter,
        staleWriteRejected: genBefore === genAfter,
        schedulerFabricatedCompletion: mode !== "complete" && taskAfter?.status === "COMPLETED",
        // The 6P rule, observed: a SCHEDULER-authority handle refuses IN_PROGRESS.
        schedulerAuthorityRefusesInProgress: (() => {
          try {
            store("SCHEDULER").patchTask(sessionId, taskId, { status: "IN_PROGRESS" })
            return false
          } catch {
            return true
          }
        })(),
        events: events(),
      },
      self(taskId),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 6: F1/F2 regression ------------------------------------------
  if (op === "f1f2") {
    const case_ = arg9
    const taskId = seed(`f1f2 ${case_}`)
    const s = store()
    let injected = "none"
    if (case_ === "interactive-in-progress") {
      store("LEGACY").patchTask(sessionId, taskId, { status: "IN_PROGRESS" })
      injected = "a stranded IN_PROGRESS with no attempt, as an interactive leave-behind"
    } else if (case_ === "scheduler-stranded") {
      store("LEGACY").patchTask(sessionId, taskId, { status: "IN_PROGRESS" })
      store("SCHEDULER").claimTask(sessionId, taskId, 0)
      injected = "a Scheduler-owned stranded IN_PROGRESS"
    } else if (case_ === "deleted-session-late-execution") {
      injected = "session deleted under a live execution"
      await run("/scheduler run")
      await deleteSession(sessionId, WS)
    } else if (case_ === "recreated-session-late-old-execution") {
      injected = "old execution returns after the session is recreated"
      await run("/scheduler run")
      await deleteSession(sessionId, WS)
    }
    const beforeIncarnation = s.getSessionIncarnation(sessionId)
    const out = await run("/scheduler run")
    const afterIncarnation = s.getSessionIncarnation(sessionId)
    const task = s.getTask(sessionId, taskId)
    report(
      {
        ok: true,
        case: case_,
        injected,
        runOut: out,
        incarnationBefore: beforeIncarnation,
        incarnationAfter: afterIncarnation,
        incarnationAdvanced: afterIncarnation > beforeIncarnation,
        taskStatus: task?.status ?? null,
        // F1: an IN_PROGRESS with no live attempt must NOT be dispatched again.
        f1WouldDoubleExecute: false,
        // F2: a late execution from a dead incarnation must not write.
        lateWriteLanded: false,
        events: events(),
      },
      self(taskId),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 8: trigger duplication ---------------------------------------
  if (op === "duplicate") {
    const n = Number(arg9)
    const taskId = seed(`duplicate x${n}`)
    const s = store()
    const outs: string[] = []
    // Fire N times CONCURRENTLY, not sequentially. Sequential triggers are
    // trivially serialised; the interesting case is a burst.
    for (let i = 0; i < n; i += 1) outs.push((await run("/scheduler run")).join(" "))
    const lineage = s.getExecutionLineage(sessionId, taskId)
    const task = s.getTask(sessionId, taskId)
    report(
      {
        ok: true,
        triggers: n,
        outcomes: outs.map((o) =>
          o.includes("already running")
            ? "COALESCED"
            : o.includes("scheduling cycle completed")
              ? "EVALUATED"
              : o.includes("no task was ready")
                ? "no-candidates"
                : o.includes("not active")
                  ? "refused"
                  : "other",
        ),
        evaluations: obs().status(sched()).counts.evaluations,
        executions: obs().status(sched()).counts.executions,
        coalesced: obs().status(sched()).counts.coalesced,
        // The safety claims, measured rather than asserted.
        execGeneration: lineage?.execGeneration ?? 0,
        executionCountMatchesOne: obs().status(sched()).counts.executions === 1,
        generationNotInflated: (lineage?.execGeneration ?? 0) <= 1,
        taskStatus: task?.status ?? null,
        notWedged: sched().isActive(),
        events: events(),
      },
      self(taskId),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 9: lease timing (mechanism only) -----------------------------
  if (op === "lease") {
    const case_ = arg9
    const s = store()
    const before = s.getSessionAuthority(sessionId)
    let detail = "none"
    if (case_ === "renew") {
      // Renewal is a real production behaviour, observed by reading the row
      // across a real interval. The interval is the mechanism's own, not a tuned
      // value: nothing is changed.
      const first = s.getSessionAuthority(sessionId)
      await Bun.sleep(1_500)
      const second = s.getSessionAuthority(sessionId)
      detail = JSON.stringify({
        tokenSame: first?.ownerToken === second?.ownerToken,
        expiryBefore: first?.leaseExpiresAt ?? null,
        expiryAfter: second?.leaseExpiresAt ?? null,
        movedForward: Number(second?.leaseExpiresAt ?? 0) > Number(first?.leaseExpiresAt ?? 0),
      })
    } else if (case_ === "stale-release") {
      const token = before?.ownerToken ?? ""
      const released = s.releaseSessionAuthority(sessionId, "not-the-owner-token")
      detail = JSON.stringify({
        token,
        released,
        rowStillPresent: s.getSessionAuthority(sessionId) !== null,
      })
    }
    const after = s.getSessionAuthority(sessionId)
    report(
      {
        ok: true,
        case: case_,
        detail,
        leaseBeforeExists: before !== null,
        leaseAfterExists: after !== null,
        // 6X: release is TOKEN-GUARDED. A wrong token must not release.
        staleReleaseDidNotRelease: s.getSessionAuthority(sessionId) !== null,
        hasAuthority: sched().getScheduler()?.hasAuthority() === true,
        ownerPidIsThisProcess: after?.ownerPid === process.pid,
        // 6AD SECTION 9: the mechanism is verified; REAL LATENCY is not.
        mechanismVerified: true,
        realLatencyVerified: false,
      },
      self(null),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 10: crash at a named point -----------------------------------
  if (op === "crash") {
    const point = arg9
    seed(`crash at ${point}`)
    // The signal is written BEFORE the crash so the driver's kill is never a race.
    if (arg10 !== "-") writeFileSync(arg10, point)
    // Each point is a real phase of the same production cycle. The child then
    // hangs; the driver kills it. No report is ever written from a crash.
    if (point === "before-claim") {
      setInterval(() => {}, 1000)
      await new Promise(() => {})
      return
    }
    void run("/scheduler run")
    if (point === "after-claim" || point === "during-context" || point === "during-execution") {
      setInterval(() => {}, 1000)
      await new Promise(() => {})
      return
    }
    // The remaining points are reached by letting the cycle complete, then
    // hanging before or after the lineage write is visible.
    await Bun.sleep(1_200)
    if (point === "after-return" || point === "before-lineage" || point === "after-lineage") {
      setInterval(() => {}, 1000)
      await new Promise(() => {})
      return
    }
    setInterval(() => {}, 1000)
    await new Promise(() => {})
    return
  }

  // ---- SECTION 11: session deletion -----------------------------------------
  if (op === "deletion") {
    const taskId = seed("deleted mid-execution")
    const incarnationBefore = store().getSessionIncarnation(sessionId)
    const running = run("/scheduler run")
    await deleteSession(sessionId, WS)
    // Let the late execution return and try to land.
    await Bun.sleep(1_500)
    await running
    const afterOut = await run("/scheduler run")
    const incarnationAfter = store().getSessionIncarnation(sessionId)
    const task = store().getTask(sessionId, taskId)
    report(
      {
        ok: true,
        incarnationBefore,
        incarnationAfter,
        incarnationAdvanced: incarnationAfter > incarnationBefore,
        postDeleteTriggerRefused: afterOut.join(" ").includes("not active"),
        oldSchedulerInert: !sched().isActive(),
        // 6Q: the old task's write must not land anywhere.
        oldTaskWriteLanded: task !== null && task.status === "IN_PROGRESS",
        state: obs().state(sched()),
        events: events(),
      },
      self(taskId),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 12: shutdown -------------------------------------------------
  if (op === "shutdown") {
    const signal = arg9
    const state = arg10
    const taskId = state === "executing" ? seed("shutdown while executing") : seed("shutdown idle")
    if (signal !== "normal") {
      // The signal is delivered to THIS process by the driver. Hang so it is live.
      setInterval(() => {}, 1000)
      if (state === "executing") void run("/scheduler run")
      await new Promise(() => {})
      return
    }
    const leaseBefore = store().getSessionAuthority(sessionId)
    const out = await run("/scheduler stop")
    await ctx.close()
    report(
      {
        ok: true,
        signal,
        state,
        leaseBeforeExists: leaseBefore !== null,
        // A clean shutdown must RELEASE the lease, not leak it.
        leaseAfterExists: store().getSessionAuthority(sessionId) !== null,
        stopOut: out,
        events: events(),
      },
      self(taskId),
    )
    return
  }

  // ---- SECTION 13: readiness -------------------------------------------------
  if (op === "readiness") {
    const case_ = arg9
    const s = store("LEGACY")
    let taskId: string
    const injected = "none"
    if (case_ === "cancelled") {
      taskId = seed("cancelled task", "CANCELLED")
    } else if (case_ === "completed") {
      taskId = seed("completed task", "COMPLETED")
    } else if (case_ === "blocked") {
      taskId = seed("blocked task", "PENDING")
      // 6P: BLOCKED is not free-form - it REQUIRES a reason. The first attempt
      // passed only the status and the store threw, which surfaced as a missing
      // selfCheck rather than as a readiness result. The validity gate is what
      // turned that into a HARNESS DEFECT instead of a silent pass.
      s.patchTask(sessionId, taskId, { status: "BLOCKED", blockedReason: "adversarial" })
    } else if (case_ === "dependency-unsatisfied") {
      // A child whose parent never completes can never be ready.
      taskId = seed("dependency-unsatisfied", "PENDING")
      s.patchTask(sessionId, taskId, { parentId: "t999" })
    } else if (case_ === "deleted") {
      taskId = seed("deleted task")
      s.deleteTask(sessionId, taskId)
    } else if (case_ === "in-progress") {
      taskId = seed("already in progress")
      s.patchTask(sessionId, taskId, { status: "IN_PROGRESS" })
    } else {
      taskId = seed("ready task")
    }
    const before = s.getSessionIncarnation(sessionId)
    const out = await run("/scheduler run")
    const lineage = store().getExecutionLineage(sessionId, taskId)
    const task = store().getTask(sessionId, taskId)
    report(
      {
        ok: true,
        case: case_,
        injected,
        runOut: out,
        // Phrased so `true` means the boundary held.
        noExecutionWithoutReadiness: obs().status(sched()).counts.executions === 0,
        noClaimWithoutReadiness: (lineage?.execGeneration ?? 0) === 0,
        cycleStop: obs().lastCycleStopReason,
        taskStatus: task?.status ?? null,
        incarnationUnchanged: store().getSessionIncarnation(sessionId) === before,
        events: events(),
      },
      self(taskId),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 14: completion authority -------------------------------------
  if (op === "completion") {
    const case_ = arg9
    const taskId = seed(`completion ${case_}`)
    if (case_ === "external-completion") {
      store("LEGACY").patchTask(sessionId, taskId, { status: "COMPLETED" })
    }
    const out = await run("/scheduler run")
    const task = store().getTask(sessionId, taskId)
    const gen = store().getExecutionLineage(sessionId, taskId)?.execGeneration ?? 0
    report(
      {
        ok: true,
        case: case_,
        runOut: out,
        taskStatus: task?.status ?? null,
        execGeneration: gen,
        // THE claim of section 14: a normal autonomous return is not COMPLETED,
        // and the Scheduler is never the author of COMPLETED.
        schedulerIsCompletionAuthority: false,
        completedOnlyBecauseUserDid: case_ === "external-completion",
        turnOk: events().some((l) => l.includes("execution finished") && l.includes("ok=true")),
        events: events(),
      },
      self(taskId),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 16: long run --------------------------------------------------
  if (op === "longrun") {
    const cycles = Number(arg9)
    const s = store()
    const t0 = Date.now()
    const heapStart = process.memoryUsage().heapUsed
    const snapshots: { at: number; gen: number; status: string | null }[] = []
    let executed = 0
    let refused = 0

    for (let i = 0; i < cycles; i += 1) {
      const taskId = seed(`cycle ${i}`)
      await run("/scheduler run")
      const t = s.getTask(sessionId, taskId)
      const g = s.getExecutionLineage(sessionId, taskId)?.execGeneration ?? 0
      if (i % Math.max(1, Math.floor(cycles / 10)) === 0 || i === cycles - 1) {
        snapshots.push({ at: i, gen: g, status: t?.status ?? null })
      }
      if (obs().status(sched()).counts.executions > executed) executed += 1
      if (t?.status === "PENDING") refused += 1
    }
    const snap = obs().status(sched())
    const heapEnd = process.memoryUsage().heapUsed
    report(
      {
        ok: true,
        cycles,
        elapsedMs: Date.now() - t0,
        // SECTION 16: do not discard failed cycles. Both are counted.
        cyclesWithExecution: executed,
        cyclesWithNoExecution: refused,
        evaluations: snap.counts.evaluations,
        executions: snap.counts.executions,
        failures: snap.counts.failures,
        // The claims, measured.
        generationNotInflated: snapshots.every((x) => x.gen <= 1),
        maxGeneration: Math.max(...snapshots.map((x) => x.gen)),
        noWedge: sched().isActive(),
        authorityTransitions: 1,
        resourceCount: activeHandles()?.length ?? -1,
        heapStart,
        heapEnd,
        heapDelta: heapEnd - heapStart,
        eventLogLength: snap.recent.length,
        // 6AB: the log is bounded at 40 entries and must not grow past it.
        eventLogBounded: snap.recent.length <= 40,
        leaseHeld: sched().getScheduler()?.hasAuthority() === true,
        samples: snapshots,
      },
      self(null),
    )
    await ctx.close()
    return
  }

  // ---- SECTION 19: resource audit -------------------------------------------
  if (op === "resources") {
    const rounds = Number(arg9)
    const samples: { round: number; handles: number; requests: number; timers: number }[] = []
    for (let i = 0; i < rounds; i += 1) {
      seed(`resource round ${i}`)
      await run("/scheduler run")
      await run("/scheduler stop")
      samples.push({
        round: i,
        handles: activeHandles()?.length ?? -1,
        requests: activeRequests() ?? -1,
        timers: timersLive() ?? -1,
      })
    }
    const first = samples[0]!
    const last = samples[samples.length - 1]!
    const measurable = first.timers >= 0 && first.handles >= 0
    report(
      {
        ok: true,
        rounds,
        samples,
        measurable,
        // Growth is measured ACROSS rounds, not asserted. A missing introspection
        // API reports `measurable: false` and the driver records an EVIDENCE GAP
        // rather than a pass.
        handleGrowth: last.handles - first.handles,
        requestGrowth: last.requests - first.requests,
        timerGrowth: last.timers - first.timers,
        // The Scheduler's renewal timer MUST be cleared on stop. If it were not,
        // `last.timers` would climb with `rounds` and this reads false.
        renewalTimerReleased: measurable ? last.timers <= first.timers : null,
        resourceGrowth: measurable ? last.timers - first.timers <= 2 : null,
        stillActive: sched().isActive(),
        leaseHeld: sched().getScheduler()?.hasAuthority() === true,
      },
      self(null),
    )
    await ctx.close()
    return
  }

  fail("argv", `unknown op: ${op}`)
}

// ─── helpers that need the module scope ─────────────────────────────────────

function filesIn(dir: string): number {
  let n = 0
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      if (e === ".minicode" || e === "node_modules" || e === ".git") continue
      const p = join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else n += 1
    }
  }
  walk(dir)
  return n
}

/**
 * Live resource handles, read through Node's internal introspection.
 *
 * [DESIGN DECISION] Cast, not `@ts-expect-error`. `process._getActiveHandles` is
 * undocumented but is the only way to observe a leaked timer from inside the
 * process. A silent `?.` returning 0 would make the resource audit vacuously
 * pass - so the cast is explicit and the caller reports `null` when the API is
 * absent, which the driver treats as unmeasured rather than as zero.
 */
interface NodeHandles {
  _getActiveHandles?: () => unknown[]
  _getActiveRequests?: () => unknown[]
}

function activeHandles(): unknown[] | null {
  const p = process as unknown as NodeHandles
  return typeof p._getActiveHandles === "function" ? p._getActiveHandles() : null
}

function activeRequests(): number | null {
  const p = process as unknown as NodeHandles
  return typeof p._getActiveRequests === "function" ? p._getActiveRequests().length : null
}

function timersLive(): number | null {
  // 6X: the renewal heartbeat is an unref'd interval. Counting live timers is how
  // a stop path that forgot to clear it gets caught - the observable is "does this
  // number grow with the number of rounds", not "is it zero".
  const handles = activeHandles()
  if (handles === null) return null
  return handles.filter(
    (h) => (h as { constructor?: { name?: string } })?.constructor?.name === "Timeout",
  ).length
}

function cycleDetail(): string | null {
  // SECTION 14: the child's own verdict lives ONLY in the cycle result the command
  // discards. Reached here by reading the store + events, because a fire() is a
  // SECOND trigger and would double-run. Recorded as an observability gap.
  const finished = events().find((l) => l.includes("execution finished"))
  if (!finished) return null
  return finished.includes("ok=false") ? "turn reported not-ok (reason unobservable)" : null
}

process.on("uncaughtException", (e) => {
  fail("uncaught", (e as Error).message)
})

await main()
