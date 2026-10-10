# FILESYSTEM SAFETY DESIGN

Status: **GUARD IMPLEMENTED, ADOPTION PARTIAL** (reconciled at HEAD `7eede05`).
`assertDeletableTarget` is live in `src/lib/safe-open.ts` (§3) and gates the one
production recursive delete (`src/session/persistence.ts`, checkpoint purge —
adoption stage 2). The stage-1 unit-test suite is still missing (zero test
references; recorded as Phase 5 required work), and stages 3–6 remain planned.
Scope: guards for destructive filesystem APIs in the reconstruction worktree.
Motivation: the 2026-09-28 incident deleted **34/34 direct children of the project root** while **preserving the root** — a *content-clearing* signature.

---

## 1. Audit result (static, reconstruction baseline)

| Metric | Value |
|---|---|
| `.ts` files scanned (excl. `.git`, `node_modules`, `vendor`) | 394 |
| Destructive `fs` call sites (any flag) | 301 |
| **Recursive** delete call sites (can remove a tree) | **251** |
| `readdir` call sites | 39 |
| **`readdir` of a directory literal** (`.` / `""` / `process.cwd()`) | **1** |
| Path-guard expressions guarding **writes** | 13 (`assertSafeWriteTarget` + callers) |
| Path-guard expressions guarding **deletes** | **0** |

### 1.1 The incident-signature site

`test/extreme.test.ts:36-43` — the **only** place in the codebase that enumerates a directory and removes its entries:

```ts
const tmp = ".tmp-extreme"
// bersihkan semua artifact test yang bocor ke repo root (dipakai banyak test di atas)
afterAll(async () => {
  const entries = await readdir(".").catch(() => [] as string[])
  for (const e of entries) {
    if (e.startsWith(".tmp-extreme")) {
      await rm(e, { recursive: true, force: true }).catch(() => {})
    }
  }
})
```

Also in that file, `const d = ".tmp-extreme-<4 hex>"` with `await rm(d, { recursive: true, force: true })` — a **relative** path, i.e. resolved against `process.cwd()`.

**Why it is currently safe (and why that is fragile):**

- `readdir` yields **single path segments only** — an entry name can never denote the parent.
- The filter `startsWith(".tmp-extreme")` is a positive allowlist.
- The relative name `d` is non-empty and contains no separator.

**Why it is a hazard:** safety rests on *positional* properties of the input, not on an assertion. Changing the prefix to `""`, `startsWith(".")`, or introducing a `""`/`"."` suffix converts a repo-root child-clearing loop into a repo-root delete. The same file also **writes into the project root during test runs**, then relies on name-prefix enumeration for cleanup rather than a tracked registry.

### 1.2 Why no audited delete can currently reach the project root

All 251 recursive sites resolve to one of:

1. `mkdtemp`/`mkdtempSync(join(tmpdir(), …))` — the OS temp dir. Verified for every `tmpRoot()`/`makeRoot()` helper (17 definitions).
2. A **non-empty** subdirectory of the project (`.tmp-extreme*`, `.tmp-gc-test-*`, `site`, `vendor/minicore`, …).
3. A deep, sanitised path under `.minicode/` — the single production recursive delete (`persistence.ts` checkpoint purge) is 3 levels deep and gated by `sanitizeSessionPart`, which maps `""`→`"x"`, strips `/`, `\`, and collapses `..`.

`process.chdir` is **never called**, so there is no cwd-mutation mechanism.

### 1.3 The structural gap

`assertSafeWriteTarget(abs, root)` in `src/lib/safe-open.ts` already implements the right primitives — `realpath` on root and parent, `isPathOutsideRoot`, and a Windows-correct `basename` split. It is wired into `write_file`, `edit`, and `patch`.

**It is not wired into a single delete.** The asymmetry is the finding: *writes are guarded; deletes are not.*

---

## 2. Required invariants

1. **Never delete a repository root.**
2. **Never clear a repository root's contents.**
3. **Never delete an ancestor of the workspace** (drive root, `D:\`, `D:\git`, home, `os.tmpdir()` itself).
4. **Recursive delete requires an explicit, declared scope.**
5. **Workspace cleanup must be temp-scoped.**
6. **Canonicalise the path before any delete** (realpath the nearest existing ancestor, then `resolve`).
7. **Fail closed** on ambiguous or unresolvable input — throw, never default to `process.cwd()`.
8. **Every destructive operation must identify its ownership scope** (which root it is permitted to touch).

---

## 3. Proposed guard: `assertDeletableTarget`

Sibling to `assertSafeWriteTarget`, in `src/lib/safe-open.ts`. Fail-closed. **Implemented** (unit tests still missing — Phase 5 required work).

```ts
export interface DeleteScope {
  /** The root this operation is permitted to touch. */
  readonly root: string
  /** True when the scope is a throwaway temp dir (relaxes nothing; only tightens reporting). */
  readonly tempScoped?: boolean
}

