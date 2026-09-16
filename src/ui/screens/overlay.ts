// Primitive overlay transient untuk layar interaktif.
//
// Tujuan: satu tempat untuk logika redraw + clear (delete line) yang dipakai
// picker/provider-manager/model-manager. Ini menjaga perilaku shell-like tetap
// konsisten: overlay hanya sementara, tidak menyentuh scrollback permanen.

export const CLEAR = "\x1b[2K"
export const SYNC_START = "\x1b[?2026h"
export const SYNC_END = "\x1b[?2026l"

/**
 * Render ulang overlay dari anchor baris saat ini.
 * Mengembalikan jumlah baris overlay terbaru untuk dipakai render berikutnya.
 */
export function renderTransientOverlay(lines: string[], prevRows: number): number {
  const next = lines.length
  // Non-TTY (pipe/redirect/CI): NOL byte kontrol — kontrak I6. Pemanggil
  // interaktif sudah menjaga via stdin.isTTY; guard di titik emisi menutup
  // pemakai langsung di masa depan (defense-in-depth, pola chrome.ts).
  if (!process.stdout.isTTY) return next
  const max = Math.max(prevRows, next)
  process.stdout.write(SYNC_START)
  if (max > 0) {
    process.stdout.write("\r\n")
    for (let k = 0; k < max; k++) {
      process.stdout.write(CLEAR)
      if (k < max - 1) process.stdout.write("\r\n")
    }
    process.stdout.write(`\x1b[${max}A`)
  }
  if (next > 0) {
    process.stdout.write("\r\n")
    for (let i = 0; i < next; i++) {
      process.stdout.write(CLEAR + (lines[i] ?? ""))
      if (i < next - 1) process.stdout.write("\r\n")
    }
    process.stdout.write(`\x1b[${next}A`)
  }
  process.stdout.write(SYNC_END)
  return next
}

/**
 * Hapus overlay dengan delete-line agar tidak menyisakan gap kosong.
 * Mengembalikan 0 (overlay sudah bersih).
 */
export function clearTransientOverlay(prevRows: number): number {
  // Lihat guard di renderTransientOverlay — alasan sama (kontrak I6).
  if (!process.stdout.isTTY) return 0
  process.stdout.write(SYNC_START)
  if (prevRows > 0) {
    process.stdout.write("\r\n")
    for (let k = 0; k < prevRows; k++) {
      process.stdout.write(CLEAR)
      process.stdout.write("\x1b[1M")
    }
    process.stdout.write("\x1b[1A")
  }
  process.stdout.write(SYNC_END)
  return 0
}
