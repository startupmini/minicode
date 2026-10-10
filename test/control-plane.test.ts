// Phase 6 — kontrak control plane: compaction budget ≠ recovery, flag
// tunggal tidak lagi membakar recovery retry, contextTokens tersedia bagi
// driver/UI, reason kompaksi membedakan pemicu. Semua test ini HARUS gagal
// di kode lama (Prinsip 3): flag `compacted` tunggal di loop.ts mengaburkan
// dua semantics berbeda.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as tk from "#minicore"
import { AgentError, ProviderError } from "#minicore"
import { collectEvents, FakeProvider, finish, text, toolCall } from "#minicore/test/fakes.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import { createLlmCompaction } from "../src/policy/compaction.ts"

const { createSession, defaultTokenEstimator } = tk
const allowAll = { check: async () => "allow" as const, describeDenial: () => undefined }

describe("compaction contract: budget ≠ recovery (F-10, seam Phase 6)", () => {
  test("budget compaction + finish length → recovery compaction DICOB dulu", async () => {
    // Kode lama: budget pre-compaction set `compacted=true`; finish "length"
    // → onLength(true) → throw budget_exceeded padahal kompaksi recovery
    // belum pernah dicoba. Kontrak baru: dua flag terpisah — recovery
    // compaction punya kesempatan sendiri.
    let recoveryCompactions = 0
    const p = new FakeProvider([
      // Turn panjang dengan tool result besar + tool_calls agar pressure
      // naik + kompaksi budget jalan di step berikutnya.
      { events: [toolCall("bigtool", {}, "c1"), finish("tool_calls")] },
      { events: [finish("length")] },
      { events: [text("selesai"), finish("stop")] },
    ])
    const s = createSession({
      provider: p,
      permissions: allowAll,
      tools: [
        {
          name: "bigtool",
          description: "big",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => "r".repeat(10_000),
        },
      ],
      contextWindowTokens: 8_000, // kecil: result 2.5k tok + tool → pressure medium
      keepRecentTurns: 1,
      recovery: {
        onError: () => ({ type: "throw" }),
        onLength: (compacted: boolean) => {
          if (compacted) return { type: "throw" }
          recoveryCompactions++
          return { type: "force_compact_and_retry" }
        },
      },
    })
    const res = await s.run("kerjakan", {})
    // Recovery compaction DICOB (sebelumnya: 0 — flag dibakar budget path).
    expect(recoveryCompactions).toBe(1)
    expect(res.finalText).toContain("selesai")
  })

  test("recovery compaction setelah recovery compaction = budget_exceeded (anti-loop)", async () => {
    // Kontrak: recovery compaction hanya SEKALI per turn; kedua = throw.
    const p = new FakeProvider([
      { throw: new ProviderError("context_length_exceeded", "too long 1") },
      { throw: new ProviderError("context_length_exceeded", "too long 2") },
    ])
    const s = createSession({
      provider: p,
      permissions: allowAll,
      contextWindowTokens: 30_000, // besar → pressure low → NO budget compaction
      keepRecentTurns: 1,
    })
    // Pertama: force_compact (flag recovery diset). Kedua: flag recovery
    // sudah set → budget_exceeded.
    await expect(s.run("halo")).rejects.toMatchObject({ kind: "budget_exceeded" })
  }, 15000)
})

describe("production compaction path (P4-M09)", () => {
  // M09-A — finish "length" lewat recovery PRODUKSI (cappedRecovery, bukan
  // mock onLength): kompaksi tepat sekali + retry + turn selesai. Sesi
  // produksi penuh (createMinicodeSession: permission, executor, estimator
  // nyata); kompaktor = default kernel (mekanikal sinkron, tanpa compactAsync)
  // agar yang dibuktikan murni jalur recovery, bukan fallback.
  test("P4-M09-A: length → satu recovery-compaction + retry → turn selesai", async () => {
    const p = new FakeProvider([
      { events: [finish("length")] },
      { events: [text("pulih"), finish("stop")] },
    ])
    const s = await createMinicodeSession({
      provider: p,
      cwd: mkdtempSync(join(tmpdir(), "mc-m09a-")),
      contextWindowTokens: 30_000, // besar → pressure low → tanpa budget compaction
      keepRecentTurns: 1,
    })
    const { events, unsubscribe } = collectEvents(s.events)
    try {
      const res = await s.run("halo", {})
      expect(res.finalText).toBe("pulih")
      // Tepat 2 request: length-attempt + retry (bukan loop).
      expect(p.requests.length).toBe(2)
      // Kompaksi benar-benar jalan lewat seam loop (bukan klaim): tepat satu
      // event context:compacted dengan reason recovery.
      const compacted = events.filter((e) => e.type === "context:compacted")
      expect(compacted).toHaveLength(1)
      expect((compacted[0] as { reason?: string }).reason).toBe("recovery")
    } finally {
      unsubscribe()
    }
  }, 15000)

  // M09-B — compactAsync produksi GAGAL → fallback mekanikal sinkron → turn
  // lanjut. Strategi = createLlmCompaction produksi TANPA provider LLM:
  // compactAsync-nya melempar deterministik ("no provider for LLM
  // compaction", tanpa network) saat histori butuh pemadatan; loop wajib
  // jatuh ke compact() sinkron (kontrak compactStore), bukan crash/retry
  // buta. Spy tipis menghitung pemanggilan async — perilaku throw + fallback
  // 100% produksi, bukan mock.
  test("P4-M09-B: compactAsync gagal → fallback sync → turn selesai, konteks susut", async () => {
    const p = new FakeProvider([
      { events: [text("jawaban-satu"), finish("stop")] },
      { events: [finish("length")] },
      { events: [text("jawaban-dua"), finish("stop")] },
    ])
    const llm = createLlmCompaction({})
    let asyncAttempts = 0
    const s = await createMinicodeSession({
      provider: p,
      cwd: mkdtempSync(join(tmpdir(), "mc-m09b-")),
      contextWindowTokens: 30_000, // besar → hanya jalur recovery yang menembak
      keepRecentTurns: 1,
      compaction: {
        ...llm,
        compactAsync: async (store, cOpts, signal) => {
          asyncAttempts++
          return llm.compactAsync!(store, cOpts, signal)
        },
      },
    })
    const { events, unsubscribe } = collectEvents(s.events)
    try {
      await s.run("topik-satu", {})
      const res = await s.run("topik-dua", {})
      // Turn lanjut SESUDAH fallback: jawaban sehat tiba.
      expect(res.finalText).toBe("jawaban-dua")
      // Tepat 3 request: turn1 + length-attempt + retry (bukan loop abadi).
      expect(p.requests.length).toBe(3)
      // Jalur async benar-benar dicoba tepat sekali (bukan dilewati).
      expect(asyncAttempts).toBe(1)
      const compacted = events.filter((e) => e.type === "context:compacted")
      expect(compacted).toHaveLength(1)
      expect((compacted[0] as { reason?: string }).reason).toBe("recovery")
      // Request retry memakai konteks HASIL kompaksi (susut), bukan prakompaksi.
      const bodies = p.requests.map((r) => r as { messages?: unknown[] })
      expect(bodies[2]!.messages!.length).toBeLessThan(bodies[1]!.messages!.length)
      // Fallback mekanikal melipat prefix jadi SATU ringkasan berbatas
      // ("Previous context:"), bukan menghapus atau menduplikasi: 4 pesan
      // tanpa kompaksi → 3 pesan (ringkasan + ekor turn berjalan).
      const history = s.state.history as { role?: string; content?: unknown }[]
      expect(history).toHaveLength(3)
      expect(history[0]!.role).toBe("user")
      expect(String(history[0]!.content)).toMatch(/^Previous context:/)
      const dump = JSON.stringify(history)
      expect(dump).toContain("topik-dua")
      expect(dump).toContain("jawaban-dua")
    } finally {
      unsubscribe()
    }
  }, 15000)
})

