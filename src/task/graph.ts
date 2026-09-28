// TaskGraph — a read-only derived view of exactly one TaskStore snapshot.
//
// NEW ARCHITECTURE. Implements the public API of design lock S19 and the
// snapshot/immutability contract of S14-S16 in
// `PHASE-5B-TASKGRAPH-NEW-ARCHITECTURE-DESIGN-LOCK.md`.
//
// The three invariants worth stating up front:
//
//   TaskStore owns truth.  TaskGraph interprets one coherent snapshot and
//   never writes, never allocates identity and never executes work.
//
// PURE (design lock S22). This module performs no TaskStore access, no
// database access, no filesystem access, no process-global state, no
// randomness and no id formatting. Its only imports are types from the
// project plus this phase's own pure helpers.
//
// It has no `addNode`, `setParent`, `markReady`, `claim`, `execute`, `retry`,
// `cancel` or `complete`. Not by omission — adding any of them would make
// TaskGraph a second authority competing with TaskStore (design lock S14).

import type { TaskSnapshot, TaskStatus } from "./model"
import {
  analyseRelations,
  type Diagnostic,
  type GraphNode,
  type RelationAnalysis,
} from "./graph-validate"
import {
  computeBlockers,
  eligibleForReadiness,
  isReady as computeIsReady,
  type Blocker,
  type NotReady,
} from "./readiness"

export type { GraphNode, Diagnostic } from "./graph-validate"
export type { Blocker, BlockerKind, NotReady } from "./readiness"

const EMPTY_IDS: readonly string[] = Object.freeze([])

/**
 * Deterministic node order (design lock S12): `order` ascending, then `taskId`
 * ascending.
 *
 * The id tiebreak is a plain lexicographic string compare, which is exactly
 * what SQLite's `ORDER BY task_id` does for a TEXT column under BINARY
 * collation. So graph iteration agrees with `listTasks` for free — including
 * the `t10 < t2` consequence of comparing ids as text rather than as numbers.
 * That is fidelity, not a bug: we mirror the store's own ordering exactly.
 */
function compareNodes(a: GraphNode, b: GraphNode): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/**
 * A read-only projection of one coherent TaskStore snapshot.
 *
 * Immutable by construction: nodes and their `dependsOn` arrays are frozen
 * copies taken at build time, so a later TaskStore mutation cannot retroactively
 * change a graph that has already been built (design lock S16). There is no
 * cache, no registry and no invalidation hook — a rebuild is cheap, so it is
 * the cache.
 */
export class TaskGraph {
  /** The session this graph was derived from. */
  readonly sessionId: string

  /** Number of distinct tasks in the snapshot. */
  readonly nodeCount: number

  /**
   * WEAK STALENESS HINT (design lock S15) — the maximum `revision` seen in the
   * snapshot, or 0 for an empty snapshot.
   *
   * Deliberately NOT called `sourceRevision`, and deliberately NOT a
   * compare-and-swap or version guarantee. It can go stale silently (removing
   * the highest-revision task leaves it unchanged) and it means nothing across
   * sessions. A consumer that needs certainty must re-read TaskStore; this
   * exists only to let a consumer notice that it *may* be looking at an older
   * view. Because the graph is read-only, a stale graph can never cause
   * incorrect behaviour inside the graph.
   */
  readonly sourceMaxRevision: number

  private readonly analysis: RelationAnalysis
  private readonly ordered: readonly GraphNode[]
  private readonly childrenIndex: ReadonlyMap<string, readonly string[]>
  private readonly dependentsIndex: ReadonlyMap<string, readonly string[]>

  constructor(snapshot: TaskSnapshot) {
    this.sessionId = snapshot.sessionId

    // --- project: defensive copy of the fields the graph reasons about -----
    let maxRevision = 0
    const projected: GraphNode[] = []
    for (const task of snapshot.tasks) {
      if (task.revision > maxRevision) maxRevision = task.revision
      projected.push(
        Object.freeze({
          id: task.id,
          title: task.title,
          status: task.status,
          order: task.order,
          parentId: task.parentId,
          // Copy the array: retaining the source array would let a caller
          // mutate a live row through the graph.
          dependsOn: Object.freeze([...task.dependsOn]),
          blockedReason: task.blockedReason,
          revision: task.revision,
        }),
      )
    }
    this.sourceMaxRevision = maxRevision

    // Sort before validation so both the de-duplication choice (first wins) and
    // diagnostic ordering are deterministic regardless of input array order
    // (invariant G5). Array.prototype.sort is stable, so equal keys keep their
    // relative order.
    projected.sort(compareNodes)

    this.analysis = analyseRelations(projected)
    // byId preserves insertion order, which is the sorted order above.
    this.ordered = Object.freeze([...this.analysis.byId.values()])
    this.nodeCount = this.ordered.length

    this.childrenIndex = buildAdjacency(this.ordered, "parent")
    this.dependentsIndex = buildAdjacency(this.ordered, "dependency")
  }

  /** The node for `taskId`, or `undefined` if it is not in the snapshot. */
  getNode(taskId: string): GraphNode | undefined {
    return this.analysis.byId.get(taskId)
  }

  /** Every node, in deterministic order. */
  nodes(): readonly GraphNode[] {
    return this.ordered
  }

  /** Execution edges out: the ids this task depends on. */
  dependencies(taskId: string): readonly string[] {
    return this.getNode(taskId)?.dependsOn ?? EMPTY_IDS
  }

