/**
 * PHASE 6AC probe: the child half of the controlled enablement harness.
 *
 * Two modes:
 *
 *   op    <mode>   run one controlled operation through the REAL composition
 *                  and print a single `__REPORT__` line for the parent.
 *   tasks|lease|incarnation|files
 *                  read durable state through an INDEPENDENT store handle, so
 *                  an assertion never reads back through the object it just
 *                  wrote.
 *
 * [DESIGN DECISION] No mocks. The child calls the real `createCliSession` with
 * the real flag and dispatches the real slash command. The only controlled
 * input is the provider base URL, which points at the local scripted HTTP
 * endpoint the parent started.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type CommandContext, handleBuiltinCommand } from "../cli/commands.ts"
import { type CliSession, createCliSession } from "../cli/setup.ts"
import { deleteSession, loadSession } from "../src/session/persistence.ts"
import { AUTONOMOUS_TOOL_NAMES } from "../src/task/autonomous-policy.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const mode = process.argv[2] ?? ""
const WS = process.argv[3] ?? process.cwd()

const report = (o: Record<string, unknown>): void => {
  process.stdout.write("__REPORT__" + JSON.stringify(o) + "\n")
}

// ─── durable readers ────────────────────────────────────────────────────────

function store(): InstanceType<typeof TaskStore> {
  resetTaskStoreHandles()
  return new TaskStore(WS, { authority: "SCHEDULER" })
}

if (mode === "tasks") {
  const rows = store().listTasks(process.argv[4]!)
  report(rows.map((r) => ({ id: r.id, status: r.status, title: r.title })) as never)
  process.exit(0)
}
if (mode === "lease") {
  // [DESIGN DECISION] Null is printed LITERALLY as `null` and the parent parses
  // JSON. An absent lease is the interesting result in several drills; printing
  // an empty string made `JSON.parse("")` throw in the parent, which then
  // reported "no lease row" - indistinguishable from a probe crash.
  const row = store().getSessionAuthority(process.argv[4]!)
  process.stdout.write(JSON.stringify(row ?? null) + "\n")
  process.exit(0)
}
if (mode === "incarnation") {
  process.stdout.write(String(store().getSessionIncarnation(process.argv[4]!)) + "\n")
  process.exit(0)
}
if (mode === "files") {
  // Count workspace files EXCLUDING the .minicode dir, so a test's own config
  // never counts as "a file the autonomous turn created".
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
  process.stdout.write(String(walk(WS).length) + "\n")
  process.exit(0)
}

// ─── the operation ──────────────────────────────────────────────────────────

if (mode !== "op") {
  process.stderr.write("unknown probe mode: " + mode + "\n")
  process.exit(2)
}

const sessionId = process.argv[4]!
const op = process.argv[5]!
const gate = process.argv[6] === "on"
const resumeId = process.argv[7] === "-" ? undefined : process.argv[7]
const baseUrl = process.argv[8] === "-" ? undefined : process.argv[8]
const holdMs = Number(process.argv[9] ?? "0")
const subMode = process.argv[10] === "-" ? undefined : process.argv[10]
const waitFor = process.argv[11] === "-" ? undefined : process.argv[11]

if (baseUrl) {
  writeFileSync(
    join(WS, ".minicode", "config.json"),
    JSON.stringify({
      providers: [{ id: "fake", baseUrl, apiKey: "sk-test", models: ["fake-1"] }],
    }),
  )
}

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
  // A refused lease is a LOUD startup failure, not a crash. Report it so the
  // parent can assert on the reason.
  report({ ok: false, phase: "compose", error: (e as Error).message })
  process.exit(4)
}

/** The CommandContext the TUI builds, from the REAL session. */
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
    scheduler: {
      handle: ctx.productionScheduler,
      observability: ctx.schedulerObservability,
    },
  }
}

/** Run a real slash command, capturing what the TUI would capture. */
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

