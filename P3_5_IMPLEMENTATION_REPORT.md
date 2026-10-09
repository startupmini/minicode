# P3.5 — Runtime Context Adapter: Implementation Report

Status: **VALID**. The runtime seed metadata gap is closed (a host-side carrier now
transports `ContextSelection` identity/frontier/revision/basis/freshness/provenance past
the kernel seed), and the headless compaction gap is closed (the autonomous-child path —
the only production path without a presentation adapter — now bridges kernel
`context:compacted` into a durable `context.compacted` marker through the existing
`appendPresentationEvents` channel). No new store, schema, vendor/kernel change;
canonical history remains the sole authority; P3.1/P2.7 untouched.

---

## 1. Baseline and checkpoint chain

- Start: `0381bf5893123f6c72671f60fb918e0cf4b06476` == `origin/main`, tree clean.
- Phase A checkpoint: `b957115` (`docs: record P3.5 runtime adapter architecture audit`).
- Phase B contract ratification: `0381bf5` (`docs: ratify P3.5 runtime adapter contract`).
- Implementation began from `0381bf5` (== origin/main at the time).

## 2. Ratified P3.5 contract

Per `P3_ROADMAP.md` (Phase B): a thin host-side metadata carrier + lifecycle bridge;
`ContextStore` stays a runtime buffer; canonical history stays sole authority; P3.2
describes; P3.3 selects; P3.4 produces derived projections; P3.1/P2.7 guards publication.
Implementation reuses `ContextSelection`, `deriveFrontierFromDurable`,
`rowsToCanonicalRefs`, `readConsumableSummaryProjection`, `ModelContextProvenance`, and
`appendPresentationEvents`. No new store/schema/vendor/kernel change.

## 3. Existing primitives reused

No algorithm reproduced: `ContextSelection`/`ContextIdentity`/`ContextFrontier`/
`ModelContextProvenance` (types); `deriveFrontierFromDurable` (canonical frontier);
`rowsToCanonicalRefs`; `readConsumableSummaryProjection`; `countDurableCompactions`
(revision source); `appendPresentationEvents` (durable write primitive, idempotent,
epoch-fenced); the kernel `SessionConfig.initialMessages` / `Session.events` seam.

## 4. Runtime metadata carrier

`RuntimeContextMetadata` (`src/session/context-adapter.ts`): `{ sessionId, threadId,
identity|null, frontier|null, revision, selectionBasis, freshness, coveredSeq,
provenance? }`. Built by `runtimeMetadataFromSelection(selection, canonicalRevision)` —
pure, no IO. When the frontier is absent: identity/frontier/provenance absent,
`freshness="unknown"`, revision falls back to the observed canonical revision (never
invented). Identity is exactly the 4 P3.2 fields (no extra-shape leak).

## 5. `ModelContextProvenance` lifecycle

