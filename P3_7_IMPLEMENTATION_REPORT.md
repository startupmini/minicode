# P3.7 — Advanced A+C Full-Coverage Fold Producer: Implementation Report

Status: **VALID**. P3.7 implements the owner-ratified deterministic, rule-based,
LLM-free fold renderer and integrates it through the existing P3.4 producer seam —
no second writer, no second store, no schema change, no publication bypass. A
full-history fold now produces a CURRENT (`base_seq == head+1`) projection that the
P3.3 selector consumes as `summary-plus-tail`, proven end-to-end on the real
production path.

---

## 1. Executive summary

The P3.4 limitation is closed at its root: `mechanicalCompaction` structurally retains
a tail, so P3.4 could only emit PARTIAL (rule-8 STALE) projections. The new pure module
`src/session/full-history-fold.ts` renders the ENTIRE canonical range `[0, N)` — one
fold line per source row — and the P3.4 producer accepts it through a narrow,
default-preserving `fold: "full-history"` policy dispatch. The persisted row satisfies
the existing P2.7 CURRENT contract (`base_seq == head+1`, intact anchor), and the
unchanged P3.3 selector consumes it. All 19 new tests pass; all neighboring suites pass;
the full suite shows zero P3.7 regressions.

## 2. Exact baseline commit and final commit

- Baseline: `21224ec3e5e280c2955ed880a88a7f4f5b7683e5` (== `origin/main`, clean tree).
- Implementation commit: `7e4b6d9c13e6639952735c27d4d5f6d7c4b00e72`
  (`p3.7: add deterministic full-coverage fold renderer`, == `origin/main`).

## 3. Source files changed and why

| File | Change | Why |
| --- | --- | --- |
| `src/session/full-history-fold.ts` (new, ~160 lines) | Pure deterministic full-coverage renderer (`renderFullHistoryFold`, `FoldError`, `FULL_HISTORY_FOLD_VERSION`) | The missing P3.7 capability; kept separate from P3.4 lifecycle per audit §10 |
| `src/session/context-projection.ts` | `ProjectionProducePolicy.fold?: "mechanical" \| "full-history"` + dispatch + `foldFullHistory` guard wrapper | Narrowest seam: reuse the single `buildProjection` write path; default preserves mechanical behavior byte-for-byte |
| `test/full-history-fold.test.ts` (new, 19 tests) | Full §6 matrix | Proof per ratified gate |
| `docs/ARCHITECTURE.html` | One module-map entry | Required by `architecture-map.test.ts` (tracked `src/**` must appear) |
| `P3_ROADMAP.md` | Status lines only (P3.5→VALID, P3.7→VALID) | Record result; ratified policy text untouched |
| `P3_7_IMPLEMENTATION_REPORT.md` (new) | This report | Evidence |

No changes to: `persistence.ts`, `context-selector.ts`, `context-assembly.ts`,
`context-adapter.ts`, `context-identity.ts`, `cli/`, `vendor/`, or any other test.

## 4. Ratified policy compliance

| Ratified item (roadmap §P3.7.1–12) | Implementation |
| --- | --- |
| Deterministic / rule-based / LLM-free / network-free | Pure function; no IO/random/clock/LLM/network imports |
| Source-traceable / derived-only | One line per row with `[seq=N]` markers; no writes of any kind |
| Full coverage ≠ lossless | Documented in module header + report; never claims verbatim copy |
| Preserve material state (§4.3) | Goals/decisions/tasks/tool results+errors/facts/uncertainty rendered; exact values (paths, hashes, numbers, errors) preserved via head-caps, not paraphrase |
| Permitted condensation (§4.4) | Only char-level head truncation (400/200/80, kernel-aligned); no message dropped, no fact inferred |
| Unsafe input → refuse, no new status/basis | `FoldError` on empty/gap/unknown-role/missing-identity; producer maps refusal to honest no-op |
| A+C invariant | Context-only transform + separately stored derived summary; canonical untouched (fingerprinted) |
| Determinism | Same rows → byte-identical output (P3.7-7); `built_at` stays in P2.7 primitive |
| Existing schema | Reused verbatim; no new fields |
| Single producer authority | Renderer consumed BY the P3.4 producer; one `buildProjection` path |
| Marker reuse | Existing `context.compacted` bridge untouched and untriggered by new code |
| P3.4/P3.5 boundaries | P3.4 owns persistence; P3.5 owns bridges; no relevance ranking |

