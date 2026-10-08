# P3.4 — Current Canonical Truth & Closure Audit

Read-only post-implementation audit. No source/test/docs/config modification; no git
mutation; working tree preserved exactly. Current canonical code is authoritative; the
implementation report is evidence only.

---

## 1. Executive Summary

P3.4 (Durable Context Projection Producer) is **implemented and genuinely production-real**.
The audit independently verified — not from the report, but from source + committed code +
live execution — that:

- The producer (`src/session/context-projection.ts`) builds `history_projections` rows from
  **canonical rows only**, writes **only** the derived cache, and never touches
  `messages`/head/run (authority graph PASS).
- `summary-plus-tail` is a **real, reproducible production path**: `persistCurrent` →
  projection row in DB (`base_seq`, anchor, ranges) → next resume → selector emits
  `basis=summary-plus-tail` and seeds `[summary] + tail`.
- Canonical history remains the sole authority; `saveSession`/P2.7 untouched.
- The PARTIAL + STALE semantics are **coherent in practice**: the two STALE sub-cases are
  distinguished by `getProjectionStatus` (rule 7 = boundary identity changed; rule 8 = head
  advanced), and rule-7 (the trust-destroying one) is **unreachable on the automatic path**
  because any canonical rewrite (shrink) deletes all thread projections in the same txn.

**One non-blocking robustness/drift finding:** `readConsumableSummaryProjection` accepts
**any** STALE state, not only "STALE with intact anchor" as the report claims. This is a
superset of the documented contract. Rule-7 STALE (broken anchor) cannot occur through the
automatic path, so no current safety violation exists — but the reader should defensively
reject the anchor-broken STALE sub-case (or the report should be corrected to describe the
actual behavior).

**Verdict: VALID WITH CONDITIONS.** No safety-critical or semantic contradiction;
conditions are the documented limitation (partial-only production; full coverage = P3.7)
and the reader-robustness drift (N1).

---

## 2. Baseline

| Fact | Value |
| --- | --- |
| Root | `D:/git/minicode` |
| Branch | `main` |
| HEAD | `e18d8747613c07af90973ae4eb1783b624e87300` |
| `origin/main` | `e18d8747613c07af90973ae4eb1783b624e87300` |
| Working tree | CLEAN |
| P3.4 implementation commit | `aba565f36b45fde12c9bfd31bddce183ef27c524` |
| P3.4 producer working-tree hash | `ABF6CE81…` == committed blob (pristine) |

---

## 3. Implementation Inventory

| File | Class | Status |
| --- | --- | --- |
| `src/session/context-projection.ts` (191 lines) | CURRENT EXECUTABLE | producer + consumable reader |
| `test/context-projection.test.ts` (18 tests) | CURRENT TEST | green (re-run) |
| `cli/setup.ts` | CURRENT EXECUTABLE | resume seam + `persistCurrent` trigger |
| `test/writer-inventory.test.ts` | CURRENT TEST | declared P3.4 diagnostics (36→38) |
| `docs/ARCHITECTURE.html` | CURRENT DOCUMENTATION | module map entry |
| `P3_4_IMPLEMENTATION_REPORT.md` | CURRENT DOCUMENTATION | report (minor drift, §21) |
| `P3_4_SCOPE_RATIFICATION_REPORT.md` | CURRENT DOCUMENTATION | owner ratification |
| `P3_ROADMAP.md` | CURRENT DOCUMENTATION | canonical roadmap (P3.4 = producer) |

No HISTORICAL/STALE artifacts introduced.

---

## 4. Production Projection Path (reconstructed, independently verified)

```
canonical history (messages)
      │  read-only: loadThreadHistoryWithSeq
      ▼
P3.4 producer (produceSummaryProjection)
      │  writes ONLY history_projections via buildProjection (epoch-fenced, 1 txn)
      ▼
history_projections row { session_id, thread_id, projection_id="summary",
                          base_seq, summary_text, included_ranges, built_at, anchor_event_id }
      │  read: readConsumableSummaryProjection (CURRENT or STALE)
      ▼
P3.3 selector (selectContext, projection input)
      │  summary + tail [base_seq, head]
      ▼
runtime context (initialMessages)
```

