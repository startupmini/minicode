// State UI per-sesi (PROMPT 06 · Area A — isolasi antar-instance).
//
// Kenapa TIDAK boleh singleton: `process.env` sudah dihapus sebagai media
// penyimpanan (F-ENV-1), tapi state module-local tetap SATU objek untuk
// seluruh proses. Dua sesi bersamaan (daemon multi-sesi; TUI sesi A + printer
// linier sesi B) saling menimpa — minimize tool di A mengubah tampilan B.
// Buffer /copy + error tertunda punya lifetime sama dengan state render, jadi
// memisahkannya ke singleton lain hanya menambah sumber kebenaran.
//
// Bentuk: SATU objek per sesi, dibuat composition root (`cli/setup.ts`) dan
// diteruskan lewat opsi eksplisit ke Transcript TUI + printer linier. Modul
// `render/collapse|detail|reasoning` tetap mengekspor API delegasi ke instance
// DEFAULT untuk call-site lama/one-shot; permukaan produksi tak memakainya.
//
// Env hanya NILAI AWAL (bootstrap), bukan tempat penyimpanan: setter di sini
// tak pernah menulis `process.env`.

import { splitTrailingEscape } from "./render/sanitize.ts"

export type CollapseSection = "thinking" | "tool" | "answer"

/** Isi section yang dikecilkan pada turn terakhir (untuk /expand). */
export interface CollapsedSectionView {
  label: string
  text: string
  /** Stream asal konten (kontrak Unix dipertahankan saat /expand mencetak). */
  stream: "stdout" | "stderr"
}

/** Cap per-entry + total untuk buffer section (/expand). */
const MAX_SECTION_CHARS = 200_000
const MAX_BUFFER_TOTAL = 500_000

/** Cap buffer /copy. */
export const LAST_TURN_MAX_CHARS = 200_000
export const MAX_COPY_TURNS = 10

export interface UiSessionStateOptions {
  minimizeAnswer?: boolean
  minimizeTool?: boolean
  compact?: boolean
  reasoningVisible?: boolean
}

/**
 * State milik SATU sesi (atau SATU renderer yang butuh state sendiri).
 *
 * Semua getter membaca field langsung saat dipanggil — jangan menyimpan
 * `state.compact` ke `const` di module scope (nilai beku saat import).
 */
export class UiSessionState {
  #activeSection: CollapseSection | null = null
  #minimizeAnswer: boolean
  #minimizeTool: boolean
  #compact: boolean
  #reasoningVisible: boolean
  #views: CollapsedSectionView[] = []

  // Buffer /copy + error tertunda (logger linier). Berlifecycle per sesi:
  // bertahan lintas re-attach per turn (lihat `cli/setup.ts` attachUI).
  #lastTurnText = ""
  #previousTurnTexts: string[] = []
  #pendingError: string | null = null

  constructor(opts: UiSessionStateOptions = {}) {
    // Env = NILAI AWAL saja. `??` dipakai supaya option eksplisit menang atas
    // env (bootstrap env tak bisa menimpa keputusan instance).
    this.#minimizeAnswer = opts.minimizeAnswer ?? process.env.MINICODE_MINIMIZE_ANSWER === "1"
    this.#minimizeTool = opts.minimizeTool ?? process.env.MINICODE_MINIMIZE_TOOL === "1"
    this.#compact = opts.compact ?? process.env.MINICODE_COMPACT === "1"
    this.#reasoningVisible = opts.reasoningVisible ?? process.env.MINICODE_SHOW_THINKING === "1"
  }

  // ── Collapse ────────────────────────────────────────────────────────────

  /** Section yang sedang aktif — keputusan tombol + / - saat turn berjalan. */
  get activeSection(): CollapseSection | null {
    return this.#activeSection
  }

  setActiveSection(k: CollapseSection | null): void {
    this.#activeSection = k
  }

  /** Section sedang dikecilkan? Thinking = invers reasoningVisible. */
  sectionMinimized(section: CollapseSection): boolean {
    if (section === "thinking") return !this.#reasoningVisible
    if (section === "answer") return this.#minimizeAnswer
    return this.#minimizeTool
  }

  /** Set eksplisit (nilai minimize) atau toggle bila `next` tidak diberikan.
   * Return nilai minimize terbaru. */
  setSectionMinimized(section: CollapseSection, next?: boolean): boolean {
    if (section === "thinking") {
      const vis = this.setReasoningVisible(next === undefined ? undefined : !next)
      return !vis
    }
    const cur = section === "answer" ? this.#minimizeAnswer : this.#minimizeTool
    const nxt = next ?? !cur
    if (section === "answer") this.#minimizeAnswer = nxt
    else this.#minimizeTool = nxt
    return nxt
  }

