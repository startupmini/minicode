// Formatter pesan event yang dipakai printer linier (simple.ts), sehingga
// "apa yang ditampilkan" konsisten antar konsumen (tidak dobel logika).
import type { UiToolCallRef } from "../contract.ts"
import { formatFriendly, friendlyFromCategory } from "./errors.ts"
import { formatUsd } from "./money.ts"

/**
 * Potong per code point (bukan UTF-16 unit): slice mentah membelah surrogate
 * pair emoji menjadi U+FFFD di label. Batas di sini adalah cap KONTEN (bukan
 * kolom terminal) — pemotongan kolom terjadi di hilir via truncateToWidth.
 */
function safeSlice(s: string, n: number): string {
  if (s.length <= n) return s
  return Array.from(s).slice(0, n).join("")
}

export function formatArgsPreview(args: unknown): string {
  try {
    const a = args as Record<string, unknown>
    if (a.path) return String(a.path)
    if (a.command) return safeSlice(String(a.command), 60)
    if (a.cmd) return safeSlice(String(a.cmd), 60)
    if (a.pattern) return String(a.pattern)
    if (a.query) return String(a.query)
    if (a.prompt) return safeSlice(String(a.prompt), 40)
    return safeSlice(JSON.stringify(a), 40)
  } catch {
    return "[args]"
  }
}

export function formatStepCalls(calls: readonly UiToolCallRef[], argCap = 35): string {
  return calls.map((tc) => `${tc.name}(${safeSlice(JSON.stringify(tc.args), argCap)})`).join(", ")
}

export function formatUsage(parts: {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}): string {
  const p = [
    parts.inputTokens != null ? `in:${parts.inputTokens}` : null,
    parts.outputTokens != null ? `out:${parts.outputTokens}` : null,
    parts.totalTokens != null ? `total:${parts.totalTokens}` : null,
  ].filter(Boolean) as string[]
  return p.join(" ")
}

/**
 * Error provider siap tampil: kategori formal dipetakan ke pesan yang bisa
 * ditindaklanjuti, detail provider diringkas ke satu kalimat.
 *
 * Sebelumnya fungsi ini mencetak `[kategori] <pesan mentah>` — body JSON
 * provider tumpah utuh ke layar. Satu 429 dari OpenRouter menghasilkan 400+
 * karakter berisi `metadata`, `provider_error_code`, dan URL dokumentasi.
 */
export function formatProviderError(e: { category?: string; message?: string }): string {
  const friendly = friendlyFromCategory(e.category ?? "unknown", e.message ?? "")
  return formatFriendly(friendly)
}

export function formatCost(cost?: number): string {
  return cost != null ? formatUsd(cost) : "N/A"
}
