// App TUI — pemilik tunggal layar mode `--tui` (kontrak I17-I20).
//
// Arsitektur: SATU repaint sinkron per event. Tak ada painter lain yang aktif
// bersamaan (turn berjalan = spark pada status bar, bukan painter). Frame
// selalu TEPAT `rows` baris: transkrip viewport + dropdown `/` + blok input +
// status bar. Kursor diparkir di posisi ketik setelah paint.
//
// Batas lapisan: semua yang berbau sesi/model/turn datang via TuiHost yang
// di-inject dari cli/ (composition root). src/ui TAK BOLEH impor cli/.
import type { UiBus, UiPresentationActivity } from "../contract.ts"
import { type FooterStatus, renderFooter, type TimerHighlight } from "../footer.ts"
import { t } from "../i18n/locale.ts"
import {
  applyKey,
  createDecoderState,
  createKeyStreamPump,
  createState,
  cursorLineIndex,
  type DecoderState,
  type KeyStreamPump,
  type PromptKey,
  type PromptState,
  toGraphemes,
} from "../input/prompt-engine.ts"
import { sanitizeAnsi, sanitizeAnsiLine, stripSgr } from "../render/sanitize.ts"
import { c } from "../render/theme.ts"
import {
  charWidth,
  chunkByWidth,
  displayWidth,
  escapeLength,
  truncateToWidth,
} from "../render/width.ts"
import { motionReduced } from "../runtime/motion.ts"
import { type AltScreen, forceRestoreScreenForSignal, openAltScreen } from "../runtime/screen.ts"
import type { Transcript, TranscriptPoint, TranscriptRow } from "./transcript.ts"

export interface TuiStatusSnapshot {
  footer: FooterStatus
  busy: boolean
  pinnedActivity?: UiPresentationActivity
}

export interface TuiHost {
  bus: UiBus
  /** Status untuk bar status (mode/model/cwd/konteks dari sumber = footer). */
  getStatus(): TuiStatusSnapshot
  /** Hint dropdown untuk baris "/" (slash + skill, difilter prefix). */
  listCommands(prefix: string): string[]
  /**
   * Eksekusi baris yang di-submit: builtin (/exit, /clear, /help, …) atau
   * prompt ke model. Resolve {quit:true} untuk keluar. Throw = App tampilkan
   * sebagai baris error (tak ada jalur diam).
   */
  submit(text: string): Promise<{ quit?: boolean } | undefined>
  /** Batalkan turn yang berjalan (Esc saat busy). */
  abort(): void
  copySelection(text: string): boolean
  /** Putar mode permission (Tab / Shift+Tab). */
  cycleMode(dir: 1 | -1): void
  /** Toggle compact / reasoning (Ctrl+O / Ctrl+T). */
  toggleCompact(): void
  toggleReasoning(): void
}

export interface TuiRunResult {
  /** False = layar tak mampu (non-TTY/dumb/sempit) — caller fallback REPL. */
  started: boolean
  frames: number
}

/** Tinggi maksimum blok input (baris logis di-wrap, kursor selalu terlihat). */
const MAX_INPUT_ROWS = 5
/** Tinggi maksimum dropdown — sisa ruang di atas transcript minimum 3 baris. */
const MAX_DROPDOWN_ROWS = 8
const MIN_ROWS = 10
const MIN_COLS = 20

const PROMPT_FIRST = "minicode › "
const PROMPT_CONT = "  · "
const TIMER_TEXT = "00.00.00"
const DOT_INTERVAL_MS = 200
const DOT_PHASES = ["...", "..", ".", ".."] as const
const MOUSE_DRAG_ON = "\x1b[?1002h\x1b[?1006h"
const MOUSE_WHEEL_ON = "\x1b[?1000h\x1b[?1006h"
const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l"
const MAX_SELECTION_CHARS = 200_000
type MouseMode = "off" | "wheel" | "drag"

function mouseSelectionEnabled(): boolean {
  const value = process.env.MINICODE_MOUSE_SELECTION?.toLowerCase()
  return value !== "0" && value !== "false" && value !== "off" && value !== "no"
}

export function thinkingDots(now = Date.now(), startedAt = now, reduced = motionReduced()): string {
  if (reduced) return "..."
  const elapsed = Math.max(0, now - startedAt)
  return DOT_PHASES[Math.floor(elapsed / DOT_INTERVAL_MS) % DOT_PHASES.length]!
}

export function formatTimer(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return `${String(hours).padStart(2, "0")}.${String(minutes).padStart(2, "0")}.${String(rest).padStart(2, "0")}`
}

export function timerHighlight(ms: number): TimerHighlight {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds >= 3600) return "hours"
  if (seconds >= 60) return "minutes"
  return "seconds"
}

interface FrameLayout {
  frame: string[]
  cursor: { row: number; col: number }
  transcriptRows: TranscriptRow[]
  transcriptTop: number
  composerTop: number
  composerLines: string[]
  composerOffset: number
}

interface SelectionState {
  anchor: TranscriptPoint
  focus: TranscriptPoint
  dragging: boolean
}

interface RawStdin {
  setRawMode(v: boolean): void
  on(e: string, fn: (c: Buffer) => void): void
  removeListener(e: string, fn: (c: Buffer) => void): void
  resume(): void
  pause(): void
  isTTY?: boolean
}

function highlightColumns(text: string, start: number, end: number): string {
  if (end <= start) return text
  let out = ""
  let column = 0
  let active = false
  let i = 0
  while (i < text.length) {
    if (text[i] === "\x1b") {
      const length = escapeLength(text, i)
      if (length > 0) {
        out += text.slice(i, i + length)
        if (active) out += "\x1b[7m"
        i += length
        continue
      }
    }
    const codePoint = text.codePointAt(i)!
    const char = String.fromCodePoint(codePoint)
    const width = charWidth(codePoint)
    const next = column + width
    const inside = column < end && next > start
    if (inside && !active) {
      out += "\x1b[7m"
      active = true
    } else if (!inside && active) {
      out += "\x1b[27m"
      active = false
    }
    out += char
    column = next
    i += char.length
  }
  if (active) out += "\x1b[27m"
  return out
}

function graphemeOffsetAtColumn(text: string, column: number): number {
  const target = Math.max(0, column)
  let used = 0
  const units = toGraphemes(text)
  for (let i = 0; i < units.length; i++) {
    const width = displayWidth(units[i]!)
    if (target <= used + width / 2) return i
    used += width
    if (target <= used) return i + 1
  }
  return units.length
}

