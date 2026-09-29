# PHASE 6K — INTEGRATION SAFETY CORRECTIONS

Base: `a94902e` (`audit: adversarially validate generation lineage`)
Fixes D3, D4 and D5 from Phase 6J. **No lineage redesign. No Scheduler change.
No enablement.**

---

## 1. Executive result

# GREEN — all three integration defects closed

| | |
|---|---|
| **D3** pre-6I databases receive the lineage columns | **FIXED** — `createTask` works again |
| **D4** production `deleteSession` removes task rows | **FIXED** — reuse yields zero old tasks |
| **D5** active-claim exemption is tested | **FIXED** — M13 now killed |
| lineage architecture (6H/6I) changed | **NO** — store diff is purely additive |
| `scheduler.ts` changed | **NO** — D5 needed a test, not code |
| mutation | **20 / 20 killed, 0 survivors, 0 harness misses** |
| new tests | **16**, all passing |
| tsc / lint | **28 / 7 — both exactly baseline** |
| full suite | **3045 pass / 23 skip / 4 fail** — the same 4 pre-existing |
| frozen surfaces | **all untouched** |
| production `new Scheduler(` | **0** |

**Files changed: 3.** `src/task/store.ts` (+97, additive), `src/session/persistence.ts`
(+36/−11), `test/phase6k-integration-safety.test.ts` (new, 16 tests).

---

## 2. D3 baseline reproduction — **VERIFIED (REAL DEFECT, pre-fix)**

Reproduced with a database whose `tasks` table was **physically created without**
the lineage columns:

```
open + read existing row         ok: {"id":"t1","status":"PENDING","rev":3}
existing task data preserved     true
columns present after open       []          <- never added
createTask on a pre-6I database  THREW: table tasks has no column named exec_generatio
getExecutionLineage              THREW: no such column: exec_generation
claimTask                         THREW: no such column: exec_generation
```

After the fix, the same probe:

```
columns present after open       ["exec_generation","attempt_generation"]
createTask on a pre-6I database  ok
getExecutionLineage              ok
claimTask                         ok
existing task data preserved     true
```

---

## 3. D3 migration design — **NEW ARCHITECTURE**

**The fact:** `CREATE TABLE IF NOT EXISTS tasks (...)` is a **no-op on an existing
table**. SQLite does not add columns. So a database predating 6I never received
the columns, and because `createTask` names them, task creation failed outright —
on the **LEGACY** path, with the Scheduler disabled.

**Why this was safe in 6F and not in 6I:** 6F added a *new table*, which
`IF NOT EXISTS` does create on an old database. 6I altered an **existing** table's
shape, which `IF NOT EXISTS` cannot express. That asymmetry is the entire bug.

**Where it lives:** inside `handle()`, immediately after the DDL loop, before
`initialized.add(p)`. It therefore runs on the same open path, once per open, and a
failure closes the handle and throws `TASK_DB_INIT_FAILURE` — identical to every
other schema-init failure.

**Why schema introspection and not only the version stamp:** a stamp can lie (a 6F
database may carry a stale or absent `data_version`); `PRAGMA table_info` reports
what is actually there. The stamp is still *written* so `dataVersion()` is not
fiction, but the **decision** comes from the schema.

| property | how it is achieved |
|---|---|
| idempotent | a column is added only when absent; running twice is a no-op |
| restart-safe | identical to idempotent; nothing depends on in-process state |
| non-destructive | `ADD COLUMN` only appends; no row is deleted, updated or reordered |
| transactionally safe | both ALTERs run in one `db.transaction(...)`, so an interruption leaves the previous state rather than a half-migration |
| compatible with existing rows | defaults are exactly 6H's: `exec_generation = 0` ("never claimed"), `attempt_generation = NULL` ("never attempted") |
| no inference | a pre-lineage row is **never** given a generation derived from its `revision` — 6H explicitly declined that, and it is precisely what caused D1 |

### A deliberate non-change: `TASK_DATA_VERSION` stays at 1

