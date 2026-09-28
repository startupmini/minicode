// Phase 4B.1 regression protection: canonical id WRITE-BACK.
//
// THIS IS NEW ARCHITECTURE. 4B found a production defect; this file is its guard.
//
// THE DEFECT (measured before the fix, on a594945)
//   todo_write persists the DECLARED payload before canonical sync, so a task the
//   sync was about to create has no id in the JSON. The allocator's id reached the
//   plan builder (4A.4A) but never the JSON - and todo_read reads the JSON.
//   Measured: todo_write [t1=A, C(new), t2=B] produced TaskStore t3=C, but
//   todo_read rendered "[ ] C" with no id. The model therefore could not address
//   the task it had just created.
//
// THE FIX
//   After a successful canonical sync, the ids the transaction returned are merged
//   into the persisted list and the file is re-written. The ids are the
//   allocator's own; nothing is inferred from position, content or title.
//
// SCOPE OF THE FIX - stated honestly
//   This makes the identity OBSERVABLE. It does not make a model error
//   impossible: if a model re-sends a task id-less inside a MIXED payload, 4A.5
//   still classifies it as new work, because deciding otherwise would require
//   content-based identity matching, which is forbidden. Test 6 pins that
//   documented behaviour rather than pretending it is fixed.
//
// SAFETY (Phase 0A discipline): one `mkdtemp(join(tmpdir(), "minicode-wb-"))` per
// test, removed by that exact absolute path. Nothing resolved from process.cwd().

import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { todoReadTool, todoWriteTool } from "../src/tools/todo.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { decodeCanonicalAssignments } from "../src/task/assignment.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-wb-"))
  owned.push(dir)
  return dir
}
afterEach(async () => {
  try {
    resetTaskStoreHandles()
  } catch {}
  while (owned.length) await rm(owned.pop()!, { recursive: true, force: true }).catch(() => {})
})

const prov = { origin: "runtime", source: "test" } as const
const S = "wb-session"
const opCtx = (dir: string, sessionId = S) =>
  ({ signal: new AbortController().signal, cwd: dir, sessionId }) as never

const seed = (dir: string, titles: string[], sessionId = S) => {
  const store = new TaskStore(dir)
  titles.forEach((title, i) =>
    store.createTask(sessionId, { title, status: "PENDING", order: i, provenance: prov }),
  )
  return store
}
const rows = (dir: string, sessionId = S) => new TaskStore(dir).listTasks(sessionId)
const todoJson = async (dir: string, sessionId = S) =>
  JSON.parse(await readFile(join(dir, ".minicode", "todos", `${sessionId}.json`), "utf8")) as {
    sessionId: string
    todos: Array<{ content: string; taskId?: string }>
  }
const planMd = async (dir: string, sessionId = S) =>
  readFile(join(dir, ".minicode", "plans", `${sessionId}.md`), "utf8").catch(() => "")

// ---------------------------------------------------------------------------
// 1. READ-BACK: a newly-created id is observable
// ---------------------------------------------------------------------------
test("1. todo_read exposes the id of a task created by the same operation", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  await todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "A", status: "pending" },
        { content: "C", status: "pending" },
        { taskId: "t2", content: "B", status: "pending" },
      ],
    } as never,
    opCtx(dir),
  )
  // The store allocated t3, and the model can now SEE it.
  expect(rows(dir).map((t) => `${t.id}=${t.title}`)).toEqual(["t1=A", "t3=C", "t2=B"])
  const read = String(await todoReadTool.execute({} as never, opCtx(dir)))
  expect(read).toMatch(/t3\s*—\s*C/)
  expect(read).toMatch(/t1\s*—\s*A/)
  expect(read).toMatch(/t2\s*—\s*B/)
})

