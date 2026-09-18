// Regresi F1 — fragmentasi ANSI antar-chunk stream.
// Latar: sanitizeAnsi() berjalan per-chunk; escape yang terpotong di batas
// ("ESC[" + "32mHello") tampil literal "32mHello" (temuan audit F1, HIGH).
// Test ini HARUS gagal di kode lama dan hijau setelah perbaikan.
import { describe, expect, test } from "bun:test"
import {
  cleanUntrusted,
  createStreamSanitizer,
  sanitizeAnsi,
  splitTrailingEscape,
} from "../src/ui/render/sanitize.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"

const ESC = "\x1b"

describe("F1: batas escape generik (CSI/SGR/OSC/malformed/unterminated)", () => {
  test("tanpa escape → tidak ada ekor", () => {
    expect(splitTrailingEscape("halo")).toEqual({ head: "halo", tail: "" })
  })

  test("ESC tunggal di ujung → ditahan", () => {
    expect(splitTrailingEscape(`ab${ESC}`)).toEqual({ head: "ab", tail: ESC })
  })

  test("ESC[ di ujung → ditahan", () => {
    expect(splitTrailingEscape(`ab${ESC}[`)).toEqual({ head: "ab", tail: `${ESC}[` })
  })

  test("CSI parameter tanpa final → ditahan", () => {
    for (const t of ["3", "32", "32;", "?25", "38;5;"]) {
      const r = splitTrailingEscape(`ab${ESC}[${t}`)
      expect(r).toEqual({ head: "ab", tail: `${ESC}[${t}` })
    }
  })

  test("SGR lengkap di ujung → langsung (perilaku lama utuh)", () => {
    expect(splitTrailingEscape(`ab${ESC}[32m`)).toEqual({
      head: `ab${ESC}[32m`,
      tail: "",
    })
  })

  test("CSI non-SGR lengkap di ujung → langsung (nanti di-drop sanitizer)", () => {
    expect(splitTrailingEscape(`ab${ESC}[2J`)).toEqual({ head: `ab${ESC}[2J`, tail: "" })
  })

  test("sekuens lengkap + teks sesudahnya → tidak ada ekor", () => {
    expect(splitTrailingEscape(`ab${ESC}[2Jcd`)).toEqual({
      head: `ab${ESC}[2Jcd`,
      tail: "",
    })
  })

  test("OSC tanpa terminator → ditahan", () => {
    expect(splitTrailingEscape(`ab${ESC}]0;judul`)).toEqual({
      head: "ab",
      tail: `${ESC}]0;judul`,
    })
  })

  test("OSC ber-terminator → langsung", () => {
    expect(splitTrailingEscape(`ab${ESC}]0;j\x07cd`)).toEqual({
      head: `ab${ESC}]0;j\x07cd`,
      tail: "",
    })
  })

  test("Fe 2-byte lengkap → langsung", () => {
    expect(splitTrailingEscape(`ab${ESC}7`)).toEqual({ head: `ab${ESC}7`, tail: "" })
  })

  test("charset 3-byte terpotong → ditahan", () => {
    expect(splitTrailingEscape(`ab${ESC}(`)).toEqual({ head: "ab", tail: `${ESC}(` })
  })
})