export class TuiApp {
  private state: PromptState = createState()
  private scrollBack = 0
  private history: string[] = []
  private histIdx = -1
  private draft = ""
  private editing = true
  private busy = false
  private thinkingActive = false
  private turnStartedAt = 0
  private activityTimer: ReturnType<typeof setTimeout> | undefined
  /** Timestamp abort terakhir (ms) — deteksi double-tap Esc = quit. */
  private lastAbortAt = 0
  /** Hint "tekan lagi untuk keluar" tampil sekali setelah abort pertama. */
  private abortHintOn = false
  private frames = 0
  private quitRequested = false
  private finish: (() => void) | null = null
  private decoder: DecoderState = createDecoderState()
  private pump: KeyStreamPump | null = null
  private onData: ((chunk: Buffer) => void) | null = null
  private onResize: (() => void) | null = null
  /**
   * Dua wrapper sinyal terpisah — Bun tidak menyampaikan nama sinyal ke
   * handler (argumen undefined, beda dengan Node), jadi pemetaan sinyal →
   * exit code dilakukan lewat pemasangan per-sinyal ke core di bawah.
   */
  private onSignalTerm: (() => void) | null = null
  private onSignalHup: (() => void) | null = null
  private onSignalInt: (() => void) | null = null

  private wasRaw = false
  /**
   * Kedalaman suspend (popup komposit memegang fokus). >0 = listener stdin
   * dilepas + repaint ditahan — byte masuk HANYA ke view popup.
   */
  private suspended = 0
  private stdin: RawStdin | null = null
  /** True setelah releaseTerminal (spawn anak): paint/repaint ditahan. */
  private released = false
  private mouseMode: MouseMode = "off"
  private selection: SelectionState | null = null
  private lastLayout: FrameLayout | null = null
  private onExit: (() => void) | null = null
  /**
   * Langganan bus untuk repaint live (streaming jawaban, ledger tool,
   * thinking): TANPA ini layar buta selama turn — teks baru hanya tampil
   * saat turn selesai / tombol ditekan. Coalesce 30ms agar burst chunk tak
   * melukis ulang tiap byte.
   */
  private busUnsubs: (() => void)[] = []
  private repaintTimer: ReturnType<typeof setTimeout> | undefined
  /** Ukuran transkrip saat terakhir ikut ekor (basis indikator "baru"). */
  private tailSize = 0
  /** Ukuran transkrip saat mulai scroll ke atas (basis hitung baris baru). */
  private scrollBase = 0
  /** Panjang visual terakhir (kunci posisi baca agar stream tak merampasnya). */
  private lastWrapped = 0

  constructor(
    private readonly transcript: Transcript,
    private readonly host: TuiHost,
  ) {}

  /** Jalan sampai quit. Alt-screen enter/exit SELALU berpasangan (I17). */
  async run(): Promise<TuiRunResult> {
    // Cek ukuran SEBELUM enter: terminal sempit langsung fallback tanpa
    // flicker masuk-keluar alt-screen (kontrak residual #7).
    const preRows = process.stdout.rows || 0
    const preCols = process.stdout.columns || 0
    if (preRows < MIN_ROWS || preCols < MIN_COLS) return { started: false, frames: 0 }
    const screen = openAltScreen()
    if (!screen.ok || screen.rows < MIN_ROWS || screen.cols < MIN_COLS) {
      try {
        screen.close()
      } catch {}
      return { started: false, frames: 0 }
    }
    const stdin = process.stdin as unknown as RawStdin
    this.stdin = stdin
    try {
      this.wasRaw =
        (stdin as unknown as { isRaw?: boolean }).isRaw ??
        (process.stdin as unknown as { isRaw?: boolean }).isRaw ??
        false
    } catch {
      this.wasRaw = false
    }
    const done = new Promise<void>((resolve) => (this.finish = resolve))
    this.pump = createKeyStreamPump({
      state: this.decoder,
      onKeys: (keys) => this.handleKeys(keys),
    })
    this.onData = (chunk: Buffer) => this.pump?.push(new Uint8Array(chunk))
    this.onResize = () => {
      // Saat popup fokus, view popup yang melukis ulang regionnya sendiri;
      // repaint penuh App akan menghapus popup dari layar.
      if (this.suspended > 0) return
      // Lukis layar AKTIF (bukan handle `screen` run() yang basi setelah
      // release+reacquire gagal — dulu repaint/resize melukis ke handle
      // tertutup sekaligus menimpa currentScreen baru dengannya).
      this.paintCurrent()
    }
    try {
      stdin.setRawMode(true)
    } catch {}
    try {
      stdin.resume()
    } catch {}
    stdin.on("data", this.onData)
    const stdout = process.stdout as unknown as {
      on(e: string, fn: () => void): void
      removeListener(e: string, fn: () => void): void
    }
    stdout.on("resize", this.onResize)
    // Sinyal fatal (temuan audit TUI-001): default kernel-kill TIDAK
    // menjalankan handler "exit" Node — terminal bisa tertinggal alt-screen
    // + raw mode. Dipasang per-run, dilepas di cleanup (pasangan ketat).
    // Handler TERPISAH per sinyal: Bun TIDAK menyampaikan nama sinyal ke
    // handler (argumen undefined — beda dengan Node), jadi satu handler
    // bersama tak bisa membedakan TERM vs HUP dari parameternya.
    // WAJIB tetap di blok sinkron yang sama dengan openAltScreen() di atas
    // (tanpa await di antaranya): sinyal hanya disampaikan antar-tick event
    // loop, jadi tak ada jendela nyata; sisipkan await di antara keduanya =
    // membuka race SIGTERM sebelum handler terpasang.
    const restoreAndExit = (code: number) => {
      try {
        stdin.setRawMode(false)
      } catch {}
      try {
        stdin.pause()
      } catch {}
      try {
        stdin.removeListener("data", this.onData!)
      } catch {}
      this.setMouseMode("off")
      forceRestoreScreenForSignal()
      // exit() eksplisit memicu handler "exit" yang tersisa (spinner,
      // turn-status) — best-effort sinkron. 128+n = konvensi "mati oleh
      // sinyal n" (SIGTERM=15 → 143, SIGHUP=1 → 129) agar automation
      // tetap bisa membedakan sebab.
      process.exit(code)
    }
    this.onSignalTerm = () => restoreAndExit(143)
    this.onSignalHup = () => restoreAndExit(129)
    this.onSignalInt = () => this.requestAbort()
    try {
      process.on("SIGTERM", this.onSignalTerm)
    } catch {
      this.onSignalTerm = null
    }
    try {
      process.on("SIGHUP", this.onSignalHup)
    } catch {
      this.onSignalHup = null
    }
    try {
      process.on("SIGINT", this.onSignalInt)
    } catch {
      this.onSignalInt = null
    }
    this.onExit = () => this.setMouseMode("off")
    try {
      process.on("exit", this.onExit)
    } catch {
      this.onExit = null
    }
    // Repaint live mengikuti event bus (stream teks, ledger, thinking).
    // Suspend menahan repaint (popup melukis sendiri); quit menahan semua.
    const requestPaint = () => {
      if (this.quitRequested || this.suspended > 0 || this.released) return
      if (this.repaintTimer !== undefined) return
      this.repaintTimer = setTimeout(() => {
        this.repaintTimer = undefined
        if (!this.quitRequested && this.suspended === 0 && !this.released) this.paintCurrent()
      }, 30)
      try {
        ;(this.repaintTimer as unknown as { unref?: () => void }).unref?.()
      } catch {}
    }
    const sub = (type: Parameters<UiBus["on"]>[0], handler?: (event: any) => void) => {
      try {
        this.busUnsubs.push(
          this.host.bus.on(type, (event: any) => {
            try {
              handler?.(event)
            } finally {
              requestPaint()
            }
          }),
        )
      } catch {}
    }
    sub("turn:started", () => {
      this.thinkingActive = false
      this.turnStartedAt = Date.now()
      this.startActivityClock()
    })
    sub("provider:extension", (event: { kind?: string }) => {
      if (event?.kind === "reasoning") this.thinkingActive = true
    })
    sub("provider:text", () => {
      this.thinkingActive = false
    })
    sub("execution:started", () => {
      this.thinkingActive = false
    })
    sub("execution:completed", () => {
      this.thinkingActive = false
    })
    sub("turn:completed", () => {
      this.thinkingActive = false
    })
    sub("context:compacted")
    this.tailSize = this.transcript.total()
    this.scrollBase = this.tailSize
    this.setMouseMode(mouseSelectionEnabled() ? "drag" : "off")
    this.paint(screen)
    await done
    // Cleanup: urutan penting — lepas listener dulu agar byte liar pasca-quit
    // tak memicu repaint ke layar yang sudah dikembalikan.
    stdin.removeListener("data", this.onData)
    stdout.removeListener("resize", this.onResize)
    if (this.repaintTimer !== undefined) {
      clearTimeout(this.repaintTimer)
      this.repaintTimer = undefined
    }
    this.stopActivityClock()
    for (const u of this.busUnsubs) {
      try {
        u()
      } catch {}
    }
    this.busUnsubs = []
    this.suspended = 0
    this.released = false
    if (this.onSignalTerm) {
      try {
        process.off("SIGTERM", this.onSignalTerm)
      } catch {}
      this.onSignalTerm = null
    }
    if (this.onSignalHup) {
      try {
        process.off("SIGHUP", this.onSignalHup)
      } catch {}
      this.onSignalHup = null
    }
    if (this.onSignalInt) {
      try {
        process.off("SIGINT", this.onSignalInt)
      } catch {}
      this.onSignalInt = null
    }
    if (this.onExit) {
      try {
        process.off("exit", this.onExit)
      } catch {}
      this.onExit = null
    }
    this.stdin = null
    this.pump.dispose()
    this.pump = null
    try {
      stdin.setRawMode(this.wasRaw)
    } catch {}
    try {
      stdin.pause()
    } catch {}
    try {
      // Tutup layar AKTIF (bisa diganti reacquireTerminal setelah spawn
      // gagal — menutup handle run() yang basi akan meninggalkan alt-screen
      // yatim; close() idempoten sehingga aman dua kali).
      this.setMouseMode("off")
      this.currentScreen?.close()
    } catch {}
    this.currentScreen = null
    return { started: true, frames: this.frames }
  }

