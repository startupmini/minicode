// Task model types — the *domain* half of Phase 1.
//
// EVIDENCE NOTE. This file did NOT survive the wipe: there is no
// `model.orig.ts` artifact and no `src/task/` in the recovered baseline. It is
// reconstructed from the only two surviving sources of truth about it:
//
//   1. `store.orig.ts` — the actual pre-wipe implementation. Every field below
//      is pinned by `TaskRow` + `rowToTask()` + the construction sites in
//      `synchronizeTasks()`. Where the artifact *uses* a field, that field is
//      PROVEN, not guessed.
//   2. `docs/TASK_IDENTITY_SPEC.md` + `docs/TASK_STATE_MACHINE_SPEC.md` —
//      in-repo design docs committed at baseline HEAD (`aa76dfb`).
//
// The two sources DISAGREE, and the disagreement is recorded rather than
// smoothed over:
//
//   | aspect        | design doc                    | store.orig.ts (ACTUAL) |
//   |---------------|-------------------------------|------------------------|
//   | status casing | lowercase ("pending")         | UPPERCASE ("PENDING")  |
//   | blocker       | `blocker: TaskBlocker` object | `blockedReason: string`|
//   | timestamps    | `createdAt: number`           | `createdAt: string` ISO|
//   | verification  | `at: number`                  | `checkedAt: string`    |
//   | provenance    | `{source, actor, at}`         | `{origin, source}`     |
//   | titleKey      | present                       | ABSENT                 |
//   | revision      | ABSENT                        | present                |
//
// The artifact wins. It is later evidence and it is the code that actually
// ran. The doc is DESIGN-mode and predates the implementation.
//
// Every inference below is tagged `[INFERRED]`. Everything untagged is proven
// by `store.orig.ts`.

/**
 * Task lifecycle states.
 *
 * PROVEN by artifact usage: `PENDING` (the `rowToTask` fallback), `BLOCKED`
 * (the only status compared in `validate()`), `CANCELLED` (named in the
 * `deleteTask` comment as the sanctioned alternative to deletion).
 *
 * [INFERRED] the remaining five, from `docs/TASK_STATE_MACHINE_SPEC.md` which
 * states the enum is "diperluas dari 5 ke 8" and lists them lowercase. Uppercased
 * to match the artifact's casing convention. None is ever written by the store
 * itself; they only widen what `isTaskStatus` accepts.
 */
export type TaskStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "VERIFYING"
  | "BLOCKED"
  | "FAILED"
  | "RETRYING"
  | "COMPLETED"
  | "CANCELLED"

const TASK_STATUSES: readonly TaskStatus[] = [
  "PENDING",
  "IN_PROGRESS",
  "VERIFYING",
  "BLOCKED",
  "FAILED",
  "RETRYING",
  "COMPLETED",
  "CANCELLED",
]

/** PROVEN: `rowToTask` calls this to decide whether a stored status is valid. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && TASK_STATUSES.includes(value as TaskStatus)
}

/**
 * Canonical task id = `t<n>`, `<n>` monotonic from 1, per session.
 *
 * `taskIdFromIndex` is the inverse of what `nextId()` needs. `nextId()` starts
 * its running max at `0` and returns `taskIdFromIndex(max)`, so for an EMPTY
 * session (max = 0) the very first id must be `t1` — therefore the index is
 * 1-based and the mapping is `n -> t(n+1)`. This also reproduces the
 * artifact's own worked example: `t1,t2,t5` -> max 5 -> `t6`, not `t3`.
 */
export function taskIdFromIndex(index: number): string {
  return `t${index + 1}`
}

/**
 * [INFERRED] Strict guard for a canonical id. `docs/TASK_IDENTITY_SPEC.md` fixes
 * the form as `t<n>` starting at 1, so `t0`, `t01` and `t-1` are all rejected.
 * `store.orig.ts` relies on this to reject model-supplied ids before they can
 * reach SQL, and `nextId()` re-parses with `Number(id.slice(1))`, which only
 * round-trips cleanly for `^t[1-9][0-9]*$`.
 */
const TASK_ID_RE = /^t[1-9][0-9]*$/

/** PROVEN: guard used by `getTask`, `patchTask`, `deleteTask`. */
export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && TASK_ID_RE.test(value)
}

