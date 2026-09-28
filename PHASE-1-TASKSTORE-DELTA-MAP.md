# PHASE 1 — TASKSTORE DELTA MAP

Workspace: `D:\recover\minicode-20260928\reconstruction`
Baseline: `58cdafe` (Phase 0C) — note the task brief said `09687ae`; the real
HEAD already contained Phase 0C, so Phase 1 was built on top of it.
Forensic artifact: `store.orig.ts` (679 lines).

---

## 0. The finding that shaped this phase

`store.orig.ts` is **not** a Phase 1 file. It is a Phase 1+2+3 snapshot, and it
imports two modules that **no surviving source describes completely**:

| Import in `store.orig.ts` | Survives? |
|---|---|
| `../constants.ts` (`LIMITS`) | **YES** — baseline |
| `../lib/db-path.ts` (`resolveLocalDbPath`) | **YES** — baseline + Phase 0B |
| `../policy/scrub.ts` (`scrubSecrets`) | **YES** — baseline |
| `./model.ts` (12 exports) | **NO** — no artifact, no baseline file |
| `./normalize.ts` (5 exports) | **NO** — no artifact, no baseline file |

Confirmed absent: `src/task/` in the baseline, no `model.orig.ts` /
`normalize.orig.ts` in the forensic set, and **zero** baseline hits for
`isTaskId`, `isTaskStatus`, `TaskStatus`, `TaskError`, `taskIdFromIndex`,
`todoStatusToTask`.

So the store cannot be lifted verbatim. Per §12 the hierarchy was applied
strictly, and where evidence ran out the gap is classified, not filled.

## 1. Doc vs artifact: the Task model conflicts

The in-repo design docs (committed at baseline HEAD `aa76dfb`) describe a
**different** Task than the surviving code. The artifact is later and is the
code that actually ran, so **the artifact wins** — but the conflict is recorded
rather than smoothed over:

| aspect | `TASK_STATE_MACHINE_SPEC.md` | `store.orig.ts` (ACTUAL) | chosen |
|---|---|---|---|
| status casing | lowercase `"pending"` | **UPPERCASE `"PENDING"`** | artifact |
| enum size | 8 | 4 used (`PENDING`,`BLOCKED`,`CANCELLED` named) | 8, artifact casing |
| blocker | `blocker: TaskBlocker` object | `blockedReason: string \| null` | artifact |
| evidence | `TaskEvidenceRef[]` | `TaskEvidence[]`, `kind:"completion"` | artifact |
| provenance | `{source, actor, at}` | `{origin, source}` | artifact |
| timestamps | `createdAt: number` | `createdAt: string` (ISO) | artifact |
| verification | `at: number` | `checkedAt: string` | artifact |
| `titleKey` | present | **absent** | absent |
| `sessionId`, `revision` | **absent** | present | artifact |

