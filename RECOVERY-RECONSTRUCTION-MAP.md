# RECOVERY RECONSTRUCTION MAP

Recovery worktree: `D:\recover\minicode-20260928\reconstruction`
Baseline: `aa76dfb` (remote `main`) + checkpoint `e6924a3`, tag `recovery-baseline-postwipe`
Status: **INVENTORY ONLY — no Phase 0–7 code has been reconstructed.**

Status vocabulary: **RECOVERED** (present in baseline) · **PARTIAL** (some content in baseline or artifacts) · **RECONSTRUCT** (must be rebuilt; reference material survives) · **UNKNOWN** (only narrative knowledge survives).

---

## Baseline composition

| Directory | `.ts` files | Subdirectories |
|---|---:|---|
| `src/` | 130 | agents, app, hooks, lib, lsp, mcp, memory, policy, presentation, providers, repo, sandbox, session, skills, telemetry, tools, ui (+ 8 nested) |
| `cli/` | 22 | commands |
| `scripts/` | 24 | web |
| `bench/` | 6 | docker |
| `experiments/` | 4 | — |
| `test/` | 208 | fixtures, helpers, vcr |
| `docs/`, `web/` | 0 | — |

**`src/task/` does not exist in the baseline.** The entire task subsystem is absent.

---

## Phase-by-phase

| Phase | Scope | Status | Basis |
|---|---|---|---|
| **0** | Task substrate foundation | **PARTIAL** | Commit `979efa4` "fix(task): tutup PF-01/02/03/04/05/07 fondasi task" **is on the remote**. Additional uncommitted N1–N4 infra survives in `persistence.orig.ts` (`withBusyRetrySync`, `isValidPlanStep`, event-shape validation) — 803 lines vs 659 baseline, 160 diff lines. |
| **1** | Durable TaskStore | **RECONSTRUCT** | `store.orig.ts` (627 lines, SHA-256 `9912D31D06CE6E83`) and `store.p2.ts` (627-ish) survive as pre-Phase-6 states of a module with **no baseline counterpart**. |
| **2** | Canonical addressing | **PARTIAL** | `todo.orig.ts` (385 vs 348 baseline) contains the canonical/legacy split: `todoPath` (canonical) + `legacyTodoPath` (read-fallback only), `sanitizeTodoId` / `legacySanitizeTodoId`, plus `planPath` / `legacyPlanPath`. |
| **3** | Canonical taskId | **PARTIAL** | `db-path.orig.ts` adds `resolveLocalDbPath` with `mkdirSync(dir, {recursive:true, mode:0o700})`; todo addressing delta covers the id canonicalisation. `src/task/identity.ts` absent. |
| **4** | Presentation projection | **RECOVERED** | `src/presentation/projection.ts` present. `adapter.orig.ts` shows +8 diff lines vs baseline (minor uncommitted delta). |
| **4.5** | Live consistency | **RECONSTRUCT** | `src/presentation/plan-projection.ts` **absent**; no baseline equivalent. |
| **5** | Task Graph semantic design | **PARTIAL** | Design commit `aa76dfb` is the baseline tip ("docs(task): desain Canonical Task Model, mode DESIGN, nol kode"), but the artefact file `docs/TASK_GRAPH_SEMANTIC_DESIGN.md` is **absent** from the baseline tree. Narrative content only. |
| **6** | TaskGraph implementation | **RECONSTRUCT** | `src/task/graph.ts`, `readiness.ts`, `model.ts`, `normalize.ts` **all absent**. No surviving artifact contains graph or readiness source. |
| **7.0** | Scheduler audit | **UNKNOWN** | Audit findings existed as report text only; no source artefact. |
| **7.1–7.3** | Scheduler semantic design | **UNKNOWN** | Locked contracts were documented in-conversation; no committed design file. |
| **7.4** | Scheduler prerequisites | **RECONSTRUCT** | Not present as a unit. Partial deltas survive in `persistence.orig.ts` (checkpoint `rm`, `pruneSessionRefs`, `purgeSessionTraces`, `deleteTodoFiles` calls in `deleteSession`) and `todo.orig.ts` (`deleteTodoFiles`). The claim/CAS/transition-matrix layer lived in the absent `store.ts`. |
| **7.5** | Scheduler core | **RECONSTRUCT** | `src/task/scheduler.ts` absent. Full text existed in agent conversation context (pre-wipe read + 7.7 edit) — **narrative only, not on-disk evidence**. |
| **7.6** | Scheduler re-audit | **UNKNOWN** | Report only. Verdict "GREEN WITH DEFERRED DEBT — ENABLEMENT READY". |
| **7.7** | Liveness fix | **RECONSTRUCT** | Absent. The minimal correction is known in structure (one release block in `runCycle`) but the exact file is not on disk. |

---

## Reconstructability ranking

| Tier | Content | Recoverability |
|---|---|---|
| **A — near-lossless** | Phase 0/2/3 deltas in `persistence.orig.ts`, `todo.orig.ts`, `db-path.orig.ts` | Source text **survives**; mechanical re-apply is possible |
| **B — from artifact** | `store.ts` pre-Phase-6 state (`store.orig.ts`) | Source text **survives**, but the Phase 6/7.4 evolution does not |
| **C — narrative only** | `graph.ts`, `readiness.ts`, `model.ts`, `normalize.ts`, `identity.ts`, `addressing.ts`, `migrate.ts`, `plan-projection.ts`, `scheduler.ts` | **Must be rebuilt from design/spec**, not copied |
| **D — report only** | Phase 7.0/7.1–7.3/7.6 findings, mutation plans, gate evidence | Behavioural intent survives; no code |

---

## Honest statement of loss

Nothing in tier C or D exists on any accessible medium. In particular:

- **No copy of `scheduler.ts`** exists in the forensics directory, the packed tarball (v0.10.1 predates it), the remote, or the USN journal. The USN journal records *deletions*, not content.
- **No copy of the graph/readiness implementation** exists anywhere.
- The 203 recovered baseline test files are the *pre-task* suite; the ~200 untracked Phase 6/7 test files (`scheduler.test.ts`, `task-graph.test.ts`, `taskstore*.test.ts`, 6 mutation scripts) are gone.

Reconstruction of tiers C/D must be treated as **fresh engineering against the recovered design contracts**, not restoration.
