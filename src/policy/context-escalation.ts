/**
 * Eskalasi adaptif jendela konteks.
 *
 * KENAPA: metadata bisa tak lengkap (endpoint tak melaporkan `context_length`,
 * model terlalu baru untuk katalog). Tanpa jalur ini model berjendela besar
 * tetap dipakai dengan tebakan kecil — sesi panjang mati padahal kapasitasnya
 * berlipat.
 *
 * UNIVERSAL: tak pernah bercabang pada nama model, vendor, atau status
 * berbayar. Semua request berbiaya, jadi anggaran probe berlaku untuk semua.
 *
 * KEAMANAN: probe HANYA dari error konteks terverifikasi — tak pernah
 * 429/402/401/403/5xx/jaringan. `max_tokens: 1` + padding sintetis, bukan
 * riwayat percakapan.
 */

/** Tangga eskalasi. Satu anak tangga per overflow terverifikasi. */
export const CONTEXT_WINDOW_LADDER: readonly number[] = [
  131_072, 262_144, 524_288, 1_048_576, 2_097_152,
] as const

/** Batas atas absolut. Menutupi seluruh jendela model publik saat ini
 * (terbesar 2M) dan aman untuk aritmetika bilangan apa pun. */
export const CONTEXT_WINDOW_ESCALATION_CEILING = 2_097_152

/** Anak tangga berikutnya di atas `current`, atau `undefined` bila sudah di
 * batas atas. Tidak melompat: satu langkah per kejadian. */
export function nextLadderStep(current: number): number | undefined {
  const cur = Number.isFinite(current) && current > 0 ? current : 0
  for (const step of CONTEXT_WINDOW_LADDER) {
    if (step > cur) return Math.min(step, CONTEXT_WINDOW_ESCALATION_CEILING)
  }
  return undefined
}

/** Apakah nilai ini boleh dipakai sebagai jendela hasil probe. */
export function isValidWindow(tokens: unknown): tokens is number {
  return (
    typeof tokens === "number" &&
    Number.isSafeInteger(tokens) &&
    tokens > 0 &&
    tokens <= CONTEXT_WINDOW_ESCALATION_CEILING
  )
}

/**
 * Apakah error ini boleh MEMICU probe.
 *
 * Whitelist ketat: menaikkan jendela pada 429/402/401/403/5xx/jaringan adalah
 * diagnosis salah yang membakar request pada kondisi yang butuh berhenti.
 * Hanya kehabisan konteks = "jendela kita salah tebak".
 */
export function isContextOverflowError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const category = (error as { category?: unknown }).category
  if (category === "context_length_exceeded") return true
  const message = String((error as { message?: unknown }).message ?? "")
  // Sebagian gateway hanya mengirim prosa. Pola sempit ini menangkap kasus
  // umum tanpa menangkap rate-limit/kuota.
  return /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long/i.test(
    message,
  )
}

export interface ProbeBudgetState {
  /** Jumlah probe per kunci `provider::model` dalam 24 jam. */
  perModel: Record<string, { count: number; lastAt: number; rejectedUntil?: number }>
  /** Jumlah probe sejak proses mulai. */
  processCount: number
}

export interface ProbeBudgetLimits {
  perModelPerDay?: number
  perProcess?: number
  backoffMs?: number
  now?: () => number
}

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_BACKOFF_MS = 6 * 60 * 60 * 1000

export function emptyProbeBudget(): ProbeBudgetState {
  return { perModel: {}, processCount: 0 }
}

/** Boleh probe sekarang? Tidak memutasi state (predikat murni). */
export function canProbe(
  state: ProbeBudgetState,
  key: string,
  limits: ProbeBudgetLimits = {},
): { allowed: boolean; reason?: "kill-switch" | "per-model" | "per-process" | "backoff" } {
  if (process.env.MINICODE_CONTEXT_PROBE === "0") return { allowed: false, reason: "kill-switch" }
  const now = limits.now?.() ?? Date.now()
  const perModelLimit = limits.perModelPerDay ?? 2
  const perProcessLimit = limits.perProcess ?? 5
  if (state.processCount >= perProcessLimit) return { allowed: false, reason: "per-process" }
  const entry = state.perModel[key]
  if (entry) {
    if (entry.rejectedUntil !== undefined && now < entry.rejectedUntil)
      return { allowed: false, reason: "backoff" }
    // Jendela 24 jam bergulir: hitungan lama dianggap 0.
    if (now - entry.lastAt < DAY_MS && entry.count >= perModelLimit)
      return { allowed: false, reason: "per-model" }
  }
  return { allowed: true }
}

/** Catat satu probe. `rejected` = endpoint menolak (401/403/404) → backoff. */
export function recordProbe(
  state: ProbeBudgetState,
  key: string,
  outcome: "attempt" | "rejected",
  limits: ProbeBudgetLimits = {},
): ProbeBudgetState {
  const now = limits.now?.() ?? Date.now()
  const backoff = limits.backoffMs ?? DEFAULT_BACKOFF_MS
  const prev = state.perModel[key]
  const countInWindow = prev && now - prev.lastAt < DAY_MS ? prev.count : 0
  const next: ProbeBudgetState = {
    perModel: {
      ...state.perModel,
      [key]: {
        count: countInWindow + 1,
        lastAt: now,
        ...(outcome === "rejected" ? { rejectedUntil: now + backoff } : {}),
      },
    },
    processCount: state.processCount + 1,
  }
  return next
}

/** Padding sintetis sepanjang `tokens` token (≈4 char/token). SENGAJA bukan
 * riwayat asli: probe mengukur kapasitas endpoint, bukan isi sesi, dan riwayat
 * asli membocorkan data sesi. */
export function syntheticPadding(tokens: number, charsPerToken = 4): string {
  const chars = Math.max(0, Math.floor(tokens * charsPerToken))
  const unit = "context-capacity-probe "
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
}
