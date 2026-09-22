// Modal popup TUI: view MURNI (state → baris kotak, tanpa IO).
//
// Menggantikan overlay manager lama (screens/picker.ts dkk.) yang melukis
// stdout mentah + membaca stdin mentah: di dalam suspend TUI, frame mereka
// tertangkap lalu disuntik ke dokumen sebagai sampah kontrol (layar beku +
// grid rusak). Modal ini me-return string; yang melukis HANYA screen via
// present({modal}) — komposit terpusat, clamp terminal mungil, dirty-check
// tetap berlaku (kontrak I17).
//
// Batas lapisan (dijaga test/ui-boundary): hanya `src/ui/*` + node builtin.
// Label dari jaringan/config (nama model/provider) WAJIB sudah disanitasi
// controller — di sini disanitasi ulang (idempoten, murah) sebagai jaring
// kedua agar pemanggil baru tak bisa lupa.

import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, ESC } from "../render/theme.ts"
import { displayWidth, padToWidth, truncateToWidth } from "../render/width.ts"

/** Isi modal dari controller (cli/): indeks konten, BUKAN koordinat layar. */
export interface TuiModalContent {
  /** Judul di border atas. */
  title: string
  /** Baris konten mentah (teks polos; disanitasi ulang di sini). */
  rows: string[]
  /** Indeks terpilih dalam rows (di-clamp). */
  selected: number
  /** Baris filter live opsional (di bawah konten): nilai + posisi kursor. */
  filter?: { value: string; cursorCol: number }
  /** Baris hint bawah opsional (mis. "↑↓ pilih · Enter ✓ · Esc batal"). */
  footer?: string
  /** Teks bila rows kosong. */
  emptyText?: string
  /** Kursor: indeks ke `rows` (atau `rows.length` = baris filter bila
   * aktif); kolom = offset display dalam teks polos baris itu (untuk
   * filter: dalam nilai filter). */
  cursor: { row: number; col: number }
}

/** Hasil render siap komposit: baris berbingkai, lebar display seragam. */
export interface TuiModalBox {
  rows: string[]
  /** Lebar display (semua baris, SGR 0 kolom). */
  width: number
  height: number
  /** Indeks konten pertama yang terlihat (windowing). */
  offset: number
  /** Jumlah baris konten yang terlihat. */
  visibleCount: number
  /** true bila baris filter ikut dirender. */
  hasFilter: boolean
  /** Kursor absolut-dalam-box (termasuk border; screen tinggal +top/+left).
   * Dihitung di sini — satu-satunya sumber geometri kursor. */
  cursorRow: number
  cursorCol: number
}

/** Indent marker baris konten (`› ` terpilih / dua spasi biasa). */
export const MODAL_ROW_INDENT = 2
/** Label baris filter (termasuk spasi akhir). */
export const MODAL_FILTER_LABEL = "Filter: "

const TOP_LEFT = "┌"
const TOP_RIGHT = "┐"
const BOTTOM_LEFT = "└"
const BOTTOM_RIGHT = "┘"
const HORIZONTAL = "─"
const VERTICAL = "│"

