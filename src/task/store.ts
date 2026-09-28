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
}

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
          `INSERT INTO tasks (session_id, task_id, title, status, task_order, parent_id, depends_on_json, blocked_reason, verification_json, evidence_json, acceptance_json, provenance_json, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
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
    return db.transaction(() => {
      this.validate(sessionId, next, taskId)
      try {
        db.prepare(
          `UPDATE tasks SET title = ?, status = ?, task_order = ?, parent_id = ?, depends_on_json = ?, blocked_reason = ?, verification_json = ?, evidence_json = ?, acceptance_json = ?, updated_at = ?, revision = revision + 1
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
  ): { outcome: ClaimOutcome; task: Task | null } {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    const db = handle(this.cwd)
    const statuses = sqlList(CLAIMABLE_STATUSES)

    // THE revision predicate lives here, in SQL. One statement = one atomic
    // decision; there is no read-then-write window.
    const result = db
      .prepare(
        `UPDATE tasks
            SET status = 'IN_PROGRESS', updated_at = ?, revision = revision + 1
          WHERE session_id = ? AND task_id = ? AND revision = ? AND status IN (${statuses})`,
      )
      .run(nowIso(), sessionId, taskId, expectedRevision)

    if (result.changes === 1) {
      return { outcome: "CLAIM_ACCEPTED", task: this.getTask(sessionId, taskId) }
    }

    // Lost the race, or never was claimable. Classify for the caller.
    const current = this.getTask(sessionId, taskId)
    if (current === null) return { outcome: "NOT_FOUND", task: null }
    if (current.revision !== expectedRevision) {
      return { outcome: "CLAIM_REJECTED_STALE", task: current }
    }
    return { outcome: "WRONG_STATE", task: current }
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
    const result = db
      .prepare(
        `UPDATE tasks
            SET status = 'PENDING', updated_at = ?, revision = revision + 1
          WHERE session_id = ? AND task_id = ? AND revision = ? AND status IN (${statuses})`,
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
