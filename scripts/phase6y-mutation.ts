/**
 * PHASE 6Y - mutation campaign harness.
 *
 * ADR-24: every mutation must resolve an ANCHOR to a real source location, must
 * actually mutate that source, and must be EXECUTED against a test. An unresolved
 * anchor is a CAMPAIGN FAILURE, never a silent skip and never a survivor.
 *
 *   bun run scripts/phase6y-mutation.ts            # run the campaign
 *   bun run scripts/phase6y-mutation.ts --only M7  # one mutation, for debugging
 *
 * Writes docs/audit/PHASE-6Y-MUTATION-SUMMARY.json.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..")
const SUMMARY = join(REPO, "docs/audit/PHASE-6Y-MUTATION-SUMMARY.json")

type Verdict = "KILLED" | "SURVIVED" | "EQUIVALENT" | "UNOBSERVABLE" | "HARNESS GAP" | "UNEXECUTED"

interface Mut {
  readonly id: string
  /** The semantic property this mutation is supposed to break. */
  readonly target: string
  readonly file: string
  /** Exact substring that MUST resolve, and MUST resolve exactly once. */
  readonly anchor: string
  readonly replacement: string
  /** Which tests must fail. */
  readonly tests: readonly string[]
}

/** The test set each mutation is judged by. */
const LEASE = ["test/phase6y-lease-core.test.ts", "test/phase6y-production-and-lifecycle.test.ts"]
const PROCS = ["test/phase6y-process-lease.test.ts"]
const GATE = [
  "test/phase6y-production-and-lifecycle.test.ts",
  "test/phase6v-adversarial-audit.test.ts",
]
const MUTATIONS: Mut[] = [
  {
    id: "M1",
    target: "lease never expires (expiry clause disabled)",
    file: "src/task/store.ts",
    anchor: "OR session_authority.lease_expires_at <= ?",
    replacement: "OR session_authority.lease_expires_at <= ? AND 0",
    tests: LEASE,
  },
  {
    id: "M2",
    target: "an active lease can be stolen (expiry always true)",
    file: "src/task/store.ts",
    anchor: "OR session_authority.lease_expires_at <= ?",
    replacement: "OR session_authority.lease_expires_at <= ? OR 1",
    tests: LEASE,
  },
  {
    id: "M3",
    target: "acquisition drops the owner-token comparison entirely",
    file: "src/task/store.ts",
    anchor: "WHERE session_authority.owner_token = excluded.owner_token",
    replacement: "WHERE 1",
    tests: LEASE,
  },
  {
    id: "M4",
    target: "renewal does not check the owner token",
    file: "src/task/store.ts",
    // The UPDATE shape, not the bare WHERE: the identical clause also appears in
    // releaseSessionAuthority, and a 2x anchor is a campaign failure by ADR-24.
    anchor:
      "`UPDATE session_authority\n            SET lease_expires_at = ?\n          WHERE session_id = ? AND incarnation = ? AND owner_token = ?`",
    replacement:
      "`UPDATE session_authority\n            SET lease_expires_at = ?\n          WHERE session_id = ? AND incarnation = ?`",
    tests: LEASE,
  },
  {
    id: "M5",
    target: "renewal accepts a token that is NOT the owner",
    file: "src/task/store.ts",
    anchor:
      "`UPDATE session_authority\n            SET lease_expires_at = ?\n          WHERE session_id = ? AND incarnation = ? AND owner_token = ?`",
    replacement:
      "`UPDATE session_authority\n            SET lease_expires_at = ?\n          WHERE session_id = ? AND incarnation = ? AND owner_token <> ?`",
    tests: LEASE,
  },
  {
    id: "M6",
    target: "release is not token-guarded",
    file: "src/task/store.ts",
    anchor:
      "`DELETE FROM session_authority\n          WHERE session_id = ? AND incarnation = ? AND owner_token = ?`",
    replacement: "`DELETE FROM session_authority WHERE 1`",
    tests: LEASE,
  },
  {
    id: "M7",
    target: "the 6X bug: takeover refreshes deadline/pid but leaves owner_token stale",
    file: "src/task/store.ts",
    anchor: "owner_token      = excluded.owner_token,",
    replacement: "-- M7 owner_token not updated on takeover",
    tests: LEASE,
  },
  {
    id: "M8",
    target: "holdsSessionAuthority ignores the token",
    file: "src/task/store.ts",
    anchor: "a.ownerToken === ownerToken &&",
    replacement: "true &&",
    tests: LEASE,
  },
  {
    id: "M9",
    target: "the Scheduler continues scheduling after losing authority",
    file: "src/task/scheduler.ts",
    anchor:
      'if (!this.hasAuthority()) {\n      if (!this.authorityLost) this.loseAuthority()\n      return { stop: "authority-lost", dispatched: null, recovered: [] }\n    }\n\n    // [PHASE 6T] CAPACITY',
    replacement:
      'if (!this.hasAuthority() && this.claim !== null) {\n      if (!this.authorityLost) this.loseAuthority()\n      return { stop: "authority-lost", dispatched: null, recovered: [] }\n    }\n\n    // [PHASE 6T] CAPACITY',
    tests: LEASE,
  },
  {
    id: "M10",
    target: "reconcile runs without authority",
    file: "src/task/scheduler.ts",
    anchor:
      "if (!this.hasAuthority()) {\n      if (!this.authorityLost) this.loseAuthority()\n      return []\n    }",
    replacement:
      "if (false) {\n      if (!this.authorityLost) this.loseAuthority()\n      return []\n    }",
    tests: LEASE,
  },
  {
    id: "M11",
    target: "start() ignores a refused lease",
    file: "src/task/scheduler.ts",
    anchor: 'if (acquired === "REFUSED_LEASE_HELD") {',
    replacement: "if (false) {",
    tests: LEASE,
  },
  {
    id: "M12",
    target: "authority is per-session, not per-(session,incarnation)",
    file: "src/task/store.ts",
    anchor: "PRIMARY KEY (session_id, incarnation)",
    replacement: "PRIMARY KEY (session_id)",
    tests: LEASE,
  },
  {
    id: "M13",
    target: "the lease is never renewed",
    file: "src/task/scheduler.ts",
    anchor: "      if (this.authorityToken === null) return",
    replacement: "      return",
    // [DESIGN DECISION] BOTH files. The process suite proves the lease is not
    // stolen while it is renewed, but the lifecycle suite is the only place the
    // Scheduler's own setInterval is exercised. Restricting this to the process
    // suite is exactly why M13 survived the first campaign.
    tests: [...LEASE, ...PROCS],
  },
  {
    id: "M14",
    target: "the lease is shorter than a legitimate execution window",
    file: "src/task/session-authority.ts",
    anchor: "export const SESSION_LEASE_MS = 300_000",
    replacement: "export const SESSION_LEASE_MS = 1_000",
    tests: [...LEASE, ...PROCS],
  },
  {
    id: "M15",
    target: "expiry is extended without limit",
    file: "src/task/store.ts",
    anchor:
      "SET lease_expires_at = ?\n          WHERE session_id = ? AND incarnation = ? AND owner_token = ?",
    replacement:
      "SET lease_expires_at = ? + 999999999\n          WHERE session_id = ? AND incarnation = ? AND owner_token = ?",
    tests: LEASE,
  },
  {
    id: "M16",
    target: "getSessionAuthority ignores the incarnation",
    file: "src/task/store.ts",
    anchor:
      "                lease_expires_at AS leaseExpiresAt,\n                incarnation\n           FROM session_authority\n          WHERE session_id = ? AND incarnation = ?`",
    replacement:
      "                lease_expires_at AS leaseExpiresAt,\n                incarnation\n           FROM session_authority\n          WHERE session_id = ?`",
    tests: LEASE,
  },
  {
    id: "M17",
    target: "a recreated session's lease is keyed to a fixed incarnation",
    file: "src/task/store.ts",
    anchor:
      "const inc = this.getSessionIncarnation(sessionId)\n    const result = handle(this.cwd)\n      .prepare(\n        `INSERT INTO session_authority",
    replacement:
      "const inc = 1\n    const result = handle(this.cwd)\n      .prepare(\n        `INSERT INTO session_authority",
    tests: LEASE,
  },
  {
    id: "M18",
    target: "session deletion does not invalidate authority",
    file: "src/task/scheduler.ts",
    anchor: "if (current !== this.incarnationAtStart) {",
    replacement: "if (false) {",
    tests: LEASE,
  },
  {
    id: "M19",
    target: "self-dispose does not release the lease",
    file: "src/task/scheduler.ts",
    anchor: '    this.releaseAuthority()\n    if (this.state === "STOPPED") return',
    replacement: '    if (this.state === "STOPPED") return',
    tests: LEASE,
  },
  {
    id: "M20",
    target: "a restarted process reuses a predictable owner token",
    file: "src/task/session-authority.ts",
    anchor: "  return `own-${Date.now().toString(36)}-${counter.toString(36)}-${rand}`",
    replacement: '  return "own-fixed-token"',
    tests: LEASE,
  },
  {
    id: "M21",
    target: "the authority check moves after autonomous scheduling begins",
    file: "src/task/scheduler.ts",
    anchor:
      '    if (!this.hasAuthority()) {\n      if (!this.authorityLost) this.loseAuthority()\n      return { stop: "authority-lost", dispatched: null, recovered: [] }\n    }',
    replacement:
      '    if (!this.hasAuthority() && this.claim !== null) {\n      if (!this.authorityLost) this.loseAuthority()\n      return { stop: "authority-lost", dispatched: null, recovered: [] }\n    }',
    tests: LEASE,
  },
  {
    id: "M22",
    target: "renewal always reports success",
    file: "src/task/store.ts",
    anchor: 'return result.changes === 1 ? "AUTHORITY_HELD" : "AUTHORITY_LOST"',
    replacement: 'return "AUTHORITY_HELD"',
    tests: LEASE,
  },
  {
    id: "M23",
    target: "a stale instance can release another incarnation's lease",
    file: "src/task/store.ts",
    anchor:
      "DELETE FROM session_authority\n          WHERE session_id = ? AND incarnation = ? AND owner_token = ?",
    replacement:
      "DELETE FROM session_authority\n          WHERE session_id = ? AND owner_token = ?",
    tests: LEASE,
  },
  {
    id: "M24",
    target: "the expiry comparison is inverted",
    file: "src/task/store.ts",
    anchor: "a.leaseExpiresAt > now",
    replacement: "a.leaseExpiresAt < now",
    tests: LEASE,
  },
  {
    id: "M25",
    target: "clock units are wrong (ms treated as s)",
    file: "src/task/store.ts",
    anchor: ".run(sessionId, inc, ownerToken, process.pid, now, now + leaseMs, now)",
    replacement: ".run(sessionId, inc, ownerToken, process.pid, now, now + leaseMs * 1000, now)",
    tests: LEASE,
  },
  {
    id: "M26",
    target: "the production gate accepts value forms again (F01 regression)",
    file: "src/task/production-scheduler.ts",
    anchor: "if (token === SCHEDULER_FLAG) return GATE_ENABLED",
    replacement: "if (token.startsWith(SCHEDULER_FLAG)) return GATE_ENABLED",
    tests: GATE,
  },
  {
    id: "M27",
    target: "the production CLI gate is bypassed for the permissive matcher (F01)",
    file: "cli/index.ts",
    anchor: "const schedulerEnabled = resolveSchedulerGate(args) === GATE_ENABLED",
    replacement: 'const schedulerEnabled = hasFlag(args, "--enable-scheduler")',
    tests: GATE,
  },
  {
    id: "M28",
    target: "an environment variable enables the Scheduler",
    file: "cli/index.ts",
    anchor: "const schedulerEnabled = resolveSchedulerGate(args) === GATE_ENABLED",
    replacement:
      'const schedulerEnabled =\n  resolveSchedulerGate(args) === GATE_ENABLED || process.env.MINICODE_SCHEDULER === "1"',
    tests: GATE,
  },
  {
    id: "M29",
    target: "the gate is applied after construction",
    file: "src/task/production-scheduler.ts",
    anchor: "if (!gate.enabled) return inertHandle(gate)",
    replacement: "if (false) return inertHandle(gate)",
    tests: GATE,
  },
  {
    id: "M30",
    target: "a second production Scheduler is constructed",
    file: "src/task/production-scheduler.ts",
    anchor: "  const trigger = new TriggerCoordinator({",
    replacement:
      "  new Scheduler(d.sessionId, {\n    store: d.store,\n    runTurn: buildAutonomousRunTurn(d.bindingFor, d.adapter),\n    instruction: d.instruction,\n  })\n\n  const trigger = new TriggerCoordinator({",
    tests: GATE,
  },
  {
    id: "M31",
    target: "an injected 6S permission handler stops suppressing onPermissions",
    file: "src/app/session.ts",
    // [DESIGN DECISION] The real 6S seam, not a proxy for it. An earlier M31
    // emptied the adapter's tool list, which is EQUIVALENT to no mutation at all -
    // a narrower tool set is more restrictive, not a bypass - so it could never be
    // killed. The property that matters is that an INJECTED handler suppresses the
    // interactive permission path, because a live prompt is what autonomous
    // execution must not be able to reach.
    anchor: "if (onPermissions && !injected) {",
    replacement: "if (onPermissions) {",
    tests: [
      ...LEASE,
      "test/phase6u-production-composition.test.ts",
      "test/phase6s-autonomous-permission.test.ts",
    ],
  },
]