The doc also *recommends* putting tasks in `sessions.db`. The artifact
explicitly rejects that, and the artifact's reason is a hard constraint:
`sessions.db` resolves via `resolveDbPath`, which may fall back to the shared
`~/.minicode/`, violating D2 ("MUST NOT silently fall back to a global/shared
database path"). **A separate `tasks.db` is recovered.**

---

## 2. Per-symbol classification

### 2a. `src/task/model.ts` — RECOVERED (reconstructed, inferences tagged)

| Symbol | Artifact evidence | Baseline counterpart | Purpose | Dependencies | Historical decision | Verdict |
|---|---|---|---|---|---|---|
| `Task` | `rowToTask()` — exact field-for-field projection of `TaskRow` | none (docs differ) | the durable task | — | doc's own principle #1: derived from code, not from prose | **RECOVER** |
| `TaskStatus` | `PENDING` (rowToTask fallback), `BLOCKED` (validate), `CANCELLED` (deleteTask comment) | doc: 8 lowercase | lifecycle | — | doc: enum widened 5→8 | **RECOVER** (5 proven, 5 `[INFERRED]`) |
| `isTaskStatus` | called in `rowToTask` | none | status guard | `TaskStatus` | fail-closed on unknown status | **RECOVER** |
| `isTaskId` | gates `getTask`/`patchTask`/`deleteTask` | none | id guard | `taskIdFromIndex` | `t<n>`, n≥1 (`TASK_IDENTITY_SPEC.md`) | **RECOVER** (`[INFERRED]` regex `^t[1-9][0-9]*$`) |
| `taskIdFromIndex` | `nextId()` returns `taskIdFromIndex(max)`, `max` starts at 0 | none | id allocation | — | 1-based: empty session (max 0) must yield `t1`; reproduces artifact's own `t1,t2,t5 → t6` | **RECOVER** |
| `TaskVerification` | construction site `{verdict, detail?, checkedAt}` | doc: `at: number` | evidence of checking | — | artifact wins on field name+type | **RECOVER** |
| `TaskEvidence` | construction site `{kind:"completion", detail, at}` | doc: `TaskEvidenceRef` | append-only evidence | — | artifact wins | **RECOVER** (kind union `[INFERRED]`) |
| `TaskProvenance` | default `{origin:"runtime", source:"unknown"}`; write `{origin:"model", source:"todo_write"}` | doc: `{source,actor,at}` | origin tracking | — | artifact wins; `origin` is a closed 2-value union | **RECOVER** |
| `TaskAcceptance` | stored + returned, **never read, never constructed non-null** | — | opaque passthrough | — | — | **RECOVER as opaque** `Record<string, unknown>` |
| `TaskSnapshot` | `getSnapshot()` return | none | snapshot | `Task` | — | **RECOVER** |
| `TaskError` | 7 codes raised; +`TASK_STALE_REVISION`, +`TASK_MIGRATION_FAILURE` | none | typed domain error | — | stable machine-readable `code` | **RECOVER** |
| state machine / transitions | none in artifact | doc has a transition table | — | — | doc: DESIGN only, no code | **DEFER** (Phase 2+) |
| `titleKey` re-attach | **absent from artifact** | doc: present | — | — | doc admits it is best-effort | **DEFER** |
| `source`/`blocker`/`completedAt` | **absent from artifact** | doc: present | — | — | — | **DEFER** |

### 2b. `src/task/store.ts` — from artifact

| Symbol | Purpose | Verdict |
|---|---|---|
| `TASK_DB_FILENAME`, `MAX_*`, `TASK_DATA_VERSION` | bounds + data version | **RECOVER** |
| `TaskRow`, `DDL` | schema (15 cols, PK `(session_id,task_id)`, order index, `task_meta`) | **RECOVER** |
| `handles` / `initialized` caches | avoid re-running DDL per op | **RECOVER** |
| `dbFile()` | `resolveLocalDbPath("tasks.db", cwd)` | **RECOVER** |
| `handle()` | open, `busy_timeout` first, WAL block, `chmod 0600`, DDL | **RECOVER + FIXED** (see §3) |
| `parseJson()` | corrupt column must not drop the task | **RECOVER** |
| `rowToTask()` | authoritative row→domain projection | **RECOVER** |
| `initialize` | idempotent schema prep | **RECOVER** |
| `getTask` / `listTasks` / `getSnapshot` | reads; `ORDER BY task_order, task_id` | **RECOVER** |
| `nextId` | `max`-based, not `count`-based | **RECOVER** |
| `validate` (private) | BLOCKED needs reason; deps real/unique/non-self; parent not self | **RECOVER** |
| `createTask` | allocates id **inside** the transaction | **RECOVER** |
| `patchTask` / `updateTask` | optimistic `expectedRevision`; `revision = revision + 1` | **RECOVER** |
| `deleteTask` / `deleteSessionTasks` | compatibility-only deletion (D7) | **RECOVER** |
| `getMeta`/`setMeta`/`migrationStamp`/`markMigrated`/`dataVersion`/`ensureDataVersion` | migration substrate + downgrade refusal | **RECOVER** (substrate only) |
| `static close`, `resetTaskStoreHandles` | shutdown / hermetic tests | **RECOVER** |
| `legacyDigest` | scrubbed SHA-256 fingerprint, 32 hex | **RECOVER** |
| `NewTaskInput`, `TaskPatch`, `UpsertOptions` | input shapes | **RECOVER** |
| `UpsertResult` | only consumer was `synchronizeTasks` | **DEFER** |
| `synchronizeTasks` | D7 retain-not-delete, CANONICAL/LEGACY modes | **DEFER — Phase 3** |
| `upsertTasks` | alias of the above | **DEFER — Phase 3** |

### 2c. Explicitly deferred

| Item | Why deferred |
|---|---|
| `synchronizeTasks` / `upsertTasks` | Reads `item.taskId` off `normalizeTodos()` output. **No surviving module has a `TodoItem.taskId`** — neither `todo.orig.ts` (416 lines) nor baseline `src/tools/todo.ts` (375 lines) declares it. Recovering these requires inventing end-to-end `taskId` addressing = **Phase 3, forbidden here**. |
| legacy-todo migration **importer** | `store.orig.ts` contains only the *substrate* (`migrationStamp`, `markMigrated`, `legacyDigest`). The trigger/importer that reads `<cwd>/.minicode/todos/*.json` and writes tasks is **in no artifact at all**. Not reconstructable. |
| `N2` canonical addressing | `todo.orig.ts` = baseline `todo.ts` + `sanitizeSessionPart` + `legacyTodoPath` fallback only. Classified **Phase 2** in Phase 0C, still deferred. |
| `reducer.orig.ts` projection | Phase 4, and `plan.updated` projection is explicitly out of scope. |
| TaskGraph / readiness / Scheduler | forbidden by the brief; no evidence in the artifact either. |
| `synchronizeTasks`' D7 *retain* semantics | Bound up with the above; re-attaching it in isolation would import half of a Phase 3 design. |

## 3. Deviations from the artifact (and why)

1. **`synchronizeTasks`/`upsertTasks`/`UpsertResult` removed** — §2c.
2. **DDL is executed one statement at a time, each inside a bounded busy-retry.**
   This is a measured fix, not a guess. The artifact ran
   `db.exec(DDL)` bare. Under a held write lock I measured: the error surfacing
   was **`no such table: main.tasks`** after ~3350 ms — bun runs the script
   *past* the blocked `CREATE TABLE` into the `CREATE INDEX`, which then fails
   with a **non-busy** error. A retry keyed on `SQLITE_BUSY` therefore never
   engaged, and the caller got a misleading error after the full 3 s
   `busy_timeout`. Per-statement execution makes the lock conflict surface as
   `SQLITE_BUSY` on the statement that actually needs the lock. This is
   exactly the gap §9 forbids reintroducing.
3. **`./normalize.ts` import dropped** — only `synchronizeTasks` used it.
   `UpsertOptions.evidence` keeps its `CompletionEvidence` type via a
   **type-only** import from `../tools/todo.ts`, which survives in the baseline.
   It is inert in Phase 1 and labelled as such.
4. **Bounded retry reimplemented locally** rather than imported from
   `persistence.ts` (whose copy is module-private). Phase 0C code untouched.
