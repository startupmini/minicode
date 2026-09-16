// Chrome footer lengket (src/ui/runtime/chrome.ts): DECSTBM scroll-region,
// repaint tiap idle, reset-on-detach, mode none/print/sticky/auto.
// Hermetik via fake-TTY harness (rows/columns/stdout.write tertangkap).

import { afterEach, describe, expect, test } from "bun:test"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { createFooterChrome, footerReserveRows } from "../src/ui/runtime/chrome.ts"
import { installFakeTty } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | undefined
const prev = process.env.MINICODE_FOOTER
afterEach(() => {
  tty?.restore()
  tty = undefined
  if (prev === undefined) delete process.env.MINICODE_FOOTER
  else process.env.MINICODE_FOOTER = prev
})

const status = () => ({
  mode: "allowlist",
  model: "acme::deepseek-v4-flash",
  cwd: "C:\\Users\\dokument",
})

describe("footer chrome", () => {
  test("non-TTY → none, nol byte, tanpa reserve", () => {
    tty = installFakeTty({ isTTY: false })
    const ch = createFooterChrome({ enabled: true, status })
    expect(ch.mode).toBe("none")
    expect(ch.reserveRows()).toBe(0)
    ch.present()
    ch.detach()
    expect(tty.chunks().join("")).toBe("")
  })

  test("MINICODE_FOOTER=off → none walau TTY", () => {
    process.env.MINICODE_FOOTER = "off"
    tty = installFakeTty()
    const ch = createFooterChrome({ enabled: true, status })
    expect(ch.mode).toBe("none")
    ch.present()
    ch.detach()
    expect(tty.chunks().join("")).toBe("")
  })

  test("print: footer sebagai baris scrollback, tanpa region/reserve", () => {
    process.env.MINICODE_FOOTER = "print"
    tty = installFakeTty({ rows: 30, columns: 60 })
    const ch = createFooterChrome({ enabled: true, status })
    expect(ch.mode).toBe("print")
    expect(ch.reserveRows()).toBe(0)
    ch.present()
    const out = tty.chunks().join("")
    // Dua baris footer + newline pemisah; tidak ada \x1b[r / DECSTBM.
    expect(stripAnsi(out)).toContain("allowlist • deepseek-v4-flash • C:\\Users\\dokument")
    expect(stripAnsi(out)).toContain("─".repeat(60))
    expect(out).not.toContain("\x1b[r")
    expect(out).not.toContain(";1H")
  })

  test("sticky: region DECSTBM + footer 3 baris + kursor di baris input", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    expect(ch.mode).toBe("sticky")
    expect(ch.reserveRows()).toBe(3)
    ch.present()
    const out = tty.chunks().join("")
    // Region atas = 1..27 (footer menempati 28..30).
    expect(out).toContain("\x1b[1;27r")
    // Footer dilukis di baris 28-30 (blank/rule/status).
    expect(out).toContain("\x1b[28;1H")
    expect(out).toContain("\x1b[29;1H")
    expect(out).toContain("\x1b[30;1H")
    // Kursor ke baris input 27.
    expect(out).toContain("\x1b[27;1H")
  })

  test("sticky: detach me-reset region + reserve nol, footer tercetak sekali", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    expect(ch.reserveRows()).toBe(3)
    ch.detach()
    expect(ch.reserveRows()).toBe(0)
    expect(footerReserveRows()).toBe(0)
    expect(tty.chunks().join("")).toContain("\x1b[r")
  })

  test("auto di terminal mampu = sticky; terminal pendek = print", () => {
    delete process.env.MINICODE_FOOTER
    tty = installFakeTty({ rows: 30 })
    expect(createFooterChrome({ enabled: true, status }).mode).toBe("sticky")
    tty?.restore()
    tty = installFakeTty({ rows: 8 })
    expect(createFooterChrome({ enabled: true, status }).mode).toBe("print")
  })

  test("sticky tanpa enabled = none (exec/pipe guard)", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30 })
    const ch = createFooterChrome({ enabled: false, status })
    expect(ch.mode).toBe("none")
  })

  test("present dua kali tidak menggandakan region (idempotent)", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    ch.present()
    const out = tty.chunks().join("")
    expect(out.split("\x1b[1;27r").length - 1).toBe(1)
  })

  test("repaint footer TIDAK menggeser kursor (save/restore)", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    tty.clear()
    // refresh() dipakai saat prompt aktif (Shift+Tab): tiap penulisan direct-
    // address harus diapit DECSC/DECRC, dan TIDAK boleh memindahkan kursor
    // input setelah selesai.
    ch.refresh()
    const out = tty.chunks().join("")
    expect(out).toContain("\x1b7")
    expect(out).toContain("\x1b8")
    expect(out.endsWith("\x1b8")).toBe(true)
  })

  test("blank footer pakai CLEAR, bukan padding selebar terminal", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    const out = tty.chunks().join("")
    // Padding 40 spasi dari kolom 1 akan membungkus ke baris berikutnya.
    expect(out).not.toContain(" ".repeat(40))
  })

  test("resize saat region aktif: re-set region + repaint, kursor aman", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    tty.clear()
    tty.resize(50, 20)
    const out = tty.chunks().join("")
    // Region baru mengikuti rows baru (footer 18..20, region 1..17).
    expect(out).toContain("\x1b[1;17r")
    expect(out).toContain("\x1b[20;1H")
    // DECSTBM dipagari save/restore.
    expect(out).toContain("\x1b7")
    expect(out).toContain("\x1b8")
  })
})
