// Phase 3B regression protection: TaskStore -> Plan pipeline contract.
//
// SCOPE. This file proves the CONTRACT and the AUTHORITY BOUNDARY of the
// canonical plan pipeline:
//
//   TaskStore snapshot -> canonical taskId -> PlanStep.taskId -> payloadVersion=2
//
// It does NOT claim an end-to-end production pipeline. TaskStore has no
// production writer (see PHASE-3B-PLAN-PIPELINE-RECOVERY-REPORT.md, "the missing
// boundary"), so the production path injects no provider and stays on the
// positional legacy shape. That is asserted here as intended behaviour, not
// hidden.
//
// NOT in scope: Phase 3C restart/reorder E2E, TaskGraph, Scheduler, ACP
// semantics. Nothing here crosses a restart boundary.
//
// SAFETY: hermetic fake bus, no network, no API key. TaskStore-backed tests own
// one mkdtemp directory each, removed by that exact absolute path.

import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createPresentationAdapter,
  type TaskIdentityProvider,
} from "../src/presentation/adapter.ts"
import type { DomainEvent, EventBusLike, PlanUpdatedEvent } from "../src/presentation/events.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { isTaskId } from "../src/task/model.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-plan-"))
  owned.push(dir)
  return dir
}
afterEach(async () => {
  resetTaskStoreHandles()
  while (owned.length) await rm(owned.pop()!, { recursive: true, force: true }).catch(() => {})
})

function fakeBus(): EventBusLike & { emit: (type: string, payload: unknown) => void } {
  const handlers = new Map<string, Set<(e: any) => void>>()
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set<(e: any) => void>()
      set.add(handler)
      handlers.set(type, set)
      return () => set.delete(handler)
    },
    emit(type, payload) {
      const set = handlers.get(type)
      if (set) for (const h of [...set]) h(payload)
    },
  }
}

const SESSION = "plan-session"
const todos3 = [
  { content: "alpha", status: "pending" },
  { content: "beta", status: "in_progress" },
  { content: "gamma", status: "pending" },
]

function build(provider?: TaskIdentityProvider) {
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, {
    sessionId: SESSION,
    ...(provider ? { taskIdentityProvider: provider } : {}),
  })
  const seen: DomainEvent[] = []
  adapter.onEvent((e) => seen.push(e))
  const plans = () => seen.filter((e): e is PlanUpdatedEvent => e.type === "plan.updated")
  return { bus, adapter, plans }
}

/** A provider backed by the REAL TaskStore: the authority under test. */
function storeProvider(store: TaskStore, sessionId: string): TaskIdentityProvider {
  return ({ sessionId: sid, declared }) => {
    const list = store.listTasks(sid)
    return declared.map((_step, i) => list[i]?.id ?? null)
  }
}

// 1. taskId comes from TaskStore, not from the adapter
test("1. taskId is supplied by the TaskStore-backed provider, never minted by the adapter", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  for (const t of todos3) {
    store.createTask(SESSION, {
      title: t.content,
      status: t.status === "in_progress" ? "IN_PROGRESS" : "PENDING",
      order: 0,
      provenance: { origin: "runtime", source: "test" },
    })
  }
  expect(store.listTasks(SESSION).map((x) => x.id)).toEqual(["t1", "t2", "t3"])

  const { adapter, plans } = build(storeProvider(store, SESSION))
  adapter.notePlanReconciled({ todos: todos3, sessionId: SESSION })
  const ev = plans()[0]!
  expect(ev.steps.map((s) => s.taskId)).toEqual(["t1", "t2", "t3"])
  // every id is a real, canonical TaskStore id
  for (const s of ev.steps) expect(isTaskId(s.taskId)).toBe(true)
  expect(store.listTasks(SESSION).map((x) => x.id)).toEqual(["t1", "t2", "t3"])
})

// 2. no positional allocator is used for canonical identity
test("2. with no provider the plan carries NO taskId and NO payloadVersion", () => {
  const { adapter, plans } = build()
  adapter.notePlanReconciled({ todos: todos3, sessionId: SESSION })
  const ev = plans()[0]!
  // positional stepIds remain, but they are not identity
  expect(ev.steps.map((s) => s.stepId)).toEqual(["1", "2", "3"])
  expect(ev.steps.every((s) => s.taskId === undefined)).toBe(true)
  expect(ev.steps.every((s) => s.ordinal === undefined)).toBe(true)
  expect(ev.payloadVersion).toBeUndefined()
  // and crucially: the adapter cannot have invented a t<n>
  expect(JSON.stringify(ev)).not.toMatch(/"t\d+"/)
})

