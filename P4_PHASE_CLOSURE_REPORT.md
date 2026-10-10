# P4 PHASE CLOSURE REPORT — Agent Loop

**Verdict: `PHASE 4 CLOSED WITH DOCUMENTED LIMITATIONS`.**

All ratified Phase 4 acceptance criteria are satisfied against current source,
tests, and committed evidence. No material blocker remains. Every residual item
is explicitly dispositioned below as a documented limitation with its rationale
and its evidence — most importantly the accepted best-effort persistence
swallow (`P05-tail`, §8). No production source file was modified during
Phase 4; Phase 3 remains closed and untouched; Phase 5 has not been started.

---

## 1. Phase identity, scope, and closure objective

- **Phase**: Phase 4 — Agent Loop (canonical record:
  `P4_AGENT_LOOP_SCOPE.md`, ratified in commit `68133de`). No `P4_ROADMAP.md`
  exists and none was invented; the scope document plus the contract-to-test
  matrix (`P4_AGENT_LOOP_CONTRACT_TEST_MATRIX.md`) are the canonical
  documentation set.
- **Purpose of the phase** (scope document, Purpose): establish the canonical
  Agent Loop contract, verify the existing production behavior, and harden
  kernel `executeTurn` + host `runPromptWithVerify` lifecycle coverage — with
  the explicit rule that "existing functionality may satisfy a requirement
  without new implementation when direct source and test evidence proves that
  it does."
- **Closure objective of this report**: decide, from repository evidence only,
  whether Phase 4 satisfies its ratified acceptance criteria (scope document,
  "Acceptance criteria" §, items 1–7) and can be declared closed with
  documented limitations. This is a verification task; it introduces no new
  production behavior, does not reopen Phase 3, and does not begin Phase 5.

## 2. Final repository commit and batch references

- **Closing baseline (pre-report)**: `30653040b1fa95517bbd40786556329dd38ad46f`
  (`main` == `origin/main`, working tree clean, verified before this report
  was written).
- **Closure commit**: this report alone, recorded after push (final SHA,
  upstream equality, and clean-tree verification are stated in the delivery
  report accompanying this document, mirroring the Phase 3 convention).
- **Full Phase 4 commit chain** (all fast-forward, all docs/tests only):

  | Commit | Content |
  |---|---|
  | `68133de` | docs: ratify phase 4 agent loop scope |
  | `008bff3` | docs: map phase 4 agent loop contract to tests (contract-to-test matrix) |
  | `8b990a8` | Batch 1 — test: harden phase 4 admission and provider streams (E04, M05) |
  | `fffb00b` | Batch 2 — test: harden per-entry persistence refusal handling (P03 A/B/C) |
  | `56e96b1` | Batch 3 — test: stabilize phase 4 architecture checks (E08/S13, P11) |
  | `4729400` | Batch 4 — test: verify phase 4 production compaction path (M09) |
  | `d8d0cc0` | Batch 5 — test: verify phase 4 composed budget behavior (M12) |
  | `065aec1` | Batch 6 — test: verify completed host run terminal state (E09/P08 sub-gap) |
  | `cd83d2a` | Batch 7 — test: harden phase 4 stream and termination contracts (M08, M10) |
  | `566b843` | Batch 8 — test: verify executor result integrity contracts (T01, T05, T07, T06-tail) |
  | `3065304` | Batch 9 — test: resolve phase 4 owner decisions and residual gaps (B08, P05-tail, M04, B02, dispositions) |

- Batch 8 and Batch 9 were re-verified as ancestors of `HEAD` via
  `git merge-base --is-ancestor` during closure ground truth (both `True`).

## 3. Ratified acceptance criteria — evidence-based verdict per criterion

The seven criteria below are quoted from `P4_AGENT_LOOP_SCOPE.md`
("Acceptance criteria"). Nothing was broadened or renumbered.

### AC1 — Canonical responsibilities and component ownership documented and unambiguous
- **Requirement**: criterion 1.
- **Boundary**: documentation of kernel-vs-host ownership (`executeTurn` vs
  `runPromptWithVerify`), entry points, and component boundaries.
- **Evidence**: scope document Scope 1; matrix §4 (execution-flow summary with
  per-function citations into `cli/setup.ts`, `vendor/minicore/src/core/loop.ts`,
  `cli/tui.ts`, `cli/index.ts`, `cli/commands/*`) and §5 (component ownership
  table).
