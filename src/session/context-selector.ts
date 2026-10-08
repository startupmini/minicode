// P3.3 — Canonical Context Selector (derived, read-only, deterministic).
//
// Jawaban SATU pertanyaan: "Dari canonical state yang mana, dan dengan policy
// apa, view konteks runtime ini dibangun?" — tanpa menjadi otoritas baru.
//
// Model yang dikunci (mengikuti P3.3 architecture audit):
//
//   Canonical History (messages; AUTHORITY: persistence.ts)
//         │  read-only (rows SUDAH dimuat pemanggil; modul ini TANPA IO)
//         ▼
//   P3.2 Identity / Frontier / Freshness  (context-identity.ts — DESKRIPTIF)
//         │
//         ▼
//   P3.3 Selector  (modul ini — DERIVED, murni, deterministik)
//         │
//         ▼
//   ContextSelection  (RAM-only, provenance-bound)
//         │
//         ▼
//   Runtime Context (ContextStore)  [EXECUTION-LOCAL]
//         │
//         └─ publication → P3.1 decision + P2.7 safety (saveSession) → canonical
//
// Batas keras modul ini:
//   - TANPA IO. Tanpa SQLite/fs/jaringan, tanpa Date.now, tanpa random, tanpa
//     state modul yang memengaruhi hasil. Input = data yang sudah dimuat +
//     policy + budget; output = nilai murni.
//   - BACA-SAJA secara struktural: modul ini TIDAK mengimpor persistence.ts,
//     jadi ia tak mungkin menulis kanonik. Ia hanya mengimpor fungsi MURNI dari
//     context-identity.ts (P3.2) dan helper murni dari context-assembly.ts (P2.8).
//   - TIDAK ada store/cache/sidecar/DB milik selector (dilarang audit).
//   - TIDAK ada ranking semantik/embedding/LLM/jaringan (infrastructure, bukan
//     intelligence — audit §3).
//   - BUKAN decider: putusan publikasi tetap di saveSession (P2.7). Selector
//     MENYELEKSI & MENJELASKAN ("describe/project"), tidak "decide".
//
// Generalisasi seam P2.8 (assembleContext) menjadi selector sadar-budget yang
// membawa provenance, TANPA menduplikasi logika P2.8 (berbagi primitive).

import { estimateMessage, type TokenEstimator } from "#minicore/core/tokens.ts"
import type { Message } from "#minicore/core/types.ts"
import {
  boundaryIsSafe,
  type ContextOnlyArtifact,
  type ContextSource,
  syntheticSummaryMessage,
} from "./context-assembly.ts"
import {
  assessContextFreshness,
  type CanonicalEventRef,
  type ContextFreshness,
  type ContextFrontier,
  deriveContextFrontier,
  deriveHistoryCommit,
} from "./context-identity.ts"

/**
 * Basis pemilihan view — kontrak semantik (BUKAN string bebas). Persis satu
 * nilai per seleksi; menjelaskan ATAS DASAR APA view dibangun.
 *
 * - full-history     : seluruh baris kanonik muat budget; tanpa fold.
 * - summary-plus-tail: ringkasan proyeksi durable CURRENT atas [0,baseSeq) +
 *                      ekor kanonik [baseSeq, head].
 * - budget-tail      : ekor kanonik kontigu terbaru yang muat budget; prefix
 *                      lama DIJATUHKAN (tanpa ringkasan) — context-window
 *                      eviction, BUKAN fold/kompaksi.
 * - fallback-unknown : kesegaran/cakupan tak dapat dipastikan; view aman-terlebar
 *                      (histori kanonik penuh) + freshness eksplisit.
 */
export type SelectionBasis =
  | "full-history"
  | "summary-plus-tail"
  | "budget-tail"
  | "fallback-unknown"

const SELECTION_BASES: readonly SelectionBasis[] = [
  "full-history",
  "summary-plus-tail",
  "budget-tail",
  "fallback-unknown",
]

/** True bila string adalah SelectionBasis yang well-formed. */
export function isSelectionBasis(value: unknown): value is SelectionBasis {
  return typeof value === "string" && (SELECTION_BASES as readonly string[]).includes(value)
}

/** Semua nilai basis (beku) — dipakai test/validasi. */
export const ALL_SELECTION_BASES: readonly SelectionBasis[] = Object.freeze([...SELECTION_BASES])

/** Baris kanonik yang sudah dimuat (bentuk SAMA dengan P2.8 `loadThreadHistory`). */
export interface SelectableRow {
  readonly seq: number
  readonly message: unknown
}

