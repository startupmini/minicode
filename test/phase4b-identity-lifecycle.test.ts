// Phase 4B: END-TO-END canonical task identity integrity - LIFECYCLE.
//
// THIS IS NEW ARCHITECTURE VALIDATION. The central invariant under test:
//
//     logical task identity  ==  durable TaskStore.taskId
//
// and a taskId must NEVER change merely because order, content or status changed.
//
// This file walks the whole lifecycle against a real temporary project and real
// SQLite:  create -> observe -> reorder -> update -> retry -> failed operation ->
// restart -> resume -> plan.
//
// Proof is ALWAYS by canonical id. Content and ordinal are never used to establish
// correctness - only to describe what happened.
//
// The narrative test (test 1) is deliberately sequential: a lifecycle is a
// sequence, and asserting it in order is what makes an id change visible at the
// step where it happened.
//
// SAFETY (Phase 0A discipline): one `mkdtemp(join(tmpdir(), "minicode-e2e-"))` per
// test, removed by that exact absolute path. No `readdir(".")`, no pattern delete,
// nothing resolved from process.cwd(). A real "restart" is performed by closing
// every TaskStore handle and re-opening the same database file.

import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { todoReadTool, todoWriteTool } from "../src/tools/todo.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { decodeCanonicalAssignments } from "../src/task/assignment.ts"
import { createPresentationAdapter, type TaskIdentityProvider } from "../src/presentation/adapter.ts"
import { createTaskIdentityResolver } from "../src/task/sync.ts"
import type { DomainEvent, EventBusLike, PlanUpdatedEvent } from "../src/presentation/events.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-e2e-"))
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
const S = "e2e-session"
const opCtx = (dir: string, sessionId = S) =>
  ({ signal: new AbortController().signal, cwd: dir, sessionId }) as never

/** A fresh TaskStore handle, as a new process would open. */
const open = (dir: string) => new TaskStore(dir)
const seed = (dir: string, titles: string[], sessionId = S) => {
  const store = open(dir)
  titles.forEach((title, i) =>
    store.createTask(sessionId, { title, status: "PENDING", order: i, provenance: prov }),
  )
  return store
}
/** id -> title, as the durable truth. */
const idMap = (dir: string, sessionId = S) =>
  Object.fromEntries(open(dir).listTasks(sessionId).map((t) => [t.id, t.title]))
const idSet = (dir: string, sessionId = S) => open(dir).listTasks(sessionId).map((t) => t.id).sort()
const write = (dir: string, todos: unknown[], sessionId = S) =>
  todoWriteTool.execute({ todos } as never, opCtx(dir, sessionId)) as Promise<string>
const read = (dir: string, sessionId = S) =>
  todoReadTool.execute({} as never, opCtx(dir, sessionId)) as Promise<string>

function fakeBus(): EventBusLike & { emit: (t: string, p: unknown) => void } {
  const h = new Map<string, Set<(e: unknown) => void>>()
  return {
    on(type, fn) {
      const s = h.get(type) ?? new Set<(e: unknown) => void>()
      s.add(fn)
      h.set(type, s)
      return () => s.delete(fn)
    },
    emit(type, p) {
      const s = h.get(type)
      if (s) for (const f of [...s]) f(p)
    },
  } as never
}
/** Drive the real adapter exactly as the kernel would, call and result together. */
function planFor(dir: string, todos: unknown[], result: string, sessionId = S) {
  const bus = fakeBus()
  const provider: TaskIdentityProvider = createTaskIdentityResolver(dir)
  const adapter = createPresentationAdapter(bus, { sessionId, taskIdentityProvider: provider })
  const seen: DomainEvent[] = []
  adapter.onEvent((e) => seen.push(e))
  bus.emit("execution:started", { execution: { call: { id: "c1", name: "todo_write" } } })
  bus.emit("execution:completed", {
    execution: {
      call: { id: "c1", name: "todo_write", args: { todos } },
      result: { isError: false, content: result },
    },
  })
  return seen.filter((e): e is PlanUpdatedEvent => e.type === "plan.updated")
}

