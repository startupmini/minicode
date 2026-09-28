// Phase 4A.1 regression protection: PROTOCOL IDENTITY (taskId in / taskId out).
//
// SCOPE. This phase makes canonical task identity REPRESENTABLE on the tool
// protocol, and nothing more. The protocol transports an id that already exists;
// it never mints, derives, renumbers, rewrites or infers one.
//
// DELIBERATELY NOT IN SCOPE, and not implemented here:
//   - TaskStore production wiring, synchronization, bootstrap/adoption
//   - rejection of all-id-less payloads (a later semantic phase)
//   - the transaction API, MCP naming, deletion semantics
//   - TaskGraph, Scheduler, plan-pipeline changes, execution-loop changes
//
// Because the tool schema in this repo is DECLARATIVE (there is no runtime
// schema validator), schema-shape tests assert the schema object itself, while
// value validation is asserted through `normalizeTodos`, which is the single
// runtime choke point on both the write and the read path.
//
// SAFETY (Phase 0A discipline): one `mkdtemp(join(tmpdir(), "minicode-p4a-"))`
// directory per test, removed by that exact absolute path. No `readdir(".")`, no
// pattern delete, no cwd-based cleanup.

import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadTodos,
  normalizeTodos,
  renderTodos,
  saveTodos,
  todoReadTool,
  todoSession,
  todoWriteTool,
} from "../src/tools/todo.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-p4a-"))
  owned.push(dir)
  return dir
}

const mkctx = () => ({ signal: new AbortController().signal }) as never