- **Caller:** `cli/setup.ts` — resume seam (read) and `persistCurrent` (produce).
- **Trigger:** after a successful canonical write in `persistCurrent`; best-effort.
- **Source rows:** `loadThreadHistoryWithSeq` (canonical).
- **Builder/writer:** `buildProjection` (delete+insert in one txn).
- **Error handling:** caught at the seam (`[warn] projection produce failed`); no-op on
  empty/no-foldable-prefix.
- **Selector consumer:** `selectContext` with `projection` input → `summary-plus-tail`.

**The production path is real and was re-verified live on committed code** (§12).

---

## 5. Authority

```
Canonical History
      │
      ├── saveSession ─────────→ canonical history (messages)
      │
      └── P3.4 Producer ───────→ history_projections
                                      │
                                      ▼
                                 P3.3 Selector
```

- Canonical history remains **the sole history authority** (`persistence.ts` only).
- Projection = **durable but derived** cache.
- Producer's only write is `buildProjection` → **`history_projections` only** (verified:
  no `INSERT`/`UPDATE`/`DELETE` verbs in the module; the only call is `buildProjection`).
- Selector remains read-only (unchanged from P3.3).
- **No projection→history write path exists** (P3.4-15/16 tests; code inspection).

**PASS.**

---

## 6. Schema / Identity

Row fields (unchanged P2.7 schema): `session_id`, `thread_id`, `projection_id="summary"`,
`base_seq`, `summary_text`, `included_ranges`, `built_at`, `anchor_event_id`.

| Field | Type | Semantics |
| --- | --- | --- |
| `session_id`, `thread_id` | authoritative reference | scope (PK part) |
| `base_seq` | derived | exclusive coverage end of `[0, base_seq)` |
| `anchor_event_id` | derived reference | identity of boundary row `seq = base_seq-1` |
| `included_ranges` | derived | `[[0, base_seq]]` |
| `summary_text` | derived copy | kernel fold render of the covered prefix |
| `built_at` | derived | timestamp (not a coverage claim) |
| `headSeq`/`revision`/`historyCommit` | **not in the row** | derived by P3.2/readers from canonical rows |

The projection **does not carry** headSeq/revision/historyCommit — those are recomputed by
the selector/P3.2 from the current canonical rows at consumption time Lines this is
consistent: the row records coverage + anchor; freshness/identity of the tail is derived
fresh on read.

---

## 7. PARTIAL + STALE Semantics (the critical question)

The audit's central question: is "PARTIAL + STALE-but-consumable" genuinely correct and
consistent across P3.0, P2.8, P3.3, P3.4?

**`getProjectionStatus` distinguishes two STALE sub-cases** (verified in source):

| Rule | Condition | Meaning | Trust |
| --- | --- | --- | --- |
| 7 | `messages[base_seq-1].event_id !== anchor_event_id` | boundary identity changed/gone | **trust-destroying** — the summary's covered prefix no longer matches canonical |
| 8 | `head >= base_seq` (anchor intact) | head advanced beyond coverage | **partial coverage** — the covered prefix `[0, base_seq)` is still intact |

**The report's claim is that the consumed STALE is rule-8 (coverage-valid).** Verified:

- **P3.0 D6** (ratified): readers should accept **coverage-valid** projections, not only
  CURRENT. A rule-8 STALE (intact anchor + head advanced) is exactly "coverage-valid".
- **P2.8 CURRENT-only**: `assembleContext` uses only CURRENT (full coverage). The P3.4
  producer's partial rows are STALE under P2.8 — so P2.8 **ignores them** (fallback full
  history). This is preserved and tested.
