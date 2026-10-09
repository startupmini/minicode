# P3.7 — Full-Coverage Fold Content Policy Ratification Report

Owner ratification of the P3.7 content policy. **No implementation performed.**
Documentation/roadmap changes only.

---

## 1. Previous decision state

The P3.7 architecture audit (`P3_7_ARCHITECTURE_AND_CONTRACT_AUDIT.md`) concluded
`READY WITH CONDITIONS`, with exactly one bounded condition: owner ratification of the
full-coverage fold content policy (preserve-vs-omit thresholds + deterministic LLM-free
renderer requirement). All other contracts (A+C semantics, output schema, producer
ownership, marker bridge, epoch fencing, determinism, provenance, failure, test
contract) were already defined from canonical evidence.

## 2. Why ratification was required

A+C defines *what kind of thing* a fold is (context-only derived summary, separately
stored) but not *what content* a full-history fold must preserve vs may omit. Without
that policy, an implementation could silently drop operationally significant content
(decisions, errors, tool side effects) while claiming full coverage — a correctness
failure no status machine can detect, because coverage metadata (`base_seq`,
`included_ranges`) only records *which rows were processed*, not *whether their content
was faithfully represented*.

## 3. A+C semantics (preserved)

Per `P3_0` §9: A = context-only transformation; C = separately stored derived summary;
B (canonical-history rewrite) = NON-CONFORMING. Canonical history remains the sole
authority; the fold is reconstructable from the intact prefix. No change.

## 4. Ratified deterministic LLM-free fold model

The P3.7 fold is DETERMINISTIC, RULE-BASED, LLM-FREE, NETWORK-FREE,
SOURCE-TRACEABLE, DERIVED-ONLY. Same history + same policy = equivalent content.
Excluded: LLM summaries, remote inference, embeddings/vector search, randomized
selection, wall-clock as content input, unsupported semantic inference.
`built_at` remains build-time metadata only.

This is consistent with `P3_0` §9's provenance slot ("model identity"): for a
deterministic renderer, the renderer identity/version fills that slot — the contract
requires *an* identified producer, not an LLM specifically. No contradiction found.

## 5. Required content preservation

Preserve the meaningful state needed to continue work: user goals/requirements/
constraints; decisions, approvals, rejections, commitments; task state and unresolved
work; tool actions with meaningful results and observable effects; errors, refusals,
recovery outcomes, failure conditions; established facts/constraints/relationships;
superseding facts; outstanding questions/uncertainty; identity/provenance for
traceability. Exact values (paths, identifiers, commands, hashes, numbers/thresholds,
error messages, structured tool results, retrieval references) preserved accurately,
not paraphrased.

## 6. Permitted condensation/omission

Only without violating preservation: greetings/filler; content-free repetition;
duplicate tool output; redundant restatement of unchanged facts; verbose intermediates
whose relevant result is retained; superseded intermediate state (with valid current
state + meaningful supersession preserved). Never omit for length alone; never treat
errors/decisions/rejections/side effects as redundant without a defensible rule; never
infer missing facts; when a message mixes filler with operational content, preserve the
operational content.

## 7. Full-coverage semantics

Full coverage = every source sequence in `[0, base_seq)` processed and accounted for
under the policy — **not** lossless preservation. The fold must never claim verbatim
fidelity it lacks, nor claim full coverage for an unprocessed range. Coverage metadata
(`base_seq == head+1`, `included_ranges == [[0, base_seq]]`, intact
`anchor_event_id`) and fold content must agree; P2.7 rule 9 (CURRENT) remains the
verifier. Existing CURRENT / PARTIAL / rule-7 / rule-8 / DIVERGED / UNKNOWN
distinctions preserved; rule-7 stays rejected.

## 8. Failure policy

