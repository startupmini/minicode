// Transkrip TUI — kolektor append-only event bus menjadi baris logis.
//
// Kenapa kelas sendiri: App butuh sumber kebenaran tunggal untuk viewport
// (paint, scroll, resize) yang terpisah dari pengambilan input. Menyimpan
// baris LOGIS (tanpa wrap) supaya resize me-wrap ulang saat paint — lebar
// terminal dibaca saat paint, bukan saat event (kontrak I11).
//
// Mode compact saja di Fase 1: teks model mengalir, ledger tool satu baris
// `  › nama target` (grammar sama dengan REPL), error merah satu baris.
import type { UiBus } from "../contract.ts"
import { t } from "../i18n/locale.ts"
import { reasoning } from "../render/reasoning.ts"
import { sanitizeAnsi, sanitizeAnsiLine } from "../render/sanitize.ts"
import { c } from "../render/theme.ts"
import { chunkByWidth, truncateToWidth } from "../render/width.ts"

/** Cap memori: baris logis tertua dibuang diam-diam (kontrak I12). */
export const TRANSCRIPT_CAP = 5000
/** Isi tool per section untuk /expand: maks 10 section × 2000 char. */
const EXPAND_MAX_SECTIONS = 10
const EXPAND_MAX_CHARS = 2000

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

export interface BufferedSection {
  label: string
  text: string
}

function ledgerTarget(args: Record<string, unknown>): string | undefined {
  if (typeof args.path === "string" && args.path) return args.path
  const cmd = args.cmd ?? args.command
  if (typeof cmd === "string" && cmd) return `$ ${cmd}`
  return undefined
}

export class Transcript {
  private lines: string[] = []
  private pending = ""
  private sections: BufferedSection[] = []
  /** Thinking terakumulasi (tersanitasi). Minimized: penanda hidup + buffer
   * /expand; expanded: mengalir redup seperti teks. */
  private thinkingBuf = ""
  private thinkingTail = ""
  private unsubs: (() => void)[] = []

  constructor(bus: UiBus) {
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
      bus.on("execution:completed", (e) => this.ledger(e)),
      bus.on("provider:extension", (e: { kind: string; data: unknown }) => this.extension(e)),
      bus.on("context:compacted", (e: { reason: string }) =>
        this.push(c.muted(t("ts.compacted", { reason: sanitizeAnsiLine(e.reason ?? "") }))),
      ),
    ]
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
      for (let i = 0; i < parts.length - 1; i++) this.append(c.muted(parts[i] ?? ""))
      this.thinkingTail = parts[parts.length - 1] ?? ""
    } else {
      // Minimized: penanda hidup + buffer untuk /expand (cap 20k).
      this.thinkingBuf = (this.thinkingBuf + clean).slice(-20000)
    }
  }

  /** Selesaikan fase thinking: minimized → buffer /expand (tanpa baris
   * transkrip, tetap bersih); expanded → flush ekor redup. */
  private commitThinking(): void {
    if (this.thinkingTail) {
      this.append(c.muted(this.thinkingTail))
      this.thinkingTail = ""
    }
    if (this.thinkingBuf.trim()) {
      this.sections.push({ label: "thinking", text: this.thinkingBuf.trim() })
      if (this.sections.length > EXPAND_MAX_SECTIONS) {
        this.sections.splice(0, this.sections.length - EXPAND_MAX_SECTIONS)
      }
    }
    this.thinkingBuf = ""
  }

  /** Dorong baris logis (sudah final, mis. gema prompt user). */
  push(line: string): void {
    this.commit()
    this.append(line)
  }

  /** Gema prompt user ala shell: `minicode › baris-1`, lanjutan menjorok. */
  pushUser(prompt: string): void {
    const rows = sanitizeAnsi(prompt).split("\n")
    const [first, ...rest] = rows
    this.push(`${c.accent("minicode")} ${c.muted("›")} ${first ?? ""}`)
    for (const r of rest) this.append(`  ${r}`)
  }

  pushError(message: string): void {
    this.push(c.error(`✗ ${sanitizeAnsiLine(message)}`))
  }

  pushInfo(lines: string[]): void {
    this.commit()
    for (const l of lines) this.append(l)
  }

  /** Kosongkan transkrip (`/clear`): viewport kembali ke layar kosong. */
  clear(): void {
    this.lines = []
    this.pending = ""
    this.sections = []
    this.thinkingBuf = ""
    this.thinkingTail = ""
  }

  /**
   * Ambil isi tool yang dibuffer untuk `/expand` (sekali ambil = habis,
   * seperti membuka arsip). Kosong = tak ada yang disembunyikan.
   */
  takeBufferedSections(): BufferedSection[] {
    const out = this.sections
    this.sections = []
    return out
  }

  /** Jumlah baris logis (untuk test; bukan API paint). */
  size(): number {
    return this.lines.length + (this.pending ? 1 : 0)
  }

  /**
   * Baris tampil untuk viewport: wrap ke `width`, ambil `height` baris
   * terakhir dikurangi `scrollBack` (0 = ikut ekor). Selalu kembalikan
   * TEPAT `height` string (padding "" bila kurang) supaya frame penuh.
   */
  view(width: number, height: number, scrollBack: number): string[] {
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
    // penanda redup (transkrip tetap bersih, isi di /expand).
    if (this.thinkingTail) {
      for (const chunk of this.thinkingTail.split("\n")) {
        const rows = chunk === "" ? [""] : chunkByWidth(chunk, w)
        for (const r of rows) wrapped.push(c.muted(r))
      }
    } else if (this.thinkingBuf.trim()) {
      wrapped.push(c.muted(t("ts.thinking")))
    }
    const back = Math.max(0, Math.min(scrollBack, Math.max(0, wrapped.length - height)))
    const tail = wrapped.slice(0, wrapped.length - back)
    const shown = tail.slice(Math.max(0, tail.length - height))
    while (shown.length < height) shown.unshift("")
    return shown
  }

  dispose(): void {
    for (const u of this.unsubs) u()
    this.unsubs = []
  }

  private commit(): void {
    if (!this.pending) return
    const text = this.pending
    this.pending = ""
    for (const row of sanitizeAnsi(text).split("\n")) this.append(row)
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
      this.append(c.error(`  › ${name}: ${msg}`))
      return
    }
    const target = ledgerTarget(args)
    const label = target ? ` ${truncateToWidth(sanitizeAnsiLine(target), 120, "")}` : ""
    // Glyph ledger memakai arrow tema (› di UTF-8, > di ASCII) — konsisten
    // dengan grammar REPL walau bentuknya disusun manual di sini.
    this.append(c.success(`  ›${name ? ` ${name}` : ""}${label}`))
    // Isi tool sukses dibuffer untuk /expand (compact default: isi milik
    // model untuk dibaca, bukan untuk membanjiri viewport).
    if (typeof r?.content === "string" && r.content.trim()) {
      const text = sanitizeAnsi(r.content.trim()).slice(0, EXPAND_MAX_CHARS)
      this.sections.push({ label: `${name}${label}`, text })
      if (this.sections.length > EXPAND_MAX_SECTIONS) {
        this.sections.splice(0, this.sections.length - EXPAND_MAX_SECTIONS)
      }
    }
  }

  private append(line: string): void {
    this.lines.push(line)
    if (this.lines.length > TRANSCRIPT_CAP) {
      this.lines.splice(0, this.lines.length - TRANSCRIPT_CAP)
    }
  }
}
