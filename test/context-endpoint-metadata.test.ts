// Test Fase 1: metadata kapasitas dari endpoint `/models`.
//
// Yang dibuktikan di sini adalah pembalikan akar masalah: `context_length` dari
// endpoint TIDAK lagi dibuang, dan nilai yang ditemukan tidak pernah secara
// diam-diam menimpa nilai yang operator tetapkan sendiri.
import { describe, expect, test } from "bun:test"
import type { MinicodeConfig, ProviderEntry } from "../src/config.ts"
import { resolveContextWindow } from "../src/policy/context-window.ts"
import type { DetectResult } from "../src/providers/detect.ts"
import { extractModelCapacity } from "../src/providers/detect.ts"
import { mergeDiscoveredCapacity } from "../src/providers/provision.ts"

describe("extractModelCapacity: alias field lintas gateway", () => {
  test("openai-compat `context_length`", () => {
    expect(extractModelCapacity({ id: "m", context_length: 128_000 })).toEqual({
      contextLength: 128_000,
    })
  })

  test("`context_window` dan `max_context_length`", () => {
    expect(extractModelCapacity({ id: "m", context_window: 200_000 }).contextLength).toBe(200_000)
    expect(extractModelCapacity({ id: "m", max_context_length: 65_536 }).contextLength).toBe(65_536)
  })

  test("anthropic-style `max_input_tokens` untuk konteks, `max_output_tokens` untuk output", () => {
    const r = extractModelCapacity({
      id: "m",
      max_input_tokens: 1_048_576,
      max_output_tokens: 65_536,
    })
    expect(r).toEqual({ contextLength: 1_048_576, maxOutputTokens: 65_536 })
  })

  test("nama agregator bersarang di `top_provider`", () => {
    const r = extractModelCapacity({
      id: "m",
      top_provider: { context_length: 1_048_576, max_completion_tokens: 32_768 },
    })
    expect(r).toEqual({ contextLength: 1_048_576, maxOutputTokens: 32_768 })
  })

  test("level atas menang atas nilai bersarang", () => {
    const r = extractModelCapacity({
      id: "m",
      context_length: 200_000,
      top_provider: { context_length: 1_048_576 },
    })
    expect(r.contextLength).toBe(200_000)
  })

  test("payload TANPA field kapasitas → kosong (tidak dikarang)", () => {
    expect(extractModelCapacity({ id: "m" })).toEqual({})
    expect(extractModelCapacity({ id: "m", owned_by: "x" })).toEqual({})
    expect(extractModelCapacity(null)).toEqual({})
    expect(extractModelCapacity("m")).toEqual({})
    expect(extractModelCapacity({ id: "m", context_length: "128000" })).toEqual({})
  })

  test("nilai rusak/absurd ditolak, bukan diteruskan", () => {
    expect(extractModelCapacity({ id: "m", context_length: 0 })).toEqual({})
    expect(extractModelCapacity({ id: "m", context_length: -5 })).toEqual({})
    expect(extractModelCapacity({ id: "m", context_length: Number.NaN })).toEqual({})
    expect(extractModelCapacity({ id: "m", context_length: 1e12 })).toEqual({})
  })

  test("`max_tokens` TIDAK diperlakukan sebagai konteks", () => {
    // Sebagian endpoint memakai `max_tokens` untuk batas OUTPUT. Memetakannya
    // sebagai konteks akan mengecilkan jendela secara diam-diam.
    expect(extractModelCapacity({ id: "m", max_tokens: 4_096 })).toEqual({})
  })
})

