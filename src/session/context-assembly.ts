// P2.8 — Context Assembly (read-only, derived, RAM-only).
//
// Perakitan konteks = lapisan TUNGGAL antara histori kanonik/proyeksi turunan
// dan buffer vendor. Aturan“P2.8” yang bersifat hukum:
//
//   HANYA proyeksi CURRENT yang boleh ikut. State lain (STALE / INCOMPLETE /
//   CORRUPT / UNKNOWN / absen) → fallback ke histori kanonik persis seperti
//   hari ini. “Tak ada proyeksi” berarti “tak ada proyeksi yang bisa dipakai”,
//   BUKAN “histori kosong”.
//
// Batas keras modul ini:
//   - BACA SAJA. Nol tulis ke messages / history_projections / runs / sessions.
//   - Tanpa reads atas runs / run_id / last_persisted_seq (Run bukan input konteks).
//   - Tanpa kebijakan budget / pemicu kompaksi (milik vendor).
//   - Tanpa ringkasan baru (summary berasal dari pemanggil P2.7), tanpa rebuild.
//   - Tanpa state durable: ContextView hidup hanya di RAM per proses.
//
// Bentuk ringkasan sintetis mengikuti konvensi vendor yang sudah ada
// (vendor/minicore/src/core/compact.ts:44 — {role:"user", content:"Previous
// context:\n..."}): pesan user biasa, TANPA field persistence-only (event_id,
// seq, run_id, thread_id, migrated, …) dan tidak pernah ditulis balik ke histori.

import type { Message } from "#minicore/core/types.ts"
import {
  getProjection,
  getProjectionStatus,
  loadThreadHistoryWithSeq,
  type ProjectionState,
  SUMMARY_PROJECTION_ID,
} from "./persistence.ts"

/** Asal isi view: proyeksi turunan, atau histori kanonik (fallback). */
export type ContextSource = "projection" | "messages"

/**
 * View konteks turunan — NILAI SESAJA, bukan state persistensi.
 * Tidak pernah diserialisasi, tidak pernah jadi otoritas resume.
 */
export interface ContextView {
  /** Ringkasan cakupan [0, coveredSeq); absen bila fallback penuh. */
  summary?: string
  /** Cakupan eksklusif yang diwakili ringkasan; 0 bila tak ada ringkasan. */
  coveredSeq: number
  source: ContextSource
  status: ProjectionState
  /** Materialisasi untuk di-seed ke ContextStore vendor (appendAll). */
  messages: Message[]
  /**
   * Artefak context-only yang Tertanam di `messages[0]` (bila proyeksi
   * dipakai). Wajib dipROID oleh jalur persist agar artefak turunan tak
   * pernah menjadi histori kanonik. `undefined` pada fallback.
   */
  contextOnly?: ContextOnlyArtifact
  /** Alasan diagnostik kenapa proyeksi tidak dipakai (kosong bila CURRENT). */
  detail: string
}

/**
 * Bentuk vendor minimum yang valid untuk ringkasan sintetis: UserMessage
 * (role+content). Field persistence-only DILARANG di sini.
 */
export function syntheticSummaryMessage(summary: string, coveredSeq: number): Message {
  return {
    role: "user",
    // Penanda cakupan eksplisit supaya model (dan pembaca log) tahu ini
    // ringkasan prefix [0,N), bukan pesan kanonik.
    content: `Previous context [0,${coveredSeq}):\n${summary}`,
  }
}

/**
 * Batas pemotongan aman. Memotong antara assistant(toolCalls) dan hasil
 * tool-nya menghasilkan tool result yatim pada konteks — pasangan rusak yang
 * kernel/provider tak boleh terima. Border tak aman → fallback penuh
 * (deterministik; bukan heuristik).
 *
 * Diekspor untuk dipakai bersama P3.3 selector (satu sumber kebenaran batas;
 * P3.3 memilih segmen kanonik, ia wajib memakai batas yang SAMA).
 */
export function boundaryIsSafe(
  rows: { seq: number; message: unknown }[],
  boundarySeq: number,
): boolean {
  if (boundarySeq <= 0) return true
  const lastCovered = rows.find((r) => r.seq === boundarySeq - 1)
  const firstTail = rows.find((r) => r.seq === boundarySeq)
  const hasCalls = (m: unknown): boolean => {
    const toolCalls = (m as { toolCalls?: unknown } | undefined)?.toolCalls
    return Array.isArray(toolCalls) && toolCalls.length > 0
  }
  if (lastCovered && hasCalls(lastCovered.message)) return false
  if (firstTail && (firstTail.message as { role?: string }).role === "tool") return false
  return true
}

