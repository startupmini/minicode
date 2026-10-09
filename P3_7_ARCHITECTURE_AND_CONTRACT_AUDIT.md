# P3.7 — A+C Fold Producer / Advanced Fold: Architecture & Contract Audit

Read-only audit. No source/test/roadmap/config modification; no git mutation; working
tree preserved. Current canonical code is authoritative; historical reports are evidence
only. P3.7 was NOT implemented.

---

## 1. Executive Summary

**P3.7 is READY TO IMPLEMENT, with one bounded contract decision to ratify** (the full-
coverage content policy: what a full-history fold must preserve vs omit). Every other
readiness condition is satisfied by current canonical evidence:

- **A+C is unambiguous.** `P3_0` §9 defines it: **A** = context-only transformation,
  **C** = separately-stored derived summary (coverage record = the existing
  `history_projections` row), **B** (canonical-history rewrite) = NON-CONFORMING.
- **The P3.4 limitation is structural and proven.** The only deterministic fold renderer
  (`mechanicalCompaction`, `vendor/minicore/src/core/compact.ts:22-53`) always retains a
  tail (`kept >= 1`; `kept >= messages.length` → no-op). It can therefore never emit a
  `base_seq == head+1` (full-coverage) projection, which is the only state P2.7's
  `getProjectionStatus` classifies CURRENT (rule 9, `persistence.ts:2932`). P3.4 produces
  only rule-8 STALE (partial) rows — consumable by the P3.3 selector as
  `summary-plus-tail`, but never CURRENT.
- **No new schema, store, or authority is needed.** The `history_projections` row
  (`session_id, thread_id, projection_id, base_seq, summary_text, included_ranges,
  built_at, anchor_event_id`) already represents full coverage (`included_ranges =
  [[0, N]]`, `base_seq = N = head+1`); `buildProjection`/`rebuildProjection` already
  enforce epoch fencing and idempotent replace semantics; `readConsumableSummaryProjection`
  (with the N1 rule-7 rejection) already gates consumption; P3.3 already consumes a
  CURRENT projection as `summary-plus-tail`.
- **Single-producer ownership is definable.** P3.7 should supply an advanced fold
  **renderer** consumed by the **existing** P3.4 producer/persistence path — not a second
  producer. One write path (`buildProjectionInTxn`) remains.
- **The one open decision:** the full-coverage content policy — what the fold must
  preserve (exact paths, signatures, tool results, errors, next steps per the existing
  LLM-fold prompt contract at `src/policy/compaction.ts:327`) vs what it may omit (the
  mechanical renderer's `<result omitted>` + 400/200/80-char truncation precedent at
  `compact.ts:56-75`), and whether the deterministic renderer stays LLM-free (recommended:
  yes, to preserve P3.3-grade determinism guarantees).

**Verdict: READY WITH CONDITIONS** (the condition = ratify the content policy; everything
else is defined).

---

## 2. Canonical Baseline

| Fact | Value |
| --- | --- |
| Root | `D:/git/minicode` |
| Branch | `main` |
| HEAD | `542043701de646903a051b4df77f9998e43c05ed` |
| `origin/main` | `542043701de646903a051b4df77f9998e43c05ed` |
| Working tree | CLEAN (at audit time; this report is the only new untracked file) |
| Remote | `https://github.com/startupmini/minicode.git` |
| P3.5 audit checkpoint | `5420437` (`docs: record P3.5 canonical truth audit`) |

---

## 3. Current P3.7 Roadmap Contract

`P3_ROADMAP.md` §3 (ratified, current authority):

- **P3.7 — A+C Fold Producer / advanced fold.** Responsibilities: advanced A+C
  fold-generation semantics (produce the summary/fold representation), the richer fold
  algorithm and its durable marker bridge.
- **Boundary vs P3.4:** P3.4 builds/persists the projection *representation* required by
  the existing contract; it must NOT absorb the complete advanced fold-generation
  algorithm — that is P3.7.
- **Numbering note:** the historical forensic roadmap's **P3.7 = Branch/Fork** usage is
  **superseded**; Branch/Fork remains unfiled (hooks reserved in `P3_0` §5/§7).
- P3.5 items (revision/provenance bridge) and P3.4 (producer lifecycle) are NOT P3.7.

---

## 4. Existing Fold/Projection Inventory

