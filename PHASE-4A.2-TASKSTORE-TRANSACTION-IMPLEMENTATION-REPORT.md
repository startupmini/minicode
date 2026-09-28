# PHASE 4A.2 — TASKSTORE TRANSACTION IMPLEMENTATION REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `f0bbfd6`
Commit message: `feat: add TaskStore transaction boundary`

**NEW ARCHITECTURE** — this capability did not exist in the recovered code.

---

## 1. Old transaction failure

A caller could open its own `db.transaction(...)` and call TaskStore methods
inside it, receiving atomicity that was silently **false**. TaskStore holds its
own cached `Database` handle (`handles: Map<string, Database>`, one per path),
so the caller's transaction and TaskStore's writes were **two different
connections** and committed independently.

Measured in Phase 3C: a forced throw rolled back **nothing** — both the task row
and the metadata row survived.

## 2. New API contract

```ts
withTransaction<T>(fn: (tx: TaskStore) => T): T
inTransaction(): boolean   // diagnostics
```

Guarantee: `BEGIN` → *N* task mutations + metadata mutations + allocation →
`COMMIT`; or on any throw → `ROLLBACK`, with the original error re-thrown
unchanged. Everything runs on **one TaskStore-owned connection**. No raw SQL is
exposed to callers, no second allocator, no duplicated SQL.

## 3. Connection ownership

The transaction is opened on `handle(this.cwd)` — the **same cached handle every
TaskStore method already obtains**. There is exactly one authoritative
connection per database path, so any method called on `tx` participates by
construction. There is no "escaped" path, because no other connection exists
for that path inside the store.

## 4. Transaction handle: why `this` is safe

The spec warns against passing the normal store if it could let work escape. It
cannot, because `handle(cwd)` returns the same object the transaction runs on. A
second restricted object would have created a second API surface for no
guarantee, so the callback receives `this` and the **misuse that does exist** is
closed explicitly: `close()` and `resetTaskStoreHandles()` are refused while a
transaction is open (`TASK_TX_ACTIVE`), because yanking the connection would
abandon a half-applied unit of work with no rollback path.

## 5. Allocation atomicity

Verified: `createTask` + `nextId` participate in the same transaction
(test F). A thrown callback leaves **no row and no durable orphan**. The
max-based allocation rule is **unchanged**; test G confirms that after a
rollback the next allocation reuses the freed id (`t2`), i.e. no gap and no
double-allocation.

## 6. Metadata atomicity

`setMeta` inside the transaction commits and rolls back with the task mutations
(tests D and E) — verified through the public API, not raw SQL. **No identity
manifest was introduced** (`'manifest'` occurrences in `store.ts`: 0).

## 7. Nested transaction semantics

Chosen explicitly: **join the enclosing transaction** (savepoint), which is
`bun:sqlite`'s native behaviour for a nested `db.transaction` on the same
connection — **measured**, not assumed: a nested transaction does *not* commit
independently. No extra code was needed.

Consequence, pinned by test K2: an inner rollback discards only the inner work;
the outer transaction's work still commits. This is the semantic that gives
nesting meaning, and the depth map makes the boundary observable.

## 8. Busy / retry behaviour

**Unchanged and deliberately not extended.** No new retry was introduced.
Contention is handled by the connection's existing `busy_timeout` pragma, and
the bounded per-statement retry remains scoped to schema DDL exactly as in
Phase 1. The CREATE TABLE `SQLITE_BUSY` fix (per-statement execution) is
untouched — `withBusyRetrySync` was not modified.

## 9. Error semantics

| condition | actual behaviour |
|---|---|
| callback throws | rollback, error propagates **unchanged** (measured) |
| `BEGIN` fails | driver throws, error propagates |
| mutation fails | propagates; SQL failures are wrapped as `TASK_PERSISTENCE_FAILURE` by `createTask`/`patchTask` as before |
| `COMMIT` fails | driver throws; rollback is the driver's |
| `ROLLBACK` fails | driver behaviour; not masked |
| store closed during a transaction | **impossible** — refused with `TASK_TX_ACTIVE` |
| manual `BEGIN` inside a transaction | already errors: "cannot start a transaction within a transaction" (measured) |

No atomicity stronger than SQLite/the driver proves is claimed.

## 10. Misuse protection

Test **J** is the architectural proof, and it does both halves through the
public API:

1. a **caller-side** transaction + `store.createTask` + throw → the row **is
   not** rolled back (the old defect, still demonstrable);
