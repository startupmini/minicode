// Phase 4A.4B regression protection: todo SESSION ISOLATION / concurrency.
//
// THIS IS NEW ARCHITECTURE (a fix to a production correctness defect discovered in
// 4A.4A, not a recovery).
//
// THE DEFECT. `todoSession` is a process-level singleton. The write path used to
// read it AFTER an `await`:
//
//     await saveTodos(todoSession.id, ...)   // safe: read before suspension
//     sessionId: todoSession.id              // RACE: another request may have rebound it
//     savePlanSnapshot(todoSession.id, ...)
//     encodeCanonicalAssignments(todoSession.id, assignment)
//
// So request A could bind session A, suspend, and then have request B rebind the
// global - leaving A's TaskStore namespace, A's plan snapshot and A's assignment
// stamp all written under B's session.
//
// THE FIX. One capture at operation entry (`todoOperationContext`), from the
// existing per-request ToolContext, and nothing after an await reads the global.
//
// The central test is C: it reproduces the exact interleaving - start the
// operation, rebind the global while it is suspended, then assert the operation
// still wrote to ITS OWN session. That test fails on 4A.4A and passes here.
//
// SAFETY (Phase 0A discipline): one `mkdtemp(join(tmpdir(), "minicode-sess-"))`
// per test, removed by that exact absolute path. No `readdir(".")`, no pattern
// delete. Nothing is resolved from process.cwd(), and the suite is run with an
// explicit cwd so it can never touch the forensic specimen at D:\git\minicode.

import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { todoReadTool, todoSession, todoWriteTool, todoOperationContext } from "../src/tools/todo.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { decodeCanonicalAssignments } from "../src/task/assignment.ts"
import { applyMcpContext, newMcpContextId } from "../src/mcp/server.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-sess-"))
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

const prov = { origin: "runtime", source: "test" } as const

/** The per-request ctx shape MCP now builds (server.ts) - operation-scoped. */
const opCtx = (sessionId: string, cwd: string) =>
  ({ signal: new AbortController().signal, cwd, sessionId }) as never

/** Seed canonical rows so a mixed payload has an existing task to update. */
const seed = (dir: string, sessionId: string, title: string) => {
  new TaskStore(dir).createTask(sessionId, {
    title,
    status: "PENDING",
    order: 0,
    provenance: prov,
  })
}

const todosDir = (dir: string) => join(dir, ".minicode", "todos")
const todoFiles = async (dir: string) => (await readdir(todosDir(dir)).catch(() => [])).sort()

/** The decisive assertion: exactly this session's file, with exactly its items.
 *  The stored shape is `{ sessionId, updatedAt, todos }`, not a bare array. */
const jsonOf = async (dir: string, file: string) => {
  const raw = JSON.parse(await Bun.file(join(todosDir(dir), file)).text()) as {
    sessionId: string
    todos: Array<{ content: string }>
  }
  // The file must also be stamped with its own session, not a neighbour's.
  return { sessionId: raw.sessionId, contents: raw.todos.map((t) => t.content) }
}

// ---------------------------------------------------------------------------
// C. THE CORE TEST - session stays stable across await
// ---------------------------------------------------------------------------
test("C. rebinding the global mid-flight cannot steal an in-flight operation's session", async () => {
  const dir = await ownedDir()
  const SESSION = "sess-A"
  seed(dir, SESSION, "A")
  todoSession.id = SESSION
  todoSession.cwd = dir

  // Start the operation. It runs synchronously up to its first await inside
  // saveTodos, so the identity is already bound and it is now suspended.
  const inFlight = todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "A", status: "pending" },
        { content: "new-from-A", status: "pending" },
      ],
    } as never,
    opCtx(SESSION, dir),
  )

  // A second request rebinds the process singleton while A is suspended. This is
  // exactly the production interleaving that was broken.
  todoSession.id = "HIJACKED-SESSION"
  todoSession.cwd = dir

  const out = (await inFlight) as string

  // 1. TaskStore rows landed under A, not under the hijacking id.
  const store = new TaskStore(dir)
  expect(store.listTasks(SESSION).map((t) => t.title).sort()).toEqual(["A", "new-from-A"])
  expect(store.listTasks("HIJACKED-SESSION")).toEqual([])
  // 2. The assignment is stamped with A, so the adapter can still decode it.
  const table = decodeCanonicalAssignments(out, { sessionId: SESSION })
  expect(table?.map((a) => a.taskId)).toEqual(["t1", "t2"])
  expect(decodeCanonicalAssignments(out, { sessionId: "HIJACKED-SESSION" })).toBeUndefined()
  // 3. No stray session file was created for the hijacking id.
  expect(await todoFiles(dir)).toEqual(["sess-A.json"])
})

