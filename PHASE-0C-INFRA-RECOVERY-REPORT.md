# PHASE 0C — INFRA RECOVERY REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Previous: `09687ae` (Phase 0B) - **this phase: the commit that adds `PHASE-0C-INFRA-RECOVERY-REPORT.md`** (SHA not self-cited: see note in S10)
Status: CLEAN, 5 commits ahead of `origin/main`, **not pushed**.
`D:\git\minicode` untouched. No install, no full suite, no coverage, no build.

---

## 1. Baseline vs artifact comparison

`src/session/persistence.ts` — 680 → 832 lines. 9 diff hunks, **+168 / −17**. Export-level delta is purely additive: **3 new exports, 0 removed**.

| Hunk | Location | Change |
|---|---|---|
| 1 | after `initializedSessionPaths` | `withBusyRetrySync` + rationale (+34) |
| 2 | `open()` | bare `db.exec(DDL)` → wrapped in `withBusyRetrySync` (1→6) |
| 3 | `open()` | block close `)` (+1) |
| 4 | after `rebasePresentationPayload` | `isValidPlanStep`, `PLAN_STEP_STATUSES`, `PLAN_STATUSES`, `isValidEventShape` (+84) |
| 5 | `decodePresentationEvent` | `truncated` stub gate + shape gate (+4) |
| 6 | `decodePresentationEvent` | blind `return value as DomainEvent` → gated (1→10) |
| 7 | `loadPresentationEvents` | signature change (+5) |
| 8 | after loader | `loadPresentationEvents` restored as wrapper (+4) |
| 9 | `appendPresentationEvents` | `withBusyRetry` private → `export async` (1→5) |

**Hunk 9's final section is NOT a Phase 0 delta.** It is the difference between my **Phase 0A** guarded `deleteSession` and the artifact's older unguarded `rm`. Reverting it would remove the fail-closed guard. **Deliberately not applied.**

## 2. Verified Phase 0 deltas — RECOVERED

| ID | Component | Purpose | Evidence | Needed |
|---|---|---|---|---|
| A1 | `withBusyRetrySync` | bounded sync retry for schema DDL, **only** `SQLITE_BUSY` / `database is locked`; other errors rethrown | artifact doc: *"Ditemukan oleh test baseline Phase 0"*; `open()` is called by every session op; the existing `withBusyRetry` sits *later* in `appendPresentationEvents`, so nothing protected DB **open** | **YES** |
| A2 | `open()` DDL wrapped | makes A1 load-bearing; `null` = failed, caller errors on the next statement | as above | **YES** |
| A3 | `withBusyRetry` exported | explicitly *"seam aditif, bukan refactor"* so the retry can be tested directly — *"Sebelum ini tidak ada satu pun test yang menyuntik SQLITE_BUSY"* | artifact doc | **YES** |
| B1 | `isValidPlanStep` + `isValidEventShape` + status sets | N4 fail-closed event shape validation | artifact doc: *"Bentuk minimum tiap tipe event durable. N4."* | **YES** |
| B2 | `decodePresentationEvent` gate | reject `truncated` stubs and wrong shapes before `reduce` | artifact doc: a single bad event *"menghapus SELURUH presentation state sesi"* because `setup.ts` catches throws around `rebuildFromDurable` | **YES** |
| B3 | `PresentationEventLoad` + `loadPresentationEventsWithStats` | counts discarded rows — *"N4: tidak boleh senyap"* | artifact doc | **YES** |
| B4 | `loadPresentationEvents` wrapper | back-compat | preserves signature for 9 call sites | **YES** |

**Cross-validated against the baseline's own types** (not assumed from the artifact):

