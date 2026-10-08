# P3.3 — Canonical Context Selector: Implementation Report

Status: **VALID**. Selector implemented as a pure, read-only, deterministic,
P3.2-aware, provenance-bound view builder and wired into the resume seam without
changing P2.7 authority or P2.8 behavior. All targeted suites green; no new type
errors; full-suite failures classified (no introduced regressions).

---

## 1. Baseline

- Repository: `D:\git\minicode`; branch `main`.
- HEAD at start: `25244a252c08841a99d26211d593e5cf98cfe9fa` == `origin/main`; working
  tree clean; both P3 audit documents tracked.
- Implementation gate passed before any change.

Files touched (relative to `25244a2`):

| File | Change | Δ |
| --- | --- | --- |
| `src/session/context-selector.ts` | **new** — the selector (463 lines) | +463 |
| `test/context-selector.test.ts` | **new** — 33 tests (493 lines) | +493 |
| `src/session/context-assembly.ts` | export `boundaryIsSafe` (behavior-preserving) | +8/-1 |
| `cli/setup.ts` | production integration at resume seam | +47/-3 |
| `test/writer-inventory.test.ts` | declare the P3.3 diagnostic writer (35→36) | +8/-1 |

No change to: `saveSession`, P2.7 refusal semantics, kernel/vendor, DB schema,
P3.1, P3.2.

---

## 2. P2.8 reuse / refactor

**Reused (no duplication):**

- `boundaryIsSafe` (P2.8) — now **exported** so the selector uses the ONE boundary
  rule. Only change to `context-assembly.ts`; behavior identical (proven by the
  P2.8 suite: 33/33 green, including P2.8-12 safe-boundary + P2.8-22 tool-pair).
- `syntheticSummaryMessage`, `stripContextOnly`, `ContextOnlyArtifact`,
  `ContextSource` — reused for summary materialization and the persist-artifact
  contract.
- `assembleContext` — **unchanged**; still the projection-status authority and
  the compatibility path. The integration reuses its result (`source`,
  `summary`, `coveredSeq`, `status`) as the projection decision, so no projection
  logic is duplicated.

**Disposition:** `context-assembly.ts` = **PRESERVED** (one additive export).
No wholesale replacement; the selector generalizes the seam rather than forking it.

---

## 3. Selector contract

```
canonical rows + revision + optional projection + policy/budget   (loaded by caller)
        │  (no IO inside the selector)
        ▼
P3.2 deriveContextFrontier / deriveHistoryCommit / assessContextFreshness
        ▼
deterministic selection policy
        ▼
ContextSelection (RAM-only, provenance-bound)
```

`selectContext(input: SelectContextInput): ContextSelection` — pure and
deterministic. Strategy order (audit §7):

1. `summary-plus-tail` — durable CURRENT projection summary `[0,B)` + canonical tail `[B, head]` (when boundary-safe).
2. `fallback-unknown` — full canonical view + explicit freshness (DIVERGED/UNKNOWN).
3. `full-history` — full canonical history fits budget.
4. `budget-tail` — newest contiguous boundary-safe tail that fits the budget.

The selector **does not** import persistence, `bun:sqlite`, clock, or random, and
**cannot** write canonical state (structural proof: test P3.3-33 + P3.3-29).

---

## 4. ContextSelection type

```ts
ContextSelection = {
  sessionId: string            // reference (not copy)
  threadId: string             // reference
  frontier: ContextFrontier | null   // P3.2; binds coverage + content via historyCommit
  messages: Message[]          // RAM-only materialization
  source: ContextSource        // "projection" | "messages"
  coveredSeq: number           // summary coverage end (0 = none)
  selectionBasis: SelectionBasis
  freshness: ContextFreshness  // P3.2: fresh|stale|diverged|unknown
  budget: SelectionBudgetReport
  detail: string               // diagnostic
  contextOnly?: ContextOnlyArtifact  // persist-artifact fingerprint (P2.8 contract)
}
```

