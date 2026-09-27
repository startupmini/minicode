# PHASE 0B — DB PATH RECOVERY REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Previous checkpoint: `c58e89e` · **this phase: `971412e`**
Status: CLEAN, 4 commits ahead of `origin/main`, **not pushed**.
`D:\git\minicode` untouched. No test / coverage / mutation-campaign / build executed.

---

## 1. Source comparison

| | State |
|---|---|
| **A — baseline** (`src/lib/db-path.ts`) | 36 lines. Exports `homeDir()` and `resolveDbPath()` only. `resolveLocalDbPath` **absent**. |
| **B — artifact** (`db-path.orig.ts`) | 62 lines. Same 36 lines **byte-identical** (verified: 0 differing lines across the shared prefix) + **26 appended lines** = `resolveLocalDbPath()` plus its N1 rationale comment. |
| **C — intended (N1)** | Task state is local-first and must **not** inherit `resolveDbPath`'s global fallback. |

The delta is **purely additive**. No baseline line was modified or removed.

### N1 rationale (as recorded in the artifact)

`resolveDbPath` falls back to `~/.minicode/` when `<cwd>/.minicode` does not exist. That is correct for `sessions.db`/`vector.db` — histories are not owned by one repo — but wrong for task state, because:

- **(a)** one project's task state would leak into another project that happens to share a session id;
- **(b)** it would be swept by `purgeExpired`, which keys on *another* session's `updated_at`.

The prior `todoPath` was always cwd-local, so adopting this function **preserves** task-state isolation rather than changing it.

## 2. Recovered semantics

