// Test pemisahan usage turn vs sesi.
//
// Regresi yang ditemukan lewat uji live: `usage.reset()` dipanggil per turn oleh
// driver REPL, dan dulu ia menghapus SATU-SATUNYA akumulator. Akibatnya
// 51.915 token nyata dilaporkan sebagai 0, `/cost` yang berjudul "biaya sesi"
// selalu 0 setelah turn pertama, header REPL kembali $0.0000, dan `--budget`
// tidak pernah bisa terpicu berapa pun yang dipakai.

import { describe, expect, test } from "bun:test"
import { createEventBus } from "#minicore/core/events.ts"
import { createUsageCollector, watchBudgetLimit } from "../src/policy/usage.ts"

const emitUsage = (
  bus: ReturnType<typeof createEventBus>,
  inputTokens: number,
  outputTokens: number,
  extra: Record<string, unknown> = {},
) => {
  bus.emit({
    type: "provider:extension",
    kind: "usage",
    data: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...extra },
  } as never)
}

describe("usage: turn vs sesi", () => {
  test("keduanya bertambah bersama sebelum reset", () => {
    const bus = createEventBus()
    const u = createUsageCollector(bus, "gpt-4o-mini")
    emitUsage(bus, 100, 50)
    expect(u.get().totalTokens).toBe(150)
    expect(u.getSession().totalTokens).toBe(150)
  })

  test("reset menghapus turn tapi TIDAK menghapus sesi", () => {
    const bus = createEventBus()
    const u = createUsageCollector(bus, "gpt-4o-mini")
    emitUsage(bus, 100, 50)
    u.reset()
    expect(u.get().totalTokens).toBe(0)
    expect(u.getSession().totalTokens).toBe(150)
  })

  test("sesi mengakumulasi lintas beberapa turn", () => {
    const bus = createEventBus()
    const u = createUsageCollector(bus, "gpt-4o-mini")
    for (let i = 0; i < 3; i++) {
      emitUsage(bus, 1000, 100)
      u.reset() // driver melakukan ini setiap turn
    }
    expect(u.get().totalTokens).toBe(0)
    expect(u.getSession().totalTokens).toBe(3300)
    expect(u.getSession().inputTokens).toBe(3000)
    expect(u.getSession().outputTokens).toBe(300)
  })

  test("biaya sesi ikut terakumulasi, bukan nol", () => {
    const bus = createEventBus()
    const u = createUsageCollector(bus, "gpt-4o-mini")
    // gpt-4o-mini: input $0,15/M, output $0,60/M
    emitUsage(bus, 1_000_000, 0, { cacheIncluded: false })
    u.reset()
    emitUsage(bus, 1_000_000, 0, { cacheIncluded: false })
    u.reset()
    expect(u.get().cost).toBe(0)
    expect(u.getSession().cost).toBeCloseTo(0.3, 6)
  })

  test("token cache diakumulasi di kedua akumulator", () => {
    const bus = createEventBus()
    const u = createUsageCollector(bus, "claude-sonnet-4")
    emitUsage(bus, 1000, 100, { cacheReadTokens: 500, cacheWriteTokens: 200 })
    expect(u.get().cacheReadTokens).toBe(500)
    expect(u.getSession().cacheWriteTokens).toBe(200)
    u.reset()
    expect(u.get().cacheReadTokens).toBe(0)
    expect(u.getSession().cacheReadTokens).toBe(500)
  })

  test("model efektif dari fallback tetap jadi basis harga sesi setelah reset", () => {
    const bus = createEventBus()
    const u = createUsageCollector(bus, "gpt-4o")
    bus.emit({
      type: "provider:extension",
      kind: "effective-model",
      data: { requested: "gpt-4o", effective: "gpt-4o-mini", provider: "fallback" },
    } as never)
    emitUsage(bus, 1_000_000, 0, { cacheIncluded: false })
    // sebelum reset: harga memakai model efektif
    expect(u.getSession().cost).toBeCloseTo(0.15, 6)
    u.reset()
    // setelah reset: modelUsed dibersihkan (itu info per-turn), tapi biaya sesi
    // tidak boleh mendadak dihitung ulang dengan harga gpt-4o yang lebih mahal.
    expect(u.modelUsed().effective).toBeUndefined()
    expect(u.getSession().cost).toBeCloseTo(0.15, 6)
  })

  test("model tanpa harga: cost undefined, token tetap tercatat", () => {
    const bus = createEventBus()
    const u = createUsageCollector(bus, "model-yang-tidak-ada-di-tabel-harga")
    emitUsage(bus, 100, 50)
    expect(u.getSession().totalTokens).toBe(150)
    expect(u.getSession().cost).toBeUndefined()
  })

  test("tanpa model sama sekali: cost tidak dihitung", () => {
    const bus = createEventBus()
    const u = createUsageCollector(bus)
    emitUsage(bus, 100, 50)
    expect(u.getSession().cost).toBeUndefined()
    expect(u.getSession().totalTokens).toBe(150)
  })
})

