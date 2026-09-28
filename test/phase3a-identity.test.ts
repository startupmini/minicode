// Phase 3A regression protection: canonical task IDENTITY substrate.
//
// SCOPE. Identity resolution and validation only: planning (pure), applying
// (delegated to TaskStore), and the invariants that identity survives reordering
// and restart. Deliberately NOT here: `TodoItem.taskId` propagation,
// `PlanStep.taskId`, `plan.updated` payloadVersion=2, the plan pipeline,
// TaskGraph or Scheduler - all Phase 3B or later.
//
// SAFETY (Phase 0A discipline): one `mkdtemp(join(tmpdir(), "minicode-id-"))`
// directory per test, removed by that exact absolute path only. No
// `readdir(".")`, no pattern delete, no cwd-based cleanup.

import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type DeclaredTask,
  applyTaskIdentities,
  planTaskIdentities,
  synchronizeIdentities,
  todoStatusToTask,
} from "../src/task/identity.ts"
import { isTaskId, TaskError } from "../src/task/model.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const owned: string[] = []

async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-id-"))
  owned.push(dir)
  return dir
}

afterEach(async () => {
  resetTaskStoreHandles()
  while (owned.length) {
    const dir = owned.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

const S1 = "sesi-identity"
const S2 = "sesi-lain"

const t = (title: string, status: DeclaredTask["status"] = "pending"): DeclaredTask => ({
  title,
  status,
})

/** Create three tasks and return them in creation order. */
function seedA(store: TaskStore, sessionId = S1) {
  return [
    store.createTask(sessionId, {
      title: "A",
      status: "PENDING",
      order: 0,
      provenance: { origin: "runtime", source: "test" },
    }),
    store.createTask(sessionId, {
      title: "B",
      status: "PENDING",
      order: 1,
      provenance: { origin: "runtime", source: "test" },
    }),
    store.createTask(sessionId, {
      title: "C",
      status: "PENDING",
      order: 2,
      provenance: { origin: "runtime", source: "test" },
    }),
  ]
}

// A. task ID validation
test("A. id validation accepts only canonical t<n>", () => {
  expect(isTaskId("t1")).toBe(true)
  expect(isTaskId("t999")).toBe(true)
  expect(isTaskId("t0")).toBe(false)
  expect(isTaskId("t01")).toBe(false)
  expect(isTaskId("T1")).toBe(false)
  expect(isTaskId("")).toBe(false)
  expect(isTaskId("abc")).toBe(false)
  expect(isTaskId(null)).toBe(false)
  // planning rejects a malformed explicit id with TASK_INVALID_ID
  expect(() => planTaskIdentities([{ ...t("x"), taskId: "bukan-id" }])).toThrow(TaskError)
  try {
    planTaskIdentities([{ ...t("x"), taskId: "t0" }])
    throw new Error("should have thrown")
  } catch (e) {
    expect((e as TaskError).code).toBe("TASK_INVALID_ID")
  }
})

test("A2. legacy status maps to canonical status", () => {
  expect(todoStatusToTask("pending")).toBe("PENDING")
  expect(todoStatusToTask("in_progress")).toBe("IN_PROGRESS")
  expect(todoStatusToTask("completed")).toBe("COMPLETED")
  expect(todoStatusToTask("cancelled")).toBe("CANCELLED")
  expect(todoStatusToTask("blocked")).toBe("BLOCKED")
})

// B. stable creation identity — TaskStore is the single allocator
test("B. identity is allocated by TaskStore, stably and monotonically", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  const made = seedA(store)
  expect(made.map((x) => x.id)).toEqual(["t1", "t2", "t3"])
  // a fresh declare-without-id allocates from the SAME allocator, continuing the
  // sequence rather than restarting at t1
  const out = synchronizeIdentities(store, S1, [t("baru")])
  expect(out.created.map((x) => x.id)).toEqual(["t4"])
  expect(out.existing).toHaveLength(0)
  // deleting a middle row must not make the next id collide (max, not count).
  // t4 already exists, so the max is 4 and the next id is t5 - NOT a reuse of
  // the freed t2.
  store.deleteTask(S1, "t2")
  expect(store.nextId(S1)).toBe("t5")
})

// C. reorder preservation
test("C. reordering preserves identity; only order changes", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  seedA(store)
  expect(store.listTasks(S1).map((x) => [x.id, x.order])).toEqual([
    ["t1", 0],
    ["t2", 1],
    ["t3", 2],
  ])

  // C -> A -> B, addressed by explicit id
  const out = synchronizeIdentities(store, S1, [
    { taskId: "t3", title: "C", status: "pending" },
    { taskId: "t1", title: "A", status: "pending" },
    { taskId: "t2", title: "B", status: "pending" },
  ])

  expect(out.created).toHaveLength(0)
  expect(out.existing.map((x) => x.id)).toEqual(["t3", "t1", "t2"])
  // the listing is ordered by (order, task_id), so display order is now C,A,B
  expect(store.listTasks(S1).map((x) => x.id)).toEqual(["t3", "t1", "t2"])
  // ids remain bound to their original titles
  expect(store.getTask(S1, "t1")?.title).toBe("A")
  expect(store.getTask(S1, "t2")?.title).toBe("B")
  expect(store.getTask(S1, "t3")?.title).toBe("C")
  // display order followed the reordering
  expect(store.getTask(S1, "t3")?.order).toBe(0)
  expect(store.getTask(S1, "t1")?.order).toBe(1)
  expect(store.getTask(S1, "t2")?.order).toBe(2)
})

// D. restart preservation — a genuine close and a new store instance
test("D. identity survives a real restart", async () => {
  const dir = await ownedDir()
  const first = new TaskStore(dir)
  seedA(first)
  const idsBefore = first.listTasks(S1).map((x) => x.id)
  const revBefore = first.listTasks(S1).map((x) => x.revision)

  TaskStore.close(dir)
  resetTaskStoreHandles()

  const second = new TaskStore(dir)
  expect(second.listTasks(S1).map((x) => x.id)).toEqual(idsBefore)
  expect(second.listTasks(S1).map((x) => x.revision)).toEqual(revBefore)
  // the reopened store resolves existing ids against the durable records
  const out = synchronizeIdentities(second, S1, [
    { taskId: "t2", title: "B diubah", status: "in_progress" },
  ])
  expect(out.created).toHaveLength(0)
  expect(out.existing[0]?.id).toBe("t2")
  expect(second.getTask(S1, "t2")?.title).toBe("B diubah")
  expect(second.getTask(S1, "t2")?.revision).toBe((revBefore[1] ?? 1) + 1)
})

// E. duplicate identity
test("E. a taskId repeated in one payload is rejected before any mutation", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  seedA(store)
  const revBefore = store.listTasks(S1).map((x) => x.revision)

  const plan = () =>
    planTaskIdentities([
      { taskId: "t1", title: "satu", status: "pending" },
      { taskId: "t2", title: "dua", status: "pending" },
      { taskId: "t1", title: "satu lagi", status: "pending" },
    ])
  expect(plan).toThrow(TaskError)
  try {
    plan()
  } catch (e) {
    expect((e as TaskError).code).toBe("TASK_DUPLICATE_ID")
  }
  // nothing was written: no title changed, no revision moved
  expect(store.listTasks(S1).map((x) => x.revision)).toEqual(revBefore)
  expect(store.getTask(S1, "t1")?.title).toBe("A")
  expect(store.listTasks(S1)).toHaveLength(3)
})

