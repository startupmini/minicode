// Kop ringkasan sesi — ditampilkan saat interactive exit (/exit atau Ctrl+D).
//
// Memakai wordmark teks "minicode" sebagai pengganti mark block-art: teks tetap
// rapi & legible di ukuran kecil, tidak hancur seperti block-element yang
// didownscale. Detail sesi di baris berikutnya, rata kiri.
//
// Wordmark tanpa warna custom: gradien truecolor (cyan→magenta) tidak didukung
// merata di semua terminal dan pernah membuat "minicode" tak tampil. Bold polos
// via `c` menjamin selalu terlihat + hormati NO_COLOR.

import { t } from "../i18n/locale.ts"
import { formatUsd } from "./money.ts"
import { sanitizeAnsiLine, stripSgr } from "./sanitize.ts"
import { c } from "./theme.ts"

const WORDMARK = "minicode"

/** "minicode" bold — selalu terlihat, hormat NO_COLOR/non-TTY. */
function paintWordmark(): string {
  return c.bold(WORDMARK)
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
  // Parameter dinamai `text`, bukan `t`: `t` sudah dipakai untuk i18n.
  const label = (text: string): string => c.muted(text.padEnd(7))
  const cost = s.cost != null ? formatUsd(s.cost) : null
  // sessionId/model = input tak-terpercaya (config/network): buang SEMUA ANSI
  // (termasuk SGR) sebelum dibungkus style — nilai mentah hanya boleh muncul
  // sebagai teks polos, styling ditambahkan pemanggil (aturan repo).
  const clean = (v: string): string => stripSgr(sanitizeAnsiLine(v))
  return `${[
    paintWordmark(),
    `${label(t("summary.session"))} ${c.gray(clean(s.sessionId))}`,
    `${label(t("summary.model"))} ${c.gray(clean(s.model))}`,
    `${label(t("summary.usage"))} ${s.totalTokens.toLocaleString()} ${t("summary.tokens")}${
      cost != null ? ` · ${cost}` : ""
    } · ${formatDuration(s.durationMs)}`,
  ]
    .join("\r\n")
    .concat("\r\n")}`
}
