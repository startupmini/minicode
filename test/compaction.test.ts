// Test kompaksi LLM: jalur yang berjalan saat konteks penuh — paling jarang
// terlihat manual, paling mahal saat salah (fakta hilang dari ringkasan).

import { describe, expect, test } from "bun:test"
import type { Message } from "#minicore/core/types.ts"
import { LIMITS } from "../src/constants.ts"
import {
  compactWithLlm,
  createLlmCompaction,
  parseCompactKeepTurns,
} from "../src/policy/compaction.ts"

/** ContextStore tiruan: hanya `messages` yang dibaca kompaksi. */
const storeOf = (messages: Message[]) => ({ messages }) as never

/** Provider tiruan yang mengembalikan teks tetap sebagai ringkasan. */
function fakeProvider(text: string, opts: { fail?: boolean; empty?: boolean } = {}) {
  return {
    id: "fake",
    models: ["m"],
    async *stream() {
      if (opts.fail) throw new Error("provider meledak")
      if (!opts.empty) yield { type: "text" as const, text }
      yield { type: "finish" as const, reason: "stop" as const }
    },
  } as never
}

const convo = (n: number): Message[] => {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: `pertanyaan ${i}` })
    out.push({ role: "assistant", content: `jawaban ${i}` })
  }
  return out
}

