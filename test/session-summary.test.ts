// Kop ringkasan sesi (exit): wordmark "minicode" + detail sesi, dan format durasi.

import { describe, expect, test } from "bun:test"
import { formatDuration, renderSessionSummary } from "../src/ui/render/session-summary.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"

describe("session summary (kop)", () => {
  test("formatDuration memformat detik & menit", () => {
    expect(formatDuration(45_000)).toBe("45s")
    expect(formatDuration(65_000)).toBe("1m 5s")
    expect(formatDuration(192_000)).toBe("3m 12s")
    expect(formatDuration(0)).toBe("0s")
  })

  test("renderSessionSummary memuat wordmark + seluruh detail", () => {
    const out = stripAnsi(
      renderSessionSummary({
        sessionId: "sess_abc123",
        model: "acme::flash",
        totalTokens: 12_345,
        cost: 0.05,
        durationMs: 192_000,
      }),
    )
    expect(out).toContain("minicode")
    expect(out).toContain("sess_abc123")
    expect(out).toContain("acme::flash")
    expect(out).toContain("12,345 tokens")
    expect(out).toContain("3m 12s")
  })

  test("sessionId/model disanitasi (ANSI mentah dibuang)", () => {
    const out = renderSessionSummary({
      sessionId: "sid\x1b[31mRED",
      model: "bold\x1b[31mRED",
      totalTokens: 0,
      durationMs: 0,
    })
    expect(out).not.toContain("\x1b[31m")
    expect(out).toContain("RED")
  })

  test("tanpa cost: tetap stabil tanpa bagian biaya", () => {
    const out = stripAnsi(
      renderSessionSummary({
        sessionId: "s",
        model: "m",
        totalTokens: 100,
        durationMs: 1000,
      }),
    )
    expect(out).toContain("s")
    expect(out).toContain("1s")
  })
})