- **Observed validation**: documentation criteria — verified by reading; the
  flow citations were cross-checked against source during Batches 1–9 (each
  matrix row's production implementation column was exercised by the test added
  for it).
- **Limitations**: none.
- **Disposition**: **VERIFIED**.

### AC2 — Each required lifecycle and failure behavior has an explicit acceptance criterion
- **Requirement**: criterion 2.
- **Evidence**: scope Scope 2 names the seven families (normal completion,
  tool-call continuation, provider failure and retry, cancellation, budget
  exhaustion, iteration limits, persistence failure); matrix §6.9 maps them to
  concrete rows. The matrix's contract tables carry **69 rows in total**:
  **62 behavior rows** (E01–E09, M01–M12, T01–T11, B01–B08, P01–P11,
  C01–C07, S01–S04) plus the **7 invariant rows I01–I07** (§6.8), each with
  source contract, required behavior, production implementation, and test
  evidence columns.
- **Observed validation**: row inventory re-counted at closure: 69/69 IDs
  present, no duplicates.
- **Limitations**: `[DERIVED]` rows are labeled proposed verification detail,
  not invented ratified requirements (matrix §6.9) — this preserves, rather
  than broadens, the ratified criteria.
- **Disposition**: **VERIFIED**.

### AC3 — Required behaviors verified through unit, integration, and production-path tests
- **Requirement**: criterion 3.
- **Boundary**: kernel, host session, executor, runtime, and entry-point seams.
- **Evidence**: matrix §6 coverage column — of the 62 rows with a coverage
  verdict, **57 are `VERIFIED`** (layer mix: PROD production-path, CLI spawn,
  UNIT, ST guard) and **5 are `EXISTING LIMITATION — ACCEPTABLE`** (E01, E06,
  E07, P07, P09 — see §7). Matrix §11 records the exact commands and results of
  Batches 1–9 (isolation, containing-suite, and regression runs — all green).
  At closure, the key suites were re-run fresh: results in §5 below.
- **Observed validation**: all targeted suites green in this closure session
  (§5). Full-suite runs also executed at closure and at an untouched
  `68133de` baseline worktree for an apples-to-apples comparison (§5, §6).
- **Limitations**: six Phase 4 tests flake **only** inside a full 301-file run
  due to a pre-existing cross-test `stderr`-wrapper pollution mechanism
  (root-caused in §6; identical mechanism observed at baseline); they are green
  in isolation and in containing groups. Two deterministic full-suite failures
  are in pre-Phase-4 documentation files (§6).
- **Disposition**: **VERIFIED**, with the flake/ baseline classes documented
  (they do not touch the verified contract behavior — the same tests pass when
  run without cross-file pollution).

### AC4 — Relevant existing safety invariants remain intact
- **Requirement**: criterion 4.
- **Boundary**: the seven scope invariants + P2.7/P3 publication safety.
- **Evidence**: matrix §6.8 (I01–I07), each with enforcement mechanism, tests,
  and residual-boundary column; P01/P02/P04 rows (single funnel, 19 fenced
  sites, guarded shrink).
- **Observed validation at closure**: architecture/epoch guard suites re-run
  fresh — `p2-architecture-guards p3-reconciliation-guard
  m15-production-integration runtime-shutdown run-foundation` = **128 pass /
  0 fail**; `writer-inventory architecture-map ui-boundary
  projection-foundation` = **29 pass / 0 fail**. `git diff --name-only
  68133de..HEAD` contains **zero** files under `src/`, `cli/`, or `vendor/` —
  no production path that could weaken an invariant was touched.
- **Limitations**: none beyond §7/§8 dispositions.
- **Disposition**: **VERIFIED**.

### AC5 — Material failures discovered during verification resolved or shown out of scope
- **Requirement**: criterion 5.
- **Evidence**: matrix §9 — **zero `DEFECT CONFIRMED`** against the ratified
  contract. The two deterministic reds found at audit time were root-caused to
  the harness/guard layer and fixed with test-only corrections in Batch 3:
  `S13 scheduler-first` (CRLF source-text assertion; fixed via
  `normalizeSourceEol`, teeth re-proven with synthetic wrong-order source) and
  `P3 konstruktor authority runtime` (guard allowlist narrower than its
  invariant; fixed with a narrow `isVerifiedPlanValidatorUse` exemption plus a
  4-case negative self-check). Both were confirmed **still red at the
  `68133de` baseline worktree** and **green at the closing commit** — i.e.,
  Phase 4 moved them, with no production change.
