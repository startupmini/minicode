// RAG layer startup: prompt kosong tak boleh me-retrieve (dulu tiap provider
// ber-API-key dicoba sequential: DNS tanpa cache + POST embedding — startup
// membayar jumlahnya dalam hening). Tanpa mock module (mock.module bocor
// antar-file di Bun): dedup diuji via fungsi murni buildEmbeddingCandidates,
// perilaku no-network via provider tanpa kunci + cwd kosong.

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildEmbeddingCandidates, createRagLayer } from "../src/app/rag-layer.ts"
import { addMemory } from "../src/memory/vector.ts"

const cfgWith = (providers: { id: string; baseUrl: string; apiKey?: string }[]) => ({
  providers: providers.map((p) => ({ ...p, models: [] as string[] })),
})

let dir = ""
const ENV_KEYS = ["AGENT_BASE_URL", "OPENAI_API_KEY", "AGENT_API_KEY"] as const
let savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rag-"))
  // Kandidat embedding default (env mesin dev) harus disingkirkan agar
  // deterministik.
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

test("dedup: dua provider satu baseUrl = satu kandidat", () => {
  const out = buildEmbeddingCandidates(
    cfgWith([
      { id: "a", baseUrl: "http://a.invalid", apiKey: "k1" },
      { id: "b", baseUrl: "http://a.invalid", apiKey: "k2" },
      { id: "c", baseUrl: "http://b.invalid", apiKey: "k3" },
    ]) as never,
  )
  expect(out).toEqual([
    { baseUrl: "http://a.invalid", apiKey: "k1" },
    { baseUrl: "http://b.invalid", apiKey: "k3" },
  ])
})

test("tanpa kunci: kandidat kosong (tak ada yang bisa dipanggil)", () => {
  const out = buildEmbeddingCandidates(cfgWith([{ id: "a", baseUrl: "http://a.invalid" }]) as never)
  expect(out).toEqual([])
})

test("prompt kosong: tanpa retrieval, tanpa hits", async () => {
  const r = await createRagLayer({
    cfg: cfgWith([{ id: "a", baseUrl: "http://a.invalid", apiKey: "k" }]) as never,
    prompt: "   ",
    cwd: dir,
  })
  expect(r.memoryHits).toBe(0)
  expect(r.systemExtra ?? "").not.toContain("Relevant memory")
})

test("keyword fallback tetap jalan tanpa kunci (anti over-skip)", async () => {
  await addMemory("kucing makan ikan di dapur", { cwd: dir })
  const r = await createRagLayer({
    cfg: cfgWith([{ id: "a", baseUrl: "http://a.invalid" }]) as never,
    prompt: "kucing",
    cwd: dir,
  })
  expect(r.memoryHits).toBeGreaterThan(0)
  expect(r.systemExtra ?? "").toContain("kucing")
})