// F. malformed identity — and no partial mutation from a mixed bad batch
test("F. a mixed batch with a bad id writes nothing at all", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  seedA(store)
  const before = store.listTasks(S1).map((x) => `${x.id}:${x.revision}:${x.title}`)

  expect(() =>
    synchronizeIdentities(store, S1, [
      { taskId: "t1", title: "DIBAWAH", status: "pending" },
      { taskId: "t99", title: "hantu", status: "pending" },
    ]),
  ).toThrow(TaskError)
  // the valid entry that preceded the bad one was NOT applied
  expect(store.listTasks(S1).map((x) => `${x.id}:${x.revision}:${x.title}`)).toEqual(before)

  // a syntactically-valid but unknown id is TASK_NOT_FOUND, also pre-mutation
  try {
    synchronizeIdentities(store, S1, [
      { taskId: "t1", title: "DIBAWAH", status: "pending" },
      { taskId: "t42", title: "hantu", status: "pending" },
    ])
    throw new Error("should have thrown")
  } catch (e) {
    expect((e as TaskError).code).toBe("TASK_NOT_FOUND")
  }
  expect(store.listTasks(S1).map((x) => `${x.id}:${x.revision}:${x.title}`)).toEqual(before)
})

// G. session isolation
test("G. identity is session-scoped: the same id can exist in two sessions", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  const a = seedA(store, S1)
  expect(a.map((x) => x.id)).toEqual(["t1", "t2", "t3"])

  // a different session starts its own sequence, independently
  const b = seedA(store, S2)
  expect(b.map((x) => x.id)).toEqual(["t1", "t2", "t3"])
  expect(store.getTask(S1, "t1")?.title).toBe("A")
  expect(store.getTask(S2, "t1")?.title).toBe("A")

  // an id valid in S1 must not resolve in S2 if absent there
  expect(() => synchronizeIdentities(store, S2, [{ taskId: "t9", title: "x", status: "pending" }])).toThrow(
    TaskError,
  )
  // mutating S1 leaves S2 alone
  synchronizeIdentities(store, S1, [{ taskId: "t1", title: "A berubah", status: "pending" }])
  expect(store.getTask(S1, "t1")?.title).toBe("A berubah")
  expect(store.getTask(S2, "t1")?.title).toBe("A")
})