| Component | Class | Evidence |
| --- | --- | --- |
| Canonical source history (`messages`) | PRODUCTION | `src/session/persistence.ts` |
| `mechanicalCompaction` (deterministic fold renderer) | PRODUCTION | `vendor/minicore/src/core/compact.ts:22` |
| `compactLine` (per-role renderer, unexported) | PRODUCTION | `compact.ts:56` |
| `createLlmCompaction` / `compactWithLlm` (model fold path) | PRODUCTION | `src/policy/compaction.ts:42,225`; wired `cli/setup.ts:1311` |
| `composeBoundedSummary` (bounded summary composer) | PRODUCTION | `src/policy/compaction.ts:188` |
| `history_projections` schema | PRODUCTION | `persistence.ts:279` |
| `buildProjection` / `rebuildProjection` (epoch-fenced) | PRODUCTION | `persistence.ts:3012,3044` |
| `getProjectionStatus` (9-rule classifier) | PRODUCTION | `persistence.ts:2879` |
| P3.4 producer (`deriveSummaryFromCanonical` + lifecycle) | PRODUCTION | `src/session/context-projection.ts` |
| `readConsumableSummaryProjection` (CURRENT + rule-8 only) | PRODUCTION | `context-projection.ts:180` |
| P3.3 selector `summary-plus-tail` | PRODUCTION | `context-selector.ts:356` |
| P2.8 `assembleContext` (CURRENT-only) | PRODUCTION | `context-assembly.ts:153` |
| P3.5 durable bridge (`appendPresentationEvents`) | PRODUCTION | `context-adapter.ts:162` |
| Full-coverage deterministic renderer | ABSENT | verified (§6) — the gap |
| A+C fold engine (generalized) | CONTRACT only | `P3_0` §9; not built |

---

## 5. A+C Semantic Definition (from canonical evidence)

From `P3_0` §9 (current contract, not historical):

- **Consumes:** the covered canonical prefix `[0, base_seq)` — full history for P3.7's
  full-coverage case (`[0, head+1)`).
