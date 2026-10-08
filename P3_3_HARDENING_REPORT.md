# P3.3 — Conditional Checkpoint + Finding Hardening Report

Status: **VALID** (N1, N2, N3, N4, N5 resolved). The conditional P3.3 checkpoint was
secured in Git first, then the five findings were fixed minimally, revalidated, and
the whole set hardened. No P3.4 work was started.

---

## 1. Conditional checkpoint SHA

- Pre-checkpoint HEAD: `25244a252c08841a99d26211d593e5cf98cfe9fa`.
- **Conditional checkpoint commit: `c8a2517d2c9594d396cff423ac8929cacb804505`**
  (`p3.3: checkpoint canonical context selector`), pushed `25244a2..c8a2517` (fast-forward,
  no force). It contained the verified P3.3 working set: the selector, its 33 tests,
  the `context-assembly.ts` export, the resume-seam integration, the writer-inventory
  declaration, the implementation report, and the truth audit.
- `HEAD == origin/main == c8a2517` at checkpoint; working tree clean.

---

## 2. N1 — Resume-seam freshness

**Finding.** The resume seam called `selectContext` without `canonicalFrontier`, so
`selectionFreshness(_, undefined)` returned `fresh` unconditionally — freshness was
never computed.

**Fix.** The seam now derives the canonical frontier from the **same freshly-read
rows** using P3.2 `deriveFrontierFromDurable` (via the newly-exported
`rowsToCanonicalRefs` adapter in the selector — one adapter, no duplication) and
passes it as `canonicalFrontier`. `selectionFreshness` now runs
`assessContextFreshness(view, canonical)`.

- `fastlane: cli/setup.ts` (imports `deriveFrontierFromDurable`, `rowsToCanonicalRefs`).
- Semantics verified (P3.3-38): `EQUAL → fresh`; canonical ahead → `stale` (+ basis
  `fallback-unknown`); differing content → `diverged`; `null` → `unknown`.
- Describe/decide preserved: the selector carries the label; `saveSession` decides.

**Result: RESOLVED.** Live resume now emits a **computed** freshness
(`[select sid=… basis=… freshness=… head=…]`).

---

## 3. N2 — Empty `budget-tail` reporting `fits=true`

**Finding.** When the tool-pair boundary shift evacuated the budget segment
(`selectedRows = []`), the code reported `fits = (0 <= limit) = true` for an empty view.

