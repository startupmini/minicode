# PHASE 4B.2 — PRODUCTION SYNC TRANSACTION ATOMICITY REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `dc680e5` · Commit message: `test: enforce production sync atomicity`

**THIS IS TEST HARDENING. No production semantics changed.** See §12.

---

## 1. Exact production path

```
todo_write.execute
  -> todoOperationContext(ctx)                      single entry capture (4A.4B)
  -> all-id-less guard                               4A.5, before anything is written
  -> await saveTodos(...)                           durable JSON write
  -> synchronizeCanonicalTasks({ cwd, sessionId, declared })
       -> planTaskIdentities(...)                   pure planning + validation
       -> store.withTransaction((tx) => {           <-- THE BOUNDARY UNDER TEST
            pre-pass: every declared id must exist   (resolve-before-mutate)
            loop:    patchTask (existing) / createTask (new)  <- mutations
            D7:      retain omitted tasks
          })
  -> merge + re-persist resolved ids                4B.1
  -> savePlanSnapshot / publish plan
```

This phase tests the seam at `synchronizeCanonicalTasks` — the exact function
`todo_write` calls — and not `TaskStore.withTransaction()` in isolation. That
distinction is the whole point: 4A.2 already proved the store's transaction works,
and P9 still survived because the **call site** was unguarded.

## 2. Failure injection

A deterministic, **real** failure that occurs after a mutation-capable step has
already run, inside the production transaction:

| entry | content | effect |
|---|---|---|
| 0 | existing `t1`, title → `A MUTATED`, status → completed | a **real mutation** runs |
| 1 | NEW task declared `blocked` with no reason | `createTask` → `validate()` → **`TASK_INVALID_TRANSITION` "BLOCKED requires blockedReason"** |

Why this mechanism is legitimate:

- The validation is **genuine production code** — `store.ts:380`, inside
  `TaskStore.validate`, reached through the **public TaskStore API**. No raw SQL,
  no test-only hook, no weakened validation, no new allocator.
- `planTaskIdentities` genuinely accepts `status: "blocked"`, so a new entry can
  carry `BLOCKED`; the store then correctly refuses it.
- The `todo_write` tool schema **cannot** express `blocked` (its enum has no such
  value), which is exactly why this must be driven at the sync seam — the seam
  4B.2 is required to cover — rather than through the tool.
- The failure happens *after* entry 0 mutated, so the transaction has real work to
  roll back.

**Measured both ways** (this is the evidence that the boundary is now observable):

```
real code :  before ["t1=A@r1","t2=B@r1"]  ->  threw TASK_INVALID_TRANSITION
                                                     after  ["t1=A@r1","t2=B@r1"]
with P9   :  before ["t1=A@r1","t2=B@r1"]  ->  threw TASK_INVALID_TRANSITION
                                                     after  ["t1=A MUTATED@r2","t2=B@r1"]
```

## 3. Before / after TaskStore snapshot

`S0` is the full durable snapshot: `{id, title, status, order, revision}` per row.

- **B** — after the injected failure, `snapshot == S0` **exactly**, and `t1` is
  still `A` / `PENDING`.
- **C** — no revision advances; every row is still at revision 1.
- **D** — no allocation: no `t3` row, and `nextId` is still `t3`.
- **E** — no `task_order` changes.
- **A** — the positive case still commits everything together (update + creation
  + untouched row), guarding against a mutant that *drops* mutations.

## 4. JSON behaviour

For the injected failure there is **no JSON at all**: it is raised at the sync
seam, below `saveTodos`, and no tool invocation is involved.

For a failure that *is* reachable through `todo_write` (an unknown id), the
recorded state is the one 4A.4 already documented and I re-asserted in test I:

| store | result |
|---|---|
| JSON | **already written** — the legacy file describes the rejected payload |
| TaskStore | rolled back / untouched (`snapshot == S0`) |
| plan | none |

That is the existing durable-write-first ordering. There is no cross-system
rollback and I did not invent one; the divergence is recorded, not hidden.

## 5. Plan behaviour

No plan is published for a failed sync. The throw makes the tool result an error,
and the adapter publishes only on `!result.isError`, so no `plan.updated` — and
certainly no `payloadVersion: 2` — can be derived from the rejected state. (The
adapter-level assertion lives in 4A.5 test L; 4B.2 asserts the store and JSON legs.)

## 6. Mutation results

| # | mutant | result | killed by |
|---|---|---|---|
| **T1** | **P9: remove the production `withTransaction` boundary** | **KILLED** | test B |
| T2 | one mutation applied **outside** the transaction (`finally`) | **KILLED** | test B |
| T3 | route updates through `store` instead of the `tx` handle | **EQUIVALENT** | — |
| T4 | swallow the failure and report success | **KILLED** | test B |

