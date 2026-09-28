// Phase 2 regression protection: canonical task ADDRESSING.
//
// SCOPE. "Addressing" in this phase means CANONICAL ADDRESSING of a session's
// durable todo/plan state: one canonical filename derived from the session id
// via `sanitizeSessionPart`, with an explicit LEGACY filename kept for
// read-only fallback. That is exactly what the N2 delta in `todo.orig.ts`
// contains.
//
// WHAT IS DELIBERATELY NOT HERE. taskId / ordinal / duplicate-address /
// mixed-payload resolution is PHASE 3. `todo.orig.ts` has zero occurrences of
// `taskId`, `ordinal`, or `address`, and its `TodoItem` is
// `{ content, status, blockedReason? }` with no id field. The resolution layer
// lived in the lost `normalize.ts` + `synchronizeTasks`. Inventing it here
// would be fabrication, so those categories are recorded as DEFERRED in
// PHASE-2-ADDRESSING-DELTA-MAP.md instead of being faked with a passing test.
//
// SAFETY (Phase 0A discipline): every test owns exactly one
// `mkdtemp(join(tmpdir(), "minicode-addr-"))` directory and removes only that
// absolute path. No `readdir(".")`, no cwd-based cleanup, no pattern deletes.

import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  deleteTodoFiles,
  loadPlan,
  loadTodos,
  savePlanSnapshot,
  saveTodos,
} from "../src/tools/todo.ts"

const owned: string[] = []

async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-addr-"))
  owned.push(dir)
  return dir
}

