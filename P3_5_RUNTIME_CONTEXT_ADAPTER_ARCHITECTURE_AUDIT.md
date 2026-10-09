# P3.5 — Runtime Context Adapter: Architecture, Lifecycle & Authority Audit

Read-only audit. No source/test/docs/config modification; no git mutation; working tree
preserved. Current canonical code is authoritative; historical reports are evidence only.
P3.5 was NOT implemented.

---

## 1. Executive Summary

P3.5 (Runtime Context Adapter) is **architecturally ready to implement** with one bounded
design decision to ratify. The audit traced every transition of the context lifecycle from
canonical history to the runtime `ContextStore` and identified precisely where identity,
frontier, revision, and provenance are dropped:

1. **Runtime seed boundary (the confirmed loss):** `cli/setup.ts:960` copies only
   `selection.messages` into the kernel `SessionConfig.initialMessages`. The
   `ContextSelection`'s `frontier` (baseSeq/headSeq/anchor/lastSeen/revision/
   historyCommit), `selectionBasis`, `freshness`, and `coverage` are **dropped**. The
   kernel's `SessionConfig` has no metadata channel.
2. **`ModelContextProvenance` is type-only:** defined at `context-identity.ts:384`, it is
   **never constructed or attached anywhere** in the repo. Failure mode if absent at
   runtime = PROVENANCE LOSS + OBSERVABILITY LOSS (not a safety violation — publication is
   still P2.7-guarded).
3. **Headless `context.compacted` bridge gap:** the durable `context.compacted` marker is
   produced **only** by the presentation adapter (`adapter.ts:968`). Normal CLI, ACP, and
   exec all go through `createCliSession` (adapter installed → marker durable). The
   **autonomous child** path (`createMinicodeSession` DI in `task.ts`/
   `autonomous-context.ts`) installs **no adapter** → `context:compacted` stays in-memory →
   `revision` undercounts. Classification: **MISSING EVENT BRIDGE**, not an authority
   difference.
4. **Compaction is runtime-only:** `compactStore` (kernel `loop.ts:342`) mutates the
   `ContextStore` and emits an in-memory bus event; it never touches canonical. Publication
   of a compacted buffer proceeds only via the explicit provenanced `shrinkThreadHistory`
   after `saveSession`'s non-prefix refusal. `SELECTION ≠ COMPACTION ≠ PROJECTION ≠
   PUBLICATION` holds.

No second authority exists; no publication bypass exists (single `saveSession` funnel at
`cli/setup.ts:2032`). **Verdict: READY TO IMPLEMENT** — the only condition is ratifying the
adapter's shape (host-side metadata carrier + headless bridge via the existing
`appendPresentationEvents` primitive, not a new store or schema).

---

## 2. Canonical Baseline

| Fact | Value |
| --- | --- |
| Root | `D:/git/minicode` |
| Branch | `main` |
| HEAD | `f78ef7642542e64416d8cbd2a032c8e072505015` |
| `origin/main` | `f78ef7642542e64416d8cbd2a032c8e072505015` |
| Working tree | CLEAN |
| Remote | `https://github.com/startupmini/minicode.git` |
| Last milestone | P3.4 VALID (N1 hardened, commit `f78ef76`) |

---

## 3. Roadmap Truth

`P3_ROADMAP.md` §3 defines P3.5 = **Runtime Context Adapter**, responsibilities:
carry `revision` into the runtime; preserve `ModelContextProvenance`; bridge headless
`context.compacted` (durable marker without the presentation adapter); make the runtime
lifecycle freshness-aware; provide the runtime-facing adapter seam.

| Concern | Current owner | Evidence | P3.5 scope? |
| --- | --- | --- | --- |
| Runtime revision propagation | none (dropped at seed) | `setup.ts:960` | **YES** |
| `ModelContextProvenance` propagation | none (type-only) | `context-identity.ts:384` (no constructors) | **YES** |
| Headless `context.compacted` bridge | presentation adapter only | `adapter.ts:968`; autonomous path lacks it | **YES** |
| Full-history fold renderer | P3.7 | `P3_ROADMAP.md` §3 | NO (P3.7) |
| Durable projection producer | P3.4 (VALID) | `context-projection.ts` | NO (done) |
| Semantic relevance ranking | later | `P3_ROADMAP.md` §3 P3.4 non-goals | NO |
| Attach history-presence gate | hardening | P3 audits | NO |
| Conflict diagnostics | hardening | P3 audits | NO |

