# P3.4 — Architecture, Scope & Dependency Audit

Read-only audit. No source/test/docs/config modification; no git mutation; working tree
preserved. Current canonical code is authoritative over historical reports. P3.4 was NOT
implemented.

> **OWNER-RATIFIED SCOPE (added after this audit).** The audit finding below is that P3.4
> was **undefined** in the current canonical roadmap. That finding is now **resolved by
> owner ratification**: **P3.4 = Durable Context Projection Producer / Projection Cache**,
> with **P3.5 = Runtime Context Adapter** and **P3.7 = A+C Fold Producer / advanced fold**.
> The canonical authority for this is the new `P3_ROADMAP.md`. The technical findings and
> candidate analysis in this document are **unchanged**; only the roadmap-definition status
> changes from ABSENT to RATIFIED. Section 24 (Readiness Verdict) should be read with this
> banner in force.


---

## 1. Executive Summary

**P3.4 is not explicitly defined in the current canonical roadmap.** The only file that
assigns P3.4 a name is `P3_FORENSIC_AUDIT_REPORT.md` (historical, HEAD `e284298`-era),
which numbers the phases **differently** from what was actually built:

| Phase | Historical forensic plan | Actually built / current authority |
| --- | --- | --- |
| P3.3 | "History → Context Projection (production)" | **Canonical Context Selector** (done) |
| P3.4 | "Resume/Recovery Reconciliation" | **undefined in the current scheme** |
| P3.5 | "Compaction Contract" | **Runtime Context Adapter** (post-P3.2 report) |

