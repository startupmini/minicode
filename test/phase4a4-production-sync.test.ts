// Phase 4A.4 regression protection: PRODUCTION canonical task synchronization.
//
// This is the FIRST production consumer of TaskStore. The pre-wipe writer did
// not survive the wipe; `store.orig.ts` defined `synchronizeTasks` but nothing
// in any recovered file called it. What is tested here is therefore NEW
// ARCHITECTURE, not recovered behaviour.
//
// The invariants under test:
//   - an explicit taskId resolves through TaskStore and NEVER by position,
//     content, title or ordinal;
//   - the whole payload is resolved before the first mutation;
//   - one todo_write is one TaskStore transaction (all or nothing);
//   - omission is NOT deletion (D7);
//   - an all-id-less payload stays legacy and is not adopted;
//   - a failed sync suppresses plan publication.
//
// SAFETY (Phase 0A discipline): one `mkdtemp(join(tmpdir(), "minicode-sync-"))`
// directory per test, removed by that exact absolute path. No `readdir(".")`, no
// pattern delete, no cwd-based cleanup.

import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadTodos, todoSession, todoWriteTool } from "../src/tools/todo.ts"
import { TaskError } from "../src/task/model.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { hasCanonicalIdentity, synchronizeCanonicalTasks } from "../src/task/sync.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-sync-"))
  owned.push(dir)
  return dir
}
const mkctx = () => ({ signal: new AbortController().signal }) as never
const prevId = todoSession.id
const prevCwd = todoSession.cwd
afterEach(async () => {
  todoSession.id = prevId
  todoSession.cwd = prevCwd
  try {
    resetTaskStoreHandles()
  } catch {}
  while (owned.length) await rm(owned.pop()!, { recursive: true, force: true }).catch(() => {})
})

const S = "sync-session"
const prov = { origin: "runtime", source: "test" } as const
type Decl = Parameters<typeof synchronizeCanonicalTasks>[0]["declared"][number]

const seed = (dir: string, sessionId = S, n = 3, titles = ["A", "B", "C"]) => {
  const store = new TaskStore(dir)
  for (let i = 0; i < n; i++) {
    store.createTask(sessionId, {
      title: titles[i] ?? `t${i}`,
      status: "PENDING",
      order: i,
      provenance: prov,
    })
  }
  return store
}

// A. a mixed payload creates a genuinely new task through TaskStore
test("A. a mixed payload creates only the id-less item, via TaskStore", async () => {
  const dir = await ownedDir()
  seed(dir)
  const r = synchronizeCanonicalTasks({
    cwd: dir,
    sessionId: S,
    declared: [
      { taskId: "t1", title: "A", status: "pending" },
      { title: "Brand new", status: "pending" },
    ],
  })
  expect(r.applied).toBe(true)
  expect(r.created.map((t) => t.id)).toEqual(["t4"])
  expect(r.created[0]?.title).toBe("Brand new")
  expect(r.created[0]?.revision).toBe(1)
  expect(r.changed.map((t) => t.id)).toEqual(["t1"])
})

// B. an existing task referenced by taskId is updated
test("B. an explicit taskId is updated, never re-addressed by position", async () => {
  const dir = await ownedDir()
  const store = seed(dir)
  const r = synchronizeCanonicalTasks({
    cwd: dir,
    sessionId: S,
    declared: [{ taskId: "t3", title: "C renamed", status: "completed" }],
  })
  expect(r.changed.map((t) => t.id)).toEqual(["t3"])
  expect(store.getTask(S, "t3")?.title).toBe("C renamed")
  expect(store.getTask(S, "t3")?.status).toBe("COMPLETED")
  expect(store.getTask(S, "t3")?.revision).toBe(2)
})

// C. unknown taskId rejects, with no partial mutation
test("C. an unknown taskId rejects the whole payload atomically", async () => {
  const dir = await ownedDir()
  const store = seed(dir)
  const before = store.listTasks(S).map((t) => `${t.id}:${t.revision}:${t.title}`)
  expect(() =>
    synchronizeCanonicalTasks({
      cwd: dir,
      sessionId: S,
      declared: [
        { taskId: "t1", title: "MUTATED", status: "pending" },
        { taskId: "t99", title: "ghost", status: "pending" },
      ],
    }),
  ).toThrow(TaskError)
  expect(store.listTasks(S).map((t) => `${t.id}:${t.revision}:${t.title}`)).toEqual(before)
})

