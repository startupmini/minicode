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
import { type FooterStatus, renderFooter } from "../footer.ts"
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
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c } from "../render/theme.ts"
import { chunkByWidth, displayWidth, truncateToWidth } from "../render/width.ts"
import { motionReduced } from "../runtime/motion.ts"
import {
  type AltScreen,
  forceRestoreScreenForSignal,
  openAltScreen,
  SYNC_UPDATE_END,
  SYNC_UPDATE_START,
} from "../runtime/screen.ts"
import type { Transcript } from "./transcript.ts"

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
  /** Batalkan turn yang berjalan (Esc/Ctrl+C saat busy). */
  abort(): void
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

interface RawStdin {
  setRawMode(v: boolean): void
  on(e: string, fn: (c: Buffer) => void): void
  removeListener(e: string, fn: (c: Buffer) => void): void
  resume(): void
  pause(): void
  isTTY?: boolean
}

export class TuiApp {
  private state: PromptState = createState()
  private scrollBack = 0
  private history: string[] = []
  private histIdx = -1
  private draft = ""
  private busy = false
  private tick = 0
  /** Timestamp abort terakhir (ms) — deteksi double-tap Esc/Ctrl+C = quit. */
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

  private wasRaw = false
  /**
   * Kedalaman suspend (popup komposit memegang fokus). >0 = listener stdin
   * dilepas + repaint ditahan — byte masuk HANYA ke view popup.
   */
  private suspended = 0
  private stdin: RawStdin | null = null
  /** True setelah releaseTerminal (spawn anak): paint/repaint ditahan. */
  private released = false
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
      forceRestoreScreenForSignal()
      // exit() eksplisit memicu handler "exit" yang tersisa (spinner,
      // turn-status) — best-effort sinkron. 128+n = konvensi "mati oleh
      // sinyal n" (SIGTERM=15 → 143, SIGHUP=1 → 129) agar automation
      // tetap bisa membedakan sebab.
      process.exit(code)
    }
    this.onSignalTerm = () => restoreAndExit(143)
    this.onSignalHup = () => restoreAndExit(129)
    try {
      process.on("SIGTERM", this.onSignalTerm)
      process.on("SIGHUP", this.onSignalHup)
    } catch {
      this.onSignalTerm = null
      this.onSignalHup = null
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
    const sub = (type: Parameters<UiBus["on"]>[0]) => {
      try {
        this.busUnsubs.push(this.host.bus.on(type, requestPaint))
      } catch {}
    }
    sub("provider:text")
    sub("provider:extension")
    sub("execution:started")
    sub("execution:completed")
    sub("turn:started")
    sub("turn:completed")
    sub("context:compacted")
    this.tailSize = this.transcript.total()
    this.scrollBase = this.tailSize
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
      this.currentScreen?.close()
    } catch {}
    this.currentScreen = null
    return { started: true, frames: this.frames }
  }

  // ── Penanganan key ──

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
    // Abort/batal: Esc & Ctrl+C — berlaku juga saat layar menciut (jalan
    // keluar saat terminal mengecil di tengah turn busy).
    // Jalan keluar saat abort macet (provider/tool non-kooperatif abaikan
    // sinyal): Esc/Ctrl+C KEDUA dalam 1.5 dtk, atau Ctrl+D baris-kosong,
    // = abort + quit. Tanpa ini sesi hanya bisa dibunuh kill -9 (kontrak I14).
    if (key.type === "esc" || key.type === "ctrl-c") {
      if (this.busy) {
        try {
          this.host.abort()
        } catch {}
        const now = Date.now()
        const doubleTap = now - this.lastAbortAt < 1500
        // Hint "tekan lagi untuk keluar" SEKALI setelah abort pertama (temuan
        // audit TUI-005): tanpa ini user yang menekan Esc dua kali untuk
        // "memastikan" justru keluar sesi tanpa sengaja — transkrip TUI hilang.
        // Hanya saat TIDAK double-tap; saat menciut indikator tak dilukis.
        if (!doubleTap) this.abortHintOn = true
        this.lastAbortAt = now
        if (doubleTap) this.quit()
        else this.paintCurrent()
        return
      }
      if (this.tooSmall()) return
      if (key.type === "esc" && this.state.menuOpen) {
        this.applyEngine(key)
        return
      }
      if (this.state.line) {
        this.state = createState()
        this.histIdx = -1
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
    // Saat turn berjalan SEMUA input dibekukan kecuali abort (Esc/Ctrl+C),
    // scroll (PgUp/PgDn di atas), dan Ctrl+D baris-kosong (= abort + quit,
    // jalan keluar saat abort macet — kontrak I14).
    if (this.busy) {
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
    const hints = (line: string) => (line.startsWith("/") ? this.host.listCommands(line) : [])
    const { state, action } = applyKey(this.state, key, hints)
    this.state = state
    if (action === "submit") {
      void this.doSubmit(state.line)
    } else if (action === "cancel") {
      // Engine cancel (ctrl-c/ctrl-d) sudah ditangani di atas; tak terjangkau.
    } else if (action === "render" || action === "none") {
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
    this.followTail()
    this.abortHintOn = false
    if (!line) {
      this.paintCurrent()
      return
    }
    this.rememberHistory(line)
    this.transcript.pushUser(rawLine)
    this.busy = true
    this.lastAbortAt = 0
    this.paintCurrent()
    try {
      const res = await this.host.submit(line)
      if (res?.quit) this.quit()
    } catch (e) {
      this.transcript.pushError(e instanceof Error ? e.message : String(e))
    } finally {
      this.busy = false
      if (!this.quitRequested) this.paintCurrent()
    }
  }

  private quit(): void {
    if (this.quitRequested) return
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
    try {
      if (this.onData) this.stdin?.removeListener("data", this.onData)
    } catch {}
    try {
      this.stdin?.setRawMode(false)
    } catch {}
    try {
      this.currentScreen?.close()
    } catch {}
    this.currentScreen = null
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
    try {
      this.stdin?.setRawMode(true)
    } catch {}
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
    const statusLine = renderFooter({ ...snap.footer, sparkFrame: 0 }, cols)[0] ?? ""
    const menu = this.menuRows(rows, cols)
    const inputAll = this.inputRows(cols)
    const inputH = Math.min(MAX_INPUT_ROWS, Math.max(1, inputAll.length))
    const viewH = Math.max(1, rows - 1 - inputH - menu.length)
    const body = this.transcript.view(cols, viewH, this.scrollBack)
    const frame: string[] = [...body, ...menu, ...inputAll.slice(-inputH), statusLine]
    while (frame.length < rows) frame.unshift("")
    const dimmed = frame.slice(-rows).map((ln) => TuiApp.applyBackdropDim(ln))
    try {
      screen.paint(dimmed)
    } catch {}
    this.frames++
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

  // ── Paint ──

  private currentScreen: AltScreen | null = null

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
    const inputH = this.inputHeight(cols)
    const menuH = this.menuHeight(rows, cols)
    return Math.max(1, rows - 1 - inputH - menuH)
  }

  private inputRows(cols: number): string[] {
    const w = Math.max(10, cols)
    const out: string[] = []
    // Baris kosong = placeholder redup (edukasi tanpa banjir): cara keluar
    // selalu terlihat (Ctrl+D), tanpa menuh-menuhi transkrip.
    if (!this.state.line) {
      const hint = c.faint(truncateToWidth(t("app.placeholder"), w - PROMPT_FIRST.length))
      out.push(`${PROMPT_FIRST}${hint}`)
      return out
    }
    const logical = this.state.line.split("\n")
    logical.forEach((ln, idx) => {
      const prefix = idx === 0 ? PROMPT_FIRST : PROMPT_CONT
      const full = `${prefix}${ln}`
      const wrapped = chunkByWidth(full, w)
      // Baris logis kosong tetap menempati 1 baris visual.
      if (!wrapped.length) out.push(full)
      else for (const r of wrapped) out.push(r)
    })
    return out
  }

  private inputHeight(cols: number): number {
    return Math.min(MAX_INPUT_ROWS, Math.max(1, this.inputRows(cols).length))
  }

  private menuRows(rows: number, cols: number): string[] {
    if (!this.state.menuOpen || !this.state.line.startsWith("/")) return []
    const hints = this.host.listCommands(this.state.line)
    if (!hints.length) return []
    const room = Math.max(0, rows - 1 - this.inputHeight(cols) - 3)
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

  private menuHeight(rows: number, cols: number): number {
    return this.menuRows(rows, cols).length
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
    // Layar menciut tengah sesi: satu bingkai pesan jujur (tepat `rows`
    // baris), bukan layout rusak. Kembali normal otomatis saat resize
    // (onResize → paint). Gagal-di-kode-lama: wrap pecah + kursor liar.
    if (this.tooSmall()) {
      const w = Math.max(1, cols)
      const frame = [c.warning(truncateToWidth(t("tui.tooSmall"), w))]
      while (frame.length < Math.max(1, rows)) frame.push("")
      try {
        screen.paint(frame.slice(0, Math.max(1, rows)))
      } catch {}
      this.frames++
      return
    }
    const snap = this.host.getStatus()
    // MINICODE_MOTION=0 (temuan audit TUI-006): spark statis redup — status
    // busy tak boleh bergantung pada animasi (aksesibilitas / rec / SSH lambat).
    this.tick = snap.busy ? this.tick + 1 : 0
    const statusLine =
      renderFooter(
        { ...snap.footer, sparkFrame: snap.busy && !motionReduced() ? this.tick : 0 },
        cols,
      )[0] ?? ""
    const menu = this.menuRows(rows, cols)
    const inputAll = this.inputRows(cols)
    const inputH = Math.min(MAX_INPUT_ROWS, Math.max(1, inputAll.length))
    // Indikator "output baru di bawah": user membaca ke atas saat stream
    // masuk — tanpa ini output baru lewat diam-diam. Makan 1 baris viewport.
    // total() monotonik: evict cap tak membuat hitungan negatif/hilang.
    const newCount = this.scrollBack > 0 ? this.transcript.total() - this.scrollBase : 0
    // Indikator + hint abort saling eksklusif (satu slot): scroll memakai slot
    // untuk "baris baru"; abort memakainya untuk petunjuk keluar.
    const indicator: string[] = []
    if (newCount > 0) indicator.push(c.muted(t("app.newBelow", { n: newCount })))
    else if (this.busy && this.abortHintOn) indicator.push(c.warning(t("app.abortHint")))
    const viewH = Math.max(1, rows - 1 - inputH - menu.length - indicator.length)
    // Kunci posisi baca: stream yang menambah baris saat user scroll ke atas
    // ikut menggeser scrollBack agar jendela menunjuk baris absolut yang sama
    // (dulu viewport merayap mengikuti ekor — kontrak I17).
    const curWrapped = this.transcript.wrappedLength(cols)
    if (this.scrollBack > 0 && this.lastWrapped > 0) {
      this.scrollBack = Math.max(
        0,
        Math.min(this.scrollBack + (curWrapped - this.lastWrapped), Math.max(0, curWrapped - 1)),
      )
    }
    this.lastWrapped = curWrapped
    const body = this.transcript.view(cols, viewH, this.scrollBack)
    // Jendela input mengikuti kursor: bila kursor di atas jendela ekor
    // (mis. paste 10 baris lalu Home), gulir ke atas agar kursor terlihat.
    // Tanpa ini baris atas tak terjangkau visual tapi kursor diparkir di
    // baris yang salah (dulu selalu slice ekor).
    const cursor = this.cursorIndex(cols)
    const winStart = Math.max(0, Math.min(inputAll.length - inputH, cursor.visIdx))
    const shownInput = inputAll.slice(winStart, winStart + inputH)
    const frame: string[] = [...body, ...menu, ...indicator, ...shownInput, statusLine]
    while (frame.length < rows) frame.unshift("")
    const out = frame.slice(-rows)
    try {
      screen.paint(out)
    } catch {}
    // Parkir kursor di posisi ketik (kolom terminal, bukan karakter).
    // Di dalam blok sync-update yang SAMA dengan frame (temuan audit TUI-007):
    // kursor yang ditulis setelah SYNC_END berpotensi tearing di emulator
    // tanpa ?2026 (frame tampil, kursor satu posisi lama).
    const cursorRow = viewH + menu.length + indicator.length + (cursor.visIdx - winStart) + 1
    try {
      process.stdout.write(
        `${SYNC_UPDATE_START}\x1b[?25l\x1b[${Math.max(1, cursorRow)};${Math.max(1, cursor.col)}H\x1b[?25h${SYNC_UPDATE_END}`,
      )
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
