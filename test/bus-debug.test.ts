// Instrumentasi diagnosis bus (MINICODE_DEBUG_BUS=1): satu baris ringkas
// per event, TANPA isi konten (panjang + nama saja) agar secret tak bocor
// ke log. Tanpa env = tanpa subscribe (zero-cost).

import { afterEach, beforeEach, expect, test } from "bun:test"
import type { EventBus } from "#minicore/core/index.ts"
import { attachBusDebug } from "../src/ui/runtime/bus-debug.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined
let saved: string | undefined

beforeEach(() => {
  tty = installFakeTty({ columns: 80, rows: 24 })
  saved = process.env.MINICODE_DEBUG_BUS
  delete process.env.MINICODE_DEBUG_BUS
})

afterEach(() => {
  if (saved === undefined) delete process.env.MINICODE_DEBUG_BUS
  else process.env.MINICODE_DEBUG_BUS = saved
  tty?.restore()
  tty = undefined
})

test("tanpa env: diam total (zero-cost, zero-noise)", () => {
  const bus = createFakeBus()
  const detach = attachBusDebug(bus as unknown as EventBus)
  bus.emit("turn:started", { turn: 1 })
  bus.emit("provider:text", { text: "halo\n" })
  detach()
  expect(tty!.allErr()).toBe("")
})

test("dengan env: ringkas per tipe event", () => {
  process.env.MINICODE_DEBUG_BUS = "1"
  const bus = createFakeBus()
  const detach = attachBusDebug(bus as unknown as EventBus)
  bus.emit("turn:started", { turn: 3 })
  bus.emit("provider:extension", { kind: "reasoning", data: { text: "x".repeat(50) } })
  bus.emit("execution:started", { execution: { call: { name: "bash", args: {} } } })
  bus.emit("turn:completed", {})
  detach()
  const out = tty!.allErr()
  expect(out).toContain("[bus] turn:started #3")
  expect(out).toContain("[bus] ext:reasoning 50ch")
  expect(out).toContain("[bus] start:bash")
  expect(out).toContain("[bus] turn:completed")
})

test("isi konten tak pernah bocor ke dump (anti secret leak)", () => {
  process.env.MINICODE_DEBUG_BUS = "1"
  const bus = createFakeBus()
  const detach = attachBusDebug(bus as unknown as EventBus)
  bus.emit("provider:text", { text: "sk-abc123XYZ987abc123XYZ987abc123\n" })
  bus.emit("execution:completed", {
    execution: {
      call: { name: "read_file", args: {} },
      result: { isError: false, content: "thk_live_zzz111yyy222zzz111" },
    },
  })
  detach()
  const out = tty!.allErr()
  expect(out).toContain("[bus] text ")
  expect(out).not.toContain("sk-abc123")
  expect(out).not.toContain("thk_live_")
})

test("detach menghentikan dump", () => {
  process.env.MINICODE_DEBUG_BUS = "1"
  const bus = createFakeBus()
  const detach = attachBusDebug(bus as unknown as EventBus)
  detach()
  tty!.clear()
  bus.emit("turn:started", { turn: 9 })
  expect(tty!.allErr()).toBe("")
})
