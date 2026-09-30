# ADR-21 — Reconciliation liveness proof

**Status:** ACCEPTED (design; not implemented)
**Phase:** 6W

## Problem
Reconciliation decides whether an in-flight task is stranded. Its predicate is
"scheduler-owned and unfinished", which is also true of a LIVE execution.

## Evidence
- `FACT` `reconcile()` gates on `ownsSession`, which is process-local, so a
  second process passes it.
- `FACT` `attempt_generation IS NULL` is the "unfinished" test, and it is exactly
  what a live turn looks like.
- `FACT` 6W: the predicate cannot be repaired by reading existing columns.

## Constraints
Reconciliation must remain ownership-aware and fail-closed. No polling loop (6T
found the runtime has none). The 6Q/6O evidence-based lineage decision must not
be weakened.

## Options
Teach reconciliation about liveness (read a lease) · make liveness structural by
removing the second reconciler · add a heartbeat field per task.

## Rejected options
- **Per-task lease read inside reconciliation** — puts the ambiguity back at the
  worst granularity and adds a read to a hot path.
- **Heartbeat field** — write amplification for a fact already implied by
  session ownership.

## Decision
Make liveness **structural, not queried**:

```
recover ⟺ scheduler-owned ∧ unfinished ∧ NOT demonstrably live
```

With ADR-20, the third disjunct is false for every process that does not hold the
session lease, so reconciliation itself is unchanged. The proof source is the
session-ownership record consulted at `start()`.

## Consequences
- No per-task lease, no new column in `tasks`, no change to the lineage predicate.
- Reconciliation keeps a single meaning: "I own this session, and this attempt
  never recorded completion."
- A false positive is impossible from within a session; only a lease expiry can
  create a second authority, and its cost is wasted work.

## Migration impact
None in the store. Reconciliation logic unchanged; the gate in front of it moves.

## Test requirements
- The `IN_PROGRESS` + `attempt_generation NULL` row is untouched by a second
  process while the lease is live.
- After takeover, the deposed attempt is refused `SUPERSEDED`.
- Ownership refusal still holds: a non-owner reconciles nothing.

## Unresolved questions
Whether ADR-20 is sufficient, or a future topology needs per-task liveness.