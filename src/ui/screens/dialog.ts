// Kotak dialog: border, judul, footer, terpusat. View membangun KONTEN; di
// sini konten ditata jadi baris kotak (paintRegion melukis region-nya saja).
// Teks disanitasi + dipotong per kolom (defense-in-depth, idempoten). ASCII
// bila MINICODE_ASCII=1.

import { t } from "../i18n/locale.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, supportsUtf8 } from "../render/theme.ts"
import { displayWidth, padToWidth, truncateToWidth } from "../render/width.ts"

export interface DialogSpec {
  /** Judul baris atas. String kosong = tanpa baris judul (chrome menyesuaikan). */
  title: string
  /** Baris konten polos. */
  body: string[]
  /** Baris hint bawah (tombol). Kosong = tanpa footer. */
  footer?: string
  /** Lebar maksimum (inklusif border+padding). Default: popup terhitung. */
  maxWidth?: number
  /** Lebar MINIMUM (inklusif border+padding). Default: skala dari `cols`. */
  minWidth?: number
  /** Tinggi maksimum (inklusif border). Default: setinggi layar. */
  maxHeight?: number
  /** Indeks body yang WAJIB terlihat; jendela digeser agar tak mengetik buta (HIGH-2). */
  focusRow?: number
}

interface BoxChars {
  tl: string
  tr: string
  bl: string
  br: string
  h: string
  v: string
}

/** Lebar kotak popup: skala dari layar; pemanggil membekukan saat mount. */
export function popupBoxWidth(cols: number): number {
  const safeCols = Math.max(10, cols)
  const scaled = Math.floor(safeCols * 0.6)
  // Margin 4 kolom menang atas lantai 40 (AUD-011: `max(40,…)` dulu
  // membungkus clamp sehingga terminal sempit overflow).
  const room = safeCols - 4
  return Math.min(Math.max(40, Math.min(88, scaled)), room)
}

function boxChars(): BoxChars {
  // Kapabilitas dan kill-switch dibaca tiap render agar perubahan env runtime
  // (terutama test/aksesibilitas) langsung berlaku, bukan membeku saat import.
  const style = process.env.MINICODE_BOX?.toLowerCase()
  if (process.env.MINICODE_ASCII === "1" || style === "ascii" || !supportsUtf8())
    return { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" }
  if (style === "square") return { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }
  return { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
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
  /**
   * Indeks body pertama yang benar-benar dirender (0 kecuali body digeser
   * karena `focusRow`). Kursor = `bodyTop + (activeRow - bodyStart)`.
   */
  bodyStart: number
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

/** Bangun KOTAK saja (tanpa backdrop); minWidth==maxWidth = lebar beku. */
export function dialogBox(spec: DialogSpec, cols: number, rows: number): DialogBox {
  const c0 = Math.max(20, Math.floor(cols) || 80)
  const r0 = Math.max(5, Math.floor(rows) || 24)
  const box = boxChars()
  const title = sanitizeAnsiLine(spec.title)
  const footer = spec.footer != null && spec.footer !== "" ? sanitizeAnsiLine(spec.footer) : null

  const hasTitle = title !== ""
  const maxInner = Math.max(10, c0 - 6)
  const def = Math.max(10, popupBoxWidth(c0) - 4)
  const capInner = Math.min(
    spec.maxWidth != null && Number.isFinite(spec.maxWidth)
      ? Math.max(10, Math.floor(spec.maxWidth) - 4)
      : def,
    maxInner,
  )
  const floorInner = Math.min(
    spec.minWidth != null && Number.isFinite(spec.minWidth)
      ? Math.max(10, Math.floor(spec.minWidth) - 4)
      : def,
    capInner,
  )

  let contentW = displayWidth(title)
  for (const ln of spec.body) {
    const w = displayWidth(sanitizeAnsiLine(ln))
    if (w > contentW) contentW = w
  }
  if (footer != null) {
    const w = displayWidth(footer)
    if (w > contentW) contentW = w
  }
  const innerW = Math.max(10, Math.min(Math.max(contentW, floorInner), capInner, maxInner))
  const cut = (s: string) => truncateToWidth(sanitizeAnsiLine(s), innerW)
  const boxW = innerW + 4
  const row = (l: string, m: string, r: string) => l + m + r

  const bar = box.h.repeat(Math.max(0, boxW - 2))
  const boxed: string[] = []
  boxed.push(row(box.tl, bar, box.tr))
  if (hasTitle) boxed.push(`${box.v} ${padToWidth(c.accent(c.bold(cut(title))), innerW)} ${box.v}`)

  const chromeFixed = 2 + (hasTitle ? 1 : 0) + (footer != null ? 1 : 0)
  const boxBudget =
    spec.maxHeight != null && Number.isFinite(spec.maxHeight)
      ? Math.min(r0, Math.max(5, Math.floor(spec.maxHeight)))
      : r0
  const room = Math.max(0, boxBudget - chromeFixed)
  const clipped = spec.body.length > room
  const shown = clipped ? Math.max(0, room - 1) : spec.body.length
  const focus = spec.focusRow
  const bodyStart =
    clipped && focus != null && shown > 0 && Number.isFinite(focus)
      ? Math.max(0, Math.min(Math.floor(focus) - shown + 1, spec.body.length - shown))
      : 0
  const body = spec.body.slice(bodyStart, bodyStart + shown)
  for (const ln of body) boxed.push(`${box.v} ${padToWidth(cut(ln), innerW)} ${box.v}`)
  if (clipped)
    boxed.push(
      `${box.v} ${padToWidth(cut(t("dlg.more", { n: spec.body.length - shown })), innerW)} ${box.v}`,
    )
  if (footer != null) boxed.push(`${box.v} ${padToWidth(c.dim(cut(footer)), innerW)} ${box.v}`)
  boxed.push(row(box.bl, bar, box.br))

  const topRow = Math.max(1, Math.floor((r0 - boxed.length) / 2) + 1)
  const lines = boxed.map((ln) => {
    const left = Math.max(0, Math.floor((c0 - displayWidth(ln)) / 2))
    return `${" ".repeat(left)}${ln}`
  })
  return { lines, topRow, height: boxed.length, bodyTop: 1 + (hasTitle ? 1 : 0), bodyStart }
}
