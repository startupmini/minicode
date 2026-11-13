// Test anggaran konteks terpusat — reserve output, ambang kompaksi, dan ambang
// reklasifikasi. Semua murni: angka masuk, angka keluar.
//
// Invariant yang dijaga di sini adalah invariant UNIVERSAL: berlaku untuk
// jendela 32k maupun 2M, tanpa menyebut model atau vendor mana pun.
import { describe, expect, test } from "bun:test"
import {
  COMPACT_BUFFER_TOKENS,
  contextBudgetFor,
  contextReclassifyThreshold,
  OUTPUT_RESERVE_MAX_TOKENS,
  OUTPUT_RESERVE_MIN_TOKENS,
  outputReserveFor,
  SMALL_WINDOW_THRESHOLD_TOKENS,
} from "../src/policy/context-budget.ts"

describe("outputReserveFor: reserve output proporsional", () => {
  test("jendela 1M dengan max_output 65536 → reserve 20k (bukan 256)", () => {
    // Nilai lama `min(256, limit/10)` = 256 token. Untuk jendela 1M itu 0,02%:
    // request yang tepat di ambang batas tetap kehabisan ruang jawaban.
    expect(outputReserveFor(1_048_576, 65_536)).toBe(OUTPUT_RESERVE_MAX_TOKENS)
  })

  test("model berbatas output kecil tetap dapat lantai 4096", () => {
    expect(outputReserveFor(200_000, 2_048)).toBe(OUTPUT_RESERVE_MIN_TOKENS)
  })

  test("tanpa metadata output → default 20k", () => {
    expect(outputReserveFor(1_048_576, undefined)).toBe(OUTPUT_RESERVE_MAX_TOKENS)
  })

  test("jendela kecil: reserve tak pernah memakan seluruh jendela", () => {
    // Untuk jendela yang cukup besar, reserve tetap di bawah 40%.
    for (const w of [32_000, 64_000, 131_072]) {
      const reserve = outputReserveFor(w, 4_096)
      expect(reserve).toBeGreaterThanOrEqual(OUTPUT_RESERVE_MIN_TOKENS)
      expect(reserve).toBeLessThanOrEqual(Math.floor(w * 0.4))
      expect(reserve).toBeLessThan(w)
    }
  })

  test("jendela sangat kecil: lantai 4096 menang atas plafon proporsional", () => {
    // Jendela 8k tak bisa memenuhi keduanya (4096 lantai vs 3200 plafon 40%).
    // Lantai dimenangkan: reserve di bawah 4096 berarti model tak punya ruang
    // jawaban sama sekali — lebih buruk daripada jendela efektif yang sempit.
    expect(outputReserveFor(8_000, 4_096)).toBe(OUTPUT_RESERVE_MIN_TOKENS)
  })

  test("monotonik: jendela lebih besar tak pernah menghasilkan reserve lebih kecil", () => {
    let prev = 0
    for (const w of [8_000, 32_000, 131_072, 262_144, 1_048_576, 2_097_152]) {
      const r = outputReserveFor(w, 65_536)
      expect(r).toBeGreaterThanOrEqual(prev)
      prev = r
    }
  })
})

describe("contextBudgetFor: seluruh angka anggaran konsisten", () => {
  test("compactTrigger < effectiveWindow < window", () => {
    for (const w of [32_000, 131_072, 1_048_576, 2_097_152]) {
      const b = contextBudgetFor(w, 65_536)
      expect(b.effectiveWindow).toBeLessThan(b.windowTokens)
      expect(b.compactTrigger).toBeLessThan(b.effectiveWindow)
      expect(b.blockingLimit).toBeLessThanOrEqual(b.windowTokens)
    }
  })

  test("jendela kecil (< 64k) memakai buffer terskala, bukan 13k penuh", () => {
    const small = contextBudgetFor(32_000, 4_096)
    const large = contextBudgetFor(1_048_576, 65_536)
    // Buffer besar penuh untuk jendela ≥ ambang.
    expect(large.effectiveWindow - large.compactTrigger).toBe(COMPACT_BUFFER_TOKENS)
    // Buffer kecil lebih kecil dari itu — 13k dari 32k akan menghabiskan 40%.
    expect(small.effectiveWindow - small.compactTrigger).toBeLessThan(COMPACT_BUFFER_TOKENS)
    expect(32_000).toBeLessThan(SMALL_WINDOW_THRESHOLD_TOKENS)
  })

  test("jendela raksasa tetap punya trigger positif (bukan 0/habis)", () => {
    const b = contextBudgetFor(2_097_152, 65_536)
    expect(b.compactTrigger).toBeGreaterThan(1_000_000)
  })

  test("input jendela rusak (0/NaN/negatif) tidak menghasilkan angka negatif", () => {
    for (const w of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const b = contextBudgetFor(w, 4_096)
      expect(b.compactTrigger).toBeGreaterThanOrEqual(0)
      expect(b.effectiveWindow).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(b.outputReserve)).toBe(true)
    }
  })
})

describe("contextReclassifyThreshold: ambang 400 relatif jendela", () => {
  test("jendela besar tetap memakai batas atas 50k", () => {
    expect(contextReclassifyThreshold(1_048_576)).toBe(50_000)
    expect(contextReclassifyThreshold(200_000)).toBe(50_000)
  })

  test("jendela kecil bisa menempuh compact-and-retry (regresi R4)", () => {
    // Bug laten: ambang 50k mutlak > jendela 32k → model 32k TIDAK PERNAH bisa
    // menempuh jalur recovery. Ambang relatif menutup itu.
    const t = contextReclassifyThreshold(32_000)
    expect(t).toBe(16_000)
    expect(t).toBeLessThan(32_000)
  })

  test("ambang selalu ≤ setengah jendela dan ≤ 50k", () => {
    for (const w of [8_000, 32_000, 100_000, 1_048_576]) {
      const t = contextReclassifyThreshold(w)
      expect(t).toBeLessThanOrEqual(50_000)
      expect(t).toBeLessThanOrEqual(w * 0.5)
    }
  })
})