The one intentional, documented deviation from kernel precedent: non-error tool results
are rendered (head 200) rather than `<result omitted>`, because full coverage requires
every sequence to be accounted for — omitting them would violate §4.3 (tool side
effects). Error results keep the kernel's `ERROR` marker.

## 5. Renderer API and determinism

```ts
renderFullHistoryFold(rows: readonly FoldSourceRow[]): FullHistoryFold
// → { summaryText, baseSeq /* == rows.length */, includedRanges: [[0, N]],
//     rowCount, lineCount /* == rowCount */, policyVersion }
```

- Pure: inputs are data; no DB/IO/clock/random. `Date.now` appears nowhere in the module.
- Deterministic: identical input yields byte-identical `summaryText` (P3.7-7); rebuilds
  after deletion reproduce equivalent rows (P2.7 semantic idempotence preserved).
- Versioned: `FULL_HISTORY_FOLD_VERSION = "full-history-fold-v1"` travels on every result
  so future policy changes are distinguishable.

## 6. Source sequence accounting and full-coverage proof

- Continuity is proven, not assumed: seqs must equal exactly `0..N-1` in order; any gap,
  duplicate, or reorder throws `FoldError` (P3.7-10).
- Coverage is proven by construction: the renderer emits exactly one line per row
  (`lineCount === rowCount`, asserted in code path and tests P3.7-1/7).
- `baseSeq` is not an input — it is derived as `rows.length`, so the claimed coverage
  cannot diverge from the processed range.
- `includedRanges` is always `[[0, N]]`, the canonical full-coverage form.

## 7. Identity, anchor, frontier, and history-commit handling

The renderer itself carries no identity (pure content function — by design, to keep the
single authority for identity in P2.7/P3.2). Binding happens at the existing seams:
- `buildProjectionInTxn` resolves `anchor_event_id` from row `base_seq - 1` (= head row
  for full coverage) and rejects NULL-event_id holes — unchanged.
- P3.2 frontier/`historyCommit` are recomputed by existing readers from canonical rows.
- The producer passes no caller-supplied anchor; the anchor always comes from the DB
  inside the write txn (no TOCTOU fabrication).

## 8. Integration with the existing P3.4 producer

`produceSummaryProjection` accepts `policy.fold` (`"mechanical"` default). When
`"full-history"` and no explicit `summaryText` is supplied, it calls the P3.7 renderer
over the freshly loaded canonical rows, then flows into the **identical**
`buildProjection` epoch-fenced write. Staleness analysis: if canonical advances between
the read and the write, the persisted row covers the older prefix — still anchor-valid,
hence at worst rule-8 STALE (honest), never falsely CURRENT (CURRENT requires
`base_seq == head+1` at read time, enforced downstream by the unchanged status machine).
Explicit `summaryText` + `baseSeq` caller override still takes precedence untouched.

## 9. Projection schema/status/freshness behavior

- Schema reused verbatim; no new fields, no migration.
- Full-history output: `base_seq == head+1` → CURRENT (rule 9), verified live
  (`{"state":"CURRENT","detail":"coverage matches head, anchor holds"}`).
- Existing partial path untouched: mechanical output still yields rule-8 STALE (P3.7-16).
- Rule-7 anchor-broken still rejected by the N1-hardened reader; DIVERGED/UNKNOWN paths
  untouched.
- P3.3 consumes CURRENT full-history as `summary-plus-tail` via its existing strategy —
  no selector change (verified: `basis summary-plus-tail`, synthetic summary first).

## 10. Existing writer and authority boundaries preserved

- No new SQL, no new table, no direct DB access in the renderer (imports: kernel
  `contentToText`/`safeStringify` + `scrubSecrets` only).
- Single projection writer: `buildProjectionInTxn` remains the only write path
  (structural: renderer has zero persistence imports).
- No canonical-history write path added (P3.7-17 fingerprints `messages` unchanged).
- Writer inventory: no new `console.*`/`process.std*` writers added (renderer/tests emit
  none); inventory suite green.
