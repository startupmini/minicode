# P3.3 — Current Canonical Truth & Closure Audit

Read-only post-implementation audit. No source/test/docs/config modification; no git
mutation; working tree preserved exactly. Current code/tests are authoritative over the
implementation report. Every claim below was re-derived from source, tests, git state,
and execution evidence.

---

## 1. Executive Summary

P3.3 (Canonical Context Selector) is **implemented and safety-sound**. The selector is a
pure, read-only, deterministic function that reuses P3.2 (identity/frontier/freshness)
and P2.8 (`boundaryIsSafe`, `syntheticSummaryMessage`) without duplicating their logic,
produces a provenance-bound `ContextSelection`, and cannot write canonical state or
bypass P2.7. The five safety-critical properties hold: **derived-only, single authority,
P3.2-aware, deterministic, provenance-complete, UNKNOWN never promoted, P3.1/P2.7
boundary preserved**.

The audit found **no blocking defect**. It found several **non-blocking** imprecisions
that the implementation report does not state, the most material being:

- **N1 — Integration freshness is uncomputed.** The resume-seam call in `cli/setup.ts`
  never passes `canonicalFrontier`, so `selectionFreshness(_, undefined)` returns
  `fresh` unconditionally. The production `[select … freshness=fresh]` line is therefore
  not a real freshness check. It cannot *promote* UNKNOWN (it never computes one), so it
  is not an unsafe promotion — but the report's "P3.2 integration: COMPLETE" overstates
  the *integration* (freshness is complete at the selector level, unwired at the seam).
- **N2 — `budget-tail` can report `fits:true` with an empty view.** In a narrow
  tool-pair boundary-shift case, `selectedRows` becomes empty while `basis="budget-tail"`
  and `fits = (0 <= limit) = true`. Safe (empty view, explicit basis) but imprecise.
- **N3 — `stale` freshness proceeds as `full-history`.** A caller-supplied stale row set
  is labelled `freshness="stale"` but `basis="full-history"`. Honest labelling, but the
  basis does not signal staleness; downstream must read `freshness`.
- **N4 — Report hash drift.** The report cites the pristine post-mutation hash
  `65E055BB…`; the current file hash is `AD817353…` because biome formatting ran after the
  mutation section. Semantics unchanged (33/33 green), but the literal is stale.
- **N5 — No committed test covers the resume-seam integration.** The selector is fully
  unit-tested (33 tests) and I reconfirmed the integration live, but no tracked test
  asserts the seam uses the selector.

These are bounded, non-safety-critical, and belong to the fast-follow/wiring scope. The
verdict is therefore **VALID WITH CONDITIONS**.

---

## 2. Baseline

| Fact | Value |
| --- | --- |
| Root (`--show-toplevel`) | `D:/git/minicode` |
| Branch | `main` |
| HEAD | `25244a252c08841a99d26211d593e5cf98cfe9fa` |
| `origin/main` | `25244a252c08841a99d26211d593e5cf98cfe9fa` (HEAD == origin/main) |
| Working tree | DIRTY — exactly the 6 expected P3.3 files |
| Modified (tracked) | `cli/setup.ts`, `src/session/context-assembly.ts`, `test/writer-inventory.test.ts` |
| Untracked | `src/session/context-selector.ts`, `test/context-selector.test.ts`, `P3_3_IMPLEMENTATION_REPORT.md` |

`diff --stat`: `cli/setup.ts` +47/-3, `context-assembly.ts` +8/-1, `writer-inventory.test.ts`
+8/-1. All six files are genuinely P3.3. Tree preserved unchanged at audit end.

---

## 3. Implementation Inventory