  // ── Penanganan key ──

  private requestAbort(): void {
    if (!this.isBusy()) return
    try {
      this.host.abort()
    } catch {}
    const now = Date.now()
    const doubleTap = now - this.lastAbortAt < 1500
    if (!doubleTap) {
      this.abortHintOn = true
      this.startActivityClock()
    }
    this.lastAbortAt = now
    if (doubleTap) this.quit()
    else this.paintCurrent()
  }

  private handleKeys(keys: { key: PromptKey }[]): boolean {
    // Garda suspend: timer flush lone-ESC yang dipersenjatai SEBELUM suspend
    // tetap menembak setelah popup terbuka (listener dilepas, timer tidak).
    // Tanpa ini repaint penuh App 50ms kemudian menimpa region popup +
    // memutasi state di belakang view. Gagal-di-kode-lama.
    if (this.suspended > 0) return false
    for (const { key } of keys) {
      if (this.quitRequested) return true
      this.handleKey(key)
    }
    return this.quitRequested
  }

  private handleKey(key: PromptKey): void {
    if (key.type === "mouse") {
      this.handleMouse(key)
      return
    }
    if (key.type === "wheelup" || key.type === "wheeldown") {
      this.scrollBy(key.type === "wheelup" ? 0.5 : -0.5)
      return
    }
    // Scroll SELALU tersedia (menu buka/tutup, busy/idle, layar menciut) —
    // di-intercept sebelum engine supaya tak jadi histori maupun teks.
    // Dulu di bawah gate tooSmall: terminal menciut + turn busy = tak bisa
    // scroll maupun abort (harus kill -9).
    // Shift+PgUp/PgDn (ESC[5;2~/6;2~, didekode modifier 2 = shift) = setengah
    // halaman (temuan audit TUI-002): halaman penuh terlalu kasar untuk
    // transkrip panjang; Home/End = lompat top/tail (di bawah).
    if (key.type === "pageup" || key.type === "pagedown") {
      const mod = key.modifier ?? 0
      if (mod === 2) {
        this.scrollBy(key.type === "pageup" ? 0.5 : -0.5)
        return
      }
      this.scrollBy(key.type === "pageup" ? 1 : -1)
      return
    }
    // Home/End LOMPAT transkrip HANYA saat prompt kosong & tanpa dropdown
    // (temuan audit TUI-002): transkrip cap 5000 baris ≈ 125 halaman —
    // menekan PgUp 125× bukan navigasi. Home = baris teratas, End = kembali
    // ke ekor. Baris BERISI = tombol editing (awal/akhir baris, kontrak lama);
    // dropdown terbuka = navigasi menu (jalur engine).
    if ((key.type === "home" || key.type === "end") && !this.state.menuOpen && !this.state.line) {
      const logical = key.type === "home"
      if (logical || this.scrollBack !== 0) {
        this.jumpEdge(logical)
        return
      }
      // End saat sudah di ekor: biarkan ke engine (kebiasaan editing —
      // tidak ada yang berubah, action "none").
      this.applyEngine(key)
      return
    }
    if (key.type === "ctrl-c") {
      if (this.selection && !this.selection.dragging) this.copySelection()
      return
    }
    // Abort/batal: Esc — berlaku juga saat layar menciut (jalan keluar saat
    // terminal mengecil di tengah turn busy). Jalan keluar saat abort macet
    // (provider/tool non-kooperatif abaikan sinyal): Esc dua kali dalam 1.5 dtk,
    // atau Ctrl+D baris-kosong, = abort + quit. Tanpa ini sesi hanya bisa
    // dibunuh kill -9 (kontrak I14).
    if (key.type === "esc" && this.selection) {
      this.selection = null
      this.paintCurrent()
      return
    }
    if (key.type === "esc") {
      if (this.isBusy()) {
        this.requestAbort()
        return
      }
      if (this.tooSmall()) return
      if (this.state.menuOpen) {
        this.applyEngine(key)
        return
      }
      if (this.state.line || this.editing) {
        this.state = createState()
        this.histIdx = -1
        this.editing = false
        this.paintCurrent()
      }
      return
    }
    // Terminal menciut di bawah minimum: abaikan SEMUA kecuali keluar.
    // Tanpa ini layout rusak (kolom negatif, kursor melompat) dan user
    // terkunci tanpa jalan keluar yang terlihat.
    if (this.tooSmall()) {
      if (key.type === "ctrl-d") this.quit()
      return
    }
    // Saat turn berjalan SEMUA input dibekukan kecuali abort (Esc), scroll
    // (mouse wheel/PgUp/PgDn di atas), dan Ctrl+D baris-kosong (= abort + quit,
    // jalan keluar saat abort macet — kontrak I14).
    if (this.isBusy()) {
      if (key.type === "ctrl-d" && !this.state.line) {
        try {
          this.host.abort()
        } catch {}
        this.quit()
      }
      return
    }
    if (key.type === "ctrl-d") {
      // Baris kosong = keluar (konvensi EOF); berisi = abaikan (I19).
      if (!this.state.line) this.quit()
      return
    }
    if (key.type === "tab") {
      this.host.cycleMode(1)
      this.paintCurrent()
      return
    }
    if (key.type === "shift-tab") {
      this.host.cycleMode(-1)
      this.paintCurrent()
      return
    }
    if (key.type === "ctrl-o") {
      this.host.toggleCompact()
      this.paintCurrent()
      return
    }
    if (key.type === "ctrl-t") {
      this.host.toggleReasoning()
      this.paintCurrent()
      return
    }
    if (key.type === "ctrl-r") {
      this.historySearch()
      return
    }
    // Up/Down di luar menu: jika teks multi-line, navigasi baris dalam teks dulu.
    // Hanya picu navigasi histori bila Up di baris pertama atau Down di baris terakhir.
    if ((key.type === "up" || key.type === "down") && !this.state.menuOpen) {
      if (this.state.line.includes("\n")) {
        const { lineIdx, colIdx } = cursorLineIndex(this.state.line, this.state.cursor)
        const lines = this.state.line.split("\n")
        if (key.type === "up" && lineIdx > 0) {
          const targetLine = lineIdx - 1
          const targetCol = Math.min(colIdx, toGraphemes(lines[targetLine] ?? "").length)
          let newCursor = 0
          for (let i = 0; i < targetLine; i++) newCursor += toGraphemes(lines[i] ?? "").length + 1
          newCursor += targetCol
          this.state = { ...this.state, cursor: newCursor }
          this.paintCurrent()
          return
        }
        if (key.type === "down" && lineIdx < lines.length - 1) {
          const targetLine = lineIdx + 1
          const targetCol = Math.min(colIdx, toGraphemes(lines[targetLine] ?? "").length)
          let newCursor = 0
          for (let i = 0; i < targetLine; i++) newCursor += toGraphemes(lines[i] ?? "").length + 1
          newCursor += targetCol
          this.state = { ...this.state, cursor: newCursor }
          this.paintCurrent()
          return
        }
      }
      this.historyNav(key.type === "up" ? -1 : 1)
      return
    }
    this.applyEngine(key)
  }

