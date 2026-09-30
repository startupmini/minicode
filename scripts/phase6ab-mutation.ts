/**
 * PHASE 6AB - production-path mutation campaign (M1-M14).
 *
 * Every anchor here is a PRODUCTION call site introduced or relied upon by 6AB,
 * and each mutation must prove the chain 6Z established:
 *
 *   anchor resolved (exactly once)
 *     -> a real production file was actually mutated
 *       -> a real process executed the mutated code
 *         -> a test observed the consequence
 *
 * An unresolved anchor, or one that resolves 0 or 2+ times, is a CAMPAIGN FAILURE
 * (not a survivor, not a skip). UNEXECUTED = campaign failure.
 *
 * [DESIGN DECISION] Every mutant here targets the CALLER, never the helper. M1
 * removes the production `fire()` call rather than breaking TriggerCoordinator;
 * M5 skips lease acquisition at the composition site rather than in the store. A
 * campaign that mutated helpers would have passed while the product stayed broken
 * - which is exactly how 6AA shipped an inert enablement flag.
 *
 *   bun run scripts/phase6ab-mutation.ts
 *   bun run scripts/phase6ab-mutation.ts --only M4
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..")
const OUT = join(REPO, "docs/audit/PHASE-6AB-PRODUCTION-MUTATION-SUMMARY.json")

type Verdict = "KILLED" | "SURVIVED" | "EQUIVALENT" | "UNOBSERVABLE" | "HARNESS GAP" | "UNEXECUTED"

interface Mut {
  readonly id: string
  readonly target: string
  readonly file: string
  readonly anchor: string
  readonly replacement: string
  readonly tests: string[]
}

const NL = "\n"

/** The 6AB production path: trigger reachability, semantics, security, properties. */
const TRIGGER = [
  "test/phase6ab-production-trigger.test.ts",
  "test/phase6ab-process-boundary.test.ts",
]
/** Observability, help text and the composition wiring. */
const OBS = ["test/phase6ab-production-trigger.test.ts"]
/** Lifecycle, authority and cross-process effects. */
const LIFE = [
  "test/phase6ab-production-trigger.test.ts",
  "test/phase6ab-process-boundary.test.ts",
  "test/phase6z-production-audit.test.ts",
]