Previously type-only (never constructed anywhere). Now `provenanceFromSelection` builds
it from the selection: `contextIdentity` (exact 4 fields), `canonicalFrontier`
(the selection's frontier), `selectionBasis`; `projectionRevision` deliberately absent
(the selection carries no versioned-projection identity; P3.2 forbids guessing). It is
embedded in the carrier (`metadata.provenance`) and exposed on the session handle.

## 6. Runtime seed integration

`cli/setup.ts` resume seam: after `selectContext`, the carrier is constructed from the
selection (with the observed `revision`) and exposed as `CliSession.runtimeContextMetadata`.
`initialMessages` still contains only valid runtime messages — no metadata is injected as
fake model messages. Fresh sessions (no resume) expose `undefined` (no freshness claim).
The interface addition is additive/optional; all existing consumers unaffected.

## 7. Revision propagation

`revision` = the observed durable-compaction count (`countDurableCompactions`), carried
through the carrier (`metadata.revision`). It is propagated, never fabricated: from the
frontier when present, otherwise the observed canonical revision. Hard rule verified by
tests (removing propagation fails P3.5-2).

## 8. Normal CLI/ACP/exec path

Unchanged behaviorally: the same resume seam now additionally publishes the carrier.
Model-visible messages are byte-identical (P3.3 suite green; cli-session suites green).
No publication logic touched.

## 9. Autonomous/headless path

The delegate_task child path already had durable compaction coverage (child presentation
adapter installed at `cli/index.ts`, `journal` branch) — verified, so no second bridge
was attached there (attaching one would double-write). The gap was the
**autonomous-context factory** (`cli/setup.ts` autonomous `sessionFactory`), which
creates kernel sessions with no adapter: the P3.5 bridge (`attachHeadlessCompactionBridge`)
is now attached there, using the spec's `sessionId`/`cwd` and the session's event bus,
with epoch evaluated at event time. Autonomous execution behavior is otherwise unchanged.

## 10. `context.compacted` bridge

`bridgeCompactionToDurable`: allocates the next `eventSeq` via `nextPresentationEventSeq`
(`presentationHead + 1`, reusing the P2.11 helper — no full-history scan), builds a
`context.compacted` DomainEvent (`{ eventSeq, ts, sessionId, turnId, reason }`), and
writes through `appendPresentationEvents` (dedup-identical-payload idempotence, epoch
fence when an epoch is held, collision surfaced not silent). Failure is best-effort:
reported via stderr (the `src/session` convention) and returned as `{ bridged: false }`
— never touching canonical history.

## 11. Failure and recovery semantics

Missing identity/frontier → null + `freshness="unknown"` (no invented certainty).
Missing revision → observed fallback (never fabricated). UNKNOWN stays UNKNOWN.
Stale/diverged → labelled, never promoted (P3.2 semantics reused). Duplicate delivery →
safe via existing dedup. Bridge failure → explicit `{ bridged:false }` + warn; canonical
history provably untouched (P3.5-11 fingerprint). No new retry loop (the primitive's own
busy-retry applies).

## 12. Identity/frontier correctness

Carrier preserves exact `ContextIdentity` fields; `canonicalFrontier` is the selection's
own frontier object; session/thread scoping proven (P3.5-7: cross-session anchors differ;
`canonicalFrontier` retains its session).

## 13. Publication boundary

The adapter has no canonical write path: its only DB call is `appendPresentationEvents`
(line 180, presentation-event channel). Structural guard P3.5-13 (no
`saveSession`/`shrinkThreadHistory`/`bun:sqlite`/messages-SQL in the module). The single
`saveSession` funnel (`cli/setup.ts:2032`) is untouched. **PRESERVED.**

## 14. Writer inventory

`writer-inventory.test.ts` scans only `cli/**` and `src/ui/**`. The adapter's failure
`stderr.write` lives in `src/session/` (established precedent: journal/checkpoint/
persistence all write there) and is not inventoried. No new `console`/`process.std*`
writer was added to `cli/` or `src/ui/`. **PASS** (3/3 with architecture-map).

## 15. Tests and production-path reachability

`test/context-adapter.test.ts` (13 tests): P3.5-1..4 (metadata/provenance pure, from real
`selectContext` output); P3.5-5/6 (real `createCliSession` resume/fresh — production path);
P3.5-7 (scoping); P3.5-8/9 (real `bridgeCompactionToDurable` + real event-bus attach
writing durable markers); P3.5-10 (idempotent re-delivery → dedup); P3.5-11 (epoch failure
leaves canonical intact); P3.5-12 (freshness carried); P3.5-13 (structural publication
guard). All load-bearing on the production adapter, not on fake metadata doubles.

## 16. Mutation/non-vacuity evidence

| Probe | Mutation | Expected | Actual | Restored |
| --- | --- | --- | --- | --- |
| 1 | hardcode `revision: 0` | P3.5-2 fails | 1 fail (P3.5-2) | exact hash `E14423FD…` |
| 2 | `provenanceFromSelection` → always undefined | provenance tests fail | 3 fail (P3.5-4/5/7) | exact hash |
| 3 | bypass bridge (no write) | bridge tests fail | 3 fail (P3.5-8/9/10) | exact hash |
| 4–5 | UNKNOWN promotion / P2.7 bypass | existing P3.2/P3.1/P3.3-32 guards | covered (suites green) | n/a |

No historical mutation evidence reused.

## 17. Validation and failure classification

| Target | Result |
| --- | --- |
| P3.5 adapter (13) | **13/13 pass** |
| P3.3 selector + resume, P3.2, P3.4, P2.8, P3.1 guard (14/14) | pass |
| P2.7 persistence, P2 guards, writer-inventory, architecture-map | pass |
| targeted batch (10 files) | **177/177 pass** |
| typecheck | **28 errors, 0 new** (pre-existing `test/phase3*`/`phase4*`) |
| **full suite** | **4423 pass / 23 skip / 8 fail** (300 files / 4454 tests) |

Full-suite failures (8): `audit-manifes-korup`, `P2.1 ×2`, `P2.2 ×2` = **FLAKY** (green in
isolation 34/34); `P3-constructor (m15)`, `S13`, `web-ssg` = **PRE-EXISTING/ENV**.
**No P3.5 regression.** Baseline before P3.5 work: 4410/23/8; delta = +13 new tests,
+1 file, same 8-failure envelope.

## 18. Authority audit

| Component | Reads | Writes | Durable | Authority |
| --- | --- | --- | --- | --- |
| Canonical history | via persistence | persistence only | yes | AUTHORITATIVE |
| P2.7/saveSession | canonical rows | `messages` | yes | CANONICAL DECIDER |
| P3.2 | rows (passed in) | none | no | DERIVED |
| P3.3 selector | rows+projection | none | no | DERIVED |
| P3.4 producer | canonical rows | `history_projections` | yes | DERIVED |
| **P3.5 adapter** | selection + durable events | `presentation_events` (bridge only) | via bridge | DERIVED |
| ContextStore | — | kernel append/replace | no | RUNTIME BUFFER |
| P3.1/P2.7 | proposed history | `messages` | yes | PUBLICATION SAFETY |

No new store, shadow history, duplicated freshness logic, fabricated revision, hidden
canonical write, or CLI/headless authority divergence. **PASS.**

## 19. Known limitations

1. Carrier is host-side RAM on the `CliSession` handle; it is not itself durable (by
   design — durable truth stays canonical).
2. The headless bridge is attached at the autonomous factory seam in `cli/setup.ts`;
   consumers that construct kernel sessions outside these factories get no bridge
   (same as today — no regression).
3. `turnId` for bridged markers defaults to 0 when the kernel event carries no turn
   (the kernel `context:compacted` has no turn); `reason` is passed through.
4. Autonomous child `expectedEpoch` is evaluated at event time and may be absent
   (writes then unfenced, matching the existing child-adapter convention).
5. No semantic relevance ranking (out of scope).

## 20. Final verdict

All closure criteria satisfied: seed metadata preserved; identity/frontier correct or
explicitly UNKNOWN; revision propagated never fabricated; provenance constructed and
propagated; normal path covered; headless bridge implemented via the approved channel;
repeated delivery safe; failure explicit; `ContextStore` non-authoritative; no new
store/writer; P3.1/P2.7 preserved; P3.4/P3.7 untouched; production-path tests green;
non-vacuity current; validation classified; authority audit passes.

```text
MINICODE P3.5 IMPLEMENTATION STATUS:
VALID

Runtime adapter:
IMPLEMENTED

Runtime seed metadata:
PRESERVED

ContextIdentity:
PASS

ContextFrontier:
PASS

Revision propagation:
PASS

Revision fabricated:
NO

ModelContextProvenance:
PASS

Normal CLI/ACP/exec lifecycle:
PASS

Headless compaction bridge:
PASS

Durable marker:
PRESENT

Idempotency:
PASS

Failure/recovery:
PASS

ContextStore authority:
NON-AUTHORITATIVE

Canonical authority:
PASS

P3.1/P2.7 publication boundary:
PRESERVED

P3.4 boundary:
PRESERVED

P3.7 boundary:
PRESERVED

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

Typecheck:
CLASSIFIED_ERRORS

Known limitations:
1. Carrier is host-side RAM (not durable by design).
2. Bridge attached at the autonomous factory seam; sessions built outside these factories get no bridge.
3. Bridged marker turnId defaults to 0 (kernel event carries no turn).
4. Child epoch evaluated at event time; may be absent (unfenced, matching convention).
5. No semantic relevance ranking (out of scope).

Final commit:
b08ee60b6b035702980d8447d225a277cb68d40f (implementation)
6fbcc14b14b4c3a1303d0af7ed6671afd050d785 (tip: SHA-backfill docs commit)

origin/main:
6fbcc14b14b4c3a1303d0af7ed6671afd050d785

Working tree:
CLEAN

P3.7:
NOT STARTED

CONFIDENCE:
HIGH
```