export function assertDeletableTarget(
  target: string,
  scope: DeleteScope,
  opts: { recursive: boolean },
): string
```

Check order (all failures **throw**):

| # | Check | Rationale |
|---|---|---|
| 1 | `typeof target === "string" && target.length > 0` | blocks `rm("")` |
| 2 | `target !== "." && target !== ".."` | blocks self/parent |
| 3 | `realpath` nearest existing ancestor, then `resolve` | defeats `..`, symlink laundering |
| 4 | `resolved !== path.parse(resolved).root` | blocks drive/FS root |
| 5 | `resolved !== os.homedir()`, `!== os.tmpdir()` | blocks user home, temp root |
| 6 | `resolved !== realpath(scope.root)` | **invariant 1 & 2** |
| 7 | `resolved !== process.cwd()` | blocks implicit cwd delete |
| 8 | `!isPathOutsideRoot(resolved, realRoot)` | **invariant 3** — target must live under scope |
| 9 | if `opts.recursive`: `depth(resolved) > depth(realRoot)` | requires a real child, blocks root-equals-target |
| 10 | resolved must not be an ancestor of `realRoot` | symmetric to 8 |
| 11 | reject a repo root: basename of `realRoot` containing `.git`, or `.git` present as a child | **explicit `.git` protection** |

Returns the canonical `resolved` path so the caller deletes exactly what was validated (no re-derivation).

### 3.1 Content-clearing is a separate, stricter operation

Invariant 2 needs its own primitive, because a legitimate "empty a temp dir" and an illegitimate "empty the repo" differ only in scope:

```ts
export async function clearDirectoryContents(dir: string, scope: DeleteScope): Promise<void>
```

- Enumerates with `withFileTypes()`; **deletes children only**; never touches `dir`.
- Requires `dir` to be `tempScoped` **and** strictly under `os.tmpdir()`.
- Refuses outright if `dir` equals the project root, contains `.git`, or is not under temp.

`extreme.test.ts`'s `afterAll` must migrate to a **tracked registry** of created paths (`registerCreatedPath(p)`), never to prefix enumeration of the cwd.

---

## 4. Adoption plan (staged; current state reconciled at HEAD `7eede05`)

| Stage | Action | State |
|---|---|---|
| 1 | Add `assertDeletableTarget` + unit tests covering: repo root, `""`, `"."`, `".."`, drive root, home, `tmpdir()` root, symlink escape, depth-0 target | **Guard added; unit tests still missing** |
| 2 | Convert the **production** recursive delete (`persistence.ts` checkpoint purge) — 1 site | **Done** (`persistence.ts:3365-3374`, fail-closed skip on guard error) |
| 3 | Convert `test/extreme.test.ts` to a created-path registry; delete the `readdir(".")` loop | Planned |
| 4 | Ban bare-name relative recursive deletes: lint rule rejecting `rm(<bare identifier>, { recursive: true })` where the argument is not `mkdtemp`-derived | Planned |
| 5 | Convert the remaining 248 sites mechanically; the guard is expected to be a no-op for them, which is itself the proof | Planned |
| 6 | CI guard test: assert **no** test file issues a recursive delete against a `process.cwd()`-derived path | Planned |

## 5. Prohibited patterns (lint/CI)

```
rm(x, { recursive: true })            // x not from mkdtemp, and not via assertDeletableTarget
rm("", …)  ·  rm(".", …)  ·  rm("..", …)
readdir("." | "" | process.cwd()) followed by any rm
process.cwd() used as a delete base without an explicit scope
```

## 6. Note on scope

This design addresses *class* of defect. It does **not** explain the incident: no audited baseline path can reach the project root, and the actor remains unattributed (USN carries no PID). The design is justified independently — a codebase where the sole directory-clearing loop depends on a name-prefix filter, and where deletes have zero path guards, is one input change away from repeating the outcome.
