// P3.2 — Context Identity + Frontier: formal, deterministik, terekonstruksi.
//
// Menjawab SATU pertanyaan: "Context ini adalah view dari canonical state
// yang mana?" — tanpa menjadikan Context authority baru. Model yang dikunci:
//
//   SESSION = durable canonical reality (SQLite messages/turns +
//             presentation_events + jurnal; PK (session_id, seq))
//   CONTEXT = deterministic view/query terhadap canonical reality
//   MODEL   = temporary consumer
//
// Modul ini MURNI (tanpa IO, tanpa Date.now, tanpa random, tanpa state
// modul yang memengaruhi hasil): canonical facts yang sama + selector yang
// sama + revisi yang sama = identity/frontier yang sama, di proses mana pun.
//
// Yang SENGAJA tidak ada di sini (batas scope P3.2):
// - second persistence store / sidecar / cache kanonis baru (dilarang);
// - selector P3.3, projection cache P3.4, adapter runtime P3.5, resume P3.6,
//   compaction P3.7, paging P3.8, branch/fork penuh P3.9, RAG P3.11;
// - run_id / model / provider / prompt fingerprint / RAG hit / buffer runtime
//   di dalam identity (eksplisit ditolak — lihat AGENT_PRESENTATION_
//   ARCHITECTURE_V2_1.md: run_id redundan dengan (sessionId, turnId)).
//
// Lapisan: src/session (host). Tidak mengimpor src/ui, cli, atau #minicore,
// tidak menyentuh vendor — ContextStore kernel tetap satu-satunya buffer
// runtime, modul ini hanya menurunkannya secara deterministik.

import { createHash } from "node:crypto"

/** Prefix anchor event. BUKAN uniqueness source; hanya namespace tampilan. */
export const CONTEXT_ANCHOR_PREFIX = "ctxev_"

/** Thread default sebelum semantik branch/fork penuh (P3.9). */
export const MAIN_THREAD_ID = "main"

/** Status kesegaran context terhadap canonical frontier. BUKAN boolean. */
export type ContextFreshness = "fresh" | "stale" | "diverged" | "unknown"

/** Hasil perbandingan dua frontier. Tanpa timestamp, tanpa run_id. */
export type ContextFrontierRelation = "EQUAL" | "A_AHEAD" | "B_AHEAD" | "DIVERGED" | "UNKNOWN"

/**
 * Referensi event kanonis — bentuk baris durable `messages` (lihat
 * loadSession di persistence.ts:656-685). `content` di sini adalah nilai
 * TERSIMPAN (sudah safeContent/scrub/cap saat tulis), bukan objek runtime:
 * hanya dari sanalah anchor stabil lintas replay/restart.
 */
export interface CanonicalEventRef {
  seq: number
  role: string
  content: string
  toolCalls?: string | null
  toolCallId?: string | null
  name?: string | null
  reasoning?: string | null
  isError?: number | boolean | null
}

/**
 * IDENTITY — "view dari canonical state yang mana".
 * session_id + thread_id + base_seq + anchor_event_id. TANPA run_id, model,
 * provider, fingerprint, RAG hit, atau buffer runtime.
 */
export interface ContextIdentity {
  readonly sessionId: string
  readonly threadId: string
  readonly baseSeq: number
  readonly anchorEventId: string
}

/**
 * FRONTIER — posisi deterministik view di dalam canonical history.
 * baseSeq/headSeq = cakupan view; anchorEventId = jangkar konten di head;
 * lastSeen* = frontier kanonis saat view dibangun (pada selector penuh =
 * head; pada selector parsial P3.3 nanti bisa berbeda — dibedakan eksplisit,
 * bukan dua nama untuk hal yang sama); revision = ruang-sekuens kanonis
 * (jumlah durable `context.compacted`; naik tepat saat canonical ditulis
 * ulang oleh kompaksi — lihat D3); historyCommit = komitmen atas SELURUH
 * isi yang dicakup view (bukan hanya head — tanpa ini, rewrite tengah
 * N→N panjang-sama ala bug F-05 tak terdeteksi: endpoint sama, isi beda).
 */
export interface ContextFrontier extends ContextIdentity {
  readonly headSeq: number
  readonly lastSeenSeq: number
  readonly lastSeenEventId: string
  readonly revision: number
  readonly historyCommit: string
}

/** Namespace derivasi (ganti bila skema anchor berubah → id baru eksplisit). */
const ANCHOR_NAMESPACE = "p32-context-anchor-v1:"

