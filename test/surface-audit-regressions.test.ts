// Regresi audit Surface Popup (AUD-007/008/010, 2026-11-14).
//   AUD-007 — kotak approval memakai lebar LAYAR PENUH, bukan lebar popup seragam.
//   AUD-008 — `ask_user` merender opsi bernomor tapi meneruskan jawaban mentah.
//   AUD-010 — opsi dipotong `.slice(0, 200)` mentah → surrogate pair terbelah.
import { describe, expect, test } from "bun:test"
import { sanitizeAnsiLine } from "../src/ui/render/sanitize.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { popupBoxWidth } from "../src/ui/screens/dialog.ts"

describe("AUD-007: lebar kotak approval = popupBoxWidth, bukan lebar layar", () => {
  test("popupBoxWidth menjepit skala 40..88 dan menyisakan margin layar", () => {
    expect(popupBoxWidth(160)).toBe(88)
    expect(popupBoxWidth(100)).toBe(60)
    expect(popupBoxWidth(70)).toBe(42)
    // Margin 4 kolom SELALU menang (AUD-011: dulu lantai 40 membungkus clamp).
    expect(popupBoxWidth(40)).toBe(36)
    expect(popupBoxWidth(30)).toBe(26)
    expect(popupBoxWidth(20)).toBe(16)
    for (const cols of [40, 60, 70, 80, 100, 120, 160, 200]) {
      const w = popupBoxWidth(cols)
      expect(w).toBeLessThanOrEqual(cols - 4)
      if (cols - 4 >= 40) expect(w).toBeGreaterThanOrEqual(40)
    }
    for (const cols of [10, 20, 30, 36, 44]) {
      expect(popupBoxWidth(cols)).toBeLessThanOrEqual(Math.max(10, cols) - 4)
    }
  })

  test("terminal lebar: kotak TIDAK melebar ke seluruh layar", () => {
    // Sebelum perbaikan renderModal tak mengirim minWidth/maxWidth → 154 kolom
    // di layar 160. Sekarang mengikuti popupBoxWidth (88).
    expect(popupBoxWidth(160)).toBe(88)
    expect(popupBoxWidth(160)).toBeLessThan(156)
  })
})

describe("AUD-008: jawaban opsi bernomor dipetakan ke teks opsi", () => {
  // Replikasi logika prompt.ts (diuji tanpa TTY).
  function mapAnswer(out: string, options?: string[]): string {
    const pick = options?.length ? /^\s*(\d+)\s*$/.exec(out) : null
    return (pick ? options?.[Number(pick[1]) - 1] : undefined) ?? out
  }

  test("indeks valid dipetakan; di luar rentang / bebas diteruskan", () => {
    const opts = ["Red", "Blue", "Green"]
    expect(mapAnswer("1", opts)).toBe("Red")
    expect(mapAnswer("  2  ", opts)).toBe("Blue")
    expect(mapAnswer("3", opts)).toBe("Green")
    expect(mapAnswer("99", opts)).toBe("99")
    expect(mapAnswer("0", opts)).toBe("0")
    expect(mapAnswer("biru dong", opts)).toBe("biru dong")
    expect(mapAnswer("1", undefined)).toBe("1")
    expect(mapAnswer("1", [])).toBe("1")
  })
})

describe("AUD-010: potong opsi tak boleh membelah surrogate pair", () => {
  // Replikasi sliceSafeChars dari src/tools/ask_user.ts.
  function sliceSafeChars(s: string, max: number): string {
    if (s.length <= max) return s
    let end = max
    const code = s.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end -= 1
    return s.slice(0, Math.max(0, end))
  }

  const hasLoneSurrogate = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = s.charCodeAt(i + 1)
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true
        i++
      } else if (c >= 0xdc00 && c <= 0xdfff) return true
    }
    return false
  }

  test("emoji tepat di batas potong tidak menyisakan surrogate yatim", () => {
    const s = `${"a".repeat(199)}😀b`
    const cut = sliceSafeChars(s, 200)
    expect(hasLoneSurrogate(cut)).toBe(false)
    expect(cut).toBe("a".repeat(199))
    expect(hasLoneSurrogate(s.slice(0, 200))).toBe(true)
  })

  test("string pendek/tanpa emoji tidak berubah", () => {
    expect(sliceSafeChars("hello", 200)).toBe("hello")
    expect(sliceSafeChars("字".repeat(300), 200)).toBe("字".repeat(300).slice(0, 200))
    expect(sliceSafeChars("", 200)).toBe("")
  })

  test("hasil aman ditampilkan (tanpa U+FFFD dari potongan)", () => {
    const cut = sliceSafeChars(`${"x".repeat(199)}😀`, 200)
    expect(sanitizeAnsiLine(cut)).toBe(cut)
    expect(displayWidth(cut)).toBe(199)
  })
})