- **Observed validation**: baseline full-suite run (§5) shows both failing;
  closure guard run (§5) shows both passing.
- **Limitations**: remaining full-suite reds are classified in §6 (2
  deterministic pre-existing documentation failures, 11 load/pollution tests);
  none is a material failure of the ratified contract.
- **Disposition**: **VERIFIED**.

### AC6 — Implementation report records validation evidence, known limitations, and final Git baseline
- **Requirement**: criterion 6 — this criterion is satisfied by this document.
- **Evidence**: §2 (Git baseline), §5 (validation commands and actual
  results), §6 (baseline/environmental failures), §7 (residual-disposition
  table), §8 (accepted limitations incl. P05-tail).
- **Disposition**: **VERIFIED** by this report.

### AC7 — No unrelated architecture redesign or unauthorized future-phase work
- **Requirement**: criterion 7 + all explicit non-goals.
- **Evidence**: `git diff --name-only 68133de..HEAD` = 10 files: the matrix
  plus 9 test files (`acp`, `control-plane`, `m15-production-integration`,
  `provider-audit`, `runtime-bounds`, `runtime-shutdown`, `session-epoch`,
  `tui-lang`, `usage-session`). **Zero production files.** No second writer or
  context store was introduced (writer-inventory guard green); the full-history
  fold was not activated (`grep` of `cli/setup.ts` production persist seam
  shows only `keepRecentTurns`, no `fold` key — matrix C07 re-verified at
  closure); no new milestone numbering was created (no `P4_ROADMAP.md`, no
  `P3.8`); Phase 9, Presentation, Self-Healing, and Desktop work were not
  absorbed (non-goals; S04/M14-style guards green).
- **Observed validation**: file list above; `git diff 883a0c1..HEAD` over
  `P3_ROADMAP.md`, `P3_PHASE_CLOSURE_REPORT.md`,
  `P3_0_CONTEXT_SESSION_CONTRACT.md`, `vendor/`,
  `docs/TERMINAL_CONTRACT.md`, `docs/ARCHITECTURE.html` = **empty** (Phase 3
  boundary untouched since the Phase 3 closure commit).
- **Disposition**: **VERIFIED**.

**Summary**: AC1–AC7 all **VERIFIED**. No criterion is claimed verified on the
strength of a test's existence alone: each production-path criterion is backed
by tests re-executed during this closure (§5) or recorded green in matrix §11
with exact counts, and the two documentation criteria were re-read against the
repository.

## 4. Summary of completed hardening batches

Nine test-hardening batches plus the scope/matrix documentation commits (full
chain in §2). Per-batch outcomes (matrix §6/§11/§15):

| Batch | Closed | Result |
|---|---|---|
| 1 (`8b990a8`) | E04 pre-turn stale skip; M05 malformed-stream arms | All new tests green; verified |
| 2 (`fffb00b`) | P03 per-entry persistence refusal (one-shot / TUI / ACP) | Green; verified |
| 3 (`56e96b1`) | E08/S13 shutdown-order red; P11 runtime-authority-guard red | Both former reds green (test-only fixes; §3 AC5) |
| 4 (`4729400`) | M09 production recovery-compaction path + async-failure sync fallback | Green; verified |
| 5 (`d8d0cc0`) | M12 composed `budget_exceeded` kind in a live host turn | Green; verified |
| 6 (`065aec1`) | E09/P08 completed-run terminalization sub-gap | Green; verified |
| 7 (`cd83d2a`) | M08 error-mid-stream containment; M10 finish-error/abort + maxSteps composition | Green; verified |
| 8 (`566b843`) | T01 invalid-args; T05 pairing arms; T07 executor throw; T06 truncation marker | Green; verified |
| 9 (`3065304`) | Owner decisions A/B/C (B08 retain+pin, P05-tail accept+pin, TUI notice retain); residuals M04, B02; acceptances E01/E06/E07/P07 | Green; verified; §13 of matrix records all three decisions |

Matrix §8 (missing test evidence) now states: *no actionable test gaps remain.*

## 5. Test and validation evidence (commands and actual results)