/**
 * Adaptasi baris → ref kanonik P3.2 (menambahkan `seq` yang dibutuhkan hashing).
 * `message` dari loadThreadHistoryWithSeq adalah kernel Message (role/content/
 * toolCalls/reasoning/…); ref kanonik HANYA mengambil field durable yang mengikat
 * identitas — persis bentuk yang dipakai guard P3.1 `refsFromRows`.
 */
function toRef(row: SelectableRow): CanonicalEventRef {
  const m = (row.message ?? {}) as {
    role?: unknown
    content?: unknown
    toolCalls?: unknown
    toolCallId?: unknown
    name?: unknown
    reasoning?: unknown
    isError?: unknown
  }
  const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? null)
  const ref: {
    seq: number
    role: string
    content: string
    toolCalls?: string | null
    toolCallId?: string | null
    name?: string | null
    reasoning?: string | null
    isError?: number | boolean | null
  } = {
    seq: row.seq,
    role: typeof m.role === "string" ? m.role : "user",
    content,
  }
  if (m.toolCalls !== undefined) ref.toolCalls = JSON.stringify(m.toolCalls ?? null)
  if (m.toolCallId !== undefined) ref.toolCallId = (m.toolCallId as string | null) ?? null
  if (m.name !== undefined) ref.name = (m.name as string | null) ?? null
  if (m.reasoning !== undefined) ref.reasoning = (m.reasoning as string | null) ?? null
  if (m.isError !== undefined) ref.isError = m.isError as boolean | number | null
  return ref
}

/**
 * Publik: adaptasi baris selector → ref kanonik P3.2. Diekspor agar pemanggil
 * (composition root) bisa menurunkan frontier kanonis dari baris yang SAMA
 * untuk diteruskan sebagai `canonicalFrontier` — SATU adapter, tanpa duplikasi.
 */
export function rowsToCanonicalRefs(rows: readonly SelectableRow[]): CanonicalEventRef[] {
  return rows.map(toRef)
}

/**
 * Ringkasan proyeksi durable yang boleh dipakai selector. Pemanggil membacanya
 * (persistence.ts getProjection/getProjectionStatus) dan menyerahkannya HANYA
 * bila status CURRENT + boundary aman — selector TIDAK membaca DB sendiri.
 */
export interface ProjectionSummary {
  /** Cakupan eksklusif [0, baseSeq) yang diringkas. baseSeq > 0. */
  readonly baseSeq: number
  /** Teks ringkasan durable (bukan hasil generate selector). */
  readonly summaryText: string
}

/**
 * Kebijakan seleksi — input deterministik, tanpa state mutable. `budgetTokens`
 * adalah pagu token untuk BAGIAN PESAN saja (system+tools sudah dikurangkan
 * pemanggil; lihat `reservedForSystemAndTools` di output untuk transparansi).
 */
export interface SelectionPolicy {
  /** Pagu token untuk pesan terpilih (>= 0). */
  readonly budgetTokens: number
  /** Estimator token injeksi (default kernel chars/4) — sumber tunggal. */
  readonly estimator?: TokenEstimator
  /** Berapa token yang sudah dipesan untuk system+tools (bukti/diagnostik). */
  readonly reservedForSystemAndTools?: number
}

/**
 * Input selector — data kanonik yang SUDAH dimuat + policy + budget. Sengaja
 * TIDAK membawa handle persistence, session object, ContextStore, run, atau
 * epoch (modul ini murni & tak menyentuh state eksekusi).
 */
export interface SelectContextInput {
  readonly sessionId: string
  readonly threadId: string
  /** Baris kanonik thread ini (dari loadThreadHistoryWithSeq), urut seq. */
  readonly rows: readonly SelectableRow[]
  /** Revisi kanonis = cacah durable `context.compacted` (P3.2). */
  readonly revision: number
  /** Ringkasan proyeksi durable (opsional; hanya bila CURRENT + boundary aman). */
  readonly projection?: ProjectionSummary
  /** Kebijakan seleksi. */
  readonly policy: SelectionPolicy
  /**
   * Frontier kanonis SAAT INI (opsional) untuk menilai kesegaran view. Bila
   * `undefined` → view baru dinilai FRESH (dibangun dari kanonik saat ini).
   * Bila eksplisit `null` → UNKNOWN (kanonik tak dapat dibuktikan).
   */
  readonly canonicalFrontier?: ContextFrontier | null
}

/**
 * Akuntansi budget — LAPORAN, bukan keputusan. Memisahkan "benar" (selection
 * correctness) dari "muat" (budget feasibility).
 */
