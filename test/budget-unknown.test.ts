// Hardening F-06: budget tidak boleh fail-open untuk harga tak dikenal;
// F-18: abort budget membawa identitas kind budget_exceeded.
import { expect, test } from "bun:test"
import { AgentError } from "#minicore/core/errors.ts"
import { extractPricing, findPrice } from "../src/policy/pricing.ts"
import { budgetExceededError, budgetStatus, costFor } from "../src/policy/usage.ts"

test("F-06: budgetStatus fail-closed bila ada pemakaian tanpa harga", () => {
  expect(budgetStatus(1, undefined, false)).toBe("ok") // tokens 0: belum belanja
  expect(budgetStatus(1, undefined, true)).toBe("unknown-strict")
  expect(budgetStatus(1, undefined, false, 0)).toBe("ok")
  expect(budgetStatus(1, undefined, false, 150)).toBe("unknown-strict")
  expect(budgetStatus(undefined, undefined, false, 150)).toBe("ok") // tanpa budget = no-op
  expect(budgetStatus(1, 2, false, 10)).toBe("over")
  expect(budgetStatus(1, 0.5, false, 10)).toBe("ok")
})

test("F-06: harga negatif di payload = dibuang (bukan biaya negatif)", () => {
  // Batas validasi adalah ekstraksi/normalisasi (extractPricing ← sync,
  // normalizePriceMap ← loadPricingOverlay): harga negatif/NaN tidak pernah
  // menjadi entri harga, sehingga findPrice → undefined → budget fail-closed.
  const out = extractPricing({
    prov: {
      models: {
        neg: { cost: { input: -5, output: 10 } },
        nan: { cost: { input: NaN, output: 10 } },
        ok: { cost: { input: 5, output: 10 } },
      },
    },
  })
  expect(out.neg).toBeUndefined()
  expect(out.nan).toBeUndefined()
  expect(out.ok).toEqual({ input: 5, output: 10 })
  expect(findPrice("m-ok", { "m-ok": { input: 5, output: 10 } })).toEqual({ input: 5, output: 10 })
})

test("F-06: costFor tak pernah negatif", () => {
  const c = costFor("gpt-4o-mini", -100, -50)
  expect(c).not.toBeUndefined()
  expect(c!).toBeGreaterThanOrEqual(0)
  const c2 = costFor("gpt-4o-mini", 1000, 500)
  expect(c2).toBeGreaterThan(0)
  expect(costFor("model-tanpa-harga-xyz", 1000, 500)).toBeUndefined()
})

test("F-18: budgetExceededError membawa kind budget_exceeded", () => {
  const e = budgetExceededError()
  expect(e).toBeInstanceOf(AgentError)
  expect((e as AgentError).kind).toBe("budget_exceeded")
})
