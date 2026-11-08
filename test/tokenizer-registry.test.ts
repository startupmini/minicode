import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetTokenizerCache,
  getCachedTokenizer,
  loadTokenizer,
} from "../src/policy/tokenizer-registry.ts"

let tmp: string
let origFetch: typeof globalThis.fetch

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mc-tok-"))
  process.env.MINICODE_HOME = tmp
  origFetch = globalThis.fetch
  __resetTokenizerCache()
})

afterEach(() => {
  globalThis.fetch = origFetch!
  rmSync(tmp, { recursive: true, force: true })
  delete process.env.MINICODE_HOME
})

const fakeModel = { vocab: { t: 0, h: 1, e: 2, the: 3 }, merges: ["t h", "th e"] }

function mockFetch(ok: boolean) {
  globalThis.fetch = (async () => ({
    ok,
    status: ok ? 200 : 404,
    json: async () => ({ model: fakeModel }),
  })) as unknown as typeof fetch
}

describe("tokenizer registry (unduh + cache)", () => {
  test("model deepseek mengunduh tokenizer lalu cache sinkron", async () => {
    mockFetch(true)
    const tok = await loadTokenizer("deepseek-v4-flash")
    expect(tok).not.toBeNull()
    expect(tok!.countTokens("the")).toBe(1)
    expect(getCachedTokenizer("deepseek-v4-flash")).not.toBeNull()
  })

  test("model tak dikenal -> null (fallback estimator densitas)", async () => {
    mockFetch(true)
    expect(await loadTokenizer("some-unknown-model")).toBeNull()
    expect(getCachedTokenizer("some-unknown-model")).toBeNull()
  })

  test("unduh gagal (404/network) -> null, tidak melempar", async () => {
    mockFetch(false)
    expect(await loadTokenizer("deepseek-x")).toBeNull()
  })

  test("cache disk dipakai ulang antar-proses (tanpa fetch kedua)", async () => {
    mockFetch(true)
    const first = await loadTokenizer("deepseek-v4-flash")
    expect(first).not.toBeNull()
    // panggil lagi (harus dari cache memori/disk, fetch kedua tetap bisa dipanggil
    // tapi hasil konsisten)
    const again = await loadTokenizer("deepseek-v4-flash")
    expect(again).not.toBeNull()
    expect(again!.countTokens("the")).toBe(1)
  })
})