Reuses `ContextFrontier`, `ContextFreshness`, `ContextSource`,
`ContextOnlyArtifact`, `Message` — **no duplicated provenance/identity schema**.
`frontier` already contains `anchorEventId`, `historyCommit`, `revision`,
`lastSeenSeq`, `lastSeenEventId` — so no field is duplicated outside it.

---

## 5. Selection basis

Typed contract (not free strings): `SelectionBasis = "full-history" |
"summary-plus-tail" | "budget-tail" | "fallback-unknown"`. Validated by
`isSelectionBasis`; frozen list `ALL_SELECTION_BASES`. Tests P3.3-30/31 assert the
exact vocabulary and that every result carries a valid value.

---

## 6. Partial coverage semantics

- `baseSeq == 0` ⇒ full-history view; `coveredSeq == 0`.
- `baseSeq > 0` ⇒ partial view; `frontier.baseSeq` is the explicit coverage
  boundary, and `historyCommit` binds **only the covered rows**.
- `budget-tail` drops a prefix **without** synthesizing a summary — modelled, as
  eviction, by `baseSeq > 0` with `source == "messages"`.
- `coveredSeq` (summary coverage) is distinct from `frontier.baseSeq`
  (view coverage) and is reported separately.

**P3.2 constraint honoured:** `deriveContextFrontier` rejects `baseSeq > head.seq`.
P2.8's full-coverage projection (`base_seq == head+1`) is therefore **capped to
`head`** (`safeBaseSeq`), yielding `summary [0,head) + tail [head]` — a faithful,
P3.2-representable view. This is a documented, bounded difference from P2.8's
empty-tail rendering (§17).

---

## 7. P3.2 integration

| Condition | Selector behavior | Test |
| --- | --- | --- |
| `EQUAL` (FRESH) | view as built; `freshness="fresh"` | P3.3-7, P3.3-11 |
| valid advance | rebuild from current canonical; higher frontier | P3.3-8 |
| `DIVERGED` | full canonical view + `freshness="diverged"`, basis `fallback-unknown`; never normalizes | P3.3-9 |
| `UNKNOWN` (canonical `null` or invalid) | full canonical view + `freshness="unknown"`; never promoted | P3.3-10 |

- Reuses `deriveContextFrontier`, `deriveHistoryCommit`, `assessContextFreshness`,
  `compareContextFrontier` (tests) — **no re-implementation** of identity/frontier/
  compare/freshness.
- Freshness is **descriptive**: the selector carries a label; it does not decide
  publication. `saveSession` remains the decider (proven by P3.3-32).
- `canonicalFrontier === undefined` ⇒ FRESH (view built from the same canonical
  input); `null` ⇒ UNKNOWN. No silent promotion of UNKNOWN.

---

## 8. Budget semantics

- Reuses kernel `estimateMessage` (chars/4 single source) — **no duplicate token
  math**. `SelectionPolicy.estimator` allows injection; default is the kernel
  estimator.
- `budgetTokens` is the **message** budget; `reservedForSystemAndTools` is carried
  through for transparency (report, not decision).
- Separation: **correctness** = a boundary-safe contiguous segment with a faithful
  frontier; **feasibility** = fits the budget. A selection is correct regardless of
  fit; the selector reports `budget.fits` and never mutates canonical to fit.
- Over budget → `budget-tail` (newest tail). Impossible budget (even one message
  exceeds) → empty view with `fits=false` and an honest `detail` (P3.3-18).

---

## 9. Determinism

`same canonical state + same policy + same budget = same ContextSelection`.
No `Date.now`, `Math.random`, `randomUUID`, network, or order-dependent iteration;
canonical `seq` ordering preserved. Proven by P3.3-21/22 (JSON-equality across
repeated calls) and P3.3-33 (structural: no clock/random in code).

---

## 10. Provenance

- `frontier.historyCommit` binds the **entire** covered content (F-05): a
  length-equal middle mutation changes the commit (P3.3-23) while endpoints stay
  equal; `anchorEventId` changes with head content (P3.3-24).
