# P3.3 — Canonical Context Selector: Architecture & Contract Design Audit

Read-only architecture/contract audit. No source, test, config, or docs modification;
no git mutation. Current canonical code is authoritative over historical reports. Every
claim below was verified against the live tree at HEAD `0597f76`.

---

## 1. Executive Summary

P3.3 is the **Canonical Context Selector**: the read-only component that, given the
current canonical session/thread state plus a budget/policy, decides **which canonical
evidence becomes the next runtime context view**.

The audit establishes that:

1. **A selector already exists in embryonic form** — `src/session/context-assembly.ts`
   (`assembleContext`, P2.8). It performs the current selection: *"whole canonical thread
   history"* (fallback) or *"CURRENT projection summary + canonical tail"*. P3.3 does not
   invent selection from nothing; it **generalizes this existing, already-disciplined seam**
   into a budget-aware, provenance-carrying, multi-policy selector, without changing its
   authority character.
2. **The authority boundary is already correct and must be preserved verbatim**: selector
   = derived, read-only, RAM-only; the *decision* to publish stays in `saveSession`
   (P2.7); the *description* of freshness stays in P3.2. The selector must be a
   **describer/reader**, never a decider/writer.
3. **P3.2 gives the selector everything it needs to bind a view to canonical state**
   (`ContextIdentity`, `ContextFrontier`, `anchorEventId`, `historyCommit`, `revision`,
   `compareContextFrontier`, `assessContextFreshness`) — and P3.2 already reserves the
   exact output field the selector needs: `ModelContextProvenance.selectionBasis`.
4. **Budget semantics already exist** and are separated from correctness: the kernel's
   `estimateSessionContext` (messages+system+tools), `defaultBudgetPolicy`, and
   `keepRecentTurns`/`contextWindowTokens`. The selector must own **selection
   correctness** and *reference* the token estimator; it must not own model-specific
   optimization.
5. **Failure semantics must be non-deceptive by default**: empty → empty view (not
   error); unverifiable/UNKNOWN → the *safe-widest* fallback (full canonical view) with an
   explicit `UNKNOWN` freshness carried in provenance — never a silently narrower context
   presented as certain.

No blocking finding exists. The one genuine design obligation is to **define the
`selectionBasis` vocabulary and the partial-coverage frontier semantics** (a
`baseSeq > 0` window), because P3.2 only models the shape and P2.8 only ever emitted two
coverage shapes (`full` and `summary+tail`).

**Verdict: READY WITH CONDITIONS.** P3.3 can be implemented; the conditions are the
concrete contract decisions enumerated in §20 (all derivable now, none requiring new
authority).

---

## 2. Current Input Authority

What P3.3 is allowed to **observe** (read-only). Derived from source, not assumptions.

| Input | Source | Authority | Durable | Mutable | Read-only to selector |
| --- | --- | --- | --- | --- | --- |
| Canonical session state | `sessions` (`persistence.ts:93`) | AUTHORITATIVE | yes | via owner | YES |
| Canonical thread history | `messages` (`:94`), `loadThreadHistoryWithSeq` (`:1290`) | AUTHORITATIVE | yes | append-only via `saveSession` | YES |
| Event identity | `messages.event_id` | AUTHORITATIVE | yes | immutable once written | YES |
| Event sequence | `messages.seq` (PK position) | positional (not identity) | yes | re-numbered only by explicit shrink | YES |
| Thread identity / lineage | `threads` (`:271`: `thread_id`, `parent_thread_id`, `fork_event_seq`) | AUTHORITATIVE (identity); `head_seq` = CACHE | yes | via owner | YES |
| Run identity | `runs` (`:273`) | AUTHORITATIVE (lifecycle) — **NOT a context input** | yes | run transitions | YES (but selector must not read it as context) |
| Writer epoch | `sessions.writer_epoch` (`:93`, P2.2) | AUTHORITATIVE fence | yes | CAS via owner | YES (observable; selector must not act on it) |
| Context identity | `ContextIdentity` (P3.2, `context-identity.ts:63`) | DERIVED | no | pure function output | YES |
| Context frontier | `ContextFrontier` (P3.2, `:81`) | DERIVED | no | pure function output | YES |
| History commitment | `historyCommit` (P3.2, `:190`) | DERIVED | no | pure | YES |
| Revision | `countDurableCompactions` (P3.2, `:369`) over durable `context.compacted` | DERIVED | (event is durable) | derived count | YES |
| Projections | `history_projections` (`:279` area; `getProjection`/`getProjectionStatus`) | **CACHE/derived** | yes | via owner | YES |
| System prompt inputs | `policy/context.ts` (MEMORY/AGENTS/repomap/env) | DERIVED, untrusted data | no | rebuilt per process | YES (via assembly, not raw) |
| Token estimator | kernel `tokens.ts` (`estimateSessionContext`, `estimateMessage`) | DERIVED (pure) | no | injected policy | YES |
| Budget window | `contextWindowTokens`, `keepRecentTurns` (cli args → session) | DERIVED policy input | no | per session | YES |

