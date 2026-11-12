import type { MarkdownTable, PipeTableAlignment } from "./markdown-table.ts"
import { cleanUntrusted, sanitizeAnsiLine } from "./sanitize.ts"
import { c, getTerminalWidth, supportsUtf8 } from "./theme.ts"
import {
  displayWidth,
  graphemeWidth,
  padToWidth,
  segmentGraphemes,
  truncateToWidth,
  wrapByWidth,
} from "./width.ts"

export interface GridColumn {
  header: string
  align?: PipeTableAlignment
  width?: number
}

export interface GridTable {
  headers: readonly string[]
  rows: readonly (readonly string[])[]
  aligns?: readonly PipeTableAlignment[]
  widths?: readonly (number | undefined)[]
}

export interface GridRenderOptions {
  width?: number
  ellipsis?: string
  maxCellWidth?: number
  minCellWidth?: number
  styleHeader?: boolean
  formatCell?: (value: string) => string
  /** Wrap isi sel ke baris berikutnya (untuk tabel markdown jawaban model)
   * alih-alih truncate dengan ellipsis — info panjang TIDAK hilang. */
  wrap?: boolean
  /** Render sebagai kotak ber-garis (opencode-like) dengan padding dalam sel. */
  box?: boolean
}

const DEFAULT_ELLIPSIS = "…"
const DEFAULT_MAX_CELL_WIDTH = 50
const MIN_CONTENT_WIDTH = 3
/** Margin kiri kotak tabel — biar tidak menempel ke tepi terminal. */
const BOX_MARGIN = 1

function cleanCell(value: unknown): string {
  return cleanUntrusted(
    sanitizeAnsiLine(value == null ? "" : String(value)),
    !!process.stdout.isTTY,
  )
    .replace(/[\t\v\f\u0085\u2028\u2029]/g, " ")
    .replace(/\r/g, " ")
}

function alignCell(value: string, width: number, align: PipeTableAlignment): string {
  if (align === "right") return padToWidth(value, width, "right")
  if (align === "center") {
    const diff = width - displayWidth(value)
    if (diff <= 0) return value
    const left = Math.floor(diff / 2)
    return `${" ".repeat(left)}${value}${" ".repeat(diff - left)}`
  }
  return padToWidth(value, width)
}

function verticalField(header: string, value: string, width: number, ellipsis: string): string {
  const safeHeader = cleanCell(header)
  const safeValue = cleanCell(value)
  const safeWidth = Math.max(1, width)
  const labelBudget = Math.max(1, safeWidth - 2)
  const label = truncateToWidth(safeHeader, labelBudget, ellipsis)
  const prefix = `${label}:`
  const valueBudget = safeWidth - displayWidth(prefix) - 1
  if (valueBudget <= 0) return truncateToWidth(prefix, safeWidth, ellipsis)
  const shown = truncateToWidth(safeValue, valueBudget, ellipsis)
  return truncateToWidth(`${prefix} ${shown}`, safeWidth, ellipsis)
}

function renderVertical(table: GridTable, width: number, ellipsis: string): string[] {
  const out: string[] = []
  for (const row of table.rows) {
    const fields: string[] = []
    for (let i = 0; i < table.headers.length; i++) {
      fields.push(verticalField(table.headers[i] ?? "", row[i] ?? "", width, ellipsis))
    }
    if (fields.length) out.push(fields.join("\n"))
  }
  if (out.length === 0) {
    for (const header of table.headers)
      out.push(truncateToWidth(cleanCell(header), Math.max(1, width), ellipsis))
  }
  return out
}

function requestedWidth(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.trunc(value))
}

function naturalWidths(table: GridTable, maxCellWidth: number): number[] {
  return table.headers.map((header, i) => {
    const requested = requestedWidth(table.widths?.[i])
    if (requested != null) return requested
    let max = displayWidth(cleanCell(header))
    for (const row of table.rows) max = Math.max(max, displayWidth(cleanCell(row[i])))
    return Math.min(max, maxCellWidth)
  })
}

