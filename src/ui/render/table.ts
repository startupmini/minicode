import { sanitizeAnsiLine } from "./sanitize.ts"
import { renderGridTable } from "./table-grid.ts"
import { c, getTerminalWidth } from "./theme.ts"

export { renderGridTable, renderMarkdownTable, renderMarkdownTableLines } from "./table-grid.ts"

export interface ColumnDef {
  header: string
  width?: number
  key: string
  align?: "left" | "right" | "center"
}

function cleanCell(value: unknown): string {
  return sanitizeAnsiLine(value == null ? "" : String(value))
    .replace(/[\t\v\f\u0085\u2028\u2029]/g, " ")
    .replace(/\r/g, " ")
}

export function renderTable(columns: ColumnDef[], data: Record<string, unknown>[]): string {
  if (columns.length === 0) return c.muted("(no columns)")
  if (data.length === 0) return c.muted("(no entries)")
  const rows = data.map((row) => columns.map((column) => cleanCell(row[column.key])))
  return renderGridTable(
    {
      headers: columns.map((column) => cleanCell(column.header)),
      rows,
      aligns: columns.map((column) => column.align ?? "left"),
      widths: columns.map((column) => column.width),
    },
    { width: getTerminalWidth(), maxCellWidth: 50, styleHeader: true },
  )
}
