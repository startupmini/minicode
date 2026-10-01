/**
 * PHASE 6AD - production-path mutation campaign (M1-M18).
 *
 * SECTION 17: every mutation must target an ACTUAL PRODUCTION EXECUTION PATH.
 * Not a helper, not a description table, not a unit.
 *
 * [DESIGN DECISION] Two of these mutants are written specifically to attack the
 * mistakes this project has already made, because a campaign that only tests the
 * mistakes you have not made yet is decoration:
 *
 *   M10 removes INCARNATION PROPAGATION  - the 6Q layer that 6AC confirmed live.
 *   M16 routes scheduler events to USER PRESENTATION - 6AB's event routing, whose
 *          only test asserts a source-level pattern. If that assertion is wrong,
 *          this mutant is what notices.
 *
 * [DESIGN DECISION] Every mutant here targets a CALL SITE, not a helper. 6AB's
 * M1 note applies: mutating helpers proves helpers are covered, which is how 6AA
 * shipped an inert flag with a fully-covered trigger layer.
 *
 * Crash-safe: each mutation is backed up before application and restored on every
 * exit path. 6AB lost two mutants to killed runs; this is not optional.
 *
 *   bun run scripts/phase6ad-mutation.ts
 *   bun run scripts/phase6ad-mutation.ts --only=M4
 *   bun run scripts/phase6ad-mutation.ts --restore
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..")
const OUT = join(REPO, "docs", "audit", "PHASE-6AD-MUTATION-SUMMARY.json")
const BACKUP = ".m6adbak"

type Verdict = "KILLED" | "SURVIVED" | "EQUIVALENT" | "UNOBSERVABLE" | "HARNESS GAP" | "UNEXECUTED"

interface Mut {
  readonly id: string
  readonly target: string
  readonly file: string
  readonly anchor: string
  readonly replacement: string
  readonly tests: string[]
  /** Why a survivor would be EQUIVALENT rather than a gap. Required when set. */
  readonly equivalence?: string
}

const NL = "\n"

/**
 * The production-path suites. Every mutant is executed against tests that compose
 * the REAL product, spawn REAL processes, and read REAL persistence.
 *
 * [DESIGN DECISION] `PROD` is the 6AC suite: real `createCliSession`, real
 * `/scheduler run`, real SQLite. `OBS` adds the observability assertions. `CRASH`
 * adds the recovery sequence.
 */
const PROD = ["test/phase6ac-controlled-enablement.test.ts", "test/phase6ad-adversarial.test.ts"]
const OBS = ["test/phase6ac-controlled-enablement.test.ts", "test/phase6ad-adversarial.test.ts"]
/**
 * The permission mutant's suite.
 *
 * [DESIGN DECISION] Kept separate rather than folded into `PROD` because the
 * first 6AD run gave M4 only the 6AC/6AD lists and it SURVIVED. That was a
 * CAMPAIGN defect, not a coverage gap: 6Z's M31 composition test already kills
 * this exact mutant, and it was simply not in the list. Listing a mutant
 * without the test that kills it is how a campaign manufactures false
 * confidence, so the list names the killer explicitly.
 */
const PERM = [
  "test/phase6z-m31-permission-composition.test.ts",
  "test/phase6ac-controlled-enablement.test.ts",
  "test/phase6ad-adversarial.test.ts",
]
const CRASH = [
  "test/phase6ac-controlled-enablement.test.ts",
  "test/phase6ad-process-authority.test.ts",
  "test/phase6ad-adversarial.test.ts",
]