/**
 * Verification record attached to a task.
 *
 * PROVEN from the artifact's only construction site
 * (`synchronizeTasks`): `{ verdict, detail?, checkedAt }` where `checkedAt` is
 * an ISO string from `nowIso()`. Note the field is `checkedAt`, NOT the
 * `at: number` the design doc proposed — artifact wins.
 */
export interface TaskVerification {
  verdict: "passed" | "failed" | "unverified"
  detail?: string
  checkedAt: string
}

export type TaskEvidenceKind =
  | "completion"
  | "receipt"
  | "test"
  | "verify"
  | "checkpoint"
  | "file"

/**
 * Evidence record appended on every synchronization.
 *
 * PROVEN from the artifact's construction site: `{ kind: "completion", detail,
 * at }` with `at` an ISO string.
 *
 * [INFERRED] the wider kind union, from `docs/TASK_STATE_MACHINE_SPEC.md`
 * (`EvidenceKind`). The store only ever writes `"completion"`; the rest exist so
 * a later phase can name evidence without another migration.
 */
export interface TaskEvidence {
  kind: TaskEvidenceKind
  detail: string
  at: string
}

/**
 * [INFERRED] Acceptance criteria.
 *
 * UNRECOVERABLE SHAPE: the artifact stores and returns this value but never
 * reads a field from it and never constructs a non-null one, so its real shape
 * is unrecoverable. Modelled as an opaque record — the store round-trips it
 * verbatim via JSON and deliberately interprets nothing. Guessing concrete
 * fields here would be pure invention with no behavioural consequence.
 */
export type TaskAcceptance = Record<string, unknown>

/**
 * Where a task came from.
 *
 * PROVEN from the artifact: the `rowToTask` default is
 * `{ origin: "runtime", source: "unknown" }` and `synchronizeTasks` writes
 * `{ origin: "model", source: "todo_write" }`. So `origin` is a closed
 * two-value union and `source` is an open string.
 */
export interface TaskProvenance {
  origin: "runtime" | "model"
  source: string
}

/**
 * One durable task row.
 *
 * PROVEN field-for-field by `rowToTask()`, which is the authoritative
 * projection: the DB column set and this object are in 1:1 correspondence.
 * `sessionId` and `revision` do not appear in the design doc at all — they
 * exist only in the artifact, and `revision` is the stale-write substrate
 * Phase 1 must preserve.
 */
export interface Task {
  /** Stable, canonical `t<n>`, allocated by the store. Never reused. */
  id: string
  sessionId: string
  title: string
  status: TaskStatus
  /** Display order only. Mutable; explicitly NOT identity. */
  order: number
  parentId: string | null
  dependsOn: string[]
  /** Required whenever `status === "BLOCKED"` (PF-04). */
  blockedReason: string | null
  verification: TaskVerification | null
  evidence: TaskEvidence[]
  acceptance: TaskAcceptance | null
  provenance: TaskProvenance
  /** ISO-8601 strings, not epoch numbers. */
  createdAt: string
  updatedAt: string
  /** Starts at 1; incremented by every successful mutation. */
  revision: number
}

/** PROVEN: `getSnapshot()` returns exactly this. */
export interface TaskSnapshot {
  sessionId: string
  tasks: Task[]
}

/** Error codes the artifact actually raises, plus nothing invented. */
export type TaskErrorCode =
  | "TASK_DB_INIT_FAILURE"
  | "TASK_INVALID_ID"
  | "TASK_INVALID_DEPENDENCY"
  | "TASK_INVALID_TRANSITION"
  | "TASK_NOT_FOUND"
  | "TASK_PERSISTENCE_FAILURE"
  | "TASK_DUPLICATE_ID"
  | "TASK_STALE_REVISION"
  | "TASK_MIGRATION_FAILURE"
  | "TASK_TX_ACTIVE"
  // PHASE 4A.5: a full declaration that carries no canonical identity at all,
  // submitted to a session that ALREADY has canonical tasks. Distinct from
  // TASK_INVALID_ID on purpose: no id was malformed, the payload simply lacks the
  // information required to address existing canonical state safely.
  | "TASK_IDENTITY_REQUIRED"

/**
 * Domain error. `code` is the stable, machine-checkable discriminator; the
 * message stays human-facing. Extends `Error` so existing
 * `catch (e) { (e as Error).message }` call sites keep working unchanged.
 */
export class TaskError extends Error {
  readonly code: TaskErrorCode
  constructor(code: TaskErrorCode, message: string) {
    super(message)
    this.name = "TaskError"
    this.code = code
  }
}
