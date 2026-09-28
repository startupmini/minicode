// Phase 4A.4A regression protection: canonical task ASSIGNMENT PROPAGATION.
//
// THIS IS NEW ARCHITECTURE.
//
// WHAT IS UNDER TEST
//     A canonical synchronization mints real TaskStore ids for declared id-less
//     items. Phase 4A.4 therefore refused `payloadVersion: 2` for any payload that
//     created a task: TaskStore knew the identity, the plan builder did not. This
//     phase closes that boundary so the SAME operation that created a task can
//     deliver its identity to plan construction.
//
// WHY THE RETURN VALUE IS THE CHANNEL (verified in vendor/minicore, not assumed)
//     `ToolContext` (vendor/minicore/src/core/tool.ts:22) has NO tool-call id, so a
//     tool cannot name its own operation and cannot key any channel it is given.
//     The kernel pairs `call` with `result` in ONE `execution:completed` event
//     (vendor/minicore/src/core/executor.ts:102), and only the serialized string
//     survives. So the tool's return value is the only per-operation channel the
//     kernel itself correlates - which is precisely why there is no registry here.
//
// The invariants:
//   - a new task's id is the one the allocator returned, captured in-transaction,
//     never reconstructed later from position, content or title;
//   - the assignment is aligned to DECLARED order, index for index;
//   - a declared id may be confirmed by the assignment but never rewritten by it;
//   - ANY incomplete, stale, foreign or malformed assignment fails closed and can
//     never produce `payloadVersion: 2`;
//   - no cross-wiring between turns, sessions or MCP contexts.
//
// SAFETY (Phase 0A discipline): one `mkdtemp(join(tmpdir(), "minicode-assign-"))`
// directory per test, removed by that exact absolute path. No `readdir(".")`, no
// pattern delete, no cwd-based cleanup. Hermetic fake bus, no network, no key.

import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createPresentationAdapter,
  type TaskIdentityProvider,
} from "../src/presentation/adapter.ts"
import type { DomainEvent, EventBusLike, PlanUpdatedEvent } from "../src/presentation/events.ts"
import { todoSession, todoWriteTool } from "../src/tools/todo.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { createTaskIdentityResolver, synchronizeCanonicalTasks } from "../src/task/sync.ts"
import {
  decodeCanonicalAssignments,
  encodeCanonicalAssignments,
  type CanonicalAssignmentTable,
} from "../src/task/assignment.ts"
import { applyMcpContext, newMcpContextId } from "../src/mcp/server.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-assign-"))
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

const S = "assign-session"
const prov = { origin: "runtime", source: "test" } as const

/** Create `n` real tasks so ids t1..tn exist in the store. */
const seed = (dir: string, sessionId = S, titles = ["A", "B", "C"]) => {
  const store = new TaskStore(dir)
  titles.forEach((title, i) => {
    store.createTask(sessionId, {
      title,
      status: "PENDING",
      order: i,
      provenance: prov,
    })
  })
  return store
}

const ids = (t: CanonicalAssignmentTable | undefined) => t?.map((a) => a.taskId)
const kinds = (t: CanonicalAssignmentTable | undefined) => t?.map((a) => a.kind)

/** Run the REAL tool so the string under test is the string production returns. */
async function runTodoWrite(dir: string, todos: unknown[], sessionId = S): Promise<string> {
  todoSession.id = sessionId
  todoSession.cwd = dir
  return (await todoWriteTool.execute({ todos } as never, mkctx())) as string
}

function fakeBus(): EventBusLike & { emit: (type: string, payload: unknown) => void } {
  const handlers = new Map<string, Set<(e: unknown) => void>>()
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set<(e: unknown) => void>()
      set.add(handler)
      handlers.set(type, set)
      return () => set.delete(handler)
    },
    emit(type, payload) {
      const set = handlers.get(type)
      if (set) for (const h of [...set]) h(payload)
    },
  } as never
}

