// Canonical task IDENTITY substrate — Phase 3A.
//
// THIS IS A RECONSTRUCTION, NOT A RECOVERY. There is no surviving source for
// `src/task/identity.ts` or `src/task/normalize.ts`, and the Phase 2 artifact
// (`todo.orig.ts`) contains ZERO occurrences of `taskId`, `ordinal`,
// `address`, `resolveTask`, `TaskStore` or `synchronizeTasks`. Nothing in this
// file may be described as "recovered".
//
// It is reconstructed from two real sources:
//
//   1. VERIFIED FROM CURRENT SOURCE — the Phase 1 TaskStore is the one and only
//      allocator (`nextId` uses `max`, not `count`; `createTask` inserts
//      `revision = 1`; the primary key is `(session_id, task_id)`). This file
//      DELEGATES to it and never allocates an id of its own.
//
//   2. RECONSTRUCTED FROM HISTORY — the behaviour that was deferred in Phase 1
//      lives in `store.orig.ts`'s `synchronizeTasks`, whose guard clauses are
//      quoted at each rule below. That is genuine recovered evidence for the
//      RULES, even though the Phase 3 wiring is gone.
//
// NOT IN SCOPE (Phase 3B): `TodoItem.taskId` propagation, `PlanStep.taskId`,
// `plan.updated` payloadVersion=2, the plan pipeline, TaskGraph, Scheduler.
// `DeclaredTask` below is this layer's own input contract precisely so that
// `TodoItem` is NOT modified here.

import type { TodoStatus } from "../tools/todo.ts"
import { isTaskId, type Task, type TaskStatus, TaskError } from "./model.ts"
import type { NewTaskInput, TaskStore } from "./store.ts"

// ── status mapping ───────────────────────────────────────────────────────────

/**
 * Legacy todo status -> canonical Task status.
 *
 * RECONSTRUCTED FROM HISTORY: `store.orig.ts:501` calls exactly this -
 * `todoStatusToTask(item.status as TodoStatus)`.
 *
 * [INFERRED] The 1:1 mapping. The CALL is recovered; the mapping body is not in
 * any surviving source. It is the only mapping consistent with the surviving
 * `TaskStatus` union in `model.ts`, which contains all five uppercase spellings
 * of the five legacy statuses.
 */
export function todoStatusToTask(status: TodoStatus): TaskStatus {
  switch (status) {
    case "pending":
      return "PENDING"
    case "in_progress":
      return "IN_PROGRESS"
    case "completed":
      return "COMPLETED"
    case "cancelled":
      return "CANCELLED"
    case "blocked":
      return "BLOCKED"
  }
}

// ── the declared shape ───────────────────────────────────────────────────────

/**
 * One item as declared by a caller. Deliberately NOT `TodoItem`: attaching
 * `taskId` to `TodoItem` is Phase 3B plan-pipeline work.
 */
export interface DeclaredTask {
  /** Canonical `t<n>` addressing an existing task, or absent for a new task. */
  taskId?: string
  title: string
  status: TodoStatus
  blockedReason?: string
}

export type IdentityKind = "existing" | "new"

export interface IdentityPlanEntry {
  kind: IdentityKind
  /** Present iff `kind === "existing"`. Already validated canonical. */
  taskId?: string
  /** Position in the declared list, which becomes display `order`. */
  order: number
  status: TaskStatus
  title: string
  blockedReason: string | null
  /** NEW TASK INPUT, ready for `TaskStore.createTask`. Absent for existing. */
  input?: NewTaskInput
}

export interface TaskIdentityPlan {
  entries: IdentityPlanEntry[]
  /** Ids that must already exist in the session before anything is written. */
  requiredExisting: string[]
}

export interface ApplyOutcome {
  existing: Task[]
  created: Task[]
}

// ── planning: pure, no I/O, no allocation ────────────────────────────────────

