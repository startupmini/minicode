// P3.7 — Advanced A+C full-coverage fold renderer (pure, deterministic).
//
// Menutup celah yang diidentifikasi audit P3.7: satu-satunya renderer fold
// deterministik (`mechanicalCompaction`, vendor) SELALU menyisakan ekor
// (`kept >= 1`), sehingga tak pernah bisa mengklaim cakupan penuh
// (`base_seq == head+1`, satu-satunya status CURRENT menurut P2.7 rule 9).
// Modul ini me-render SELURUH riwayat kanonik [0, N) menjadi satu ringkasan —
// tanpa ekor — sehingga produsen P3.4 dapat menulis proyeksi CURRENT.
//
// Batas keras (kontrak ratifikasi P3_ROADMAP.md + HARD RULES P3.7):
//   - MURNI: tanpa SQL/fs/jaringan/LLM/random/clock/state. Input = baris +
//     policy; output = nilai. `built_at` milik primitif P2.7, BUKAN renderer.
//   - DERIVED-ONLY: tak menyentuh `messages`/proyeksi/event; tak memanggil
//     persistence/presentation/selector.
//   - CAKUPAN PENUH ATAU GAGAL: tiap baris sumber diproses dan dipertanggung-
//     jawabkan tepat satu baris ringkasan; baris hilang/tak-kontinu/tak-
//     didukung → throw eksplisit (jangan klaim CURRENT atas yang tak utuh).
//   - SATU baris ringkasan per SATU baris sumber: lines.length === rows.length
//     adalah bukti cakupan menurut konstruksi (bukan heuristik).
//   - Konvensi render mengikuti kernel (`compactLine`: awalan `- role:`, cap
//     400/200/80) agar konsisten lintas render; PERBEDAAN yang disengaja vs
//     kernel didokumentasikan di bawah (bagian dari semantik A+C P3.7):
//       * hasil tool non-error DI-RENDER (head 200 char), bukan `<result
//         omitted>` — full coverage mewajibkan tiap sekuens dipertanggung-
//         jawabkan; menghilangkan seluruh hasil tool akan melanggar §4.3
//         (tool side effects) kontrak ratifikasi.
//       * `reasoning` (bila ada) dipertahankan sebagai penanda head-capped,
//         bukan dibuang — ketidakpastian/penalaran adalah state bermakna.
//   - Teks akhir lewat `scrubSecrets` yang SUDAH ADA (tanpa scrub paralel).

import { contentToText, safeStringify } from "#minicore/core/tokens.ts"
import { scrubSecrets } from "../policy/scrub.ts"

/** Identitas versi renderer — bagian dari kontrak determinisme. */
export const FULL_HISTORY_FOLD_VERSION = "full-history-fold-v1"

/** Batas head per peran — selaras kernel agar konsisten lintas render. */
const HEAD_USER = 400
const HEAD_ASSISTANT = 400
const HEAD_TOOL = 200
const HEAD_TOOL_ARGS = 80
const HEAD_REASONING = 400

/** Baris sumber kanonik untuk fold (bentuk yang dipakai loader thread). */
export interface FoldSourceRow {
  readonly seq: number
  readonly message: unknown
}

/** Hasil fold cakupan-penuh — nilai murni, bukan baris DB. */
export interface FullHistoryFold {
  /** Teks ringkasan (sudah scrubSecrets; TANPA header — konsumen membungkus). */
  readonly summaryText: string
  /** Selalu == jumlah baris sumber (cakupan eksklusif [0, baseSeq)). */
  readonly baseSeq: number
  /** Selalu [[0, baseSeq]] — bentuk kanonik cakupan penuh. */
  readonly includedRanges: readonly (readonly [number, number])[]
  /** Jumlah baris sumber yang diproses. */
  readonly rowCount: number
  /** Jumlah baris ringkasan yang diemisikan (== rowCount menurut konstruksi). */
  readonly lineCount: number
  /** Identitas versi renderer yang menghasilkan output ini. */
  readonly policyVersion: typeof FULL_HISTORY_FOLD_VERSION
}

export class FoldError extends Error {
  readonly code = "FOLD_INVALID"
  constructor(detail: string) {
    super(`[fold] FOLD_INVALID: ${detail}`)
    this.name = "FoldError"
  }
}