describe("F1: sanitizer sadar-stream", () => {
  test("Case A: sekuens utuh satu chunk → normal", () => {
    const s = createStreamSanitizer()
    expect(s.push(`${ESC}[32mHello${ESC}[0m`)).toBe(`${ESC}[32mHello${ESC}[0m`)
    expect(s.flush()).toBe("")
  })

  test("Case B: SGR dibelah per-karakter → tersambung utuh, tanpa literal", () => {
    const s = createStreamSanitizer()
    let got = ""
    for (const c of [ESC, "[", "3", "2", "m", "H", "e", "l", "l", "o"]) got += s.push(c)
    got += s.flush()
    // Kode lama menghasilkan literal "32mHello" (korupsi terlihat); yang benar
    // sekuens utuh + teks. stripAnsi memisahkan keduanya secara tegas.
    expect(got).toBe(`${ESC}[32mHello`)
    expect(stripAnsi(got)).toBe("Hello")
  })

  test("Case B2: belah dua di tengah parameter", () => {
    const s = createStreamSanitizer()
    const a = s.push(`teks ${ESC}[3`)
    const b = s.push(`2mX${ESC}[0m\n`)
    const all = a + b + s.flush()
    expect(all).toBe(`teks ${ESC}[32mX${ESC}[0m\n`)
    expect(stripAnsi(all)).toBe("teks X\n")
  })

  test("Case C: sekuens tak-lengkap sampai stream selesai → dibuang, tak bocor", () => {
    const s = createStreamSanitizer()
    const a = s.push(`halo ${ESC}[`)
    expect(a).toBe("halo ")
    expect(s.flush()).toBe("")
  })

  test("C2: OSC raksasa tanpa terminator di-cap, tak tumbuh tanpa batas", () => {
    const s = createStreamSanitizer()
    s.push(`ok ${ESC}]0;${"z".repeat(9000)}`)
    const tail = s.push("lagi")
    expect(tail).not.toContain("z".repeat(100))
    expect(s.flush()).toBe("")
  })

  test("ANSI + markdown: fence utuh walau SGR terbelah di dalamnya", () => {
    const s = createStreamSanitizer()
    const parts = ["```j", "s\n", `${ESC}[3`, "2mcode", `${ESC}[0m\n`, "```\n"]
    const all = parts.map((p) => s.push(p)).join("") + s.flush()
    expect(all).toBe(`\`\`\`js\n${ESC}[32mcode${ESC}[0m\n\`\`\`\n`)
    expect(stripAnsi(all)).toBe("```js\ncode\n```\n")
  })

  test("ANSI + abort: ekor parsal di-flush tepat-1x, ekor escape dibuang", () => {
    const s = createStreamSanitizer()
    const a = s.push(`partial${ESC}[3`)
    const f = s.flush()
    expect(a + f).toBe("partial")
  })
})

describe("F1: semua titik belah setara whole-string (properti streaming)", () => {
  // Invarian konsolidasi: untuk SETIAP posisi belah, sanitasi streaming
  // (push+push+flush) harus identik dengan sanitizeAnsi atas string utuh.
  // Ini membuktikan sanitizer benar-benar stream-aware, bukan tambalan ESC[.
  const streams = [
    `${ESC}[32mHello${ESC}[0m`,
    `teks ${ESC}[1;33mKuning${ESC}[0m biasa`,
    `A${ESC}[2J${ESC}[HB${ESC}[?25lC`,
    `${ESC}]0;judul\x07ok`,
    "日本語💡 campur \x1b[36mSian\x1b[0m akhir",
    "```js\nkode\n```\nsetelah",
    `multi${ESC}[38;5;196m256${ESC}[0m+${ESC}[38;2;1;2;3mtrue${ESC}[0m`,
    `belah-tepat-sebelum-terminator${ESC}[33`,
  ]
  test("belah-2 di semua posisi: identik whole-string", () => {
    for (const input of streams) {
      const ref = sanitizeAnsi(input)
      for (let i = 0; i <= input.length; i++) {
        const s = createStreamSanitizer()
        const got = s.push(input.slice(0, i)) + s.push(input.slice(i)) + s.flush()
        expect(got).toBe(ref)
      }
    }
  })

  test("belah-3 acak: identik whole-string", () => {
    let seed = 42
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed
    }
    for (const input of streams) {
      const ref = sanitizeAnsi(input)
      for (let k = 0; k < 25; k++) {
        const a = rnd() % (input.length + 1)
        const b = a + (rnd() % (input.length + 1 - a))
        const s = createStreamSanitizer()
        const got =
          s.push(input.slice(0, a)) + s.push(input.slice(a, b)) + s.push(input.slice(b)) + s.flush()
        expect(got).toBe(ref)
      }
    }
  })

  test("belah-2 + kebijakan pipa: identik strip whole-string", () => {
    for (const input of streams) {
      const ref = cleanUntrusted(input, false)
      for (let i = 0; i <= input.length; i++) {
        const s = createStreamSanitizer()
        const got =
          cleanUntrusted(s.push(input.slice(0, i)), false) +
          cleanUntrusted(s.push(input.slice(i)), false) +
          s.flush()
        expect(got).toBe(ref)
      }
    }
  })
})
