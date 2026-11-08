import type { MarkdownTable, PipeTableAlignment } from "./markdown-table.ts"
import { cleanUntrusted, sanitizeAnsiLine } from "./sanitize.ts"
import { c, getTerminalWidth } from "./theme.ts"
import { chunkByWidth, displayWidth, padToWidth, truncateToWidth } from "./width.ts"

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
}

const DEFAULT_ELLIPSIS = "…"
const DEFAULT_MAX_CELL_WIDTH = 50
const MIN_CONTENT_WIDTH = 3

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

function fitWidths(natural: readonly number[], budget: number, minimum: number): number[] | null {
  const widths = natural.map((value) => Math.max(minimum, value))
  const naturalTotal = widths.reduce((sum, value) => sum + value, 0)
  if (naturalTotal <= budget) return widths
  const room = budget - widths.length * minimum
  if (room < 0) return null
  const extras = widths.map((value) => value - minimum)
  const extraTotal = extras.reduce((sum, value) => sum + value, 0)
  if (extraTotal <= 0) return null
  let assigned = 0
  for (let i = 0; i < widths.length; i++) {
    const share =
      i === widths.length - 1 ? room - assigned : Math.floor((extras[i]! * room) / extraTotal)
    const amount = Math.min(extras[i]!, Math.max(0, share))
    widths[i] = minimum + amount
    assigned += amount
  }
  return widths
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
  const overhead = table.headers.length * 3 - 1
  const budget = width - overhead
  const natural = naturalWidths(table, maxCellWidth)
  const minimum = Math.max(1, Math.min(minCellWidth, ...natural.map((value) => Math.max(1, value))))
  const widths =
    (width < 40 && table.headers.length > 3) || budget < table.headers.length * minimum
      ? null
      : fitWidths(natural, budget, minimum)
  if (!widths) return renderVertical(table, width, ellipsis).join("\n")

  const aligns = table.aligns ?? table.headers.map(() => "left" as const)
  const styleHeader = options.styleHeader !== false
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
      return chunkByWidth(rendered, colWidth).map((l) => alignCell(l, colWidth, align))
    }
    // Header bergaya bold+accent DITERAPKAN SEBELUM wrap agar baris lanjutan tetap
    // bergaya; header jarang wrap tapi tetap ditangani.
    const headerCols = table.headers.map((value, i) => {
      const colWidth = widths[i]!
      const align = aligns[i] ?? "left"
      const raw = cleanCell(value)
      const rendered = options.formatCell?.(raw) ?? raw
      const styled = styleHeader ? c.bold(c.accent(rendered)) : rendered
      return chunkByWidth(styled, colWidth).map((l) => alignCell(l, colWidth, align))
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
    { width, styleHeader: true, formatCell, wrap: true },
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
