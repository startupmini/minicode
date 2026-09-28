// Phase 4B: canonical identity integrity - ISOLATION, MCP LIFECYCLE, CONCURRENCY.
//
// THIS IS NEW ARCHITECTURE VALIDATION.
//
// Covers:
//   13. session isolation      - A:t1 and B:t1 are different tasks
//   14. MCP lifecycle          - one context is stable; two contexts differ; and
//                                RESTART is measured, not assumed
//   15. concurrent operations  - no identity cross-wiring
//
// The MCP restart behaviour is deliberately MEASURED here rather than asserted
// either way. Phase 4A.3 generates a fresh `mcp:<uuid>` per server instance, so
// canonical identity is NOT expected to survive a restart - but that is a claim
// about a durable mechanism, so it is measured and recorded as a lifecycle
// limitation rather than glossed over.

import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { todoReadTool, todoWriteTool } from "../src/tools/todo.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { decodeCanonicalAssignments } from "../src/task/assignment.ts"
import { applyMcpContext, newMcpContextId } from "../src/mcp/server.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-iso-"))
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
const opCtx = (dir: string, sessionId: string) =>
  ({ signal: new AbortController().signal, cwd: dir, sessionId }) as never
const seed = (dir: string, sessionId: string, titles: string[]) => {
  const s = new TaskStore(dir)
  titles.forEach((t, i) => s.createTask(sessionId, { title: t, status: "PENDING", order: i, provenance: prov }))
}
const rows = (dir: string, sessionId: string) =>
  Object.fromEntries(new TaskStore(dir).listTasks(sessionId).map((t) => [t.id, t.title]))
const write = (dir: string, todos: unknown[], sessionId: string) =>
  todoWriteTool.execute({ todos } as never, opCtx(dir, sessionId)) as Promise<string>

// ---------------------------------------------------------------------------
// 13. SESSION ISOLATION
// ---------------------------------------------------------------------------
test("13. session isolation: t1 in session A and t1 in session B are different tasks", async () => {
  const dir = await ownedDir()
  seed(dir, "A", ["A"])
  seed(dir, "B", ["B"])
  // The same id string in two namespaces, bound to different logical tasks.
  expect(rows(dir, "A")).toEqual({ t1: "A" })
  expect(rows(dir, "B")).toEqual({ t1: "B" })

  // Reorder + update both, concurrently.
  const [outA, outB] = await Promise.all([
    write(dir, [{ taskId: "t1", content: "A renamed", status: "completed" }], "A"),
    write(dir, [{ taskId: "t1", content: "B renamed", status: "pending" }], "B"),
  ])
  // No cross-session leakage: A's rename did not touch B.
  expect(rows(dir, "A")).toEqual({ t1: "A renamed" })
  expect(rows(dir, "B")).toEqual({ t1: "B renamed" })
  // Each assignment is stamped for its own session and is meaningless in the other.
  expect(decodeCanonicalAssignments(outA, { sessionId: "A" })?.map((a) => a.taskId)).toEqual(["t1"])
  expect(decodeCanonicalAssignments(outA, { sessionId: "B" })).toBeUndefined()
  expect(decodeCanonicalAssignments(outB, { sessionId: "B" })?.map((a) => a.taskId)).toEqual(["t1"])
  expect(decodeCanonicalAssignments(outB, { sessionId: "A" })).toBeUndefined()
  // Statuses stayed in their own namespace too.
  expect(new TaskStore(dir).getTask("A", "t1")?.status).toBe("COMPLETED")
  expect(new TaskStore(dir).getTask("B", "t1")?.status).toBe("PENDING")
})

// ---------------------------------------------------------------------------
// 15. CONCURRENCY
// ---------------------------------------------------------------------------
test("15. concurrent canonical writes in two sessions create no cross-wired identity", async () => {
  const dir = await ownedDir()
  seed(dir, "sess-A", ["A"])
  seed(dir, "sess-B", ["B"])
  const payloadA = [
    { taskId: "t1", content: "A", status: "pending" },
    { content: "new-in-A", status: "pending" },
  ]
  const payloadB = [
    { taskId: "t1", content: "B", status: "pending" },
    { content: "new-in-B", status: "pending" },
  ]
  const [outA, outB] = await Promise.all([
    write(dir, payloadA, "sess-A"),
    write(dir, payloadB, "sess-B"),
  ])
  // Each new task landed in its OWN namespace only.
  expect(rows(dir, "sess-A")).toEqual({ t1: "A", t2: "new-in-A" })
  expect(rows(dir, "sess-B")).toEqual({ t1: "B", t2: "new-in-B" })
  // No duplicate identity anywhere, and both namespaces have exactly two rows.
  expect(new TaskStore(dir).listTasks("sess-A")).toHaveLength(2)
  expect(new TaskStore(dir).listTasks("sess-B")).toHaveLength(2)
  // Assignment did not cross-wire.
  expect(decodeCanonicalAssignments(outA, { sessionId: "sess-A" })?.map((a) => a.taskId)).toEqual(["t1", "t2"])
  expect(decodeCanonicalAssignments(outB, { sessionId: "sess-B" })?.map((a) => a.taskId)).toEqual(["t1", "t2"])
  expect(decodeCanonicalAssignments(outA, { sessionId: "sess-B" })).toBeUndefined()
  // No transaction contamination: each namespace's next id is independent.
  expect(new TaskStore(dir).nextId("sess-A")).toBe("t3")
  expect(new TaskStore(dir).nextId("sess-B")).toBe("t3")
})

