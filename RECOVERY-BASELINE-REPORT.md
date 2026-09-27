# RECOVERY BASELINE REPORT

Prepared: 2026-09-28, during post-wipe recovery.
Incident specimen: `D:\git\minicode` — **not touched by this work.**
Read-only reference: `D:\recover\minicode-20260928\repo-from-remote`
Working tree: `D:\recover\minicode-20260928\reconstruction`

---

## 1. Recovery baseline

| Property | Value |
|---|---|
| Remote | `https://github.com/startupmini/minicode.git` (recovered from preserved `package.json`, not guessed) |
| Baseline commit | `aa76dfb` — `docs(task): desain Canonical Task Model (mode DESIGN, nol kode)` |
| Branch | `main` |
| Total commits reachable | 392 |
| Files (excl. `.git`) | 519 |
| Source `.ts` | 203 (130 `src/`, 22 `cli/`, 24 `scripts/`, 6 `bench/`, 4 `experiments/`, plus tests) |
| Test files (`*.test.ts`) | 203 |
| Package | `minicode-ai@0.12.0`, bin `minicode` → `./cli/index.ts` |
| TypeScript | `^7.0.2` |
| `@types/node` | `^26.2.0` |
| bun | 1.4.2 |
| node | v22.23.2 |
| Baseline `git status` | clean (0 changes) — never modified |

**Important:** the pre-wipe local HEAD was `9f99486`, which **does not exist on the remote** (`git cat-file -t` → "Not a valid object name"). It was a local-only, unpushed commit and is unrecoverable. `aa76dfb` is therefore a *baseline*, not a restoration of the wiped tree.

## 2. Git checkpoint

| Item | Value |
|---|---|
| Checkpoint commit | `e6924a3` — `recovery: establish post-wipe baseline` (empty commit, by design) |
| Tag | `recovery-baseline-postwipe` |
| Parent | `aa76dfb` |
| Status after checkpoint | **CLEAN** (0 changes) |
| Ahead of `origin/main` | 1 commit |
| Pushed | **NO** |

The tag makes the recovered baseline an immutable reference point independent of further work.

## 3. Missing component inventory

**`src/task/` is entirely absent.** Confirmed absent: `model.ts`, `store.ts`, `graph.ts`, `readiness.ts`, `normalize.ts`, `identity.ts`, `addressing.ts`, `migrate.ts`, `scheduler.ts`.

Also absent: `src/presentation/plan-projection.ts`, `docs/TASK_GRAPH_SEMANTIC_DESIGN.md`, and all Phase 6/7 test files (`scheduler.test.ts`, `task-graph.test.ts`, `taskstore*.test.ts`, `scheduler-primitives.test.ts`, `live-projection.test.ts`, `presentation-projection.test.ts`, `task-identity-cli.test.ts`) plus the six mutation scripts and three bench-scale scripts.

The packed tarball `minicode-ai-0.10.1.tgz` (SHA-1 `03f31e45…87235ed`, verified) contains 139 `src/` files at v0.10.1 — **two minor versions behind** the baseline and predating the task subsystem, so it adds little beyond what the clone already provides.

## 4. Surviving artifact comparison

All six source artifacts are **larger than their baseline counterparts** — they are snapshots of the *uncommitted* working tree, i.e. **recoverable deltas**, not stale duplicates.

| Artifact | Lines | Baseline | Diff lines | Contains (uncommitted) |
|---|---:|---:|---:|---|
| `persistence.orig.ts` | 803 | 659 | 160 | `withBusyRetrySync` schema-setup retry, `isValidPlanStep`, durable event-shape validation (N1–N4) |
| `todo.orig.ts` | 385 | 348 | 59 | canonical vs legacy todo/plan paths, `sanitizeTodoId` split, `deleteTodoFiles` |
| `db-path.orig.ts` | 60 | 35 | 26 | `resolveLocalDbPath` with `mkdirSync(..., mode:0o700)` |
| `adapter.orig.ts` | 1005 | 997 | 8 | minor presentation delta |
| `reducer.orig.ts` | 800 | 786 | 16 | minor reducer delta |
| `store.orig.ts` | 627 | *(no counterpart)* | — | pre-Phase-6 `TaskStore` state |