// ===========================================================================
// 1-6. THE LIFECYCLE, in order
// ===========================================================================
test("1. lifecycle: create -> observe -> reorder -> update -> retry keeps identity stable", async () => {
  const dir = await ownedDir()

  // ---- CREATE: A(t1) B(t2) exist, C is new ------------------------------
  seed(dir, ["A", "B"])
  const createPayload = [
    { taskId: "t1", content: "A", status: "pending" },
    { taskId: "t2", content: "B", status: "pending" },
    { content: "C", status: "pending" },
  ]
  const created = await write(dir, createPayload)
  // A and B are the EXISTING ids; C got the allocator's next id.
  expect(decodeCanonicalAssignments(created, { sessionId: S })?.map((a) => a.taskId)).toEqual([
    "t1",
    "t2",
    "t3",
  ])
  expect(idMap(dir)).toEqual({ t1: "A", t2: "B", t3: "C" })
  const afterCreate = idSet(dir)
  expect(afterCreate).toEqual(["t1", "t2", "t3"])

  // ---- OBSERVE: every canonical id is visible through the real read path --
  const observed = await read(dir)
  expect(observed).toMatch(/t1\s*—\s*A/)
  expect(observed).toMatch(/t2\s*—\s*B/)
  expect(observed).toMatch(/t3\s*—\s*C/)
  // No id may disappear between TaskStore and todo_read.
  for (const id of afterCreate) expect(observed).toContain(id)

  // ---- REORDER: t3, t1, t2 ----------------------------------------------
  const reorderPayload = [
    { taskId: "t3", content: "C", status: "pending" },
    { taskId: "t1", content: "A", status: "pending" },
    { taskId: "t2", content: "B", status: "pending" },
  ]
  await write(dir, reorderPayload)
  // Order changed; identity did not.
  expect(open(dir).listTasks(S).map((t) => t.id)).toEqual(["t3", "t1", "t2"])
  expect(idMap(dir)).toEqual({ t1: "A", t2: "B", t3: "C" })
  expect(idSet(dir)).toEqual(afterCreate)
  expect(open(dir).listTasks(S)).toHaveLength(3)

  // ---- UPDATE t3: content + status, id untouched -------------------------
  const revBefore = open(dir).getTask(S, "t3")!.revision
  await write(dir, [
    { taskId: "t3", content: "C updated", status: "completed" },
    { taskId: "t1", content: "A", status: "pending" },
    { taskId: "t2", content: "B", status: "pending" },
  ])
  const updated = open(dir)
  // Only t3 changed, and it is STILL t3.
  expect(updated.getTask(S, "t3")?.title).toBe("C updated")
  expect(updated.getTask(S, "t3")?.status).toBe("COMPLETED")
  expect(updated.getTask(S, "t3")!.revision).toBeGreaterThan(revBefore)
  expect(updated.getTask(S, "t1")?.title).toBe("A")
  expect(updated.getTask(S, "t2")?.title).toBe("B")
  expect(idSet(dir)).toEqual(afterCreate)
  expect(updated.listTasks(S)).toHaveLength(3)

  // ---- RETRY (exact) -----------------------------------------------------
  const retryPayload = [
    { taskId: "t3", content: "C updated", status: "completed" },
    { taskId: "t1", content: "A", status: "pending" },
    { taskId: "t2", content: "B", status: "pending" },
  ]
  await write(dir, retryPayload)
  await write(dir, retryPayload)
  // An exact retry is idempotent in identity terms: no new ids, no duplicates.
  expect(idSet(dir)).toEqual(afterCreate)
  expect(open(dir).listTasks(S)).toHaveLength(3)
  expect(idMap(dir)).toEqual({ t1: "A", t2: "B", t3: "C updated" })

  // ---- RETRY AFTER REORDER ----------------------------------------------
  await write(dir, [
    { taskId: "t1", content: "A", status: "pending" },
    { taskId: "t2", content: "B", status: "pending" },
    { taskId: "t3", content: "C updated", status: "completed" },
  ])
  expect(idSet(dir)).toEqual(afterCreate)
  expect(open(dir).listTasks(S)).toHaveLength(3)
})

// ===========================================================================
// 6. FAILED OPERATION then a corrected retry
// ===========================================================================
test("6. a payload with an unknown id mutates nothing, and the corrected retry is clean", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B", "C"])
  const before = idMap(dir)
  const rowsBefore = open(dir).listTasks(S).map((t) => `${t.id}:${t.revision}`)

  // valid t1, unknown t404, valid t3 - resolve-before-mutate must hold.
  await expect(
    write(dir, [
      { taskId: "t1", content: "A", status: "completed" },
      { taskId: "t404", content: "ghost", status: "pending" },
      { taskId: "t3", content: "C", status: "pending" },
    ]),
  ).rejects.toThrow()

  // Zero partial mutation: not even t1 took the completion.
  expect(idMap(dir)).toEqual(before)
  expect(open(dir).listTasks(S).map((t) => `${t.id}:${t.revision}`)).toEqual(rowsBefore)
  // No orphan, no duplicate allocation.
  expect(open(dir).listTasks(S)).toHaveLength(3)
  expect(open(dir).nextId(S)).toBe("t4")

  // Corrected retry: identity is intact and the update lands once.
  await write(dir, [
    { taskId: "t1", content: "A", status: "completed" },
    { taskId: "t3", content: "C", status: "pending" },
  ])
  expect(open(dir).getTask(S, "t1")?.status).toBe("COMPLETED")
  expect(idSet(dir)).toEqual(["t1", "t2", "t3"])
  // t2 was omitted: D7 retains it, unchanged.
  expect(open(dir).getTask(S, "t2")?.title).toBe("B")
})

