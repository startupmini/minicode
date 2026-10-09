# MiniCode P3 Roadmap (Canonical)

**Status:** Owner-ratified. This document is the canonical authority for the P3
(Context ↔ Session Reconciliation) program sub-milestone numbering.

**Outer phase:** Big Roadmap **Phase 3 — Context ↔ Session Reconciliation**
(`P2_CLOSURE_HANDOFF.md` §"Phase 3 handoff").

**Ratification:** establishes the P3.4 boundary. No implementation is authorized by this
document; it defines scope only.

---

## 1. Authority & provenance

This roadmap **supersedes** the historical sub-numbering in
`P3_FORENSIC_AUDIT_REPORT.md` where they conflict. Rationale: the forensic report
numbered the phases before implementation; the actual program diverged (P3.3 was built as
the **Canonical Context Selector**, not "History → Context Projection production"). Current
canonical **code is authoritative** for implementation state; this document is authoritative
for **scope**.

Sources consulted (classified):

| Document | Class |
| --- | --- |
| `P2_CLOSURE_HANDOFF.md` | CURRENT (outer phase handoff) |
| `P3_0_CONTEXT_SESSION_CONTRACT.md` | CURRENT contract (P3.0) |
| `P3_1_CURRENT_CANONICAL_IMPLEMENTATION_REPORT.md` | CURRENT (P3.1) |
| `P3.2_CONTEXT_IDENTITY_FRONTIER_REPORT.md` | CURRENT (P3.2) |
| `P3_3_IMPLEMENTATION_REPORT.md` / `P3_3_HARDENING_REPORT.md` | CURRENT (P3.3) |
| `P3_PROGRAM_CURRENT_CANONICAL_TRUTH_AUDIT.md` | CURRENT (program audit) |
| `P3_FORENSIC_AUDIT_REPORT.md` | HISTORICAL (superseded numbering) |
| `P3.10_GATE_HYGIENE_CLOSURE_REPORT.md` | HISTORICAL (gate hygiene closure) |
| `PLAN.md` | DERIVED/UNRELATED (uses a different P0–P3 harness numbering) |

---

## 2. Completed milestones

| Milestone | Scope | Status |
| --- | --- | --- |
| **P3.0** | Context ↔ Session Authority & Contract Reconciliation (contract) | FROZEN (D1–D6 mostly ratified) |
| **P3.1** | Reconciliation Guard (append-only enforcement; `grewBeyondBuffer` I2 fix) | ✅ VALID (tag `p3.1-canonical-2026-10-08`) |
| **P3.2** | Context Identity / Frontier / Freshness (descriptive, pure) | ✅ VALID |
| **P3.3** | Canonical Context Selector (derived, read-only, deterministic) | ✅ VALID |

---

## 3. Ratified forward milestones

```
P3.4 — Durable Context Projection Producer / Projection Cache   ← NEXT
P3.5 — Runtime Context Adapter
P3.7 — A+C Fold Producer / advanced fold
```

### P3.4 — Durable Context Projection Producer / Projection Cache

**Primary problem.** The durable-derived `history_projections` cache can be **consumed**
(the P2.8 assembly and the P3.3 selector read a CURRENT projection), but there is **no
production producer path** that builds or refreshes it on the automatic path.
`buildProjection`/`rebuildProjection` are exercised by tests only.

**Goal.** Establish the smallest production-safe **producer** that writes
`history_projections` rows from canonical state, so that selector strategies such as
`summary-plus-tail` can become real production behavior.

**In scope.** A production producer writing the existing projection representation
(`base_seq`, `included_ranges`, `anchor_event_id`, `summary_text`, `built_at`) into
`history_projections`; wiring it at a single safe seam; provenance + invalidation
verbatim per the existing P2.7 projection contract.

