// Test eskalasi adaptif jendela konteks + anggaran probe.
//
// Fokus: tangga naik satu langkah, batas atas absolut, dan bahwa anggaran
// probe berlaku UNIVERSAL — tanpa cabang nama model/vendor/status berbayar.
import { describe, expect, test } from "bun:test"
import {
  CONTEXT_WINDOW_ESCALATION_CEILING,
  CONTEXT_WINDOW_LADDER,
  canProbe,
  emptyProbeBudget,
  isContextOverflowError,
  isValidWindow,
  nextLadderStep,
  recordProbe,
  syntheticPadding,
} from "../src/policy/context-escalation.ts"

describe("tangga eskalasi", () => {
  test("naik tepat satu anak tangga, tidak melompat", () => {
    expect(nextLadderStep(131_072)).toBe(262_144)
    expect(nextLadderStep(262_144)).toBe(524_288)
    expect(nextLadderStep(524_288)).toBe(1_048_576)
    expect(nextLadderStep(1_048_576)).toBe(2_097_152)
  })

  test("nilai di antara anak tangga naik ke anak tangga berikutnya di atasnya", () => {
    expect(nextLadderStep(150_000)).toBe(262_144)
    expect(nextLadderStep(1_000)).toBe(131_072)
  })

  test("di batas atas → tidak ada langkah berikutnya", () => {
    expect(nextLadderStep(CONTEXT_WINDOW_ESCALATION_CEILING)).toBeUndefined()
    expect(nextLadderStep(9_999_999)).toBeUndefined()
  })

  test("tidak pernah melebihi batas atas absolut", () => {
    let cur = 1
    for (let i = 0; i < 20; i++) {
      const next = nextLadderStep(cur)
      if (next === undefined) break
      expect(next).toBeLessThanOrEqual(CONTEXT_WINDOW_ESCALATION_CEILING)
      cur = next
    }
    expect(cur).toBe(CONTEXT_WINDOW_ESCALATION_CEILING)
  })

  test("tangga menutupi seluruh jendela model publik (≥ 2M)", () => {
    expect(Math.max(...CONTEXT_WINDOW_LADDER)).toBeGreaterThanOrEqual(2_097_152)
  })
})

describe("isContextOverflowError: hanya konteks yang boleh memicu probe", () => {
  test("kategori context_length_exceeded → ya", () => {
    expect(isContextOverflowError({ category: "context_length_exceeded" })).toBe(true)
  })

  test("prosa gateway soal konteks → ya", () => {
    for (const message of [
      "maximum context length is 128000 tokens",
      "This model's maximum context window is 8192 tokens",
      "prompt is too long",
      "too many tokens in request",
    ]) {
      expect(isContextOverflowError({ message })).toBe(true)
    }
  })

  test("rate limit / kuota / auth / server / jaringan TIDAK memicu probe", () => {
    for (const error of [
      { category: "rate_limit", message: "429 Too Many Requests" },
      { category: "quota", message: "402 payment required" },
      { category: "auth", message: "401 unauthorized" },
      { category: "server", message: "500 internal server error" },
      { message: "network unreachable" },
      { message: "timeout after 30000ms" },
      {},
      null,
      undefined,
      "string error",
    ]) {
      expect(isContextOverflowError(error)).toBe(false)
    }
  })
})

describe("anggaran probe: universal, tak bisa dibanjiri", () => {
  const limits = { perModelPerDay: 2, perProcess: 5 }
  const key = "someprovider::somemodel"

  test("probe pertama dan kedua diizinkan, ketiga ditolak", () => {
    let state = emptyProbeBudget()
    const t0 = 1_000_000
    expect(canProbe(state, key, { ...limits, now: () => t0 }).allowed).toBe(true)
    state = recordProbe(state, key, "attempt", { now: () => t0 })
    expect(canProbe(state, key, { ...limits, now: () => t0 }).allowed).toBe(true)
    state = recordProbe(state, key, "attempt", { now: () => t0 })
    const third = canProbe(state, key, { ...limits, now: () => t0 })
    expect(third.allowed).toBe(false)
    expect(third.reason).toBe("per-model")
  })

  test("jendela 24 jam bergulir: hitungan lama tidak menahan selamanya", () => {
    const t0 = 1_000_000
    let state = emptyProbeBudget()
    state = recordProbe(state, key, "attempt", { now: () => t0 })
    state = recordProbe(state, key, "attempt", { now: () => t0 })
    expect(canProbe(state, key, { ...limits, now: () => t0 }).allowed).toBe(false)
    const nextDay = t0 + 24 * 60 * 60 * 1000 + 1
    expect(canProbe(state, key, { ...limits, now: () => nextDay }).allowed).toBe(true)
  })

  test("anggaran per-proses berlaku lintas model", () => {
    let state = emptyProbeBudget()
    for (let i = 0; i < 5; i++)
      state = recordProbe(state, `p::m${i}`, "attempt", { now: () => 1_000 })
    const res = canProbe(state, "p::other", { ...limits, now: () => 1_000 })
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe("per-process")
  })

  test("endpoint menolak probe → backoff, bukan dicoba berulang", () => {
    const t0 = 1_000_000
    let state = emptyProbeBudget()
    state = recordProbe(state, key, "rejected", { now: () => t0 })
    const res = canProbe(state, key, { ...limits, now: () => t0 + 1_000 })
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe("backoff")
    // Setelah backoff 6 jam lewat, boleh dicoba lagi.
    const later = t0 + 6 * 60 * 60 * 1000 + 1
    expect(canProbe(state, key, { ...limits, now: () => later }).allowed).toBe(true)
  })

  test("kill-switch mematikan probe sepenuhnya", () => {
    const prev = process.env.MINICODE_CONTEXT_PROBE
    try {
      process.env.MINICODE_CONTEXT_PROBE = "0"
      const res = canProbe(emptyProbeBudget(), key, limits)
      expect(res.allowed).toBe(false)
      expect(res.reason).toBe("kill-switch")
    } finally {
      // Pulihkan agar test lain tidak terpengaruh.
      if (prev === undefined) delete process.env.MINICODE_CONTEXT_PROBE
      else process.env.MINICODE_CONTEXT_PROBE = prev
    }
  })
})

describe("validasi & padding probe", () => {
  test("nilai jendela di luar batas ditolak", () => {
    expect(isValidWindow(131_072)).toBe(true)
    expect(isValidWindow(0)).toBe(false)
    expect(isValidWindow(-1)).toBe(false)
    expect(isValidWindow(1.5)).toBe(false)
    expect(isValidWindow(CONTEXT_WINDOW_ESCALATION_CEILING + 1)).toBe(false)
    expect(isValidWindow("131072")).toBe(false)
  })

  test("padding sintetis panjangnya proporsional dan tidak membocorkan isi sesi", () => {
    const padding = syntheticPadding(1_000)
    expect(padding.length).toBe(4_000)
    expect(padding).not.toContain("undefined")
  })
})