**Constraint (must hold):** the selector must not read `runs`/`run_id`/
`last_persisted_seq` as a context input — `context-assembly.ts:13` explicitly forbids it,
and P3.0 §5 rejects `run_id` from context identity. Run state is execution evidence, not
context.

**The selector must never invent authoritative state.** Every field in its output must be
either (a) a **reference** to canonical identity (`session_id`, `thread_id`, `event_id`,
`seq`) or (b) a **derived value** recomputed from canonical rows
(`historyCommit`, `revision`, `anchorEventId`). No selector-generated IDs, no
selector-owned counters, no selector-cached canonical facts.

---

## 3. Selector Semantic Definition

The selector is **not** `history.slice(...)`. The precise semantic operation it must
perform:

> Given `(sessionId, threadId, canonical rows, budget/policy)`, produce the **derived
> context view** — an ordered, provenance-tagged, budget-bounded selection of canonical
> evidence — that will seed the runtime `ContextStore`, such that every selected element
> can answer *"from exactly which canonical state was this derived?"*.

Dimensions the selector must reason about (derived from the current architecture, not
invented):

| Dimension | Needed? | Why (from current code) |
| --- | --- | --- |
| Latest turns / recency tail | **YES** | `mechanicalCompaction` keeps recent turns; `assembleContext` keeps canonical tail after coverage |
| Compaction/fold boundary | **YES** | Projection `base_seq` + `boundaryIsSafe` define a safe cut |
| Durable projections (summary) | **YES** | `SUMMARY_PROJECTION_ID` CURRENT → summary + tail |
| Token/size budget | **YES** | kernel budget + `contextWindowTokens`/`keepRecentTurns` |
| System prompt overhead | **YES (reference)** | `estimateSessionContext` includes system+tools; selector must reserve for them |
| Tool-result overhead | **YES (reference)** | tool results are heavyweight; must count via estimator, not raw length |
| Provenance | **YES** | P3.2 `ModelContextProvenance`; P2.8 `contextOnly` fingerprint |
| Freshness / frontier | **YES** | P3.2 `assessContextFreshness`, `compareContextFrontier` |
| Determinism | **YES** | P2.8 assembly is deterministic; keep it |
| Pinned facts (memory/RAG) | **NO (out of selector scope)** | RAG is injected as `systemExtra` (`policy/context.ts`), a separate channel; D4 timing is OPEN and belongs to P3.11 |
| Semantic relevance ranking (LLM/embedding) | **NO (not now)** | Current architecture has no relevance-ranked context selection; introducing it would add nondeterminism. Minimum contract first. |
| User intent classification | **NO** | No such primitive exists; out of scope |

**Minimum semantic contract:** select a **contiguous, order-preserving, boundary-safe
segment** of the canonical thread — optionally prefixed by a durable projection summary —
bounded by an explicit budget, scoped by `(sessionId, threadId)`, tagged with a frontier
whose `historyCommit` binds it to the exact canonical content. **Segmentation, not
ranking.** (Ranking/relevance is an explicit non-goal for P3.3; it would require a new
nondeterministic authority.)

---

## 4. Selector vs Reconciliation vs Publication vs Persistence

Boundary model, verified to already hold for the P2.8 seam:

```
                 CANONICAL HISTORY (messages)  [AUTHORITY: persistence.ts]
                          │  read-only
                          ▼
     SELECT (P3.3)  ── derived ContextSelection ── no writes, no authority
                          │
                          ▼
     ASSEMBLY (P2.8 assembleContext) ── derived ContextView (RAM)
                          │
                          ▼
     RUNTIME CONSUMPTION (ContextStore, kernel) ── EXECUTION-LOCAL
                          │
                          ▼
     optional PUBLICATION REQUEST (persistCurrent)
                          │
                          ▼
     PUBLISH/RECONCILE/PERSIST = P3.1 decision + P2.7 safety (saveSession)
                          │
                          ▼
     CANONICAL PERSISTENCE (append-only; refuse otherwise)
```

| Stage | Owner | Writes canonical? | Authority |
| --- | --- | --- | --- |
| **SELECT** | P3.3 (new) | NO | Derived/descriptive |
| **RECONCILE** | P2.7 `saveSession` prefix-check | only via accept | Deciding |
| **PUBLISH** | `persistCurrent` (composition root) | requests only | Orchestration |
| **PERSIST** | `persistence.ts` | yes (append/explicit-shrink) | Authoritative |

**Boundary check against existing paths:**

- `assembleContext` — read-only, no writes (guard: `context-assembly.test.ts` P2.8-14/15/16/17). **Compliant.**
- `persistCurrent` — writes only via `saveSession`/explicit shrink. **Compliant.**
- **No existing path violates the boundary.** The selector inherits this discipline and
  must not add one.

**The selector must NOT:** rewrite history · reconcile conflicting history · silently
repair history · persist canonical events · mutate canonical state · become a second
session store. All six are non-negotiable.

---

## 5. P3.2 Integration Contract

