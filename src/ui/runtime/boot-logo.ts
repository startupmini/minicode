// Logo minicode — block-art untuk boot screen TUI (phase startup).
//
// Diturunkan dari SVG logo (path poligon) lewat `scripts/render-logo.ts`
// (rasterizer zero-dep, one-off). Disimpan sebagai array baris supaya runtime
// TUI TIDAK butuh parser SVG/vektor — cuma string statis. Bila logo berubah,
// render ulang lewat `bun scripts/render-logo.ts` dan tempel hasilnya ke sini.
//
// Karakter pakai `█` (U+2588) full-block: render konsisten di ConPTY Windows dan
// tak bergantung font Braille. Warna diterapkan saat paint (bukan di sini) —
// data tetap polos agar bisa dipakai ulang.

/** Baris logo (panjang kiri-rata dalam kotak selebar BOOT_LOGO_WIDTH). */
export const BOOT_LOGO_ROWS: readonly string[] = [
  "  ██████               █████████",
  "  ██████               █████████",
  "███████████         ██████████████",
  "███████████         ██████████████",
  "██████████████   █████████████████",
  "██████████████   █████████████████",
  "██████████████████████████████████",
  "██████████████████████████████████",
  "██████████████████████████████████",
  "█████████████   ██████████████████",
  "█████████████   ██████████████████",
  "███████████         ██████████████",
  "███████████         ██████████████",
  "  ██████              ████████████",
  "  ██████              ████████████",
  "  ██████              ████████████",
  "                         ███████",
  "                         ███████",
]

/** Lebar maksimum baris logo (untuk centering). */
export const BOOT_LOGO_WIDTH = 34
