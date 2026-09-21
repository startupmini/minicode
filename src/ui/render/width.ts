// Lebar tampil karakter di terminal.
//
// Semua kode UI sebelumnya menganggap 1 karakter = 1 kolom. Itu salah untuk CJK,
// Hangul, kana, emoji, dan simbol lebar-penuh — semuanya memakan DUA kolom.
// Akibatnya nyata: 38 code point CJK menempati 73 kolom di terminal 40 kolom,
// baris membungkus sendiri, dan frame TUI (yang dihitung per baris) rusak.
//
// Karakter penggabung (combining marks, variation selector, ZWJ) sebaliknya
// memakan NOL kolom — "é" sebagai e+U+0301 adalah satu kolom, bukan dua.
//
// Referensi: EastAsianWidth (UAX #11) kategori W dan F. Rentang di bawah adalah
// blok utama yang relevan untuk keluaran terminal; tidak perlu tabel lengkap
// Unicode karena kesalahan pada blok langka jauh lebih murah daripada
// menyeret dependensi.

/** Rentang lebar-ganda (UAX #11 kategori W/F). */
const WIDE: [number, number][] = [
  [0x1100, 0x115f], // Hangul Jamo awal
  [0x2e80, 0x303e], // CJK Radicals, Kangxi, simbol CJK
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul Compat, CJK Compat
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Ext A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compat Ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK Compat Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Emoji: simbol & pictograph, emoticon
  [0x1f680, 0x1f6ff], // Transport
  [0x1f900, 0x1f9ff], // Supplemental symbols
  [0x1fa70, 0x1faff], // Extended-A
  [0x20000, 0x2fffd], // CJK Ext B+
  [0x30000, 0x3fffd],
]

/** Rentang lebar-nol: combining marks, variation selector, ZWJ, kontrol format. */
const ZERO: [number, number][] = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0900, 0x0903],
  [0x093a, 0x093a],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x1ab0, 0x1aff], // Combining Diacritical Marks Extended
  [0x1dc0, 0x1dff], // Combining Diacritical Marks Supplement
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x2028, 0x202e], // separator & bidi
  [0x20d0, 0x20f0], // Combining Diacritical Marks for Symbols
  [0xfe00, 0xfe0f], // Variation Selectors
  [0xfe20, 0xfe2f], // Combining Half Marks
  [0xfeff, 0xfeff], // BOM / ZWNBSP
  [0xe0100, 0xe01ef], // Variation Selectors Supplement
]

function inRanges(cp: number, ranges: [number, number][]): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [start, end] = ranges[mid]!
    if (cp < start) hi = mid - 1
    else if (cp > end) lo = mid + 1
    else return true
  }
  return false
}

/** Lebar kolom satu code point: 0, 1, atau 2. */
export function charWidth(cp: number): number {
  if (cp === 0) return 0
  // C0/C1 control: tidak menempati kolom (dan seharusnya tidak sampai ke layar).
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (inRanges(cp, ZERO)) return 0
  if (inRanges(cp, WIDE)) return 2
  return 1
}

/**
 * Lebar tampil string dalam kolom terminal. Sekuens ANSI dan karakter
 * penggabung tidak dihitung; CJK/emoji dihitung dua.
 */
export function displayWidth(s: string): number {
  let w = 0
  let i = 0
  while (i < s.length) {
    // Lewati sekuens escape — tidak menempati kolom.
    if (s[i] === "\x1b") {
      const len = escapeLength(s, i)
      if (len > 0) {
        i += len
        continue
      }
    }
    const cp = s.codePointAt(i)!
    w += charWidth(cp)
    i += cp > 0xffff ? 2 : 1
  }
  return w
}

// Klasifikasi byte di dalam CSI: parameter (digit/;/:/</=/>/?), intermediate
// (!#$%&'()*+,-./), atau final (A-Z a-z @ [ \ ] ^ _ ` { | } ~). SPASI sengaja
// TIDAK dianggap intermediate: jauh lebih sering itu teks biasa yang mengikuti
// sekuens yang terpotong daripada bagian dari sekuens itu sendiri.
function csiByteKind(b: number): "param" | "inter" | "final" | "other" {
  if (b >= 0x40 && b <= 0x7e) return "final"
  if (b >= 0x30 && b <= 0x3f) return "param"
  if (b >= 0x21 && b <= 0x2f) return "inter"
  return "other"
}

