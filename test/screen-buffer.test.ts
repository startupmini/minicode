// Unit parser screen-buffer harness — fondasi SEMUA assertion frame TUI.
// Tanpa parser yang benar, test fullscreen hanya mencocokkan substring byte
// (posisi/susunan tak terjaga) dan bug "frame penuh tapi acak" lolos.
import { describe, expect, test } from "bun:test"
import { parseScreenBuffer } from "./helpers/tui-harness.ts"

describe("parseScreenBuffer", () => {
  test("teks polos + newline mengisi baris berurutan", () => {
    const rows = parseScreenBuffer("halo\r\ndunia", 20, 5)
    expect(rows[0]).toBe("halo")
    expect(rows[1]).toBe("dunia")
    expect(rows).toHaveLength(5)
  })
  test("SGR dibuang, sel menyimpan karakter polos", () => {
    const rows = parseScreenBuffer("\x1b[1;31mmerah\x1b[0m biasa", 20, 3)
    expect(rows[0]).toBe("merah biasa")
  })
  test("HOME + ED me-reset grid (semantik repaint penuh)", () => {
    const rows = parseScreenBuffer("lama\r\n\x1b[H\x1b[2Jbaru", 20, 3)
    expect(rows[0]).toBe("baru")
    expect(rows[1]).toBe("")
  })
  test("EL menghapus sisa baris dari kursor", () => {
    const rows = parseScreenBuffer("abcdef\r\x1b[3C\x1b[0K", 20, 2)
    // kursor di kolom 3 (0-based) — "def" terhapus, "abc" bertahan.
    expect(rows[0]).toBe("abc")
  })
  test("CUP absolut menempatkan teks (posisi kursor App)", () => {
    const rows = parseScreenBuffer("\x1b[3;5Hhi", 20, 5)
    expect(rows[2]).toBe("    hi")
  })
  test("kursor naik/turun relatif (A/B mempertahan kolom)", () => {
    const rows = parseScreenBuffer("a\r\nb\x1b[A\x1b[1CX", 20, 4)
    expect(rows[0]).toBe("a X")
    expect(rows[1]).toBe("b")
  })
  test("mode privat selain 1049 tak me-reset (cursor hide/show, SYNC)", () => {
    const rows = parseScreenBuffer("x\x1b[?25l\x1b[?2026h\x1b[?25h", 20, 2)
    expect(rows[0]).toBe("x")
  })
  test("masuk alt-screen (?1049h) mengosongkan grid", () => {
    const rows = parseScreenBuffer("utama\x1b[?1049hframe", 20, 3)
    expect(rows[0]).toBe("frame")
  })
  test("glyph 2 kolom menggeser kursor 2 (CJK tak menimpa tetangga)", () => {
    const rows = parseScreenBuffer("ab中c", 20, 2)
    expect(rows[0]).toBe("ab中c")
  })
  test("OSC (judul) dilewati sampai BEL", () => {
    const rows = parseScreenBuffer("\x1b]0;judul\x07ok", 20, 2)
    expect(rows[0]).toBe("ok")
  })
})
