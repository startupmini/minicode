import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addMemory, searchHybrid } from "../src/memory/vector.ts"

const originalFetch = globalThis.fetch
let tempDirs: string[] = []

async function cleanupTempDir(dir: string): Promise<void> {
  // Bun SQLite WAL sidecars can briefly keep Windows directory handles busy;
  // match the repo's existing best-effort cleanup convention for temp DBs.
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  await Promise.all(tempDirs.map(cleanupTempDir))
  tempDirs = []
})

test("F-07: keyword-only memories do not trigger an unused embedding request", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "minicode-no-embedding-"))
  tempDirs.push(cwd)
  const marker = `keyword-only-${randomUUID()}`
  await addMemory(`project convention ${marker}`, { cwd })

  let requests = 0
  globalThis.fetch = Object.assign(
    async () => {
      requests++
      return new Response("", { status: 404 })
    },
    { preconnect: originalFetch.preconnect },
  )

  const hits = await searchHybrid(marker, {
    cwd,
    baseUrl: "https://1.1.1.1/v1",
    apiKey: "test-key",
  })

  expect(hits.some((hit) => hit.text.includes(marker))).toBe(true)
  expect(requests).toBe(0)
})
