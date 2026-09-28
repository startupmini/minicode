// Phase 5C — TaskGraph unit + integration tests.
//
// NEW ARCHITECTURE. Covers the test model of design lock S24 (A-Z) and the
// explicit status matrix required by Phase 5C brief S19.
//
// Fixture discipline (brief S18):
//   REACHABLE from TaskStore   — missing parent, both cycle kinds, valid
//                                 relations, and every status value.
//   DEFENSIVE / graph-only     — missing dependency, duplicate node, duplicate
//                                 dependency, malformed relation. These are
//                                 unreachable through TaskStore, so they are
//                                 built by hand. TaskStore validation is NOT
//                                 weakened to make them reachable.
//
// The hand-built fixtures use `mkTask`, which produces a well-formed durable
// row; the "impossible" states are then introduced by editing the copy that
// goes into the snapshot, never by touching TaskStore.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { TaskGraph } from "../src/task/graph.ts"
import { TaskStore, resetTaskStoreHandles, type NewTaskInput } from "../src/task/store.ts"
import type { Blocker } from "../src/task/readiness.ts"
import type { Task, TaskSnapshot, TaskStatus } from "../src/task/model.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..")

/** Every real `TaskStatus`. `READY` and `PAUSED` are deliberately absent. */
const ALL_STATUSES: readonly TaskStatus[] = [
  "PENDING",
  "BLOCKED",
  "IN_PROGRESS",
  "VERIFYING",
  "RETRYING",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
]

/** A well-formed durable task row. */
function mkTask(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    sessionId: "s1",
    title: `task ${id}`,
    status: "PENDING",
    order: 1,
    parentId: null,
    dependsOn: [],
    blockedReason: null,
    verification: null,
    evidence: [],
    acceptance: null,
    provenance: { origin: "runtime", source: "test" },
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    revision: 1,
    ...over,
  }
}

function snap(tasks: Task[]): TaskSnapshot {
  return { sessionId: tasks[0]?.sessionId ?? "s1", tasks }
}

function graphOf(tasks: Task[]): TaskGraph {
  return new TaskGraph(snap(tasks))
}

const kindsOf = (g: TaskGraph, id: string) => g.blockers(id).map((b) => b.kind)