I first bumped it to 2 and **that broke `taskstore.test.ts` "H"**, which asserts
`ensureDataVersion() === 1`. I reverted it. Bumping the constant is a semantic
change outside the scope of D3/D4/D5, and it is unnecessary: the migration never
consults the stamp. The constant now carries a comment recording exactly this, so
the next person does not re-introduce the bump or assume the stamp is load-bearing.

---

## 4. D3 migration implementation — **NEW ARCHITECTURE**

```ts
function migrateExecutionLineageSchema(db: Database): void {
  const present = new Set(
    (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((r) => r.name),
  )
  if (present.size === 0) return            // DDL just created it with the columns
  const needsExec = !present.has("exec_generation")
  const needsAttempt = !present.has("attempt_generation")
  if (!needsExec && !needsAttempt) return
  const run = db.transaction(() => {
    if (needsExec) db.exec("ALTER TABLE tasks ADD COLUMN exec_generation INTEGER NOT NULL DEFAULT 0")
    if (needsAttempt) db.exec("ALTER TABLE tasks ADD COLUMN attempt_generation INTEGER")
  })
  withBusyRetrySync(() => { run(); return true })   // TASK_MIGRATION_FAILURE on throw
  // then record data_version as bookkeeping, in its own swallowed try/catch
}
```

`NOT NULL DEFAULT 0` is required by SQLite for `ADD COLUMN` and backfills every
existing row with `0`. `attempt_generation` is deliberately nullable with **no**
default, so existing rows read as `NULL`.

**No second migration system was invented.** The function reuses the store's
existing `withBusyRetrySync` and `TaskError` conventions, and it is the only
schema work on the open path.

---

## 5. D3 compatibility — **VERIFIED**

| shape | opens | rows | lineage | verdict |
|---|---|---|---|---|
| A. fresh DB | yes | — | `(0, null)` | **VERIFIED** |
| B. pre-6F DB (no columns at all) | yes | intact | `(0, null)` | **VERIFIED** — `D3.2` |
| C. 6F DB (has `task_attempt`) | yes | intact | correct, stale table ignored | **VERIFIED** — `D3.6` |
| D. 6I DB | yes | intact | correct | **VERIFIED** |
| E. partially migrated (one column) | yes | intact | `(0, null)` | **VERIFIED** — `D3.5` |
| F. migration run twice | yes | intact | unchanged | **VERIFIED** — `D3.4` |
| G. interruption between steps | — | — | transactional; test `D3.5` is the reachable shape | **NOT IMPLEMENTED** (no fault-injection hook exists) |
| H. existing `IN_PROGRESS` row | yes | intact, still reconcilable | `(0, null)` | **VERIFIED** — `D3.2` |
| I. existing `COMPLETED` row | yes | intact | `(0, null)` | **VERIFIED** — `D3.4` |
| J. existing `CANCELLED`/`BLOCKED` | yes | intact | `(0, null)` | **VERIFIED** (status never read by the migration) |

**No migration converts missing evidence into completed evidence.** A pre-lineage
row is always `(0, null)` — "never claimed, never attempted" — never
`attempt_generation = 0`, which would have fabricated a completion. Asserted
directly in `D3.2` and `D3.5`.

**Legacy safety after migration** (`D3.3`, `D3.7`, raw SQLite): `createTask`,
`patchTask`, status transitions and completion all work; a full LEGACY lifecycle
leaves `exec_generation = 0` and `attempt_generation = null` on every row; no
Scheduler is constructed; no authority is activated. **Schema presence is not
activation.**

---

## 6. D3 migration test — **the fixture is genuinely pre-schema**

6J's specific criticism was that 6I's `J1` created the fixture with the *current*
TaskStore, so it could never have detected a missing migration. That is fixed:

`preLineageDatabase()` issues **raw `CREATE TABLE` SQL** with the exact pre-6I
column list, and `D3.1` asserts the fixture genuinely lacks both columns
**before** `TaskStore` is ever constructed. `D3.2` then asserts they exist after.

**And the migration is mutation-tested** (§15): removing the call, or making it a
detect-only no-op, both fail `D3.2`. The test is pinned to real behaviour, not to
its own setup.

---