describe("mergeDiscoveredCapacity: presedensi nilai", () => {
  const detected = (
    meta: Record<string, { contextLength?: number; maxOutputTokens?: number }>,
    offered?: string[],
  ) =>
    ({
      // `offered` memisahkan "model yang ditawarkan endpoint" dari "model yang
      // metadata kapasitasnya dilaporkan". Respons `/models` nyata biasanya
      // mencantumkan semua model, tapi hanya sebagian punya field kapasitas.
      models: offered ?? Object.keys(meta),
      modelMetadata: Object.fromEntries(Object.entries(meta).map(([id, m]) => [id, { id, ...m }])),
      providerHint: "openai",
      authFailed: false,
    }) as DetectResult

  test("provider baru: metadata endpoint langsung dipakai", () => {
    const merged = mergeDiscoveredCapacity(undefined, detected({ m: { contextLength: 1_048_576 } }))
    expect(merged.contextWindows).toEqual({ m: 1_048_576 })
    expect(merged.contextWindowSources).toEqual({ m: "endpoint" })
  })

  test("nilai operator (`user`) TIDAK ditimpa endpoint", () => {
    const prev: ProviderEntry = {
      id: "p",
      baseUrl: "u",
      apiKey: "k",
      models: ["m"],
      contextWindows: { m: 200_000 },
      contextWindowSources: { m: "user" },
    }
    const merged = mergeDiscoveredCapacity(prev, detected({ m: { contextLength: 1_048_576 } }))
    expect(merged.contextWindows).toEqual({ m: 200_000 })
    expect(merged.contextWindowSources).toEqual({ m: "user" })
  })

  test("config lama tanpa catatan asal diperlakukan sebagai `user` (tanpa regresi)", () => {
    const prev: ProviderEntry = {
      id: "p",
      baseUrl: "u",
      apiKey: "k",
      models: ["m"],
      contextWindows: { m: 99_999 },
    }
    const merged = mergeDiscoveredCapacity(prev, detected({ m: { contextLength: 1_048_576 } }))
    expect(merged.contextWindows?.m).toBe(99_999)
  })

  test("nilai `endpoint` lama diperbarui oleh deteksi berikutnya", () => {
    const prev: ProviderEntry = {
      id: "p",
      baseUrl: "u",
      apiKey: "k",
      models: ["m"],
      contextWindows: { m: 131_072 },
      contextWindowSources: { m: "endpoint" },
    }
    const merged = mergeDiscoveredCapacity(prev, detected({ m: { contextLength: 262_144 } }))
    expect(merged.contextWindows?.m).toBe(262_144)
  })

  test("model yang sudah tak ditawarkan endpoint dibuang (basi)", () => {
    const prev: ProviderEntry = {
      id: "p",
      baseUrl: "u",
      apiKey: "k",
      models: ["m", "gone"],
      contextWindows: { m: 100_000, gone: 50_000 },
      contextWindowSources: { m: "endpoint", gone: "endpoint" },
    }
    const merged = mergeDiscoveredCapacity(prev, detected({ m: { contextLength: 100_000 } }))
    expect(merged.contextWindows?.gone).toBeUndefined()
    expect(merged.contextWindows?.m).toBe(100_000)
  })

  test("endpoint parsial: nilai model lain dipertahankan", () => {
    const prev: ProviderEntry = {
      id: "p",
      baseUrl: "u",
      apiKey: "k",
      models: ["a", "b"],
      contextWindows: { a: 100_000, b: 200_000 },
      contextWindowSources: { a: "endpoint", b: "endpoint" },
    }
    const merged = mergeDiscoveredCapacity(
      prev,
      detected({ a: { contextLength: 111_111 } }, ["a", "b"]),
    )
    expect(merged.contextWindows).toEqual({ a: 111_111, b: 200_000 })
  })

  test("tanpa metadata sama sekali → tidak mengubah apa pun", () => {
    const prev: ProviderEntry = {
      id: "p",
      baseUrl: "u",
      apiKey: "k",
      models: ["m"],
      contextWindows: { m: 1 },
    }
    expect(mergeDiscoveredCapacity(prev, detected({}))).toEqual({})
  })
})

describe("resolveContextWindow: presedensi lapis + asal nilai", () => {
  test("nilai dari endpoint menang atas katalog statis", () => {
    // Bug asli: endpoint melaporkan kapasitas nyata tapi nilainya dibuang, lalu
    // katalog/tebakan (32k) menang → sesi panjang mati.
    const cfg = {
      providers: [
        {
          id: "p",
          baseUrl: "u",
          apiKey: "k",
          models: ["unknown-model-xyz"],
          contextWindows: { "unknown-model-xyz": 1_048_576 },
          contextWindowSources: { "unknown-model-xyz": "endpoint" as const },
        },
      ],
    } as unknown as MinicodeConfig
    const r = resolveContextWindow(cfg, "p::unknown-model-xyz")
    expect(r.tokens).toBe(1_048_576)
    expect(r.origin).toBe("endpoint")
  })

  test("nilai operator dilaporkan dengan origin `user`", () => {
    const cfg = {
      providers: [
        { id: "p", baseUrl: "u", apiKey: "k", models: ["m"], contextWindows: { m: 200_000 } },
      ],
    } as unknown as MinicodeConfig
    const r = resolveContextWindow(cfg, "p::m")
    expect(r.tokens).toBe(200_000)
    expect(r.origin).toBe("user")
  })

  test("fallback terakhir kini 131072 (bukan 32k) dan tetap menandai safe-default", () => {
    const cfg = { providers: [] } as unknown as MinicodeConfig
    const r = resolveContextWindow(cfg, "never-heard-of-this")
    expect(r.source).toBe("safe-default")
    expect(r.tokens).toBe(131_072)
  })
})

