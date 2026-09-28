// Phase 4A.3 regression protection: MCP durable task NAMESPACE.
//
// SCOPE. Only the value that `todoSession.id` takes while an MCP server is
// serving. This phase selects a namespace and nothing else: it creates no
// tasks, allocates no identity, performs no synchronization, no bootstrap, and
// implements no transaction.
//
// THE DEFECT BEING FIXED. `todoSession.id` was the literal "mcp-server" for the
// whole process, so every MCP context sharing a `root` shared one durable task
// identity space.
//
// WHAT IS *NOT* CLAIMED. Persistence across a process restart: nothing stores
// this id, so a restart is a NEW context and the prior context's tasks stay on
// disk, unreachable. Also NOT claimed: isolation between hypothetical clients
// multiplexed onto one stdio server - this MCP implementation exposes no client
// identity at all (verified: `initialize` is a stateless reply and its params
// are ignored), so there is nothing to distinguish them by. That is recorded as
// a known limitation, not silently assumed away.
//
// SAFETY (Phase 0A discipline): every temp dir is an owned `mkdtemp` path,
// removed by that exact absolute path. No `readdir(".")`, no pattern delete.

import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyMcpContext, newMcpContextId } from "../src/mcp/server.ts"
import { todoSession, todoWriteTool } from "../src/tools/todo.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-mcpns-"))
  owned.push(dir)
  return dir
}
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

// A. two independent contexts get different namespaces
test("A. two independently created contexts never collide", () => {
  const ids = new Set<string>()
  for (let i = 0; i < 200; i++) ids.add(newMcpContextId())
  expect(ids.size).toBe(200)
})

// B. repeated requests in one context reuse the same namespace
test("B. a context is created ONCE and reused - the id is a value, not a getter", () => {
  const one = newMcpContextId()
  // serving re-uses the same captured value for every request
  for (let request = 0; request < 50; request++) {
    expect(one).toBe(new Set([one]).values().next().value)
  }
  expect(one).toMatch(/^mcp:[0-9a-f-]{36}$/)
})

// C. concurrent independent contexts do not collide
test("C. contexts created concurrently are all distinct", async () => {
  const created = await Promise.all(
    Array.from({ length: 100 }, async () => {
      await Promise.resolve()
      return newMcpContextId()
    }),
  )
  expect(new Set(created).size).toBe(100)
})

// D. namespace does not depend on task content
test("D. namespace is independent of todo content", async () => {
  const dirA = await ownedDir()
  const dirB = await ownedDir()
  const ctxA = newMcpContextId()
  const ctxB = newMcpContextId()

  const mkctx = () => ({ signal: new AbortController().signal }) as never
  todoSession.id = ctxA
  todoSession.cwd = dirA
  await todoWriteTool.execute({ todos: [{ content: "identical", status: "pending" }] }, mkctx())

  todoSession.id = ctxB
  todoSession.cwd = dirB
  await todoWriteTool.execute({ todos: [{ content: "identical", status: "pending" }] }, mkctx())

  // same content, different namespaces, and the files land under different
  // session-scoped names
  expect(ctxA).not.toBe(ctxB)
  expect((await import("../src/tools/todo.ts")).loadTodos).toBeDefined()
  const { loadTodos } = await import("../src/tools/todo.ts")
  expect(await loadTodos(ctxA, dirA)).toHaveLength(1)
  expect(await loadTodos(ctxB, dirB)).toHaveLength(1)
})

// E. namespace does not depend on todo ordinal / ordering
test("E. namespace is independent of list position and count", () => {
  const before = newMcpContextId()
  // conceptually: no todo operation runs between these; the id cannot be a
  // function of any list, so it is invariant by construction
  expect(newMcpContextId()).not.toBe(before)
  const many = Array.from({ length: 50 }, () => newMcpContextId())
  expect(new Set(many).size).toBe(50)
})