function build(dir: string, sessionId = S, provider?: TaskIdentityProvider) {
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, {
    sessionId,
    // Production injects the TaskStore-backed resolver (cli/setup.ts). It is used
    // here so these tests exercise the real production wiring, not a convenient
    // stand-in.
    ...(provider === undefined ? { taskIdentityProvider: createTaskIdentityResolver(dir) } : provider ? { taskIdentityProvider: provider } : {}),
  })
  const seen: DomainEvent[] = []
  adapter.onEvent((e) => seen.push(e))
  const plans = () => seen.filter((e): e is PlanUpdatedEvent => e.type === "plan.updated")
  return { bus, adapter, plans }
}

/** Deliver the kernel-shaped completion event: `call` and `result` TOGETHER. */
function complete(
  bus: ReturnType<typeof fakeBus>,
  callId: string,
  args: unknown,
  content: string,
  sessionId = S,
) {
  bus.emit("execution:started", { execution: { call: { id: callId, name: "todo_write" } } })
  bus.emit("execution:completed", {
    sessionId,
    execution: { call: { id: callId, name: "todo_write", args }, result: { isError: false, content } },
  })
}

// ---------------------------------------------------------------------------
// A. existing task assignment
// ---------------------------------------------------------------------------
test("A. an existing-only payload assigns its declared ids unchanged, in order", async () => {
  const dir = await ownedDir()
  seed(dir)
  const out = await runTodoWrite(dir, [
    { taskId: "t1", content: "A", status: "pending" },
    { taskId: "t2", content: "B", status: "pending" },
  ])
  const t = decodeCanonicalAssignments(out, { sessionId: S })
  expect(ids(t)).toEqual(["t1", "t2"])
  expect(kinds(t)).toEqual(["existing", "existing"])
  // No remapping, no new rows.
  expect(new TaskStore(dir).listTasks(S).map((x) => x.id)).toEqual(["t1", "t2", "t3"])
})

// ---------------------------------------------------------------------------
// B. new task gets a canonical id
// ---------------------------------------------------------------------------
test("B. a newly created task is assigned the id the allocator actually returned", async () => {
  const dir = await ownedDir()
  seed(dir)
  const out = await runTodoWrite(dir, [
    { taskId: "t1", content: "A", status: "pending" },
    { content: "Brand new", status: "pending" },
  ])
  const t = decodeCanonicalAssignments(out, { sessionId: S })
  expect(ids(t)).toEqual(["t1", "t4"])
  expect(kinds(t)).toEqual(["existing", "new"])
  // The assigned id is a REAL row, and it is the row that carries the new title.
  const created = new TaskStore(dir).getTask(S, "t4")
  expect(created?.title).toBe("Brand new")
  expect(created?.revision).toBe(1)
})

// ---------------------------------------------------------------------------
// C. mixed existing + new
// ---------------------------------------------------------------------------
test("C. a mixed payload assigns every declared item, new and existing alike", async () => {
  const dir = await ownedDir()
  seed(dir)
  const out = await runTodoWrite(dir, [
    { taskId: "t3", content: "C", status: "pending" },
    { content: "D", status: "pending" },
    { taskId: "t1", content: "A", status: "pending" },
  ])
  const t = decodeCanonicalAssignments(out, { sessionId: S })
  // Declared order preserved: t3, then the new id, then t1.
  expect(ids(t)).toEqual(["t3", "t4", "t1"])
  expect(kinds(t)).toEqual(["existing", "new", "existing"])
  expect(new TaskStore(dir).getTask(S, "t4")?.title).toBe("D")
})