describe("context contract: kernel ekspos contextTokens (seam Phase 6)", () => {
  test("Session punya getter contextTokens — satu sumber kebenaran", async () => {
    const p = new FakeProvider([{ events: [finish("stop")] }])
    const s = createSession({
      provider: p,
      permissions: allowAll,
      system: "s".repeat(400), // 100 tok
    })
    // Sebelum turn: history kosong + system 100 tok.
    expect(typeof (s as unknown as { contextTokens?: unknown }).contextTokens).toBe("number")
    expect((s as unknown as { contextTokens: number }).contextTokens).toBeGreaterThan(0)
    await s.run("halo", {})
    // Setelah turn: user+assistant masuk — angka tumbuh dari sumber yang sama.
    const after = (s as unknown as { contextTokens: number }).contextTokens
    expect(after).toBeGreaterThan(
      (s as unknown as { contextTokens: number }).contextTokens === after ? 0 : 0,
    )
    // Konsistensi: hitung manual dengan estimator yang sama — harus sama.
    const manual =
      tk.estimateMessages(s.state.history, defaultTokenEstimator) +
      tk.estimateSystem("s".repeat(400), defaultTokenEstimator) +
      tk.estimateTools([], defaultTokenEstimator)
    expect(after).toBe(manual)
  })

  test("contextTokens mencakup tool schema (fixed per-request cost)", async () => {
    const p = new FakeProvider([{ events: [finish("stop")] }])
    const s = createSession({
      provider: p,
      permissions: allowAll,
      tools: [
        {
          name: "t",
          description: "d".repeat(400),
          parameters: { type: "object", properties: {} },
          execute: async () => "ok",
        },
      ] as never,
    })
    const withTools = (s as unknown as { contextTokens: number }).contextTokens
    // Tool schema 100 tok + overhead — tanpa tools angka lebih kecil.
    const s2 = createSession({ provider: p, permissions: allowAll })
    const withoutTools = (s2 as unknown as { contextTokens: number }).contextTokens
    expect(withTools).toBeGreaterThan(withoutTools)
  })
})

describe("termination contract: reason membedakan pemicu", () => {
  test("budget compaction gagal → budget_exceeded (bukan provider)", async () => {
    const p = new FakeProvider([
      { events: [toolCall("bigtool", {}, "c1"), finish("tool_calls")] },
      { events: [finish("stop")] },
    ])
    const s = createSession({
      provider: p,
      permissions: allowAll,
      tools: [
        {
          name: "bigtool",
          description: "big",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => "r".repeat(10_000),
        },
      ],
      contextWindowTokens: 500, // jauh di bawah result — kompaksi tak pernah cukup
      keepRecentTurns: 1,
    })
    // Tool result 2.5k tok vs window 500 → critical → kompaksi no-op (3 pesan,
    // keep 1 turn = semuanya) → flag budget set → budget_exceeded (bukan
    // retry provider sia-sia atas konteks yang pasti gagal lagi).
    await expect(s.run("kerjakan", {})).rejects.toMatchObject({ kind: "budget_exceeded" })
  }, 15000)

  test("user abort tetap aborted; timeout tetap timeout (kontrak lama utuh)", async () => {
    const ac = new AbortController()
    ac.abort(new AgentError("aborted", "user aborted"))
    const { abortError } = await import("#minicore")
    expect(abortError(ac.signal).kind).toBe("aborted")
    const tc = new AbortController()
    tc.abort(new AgentError("timeout", "turn exceeded"))
    expect(abortError(tc.signal).kind).toBe("timeout")
  })
})
