# ADR-19 — Trigger scope / multi-session behavior

**Status:** ACCEPTED
**Phase:** 6T

## Problem
Per process, per session, or per task — and what must hold with multiple sessions,
multiple processes, and one task namespace.

## Evidence
- `FACT` `Scheduler` is constructed as `new Scheduler(sessionId, opts)`.
- `FACT` The task namespace is the session; every `TaskStore` method takes
  `sessionId` first.
- `FACT` `session-ownership.ts:39-50` is process-local, and its header says so:
  liveness is in memory only and invisible across processes (6L D5′).
- `FACT` 6Q's incarnation makes a session's tasks unusable after deletion, across
  processes, with no registry.

## Candidates
per process · per session · per task · hybrid.

## Rejected options
- **Per process** — would have to reason about *which* session it meant. A
  per-session trigger has exactly one namespace and no such question.
- **Per task** — not expressible, and not wanted: a task cannot ask to be run
  without something already knowing it exists.
- **A cross-process lock** — the durable atomic claim already does this job
  (ADR-13); a global lock would add a failure mode, not remove one.

## Decision
**PER SESSION**, inherited rather than chosen. No new coordination primitive.

| requirement | mechanism | evidence |
|---|---|---|
| no cross-session execution | per-session ownership; namespace is the session | H1, P1, P2 |
| no duplicate ownership | `acquireSessionOwnership` fails closed; atomic capacity predicate | G5, I2, M12 |
| no scheduler for a deleted session | incarnation check at every cycle | F2, P4 |
| no resurrection by recreation | a new lifetime is a new incarnation; the old instance self-disposed | F3, P6 |
| multiple processes | durable facts only — no registry, no lock | P2, P4, P6 |

## Consequences
- Two sessions in one process run independently and may hold separate claims.
- A recreated session id is a *new* session for the Scheduler, and the old
  instance can never touch it.
- Cross-process *liveness* remains 6L D5′ and is neither fixed nor regressed.

## Migration impact
None.

## Test requirements
- Two sessions dispatch independently (H1).
- Deletion stops a trigger loop even when the root does nothing (H3).
- A trigger for a stopped scheduler never runs a cycle (H2).
- Cross-process: two parallel processes (P2), deletion (P4), late trigger (P6).
- Mutation M12 (unscoped ownership) and M11 (no incarnation check) both killed.

## Unresolved
6L D5′: two OS processes on one session are not detected. Unchanged by 6T and
still an enablement blocker.