`coverage-phase2.xml` lists 199 test files, **all of which exist in the baseline** — confirming that coverage run predates the task work and carries no task-system source.

**Net:** tier A deltas (Phase 0/2/3) are near-losslessly recoverable. Tier B (`store.ts` pre-Phase-6) is recoverable but its Phase 6/7.4 evolution is not.

## 5. Destructive-path audit (static, 394 `.ts` files)

| Metric | Value |
|---|---|
| Destructive `fs` call sites | 301 |
| **Recursive** delete sites | **251** |
| `readdir` sites | 39 |
| **`readdir` of a directory literal** | **1** (`test/extreme.test.ts:37`) |
| Path guards on **writes** | 13 |
| Path guards on **deletes** | **0** |
| `process.chdir` calls | **0** |

**Incident-signature site:** `test/extreme.test.ts:36-43` — an `afterAll` that does `readdir(".")` and `rm(entry, {recursive:true, force:true})` filtered by `startsWith(".tmp-extreme")`. This is the *only* directory-enumerating delete in the codebase, and it is the only construct that can delete children while preserving the parent — the exact observed outcome.

It is currently safe because `readdir` returns single segments and the filter is a positive allowlist. It is fragile because that safety is positional, not asserted. The same file writes into the project root during test runs.

**Why no baseline delete can reach the project root:** every recursive site resolves to a `mkdtemp(tmpdir())` path, a non-empty project subdirectory, or a 3-level-deep sanitised path under `.minicode/`. The single production recursive delete is gated by `sanitizeSessionPart` (which maps `""`→`"x"`, strips separators, collapses `..`).

**The structural gap:** `assertSafeWriteTarget()` already implements realpath + `isPathOutsideRoot` + Windows-safe `basename`, and is used by `write_file`/`edit`/`patch` — but **not by any delete**.

## 6. Safety design

Delivered in `FILESYSTEM-SAFETY-DESIGN.md`. Summary: an `assertDeletableTarget(target, scope, {recursive})` guard (11 ordered, fail-closed checks) covering non-empty input, no `.`/`..`, canonicalised realpath, rejection of drive root / home / `tmpdir()`, rejection of scope-root equality, cwd equality, ancestry violations, and explicit `.git` protection; plus a separate stricter `clearDirectoryContents()` that is temp-scoped only; a created-path registry to replace prefix enumeration; a lint rule banning bare-name recursive deletes; and a CI guard test.

**Not implemented** — design only, per instruction.

## 7. First reconstruction slice

**Slice 1 — `src/lib/db-path.ts`: add `resolveLocalDbPath`.**

Rationale (dependency-first, lowest risk):

1. **Dependency foundation.** `resolveLocalDbPath` is the storage-location primitive every later task module needs; nothing else can be built without it.
2. **Near-lossless recovery.** The exact implementation survives in `db-path.orig.ts` (+26 diff lines) — this is a *restore*, not a rewrite.
3. **Minimal blast radius.** 26 lines, one file, additive, no behavioural change to any existing caller.
4. **No destructive surface.** It performs `mkdirSync(..., {recursive:true, mode:0o700})` only — no delete, no cwd fallback beyond the existing `cwd ?? process.cwd()` pattern, so it introduces no deletion risk.
5. **Immediately testable** in isolation, and it validates the recovery pipeline (artifact → reconstruction) before anything larger is attempted.

Explicitly **not** the first slice: `store.ts` (tier B, needs design decisions), and certainly not the Scheduler.

Recommended order thereafter: `session-id`/identity helpers → `model.ts` → `normalize.ts` → `store.ts` → compatibility adapter (`todo.ts` canonical/legacy paths) → graph/readiness → scheduler.

## 8. Git status

| Item | Value |
|---|---|
| Worktree | `D:\recover\minicode-20260928\reconstruction` |
| Branch | `main` |
| HEAD at report time | documentation commit on top of `e6924a3` |
| `git status` | expected **CLEAN** after the documentation commit |
| Pushed | **NO** |
| `D:\git\minicode` touched | **NO** — read-only, specimen preserved |
| `repo-from-remote` modified | **NO** — read-only baseline |
| Tests / build / mutation run | **NO** |
