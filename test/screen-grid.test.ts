// Test emulator grid layar (test/helpers/screen-grid.ts): ia fondasi semua
// assertion visual TUI — emulatornya sendiri harus benar dulu. Setiap test
// mem-feed sekuens yang dipakai renderer kita + pola umum.

import { describe, expect, test } from "bun:test"
import { createGridEmulator } from "./helpers/screen-grid.ts"

describe("screen grid: tulis + kursor", () => {
  test("teks biasa + CRLF menempati baris berurutan", () => {
    const g = createGridEmulator(10, 5)
    g.feed("hi\r\nok")
    expect(g.text(1)).toBe("hi")
    expect(g.text(2)).toBe("ok")
    expect(g.cursor()).toEqual({ r: 2, c: 3 })
  })

  test("wrap standar saat teks melebihi lebar", () => {
    const g = createGridEmulator(5, 3)
    g.feed("abcdef")
    expect(g.text(1)).toBe("abcde")
    expect(g.text(2)).toBe("f")
  })

  test("CUP/CHA memindah kursor absolut", () => {
    const g = createGridEmulator(20, 10)
    g.feed("\x1b[5;10H")
    expect(g.cursor()).toEqual({ r: 5, c: 10 })
    // CHA = kolom ABSOLUT (bukan relatif): X mendarat di kolom 3.
    g.feed("\x1b[3GX")
    expect(g.text(5)).toBe("  X")
  })

  test("EL menghapus sebaris (0/1/2) — erase jadi spasi, bukan geser", () => {
    const g = createGridEmulator(10, 3)
    g.feed("hello")
    g.feed("\x1b[1;1H\x1b[K")
    expect(g.text(1)).toBe("")
    // EL1 menghapus awal→kursor (kolom 1-3 jadi spasi); teks tak bergeser
    // (itu DCH, bukan EL).
    g.feed("hello\x1b[1;3H\x1b[1K")
    expect(g.text(1)).toBe("   lo")
  })

  test("SGR diabaikan untuk layout (warna bukan geometri)", () => {
    const g = createGridEmulator(10, 3)
    g.feed("\x1b[31mhi\x1b[39m")
    expect(g.text(1)).toBe("hi")
    expect(g.cursor()).toEqual({ r: 1, c: 3 })
  })

  test("CJK memakan 2 kolom", () => {
    const g = createGridEmulator(10, 3)
    g.feed("aあb")
    expect(g.text(1)).toBe("aあb")
    expect(g.cursor()).toEqual({ r: 1, c: 5 })
  })
})

describe("screen grid: region + scroll", () => {
  test("DECSTBM membatasi scroll; reset mengembalikan", () => {
    const g = createGridEmulator(10, 6)
    g.feed("\x1b[2;5r")
    expect(g.region()).toEqual({ top: 2, bottom: 5 })
    g.feed("\x1b[5;5r") // top==bottom = invalid → abaikan (perilaku WT)
    expect(g.region()).toEqual({ top: 2, bottom: 5 })
    g.feed("\x1b[r")
    expect(g.region()).toEqual({ top: 1, bottom: 6 })
  })

  test("LF di dasar region menggeser isi region saja", () => {
    const g = createGridEmulator(10, 6)
    g.feed("l1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6")
    g.feed("\x1b[2;5r")
    g.feed("\x1b[5;1H\n") // LF di baris dasar region
    expect(g.text(1)).toBe("l1")
    expect(g.text(2)).toBe("l3")
    expect(g.text(5)).toBe("")
    expect(g.text(6)).toBe("l6")
    expect(g.scrollback()).toContain("l2")
  })

  test("DL menghapus dalam margin (pola cleanup overlay)", () => {
    const g = createGridEmulator(10, 6)
    g.feed("a\r\nb\r\nc\r\nd")
    g.feed("\x1b[2;1H\x1b[1M")
    expect(g.text(1)).toBe("a")
    expect(g.text(2)).toBe("c")
    expect(g.text(3)).toBe("d")
  })
})

describe("screen grid: alternate screen", () => {
  test("?1049h menyimpan main + buffer bersih; ?1049l mengembalikan", () => {
    const g = createGridEmulator(10, 4)
    g.feed("MAIN\r\n")
    g.feed("\x1b[?1049h")
    expect(g.altActive()).toBe(true)
    expect(g.text(1)).toBe("")
    g.feed("ALT")
    expect(g.text(1)).toBe("ALT")
    g.feed("\x1b[?1049l")
    expect(g.altActive()).toBe(false)
    expect(g.text(1)).toBe("MAIN")
  })

  test("scroll di alt-screen dibuang (tanpa scrollback)", () => {
    const g = createGridEmulator(10, 2)
    g.feed("\x1b[?1049h")
    // Tanpa newline trailing: LF terakhir akan menggeser sekali lagi.
    g.feed("a\r\nb\r\nc")
    expect(g.scrollback()).toEqual([])
    expect(g.text(1)).toBe("b")
    expect(g.text(2)).toBe("c")
  })

  test("?25l/h melacak visibilitas kursor", () => {
    const g = createGridEmulator(10, 2)
    expect(g.cursorVisible()).toBe(true)
    g.feed("\x1b[?25l")
    expect(g.cursorVisible()).toBe(false)
    g.feed("\x1b[?25h")
    expect(g.cursorVisible()).toBe(true)
  })
})
