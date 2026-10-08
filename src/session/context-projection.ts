// P3.4 — Durable Context Projection Producer (Projection Cache lifecycle).
//
// Menutup celah yang diidentifikasi audit P3.4: substrate `history_projections`
// (cache derived durable) SUDAH ada dan bisa DIBACA (P2.8 assembly + P3.3
// selector), tetapi TIDAK ADA jalur produksi yang membangunnya di jalur otomatis
// (`buildProjection`/`rebuildProjection` hanya dipakai test). Akibatnya basis
// seleksi `summary-plus-tail` tak pernah terjadi di produksi.
//
// Modul ini = PRODUSEN: membangun/menyegarkan baris proyeksi dari state kanonik
// lewat primitif yang SUDAH ADA (`buildProjection`, berpagar epoch). Batas keras:
//   - SUMBER = histori kanonik (baca-saja via loadThreadHistoryWithSeq). Bukan
//     buffer runtime, bukan state eksekusi.
//   - TULIS = HANYA `history_projections` (derived). NEVER `messages`/head/run.
//   - Bukan otoritas: proyeksi tetap cache; `saveSession` tetap satu-satunya
//     penulis kanonik.
//   - Ringkasan = render fold kernel yang SUDAH ADA (`mechanicalCompaction`) atas
//     PREFIX kanonik [0, baseSeq); ekor [baseSeq, head] tetap verbatim. BUKAN
//     algoritma A+C lanjutan (P3.7), bukan LLM/embedding/network.
//   - Deterministik: urutan kanonik, tanpa Date.now/random di jalur derivasi
//     (built_at diisi primitif P2.7, bukan klaim cakupan).
//
// Cakupan: proyeksi yang diproduksi adalah PARSIAL (base_seq < head+1) —
// "ringkasan prefix + ekor kanonik". P2.8 `assembleContext` hanya memakai
// proyeksi CURRENT (cakupan penuh); konsumen yang boleh menerima cakupan-parsial
// yang tetap VALID (jangkar utuh) adalah P3.3 selector (basis `summary-plus-tail`),
// sesuai P3.0 §8 D6 ("pembaca menerima coverage-valid, bukan hanya CURRENT").
//
// Runtime adapter / revision bridge ke runtime = P3.5 (di luar modul ini).

import { ContextStore, mechanicalCompaction } from "#minicore"
import type { Message } from "#minicore/core/types.ts"
import {
  buildProjection,
  DEFAULT_THREAD_ID,
  getProjection,
  getProjectionStatus,
  loadThreadHistoryWithSeq,
  type ProjectionRow,
  type ProjectionState,
  SUMMARY_PROJECTION_ID,
} from "./persistence.ts"

/** Kebijakan produsen — input deterministik, tanpa state mutable. */
export interface ProjectionProducePolicy {
  /**
   * Berapa turn terakhir dipertahankan verbatim sebagai ekor; prefix di atasnya
   * diringkas (render fold kernel yang SUDAH ADA). Harus >= 1 agar ada prefix.
   */
  readonly keepRecentTurns: number
}

/** Hasil produksi — laporan, bukan otoritas. */
export interface ProjectionProduceResult {
  /** True bila sebuah baris proyeksi dituliskan (ada prefix untuk diringkas). */
  readonly produced: boolean
  /** Baris proyeksi yang ditulis (bila produced). */
  readonly row?: ProjectionRow
  /** Cakupan eksklusif [0, baseSeq) yang diringkas (bila produced). */
  readonly baseSeq?: number
  /** Kenapa produced / tidak. Diagnostik. */
  readonly detail: string
}

/**
 * Derivasi DETERMINISTIK {summaryText, baseSeq} dari baris kanonik memakai render
 * fold kernel yang SUDAH ADA (`mechanicalCompaction`). MURNI (tak menyentuh DB,
 * tak memutasi input). Mengembalikan null bila tak ada prefix untuk diringkas.
 *
 * base_seq = jumlah baris prefix yang diringkas = total - |ekor verbatim|.
 */
export function deriveSummaryFromCanonical(
  messages: readonly Message[],
  policy: ProjectionProducePolicy,
): { summaryText: string; baseSeq: number } | null {
  if (messages.length === 0) return null
  const keep =
    Number.isInteger(policy.keepRecentTurns) && policy.keepRecentTurns >= 1
      ? policy.keepRecentTurns
      : 1
  const store = new ContextStore()
  store.appendAll(messages)
  const folded = mechanicalCompaction.compact(store, { keepRecentTurns: keep })
  // Tak ada fold (prefix kosong) → tak ada cakupan untuk proyeksi.
  if (folded.length >= messages.length) return null
  const kept = folded.length - 1
  const baseSeq = messages.length - kept
  const summaryMsg = folded[0] as { role?: unknown; content?: unknown } | undefined
  const summaryText = summaryMsg && typeof summaryMsg.content === "string" ? summaryMsg.content : ""
  if (baseSeq <= 0 || summaryText.length === 0) return null
  return { summaryText, baseSeq }
}

