import { expect, test } from "bun:test"
import { createEventBus } from "#minicore/core/events.ts"
import type { ToolSchema } from "#minicore/core/tool.ts"
import type { Message } from "#minicore/core/types.ts"
import { applyMicrocompact } from "../src/policy/microcompact.ts"
import { createUsageCollector } from "../src/policy/usage.ts"
import { toAnthropicMessages, toAnthropicTools } from "../src/providers/anthropic.ts"

test("usage: tracks cache read and write tokens and reduces cost", () => {
  const bus = createEventBus()
  const collector = createUsageCollector(bus, "claude-sonnet-4")

  bus.emit({
    type: "provider:extension",
    kind: "usage",
    data: {
      inputTokens: 10000,
      outputTokens: 500,
      cacheReadTokens: 8000, // 8k tokens read from cache
      cacheWriteTokens: 2000,
    },
  })

  const u = collector.get()
  expect(u.inputTokens).toBe(10000)
  expect(u.outputTokens).toBe(500)
  expect(u.cacheReadTokens).toBe(8000)
  expect(u.cost).toBeDefined()

  // With 8k cache read (at $0.3/M instead of $3/M), cost should be significantly lower:
  // Normal 10k: 10000*3/1M = $0.030
  // Cached: 2000*3/1M ($0.006) + 8000*0.3/1M ($0.0024) + 500*15/1M ($0.0075) = $0.0159
  expect(u.cost!).toBeLessThan(0.025)
})

test("Fase 7: prefix Anthropic deterministik antar-turn (syarat cache hit)", () => {
  // Prefix = system + tools + messages dibangun dari fungsi MURNI. Dua kali
  // rakitan dengan input sama HARUS byte-identik — bila ada timestamp/session-id/
  // hitungan yang menyelinap, prefix berubah tiap turn dan cache tak pernah kena.
  const messages: Message[] = [
    { role: "user", content: "halo" },
    { role: "assistant", content: "hai! ada yang bisa dibantu?" },
  ]
  const tools: ToolSchema[] = [
    { name: "glob", description: "Cari file", parameters: { type: "object", properties: {} } },
    { name: "read_file", description: "Baca file", parameters: { type: "object", properties: {} } },
  ]

  expect(JSON.stringify(toAnthropicMessages(messages))).toBe(
    JSON.stringify(toAnthropicMessages(messages)),
  )
  expect(JSON.stringify(toAnthropicTools(tools, true))).toBe(
    JSON.stringify(toAnthropicTools(tools, true)),
  )
})

test("Fase 7: cache_control hanya di tool terakhir (bukan bagian volatil)", () => {
  const tools: ToolSchema[] = [
    { name: "glob", description: "C", parameters: { type: "object", properties: {} } },
    { name: "read_file", description: "R", parameters: { type: "object", properties: {} } },
    { name: "bash", description: "B", parameters: { type: "object", properties: {} } },
  ]
  const out = toAnthropicTools(tools, true) as Array<{
    name: string
    cache_control?: { type: string }
  }>
  expect(out[0]!.cache_control).toBeUndefined()
  expect(out[1]!.cache_control).toBeUndefined()
  // Penanda hanya pada tool terakhir: batas blok stabil, bukan pada item yang
  // bisa berubah urutannya tiap turn.
  expect(out[2]!.cache_control).toEqual({ type: "ephemeral" })
})

test("Fase 7: microcompact mempertahankan struktur pesan (boundary cache tetap valid)", () => {
  // microcompact memangkas ISI (bukan menghapus pesan). Invariant "tanpa membuang
  // pesan" memastikan penanda cache_control di pesan kedua-terakhir selalu menunjuk
  // ke pesan yang ADA — jadi microcompact hanya membuat cache miss sesaat (isi berubah),
  // bukan menghilangkan titik cache permanen. Ini kunci agar cache re-establish di
  // turn berikut dan hit tidak selalu 0.
  const messages: Message[] = [
    { role: "user", content: "mulai" },
    {
      role: "assistant",
      content: "langkah 1",
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "a" } }],
    },
    { role: "tool", toolCallId: "c1", name: "read_file", content: "x".repeat(40_000) },
    {
      role: "assistant",
      content: "langkah 2",
      toolCalls: [{ id: "c2", name: "grep", args: { pattern: "a" } }],
    },
    { role: "tool", toolCallId: "c2", name: "grep", content: "y".repeat(40_000) },
    { role: "user", content: "lanjut" },
  ]
  const r = applyMicrocompact(messages, {
    estimateTokens: (s) => Math.ceil(s.length / 4),
    budgetTokens: 100_000,
    keepRecent: 1,
    minSavingTokens: 100,
    minToolShare: 0.1,
  })
  // Struktur & jumlah pesan dipertahankan (isi yang dipangkas, bukan pesannya).
  expect(r.messages.length).toBe(messages.length)
  // toAnthropicMessages tetap menghasilkan role valid → penanda cache tak pernah
  // menunjuk ke pesan yang hilang.
  const anthropic = toAnthropicMessages(r.messages) as Array<{ role: string }>
  expect(anthropic.length).toBeGreaterThanOrEqual(2)
  for (const m of anthropic) expect(["user", "assistant"].includes(m.role)).toBe(true)
})
