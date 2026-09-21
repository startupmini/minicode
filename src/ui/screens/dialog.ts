// Bingkai dialog modal: backdrop + kotak terpusat (border, judul, bayangan).
//
// View membangun KONTEN (state + tombol, seperti sekarang); dialog.ts hanya
// menata konten menjadi frame SELAYAR (`rows` baris tepat) untuk `screen.paint`.
// Teks disanitasi satu-baris + potong per kolom di sini (defense-in-depth di
// atas sanitasi view — idempoten, murah). Fallback ASCII bila MINICODE_ASCII=1.

import { t } from "../i18n/locale.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, supportsUtf8 } from "../render/theme.ts"
import { displayWidth, padToWidth, truncateToWidth } from "../render/width.ts"

export interface DialogSpec {
  /** Judul baris atas. String kosong = tanpa baris judul (chrome menyesuaikan). */
  title: string
  /** Baris konten polos (sudah di-clamp view; di sini dipotong defensif). */
  body: string[]
  /** Baris hint bawah (tombol). Kosong = tanpa footer. */
  footer?: string
  /** Lebar kotak maksimum (inklusif border+padding). Default: selebar layar. */
  maxWidth?: number
  /**
   * Lebar kotak MINIMUM (inklusif border+padding): kotak tak pernah lebih
   * sempit dari ini walau konten pendek — geometri stabil, tak melompat
   * mengikuti data (keputusan rasa: presisi). Samakan dengan maxWidth untuk
   * lebar TETAP.
   */
  minWidth?: number
  /** Tinggi kotak maksimum (inklusif border). Default: setinggi layar. */
  maxHeight?: number
}

interface BoxChars {
  tl: string
  tr: string
  bl: string
  br: string
  h: string
  v: string
}