/**
 * PRODUSEN PRODUKSI. Membangun/menyegarkan proyeksi ringkasan durable dari state
 * kanonik. Berpagar epoch (reuse `buildProjection`). TIDAK menyentuh `messages`.
 *
 * Cakupan = PARSIAL bila `policy.keepRecentTurns` menyisakan ekor; base_seq =
 * jumlah baris prefix. `summaryText` opsional: bila pemanggil sudah memegang teks
 * ringkasan (mis. dari jalur kompaksi kernel), ia tidak dihitung ulang.
 *
 * Idempoten secara semantik: sumber sama + policy/ringkasan sama → baris ekuivalen
 * (base_seq + summary_text + anchor sama; built_at boleh beda — stempel waktu).
 * Kegagalan build TIDAK pernah mengubah kanonik.
 */
export function produceSummaryProjection(
  sessionId: string,
  cwd: string | undefined,
  opts: {
    expectedEpoch: number
    policy: ProjectionProducePolicy
    threadId?: string
    /** Teks ringkasan yang sudah diproduksi jalur kompaksi (opsional). */
    summaryText?: string
    /** base_seq eksplisit (dipakai bersama summaryText); absen = diturunkan. */
    baseSeq?: number
  },
): ProjectionProduceResult {
  const threadId = opts.threadId ?? DEFAULT_THREAD_ID
  const rows = loadThreadHistoryWithSeq(sessionId, threadId, cwd)
  if (rows.length === 0) {
    return { produced: false, detail: "empty canonical history — no projection" }
  }
  let summaryText = opts.summaryText
  let baseSeq = opts.baseSeq
  if (typeof summaryText !== "string" || summaryText.length === 0) {
    const derived = deriveSummaryFromCanonical(
      rows.map((r) => r.message as Message),
      opts.policy,
    )
    if (!derived) {
      return {
        produced: false,
        detail: `no foldable prefix (rows=${rows.length}, keepRecentTurns=${opts.policy.keepRecentTurns})`,
      }
    }
    summaryText = derived.summaryText
    baseSeq = derived.baseSeq
  }
  if (baseSeq === undefined || baseSeq <= 0) {
    return { produced: false, detail: "no explicit/derivable baseSeq — refusing empty projection" }
  }
  // Tulis lewat primitif P2.7 (epoch-fenced, satu txn, delete+insert, sumber
  // kanonik UTUH). Satu-satunya efek tulis produsen = history_projections.
  const row = buildProjection(sessionId, threadId, summaryText, cwd, {
    expectedEpoch: opts.expectedEpoch,
    baseSeq,
    projectionId: SUMMARY_PROJECTION_ID,
  })
  return {
    produced: true,
    row,
    baseSeq: row.base_seq,
    detail: `projection covers [0,${row.base_seq}) of ${rows.length} rows (partial: prefix summary + canonical tail)`,
  }
}

/** Status proyeksi ringkasan terkini (baca-saja). */
export function summaryProjectionStatus(
  sessionId: string,
  cwd?: string,
  threadId?: string,
): { state: ProjectionState; detail: string } {
  return getProjectionStatus(sessionId, threadId ?? DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)
}

/**
 * Baca proyeksi ringkasan yang dapat dikonsumsi SELECTOR: baris ada + VALID
 * (jangkar utuh & cakupan kanonik; STALE-dengan-jangkar-utuh DITERIMA sebagai
 * coverage-valid per P3.0 §8 D6). CORRUPT/UNKNOWN/absen → null (fallback kanonik).
 *
 * Mengembalikan { summaryText, baseSeq } untuk diteruskan ke `selectContext`
 * sebagai `projection`. Baca-saja; tak menulis apa pun.
 */
export function readConsumableSummaryProjection(
  sessionId: string,
  cwd?: string,
  threadId?: string,
): { summaryText: string; baseSeq: number } | null {
  const tid = threadId ?? DEFAULT_THREAD_ID
  const status = getProjectionStatus(sessionId, tid, SUMMARY_PROJECTION_ID, cwd)
  // CURRENT = cakupan penuh; STALE = head maju tetapi JANGKAR masih utuh
  // (coverage-valid). Keduanya boleh dikonsumsi selector. CORRUPT/INCOMPLETE/
  // UNKNOWN/absen → tak dapat dipakai.
  if (status.state !== "CURRENT" && status.state !== "STALE") return null
  const row = getProjection(sessionId, tid, SUMMARY_PROJECTION_ID, cwd)
  if (!row) return null
  if (row.base_seq <= 0 || typeof row.summary_text !== "string" || row.summary_text.length === 0) {
    return null
  }
  return { summaryText: row.summary_text, baseSeq: row.base_seq }
}
