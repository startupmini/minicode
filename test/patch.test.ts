import { expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { applyPatchTool } from "../src/tools/patch.ts"

const tmp = ".tmp-patch-test"
const ctx: any = { signal: new AbortController().signal, cwd: process.cwd() }

test("apply_patch: replaces single block", async () => {
  await mkdir(tmp, { recursive: true })
  await writeFile(`${tmp}/a.ts`, "const x = 1;\nconsole.log(x);\n")
  const out = await applyPatchTool.execute(
    {
      path: `${tmp}/a.ts`,
      patches: [
        { search: "const x = 1;\nconsole.log(x);", replace: "const x = 2;\nconsole.log(x * 2);" },
      ],
    },
    ctx,
  )
  expect(String(out)).toContain("applied 1 patch")
  const after = await readFile(`${tmp}/a.ts`, "utf8")
  expect(after).toContain("const x = 2;")
  expect(after).toContain("console.log(x * 2);")
  await rm(tmp, { recursive: true, force: true })
})

test("apply_patch: multiple patches", async () => {
  await mkdir(tmp, { recursive: true })
  await writeFile(`${tmp}/b.ts`, "function a() { return 1; }\nfunction b() { return 2; }\n")
  const out = await applyPatchTool.execute(
    {
      path: `${tmp}/b.ts`,
      patches: [
        { search: "function a() { return 1; }", replace: "function a() { return 10; }" },
        { search: "function b() { return 2; }", replace: "function b() { return 20; }" },
      ],
    },
    ctx,
  )
  expect(String(out)).toContain("applied 2 patch(es)")
  const after = await readFile(`${tmp}/b.ts`, "utf8")
  expect(after).toContain("return 10")
  expect(after).toContain("return 20")
  await rm(tmp, { recursive: true, force: true })
})

test("apply_patch: error when search not found", async () => {
  await mkdir(tmp, { recursive: true })
  await writeFile(`${tmp}/c.ts`, "const a = 1;\n")
  await expect(
    applyPatchTool.execute(
      { path: `${tmp}/c.ts`, patches: [{ search: "nonexistent", replace: "x" }] },
      ctx,
    ),
  ).rejects.toThrow(/not found/)
  await rm(tmp, { recursive: true, force: true })
})

test("apply_patch: fuzzy match (CRLF)", async () => {
  await mkdir(tmp, { recursive: true })
  await writeFile(`${tmp}/d.ts`, "line1\r\nline2\r\nline3\r\n")
  const out = await applyPatchTool.execute(
    { path: `${tmp}/d.ts`, patches: [{ search: "line1\nline2", replace: "A\nB" }] },
    ctx,
  )
  expect(String(out)).toContain("crlf match")
  const after = await readFile(`${tmp}/d.ts`, "utf8")
  expect(after).toBe("A\nB\r\nline3\r\n")
  await rm(tmp, { recursive: true, force: true })
})