No closure criteria for P3.5 are yet written; this audit proposes the test contract (§21).

---

## 4. Runtime Context Type Inventory

| Type | Definition / File | Owner | Durable | Authority | Mutable | Consumers | Writers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ContextIdentity` | `context-identity.ts:63` | P3.2 | no | derived | immutable | selector | P3.2 pure fn |
| `ContextFrontier` | `context-identity.ts:81` | P3.2 | no | derived | immutable | selector, (provenance) | P3.2 pure fn |
| `ContextFreshness` | `context-identity.ts:36` | P3.2 | no | derived | — | selector | P3.2 pure fn |
| `ModelContextProvenance` | `context-identity.ts:384` | P3.2 | no | derived | immutable | **none (type-only)** | none |
| `ContextSelection` | `context-selector.ts` | P3.3 | no | derived | immutable | setup seed | selector |
| `SelectableRow` / rows | `context-selector.ts:91` | P3.3 | no | derived | — | selector | setup read |
| `ContextStore` | kernel `history.ts:12` | kernel | no | runtime buffer | yes | loop/executor | kernel append/replace |
| `SessionConfig.initialMessages` | kernel `session.ts:52` | kernel | no | — | — | kernel seed | setup |
| `revision` | derived count | P3.2 | no (from durable events) | derived | — | selector, setup | `countDurableCompactions` |
| `sessionId`/`threadId` | `persistence.ts` schema | persistence | yes | authoritative ref | no | all | persistence |
| `writer_epoch` | `persistence.ts` schema | P2.2 | yes | authoritative fence | takeover-only | saveSession | persistence |
| `context.compacted` (durable event) | `events.ts:265,432` | presentation | yes (durable+replayable) | derived evidence | no | reducer, ACP, revision | adapter bridge |
| `historyCommit` / `anchorEventId` | `context-identity.ts` | P3.2 | no | derived | immutable | selector/frontier | P3.2 pure fn |

**Reuse conclusion:** P3.5 needs **no new type**. `ContextSelection`,
`ContextFrontier`, `ContextFreshness`, `ModelContextProvenance` are sufficient; the
adapter transports them.

---

## 5. Full Context Lifecycle (reconstructed)

```
Canonical History (messages)
   │ read-only (loadThreadHistoryWithSeq, persistence.ts)
   ▼
P3.2 Identity / Frontier / Freshness (deriveFrontierFromDurable — setup.ts:945)
   │
   ▼
P3.4 Durable Projection (history_projections — readConsumableSummaryProjection, setup.ts:930)
   │
   ▼
P3.3 Context Selector (selectContext — setup.ts:951)
   │
   ▼
ContextSelection (RAM, immutable)
   │ ✱ ONLY messages + contextOnly survive (setup.ts:960)
   ▼
Runtime Seed (SessionConfig.initialMessages → ContextStore.appendAll, kernel session.ts:165)
   │
   ▼
Kernel ContextStore (loop.ts:34-…)  →  Model/Tool execution
   │
   ▼
Context Compaction (compactStore — loop.ts:342)  →  in-memory bus event context:compacted
   │   [adapter installed? → durable context.compacted via adapter.ts:968 + persist flush]
   ▼
persistCurrent (setup.ts:1997+)  →  flushPresentationEvents → saveSession (P2.7)
   │   compacted non-prefix → RefusedHistoryRewriteError → explicit shrinkThreadHistory
   ▼