// 3. PlanStep.taskId is stable across repeated publications
test("3. taskId is stable across repeated plan publication", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  for (const t of todos3) {
    store.createTask(SESSION, {
      title: t.content,
      status: "PENDING",
      order: 0,
      provenance: { origin: "runtime", source: "test" },
    })
  }
  const { adapter, plans } = build(storeProvider(store, SESSION))
  adapter.notePlanReconciled({ todos: todos3, sessionId: SESSION })
  adapter.notePlanReconciled({ todos: todos3, sessionId: SESSION })
  adapter.notePlanReconciled({ todos: todos3, sessionId: SESSION })
  const ids = plans().map((p) => p.steps.map((s) => s.taskId))
  expect(ids).toHaveLength(3)
  expect(ids[1]).toEqual(ids[0])
  expect(ids[2]).toEqual(ids[0])
  expect(ids[0]).toEqual(["t1", "t2", "t3"])
})

// 4. ordinal may change without changing taskId
test("4. reordering changes ordinal and stepId but never taskId", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  for (const t of todos3) {
    store.createTask(SESSION, {
      title: t.content,
      status: "PENDING",
      order: 0,
      provenance: { origin: "runtime", source: "test" },
    })
  }
  const { adapter, plans } = build(storeProvider(store, SESSION))
  // declared in store order: alpha=t1, beta=t2, gamma=t3
  adapter.notePlanReconciled({ todos: todos3, sessionId: SESSION })
  const first = plans()[0]!
  expect(first.steps.map((s) => [s.taskId, s.ordinal])).toEqual([
    ["t1", 0],
    ["t2", 1],
    ["t3", 2],
  ])

  // now the store's display order changes: gamma first
  store.patchTask(SESSION, "t3", { order: 0 })
  store.patchTask(SESSION, "t1", { order: 1 })
  store.patchTask(SESSION, "t2", { order: 2 })
  adapter.notePlanReconciled({ todos: todos3, sessionId: SESSION })
  const second = plans()[1]!

  // display position followed the store; the id set is unchanged
  expect(second.steps.map((s) => s.taskId)).toEqual(["t3", "t1", "t2"])
  expect(second.steps.map((s) => s.ordinal)).toEqual([0, 1, 2])
  // stepId is still purely positional and therefore DID change
  expect(second.steps.map((s) => s.stepId)).toEqual(["1", "2", "3"])
  // no taskId was lost or duplicated
  expect(new Set(second.steps.map((s) => s.taskId)).size).toBe(3)
})

// 5. payloadVersion=2 is emitted where required - and only when truthful
test("5. payloadVersion=2 appears only on a fully canonical plan", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  // store has only TWO of the three declared items
  for (const t of todos3.slice(0, 2)) {
    store.createTask(SESSION, {
      title: t.content,
      status: "PENDING",
      order: 0,
      provenance: { origin: "runtime", source: "test" },
    })
  }
  // provider returns null for the unresolved third entry
  const partial: TaskIdentityProvider = ({ declared }) =>
    declared.map((_s, i) => store.listTasks(SESSION)[i]?.id ?? null)

  const { adapter, plans } = build(partial)
  adapter.notePlanReconciled({ todos: todos3, sessionId: SESSION })
  const ev = plans()[0]!
  // partial resolution must NOT claim v2, and must not half-attach ids
  expect(ev.payloadVersion).toBeUndefined()
  expect(ev.steps.every((s) => s.taskId === undefined)).toBe(true)
})

// 6. legacy stepId is explicitly non-canonical
test("6. legacy stepId is never mirrored from taskId", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  for (const t of todos3) {
    store.createTask(SESSION, {
      title: t.content,
      status: "PENDING",
      order: 0,
      provenance: { origin: "runtime", source: "test" },
    })
  }
  const { adapter, plans } = build(storeProvider(store, SESSION))
  adapter.notePlanReconciled({ todos: todos3, sessionId: SESSION })
  const ev = plans()[0]!
  // taskId IS canonical...
  expect(ev.steps.map((s) => s.taskId)).toEqual(["t1", "t2", "t3"])
  // ...while stepId stays a positional "1","2","3" alias, deliberately NOT "t1"
  expect(ev.steps.map((s) => s.stepId)).toEqual(["1", "2", "3"])
  for (const s of ev.steps) expect(s.stepId).not.toBe(s.taskId)
})

