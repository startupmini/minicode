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
  UiPresentationEvent,
  UiPresentationSnapshot,
  UiToolStatus,
} from "../contract.ts"
import { t } from "../i18n/locale.ts"
import { renderInline } from "../render/markdown.ts"
import { type MarkdownTable, parseMarkdownBlocks } from "../render/markdown-table.ts"
import { reasoning } from "../render/reasoning.ts"
import { sanitizeAnsi, sanitizeAnsiLine, stripSgr } from "../render/sanitize.ts"
import { renderMarkdownTable } from "../render/table-grid.ts"
import { c, glyphs } from "../render/theme.ts"
import { chunkByWidth, displayWidth, truncateToWidth } from "../render/width.ts"

/** Cap memori: baris logis tertua dibuang diam-diam (kontrak I12). */
export const TRANSCRIPT_CAP = 5000
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

function targetForFallback(args: Record<string, unknown>): string | undefined {
  if (typeof args.path === "string" && args.path) return args.path
  const cmd = args.cmd ?? args.command
  if (typeof cmd === "string" && cmd) return `$ ${cmd}`
  return undefined
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
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
  private ids: number[] = []
  private sourcePrefixes: string[] = []
  private sourceTexts = new Map<number, string>()
  private sourceOrders = new Map<number, number>()
  private nextId = 1
  private nextOrder = 1
  private pending = ""
  /** Hitung monotonik baris yang pernah ditambah — basis indikator "baru"
   * yang kebal evict cap 5000 (size() menyusut saat tertua dibuang). */
  private totalAppended = 0
  /** Thinking terakumulasi (tersanitasi). Minimized: penanda hidup;
   * expanded: mengalir redup seperti teks. */
  private thinkingBuf = ""
  private thinkingTail = ""
  private meta: TranscriptMeta[] = []
  private evicted = 0
  private hasEvictMarker = false
  private getSnapshot: (() => UiPresentationSnapshot | null) | undefined
  private policy: PresentationPolicy | undefined
  private presentationEvents = false
  private presentationUnsub: (() => void) | null = null
  private presentedTerminals = new Set<string>()
  private summarizedTurns = new Set<number>()
  private unsubs: (() => void)[] = []

  constructor(bus: UiBus, opts: TranscriptOptions = {}) {
    this.getSnapshot = opts.getSnapshot
    this.policy = opts.policy
    // Gagal subscribe = transcript mati total; biarkan throw (fail-closed).
    this.unsubs = [
      bus.on("provider:text", (e: { text: string }) => this.stream(e.text)),
      bus.on("turn:started", () => {
        this.commit()
        this.commitThinking()
      }),
      bus.on("turn:completed", () => {
        this.commit()
        this.commitThinking()
      }),
      bus.on("execution:started", () => {
        this.commit()
        this.commitThinking()
      }),
      bus.on("execution:completed", (e) => {
        if (!this.presentationEvents) this.ledger(e)
      }),
      bus.on("provider:extension", (e: { kind: string; data: unknown }) => this.extension(e)),
      bus.on("context:compacted", (e: { reason: string }) =>
        this.push(c.muted(t("ts.compacted", { reason: sanitizeAnsiLine(e.reason ?? "") }))),
      ),
    ]
    if (opts.onPresentationEvent) {
      this.presentationEvents = true
      this.presentationUnsub = opts.onPresentationEvent((event) => this.presentationEvent(event))
    }
  }

  /** Teks model mengalir — ditahan sebagai ekor hidup sampai commit. */
  stream(text: string): void {
    if (text) {
      // Jawaban dimulai = fase thinking selesai.
      this.commitThinking()
      this.pending += text
    }
  }

  /** Chunk reasoning (`provider:extension` kind reasoning, data {text}). */
  extension(e: { kind: string; data: unknown }): void {
    if (e.kind !== "reasoning") return
    const text = (e.data as { text?: string } | null)?.text ?? ""
    if (!text) return
    const clean = sanitizeAnsi(text)
    if (reasoning.visible) {
      // Expanded: alir redup per baris (line-buffered, ekor hidup).
      this.thinkingTail += clean
      const parts = this.thinkingTail.split("\n")
      for (let i = 0; i < parts.length - 1; i++)
        this.append(c.muted(parts[i] ?? ""), { kind: "diagnostic" })

      this.thinkingTail = parts[parts.length - 1] ?? ""
    } else {
      // Minimized: penanda hidup; isi disimpan di collapsed view linear.
      this.thinkingBuf = (this.thinkingBuf + clean).slice(-20000)
    }
  }

  /** Selesaikan fase thinking: minimized → penanda hilang; expanded → flush
   * ekor redup. */
  private commitThinking(): void {
    if (this.thinkingTail) {
      this.append(c.muted(this.thinkingTail), { kind: "diagnostic" })
      this.thinkingTail = ""
    }
    this.thinkingBuf = ""
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
    this.push(c.error(`✗ ${sanitizeAnsiLine(message)}`), { kind: "diagnostic" })
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
    this.tables = []
    this.ids = []
    this.sourcePrefixes = []
    this.sourceTexts.clear()
    this.sourceOrders.clear()
    this.nextId = 1
    this.nextOrder = 1
    this.meta = []
    this.pending = ""
    this.thinkingBuf = ""
    this.thinkingTail = ""
    this.evicted = 0
    this.hasEvictMarker = false
    this.presentedTerminals.clear()
    this.summarizedTurns.clear()
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
  ): TranscriptRow[] {
    const w = Math.max(10, width)
    const renderedLines = text.split("\n")
    const sourceLines = sourceText.split("\n")
    const out: TranscriptRow[] = []
    let sourceBase = 0
    for (let lineIndex = 0; lineIndex < renderedLines.length; lineIndex++) {
      const rendered = renderedLines[lineIndex] ?? ""
      const source = sourceLines[lineIndex] ?? stripSgr(sanitizeAnsi(rendered))
      const renderedRows = rendered === "" ? [""] : chunkByWidth(rendered, w)
      const sourceRows = sourcePrefix || source ? chunkByWidth(`${sourcePrefix}${source}`, w) : [""]
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

  private projectAll(width: number): TranscriptRow[] {
    const w = Math.max(10, width)
    const rows: TranscriptRow[] = []
    for (let i = 0; i < this.lines.length; i++) {
      const table = this.tables[i]
      const id = this.ids[i] ?? -1
      if (table) rows.push(...this.projectTable(table, id, w))
      else
        rows.push(
          ...this.projectText(
            this.lines[i] ?? "",
            this.sourceTexts.get(id) ?? "",
            id,
            w,
            true,
            this.sourcePrefixes[i] ?? "",
          ),
        )
    }
    if (this.pending) {
      for (const block of parseMarkdownBlocks(sanitizeAnsi(this.pending))) {
        if (block.type === "table") rows.push(...this.projectTable(block.table, -1, w))
        else
          rows.push(
            ...this.projectText(block.text, stripSgr(sanitizeAnsi(block.text)), -1, w, false),
          )
      }
    }
    if (this.thinkingTail) {
      for (const chunk of this.thinkingTail.split("\n")) {
        const chunkRows = chunk === "" ? [""] : chunkByWidth(chunk, w)
        for (const row of chunkRows) {
          rows.push({
            text: c.muted(row),
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
    for (const row of this.runningRows()) {
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
    const parts: string[] = []
    for (const id of this.ids) {
      const order = this.sourceOrders.get(id)
      if (order === undefined || order < first.order || order > last.order) continue
      const source = this.sourceTexts.get(id) ?? ""
      if (order === first.order) parts.push(source.slice(first.point.offset))
      else if (order === last.order) parts.push(source.slice(0, last.point.offset))
      else parts.push(source)
    }
    return parts.join("\n")
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
    const text = this.pending
    this.pending = ""
    for (const block of parseMarkdownBlocks(sanitizeAnsi(text))) {
      if (block.type === "table") this.appendTable(block.table, { kind: "assistant" })
      else {
        for (const row of block.text.split("\n")) this.append(row, { kind: "assistant" })
      }
    }
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
    if (event.type === "turn.completed") {
      this.commit()
      this.commitThinking()
      this.turnSummary(event.summary, event)
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

  private statusWord(status: UiToolStatus): string {
    if (status === "completed") return t("ts.statusCompleted")
    if (status === "failed") return t("ts.statusFailed")
    if (status === "denied") return t("ts.statusDenied")
    if (status === "cancelled") return t("ts.statusCancelled")
    if (status === "interrupted") return t("ts.statusInterrupted")
    return t("ts.statusRunning")
  }

  private statusGlyph(status: UiToolStatus): string {
    if (status === "completed") return glyphs.check
    if (status === "failed") return glyphs.cross
    if (status === "denied") return glyphs.denied
    return glyphs.circle
  }

  private statusPaint(status: UiToolStatus, line: string): string {
    if (status === "completed") return c.success(line)
    if (status === "failed") return c.error(line)
    if (status === "denied") return c.warning(line)
    return c.muted(line)
  }

  private presentationLedger(event: UiPresentationEvent): void {
    if (event.toolCallId) {
      if (this.presentedTerminals.has(event.toolCallId)) return
      this.presentedTerminals.add(event.toolCallId)
    }
    const activity = this.snapshotActivity(event.toolCallId)
    if (activity?.parentToolCallId) return
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
    const message =
      status === "failed" && event.message
        ? `: ${truncateToWidth(sanitizeAnsi(String(event.message)), 200, "…").split("\n")[0] ?? ""}`
        : ""
    const line = `  ${this.statusGlyph(status)} ${name}${targetText} ${this.statusWord(status)}${retry}${child}${message}`
    this.append(this.statusPaint(status, line), {
      kind: "activity",
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      status,
      ...(activity?.expandRef ? { expandRef: activity.expandRef } : {}),
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
    const turnId = turn?.turnId ?? snapshot?.turns[snapshot.turns.length - 1]?.turnId ?? 0
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

  private runningRows(): string[] {
    const snapshot = this.presentationSnapshot()
    if (!snapshot) return []
    const running = snapshot.activities.filter((a) => a.status === "running")
    const roots = running.filter((a) => !a.parentToolCallId)
    const rootIds = new Set(roots.map((a) => a.toolCallId))
    const row = (activity: (typeof running)[number], child: boolean): string => {
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
      const prefix = child ? "    ↳ " : `  ${glyphs.arrow} `
      return c.info(`${prefix}${name}${target} … ${t("ts.statusRunning")}${elapsedText}${retry}`)
    }
    const out = roots.map((activity) => {
      const childCount = running.filter((a) => a.parentToolCallId === activity.toolCallId).length
      const suffix = childCount > 0 ? ` ${t("ts.childGroup", { n: childCount })}` : ""
      return `${row(activity, false)}${suffix}`
    })
    for (const activity of running) {
      if (!activity.parentToolCallId || rootIds.has(activity.parentToolCallId)) continue
      out.push(row(activity, true))
    }
    return out
  }

  private ledger(e: {
    execution: {
      call: { name: string; args?: unknown }
      result: { isError?: boolean; content?: unknown }
    }
  }): void {
    this.commit()
    const rawName = e.execution.call.name ?? "tool"
    const name = sanitizeAnsiLine(String(rawName))
    const args = (e.execution.call.args ?? {}) as Record<string, unknown>
    const r = e.execution.result
    if (r?.isError) {
      const msg =
        truncateToWidth(sanitizeAnsi(String(r.content ?? "")), 200, "…").split("\n")[0] ?? ""
      this.append(c.error(`  › ${name}: ${msg}`), { kind: "activity" })
      return
    }
    const target = targetForFallback(args)
    const label = target ? ` ${truncateToWidth(sanitizeAnsiLine(target), 120, "")}` : ""
    // Glyph ledger memakai arrow tema (› di UTF-8, > di ASCII) — konsisten
    // dengan grammar REPL walau bentuknya disusun manual di sini.
    this.append(c.success(`  ›${name ? ` ${name}` : ""}${label}`), { kind: "activity" })
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
        this.sourceOrders.delete(removedId)
      }
      this.lines.splice(0, overflow)
      this.tables.splice(0, overflow)
      this.sourcePrefixes.splice(0, overflow)
      this.meta.splice(0, overflow)
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
        this.sourceOrders.delete(removedId)
      }
      this.lines.splice(1, overflow)
      this.tables.splice(1, overflow)
      this.sourcePrefixes.splice(1, overflow)
      this.meta.splice(1, overflow)
      this.evicted += overflow
      this.lines[0] = c.muted(t("ts.evictMarker", { n: this.evicted }))
    }
  }
}