/** Pola anchor valid: prefix + 32 hex (berbeda bentuk dari id alokasi M1). */
const ANCHOR_RE = /^ctxev_[0-9a-f]{32}$/

/** Pola komitmen histori valid: namespace sendiri, bukan event id. */
const HISTORY_COMMIT_RE = /^ctxhist_[0-9a-f]{32}$/

/** True bila string adalah anchor event P3.2 yang well-formed. */
export function isAnchorEventId(value: unknown): value is string {
  return typeof value === "string" && ANCHOR_RE.test(value)
}

/** True bila string adalah komitmen histori P3.2 yang well-formed. */
export function isHistoryCommit(value: unknown): value is string {
  return typeof value === "string" && HISTORY_COMMIT_RE.test(value)
}

function assertSeq(seq: unknown, field: string): asserts seq is number {
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0)
    throw new Error(
      `context-identity: ${field} must be a non-negative integer (got ${String(seq)})`,
    )
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`context-identity: ${field} is required (never guess identity)`)
}

/**
 * Serialisasi kanonis SATU baris durable untuk hashing. Urutan field tetap
 * dan null dinormalisasi eksplisit supaya baris yang "sama secara kanonis"
 * selalu menghasilkan string yang sama (Replay stability / test C).
 */
function canonicalEventKey(ref: CanonicalEventRef): string {
  assertSeq(ref.seq, "ref.seq")
  if (typeof ref.role !== "string" || typeof ref.content !== "string")
    throw new Error("context-identity: ref.role and ref.content must be strings (durable form)")
  return JSON.stringify([
    ref.seq,
    ref.role,
    ref.content,
    ref.toolCalls ?? null,
    ref.toolCallId ?? null,
    ref.name ?? null,
    ref.reasoning ?? null,
    ref.isError == null ? null : ref.isError === true || ref.isError === 1 ? 1 : 0,
  ])
}

/**
 * Turunkan anchor stabil untuk SATU event kanonis. Mengikat session + thread
 * + seq + ISI kanonis: seq sama tapi isi/session/thread berbeda = anchor
 * berbeda (Identity != Sequence). Sama canonical = sama anchor pada setiap
 * load/restart/replay — tanpa storage, tanpa runtime state.
 */
export function deriveAnchorEventId(
  sessionId: string,
  threadId: string,
  ref: CanonicalEventRef,
): string {
  assertNonEmptyString(sessionId, "sessionId")
  assertNonEmptyString(threadId, "threadId")
  const digest = createHash("sha256")
    .update(`${ANCHOR_NAMESPACE}${sessionId}:${threadId}:${canonicalEventKey(ref)}`)
    .digest("hex")
    .slice(0, 32)
  return `${CONTEXT_ANCHOR_PREFIX}${digest}`
}

/** Turunkan identity view dari posisi base + event jangkar di head. */
export function deriveContextIdentity(input: {
  sessionId: string
  threadId?: string
  baseSeq: number
  head: CanonicalEventRef
}): ContextIdentity {
  assertNonEmptyString(input.sessionId, "sessionId")
  const threadId = input.threadId ?? MAIN_THREAD_ID
  assertNonEmptyString(threadId, "threadId")
  assertSeq(input.baseSeq, "baseSeq")
  if (input.baseSeq > input.head.seq)
    throw new Error("context-identity: baseSeq must not exceed head seq (view is never inverted)")
  return Object.freeze({
    sessionId: input.sessionId,
    threadId,
    baseSeq: input.baseSeq,
    anchorEventId: deriveAnchorEventId(input.sessionId, threadId, input.head),
  })
}

/**
 * Komitmen deterministik atas SELURUH baris yang dicakup satu view, dalam
 * urutan seq. Mengikat isi (via canonicalEventKey per baris yang sudah
 * mengikat session+thread+seq+isi), bukan hanya endpoint: dua canonical yang
 * berbeda di tengah (rewrite N→N) menghasilkan commit berbeda walau base,
 * head, dan anchor head-nya sama. Input kosong → throw (canonical kosong
 * direpresentasikan sebagai frontier null, bukan commit kosong).
 */
export function deriveHistoryCommit(rows: readonly CanonicalEventRef[]): string {
  if (rows.length === 0)
    throw new Error("context-identity: cannot commit to an empty history (use null frontier)")
  const hash = createHash("sha256")
  hash.update("p32-context-history-v1:")
  const sorted = [...rows].sort((a, b) => a.seq - b.seq)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.seq <= sorted[i - 1]!.seq)
      throw new Error(
        `context-identity: duplicate/non-monotonic seq ${sorted[i]!.seq} (canonical corrupt — refusing to guess)`,
      )
  }
  for (const r of sorted) hash.update(`|${canonicalEventKey(r)}`)
  return `ctxhist_${hash.digest("hex").slice(0, 32)}`
}

