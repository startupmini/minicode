// Kop ringkasan sesi (exit): logo kiri + detail sesi kanan, dan format durasi.

import { describe, expect, test } from "bun:test"
import {
  formatDuration,
  renderSessionSummary,
  SESSION_LOGO_ROWS,
} from "../src/ui/render/session-summary.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"

describe("session summary (kop)", () => {
  test("formatDuration memformat detik & menit", () => {
    expect(formatDuration(45_000)).toBe("45s")
    expect(formatDuration(65_000)).toBe("1m 5s")
    expect(formatDuration(192_000)).toBe("3m 12s")
    expect(formatDuration(0)).toBe("0s")
  })

  test("renderSessionSummary memuat logo + seluruh detail", () => {
    const out = stripAnsi(
      renderSessionSummary({
        sessionId: "sess_abc123",
        model: "acme::flash",
        totalTokens: 12_345,
        cost: 0.05,
        durationMs: 192_000,
      }),
    )
    expect(out).toContain("sess_abc123")
    expect(out).toContain("acme::flash")
    expect(out).toContain("12,345 tokens")
    expect(out).toContain("3m 12s")
    // Logo (3 baris block art) ikut ter-cetak.
    for (const row of SESSION_LOGO_ROWS) expect(out).toContain(row.trim())
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