// ---------------------------------------------------------------------------
// D. reordered explicit ids
// ---------------------------------------------------------------------------
test("D. reordered explicit ids keep their own identity and are not remapped", async () => {
  const dir = await ownedDir()
  seed(dir)
  const out = await runTodoWrite(dir, [
    { taskId: "t3", content: "C", status: "pending" },
    { taskId: "t1", content: "A", status: "pending" },
    { taskId: "t2", content: "B", status: "pending" },
  ])
  expect(ids(decodeCanonicalAssignments(out, { sessionId: S }))).toEqual(["t3", "t1", "t2"])
  // Reordering moves order, never identity: no new row was minted.
  const store = new TaskStore(dir)
  expect(store.listTasks(S).map((x) => x.id).sort()).toEqual(["t1", "t2", "t3"])
  expect(store.getTask(S, "t1")?.title).toBe("A")
  expect(store.getTask(S, "t3")?.title).toBe("C")
})

// ---------------------------------------------------------------------------
// E. the canonical plan carries the newly created id
// ---------------------------------------------------------------------------
test("E. the plan for a payload that CREATED a task now carries that new canonical id", async () => {
  const dir = await ownedDir()
  // Exactly the PHASE 4A.4A §3 scenario: t1=A, t2=B exist; C is new and must
  // arrive in the plan as t3.
  seed(dir, S, ["A", "B"])
  const todos = [
    { taskId: "t1", content: "A", status: "pending" },
    { taskId: "t2", content: "B", status: "pending" },
    { content: "C", status: "pending" },
  ]
  // The tool result is production's, not a hand-written fixture.
  const out = await runTodoWrite(dir, todos)
  const { bus, plans } = build(dir)
  complete(bus, "call-1", { todos }, out)

  const ev = plans()[0]
  expect(ev).toBeDefined()
  // t1, t2 AND the id minted by this very operation.
  expect(ev!.steps.map((s) => s.taskId)).toEqual(["t1", "t2", "t3"])
  expect(ev!.steps.map((s) => s.ordinal)).toEqual([0, 1, 2])
  // Identity is taskId-based, never inferred from position.
  expect(ev!.steps.map((s) => s.stepId)).toEqual(["1", "2", "3"])
  expect(new TaskStore(dir).getTask(S, "t3")?.title).toBe("C")
})

// ---------------------------------------------------------------------------
// F. v2 for a fully canonical mixed payload
// ---------------------------------------------------------------------------
test("F. a fully canonical mixed payload emits payloadVersion=2", async () => {
  const dir = await ownedDir()
  seed(dir)
  const todos = [
    { taskId: "t3", content: "C", status: "pending" },
    { content: "D", status: "pending" },
    { taskId: "t1", content: "A", status: "pending" },
  ]
  const out = await runTodoWrite(dir, todos)
  const { bus, plans } = build(dir)
  complete(bus, "call-1", { todos }, out)
  const ev = plans()[0]
  expect(ev!.payloadVersion).toBe(2)
  expect(ev!.steps.map((s) => s.taskId)).toEqual(["t3", "t4", "t1"])
})

// ---------------------------------------------------------------------------
// G. an incomplete / stale / foreign assignment must never yield v2
// ---------------------------------------------------------------------------
test("G. no incomplete assignment can produce payloadVersion=2", async () => {
  const dir = await ownedDir()
  seed(dir)
  const todos = [
    { taskId: "t1", content: "A", status: "pending" },
    { content: "New", status: "pending" },
  ]
  const out = await runTodoWrite(dir, todos)
  const good = decodeCanonicalAssignments(out, { sessionId: S })!
  expect(good).toHaveLength(2)

  const cases: Array<[string, string]> = [
    // no assignment at all
    ["absent", out.split("\n").slice(0, -1).join("\n")],
    // arity mismatch: one entry short
    ["short", encodeCanonicalAssignments(S, good.slice(0, 1))],
    // foreign session stamp
    ["foreign session", encodeCanonicalAssignments("some-other-session", good)],
    // malformed id
    [
      "malformed id",
      encodeCanonicalAssignments(S, [{ taskId: "nope", kind: "existing" }, good[1]!]),
    ],
    // duplicate ids
    [
      "duplicate",
      encodeCanonicalAssignments(S, [good[0]!, { taskId: "t1", kind: "new" }]),
    ],
    // stale: rewrites an id the model actually declared
    [
      "stale rewrite",
      encodeCanonicalAssignments(S, [{ taskId: "t3", kind: "existing" }, good[1]!]),
    ],
    // truncated mid-JSON (what serializeContent can do to an oversized result)
    ["truncated", out.slice(0, out.length - 12)],
  ]

  for (const [label, content] of cases) {
    const { bus, plans } = build(dir)
    complete(bus, `call-${label}`, { todos }, content)
    const ev = plans()[0]
    // The plan still publishes - it is the legacy positional shape, never a lie.
    expect(ev, label).toBeDefined()
    expect(ev!.payloadVersion, label).toBeUndefined()
    expect(ev!.steps.every((s) => s.taskId === undefined), label).toBe(true)
  }
})

