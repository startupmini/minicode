# ADR-16 — Scheduler lifecycle

**Status:** ACCEPTED
**Phase:** 6T

## Problem
The mission asks for `NEW → READY → RUNNING → STOP_REQUESTED → STOPPED`, and asks
whether the Scheduler can ever need a restart because of stale internal ownership.

## Evidence
- `FACT` `SchedulerState` already existed as `CREATED | RUNNING | IDLE | STOPPING |
  STOPPED`. No new state was needed; the mapping to the mission's names is exact.
- `OBSERVATION` **D3:** an idle Scheduler whose session was deleted kept its
  ownership token and refused every replacement — precisely the "restart by
  accident" failure the mission names.

## Candidates
Add new states · add a `READY` state · keep the existing five and close the hole ·
add a watchdog/lease.

## Rejected options
- **New states** — `IDLE` already means "running but nothing in flight", which is
  the mission's `READY`.
- **A lease or heartbeat** — explicitly rejected at
  `src/task/session-ownership.ts:30-32`; 6T does not reopen it.

## Decision
Keep the five states; fix the hole with the incarnation check (ADR-15).

| question | answer |
|---|---|
| can RUNNING restart? | yes, idempotent; `start()` returns early (G3) |
| can STOPPED restart? | **no**, and it **throws** rather than silently no-opping, so a dead subsystem cannot look alive (G2) |
| can two loops exist? | no — `inFlight` serialises cycles, `ownsSession` fails closed (G3, G5) |
| active execution on stop? | `stop()` cancels, **then** awaits the cycle (G4) |
| pending cycle on stop? | awaited to completion; never half-abandoned |
| after session deletion? | self-dispose, release ownership, replacement may start |
| accidental restart needed? | **no** — that was D3, now fixed |

`DESIGN DECISION` — `stop()` cancels **before** awaiting. The await is what makes
it graceful rather than crash-like: the abort gives the turn a chance to unwind so
the attempt can still be recorded. The durable outcome does not depend on it.

## Consequences
- `start()` on a STOPPED scheduler throws with reason `stopped`.
- Ownership is always released on a terminal path.
- A wiped session cannot be resurrected by a new instance.

## Migration impact
`incarnationAtStart` captured at `start()`, cleared on dispose. `stop()` gained
one cancel call.

## Test requirements
- STOPPED executes nothing (G1) — mutation M5.
- STOPPED cannot restart and says so (G2).
- Repeated `start()` creates no second loop (G3).
- `stop()` cancels then awaits (G4).
- Two schedulers cannot own one session (G5) — mutation M12.
- A deleted session releases ownership (G6).
- `incarnationAtStart` never wedges a replacement (F2, F3, P4).

## Unresolved
None.