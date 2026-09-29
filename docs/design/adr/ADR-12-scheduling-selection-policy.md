# ADR-12 — Scheduling selection policy

**Status:** ACCEPTED
**Phase:** 6T

## Problem
Given an ordered list of ready tasks, which one runs now? The Scheduler read
`ready[0]` inline — correct, but unnamed, so there was no statement of what
selection guarantees and no function to point a property test at.

## Evidence
- `FACT` `graph.ts:63-67`: `compareNodes` sorts `order` ASC, then `id` ASC as a
  deterministic tiebreak; `readyTasks()` walks that order.
- `FACT` The Scheduler has always taken `ready[0]`, so `ORDER_ASC_THEN_ID_ASC` has
  been the policy since 6C.
- `OBSERVATION` Mutation M9/M10 initially **survived** because 6T created
  `scheduling-policy.ts` but left the Scheduler reading `ready[0]` — the two could
  not disagree, because the Scheduler did not use the policy. That realised the
  exact two-sources-of-truth risk the module documents.

## Candidates
Priority field; age (FIFO by creation); retry/attempt count; user-created vs
autonomous; dependency depth; explicit fairness queue.

## Rejected options
All six. `FACT` TaskGraph already defines readiness and its order is
deterministic. `INFERENCE` No evidence in the current model requires a second
ordering dimension, and each would need its own starvation analysis. `grep`/`glob`
are never ordered, so selection is a pure function of the snapshot.

## Decision
`ORDER_ASC_THEN_ID_ASC`, formalised as `SELECTION_POLICY` and applied by
`selectTask(ready, snapshot)`.

- `selectTask` receives an **already-ordered** ready list and applies ordering
  only. It never re-derives readiness.
- `SELECTION_POLICY` is a one-member union, so adding a policy is a type error.
- The Scheduler routes through `selectTask` so there is exactly one implementation.

## Consequences
- Deterministic and replayable: same snapshot ⇒ same choice (C6, I5).
- No priority, no fairness, no queue — and no hidden tiebreaker.
- Selection cannot substitute a task that was not ready (C8, C9).

## Migration impact
Behaviour unchanged. `ready[0]` became `selectTask(ready, snapshot).taskId`.

## Test requirements
- The policy is the graph's order (C1).
- Bridges, terminal, blocked and all-blocked sets are never selected (C3, C4, C5).
- A **non-ready task that sorts first** is not selected (C8) — the gap M9 exposed.
- When nothing is ready, no terminal task is substituted (C9) — the gap M10 exposed.
- Determinism across repeats and randomised seeds (C6, I5, 300 seeds).

## Unresolved
Whether a future verifier's requeueing forces an anti-starvation tiebreak. Recorded
in ADR-13; deliberately not pre-solved.