// ---------------------------------------------------------------------------
// H. a rolled-back transaction publishes no assignment
// ---------------------------------------------------------------------------
test("H. a rolled-back transaction cannot publish an assignment or a plan", async () => {
  const dir = await ownedDir()
  seed(dir)
  const todos = [
    { taskId: "t1", content: "A", status: "pending" },
    { content: "Created then rolled back", status: "pending" },
    { taskId: "t99", content: "unknown", status: "pending" },
  ]
  // The sync rejects the whole payload (resolve-before-mutate), so the tool
  // throws and there is no result string to carry an assignment.
  await expect(runTodoWrite(dir, todos)).rejects.toThrow()
  // Nothing committed: the new row does not exist.
  const store = new TaskStore(dir)
  expect(store.listTasks(S).map((x) => x.id)).toEqual(["t1", "t2", "t3"])
  // And the transaction-level result likewise exposes no assignment.
  expect(() =>
    synchronizeCanonicalTasks({
      cwd: dir,
      sessionId: S,
      declared: [
        { taskId: "t1", title: "A", status: "pending" },
        { title: "doomed", status: "pending" },
        { taskId: "t99", title: "unknown", status: "pending" },
      ],
    }),
  ).toThrow()
})

// ---------------------------------------------------------------------------
// I. concurrent operations must not cross-wire
// ---------------------------------------------------------------------------
test("I. two operations' assignments cannot be consumed by each other", async () => {
  const dir = await ownedDir()
  seed(dir, S, ["A"])
  // Two operations over the same store. The first mints t2, the second t3, so
  // their assignments are DISTINGUISHABLE - if any shared state leaked, the two
  // plans would collide.
  const payloadA = [
    { taskId: "t1", content: "A", status: "pending" },
    { content: "from-A", status: "pending" },
  ]
  const payloadB = [
    { taskId: "t1", content: "A", status: "pending" },
    { content: "from-B", status: "pending" },
  ]
  const outA = await runTodoWrite(dir, payloadA)
  const outB = await runTodoWrite(dir, payloadB)
  expect(ids(decodeCanonicalAssignments(outA, { sessionId: S }))).toEqual(["t1", "t2"])
  expect(ids(decodeCanonicalAssignments(outB, { sessionId: S }))).toEqual(["t1", "t3"])
  expect(new TaskStore(dir).getTask(S, "t2")?.title).toBe("from-A")
  expect(new TaskStore(dir).getTask(S, "t3")?.title).toBe("from-B")

  // Interleave the completions - B delivered first, then A - in a single burst.
  // Each plan must be built from ITS OWN result, not from whatever ran last.
  const forward = build(dir)
  complete(forward.bus, "call-B", { todos: payloadB }, outB)
  complete(forward.bus, "call-A", { todos: payloadA }, outA)
  const fwd = forward.plans()
  expect(fwd.map((p) => p.steps.map((s) => s.taskId))).toEqual([
    ["t1", "t3"],
    ["t1", "t2"],
  ])

  // And the opposite order, on a fresh adapter, must follow the results too.
  const reverse = build(dir)
  complete(reverse.bus, "call-A", { todos: payloadA }, outA)
  complete(reverse.bus, "call-B", { todos: payloadB }, outB)
  expect(reverse.plans().map((p) => p.steps.map((s) => s.taskId))).toEqual([
    ["t1", "t2"],
    ["t1", "t3"],
  ])

  // Reusing operation A's result under a different session is refused outright.
  expect(decodeCanonicalAssignments(outA, { sessionId: "another-session" })).toBeUndefined()
})

