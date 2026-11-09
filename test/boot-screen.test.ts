// Boot screen (logo reveal typewriter) — hanya TTY; non-TTY/sempit jatuh ke
// spinner teks. Verifikasi logo block ter-lukis + status + clear saat stop.

import { afterEach, describe, expect, test } from "bun:test"
import { createBootScreen } from "../src/ui/runtime/boot.ts"
import { type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let tty: FakeTty | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
})

describe("boot screen", () => {
  test("non-TTY: tidak melukis logo (fallback no-op), stop(final) tetap tercetak", async () => {
    tty = installFakeTty({ isTTY: false })
    const boot = createBootScreen("siapkan", { intervalMs: 5 })
    await sleep(30)
    boot.stop("selesai")
    expect(tty.allErr()).not.toContain("█")
    expect(tty.allErr()).toContain("selesai")
  })

  test("TTY: melukis logo block + status line, hold 0.4 dtk lalu clear + show cursor", async () => {
    tty = installFakeTty({ columns: 80, rows: 30 })
    const boot = createBootScreen("Menyiapkan…", { intervalMs: 5 })
    await sleep(80) // reveal penuh (6 baris × 5ms) + beberapa frame spinner
    const drawn = tty.allErr()
    expect(drawn).toContain("█")
    expect(drawn).toContain("Menyiapkan…")
    expect(drawn).toContain("\x1b[s") // save-cursor untuk clear blok
    boot.stop()
    // stop() menahan clear ±400ms (HOLD_MS) agar logo terlihat penuh dulu.
    await sleep(550)
    const cleared = tty.allErr()
    expect(cleared).toContain("\x1b[J") // clear-below
    expect(cleared).toContain("\x1b[?25h") // show cursor
  })
})