/** Turunkan frontier lengkap: cakupan view + last-seen + revisi kanonis. */
export function deriveContextFrontier(input: {
  sessionId: string
  threadId?: string
  baseSeq: number
  head: CanonicalEventRef
  lastSeen?: CanonicalEventRef
  revision: number
  /** Komitmen isi cakupan view (deriveHistoryCommit atas baris yang dicakup). */
  historyCommit: string
}): ContextFrontier {
  const identity = deriveContextIdentity(input)
  assertSeq(input.head.seq, "head.seq")
  if (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 0)
    throw new Error("context-identity: revision must be a non-negative integer (compaction count)")
  if (!isHistoryCommit(input.historyCommit))
    throw new Error("context-identity: historyCommit is required (never guess content)")
  const lastSeen = input.lastSeen ?? input.head
  return Object.freeze({
    ...identity,
    headSeq: input.head.seq,
    lastSeenSeq: lastSeen.seq,
    lastSeenEventId: deriveAnchorEventId(identity.sessionId, identity.threadId, lastSeen),
    revision: input.revision,
    historyCommit: input.historyCommit,
  })
}

/**
 * Rekonstruksi frontier dari durable rows saja (tanpa ContextStore runtime,
 * tanpa memori proses, tanpa invocasi model). Rows boleh tak terurut —
 * diurutkan stabil berdasarkan seq; seq duplikat = canonical korup → throw
 * (fail-closed, jangan tebak). Rows kosong → null (belum ada jangkar;
 * pemanggil memperlakukannya sebagai UNKNOWN, bukan error).
 */
export function deriveFrontierFromDurable(input: {
  sessionId: string
  threadId?: string
  rows: readonly CanonicalEventRef[]
  revision: number
}): ContextFrontier | null {
  assertNonEmptyString(input.sessionId, "sessionId")
  if (input.rows.length === 0) return null
  const sorted = [...input.rows].sort((a, b) => a.seq - b.seq)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.seq <= sorted[i - 1]!.seq)
      throw new Error(
        `context-identity: duplicate/non-monotonic seq ${sorted[i]!.seq} (canonical corrupt — refusing to guess)`,
      )
  }
  const base = sorted[0]!
  const head = sorted[sorted.length - 1]!
  return deriveContextFrontier({
    sessionId: input.sessionId,
    threadId: input.threadId,
    baseSeq: base.seq,
    head,
    revision: input.revision,
    historyCommit: deriveHistoryCommit(sorted),
  })
}

/** Type guard untuk frontier dari sumber tak terpercaya (mis. JSON). */
export function isContextFrontier(value: unknown): value is ContextFrontier {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.sessionId === "string" &&
    v.sessionId.length > 0 &&
    typeof v.threadId === "string" &&
    v.threadId.length > 0 &&
    typeof v.baseSeq === "number" &&
    Number.isInteger(v.baseSeq) &&
    v.baseSeq >= 0 &&
    isAnchorEventId(v.anchorEventId) &&
    typeof v.headSeq === "number" &&
    Number.isInteger(v.headSeq) &&
    v.headSeq >= 0 &&
    typeof v.lastSeenSeq === "number" &&
    Number.isInteger(v.lastSeenSeq) &&
    v.lastSeenSeq >= 0 &&
    isAnchorEventId(v.lastSeenEventId) &&
    typeof v.revision === "number" &&
    Number.isInteger(v.revision) &&
    (v.revision as number) >= 0 &&
    isHistoryCommit(v.historyCommit)
  )
}

/**
 * Perbandingan frontier deterministik — TANPA timestamp, TANPA
 * Date.now/object-identity/index-array/posisi-prompt/run_id.
 * - session berbeda = UNKNOWN (tak ada basis bersama);
 * - thread berbeda dalam session sama = DIVERGED (tabrakan terdeteksi);
 * - revisi berbeda = DIVERGED (ruang sekuens ditulis ulang — kompaksi;
 *   perbandingan posisional tak bermakna, jangan diam-diam reconcile);
 * - revisi sama: semua sama (termasuk historyCommit) = EQUAL; head beda =
 *   A_AHEAD/B_AHEAD; head sama tapi identitas/isi beda = DIVERGED (posisi
 *   sama, event berbeda — termasuk base view berbeda pada head yang sama:
 *   view parsial tak pernah disamakan dengan view penuh — dan termasuk
 *   rewrite tengah N→N: commit beda walau endpoint sama).
 */
