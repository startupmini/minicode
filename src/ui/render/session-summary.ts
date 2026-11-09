// Kop ringkasan sesi — ditampilkan saat interactive exit (/exit atau Ctrl+D).
//
// Memakai wordmark teks "minicode" (gradien cyan→magenta, warna brand) sebagai
// pengganti mark block-art: teks tetap rapi & legible di ukuran kecil, tidak
// hancur seperti block-element yang didownscale. Detail sesi di baris berikutnya,
// rata kiri. Warna hormati NO_COLOR/non-TTY.

import { formatUsd } from "./money.ts"
import { c } from "./theme.ts"

const WORDMARK = "minicode"

const GRAD_START = [0, 240, 255] // cyan
const GRAD_END = [255, 80, 220] // magenta

/** Apa warna boleh keluar (mirip aturan theme.ts; target = stdout exit summary). */
function wordmarkStyle(): { ansi: boolean; truecolor: boolean } {
  const noColor = process.env.NO_COLOR != null && process.env.NO_COLOR !== "0"
  const ansi = !noColor && process.stdout.isTTY
  const truecolor =
    ansi && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit")
  return { ansi, truecolor }
}

/** "minicode" dengan gradien horizontal cyan→magenta (+bold), fallback bright-cyan. */
function paintWordmark(): string {
  const { ansi, truecolor } = wordmarkStyle()
  if (!ansi) return WORDMARK
  if (!truecolor) return `\x1b[1;96m${WORDMARK}\x1b[0m`
  let out = ""
  const last = WORDMARK.length - 1
  for (let i = 0; i < WORDMARK.length; i++) {
    const t = i / last
    const r = Math.round(GRAD_START[0]! + (GRAD_END[0]! - GRAD_START[0]!) * t)
    const g = Math.round(GRAD_START[1]! + (GRAD_END[1]! - GRAD_START[1]!) * t)
    const b = Math.round(GRAD_START[2]! + (GRAD_END[2]! - GRAD_START[2]!) * t)
    out += `\x1b[1;38;2;${r};${g};${b}m${WORDMARK[i]}`
  }
  return `${out}\x1b[0m`
}

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

/** Render kop: wordmark + detail sesi (baris demi baris). */
export function renderSessionSummary(s: SessionSummary): string {
  const label = (t: string): string => c.muted(t.padEnd(7))
  const cost = s.cost != null ? formatUsd(s.cost) : null
  return `\n${[
    paintWordmark(),
    `${label("Session")} ${c.gray(s.sessionId)}`,
    `${label("Model")} ${c.gray(s.model)}`,
    `${label("Usage")} ${s.totalTokens.toLocaleString()} tokens${
      cost != null ? ` · ${cost}` : ""
    } · ${formatDuration(s.durationMs)}`,
  ].join("\n")}\n`
}