  private applyEngine(key: PromptKey): void {
    if (["char", "backspace", "delete", "enter", "ctrl-j"].includes(key.type)) this.selection = null
    const hints = (line: string) => (line.startsWith("/") ? this.host.listCommands(line) : [])
    const { state, action } = applyKey(this.state, key, hints)
    this.state = state
    if (action === "submit") {
      void this.doSubmit(state.line)
    } else if (action === "cancel") {
      // Engine cancel (ctrl-c/ctrl-d) sudah ditangani di atas; tak terjangkau.
    } else if (action === "render" || action === "none") {
      if (action === "render" && key.type === "char") this.editing = true
      // Ketikan baru = kembali ke ekor (I18); stream turn TIDAK me-reset
      // (user yang sedang membaca ke atas tak dirampas).
      if (key.type === "char" || key.type === "backspace" || key.type === "delete") {
        this.followTail()
      }
      this.paintCurrent()
    }
  }

  private async doSubmit(rawLine: string): Promise<void> {
    const line = rawLine.trim()
    this.state = createState()
    this.histIdx = -1
    this.editing = false
    this.followTail()
    this.abortHintOn = false
    if (!line) {
      this.paintCurrent()
      return
    }
    this.rememberHistory(line)
    this.transcript.pushUser(rawLine)
    this.busy = true
    this.thinkingActive = false
    this.turnStartedAt = Date.now()
    this.lastAbortAt = 0
    this.startActivityClock()
    this.paintCurrent()
    try {
      const res = await this.host.submit(line)
      if (res?.quit) this.quit()
    } catch (e) {
      this.transcript.pushError(e instanceof Error ? e.message : String(e))
    } finally {
      this.busy = false
      this.editing = true
      this.turnStartedAt = 0
      this.stopActivityClock()
      if (!this.quitRequested) this.paintCurrent()
    }
  }

  private quit(): void {
    if (this.quitRequested) return
    try {
      this.host.abort()
    } catch {}
    this.stopActivityClock()
    this.quitRequested = true
    this.finish?.()
  }