/** Panjang sekuens escape yang mulai di `i`, atau 0 bila bukan escape. */
export function escapeLength(s: string, i: number): number {
  if (s[i] !== "\x1b") return 0
  const next = s[i + 1]
  if (next === "[") {
    // CSI: ESC [ params intermediate* final-byte
    let j = i + 2
    while (j < s.length) {
      const kind = csiByteKind(s.charCodeAt(j)!)
      if (kind === "param" || kind === "inter") j++
      else break
    }
    if (j < s.length && csiByteKind(s.charCodeAt(j)!) === "final") return j - i + 1
    // Tidak ada byte final yang sah: konsumsi HANYA parameter yang sudah
    // terbaca. Sebelumnya scan meneruskan sampai huruf berikutnya di TEKS
    // ("a ESC[33 world" → 'w' ikut ditelan jadi "a orld") — data loss.
    return Math.min(j, s.length) - i
  }
  if (next === "]") {
    // OSC: ESC ] ... BEL | ESC \
    const bel = s.indexOf("\u0007", i + 2)
    const st = s.indexOf("\x1b\\", i + 2)
    if (bel !== -1 && (st === -1 || bel < st)) return bel - i + 1
    if (st !== -1) return st - i + 2
    return s.length - i
  }
  if (next === "P" || next === "_" || next === "^" || next === "X") {
    // DCS/APC/PM/SOS: ESC P/_/^/X ... BEL | ESC \
    const bel = s.indexOf("\u0007", i + 2)
    const st = s.indexOf("\x1b\\", i + 2)
    if (bel !== -1 && (st === -1 || bel < st)) return bel - i + 1
    if (st !== -1) return st - i + 2
    return s.length - i
  }
  // ESC ( B, ESC ) 0, ESC # 8 — charset & DEC line size, 3 byte.
  if (next === "(" || next === ")" || next === "#") return 3
  // ESC diikuti byte final tunggal (ESC 7, ESC =, ESC M, …) = 2 byte.
  // ESC di ujung string = 1 byte. Karakter setelahnya yang BUKAN bagian
  // sekuens (mis. huruf biasa) tidak boleh ikut ditelan — itu membuat teks
  // hilang, jadi hanya byte final yang sah (0x30–0x7E) yang dihitung.
  if (next === undefined) return 1
  const code = next.charCodeAt(0)
  return code >= 0x30 && code <= 0x7e ? 2 : 1
}

/**
 * Potong string ke `width` KOLOM (bukan jumlah karakter), pertahankan sekuens
 * ANSI utuh, dan tutup atribut yang masih terbuka. Tidak pernah membelah
 * surrogate pair atau memisahkan combining mark dari basisnya.
 */
export function truncateToWidth(s: string, width: number, ellipsis = "..."): string {
  if (width <= 0) return ""
  if (displayWidth(s) <= width) return s

  const ellW = displayWidth(ellipsis)
  const budget = width > ellW ? width - ellW : width
  let out = ""
  let w = 0
  let sawSgr = false
  let i = 0
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const len = escapeLength(s, i)
      if (len > 0) {
        const seq = s.slice(i, i + len)
        if (seq.endsWith("m")) sawSgr = true
        out += seq
        i += len
        continue
      }
    }
    const cp = s.codePointAt(i)!
    const cw = charWidth(cp)
    if (w + cw > budget) break
    const size = cp > 0xffff ? 2 : 1
    out += s.slice(i, i + size)
    w += cw
    i += size
  }
  const tail = width > ellW ? ellipsis : ""
  return sawSgr ? `${out}\x1b[0m${tail}` : out + tail
}

/** Sisipkan spasi agar lebar tampil mencapai `width`. */
export function padToWidth(s: string, width: number, align: "left" | "right" = "left"): string {
  const diff = width - displayWidth(s)
  if (diff <= 0) return s
  const pad = " ".repeat(diff)
  return align === "right" ? pad + s : s + pad
}

/**
 * Pecah string menjadi potongan yang masing-masing <= `width` kolom.
 * Dipakai untuk teks tanpa spasi (CJK, URL panjang, hash) yang tidak bisa
 * dipecah di batas kata.
 */
export function chunkByWidth(s: string, width: number): string[] {
  if (width <= 0) return [s]
  const out: string[] = []
  let cur = ""
  let w = 0
  let i = 0
  // Sekuens SGR yang masih "terbuka" — disuntikkan ke potongan berikutnya
  // agar warna tidak hilang saat kata berwarna panjang dipecah. SEMUA pembuka
  // diingat (bukan satu): `\x1b[1m\x1b[31m…` yang terbelah harus membawa bold
  // DAN merah ke potongan berikut. Reset/off (0, 22–29, 39, 49) mengosongkan
  // tumpukan — arah aman: potongan berikut mulai tanpa gaya daripada dengan
  // gaya basi yang salah.
  const SGR_OFF = new Set(["0", "22", "23", "24", "25", "27", "28", "29", "39", "49"])
  let openSgr: string[] = []
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const len = escapeLength(s, i)
      if (len > 0) {
        const seq = s.slice(i, i + len)
        if (seq.endsWith("m")) {
          const params = seq.slice(2, -1).split(/[:;]/)
          if (params.some((p) => SGR_OFF.has(p) || p === "")) openSgr = []
          if (params.some((p) => p !== "" && !SGR_OFF.has(p))) {
            openSgr.push(seq)
            // Batas tumpukan: input patologis (ganti warna tiap karakter tanpa
            // reset) tak boleh membuat tiap potongan membawa ratusan sekuens.
            if (openSgr.length > 8) openSgr = openSgr.slice(-8)
          }
        }
        cur += seq
        i += len
        continue
      }
    }
    const cp = s.codePointAt(i)!
    const cw = charWidth(cp)
    const size = cp > 0xffff ? 2 : 1
    if (w + cw > width && cur !== "") {
      out.push(cur)
      cur = openSgr.join("") // lanjutkan warna ke potongan berikutnya
      w = 0
    }
    cur += s.slice(i, i + size)
    w += cw
    i += size
  }
  if (cur !== "") out.push(cur)
  return out.length ? out : [""]
}
