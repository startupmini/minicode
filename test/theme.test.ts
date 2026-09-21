// Palet tunggal (dark, Ubuntu Server style) — fitur tema (--theme, /theme,
// preset light/dim/mono) dihapus. Yang diuji: slot warna mengeluarkan SGR saat
// truecolor, NO_COLOR mematikan semuanya, alias legacy konsisten dengan token
// semantik, dan stripAnsi menangkap semua pola ANSI.
import { afterAll, beforeEach, expect, test } from "bun:test"
import { c, ESC, stripAnsi } from "../src/ui/render/theme.ts"

const origColorterm = process.env.COLORTERM
const origNoColor = process.env.NO_COLOR

beforeEach(() => {
  process.env.COLORTERM = "truecolor"
  delete process.env.NO_COLOR
  // Warna digate stdout.isTTY — stub TTY agar yang diuji palet, bukan gate.
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
})

afterAll(() => {
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
  if (origColorterm == null) delete process.env.COLORTERM
  else process.env.COLORTERM = origColorterm
  if (origNoColor == null) delete process.env.NO_COLOR
  else process.env.NO_COLOR = origNoColor
})

const COLOR_SLOTS = [
  "success",
  "error",
  "warning",
  "info",
  "accent",
  "accentAlt",
  "accentBold",
  "gray",
  "red",
  "green",
  "yellow",
  "cyan",
  "blue",
  "magenta",
  "white",
  "brightYellow",
  "brightMagenta",
  "brightCyan",
] as const

test("palet tunggal: semua slot warna mengeluarkan SGR saat truecolor", () => {
  for (const slot of COLOR_SLOTS) {
    expect(c[slot]("X"), slot).toContain(ESC)
  }
})

test("warna mati saat stdout bukan TTY walau COLORTERM=truecolor (Unix pipe)", () => {
  // Regresi: warna dulu digate env saja, sehingga TERM/COLORTERM dari sesi
  // interaktif bocor ke `minicode ... > file` / pipe → ANSI garbage.
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
  for (const slot of [...COLOR_SLOTS, "bold", "muted"] as const) {
    expect(c[slot]("X"), slot).toBe("X")
  }
  expect(c.gray("X")).toBe("X") // dim ikut mati
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
})

test("palet tunggal: teks tetap utuh setelah strip", () => {
  expect(stripAnsi(c.success("halo"))).toBe("halo")
  expect(stripAnsi(c.accent(c.bold("halo")))).toBe("halo")
  expect(stripAnsi(c.error(c.brightYellow("x")))).toBe("x")
})

test("alias legacy memetakan ke token semantik yang sama", () => {
  expect(c.red("X")).toBe(c.error("X"))
  expect(c.green("X")).toBe(c.success("X"))
  expect(c.yellow("X")).toBe(c.warning("X"))
  expect(c.cyan("X")).toBe(c.info("X"))
})

test("NO_COLOR mematikan semua warna", () => {
  process.env.NO_COLOR = "1"
  for (const slot of [...COLOR_SLOTS, "bold", "muted", "dim", "italic"] as const) {
    expect(c[slot]("X"), slot).toBe("X")
  }
  delete process.env.NO_COLOR
})

test("stripAnsi: menangkap sekuens private-mode dan OSC", () => {
  expect(stripAnsi("\x1b[?25lteks\x1b[?25h")).toBe("teks")
  expect(stripAnsi("\x1b[?2026hsync\x1b[?2026l")).toBe("sync")
  expect(stripAnsi("\x1b[?1049halt\x1b[?1049l")).toBe("alt")
  expect(stripAnsi("\x1b[1Mhapus")).toBe("hapus")
  expect(stripAnsi("\x1b[38;2;1;2;3mwarna\x1b[39m")).toBe("warna")
  expect(stripAnsi("\x1b]0;judul\x07teks")).toBe("teks")
})

test("stripAnsi: DCS/APC/PM/SOS + final CSI non-huruf (F-01)", () => {
  // Pola lama \\[P_\\^X] hanya cocok ESC[ + satu char: payload DCS bocor
  // sebagai "1$q0" + BEL. Final [a-zA-Z] menyisakan "~" dari ESC[3~.
  expect(stripAnsi("a\x1bP1$q0\x07b")).toBe("ab")
  expect(stripAnsi("a\x1b_Xpayload\x1b\\b")).toBe("ab")
  expect(stripAnsi("a\x1b[3~b")).toBe("ab")
  expect(stripAnsi("a\x1b[@b")).toBe("ab")
})
