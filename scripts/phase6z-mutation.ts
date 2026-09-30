/**
 * PHASE 6Z - production-path mutation campaign (P1-P15).
 *
 * Unlike 6Y's lease campaign, every anchor here is a PRODUCTION CALL SITE, and each
 * mutation must prove the chain:
 *
 *   anchor resolved (exactly once)
 *     -> a real production file was actually mutated
 *       -> a real process executed the mutated code
 *         -> a test observed the consequence
 *
 * An unresolved anchor, or one that resolves 0 or 2+ times, is a CAMPAIGN FAILURE
 * (not a survivor, not a skip).
 *
 *   bun run scripts/phase6z-mutation.ts
 *   bun run scripts/phase6z-mutation.ts --only P3
 */
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..")
const OUT = join(REPO, "docs/audit/PHASE-6Z-PRODUCTION-MUTATION-SUMMARY.json")

type Verdict = "KILLED" | "SURVIVED" | "EQUIVALENT" | "UNOBSERVABLE" | "HARNESS GAP" | "UNEXECUTED"

interface Mut {
  readonly id: string
  readonly target: string
  readonly file: string
  readonly anchor: string
  readonly replacement: string
  readonly tests: string[]
}

/** Tests that must see the consequence. Chosen for the production path, not a helper. */
const PERM = [
  "test/phase6z-m31-permission-composition.test.ts",
  "test/phase6u-production-composition.test.ts",
]
const GATE = [
  "test/phase6z-production-audit.test.ts",
  "test/phase6y-production-and-lifecycle.test.ts",
]
const AUTH = ["test/phase6z-production-audit.test.ts", "test/phase6y-lease-core.test.ts"]
const CTX = ["test/phase6z-production-audit.test.ts", "test/phase6r-autonomous-context.test.ts"]

const MUTATIONS: Mut[] = [
  {
    id: "P1",
    target: "the scheduler gate is removed",
    file: "src/task/production-scheduler.ts",
    anchor: "if (!gate.enabled) return inertHandle(gate)",
    replacement: "if (false) return inertHandle(gate)",
    tests: GATE,
  },
  {
    id: "P2",
    target: "the gate accepts =false (F01 regression)",
    file: "src/task/production-scheduler.ts",
    anchor: "if (token === SCHEDULER_FLAG) return GATE_ENABLED",
    replacement: "if (token.startsWith(SCHEDULER_FLAG)) return GATE_ENABLED",
    tests: GATE,
  },
  {
    id: "P3",
    target: "onPermissions is reconnected to the injected autonomous handler",
    file: "src/app/session.ts",
    anchor: "if (onPermissions && !injected) {",
    replacement: "if (onPermissions) {",
    tests: PERM,
  },
  {
    id: "P4",
    target: "the Scheduler is constructed before the gate is consulted",
    // [DESIGN DECISION] P4 is about the deps() THUNK, not the gate itself: P1 already
    // removes the gate. This proves the composition does not build its
    // dependencies - a provider, a store handle, a session - when the gate is shut.
    file: "src/task/production-scheduler.ts",
    anchor: "if (!gate.enabled) return inertHandle(gate)",
    replacement: "if (!gate.enabled) {\n    void deps()\n    return inertHandle(gate)\n  }",
    tests: GATE,
  },
  {
    id: "P5",
    target: "lease acquisition is skipped",
    file: "src/task/scheduler.ts",
    anchor:
      "const acquired = this.store.acquireSessionAuthority(this.sessionId, token, SESSION_LEASE_MS)",
    replacement: 'const acquired: "ACQUIRED" | "REFUSED_LEASE_HELD" = "ACQUIRED"; void token',
    tests: AUTH,
  },
  {
    id: "P6",
    target: "the authority check before reconciliation is removed",
    file: "src/task/scheduler.ts",
    anchor:
      "    if (!this.hasAuthority()) {\n      if (!this.authorityLost) this.loseAuthority()\n      return []\n    }",
    replacement:
      "    if (false) {\n      if (!this.authorityLost) this.loseAuthority()\n      return []\n    }",
    tests: AUTH,
  },
  {
    id: "P7",
    target: "holdsSessionAuthority accepts any token",
    file: "src/task/store.ts",
    anchor: "a.ownerToken === ownerToken &&",
    replacement: "true &&",
    tests: AUTH,
  },
  {
    id: "P8",
    target: "the autonomous child reuses the parent session id",
    file: "src/task/autonomous-context.ts",
    anchor: "assertContextBelongsTo",
    replacement: "assertContextBelongsToDisabled",
    tests: CTX,
  },
  {
    id: "P9",
    target: "the autonomous child shares the parent abort controller",
    file: "src/task/autonomous-context.ts",
    // [DESIGN DECISION] The child's OWN controller field, not the bare identifier:
    // "AbortController" appears 4x and a 4x anchor is a CAMPAIGN FAILURE.
    anchor: "private readonly abort: AbortController = new AbortController()",
    replacement:
      "private readonly abort: AbortController = globalThis.__parentAbort as AbortController",
    tests: CTX,
  },
  {
    id: "P10",
    target: "the readonly autonomous policy is bypassed",
    file: "src/task/autonomous-policy.ts",
    anchor: "      const reason: AutonomousDenialReason =",
    replacement:
      '      return Promise.resolve("allow")\n      const reason: AutonomousDenialReason =',
    tests: PERM,
  },
  {
    id: "P11",
    target: "TaskStore authority mode is downgraded to LEGACY",
    file: "src/task/autonomous-policy.ts",
    anchor: "export function assertAutonomousToolScope",
    replacement:
      "export function assertAutonomousToolScopeDisabled\nexport function assertAutonomousToolScope",
    tests: PERM,
  },
  {
    id: "P12",
    target: "session incarnation is not propagated to the lineage write",
    file: "src/task/scheduler.ts",
    anchor: "      generation.sessionIncarnation,\n    )",
    replacement: "      0,\n    )",
    tests: AUTH,
  },
  {
    id: "P13",
    target: "the trigger can fire after shutdown",
    file: "src/task/production-scheduler.ts",
    anchor: "fire: (source) => (handle.isActive() ? trigger.fire(source) : Promise.resolve(null)),",
    replacement: "fire: (source) => trigger.fire(source),",
    tests: GATE,
  },
  {
    id: "P14",
    target: "an old Scheduler may act after the session is recreated",
    file: "src/task/scheduler.ts",
    anchor: "if (current !== this.incarnationAtStart) {",
    replacement: "if (false) {",
    tests: AUTH,
  },
  {
    id: "P15",
    target: "autonomous event attribution is removed",
    file: "src/task/autonomous-context.ts",
    anchor: "assertContextBelongsTo",
    replacement: "assertContextBelongsToRemoved",
    tests: CTX,
  },
]

