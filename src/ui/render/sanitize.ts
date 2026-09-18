// Sanitasi sekuens ANSI dari sumber tidak terpercaya (teks model, hasil tool,
// isi berkas).
//
// Renderer sengaja MEMPERTAHANKAN warna — itulah kenapa diff card hijau/merah
// dan markdown bold bekerja. Tapi mempertahankan semua sekuens berarti model
// bisa mengirim:
//   ESC[2J ESC[H        bersihkan layar & pindahkan kursor
//   ESC[?1049h/l        masuk/keluar alternate screen (merusak TUI)
//   ESC]0;judul BEL     ubah judul jendela terminal
//   ESC[999B            geser kursor keluar area yang dihitung renderer
//   ESC[?25l            sembunyikan kursor secara permanen
// Terverifikasi: teks model `aman\x1b[2J\x1b[H\x1b[?1049hJAHAT` benar-benar
// sampai ke terminal utuh.
//
// Kebijakan: HANYA SGR (`ESC[…m`) yang dipertahankan — itu satu-satunya yang
// dibutuhkan untuk warna dan atribut teks. Semua sekuens lain dibuang, termasuk
// OSC, DCS, dan CSI non-SGR. Karakter kontrol C0 selain tab dibuang juga
// (BEL membunyikan bel terminal, BS/CR memindahkan kursor mundur).

import { escapeLength } from "./width.ts"

/** Apakah sekuens di posisi `i` adalah SGR (pewarnaan) yang boleh lewat? */
function isSgr(s: string, i: number, len: number): boolean {
  if (s[i + 1] !== "[") return false
  // SGR berakhir dengan 'm' dan parameternya hanya digit/;/: (bukan '?', '<', dll).
  if (s[i + len - 1] !== "m") return false
  for (let k = i + 2; k < i + len - 1; k++) {
    const ch = s[k]!
    if (!(ch >= "0" && ch <= "9") && ch !== ";" && ch !== ":") return false
  }
  return true
}

/**
 * Buang semua sekuens kontrol kecuali SGR. Teks tampak tidak berubah.
 *
 * Dipakai pada SEMUA teks yang berasal dari luar: `provider:text`, isi hasil
 * tool, dan konten berkas yang ditampilkan.
 */
