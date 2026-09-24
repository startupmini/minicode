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
  UiBus,
  UiPresentationEvent,
  UiPresentationSnapshot,
  UiToolStatus,
} from "../contract.ts"
import { t } from "../i18n/locale.ts"
import { reasoning } from "../render/reasoning.ts"
import { sanitizeAnsi, sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs } from "../render/theme.ts"
import { chunkByWidth, truncateToWidth } from "../render/width.ts"

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
}

export interface TranscriptOptions {
  getSnapshot?: () => UiPresentationSnapshot | null
  onPresentationEvent?: (handler: (event: UiPresentationEvent) => void) => () => void
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

export class Transcript {
  private lines: string[] = []
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
  private presentationEvents = false
  private presentationUnsub: (() => void) | null = null
  private presentedTerminals = new Set<string>()
  private summarizedTurns = new Set<number>()
  private unsubs: (() => void)[] = []

  constructor(bus: UiBus, opts: TranscriptOptions = {}) {
    this.getSnapshot = opts.getSnapshot
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
    this.push(`${c.accent("minicode")} ${c.muted("›")} ${first ?? ""}`, { kind: "user" })
    for (const r of rest) this.append(`  ${r}`, { kind: "user" })
  }

  pushError(message: string): void {
    this.push(c.error(`✗ ${sanitizeAnsiLine(message)}`), { kind: "diagnostic" })
  }

  pushInfo(lines: string[]): void {
    this.commit()
    for (const l of lines) this.append(l)
  }

  /** Kosongkan transkrip (`/clear`): viewport kembali ke layar kosong. */
  clear(): void {
    this.lines = []
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

  /** Baris visual (ter-wrap) untuk lebar kolom — dipakai view + kunci scroll. */
  private wrapAll(width: number): string[] {
    const w = Math.max(10, width)
    const wrapped: string[] = []
    for (const logical of this.lines) {
      const clean = logical === "" ? [""] : chunkByWidth(logical, w)
      for (const r of clean) wrapped.push(r)
    }
    if (this.pending) {
      for (const chunk of sanitizeAnsi(this.pending).split("\n")) {
        const rows = chunk === "" ? [""] : chunkByWidth(chunk, w)
        for (const r of rows) wrapped.push(r)
      }
    }
    // Ekor hidup thinking: expanded = sisa baris redup; minimized = satu
    // penanda redup (isi tidak membanjiri transkrip).
    if (this.thinkingTail) {
      for (const chunk of this.thinkingTail.split("\n")) {
        const rows = chunk === "" ? [""] : chunkByWidth(chunk, w)
        for (const r of rows) wrapped.push(c.muted(r))
      }
    } else if (this.thinkingBuf.trim()) {
      wrapped.push(c.muted(t("ts.thinking")))
    }
    wrapped.push(...this.runningRows())
    return wrapped
  }

  /** Panjang visual viewport (untuk kunci posisi baca App saat stream masuk). */
  wrappedLength(width: number): number {
    return this.wrapAll(width).length
  }

  /**
   * Baris tampil untuk viewport: wrap ke `width`, ambil `height` baris
   * terakhir dikurangi `scrollBack` (0 = ikut ekor). Selalu kembalikan
   * TEPAT `height` string (padding "" bila kurang) supaya frame penuh.
   */
  view(width: number, height: number, scrollBack: number): string[] {
    const wrapped = this.wrapAll(width)
    const back = Math.max(0, Math.min(scrollBack, Math.max(0, wrapped.length - height)))
    const tail = wrapped.slice(0, wrapped.length - back)
    const shown = tail.slice(Math.max(0, tail.length - height))
    while (shown.length < height) shown.unshift("")
    return shown
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
    for (const row of sanitizeAnsi(text).split("\n")) this.append(row, { kind: "assistant" })
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
    const name = sanitizeAnsiLine(activity?.name ?? event.name ?? "tool")
    const target = activity?.target ?? event.target
    const targetText = target ? ` ${truncateToWidth(sanitizeAnsiLine(target), 120, "")}` : ""
    const status = activity?.status ?? event.status ?? "completed"
    const snapshot = this.presentationSnapshot()
    const children = activity
      ? (snapshot?.activities ?? []).filter((a) => a.parentToolCallId === activity.toolCallId)
          .length
      : 0
    const retry = activity?.supersedes ? ` ${t("ts.retry")}` : ""
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
    const turn = snapshot?.turns.find((candidate) => {
      const value = candidate.summary
      return (
        value?.toolsOk === summary.toolsOk &&
        value?.toolsFailed === summary.toolsFailed &&
        value?.toolsDenied === summary.toolsDenied &&
        value?.filesChanged === summary.filesChanged
      )
    })
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
      const elapsedText = elapsed >= 2000 ? ` (${formatElapsed(elapsed)})` : ""
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
    this.lines.push(line)
    this.meta.push(meta)
    this.totalAppended++
    if (!this.hasEvictMarker && this.lines.length > TRANSCRIPT_CAP) {
      const overflow = this.lines.length - TRANSCRIPT_CAP
      this.lines.splice(0, overflow)
      this.meta.splice(0, overflow)
      this.evicted += overflow
      this.lines.unshift(c.muted(t("ts.evictMarker", { n: this.evicted })))
      this.meta.unshift({ kind: "system" })
      this.hasEvictMarker = true
    }
    if (this.hasEvictMarker && this.lines.length > TRANSCRIPT_CAP + 1) {
      const overflow = this.lines.length - (TRANSCRIPT_CAP + 1)
      this.lines.splice(1, overflow)
      this.meta.splice(1, overflow)
      this.evicted += overflow
      this.lines[0] = c.muted(t("ts.evictMarker", { n: this.evicted }))
    }
  }
}
