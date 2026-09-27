# PHASE 0A — FILESYSTEM SAFETY REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline checkpoint: `e6924a3` · docs: `81b7647` · **this phase: `9d3de6b`**
Status: CLEAN, 3 commits ahead of `origin/main`, **not pushed**.
`D:\git\minicode` untouched. No test / mutation / coverage / build executed.

---

## 1. Delete surface before

394 `.ts` files (186 production, 208 test) — 301 destructive call sites, **251 recursive**.

| Location | Operation | Target source | Resolved target | Consumer | Risk |
|---|---|---|---|---|---|
| `src/session/persistence.ts:568` | `rm(recursive)` | `join(resolve(cwd ?? cwd()), ".minicode","checkpoints", sanitize(id))` | 3 levels under workspace | `deleteSession` | **only recursive delete in shipped runtime** — safe by depth + fail-closed sanitizer |
| `src/lib/trash.ts:36` | `rm(force)` | `join(dir, entry)` | one file | trash eviction | low — non-recursive |
| `src/session/{checkpoint,journal,shadow-git,turn-marker}.ts` | `rm`/`unlink` | session-scoped paths | one file | session lifecycle | low |
| `src/tools/todo.ts:88-89` | `rm(force)` | `todoPath`/`planPath` | one file | todo cleanup | low |
| `src/telemetry/trace.ts:228` | `unlink` | trace file | one file | trace rotation | low |
| `src/lib/atomic-write.ts:81` | `unlink` | tmp file | one file | atomic write | low |
| `scripts/build-web.ts:43` | `rmSync(recursive)` | `siteDir = join(repoRoot,"site")` | subdir | web build | med — repo-relative subdir |
| `experiments/extreme-shadow-git.ts:59,279,287` | `rmSync(recursive)` | `join(process.cwd(), ".tmp-extreme-sg-*")` | cwd-relative subdir | experiment | med — cwd-derived |
| `bench/{runner,swebench,tasks}.ts` | `rm(recursive)` | `mkdtemp` results | temp | bench | low |
| `scripts/live-qa.ts:66,86` | `rmSync(force)` | literal `"sum.ts"` | repo-root file | live QA | med — literal repo-root-relative |
| **`test/extreme.test.ts:36-43`** | `readdir(".")` + `rm(recursive)` per entry, prefix-filtered | **bare entry names of the process cwd** | **direct children of the repo root** | test teardown | **HIGH — the only construct matching the incident signature** |

Test tree: 248 recursive sites, all resolving to `mkdtemp(join(tmpdir(),…))` or a non-empty repo subdirectory.

## 2. Changes made

Three files, **+152 / −26**.

**`src/lib/safe-open.ts`** — added `DeleteScope` and `assertDeletableTarget(target, scope, {recursive})`: 11 ordered, fail-closed checks, returning the *canonical* path so the caller deletes exactly what was validated. Reuses the module's existing `isPathOutsideRoot` and realpath discipline. New imports: `tmpdir`, `homedir`, `join`, `parse`, `relative`.

**`src/session/persistence.ts`** — the one shipped recursive delete now routes through the guard and deletes the **canonical** path:

```ts
const safeCp = await assertDeletableTarget(cpDir, { root: base }, { recursive: true }).catch(() => null)
if (safeCp) await rm(safeCp, { recursive: true, force: true }).catch(() => {})
```

Guard failure = **skip**, not throw — preserving the pre-existing best-effort contract of `deleteSession`.

**`test/extreme.test.ts`** — see §4.

**`clearDirectoryContents()` was deliberately NOT implemented.** No production code needs it: the only directory-clearing construct in the tree is the test teardown, now replaced by an owned-path registry. Adding an unused "clear a directory" primitive would itself enlarge the dangerous surface. The brief conditioned it on existing production need; that need does not exist.

## 3. Safety invariants

`assertDeletableTarget` refuses, in order:

| # | Invariant | Guard |
|---|---|---|
| 1 | target valid | non-empty string |
| 2 | not ambiguous | `"."` / `".."` refused |
| 3 | not drive/FS root | `parse().root` |
| 4 | not home / tmpdir | `protectedPaths()` |
| 5 | **never delete scope root** | `real === realRoot` |
| 6 | target canonicalisable | realpath, else nearest existing ancestor walk |
| 7 | **never delete cwd** | `real === realCwd` |
| 8 | **inside allowed root** | `isPathOutsideRoot` |
| 9 | recursive ⇒ real child | `depth(target) > depth(root)` |
| 10 | **not an ancestor of scope** | `relative()` empty / `..` / absolute |
| 11 | **`.git` workspace protection** | `.git` present in scope root ⇒ root refused |

No `force` escape hatch and no "clear arbitrary directory" API.

