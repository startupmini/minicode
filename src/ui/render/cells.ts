// Framebuffer sel untuk penulisan terminal inkremental.
//
// Kenapa ada: diff per BARIS (CUP+EL lalu tulis ulang seluruh baris) masih
// membayar O(panjang baris) untuk setiap perubahan kecil. Mengetik satu huruf
// di prompt 1.000 karakter berarti menulis ulang ±1.000 karakter ke ConPTY.
// Modul ini memecah baris menjadi SEL (grapheme + gaya SGR) lalu menghasilkan
// hanya rentang kolom yang benar-benar berubah — mekanisme yang sama dengan
// framebuffer/diff-cell OpenTUI, tetapi murni TypeScript tanpa dependency.
//
// Kontrak penting:
// - Frame LOGIS tetap penuh (pemilik layar mengirim `rows` baris utuh); modul
//   ini hanya memutuskan byte FISIK apa yang ditulis.
// - Glyph lebar (CJK/emoji) menempati beberapa kolom: sel pertama membawa
//   glyph, kolom lanjutan ditandai `cont` agar diff tidak memotong glyph.
// - Gaya disimpan sebagai STATE SGR, bukan riwayat sekuens mentah: terminal
//   memperlakukan SGR sebagai himpunan atribut aktif, jadi `\x1b[39m` harus
//   membatalkan warna foreground sebelumnya — bukan menumpuk sebagai teks.
//   Tanpa normalisasi ini setiap sel sesudah reset membawa string yang terus
//   memanjang, diff menganggap sel identik "berubah", dan footer ditulis ulang
//   tiap detik.
import { escapeLength, graphemeWidth, segmentGraphemes } from "./width.ts"

/** Satu kolom layar. `cont` = kolom lanjutan glyph lebar (tanpa glyph sendiri). */
export interface Cell {
  glyph: string
  /** Sekuens SGR aktif ("" = atribut default). */
  style: string
  cont?: boolean
}

const BLANK: Cell = { glyph: " ", style: "" }

/** SGR saja (`ESC[...m` dengan parameter angka/`;`/`:`) — sisanya diabaikan. */
function isSgr(seq: string): boolean {
  if (!seq.startsWith("\x1b[") || !seq.endsWith("m")) return false
  for (let i = 2; i < seq.length - 1; i++) {
    const ch = seq[i]!
    if (!((ch >= "0" && ch <= "9") || ch === ";" || ch === ":")) return false
  }
  return true
}

/** Urutan serialisasi kanonik — hasil sama apa pun urutan SGR masukannya.
 * Termasuk atribut yang jarang dipakai: 21 double-underline (u2), 53
 * overline (ov), 58 underline-color (uc) — sebelumnya jatuh ke `raw:*` dan
 * hilang saat serialisasi (audit render #1). */
const SGR_ORDER: readonly string[] = [
  "bold",
  "dim",
  "italic",
  "underline",
  "u2",
  "ov",
  "blink",
  "inverse",
  "conceal",
  "strike",
  "fg",
  "bg",
  "uc",
]

interface SgrState {
  values: Map<string, string>
}

function setGroup(state: SgrState, group: string, value: string | null): void {
  if (value === null) state.values.delete(group)
  else state.values.set(group, value)
}

function serializeSgr(state: SgrState): string {
  if (state.values.size === 0) return ""
  const parts: string[] = []
  for (const group of SGR_ORDER) {
    const value = state.values.get(group)
    if (value !== undefined) parts.push(value)
  }
  // Parameter tak dikenal (`raw:<token>`: 21, 53, 58, dst.) ikut
  // diserialisasi — jangan dibuang (audit render #1). Urutan stabil
  // (insertion order Map) supaya serialize idempoten.
  for (const [group, value] of state.values) {
    if (!SGR_ORDER.includes(group)) parts.push(value)
  }
  return `\x1b[${parts.join(";")}m`
}

/** Parameter warna lanjutan (`38;5;n` / `38;2;r;g;b`), atau null bila tak lengkap. */
function readExtended(
  tokens: string[],
  i: number,
  code: number,
): { value: string; next: number } | null {
  const mode = tokens[i + 1]
  if (mode === "5") {
    const slot = tokens[i + 2]
    if (slot === undefined) return null
    return { value: `${code};5;${slot}`, next: i + 2 }
  }
  if (mode === "2") {
    const r = tokens[i + 2]
    const g = tokens[i + 3]
    const b = tokens[i + 4]
    if (r === undefined || g === undefined || b === undefined) return null
    return { value: `${code};2;${r};${g};${b}`, next: i + 4 }
  }
  return null
}

