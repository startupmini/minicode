// Logo minicode — block-art KOMPAK (setengah ukuran) untuk boot screen TUI.
//
// Diturunkan dari hand-trace logo (logo_tui.py milik pemilik), didownsample 2×
// (12×47 → 6×24) memakai kuadran block elements (▘▝▖▗▚▞▙▛▜▟ + ▀▄▌▐█) supaya tepi
// diagonal tetap tajam di resolusi kecil. Warna: putih polos (c.white, hormati
// NO_COLOR/non-TTY) — diterapkan saat paint, data murni dapat dipakai ulang.

import { c } from "../render/theme.ts"

/** Baris logo (6 baris, lebar maks BOOT_LOGO_WIDTH). */
export const BOOT_LOGO_ROWS: readonly string[] = [
  " ▗▄▄▄▄         ▗▄▟█████▌",
  "▄▟████▄▖     ▗▄▟█▞▀▀▜██▌",
  "███▀▀▜███▌ ████▞▀▘  ▐██▌",
  "███    ▄▄███▀▀      ▐██▌",
  "███▄▄█████  ████▄▄▖ ▐██▌",
  "▀▜████▀▘     ▝▀▜███████▌",
]

/** Lebar maksimum (kolom) frame logo — untuk centering. */
export const BOOT_LOGO_WIDTH = 24

/** Satu baris logo siap cetak: indent `leftPad` + putih. */
export function paintLogoRow(row: string, leftPad: number): string {
  return `${" ".repeat(leftPad)}${c.white(row)}`
}