- `PlanStepStatus = "pending"|"active"|"completed"|"cancelled"|"blocked"` — **exactly** `PLAN_STEP_STATUSES`
- `plan.updated.status: "open"|"completed"|"cancelled"` — **exactly** `PLAN_STATUSES`
- `file.changed { toolCallId: string; paths: string[] }` — matches the validator
- `truncated: boolean` genuinely exists on delta events
- **all 25 durable types are explicitly cased** (verified statically) — no durable event is silently over-validated

## 3. Rejected / deferred deltas

| ID | Item | Classification | Reason |
|---|---|---|---|
| C1 | `deleteSession` unguarded `rm` | **NOT PHASE 0** | This is my Phase 0A guard vs the artifact's older state. Reverting *reduces* safety. |
| D1 | `todo.orig.ts` canonical/legacy path split | **DEFER (Phase 2)** | N2 — canonical addressing, a different phase. 8 lines. |
| D2 | `reducer.orig.ts` ordered-reduce loop | **DEFER (Phase 4)** | Presentation reducer, not infra. |
| D3 | `adapter.orig.ts` | **NOT PHASE 0** | 0 substantive lines — nothing to recover. |
| D4 | `vector.ts` own `withBusyRetry` | **DEFER** | pre-existing baseline duplication, unrelated to Phase 0 |
| D5 | `store.orig.ts` | **NOT NOW** | pre-Phase-6 TaskStore — Phase 1 territory, out of scope |

## 4. Implementation

`src/session/persistence.ts` only. **+155 / −6**, one file.

No refactor of unrelated SQLite code; no new status; no persistence-format change; no schema change. The DDL text itself is untouched — only its execution is wrapped.

## 5. Integration status

| Symbol | External consumers | Assessment |
|---|---|---|
| `withBusyRetrySync` | 0 | internal to `open()`; exported for testability only — matches artifact intent |
| `loadPresentationEventsWithStats` | 0 | N4 observability surface. The artifact did **not** wire `cli/setup.ts` to it, so neither do I — **no speculative wiring** |
| `withBusyRetry` | 0 | additive testability seam |
| `isValidEventShape` / `isValidPlanStep` | 0 | module-private, invoked from `decodePresentationEvent` |
| `loadPresentationEvents` | **9 call sites** preserved | signature unchanged (`DomainEvent[]`); the wrapper keeps all 5 test files + `cli/setup.ts:660` compiling untouched |

**Correction:** an earlier grep reported `withBusyRetry` having "6 consumers" in `vector.ts`. That was a **name-collision false positive** — `vector.ts` defines its *own* `withBusyRetry` at line 248 and imports nothing from `persistence.ts`. True external consumers: **0**.

## 6. Safety audit

| Pattern | In `persistence.ts` |
|---|---|
| `readdir(` | **0** |
| `rmSync(` | **0** |
| `unlinkSync(` | **0** |
| `rmdir` | **0** |
| `process.chdir` | **0** |
| `homeDir()` / `MINICODE_HOME` | **0** |
| `process.cwd()` | 3 (all pre-existing, non-destructive base resolution) |
| `assertDeletableTarget` | 2 — **Phase 0A guard intact** |

No cwd-relative cleanup added. No global-DB fallback introduced into task-state code. No root-clearing primitive added.

## 7. Verification matrix

| Category | Status | Detail |
|---|---|---|
| **PARSE VERIFIED** | ✅ | `Bun.Transpiler` on `persistence.ts` |
| **RUNTIME VERIFIED** | ✅ | 23/23 checks — `withBusyRetrySync`: first-try success; retries `SQLITE_BUSY` (3 attempts); retries `database is locked`; **rethrows non-busy immediately (1 attempt)**; exhausts to `null` bounded (199 ms); backoff < 1 s. N4 via **real SQLite round-trip**: valid `plan.updated` kept; bad step status, missing `stepId`, bad plan status, truncated stub, malformed JSON all rejected; mixed batch 2 kept / 1 rejected; wrapper returns events only; unknown type rejected by the pre-existing `DURABILITY` gate; all 25 durable types cased |
| **TYPECHECK DEFERRED** | ⛔ | `node_modules` absent; install is a prohibited build step. `Bun.Transpiler` **parses**, it does **not** typecheck. |
| **FULL SUITE DEFERRED** | ⛔ | not run, by instruction |