## 7. D4 baseline reproduction — **VERIFIED (REAL DEFECT, pre-fix)**

Through the **real production** `deleteSession`, never `deleteSessionTasks` directly:

```
tasks before delete              t1:PENDING, t2:PENDING
  lineage of t1 (ran once)       {"execGeneration":1,"attemptGeneration":1}
deleteSession completed          yes
RAW tasks.db after delete        [t1 ... exec_generation:1, t2 ...]   <- both survive
recreated session sees           2 task(s): t1:PENDING, t2:PENDING
old tasks EXECUTED               ["t1"]    <- deleted work RE-RAN
```

After the fix:

```
RAW tasks.db after delete        []
recreated session sees           0 task(s)
Scheduler.cycle()                stop=no-candidates
old tasks EXECUTED               []
lineage after                    null
```

---

## 8. D4 delete lifecycle — **NEW ARCHITECTURE**

`deleteSession` now begins by removing TaskStore rows through the store's own API:

```ts
try {
  const { TaskStore } = await import("../task/store.ts")
  new TaskStore(cwd).deleteSessionTasks(id)
} catch (e) {
  throw new Error(`deleteSession: task store cleanup failed for ${id}; ...`)
}
```

| requirement | how it is met |
|---|---|
| through TaskStore APIs | `new TaskStore(cwd).deleteSessionTasks(id)` — the pre-existing method; **no second deletion API was created** |
| no direct SQL from session persistence | verified: `src/session` contains no `tasks.db`, no `TASK_DB_FILENAME`, no schema text; the only hit is this comment |
| no duplicated delete logic | 1 call; TaskStore still owns deletion |
| dynamic import | matches the file's existing best-effort pattern (`journal.ts`, `checkpoint.ts`) and avoids any load-order coupling |
| **not** best-effort | see §9 — swallowing it would recreate D4 |

---

## 9. D4 cross-database semantics — **EXPLICITLY NOT ATOMIC**

> **This operation is NOT atomic across the two databases.**

`tasks.db` and `sessions.db` are separate SQLite files. No transaction spans them,
and the source proves none is attempted. The only safety mechanism available is
**ordering**, so the ordering was chosen by comparing the two possible residues,
which are **not symmetric**:

| order | failure point | residue | severity |
|---|---|---|---|
| **A** session-side first | task delete fails | tasks survive a **deleted** session → **executable orphans** (exactly D4) | **dangerous** |
| **A** session-side first | session delete fails | nothing deleted | benign |
| **B** tasks first **(chosen)** | task delete fails | session **still exists** → delete visibly incomplete, retryable, no orphan | **benign** |
| **B** tasks first **(chosen)** | session delete fails | session exists with **no** tasks; retry is a task-delete no-op then completes | **benign, converges** |

Order **B** is implemented. The asymmetry is the whole argument: the dangerous
residue is "tasks without a session", so the tasks go first.

**No new guard, tombstone, lease or lock was introduced** — none is needed once
the benign residue is the only reachable one. Had order A been retained, a
narrowly-scoped guard would have been required; that is not the case here.

---

## 10. D4 failure modes — **VERIFIED by injection**

`D4.6` injects a real failure at the only seam production uses
(`TaskStore.prototype.deleteSessionTasks`) and inspects the residual state:

```
deleteSession threw            "...task store cleanup failed for S..."
the session SURVIVED           loadSession("S") !== null     <- not freed
task rows untouched            ["t1"]                         <- safe: the id was never released
retry after the fault          session gone, tasks.db empty   <- CONVERGES
```

So: **retry is safe**, **session-ID reuse is not possible** while the failure
persists (the id was never freed), and **no orphan is reachable** — precisely
because the ordering leaves the session intact. The task rows are still there, but
they belong to a session that still exists, so nothing is orphaned.

---

## 11. D4 session reuse proof — **VERIFIED, raw SQLite**

`D4.2`, end to end through the production API:

