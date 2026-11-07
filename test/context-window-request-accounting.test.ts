import { expect, test } from "bun:test"
import { createEventBus } from "#minicore/core/events.ts"
import { createUsageCollector, watchContextWindowLimit } from "../src/policy/usage.ts"

test("context-window output allowance uses current request, not cumulative turn input", () => {
  const bus = createEventBus()
  const usage = createUsageCollector(bus, "deepseek-v4.1-flash-1017")
  const cutoffs: { allowed: number; actual: number }[] = []
  const stop = watchContextWindowLimit({
    bus,
    windowTokens: 1_000_000,
    getRequestTokens: () => usage.currentRequestTokens(),
    onOver: (allowed, actual) => cutoffs.push({ allowed, actual }),
  })

  bus.emit({ type: "turn:started", turn: 0 })
  bus.emit({
    type: "provider:extension",
    kind: "usage",
    data: { inputTokens: 990_000, outputTokens: 5_000, totalTokens: 995_000 },
  })
  bus.emit({ type: "step:started", step: {} as never })
  bus.emit({
    type: "provider:extension",
    kind: "usage",
    data: { inputTokens: 10_000, outputTokens: 18_058, totalTokens: 28_058 },
  })

  // Total pemakaian turn melewati 1 juta, tetapi request kedua masih jauh
  // di bawah window provider; pemakaian lintas-request bukan context aktif.
  expect(usage.get().inputTokens).toBe(1_000_000)
  expect(usage.get().outputTokens).toBe(23_058)
  expect(usage.currentRequestTokens()).toEqual({ inputTokens: 10_000, outputTokens: 18_058 })
  expect(cutoffs).toEqual([])
  stop()
})
