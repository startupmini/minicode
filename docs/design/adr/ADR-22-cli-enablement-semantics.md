# ADR-22 — CLI enablement semantics

**Status:** ACCEPTED (design; not implemented)
**Phase:** 6W

## Problem
`--enable-scheduler=false` enables the Scheduler (6V FINDING-01). Production reads
the gate with `hasFlag`, which matches `token.startsWith(name + "=")`; 6U tested
`resolveSchedulerGate`, which does not.

## Evidence
- `FACT` `cli/args.ts:70`.
- `FACT` Real process: `hasFlag=true, module=false, constructed=true`.
- `FACT` 6U documented and tested the opposite property, against the wrong function.
- `FACT` FINDING-03: the same seam (`schedulerGateFor`) can be made env-inheritable
  with no test failing.

## Constraints
Must not change `hasFlag` for other flags (its value-form tolerance is
load-bearing). Exactly one gate. Default OFF. Un-inheritable. Must not be
conflated with ADR-20.

## Options
Fix `hasFlag` · give the flag a value grammar · match the exact token in the gate
reader · retire one of the two resolvers.

## Rejected options
- **Fix `hasFlag`** — would alter every flag in the CLI.
- **Value grammar** (`=true` enables) — a boolean gate with two spellings and two
  ways to be wrong.

## Decision
The gate reader stops using `hasFlag` and matches the **exact token**:

| argv | behaviour |
|---|---|
| `--enable-scheduler` | ENABLE |
| `--enable-scheduler=<anything>` | DISABLE (no value form exists) |
| `--enable-schedulerx` / `--enable-sched` | DISABLE |
| anything after `--` | DISABLE |

And **one resolver survives**: the boolean seam production uses. The unused argv
resolver is retired, because a tested-but-unused gate is what let FINDING-01 and
FINDING-03 through.

## Consequences
- A user who typed `=false` no longer gets autonomous execution.
- The documented property is finally true in production.
- The seam is one function, and a test can traverse it.

## Migration impact
`cli/index.ts` one line; remove or fold `resolveSchedulerGate`; update the `--help`
text to say the flag takes no value.

## Test requirements
- A test through the **production caller** for every form in the table, in a real
  process — not a helper unit test.
- A guard that fails if any env var can enable it (6U A3 extended to the boolean
  seam).

## Unresolved questions
Whether the flag should be named as experimental in `--help` or hidden entirely
while 6V/6W findings are open.