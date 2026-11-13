// Test perilaku kernel saat kompaksi TIDAK BISA membantu.
//
// Kode lama: `✗ Context window exceeded` dilempar tanpa membedakan
// (a) konteks penuh tapi masih bisa dipadatkan dari
// (b) kompaksi sudah di titik tetap, dan
// (c) biaya tetap (system+tools) sendiri yang melebihi jendela.
// Ketiganya butuh tindakan user yang BERBEDA, jadi pesan dan detailnya harus beda.
import { describe, expect, test } from "bun:test"
import * as tk from "#minicore"
import { AgentError } from "#minicore"
import { collectEvents, FakeProvider, finish, text } from "#minicore/test/fakes.ts"

const { createSession, defaultTokenEstimator } = tk
const allowAll = { check: async () => "allow" as const, describeDenial: () => undefined }

describe("kompaksi mustahil: biaya tetap melebihi jendela", () => {
  test("system prompt + tool schema > jendela → error 'impossible' dengan angka", async () => {
    const p = new FakeProvider([{ events: [text("x"), finish("stop")] }])
    const tools = [
      {
        name: "huge",
        // Deskripsi besar = biaya tetap besar yang tak bisa dikompaksi.
        description: "d".repeat(40_000),
        parameters: { type: "object" as const, properties: {}, additionalProperties: false },
        execute: async () => "",
      },
    ]
    const s = createSession({
      provider: p,
      permissions: allowAll,
      tools,
      // Jendela sengaja kecil: biaya tetap saja sudah melebihinya.
      contextWindowTokens: 1_000,
      estimator: defaultTokenEstimator,
    })
    const { events, unsubscribe } = collectEvents(s.events)
    try {
      let caught: unknown
      try {
        await s.run("halo", {})
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(AgentError)
      const err = caught as AgentError
      expect(err.kind).toBe("budget_exceeded")
      // Pesan menyebut SEBAB-nya, bukan sekadar "context window exceeded".
      expect(err.message).toMatch(/before compaction|fixed instructions/i)
      expect(err.details?.reason).toBe("impossible")
      // Angka tersedia untuk ditampilkan.
      expect(typeof err.details?.fixedTokens).toBe("number")
      expect(err.details?.windowTokens).toBe(1_000)
      // Peristiwa kompaksi melaporkan sebab yang sama (bukan no-op palsu).
      const compacted = events.filter((e) => e.type === "context:compacted")
      expect(compacted.length).toBe(1)
      expect(String((compacted[0] as { reason?: string }).reason)).toMatch(/^impossible:/)
      // Tidak ada request provider yang terkirim: mustahil dipadatkan berarti
      // tak masuk akal membakar panggilan model.
      expect(p.requests.length).toBe(0)
    } finally {
      unsubscribe()
    }
  })
})

describe("kompaksi di titik tetap: dilaporkan, bukan dilempar buta", () => {
  test("kompaksi berulang tanpa kemajuan → error menyebut 'fixpoint' + jumlah pesan", async () => {
    // Strategi kompaksi yang SELALU mengembalikan daftar yang sama = nol kemajuan.
    // Ini meniru kondisi nyata: ekor verbatim `keepRecentTurns` sudah lebih besar
    // dari jendela sehingga tak ada yang bisa dibuang lagi.
    const p = new FakeProvider([
      { events: [text("x"), finish("stop")] },
      { events: [text("x"), finish("stop")] },
      { events: [text("x"), finish("stop")] },
    ])
    const s = createSession({
      provider: p,
      permissions: allowAll,
      system: "s".repeat(4_000), // 1000 token biaya tetap
      contextWindowTokens: 2_000,
      compaction: {
        kind: "frozen",
        // Tak pernah menyusutkan apa pun — kompaksi berada di titik tetap.
        compact: (store) => store.messages,
      },
    })
    const { events, unsubscribe } = collectEvents(s.events)
    try {
      let caught: unknown
      try {
        await s.run(`halo ${"k".repeat(12_000)}`, {})
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(AgentError)
      const err = caught as AgentError
      expect(err.kind).toBe("budget_exceeded")
      expect(err.message).toMatch(/cannot reduce this session further|fixpoint/i)
      expect(err.details?.reason).toBe("fixpoint")
      expect(typeof err.details?.keptMessages).toBe("number")
      // Minimal satu peristiwa no-op tercatat — bukti kompaksi benar-benar dicoba.
      const compacted = events.filter((e) => e.type === "context:compacted")
      expect(
        compacted.some((e) => String((e as { reason?: string }).reason).includes("no-op")),
      ).toBe(true)
    } finally {
      unsubscribe()
    }
  }, 15000)
})