/**
 * Minimum per kolom berdasarkan ATOMIC WIDTH isinya.
 *
 * Lebar kolom 1 memotong grapheme 2 kolom (CJK/emoji) sehingga baris data
 * menjadi lebih lebar dari border — terminal membungkusnya sendiri dan tinggi
 * frame meleset (audit 2026-11-12, MEDIUM-8). Kolom yang isinya memuat
 * grapheme 2 kolom minimal 2 (dibatasi lebar naturalnya).
 */
function atomicMinimums(table: GridTable, natural: readonly number[]): number[] {
  return table.headers.map((_, col) => {
    const naturalW = natural[col] ?? 1
    if (naturalW >= 2) return 1
    const cells = [table.headers[col] ?? "", ...table.rows.map((row) => row[col] ?? "")]
    for (const cell of cells) {
      for (const g of segmentGraphemes(cleanCell(cell))) {
        if (graphemeWidth(g) >= 2) return 2
      }
    }
    return 1
  })
}

function fitWidths(
  natural: readonly number[],
  budget: number,
  minimums: number[],
): number[] | null {
  const widths = natural.map((value, i) => Math.max(minimums[i]!, value))
  const naturalTotal = widths.reduce((sum, value) => sum + value, 0)
  if (naturalTotal <= budget) return widths
  const floor = minimums.reduce((sum, value) => sum + value, 0)
  const room = budget - floor
  if (room < 0) return null
  const extras = widths.map((value, i) => value - minimums[i]!)
  const extraTotal = extras.reduce((sum, value) => sum + value, 0)
  if (extraTotal <= 0) return null
  let assigned = 0
  for (let i = 0; i < widths.length; i++) {
    const share =
      i === widths.length - 1 ? room - assigned : Math.floor((extras[i]! * room) / extraTotal)
    const amount = Math.min(extras[i]!, Math.max(0, share))
    widths[i] = minimums[i]! + amount
    assigned += amount
  }
  return widths
}

/**
 * Render tabel sebagai kotak ber-garis (opencode-like) dengan padding 1 kolom
 * di dalam tiap sel — teks tidak menempel ke garis `│`. Isi sel di-wrap
 * (bukan truncate) agar info panjang tidak hilang; ANSI terjaga via
 * chunkByWidth. Fallback ASCII (`+`,`-`,`|`) saat MINICODE_ASCII/terminal non-UTF.
 */