// H. no accidental identity reallocation
test("H. an item without an id creates a NEW task and never renumbers an existing one", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  seedA(store)

  const out = synchronizeIdentities(store, S1, [t("tanpa id")])
  expect(out.created).toHaveLength(1)
  expect(out.created[0]?.id).toBe("t4")
  // the three existing tasks keep their ids and titles. Checked BY ID, not by
  // list position: the new task takes order 0, so it also sorts near the top.
  for (const [id, title] of [
    ["t1", "A"],
    ["t2", "B"],
    ["t3", "C"],
  ] as const) {
    expect(store.getTask(S1, id)?.title).toBe(title)
  }
  // and existing tasks the payload omitted are retained, not deleted
  expect(store.listTasks(S1)).toHaveLength(4)

  // re-running with an explicit id addresses the new task instead of adding one
  const again = synchronizeIdentities(store, S1, [{ taskId: "t4", title: "tanpa id", status: "completed" }])
  expect(again.created).toHaveLength(0)
  expect(store.listTasks(S1)).toHaveLength(4)
  expect(store.getTask(S1, "t4")?.status).toBe("COMPLETED")
})

test("H2. blockedReason survives only for BLOCKED", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  // a non-blocked item carrying a stray reason drops it
  const plan = planTaskIdentities([{ title: "x", status: "pending", blockedReason: "alas" }])
  expect(plan.entries[0]?.blockedReason).toBeNull()
  // a blocked item keeps it
  const blocked = planTaskIdentities([{ title: "y", status: "blocked", blockedReason: "alas" }])
  expect(blocked.entries[0]?.blockedReason).toBe("alas")
  // and TaskStore still enforces the PF-04 rail on the way in
  const store2 = new TaskStore(await ownedDir())
  expect(() =>
    applyTaskIdentities(store2, S1, planTaskIdentities([{ title: "z", status: "blocked" }])),
  ).toThrow(TaskError)
})

// I. normalization preserves identity
test("I. planning is pure: it never allocates, never writes, and is repeatable", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  seedA(store)
  const declared: DeclaredTask[] = [
    { taskId: "t3", title: "C", status: "in_progress" },
    { taskId: "t1", title: "A", status: "completed" },
    { taskId: "t2", title: "B", status: "cancelled" },
  ]
  const p1 = planTaskIdentities(declared)
  const p2 = planTaskIdentities(declared)
  expect(p1.entries).toEqual(p2.entries)
  // planning touched nothing
  expect(store.listTasks(S1).map((x) => x.revision)).toEqual([1, 1, 1])
  expect(store.getTask(S1, "t3")?.title).toBe("C")
  // every entry is addressed, none is new
  expect(p1.entries.every((e) => e.kind === "existing")).toBe(true)
  expect(p1.requiredExisting).toEqual(["t3", "t1", "t2"])
  // order follows the declared sequence, identity does not
  expect(p1.entries.map((e) => [e.taskId, e.order])).toEqual([
    ["t3", 0],
    ["t1", 1],
    ["t2", 2],
  ])
  expect(p1.entries.map((e) => e.status)).toEqual(["IN_PROGRESS", "COMPLETED", "CANCELLED"])
})
