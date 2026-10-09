// P3.5 — Runtime Context Adapter (host-side metadata propagation + lifecycle bridge).
//
// Menutup dua celah yang diidentifikasi audit P3.5:
//
//   N1 — Runtime metadata propagation.
//   Pada batas seed runtime, hanya `ContextSelection.messages` yang disalin ke
//   `SessionConfig.initialMessages`; identity/frontier/revision/selectionBasis/
//   freshness/coverage/ModelContextProvenance tidak terbawa. Modul ini menyediakan
//   carrier metadata host-side (RAM, lifecycle-scoped) yang MENGANGKUT metadata itu
//   melewati batas seed — tanpa memasukkannya sebagai pesan model palsu.
//
//   N2 — Headless compaction bridge.
//   Jembatan durable `context.compacted` hanya ada di presentation adapter.
//   Sesi otonom yang dibuat lewat factory otonom (tanpa adapter) membuat event
//   `context:compacted` tetap in-memory sehingga revision undercount. Modul ini
//   menyediakan jembatan tipis yang MENGAMBIL event bus kernel dan menuliskannya
//   ke jalur durable YANG SUDAH ADA (appendPresentationEvents) — idempoten,
//   berpagar epoch bila epoch dipegang, tanpa store kedua.
//
// Batas keras (roadmap ratifikasi + HARD RULES):
//   - TANPA store/cache/sidecar baru; TANPA perubahan vendor/kernel; TANPA schema.
//   - TANPA tulis ke messages/turns/head/run/canonical history.
//   - TANPA fabricate revision; TANPA promosi UNKNOWN→fresh.
//   - ContextStore tetap buffer runtime; canonical tetap satu-satunya authority;
//     P3.1/P2.7 tetap batas publikasi.
//   - Satu-satunya tulis adapter = jembatan presentation-event yang SUDAH ADA
//     (saluran yang sama dipakai presentation adapter hari ini).
//
// Catatan jangkauan (audit §11): jalur anak delegate_task SUDAH di-bridge oleh
// presentation adapter anak (cli/index.ts memasang adapter + flush). Jembatan di
// sini HANYA untuk sesi tanpa presentation adapter (factory otonom / headless);
// memasangnya di jalur yang sudah punya adapter akan menggandakan marker.

import type { DomainEvent } from "../presentation/events.ts"
import type {
  ContextFreshness,
  ContextFrontier,
  ContextIdentity,
  ModelContextProvenance,
} from "./context-identity.ts"
import type { ContextSelection } from "./context-selector.ts"
import { appendPresentationEvents, presentationHead } from "./persistence.ts"

/**
 * Sumber event kompaksi kernel minimal — bentuk struktural yang dipenuhi baik
 * oleh EventBus kernel (`Session.events`) maupun `SubAgentSession.events`
 * (tanpa mengimpor kernel di modul ini; tanpa melebar ke tipe sesi penuh).
 */
export interface CompactionEventSource {
  on(type: "context:compacted", handler: (event: { reason?: unknown }) => void): () => void
}

/**
 * Metadata runtime yang dibawa melewati batas seed (host-side, RAM, lifecycle-
 * scoped). BUKAN store: objek ini hidup pada handle sesi; tidak diserialisasi,
 * tidak menjadi otoritas, tidak mengubah keputusan publikasi. Bila frontier tak
 * tersedia (seleksi kosong) → identity/frontier/provenance absen + freshness
 * unknown (jangan mengarang).
 */
