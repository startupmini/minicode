// Production canonical task synchronization — Phase 4A.4.
//
// THIS IS NEW ARCHITECTURE. The pre-wipe production writer did not survive the
// workspace wipe and has no surviving caller: `store.orig.ts` defined
// `synchronizeTasks` but nothing in any recovered file invoked it. This module
// is the FIRST production consumer of TaskStore, and its placement is a design
// decision, not a recovery.
//
// THE BOUNDARY
//     todo_write payload
//         -> JSON durable write            (unchanged, still the legacy file)
//         -> THIS module                  (canonical TaskStore state)
//         -> plan publication             (unchanged, downstream)
//
// The ordering is the one already proven in production: a durable write happens
// before the plan is published, so a failed durable write suppresses the plan
// (`src/presentation/adapter.ts`). Nothing here invents a new ordering.
//
// CLASSIFICATION (the approved distinction)
//   mixed payload (>=1 taskId)  -> id-bearing items are EXISTING, id-less items
//                                  are genuinely NEW
//   all-id-less payload         -> NOT synchronized. The legacy JSON path stays
//                                  exactly as it was; no automatic adoption, no
//                                  id allocation, no manifest. Rejecting that
//                                  case is Phase 4A.5's decision, not this one's.
//
// IDENTITY RULES
//   - an explicit taskId is resolved directly through TaskStore. NEVER by array
//     position, content, title or ordinal.
//   - the WHOLE payload is validated before the first mutation (the Phase 3A
//     resolve-before-mutate invariant, preserved).
//   - only TaskStore allocates ids, via `createTask`. This module never formats
//     one.
//   - one `todo_write` is one `withTransaction`: every update, creation, order
//     change and metadata write either all commit or all roll back.

import { TaskError, isTaskId, type Task } from "./model.ts"
import { type DeclaredTask, planTaskIdentities, todoStatusToTask } from "./identity.ts"
import { TaskStore } from "./store.ts"
import type { CanonicalAssignment, CanonicalAssignmentTable } from "./assignment.ts"

/** One declared item, already mapped out of the legacy `TodoItem` shape.
 *  `content` is mapped to `title` by the caller - the store requires `title`,
 *  and passing `content` straight through was measured to fail NOT NULL. */
export interface CanonicalTaskInput {
  taskId?: string
  title: string
  status: "pending" | "in_progress" | "completed" | "cancelled" | "blocked"
  blockedReason?: string
}

export interface CanonicalSyncResult {
  /** False when the payload was all-id-less and therefore left legacy. */
  applied: boolean
  reason?: "legacy-idless-payload"
  changed: Task[]
  created: Task[]
  /** D7 survivors: declared in an earlier turn, omitted now, kept anyway. */
  retained: Task[]
  /**
   * PHASE 4A.4A — one entry per DECLARED item, in declaration order: the
   * canonical id that item now has, and whether it already existed or this
   * operation minted it. Absent for the legacy all-id-less path, which performs
   * no synchronization and therefore has nothing to assign.
   *
   * Built INSIDE the transaction from the ids `createTask` returned, so it is
   * exactly the committed result and never a later reconstruction. A rollback
   * throws, so no assignment can be published for a transaction that did not
   * commit — that is a structural guarantee, not a check.
   */
  assignment?: CanonicalAssignmentTable
}

/** True when at least one item carries an identity. Mirrors the recovered
 *  artifact's `hasAnyId` switch (`store.orig.ts:480`). */
export function hasCanonicalIdentity(items: readonly { taskId?: string }[]): boolean {
  return items.some((i) => typeof i.taskId === "string" && i.taskId !== "")
}

