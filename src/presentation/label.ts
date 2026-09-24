// Labeler tunggal presentasi — satu sumber untuk target, preview, dan ringkasan
// tool. Murni, tanpa IO/clock.
//
// Kenapa di sini: 4 labeler lama + 3 angka cap berbeda; reducer (summary) dan
// proyeksi (label) harus berbagi satu sumber. Fase 3: fungsi siap pakai +
// unit test; Fase 6: simple.ts/toolStatus delegasi ke sini, Fase 7 hapus lama.
//
// Batas lapisan: src/presentation TIDAK boleh impor src/ui (ui-boundary) —
// sanitasi tampilan tetap di renderer (sanitizeAnsi defense-in-depth). Label
// di sini hanya memotong & membuang control-char kasar agar aman disimpan
// di state sebelum proyeksi.

import type { ArgsSummary, ToolIdentity } from "./events.ts"

/** Predikat nama tool ter-namespace; dipanggil policy/session tanpa parse string. */
export function isMcpToolName(name: string): boolean {
  return name.indexOf(".") > 0
}

export const MAX_TARGET = 80
/** Cap preview args di label satu-baris. */
export const MAX_PREVIEW = 60
/** Cap summary ringkas tool. */
export const MAX_SUMMARY = 120
/** Cap label status bar (nama+target). */
export const MAX_LABEL = 200

/** Potong per code point (jangan belah surrogate pair emoji di batas). */
function safeSlice(s: string, n: number): string {
  if (s.length <= n) return s
  return Array.from(s).slice(0, n).join("")
}

/** Buang C0/C1 + ESC kasar; label = satu baris plain sebelum paint sanitize. */
function stripControl(s: string): string {
  let out = ""
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c === 0x1b || c === 0x7f || (c < 0x20 && ch !== "\t") || (c >= 0x80 && c <= 0x9f)) continue
    out += ch === "\n" || ch === "\r" ? " " : ch
  }
  return out.trim()
}

function clip(s: string, max: number): string {
  const t = stripControl(s)
  return t.length > max ? `${safeSlice(t, max)}…` : t
}

/**
 * Target utama argumen — urutan mengikuti konvensi ledger:
 * path/from-to → cmd/command → pattern → query → prompt-slice.
 */
export function targetOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined
  const a = args as Record<string, unknown>
  if (typeof a.path === "string" && a.path) return a.path
  if (typeof a.from === "string" && a.from) {
    const to = typeof a.to === "string" ? a.to : ""
    return to ? `${a.from} → ${to}` : a.from
  }
  const cmd = a.cmd ?? a.command
  if (typeof cmd === "string" && cmd) return `$ ${cmd}`
  if (typeof a.pattern === "string" && a.pattern) return a.pattern
  if (typeof a.query === "string" && a.query) return a.query
  if (typeof a.prompt === "string" && a.prompt) return a.prompt
  if (typeof a.file === "string" && a.file) return a.file
  return undefined
}

/** Preview args satu baris (fallback bila ArgsSummary.target kosong). */
export function previewArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) return ""
  const t = targetOf(args)
  if (t) return t
  try {
    return clip(JSON.stringify(args), MAX_PREVIEW)
  } catch {
    return "[args]"
  }
}

export interface ToolLabel {
  target?: string
  summary: string
}

/**
 * Label semantik tool dari identity + argsSummary (sudah di-parse di adapter).
 * `summary` = baris ledger; `target` = path/$cmd untuk kolom.
 */
export function labelTool(identity: ToolIdentity, args: ArgsSummary): ToolLabel {
  const name = identity.qualified
  const rawTarget = args.target ?? undefined
  const target = rawTarget ? clip(rawTarget, MAX_TARGET) : undefined
  if (name === "bash" && rawTarget) {
    return { target, summary: clip(`bash ${rawTarget}`, MAX_SUMMARY) }
  }
  if ((name === "todo_write" || name === "todo_read") && args.text) {
    const m = /todos=(\d+)/.exec(args.text)
    const n = m?.[1]
    if (n && n !== "0") return { target, summary: clip(`${name} ${n} items`, MAX_SUMMARY) }
  }
  const summary = target ? `${name} ${target}` : name
  return { target, summary: clip(summary, MAX_SUMMARY) }
}

/** Label status-bar — nama + target, cap MAX_LABEL. */
export function statusLabel(identity: ToolIdentity, args: ArgsSummary): string {
  const { target } = labelTool(identity, args)
  const line = target ? `${identity.qualified} ${target}` : identity.qualified
  return clip(line, MAX_LABEL)
}

/**
 * Ringkasan hasil tool per jenis — satu baris, cap MAX_SUMMARY.
 * `result` = ToolResult kernel (isError + content) atau string mentah.
 */
export function summarizeResult(name: string, result: unknown): string {
  if (typeof result === "string") return clip(result, MAX_SUMMARY)
  if (typeof result !== "object" || result === null) return clip(String(result ?? ""), MAX_SUMMARY)
  const r = result as { isError?: boolean; content?: unknown }
  const content = r.content
  let text = ""
  if (typeof content === "string") text = content
  else if (Array.isArray(content)) {
    text = content
      .map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
      .join(" ")
  } else if (content != null) {
    try {
      text = JSON.stringify(content)
    } catch {
      text = String(content)
    }
  }
  const first = text.split(/\r?\n/, 1)[0] ?? ""
  if (r.isError && name === "bash") return clip(`✗ ${first}`, MAX_SUMMARY)
  return clip(first || name, MAX_SUMMARY)
}