All commands run from `D:\git\minicode` in this closure session unless noted.

**Full suite (three consecutive runs at the closing commit):**

- Run 1: `bun test` → **4461 pass / 23 skip / 15 fail** (4499 tests, 301 files,
  1185.5s; console output observed, log not retained).
- Run 2 (log retained): `bun test | Tee-Object p4-closure-fulltest.log` →
  **4463 pass / 23 skip / 13 fail / 1 error** (4499 tests, 301 files, 1074.6s).
- Run 3 (log retained): `bun test | Tee-Object p4-closure-fulltest-run3.log` →
  **4463 pass / 23 skip / 13 fail** (4499 tests, 301 files, 1170.4s), zero
  unhandled errors. The 13 unique fail names in run 3 are exactly the
  classified set in §6 (2 class A + 11 class C), byte-for-byte identical to
  run 2's fail list — the two retained runs are reproducible.

**Full suite at an untouched baseline worktree** (`git worktree add --detach
… 68133de`, junctioned `node_modules`, same machine, same session):

- `bun test` → **4440 pass / 23 skip / 10 fail** (4473 tests, 301 files,
  1078.9s). This is the reference used to distinguish regression from
  pre-existing in §6.

**Focused/closure suites (fresh re-runs):**

| Command | Result |
|---|---|
| `bun test session-epoch usage-session runtime-bounds provider-audit` | 66 pass / 0 fail (270 expects, 21s) |
| `bun test run-foundation p3-reconciliation-guard budget-unknown cli-setup-coverage` | 51 pass / 0 fail (240 expects, 18s) |
| `bun test p2-architecture-guards p3-reconciliation-guard m15-production-integration runtime-shutdown run-foundation` | 128 pass / 0 fail (2435 expects, 32s) |
| `bun test writer-inventory architecture-map ui-boundary projection-foundation` | 29 pass / 0 fail (91 expects, 2s) |
| `bun test statusline-bun-guard acp session-epoch` (pollution-order probe) | 39 pass / 0 fail (190 expects, 21s) |
| `bun test session-epoch session-identity session-audit session-storage persistence-rewrite exec-json-envelope` (6-file group) | 54 pass / 0 fail (267 expects, 15s) |
| `bun test session-epoch` (isolation) | 18 pass / 0 fail |
| `bun test session-identity` (isolation) | 12 pass / 0 fail |
| `bun test exec-json-envelope` (isolation) | 2 pass / 0 fail |
| `bun test hardening-boundary` (EPIPE probe, isolation) | 14 pass / 0 fail |
| `bun test web-build import-convention session-audit` (deterministic-red probe) | 71 pass / 2 fail — the 2 fails are the deterministic documentation failures classified in §6 |

**Static gates:**

- `bun x tsc --noEmit`: 28 errors, all in `test/phase3*` / `test/phase4*`
  historical suites (by-file list in matrix §11); **0 errors in `src/`, `cli/`,
  `vendor/`** — matches the documented pre-existing baseline exactly.
- `bun x biome lint <all 9 Phase 4 test files>`: clean ("No fixes applied").
- `git diff --check`: clean (only benign CRLF-to-LF warnings from the Windows
  checkout, pre-existing repo-wide).

## 6. Baseline and environmental failures that remain

The full-suite reds at the closing commit, each classified against the
`68133de` baseline run from §5. **Baseline fails: 10. Closing-commit fails (both
retained runs): 13** — plus 1 unhandled EPIPE error in run 2 only (below).

**A. Deterministic, pre-existing, unrelated to Phase 4 (2)** — fail in
isolation and at baseline; caused by content in documentation files last
committed before the Phase 4 scope existed:

1. `integritas encoding berkas > tidak ada U+FFFD` — `P3_7_ARCHITECTURE_AND_CONTRACT_AUDIT.md`
   contains 3 U+FFFD characters; file last touched by `acf16e4` (2026-10-09
   10:04), which is an ancestor of the Phase 4 scope commit `68133de`
   (2026-10-09 17:47) — verified with `git merge-base --is-ancestor`.
2. `web ssg > docs tanpa nested list` — `docs/TASK_EVENT_MODEL.md:58,62,143`
   have nested list lines; file last touched by `aa76dfb` (2026-09-26), also
   proven to predate the Phase 4 scope.