/** Render kotak dari state. Murni: tanpa IO, tanpa baca terminal. */
export function renderModalBox(
  spec: TuiModalContent,
  maxCols: number,
  maxRows: number,
): TuiModalBox {
  const cols = Math.max(10, Math.floor(maxCols) || 80)
  const rows_ = Math.max(6, Math.floor(maxRows) || 24)
  const title = sanitizeAnsiLine(spec.title)
  const footer = spec.footer != null ? sanitizeAnsiLine(spec.footer) : null
  const plainRows = spec.rows.map((r) => sanitizeAnsiLine(r))

  // Lebar teks: judul, baris terpanjang, footer, filter — lalu bingkai.
  let textW = displayWidth(title)
  for (const r of plainRows) textW = Math.max(textW, displayWidth(r))
  if (footer != null) textW = Math.max(textW, displayWidth(footer))
  if (spec.filter != null) {
    textW = Math.max(textW, displayWidth(MODAL_FILTER_LABEL + spec.filter.value))
  }
  if (plainRows.length === 0 && spec.emptyText != null) {
    textW = Math.max(textW, displayWidth(sanitizeAnsiLine(spec.emptyText)))
  }
  // Ruang konten + indent marker + padding kanan 1.
  textW = Math.max(4, textW + MODAL_ROW_INDENT + 1)
  const width = Math.min(cols - 2 < 8 ? cols : cols - 2, textW + 2)
  const innerW = Math.max(1, width - 2)

  // Tinggi: border atas + konten + filter? + footer? + border bawah,
  // dijepit ke viewport (minimal 1 baris konten).
  const chromeRows = 2 + (spec.filter != null ? 1 : 0) + (footer != null ? 1 : 0)
  const maxContent = Math.max(1, Math.min(plainRows.length, rows_ - 1 - chromeRows))
  const sel =
    plainRows.length === 0 ? -1 : Math.max(0, Math.min(spec.selected, plainRows.length - 1))
  // Windowing: jendela mengikuti seleksi (awal/akhir dijepit).
  let offset = 0
  if (sel >= 0 && plainRows.length > maxContent) {
    offset = Math.min(sel, plainRows.length - maxContent)
    offset = Math.max(0, Math.min(offset, sel - Math.floor(maxContent / 2)))
    // Aturan sederhana yang stabil: jendela sedekat mungkin dengan awal
    // selama seleksi terlihat — geser hanya bila seleksi keluar.
    if (sel < offset) offset = sel
    if (sel >= offset + maxContent) offset = sel - maxContent + 1
  }
  const visible = plainRows.slice(offset, offset + maxContent)
  const hasFilter = spec.filter != null
  // Bingkai: │ + " " + isi(innerW-1) + │ = tepat width. innerW = width-2.
  // Isi teks dibatasi innerW-1 agar padding kanan selalu ada (kursor tak
  // pernah parkir di border).
  const frame = (inner: string): string => `${VERTICAL} ${padToWidth(inner, innerW - 1)}${VERTICAL}`
  const out: string[] = (() => {
    const titleInner = truncateToWidth(`─ ${title} `, innerW)
    const pad = HORIZONTAL.repeat(Math.max(0, innerW - displayWidth(titleInner)))
    return [TOP_LEFT + titleInner + pad + TOP_RIGHT]
  })()
  visible.forEach((text, i) => {
    const globalIdx = offset + i
    const body =
      globalIdx === sel
        ? c.accent(c.bold(`› ${truncateToWidth(text, Math.max(0, innerW - 1 - MODAL_ROW_INDENT))}`))
        : `  ${truncateToWidth(text, Math.max(0, innerW - 1 - MODAL_ROW_INDENT))}`
    out.push(frame(body))
  })
  if (plainRows.length === 0) {
    const t =
      spec.emptyText != null ? truncateToWidth(sanitizeAnsiLine(spec.emptyText), innerW - 1) : ""
    out.push(frame(c.dim(t)))
  }
  if (plainRows.length > maxContent) {
    const hiddenAbove = offset
    const hiddenBelow = plainRows.length - offset - visible.length
    const more: string[] = []
    if (hiddenAbove > 0) more.push(`↑${hiddenAbove}`)
    if (hiddenBelow > 0) more.push(`↓${hiddenBelow}`)
    out.push(frame(c.dim(`… ${more.join(" ")}`)))
  }
  if (hasFilter) {
    const ftext = truncateToWidth(`${MODAL_FILTER_LABEL}${spec.filter!.value}`, innerW - 1)
    out.push(frame(c.accent(ftext)))
  }
  if (footer != null) {
    out.push(frame(c.dim(truncateToWidth(footer, innerW - 1))))
  }
  out.push(BOTTOM_LEFT + HORIZONTAL.repeat(Math.max(0, innerW)) + BOTTOM_RIGHT)

  // Kursor konten-relatif → absolut-dalam-box. Baris konten: 1 (border
  // judul) + posisi terlihat (offset windowing, dijepit); baris filter:
  // setelah konten + baris "… more" bila ada; kolom = dalam teks polos
  // baris itu + indent marker/label. Semua dijepit ke dalam box.
  const moreRows = plainRows.length > maxContent ? 1 : 0
  let cursorRow = 0
  let cursorCol = 1
  if (hasFilter && spec.cursor.row >= plainRows.length) {
    cursorRow = 1 + visible.length + moreRows
    const maxCol = Math.max(0, innerW - 1 - MODAL_FILTER_LABEL.length)
    cursorCol = 2 + MODAL_FILTER_LABEL.length + Math.max(0, Math.min(spec.cursor.col, maxCol))
  } else if (visible.length > 0) {
    const vis = Math.max(0, Math.min(spec.cursor.row - offset, visible.length - 1))
    const maxCol = Math.max(0, innerW - 1 - MODAL_ROW_INDENT)
    cursorRow = 1 + vis
    cursorCol = 2 + MODAL_ROW_INDENT + Math.max(0, Math.min(spec.cursor.col, maxCol))
  }
  cursorCol = Math.max(0, Math.min(cursorCol, width - 2))

  return {
    rows: out,
    width,
    height: out.length,
    offset,
    visibleCount: visible.length,
    hasFilter,
    cursorRow,
    cursorCol,
  }
}

