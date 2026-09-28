// TaskGraph structure, validity and cycle detection — Phase 5C.
//
// NEW ARCHITECTURE. Implements the contract locked in
// `PHASE-5B-TASKGRAPH-NEW-ARCHITECTURE-DESIGN-LOCK.md`. Nothing here is a
// recovery of the lost original `graph-validate.ts`; the module name matches
// coincidentally and no historical content is implied.
//
// PURE (design lock S22). This module performs no TaskStore access, no
// filesystem access, no process-global state, no randomness and no identity
// allocation. Its only import is `isTaskId`, a *read-only format validator* —
// it never mints, formats or repairs an id. `taskIdFromIndex` (the only
// formatter in the model) is deliberately NOT imported.
//
// CYCLE ALGORITHMS (design lock S12). Both traversals are ITERATIVE. A
// recursive DFS would overflow the call stack on the 10 000-deep parent-chain
// fixture, which is an explicit requirement of this phase.

import { isTaskId, type TaskStatus } from "./model"

/**
 * The projected node (design lock S4).
 *
 * A *projection*, not a copy of the durable row: `sessionId`, timestamps,
 * `verification`, `evidence`, `acceptance` and `provenance` are deliberately
 * absent because TaskGraph does not reason about them. In particular the
 * completion gate is not this component's business (S1).
 */
export interface GraphNode {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  readonly order: number
  readonly parentId: string | null
  readonly dependsOn: readonly string[]
  readonly blockedReason: string | null
  readonly revision: number
}

/**
 * Why a snapshot is not a valid graph (design lock S10).
 *
 * Note the deliberate asymmetry with `BlockerKind` (readiness.ts): a
 * self-reference is the diagnostic `SELF_PARENT` / `SELF_DEPENDENCY` but the
 * blocker `SELF_REFERENCE`. The graph-level condition and the task-level
 * condition are different questions and keep different names.
 */
export type DiagnosticKind =
  | "DUPLICATE_NODE"
  | "DANGLING_PARENT"
  | "SELF_PARENT"
  | "PARENT_CYCLE"
  | "SELF_DEPENDENCY"
  | "DANGLING_DEPENDENCY"
  | "DUPLICATE_DEPENDENCY"
  | "MALFORMED_RELATION"

export interface Diagnostic {
  readonly kind: DiagnosticKind
  /** `"node"` for id-level faults that belong to neither relation. */
  readonly relation: "parent" | "dependency" | "node"
  readonly taskId: string
  /** Human-readable, explicitly non-contractual. */
  readonly detail: string
  /** Cycle membership, when the diagnostic describes a cycle. */
  readonly members?: readonly string[]
}

/** The result of interpreting one snapshot's relations. */
export interface RelationAnalysis {
  /** False if any diagnostic was raised. A dependency cycle does NOT make it false. */
  readonly valid: boolean
  readonly diagnostics: readonly Diagnostic[]
  /** De-duplicated nodes keyed by canonical id (first occurrence wins). */
  readonly byId: ReadonlyMap<string, GraphNode>
  /** Nodes that participate in a containment cycle. */
  readonly parentCycleMembers: ReadonlySet<string>
  /** Nodes that participate in a dependency cycle of length > 1. */
  readonly dependencyCycleMembers: ReadonlySet<string>
  readonly parentCycles: readonly (readonly string[])[]
  readonly dependencyCycles: readonly (readonly string[])[]
}

/**
 * Interpret every relation in the snapshot.
 *
 * NEVER THROWS for malformed graph data (design lock S10 / brief S11):
 * invalidity is returned as data so no consumer has to exception-handle a
 * corrupt session.
 */
