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
import { randomUUID } from "node:crypto"
import { LIMITS } from "../constants.ts"
import { resolveLocalDbPath } from "../lib/db-path.ts"
import { scrubSecrets } from "../policy/scrub.ts"
import type { CompletionEvidence } from "../tools/todo.ts"
import {
  type ClaimOutcome,
  IllegalTaskTransitionError,
  isLegalTaskTransition,
  isTaskId,
  isTaskStatus,
  isTerminalTaskStatus,
  type ReconcileOutcome,
  type Task,
  type TaskAcceptance,
  TaskAuthorityLostError,
  TaskError,
  type TaskEvidence,
  type TaskProvenance,
  type TaskSnapshot,
  type TaskStatus,
  type TaskVerification,
  taskIdFromIndex,
} from "./model.ts"
import type { SessionAuthority } from "./session-authority.ts"

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
const SCHEMA_ATTEMPTS = 8
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
  /** [PHASE 6P] Kolom terpisah dari status/lineage; lihat `ExecutionOwner`. */
  execution_owner: string | null
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

/** `task_meta` key holding the current incarnation of a session id. */
const incarnationKey = (sessionId: string): string => `session_incarnation:${sessionId}`

/**
 * [PHASE 6Q] Outcome of `recordAttemptReturned`.
 *
 * [DESIGN DECISION] This used to be `void` and it THREW whenever the guarded
 * UPDATE matched no row. That is what made 6N F2 a wedge rather than an error: the
 * throw escaped `cycle()`, so the Scheduler never reached the line that clears its
 * own claim, and it kept both the claim and the session ownership forever.
 *
 * "The row I claimed is gone" and "the generation moved" are NOT persistence
 * failures - they are the ordinary outcomes of a session being deleted under a
 * running execution, or of a later generation superseding an earlier one. The
 * protection 6I wanted is preserved exactly (NOTHING IS WRITTEN when the guard
 * does not match); what changes is that the caller is TOLD, instead of being
 * destroyed by it. Genuine SQL errors still throw.
 */
export type AttemptRecordOutcome =
  /** The completion marker for this generation was written. */
  | "RECORDED"
  /** The task row no longer exists - the session was deleted under this execution. */
  | "TASK_GONE"
  /** The row exists but this generation is no longer current. Nothing was written. */
  | "SUPERSEDED"
  /**
   * The session was deleted (or deleted and recreated) since this execution was
   * claimed, so the row that exists - if any - belongs to a DIFFERENT incarnation.
   * This is the cross-generation guard; nothing was written.
   */
  | "SESSION_SUPERSEDED"

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

/**
 * [P14] Status yang boleh DIPINDAHKAN ke sesi lain.
 *
 * Kenapa bukan "semua status": memindahkan pekerjaan yang sudah COMPLETED atau
 * CANCELLED akan menghidupkan kembali pekerjaan yang sudah ditutup — persis
 * larangan P14. Status di luar daftar ini = terminal/UNKNOWN dan harus
 * ditangani operator, bukan diadopsi diam-diam.
 */
const ADOPTABLE_STATUSES: readonly TaskStatus[] = [
  "PENDING",
  "IN_PROGRESS",
  "VERIFYING",
  "BLOCKED",
  "FAILED",
  "RETRYING",
]

const ADOPTABLE_STATUS_SET: ReadonlySet<TaskStatus> = new Set(ADOPTABLE_STATUSES)

/**
 * [P14] Satu baris ledger transfer. TIDAK mengandung token otoritas: token
 * adalah kredensial proses, bukan bukti yang boleh menetap di database.
 *
 * Ledger ini adalah BUKTI ASAL, bukan otoritas kedua. Status task tetap
 * dibaca dari tabel `tasks`; ledger hanya menjawab "task id ini pernah
 * berpindah dari sesi mana ke sesi mana, pada revisi/generasi apa".
 */
export interface TaskTransfer {
  readonly transferId: string
  readonly taskId: string
  readonly fromSessionId: string
  readonly fromIncarnation: number
  readonly toSessionId: string
  readonly toIncarnation: number
  readonly expectedRevision: number
  readonly newRevision: number
  readonly status: string
  readonly execGeneration: number
  readonly attemptGeneration: number | null
  readonly executionOwner: ExecutionOwner | null
  readonly transferredAt: string
}

export interface TaskTransferRequest {
  readonly taskId: string
  readonly fromSessionId: string
  readonly fromIncarnation: number
  readonly toSessionId: string
  readonly toIncarnation: number
  readonly expectedRevision: number
  /** Token yang HARUS masih memegang lease sesi sumber. */
  readonly sourceOwnerToken: string
  /** Token yang HARUS masih memegang lease sesi tujuan. */
  readonly targetOwnerToken: string
  /** Satu jam logis untuk seluruh pemeriksaan + mutasi. */
  readonly now?: number
}

export type TaskTransferOutcome =
  | "TRANSFERRED"
  | "NOT_FOUND"
  | "REFUSED_SELF_TRANSFER"
  | "REJECTED_STALE_SOURCE_INCARNATION"
  | "REJECTED_STALE_TARGET_INCARNATION"
  | "REJECTED_STALE_REVISION"
  | "REFUSED_NO_SOURCE_AUTHORITY"
  | "REFUSED_NO_TARGET_AUTHORITY"
  | "REFUSED_STATUS"
  | "REFUSED_TARGET_ID_CONFLICT"
  | "REFUSED_UNRESOLVED_RELATION"
  | "REFUSED_CORRUPT_STATE"

export interface TaskTransferResult {
  readonly outcome: TaskTransferOutcome
  readonly task: Task | null
  readonly transfer: TaskTransfer | null
  readonly detail: string
  /**
   * Id relasi (parent/dependency) yang tidak bisa dibuktikan berasal dari sesi
   * sumber yang sama. Kosong kecuali outcome `REFUSED_UNRESOLVED_RELATION`.
   */
  readonly unresolvedRelations: readonly string[]
}

/**
 * [P14] Satu item inventaris open-work lintas sesi.
 *
 * `Task` sengaja tetap bentuk kanoniknya; fakta eksekusi dan provenance
 * transfer berada DI SAMPINGNYA, bukan dicampur ke dalam `Task`. Discovery
 * tidak pernah memberi otoritas: tidak ada lease yang diakuisisi dan tidak
 * ada baris yang ditulis.
 */
export interface UnfinishedWorkItem {
  readonly sessionId: string
  readonly sessionIncarnation: number
  readonly task: Task
  readonly execGeneration: number
  readonly attemptGeneration: number | null
  readonly executionOwner: ExecutionOwner | null
  readonly transferredFromSessionId: string | null
  readonly transferredAt: string | null
}

/**
 * [P14.3] Satu baris ledger dedup. Append-only.
 *
 * `duplicateId` adalah task yang DINYATAKAN operator sebagai unit kerja yang
 * sama dengan `survivorId`, lalu ditutup sebagai CANCELLED (BUKAN COMPLETED —
 * menyelesaikan duplikat adalah inferensi yang dilarang). `evidence` adalah
 * teks operator yang direkam utuh: kemiripan judul tidak pernah cukup, dan
 * ledger inilah bukti bahwa keputusan itu eksplisit, bukan otomatis.
 */
export interface TaskMerge {
  readonly mergeId: string
  readonly sessionId: string
  readonly survivorId: string
  readonly duplicateId: string
  readonly evidence: string
  readonly survivorStatus: string
  readonly duplicateStatus: string
  readonly duplicateRevision: number
  readonly mergedAt: string
}

export interface TaskDuplicateRequest {
  readonly sessionId: string
  readonly survivorId: string
  readonly duplicateId: string
  /** WAJIB non-kosong: alasan operator bahwa ini unit kerja yang sama. */
  readonly evidence: string
  /** Revisi duplikat yang dilihat operator (read-then-write, bukan CAS). */
  readonly expectedRevision?: number
}

export type TaskDuplicateOutcome =
  | "DECLARED"
  | "NOT_FOUND"
  | "REFUSED_SELF_MERGE"
  | "REFUSED_NO_EVIDENCE"
  | "REFUSED_TERMINAL_DUPLICATE"
  | "REJECTED_STALE_REVISION"