afterEach(async () => {
  while (owned.length) {
    const dir = owned.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

function todosDir(cwd: string): string {
  return join(cwd, ".minicode", "todos")
}
function plansDir(cwd: string): string {
  return join(cwd, ".minicode", "plans")
}
/** Write a todo file at an EXACT filename, bypassing the addressing layer. */
function plant(cwd: string, name: string, content: string): void {
  mkdirSync(todosDir(cwd), { recursive: true })
  writeFileSync(join(todosDir(cwd), name), content, "utf8")
}
const payload = (title: string) =>
  JSON.stringify({ sessionId: "s", todos: [{ content: title, status: "pending" }] })

// A. explicit address — the canonical filename is the write target
test("A. writes always land on the canonical address", async () => {
  const dir = await ownedDir()
  await saveTodos("plain-session", [{ content: "tugas", status: "pending" }], dir)
  expect(existsSync(join(todosDir(dir), "plain-session.json"))).toBe(true)
  // and the plan snapshot uses the same canonical stem
  await savePlanSnapshot("plain-session", [{ content: "tugas", status: "pending" }], dir)
  expect(existsSync(join(plansDir(dir), "plain-session.md"))).toBe(true)
  expect(await loadTodos("plain-session", dir)).toEqual([{ content: "tugas", status: "pending" }])

  // An id whose canonical and legacy stems DIFFER, so the write target is
  // actually observable. A plain id like "plain-session" sanitises to the same
  // stem under both mappings and therefore cannot tell them apart.
  const dir2 = await ownedDir()
  await saveTodos("a/b", [{ content: "tugas", status: "pending" }], dir2)
  await savePlanSnapshot("a/b", [{ content: "tugas", status: "pending" }], dir2)
  expect(existsSync(join(todosDir(dir2), "a-b.json"))).toBe(true)
  expect(existsSync(join(todosDir(dir2), "a_b.json"))).toBe(false)
  expect(existsSync(join(plansDir(dir2), "a-b.md"))).toBe(true)
  expect(existsSync(join(plansDir(dir2), "a_b.md"))).toBe(false)
})

// B. legacy address — the pre-N2 filename is still readable
test("B. a legacy-named file is still readable (compatibility window)", async () => {
  const dir = await ownedDir()
  // `a/b` was `a_b.json` before N2 and is `a-b.json` after it. A workspace
  // upgraded but never rewritten still only has the old file.
  plant(dir, "a_b.json", payload("dari file legacy"))
  const got = await loadTodos("a/b", dir)
  expect(got).toEqual([{ content: "dari file legacy", status: "pending" }])
})

// C. mixed addressing — canonical wins; legacy is only a fallback
test("C. canonical takes precedence when both addresses exist", async () => {
  // "du/al" addresses canonically as du-al.json and legacy as du_al.json
  const dir = await ownedDir()
  plant(dir, "du-al.json", payload("dari alamat kanonik"))
  plant(dir, "du_al.json", payload("dari alamat legacy"))
  expect(await loadTodos("du/al", dir)).toEqual([
    { content: "dari alamat kanonik", status: "pending" },
  ])

  // ...and when the canonical file is missing, legacy answers instead
  const dir2 = await ownedDir()
  plant(dir2, "du_al.json", payload("hanya legacy"))
  expect(await loadTodos("du/al", dir2)).toEqual([
    { content: "hanya legacy", status: "pending" },
  ])
})

// D. duplicate address — DEFERRED to Phase 3 (no taskId in evidence). The
// Phase 2 consequence that IS evidenced: a corrupt canonical file must not
// silently mask a readable legacy one.
test("D. a corrupt canonical file falls through to a readable legacy file", async () => {
  const dir = await ownedDir()
  plant(dir, "x-y.json", "{bukan json")
  plant(dir, "x_y.json", payload("legacy tersembunyi"))
  expect(await loadTodos("x/y", dir)).toEqual([
    { content: "legacy tersembunyi", status: "pending" },
  ])
  // with neither readable, the result is an empty list, never a throw
  const dir2 = await ownedDir()
  plant(dir2, "x-y.json", "{bukan json")
  plant(dir2, "x_y.json", "{juga rusak")
  expect(await loadTodos("x/y", dir2)).toEqual([])

  // a VALID-JSON canonical file with the wrong shape must also fall through
  // rather than masquerade as an empty task list and mask the legacy file
  const dir3 = await ownedDir()
  plant(dir3, "w-y.json", JSON.stringify({ sessionId: "w/y", todos: "bukan array" }))
  plant(dir3, "w_y.json", payload("legacy tersembunyi 2"))
  expect(await loadTodos("w/y", dir3)).toEqual([
    { content: "legacy tersembunyi 2", status: "pending" },
  ])
})

// E. invalid address — traversal cannot escape the project .minicode tree
test("E. hostile session ids stay inside .minicode/todos", async () => {
  const dir = await ownedDir()
  for (const hostile of ["../../../etc", "..", "", "....//....", "a/b/c"]) {
    await saveTodos(hostile, [{ content: "x", status: "pending" }], dir)
  }
  // everything landed as a flat sanitised name, nothing escaped
  const names = readdirSync(todosDir(dir))
  expect(names.length).toBeGreaterThan(0)
  for (const n of names) {
    expect(n).not.toContain("..")
    expect(n).not.toContain("/")
    expect(n.endsWith(".json")).toBe(true)
  }
  // and nothing was created outside the owned tree
  expect(existsSync(resolve(dir, "..", "..", "etc.json"))).toBe(false)
  expect(existsSync(join(dir, "etc.json"))).toBe(false)
  // empty id is not the old "default" fallback any more: canonical maps it to "x"
  expect(existsSync(join(todosDir(dir), "x.json"))).toBe(true)
})

// F. invalid legacy address — legacy stem never used for writes
test("F. a legacy-only address is never written to", async () => {
  const dir = await ownedDir()
  await saveTodos("z/w", [{ content: "tugas", status: "pending" }], dir)
  expect(existsSync(join(todosDir(dir), "z-w.json"))).toBe(true)
  // the pre-N2 underscore file must not be created by a write
  expect(existsSync(join(todosDir(dir), "z_w.json"))).toBe(false)
})

// G. resolve-before-mutate — the read path picks an address; the write path has one
test("G. reading never creates a file, and writing only touches canonical", async () => {
  const dir = await ownedDir()
  expect(await loadTodos("belum-ada", dir)).toEqual([])
  // a read of a missing session must not have created the directory or a file
  expect(existsSync(todosDir(dir))).toBe(false)
  await saveTodos("baru", [{ content: "a", status: "pending" }], dir)
  expect(readdirSync(todosDir(dir))).toEqual(["baru.json"])
})

// H. deterministic ordering/addressing — same id, same address, always
test("H. addressing is deterministic and repeatable", async () => {
  const dir = await ownedDir()
  await saveTodos("det/kunci", [{ content: "satu", status: "pending" }], dir)
  const first = readdirSync(todosDir(dir))
  await saveTodos("det/kunci", [{ content: "dua", status: "pending" }], dir)
  // same address every time; content updated in place, no second file
  expect(readdirSync(todosDir(dir))).toEqual(first)
  expect((await loadTodos("det/kunci", dir))[0]?.content).toBe("dua")
})

// I. restart compatibility — legacy state is still reachable by a fresh load
test("I. legacy state survives a fresh process-style read", async () => {
  const dir = await ownedDir()
  plant(dir, "restart_me.json", payload("bertahan"))
  // simulate a restart: nothing cached, paths recomputed from scratch
  const first = await loadTodos("restart/me", dir)
  const second = await loadTodos("restart/me", dir)
  expect(first).toEqual(second)
  expect(first).toEqual([{ content: "bertahan", status: "pending" }])
})

// J. session isolation — distinct ids address distinct files
test("J. distinct sessions address distinct files and never cross-read", async () => {
  const dir = await ownedDir()
  await saveTodos("satu", [{ content: "milik satu", status: "pending" }], dir)
  await saveTodos("dua", [{ content: "milik dua", status: "pending" }], dir)
  expect((await loadTodos("satu", dir))[0]?.content).toBe("milik satu")
  expect((await loadTodos("dua", dir))[0]?.content).toBe("milik dua")
  expect(readdirSync(todosDir(dir)).sort()).toEqual(["dua.json", "satu.json"])
})

// session deletion must clear BOTH addresses, or plan content survives as
// reachable residual after the session is gone (Audit #13 chain 28)
test("deleteTodoFiles removes both the canonical and the legacy address", async () => {
  const dir = await ownedDir()
  await saveTodos("hapus/saya", [{ content: "rahasia", status: "pending" }], dir)
  await savePlanSnapshot("hapus/saya", [{ content: "rahasia", status: "pending" }], dir)
  // plant the legacy pair too, as an un-upgraded workspace would still have
  plant(dir, "hapus_saya.json", payload("rahasia legacy"))
  mkdirSync(plansDir(dir), { recursive: true })
  writeFileSync(join(plansDir(dir), "hapus_saya.md"), "rencana legacy", "utf8")
  expect(existsSync(join(todosDir(dir), "hapus_saya.json"))).toBe(true)

  await deleteTodoFiles("hapus/saya", dir)

  expect(existsSync(join(todosDir(dir), "hapus-saya.json"))).toBe(false)
  expect(existsSync(join(todosDir(dir), "hapus_saya.json"))).toBe(false)
  expect(existsSync(join(plansDir(dir), "hapus-saya.md"))).toBe(false)
  expect(existsSync(join(plansDir(dir), "hapus_saya.md"))).toBe(false)
  expect(await loadTodos("hapus/saya", dir)).toEqual([])
})

test("loadPlan stays passive: a missing plan is null, not a throw", async () => {
  const dir = await ownedDir()
  expect(await loadPlan("tidak-ada", dir)).toBeNull()
  await savePlanSnapshot("ada", [{ content: "c", status: "pending" }], dir)
  expect(await loadPlan("ada", dir)).toContain("# Plan")
})