/**
 * Resolve declared items to identity, WITHOUT touching the store and WITHOUT
 * allocating any id. Allocation belongs to `TaskStore` and nowhere else.
 *
 * Rules, each traced to evidence:
 *
 *  - An explicit `taskId` must be canonical, else `TASK_INVALID_ID`.
 *    VERIFIED: `store.orig.ts:256,387,580` guard every id the same way.
 *  - A `taskId` may appear at most once per payload, else `TASK_DUPLICATE_ID`.
 *    VERIFIED: `store.orig.ts:479-488` - a `claimedInPayload` Set, throwing
 *    "`${item.taskId} appears twice in one payload`". The artifact's comment
 *    calls this a "pagar" (rail) whose absence would let two items silently
 *    last-write-win.
 *  - An item WITHOUT a `taskId` is a NEW task, never a silent re-addressing of
 *    an existing one.
 *    VERIFIED: `store.orig.ts:450` - "Item ber-id harus ada (ID tak
 *    diketahui = `TASK_NOT_FOUND`), item tanpa id = task baru."
 *    This is what makes the no-reallocation guarantee hold: an existing task is
 *    only ever reachable through its own id, so a payload that omits the id
 *    cannot overwrite or renumber it. Existing tasks it omits are simply left
 *    alone (the artifact's D7 retain rule).
 *  - `blockedReason` survives only for `BLOCKED`.
 *    VERIFIED: `store.orig.ts:502` - `status === "BLOCKED" ? item.blockedReason
 *    ?? null : null`.
 *  - `order` is the declared index, and is display position only - never
 *    identity. VERIFIED: `store.orig.ts:522,532` assign `order: index`.
 */
export function planTaskIdentities(declared: readonly DeclaredTask[]): TaskIdentityPlan {
  const entries: IdentityPlanEntry[] = []
  const requiredExisting: string[] = []
  const claimedInPayload = new Set<string>()

  declared.forEach((item, index) => {
    const status = todoStatusToTask(item.status)
    const blockedReason = status === "BLOCKED" ? (item.blockedReason ?? null) : null

    if (item.taskId === undefined || item.taskId === "") {
      entries.push({
        kind: "new",
        order: index,
        status,
        title: item.title,
        blockedReason,
        input: {
          title: item.title,
          status,
          order: index,
          parentId: null,
          dependsOn: [],
          blockedReason,
          provenance: { origin: "model", source: "todo_write" },
        },
      })
      return
    }

    if (!isTaskId(item.taskId)) {
      throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${item.taskId}`)
    }
    if (claimedInPayload.has(item.taskId)) {
      throw new TaskError("TASK_DUPLICATE_ID", `${item.taskId} appears twice in one payload`)
    }
    claimedInPayload.add(item.taskId)
    requiredExisting.push(item.taskId)
    entries.push({
      kind: "existing",
      taskId: item.taskId,
      order: index,
      status,
      title: item.title,
      blockedReason,
    })
  })

  return { entries, requiredExisting }
}

// ── applying: delegates every write to TaskStore ─────────────────────────────

/**
 * Apply a plan produced by `planTaskIdentities`.
 *
 * Every required id is checked for existence in a PRE-PASS, before the first
 * write, so an unknown id cannot leave a half-applied payload. The artifact
 * enforced the same thing at `store.orig.ts:494-496` (`TASK_NOT_FOUND` for an
 * unknown explicit id); the pre-pass keeps that guarantee when the plan spans
 * several writes instead of one.
 *
 * All writes go through `TaskStore.patchTask` / `createTask`, so `revision`,
 * session ownership, the primary key and migration metadata stay owned by
 * TaskStore. This layer holds no state of its own.
 */
export function applyTaskIdentities(
  store: TaskStore,
  sessionId: string,
  plan: TaskIdentityPlan,
): ApplyOutcome {
  for (const id of plan.requiredExisting) {
    if (!store.getTask(sessionId, id)) {
      throw new TaskError("TASK_NOT_FOUND", `declared unknown task ${id}`)
    }
  }

  const existing: Task[] = []
  const created: Task[] = []
  for (const entry of plan.entries) {
    if (entry.kind === "existing") {
      existing.push(
        store.patchTask(sessionId, entry.taskId!, {
          title: entry.title,
          status: entry.status,
          order: entry.order,
          blockedReason: entry.blockedReason,
        }),
      )
    } else {
      created.push(store.createTask(sessionId, entry.input!))
    }
  }
  return { existing, created }
}

/** Convenience: plan then apply. Planning is pure, so this is still
 *  resolve-before-mutate: the plan throws before any write happens. */
export function synchronizeIdentities(
  store: TaskStore,
  sessionId: string,
  declared: readonly DeclaredTask[],
): ApplyOutcome {
  return applyTaskIdentities(store, sessionId, planTaskIdentities(declared))
}
