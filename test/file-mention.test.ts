import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expandMentions, parseMentions, resolveMentionContent } from "../src/app/mentions.ts"

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-mention-"))
  await mkdir(join(dir, "sub"), { recursive: true })
  await writeFile(join(dir, "hello.txt"), "world")
  await writeFile(join(dir, ".env"), "secret=1")
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

test("parseMentions extracts @paths", () => {
  expect(parseMentions("see @hello.txt x")).toEqual(["hello.txt"])
  expect(parseMentions("no mention")).toEqual([])
})

test("resolveMentionContent reads file and returns content", async () => {
  const r = await resolveMentionContent("hello.txt", dir)
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.content).toContain("world")
})

test("resolveMentionContent blocks sensitive paths", async () => {
  const r = await resolveMentionContent(".env", dir)
  expect(r.ok).toBe(false)
})

test("resolveMentionContent reads only a bounded prefix", async () => {
  await writeFile(join(dir, "large.txt"), "x".repeat(100_000))
  const r = await resolveMentionContent("large.txt", dir)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.content).toContain("truncated: first 2000 bytes")
    expect(r.content.length).toBeLessThan(2200)
  }
})

test("expandMentions in full flow", async () => {
  const { prompt, notes } = await expandMentions("read @hello.txt", dir)
  expect(prompt).toContain("[file: hello.txt]")
  expect(notes).toEqual([])
})
