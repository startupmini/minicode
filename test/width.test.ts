// Lebar tampil karakter: CJK/emoji 2 kolom, combining mark 0 kolom.
//
// Ditemukan oleh bug-hunter UI: seluruh lapisan render menganggap 1 karakter =
// 1 kolom. Bukti nyata di TUI 40 kolom: 38 code point CJK menempati 73 kolom,
// baris membungkus sendiri, dan frame (yang dihitung per baris) rusak.

import { describe, expect, test } from "bun:test"
import {
  charWidth,
  chunkByWidth,
  displayWidth,
  escapeLength,
  padToWidth,
  truncateToWidth,
} from "../src/ui/render/width.ts"

describe("charWidth", () => {
  test("ASCII satu kolom", () => {
    for (const ch of "aZ0 ~!") expect(charWidth(ch.codePointAt(0)!)).toBe(1)
  })

  test("CJK, Hangul, kana dua kolom", () => {
    for (const ch of "字漢한글あイ") expect(charWidth(ch.codePointAt(0)!), ch).toBe(2)
  })

  test("fullwidth form dua kolom", () => {
    expect(charWidth("Ａ".codePointAt(0)!)).toBe(2)
    expect(charWidth("１".codePointAt(0)!)).toBe(2)
  })

  test("emoji dua kolom", () => {
    for (const ch of ["😀", "🚀", "🧠", "🩰"]) {
      expect(charWidth(ch.codePointAt(0)!), ch).toBe(2)
    }
  })

  test("tab delapan kolom (batas atas stop terminal, arah aman)", () => {
    // Bug-hunter TUI F-03: tab dihitung 0 → wrap/table/truncate undercount dan
    // frame meluap. 8 = lompatan maksimum ke stop kelipatan-8 (tak pernah
    // undercount; overcount hanya wrap lebih awal).
    expect(charWidth(0x09)).toBe(8)
    expect(displayWidth("a\tb")).toBe(10)
  })

  test("combining mark & variation selector nol kolom", () => {
    expect(charWidth(0x0301)).toBe(0) // combining acute
    expect(charWidth(0xfe0f)).toBe(0) // variation selector-16
    expect(charWidth(0x200d)).toBe(0) // ZWJ
  })

  test("karakter kontrol nol kolom", () => {
    for (const cp of [0, 0x07, 0x0c, 0x1b, 0x7f]) expect(charWidth(cp)).toBe(0)
  })
})

describe("displayWidth", () => {
  test("ASCII = jumlah karakter", () => {
    expect(displayWidth("halo dunia")).toBe(10)
  })

  test("CJK dua kali jumlah karakter", () => {
    expect(displayWidth("这是中文")).toBe(8)
    expect(displayWidth("字".repeat(50))).toBe(100)
  })

  test("campuran ASCII + CJK", () => {
    expect(displayWidth("ab字cd")).toBe(6)
  })

  test("sekuens ANSI tidak dihitung", () => {
    expect(displayWidth("\x1b[32mhijau\x1b[39m")).toBe(5)
    expect(displayWidth("\x1b[?25labc\x1b[?25h")).toBe(3)
    expect(displayWidth("\x1b[1;38;2;1;2;3mX\x1b[0m")).toBe(1)
  })

  test("OSC (judul jendela) tidak dihitung", () => {
    expect(displayWidth("\x1b]0;judul\u0007teks")).toBe(4)
  })

  test("e + combining acute = satu kolom, bukan dua", () => {
    expect(displayWidth("e\u0301")).toBe(1)
  })

  test("emoji dengan variation selector tetap dua kolom", () => {
    expect(displayWidth("❤\ufe0f")).toBe(1) // ❤ BMP = 1 kolom + VS16 = 0
    expect(displayWidth("🩰")).toBe(2)
  })

  test("string kosong nol", () => {
    expect(displayWidth("")).toBe(0)
  })
})

describe("escapeLength", () => {
  test("CSI diukur sampai huruf final", () => {
    expect(escapeLength("\x1b[32m", 0)).toBe(5)
    expect(escapeLength("\x1b[1;2;3H", 0)).toBe(8)
    expect(escapeLength("\x1b[?25l", 0)).toBe(6)
  })

  test("OSC diukur sampai BEL atau ST", () => {
    expect(escapeLength("\x1b]0;judul\u0007", 0)).toBe(10)
    expect(escapeLength("\x1b]0;judul\x1b\\", 0)).toBe(11)
  })

  test("bukan escape → 0", () => {
    expect(escapeLength("abc", 0)).toBe(0)
  })

  test("CSI terpotong tidak melampaui panjang string", () => {
    const s = "\x1b[32"
    expect(escapeLength(s, 0)).toBe(s.length)
  })
})