export interface RuntimeContextMetadata {
  readonly sessionId: string
  readonly threadId: string
  /** Identitas view (dari frontier seleksi); null bila tak ada baris kanonik. */
  readonly identity: ContextIdentity | null
  /** Frontier view terpilih (provenance mengikat isi); null bila tak ada. */
  readonly frontier: ContextFrontier | null
  /**
   * Revisi kanonis yang diamati (dari frontier seleksi, atau canonicalRevision
   * bila frontier absen). Nilai observasi — TIDAK pernah di-fabricate.
   */
  readonly revision: number
  /** Basis pemilihan (dari seleksi). */
  readonly selectionBasis: string
  /** Kesegaran view (dari seleksi; unknown tetap unknown). */
  readonly freshness: ContextFreshness
  /** Cakupan ringkasan [0, coveredSeq); 0 = tanpa ringkasan. */
  readonly coveredSeq: number
  /** Provenance model-visible; absen bila frontier absen (jangan mengarang). */
  readonly provenance?: ModelContextProvenance
}

/**
 * Bangun metadata runtime dari ContextSelection. MURNI; tak menyentuh DB/runtime.
 * `canonicalRevision` = revisi kanonis yang diamati pemanggil (mis. dari
 * countDurableCompactions); dipakai HANYA bila frontier absen — bila frontier
 * ada, revision frontier yang dipakai (sumber tunggal, tak ditebak).
 */
export function runtimeMetadataFromSelection(
  selection: ContextSelection,
  canonicalRevision = 0,
): RuntimeContextMetadata {
  const frontier = selection.frontier
  const identity: ContextIdentity | null = frontier
    ? {
        sessionId: selection.sessionId,
        threadId: selection.threadId,
        baseSeq: frontier.baseSeq,
        anchorEventId: frontier.anchorEventId,
      }
    : null
  const provenance = provenanceFromSelection(selection)
  return {
    sessionId: selection.sessionId,
    threadId: selection.threadId,
    identity,
    frontier,
    revision: frontier?.revision ?? canonicalRevision,
    selectionBasis: selection.selectionBasis,
    freshness: selection.freshness,
    coveredSeq: selection.coveredSeq,
    ...(provenance !== undefined ? { provenance } : {}),
  }
}

/**
 * Bangun ModelContextProvenance dari ContextSelection (tipe P3.2 yang sudah ada —
 * sebelumnya TIDAK pernah dikonstruksi di mana pun; P3.5 mengisinya). Provenance
 * mencatat ASAL + transformasi; TIDAK memberi otoritas kanonik.
 *
 * Mengembalikan undefined bila frontier absen (tak ada yang bisa dibuktikan).
 * `projectionRevision` SENGAJA dibiarkan absen: ContextSelection tidak membawa
 * versi proyeksi berversi, dan kontrak P3.2 melarang mengarangnya.
 */
export function provenanceFromSelection(
  selection: ContextSelection,
): ModelContextProvenance | undefined {
  if (!selection.frontier) return undefined
  return {
    contextIdentity: {
      sessionId: selection.sessionId,
      threadId: selection.threadId,
      baseSeq: selection.frontier.baseSeq,
      anchorEventId: selection.frontier.anchorEventId,
    },
    canonicalFrontier: selection.frontier,
    selectionBasis: selection.selectionBasis,
  }
}

/**
 * Baca event_seq berikutnya untuk jalur jembatan (presentationHead + 1).
 * Baca-saja; memakai helper P2.11 yang SUDAH ADA (tanpa memuat seluruh riwayat
 * — murah untuk kompaksi yang jarang).
 */
export function nextPresentationEventSeq(sessionId: string, cwd?: string): number {
  return presentationHead(sessionId, cwd) + 1
}

/**
 * Jembatan kompaksi headless: tulis event durable `context.compacted` lewat
 * primitif yang SUDAH ADA (appendPresentationEvents — idempoten via dedup payload
 * identik, berpagar epoch, tabrakan payload-beda ditolak eksplisit). TIDAK
 * menulis kanonik; TIDAK membuat store kedua.
 *
 * Best-effort: kegagalan jembatan dilaporkan (stderr, konvensi src/session yang
 * sudah ada) dan TIDAK pernah menyentuh canonical history. `expectedEpoch`
 * opsional — bila absen, tulis tanpa pagar (sama seperti flush jalur yang tak
 * memegang epoch; mis. adapter anak di cli/index.ts yang juga unfenced).
 * `eventSeq`/`ts` opsional agar deterministik di test; produksi membiarkannya
 * dihitung (seq berikutnya; waktu saat tulis).
 */