const MUTATIONS: Mut[] = [
  {
    id: "M1",
    target: "the production gate is removed",
    file: "src/task/production-scheduler.ts",
    anchor: "  if (!gate.enabled) return inertHandle(gate)",
    replacement: "  if (false) return inertHandle(gate)",
    tests: PROD,
  },
  {
    id: "M2",
    target: "the false form of the flag is accepted as enabled",
    file: "src/task/production-scheduler.ts",
    // [DEFECT FOUND AND FIXED] The anchor still pointed at a token-scanning gate
    // (`token === SCHEDULER_FLAG`) from a pre-6AB revision. 6AB moved flag
    // parsing to the composition root, so the real gate is the strict
    // `enabled === true` identity check in `schedulerGateFor`. The anchor
    // resolved 0x and the campaign reported M2 UNEXECUTED rather than quietly
    // skipping it - which is exactly the behaviour §19 requires.
    //
    // [DESIGN DECISION] The mutant is the LOOSE truthiness form. The property is
    // "only the literal true is enabled", so anything that treats a merely
    // truthy value - a string "false" from a hand-rolled parse, a 1 - as enabled
    // is the mutation. This is the mutation that would turn a typo in flag
    // plumbing into silent autonomous execution.
    anchor: "  return enabled === true ? GATE_ENABLED : GATE_DISABLED",
    replacement: "  return enabled ? GATE_ENABLED : GATE_DISABLED",
    tests: PROD,
  },
  {
    id: "M3",
    target: "the autonomous executor is given the full session tool set",
    file: "cli/setup.ts",
    anchor: "      const autonomousTools = AUTONOMOUS_TOOL_NAMES.map((name) =>",
    replacement: "      const autonomousTools = sessionTools.map((t) => t.name).map((name) =>",
    tests: PROD,
  },
  {
    id: "M4",
    target: "the autonomous permission handler is bypassed in the child session",
    file: "src/app/session.ts",
    anchor: "  if (onPermissions && !injected) {",
    replacement: "  if (onPermissions) {",
    // [DESIGN DECISION] 6Z already killed this exact mutant (P3) with the M31
    // composition test. The first 6AD run listed only the 6AC/6AD suites and it
    // SURVIVED - not because the mutant is unkillable, but because the test that
    // kills it was not in the list. That is a campaign defect, not a coverage gap.
    tests: PERM,
  },
  {
    id: "M5",
    target: "lease acquisition is skipped at the composition root",
    file: "src/task/production-scheduler.ts",
    anchor: `  scheduler.start()${NL}  active = true`,
    replacement: `  try {${NL}    scheduler.start()${NL}  } catch {}${NL}  active = true`,
    tests: CRASH,
  },
  {
    id: "M6",
    target: "the cycle ignores graph readiness",
    file: "src/task/scheduler.ts",
    anchor: "    const ready = graph.readyTasks()",
    replacement: "    const ready = snapshot.tasks",
    tests: PROD,
  },
  {
    id: "M7",
    target: "the autonomous child reuses the parent session id",
    file: "cli/setup.ts",
    anchor: "          parentSessionId: sessionId,",
    replacement: '          parentSessionId: "shared-parent",',
    tests: PROD,
  },
  {
    id: "M8",
    // The seam is the CONTEXT'S OWN AbortController, not a config field. 6R
    // creates it per execution and never accepts a parent signal, so the honest
    // mutant is the one that would make a child observe the parent's cancellation.
    target: "the autonomous context is wired to a SHARED global abort controller",
    file: "src/task/autonomous-context.ts",
    anchor: "  private readonly abort: AbortController = new AbortController()",
    replacement:
      "  private readonly abort: AbortController = ((globalThis as never as { __m8?: AbortController }).__m8 ??= new AbortController())",
    tests: PROD,
  },
  {
    id: "M9",
    target: "the cycle selects from every task rather than ready ones",
    file: "src/task/scheduler.ts",
    anchor: "    const selection = selectTask(ready, snapshot)",
    replacement:
      "    const selection = selectTask(ready.length > 0 ? ready : snapshot.tasks, snapshot)",
    tests: PROD,
    equivalence:
      "selectTask re-checks claimability internally, so widening the candidate list is observationally identical. 6AB measured this: the mutant was replaced by one that attacks the readiness COMPUTATION (M6 here).",
  },
  {
    id: "M10",
    target: "incarnation propagation is removed from the autonomous binding",
    file: "cli/setup.ts",
    anchor: "          sessionIncarnation: store.getSessionIncarnation(sessionId),",
    replacement: "          sessionIncarnation: 1,",
    tests: PROD,
  },
  {
    id: "M11",
    target: "ownership propagation is removed from the autonomous binding",
    file: "cli/setup.ts",
    anchor:
      "          execGeneration: store.getExecutionLineage(sessionId, taskId)?.execGeneration ?? 0,",
    replacement: "          execGeneration: 1,",
    tests: PROD,
  },
  {
    id: "M12",
    target: "the Scheduler treats a not-ok autonomous return as a successful one",
    // [DESIGN DECISION] Anchored on the EMIT, not on the return value, and with
    // surrounding context because the same expression appears three times. The
    // emit is what the operator's activity log is built from, so a mutant here
    // changes what 6AD section 15 can tell them.
    file: "src/task/scheduler.ts",
    anchor: `      kind: "task:execution_completed",${NL}      taskId: work.taskId,${NL}      ok: observation.kind === "returned" && observation.ok,`,
    replacement: `      kind: "task:execution_completed",${NL}      taskId: work.taskId,${NL}      ok: observation.kind === "returned",`,
    tests: PROD,
  },
  {
    id: "M13",
    target: "duplicate triggers are permitted to run concurrently",
    file: "src/task/trigger.ts",
    anchor: "    if (this.inFlight !== null) {",
    replacement: "    if (false) {",
    tests: PROD,
  },
  {
    id: "M14",
    target: "a trigger after stop is allowed through",
    // [DESIGN DECISION] Anchored with the following comment, because
    // `if (!handle.isActive()) {` appears in BOTH the run and stop branches and a
    // bare anchor resolves 2x - which is a CAMPAIGN FAILURE, not a skip.
    file: "cli/commands.ts",
    anchor:
      "    if (!handle.isActive()) {" +
      NL +
      "      // Reachable after `/scheduler stop`, after `close()`, or after the renewal",
    replacement:
      "    if (false) {" +
      NL +
      "      // Reachable after `/scheduler stop`, after `close()`, or after the renewal",
    tests: PROD,
  },
  {
    id: "M15",
    target: "an old Scheduler may keep scheduling after session recreation",
    file: "src/task/production-scheduler.ts",
    anchor: `    notifySessionDeleted: () => handle.stop("session-deleted"),`,
    replacement: `    notifySessionDeleted: () => Promise.resolve(),`,
    tests: PROD,
  },
  {
    id: "M16",
    target: "scheduler events are routed into the user conversation",
    file: "cli/tui.ts",
    anchor: "  schedulerObservability?.onSchedulerNotice((line) =>",
    replacement:
      "  schedulerObservability?.onSchedulerNotice((line) => void (sessionPushUser as never)(line) ||",
    tests: OBS,
  },
  {
    id: "M17",
    target: "cancellation is suppressed on stop",
    file: "src/task/production-scheduler.ts",
    anchor: "      scheduler.cancelActive(reason)",
    replacement: "      // M17 mutant: cancellation suppressed",
    tests: PROD,
  },
  {
    id: "M18",
    target: "the production trigger call is removed",
    file: "cli/commands.ts",
    anchor: 'const result = await handle.fire("explicit-command")',
    replacement: "const result = null as Awaited<ReturnType<typeof handle.fire>>",
    tests: PROD,
  },
]

