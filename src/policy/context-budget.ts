import { LIMITS } from "../constants.ts"

/**
 * Anggaran konteks — satu sumber angka untuk reserve output, ambang kompaksi,
 * dan ambang reklasifikasi error. Murni (tanpa IO/state modul) supaya bisa
 * diuji langsung dan tak "membeku" saat import.
 *
 * KENAPA terpusat: reserve (`min(256, limit/10)`), ambang kompaksi, dan ambang
 * reklasifikasi 400 (50.000 mutlak) dulu hidup terpisah dengan asumsi yang
 * bertentangan — reserve 256 praktis nol untuk jendela 1M, sementara 50.000
 * mustahil dicapai model berjendela di bawah 50k.
 *
 * KENAPA tidak per-model: rumus hanya memakai jendela + batas output yang
 * DILAPORKAN endpoint. Semua model/provider mendapat anggaran proporsional sama.
 */

/** Batas atas reserve output. 20.000 = p99.99 ukuran ringkasan kompaksi di
 * lapangan; reserve lebih besar hanya mengurangi jendela berguna. */
export const OUTPUT_RESERVE_MAX_TOKENS = 20_000

/** Lantai reserve output: model ber-`max_output_tokens` kecil (4k) tetap butuh
 * ruang jawaban bermakna. Reserve 0 = request tepat di batas langsung ditolak. */
export const OUTPUT_RESERVE_MIN_TOKENS = 4_096

/** Dipakai saat `max_output_tokens` tidak dilaporkan endpoint. */
export const OUTPUT_RESERVE_DEFAULT_TOKENS = 20_000

/** Jarak ambang kompaksi dari effective window (lihat `compactBufferFor`
 * untuk penyesuaian jendela kecil). */
export const COMPACT_BUFFER_TOKENS = 13_000

/** Buffer peringatan (warning) sebelum kompaksi, dan jarak blocking. */
export const COMPACT_WARNING_BUFFER_TOKENS = 20_000
export const COMPACT_BLOCKING_BUFFER_TOKENS = 3_000

/** Di bawah jendela ini buffer diskalakan: 13k dari 32k = 40% jendela hilang. */
export const SMALL_WINDOW_THRESHOLD_TOKENS = 64_000

/**
 * Reserve output untuk sebuah jendela konteks.
 *
 * Rumus: `clamp(max(4_096, min(maxOutput, 20_000)), lantai 2% jendela)`.
 * Model yang melaporkan batas output kecil (4k) tetap mendapat reserve 4k;
 * model besar mendapat 20k. Jendela raksasa tidak pernah mendapat reserve 0
 * seperti perilaku lama `min(256, limit/10)`.
 */
export function outputReserveFor(windowTokens: number, maxOutputTokens?: number): number {
  const window = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : 0
  const reported =
    typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
      ? maxOutputTokens
      : OUTPUT_RESERVE_DEFAULT_TOKENS
  const wanted = Math.max(OUTPUT_RESERVE_MIN_TOKENS, Math.min(reported, OUTPUT_RESERVE_MAX_TOKENS))
  // Lantai 2% jendela: jendela raksasa (1M) tak boleh reserve lebih kecil dari
  // proporsi wajar; jendela kecil tak boleh reserve memakan seluruhnya.
  const floor = Math.floor(window * 0.02)
  // Reserve tak pernah boleh melebihi 40% jendela — di atas itu tak ada lagi
  // ruang berguna untuk input dan kompaksi menjadi mustahil.
  const ceiling = Math.floor(window * 0.4)
  // Lantai 2% TIDAK BOLEH melewati plafon 20k: reserve lebih besar dari plafon
  // hanya mengurangi jendela berguna tanpa manfaat (p99.99 ringkasan muat di
  // bawah 20k), dan membuat anggaran bergantung pada ukuran jendela dengan cara
  // yang tak diminta siapa pun.
  const target = Math.max(wanted, Math.min(floor, OUTPUT_RESERVE_MAX_TOKENS))
  return Math.max(
    OUTPUT_RESERVE_MIN_TOKENS,
    Math.min(target, Math.max(OUTPUT_RESERVE_MIN_TOKENS, ceiling)),
  )
}

/** Buffer kompaksi, diskalakan untuk jendela kecil. */
export function compactBufferFor(windowTokens: number): number {
  const window = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : 0
  if (window >= SMALL_WINDOW_THRESHOLD_TOKENS) return COMPACT_BUFFER_TOKENS
  // Jendela kecil: buffer proporsional (20% effective window), tak pernah lebih
  // dari buffer penuh.
  return Math.min(COMPACT_BUFFER_TOKENS, Math.max(1_000, Math.floor(window * 0.2)))
}

export interface ContextBudget {
  readonly windowTokens: number
  readonly outputReserve: number
  /** Jendela yang benar-benar bisa dipakai untuk input + riwayat. */
  readonly effectiveWindow: number
  /** Ambang kompaksi: effectiveWindow - buffer. */
  readonly compactTrigger: number
  /** Ambang peringatan user. */
  readonly warningLevel: number
  /** Batas blokir: di atas ini request pasti ditolak provider. */
  readonly blockingLimit: number
  /** Ambang reklasifikasi 400 = min(50_000, window*0.5). */
  readonly reclassifyThreshold: number
}

/**
 * Hitung seluruh angka anggaran dari satu jendela. Semua nilai non-negatif dan
 * monotonik terhadap jendela, sehingga jendela lebih besar tidak pernah
 * menghasilkan ambang kompaksi lebih kecil.
 */
export function contextBudgetFor(windowTokens: number, maxOutputTokens?: number): ContextBudget {
  const window = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : 1
  const outputReserve = outputReserveFor(window, maxOutputTokens)
  const effectiveWindow = Math.max(0, window - outputReserve)
  const buffer = compactBufferFor(window)
  const warningBuffer = Math.min(COMPACT_WARNING_BUFFER_TOKENS, buffer + 7_000)
  return {
    windowTokens: window,
    outputReserve,
    effectiveWindow,
    compactTrigger: Math.max(0, effectiveWindow - buffer),
    warningLevel: Math.max(0, effectiveWindow - warningBuffer),
    blockingLimit: Math.max(0, window - outputReserve - COMPACT_BLOCKING_BUFFER_TOKENS),
    reclassifyThreshold: contextReclassifyThreshold(window),
  }
}

/**
 * Ambang volume lokal untuk mereklasifikasi 400 generik sebagai kehabisan
 * konteks.
 *
 * `min(CONTEXT_RECLASSIFY_400_MIN_LOCAL_TOKENS, window * ratio)`: jendela besar
 * tetap memakai 50.000 (aman dari salah klasifikasi argumen tool yang panjang),
 * sedangkan jendela kecil bisa mencapainya sebelum benar-benar penuh. Tanpa
 * lantai proporsional, model 32k mustahil menempuh recovery.
 */
export function contextReclassifyThreshold(windowTokens: number): number {
  const cap = LIMITS.CONTEXT_RECLASSIFY_400_MIN_LOCAL_TOKENS
  const window = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : 0
  const scaled = Math.floor(window * LIMITS.CONTEXT_RECLASSIFY_400_WINDOW_RATIO)
  if (scaled <= 0) return cap
  return Math.min(cap, scaled)
}
