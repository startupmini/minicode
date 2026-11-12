// Lebar tampil teks dalam kolom terminal.
//
// Ukur per grapheme, bukan per code point: satu emoji keluarga atau flag
// tersusun dari beberapa scalar tetapi tampil sebagai satu glyph dua kolom.
// Combining marks melekat pada base dan tidak menambah lebar sendiri.
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
  [0xe0020, 0xe007f], // Tag characters used by emoji flag sequences
]

const UNICODE_MARK = /\p{Mark}/u
const EMOJI = /\p{Emoji}/u
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u
let widthSegmenter: Intl.Segmenter | undefined

export function segmentGraphemes(text: string): string[] {
  try {
    widthSegmenter ??= new Intl.Segmenter("und", { granularity: "grapheme" })
    return Array.from(widthSegmenter.segment(text), (part) => part.segment)
  } catch {
    // Bun yang didukung MiniCode menyediakan Intl.Segmenter; fallback ini
    // menjaga module tetap bisa dipakai di runtime tertanam yang lebih tua.
    return Array.from(text)
  }
}

export function graphemeWidth(grapheme: string): number {
  const points = Array.from(grapheme, (part) => part.codePointAt(0)!)
  const has = (from: number, to: number): boolean => points.some((cp) => cp >= from && cp <= to)
  const containsEmoji = points.some((cp) => EMOJI.test(String.fromCodePoint(cp)))
  const containsPictograph = points.some((cp) =>
    EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(cp)),
  )
  if (
    has(0x20e3, 0x20e3) || // keycap
    has(0x1f1e6, 0x1f1ff) || // regional-indicator flag (including a lone RI, conservatively)
    has(0x1f3fb, 0x1f3ff) || // skin-tone modifier
    (has(0x200d, 0x200d) && containsPictograph) || // emoji ZWJ sequence
    (has(0xfe0f, 0xfe0f) && containsEmoji) || // explicit emoji presentation
    points.some((cp) => EMOJI_PRESENTATION.test(String.fromCodePoint(cp)))
  ) {
    return 2
  }
  let width = 0
  for (const cp of points) width += charWidth(cp)
  return width
}

interface DisplayToken {
  text: string
  width: number
  escape: boolean
}

/** Token terminal: escape utuh atau grapheme utuh dengan lebar display yang sama. */
function* displayTokens(s: string): Generator<DisplayToken> {
  let i = 0
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const length = escapeLength(s, i)
      if (length > 0) {
        yield { text: s.slice(i, i + length), width: 0, escape: true }
        i += length
        continue
      }
    }
    let end = s.indexOf("\x1b", i)
    if (end < 0) end = s.length
    if (end === i) end = i + 1
    const run = s.slice(i, end)
    for (const text of segmentGraphemes(run)) {
      yield { text, width: graphemeWidth(text), escape: false }
    }
    i = end
  }
}

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

/** Lebar kolom satu code point: 0, 1, 2, atau 8 (tab). */
export function charWidth(cp: number): number {
  if (cp === 0) return 0
  // Tab dirender terminal sebagai lompatan ke stop berikutnya (kelipatan 8).
  // Tanpa posisi kolom, hitung 8 = batas atas: tak pernah undercount (arah
  // aman — overcount hanya wrap lebih awal, undercount merusak frame/popup).
  // sanitizeAnsi SENGAJA mempertahankan tab agar isi (indentasi kode) utuh.
  if (cp === 0x09) return 8
  // C0/C1 control: tidak menempati kolom (dan seharusnya tidak sampai ke layar).
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (inRanges(cp, ZERO) || UNICODE_MARK.test(String.fromCodePoint(cp))) return 0
  if (inRanges(cp, WIDE)) return 2
  return 1
}

/**
 * Lebar tampil string dalam kolom terminal. Sekuens ANSI dan karakter
 * penggabung tidak dihitung; CJK/fullwidth dan emoji presentation dihitung
 * dua kolom per grapheme. Lebar glyph spesifik terminal tidak diprobe.
 */