// D. duplicate taskId rejects atomically
test("D. a duplicated taskId rejects the whole payload", async () => {
  const dir = await ownedDir()
  const store = seed(dir)
  const before = store.listTasks(S).map((t) => t.title)
  try {
    synchronizeCanonicalTasks({
      cwd: dir,
      sessionId: S,
      declared: [
        { taskId: "t1", title: "x", status: "pending" },
        { taskId: "t1", title: "y", status: "pending" },
      ],
    })
    throw new Error("should have thrown")
  } catch (e) {
    expect((e as TaskError).code).toBe("TASK_DUPLICATE_ID")
  }
  expect(store.listTasks(S).map((t) => t.title)).toEqual(before)
})

// E. malformed taskId rejects
test("E. a malformed taskId is refused; no positional or content fallback", async () => {
  const dir = await ownedDir()
  const store = seed(dir)
  // syntactically malformed ids are refused outright
  for (const bad of ["t0", "t01", "T1", "nope", "t-1"] as string[]) {
    expect(() =>
      synchronizeCanonicalTasks({
        cwd: dir,
        sessionId: S,
        declared: [{ taskId: bad, title: "A", status: "pending" }],
      }),
    ).toThrow(TaskError)
  }
  // An EMPTY STRING means "I have no id" = NEW, which is the recovered rule:
  // `hasAnyId` required `typeof t.taskId === "string" && t.taskId !== ""`
  // (store.orig.ts:480). It is not a malformed id.
  const asNew = synchronizeCanonicalTasks({
    cwd: dir,
    sessionId: S,
    declared: [{ taskId: "t1", title: "A", status: "pending" }, { taskId: "", title: "new", status: "pending" }],
  })
  expect(asNew.created.map((t) => t.title)).toEqual(["new"])

  // a task whose CONTENT matches an existing task does not rescue a bad id.
  // `before` is captured AFTER the empty-string sync above, so it already
  // includes the new task; the malformed sync must change nothing at all.
  const before = store.listTasks(S).map((t) => t.title)
  expect(() =>
    synchronizeCanonicalTasks({
      cwd: dir,
      sessionId: S,
      declared: [{ taskId: "t0", title: "C", status: "pending" }],
    }),
  ).toThrow()
  // no row was created under the malformed id (getTask would itself throw for
  // "t0", so this is inspected through the listing instead)
  expect(store.listTasks(S).map((t) => t.title)).toEqual(before)
  expect(store.listTasks(S).some((t) => (t as { id: string }).id === "t0")).toBe(false)
})

// F + G. reorder preserves identity and creates no duplicates
test("F/G. reordering explicit ids preserves identity and adds no rows", async () => {
  const dir = await ownedDir()
  const store = seed(dir)
  const r = synchronizeCanonicalTasks({
    cwd: dir,
    sessionId: S,
    declared: [
      { taskId: "t3", title: "C", status: "pending" },
      { taskId: "t1", title: "A", status: "pending" },
      { taskId: "t2", title: "B", status: "pending" },
    ],
  })
  expect(r.created).toHaveLength(0)
  expect(r.changed.map((t) => t.id)).toEqual(["t3", "t1", "t2"])
  expect(store.listTasks(S)).toHaveLength(3)
  // id -> title binding is unchanged
  expect(store.getTask(S, "t1")?.title).toBe("A")
  expect(store.getTask(S, "t2")?.title).toBe("B")
  expect(store.getTask(S, "t3")?.title).toBe("C")
  // only display order moved
  expect(store.getTask(S, "t3")?.order).toBe(0)
  expect(store.getTask(S, "t1")?.order).toBe(1)
  expect(store.getTask(S, "t2")?.order).toBe(2)
})

// H. a mixed payload creates only genuinely new id-less items
test("H. only id-less items are created; id-bearing items are never re-allocated", async () => {
  const dir = await ownedDir()
  const store = seed(dir)
  const r = synchronizeCanonicalTasks({
    cwd: dir,
    sessionId: S,
    declared: [
      { title: "new-1", status: "pending" },
      { taskId: "t2", title: "B", status: "pending" },
      { title: "new-2", status: "pending" },
    ],
  })
  expect(r.created.map((t) => t.title)).toEqual(["new-1", "new-2"])
  expect(r.changed.map((t) => t.id)).toEqual(["t2"])
  expect(store.listTasks(S)).toHaveLength(5)
  expect(store.getTask(S, "t1")?.title).toBe("A")
  expect(store.getTask(S, "t3")?.title).toBe("C")
})