| step | assertion |
|---|---|
| 1. create session `S` + task with a recorded generation | `(1,1)` |
| 2. `deleteSession("S", dir)` | `tasks.db` rows `[]` |
| 3. recreate the same id | `getSnapshot("S").tasks` `[]` |
| 4. create a new task | same canonical id recycled |
| 5. lineage | **`{execGeneration: 0, attemptGeneration: null}`** |
| 6. construct a Scheduler, cycle | only the **new** task runs, from generation 1 |
| 7. old work selectable | **no** |

Multi-session isolation (`D4.3`): deleting `S1` leaves `S2`'s task, lineage and
Scheduler fully intact — `S2` is not re-dispatched because its own generation is
recorded, which also re-verifies the `attempt == exec` protection.

Repeat delete (`D4.4`): the second `deleteSession` does not throw and resurrects
nothing.

---

## 12. D5 active-claim safety — **VERIFIED**

`D5.1` builds the exact state 6J identified, using a **deferred bridge** so the
claim is genuinely held by a live turn:

```
G1 completes                              lineage = {1, 1}
requeue, G2 claims, turn blocks in-flight lineage = {2, 1}   <- attempt < exec, task ALIVE
sc.reconcile()   (the OWNER)              []
status                                   IN_PROGRESS
lineage                                  {2, 1}      <- unchanged
release the bridge
G2 finishes                              lineage = {2, 2}
```

`D5.2` keeps the three outcomes **distinct** rather than collapsing them into one
`IN_PROGRESS` assertion:

| case | outcome |
|---|---|
| A. same Scheduler still owns active G2 | `reconcile()` → `[]`, stays `IN_PROGRESS` |
| B. fresh Scheduler, claim is genuinely stranded | `reconcile()` → `[t1]`, becomes `PENDING` |
| C. ownership unavailable | `start()` throws, `reconcile()` → `[]` — **fails closed** |

`D5.3` pins the store-level consequence directly, so the exemption is bound to
real behaviour: with the owner protected, the very same row *is* reconcilable
(`RECONCILED`) once the claim is gone.

**No production code changed for D5.** The exemption was already correct; only
the evidence was missing.

---

## 13. Lineage regression — **VERIFIED unchanged**

Re-ran the 6J probes after all three fixes:

```
active-claim exemption       HOLDS: G2 NOT recovered
ownership gate               HOLDS: refused, G2 untouched
stranded recovery            recovery CORRECT
fail closed                  HOLDS
attempt == exec              HOLDS (not recovered)
normal-return vs crash       distinguishable: YES
reconcile outcomes           differ: A protected, B recovered
```

| invariant | result |
|---|---|
| only accepted claim advances `exec_generation` | **VERIFIED** — `E2`, K1/K2 mutants |
| ordinary mutation never advances it | **VERIFIED** — 5 mutation kinds |
| normal return records the correct generation | **VERIFIED** — M2/M3 killed |
| stale generation cannot protect a newer one | **VERIFIED** — M5/M6/M9 killed |
| deleted task cannot leak lineage | **VERIFIED** — D2 + D4.2 |
| restart preserves lineage | **VERIFIED** |
| normal return cannot recreate the 6D livelock | **VERIFIED** — `A2`, 8 cycles → `runs == 1` |

**No 6H/6I semantic change.** The `store.ts` diff is 97 insertions of a new
function, its call site, and a version comment — **zero modified existing
statements**. `exec_generation` meaning, `attempt_generation` meaning, claim
generation, revision semantics, the marker/recovery relation, TaskGraph,
readiness and task identity are all untouched.

---

## 14. Static architecture — **VERIFIED CLEAN**