export function analyseRelations(nodes: readonly GraphNode[]): RelationAnalysis {
  const diagnostics: Diagnostic[] = []
  const byId = new Map<string, GraphNode>()

  // --- node identity -------------------------------------------------------
  // Reachable only defensively: TaskStore's PRIMARY KEY (session_id, task_id)
  // makes this impossible, but a hand-built snapshot can violate it.
  for (const n of nodes) {
    if (byId.has(n.id)) {
      diagnostics.push({
        kind: "DUPLICATE_NODE",
        relation: "node",
        taskId: n.id,
        detail: `duplicate node id ${n.id}; first occurrence kept`,
      })
      continue
    }
    byId.set(n.id, n)
  }

  // --- per-relation shape --------------------------------------------------
  for (const n of byId.values()) {
    if (n.parentId !== null) {
      if (!isTaskId(n.parentId)) {
        diagnostics.push({
          kind: "MALFORMED_RELATION",
          relation: "parent",
          taskId: n.id,
          detail: `parentId is not a canonical task id: ${n.parentId}`,
        })
      } else if (n.parentId === n.id) {
        diagnostics.push({
          kind: "SELF_PARENT",
          relation: "parent",
          taskId: n.id,
          detail: `task ${n.id} is its own parent`,
        })
      } else if (!byId.has(n.parentId)) {
        diagnostics.push({
          kind: "DANGLING_PARENT",
          relation: "parent",
          taskId: n.id,
          detail: `parent ${n.parentId} is not present in the snapshot`,
        })
      }
    }

    const seen = new Set<string>()
    for (const d of n.dependsOn) {
      if (!isTaskId(d)) {
        diagnostics.push({
          kind: "MALFORMED_RELATION",
          relation: "dependency",
          taskId: n.id,
          detail: `dependency is not a canonical task id: ${d}`,
        })
        continue
      }
      if (d === n.id) {
        diagnostics.push({
          kind: "SELF_DEPENDENCY",
          relation: "dependency",
          taskId: n.id,
          detail: `task ${n.id} depends on itself`,
        })
        continue
      }
      if (seen.has(d)) {
        diagnostics.push({
          kind: "DUPLICATE_DEPENDENCY",
          relation: "dependency",
          taskId: n.id,
          detail: `dependency ${d} listed more than once`,
        })
        continue
      }
      seen.add(d)
      if (!byId.has(d)) {
        diagnostics.push({
          kind: "DANGLING_DEPENDENCY",
          relation: "dependency",
          taskId: n.id,
          detail: `dependency ${d} is not present in the snapshot`,
        })
      }
    }
  }

  // --- cycles --------------------------------------------------------------
  // Containment and execution are analysed SEPARATELY: a parent cycle makes
  // the graph INVALID, a dependency cycle leaves it VALID and merely
  // unsatisfiable (design lock S11).
  const { members: parentCycleMembers, groups: parentCycles } = findParentCycles(byId)
  const { members: dependencyCycleMembers, groups: dependencyCycles } =
    findDependencyCycles(byId)

  for (const cycle of parentCycles) {
    diagnostics.push({
      kind: "PARENT_CYCLE",
      relation: "parent",
      taskId: cycle[0] ?? "",
      detail: `containment cycle: ${cycle.join(" -> ")}`,
      members: cycle,
    })
  }

  return {
    valid: diagnostics.length === 0,
    diagnostics: Object.freeze(diagnostics),
    byId,
    parentCycleMembers,
    dependencyCycleMembers,
    parentCycles: Object.freeze(parentCycles),
    dependencyCycles: Object.freeze(dependencyCycles),
  }
}

/**
 * Containment cycles. Iterative, O(n) over the whole graph.
 *
 * `parentId` is a *functional* relation (at most one parent per node), so this
 * is a functional-graph walk: follow the parent chain from each unvisited node
 * and detect a repeat within the CURRENT path. The explicit `pathIndex` map is
 * what distinguishes "seen in this walk" (a cycle) from "seen in an earlier
 * walk" (already settled).
 *
 * Fan-out is intentionally unbounded: `MAX_PARENT` is declared in TaskStore but
 * enforced nowhere, so the width of a containment forest is not bounded here
 * either (design lock S5).
 */
function findParentCycles(byId: ReadonlyMap<string, GraphNode>): {
  members: Set<string>
  groups: string[][]
} {
  const members = new Set<string>()
  const groups: string[][] = []
  const settled = new Set<string>()

  for (const start of byId.values()) {
    if (settled.has(start.id)) continue

    const path: string[] = []
    const pathIndex = new Map<string, number>()
    let cursor: string | null = start.id

    while (cursor !== null) {
      // Current-path repeat first: `settled` is populated during this walk too,
      // so testing it first would hide the cycle.
      const at = pathIndex.get(cursor)
      if (at !== undefined) {
        const cycle = path.slice(at)
        groups.push(cycle)
        for (const m of cycle) members.add(m)
        break
      }
      if (settled.has(cursor)) break

      const node = byId.get(cursor)
      if (node === undefined) break

      settled.add(cursor)
      pathIndex.set(cursor, path.length)
      path.push(cursor)

      const parent = node.parentId
      // Terminate on: no parent, missing parent (already diagnosed), self
      // parent (already diagnosed). All are genuine non-cycles.
      if (parent === null || parent === cursor || !byId.has(parent)) break
      cursor = parent
    }
  }

  return { members, groups }
}

