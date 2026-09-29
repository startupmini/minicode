# ADR-11 — Trigger ownership

**Status:** PARTIALLY BLOCKED (coordinator decided; transport deliberately undecided)
**Phase:** 6T

## Problem
Something must decide *when* the Scheduler evaluates. Without an owner, "when" is
implicit in whatever code happens to call `cycle()` — and in this repository
nothing does.

## Evidence
- `FACT` No periodic timer exists. The only `setInterval` calls in `src/` paint a
  spinner (`src/ui/runtime/spinner.ts:74`) and a status line
  (`src/ui/assistant/turn-status.ts:174`).
- `FACT` `TaskStore` emits nothing. `createTask`/`patchTask`/`claimTask`/
  `recordAttemptReturned` have no callbacks; the only outward signal is a return
  value (`src/task/sync.ts:52`).
- `FACT` The kernel bus (`vendor/minicore/src/core/events.ts:5-14`) carries nine
  turn/step/provider event types and **no task-shaped event**.
- `FACT` Eight composition roots exist; none imports `src/task/scheduler.ts`.
- `FACT` `cli/index.ts:456-554` runs one turn and exits. MiniCode is not a
  continuously running server.

## Candidates
| option | verdict |
|---|---|
| startup hook | available, unused |
| task-mutation emitter | available, unused — best latency, zero idle cost |
| explicit CLI command | available, unused — most honest, but an enablement decision |
| interval | rejected: assumes a long-running server |
| internal event | rejected: no task events exist |
| hybrid startup+mutation | coherent, both unreachable today |

## Rejected options
- **Interval.** The one candidate that requires a lifecycle to own a timer, for a
  process that is usually about to exit.
- **A trigger queue.** N rapid task mutations would become N evaluations. A cycle
  re-reads the whole snapshot, so one coalesced re-run subsumes them.
- **Transport implemented now.** Every available transport is an enablement
  decision, and §26 of the mission forbids it.

## Decision
A trigger is a **decision, not a mechanism**.

`TriggerCoordinator` answers "may an evaluation start now, and who may ask?",
refuses before touching anything when the scheduler is not running, and coalesces
duplicate requests. `runCycle` is **injected**; the coordinator holds no store
reference and imports no Scheduler — the absence is what makes "a refused trigger
writes nothing" structural rather than a promise.

Scope is per session. `dispose()` refuses later triggers and deliberately does
**not** cancel in-flight work: that is the Scheduler's half.

Transport remains **DECISION BLOCKED**. The coordinator is complete; what pokes it
is an integration-phase choice.

## Consequences
- Trigger cost is 0.001 ms and flat in task count, so a task-mutation hook is
  affordable when one exists.
- A trigger cannot create durable state, by construction.
- Nothing in the tree can reach the Scheduler: the only importers of
  `src/task/trigger.ts` are tests.

## Migration impact
None. No production file imports it.

## Test requirements
- A refused trigger writes nothing (A1).
- Duplicate triggers never overlap, and N mid-cycle requests produce one re-run
  (A3, A4, I3).
- A throwing cycle does not wedge the trigger (A5).
- A throwing sink cannot break it (A7).

## Unresolved
Which transport. Deliberately not chosen.