Empty history, unsupported/malformed content, missing rows, source drift mid-fold,
incorrect anchors, partial output, generation/persistence/marker failures, duplicates,
stale writers, invalid existing projections: fail safe per the existing contracts
(refuse full-history claim; fall back to full canonical history + explicit status; retry
only where idempotent). No new statuses or `SelectionBasis` values. Missing fold ≠
successful coverage. Fold failure never touches canonical history; non-atomic
fold→record→marker steps recover via rebuild (canonical source) and marker
reconciliation (idempotent dedup).

## 9. Determinism and test obligations

Same history + same policy = equivalent content across time, entrypoint, retry,
redelivery, and rebuild. Future implementation must prove: full range processed;
preservation/omission rules followed; identity/anchors correct; incomplete output cannot
claim full coverage; determinism; derived-only output; canonical untouched.
(Tests to be written at implementation time per the audit's §15 contract.)

## 10. Projection ownership

P3.7 provides the pure fold renderer; P3.4 retains the single persistence path
(`buildProjectionInTxn`); P3.5 retains runtime metadata/bridges; P3.3 stays a read-only
selector; P3.1/P2.7 stays the publication boundary. No second producer, store, or
marker system.

## 11. Durable marker ownership

Fold markers reuse the approved P3.5/P2.11 primitives (`appendPresentationEvents`:
idempotent, epoch-fenced, collision-surfaced). Emission ordered after successful
persistence; reconcile-marker-only recovery on partial failure.

## 12. P3.4/P3.5 boundaries

P3.4 owns schema + lifecycle + persistence; P3.5 owns runtime metadata + bridges
(including the revision/provenance transport the fold's output will flow through);
P3.7 owns fold content generation only. Semantic relevance ranking stays later work.

## 13. Files changed

| File | Change |
| --- | --- |
| `P3_ROADMAP.md` | new P3.7 policy subsection + status line |
| `P3_7_ARCHITECTURE_AND_CONTRACT_AUDIT.md` | §23 owner-ratification record (findings preserved) |
| `P3_7_CONTENT_POLICY_RATIFICATION_REPORT.md` | new (this report) |

No `src/`, `cli/`, `tools/`, `test/`, `vendor/` changes.

## 14. Commit SHA

`acf16e4c301845125c448f5fd40302a53ab86ff2`
(`docs: ratify P3.7 full-coverage fold content policy`), parent `5420437`.

## 15. Push verification

Pushed `5420437..acf16e4` (fast-forward, no force).
`HEAD == origin/main == acf16e4c301845125c448f5fd40302a53ab86ff2`; working tree CLEAN.

## 16. Final P3.7 readiness

With the content policy ratified, the audit's single condition is satisfied: P3.7 scope
CLEAR, A+C DEFINED, output contract CLEAR, ownership SINGLE, marker DEFINED, fencing
SAFE, determinism PASS, test contract DEFINED, no blockers. **P3.7 is READY TO
IMPLEMENT** (implementation itself not started in this task).

---

```text
MINICODE P3.7 CONTENT POLICY RATIFICATION:
SECURED

A+C semantics:
PRESERVED

Fold model:
DETERMINISTIC / RULE-BASED / LLM-FREE

Full-coverage semantics:
DEFINED

Preserve/omit policy:
RATIFIED

Failure contract:
DEFINED

Projection writer ownership:
SINGLE — P3.4

Advanced fold renderer:
P3.7

Durable marker:
EXISTING P3.5/P2.11 PRIMITIVES

Canonical history authority:
PRESERVED

P3.4 boundary:
PRESERVED

P3.5 boundary:
PRESERVED

Implementation:
NOT STARTED

Documentation files:
P3_ROADMAP.md
P3_7_ARCHITECTURE_AND_CONTRACT_AUDIT.md
P3_7_CONTENT_POLICY_RATIFICATION_REPORT.md

Commit:
acf16e4c301845125c448f5fd40302a53ab86ff2

origin/main:
acf16e4c301845125c448f5fd40302a53ab86ff2

Working tree:
CLEAN

P3.7 implementation readiness:
READY TO IMPLEMENT

Recommended next action:
Prepare the P3.7 implementation prompt using the ratified policy.

CONFIDENCE:
HIGH
```