# P3.4 — Scope Ratification Report

Owner-ratified scope for the P3.4 milestone, recorded into the canonical roadmap. **No
implementation was performed.** Documentation/roadmap changes only.

---

## 1. Previous roadmap state

The P3 (Context ↔ Session Reconciliation) sub-milestone numbering had **no single
canonical roadmap document**. It was scattered across reports with **conflicting**
numbering:

| Phase | Historical (`P3_FORENSIC_AUDIT_REPORT`, obsolete) | Recent authorities |
| --- | --- | --- |
| P3.3 | "History → Context Projection (production)" | **Canonical Context Selector** (built) |
| P3.4 | "Resume/Recovery Reconciliation" | **undefined** |
| P3.5 | "Compaction Contract" | **Runtime Context Adapter** (P3.2 report §16–17) |
| P3.6 | "Bounded Reads (Paging/Lazy)" | not required by current authority |
| P3.7 | "Branch/Fork Read Semantics" | **A+C fold producer** (P3.3 audits) |

The outer phase is **Big Roadmap Phase 3 — Context ↔ Session Reconciliation**
(`P2_CLOSURE_HANDOFF.md`). `PLAN.md` uses a different P0–P3 harness numbering and is not the
context roadmap.

## 2. Why P3.4 was undefined

The `P3_FORENSIC_AUDIT_REPORT` (HEAD `e284298`-era) was written **before** implementation
and numbered the phases speculatively. The actual program diverged: **P3.3 was built as the
Canonical Context Selector**, not "History → Context Projection production". Consequently
the forensic numbering no longer matches reality, and no authority ever restated P3.4 in the
current scheme. The post-P3.2 authority skipped from P3.3 directly to **P3.5 Runtime Context
Adapter**. Result: **P3.4 was undefined** (the blocking finding of the P3.4 architecture
audit).

## 3. Ratified P3.4 scope

```
P3.4 — Durable Context Projection Producer / Projection Cache
```

P3.4 establishes the **smallest production-safe producer** that writes the existing
`history_projections` durable-derived cache from canonical state, so that selector
strategies such as `summary-plus-tail` can become real production behavior.

## 4. P3.4 primary problem

> Today MiniCode can **consume** a durable `history_projections` summary (P2.8 assembly and
> the P3.3 selector read a CURRENT projection), but **nothing in production builds one** —
> `buildProjection`/`rebuildProjection` are exercised by tests only — so `summary-plus-tail`
> selection can never trigger on the automatic path.

## 5. P3.4 non-goals

Explicitly **not** P3.4:

- Runtime Context Adapter → P3.5
- headless `context.compacted` durable bridge → P3.5
- presentation adapter redesign → P3.5
- semantic relevance ranking / vector / embedding search → later (P3.11/P4)
- selector redesign (P3.3 closed)
- canonical history rewrite (forbidden)
- new persistence authority / second memory system (forbidden)
- advanced A+C fold producer / generalized compaction engine → P3.7
- attach history-presence gate → hardening, not P3.4
- conflict diagnostic category → hardening, not P3.4

## 6. P3.4 ↔ P3.5 boundary

```
P3.4 — Durable Context Projection Producer / Projection Cache
P3.5 — Runtime Context Adapter
```

P3.5 responsibilities: carry `revision` into the runtime where it is currently lost;
preserve `ModelContextProvenance`; bridge headless `context.compacted`; make the runtime
context lifecycle freshness-aware; provide the runtime-facing adapter seam.

Not implemented in this task.

## 7. P3.4 ↔ P3.7 boundary

This was the audit's noted overlap. Resolved:

```
P3.4: production projection producer / projection cache lifecycle
      (write the EXISTING projection representation into history_projections)
P3.7: advanced A+C fold producer / richer fold-generation semantics
      (the algorithm that produces the summary/fold content itself)
```

P3.4 builds and persists the projection representation required by the existing projection
contract; it must **not** absorb the complete advanced A+C fold algorithm. If the current
code makes this boundary unclean, it is documented as a constraint rather than implemented.

## 8. Authority model (invariant)

```
Canonical history   = sole authoritative history        (src/session/persistence.ts)
Projection cache    = durable BUT derived               (history_projections)
Projection producer = writer of DERIVED projection only (P3.4 — not yet built)
Selector            = derived, read-only consumer       (src/session/context-selector.ts)
P3.1 / P2.7         = canonical publication safety      (saveSession append-only + epoch)
```

**Hard invariant:** the projection cache must never become canonical history authority.
Invalidation/rebuild is deterministic (anchor + head via `getProjectionStatus`); a
missing/corrupt projection degrades to full canonical history (cache miss).

## 9. Data lifecycle (target shape)

```
canonical history → projection producer (P3.4) → history_projections → P3.3 selector
   → ContextSelection → runtime context
```

A projection is a **derived durable view**, not a replacement for history.

## 10. Future implementation criteria (P3.4 gate)

Recorded in `P3_ROADMAP.md` §3: production producer exists; projection generated from
canonical state; projection remains derived; provenance retained; identity scoped;
revision/freshness explicit; invalidation semantics defined; selector can consume it; no
second history authority; no silent canonical mutation; deterministic where required;
production-path tests; mutation/non-vacuity evidence; recovery/rebuild tested.

## 11. Files changed

| File | Change |
| --- | --- |
| `P3_ROADMAP.md` | **new** — canonical P3 roadmap (ratified P3.4/P3.5/P3.7) |
| `P3_4_ARCHITECTURE_SCOPE_AND_DEPENDENCY_AUDIT.md` | amended — owner-ratification banner |
| `P3_4_SCOPE_RATIFICATION_REPORT.md` | **new** — this report |

No `src/`, `cli/`, or `test/` changes.

## 12. Commit SHA

`8eb0aa8bcfc475f790a59f549d13bc0105066a25`
(`docs: ratify P3.4 projection roadmap scope`), parent `5b8d98d`.

## 13. Push verification

Pushed `5b8d98d..8eb0aa8` (fast-forward, no force).
`HEAD == origin/main == 8eb0aa8bcfc475f790a59f549d13bc0105066a25`; working tree CLEAN.

## 14. Final P3 roadmap state

```
P3.1 — Reconciliation Guard              ✅ VALID
P3.2 — Context Identity / Frontier       ✅ VALID
P3.3 — Canonical Context Selector        ✅ VALID
P3.4 — Durable Context Projection        ← NEXT (not started)
P3.5 — Runtime Context Adapter           (not started)
P3.6 — (reserved; undefined by current authority)
P3.7 — A+C Fold Producer / advanced fold (not started)
```

Authority: `P3_ROADMAP.md` (canonical), superseding the historical forensic numbering where
they conflict. No implementation was authorized or performed.