export interface SelectionBudgetReport {
  /** Pagu token untuk pesan (dari policy). */
  readonly limitTokens: number
  /** Estimasi token pesan terpilih. */
  readonly estimatedTokens: number
  /** Token yang pemanggil pesan untuk system+tools (diteruskan apa adanya). */
  readonly reservedForSystemAndTools: number
  /** True bila pesan terpilih muat dalam pagu. */
  readonly fits: boolean
}

/**
 * Hasil seleksi — nilai RAM murni (seperti ContextView P2.8: tak pernah
 * diserialisasi, tak pernah jadi otoritas resume). Membawa provenance yang
 * mengikat view ke isi kanonik eksak via `frontier.historyCommit`.
 */
export interface ContextSelection {
  /** Referensi identitas kanonik (bukan salinan). */
  readonly sessionId: string
  readonly threadId: string
  /**
   * Frontier view terpilih — mengikat cakupan + isi. `baseSeq` menandai batas
   * cakupan: 0 = histori penuh; > 0 = parsial. `null` hanya bila tak ada baris
   * kanonik (frontier kosong = UNKNOWN).
   */
  readonly frontier: ContextFrontier | null
  /** Materialisasi untuk di-seed ke ContextStore (appendAll). RAM-only. */
  readonly messages: Message[]
  /** Asal isi: "projection" (ada ringkasan) atau "messages" (murni kanonik). */
  readonly source: ContextSource
  /** Cakupan eksklusif yang diwakili ringkasan; 0 bila tak ada ringkasan. */
  readonly coveredSeq: number
  /** Basis pemilihan (kontrak semantik). */
  readonly selectionBasis: SelectionBasis
  /** Kesegaran view ini terhadap frontier kanonis (P3.2, deskriptif). */
  readonly freshness: ContextFreshness
  /** Materialisasi token/budget. */
  readonly budget: SelectionBudgetReport
  /** Kenapa basis ini dipilih / kenapa fallback. Diagnostik, bukan otoritas. */
  readonly detail: string
  /**
   * Artefak context-only (bila summary dipakai) yang WAJIB dibuang jalur persist
   * sebelum menulis kanonik (fingerprint P2.8; diteruskan apa adanya).
   */
  readonly contextOnly?: ContextOnlyArtifact
}

/** Estimator default = kernel chars/4, dipakai bila policy tak menyediakan. */
const defaultEstimator: TokenEstimator = (text: string) => Math.ceil(text.length / 4)

function sumTokens(messages: readonly Message[], est: TokenEstimator): number {
  let total = 0
  for (const m of messages) total += estimateMessage(m, est)
  return total
}

/**
 * Batas cakupan parsial yang aman: mulai `rawBaseSeq`, geser NAIK sampai batas
 * aman (tidak memisahkan pasangan assistant(toolCalls)/tool-result). Batas sah
 * ada di [1, head] — P3.2 `deriveContextFrontier` menolak baseSeq > head
 * ("view is never inverted"), jadi cakupan PENUH P2.8 (base_seq == head+1)
 * DICAP ke head (ringkasan [0,head) + ekor [head]; tetap valid & lengkap).
 * Deterministis; tanpa heuristik.
 *
 * Mengembalikan baseSeq final; 0 = cakupan penuh (mundur aman-terlebar bila
 * tak ada batas aman). rawBaseSeq <= 0 juga 0.
 */
export function safeBaseSeq(rows: readonly SelectableRow[], rawBaseSeq: number): number {
  if (rawBaseSeq <= 0) return 0
  if (rows.length === 0) return 0
  const head = rows[rows.length - 1]!.seq
  // Cap ke head: base_seq == head+1 (cakupan penuh P2.8) tetap representable
  // sebagai ringkasan [0,head) + ekor [head].
  let boundary = Math.min(rawBaseSeq, head)
  while (boundary >= 1 && boundary <= head) {
    if (boundaryIsSafe(rows as { seq: number; message: unknown }[], boundary)) return boundary
    boundary++
  }
  return 0
}

/** Bangun frontier + materialisasi atas cakupan [baseSeq, head]. */
function coverageOf(
  input: SelectContextInput,
  rows: readonly SelectableRow[],
  baseSeq: number,
): { frontier: ContextFrontier; messages: Message[] } {
  const covered = baseSeq <= 0 ? rows : rows.filter((r) => r.seq >= baseSeq)
  const headRow = rows[rows.length - 1]!
  const frontier = deriveContextFrontier({
    sessionId: input.sessionId,
    threadId: input.threadId,
    baseSeq,
    head: toRef(headRow),
    revision: input.revision,
    historyCommit: deriveHistoryCommit(covered.map(toRef)),
  })
  return { frontier, messages: covered.map((r) => r.message as Message) }
}

