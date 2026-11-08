// Katalog jendela konteks built-in: keluarga model umum dikenali tanpa config,
// sehingga tak langsung jatuh ke fallback 32k.
import { describe, expect, test } from "bun:test"
import type { MinicodeConfig } from "../src/config.ts"
import { resolveContextWindow } from "../src/policy/context-window.ts"
import {
  findContextWindowFromCatalog,
  normalizeModelId,
} from "../src/policy/context-window-catalog.ts"

describe("context window catalog", () => {
  test("normalisasi versi v- agar tak menggagalkan pencocokan keluarga", () => {
    expect(normalizeModelId("DeepSeek-v-4.1-flash-1017")).toBe("deepseek-v4.1-flash-1017")
  })

  test.each([
    ["deepseek-v-4.1-flash-1017", 1_000_000],
    ["deepseek-v4", 1_000_000],
    ["deepseek-chat", 131_072],
    ["gpt-5-mini", 400_000],
    ["gpt-4.1", 1_000_000],
    ["gpt-4o", 128_000],
    ["claude-sonnet-4", 200_000],
    ["gemini-2.5-pro", 2_000_000],
    ["qwen3-coder-plus", 262_144],
  ])("keluarga %s → %d token", (model, expected) => {
    expect(findContextWindowFromCatalog(model as string)).toBe(expected)
  })

  test("keluarga tak dikenal → undefined", () => {
    expect(findContextWindowFromCatalog("some-unknown-model")).toBeUndefined()
  })

  test("longest-family menang: deepseek-v4 mengalahkan deepseek", () => {
    expect(findContextWindowFromCatalog("deepseek-v4-flash")).toBe(1_000_000)
  })
})

describe("resolveContextWindow integrasi katalog", () => {
  const cfg = { providers: [] } as unknown as MinicodeConfig

  test("model dikenal tanpa config → source catalog, bukan safe-default 32k", () => {
    const r = resolveContextWindow(cfg, "deepseek-v-4.1-flash-1017")
    expect(r.source).toBe("catalog")
    expect(r.tokens).toBe(1_000_000)
  })

  test("explicit contextWindows tetap menang atas katalog", () => {
    const cfg2 = {
      providers: [
        {
          id: "p",
          models: ["deepseek-v-4.1-flash-1017"],
          contextWindows: { "deepseek-v-4.1-flash-1017": 12345 },
        },
      ],
    } as unknown as MinicodeConfig
    const r = resolveContextWindow(cfg2, "p::deepseek-v-4.1-flash-1017")
    expect(r.source).toBe("model")
    expect(r.tokens).toBe(12345)
  })

  test("model tak dikenal tanpa config → tetap safe-default 32k", () => {
    const r = resolveContextWindow(cfg, "totally-unknown-model")
    expect(r.source).toBe("safe-default")
    expect(r.tokens).toBe(32_000)
  })
})
