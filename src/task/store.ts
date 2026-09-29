// TaskStore — durable authority for task state (Phase 1).
//
// RECOVERY NOTE. This file is reconstructed from
// `store.orig.ts`, an actual recovered snapshot of the pre-wipe uncommitted
// tree. It is NOT a redesign. Deviations from the artifact, and only these:
//
//   D1. `synchronizeTasks()` / `upsertTasks()` / `UpsertResult` are NOT here.
//       DEFERRED to Phase 3. They read `item.taskId` off the output of
//       `normalizeTodos()`, and no surviving module has a `TodoItem.taskId`
//       (see `todo.orig.ts` and baseline `src/tools/todo.ts` — neither has
//       one). Recovering them would require inventing Phase 3 addressing.
//       Every other artifact member is preserved verbatim.
//   D2. `CREATE TABLE` is wrapped in a bounded busy-retry (artifact line 137 ran
//       a bare `db.exec(DDL)`). The artifact therefore still carries the exact
//       SQLITE_BUSY gap that Phase 0C closed in `persistence.ts`. Reintroducing
//       it is forbidden, so it is fixed here. The retry is reimplemented locally
//       rather than imported, leaving Phase 0C code untouched.
//
// Database: a SEPARATE `tasks.db` at `<cwd>/.minicode/tasks.db`, reached through
// `resolveLocalDbPath` (Phase 0B, N1). NOT `sessions.db`, because that resolves
// via `resolveDbPath` which may fall back to the shared `~/.minicode/` — which
// violates D2 ("MUST NOT silently fall back to a global/shared database path").
// A separate file also keeps this table clear of `sessions.db`, which already
// carries 11 additive migrations and its own concurrency tests.
//
// All SQL lives here. Other subsystems may only use the domain API.

import { Database } from "bun:sqlite"
import { LIMITS } from "../constants.ts"
import { resolveLocalDbPath } from "../lib/db-path.ts"
import { scrubSecrets } from "../policy/scrub.ts"
import type { CompletionEvidence } from "../tools/todo.ts"
import {
  type ClaimOutcome,
  isTaskId,
  isTaskStatus,
  type ReconcileOutcome,
  type Task,
  type TaskAcceptance,
  TaskError,
  type TaskEvidence,
  type TaskProvenance,
  type TaskSnapshot,
  type TaskStatus,
  type TaskVerification,
  taskIdFromIndex,
} from "./model.ts"

const TASK_DB_FILENAME = "tasks.db"

/** Bounds so the JSON columns cannot grow without limit. */
const MAX_DEPENDS_ON = 32
const MAX_EVIDENCE = 32
const MAX_ACCEPTANCE = 32
const MAX_PARENT = 64

/** Shape of the data, not of the table: this rises when column SEMANTICS
 *  change, not merely when a column is added. */
// [PHASE 6K] Deliberately NOT bumped. `TASK_DATA_VERSION` is an existing
// contract (taskstore.test.ts "H" asserts `ensureDataVersion() === 1`, and that
// a newer writer is refused rather than downgraded), and bumping it would be a
// semantic change outside the scope of D3/D4/D5.
//
// It is also unnecessary. The lineage migration decides from
// `PRAGMA table_info`, not from this stamp, precisely because a stamp can lie
// and the schema cannot. The stamp is written as bookkeeping; the migration's
// correctness does not depend on it. If a future change makes the SCHEMA itself
// version-dependent, that change should bump this constant deliberately.
const TASK_DATA_VERSION = 1

/** Bounded schema-DDL retry. Matches the Phase 0C contract: at most `attempts`
 *  tries, only `SQLITE_BUSY` / "database is locked" is retried, every other
 *  error propagates immediately, and exhaustion yields `null` so the caller
 *  raises its own domain error. */
const SCHEMA_ATTEMPTS = 3
const SCHEMA_BACKOFF_MS = 25

function isBusyError(message: string): boolean {
  return /SQLITE_BUSY|database is locked/i.test(message)
}