// ─── crash-safe mutation ─────────────────────────────────────────────────────

const active = new Map<string, string>()

function restoreAll(): void {
  for (const [abs, backup] of active) {
    try {
      writeFileSync(abs, readFileSync(backup, "utf8"), "utf8")
      console.error(`  restored ${abs}`)
    } catch {}
  }
  active.clear()
}

process.on("exit", restoreAll)
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    restoreAll()
    process.exit(130)
  })
}

if (process.argv.includes("--restore")) {
  for (const m of MUTATIONS) {
    const abs = join(REPO, m.file)
    const backup = abs + BACKUP
    if (existsSync(backup)) {
      writeFileSync(abs, readFileSync(backup, "utf8"), "utf8")
      console.log(`  restored ${m.file}`)
      try {
        unlinkSync(backup)
      } catch {}
    }
  }
  console.log("  restore sweep complete")
  process.exit(0)
}

// ─── run ─────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown> & { id: string }
let merged: { rows?: Row[] } = {}
if (existsSync(OUT)) {
  try {
    merged = JSON.parse(readFileSync(OUT, "utf8")) as { rows?: Row[] }
  } catch {
    merged = {}
  }
}
const rows: Row[] = merged.rows ?? []

function mergeRow(row: Row): void {
  const at = rows.findIndex((r) => r.id === row.id)
  if (at >= 0) rows[at] = row
  else rows.push(row)
  rows.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * [DEFECT FOUND AND FIXED] The first version read `--only` with
 * `argv.indexOf("--only")`, which only matches the SPACE form. The `--only=M4`
 * form the file's own usage comment advertised returned -1, so `only` stayed
 * null and the script silently ran the ENTIRE campaign. Two consequences, both
 * real: (1) an operator asking for one mutant got eighteen, and (2) - worse -
 * the summary was written from a run they did not ask for, so they could read a
 * fresh-looking report that never contained the mutant they were debugging.
 *
 * A tool that ignores the scope you gave it does not get to report on that
 * scope. Both spellings are now accepted, and a value that looks like another
 * flag is rejected rather than swallowed.
 */
function flag(name: string): string | null {
  const args = process.argv.slice(2)
  const joined = args.find((a) => a.startsWith(`${name}=`))
  if (joined) return joined.slice(name.length + 1)
  const at = args.indexOf(name)
  if (at < 0) return null
  const value = args[at + 1]
  if (value === undefined || value.startsWith("--")) {
    console.error(`  ${name} requires a value`)
    process.exit(2)
  }
  return value
}

const only = flag("--only")
const from = flag("--from")
let planned = MUTATIONS
if (only) planned = MUTATIONS.filter((m) => m.id === only)
else if (from) planned = MUTATIONS.filter((m) => m.id >= from)

if (only && planned.length === 0) {
  console.error(`  unknown mutant id: ${only}`)
  process.exit(2)
}

console.log(`  PHASE 6AD production-path mutation campaign (${planned.length} planned)\n`)

let campaignFailure: string | null = null

for (const m of planned) {
  const abs = join(REPO, m.file)
  const original = readFileSync(abs, "utf8")
  const occ = original.split(m.anchor).length - 1

  const row: Row = {
    id: m.id,
    target: m.target,
    file: m.file,
    resolved: occ === 1,
    occurrences: occ,
    mutated: false,
    executed: false,
    result: "UNEXECUTED" as Verdict,
    tests: m.tests,
    note: "",
  }

  if (occ !== 1) {
    campaignFailure ??= `${m.id}: anchor resolved ${occ}x (need exactly 1) in ${m.file}`
    row.note = `anchor resolved ${occ}x - CAMPAIGN FAILURE`
    mergeRow(row)
    console.log(
      `  ${m.id.padEnd(4)} UNEXECUTED  ${m.target.slice(0, 50).padEnd(50)} ANCHOR ${occ}x`,
    )
    continue
  }

  const backup = abs + BACKUP
  writeFileSync(backup, original, "utf8")
  active.set(abs, backup)
  writeFileSync(abs, original.replace(m.anchor, m.replacement), "utf8")
  row.mutated = readFileSync(abs, "utf8") !== original

  const tr = spawnSync("bun", ["test", ...m.tests, "--timeout", "180000"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 1_800_000,
    shell: true,
  })
  row.executed = true

  const out = `${tr.stdout ?? ""}${tr.stderr ?? ""}`
  const failMatch = out.match(/^\s*(\d+)\s+fail/m)
  const failed = failMatch ? Number(failMatch[1]) : 0
  const compileBroke = /error TS|Syntax Error|Expected .* but found|Unexpected/.test(out)

  if (failed > 0) {
    row.result = "KILLED"
    row.note = `${failed} test(s) failed under mutant`
  } else if (tr.status !== 0 && compileBroke) {
    row.result = "KILLED"
    row.note = "mutant does not compile"
  } else if (tr.status !== 0) {
    row.result = "KILLED"
    row.note = `non-zero exit ${tr.status}`
  } else if (m.equivalence) {
    row.result = "EQUIVALENT"
    row.note = m.equivalence
  } else {
    row.result = "SURVIVED"
    row.note = "no test detected the mutation"
  }

  writeFileSync(abs, original, "utf8")
  try {
    unlinkSync(backup)
  } catch {}
  active.delete(abs)
  mergeRow(row)
  console.log(
    `  ${m.id.padEnd(4)} ${String(row.result).padEnd(11)} ${m.target.slice(0, 52).padEnd(52)} ${String(row.note).slice(0, 40)}`,
  )
}

const summary = {
  phase: "6AD",
  kind: "production-path mutation campaign",
  generated_at: new Date().toISOString(),
  totals: {
    planned: MUTATIONS.length,
    executed: rows.filter((r) => r.executed).length,
    killed: rows.filter((r) => r.result === "KILLED").length,
    survived: rows.filter((r) => r.result === "SURVIVED").length,
    equivalent: rows.filter((r) => r.result === "EQUIVALENT").length,
    unexecuted: rows.filter((r) => r.result === "UNEXECUTED").length,
  },
  campaign_failure: campaignFailure,
  complete: rows.length === MUTATIONS.length,
  rows,
}
writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`, "utf8")
const t = summary.totals
console.log(
  `\n  accumulated=${rows.length}/${MUTATIONS.length} killed=${t.killed} survived=${t.survived} equivalent=${t.equivalent} unexecuted=${t.unexecuted}`,
)
console.log(`  campaign_failure: ${campaignFailure ?? "none"}`)