export function displayWidth(s: string): number {
  let w = 0
  for (const token of displayTokens(s)) if (!token.escape) w += token.width
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

/** Parameter SGR yang menutup gaya (reset/off) — arah aman saat pecah chunk. */
const SGR_OFF = new Set(["0", "22", "23", "24", "25", "27", "28", "29", "39", "49"])

/** True bila sekuens escape utuh adalah SGR pewarnaan (satu-satunya yang boleh lewat). */
function isSgrSeq(seq: string): boolean {
  if (!seq.startsWith("\x1b[") || !seq.endsWith("m")) return false
  const params = seq.slice(2, -1)
  if (params === "") return true
  return params.split(/[:;]/).every((p) => p === "" || /^[0-9]+$/.test(p))
}

/**
 * True bila string berakhir dengan gaya SGR masih terbuka (butuh reset).
 *
 * Parameter diproses BERURUTAN, bukan "ada OFF di mana pun": `\x1b[0;31m`
 * berarti reset lalu merah (= masih terbuka), sedangkan `some(SGR_OFF)` lama
 * menyimpulkan tertutup dan tak menambahkan reset → warna bocor ke sisa baris
 * (audit 2026-11-12, HIGH-7). Parameter extended color (`38;2;r;g;b`,
 * `38;5;n`) juga dikonsumsi sebagai satu atribut: komponen warnanya bisa
 * bernilai 0 dan tidak boleh disalahartikan sebagai reset.
 */
function sgrLeftOpen(s: string): boolean {
  let open = false
  let i = 0
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const len = escapeLength(s, i)
      if (len > 0) {
        const seq = s.slice(i, i + len)
        if (isSgrSeq(seq)) open = sgrParamsEndOpen(seq.slice(2, -1).split(/[:;]/), open)
        i += len
        continue
      }
    }
    const cp = s.codePointAt(i)!
    i += cp > 0xffff ? 2 : 1
  }
  return open
}

/** State "masih terbuka" setelah satu sekuens SGR, mengikuti urutan parameter. */
function sgrParamsEndOpen(params: string[], open: boolean): boolean {
  let state = open
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!
    if (p === "" || p === "0") {
      state = false
      continue
    }
    // Extended color: 38/48/58 diikuti 5;n atau 2;r;g;b — satu atribut utuh.
    if (p === "38" || p === "48" || p === "58") {
      const mode = params[i + 1]
      i += mode === "5" ? 2 : mode === "2" ? 4 : 1
      state = true
      continue
    }
    // OFF hanya menutup satu atribut; atribut lain bisa tetap aktif, jadi
    // status dibiarkan (arah aman: reset ekstra tak berbahaya).
    if (SGR_OFF.has(p)) continue
    state = true
  }
  return state
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
  // ESC ( B, ESC ) 0, ESC # 8 — charset & DEC line size, 3 byte (dibatasi sisa string).
  if (next === "(" || next === ")" || next === "#") return Math.min(3, s.length - i)
  // ESC diikuti byte final tunggal (ESC 7, ESC =, ESC M, …) = 2 byte.
  // ESC di ujung string = 1 byte. Karakter setelahnya yang BUKAN bagian
  // sekuens (mis. huruf biasa) tidak boleh ikut ditelan — itu membuat teks
  // hilang, jadi hanya byte final yang sah (0x30–0x7E) yang dihitung.
  if (next === undefined) return 1
  const code = next.charCodeAt(0)
  return code >= 0x30 && code <= 0x7e ? 2 : 1
}

/** True bila string memuat escape non-SGR (atau ESC liar) yang wajib dibuang. */
function hasNonSgrEscape(s: string): boolean {
  let i = 0
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const len = escapeLength(s, i)
      if (len <= 0 || !isSgrSeq(s.slice(i, i + len))) return true
      i += len
      continue
    }
    const cp = s.codePointAt(i)!
    i += cp > 0xffff ? 2 : 1
  }
  return false
}
/**
 * Potong string ke `width` KOLOM (bukan jumlah karakter), pertahankan sekuens
 * ANSI utuh, dan tutup atribut yang masih terbuka. Tidak pernah membelah
 * surrogate pair atau memisahkan combining mark dari basisnya.
 */