- Architecture map: new module registered (map test green).

## 11. Concurrency and epoch-fencing behavior

- The fold itself is pure (no race surface).
- Persistence reuses P3.4's existing epoch fence: `buildProjection` requires
  `expectedEpoch`; stale epoch → throw, no row (P3.7-18).
- Source-advance race: covered in §8 — worst case is an honest rule-8 STALE row, never
  a false CURRENT (CURRENT is a read-time property of the status machine, not a claim
  stamped by the producer).
- No new transaction abstraction; no invented epochs; no epoch check removed.

## 12. P3.5/P2.11 marker integration

No new marker code. The existing `context.compacted` bridge (P3.5 adapter + presentation
adapter) fires on the kernel's compaction events exactly as before; a full-history fold
is itself a projection write, not a compaction, so it neither emits nor requires a
marker. Marker/idempotency/epoch behavior therefore unchanged (existing P3.5 tests green).

## 13. Failure and recovery semantics

| Case | Behavior | Test |
| --- | --- | --- |
| Empty history | `FoldError` → producer no-op, no row | P3.7-11 |
| Gap/discontinuity | `FoldError` → no-op | P3.7-10 |
| Unknown role / missing identity | `FoldError` → no-op | P3.7-12/13/14 |
| Stale epoch at persist | throw, no row, canonical intact | P3.7-18 |
| Append after build | honest STALE (no false CURRENT) | P3.7-19 |
| Duplicate/retry | idempotent replace (same content) | P3.4-2 (existing) |
| Delete + rebuild | deterministic reproduce | P3.4 pattern (existing) |

Failures never touch canonical history; recovery is rebuild-from-canonical.

## 14. Tests added, with test names and results

`test/full-history-fold.test.ts` — **19 pass, 0 fail**:
P3.7-1 (mixed history, one-line-per-row, baseSeq==N); P3.7-2 (goals/decisions/tasks);
P3.7-3 (tool actions/results/errors); P3.7-4 (exact values); P3.7-5 (reasoning/
uncertainty); P3.7-6 (secret scrubbing via existing path); P3.7-7 (determinism);
P3.7-8 (policy version); P3.7-9 (input immutability); P3.7-10/11/12/13/14 (refusals);
P3.7-15 (full-history → CURRENT + selector `summary-plus-tail`, production path);
P3.7-16 (mechanical default unchanged); P3.7-17 (canonical untouched); P3.7-18
(epoch fence); P3.7-19 (honest STALE after append).

## 15. Validation commands and exact outcomes

| Step | Command | Outcome |
| --- | --- | --- |
| 1. New renderer tests | `bun test test/full-history-fold.test.ts` | 19 pass / 0 fail |
| 2–4. Projection/substrate | `bun test test/context-projection.test.ts test/projection-foundation.test.ts test/p2-history-projection.test.ts` | 60 pass / 0 fail |
| 5. Selector + resume + identity + guard | `bun test test/context-selector.test.ts test/context-selector-resume.test.ts test/context-identity.test.ts test/p3-reconciliation-guard.test.ts` | 94 pass / 0 fail |
| 6. P2.8/compaction/presentation/assembly | `bun test test/p2-history-projection.test.ts test/presentation-projections.test.ts test/compaction.test.ts test/context-assembly.test.ts` | 71 pass / 0 fail |
| 7–9. Maps/guards | `bun test test/writer-inventory.test.ts test/architecture-map.test.ts test/m16-architecture-audit.test.ts test/p2-architecture-guards.test.ts` | 67 pass / 0 fail |
| 10. Typecheck | `bun x tsc --noEmit` | 28 errors, all in pre-existing `test/phase3*`/`test/phase4*`; **0 in P3.7/P3.4 files** |
| 11. Lint (touched files) | `bun x biome check src/session/full-history-fold.ts test/full-history-fold.test.ts src/session/context-projection.ts` | clean (after literal-keys + dot-notation normalization) |
| 12. Full suite | `bun test` | **4441 pass / 9 fail** |

## 16. Full-suite/typecheck failure classification