function head(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

interface FoldMessageShape {
  role?: unknown
  content?: unknown
  toolCalls?: unknown
  toolCallId?: unknown
  name?: unknown
  reasoning?: unknown
  isError?: unknown
}

function asShape(value: unknown): FoldMessageShape {
  return (value ?? {}) as FoldMessageShape
}

/**
 * Render SATU baris kanonik menjadi SATU baris ringkasan. Throw FoldError untuk
 * peran/bentuk tak-didukung — pemanggil tak boleh menebak atau melewatkan diam.
 */
function foldLine(seq: number, message: unknown): string {
  const m = asShape(message)
  const role = m.role
  if (role === "user") {
    if (typeof m.content !== "string" && !Array.isArray(m.content))
      throw new FoldError(`seq ${seq}: user message without content`)
    return `- user [seq=${seq}]: ${head(contentToText(m.content as never), HEAD_USER)}`
  }
  if (role === "assistant") {
    if (typeof m.content !== "string" && !Array.isArray(m.content))
      throw new FoldError(`seq ${seq}: assistant message without content`)
    const calls = Array.isArray(m.toolCalls)
      ? (m.toolCalls as { name?: unknown; args?: unknown }[])
          .map((call) => {
            const name = typeof call?.name === "string" ? call.name : "unknown-tool"
            return `${name}(${head(safeStringify(call?.args), HEAD_TOOL_ARGS)})`
          })
          .join(", ")
      : ""
    const reasoning =
      typeof m.reasoning === "string" && m.reasoning.length > 0
        ? ` [reasoning: ${head(m.reasoning, HEAD_REASONING)}]`
        : ""
    return `- assistant [seq=${seq}]${calls ? ` [calls: ${calls}]` : ""}${reasoning}: ${head(
      contentToText(m.content as never),
      HEAD_ASSISTANT,
    )}`
  }
  if (role === "tool") {
    if (typeof m.name !== "string" || m.name.length === 0)
      throw new FoldError(`seq ${seq}: tool result without name`)
    if (typeof m.toolCallId !== "string" || m.toolCallId.length === 0)
      throw new FoldError(`seq ${seq}: tool result without toolCallId`)
    const content = m.content
    const text = typeof content === "string" ? content : safeStringify(content ?? null)
    const err = m.isError === true || m.isError === 1 ? " ERROR" : ""
    return `- tool(${m.name}) [seq=${seq} call=${m.toolCallId}]${err}: ${head(text, HEAD_TOOL)}`
  }
  throw new FoldError(`seq ${seq}: unsupported role ${JSON.stringify(role) ?? "?"}`)
}

/**
 * Render fold cakupan-penuh yang DETERMINISTIK atas SELURUH baris sumber.
 *
 * Kontrak (fail-closed):
 * - rows kosong → throw (tak ada yang bisa diklaim).
 * - seq harus tepat 0..N-1 kontinyu dan terurut — celah/duplikat/tak-urut →
 *   throw (seq tertinggi saja TIDAK membuktikan kontinuitas).
 * - tiap baris tepat satu baris ringkasan (lines.length === rows.length);
 *   peran/bentuk tak-didukung → throw (jangan lewatkan diam).
 * - teks akhir di-scrub via `scrubSecrets` yang SUDAH ADA.
 * - baseSeq SELALU == rows.length (cakupan [0, N) penuh).
 */
export function renderFullHistoryFold(rows: readonly FoldSourceRow[]): FullHistoryFold {
  if (rows.length === 0) throw new FoldError("empty source history — no full-coverage fold")
  for (let i = 0; i < rows.length; i++) {
    const got = rows[i]!.seq
    if (got !== i)
      throw new FoldError(
        `non-contiguous source seq at index ${i} (got ${String(got)}, want ${i}) — refusing partial claim`,
      )
  }
  const lines = rows.map((r) => foldLine(r.seq, r.message))
  if (lines.length !== rows.length)
    throw new FoldError("line/row count mismatch — refusing partial claim")
  const summaryText = scrubSecrets(lines.join("\n"))
  if (summaryText.length === 0) throw new FoldError("empty fold output — refusing partial claim")
  return {
    summaryText,
    baseSeq: rows.length,
    includedRanges: [[0, rows.length]] as readonly (readonly [number, number])[],
    rowCount: rows.length,
    lineCount: lines.length,
    policyVersion: FULL_HISTORY_FOLD_VERSION,
  }
}