// ===========================================================================
// 7. RESTART
// ===========================================================================
test("7. restart: closing every handle and re-opening preserves ids, content, status and order", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  await write(dir, [
    { taskId: "t2", content: "B", status: "pending" },
    { taskId: "t1", content: "A", status: "completed" },
    { content: "C", status: "pending" },
  ])
  const before = open(dir)
    .listTasks(S)
    .map((t) => `${t.id}|${t.title}|${t.status}|${t.order}|${t.revision}`)
  const beforeIds = idSet(dir)

  // RESTART: drop every cached handle, as a process exit would.
  resetTaskStoreHandles()

  // Re-open the same durable database with the same logical session namespace.
  const after = open(dir).listTasks(S).map((t) => `${t.id}|${t.title}|${t.status}|${t.order}|${t.revision}`)
  expect(after).toEqual(before)
  expect(idSet(dir)).toEqual(beforeIds)
  // No id regeneration.
  expect(open(dir).nextId(S)).toBe("t4")
  // And the read path still shows every id.
  const observed = await read(dir)
  for (const id of beforeIds) expect(observed).toContain(id)

  // Work continues correctly after the restart.
  await write(dir, [
    { taskId: "t3", content: "C updated", status: "completed" },
    { taskId: "t2", content: "B", status: "pending" },
    { taskId: "t1", content: "A", status: "completed" },
  ])
  expect(open(dir).getTask(S, "t3")?.title).toBe("C updated")
  expect(idSet(dir)).toEqual(beforeIds)
})

// ===========================================================================
// 8. RESUME
// ===========================================================================
// `presentationSessionId = resumeId ?? sessionId` is computed inside a
// non-exported setup function (cli/setup.ts:505), so 4B verifies its CONSEQUENCE -
// the one that actually matters for identity - rather than the literal expression:
// the same logical namespace must resolve to the same canonical rows, and a
// different namespace must not see them.
test("8. resume: the same logical session namespace still addresses the same ids", async () => {
  const dir = await ownedDir()
  const RESUMED = "resumed-session-id" // what `resumeId ?? sessionId` yields
  seed(dir, ["A", "B"], RESUMED)
  await write(
    dir,
    [
      { taskId: "t1", content: "A", status: "pending" },
      { taskId: "t2", content: "B", status: "pending" },
      { content: "C", status: "pending" },
    ],
    RESUMED,
  )
  const before = idMap(dir, RESUMED)
  expect(before).toEqual({ t1: "A", t2: "B", t3: "C" })

  // Resume: a new process, the same logical session.
  resetTaskStoreHandles()

  // READ
  const observed = await read(dir, RESUMED)
  for (const id of ["t1", "t2", "t3"]) expect(observed).toContain(id)
  // REORDER + UPDATE after resume.
  await write(
    dir,
    [
      { taskId: "t3", content: "C", status: "completed" },
      { taskId: "t1", content: "A", status: "pending" },
      { taskId: "t2", content: "B", status: "pending" },
    ],
    RESUMED,
  )
  expect(open(dir).listTasks(RESUMED).map((t) => t.id)).toEqual(["t3", "t1", "t2"])
  expect(open(dir).getTask(RESUMED, "t3")?.status).toBe("COMPLETED")
  // Same ids throughout - the resumed session did not mint anything.
  expect(idSet(dir, RESUMED)).toEqual(["t1", "t2", "t3"])
  // A DIFFERENT logical session sees nothing: the namespace is the identity scope.
  expect(open(dir).listTasks("some-other-session")).toEqual([])
})