/**
 * Terapkan satu sekuens SGR ke state. Reset penuh (kosong/0) membuang semua.
 * Parameter tak dikenal disimpan apa adanya (grup `raw:<token>`) supaya tidak
 * hilang dan tetap idempoten di paint ulang.
 */
function applySgrTo(state: SgrState, seq: string): void {
  const body = seq.slice(2, -1)
  const tokens = body === "" ? ["0"] : body.split(";")
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    // Bentuk titik-dua (mis. `38:5:196`) dibiarkan utuh — satu nilai warna.
    const colon = token.indexOf(":")
    if (colon >= 0) {
      const head = token.slice(0, colon)
      if (head === "38") setGroup(state, "fg", token)
      else if (head === "48") setGroup(state, "bg", token)
      else if (head === "58") setGroup(state, "uc", token)
      else setGroup(state, `raw:${head}`, token)
      continue
    }
    const n = token === "" ? 0 : Number(token)
    if (Number.isNaN(n)) {
      setGroup(state, `raw:${token}`, token)
      continue
    }
    if (n === 0) {
      state.values.clear()
      continue
    }
    if (n === 38 || n === 48 || n === 58) {
      const extended = readExtended(tokens, i, n)
      if (!extended) {
        setGroup(state, `raw:${n}`, token)
        continue
      }
      if (n === 58) setGroup(state, "uc", extended.value)
      else setGroup(state, n === 38 ? "fg" : "bg", extended.value)
      i = extended.next
      continue
    }
    switch (n) {
      case 1:
        setGroup(state, "bold", "1")
        break
      case 2:
        setGroup(state, "dim", "2")
        break
      case 22:
        setGroup(state, "bold", null)
        setGroup(state, "dim", null)
        break
      case 3:
        setGroup(state, "italic", "3")
        break
      case 23:
        setGroup(state, "italic", null)
        break
      case 4:
        setGroup(state, "underline", "4")
        break
      case 21:
        setGroup(state, "u2", "21")
        break
      case 24:
        setGroup(state, "underline", null)
        setGroup(state, "u2", null)
        break
      case 53:
        setGroup(state, "ov", "53")
        break
      case 54:
        setGroup(state, "ov", null)
        break
      case 59:
        setGroup(state, "uc", null)
        break
      case 5:
      case 6:
        setGroup(state, "blink", String(n))
        break
      case 25:
        setGroup(state, "blink", null)
        break
      case 7:
        setGroup(state, "inverse", "7")
        break
      case 27:
        setGroup(state, "inverse", null)
        break
      case 8:
        setGroup(state, "conceal", "8")
        break
      case 28:
        setGroup(state, "conceal", null)
        break
      case 9:
        setGroup(state, "strike", "9")
        break
      case 29:
        setGroup(state, "strike", null)
        break
      case 39:
        setGroup(state, "fg", null)
        break
      case 49:
        setGroup(state, "bg", null)
        break
      default:
        if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) setGroup(state, "fg", String(n))
        else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) setGroup(state, "bg", String(n))
        else setGroup(state, `raw:${n}`, String(n))
    }
  }
}

/**
 * Pecah satu baris frame menjadi sel kolom. Escape non-SGR diabaikan (frame
 * TUI hanya membawa SGR; sanitizer membuang kontrol lain). Tab diperlakukan
 * selebar 8 kolom — kebijakan yang sama dengan `charWidth`/`displayWidth`.
 */