// ---------------------------------------------------------------------------
// J. MCP contexts must not cross-wire
// ---------------------------------------------------------------------------
test("J. two MCP contexts propagate their own assignment and never each other's", async () => {
  const dirA = await ownedDir()
  const dirB = await ownedDir()
  // Real Phase 4A.3 namespaces, not hand-written strings.
  const ctxA = newMcpContextId()
  const ctxB = newMcpContextId()
  expect(ctxA).not.toBe(ctxB)
  expect(ctxA.startsWith("mcp:")).toBe(true)
  // Seed under the namespaces themselves, so the store rows and the propagated
  // session are the same identity.
  seed(dirA, ctxA, ["A"])
  seed(dirB, ctxB, ["B"])

  const savedA = applyMcpContext(ctxA, dirA)
  try {
    const outA = await runTodoWrite(
      dirA,
      [
        { taskId: "t1", content: "A", status: "pending" },
        { content: "ctx-A-new", status: "pending" },
      ],
      ctxA,
    )
    const tA = decodeCanonicalAssignments(outA, { sessionId: ctxA })
    expect(ids(tA)).toEqual(["t1", "t2"])
    // A's assignment is meaningless in B's namespace.
    expect(decodeCanonicalAssignments(outA, { sessionId: ctxB })).toBeUndefined()
    expect(new TaskStore(dirA).getTask(ctxA, "t2")?.title).toBe("ctx-A-new")
  } finally {
    todoSession.id = savedA.prevId
    todoSession.cwd = savedA.prevCwd
  }

  const savedB = applyMcpContext(ctxB, dirB)
  try {
    const outB = await runTodoWrite(
      dirB,
      [
        { taskId: "t1", content: "B", status: "pending" },
        { content: "ctx-B-new", status: "pending" },
      ],
      ctxB,
    )
    const tB = decodeCanonicalAssignments(outB, { sessionId: ctxB })
    expect(ids(tB)).toEqual(["t1", "t2"])
    expect(decodeCanonicalAssignments(outB, { sessionId: ctxA })).toBeUndefined()
    // B's store never saw A's task.
    expect(new TaskStore(dirB).getTask(ctxA, "t2")).toBeNull()
    expect(new TaskStore(dirB).getTask(ctxB, "t2")?.title).toBe("ctx-B-new")
  } finally {
    todoSession.id = savedB.prevId
    todoSession.cwd = savedB.prevCwd
  }
})

// ---------------------------------------------------------------------------
// K. no global assignment registry exists
// ---------------------------------------------------------------------------
test("K. the assignment channel holds no module-level mutable state", async () => {
  const src = await readFile(join(import.meta.dir, "..", "src", "task", "assignment.ts"), "utf8")
  // No module-scope mutable container. `const` tables and pure helpers only.
  expect(src).not.toMatch(/^\s*(let|var)\s+\w+\s*=\s*new\s+(Map|Set|WeakMap)/m)
  expect(src).not.toMatch(/^\s*(let|var)\s+\w+\s*=\s*\[\]/m)
  // No process-global singleton holding assignments.
  expect(src).not.toMatch(/globalThis/)
  expect(src).not.toMatch(/\bstatic\s+\w+/)
  // The codec is pure: same input, same output, no accumulation across calls.
  const table = [
    { taskId: "t1", kind: "existing" as const },
    { taskId: "t2", kind: "new" as const },
  ]
  const wire = encodeCanonicalAssignments(S, table)
  const first = decodeCanonicalAssignments(wire, { sessionId: S })
  for (let i = 0; i < 5; i++) {
    expect(decodeCanonicalAssignments(wire, { sessionId: S })).toEqual(first)
  }
  expect(first).toEqual(table)
  // Unrelated traffic between decodes changes nothing.
  decodeCanonicalAssignments("some other tool output", { sessionId: S })
  decodeCanonicalAssignments(encodeCanonicalAssignments("other", table), { sessionId: "other" })
  expect(decodeCanonicalAssignments(wire, { sessionId: S })).toEqual(first)
})