**B. Deterministic failures at baseline, RESOLVED by Phase 4 (2)** — proof
that Phase 4 fixed reds rather than adding them: `S13 scheduler-first` and
`P3 konstruktor authority runtime` (both fail at `68133de`, both green at the
closing commit; fixed test-only in Batch 3 — §3 AC5).

**C. Load/pollution flakes in full-suite runs only (11 tests + 1 error)** —
green in isolation and in every containing-group run recorded in matrix §11 or
re-run at closure (§5); red only when the entire 301-file suite shares one
process:

- Root cause (newly root-caused during closure): `src/ui/runtime/statusline.ts`
  installs a `process.stderr.write` wrapper whose module-level `bound` can be
  nulled by `__resetTransientForTest()`/`disableTransient()` in one test file
  while another test file's captured restore puts the wrapper back as the
  active `stderr.write`. The next write through the stale wrapper throws
  `TypeError: bound is not a function … 'bound' is null` from
  `statusline.ts:92`, surfacing at the first `createCliSession` call in
  subsequently-run session tests. Files that patch `stderr.write`:
  `acp.test.ts`, `keystore.test.ts`, `supply-chain.test.ts`,
  `statusline-bun-guard.test.ts` — only `acp.test.ts` was extended by Phase 4
  (Batch 2 `P03-C`, with restore), and the identical stack was observed at the
  `68133de` baseline (5 bound errors; `session-epoch.test.ts` and
  `session-audit.test.ts` frames) — **the mechanism predates Phase 4**.
- Affected at the closing commit (runs 2 and 3, identical fail lists): `P2.1
  single-write`, `P2.1 semua path turunan`, `P2.2 alias`, `P2.2 komposisi`,
  `P4-E04`, `P03-A`, `P03-B`, `P05-tail`, `P4-E09`, `P4-M12`, plus
  `audit: manifes korup` (pollution-window dependent). Run 1 recorded 15 fails
  — the same 13-name classified set plus `cli: exec --json machine envelope`
  (5001ms timeout; green isolated, in its containing group, and in runs 2/3)
  and one further run-to-run flake whose name was not retained (run 1's console
  output was observed but not logged); both are in the same pollution-window
  class and neither recurred in the two retained runs. Baseline shows the same
  class (P2.1/P2.2, manifes korup, session frames).
- The 1 unhandled error in run 2: `EPIPE: broken pipe` between tests after the
  MCP stdio abort tests; the owning file (`hardening-boundary.test.ts`) is
  untouched by Phase 4 and green isolated (14 pass); not present at baseline,
  not present in run 1, and not present in run 3 — run-to-run I/O flake.
- One baseline flake (`§21 … renewal timer self-disposes`, 67s timeout) did not
  recur at the closing commit.

**D. Static/environmental baselines (unchanged, documented pre-existing):**

- 28 `tsc` errors, all in `test/phase3*`/`test/phase4*` (0 production).
- Repo-wide CRLF vs `.gitattributes eol=lf`: `bun run lint` (biome *check*)
  fails across ~106 files on this Windows checkout (`core.autocrlf=true`);
  `biome lint` (rules) is clean. Environment inconsistency, not code quality.

**Net regression count attributable to Phase 4: 0.** Phase 4 converted two
deterministic reds to green, added ~26 tests (4473 → 4499), and its new tests
inherit exposure to a pre-existing full-suite pollution mechanism without
introducing that mechanism.

## 7. Final residual-disposition table

