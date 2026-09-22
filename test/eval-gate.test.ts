// Gate baterai eval: lolos/gagal deterministik dari fixture (tanpa file/API).

import { describe, expect, test } from "bun:test"
import { evaluateGate } from "../bench/eval-gate.ts"
import { classifyBenchFailure } from "../bench/runner.ts"

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

  test("F2.2 observe-tokens: pelanggaran token jadi peringatan, rate tetap lolos", () => {
    // Gagal di kode lama: warnings tak ada + ok=false.
    const v = evaluateGate(perfect, {
      minRate: 1,
      maxMedianTokens: 150,
      allowPartial: false,
      observeTokens: true,
    })
    expect(v.ok).toBe(true)
    expect(v.failures).toEqual([])
    expect(v.warnings.length).toBeGreaterThan(0)
    expect(v.warnings.join(" ")).toContain("median")
  })

  test("F2.2 tanpa observe: pelanggaran token tetap gagal", () => {
    const v = evaluateGate(perfect, {
      minRate: 1,
      maxMedianTokens: 150,
      allowPartial: false,
      observeTokens: false,
    })
    expect(v.ok).toBe(false)
    expect(v.warnings).toEqual([])
  })
})

describe("F2.3 classifyBenchFailure", () => {
  const base = { verifyPassed: false, steps: 5, maxSteps: 50 }
  test("lolos verify -> null (bukan gagal)", () => {
    expect(classifyBenchFailure({ ...base, verifyPassed: true })).toBeNull()
  })
  test("error -> ABORT (menang atas segalanya)", () => {
    expect(classifyBenchFailure({ ...base, error: "boom" })).toBe("ABORT")
    expect(classifyBenchFailure({ ...base, verifyPassed: true, error: "boom" })).toBe("ABORT")
  })
  test("steps <= 1 -> NO_PROGRESS", () => {
    expect(classifyBenchFailure({ ...base, steps: 0 })).toBe("NO_PROGRESS")
    expect(classifyBenchFailure({ ...base, steps: 1 })).toBe("NO_PROGRESS")
  })
  test("steps >= maxSteps -> MAX_STEPS", () => {
    expect(classifyBenchFailure({ ...base, steps: 50 })).toBe("MAX_STEPS")
    expect(classifyBenchFailure({ ...base, steps: 99 })).toBe("MAX_STEPS")
  })
  test("berhenti sendiri tapi verify gagal -> VERIFY_FAIL", () => {
    expect(classifyBenchFailure(base)).toBe("VERIFY_FAIL")
  })
})
