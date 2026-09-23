import { expect, test } from "bun:test"
import { CUSTOM_PRESET_ID, findPreset, GATEWAY_PRESETS } from "../src/providers/presets.ts"

test("presets: daftar lengkap & id unik", () => {
  const ids = GATEWAY_PRESETS.map((p) => p.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids).toContain("openai")
  expect(ids).toContain("anthropic")
  expect(ids).toContain("openrouter")
  expect(ids).toContain("yolo-auto")
  expect(ids).toContain("deepseek")
  expect(ids).toContain("opencode-zen")
  expect(ids).toContain("google")
  // custom bukan preset — const terpisah untuk pilihan manual di wizard
  expect(CUSTOM_PRESET_ID).toBe("custom")
})

test("presets: setiap preset punya baseUrl http(s) & fallbackModels non-empty", () => {
  for (const p of GATEWAY_PRESETS) {
    expect(p.baseUrl).toMatch(/^https?:\/\//)
    expect(p.fallbackModels.length).toBeGreaterThan(0)
    expect(p.label.length).toBeGreaterThan(3)
  }
})

test("presets: findPreset mengambil by id", () => {
  expect(findPreset("openrouter")?.baseUrl).toBe("https://openrouter.ai/api/v1")
  expect(findPreset("nope")).toBeUndefined()
})