2. `store.withTransaction` + `createTask` + throw → the row **is** rolled back.

So the guarantee is owned by TaskStore, and the old escape remains visible
rather than silently believed fixed.

## 11. Tests

`test/phase4a2-taskstore-transaction.test.ts` — **13 tests, 53 assertions, 0 fail.**

A commit persists · B create rollback · C update rollback · D task+metadata
rollback · E task+metadata commit · F allocation rollback · G post-rollback
allocation · H 25-mutation all-or-nothing · I error propagation and return
value · J cross-connection regression (both halves) · K nesting joins outer ·
**K2** inner rollback preserves outer work · L close/reset refused mid-transaction
then permitted.

Real SQLite throughout; no mock-only atomicity proof.

## 12. Mutation results

Run against `src/task/store.ts`, global replacement, pristine bytes restored and
**SHA-verified** per mutant.

| # | mutant | result |
|---|---|---|
| T1 | no transaction at all | **KILLED** (B) |
| T2 | callback error swallowed | **KILLED** (B) |
| T3 | transaction on a foreign connection (reintroduces the bug) | **KILLED** (B) |
| T4 | callback runs after commit | **KILLED** (B) |
| T5 | nesting altered — nested call skips its transaction | **KILLED** (K2) |
| T6 | close/reset misuse guard removed | **KILLED** (L) |
| T7 | metadata does not participate | **KILLED** (E) |
| T8 | depth never decremented | **KILLED** (K) |

```
killed=8  survived=0  needle-misses=0
```

**One survivor in the first run was my test's gap, not an equivalent mutant.**
T5 survived because test K only covered the case where the *outer* also throws.
The observable difference is the case where the inner throws and the outer
**catches and commits** — test K2 now pins that, and T5 is killed legitimately.
No result was forced.

## 13. Validation status

| check | result |
|---|---|
| PARSE | **VERIFIED** — `Bun.Transpiler` on `store.ts` and `model.ts` |
| RUNTIME (new) | **VERIFIED** — 13/13, 53 assertions |
| RUNTIME (regression) | **VERIFIED** — 118 pass / 0 fail across 8 dependent suites |
| MUTATION | **VERIFIED** — 8/8 killed |
| TYPECHECK | **DEFERRED** — `node_modules` absent; install not authorised |
| FULL SUITE | **DEFERRED** — 200+ files not run; no broader health inferred |

## 14. Files changed

| file | change |
|---|---|
| `src/task/store.ts` | modified — `txDepth` map, `openTxPaths`, `assertNoOpenTx`, `withTransaction`, `inTransaction`, close/reset guards |
| `src/task/model.ts` | modified — one error code added: `TASK_TX_ACTIVE` |
| `test/phase4a2-taskstore-transaction.test.ts` | **new** |
| `PHASE-4A.2-TASKSTORE-TRANSACTION-IMPLEMENTATION-REPORT.md` | **new** |

Verified **unchanged** by hash: `src/tools/todo.ts`,
`src/presentation/adapter.ts`, `src/presentation/events.ts`,
`src/task/identity.ts`, `src/mcp/server.ts`, `cli/setup.ts`.

Added lines contain **no** reference to: `todo_write`, `todo_read`,
`normalizeTodos`, `synchronizeIdentities`, `applyTaskIdentities`, `migrated:`,
`bootstrap`, `manifest`, `TaskGraph`, `Scheduler`, `process.cwd`, or any
destructive filesystem primitive.

## 15. Commit

`feat: add TaskStore transaction boundary`. SHA not self-cited — committing this
report changes it. Verify with `git log -1 --pretty=format:'%h %s'`.
Working tree **CLEAN** after commit. Not pushed. Specimen untouched.

## 16. Explicit non-scope

This phase implemented **only** a transaction boundary. It did **not** implement:

- todo synchronization or any production `todo_write` → TaskStore wiring
- bootstrap / adoption (still BLOCKED; no manifest introduced)
- all-id-less rejection (still a later semantic phase)
- MCP namespace (`todoSession.id` is still `"mcp-server"`)
- deletion semantics
- identity protocol changes (`todo.ts` untouched)
- TaskGraph, Scheduler, plan-pipeline or execution-loop changes
- the identity manifest, or any use of `legacyDigest`/`migrationStamp`

Production behaviour outside `TaskStore` is **unchanged**: TaskStore still has
zero production consumers, and the identity contract remains **BLOCKED** on the
semantic, namespace and adoption questions. The duplication defect captured in
`debc295` is untouched and still reproduces.