/** Potong baris dasar pada kolom [col0, col0+boxW) lalu sisipkan overlay.
 * Wide-char yang terbelah batas diganti spasi (kolom tetap selaras);
 * SGR diwariskan apa adanya (nol kolom). */
export function stampLine(base: string, col0: number, overlay: string, boxW: number): string {
  let prefix = ""
  let pw = 0
  let i = 0
  // Prefix: kolom [0, col0).
  while (i < base.length && pw < col0) {
    if (base[i] === "\x1b") {
      const m = base.slice(i).match(new RegExp(`^${ESC}\\[[0-9;:]*m`))
      if (m) {
        prefix += m[0]
        i += m[0].length
        continue
      }
      i += 1
      continue
    }
    const cp = base.codePointAt(i)!
    const cw = displayWidth(base.slice(i, i + (cp > 0xffff ? 2 : 1)))
    if (pw + cw > col0) {
      // Wide-char menabrak batas: ganti spasi agar kolom selaras.
      prefix += " "
      pw += 1
      i += cp > 0xffff ? 2 : 1
      continue
    }
    prefix += base.slice(i, i + (cp > 0xffff ? 2 : 1))
    pw += cw
    i += cp > 0xffff ? 2 : 1
  }
  while (pw < col0) {
    prefix += " "
    pw += 1
  }
  // Suffix: lewati kolom [col0, col0+boxW).
  let sw = 0
  while (i < base.length && sw < boxW) {
    if (base[i] === "\x1b") {
      const m = base.slice(i).match(new RegExp(`^${ESC}\\[[0-9;:]*m`))
      if (m) {
        i += m[0].length
        continue
      }
      i += 1
      continue
    }
    const cp = base.codePointAt(i)!
    const cw = displayWidth(base.slice(i, i + (cp > 0xffff ? 2 : 1)))
    sw += cw
    i += cp > 0xffff ? 2 : 1
  }
  return prefix + overlay + base.slice(i)
}

/** Komposit box terpusat di atas frame (tak mengubah input). Murni. */
export function compositeModal(
  frame: string[],
  rows: number,
  cols: number,
  box: TuiModalBox,
): string[] {
  const out = frame.slice()
  const top = Math.max(0, Math.floor((rows - box.height) / 2))
  const left = Math.max(0, Math.floor((cols - box.width) / 2))
  for (let k = 0; k < box.rows.length && top + k < rows; k++) {
    out[top + k] = stampLine(out[top + k] ?? "", left, box.rows[k]!, box.width)
  }
  return out
}