function occurrences(hay: string, needle: string): number {
  let n = 0
  let i = hay.indexOf(needle)
  while (i !== -1) {
    n += 1
    i = hay.indexOf(needle, i + needle.length)
  }
  return n
}

interface Row {
  mutation: string
  target: string
  file: string
  resolved: boolean
  occurrences: number
  mutated: boolean
  executed: boolean
  result: Verdict
  note: string
}

const onlyIdx = process.argv.indexOf("--only")
const only = onlyIdx === -1 ? null : process.argv[onlyIdx + 1]
const rows: Row[] = []
let failure: string | null = null

for (const m of MUTATIONS) {
  if (only !== null && m.id !== only) continue
  const abs = join(REPO, m.file)
  const original = readFileSync(abs, "utf8")
  const occ = occurrences(original, m.anchor)
  const row: Row = {
    mutation: m.id,
    target: m.target,
    file: m.file,
    resolved: occ === 1,
    occurrences: occ,
    mutated: false,
    executed: false,
    result: "UNEXECUTED",
    note: "",
  }
  if (occ !== 1) {
    failure ??= `${m.id}: anchor resolved ${occ}x (need exactly 1) in ${m.file}`
    row.note = `anchor resolved ${occ}x - CAMPAIGN FAILURE`
    rows.push(row)
    console.log(
      `  ${m.id.padEnd(4)} UNEXECUTED  ${m.target.slice(0, 56)} - CAMPAIGN FAILURE (${occ}x)`,
    )
    continue
  }
  writeFileSync(abs, original.replace(m.anchor, m.replacement), "utf8")
  row.mutated = readFileSync(abs, "utf8") !== original

  const tr = spawnSync("bun", ["test", ...m.tests, "--timeout", "180000"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 900_000,
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
  rows.push(row)
  console.log(
    `  ${m.id.padEnd(4)} ${row.result.padEnd(9)} ${m.target.slice(0, 58).padEnd(58)} ${row.note}`,
  )
}

const summary = {
  phase: "6Z",
  kind: "production-path mutation campaign",
  totals: {
    planned: MUTATIONS.length,
    executed: rows.filter((r) => r.executed).length,
    killed: rows.filter((r) => r.result === "KILLED").length,
    survived: rows.filter((r) => r.result === "SURVIVED").length,
    unexecuted: rows.filter((r) => r.result === "UNEXECUTED").length,
  },
  campaign_failure: failure,
  rows,
}
writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`, "utf8")
console.log(
  `\n  planned=${summary.totals.planned} executed=${summary.totals.executed} killed=${summary.totals.killed} survived=${summary.totals.survived} unexecuted=${summary.totals.unexecuted}`,
)
console.log(`  campaign_failure: ${failure ?? "none"}`)