- **P3.3 selector**: `selectContext` consumes whatever `projection` it is given (no
  CURRENT gate); it builds `summary + tail[base_seq, head]` and computes its own
  `freshness` vs the canonical frontier. It does not bypass freshness (the label is
  carried; publication stays in P2.7).
- **P3.4 producer**: emits partial coverage by construction (`keepRecentTurns >= 1` tail).

**Answer:** the four layers are **mutually coherent**:
- "STALE" in `getProjectionStatus` rule 8 = **partial coverage** (valid as a derived
  summary source), **not** "unusable".
- "STALE" in rule 7 = **invalid coverage** — but **unreachable** on the automatic path
  (any rewrite deletes all thread projections in the same txn; `saveSession` is
  append-only; legacy backfill touches only NULL event_ids).
- Therefore the consumed-STALE set is effectively rule-8-only in production → coherent.

**Finding N1 (non-blocking):** `readConsumableSummaryProjection` accepts **any** STALE
(not just rule-8). The reader does not re-verify the anchor after the status check.
Verified empirically: forging the boundary row's `event_id` still returns the projection as
consumable. On the automatic path this is unreachable (shrink deletes projections), so no
live violation — but the reader should defensively reject rule-7 STALE, and the report's
"STALE-with-intact-anchor" wording overstates the code's precision.

---

## 8. Freshness Model

| Conceptual state | Can consume? | Evidence |
| --- | --- | --- |
| projection CURRENT (full coverage) | YES | P2.8/selector; `getProjectionStatus` CURRENT |
| projection STALE, rule-8 (partial, anchor intact) | YES (coverage-valid, P3.0 D6) | P3.4-9; live resume |
| projection STALE, rule-7 (anchor broken) | YES in code (should be NO) | empirical forgery test — **N1** |
| projection CORRUPT / INCOMPLETE / UNKNOWN / absent | NO (fallback canonical) | `readConsumableSummaryProjection` returns null; P3.4-14 |
| projection DIVERGED | n/a (no such row state) | — |

P3.3 selector behavior matches: `selectContext` labels `freshness` from P3.2 and uses
`fallback-unknown` for DIVERGED/UNKNOWN/STALE row sets, without treating a partial summary
as canonical truth.

**PASS (with N1).**

---

## 9. Producer Trigger

Verified in `cli/setup.ts`:

- **Produce:** `persistCurrent` — only after the canonical write branch succeeded
  (`saveSession` append or explicit shrink), before journal finalize. Best-effort
  (`try/catch` → warn). Default `keepRecentTurns = session option ?? 2`.
- **Consume:** resume seam — `readConsumableSummaryProjection` preferred, P2.8 fallback.

Checks:

- **Which writes generate:** any successful `persistCurrent` with a foldable prefix.
- **Every required lifecycle path:** the two seams cover the normal flow. A session that
  never persists produces nothing (correct).
- **Duplicate generation:** `buildProjection` replaces the single row (delete+insert) —
  no accumulation (P3.4-2).
- **Missing generation:** leaves a missing/stale row → recoverable (P3.4-10/14); resume
  falls back to canonical or P2.8.
- **Resume rebuild when missing:** the resume seam only **reads**; rebuild happens on the
  next `persistCurrent` (or the producer can be called directly). Deterministic recovery.

---

## 10. Idempotence

Same canonical rows + same policy ⇒ same `{summaryText, baseSeq}` (`mechanicalCompaction`
is deterministic; `deriveSummaryFromCanonical` is pure). Repeated `produceSummaryProjection`
replaces the one row with a semantically-equivalent row (P3.4-2). No duplicate projections,
no canonical events created, no writer-epoch changes beyond the fence check. **PASS.**

---

## 11. Atomicity / Failure Safety

- `buildProjection` wraps `DELETE` + `INSERT` in one `db.transaction` with
  `assertWriterEpochInTxn`.
- Wrong epoch → `StaleWriterError` thrown; canonical untouched (P3.4-12; fingerprint
  verified).
