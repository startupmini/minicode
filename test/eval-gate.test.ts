// Gate baterai eval: lolos/gagal deterministik dari fixture (tanpa file/API).

import { describe, expect, test } from "bun:test"
import { evaluateGate } from "../bench/eval-gate.ts"

const perfect = {
  resolveRate: 1,
  runsPerTask: 2,
  results: [
    { id: "a", passedCount: 2, runs: 2, medianTokens: 100 },
    { id: "b", passedCount: 2, runs: 2, medianTokens: 200 },
  ],
}

describe("eval-gate", () => {
  test("baterai sempurna lolos", () => {
    const v = evaluateGate(perfect, { minRate: 1, maxMedianTokens: 0, allowPartial: false })
    expect(v.ok).toBe(true)
  })

  test("rate di bawah min gagal dengan alasan jelas", () => {
    const v = evaluateGate(
      { ...perfect, resolveRate: 0.5 },
      { minRate: 1, maxMedianTokens: 0, allowPartial: false },
    )
    expect(v.ok).toBe(false)
    expect(v.failures.join(" ")).toContain("0.5")
  })

  test("partial tanpa flag gagal; dengan flag lolos bila rate cukup", () => {
    const part = {
      resolveRate: 1,
      runsPerTask: 2,
      results: [{ id: "a", passedCount: 1, runs: 2, medianTokens: 100 }],
    }
    expect(evaluateGate(part, { minRate: 1, maxMedianTokens: 0, allowPartial: false }).ok).toBe(
      false,
    )
    expect(evaluateGate(part, { minRate: 1, maxMedianTokens: 0, allowPartial: true }).ok).toBe(true)
  })

  test("median token di atas max gagal", () => {
    const v = evaluateGate(perfect, { minRate: 1, maxMedianTokens: 150, allowPartial: false })
    expect(v.ok).toBe(false)
    expect(v.failures.join(" ")).toContain("median")
  })

  test("results kosong/hilang gagal (bukan lolos diam)", () => {
    expect(evaluateGate({}, { minRate: 1, maxMedianTokens: 0, allowPartial: false }).ok).toBe(false)
    expect(
      evaluateGate(
        { resolveRate: 1, results: [] },
        { minRate: 1, maxMedianTokens: 0, allowPartial: false },
      ).ok,
    ).toBe(false)
  })
})