function boxChars(): BoxChars {
  // supportsUtf8() dibaca TIAP paint (getter runtime, bukan cache module) —
  // aturan yang sama dengan c/glyphs (theme.ts).
  // Tanpa bayangan: kolom `▓` redup terlihat seperti strip berpasir di
  // Windows Terminal (keluhan visual nyata) — kedalaman diganti backdrop
  // redup + kotak terpusat saja.
  if (!supportsUtf8()) return { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" }
  return { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }
}

/** Kotak popup tanpa backdrop: untuk paintRegion di atas konten pemilik layar. */
export interface DialogBox {
  /** Baris kotak (sudah center-horizontal, satu-baris-tersanitasi). */
  lines: string[]
  /** Baris layar 1-based tempat baris pertama ditulis. */
  topRow: number
  height: number
  /**
   * Indeks 0-based dalam `lines` tempat body[0] berada (= 1 border +
   * 1 judul bila ada). View WAJIB memakai ini untuk parkir kursor —
   * menebak offset manual meleset 1-2 baris begitu judul ditambah/dihapus
   * (bug nyata di 4 view).
   */
  bodyTop: number
}

/**
 * Padding kiri (spasi) baris box — box.lines sudah ter-center saat dibangun.
 * Kolom absolut = leftPad + offset-dalam-konten + 1. JANGAN hitung ulang
 * center dari displayWidth (lupa padding = off-by-N, bug nyata).
 */
export function boxLeftPad(strippedLine: string): number {
  const m = /^ */.exec(strippedLine)
  return m ? m[0].length : 0
}

/**
 * Bangun KOTAK saja (tanpa backdrop): dipakai popup komposit App TUI lewat
 * paintRegion — transkrip di belakang tetap tampil. Lebar mengikuti konten
 * (clamp maxWidth); tinggi mengikuti body (clamp maxHeight).
 */
export function dialogBox(spec: DialogSpec, cols: number, rows: number): DialogBox {
  const c0 = Math.max(20, Math.floor(cols) || 80)
  const r0 = Math.max(5, Math.floor(rows) || 24)
  const box = boxChars()
  const title = sanitizeAnsiLine(spec.title)
  const footer = spec.footer != null && spec.footer !== "" ? sanitizeAnsiLine(spec.footer) : null

  // Lebar dalam = konten terlebar, clamp ke layar. Chrome total per baris:
  // v(1) + sp(1) + innerW + sp(1) + v(1) = innerW + 4. View membangun baris
  // selebar itu (width() modal-aware) sehingga tak ada potong ulang di sini.
  // maxWidth opsional mengecilkan kotak (dialog mungil) — kurangi SEBELUM
  // hitung isi. Judul kosong = tanpa baris judul (chrome vertikal menyesuaikan).
  const hasTitle = title !== ""
  let innerMax = c0 - 2 - 4
  if (spec.maxWidth != null && Number.isFinite(spec.maxWidth))
    innerMax = Math.min(innerMax, Math.max(8, Math.floor(spec.maxWidth) - 4))
  if (innerMax < 8) innerMax = 8
  let innerMin = 8
  if (spec.minWidth != null && Number.isFinite(spec.minWidth))
    innerMin = Math.min(innerMax, Math.max(8, Math.floor(spec.minWidth) - 4))
  let contentW = displayWidth(title)
  for (const ln of spec.body) {
    const w = displayWidth(sanitizeAnsiLine(ln))
    if (w > contentW) contentW = w
  }
  if (footer != null) {
    const w = displayWidth(footer)
    if (w > contentW) contentW = w
  }
  const innerW = Math.min(Math.max(innerMin, contentW), innerMax)
  const cut = (s: string) => truncateToWidth(sanitizeAnsiLine(s), innerW)
  // +2 border, +2 padding: "│ text │".
  const boxW = innerW + 4
  const row = (left: string, mid: string, right: string) => left + mid + right

  const bar = box.h.repeat(Math.max(0, boxW - 2))
  const boxed: string[] = []
  boxed.push(row(box.tl, bar, box.tr))
  // Judul aksen (paritas visual dengan overlay inline); footer redup.
  // Judul kosong = baris judul dilewati seluruhnya (bukan baris kosong).
  if (hasTitle) boxed.push(`${box.v} ${padToWidth(c.accent(c.bold(cut(title))), innerW)} ${box.v}`)
  // Isi: chrome tetap = 2 border + (judul ? 1 : 0) + (footer ? 1 : 0); baris
  // marker ("… N more") ikut dihitung BILA terpotong. maxHeight opsional
  // membatasi tinggi KOTAK (bukan frame — padding backdrop menyerap sisa).
  const chromeFixed = 2 + (hasTitle ? 1 : 0) + (footer != null ? 1 : 0)
  const boxBudget =
    spec.maxHeight != null && Number.isFinite(spec.maxHeight)
      ? Math.min(r0, Math.max(5, Math.floor(spec.maxHeight)))
      : r0
  const room = Math.max(0, boxBudget - chromeFixed)
  const clipped = spec.body.length > room
  const shown = clipped ? Math.max(0, room - 1) : spec.body.length
  const body = spec.body.slice(0, shown)
  for (const ln of body) boxed.push(`${box.v} ${padToWidth(cut(ln), innerW)} ${box.v}`)
  if (clipped)
    boxed.push(
      `${box.v} ${padToWidth(cut(t("dlg.more", { n: spec.body.length - shown })), innerW)} ${box.v}`,
    )
  if (footer != null) boxed.push(`${box.v} ${padToWidth(c.dim(cut(footer)), innerW)} ${box.v}`)
  boxed.push(row(box.bl, bar, box.br))

  // Pusatkan horizontal; vertikal via topRow (1-based) untuk paintRegion.
  // displayWidth mengabaikan SGR (nol kolom) sehingga ANSI tak merusak hitungan.
  const topRow = Math.max(1, Math.floor((r0 - boxed.length) / 2) + 1)
  const lines = boxed.map((ln) => {
    const left = Math.max(0, Math.floor((c0 - displayWidth(ln)) / 2))
    return `${" ".repeat(left)}${ln}`
  })
  return { lines, topRow, height: boxed.length, bodyTop: 1 + (hasTitle ? 1 : 0) }
}

/**
 * Bangun frame SELAYAR: tepat `rows` string (backdrop redup + kotak terpusat).
 * Tak pernah melempar; tak menulis IO (view yang paint via screen).
 * Dipakai layar yang memiliki buffer sendiri (wizard first-run); popup di
 * atas konten App memakai dialogBox + paintRegion (tanpa clear).
 */
export function dialogFrame(spec: DialogSpec, cols: number, rows: number): string[] {
  const c0 = Math.max(20, Math.floor(cols) || 80)
  const r0 = Math.max(5, Math.floor(rows) || 24)
  const box = dialogBox(spec, c0, r0)
  // Backdrop REDUP (bukan hitam polos): pola ░ faint memenuhi layar sehingga
  // kotak terbaca sebagai jendela di depan, bukan screen baru. Fallback ASCII
  // "." bila glyph shade tak didukung.
  const shade = supportsUtf8() ? "░".repeat(c0) : ".".repeat(c0)
  const dim = c.faint(shade)
  const out: string[] = []
  for (let i = 1; i < box.topRow; i++) out.push(dim)
  for (const ln of box.lines) out.push(ln)
  while (out.length < r0) out.push(dim)
  return out.slice(0, r0)
}