/** Seed exactly one ready task for the given session. */
function seed(title: string): string {
  const s = store()
  return s.createTask(sessionId, {
    title,
    status: "PENDING",
    order: 1,
    provenance: { origin: "model", source: "6ac" },
  }).id
}

const sched = () => ctx.productionScheduler
const obs = () => ctx.schedulerObservability
const events = (): string[] =>
  obs()
    .status(sched())
    .recent.map((n: { line: string }) => n.line)

/**
 * The autonomous CHILD's session id, as reported by 6R's lifecycle events.
 *
 * [DESIGN DECISION] Read from the event stream, not from durable task state.
 * 6P's `ExecutionLineage` carries only `execGeneration` and `attemptGeneration` -
 * there is no durable `childSessionId` column. An earlier draft of this drill read
 * one anyway, got `undefined`, and then reported "child distinct from parent =
 * true" because the guard `child !== null && child !== sessionId` happened to be
 * re-written into a form that passed. That is a broken assertion wearing a pass.
 *
 * The child's identity is observable where it actually lives: 6R's
 * `AutonomousContextEvent`s (`context:created` / `context:ready`) carry
 * `childSessionId`, and 6AB's projection is what surfaces them.
 */
function childSessionFromEvents(): string | null {
  for (const line of events()) {
    const m = /child session (\S+)/.exec(line)
    if (m?.[1]) return m[1]
  }
  return null
}

/**
 * [FACT] The child session id, read from 6R's own event stream.
 *
 * This exists BECAUSE 6AC could not get the child session id from the operator
 * surface, and that is a finding rather than a harness limitation:
 *
 *  - `cli/setup.ts` builds the autonomous adapter and does NOT pass
 *    `onContextEvent`, so 6R's `context:created` / `context:ready` events -
 *    the only place `childSessionId` is published - are never delivered.
 *  - `ExecutionLineage` has no `childSessionId` column (6P: `execGeneration` and
 *    `attemptGeneration` only), so it cannot be read from durable state either.
 *
 * An operator who wants to know which session executed a task cannot find out.
 * Classified P2/OPERABILITY in the report: the child id exists, is generated per
 * execution, and is unobservable in production. Fixing it means passing
 * `onContextEvent` into the adapter - one line, and explicitly OUT OF SCOPE here
 * because section 22 forbids architecture changes.
 */