/**
 * Kesegaran view terhadap frontier kanonis. Bila pemanggil tak memberi frontier
 * (`undefined`), view yang baru dibangun dari kanonik saat ini = FRESH. Bila
 * eksplisit `null` → UNKNOWN. Selain itu delegasi ke semantik P3.2.
 */
function selectionFreshness(
  view: ContextFrontier,
  canonical: ContextFrontier | null | undefined,
): ContextFreshness {
  if (canonical === undefined) return "fresh"
  if (canonical === null) return "unknown"
  return assessContextFreshness(view, canonical)
}

/**
 * SELECTOR INTI. MURNI + DETERMINISTIK: input tak dimutasi, tanpa IO.
 *
 * Urutan strategi (audit §7):
 *   1. summary-plus-tail — ringkasan durable [0,B) + ekor [B, head] (bila aman)
 *   2. fallback-unknown  — view kanonik penuh + label jujur (DIVERGED/UNKNOWN)
 *   3. full-history      — histori kanonik penuh bila muat budget
 *   4. budget-tail       — ekor kanonik terbaru yang muat budget
 */
export function selectContext(input: SelectContextInput): ContextSelection {
  const est = input.policy.estimator ?? defaultEstimator
  const reserved = input.policy.reservedForSystemAndTools ?? 0
  const limit = Math.max(0, Math.floor(input.policy.budgetTokens))
  const rows = input.rows

  const report = (msgs: readonly Message[]): SelectionBudgetReport => {
    const estimated = sumTokens(msgs, est)
    return {
      limitTokens: limit,
      estimatedTokens: estimated,
      reservedForSystemAndTools: reserved,
      fits: estimated <= limit,
    }
  }

  // ── Kosong: frontier null = UNKNOWN (P3.2) ─────────────────────────────────
  if (rows.length === 0) {
    return Object.freeze({
      sessionId: input.sessionId,
      threadId: input.threadId,
      frontier: null,
      messages: [] as Message[],
      source: "messages" as ContextSource,
      coveredSeq: 0,
      selectionBasis: "fallback-unknown" as SelectionBasis,
      freshness: "unknown" as ContextFreshness,
      budget: report([]),
      detail: "empty canonical history (no rows); frontier null = UNKNOWN",
    })
  }

  const headSeq = rows[rows.length - 1]!.seq

  // ── Strategi 1: summary-plus-tail ──────────────────────────────────────────
  if (input.projection && input.projection.baseSeq > 0) {
    const b = safeBaseSeq(rows, input.projection.baseSeq)
    const summaryText = input.projection.summaryText
    if (b > 0 && typeof summaryText === "string" && summaryText.length > 0) {
      const { frontier, messages: tail } = coverageOf(input, rows, b)
      const synthetic = syntheticSummaryMessage(summaryText, b)
      const msgs: Message[] = [synthetic, ...tail]
      const artifact: ContextOnlyArtifact = { role: "user", content: synthetic.content as string }
      return Object.freeze({
        sessionId: input.sessionId,
        threadId: input.threadId,
        frontier,
        messages: msgs,
        source: "projection" as ContextSource,
        coveredSeq: b,
        selectionBasis: "summary-plus-tail" as SelectionBasis,
        freshness: selectionFreshness(frontier, input.canonicalFrontier),
        budget: report(msgs),
        detail: `durable summary covers [0,${b}) + canonical tail [${b},${headSeq}]`,
        contextOnly: artifact,
      })
    }
    // batas tak aman / ringkasan kosong → lanjut sebagai histori kanonik penuh.
  }

  const full = coverageOf(input, rows, 0)
  const fullFreshness = selectionFreshness(full.frontier, input.canonicalFrontier)

  // ── Strategi 2: fallback-unknown (STALE/DIVERGED/UNKNOWN) ──────────────────
  // N3: baris BASI (view di belakang kanonis) TIDAK boleh dilabeli
  // "full-history" — label itu menyiratkan representasi kanonik yang trusted,
  // padahal view ini tak memutakhirkan diri ke head kanonis. Pakai
  // `fallback-unknown` (state yang sudah ada; bukan basis kelima yang baru).
  // Coverage completeness (semua baris tersedia diikutkan) ≠ freshness/trust.
  if (fullFreshness === "unknown" || fullFreshness === "diverged" || fullFreshness === "stale") {
    return Object.freeze({
      sessionId: input.sessionId,
      threadId: input.threadId,
      frontier: full.frontier,
      messages: full.messages,
      source: "messages" as ContextSource,
      coveredSeq: 0,
      selectionBasis: "fallback-unknown" as SelectionBasis,
      freshness: fullFreshness,
      budget: report(full.messages),
      detail: `canonical freshness vs supplied frontier = ${fullFreshness}; full rows present but labeled untrusted (not full-history)`,
    })
  }

  // ── Strategi 3: full-history (muat budget) ─────────────────────────────────
  const fullTokens = sumTokens(full.messages, est)
  if (fullTokens <= limit) {
    return Object.freeze({
      sessionId: input.sessionId,
      threadId: input.threadId,
      frontier: full.frontier,
      messages: full.messages,
      source: "messages" as ContextSource,
      coveredSeq: 0,
      selectionBasis: "full-history" as SelectionBasis,
      freshness: fullFreshness,
      budget: report(full.messages),
      detail: `full canonical history fits budget (${fullTokens} <= ${limit})`,
    })
  }

  // ── Strategi 4: budget-tail (ekor kontigu terbaru yang muat) ────────────────
  const boundaryRows = rows as unknown as { seq: number; message: unknown }[]
  let acc = 0
  let firstKeptIdx = rows.length // tak ada yang muat
  for (let i = rows.length - 1; i >= 0; i--) {
    const one = estimateMessage(rows[i]!.message as Message, est)
    if (acc + one > limit) break
    acc += one
    firstKeptIdx = i
  }
  if (firstKeptIdx >= rows.length) {
    return Object.freeze({
      sessionId: input.sessionId,
      threadId: input.threadId,
      frontier: full.frontier,
      messages: [] as Message[],
      source: "messages" as ContextSource,
      coveredSeq: 0,
      selectionBasis: "budget-tail" as SelectionBasis,
      freshness: fullFreshness,
      budget: {
        limitTokens: limit,
        estimatedTokens: 0,
        reservedForSystemAndTools: reserved,
        // Bahkan satu pesan tak muat: view kosong, namun konten yang
        // diminta TIDAK muat → fits=false (jujur; ini eviction, bukan sukses).
        fits: false,
      },
      detail: `insufficient budget: even one message exceeds ${limit} tokens; empty view (honest)`,
    })
  }
  // Batas aman: geser NAIK hanya MENYUSUT segmen (tetap <= budget).
  let safeBase = rows[firstKeptIdx]!.seq
  while (safeBase <= headSeq) {
    if (boundaryIsSafe(boundaryRows, safeBase)) break
    safeBase++
  }
  const selectedRows = safeBase > headSeq ? [] : rows.filter((r) => r.seq >= safeBase)
  const tailMsgs = selectedRows.map((r) => r.message as Message)
  const baseForFrontier = safeBase > headSeq ? headSeq : safeBase
  const frontier = coverageOf(input, rows, baseForFrontier).frontier
  const fresh = selectionFreshness(frontier, input.canonicalFrontier)
  // N2: bila batas-aman menggeser segmen sampai KOSONG (segmen budget tak dapat
  // diwakili tanpa memisahkan pasangan tool), view kosong TIDAK boleh melaporkan
  // fits=true — konten yang diminta tidak dapat direpresentasikan. `fits=false`
  // (eviction jujur, sejalan dengan cabang insufficient-budget di atas).
  if (tailMsgs.length === 0) {
    return Object.freeze({
      sessionId: input.sessionId,
      threadId: input.threadId,
      frontier,
      messages: [] as Message[],
      source: "messages" as ContextSource,
      coveredSeq: 0,
      selectionBasis: "budget-tail" as SelectionBasis,
      freshness: fresh,
      budget: {
        limitTokens: limit,
        estimatedTokens: 0,
        reservedForSystemAndTools: reserved,
        fits: false,
      },
      detail: `budget-tail empty: safe boundary shift left no representable segment (${limit} tokens); eviction, NOT a fold`,
    })
  }
  return Object.freeze({
    sessionId: input.sessionId,
    threadId: input.threadId,
    frontier,
    messages: tailMsgs,
    source: "messages" as ContextSource,
    coveredSeq: 0,
    selectionBasis: "budget-tail" as SelectionBasis,
    freshness: fresh,
    budget: report(tailMsgs),
    detail: `budget-tail from seq ${baseForFrontier} (${sumTokens(tailMsgs, est)} <= ${limit}); prefix dropped = eviction, NOT a fold`,
  })
}