// ---------------------------------------------------------------------------
// A. concurrent writes, different CLI-style sessions
// ---------------------------------------------------------------------------
test("A. two concurrent operations with different sessions stay isolated", async () => {
  const dirA = await ownedDir()
  const dirB = await ownedDir()
  seed(dirA, "cli-A", "A")
  seed(dirB, "cli-B", "B")
  // Composition root binds the global once, as the CLI does.
  todoSession.id = "cli-A"
  todoSession.cwd = dirA

  // Genuinely interleaved: neither is awaited before the other starts.
  const [outA, outB] = await Promise.all([
    todoWriteTool.execute(
      {
        todos: [
          { taskId: "t1", content: "A", status: "pending" },
          { content: "only-A", status: "pending" },
        ],
      } as never,
      opCtx("cli-A", dirA),
    ) as Promise<string>,
    todoWriteTool.execute(
      {
        todos: [
          { taskId: "t1", content: "B", status: "pending" },
          { content: "only-B", status: "pending" },
        ],
      } as never,
      opCtx("cli-B", dirB),
    ) as Promise<string>,
  ])

  // D. JSON isolation: one file per session, each holding only its own item.
  expect(await todoFiles(dirA)).toEqual(["cli-A.json"])
  expect(await todoFiles(dirB)).toEqual(["cli-B.json"])
  const fileA = await jsonOf(dirA, "cli-A.json")
  const fileB = await jsonOf(dirB, "cli-B.json")
  expect(fileA.contents).toEqual(["A", "only-A"])
  expect(fileB.contents).toEqual(["B", "only-B"])
  // Each file is stamped with its OWN session id.
  expect(fileA.sessionId).toBe("cli-A")
  expect(fileB.sessionId).toBe("cli-B")

  // E. TaskStore isolation: the correct session_id reached the store.
  expect(new TaskStore(dirA).listTasks("cli-A").map((t) => t.title).sort()).toEqual(["A", "only-A"])
  expect(new TaskStore(dirA).listTasks("cli-B")).toEqual([])
  expect(new TaskStore(dirB).listTasks("cli-B").map((t) => t.title).sort()).toEqual(["B", "only-B"])
  expect(new TaskStore(dirB).listTasks("cli-A")).toEqual([])

  // F. Assignment isolation: each is bound to its own session and is meaningless
  // in the other's.
  expect(decodeCanonicalAssignments(outA, { sessionId: "cli-A" })?.map((a) => a.taskId)).toEqual([
    "t1",
    "t2",
  ])
  expect(decodeCanonicalAssignments(outB, { sessionId: "cli-B" })?.map((a) => a.taskId)).toEqual([
    "t1",
    "t2",
  ])
  expect(decodeCanonicalAssignments(outA, { sessionId: "cli-B" })).toBeUndefined()
  expect(decodeCanonicalAssignments(outB, { sessionId: "cli-A" })).toBeUndefined()
})

// ---------------------------------------------------------------------------
// B. concurrent MCP contexts
// ---------------------------------------------------------------------------
test("B. two MCP contexts keep their own namespace, and a global swap cannot move them", async () => {
  const dirA = await ownedDir()
  const dirB = await ownedDir()
  const ctxA = newMcpContextId()
  const ctxB = newMcpContextId()
  expect(ctxA).not.toBe(ctxB)
  seed(dirA, ctxA, "A")
  seed(dirB, ctxB, "B")

  // The global is installed by the last applyMcpContext - i.e. it points at B.
  const savedA = applyMcpContext(ctxA, dirA)
  const savedB = applyMcpContext(ctxB, dirB)
  expect(todoSession.id).toBe(ctxB)
  try {
    // Both requests are issued concurrently, each carrying its OWN 4A.3 context
    // on the per-request ctx, exactly as server.ts now does.
    const [outA, outB] = await Promise.all([
      todoWriteTool.execute(
        {
          todos: [
            { taskId: "t1", content: "A", status: "pending" },
            { content: "mcp-A-new", status: "pending" },
          ],
        } as never,
        opCtx(ctxA, dirA),
      ) as Promise<string>,
      todoWriteTool.execute(
        {
          todos: [
            { taskId: "t1", content: "B", status: "pending" },
            { content: "mcp-B-new", status: "pending" },
          ],
        } as never,
        opCtx(ctxB, dirB),
      ) as Promise<string>,
    ])

    // A's work did NOT land in B's namespace even though the global pointed at B.
    expect(new TaskStore(dirA).listTasks(ctxA).map((t) => t.title).sort()).toEqual(["A", "mcp-A-new"])
    expect(new TaskStore(dirA).listTasks(ctxB)).toEqual([])
    expect(new TaskStore(dirB).listTasks(ctxB).map((t) => t.title).sort()).toEqual(["B", "mcp-B-new"])
    expect(new TaskStore(dirB).listTasks(ctxA)).toEqual([])
    // Exactly one JSON file per context, named by its sanitized namespace.
    expect(await todoFiles(dirA)).toHaveLength(1)
    expect(await todoFiles(dirB)).toHaveLength(1)
    expect(decodeCanonicalAssignments(outA, { sessionId: ctxA })).toBeDefined()
    expect(decodeCanonicalAssignments(outA, { sessionId: ctxB })).toBeUndefined()
    expect(decodeCanonicalAssignments(outB, { sessionId: ctxB })).toBeDefined()
    expect(decodeCanonicalAssignments(outB, { sessionId: ctxA })).toBeUndefined()
  } finally {
    todoSession.id = savedB.prevId
    todoSession.cwd = savedB.prevCwd
    void savedA
  }
})

