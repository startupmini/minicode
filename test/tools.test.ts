import { expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { createPermissionHandler } from "../src/policy/permission.ts"
import { editTool } from "../src/tools/edit.ts"
import { globTool } from "../src/tools/glob.ts"
import { grepTool } from "../src/tools/grep.ts"
import { readFileTool } from "../src/tools/read_file.ts"
import { writeFileTool } from "../src/tools/write_file.ts"

const tmp = ".tmp-tools-test"

test("write_file + read_file + edit", async () => {
  await mkdir(tmp, { recursive: true })
  const p = `${tmp}/a.txt`
  const ctx: any = { signal: new AbortController().signal }
  await writeFileTool.execute({ path: p, content: "hello world" }, ctx)
  // read_file kini memberi nomor baris (`1: `) supaya model bisa merujuk baris.
  const r = (await readFileTool.execute({ path: p }, ctx)) as string
  expect(r).toBe("1: hello world")
  await editTool.execute({ path: p, oldString: "world", newString: "minicode" }, ctx)
  const r2 = (await readFileTool.execute({ path: p }, ctx)) as string
  expect(r2).toBe("1: hello minicode")
  await rm(tmp, { recursive: true, force: true })
})

test("edit fails on multiple matches", async () => {
  await mkdir(tmp, { recursive: true })
  const p = `${tmp}/b.txt`
  const ctx: any = { signal: new AbortController().signal }
  await writeFile(p, "a a a")
  try {
    await editTool.execute({ path: p, oldString: "a", newString: "b" }, ctx)
    expect(false).toBe(true)
  } catch (e) {
    expect(String((e as Error).message)).toContain("multiple times")
  }
  await rm(tmp, { recursive: true, force: true })
})

test("glob finds files", async () => {
  await mkdir(`${tmp}/sub`, { recursive: true })
  await writeFile(`${tmp}/sub/x.ts`, "hi")
  await writeFile(`${tmp}/sub/y.js`, "hi")
  const ctx: any = { signal: new AbortController().signal }
  const out = (await globTool.execute({ pattern: "**/*.ts", cwd: tmp }, ctx)) as string
  expect(out).toContain("x.ts")
  const outBrace = (await globTool.execute({ pattern: "sub/{*.ts,*.js}", cwd: tmp }, ctx)) as string
  expect(outBrace).toContain("sub/x.ts")
  expect(outBrace).toContain("sub/y.js")
  await rm(tmp, { recursive: true, force: true })
})

test("grep finds regex", async () => {
  await mkdir(tmp, { recursive: true })
  await writeFile(`${tmp}/f.txt`, "hello\nworld\nhello world")
  const ctx: any = { signal: new AbortController().signal }
  const out = (await grepTool.execute({ pattern: "hello", cwd: tmp }, ctx)) as string
  expect(out.split("\n").length).toBe(2)
  await rm(tmp, { recursive: true, force: true })
})

test("permission auto", async () => {
  const h = createPermissionHandler({ mode: "auto", root: process.cwd() })
  expect(
    await h.check(
      { id: "1", name: "read_file", args: { path: "src/tools/read_file.ts" } } as any,
      {} as any,
    ),
  ).toBe("allow")
  expect(
    await h.check({ id: "1", name: "bash", args: { cmd: "rm -rf /" } } as any, {} as any),
  ).toBe("deny")
  expect(await h.check({ id: "1", name: "bash", args: { cmd: "echo hi" } } as any, {} as any)).toBe(
    "allow",
  )
  expect(
    await h.check(
      { id: "1", name: "write_file", args: { path: "../outside.txt", content: "x" } } as any,
      {} as any,
    ),
  ).toBe("deny")
})

test("permission readonly", async () => {
  const h = createPermissionHandler({ mode: "readonly" })
  expect(await h.check({ id: "1", name: "read_file", args: { path: "a" } } as any, {} as any)).toBe(
    "allow",
  )
  expect(await h.check({ id: "1", name: "bash", args: { cmd: "echo hi" } } as any, {} as any)).toBe(
    "deny",
  )
})