The post-P3.2 roadmap (`P3.2_CONTEXT_IDENTITY_FRONTIER_REPORT.md` §16–17) — the most
recent authoritative statement — explicitly names the next milestone after P3.3 as
**P3.5 Runtime Context Adapter** (plumbing `revision`/`ModelContextProvenance` into the
resume path) and mentions P3.4 only incidentally ("`projection_id` … tinjau ulang di P3.4
bila proyeksi berversi"). The `P3.10` gate-hygiene report lists P3.4–P3.11 as a bag
("Projection Cache, Runtime Context Adapter, Resume/Recovery, Compaction, Paging/Budget,
Branch/Fork, Model Context+RAG") without a 1:1 mapping.

**The single most concrete architectural gap after P3.3** — supported by current code —
is that the **`history_projections` "Projection Cache" has no production producer**: the
selector consumes a durable projection if one exists, but **nothing builds one**.
`buildProjection`/`rebuildProjection` are called by **no production code** (tests only).
This makes the "Projection Cache" (P3.4 in the P3.10 list order) the strongest candidate
for P3.4 scope — but it is **not** documented as such in any authority, and it borders on
P3.7 (the P3.3 audit calls the A+C fold producer "P3.7").

**Verdict: READY WITH CONDITIONS.** The repository is architecturally ready (all hard
dependencies present), P3.4's *candidate* scope is small and safe, but the **roadmap
definition of P3.4 is ABSENT** in the current scheme. P3.4 cannot be "READY TO IMPLEMENT"
until the owner ratifies which concern is P3.4 (recommended: **Durable Context Projection
Producer / Projection Cache** — formalize the producer for the existing
`history_projections` substrate) versus deferred to P3.5/P3.7.

---

## 2. Canonical Baseline

| Fact | Value |
| --- | --- |
| Root | `D:/git/minicode` |
| Branch | `main` |
| HEAD | `5b8d98d05d51dee52ceae04b1610019f7c3c7eb8` |
| `origin/main` | `5b8d98d05d51dee52ceae04b1610019f7c3c7eb8` (HEAD == origin/main) |
| Working tree | CLEAN |
| P3.3 final checkpoint | `5b8d98d` (`p3.3: harden selector integration and edge cases`) |

Nothing was modified during this audit.

---

## 3. Roadmap Truth

```
ROADMAP TRUTH
--------------
P3.4:
UNDEFINED in the current scheme.
Historically named "Resume/Recovery Reconciliation" (P3_FORENSIC_AUDIT_REPORT, obsolete
numbering). The P3.10 list places "Projection Cache" first among P3.4–P3.11 but without a
1:1 mapping. No current authority assigns P3.4 a scope.

P3.5:
PARTIALLY DEFINED. The post-P3.2 report names "P3.5 Runtime Context Adapter" as the next
milestone after P3.3 (plumb revision/ModelContextProvenance to the resume path); the
forensic report called P3.5 "Compaction Contract". Conflicting.

Current authoritative source:
P3.2_CONTEXT_IDENTITY_FRONTIER_REPORT.md §16–17 (most recent milestone statement) — but
it defines P3.5, NOT P3.4. No file defines P3.4 in the current numbering.
```

**Conflict resolution:** the historical forensic numbering is **superseded** (P3.3 was
built as the Selector, not "Projection production"). Current code + the post-P3.2 report
are authoritative. Under them, **P3.4 is a genuine gap in the roadmap.**

---

## 4. P3.3 Current State (verified)

P3.3 (`src/session/context-selector.ts`) is VALID (per `P3_3_HARDENING_REPORT`, HEAD
`5b8d98d`):

- Pure, read-only, deterministic; imports no persistence function.
- Selection bases: `full-history | summary-plus-tail | budget-tail | fallback-unknown`.
- Emits provenance-bound `ContextSelection` (frontier incl. `historyCommit`, `anchor`,
  `revision`; `selectionBasis`; `freshness`).
- Integrated at **one** seam: the resume path in `cli/setup.ts` (with computed
  `canonicalFrontier`).
- 38 selector tests + 3 resume-integration tests, all green.

**What P3.3 does NOT do:** it selects from rows the caller already loaded; it does not
produce or persist projections; it does not thread `revision`/provenance into the runtime
kernel beyond seeding `messages`.

---

## 5. P3.3 Limitation Ownership

| # | P3.3 limitation | Owner | Why |
| --- | --- | --- | --- |
| 1 | full-coverage projection `base_seq == head+1` capped to `head` | **P3.3 (accepted)** / Not a problem | Conservative, faithful rendering; enforced by P3.2's `baseSeq <= head` rule. No data loss. |
| 2 | `budget-tail` is non-durable eviction | **Not a problem** (by design) | Eviction ≠ fold; publishing it is refused by P2.7. Correct. |
| 3 | `revision` undercounts on headless paths without presentation adapter | **P3.5** (explicitly declared a P3.5 seam in the P3.2/P3.3 reports) | The `context.compacted` durable bridge lives in the presentation adapter; a headless path without it under-counts. This is the **runtime adapter** concern, i.e. P3.5. |
| 4 | selector wired at resume seam only | **P3.4 candidate (Selector Widening)** OR integration work | Other consumers use `assembleContext`; widening is adoption, not necessarily a milestone. |
| 5 | no semantic relevance ranking | **Later P3 / P4** | Requires embeddings/model calls/retrieval → nondeterminism; explicitly out of P3 infrastructure scope. |

**Conclusion:** none of the five limitations is *unambiguously* P3.4. #3 is P3.5; #5 is
later; #1/#2 are non-problems; #4 is a candidate but likely integration.

---

## 6. P3.4 Problem Statement

Derived from the current architecture's most concrete gap:

> **Today MiniCode can select a context view from canonical history (P3.3) and can consume
> a durable `history_projections` summary if one exists, but nothing in production builds
> a projection, so the selector's `summary-plus-tail` basis can never be triggered on the
> automatic path; the durable projection cache is a producerless substrate.**

Supporting facts (verified):
- `buildProjection`/`rebuildProjection` are called by **no production code** (only tests).
- `context-assembly.ts` and the selector **read** `history_projections` but never write.
- The `history_projections` table (`projection_id`, `base_seq`, `included_ranges`,
  `anchor_event_id`, `summary_text`, `built_at`) is fully implemented and tested
  (`projection-foundation.test.ts`, 21 tests) — a cache **missing a producer**.

This is the **"Projection Cache"** concern from the P3.10 list, and it is the single
capability that measurably unlocks `summary-plus-tail` in production.

**Alternative framing** (also defensible): P3.4 = **Selector Widening** (migrate remaining
context consumers from `assembleContext` to the selector). This is smaller and purely
integration, but it may not warrant a milestone.

---

## 7. P3.3 → P3.4 Boundary

| Layer | Owns | Status |
| --- | --- | --- |
| P2.7 | canonical publication safety (`saveSession` append-only + epoch) | DONE |
| P3.1 | reconciliation contract / guard | DONE |
| P3.2 | identity / frontier / freshness (descriptive) | DONE |
| P3.3 | deterministic selection from loaded rows → `ContextSelection` | DONE |
| **P3.4** | **produce durable projections** (the missing producer) **or** selector widening | **OPEN** |
| P3.5 | runtime context adapter (thread revision/provenance into runtime; headless revision bridge) | NOT STARTED |

**Responsibility deliberately outside P3.3:** producing/persisting durable derived
context. P3.3 is explicitly a *view builder over loaded rows*; it must not write.

---

## 8. Candidate Capability Analysis

### Candidate A — Selector Widening
- **Consumers using `assembleContext`:** only `cli/setup.ts` (the resume seam, which now
  uses the selector) — grep shows no other production consumer of `assembleContext`.
- **Conclusion:** there is effectively **nothing to widen**; the selector already replaced
  the sole consumer. Widening is **not a milestone** — at most cleanup. (This *weakens* the
  "P3.4 = widening" framing.)

### Candidate B — Context Projection
- Current state: projection is a **read-only cache** (`history_projections`) with a
  **missing producer**. No ad-hoc/P2.8/P3.3 production producer exists.
- **Conclusion:** formalizing the projection **producer** is a real, small capability and
  the best-supported P3.4 candidate — but it overlaps the P3.3-audit-named **P3.7** (A+C
  fold producer). Needs owner ratification.

### Candidate C — Revision / Headless Path
- The presentation adapter (`src/presentation/adapter.ts`) bridges `context:compacted` →
  durable `context.compacted`; a headless path without the adapter under-counts `revision`.
- **Conclusion:** this affects freshness/revision **correctness in headless execution** —
  a **runtime adapter** concern → **P3.5** (the post-P3.2 report explicitly calls it a
  P3.5 seam). Not P3.4.

### Candidate D — Relevance / Semantic Selection
- Requires embeddings/model calls/retrieval → adds **nondeterminism** and a new authority.
- **Conclusion:** **NOT P3.4**; later P3 (P3.11 RAG) or P4. Explicitly out of infrastructure scope.

### Candidate E — Durable Context Projection
- Question: does MiniCode need durable representations of summaries/projections/selected
  context? **Yes — the substrate already exists** (`history_projections`) and is unused in
  production. The invariant `derived context ≠ canonical history` is already honored
  (projections are a CACHE, invalidated by `getProjectionStatus`, rebuilt from `messages`).
- **Conclusion:** if P3.4 = "Projection Cache (producer)", its authority/ownership/
  invalidation/versioning/provenance/recovery are **already defined** by P3.0 §8/P2.7.

---

## 9. Authority Graph

```
Canonical History (messages)                 AUTHORITATIVE      (persistence.ts)
       │ read-only
       ▼
Context Identity / Frontier (P3.2)           DERIVED            (context-identity.ts)
       │
       ▼
Selector (P3.3)                              DERIVED            (context-selector.ts)
       │
       ▼
Context Projection (history_projections)     DURABLE BUT DERIVED / CACHE   ← producer MISSING
       │
       ▼
Context Assembly (P2.8)                      DERIVED            (context-assembly.ts)
       │
       ▼
Runtime Context (ContextStore)               EPHEMERAL          (kernel)
       │
       ▼
Publication                                  AUTHORITATIVE (write)  (P3.1 decision + P2.7)
       │
       ▼
Canonical History
```

| Part | Class |
| --- | --- |
| Canonical history (`messages`) | AUTHORITATIVE |
| P3.2 identity/frontier | DERIVED |
| P3.3 selector | DERIVED |
| `history_projections` | DURABLE BUT DERIVED (cache) |
| Context assembly view | DERIVED / EPHEMERAL |
| Runtime `ContextStore` | EPHEMERAL |
| `saveSession` | AUTHORITATIVE (single writer) |

**What P3.4 would add:** a **producer** that writes to the existing `history_projections`
cache — still DURABLE BUT DERIVED, **not** a second canonical authority. Invariant
**"P3.4 must not create a second canonical history authority"** is satisfiable because the
substrate is already a cache owned by `persistence.ts`.

---

## 10. Context Lifecycle

| Transition | Transforms | Retained | Discarded | Authoritative | Provenance | Version/Freshness |
| --- | --- | --- | --- | --- | --- | --- |
| event → identity | hash(session,thread,seq,content) | content binding | — | no (derived) | `anchorEventId` | identity |
| identity → frontier | + head/commit/revision | coverage | — | no | `historyCommit` | `revision` |
| frontier → selection | row pick + budget | frontier | excluded rows (eviction) | no | `selectionBasis` + frontier | `freshness` |
| selection → projection | (N/A today — **producer missing**) | — | — | — | — | — |
| selection/assembly → runtime | `messages` seed | messages | **frontier/revision/basis dropped here** | no | partial (`[select]` log only) | **lost at runtime boundary** |
| runtime → compaction | kernel fold (RAM) | tail + summary | prefix (RAM) | no | `context.compacted` | `revision++` |
| compaction → publication | `persistCurrent` → `saveSession` | adopted rows | — | yes (append) | `migrated_compacted` | epoch |
| publication → canonical | append/explicit shrink | — | — | yes | `event_id` | — |

**First point of insufficiency:** the **runtime boundary** — `revision`/`ModelContextProvenance`
computed by P3.3 are **dropped** when `initialMessages` seeds the kernel
(`cli/setup.ts:952` keeps only `selection.messages`). This is the **P3.5 Runtime Context
Adapter** gap (the post-P3.2 report names it so). The **projection producer absence** is the
other gap (P3.4 candidate).

---

## 11. Compaction Boundary

Current semantics (verified distinct):

| Operation | Owner | Effect on canonical | Durability |
| --- | --- | --- | --- |
| SELECT (P3.3) | selector | none | none (RAM) |
| ASSEMBLY (P2.8) | `assembleContext` | none | none (RAM) |
| PROJECTION (read) | `getProjection` | none | reads cache |
| **PROJECTION (write)** | **none in production** | — | **missing producer** |
| COMPACT (kernel) | kernel `replace` | none (RAM) | `context.compacted` event |
| SHRINK (explicit) | `shrinkThreadHistory` | rewrite (authorized, provenanced) | durable |
| PUBLISH (P2.7) | `saveSession` | append-only / refuse | durable |

`SELECT ≠ PROJECT ≠ COMPACT ≠ PUBLISH` holds. A P3.4 projection producer must keep
`PROJECT ≠ COMPACT` (a projection is a cache record, not a history rewrite) and
`PROJECT ≠ PUBLISH` (writing a projection is not publishing history).

---

## 12. Freshness / Revision Lifecycle

| Path | identity | frontier | revision | historyCommit | anchor | Loss? |
| --- | --- | --- | --- | --- | --- | --- |
| selection (P3.3) | preserved | preserved | preserved (passed) | preserved | preserved | no |
| assembly (P2.8) | n/a | n/a | n/a | n/a | n/a | n/a |
| compaction | — | — | +1 via durable marker (with adapter) | — | — | **yes on headless (no adapter)** |
| resume | rebuilt | rebuilt | `countDurableCompactions` | rebuilt | rebuilt | no (when adapter present) |
| headless execution | rebuilt | rebuilt | **undercount if no adapter** | rebuilt | rebuilt | **yes (P3.5)** |
| presentation path | — | — | bridged (`context.compacted`) | — | — | no |
| publication | event_id | — | — | — | — | n/a |
| **runtime seed** | **dropped** | **dropped** | **dropped** | **dropped** | **dropped** | **yes (P3.5)** |

Two loss points, both **P3.5 (runtime adapter / headless bridge)** — not P3.4.

---

## 13. Session / Resume Lifecycle

`create → reuse → reconstruct → select → execute → persist → resume`:

- **create/reuse**: `resolveSessionIdentity` (P2.1) — reuse continues; unknown-resume
  refuses; alias conflicts refuse. Gap: **no history-presence gate** (attach gap).
- **reconstruct/select**: `assembleContext` + `selectContext` (P3.3) — complete.
- **execute/persist**: `saveSession` (P2.7) — append-only.
- **resume**: recovery journal → `recoveryAppendix` → `systemExtra`; selector seeds
  messages. Ordering: recovery is read **before** seed and passed as a **system appendix**
  (not fake messages) — deterministic.

**What remains incomplete after P3.3:** (a) runtime adapter (P3.5); (b) attach
history-presence gate (defence-in-depth, P3.4/P3.5 candidate per the P3 program audit).

**Should P3.4 touch the attach gate?** It is orthogonal to context selection; it is a
session-identity-hardening item. **Evidence does not place it in P3.4**; it is a
defence-in-depth item, likely P3.5 or a dedicated hardening task.

---

## 14. Test Gap Analysis

| Stage | Coverage | Class |
| --- | --- | --- |
| canonical (`messages`) | extensive (persistence suites) | FULLY TESTED |
| identity / frontier (P3.2) | 39 tests, non-vacuous | FULLY TESTED |
| selector (P3.3) | 38 tests + 3 resume | FULLY TESTED |
| projection read/status | `projection-foundation` 21 tests | FULLY TESTED |
| **projection PRODUCER** | **none (no production producer)** | **UNTESTED (no producer)** |
| assembly (P2.8) | 33 tests | FULLY TESTED |
| runtime seeding | via cli-session/resume tests | PARTIALLY TESTED |
| runtime `revision`/provenance threading | **none** | **UNTESTED (P3.5 gap)** |
| resume | `context-selector-resume` + cli-session | PARTIALLY TESTED |
| publication boundary | P3.1 guard 14 + P3.3-32 | FULLY TESTED |

**Missing coverage is mostly P3.4/P3.5 implementation requirement** (the producer and the
runtime adapter), not mere testing debt.

---

## 15. Performance / Budget

- Budget is handled in the selector (message budget vs `contextWindowTokens`); correctness
  is separated from optimization.
- No repeated-selection caching, no incremental selection — **not needed** for correctness.
- Full-history traversal cost exists but is a **P3.6 (Paging/Bounded Reads)** concern
  (forensic roadmap), not P3.4.
- **Conclusion:** no dedicated P3.4 performance solution is required.

---

## 16. Recovery / Failure Semantics

| Condition | Current behavior | Sufficient for next phase? |
| --- | --- | --- |
| projection unavailable | selector/assembly fall back to canonical (`UNKNOWN`/miss) | yes |
| selector returns UNKNOWN | full view + explicit label | yes |
| projection stale | falls back to full canonical | yes |
| canonical changes during prep | view rebuilt from freshly-read rows | yes |
| resume after compaction | `revision` via durable markers (needs adapter) | yes with adapter (P3.5) |
| context too large | `budget-tail` eviction | yes |
| durable derived state missing | cache miss → fallback | yes |

Recovery semantics are **complete enough** for the next phase. The projection-cache
absence degrades gracefully (fallback full-history), so P3.4 (if = producer) does not
*worsen* failure behavior.

---

## 17. Hard Dependencies

| Dependency | Present | Partial | Missing | Owner |
| --- | --- | --- | --- | --- |
| P3.1 safety | ✅ | | | P3.1 |
| P3.2 identity | ✅ | | | P3.2 |
| P3.2 frontier | ✅ | | | P3.2 |
| P3.3 selector | ✅ | | | P3.3 |
| provenance | ✅ | | | P3.2/P3.3 |
| compaction contract | | ✅ | | P3.5/P3.7 (A+C producer) |
| resume seam | ✅ | | | P3.3 |
| projection (read/status) | ✅ | | | P2.7 |
| projection (producer) | | | ✅ | **P3.4 candidate / P3.7** |
| presentation adapter (headless revision bridge) | | ✅ | | P3.5 |

**True hard dependencies for a "Projection Cache Producer" P3.4:** all present except the
producer itself; `buildProjection` + `getProjectionStatus` + `saveSession` give the
substrate. **No missing hard dependency blocks P3.4.**

---

## 18. Risk Matrix

| ID | Risk | Classification |
| --- | --- | --- |
| R1 | P3.4 becomes second memory system | **POSSIBLE** (mitigate: projections are a cache-owned record, not memory) |
| R2 | projection becomes canonical authority | **NOT PRESENT** (invariant: cache ≠ authority; `getProjectionStatus` invalidates) |
| R3 | selector and projection duplicate logic | **POSSIBLE** (mitigate: producer writes records; selector reads them — distinct) |
| R4 | compaction mutates history semantics | **NOT PRESENT** (unchanged) |
| R5 | freshness dropped between selector and runtime | **PRESENT** (the runtime boundary drop — but this is **P3.5**) |
| R6 | provenance lost | **POSSIBLE** (same P3.5 boundary) |
| R7 | headless paths silently become authoritative | **POSSIBLE** (revision undercount — P3.5) |
| R8 | semantic ranking introduces nondeterminism too early | **NOT PRESENT** (out of scope) |
| R9 | durable projection stale without invalidation | **NOT PRESENT** (invalidation exists via `getProjectionStatus` + shrink deletes) |
| R10 | publication bypasses P3.1/P2.7 | **NOT PRESENT** (producer must not touch `messages`) |
| R11 | P3.4 absorbs unrelated P3.5 scope | **POSSIBLE** (the main scoping risk, given undefined roadmap) |
| R12 | P3.4 too large to validate | **POSSIBLE** (mitigate by keeping producer minimal) |

---

## 19. Minimal P3.4 Definition (recommended)

**Primary problem.** The durable `history_projections` cache has no production producer,
so `summary-plus-tail` selection can never occur on the automatic path.

- **Problem:** "MiniCode can read a durable projection cache but cannot produce one in
  production because no producer is wired."
- **Goal:** introduce a **derived projection producer** that writes `history_projections`
  records (a cache), triggered at a safe seam, with a summary text supplied by the existing
  compaction path — **without** altering canonical history.
- **Non-goals:** runtime adapter / revision threading (P3.5); semantic relevance (later);
  paging (P3.6); branch/fork (P3.7); attach gate; second store.
- **Inputs:** canonical rows, `buildProjection`/`getProjectionStatus` (P2.7), the kernel
  `context:compacted` signal, P3.2 revision.
- **Outputs:** durable `history_projections` rows (cache).
- **Authority:** `persistence.ts` remains sole writer; projection is DURABLE-BUT-DERIVED.
- **Persistence:** yes — into the existing cache table only.
- **Provenance:** `anchor_event_id`, `base_seq`, `included_ranges`, `built_at`,
  `summary_text` (already in schema).
- **Freshness:** `getProjectionStatus` (CURRENT/STALE/CORRUPT); `historyCommit` binds.
- **Failure semantics:** build failure → **no partial row** (already enforced by
  `buildProjectionInTxn`); absent/corrupt → cache miss → full-history fallback.

**Alternative minimal P3.4 (if owner prefers):** **Selector Adoption Cleanup** — retire the
now-redundant `assembleContext` call at the resume seam and confirm no other consumers
need it. This is smaller but may be "integration work", not a milestone.

---

## 20. P3.4 Invariants

```
I1  canonical history (messages) remains the sole authority.
I2  derived projection state cannot silently become authority (cache only).
I3  identity remains stable (event_id ≠ seq).
I4  freshness remains explicit (CURRENT/STALE/CORRUPT/UNKNOWN).
I5  provenance survives (anchor_event_id + base_seq + included_ranges + built_at).
I6  selection (P3.3) remains distinct from projection production.
I7  projection production remains distinct from compaction (COMPACT writes the summary
    text + emits the event; PROJECT records coverage; neither rewrites history).
I8  compaction remains distinct from publication (P2.7 unchanged).
I9  UNKNOWN remains explicit (no promotion).
I10 P3.1/P2.7 remains the publication boundary (producer never writes messages).
I11 a failed build leaves NO partial projection row.
I12 projection invalidation is deterministic (anchor/head-based).
```

---

## 21. P3.4 Test Contract (pre-implementation)

| Category | Required |
| --- | --- |
| normal lifecycle | build → read CURRENT → selector uses `summary-plus-tail` |
| stale lifecycle | head advances → status STALE → fallback full-history |
| resume | resume with CURRENT projection → summary-plus-tail; selector honors it |
| compaction | kernel compaction emits `context.compacted` → producer records coverage |
| provenance | `anchor_event_id`/`base_seq`/`included_ranges` present and correct |
| identity isolation | projection scoped `(session_id, thread_id)`; cross-thread not used |
| freshness | CURRENT/STALE/CORRUPT/UNKNOWN each observable |
| UNKNOWN | absent projection → UNKNOWN → full canonical (no promotion) |
| failure | build failure → no partial row; source intact |
| determinism | same canonical → same projection record |
| publication boundary | producer writes only `history_projections`; `messages` untouched |
| mutation/non-vacuity | inverting producer/invalidation flips tests |
| recovery | corrupt projection → fallback, no silent normalize |

---

## 22. Implementation Plan (proposed, NOT executed)

1. **New files:** a producer module (e.g. `src/session/context-projection.ts`) OR a
   function in `persistence.ts` exposed as a seam; one test file.
2. **Modified files:** minimal — wire the producer at a single seam (e.g. after
   `persistCurrent` on a `context.compacted` event), plus `docs/ARCHITECTURE.html`.
3. **Types/APIs:** reuse `ProjectionRow`, `buildProjection`, `getProjectionStatus`,
   `SUMMARY_PROJECTION_ID`.
4. **Dependency direction:** producer → `persistence.ts` (writes cache); selector stays
   read-only.
5. **Integration point:** the compaction path (kernel `context:compacted` → durable event
   → producer records coverage). *Coupled to P3.5/P3.7 — ratify boundary first.*
6. **Migration concerns:** none (cache table exists).
7. **Validation:** `bun test` (projection + selector + assembly + guard), `tsc --noEmit`.
8. **Rollback point:** additive producer; disabling the seam restores current
   (producerless) behavior exactly.

**Caveat:** this plan is only valid if the owner ratifies P3.4 = projection producer (vs
deferring to P3.7).

---

## 23. P3.4 vs P3.5 Boundary

| Concern | P3.4 | P3.5 | Later | Why |
| --- | --- | --- | --- | --- |
| Selector widening | (cleanup) | | | Only one consumer exists; effectively done |
| **Projection producer (cache)** | **✔ (candidate)** | | | Missing capability; substrate exists |
| Headless revision | | **✔** | | Runtime adapter seam (post-P3.2 authority) |
| Presentation adapter bridge | | **✔** | | Enables durable `context.compacted` |
| Runtime revision/provenance threading | | **✔** | | `selection.messages` drops the frontier |
| Semantic relevance | | | **✔ (P3.11/P4)** | Needs embeddings/model → nondeterminism |
| Durable summaries | | **✔** | | Tied to compaction contract (A+C) |
| Attach history gate | | **✔ (or hardening)** | | Session-identity defence-in-depth |
| Conflict diagnostics | | **✔** | | Observability item |
| Context caching (runtime) | | | **✔ (P3.6)** | Paging/bounded reads |

**Recommended split:** **P3.4 = Projection Cache Producer**; **P3.5 = Runtime Context
Adapter** (thread revision/provenance + headless bridge); attach gate / conflict
diagnostics = later hardening; semantic relevance = P3.11/P4.

---

## 24. Readiness Verdict

**READY WITH CONDITIONS.**

The repository is architecturally ready (all hard dependencies present; the projection
cache substrate exists, is tested, and is authority-safe). P3.4's *candidate* scope is
small, bounded, and safe. **The blocking condition is the roadmap**: P3.4 is **not
defined** in the current canonical numbering, and its most-supported scope (projection
producer) overlaps the P3.3-audit-named P3.7. The owner must ratify P3.4's scope before
implementation.

No P3 safety blocker exists. P3.3 remains valid and is not reopened.

---

## 25. Exact Next Action

**One action:** the owner ratifies the P3.4 scope in the current roadmap — recommended:
**"P3.4 = Durable Context Projection Producer (Projection Cache)"**, with P3.5 = Runtime
Context Adapter and the compaction-marker fold producer remaining P3.7 — by recording it
in a canonical roadmap note (e.g. a short P3 program roadmap doc) before any P3.4 code is
written.

(No implementation, commit, or push was performed in this audit.)

---

```text
MINICODE P3.4 ARCHITECTURE STATUS:
READY WITH CONDITIONS

P3.4 problem:
CLEAR

P3.4 scope:
MINIMAL

Roadmap definition:
ABSENT

P3.3 boundary:
CLEAR

P3.5 boundary:
PARTIAL

Authority model:
PASS

Freshness model:
PARTIAL

Provenance model:
PARTIAL

Compaction boundary:
PASS

Session/resume dependency:
PRESENT

Hard dependencies:
PRESENT

Test contract:
DEFINED

P3.4 safety:
PASS

Blocking findings:
1. P3.4 is UNDEFINED in the current canonical roadmap; the only explicit definition (P3_FORENSIC_AUDIT_REPORT "Resume/Recovery Reconciliation") uses obsolete numbering that conflicts with what was actually built (P3.3 = Selector). Owner ratification of P3.4 scope is required before implementation.

Non-blocking findings:
1. The `history_projections` cache has no production producer (buildProjection is test-only) — the strongest P3.4 candidate scope; overlaps the P3.3-audit-named P3.7.
2. P3.3's `revision`/`ModelContextProvenance` are dropped at the runtime seed boundary (cli/setup.ts:952) — a P3.5 Runtime Context Adapter gap, not P3.4.
3. Headless revision undercounts without the presentation adapter bridge — P3.5 seam (explicitly declared).
4. Attach history-presence gate absent — defence-in-depth; not evidenced as P3.4.
5. P3.5 is also only partially defined (conflicting historical names); a P3.5 scope note is advisable.
6. Selector widening has effectively no remaining consumers — not a milestone.

P3.5 items:
- Runtime Context Adapter: thread revision/ModelContextProvenance into the runtime (fix the runtime-seed drop).
- Headless `context.compacted` durable bridge (revision correctness without the presentation adapter).
- Durable summary/compaction contract (A+C producer) — shared with P3.7.
- Attach history-presence gate (or separate hardening).
- Conflict-diagnostics category (observability).

Recommended next action:
Owner ratifies P3.4 scope in the current roadmap (recommended: "Durable Context Projection Producer / Projection Cache"), with P3.5 = Runtime Context Adapter and the fold producer deferred to P3.7, before any P3.4 implementation.

CONFIDENCE:
HIGH
```

**STOP.** No implementation, no modification, no commit, no push.
