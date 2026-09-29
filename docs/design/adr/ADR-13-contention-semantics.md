# ADR-13 — Contention semantics

**Status:** ACCEPTED
**Phase:** 6T

## Problem
When the runtime cannot take another execution, what happens to the task that was
about to run?

## Evidence
- `FACT` 6N F1 / 6O U5: `cycle()` claimed **before** dispatch, and a `runTurn`
  rejection was recorded as a completed attempt — a turn that never ran still
  consumed a generation.
- `FACT` 6O selected a capacity predicate inside the claim, reporting
  `CLAIM_REJECTED_BUSY`. `FACT` It was never implemented:
  `CLAIM_REJECTED_BUSY` existed only in that design document.
- `OBSERVATION` Probe of the committed tree: `generation 0 -> 1`, task left
  `IN_PROGRESS` and scheduler-owned, for an authority that does not exist to move it.

## Candidates
A skip this cycle · B retry later · C wait · D claim after capacity frees ·
E task remains ready untouched.

## Rejected options
- **B / retry-later** — a timer plus the lifecycle to own it; the runtime has no
  periodic timer, and it turns a policy decision into a background obligation.
- **C / wait** — an unbounded in-memory wait across a user turn of unknown length,
  needing its own timeout and cancellation.
- **D / claim after capacity frees** — spends a generation on work that will not
  run. This is the defect 6N reported.

## Decision
**`SKIP_CYCLE`**, rejection total: no claim, no generation, no owner, no attempt
lineage, no status write, no retry loop. `decideContention` returns
`mayClaim: false` and `reEvaluateLater: true`.

Enforced at **two** points, both required:
1. **pre-claim probe** — cheap; stops before reading a snapshot. A read, so
   raceable.
2. **atomic capacity predicate** — inside the claim's own `UPDATE`. The half that
   actually holds, including across processes.

`DESIGN DECISION` — "live" means the current generation's attempt has not ended:
`attempt_generation IS NULL OR attempt_generation < exec_generation`. My first
predicate used bare `IN_PROGRESS` and **wedged the Scheduler** (every completed task
stays `IN_PROGRESS` awaiting a verifier), which a probe caught. This is the same
condition reconciliation uses, so capacity and recovery read one fact.

`DESIGN DECISION` — the 6C property "a refused dispatch does not release the claim"
is preserved for the post-claim TOCTOU window (test 25c). The pre-claim case is now
strictly better: nothing is claimed at all.

## Consequences
- Contention is indistinguishable from "nothing happened".
- The exclusive predicate is opt-in, so every existing caller is unchanged.
- A crashed execution holds capacity until reconciled — correct, since unknown
  liveness is not free capacity.

## Migration impact
`claimTask` gained an optional 4th argument; default behaviour byte-identical.

## Test requirements
- Pre-claim contention spends no generation and moves no revision (B1, I1, 400 seeds).
- The atomic predicate refuses a second executor and reports the **unchanged**
  generation (B2, I2, 400 seeds).
- Contention is not cross-session (B3); non-exclusive claims unaffected (B4).
- No attempt lineage is created (B6).
- Two parallel OS processes never both claim (P2).

## Unresolved
None. A `RETRY_LATER` policy remains available if a transport is ever chosen.