/**
 * Dependency cycles via an ITERATIVE Tarjan strongly-connected-component pass.
 *
 * A node is in a dependency cycle iff its SCC has more than one member. Self
 * edges are skipped: a self dependency is already the `SELF_DEPENDENCY`
 * diagnostic (an INVALID graph), not a cycle member, per design lock S10.
 * Edges to absent ids are skipped for the same reason — a dangling target is
 * an INVALID graph, and inventing a phantom node would corrupt the SCCs of
 * every node pointing at it.
 *
 * Iterative with an explicit frame stack so a 10 000-deep chain cannot overflow.
 */
function findDependencyCycles(byId: ReadonlyMap<string, GraphNode>): {
  members: Set<string>
  groups: string[][]
} {
  const members = new Set<string>()
  const groups: string[][] = []

  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const sccStack: string[] = []
  let counter = 0

  const adjacencyOf = (id: string): string[] => {
    const node = byId.get(id)
    if (node === undefined) return []
    const out: string[] = []
    for (const dep of node.dependsOn) {
      if (dep === id) continue
      if (!byId.has(dep)) continue
      out.push(dep)
    }
    return out
  }

  for (const start of byId.keys()) {
    if (index.has(start)) continue

    index.set(start, counter)
    lowlink.set(start, counter)
    counter++
    sccStack.push(start)
    onStack.add(start)

    const frames: Array<{ id: string; next: number; adj: string[] }> = [
      { id: start, next: 0, adj: adjacencyOf(start) },
    ]

    while (frames.length > 0) {
      // PHASE 5D.1 / defect D2. Under `noUncheckedIndexedAccess` a plain
      // `frames[frames.length - 1]` is `Frame | undefined`, and a length test
      // does NOT narrow an index expression — so the compiler could not prove
      // the loop invariant. `.at(-1)` states that absence is possible and the
      // `undefined` test makes the narrowing provable. No assertion, no cast.
      const frame = frames.at(-1)
      if (frame === undefined) break

      // One `undefined` test replaces the `next < adj.length` bounds check:
      // `next` advances by exactly 1 from 0 and `adj` never changes length, so
      // `adj.at(next)` is undefined exactly when the frame is exhausted. This
      // also removes the `as string` cast that previously masked the same
      // unchecked access.
      const neighbour = frame.adj.at(frame.next)
      if (neighbour !== undefined) {
        frame.next++
        if (!index.has(neighbour)) {
          index.set(neighbour, counter)
          lowlink.set(neighbour, counter)
          counter++
          sccStack.push(neighbour)
          onStack.add(neighbour)
          frames.push({ id: neighbour, next: 0, adj: adjacencyOf(neighbour) })
        } else if (onStack.has(neighbour)) {
          lowlink.set(
            frame.id,
            Math.min(lowlink.get(frame.id) as number, index.get(neighbour) as number),
          )
        }
        continue
      }

      // The frame has no unvisited edge left: close it, then pop an SCC if it
      // is a root (lowlink === index).
      frames.pop()
      if (lowlink.get(frame.id) === index.get(frame.id)) {
        const component: string[] = []
        for (;;) {
          const member = sccStack.pop()
          if (member === undefined) break
          onStack.delete(member)
          component.push(member)
          if (member === frame.id) break
        }
        if (component.length > 1) {
          component.sort()
          groups.push(component)
          for (const m of component) members.add(m)
        }
      }

      // Propagate the lowlink to the frame that resumed us. `at(-1)` keeps this
      // provable; a plain index would reintroduce D2 here.
      const caller = frames.at(-1)
      if (caller !== undefined) {
        lowlink.set(
          caller.id,
          Math.min(lowlink.get(caller.id) as number, lowlink.get(frame.id) as number),
        )
      }
    }
  }

  return { members, groups }
}