P3.2 is the source of truth for identity/frontier/freshness. The selector consumes it as
follows (mapping directly to current P3.2 semantics — no new meaning invented):

| Selector condition | Meaning (P3.2) | Selector behavior |
| --- | --- | --- |
| `EQUAL` | view frontier equals canonical frontier; content commit equal | Emit the view as-is; freshness `FRESH`; `selectionBasis` = the policy that produced it. No rebuild needed. |
| valid **advance** (`B_AHEAD`/canonical ahead) | canonical extended beyond the view; view still a prefix | Rebuild the view against the current canonical head; freshness `STALE` for the *old* view, but the *new* selection is `FRESH`. Selector re-derives; it never "patches" the old buffer. |
| `DIVERGED` | same position, different content/commit; or revision differs (post-compaction) | Selector **still produces a derived view from current canonical** (it is a reader), but it **must not** treat any prior view/buffer as reconcilable. Freshness `DIVERGED`; provenance carries the canonical frontier it derived from. It does **not** decide anything about publication. |
| `UNKNOWN` | unprovable (null/invalid side, foreign session/thread, future revision, head beyond canonical) | Freshness `UNKNOWN`. The selector falls back to the **safe-widest** derived view (full canonical thread, read at selection time) and **labels it UNKNOWN**. It must never promote `UNKNOWN → trusted/certain`. |

**Critical rules preserved from P3.2:**

- The selector's freshness comparison is **descriptive**, not the publication authority.
  `saveSession` remains the sole decider. The selector must not call its own freshness
  result a "publication verdict".
- The selector must not turn `UNKNOWN → trusted context`. The current architecture permits
  UNKNOWN-view usage **only** as a transparently-labelled view (P3.0 §15: UNKNOWN must be
  visible, never rendered as success). The selector carries the label forward.
- The selector must not make freshness comparison the canonical authority — this is the
  exact "describe-vs-decide" division the P3 program audit proved consistent.

Mapping to current `ContextView.status` (`ProjectionState`): the selector should emit a
freshness field in its own output (from P3.2) **in addition to** the projection status,
rather than overloading `status`.

---

## 6. Output Contract

Derived minimal `ContextSelection` — the smallest shape that supports every downstream
requirement (assembly, provenance, budget, freshness), grounded in current types.

```
ContextSelection {
  // ── identity (references, NOT copies) ─────────────────────────────
  sessionId: string              // canonical session id (reference)
  threadId: string               // canonical thread id (reference)

  // ── derived frontier (binds view → exact canonical content) ────────
  frontier: ContextFrontier       // P3.2 type; carries baseSeq, headSeq,
                                  // lastSeenSeq, lastSeenEventId, revision,
                                  // anchorEventId, historyCommit

  // ── the selected materialization (RAM-only) ───────────────────────
  messages: Message[]             // vendor-typed; ready for ContextStore.appendAll
  coveredSeq: number              // exclusive coverage end of any summary prefix
  source: ContextSource           // "projection" | "messages" (existing type)

  // ── provenance / reason ────────────────────────────────────────────
  selectionBasis: string          // vocabulary defined in §6.1
  freshness: ContextFreshness     // P3.2: "fresh"|"stale"|"diverged"|"unknown"
  detail: string                  // diagnostic (why fallback, if any)

  // ── budget accounting (references, not authority) ──────────────────
  budget: { limitTokens: number; estimatedTokens: number; reservedForSystemAndTools: number }

  // ── projection artifact discipline (preserve P2.8 behavior) ────────
  contextOnly?: ContextOnlyArtifact   // existing type; must round-trip to stripContextOnly
}
```

Design notes:

- **`frontier` replaces the need to duplicate `revision`/`historyCommit`/`anchorEventId`**
  as separate fields — they are already inside `ContextFrontier`. No duplication.
- **`messages` + `contextOnly` preserve the exact P2.8 contract** so
  `persistCurrent`'s `stripContextOnly`/baseline-rebase logic continues to work
  unchanged (see §9).
- **`budget` is a report, not a decision.** The selector records what it estimated and
  what it reserved for system+tools; it does not assert model-specific truth.
- **Do not add**: a selector ID, a generation counter, a timestamp, a "confidence" score,
  a relevance rank, or a durable handle. None is justified by the current architecture.

### 6.1 `selectionBasis` vocabulary (the one genuine new contract)

Derived from what P2.8 already does and what P3.2 models:

| `selectionBasis` | Meaning | Coverage shape |
| --- | --- | --- |
| `full-history` | all canonical rows, no fold | `baseSeq = 0`, `headSeq = head` |
| `summary-plus-tail` | durable CURRENT projection summary over `[0,B)` + canonical `[B,head]` | `baseSeq = B > 0` |
| `budget-tail` (new, P3.3) | newest boundary-safe contiguous tail fitting the budget; older prefix dropped (unfolded — *no summary synthesized*) | `baseSeq = cut > 0`, but source stays `"messages"` |
| `fallback-unknown` | freshest derivable view when freshness is UNKNOWN | `full-history` shape, freshness `unknown` |

