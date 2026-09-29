# ADR-17 — Shutdown behavior

**Status:** ACCEPTED (model chosen; signal wiring deferred)
**Phase:** 6T

## Problem
6N found `SIGTERM → process.exit()` with no graceful async lifecycle, and 6O
considered crash-like shutdown. With per-turn cancellation now existing, is that
still sufficient?

## Evidence
- `FACT` `cli/setup.ts:1507-1539` already performs a real async teardown
  (`killAllBackgroundJobs`, `mcpCloseAll`, `lspCloseAll`, stdin pause) and is
  called from `cli/index.ts:479,550,554`, `exec.ts`, and `tui.ts`.
- `FACT` **No signal handler calls it.** SIGTERM/SIGHUP `process.exit(143/129)`
  synchronously at `src/ui/tui/app.ts:333-334`, bypassing it entirely.
- `FACT` `src/mcp/server.ts:608-613` does abort-and-resolve on SIGINT/SIGTERM —
  one subsystem already does the right thing.

## Candidates
A crash-like exit · B signal but do not wait · C bounded graceful cancellation ·
D hybrid.

## Rejected options
- **A** — discards an existing async teardown, and means a live turn is *always*
  abandoned rather than usually.
- **B** — same waste: it has the signal and no way to use it.
- **Redesigning application-wide shutdown** — forbidden by §26.

## Decision
**Model D, bounded, minimal:**

```
stop accepting triggers → cancel active work → bounded wait → exit
                                                   ↓
                                    durable state remains recoverable
```

`TriggerCoordinator.dispose()` stops accepting requests (and deliberately does not
cancel execution — that is the Scheduler's half). `Scheduler.stop()` cancels the
live turn and awaits the cycle. The bound is the existing await plus a timeout the
integration phase supplies.

`DESIGN DECISION` — **cancellation is an optimisation, not a substitute for
recovery.** A cancelled turn that never returns is handled by 6Q's incarnation
check and later reconciliation, exactly as a crash is. Durable recovery is not
removed because cancellation exists.

`DESIGN DECISION` — the trigger layer may not cancel execution. `dispose()` and
`cancelActive()` are separate, so neither layer can overstep.

## Consequences
- A shutdown that reaches `stop()` records attempts instead of losing them.
- A shutdown that does not is no worse than today: crash-like.
- Shutdown can never start new work — the trigger refuses and the scheduler is
  `STOPPING`/`STOPPED`.

## Migration impact
None. `cli/` untouched.

## Test requirements
- `dispose()` refuses later triggers and leaves in-flight work alone (A6) —
  mutation M8.
- `stop()` cancels then awaits, and is idempotent (G4).
- After `stop()`, any trigger is inert (I3, 300 seeds; H2).

## Unresolved
The signal handler itself, and the timeout value. Integration phase.