// ---------------------------------------------------------------------------
// D. read path isolation
// ---------------------------------------------------------------------------
test("D. todo_read observes only its own operation's session", async () => {
  const dirA = await ownedDir()
  const dirB = await ownedDir()
  await todoWriteTool.execute(
    { todos: [{ content: "belongs-to-A", status: "pending" }] } as never,
    opCtx("read-A", dirA),
  )
  await todoWriteTool.execute(
    { todos: [{ content: "belongs-to-B", status: "pending" }] } as never,
    opCtx("read-B", dirB),
  )
  // The global points at A while B reads.
  todoSession.id = "read-A"
  todoSession.cwd = dirA
  const seenByB = (await todoReadTool.execute({} as never, opCtx("read-B", dirB))) as string
  expect(seenByB).toContain("belongs-to-B")
  expect(seenByB).not.toContain("belongs-to-A")
})

// ---------------------------------------------------------------------------
// G. a failing operation must not corrupt another
// ---------------------------------------------------------------------------
test("G. a failing operation leaves a concurrent one's session and data intact", async () => {
  const dirA = await ownedDir()
  const dirB = await ownedDir()
  seed(dirA, "f-A", "A")
  seed(dirB, "f-B", "B")

  // A fails: it declares an unknown canonical id, so the whole payload rejects.
  const failing = todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "A", status: "pending" },
        { taskId: "t404", content: "nope", status: "pending" },
      ],
    } as never,
    opCtx("f-A", dirA),
  )
  // B succeeds, concurrently.
  const succeeding = todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "B", status: "pending" },
        { content: "B-new", status: "pending" },
      ],
    } as never,
    opCtx("f-B", dirB),
  ) as Promise<string>

  await expect(failing).rejects.toThrow()
  const outB = await succeeding

  // B is completely unaffected by A's failure: correct namespace, correct data.
  expect(new TaskStore(dirB).listTasks("f-B").map((t) => t.title).sort()).toEqual(["B", "B-new"])
  expect(new TaskStore(dirB).listTasks("f-A")).toEqual([])
  expect(decodeCanonicalAssignments(outB, { sessionId: "f-B" })?.map((a) => a.taskId)).toEqual([
    "t1",
    "t2",
  ])
  // A's transaction rolled back, so no new row exists for it either.
  expect(new TaskStore(dirA).listTasks("f-A").map((t) => t.id)).toEqual(["t1"])
})

// ---------------------------------------------------------------------------
// G2. an ABORTED operation must not disturb a continuing one
// ---------------------------------------------------------------------------
test("G2. an aborted operation does not disturb a continuing one", async () => {
  const dirA = await ownedDir()
  const dirB = await ownedDir()
  seed(dirB, "ab-B", "B")
  const ac = new AbortController()
  ac.abort()
  const aborted = todoWriteTool.execute(
    { todos: [{ content: "never-written", status: "pending" }] } as never,
    { signal: ac.signal, cwd: dirA, sessionId: "ab-A" } as never,
  )
  const continuing = todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "B", status: "pending" },
        { content: "B-new", status: "pending" },
      ],
    } as never,
    opCtx("ab-B", dirB),
  ) as Promise<string>

  await expect(aborted).rejects.toThrow()
  const outB = await continuing
  expect(new TaskStore(dirB).listTasks("ab-B").map((t) => t.title).sort()).toEqual(["B", "B-new"])
  expect(decodeCanonicalAssignments(outB, { sessionId: "ab-B" })).toBeDefined()
  // The aborted operation left no JSON for its session.
  expect(await todoFiles(dirA)).toEqual([])
})