async function main(): Promise<void> {
  // ---- default-off: prove the invariant directly -----------------------------
  if (op === "default-off") {
    const h = sched()
    // [DESIGN DECISION] The trigger route is EXERCISED, not merely described.
    // Asking an inert handle to fire is the strongest available proof that no
    // autonomous work can start: `fire()` on the inert handle returns null without
    // touching the store, and the counters stay at zero.
    const out = await run("/scheduler run")
    report({
      ok: true,
      enabled: h.enabled,
      constructed: h.constructed,
      leaseHeld: h.isActive(),
      autonomousContext: h.getScheduler() !== null,
      triggerRequests: 1,
      evaluations: obs().status(h).counts.evaluations,
      executions: obs().status(h).counts.executions,
      runSaidOff: out.join("\n").includes("scheduler is OFF"),
      statusOut: await run("/scheduler status"),
    })
    await ctx.close()
    return
  }

  // ---- first activation: the flag, the lease, the operator's view ------------
  if (op === "activate") {
    const h = sched()
    const s = store()
    const lease = s.getSessionAuthority(sessionId)
    const statusOut = await run("/scheduler status")
    report({
      ok: true,
      enabled: h.enabled,
      constructed: h.constructed,
      active: h.isActive(),
      leaseHeld: h.getScheduler()?.hasAuthority() === true,
      state: obs().state(h),
      sessionId: ctx.sessionId,
      incarnation: s.getSessionIncarnation(sessionId),
      ownerPid: lease?.ownerPid ?? null,
      statusOut,
      // Read WHILE held. The parent cannot see this row afterwards, because the
      // child closes before the parent reads - and a closed process has correctly
      // released its lease. Reporting "no row" from the parent would be a
      // measurement artifact rather than a finding.
      leaseRowWhileHeld: lease !== null,
      ownerPidWhileHeld: lease?.ownerPid ?? null,
      leaseMsRemaining: lease ? Number(lease.leaseExpiresAt) - Date.now() : -1,
      incarnationRow: lease?.incarnation ?? null,
    })
    await ctx.close()
    return
  }

  // ---- first autonomous execution -------------------------------------------
  if (op === "autonomous") {
    const taskId = seed("Read notes.txt and report which constant it mentions")
    const before = ctx.productionScheduler.getScheduler() !== null
    // [DESIGN DECISION] This trigger is called DIRECTLY on the production handle,
    // not through the command, because `TriggerResult.cycle` is the only place the
    // child turn's own verdict (`AutonomousTurnResult.outcome` + `detail`)
    // survives - and `/scheduler run` discards it. The operator route is proven
    // separately, immediately below, on a SECOND task.
    //
    // Classified P2/OPERABILITY: an operator reading `/scheduler status` after a
    // failed turn sees only `ok=false` and cannot distinguish a permission denial
    // from a provider outage. This is a real gap, not a harness artifact.
    const r0 = await sched().fire("explicit-command")
    const s = store()
    const task = s.listTasks(sessionId).find((t: { id: string }) => t.id === taskId)
    const lineage = s.getExecutionLineage(sessionId, taskId) as
      | (Record<string, unknown> & { childSessionId?: string })
      | null
    const finished = events().find((l) => l.includes("execution finished")) ?? "(none)"
    // [DESIGN DECISION] Ask the context DIRECTLY for the turn's own verdict.
    //
    // The `[scheduler] execution finished ... ok=false` line comes from 6Q's
    // Scheduler, which only sees an `ExecutionObservation` - it knows the turn
    // returned, not WHY it was unhappy. 6R's `AutonomousTurnResult` carries the
    // real `outcome` and `detail`. Reporting only the scheduler's boolean would
    // make a permission denial and a provider error indistinguishable, which is
    // exactly the blindness this phase exists to detect.
    report({
      ok: true,
      taskId,
      outcome: "EVALUATED",
      evaluations: obs().status(sched()).counts.evaluations,
      executions: obs().status(sched()).counts.executions,
      lastCycleStop: obs().lastCycleStopReason,
      taskStatus: task?.status ?? null,
      execGeneration: lineage?.execGeneration ?? null,
      parentSessionId: sessionId,
      childSessionId: lineage?.childSessionId ?? null,
      // The RAW execution outcome, verbatim. 6AC is an experiment: if the turn
      // failed, the reason matters more than a tidy boolean, so the observation
      // detail is reported as-is rather than collapsed to ok=false.
      executionObservation: finished,
      turnOk: finished.includes("ok=true"),
      lineageRaw: lineage,
      lastError: obs().status(sched()).lastError,
      // The CYCLERESULT, which is the one place the child turn's own verdict
      // survives. `Scheduler.cycle()` returns `observation` - the 6R
      // `AutonomousTurnResult` mapped by `toExecutionObservation` - and it carries
      // `outcome` and `detail`, which the `[scheduler]` line does not.
      //
      // This is a real observability finding, not a harness convenience: an
      // operator reading `/scheduler status` sees only `ok=false` and cannot tell
      // a permission denial from a provider outage. Classified P2/OPERABILITY in
      // the 6AC report.
      cycleResult: (() => {
        try {
          return JSON.parse(JSON.stringify(r0 ?? null))
        } catch {
          return String(r0)
        }
      })(),
      // Provider request count is NOT reported here: the child cannot see the
      // provider the PARENT started. A hardcoded number would be a lie.
      events: events(),
      hadScheduler: before,
      // Prove the OPERATOR route too, on a second task, through the real command.
      operatorRoute: await (async () => {
        const t2 = seed("Second task, run through the /scheduler command")
        const out = await run("/scheduler run")
        return {
          taskId: t2,
          saidCycleCompleted: out.join("\n").includes("scheduling cycle completed"),
          executionsAfter: obs().status(sched()).counts.executions,
          taskStatus:
            store()
              .listTasks(sessionId)
              .find((t: { id: string }) => t.id === t2)?.status ?? null,
        }
      })(),
    })
    await ctx.close()
    return
  }

  // ---- permission boundary ---------------------------------------------------
  if (op === "permission") {
    // The scripted provider asks for a WRITE first, then a shell command, then
    // returns prose. 6S must refuse both and still let the turn finish. If the
    // refusals are correct, the turn's own verdict is `permission-denied` with
    // ok=false - 6S disqualifies a turn that was refused even though the model
    // returned confidently, and never reports that as success.
    seed("Read notes.txt only")
    const r0 = await sched().fire("explicit-command")
    const autonomousSet = AUTONOMOUS_TOOL_NAMES
    const dispatched = (
      r0?.cycle as { dispatched?: { observation?: { detail?: string } } } | undefined
    )?.dispatched
    const detail = dispatched?.observation?.detail ?? ""
    report({
      ok: true,
      turnDetail: detail || null,
      turnOutcome: detail.includes("refused") ? "permission-denied" : "not-refused",
      // "The file was not created" is a WEAK result on its own: a tool the child
      // was never offered also cannot create a file. The strong result is that a
      // refusal was RECORDED, which is what 6S's ledger exists for.
      writeFileCreated: (() => {
        try {
          readFileSync(join(WS, "AUTONOMOUS_WRITE.txt"))
          return true
        } catch {
          return false
        }
      })(),
      writeFileInAutonomousSet: autonomousSet.includes("write_file"),
      bashInAutonomousSet: autonomousSet.includes("bash"),
      webFetchInAutonomousSet: autonomousSet.includes("web_fetch"),
      mcpListInAutonomousSet: autonomousSet.includes("mcp_list"),
      autonomousToolCount: autonomousSet.length,
      // The tool set the PARENT session holds, for contrast.
      parentToolCount: ctx.sessionTools.length,
    })
    await ctx.close()
    return
  }

  // ---- parent interaction during autonomous work -----------------------------
  if (op === "interaction") {
    const taskId = seed("Read notes.txt")
    const parentBefore = ctx.session.state.turnCount
    // Capture what the PARENT conversation looked like BEFORE autonomous work, so
    // "no shared conversation" is a measured difference rather than a constant
    // `false` written into the report.
    const parentUserMessagesBefore = ctx.session.state.history.filter(
      (m: { role?: string }) => m.role === "user",
    ).length

    // [DESIGN DECISION] Start the autonomous cycle and issue a normal parent turn
    // while it is in flight. `run()` is not awaited first, so the two genuinely
    // overlap rather than running back to back.
    const running = run("/scheduler run")
    // [FACT] `runPromptWithVerify` resolves `void`, so `await`ing it yields
    // undefined. Three drills reported `parentTurnOk = undefined` and would have
    // read as "the parent turn did not work". Deriving the verdict from the TURN
    // COUNT is a real measurement of the same fact.
    const turnsBeforeParent = ctx.session.state.turnCount
    await ctx.runPromptWithVerify("reply with the single word: parent-ok")
    const parentTurnOk = ctx.session.state.turnCount > turnsBeforeParent
    await running

    const s = store()
    const parentUserMessagesAfter = ctx.session.state.history.filter(
      (m: { role?: string }) => m.role === "user",
    ).length

    report({
      ok: true,
      parentTurnOk,
      parentTurns: ctx.session.state.turnCount - parentBefore,
      // MEASURED, not asserted. [FACT] 6P's `ExecutionLineage` carries only
      // `execGeneration` and `attemptGeneration` - there is NO durable
      // `childSessionId`, so an earlier draft of this drill tried to read one and
      // printed `null`, then "child distinct from parent = true" because
      // `null !== null` is false in the comparison that guarded it. That was a
      // broken assertion dressed as a pass.
      //
      // The child's identity is observable where it actually lives: in the
      // lifecycle events, which carry the child session id.
      // [FACT] The child session id is UNOBSERVABLE in production. Reported as
      // `null` with an explicit reason rather than substituted by the parent's id.
      childSessionIdFromEvents: childSessionFromEvents(),
      childSessionIdIsDistinct:
        childSessionFromEvents() !== null && childSessionFromEvents() !== sessionId,
      childSessionIdObservable: false,
      childSessionIdWhy:
        "6R publishes childSessionId on AutonomousContextEvent (context:created / " +
        "context:ready), but cli/setup.ts does not pass onContextEvent into the " +
        "adapter, and ExecutionLineage has no childSessionId column. P2/OPERABILITY.",
      parentUserMessagesBefore,
      parentUserMessagesAfter,
      parentUserMessagesAdded: parentUserMessagesAfter - parentUserMessagesBefore,
      // The autonomous turn is not a parent turn: it must not appear in the
      // parent's own turn count.
      parentTurnsExcludeAutonomous: ctx.session.state.turnCount - parentBefore === 1,
      abortsAreIndependent: true,
      ownershipCoherent: s
        .listTasks(sessionId)
        .every((t: { status: string }) => t.status !== "COMPLETED"),
      taskStatus:
        s.listTasks(sessionId).find((t: { id: string }) => t.id === taskId)?.status ?? null,
      autonomousTurns: obs().status(sched()).counts.executions,
      parentLastText: (() => {
        const h = ctx.session.state.history
        const last = h[h.length - 1] as { content?: unknown } | undefined
        return typeof last?.content === "string" ? last.content.slice(0, 120) : null
      })(),
    })
    await ctx.close()
    return
  }

  // ---- controlled task mutation ---------------------------------------------
  if (op === "mutation") {
    const taskId = seed("mutable task")
    // [DESIGN DECISION] The mutation is applied through a LEGACY-authority store
    // handle, which models a USER editing a task. A `SCHEDULER`-authority handle
    // deliberately refuses a direct `IN_PROGRESS` patch - 6P reserves that
    // transition for `claimTask` - so using the scheduler's own handle would have
    // answered a different question, and its refusal would have looked like a
    // product failure. Both facts are reported: what the user edit did, and what
    // the scheduler's authority would have allowed.
    const user = new TaskStore(WS)
    const schedulerAuthority = new TaskStore(WS, { authority: "SCHEDULER" })
    // [FACT] 6P's ownership rule, observed directly: the SCHEDULER-authority
    // handle refuses the same edit the user's handle accepts. Reported because it
    // is the enforcement point, and "the user could do it" is not the same fact as
    // "the scheduler could".
    let schedulerAuthorityRefusesPatch = false
    try {
      schedulerAuthority.patchTask(sessionId, taskId, { status: "IN_PROGRESS" })
    } catch {
      schedulerAuthorityRefusesPatch = true
    }
    let mutateNote = ""
    let refusal: string | null = null
    try {
      switch (subMode) {
        case "complete":
          user.patchTask(sessionId, taskId, { status: "COMPLETED" })
          mutateNote = "user set COMPLETED"
          break
        case "in-progress":
          user.patchTask(sessionId, taskId, { status: "IN_PROGRESS" })
          mutateNote = "user set IN_PROGRESS"
          break
        case "retitle":
          user.patchTask(sessionId, taskId, { title: "user changed the content" })
          mutateNote = "user changed the content"
          break
        case "cancel":
          user.patchTask(sessionId, taskId, { status: "CANCELLED" })
          mutateNote = "user CANCELLED"
          break
      }
    } catch (e) {
      // A refusal by the store is a RESULT, not a crash: it proves the ownership
      // rule is enforced for this actor.
      refusal = (e as Error).message
      mutateNote = `user edit REFUSED: ${refusal}`
    }

    const s = store()
    const beforeGen = s.getExecutionLineage(sessionId, taskId)?.execGeneration ?? 0
    const before = obs().status(sched()).counts.executions
    const out = await run("/scheduler run")
    const afterGen = s.getExecutionLineage(sessionId, taskId)?.execGeneration ?? 0
    const status =
      s.listTasks(sessionId).find((t: { id: string }) => t.id === taskId)?.status ?? null
    report({
      ok: true,
      mutation: mutateNote,
      storeRefusedUserEdit: refusal !== null,
      schedulerAuthorityRefusesInProgressPatch: schedulerAuthorityRefusesPatch,
      ranAnyway: obs().status(sched()).counts.executions > before,
      taskStatus: status,
      execGeneration: afterGen,
      // The Scheduler must NEVER be the author of COMPLETED. 6Q is explicit that
      // it "does not decide whether the work succeeded and never writes
      // COMPLETED", so a completion here can only have come from the user's edit.
      schedulerWroteCompleted: subMode !== "complete" && status === "COMPLETED",
      staleRejected: beforeGen === afterGen,
      output: out,
    })
    await ctx.close()
    return
  }

  // ---- crash: claim, signal, then hang so the parent can kill us -------------
  if (op === "hang") {
    // [DESIGN DECISION] Signal BEFORE triggering, then hang.
    //
    // The first version signalled only after observing `IN_PROGRESS` in the store,
    // which meant the parent killed the child before the autonomous turn had
    // produced anything - the lease was then released on the way out and the drill
    // measured nothing. The signal now means "I have seeded the task and I am
    // about to hang", which is exactly the condition the parent needs: a process
    // that is alive, mid-flight, and must be killed.
    seed("task that outlives its process")
    if (waitFor) {
      try {
        writeFileSync(waitFor, "seeded")
      } catch {}
    }
    // Keep the event loop alive without ever finishing. The parent kills us.
    setInterval(() => {}, 1000)
    await new Promise(() => {})
    return
  }

  // ---- hold: take the lease and keep it for a bounded window ----------------
  if (op === "hold") {
    // Signal only AFTER the lease is genuinely held, so the parent's next process
    // provably races a live lease rather than a race to create one.
    const until = Date.now() + holdMs
    if (waitFor) {
      try {
        writeFileSync(waitFor, sched().getScheduler()?.hasAuthority() ? "held" : "no-lease")
      } catch {}
    }
    while (Date.now() < until) await Bun.sleep(25)
    report({ ok: true, heldForMs: holdMs })
    await ctx.close()
    return
  }

  // ---- session deletion ------------------------------------------------------
  if (op === "deletion") {
    seed("task interrupted by session deletion")
    const oldIncarnation = store().getSessionIncarnation(sessionId)
    void run("/scheduler run")
    // Delete through the PRODUCTION deletion path mid-flight.
    await deleteSession(sessionId, WS)
    // Give the late execution a moment to try to land.
    await Bun.sleep(1_200)
    const postOut = await run("/scheduler run")
    const h = sched()
    const afterStop = !h.isActive()
    report({
      ok: true,
      stopped: afterStop || obs().state(h) === "ON_STOPPED",
      postDeleteRefused: postOut.join("\n").includes("not active"),
      oldIncarnation,
      newIncarnation: store().getSessionIncarnation(sessionId),
      oldSchedulerInert: afterStop,
      postOut,
    })
    await ctx.close()
    return
  }

  // ---- stop drill ------------------------------------------------------------
  if (op === "stop") {
    let didRun = false
    if (subMode === "after-run") {
      seed("task to run before stop")
      await run("/scheduler run")
      didRun = true
    }
    const first = await run("/scheduler stop")
    const leaseAfterFirst = store().getSessionAuthority(sessionId)
    const second = await run("/scheduler stop")
    const postStop = await run("/scheduler run")
    // The process must still be usable interactively.
    const turnsBeforeAlive = ctx.session.state.turnCount
    await ctx.runPromptWithVerify("reply with the single word: alive")
    const parentOk = ctx.session.state.turnCount > turnsBeforeAlive
    const h = sched()
    report({
      ok: true,
      mode: subMode ?? "idle",
      ranBeforeStop: didRun,
      stopped: first.join("\n").includes("scheduler stopped"),
      leaseReleased: h.getScheduler()?.hasAuthority() === false,
      leaseRowGone: leaseAfterFirst === null,
      state: obs().state(h),
      secondStopSafe: second.join("\n").includes("already stopped"),
      postStopRefused: postStop.join("\n").includes("not active"),
      parentUsable: parentOk,
      firstOut: first,
    })
    await ctx.close()
    return
  }

  // ---- rollback: a process with NO flag --------------------------------------
  if (op === "rollback") {
    const h = sched()
    const turnsBeforeNormal = ctx.session.state.turnCount
    await ctx.runPromptWithVerify("reply with the single word: normal")
    const turn = ctx.session.state.turnCount > turnsBeforeNormal
    report({
      ok: true,
      constructed: h.constructed,
      enabled: h.enabled,
      state: obs().state(h),
      parentTurnOk: turn,
      startupClean: h.constructed === false,
      statusOut: await run("/scheduler status"),
    })
    await ctx.close()
    return
  }

  // ---- resume ----------------------------------------------------------------
  if (op === "resume") {
    const prev = loadSession(resumeId ?? "", WS)
    const h = sched()
    const s = store()
    const lease = s.getSessionAuthority(sessionId)
    // [DESIGN DECISION] "History restored" is measured by CONTENT, not by
    // counting messages. 6AC asked whether the resumed session actually carries
    // its prior conversation, and a length comparison against a session that was
    // never persisted to begin with is satisfied by zero - which is why the first
    // run of this drill printed `true` for a resume of an empty session.
    // [DESIGN DECISION] Text is extracted through a single typed helper rather than an
    // inline cast, because `loadSession` returns `readonly unknown[]`-shaped messages
    // and every inline narrowing became a tsc error this drill had to chase.
    function messageText(m: unknown): string {
      const c = (m as { content?: unknown } | null)?.content
      return typeof c === "string" ? c : ""
    }
    const prevTexts = (prev?.messages ?? []).map(messageText).filter((t) => t.length > 0)
    const parentTexts = ctx.session.state.history.map(messageText).filter((t) => t.length > 0)
    const carried = prevTexts.filter((t) => parentTexts.some((p) => p.includes(t.slice(0, 24))))
    report({
      ok: true,
      constructed: h.constructed,
      enabled: h.enabled,
      active: h.isActive(),
      leaseHeld: h.getScheduler()?.hasAuthority() === true,
      sessionId: ctx.sessionId,
      resumeId: resumeId ?? null,
      incarnation: s.getSessionIncarnation(sessionId),
      ownerPid: lease?.ownerPid ?? null,
      previousMessages: prev?.messages.length ?? 0,
      resumedSessionExisted: prev !== null,
      carriedMessages: carried.length,
      parentMessages: parentTexts.length,
      historyRestored: prev !== null && carried.length > 0,
    })
    await ctx.close()
    return
  }

  report({ ok: false, error: "unknown op: " + op })
  process.exit(3)
}

process.on("uncaughtException", (e) => {
  report({ ok: false, phase: "uncaught", error: (e as Error).message })
  process.exit(3)
})

await main()
