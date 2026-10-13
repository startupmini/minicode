# ADR-25 — M7 mode-specific admission contracts

**Status:** ACCEPTED (owner-ratified)
**Phase:** P9.1.1
**Amends:** P1 ADR-003 (shared-spec mandate for M7 — superseded below; ADR-003
remains the historical origin of the module, not its current contract)

## Problem

P1 ADR-003 created `src/runtime/child-execution.ts` (M7) as SATU canonical
admission spec for **both** `delegate_task` (`src/tools/task.ts`) and
autonomous execution (`src/task/autonomous-*`). The P9.1 convergence attempt
proved the autonomous contract cannot be represented in M7 without changing
established behavior or fabricating authorization artifacts (an M7 mode, a
parent capability grant, an M1 correlation). Meanwhile the M7 source header,
`docs/ARCHITECTURE.html`, and test comments still assert the shared mandate —
a record conflict (review item A-01) that must be resolved before any Phase 9
execution work cites M7 as authority.

## Evidence

- `FACT` delegate fallback caps are `LIMITS.SUB_AGENT_BUDGET_EXPLORE/PLAN`
  (5/15); delegate explicit caps are `min(requested, DEFAULT_MAX_STEPS)` with
  **no** mode clamp — pinned by P9.1 B1/B2 through the real
  `delegateTaskTool.execute` production boundary.
- `FACT` M7 `modeStepCap` is `min(modeCap, DEFAULT_MAX_STEPS)` and M7 clamps
  explicit requests to the mode cap (request 40 explore → 5) — pinned by P9.1
  B5 and `test/child-execution.test.ts` ("M7 budget").
- `FACT` autonomous keeps `permissionMode: "readonly"` (fixed, never
  inherited), `maxSteps ?? 8`, `timeoutMs ?? 120_000`, the `auto~` derived
  identity, the atomic `store.claimTask`, and the per-execution
  six-sense permission handler — pinned by P9.1 B6/A2 and the 6R/6S suites.
- `FACT` the only production importer of `child-execution.ts` is
  `src/runtime/supervisor.ts`, for `planParentCancellation` (pure
  cancel-planning, not admission). No `cli/` importer, no barrel re-export
  (`src/runtime/`, `src/task/` contain no `index.ts`).
- `FACT` delegate timeout (`LIMITS.SUB_AGENT_TIMEOUT_MS` = 120_000) and the
  autonomous default (120_000) are numerically equal today but derive from
  **separate authorities** — changing one must not implicitly change the other.

## Candidates

A. Global convergence — both paths consume `admitChild` ·
B. Mode-specific contracts, reuse only equivalent rules ·
C. Delete M7.

## Rejected options

- **A — global convergence.** Requires either fabricating an M6 parent grant
  plus an M1 correlation for autonomous (invented authority), or changing the
  autonomous defaults / delegate explicit-cap semantics (observable behavior
  change). Both are prohibited without a separate owner-approved ADR. The P9.1
  attempt was stopped on exactly this rule.
- **C — delete M7.** The derivation rules anchor the delegate/M7 equivalence
  (B5), and `planParentCancellation` is the single cancel-planning helper the
  supervisor reuses. Deleting the module would scatter both again — the
  original ADR-003 problem.

## Decision

**Two admission contracts, intentionally distinct.** M7 is the pure
admission/derivation contract for the **delegate family**, plus the shared
pure cancel-planning helper (`planParentCancellation`). Autonomous execution
**does not consume M7** — not `admitChild`, not `modeStepCap`, neither
directly nor through a barrel — because its contract is not representable
there (mode-less, fixed readonly, default 8, no parent grant, no M1
correlation) without fabrication or behavior change.

| question | delegate | autonomous |
|---|---|---|
| admission authority | durable intent + child writer lease | atomic `TaskStore.claimTask` |
| M7 consumed? | fallback cap equivalent to `modeStepCap` (same constants); explicit branch deliberately stricter-free | **no** |
| step default | 5 explore / 15 plan (mode caps) | 8 (mode-less) |
| explicit request | `min(req, 50)`, no mode clamp | n/a (no requester-supplied cap) |
| timeout | `SUB_AGENT_TIMEOUT_MS` ceiling | `120_000` default (separate authority) |
| mode | explore / plan (+ forced-explore) | none — readonly fixed |
| child identity | `sub_`-prefixed canonical session | derived `auto~` session id |
| cancel planning | supervisor via M7 `planParentCancellation` | same helper (planning only, not admission) |

Shared invariants (reuse — proven equivalent, pinned by test): the
`SUB_AGENT_BUDGET_*` constants; M1 identity rules; M6 subset discipline;
attached-default with no silent outliving of the parent; writer-epoch/run
guards with `saveSession` as the sole canonical publisher; scheduler
dispatch-only (never writes COMPLETED); the R1 disposal integration gate.

Preserved differences (must NOT be unified without a new ADR): delegate
explicit-cap semantics; autonomous 8-step default; autonomous readonly
fixity; the two admission authorities; the two identity namespaces.

No authorization artifact may be fabricated to satisfy a common interface:
no invented M6 grant, no invented M1 correlation, no invented M7 mode.

## Consequences

- M7 source header, `docs/ARCHITECTURE.html` module line, and P9.1 comments
  now cite this ADR instead of the shared mandate.
- M16 G2 (M7 separate from kernel/backend/dispatch) is retained unchanged —
  the narrowed responsibility needs the same purity.
- P9.1 A2/E1 pin the autonomous↛M7 boundary at the import level (direct
  imports; no barrels exist to launder one through).
- The canonical-writer authority stays with `test/p2-architecture-guards.test.ts`
  (P2.3/P2.4 repo-wide single-writer guards on `src/session/persistence.ts`),
  not with the terminal-output inventory.

## Migration impact

Documentation, comments, and tests only. Zero executable behavior change:
production diff is comment-only; no caller, default, cap, timeout, identity,
or lifecycle transition is touched.

## Test requirements

- Delegate fallback/explicit caps through the production tool boundary
  (P9.1 B1–B4) and M7 derivation equivalence (B5).
- Autonomous readonly/defaults without M7 artifacts (B6) and without M7
  imports (A2).
- Independent admission authorities (A1/A2) and M7 purity (E1, M7 boundary
  test, M16 G2).
- Publication, ownership, lifecycle, and no-fabrication invariants
  (C1–C3, D1–D3, E2).
- Dormant backend with R1 as explicit gate (E3, R1 disposal suite).
- Guard self-check: the import/call scanners detect all supported
  import forms and ignore comments/strings (P9.1 self-check test).

## Unresolved

- **A-03 (recorded separately, not investigated here):** the child-session
  database-path pin in `src/tools/task.ts` (`resolveLocalDbPath` +
  fail-closed refusal when the pinned directory is missing) is pre-existing
  P2.9 logic covered by the delegate-audit plumbing tests. No reproducible
  evidence of a violated persistence or identity contract was presented in
  this batch. It is an **unverified pre-existing risk requiring its own
  investigation** — not a confirmed production defect — and must not expand
  this documentation/test-hardening scope.
- None other.