**Non-goals (explicit).**
- Runtime Context Adapter (→ P3.5)
- headless `context.compacted` durable bridge (→ P3.5)
- presentation adapter redesign (→ P3.5)
- semantic relevance ranking / vector / embedding search (→ later P3.11/P4)
- selector redesign (P3.3 is closed)
- canonical history rewrite (forbidden)
- a new persistence authority or a second memory system (forbidden)
- advanced A+C fold producer / generalized compaction engine (→ P3.7)
- attach history-presence gate (→ hardening, not P3.4)
- conflict-diagnostic category (→ hardening, not P3.4)

**Boundary vs P3.7.** P3.4 builds and persists the projection representation required by
the **existing** projection contract (a cache record of an already-produced summary text).
P3.4 must **not** absorb the complete advanced A+C fold-generation algorithm (the richer
fold semantics for producing the summary itself) — that is P3.7. If the current code makes
this boundary unclean, document the constraint rather than implementing it.

**Success criteria (implementation gate for future P3.4).**
```
[ ] production producer exists
[ ] projection generated from canonical state
[ ] projection remains derived
[ ] provenance retained (anchor_event_id + base_seq + included_ranges + built_at)
[ ] identity scoped (session_id, thread_id)
[ ] revision/freshness explicit
[ ] projection invalidation semantics defined
[ ] selector can consume the produced projection
[ ] no second history authority
[ ] no silent canonical mutation
[ ] deterministic generation where required
[ ] production-path tests exist
[ ] mutation/non-vacuity evidence
[ ] recovery/rebuild tested
```

### P3.5 — Runtime Context Adapter

**Responsibilities.**
- carry `revision` into the runtime where it is currently lost
- preserve `ModelContextProvenance`
- bridge headless `context.compacted` (durable marker without the presentation adapter)
- make the runtime context lifecycle freshness-aware
- provide the runtime-facing adapter seam

**Note.** The post-P3.2 authority (`P3.2` report §16–17) names this the next milestone
after P3.3; this roadmap places P3.4 (projection producer) before it, because the selector
consumes a projection that nothing currently produces.

**Ratified implementation contract** (owner-ratified, see
`P3_5_RUNTIME_CONTEXT_ADAPTER_ARCHITECTURE_AUDIT.md`):

- **Adapter shape:** a thin **host-side** runtime metadata carrier + lifecycle bridge. It
  transports `ContextSelection`-derived metadata (`ContextIdentity`, `ContextFrontier`,
  `revision`, `selectionBasis`, `freshness`, `coverage`) into the runtime handle and
  constructs `ModelContextProvenance` from the selection.
- **No new store/schema/vendor/kernel change.** The adapter reuses existing primitives
  (`ContextSelection`, `deriveFrontierFromDurable`, `rowsToCanonicalRefs`,
  `readConsumableSummaryProjection`, `ModelContextProvenance`).
- **Headless `context.compacted` bridge:** on paths without the presentation adapter
  (autonomous children via `createMinicodeSession`), the adapter bridges the kernel
  `context:compacted` bus event into the durable `context.compacted` presentation event by
  **reusing `appendPresentationEvents`** (idempotent, epoch-fenced). No second marker
  system.
- **Authority:** `ContextStore` stays a runtime buffer; canonical history stays the sole
  authority; the adapter writes **only** the presentation-event bridge channel, never
  canonical history; P3.1/P2.7 remains the publication boundary.
- **Revision:** propagated, never fabricated; the adapter does not manufacture a higher
  revision.
- **Non-goals remain:** P3.7 A+C fold producer, semantic ranking, attach history gate,
  conflict diagnostics.

### P3.7 — A+C Fold Producer / advanced fold

**Responsibilities.** Advanced A+C fold-generation semantics (produce the summary/fold
representation), the richer fold algorithm and its durable marker bridge.

**Numbering note.** The historical forensic roadmap used **P3.7 = Branch/Fork Read
Semantics**. That usage is **superseded** for this program: the recent P3.3 audits
(`P3_3_CANONICAL_SELECTOR_ARCHITECTURE_AUDIT`, `P3_3_CURRENT_CANONICAL_TRUTH_AUDIT`,
`P3_PROGRAM_CURRENT_CANONICAL_TRUTH_AUDIT`) consistently treat **P3.7 as the A+C fold
producer**. Branch/Fork remains an unfiled future concern (its contract hooks are reserved
in `P3_0` §5/§7 as `(parent_thread_id, fork_event_seq)`).