/**
 * Identitas artefak context-only yang HANYA boleh hidup di ContextStore.
 *
 * Mengapa field penanda tak bisa di的和ismegasikan di pesan: vendor
 * `snapshotMessage` (vendor/minicore/src/core/snapshot.ts:17) untuk
 * role "user" HANYA mempertahankan `{role, content}` — field tambahan
 * DIBUANG sebelum `session.state.history` terlihat aplikasi. Jadi penanda
 * struktural mustahil tanpa mengubah vendor (dilarang). Kanal yang selamat
 * hanyalah content itu sendiri — maka kanal ini adalah FINGERPRINT TEBAK
 * PERSIS dari artefak yang kita buat sendiri, bukan pola tekstual heuristik.
 *
 * Batasnya jelas: hanya cocok untuk satu pesan (index 0) dan hanya bila
 * role+content identik_byte dengan artefak yang dicatat. Kalau kernel
 * sudah mengompak (artefak terlipat ke summary vendor), fingerprint tak
 * cocok lagi → tak ada yang dibuang.
 */
export interface ContextOnlyArtifact {
  role: "user"
  content: string
}

/**
 * Buang artefak context-only dari array yang akan dipersist.
 * Fungsi MURNI, gagal-closed: tanpa fingerprint → tak mengubah apa pun.
 */
export function stripContextOnly<T>(
  messages: readonly T[],
  artifact: ContextOnlyArtifact | undefined,
): T[] {
  if (!artifact) return messages as T[]
  const first = messages[0] as { role?: unknown; content?: unknown } | undefined
  if (!first) return messages as T[]
  if (first.role !== artifact.role) return messages as T[]
  if (first.content !== artifact.content) return messages as T[]
  return messages.slice(1)
}

/**
 * Rakit view konteks untuk satu thread.
 *
 * Fallback = histori kanonik utuh, tanpa filter/urutan/transformasi — identik
 * dengan replay `loadSession` hari ini.
 */
export function assembleContext(sessionId: string, threadId: string, cwd?: string): ContextView {
  const status = getProjectionStatus(sessionId, threadId, SUMMARY_PROJECTION_ID, cwd)
  const rows = loadThreadHistoryWithSeq(sessionId, threadId, cwd)
  const all: Message[] = rows.map((r) => r.message as Message)

  // Fallback: tak ada proyeksi yang bisa dipakai. Histori kanonik utuh.
  const fallback = (detail: string, state: ProjectionState = status.state): ContextView => ({
    coveredSeq: 0,
    source: "messages",
    status: state,
    messages: all,
    detail,
  })

  // HANYA CURRENT boleh ikut. State lain → fallback, tanpa blend.
  if (status.state !== "CURRENT") return fallback(`projection ${status.state}: ${status.detail}`)

  const projection = getProjection(sessionId, threadId, SUMMARY_PROJECTION_ID, cwd)
  // Baris CURRENT tapi hilang saat dibaca = tak dapat dibuktikan → fallback.
  if (!projection) return fallback("projection CURRENT but unreadable", "UNKNOWN")
  const baseSeq = projection.base_seq
  // base_seq=0: cakupan vakum → tak ada ringkasan; histori utuh apa adanya.
  if (baseSeq <= 0) return fallback("empty coverage (base_seq=0)", "CURRENT")

  if (!boundaryIsSafe(rows, baseSeq)) {
    return fallback("unsafe boundary: tool call/result pair would split", "CURRENT")
  }

  const tail = rows.filter((r) => r.seq >= baseSeq).map((r) => r.message as Message)
  const summary = projection.summary_text
  if (typeof summary !== "string" || summary.length === 0) {
    return fallback("CURRENT projection carries no summary text", "CURRENT")
  }
  const synthetic = syntheticSummaryMessage(summary, baseSeq)
  const artifact: ContextOnlyArtifact = {
    role: "user",
    content: synthetic.content as string,
  }
  return {
    summary,
    coveredSeq: baseSeq,
    source: "projection",
    status: "CURRENT",
    messages: [synthetic, ...tail],
    contextOnly: artifact,
    detail: `summary covers [0,${baseSeq}) + canonical tail`,
  }
}