  /** Execution edges in: the ids that depend on this task. */
  dependents(taskId: string): readonly string[] {
    return this.dependentsIndex.get(taskId) ?? EMPTY_IDS
  }

  /** Containment edges: the ids nested directly under this task. */
  children(taskId: string): readonly string[] {
    return this.childrenIndex.get(taskId) ?? EMPTY_IDS
  }

  /** This task's parent id, or `null` when it is a root or absent. */
  parent(taskId: string): string | null {
    return this.getNode(taskId)?.parentId ?? null
  }

  /**
   * Ids eligible for readiness, in deterministic order.
   *
   * `PENDING` and `BLOCKED` are eligible. Eligibility is not readiness: see
   * `isReady`. Membership here is independent of graph validity, because a
   * blocked-by-relation task is still an eligible candidate that happens not to
   * be ready.
   */
  eligibleTasks(): readonly string[] {
    const out: string[] = []
    for (const node of this.ordered) {
      if (eligibleForReadiness(node)) out.push(node.id)
    }
    return out
  }

  /**
   * Ids that are ready, in deterministic order — or `[]` when the graph is
   * invalid.
   *
   * An invalid graph must not publish a partial readiness answer: the
   * structure is ill-defined, so any "ready" claim would be a lie (design lock
   * S10). O(n + e) — one pass, per-node blocker derivation.
   */
  readyTasks(): readonly string[] {
    if (!this.analysis.valid) return EMPTY_IDS
    const out: string[] = []
    for (const node of this.ordered) {
      if (computeIsReady(node, this.analysis.byId, this.analysis)) out.push(node.id)
    }
    return out
  }

  /** True only for a `PENDING` task with no blockers in a valid graph. */
  isReady(taskId: string): boolean {
    const node = this.getNode(taskId)
    if (node === undefined) return false
    return computeIsReady(node, this.analysis.byId, this.analysis)
  }

  /**
   * Why this task is or is not ready. `undefined` if the id is not in the snapshot.
   *
   * The order of these tests is the whole contract:
   *
   *  1. an invalid graph answers `graph-invalid` for EVERY id — the structure
   *     is ill-defined, so no partial readiness claim is permitted;
   *  2. any blocker answers `blocked` — blockers outrank status, so a
   *     durably-`BLOCKED` task that also waits on a dependency reports the
   *     actionable reason;
   *  3. `PENDING` with no blockers is the only `ready` case;
   *  4. an ELIGIBLE task that survived the above is `eligible-not-ready` —
   *     this is the `BLOCKED`-with-no-blockers case, and it is exactly why
   *     Phase 5C.1 added the variant;
   *  5. everything else is `not-eligible`.
   *
   * Step 4 tests `eligibleForReadiness` rather than hard-coding `"BLOCKED"`, so
   * this classification can never drift away from `eligibleTasks()`, which uses
   * the same predicate.
   */
  notReadyReason(taskId: string): NotReady | undefined {
    const node = this.getNode(taskId)
    if (node === undefined) return undefined

    if (!this.analysis.valid) {
      return { kind: "graph-invalid", diagnostics: this.analysis.diagnostics }
    }

    const blockers = computeBlockers(node, this.analysis.byId, this.analysis)
    if (blockers.length > 0) return { kind: "blocked", blockers }

    if (node.status === "PENDING") return { kind: "ready" }

    if (eligibleForReadiness(node)) {
      return { kind: "eligible-not-ready", status: node.status }
    }

    return { kind: "not-eligible", status: node.status }
  }

  /** Every relation-derived reason this task is not ready. */
  blockers(taskId: string): readonly Blocker[] {
    const node = this.getNode(taskId)
    if (node === undefined) return EMPTY_IDS
    return computeBlockers(node, this.analysis.byId, this.analysis)
  }

  /**
   * Structural validity plus the diagnostics that explain an invalid graph.
   *
   * A dependency cycle keeps `valid === true`: it is a well-formed but
   * unsatisfiable relation, and its members carry `DEPENDENCY_CYCLE` blockers
   * instead.
   */
  validity(): { valid: boolean; diagnostics: readonly Diagnostic[] } {
    return { valid: this.analysis.valid, diagnostics: this.analysis.diagnostics }
  }
}

/**
 * Build the reverse-relation index once, at construction.
 *
 * These are intrinsic indices over immutable data, not caches: there is
 * nothing to invalidate because nothing can change. Edges to absent ids, and
 * self edges, are excluded — both are already INVALID diagnostics, and a
 * phantom index entry would misreport the graph's structure.
 */
function buildAdjacency(
  ordered: readonly GraphNode[],
  relation: "parent" | "dependency",
): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>()
  for (const node of ordered) index.set(node.id, [])

  for (const node of ordered) {
    const targets = relation === "parent" ? [node.parentId] : node.dependsOn
    for (const target of targets) {
      if (target === null || target === node.id) continue
      const bucket = index.get(target)
      if (bucket === undefined) continue
      bucket.push(node.id)
    }
  }

  // Iterate `ordered`, so every bucket is already in deterministic order.
  const frozen = new Map<string, readonly string[]>()
  for (const [id, bucket] of index) frozen.set(id, Object.freeze(bucket))
  return frozen
}

/** Re-exported so a consumer can name the status type without a second import. */
export type { TaskStatus }