export function synchronizeCanonicalTasks(opts: {
  cwd: string
  sessionId: string
  declared: readonly CanonicalTaskInput[]
}): CanonicalSyncResult {
  const { cwd, sessionId, declared } = opts

  // All-id-less: legacy behaviour, untouched. No adoption, no allocation.
  if (!hasCanonicalIdentity(declared)) {
    return {
      applied: false,
      reason: "legacy-idless-payload",
      changed: [],
      created: [],
      retained: [],
    }
  }

  const store = new TaskStore(cwd)

  // Pure planning + validation. Throws on a malformed or duplicated id BEFORE
  // any statement runs, so a bad payload cannot half-apply.
  const asDeclared: DeclaredTask[] = declared.map((d) => ({
    ...(d.taskId ? { taskId: d.taskId } : {}),
    title: d.title,
    status: d.status,
    ...(d.blockedReason ? { blockedReason: d.blockedReason } : {}),
  }))
  const plan = planTaskIdentities(asDeclared)

  return store.withTransaction((tx) => {
    // Resolve-before-mutate, second leg: every claimed id must already exist.
    // An unknown id is a hard failure - never a silent "treat as new".
    for (const id of plan.requiredExisting) {
      if (!tx.getTask(sessionId, id)) {
        throw new TaskError("TASK_NOT_FOUND", `declared unknown task ${id}`)
      }
    }

    const seen = new Set<string>()
    const changed: Task[] = []
    const created: Task[] = []
    // PHASE 4A.4A — pushed in `plan.entries` order, which IS declaration order,
    // so index i of this table always describes declared item i.
    const assignment: CanonicalAssignment[] = []

    plan.entries.forEach((entry) => {
      if (entry.kind === "existing") {
        const id = entry.taskId as string
        seen.add(id)
        assignment.push({ taskId: id, kind: "existing" })
        changed.push(
          tx.patchTask(sessionId, id, {
            title: entry.title,
            status: entry.status,
            // `order` is the declared position. It is display/execution order,
            // never identity.
            order: entry.order,
            blockedReason: entry.blockedReason,
          }),
        )
      } else {
        // Only TaskStore allocates. `input` was built by planTaskIdentities with
        // provenance { origin: "model", source: "todo_write" }.
        const t = tx.createTask(sessionId, entry.input as never)
        seen.add(t.id)
        // The id the allocator actually returned, captured here and now — never
        // re-derived from position, title or content afterwards.
        assignment.push({ taskId: t.id, kind: "new" })
        created.push(t)
      }
    })

    // D7 — omission is NOT deletion. A task the model did not mention this turn
    // is retained: not deleted, not cancelled, not reset. The canonical payload
    // is a full DECLARATION, not a replacement.
    //
    // Retained tasks are placed after the declared range so that
    // (task_order, task_id) stays a total, collision-free ordering key. The
    // recovered artifact instead renumbered survivors to 0..n-1, which could
    // collide with a declared item's own order; this is a deliberate difference.
    const retained: Task[] = []
    tx.listTasks(sessionId)
      .filter((t) => !seen.has(t.id))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .forEach((t, i) => {
        const order = plan.entries.length + i
        retained.push(t.order === order ? t : tx.patchTask(sessionId, t.id, { order }))
      })

    return { applied: true, changed, created, retained, assignment }
  })
}

/** Resolve canonical identity for a plan projection.
 *
 *  Authority: TaskStore. An id is reported ONLY when the store actually holds
 *  that row for this session. Anything else is `null`, which makes the plan
 *  fall back to the positional legacy shape rather than emit a false `v2`.
 */
export function createTaskIdentityResolver(cwd: string) {
  return (input: { sessionId: string; declared: readonly { taskId?: string }[] }) => {
    try {
      const store = new TaskStore(cwd)
      return input.declared.map((d) => {
        if (!d.taskId || !isTaskId(d.taskId)) return null
        return store.getTask(input.sessionId, d.taskId) ? d.taskId : null
      })
    } catch {
      return undefined
    }
  }
}

/** Exported for the mapping the caller performs; kept here so the status
 *  vocabulary has a single owner. */
export { todoStatusToTask }
