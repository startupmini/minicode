// Wrap composer INKREMENTAL.
//
// Kenapa ada: `chunkByWidth` adalah O(panjang baris). Mengetik satu huruf di
// prompt 5.000 karakter berarti membungkus ulang 5.000 karakter tiap ketukan —
// biaya itulah yang membuat ketikan panjang terasa berat. Karena composer
// menambah/menghapus SELALU di ujung baris, wrap greedy (isi tiap baris
// maksimal) hanya berubah pada baris visual TERAKHIR; baris sebelumnya sudah
// jenuh dan tak terpengaruh.
//
// Kontrak: helper di sini mengembalikan `null` bila pola tak didukung supaya
// pemanggil jatuh balik ke `chunkByWidth` penuh (jawaban aman, bukan jawaban
// salah). Teks composer tak memuat SGR (engine membuang byte kontrol), jadi
// varian tanpa riwayat SGR cukup — SGR apa pun memicu fallback.
import { displayWidth, segmentGraphemes } from "./width.ts"

/** Tabel kelipatan lebar tab, sinkron dengan `chunkByWidth`. */
const TAB_WIDTH = 8

function graphemeColumns(g: string): number {
  if (g === "\t") return TAB_WIDTH
  // Kolom lanjutan grapheme lebar: dihitung per grapheme (bukan per sel).
  return displayWidth(g)
}

/**
 * Perluas `rows` (hasil `chunkByWidth` untuk teks sebelumnya) dengan `appended`
 * di UJUNG, mempertahankan wrap greedy. `null` bila tak bisa (baris kosong,
 * lebar ≤ 0, atau ada newline/SGR) — pemanggil membungkus ulang penuh.
 */
export function appendWrapped(rows: string[], appended: string, width: number): string[] | null {
  if (!rows.length || width <= 0) return null
  if (appended.includes("\n") || appended.includes("\r") || appended.includes("\x1b")) return null
  const out = rows.slice(0, -1)
  let buf = rows[rows.length - 1]!
  for (const g of segmentGraphemes(appended)) {
    const gw = graphemeColumns(g)
    if (gw <= 0) {
      // Grapheme nol-lebar menempel ke buf tanpa menghabiskan kolom.
      buf += g
      continue
    }
    if (displayWidth(buf) + gw > width && buf !== "") {
      out.push(buf)
      buf = ""
    }
    buf += g
  }
  out.push(buf)
  return out
}

/**
 * Buang `removed` (UTF-16, harus menjadi AKHIR baris visual terakhir) dari
 * `rows`. `null` bila baris terakhir tak diakhiri `removed` (mis. batas
 * grapheme berbeda) — pemanggil membungkus ulang penuh.
 */
export function shaveWrapped(rows: string[], removed: string, width: number): string[] | null {
  if (!rows.length || width <= 0 || !removed) return null
  if (removed.includes("\x1b")) return null
  const last = rows[rows.length - 1]!
  if (!last.endsWith(removed)) return null
  const trimmed = last.slice(0, last.length - removed.length)
  if (trimmed === "") {
    // Baris terakhir habis. Baris sebelumnya jenuh, jadi cukup pop — tapi bila
    // ini satu-satunya baris, serahkan ke pemanggil (prefix prompt bisa hilang
    // saat baris jadi kosong dan special-case `!line` yang menanganinya).
    if (rows.length === 1) return null
    return rows.slice(0, -1)
  }
  const out = rows.slice(0, -1)
  out.push(trimmed)
  return out
}