function withBusyRetrySync<T>(fn: () => T, attempts = SCHEMA_ATTEMPTS): T | null {
  for (let i = 1; i <= attempts; i++) {
    try {
      return fn()
    } catch (e) {
      const message = (e as Error).message
      if (!isBusyError(message)) throw e
      if (i === attempts) return null
      sleepSync(SCHEMA_BACKOFF_MS * 2 ** (i - 1))
    }
  }
  return null
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

interface TaskRow {
  session_id: string
  task_id: string
  title: string
  status: string
  task_order: number
  parent_id: string | null
  depends_on_json: string | null
  blocked_reason: string | null
  verification_json: string | null
  evidence_json: string | null
  acceptance_json: string | null
  provenance_json: string | null
  created_at: string
  updated_at: string
  revision: number
  exec_generation: number
  attempt_generation: number | null
}

/**
 * [PHASE 6I] Execution lineage for one task, read through a dedicated accessor so
 * it never becomes part of the public `Task` shape.
 *
 * `execGeneration` is the CURRENT execution generation. It advances ONLY when
 * `claimTask` accepts a claim - never on a title, order, dependency, parent,
 * blockedReason, evidence, verification or status write. That invariance is the
 * whole point: it makes the lineage decision immune to arbitrary task mutation,
 * which is what 6G D1 proved revision could not be.
 *
 * `attemptGeneration` is the generation whose execution attempt reached its end,
 * or `null` when no attempt of the current generation has completed. It records
 * that an ATTEMPT ENDED - never that the task is correct or complete.
 *
 * It is NOT a task status, NOT a lock, NOT a lease, NOT a counter of attempts
 * and NOT a history: exactly one generation is retained, and evidence lives on
 * the task row so it cannot outlive the task.
 */
export interface ExecutionLineage {
  readonly execGeneration: number
  readonly attemptGeneration: number | null
}

/**
 * [PHASE 6P] Who owns the CURRENT in-flight state of a task.
 *
 * This is a FOURTH, separate fact. It is deliberately NOT folded into
 * `TaskStatus`, `ExecutionLineage`, or `Task`:
 *
 *   status             WHAT the task is (pending, in-flight, done, …)
 *   execution_owner    WHOSE in-flight state it is
 *   exec_generation    WHICH execution generation is current
 *   attempt_generation whether that generation's attempt reached its end
 *
 * WHY IT EXISTS (6N F1, proved in 6O §5.2). `IN_PROGRESS` is overloaded: it is
 * written both by `claimTask` (a Scheduler-owned execution) and by the
 * model-facing path (`todo_write` → `synchronizeCanonicalTasks` → `patchTask`,
 * where it is the agent's plan cursor — see `src/tools/todo.ts:15-19`).
 * Reconciliation used to read *every* `IN_PROGRESS`/`VERIFYING` without a
 * completion marker as stranded Scheduler work, so it reverted the user's cursor.
 *
 * The information needed to tell those apart DID NOT EXIST in the other columns.
 * Two histories are byte-identical under `(status, exec_generation,
 * attempt_generation)` and demand opposite actions:
 *
 *   H2  claim → crash                     → IN_PROGRESS/1/NULL → REVERT
 *   H5  claim → crash → reconcile → user
 *       marks IN_PROGRESS                 → IN_PROGRESS/1/NULL → LEAVE
 *
 * `exec_generation > 0` does not separate them (both are 1, and reconcile never
 * resets the counter), and `attempt_generation` is NULL in both. This column is
 * the missing fact: it records whether a reconcile already ended that claim.
 *
 * STATE MODEL — the only two values:
 *   'scheduler'  the current in-flight status was established by `claimTask` and
 *                has NOT been reconciled away. The Scheduler may recover it.
 *   null         no Scheduler execution owns this task. Either never claimed, or
 *                ownership was released (by a reconcile, or by any status write
 *                that leaves the Scheduler-owned in-flight states). The Scheduler
 *                must NOT touch it.
 *
 * TRANSITIONS (and only these):
 *   set   'scheduler'  by `claimTask`, in the SAME statement that advances
 *                      `exec_generation` and writes IN_PROGRESS — so ownership and
 *                      generation can never disagree.
 *   clear null         by `reconcileStranded` / `reconcileIfNoCompletedAttempt`
 *                      (reverting releases it), and by ANY other writer that
 *                      moves the task OUT of RECONCILABLE_STATUSES.
 *   keep  unchanged    by a status write that STAYS inside
 *                      RECONCILABLE_STATUSES, and by every non-status write
 *                      (title, order, dependency, evidence, …). A title edit does
 *                      not end a claim.
 *
 * WHY A WRITE THAT STAYS `IN_PROGRESS` KEEPS OWNERSHIP. A user writing
 * `IN_PROGRESS` onto a task whose claim is stranded does not end the stranded
 * execution; it only re-states the agent's plan cursor on top of it. The
 * Scheduler's generation is still dead, so the row is still recoverable (6O
 * history H3/H6). Releasing ownership there would strand the generation forever.
 * Ownership is released when the task LEAVES the in-flight states — which is
 * also exactly what a reconcile does.
 *
 * IT IS NOT: a lock, a lease, a heartbeat, a priority, a completion claim, a
 * verification, or evidence of anything. It grants no authority over the task
 * beyond "the Scheduler may revert this in-flight state", and it is never
 * consulted for readiness, identity, or dependency semantics.
 */
export type ExecutionOwner = "scheduler"

/** Result shape for `getExecutionOwnership`. `null` = no such task. */
export interface ExecutionOwnership {
  readonly executionOwner: ExecutionOwner | null
}

/**
 * [PHASE 6I] Outcome of `reconcileIfNoCompletedAttempt`.
 *
 * Distinct from the 6B `ReconcileOutcome` because the decision now also carries
 * lineage meaning: `RECONCILED` means "this execution generation has no recorded
 * completion, so it is stranded", whereas `NOT_STRANDED` means the current
 * generation DID record completion (or the row is not reconcilable at all).
 * `REFUSED_NO_OWNERSHIP` keeps 6B's fail-closed contract.
 */
export type LineageReconcileOutcome =
  | "RECONCILED"
  | "NOT_STRANDED"
  | "REJECTED_STALE"
  | "NOT_FOUND"
  | "REFUSED_NO_OWNERSHIP"

const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  task_order INTEGER NOT NULL,
  parent_id TEXT,
  depends_on_json TEXT,
  blocked_reason TEXT,
  verification_json TEXT,
  evidence_json TEXT,
  acceptance_json TEXT,
  provenance_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  exec_generation INTEGER NOT NULL DEFAULT 0,
  attempt_generation INTEGER,
  execution_owner TEXT,
  PRIMARY KEY (session_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_session_order ON tasks(session_id, task_order);
CREATE TABLE IF NOT EXISTS task_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/**
 * The DDL as INDIVIDUAL statements.
 *
 * [PHASE 1 FIX] The artifact passed the whole script to a single `db.exec()`.
 * Measured under a held write lock, that does not fail the way the code
 * assumed: bun runs the script past the blocked `CREATE TABLE` and the next
 * statement (`CREATE INDEX ... ON tasks`) then fails with
 * `no such table: main.tasks` — a NON-busy error. A retry keyed on
 * SQLITE_BUSY therefore never engaged, and the caller saw a misleading error
 * after the full 3s busy_timeout. Running one statement at a time means a lock
 * conflict surfaces as SQLITE_BUSY on the statement that actually needs the
 * lock, which is exactly what the retry can act on.
 */
const DDL_STATEMENTS: readonly string[] = DDL.split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)

/** Handle cache per path, as with `sessions.db`, so `initialize()` does not run
 *  the DDL on every operation. */
const handles = new Map<string, Database>()
const initialized = new Set<string>()

/** Depth of in-flight `withTransaction` calls, per db path.
 *
 *  Exists for two reasons:
 *   1. `close`/`resetTaskStoreHandles` must not yank the connection out from
 *      under an open transaction - that would leave a half-applied unit of work
 *      with no rollback path.
 *   2. It makes the transaction boundary observable, so a caller cannot open a
 *      transaction and then escape it by reaching for a different connection. */
const txDepth = new Map<string, number>()

function openTxPaths(): string[] {
  return [...txDepth.entries()].filter(([, d]) => d > 0).map(([p]) => p)
}

/** Throw if `p` currently has an open transaction. */
function assertNoOpenTx(p: string, what: string): void {
  if ((txDepth.get(p) ?? 0) > 0) {
    throw new TaskError(
      "TASK_TX_ACTIVE",
      `cannot ${what} while a TaskStore transaction is open for this database`,
    )
  }
}

function dbFile(cwd?: string): string {
  return resolveLocalDbPath(TASK_DB_FILENAME, cwd)
}

/**
 * [PHASE 6K] Bring an existing `tasks` table up to the current lineage schema.
 *
 * WHY THIS EXISTS (Phase 6J D3, HIGH): `CREATE TABLE IF NOT EXISTS tasks (...)`
 * is a NO-OP when the table already exists. SQLite does not add columns. So a
 * database created before Phase 6I never received `exec_generation` /
 * `attempt_generation`, and because `createTask` names them, task creation
 * failed outright on any pre-6I installation - on the LEGACY path, with the
 * Scheduler still disabled.
 *
 * WHY SCHEMA INTROSPECTION rather than only a version stamp: a version stamp
 * can lie (a 6F database may carry a stale or absent `data_version`), whereas
 * `PRAGMA table_info` reports what is actually there. The stamp is still
 * written so `dataVersion()` reflects reality, but the DECISION is made from
 * the schema.
 *
 * PROPERTIES, each load-bearing:
 *   - IDEMPOTENT: a column is added only when absent, so running twice is a
 *     no-op, and a partially migrated database converges.
 *   - NON-DESTRUCTIVE: no row is deleted, updated, or reordered. `ADD COLUMN`
 *     only appends.
 *   - COMPATIBLE WITH EXISTING ROWS: the defaults are exactly the 6H
 *     semantics for a row that predates lineage - `exec_generation = 0`
 *     ("never claimed") and `attempt_generation = NULL` ("never attempted").
 *     `revision`, `status`, `task_id` and every relationship are untouched.
 *   - NO INFERENCE: a pre-lineage row is NOT given a generation derived from
 *     its revision. 6H explicitly declined that, and it is what caused D1.
 *   - TRANSACTIONAL: both ALTERs run in one transaction, so an interruption
 *     leaves the table in its previous state rather than half-migrated.
 */
function migrateExecutionLineageSchema(db: Database): void {
  const present = new Set(
    (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((r) => r.name),
  )
  // No `tasks` table at all: the DDL above just created it with the columns.
  if (present.size === 0) return

  const needsExec = !present.has("exec_generation")
  const needsAttempt = !present.has("attempt_generation")
  if (!needsExec && !needsAttempt) return

  const run = db.transaction(() => {
    if (needsExec) {
      // NOT NULL with a non-null default is required by SQLite for ADD COLUMN,
      // and it backfills every existing row with 0 = "never claimed".
      db.exec("ALTER TABLE tasks ADD COLUMN exec_generation INTEGER NOT NULL DEFAULT 0")
    }
    if (needsAttempt) {
      // Deliberately nullable with NO default: existing rows read as NULL,
      // which is exactly 6H's "no attempt of the current generation".
      db.exec("ALTER TABLE tasks ADD COLUMN attempt_generation INTEGER")
    }
  })
  try {
    withBusyRetrySync(() => {
      run()
      return true
    })
  } catch (e) {
    throw new TaskError(
      "TASK_MIGRATION_FAILURE",
      `lineage migration failed: ${(e as Error).message}`,
    )
  }
  // Record the schema version so `dataVersion()` is no longer fiction.
  try {
    const cur = db.prepare("SELECT value FROM task_meta WHERE key = ?").get("data_version") as
      | { value: string }
      | null
      | undefined
    const n = cur ? Number(cur.value) : 0
    if (!Number.isFinite(n) || n < TASK_DATA_VERSION) {
      db.prepare(
        "INSERT INTO task_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run("data_version", String(TASK_DATA_VERSION))
    }
  } catch {
    // The version stamp is bookkeeping, not correctness. A failure to record it
    // must never prevent the store from opening.
  }
}

/**
 * [PHASE 6P] Add `execution_owner` to a database that predates it.
 *
 * Same decision procedure as `migrateExecutionLineageSchema` — decide from
 * `PRAGMA table_info`, never from a version stamp, because a stamp can lie and
 * the schema cannot. Kept as a SEPARATE function so the 6P change is
 * independently reviewable and independently idempotent, and so the older
 * function's documented properties are not silently redefined.
 *
 * PROPERTIES, each load-bearing:
 *   - IDEMPOTENT: added only when absent, so repeated opens are a no-op and a
 *     partially migrated database converges.
 *   - ADDITIVE / NON-DESTRUCTIVE: `ADD COLUMN` only. No row is updated, deleted,
 *     reordered or rewritten. Same guarantee as the 6I migration.
 *   - COMPATIBLE WITH EXISTING ROWS: nullable with no default, so every existing
 *     row reads back as `NULL` = "no Scheduler execution owns this task".
 *   - TRANSACTIONAL: the ALTER runs in one transaction, so an interruption leaves
 *     the table as it was rather than half-migrated.
 *
 * NO BACKFILL — DELIBERATE, and it is the important decision here.
 *
 * It is tempting to backfill `'scheduler'` onto every pre-6P row that looks like a
 * stranded claim (`status IN (IN_PROGRESS, VERIFYING) AND exec_generation > 0`).
 * That would be a GUESS, and it is provably wrong in one direction and
 * un-recoverable in the other:
 *
 *   - A pre-6P row can ALSO be history H5: claim → crash → 6B `reconcileStranded`
 *     (status → PENDING) → a user turn marks IN_PROGRESS. That is the same
 *     `(IN_PROGRESS, exec>0, att NULL)` shape, and backfilling would mark
 *     interactive work as Scheduler-owned and revert it — reintroducing 6N F1
 *     on upgraded databases.
 *   - Not backfilling leaves a pre-6P genuinely stranded claim unrecovered. Its
 *     row stays IN_PROGRESS, which is not-eligible, so its dependents stay
 *     unready. This is an availability cost, and it is a MANUAL/OPERATOR cost,
 *     not a correctness one: no execution is corrupted, nothing is lost.
 *
 * The ambiguity in legacy rows is IRREDUCIBLE — the fact was never recorded, and
 * 6I's "NO INFERENCE" rule (a pre-lineage row is not given a generation derived
 * from its revision) forbids manufacturing it. Inventing ownership would be the
 * same error one column over. So: additive only, no inference, and the
 * behaviour change is stated rather than hidden.
 */
function migrateExecutionOwnershipSchema(db: Database): void {
  const present = new Set(
    (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((r) => r.name),
  )
  // No `tasks` table at all: the DDL above just created it with the column.
  if (present.size === 0) return
  if (present.has("execution_owner")) return

  try {
    withBusyRetrySync(() => {
      // Nullable with NO default: existing rows read as NULL, which is exactly
      // "no Scheduler execution owns this task" - the safe direction, because it
      // forbids reconciliation rather than permitting it.
      db.exec("ALTER TABLE tasks ADD COLUMN execution_owner TEXT")
      return true
    })
  } catch (e) {
    throw new TaskError(
      "TASK_MIGRATION_FAILURE",
      `execution-ownership migration failed: ${(e as Error).message}`,
    )
  }
}

function handle(cwd?: string): Database {
  const p = dbFile(cwd)
  const existing = handles.get(p)
  if (existing) return existing
  let db: Database
  try {
    db = new Database(p)
  } catch (e) {
    throw new TaskError("TASK_DB_INIT_FAILURE", `cannot open ${p}: ${(e as Error).message}`)
  }
  try {
    // Same pragma order as `persistence.ts`: busy_timeout FIRST, before any
    // statement that needs a lock.
    db.exec(`PRAGMA busy_timeout=${LIMITS.SQLITE_BUSY_TIMEOUT_MS}`)
  } catch {}
  if (!initialized.has(p)) {
    try {
      db.exec(
        `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${LIMITS.SQLITE_BUSY_TIMEOUT_MS}; PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=${LIMITS.SQLITE_WAL_SIZE_LIMIT_BYTES}; PRAGMA wal_autocheckpoint=${LIMITS.SQLITE_WAL_AUTOCHECKPOINT_PAGES};`,
      )
    } catch (e) {
      process.stderr.write(
        `[warn] taskstore: wal setup deferred, retry next open: ${(e as Error).message}\n`,
      )
    }
    try {
      const { chmodSync } = require("node:fs") as typeof import("node:fs")
      chmodSync(p, 0o600)
    } catch {}
  }
  // D2: the artifact ran this bare and could therefore throw SQLITE_BUSY before
  // any retry. Bounded retry now. On failure the handle is closed and dropped
  // from the cache, exactly as the artifact did, so the next call retries from a
  // clean state instead of handing out a half-built connection.
  try {
    for (const stmt of DDL_STATEMENTS) {
      const ok = withBusyRetrySync(() => {
        db.exec(stmt)
        return true
      })
      if (ok === null) throw new Error(`schema init did not complete: ${stmt.slice(0, 40)}`)
    }
    // [PHASE 6K] `CREATE TABLE IF NOT EXISTS` cannot add a column to an
    // existing table, so a database created before 6I never receives the
    // execution-lineage columns and every statement naming them fails. The
    // migration runs here, on the same open path, immediately after the DDL.
    migrateExecutionLineageSchema(db)
    // [PHASE 6P] Same open path, immediately after, so a database that already
    // has the lineage columns but predates 6P still receives `execution_owner`.
    migrateExecutionOwnershipSchema(db)
    initialized.add(p)
  } catch (e) {
    try {
      db.close()
    } catch {}
    handles.delete(p)
    throw new TaskError("TASK_DB_INIT_FAILURE", `schema init failed: ${(e as Error).message}`)
  }
  handles.set(p, db)
  return db
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    const v = JSON.parse(raw) as T
    return v ?? fallback
  } catch {
    // A corrupt column must NOT drop the whole task. Fall back to a neutral
    // shape and the task still reads as present.
    return fallback
  }
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.task_id,
    sessionId: r.session_id,
    title: r.title,
    status: (isTaskStatus(r.status) ? r.status : "PENDING") as TaskStatus,
    order: r.task_order,
    parentId: r.parent_id,
    dependsOn: parseJson<string[]>(r.depends_on_json, []),
    blockedReason: r.blocked_reason,
    verification: parseJson<TaskVerification | null>(r.verification_json, null),
    evidence: parseJson<TaskEvidence[]>(r.evidence_json, []),
    acceptance: parseJson<TaskAcceptance | null>(r.acceptance_json, null),
    provenance: parseJson<TaskProvenance>(r.provenance_json, {
      origin: "runtime",
      source: "unknown",
    }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revision: r.revision,
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function j(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value)
}

/** Shape that may arrive from the model/caller. Task ids are already validated
 *  by the allocator; this struct is never stored as-is. */
export interface NewTaskInput {
  title: string
  status: TaskStatus
  order: number
  parentId?: string | null
  dependsOn?: string[]
  blockedReason?: string | null
  verification?: TaskVerification | null
  evidence?: TaskEvidence[]
  acceptance?: TaskAcceptance | null
  provenance: TaskProvenance
}

export interface TaskPatch {
  title?: string
  status?: TaskStatus
  /** Display position. Unlike `id`, `order` may change at any time and `id`
   *  never does. */
  order?: number
  parentId?: string | null
  dependsOn?: string[]
  blockedReason?: string | null
  verification?: TaskVerification | null
  evidence?: TaskEvidence[]
  acceptance?: TaskAcceptance | null
}

export interface UpsertOptions {
  /** Evidence used by the completion gate. Default `unverified` so a TaskStore
   *  called without DI cannot silently refuse `completed`.
   *  [PHASE 1] inert: the only reader was the deferred `synchronizeTasks`. */
  evidence?: CompletionEvidence
  /** Revision that MUST match (optimistic). `undefined` = no check.
   *
   *  PHASE 6B NOTE: this is a READ-THEN-WRITE check performed OUTSIDE the write
   *  transaction (see `patchTask`). It catches sequential staleness only and is
   *  NOT a compare-and-swap. Code that needs real mutual exclusion must use
   *  `claimTask`, whose revision predicate lives inside the SQL mutation. */
  expectedRevision?: number
}

/**
 * PHASE 6B: authority mode.
 *
 * `LEGACY` (the default, and the only mode in production today) preserves the
 * historical behaviour where any writer may author `IN_PROGRESS`.
 *
 * `SCHEDULER` closes that door: `IN_PROGRESS` may then be authored ONLY by
 * `claimTask`. Model-facing `todo_write` therefore fails closed with
 * `TASK_AUTHORITY_VIOLATION` instead of creating a claim.
 *
 * Activation is explicit and per-instance. There is no environment variable, no
 * module-level flag, and no automatic activation on `initialize()`.
 */
export type TaskAuthorityMode = "LEGACY" | "SCHEDULER"

export interface TaskStoreOptions {
  /**
   * PHASE 6B. Defaults to `"LEGACY"`. Must be opted into by a composition root.
   * Tests must assert that no production path sets this.
   */
  authority?: TaskAuthorityMode
}

/**
 * Render a status allow-list as a SQL literal list.
 *
 * The values are module-private compile-time constants (`TaskStatus` members),
 * never caller input, so this needs no escaping. It exists so the claim and
 * reconcile predicates read as one auditable statement each, instead of string
 * concatenation repeated per call site.
 */
function sqlList(statuses: readonly TaskStatus[]): string {
  return statuses.map((s) => `'${s}'`).join(", ")
}

/**
 * PHASE 6B: the only status a claim may transition from.
 *
 * `COMPLETED`, `CANCELLED` and `FAILED` are irreversible and are therefore not
 * claimable — which is what stops a claim from resurrecting finished or
 * abandoned work. `IN_PROGRESS` and `VERIFYING` are excluded because a second
 * claim of in-flight work is exactly the double-claim the primitive prevents.
 */
const CLAIMABLE_STATUSES: readonly TaskStatus[] = ["PENDING"]

/**
 * PHASE 6B: the only statuses reconciliation may revert.
 *
 * `IN_PROGRESS` and `VERIFYING` assert in-flight activity with no durable proof
 * of liveness. `COMPLETED` / `CANCELLED` / `FAILED` are irreversible facts and
 * are never targets. `PAUSED` does not exist in `TaskStatus` and is never
 * introduced here.
 */
const RECONCILABLE_STATUSES: readonly TaskStatus[] = ["IN_PROGRESS", "VERIFYING"]

export class TaskStore {
  readonly cwd: string

  /**
   * PHASE 6B. Defaults to `"LEGACY"`, so every existing construction site keeps
   * its exact current behaviour. Per-instance, never a module singleton.
   */
  readonly authorityMode: TaskAuthorityMode

  constructor(cwd?: string, opts: TaskStoreOptions = {}) {
    this.cwd = cwd ?? process.cwd()
    this.authorityMode = opts.authority ?? "LEGACY"
  }

  /** Prepare the schema. Idempotent; safe to call repeatedly. */
  initialize(): void {
    handle(this.cwd)
  }

  // ── read ──────────────────────────────────────────────────────────────────

  getTask(sessionId: string, taskId: string): Task | null {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    const db = handle(this.cwd)
    const row = db
      .prepare("SELECT * FROM tasks WHERE session_id = ? AND task_id = ?")
      .get(sessionId, taskId) as TaskRow | null
    return row ? rowToTask(row) : null
  }

  listTasks(sessionId: string): Task[] {
    const db = handle(this.cwd)
    const rows = db
      .prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY task_order, task_id")
      .all(sessionId) as TaskRow[]
    return rows.map(rowToTask)
  }

  getSnapshot(sessionId: string): TaskSnapshot {
    return { sessionId, tasks: this.listTasks(sessionId) }
  }

  /** The next id that is DEFINITELY unused. Uses `max`, not `count`, so that
   *  `t1,t2,t5` yields `t6` — not a `t3` that would collide. */
  nextId(sessionId: string): string {
    const tasks = this.listTasks(sessionId)
    let max = 0
    for (const t of tasks) {
      const n = Number(t.id.slice(1))
      if (Number.isFinite(n) && n > max) max = n
    }
    return taskIdFromIndex(max)
  }

  // ── validation ────────────────────────────────────────────────────────────

  /**
   * Validate blocker/verification/dependency BEFORE persisting.
   *
   * Rules enforced:
   *  - `BLOCKED` requires a `blockedReason` (PF-04, second rail — the first is
   *    already in `normalizeTodos`).
   *  - `dependsOn` may only contain canonical ids that EXIST in this session, may
   *    not point at itself, and may not duplicate.
   *  - `COMPLETED` is never rejected here. The "completed needs evidence" gate
   *    runs in `normalizeTodos` (red evidence -> BLOCKED), and duplicating that
   *    logic in a second place is precisely what the brief forbids.
   */
  private validate(sessionId: string, input: NewTaskInput, selfId: string): void {
    if (input.status === "BLOCKED" && !input.blockedReason?.trim()) {
      throw new TaskError("TASK_INVALID_TRANSITION", "BLOCKED requires blockedReason")
    }
    const deps = input.dependsOn ?? []
    if (deps.length > MAX_DEPENDS_ON) {
      throw new TaskError("TASK_INVALID_DEPENDENCY", `dependsOn exceeds ${MAX_DEPENDS_ON}`)
    }
    const seen = new Set<string>()
    for (const d of deps) {
      if (!isTaskId(d)) throw new TaskError("TASK_INVALID_DEPENDENCY", `bad id: ${d}`)
      if (d === selfId) {
        throw new TaskError("TASK_INVALID_DEPENDENCY", "task cannot depend on itself")
      }
      if (seen.has(d)) throw new TaskError("TASK_INVALID_DEPENDENCY", `duplicate dependency: ${d}`)
      seen.add(d)
      const exists = this.getTask(sessionId, d)
      if (!exists) {
        throw new TaskError("TASK_INVALID_DEPENDENCY", `unknown dependency: ${d}`)
      }
    }
    if (input.parentId != null) {
      if (!isTaskId(input.parentId)) {
        throw new TaskError("TASK_INVALID_DEPENDENCY", `bad parentId: ${input.parentId}`)
      }
      if (input.parentId === selfId) {
        throw new TaskError("TASK_INVALID_DEPENDENCY", "task cannot be its own parent")
      }
    }
  }

  // ── write ─────────────────────────────────────────────────────────────────

  createTask(sessionId: string, input: NewTaskInput): Task {
    // PHASE 6B authority guard. Creating a task directly in `IN_PROGRESS` is an
    // authoritative claim just as much as patching one into that status, so the
    // guard must cover creation as well. LEGACY is untouched.
    if (this.authorityMode === "SCHEDULER" && input.status === "IN_PROGRESS") {
      throw new TaskError(
        "TASK_AUTHORITY_VIOLATION",
        `IN_PROGRESS may only be authored by claimTask while Scheduler authority is active (${sessionId})`,
      )
    }
    const db = handle(this.cwd)
    const id = this.nextId(sessionId)
    return db.transaction(() => {
      // `nextId` is recomputed INSIDE the transaction so two concurrent writers
      // cannot be handed the same id.
      const chosen = db
        .prepare("SELECT 1 FROM tasks WHERE session_id = ? AND task_id = ?")
        .get(sessionId, id)
        ? (() => {
            let max = 0
            for (const t of this.listTasks(sessionId)) {
              const n = Number(t.id.slice(1))
              if (Number.isFinite(n) && n > max) max = n
            }
            return taskIdFromIndex(max)
          })()
        : id
      this.validate(sessionId, input, chosen)
      const ts = nowIso()
      try {
        db.prepare(
          `INSERT INTO tasks (session_id, task_id, title, status, task_order, parent_id, depends_on_json, blocked_reason, verification_json, evidence_json, acceptance_json, provenance_json, created_at, updated_at, revision, exec_generation, attempt_generation)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL)`,
        ).run(
          sessionId,
          chosen,
          input.title,
          input.status,
          input.order,
          input.parentId ?? null,
          j(input.dependsOn ?? []),
          input.blockedReason ?? null,
          j(input.verification ?? null),
          j((input.evidence ?? []).slice(0, MAX_EVIDENCE)),
          j(input.acceptance ?? null),
          j(input.provenance),
          ts,
          ts,
        )
      } catch (e) {
        throw new TaskError("TASK_PERSISTENCE_FAILURE", (e as Error).message)
      }
      return this.getTask(sessionId, chosen)!
    })()
  }

  /**
   * Apply a patch to one task. Optimistic: if `expectedRevision` is supplied and
   * does not match, the mutation is REFUSED and the revision does not advance.
   *
   * This is the Phase 1 revision substrate. It deliberately contains no
   * scheduler claim/CAS logic — a later phase may add that on top, but the
   * substrate itself is what makes such a check possible at all.
   *
   * PHASE 6B: `expectedRevision` is a READ-THEN-WRITE check performed OUTSIDE
   * the write transaction, and the UPDATE carries no `AND revision = ?`
   * predicate. It therefore detects sequential staleness but is NOT a
   * compare-and-swap; two concurrent writers can both pass it. Use
   * `claimTask` when mutual exclusion is required.
   *
   * PHASE 6B authority guard: when `authorityMode === "SCHEDULER"`, a patch may
   * not author `IN_PROGRESS` — only `claimTask` may. This is the fail-closed
   * door that stops model-facing `todo_write` from creating a claim.
   */
  patchTask(sessionId: string, taskId: string, patch: TaskPatch, opts: UpsertOptions = {}): Task {
    if (this.authorityMode === "SCHEDULER" && patch.status === "IN_PROGRESS") {
      throw new TaskError(
        "TASK_AUTHORITY_VIOLATION",
        `IN_PROGRESS may only be authored by claimTask while Scheduler authority is active (${sessionId}/${taskId})`,
      )
    }
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    const db = handle(this.cwd)
    const current = this.getTask(sessionId, taskId)
    if (!current) throw new TaskError("TASK_NOT_FOUND", `no task ${taskId} in ${sessionId}`)
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== current.revision) {
      throw new TaskError(
        "TASK_STALE_REVISION",
        `${taskId} is at revision ${current.revision}, got ${opts.expectedRevision}`,
      )
    }
    const next: NewTaskInput = {
      title: patch.title ?? current.title,
      status: patch.status ?? current.status,
      order: patch.order ?? current.order,
      parentId: patch.parentId === undefined ? current.parentId : patch.parentId,
      dependsOn: patch.dependsOn ?? current.dependsOn,
      blockedReason:
        patch.blockedReason === undefined ? current.blockedReason : patch.blockedReason,
      verification: patch.verification === undefined ? current.verification : patch.verification,
      evidence: patch.evidence ?? current.evidence,
      acceptance: patch.acceptance === undefined ? current.acceptance : patch.acceptance,
      provenance: current.provenance,
    }
    // [PHASE 6P] EXECUTION OWNERSHIP IS RELEASED ONLY WHEN THE TASK LEAVES THE
    // SCHEDULER-OWNED IN-FLIGHT STATES.
    //
    // `patchTask` is every non-claim status writer: the model-facing
    // `synchronizeCanonicalTasks` path and any operator edit. Two rules, and the
    // difference between them is the whole point of the 6O history table:
    //
    //   status STAYS inside RECONCILABLE_STATUSES -> ownership is KEPT.
    //     A user writing IN_PROGRESS is the agent's plan cursor (todo.ts:15-19)
    //     laid on top of a live claim. It does not end the stranded execution
    //     (6O H3/H6), and only a legitimate authority may end a Scheduler
    //     execution. Releasing here would strand the generation forever.
    //
    //   status LEAVES RECONCILABLE_STATUSES       -> ownership is CLEARED.
    //     The row is no longer a Scheduler execution in flight, so leaving
    //     `scheduler` on it would be STALE ownership that a later reconcile
    //     could still match. This is what stops an interactive completion,
    //     failure, cancellation, block or requeue from being reverted later.
    //
    // Non-status writes (title, order, dependsOn, evidence, …) never touch the
    // column: editing a title must not end an execution claim.
    //
    // The release is computed in SQL (a CASE over the RESULTING status) so it
    // stays inside the write transaction and needs no extra read - a read here
    // would be a read-then-write outside the mutation, which is exactly the
    // hazard `expectedRevision` is documented not to be.
    return db.transaction(() => {
      this.validate(sessionId, next, taskId)
      try {
        db.prepare(
          `UPDATE tasks SET title = ?, status = ?, task_order = ?, parent_id = ?, depends_on_json = ?, blocked_reason = ?,
            verification_json = ?, evidence_json = ?, acceptance_json = ?, updated_at = ?, revision = revision + 1,
            execution_owner = CASE WHEN ? IN (${sqlList(RECONCILABLE_STATUSES)}) THEN execution_owner ELSE NULL END
           WHERE session_id = ? AND task_id = ?`,
        ).run(
          next.title,
          next.status,
          next.order,
          next.parentId ?? null,
          j(next.dependsOn ?? []),
          next.blockedReason ?? null,
          j(next.verification ?? null),
          j((next.evidence ?? []).slice(0, MAX_EVIDENCE)),
          j(next.acceptance ?? null),
          nowIso(),
          next.status,
          sessionId,
          taskId,
        )
      } catch (e) {
        throw new TaskError("TASK_PERSISTENCE_FAILURE", (e as Error).message)
      }
      return this.getTask(sessionId, taskId)!
    })()
  }
  /** Readable alias for the layer above. */
  updateTask(sessionId: string, taskId: string, patch: TaskPatch, opts: UpsertOptions = {}): Task {
    return this.patchTask(sessionId, taskId, patch, opts)
  }

  // ── PHASE 6B: scheduler substrate ──────────────────────────────────────────
  //
  // P1 (claim) and P3 (reconciliation) live here, inside the TaskStore
  // persistence boundary, for one reason: both need the revision predicate to be
  // part of the SQL mutation itself. Emulating either with
  // read -> compare in application code -> write without the predicate is
  // explicitly NOT a compare-and-swap and is not done.
  //
  // Neither primitive accepts a `TaskGraph`, a plan revision, a presentation
  // revision, or a timestamp as currency. The only currency is the per-task
  // `revision` column.

  /**
   * P1: atomically claim one task for execution.
   *
   * The revision predicate and the claimable-status predicate are INSIDE the
   * single UPDATE statement, so SQLite decides the winner. This is the property
   * `patchTask`'s `expectedRevision` lacks.
   *
   * Claim contract (6A S4/S7): durable, revision-advancing, atomic, TaskStore
   * adjudicated, valid only from `CLAIMABLE_STATUSES`, never silently retried,
   * and never based on `TaskGraph.sourceMaxRevision`.
   *
   * A zero-rows-affected result is disambiguated with a follow-up READ so the
   * caller learns *which* precondition failed. That read is classification only
   * — it cannot turn a lost race into a win, because the mutation already
   * happened and already failed.
   */
  claimTask(
    sessionId: string,
    taskId: string,
    expectedRevision: number,
  ): { outcome: ClaimOutcome; task: Task | null; execGeneration: number } {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    const db = handle(this.cwd)
    const statuses = sqlList(CLAIMABLE_STATUSES)

    // THE revision predicate lives here, in SQL. One statement = one atomic
    // decision; there is no read-then-write window.
    //
    // [PHASE 6I] The execution generation is created by the SAME statement that
    // accepts the claim, so the two can never disagree and a rejected claim
    // cannot advance it. It is the only place in the entire store that
    // increments `exec_generation` - see the invariant at the column DDL.
    //
    // [PHASE 6P] `execution_owner = 'scheduler'` is set by that same statement,
    // for the same reason. The three facts that define a Scheduler execution -
    // accepted revision, new generation, durable ownership - are therefore
    // ATOMIC. There is no interleaving in which the row says "generation N
    // exists" while ownership still says "interactive/unknown", or vice versa,
    // and a rejected claim writes none of the three.
    const result = db
      .prepare(
        `UPDATE tasks
            SET status = 'IN_PROGRESS', updated_at = ?, revision = revision + 1,
                exec_generation = exec_generation + 1,
                execution_owner = 'scheduler'
          WHERE session_id = ? AND task_id = ? AND revision = ? AND status IN (${statuses})`,
      )
      .run(nowIso(), sessionId, taskId, expectedRevision)

    if (result.changes === 1) {
      const lineage = this.getExecutionLineage(sessionId, taskId)
      return {
        outcome: "CLAIM_ACCEPTED",
        task: this.getTask(sessionId, taskId),
        execGeneration: lineage?.execGeneration ?? 0,
      }
    }

    // Lost the race, or never was claimable. Classify for the caller. A rejected
    // claim creates NO generation: execGeneration reports the unchanged current
    // value so a caller can never mistake a rejection for a claim.
    const current = this.getTask(sessionId, taskId)
    if (current === null) {
      return { outcome: "NOT_FOUND", task: null, execGeneration: 0 }
    }
    const lineage = this.getExecutionLineage(sessionId, taskId)
    const execGeneration = lineage?.execGeneration ?? 0
    if (current.revision !== expectedRevision) {
      return { outcome: "CLAIM_REJECTED_STALE", task: current, execGeneration }
    }
    return { outcome: "WRONG_STATE", task: current, execGeneration }
  }

  /**
   * P3: revert ONE stranded in-flight task, revision-safely.
   *
   * Deliberately single-task rather than bulk: a bulk revert cannot be made
   * atomic across rows, so a per-row revision predicate is the only way to
   * guarantee a newer writer is never clobbered (6B S-race case A/C).
   *
   * The caller MUST hold session ownership (see `task/session-ownership.ts`).
   * When `ownsSession` is false this returns `REFUSED_NO_OWNERSHIP` and mutates
   * nothing — reconciliation fails closed rather than guessing.
   *
   * Never deletes. Never touches `parentId` / `dependsOn` / `order`. Never
   * manufactures `verification` or `evidence`. Never reads a graph. Never
   * inspects message history or presentation events.
   */
  reconcileStranded(
    sessionId: string,
    taskId: string,
    expectedRevision: number,
    opts: { ownsSession: boolean },
  ): { outcome: ReconcileOutcome; task: Task | null } {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    if (!opts.ownsSession) {
      // Fail closed. Uncertainty about ownership is not permission to act.
      return { outcome: "REFUSED_NO_OWNERSHIP", task: null }
    }
    const db = handle(this.cwd)
    const statuses = sqlList(RECONCILABLE_STATUSES)

    // Sets status AND clears blockedReason is deliberately NOT done: a stranded
    // task's blockedReason is not the property being reconciled, and rewriting
    // it would destroy information the operator may need.
    // [PHASE 6P] Same contract as `reconcileIfNoCompletedAttempt` for ownership:
    // only durably Scheduler-owned in-flight state may be reverted, and
    // reverting releases ownership. This is the path `Scheduler.releaseClaim`
    // uses for a claim whose dispatch never established, so requiring ownership
    // here also stops this method from reverting a task whose claim has already
    // been released or was never ours.
    const result = db
      .prepare(
        `UPDATE tasks
            SET status = 'PENDING', updated_at = ?, revision = revision + 1,
                execution_owner = NULL
          WHERE session_id = ? AND task_id = ? AND revision = ? AND status IN (${statuses})
            AND execution_owner = 'scheduler' AND exec_generation > 0`,
      )
      .run(nowIso(), sessionId, taskId, expectedRevision)

    if (result.changes === 1) {
      return { outcome: "RECONCILED", task: this.getTask(sessionId, taskId) }
    }

    const current = this.getTask(sessionId, taskId)
    if (current === null) return { outcome: "NOT_FOUND", task: null }
    if (current.revision !== expectedRevision) {
      // Someone else moved it. Do not overwrite newer state.
      return { outcome: "REJECTED_STALE", task: current }
    }
    return { outcome: "NOT_STRANDED", task: current }
  }

  /**
   * [PHASE 6I] Read the execution lineage of one task.
   *
   * Deliberately NOT part of the public `Task` shape: execution provenance is
   * not task state, and exposing it on `Task` would let it leak into TaskGraph,
   * readiness and presentation. It is reachable only through these accessors.
   *
   * Returns `null` for a task that does not exist. `attemptGeneration === null`
   * means "no attempt of the current generation has completed" - a meaningful
   * value, not an error.
   */
  getExecutionLineage(sessionId: string, taskId: string): ExecutionLineage | null {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    const db = handle(this.cwd)
    const row = db
      .prepare(
        `SELECT exec_generation, attempt_generation FROM tasks WHERE session_id = ? AND task_id = ?`,
      )
      .get(sessionId, taskId) as
      | { exec_generation: number; attempt_generation: number | null }
      | null
      | undefined
    if (row === null || row === undefined) return null
    return { execGeneration: row.exec_generation, attemptGeneration: row.attempt_generation }
  }

  /**
   * [PHASE 6P] Read EXECUTION OWNERSHIP for one task.
   *
   * Deliberately a SEPARATE accessor from `getExecutionLineage`, so the four
   * facts stay four facts: task state, execution ownership, execution generation,
   * attempt generation. Folding ownership into the lineage object would invite
   * exactly the collapse 6O rejected.
   *
   * Returns `null` for a task that does not exist (same convention as
   * `getExecutionLineage`). `executionOwner === null` on an existing task is a
   * MEANINGFUL value - "no Scheduler execution owns this task" - not an error.
   *
   * Reachable only here: ownership is execution state and must not leak into
   * `Task`, TaskGraph, readiness or presentation.
   */
  getExecutionOwnership(sessionId: string, taskId: string): ExecutionOwnership | null {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    const db = handle(this.cwd)
    const row = db
      .prepare(`SELECT execution_owner FROM tasks WHERE session_id = ? AND task_id = ?`)
      .get(sessionId, taskId) as { execution_owner: ExecutionOwner | null } | null | undefined
    if (row === null || row === undefined) return null
    return { executionOwner: row.execution_owner }
  }

  /**
   * [PHASE 6I] Record that the execution attempt for one generation ended.
   *
   * This is the ONE durable fact the lineage design adds. It answers exactly one
   * question: "did the attempt for generation `execGeneration` reach its end?" It
   * is deliberately NOT:
   *
   *   - a task status. `IN_PROGRESS` stays `IN_PROGRESS`; a returned turn is not
   *     a verdict. EXECUTION != VERIFICATION != COMPLETION.
   *   - a completion claim, a lock, a lease, a heartbeat, a retry counter, or an
   *     attempt history. One generation is retained per task and nothing here
   *     expires on a clock.
   *   - a revision. `execGeneration` comes from the claim that ran, never from
   *     the task's current revision - that conflation is 6G defect D1.
   *
   * The write is GUARDED on `exec_generation = ?`. If the generation moved while
   * the attempt was in flight the record would be misleading, so it is refused
   * rather than written.
   *
   * The task's durable status is NOT touched, and no other column is written.
   */
  recordAttemptReturned(sessionId: string, taskId: string, execGeneration: number): void {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    if (!Number.isSafeInteger(execGeneration) || execGeneration < 1) {
      throw new TaskError(
        "TASK_INVALID_ID",
        `execution generation must be a positive integer: ${execGeneration}`,
      )
    }
    const db = handle(this.cwd)
    let changes = 0
    try {
      changes = db
        .prepare(
          `UPDATE tasks
              SET attempt_generation = ?
            WHERE session_id = ? AND task_id = ? AND exec_generation = ?`,
        )
        .run(execGeneration, sessionId, taskId, execGeneration).changes
    } catch (e) {
      // Evidence that cannot be persisted is NOT a returned attempt. Never
      // swallow: converting this into "execution succeeded" would turn the crash
      // window into a silent permanent strand.
      throw new TaskError("TASK_PERSISTENCE_FAILURE", (e as Error).message)
    }
    if (changes !== 1) {
      // The generation moved under us. Recording it now would attribute an
      // outcome to the wrong generation, which is worse than recording nothing.
      throw new TaskError(
        "TASK_PERSISTENCE_FAILURE",
        `execution generation ${execGeneration} is no longer current for ${sessionId}/${taskId}; refusing to record a stale completion`,
      )
    }
  }

  /**
   * [PHASE 6I] Revert a stranded in-flight task, deciding strandedness by
   * EXECUTION LINEAGE rather than by revision.
   *
   * This replaces the 6F `reconcileStranded`-after-marker-read sequence. The
   * lineage predicate and the revert are ONE statement, so there is no
   * read-then-write window: a concurrent completion record cannot slip between
   * the decision and the mutation. That property was 6B's and 6G re-confirmed it
   * must not be regressed.
   *
   * The rule, exactly as 6H specified it:
   *
   *   attempt_generation IS NULL            -> STRANDED  (never completed)
   *   attempt_generation <  exec_generation -> STRANDED  (a later generation
   *                                               superseded an earlier one; the
   *                                               current one has no record)
   *   attempt_generation =  exec_generation -> not stranded
   *   attempt_generation >  exec_generation -> impossible -> THROW
   *
   * The `IS NULL` disjunct is explicit rather than a comparison because
   * `NULL < 0` is NULL, not true: a LEGACY-created `IN_PROGRESS` row that was
   * never claimed (`exec_generation = 0`, no attempt) must be reconciled.
   *
   * The relation is STRICTLY `<`, and that strictness is load-bearing twice over.
   * `<>` would wrongly match the impossible `attempt > exec` and silently revert
   * a row on corrupt data; `<` excludes it, so the row is left alone, `changes`
   * is 0, and the classification below raises instead of guessing. `<=` would be
   * worse still: it would match `attempt = exec`, i.e. a COMPLETED generation,
   * and reintroduce the 6D livelock in lineage form.
   *
   * Because `exec_generation` advances ONLY on an accepted claim, NO ordinary
   * mutation - title, order, dependency, parent, blockedReason, evidence,
   * verification, or status - can change the outcome of this rule. That is the
   * structural end of 6G D1.
   *
   * The caller MUST hold session ownership; without it this refuses and mutates
   * nothing (6B, unchanged). Never deletes. Never writes lineage. Never
   * manufactures verification or evidence. Never reads a graph.
   */
  reconcileIfNoCompletedAttempt(
    sessionId: string,
    taskId: string,
    expectedRevision: number,
    opts: { ownsSession: boolean },
  ): { outcome: LineageReconcileOutcome; task: Task | null } {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    if (!opts.ownsSession) {
      // Fail closed. Uncertainty about ownership is not permission to act.
      return { outcome: "REFUSED_NO_OWNERSHIP", task: null }
    }
    const db = handle(this.cwd)
    const statuses = sqlList(RECONCILABLE_STATUSES)

    // [PHASE 6P] `execution_owner = 'scheduler'` is a REQUIRED condition, and
    // `exec_generation > 0` is retained beside it as a co-condition.
    //
    // The owner condition is what makes 6N F1 impossible: a task the model marked
    // IN_PROGRESS without a claim is not Scheduler execution state, so it is
    // never reverted (6O H1). The exec condition is redundant while the column
    // exists - only `claimTask` sets ownership, and it always advances the
    // generation in the same statement - and is kept deliberately as a cheap
    // invariant: if a future writer ever sets ownership without a generation, this
    // still refuses rather than reverting.
    //
    // Reverting RELEASES ownership in the same statement, which is what makes
    // 6O H5 work: after this runs, the row is interactive state, and a later
    // user IN_PROGRESS write must survive the next reconcile.
    const result = db
      .prepare(
        `UPDATE tasks
            SET status = 'PENDING', updated_at = ?, revision = revision + 1,
                execution_owner = NULL
          WHERE session_id = ? AND task_id = ? AND revision = ? AND status IN (${statuses})
            AND execution_owner = 'scheduler' AND exec_generation > 0
            AND (attempt_generation IS NULL OR attempt_generation < exec_generation)`,
      )
      .run(nowIso(), sessionId, taskId, expectedRevision)

    if (result.changes === 1) {
      return { outcome: "RECONCILED", task: this.getTask(sessionId, taskId) }
    }

    // Zero changes: the lineage predicate said "not stranded", or the row moved
    // under us, or it is gone. One read classifies, exactly as 6B did.
    const current = this.getTask(sessionId, taskId)
    if (current === null) return { outcome: "NOT_FOUND", task: null }
    if (current.revision !== expectedRevision) {
      // Someone else moved it. Do not overwrite newer state.
      return { outcome: "REJECTED_STALE", task: current }
    }
    const lineage = this.getExecutionLineage(sessionId, taskId)
    if (lineage !== null && lineage.attemptGeneration !== null) {
      if (lineage.attemptGeneration > lineage.execGeneration) {
        // The recorded attempt names a generation NEWER than the current one.
        // No legitimate sequence produces this. Do not guess which side is wrong:
        // guessing either strands live work or re-runs finished work.
        throw new TaskError(
          "TASK_PERSISTENCE_FAILURE",
          `attempt generation ${lineage.attemptGeneration} exceeds execution generation ${lineage.execGeneration} for ${sessionId}/${taskId}`,
        )
      }
      return { outcome: "NOT_STRANDED", task: current }
    }
    // In flight with no completion record, yet the update matched nothing: the
    // row is not in a reconcilable status. Leave it alone.
    return { outcome: "NOT_STRANDED", task: current }
  }

  /**
   * Delete one task. Used ONLY by compatibility: `deleteSession`.
   *
   * The model has no way to delete in Phase 1 (D7: explicit deletion is
   * deferred; cancellation happens through the `CANCELLED` status instead).
   */
  deleteTask(sessionId: string, taskId: string): boolean {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    const db = handle(this.cwd)
    try {
      const r = db
        .prepare("DELETE FROM tasks WHERE session_id = ? AND task_id = ?")
        .run(sessionId, taskId)
      return r.changes > 0
    } catch (e) {
      throw new TaskError("TASK_PERSISTENCE_FAILURE", (e as Error).message)
    }
  }

  /** Drop every task in one session. For `deleteSession`. */
  deleteSessionTasks(sessionId: string): number {
    const db = handle(this.cwd)
    try {
      return db.prepare("DELETE FROM tasks WHERE session_id = ?").run(sessionId).changes
    } catch (e) {
      throw new TaskError("TASK_PERSISTENCE_FAILURE", (e as Error).message)
    }
  }

  // ── meta / migration ──────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const db = handle(this.cwd)
    const row = db.prepare("SELECT value FROM task_meta WHERE key = ?").get(key) as {
      value: string
    } | null
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    const db = handle(this.cwd)
    db.prepare("INSERT OR REPLACE INTO task_meta (key, value) VALUES (?, ?)").run(key, value)
  }

  /** Sessions whose data has already been imported from a legacy file,
   *  together with the source fingerprint used. Used by migration idempotency. */
  migrationStamp(sessionId: string): string | null {
    return this.getMeta(`migrated:${sessionId}`)
  }

  markMigrated(sessionId: string, digest: string): void {
    this.setMeta(`migrated:${sessionId}`, digest)
  }

  dataVersion(): number {
    const raw = this.getMeta("data_version")
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) ? n : 0
  }

  ensureDataVersion(): number {
    const v = this.dataVersion()
    if (v === 0) this.setMeta("data_version", String(TASK_DATA_VERSION))
    if (v > TASK_DATA_VERSION) {
      throw new TaskError(
        "TASK_MIGRATION_FAILURE",
        `data written by newer version (${v} > ${TASK_DATA_VERSION}); refusing to downgrade`,
      )
    }
    return TASK_DATA_VERSION
  }

  /** Close the handle. For tests and explicit shutdown only. */
  static close(cwd?: string): void {
    const p = dbFile(cwd)
    // Closing the connection under an open transaction would abandon a
    // half-applied unit of work with no way to roll it back.
    assertNoOpenTx(p, "close the store")
    const db = handles.get(p)
    if (db) {
      try {
        db.close()
      } catch {}
      handles.delete(p)
      initialized.delete(p)
    }
  }

  // ── transaction boundary (Phase 4A.2) ─────────────────────────────────────

  /**
   * Run `fn` inside a single SQLite transaction owned by THIS TaskStore.
   *
   * WHY THIS EXISTS. A caller could previously open its own `db.transaction()`
   * and call TaskStore methods inside it, and get atomicity that was silently
   * false: TaskStore holds its own cached `Database` handle, so the caller's
   * transaction and TaskStore's writes were two different connections and
   * committed independently. Measured: a forced throw rolled back nothing.
   *
   * WHY THE CALLBACK RECEIVES `this`. The transaction is opened on the very same
   * cached handle that every TaskStore method obtains from `handle(cwd)`, so
   * there is exactly ONE authoritative connection per path. Every method called
   * on `tx` therefore participates in this transaction by construction - there
   * is no "escaped" path, and no second allocator or duplicated SQL.
   *
   * NESTING. `bun:sqlite` implements a nested `db.transaction` as a savepoint
   * that joins the enclosing transaction rather than committing independently
   * (measured). So `createTask`/`patchTask`, which each open their own
   * transaction, compose correctly inside this one with no extra machinery.
   *
   * BUSY HANDLING. Deliberately unchanged: this adds no new retry. Contention
   * is handled by the connection's existing `busy_timeout` pragma, and the
   * bounded per-statement retry remains scoped to schema DDL exactly as in
   * Phase 1. No unbounded retry is introduced here.
   *
   * Errors from `fn` propagate unchanged after rollback.
   */
  withTransaction<T>(fn: (tx: TaskStore) => T): T {
    const p = dbFile(this.cwd)
    const db = handle(this.cwd)
    txDepth.set(p, (txDepth.get(p) ?? 0) + 1)
    try {
      return db.transaction(() => fn(this))()
    } finally {
      const d = (txDepth.get(p) ?? 1) - 1
      if (d <= 0) txDepth.delete(p)
      else txDepth.set(p, d)
    }
  }

  /** True when a `withTransaction` is currently in flight for this store's
   *  database. Diagnostics only; the guard above is what enforces safety. */
  inTransaction(): boolean {
    return (txDepth.get(dbFile(this.cwd)) ?? 0) > 0
  }
}

/** Discard the handle cache. For hermetic tests only. */
export function resetTaskStoreHandles(): void {
  // Refuse while any transaction is open, for the same reason `close` does.
  const open = openTxPaths()
  if (open.length > 0) {
    throw new TaskError(
      "TASK_TX_ACTIVE",
      `cannot reset task store handles while ${open.length} transaction(s) are open`,
    )
  }
  for (const db of handles.values()) {
    try {
      db.close()
    } catch {}
  }
  handles.clear()
  initialized.clear()
}

/** Legacy-source fingerprint, used by migration so a re-import of identical
 *  content changes nothing. */
export function legacyDigest(raw: string): string {
  // `scrubSecrets` is used so a secret accidentally present in the legacy file
  // is neither hashed nor leaked through the marker.
  const { createHash } = require("node:crypto") as typeof import("node:crypto")
  return createHash("sha256").update(scrubSecrets(raw)).digest("hex").slice(0, 32)
}

export const __testing = { MAX_DEPENDS_ON, MAX_EVIDENCE, MAX_ACCEPTANCE, MAX_PARENT }