Canonical History
```

| Transition | Caller | Input | Output | Identity | Frontier | Revision | Provenance | Freshness | Durable | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| canonical → frontier | setup.ts:945 | rows+revision | `ContextFrontier` | session/thread/anchor | full | carried | via commit | — | no | throws on corrupt |
| frontier → selection | setup.ts:951 | rows+proj+frontier | `ContextSelection` | session/thread | baseSeq/head | carried | basis+commit | computed | no | UNKNOWN fallback |
| selection → runtime seed | setup.ts:960 | ContextSelection | raw messages | **session/thread only** | **DROPPED** | **DROPPED** | **DROPPED** | **DROPPED** | no | none |
| runtime → compaction | loop.ts:342 | ContextStore | replaced buffer + event | — | buffer-local | — | — | — | event only via adapter | throws abort |
| compaction → durable marker | adapter.ts:968 | bus event | durable event | session | — | — | reason | — | yes (adapter path) | silent if no adapter |
| runtime → publication | setup.ts:2032 | buffer/durableHistory | canonical rows | session/thread | — | — | shrink flags | — | yes | P2.7 refusal |

**First point of information loss: the runtime seed boundary** (§6). Second: the durable
`context.compacted` marker on adapterless paths (§9).

---

## 6. Runtime Seed Boundary Audit (exact current code)

`cli/setup.ts:951-964`:

```ts
const selection = selectContext({ sessionId, threadId, rows, revision, projection, policy, canonicalFrontier })
initialMessages = selection.messages as readonly Message[]   // ← only field copied
if (selection.contextOnly) { contextOnlyArtifact = …; contextCanonicalBaseline = … }
```

`SessionConfig.initialMessages` (kernel `session.ts:52`) is `appendAll`-ed into the
`ContextStore` (`session.ts:165`). There is **no metadata channel** on the kernel config.

| Field | Status | Detail |
| --- | --- | --- |
| `sessionId` | PRESERVED | lives on the host handle, not the kernel |
| `threadId` | PRESERVED | host handle |
| `baseSeq` | **DROPPED** | not carried past setup.ts:960 |
| `anchorEventId` | **DROPPED** | — |
| `headSeq` / `lastSeenSeq` / `lastSeenEventId` | **DROPPED** | — |
| `revision` | **DROPPED** | recomputed only at next resume |
| `historyCommit` | **DROPPED** | — |
| `selectionBasis` | **DROPPED** | only logged (`[select …]`) |
| `ModelContextProvenance` | **DROPPED** | never constructed |
| `freshness` | **DROPPED** | only logged |
| `coverage` (`coveredSeq`) | **DROPPED** | only logged |

**Conclusion:** the drop is accidental (nothing reconstructs it during the session; the
runtime cannot answer "which canonical state produced this context"). Legitimate
transformations (kernel message snapshot) are distinct from this loss.

---

## 7. Adapter Responsibility

The adapter should be a **thin, host-side, lifecycle transport**:

1. Carry `ContextSelection`-derived metadata (`identity`, `frontier`, `revision`,
   `selectionBasis`, `freshness`, `coverage`) **beside** the seed into the runtime handle.
2. Bridge compaction lifecycle: on paths without the presentation adapter, write the
   durable `context.compacted` marker via the **existing** `appendPresentationEvents`
   primitive (epoch-fenced, idempotent) — no new store.
3. Expose freshness/coverage to runtime consumers **without fabricating revision**.

The adapter must NOT: query/be canonical authority; reconstruct canonical history;
write `messages`/turns/heads/runs; persist projections; recompute selection; change
publication policy; become a memory store; introduce a second revision authority.

---

## 8. Revision Semantics

- **Definition:** `revision` = count of **durable** `context.compacted` events
  (`countDurableCompactions`, `context-identity.ts:369`), read from `loadPresentationEvents`.
- **What increments it:** each kernel compaction (`loop.ts:74` pressure, `:185` recovery)
  that is bridged by the adapter and flushed by `persistCurrent`.
- **What it identifies:** the canonical-space compaction epoch (how many times canonical
  history was rewritten by compaction/shrink) — **not** a runtime buffer version.
- **Relationship:** `revision` (space, compaction count) ⊥ `headSeq` (position) ⊥
  `historyCommit` (content) ⊥ `anchorEventId` (head identity). `compareContextFrontier`
  treats revision mismatch as `DIVERGED`.
- **Undercount mechanism:** a kernel `context:compacted` that is not bridged (no adapter)
  never becomes durable → `countDurableCompactions` misses it. **Classification: MISSING
  EVENT BRIDGE** (autonomous child path via `createMinicodeSession`).
- **Failure to fabricate:** the adapter must NOT manufacture a higher revision to make
  runtime state appear current.

**Minimum P3.5 contract for revision:** every kernel `context:compacted` must reach a
durable `context.compacted` on ALL execution paths (normal via adapter; adapterless via the
bridge), and the runtime handle must carry the observed `revision` for freshness
comparison at publish/resume — without inventing counts.

---

## 9. `ModelContextProvenance` Lifecycle

- **Who creates it:** nobody (type-only at `context-identity.ts:384`).
- **Who attaches it:** nobody.
- **Immutable:** yes (readonly fields).
- **Derived from canonical:** yes (identity + canonicalFrontier + selectionBasis).
- **Tied to `ContextSelection`:** structurally compatible (selectionBasis is in both), but
  not constructed from it.
- **Preserved at seed:** NO. **After compaction:** NO. **Headless:** NO.
- **Needed for publication safety?** NO — publication is P2.7-guarded; provenance is for
  runtime observability + freshness reasoning.
- **Failure mode if absent:** PROVENANCE LOSS + OBSERVABILITY LOSS (not a safety violation;
  not freshness loss per se — freshness is recomputable from canonical at resume).

**P3.5 should PROPAGATE the existing shape** (`ContextIdentity` +
`ContextFrontier` + `selectionBasis`), not redesign the schema. The adapter constructs a
`ModelContextProvenance` from the `ContextSelection` at seed time.

---

## 10. Normal CLI Path

`createCliSession` (setup.ts) → resume seam (`assembleContext` + `selectContext`) → seed
`initialMessages` → kernel loop → compaction (`context:compacted` bus) → presentation
adapter (`context.compacted` durable) → `persistCurrent` (flush + `saveSession`; compacted
non-prefix → explicit shrink).

Consistent. The only gap is the seed-metadata drop (§6) and the fact that freshness is
recomputed only at resume (never during the live session).

---

## 11. Headless Execution

| Entrypoint | Session factory | Adapter installed? | `context.compacted` durable? | Revision observed? |
| --- | --- | --- | --- | --- |
| `cli/commands/acp.ts` | `createCliSession` | yes | yes | yes |
| `cli/commands/exec.ts` | `createCliSession` | yes | yes | yes |
| autonomous child (`tools/task.ts:333` via `createMinicodeSession` DI) | kernel `createSession` | **no** | **no** | **undercount** |

- **Same logical runtime context:** yes (same kernel `ContextStore`).
- **Same identity/frontier/provenance:** children get none (no seed metadata) — same as
  normal path today.
- **Same authority model:** yes — `saveSession` remains the sole canonical writer; children
  are not a different authority.
- **Compacted buffer as canonical?** No — non-prefix publication is refused; only the
  explicit shrink route rewrites, provenance-marked.
- **Direct publication bypass:** none.

**Distinction:** headless has a **different bridge coverage**, not different authority
semantics. P3.5 closes the bridge on the adapterless path.

---

## 12. `context.compacted` Event Contract

| Aspect | Fact |
| --- | --- |
| In-memory event | `context:compacted` (kernel loop bus; `ui/contract.ts:58`) |
| Durable event | `context.compacted` (presentation; `events.ts:265`, durable+replayable `:432`) |
| Producer (bridge) | presentation adapter `adapter.ts:968-974` (only bridge) |
| Consumers | `persistence.ts:625` (reducer validation), `setup.ts:526`, `acp.ts:287`, `reducer.ts:622`, `countDurableCompactions` |
| Schema | `{ type, eventSeq, turnId, reason }` |
| Triggers | kernel budget-pressure compaction, recovery compaction |
| Durable consequences | yes (when bridged + flushed) |
| Failure surfacing | silent (no durable marker → revision undercount) |
| Idempotent | `appendPresentationEvents` dedups identical payloads (`persistence.ts:833-839`) |
| Repeated delivery possible | yes (each kernel emit → one durable event; dedup makes same-payload re-delivery safe) |
| Missing delivery detectable | **NO** (undercount only observable by comparing runtime compaction vs durable count) |

**P3.5 guarantee needed:** durable delivery of `context.compacted` on every execution path;
idempotent (existing primitive); missing delivery surfaced or at least comparable.

---

## 13. Compaction Lifecycle

| Field | Effect | Class |
| --- | --- | --- |
| Runtime message sequence | replaced by fold result | PRESERVED (new sequence) |
| Runtime buffer coverage | folded prefix + kept tail | TRANSFORMED |
| Summary content | kernel/LLM fold | DERIVED |
| Selection provenance | not updated during run | UNCHANGED (lost) |
| Runtime revision | not carried | DROPPED |
| Canonical `headSeq` | unchanged (until publish) | UNCHANGED |
| Canonical revision | +1 per durable marker (adapter path) | ADVANCED |
| Projection state | invalidated on shrink | INVALIDATED |
| `historyCommit` | recomputed at next select | DERIVED |
| Future publication eligibility | non-prefix → refused → explicit shrink | DERIVED |

Invariants verified: `SELECTION ≠ COMPACTION` (selector never compacts),
`COMPACTION ≠ PROJECTION GENERATION` (compaction is kernel; projection is P3.4 producer),
`PROJECTION GENERATION ≠ CANONICAL PUBLICATION` (producer writes cache only). No P3.7 fold
engine is implied.

---

## 14. Authority Analysis

| Component | Reads | Writes | Durable | Authority |
| --- | --- | --- | --- | --- |
| Canonical history (`messages`) | via persistence | persistence only | yes | **AUTHORITATIVE** |
| `saveSession` (P2.7) | canonical rows | `messages` (append/explicit shrink) | yes | **CANONICAL DECIDER** |
| P3.2 identity/frontier | rows (passed in) | none | no | DERIVED (descriptive) |
| P3.3 selector | rows+projection | none | no | DERIVED (view) |
| P3.4 producer | canonical rows | `history_projections` only | yes | DERIVED (cache) |
| `history_projections` | — | producer/build/shrink | yes | DURABLE-BUT-DERIVED |
| **P3.5 adapter (candidate)** | `ContextSelection` + durable events | `presentation_events` via `appendPresentationEvents` (bridge only) | via bridge | DERIVED (lifecycle transport) |
| `ContextStore` | — | kernel append/replace | no | RUNTIME BUFFER (not authority) |
| `context.compacted` consumer | durable events | none | — | derived evidence |

Principles hold: canonical = sole history authority; P3.2 describes; P3.3 selects; P3.4
produces derived cache; P3.5 transports; `ContextStore` = buffer; P3.1/P2.7 = publication
safety. The adapter candidate writes **only** durable evidence events (same channel as the
presentation adapter today), never canonical history.

---

## 15. Publication Boundary

Every route (normal CLI, acp, exec, turn completion, close, resume, recovery, stale-writer,
explicit shrink, backfill) funnels persistence through **`persistCurrent` → `saveSession`**
(the only `saveSession` caller, `cli/setup.ts:2032`). Each is: epoch-fenced, run-gated,
append-only-or-explicit-shrink, cannot bypass `saveSession`. The adapter adds no
publication path; it must remain outside publication authority. **PRESERVED.**

---

## 16. Failure and Recovery Semantics

| Case | Current behavior | Desired (P3.5) |
| --- | --- | --- |
| seed incomplete (metadata dropped) | silent (messages only) | ACCEPT + carry metadata or explicit UNKNOWN |
| revision missing | undercount (adapterless paths) | SURFACE or compare |
| provenance missing | silent | OBSERVABILITY warning; never treat as trusted |
| canonical frontier unavailable | selector → UNKNOWN full view | RECONSTRUCT FROM DURABLE AUTHORITY (recompute frontier) |
| source projection stale | rule-8 consumed / rule-7 rejected (N1) | unchanged |
| freshness UNKNOWN | explicit label | unchanged (never promote) |
| headless compaction | marker missing | bridge writes durable marker |
| `context.compacted` delivery fails | silent undercount | SURFACE (warn) or compare |
| runtime/canonical disagree | P2.7 refusal at publish | unchanged (publication safety) |
| resume after compaction | revision from durable count; buffer from selector | preserve + carry |

No blind retry; no silent UNKNOWN→fresh.

---

## 17. Existing Code Reuse

| Candidate | Classification | P3.5 use |
| --- | --- | --- |
| `deriveFrontierFromDurable` | REUSE | reconstruct frontier for provenance |
| `rowsToCanonicalRefs` | REUSE | canonical refs |
| `readConsumableSummaryProjection` | REUSE | projection at seed |
| `selectContext` / `ContextSelection` | REUSE | selection + metadata source |
| `ModelContextProvenance` | REUSE | construct from ContextSelection |
| `appendPresentationEvents` | REUSE | headless durable `context.compacted` bridge (idempotent, epoch-fenced) |
| `countDurableCompactions` | REUSE | revision source |
| kernel `SessionConfig.initialMessages` | EXTEND (host-side handle only) | the adapter carries metadata OUTSIDE the kernel |
| presentation adapter bridge | REUSE (normal path) | already functional |

No duplicate P3.2/P3.3/P3.4 logic needed. The adapter is a composition, not a new
subsystem.

---

## 18. Non-Goals and Phase Boundaries

Outside P3.5 (roadmap §3 + this audit): P3.4 (VALID, closed), P3.7 (A+C fold producer /
full-history fold renderer), semantic relevance ranking, embedding/vector search, new
memory database, speculative context caching, attach history-presence gate, conflict
diagnostics, CLI flakes, pre-existing typecheck debt. None has a causal dependency on P3.5;
P3.5 needs only the `context.compacted` bridge and metadata transport.

---

## 19. Test Graph

Current tests touching revision/provenance: `context-identity.test.ts` (pure P3.2),
`context-selector.test.ts`, `context-projection.test.ts` (P3.4). **No existing test covers
runtime seed metadata propagation, `ModelContextProvenance` construction, or the headless
`context.compacted` bridge.**

| Required test (P3.5) | Classification | Coverage today |
| --- | --- | --- |
| seed metadata propagation (frontier/revision/basis carried) | REAL PRODUCTION PATH | ABSENT |
| identity preservation at seed | REAL PRODUCTION PATH | PARTIAL (host-level) |
| revision propagation | REAL PRODUCTION PATH | ABSENT |
| `ModelContextProvenance` constructed from selection | PURE FUNCTION | ABSENT |
| normal CLI path end-to-end | REAL PRODUCTION PATH | PARTIAL (cli-session) |
| headless bridge writes durable marker | REAL PRODUCTION PATH | ABSENT |
| `context.compacted` dedup/idempotency | REAL PRODUCTION PATH | ABSENT (primitive is tested) |
| resume after compaction (revision) | REAL PRODUCTION PATH | PARTIAL |
| UNKNOWN never promoted | PURE/STRUCTURAL | PRESENT (P3.2/P3.3) |
| publication boundary | REAL PRODUCTION PATH | PRESENT (P3.1/P3.3-32) |
| identity isolation | PURE | PRESENT (P3.2/P3.4) |

---

## 20. Non-Vacuity Contract (future P3.5 tests)

1. Remove revision propagation → seed/revision test fails.
2. Remove provenance propagation → provenance test fails.
3. Bypass headless `context.compacted` bridge → durable-marker test fails.
4. Feed stale/UNKNOWN as trusted → freshness test fails (existing guard).
5. Bypass P2.7 → boundary test fails (existing).

These are future test requirements, not audit mutations.

---

## 21. P3.5 Data Contract

| Field | SOURCE | MEANING | CONSUMER | DURABILITY | LOSS IF ABSENT | RECONSTRUCTION |
| --- | --- | --- | --- | --- | --- | --- |
| `sessionId` / `threadId` | handle / selection | identity scope | runtime, publish | durable (canonical) | mis-scope | — |
| `ContextIdentity` | `ContextSelection` | view identity | runtime provenance | ephemeral | provenance loss | from canonical rows |
| `ContextFrontier` | `ContextSelection`/derive | coverage+commit | runtime, publish-time | ephemeral | freshness reasoning loss | recompute from rows |
| `revision` | `countDurableCompactions` | compaction epoch | freshness | from durable events | undercount | durable events |
| `historyCommit` | `ContextSelection` | content binding | provenance | ephemeral | F-05 detection loss | recompute |
| `anchorEventId` | `ContextSelection` | head identity | provenance | ephemeral | staleness misjudge | recompute |
| `selectionBasis` | `ContextSelection` | why this view | observability | ephemeral | observability loss | — |
| `coverage` (`baseSeq`) | `ContextSelection` | partial coverage | runtime | ephemeral | mislabeled completeness | recompute |
| `ModelContextProvenance` | adapter (constructed) | transport bundle | runtime/observability | ephemeral | provenance loss (observability) | from selection |

Essential: identity, frontier, revision, coverage. Optional observability: selectionBasis,
freshness label. No schema change required.

---

## 22. Minimal Implementation Design

- **Primary problem:** runtime cannot answer "which canonical state produced this
  context", and adapterless headless paths lose the durable compaction marker.
- **Primary capability:** carry `ContextSelection` metadata into the runtime handle and
  bridge compaction to a durable marker on all paths.
- **Adapter responsibility (one thin seam):** (a) construct a `ModelContextProvenance`
  from the `ContextSelection` at seed; (b) keep it on the session handle (host memory, no
  store); (c) on paths without the presentation adapter, subscribe to the kernel
  `context:compacted` bus and write the durable `context.compacted` via
  `appendPresentationEvents` (idempotent, epoch-fenced).
- **Inputs:** `ContextSelection`, kernel bus, `cwd`, `expectedEpoch`, `sessionId`.
- **Outputs:** runtime metadata handle + durable marker (when bridged).
- **Lifecycle entrypoints:** resume seed (`setup.ts:960`), kernel loop subscription
  (adapterless sessions), `persistCurrent` flush.
- **Revision/provenance contract:** propagate observed revision; never fabricate;
  construct `ModelContextProvenance` from selection.
- **Headless bridge contract:** every `context:compacted` → durable `context.compacted`
  (dedup safe).
- **Authority:** reads only; writes only `presentation_events` (same channel the
  presentation adapter uses today).
- **Failure semantics:** missing bridge → warn + surface; UNKNOWN stays UNKNOWN.
- **Reuse:** functions in §17; no new kernel/vendor changes; `SessionConfig` untouched
  (metadata is host-side).
- **New file:** `src/session/context-adapter.ts` (thin composition).
- **Likely changed:** `cli/setup.ts` (attach adapter at seed; wire into the resume seam),
  the autonomous-child factory (`task.ts`/`autonomous-context.ts` — attach the adapter).
- **Required tests:** §19 rows.
- **Validation:** P3.2/P3.3/P3.4 suites + new adapter tests + `tsc --noEmit` + full suite.
- **Rollback:** adapter is additive; detaching it restores today's behavior.

---

## 23. Hard Invariants

```
I1  Canonical history remains sole history authority.
I2  ContextStore remains a runtime buffer.
I3  Adapter never writes canonical history.
I4  Identity survives seed/resume transitions.
I5  Frontier/freshness preserved or explicitly UNKNOWN.
I6  Revision is propagated, not fabricated.
I7  ModelContextProvenance survives supported lifecycle transitions.
I8  Compaction notification is distinct from canonical publication.
I9  Missing event/provenance does not silently become trusted state.
I10 Repeated event delivery is safe (idempotent) or explicitly rejected.
I11 Normal and headless paths retain equivalent authority semantics.
I12 P3.1/P2.7 remains the publication safety boundary.
I13 P3.4 projection semantics remain unchanged.
I14 P3.7 fold scope remains deferred.
```

All are consistent with the current architecture; I1–I4, I8, I11–I14 verified directly.

---

## 24. P3.5 vs P3.7 Boundary

| Concern | P3.5 | P3.7 | Later | Rationale |
| --- | --- | --- | --- | --- |
| Runtime revision propagation | ✔ | | | roadmap |
| `ModelContextProvenance` bridge | ✔ | | | roadmap |
| Headless `context.compacted` bridge | ✔ | | | roadmap; adapter.ts:968 is the only bridge |
| Full-history fold renderer | | ✔ | | roadmap |
| A+C advanced fold producer | | ✔ | | roadmap |
| Projection cache | | | ✔ (P3.4 done) | closed |
| Semantic ranking | | | ✔ | roadmap |
| Attach history-presence gate | | | ✔ (hardening) | audits |
| Conflict diagnostics | | | ✔ (hardening) | audits |

P3.7 scope is not shifted into P3.5.

---

## 25. Validation Health

Last known envelope: **4410 pass / 23 skip / 8 fail** (299 files, P3.4 N1 hardening run;
8 = 5 flakes + 3 pre-existing). P3.5 implementation must re-run: P3.2, P3.3 (selector +
resume), P3.4 (producer + N1), P3.1 guard, P2.7 persistence, writer-inventory,
architecture-map, new adapter tests, `tsc --noEmit` (expect 28 pre-existing, 0 new), full
suite.

---

## 26. Risk Matrix

| ID | Risk | Classification | Evidence |
| --- | --- | --- | --- |
| R1 | adapter = second authority | NOT PRESENT | writes only `presentation_events`; canonical funnel single |
| R2 | revision fabricated | POSSIBLE (guard needed) | must reuse `countDurableCompactions` |
| R3 | provenance dropped at seed | **PRESENT** (today) | setup.ts:960; adapter fixes |
| R4 | headless compaction non-durable | **PRESENT** (autonomous path) | no adapter; bridge fixes |
| R5 | compacted buffer = canonical | NOT PRESENT | P2.7 refusal + explicit shrink |
| R6 | UNKNOWN → fresh | NOT PRESENT | P3.2 explicit labels |
| R7 | CLI/headless authority divergence | NOT PRESENT | same `saveSession` funnel |
| R8 | duplicate adapter logic | POSSIBLE | keep one thin seam, share contract |
| R9 | compaction/publication conflated | NOT PRESENT | distinct seams verified |
| R10 | P3.5 absorbs P3.7 | POSSIBLE | bound by roadmap; fold is P3.7 |
| R11 | P3.4 semantics altered | POSSIBLE | adapter must not touch projection producer |
| R12 | bypass P3.1/P2.7 | NOT PRESENT | single funnel; test guard exists |

---

## 27. Readiness Verdict

**READY TO IMPLEMENT.** The primary problem is clear (runtime seed metadata drop +
adapterless headless compaction marker loss); authority boundaries are valid and verified;
identity/revision/provenance semantics are defined; normal and headless paths are fully
traced; the compaction lifecycle is mapped; failure semantics are explicit; the required
tests are defined (§19); all hard dependencies are present (reusable primitives); P3.4 and
P3.7 boundaries are preserved; no unresolved P3 safety blocker exists.

The one bounded design decision to ratify: the adapter is **host-side metadata transport +
a headless durable-marker bridge reusing `appendPresentationEvents`** (no new store, no
schema change, no kernel/vendor change).

---

## 28. Exact Next Action

**One action:** ratify the adapter shape (host-side `ModelContextProvenance` carrier +
headless `context.compacted` bridge via `appendPresentationEvents`) and implement
`src/session/context-adapter.ts` + the seed/bridge wiring, with the §19 test contract.

(No implementation, commit, or push was performed in this audit.)

---

```text
MINICODE P3.5 ARCHITECTURE STATUS:
READY TO IMPLEMENT

