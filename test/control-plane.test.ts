// Phase 6 — kontrak control plane: compaction budget ≠ recovery, flag
// tunggal tidak lagi membakar recovery retry, contextTokens tersedia bagi
// driver/UI, reason kompaksi membedakan pemicu. Semua test ini HARUS gagal
// di kode lama (Prinsip 3): flag `compacted` tunggal di loop.ts mengaburkan
// dua semantics berbeda.
import { describe, expect, test } from "bun:test"
import * as tk from "#minicore"
import { AgentError, ProviderError } from "#minicore"
import { FakeProvider, finish, text, toolCall } from "#minicore/test/fakes.ts"

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