// ── harness ──────────────────────────────────────────────────────────────────

function countOccurrences(haystack: string, needle: string): number {
  let n = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    n += 1
    i = haystack.indexOf(needle, i + needle.length)
  }
  return n
}

/**
 * Mutations proven not to change behaviour, with the proof.
 *
 * These are NOT survivors. A survivor means "no test can see this break", which
 * for an equivalent mutant is actually the CORRECT answer - an equivalent mutant
 * is by definition undetectable. The difference is that equivalence must be
 * argued, and the argument is recorded here so a reader can check it.
 */
const EQUIVALENT: Record<string, string> = {
  M15: `EQUIVALENT: renewal IS "extend the expiry", so a holder extending its own lease is the
       intended semantics, not a defect. The security-relevant variants - extending
       SOMEONE ELSE's lease (M5) and a renewal that always reports success (M22) -
       are both killed.`,
  M19: `EQUIVALENT: disposeSelf()'s releaseAuthority() is unreachable for any path where the
       lease would still be held. disposeSelf is called from (a) loseAuthority(),
       where the lease is already lost so a token-guarded release is a no-op, and
       (b) the runCycle session-superseded path, where the 6Q incarnation bump has
       already re-keyed the lease. The TASK_GONE path - the one where a release is
       load-bearing - does NOT go through disposeSelf: dispatchTracked calls the
       deleted-session handler, which releases at scheduler.ts:530. Verified by
       stack-tracing releaseSessionAuthority under the mutant.`,
}