const MUTATIONS: Mut[] = [
  {
    id: "M1",
    target: "the production fire() call is removed from the operator command",
    file: "cli/commands.ts",
    anchor: 'const result = await handle.fire("explicit-command")',
    replacement: "const result = null as Awaited<ReturnType<typeof handle.fire>>",
    tests: TRIGGER,
  },
  {
    id: "M2",
    target: "the trigger handle is dropped instead of exposed on the session",
    file: "cli/setup.ts",
    anchor: `    productionScheduler,${NL}    schedulerObservability,`,
    replacement: `    // M2 mutant: the handle is dropped on the floor${NL}    schedulerObservability,`,
    tests: TRIGGER,
  },
  {
    id: "M3",
    target: "the command context is given another session's identity",
    file: "cli/tui.ts",
    anchor: `      handle: productionScheduler,`,
    replacement: `      handle: productionScheduler,${NL}      __M3_session: "not-this-session",`,
    tests: OBS,
  },
  {
    id: "M4",
    target: "the command no longer refuses a trigger after stop",
    file: "cli/commands.ts",
    anchor: `    if (!handle.isActive()) {${NL}      // Reachable after`,
    replacement: `    if (false) {${NL}      // Reachable after`,
    tests: TRIGGER,
  },
  {
    id: "M5",
    target: "lease acquisition failures are swallowed at the composition root",
    file: "src/task/production-scheduler.ts",
    anchor: `  scheduler.start()${NL}  active = true`,
    replacement: `  try {${NL}    scheduler.start()${NL}  } catch {}${NL}  active = true`,
    tests: LIFE,
  },
  {
    id: "M6",
    // [DESIGN DECISION] The first attempt at this mutant selected from
    // `snapshot.tasks` when nothing was ready. It SURVIVED, and that was correct:
    // `selectTask` re-checks state, so widening the candidate list changes nothing
    // observable. The mutant was EQUIVALENT, not undetected - and a campaign that
    // keeps an equivalent mutant because it flatters the numbers is measuring
    // nothing at all.
    //
    // This version attacks the actual READINESS COMPUTATION, which is the boundary
    // section 17 names. If readiness is ignored, a CANCELLED task becomes
    // claimable, and the claim itself is the observable damage.
    target: "the cycle ignores graph readiness and treats every task as a candidate",
    file: "src/task/scheduler.ts",
    anchor: "    const ready = graph.readyTasks()",
    replacement: "    const ready = snapshot.tasks",
    tests: TRIGGER,
  },
  {
    id: "M7",
    // [DESIGN DECISION] The first attempt replaced the autonomous child's
    // `permissionHandler` with an allow-all. It SURVIVED, and understanding why
    // produced the most useful single fact of this campaign: that handler is NOT
    // the enforcement point. 6S enforces the boundary earlier and twice over -
    // `assertAutonomousToolScope` at adapter construction, and the READ_ONLY
    // allow-list that produces the tool set in the first place. A test that
    // "proves permission is enforced" by weakening the handler proves nothing.
    //
    // This version asks the question that actually matters: what if production gave
    // the autonomous executor the FULL session tool set? The answer must be a loud
    // construction failure, and the mutation proves the boundary is enforced where a
    // real widening would meet it.
    target: "the autonomous executor is given the full session tool set",
    file: "cli/setup.ts",
    anchor: "const autonomousTools = AUTONOMOUS_TOOL_NAMES.map((name) =>",
    replacement: "const autonomousTools = sessionTools.map((t) => t.name).map((name) =>",
    tests: TRIGGER,
  },
  {
    id: "M8",
    target: "production observability sinks are removed",
    file: "cli/setup.ts",
    anchor: `        onSchedulerEvent: (e) => schedulerObservability.noteSchedulerEvent(e),${NL}        onTriggerEvent: (e) => schedulerObservability.noteTriggerEvent(e),`,
    replacement: `        // M8 mutant: no production observability`,
    tests: OBS,
  },
  {
    id: "M9",
    target: "the shutdown stop wiring is dropped",
    file: "cli/setup.ts",
    anchor: `      await productionScheduler.stop("shutdown")`,
    replacement: `      // M9 mutant: shutdown no longer stops the scheduler`,
    tests: LIFE,
  },
  {
    id: "M10",
    target: "help text claims continuous background scheduling",
    file: "cli/index.ts",
    anchor: "no background timer",
    replacement: "Runs continuously in the background on a timer",
    tests: OBS,
  },
  {
    id: "M11",
    target: "--resume is no longer passed to the composition root",
    file: "cli/index.ts",
    anchor: `  resumeId,`,
    replacement: `  resumeId: undefined,`,
    tests: OBS,
  },
  {
    id: "M12",
    target: "the Scheduler is constructed against a process-global session",
    file: "src/task/production-scheduler.ts",
    anchor: "  const scheduler = new Scheduler(d.sessionId, {",
    replacement: '  const scheduler = new Scheduler("process-global-session", {',
    tests: TRIGGER,
  },
  {
    id: "M13",
    target: "session deletion no longer stops the scheduler",
    file: "src/task/production-scheduler.ts",
    anchor: `    notifySessionDeleted: () => handle.stop("session-deleted"),`,
    replacement: `    notifySessionDeleted: () => Promise.resolve(),`,
    tests: TRIGGER,
  },
  {
    id: "M14",
    target: "authority loss no longer self-disposes, so triggering could continue",
    file: "src/task/scheduler.ts",
    anchor: `      if (!this.authorityLost) this.loseAuthority()${NL}      return { stop: "authority-lost", dispatched: null, recovered: [] }`,
    replacement: `      // M14 mutant: authority loss is not acted upon${NL}      return { stop: "authority-lost", dispatched: null, recovered: [] }`,
    tests: TRIGGER,
  },
]

const onlyIdx = process.argv.indexOf("--only")
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null
const fromIdx = process.argv.indexOf("--from")
const from = fromIdx >= 0 ? process.argv[fromIdx + 1] : null

/**
 * Accumulating summary.
 *
 * [DESIGN DECISION] Results MERGE into the existing summary rather than replacing
 * it. A full 14-mutant campaign runs for many minutes, which does not fit in one
 * uninterrupted shell session here; without merging, every partial run would erase
 * the evidence of the ones before it and the campaign would end with a summary
 * containing exactly one row. Merging by id makes an interrupted campaign
 * recoverable and its final summary complete.
 */
type Row = Record<string, unknown> & { id: string }
let merged: Record<string, unknown> = {}
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, "utf8")) as { rows?: Row[] }
    merged = { rows: prev.rows ?? [] }
  } catch {
    merged = {}
  }
}
const mergedRows: Row[] = (merged.rows as Row[]) ?? []

/**
 * Crash-safe restore.
 *
 * [DESIGN DECISION] Every mutation is backed up to `<file>.m5bak` BEFORE it is
 * applied, and restored on every exit path including SIGINT/SIGTERM. An earlier
 * run of this campaign was killed mid-flight and left an M5 mutant committed into
 * `production-scheduler.ts`; a campaign that can strand a mutant in a production
 * file is worse than no campaign, because the next test run reports green results
 * against mutated code.
 *
 * The backup also makes recovery possible after a hard kill: `--restore` puts
 * every `.m5bak` back without needing this process to still be alive.
 */
