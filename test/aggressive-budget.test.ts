// Ambang kompaksi host-side lebih agresif: ringkas lebih awal (65%/85%) daripada
// default kernel (75%/90%) supaya konteks jarang menyentuh dinding.
import { describe, expect, test } from "bun:test"
import { aggressiveBudgetPolicy } from "../src/app/session.ts"

describe("aggressiveBudgetPolicy", () => {
  test("ambang medium/high lebih rendah dari default kernel", () => {
    const e = aggressiveBudgetPolicy.evaluate
    expect(e({ usedTokens: 64, limitTokens: 100 })).toBe("low")
    expect(e({ usedTokens: 65, limitTokens: 100 })).toBe("medium")
    expect(e({ usedTokens: 85, limitTokens: 100 })).toBe("high")
    expect(e({ usedTokens: 100, limitTokens: 100 })).toBe("critical")
  })

  test("shouldCompact menahan hanya saat low", () => {
    expect(aggressiveBudgetPolicy.shouldCompact("low")).toBe(false)
    expect(aggressiveBudgetPolicy.shouldCompact("medium")).toBe(true)
    expect(aggressiveBudgetPolicy.shouldCompact("high")).toBe(true)
    expect(aggressiveBudgetPolicy.shouldCompact("critical")).toBe(true)
  })
})