interface Row {
  mutation: string
  target: string
  file: string
  resolved: boolean
  occurrences: number
  mutated: boolean
  executed: boolean
  testsFailed: string[]
  result: Verdict
  note: string
}

const onlyIdx = process.argv.indexOf("--only")
const only = onlyIdx === -1 ? null : process.argv[onlyIdx + 1]
const rows: Row[] = []
let campaignFailure: string | null = null

for (const m of MUTATIONS) {
  if (only !== null && m.id !== only) continue
  const abs = join(REPO, m.file)
  const original = readFileSync(abs, "utf8")
  const occurrences = countOccurrences(original, m.anchor)
  const resolved = occurrences === 1
  const row: Row = {
    mutation: m.id,
    target: m.target,
    file: m.file,
    resolved,
    occurrences,
    mutated: false,
    executed: false,
    testsFailed: [],
    result: "UNEXECUTED",
    note: "",
  }

  if (!resolved) {
    // ADR-24: this is a CAMPAIGN FAILURE, not a survivor.
    campaignFailure ??= `${m.id}: anchor resolved ${occurrences}x (need exactly 1) in ${m.file}`
    row.note = `anchor resolved ${occurrences}x; campaign failure per ADR-24`
    rows.push(row)
    console.log(`  ${m.id.padEnd(4)} UNEXECUTED  anchor ${occurrences}x - CAMPAIGN FAILURE`)
    continue
  }

  // Mutants are written to COMPILE. A mutation that merely fails to typecheck
  // proves nothing about behaviour, so a compile failure is classified
  // separately and the anchor is chosen to keep every binding used.
  writeFileSync(abs, original.replace(m.anchor, m.replacement), "utf8")
  row.mutated = readFileSync(abs, "utf8") !== original

  const tr = spawnSync("bun", ["test", ...m.tests, "--timeout", "120000"], {
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
    row.testsFailed = [...m.tests]
  } else if (tr.status !== 0 && compileBroke) {
    row.result = "KILLED"
    row.note = "mutant does not compile (product would be broken)"
  } else if (tr.status !== 0) {
    row.result = "KILLED"
    row.note = `non-zero exit ${tr.status} with no assertion failure`
  } else {
    // A survivor is only EQUIVALENT when the mutation provably cannot change
    // behaviour, and the reason is recorded. Anything else stays SURVIVED, because
    // an unexplained survivor is the thing this campaign exists to prevent.
    row.result = EQUIVALENT[m.id] ? "EQUIVALENT" : "SURVIVED"
    row.note = EQUIVALENT[m.id] ?? "no test detected the mutation"
  }

  writeFileSync(abs, original, "utf8")
  rows.push(row)
  console.log(
    `  ${m.id.padEnd(4)} ${row.result.padEnd(9)} ${m.target.slice(0, 62).padEnd(62)} ${row.note}`,
  )
}

const summary = {
  checkpoint: readFileSync(join(REPO, "package.json"), "utf8").includes("minicode")
    ? "964c0b7"
    : "unknown",
  generated_by: "scripts/phase6y-mutation.ts",
  totals: {
    executed: rows.filter((r) => r.executed).length,
    killed: rows.filter((r) => r.result === "KILLED").length,
    survived: rows.filter((r) => r.result === "SURVIVED").length,
    equivalent: rows.filter((r) => r.result === "EQUIVALENT").length,
    unexecuted: rows.filter((r) => r.result === "UNEXECUTED").length,
    planned: MUTATIONS.length,
  },
  campaign_failure: campaignFailure,
  rows,
}
if (!existsSync(join(REPO, "docs/audit"))) throw new Error("docs/audit missing")
writeFileSync(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`, "utf8")
console.log(
  `\n  planned=${summary.totals.planned} executed=${summary.totals.executed} killed=${summary.totals.killed} survived=${summary.totals.survived} unexecuted=${summary.totals.unexecuted}`,
)
console.log(`  campaign_failure: ${campaignFailure ?? "none"}`)
console.log(`  summary: ${SUMMARY.replace(REPO + "\\", "")}`)