// ===========================================================================
// 9. PLAN CONTINUITY
// ===========================================================================
test("9. plan continuity: plan step ids equal TaskStore ids, order may move", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  const payload = [
    { taskId: "t1", content: "A", status: "pending" },
    { taskId: "t2", content: "B", status: "pending" },
    { content: "C", status: "pending" },
  ]
  const out = await write(dir, payload)
  const storeIds = idSet(dir)
  const events = planFor(dir, payload, out)

  expect(events).toHaveLength(1)
  const plan = events[0]!
  // Full canonical resolution -> v2.
  expect(plan.payloadVersion).toBe(2)
  const planIds = plan.steps.map((s) => s.taskId!)
  // Every plan id is a real durable row, and the sets agree.
  for (const id of planIds) expect(storeIds).toContain(id)
  expect([...planIds].sort()).toEqual(storeIds)
  // The newly-created id is in the plan - no positional fallback.
  expect(planIds).toContain("t3")
  expect(planIds).toEqual(["t1", "t2", "t3"])

  // After a reorder the PLAN order follows the declaration while identity holds.
  const reordered = [
    { taskId: "t3", content: "C", status: "pending" },
    { taskId: "t1", content: "A", status: "pending" },
    { taskId: "t2", content: "B", status: "pending" },
  ]
  const out2 = await write(dir, reordered)
  const plan2 = planFor(dir, reordered, out2)[0]!
  expect(plan2.payloadVersion).toBe(2)
  expect(plan2.steps.map((s) => s.taskId)).toEqual(["t3", "t1", "t2"])
  // Plan order moved; the id SET is identical.
  expect([...plan2.steps.map((s) => s.taskId!)].sort()).toEqual(storeIds)
})

// ===========================================================================
// 10. NEW TASK ASSIGNMENT
// ===========================================================================
test("10. a mixed payload that creates a task propagates its new id end to end", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  const payload = [
    { taskId: "t1", content: "A", status: "pending" },
    { content: "C", status: "pending" },
    { taskId: "t2", content: "B", status: "pending" },
  ]
  const out = await write(dir, payload)
  // C receives t3 from the allocator, exposed on the operation's own channel.
  expect(decodeCanonicalAssignments(out, { sessionId: S })?.map((a) => a.taskId)).toEqual([
    "t1",
    "t3",
    "t2",
  ])
  // It is a real row, and the plan contains it - no positional fallback.
  expect(open(dir).getTask(S, "t3")?.title).toBe("C")
  const plan = planFor(dir, payload, out)[0]!
  expect(plan.payloadVersion).toBe(2)
  expect(plan.steps.map((s) => s.taskId)).toEqual(["t1", "t3", "t2"])
  expect(String(await read(dir))).toMatch(/t3\s*—\s*C/)
})

// ===========================================================================
// 11. ALL-ID-LESS REGRESSION (4A.5 behaviour, under lifecycle conditions)
// ===========================================================================
test("11. all-id-less reorder of a canonical list is rejected and changes nothing", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B", "C"])
  const before = idMap(dir)
  const rowsBefore = open(dir).listTasks(S).map((t) => `${t.id}:${t.revision}`)

  await expect(
    write(dir, [
      { content: "C", status: "pending" },
      { content: "A", status: "pending" },
      { content: "B", status: "pending" },
    ]),
  ).rejects.toThrow()

  expect(idMap(dir)).toEqual(before)
  expect(open(dir).listTasks(S).map((t) => `${t.id}:${t.revision}`)).toEqual(rowsBefore)
  expect(open(dir).listTasks(S)).toHaveLength(3)
  expect(open(dir).nextId(S)).toBe("t4")
  // And no plan is published for it.
  //
  // PHASE 4C.1 CLARIFICATION. The assertion below is deliberately inline rather
  // than routed through the `planFor` helper used by the tests above. `planFor`
  // hardcodes `result: { isError: false }`, i.e. it models a SUCCESSFUL tool
  // result - the opposite of the rejected case being proved here. An earlier
  // draft called `planFor(...)` and discarded the result, which was not merely
  // dead: read casually it suggests "no plan is published for a rejected write",
  // while in fact that call publishes one. The only faithful model of a rejected
  // write is an ERROR result, which is what the adapter gates on.
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, {
    sessionId: S,
    taskIdentityProvider: createTaskIdentityResolver(dir),
  })
  const seen: DomainEvent[] = []
  adapter.onEvent((e) => seen.push(e))
  bus.emit("execution:started", { execution: { call: { id: "r1", name: "todo_write" } } })
  bus.emit("execution:completed", {
    execution: {
      call: { id: "r1", name: "todo_write", args: { todos: [{ content: "C" }] } },
      // isError: true is the load-bearing part - the adapter publishes only on
      // !result.isError.
      result: { isError: true, content: "TASK_IDENTITY_REQUIRED" },
    },
  })
  expect(seen.filter((e) => e.type === "plan.updated")).toHaveLength(0)
})

