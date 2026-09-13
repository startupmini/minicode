// RAG layer startup: prompt kosong tak boleh menyentuh network sama sekali.
// Dulu tiap provider ber-API-key dicoba sequential (DNS tanpa cache + POST
// embedding, timeout per endpoint) — startup membayar jumlahnya dalam hening.
// Mock module vector.ts (bun:test, file-scoped): hitung invocasi searchHybrid
// tanpa network sungguhan. Satu dynamic import di bawah mock agar binding
// yang dipakai createRagLayer adalah mock-nya.

import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Hit = { text: string; score: number; createdAt: number }
let calls: { baseUrl?: string }[] = []
let hits: Hit[] = []

mock.module("../src/memory/vector.ts", () => ({
  searchHybrid: async (_q: unknown, o: { baseUrl?: string }) => {
    calls.push({ baseUrl: o?.baseUrl })
    return hits
  },
}))

const { createRagLayer } = await import("../src/app/rag-layer.ts")

const cfgWith = (urls: string[]) => ({
  providers: urls.map((baseUrl, i) => ({ id: `p${i}`, baseUrl, apiKey: "k", models: [] })),
})

let dir = ""
const ENV_KEYS = ["AGENT_BASE_URL", "OPENAI_API_KEY", "AGENT_API_KEY"] as const
let savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rag-"))
  calls = []
  hits = []
  // Kandidat embedding default (env mesin dev) harus disingkirkan agar
  // hitungan panggilan deterministik.
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

test("prompt kosong: searchHybrid tak pernah dipanggil (startup tanpa network)", async () => {
  const r = await createRagLayer({
    cfg: cfgWith(["http://a.invalid", "http://b.invalid"]) as never,
    prompt: "   ",
    cwd: dir,
  })
  expect(calls).toEqual([])
  expect(r.memoryHits).toBe(0)
  expect(r.systemExtra ?? "").not.toContain("Relevant memory")
})

test("dedup: dua provider satu baseUrl = satu panggilan", async () => {
  await createRagLayer({
    cfg: cfgWith(["http://a.invalid", "http://a.invalid"]) as never,
    prompt: "halo",
    cwd: dir,
  })
  expect(calls).toEqual([{ baseUrl: "http://a.invalid" }])
})

test("URL beda tetap dicoba semua sampai hits (anti over-dedup)", async () => {
  await createRagLayer({
    cfg: cfgWith(["http://a.invalid", "http://b.invalid"]) as never,
    prompt: "halo",
    cwd: dir,
  })
  expect(calls).toEqual([{ baseUrl: "http://a.invalid" }, { baseUrl: "http://b.invalid" }])
})

test("prompt isi tetap me-retrieve (anti over-skip)", async () => {
  hits = [{ text: "ingatan penting", score: 0.9, createdAt: Date.now() }]
  const r = await createRagLayer({
    cfg: cfgWith(["http://a.invalid"]) as never,
    prompt: "halo",
    cwd: dir,
  })
  expect(calls).toHaveLength(1)
  expect(r.memoryHits).toBe(1)
  expect(r.systemExtra ?? "").toContain("ingatan penting")
})