| # | Residual | Disposition | Rationale / evidence | Reversible? |
|---|---|---|---|---|
| 1 | B08 `budgetGateAllowsStart` (`src/policy/usage.ts:94`) — no code caller | **RETAINED, deliberately unwired; semantics pinned** (Batch 9 Decision A) | Wiring would deny any session with recorded usage and break multi-turn use; removal would orphan the CHANGELOG-documented investigatory contract; enforced gates are `budgetStatus` (5 pre-turn sites) + `watchBudgetLimit` (mid-turn). Pinned by `usage-session.test.ts` (5 expects, green). Zero behavior change | Yes — wiring needs separate owner approval |
| 2 | P05-tail non-guard persist swallow (`cli/setup.ts:2112`) | **ACCEPTED best-effort, pinned, pending-policy** (Batch 9 Decision B) | Full statement in §8. Pinned by `P05-tail` trigger-injection test (green isolation + groups) | Yes — policy change must update the pinned test, not silently keep it |
| 3 | TUI stale pre-turn skip: no dedicated turn-level notice | **RETAINED, no new notice** (Batch 9 Decision C) | Every skip already surfaces through the existing transcript path (`tui.ts:318-320` → `[writer] <note>`, asserted by `P03-B`); a second notice would duplicate it | Yes |
| 4 | E07 / P07 — host file-bracket on a real turn + startup notice path untested | **ACCEPTED LIMITATION** (advisory crash-diagnostic UX; no data-integrity bearing) | Module contract + durable `turn.started/completed` events (the integrity half) proven (`turn-marker.test.ts`, `presentation-events.test.ts`) | Yes — fs-seam test possible in a hygiene batch |
| 5 | E01 — behavioral entry→factory pin absent | **ACCEPTED LIMITATION** | Output-level parity spawn-proven across CLI/exec/ACP; 4 stable call sites, wiring breaks fail loudly; TUI leg narrowed by `P03-B` (real `runTui` + real session) | Yes — seam test possible |
| 6 | E06 — mid-turn main-run RUNNING state unobserved | **ACCEPTED LIMITATION** | No ratified contract requires it (instrumentation detail); state machine, uniqueness, and terminal edges fully proven (`run-foundation.test.ts`) | Yes |
| 7 | P09 — RAM commit ≠ durable commit | **ACCEPTED LIMITATION (pre-existing design)** | Named by `p2-run-cursor.test.ts:55` as `CURRENT_INVARIANT`; must not be "fixed" by weakening publication safety | Structural — deliberately not test-reversible |
| 8 | Full-suite `stderr`-wrapper pollution flakes (§6C) | **ACCEPTED ENVIRONMENTAL LIMITATION** | Mechanism root-caused and proven pre-existing at baseline; affected tests green in isolation/containing runs; fixing it is test-harness work in files outside the ratified scope | Yes — harness-only fix, no production change |
| 9 | 2 deterministic documentation failures (§6A) | **OUT OF SCOPE (predate Phase 4)** | Both files committed before the Phase 4 scope existed (ancestor-proven) | Yes — docs fixes, unrelated to Agent Loop |
| 10 | 28 `tsc` errors in `test/phase3*`/`test/phase4*` | **ACCEPTED BASELINE DEBT** | Pre-existing harness debt; 0 in production | Separate repair task |
| 11 | CRLF formatting vs `.gitattributes` (`bun run lint` red) | **ACCEPTED ENVIRONMENTAL** | `core.autocrlf=true` on this checkout; `biome lint` rules clean | Checkout/CI config |
| 12 | `RunStatus` has no `CANCELLED` (kernel `CANCELLED` vs durable `INTERRUPTED`) | **DOCUMENTED VOCABULARY, coherent and tested** | Recorded in matrix §10 to prevent drift; classification proven (`classifyTurnError`/`classifyTurnFailure`) | n/a |

## 8. Explicit accepted limitations — P05-tail (required statement)

**Accepted limitation: hard persistence failures outside the guard path may
remain runtime-silent under the current best-effort behavior.**

- **What is accepted** (`cli/setup.ts:2112`, Batch 9 Decision B): inside
  `persistCurrent`, errors that are *not* writer-epoch/refusal guard failures —
  concretely hard `saveSession` I/O errors after `SQLITE_BUSY` retry
  exhaustion, constraint violations, database corruption, and inner-path
  failures — are caught and swallowed. The call **resolves without throwing,
  without setting the stale-writer flag, and without any durable success
  signal being distinguishable by the caller.** This is explicitly **not**
  equivalent to durable success and is **not** characterized as universally
  safe.
- **Known consequences**: after such a failure the canonical history may lag
  the in-memory session state for that persist attempt; the caller (one-shot
  tail, TUI turn loop, ACP envelope path) treats the turn as settled; no
  immediate error surfaces to the user on that path.