// ---------------------------------------------------------------------------
// L. the legacy all-id-less path is untouched
// ---------------------------------------------------------------------------
// PHASE 4A.5 FIXTURE CORRECTION. This test used to seed canonical tasks and then
// write an all-id-less payload into that same session. That is exactly the case
// 4A.5 now REJECTS, so the fixture no longer described the legacy path. The
// intent - "the legacy path is unchanged" - is preserved by using a session with
// NO canonical identity, which is precisely what LEGACY means. The complementary
// case (canonical tasks + all-id-less) is proven in the 4A.5 suite, not here.
test("L. an all-id-less payload with no canonical identity stays legacy: no sync, no assignment", async () => {
  const dir = await ownedDir()
  // NO seed: this session has never had canonical identity, so it is LEGACY.
  const todos = [
    { content: "legacy one", status: "pending" },
    { content: "legacy two", status: "pending" },
  ]
  const out = await runTodoWrite(dir, todos)
  // No assignment is emitted at all - nothing to decode, and nothing invented.
  expect(decodeCanonicalAssignments(out, { sessionId: S })).toBeUndefined()
  expect(out).not.toContain("canonical-tasks")
  // Nothing was adopted, allocated or created: the store is still empty.
  const store = new TaskStore(dir)
  expect(store.listTasks(S)).toEqual([])
  // The legacy JSON file holds exactly the id-less payload, at its real path
  // (`.minicode/todos/<sanitized-session>.json`).
  const raw = await readFile(join(dir, ".minicode", "todos", `${S}.json`), "utf8")
  const parsed = JSON.parse(raw) as { sessionId: string; todos: Array<{ content: string }> }
  expect(parsed.sessionId).toBe(S)
  expect(parsed.todos.map((t) => t.content)).toEqual(["legacy one", "legacy two"])
  expect(raw).not.toContain("taskId")
})

// ---------------------------------------------------------------------------
// M. §14 regression: the GREEN canonical counterpart of the debc295 known-bad
// ---------------------------------------------------------------------------
test("M. a canonical payload creates C as t3, and reordering C keeps t3 (no duplicates)", async () => {
  const dir = await ownedDir()
  seed(dir, S, ["A", "B"])

  // First turn: A(t1) B(t2) C(new). The plan must be able to name all three,
  // including the id this operation is about to mint.
  const first = [
    { taskId: "t1", content: "A", status: "pending" },
    { taskId: "t2", content: "B", status: "pending" },
    { content: "C", status: "pending" },
  ]
  const out1 = await runTodoWrite(dir, first)
  const one = build(dir)
  complete(one.bus, "turn-1", { todos: first }, out1)
  const plan1 = one.plans()[0]!
  expect(plan1.payloadVersion).toBe(2)
  expect(plan1.steps.map((s) => s.taskId)).toEqual(["t1", "t2", "t3"])

  // Second turn: C(t3) A(t1) B(t2). Identity must travel with the item.
  const second = [
    { taskId: "t3", content: "C", status: "pending" },
    { taskId: "t1", content: "A", status: "pending" },
    { taskId: "t2", content: "B", status: "pending" },
  ]
  const out2 = await runTodoWrite(dir, second)
  const two = build(dir)
  complete(two.bus, "turn-2", { todos: second }, out2)
  const plan2 = two.plans()[0]!
  expect(plan2.payloadVersion).toBe(2)
  expect(plan2.steps.map((s) => s.taskId)).toEqual(["t3", "t1", "t2"])

  // The contrast with debc295: three rows, not six. Reordering is not creation.
  // `listTasks` is returned in canonical ORDER (t3 now leads), so the row SET is
  // what must be unchanged - identity, not position, is the invariant.
  const store = new TaskStore(dir)
  const rows = store.listTasks(S)
  expect(rows).toHaveLength(3)
  expect(rows.map((x) => x.id).sort()).toEqual(["t1", "t2", "t3"])
  expect(store.getTask(S, "t1")?.title).toBe("A")
  expect(store.getTask(S, "t2")?.title).toBe("B")
  expect(store.getTask(S, "t3")?.title).toBe("C")
})