| File | Classification | Notes |
| --- | --- | --- |
| `src/session/context-selector.ts` (new, 463 lines) | **P3.3 REQUIRED** | the selector |
| `test/context-selector.test.ts` (new, 33 tests) | **P3.3 REQUIRED** | contract tests |
| `src/session/context-assembly.ts` | **P3.3 SUPPORTING** | `boundaryIsSafe` exported (behavior-preserving) |
| `cli/setup.ts` | **P3.3 REQUIRED** | resume-seam integration |
| `test/writer-inventory.test.ts` | **P3.3 SUPPORTING** | declared the `[select …]` diagnostic writer (35→36) |
| `P3_3_IMPLEMENTATION_REPORT.md` | **P3.3 SUPPORTING** | report (has minor drift, §23) |

**No UNRELATED. No SUSPICIOUS.** No changes to `saveSession`/`persistence.ts`, P2.7
semantics, kernel/vendor, or DB schema (verified: `git diff --stat src/session/persistence.ts`
empty).

---

## 4. Selector Architecture

```
canonical rows + revision + optional projection + policy/budget   (loaded by caller)
        │   selector performs NO IO
        ▼
P3.2 deriveContextFrontier / deriveHistoryCommit / assessContextFreshness   (DESCRIPTIVE)
        ▼
P3.3 selection policy (deterministic, 4 bases)
        ▼
ContextSelection (RAM-only; provenance via frontier.historyCommit)
        ▼
runtime ContextStore (EXECUTION-LOCAL)       ← via cli/setup.ts initialMessages
        ▼
publication request → saveSession (P3.1 decision + P2.7 safety) → canonical
```

| Arrow | Data | Authority | Mutable | Persistence | Refusal |
| --- | --- | --- | --- | --- | --- |
| rows → selector | canonical rows | caller (persistence read) | read-only | none | n/a |
| selector → P3.2 | hashing only | pure | none | none | throws on corrupt seq |
| selector → ContextSelection | derived value | derived | frozen | none | n/a |
| ContextSelection → runtime | messages | execution-local | buffer-local | none | n/a |
| runtime → saveSession | proposed history | authoritative writer | — | append-only | `RefusedHistoryRewriteError` |

**No hidden writer.** The selector imports no persistence function and calls only pure
helpers (verified §5).

---

## 5. Purity / Authority

**Direct imports** (selector): `#minicore/core/tokens` (pure estimator),
`#minicore/core/types` (type), `./context-assembly` (`boundaryIsSafe`,
`syntheticSummaryMessage`, types — pure), `./context-identity` (P3.2 — pure).

**Transitive:** `context-selector.ts → context-assembly.ts → persistence.ts`. This is a
**module-graph edge**, not a call path: the selector uses only `boundaryIsSafe`
(pure) and `syntheticSummaryMessage` (pure) from assembly, neither of which touches
the DB. Grep confirms the selector contains **no** `getProjection`/`loadThreadHistory`/
`saveSession`/`open(`/`db.` calls (only comments). `context-identity.ts` imports only
`node:crypto`.

**Behavioral purity:** P3.3-28 (input rows unchanged), P3.3-29 (real SQLite fingerprint
unchanged across full-history, summary-plus-tail, budget-tail). **PASS.**

Caveat (non-blocking): the structural "cannot write" argument rests on *no persistence
function being called*, not on the absence of the import edge. A future edit adding a
persistence call to `context-assembly.ts` would extend the selector's reachable graph;
this is a maintenance watch-item, not a current violation.

---

## 6. P3.2 Integration

| Condition | Behavior (verified) | Test |
| --- | --- | --- |
| `EQUAL` | `freshness="fresh"`, view as built | P3.3-7, P3.3-11 |
| valid advance | rebuild from passed rows; `B_AHEAD` vs prior | P3.3-8 |
| `DIVERGED` | full view + `freshness="diverged"`, basis `fallback-unknown`; never normalizes | P3.3-9 |
| `UNKNOWN` (canonical `null`/invalid) | full view + `freshness="unknown"`; never promoted | P3.3-10 |
| `canonicalFrontier === undefined` | `fresh` (view built from the same rows) | (integration behavior) |
| stale rows (behind canonical) | `freshness="stale"`, basis `full-history` (see N3) | (probed) |