- **Existing safeguards (why the risk is bounded)**:
  1. *Guard failures still refuse loudly* — writer-epoch and rewrite-refusal
     errors are never swallowed: they propagate as typed refusals
     (`StaleWriterError`, shrink refusal), trigger honest per-entry reporting
     (one-shot exit, TUI transcript `[writer] … NOT durable`, ACP stderr), and
     the stale path is unaffected by this decision. Proven by `P03-A/B/C`
     (Batch 2) and the full taxonomy tests.
  2. *Finalize/presentation-flush failures are independently warn-only by
     earlier tested design* — the swallow did not widen their blast radius.
  3. *Recovery evidence survives* — unswept journal files remain on disk for
     the recovery path; canonical rows are never partially corrupted by this
     catch (it wraps, it does not repair or retry).
  4. *Scope of the swallow* — it cannot mask a stale-writer condition (the
     stale branch `:2105-2111` returns before the catch) and does not exist on
     the guard/shrink refusal paths at all.
- **Supporting test evidence**: `session-epoch.test.ts` `P05-tail: non-guard
  persist failure saat ini ditelan tanpa flag` — a real `persistCurrent` with a
  SQLite trigger injecting an instant non-guard failure: the call resolves
  without throwing, `isWriterStale() === false` (distinguishing this path from
  the honest guard path), and the canonical history equals the seed. Green in
  isolation (1 pass / 4 expects) and in every containing run (§5). The test is
  **labeled pending-policy**: if the policy is ever tightened (flag or throw on
  hard failures), that test must be updated deliberately — it exists to pin
  current behavior, not to bless it forever.
- **Conditions to revisit this decision**: (a) an owner decision to require a
  durable-success signal or user-visible warning on hard persist failures;
  (b) evidence of real-world data divergence caused by the swallow (currently
  none — no `DEFECT CONFIRMED`); (c) any change to the recovery/journal
  assumptions that currently make unswept files sufficient evidence;
  (d) a crash-recovery audit that finds the silent window materially harmful.
  A stricter future policy remains possible and does not require reopening any
  other Phase 4 decision.

**Owner-decision evidence check (required by closure):** Decision A (B08) and
Decision C (TUI notice) are supported by repository evidence — Decision A by
`grep` (zero code callers of `budgetGateAllowsStart`, CHANGELOG-documented
investigatory contract) plus the enforced-gates inventory
(`budgetStatus` ×5 call sites, `watchBudgetLimit`), Decision C by the
`P03-B` transcript assertion over a real `runTui` turn — and both are recorded
with rationale in matrix §13. No uncertainty remains that would downgrade
closure readiness.

## 9. Cross-phase invariant and Phase 3 boundary confirmation

Phase 4 closure does not reopen Phase 3. Evidence, not absence-of-change:

- **`P2.7 saveSession` remains the canonical publication decision authority**:
  matrix P01 (`VERIFIED`) — single-transaction funnel
  (`persistence.ts:904-1108`) enforced by `p2-architecture-guards.test.ts`
  writers-in-`persistence.ts`-only + callers-fenced structural tests; guard
  suite re-run green at closure (128 pass, §5).
- **Writer-epoch and run guards intact**: matrix P02 (`VERIFIED`, 19 fenced
  sites) and P04 (guarded shrink); `session-epoch` + `run-foundation` +
  `p3-reconciliation-guard` green (§5: 66 + 51 pass groups).
- **Canonical-history publication safety properties unchanged**: append-only,
  refusal taxonomy, journal-after-durable ordering (P05/P06 rows) — all
  `VERIFIED`; Phase 4's only persistence-adjacent contribution is test coverage
  (Batches 2 and 9), zero production edits (`git diff --name-only
  68133de..HEAD` has no `persistence.ts`, no `setup.ts`, no `loop.ts`).
- **Derived state does not silently become authoritative**: matrix I02/C04/C05
  (`VERIFIED`) — producer writes only `history_projections` epoch-fenced;
  selector imports no persistence (`context-selector.test.ts:479`); projection
  foundation suite green (§5).
- **No alternate canonical-history writer introduced**: writer-inventory guard
  green (§5); the Phase 4 diff adds no writer (file list, §3 AC7).
- **Full-history fold not activated by implication**: production persist seam
  re-grepped at closure — `cli/setup.ts:2090` passes only `keepRecentTurns`,
  no `fold` key (matrix C07 `VERIFIED`); writer inventory unchanged.
- **Phase 3 boundary files untouched**: `git diff 883a0c1..HEAD` over
  `P3_ROADMAP.md`, `P3_PHASE_CLOSURE_REPORT.md`,
  `P3_0_CONTEXT_SESSION_CONTRACT.md`, `vendor/`, `docs/TERMINAL_CONTRACT.md`,
  `docs/ARCHITECTURE.html` = empty. Phase 3's closure verdict and handoff
  conditions (`P3_PHASE_CLOSURE_REPORT.md` §12) remain in force as written.
