# ADR-14 — Per-turn cancellation

**Status:** ACCEPTED
**Phase:** 6T

## Problem
6R gave the autonomous context its own `AbortController`, but nothing outside the
context could reach it. `SchedulerOptions.cancellation` was a read-only
`isCancelled()` probe that could refuse new work and could not stop anything.

## Evidence
- `FACT` `src/task/scheduler.ts:149-150` — "Optional cancellation the composition
  root owns. Scheduler never invents one."
- `FACT` `dispatch()` could only check a flag *after* the claim.
- `FACT` `AutonomousExecutionContext.cancel()` existed but was unreachable from a
  lifecycle that held only a Scheduler.

## Candidates
Expose the context · expose its `AbortController` · publish a handle ·
poll for session deletion · a registry.

## Rejected options
- **Expose the context** — hands a lifecycle the power to touch everything the
  context owns.
- **Expose the AbortController** — a live handle, so a late cancel could reach into
  a settled context.
- **Registry** — cross-cutting, and 6Q reached deletion through durable evidence
  specifically to avoid one.
- **Polling** — a loop the runtime otherwise does not have.

## Decision
`ExecutionHandle` is the **address** of the context's abort, not the controller
itself. It is created per dispatch and passed to `RunTurn` as an optional second
argument, so existing bridges keep compiling.

```
NEW → RUNNING → CANCEL REQUESTED → CANCELLED / RETURNED → CLEANUP
```

- **per-execution** — constructed per dispatch, never pooled.
- **unique** — monotonic counter.
- **disposable** — `dispose()` drops the callback, in a `finally` rather than in
  seven separate returns.
- **not shared** — held singly; replaced, not stacked (V1 is serial).
- **repeatable** — `cancel()` sets a flag and returns; **first reason wins**, so the
  recorded cause stays truthful.
- **a cancel before attach is remembered** and fires on `attach`. Dropping it
  because the handle was not wired up yet is a race with a silent winner.

`DESIGN DECISION` — cancelling is **not** releasing. The task stays `IN_PROGRESS`
with its generation; moving it belongs to a legitimate authority, never to the
thing that stopped the work.

## Consequences
- A lifecycle owner with no context reference can stop a turn.
- Cancellation latency p99 is 0.0019 ms.
- Handle allocation is 76 ns, so per-turn disposable handles are free.

## Migration impact
`RunTurn`'s second parameter is optional. No existing bridge breaks.

## Test requirements
- Cancel before attach fires on attach (E2, I4, 300 seeds, both orderings).
- Idempotent; first reason wins (E3).
- `dispose()` drops the callback; a late attach does not revive it (E4).
- Nothing to cancel ⇒ `cancelActive` returns false (E6, E11).
- Unique per execution (E1, E7); the handle never outlives its turn (E8).
- Cancelling one execution reaches neither another handle nor another session (E10).
- Reachable from outside while a turn runs (E9).

## Unresolved
Whether the composition root polls, or accepts an explicit notification, for
deletion. See ADR-15.