describe("watchBudgetLimit: pemutus mid-turn", () => {
  // gpt-4o-mini input $0,15/M → 1 jt token = $0,15.
  test("melewati pagu di tengah turn → onOver sekali, lalu hening", () => {
    const bus = createEventBus()
    const u = createUsageCollector(bus, "gpt-4o-mini")
    const calls: string[] = []
    const stop = watchBudgetLimit({
      bus,
      budget: 0.1,
      getCost: () => u.getSession().cost,
      onOver: (st) => calls.push(st),
    })
    emitUsage(bus, 100, 0, { cacheIncluded: false }) // jauh di bawah pagu
    expect(calls).toEqual([])
    emitUsage(bus, 1_000_000, 0, { cacheIncluded: false }) // $0,15 > $0,10
    expect(calls).toEqual(["over"])
    emitUsage(bus, 1_000_000, 0, { cacheIncluded: false }) // tak dobel
    expect(calls).toEqual(["over"])
    stop()
  })

  test("sudah over sebelum watcher dipasang → langsung tembak sekali", () => {
    const bus = createEventBus()
    const u = createUsageCollector(bus, "gpt-4o-mini")
    emitUsage(bus, 1_000_000, 0, { cacheIncluded: false })
    const calls: string[] = []
    const stop = watchBudgetLimit({
      bus,
      budget: 0.1,
      getCost: () => u.getSession().cost,
      onOver: (st) => calls.push(st),
    })
    expect(calls).toEqual(["over"])
    stop()
  })

  test("tanpa budget = no-op: belanja berapa pun tak menembak", () => {
    const bus = createEventBus()
    const u = createUsageCollector(bus, "gpt-4o-mini")
    let fired = 0
    const stop = watchBudgetLimit({
      bus,
      getCost: () => u.getSession().cost,
      onOver: () => fired++,
    })
    emitUsage(bus, 10_000_000, 0, { cacheIncluded: false })
    expect(fired).toBe(0)
    stop()
  })

  test("strict + model tanpa harga + ada pemakaian → unknown-strict", () => {
    const bus = createEventBus()
    const u = createUsageCollector(bus, "model-yang-tidak-ada-di-tabel-harga")
    const calls: string[] = []
    const stop = watchBudgetLimit({
      bus,
      budget: 1,
      strict: true,
      getCost: () => u.getSession().cost,
      onOver: (st) => calls.push(st),
    })
    emitUsage(bus, 100, 50)
    expect(calls).toEqual(["unknown-strict"])
    stop()
  })

  test("non-strict + cost tak dikenal = fail-open seperti dulu", () => {
    const bus = createEventBus()
    const u = createUsageCollector(bus, "model-yang-tidak-ada-di-tabel-harga")
    let fired = 0
    const stop = watchBudgetLimit({
      bus,
      budget: 1,
      getCost: () => u.getSession().cost,
      onOver: () => fired++,
    })
    emitUsage(bus, 100, 50)
    expect(fired).toBe(0)
    stop()
  })
})