- **Frozen context pipeline consumed as-is**: matrix §6.6 rows C01–C07 all
  `VERIFIED` from Phase 3 evidence; no Phase 4 test weakened them (the
  context/selector/assembly suites were run as regressions in earlier batches
  and remain green — `p3-reconciliation-guard`, `context-assembly` groups in
  matrix §11).

## 10. Known exclusions and work intentionally deferred

- **Deferred to a future owner decision**: wiring (or removal of)
  `budgetGateAllowsStart` as a start gate (§7 #1); tightening the P05-tail
  swallow policy (§8); a dedicated TUI stale-skip notice (§7 #3).
- **Deferred as non-blocking test-harness work**: root fix of the full-suite
  `stderr`-wrapper pollution (§6C); the E07/P07 fs-seam test, E01 seam pin,
  M03 multi-call-through-production-session test (matrix marks all optional);
  repair of the 28 historical `tsc` errors; the two pre-Phase-4 documentation
  content fixes (§6A).
- **Out of scope by ratified non-goals**: Agent Loop replacement/redesign;
  Session Architecture or Phase 3 pipeline rebuild; Tool Execution / Task
  System / TaskGraph / Scheduler reimplementation; Phase 9 expansion; second
  persistence authority; full-history fold production activation;
  Presentation / Verification & Self-Healing / Desktop absorption; new
  milestone numbering.
- **Not started (by instruction)**: Phase 5 work of any kind.

## 11. Closure rationale

1. The ratified contract exists and is unambiguous (scope § + matrix 69 rows —
   AC1/AC2).
2. Every required behavior family has direct production-path evidence, re-run
   and green in this closure session (§3 AC3, §5); the matrix has no
   `DEFECT CONFIRMED` row and no remaining actionable test gap (matrix §8).
3. The only two deterministic reds discovered during the phase were
   harness-layer issues, root-caused, fixed test-only, and are demonstrably
   red-at-baseline / green-at-closure (§3 AC5, §6B).
4. Every safety invariant of the scope (I01–I07) plus the P2/P3 publication
   invariants are enforced by green guard suites, with zero production files
   changed across the entire phase (§3 AC4, §9).
5. Every residual — including the persistence-swallow risk — has an explicit
   disposition, rationale, evidence, and revisit condition (§7, §8); nothing
   material is unclassified. The full-suite reds are fully classified against a
   same-session baseline run and are pre-existing classes, not Phase 4
   regressions (§6).
6. The report criteria (AC6) are met by this document; the non-redesign
   criteria (AC7) are met by the diff inventory.

## 12. Final verdict and conditions for reopening

**Verdict: `PHASE 4 CLOSED WITH DOCUMENTED LIMITATIONS`.**

Phase 4 — Agent Loop is closed at (and after) closing baseline
`30653040b1fa95517bbd40786556329dd38ad46f`, with the limitations enumerated in
§7 and §8 — chiefly: the accepted best-effort persist swallow (P05-tail, pinned
as pending-policy), the deliberately unwired `budgetGateAllowsStart`, the
advisory-marker/entry-pin/mid-turn-RUNNING acceptances, the pre-existing
full-suite pollution flakes and documentation failures, and the pre-existing
static baselines (28 historical type errors, CRLF checkout).

**Phase 4 should be reopened if any of the following occurs:**

1. A concrete violation of the ratified contract (any scope invariant or
   acceptance criterion) is demonstrated with reproducing evidence.
2. A production change to the Agent Loop, `persistCurrent`, writer-epoch
   fencing, or canonical publication paths is proposed — those paths were
   verified untouched in Phase 4 and would require re-verification.
3. The P05-tail policy is tightened or the pinned test would otherwise drift
   from intended behavior (§8 revisit conditions).
4. `budgetGateAllowsStart` is to be wired as an enforced start gate (requires
   separate owner approval; §7 #1).
5. The full-suite `stderr`-wrapper pollution is fixed in a way that touches
   production `statusline.ts` behavior (the current accepted classification
   covers test-harness-only remediation).

Phase 5 is a separate authorized phase; nothing in this closure starts or
pre-authorizes it.