test("15b. concurrent operations in ONE session do not duplicate or cross-wire", async () => {
  const dir = await ownedDir()
  const S = "one-session"
  seed(dir, S, ["A"])
  // Two different new tasks racing in the same namespace.
  const [outX, outY] = await Promise.all([
    write(dir, [{ taskId: "t1", content: "A", status: "pending" }, { content: "X", status: "pending" }], S),
    write(dir, [{ taskId: "t1", content: "A", status: "pending" }, { content: "Y", status: "pending" }], S),
  ])
  const after = rows(dir, S)
  // Whatever the interleaving, identity is unique and each payload's item kept
  // its own content: no item was renamed into another, none was lost.
  expect(Object.values(after).sort()).toEqual(["A", "X", "Y"])
  expect(new Set(Object.values(after)).size).toBe(3)
  // Both operations reported a complete assignment for their own payload.
  for (const out of [outX, outY]) {
    const t = decodeCanonicalAssignments(out, { sessionId: S })
    expect(t).toHaveLength(2)
    expect(t![0]!.taskId).toBe("t1")
    expect(t![0]!.kind).toBe("existing")
  }
})

// ---------------------------------------------------------------------------
// 14. MCP LIFECYCLE
// ---------------------------------------------------------------------------
/** Start a real MCP server over stdio and return an RPC helper. */
async function startMcp(dir: string) {
  const bunBin = existsSync(process.execPath) ? process.execPath : "bun"
  const proc = Bun.spawn([bunBin, "cli/index.ts", "mcp", "serve", "--cwd", dir], {
    cwd: resolve(import.meta.dir, ".."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ""
  const next = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const nl = buf.indexOf("\n")
      if (nl >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) {
          try {
            return JSON.parse(line) as Record<string, unknown>
          } catch {}
        }
        continue
      }
      const { value, done } = await reader.read()
      if (done) throw new Error("mcp stdout closed")
      buf += value
    }
  }
  const call = async (id: number, name: string, args: unknown) => {
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n",
    )
    for (;;) {
      const m = await next()
      if (m.id === id) return m as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }
    }
  }
  proc.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "d", version: "1" } },
    }) + "\n",
  )
  await next()
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
  return { call, stop: async () => { proc.kill(); await proc.exited } }
}
const todosDir = (dir: string) => join(dir, ".minicode", "todos")

test("14. MCP: one context is stable across requests, and canonical identity works inside it", async () => {
  const dir = await ownedDir()
  const mcp = await startMcp(dir)
  try {
    // Two writes in the SAME server context must share one durable namespace.
    const w1 = await mcp.call(11, "todo_write", { todos: [{ content: "from-mcp", status: "pending" }] })
    expect(w1.result?.isError ?? false).toBe(false)
    const w2 = await mcp.call(12, "todo_write", { todos: [{ content: "from-mcp", status: "pending" }] })
    expect(w2.result?.isError ?? false).toBe(false)
    const files = (await readdir(todosDir(dir))).sort()
    // Exactly ONE namespace file, named by a per-instance mcp:<uuid>.
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^mcp-[0-9a-f-]{36}\.json$/)
    // The JSON-RPC request ids (11, 12) were NOT used as durable identity.
    expect(files[0]).not.toContain("11")
    expect(files[0]).not.toContain("12")
    // The sessionId recorded inside is the mcp: form of that same namespace.
    const stored = JSON.parse(await Bun.file(join(todosDir(dir), files[0]!)).text()) as { sessionId: string }
    expect(stored.sessionId).toBe(files[0]!.replace(/\.json$/, "").replace("mcp-", "mcp:"))
  } finally {
    await mcp.stop()
  }
}, 30000)