// ---------------------------------------------------------------------------
describe("A. node identity", () => {
  test("one node per canonical taskId, and the id is the durable id", () => {
    const g = graphOf([mkTask("t1"), mkTask("t2"), mkTask("t3")])
    expect(g.nodes().map((n) => n.id)).toEqual(["t1", "t2", "t3"])
    expect(g.nodeCount).toBe(3)
    expect(g.getNode("t2")?.id).toBe("t2")
  })

  test("identity is never derived from title, order or position", () => {
    // Deliberately misleading: reversed orders, alphabetic titles that
    // disagree with the ids, and a shuffled source array.
    const g = graphOf([
      mkTask("t7", { title: "aaa", order: 9 }),
      mkTask("t3", { title: "zzz", order: 1 }),
      mkTask("t5", { title: "mmm", order: 5 }),
    ])
    expect(g.getNode("t3")?.id).toBe("t3")
    expect(g.getNode("t3")?.title).toBe("zzz")
    // Order drives iteration, ids drive identity.
    expect(g.nodes().map((n) => n.id)).toEqual(["t3", "t5", "t7"])
  })

  test("an absent id has no node and never throws", () => {
    const g = graphOf([mkTask("t1")])
    expect(g.getNode("t99")).toBeUndefined()
    expect(g.parent("t99")).toBeNull()
    expect(g.dependencies("t99")).toEqual([])
    expect(g.dependents("t99")).toEqual([])
    expect(g.children("t99")).toEqual([])
    expect(g.blockers("t99")).toEqual([])
    expect(g.isReady("t99")).toBe(false)
    expect(g.notReadyReason("t99")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
describe("B/C. ordering and reorder", () => {
  test("order ascending, then taskId ascending as the tiebreak", () => {
    const g = graphOf([
      mkTask("t3", { order: 2 }),
      mkTask("t1", { order: 1 }),
      mkTask("t2", { order: 1 }),
    ])
    expect(g.nodes().map((n) => n.id)).toEqual(["t1", "t2", "t3"])
  })

  test("id tiebreak is lexicographic, matching SQLite BINARY collation", () => {
    // t10 < t2 as TEXT — the same result listTasks produces.
    const g = graphOf([mkTask("t2", { order: 1 }), mkTask("t10", { order: 1 })])
    expect(g.nodes().map((n) => n.id)).toEqual(["t10", "t2"])
  })

  test("ordering never uses title", () => {
    const g = graphOf([mkTask("t1", { title: "zebra" }), mkTask("t2", { title: "apple" })])
    expect(g.nodes().map((n) => n.id)).toEqual(["t1", "t2"])
  })

  test("deterministic: the same snapshot content yields the same graph", () => {
    const tasks = [mkTask("t2", { order: 2 }), mkTask("t1", { order: 1 })]
    const a = graphOf(tasks)
    const b = graphOf([...tasks].reverse())
    expect(a.nodes().map((n) => n.id)).toEqual(b.nodes().map((n) => n.id))
    expect(a.validity()).toEqual(b.validity())
  })

  test("C. reordering changes iteration order but never identity", () => {
    const before = graphOf([mkTask("t1", { order: 1 }), mkTask("t2", { order: 2 })])
    const after = graphOf([mkTask("t1", { order: 2 }), mkTask("t2", { order: 1 })])
    expect(before.nodes().map((n) => n.id)).toEqual(["t1", "t2"])
    expect(after.nodes().map((n) => n.id)).toEqual(["t2", "t1"])
    // Same ids, same relations — only order moved.
    expect(after.getNode("t1")?.id).toBe("t1")
    expect(after.getNode("t2")?.id).toBe("t2")
    expect(after.dependents("t1")).toEqual(before.dependents("t1"))
  })
})

// ---------------------------------------------------------------------------
describe("D/E. relations", () => {
  test("parent: child -> parent, and children are the reverse edge", () => {
    const g = graphOf([mkTask("t1"), mkTask("t2", { parentId: "t1" }), mkTask("t3", { parentId: "t1" })])
    expect(g.parent("t2")).toBe("t1")
    expect(g.parent("t1")).toBeNull()
    expect(g.children("t1")).toEqual(["t2", "t3"])
    expect(g.children("t2")).toEqual([])
    expect(g.validity().valid).toBe(true)
  })

  test("dependency: dependent -> dependency, and dependents is the reverse edge", () => {
    const g = graphOf([mkTask("t1"), mkTask("t2", { dependsOn: ["t1"] })])
    expect(g.dependencies("t2")).toEqual(["t1"])
    expect(g.dependencies("t1")).toEqual([])
    expect(g.dependents("t1")).toEqual(["t2"])
    expect(g.dependents("t2")).toEqual([])
  })

  test("parent and dependency stay separate relations", () => {
    // t2 is BOTH a child of t1 and depends on t1 — the graph must keep the
    // two edges distinct, never merge them.
    const g = graphOf([mkTask("t1"), mkTask("t2", { parentId: "t1", dependsOn: ["t1"] })])
    expect(g.parent("t2")).toBe("t1")
    expect(g.dependencies("t2")).toEqual(["t1"])
    expect(g.children("t1")).toEqual(["t2"])
    expect(g.dependents("t1")).toEqual(["t2"])
  })

  test("parent never gates readiness (design lock S5)", () => {
    // The parent is unfinished, but the child is still ready: containment is
    // structure, not an execution gate.
    const g = graphOf([mkTask("t1", { status: "PENDING" }), mkTask("t2", { parentId: "t1" })])
    expect(g.isReady("t2")).toBe(true)
    expect(g.readyTasks()).toContain("t2")
    expect(kindsOf(g, "t2")).toEqual([])
  })

  test("an unfinished dependency DOES gate readiness (the contrast)", () => {
    const g = graphOf([mkTask("t1", { status: "PENDING" }), mkTask("t2", { dependsOn: ["t1"] })])
    expect(g.isReady("t2")).toBe(false)
    expect(kindsOf(g, "t2")).toEqual(["DEPENDENCY_UNSATISFIED"])
  })
})

// ---------------------------------------------------------------------------
describe("F/G/H/I. invalid references", () => {
  test("F. missing parent -> INVALID DANGLING_PARENT (reachable from TaskStore)", () => {
    const g = graphOf([mkTask("t1", { parentId: "t99" })])
    expect(g.validity().valid).toBe(false)
    expect(g.validity().diagnostics.map((d) => d.kind)).toContain("DANGLING_PARENT")
    expect(kindsOf(g, "t1")).toEqual(["PARENT_MISSING"])
  })

  test("G. missing dependency -> INVALID DANGLING_DEPENDENCY (defensive)", () => {
    const g = graphOf([mkTask("t1", { dependsOn: ["t99"] })])
    expect(g.validity().valid).toBe(false)
    expect(g.validity().diagnostics.map((d) => d.kind)).toContain("DANGLING_DEPENDENCY")
    expect(kindsOf(g, "t1")).toEqual(["DANGLING_DEPENDENCY"])
  })

  test("H. parent self-reference -> INVALID SELF_PARENT + SELF_REFERENCE blocker", () => {
    const g = graphOf([mkTask("t1", { parentId: "t1" })])
    expect(g.validity().valid).toBe(false)
    expect(g.validity().diagnostics.map((d) => d.kind)).toContain("SELF_PARENT")
    const blockers = g.blockers("t1")
    expect(blockers[0]?.kind).toBe("SELF_REFERENCE")
    expect(blockers[0]?.relation).toBe("parent")
    expect(blockers[0]?.taskId).toBe("")
  })

  test("I. dependency self-reference -> INVALID SELF_DEPENDENCY", () => {
    const g = graphOf([mkTask("t1", { dependsOn: ["t1"] })])
    expect(g.validity().valid).toBe(false)
    expect(g.validity().diagnostics.map((d) => d.kind)).toContain("SELF_DEPENDENCY")
    const blockers = g.blockers("t1")
    expect(blockers[0]?.kind).toBe("SELF_REFERENCE")
    expect(blockers[0]?.relation).toBe("dependency")
  })

  test("defensive: duplicate node id -> INVALID DUPLICATE_NODE, first wins", () => {
    const g = graphOf([mkTask("t1", { title: "first" }), mkTask("t1", { title: "second" })])
    expect(g.validity().valid).toBe(false)
    expect(g.validity().diagnostics.map((d) => d.kind)).toContain("DUPLICATE_NODE")
    expect(g.nodeCount).toBe(1)
    expect(g.getNode("t1")?.title).toBe("first")
  })

  test("defensive: duplicate dependency -> INVALID, blocker not duplicated", () => {
    const g = graphOf([mkTask("t1", { status: "COMPLETED" }), mkTask("t2", { dependsOn: ["t1", "t1"] })])
    expect(g.validity().valid).toBe(false)
    expect(g.validity().diagnostics.map((d) => d.kind)).toContain("DUPLICATE_DEPENDENCY")
    expect(g.blockers("t2")).toEqual([])
  })

  test("defensive: malformed relation -> INVALID MALFORMED_RELATION", () => {
    const g = graphOf([mkTask("t1", { parentId: "not-an-id" }), mkTask("t2", { dependsOn: ["t0"] })])
    const kinds = g.validity().diagnostics.map((d) => d.kind)
    expect(kinds).toContain("MALFORMED_RELATION")
    expect(g.validity().valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
describe("J/K. cycles", () => {
  test("J. parent cycle -> INVALID PARENT_CYCLE", () => {
    const g = graphOf([
      mkTask("t1", { parentId: "t2" }),
      mkTask("t2", { parentId: "t3" }),
      mkTask("t3", { parentId: "t1" }),
    ])
    expect(g.validity().valid).toBe(false)
    const cycle = g.validity().diagnostics.find((d) => d.kind === "PARENT_CYCLE")
    expect(cycle).toBeDefined()
    expect([...(cycle?.members ?? [])].sort()).toEqual(["t1", "t2", "t3"])
    for (const id of ["t1", "t2", "t3"]) {
      expect(kindsOf(g, id)).toContain("PARENT_CYCLE")
    }
  })

  test("J. a 2-node parent cycle is detected", () => {
    const g = graphOf([mkTask("t1", { parentId: "t2" }), mkTask("t2", { parentId: "t1" })])
    expect(g.validity().diagnostics.some((d) => d.kind === "PARENT_CYCLE")).toBe(true)
  })

  test("K. dependency cycle -> VALID graph, members permanently blocked", () => {
    const g = graphOf([
      mkTask("t1", { dependsOn: ["t2"] }),
      mkTask("t2", { dependsOn: ["t1"] }),
    ])
    // The deliberate asymmetry: well-formed but unsatisfiable.
    expect(g.validity().valid).toBe(true)
    expect(g.validity().diagnostics).toEqual([])
    for (const id of ["t1", "t2"]) {
      const blockers = g.blockers(id)
      expect(blockers[0]?.kind).toBe("DEPENDENCY_CYCLE")
      expect(blockers[0]?.permanent).toBe(true)
      expect(g.isReady(id)).toBe(false)
    }
    expect(g.readyTasks()).toEqual([])
  })

  test("K. a 3-node dependency cycle is detected", () => {
    const g = graphOf([
      mkTask("t1", { dependsOn: ["t3"] }),
      mkTask("t2", { dependsOn: ["t1"] }),
      mkTask("t3", { dependsOn: ["t2"] }),
    ])
    expect(g.validity().valid).toBe(true)
    for (const id of ["t1", "t2", "t3"]) {
      expect(kindsOf(g, id)).toContain("DEPENDENCY_CYCLE")
    }
  })

  test("K. a diamond is NOT a cycle", () => {
    // t4 depends on both t2 and t3, which both depend on t1. No cycle.
    const g = graphOf([
      mkTask("t1", { status: "COMPLETED" }),
      mkTask("t2", { status: "COMPLETED", dependsOn: ["t1"] }),
      mkTask("t3", { status: "COMPLETED", dependsOn: ["t1"] }),
      mkTask("t4", { dependsOn: ["t2", "t3"] }),
    ])
    expect(g.validity().valid).toBe(true)
    expect(g.blockers("t4")).toEqual([])
    expect(g.isReady("t4")).toBe(true)
  })

  test("K. cycle membership does not leak to non-members", () => {
    const g = graphOf([
      mkTask("t1", { dependsOn: ["t2"] }),
      mkTask("t2", { dependsOn: ["t1"] }),
      mkTask("t3"),
    ])
    expect(kindsOf(g, "t1")).toEqual(["DEPENDENCY_CYCLE"])
    expect(kindsOf(g, "t3")).toEqual([])
    expect(g.isReady("t3")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
describe("L. dependency satisfaction — only COMPLETED", () => {
  // PHASE 5D.1: `test.each` types its callback parameter as `unknown`, which
  // cannot carry a `TaskStatus` annotation and leaked `unknown` into 10 type
  // errors. A typed `for` loop over the same fixture list gives real inference
  // with no cast and no suppression, and produces the same test names and the
  // same assertions.
  for (const status of ALL_STATUSES) {
    test(`dependency with status ${status}`, () => {
      const g = graphOf([
        mkTask("t1", { status, blockedReason: status === "BLOCKED" ? "cause" : null }),
        mkTask("t2", { dependsOn: ["t1"] }),
      ])
      const satisfied = status === "COMPLETED"
      const blockers = g.blockers("t2")

      if (satisfied) {
        expect(blockers).toEqual([])
        expect(g.isReady("t2")).toBe(true)
      } else {
        expect(blockers.length).toBe(1)
        const terminal = status === "CANCELLED" || status === "FAILED"
        expect(blockers[0]?.kind).toBe(terminal ? "DEPENDENCY_TERMINAL" : "DEPENDENCY_UNSATISFIED")
        expect(blockers[0]?.permanent).toBe(terminal)
        expect(g.isReady("t2")).toBe(false)
      }
    })
  }

  test("COMPLETED is the only satisfying status — explicit negation table", () => {
    for (const status of ALL_STATUSES) {
      const g = graphOf([mkTask("t1", { status }), mkTask("t2", { dependsOn: ["t1"] })])
      const satisfied = g.blockers("t2").length === 0
      expect(satisfied).toBe(status === "COMPLETED")
    }
  })
})

// ---------------------------------------------------------------------------
describe("M. readiness matrix", () => {
  // PHASE 5D.1: typed `for` loop instead of `test.each` (see the note in
  // section L). Same names, same assertions, real type inference.
  for (const status of ALL_STATUSES) {
    test(`status ${status}: eligible / ready`, () => {
      const blockedReason = status === "BLOCKED" ? "waiting on review" : null
      const g = graphOf([mkTask("t1", { status, blockedReason })])

      const eligible = status === "PENDING" || status === "BLOCKED"
      expect(g.eligibleTasks()).toEqual(eligible ? ["t1"] : [])

      // Ready requires PENDING. BLOCKED is eligible but NEVER ready.
      const ready = status === "PENDING"
      expect(g.isReady("t1")).toBe(ready)
      expect(g.readyTasks()).toEqual(ready ? ["t1"] : [])
    })
  }

  test("BLOCKED is eligible but never ready — the anti-contradiction invariant", () => {
    const g = graphOf([mkTask("t1", { status: "BLOCKED", blockedReason: "cause" })])
    expect(g.eligibleTasks()).toEqual(["t1"])
    expect(g.isReady("t1")).toBe(false)
    expect(g.readyTasks()).not.toContain("t1")
  })

  test("readiness is transitive along a satisfied chain", () => {
    const g = graphOf([
      mkTask("t1", { status: "COMPLETED" }),
      mkTask("t2", { status: "COMPLETED", dependsOn: ["t1"] }),
      mkTask("t3", { dependsOn: ["t2"] }),
    ])
    expect(g.readyTasks()).toEqual(["t3"])
  })

  test("readiness appears only on the NEXT build, never in place", () => {
    // t1 is itself PENDING with no blockers, so it is ready; t2 waits on it.
    const first = graphOf([mkTask("t1", { status: "PENDING" }), mkTask("t2", { dependsOn: ["t1"] })])
    expect(first.readyTasks()).toEqual(["t1"])
    expect(first.isReady("t2")).toBe(false)
    // A new snapshot with t1 completed promotes t2 — in the NEW graph only.
    const second = graphOf([mkTask("t1", { status: "COMPLETED" }), mkTask("t2", { dependsOn: ["t1"] })])
    expect(second.readyTasks()).toEqual(["t2"])
    // The first graph is untouched by anything that happened afterwards.
    expect(first.readyTasks()).toEqual(["t1"])
    expect(first.isReady("t2")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
describe("N. blocker classification", () => {
  test("temporary vs permanent, and the cause id is carried", () => {
    const g = graphOf([
      mkTask("t1", { status: "IN_PROGRESS" }),
      mkTask("t2", { status: "CANCELLED" }),
      mkTask("t3", { status: "FAILED" }),
      mkTask("t9", { dependsOn: ["t1", "t2", "t3"] }),
    ])
    const blockers = g.blockers("t9")
    expect(blockers.map((b) => [b.kind, b.taskId, b.permanent])).toEqual([
      ["DEPENDENCY_UNSATISFIED", "t1", false],
      ["DEPENDENCY_TERMINAL", "t2", true],
      ["DEPENDENCY_TERMINAL", "t3", true],
    ])
    expect(blockers.every((b) => b.relation === "dependency")).toBe(true)
  })

  test("every blocker kind is reachable and correctly named", () => {
    const observed = new Set<string>()
    // DEPENDENCY_UNSATISFIED (dependency still moving) and DEPENDENCY_TERMINAL
    const a = graphOf([
      mkTask("t1", { status: "PENDING" }),
      mkTask("t2", { status: "FAILED" }),
      mkTask("t3", { dependsOn: ["t1"] }),
      mkTask("t4", { dependsOn: ["t2"] }),
    ])
    for (const b of a.blockers("t3")) observed.add(b.kind)
    for (const b of a.blockers("t4")) observed.add(b.kind)
    // DEPENDENCY_CYCLE
    const b = graphOf([mkTask("t1", { dependsOn: ["t2"] }), mkTask("t2", { dependsOn: ["t1"] })])
    for (const x of b.blockers("t1")) observed.add(x.kind)
    // DANGLING_DEPENDENCY (defensive)
    const c = graphOf([mkTask("t1", { dependsOn: ["t99"] })])
    for (const x of c.blockers("t1")) observed.add(x.kind)
    // PARENT_MISSING (reachable)
    const d = graphOf([mkTask("t1", { parentId: "t99" })])
    for (const x of d.blockers("t1")) observed.add(x.kind)
    // PARENT_CYCLE
    const e = graphOf([mkTask("t1", { parentId: "t2" }), mkTask("t2", { parentId: "t1" })])
    for (const x of e.blockers("t1")) observed.add(x.kind)
    // SELF_REFERENCE (defensive)
    const f = graphOf([mkTask("t1", { parentId: "t1" })])
    for (const x of f.blockers("t1")) observed.add(x.kind)

    expect([...observed].sort()).toEqual([
      "DANGLING_DEPENDENCY",
      "DEPENDENCY_CYCLE",
      "DEPENDENCY_TERMINAL",
      "DEPENDENCY_UNSATISFIED",
      "PARENT_CYCLE",
      "PARENT_MISSING",
      "SELF_REFERENCE",
    ])
  })

  test("durable status is never itself a blocker", () => {
    for (const status of ALL_STATUSES) {
      const g = graphOf([mkTask("t1", { status, blockedReason: status === "BLOCKED" ? "x" : null })])
      expect(g.blockers("t1")).toEqual([])
    }
  })

  test("blocker count respects dependency degree", () => {
    const deps = Array.from({ length: 32 }, (_, i) => `t${i + 1}`)
    const tasks = deps.map((id) => mkTask(id, { status: "PENDING" }))
    const g = graphOf([...tasks, mkTask("t99", { dependsOn: deps })])
    expect(g.blockers("t99").length).toBe(32)
  })
})

// ---------------------------------------------------------------------------
describe("O. NotReady union — FIVE states (Phase 5C.1 amendment)", () => {
  test("all five states are produced, and no sixth exists", () => {
    // ready
    expect(graphOf([mkTask("t1")]).notReadyReason("t1")).toEqual({ kind: "ready" })
    // eligible-not-ready  <- the 5C.1 correction
    expect(
      graphOf([mkTask("t1", { status: "BLOCKED", blockedReason: "waiting on review" })]).notReadyReason("t1"),
    ).toEqual({ kind: "eligible-not-ready", status: "BLOCKED" })
    // not-eligible
    expect(graphOf([mkTask("t1", { status: "COMPLETED" })]).notReadyReason("t1")).toEqual({
      kind: "not-eligible",
      status: "COMPLETED",
    })
    // blocked
    const blocked = graphOf([mkTask("t1", { status: "PENDING" }), mkTask("t2", { dependsOn: ["t1"] })])
      .notReadyReason("t2")
    expect(blocked?.kind).toBe("blocked")
    // graph-invalid
    const invalid = graphOf([mkTask("t1", { parentId: "t99" })]).notReadyReason("t1")
    expect(invalid?.kind).toBe("graph-invalid")
  })

  // --- brief S4.A: the case the original 5B union could not name -----------
  test("A. BLOCKED with zero blockers is eligible-not-ready, NOT not-eligible", () => {
    const g = graphOf([mkTask("t1", { status: "BLOCKED", blockedReason: "awaiting sign-off" })])

    // eligible...
    expect(g.eligibleTasks()).toEqual(["t1"])
    // ...but not ready
    expect(g.readyTasks()).toEqual([])
    expect(g.isReady("t1")).toBe(false)
    // ...and with no blockers at all
    expect(g.blockers("t1")).toEqual([])
    // ...so the reason must be the new variant.
    expect(g.notReadyReason("t1")).toEqual({ kind: "eligible-not-ready", status: "BLOCKED" })
  })

  test("B. BLOCKED with a dependency blocker reports blocked", () => {
    const g = graphOf([
      mkTask("t1", { status: "PENDING" }),
      mkTask("t2", { status: "BLOCKED", blockedReason: "cause", dependsOn: ["t1"] }),
    ])
    // Blockers outrank the status: the actionable reason is reported.
    expect(g.notReadyReason("t2")?.kind).toBe("blocked")
  })

  test("C. PENDING with no blockers is ready", () => {
    const g = graphOf([mkTask("t1")])
    expect(g.notReadyReason("t1")).toEqual({ kind: "ready" })
    expect(g.isReady("t1")).toBe(true)
  })

  test("D. PENDING with blockers is blocked", () => {
    const g = graphOf([mkTask("t1", { status: "PENDING" }), mkTask("t2", { dependsOn: ["t1"] })])
    expect(g.notReadyReason("t2")?.kind).toBe("blocked")
    expect(g.isReady("t2")).toBe(false)
  })

  test("E. every non-eligible, non-READY status is not-eligible", () => {
    for (const status of ["IN_PROGRESS", "VERIFYING", "RETRYING", "COMPLETED", "CANCELLED", "FAILED"] as const) {
      const g = graphOf([mkTask("t1", { status })])
      expect(g.notReadyReason("t1")).toEqual({ kind: "not-eligible", status })
      expect(g.eligibleTasks()).toEqual([])
    }
  })

  test("F. an invalid graph reports graph-invalid, even for a BLOCKED task", () => {
    const g = graphOf([mkTask("t1", { status: "BLOCKED", blockedReason: "cause", parentId: "t99" })])
    expect(g.notReadyReason("t1")?.kind).toBe("graph-invalid")
  })

  test("G. the state for every status x blocker combination is pinned", () => {
    // Exhaustiveness: for a VALID graph and a known id, exactly one state, and
    // it is the one the contract prescribes.
    for (const status of ALL_STATUSES) {
      const blockedReason = status === "BLOCKED" ? "cause" : null
      const eligible = status === "PENDING" || status === "BLOCKED"

      // no blockers
      const clean = graphOf([mkTask("t1", { status, blockedReason })])
      const expectedClean =
        status === "PENDING"
          ? "ready"
          : eligible
            ? "eligible-not-ready"
            : "not-eligible"
      expect({ status, blockers: 0, kind: clean.notReadyReason("t1")?.kind }).toEqual({
        status,
        blockers: 0,
        kind: expectedClean,
      })

      // with an unsatisfied dependency -> always `blocked`, for EVERY status.
      // t3 carries the loop's status and waits on t2, so this pins that
      // blockers outrank status rather than being overridden by it.
      const dirty = graphOf([
        mkTask("t1", { status, blockedReason }),
        mkTask("t2", { status: "PENDING" }),
        mkTask("t3", { status, blockedReason, dependsOn: ["t2"] }),
      ])
      expect({ status, kind: dirty.notReadyReason("t3")?.kind }).toEqual({
        status,
        kind: "blocked",
      })
    }
  })

  // PHASE 5D.1 defect D1 regression. COMPILE-SENSITIVE: the annotations below
  // only typecheck if `blockers()` really returns `readonly Blocker[]` on every
  // path. Under the original defect (returning `EMPTY_IDS`, a
  // `readonly string[]`) `g.blockers(id)[0]?.kind` is a type error, because
  // `string` has no `kind`. Runtime assertions cannot catch that; these can.
  test("D1: blockers() is typed as Blocker[] on every return path", () => {
    const g = graphOf([mkTask("t1")])

    // absent id -> the empty result is still Blocker[]
    const absent: Blocker["kind"] | undefined = g.blockers("t99")[0]?.kind
    expect(absent).toBeUndefined()

    // present id, no blockers -> also Blocker[]
    const present: Blocker["kind"] | undefined = g.blockers("t1")[0]?.kind
    expect(present).toBeUndefined()

    // a real blocker, and `permanent` is reachable as a boolean
    const blocked = graphOf([mkTask("t1", { status: "CANCELLED" }), mkTask("t2", { dependsOn: ["t1"] })])
    const first = blocked.blockers("t2")[0]
    const kind = first?.kind
    const permanent = first?.permanent
    expect(kind).toBe("DEPENDENCY_TERMINAL")
    expect(permanent).toBe(true)

    // the whole array is assignable to the declared element type
    const all: readonly Blocker[] = blocked.blockers("t2")
    expect(all.length).toBe(1)
  })

  test("eligible-not-ready is never used for a task that is not eligible", () => {    // The variant must not leak: only BLOCKED can produce it, because only
    // BLOCKED survives to step 4 of the classification.
    for (const status of ALL_STATUSES) {
      const g = graphOf([mkTask("t1", { status, blockedReason: status === "BLOCKED" ? "c" : null })])
      const kind = g.notReadyReason("t1")?.kind
      if (kind === "eligible-not-ready") {
        expect({ status, eligibleListed: g.eligibleTasks() }).toEqual({
          status: "BLOCKED",
          eligibleListed: ["t1"],
        })
      }
    }
  })

  test("the five states stay consistent with eligibleTasks/isReady/readyTasks", () => {
    // Design-consistency audit: no id may be simultaneously listed as eligible
    // and reported ready, and vice versa.
    const g = graphOf([
      mkTask("t1", { status: "BLOCKED", blockedReason: "c" }),
      mkTask("t2", { status: "PENDING" }),
      mkTask("t3", { status: "COMPLETED" }),
      mkTask("t4", { dependsOn: ["t3"] }),
    ])
    const eligible = g.eligibleTasks()
    const ready = g.readyTasks()
    // t1 BLOCKED, t2 and t4 PENDING are all eligible.
    // `eligibleTasks()` returns a readonly array, so sort a defensive copy
    // rather than mutating (or weakening the type of) the graph's own result.
    expect([...eligible].sort()).toEqual(["t1", "t2", "t4"])
    // t2 is ready outright; t4's dependency t3 is COMPLETED, so t4 is ready too.
    // t1 is eligible but never ready.
    expect(ready).toEqual(["t2", "t4"])
    expect(eligible).toContain("t1")
    expect(ready).not.toContain("t1")
    // eligible is a superset of ready, and the difference is exactly t1.
    expect([...eligible].filter((id) => !ready.includes(id))).toEqual(["t1"])
    // The eligible-but-not-ready task says so.
    expect(g.notReadyReason("t1")?.kind).toBe("eligible-not-ready")
  })

  test("an invalid graph reports graph-invalid for every node, not a partial answer", () => {
    const g = graphOf([mkTask("t1", { parentId: "t99" }), mkTask("t2")])
    expect(g.notReadyReason("t1")?.kind).toBe("graph-invalid")
    expect(g.notReadyReason("t2")?.kind).toBe("graph-invalid")
  })
})

// ---------------------------------------------------------------------------
describe("P/Q. invalid graph handling", () => {
  test("P. construction never throws for malformed graph data", () => {
    const cases: Task[][] = [
      [mkTask("t1", { parentId: "t99" })],
      [mkTask("t1", { dependsOn: ["t99"] })],
      [mkTask("t1", { parentId: "t1" })],
      [mkTask("t1", { dependsOn: ["t1"] })],
      [mkTask("t1", { parentId: "t2" }), mkTask("t2", { parentId: "t1" })],
      [mkTask("t1", { dependsOn: ["t2"] }), mkTask("t2", { dependsOn: ["t1"] })],
      [mkTask("t1", { dependsOn: ["bad"] })],
      [mkTask("t1"), mkTask("t1")],
      [mkTask("t1", { parentId: "!!!" })],
    ]
    for (const tasks of cases) {
      expect(() => graphOf(tasks)).not.toThrow()
    }
  })

  test("Q. readyTasks() is empty on an invalid graph, even for clean nodes", () => {
    const g = graphOf([mkTask("t1", { parentId: "t99" }), mkTask("t2")])
    expect(g.validity().valid).toBe(false)
    expect(g.readyTasks()).toEqual([])
    expect(g.isReady("t2")).toBe(false)
    // eligibleTasks is independent of validity.
    expect(g.eligibleTasks()).toEqual(["t1", "t2"])
  })

  test("Q. the invalid-graph guard is load-bearing at the readyTasks() layer", () => {
    // `readyTasks()` and `computeIsReady()` BOTH refuse to publish readiness on
    // an invalid graph — defence in depth. Removing only the readyTasks()
    // guard is behaviourally equivalent, so this test pins the guard's own
    // contract independently of the lower layer.
    const g = graphOf([mkTask("t1", { parentId: "t99" }), mkTask("t2", { status: "PENDING" })])
    expect(g.validity().valid).toBe(false)
    // t2 is PENDING with zero blockers — only the invalid-graph guard can
    // keep it out of readyTasks().
    expect(g.blockers("t2")).toEqual([])
    expect(g.isReady("t2")).toBe(false)
    expect(g.readyTasks()).toEqual([])
    // ...and the same node IS ready once the graph is repaired.
    const repaired = graphOf([mkTask("t1"), mkTask("t99"), mkTask("t2", { status: "PENDING" })])
    expect(repaired.validity().valid).toBe(true)
    expect(repaired.isReady("t2")).toBe(true)
  })

  test("an empty snapshot is valid and trivially ready-empty", () => {
    const g = new TaskGraph({ sessionId: "s1", tasks: [] })
    expect(g.validity().valid).toBe(true)
    expect(g.nodes()).toEqual([])
    expect(g.readyTasks()).toEqual([])
    expect(g.sourceMaxRevision).toBe(0)
    expect(g.nodeCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
describe("R/S. staleness and immutability", () => {
  test("R. sourceMaxRevision is the maximum revision in the snapshot", () => {
    const g = graphOf([
      mkTask("t1", { revision: 3 }),
      mkTask("t2", { revision: 11 }),
      mkTask("t3", { revision: 7 }),
    ])
    expect(g.sourceMaxRevision).toBe(11)
  })

  test("S. a later mutation of the source rows cannot change a built graph", () => {
    const source = mkTask("t1", { status: "PENDING", dependsOn: [] })
    const g = graphOf([source])

    // Mutate the source row and the dependsOn array after construction.
    source.status = "COMPLETED"
    ;(source as { title: string }).title = "mutated"
    source.dependsOn.push("t77")

    expect(g.getNode("t1")?.status).toBe("PENDING")
    expect(g.getNode("t1")?.title).toBe("task t1")
    expect(g.dependencies("t1")).toEqual([])
    expect(g.isReady("t1")).toBe(true)
  })

  test("S. nodes and their relation arrays are frozen", () => {
    const g = graphOf([mkTask("t1"), mkTask("t2", { dependsOn: ["t1"] })])
    expect(Object.isFrozen(g.nodes())).toBe(true)
    expect(Object.isFrozen(g.getNode("t1"))).toBe(true)
    expect(Object.isFrozen(g.dependencies("t2"))).toBe(true)
    expect(Object.isFrozen(g.children("t1"))).toBe(true)
  })

  test("S. the projection carries blockedReason but does not reason with it", () => {
    const g = graphOf([mkTask("t1", { status: "BLOCKED", blockedReason: "needs review" })])
    expect(g.getNode("t1")?.blockedReason).toBe("needs review")
    // ...and it is never a blocker.
    expect(g.blockers("t1")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
describe("T/U/V. omission, cancellation, failure", () => {
  test("T. a retained (D7) task is a normal node that was simply not declared", () => {
    // Omission is not deletion: the task is present and readable.
    const g = graphOf([mkTask("t1", { status: "PENDING" }), mkTask("t2", { status: "IN_PROGRESS" })])
    expect(g.nodeCount).toBe(2)
    expect(g.getNode("t2")?.status).toBe("IN_PROGRESS")
  })

  test("U. a CANCELLED dependency blocks permanently", () => {
    const g = graphOf([mkTask("t1", { status: "CANCELLED" }), mkTask("t2", { dependsOn: ["t1"] })])
    const blockers = g.blockers("t2")
    expect(blockers[0]?.kind).toBe("DEPENDENCY_TERMINAL")
    expect(blockers[0]?.permanent).toBe(true)
    expect(g.isReady("t2")).toBe(false)
    // The cancelled task itself is not eligible and not blocked.
    expect(g.isReady("t1")).toBe(false)
    expect(g.blockers("t1")).toEqual([])
  })

  test("V. a FAILED dependency blocks permanently and does not satisfy", () => {
    const g = graphOf([mkTask("t1", { status: "FAILED" }), mkTask("t2", { dependsOn: ["t1"] })])
    expect(g.blockers("t2")[0]?.kind).toBe("DEPENDENCY_TERMINAL")
    expect(g.blockers("t2")[0]?.permanent).toBe(true)
    expect(g.isReady("t2")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
describe("W/X/Y. scale", () => {
  test("W. a 1 000-node graph with a dependency chain", () => {
    const tasks: Task[] = []
    for (let i = 1; i <= 1000; i++) {
      tasks.push(
        mkTask(`t${i}`, {
          status: i < 1000 ? "COMPLETED" : "PENDING",
          dependsOn: i > 1 ? [`t${i - 1}`] : [],
        }),
      )
    }
    const g = graphOf(tasks)
    expect(g.validity().valid).toBe(true)
    expect(g.nodeCount).toBe(1000)
    expect(g.readyTasks()).toEqual(["t1000"])
  })

  test("X. a 10 000-deep parent chain does not overflow the stack", () => {
    const tasks: Task[] = []
    for (let i = 1; i <= 10000; i++) {
      tasks.push(mkTask(`t${i}`, { parentId: i > 1 ? `t${i - 1}` : null }))
    }
    const g = graphOf(tasks)
    // A recursive implementation throws RangeError here; an iterative one does not.
    expect(g.validity().valid).toBe(true)
    expect(g.validity().diagnostics).toEqual([])
    expect(g.nodeCount).toBe(10000)
    expect(g.parent("t10000")).toBe("t9999")
    expect(g.children("t1")).toEqual(["t2"])
  })

  test("X. a 10 000-deep DEPENDENCY chain does not overflow the stack", () => {
    const tasks: Task[] = []
    for (let i = 1; i <= 10000; i++) {
      tasks.push(mkTask(`t${i}`, { dependsOn: i > 1 ? [`t${i - 1}`] : [] }))
    }
    const g = graphOf(tasks)
    expect(g.validity().valid).toBe(true)
    expect(g.nodeCount).toBe(10000)
    // Only the last node could be ready, and only if every dependency is COMPLETED.
    expect(g.blockers("t10000").length).toBe(1)
    expect(g.blockers("t10000")[0]?.kind).toBe("DEPENDENCY_UNSATISFIED")
  })

  test("X. a 10 000-deep parent CYCLE is detected without overflow", () => {
    const tasks: Task[] = []
    for (let i = 1; i <= 10000; i++) {
      tasks.push(mkTask(`t${i}`, { parentId: `t${(i % 10000) + 1}` }))
    }
    const g = graphOf(tasks)
    expect(g.validity().valid).toBe(false)
    expect(g.validity().diagnostics.some((d) => d.kind === "PARENT_CYCLE")).toBe(true)
  })

  test("Y. 200-child fan-out is allowed (MAX_PARENT is not enforced)", () => {
    // 200 > MAX_PARENT (64), which TaskStore declares but never enforces.
    const tasks: Task[] = [mkTask("t1")]
    for (let i = 2; i <= 201; i++) tasks.push(mkTask(`t${i}`, { parentId: "t1" }))
    const g = graphOf(tasks)
    expect(g.children("t1").length).toBe(200)
    expect(g.validity().valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// INTEGRATION: the graph over a REAL TaskStore snapshot.
//
// The unit fixtures above hand-build snapshots so every state is reachable in
// one line. These drive the real store instead, which serves two purposes:
//  1. it proves TaskGraph consumes the genuine `getSnapshot` output; and
//  2. it PROVES the brief-S18 split — which malformed states TaskStore actually
//     lets through (parent cycle, dependency cycle, missing parent) versus
//     which it rejects, leaving them genuinely defensive-only.
describe("INTEGRATION. a real TaskStore snapshot", () => {
  let dir: string
  let store: TaskStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "minicode-taskgraph-"))
    store = new TaskStore(dir)
  })
  afterEach(async () => {
    // Windows holds the SQLite handle; release it before removing the dir.
    resetTaskStoreHandles()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  const S = "sess-int"
  const create = (title: string, over: Partial<NewTaskInput> = {}) =>
    store.createTask(S, {
      title,
      status: "PENDING",
      order: 1,
      provenance: { origin: "model", source: "test" },
      ...over,
    })
  const graph = () => new TaskGraph(store.getSnapshot(S))

  test("consumes the real getSnapshot output and derives readiness", () => {
    const a = create("a")
    const b = create("b", { dependsOn: [a.id] })
    const g = graph()
    expect(g.nodeCount).toBe(2)
    expect(g.getNode(a.id)?.title).toBe("a")
    expect(g.dependencies(b.id)).toEqual([a.id])
    expect(g.dependents(a.id)).toEqual([b.id])
    // Both PENDING: `a` is ready, `b` waits on it.
    expect(g.readyTasks()).toEqual([a.id])
    expect(g.isReady(b.id)).toBe(false)
  })

  test("REACHABLE: a dependency cycle really persists in the real store", () => {
    const a = create("a")
    const b = create("b", { dependsOn: [a.id] })
    store.patchTask(S, a.id, { dependsOn: [b.id] }) // closes the cycle
    const g = graph()
    expect(g.validity().valid).toBe(true) // valid graph, unsatisfiable
    expect(g.blockers(a.id)[0]?.kind).toBe("DEPENDENCY_CYCLE")
    expect(g.blockers(b.id)[0]?.kind).toBe("DEPENDENCY_CYCLE")
    expect(g.readyTasks()).toEqual([])
  })

  test("REACHABLE: a parent cycle really persists in the real store", () => {
    const a = create("a")
    const b = create("b", { parentId: a.id })
    store.patchTask(S, a.id, { parentId: b.id })
    const g = graph()
    expect(g.validity().valid).toBe(false)
    expect(g.validity().diagnostics.some((d) => d.kind === "PARENT_CYCLE")).toBe(true)
    expect(g.readyTasks()).toEqual([])
  })

  test("REACHABLE: a missing parent really persists in the real store", () => {
    const a = create("a")
    store.patchTask(S, a.id, { parentId: "t9999" }) // an id that will never exist
    const g = graph()
    expect(g.validity().valid).toBe(false)
    expect(g.validity().diagnostics.some((d) => d.kind === "DANGLING_PARENT")).toBe(true)
    expect(g.blockers(a.id)[0]?.kind).toBe("PARENT_MISSING")
  })

  test("DEFENSIVE: the real store refuses the states that only exist in fixtures", () => {
    const a = create("a")
    expect(() => create("bad", { dependsOn: ["t9999"] })).toThrow() // missing dependency
    expect(() => store.patchTask(S, a.id, { dependsOn: [a.id] })).toThrow() // self dependency
    expect(() => store.patchTask(S, a.id, { parentId: a.id })).toThrow() // self parent
    expect(() => create("dup", { dependsOn: [a.id, a.id] })).toThrow() // duplicate dependency
    // => these four are unreachable through TaskStore, so the graph's handling
    //    of them is real defence in depth, exercised only by unit fixtures.
  })

  test("readiness follows a real status transition on the next snapshot", () => {
    const a = create("a")
    const b = create("b", { dependsOn: [a.id] })
    expect(graph().readyTasks()).toEqual([a.id])

    store.patchTask(S, a.id, { status: "COMPLETED" })
    const after = graph()
    expect(after.readyTasks()).toEqual([b.id])
    expect(after.blockers(b.id)).toEqual([])

    store.patchTask(S, a.id, { status: "FAILED" })
    const failed = graph()
    expect(failed.blockers(b.id)[0]?.kind).toBe("DEPENDENCY_TERMINAL")
    expect(failed.blockers(b.id)[0]?.permanent).toBe(true)
    expect(failed.readyTasks()).toEqual([])
  })

  test("a 'READY' status written to the store is coerced, so readiness stays derived", () => {
    const a = create("a", { status: "READY" as TaskStatus })
    expect(store.getSnapshot(S).tasks[0]?.status).not.toBe("READY")
    const g = graph()
    expect(g.getNode(a.id)?.status).toBe("PENDING")
    expect(g.isReady(a.id)).toBe(true)
  })

  test("sourceMaxRevision: a WEAK hint, exactly as the design says", () => {
    const a = create("a")
    const first = graph().sourceMaxRevision

    // Adding a brand-new task does NOT raise the hint: a new row starts at
    // revision 1, so the maximum across the snapshot is unchanged. This is the
    // documented weakness of the hint (design lock S15) — it is not a
    // version, not a CAS, and a consumer must re-read TaskStore for certainty.
    create("b")
    expect(graph().sourceMaxRevision).toBe(first)

    // Mutating an EXISTING task does raise it, because that row's own
    // revision increments.
    store.patchTask(S, a.id, { title: "a2" })
    const second = graph().sourceMaxRevision
    expect(second).toBeGreaterThan(first)
    expect(graph().nodes().find((n) => n.id === a.id)?.title).toBe("a2")
  })

  test("the graph is a pure function of the snapshot it was given", () => {
    create("a")
    create("b")
    const snap = store.getSnapshot(S)
    const g1 = new TaskGraph(snap)
    // Mutate the SOURCE snapshot after the graph was built.
    snap.tasks[0]!.title = "mutated after build"
    snap.tasks.push(mkTask("t9999"))
    const g2 = new TaskGraph(store.getSnapshot(S))
    expect(g1.nodeCount).toBe(2)
    expect(g2.nodeCount).toBe(2)
    expect(g1.nodes().map((n) => n.title)).not.toContain("mutated after build")
    expect(g1.nodes().map((n) => n.id)).toEqual(g2.nodes().map((n) => n.id))
  })

  test("an empty session yields a valid, empty graph", () => {
    const g = new TaskGraph(store.getSnapshot("never-used"))
    expect(g.validity().valid).toBe(true)
    expect(g.nodes()).toEqual([])
    expect(g.readyTasks()).toEqual([])
    expect(g.sourceMaxRevision).toBe(0)
  })
})

// ---------------------------------------------------------------------------
describe("Z. purity — construction performs no I/O", () => {
  // Static proof over the three new modules: strip comments, then assert that
  // no capability outside pure computation is even referenced.
  const MODULES = ["graph.ts", "graph-validate.ts", "readiness.ts"]

  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ")

  test("no filesystem, database, process, randomness or id-allocation references", () => {
    const FORBIDDEN = [
      "node:fs", "node:path", "node:os", "node:child_process", "node:crypto",
      "bun:sqlite", "better-sqlite3", "DatabaseSync", "readFileSync", "writeFileSync",
      "process.", "Math.random", "crypto.", "Date.now", "new Date(",
      "taskIdFromIndex", "nextId", "fetch(", "require(",
    ]
    for (const name of MODULES) {
      const code = stripComments(readFileSync(join(REPO, "src", "task", name), "utf8"))
      for (const token of FORBIDDEN) {
        expect({ module: name, token, present: code.includes(token) }).toEqual({
          module: name,
          token,
          present: false,
        })
      }
    }
  })

  test("the new modules import only types and this phase's own pure modules", () => {
    // Allowed: the model (types + the read-only id validator) and the two
    // sibling modules written in this phase. Anything else — notably
    // ./store, a database, or an execution surface — is a violation.
    const ALLOWED = new Set(["./model", "./graph-validate", "./readiness"])
    for (const name of MODULES) {
      const code = stripComments(readFileSync(join(REPO, "src", "task", name), "utf8"))
      const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string)
      for (const spec of imports) {
        expect({ module: name, spec, allowed: ALLOWED.has(spec) }).toEqual({
          module: name,
          spec,
          allowed: true,
        })
      }
    }
  })

  test("the public API exposes no mutation, claim or execution surface", () => {
    const g = graphOf([mkTask("t1")])
    const FORBIDDEN_METHODS = [
      "addNode", "setParent", "setStatus", "markReady", "claim", "execute",
      "retry", "cancel", "complete", "delete", "update", "patch", "nextId",
    ]
    for (const name of FORBIDDEN_METHODS) {
      expect(typeof (g as unknown as Record<string, unknown>)[name]).toBe("undefined")
    }
  })

  test("no durable READY status is introduced anywhere in the new modules", () => {
    for (const name of MODULES) {
      const code = stripComments(readFileSync(join(REPO, "src", "task", name), "utf8"))
      // A quoted "READY" literal would be a durable status, not a derived answer.
      expect(code.includes('"READY"')).toBe(false)
      expect(code.includes("'READY'")).toBe(false)
    }
  })

  test("PAUSED is referenced nowhere in executable code (comments excepted)", () => {
    // A comment explaining that PAUSED was deliberately omitted is good
    // documentation; what must not exist is a reference in code.
    for (const name of MODULES) {
      const code = stripComments(readFileSync(join(REPO, "src", "task", name), "utf8"))
      expect({ module: name, present: code.includes("PAUSED") }).toEqual({
        module: name,
        present: false,
      })
    }
  })

  test("the real TaskStatus list is exactly the 8 statuses this phase designs for", () => {
    // Guards the brief's S19 precondition: no PAUSED, no READY, exactly 8.
    const model = stripComments(readFileSync(join(REPO, "src", "task", "model.ts"), "utf8"))
    const block = /const TASK_STATUSES[^=]*=\s*\[([^\]]*)\]/.exec(model)
    expect(block).not.toBeNull()
    const declared = [...(block?.[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as string).sort()
    expect(declared).toEqual([...ALL_STATUSES].sort())
    expect(declared).toHaveLength(8)
    expect(declared).not.toContain("PAUSED")
    expect(declared).not.toContain("READY")
  })

  // The brief requires iterative traversal for the 10 000-depth fixture. A
  // behavioural depth test CANNOT verify that on its own: measured under
  // bun 1.4.2, recursion survives a 2 000 000-deep call chain without
  // overflowing, so a recursive implementation passes a 10 000-node fixture
  // too. Measured thresholds: 10k OK, 200k OK, 2M OK. The requirement is
  // therefore asserted STRUCTURALLY here — no declared function may call
  // itself — and the 10 000-depth fixture covers the behavioural half.
  test("cycle detection is iterative: no declared function calls itself", () => {
    const bodyOf = (src: string, openIndex: number): string => {
      let depth = 0
      let seen = false
      for (let i = openIndex; i < src.length; i++) {
        const ch = src[i]
        if (ch === "{") {
          depth++
          seen = true
        } else if (ch === "}") {
          depth--
          if (seen && depth === 0) return src.slice(openIndex, i)
        }
      }
      return ""
    }
    const selfCalls = (src: string, name: string): boolean => {
      const body = bodyOf(src, src.indexOf("{", src.indexOf(name)))
      if (body === "") return false
      // ANY self-reference in the body is recursion. The threshold is 1, not 2:
      // a declaration sits before the opening brace, so `const f = () => { f() }`
      // and `function f() { f() }` both yield exactly one hit in the body.
      const hits = body.split(new RegExp(`\\b${name}\\b`)).length - 1
      return hits > 0
    }

    for (const name of MODULES) {
      const code = stripComments(readFileSync(join(REPO, "src", "task", name), "utf8"))

      const declared = [...code.matchAll(/function\s+(\w+)\s*\(/g)].map((m) => m[1] as string)
      const arrows = [...code.matchAll(/const\s+(\w+)\s*=\s*(?:\([^)]*\)|[\w]+)\s*(?::[^=]*?)?=>/g)].map(
        (m) => m[1] as string,
      )

      for (const fn of declared) {
        expect({ module: name, fn, recursive: selfCalls(code, fn) }).toEqual({
          module: name,
          fn,
          recursive: false,
        })
      }
      for (const fn of arrows) {
        expect({ module: name, fn, recursive: selfCalls(code, fn) }).toEqual({
          module: name,
          fn,
          recursive: false,
        })
      }
    }
  })
})

// ---------------------------------------------------------------------------
describe("status matrix (brief S19) — every real TaskStatus", () => {
  // Five axes. `reason` is the `notReadyReason` state for a task in this status
  // with NO blockers; `blocker` is what it causes on a dependent.
  //
  // PHASE 5D.1: keyed as `Record<TaskStatus, …>` rather than `Record<string, …>`
  // so the compiler proves the table is COMPLETE — a ninth key or a missing
  // status is now a type error, and `EXPECTED[status]` needs no cast.
  interface MatrixRow {
    eligible: boolean
    ready: boolean
    satisfies: boolean
    /** The blocker this status causes on a dependent; `""` when it satisfies. */
    blocker: Blocker["kind"] | ""
    reason: "ready" | "eligible-not-ready" | "not-eligible"
  }
  const EXPECTED: Record<TaskStatus, MatrixRow> = {
    PENDING:     { eligible: true,  ready: true,  satisfies: false, blocker: "DEPENDENCY_UNSATISFIED", reason: "ready" },
    BLOCKED:     { eligible: true,  ready: false, satisfies: false, blocker: "DEPENDENCY_UNSATISFIED", reason: "eligible-not-ready" },
    IN_PROGRESS: { eligible: false, ready: false, satisfies: false, blocker: "DEPENDENCY_UNSATISFIED", reason: "not-eligible" },
    VERIFYING:   { eligible: false, ready: false, satisfies: false, blocker: "DEPENDENCY_UNSATISFIED", reason: "not-eligible" },
    RETRYING:    { eligible: false, ready: false, satisfies: false, blocker: "DEPENDENCY_UNSATISFIED", reason: "not-eligible" },
    COMPLETED:   { eligible: false, ready: false, satisfies: true,  blocker: "",                        reason: "not-eligible" },
    CANCELLED:   { eligible: false, ready: false, satisfies: false, blocker: "DEPENDENCY_TERMINAL",     reason: "not-eligible" },
    FAILED:      { eligible: false, ready: false, satisfies: false, blocker: "DEPENDENCY_TERMINAL",     reason: "not-eligible" },
  }

  // Explicit total lookup: `noUncheckedIndexedAccess` makes a `Record` read
  // `MatrixRow | undefined`, and a missing row is a real fixture bug worth
  // failing loudly rather than papering over with a cast.
  const rowOf = (status: TaskStatus): MatrixRow => {
    const row: MatrixRow | undefined = EXPECTED[status]
    if (row === undefined) throw new Error(`no status-matrix row for ${status}`)
    return row
  }

  test("the matrix covers exactly the 8 real statuses and nothing else", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ALL_STATUSES].sort())
  })

  test("the NotReady states reachable by status alone are all exercised", () => {
    // `blocked` and `graph-invalid` need relations, so they are covered by
    // their own dedicated tests; this guards the three status-derived states.
    const fromMatrix = new Set(Object.values(EXPECTED).map((e) => e.reason))
    expect([...fromMatrix].sort()).toEqual(["eligible-not-ready", "not-eligible", "ready"])
  })

  // PHASE 5D.1: typed `for` loop instead of `test.each` (see the note in
  // section L). Same names, same assertions, real type inference.
  for (const status of ALL_STATUSES) {
    test(`${status}: eligible / ready / satisfies / blocker / reason`, () => {
      const expected = rowOf(status)
      const blockedReason = status === "BLOCKED" ? "cause" : null
      const g = graphOf([mkTask("t1", { status, blockedReason })])

      expect(g.eligibleTasks()).toEqual(expected.eligible ? ["t1"] : [])
      expect(g.isReady("t1")).toBe(expected.ready)
      // `ready` carries no status; the other states echo the durable status.
      expect(g.notReadyReason("t1")).toEqual(
        expected.reason === "ready" ? { kind: "ready" } : { kind: expected.reason, status },
      )

      const dependent = graphOf([
        mkTask("t1", { status, blockedReason }),
        mkTask("t2", { dependsOn: ["t1"] }),
      ])
      const kinds = kindsOf(dependent, "t2")
      if (expected.satisfies) {
        expect(kinds).toEqual([])
      } else if (expected.blocker !== "") {
        // Narrowed to `Blocker["kind"]`, so this compares like with like.
        expect(kinds).toEqual([expected.blocker])
      } else {
        throw new Error(`status ${status} neither satisfies nor blocks a dependent`)
      }
    })
  }
})
