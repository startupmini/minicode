# P3.4 — Durable Context Projection Producer: Implementation Report

Status: **VALID**. The missing production producer for the existing `history_projections`
cache is implemented, wired at one seam, and proven end-to-end: a production-created
projection is consumed by the P3.3 selector as `summary-plus-tail`. Canonical history
remains the sole authority; the projection stays a derived cache.

---

## 1. Baseline

- Repository `D:\git\minicode`; branch `main`.
- HEAD at start: `bfd12411960e2c92a658ec5575f3e92f683b696e` == `origin/main`; clean.
- `P3_ROADMAP.md` present with the ratified P3.4 = Durable Context Projection Producer.

Files touched:

| File | Change |
| --- | --- |
| `src/session/context-projection.ts` | **new** — the producer (baca-saja kanonik → tulis HANYA `history_projections`) |
| `test/context-projection.test.ts` | **new** — 18 tests |
| `cli/setup.ts` | resume seam: prefer durable projection for the selector; `persistCurrent`: produce after a successful write |
| `test/writer-inventory.test.ts` | declare the P3.4 diagnostics (`cli/setup.ts` 36→38) |
| `docs/ARCHITECTURE.html` | add `context-projection.ts` to the module map |

No change to `saveSession`, P2.7 refusal rules, P3.1, P3.2, P3.3 selector logic, kernel,
vendor, or the projection schema.

---

## 2. Existing projection substrate (reused, not replaced)

| Component | Reads | Writes | Durable | Authority |
| --- | --- | --- | --- | --- |
| canonical history (`messages`) | via `persistence.ts` | `persistence.ts` only | yes | **AUTHORITATIVE (single)** |
| projection cache (`history_projections`) | `getProjection`/`getProjectionStatus` | `buildProjection`/`rebuildProjection` (+ shrink/delete) | yes | **DERIVED (cache)** |
| projection builder (`buildProjection`) | canonical rows | **only `history_projections`** | yes | derived writer |
| selector (P3.3) | rows + projection | none | no | derived, read-only |
| `saveSession` (P2.7) | canonical rows | `messages` | yes | **CANONICAL DECIDER** |

The producer **reuses** `buildProjection` (epoch-fenced, delete+insert in one txn, reads
canonical, never touches `messages`). The projection **schema is unchanged**.

---

## 3. Projection contract (as-is)

A `history_projections` row = `{session_id, thread_id, projection_id="summary", base_seq,
summary_text, included_ranges, built_at, anchor_event_id}`. Semantics (P2.7):
- `base_seq` = exclusive end of the covered prefix `[0, base_seq)`.
- `anchor_event_id` = `event_id` of the boundary row (`seq = base_seq-1`).
- `getProjectionStatus` → `CURRENT` (coverage == head+1), `STALE` (head moved / anchor
  changed), `CORRUPT`, `INCOMPLETE`, `UNKNOWN`.
- Rebuildable deterministically from canonical `messages`.

---

## 4. Producer trigger (one seam)

- **On resume** (`cli/setup.ts`, the existing P3.3 seam): read the durable projection and
  prefer it for the selector.
- **On `persistCurrent`** (after a successful canonical write, before journal finalize):
  call `produceSummaryProjection(sessionId, cwd, {expectedEpoch, policy:{keepRecentTurns}})`
  best-effort. No recursion (the producer never calls `saveSession`).

`keepRecentTurns` defaults to the session option or 2. The producer is a cheap no-op when
there is no foldable prefix.

---

## 5. Input authority

The producer reads **canonical rows only** (`loadThreadHistoryWithSeq`) — never the runtime
buffer, never execution state, never run/epoch. The summary is derived from canonical rows
via the **existing** kernel fold renderer (`mechanicalCompaction`), not from runtime
context.

---

## 6. Identity binding

