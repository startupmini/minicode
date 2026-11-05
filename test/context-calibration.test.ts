// P1.4 — regresi kalibrasi konteks (gate in-flight + drift + cap).
//
// Latar: gateway yang mengirim `usage` kumulatif per-chunk SSE membuat
// `local` beku sementara `actual` melonjak; sampel itu BUKAN drift tokenizer.
// Gate harus membuang sampel berbahaya dari perhitungan `factor`, tanpa
// membuang drift lintas-turn yang sah maupun mematikan cap 64.

import { describe, expect, test } from "bun:test"
import { createCalibratedEstimator } from "../src/policy/context.ts"

describe("P1.4 calibration gate", () => {
  test("sampel in-flight (local beku, actual > 3x) tidak menginflasi factor", () => {
    const cal = createCalibratedEstimator()
    const first = cal.recordTokenCalibrationSample(5026, 6413)
    expect(first.factor).toBeCloseTo(6413 / 5026, 6)

    const poisoned = cal.recordTokenCalibrationSample(5026, 28024)
    expect(poisoned.factor).toBeCloseTo(6413 / 5026, 6)
    // Nilai mentah tetap tercatat sebagai observasi, tetapi factor (yang dipakai
    // estimator produksi) tidak ikut meledak.
    expect(poisoned.lastProviderTokens).toBe(28024)
  })

  test("drift lintas-turn yang sah tetap terkalibrasi", () => {
    const cal = createCalibratedEstimator()
    const s1 = cal.recordTokenCalibrationSample(100, 180)
    expect(s1.factor).toBeCloseTo(1.8, 6)
    const s2 = cal.recordTokenCalibrationSample(200, 400)
    expect(s2.factor).toBeCloseTo(2, 6)
  })

  test("sampel pertama yang besar tetap dihormati (cap 64, bukan gate in-flight)", () => {
    const cal = createCalibratedEstimator()
    const snap = cal.recordTokenCalibrationSample(100, 12000)
    expect(snap.factor).toBe(64)
  })

  test("factor tidak pernah < 1 (estimasi lokal tidak dilemahkan)", () => {
    const cal = createCalibratedEstimator()
    const snap = cal.recordTokenCalibrationSample(1000, 100)
    expect(snap.factor).toBe(1)
  })
})
