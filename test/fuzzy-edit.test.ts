import { expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { editTool, flexibleMatch } from "../src/tools/edit.ts"

test("fuzzy-match: matches exact and trimmed trailing whitespace", () => {
  const content = "function hello() {  \n    return 42;  \n}"
  const needle = "function hello() {\n    return 42;\n}"

  const match = flexibleMatch(content, needle)
  expect(match).not.toBeNull()
  expect(match?.mode).toBe("trimmed")
})

test("fuzzy-match: matches lines with different indentation", () => {
  const content = "class Service {\n    constructor() {\n        this.init();\n    }\n}"
  const needle = "constructor() {\n  this.init();\n}"

  const match = flexibleMatch(content, needle)
  expect(match).not.toBeNull()
  expect(match?.mode).toBe("fuzzy")
})

test("fuzzy-edit: editTool replaces fuzzy matched content", async () => {
  const tmp = ".tmp-fuzzy-test"
  await mkdir(tmp, { recursive: true })
  const testFile = `${tmp}/code.ts`

  await writeFile(testFile, "function test() {  \n    const a = 1;  \n    return a;  \n}", "utf8")

  // Edit with clean unpadded needle
  await editTool.execute(
    {
      path: testFile,
      oldString: "const a = 1;\nreturn a;",
      newString: "const a = 2;\nreturn a * 2;",
    },
    { signal: new AbortController().signal, cwd: process.cwd() } as never,
  )

  const updated = await readFile(testFile, "utf8")
  expect(updated).toContain("const a = 2;")
  expect(updated).toContain("return a * 2;")

  await rm(tmp, { recursive: true, force: true })
})