test("14b. MCP: two independent server contexts get different durable namespaces", async () => {
  const dirA = await ownedDir()
  const dirB = await ownedDir()
  const a = await startMcp(dirA)
  try {
    await a.call(11, "todo_write", { todos: [{ content: "in-A", status: "pending" }] })
  } finally {
    await a.stop()
  }
  const b = await startMcp(dirB)
  try {
    await b.call(11, "todo_write", { todos: [{ content: "in-B", status: "pending" }] })
  } finally {
    await b.stop()
  }
  const nsA = (await readdir(todosDir(dirA)))[0]!
  const nsB = (await readdir(todosDir(dirB)))[0]!
  // Different instances, different namespaces.
  expect(nsA).not.toBe(nsB)
  expect(nsA).toMatch(/^mcp-/)
  expect(nsB).toMatch(/^mcp-/)
}, 30000)

test("14c. MEASURED LIMITATION: MCP canonical identity does NOT survive a server restart", async () => {
  const dir = await ownedDir()
  const first = await startMcp(dir)
  let firstNs: string
  try {
    await first.call(11, "todo_write", { todos: [{ content: "before-restart", status: "pending" }] })
    firstNs = (await readdir(todosDir(dir)))[0]!
  } finally {
    await first.stop()
  }
  // Restart: a brand new server instance against the SAME project directory.
  const second = await startMcp(dir)
  try {
    await second.call(11, "todo_write", { todos: [{ content: "after-restart", status: "pending" }] })
  } finally {
    await second.stop()
  }
  // Phase 4A.3 mints `mcp:<uuid>` per INSTANCE, so the restarted server gets a
  // NEW namespace. That is a real lifecycle limitation, measured here rather
  // than assumed: there is no durable mechanism preserving the MCP context id,
  // so canonical task identity and todo state do not carry across a restart.
  const all = (await readdir(todosDir(dir))).sort()
  expect(all).toHaveLength(2)
  const newNs = all.find((f) => f !== firstNs)!
  expect(newNs).toBeDefined()
  // Both namespaces are distinct mcp:<uuid> instances.
  expect(firstNs).toMatch(/^mcp-[0-9a-f-]{36}\.json$/)
  expect(newNs).toMatch(/^mcp-[0-9a-f-]{36}\.json$/)
  // Nothing was migrated, adopted or merged into the new namespace.
  const firstStored = JSON.parse(await Bun.file(join(todosDir(dir), firstNs)).text()) as {
    todos: Array<{ content: string }>
  }
  const newStored = JSON.parse(await Bun.file(join(todosDir(dir), newNs)).text()) as {
    todos: Array<{ content: string }>
  }
  expect(firstStored.todos.map((t) => t.content)).toEqual(["before-restart"])
  expect(newStored.todos.map((t) => t.content)).toEqual(["after-restart"])
  // TaskStore holds no canonical rows for the pre-restart context, and the
  // restarted context cannot see the earlier namespace's work.
  const ctxId = firstNs.replace(/\.json$/, "").replace("mcp-", "mcp:")
  expect(new TaskStore(dir).listTasks(ctxId)).toEqual([])
}, 30000)

test("14d. MCP context isolation holds for the 4A.5 rule", async () => {
  const dir = await ownedDir()
  const ctxA = newMcpContextId()
  const ctxB = newMcpContextId()
  seed(dir, ctxA, ["A"])
  const saved = applyMcpContext(ctxA, dir)
  try {
    // A is canonical -> rejected.
    await expect(write(dir, [{ content: "A", status: "pending" }], ctxA)).rejects.toThrow()
    // B is not -> legacy, accepted.
    const outB = await write(dir, [{ content: "B", status: "pending" }], ctxB)
    expect(outB).not.toContain("canonical-tasks")
    expect(new TaskStore(dir).listTasks(ctxA)).toHaveLength(1)
    expect(new TaskStore(dir).listTasks(ctxB)).toEqual([])
  } finally {
    todoSessionReset(saved)
  }
})

function todoSessionReset(saved: { prevId: string; prevCwd: string | undefined }) {
  // Restoring through the same API the server uses, without importing the global.
  const { todoSession } = require("../src/tools/todo.ts")
  todoSession.id = saved.prevId
  todoSession.cwd = saved.prevCwd
}

// ---------------------------------------------------------------------------
// read-back isolation across sessions
// ---------------------------------------------------------------------------
test("13b. todo_read never crosses a session boundary", async () => {
  const dir = await ownedDir()
  await write(dir, [{ content: "belongs-to-A", status: "pending" }], "A")
  await write(dir, [{ content: "belongs-to-B", status: "pending" }], "B")
  const seenA = String(await todoReadTool.execute({} as never, opCtx(dir, "A")))
  const seenB = String(await todoReadTool.execute({} as never, opCtx(dir, "B")))
  expect(seenA).toContain("belongs-to-A")
  expect(seenA).not.toContain("belongs-to-B")
  expect(seenB).toContain("belongs-to-B")
  expect(seenB).not.toContain("belongs-to-A")
  // Each session's durable file is its own.
  expect((await readdir(todosDir(dir))).sort()).toEqual(["A.json", "B.json"])
})
