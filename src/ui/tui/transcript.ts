// Transkrip TUI — kolektor append-only event bus menjadi baris logis.
//
// Kenapa kelas sendiri: App butuh sumber kebenaran tunggal untuk viewport
// (paint, scroll, resize) yang terpisah dari pengambilan input. Menyimpan
// baris LOGIS (tanpa wrap) supaya resize me-wrap ulang saat paint — lebar
// terminal dibaca saat paint, bukan saat event (kontrak I11).
//
// Mode compact saja di Fase 1: teks model mengalir, ledger tool satu baris
// `  › nama target` (grammar sama dengan REPL), error merah satu baris.
import type {
  PresentationPolicy,
  UiBus,
  UiPresentationActivity,
  UiPresentationEvent,
  UiPresentationSnapshot,
  UiToolStatus,
} from "../contract.ts"
import { t } from "../i18n/locale.ts"
import { renderActivityPanel } from "../render/activity-panel.ts"
import { paintLedger, runMarker, statusWord } from "../render/ledger.ts"
import { parseFence, renderInline } from "../render/markdown.ts"
import { type MarkdownTable, parseMarkdownBlocks } from "../render/markdown-table.ts"
import { sanitizeAnsi, sanitizeAnsiLine, stripSgr } from "../render/sanitize.ts"
import { renderMarkdownTable } from "../render/table-grid.ts"
import { c, glyphs } from "../render/theme.ts"
import { displayWidth, truncateToWidth, wrapByWidth } from "../render/width.ts"
import { defaultUiState, type UiSessionState } from "../session-state.ts"

/** Cap memori: baris logis tertua dibuang diam-diam (kontrak I12). */
// Catatan retention (K.7): ini cap TAMPILAN transkrip. Berbeda dan sengaja tak
// sama dengan MAX_STATE_ENTRIES=4096 di presentation/model.ts yang membatasi
// reducer presentasi (state durable/resume) — dua lapis retention berbeda untuk
// substansi berbeda (viewport vs riwayat yang bisa di-replay).
export const TRANSCRIPT_CAP = 5000
export const TRANSCRIPT_TEXT_MAX_CHARS = 1_000_000
/** Baris pending lebih panjang dari ini tidak dimemo (kunci = isi baris). */
const PENDING_MEMO_LINE_MAX = 4096
/** Batas entri memo proyeksi pending sebelum dibuang seluruhnya. */
const PENDING_MEMO_MAX_ENTRIES = 4000
/** Baris thinking yang terlihat di area live (Fase 3). */
const MAX_THINKING_ROWS = 10
const TRANSCRIPT_TRUNCATION_MARKER = "… [transcript truncated: turn cap exceeded]"
/**
 * Sink approval TUI: pemilik layar (cli/tui.ts) mendaftarkan transkrip +
 * repaint + suspend/resume agar prompt persetujuan tercatat di transkrip dan
 * terlihat SEBELUM user menjawab. Suspend selama askLine menunggu jawaban:
 * tanpa ini listener App + repaint live (stream/PgUp) berlomba dengan
 * askLine — prompt tak terlihat, user mengetik buta. Tanpa sink
 * (one-shot/exec/headless) approval memakai tulis langsung warisan.
 * Satu layer (src/ui) sehingga impor aman dari siklus.
 */
export interface ApprovalSink {
  pushBlock(lines: string[]): void
  repaint(): void
  suspend(): void
  resume(): void
}

let approvalSink: ApprovalSink | null = null

export function setApprovalSink(sink: ApprovalSink | null): void {
  approvalSink = sink
}

export function getApprovalSink(): ApprovalSink | null {
  return approvalSink
}

export interface TranscriptMeta {
  seq?: number
  kind: "user" | "assistant" | "activity" | "approval" | "system" | "diagnostic"
  turnId?: number
  toolCallId?: string
  approvalId?: string
  status?: UiToolStatus
  expandRef?: { toolCallId: string; idx: number }
  table?: MarkdownTable
}

export interface TranscriptOptions {
  getSnapshot?: () => UiPresentationSnapshot | null
  onPresentationEvent?: (handler: (event: UiPresentationEvent) => void) => () => void
  /** Kebijakan kanonik dari composition root; absen = logika inline legacy. */
  policy?: PresentationPolicy
  maxPendingChars?: number
  /**
   * [Area A · PROMPT 06] State UI milik SESI ini (visibility reasoning).
   * Absen = instance default modul. Permukaan produksi wajib mengoper state
   * sesinya supaya dua sesi dalam satu proses tak saling menimpa.
   */
  uiState?: UiSessionState
}

export interface TranscriptPoint {
  id: number
  offset: number
}

export interface TranscriptRow {
  text: string
  sourceId: number
  sourceStart: number
  sourceEnd: number
  displayStart: number
  displayEnd: number
  selectable: boolean
}

export interface TranscriptViewport {
  rows: TranscriptRow[]
  firstIndex: number
  totalRows: number
}

/** P2.2: hasil proyeksi satu baris logis + input yang memengaruhinya. */
interface ProjectedLineCache {
  width: number
  id: number
  raw: string
  assistant: boolean
  source: string
  prefix: string
  table: MarkdownTable | null
  fenceState: FenceState
  rows: TranscriptRow[]
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}

type FenceState = "outside" | "inside" | "boundary"