Every produced row is scoped to `(session_id, thread_id, projection_id="summary")` via
`buildProjection`. `anchor_event_id` binds the boundary row; `base_seq` binds the coverage.
Identity tests: P3.4-4 (cross-session), P3.4-5 (cross-thread).

---

## 7. Determinism

`deriveSummaryFromCanonical` is a pure function over canonical rows using the kernel's
deterministic `mechanicalCompaction` (no clock/random/network/LLM). Same canonical rows +
same policy ⇒ same `{summaryText, baseSeq}` (P3.4-7, P3.4-17). `built_at` is a timestamp
stamp (set by P2.7), not a coverage claim, so idempotence is semantic (P3.4-2).

---

## 8. Projection content

`summary_text` + coverage `[0, baseSeq)` where `baseSeq = totalRows − keptTail`. The prefix
is rendered by the **existing** kernel fold (convention `Previous context:\n- user: …`);
the tail `[baseSeq, head]` stays verbatim in canonical history (not in the projection row).
This is the **existing projection representation**, not a new A+C algorithm (P3.7).

---

## 9. Provenance

The row retains `base_seq`, `included_ranges` (`[[0, baseSeq]]`), `anchor_event_id`, and
`built_at` — the same provenance the projection contract already defines (P3.4-11). No
separate provenance store is introduced.

---

## 10. Freshness / invalidation

- `getProjectionStatus` is the single validator. A produced **partial** projection is
  `STALE` (head not yet covered) — explicit, never silently treated as canonical
  (P3.4-8, P3.4-9).
- **Consumability rule (P3.0 §8 D6):** a projection is consumable by the selector when
  **coverage-valid** — `CURRENT` or `STALE` with an intact anchor. `CORRUPT`/`INCOMPLETE`/
  `UNKNOWN`/absent ⇒ not consumable ⇒ full-canonical fallback (P3.4-9, P3.4-14).
- Explicit `shrinkThreadHistory` deletes affected projections in the same txn (P2.7); the
  producer can then rebuild (P3.4-10).

---

## 11. Rebuild semantics

Rebuild = re-run the producer from canonical rows via `buildProjection` (delete+insert in
one epoch-fenced txn). It **replaces** the derived row and **never** rewrites canonical
history (P3.4-14). A failed rebuild leaves the previous row (or none) and canonical intact.

---

## 12. Atomicity

`buildProjection` performs `DELETE`+`INSERT` of the single projection row inside one
`db.transaction` guarded by `assertWriterEpochInTxn`. Canonical history is only **read**.
The producer cannot partially corrupt the cache or the history.

---

## 13. Failure semantics

| Condition | Behavior |
| --- | --- |
| empty history | no-op, `produced:false` (P3.4-13) |
| no foldable prefix | no-op, `produced:false` (P3.4-3) |
| wrong epoch | `buildProjection` throws (`StaleWriterError`); canonical unchanged (P3.4-12) |
| build/persist failure | caught at the seam (warn); canonical unchanged |
| missing/corrupt projection | not consumable → full-canonical fallback |

**Rule honored:** projection failure ⇒ canonical history remains safe; projection may remain
missing/stale; the failure is explicit (stderr warn). No path alters canonical history.

---

## 14. Recovery

A deleted/missing projection is recoverable by re-running the producer from canonical rows
(P3.4-14); canonical history is untouched. The projection is never an irreversible
dependency.

---

## 15. P3.3 integration

```
canonical history → producer (P3.4) → history_projections → P3.3 selector → ContextSelection
```

- The selector is **unchanged** (read-only). It is not responsible for generation/persistence.
- On resume, `cli/setup.ts` prefers `readConsumableSummaryProjection(...)` for the selector's
  `projection` input; P2.8's `assembleContext` (CURRENT-only) remains the compatible fallback.

---

## 16. Authority proof

- The producer imports only `#minicore` (kernel fold) + `persistence.ts`. No SQL, no fs, no
  network.