### P3.7 — Owner-Ratified Full-Coverage Fold Content Policy

(Ratified; see `P3_7_CONTENT_POLICY_RATIFICATION_REPORT.md`. No implementation is
authorized by this section — it defines the content contract only.)

1. **Fold model.** The P3.7 fold is DETERMINISTIC, RULE-BASED, LLM-FREE, NETWORK-FREE,
   SOURCE-TRACEABLE, and DERIVED-ONLY. Same canonical history + same fold policy =
   equivalent fold content. It must not rely on LLM-generated summaries, remote inference
   APIs, embeddings or vector search, randomized selection, wall-clock time as a
   content-selection input, or unsupported semantic inference. The projection's `built_at`
   metadata may continue to reflect actual build time; that does not permit build time to
   influence fold content.

2. **Full coverage is not lossless preservation.** Full coverage means every source
   sequence in the claimed range has been processed and accounted for under the fold
   policy. It does not mean every character, sentence, or message is retained verbatim.
   The fold is a lossy derived representation; it must never claim to be a verbatim copy,
   and must never claim full coverage for a range it did not process. Coverage metadata
   and fold content must agree.

3. **Required semantic preservation.** The fold must preserve the meaningful state needed
   to continue work: user goals/requirements/constraints; explicit decisions, approvals,
   rejections, commitments; current task state and unresolved work; tool actions with
   meaningful results and externally observable effects; errors, refusals, recovery
   outcomes, failure conditions; established facts, constraints, relationships; superseding
   facts/decisions; outstanding questions and uncertainty; identity/provenance for
   traceability. Where exact values carry operational significance (file paths,
   identifiers, commands, hashes, numbers/thresholds, error messages, structured tool
   results, retrieval references), preserve them accurately rather than paraphrasing.

4. **Permitted condensation/omission.** Condense or omit only without violating the
   preservation contract: greetings/filler; repeated statements with no new information;
   duplicate tool output; redundant restatement of unchanged facts; verbose intermediate
   output whose relevant result is retained; superseded intermediate state (provided the
   valid current state and meaningful supersession are preserved). Never omit significant
   content merely for length; never treat errors, decisions, rejections, or side effects
   as redundant without a defensible rule; never infer missing facts. When a message mixes
   low-value prose with operational content, preserve the operational content.

5. **Unsupported content / failure.** If the deterministic rules cannot safely represent
   a relevant event or establish coverage: do not claim a valid full-history fold. Use
   the existing safe fallback (full canonical history + explicit status). Do not introduce
   a new projection status or `SelectionBasis` value without a separately justified
   contract change. A missing fold must never be disguised as successful full coverage.

6. **A+C invariant.** A = context-only transformation; C = separately stored derived
   summary; B (canonical-history rewrite) = NON-CONFORMING. Canonical history remains the
   sole authority; the fold is reconstructable from the intact prefix.

7. **Determinism.** Same history + same policy = equivalent content across time,
   entrypoint, retry, redelivery, and rebuild (timestamps may differ; semantics must not).

8. **Existing projection schema contract.** Reuse `session_id`, `thread_id`, `base_seq`
   (`== head+1` for full coverage), `included_ranges` (`[[0, base_seq]]`), non-null
   `anchor_event_id` (boundary identity), `summary_text` (scrubbed via the existing
   `scrubSecrets` path), `built_at`. No new fields. Full coverage keeps the existing
   CURRENT / PARTIAL / rule-7 / rule-8 / DIVERGED / UNKNOWN distinctions (rule-7 stays
   rejected; rule-8 stays consumable-as-partial).