function renderAssistantLine(line: string, fenceState: FenceState): string | null {
  if (fenceState === "boundary") return null
  if (fenceState === "inside") return line
  if (!/(?:\*{1,2}|`|^#{1,6}\s|~~|\[[^\]]+\]\()/.test(line)) return line
  const heading = /^(#{1,6})\s+(.*)$/.exec(line)
  if (heading) return c.bold(renderInline(heading[2] ?? ""))
  return renderInline(line)
}

/**
 * Rapikan hanya whitespace presentasi jawaban model: hapus baris kosong di
 * tepi dan batasi jeda berulang di luar fenced code. Isi code fence tetap
 * literal karena spasi dan baris kosong di dalamnya adalah bagian contoh.
 */
function normalizeAssistantOutput(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  let openFence: { char: string; len: number } | null = null
  for (const line of lines) {
    const fence = parseFence(line)
    if (openFence) {
      out.push(line)
      if (fence && fence.char === openFence.char && fence.len >= openFence.len) openFence = null
      continue
    }
    if (fence) {
      openFence = fence
      out.push(line)
      continue
    }
    if (!line.trim()) {
      if (out.length && out[out.length - 1] !== "") out.push("")
      continue
    }
    out.push(line)
  }
  // Jika fence belum ditutup, baris kosong di ekor masih bagian dari contoh
  // kode dan harus tetap literal. Hanya whitespace di luar fence yang dirapatkan.
  if (!openFence) while (out.length && out[out.length - 1] === "") out.pop()
  return out.join("\n")
}

let selectionSegmenter: Intl.Segmenter | undefined

function offsetAtColumn(text: string, start: number, end: number, column: number): number {
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(end, text.length))
  const target = Math.max(0, column)
  let used = 0
  try {
    selectionSegmenter ??= new Intl.Segmenter("und", { granularity: "grapheme" })
    for (const part of selectionSegmenter.segment(text.slice(from, to))) {
      const width = displayWidth(part.segment)
      if (target <= used + width / 2) return from + part.index
      used += width
      if (target <= used) return from + part.index + part.segment.length
    }
  } catch {
    for (const part of text.slice(from, to)) {
      const width = displayWidth(part)
      if (target <= used + width / 2) return from + text.indexOf(part, from)
      used += width
      if (target <= used) return from + text.indexOf(part, from) + part.length
    }
  }
  return to
}

export class Transcript {
  private lines: string[] = []
  private tables: (MarkdownTable | null)[] = []
  /**
   * P2.2: cache proyeksi PER BARIS logis. Transkrip append-only, jadi baris
   * lama tidak perlu di-wrap/markdown ulang setiap frame. Cache di-key oleh
   * semua input yang memengaruhi hasil (width, teks, source, prefix, tabel,
   * fence state) dan dibuang saat eviction (index bergeser) atau clear.
   */
  private rowCache = new Map<number, ProjectedLineCache>()
  private ids: number[] = []
  private sourcePrefixes: string[] = []
  private sourceTexts = new Map<number, string>()
  private sourceOrders = new Map<number, number>()
  private assistantDisplay = new Map<number, string | null>()
  private nextId = 1
  private nextOrder = 1
  private pending = ""
  private pendingTruncated = false
  private activeProviderAttempt: {
    id: number
    pendingLength: number
    pendingTruncated: boolean
  } | null = null
  private maxPendingChars: number
  /** Hitung monotonik baris yang pernah ditambah — basis indikator "baru"
   * yang kebal evict cap 5000 (size() menyusut saat tertua dibuang). */
  private totalAppended = 0
  /** Thinking terakumulasi (tersanitasi). Minimized: penanda hidup;
   * expanded: mengalir redup seperti teks. */
  private thinkingBuf = ""
  private thinkingTail = ""
  /** Baris thinking turn berjalan (mode AREA, Fase 3): dirender sebagai blok
   * live maks 10 baris, bukan di-commit per baris. Diringkas saat turn selesai. */
  private thinkingArea: string[] = []
  private meta: TranscriptMeta[] = []
  private evicted = 0
  private hasEvictMarker = false
  private getSnapshot: (() => UiPresentationSnapshot | null) | undefined
  private policy: PresentationPolicy | undefined
  // [Area A · PROMPT 06] State UI sesi ini; default = instance modul.
  private uiState: UiSessionState
  private presentationUnsub: (() => void) | null = null
  private presentedTerminals = new Set<string>()
  private presentedVerifications = new Set<string>()
  private summarizedTurns = new Set<number>()
  /** Lipat aktivitas (minimizeActivity): baris ledger per-tool ditahan dulu,
   * lalu saat turn selesai dirangkum jadi SATU baris (opencode-like) + detail
   * di-buffer untuk /expand. */
  private activityFold: { name: string; status: string; line: string }[] = []
  private unsubs: (() => void)[] = []
  /**
   * Fase 1 perf (butir 2): memo daftar activity "running". Snapshot presentasi
   * kini stabil antar-event (cache di composition root), jadi filter
   * `status === "running"` tak perlu diulang tiap paint — cukup sekali per
   * snapshot. Key = identitas objek snapshot.
   */
  private runningMemo: {
    snapshot: UiPresentationSnapshot
    running: UiPresentationActivity[]
  } | null = null
  /**
   * Fase 1 perf (butir 3): cache proyeksi baris. Proyeksi sudah punya
   * `rowCache` per baris logis, tetapi `projectAll` tetap membangun ulang array
   * seluruh baris visual + parseFence + parse markdown `pending` pada tiap
   * paint (ketikan/scroll), meski isinya tak berubah. Cache di bawah menghindari
   * kerja itu: baris ter-commit di-cache per (width, totalAppended), pending
   * per (width, pendingVersion, truncated).
   */
  private committedProjection: {
    width: number
    totalAppended: number
    rows: TranscriptRow[]
  } | null = null
  private pendingProjection: {
    width: number
    version: number
    truncated: boolean
    rows: TranscriptRow[]
  } | null = null
  /**
   * Fase 1 perf (lanjutan): cache gabungan committed+pending — bagian O(N)
   * dari `projectAll`. Saat thinking/running kosong (kasus idle ketik/scroll,
   * mayoritas paint), hasil ini dikembalikan APA ADANYA tanpa salinan, sehingga
   * `[...committed, ...pending]` tak diulang O(N) tiap keystroke saat transkrip
   * sudah menumpuk. Di-invalidate oleh sinyal yang sama dengan dua cache di atas.
   */
  private projectedBase: {
    width: number
    totalAppended: number
    pendingVersion: number
    pendingTruncated: boolean
    rows: TranscriptRow[]
  } | null = null
  /** Naik setiap `this.pending` berubah (stream/commit/invalidated/clear). */
  private pendingVersion = 0

  constructor(bus: UiBus, opts: TranscriptOptions = {}) {
    this.getSnapshot = opts.getSnapshot
    this.policy = opts.policy
    this.uiState = opts.uiState ?? defaultUiState
    this.maxPendingChars = Math.max(1, opts.maxPendingChars ?? TRANSCRIPT_TEXT_MAX_CHARS)
    // Gagal subscribe = transcript mati total; biarkan throw (fail-closed).
    this.unsubs = [
      bus.on("provider:text", (e: { text: string }) => this.stream(e.text)),
      bus.on("turn:started", () => {
        this.commit()
        this.commitThinking()
        this.activityFold = []
      }),
      bus.on("turn:completed", () => {
        this.commit()
        this.commitThinking()
      }),
      bus.on("execution:started", () => {
        this.commit()
        this.commitThinking()
      }),
      bus.on("provider:extension", (e: { kind: string; data: unknown }) => this.extension(e)),
      bus.on("context:compacted", (e: { reason: string }) =>
        this.push(c.muted(t("ts.compacted", { reason: sanitizeAnsiLine(e.reason ?? "") }))),
      ),
    ]
    if (opts.onPresentationEvent) {
      this.presentationUnsub = opts.onPresentationEvent((event) => this.presentationEvent(event))
    }
  }

  /** Teks model mengalir — ditahan sebagai ekor hidup sampai commit. */
  stream(text: string): void {
    if (!text) return
    this.commitThinking()
    const remaining = this.maxPendingChars - this.pending.length
    if (remaining <= 0) {
      this.pendingTruncated = true
      return
    }
    if (text.length <= remaining) {
      this.pending += text
      this.pendingVersion++
      return
    }
    let keep = text.slice(0, remaining)
    const last = keep.charCodeAt(keep.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) keep = keep.slice(0, -1)
    this.pending += keep
    this.pendingVersion++
    this.pendingTruncated = true
  }

  /** Chunk reasoning (`provider:extension` kind reasoning, data {text}). */
  extension(e: { kind: string; data: unknown }): void {
    if (e.kind === "minicode:attempt") {
      const data = e.data as {
        phase?: unknown
        attemptId?: unknown
        hadVisibleOutput?: unknown
      } | null
      const id = data?.attemptId
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return
      if (data?.phase === "started") {
        this.activeProviderAttempt = {
          id,
          pendingLength: this.pending.length,
          pendingTruncated: this.pendingTruncated,
        }
      } else if (data?.phase === "completed") {
        if (this.activeProviderAttempt?.id === id) this.activeProviderAttempt = null
      } else if (data?.phase === "invalidated" && this.activeProviderAttempt?.id === id) {
        this.pending = this.pending.slice(0, this.activeProviderAttempt.pendingLength)
        this.pendingVersion++
        this.pendingTruncated = this.activeProviderAttempt.pendingTruncated
        this.activeProviderAttempt = null
        // Reasoning dari attempt yang gagal tidak boleh tertinggal sebagai
        // konten aktif/collapsible. Baris reasoning yang sudah dipaint tetap
        // diberi marker append-only di bawah.
        this.thinkingBuf = ""
        this.thinkingTail = ""
        this.thinkingArea = []
        if (data.hadVisibleOutput === true) {
          this.push(c.warning(t("ts.providerAttemptDiscarded", { attempt: id })), {
            kind: "diagnostic",
          })
        }
      }
      return
    }
    if (e.kind !== "reasoning") return
    const text = (e.data as { text?: string } | null)?.text ?? ""
    if (!text) return
    const clean = sanitizeAnsi(text)
    if (this.uiState.reasoningVisible) {
      if (this.thinkingAreaMode()) {
        // Mode AREA (Fase 3): tahan baris di buffer, dirender sebagai blok live
        // terbatas (projectAll). JANGAN di-commit per baris — area yang
        // menggantikannya + ringkasan saat turn selesai.
        this.thinkingTail += clean
        const parts = this.thinkingTail.split("\n")
        for (let i = 0; i < parts.length - 1; i++) this.thinkingArea.push(parts[i] ?? "")
        // Batasi memori; detail penuh sudah dipangkas per turn saat ringkasan.
        if (this.thinkingArea.length > 2000)
          this.thinkingArea.splice(0, this.thinkingArea.length - 2000)
        this.thinkingTail = parts[parts.length - 1] ?? ""
      } else {
        // Legacy (panel off): alir per baris dengan indentasi 2 kolom
        // (line-buffered, ekor hidup) — membedakan thinking dari jawaban model.
        this.thinkingTail += clean
        const parts = this.thinkingTail.split("\n")
        for (let i = 0; i < parts.length - 1; i++)
          this.append(c.thinking(`  ${parts[i] ?? ""}`), { kind: "diagnostic" })

        this.thinkingTail = parts[parts.length - 1] ?? ""
      }
    } else {
      // Minimized: penanda hidup; isi disimpan di collapsed view linear.
      this.thinkingBuf = (this.thinkingBuf + clean).slice(-20000)
    }
  }

  /** Mode area thinking aktif? Panel aktivitas ON + reasoning terlihat.
   * Panel off = perilaku legacy (stream per baris) agar `/fold` benar-benar
   * mengembalikan tampilan mentah. */
  private thinkingAreaMode(): boolean {
    return this.uiState.reasoningVisible && this.uiState.activityPanel
  }

  /** Selesaikan fase thinking.
   * - Mode area: ringkas jadi SATU baris (detail penuh di `/expand`).
   * - Legacy: flush ekor berindentasi.
   * - Minimized: penanda hilang. */
  private commitThinking(): void {
    if (this.thinkingAreaMode()) {
      const lines = [...this.thinkingArea]
      if (this.thinkingTail) {
        lines.push(this.thinkingTail)
        this.thinkingTail = ""
      }
      this.thinkingArea = []
      this.thinkingBuf = ""
      if (lines.length > 0) {
        // Detail penuh tidak hilang: masuk buffer `/expand`.
        this.uiState.rememberCollapsedSection("thinking", lines.join("\n"))
        this.append(
          c.thinking(`  + ${t("panel.thinking")} · ${t("panel.lines", { n: lines.length })}`),
          { kind: "diagnostic" },
        )
      }
      return
    }
    if (this.thinkingTail) {
      this.append(c.thinking(`  ${this.thinkingTail}`), { kind: "diagnostic" })
      this.thinkingTail = ""
    }
    this.thinkingBuf = ""
    this.thinkingArea = []
  }

  /** Dorong baris logis (sudah final, mis. gema prompt user). */
  push(line: string, meta: TranscriptMeta = { kind: "system" }): void {
    this.commit()
    this.append(line, meta)
  }

  /** Gema prompt user ala shell: `minicode › baris-1`, lanjutan menjorok. */
  pushUser(prompt: string): void {
    const rows = sanitizeAnsi(prompt).split("\n")
    const [first, ...rest] = rows
    this.commit()
    this.appendWithSource(
      `${c.accent("minicode")} ${c.muted("›")} ${first ?? ""}`,
      { kind: "user" },
      first ?? "",
      "minicode › ",
    )
    for (const r of rest) this.appendWithSource(`  ${r}`, { kind: "user" }, r, "  · ")
  }

  pushError(message: string): void {
    this.push(c.error(sanitizeAnsiLine(message)), { kind: "diagnostic" })
  }

  pushInfo(lines: string[]): void {
    this.commit()
    if (lines.length === 0) return
    const blocks = parseMarkdownBlocks(sanitizeAnsi(lines.join("\n")))
    if (blocks.length === 0) {
      for (const line of lines) this.append(line)
      return
    }
    for (const block of blocks) {
      if (block.type === "table") this.appendTable(block.table, { kind: "system" })
      else {
        for (const line of block.text.split("\n")) this.append(line)
      }
    }
  }

  /** Kosongkan transkrip (`/clear`): viewport kembali ke layar kosong. */
  clear(): void {
    this.lines = []
    this.rowCache.clear()
    this.pendingRowMemo.clear()
    this.tables = []
    this.ids = []
    this.sourcePrefixes = []
    this.sourceTexts.clear()
    this.sourceOrders.clear()
    this.assistantDisplay.clear()
    this.nextId = 1
    this.nextOrder = 1
    this.meta = []
    this.pending = ""
    this.pendingTruncated = false
    this.activeProviderAttempt = null
    this.thinkingBuf = ""
    this.thinkingTail = ""
    this.thinkingArea = []
    this.evicted = 0
    this.hasEvictMarker = false
    this.runningMemo = null
    this.committedProjection = null
    this.pendingProjection = null
    this.projectedBase = null
    this.pendingVersion = 0
    this.presentedTerminals.clear()
    this.presentedVerifications.clear()
    this.summarizedTurns.clear()
    this.activityFold = []
  }

  /** Jumlah baris logis (untuk test; bukan API paint). */
  size(): number {
    return this.lines.length + (this.pending ? 1 : 0)
  }

  /** Total baris logis yang pernah ditambah (monotonik, kebal evict cap). */
  total(): number {
    return this.totalAppended + (this.pending ? 1 : 0)
  }

  private projectText(
    text: string,
    sourceText: string,
    sourceId: number,
    width: number,
    selectable: boolean,
    sourcePrefix = "",
    markdown = false,
    fenceState: FenceState = "outside",
  ): TranscriptRow[] {
    const w = Math.max(10, width)
    const renderedLines = text.split("\n")
    const sourceLines = sourceText.split("\n")
    const out: TranscriptRow[] = []
    let sourceBase = 0
    for (let lineIndex = 0; lineIndex < renderedLines.length; lineIndex++) {
      const raw = renderedLines[lineIndex] ?? ""
      const source = sourceLines[lineIndex] ?? stripSgr(sanitizeAnsi(raw))
      let rendered: string | null
      if (!markdown) rendered = raw
      else if (sourceId >= 0 && this.assistantDisplay.has(sourceId))
        rendered = this.assistantDisplay.get(sourceId)!
      else {
        rendered = renderAssistantLine(raw, fenceState)
        if (sourceId >= 0) this.assistantDisplay.set(sourceId, rendered)
      }
      if (rendered === null) {
        sourceBase += source.length + 1
        continue
      }
      const renderedRows = rendered === "" ? [""] : wrapByWidth(rendered, w)
      const sourceRows = sourcePrefix || source ? wrapByWidth(`${sourcePrefix}${source}`, w) : [""]
      let offset = sourceBase
      const count = Math.max(renderedRows.length, sourceRows.length)
      for (let rowIndex = 0; rowIndex < count; rowIndex++) {
        const renderedRow = renderedRows[rowIndex] ?? ""
        const rawSourceRow = sourceRows[rowIndex] ?? ""
        const sourceRow =
          sourcePrefix && rowIndex === 0 && rawSourceRow.startsWith(sourcePrefix)
            ? rawSourceRow.slice(sourcePrefix.length)
            : rawSourceRow
        out.push({
          text: renderedRow,
          sourceId: selectable ? sourceId : -1,
          sourceStart: offset,
          sourceEnd: offset + sourceRow.length,
          displayStart: 0,
          displayEnd: displayWidth(renderedRow),
          selectable: selectable && sourceId >= 0,
        })
        offset += sourceRow.length
      }
      sourceBase += source.length + 1
    }
    return out
  }

  private projectTable(table: MarkdownTable, sourceId: number, width: number): TranscriptRow[] {
    const rendered = renderMarkdownTable(table, Math.max(1, width), renderInline)
    if (!rendered) return []
    const renderedRows = rendered.split("\n")
    const logicalRows = [table.headers, ...table.rows].map((row) => row.join("\t"))
    const ranges: Array<{ start: number; end: number }> = []
    let base = 0
    for (const row of logicalRows) {
      ranges.push({ start: base, end: base + row.length })
      base += row.length + 1
    }
    const plainRows = renderedRows.map((row) => stripSgr(sanitizeAnsi(row)))
    const horizontal = plainRows.some((row) => /^[\s─━┌┐└┘├┤┬┴┼]+$/.test(row))
    const fields = Math.max(1, table.headers.length)
    let logicalIndex = 0
    return renderedRows.map((row, index) => {
      const plain = plainRows[index] ?? ""
      const isBorder = /^[\s─━┌┐└┘├┤┬┴┼]+$/.test(plain)
      let range = ranges[0] ?? { start: 0, end: 0 }
      if (horizontal) {
        if (!isBorder) range = ranges[logicalIndex] ?? range
        if (!isBorder) logicalIndex++
      } else {
        const dataIndex = table.rows.length === 0 ? 0 : Math.floor(index / fields) + 1
        range = ranges[dataIndex] ?? range
      }
      return {
        text: row,
        sourceId: isBorder ? -1 : sourceId,
        sourceStart: range.start,
        sourceEnd: range.end,
        displayStart: 0,
        displayEnd: displayWidth(row),
        selectable: !isBorder && sourceId >= 0,
      }
    })
  }

  /**
   * Pelacak code fence per aliran teks: baris DI DALAM fence tidak kena
   * render markdown (kode harus literal). Marker pembuka/penutup sendiri
   * juga dilewati agar state tetap sinkron dengan decorateMarkdown.
   */
  private fenceTracker(): (line: string) => FenceState {
    let open = false
    let char = ""
    let len = 0
    return (line: string): FenceState => {
      const fence = parseFence(line)
      if (!open && fence) {
        open = true
        char = fence.char
        len = fence.len
        return "boundary"
      }
      if (open && fence && fence.char === char && fence.len >= len) {
        open = false
        return "boundary"
      }
      return open ? "inside" : "outside"
    }
  }

  /** Baris live area thinking (mode area): header `+ berpikir` + maks 10 baris
   * visual terakhir dari turn berjalan. Baris panjang dibungkus (bukan
   * dipotong). Kosong bila mode area off / belum ada thinking. */
  private thinkingRows(w: number): TranscriptRow[] {
    if (!this.thinkingAreaMode()) return []
    const logical = [...this.thinkingArea]
    if (this.thinkingTail) logical.push(this.thinkingTail)
    if (logical.length === 0) return []
    const visual: string[] = []
    for (const line of logical) {
      if (line === "") visual.push("")
      else visual.push(...wrapByWidth(line, w))
    }
    const shown = visual.slice(-MAX_THINKING_ROWS)
    const hidden = visual.length - shown.length
    const out: TranscriptRow[] = []
    const push = (raw: string) => {
      out.push({
        text: c.thinking(raw),
        sourceId: -1,
        sourceStart: 0,
        sourceEnd: 0,
        displayStart: 0,
        displayEnd: displayWidth(raw),
        selectable: false,
      })
    }
    push(
      hidden > 0
        ? `  + ${t("panel.thinking")} · ${t("panel.moreLines", { n: hidden })}`
        : `  + ${t("panel.thinking")}`,
    )
    for (const row of shown) push(`  ${row}`)
    return out
  }

  /** Proyeksi panel aktivitas (Fase 2): baris grup dari tool TURN BERJALAN.
   * Sumber = `activityFold` (dikumpulkan per turn oleh event tool), BUKAN
   * snapshot sesi — snapshot bersifat kumulatif sampai cap, jadi akan
   * menampilkan tool dari turn lama. Kosong bila panel off / belum ada tool. */
  private panelRows(): TranscriptRow[] {
    if (!this.uiState.activityPanel) return []
    if (this.activityFold.length === 0) return []
    const activities = this.activityFold.map((e) => ({
      toolCallId: "",
      name: e.name,
      status: e.status as UiToolStatus,
      tsStart: 0,
    }))
    const lines = renderActivityPanel(activities, { maxRows: 10 })
    return lines.map((line) => ({
      text: line,
      sourceId: -1,
      sourceStart: 0,
      sourceEnd: 0,
      displayStart: 0,
      displayEnd: displayWidth(line),
      selectable: false,
    }))
  }

  private projectAll(width: number): TranscriptRow[] {
    const w = Math.max(10, width)
    const thinking = this.thinkingRows(w)
    const running = this.runningRows()
    const panel = this.panelRows()
    // Kasus umum (idle ketik/scroll — thinking tau cara running kosong):
    // kembalikan gabungan committed+pending yang ter-cache TANPA menyalin ulang.
    // Ini memberantas biaya concat O(N) pada setiap paint (biaya yang TUMBUH
    // seiring transkrip menumpuk — tepat gejala "mengetik berat saat history penuh").
    if (!this.thinkingTail && thinking.length === 0 && running.length === 0 && panel.length === 0) {
      if (
        this.projectedBase &&
        this.projectedBase.width === w &&
        this.projectedBase.totalAppended === this.totalAppended &&
        this.projectedBase.pendingVersion === this.pendingVersion &&
        this.projectedBase.pendingTruncated === this.pendingTruncated
      ) {
        return this.projectedBase.rows
      }
      const base: TranscriptRow[] = [...this.committedRows(w), ...this.pendingRows(w)]
      this.projectedBase = {
        width: w,
        totalAppended: this.totalAppended,
        pendingVersion: this.pendingVersion,
        pendingTruncated: this.pendingTruncated,
        rows: base,
      }
      return base
    }
    // thinking/running aktif: bangun segar (jarang — hanya saat turn berjalan,
    // dan repaint-nya sudah dicoalesce 30ms, bukan per-keypress).
    const rows: TranscriptRow[] = [...this.committedRows(w), ...this.pendingRows(w)]
    if (!this.thinkingAreaMode() && this.thinkingTail) {
      for (const chunk of this.thinkingTail.split("\n")) {
        const chunkRows = chunk === "" ? [""] : wrapByWidth(chunk, w)
        for (const row of chunkRows) {
          rows.push({
            text: c.thinking(row),
            sourceId: -1,
            sourceStart: 0,
            sourceEnd: 0,
            displayStart: 0,
            displayEnd: displayWidth(row),
            selectable: false,
          })
        }
      }
    }
    // Area thinking (Fase 3): blok live maks 10 baris terakhir (mode area).
    // Mode legacy sudah menaruh thinking-nya di atas (stream per baris).
    rows.push(...thinking)
    // Baris tool yang SEDANG berjalan (dari snapshot). Panel aktivitas hanya
    // memuat tool TERMINAL (fold), jadi running tetap punya barisnya sendiri —
    // tak ada duplikasi, dan tool yang belum selesai tidak pernah hilang.
    for (const row of running) {
      rows.push({
        text: row,
        sourceId: -1,
        sourceStart: 0,
        sourceEnd: 0,
        displayStart: 0,
        displayEnd: displayWidth(row),
        selectable: false,
      })
    }
    // Panel aktivitas (Fase 2): baris grup tool terminal — tampil di bawah
    // running, di atas transkrip. Hanya saat ada activity.
    rows.push(...panel)
    return rows
  }

  /** Proyeksi baris ter-commit (Fase 1 perf butir 3). Di-cache per (width,
   * totalAppended): totalAppended monotonik dan hanya naik saat baris baru
   * masuk/evict, jadi paint idle (ketik/scroll) tidak mengulang iterasi 5000
   * baris + parseFence. Cache disamakan objeknya, hasil dipakai read-only. */
  private committedRows(w: number): TranscriptRow[] {
    if (
      this.committedProjection &&
      this.committedProjection.width === w &&
      this.committedProjection.totalAppended === this.totalAppended
    ) {
      return this.committedProjection.rows
    }
    const rows: TranscriptRow[] = []
    const committedFence = this.fenceTracker()
    for (let i = 0; i < this.lines.length; i++) {
      const table = this.tables[i] ?? null
      const id = this.ids[i] ?? -1
      const raw = this.lines[i] ?? ""
      const assistant = this.meta[i]?.kind === "assistant"
      const fenceState = assistant ? committedFence(raw) : "outside"
      const source = this.sourceTexts.get(id) ?? ""
      const prefix = this.sourcePrefixes[i] ?? ""
      const cached = this.rowCache.get(i)
      if (
        cached &&
        cached.width === w &&
        cached.id === id &&
        cached.raw === raw &&
        cached.assistant === assistant &&
        cached.source === source &&
        cached.prefix === prefix &&
        cached.table === table &&
        cached.fenceState === fenceState
      ) {
        rows.push(...cached.rows)
        continue
      }
      const produced = table
        ? this.projectTable(table, id, w)
        : this.projectText(raw, source, id, w, true, prefix, assistant, fenceState)
      this.rowCache.set(i, {
        width: w,
        id,
        raw,
        assistant,
        source,
        prefix,
        table,
        fenceState,
        rows: produced,
      })
      rows.push(...produced)
    }
    this.committedProjection = { width: w, totalAppended: this.totalAppended, rows }
    return rows
  }

  /**
   * Memo proyeksi baris pending, dikunci isi baris (bukan indeks).
   *
   * Cache `pendingProjection` lama hanya valid per `pendingVersion`, dan versi
   * itu naik SETIAP delta — jadi tiap paint memproyeksikan ulang seluruh
   * jawaban. Biayanya O(pending) per frame → total O(n²) per turn (audit
   * 2026-11-12, CRITICAL-1): terukur 295 ms/frame pada 200 KB dan 1,4 dtk/
   * frame pada batas 1 MB. Mayoritas baris saat streaming sudah final, jadi
   * proyeksi per baris dimemo: yang tumbuh hanya baris terakhir.
   *
   * Dikunci juga `w` dan fenceState karena keduanya mengubah hasil proyeksi.
   * Baris sangat panjang tidak dimemo (kuncinya akan sebesar barisnya sendiri).
   */
  private pendingRowMemo = new Map<string, TranscriptRow[]>()

  /** Proyeksi `pending` (jawaban streaming) + marker truncasi. Di-cache per
   * (width, pendingVersion, truncated) untuk hasil total; proyeksi per baris
   * dimemo terpisah agar delta baru tidak memaksa kerja ulang penuh. */
  private pendingRows(w: number): TranscriptRow[] {
    if (!this.pending) {
      this.pendingProjection = null
      this.pendingRowMemo.clear()
      return []
    }
    if (
      this.pendingProjection &&
      this.pendingProjection.width === w &&
      this.pendingProjection.version === this.pendingVersion &&
      this.pendingProjection.truncated === this.pendingTruncated
    ) {
      return this.pendingProjection.rows
    }
    const rows: TranscriptRow[] = []
    const pendingFence = this.fenceTracker()
    const pending = normalizeAssistantOutput(sanitizeAnsi(this.pending))
    if (pending) {
      for (const block of parseMarkdownBlocks(pending)) {
        if (block.type === "table") rows.push(...this.projectTable(block.table, -1, w))
        else
          for (const line of block.text.split("\n")) {
            const fenceState = pendingFence(line)
            const memoKey =
              line.length <= PENDING_MEMO_LINE_MAX ? `${w}\u0000${fenceState}\u0000${line}` : null
            const memo = memoKey === null ? undefined : this.pendingRowMemo.get(memoKey)
            if (memo) {
              rows.push(...memo)
              continue
            }
            const clean = stripSgr(sanitizeAnsi(line))
            const produced = this.projectText(line, clean, -1, w, false, "", true, fenceState)
            if (memoKey !== null) {
              // Batas sederhana: memo adalah cache tampilan, bukan struktur
              // data — dibuang seluruhnya saat terlalu besar.
              if (this.pendingRowMemo.size >= PENDING_MEMO_MAX_ENTRIES) this.pendingRowMemo.clear()
              this.pendingRowMemo.set(memoKey, produced)
            }
            rows.push(...produced)
          }
      }
    }
    if (this.pendingTruncated) {
      rows.push({
        text: c.muted(TRANSCRIPT_TRUNCATION_MARKER),
        sourceId: -1,
        sourceStart: 0,
        sourceEnd: 0,
        displayStart: 0,
        displayEnd: displayWidth(TRANSCRIPT_TRUNCATION_MARKER),
        selectable: false,
      })
    }
    this.pendingProjection = {
      width: w,
      version: this.pendingVersion,
      truncated: this.pendingTruncated,
      rows,
    }
    return rows
  }

  wrappedLength(width: number): number {
    return this.projectAll(width).length
  }

  viewport(width: number, height: number, scrollBack: number): TranscriptViewport {
    const wrapped = this.projectAll(width)
    const safeHeight = Math.max(1, Math.floor(height))
    const back = Math.max(0, Math.min(scrollBack, Math.max(0, wrapped.length - safeHeight)))
    const firstIndex = Math.max(0, wrapped.length - back - safeHeight)
    const rows = wrapped.slice(firstIndex, firstIndex + safeHeight)
    while (rows.length < safeHeight) {
      rows.unshift({
        text: "",
        sourceId: -1,
        sourceStart: 0,
        sourceEnd: 0,
        displayStart: 0,
        displayEnd: 0,
        selectable: false,
      })
    }
    return { rows, firstIndex, totalRows: wrapped.length }
  }

  view(width: number, height: number, scrollBack: number): string[] {
    return this.viewport(width, height, scrollBack).rows.map((row) => row.text)
  }

  pointAt(row: TranscriptRow, column: number): TranscriptPoint | null {
    if (!row.selectable || row.sourceId < 0) return null
    const source = this.sourceTexts.get(row.sourceId)
    if (source === undefined) return null
    const relative = Math.max(0, column - row.displayStart)
    return {
      id: row.sourceId,
      offset: offsetAtColumn(source, row.sourceStart, row.sourceEnd, relative),
    }
  }

  hasSource(id: number): boolean {
    return this.sourceTexts.has(id)
  }

  columnAtOffset(row: TranscriptRow, offset: number): number {
    const source = this.sourceTexts.get(row.sourceId)
    if (source === undefined) return 0
    const clamped = Math.max(row.sourceStart, Math.min(offset, row.sourceEnd))
    return displayWidth(source.slice(row.sourceStart, clamped))
  }

  comparePoints(left: TranscriptPoint, right: TranscriptPoint): number {
    const leftOrder = this.sourceOrders.get(left.id)
    const rightOrder = this.sourceOrders.get(right.id)
    if (leftOrder === undefined || rightOrder === undefined) return 0
    if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1
    return left.offset === right.offset ? 0 : left.offset < right.offset ? -1 : 1
  }

  selectionText(start: TranscriptPoint, end: TranscriptPoint): string {
    const startOrder = this.sourceOrders.get(start.id)
    const endOrder = this.sourceOrders.get(end.id)
    if (startOrder === undefined || endOrder === undefined) return ""
    const [first, last] =
      startOrder <= endOrder
        ? [
            { order: startOrder, point: start },
            { order: endOrder, point: end },
          ]
        : [
            { order: endOrder, point: end },
            { order: startOrder, point: start },
          ]
    if (start.id === end.id) {
      const source = this.sourceTexts.get(start.id) ?? ""
      const from = Math.min(start.offset, end.offset)
      const to = Math.max(start.offset, end.offset)
      return source.slice(from, to)
    }
    // `ids` terurut menaik menurut `order` (monotonik saat append + eviction
    // dari depan), jadi lompati sumber SEBELUM awal seleksi dengan pencarian
    // biner — bukan memindai seluruh transkrip (bisa 5.000 entri) tiap salin.
    const parts: string[] = []
    for (let i = this.orderLowerBound(first.order); i < this.ids.length; i++) {
      const id = this.ids[i]!
      const order = this.sourceOrders.get(id)
      if (order === undefined) continue
      if (order > last.order) break
      const source = this.sourceTexts.get(id) ?? ""
      if (order === first.order) parts.push(source.slice(first.point.offset))
      else if (order === last.order) parts.push(source.slice(0, last.point.offset))
      else parts.push(source)
    }
    return parts.join("\n")
  }

  /** Seleksi kosong (anchor == focus pada sumber yang sama) tanpa menyusun teks. */
  selectionIsEmpty(start: TranscriptPoint, end: TranscriptPoint): boolean {
    const startOrder = this.sourceOrders.get(start.id)
    const endOrder = this.sourceOrders.get(end.id)
    if (startOrder === undefined || endOrder === undefined) return true
    if (start.id === end.id) return start.offset === end.offset
    return false
  }

  /** Indeks pertama di `ids` dengan order >= `order` (ids terurut menaik). */
  private orderLowerBound(order: number): number {
    let lo = 0
    let hi = this.ids.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const o = this.sourceOrders.get(this.ids[mid]!) ?? -1
      if (o < order) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  dispose(): void {
    for (const u of this.unsubs) u()
    this.unsubs = []
    try {
      this.presentationUnsub?.()
    } catch {}
    this.presentationUnsub = null
  }

  private commit(): void {
    if (!this.pending) return
    const rawText = this.pendingTruncated
      ? `${this.pending}\n${TRANSCRIPT_TRUNCATION_MARKER}`
      : this.pending
    this.pending = ""
    this.pendingVersion++
    this.pendingTruncated = false
    this.appendAssistantText(rawText)
  }

  /** Render jawaban asisten (markdown) menjadi baris logis kind "assistant". */
  private appendAssistantText(raw: string): void {
    const text = normalizeAssistantOutput(raw)
    if (!text) return
    // Pisahkan jawaban dari thinking/diagnostik tepat di atasnya dengan satu
    // baris kosong — supaya "berpikir" tidak nempel ke jawaban.
    if (this.lastKind() === "diagnostic") this.append("", { kind: "assistant" })
    for (const block of parseMarkdownBlocks(sanitizeAnsi(text))) {
      if (block.type === "table") this.appendTable(block.table, { kind: "assistant" })
      else {
        for (const row of block.text.split("\n")) this.append(row, { kind: "assistant" })
      }
    }
  }

  /**
   * Rebuild riwayat transkrip dari event presentasi durable (jalur resume).
   * Dipanggil SEKALI sebelum turn live berikutnya, jadi tak ada double-render.
   * `user.message` → echo prompt; `model.completed` → jawaban model; sisanya
   * (turn.*, tool.*, task.status, …) melewati jalur `presentationEvent` yang
   * sama seperti live — snapshot presentasi sudah di-rebuild saat resume,
   * sehingga ledger/provenance mengacu data yang benar.
   */
  replayHistory(events: readonly UiPresentationEvent[]): void {
    for (const event of events) {
      if (event.type === "user.message") {
        if (event.text) this.pushUser(event.text)
        continue
      }
      if (event.type === "model.completed") {
        if (event.text) this.appendAssistantText(event.text)
        continue
      }
      // reasoning/plan/finding/result/diagnostic/approval/… tak punya baris
      // transkrip di jalur live; presentationEvent men-drop-nya (no-op aman).
      this.presentationEvent(event)
    }
  }

  private lastKind(): TranscriptMeta["kind"] | undefined {
    return this.meta[this.meta.length - 1]?.kind
  }

  private presentationSnapshot(): UiPresentationSnapshot | null {
    if (!this.getSnapshot) return null
    try {
      return this.getSnapshot()
    } catch {
      return null
    }
  }

  private presentationEvent(event: UiPresentationEvent): void {
    if (event.type === "turn.started") {
      this.commit()
      this.commitThinking()
      this.activityFold = []
      return
    }
    if (event.type === "turn.completed") {
      this.commit()
      this.commitThinking()
      // minimizeActivity ON / activityPanel ON → fold meringkas sendiri (nama
      // tool + ok/gagal); turnSummary (turn · files · durasi) dilewati agar
      // tidak ada dua ringkasan.
      if (!this.uiState.minimizeActivity && !this.uiState.activityPanel)
        this.turnSummary(event.summary, event)
      this.flushActivityFold()
      return
    }
    if (event.type === "turn.failed" || event.type === "turn.cancelled") {
      this.commit()
      this.commitThinking()
      this.flushActivityFold()
      return
    }
    // F-TASK-1: status task kanonik (t<n>) + DAG dirender sebagai baris ledger,
    // bukan ditelan — event ini sebelumnya hanya hidup di machine envelope.
    if (event.type === "task.status") {
      this.taskStatusLedger(event)
      return
    }
    // P1.6: event observability non-tool yang sebelumnya diblokir oleh guard
    // `!event.type.startsWith("tool.")` — consequence, context, verification
    // kini dirender sebagai baris ledger informatif.
    if (event.type === "consequence.decided") {
      this.consequenceLedger(event)
      return
    }
    if (event.type === "context.cutoff" || event.type === "context.window") {
      this.contextLedger(event)
      return
    }
    // P1.5: observasi verifikasi bukan `tool.*`, jadi sebelumnya ditelan guard
    // di bawah dan `verificationLedger` menjadi kode mati. Render sebelum guard.
    if (event.type === "verification.observed") {
      this.verificationLedger(event)
      return
    }
    if (!event.type.startsWith("tool.")) return
    if (event.type === "tool.started") {
      this.commit()
      this.commitThinking()
      return
    }
    this.presentationLedger(event)
  }

  private snapshotActivity(toolCallId: string | undefined) {
    if (!toolCallId) return undefined
    return this.presentationSnapshot()?.activities.find((a) => a.toolCallId === toolCallId)
  }

  private presentationLedger(event: UiPresentationEvent): void {
    // Observasi verifikasi punya baris ledger sendiri (dedup per invocation):
    // terminal tool sudah tampil duluan, dan transcript append-only tak bisa
    // menimpa baris lama. Baris ini tak pernah mengklaim status tool.
    if (event.type === "verification.observed") {
      this.verificationLedger(event)
      return
    }
    if (event.toolCallId) {
      if (this.presentedTerminals.has(event.toolCallId)) return
      this.presentedTerminals.add(event.toolCallId)
    }
    const activity = this.snapshotActivity(event.toolCallId)
    // F-AGENT-1: baris per-run HANYA bila activity membawa identitas run anak
    // (childSessionId/runId — data nyata dari ChildSessionLink). Tool anak yang
    // cuma punya `parentToolCallId` (jalur grouping legacy) tetap SEPENUHNYA
    // ditelan hitungan induk "n child tools" — kontrak P5 satu baris ledger
    // induk. `parentToolCallId` = taut ke pemanggil, BUKAN identitas run; jangan
    // disamakan dengan childSessionId/runId.
    if (activity?.parentToolCallId) {
      if (activity.childSessionId || activity.runId) this.childLedger(event, activity)
      return
    }
    this.commit()
    const snapshot = this.presentationSnapshot()
    const children = activity
      ? (snapshot?.activities ?? []).filter((a) => a.parentToolCallId === activity.toolCallId)
          .length
      : 0
    // Keputusan node dari policy kanonik bila di-inject; paint/sanitasi tetap
    // di sini. Tanpa policy = logika inline legacy (rollback flag).
    const desc =
      this.policy && activity
        ? this.policy.describeActivity(activity, { childCount: children })
        : undefined
    const name = sanitizeAnsiLine(desc?.name ?? activity?.name ?? event.name ?? "tool")
    const target = desc?.target ?? activity?.target ?? event.target
    const targetText = target ? ` ${truncateToWidth(sanitizeAnsiLine(target), 120, "")}` : ""
    const status = desc?.status ?? activity?.status ?? event.status ?? "completed"
    const retry = (desc ? desc.retryOf : activity?.supersedes) ? ` ${t("ts.retry")}` : ""
    const child = children > 0 ? ` ${t("ts.childGroup", { n: children })}` : ""
    // P2.11: penanda verifikasi/provenans dari deskripsi policy (ASCII aman).
    // Absen = unknown/live — tidak dirender sebagai keberhasilan.
    const verification = desc?.verification ?? activity?.verification
    const provenance = desc?.provenance ?? activity?.provenance
    // Keputusan marker lewat policy kanonik bila di-inject; fallback inline
    // legacy (tanpa policy) dijaga test display agar tak divergen dari
    // projection.ts (`verificationMark`/`provenanceMark`).
    const verificationMark = this.policy
      ? this.policy.verificationMark(verification)
      : !verification
        ? ""
        : verification.verdict === "present"
          ? " [verified]"
          : ` [unverified:${verification.verdict}]`
    const provenanceMark = this.policy
      ? this.policy.provenanceMark(provenance)
      : provenance === "reconstructed"
        ? " [reconstructed]"
        : provenance === "replay"
          ? " [replay]"
          : ""
    // Denial reason wajib terlihat di TUI: linear + machine sudah menampilkannya,
    // dan operator butuh tahu MENGAPA tool ditolak tanpa membaca log.
    const denyReason =
      status === "denied"
        ? (desc?.denyReason ?? activity?.denyReason ?? (event.reason ? String(event.reason) : ""))
        : ""
    const message = event.message
      ? `: ${truncateToWidth(sanitizeAnsi(String(event.message)), 200, "…").split("\n")[0] ?? ""}`
      : denyReason
        ? `: ${truncateToWidth(sanitizeAnsi(denyReason), 200, "…").split("\n")[0] ?? ""}`
        : ""
    const line = `  ${name}${targetText} ${statusWord(status)}${retry}${child}${verificationMark}${provenanceMark}${message}`
    // Lipat aktivitas (opencode-like): saat minimizeActivity ATAU panel
    // aktivitas aktif, baris ledger per-tool TIDAK boleh menghilang diam-diam
    // — ditahan lalu dirangkum saat turn selesai (panel: per keluarga tool;
    // minimize: satu baris nama+hitungan). Detail via /expand.
    if (this.uiState.minimizeActivity || this.uiState.activityPanel) {
      this.activityFold.push({ name, status, line })
      return
    }
    this.append(paintLedger(status, line), {
      kind: "activity",
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      status,
      ...(activity?.expandRef ? { expandRef: activity.expandRef } : {}),
    })
  }

  /** F-AGENT-1: baris terminal tool anak — identitas run + tool + status.
   * Paralel dipisah via runMarker (data aktual runId/childSessionId), bukan
   * hitungan "n tool anak" yang menyatukan run berbeda.
   */
  private childLedger(event: UiPresentationEvent, activity: UiPresentationActivity): void {
    this.commit()
    const marker = runMarker(activity)
    const name = sanitizeAnsiLine(activity.name ?? event.name ?? "tool")
    const target = activity.target ?? event.target
    const targetText = target ? ` ${truncateToWidth(sanitizeAnsiLine(target), 120, "")}` : ""
    const status = activity.status ?? event.status ?? "completed"
    const message =
      status === "failed" && event.message
        ? `: ${truncateToWidth(sanitizeAnsi(String(event.message)), 200, "…").split("\n")[0] ?? ""}`
        : ""
    const markerText = marker ? `${marker} ` : ""
    const line = `    ↳ ${markerText}${name}${targetText} ${statusWord(status)}${message}`
    this.append(paintLedger(status, line), {
      kind: "activity",
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      status,
      ...(activity.expandRef ? { expandRef: activity.expandRef } : {}),
    })
  }

  private verificationLedger(event: UiPresentationEvent): void {
    const verification = event.verification
    if (!verification || !event.toolCallId) return
    if (this.presentedVerifications.has(verification.invocationId)) return
    this.presentedVerifications.add(verification.invocationId)
    const activity = this.snapshotActivity(event.toolCallId)
    if (activity?.parentToolCallId) return
    const name = sanitizeAnsiLine(activity?.name ?? event.name ?? "tool")
    const target = activity?.target ?? event.target
    const targetText = target ? ` ${truncateToWidth(sanitizeAnsiLine(target), 120, "")}` : ""
    const line =
      verification.verdict === "present"
        ? `  ${name}${targetText} verified`
        : `  ? ${name}${targetText} unverified (${verification.verdict})`
    this.append(
      verification.verdict === "present" ? paintLedger("completed", line) : c.muted(line),
      {
        kind: "activity",
        ...(event.seq !== undefined ? { seq: event.seq } : {}),
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        toolCallId: event.toolCallId,
        status: activity?.status ?? "completed",
      },
    )
  }

  /**
   * P1.6: baris ledger consequence.decided — menampilkan verdict ACE/policy
   * agar operator tahu keputusan yang diambil runtime (PASS/FAIL/BLOCKED/
   * INCONCLUSIVE). Sebelumnya diblokir oleh guard `!startsWith("tool.")`.
   */
  private consequenceLedger(event: UiPresentationEvent): void {
    this.commit()
    const verdict = String(event.verdict ?? "UNKNOWN")
    const rule = event.failureClass ? ` class=${sanitizeAnsiLine(String(event.failureClass))}` : ""
    const rationale = event.message ?? event.reason
    const reason = rationale
      ? `: ${truncateToWidth(sanitizeAnsiLine(String(rationale)), 200, "…")}`
      : ""
    const next = event.nextAction ? ` next=${sanitizeAnsiLine(String(event.nextAction))}` : ""
    const glyph =
      verdict === "PASS"
        ? glyphs.check
        : verdict === "FAIL" || verdict === "BLOCKED"
          ? glyphs.cross
          : "?"
    const line = `  ${glyph} consequence ${sanitizeAnsiLine(verdict)}${rule}${next}${reason}`
    const paint =
      verdict === "FAIL" || verdict === "BLOCKED"
        ? c.error(line)
        : verdict === "PASS"
          ? c.success(line)
          : c.warning(line)
    this.append(paint, {
      kind: "activity",
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    })
  }

  /**
   * P1.6: baris ledger context.cutoff / context.window — memberitahu operator
   * saat konteks dipotong (compaction) atau mendekati batas jendela.
   * Sebelumnya diblokir oleh guard `!startsWith("tool.")`.
   */
  private contextLedger(event: UiPresentationEvent): void {
    this.commit()
    if (event.type === "context.cutoff") {
      const reason = event.reason ? `: ${sanitizeAnsiLine(String(event.reason))}` : ""
      const line = `  ▪ context cutoff${reason}`
      this.append(c.warning(line), {
        kind: "system",
        ...(event.seq !== undefined ? { seq: event.seq } : {}),
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      })
    } else {
      // context.window — occupancy aktual vs kapasitas (bukan session spend).
      const used = event.usedTokens
      const window = event.windowTokens
      const pct = event.percent != null ? ` ${Math.round(event.percent)}%` : ""
      const tokens =
        used != null
          ? ` ${used.toLocaleString()}${window ? `/${window.toLocaleString()}` : ""} tokens`
          : ""
      const line = `  ▪ context window${tokens}${pct}`
      this.append(c.muted(line), {
        kind: "system",
        ...(event.seq !== undefined ? { seq: event.seq } : {}),
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      })
    }
  }

  /**
   * F-TASK-1: baris ledger status task kanonik (`t<n>`) + DAG. Id/status/parent/
   * dependsOn dibawa apa adanya dari TaskStore; tak ada status yang diarang.
   */
  private taskStatusLedger(event: UiPresentationEvent): void {
    const id = event.taskId
    const raw = event.taskStatus
    if (id === undefined || raw === undefined) return
    this.commit()
    const status = sanitizeAnsiLine(String(raw).toLowerCase())
    const parent = event.parentId ? ` parent=${sanitizeAnsiLine(event.parentId)}` : ""
    const deps = event.dependsOn?.length
      ? ` dependsOn=[${event.dependsOn.map((d) => sanitizeAnsiLine(d)).join(",")}]`
      : ""
    const rev = event.revision !== undefined ? ` r${event.revision}` : ""
    // P1.5: COMPLETED tanpa verification passed bukan PASS. Tandai eksplisit.
    const verify =
      raw === "COMPLETED"
        ? event.taskVerification?.verdict === "passed"
          ? " [verified]"
          : ` [${event.taskVerification?.verdict ?? "unverified"}]`
        : ""
    const line = `  ▪ ${sanitizeAnsiLine(id)} ${status}${parent}${deps}${rev}${verify}`
    const paint =
      raw === "FAILED"
        ? c.error(line)
        : raw === "BLOCKED"
          ? c.warning(line)
          : raw === "COMPLETED"
            ? c.success(line)
            : c.muted(line)
    this.append(paint, {
      kind: "activity",
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    })
  }

  private turnSummary(summary: UiPresentationEvent["summary"], event: UiPresentationEvent): void {
    if (!summary) return
    const snapshot = this.presentationSnapshot()
    const turn = snapshot
      ? (this.policy?.matchTurn(snapshot.turns, summary) ??
        snapshot.turns.find((candidate) => {
          const value = candidate.summary
          return (
            value?.toolsOk === summary.toolsOk &&
            value?.toolsFailed === summary.toolsFailed &&
            value?.toolsDenied === summary.toolsDenied &&
            value?.filesChanged === summary.filesChanged
          )
        }))
      : undefined
    const turnId =
      event.turnId ?? turn?.turnId ?? snapshot?.turns[snapshot.turns.length - 1]?.turnId ?? 0
    if (event.turnId !== undefined) {
      if (this.summarizedTurns.has(event.turnId)) return
      this.summarizedTurns.add(event.turnId)
    }
    const line = t("ts.turnSummary", {
      turn: turnId,
      ok: summary.toolsOk,
      failed: summary.toolsFailed,
      denied: summary.toolsDenied,
      cancelled: summary.toolsCancelled,
      interrupted: summary.toolsInterrupted,
      files: summary.filesChanged,
      ckpt: summary.checkpointId ?? "—",
      secs: formatElapsed(summary.durationMs),
    })
    this.append(c.muted(line), {
      kind: "system",
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    })
  }

  /** Flush lipatan aktivitas (minimizeActivity) menjadi SATU baris ringkas
   * (opencode-like) + buffer detail untuk /expand. Tidak menghilangkan isi
   * diam-diam: nama tool + hitung ok/gagal tetap terlihat.
   *
   * Saat activityPanel ON, ringkasan memakai KELUARGA tool (satu baris per
   * grup — `+ explore · 3 tools · 2 ok`) alih-alih daftar nama rata.
   * Detail penuh tetap masuk /expand. */
  private flushActivityFold(): void {
    const fold = this.activityFold
    this.activityFold = []
    if (fold.length === 0) return
    // Panel ON: render per-grup (sumber: event tool yang sudah dikumpulkan).
    if (this.uiState.activityPanel) {
      const activities = fold.map((e) => ({
        toolCallId: "",
        name: e.name,
        status: e.status as UiToolStatus,
        tsStart: 0,
      }))
      const lines = renderActivityPanel(activities, { maxRows: 10 })
      if (lines.length === 0) return
      this.uiState.rememberCollapsedSection("activity", fold.map((e) => e.line).join("\n"))
      for (const line of lines) this.append(line, { kind: "activity" })
      return
    }
    const count = (status: string) => fold.reduce((n, e) => n + (e.status === status ? 1 : 0), 0)
    const ok = count("completed")
    const failed = count("failed")
    const denied = count("denied")
    const names = [...new Set(fold.map((e) => e.name))]
    const shown = names.slice(0, 3).join(", ")
    const more = names.length - 3
    const namePart = shown ? ` · ${shown}${more > 0 ? ` +${more}` : ""}` : ""
    const stats = [
      ok ? `${ok} ok` : "",
      failed ? `${failed} ${t("ts.statusFailed")}` : "",
      denied ? `${denied} ${t("ts.statusDenied")}` : "",
    ]
      .filter(Boolean)
      .join(", ")
    const statPart = stats ? ` · ${stats}` : ""
    const line = `  ${glyphs.check} ${fold.length} tool${fold.length > 1 ? "s" : ""}${namePart}${statPart}`
    // Detail tetap tersedia via /expand (tidak dibuang).
    this.uiState.rememberCollapsedSection("activity", fold.map((e) => e.line).join("\n"))
    this.append(line, { kind: "activity" })
  }

  /** Fase 1 perf (butir 2): daftar activity running per snapshot (memoized). */
  private runningActivities(snapshot: UiPresentationSnapshot): UiPresentationActivity[] {
    if (this.runningMemo && this.runningMemo.snapshot === snapshot) {
      return this.runningMemo.running
    }
    const running = snapshot.activities.filter((a) => a.status === "running")
    this.runningMemo = { snapshot, running }
    return running
  }

  private runningRows(): string[] {
    const snapshot = this.presentationSnapshot()
    if (!snapshot) return []
    const running = this.runningActivities(snapshot)
    const roots = running.filter((a) => !a.parentToolCallId)
    const row = (activity: (typeof running)[number], child: boolean, marker: string): string => {
      const name = sanitizeAnsiLine(activity.name)
      const target = activity.target
        ? ` ${truncateToWidth(sanitizeAnsiLine(activity.target), 120, "")}`
        : ""
      const elapsed = Date.now() - activity.tsStart
      const showElapsed = this.policy
        ? this.policy.elapsedVisible(activity.tsStart, Date.now())
        : elapsed >= 2000
      const elapsedText = showElapsed ? ` (${formatElapsed(elapsed)})` : ""
      const retry = activity.supersedes ? ` ${t("ts.retry")}` : ""
      const markerText = marker ? `${marker} ` : ""
      const prefix = child ? "    ↳ " : `  ${glyphs.arrow} `
      return c.info(
        `${prefix}${markerText}${name}${target} … ${t("ts.statusRunning")}${elapsedText}${retry}`,
      )
    }
    // F-AGENT-1: tiap run anak = baris sendiri, bukan hitungan "n tool anak".
    const out: string[] = []
    for (const activity of roots) {
      out.push(row(activity, false, ""))
      for (const child of running.filter((a) => a.parentToolCallId === activity.toolCallId))
        out.push(row(child, true, runMarker(child)))
    }
    // Anak yatim (parent tak lagi running/root): tetap tampil, jangan hilang.
    for (const activity of running) {
      if (
        !activity.parentToolCallId ||
        roots.some((r) => r.toolCallId === activity.parentToolCallId)
      )
        continue
      out.push(row(activity, true, runMarker(activity)))
    }
    return out
  }

  private append(line: string, meta: TranscriptMeta = { kind: "system" }): void {
    this.appendWithSource(line, meta, stripSgr(sanitizeAnsi(line)))
  }

  private appendWithSource(
    line: string,
    meta: TranscriptMeta,
    sourceText: string,
    sourcePrefix = "",
  ): void {
    this.appendEntry(line, null, meta, sourceText, sourcePrefix)
  }

  private appendTable(table: MarkdownTable, meta: TranscriptMeta = { kind: "assistant" }): void {
    const sourceText = [table.headers, ...table.rows].map((row) => row.join("\t")).join("\n")
    this.appendEntry(table.source, table, { ...meta, table }, sourceText, "")
  }

  private appendEntry(
    line: string,
    table: MarkdownTable | null,
    meta: TranscriptMeta,
    sourceText: string,
    sourcePrefix: string,
  ): void {
    const id = this.nextId++
    const order = this.nextOrder++
    this.lines.push(line)
    this.tables.push(table)
    this.ids.push(id)
    this.sourcePrefixes.push(sourcePrefix)
    this.sourceTexts.set(id, sourceText)
    this.sourceOrders.set(id, order)
    this.meta.push(meta)
    this.totalAppended++
    if (!this.hasEvictMarker && this.lines.length > TRANSCRIPT_CAP) {
      const overflow = this.lines.length - TRANSCRIPT_CAP
      const removed = this.ids.splice(0, overflow)
      for (const removedId of removed) {
        this.sourceTexts.delete(removedId)
        this.assistantDisplay.delete(removedId)
        this.sourceOrders.delete(removedId)
      }
      this.lines.splice(0, overflow)
      this.tables.splice(0, overflow)
      this.sourcePrefixes.splice(0, overflow)
      this.meta.splice(0, overflow)
      this.rowCache.clear() // index bergeser setelah eviction
      this.evicted += overflow
      this.lines.unshift(c.muted(t("ts.evictMarker", { n: this.evicted })))
      this.tables.unshift(null)
      this.ids.unshift(-1)
      this.sourcePrefixes.unshift("")
      this.meta.unshift({ kind: "system" })
      this.hasEvictMarker = true
    }
    if (this.hasEvictMarker && this.lines.length > TRANSCRIPT_CAP + 1) {
      const overflow = this.lines.length - (TRANSCRIPT_CAP + 1)
      const removed = this.ids.splice(1, overflow)
      for (const removedId of removed) {
        this.sourceTexts.delete(removedId)
        this.assistantDisplay.delete(removedId)
        this.sourceOrders.delete(removedId)
      }
      this.lines.splice(1, overflow)
      this.tables.splice(1, overflow)
      this.sourcePrefixes.splice(1, overflow)
      this.meta.splice(1, overflow)
      this.rowCache.clear() // index bergeser setelah eviction
      this.evicted += overflow
      this.lines[0] = c.muted(t("ts.evictMarker", { n: this.evicted }))
    }
  }
}
