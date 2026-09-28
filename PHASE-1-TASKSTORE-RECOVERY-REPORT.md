# PHASE 1 — TASKSTORE RECOVERY REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `58cdafe` (Phase 0C) — the brief said `09687ae`, but HEAD already
carried Phase 0C, so this phase was built on top of it.
Artifact: `store.orig.ts` (679 lines, pre-wipe uncommitted tree).

---

## 1. Source evidence

| Source | Role | Status |
|---|---|---|
| `store.orig.ts` | primary — the code that actually ran | present, 679 lines |
| `src/tools/todo.ts` (baseline, 375 lines) | `normalizeTodos`, `applyCompletionPolicy`, `CompletionEvidence`, `UNVERIFIED` | present in baseline |
| `todo.orig.ts` (416 lines) | N2 addressing variant of the above | present, **deferred to Phase 2** |
| `docs/TASK_IDENTITY_SPEC.md` | `t<n>`, n monotonic from 1 | present (baseline HEAD `aa76dfb`) |
| `docs/TASK_STATE_MACHINE_SPEC.md` | Task schema, 8-status enum | present — **conflicts with artifact** |
| `src/constants.ts` | `LIMITS.SQLITE_*`, `TODO_*` | present |
| `src/lib/db-path.ts` | `resolveLocalDbPath` (Phase 0B) | present |
| `src/policy/scrub.ts` | `scrubSecrets` | present |
| **`src/task/model.ts`** | 12 exports the store needs | **ABSENT — no artifact, no baseline** |
| **`src/task/normalize.ts`** | 5 exports the store needs | **ABSENT — no artifact, no baseline** |

Zero baseline hits for `isTaskId`, `isTaskStatus`, `TaskStatus`, `TaskError`,
`taskIdFromIndex`, `todoStatusToTask`. The store could not be lifted verbatim;
`src/task/model.ts` was reconstructed from artifact usage with every inference
tagged `[INFERRED]`.

## 2. Artifact vs baseline comparison

The artifact disagrees with the in-repo design docs on the Task shape. The
artifact is later and is the code that ran, so it wins:

| aspect | design doc | artifact (chosen) |
|---|---|---|
| status casing | lowercase | **UPPERCASE** `"PENDING"` |
| blocker | `blocker: TaskBlocker` | `blockedReason: string \| null` |
| timestamps | `number` | **ISO `string`** |
| verification | `at: number` | `checkedAt: string` |
| provenance | `{source, actor, at}` | `{origin, source}` |
| `titleKey` | present | **absent** |
| `sessionId`, `revision` | absent | **present** |

The doc also recommends `sessions.db`; the artifact rejects it because that path
may fall back to shared `~/.minicode/` (violating D2). **Separate `tasks.db` recovered.**

## 3. Recovered API

`initialize`, `getTask`, `listTasks`, `getSnapshot`, `nextId`, `createTask`,
`patchTask`, `updateTask`, `deleteTask`, `deleteSessionTasks`, `getMeta`,
`setMeta`, `migrationStamp`, `markMigrated`, `dataVersion`, `ensureDataVersion`,
`static close`, `resetTaskStoreHandles`, `legacyDigest`, plus
`NewTaskInput` / `TaskPatch` / `UpsertOptions`.

**Deliberately absent:** `synchronizeTasks`, `upsertTasks`, `UpsertResult`. They
read `item.taskId` off `normalizeTodos()` output, and **no surviving module
declares a `TodoItem.taskId`** — not `todo.orig.ts`, not baseline `todo.ts`.
Recovering them means inventing end-to-end `taskId` addressing = **Phase 3**.

## 4. Recovered schema

`tasks` (15 columns, `PRIMARY KEY (session_id, task_id)`), index
`idx_tasks_session_order`, and `task_meta(key, value)`. Columns exactly as the
artifact's `TaskRow`. **No column added for later phases.**

## 5. Revision semantics

- `revision` starts at **1** (hardcoded in the INSERT).
- Successful mutation: `revision = revision + 1` (UPDATE).
- `expectedRevision` is checked **before** the write; on mismatch it throws
  `TASK_STALE_REVISION` and the revision does **not** advance.
- This is the **substrate only**. No scheduler claim/CAS logic was added.

## 6. Transaction semantics

`createTask` and `patchTask` both wrap their body in `db.transaction()`. No
redesign. See §13 for the honest limit of what this is currently worth.