**3/4 killed. The P9 survivor from 4B is now dead**, and §5's "do not accept
survived" is satisfied for both required mutants.

**T3 is provably equivalent, from the source rather than by assumption.**
`withTransaction` is implemented as `db.transaction(() => fn(this))` — so `tx`
**is** `store`, the same object on the same cached handle. Replacing
`tx.patchTask` with `store.patchTask` is a rename, not a semantic change. (That is
also why the code uses `tx`: for clarity, not because it is a distinct connection.)

**Two survivors in the first run were my own construction errors**, and I fixed the
mutants rather than the tests:

- **T2 (first version)** put the deferred write *after* the `throw`, so it never
  executed on the failure path and was trivially unobservable. Rewritten into a
  `finally` block so it genuinely runs after the rollback — and is then killed.
- **T4 (first version)** replaced text with itself plus a comment: a literal
  no-op wearing a mutation's label. Rewritten to actually catch and fabricate
  success — and is then killed.

## 7. Tests

`test/phase4b2-production-sync-atomicity.test.ts` — **9 tests, 35 assertions.**

A commit atomically · **B** rollback after a later failure · C no partial
revisions · D no partial allocation · E no partial order changes · F the rollback
is the seam's own behaviour · **G** the assertion is *sensitive* to a partial
commit · **H** it detects a single deferred mutation · I JSON/plan of a reachable
tool failure.

**G and H are what stop B–E from being vacuous.** They do not mutate production
code; they apply the partial write through the same public API the sync uses and
assert the resulting snapshot is **distinguishable** from the rolled-back one. If
those two states were indistinguishable, B–E would pass forever and the regression
would be worthless.

H also caught a real mistake in my own test: patching `order` moves `t1` to the
end of the `listTasks` ordering, so comparing rows by list index reported a
spurious extra diff. Rows are now compared **by id**.

## 8. Validation

| check | label |
|---|---|
| PARSE (5 sources) | **VERIFIED** |
| 4B.2 focused suite | **VERIFIED** — 9/9, 35 assertions |
| 4A.2 transaction tests | **VERIFIED** |
| 4A.4 / 4A.4A production sync + assignment | **VERIFIED** |
| 4B lifecycle + isolation, 4B.1 write-back | **VERIFIED** |
| all phase suites (13 files) | **VERIFIED** — 150 pass / 0 fail, 1239 assertions |
| `debc295` historical evidence | **VERIFIED** — unchanged, still reproduces (19) |
| mutation | **VERIFIED** — 3 killed, 1 equivalent |
| broad sweep (20 files) | **476 pass / 2 fail** |
| clean baseline `dc680e5`, same files | **476 pass / 2 fail** — identical |
| 2 purity-audit failures | **BASELINE-FLAKE** — identical at `dc680e5` |
| TYPECHECK | **DEFERRED** — `node_modules` absent |
| FULL SUITE | **DEFERRED** |

## 9. Regression interaction

Nothing was replaced; evidence was added. `debc295` is byte-unchanged, 4A.5's
rejection tests, 4B's lifecycle suites and 4B.1's write-back behaviour all still
pass, and the combined run is 150/0.

## 10. Files changed

| file | change |
|---|---|
| `test/phase4b2-production-sync-atomicity.test.ts` | **new** — 9 tests |
| `PHASE-4B.2-PRODUCTION-SYNC-ATOMICITY-ATOMICITY-REPORT.md` | this report |

`src/task/sync.ts`, `src/task/store.ts`, `src/tools/todo.ts` and
`src/presentation/adapter.ts` are **untouched** — `git status` before the commit
showed only the new test file.

## 11. Commit

`test: enforce production sync atomicity`. SHA not self-cited — committing this
report changes it. Tree CLEAN after commit. **Not pushed.** Specimen untouched;
every run used an explicit redirected `cwd`, and no `todos/`, `tasks.db` or
`vector.db` was created there.

## 12. Did production semantics change? — **NO**

**No production code was modified in this phase.** The gap was a missing
*observation*, not a missing guarantee:

- The transaction boundary was already correct, and the injected failure confirms
  it rolls back correctly.
- The failure mechanism is an existing production validation rule
  (`TASK_INVALID_TRANSITION`, `store.ts:380`), not a new code path.
- No test-only hook was added to production code, because the repository already
  offered a real failure that reaches the required point.

The only change is that this boundary is now **capable of detecting its own
removal**, which is the invariant 4B identified as unguarded.

## 13. Explicit non-scope

Not started: TaskGraph, Scheduler, bootstrap, deletion redesign, MCP changes,
protocol changes, all-id-less semantics, new transaction API, new identity
allocator, plan redesign.
