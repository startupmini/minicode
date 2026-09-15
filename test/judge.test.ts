// LLM-judge: parse + prompt deterministik tanpa API.

import { describe, expect, test } from "bun:test"
import { buildJudgePrompt, parseJudgeScore } from "../bench/judge.ts"

describe("judge", () => {
  test("parse skor 0/1/2 + alasan", () => {
    expect(parseJudgeScore("SCORE: 2\nREASON: explains fix")).toEqual({
      score: 2,
      reason: "explains fix",
    })
    expect(parseJudgeScore("bla\nSCORE: 0\nREASON: empty")?.score).toBe(0)
  })

  test("tanpa SCORE = null (bukan vonis)", () => {
    expect(parseJudgeScore("looks good to me")).toBeNull()
    expect(parseJudgeScore("SCORE: 5\nREASON: x")).toBeNull()
  })

  test("prompt memuat rubrik + jawaban terpotong", () => {
    const p = buildJudgePrompt({
      taskDescription: "fix sum",
      taskPrompt: "fix it",
      answer: "y".repeat(5000),
      verifyPassed: true,
      verifyDetail: "ok",
    })
    expect(p).toContain("SCORE: <0, 1, or 2>")
    expect(p).toContain("PASSED")
    expect(p.length).toBeLessThan(4000)
  })
})
