// P13 P1 plan artifact: tiap todo_write meninggalkan snapshot markdown di
// .minicode/plans/<id>.md agar resume lintas sesi tak perlu memutar ulang todo.

import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadPlan, renderPlan, todoSession, todoWriteTool } from "../src/tools/todo.ts"

const mkctx = (cwd: string) => ({ signal: new AbortController().signal, cwd }) as never

test("renderPlan: checkbox + progress + status", () => {
  const md = renderPlan("s1", [
    { content: "tulis kode", status: "completed" },
    { content: "jalankan test", status: "in_progress" },
    { content: "rapikan", status: "pending" },
  ])
  expect(md).toContain("# Plan — s1")
  expect(md).toContain("1/3 completed")
  expect(md).toContain("- [x] tulis kode (completed)")
  expect(md).toContain("- [~] jalankan test (in_progress)")
  expect(md).toContain("- [ ] rapikan (pending)")
})

test("todo_write: menulis plans/<id>.md yang bisa dibaca balik", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-plan-"))
  const prevId = todoSession.id
  const prevCwd = todoSession.cwd
  todoSession.id = "plan-test"
  todoSession.cwd = dir
  try {
    const out = (await todoWriteTool.execute(
      {
        todos: [
          { content: "langkah satu", status: "completed" },
          { content: "langkah dua", status: "pending" },
        ],
      },
      mkctx(dir),
    )) as string
    expect(out).toContain("1/2")
    const md = await loadPlan("plan-test", dir)
    expect(md).toContain("# Plan — plan-test")
    expect(md).toContain("langkah dua")
    // id disanitasi sama seperti todos
    expect(await loadPlan("hilang", dir)).toBeNull()
  } finally {
    todoSession.id = prevId
    todoSession.cwd = prevCwd
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