## 8. Mutation matrix

Mutant copies written into `src/session/` (so relative imports resolve), removed in `finally`.

| Mutant | Result | Detected by |
|---|---|---|
| M1 retry gate removed (rethrow on BUSY) | **KILLED** | `retries-busy` |
| M2 everything treated as retryable | **KILLED** | `rethrows-nonbusy` |
| M3 shape validation bypassed | **KILLED** | `valid-kept` + 3 rejection probes |
| M4 `isValidPlanStep` always true | **KILLED** | `valid-kept` + 3 rejection probes |
| M5 truncated-stub gate removed | **KILLED** | `valid-kept` + 3 rejection probes |
| baseline | clean | 0 violations |

**MUTATION = 5/5 killed. 0 survivors.**

### Four defects in my own harness, found and fixed before reporting

1. Baseline expectation was **off by one** (expected 2 rejections, correct is 3) — which also made M1/M2 appear to "kill" that probe. Code was right; probe was wrong.
2. **`process.exit()` inside `try` skipped `finally`** → 5 mutant files leaked into `src/session/`. I detected the leftovers, removed them, and moved the exit after cleanup. `src/session/` verified back to 5 clean files.
3. **M5 initially SURVIVED.** Cause: my stub fixture used `model.delta`, which `isValidEventShape` *also* rejects — so the two N4 defenses overlapped on that input. I then read the **real** stub producer (`encodePresentationEvent` L227–234 = `Base + type + truncated:true`, preserving `type`) and switched the fixture to `turn.started`, one of the five types whose shape check is `return true`. The gate is genuinely load-bearing for those, and M5 is then killed.
4. Temp-dir cleanup threw `EBUSY` (Windows holding the SQLite handle); made best-effort.

## 9. Remaining Phase 0 gaps

- **No in-repo test exists** for `withBusyRetrySync`, `withBusyRetry`, or the N4 validation. All verification was an out-of-tree harness, removed before commit. The recovered baseline has `test/persistence-rewrite.test.ts`, which exercises `loadPresentationEvents` but cannot inject `SQLITE_BUSY`.
- **`loadPresentationEventsWithStats` is unwired** — no caller surfaces `rejected`. Faithful to the artifact, but the "not silent" property is therefore only observable by a direct caller.
- **TYPECHECK and FULL SUITE remain deferred**; these cannot clear until dependencies are installed, which is a build step outside this phase's authority.
- **Phase 2 (N2 canonical addressing)** in `todo.ts` and **Phase 4 presentation** in `reducer.ts` remain recovered-but-deferred.

## 10. Git checkpoint

| | |
|---|---|
| Commit | `recovery: restore phase 0 persistence infrastructure` (message verified via `git log -1 --pretty=%s`; SHA not self-cited, see note below) |
| Diff | `src/session/persistence.ts` only — **+155 / −6** |
| Working tree | **CLEAN** |
| History | `this phase` -> `09687ae` -> `c58e89e` -> `81b7647` -> `e6924a3` -> `aa76dfb` |
| Pushed | **NO** (5 ahead) |
| Specimen | `D:\git\minicode` still only `.freebuff` — untouched |
| Baseline | `repo-from-remote` 0 changes, still `aa76dfb` |
| Temp/mutant files | none staged. Commit contains exactly 2 files: `src/session/persistence.ts` (+155/-6) and this report (+147) |


> **Note on the commit SHA.** This report deliberately does not print its own commit SHA.
> Amending the commit to include this report necessarily changes that SHA, so any
> hardcoded value is stale the moment it is written. Verify the phase commit with:
> `git log -1 --pretty=format:'%h %s'` in the reconstruction worktree.

