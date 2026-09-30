# ADR-20 — Cross-process live execution authority

**Status:** ACCEPTED (design; not implemented)
**Phase:** 6W

## Problem
Two OS processes can both run a Scheduler for one session. Process B's
reconciliation then reclaims a task process A is actively executing, because the
durable row cannot distinguish LIVE from DEAD (6V FINDING-02, P1).

## Evidence
- `FACT` 6V reproduced it in real processes; 6W reproduced it deterministically
  via a rendezvous: B advanced `exec_generation` 1 -> 2 while A was provably
  mid-turn.
- `FACT` The durable row is byte-identical for H1 (live) and H2 (crash):
  `IN_PROGRESS / exec_generation N / attempt_generation NULL / execution_owner=scheduler`.
- `FACT` `session-ownership.ts:37-45` is process-local by design and says so.
- `FACT` 6B §8 rejected lease/heartbeat as "a second authority"; 6L D5′ locked it.

## Constraints
Must not redesign TaskGraph, TaskStore identity, the 6P ownership model, 6Q's
incarnation model, 6R context, 6S permission policy or 6T policy/lifecycle.
Single-host (`tasks.db` is a local file). No daemon, queue or cluster scheduler.
Never intentionally create two concurrent executions for one task.

## Options
A lease/heartbeat per task · B heartbeat · C DB lock/active-execution row per task ·
D OS/pid liveness · E separate execution registry · F cooperative token ·
G durable session-ownership record with lease expiry.

## Rejected options
- **A/B/C/E** — identical mechanism, different storage. Rejected because a false
  positive at TASK granularity means two concurrent executions: the exact defect
  being fixed.
- **D** — pid liveness is unsafe alone (pid reuse, no portable start-time in Bun,
  no `/proc` on Windows) and cannot be the authority. Retained only as a
  possible fast path.
- **F** — process-local by construction; it is the thing that cannot cross
  processes.

## Decision
**G: a durable `(session_id, incarnation)` ownership record with a lease,
acquired atomically at `Scheduler.start()`.**

The decisive insight is granularity, not mechanism. A false positive at session
granularity means "I decline to start" plus wasted work; at task granularity it
means corruption. And the second half of F02 needs no mechanism at all: once the
new owner re-claims, `exec_generation` advances and 6Q already refuses the
deposed authority's late write as `SUPERSEDED`.

## Consequences
- A second process cannot start a Scheduler for a session whose owner's lease is
  live. F02's precondition is removed.
- A crashed process's scheduler cannot restart until the lease expires — bounded
  and stated.
- The claim statement, lineage, reconciliation predicate and readiness are
  unchanged.
- A duplicate window across a lease expiry is PRESERVED, not eliminated.

## Migration impact
One durable record, one acquisition check, one renewal point, one release. No
status, identity or lineage change.

## Test requirements
- A live owner's lease blocks a second `start()` across processes.
- After expiry, a second process may take over and the deposed owner's late write
  is refused as `SUPERSEDED`.
- A recreated session (new incarnation) does not inherit the predecessor's lease.
- An object restart by the same live process is not mistaken for a takeover.

## Unresolved questions
Lease duration and renewal floor (U1); whether per-task authority becomes
necessary under a future multi-scheduler product (U2); whether pid may be a fast
path (U3); record placement in `task_meta` vs a table (U4).