// ── Fase 7.1: dukungan prompt caching dari metadata endpoint ────────────────
// KENAPA diuji ketat: `undefined` (endpoint diam) dan `false` (endpoint bilang
// tidak) punya akibat BERBEDA — yang pertama mempertahankan cache yang sudah
// jalan, yang kedua mematikannya. Menggabungkan keduanya = regresi senyap.
describe("extractModelCapacity: dukungan prompt caching (Fase 7.1)", () => {
  test("boolean eksplisit dibaca apa adanya", () => {
    expect(extractModelCapacity({ id: "m", prompt_caching: true }).promptCaching).toBe(true)
    expect(extractModelCapacity({ id: "m", prompt_caching: false }).promptCaching).toBe(false)
  })

  test("alias lain: supports_*, prompt_cache, cache_control", () => {
    expect(extractModelCapacity({ supports_prompt_caching: true }).promptCaching).toBe(true)
    expect(extractModelCapacity({ supports_cache: true }).promptCaching).toBe(true)
    expect(extractModelCapacity({ prompt_cache: true }).promptCaching).toBe(true)
    // Kehadiran objek (tanpa nilai true) tetap menandakan dukungan.
    expect(extractModelCapacity({ cache_control: {} }).promptCaching).toBe(true)
    expect(extractModelCapacity({ cache_control: { type: "ephemeral" } }).promptCaching).toBe(true)
  })

  test("field tidak ada = undefined, BUKAN false", () => {
    const r = extractModelCapacity({ id: "m", context_length: 128_000 })
    expect(r.promptCaching).toBeUndefined()
    expect("promptCaching" in r).toBe(false)
  })

  test("nilai kosong/falsy eksplisit = false", () => {
    expect(extractModelCapacity({ prompt_caching: "" }).promptCaching).toBe(false)
    expect(extractModelCapacity({ prompt_caching: 0 }).promptCaching).toBe(false)
    expect(extractModelCapacity({ prompt_caching: null }).promptCaching).toBe(false)
  })

  test("`top_provider` dipakai bila level atas tidak menyebut", () => {
    expect(extractModelCapacity({ top_provider: { prompt_caching: true } }).promptCaching).toBe(
      true,
    )
  })

  test("level atas menang atas top_provider", () => {
    const r = extractModelCapacity({
      prompt_caching: false,
      top_provider: { prompt_caching: true },
    })
    expect(r.promptCaching).toBe(false)
  })
})

describe("mergeDiscoveredCapacity: agregasi caching per provider", () => {
  const detect = (meta: Record<string, { promptCaching?: boolean }>) => ({
    models: Object.keys(meta),
    modelMetadata: Object.fromEntries(Object.entries(meta).map(([id, m]) => [id, { id, ...m }])),
    providerHint: "anthropic" as const,
    authFailed: false,
  })

  test("satu model mendukung = provider mendukung", () => {
    const r = mergeDiscoveredCapacity(undefined, detect({ a: { promptCaching: true }, b: {} }))
    expect(r.enablePromptCaching).toBe(true)
  })

  test("semua model menolak = provider dimatikan", () => {
    const r = mergeDiscoveredCapacity(
      undefined,
      detect({ a: { promptCaching: false }, b: { promptCaching: false } }),
    )
    expect(r.enablePromptCaching).toBe(false)
  })

  test("tak ada model yang menyebut = field tidak ditulis (default lama berlaku)", () => {
    const r = mergeDiscoveredCapacity(undefined, detect({ a: {}, b: {} }))
    expect("enablePromptCaching" in r).toBe(false)
  })

  test("campuran true+false = true menang (satu model bisa di-cache)", () => {
    const r = mergeDiscoveredCapacity(
      undefined,
      detect({ a: { promptCaching: false }, b: { promptCaching: true } }),
    )
    expect(r.enablePromptCaching).toBe(true)
  })
})
