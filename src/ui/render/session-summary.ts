// Kop ringkasan sesi — ditampilkan saat interactive exit (/exit atau Ctrl+D).
//
// Logo kecil (3 baris) di kiri, detail sesi di kanan. Logo adalah penyederhanaan
// dari mark minicode (logo_tui.py) yang didownscale; disimpan sebagai array
// tunggal supaya mudah disesuaikan tanpa menyentuh logika. Warna hormati
// NO_COLOR/non-TTY lewat palet `c`.

import { formatUsd } from "./money.ts"
import { c } from "./theme.ts"

export const SESSION_LOGO_ROWS: readonly string[] = [
  " ▄▄▄▄▖      ▄▄▄▄▄▖",
  "█▌   ▗▄▟▀▀▜▙▄▖    ▐█",
  "▀▜▄▄▄▄▟▀▘   ▝▀▜▄▄▟▘",
]

const LOGO_WIDTH = Math.max(...SESSION_LOGO_ROWS.map((r) => r.length))

export interface SessionSummary {
  sessionId: string
  model: string
  totalTokens: number
  cost?: number
  durationMs: number
}

/** "3m 12s" / "1m 5s" / "45s" untuk durasi manusia. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total >= 60) return `${Math.floor(total / 60)}m ${total % 60}s`
  return `${total}s`
}

/** Indent baris logo ke lebar tetap agar kolom detail rata kiri. */
function logoCell(i: number): string {
  const row = SESSION_LOGO_ROWS[i] ?? ""
  return c.white(row) + " ".repeat(LOGO_WIDTH - row.length)
}

/** Render kop: logo kiri + detail sesi kanan (baris demi baris). */
export function renderSessionSummary(s: SessionSummary): string {
  const label = (t: string): string => c.muted(t.padEnd(8))
  const cost = s.cost != null ? formatUsd(s.cost) : "N/A"
  const lines = [
    `${logoCell(0)}  ${label("Session")} ${c.gray(s.sessionId)}`,
    `${logoCell(1)}  ${label("Model")} ${c.gray(s.model)}`,
    `${logoCell(2)}  ${label("Usage")} ${s.totalTokens.toLocaleString()} tokens${
      s.cost != null ? ` · ${cost}` : ""
    } · ${formatDuration(s.durationMs)}`,
  ]
  return `\n${lines.join("\n")}\n`
}