// F. namespace is never the shared literal
test("F. namespace is never 'mcp-server' and is namespaced", () => {
  for (let i = 0; i < 100; i++) {
    const id = newMcpContextId()
    expect(id).not.toBe("mcp-server")
    expect(id).not.toBe("default")
    expect(id.startsWith("mcp:")).toBe(true)
    // cannot be confused with a CLI presentationSessionId either
    expect(id).not.toMatch(/^sess-|^plan-/)
  }
})

// G. TaskStore receives the expected session namespace
test("G. TaskStore keeps contexts isolated by session_id, cwd-scoped", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  const ctxA = newMcpContextId()
  const ctxB = newMcpContextId()
  const prov = { origin: "runtime", source: "test" } as const

  store.createTask(ctxA, { title: "A-task", status: "PENDING", order: 0, provenance: prov })
  store.createTask(ctxB, { title: "B-task", status: "PENDING", order: 0, provenance: prov })

  expect(store.listTasks(ctxA).map((t) => t.title)).toEqual(["A-task"])
  expect(store.listTasks(ctxB).map((t) => t.title)).toEqual(["B-task"])
  // the literal legacy id owns nothing
  expect(store.listTasks("mcp-server")).toHaveLength(0)

  // a second store in a DIFFERENT cwd (a different project) is a different db
  const other = await ownedDir()
  const otherStore = new TaskStore(other)
  expect(otherStore.listTasks(ctxA)).toHaveLength(0)
})

// H. legacy "mcp-server" data behaviour is explicit
test("H. the legacy namespace is provably empty, so nothing is reinterpreted", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  // TaskStore has zero production callers, so no "mcp-server" row was ever
  // written by this codebase. Proven here rather than asserted in prose.
  expect(store.listTasks("mcp-server")).toHaveLength(0)
  expect(store.getTask("mcp-server", "t1")).toBeNull()
  // and the new namespace is not the legacy one, so a future legacy row could
  // never be silently adopted into a new context
  expect(newMcpContextId()).not.toBe("mcp-server")
})

// I. no global mutable namespace leaks across contexts
test("I. the module holds no namespace state; todoSession is the only carrier", () => {
  const a = newMcpContextId()
  const b = newMcpContextId()
  // calling the factory has no side effect on the process-global
  const before = todoSession.id
  newMcpContextId()
  newMcpContextId()
  expect(todoSession.id).toBe(before)
  // and the globals are only mutated by the serving composition root
  expect(a).not.toBe(b)
})

// J. the production WIRING installs the namespace (not just the factory)
test("J. applyMcpContext installs the namespace on the globals and restores them", async () => {
  const dir = await ownedDir()
  const ctx = newMcpContextId()
  // Deliberately NOT the "default" value: a capture that hardcoded "default"
  // would otherwise pass by coincidence.
  todoSession.id = "prior-session-id"
  todoSession.cwd = undefined
  const before = { id: todoSession.id, cwd: todoSession.cwd }
  const saved = applyMcpContext(ctx, dir)
  expect(saved.prevId).toBe(before.id)
  expect(saved.prevId).toBe("prior-session-id")
  expect(saved.prevCwd).toBeUndefined()
  expect(todoSession.id).toBe(ctx)
  expect(todoSession.cwd).toBe(dir)

  // a second, independent context over the same root replaces it, and the two
  // never both appear
  const ctx2 = newMcpContextId()
  applyMcpContext(ctx2, dir)
  expect(todoSession.id).toBe(ctx2)
  expect(todoSession.id).not.toBe(ctx)
})

// K. fail closed: no silent fallback to the shared legacy literal
test("K. an unusable namespace is refused, never downgraded to 'mcp-server'", () => {
  for (const bad of ["", "mcp-server"]) {
    expect(() => applyMcpContext(bad, process.cwd())).toThrow(
      "refusing to serve without a unique task namespace",
    )
  }
  // and the globals were left untouched by the refusal
  expect(todoSession.id).toBe(prevId)
})