- Producer failure is caught at the seam → canonical already committed; projection may be
  missing/stale. **No canonical mutation on projection failure. PASS.**

---

## 12. Recovery

Delete/miss the projection row → canonical intact (P3.4-14 fingerprint) → re-run producer
→ row restored. Deterministic (canonical rows are the only input). **PASS.**

---

## 13. P3.3 Integration

- `readConsumableSummaryProjection` → `projectionSummary` → `selectContext` (resume seam,
  `cli/setup.ts:930-935`).
- Selector does **not** build or persist projections; it consumes the given `projection`.
- Selector does not bypass freshness: its `freshness` is P3.2-computed vs
  `canonicalFrontier`; publication decision stays in P2.7.

**PASS.**

---

## 14. Summary-plus-tail Proof (independently re-verified)

Live on committed code (`createCliSession` + real `persistCurrent` + real `saveSession`):

1. Seed 8 turns → resume 1: `[select … basis=full-history …]`.
2. `persistCurrent` → `[projection sid=e2e base=12 status=produced]`.
3. DB row exists: `base_seq=12, included_ranges="[[0,12]]", anchor_event_id=…`, status
   `STALE` (rule 8).
4. Resume 2: `[select … basis=summary-plus-tail freshness=fresh head=15]`; history = 5
   messages; first = `Previous context [0,12):\n…`.

**PROVEN** (not unit-test-only).

---

## 15. Full-Coverage Limitation

`mechanicalCompaction` always retains a tail (`keepRecentTurns >= 1`), so the producer can
only emit **partial** coverage (`base_seq < head+1`). A CURRENT (full-coverage) projection
requires folding the **entire** history — which the kernel primitive does not expose.

- **Classification:** **EXPECTED BY DESIGN** (documented P3.4 limitation) with a genuine
  **P3.7 dependency** for the full-history fold renderer. Not a bug; not a P3.5 dependency.
- Impact: the selector uses `summary + tail` (partial) — which is precisely the intended
  P3.4 outcome. A full-coverage summary-only view is the P3.7 seam.

---

## 16. P3.5 Boundary

The producer does **not** implement: runtime revision bridge, `ModelContextProvenance`
runtime bridge, headless `context.compacted` bridge. Grep: no `revision`, no
`ModelContextProvenance`, no `ContextStore` mutation, no runtime `append` in
`context-projection.ts` (only the kernel `mechanicalCompaction` fold over a temporary
`ContextStore`). **PRESERVED.**

---

## 17. P3.7 Boundary

The producer uses the **existing** kernel `mechanicalCompaction` renderer over the covered
prefix — a reuse of current infrastructure, **not** an A+C fold engine, no LLM/embedding/
network, no new fold algorithm. **PRESERVED.**

---

## 18. Provenance

Provenance chain `canonical → projection → selector → context`:

- Row: `base_seq` (coverage) + `anchor_event_id` (boundary identity) + `included_ranges` +
  `built_at`.
- Selector: `frontier` (baseSeq/headSeq/anchor/historyCommit/revision) + `selectionBasis`
  recomputed from current canonical rows at read time.
- The projection itself is *reference-bound* to canonical identity; the tail is
  canonical-verbatim; the summary is a derived copy of a fold render.

Answer to "which canonical history produced this context": the row's `anchor_event_id` +
`base_seq` + the canonical rows at consumption time. **PASS.**

---

## 19. Identity Isolation

| Negative case | Test / verification |
| --- | --- |
| thread A → thread B | P3.4-5 (`th_lain` has no row); selector `compareContextFrontier` = DIVERGED cross-thread |
| session A → session B | P3.4-4 (`sB` has no row; reader returns null) |
| stale projection matches another history | PK scoping + anchor validation prevent cross-match |
| same thread, different revision | `getProjectionStatus` re-validates anchor/head; revision is not stored in the row (derived at read) |

**PASS.**

---

## 20. Mutation Evidence

Implementation-run probes (re-verified from committed hash):