export async function bridgeCompactionToDurable(opts: {
  sessionId: string
  cwd?: string
  expectedEpoch?: number
  reason: string
  turnId?: number
  ts?: number
  eventSeq?: number
}): Promise<{ bridged: boolean; detail: string }> {
  const event: DomainEvent = {
    type: "context.compacted",
    eventSeq: opts.eventSeq ?? nextPresentationEventSeq(opts.sessionId, opts.cwd),
    ts: opts.ts ?? Date.now(),
    sessionId: opts.sessionId,
    turnId: opts.turnId ?? 0,
    reason: typeof opts.reason === "string" ? opts.reason : "",
  }
  try {
    const stats = await appendPresentationEvents(
      opts.sessionId,
      opts.cwd,
      [event],
      opts.expectedEpoch !== undefined ? { expectedEpoch: opts.expectedEpoch } : undefined,
    )
    return {
      bridged: stats.written > 0,
      detail: `written=${stats.written} dup=${stats.duplicates} col=${stats.collisions}`,
    }
  } catch (e) {
    const detail = `context.compacted bridge failed: ${(e as Error).message}`
    process.stderr.write(`[warn] ${detail}\n`)
    return { bridged: false, detail }
  }
}

/**
 * Pasang jembatan kompaksi pada bus event sesi TANPA presentation adapter (jalur
 * otonom/headless). Berlangganan `context:compacted` dan menuliskan marker durable
 * via `bridgeCompactionToDurable`. Mengembalikan fungsi detach.
 *
 * Desain (mengapa begini):
 * - `epochOf` dievaluasi SAAT event tiba (bukan saat attach) supaya nilai epoch
 *   selalu terkini; kegagalan membaca epoch → tulis tanpa pagar (best-effort, sama
 *   seperti konvensi flush anak yang tak memegang epoch).
 * - `seq` dialokasikan dari SATU counter lokal yang di-seed presentationHead saat
 *   attach (bukan MAX+1 per event) supaya dua kompaksi berurutan tak berebut seq
 *   yang sama dalam satu proses; lintas-proses tetap aman via INSERT OR IGNORE +
 *   deteksi tabrakan primitif yang sudah ada.
 * - Handler TIDAK melempar (bus kernel mengisolasi error handler, tapi jembatan
 *   tetap fire-and-forget + catch agar tak ada efek samping ke turn).
 *
 * JANGAN pasang di sesi yang SUDAH punya presentation adapter (jalur anak
 * delegate_task di cli/index.ts) — marker akan ganda per kompaksi.
 */
export function attachHeadlessCompactionBridge(opts: {
  sessionId: string
  cwd?: string
  events: CompactionEventSource
  epochOf?: () => number | undefined
  turnIdOf?: () => number
}): () => void {
  let seq: number
  try {
    seq = nextPresentationEventSeq(opts.sessionId, opts.cwd)
  } catch {
    // Baca gagal = mulai dari 0; tulis pertama menentukan nasib (diterima atau
    // ditolak eksplisit oleh primitif). Jangan mengarang seq acak.
    seq = 0
  }
  const handler = (e: unknown): void => {
    const reason = (e as { reason?: unknown } | null | undefined)?.reason
    const reasonText = typeof reason === "string" ? reason : ""
    let expectedEpoch: number | undefined
    try {
      expectedEpoch = opts.epochOf?.()
    } catch {
      expectedEpoch = undefined
    }
    const eventSeq = seq++
    void bridgeCompactionToDurable({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      ...(expectedEpoch !== undefined ? { expectedEpoch } : {}),
      reason: reasonText,
      eventSeq,
      ...(opts.turnIdOf ? { turnId: opts.turnIdOf() } : {}),
    })
  }
  return opts.events.on("context:compacted", handler)
}