export function compareContextFrontier(
  a: ContextFrontier | null | undefined,
  b: ContextFrontier | null | undefined,
): ContextFrontierRelation {
  if (!isContextFrontier(a) || !isContextFrontier(b)) return "UNKNOWN"
  if (a.sessionId !== b.sessionId) return "UNKNOWN"
  if (a.threadId !== b.threadId) return "DIVERGED"
  if (a.revision !== b.revision) return "DIVERGED"
  if (
    a.baseSeq === b.baseSeq &&
    a.headSeq === b.headSeq &&
    a.anchorEventId === b.anchorEventId &&
    a.historyCommit === b.historyCommit
  )
    return "EQUAL"
  if (a.headSeq !== b.headSeq) return a.headSeq > b.headSeq ? "A_AHEAD" : "B_AHEAD"
  return "DIVERGED"
}

/**
 * Status kesegaran SATU context terhadap frontier kanonis saat ini.
 * Context TIDAK PERNAH otomatis menjadi kanonis hanya karena stale:
 * STALE = pemanggil harus membangun ulang dari canonical; DIVERGED/UNKNOWN
 * = dilarang menulis diam-diam maupun reconcile diam-diam.
 * - revisi context < kanonis = DIVERGED (canonical ditulis ulang di bawahnya);
 * - revisi context > kanonis = UNKNOWN (klaim dari masa depan — invalid);
 * - revisi sama: head+anchor sama = FRESH bila isi cakupan SAMA terbukti
 *   (base sama + historyCommit sama) atau bila base berbeda (perbedaan
 *   selector P3.3 — kesegaran soal head, bukan cakupan); base sama tapi
 *   historyCommit beda = DIVERGED (rewrite tengah tanpa revisi — anomali
 *   tulis yang tak boleh dibaca sebagai fresh);
 *   canonical di depan = STALE; context melampaui canonical = UNKNOWN;
 *   head sama anchor beda = DIVERGED.
 */
export function assessContextFreshness(
  context: ContextFrontier | null | undefined,
  canonical: ContextFrontier | null | undefined,
): ContextFreshness {
  if (!isContextFrontier(context) || !isContextFrontier(canonical)) return "unknown"
  if (context.sessionId !== canonical.sessionId || context.threadId !== canonical.threadId)
    return "unknown"
  if (context.revision < canonical.revision) return "diverged"
  if (context.revision > canonical.revision) return "unknown"
  if (context.headSeq === canonical.headSeq) {
    if (context.anchorEventId !== canonical.anchorEventId) return "diverged"
    if (context.baseSeq === canonical.baseSeq && context.historyCommit !== canonical.historyCommit)
      return "diverged"
    return "fresh"
  }
  return context.headSeq < canonical.headSeq ? "stale" : "unknown"
}

/**
 * Derivasikan revisi kanonis dari daftar event durable: jumlah event
 * `context.compacted` yang durable+replayable (events.ts DURABILITY).
 * Jembatan kernel `context:compacted` → durable `context.compacted` ada di
 * adapter.ts:951-957, jadi setiap kompaksi loop/recovery meninggalkan satu
 * marker durable — kecuali jalur yang tak memasang adapter (headless tanpa
 * presentation): revisi undercount di sana adalah seam P3.5, bukan angka
 * yang boleh ditebak di sini (fail-closed: hitung yang durable saja).
 */
export function countDurableCompactions(events: readonly { readonly type: string }[]): number {
  let count = 0
  for (const e of events) {
    if (e.type === "context.compacted") count++
  }
  return count
}

/**
 * Provenance minimal untuk model-visible context (kontrak Fase 10 — TIPE
 * SAJA, tanpa assembly: assembly penuh = P3.3 selector + P3.11 RAG).
 * selectionBasis mendokumentasikan ATAS DASAR APA view dipilih
 * ("full-history" hari ini; P3.3 merumuskan sisanya); projectionRevision
 * hanya diisi bila proyeksi berversi benar-benar ada (jangan dikarang).
 */
export interface ModelContextProvenance {
  readonly contextIdentity: ContextIdentity
  readonly canonicalFrontier: ContextFrontier
  readonly selectionBasis: string
  readonly projectionRevision?: number
}