// ---------------------------------------------------------------------------
// H. the write path does not REQUIRE a module-global session
// ---------------------------------------------------------------------------
test("H. with a per-request session the global is never consulted", async () => {
  const dir = await ownedDir()
  // The global is deliberately garbage. If the write path read it at any point,
  // this operation would write into the garbage session.
  todoSession.id = "GLOBAL-SHOULD-NEVER-BE-USED"
  todoSession.cwd = dir

  const out = (await todoWriteTool.execute(
    { todos: [{ content: "from-ctx-only", status: "pending" }] } as never,
    opCtx("ctx-only", dir),
  )) as string

  expect(await todoFiles(dir)).toEqual(["ctx-only.json"])
  expect(new TaskStore(dir).listTasks("ctx-only")).toEqual([])
  expect(new TaskStore(dir).listTasks("GLOBAL-SHOULD-NEVER-BE-USED")).toEqual([])
  // No assignment at all here (all-id-less legacy), and no session leak in text.
  expect(decodeCanonicalAssignments(out, { sessionId: "ctx-only" })).toBeUndefined()
})

test("H2. the operation context is an immutable snapshot, and prefers ctx over the global", () => {
  todoSession.id = "global-session"
  todoSession.cwd = "/global/cwd"
  // ctx wins.
  expect(todoOperationContext({ sessionId: "ctx-session", cwd: "/ctx/cwd" })).toEqual({
    sessionId: "ctx-session",
    cwd: "/ctx/cwd",
  })
  // No sessionId on ctx -> composition-root default, still captured now.
  expect(todoOperationContext({ cwd: "/ctx/cwd" })).toEqual({
    sessionId: "global-session",
    cwd: "/ctx/cwd",
  })
  // An empty string is not a usable session identity; it must not be accepted.
  expect(todoOperationContext({ sessionId: "", cwd: "/ctx/cwd" }).sessionId).toBe("global-session")
  // The returned object is a fresh value: mutating it cannot affect the global.
  const snap = todoOperationContext({ sessionId: "ctx-session", cwd: "/ctx/cwd" })
  snap.sessionId = "tampered"
  expect(todoSession.id).toBe("global-session")
})

// ---------------------------------------------------------------------------
// I. existing single-operation behaviour is unchanged
// ---------------------------------------------------------------------------
test("I. the composition-root global still drives a normal single operation", async () => {
  const dir = await ownedDir()
  // Exactly the pre-4A.4B CLI shape: no sessionId on ctx, global set at startup.
  todoSession.id = "legacy-style-session"
  todoSession.cwd = dir
  seed(dir, "legacy-style-session", "A")

  const out = (await todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "A", status: "pending" },
        { content: "C", status: "pending" },
      ],
    } as never,
    { signal: new AbortController().signal, cwd: dir } as never,
  )) as string

  expect(await todoFiles(dir)).toEqual(["legacy-style-session.json"])
  expect(new TaskStore(dir).listTasks("legacy-style-session").map((t) => t.title).sort()).toEqual([
    "A",
    "C",
  ])
  // The 4A.4A assignment contract is intact through this path too.
  expect(decodeCanonicalAssignments(out, { sessionId: "legacy-style-session" })?.map((a) => a.taskId)).toEqual(["t1", "t2"])
})

// ---------------------------------------------------------------------------
// K. the MCP SERVER actually threads its namespace onto the request ctx
// ---------------------------------------------------------------------------
// Test B drives the tool directly, which proves the tool HONOURS a per-request
// session but not that the server PUTS one there. Mutation M4 (MCP threading the
// journal key "mcp-server" instead of the 4A.3 namespace) survived until this
// test existed, so this drives the real server over stdio and checks where the
// bytes actually land.
test("K. a todo_write through the real MCP server lands in its per-instance namespace", async () => {
  const dir = await ownedDir()
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
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n")
    for (;;) {
      const m = await next()
      if (m.id === id) return m
    }
  }
  try {
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

    // An all-id-less payload keeps this test focused on the SESSION, not on
    // canonical sync: where does the JSON land, and under whose name?
    const w = (await call(7, "todo_write", {
      todos: [{ content: "through-the-real-server", status: "pending" }],
    })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }
    expect(w.result?.isError ?? false).toBe(false)

    const files = await todoFiles(dir)
    // Exactly one file, named by a per-instance 4A.3 namespace - NOT the shared
    // journal literal, and not anything derived from the JSON-RPC id.
    expect(files).toHaveLength(1)
    expect(files[0]).not.toBe("mcp-server.json")
    const written = await jsonOf(dir, files[0]!)
    // The durable id keeps its `mcp:` prefix and is a real uuid.
    expect(written.sessionId).toMatch(/^mcp:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // The filename is that same id with the sanitized mapping (`:` -> `-`).
    expect(files[0]).toBe(written.sessionId.replace(/:/g, "-") + ".json")
    expect(written.contents).toEqual(["through-the-real-server"])
  } finally {
    proc.kill()
    await proc.exited
  }
}, 30000)