## 7. Normalization semantics

The store is a *consumer* of normalization, not its owner. `normalizeTodos` /
`applyCompletionPolicy` survive in baseline `src/tools/todo.ts` and were **not
modified**. The store's own contribution is `validate()`: BLOCKED requires a
reason (PF-04), dependencies must be canonical/existing/non-self/non-duplicate,
a task may not be its own parent. `parseJson()` degrades a corrupt column to a
neutral value rather than dropping the task.

**Phase 2 addressing and Phase 3 taskId planning are not implemented here.**

## 8. Migration semantics — partial, and honestly so

**Recovered (substrate):** `migrationStamp`/`markMigrated` (per-session
`migrated:<id>` key), `legacyDigest` (SHA-256 of `scrubSecrets(raw)`, 32 hex),
`dataVersion`/`ensureDataVersion` with explicit refusal to downgrade.

**NOT recovered:** the migration *trigger/importer* that reads
`<cwd>/.minicode/todos/*.json` and writes tasks. **It exists in no artifact.**
So the FINAL GATE item "migration behavior verified" is satisfied **only for the
idempotency substrate** — deterministic digest, repeated-mark no-op, downgrade
refusal. The importer cannot be reconstructed without inventing it.

## 9. Concurrency handling

**The artifact carried the exact SQLITE_BUSY gap §9 forbids.** It ran a bare
`db.exec(DDL)`. I measured the real failure under a held write lock:

```
artifact behaviour : "no such table: main.tasks" after ~3350 ms
```

Not `SQLITE_BUSY`. bun runs the script *past* the blocked `CREATE TABLE` into
the `CREATE INDEX`, which then fails with a **non-busy** error — so a retry keyed
on `SQLITE_BUSY` never engaged, and the caller saw a misleading error after the
full 3 s `busy_timeout`. Fixed by executing the DDL **one statement at a time**,
each inside a bounded retry (3 attempts, 25/50/100 ms). The retry now genuinely
engages. Retry reimplemented locally; **Phase 0C code untouched**.

## 10. Local DB isolation

`<cwd>/.minicode/tasks.db` via `resolveLocalDbPath` only. `resolveDbPath` appears
**only in a comment explaining why it is not used**. Test J asserts two projects
get independent DBs and that `sessions.db` is never created.

## 11. Implementation diff

| File | Change |
|---|---|
| `src/task/model.ts` | **new** — reconstructed domain types |
| `src/task/store.ts` | **new** — durable TaskStore |
| `test/taskstore.test.ts` | **new** — 17 in-repo regression tests |
| `PHASE-1-TASKSTORE-DELTA-MAP.md` | **new** |
| `PHASE-1-TASKSTORE-RECOVERY-REPORT.md` | **new** (this file) |

No existing source file was modified. Phase 0A/0B/0C code is byte-identical.

## 12. In-repo regression tests

`test/taskstore.test.ts` — **17 tests, 109 assertions, 0 fail**. All required
categories A–M are covered, plus a validation-rails test and a
`deleteSessionTasks` isolation test. Every test owns exactly one
`mkdtemp(join(tmpdir(), "minicode-taskstore-"))` directory and removes only that
absolute path; no `readdir(".")`, no cwd-based cleanup. Real `bun:sqlite`
throughout.

| cat | test |
|---|---|
| A | initialize is idempotent, creates local db |
| B | create/get/list/snapshot round-trip every column |
| C / C2 | revision 1→2→3; stale `expectedRevision` refused, revision unchanged |
| D | patch is partial; `updateTask` alias; explicit `null` clears |
| E | failed write leaves no row and burns no id |
| F | session A ≠ session B, both directions |
| G | 5× initialize, data intact |
| H | digest deterministic, re-mark is a no-op, downgrade refused |
| I | corrupt JSON + unknown status degrade, task still readable |
| J | two projects, independent DBs, no `sessions.db` |
| K | real close + fresh instance, exact durable state, revision resumes at 3 |
| L | PK rejects duplicate id; `nextId` uses max not count |
| M | deterministic `ORDER BY task_order, task_id`, ties broken by id |

## 13. Mutation results

**10 of 12 killed, 0 fabricated.** Each mutant ran against the **in-repo**
suite; the pristine copy was restored and **hash-verified** after every mutant;
all children ran with `cwd` = a throwaway temp dir so a cwd-ignoring mutant
could not pollute the worktree.