export function sanitizeAnsi(s: string): string {
  let out = ""
  let i = 0
  while (i < s.length) {
    const ch = s[i]!
    if (ch === "\x1b") {
      const len = escapeLength(s, i)
      if (len > 0) {
        if (isSgr(s, i, len)) out += s.slice(i, i + len)
        i += len
        continue
      }
      // ESC tunggal tanpa sekuens yang dikenali: buang.
      i += 1
      continue
    }
    // Kontrol C0: tab & newline dipertahankan (pemanggil yang memecah baris),
    // sisanya dibuang. CR khususnya berbahaya — ia menimpa baris yang sudah
    // digambar.
    const code = ch.charCodeAt(0)
    if (code < 0x20 && ch !== "\t" && ch !== "\n") {
      i += 1
      continue
    }
    if (code === 0x7f) {
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * Versi satu-baris: newline juga dibuang (jadi spasi).
 * Untuk tempat yang menggambar tepat satu baris — judul, label, sel tabel.
 */
export function sanitizeAnsiLine(s: string): string {
  return sanitizeAnsi(s).replace(/\n/g, " ")
}

// ── Sanitasi sadar-stream (temuan F1) ──
//
// sanitizeAnsi() bekerja pada string utuh, sedangkan teks model datang
// per-chunk: escape yang terpotong tepat di batas ("ESC[" + "32mHello")
// tampil literal "32mHello". Strateginya: tahan ekor yang MUNGKIN sekuens
// tak-lengkap, sambung ke chunk berikut SEBELUM sanitasi. Hanya ekor
// tak-lengkap yang ditahan — sekuens lengkap langsung disanitasi seperti
// dulu (perilaku lama utuh, tanpa duplikasi logika grammar: aturan
// "lengkap vs terpotong" mencerminkan escapeLength di width.ts).

/** Batas ekor tahan: OSC tanpa terminator tak boleh tumbuh tanpa batas. */
const MAX_ESC_TAIL = 4096

function isCsiParamOrInter(code: number): boolean {
  // Sama seperti csiByteKind di width.ts: parameter 0x30–0x3F, intermediate
  // 0x21–0x2F. SPASI bukan intermediate (komentar di width.ts).
  return (code >= 0x30 && code <= 0x3f) || (code >= 0x21 && code <= 0x2f)
}

/**
 * Pisahkan kemungkinan ekor escape tak-lengkap di ujung string.
 * Kembalikan {head, tail}: head aman disanitasi SEKARANG, tail wajib
 * disambung ke chunk berikut (atau dibuang saat stream selesai — tak pernah
 * render mentah). Sekuens lengkap tidak pernah ditahan.
 */
export function splitTrailingEscape(s: string): { head: string; tail: string } {
  const idx = s.lastIndexOf("\x1b")
  if (idx === -1) return { head: s, tail: "" }
  const next = s[idx + 1]
  // ESC tunggal di ujung: bisa menjadi awal apa pun → tahan.
  if (next === undefined) return { head: s.slice(0, idx), tail: s.slice(idx) }
  if (next === "[") {
    // CSI: lengkap bila ada byte final sebelum string habis.
    let j = idx + 2
    while (j < s.length && isCsiParamOrInter(s.charCodeAt(j)!)) j++
    if (j >= s.length) return { head: s.slice(0, idx), tail: s.slice(idx) }
    return { head: s, tail: "" }
  }
  if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
    // OSC/DCS/APC/PM/SOS: lengkap bila ada terminator BEL atau ESC \.
    const rest = s.slice(idx + 2)
    if (!rest.includes("\u0007") && !rest.includes("\x1b\\")) {
      return { head: s.slice(0, idx), tail: s.slice(idx) }
    }
    return { head: s, tail: "" }
  }
  if (next === "(" || next === ")" || next === "#") {
    // Charset 3-byte: tahan bila terpotong.
    if (s.length - idx < 3) return { head: s.slice(0, idx), tail: s.slice(idx) }
    return { head: s, tail: "" }
  }
  // Fe 2-byte (ESC 7, ESC M, …): lengkap.
  return { head: s, tail: "" }
}

/**
 * Sanitizer stateful untuk satu stream teks: push() per chunk, flush() saat
 * stream selesai. Ekor tak-lengkap yang tersisa di flush() DIBUANG (bukan
 * dirender) — escape tanpa teks lanjutan tak punya efek tampak kecuali
 * mutasi state terminal, yang tak pernah diinginkan dari teks tak-terpercaya.
 */
export interface StreamSanitizer {
  push(chunk: string): string
  flush(): string
}

export function createStreamSanitizer(): StreamSanitizer {
  let tail = ""
  return {
    push(chunk: string): string {
      const combined = tail + chunk
      const part = splitTrailingEscape(combined)
      tail = part.tail.length > MAX_ESC_TAIL ? "" : part.tail
      return sanitizeAnsi(part.head)
    },
    flush(): string {
      tail = ""
      return ""
    },
  }
}

// ── Kebijakan ANSI non-TTY (temuan F2) ──

const ESC_CH = String.fromCharCode(27)

/** Buang SGR (sesudah sanitizeAnsi, hanya ini yang tersisa) untuk pipa. */
export function stripSgr(s: string): string {
  // Pola dibangun tanpa literal kontrol (aturan lint noControlCharactersInRegex).
  return s.replace(new RegExp(`${ESC_CH}\\[[0-9;:]*m`, "g"), "")
}

/**
 * Satu pintu kebijakan ANSI teks tak-terpercaya: TTY → SGR dipertahankan
 * (renderer mewarnai); non-TTY → semua ANSI dibuang agar pipe/CI
 * deterministik. Cerminan colorLevel() di theme.ts yang mengacu
 * stdout.isTTY — satu aturan untuk semua stream.
 */
export function cleanUntrusted(s: string, stdoutTty: boolean): string {
  const clean = sanitizeAnsi(s)
  return stdoutTty ? clean : stripSgr(clean)
}