- **Preserves:** recoverability — the prefix stays readable in `messages`, so the fold
  is rebuildable at any time (§9: "prefix tetap dapat dibaca ⇒ ringkasan dapat dibangun
  ulang kapan pun").
- **Summarizes:** the covered prefix into a labeled derived summary (`Previous
  context:` convention).
- **Complete-history coverage is demonstrated by:** `base_seq == head+1` with
  `included_ranges == [[0, base_seq]]` and a matching `anchor_event_id` → P2.7 rule 9
  CURRENT ("coverage matches head, anchor holds").
- **Continuity/anchor properties:** `anchor_event_id` must equal the boundary row's
  `event_id` (`seq = base_seq - 1`); rule 7 otherwise (rejected by N1 hardening).
- **May omit:** per the existing mechanical precedent — non-error tool result bodies
  (`<result omitted>`) and text beyond truncation caps (400/200/80). The exact P3.7
  policy is the one ratification decision (§20).
- **Must remain reconstructable:** provenance (model identity, time, coverage,
  "derived summary" label) + the intact canonical prefix itself.
- **Deterministic:** recommended (see §11) — required for the idempotent-replace and
  no-duplicate-marker guarantees.
- **Output persisted:** the existing `history_projections` row (no new schema).
- **Durable marker required:** `context.compacted` via the existing
  `appendPresentationEvents` channel (P3.5 bridge), per compaction event.

**No ambiguity remains in what A+C *means*; the only open question is the content
policy** (preserve-vs-omit thresholds), which is a bounded product decision, not a
semantic gap.

---

## 6. P3.4 Limitation Analysis (proven)

Claim (P3.4 report limitation 1): `mechanicalCompaction` retains a tail, so produced
projections are PARTIAL, never full-coverage. **Verified true by direct source
inspection:**

- `compact.ts:27-32` counts user turns from the end; `kept >= 1` always (there is at
  least one message whenever input is non-empty).
- `compact.ts:35-45` only *extends* the kept region (tool-pair safety); never shrinks it.
- `compact.ts:46`: `if (kept >= messages.length) return messages` — small histories
  produce NO fold at all.
- Therefore every emitted fold has shape `[summary, ...tail>=1]`, i.e. `base_seq =
  total - kept <= head`, i.e. **rule-8 STALE forever** under `getProjectionStatus`
  rule 8 (`persistence.ts:2931`).
- A CURRENT row requires `base_seq == head+1` (rule 9), which this renderer cannot emit.

Coverage fields: `base_seq` (exclusive coverage end), `head_seq` (canonical head),
`included_ranges` (`[[0, base_seq]]`), `anchor_event_id` (boundary identity). The P3.3
selector needs `base_seq == head+1` + intact anchor for a CURRENT `summary-plus-tail`
without tail. P2.7 requires the same for CURRENT. **The limitation genuinely belongs to
P3.7** (a full-coverage renderer is exactly the missing piece; P3.5's revision/provenance
work and P3.4's lifecycle do not address it).

---

## 7. Full-Coverage Output Contract

Reuses the existing `history_projections` row — no new fields:

| Field | Source | Meaning | Authority | Durability | Consumer | Validation rule |
| --- | --- | --- | --- | --- | --- | --- |
| `session_id` / `thread_id` | caller | scope | reference | durable | selector, assembly | PK scope |
| `projection_id` (`"summary"`) | constant | vocabulary | fixed | durable | all readers | allowlist |
| `base_seq` (= head+1) | fold output | exclusive coverage end | derived | durable | status machine | `base_seq == parsed.end`; `<= head+1` |
| `summary_text` | fold renderer | full-history summary | derived | durable | selector/assembly | non-empty; scrubbed |
| `included_ranges` (`[[0, base_seq]]`) | fold output | canonical coverage | derived | durable | status machine | strict canonical form |
| `anchor_event_id` | boundary row | coverage identity | reference | durable | status machine | must equal row's event_id |
| `built_at` | P2.7 primitive | build time (not coverage) | derived | durable | diagnostics | — |
| `historyCommit`-equivalence | recomputed | content binding | derived | ephemeral | P3.2/P3.3 | commit over covered rows |
| revision | durable markers | compaction epoch | derived | via events | P3.2/P3.5 | `countDurableCompactions` |
| generation metadata | fold call | when/why built | derived | in `detail`/logs | diagnostics | explicit |

---

## 8. Full-Coverage Semantics

Using the existing P2.7 machine (rules cited from `persistence.ts:2879-2933`):

- **FULL HISTORY REPRESENTED:** `base_seq == head+1` + intact anchor → CURRENT (rule 9);
  consumable by P2.8 and P3.3 as `summary-plus-tail` with empty tail.
- **PARTIAL HISTORY REPRESENTED:** `base_seq <= head` + intact anchor → STALE rule-8;
  consumable by P3.3 as `summary-plus-tail` (P3.0 §8 D6), ignored by P2.8.
- **STALE WITH INTACT ANCHOR (rule-8):** consumable as partial derived source.
- **STALE WITH BROKEN ANCHOR (rule-7):** NOT consumable (N1 hardening).
- **DIVERGED:** P3.2-level (frontier mismatch) → `fallback-unknown`, explicit label.
- **UNKNOWN:** no row / thread missing / corrupt → fallback canonical, explicit label.

A genuinely full-history fold produces CURRENT; consumers verify via the unchanged
`getProjectionStatus` + anchor check. No STALE state is made equivalent.

---

## 9. Fold Algorithm Boundary

| Concern | Owner |
| --- | --- |
| fold content generation (full-coverage renderer) | **P3.7 (new, pure)** |
| projection record construction | P3.4 (`buildProjectionInTxn` — reuse) |
| projection persistence | P3.4 path (`buildProjection`, epoch-fenced — reuse) |
| projection consumption | P2.8 / P3.3 (unchanged) |
| runtime context adaptation | P3.5 (unchanged) |
| canonical publication | P3.1 / P2.7 (unchanged) |

P3.7 owns **only** the renderer: a pure function `canonical rows → { summaryText,
baseSeq = rows.length }` (plus the content policy). It must NOT reimplement
persistence, status classification, selection, bridging, or publication. No generalized
compaction engine is required — the kernel loop keeps its own trigger/throttle logic.

---

## 10. Single Producer Authority

Recommended (option 1 of the audit's candidates): **P3.7 provides an advanced fold
renderer consumed by the existing P3.4 producer** — i.e., P3.4's
`deriveSummaryFromCanonical` gains a fold-strategy seam (mechanical renderer today,
advanced renderer for full coverage), while `buildProjectionInTxn` remains the **single**
write path for `history_projections` rows. No second producer, no competing writers:

| Artifact | Owner |
| --- | --- |
| fold content | P3.7 renderer (pure) |
| projection record | P3.4 `buildProjectionInTxn` (existing) |
| projection persistence | P3.4 path (existing, epoch-fenced) |
| projection invalidation | P2.7 status machine (existing) |
| durable fold marker | existing `appendPresentationEvents` channel (P3.5 bridge) |

---

## 11. Durable Marker Bridge

Order: fold requested → fold generated (pure) → projection persisted
(`buildProjection`, epoch-fenced) → durable `context.compacted` emitted via the existing
P3.5 bridge → selector may consume. Failure cases:

- Fold succeeds, persistence fails → projection absent/stale; canonical untouched;
  SURFACE ERROR; retry safe (idempotent replace).
- Projection persists, marker fails → projection present but revision stale;
  RECONCILE by re-emitting the marker (idempotent dedup); never fabricate revision.
- Marker emitted twice → dedup via identical payload (`duplicates`, safe).
- Marker seq collides (different payload) → keep-existing + explicit warn (existing).
- Source changes during fold → re-derive from fresh rows; anchor validation at persist
  (P2.7) rejects mismatched coverage; RETRY SAFELY.
- Stale writer attempts fold → epoch fence refuses (`ProjectionValidationError`/
  `StaleWriterError`); REFUSE.
- Partial output when full coverage required → REFUSE full-history claim (emit partial
  only if the policy allows, else fail explicit).
- Concurrent folds → last-writer-wins on the single row is safe (deterministic content
  makes them equivalent); no second row possible (PK replace).

The operation is complete only when projection row + marker are both durable; otherwise
explicit recovery as above. No second marker system.

---

## 12. Epoch/Writer Fencing

- Fold-request owner: the composition root holding the session's writer epoch (same as
  P3.4's `expectedEpoch` threading).
- Epoch travels with the request into `buildProjection`'s fence
  (`assertWriterEpochInTxn`, `persistence.ts:3025`); a fold outliving its run fails the
  fence → REFUSE.
- A stale fold cannot overwrite a newer projection silently: same-txn epoch check +
  deterministic content (identical inputs → identical rows) make races benign.
- Duplicate fold requests: idempotent replace, safe.
- `appendPresentationEvents` validates epoch where the caller holds one (P3.5 bridge);
  the marker path inherits the same fencing.
- **No new writer-epoch semantics are needed.** The existing fence is sufficient —
  provided P3.7 threads the epoch through (as P3.4 already does). Not a blocker.

---

## 13. Determinism/Idempotency

Contract: same canonical history + same fold policy = same fold output.
Ordering: canonical `seq` order (already the convention). Summary text: deterministic
renderer required (LLM path excluded from the deterministic contract; the existing
`createLlmCompaction` remains a runtime-only strategy, not the projection renderer).
Repeated fold → same `{summaryText, baseSeq}` → idempotent row replace (`built_at`
differs; not a coverage claim). Duplicate markers → dedup. Retry after partial failure →
safe re-run. Source changes → anchor/head checks detect (rule 7/8).

---

## 14. Provenance/Recovery

The fold result proves: session/thread (row scope), covered `[0, base_seq)` + anchor,
revision at build, completeness (`base_seq == head+1` at build time), staleness via the
unchanged status machine, rebuildability from intact canonical prefix. Deleting a
projection never touches canonical history (separate table; tested pattern). Invalid
folds are rejected by `buildProjectionInTxn` validation / `getProjectionStatus`, and
regenerated from canonical. No separate provenance store (row + durable events suffice).

---

## 15. P3.3 Integration

Expected selector behavior (unchanged code):

- no projection → `full-history` / `budget-tail` / `fallback-unknown`.
- valid partial projection → `summary-plus-tail` (rule-8, coverage-valid).
- **valid full-history fold → `summary-plus-tail` with empty tail** (CURRENT; the newly
  enabled case).
- rule-7 STALE → rejected (N1) → fallback, explicit label.
- rule-8 STALE → `summary-plus-tail`, explicit label.
- DIVERGED / UNKNOWN → `fallback-unknown`, explicit label.

The selector is not redesigned, generates nothing, persists nothing.

---

## 16. Failure Semantics

| Case | Behavior |
| --- | --- |
| Empty history | REFUSE (no foldable content; cf. P3.4-13) |
| Insufficient source | REFUSE or PARTIAL per policy (explicit) |
| Malformed source event | REFUSE (fail-closed; cf. P3.2 corrupt handling) |
| Source changes during fold | REBUILD from fresh rows / RETRY SAFELY |
| Stale writer | REFUSE (epoch fence) |
| Missing/invalid anchor | REFUSE (P2.7 validation) |
| Incomplete coverage (when full required) | REFUSE full-history claim |
| Fold-generation failure | SURFACE ERROR; canonical untouched |
| Projection-persistence failure | SURFACE ERROR; retry safe |
| Durable-marker failure | SURFACE ERROR; reconcile marker only |
| Duplicate request | idempotent (dedup/replace) |
| Rebuild | from canonical; deterministic |
| Resume after failed fold | fallback canonical + explicit label |
| Concurrent folds | benign (single row, deterministic content) |

No blind retries; no canonical mutation on derived-path failure.

---

## 17. P3.4 / P3.5 Boundary

| Concern | P3.4 | P3.5 | P3.7 | Why |
| --- | --- | --- | --- | --- |
| Projection schema | Existing owner | None | Reuse | schema unchanged |
| Projection lifecycle | Existing owner | None | Integrate | single write path |
| Advanced fold content | None | None | **Own** | the missing renderer |
| Projection persistence | Existing producer path | None | Reuse | epoch-fenced path exists |
| Runtime metadata | None | Own | Consume existing contract | P3.5 closed |
| Durable event primitive | Existing primitives | Existing bridge | Reuse | no second marker system |
| Full-coverage semantics | Consume representation | Preserve metadata | Produce/verify | the gap |
| Canonical publication | P3.1/P2.7 | Preserve boundary | Preserve boundary | single funnel |

No roadmap/implementation conflict found; the three milestones compose without overlap.

---

## 18. Write Graph / Authority

Proposed (validated against current code):

```
Canonical History (messages)
   │ read-only
   ├─► P3.4 Projection Producer ──► history_projections (existing path)
   │         ▲
   │         │ fold content (pure renderer)
   │    P3.7 Advanced Fold ──► existing durable marker primitive
   ▼
P3.3 Selector ──► ContextSelection ──► ContextStore (P3.5 carries metadata)
```

Preserved: canonical history = sole history authority; projection cache = durable but
derived; selector = read-only; fold renderer = pure/derived; P3.1/P2.7 = publication
safety. No second projection writer (one `buildProjectionInTxn` path), no second marker
store.

---

## 19. Risk Matrix

| ID | Risk | Classification | Evidence |
| --- | --- | --- | --- |
| R1 | A+C semantics ambiguous | NOT PRESENT | `P3_0` §9 defines A/C/B explicitly |
| R2 | incomplete fold claims full coverage | POSSIBLE | must enforce `base_seq == head+1` + intact anchor; test contract covers |
| R3 | summary untraceable | POSSIBLE | enforce provenance fields + anchor; test contract covers |
| R4 | fold uses untrusted runtime buffer | POSSIBLE | require canonical-rows source (as P3.4 does) |
| R5 | fold races append/shrink | POSSIBLE | epoch fence + anchor validation at persist; retry-safe |
| R6 | stale fold overwrites newer projection | NOT PRESENT | deterministic content makes same-input rows equivalent; epoch fence |
| R7 | fold/marker disagree after partial failure | POSSIBLE | reconcile-marker-only recovery defined |
| R8 | duplicate markers inflate revision | NOT PRESENT | existing dedup (`duplicates`); tested pattern |
| R9 | second producer authority | NOT PRESENT | renderer-consumed-by-existing-producer design |
| R10 | second marker system | NOT PRESENT | reuse mandated |
| R11 | selector trusts invalid fold | NOT PRESENT | N1 rule-7 rejection + CURRENT/anchor checks |
| R12 | full-history bypasses P2.7 contract | NOT PRESENT | same `buildProjection` validation path |
| R13 | absorbs revision/provenance ownership | NOT PRESENT | P3.5 owns transport; P3.7 only renders |
| R14 | absorbs semantic ranking | NOT PRESENT | explicitly out of scope |
| R15 | recovery depends on projection | NOT PRESENT | canonical-first recovery (fallback + rebuild) |
| R16 | epoch fencing insufficient | NOT PRESENT | existing fence sufficient if threaded (as P3.4 does) |

---

## 20. Minimal Implementation Plan

- **Primary problem:** no deterministic full-coverage fold renderer exists.
- **A+C contract:** §5 (unambiguous; content policy is the one ratification item).
- **Reuse:** `mechanicalCompaction` line-rendering *conventions* (not its tail-keeping
  algorithm), `compactLine`-style per-role rendering, `scrubSecrets`
  (`src/policy/compaction.ts:8`), `composeBoundedSummary` budget discipline, kernel
  `ContextStore` as scratch (never canonical), `buildProjection`/`rebuildProjection`,
  `getProjectionStatus`, `readConsumableSummaryProjection`, P3.5 bridge.
- **New pure renderer required:** yes — one function `canonical rows →
  { summaryText, baseSeq = rows.length }` (full coverage), LLM-free (recommended).
- **Integration point:** P3.4 `deriveSummaryFromCanonical` gains a fold-strategy seam
  (mechanical for partial; advanced for full coverage).
- **Marker contract:** existing `context.compacted` via existing bridge, after
  successful persist.
- **Writer/epoch ownership:** composition root's epoch threaded as today.
- **Provenance:** row fields + `ModelContextProvenance` via existing P3.5 carrier.
- **Failure/recovery:** §14/§16.
- **Likely files:** new renderer module (e.g. `src/session/context-fold.ts`) + P3.4
  producer seam + `test/context-fold.test.ts`; `docs/ARCHITECTURE.html` map entry.
- **Validation:** new fold tests + existing P3.2/P3.3/P3.4/P3.5 suites + `tsc --noEmit` +
  full suite + writer-inventory/architecture-map.
- **Rollback:** renderer is additive; disabling the seam restores mechanical-only
  behavior exactly.

---

## 21. Readiness Verdict

**READY WITH CONDITIONS.** Everything required is defined except the bounded
content-policy ratification (preserve-vs-omit thresholds for the full-coverage renderer,
including the LLM-free recommendation). Authority, ownership, persistence, marker,
fencing, determinism, provenance, failure, and test contracts are all explicit and
grounded in current code. No safety blocker exists.

---

## 22. Exact Next Action

**One action:** ratify the full-coverage fold content policy (what a full-history summary
must preserve vs may omit, and confirm the deterministic LLM-free renderer requirement),
then implement the P3.7 renderer + P3.4-producer seam per §20.

(No implementation, commit, or push was performed in this audit.)

---

```text
MINICODE P3.7 ARCHITECTURE STATUS:
READY WITH CONDITIONS

P3.7 scope:
CLEAR

A+C semantics:
DEFINED

Full-coverage contract:
CLEAR

Fold source authority:
PASS

Projection producer ownership:
SINGLE

Projection persistence:
REUSED

P3.3 integration:
CLEAR

Durable marker bridge:
DEFINED

Epoch fencing:
SAFE

Determinism/idempotency:
PASS

Provenance/recovery:
PASS

Canonical authority:
PASS

P3.4 boundary:
PRESERVED

P3.5 boundary:
PRESERVED

Hard dependencies:
PRESENT

Test contract:
DEFINED

Blocking findings:
NONE

Non-blocking findings:
1. Full-coverage fold content policy (preserve-vs-omit thresholds; LLM-free recommendation) needs owner ratification — the single bounded condition.
2. P3.4 limitation-1 wording ("needs the P3.7 full-history fold renderer") is confirmed accurate by direct source inspection of mechanicalCompaction.
3. No committed test drives a full-coverage fold today (impossible by construction until the renderer exists) — expected, not a gap.

Recommended next action:
Ratify the full-coverage fold content policy (preserve-vs-omit + deterministic LLM-free requirement), then implement the P3.7 renderer + P3.4-producer seam per §20.

P3.7:
READY WITH CONDITIONS

CONFIDENCE:
HIGH
```
---

## 23. Owner Ratification Record

**Status at audit time:** the audit's single bounded condition (non-blocking finding 1) was the unratified content policy. **Ratified** via P3_7_CONTENT_POLICY_RATIFICATION_REPORT.md and the P3.7 � Owner-Ratified Full-Coverage Fold Content Policy subsection in P3_ROADMAP.md.

- **Original audit finding:** content policy (preserve-vs-omit + LLM-free) needed owner ratification; all other contracts defined.
- **Owner-ratified content policy:** deterministic, rule-based, LLM-free, network-free fold model; full coverage = processed-and-accounted (not lossless); preservation categories (�4.3) and condensation rules (�4.4) as specified; unsupported content fails safe without new statuses; A+C invariant preserved.
- **Implementation status:** NOT STARTED (this ratification authorizes scope only, not code).