| # | mutant | result |
|---|---|---|
| M1 | revision increment removed | KILLED |
| M2 | revision starts at 0 | KILLED |
| M3 | `nextId` uses count instead of max | KILLED |
| **M4** | **`patchTask` transaction wrapper removed** | **SURVIVED — equivalent** |
| M5 | `patchTask` skips the write | KILLED |
| M6 | `listTasks` drops session filter | KILLED |
| M7 | `validate()` disabled | KILLED |
| M8 | `migrationStamp` always null | KILLED |
| M9 | ordering non-deterministic | KILLED |
| **M10** | **busy retry disabled** | **SURVIVED — not covered** |
| M11 | `deleteSessionTasks` drops session filter | KILLED |
| M12 | corrupt JSON rethrows | KILLED |

**M4 is a genuine equivalent mutant.** Each Phase 1 write body contains exactly
*one* mutating statement, and a single-statement mutation is already atomic in
SQLite, so `BEGIN/COMMIT` adds no observable behaviour. The transaction's real
value is cross-writer id allocation in `createTask`, which needs a
**cross-process** concurrency test (bun:sqlite is synchronous) — not attempted
here. Test E's name and comment were rewritten to state this limit rather than
imply it verifies the wrapper.

**M10 is honestly uncovered.** Nothing injects `SQLITE_BUSY`, so disabling the
retry is undetectable. I prototyped real lock contention and it is not
deterministic in this environment (Windows + Bun 1.4.2 + WAL). A flaky test would
be worse than an honest gap, so none was added. Related measured fact: because
`busy_timeout` is 3000 ms **per attempt**, worst-case schema init is ~10 s.

## 14. Dependency limitations

`node_modules` **absent**; no install was performed (unauthorized).

| check | status |
|---|---|
| **PARSE** | **VERIFIED** — `Bun.Transpiler` on both new source files |
| **RUNTIME** | **VERIFIED** — 17/17 tests, 109 assertions, real SQLite |
| **TYPECHECK** | **DEFERRED** — no `tsc` without `node_modules`. `Bun.Transpiler` parses; it does **not** typecheck. |
| **FULL SUITE** | **DEFERRED** — out of scope; 203 pre-existing test files untouched |
| MUTATION | 10/12 killed, 2 classified above |

## 15. Restart verification

Test K uses a real sequence: store A creates + patches → `TaskStore.close(dir)`
→ `resetTaskStoreHandles()` → **new** `TaskStore(dir)` instance → asserts title,
status, blockedReason, `createdAt` equality, `revision === 2`, and that the next
patch advances to 3. Not simulated by reusing one object.

## 16. Safety audit

| check | result |
|---|---|
| `rmSync`/`unlink`/`rmdir`/`readdir`/`process.chdir` in `src/task/**` | **0** |
| `rm()` in tests | 1 site, on the owned `mkdtemp` path only |
| `process.cwd()` | 1, the constructor default (artifact-faithful, non-destructive) |
| `resolveDbPath` **call** | **0** (one mention, in a comment) |
| Scheduler / TaskGraph / readiness in code | **0** (4 mentions, all comments) |
| `src/task/**` deletions | none — only SQLite row deletes |
| dependency install | none |
| test / mutation leftovers | none |

## 17. Deferred items

1. `synchronizeTasks` / `upsertTasks` / `UpsertResult` — **Phase 3** (needs lost `TodoItem.taskId`).
2. Legacy-todo migration **importer** — **unrecoverable**; not in any artifact.
3. `model.ts` members absent from the artifact: `titleKey`, `source`, `blocker` object, `completedAt`, the state machine — **Phase 2+**.
4. N2 canonical addressing in `todo.ts` — **Phase 2**.
5. `plan.updated` projection — **Phase 4**.
6. TaskGraph / readiness / Scheduler — forbidden by the brief.
7. Cross-process concurrency test for `createTask` id allocation.
8. Deterministic `SQLITE_BUSY` injection test.

## 18. Git checkpoint

Commit: **`recovery: reconstruct durable task store`**
Working tree: **CLEAN**. Not pushed (6 ahead of `origin/main`).
Incident specimen `D:\git\minicode` untouched (still only `.freebuff`).
`repo-from-remote` still 0 changes at `aa76dfb`.
No pre-existing file modified — Phase 0A/0B/0C behaviour is untouched.