Reuses `deriveContextFrontier`, `deriveHistoryCommit`, `assessContextFreshness`,
`compareContextFrontier` (tests) — **no re-implementation**. Describe/decide boundary
intact: the selector carries a label; `saveSession` decides (P3.3-32).

**N1 (non-blocking):** the resume-seam integration does **not** pass `canonicalFrontier`,
so freshness is unconditionally `fresh` in production. The report's "P3.2 integration:
COMPLETE" is true of the selector, not of the seam.

---

## 7. Selection Basis

Typed `SelectionBasis = full-history | summary-plus-tail | budget-tail | fallback-unknown`;
validated by `isSelectionBasis`; frozen `ALL_SELECTION_BASES`. Verified trigger/output per
value:

| Basis | Trigger | Output | Provenance | Partial coverage |
| --- | --- | --- | --- | --- |
| `summary-plus-tail` | projection `baseSeq>0` + safe boundary + non-empty summary | `[summary] + tail[b,head]` | `frontier.baseSeq=b`, commit over `[b,head]` | explicit (`coveredSeq=b>0`) |
| `fallback-unknown` | empty rows **or** freshness `unknown`/`diverged` | full rows (or `[]`) | `frontier` (or null) | n/a |
| `full-history` | full rows fit budget (freshness `fresh`/`stale`) | full rows | `frontier.baseSeq=0` | none (complete) |
| `budget-tail` | full rows exceed budget | newest safe contiguous tail | `frontier.baseSeq>0` | explicit |

**Finding N2 (non-blocking):** in a tool-pair boundary-shift edge, `budget-tail` can yield
`messages=[]` with `fits=true` (`0 <= limit`) while `frontier.baseSeq` = head. The output
is an honest empty view but the `fits`/basis pair is imprecise.

**Finding N3 (non-blocking):** a stale row set produces `basis="full-history"` with
`freshness="stale"`; the basis does not encode staleness (freshness does).

No branch was found where `selectionBasis` misdescribes the **content** (the basis always
matches the coverage strategy). The two findings are about *fit/freshness signalling*, not
content misdescription.

---

## 8. Partial Coverage / Frontier

- `baseSeq == 0` ⇒ complete; `coveredSeq == 0`, `frontier.baseSeq == 0`.
- `baseSeq > 0` ⇒ explicit partial boundary; `historyCommit` binds only covered rows.
- **Mutual consistency** verified: `frontier.headSeq` = last row seq; `lastSeenSeq` =
  head (default); `anchorEventId` = content-bound head hash; `revision` passed through;
  `historyCommit` = `deriveHistoryCommit(covered)`. Test P3.3-6 asserts these.