`resolveLocalDbPath(filename, cwd?)`:
1. rejects `filename` containing `/`, `\`, or `..` (identical validation to `resolveDbPath`);
2. base = `cwd ?? process.cwd()`;
3. `dir = resolve(base, ".minicode")`;
4. `mkdirSync(dir, { recursive: true, mode: 0o700 })` inside `try {} catch {}` (best-effort, matching the existing convention);
5. returns `join(dir, filename)`.

**It never consults `homeDir()`, `homedir()`, or `MINICODE_HOME`, and never branches on `existsSync`.** The return path is unconditionally local. That is the N1 invariant, and it is provable statically (§6).

## 3. Implementation delta

`src/lib/db-path.ts` — **+26 / −0**, one file, no other file touched.

No new global state, no new fallback hierarchy, no filesystem abstraction, no unrelated refactor. The one intentional duplication is the `filename` validation block, kept verbatim rather than extracted into a shared helper: the artifact is the historical implementation, extracting it would add a new export the artifact never had, and the brief required the smallest correct version.

## 4. Verification performed

`node_modules` is **absent**; no install was performed. `db-path.ts` imports **only** `node:fs`, `node:os`, `node:path` — all builtins — so the real module is importable and executable without any dependency. All filesystem activity was `mkdirSync` under a `mkdtemp` temp dir.

| Group | Result |
|---|---|
| `Bun.Transpiler` parse of `src/lib/db-path.ts` | **PASS** |
| **INV1** resolves inside intended local scope | **5/5** — stays under projA, under projB, absolute, lands in `.minicode`, dir created |
| **INV2** never falls back to global | **5/5** — result ≠ global, ≠ global `tasks.db`, no global DB created; **contrast case proves the test bites**: with the same cwd, `resolveDbPath` did resolve into the global dir while `resolveLocalDbPath` stayed local |
| **INV3** deterministic for same input | **3/3** — identical output; not inside global `.minicode`; not equal to global path |
| **INV4** normalization stable | **3/3** — `./sub/..` cwd and trailing separators both normalize to the identical result; `relative()` of result is exactly `.minicode/tasks.db` |
| **INV5** invalid/ambiguous input fails | **4/4** — rejects `../escape.db`, `sub/tasks.db`, `sub\tasks.db`, `a/../../b.db`, all with `invalid filename:` |
| **INV6** no destructive behaviour | **6/6** — cwd gains only `.minicode`; an unrelated sibling has no `.minicode` before any call; a later call for a different scope leaves projA unchanged; no stray `.minicode` in the temp root; target is a directory |
| **TOTAL** | **27 pass / 0 fail** |

### Targeted mutation (3 mutants, dependency-free, mkdir-only)

| Mutant | Result | Violated |
|---|---|---|
| **M1** reintroduce global fallback | **KILLED** | stays in local scope; no global fallback |
| **M2** drop filename validation | **KILLED** | rejects traversal |
| **M3** skip local dir creation | **KILLED** | creates `.minicode` |
| baseline | clean | — (0 violations) |

**0 survivors.** Each mutant is a string-replaced copy written to a temp dir; each run uses a **fresh scope**.

### Three defects in my own verification, found and fixed before reporting

Each would have produced a false result:

1. **"no global fallback on repeat"** failed spuriously — I asserted "not under home", but the temp workspace itself lives under `C:\Users\xmlze`, so the assertion could not distinguish local from global. Replaced with the meaningful invariant (not inside the global `.minicode` dir).
2. **"sibling has no `.minicode`"** failed because an earlier line had already created it. Fixed by reordering onto a genuinely untouched project.
3. **M3 appeared to SURVIVE** — the scope had been populated by the baseline run, so `existsSync(".minicode")` passed vacuously. Fixed by giving every run a fresh scope; M3 is then killed.

## 5. Verification deferred

**COMPILE VERIFICATION = DEFERRED.** No typecheck was performed: `node_modules` is absent and installing would be a prohibited build step. `Bun.Transpiler` **parses**; it does **not** typecheck. Type-correctness of the new export is unverified.

**MUTATION = PERFORMED (targeted, 3 mutants).** A broad campaign is deferred — it needs the full suite and installed dependencies.

**No runtime integration test exists** for this function in the recovered baseline (`test/` has no db-path test). The verification above is an out-of-tree harness, not a committed test.

## 6. Safety audit

Pattern scan restricted to the **new function** (lines 52+):

| Pattern | Occurrences | Note |
|---|---|---|
| `rm` / `rmSync` / `unlink` / `rmdir` | **0** | no deletion whatsoever |
| `recursive: true` | 1 | the **mkdirSync**, a creation, not a delete |
| `homeDir()` / `homedir()` / `MINICODE_HOME` | **0** | static proof it cannot reach global state |
| `existsSync` | **0** | never branches on existing state — always local |
| `process.cwd()` | 1 | non-destructive base for the `.minicode` path |

**Cannot clear a directory, cannot delete, cannot depend on cwd destructively.** The `mkdirSync` target is `resolve(baseCwd, ".minicode")`, which always carries a non-empty `.minicode` segment, so it can never equal `baseCwd` nor be an ancestor of it.

No speculative guard was added, per instruction — Phase 0A's `assertDeletableTarget` is not invoked here because this code performs no destructive operation.

## 7. Git checkpoint

| | |
|---|---|
| Commit | **`971412e` — `recovery: restore local db path resolution`** |
| Diff | `src/lib/db-path.ts` only — **+26 / −0** |
| Working tree | **CLEAN** |
| History | `971412e` → `c58e89e` → `81b7647` → `e6924a3` → `aa76dfb` |
| Pushed | **NO** (4 ahead) |
| Specimen | `D:\git\minicode` still only `.freebuff` — untouched |
| Baseline | `repo-from-remote` 0 changes, still `aa76dfb` |
| Temp harness files | removed before commit (`git add -A` staged only `db-path.ts`) |

## 8. What this slice does and does not establish

**Establishes:** the storage-location foundation for task state is restored, and the N1 local-first property is verified by 27 focused checks plus 3 killed mutants.

**Does not establish:** compile-time correctness (deferred), any in-repo test coverage, or anything about TaskStore — no caller of `resolveLocalDbPath` exists yet, so the function is currently **unused**. It is a foundation, not an integrated capability.