9. **Single producer authority.** P3.7 provides the pure fold renderer; P3.4 retains the
   single approved persistence path (`buildProjectionInTxn`); P3.5 retains the runtime
   metadata/bridge primitives; P3.3 stays a read-only selector; P3.1/P2.7 stays the
   publication boundary.

10. **Durable marker reuse.** Fold markers reuse the approved P3.5/P2.11 event primitives
    (`appendPresentationEvents`: idempotent, epoch-fenced, collision-surfaced). No second
    marker system.

11. **P3.4/P3.5 boundaries.** P3.4 owns schema + lifecycle + persistence; P3.5 owns
    runtime metadata + bridges; P3.7 owns fold content generation only. Semantic relevance
    ranking and model-based selection stay later work, not P3.7.

12. **P3.7 implementation gate.** A future implementation must prove: full source range
    processed; preservation/omission rules followed; identity/anchors correct; incomplete
    output cannot claim full coverage; deterministic output; projection still derived;
    canonical history untouched; production-path tests; mutation/non-vacuity evidence;
    recovery/rebuild tested.

**Numbering note.** The historical forensic roadmap used **P3.7 = Branch/Fork Read
Semantics**. That usage is **superseded** for this program: the recent P3.3 audits
(`P3_3_CANONICAL_SELECTOR_ARCHITECTURE_AUDIT`, `P3_3_CURRENT_CANONICAL_TRUTH_AUDIT`,
`P3_PROGRAM_CURRENT_CANONICAL_TRUTH_AUDIT`) consistently treat **P3.7 as the A+C fold
producer**. Branch/Fork remains an unfiled future concern (its contract hooks are reserved
in `P3_0` §5/§7 as `(parent_thread_id, fork_event_seq)`).

---

## 4. P3.6 — not defined in the current canonical roadmap

The historical forensic roadmap listed **P3.6 — Bounded Reads (Paging/Lazy)**, and the
P3.10 report grouped "Paging/Budget" among P3.4–P3.11. However, **no current canonical
authority requires a P3.6**, and the ratified forward set is {P3.4, P3.5, P3.7}. Per the
ratification rule ("do not invent P3.6 if the existing roadmap does not require one"),
**P3.6 is intentionally left undefined/reserved**. If bounded reads (paging/lazy) becomes
necessary, it will be filed explicitly with its own scope note.

---

## 5. Authority contract (invariant for all forward milestones)

```
Canonical history          = sole authoritative history        (src/session/persistence.ts)
Projection cache           = durable BUT derived               (history_projections, a CACHE)
Projection producer        = writer of DERIVED projection only (P3.4 — not yet built)
Selector                   = derived, read-only consumer       (src/session/context-selector.ts)
P3.1 / P2.7                = canonical publication safety      (saveSession append-only + epoch)
```

**Hard invariant.** The projection cache **MUST NEVER** become canonical history authority.
A projection is invalidated/validated deterministically by `getProjectionStatus`
(anchor + head based); a missing/corrupt projection degrades to full canonical history
(cache miss), never to a fabricated or authoritative state.

---

## 6. Intended data lifecycle (P3.4 target shape)

```
canonical history (messages)
      │  read-only
      ▼
projection producer (P3.4)         ── writes ONLY history_projections
      ▼
history_projections  (durable, derived, invalidated by anchor/head)
      ▼
P3.3 selector  (reads CURRENT projection)
      ▼
ContextSelection  (derived, provenance-bound)
      ▼
runtime context (ContextStore)
```

The projection is a **derived durable view**, **not** a replacement for history.

---

## 7. Status

```
P3.1 — Reconciliation Guard              ✅
P3.2 — Context Identity / Frontier       ✅
P3.3 — Canonical Context Selector        ✅
P3.4 — Durable Context Projection        ✅ VALID
P3.5 — Runtime Context Adapter           ← CURRENT (ratified; implementation pending)
P3.6 — (reserved; undefined by current authority)
P3.7 — A+C Fold Producer / advanced fold (not started)
```

No implementation is authorized by this roadmap document.