const BACKUP_SUFFIX = ".m5bak"
const activeBackups = new Map<string, string>()

function restoreAll(): void {
  for (const [abs, backup] of activeBackups) {
    try {
      writeFileSync(abs, readFileSync(backup, "utf8"), "utf8")
      console.error(`  restored ${abs} from backup`)
    } catch {}
  }
  activeBackups.clear()
}

process.on("exit", restoreAll)
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    restoreAll()
    process.exit(130)
  })
}

if (process.argv.includes("--restore")) {
  // Sweep any backup a killed run left behind.
  for (const m of MUTATIONS) {
    const abs = join(REPO, m.file)
    const backup = abs + BACKUP_SUFFIX
    if (existsSync(backup)) {
      writeFileSync(abs, readFileSync(backup, "utf8"), "utf8")
      console.log(`  restored ${m.file} from ${BACKUP_SUFFIX}`)
    }
  }
  console.log("  restore sweep complete")
  process.exit(0)
}

let planned = MUTATIONS
if (only) planned = MUTATIONS.filter((m) => m.id === only)
else if (from) planned = MUTATIONS.filter((m) => m.id >= from)

/** Merge one row into the accumulated campaign, replacing any earlier row for it. */
function mergeRow(row: Record<string, unknown>): void {
  const asRow = row as Row
  const at = mergedRows.findIndex((r) => r.id === asRow.id)
  if (at >= 0) mergedRows[at] = asRow
  else mergedRows.push(asRow)
  mergedRows.sort((a, b) => a.id.localeCompare(b.id))
}

if (only && planned.length === 0) {
  console.error(`  unknown mutant id: ${only}`)
  process.exit(2)
}

console.log(`  PHASE 6AB production-path mutation campaign (${planned.length} planned)\n`)

let failure: string | null = null
const rows: Record<string, unknown>[] = []

for (const m of planned) {
  const abs = join(REPO, m.file)
  const original = readFileSync(abs, "utf8")
  const occ = original.split(m.anchor).length - 1

  const row: Record<string, unknown> = {
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
    failure ??= `${m.id}: anchor resolved ${occ}x (need exactly 1) in ${m.file}`
    row.note = `anchor resolved ${occ}x - CAMPAIGN FAILURE`
    rows.push(row)
    mergeRow(row)
    console.log(
      `  ${m.id.padEnd(4)} UNEXECUTED  ${m.target.slice(0, 52).padEnd(52)} ANCHOR ${occ}x`,
    )
    continue
  }

  const backup = abs + BACKUP_SUFFIX
  writeFileSync(backup, original, "utf8")
  activeBackups.set(abs, backup)
  writeFileSync(abs, original.replace(m.anchor, m.replacement), "utf8")
  row.mutated = readFileSync(abs, "utf8") !== original

  const tr = spawnSync("bun", ["test", ...m.tests, "--timeout", "180000"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 1_800_000,
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
  } else {
    row.result = "SURVIVED"
    row.note = "no test detected the mutation"
  }

  writeFileSync(abs, original, "utf8")
  try {
    unlinkSync(backup)
  } catch {}
  activeBackups.delete(abs)
  rows.push(row)
  console.log(
    `  ${m.id.padEnd(4)} ${String(row.result).padEnd(9)} ${m.target.slice(0, 54).padEnd(54)} ${row.note}`,
  )
  mergeRow(row)
}

const summary = {
  phase: "6AB",
  kind: "production-path mutation campaign",
  generated_at: new Date().toISOString(),
  totals: {
    planned: MUTATIONS.length,
    executed: mergedRows.filter((r) => r.executed).length,
    killed: mergedRows.filter((r) => r.result === "KILLED").length,
    survived: mergedRows.filter((r) => r.result === "SURVIVED").length,
    unexecuted: mergedRows.filter((r) => r.result === "UNEXECUTED").length,
  },
  campaign_failure: mergedRows.find((r) => r.result === "UNEXECUTED")
    ? `unresolved anchor in ${mergedRows.find((r) => r.result === "UNEXECUTED")!.id}`
    : null,
  complete: mergedRows.length === MUTATIONS.length,
  rows: mergedRows,
}
writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`, "utf8")
const t = summary.totals
console.log(
  `\n  accumulated=${mergedRows.length}/${MUTATIONS.length} killed=${t.killed} survived=${t.survived} unexecuted=${t.unexecuted}`,
)
console.log(`  campaign_failure: ${summary.campaign_failure ?? "none"}`)
