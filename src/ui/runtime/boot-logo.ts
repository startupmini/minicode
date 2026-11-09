// Logo minicode — block-art 12 baris untuk boot screen TUI (phase startup).
//
// Berasal dari hand-trace logo (lihat logo_tui.py milik pemilik) yang dipakai
// sebagai SATU sumber visual: block elements (█ ▌ ▐ ▀ ▄ + kuadran ▘▝▖▗▚▞▙▛▜▟)
// supaya tepi piksel tetap tajam, lebih mirip mark asli daripada rasterisasi
// path SVG polos. Warna: gradien horizontal cyan→magenta (truecolor), fallback
// bright-cyan, dan polos saat NO_COLOR/non-TTY — diterapkan saat paint, bukan
// dibekukan di data, jadi data murni dapat dipakai ulang.

/** Baris logo (sudah memuat spasi internal sebagai bagian frame 47 kolom). */
export const BOOT_LOGO_ROWS: readonly string[] = [
  "                                   ████████▌",
  "   ▗▄▄▄▄▄▄▄▖                   ▄▄▄▄████████▙▄▄▄",
  "   ▐███████▌                   ████████████████",
  "███████████████            ████████      ▐█████",
  "█████▛▀▀▀▀▀▜███▄▄▄▖   ▗▄▄▄▄████▀▀▀▀      ▐█████",
  "█████▌     ▐██████▌   ▐████████          ▐█████",
  "█████▌            ▐████████▌             ▐█████",
  "█████▌        ▐█████████                 ▐█████",
  "█████▌    █████████▌    ███████▌         ▐█████",
  "█████▙▄▄▄▄█████▀▀▀▀▘    ▀▀▀▜███▙▄▄▄▄▖    ▐█████",
  "▀▀▀▜███████▛▀▀▀            ▝▀▀▀▜████▙▄▄▄▄▟█▛▀▀▀",
  "   ▐███████▌                   ▐███████████▌",
]

/** Lebar maksimum (kolom) frame logo — dipakai untuk centering + gradien. */
export const BOOT_LOGO_WIDTH = Math.max(...BOOT_LOGO_ROWS.map((r) => r.length))

const GRAD_START = [0, 240, 255] // cyan
const GRAD_END = [255, 80, 220] // magenta

/** Apa warna boleh keluar (mirip aturan theme.ts, target = stderr boot screen). */
function colorEnabled(): { ansi: boolean; truecolor: boolean } {
  const noColor = process.env.NO_COLOR != null && process.env.NO_COLOR !== "0"
  const ansi = !noColor && process.stderr.isTTY
  const truecolor =
    ansi && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit")
  return { ansi, truecolor }
}

/** Warnai satu baris: gradien horizontal cyan→magenta (truecolor) atau bright-cyan. */
function colorizeRow(row: string): string {
  const { ansi, truecolor } = colorEnabled()
  if (!ansi) return row
  const width = BOOT_LOGO_WIDTH
  let out = ""
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!
    if (ch === " ") {
      out += " "
      continue
    }
    if (truecolor) {
      const t = i / (width - 1)
      const r = Math.round(GRAD_START[0]! + (GRAD_END[0]! - GRAD_START[0]!) * t)
      const g = Math.round(GRAD_START[1]! + (GRAD_END[1]! - GRAD_START[1]!) * t)
      const b = Math.round(GRAD_START[2]! + (GRAD_END[2]! - GRAD_START[2]!) * t)
      out += `\x1b[38;2;${r};${g};${b}m${ch}`
    } else {
      out += `\x1b[96m${ch}`
    }
  }
  return `${out}\x1b[0m`
}

/** Baris logo siap cetak: di-indent `leftPad` + ternilai. */
export function paintLogoRow(row: string, leftPad: number): string {
  return `${" ".repeat(leftPad)}${colorizeRow(row)}`
}