| Probe | Mutation | Result |
| --- | --- | --- |
| P2 | force `baseSeq = 1` (coverage off) | 1 fail (P3.4-6) |
| P3 | `readConsumableSummaryProjection → null` | 3 fail (P3.4-9/14/18) |
| P4 | empty guard off | 1 fail (P3.4-13) |
| P1 | hardcode `threadId` | not load-bearing (noted) |

The working-tree producer hash `ABF6CE81…` equals the committed blob; tree is clean; the
tests are load-bearing on the current implementation toward the milestone core (P3.4-18
guards the production path). **PASS.**

---

## 21. Test Graph

| Test | Path |
| --- | --- |
| P3.4-1/2/3/4/5/6/8/9/10/11/12/13/14/15/16/18 | **REAL PRODUCTION PATH** (real `produceSummaryProjection` → real `buildProjection` → real SQLite; -18 is the full production path proof) |
| P3.4-7/17 | PURE FUNCTION (`deriveSummaryFromCanonical`) |

No TEST-ONLY/structural-only claims support the milestone proof. The production claim is
additionally backed by the live e2e (§14), not only the test. **PASS.**

---

## 22. Validation

| Target | Result |
| --- | --- |
| P3.4 producer | 18/18 pass (re-run) |
| projection substrate (`projection-foundation`, `p2-history-projection`) | pass |
| P3.3 selector + resume | pass |
| P3.2 context-identity | pass |
| P3.1 guard | 14/14 pass |
| P2.7 persistence | pass |
| P2 architecture guards | 50/50 pass |
| writer-inventory | pass |
| architecture-map | 2/2 pass |
| broad batch (13 files, 208) | 208/208 pass |
| typecheck | 28 errors, 0 new (all `test/phase3*`/`phase4*`) |
| **full suite** | **4408 pass / 23 skip / 8 fail** (299 files / 4439 tests) |

Full-suite failures (8) — classified: `audit-manifes-korup`, `P2.1 ×2`, `P2.2 ×2` =
**FLAKY** (green in isolation 34/34); `P3-constructor (m15)`, `S13`, `web-ssg` =
**PRE-EXISTING/ENV**. **No P3.4 regression.**

---

## 23. Report/Code Drift

| Report claim | Actual | Class |
| --- | --- | --- |
| production producer exists | true | CURRENTLY TRUE |
| existing substrate reused | true (`buildProjection`, schema unchanged) | CURRENTLY TRUE |
| projection derived-only | true | CURRENTLY TRUE |
| summary-plus-tail production path | proven live | CURRENTLY TRUE |
| P3.3 integration complete | true | CURRENTLY TRUE |
| P3.1/P2.7 boundary preserved | true (`persistence.ts` untouched) | CURRENTLY TRUE |
| no second authority | true | CURRENTLY TRUE |
| mutation evidence | true (P2/P3/P4 load-bearing) | CURRENTLY TRUE |
| limitation 1 (partial-only; full = P3.7) | true | CURRENTLY TRUE |
| limitation 2 (trigger seam) | true | CURRENTLY TRUE |
| limitation 3 (headless revision = P3.5) | true | CURRENTLY TRUE |
| **limitation 4 ("STALE-with-intact-anchor")** | **PARTIAL** — code accepts ANY STALE (rule-7 included) | **PARTIAL (N1)** |
| limitation 5 (no ranking) | true | CURRENTLY TRUE |

---

## 24. Authority Table

| Component | Reads | Writes | Durable | Authority |
| --- | --- | --- | --- | --- |
| Canonical history (`messages`) | via `persistence.ts` | `persistence.ts` only | yes | **AUTHORITATIVE (single)** |
| P2.7 / `saveSession` | canonical rows | `messages` (append/explicit shrink) | yes | **CANONICAL DECIDER** |
| P3.2 (`context-identity`) | rows (passed in) | none | no | DERIVED (descriptive) |
| P3.3 selector | rows + projection | none | no | DERIVED (view) |
| P3.4 producer | canonical rows | **`history_projections` only** | yes | DERIVED (cache writer) |
| `history_projections` | — | via producer/build/shrink/delete | yes | DURABLE-BUT-DERIVED |
| Runtime context | ContextSelection | in-RAM | no | EPHEMERAL/DERIVED |

