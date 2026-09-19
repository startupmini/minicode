// Kotak input TUI: state machine di atas prompt-engine MURNI.
//
// Peran: apa yang `askLine` lakukan untuk REPL linier (ketik, history,
// dropdown `/`, submit/cancel), tanpa satu byte IO — driver (P3,
// `cli/repl-tui.ts`) memompa byte stdin via feed() dan melukis blok hasil
// render() lewat `src/ui/tui/screen.ts`. Satu render per chunk (bukan per
// key): paste 50+ char tetap 1 frame bila driver me-render per event batch.
//
// Batas lapisan (dijaga test/ui-boundary): hanya `src/ui/*`, tanpa node
// import. Data (history, completion) masuk via DI dari driver — box tak
// tahu config, provider, atau skill apa pun. Semantik disalin persis dari
// `askLine` (Esc kosong=cancel, Ctrl+C/D=cancel, Enter=submit ter-trim,
// history ganti-baris + savedLine, edit memutus history, Tab dkk.
// diteruskan ke driver): yang berubah hanya renderer, bukan perilaku.
import {
  applyKey,
  buildRenderSpec,
  createDecoderState,
  createState,
  type DecoderState,
  decodeKeysStream,
  type PromptKey,
  type PromptState,
  pointLength,
  toGraphemes,
} from "../input/prompt-engine.ts"
import { sanitizeAnsi } from "../render/sanitize.ts"
import { c } from "../render/theme.ts"
import { displayWidth, truncateToWidth } from "../render/width.ts"

export interface TuiInputOptions {
  /** Prefix visual baris pertama (mis. `"minicode › "`, terhitung di kolom). */
  prompt: string
  /** Riwayat awal (milik driver: load/append via history fns). */
  history: string[]
  /** Sinkron + murah (dipanggil tiap keypress): daftar cocok penuh. */
  complete(query: string): string[]
  groupOf?: (text: string) => string
}

export type TuiInputEvent =
  | { type: "submit"; line: string }
  | { type: "cancel" }
  | { type: "render" }
  /** Diteruskan mentah ke driver (mode cycle, compact, thinking, search):
   * engine me-return none untuk ini dan state tak berubah. */
  | { type: "key"; key: PromptKey }

export interface TuiInputRender {
  /** Blok visual: [...baris input, ...baris dropdown]. */
  lines: string[]
  /** Indeks baris kursor DALAM blok (cocok untuk TuiCursor.line). */
  cursorLine: number
  /** Kolom tampil dalam baris itu. */
  cursorCol: number
}

export interface TuiInputBox {
  feed(chunk: Uint8Array): TuiInputEvent[]
  render(maxCols: number): TuiInputRender
  readonly line: string
  /** Ganti prefix prompt (mis. continuation `··· › `); me-reset draf. */
  setPrompt(prompt: string): void
  /** Ganti riwayat (driver reload per prompt seperti askLine). */
  setHistory(history: string[]): void
  /** Ganti isi baris (kursor ke ujung, menu ikut aturan `/` engine).
   * Dipakai reverse-search menerima hasil. */
  setLine(line: string): void
  reset(): void
}

// Kunci yang MEMUTUS mode history-browse (disalin dari askLine: setiap edit
// = edit baris baru, bukan lanjut navigasi). Daftar ini disengaja TIDAK
// mencakup home/end — sama seperti askLine.
const HISTORY_BREAK = new Set([
  "char",
  "ctrl-j",
  "backspace",
  "delete",
  "ctrl-w",
  "ctrl-u",
  "tab",
  "left",
  "right",
])

// Kunci milik driver (mode/compact/thinking/tambah): engine none,
// state utuh, driver yang menangani. Ctrl+R TIDAK di sini — reverse search
// ditangani box sendiri seperti askLine (lihat bawah).
const DRIVER_KEYS = new Set(["tab", "shift-tab", "ctrl-o", "ctrl-t", "ctrl-n"])

