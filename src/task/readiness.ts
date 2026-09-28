// TaskGraph readiness and blockers — Phase 5C.
//
// NEW ARCHITECTURE. Implements design lock S7 (dependency satisfaction),
// S8 (readiness) and S9 (blockers) of
// `PHASE-5B-TASKGRAPH-NEW-ARCHITECTURE-DESIGN-LOCK.md`.
//
// PURE (design lock S22). No TaskStore access, no filesystem, no process
// state, no randomness, no identity allocation, no status mutation.
//
// THE CENTRAL RULE: readiness is DERIVED. `TaskStore` coerces a written
// "READY" to `PENDING` (verified), so a durable `READY` cannot exist and this
// module must never pretend to persist one.
//
// NO `PAUSED`. `TaskStatus` contains exactly eight values; this module refers
// only to those. `READY` is not one of them either — it is a derived answer,
// not a status.

import type { TaskStatus } from "./model"
import type { Diagnostic, GraphNode, RelationAnalysis } from "./graph-validate"

export type BlockerKind =
  | "DEPENDENCY_UNSATISFIED"
  | "DEPENDENCY_TERMINAL"
  | "DEPENDENCY_CYCLE"
  | "DANGLING_DEPENDENCY"
  | "PARENT_MISSING"
  | "PARENT_CYCLE"
  | "SELF_REFERENCE"

export interface Blocker {
  readonly kind: BlockerKind
  readonly relation: "dependency" | "parent"
  /** The task that causes the block; `""` for a self-reference (design lock S9). */
  readonly taskId: string
  /** Temporary blockers may resolve on their own; permanent ones need an operator. */
  readonly permanent: boolean
  /** Human-readable, explicitly non-contractual. */
  readonly detail: string
}

/**
 * Why a task is or is not ready (design lock S9).
 *
 * Exactly the four locked states — no more. Note that durable status is NOT a
 * blocker: a cancelled task is *not eligible*, not *blocked*. Conflating the
 * two is what would let a durably-`BLOCKED` task be reported ready.
 */
export type NotReady =
  | { readonly kind: "ready" }
  | { readonly kind: "not-eligible"; readonly status: TaskStatus }
  | { readonly kind: "blocked"; readonly blockers: readonly Blocker[] }
  | { readonly kind: "graph-invalid"; readonly diagnostics: readonly Diagnostic[] }

/** Statuses that can never satisfy a dependency (design lock S7). */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "CANCELLED",
  "FAILED",
])

/** Statuses from which a task is *eligible* for readiness (design lock S8). */
const ELIGIBLE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "PENDING",
  "BLOCKED",
])

/**
 * A dependency is satisfied by completion and by nothing else (design lock S7).
 *
 * `FAILED` and `CANCELLED` deliberately do NOT satisfy. Treating them as
 * satisfied would claim finished work that does not exist, and the failure
 * mode is asymmetric: a false negative merely leaves a task unready, a false
 * positive executes dependent work on a false premise.
 */
export function dependencySatisfied(dependency: GraphNode): boolean {
  return dependency.status === "COMPLETED"
}

/**
 * `PENDING` and `BLOCKED` are eligible; nothing else is.
 *
 * `BLOCKED` being *eligible* is what lets the graph model "this could become
 * ready once its cause is resolved" while still never reporting it ready.
 */
export function eligibleForReadiness(node: GraphNode): boolean {
  return ELIGIBLE_STATUSES.has(node.status)
}

/** True when a task is in a state from which it will never proceed. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/**
 * Every reason `node` is not ready, derived from its relations.
 *
 * A task with no blockers is a candidate for readiness, but readiness still
 * requires `status === "PENDING"` (see `isReady`) — so `BLOCKED` with an empty
 * blocker list is reported as not ready, never as ready.
 *
 * Precedence, and why:
 *  1. Cycle membership first — a member of a dependency cycle can never be
 *     satisfied regardless of its status, so that is the dominant reason.
 *  2. Terminal before merely-unsatisfied, so an operator sees the actionable
 *     "this will not proceed" rather than a misleading "still working on it".
 */
export function computeBlockers(
  node: GraphNode,
  byId: ReadonlyMap<string, GraphNode>,
  analysis: RelationAnalysis,
): readonly Blocker[] {
  const blockers: Blocker[] = []

  // --- containment: STRUCTURE, never an execution gate (design lock S5) ----
  if (node.parentId !== null) {
    if (node.parentId === node.id) {
      blockers.push({
        kind: "SELF_REFERENCE",
        relation: "parent",
        taskId: "",
        permanent: true,
        detail: `task ${node.id} is its own parent`,
      })
    } else if (!byId.has(node.parentId)) {
      blockers.push({
        kind: "PARENT_MISSING",
        relation: "parent",
        taskId: node.parentId,
        permanent: true,
        detail: `parent ${node.parentId} is not present in the snapshot`,
      })
    } else if (analysis.parentCycleMembers.has(node.id)) {
      blockers.push({
        kind: "PARENT_CYCLE",
        relation: "parent",
        taskId: node.id,
        permanent: true,
        detail: `task ${node.id} participates in a containment cycle`,
      })
    }
  }

  // --- dependencies: EXECUTION --------------------------------------------
  const counted = new Set<string>()
  for (const depId of node.dependsOn) {
    if (depId === node.id) {
      blockers.push({
        kind: "SELF_REFERENCE",
        relation: "dependency",
        taskId: "",
        permanent: true,
        detail: `task ${node.id} depends on itself`,
      })
      continue
    }
    // A duplicated dependency is already an INVALID graph; do not emit the
    // same blocker twice.
    if (counted.has(depId)) continue
    counted.add(depId)

    const dependency = byId.get(depId)
    if (dependency === undefined) {
      blockers.push({
        kind: "DANGLING_DEPENDENCY",
        relation: "dependency",
        taskId: depId,
        permanent: true,
        detail: `dependency ${depId} is not present in the snapshot`,
      })
      continue
    }
    if (analysis.dependencyCycleMembers.has(depId)) {
      blockers.push({
        kind: "DEPENDENCY_CYCLE",
        relation: "dependency",
        taskId: depId,
        permanent: true,
        detail: `dependency ${depId} is part of a dependency cycle and can never be satisfied`,
      })
      continue
    }
    if (dependencySatisfied(dependency)) continue
    if (isTerminalStatus(dependency.status)) {
      blockers.push({
        kind: "DEPENDENCY_TERMINAL",
        relation: "dependency",
        taskId: depId,
        permanent: true,
        detail: `dependency ${depId} is ${dependency.status} and will not proceed`,
      })
      continue
    }
    blockers.push({
      kind: "DEPENDENCY_UNSATISFIED",
      relation: "dependency",
      taskId: depId,
      permanent: false,
      detail: `dependency ${depId} is ${dependency.status}`,
    })
  }

  return blockers
}

/**
 * Ready means: `PENDING` AND no blockers AND the graph is structurally valid.
 *
 * The `status === "PENDING"` clause is the whole point of the design. It makes
 * it *unconstructible* for a durably-`BLOCKED` task to be reported ready, which
 * is the contradiction the design lock forbids (S13).
 */
export function isReady(
  node: GraphNode,
  byId: ReadonlyMap<string, GraphNode>,
  analysis: RelationAnalysis,
): boolean {
  if (!analysis.valid) return false
  if (node.status !== "PENDING") return false
  return computeBlockers(node, byId, analysis).length === 0
}