function renderBorderedGrid(
  table: GridTable,
  widths: number[],
  aligns: readonly PipeTableAlignment[],
  styleHeader: boolean,
  options: GridRenderOptions,
): string {
  const g = supportsUtf8()
    ? {
        tl: "┌",
        tm: "┬",
        tr: "┐",
        ml: "├",
        mm: "┼",
        mr: "┤",
        bl: "└",
        bm: "┴",
        br: "┘",
        h: "─",
        v: "│",
      }
    : {
        tl: "+",
        tm: "+",
        tr: "+",
        ml: "+",
        mm: "+",
        mr: "+",
        bl: "+",
        bm: "+",
        br: "+",
        h: "-",
        v: "|",
      }
  // Guard terakhir: baris sel TIDAK BOLEH lebih lebar dari kolomnya. Dengan
  // minimum wide-aware ini seharusnya tak terjadi, tapi invariant geometri
  // (I1) terlalu mahal untuk ditebak — potong defensif tanpa ellipsis.
  const fitCellLine = (line: string, colWidth: number): string =>
    displayWidth(line) > colWidth ? truncateToWidth(line, colWidth, "") : line
  const cellLines = (value: unknown, col: number): string[] => {
    const colWidth = widths[col]!
    const align = aligns[col] ?? "left"
    const raw = cleanCell(value)
    const rendered = options.formatCell?.(raw) ?? raw
    return wrapByWidth(rendered, colWidth).map((l) =>
      alignCell(fitCellLine(l, colWidth), colWidth, align),
    )
  }
  const headerCols = table.headers.map((v, i) => {
    const rendered = options.formatCell?.(cleanCell(v)) ?? cleanCell(v)
    const styled = styleHeader ? c.bold(c.accent(rendered)) : rendered
    return wrapByWidth(styled, widths[i]!).map((l) =>
      alignCell(fitCellLine(l, widths[i]!), widths[i]!, aligns[i] ?? "left"),
    )
  })
  const rowLine = (cols: string[][], li: number): string =>
    c.dim(g.v) +
    cols.map((lines, i) => ` ${lines[li] ?? padToWidth("", widths[i]!)} `).join(c.dim(g.v)) +
    c.dim(g.v)
  const horiz = (l: string, m: string, r: string): string =>
    c.dim(l + widths.map((w) => g.h.repeat(w + 2)).join(m) + r)

  const out: string[] = [horiz(g.tl, g.tm, g.tr)]
  const headerHeight = headerCols.reduce((m, lines) => Math.max(m, lines.length), 1)
  for (let li = 0; li < headerHeight; li++) out.push(rowLine(headerCols, li))
  out.push(horiz(g.ml, g.mm, g.mr))
  for (const row of table.rows) {
    const cols = row.map((_, i) => cellLines(row[i] ?? "", i))
    const height = cols.reduce((m, lines) => Math.max(m, lines.length), 0)
    for (let li = 0; li < height; li++) out.push(rowLine(cols, li))
  }
  out.push(horiz(g.bl, g.bm, g.br))
  return out.map((line) => " ".repeat(BOX_MARGIN) + line).join("\n")
}