export interface TaskDuplicateResult {
  readonly outcome: TaskDuplicateOutcome
  /** Duplikat setelah ditutup (CANCELLED, revisi +1), atau null saat ditolak. */
  readonly duplicate: Task | null
  readonly survivor: Task | null
  readonly merge: TaskMerge | null
  readonly detail: string
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

CREATE TABLE IF NOT EXISTS session_authority (
  -- [PHASE 6X] One row per (session, incarnation): a bounded, self-expiring
  -- claim on the RIGHT TO SCHEDULE, never proof of liveness.
  session_id       TEXT    NOT NULL,
  incarnation      INTEGER NOT NULL,
  owner_token      TEXT    NOT NULL,
  owner_pid        INTEGER NOT NULL,
  acquired_at      INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  -- Keyed by incarnation as well as session, so a session deleted and recreated
  -- (6Q bumps the incarnation) can never inherit its predecessor's lease.
  PRIMARY KEY (session_id, incarnation)
);

CREATE TABLE IF NOT EXISTS task_transfers (
  -- [P14] Ledger transfer lintas sesi. APPEND-ONLY: tidak ada UPDATE/DELETE di
  -- jalur produksi. Token otoritas sengaja TIDAK disimpan — yang dicatat adalah
  -- fakta yang tidak berubah (identitas, revisi, generasi, status) supaya
  -- operator bisa mengaudit asal task tanpa memegang kredensial proses.
  transfer_id        TEXT    PRIMARY KEY,
  task_id            TEXT    NOT NULL,
  from_session_id    TEXT    NOT NULL,
  from_incarnation   INTEGER NOT NULL,
  to_session_id      TEXT    NOT NULL,
  to_incarnation     INTEGER NOT NULL,
  expected_revision  INTEGER NOT NULL,
  new_revision       INTEGER NOT NULL,
  status             TEXT    NOT NULL,
  exec_generation    INTEGER NOT NULL,
  attempt_generation INTEGER,
  execution_owner    TEXT,
  transferred_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_transfers_from ON task_transfers(from_session_id, task_id);
CREATE INDEX IF NOT EXISTS idx_task_transfers_to ON task_transfers(to_session_id, task_id);
CREATE TABLE IF NOT EXISTS task_merges (
  -- [P14.3] Ledger dedup EKSPLISIT operator. Append-only. Satu-satunya penulis
  -- adalah declareTaskDuplicate, di transaksi yang sama dengan status CANCELLED
  -- duplikat. Kolom evidence WAJIB: kemiripan judul bukan bukti, operator
  -- yang menyatakan alasannya dan teks itu disimpan utuh untuk audit
  -- (tanpa token otoritas — sama seperti task_transfers).
  merge_id          TEXT    PRIMARY KEY,
  session_id        TEXT    NOT NULL,
  survivor_id       TEXT    NOT NULL,
  duplicate_id      TEXT    NOT NULL,
  evidence          TEXT    NOT NULL,
  survivor_status   TEXT    NOT NULL,
  duplicate_status  TEXT    NOT NULL,
  duplicate_revision INTEGER NOT NULL,
  merged_at         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_merges_session ON task_merges(session_id, duplicate_id);
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
  // [Phase 7 / Live #1] Sama dengan persistence.ts: buka koneksi + PRAGMA
  // setup dalam retry. `new Database(p)` dan `PRAGMA journal_mode=WAL`
  // bisa gagal SQLITE_BUSY saat beberapa proses membuka tasks.db bersamaan.
  // busy_timeout diatur SEBELUM journal_mode (peralihan WAL butuh exclusive
  // lock sesaat yang langsung gagal tanpa busy_timeout).
  let db: Database
  const opened = withBusyRetrySync(() => {
    const d = new Database(p)
    try {
      d.exec(`PRAGMA busy_timeout=${LIMITS.SQLITE_BUSY_TIMEOUT_MS}`)
    } catch {}
    return d
  })
  if (!opened) {
    throw new TaskError(
      "TASK_DB_INIT_FAILURE",
      `cannot open ${p} after ${SCHEMA_ATTEMPTS} busy-retry attempts`,
    )
  }
  db = opened
  // [Audit #3 RL-3] WAL + DDL/migrasi dibungkus SATU guard pasca-konstruksi agar
  // kegagalan IOERR/CORRUPT menutup handle (bukan bocor) — WAL sebelumnya di luar guard.
  try {
    if (!initialized.has(p)) {
      // Sama dengan persistence.ts: PRAGMA WAL dibungkus retry (peralihan WAL
      // butuh exclusive lock sesaat).
      const walOk = withBusyRetrySync(() => {
        db.exec(
          `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${LIMITS.SQLITE_BUSY_TIMEOUT_MS}; PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=${LIMITS.SQLITE_WAL_SIZE_LIMIT_BYTES}; PRAGMA wal_autocheckpoint=${LIMITS.SQLITE_WAL_AUTOCHECKPOINT_PAGES};`,
        )
        return true
      })
      if (walOk === null) {
        process.stderr.write(`[warn] taskstore: wal setup deferred, retry next open: ${p}\n`)
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

/**
 * [P14] Parse relasi secara KETAT — berbeda dari `parseJson` yang sengaja
 * memaafkan kolom rusak untuk pembacaan biasa.
 *
 * Transfer lintas sesi memindahkan baris yang relasinya akan ditafsirkan ulang
 * di namespace sesi lain. Menebak `[]` dari JSON rusak berarti memindahkan task
 * tanpa dependency yang sebenarnya ada — persis "deduplication menyatukan tugas
 * yang berbeda" yang dilarang P14. `null` = tidak bisa dibuktikan, jadi tolak.
 */
function parseStringArrayStrict(raw: string | null): string[] | null {
  if (raw === null || raw.trim() === "") return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return null
    if (v.some((x) => typeof x !== "string")) return null
    return v as string[]
  } catch {
    return null
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
   *  [Fase 1 / LOOP-INV-01] The check now runs INSIDE the write transaction and
   *  the UPDATE carries `AND revision = ?`, so it is a real compare-and-swap
   *  (one writer wins, the loser gets `TASK_STALE_REVISION` and changes
   *  nothing). Previously it was a read-then-write outside the transaction and
   *  two concurrent writers could both pass it. */
  expectedRevision?: number
}

/**
 * [Fase 1] Opsi khusus `patchTask` untuk dua jaminan baru.
 */
export interface PatchOptions extends UpsertOptions {
  /**
   * [LOOP-INV-02] Permit EKSPLISIT untuk keluar dari status terminal
   * (`COMPLETED`/`CANCELLED`). Tanpa ini, transisi tersebut ditolak dengan
   * `IllegalTaskTransitionError`.
   *
   * Ini bukan pelonggaran diam-diam: reopen tetap mungkin (operator yang salah
   * merge harus bisa membatalkannya), tetapi setiap pemanggil yang
   * melakukannya menyatakannya di kode dan bisa diaudit lewat grep, bukan
   * tersembunyi sebagai efek samping "tulis status apa saja".
   */
  allowReopen?: boolean
  /**
   * [LOOP-INV-13] Token lease milik pemanggil. Bila diberikan, `patchTask`
   * memverifikasi token itu masih memegang `session_authority` untuk sesi ini.
   * Token basi/tersingkir = `TaskAuthorityLostError`, tanpa menulis apa pun.
   *
   * `undefined` = pemanggil tanpa identitas lease (CLI interaktif / operator).
   * Mode itu sengaja tetap diizinkan supaya sesi tunggal tanpa kontensi tidak
   * berubah perilakunya.
   */
  authorityToken?: string
}

/**
 * [Fase 3 / LOOP-INV-12, LOOP-G21] Hasil verifikasi terstruktur untuk mengunci
 * transisi dari `VERIFYING` ke `COMPLETED` (lulus) atau `BLOCKED` (gagal).
 */
export interface VerificationGateOutcome {
  readonly ok: boolean
  readonly verdict: "passed" | "failed" | "stale"
  readonly exitCode?: number | null
  readonly command?: string
  readonly summary?: string
  readonly integrityOk?: boolean
  readonly timestamp?: string
}

/** Format satu rekaman `TaskEvidence` berjenis `"verify"` secara deterministik. */
export function buildVerificationTaskEvidence(outcome: VerificationGateOutcome): TaskEvidence {
  const at = outcome.timestamp ?? nowIso()
  const payload = {
    verdict: outcome.verdict,
    ok: outcome.ok,
    exitCode: outcome.exitCode ?? (outcome.ok ? 0 : 1),
    ...(outcome.command ? { command: scrubSecrets(outcome.command).slice(0, 200) } : {}),
    summary: scrubSecrets(
      outcome.summary ?? (outcome.ok ? "verification passed" : "verification failed"),
    ).slice(0, 500),
    ...(typeof outcome.integrityOk === "boolean" ? { integrityOk: outcome.integrityOk } : {}),
    timestamp: at,
  }
  return {
    kind: "verify",
    detail: JSON.stringify(payload),
    at,
  }
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
   * [Fase 1 / LOOP-INV-01] `expectedRevision` is now a REAL compare-and-swap:
   * the read, the validation and the write share one transaction, and the
   * UPDATE carries `AND revision = ?`. Two concurrent writers can no longer
   * both pass it — the loser gets TASK_STALE_REVISION and writes nothing.
   * (The previous PHASE 6B note above described the old read-then-write shape;
   * that shape no longer exists.)
   *
   * [Fase 1 / LOOP-INV-02] From-state gate: `TASK_EDGES` rejects illegal
   * transitions, and terminal states (COMPLETED/CANCELLED) can only be left
   * with the explicit permit `allowReopen`.
   *
   * [Fase 1 / LOOP-INV-13] Lease fencing: when `authorityToken` is supplied and
   * no longer holds `session_authority`, the write is refused without touching
   * the row. Callers without a token (interactive operator) behave as before.
   *
   * PHASE 6B authority guard: when `authorityMode === "SCHEDULER"`, a patch may
   * not author `IN_PROGRESS` — only `claimTask` may. This is the fail-closed
   * door that stops model-facing `todo_write` from creating a claim.
   */
  patchTask(sessionId: string, taskId: string, patch: TaskPatch, opts: PatchOptions = {}): Task {
    if (this.authorityMode === "SCHEDULER" && patch.status === "IN_PROGRESS") {
      throw new TaskError(
        "TASK_AUTHORITY_VIOLATION",
        `IN_PROGRESS may only be authored by claimTask while Scheduler authority is active (${sessionId}/${taskId})`,
      )
    }
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    const db = handle(this.cwd)
    // [Fase 1 / LOOP-INV-01] READ -> VALIDATE -> WRITE is ONE transaction, and
    // the UPDATE carries `AND revision = ?`. That makes it a true CAS: a caller
    // passing `expectedRevision` that loses the race gets TASK_STALE_REVISION
    // and writes nothing, and even a caller that passes no revision cannot
    // silently overwrite a row whose revision moved underneath the read.
    return db.transaction(() => {
      const current = this.getTask(sessionId, taskId)
      if (!current) throw new TaskError("TASK_NOT_FOUND", `no task ${taskId} in ${sessionId}`)
      if (opts.expectedRevision !== undefined && opts.expectedRevision !== current.revision) {
        throw new TaskError(
          "TASK_STALE_REVISION",
          `${taskId} is at revision ${current.revision}, got ${opts.expectedRevision}`,
        )
      }
      // [Fase 1 / LOOP-INV-13] Lease fencing for callers that present an
      // identity. No token = interactive/operator path (unchanged behaviour);
      // a token that is no longer current = fail-closed, because a displaced
      // worker must not write after losing authority.
      if (
        opts.authorityToken !== undefined &&
        !this.holdsSessionAuthority(sessionId, opts.authorityToken)
      ) {
        throw new TaskAuthorityLostError(sessionId)
      }
      const nextStatus: TaskStatus = patch.status ?? current.status
      // [Fase 1 / LOOP-INV-02] From-state gate. A self-write (title/order edit)
      // keeps the same status and therefore always passes. Leaving a terminal
      // state requires the explicit permit `allowReopen`.
      if (
        nextStatus !== current.status &&
        !isLegalTaskTransition(current.status, nextStatus) &&
        !(opts.allowReopen === true && isTerminalTaskStatus(current.status))
      ) {
        throw new IllegalTaskTransitionError(current.status, nextStatus)
      }
      const next: NewTaskInput = {
        title: patch.title ?? current.title,
        status: nextStatus,
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
      // The release is computed in SQL (a CASE over the RESULTING status), so it
      // needs no extra read and stays inside the same transaction as the write.
      // [Fase 1] The whole read-validate-write now lives inside that transaction
      // and the UPDATE is revision-guarded (CAS), so the ownership CASE, the
      // status gate and the mutation observe one consistent snapshot.
      this.validate(sessionId, next, taskId)
      let changes = 0
      try {
        changes = db
          .prepare(
            `UPDATE tasks SET title = ?, status = ?, task_order = ?, parent_id = ?, depends_on_json = ?, blocked_reason = ?,
              verification_json = ?, evidence_json = ?, acceptance_json = ?, updated_at = ?, revision = revision + 1,
              execution_owner = CASE WHEN ? IN (${sqlList(RECONCILABLE_STATUSES)}) THEN execution_owner ELSE NULL END
             WHERE session_id = ? AND task_id = ? AND revision = ?`,
          )
          .run(
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
            current.revision,
          ).changes
      } catch (e) {
        throw new TaskError("TASK_PERSISTENCE_FAILURE", (e as Error).message)
      }
      if (changes !== 1) {
        // The predicate matched a revision read in this same transaction, so a
        // zero here means the row vanished under us (session deleted). Never a
        // silent success, and never a second write attempt.
        throw new TaskError(
          "TASK_STALE_REVISION",
          `${taskId} changed while the patch was being applied (expected revision ${current.revision})`,
        )
      }
      return this.getTask(sessionId, taskId)!
    })()
  }
  /** Readable alias for the layer above. */
  updateTask(sessionId: string, taskId: string, patch: TaskPatch, opts: PatchOptions = {}): Task {
    return this.patchTask(sessionId, taskId, patch, opts)
  }

  // ── [Fase 3 / LOOP-INV-12, LOOP-G20, LOOP-G21] siklus VERIFYING ────────────
  //
  // Transisi eksplisit menuju `VERIFYING` dan penyelesaiannya ke `COMPLETED`
  // (bila bukti terverifikasi) atau `BLOCKED` (bila verifikasi / Tier 1 gagal),
  // sambil merekam bukti terstruktur pada `evidence_json`.

  /**
   * Masuk ke status `VERIFYING` sebelum/selama verifikasi berjalan.
   * Mematuhi `TASK_EDGES`, CAS `expectedRevision`, dan lease `authorityToken`.
   */
  beginTaskVerification(sessionId: string, taskId: string, opts: PatchOptions = {}): Task {
    return this.patchTask(sessionId, taskId, { status: "VERIFYING", blockedReason: null }, opts)
  }

  /**
   * Selesaikan verifikasi sebuah task dalam satu transaksi atomik:
   * - Jika task belum di `VERIFYING` (mis. `IN_PROGRESS`/`PENDING`) dan belum
   *   terminal, transisikan dulu ke `VERIFYING` agar jalur siklus tetap utuh.
   * - Jika `outcome.ok === true`: `VERIFYING -> COMPLETED` + bukti `"verify"`.
   * - Jika `outcome.ok === false`: `VERIFYING -> BLOCKED` + alasan + bukti.
   */
  completeTaskVerification(
    sessionId: string,
    taskId: string,
    outcome: VerificationGateOutcome,
    opts: PatchOptions = {},
  ): Task {
    return this.withTransaction(() => {
      const current = this.getTask(sessionId, taskId)
      if (!current) throw new TaskError("TASK_NOT_FOUND", `no task ${taskId} in ${sessionId}`)
      let base = current
      let nextOpts = opts
      if (base.status !== "VERIFYING" && !isTerminalTaskStatus(base.status)) {
        base = this.patchTask(sessionId, taskId, { status: "VERIFYING", blockedReason: null }, opts)
        // Setelah langkah masuk VERIFYING menggunakan expectedRevision pemanggil,
        // langkah kedua mengunci revisi baru yang baru saja ditulis dalam txn ini.
        nextOpts = {
          ...opts,
          expectedRevision: base.revision,
        }
      }
      const ev = buildVerificationTaskEvidence(outcome)
      const mergedEvidence = [...(base.evidence ?? []).slice(-(MAX_EVIDENCE - 1)), ev]
      if (outcome.ok) {
        return this.patchTask(
          sessionId,
          taskId,
          {
            status: "COMPLETED",
            blockedReason: null,
            evidence: mergedEvidence,
          },
          nextOpts,
        )
      }
      const reason =
        outcome.summary?.trim().slice(0, 300) ||
        (outcome.verdict === "stale" ? "verification stale" : "verification failed")
      return this.patchTask(
        sessionId,
        taskId,
        {
          status: "BLOCKED",
          blockedReason: reason,
          evidence: mergedEvidence,
        },
        nextOpts,
      )
    })
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
    /**
     * [PHASE 6T] `exclusive` adds the CAPACITY PREDICATE to the same statement
     * that performs the claim.
     *
     * [DESIGN DECISION] 6O selected this shape and it was never built: contention
     * was detected AFTER the claim, so a turn that never ran still consumed an
     * execution generation and left the task `IN_PROGRESS` and stranded. The fix
     * has to be atomic for the reason 6O gave — `exec_generation` is the unit that
     * must not be spent on a non-attempt, and a read-then-write check outside the
     * UPDATE would reopen exactly the window the revision predicate closes.
     *
     * The predicate is "no OTHER task in this session holds a LIVE Scheduler
     * execution", which is the Scheduler's own serial guarantee expressed durably,
     * so it holds across processes and not merely within one.
     *
     * [PHASE 6T][DESIGN DECISION] "LIVE" is not the same as "IN_PROGRESS", and
     * conflating them is a bug this predicate was written and then caught with.
     * After every completed turn the task deliberately REMAINS `IN_PROGRESS`
     * awaiting a verifier that does not exist yet (6N's "no verifier" limit), so
     * a naive `IN_PROGRESS` test finds a live execution forever and the Scheduler
     * can never run a second task. Live means the current generation's attempt has
     * not ended:
     *
     *     attempt_generation IS NULL OR attempt_generation < exec_generation
     *
     * which is exactly the condition reconciliation already uses to tell a
     * crashed execution (REVERT) from finished work (LEAVE). Capacity and
     * recovery therefore read one fact, and cannot disagree.
     *
     * A crashed execution still occupies capacity until a cycle reconciles it —
     * which is correct: an execution of unknown liveness is not free capacity,
     * and `runCycle` reconciles before it selects.
     *
     * Off by default: every existing caller keeps its exact behaviour, and only a
     * caller that means to be exclusive asks for it.
     */
    opts: { readonly exclusive?: boolean } = {},
  ): {
    outcome: ClaimOutcome
    task: Task | null
    execGeneration: number
    /** [PHASE 6Q] Incarnation the claim was made under. 1 for an undeleted session. */
    sessionIncarnation: number
  } {
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
          WHERE session_id = ? AND task_id = ? AND revision = ? AND status IN (${statuses})${
            opts.exclusive === true
              ? `
            AND NOT EXISTS (
              SELECT 1 FROM tasks AS busy
               WHERE busy.session_id = tasks.session_id
                 AND busy.execution_owner = 'scheduler'
                 AND busy.status = 'IN_PROGRESS'
                 AND busy.exec_generation > 0
                 AND (busy.attempt_generation IS NULL
                      OR busy.attempt_generation < busy.exec_generation)
                 AND busy.task_id <> tasks.task_id
            )`
              : ""
          }`,
      )
      .run(nowIso(), sessionId, taskId, expectedRevision)

    if (result.changes === 1) {
      const lineage = this.getExecutionLineage(sessionId, taskId)
      return {
        outcome: "CLAIM_ACCEPTED",
        task: this.getTask(sessionId, taskId),
        execGeneration: lineage?.execGeneration ?? 0,
        // [PHASE 6Q] Read inside the same call so the Scheduler can present this
        // incarnation back at lineage-write time. A deletion between claim and
        // write moves it, and the write is then refused.
        sessionIncarnation: this.getSessionIncarnation(sessionId),
      }
    }

    // Lost the race, or never was claimable. Classify for the caller. A rejected
    // claim creates NO generation: execGeneration reports the unchanged current
    // value so a caller can never mistake a rejection for a claim.
    const current = this.getTask(sessionId, taskId)
    const sessionIncarnation = this.getSessionIncarnation(sessionId)
    if (current === null) {
      return { outcome: "NOT_FOUND", task: null, execGeneration: 0, sessionIncarnation }
    }
    const lineage = this.getExecutionLineage(sessionId, taskId)
    const execGeneration = lineage?.execGeneration ?? 0
    if (current.revision !== expectedRevision) {
      return { outcome: "CLAIM_REJECTED_STALE", task: current, execGeneration, sessionIncarnation }
    }
    // [PHASE 6T] The row is claimable and the revision matched, so the ONLY
    // reason the UPDATE did not land is the capacity predicate. Classify it as
    // contention rather than lumping it in with WRONG_STATE: the caller must be
    // able to tell "someone else is running" (skip, no state spent) from
    // "this task is not claimable" (a different question entirely).
    if (opts.exclusive === true && this.hasLiveSchedulerClaim(sessionId, taskId)) {
      return { outcome: "CLAIM_REJECTED_BUSY", task: current, execGeneration, sessionIncarnation }
    }
    return { outcome: "WRONG_STATE", task: current, execGeneration, sessionIncarnation }
  }

  /**
   * [PHASE 6T] Does another task in this session hold a LIVE Scheduler execution?
   *
   * "Live" means the current generation's attempt has not ended — see the note on
   * the capacity predicate. A task still `IN_PROGRESS` after a completed attempt
   * is awaiting verification, not occupying capacity.
   *
   * The read side of that predicate. It classifies a REJECTION; it is never used
   * to decide whether to attempt a claim, because only the atomic statement can
   * make that decision safely.
   */
  private hasLiveSchedulerClaim(sessionId: string, excludeTaskId: string): boolean {
    const row = handle(this.cwd)
      .prepare(
        `SELECT 1 FROM tasks
          WHERE session_id = ? AND execution_owner = 'scheduler'
            AND status = 'IN_PROGRESS' AND exec_generation > 0
            AND (attempt_generation IS NULL OR attempt_generation < exec_generation)
            AND task_id <> ?
          LIMIT 1`,
      )
      .get(sessionId, excludeTaskId)
    return row !== undefined && row !== null
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

  // ── [PHASE 6Q] SESSION INCARNATION ──────────────────────────────────────────

  /**
   * [PHASE 6Q] A durable, monotonically increasing counter identifying WHICH
   * INCARNATION of a session id is current.
   *
   * WHY IT EXISTS (6N F2). `taskId` is allocated PER SESSION and restarts at `t1`,
   * so deleting a session and recreating it with the same id produces a session
   * whose task rows are *indistinguishable by id* from the deleted ones. An
   * execution that was still running against the DELETED incarnation therefore
   * holds a `(taskId, execGeneration)` pair that a FRESH claim in the RECREATED
   * session can legitimately match:
   *
   *   delete session A  -> recreate A  -> new Scheduler claims new t1 (exec=1)
   *   -> the OLD execution returns with (t1, execGeneration=1)
   *   -> `WHERE exec_generation = 1` MATCHES THE NEW ROW
   *
   * Without a discriminator the old execution would stamp `attempt_generation` on
   * the new row, and that new claim would be treated as "already completed" and
   * never recovered. That is exactly the cross-generation effect 6Q must forbid.
   *
   * THE MINIMUM GUARD. The Scheduler reads the incarnation at CLAIM time and
   * passes it back at lineage-write time; the write is refused if the current
   * incarnation has moved. Deletion bumps the counter, which invalidates every
   * in-flight execution of that session id at once, in one durable write, with no
   * coordination and no cross-process signalling.
   *
   * Stored in `task_meta` in THIS database, so the counter and the task rows it
   * protects share a persistence domain and can be read and written under one
   * handle. It is NOT session state: it deliberately SURVIVES the session's own
   * deletion, because its entire job is to remember that a deletion happened.
   *
   * It is NOT a lease, lock, heartbeat, priority or completion claim. It grants no
   * authority; it only lets a late writer recognise that it is late.
   */
  getSessionIncarnation(sessionId: string): number {
    const db = handle(this.cwd)
    const row = db
      .prepare(`SELECT value FROM task_meta WHERE key = ?`)
      .get(incarnationKey(sessionId)) as { value: string } | null | undefined
    if (row === null || row === undefined) return 1
    const n = Number(row.value)
    return Number.isSafeInteger(n) && n > 0 ? n : 1
  }

  /**
   * [PHASE 6Q] Invalidate every in-flight execution of this session id.
   *
   * Called by the canonical deletion operation BEFORE any row is removed, so that
   * an execution which returns after this point is refused rather than allowed to
   * write into a session that no longer exists - or into a later recreation of it.
   *
   * Idempotent-safe: bumping an already-bumped counter is harmless, and a session
   * that was never deleted keeps incarnation 1.
   */
  bumpSessionIncarnation(sessionId: string): number {
    const db = handle(this.cwd)
    const next = this.getSessionIncarnation(sessionId) + 1
    db.prepare(
      `INSERT INTO task_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(incarnationKey(sessionId), String(next))
    return next
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
  recordAttemptReturned(
    sessionId: string,
    taskId: string,
    execGeneration: number,
    /**
     * [PHASE 6Q] The incarnation the caller claimed under. Omitted = "assume the
     * current one", which preserves the pre-6Q behaviour for any caller that does
     * not track incarnations; the Scheduler always supplies it.
     */
    sessionIncarnation?: number,
  ): AttemptRecordOutcome {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    if (!Number.isSafeInteger(execGeneration) || execGeneration < 1) {
      throw new TaskError(
        "TASK_INVALID_ID",
        `execution generation must be a positive integer: ${execGeneration}`,
      )
    }
    const db = handle(this.cwd)

    // [PHASE 6Q] THE INCARNATION GUARD MUST PRECEDE THE WRITE.
    //
    // Checking it afterwards is not a weaker check, it is a wrong one: the guarded
    // UPDATE can MATCH A ROW THAT BELONGS TO A DIFFERENT SESSION LIFETIME, because
    // `taskId` restarts at `t1` for every incarnation and a fresh claim also
    // starts at `exec_generation = 1`. Observed during 6Q: with the check after
    // the write, a delete + recreate + re-claim sequence returned RECORDED and
    // stamped `attempt_generation` onto the RECREATED row.
    //
    // The check and the write share one transaction, so no other process can bump
    // the incarnation between them.
    return db.transaction((): AttemptRecordOutcome => {
      if (sessionIncarnation !== undefined) {
        if (this.getSessionIncarnation(sessionId) !== sessionIncarnation) {
          return "SESSION_SUPERSEDED"
        }
      }
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
      if (changes === 1) return "RECORDED"
      // The guard did not match. Nothing was written, so 6I's protection holds:
      // an outcome is never attributed to a generation that is not current. These
      // are results, not throws, because a throw is what wedged the Scheduler
      // (6N F2).
      const current = this.getTask(sessionId, taskId)
      if (current === null) return "TASK_GONE"
      return "SUPERSEDED"
    })()
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

  // ── [P14] CROSS-SESSION UNFINISHED WORK ─────────────────────────────────────
  //
  // Dua operasi, satu batas: discovery READ-ONLY, dan transfer yang menuntut
  // otoritas eksplisit di KEDUA sesi. Keduanya hidup di TaskStore karena
  // TaskStore adalah satu-satunya otoritas status task; modul orkestrasi di
  // atasnya hanya mengakuisisi lease dan menerjemahkan hasil.

  /**
   * [P14] Inventaris pekerjaan belum selesai di seluruh sesi WORKSPACE INI.
   *
   * Batas cakupan bukan pilihan bebas: `tasks.db` memang per-workspace
   * (`resolveLocalDbPath`), jadi query ini tidak bisa melihat sesi proyek lain.
   * Itu juga yang membuatnya aman dijalankan tanpa aturan merge lintas proyek.
   *
   * Operasi ini TIDAK PERNAH:
   *   - mengakuisisi lease/otoritas,
   *   - menulis baris, revisi, generasi, atau status,
   *   - menyimpulkan bahwa item "boleh dilanjutkan" (itu keputusan scheduler
   *     dengan continuity gate, bukan discovery).
   *
   * `transferredFromSessionId` diambil dari ledger agar operator bisa melihat
   * asal item yang sudah berpindah, tanpa menjadikan ledger sebagai otoritas
   * status kedua.
   */
  listUnfinishedWork(sessionId?: string): UnfinishedWorkItem[] {
    const db = handle(this.cwd)
    const statuses = sqlList(ADOPTABLE_STATUSES)
    const filter = sessionId === undefined ? "" : " AND t.session_id = ?"
    type OpenRow = TaskRow & {
      transferred_from_session_id: string | null
      transferred_at: string | null
    }
    const rows = db
      .prepare(
        `SELECT t.*,
                (SELECT tr.from_session_id
                   FROM task_transfers tr
                  WHERE tr.to_session_id = t.session_id AND tr.task_id = t.task_id
                  ORDER BY tr.transferred_at DESC, tr.rowid DESC
                  LIMIT 1) AS transferred_from_session_id,
                (SELECT tr.transferred_at
                   FROM task_transfers tr
                  WHERE tr.to_session_id = t.session_id AND tr.task_id = t.task_id
                  ORDER BY tr.transferred_at DESC, tr.rowid DESC
                  LIMIT 1) AS transferred_at
           FROM tasks t
          WHERE t.status IN (${statuses})${filter}
          ORDER BY t.session_id, t.task_order, t.task_id`,
      )
      .all(...(sessionId === undefined ? [] : [sessionId])) as OpenRow[]

    const incarnations = new Map<string, number>()
    return rows.map((r) => {
      let incarnation = incarnations.get(r.session_id)
      if (incarnation === undefined) {
        incarnation = this.getSessionIncarnation(r.session_id)
        incarnations.set(r.session_id, incarnation)
      }
      return {
        sessionId: r.session_id,
        sessionIncarnation: incarnation,
        task: rowToTask(r),
        execGeneration: r.exec_generation,
        attemptGeneration: r.attempt_generation,
        // Nilai asing TIDAK dipromosikan menjadi "scheduler": discovery harus
        // gagal-jujur, bukan menciptakan pemilik yang tidak ada.
        executionOwner: r.execution_owner === "scheduler" ? "scheduler" : null,
        transferredFromSessionId: r.transferred_from_session_id ?? null,
        transferredAt: r.transferred_at ?? null,
      }
    })
  }

  /**
   * [P14.0] Seluruh baris task lintas sesi — READ-ONLY, untuk inventaris.
   *
   * Tidak dipakai untuk keputusan status: TaskStore tetap satu-satunya
   * otoritas; inventaris hanya MENGHITUNG. Hasilnya tidak pernah menjadi
   * input jalur tulis, dan tidak menimpa semantik `listUnfinishedWork`
   * (yang tetap satu-satunya definisi "open").
   */
  listAllTasks(): { sessionId: string; task: Task }[] {
    const db = handle(this.cwd)
    const rows = db
      .prepare("SELECT * FROM tasks ORDER BY session_id, task_order, task_id")
      .all() as TaskRow[]
    return rows.map((r) => ({ sessionId: r.session_id, task: rowToTask(r) }))
  }

  /**
   * [P14] Baca ledger transfer. Append-only dan read-only; dipakai audit/CLI.
   *
   * Tidak ada `DELETE`/`UPDATE` ledger di API publik: satu-satunya penulis
   * adalah `transferTaskAuthority`, di dalam transaksi yang sama dengan
   * perpindahan baris.
   */
  listTaskTransfers(
    filter: { fromSessionId?: string; toSessionId?: string; taskId?: string } = {},
  ): TaskTransfer[] {
    const db = handle(this.cwd)
    const clauses: string[] = []
    const params: string[] = []
    if (filter.fromSessionId !== undefined) {
      clauses.push("from_session_id = ?")
      params.push(filter.fromSessionId)
    }
    if (filter.toSessionId !== undefined) {
      clauses.push("to_session_id = ?")
      params.push(filter.toSessionId)
    }
    if (filter.taskId !== undefined) {
      clauses.push("task_id = ?")
      params.push(filter.taskId)
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""
    const rows = db
      .prepare(
        `SELECT transfer_id        AS transferId,
                task_id            AS taskId,
                from_session_id    AS fromSessionId,
                from_incarnation   AS fromIncarnation,
                to_session_id      AS toSessionId,
                to_incarnation     AS toIncarnation,
                expected_revision  AS expectedRevision,
                new_revision       AS newRevision,
                status             AS status,
                exec_generation    AS execGeneration,
                attempt_generation AS attemptGeneration,
                execution_owner    AS executionOwner,
                transferred_at     AS transferredAt
           FROM task_transfers${where}
          ORDER BY transferred_at, rowid`,
      )
      .all(...params) as Array<{
      transferId: string
      taskId: string
      fromSessionId: string
      fromIncarnation: number
      toSessionId: string
      toIncarnation: number
      expectedRevision: number
      newRevision: number
      status: string
      execGeneration: number
      attemptGeneration: number | null
      executionOwner: string | null
      transferredAt: string
    }>
    return rows.map((r) => ({
      ...r,
      executionOwner: r.executionOwner === "scheduler" ? "scheduler" : null,
    }))
  }

  /**
   * [P14] Pindahkan SATU task unfinished ke sesi lain, dengan bukti otoritatif.
   *
   * Kontrak yang membuat operasi ini aman:
   *
   *   1. SATU transaksi. Pemeriksaan revisi/inkarnasi/status/relasi, UPDATE
   *      baris, dan INSERT ledger berbagi transaksi yang sama. Kegagalan
   *      ledger tidak boleh meninggalkan task sudah berpindah tanpa bukti.
   *   2. KEDUA lease harus dipegang token yang diberikan, diperiksa DI DALAM
   *      transaksi. Lease sumber yang sudah diambil alih proses lain membuat
   *      transfer gagal, bukan menebak bahwa pemilik lama sudah mati.
   *   3. Revisi + inkarnasi + generasi diperiksa ulang. Revisi TIDAK dipakai
   *      sebagai pengganti lineage; `exec_generation`/`attempt_generation`
   *      dipindahkan APA ADANYA sehingga target mewarisi bukti yang jujur.
   *   4. Task terminal/UNKNOWN tidak pernah diadopsi.
   *   5. Relasi hanya boleh menunjuk task yang SUDAH lebih dulu diadopsi dari
   *      sesi sumber yang sama (dibuktikan ledger). Menunjuk id yang kebetulan
   *      ada di target akan menyatukan dua tugas berbeda — dilarang.
   *   6. Task id TIDAK PERNAH diganti. Tabrakan id di target = tolak eksplisit,
   *      bukan renumber diam-diam.
   *
   * Yang TIDAK dilakukan: tidak membuat generasi baru, tidak menandai selesai,
   * tidak menghapus attempt marker, tidak menyentuh jurnal runtime/child run.
   * Eksekusi baru hanya lahir dari claim baru di sesi tujuan, setelah
   * continuity gate memutuskan apakah retry aman.
   */
  transferTaskAuthority(req: TaskTransferRequest): TaskTransferResult {
    if (!isTaskId(req.taskId)) {
      throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${req.taskId}`)
    }
    const refuse = (
      outcome: TaskTransferOutcome,
      detail: string,
      task: Task | null = null,
      unresolvedRelations: readonly string[] = [],
    ): TaskTransferResult => ({ outcome, task, transfer: null, detail, unresolvedRelations })

    if (req.fromSessionId.length === 0 || req.toSessionId.length === 0) {
      return refuse("NOT_FOUND", "source and target session ids must be non-empty")
    }
    if (req.fromSessionId === req.toSessionId) {
      return refuse("REFUSED_SELF_TRANSFER", "source and target sessions are identical")
    }

    const db = handle(this.cwd)
    const now = req.now ?? Date.now()
    return db.transaction((): TaskTransferResult => {
      const sourceIncarnation = this.getSessionIncarnation(req.fromSessionId)
      if (sourceIncarnation !== req.fromIncarnation) {
        return refuse(
          "REJECTED_STALE_SOURCE_INCARNATION",
          `source incarnation moved: expected ${req.fromIncarnation}, found ${sourceIncarnation}`,
        )
      }
      const targetIncarnation = this.getSessionIncarnation(req.toSessionId)
      if (targetIncarnation !== req.toIncarnation) {
        return refuse(
          "REJECTED_STALE_TARGET_INCARNATION",
          `target incarnation moved: expected ${req.toIncarnation}, found ${targetIncarnation}`,
        )
      }

      const raw = db
        .prepare("SELECT * FROM tasks WHERE session_id = ? AND task_id = ?")
        .get(req.fromSessionId, req.taskId) as TaskRow | null
      if (raw === null) {
        return refuse("NOT_FOUND", `no task ${req.taskId} in ${req.fromSessionId}`)
      }
      if (raw.revision !== req.expectedRevision) {
        return refuse(
          "REJECTED_STALE_REVISION",
          `${req.taskId} is at revision ${raw.revision}, expected ${req.expectedRevision}`,
          rowToTask(raw),
        )
      }

      // Urutan sengaja: revisi dulu (murah, menentukan), lalu otoritas. Token
      // yang tidak memegang lease tidak boleh belajar status task lewat pesan
      // yang lebih spesifik.
      if (!this.holdsSessionAuthority(req.fromSessionId, req.sourceOwnerToken, now)) {
        return refuse(
          "REFUSED_NO_SOURCE_AUTHORITY",
          `source lease for ${req.fromSessionId} is not held by the presented token`,
        )
      }
      if (!this.holdsSessionAuthority(req.toSessionId, req.targetOwnerToken, now)) {
        return refuse(
          "REFUSED_NO_TARGET_AUTHORITY",
          `target lease for ${req.toSessionId} is not held by the presented token`,
        )
      }

      if (!isTaskStatus(raw.status)) {
        return refuse("REFUSED_CORRUPT_STATE", `unknown task status: ${raw.status}`, rowToTask(raw))
      }
      if (!ADOPTABLE_STATUS_SET.has(raw.status)) {
        return refuse(
          "REFUSED_STATUS",
          `status ${raw.status} is terminal and cannot be adopted`,
          rowToTask(raw),
        )
      }

      // Lineage yang tidak mungkin = HOLD, bukan tebakan. Sama seperti
      // reconcile: attempt > exec tidak punya penafsiran yang aman.
      if (!Number.isSafeInteger(raw.exec_generation) || raw.exec_generation < 0) {
        return refuse("REFUSED_CORRUPT_STATE", "exec_generation is not a non-negative integer")
      }
      if (
        raw.attempt_generation !== null &&
        (!Number.isSafeInteger(raw.attempt_generation) || raw.attempt_generation < 0)
      ) {
        return refuse("REFUSED_CORRUPT_STATE", "attempt_generation is not a non-negative integer")
      }
      if (raw.attempt_generation !== null && raw.attempt_generation > raw.exec_generation) {
        return refuse(
          "REFUSED_CORRUPT_STATE",
          `attempt_generation ${raw.attempt_generation} exceeds exec_generation ${raw.exec_generation}`,
        )
      }
      if (raw.attempt_generation !== null && raw.exec_generation === 0) {
        return refuse(
          "REFUSED_CORRUPT_STATE",
          "attempt marker exists without an execution generation",
        )
      }
      if (raw.execution_owner !== null && raw.execution_owner !== "scheduler") {
        return refuse("REFUSED_CORRUPT_STATE", `unknown execution_owner: ${raw.execution_owner}`)
      }
      if (raw.execution_owner === "scheduler") {
        if (raw.status !== "IN_PROGRESS" && raw.status !== "VERIFYING") {
          return refuse(
            "REFUSED_CORRUPT_STATE",
            `scheduler ownership is inconsistent with status ${raw.status}`,
          )
        }
        if (raw.exec_generation < 1) {
          return refuse("REFUSED_CORRUPT_STATE", "scheduler ownership without a claim generation")
        }
      }

      // Relasi harus menunjuk task yang SUDAH berpindah dari sumber yang sama.
      // Keberadaan id semata tidak cukup: id task berulang per sesi, jadi id
      // yang sama di target bisa merupakan tugas yang sama sekali berbeda.
      const deps = parseStringArrayStrict(raw.depends_on_json)
      if (deps === null) {
        return refuse("REFUSED_CORRUPT_STATE", "depends_on_json is not a string array")
      }
      const relations = new Set<string>()
      if (raw.parent_id !== null) relations.add(raw.parent_id)
      for (const d of deps) relations.add(d)
      const unresolved: string[] = []
      const relationExistsInTarget = db.prepare(
        "SELECT 1 FROM tasks WHERE session_id = ? AND task_id = ?",
      )
      const relationWasAdopted = db.prepare(
        `SELECT 1 FROM task_transfers
          WHERE from_session_id = ? AND to_session_id = ? AND task_id = ?
          LIMIT 1`,
      )
      for (const relation of relations) {
        if (!isTaskId(relation) || relation === req.taskId) {
          return refuse("REFUSED_CORRUPT_STATE", `invalid or self relation: ${relation}`)
        }
        const exists = relationExistsInTarget.get(req.toSessionId, relation)
        if (exists === undefined || exists === null) {
          unresolved.push(relation)
          continue
        }
        const adopted = relationWasAdopted.get(req.fromSessionId, req.toSessionId, relation)
        if (adopted === undefined || adopted === null) unresolved.push(relation)
      }
      if (unresolved.length > 0) {
        return refuse(
          "REFUSED_UNRESOLVED_RELATION",
          `relations must be adopted first from ${req.fromSessionId}: ${unresolved.join(", ")}`,
          rowToTask(raw),
          unresolved,
        )
      }

      // Tabrakan id adalah penolakan eksplisit. Renumber akan mengubah identitas
      // yang dipegang evidence/dependency dan menyembunyikan konflik.
      const collision = db
        .prepare("SELECT 1 FROM tasks WHERE session_id = ? AND task_id = ?")
        .get(req.toSessionId, req.taskId)
      if (collision !== undefined && collision !== null) {
        return refuse(
          "REFUSED_TARGET_ID_CONFLICT",
          `${req.taskId} already exists in ${req.toSessionId}; ids are never renumbered`,
          rowToTask(raw),
        )
      }

      // Posisi tampilan di target: append. Urutan bukan identitas dan bukan
      // dependency; menyalin urutan sumber bisa membuat dua baris berbagi
      // nomor yang sama tanpa alasan.
      const maxRow = db
        .prepare("SELECT MAX(task_order) AS m FROM tasks WHERE session_id = ?")
        .get(req.toSessionId) as { m: number | null } | null
      const nextOrder = (maxRow?.m ?? 0) + 1
      const transferredAt = nowIso()

      // SATU UPDATE: seluruh kolom dipertahankan; hanya namespace, posisi
      // tampilan, revisi (mutasi nyata), dan timestamp yang berubah. Lineage
      // dan status TIDAK disentuh.
      const moved = db
        .prepare(
          `UPDATE tasks
              SET session_id = ?, task_order = ?, revision = revision + 1, updated_at = ?
            WHERE session_id = ? AND task_id = ? AND revision = ?`,
        )
        .run(
          req.toSessionId,
          nextOrder,
          transferredAt,
          req.fromSessionId,
          req.taskId,
          req.expectedRevision,
        )
      if (moved.changes !== 1) {
        // Normalnya mustahil di dalam transaksi; tetap ditangani sebagai
        // klasifikasi, bukan dianggap sukses.
        return refuse("REJECTED_STALE_REVISION", "task moved while transfer was being prepared")
      }

      const transfer: TaskTransfer = {
        transferId: randomUUID(),
        taskId: req.taskId,
        fromSessionId: req.fromSessionId,
        fromIncarnation: req.fromIncarnation,
        toSessionId: req.toSessionId,
        toIncarnation: req.toIncarnation,
        expectedRevision: req.expectedRevision,
        newRevision: req.expectedRevision + 1,
        status: raw.status,
        execGeneration: raw.exec_generation,
        attemptGeneration: raw.attempt_generation,
        executionOwner: raw.execution_owner === "scheduler" ? "scheduler" : null,
        transferredAt,
      }
      try {
        db.prepare(
          `INSERT INTO task_transfers
             (transfer_id, task_id, from_session_id, from_incarnation, to_session_id,
              to_incarnation, expected_revision, new_revision, status, exec_generation,
              attempt_generation, execution_owner, transferred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          transfer.transferId,
          transfer.taskId,
          transfer.fromSessionId,
          transfer.fromIncarnation,
          transfer.toSessionId,
          transfer.toIncarnation,
          transfer.expectedRevision,
          transfer.newRevision,
          transfer.status,
          transfer.execGeneration,
          transfer.attemptGeneration,
          transfer.executionOwner,
          transfer.transferredAt,
        )
      } catch (e) {
        // Jangan telan: transaksi akan rollback, dan pesan ini adalah bukti
        // bahwa transfer TIDAK berlaku.
        throw new TaskError(
          "TASK_PERSISTENCE_FAILURE",
          `transfer ledger write failed: ${(e as Error).message}`,
        )
      }

      return {
        outcome: "TRANSFERRED",
        task: this.getTask(req.toSessionId, req.taskId),
        transfer,
        detail: `moved ${req.taskId} from ${req.fromSessionId} to ${req.toSessionId}`,
        unresolvedRelations: [],
      }
    })()
  }

  /**
   * [P14.3] Baca ledger dedup. Append-only dan read-only; dipakai audit/CLI.
   */
  listTaskMerges(
    filter: { sessionId?: string; survivorId?: string; duplicateId?: string } = {},
  ): TaskMerge[] {
    const db = handle(this.cwd)
    const clauses: string[] = []
    const params: string[] = []
    if (filter.sessionId !== undefined) {
      clauses.push("session_id = ?")
      params.push(filter.sessionId)
    }
    if (filter.survivorId !== undefined) {
      clauses.push("survivor_id = ?")
      params.push(filter.survivorId)
    }
    if (filter.duplicateId !== undefined) {
      clauses.push("duplicate_id = ?")
      params.push(filter.duplicateId)
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""
    const rows = db
      .prepare(
        `SELECT merge_id          AS mergeId,
                session_id        AS sessionId,
                survivor_id       AS survivorId,
                duplicate_id      AS duplicateId,
                evidence          AS evidence,
                survivor_status   AS survivorStatus,
                duplicate_status  AS duplicateStatus,
                duplicate_revision AS duplicateRevision,
                merged_at         AS mergedAt
           FROM task_merges${where}
          ORDER BY merged_at, rowid`,
      )
      .all(...params) as TaskMerge[]
    return rows
  }

  /**
   * [P14.3] Deklarasikan EKSPLISIT bahwa satu task adalah duplikat unit kerja
   * dari task lain di SESI YANG SAMA, lalu tutup duplikat sebagai CANCELLED.
   *
   * Kontrak yang membuat operasi ini aman:
   *
   *   1. EVIDENCE WAJIB. Kemiripan judul bukan bukti — operator menulis
   *      alasannya dan teks itu masuk ledger utuh. Tidak ada jalur otomatis
   *      ke fungsi ini (proyeksi hanya MENANDAI kandidat serupa sebagai
   *      UNPROVEN; ia tidak pernah menyatukan).
   *   2. Duplikat ditutup CANCELLED, BUKAN COMPLETED. "Sudah dikerjakan di
   *      task lain" adalah keputusan operator; menulis COMPLETED akan menjadi
   *      inferisi penyelesaian yang dilarang P14. CANCELLED = unit ini
   *      ditarik sebagai kerja terpisah, status kanonik tetap jujur.
   *   3. Penulisan status lewat `patchTask` — penulis lifecycle yang SAMA
   *      dengan jalur model/operator (revisi maju, ownership dilepas saat
   *      keluar dari status in-flight). Tidak ada jalur tulis kedua.
   *   4. SATU transaksi (`withTransaction`): patch + INSERT ledger berjalan
   *      bersama. Kegagalan ledger = status duplikat ikut rollback.
   *   5. Duplikat terminal ditolak: pekerjaan yang sudah ditutup tidak
   *      dibuka ulang hanya untuk ditutup lagi. Survivor BOLEH terminal —
   *      kasus klasik dedup adalah "task pending ini ternyata sudah
   *      dikerjakan task yang selesai".
   *   6. Antar-sesi ditolak: pindahkan otoritasnya dulu lewat
   *      `transferTaskAuthority` (adopsi), baru merge di satu namespace.
   *
   * Pembalikan kesalahan tetap jujur: ledger append-only (deklarasi tetap
   * tercatat selamanya), dan status kini-duplikat boleh dibuka kembali
   * operator lewat penulisan lifecycle biasa — status saat itulah kebenaran,
   * ledger hanyalah sejarah keputusan.
   */
  declareTaskDuplicate(req: TaskDuplicateRequest): TaskDuplicateResult {
    const refuse = (
      outcome: TaskDuplicateOutcome,
      detail: string,
      survivor: Task | null = null,
    ): TaskDuplicateResult => ({
      outcome,
      detail,
      duplicate: null,
      survivor,
      merge: null,
    })

    if (!isTaskId(req.survivorId) || !isTaskId(req.duplicateId)) {
      throw new TaskError(
        "TASK_INVALID_ID",
        `not canonical ids: ${req.survivorId}/${req.duplicateId}`,
      )
    }
    if (req.survivorId === req.duplicateId) {
      return refuse("REFUSED_SELF_MERGE", "a task cannot be a duplicate of itself")
    }
    const evidence = req.evidence.trim()
    if (evidence.length === 0) {
      return refuse(
        "REFUSED_NO_EVIDENCE",
        "dedup requires operator evidence — similar wording is not proof",
      )
    }
    const survivor = this.getTask(req.sessionId, req.survivorId)
    if (survivor === null) {
      return refuse("NOT_FOUND", `no task ${req.survivorId} in ${req.sessionId}`)
    }
    const duplicate = this.getTask(req.sessionId, req.duplicateId)
    if (duplicate === null) {
      return refuse("NOT_FOUND", `no task ${req.duplicateId} in ${req.sessionId}`, survivor)
    }
    if (duplicate.status === "COMPLETED" || duplicate.status === "CANCELLED") {
      return refuse(
        "REFUSED_TERMINAL_DUPLICATE",
        `${req.duplicateId} is already ${duplicate.status} — closed work is never reopened to be closed again`,
        survivor,
      )
    }
    if (req.expectedRevision !== undefined && req.expectedRevision !== duplicate.revision) {
      return refuse(
        "REJECTED_STALE_REVISION",
        `${req.duplicateId} is at revision ${duplicate.revision}, expected ${req.expectedRevision}`,
        survivor,
      )
    }

    // SATU transaksi: patchTask (penulis lifecycle yang sudah ada) + ledger
    // digabung oleh boundary Phase 4A.2 — nested db.transaction di bun adalah
    // savepoint yang bergabung, bukan transaksi terpisah.
    return this.withTransaction((): TaskDuplicateResult => {
      // Baca ulang DI DALAM transaksi: dunia boleh bergerak antara
      // pemeriksaan di atas dan titik tulis.
      const current = this.getTask(req.sessionId, req.duplicateId)
      if (current === null) {
        return refuse("NOT_FOUND", `${req.duplicateId} vanished while merge was prepared`)
      }
      if (current.status === "COMPLETED" || current.status === "CANCELLED") {
        return refuse(
          "REFUSED_TERMINAL_DUPLICATE",
          `${req.duplicateId} became ${current.status} while merge was prepared`,
        )
      }
      const survivorNow = this.getTask(req.sessionId, req.survivorId)
      if (survivorNow === null) {
        return refuse("NOT_FOUND", `${req.survivorId} vanished while merge was prepared`)
      }
      let patched: Task
      try {
        patched = this.patchTask(
          req.sessionId,
          req.duplicateId,
          { status: "CANCELLED" },
          req.expectedRevision !== undefined ? { expectedRevision: req.expectedRevision } : {},
        )
      } catch (e) {
        // Stale di jendela race = klasifikasi, bukan crash. Error TaskStore
        // lain (persistence, dependency) tetap dilempar — jangan ditelan.
        if (e instanceof TaskError && e.code === "TASK_STALE_REVISION") {
          return refuse(
            "REJECTED_STALE_REVISION",
            `${req.duplicateId} moved while merge was being prepared`,
            survivorNow,
          )
        }
        throw e
      }

      const merge: TaskMerge = {
        mergeId: randomUUID(),
        sessionId: req.sessionId,
        survivorId: req.survivorId,
        duplicateId: req.duplicateId,
        evidence,
        survivorStatus: survivorNow.status,
        duplicateStatus: patched.status,
        duplicateRevision: patched.revision,
        mergedAt: patched.updatedAt,
      }
      const db = handle(this.cwd)
      try {
        db.prepare(
          `INSERT INTO task_merges
             (merge_id, session_id, survivor_id, duplicate_id, evidence,
              survivor_status, duplicate_status, duplicate_revision, merged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          merge.mergeId,
          merge.sessionId,
          merge.survivorId,
          merge.duplicateId,
          merge.evidence,
          merge.survivorStatus,
          merge.duplicateStatus,
          merge.duplicateRevision,
          merge.mergedAt,
        )
      } catch (e) {
        throw new TaskError(
          "TASK_PERSISTENCE_FAILURE",
          `merge ledger write failed: ${(e as Error).message}`,
        )
      }
      return {
        outcome: "DECLARED",
        duplicate: patched,
        survivor: this.getTask(req.sessionId, req.survivorId),
        merge,
        detail: `closed ${req.duplicateId} as duplicate of ${req.survivorId} (CANCELLED, not COMPLETED)`,
      }
    })
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
  // â”€â”€ [PHASE 6X] session-level autonomous authority (6W ADR-20/21) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  //
  // [DESIGN DECISION] The lease is a SESSION fact, kept deliberately separate from
  // the tasks table and from 6Q's per-task lineage. The two layers never read each
  // other, so authority can never be half-updated alongside a task row.
  //
  // Its existence is NOT evidence of liveness - it is a bounded claim on the right
  // to schedule. That distinction is the whole fix for 6V FINDING-02, which needed
  // two reconcilers to coexist on one session so one could revert the other's live
  // execution. Exactly one of them can hold this row at a time.

  /**
   * Read the authority record for a session's current incarnation, or null.
   *
   * [DESIGN DECISION] Fail-closed on an undecodable row: it reads as "no authority
   * exists", the safe direction for a caller deciding whether it may schedule. It is
   * NOT treated as free for a *renewal*, which additionally requires our own token.
   */
  getSessionAuthority(sessionId: string, incarnation?: number): SessionAuthority | null {
    const inc = incarnation ?? this.getSessionIncarnation(sessionId)
    const row = handle(this.cwd)
      .prepare(
        `SELECT owner_token AS ownerToken,
                owner_pid AS ownerPid,
                acquired_at AS acquiredAt,
                lease_expires_at AS leaseExpiresAt,
                incarnation
           FROM session_authority
          WHERE session_id = ? AND incarnation = ?`,
      )
      .get(sessionId, inc) as Record<string, unknown> | undefined | null
    if (row === undefined || row === null) return null
    return {
      sessionId,
      incarnation: Number(row.incarnation),
      ownerToken: String(row.ownerToken),
      ownerPid: Number(row.ownerPid),
      acquiredAt: Number(row.acquiredAt),
      leaseExpiresAt: Number(row.leaseExpiresAt),
    }
  }

  /**
   * Take the lease, or renew it, in ONE atomic statement.
   *
   * [DESIGN DECISION] This is the mutual-exclusion primitive, so it must be one SQL
   * statement. Split into a read-then-write it would reintroduce precisely the race
   * F02 needed, and a concurrent pair of acquirers would then have two winners.
   *
   * The `ON CONFLICT ... WHERE` clause is the whole trick: the upsert lands only when
   * no row exists, or when the existing row is still OURS. A live lease belonging to
   * somebody else fails the WHERE, is left untouched, and `changes` reports 0.
   */
  acquireSessionAuthority(
    sessionId: string,
    ownerToken: string,
    leaseMs: number,
    now = Date.now(),
  ): "ACQUIRED" | "REFUSED_LEASE_HELD" {
    const inc = this.getSessionIncarnation(sessionId)
    const result = handle(this.cwd)
      .prepare(
        `INSERT INTO session_authority
           (session_id, incarnation, owner_token, owner_pid, acquired_at, lease_expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, incarnation) DO UPDATE SET
           -- [PHASE 6X] owner_token MUST be updated here, not just the deadline.
           -- On a takeover the new owner has to become the recorded owner, or the
           -- row would keep naming the previous owner while its lease was extended -
           -- so the old token would still pass holdsSessionAuthority and both
           -- parties would believe they were authoritative.
           owner_token      = excluded.owner_token,
           owner_pid        = excluded.owner_pid,
           acquired_at      = excluded.acquired_at,
           lease_expires_at = excluded.lease_expires_at
         WHERE session_authority.owner_token = excluded.owner_token
            OR session_authority.lease_expires_at <= ?`,
      )
      .run(sessionId, inc, ownerToken, process.pid, now, now + leaseMs, now)
    return result.changes === 1 ? "ACQUIRED" : "REFUSED_LEASE_HELD"
  }

  /**
   * Extend OUR lease. Refused when the token is not the current owner's, which is
   * what stops a paused or partitioned process from reclaiming a session whose lease
   * has already been taken over.
   */
  renewSessionAuthority(
    sessionId: string,
    ownerToken: string,
    leaseMs: number,
    now = Date.now(),
  ): "AUTHORITY_HELD" | "AUTHORITY_LOST" {
    const inc = this.getSessionIncarnation(sessionId)
    const result = handle(this.cwd)
      .prepare(
        `UPDATE session_authority
            SET lease_expires_at = ?
          WHERE session_id = ? AND incarnation = ? AND owner_token = ?`,
      )
      .run(now + leaseMs, sessionId, inc, ownerToken)
    return result.changes === 1 ? "AUTHORITY_HELD" : "AUTHORITY_LOST"
  }

  /**
   * Give the lease back.
   *
   * [DESIGN DECISION] A clean stop is an unambiguous handover, so the row is DELETED
   * rather than left to expire. Keeping it would leave a released session with an
   * "authority record" a later reader could mistake for a live owner. The EXPIRY
   * path is the one that preserves the row, so a crashed owner's takeover history
   * stays inspectable.
   *
   * Token-guarded, so a stale instance can only ever fail to release - never evict
   * the successor that holds the session now.
   */
  releaseSessionAuthority(sessionId: string, ownerToken: string): boolean {
    const inc = this.getSessionIncarnation(sessionId)
    const result = handle(this.cwd)
      .prepare(
        `DELETE FROM session_authority
          WHERE session_id = ? AND incarnation = ? AND owner_token = ?`,
      )
      .run(sessionId, inc, ownerToken)
    return result.changes === 1
  }

  /**
   * Is OUR authority still valid right now?
   *
   * The single predicate every scheduling boundary consults. A lease is ACTIVE while
   * `lease_expires_at > now`; the strict inequality means an expired row is already
   * free, so expiry and takeover can never both succeed at the same instant.
   */
  holdsSessionAuthority(sessionId: string, ownerToken: string, now = Date.now()): boolean {
    const a = this.getSessionAuthority(sessionId)
    return a !== null && a.ownerToken === ownerToken && a.leaseExpiresAt > now
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