// ---------------------------------------------------------------------------
// N. two new tasks with the SAME title still get distinct identities
// ---------------------------------------------------------------------------
test("N. identical titles do not collapse into one identity", async () => {
  const dir = await ownedDir()
  seed(dir, S, ["A"])
  // Duplicate content is entirely ordinary for a model. It is precisely the case
  // that any title/content-based re-query gets wrong.
  const todos = [
    { taskId: "t1", content: "A", status: "pending" },
    { content: "same", status: "pending" },
    { content: "same", status: "pending" },
  ]
  const out = await runTodoWrite(dir, todos)
  const t = decodeCanonicalAssignments(out, { sessionId: S })
  expect(ids(t)).toEqual(["t1", "t2", "t3"])
  // Two DISTINCT rows, both titled "same" - identity is not the title.
  const store = new TaskStore(dir)
  const same = store.listTasks(S).filter((x) => x.title === "same")
  expect(same).toHaveLength(2)
  expect(same.map((x) => x.id)).toEqual(["t2", "t3"])
  expect(store.getTask(S, "t2")?.id).not.toBe(store.getTask(S, "t3")?.id)

  // And the plan names both of them.
  const { bus, plans } = build(dir)
  complete(bus, "call-1", { todos }, out)
  const ev = plans()[0]!
  expect(ev.payloadVersion).toBe(2)
  expect(ev.steps.map((s) => s.taskId)).toEqual(["t1", "t2", "t3"])
})

// ---------------------------------------------------------------------------
// O. a LATER operation must not inherit an EARLIER operation's assignment
// ---------------------------------------------------------------------------
test("O. a later operation with no assignment cannot inherit an earlier one", async () => {
  const dir = await ownedDir()
  seed(dir, S, ["A"])
  const todos = [
    { taskId: "t1", content: "A", status: "pending" },
    { content: "X", status: "pending" },
  ]
  const withAssignment = await runTodoWrite(dir, todos)
  // Deliberately the SAME arity and the SAME declared leading id as the first
  // operation, so a leaked cache would pass every length and consistency check.
  // This is the shape that makes cross-operation leakage observable.
  const withoutAssignment = withAssignment.split("\n").slice(0, -1).join("\n")

  // ONE adapter serves both operations - the realistic case within a session.
  const { bus, plans } = build(dir)
  complete(bus, "op-1", { todos }, withAssignment)
  complete(bus, "op-2", { todos }, withoutAssignment)

  const evs = plans()
  expect(evs).toHaveLength(2)
  expect(evs[0]!.payloadVersion).toBe(2)
  expect(evs[0]!.steps.map((s) => s.taskId)).toEqual(["t1", "t2"])
  // The second operation has no assignment of its own, so it must not claim v2.
  expect(evs[1]!.payloadVersion).toBeUndefined()
  expect(evs[1]!.steps.every((s) => s.taskId === undefined)).toBe(true)
})