  /** Simpan isi section yang dikecilkan (cap per-entry + total). */
  rememberCollapsedSection(
    label: string,
    text: string,
    stream: CollapsedSectionView["stream"] = "stderr",
  ): void {
    if (!text) return
    // Cap jangan belah surrogate pair (U+FFFD di /expand) dan jangan sisakan
    // ekor escape parsial (SGR gantung ikut tercetak saat /expand).
    let cut = text.length > MAX_SECTION_CHARS ? text.slice(0, MAX_SECTION_CHARS) : text
    const last = cut.charCodeAt(cut.length - 1)
    if (cut.length > 0 && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
    cut = splitTrailingEscape(cut).head
    this.#views.push({ label, text: cut, stream })
    // Buang yang tertua sampai total dalam budget — terbaru selalu dipertahankan.
    let total = 0
    let keepFrom = this.#views.length
    for (let i = this.#views.length - 1; i >= 0; i--) {
      total += this.#views[i]!.text.length
      if (total > MAX_BUFFER_TOTAL) break
      keepFrom = i
    }
    if (keepFrom > 0) this.#views.splice(0, keepFrom)
  }

  clearCollapsedSections(): void {
    this.#views.length = 0
  }

  /** Konten section yang dikecilkan pada turn terakhir (untuk /expand). */
  collapsedSectionsSnapshot(): CollapsedSectionView[] {
    return [...this.#views]
  }

  // ── Detail (compact vs expanded) ────────────────────────────────────────

  get compact(): boolean {
    return this.#compact
  }

  set compact(v: boolean) {
    this.#compact = v
  }

  /** Set eksplisit (on/off) atau toggle bila `next` tidak diberikan. */
  setCompactMode(next?: boolean): boolean {
    const nextVal = next ?? !this.#compact
    this.#compact = nextVal
    return nextVal
  }

  // ── Reasoning ───────────────────────────────────────────────────────────

  get reasoningVisible(): boolean {
    return this.#reasoningVisible
  }

  set reasoningVisible(v: boolean) {
    this.#reasoningVisible = v
  }

  /** Set eksplisit (on/off) atau toggle bila `next` tidak diberikan. */
  setReasoningVisible(next?: boolean): boolean {
    const nextVal = next ?? !this.#reasoningVisible
    this.#reasoningVisible = nextVal
    return nextVal
  }

  // ── Buffer /copy (logger linier) ────────────────────────────────────────

  /** Isi output turn terakhir (teks model + hasil tool). */
  getLastTurnText(): string {
    return this.#lastTurnText
  }

  /** N turn terakhir, oldest-to-newest. */
  getLastTurnTexts(count = 1): string[] {
    const all = this.#lastTurnText
      ? [...this.#previousTurnTexts, this.#lastTurnText]
      : [...this.#previousTurnTexts]
    const n = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1
    return all.slice(-n)
  }

  /** Geser turn berjalan ke arsip (dipanggil saat turn baru mulai). */
  archiveTurn(): void {
    if (!this.#lastTurnText) return
    this.#previousTurnTexts.push(this.#lastTurnText)
    if (this.#previousTurnTexts.length > MAX_COPY_TURNS) this.#previousTurnTexts.shift()
    this.#lastTurnText = ""
  }

  /** Tambah teks ke buffer turn berjalan (dibatasi). */
  appendTurnText(s: string): void {
    if (!s) return
    this.#lastTurnText += s
    if (this.#lastTurnText.length > LAST_TURN_MAX_CHARS)
      this.#lastTurnText = this.#lastTurnText.slice(-LAST_TURN_MAX_CHARS)
  }

  // ── Error tertunda (logger linier) ──────────────────────────────────────

  setPendingError(e: string | null): void {
    this.#pendingError = e
  }

  /** Ambil + kosongkan error tertunda (consume-once per turn). */
  takePendingError(): string | null {
    const e = this.#pendingError
    this.#pendingError = null
    return e
  }

  /**
   * Kosongkan buffer /copy + error tertunda.
   *
   * [Area A] Reset ini EKSPLISIT, bukan implisit di `attachSimpleLogger`.
   * Sebelumnya attach (dipanggil tiap turn) wipe buffer — membuat `/copy [n]`
   * untuk n>1 selalu mengembalikan satu turn saja. Memindahkan reset ke sini
   * membuat batasnya jelas: sesi yang memulai sesi baru/uji yang butuh
   * kekaburan memanggil ini; pergantian turn biasa TIDAK.
   */
  resetCopyBuffer(): void {
    this.#lastTurnText = ""
    this.#previousTurnTexts = []
    this.#pendingError = null
  }
}

/**
 * Instance default — dipakai API modul lama (`render/collapse|detail|reasoning`)
 * dan jalur yang tak punya state sesi (one-shot/ekspor test).
 *
 * PERINGATAN: permukaan produksi yang punya sesi (TUI, printer linier) WAJIB
 * memakai instance miliknya sendiri; memakai default berarti state bersama
 * proses — persis cacat Area A yang ditutup di sini.
 */
export const defaultUiState = new UiSessionState()
