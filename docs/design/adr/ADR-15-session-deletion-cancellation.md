# ADR-15 — Session deletion cancellation

**Status:** ACCEPTED (mechanism only; composition-root wiring deferred)
**Phase:** 6T

## Problem
6Q made a late write **safe** but did not stop live work: an autonomous turn kept
running after its session was deleted, and 6Q made the write harmless instead of
making the work stop.

## Evidence
- `FACT` 6Q's self-dispose fires on the **lineage-write** path — after a turn has
  already returned. It never fires while a turn is live.
- `OBSERVATION` **D3, pre-existing:** a session deleted under an **IDLE** scheduler
  produced `lifecycle=IDLE stop=no-candidates`, and a replacement
  `start()` was REFUSED with "already owned in this process". The idle instance
  never learned, so it wedged every replacement including a recreated session.
- `FACT` `session-ownership.ts` is process-local by design (6L D5′).

## Candidates
Registry of live schedulers · polling the incarnation during a turn · a
deletion-path callback · reuse the durable incarnation at cycle granularity.

## Rejected options
- **Registry** — cross-cutting; 6Q reached deletion through durable evidence
  precisely to avoid one, and it works across processes for free.
- **Poll during a turn** — a loop in a runtime that has no other one.

## Decision
Two independent halves, neither weakening the other.

**1. Live cancellation — mechanism, wiring deferred.** 6T supplies a reachable
handle (ADR-14). The composition root owns both the session lifecycle and the
Scheduler, so it is the thing that must call
`cancelActive("session-deleted")`. 6T defines the contract and proves the
mechanism; it does not wire it, because wiring means production reachability.

`INFERENCE` — and `disposeSelf()`'s own `cancelActive` is currently a **no-op**,
since it runs on the lineage path *after* the turn returned. Mutation M6 survived;
classification **EQUIVALENT**, pinned by test E11.

**2. Cycle-granularity detection — implemented.** `start()` records the session
incarnation; every cycle compares it. If it moved, the session was deleted or
superseded, and the instance self-disposes, cancelling any active turn and
releasing ownership.

`DESIGN DECISION` — this **strengthens 6Q**: same durable evidence, checked at
cycle granularity instead of only at lineage-write time. It works across
processes with no registry and no notification from the deletion path.

## Consequences
- A composition root that forgets to notify is still stopped (H3).
- A recreated session is never wedged by a dead predecessor (F2, F3, G6, P4, P6).
- Deletion stops work as early as the runtime permits; 6Q's incarnation check
  remains the final boundary.

## Migration impact
`claimTask` unchanged. Scheduler gained `incarnationAtStart` and a pre-cycle check.

## Test requirements
- A live turn is cancelled via the handle, and nothing is resurrected; the durable
  check still refuses the write (F1).
- An **idle** scheduler self-disposes and a replacement can start (F2).
- The old instance of a recreated session executes nothing (F3).
- A trigger loop goes inert **even if the root does nothing** (H3).
- Cross-process: deletion + idle scheduler (P4), recreation + late trigger (P6).
- Mutation M11 (remove the incarnation check) killed.

## Unresolved
The composition-root wiring itself. Integration phase.