// ===========================================================================
// 12. LEGACY PATH
// ===========================================================================
test("12. a genuinely pre-canonical session stays legacy: no bootstrap, no canonical rows", async () => {
  const dir = await ownedDir()
  // No seed: this session has never had canonical identity.
  const out = await write(dir, [
    { content: "legacy one", status: "pending" },
    { content: "legacy two", status: "pending" },
  ])
  // Accepted, but nothing canonical was manufactured.
  expect(out).not.toContain("canonical-tasks")
  expect(open(dir).listTasks(S)).toEqual([])
  // And the read path shows no invented ids.
  const observed = await read(dir)
  expect(observed).toContain("legacy one")
  expect(observed).not.toMatch(/t\d+\s*—/)
  // Legacy compatibility is not canonical identity support: the moment canonical
  // state appears, the same payload is rejected.
  seed(dir, ["legacy one", "legacy two"], S)
  await expect(write(dir, [{ content: "legacy one", status: "pending" }])).rejects.toThrow()
})

// ===========================================================================
// 16. PROPERTY / INVARIANT SUITE
// ===========================================================================
test("16. invariant: id set is preserved by every non-CREATE operation", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B", "C"])
  const baseline = idSet(dir)
  const ops: Array<[string, unknown[]]> = [
    ["reorder", [
      { taskId: "t3", content: "C", status: "pending" },
      { taskId: "t1", content: "A", status: "pending" },
      { taskId: "t2", content: "pending" } && { taskId: "t2", content: "B", status: "pending" },
    ]],
    ["update", [
      { taskId: "t2", content: "B renamed", status: "completed" },
      { taskId: "t1", content: "A", status: "pending" },
      { taskId: "t3", content: "C", status: "pending" },
    ]],
    ["exact retry", [
      { taskId: "t2", content: "B renamed", status: "completed" },
      { taskId: "t1", content: "A", status: "pending" },
      { taskId: "t3", content: "C", status: "pending" },
    ]],
    ["subset (D7)", [{ taskId: "t1", content: "A", status: "pending" }]],
  ]
  for (const [name, payload] of ops) {
    await write(dir, payload)
    // set(taskIds) before == set(taskIds) after, for every non-CREATE op.
    expect(idSet(dir), name).toEqual(baseline)
    // Content stays attached to the SAME id it started on.
    expect(open(dir).getTask(S, "t1")?.title, name).toBe("A")
    expect(open(dir).getTask(S, "t3")?.title, name).toBe("C")
  }
  // CREATE is the only operation permitted to grow the set.
  await write(dir, [
    { taskId: "t1", content: "A", status: "pending" },
    { content: "D", status: "pending" },
  ])
  expect(idSet(dir).sort()).toEqual(["t1", "t2", "t3", "t4"])
  expect(open(dir).getTask(S, "t4")?.title).toBe("D")
})

// ===========================================================================
// 17. FAILURE MATRIX
// ===========================================================================
test("17. failure matrix: every failure is non-mutating, id-stable and visible", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B", "C"])
  const baseline = idMap(dir)
  const revs = () => open(dir).listTasks(S).map((t) => `${t.id}:${t.revision}`).sort()
  const before = revs()

  // `coded` is asserted PER CASE, not universally: a malformed id is rejected by
  // protocol validation (Phase 4A.1) and is deliberately a plain Error, not a
  // TaskError. Recording that distinction is more useful than flattening it.
  const cases: Array<[string, unknown[], RegExp, string | undefined]> = [
    ["unknown taskId", [{ taskId: "t404", content: "x", status: "pending" }], /unknown task/i, "TASK_NOT_FOUND"],
    [
      "duplicate taskId",
      [
        { taskId: "t1", content: "A", status: "pending" },
        { taskId: "t1", content: "A", status: "pending" },
      ],
      /appears twice/i,
      "TASK_DUPLICATE_ID",
    ],
    // Protocol boundary: visible, but intentionally NOT a TaskError code.
    ["malformed taskId", [{ taskId: "nope", content: "x", status: "pending" }], /nope|taskId/i, undefined],
    [
      "all-id-less with canonical state",
      [{ content: "C", status: "pending" }],
      /canonical task/i,
      "TASK_IDENTITY_REQUIRED",
    ],
  ]
  for (const [name, payload, expected, expectedCode] of cases) {
    let message = ""
    let code: string | undefined
    try {
      await write(dir, payload)
    } catch (e) {
      message = (e as Error).message
      code = (e as { code?: string }).code
    }
    // error visible, and the documented code for this failure class
    expect(message, name).toMatch(expected)
    expect(code, name).toBe(expectedCode)
    // no mutation, no duplicate, no id change
    expect(idMap(dir), name).toEqual(baseline)
    expect(revs(), name).toEqual(before)
    expect(open(dir).nextId(S), name).toBe("t4")
  }
})