// ---------------------------------------------------------------------------
// 2. the durable file carries the resolved id
// ---------------------------------------------------------------------------
test("2. the persisted todo file records the resolved id, not just the declaration", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  await todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "A", status: "pending" },
        { content: "C", status: "pending" },
      ],
    } as never,
    opCtx(dir),
  )
  const stored = await todoJson(dir)
  expect(stored.sessionId).toBe(S)
  expect(stored.todos.map((t) => `${t.taskId ?? "-"}:${t.content}`)).toEqual(["t1:A", "t3:C"])
})

// ---------------------------------------------------------------------------
// 3. the tool's own result shows the id too
// ---------------------------------------------------------------------------
test("3. the write result itself names the created id, and still carries the assignment", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  const out = (await todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "A", status: "pending" },
        { content: "C", status: "pending" },
      ],
    } as never,
    opCtx(dir),
  )) as string
  expect(out).toMatch(/t3\s*—\s*C/)
  // The 4A.4A machine channel is unchanged and still correct.
  expect(decodeCanonicalAssignments(out, { sessionId: S })?.map((a) => a.taskId)).toEqual(["t1", "t3"])
})

// ---------------------------------------------------------------------------
// 4. the legacy all-id-less path is untouched
// ---------------------------------------------------------------------------
test("4. a pre-canonical session writes no ids and performs no second write", async () => {
  const dir = await ownedDir()
  // No canonical identity, so the legacy path runs and mints nothing.
  const out = (await todoWriteTool.execute(
    { todos: [{ content: "legacy", status: "pending" }] } as never,
    opCtx(dir),
  )) as string
  expect(out).not.toContain("canonical-tasks")
  expect(out).not.toMatch(/t\d+\s*—/)
  const raw = await readFile(join(dir, ".minicode", "todos", `${S}.json`), "utf8")
  expect(raw).not.toContain("taskId")
  expect(rows(dir)).toEqual([])
  // No plan snapshot identity was invented either.
  expect(await planMd(dir)).not.toMatch(/t\d+\s*—/)
})

// ---------------------------------------------------------------------------
// 5. a payload that creates nothing performs no extra write
// ---------------------------------------------------------------------------
test("5. a fully-identified payload is left exactly as declared", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B", "C"])
  // Establish the file with a first write that DOES create a task, so there is a
  // real file to compare against.
  await todoWriteTool.execute(
    { todos: [{ taskId: "t1", content: "A", status: "pending" }, { content: "D", status: "pending" }] } as never,
    opCtx(dir),
  )
  const before = await readFile(join(dir, ".minicode", "todos", `${S}.json`), "utf8")
  const rowsBefore = rows(dir).map((t) => `${t.id}:${t.title}`)

  // A second write that creates nothing: there is no id to merge, so the persisted
  // todos must be exactly as declared and no canonical id may be consumed.
  // (`updatedAt` is a wall-clock stamp that legitimately changes on every write,
  // so the invariant is the todos array, not raw byte identity.)
  const out = (await todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "A", status: "pending" },
        { taskId: "t2", content: "B", status: "pending" },
        { taskId: "t3", content: "C", status: "pending" },
        { taskId: "t4", content: "D", status: "pending" },
      ],
    } as never,
    opCtx(dir),
  )) as string
  const stored = await todoJson(dir)
  expect(stored.todos.map((t) => `${t.taskId}:${t.content}`)).toEqual([
    "t1:A",
    "t2:B",
    "t3:C",
    "t4:D",
  ])
  expect(rows(dir).map((t) => `${t.id}:${t.title}`).sort()).toEqual(rowsBefore.sort())
  expect(decodeCanonicalAssignments(out, { sessionId: S })?.every((a) => a.kind === "existing")).toBe(true)
})

// ---------------------------------------------------------------------------
// 6. a DECLARED id is never rewritten by the write-back
// ---------------------------------------------------------------------------
test("6. the write-back only ADDS ids; it never rewrites a declared one", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  await todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "A", status: "pending" },
        { content: "C", status: "pending" },
        { taskId: "t2", content: "B", status: "pending" },
      ],
    } as never,
    opCtx(dir),
  )
  const stored = await todoJson(dir)
  // The declared ids survive verbatim; only C gained one.
  expect(stored.todos.find((t) => t.content === "A")?.taskId).toBe("t1")
  expect(stored.todos.find((t) => t.content === "B")?.taskId).toBe("t2")
  expect(stored.todos.find((t) => t.content === "C")?.taskId).toBe("t3")
})