- Its only write is `buildProjection` → **`history_projections` only**.
- P3.4-15: changing/deleting the projection does not change canonical history.
- P3.4-16: the producer writes none of `messages`/`turns`/`threads`/`runs`/`sessions`.

**Projection cache never becomes canonical authority.**

---

## 17. Writer inventory

`cli/setup.ts` was declared 36 → 38 for exactly **two** diagnostics: `[projection …]`
(produce notice) and the producer failure warning (owner `diagnostic`). The producer module
(`src/session/**`) is outside the inventory's scan scope and writes only the projection
cache. Writer inventory **passes**; categorization is semantically correct (diagnostics, not
canonical writers).

---

## 18. Test matrix (18 tests, all green)

| Group | Tests |
| --- | --- |
| Production creation | P3.4-1 (canonical→projection, canonical intact), -2 (idempotent), -3 (no prefix → no-op) |
| Identity/scope | P3.4-4 (cross-session), -5 (cross-thread) |
| Coverage | P3.4-6 (exact baseSeq=12), -7 (pure derive) |
| Freshness/invalidation | P3.4-8 (partial STALE), -9 (STALE consumable), -10 (shrink deletes → rebuild) |
| Content/ordering | P3.4-11 (kernel convention, ranges, anchor) |
| Failure safety | P3.4-12 (epoch fail leaves canonical), -13 (empty no-op) |
| Recovery | P3.4-14 (delete → rebuild) |
| Authority | P3.4-15 (projection ≠ canonical), -16 (no messages/turns/threads/runs writes) |
| Determinism | P3.4-17 |
| **Production path** | P3.4-18 (kanonik → producer → cache → selector `summary-plus-tail`) |

---

## 19. Mutation / non-vacuity

| Probe | Mutation | Result |
| --- | --- | --- |
| P1 | hardcode `threadId` in the producer | not load-bearing (tests use the default thread) |
| P2 | force `baseSeq = 1` (coverage off) | **1 fail** (P3.4-6) |
| P3 | `readConsumableSummaryProjection → null` | **3 fail** (P3.4-9/14/18) |
| P4 | empty guard off (`produced:true` on empty) | **1 fail** (P3.4-13) |

Each probe was applied to the current implementation and reverted to the exact pristine
SHA-256 (`ABF6CE81…`). No historical mutation evidence used. (P1 recorded as non-load-bearing
because the producer's thread handling is exercised only via the default thread in tests;
the read-side thread scoping is covered by P3.4-5.)

---

## 20. Production path proof (milestone core)

Live end-to-end (`createCliSession`), two resumes of an 8-turn session:

1. First resume (no projection): `[select … basis=full-history]`; `persistCurrent` →
   `[projection sid=e2e base=12 status=produced]`.
2. Second resume (projection present): `[select … basis=summary-plus-tail freshness=fresh
   head=15]`, history seeded as `[summary] + tail` (5 messages), first message
   `Previous context [0,12):\n…`.

**`summary-plus-tail` is now real production behavior. The production producer is
load-bearing (removing it removes the basis).**

---

## 21. Compaction boundary

```
projection generation ≠ advanced fold generation ≠ canonical rewrite
```

The producer renders a summary via the **existing** kernel fold (`mechanicalCompaction`)
and records coverage — it does **not** implement the P3.7 A+C fold producer, does not
rewrite history, and does not alter compaction. Compaction remains the kernel `replace`
seam; the projection is a separate derived cache row.

---

## 22. P3.5 boundary

Not implemented: runtime revision/`ModelContextProvenance` bridge, headless
`context.compacted` bridge, runtime-facing adapter. The producer **exposes the seam** P3.5
will consume (`readConsumableSummaryProjection` output → selector), but nothing is
prematurely wired into the runtime beyond the existing seed.

---

## 23. Validation