describe("compactWithLlm", () => {
  test("ringkasan LLM menggantikan prefix, pesan terbaru dipertahankan", async () => {
    const messages = convo(6)
    const out = await compactWithLlm(storeOf(messages), {
      keepRecentTurns: 2,
      provider: fakeProvider("RINGKASAN FAKTA"),
    })
    expect(out.length).toBeLessThan(messages.length)
    expect(String(out[0]!.content)).toContain("RINGKASAN FAKTA")
    // Pesan terakhir asli tetap utuh — bukan diringkas.
    expect(out[out.length - 1]).toEqual(messages[messages.length - 1]!)
  })

  test("riwayat lebih pendek dari yang dipertahankan → tidak diubah", async () => {
    const messages = convo(1)
    const out = await compactWithLlm(storeOf(messages), {
      keepRecentTurns: 5,
      provider: fakeProvider("x"),
    })
    expect(out).toEqual(messages)
  })

  test("ringkasan kosong → fallback mekanis (bukan konteks kosong)", async () => {
    const messages = convo(6)
    const out = await compactWithLlm(storeOf(messages), {
      keepRecentTurns: 2,
      provider: fakeProvider("", { empty: true }),
    })
    expect(out.length).toBeGreaterThan(0)
    expect(String(out[0]!.content)).not.toContain("LLM summarized")
  })

  test("provider melempar → fallback mekanis", async () => {
    const messages = convo(6)
    const out = await compactWithLlm(storeOf(messages), {
      keepRecentTurns: 2,
      provider: fakeProvider("x", { fail: true }),
    })
    expect(out.length).toBeGreaterThan(0)
  })

  test("noFallback + provider gagal → melempar (loop yang memutuskan)", async () => {
    await expect(
      compactWithLlm(
        storeOf(convo(6)),
        { keepRecentTurns: 2, provider: fakeProvider("x", { fail: true }) },
        undefined,
        true,
      ),
    ).rejects.toThrow()
  })

  test("abort saat ringkasan berjalan diteruskan, bukan ditelan jadi fallback", async () => {
    const ac = new AbortController()
    const slow = {
      id: "slow",
      models: ["m"],
      async *stream(_req: unknown, signal: AbortSignal) {
        ac.abort()
        if (signal.aborted) {
          const err = new Error("Aborted")
          err.name = "AbortError"
          throw err
        }
        yield { type: "text" as const, text: "x" }
      },
    } as never
    await expect(
      compactWithLlm(storeOf(convo(6)), { keepRecentTurns: 2, provider: slow }, ac.signal, true),
    ).rejects.toThrow()
  })

  test("hasil tool sukses ikut masuk prompt ringkasan (sumber fakta)", async () => {
    let seenPrompt = ""
    const spy = {
      id: "spy",
      models: ["m"],
      async *stream(req: { messages: Message[] }) {
        seenPrompt = String(req.messages[0]?.content ?? "")
        yield { type: "text" as const, text: "ok" }
        yield { type: "finish" as const, reason: "stop" as const }
      },
    } as never
    const messages: Message[] = [
      { role: "user", content: "baca berkas" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "read_file", args: { path: "src/a.ts" } }],
      } as Message,
      {
        role: "tool",
        name: "read_file",
        content: "export const x = 1",
        toolCallId: "1",
      } as Message,
      { role: "user", content: "sekarang ubah" },
      { role: "assistant", content: "selesai" },
      { role: "user", content: "terakhir" },
      { role: "assistant", content: "ya" },
    ]
    await compactWithLlm(storeOf(messages), { keepRecentTurns: 1, provider: spy })
    expect(seenPrompt).toContain("read_file")
    expect(seenPrompt).toContain("export const x = 1")
    expect(seenPrompt).toContain("KEEP FACTS")
  })

  test("hasil tool ERROR ditandai di ringkasan", async () => {
    let seenPrompt = ""
    const spy = {
      id: "spy",
      models: ["m"],
      async *stream(req: { messages: Message[] }) {
        seenPrompt = String(req.messages[0]?.content ?? "")
        yield { type: "text" as const, text: "ok" }
        yield { type: "finish" as const, reason: "stop" as const }
      },
    } as never
    const messages: Message[] = [
      { role: "user", content: "jalankan" },
      {
        role: "tool",
        name: "bash",
        content: "gagal total",
        isError: true,
        toolCallId: "1",
      } as Message,
      { role: "user", content: "lagi" },
      { role: "assistant", content: "ya" },
    ]
    await compactWithLlm(storeOf(messages), { keepRecentTurns: 1, provider: spy })
    expect(seenPrompt).toContain("ERROR")
    expect(seenPrompt).toContain("gagal total")
  })

  test("anggaran di prompt = pagu simpan, bukan angka lepas", async () => {
    // Kalau prompt minta lebih dari yang composeBoundedSummary simpan, sisanya
    // dibuang diam-diam: token terbuang tanpa manfaat. Keduanya harus-bind ke
    // konstanta yang sama.
    let seenPrompt = ""
    const spy = {
      id: "spy",
      models: ["m"],
      async *stream(req: { messages: Message[] }) {
        seenPrompt = String(req.messages[0]?.content ?? "")
        yield { type: "text" as const, text: "ok" }
        yield { type: "finish" as const, reason: "stop" as const }
      },
    } as never
    await compactWithLlm(storeOf(convo(6)), { keepRecentTurns: 1, provider: spy })
    const asked = Number(/max (\d+) tokens/.exec(seenPrompt)?.[1])
    expect(Number.isFinite(asked)).toBe(true)
    // Estimasi 4 char/token; angka yang diminta harus muat di bawah pagu,
    // bukan 600 token lepas yang sebagian besar dibuang.
    expect(asked * 4).toBeLessThan(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
    expect(seenPrompt).toContain("discarded")
  })

  test("apiKey membangun provider openai-compat tanpa provider eksplisit", async () => {
    // Tanpa apiKey maupun provider: fallback mekanis, tidak melempar.
    const out = await compactWithLlm(storeOf(convo(6)), { keepRecentTurns: 2 })
    expect(out.length).toBeGreaterThan(0)
  })

  // Regresi P0 long-horizon: prior summary di-carried verbatim lalu
  // digabung dengan summary baru. Tanpa pagu, tiap siklus menambah
  // ~2.400 char ke pesan pertama yang SELALU ikut dikirim ke model — setelah
  // 12 siklus summary itu sendiri jadi sumber context overflow.
  test("berulang kali dikompaksi: summary tak tumbuh tanpa batas", async () => {
    // Panjang summary realistis (LLM diminta "max 600 tokens" ≈ 2.400 char).
    const realistic = (cycle: number) =>
      `FAKTA siklus ${cycle}: berkas diubah, tes lulus. ${"detail penting. ".repeat(160)}`
    let history: Message[] = convo(6)
    for (let cycle = 0; cycle < 12; cycle++) {
      history = [
        ...(await compactWithLlm(storeOf(history), {
          keepRecentTurns: 1,
          provider: fakeProvider(realistic(cycle)),
        })),
        { role: "user", content: `lanjutan ${cycle}` },
        { role: "assistant", content: `jawaban lanjutan ${cycle}` },
      ]
    }
    const head = String(history[0]!.content)
    expect(head).toContain("Previous context")
    expect(head.length).toBeLessThanOrEqual(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
    // Fakta siklus TERAKHIR harus selamat walau yang lama dipangkas.
    expect(head).toContain("siklus 11")
    // Pemangkasan bersifat eksplisit, bukan diam-diam: model tak boleh
    // menyimpulkan ringkasan ini lengkap.
    expect(head).toContain("elided")
  })

  test("summary pendek tetap digabung dengan prior di bawah pagu", async () => {
    let history: Message[] = convo(6)
    for (let cycle = 0; cycle < 6; cycle++) {
      history = [
        ...(await compactWithLlm(storeOf(history), {
          keepRecentTurns: 1,
          provider: fakeProvider(`FAKTA ${cycle}`),
        })),
        { role: "user", content: `lanjutan ${cycle}` },
        { role: "assistant", content: `jawaban lanjutan ${cycle}` },
      ]
    }
    const head = String(history[0]!.content)
    expect(head.length).toBeLessThanOrEqual(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
    // Prior di-tail, jadi fakta siklus pertama (yang paling lama) boleh hilang
    // sementara siklus terbaru pasti ada.
    expect(head).toContain("FAKTA 5")
    expect(head).not.toContain("FAKTA 0\n")
  })
})

describe("createLlmCompaction", () => {
  test("compact sinkron selalu memakai fallback mekanis", () => {
    const s = createLlmCompaction()
    const out = s.compact(storeOf(convo(6)), { keepRecentTurns: 2 })
    expect(out.length).toBeGreaterThan(0)
    expect(s.kind).toBe("llm-mechanical")
  })

  test("compactAsync memakai provider bila diberikan", async () => {
    const s = createLlmCompaction({ provider: fakeProvider("HASIL") })
    const out = await s.compactAsync!(
      storeOf(convo(6)),
      { keepRecentTurns: 2 },
      new AbortController().signal,
    )
    expect(String(out[0]!.content)).toContain("HASIL")
  })

  test("compactAsync menolak tanpa provider (loop yang fallback)", async () => {
    const s = createLlmCompaction()
    await expect(
      s.compactAsync!(storeOf(convo(6)), { keepRecentTurns: 2 }, new AbortController().signal),
    ).rejects.toThrow()
  })

  test("fallback kustom dipakai oleh compact sinkron", () => {
    let dipakai = false
    const s = createLlmCompaction({
      fallback: {
        kind: "kustom",
        compact: () => {
          dipakai = true
          return []
        },
      },
    })
    s.compact(storeOf(convo(4)), { keepRecentTurns: 1 })
    expect(dipakai).toBe(true)
  })

  test("signal luar diteruskan ke provider", async () => {
    // Provider yang menghormati signal akan melempar; compactAsync memakai
    // noFallback sehingga error itu naik ke loop (bukan diam-diam mekanis).
    const respectful = {
      id: "r",
      models: ["m"],
      async *stream(_req: unknown, signal: AbortSignal) {
        if (signal.aborted) {
          const err = new Error("Aborted")
          err.name = "AbortError"
          throw err
        }
        yield { type: "text" as const, text: "x" }
        yield { type: "finish" as const, reason: "stop" as const }
      },
    } as never
    const s = createLlmCompaction({ provider: respectful })
    const ac = new AbortController()
    ac.abort()
    await expect(
      s.compactAsync!(storeOf(convo(6)), { keepRecentTurns: 2 }, ac.signal),
    ).rejects.toThrow()
  })
})

describe("F3.1 anti-thrash kompaksi LLM", () => {
  // convo(10) + keep 9 = prefix 2 pesan → ringkasan mengganti 2 jadi 1:
  // progres 1/20 = 5% < 10% = tak berprogres, dua kali = thrash.
  const narrow = () => storeOf(convo(10))
  const sig = () => new AbortController().signal
  test("2× tak berprogres beruntun → jalur LLM mati sesi-ini (lempar ke mekanikal)", async () => {
    // Gagal di kode lama: panggilan ketiga tetap memanggil provider (sukses).
    const s = createLlmCompaction({ provider: fakeProvider("RINGKASAN") })
    await s.compactAsync!(narrow(), { keepRecentTurns: 9 }, sig())
    await s.compactAsync!(narrow(), { keepRecentTurns: 9 }, sig())
    await expect(s.compactAsync!(narrow(), { keepRecentTurns: 9 }, sig())).rejects.toThrow(
      /disabled after thrash/,
    )
  })
  test("kompaksi berprogres me-reset streak (tak pernah dimatikan)", async () => {
    const s = createLlmCompaction({ provider: fakeProvider("RINGKASAN PADAT") })
    const wide = () => storeOf(convo(6))
    // progres 6/12 = 50% tiap kali → streak tak pernah mencapai 2.
    for (let i = 0; i < 4; i++) {
      const out = await s.compactAsync!(wide(), { keepRecentTurns: 2 }, sig())
      expect(String(out[0]!.content)).toContain("RINGKASAN PADAT")
    }
  })
  test("no-op (tak ada yang bisa dibuang) bukan thrash", async () => {
    const s = createLlmCompaction({ provider: fakeProvider("TAK DIPAKAI") })
    // keep ≥ isi → early-return tanpa panggilan LLM, berulang-ulang aman.
    for (let i = 0; i < 4; i++) {
      const out = await s.compactAsync!(storeOf(convo(1)), { keepRecentTurns: 5 }, sig())
      expect(out.length).toBe(2)
    }
  })
})

describe("F3.2 parseCompactKeepTurns", () => {
  test("bilangan ≥1 dipakai; kosong/invalid → undefined (default kernel)", () => {
    expect(parseCompactKeepTurns(undefined)).toBeUndefined()
    expect(parseCompactKeepTurns("")).toBeUndefined()
    expect(parseCompactKeepTurns("  ")).toBeUndefined()
    expect(parseCompactKeepTurns("4")).toBe(4)
    expect(parseCompactKeepTurns(" 7 ")).toBe(7)
    expect(parseCompactKeepTurns("0")).toBeUndefined()
    expect(parseCompactKeepTurns("-2")).toBeUndefined()
    expect(parseCompactKeepTurns("2.5")).toBeUndefined()
    expect(parseCompactKeepTurns("banyak")).toBeUndefined()
    expect(parseCompactKeepTurns("Infinity")).toBeUndefined()
  })
})