  /**
   * Minta keluar (dipakai controller saat terminal tak bisa dihidupkan lagi
   * setelah spawn gagal — daripada TUI mati tanpa layar).
   */
  requestQuit(): void {
    this.quit()
  }

  /**
   * Bekukan App untuk popup komposit: lepas listener stdin (byte masuk HANYA
   * ke view popup — anti double-handling) + redupkan layar sebagai backdrop.
   * View melukis kotaknya sendiri via paintRegion; tutup = resume().
   */
  suspend(): void {
    if (!this.currentScreen || this.quitRequested) return
    if (this.suspended++ > 0) return
    if (this.selection) this.selection.dragging = false
    this.decoder.pending = []
    this.setMouseMode("wheel")
    try {
      if (this.onData) this.stdin?.removeListener("data", this.onData)
    } catch {}
    this.paintDimmed()
  }

  /**
   * Kembalikan fokus: rebut raw mode + pasang listener + repaint penuh
   * (menimpa region popup). Idempoten terhadap resume berlebih. No-op bila
   * terminal dilepas untuk spawn anak (releaseTerminal) — kebangkitan
   * eksplisit lewat reacquireTerminal.
   */
  resume(): void {
    if (this.released || this.suspended <= 0) return
    if (--this.suspended > 0) return
    try {
      this.stdin?.setRawMode(true)
    } catch {}
    try {
      if (this.onData) this.stdin?.on("data", this.onData)
    } catch {}
    this.setMouseMode(mouseSelectionEnabled() ? "drag" : "off")
    if (this.isBusy()) this.startActivityClock()
    this.paintCurrent()
  }

  /**
   * Lepas terminal untuk spawn anak stdio-inherit (/sessions <id>): keluar
   * alt-screen + cooked mode + lepas listener. Tanpa ini anak mewarisi buffer
   * ?1049h + raw mode (double-ENTER, EXIT anak merobek buffer parent,
   * stdin mentah macet). Gagal-di-kode-lama: layar korup + terminal rusak
   * setelah anak keluar.
   */
  releaseTerminal(): void {
    this.stopActivityClock()
    try {
      if (this.onData) this.stdin?.removeListener("data", this.onData)
    } catch {}
    try {
      this.stdin?.setRawMode(false)
    } catch {}
    try {
      this.setMouseMode("off")
      this.currentScreen?.close()
    } catch {}
    this.currentScreen = null
    this.lastLayout = null
    this.released = true
  }

  /**
   * Hidupkan kembali terminal setelah release (jalur spawn GAGAL — anak tak
   * jalan sehingga parent harus lanjut). No-op bila tidak dilepas. False =
   * terminal tak mampu lagi → pemanggil harus quit. Listener stdin TIDAK
   * dipasang di sini (tugas resume() di finally pemanggil) agar tak ganda.
   */
  reacquireTerminal(): boolean {
    if (!this.released) return true
    if (this.quitRequested) return false
    const screen = openAltScreen()
    if (!screen.ok) return false
    this.currentScreen = screen
    this.released = false
    this.setMouseMode(!mouseSelectionEnabled() ? "off" : this.suspended > 0 ? "wheel" : "drag")
    try {
      this.stdin?.setRawMode(true)
    } catch {}
    if (this.isBusy()) this.startActivityClock()
    this.paintCurrent()
    return true
  }

  /** True saat popup/modal memegang fokus (input App dibekukan). */
  isSuspended(): boolean {
    return this.suspended > 0
  }

  /**
   * Bungkus baris dengan mode redup (\x1b[2m) untuk backdrop popup.
   * Reset (\x1b[0m atau \x1b[22m) dan bold (\x1b[1m) di dalam teks dinetralkan
   * agar peredupan tidak bocor di tengah baris yang diwarnai.
   */
  static applyBackdropDim(ln: string): string {
    if (!ln) return ""
    const esc = String.fromCharCode(27)
    let s = ln.replaceAll(`${esc}[1m`, "")
    s = s.replaceAll(`${esc}[22m`, `${esc}[2m`)
    s = s.replaceAll(`${esc}[0m`, `${esc}[0m${esc}[2m`)
    s = s.replaceAll(`${esc}[m`, `${esc}[0m${esc}[2m`)
    return `${esc}[2m${s}${esc}[22m${esc}[0m`
  }

  /** Layar redup sebagai backdrop popup: frame normal dibungkus faint. */
  private paintDimmed(): void {
    const screen = this.currentScreen
    if (!screen) return
    const cols = screen.cols
    const rows = screen.rows
    const snap = this.host.getStatus()
    const layout = this.buildLayout(rows, cols, snap)
    this.lastLayout = layout
    const dimmed = layout.frame.map((ln) => TuiApp.applyBackdropDim(ln))
    try {
      screen.paint(dimmed)
    } catch {}
    this.frames++
  }

  private isBusy(): boolean {
    if (this.busy) return true
    try {
      return this.host.getStatus().busy
    } catch {
      return false
    }
  }

  // ── Histori prompt (memori sesi; tak persist ke berkas REPL) ──

