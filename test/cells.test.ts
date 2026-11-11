// Diff sel (src/ui/render/cells.ts): inti optimasi latensi ketik.
//
// Test ini menjaga dua hal yang mudah rusak:
// 1. PARITAS — hasil byte diff harus mereproduksi grid yang sama dengan
//    menulis ulang seluruh baris (termasuk CJK/emoji lebar).
// 2. MINIMALITAS — perubahan satu kolom tidak boleh menulis ulang prefix.
import { describe, expect, test } from "bun:test"
import { diffCellLine, parseCells, sameCells } from "../src/ui/render/cells.ts"
import { parseScreenBuffer } from "./helpers/tui-harness.ts"

const WIDTH = 24
const ROWS = 4

function paintFull(lines: string[]): string {
  return `\x1b[H\x1b[2J${lines.join("\r\n")}`
}

function paintIncremental(prev: string[], next: string[]): string {
  let out = paintFull(prev)
  for (let r = 0; r < next.length; r++) {
    if (prev[r] === next[r]) continue
    out += diffCellLine(parseCells(prev[r] ?? ""), parseCells(next[r] ?? ""), r + 1)
  }
  return out
}

function grid(out: string): string[] {
  return parseScreenBuffer(out, WIDTH, ROWS)
}

describe("diffCellLine", () => {
  test("hanya kolom berubah yang ditulis, prefix tidak diulang", () => {
    const prev = ["prefix-abcdefghij"]
    const next = ["prefix-abcdefghik"]
    const diff = diffCellLine(parseCells(prev[0]!), parseCells(next[0]!), 1)
    expect(diff).toContain("k")
    expect(diff).not.toContain("prefix")
    expect(diff.length).toBeLessThan(40)
  })

  test("baris menyusut: ekor dihapus dengan EL, sisa glyph lebar bersih", () => {
    const prev = ["A中B"]
    const next = ["AB"]
    const out = paintIncremental(prev, next)
    expect(grid(out)).toEqual(grid(paintFull(next)))
  })

  test("glyph lebar bergeser: diff tidak memotong di tengah sel", () => {
    const prev = ["中中中", "abc"]
    const next = ["中a中", "abcd"]
    const out = paintIncremental(prev, next)
    expect(grid(out)).toEqual(grid(paintFull(next)))
  })

  test("state SGR: akumulasi ternormalisasi (urutan kanonik)", () => {
    const cells = parseCells("\x1b[31ma\x1b[1mb\x1b[0mc")
    expect(cells.map((cell) => cell.glyph)).toEqual(["a", "b", "c"])
    expect(cells[0]!.style).toBe("\x1b[31m")
    // Bold + merah diserialisasi kanonik (bold dulu), bukan urutan input.
    expect(cells[1]!.style).toBe("\x1b[1;31m")
    expect(cells[2]!.style).toBe("")
  })

  test("state SGR: reset membatalkan, bukan menumpuk riwayat", () => {
    // Tanpa normalisasi, `31` lalu `39` akan menjadi string gabungan dan
    // membuat diff menganggap sel identik "berubah" (footer ditulis tiap tick).
    const cells = parseCells("\x1b[31mred\x1b[39m plain")
    expect(cells[0]!.style).toBe("\x1b[31m")
    expect(cells[3]!.style).toBe("") // "p" kembali default
  })

  test("state SGR: warna lanjutan 38;5;n / 38;2;r;g;b", () => {
    const idx = parseCells("\x1b[38;5;196mx")
    expect(idx[0]!.style).toBe("\x1b[38;5;196m")
    const truecolor = parseCells("\x1b[38;2;72;72;72my")
    expect(truecolor[0]!.style).toBe("\x1b[38;2;72;72;72m")
  })

  test("perubahan atribut pada sel yang sama tetap ditulis", () => {
    const prev = ["abc"]
    const next = ["a\x1b[7mbc\x1b[27m"]
    const diff = diffCellLine(parseCells(prev[0]!), parseCells(next[0]!), 1)
    expect(diff).toContain("\x1b[7m")
    const out = paintIncremental(prev, next)
    expect(grid(out)).toEqual(grid(paintFull(next)))
  })

  test("sel identik secara tampilan dianggap sama", () => {
    expect(sameCells(parseCells("a b"), parseCells("a b"))).toBe(true)
    expect(sameCells(parseCells("a b"), parseCells("a  b"))).toBe(false)
  })
})

// Fuzz deterministik: campur ASCII, CJK, emoji ZWJ, dan SGR; diff harus
// menghasilkan grid identik dengan repaint penuh pada setiap kasus.
describe("paritas diff sel (fuzz)", () => {
  const TOKENS = [
    "a",
    "b",
    " ",
    "中",
    "界",
    "🙂",
    "👨‍👩‍👧",
    "🇮🇩",
    "❤️",
    "\x1b[31m",
    "\x1b[1m",
    "\x1b[7m",
    "\x1b[0m",
    "\x1b[27m",
    "\x1b[39m",
  ]

  function makeLine(rand: () => number): string {
    let line = ""
    let cols = 0
    const n = 1 + Math.floor(rand() * 14)
    for (let i = 0; i < n; i++) {
      const token = TOKENS[Math.floor(rand() * TOKENS.length)]!
      if (token.startsWith("\x1b[")) {
        line += token
        continue
      }
      const width = token === "中" || token === "界" || token.includes("🙂") ? 2 : 1
      // Emoji ZWJ/flag juga 2 kolom; jaga baris tidak melewati lebar terminal
      // supaya perbandingan tidak melibatkan perilaku wrap terminal nyata.
      if (cols + width > WIDTH - 2) break
      line += token
      cols += width
    }
    return line
  }

  test("500 pasang baris acak menghasilkan grid yang sama", () => {
    let seed = 0x5eed1234
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x1_0000_0000
    }
    for (let caseNo = 0; caseNo < 500; caseNo++) {
      const prev = Array.from({ length: ROWS }, () => makeLine(rand))
      const next = Array.from({ length: ROWS }, () => makeLine(rand))
      const incremental = grid(paintIncremental(prev, next))
      const full = grid(paintFull(next))
      if (JSON.stringify(incremental) !== JSON.stringify(full)) {
        throw new Error(
          `paritas gagal pada kasus ${caseNo}\nprev=${JSON.stringify(prev)}\nnext=${JSON.stringify(next)}\ninc=${JSON.stringify(incremental)}\nfull=${JSON.stringify(full)}`,
        )
      }
    }
  })
})