describe("truncateToWidth", () => {
  test("string yang sudah pendek tidak diubah", () => {
    expect(truncateToWidth("abc", 10)).toBe("abc")
  })

  test("CJK dipotong ke KOLOM, bukan jumlah karakter", () => {
    const out = truncateToWidth("字".repeat(50), 20)
    expect(displayWidth(out)).toBeLessThanOrEqual(20)
    // 20 kolom = 8 karakter CJK + "..." (3 kolom) = 19; bukan 20 karakter.
    expect(Array.from(out.replace("...", "")).length).toBeLessThanOrEqual(9)
  })

  test("tidak pernah melampaui width untuk campuran apa pun", () => {
    const kasus = [
      "这是一个很长的中文句子需要被截断",
      "ab字cd漢ef한gh",
      "😀😀😀😀😀😀😀😀",
      "\x1b[32m这是绿色的中文\x1b[39m",
      "e\u0301e\u0301e\u0301e\u0301e\u0301",
    ]
    for (const s of kasus) {
      for (const w of [1, 2, 3, 5, 10, 15]) {
        expect(displayWidth(truncateToWidth(s, w)), `${s} @ ${w}`).toBeLessThanOrEqual(w)
      }
    }
  })

  test("atribut ANSI ditutup setelah dipotong", () => {
    const out = truncateToWidth(`\x1b[32m${"x".repeat(50)}`, 10)
    expect(out).toContain("\x1b[0m")
  })

  test("emoji tidak terbelah jadi surrogate tunggal", () => {
    const out = truncateToWidth("😀".repeat(10), 5)
    // Roundtrip encode/decode utuh = tidak ada lone surrogate.
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out)
    expect(out).not.toContain("\ufffd")
  })

  test("width 0 mengembalikan kosong", () => {
    expect(truncateToWidth("apa saja", 0)).toBe("")
  })

  test("width lebih kecil dari elipsis tidak menambah elipsis", () => {
    const out = truncateToWidth("abcdef", 2)
    expect(displayWidth(out)).toBeLessThanOrEqual(2)
    expect(out).not.toContain("...")
  })
})

describe("padToWidth", () => {
  test("CJK dipad sesuai kolom", () => {
    expect(displayWidth(padToWidth("字", 6))).toBe(6)
    expect(displayWidth(padToWidth("abc", 6))).toBe(6)
  })

  test("align kanan", () => {
    expect(padToWidth("字", 6, "right")).toBe("    字")
  })

  test("lebih panjang dari width dibiarkan (pemanggil yang memotong)", () => {
    expect(padToWidth("字字字", 2)).toBe("字字字")
  })

  test("ANSI tidak menggeser padding", () => {
    const out = padToWidth("\x1b[32mab\x1b[39m", 5)
    expect(displayWidth(out)).toBe(5)
  })
})

describe("chunkByWidth", () => {
  test("CJK tanpa spasi dipecah per kolom", () => {
    const chunks = chunkByWidth("字".repeat(30), 20)
    expect(chunks.length).toBeGreaterThan(1)
    for (const ch of chunks) expect(displayWidth(ch)).toBeLessThanOrEqual(20)
  })

  test("tidak kehilangan karakter", () => {
    const src = "这是中文abc漢字def"
    expect(chunkByWidth(src, 5).join("")).toBe(src)
  })

  test("string pendek jadi satu potongan", () => {
    expect(chunkByWidth("abc", 10)).toEqual(["abc"])
  })

  test("width 0 mengembalikan potongan kosong (kontrak <= width)", () => {
    // Bug-hunter TUI: kode lama mengembalikan [s] utuh — melanggar kontraknya
    // sendiri (potongan masing-masing <= width).
    expect(chunkByWidth("abc", 0)).toEqual([""])
  })

  test("emoji tidak terbelah antar potongan", () => {
    for (const ch of chunkByWidth("😀".repeat(10), 5)) {
      expect(ch).not.toContain("\ufffd")
      expect(Buffer.from(ch, "utf8").toString("utf8")).toBe(ch)
    }
  })
  test("semua SGR terbuka terbawa (bold+warna), bukan hanya 1", () => {
    // Audit TUI P2-3a: kode lama hanya ingat 1 SGR — bold hilang di potongan 2.
    const src = `\x1b[1m\x1b[31m${"a".repeat(30)}`
    const chunks = chunkByWidth(src, 10)
    expect(chunks.length).toBeGreaterThan(1)
    for (const ch of chunks.slice(1)) {
      expect(ch).toContain("\x1b[1m")
      expect(ch).toContain("\x1b[31m")
    }
  })

  test("kode penutup italic/underline/strike me-reset ingatan SGR", () => {
    // Audit TUI P2-3b: \x1b[23m (italic-off) dulu dianggap pembuka dan bocor
    // ke potongan berikut sebagai gaya basi (kode lama: tiap potongan >1
    // diawali "\x1b[23m").
    const src = `\x1b[3mabc\x1b[23m${"d".repeat(30)}`
    const chunks = chunkByWidth(src, 5)
    expect(chunks.length).toBeGreaterThan(1)
    for (const ch of chunks.slice(1)) expect(ch).not.toContain("23m")
  })

  test("sekuens non-SGR dibuang (defense-in-depth F-04)", () => {
    // truncateToWidth/chunkByWidth dulu menyalin SEMUA escape: satu pemanggil
    // yang lupa sanitizeAnsi = injeksi clear/altscreen.
    expect(truncateToWidth("a\x1b[2Jb", 10)).toBe("ab")
    expect(truncateToWidth("a\x1b[2Jb", 10)).not.toContain("\x1b[2J")
    for (const ch of chunkByWidth("ab\x1b[?1049hcdefgh", 4)) {
      expect(ch).not.toContain("?1049h")
    }
  })

  test("SGR terbuka ditutup otomatis (tanpa bleed)", () => {
    // Early-return muat + tiap chunk: gaya tak boleh bocor ke baris berikut.
    expect(truncateToWidth("\x1b[31mhi", 10)).toBe("\x1b[31mhi\x1b[0m")
    const chunks = chunkByWidth(`\x1b[31m${"a".repeat(30)}`, 10)
    expect(chunks.length).toBeGreaterThan(1)
    for (const ch of chunks.slice(0, -1)) expect(ch.endsWith("\x1b[0m")).toBe(true)
  })
})
