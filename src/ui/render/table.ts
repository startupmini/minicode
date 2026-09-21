import { sanitizeAnsiLine } from "./sanitize.ts"
import { c, getTerminalWidth } from "./theme.ts"
import { displayWidth, padToWidth, truncateToWidth } from "./width.ts"

export interface ColumnDef {
  header: string
  /** Lebar kolom dalam KOLOM terminal sebagai BATAS KERAS; isi lebih panjang dipotong "…". */
  width?: number
  key: string
  align?: "left" | "right"
}

const ELLIPSIS = "\u2026"
/** Batas otomatis bila `width` tidak diberikan. */
const AUTO_MAX = 50

/**
 * Nilai sel siap tampil: newline/tab/karakter kontrol dibuang.
 *
 * Satu newline dalam nilai memecah baris tabel menjadi dua dan seluruh
 * kolom setelahnya bergeser — pemanggil (`config list`, `providers`, `skills`)
 * mengambil nilai dari config/frontmatter yang bisa berisi apa pun.
 */
function sanitizeCell(v: unknown): string {
  const s = v == null ? "" : String(v)
  // Sekuens non-SGR dibuang, SGR dipertahankan — sel tabel bisa berisi data tidak terpercaya.
  return sanitizeAnsiLine(s)
    .replace(/[\t\v\f\u0085\u2028\u2029]/g, " ")
    .replace(/\r/g, " ")
}

// Table minimal - kolom aligned + separator header, tanpa border.
export function renderTable(columns: ColumnDef[], data: Record<string, unknown>[]): string {
  if (columns.length === 0) return c.muted("(no columns)")
  if (data.length === 0) return c.muted("(no entries)")

  const cells = data.map((row) => columns.map((col) => sanitizeCell(row[col.key])))
  // Header bisa berasal dari frontmatter/config (tak-terpercaya): sanitasi
  // seperti sel agar `\n`/ANSI tak memecah baris vertikal atau lolos.
  const heads = columns.map((col) => sanitizeCell(col.header))

  const termW = getTerminalWidth()
  // Terminal sangat sempit + banyak kolom: budget per kolom (~10) membuat
  // semua isi jadi "…" — render vertikal `key: value` agar tetap terbaca.
  if (termW < 40 && columns.length > 3) {
    return data
      .map((row) =>
        columns
          .map((col, ci) => {
            // Nilai dipotong dari sisa budget SETELAH header: tanpa ini
            // header+": "+value pasti > termW di terminal sempit (jalur
            // penyelamat yang malah wrap sendiri).
            const budget = Math.max(4, termW - displayWidth(heads[ci] ?? "") - 2)
            return `${c.bold(heads[ci] ?? "")}: ${truncateToWidth(sanitizeCell(row[col.key]), budget, ELLIPSIS)}`
          })
          .join("\n"),
      )
      .join("\n\n")
  }

  // `width` yang dideklarasikan adalah batas keras dalam KOLOM terminal
  // (CJK/emoji dihitung dua). Sebelumnya ia hanya MINIMUM dan diukur per
  // karakter, sehingga satu nilai panjang mendorong kolom melebar dan header
  // berhenti berbaris dengan body.
  const widths = columns.map((col, i) => {
    // Nilai negatif/NaN dari pemanggil tidak boleh membuat "".repeat() melempar.
    if (col.width != null && Number.isFinite(col.width)) return Math.max(0, Math.trunc(col.width))
    let max = displayWidth(heads[i] ?? "")
    for (const row of cells) {
      const w = displayWidth(row[i] ?? "")
      if (w > max) max = w
    }
    // AUTO_MAX dihormati, tapi di terminal sempit kurangi agar tidak overflow.
    const budget = Math.max(10, Math.floor((termW - columns.length * 3) / columns.length))
    return Math.min(max, Math.min(AUTO_MAX, budget))
  })

  const cell = (text: string, width: number, align: "left" | "right" = "left"): string =>
    padToWidth(truncateToWidth(text, width, ELLIPSIS), width, align)

  const header = columns
    .map((col, i) => ` ${c.bold(c.accent(cell(heads[i] ?? "", widths[i]!, col.align)))} `)
    .join(" ")

  // Separator (─ antara header dan body). Lebarnya harus SAMA dengan baris
  // data: tiap sel adalah " isi " (width+2) dan antar sel disatukan satu spasi.
  const sep = c.dim(widths.map((w) => "─".repeat(w + 2)).join(" "))

  const rows = cells.map((row) =>
    columns.map((col, i) => ` ${cell(row[i] ?? "", widths[i]!, col.align)} `).join(" "),
  )

  return [sep, header, ...rows].join("\n")
}
