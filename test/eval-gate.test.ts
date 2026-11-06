// Gate baterai eval: lolos/gagal deterministik dari fixture (tanpa file/API).

import { describe, expect, test } from "bun:test"
import { computeDeterministicEvalScore, evaluateGate } from "../bench/eval-gate.ts"
import { classifyBenchFailure } from "../bench/runner.ts"

const perfect = {
  fake: false,
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
      fake: false,
      resolveRate: 0,
      runsPerTask: 2,
      results: [{ id: "a", passedCount: 1, runs: 2, medianTokens: 100 }],
    }
    expect(evaluateGate(part, { minRate: 0, maxMedianTokens: 0, allowPartial: false }).ok).toBe(
      false,
    )
    expect(evaluateGate(part, { minRate: 0, maxMedianTokens: 0, allowPartial: true }).ok).toBe(true)
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

  test("menolak rate agregat di luar rentang dan agregat yang tidak cocok dengan hasil", () => {
    expect(
      evaluateGate(
        { ...perfect, resolveRate: 1.2 },
        { minRate: 1, maxMedianTokens: 0, allowPartial: false },
      ).ok,
    ).toBe(false)
    expect(
      evaluateGate(
        { ...perfect, resolveRate: 0.5 },
        { minRate: 0, maxMedianTokens: 0, allowPartial: false },
      ).failures.join(" "),
    ).toContain("tidak cocok")
  })

  test("menolak hitungan run yang mustahil dan median token yang hilang", () => {
    const impossible = {
      fake: false,
      resolveRate: 1,
      runsPerTask: 2,
      results: [{ id: "a", passedCount: 3, runs: 2, medianTokens: 10 }],
    }
    expect(
      evaluateGate(impossible, { minRate: 0, maxMedianTokens: 0, allowPartial: true }).ok,
    ).toBe(false)
    const noTokens = {
      fake: false,
      resolveRate: 1,
      runsPerTask: 1,
      results: [{ id: "a", passedCount: 1, runs: 1 }],
    }
    expect(
      evaluateGate(noTokens, {
        minRate: 1,
        maxMedianTokens: 100,
        allowPartial: false,
      }).failures.join(" "),
    ).toContain("medianTokens")
  })

  test("hasil provider fake hanya diterima sebagai smoke, bukan bukti kualitas", () => {
    const v = evaluateGate(
      { ...perfect, fake: true },
      { minRate: 1, maxMedianTokens: 0, allowPartial: false },
    )
    expect(v.ok).toBe(false)
    expect(v.failures.join(" ")).toContain("smoke")
    const unknownOrigin = evaluateGate(
      { resolveRate: 1, results: perfect.results },
      { minRate: 1, maxMedianTokens: 0, allowPartial: false },
    )
    expect(unknownOrigin.ok).toBe(false)
    expect(unknownOrigin.failures.join(" ")).toContain("fake:false")
  })
})

describe("deterministic eval input validation", () => {
  test("rate di luar [0,1], threshold invalid, dan safety hilang gagal tertutup", () => {
    const invalidRate = computeDeterministicEvalScore({
      taskCompletionRate: 1.2,
      verificationPassRate: 1,
      stepsUsed: 1,
      maxSteps: 10,
      safetyViolations: 0,
    })
    expect(invalidRate.ok).toBe(false)
    expect(invalidRate.components.taskCompletion).toBe(0)

    const missingSafety = computeDeterministicEvalScore({
      taskCompletionRate: 1,
      verificationPassRate: 1,
      stepsUsed: 1,
      maxSteps: 10,
    })
    expect(missingSafety.ok).toBe(false)
    expect(missingSafety.components.safetyCompliance).toBe(0)

    const invalidThreshold = computeDeterministicEvalScore(
      {
        taskCompletionRate: 1,
        verificationPassRate: 1,
        stepsUsed: 1,
        maxSteps: 10,
        safetyViolations: 0,
      },
      { threshold: -1 },
    )
    expect(invalidThreshold.ok).toBe(false)
    expect(invalidThreshold.failures.join(" ")).toContain("threshold")
  })

  test("rejects negative safety and impossible step counts", () => {
    const verdict = computeDeterministicEvalScore({
      taskCompletionRate: 1,
      verificationPassRate: 1,
      stepsUsed: 11,
      maxSteps: 10,
      safetyViolations: -1,
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.components.safetyCompliance).toBe(0)
    expect(verdict.failures.join(" ")).toContain("safetyViolations")
    expect(verdict.failures.join(" ")).toContain("melebihi")
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
