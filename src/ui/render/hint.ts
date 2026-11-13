// Petunjuk aksi minimalis untuk jendela pilihan / manager / form.
//
// Bentuk sengaja "a add" (bukan "a: add"): kunci pendek, pemisah satu SPASI,
// label redup — kunci yang bisa ditekan lebih terang. Ini menyeragamkan seluruh
// jendela MiniCode yang sebelumnya menulis hint dengan gaya berbeda-beda
// ("a add · d delete" vs footer form vs tanpa hint sama sekali), dan tetap
// mematuhi kontrak v7.8 (tanpa judul, tanpa footer dekoratif di dalam kotak):
// hint ditaruh sebagai baris body paling bawah, bukan chrome kotak.
import { c } from "../render/theme.ts"

export interface HintItem {
  /** Tombol yang benar-benar berlaku di permukaan ini. */
  key: string
  /** Label pendek, title case/lowercase mengikuti bahasa. */
  label: string
}

/** Warna kunci (lebih terang) vs label (redup) — aksesibel tanpa warna. */
export function paintHint(item: HintItem): string {
  return `${c.accent(item.key)} ${c.dim(item.label)}`
}

/** Satu baris hint: `a add · d hapus · Esc tutup` (tanpa awalan/akhiran).
 * Tanpa pembungkus faint di seluruh baris: itu akan meredupkan KUNCI juga
 * (SGR 2 tak dibatalkan warna). Kunci = accent (lebih terang), label = dim. */
export function hintLine(items: readonly HintItem[]): string {
  return items.map(paintHint).join(` ${c.faint("·")} `)
}
