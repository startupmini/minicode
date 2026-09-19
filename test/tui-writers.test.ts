// Seam pengalih tulis logger (setUiWriters): tanpa override, byte-identik
// seperti sebelumnya; dengan override, stdout/stderr bersih dan teks
// mengalir ke penangkap (dipakai driver TUI untuk transkrip). Wajib
// restore null (global mutable!) — afterEach di bawah + finally driver.

import { afterEach, describe, expect, test } from "bun:test"
import { attachSimpleLogger, setUiWriters } from "../src/ui/assistant/simple.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined
afterEach(() => {
  setUiWriters(null)
  tty?.restore()
  tty = undefined
})

describe("setUiWriters", () => {
  test("tanpa override: event mengalir ke stderr, penangkap kosong", () => {
    tty = installFakeTty()
    const bus = createFakeBus()
    const detach = attachSimpleLogger(bus as never, {})
    bus.emit("context:compacted", { reason: "uji" })
    expect(tty.allErr()).toContain("compacted")
    detach()
  })

  test("dengan override: stdout/stderr bersih, teks tertangkap verbatim", () => {
    tty = installFakeTty()
    const bus = createFakeBus()
    const detach = attachSimpleLogger(bus as never, {})
    const got: string[] = []
    setUiWriters({ out: (s) => got.push(`out:${s}`), err: (s) => got.push(`err:${s}`) })
    bus.emit("context:compacted", { reason: "uji-tui" })
    detach()
    expect(got.length).toBe(1)
    expect(got[0]).toContain("compacted")
    expect(got[0]).toContain("uji-tui")
    expect(tty.all()).toBe("")
    expect(tty.allErr()).toBe("")
  })

  test("override parsial: hanya err dialihkan, out tetap alami", () => {
    tty = installFakeTty()
    const bus = createFakeBus()
    const detach = attachSimpleLogger(bus as never, {})
    const got: string[] = []
    setUiWriters({ err: (s) => got.push(s) })
    bus.emit("context:compacted", { reason: "parsial" })
    detach()
    expect(got.length).toBe(1)
    expect(tty.allErr()).toBe("")
  })
})