- Reference vs copy: `sessionId`/`threadId` are references; `anchorEventId`/
  `historyCommit`/`revision` are derived (recomputed from rows), never cached as
  authority.
- `selectionBasis` records *why* the view was chosen; `ModelContextProvenance`
  (P3.2) already reserves this field — the selector's basis value is directly
  compatible.

---

## 11. Failure semantics

| Condition | Behavior | Test |
| --- | --- | --- |
| empty history | empty view, `frontier=null`, `freshness=unknown`, basis `fallback-unknown` (no throw) | P3.3-1 |
| missing thread / no rows | same as empty (reader degrades to empty, never fabricates) | P3.3-1 |
| DIVERGED | full view + `diverged` label | P3.3-9 |
| UNKNOWN | full view + `unknown` label, never promoted | P3.3-10 |
| unsafe summary boundary | falls back to full canonical (no dangling tool result) | P3.3-13 |
| insufficient budget | empty view, `fits=false`, honest detail | P3.3-18 |
| malformed/non-canonical rows | fail-closed via P3.2 (`deriveHistoryCommit`/`deriveContextFrontier` throw on non-monotonic/duplicate seq) | (P3.2 suite) |

No failure silently becomes plausible-but-false context; the safe default is a
wider view with an explicit label.

---

## 12. Scope / isolation

- Every read is scoped by `(sessionId, threadId)`; the frontier is derived for the
  requested identity only.
- Cross-session: same content, different `sessionId` ⇒ different `anchorEventId`
  (no collision) — P3.3-26.
- Cross-thread: different `threadId` ⇒ `compareContextFrontier` = `DIVERGED`, never
  `EQUAL` — P3.3-27.
- Selector never reads `runs`/`run_id`/`writer_epoch`.

---

## 13. Purity / authority

- Purity: P3.3-28 (input rows unchanged) + P3.3-29 (SQLite fingerprint unchanged
  across full-history, summary-plus-tail, and budget-tail calls).
- Authority: the selector imports no writer. Structural proof P3.3-33: source has
  no `persistence`/`bun:sqlite` import and no runtime clock/random calls.
- No new store, cache, sidecar, DB, column, or generation counter.

---

## 14. Test matrix

33 tests in `test/context-selector.test.ts` (all green):

| Group | Tests |
| --- | --- |
| Basic | P3.3-1 empty, -2 single, -3 normal |
| Ordering | -4 order/no-duplicate |
| Identity | -5 session/thread, -6 frontier fields |
| Freshness | -7 EQUAL, -8 advance, -9 DIVERGED, -10 UNKNOWN, -11 P3.2 parity |
| Coverage / basis | -12 summary-plus-tail, -13 unsafe boundary, -14 full, -15 safeBaseSeq, -30/31 basis typing |
| Budget | -16 under, -17 over→budget-tail, -18 impossible, -19 exact, -20 reserved |
| Determinism | -21, -22 |
| Provenance | -23 commit binds content, -24 anchor, -25 stripContextOnly round-trip |
| Scoping | -26 cross-session, -27 cross-thread |
| Purity | -28 no input mutation, -29 no SQLite touch |
| Boundary | -32 P2.7 refuses selector output, -33 structural derived-only |

Existing suites re-run green: `context-assembly` (P2.8, 33), `context-identity`
(P3.2), `p3-reconciliation-guard` (P3.1, 14), `p2-architecture-guards`,
`writer-inventory`, `architecture-map`, `cli-session`, `session-*`.

---

## 15. Mutation / non-vacuity

Five controlled mutations of `context-selector.ts` (temporarily, then reverted):

| Probe | Mutation | Expected | Actual |
| --- | --- | --- | --- |
| P1 | hardcode `sessionId` in `coverageOf` (identity scoping off) | identity tests fail | **5 fail** |
| P2 | force `full-history` branch (budget ignored) | budget tests fail | **3 fail** |
| P3 | `reverse()` selected messages (ordering off) | ordering tests fail | **6 fail** |
| P4 | misreport `budget-tail` as `full-history` (basis off) | basis test fails | **1 fail** |
| P5 | `selectionFreshness(null) → "fresh"` (UNKNOWN promoted) | UNKNOWN test fails | **1 fail** |