export function renderGridTable(table: GridTable, options: GridRenderOptions = {}): string {
  if (table.headers.length === 0) return ""
  if (table.rows.length === 0 && options.styleHeader === false) return ""
  const requestedTotalWidth = options.width ?? getTerminalWidth()
  const width = Number.isFinite(requestedTotalWidth)
    ? Math.max(1, Math.trunc(requestedTotalWidth))
    : getTerminalWidth()
  const ellipsis = options.ellipsis ?? DEFAULT_ELLIPSIS
  const requestedMaxCellWidth = options.maxCellWidth ?? DEFAULT_MAX_CELL_WIDTH
  const maxCellWidth = Number.isFinite(requestedMaxCellWidth)
    ? Math.max(1, Math.trunc(requestedMaxCellWidth))
    : DEFAULT_MAX_CELL_WIDTH
  const requestedMinCellWidth = options.minCellWidth ?? MIN_CONTENT_WIDTH
  const minCellWidth = Number.isFinite(requestedMinCellWidth)
    ? Math.max(1, Math.trunc(requestedMinCellWidth))
    : MIN_CONTENT_WIDTH
  // Overhead batas: format kotak `│ c │` memakan 2 kolom lebih banyak per baris
  // (baris batas `│` + padding) daripada format separator lama ` c ` + spasi.
  // `BOX_MARGIN` = margin kiri agar kotak tidak nempel ke tepi terminal.
  const overhead = options.box
    ? table.headers.length * 3 + 1 + BOX_MARGIN
    : table.headers.length * 3 - 1
  const budget = width - overhead
  const natural = naturalWidths(table, maxCellWidth)
  const minimums = atomicMinimums(table, natural).map((m) =>
    Math.max(m, Math.min(minCellWidth, ...natural.map((value) => Math.max(1, value)))),
  )
  const widths =
    (width < 40 && table.headers.length > 3) ||
    budget < minimums.reduce((sum, value) => sum + value, 0)
      ? null
      : fitWidths(natural, budget, minimums)
  if (!widths) return renderVertical(table, width, ellipsis).join("\n")

  const aligns = table.aligns ?? table.headers.map(() => "left" as const)
  const styleHeader = options.styleHeader !== false

  if (options.box) return renderBorderedGrid(table, widths, aligns, styleHeader, options)

  const separator = c.dim(widths.map((value) => "─".repeat(value + 2)).join(" "))

  if (options.wrap) {
    // Wrap isi sel di batas kolom (BUKAN truncate) agar info panjang tidak hilang
    // — dilanjutkan ke baris berikutnya dalam sel. ANSI terjaga via chunkByWidth
    // (mengembalikan SGR yang terbuka ke potongan berikutnya).
    const cellWrapped = (value: unknown, column: number): string[] => {
      const colWidth = widths[column]!
      const align = aligns[column] ?? "left"
      const raw = cleanCell(value)
      const rendered = options.formatCell?.(raw) ?? raw
      return wrapByWidth(rendered, colWidth).map((l) => alignCell(l, colWidth, align))
    }
    // Header bergaya bold+accent DITERAPKAN SEBELUM wrap agar baris lanjutan tetap
    // bergaya; header jarang wrap tapi tetap ditangani.
    const headerCols = table.headers.map((value, i) => {
      const colWidth = widths[i]!
      const align = aligns[i] ?? "left"
      const raw = cleanCell(value)
      const rendered = options.formatCell?.(raw) ?? raw
      const styled = styleHeader ? c.bold(c.accent(rendered)) : rendered
      return wrapByWidth(styled, colWidth).map((l) => alignCell(l, colWidth, align))
    })
    const lineOf = (cols: string[][], li: number): string =>
      cols.map((lines, ci) => ` ${lines[li] ?? padToWidth("", widths[ci]!)} `).join(" ")

    const headerHeight = headerCols.reduce((m, lines) => Math.max(m, lines.length), 1)
    const headerLines: string[] = []
    for (let li = 0; li < headerHeight; li++) headerLines.push(lineOf(headerCols, li))

    const bodyLines: string[] = []
    for (const row of table.rows) {
      const cols = row.map((_, i) => cellWrapped(row[i] ?? "", i))
      const height = cols.reduce((m, lines) => Math.max(m, lines.length), 0)
      for (let li = 0; li < height; li++) bodyLines.push(lineOf(cols, li))
    }
    return [separator, ...headerLines, ...bodyLines].join("\n")
  }

  // Mode default (tabel UI: config/sessions/skills): kolom lebar-tetap, nilai
  // kepanjangan dipotong dengan ellipsis — kolom TIDAK melebar / multi-baris.
  const cell = (value: unknown, column: number): string => {
    const colWidth = widths[column]!
    const align = aligns[column] ?? "left"
    const raw = cleanCell(value)
    const rendered = options.formatCell?.(raw) ?? raw
    return alignCell(truncateToWidth(rendered, colWidth, ellipsis), colWidth, align)
  }
  const header = table.headers.map((value, i) => {
    const rendered = cell(value, i)
    return styleHeader ? ` ${c.bold(c.accent(rendered))} ` : ` ${rendered} `
  })
  const rows = table.rows.map((row) => table.headers.map((_, i) => ` ${cell(row[i] ?? "", i)} `))
  return [separator, header.join(" "), ...rows.map((row) => row.join(" "))].join("\n")
}

export const renderTableGrid = renderGridTable
export const renderGrid = renderGridTable

export function renderMarkdownTable(
  table: MarkdownTable,
  width = getTerminalWidth(),
  formatCell?: (value: string) => string,
): string {
  return renderGridTable(
    {
      headers: table.headers,
      rows: table.rows,
      aligns: table.aligns,
    },
    { width, styleHeader: true, formatCell, box: true },
  )
}

export function renderMarkdownTableLines(
  table: MarkdownTable,
  width = getTerminalWidth(),
  formatCell?: (value: string) => string,
): string[] {
  const rendered = renderMarkdownTable(table, width, formatCell)
  return rendered ? rendered.split("\n") : []
}