Exactly one `selectionBasis` value per selection. `budget-tail` is the only genuinely new
basis; it is still **ungrounded** in a durable summary (it drops older context rather than
folding it) — a critical correctness property (§9).

---

## 7. Budget Semantics

Current representation of context size (verified):

| Mechanism | Where | Unit |
| --- | --- | --- |
| Token estimator | kernel `tokens.ts:13` (`chars/4` heuristic) | tokens (estimate) |
| Session context size | `estimateSessionContext` (`tokens.ts:97`) = messages + system + tools | tokens |
| Budget pressure | kernel `defaultBudgetPolicy` (`budget.ts:15`) | ratio → low/med/high/critical |
| Window knob | `contextWindowTokens` (cli → session) | tokens |
| Compaction knob | `keepRecentTurns` (`mechanicalCompaction`) | turns |

**Selector responsibility (bounded):**

- **Owns selection correctness**: which contiguous canonical segment is included.
- **References** the token estimator (`estimateMessage`/`estimateSessionContext`) — it must
  not create a competing estimator (drift risk; `tokens.ts:3` names the estimator the
  single source of truth).
- **Reserves** (does not compute) system+tools overhead: `estimateSystem` + `estimateTools`
  are input to the selector so its message budget = `limit − system − tools − reservedOutput`.
- **Does NOT own** model-specific optimization, provider tokenizers, or summarization cost.

**Hard separation:** *selection correctness* (is *this segment* a faithful, boundary-safe,
provenance-bound view of canonical?) is independent of *token optimization* (does it fit?).
A selection is **correct** iff it is a boundary-safe contiguous segment with a frontier
whose `historyCommit` matches the covered rows — regardless of whether it exactly fills the
budget. Fitting the budget is a **feasibility** property, not a correctness property.

---

## 8. Determinism

Required property:

```
same canonical state (rows + revision)
+ same selector policy
+ same budget
= same ContextSelection
```

**Nondeterministic input inventory (must be excluded or bounded):**

