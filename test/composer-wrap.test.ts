// Wrap composer inkremental (src/ui/render/composer-wrap.ts): jalur ketik
// panjang. Test ini membuktikan PARITAS dengan `chunkByWidth` penuh — helper
// boleh memilih fallback, tapi bila ia mengembalikan hasil, hasilnya harus
// identik dengan membungkus ulang seluruh baris dari nol.
import { describe, expect, test } from "bun:test"
import { appendWrapped, shaveWrapped } from "../src/ui/render/composer-wrap.ts"
import { chunkByWidth } from "../src/ui/render/width.ts"

const P1 = "minicode › "
const P2 = "  · "

/** Bangun rows composer persis seperti app: prefix per baris logis. */
function buildRows(line: string, w: number): string[] {
  const logical = line.split("\n")
  const rows: string[] = []
  for (let i = 0; i < logical.length; i++) {
    const prefix = i === 0 ? P1 : P2
    rows.push(...chunkByWidth(`${prefix}${logical[i] ?? ""}`, w))
  }
  return rows
}

describe("appendWrapped: paritas dengan chunkByWidth penuh", () => {
  test("ASCII acak: setiap penambahan sama dengan wrap ulang", () => {
    for (const w of [12, 20, 40]) {
      let line = ""
      let rows = buildRows(line, w)
      let seed = 12345
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
      }
      for (let step = 0; step < 300; step++) {
        const ch = String.fromCharCode(97 + Math.floor(rnd() * 26))
        line += ch
        const next = appendWrapped(rows, ch, w)
        expect(next).not.toBeNull()
        expect(next).toEqual(buildRows(line, w))
        rows = next!
      }
    }
  })

  test("glyph lebar (CJK) tak terbelah di batas kolom", () => {
    const w = 10
    let line = ""
    let rows = buildRows(line, w)
    for (const ch of "你好世界abcdef你好") {
      line += ch
      const next = appendWrapped(rows, ch, w)
      expect(next).not.toBeNull()
      expect(next).toEqual(buildRows(line, w))
      rows = next!
    }
  })

  test("multiline: hanya baris terakhir yang berubah", () => {
    const w = 14
    let line = "halo dunia\nbaris kedua yang panjang"
    let rows = buildRows(line, w)
    for (const ch of " terus") {
      line += ch
      const next = appendWrapped(rows, ch, w)
      expect(next).toEqual(buildRows(line, w))
      rows = next!
    }
  })

  test("menolak pola tak didukung (fallback), bukan menebak", () => {
    expect(appendWrapped([], "a", 10)).toBeNull()
    expect(appendWrapped(["x"], "a\nb", 10)).toBeNull()
    expect(appendWrapped(["x"], "a\x1b[31mb", 10)).toBeNull()
    expect(appendWrapped(["x"], "a", 0)).toBeNull()
  })
})

describe("shaveWrapped: paritas dengan chunkByWidth penuh", () => {
  test("ASCII acak: setiap backspace sama dengan wrap ulang", () => {
    for (const w of [12, 20, 40]) {
      let line = "abcdefghijklmnopqrstuvwxyz0123456789 aaa bbb ccc ddd"
      let rows = buildRows(line, w)
      while (line.length > 0) {
        const removed = line.slice(-1)
        const next = shaveWrapped(rows, removed, w)
        line = line.slice(0, -1)
        if (line === "") break
        expect(next).not.toBeNull()
        expect(next).toEqual(buildRows(line, w))
        rows = next!
      }
    }
  })

  test("baris terakhir kosong → pop, baris sebelumnya utuh", () => {
    const w = 6
    const rows = buildRows("abcdefghijkl", w) // beberapa baris penuh
    const next = shaveWrapped(rows, "l", w)
    expect(next).toEqual(buildRows("abcdefghijk", w))
  })

  test("menolak bila ekor tak cocok (fallback)", () => {
    expect(shaveWrapped(["abc"], "z", 10)).toBeNull()
    expect(shaveWrapped([], "a", 10)).toBeNull()
    expect(shaveWrapped(["abc"], "", 10)).toBeNull()
    expect(shaveWrapped(["abc"], "a\x1b[0m", 10)).toBeNull()
  })
})