**Fix.** Added an explicit empty-segment branch in the `budget-tail` path: an empty
result reports `fits: false` with an honest `detail` ("safe boundary shift left no
representable segment; eviction, NOT a fold"), mirroring the insufficient-budget
branch. No change to generic token accounting.

**Result: RESOLVED.** Regression: P3.3-34 (empty → `fits=false`), P3.3-35
(normal budget-tail `fits=true`; exact boundary → full-history). Mutation H3
(force `fits=true`) → 1 fail. No canonical mutation (selector remains pure).

---

## 4. N3 — Stale rows labelled `full-history`

**Finding.** A row set behind the canonical frontier produced `basis="full-history"`
with `freshness="stale"` — `full-history` implies a trusted canonical representation.

**Fix.** Added `stale` to the existing `fallback-unknown` branch (STALE/DIVERGED/
UNKNOWN). Coverage completeness (all available rows included) is now explicitly
separated from freshness/trust. **No fifth `SelectionBasis` was invented.**

**Result: RESOLVED.** Regression: P3.3-36 (stale → `fallback-unknown`), P3.3-37
(complete + `EQUAL` → `full-history`; completeness ≠ freshness). Mutation H4 (drop
`stale`) → 2 fail.

---

## 5. N4 — Report hash drift

**Finding.** The implementation report cited the post-mutation pristine hash
`65E055BB…`; the audit found the live hash `AD817353…` because a `biome` formatting
pass ran after that report section (line length only; semantics unchanged).

**Correction.** The implementation report §15 was updated to:
- keep the historical probe evidence (not falsified),
- explain that the cited hash predates a formatting pass,
- treat only the **current tracked source hash** as authoritative, and
- add the hardening probe table (H1–H5).

**Result: RESOLVED (documentation).**

---

## 6. N5 — Resume integration test

**Finding.** No committed test exercised the resume seam.

**Fix.** Added `test/context-selector-resume.test.ts` (3 tests) driving the **real
production path** (`createCliSession` resume with a fake provider):

- **N5-1** — real resume loads the canonical history and the `[select …]` provenance
  line appears (selector runs in production), `basis=full-history freshness=fresh head=2`.
- **N5-2** — a CURRENT durable projection resume yields `basis=summary-plus-tail`
  (built via the real `buildProjection`, not a mock).
- **N5-3 (guard)** — the resume seam passes `canonicalFrontier` into `selectContext`
  and derives it via `deriveFrontierFromDurable`/`rowsToCanonicalRefs`.

**Anti-regression proof.** Removing `canonicalFrontier` from the seam makes **N5-3
fail** (verified: 2 pass / 1 fail), then restored exactly (SHA-256 unchanged).

**Result: ADDED.**

---

## 7. Non-vacuity evidence (post-hardening)

| Probe | Mutation | Expected | Actual |
| --- | --- | --- | --- |
| H1 | hardcode `sessionId` in `coverageOf` | identity tests fail | **8 fail** |
| H2 | `selectionFreshness(null) → "fresh"` | UNKNOWN not promoted | **2 fail** (P3.3-10, P3.3-38) |
| H3 | force empty `budget-tail` `fits=true` | N2 test fails | **1 fail** (P3.3-34) |
| H4 | drop `stale` from fallback branch | N3 test fails | **2 fail** (P3.3-36, P3.3-38) |
| H5 | remove `canonicalFrontier` from resume seam | N1 guard fails | **1 fail** (N5-3) |

Every probe was applied to the current (hardened) implementation, produced the
expected failures, and was reverted to the exact pre-probe SHA-256
(`cli/setup.ts` `0C33A1FD…`; `src/session/context-selector.ts` restored). No
historical P3.1 evidence was used.

---

## 8. Validation

| Target | Result |
| --- | --- |
| P3.3 selector (`context-selector`) | **38/38 pass** |
| P3.3 resume integration (`context-selector-resume`) | **3/3 pass** |
| P2.8 context-assembly | **33/33 pass** |
| P3.2 context-identity | pass |
| P3.1 reconciliation guard | **14/14 pass** |
| P2.7 persistence (rewrite/ttl/vector) | pass |
| writer-inventory | pass |
| architecture-map | **2/2 pass** (map updated for `context-selector.ts`) |
| targeted batch (10 files) | **147/147 pass** |
| typecheck | **28 errors, 0 new** (all pre-existing `test/phase3*`/`phase4*`) |
| **full suite** | **4390 pass / 23 skip / 8 fail** (298 files / 4421 tests) |

Full-suite failures (8): `audit-manifes-korup`, `P2.1 ×2`, `P2.2 ×2` = **FLAKY**
(green in isolation: 34/34); `P3-constructor (m15)`, `S13`, `web-ssg` =
**PRE-EXISTING/ENV**. **No P3.3 regression.**

---

## 9. Authority audit (post-fix)

| Component | Reads | Writes | Durable | Authority |
| --- | --- | --- | --- | --- |
| Canonical history | via `persistence.ts` | `persistence.ts` only | yes | AUTHORITATIVE (single) |
| P3.2 `context-identity` | rows (passed in) | none | no | DERIVED (describe) |
| P3.3 selector | rows/revision/projection (passed in) | none | no | DERIVED (view) |
| Runtime context | ContextSelection | in-RAM | no | EXECUTION-LOCAL |
| P3.1 | proposed history | none | no | derived enforcement |
| P2.7 `saveSession` | canonical rows | `messages` | yes | CANONICAL DECIDER |

- Selector still imports no persistence function (only pure P2.8/P3.2 helpers); the
  N1 fix added a pure adapter (`rowsToCanonicalRefs`) and a P3.2 derive call in the
  **composition root**, not in the selector.
- No accidental new authority at the resume seam: the seam still only **reads**
  (`loadPresentationEvents`, `loadThreadHistoryWithSeq`, `assembleContext`) and
  **produces `initialMessages`**; it does not write.
- P2.7 semantics unchanged (`persistence.ts` untouched).

**PASS.**

---

## 10. Final P3.3 verdict

All five findings resolved with current, load-bearing evidence; no new safety issue;
no second authority; P3.1/P2.7 boundary preserved; selector pure and deterministic.
The previously-deferred limitations (full-coverage cap, headless revision, one-seam
integration, no ranking) remain as bounded, documented, non-blocking items.

**P3.3 = VALID.**

---

## 11. Remaining limitations

1. Full-coverage projection `base_seq == head+1` capped to `head` (faithful view;
   conservative summary marker) — bounded.
2. `budget-tail` is non-durable eviction (publishing it is refused by P2.7) — by design.
3. `revision` undercounts on headless paths without the presentation adapter — declared
   P3.5 seam; fail-closed.
4. Selector integrated at the resume seam only; other consumers still use
   `assembleContext` — staged rollout.
5. No semantic relevance ranking (infrastructure-only milestone).