let prevId = todoSession.id
let prevCwd = todoSession.cwd
afterEach(async () => {
  todoSession.id = prevId
  todoSession.cwd = prevCwd
  while (owned.length) {
    const dir = owned.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── A / G: the declared schema ───────────────────────────────────────────────

test("A. schema accepts an optional taskId, and keeps required + additionalProperties intact", () => {
  const params = todoWriteTool.parameters as {
    properties: { todos: { items: { properties: Record<string, unknown> } } }
    required: string[]
    additionalProperties: boolean
  }
  const item = params.properties.todos.items
  // the one new property
  expect(Object.keys(item.properties)).toContain("taskId")
  // existing properties unchanged
  expect(Object.keys(item.properties).sort()).toEqual(["content", "status", "taskId"])
  // NOT made required - backward compatibility
  expect(params.properties.todos.items.properties.taskId).toBeDefined()
  expect(JSON.stringify(params.required)).toContain("todos")
  // still closed to arbitrary properties, so taskId is the ONLY new accepted key
  expect((params.properties.todos.items as unknown as { additionalProperties: boolean }).additionalProperties).toBe(false)
  expect(params.additionalProperties).toBe(false)
})

test("A2. taskId is optional at the item level (required is still content+status only)", () => {
  const item = (todoWriteTool.parameters as unknown as {
    properties: { todos: { items: { required: string[]; additionalProperties: boolean } } }
  }).properties.todos.items
  expect(item.required).toEqual(["content", "status"])
  expect(item.additionalProperties).toBe(false)
})

// ── B: value validation uses the canonical guard ─────────────────────────────

test("B. malformed taskId is rejected; valid canonical ids are accepted", () => {
  // valid
  for (const id of ["t1", "t2", "t42"]) {
    const out = normalizeTodos([{ taskId: id, content: "x", status: "pending" }], {
      verdict: "unverified",
    })
    expect(out[0]?.taskId).toBe(id)
  }
  // invalid - rejected by the canonical guard, not a local regex
  for (const bad of ["", "t0", "t01", "T1", "foo", "t-1", 1 as unknown as string]) {
    expect(() =>
      normalizeTodos([{ taskId: bad, content: "x", status: "pending" }], { verdict: "unverified" }),
    ).toThrow()
  }
})

// ── C: backward compatibility ────────────────────────────────────────────────

test("C. legacy id-less payloads still pass unchanged", () => {
  const out = normalizeTodos(
    [
      { content: "satu", status: "pending" },
      { content: "dua", status: "in_progress" },
      { content: "tiga", status: "completed" },
    ],
    { verdict: "unverified" },
  )
  expect(out).toHaveLength(3)
  expect(out.map((t) => t.content)).toEqual(["satu", "dua", "tiga"])
  // no id invented
  expect(out.every((t) => t.taskId === undefined)).toBe(true)
})

// ── D: normalization preserves taskId ────────────────────────────────────────

test("D. taskId survives normalization, alongside blockedReason", () => {
  const out = normalizeTodos(
    [{ taskId: "t7", content: "dengan alasan", status: "blocked", blockedReason: "menunggu" }],
    { verdict: "unverified" },
  )
  expect(out[0]?.taskId).toBe("t7")
  expect(out[0]?.blockedReason).toBe("menunggu")
  // and is absent (not empty-string, not null) when not supplied
  const bare = normalizeTodos([{ content: "b", status: "pending" }], { verdict: "unverified" })
  expect("taskId" in bare[0]!).toBe(false)
})

// ── E: todo_read exposes taskId ──────────────────────────────────────────────

test("E. todo_read exposes the taskId it was given", async () => {
  const dir = await ownedDir()
  todoSession.id = "p4a-read"
  todoSession.cwd = dir
  await saveTodos(
    "p4a-read",
    [
      { content: "First task", status: "pending", taskId: "t1" },
      { content: "Second task", status: "pending", taskId: "t2" },
    ],
    dir,
  )
  const out = (await todoReadTool.execute({}, mkctx())) as string
  expect(out).toContain("t1")
  expect(out).toContain("First task")
  expect(out).toContain("t2")
  expect(out).toContain("Second task")
  // identity precedes the content on the same line
  expect(out).toMatch(/\[\s\] t1 . First task/)
})

test("E2. an id-less item renders exactly as before (no synthesised id)", () => {
  const out = renderTodos([
    { content: "legacy item", status: "pending" },
    { content: "identified", status: "pending", taskId: "t5" },
  ])
  const legacyLine = out.split("\n").find((l) => l.includes("legacy item"))!
  expect(legacyLine).not.toMatch(/t\d+/)
  expect(legacyLine.trim()).toBe("[ ] legacy item")
  const idLine = out.split("\n").find((l) => l.includes("identified"))!
  expect(idLine).toContain("t5")
})

// ── F: round-trip preserves the exact value ──────────────────────────────────

test("F. round-trip preserves the exact taskId through write and read", async () => {
  const dir = await ownedDir()
  todoSession.id = "p4a-roundtrip"
  todoSession.cwd = dir
  const input = { taskId: "t7", content: "Implement parser", status: "pending" as const }
  await saveTodos("p4a-roundtrip", [input], dir)
  const [read] = await loadTodos("p4a-roundtrip", dir)
  expect(read?.taskId).toBe("t7")
  expect(read?.content).toBe("Implement parser")
  // not regenerated, not renumbered
  expect(read?.taskId).toBe(input.taskId)
})

test("F2. taskId written through the todo_write tool itself round-trips", async () => {
  const dir = await ownedDir()
  todoSession.id = "p4a-tool"
  todoSession.cwd = dir
  // Phase 4A.4: `todo_write` now ALSO synchronizes canonical identity, and a
  // taskId that no TaskStore row backs is correctly rejected as TASK_NOT_FOUND.
  // This test is about the PROTOCOL round-trip, so the id is seeded first; the
  // rejection behaviour is covered in test/phase4a4-production-sync.test.ts.
  const store = new TaskStore(dir)
  const prov = { origin: "runtime", source: "test" } as const
  for (let i = 0; i < 3; i++) {
    store.createTask("p4a-tool", {
      title: `seed-${i}`,
      status: "PENDING",
      order: i,
      provenance: prov,
    })
  }
  expect(store.getTask("p4a-tool", "t3")).not.toBeNull()

  await todoWriteTool.execute(
    { todos: [{ taskId: "t3", content: "lewat tool", status: "completed" }] },
    mkctx(),
  )
  const [read] = await loadTodos("p4a-tool", dir)
  expect(read?.taskId).toBe("t3")
  expect(read?.status).toBe("completed")
})

// ── G: arbitrary unknown properties are still not carried ────────────────────

test("G. unknown identity-like properties are still dropped, not carried", () => {
  const out = normalizeTodos(
    [{ content: "x", status: "pending", id: "t9", stepId: "3", task_id: "t8", foo: "bar" }],
    { verdict: "unverified" },
  )
  const item = out[0] as unknown as Record<string, unknown>
  expect(item.taskId).toBeUndefined()
  expect(item.id).toBeUndefined()
  expect(item.stepId).toBeUndefined()
  expect(item.task_id).toBeUndefined()
  expect(item.foo).toBeUndefined()
  expect(Object.keys(item).sort()).toEqual(["content", "status"])
})

// ── H: the protocol layer never allocates ────────────────────────────────────

test("H. no id is allocated when taskId is absent, across repeated normalization", () => {
  for (let i = 0; i < 3; i++) {
    const out = normalizeTodos(
      [{ content: "no id here", status: "pending" }, { content: "nor here", status: "pending" }],
      { verdict: "unverified" },
    )
    for (const t of out) expect(t.taskId).toBeUndefined()
    expect(JSON.stringify(out)).not.toMatch(/"t\d+"/)
  }
})

// ── I: a supplied id is never rewritten ──────────────────────────────────────

test("I. a supplied taskId is passed through byte-for-byte", () => {
  // no trimming, no case folding, no renumbering, no padding
  for (const id of ["t1", "t42", "t999999"]) {
    const out = normalizeTodos([{ taskId: id, content: "x", status: "pending" }], {
      verdict: "unverified",
    })
    expect(out[0]?.taskId).toBe(id)
    expect(out[0]?.taskId).toHaveLength(id.length)
  }
  // a larger id is not re-sequenced to the next free slot
  const out = normalizeTodos([{ taskId: "t100", content: "x", status: "pending" }], {
    verdict: "unverified",
  })
  expect(out[0]?.taskId).toBe("t100")
})