## 4. extreme.test cleanup change

**Before** — enumerate the process cwd, filter by prefix, delete each entry recursively:

```ts
const entries = await readdir(".").catch(() => [] as string[])
for (const e of entries) if (e.startsWith(".tmp-extreme")) await rm(e, { recursive: true, force: true })
```

**After** — register each path as an absolute path *at creation*, delete only that set:

```ts
const TRACKED = new Set<string>()
function track(name: string): string {
  const abs = resolve(process.cwd(), name)
  TRACKED.add(abs)
  return abs
}
afterAll(async () => {
  for (const p of TRACKED) await rm(p, { recursive: true, force: true }).catch(() => {})
})
```

`tmp` and the four `const d = …` sites now call `track(...)`. Test assertions and behaviour are unchanged; only the cleanup mechanism differs. `readdir` import removed; `resolve` added.

## 5. Static verification

No test/coverage/mutation/build was run. Verification was a dependency-free parse plus pure-predicate checks.

| Check | Result |
|---|---|
| `Bun.Transpiler` parse of all 3 changed files | **3/3 OK, 0 failures** |
| Guard contract vs 8 representative paths | **8/8 as-expected, 0 mismatches** (workspace root, drive root, parent of workspace, `""`-suffix join, `.`-suffix join → all REFUSE; named subdir, `.tmp-*`-style child, deep child → all ALLOW) |
| `readdir` of a directory literal, whole tree | **0** (was 1) — **incident signature eliminated** |
| Recursive delete with relative **string-literal** arg | **0** (was ≥1 via `extreme.test.ts`) |
| Recursive delete in shipped runtime | **1**, and it is **GUARDED** |
| `extreme.test.ts` `readdir(".")` in live code | **0** (only occurrence is inside a comment describing the old behaviour) |

**Three measurement errors in my own audit scripts, found and corrected before reporting** — I am flagging them because each would have produced a false claim:

1. A regex counted all 251 recursive `rm(var, …)` calls as "cwd-relative" (reported 252). Category was wrong; the corrected measure is *relative string-literal* = 0.
2. A `startsWith("src/")` filter failed because `relative()` returns backslashes on Windows, producing a false "0 recursive deletes in runtime" when 1 exists.
3. A comment-skipping miss counted my own documentation comment as live `readdir(".")`.

## 6. Remaining delete surfaces

- **1 guarded** recursive delete in shipped runtime (`persistence.ts:578`).
- **7 unguarded recursive** sites, none in shipped runtime: `scripts/build-web.ts` (`join(repoRoot,"site")`), `experiments/extreme-shadow-git.ts` ×3 (`join(process.cwd(), ".tmp-extreme-sg-*")`), `bench/*` ×3 (`mkdtemp`).
- **11 file-only** `rm`/`unlink` sites in `src/`+`cli/` — non-recursive, so cannot remove a tree.
- **248 recursive** sites in the test tree, all `mkdtemp` or non-empty subdirectory.
- `src/session/turn-marker.ts:100` still uses the `cwd ?? "."` fallback idiom (for a *file*, non-recursive) — a residual pattern worth removing, deliberately left untouched to honour "do not over-harden".

## 7. Known limitations

1. **No typecheck was possible.** `node_modules` is absent in the recovery clone, and installing deps would be a build step (prohibited). I verified by parse + pure-predicate execution only. `assertDeletableTarget` has **not** been compiler-checked.
2. **No runtime test of the guard.** Its 11 checks have been exercised only as pure predicates; the realpath/ancestor-walk branches are unverified at runtime.
3. **Guard is adopted at 1 of 8 recursive sites.** The remainder are unguarded by design of this phase.
4. **This does not explain the incident.** No baseline path could reach the repo root, and the actor remains unattributed. The value here is that the *class* of defect — a cwd-enumerating delete loop — no longer exists in the tree.
5. `bun x tsc` was invoked once and reported "Resolving dependencies / Saved lockfile". It used a temp directory: `node_modules` is **absent**, `bun.lock` matches HEAD, and `git status` was clean. No side effect on the tree, but disclosed.
6. Git reported CRLF→LF normalisation warnings on the three edited files (repo has no `.gitattributes` rule covering them). Content is unaffected; line endings will normalise on next checkout.

## 8. Git checkpoint

| | |
|---|---|
| Commit | **`9d3de6b` — `security: harden filesystem deletion boundaries`** |
| Diff | 3 files, +152 / −26 |
| Working tree | **CLEAN** |
| History | `9d3de6b` → `81b7647` → `e6924a3` → `aa76dfb` |
| Pushed | **NO** (3 ahead) |
| Specimen | `D:\git\minicode` still only `.freebuff` — untouched |
| Baseline | `repo-from-remote` 0 changes, still `aa76dfb` |
