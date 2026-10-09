# PHASE 4 — AGENT LOOP
**Status: SCOPE RATIFIED — IMPLEMENTATION PLANNING NOT STARTED**

## Purpose

Phase 4 establishes the canonical contract, verifies the production behavior, and hardens the existing MiniCode Agent Loop across kernel turn orchestration and host run lifecycle management.

The objective is to ensure that model invocation, response interpretation, tool execution, result incorporation, loop continuation or termination, cancellation, bounded execution, error handling, and state persistence operate as one coherent and testable execution lifecycle.

## Authority hierarchy

- The outer Big Roadmap (Phase 1–12, referenced in `P2_CLOSURE_HANDOFF.md`) governs high-level phase scope; no single outer-roadmap file with a Phase 4 section exists in this repository, so this document is the canonical record of the ratified Phase 4 scope.
- `P3_ROADMAP.md` governs P3 sub-milestone scope and numbering (Phase 3 closed and frozen; not modified by this registration).
- `P3_PHASE_CLOSURE_REPORT.md` records Phase 3 closure evidence and Phase 4 handoff conditions (§12), which remain in force.
- Current source code and production tests establish implementation reality.
- Historical plans (e.g. agent-presentation and output phase numbering) provide context only and do not override this scope.

## Scope

Phase 4 will:

1. Define ownership boundaries between kernel `executeTurn` and host `runPromptWithVerify`.
2. Establish explicit, testable acceptance criteria for normal completion, tool-call continuation, provider failure and retry, cancellation, budget exhaustion, iteration limits, and persistence failure.
3. Verify that supported entry points use the intended session and execution lifecycle.
4. Strengthen production-path integration and regression tests for required behaviors.
5. Fix only defects demonstrated against the ratified contract.
6. Preserve existing session, canonical-history, context-selection, tool-execution, and task-management boundaries.

Existing functionality may satisfy a requirement without new implementation when direct source and test evidence proves that it does.

## Invariants

* Canonical history remains governed by the existing persistence and publication-safety contracts.
* Derived projections and runtime context metadata never become an alternative canonical authority.
* Context assembly and selection remain owned by their established components.
* Tool authorization, execution, error reporting, and side-effect safety retain their existing responsibility boundaries.
* Task lifecycle, dependency management, and scheduling remain owned by Task System, TaskGraph, and Scheduler.
* Cancellation, bounded execution, and failure outcomes must not be silently converted into successful completion.
* Any required retry must respect the existing recovery and side-effect safety contracts.

## Explicit non-goals

Phase 4 will not:

* Replace the existing Agent Loop merely to introduce a new architecture.
* Rebuild Session Architecture or the Phase 3 context pipeline.
* Reimplement Tool Execution, Task System, TaskGraph, or Scheduler.
* Expand into Phase 9 — Sub-Agent / Execution.
* Introduce another canonical-history writer, context store, or persistence authority.
* Activate the full-history fold as the production default.
* Absorb Presentation, Verification & Self-Healing, or Desktop / Long-running Runtime work.
* Introduce arbitrary new milestone numbering without separate approval.

## Acceptance criteria

Phase 4 can be declared complete when:

1. Its canonical responsibilities and component ownership are documented and unambiguous.
2. Each required lifecycle and failure behavior has an explicit acceptance criterion.
3. Required behaviors are verified through appropriate unit, integration, and production-path tests.
4. Relevant existing safety invariants remain intact.
5. Material failures discovered during verification are resolved or explicitly shown to be outside the ratified scope.
6. The implementation report records validation evidence, known limitations, and the final Git baseline.
7. No unrelated architecture redesign or unauthorized future-phase work is introduced.