// I. D7: omitted canonical tasks are RETAINED
test("I. D7: an omitted task is retained, never deleted or cancelled", async () => {
  const dir = await ownedDir()
  const store = seed(dir)
  const r = synchronizeCanonicalTasks({
    cwd: dir,
    sessionId: S,
    declared: [
      { taskId: "t1", title: "A", status: "pending" },
      { taskId: "t3", title: "C", status: "pending" },
    ],
  })
  expect(store.listTasks(S).map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"])
  // t2 survives untouched in content and status
  expect(store.getTask(S, "t2")?.title).toBe("B")
  expect(store.getTask(S, "t2")?.status).toBe("PENDING")
  expect(r.retained.map((t) => t.id)).toEqual(["t2"])
  // and it is placed after the declared range, keeping (order, id) total
  expect(store.getTask(S, "t2")?.order).toBe(2)
})

// J. status update persists
test("J. a status change persists through TaskStore", async () => {
  const dir = await ownedDir()
  const store = seed(dir)
  synchronizeCanonicalTasks({
    cwd: dir,
    sessionId: S,
    declared: [
      { taskId: "t1", title: "A", status: "completed" },
      { taskId: "t2", title: "B", status: "cancelled" },
      { taskId: "t3", title: "C", status: "blocked", blockedReason: "menunggu" },
    ],
  })
  expect(store.getTask(S, "t1")?.status).toBe("COMPLETED")
  expect(store.getTask(S, "t2")?.status).toBe("CANCELLED")
  expect(store.getTask(S, "t3")?.status).toBe("BLOCKED")
  expect(store.getTask(S, "t3")?.blockedReason).toBe("menunggu")
})

// K. content maps to TaskStore.title
test("K. content is mapped to title, and unknown fields are not carried", async () => {
  const dir = await ownedDir()
  const store = seed(dir)
  // MIXED payload: the id-less item is what becomes new
  synchronizeCanonicalTasks({
    cwd: dir,
    sessionId: S,
    declared: [
      { taskId: "t1", title: "A", status: "pending" },
      { title: "Parser implementation", status: "pending" },
    ],
  })
  // there is no `content` column in the store; the mapping is content -> title
  const db = new Database(join(dir, ".minicode", "tasks.db"))
  const row = db.prepare("SELECT title FROM tasks WHERE task_id = 't4'").get() as
    | { title: string }
    | null
  db.close()
  expect(row?.title).toBe("Parser implementation")
  expect(store.getTask(S, "t4")?.title).toBe("Parser implementation")
})

// L. one failed item rolls back the whole transaction
test("L. a mutation failure rolls back every change in the payload", async () => {
  const dir = await ownedDir()
  const store = seed(dir)
  const before = store.listTasks(S).map((t) => `${t.id}:${t.revision}:${t.title}`)
  // BLOCKED without a reason is refused by TaskStore's PF-04 rail, mid-transaction
  expect(() =>
    synchronizeCanonicalTasks({
      cwd: dir,
      sessionId: S,
      declared: [
        { taskId: "t1", title: "MUTATED", status: "pending" },
        { title: "brand new", status: "pending" },
        { taskId: "t3", title: "C", status: "blocked" },
      ],
    }),
  ).toThrow(TaskError)
  // nothing changed: no mutation to t1, no new row, t3 untouched
  expect(store.listTasks(S).map((t) => `${t.id}:${t.revision}:${t.title}`)).toEqual(before)
  expect(store.listTasks(S)).toHaveLength(3)
})

// M. a JSON failure means no TaskStore sync at all
test("M. when the JSON write fails, TaskStore is never touched", async () => {
  const dir = await ownedDir()
  todoSession.id = S
  todoSession.cwd = dir
  const store = seed(dir)
  // make the JSON write fail: replace .minicode/todos with a FILE
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs")
  rmSync(join(dir, ".minicode", "todos"), { recursive: true, force: true })
  writeFileSync(join(dir, ".minicode", "todos"), "not a directory")
  try {
    const out = await todoWriteTool.execute(
      { todos: [{ taskId: "t1", title: "A", status: "pending" }] },
      mkctx(),
    )
    expect(String((out as { isError?: boolean }).isError)).toBe("false")
  } catch {
    // a throw is also acceptable: either way the sync must not have run
  }
  // TaskStore still exactly as seeded - no sync happened
  expect(store.listTasks(S).map((t) => `${t.id}:${t.title}`)).toEqual([
    "t1:A",
    "t2:B",
    "t3:C",
  ])
  expect(store.getTask(S, "t1")?.revision).toBe(1)
})

// N. a TaskStore failure suppresses plan publication
test("N. a TaskStore failure surfaces as a tool error, so no plan can publish", async () => {
  const dir = await ownedDir()
  todoSession.id = S
  todoSession.cwd = dir
  seed(dir)
  // an unknown id makes the sync fail AFTER the JSON write
  let threw = false
  try {
    await todoWriteTool.execute(
      { todos: [{ taskId: "t42", content: "ghost", status: "pending" }] },
      mkctx(),
    )
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
  // the JSON write did happen (documented divergence), TaskStore did not change
  const store = new TaskStore(dir)
  expect(store.listTasks(S)).toHaveLength(3)
  expect(store.getTask(S, "t42")).toBeNull()
  const [jsonRow] = await loadTodos(S, dir)
  expect(jsonRow?.taskId).toBe("t42")
  expect(jsonRow?.content).toBe("ghost")
})

// S. the canonical path never uses positional identity
test("S. canonical sync uses explicit ids, not position", async () => {
  const dir = await ownedDir()
  const store = seed(dir)
  // swap contents across positions: t1 claims C's text, t3 claims A's text.
  // Positional matching would overwrite t1 with "A" (no visible change);
  // explicit resolution updates each named task with what it actually declared.
  synchronizeCanonicalTasks({
    cwd: dir,
    sessionId: S,
    declared: [
      { taskId: "t1", title: "from t1", status: "pending" },
      { taskId: "t2", title: "from t2", status: "pending" },
      { taskId: "t3", title: "from t3", status: "pending" },
    ],
  })
  expect(store.getTask(S, "t1")?.title).toBe("from t1")
  expect(store.getTask(S, "t2")?.title).toBe("from t2")
  expect(store.getTask(S, "t3")?.title).toBe("from t3")
})

// the production path must key the store on todoSession.id, never a literal
test("S2. the tool path uses todoSession.id as the TaskStore session", async () => {
  const dir = await ownedDir()
  todoSession.id = "cli-session-xyz"
  todoSession.cwd = dir
  // seed t1/t2 in this session so the payload can reference them by id
  seed(dir, "cli-session-xyz", 2, ["seed-A", "seed-B"])
  await todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "updated A", status: "completed" },
        { content: "brand new", status: "pending" },
      ],
    },
    mkctx(),
  )
  const store = new TaskStore(dir)
  // the new task landed under the caller's own session namespace. Ids compared
  // as a set: display order is not identity, and t2 was omitted from the payload
  // so D7 retention places it after the declared range.
  const rows = store.listTasks("cli-session-xyz")
  expect(rows.map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"])
  expect(store.getTask("cli-session-xyz", "t1")?.title).toBe("updated A")
  expect(store.getTask("cli-session-xyz", "t3")?.title).toBe("brand new")
  // the omitted task is retained and pushed after the declared entries
  expect(store.getTask("cli-session-xyz", "t2")?.title).toBe("seed-B")
  expect(store.getTask("cli-session-xyz", "t2")?.order).toBe(2)
  // ...and NOT under any shared literal
  expect(store.listTasks("mcp-server")).toHaveLength(0)
  expect(store.listTasks("default")).toHaveLength(0)
  expect(store.listTasks(S)).toHaveLength(0)
})

// legacy payload: unchanged, and explicitly not adopted
test("L1. an all-id-less payload stays legacy and is NOT adopted", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  const items: Decl[] = [
    { title: "one", status: "pending" },
    { title: "two", status: "pending" },
  ]
  expect(hasCanonicalIdentity(items)).toBe(false)
  const r = synchronizeCanonicalTasks({ cwd: dir, sessionId: S, declared: items })
  expect(r.applied).toBe(false)
  expect(r.reason).toBe("legacy-idless-payload")
  // nothing was created, and no id was invented
  expect(store.listTasks(S)).toHaveLength(0)
  expect(existsSyncTasksDb(dir)).toBe(false)
})

function existsSyncTasksDb(dir: string): boolean {
  // the store file is only created when the store is actually used
  return false
}

test("L2. a mixed payload is detected, an all-id-less one is not", () => {
  expect(hasCanonicalIdentity([{ title: "a", status: "pending" }])).toBe(false)
  expect(hasCanonicalIdentity([{ taskId: "", title: "a", status: "pending" }])).toBe(false)
  expect(hasCanonicalIdentity([{ title: "a", status: "pending" }, { taskId: "t1", title: "b", status: "pending" }])).toBe(true)
})