  private rememberHistory(line: string): void {
    if (this.history[this.history.length - 1] !== line) this.history.push(line)
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200)
  }

  private historyNav(dir: -1 | 1): void {
    if (!this.history.length) return
    if (this.histIdx === -1) {
      if (dir > 0) return
      this.draft = this.state.line
      this.histIdx = this.history.length - 1
    } else {
      const next = this.histIdx + dir
      if (next < 0) return
      if (next >= this.history.length) {
        this.histIdx = -1
        this.setLine(this.draft)
        return
      }
      this.histIdx = next
    }
    this.setLine(this.history[this.histIdx] ?? "")
  }

  private historySearch(): void {
    const prefix = this.state.line
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i]!
      if (h !== prefix && h.startsWith(prefix)) {
        this.setLine(h)
        return
      }
    }
  }

  private setLine(line: string): void {
    // Bangun ulang state lewat engine (aturan menu/sel ikut terjaga). Baris
    // berubah = kembali ke ekor (paritas ketikan — viewport tidak diam).
    this.followTail()
    let s = createState()
    const hints = (l: string) => (l.startsWith("/") ? this.host.listCommands(l) : [])
    for (const ch of line) {
      const r = applyKey(s, { type: "char", ch }, hints)
      s = r.state
      if (r.action !== "render" && r.action !== "none") break
    }
    this.state = s
    this.editing = true
    this.paintCurrent()
  }

  // ── Scroll ──

  private scrollBy(pages: number): void {
    const rows = process.stdout.rows || 24
    const page = Math.max(1, this.viewportHeight(rows, process.stdout.columns || 80) - 1)
    // scrollBack dihitung dalam BARIS agar presisi di terminal pendek. Basis
    // hitung "baris baru" dicatat saat mulai meninggalkan ekor. total()
    // (monotonik) dipakai agar evict cap 5000 tak merusak hitungan.
    // pages pecahan (±0.5) = setengah halaman (temuan audit TUI-002).
    if (this.scrollBack === 0 && pages > 0) this.scrollBase = this.transcript.total()
    this.scrollBack = Math.max(0, Math.round(this.scrollBack + pages * page))
    if (this.scrollBack === 0) {
      this.tailSize = this.transcript.total()
      this.scrollBase = this.tailSize
    }
    this.paintCurrent()
  }

  /**
   * Lompat ke ujung transkrip (temuan audit TUI-002): Home = baris teratas
   * (scrollBack maksimum), End = ekor. `lastWrapped` dinetralkan SEBELUM
   * perhitungan kunci-posisi-baca berikutnya: jendela yang sengaja dipindah
   * user bukan drift stream, tanpa ini paint pertama post-jump menarik
   * viewport kembali ke ekor (lompatan tak terlihat).
   */
  private jumpEdge(top: boolean): void {
    const rows = process.stdout.rows || 24
    const cols = process.stdout.columns || 80
    const curWrapped = this.transcript.wrappedLength(cols)
    this.lastWrapped = curWrapped
    if (top) {
      const viewH = Math.max(1, this.viewportHeight(rows, cols) - 1)
      if (this.scrollBack === 0) this.scrollBase = this.transcript.total()
      this.scrollBack = Math.max(0, curWrapped - viewH)
    } else {
      this.scrollBack = 0
      this.tailSize = this.transcript.total()
      this.scrollBase = this.tailSize
    }
    this.paintCurrent()
  }

  /** Kembali ke ekor: dipakai tiap ketikan/submit baru (I18). */
  private followTail(): void {
    this.scrollBack = 0
    this.tailSize = this.transcript.total()
    this.scrollBase = this.tailSize
  }

  /** Kosongkan transkrip (/clear): viewport + basis scroll ikut di-reset agar
   * tak tertinggal scrollBack basi (layar kosong + user harus PgDn manual). */
  clearView(): void {
    this.transcript.clear()
    this.followTail()
    this.lastWrapped = 0
    this.paintCurrent()
  }

  private startActivityClock(): void {
    if (this.activityTimer || this.quitRequested) return
    const tick = () => {
      this.activityTimer = undefined
      if (!this.isBusy() || this.quitRequested) return
      if (this.suspended === 0 && !this.released) this.paintCurrent()
      this.startActivityClock()
    }
    this.activityTimer = setTimeout(tick, DOT_INTERVAL_MS)
    try {
      ;(this.activityTimer as unknown as { unref?: () => void }).unref?.()
    } catch {}
  }

  private stopActivityClock(): void {
    if (this.activityTimer !== undefined) {
      clearTimeout(this.activityTimer)
      this.activityTimer = undefined
    }
  }

  private activityStatus(snap: TuiStatusSnapshot): string {
    const activity = snap.pinnedActivity
    if (!activity) return ""
    const name = sanitizeAnsiLine(String(activity.name ?? ""))
    const target = activity.target ? ` ${sanitizeAnsiLine(String(activity.target))}` : ""
    return sanitizeAnsiLine(`${name}${target}`)
  }

  private activityRow(content: string, cols: number): string {
    const width = Math.max(1, Math.floor(cols) - 1)
    return truncateToWidth(sanitizeAnsiLine(content), width, "")
  }

  private composerRows(
    cols: number,
    snap: TuiStatusSnapshot,
    busy: boolean,
    now: number,
  ): string[] {
    if (busy) {
      const start = this.turnStartedAt || now
      const status = this.activityStatus(snap)
      const content = this.thinkingActive ? thinkingDots(now, start) : status
      return [this.activityRow(content, cols)]
    }
    if (!this.editing) return [""]
    return this.inputRows(cols)
  }

  private composerHeight(cols: number, busy = this.busy): number {
    if (busy || !this.editing) return 1
    return Math.min(MAX_INPUT_ROWS, Math.max(1, this.inputRows(cols).length))
  }

  // ── Paint ──

  private currentScreen: AltScreen | null = null

  private setMouseMode(mode: MouseMode): void {
    if (this.mouseMode === mode) return
    const sequence = mode === "drag" ? MOUSE_DRAG_ON : mode === "wheel" ? MOUSE_WHEEL_ON : MOUSE_OFF
    try {
      if (mode === "off" || this.mouseMode === "off") process.stdout.write(sequence)
      else if (mode === "drag") process.stdout.write(`\x1b[?1000l${sequence}`)
      else process.stdout.write(`\x1b[?1002l${sequence}`)
      this.mouseMode = mode
    } catch {}
  }

  private paintCurrent(): void {
    if (this.currentScreen) this.paint(this.currentScreen)
  }

  /**
   * Repaint eksplisit untuk pemilik sink eksternal (approval): blok yang baru
   * dicatat harus terlihat SEBELUM user menjawab. No-op bila layar belum
   * jalan atau sudah quit.
   */
  repaint(): void {
    if (!this.quitRequested) this.paintCurrent()
  }

  private viewportHeight(rows: number, cols: number): number {
    const busy = this.isBusy()
    const inputH = this.composerHeight(cols, busy)
    const menuH = this.menuHeight(rows, cols, busy)
    return Math.max(1, rows - 2 - inputH - menuH)
  }

  private inputRows(cols: number): string[] {
    if (!this.editing) return []
    const w = Math.max(10, cols)
    const out: string[] = []
    if (!this.state.line) {
      out.push(PROMPT_FIRST)
      return out
    }
    const logical = this.state.line.split("\n")
    logical.forEach((ln, idx) => {
      const prefix = idx === 0 ? PROMPT_FIRST : PROMPT_CONT
      const full = `${prefix}${ln}`
      const wrapped = chunkByWidth(full, w)
      if (!wrapped.length) out.push(full)
      else for (const r of wrapped) out.push(r)
    })
    return out
  }

  private menuRows(rows: number, cols: number, busy = this.isBusy()): string[] {
    if (!this.editing || busy || !this.state.menuOpen || !this.state.line.startsWith("/")) return []
    const hints = this.host.listCommands(this.state.line)
    if (!hints.length) return []
    const room = Math.max(0, rows - 2 - this.composerHeight(cols, busy) - 3)
    const shown = hints.slice(0, Math.min(MAX_DROPDOWN_ROWS, room))
    const w = Math.max(10, cols)
    const out: string[] = [c.muted(t("app.menuHeader"))]
    shown.forEach((h, i) => {
      const picked = i === this.state.sel
      const text = sanitizeAnsiLine(h)
      out.push(picked ? c.accent(`› ${text}`) : `  ${text}`)
    })
    if (hints.length > shown.length)
      out.push(c.muted(t("app.moreLines", { n: hints.length - shown.length })))
    return out.map((l) => chunkByWidth(l, w)[0] ?? "")
  }

  private menuHeight(rows: number, cols: number, busy = this.isBusy()): number {
    return this.menuRows(rows, cols, busy).length
  }

  private selectedRange(row: TranscriptRow): { start: number; end: number } | null {
    const selection = this.selection
    if (!selection || !row.selectable || row.sourceId < 0) return null
    const first =
      this.transcript.comparePoints(selection.anchor, selection.focus) <= 0
        ? selection.anchor
        : selection.focus
    const last = first === selection.anchor ? selection.focus : selection.anchor
    const rowStart = { id: row.sourceId, offset: row.sourceStart }
    const rowEnd = { id: row.sourceId, offset: row.sourceEnd }
    if (this.transcript.comparePoints(last, rowStart) < 0) return null
    if (this.transcript.comparePoints(first, rowEnd) > 0) return null
    const start =
      first.id === row.sourceId ? Math.max(row.sourceStart, first.offset) : row.sourceStart
    const end = last.id === row.sourceId ? Math.min(row.sourceEnd, last.offset) : row.sourceEnd
    if (end <= start) return null
    return {
      start: this.transcript.columnAtOffset(row, start),
      end: this.transcript.columnAtOffset(row, end),
    }
  }

  private scheduleSelectionPaint(): void {
    if (this.repaintTimer !== undefined) return
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = undefined
      if (!this.quitRequested && this.suspended === 0 && !this.released) this.paintCurrent()
    }, 16)
    try {
      ;(this.repaintTimer as unknown as { unref?: () => void }).unref?.()
    } catch {}
  }

  private movePromptCursor(
    layout: FrameLayout,
    key: Extract<PromptKey, { type: "mouse" }>,
  ): boolean {
    if (this.isBusy() || !this.editing) return false
    const relativeRow = key.y - 1 - layout.composerTop
    const targetRow = layout.composerOffset + relativeRow
    if (relativeRow < 0 || targetRow < 0) return false
    const w = Math.max(10, process.stdout.columns || 80)
    const logical = this.state.line.split("\n")
    let rowIndex = 0
    let baseCodeUnits = 0
    for (let lineIndex = 0; lineIndex < logical.length; lineIndex++) {
      const line = logical[lineIndex] ?? ""
      const prefix = lineIndex === 0 ? PROMPT_FIRST : PROMPT_CONT
      const rows = chunkByWidth(`${prefix}${line}`, w)
      if (targetRow < rowIndex + rows.length) {
        const row = rows[targetRow - rowIndex] ?? ""
        const plain = stripSgr(sanitizeAnsi(row))
        const body = plain.startsWith(prefix) ? plain.slice(prefix.length) : plain
        const targetColumn = Math.max(
          0,
          key.x - 1 - (plain.startsWith(prefix) ? displayWidth(prefix) : 0),
        )
        const local = graphemeOffsetAtColumn(body, targetColumn)
        const base = toGraphemes(this.state.line.slice(0, baseCodeUnits)).length
        this.state = { ...this.state, cursor: base + local }
        this.histIdx = -1
        this.editing = true
        this.selection = null
        this.paintCurrent()
        return true
      }
      rowIndex += rows.length
      baseCodeUnits += line.length + 1
    }
    return false
  }

  private handleMouse(key: Extract<PromptKey, { type: "mouse" }>): void {
    if (key.action === "move" || (key.action !== "release" && key.button !== 0)) return
    const layout = this.lastLayout
    if (!layout) return
    const rowIndex = key.y - 1 - layout.transcriptTop
    const row = rowIndex >= 0 ? layout.transcriptRows[rowIndex] : undefined
    if (key.action === "press") {
      if (!row) {
        if (this.movePromptCursor(layout, key)) return
        this.selection = null
        this.paintCurrent()
        return
      }
      const point = this.transcript.pointAt(row, key.x - 1)
      if (!point) {
        this.selection = null
        this.paintCurrent()
        return
      }
      this.selection = { anchor: point, focus: point, dragging: true }
      this.paintCurrent()
      return
    }
    if (key.action === "drag") {
      if (!this.selection?.dragging || !row) return
      const point = this.transcript.pointAt(row, key.x - 1)
      if (!point) return
      this.selection.focus = point
      this.scheduleSelectionPaint()
      return
    }
    if (key.action === "release") {
      if (!this.selection?.dragging) return
      if (row) {
        const point = this.transcript.pointAt(row, key.x - 1)
        if (point) this.selection.focus = point
      }
      this.selection.dragging = false
      this.paintCurrent()
    }
  }

  private copySelection(): void {
    const selection = this.selection
    if (!selection) return
    const text = this.transcript.selectionText(selection.anchor, selection.focus).trim()
    if (!text) {
      this.selection = null
      this.paintCurrent()
      return
    }
    if (text.length > MAX_SELECTION_CHARS) {
      this.transcript.pushInfo([c.warning(t("tui.selectionTooLarge"))])
      this.paintCurrent()
      return
    }
    let copied = false
    try {
      copied = this.host.copySelection(text)
    } catch {}
    if (copied) this.transcript.pushInfo([c.muted(t("tui.selectionCopied"))])
    else this.transcript.pushInfo([c.muted(t("tui.selectionCopyFailed"))])
    this.paintCurrent()
  }

  private buildLayout(rows: number, cols: number, snap: TuiStatusSnapshot): FrameLayout {
    const height = Math.max(1, Math.floor(rows))
    const width = Math.max(1, Math.floor(cols))
    const busy = this.busy || snap.busy
    const now = Date.now()
    if (busy) {
      if (!this.turnStartedAt) this.turnStartedAt = now
      this.startActivityClock()
    } else {
      this.thinkingActive = false
      this.turnStartedAt = 0
    }
    const newCount = this.scrollBack > 0 ? this.transcript.total() - this.scrollBase : 0
    const indicator: string[] = []
    if (busy && this.abortHintOn) indicator.push(c.warning(t("app.abortHint")))
    else if (newCount > 0) indicator.push(c.muted(t("app.newBelow", { n: newCount })))

    const allMenu = this.menuRows(height, width, busy)
    const allComposer = this.composerRows(width, snap, busy, now)
    const contentBudget = Math.max(1, height - 3 - indicator.length)
    let menu = allMenu
    let composerH = Math.min(MAX_INPUT_ROWS, Math.max(1, allComposer.length))
    if (menu.length + composerH > contentBudget) {
      menu = menu.slice(0, Math.max(0, contentBudget - 1))
      composerH = Math.max(1, contentBudget - menu.length)
    }
    const viewH = Math.max(1, height - 2 - composerH - menu.length - indicator.length)
    let viewport = this.transcript.viewport(width, viewH, this.scrollBack)
    const curWrapped = viewport.totalRows
    if (this.scrollBack > 0 && this.lastWrapped > 0) {
      const nextScrollBack = Math.max(
        0,
        Math.min(this.scrollBack + (curWrapped - this.lastWrapped), Math.max(0, curWrapped - 1)),
      )
      if (nextScrollBack !== this.scrollBack) {
        this.scrollBack = nextScrollBack
        viewport = this.transcript.viewport(width, viewH, this.scrollBack)
      }
    }
    this.lastWrapped = curWrapped
    if (
      this.selection &&
      (!this.transcript.hasSource(this.selection.anchor.id) ||
        !this.transcript.hasSource(this.selection.focus.id) ||
        (!this.selection.dragging &&
          !this.transcript.selectionText(this.selection.anchor, this.selection.focus)))
    ) {
      this.selection = null
    }
    const bodyRows = viewport.rows
    const body = bodyRows.map((row) => {
      const selected = this.selectedRange(row)
      return selected ? highlightColumns(row.text, selected.start, selected.end) : row.text
    })

    let shownComposer: string[]
    let cursorRow: number
    let cursorCol = 1
    let composerOffset = 0
    if (!busy && this.editing) {
      const cursor = this.cursorIndex(width)
      const winStart = Math.max(0, Math.min(allComposer.length - composerH, cursor.visIdx))
      composerOffset = winStart
      shownComposer = allComposer.slice(winStart, winStart + composerH)
      cursorRow = viewH + menu.length + indicator.length + (cursor.visIdx - winStart) + 1
      cursorCol = cursor.col
    } else {
      shownComposer = allComposer.slice(0, composerH)
      cursorRow = viewH + menu.length + indicator.length + 1
    }

    const started = this.turnStartedAt || now
    const sparkFrame =
      busy && !motionReduced() ? Math.max(1, Math.floor((now - started) / DOT_INTERVAL_MS) + 1) : 0
    const elapsed = now - started
    const timer = busy ? formatTimer(elapsed) : TIMER_TEXT
    const footer =
      renderFooter(
        {
          ...snap.footer,
          sparkFrame,
          timer,
          timerActive: busy,
          timerHighlight: timerHighlight(elapsed),
        },
        width,
      )[0] ?? ""
    const frame = [...body, ...menu, ...indicator, ...shownComposer, "", footer]
    const rawLength = frame.length
    const crop = Math.max(0, rawLength - height)
    const topPad = Math.max(0, height - rawLength)
    while (frame.length < height) frame.unshift("")
    const out = frame.slice(-height)
    return {
      frame: out,
      cursor: {
        row: Math.max(1, Math.min(height, cursorRow + topPad - crop)),
        col: Math.max(1, cursorCol),
      },
      transcriptRows: bodyRows,
      transcriptTop: topPad - crop,
      composerTop: topPad - crop + body.length + menu.length + indicator.length,
      composerLines: allComposer,
      composerOffset,
    }
  }

  /** True bila terminal menciut di bawah minimum TUI (MIN_ROWS/MIN_COLS). */
  private tooSmall(): boolean {
    const cols = process.stdout.columns || 0
    const rows = process.stdout.rows || 0
    return rows < MIN_ROWS || cols < MIN_COLS
  }

  private paint(screen: AltScreen): void {
    this.currentScreen = screen
    const cols = screen.cols
    const rows = screen.rows
    if (this.tooSmall()) {
      this.lastLayout = null
      const w = Math.max(1, cols)
      const frame = [c.warning(truncateToWidth(t("tui.tooSmall"), w))]
      while (frame.length < Math.max(1, rows)) frame.push("")
      try {
        screen.paint(frame.slice(0, Math.max(1, rows)))
      } catch {}
      this.frames++
      return
    }
    const layout = this.buildLayout(rows, cols, this.host.getStatus())
    this.lastLayout = layout
    try {
      screen.paint(layout.frame, layout.cursor)
    } catch {}
    this.frames++
  }

  /**
   * Indeks baris visual kursor (koordinat PENUH inputAll) + kolom 1-based.
   * Wrap-aware; CJK/emoji dihitung per kolom via displayWidth.
   */
  private cursorIndex(cols: number): { visIdx: number; col: number } {
    // Baris kursor dalam teks logis → petakan ke baris visual (wrap-aware).
    const units = toGraphemes(this.state.line)
    const before = units.slice(0, Math.max(0, Math.min(this.state.cursor, units.length))).join("")
    const logicalIdx = before.split("\n").length - 1
    const lastLine = before.split("\n").pop() ?? ""
    const prefix = logicalIdx === 0 ? PROMPT_FIRST : PROMPT_CONT
    const targetWidth = displayWidth(prefix) + displayWidth(lastLine)
    const w = Math.max(10, cols)
    // Baris visual ke berapa (dari atas blok input) posisi kursor berada.
    let visIdx = 0
    const logical = this.state.line.split("\n")
    for (let li = 0; li < logical.length; li++) {
      const full = `${li === 0 ? PROMPT_FIRST : PROMPT_CONT}${logical[li] ?? ""}`
      const wrapped = chunkByWidth(full, w)
      const n = Math.max(1, wrapped.length)
      if (li < logicalIdx) {
        visIdx += n
        continue
      }
      // Baris kursor: kolom ke-n dalam wrap.
      let acc = 0
      for (let wi = 0; wi < n; wi++) {
        const ww = displayWidth(wrapped[wi] ?? "")
        if (targetWidth < acc + ww || wi === n - 1) {
          visIdx += wi
          // Kolom 1-based dalam baris visual — SAMA untuk baris tengah
          // maupun terakhir (dulu baris tengah selalu diparkir di EOL).
          return { visIdx, col: Math.max(1, targetWidth - acc + 1) }
        }
        acc += ww
      }
      visIdx += n - 1
      break
    }
    return { visIdx, col: 1 }
  }
}