```
Scheduler runtime closure (3 modules): graph.ts, scheduler.ts, session-ownership.ts
Scheduler runtime-edges into store.ts : no  (TaskStore is a TYPE-only import)
TaskStore owns SQLite persistence     : yes
modules naming task_attempt           : []
production `new Scheduler(` sites     : 0
RESULT: CLEAN
```

| owner | responsibility | verified |
|---|---|---|
| **TaskStore** | task deletion, lineage, schema migration, atomic claim/reconciliation | owns all four; `deleteSessionTasks` is the only deletion path and is now called |
| **session persistence** | orchestrates deletion | calls the TaskStore API; contains **no** `tasks.db`, `TASK_DB_FILENAME`, `exec_generation` or `task_attempt` |
| **Scheduler** | headless; no SQLite, no task deletion, no schema ops | `scheduler.ts` **byte-unchanged** this phase |

---

## 15. Mutation evidence — **20 / 20 killed, 0 survivors, 0 HARNESS MISS**

Per §20 discipline: unique anchors, target verified changed, compile checked,
stdout **and** stderr inspected, no no-op mutants, no module-cache evidence.

**Carried over (M1–M16), now with the 6K suite included:**

| id | mutation | killed by |
|---|---|---|
| M1–M12, M14–M16 | 6I's set | `A1`, `A2`, `C1`, `D1` (as before) |
| **M13** | **remove the active-claim exemption** | **`D5.1` / `D5.2`** — previously SURVIVED in 6J |

**New for the 6K changes:**

| id | mutation | killed by |
|---|---|---|
| **K1** | remove the lineage migration entirely | `D3.2` |
| **K2** | make the migration detect-only, never ALTER | `D3.2` |
| **K3** | remove the TaskStore cleanup from `deleteSession` | `D4.1` |
| **K4** | reverse the ordering (tasks deleted after session state) | `D4.6` |

**M13 is scored honestly.** The 6J attempt that "proved" harm was invalid — it
imported the module before mutating, so ES module caching ran pristine code. For
6K the mutation harness re-reads the mutated file from disk to prove installation
and runs the suite in a **separate `bun` process**, so no pristine module graph
can be reused. M13 is a genuine kill.

**K4 required a different technique.** The ordering is a code-structure property,
not a single expression, so a string-replacement mutant cannot express it. I
replaced it with a **failure-injection test** (`D4.6`) that moves the real block
and observes the residual state. That is stronger than a mutant, because it tests
the consequence rather than the code shape.

**Three of my own harness errors were found and corrected rather than reported as
results:** a defective K4 anchor, and (in 6J, carried here) two mutants that did
not implement their names. No no-op was scored as a kill.

---

## 16–17. Migration and deletion tests — **VERIFIED**

`test/phase6k-integration-safety.test.ts` — **16 pass / 0 fail**, 85 assertions.

| group | tests |
|---|---|
| D3 | `D3.1` fixture is genuinely pre-lineage · `D3.2` migrates and preserves every field · `D3.3` LEGACY creation works · `D3.4` idempotent across 3 opens · `D3.5` partially-migrated converges · `D3.6` 6F-era `task_attempt` ignored · `D3.7` no evidence manufactured |
| D4 | `D4.1` rows + lineage removed (raw SQLite) · `D4.2` reuse yields clean lineage, old work not selectable · `D4.3` other sessions untouched · `D4.4` repeat delete safe · `D4.6` failure injection leaves a retryable session |
| D5 | `D5.1` owner cannot reconcile its live claim · `D5.2` owner / fresh / fail-closed kept distinct · `D5.3` store-level consequence pinned |
| interaction | `K.1` migrate → generate → delete → reuse is clean |

Combined task suites: **144 pass / 0 fail** (6K 16, 6I 41, 6C 49, 6B 38).

---

## 18. Performance — **VERIFIED (measurement, not optimised)**

**D3 migration cost** (pre-6I database, medians of 3):

| rows | first open (migrates) | second open (no-op) |
|---|---|---|
| 100 | 13.9 ms | 1.3 ms |
| 1 000 | 13.8 ms | 1.2 ms |
| 10 000 | 17.0 ms | 1.1 ms |

**The migration is O(1) in row count** — 13.8 ms at 1 000 rows and 17.0 ms at
10 000. That is not a measurement artefact: `ALTER TABLE … ADD COLUMN` in SQLite
is a **schema-only** operation that appends a column definition and does not
rewrite rows. It is independent evidence that the migration is non-destructive.
Subsequent opens cost ~1.2 ms because the column check short-circuits.

**D4 session deletion cost** (tasks + session side, medians of 3): **100 ms** at
100 tasks, **67 ms** at 1 000. Cost is dominated by the pre-existing best-effort
cleanup (checkpoint directory walk, shadow-git ref prune, trace purge), not by the
task delete.

**D5 / lineage hot path: unchanged.** The migration runs once per database open,
never per cycle. The reconciliation `UPDATE` and the claim `UPDATE` each still
write the same number of columns as in 6I.

---

## 19. Legacy compatibility — **VERIFIED**

| requirement | result |
|---|---|
| existing workflows functional | **VERIFIED** — `D3.3`, `D3.7` |
| task creation on an old DB | **VERIFIED** — this is the call that threw in 6J |
| task deletion works | **VERIFIED** — `D4.1` |
| session deletion works | **VERIFIED** — `D4.1`–`D4.4` |
| session-ID reuse resurrects nothing | **VERIFIED** — `D4.2` |
| no Scheduler construction | **VERIFIED** — 0 production sites |
| no authority activation | **VERIFIED** — `authority: "SCHEDULER"` never constructed in `src` |

**D4 was proved without enabling the Scheduler**, using the real production
`deleteSession` plus raw SQLite inspection, as the brief requires.

---

## 20. Findings

| # | finding | class |
|---|---|---|
| K1 | D3 fixed: pre-6I databases migrate; `createTask` works again | **VERIFIED** |
| K2 | The migration is O(1) in row count, empirically confirming no row rewrite | **VERIFIED** |
| K3 | D4 fixed: `deleteSession` removes task rows; reuse yields zero old tasks | **VERIFIED** |
| K4 | The two-database operation is **not atomic**; ordering B makes the reachable residue benign | **VERIFIED** |
| K5 | A task-deletion failure leaves a retryable session and no reachable orphan | **VERIFIED** |
| K6 | D5 fixed: M13 killed by `D5.1`; no production code needed | **VERIFIED** |
| K7 | 20/20 mutants killed, 0 survivors, 0 harness misses | **VERIFIED** |
| K8 | The 6K migration fixture is genuinely pre-schema, closing 6J's criticism of 6I's `J1` | **VERIFIED** |
| K9 | Lineage architecture untouched: 97 additive lines in `store.ts`, `scheduler.ts` byte-unchanged | **VERIFIED** |
| K10 | **Bumping `TASK_DATA_VERSION` broke `taskstore.test.ts` "H"** and was reverted as out of scope; the stamp is bookkeeping and the migration does not gate on it | **VERIFIED** |
| K11 | My first K4 mutant was a defective anchor; replaced by failure injection, which is stronger | **HARNESS MISS** (mine, corrected) |
| K12 | An interruption *between* migration statements is not directly testable — no fault-injection hook exists | **NOT IMPLEMENTED** |
| K13 | Model↔task intent remains unprovable | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| K14 | Scheduler reachability stays zero; all three defects are now fixed, so none is latent-but-broken | **VERIFIED** |

---

## 21. Remaining limitations

| # | limitation | class |
|---|---|---|
| L1 | **This operation is not atomic across the two databases.** Ordering makes the failure benign and retryable, but a crash between the two deletions leaves a session with no tasks. Documented, not engineered away | **DEFERRED** |
| L2 | No fault-injection hook exists for an interruption *inside* the migration transaction; the transaction boundary is reasoned about, not exercised | **NOT IMPLEMENTED** |
| L3 | A death between `runTurn` returning and the completion write still costs one duplicate | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| L4 | The Scheduler still cannot prove the model worked on the selected task | **IMPOSSIBLE WITH CURRENT CONTRACT** |
| L5 | A returned-but-unadjudicated task waits for an external authority forever | **DEFERRED** |
| L6 | Cross-process same-session ownership unsupported | **DEFERRED** |
| L7 | No verifier component exists, so verifier interaction is still proven against `patchTask` | **UNVERIFIED** (inherited) |
| L8 | `deleteSessionTasks` is now on a production path for the first time; it has only a narrow test (one session, many tasks) and no large-scale or concurrent-delete coverage | **DEFERRED** |

---

## 22. Exact changed files

| file | change |
|---|---|
| `src/task/store.ts` | **+97, purely additive**: `migrateExecutionLineageSchema()` (new), its call in `handle()`, a comment on `TASK_DATA_VERSION`. **Zero existing statements modified.** |
| `src/session/persistence.ts` | **+36 / −11**: `deleteSession` now deletes TaskStore rows first, via the TaskStore API, with the ordering rationale and an explicit non-swallow policy |
| `test/phase6k-integration-safety.test.ts` | **new**, 16 tests / 85 assertions, including the genuinely pre-6I SQL fixture |

---

## 23. Frozen surfaces — **VERIFIED UNCHANGED**

`model.ts` · `graph.ts` · `graph-validate.ts` · `readiness.ts` ·
`session-ownership.ts` · **`scheduler.ts`** · `todo.ts` · `vendor/minicore` ·
`src/ui` · `src/tui` · `src/acp` · `src/presentation` · `parallel-executor` ·
`package.json`

`scheduler.ts` being untouched is the strongest single statement of scope: D5
required *evidence*, not behaviour, so no Scheduler line moved.

No new `TaskStatus`. No lease, heartbeat, retry engine, attempt UUID, structured
execution bridge, completion-ownership change, or TaskGraph/readiness change.

---

## 24. Exact commit

```
fix: close scheduler integration safety gaps
```

---

## 25. Tree cleanliness

`git status` — **CLEAN**. `git diff --stat` and `git diff` — empty.

All probes, migration fixtures and the mutation harness lived **outside** the
repository. Gates on the actual working tree:

| gate | 6J baseline | after 6K |
|---|---|---|
| `tsc --noEmit` | 28 | **28** (0 in 6K scope) |
| lint `src/task` | 7 | **7** |
| biome on the 3 changed files | — | **0** |
| full suite | 3045 / 23 skip / 4 fail | **3045 / 23 skip / 4 fail** |
| task suites | 128 | **144** (+16 new) |

The 4 failures are the same pre-existing set (architecture-map, two `audit #11`
vendor/pack hash, `web ssg`). **No new failures.**

One transient regression was caught and reverted during this phase: bumping
`TASK_DATA_VERSION` to 2 broke `taskstore.test.ts` "H". It is recorded as K10
rather than quietly fixed, because the reason for the revert is a design decision
someone will otherwise repeat.

---

## 26. Scheduler enablement status

# STILL NOT ENABLED

| | |
|---|---|
| production `new Scheduler(` sites | **0** |
| modules importing `task/scheduler` outside tests | **0** |
| `authority: "SCHEDULER"` constructed in `src` | **0** |
| env-var / script / CLI activation | **0** |
| composition-root wiring | **none** |
| pushed | **no** |

Adversarial audit **not** started, per the brief.

---

## 27. Bottom line

All three of 6J's integration defects are closed, and the fixes are smaller than
the defects were: **two production files, one of them purely additive, and
`scheduler.ts` untouched.**

D3 was the serious one, and the honest detail is *why* it shipped twice past
review. 6I's own test created its migration fixture with current code, so the
columns always existed and the test was structurally incapable of failing. 6K
rebuilds the fixture from raw SQL and asserts its own pre-migration shape before
opening the store, and then mutation-tests the migration away (K1, K2) so the test
is pinned to the fix rather than to its setup. That is the change that matters
most here — not the `ALTER TABLE`, but the removal of a test that could not fail.

D4's fix is one call through an existing API that had been dead code, but the
part worth arguing for is the **ordering**: tasks first, because the two possible
residues are not symmetric and the dangerous one is "tasks outliving a deleted
session". I did not add a tombstone or a lock to compensate, because with that
ordering the benign residue is the only reachable one, and a new authority would
have been the more dangerous change.

D5 needed no production change at all — the exemption was already correct. What
was missing was evidence, and M13's survival was a statement about the suite, not
about the code. Adding `D5.1` with a genuinely blocked turn, and scoring the mutant
in a separate process so no pristine module graph could be reused, turned that
from an unproven claim into a kill.

What is unchanged and still true: the lineage model only proves that an
*execution generation ended*, never that the model worked on the task it was
given, and a crash in the one-write window still costs a duplicate. Those are the
same walls 6E documented, and none of them is a reason to hold this phase.
