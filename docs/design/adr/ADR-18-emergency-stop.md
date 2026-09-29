# ADR-18 — Emergency stop

**Status:** ACCEPTED (design only; no mechanism added)
**Phase:** 6T

## Problem
How can autonomous scheduling be stopped without deleting tasks?

## Evidence
- `FACT` `Scheduler.stop()` already exists: cancels nothing (before 6T), prevents
  new dispatch, releases ownership, and is not restartable.
- `FACT` There is **no feature-flag mechanism**: no `features`/`flags` field in
  `MinicodeConfig` (`src/config.ts:71-76`), `CliSessionOptions`, or
  `SchedulerOptions`. All switches are ~20 ad-hoc `process.env.X === "1"` reads
  with no registry.
- `FACT` Session deletion destroys the task namespace, so it cannot serve.
- `FACT` The only escape hatch that always works is process termination.

## Candidates
process shutdown · session deletion · explicit stop command · configuration ·
feature flag.

## Rejected options
- **Session deletion** — destroys the tasks. The opposite of "without deleting
  tasks".
- **A feature flag** — none exists, and inventing one is enablement, which §26
  forbids. `INFERENCE` A flag read at construction also cannot stop a *running*
  turn without the polling loop that was rejected in ADR-14.
- **A new CLI command** — an enablement decision and a production wiring.

## Decision
Design only. Two answers, in preference order:

1. **`scheduler.stop()`** — cancels the live turn (6T), waits, releases ownership,
   refuses to restart, and **deletes nothing**. A claimed task stays `IN_PROGRESS`
   for a legitimate authority to move, because stopping is not a verdict.
2. **Process shutdown** — the blunt instrument, and the only one that works when
   the scheduler is unreachable for any other reason.

`DESIGN DECISION` — stop and cancel are deliberately distinct operations.
`stop()` is administrative (a subsystem is going away); `cancelActive()` is about
one execution. Conflating them would let a trigger-level cleanup reach into
execution — the layering the mission forbids.

## Consequences
- An operator can stop autonomous work without losing the task list.
- A task claimed at the moment of the stop remains `IN_PROGRESS` and recoverable
  by a later owner after a restart.
- No runtime switch exists yet, so an emergency between process starts is not
  expressible. Recorded, not solved.

## Migration impact
None.

## Test requirements
- `stop()` is idempotent, terminal, and non-restartable (G2, G4).
- After `stop()`, no trigger can cause execution (H2, I3, 300 seeds).
- `stop()` deletes nothing: the task rows survive (asserted via F2/G6 state).

## Unresolved
No runtime flag. If one is wanted it needs its own ADR and its own ADR-worthy
question: *when* is it read, given a construction-time read cannot stop a live turn?