**Hash correction (N4).** The original report cited the post-mutation pristine hash
`65E055BB…`. That hash was captured **before** a subsequent `biome` formatting pass;
formatting changed the bytes without changing semantics. To avoid ambiguity, the
only hash this report now treats as authoritative is the **current** tracked source
hash (see §21), which the audit confirmed as the live pristine value. The mutation
results above were reproduced on the **same logic** (formatting-invariant) and are
therefore still valid in substance. A separate hardening pass (§"Hardening" below)
re-ran the probes and added N2/N3 mutations.

### Hardening probes (post-N1/N2/N3)

| Probe | Mutation | Actual |
| --- | --- | --- |
| H1 | hardcode `sessionId` in `coverageOf` | **8 fail** |
| H2 | `selectionFreshness(null) → "fresh"` | **2 fail** (P3.3-10, P3.3-38) |
| H3 | force empty `budget-tail` `fits=true` (N2 off) | **1 fail** (P3.3-34) |
| H4 | drop `stale` from the fallback branch (N3 off) | **2 fail** (P3.3-36, P3.3-38) |
| H5 | remove `canonicalFrontier` from the resume seam (N1 off) | **1 fail** (N5-3) |

All probes reverted; each file restored to its exact pre-probe SHA-256.


---

## 16. P3.1 / P2.7 boundary

- The selector produces a view; it holds **no write capability** (no persistence
  import).
- Test P3.3-32: a `budget-tail` selection (prefix dropped) is fed to `saveSession`;
  P2.7 **refuses** (`RefusedHistoryRewriteError`) and canonical stays intact
  (`["A","B","C","D","E"]`). The selector cannot bypass publication safety.
- No `saveSession` change was made to accommodate the selector.

---

## 17. Integration

- Seam: the resume path in `cli/setup.ts` (`createCliSession`). `assembleContext`
  is retained for the projection decision + diagnostics + P2.8 compatibility;
  `selectContext` now **produces** `initialMessages`/`contextOnly`.
- Inputs: `loadThreadHistoryWithSeq` (rows), `loadPresentationEvents` +
  `countDurableCompactions` (revision), and the P2.8 projection decision
  (`view.summary`/`view.coveredSeq`) as the `ProjectionSummary`.
- Budget: `contextWindowTokens` (when configured) else unbounded (reproduces P2.8).
- Preserved: P2.8 behavior (context-assembly 33/33, cli-session 45/45),
  compaction behavior, provenance, identity, deterministic ordering, no canonical
  writes.
- New diagnostic (declared in `writer-inventory.test.ts`, owner `diagnostic`):
  `[select sid=… basis=… freshness=… head=…]`.
- Scope: only this seam widened; no other context consumer touched.

### 17.1 Documented bounded difference

P2.8 renders a full-coverage projection (`base_seq == head+1`) as `summary` with an
empty tail. The selector caps `baseSeq` to `head` (P3.2 forbids `baseSeq > head`),
so it renders `summary [0,head) + tail [head]` — all canonical rows remain present;
only the summary coverage marker shifts by one. For every `baseSeq ∈ [1, head]` the
selector reproduces P2.8 exactly.

---

## 18. Validation

| Target | Result | Classification |
| --- | --- | --- |
| P3.3 selector | **38/38 pass** | (33 original + 5 hardening N1/N2/N3) |
| P3.3 resume integration (N5) | **3/3 pass** | new |
| P2.8 context-assembly | **33/33 pass** | — |
| P3.2 context-identity | pass | — |
| P3.1 reconciliation guard | **14/14 pass** | — |
| P2.7 persistence (rewrite/ttl/vector) | pass | — |
| architecture-map | **2/2 pass** | (map updated for the new module) |
| writer-inventory | pass | (P3.3 diagnostic writer declared) |
| harness-p3, session-*, context-audit | pass | — |
| typecheck (`tsc --noEmit`) | **28 errors, 0 new** | all pre-existing `test/phase3*`/`phase4*` |
| **full suite** | **4390 pass / 23 skip / 8 fail** (298 files / 4421 tests) | see below |