// ---------------------------------------------------------------------------
// 7. DOCUMENTED RESIDUAL: a model that ignores the id can still duplicate
// ---------------------------------------------------------------------------
test("7. documented residual: re-sending a known task id-less in a MIXED payload creates a new task", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  const first = (await todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "A", status: "pending" },
        { content: "C", status: "pending" },
        { taskId: "t2", content: "B", status: "pending" },
      ],
    } as never,
    opCtx(dir),
  )) as string
  expect(decodeCanonicalAssignments(first, { sessionId: S })?.map((a) => a.taskId)).toEqual(["t1", "t3", "t2"])
  expect(rows(dir)).toHaveLength(3)

  // The model now KNOWS t3 (todo_read shows it) but sends C id-less anyway. That
  // is a mixed payload, and 4A.5 defines id-less items in a mixed payload as new
  // work. Rejecting it would require matching on content, which is forbidden.
  await todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "A", status: "pending" },
        { content: "C", status: "pending" },
        { taskId: "t2", content: "B", status: "pending" },
      ],
    } as never,
    opCtx(dir),
  )
  const after = rows(dir)
  expect(after).toHaveLength(4)
  // Set comparison: `listTasks` returns canonical ORDER, and t3 is D7-retained
  // after the newly declared t4, so positional order is not the invariant.
  expect(after.filter((t) => t.title === "C").map((t) => t.id).sort()).toEqual(["t3", "t4"])
  // This is pinned deliberately: it is the boundary of the current contract, not
  // an oversight. 4B.1 makes the identity observable; it does not make a model
  // error impossible.
})

// ---------------------------------------------------------------------------
// 8. DOCUMENTED: the markdown plan snapshot is a LEGACY artifact
// ---------------------------------------------------------------------------
// The `.minicode/plans/<session>.md` snapshot renders `- [ ] A (pending)` and has
// never carried canonical ids. Adding them would be a plan-pipeline change, which
// is explicitly out of scope here, so this test pins the CURRENT reality rather
// than a wish: canonical identity is observable through `todo_read`, the
// `todo_write` result and the `plan.updated` EVENT (Phase 3B) - not through this
// markdown. If a later phase adds ids here, this test is the thing to update.
test("8. the markdown plan snapshot is a legacy artifact without canonical ids", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  await todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "A", status: "pending" },
        { content: "C", status: "pending" },
      ],
    } as never,
    opCtx(dir),
  )
  const md = await planMd(dir)
  expect(md).toContain("A")
  expect(md).toContain("C")
  // The durable todo file IS the identity-bearing view, and it has the id.
  expect((await todoJson(dir)).todos.find((t) => t.content === "C")?.taskId).toBe("t3")
  // The markdown does not, and that is documented rather than accidental.
  expect(md).not.toContain("t3")
})

// ---------------------------------------------------------------------------
// 9. ordering preserved: the 4A.5 guard still rejects BEFORE any write
// ---------------------------------------------------------------------------
test("9. the 4A.5 guard still fires before the FIRST write, so nothing is persisted", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B", "C"])
  const before = await readFile(join(dir, ".minicode", "todos", `${S}.json`), "utf8").catch(() => "")
  await expect(
    todoWriteTool.execute(
      {
        todos: [
          { content: "C", status: "pending" },
          { content: "A", status: "pending" },
          { content: "B", status: "pending" },
        ],
      } as never,
      opCtx(dir),
    ),
  ).rejects.toThrow()
  const after = await readFile(join(dir, ".minicode", "todos", `${S}.json`), "utf8").catch(() => "")
  expect(after).toBe(before)
  expect(rows(dir).map((t) => t.id)).toEqual(["t1", "t2", "t3"])
})
