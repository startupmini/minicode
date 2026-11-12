// Word-wrap + justify (rata kanan-kiri) - untuk output teks AI.
//
// Semua pengukuran memakai KOLOM terminal (src/ui/render/width.ts), bukan jumlah
// karakter: CJK/emoji memakan dua kolom, combining mark nol, dan sekuens ANSI
// tidak menempati kolom sama sekali.
//
// stripAnsi di-re-export dari theme.ts: dulu ada dua implementasi terpisah, dan
// yang di sini tidak ikut diperbaiki saat pola ANSI diperluas untuk sekuens
// private-mode (ESC[?25l dsb.).

import { stripAnsi } from "./theme.ts"
import { chunkByWidth, displayWidth } from "./width.ts"

export { stripAnsi }

/** Lebar tampil dalam kolom terminal. */
export function visibleLen(s: string): number {
  return displayWidth(s)
}

/**
 * Wrap teks ke baris-baris <= `width` KOLOM, dipotong di batas spasi.
 *
 * Kata yang sendirian sudah lebih lebar dari `width` (URL panjang, hash, atau
 * teks CJK yang memang tidak punya spasi) dipecah per kolom — sebelumnya
 * dibiarkan utuh sehingga baris membungkus sendiri di terminal dan merusak
 * frame TUI yang menghitung tinggi per baris.
 */
export function wordWrap(text: string, width: number): string {
  if (width <= 0) return text
  const out: string[] = []
  for (const line of text.split("\n")) {
    if (displayWidth(line) <= width) {
      out.push(line)
      continue
    }
    let current = ""
    const flush = () => {
      if (current !== "") {
        // Spasi pemisah di ujung tidak ikut tampil.
        out.push(current.trimEnd())
        current = ""
      }
    }
    // Pisah dengan pemisah tertangkap agar spasi ganda (ASCII art/tabel)
    // tetap utuh — run whitespace menempel ke kata berikut, wrap hanya putus
    // di batas run (spasi di ujung baris dibuang saat flush).
    for (const tok of line.split(/(\s+)/)) {
      if (tok === "") continue
      if (/^\s+$/.test(tok)) {
        // Run whitespace di AWAL baris = indentasi, bukan pemisah: ia harus
        // ikut baris pertama. Dulu run ini dibuang saat `current` masih kosong
        // sehingga indentasi & marker list panjang hilang di jalur linear
        // (audit 2026-11-12, HIGH-6).
        current += tok
        continue
      }
      const word = tok
      // Kata tunggal lebih lebar dari baris: pecah paksa per kolom.
      if (displayWidth(word) > width) {
        // Indentasi (bila ada) menempel ke potongan PERTAMA dan menyusutkan
        // lebar potongan itu — tanpa ini indentasi hilang atau baris meluap.
        const lead = current.trim() === "" ? current : ""
        // Teks yang sudah terkumpul (bila ada) ditutup dulu; hanya indentasi
        // murni yang ikut menempel ke potongan pertama.
        if (current.trim() !== "") out.push(current.trimEnd())
        current = ""
        const avail = Math.max(1, width - displayWidth(lead))
        const pieces = chunkByWidth(word, avail)
        if (lead && pieces.length > 0) {
          out.push(lead + (pieces[0] ?? ""))
          for (let i = 1; i < pieces.length - 1; i++) out.push(pieces[i]!)
          current = pieces[pieces.length - 1] ?? ""
          if (pieces.length === 1) current = ""
        } else {
          for (let i = 0; i < pieces.length - 1; i++) out.push(pieces[i]!)
          current = pieces[pieces.length - 1] ?? ""
        }
        continue
      }
      // `current` sudah memuat run whitespace aslinya; tambah satu spasi
      // hanya bila tidak ada pemisah di antara dua kata.
      const glued = !current || /\s$/.test(current) ? `${current}${word}` : `${current} ${word}`
      if (displayWidth(glued) > width && current.trim() !== "") {
        out.push(current.trimEnd())
        current = word
      } else if (displayWidth(glued) > width) {
        // Indentasi + kata tak muat bersama: indentasi dilepas untuk baris ini
        // (baris tetap <= width; lebih baik daripada meluap/memecah kata).
        current = word
      } else {
        current = glued
      }
    }
    flush()
  }
  return out.join("\n")
}

// Justify satu baris: distribusi spasi ekstra supaya ujung kiri & kanan rata.
// Baris kosong / <2 kata / baris yang sudah penuh dibiarkan.
export function justifyLine(line: string, width: number): string {
  const clean = displayWidth(line)
  if (clean >= width || width <= 0) return line
  const words = line.split(" ")
  if (words.length < 2) return line
  const gaps = words.length - 1
  const extra = width - clean
  const perGap = Math.floor(extra / gaps)
  const extraGap = extra % gaps
  return words
    .map((w, i) => {
      if (i >= gaps) return w
      const spaces = 1 + perGap + (i < extraGap ? 1 : 0)
      return w + " ".repeat(spaces)
    })
    .join("")
}

// Wrap + justify: untuk output streaming per paragraf.
//
// Baris TERAKHIR paragraf tidak dijustify — menjustifikasinya menghasilkan
// "sungai" spasi seperti `dengan      lebar      tertentu`, kesalahan tipografi
// klasik. Justify kini OPT-IN (default OFF, temuan K.2): menjustifikasi
// menyuntik spasi yang mengubah teks asli model saat di-copy/–pipe, dan membuat
// output linear berbeda dari TUI (ragged). `MINICODE_JUSTIFY=1` mengaktifkan.
export function formatWrapped(text: string, width: number, justify = false): string {
  const wrapped = wordWrap(text, width)
  if (!(justify || process.env.MINICODE_JUSTIFY === "1")) return wrapped
  const lines = wrapped.split("\n")
  return lines
    .map((line, i) => {
      const plain = stripAnsi(line)
      if (/^\s*(```|#|[-*] |>\s)/.test(plain) || /^\s*$/.test(plain)) return line
      // Baris dengan spasi ganda (tabel ASCII/art) jangan dijustify —
      // justifyLine akan meratakan ulang run spasi yang disengaja.
      if (plain.includes("  ")) return line
      // Baris terakhir, atau baris tepat sebelum baris kosong (= akhir paragraf).
      const isParagraphEnd = i === lines.length - 1 || /^\s*$/.test(lines[i + 1] ?? "")
      if (isParagraphEnd) return line
      return justifyLine(line, width)
    })
    .join("\n")
}