export function parseCells(line: string): Cell[] {
  const cells: Cell[] = []
  const sgr: SgrState = { values: new Map() }
  let style = ""
  let i = 0
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const len = escapeLength(line, i)
      if (len > 0) {
        const seq = line.slice(i, i + len)
        if (isSgr(seq)) {
          applySgrTo(sgr, seq)
          style = serializeSgr(sgr)
        }
        i += len
        continue
      }
    }
    let end = line.indexOf("\x1b", i)
    if (end < 0) end = line.length
    if (end === i) end++
    const run = line.slice(i, end)
    for (const g of segmentGraphemes(run)) {
      // Baris frame tidak boleh memuat newline; kalau ada, itu artefak dan
      // bukan sel yang sah (menuliskannya akan menggeser baris berikut).
      if (g === "\n" || g === "\r" || g === "\x1b") continue
      const width = g === "\t" ? 8 : graphemeWidth(g)
      if (width <= 0) {
        // Grapheme nol-lebar menempel ke sel sebelumnya (mis. combining mark
        // yang lolos tanpa base). Tanpa base, simpan sebagai sel selebar 1
        // supaya posisi kolom berikutnya tidak meleset.
        const prev = cells[cells.length - 1]
        if (prev && !prev.cont) prev.glyph += g
        else cells.push({ glyph: g, style })
        continue
      }
      cells.push({ glyph: g === "\t" ? " ".repeat(8) : g, style })
      for (let k = 1; k < width; k++) cells.push({ glyph: "", style, cont: true })
    }
    i = end
  }
  return cells
}

/** Sel hilang = blank default; terminal memang sudah punya blank di sana. */
function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) {
    const only = a ?? b!
    return only.glyph === " " && only.style === "" && !only.cont
  }
  return a.glyph === b.glyph && a.style === b.style && Boolean(a.cont) === Boolean(b.cont)
}

/**
 * Tulis ulang EKOR baris `next` mulai kolom `start` (0-based, sudah selaras
 * glyph): CUP ke kolom itu, reset atribut, hapus sisa baris (EL `0K`), lalu
 * render sel dari `start` sampai akhir.
 *
 * Kenapa hapus-lalu-tulis, bukan menulis rentang terpisah per perubahan:
 * terminal (khususnya ConPTY Windows) memegang buffer sendiri. Byte yang tidak
 * kita tulis TIDAK hilang dari layar — sisa glyph lebar, ekor baris lama, atau
 * teks diagnostik asing (`[hooks] …` dari stderr) tetap menempel bila tidak
 * dihapus. Diff per-rentang tanpa EL pernah membiarkan sampah itu bertahan
 * (regresi PTY: baris emoji + prompt tertimpa fragmen asing). Menghapus dari
 * kolom perubahan pertama ke akhir baris menutup celah itu sekaligus tetap
 * melewati prefix yang identik — penghasilan byte fase-2 untuk prompt panjang.
 */
function emitTail(next: Cell[], start: number, row: number): string {
  // Reset SEBELUM EL: EL mewarisi atribut aktif (BCE), jadi tanpa reset area
  // terhapus bisa tetap berwarna.
  let out = `\x1b[${row};${start + 1}H\x1b[0m\x1b[0K`
  // Setelah reset, atribut awal = default ("").
  let active = ""
  for (let col = start; col < next.length; col++) {
    const cell = next[col]
    // Kolom lanjutan tidak ditulis: glyph lebar di sel sebelumnya sudah
    // memajukan kursor melewatinya.
    if (cell?.cont) continue
    const glyph = cell?.glyph ?? " "
    const style = cell?.style ?? ""
    if (style !== active) {
      // Reset dulu agar atribut dari run sebelumnya tidak bocor ke sel ini.
      out += style ? `\x1b[0m${style}` : "\x1b[0m"
      active = style
    }
    out += glyph
  }
  return out
}

/**
 * Hasilkan byte yang mengubah baris `prev` menjadi `next`.
 *
 * Prefix identik tidak ditulis (nol byte); dari kolom berbeda pertama sampai
 * akhir baris ditulis ulang setelah EL. `prev`/`next` adalah keluaran
 * `parseCells` untuk baris yang sama; pemanggil wajib menyimpan `prev` dari
 * paint sebelumnya.
 */
export function diffCellLine(prev: Cell[], next: Cell[], row: number): string {
  const max = Math.max(prev.length, next.length)
  let start = 0
  while (start < max && sameCell(prev[start], next[start])) start++
  if (start >= max) return ""
  // Jangan mulai di tengah glyph lebar: mundur ke sel pembawa glyph supaya EL
  // tidak membelah glyph (meninggalkan separuh sel kosong di kolom sebelumnya).
  while (start > 0 && (prev[start]?.cont || next[start]?.cont)) start--
  return emitTail(next, start, row)
}

/** True bila dua baris framebuffer identik secara tampilan (test/diagnostik). */
export function sameCells(a: Cell[], b: Cell[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!sameCell(a[i], b[i])) return false
  return true
}

export const EMPTY_CELLS: readonly Cell[] = [BLANK]