Full-suite failures (8) classification:

| Failure | Class |
| --- | --- |
| `audit-manifes-korup`, `P2.1 ×2`, `P2.2 ×2` | **FLAKY** (stderr-stub contamination; green in isolation — 34/34) |
| `P3-constructor (m15)` | **PRE-EXISTING** (P1 allowlist debt) |
| `S13 scheduler-first` | **PRE-EXISTING** (brittle source-text assertion) |
| `web-ssg nested-list` | **PRE-EXISTING/ENV** |

The checkpoint baseline was 9 fail; after hardening it is 8 fail (the flake set
varies run-to-run). `writer-inventory` and `architecture-map` are green. **Zero P3.3
regressions.**


---

## 19. Known limitations

See also `P3_3_HARDENING_REPORT.md` for the N1–N5 resolution.

1. **Full-coverage projection cap** (§17.1): `baseSeq` for `base_seq == head+1` is
   capped to `head`; view is faithful but the summary marker differs from P2.8 by
   one position. Bounded and documented.
2. **`budget-tail` is eviction, not compaction**: it drops a prefix without a
   durable summary record; it is intentionally **not** a fold. A `budget-tail` view
   published as-is is refused by P2.7 (correct). (Empty-result feasibility now
   reports `fits=false` — N2 fixed.)
3. **`revision` undercounting on headless paths**: `countDurableCompactions`
   counts durable `context.compacted` events only; a path without the presentation
   adapter under-counts (declared P3.5 seam; fail-closed, never guessed).
4. **Selector is used at one seam** (resume). Other context consumers still call
   `assembleContext`; widening is deferred (audit: do not widen every consumer yet).
5. **No relevance/ranking**: this milestone is infrastructure only (no
   embedding/LLM/network ranking), by mandate.

---


## 20. Final verdict

The selector is derived-only, has no persistence authority, is deterministic,
P3.2-aware, provenance-bound, scoped by identity, freshness-aware (UNKNOWN never
promoted), budget-bounded, and cannot bypass P3.1/P2.7. P2.8 behavior is preserved
(subject to the one documented cap). Targeted tests are green; mutation evidence is
current and load-bearing; the full suite has no unresolved introduced regression.

> Hardening (N1–N5) is recorded in `P3_3_HARDENING_REPORT.md`: resume-seam
> freshness is now computed (N1), empty `budget-tail` reports `fits=false` (N2),
> stale rows are labelled `fallback-unknown` (N3), the report hash is corrected
> (N4), and a resume integration test with an anti-regression guard is added (N5).

```text
MINICODE P3.3 IMPLEMENTATION STATUS:
VALID

Selector:
IMPLEMENTED

P2.8 reuse:
PRESERVED

P3.2 integration:
COMPLETE

Selection basis:
COMPLETE

Partial coverage semantics:
COMPLETE

Budget semantics:
COMPLETE

Determinism:
PASS

Provenance:
PASS

Purity:
PASS

Identity scoping:
PASS

Second authority:
NO

P3.1/P2.7 boundary:
PRESERVED

Targeted tests:
PASS

Mutation/non-vacuity:
PASS

Full suite:
CLASSIFIED_FAILURES

Known limitations:
1. Full-coverage projection base_seq==head+1 capped to head (view faithful; summary marker shifts by one vs P2.8).
2. budget-tail is context-window eviction (no durable summary); publishing it as-is is refused by P2.7 (correct).
3. revision undercounts on headless paths without the presentation adapter (declared P3.5 seam; fail-closed).
4. Selector wired at the resume seam only; other context consumers still use assembleContext (deferred widening).
5. No semantic relevance ranking (infrastructure-only milestone).

P3.4:
NOT STARTED

CONFIDENCE:
HIGH
```