export function truncateToWidth(s: string, width: number, ellipsis = "..."): string {
  if (width <= 0) return ""
  // Muat tanpa potong DAN tanpa escape asing: tetap tutup SGR yang terbuka
  // agar tak bleed ke chrome berikut (dulu early-return membocorkan warna).
  // Bila ada non-SGR, jatuh ke loop filter di bawah (tanpa ellipsis bila
  // akhirnya tak ada yang dipotong).
  if (displayWidth(s) <= width && !hasNonSgrEscape(s)) {
    return sgrLeftOpen(s) ? `${s}\x1b[0m` : s
  }

  const ellW = displayWidth(ellipsis)
  const budget = width > ellW ? width - ellW : width
  let out = ""
  let w = 0
  let sawSgr = false
  let cut = false
  for (const token of displayTokens(s)) {
    if (token.escape) {
      // Hanya SGR yang disalin — sekuens kontrol lain (clear, alternate
      // screen, OSC) DIBUANG di sini agar satu pemanggil yang lupa sanitasi
      // tidak menjadi injeksi terminal (defense-in-depth, bukan pengganti
      // sanitizeAnsi di batas input tak-terpercaya).
      if (!isSgrSeq(token.text)) continue
      if (token.text.endsWith("m")) sawSgr = true
      out += token.text
      continue
    }
    if (w + token.width > budget) {
      cut = true
      break
    }
    out += token.text
    w += token.width
  }
  const tail = cut && width > ellW ? ellipsis : ""
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
  if (width <= 0) return [""]
  const out: string[] = []
  let cur = ""
  let w = 0
  // Sekuens SGR yang masih "terbuka" — disuntikkan ke potongan berikutnya
  // agar warna tidak hilang saat kata berwarna panjang dipecah. SEMUA pembuka
  // diingat (bukan satu): `\x1b[1m\x1b[31m…` yang terbelah harus membawa bold
  // DAN merah ke potongan berikut. Reset/off (0, 22–29, 39, 49) mengosongkan
  // tumpukan — arah aman: potongan berikut mulai tanpa gaya daripada dengan
  // gaya basi yang salah.
  // Non-SGR DIBUANG seperti truncateToWidth (defense-in-depth yang sama).
  let openSgr: string[] = []
  const pushChunk = (): void => {
    out.push(openSgr.length > 0 ? `${cur}\x1b[0m` : cur)
    cur = openSgr.join("") // lanjutkan warna ke potongan berikutnya
    w = 0
  }
  for (const token of displayTokens(s)) {
    if (token.escape) {
      const seq = token.text
      if (!isSgrSeq(seq)) continue
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
      continue
    }
    if (w + token.width > width && cur !== "") {
      pushChunk()
    }
    cur += token.text
    w += token.width
  }
  if (cur !== "") pushChunk()
  return out.length ? out : [""]
}

/**
 * Pecah string ke potongan <= `width` kolom, TAPI word-aware: lebih suka
 * memutus di batas kata (spasi) daripada membelah kata di tengah. Token tanpa
 * spasi yang lebih panjang dari `width` (URL, hash, CJK panjang) jatuh-balik
 * ke pemotongan per-kolom. ANSI-safe (SGR terbuka dibawa ke potongan berikut,
 * non-SGR dibuang) — identik dengan `chunkByWidth`.
 *
 * Spasi yang tepat TIDAK muat menjadi titik putus; spasi itu (dan spasi-trailing
 * yang tak terlihat) dibuang, bukan dipindah ke baris berikutnya.
 */
export function wrapByWidth(s: string, width: number): string[] {
  if (width <= 0) return [""]
  const out: string[] = []
  let line = ""
  let lineWidth = 0
  let openSgr: string[] = []
  let word = ""
  let wordWidth = 0

  const trackSgr = (seq: string): void => {
    if (!seq.endsWith("m")) return
    const params = seq.slice(2, -1).split(/[:;]/)
    if (params.some((p) => SGR_OFF.has(p) || p === "")) openSgr = []
    if (params.some((p) => p !== "" && !SGR_OFF.has(p))) {
      openSgr.push(seq)
      if (openSgr.length > 8) openSgr = openSgr.slice(-8)
    }
  }

  const flush = (): void => {
    if (line !== "") out.push(openSgr.length > 0 ? `${line}\x1b[0m` : line)
    line = openSgr.join("")
    lineWidth = 0
  }

  const placeWord = (): void => {
    if (wordWidth === 0) {
      word = ""
      return
    }
    if (lineWidth + wordWidth <= width) {
      line += word
      lineWidth += wordWidth
    } else if (wordWidth <= width) {
      // Kata utuh pindah ke baris berikutnya (bukan dibelah di tengah).
      flush()
      line += word
      lineWidth += wordWidth
    } else {
      // Token tanpa spasi > width: potong per kolom (chunkByWidth, sgr-safe).
      if (lineWidth > 0) flush()
      const pieces = chunkByWidth(word, width)
      for (let i = 0; i < pieces.length - 1; i++) {
        const piece = pieces[i]!
        out.push(openSgr.length > 0 && !piece.endsWith("\x1b[0m") ? `${piece}\x1b[0m` : piece)
      }
      line = pieces[pieces.length - 1] ?? ""
      lineWidth = displayWidth(line)
    }
    word = ""
    wordWidth = 0
  }

  for (const token of displayTokens(s)) {
    if (token.escape) {
      const seq = token.text
      if (!isSgrSeq(seq)) continue
      word += seq
      trackSgr(seq)
      continue
    }
    if (token.text === " ") {
      placeWord()
      if (lineWidth + 1 <= width) {
        line += " "
        lineWidth += 1
      }
      continue
    }
    word += token.text
    wordWidth += token.width
  }
  placeWord()
  if (line !== "" || out.length === 0) flush()
  return out.length ? out : [""]
}