| Input | Present in current code? | Selector treatment |
| --- | --- | --- |
| Wall clock (`Date.now`) | used elsewhere, **not** in assembly | **FORBIDDEN** in selection |
| Unordered iteration | rows are `ORDER BY seq` (`loadThreadHistoryWithSeq`) | **excluded** (seq order) |
| Random ranking | none | **excluded** |
| External network | RAG/embedding (separate channel) | **out of selector scope** |
| Model inference | LLM compaction (separate, downstream) | **out of selector scope** |
| Mutable caches | `head_seq` cache — but selector must recompute from rows | **excluded** (recompute, don't trust cache) |
| Object identity / array index | must not influence outcome | **excluded** |

**Conclusion:** the selector can be **fully deterministic** (a pure function over
`(rows, revision, policy, budget)`), exactly as P3.2 and P2.8 already are. No bounded
nondeterminism is required. This mirrors P3.2's guarantee
(`context-identity.ts:11-13`: "no IO, no Date.now, no random, no module state").

---

## 9. Provenance

For every selected element, traceability requirements:

| Field | Kind | Where it comes from | Why |
| --- | --- | --- | --- |
| `sessionId` | reference | input | scope |
| `threadId` | reference | input | scope |
| `eventId` (per row) | reference | canonical row | identity ≠ sequence |
| `seq` (per row) | reference | canonical row | position |
| `baseSeq` / `headSeq` | derived | selection | coverage bounds |
| `anchorEventId` | derived (P3.2) | covered head row | content anchor |
| `historyCommit` | derived (P3.2) | all covered rows | closes F-05 middle-rewrite |
| `revision` | derived (P3.2) | durable `context.compacted` count | post-compaction space |
| `selectionBasis` | derived | policy | *why this view* |

**References vs copies:**

- **References** (never duplicated into a new store): `sessionId`, `threadId`, `eventId`,
  `seq`. These already live in `messages`; the selector carries them **within** the
  `ContextFrontier`/`messages` and must not persist a parallel copy.
- **Derived values** (recomputed, never cached as authority): `anchorEventId`,
  `historyCommit`, `revision`, `baseSeq`, `headSeq`. All are pure outputs of P3.2
  functions or trivially derived.

**Anti-pattern to avoid:** do not copy canonical row content into a selector-owned table.
The `ContextSelection` is a **RAM value** (like `ContextView`, `context-assembly.ts:36-38`,
"tidak pernah diserialisasi").

---

## 10. Compaction Interaction

Two paths, verified:

```
raw canonical history ─► SELECTOR ─► selected context ─► COMPACTION ─► runtime buffer
runtime/compacted buffer ─► PUBLICATION ─► P3.1 ─► P2.7 ─► canonical
```

**Invariants to prove:**

| Invariant | Status in current code | Selector obligation |
| --- | --- | --- |
| `SELECT ≠ COMPACT` | P2.8 assembly only *picks* a summary artifact; it never compacts. Compaction is kernel `store.replace` (`history.ts:29`). | Selector must not fold/summarize. Dropping a prefix (`budget-tail`) is **not** compaction — no summary is synthesized. |
| `COMPACT ≠ REWRITE` | kernel compaction folds in RAM; `persistCurrent` refuses a non-prefix buffer (`RefusedHistoryRewriteError`) unless explicit `shrinkThreadHistory`. | Selector output feeding compaction must remain a *view*; canonical is untouched. |
| `SELECT ≠ PERSIST` | `assembleContext` has no writes (test P2.8-17). | Selector reads; persistence is downstream. |

**Can selector output safely feed compaction?** Yes — with one rule: **a pure `budget-tail`
selection (prefix dropped, no summary) must never be published as if it were a fold.**
Dropping old tail is context loss, not a lawful compaction. If the selected view is later
`persistCurrent`'d, `saveSession`'s prefix-check would see a shorter non-prefix buffer and
**refuse** (`RefusedHistoryRewriteError`), which is the correct safe behavior — but P3.3
must ensure the selector's *dropped-prefix* case is understood as **context-window
eviction**, not a durable rewrite request.

**Forward seam:** the P3.0 target compaction shape (A+C: context-only summary artifact +
`history_projections` coverage record, no canonical delete) is **not yet wired** — the
durable `context.compacted` event and `countDurableCompactions` exist, but the projection
producer on the automatic path is P3.7. The selector must consume `revision` correctly but
must not assume the A+C fold record is always present.

---

## 11. Repeated Selection / Idempotence

Default expectation: **selection is observationally pure.**

Analysis of `select(S, P, B)` called repeatedly with the same canonical state, policy, and
budget:

| Question | Answer (design) |
| --- | --- |
| Returns equivalent views? | YES (deterministic — §8) |
| Mutates anything? | NO (read-only) |
| Creates IDs? | NO (no selector-generated IDs) |
| Changes canonical state? | NO |
| Changes session state? | NO |
| Creates caches? | NO (no selector-owned store) |
| Requires a generation counter? | NO |

**No generation counter.** The binding to canonical state is already provided by
`historyCommit` (content) + `revision` (space) inside `ContextFrontier`. A selector
generation counter would be a redundant, non-canonical identity — a second-authority smell.
Reject it.

---

## 12. Failure Semantics

| Condition | Behavior | Rationale |
| --- | --- | --- |
| Empty history | **RETURN EMPTY** view (`messages: []`, `baseSeq=0`, frontier `null`-based → freshness `unknown`) | matches `deriveFrontierFromDurable` → null (`context-identity.ts:248`) |
| Missing thread | **THROW/REFUSE** (no thread row) | matches `getProjectionStatus` → `UNKNOWN`, and `assembleContext` fallback; the selector surfaces `UNKNOWN` + empty-safe view, not a fabricated context |
| Stale frontier | **RETURN (safe, rebuilt)** view + freshness `STALE` | rebuild from current canonical; never patch |
| Diverged frontier | **RETURN (safe, rebuilt)** view + freshness `DIVERGED` | selector reads current canonical; carries DIVERGED label; makes no publication claim |
| UNKNOWN frontier | **RETURN unimpaired full view** + freshness `UNKNOWN` + `selectionBasis=fallback-unknown` | P3.0 §15: UNKNOWN is first-class, must be visible, never promoted |
| Corrupted projection | **RETURN full canonical fallback** + status `CORRUPT`/`UNKNOWN` visible | matches P2.8 rules 2/3/5 (`context-assembly.ts:148` falls back for non-CURRENT) |
| Unavailable metadata | **RETURN full fallback** + `UNKNOWN` | never infer certainty |
| Insufficient budget | **RETURN PARTIAL** boundary-safe tail, or **RETURN EMPTY** if even one turn cannot fit | partial is honest if it is a contiguous boundary-safe segment with correct frontier; otherwise empty + diagnostic. **Never fabricate a "valid-looking" narrower context.** |
| Impossible selection (budget < system+tools+one message) | **RETURN EMPTY** + `detail` | feasible-null; do not throw (empty is a legal view) |
| Malformed event (bad durable row) | **REFUSE** (surfaced as projection/source `CORRUPT`; selector returns safe full fallback with visible status) | fail-closed; matches `parseIncludedRangesStrict` refusing non-canonical |

**Rule:** a failure must never degrade into *plausible but false* context. The safe default
is **wider context + explicit UNKNOWN label**, never a silently narrower context asserted
as certain.

---

## 13. Security / Scoping

The selector must not accidentally expose:

| Risk | Guard |
| --- | --- |
| another thread | scope every read by `(sessionId, threadId)`; `loadThreadHistoryWithSeq` is already thread-scoped; P2.8 test "proyeksi thread lain tidak dipakai" |
| another session | scope by `sessionId`; `ContextIdentity.sessionId` binds it |
| stale history | freshness via P3.2; stale → rebuilt, labelled |
| unrelated run | selector must not read `runs` at all (`context-assembly.ts:13`) |
| foreign writer state | selector must not read/act on `writer_epoch`; that is P2.2's fence |
| deleted/replaced events | `event_id`/`historyCommit` detect replacement (F-05); `revision` detects compaction rewrite |

**Scoping invariant:** `(sessionId, threadId, frontier)` must never be cross-wired. The
existing primitives are already scope-safe; the selector must not introduce a newer,
looser read.

---

## 14. Existing Code Reuse

Inventory of existing primitives and disposition:

| Primitive | Location | Disposition |
| --- | --- | --- |
| `assembleContext` + `ContextView` | `src/session/context-assembly.ts` | **REUSE/WRAP** — selector generalizes; `full-history` and `summary-plus-tail` bases are produced by this exact logic. P3.3 should reuse `boundaryIsSafe`, `syntheticSummaryMessage`, `stripContextOnly`, `ContextOnlyArtifact`. |
| `loadThreadHistoryWithSeq` | `persistence.ts:1290` | **REUSE** — canonical read |
| `getProjection` / `getProjectionStatus` | `persistence.ts:2851/2873` | **REUSE** — durable projection cache read |
| P3.2 `deriveAnchorEventId`/`deriveContextIdentity`/`deriveContextFrontier`/`deriveHistoryCommit`/`deriveFrontierFromDurable` | `context-identity.ts` | **REUSE** — frontier/provenance |
| P3.2 `assessContextFreshness`/`compareContextFrontier` | `context-identity.ts` | **REUSE** — freshness/compare |
| P3.2 `countDurableCompactions` | `context-identity.ts:369` | **REUSE** — revision |
| P3.2 `ModelContextProvenance` | `context-identity.ts:384` | **REUSE (fill `selectionBasis`)** |
| `estimateMessage`/`estimateMessages`/`estimateSystem`/`estimateTools`/`estimateSessionContext` | kernel `tokens.ts` | **REUSE** — budget estimation |
| `defaultBudgetPolicy` | kernel `budget.ts` | **REFERENCE** — pressure semantics; do not duplicate |
| `mechanicalCompaction`/`createLlmCompaction` | kernel `compact.ts` / `policy/compaction.ts` | **LEAVE ALONE** — compaction is downstream of selection |
| `buildSystemPrompt` | `policy/context.ts` | **LEAVE ALONE** — system channel, separate from message selection |
| RAG (`createRagLayer`) | `src/memory/*` | **LEAVE ALONE** — separate channel; D4 OPEN |
| `persistCurrent` | `cli/setup.ts:1944` | **WRAP (read its output contract only)** — selector output must round-trip through its `contextOnly`/baseline logic |

**No duplicate selector logic should be created.** P3.3 is largely a **generalization of
`assembleContext` into a budget/policy-aware, provenance-emitting selector**, not a new
parallel subsystem.

---

## 15. Test Contract Matrix

Derived before implementation (no tests written yet).

| Category | Cases |
| --- | --- |
| **Basic** | empty history; one event; normal multi-turn history |
| **Ordering** | canonical `seq` order preserved; no duplicate event; no cross-thread event; boundary-safe cut never splits assistant-toolcall/tool-result |
| **Identity** | `sessionId`/`threadId`/`baseSeq` retained; `frontier.anchorEventId` matches covered head row |
| **Provenance** | `historyCommit` matches covered rows; F-05 middle-rewrite changes commit; every selection traceable to canonical; `selectionBasis` ∈ vocabulary; `contextOnly` round-trips through `stripContextOnly` |
| **Freshness** | EQUAL → fresh; valid advance → rebuilt + correct; DIVERGED → labelled; UNKNOWN → labelled + full fallback (never promoted) |
| **Budget** | exactly at boundary; under budget; over budget (partial boundary-safe tail); impossible budget (empty + diagnostic); reserved system+tools accounted |
| **Determinism** | repeated same input → deep-equal result; no `Date.now`/random influence |
| **Purity/Mutation** | selector does not mutate `messages`/`history_projections`/`runs`/`sessions` (fingerprint); no new durable rows; no selector store |
| **Authority** | selector imports no writer; cannot call `saveSession`/`shrinkThreadHistory` for writes; output is RAM-only |
| **Failure** | empty/missing-thread/stale/diverged/unknown/corrupt/unavailable/insufficient/impossible/malformed (per §12) |
| **Compaction interaction** | `budget-tail` (dropped prefix, no summary) is NOT treated as a fold; selector output fed to `persistCurrent` behaves per P2.7 (refuse non-prefix) |
| **Regression** | P2.8 (`context-assembly`) suite stays green; P3.2 (`context-identity`) suite stays green; P3.1 guard stays 14/14 |

---

## 16. Architectural Risk Matrix

| ID | Risk | Status | Notes |
| --- | --- | --- | --- |
| R1 | selector becomes hidden memory store | **NOT PRESENT** (by design) — must remain so | no selector-owned store |
| R2 | selector mutates canonical state | **NOT PRESENT** — read-only | enforce by not importing writers |
| R3 | selector duplicates persistence logic | **POSSIBLE** — mitigate by REUSE (§14) | do not re-implement reads/validity |
| R4 | selector ignores freshness | **POSSIBLE** — mitigate by mandatory `assessContextFreshness` | freshness is a required output field |
| R5 | UNKNOWN silently treated as fresh | **POSSIBLE** — mitigate by explicit `freshness: unknown` + full fallback | must never promote |
| R6 | cross-session contamination | **NOT PRESENT** in existing primitives | keep `sessionId` scoping |
| R7 | cross-thread contamination | **NOT PRESENT** in existing primitives | keep `threadId` scoping; P2.8 test exists |
| R8 | nondeterministic selection | **NOT PRESENT** (deterministic achievable) | forbid clock/random/order |
| R9 | provenance loss | **POSSIBLE** — mitigate by `frontier`+`historyCommit` in output | required field |
| R10 | compaction mistaken for history rewrite | **POSSIBLE** — mitigate by `SELECT ≠ COMPACT` rule | `budget-tail` ≠ fold |
| R11 | selection policy becomes canonical truth | **POSSIBLE** — mitigate by describe-only | decision stays in `saveSession` |
| R12 | token optimization contaminates correctness | **POSSIBLE** — mitigate by separation (§7) | feasibility ≠ correctness |

All "POSSIBLE" risks are **mitigable by the invariants in §17** and are not present in the
existing assembly substrate; none is currently realized.

---

## 17. Minimal Architecture

```
        CANONICAL HISTORY (messages) ── read-only ──┐
                                                    ▼
                    ┌───────────────────────────────────────────┐
                    │  CANONICAL READ (loadThreadHistoryWithSeq) │
                    │  + projection cache (getProjectionStatus)  │
                    └───────────────────────────────────────────┘
                                    │
                                    ▼
        ┌──────────────────────────────────────────────────────┐
        │  P3.2 Context Identity / Frontier (derive* + assess)  │   ← description only
        └──────────────────────────────────────────────────────┘
                                    │
                                    ▼
        ┌──────────────────────────────────────────────────────┐
        │  SELECTOR INPUT  { sessionId, threadId, rows,         │
        │                    revision, policy, budget }         │
        └──────────────────────────────────────────────────────┘
                                    │
                                    ▼
        ┌──────────────────────────────────────────────────────┐
        │  SELECTION POLICY (deterministic, pure)               │
        │   - basis: full-history | summary-plus-tail |         │
        │            budget-tail | fallback-unknown             │
        │   - boundary-safe contiguous segment                  │
        │   - budget-bounded (feasibility, not correctness)     │
        └──────────────────────────────────────────────────────┘
                                    │
                                    ▼
        ┌──────────────────────────────────────────────────────┐
        │  ContextSelection (RAM-only, provenance-bound)        │
        └──────────────────────────────────────────────────────┘
                                    │
                                    ▼
        ┌──────────────────────────────────────────────────────┐
        │  Context Assembly (assembleContext reuse)             │
        └──────────────────────────────────────────────────────┘
                                    │
                                    ▼
        ┌──────────────────────────────────────────────────────┐
        │  Runtime Context (ContextStore)  [EXECUTION-LOCAL]    │
        └──────────────────────────────────────────────────────┘
                                    │
                                    ▼
        publication request → P3.1 decision → P2.7 safety → canonical
```

Minimal scope: **one new module** (`src/session/context-selector.ts`) that **reuses**
existing primitives; **one new test file**. No changes to `saveSession`, P2.2, kernel,
vendor, or the DB schema.

---

## 18. Hard Invariants

Derived and corrected against the actual architecture:

```
I1  Selector is derived-only (no IO writes; RAM-only output).
I2  Selector never mutates canonical history (messages) or any durable table.
I3  Selection is scoped by (sessionId, threadId) identity; no cross-scope leakage.
I4  Selection is freshness-aware: it computes and carries P3.2 freshness.
I5  UNKNOWN never becomes implicit certainty (carried explicitly; safe-widest fallback).
I6  Selected context is provenance-traceable (P3.2 frontier incl. historyCommit binds it).
I7  Same canonical state + same policy + same budget = deterministic output.
I8  Selection never bypasses P3.1/P2.7; the publication decision stays in saveSession.
I9  Compaction remains distinct from selection (SELECT ≠ COMPACT; budget-tail ≠ fold).
I10 No selector-owned authority exists (no store, no IDs, no generation counter).
I11 Selection correctness is independent of token optimization (feasibility ≠ correctness).
I12 Selector must not read runs/run_id as a context input (mirrors context-assembly.ts:13).
```

(I1–I10 from the prompt; I11–I12 added because the actual architecture demands them.)

---

## 19. Implementation Plan (not executed)

1. **New files**
   - `src/session/context-selector.ts` — pure selector + `ContextSelection` type +
     `selectionBasis` vocabulary.
   - `test/context-selector.test.ts` — the §15 matrix.
2. **Modified files** — minimal:
   - `cli/setup.ts` — call the selector where `assembleContext` is called today
     (`:904`), preserving `initialMessages`/`contextOnly`/baseline semantics. (Could be a
     follow-up if the selector initially wraps `assembleContext`.)
   - Possibly `src/session/context-assembly.ts` — expose `boundaryIsSafe` for reuse
     (currently module-private).
3. **Public APIs**
   - `selectContext(input: { sessionId; threadId; rows; revision; policy; budget; cwd? }): ContextSelection`
   - `type SelectionBasis = "full-history" | "summary-plus-tail" | "budget-tail" | "fallback-unknown"`
   - `type ContextSelection` (§6)
4. **Data types** — reuse `ContextFrontier`, `ContextFreshness`, `ContextSource`,
   `ContextOnlyArtifact`, `Message`; add only `ContextSelection` + `SelectionBasis`.
5. **Dependency direction** — `context-selector.ts` → `context-identity.ts` (P3.2) +
   `context-assembly.ts` (P2.8) + `persistence.ts` (reads) + kernel `tokens.ts` (estimate).
   No production code depends on the selector except `cli/setup.ts`.
6. **Test files** — `test/context-selector.test.ts`.
7. **Migration concerns** — none (no schema change; read-only).
8. **Compatibility constraints** — P2.8 suite must stay green; P3.2 suite green; P3.1 guard
   14/14; `ContextSelection` must round-trip through `persistCurrent`'s
   `stripContextOnly`/baseline logic.
9. **Validation commands** — `bun test test/context-selector.test.ts`,
   `bun test test/context-assembly.test.ts test/context-identity.test.ts
   test/p3-reconciliation-guard.test.ts`, `bun x tsc --noEmit` (expect zero new errors).
10. **Rollback point** — the selector is additive and observably pure; rollback =
    revert `cli/setup.ts` call site to `assembleContext` (behavior-equivalent for
    `full-history`/`summary-plus-tail`). Tag/commit before wiring.

---

## 20. P3.3 Readiness

The selector contract is clear, the authority boundary is explicit and already embodied
by the P2.8 seam, P3.2 integration semantics are clear, provenance is clear (P3.2
`historyCommit` binds content), failure semantics are defined, no second authority is
introduced, no hard dependency is missing, determinism is achievable and proven by the
existing pure primitives, and the test matrix is complete.

Conditions to satisfy *during* implementation (all derivable now; none needs new
authority):

1. Define the `selectionBasis` vocabulary (§6.1) — especially `budget-tail`
   (dropped-prefix ≠ fold).
2. Define partial-coverage frontier semantics for `baseSeq > 0` — P3.2 models the shape
   (`deriveContextFrontier` with arbitrary `baseSeq`), but P2.8 only ever emitted
   `full` and `summary-plus-tail`. The selector must bind a partial window's
   `historyCommit` to **only the covered rows** (as `test/context-identity.test.ts:48-61`
   `viewFrontier` already demonstrates).
3. Keep the publication decision in `saveSession` (never move it into the selector).
4. Do not solve attach-history/diagnostic gaps (proven non-blocking, not hard deps).

---

## 21. Exact Next Execution Step

**One action:** implement `src/session/context-selector.ts` as a pure, read-only module
that (a) reads canonical rows + revision for `(sessionId, threadId)`, (b) derives the P3.2
frontier, (c) applies a deterministic, boundary-safe, budget-bounded selection policy with
the four `selectionBasis` values, and (d) returns a provenance-bound `ContextSelection`
carrying an explicit freshness — introducing no writer, store, or second authority.

(Do not start implementation in this audit session.)

---

```text
MINICODE P3.3 ARCHITECTURE STATUS:
READY WITH CONDITIONS

Selector definition:
CLEAR

Input authority:
SAFE

P3.2 integration:
SAFE

Publication boundary:
PRESERVED

Provenance:
COMPLETE

Determinism:
PROVEN

Compaction interaction:
SAFE

Failure semantics:
DEFINED

Second authority:
NO

Hard dependencies:
PRESENT

P3.3:
READY WITH CONDITIONS

Blocking findings:
NONE

Non-blocking findings:
1. selectionBasis vocabulary not yet formal (must define full-history | summary-plus-tail | budget-tail | fallback-unknown).
2. Partial-coverage (baseSeq > 0) frontier semantics for budget-tail not yet specified as a contract (P3.2 models the shape; P2.8 only emitted full + summary-plus-tail).
3. P3.3 must remain a reader; publication decision must not migrate into it (describe-vs-decide division).
4. P3.2 module still not wired to production; P3.3 becomes the first production consumer of context-identity.ts.
5. Companion untracked audit artifact P3_PROGRAM_CURRENT_CANONICAL_TRUTH_AUDIT.md present in tree (from prior milestone; not committed).

Recommended next action:
Implement src/session/context-selector.ts as a pure, read-only, provenance-bound, deterministic, budget-bounded selector reusing context-identity.ts + context-assembly.ts, with saveSession retained as the sole publication decision authority.

CONFIDENCE:
HIGH
```