// 7. conflicting / malformed identity is rejected by falling back, not by emitting v2
test("7. a misbehaving provider degrades to the legacy plan instead of lying", () => {
  const cases: TaskIdentityProvider[] = [
    // wrong length
    () => ["t1"],
    // throws
    () => {
      throw new Error("store unavailable")
    },
    // returns undefined
    () => undefined,
    // returns empty strings
    () => ["", "", ""],
    // returns non-strings
    () => [1, 2, 3] as unknown as string[],
  ]
  for (const provider of cases) {
    const { adapter, plans } = build(provider)
    adapter.notePlanReconciled({ todos: todos3, sessionId: SESSION })
    const ev = plans()[0]!
    expect(ev.payloadVersion).toBeUndefined()
    expect(ev.steps.every((s) => s.taskId === undefined)).toBe(true)
    expect(ev.steps.map((s) => s.stepId)).toEqual(["1", "2", "3"])
  }
})

// 8. empty / missing snapshot behaviour is explicit
test("8. empty and missing declarations publish no plan at all", () => {
  const { adapter, plans } = build(() => ["t1"])
  adapter.notePlanReconciled({ todos: [], sessionId: SESSION })
  adapter.notePlanReconciled({ todos: "not-an-array" as never, sessionId: SESSION })
  adapter.notePlanReconciled({ todos: [{ content: "", status: "pending" }], sessionId: SESSION })
  expect(plans()).toHaveLength(0)
})

// 9. existing unrelated plan behaviour is unchanged
test("9. plan status derivation and step status mapping are untouched", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(SESSION, {
    title: "a",
    status: "PENDING",
    order: 0,
    provenance: { origin: "runtime", source: "test" },
  })
  store.createTask(SESSION, {
    title: "b",
    status: "PENDING",
    order: 0,
    provenance: { origin: "runtime", source: "test" },
  })

  const { adapter, plans } = build(storeProvider(store, SESSION))
  adapter.notePlanReconciled({
    todos: [
      { content: "a", status: "completed" },
      { content: "b", status: "blocked", blockedReason: "menunggu" },
    ],
    sessionId: SESSION,
  })
  const ev = plans()[0]!
  // step status mapping preserved (in_progress -> active, else passthrough)
  expect(ev.steps.map((s) => s.status)).toEqual(["completed", "blocked"])
  // plan status: not all completed, not all cancelled -> open
  expect(ev.status).toBe("open")
  // and canonical identity rides along without disturbing either
  expect(ev.payloadVersion).toBe(2)
  expect(ev.steps.map((s) => s.taskId)).toEqual(["t1", "t2"])

  // all-completed still derives "completed"
  adapter.notePlanReconciled({
    todos: [
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
    ],
    sessionId: SESSION,
  })
  expect(plans()[1]?.status).toBe("completed")
})

// 10. the SECOND emission site (todo_write) carries the same contract
test("10. the todo_write emission path applies the identical canonical contract", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  for (const t of todos3) {
    store.createTask(SESSION, {
      title: t.content,
      status: "PENDING",
      order: 0,
      provenance: { origin: "runtime", source: "test" },
    })
  }
  const { bus, plans } = build(storeProvider(store, SESSION))
  const call = { id: "call-1", name: "todo_write", args: { todos: todos3 } }

  bus.emit("execution:started", { execution: { call: { id: call.id, name: call.name } } })
  bus.emit("execution:completed", {
    execution: {
      call: { id: call.id, name: call.name, args: call.args },
      result: { isError: false, content: "ok" },
    },
  })

  const ev = plans()[0]
  expect(ev).toBeDefined()
  expect(ev!.payloadVersion).toBe(2)
  expect(ev!.steps.map((s) => s.taskId)).toEqual(["t1", "t2", "t3"])
  expect(ev!.steps.map((s) => s.stepId)).toEqual(["1", "2", "3"])
  expect(ev!.steps.map((s) => s.ordinal)).toEqual([0, 1, 2])
  expect(ev!.planId).toContain(SESSION)

  // and with no provider, that same path stays positional and unversioned
  const legacy = build()
  legacy.bus.emit("execution:started", { execution: { call: { id: "c2", name: "todo_write" } } })
  legacy.bus.emit("execution:completed", {
    execution: {
      call: { id: "c2", name: "todo_write", args: { todos: todos3 } },
      result: { isError: false, content: "ok" },
    },
  })
  const legacyPlan = legacy.plans()[0]!
  expect(legacyPlan.payloadVersion).toBeUndefined()
  expect(legacyPlan.steps.every((s) => s.taskId === undefined)).toBe(true)
})