export function createTuiInput(opts: TuiInputOptions): TuiInputBox {
  let prompt = opts.prompt
  let history = opts.history
  let state: PromptState = createState()
  // Reverse-i-search ala readline (Ctrl+R), cermin askLine: filter substring
  // history (terbaru dulu); Up/tua, Down/muda; Enter terima; Esc/Ctrl+C
  // batal (baris utuh — search tak pernah menyentuh draf). Tombol lain
  // keluar dari search DULU lalu diproses normal.
  let search: { query: string; idx: number; saved: string } | null = null

  const searchMatches = (): string[] => {
    if (!search) return []
    const q = search.query
    const all = [...history].reverse()
    return q ? all.filter((h) => h.includes(q)) : all
  }

  const exitSearch = (accept: boolean): void => {
    if (!search) return
    if (accept) {
      const m = searchMatches()[search.idx]
      const line = m ?? search.saved
      state = { ...state, line, cursor: pointLength(line), sel: -1, menuOpen: line.startsWith("/") }
    }
    search = null
  }

  const isSearchKey = (key: PromptKey): boolean =>
    key.type === "char" ||
    key.type === "backspace" ||
    key.type === "up" ||
    key.type === "down" ||
    key.type === "enter" ||
    key.type === "esc" ||
    key.type === "ctrl-c" ||
    key.type === "ctrl-r"
  const decoder: DecoderState = createDecoderState()
  let historyIdx = -1
  let savedLine = ""

  const setHistoryLine = (line: string): void => {
    // Sama seperti askLine: recall mengganti baris + kursor di ujung,
    // menu TERTUTUP (dibuka lagi oleh edit berikutnya bila diawali "/").
    state = { ...state, line, cursor: pointLength(line), sel: -1, menuOpen: false }
  }

  const handleKey = (key: PromptKey): TuiInputEvent[] => {
    if (DRIVER_KEYS.has(key.type)) return [{ type: "key", key }]
    // Ctrl+R: masuk search (dari baris apapun); di dalam search, tangani
    // di bawah. Keluar search dulu untuk tombol lain.
    if (key.type === "ctrl-r" && !search) {
      search = { query: "", idx: 0, saved: state.line }
      return [{ type: "render" }]
    }
    if (search) {
      if (!isSearchKey(key)) {
        exitSearch(false)
        // Jatuh ke penanganan normal di bawah (tanpa return).
      } else {
        if (key.type === "char") {
          search.query += key.ch
          search.idx = 0
          return [{ type: "render" }]
        }
        if (key.type === "backspace") {
          const g = toGraphemes(search.query)
          g.pop()
          search.query = g.join("")
          search.idx = 0
          return [{ type: "render" }]
        }
        if (key.type === "up" || key.type === "ctrl-r") {
          const n = searchMatches().length
          if (n) search.idx = Math.min(search.idx + 1, n - 1)
          return [{ type: "render" }]
        }
        if (key.type === "down") {
          search.idx = Math.max(0, search.idx - 1)
          return [{ type: "render" }]
        }
        // Enter terima, Esc/Ctrl+C batal — keduanya keluar dari search.
        exitSearch(key.type === "enter")
        return [{ type: "render" }]
      }
    }
    // Esc pada baris KOSONG tanpa menu = batal (null) — dipakai dialog agar
    // Esc konsisten dengan picker/manager. Esc pada baris berisi TIDAK
    // batal: draf tak boleh hilang karena salah tekan.
    if (key.type === "esc" && !state.menuOpen && state.line === "") return [{ type: "cancel" }]
    // Navigasi history saat dropdown tertutup: GANTI baris (bukan gabung),
    // baris tulisan tersimpan dan kembali saat turun melewati terbaru.
    if ((key.type === "up" || key.type === "down") && !state.menuOpen) {
      const h = history
      if (!h.length) return []
      if (key.type === "up") {
        if (historyIdx < h.length - 1) {
          if (historyIdx === -1) savedLine = state.line
          historyIdx++
          setHistoryLine(h[h.length - 1 - historyIdx] ?? "")
          return [{ type: "render" }]
        }
        return []
      }
      if (historyIdx > 0) {
        historyIdx--
        setHistoryLine(h[h.length - 1 - historyIdx] ?? "")
        return [{ type: "render" }]
      }
      if (historyIdx === 0) {
        historyIdx = -1
        setHistoryLine(savedLine)
        return [{ type: "render" }]
      }
      return []
    }
    if (HISTORY_BREAK.has(key.type)) {
      historyIdx = -1
      savedLine = ""
    }
    const r = applyKey(state, key, (line) => opts.complete(line))
    state = r.state
    // Empty Enter = "" (bukan null): driver lanjut; null = cancel (keluar).
    // Trim seperti doSubmit askLine.
    if (r.action === "submit") return [{ type: "submit", line: state.line.trim() }]
    if (r.action === "cancel") return [{ type: "cancel" }]
    if (r.action === "render") return [{ type: "render" }]
    return []
  }

  return {
    get line() {
      return state.line
    },
    feed(chunk: Uint8Array): TuiInputEvent[] {
      const out: TuiInputEvent[] = []
      for (const d of decodeKeysStream(chunk, decoder)) out.push(...handleKey(d.key))
      return out
    },
    render(maxCols: number): TuiInputRender {
      if (search) {
        const m = searchMatches()[search.idx]
        const label = `(reverse-i-search)\`${search.query}': ${m ?? "(no match)"}`
        return {
          lines: [truncateToWidth(label, maxCols)],
          cursorLine: 0,
          cursorCol: displayWidth("(reverse-i-search)`") + displayWidth(search.query),
        }
      }
      const hints = opts.complete(state.line)
      const spec = buildRenderSpec(state, prompt, hints, opts.groupOf)
      const dd: string[] = []
      for (const row of spec.rows) {
        if (row.kind === "header") {
          dd.push(truncateToWidth(c.accent(c.bold(sanitizeAnsi(row.text))), maxCols))
        } else {
          const label = sanitizeAnsi(row.text)
          const text = row.picked ? c.accent(c.bold(label)) : label
          dd.push(truncateToWidth(`${row.picked ? "  › " : "    "}${text}`, maxCols))
        }
      }
      if (spec.moreCount > 0) dd.push(truncateToWidth(`    … ${spec.moreCount} more`, maxCols))
      // Baris visual input: prefix hanya di baris pertama; kursor dari
      // grapheme sebelum kursor (satuan grapheme — CJK/emoji aman).
      const parts = state.line.split("\n")
      const before = toGraphemes(state.line)
        .slice(0, Math.max(0, Math.min(state.cursor, toGraphemes(state.line).length)))
        .join("")
        .split("\n")
      const cursorLine = before.length - 1
      const cursorCol =
        (cursorLine === 0 ? displayWidth(prompt) : 0) +
        displayWidth(before[before.length - 1] ?? "")
      const lines = parts.map((p, i) => truncateToWidth(i === 0 ? `${prompt}${p}` : p, maxCols))
      return { lines: [...lines, ...dd], cursorLine, cursorCol }
    },
    setPrompt(p: string): void {
      prompt = p
    },
    setHistory(h: string[]): void {
      history = h
    },
    setLine(line: string): void {
      // Aturan menu sama seperti withLine engine + setHistoryLine di atas:
      // menu terbuka bila diawali "/", seleksi dijepit (di sini: tutup).
      state = { ...state, line, cursor: pointLength(line), sel: -1, menuOpen: line.startsWith("/") }
      historyIdx = -1
      savedLine = ""
    },
    reset() {
      state = createState()
      historyIdx = -1
      savedLine = ""
      search = null
    },
  }
}
