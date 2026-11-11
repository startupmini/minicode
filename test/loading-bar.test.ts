// Bar loading startup — unit test modul src/ui/runtime/loading-bar.ts.
// Kasus: non-TTY no-op, delay pertama, progres blok + persen + label,
// sanitasi label tak terpercaya, stop idempoten, restore kursor, dan
// tunduk pada arbitrase statusline (wizard menahan lukisan).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { createLoadingBar } from "../src/ui/runtime/loading-bar.ts"
import { beginInteractiveScreen, isTransientPainting } from "../src/ui/runtime/statusline.ts"
import { type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let tty: FakeTty | undefined

beforeEach(() => {
  tty = installFakeTty({ columns: 80, rows: 24 })
})

afterEach(() => {
  tty?.restore()
})

describe("loading bar", () => {
  test("non-TTY: tidak menghasilkan byte apa pun (no-op)", async () => {
    tty = installFakeTty({ isTTY: false })
    const bar = createLoadingBar("menyiapkan")
    expect(bar).toBeNull()
    expect(tty!.allErr()).toBe("")
  })

  test("delay pertama: nol byte sebelum delay, bar setelah update", async () => {
    const bar = createLoadingBar("", { delayMs: 120 })!
    await sleep(60)
    expect(tty!.allErr()).toBe("")
    bar.update("memuat konteks", 50)
    await sleep(220)
    const err = tty!.allErr()
    expect(err).toContain("50%")
    expect(err).toContain("memuat konteks")
    expect(stripAnsi(err)).toContain("▓")
    bar.stop()
  })

  test("progres naik + label berubah + persen 0..100", async () => {
    const bar = createLoadingBar("mulai", { delayMs: 0 })!
    await sleep(40)
    bar.update("fase 1", 10)
    bar.update("fase 2", 55)
    bar.update("fase 3", 100)
    await sleep(40)
    const err = tty!.allErr()
    expect(err).toContain("10%")
    expect(err).toContain("55%")
    expect(err).toContain("100%")
    expect(stripAnsi(err)).toContain("▓")
    bar.stop()
  })

  test("label tak terpercaya disanitasi (ANSI dibuang)", async () => {
    const bar = createLoadingBar("", { delayMs: 0 })!
    await sleep(40)
    bar.update("pesan \x1b[2J bersih", 33)
    await sleep(40)
    const err = tty!.allErr()
    expect(err).not.toContain("\x1b[2J")
    expect(err).toContain("33%")
    bar.stop()
  })

  test("stop idempoten + restore kursor", async () => {
    const bar = createLoadingBar("", { delayMs: 0 })!
    await sleep(40)
    bar.update("x", 1)
    await sleep(40)
    expect(tty!.allErr()).toContain("\x1b[?25l")
    bar.stop()
    bar.stop()
    // Setelah stop: tidak ada frame baru, kursor direstore.
    const before = tty!.allErr()
    expect(before).toContain("\x1b[?25h")
    await sleep(120)
    expect(tty!.allErr()).toBe(before)
  })

  test("manifestasi transient: bar adalah owner stderr (mutual exclusion)", async () => {
    const bar = createLoadingBar("", { delayMs: 0 })!
    await sleep(40)
    expect(isTransientPainting()).toBe(true)
    bar.stop()
    expect(isTransientPainting()).toBe(false)
  })

  test("layar interaktif menahan lukisan bar (paintWrite)", async () => {
    const bar = createLoadingBar("", { delayMs: 0 })!
    await sleep(40)
    tty!.clear()
    const release = beginInteractiveScreen()
    bar.update("phase", 60)
    await sleep(60)
    expect(tty!.allErr()).not.toContain("60%")
    release()
    bar.update("phase", 70)
    await sleep(40)
    expect(tty!.allErr()).toContain("70%")
    bar.stop()
  })

  test("motion-dikurangi: tetap tampil progres, tanpa sembunyikan kursor", async () => {
    const prev = process.env.MINICODE_MOTION
    process.env.MINICODE_MOTION = "0"
    try {
      const bar = createLoadingBar("mulai", { delayMs: 500 })!
      await sleep(30)
      bar.update("memuat", 40)
      await sleep(30)
      expect(tty!.allErr()).toContain("40%")
      expect(tty!.allErr()).not.toContain("\x1b[?25l")
      bar.stop()
      expect(tty!.allErr()).not.toContain("\x1b[?25h")
    } finally {
      if (prev === undefined) delete process.env.MINICODE_MOTION
      else process.env.MINICODE_MOTION = prev
    }
  })
})