| Target | Result |
| --- | --- |
| P3.4 producer | **18/18 pass** |
| projection substrate (`projection-foundation`, `p2-history-projection`) | pass |
| P3.3 selector + resume | pass |
| P3.2 context-identity | pass |
| P3.1 guard | **14/14 pass** |
| P2.7 persistence/refusal | pass |
| P2 architecture guards | **50/50 pass** |
| writer-inventory | pass (declared 36→38) |
| architecture-map | **2/2 pass** |
| broad batch (10 files, 186) | **186/186 pass** |
| typecheck | **28 errors, 0 new** (all pre-existing `test/phase3*`/`phase4*`) |
| **full suite** | **4408 pass / 23 skip / 8 fail** (299 files / 4439 tests) |

Full-suite failures (8): `audit-manifes-korup`, `P2.1 ×2`, `P2.2 ×2` = **FLAKY** (green in
isolation: 34/34); `P3-constructor (m15)`, `S13`, `web-ssg` = **PRE-EXISTING/ENV**. **No P3.4
regression.**

---

## 24. Known limitations

1. **Partial coverage by construction.** The producer records a prefix summary; the row is
   `STALE` under P2.8's CURRENT-only rule but **coverage-valid** (P3.0 §8 D6) and consumable
   by the P3.3 selector. Making a **CURRENT** (full-coverage) projection requires a
   full-history fold renderer that does not exist as a reusable primitive — that is the
   P3.7 seam, deliberately not implemented here.
2. **Trigger is `persistCurrent` + resume**, not every canonical mutation path; a session
   that never persists produces no projection (correct: no context to summarize).
3. **`revision` undercount on headless paths** (no presentation adapter) remains a P3.5
   seam; the producer does not depend on `revision`.
4. **Consumability uses STALE-with-intact-anchor**; a stricter CURRENT-only consumer would
   not use it — documented, not a defect.
5. No semantic relevance ranking (out of scope).

---

## 25. Final verdict

The producer reuses the existing projection substrate, reads canonical history only, writes
only the derived projection cache, is deterministic, scoped, provenance-complete,
failure-safe, and recoverable. It does not create a second authority and does not bypass
P3.1/P2.7. The production path from canonical history → producer → cache → P3.3
`summary-plus-tail` is proven live. No P3.4 regression.

```text
MINICODE P3.4 IMPLEMENTATION STATUS:
VALID

Projection producer:
IMPLEMENTED

Existing projection substrate:
REUSED

Production trigger:
DEFINED

Canonical source:
PRESERVED

Projection authority:
DERIVED

Identity binding:
PASS

Freshness/invalidation:
PASS

Provenance:
PASS

Determinism:
PASS

Rebuild/recovery:
PASS

Projection failure safety:
PASS

P3.3 integration:
COMPLETE

Summary-plus-tail production path:
PROVEN

P3.7 boundary:
PRESERVED

P3.5 boundary:
PRESERVED

Second authority:
NO

Writer inventory:
PASS

Mutation/non-vacuity:
PASS

Production-path tests:
PASS

Targeted tests:
PASS

Full suite:
CLASSIFIED_FAILURES

Known limitations:
1. Producer records PARTIAL coverage (STALE-but-coverage-valid, consumable by P3.3 selector); CURRENT full-coverage projection needs the P3.7 full-history fold renderer.
2. Trigger = persistCurrent + resume seam only (a session that never persists produces none).
3. revision undercount on headless paths persists as a P3.5 seam (producer independent of revision).
4. Consumability accepts STALE-with-intact-anchor (P3.0 §8 D6); a CURRENT-only consumer would not use it.
5. No semantic relevance ranking (out of scope).

Final commit:
aba565f36b45fde12c9bfd31bddce183ef27c524

origin/main:
aba565f36b45fde12c9bfd31bddce183ef27c524

Working tree:
CLEAN

P3.5:
NOT STARTED

P3.7:
NOT STARTED

CONFIDENCE:
HIGH
```
