import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRepoMap, extractSymbols, loadRepoMap } from "../src/repo/repomap.ts"

test("extractSymbols: TypeScript function/class/interface/const", () => {
  const content = `export function foo(a: string) {}\nexport class Bar {}\nexport interface Baz {}\nexport const version = 1;\nfunction helper() {}\n`
  const symbols = extractSymbols(content, "ts")
  expect(symbols).toContain("function foo(...)")
  expect(symbols).toContain("class Bar")
  expect(symbols).toContain("interface Baz")
  expect(symbols).toContain("const version")
  expect(symbols).toContain("function helper(...)")
})

test("extractSymbols: Python def/class", () => {
  const content = `import os\n\ndef process(data):\n    pass\n\nclass Service:\n    def run(self):\n        pass\n`
  const symbols = extractSymbols(content, "py")
  expect(symbols).toContain("def process(...)")
  expect(symbols).toContain("class Service")
})

test("extractSymbols: Rust fn/struct", () => {
  const content = `pub fn main() {}\npub struct Config {}\nfn private() {}\n`
  const symbols = extractSymbols(content, "rs")
  expect(symbols).toContain("fn main(...)")
  expect(symbols).toContain("struct Config")
})

test("extractSymbols: ignores comments and unknown lang", () => {
  expect(extractSymbols("// comment\nfunction x() {}", "ts")).toContain("function x(...)")
  expect(extractSymbols("anything", "unknown")).toEqual([])
})

test("buildRepoMap: walks temp dir and lists symbols", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-repomap-"))
  await mkdir(join(dir, "src"), { recursive: true })
  await writeFile(
    join(dir, "src", "a.ts"),
    "export function foo() {}\nexport class Bar {}\n",
    "utf8",
  )
  await writeFile(join(dir, "README.md"), "not source", "utf8")
  const map = await buildRepoMap(dir)
  expect(map).toContain("src/a.ts")
  expect(map).toContain("function foo(...)")
  expect(map).toContain("class Bar")
  await rm(dir, { recursive: true, force: true })
})

test("loadRepoMap: caches to .minicode/repomap.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-repomap-"))
  await writeFile(join(dir, "b.ts"), "export const x = 1;\n", "utf8")
  const first = await loadRepoMap(dir)
  const second = await loadRepoMap(dir)
  expect(first).toBe(second)
  expect(first).toContain("b.ts")
  await rm(dir, { recursive: true, force: true })
})

test("loadRepoMap excludes tracked symlinks whose target is outside the workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minicode-repomap-link-"))
  const outside = await mkdtemp(join(tmpdir(), "minicode-repomap-outside-"))
  const previousMode = process.env.MINICODE_REPOMAP
  try {
    process.env.MINICODE_REPOMAP = "regex"
    await mkdir(join(dir, "src"), { recursive: true })
    const secretFile = join(outside, "secret.ts")
    await writeFile(secretFile, "export function OUTSIDE_SECRET_SYMBOL() {}\n", "utf8")
    const linkPath = join(dir, "src", "linked.ts")
    try {
      await symlink(secretFile, linkPath, "file")
    } catch {
      return
    }
    const init = spawnSync("git", ["init", "-q"], { cwd: dir, timeout: 5000 })
    if (init.status !== 0) return
    spawnSync("git", ["config", "core.symlinks", "true"], { cwd: dir, timeout: 5000 })
    const add = spawnSync("git", ["add", "--", "src/linked.ts"], { cwd: dir, timeout: 5000 })
    if (add.status !== 0) return
    const map = await loadRepoMap(dir)
    expect(map).not.toContain("OUTSIDE_SECRET_SYMBOL")
    expect(map).not.toContain("secret.ts")
  } finally {
    if (previousMode === undefined) delete process.env.MINICODE_REPOMAP
    else process.env.MINICODE_REPOMAP = previousMode
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    await rm(outside, { recursive: true, force: true }).catch(() => {})
  }
})