**Cap behavior (limitation #1):** `deriveContextFrontier` rejects `baseSeq > head.seq`
("view is never inverted"), so P2.8's full-coverage projection (`base_seq == head+1`) is
`Math.min(rawBase, head)`-capped. Result: `summary [0,head) + tail [head]` (nmsg ≥ 2),
vs P2.8's `summary [0,head+1) + []`. **No data loss** — every row's content is present
(summary + tail includes the head); the marker is conservative. **CURRENTLY TRUE, not a
correctness bug; acceptable documented limitation.**

---

## 9. Budget-Tail Safety

- `budget-tail` is produced with `source="messages"` (no summary). It is an eviction, not a
  fold — the selector never synthesizes a summary and never writes canonical.
- **P3.3-32** (real `saveSession`): a `budget-tail` selection fed to `saveSession` is
  **refused** (`RefusedHistoryRewriteError`); canonical stays `["A","B","C","D","E"]`.
- `saveSession`/P2.7 semantics unchanged (`persistence.ts` unmodified).
- No downstream path in the selector treats `budget-tail` as canonical; provenance marks
  `frontier.baseSeq > 0` (partial) and `selectionBasis="budget-tail"`.
- Compaction/shrink remains the explicit, provenanced `shrinkThreadHistory` route.

**PASS.** (The N2 imprecision does not affect this boundary.)

---

## 10. Compaction Interaction

- The selector never compacts: no call to `ContextStore`/`replace`/`compact*`; it only
  *renders* a caller-supplied durable `summaryText` via `syntheticSummaryMessage`.
- `SELECT ≠ COMPACT`: eviction (`budget-tail`) is distinct from folding; no summary is
  generated.
- `COMPACT ≠ REWRITE`: unchanged — kernel folds in RAM; `persistCurrent` refuses non-prefix
  buffers unless the explicit provenanced shrink runs.
- `SELECT ≠ PERSIST`: selector output is RAM-only; persistence is downstream.
- No double-summarization, no provenance loss, no frontier drift observed. `revision`
  (from `countDurableCompactions`) is passed through unchanged.

**PASS.** (Forward seam: the A+C projection producer is P3.7; not in scope.)

---

## 11. P2.8 Compatibility

`git diff src/session/context-assembly.ts` = **only** `function boundaryIsSafe` →
`export function boundaryIsSafe` plus a doc comment. `assembleContext` is byte-unchanged.
P2.8 suite: **33/33 green** (context-assembly.test.ts). Behavior **PRESERVED**.

The selector does **not** duplicate `assembleContext`: it reuses `boundaryIsSafe`,
`syntheticSummaryMessage`, `stripContextOnly` (via the persist contract),
`ContextOnlyArtifact`, `ContextSource`, and adds its own budget/fallback strategy.

---

## 12. Resume Integration

`cli/setup.ts` resume seam (lines 903-964):
- Keeps `assembleContext` (P2.8) for the projection decision + diagnostics.
- Reads `loadPresentationEvents` → `countDurableCompactions` (revision),
  `loadThreadHistoryWithSeq` (rows), and builds `ProjectionSummary` from P2.8's result.
- Calls `selectContext` → sets `initialMessages` / `contextOnly` / baseline.
- Emits `[select sid=… basis=… freshness=… head=…]`.

**Classification: EXPECTED STAGED ROLLOUT.** The selector is wired at one seam; other
consumers still use `assembleContext`. This matches the audit mandate ("do not widen every
context consumer yet"). Not an inconsistent architecture.

**Live reconfirmation:** resume of a 3-message session produced
`[select sid=e2e basis=full-history freshness=fresh head=2]` and history `["A","B","C"]`.

**N1 + N5:** `canonicalFrontier` is not passed (freshness unwired); no committed test
covers this seam.

---

## 13. Writer Inventory

`test/writer-inventory.test.ts`: `cli/setup.ts` max 35→36, owner `diagnostic`, with a
declaration comment for the `[select …]` line stated as a stderr provenance diagnostic. The
"writer" is a `console.error` diagnostic, **not** a persistence writer. The selector
itself writes nothing (verified §5). Categorization is **semantically correct**; it does
not hide an authority violation. `writer-inventory` passes (declared, not absorbed).

---

## 14. Isolation

- Scope is `(sessionId, threadId)` for every read; frontier derived for the requested
  identity only.
- Cross-session: same content, different `sessionId` ⇒ different `anchorEventId` (P3.3-26).
- Cross-thread: different `threadId` ⇒ `compareContextFrontier = DIVERGED`, never `EQUAL`
  (P3.3-27).
- Selector never reads `runs`/`run_id`/`writer_epoch`.
- Stale rows cannot silently select newer unrelated history: freshness is `stale` and the
  row set is exactly what the caller passed (no hidden re-read).

**PASS.**

---

## 15. Determinism

`same canonical state + policy + budget = same ContextSelection`. No `Date.now`,
`Math.random`, `randomUUID`, network, or order-dependent iteration; canonical `seq` order
preserved; no module-level mutable state (verified by grep). P3.3-21/22 assert JSON
equality across repeated calls; P3.3-33 asserts no clock/random in code.

**PASS.**

---

## 16. Provenance

`ContextSelection` answers "which canonical history produced this context?" via:
`frontier.{sessionId, threadId, baseSeq, headSeq, lastSeenSeq, lastSeenEventId,
anchorEventId, revision, historyCommit}` + `selectionBasis` + `source` + `coveredSeq`.
`historyCommit` binds the **entire** covered content (F-05: mid-rewrite changes it while
endpoints stay equal — P3.3-23); `anchorEventId` changes with head content (P3.3-24).
Partial selections carry `baseSeq > 0` explicitly. References (`sessionId`, `threadId`,
per-row `eventId`/`seq`) vs derived values (`anchor`, `commit`, `revision`) are correctly
separated; no duplication into a second store.

**PASS** (with N3 caveat: `budget-tail`/`full-history` provenance is correct; only the
basis↔freshness signalling for `stale` is imprecise).

---

## 17. Failure Semantics

| Condition | Behavior | Correct? |
| --- | --- | --- |
| empty history | empty view, frontier `null`, freshness `unknown`, basis `fallback-unknown` (no throw) | yes |
| missing thread/rows | same as empty (never fabricates) | yes |
| DIVERGED | full view + `diverged` label | yes |
| UNKNOWN | full view + `unknown` label, never promoted | yes |
| unsafe summary boundary | falls back to full canonical (no dangling tool result) | yes |
| insufficient budget | empty view + honest detail (`fits=false` when nothing fits) | yes |
| malformed rows | fail-closed via P3.2 (throws on non-monotonic/duplicate seq) | yes |

No path silently turns unsafe/unknown into trusted/complete. **PASS.**

---

## 18. P3.1 / P2.7 Boundary

- `saveSession`/`persistence.ts` **unchanged** (verified diff empty).
- Selector contains **no** persistence/refusal/fallback logic (grep: no `saveSession`,
  `shrinkThreadHistory`, `INSERT/UPDATE/DELETE`, `db.`).
- P3.3-32 proves a selector output cannot bypass prefix validation/epoch fence/refusal;
  `RefusedHistoryRewriteError` fires and canonical is intact.
- Explicit provenanced shrink (`shrinkThreadHistory`) remains the only history-rewrite
  route; untouched.

**PRESERVED.**

---

## 19. Mutation Evidence

The implementation used five controlled probes (temporarily mutated, then reverted):
identity scoping (→5 fail), budget (→3 fail), ordering (→6 fail), selection basis (→1
fail), UNKNOWN handling (→1 fail). The tests targeted by each probe exist and would catch
each mutation (identity: P3.3-5/6/26; budget: P3.3-16-19; ordering: P3.3-4/12/13; basis:
P3.3-17; UNKNOWN: P3.3-10). Evidence is load-bearing and uses only current P3.3 tests (no
historical P3.1 evidence).

**N4:** the report cites pristine hash `65E055BB…`; the current file hash is `AD817353…`
(biome formatting ran after the mutation section). The mutation logic is formatting-invariant,
so the evidence remains valid in substance; only the literal hash is stale. Current suite is
33/33 green.

---

## 20. Test Reachability

| Test group | Classification |
| --- | --- |
| P3.3-1…-28, -30, -31 (pure selector calls) | EXECUTABLE PURE FUNCTION |
| P3.3-29 (real SQLite fingerprint) | EXECUTABLE PRODUCTION PATH (purity) |
| P3.3-32 (real `saveSession` refusal) | EXECUTABLE PRODUCTION PATH (boundary) |
| P3.3-33 (source-string scan) | STRUCTURAL GUARD |

No helper-only, no "not actually reachable" tests. All 33 call the production
`selectContext` (or a real persistence boundary). **PASS** for the selector. The
**integration** seam has no dedicated committed test (N5).

---

## 21. Validation

| Target | Result |
| --- | --- |
| P3.3 selector | **33/33 pass** |
| P2.8 context-assembly | **33/33 pass** |
| P3.2 context-identity | pass |
| P3.1 reconciliation guard | **14/14 pass** |
| writer-inventory | pass |
| Targeted batch (5 files) | **120/120 pass** |
| **full suite** | **4381 pass / 23 skip / 9 fail** (297 files / 4413 tests) |

Full-suite failures (9) this run: `MCP-context`, `audit-manifes-korup`, `P2.1 ×2`,
`P2.2 ×2` → **FLAKY** (all pass in isolation: 34/34 session files, 8/8 phase4b); 
`P3-constructor (m15)`, `S13 scheduler-first`, `web ssg nested-list` → **PRE-EXISTING/
ENV**. None is a P3.3/P3.1/P3.2 regression. The flake set varies run-to-run (consistent
with nondeterministic contamination, not a fixed failure). `writer-inventory` is green.

---

## 22. Typecheck

`bun x tsc --noEmit` → **28 errors**, **all** in `test/phase3a|3b|3c*` and
`test/phase4a*|4b*` (pre-existing envelope). **Zero** errors in
`src/session/context-selector.ts`, `src/session/context-assembly.ts`, `cli/setup.ts`, or
`test/context-selector.test.ts`. **CLASSIFIED_ERRORS (pre-existing only).**

---

## 23. Report / Code Drift

| Report claim | Actual | Class |
| --- | --- | --- |
| Selector implemented (463 lines) | true | CURRENTLY TRUE |
| P2.8 reuse PRESERVED | true (`export` only; 33/33) | CURRENTLY TRUE |
| P3.2 integration COMPLETE | true at selector; **not** at the seam (freshness unwired) | **PARTIALLY TRUE** (N1) |
| Determinism / purity / isolation PASS | true | CURRENTLY TRUE |
| P3.1/P2.7 boundary PRESERVED | true | CURRENTLY TRUE |
| Mutation pristine hash `65E055BB…` | current hash `AD817353…` (post-format) | **PARTIALLY TRUE** (N4) |
| Limitation #1 base_seq cap | reproduced | CURRENTLY TRUE |
| Limitation #2 budget-tail non-durable + refused | reproduced (P3.3-32) | CURRENTLY TRUE |
| Limitation #3 revision undercount headless | reproduced (`countDurableCompactions` ignores `context:compacted`) | CURRENTLY TRUE |
| Limitation #4 resume-seam only | true | CURRENTLY TRUE |
| Limitation #5 no ranking | true (no embedding/LLM/network) | CURRENTLY TRUE |

---

## 24. Authority Table

| Component | Reads | Writes | Durable | Authority |
| --- | --- | --- | --- | --- |
| Canonical history (`messages`) | via `persistence.ts` reads | `persistence.ts` only | yes | **AUTHORITATIVE (single)** |
| P3.2 (`context-identity.ts`) | canonical rows (passed in) | none | no | **DERIVED (descriptive)** |
| P3.3 selector | rows/revision/projection (passed in) | none | no | **DERIVED (view builder)** |
| Runtime context (`ContextStore`) | ContextSelection | in-RAM only | no | **EXECUTION-LOCAL** |
| P3.1 (reconciliation contract) | proposed history | none (decision surfaced by saveSession) | no | derived enforcement |
| P2.7 (`saveSession`) | canonical rows | `messages` (append/explicit shrink) | yes | **CANONICAL DECIDER** |

**Exactly one canonical history authority** (`persistence.ts`/`saveSession`). P3.3 is
derived. **PASS.**

---

## 25. Closure Matrix

| Criterion | Status |
| --- | --- |
| selector derived-only | SATISFIED (behavioral; module-graph caveat noted) |
| no persistence authority | SATISFIED |
| no second source of truth | SATISFIED |
| deterministic | SATISFIED (P3.3-21/22/33) |
| P3.2 integrated correctly | SATISFIED at selector; **PARTIAL at seam** (N1) |
| EQUAL handled correctly | SATISFIED (P3.3-7/11) |
| advance handled correctly | SATISFIED (P3.3-8) |
| DIVERGED handled correctly | SATISFIED (P3.3-9) |
| UNKNOWN handled correctly | SATISFIED (P3.3-10) |
| complete vs partial coverage explicit | SATISFIED (P3.3-12/14/17) |
| selectionBasis semantically correct | SATISFIED (content); fit/stale signalling imprecise (N2/N3) |
| budget semantics correct | SATISFIED (P3.3-16-20) |
| provenance complete | SATISFIED (P3.3-23/24/25) |
| identity isolation correct | SATISFIED (P3.3-26/27) |
| P2.8 behavior preserved | SATISFIED (33/33) |
| P3.1/P2.7 boundary preserved | SATISFIED (P3.3-32) |
| tests load-bearing | SATISFIED (mutation probes) |
| mutation evidence current | SATISFIED in substance; hash literal stale (N4) |
| full-suite failures classified | SATISFIED (flaky + pre-existing) |
| typecheck impact understood | SATISFIED (28 pre-existing, 0 new) |
| known limitations accurate | PARTIALLY (limitations true; N1/N4 not stated) |

No safety-critical item fails. The partials are bounded and non-blocking.

---

## 26. Final Verdict

**VALID WITH CONDITIONS.** P3.3 is safe, derived-only, deterministic, provenance-bound,
P3.2-aware, and cannot bypass P3.1/P2.7. The partials are non-blocking wiring/report
imprecisions (uncomputed integration freshness, an imprecise `budget-tail` `fits` edge, an
imprecise stale-labelling, a stale hash literal, and a missing integration test) — none
affects canonical safety or correctness.

---

## 27. Exact Next Action

**One action:** commit the P3.3 working set (the 5 code/test/report files) as the P3.3
checkpoint, then (as a separate fast-follow, not part of closure) wire
`canonicalFrontier` at the resume seam and add a resume-integration test asserting the
selector is invoked — addressing N1/N5.

(No implementation, commit, or push was performed in this audit.)

---

```text
MINICODE P3.3 CURRENT CANONICAL STATUS:
VALID WITH CONDITIONS

Implementation:
TRUE

Selector purity:
PASS

Single authority:
PASS

P3.2 integration:
PARTIAL

Selection basis:
PASS

Partial coverage:
PASS

Budget safety:
PASS

Compaction safety:
PASS

P2.8 compatibility:
PASS

Identity isolation:
PASS

Determinism:
PASS

Provenance:
PASS

UNKNOWN handling:
PASS

P3.1/P2.7 boundary:
PRESERVED

Mutation/non-vacuity:
PASS

Test reachability:
PASS

Full suite:
CLASSIFIED_FAILURES

Typecheck:
CLASSIFIED_ERRORS

Known limitations:
1. Full-coverage projection base_seq==head+1 capped to head (faithful view; summary marker conservative vs P2.8).
2. budget-tail is context-window eviction (non-durable); publishing it is refused by P2.7 (correct). Edge: empty tail can report fits=true (N2).
3. revision undercounts on headless paths without the presentation adapter (declared P3.5 seam).
4. Selector wired at the resume seam only; other consumers still use assembleContext.
5. No semantic relevance ranking (infrastructure-only milestone).

Blocking findings:
NONE

Non-blocking findings:
N1. Integration freshness uncomputed: cli/setup.ts omits canonicalFrontier, so production freshness is unconditionally "fresh" (not an unsafe promotion, but the seam's freshness is unwired).
N2. budget-tail can report fits=true with an empty view in a tool-pair boundary-shift edge (safe but imprecise).
N3. A stale row set yields basis="full-history" with freshness="stale" (honest, but basis does not encode staleness).
N4. Implementation report cites pristine hash 65E055BB…; current hash is AD817353… (biome reformatted after the mutation section; semantics unchanged).
N5. No committed test covers the resume-seam integration; selector itself is fully unit-tested.

P3.4:
NOT STARTED

Recommended next action:
Commit the P3.3 working set as the checkpoint, then fast-follow by wiring canonicalFrontier at the resume seam and adding a resume-integration test (N1/N5).

CONFIDENCE:
HIGH
```
