# P3.4 — N1 Hardening Report

Status: **VALID** (N1 resolved). Rule-7 anchor-broken STALE projections are now rejected by
`readConsumableSummaryProjection`; rule-8 anchor-intact partial projections remain
consumable; the production `summary-plus-tail` path is unaffected. No P3.5/P3.7 work.

---

## 1. Audit checkpoint SHA

- `7a1b4a19ed227fcadb51825fa64036ed88ca849c` — `docs: record P3.4 canonical truth audit`
  (the completed post-implementation audit, pushed `e18d874..7a1b4a1`).

## 2. Original N1 finding

The current-truth audit found: `readConsumableSummaryProjection` accepted **any** STALE
state, including **rule-7** (anchor-broken / boundary identity changed or gone), while the
implementation report claimed "STALE-with-intact-anchor". Verified empirically: forging the
boundary row's `event_id` still returned the projection as consumable. Rule-7 was
unreachable on the automatic path, so it was a defensive robustness gap + report-wording
drift, not a live violation.

## 3. Rule-7 semantics

`getProjectionStatus` returns `STALE` with detail **"boundary event changed or gone"** when
the projection's `anchor_event_id` no longer matches `messages[base_seq-1].event_id`. The
covered prefix `[0, base_seq)` may no longer correspond to the canonical prefix — the
summary is **not trustworthy** as a derived source)Skip.

## 4. Rule-8 semantics

`getProjectionStatus` returns `STALE` with detail **"head advanced beyond coverage"** when
`head >= base_seq` **and** the anchor is intact. The covered prefix is **still valid**
(coverage-valid per P3.0 §8 D6); the projection remains consumable as a derived summary
source with the canonical tail supplied fresh.

## 5. Implementation change

- `src/session/persistence.ts`: added the stable exported constant
  `PROJECTION_STALE_HEAD_ADVANCED_DETAIL = "head advanced beyond coverage"` (the rule-8
  detail). No status vocabulary or semantics changed.
- `src/session/context-projection.ts` `readConsumableSummaryProjection`: now accepts STALE
  **only** when `status.detail === PROJECTION_STALE_HEAD_ADVANCED_DETAIL` (rule-8);
  any other STALE (rule-7 anchor-broken, or future unknown sub-case) → `null`. CURRENT is
  unchanged. No duplicate anchor logic; the existing status classification is reused.

## 6. Regression tests

- **P3.4-19 (N1 rule-7):** produce a projection, then forge the boundary row's `event_id`;
  asserts status STALE with detail "boundary event changed or gone" and
  `readConsumableSummaryProjection → null`. Fails against the pre-fix code.
- **P3.4-20 (N1 rule-8):** produce a normal partial projection; asserts status STALE with
  detail "head advanced beyond coverage" and `readConsumableSummaryProjection` remains
  non-null. Guards against over-rejection (fixing N1 by rejecting all STALE).

Both green (20/20 P3.4 suite).

## 7. Non-vacuity evidence

- **Negative probe:** inverted the guard (`accept any STALE`) → **P3.4-19 fails**
  (1 fail), then restored to the exact guard text (hash re-verified, tests green).
- **Positive probe:** rule-8 test P3.4-20 remains green with the hardening in place
  (no regression of legitimate partial consumption).

## 8. Production E2E

Re-run on committed code: seed 8 turns → resume → `persistCurrent` →
`[projection sid=e2e base=12 status=produced]` → resume again →
`[select … basis=summary-plus-tail freshness=fresh head=15]`, history = 5 messages, first =
`Previous context [0,12):…`. **Production `summary-plus-tail` remains functional.**

## 9. Validation

| Target | Result |
| --- | --- |
| P3.4 producer (20 tests incl. N1) | **20/20 pass** |
| projection substrate, P3.3 selector+resume, P3.2, P3.1 guard | pass |
| P2.7 persistence, P2 guards, writer-inventory, architecture-map | pass |
| targeted batch (13 files, 210) | **210/210 pass** |
| typecheck | **28 errors, 0 new** (pre-existing `test/phase3*`/`phase4*`) |
| **full suite** | **4410 pass / 23 skip / 8 fail** (299 files / 4441 tests) |

Full-suite failures (8): `audit-manifes-korup`, `P2.1 ×2`, `P2.2 ×2` = **FLAKY** (green in
isolation 34/34); `P3-constructor (m15)`, `S13`, `web-ssg` = **PRE-EXISTING/ENV**. **No P3.4
regression.**

## 10. Authority audit

- Canonical history = sole authority (`persistence.ts` only; untouched by this change).
- Projection = durable derived cache.
- Producer = writer of `history_projections` only (its only write call is
  `buildProjection`).
- `readConsumableSummaryProjection` = consumer/read path only (no writes).
- P3.3 selector = derived read-only; P3.1/P2.7 = publication authority.

**No new authority introduced.**

## 11. Final P3.4 status

**VALID** — rule-7 rejected, rule-8 consumable, production path functional, no canonical
mutation, all targeted tests pass, no P3 regression. N1 is resolved.

## 12. Remaining limitations

1. Producer records PARTIAL coverage (rule-8 consumable); CURRENT full-coverage projection
   needs the P3.7 full-history fold renderer.
2. Trigger = `persistCurrent` + resume seam only.
3. `revision` undercount on headless paths persists as a P3.5 seam.
4. No semantic relevance ranking (out of scope).