| Failure | Class | Evidence |
| --- | --- | --- |
| `integritas encoding berkas > tidak ada U+FFFD` | **PRE-EXISTING** | Offender is `P3_7_ARCHITECTURE_AND_CONTRACT_AUDIT.md` (3 chars), a file untouched by this change (`git diff` empty); my 4 files contain 0 U+FFFD |
| `P3: konstruktor authority runtime hanya di src/runtime` | **PRE-EXISTING** | Offender `src/runtime/dispatch.ts: createRecoveryEngine`; deterministic in isolation; disjoint files/symbols from P3.7 |
| `S13 scheduler-first` | **PRE-EXISTING** | Deterministic source-text assertion on `cli/setup.ts` composition order; I did not touch `cli/` or runtime |
| `audit: manifes korup dibackup…` | **FLAKY** | 9 pass / 0 fail in isolation |
| `P2.2` ×2, `P2.1` ×2 | **FLAKY** | Pass in isolation (`session-epoch` 13/13, `session-identity` 12/12) |
| `web ssg > docs tanpa nested list` | **PRE-EXISTING** | Offenders in `docs/TASK_EVENT_MODEL.md`, untouched |
| tsc 28 errors | **PRE-EXISTING** | All in `test/phase3*`/`test/phase4*`; none in touched files |

**Zero P3.7 regressions.** No test was modified to make the suite pass (only additive
changes: new module, new tests, extended policy type, arch-map entry, roadmap status).

## 17. Known limitations and follow-up items

1. **Truncation caps are fixed** (400/200/80, kernel-aligned). Extremely long single
   values are head-truncated; caps are documented constants, not policy inputs. A future
   policy extension could parameterize them — explicitly out of scope.
2. **No cross-message semantic merging.** The renderer preserves per-row lines; it does
   not deduplicate repeated statements across rows or synthesize higher-level conclusions
   (that would require semantic inference, forbidden by the ratified policy).
3. **Fold policy has one version** (`full-history-fold-v1`); no policy registry. The
   version field exists precisely to support future versioning without silent drift.
4. **Mechanical path is the default**; full-history must be opted in via
   `policy.fold: "full-history"`. No production caller was switched — wiring a production
   trigger is a separate composition decision, deliberately left out of this milestone.
5. **Image content** renders as `[image:mime]` placeholders via the existing
   `contentToText` (no byte inspection); consistent with kernel behavior.

## 18. Git verification: working tree, branch, remote, commit, and push status

Recorded after push (see §2 for SHAs).

## 19. Final verdict

**VALID.** Every closure criterion is met with direct evidence: deterministic pure
renderer implemented; full-coverage proof by construction (continuity check + one-line-
per-row + baseSeq derived, never input); material state preserved with exact values;
refusals explicit with no new statuses; single P3.4 write path reused with epoch fencing;
CURRENT achieved and consumed via existing contracts; no second authority/store/marker;
mutation probes confirm load-bearing tests; validation green with zero regressions.

```text
MINICODE P3.7 IMPLEMENTATION STATUS:
VALID

Renderer:
IMPLEMENTED (src/session/full-history-fold.ts, pure, deterministic, LLM-free)

Coverage proof:
BY CONSTRUCTION (continuity check + one-line-per-row + derived baseSeq)

Producer integration:
SINGLE P3.4 PATH (policy.fold dispatch, default-preserving)

CURRENT projection:
ACHIEVED (base_seq == head+1, anchor-validated, selector-consumed)

P3.4 boundary:
PRESERVED

P3.5 boundary:
PRESERVED

P3.3 boundary:
PRESERVED (no selector change)

P2.7 boundary:
PRESERVED

Second authority/store/marker:
NONE

Targeted tests:
PASS (19/19 new + all neighboring suites green)

Mutation/non-vacuity:
PASS (continuity/scrub/seam probes fail as required, restored)

Full suite:
CLASSIFIED_FAILURES (4441 pass / 9 fail: 4 pre-existing deterministic + 5 flaky, 0 P3.7)

Typecheck:
CLASSIFIED_ERRORS (28 pre-existing phase3/4, 0 new)

Known limitations:
per §17 (fixed caps; no cross-row merging; single policy version; opt-in only; image placeholders)

P3.8:
NOT STARTED

CONFIDENCE:
HIGH
```