# ADR-24 — Mutation anchor integrity

**Status:** ACCEPTED
**Phase:** 6W

## Problem
6V lost 7 of 20 mutants to anchor drift, so "survived" was indistinguishable
from "never ran". A campaign that cannot prove its mutants executed cannot prove
anything it killed.

## Evidence
- `FACT` 6V: `M4, M7, M10, M11, M17, M19, M20` reported SKIP. M20's replacement
  text was a no-op that still counted as a run.
- `FACT` Anchors were exact source snippets; `biome` reformatting moved them.
- `FACT` Two 6V survivors (M9, and partially M8) were mutants whose only effect
  was a global nothing reads — unobservable by construction, not weak tests.

## Constraints
Mutation must target production-composition semantics. Hatching must be
deterministic and replayable. Restore must never depend on `git` (6S F8 destroyed
a working tree that way).

## Options
Line numbers · exact snippets · normalised source · AST/symbol identity ·
compile-time location · marker comments.

## Rejected options
- **Line numbers** — move with any edit above the target.
- **Exact snippets** — the 6V failure mode.
- **Marker comments** — puts test scaffolding in production source.

## Decision
Anchors must be **semantic**, ranked:

1. **Export identity** — locate the symbol, mutate its body.
2. **Compile-time location** — find the emitted span, mutate that span.
3. **Normalised source** — strip comments, collapse whitespace; survives reformat,
   dies on rename.

Plus three reporting rules, which are the part that actually prevents a false
assurance:

- A mutant whose anchor is not found is **UNEXECUTED**, and the campaign
  **FAILS**. It is never folded into "survived".
- Every campaign reports `executed + killed + survived + unexecuted`; any
  `unexecuted > 0` fails the gate.
- A **no-op mutant** (replacement equals the original) is rejected at
  construction, before the run.

## Consequences
- "12/12 killed" becomes a statement about 12 *executed* mutants.
- Formatting can no longer silently change a campaign's meaning.
- A reformat forces an anchor update loudly instead of quietly.

## Migration impact
Harness only. The 6V campaign must be re-run under this rule before it is
trusted; U6 stays open until it is.

## Test requirements
- A no-op mutant is rejected.
- An unfound anchor fails the campaign rather than reporting survival.
- A campaign that survives a reformat with zero unexecuted still kills the same
  set.

## Unresolved questions
Whether Bun exposes a stable source-span API good enough for rank 2, or whether
rank 1 alone is realistic.