**Exactly one canonical history authority; projection is derived; no second authority.**

---

## 25. Closure Criteria

| Criterion | Status |
| --- | --- |
| production producer exists | SATISFIED |
| existing projection substrate reused | SATISFIED |
| canonical source preserved | SATISFIED |
| projection remains derived | SATISFIED |
| identity scoped | SATISFIED |
| freshness semantics coherent | SATISFIED |
| PARTIAL/STALE semantics coherent | SATISFIED (with N1 robustness gap) |
| provenance preserved | SATISFIED |
| deterministic | SATISFIED |
| rebuild/recovery works | SATISFIED |
| projection failure cannot corrupt canonical history | SATISFIED |
| P3.3 consumes production projection | SATISFIED |
| summary-plus-tail production path proven | SATISFIED |
| P3.5 boundary preserved | SATISFIED |
| P3.7 boundary preserved | SATISFIED |
| no second authority | SATISFIED |
| mutation evidence current | SATISFIED |
| test reachability valid | SATISFIED |
| full validation classified | SATISFIED |

No safety-critical item fails.

---

## 26. Final Verdict

**VALID WITH CONDITIONS.** P3.4 is genuinely implemented, production-real, authority-safe,
and semantically coherent. The condition is N1: the consumable reader accepts the
trust-destroying rule-7 STALE sub-case (unreachable today, but should be defensively
rejected), and the report's limitation-4 wording should match the actual (looser) behavior.
This is a robustness/observability matter, not a safety violation — it does not reopen P3.4.

---

## 27. Exact Next Action

**One action:** harden `readConsumableSummaryProjection` to reject the rule-7 STALE
sub-case (anchor-broken) — or, at minimum, correct the report's limitation-4 wording to
describe the actual accept-any-STALE behavior — as a small follow-up before P3.5.

(No implementation, commit, or push was performed in this audit.)

---

```text
MINICODE P3.4 CURRENT CANONICAL STATUS:
VALID WITH CONDITIONS

Production producer:
PASS

Projection substrate:
PRESERVED

Canonical authority:
PASS

Projection authority:
DERIVED

Identity:
PASS

Freshness:
PASS

PARTIAL + STALE semantics:
COHERENT

Provenance:
PASS

Determinism:
PASS

Idempotence:
PASS

Atomicity:
PASS

Recovery:
PASS

P3.3 integration:
PASS

Summary-plus-tail:
PROVEN

P3.5 boundary:
PRESERVED

P3.7 boundary:
PRESERVED

Second authority:
NO

Mutation/non-vacuity:
PASS

Test reachability:
PASS

Full suite:
CLASSIFIED_FAILURES

Blocking findings:
NONE

Non-blocking findings:
N1. [RESOLVED by hardening — see P3_4_N1_HARDENING_REPORT.md] The original audit found that readConsumableSummaryProjection accepted ANY STALE state (rule-7 anchor-broken included) while the report claimed "STALE-with-intact-anchor". The hardening now rejects STALE unless the status detail is rule-8 ("head advanced beyond coverage"): rule-7 (anchor-broken) is rejected, rule-8 (anchor-intact partial) remains consumable, and the production summary-plus-tail path is unaffected (re-verified live). Rule-7 remains unreachable on the automatic path (shrink deletes all thread projections in the same txn; saveSession is append-only; legacy backfill touches only NULL event_ids) — the rejection is a defensive guard against a forged/corrupt projection.

Recommended next action:
N1 is resolved; proceed toward P3.5 when the owner authorizes it. (No P3.5 work has been started.)

P3.5:
NOT STARTED

P3.7:
NOT STARTED

CONFIDENCE:
HIGH
```