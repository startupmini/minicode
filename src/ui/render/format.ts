// Formatter pesan event yang dipakai printer linier (simple.ts), sehingga
// "apa yang ditampilkan" konsisten antar konsumen (tidak dobel logika).
import { formatFriendly, friendlyFromCategory } from "./errors.ts"
import { formatUsd } from "./money.ts"

export function formatArgsPreview(args: unknown): string {
  try {
    const a = args as Record<string, unknown>
    if (a.path) return String(a.path)
    if (a.command) return String(a.command).slice(0, 60)
    if (a.cmd) return String(a.cmd).slice(0, 60)
    if (a.pattern) return String(a.pattern)
    if (a.query) return String(a.query)
    if (a.prompt) return String(a.prompt).slice(0, 40)
    return JSON.stringify(a).slice(0, 40)
  } catch {
    return "[args]"
  }
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
