# ADR-23 — Production-path evidence contract

**Status:** ACCEPTED
**Phase:** 6W

## Problem
6V produced four coverage gaps (FINDING-01/03/04/05) with one root cause: tests
asserted a helper rather than the function production actually calls. Each would
have survived a fully green suite.

## Evidence
| boundary | tested | production caller | result |
|---|---|---|---|
| CLI enablement | `resolveSchedulerGate` | `hasFlag` in `cli/index.ts` | FAIL (`=false` enables) |
| permission injection | handler *shape* | `if (onPermissions && !injected)` | untested; a one-word edit wins |
| claim exclusivity | `claimTask(..., {exclusive})` in isolation | the Scheduler's call site | untested; removing `exclusive: true` keeps green |
| gate inheritance | `resolveSchedulerGate` | `schedulerGateFor` | untested |
- `FACT` 6U introduced `schedulerGateFor` specifically to close this class, and
  the very next class appeared one level deeper.

## Constraints
Tests must stay fast. Not every helper needs a production-path test. A rule that
demands it everywhere will be ignored.

## Options
Prohibit helper-only tests for security gates · require one production-path test
per gate · property-test the seam · accept the gap and document it.

## Rejected options
- **Prohibit** — unenforceable in review; the boundary between "helper" and
  "production caller" is judgement.
- **Property-test the seam** — properties do not tell you *which* function is
  under test.

## Decision
**Every security or correctness gate must have at least one test that traverses
the exact production caller** — same function, module and call site the product
uses. Helpers may be tested additionally; they may not be tested *instead*.

For the seven audited boundaries, the current production-path coverage is listed
in `docs/design/PHASE-6W-CROSS-PROCESS-AUTHORITY.md` §14; four are gaps.

## Consequences
- A refactor that changes which function decides becomes a test failure rather
  than a silent assurance gap.
- Cost is bounded: one test per gate, mostly real-process.
- ADR-22's gate table is written in these terms on purpose.

## Migration impact
None. Rule plus four tests to add.

## Test requirements
One production-path test per gate, named for the caller it traverses. A gate with
only helper coverage is recorded as an EVIDENCE GAP, not as passing.

## Unresolved questions
Whether "exact production caller" should extend to callers two levels out (e.g.
`createCliSession` itself, which needs a live provider and is still untested).