P3.5 problem:
CLEAR

Runtime seed boundary:
PARTIAL

Revision propagation:
PARTIAL

Provenance propagation:
PARTIAL

Headless compaction bridge:
PARTIAL

Normal/headless lifecycle consistency:
PASS

Authority model:
PASS

ContextStore remains non-authoritative:
PASS

Publication safety:
PRESERVED

Failure semantics:
DEFINED

P3.4 boundary:
PRESERVED

P3.7 boundary:
CLEAR

Hard dependencies:
PRESENT

Test contract:
DEFINED

Blocking findings:
NONE

Non-blocking findings:
1. Runtime seed boundary drops ContextSelection metadata (frontier/revision/basis/freshness/coverage) — the confirmed gap the adapter closes.
2. ModelContextProvenance is type-only (never constructed/attached) — provenance is an observability/freshness loss today, not a safety violation.
3. Headless `context.compacted` durable marker is bridged ONLY by the presentation adapter; autonomous children (createMinicodeSession) have no adapter → revision undercounts (MISSING EVENT BRIDGE).
4. Missing durable-marker delivery is currently silent (undetectable) — the adapter should surface/comparable it.
5. One design decision to ratify: host-side metadata transport + bridge reusing appendPresentationEvents (no new store/schema/vendor).

P3.5:
READY TO IMPLEMENT

P3.7:
NOT STARTED

Recommended next action:
Ratify the host-side adapter shape (ModelContextProvenance carrier + headless context.compacted bridge via appendPresentationEvents), then implement src/session/context-adapter.ts with the §19 test contract.

CONFIDENCE:
HIGH
```