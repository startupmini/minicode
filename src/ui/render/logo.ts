// Block logo minicode: mark wordmark pemilik, dikonversi dari SVG vektor
// (CorelDRAW) menjadi grid 17 kolom × 9 baris sel.
//
// ASPEK PER-SEL — inti modul ini. Satu karakter terminal TIDAK persegi:
// tingginya ±2× lebarnya. Menggambar satu sel = satu karakter penuh membuat
// setiap "kotak" logo tampak persegi panjang (tinggi > lebar). Solusi: setiap
// sel logis dipetakan ke SETENGAH sel karakter (upper/lower half block), yang
// kotak tintanya persegi di terminal tipikal (lebar 1 kolom, tinggi ½ baris).
//
// Komposisi 2 sel logis bertumpuk → 1 baris karakter, memakai glyph set yang
// sudah ada (U+2580–U+2584):
//   atas∅ bawah∅ → ' '
//   atas█ bawah█ → '█' (kedua sel terisi)
//   atas█ bawah∅ → '▀' (hanya sel atas)
//   atas∅ bawah█ → '▄' (hanya sel bawah)
// Hasil: 17 kolom × 5 baris karakter (baris terakhir hanya berisi sel ke-9,
// karena tinggi logis 9 sel — ganjil). Rasio kotak fisik ≈ 17:9, sama dengan
// SVG asli; tidak lagi "dipipihkan" seperti blok karakter penuh.
//
// Fallback: terminal tanpa UTF-8 (MINICODE_ASCII/mini console legacy) memakai
// '#' 9 baris — aspek setengah-sel tidak tersedia di sana, jadi bentuk penuh
// dipertahankan agar pola tidak terpotong.
//
// Dimensi DIVERIFIKASI terhadap SVG (viewBox 8418.09 × 4456.66): 8418.09 =
// 495.18 × 17 kolom, 4456.66 = 495.18 × 9 baris (sel seragam 495.18²).
// Setiap '#' = satu sel terisi (75 polygon → 75 sel).

import { supportsUtf8 } from "./theme.ts"

const ROWS = [
  "           ##### ",
  " ###      #######",
  "#####    ##    ##",
  "##  ### ##     ##",
  "##     ##      ##",
  "##    ##       ##",
  "##   ## ###    ##",
  "######    ### ###",
  " ####      ##### ",
] as const

/** Dimensi logis logo (sel), untuk pemanggil yang butuh geometri/centering. */
export const LOGO_WIDTH = 17
export const LOGO_HEIGHT = 9

/** Glyph sel terisi (fallback ASCII). */
export function logoBlock(): string {
  return supportsUtf8() ? "█" : "#"
}

/** Apakah terminal mampu glyph half-block (U+2580/U+2584/U+2588)? */
export function supportsHalfBlocks(): boolean {
  return supportsUtf8()
}

function halfLine(top: string, bottom: string): string {
  let out = ""
  for (let x = 0; x < LOGO_WIDTH; x++) {
    const up = top[x] === "#"
    const down = bottom[x] === "#"
    if (up && down) out += "█"
    else if (up) out += "▀"
    else if (down) out += "▄"
    else out += " "
  }
  return out
}

/**
 * Baris logo, kotak-per-sel:
 * - UTF-8: gabungkan 2 sel logis per baris dengan glyph half-block (5 baris).
 * - ASCII/legacy: tetap 1 sel per karakter (9 baris) supaya pola tidak hilang.
 */
export function renderLogoRows(): string[] {
  if (!supportsUtf8()) {
    const block = logoBlock()
    return ROWS.map((row) => row.replace(/#/g, block))
  }
  const out: string[] = []
  for (let y = 0; y < ROWS.length; y += 2) {
    const top = ROWS[y] ?? " ".repeat(LOGO_WIDTH)
    const bottom = ROWS[y + 1] ?? " ".repeat(LOGO_WIDTH)
    out.push(halfLine(top, bottom))
  }
  return out
}

/** Jumlah baris hasil render (bukan tinggi grid logis). */
export function renderLogoLineCount(): number {
  return supportsUtf8() ? Math.ceil(LOGO_HEIGHT / 2) : LOGO_HEIGHT
}
