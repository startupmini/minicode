// Prompt engine - PURE functions untuk logika input interaktif.
// Sama sekali tidak menyentuh stdin/stdout - hanya data -> data.
// Dipakai askLine (src/ui/input/input.ts) + unit test.

import { displayWidth } from "../render/width.ts"

export interface PromptState {
  line: string
  /**
   * Posisi kursor dalam satuan CODE POINT (bukan UTF-16 unit), 0..len.
   * Tanpa ini tidak ada editing di tengah baris: user harus menghapus seluruh
   * sisa prompt untuk memperbaiki satu kata.
   */
  cursor: number
  sel: number // index seleksi dropdown, -1 = tidak ada
  menuOpen: boolean
}

export const MAX_VISIBLE = 10

// Hasil render satu frame - pure spec, renderer (input.ts) yang menulis ke stdout.
export interface RenderSpec {
  inputLine: string // prompt + line (baris 1)
  /** Kolom kursor (0-based) relatif awal inputLine — untuk ESC[<n>G. */
  cursorCol: number
  rows: { kind: "header" | "item"; text: string; picked: boolean }[] // baris dropdown
  moreCount: number // jumlah item tersembunyi (0 = tidak ada)
  totalRows: number // jumlah baris dropdown termasuk baris "more"
}

export function createState(): PromptState {
  return { line: "", cursor: 0, sel: -1, menuOpen: false }
}

// Keypress ter-normalisasi (hasil decode binari stdin).
export type PromptKey =
  | { type: "char"; ch: string }
  | { type: "backspace" }
  | { type: "delete" } // hapus karakter DI kursor (Del)
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "up" }
  | { type: "down" }
  // PgUp/PgDn (ESC[5~/[6~) — di TUI scroll viewport transkrip, bukan histori.
  | { type: "pageup" }
  | { type: "pagedown" }
  | { type: "tab" }
  | { type: "enter" }
  | { type: "esc" }
  | { type: "ctrl-c" }
  | { type: "ctrl-d" }
  | { type: "ctrl-u" } // clear line
  | { type: "ctrl-w" } // delete previous word
  | { type: "ctrl-o" } // expand detail (TUI)
  | { type: "ctrl-r" } // reverse-i-search history
  | { type: "ctrl-t" } // toggle expand/minimize reasoning di REPL
  | { type: "ctrl-n" } // tambah (model-manager: Ctrl+N = add model)
  | { type: "ctrl-j" } // sisipkan newline (multiline opt-in; Enter=\r tetap submit)
  | { type: "shift-tab" } // cycle mode (REPL linier) — ESC[Z didekode decodeKey
  | { type: "ignore" } // sekuens yang sengaja dibuang (mis. byte mouse)

// Terapkan satu keypress -> state baru + render spec + action (submit/cancel).
export type PromptAction = "none" | "render" | "submit" | "cancel"

// ── Helper grapheme ──
// String JS diindeks per UTF-16 unit; emoji memakai dua. Array.from memecah per
// code point, tapi grapheme cluster (ZWJ 👨‍👩‍👧, flag 🇮🇩, emoji + VS16 ❤️) tetap
// terbelah — backspace lalu menyisakan setengah. Intl.Segmenter membagi di
// batas grapheme sungguhan (Node 16+ / Bun tersedia); fallback ke code point
// di runtime tanpa dukungan.
let segmenter: Intl.Segmenter | undefined
export function toGraphemes(s: string): string[] {
  try {
    segmenter ??= new Intl.Segmenter("und", { granularity: "grapheme" })
    return [...segmenter.segment(s)].map((seg) => seg.segment)
  } catch {
    return Array.from(s)
  }
}

/** Panjang dalam satuan grapheme (bukan code point / UTF-16 unit). */
export function pointLength(s: string): number {
  return toGraphemes(s).length
}

/** Menghitung jumlah baris logis dalam teks prompt (berdasarkan separator \n). */
export function countLogicalLines(text: string): number {
  return text.split("\n").length
}

/** Menghitung indeks baris kursor (0-based) dan offset kolom dalam baris tersebut. */
export function cursorLineIndex(text: string, cursor: number): { lineIdx: number; colIdx: number } {
  const units = toGraphemes(text)
  const before = units.slice(0, Math.max(0, Math.min(cursor, units.length))).join("")
  const lines = before.split("\n")
  const lineIdx = lines.length - 1
  const colIdx = toGraphemes(lines[lineIdx] ?? "").length
  return { lineIdx, colIdx }
}

// Tanda diakritik Thai/Lao yang menempel: satu grapheme Thai bisa terdiri
// dari konsonan + 1-2 tanda (mis. U+0E19 U+0E49 U+0E33 = satu suku kata).
// Menghapus per grapheme (aturan emoji ZWJ) membuat satu backspace menelan
// SELURUH suku kata sekaligus — platform menghapus per code point untuk
// aksara ini (bug Claude #83449). deletePrevUnit memilih satuan hapus yang
// benar: diakritik terakhir dulu, lalu bertahap.
// (Range ditulis \u eksplisit — literal combining char pernah rusak jadi U+FFFD
// oleh pipeline PowerShell tanpa encoding, dijaga test/import-convention.)
const THAI_DEPENDENT = new RegExp(
  `[${String.fromCharCode(0x0e31)}-${String.fromCharCode(0x0e4e)}${String.fromCharCode(0x0ec8)}-${String.fromCharCode(0x0ecd)}]`,
)
export function deletePrevUnit(line: string, cursor: number): { line: string; cursor: number } {
  if (cursor <= 0) return { line, cursor }
  const pts = toGraphemes(line)
  const target = pts[cursor - 1] ?? ""
  if (THAI_DEPENDENT.test(target)) {
    // Potong satu code point terakhir cluster via indeks UTF-16 mentah.
    // Sisa cluster tetap 1 grapheme di posisi sama, jadi kursor BERTAHAN
    // (bukan mundur): backspace berikut menghapus diakritik berikutnya —
    // persis perilaku platform (satu suku kata butuh N kali tekan).
    // clampCursor menangani kasus sisa kosong (cluster tinggal 1 tanda).
    const at = unitIndex(line, cursor)
    const cps = Array.from(target)
    const lastLen = cps[cps.length - 1]?.length ?? 1
    const next = line.slice(0, at - lastLen) + line.slice(at)
    return { line: next, cursor: clampCursor(next, cursor) }
  }
  pts.splice(cursor - 1, 1)
  return { line: pts.join(""), cursor: cursor - 1 }
}

/** Konversi indeks grapheme -> indeks UTF-16, untuk slice(). */
function unitIndex(s: string, point: number): number {
  const pts = toGraphemes(s)
  let units = 0
  for (let i = 0; i < point && i < pts.length; i++) units += pts[i]!.length
  return units
}

function clampCursor(line: string, cursor: number): number {
  const max = pointLength(line)
  return cursor < 0 ? 0 : cursor > max ? max : cursor
}

/** Sisipkan `ins` pada posisi kursor; kursor maju sepanjang teks yang disisipkan. */
function insertAt(line: string, cursor: number, ins: string): { line: string; cursor: number } {
  const at = unitIndex(line, cursor)
  return {
    line: line.slice(0, at) + ins + line.slice(at),
    cursor: cursor + pointLength(ins),
  }
}

export function applyKey(
  state: PromptState,
  key: PromptKey,
  hints: (line: string) => string[],
): { state: PromptState; action: PromptAction } {
  const countOf = (line: string): number => hints(line).length
  const pickSelected = (line: string) => {
    const rows = hints(line)
    if (!rows.length) return null
    return state.sel >= 0 && state.sel < rows.length ? rows[state.sel]! : null
  }

  // Setiap perubahan baris memakai aturan menu yang sama: menu terbuka bila
  // baris dimulai "/", dan seleksi dijepit ke jumlah hint yang baru.
  const withLine = (line: string, cursor: number): PromptState => {
    const menuOpen = line.startsWith("/")
    return {
      line,
      cursor: clampCursor(line, cursor),
      sel: menuOpen ? Math.min(Math.max(state.sel, -1), countOf(line) - 1) : -1,
      menuOpen,
    }
  }
  // Melengkapi baris dari dropdown: kursor selalu ke ujung teks hasil.
  const completeTo = (text: string): PromptState => ({
    line: text,
    cursor: pointLength(text),
    sel: -1,
    menuOpen: false,
  })

  switch (key.type) {
    case "char": {
      // Paste bisa memuat newline/tab/kontrol. Dulu "\n" digepeng jadi spasi
      // agar tidak melebihi tinggi terminal, tapi itu membuat copas code
      // multilines cuma baris pertama (keluhan nyata). Sekarang "\n" dipertahankan
      // sebagai baris baru — renderer `scrollableMultiline` sudah memperhitungkan
      // tinggi (`nInGuess`, `maxVisible - footerReserveRows`) sehingga tidak
      // menabrak footer. Tab jadi spasi; kontrol lain dibuang.
      const ins = key.ch
        .replace(/\r\n|\r/g, "\n")
        .replace(/\t/g, " ")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: membuang byte kontrol dari paste
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      if (!ins) return { state, action: "none" }
      const { line, cursor } = insertAt(state.line, state.cursor, ins)
      return { state: withLine(line, cursor), action: "render" }
    }
    case "ctrl-j": {
      // Multiline opt-in eksplisit — BERBEDA dari paste yang digepeng jadi
      // spasi: keypress sadar user boleh membawa newline mentah. Render dan
      // history menanganinya per baris visual.
      const ins = insertAt(state.line, state.cursor, "\n")
      return { state: withLine(ins.line, ins.cursor), action: "render" }
    }
    case "backspace": {
      if (state.cursor === 0) return { state, action: "none" }
      const { line, cursor } = deletePrevUnit(state.line, state.cursor)
      return { state: withLine(line, cursor), action: "render" }
    }
    case "delete": {
      const pts = toGraphemes(state.line)
      if (state.cursor >= pts.length) return { state, action: "none" }
      pts.splice(state.cursor, 1)
      return { state: withLine(pts.join(""), state.cursor), action: "render" }
    }
    case "left": {
      if (state.cursor === 0) return { state, action: "none" }
      return { state: { ...state, cursor: state.cursor - 1 }, action: "render" }
    }
    case "right": {
      if (state.cursor >= pointLength(state.line)) return { state, action: "none" }
      return { state: { ...state, cursor: state.cursor + 1 }, action: "render" }
    }
    case "home": {
      if (state.cursor === 0) return { state, action: "none" }
      return { state: { ...state, cursor: 0 }, action: "render" }
    }
    case "end": {
      const max = pointLength(state.line)
      if (state.cursor === max) return { state, action: "none" }
      return { state: { ...state, cursor: max }, action: "render" }
    }
    case "up": {
      if (!state.menuOpen) return { state, action: "none" }
      const n = countOf(state.line)
      if (!n) return { state, action: "none" }
      return {
        state: { ...state, sel: state.sel <= 0 ? n - 1 : (((state.sel - 1) % n) + n) % n },
        action: "render",
      }
    }
    case "down": {
      if (!state.menuOpen) return { state, action: "none" }
      const n = countOf(state.line)
      if (!n) return { state, action: "none" }
      return { state: { ...state, sel: (state.sel + 1) % n }, action: "render" }
    }
    case "tab": {
      // Tab sekarang HANYA putar mode (cycle `auto→ask→plan→allowlist`),
      // ditangani di REPL via `onKey` agar selalu jalan bahkan saat mengetik.
      // Completion dropdown tidak lagi pakai Tab — user pilih via ↑/↓ lalu
      // Enter (lengkapi + kirim). Tanpa ini Tab saat mengetik tidak bisa
      // ganti mode (keluhan nyata) dan menabrak completion.
      return { state, action: "none" }
    }
    case "enter": {
      const pick = pickSelected(state.line)
      const finalLine = pick ?? state.line
      return { state: completeTo(finalLine), action: "submit" }
    }
    case "esc": {
      if (!state.menuOpen) return { state, action: "none" }
      return { state: { ...state, sel: -1, menuOpen: false }, action: "render" }
    }
    case "ctrl-c":
    case "ctrl-d":
      return { state, action: "cancel" }
    case "ctrl-o": // toggle compact — ditangani REPL lewat onKey askLine
    case "ctrl-r": // reverse-i-search — ditangani askLine (input.ts) sebelum applyKey
    case "ctrl-t": // toggle expand/minimize reasoning di REPL (onKey)
    case "ctrl-n": // tambah model — ditangani view yang membutuhkan (model-manager); di prompt teks diabaikan
    case "shift-tab": // cycle mode — ditangani REPL lewat onKey askLine
    case "ignore": // byte mouse dsb: dibuang, tidak boleh jadi teks
      return { state, action: "none" }
    case "ctrl-u": {
      if (!state.line.length) return { state, action: "none" }
      return { state: createState(), action: "render" }
    }
    // PgUp/PgDn: scroll viewport transkrip — ditangani App TUI SEBELUM
    // applyKey; engine netral (tanpa ini switch tak exhaustive → tsc merah).
    case "pageup":
    case "pagedown":
      return { state, action: "none" }
    case "ctrl-w": {
      if (state.cursor === 0) return { state, action: "none" }
      const at = unitIndex(state.line, state.cursor)
      const before = state.line.slice(0, at)
      const trimmed = before.replace(/\S+\s*$/, "")
      const line = trimmed + state.line.slice(at)
      return { state: withLine(line, pointLength(trimmed)), action: "render" }
    }
  }
}

// Pure render - spec yang digambar renderer.
// `groupOf` opsional: menandai item sebagai command/skill -> header grup dinamis.
export function buildRenderSpec(
  state: PromptState,
  prompt: string,
  hints: string[],
  groupOf?: (text: string) => string,
  maxVisible = MAX_VISIBLE,
): RenderSpec {
  // Dropdown tidak boleh melebihi tinggi terminal sungguhan. MAX_VISIBLE=10
  // konstan membuat overlay 11 baris di terminal 8 baris (dulu membungkus).
  const limit = Math.max(1, maxVisible)
  const inputLine = `${prompt}${state.line}`
  const visible = hints.slice(0, limit)
  const moreCount = Math.max(0, hints.length - limit)
  const rows: RenderSpec["rows"] = []
  let lastGroup: string | undefined
  for (const text of visible) {
    const group = groupOf?.(text)
    if (group !== undefined && group !== lastGroup) {
      lastGroup = group
      rows.push({ kind: "header", text: group.toUpperCase(), picked: false })
    }
    rows.push({ kind: "item", text, picked: text === visible[state.sel] })
  }
  // Kolom kursor diukur dalam KOLOM terminal: sekuens ANSI pada prompt tidak
  // menempati kolom, dan CJK/emoji menempati dua. Menghitung panjang string
  // mentah membuat kursor terminal salah posisi begitu prompt diwarnai.
  const cursorPoints = toGraphemes(state.line)
    .slice(0, clampCursor(state.line, state.cursor))
    .join("")
  return {
    inputLine,
    cursorCol: displayWidth(prompt) + displayWidth(cursorPoints),
    rows,
    moreCount,
    totalRows: rows.length + (moreCount > 0 ? 1 : 0),
  }
}

// ── Binari dari chunk stdin -> keystroke stream ──
// Rust-style manual parsing: ESC [ A/B/C/D = arrows, ESC = esc, dsb.
export function decodeKeys(buf: Uint8Array): DecodedKey[] {
  const out: DecodedKey[] = []
  const s = new TextDecoder("utf-8").decode(buf)
  let i = 0
  while (i < s.length) {
    const d = decodeKey(s, i)
    d && out.push(d)
    i += d?.width ?? 1
  }
  return out
}

export interface DecodedKey {
  key: PromptKey
  width: number
}

// ── Streaming decoder ──
// `decodeKeys` di atas bekerja pada SATU chunk utuh. Data stdin datang per
// chunk (Bun/Node tidak menjamin batas UTF-8, bracketed paste, atau byte mouse
// jatuh di satu event). Decoder di bawah memakai buffer byte agar emoji yang
// terbelah 2+2, paste `ESC[200~…` yang terbelah, dan `ESC[M`/`ESC[<…M` yang
// terpotong tidak bocor jadi karakter pengganti/teks (dulu: emoji rusak, paste
// jadi teks "200~", mouse jadi "00").
export interface DecoderState {
  /** Byte yang belum lengkap jadi satu key (tail dari chunk sebelumnya). */
  pending: number[]
}

export function createDecoderState(): DecoderState {
  return { pending: [] }
}

function isCsiParam(b: number): boolean {
  return b >= 0x30 && b <= 0x3f
}

function isCsiFinal(b: number): boolean {
  return b >= 0x40 && b <= 0x7e
}

function utf8CharLen(b: number): number {
  if (b < 0x80) return 1
  if ((b & 0xe0) === 0xc0) return 2
  if ((b & 0xf0) === 0xe0) return 3
  if ((b & 0xf8) === 0xf0) return 4
  return 1
}

function decodeUtf8(bytes: number[]): string {
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

/** Pemetaan byte ASCII/control → key; null bila printable biasa. */
function asciiKey(b: number): DecodedKey | null {
  switch (b) {
    case 0x01:
      return { key: { type: "home" }, width: 0 }
    case 0x05:
      return { key: { type: "end" }, width: 0 }
    case 0x0f:
      return { key: { type: "ctrl-o" }, width: 0 }
    case 0x12:
      return { key: { type: "ctrl-r" }, width: 0 }
    case 0x14:
      return { key: { type: "ctrl-t" }, width: 0 }
    case 0x0e:
      return { key: { type: "ctrl-n" }, width: 0 }
    case 0x7f:
    case 0x08:
      return { key: { type: "backspace" }, width: 0 }
    // LF (Ctrl+J) BUKAN submit: ia menyisipkan newline (multiline opt-in).
    // Hanya CR (tombol Enter) yang submit. Paste bracketed tak tersentuh
    // (segelintir chunk → char) sehingga perilaku paste lama tidak berubah.
    case 0x0a:
      return { key: { type: "ctrl-j" }, width: 0 }
    case 0x0d:
      return { key: { type: "enter" }, width: 0 }
    case 0x09:
      return { key: { type: "tab" }, width: 0 }
    case 0x03:
      return { key: { type: "ctrl-c" }, width: 0 }
    case 0x04:
      return { key: { type: "ctrl-d" }, width: 0 }
    case 0x15:
      return { key: { type: "ctrl-u" }, width: 0 }
    case 0x17:
      return { key: { type: "ctrl-w" }, width: 0 }
    default:
      if (b < 0x20) return { key: { type: "ignore" }, width: 0 }
      return null
  }
}

/**
 * Dekode chunk stdin streaming: konsumsi key yang LENGKAP, sisanya disimpan
 * di `state.pending` untuk chunk berikutnya. Key dikembalikan berurutan.
 */
export function decodeKeysStream(chunk: Uint8Array, state: DecoderState): DecodedKey[] {
  const buf = state.pending.concat([...chunk])
  const out: DecodedKey[] = []
  let i = 0
  while (i < buf.length) {
    const b = buf[i]!
    if (b === 0x1b) {
      const n1 = buf[i + 1]
      // ESC di ujung chunk = awal sekuens yang terbelah (panah ESC[A jadi
      // [0x1b]+[0x5b,0x41]) ATAU Esc tunggal. Tak bisa dibedakan sinkron —
      // TAHAN di pending; pemanggil (input.ts) flush sebagai esc bila tak ada
      // byte lanjutan dalam ~50ms (pola lone-ESC yang sama saat busy).
      // Emisi langsung di sini mengubah panah split jadi esc+"[A" (batal prompt
      // + teks nyasar).
      if (n1 === undefined) break
      // Bracketed paste start: ESC[200~ … ESC[201~ — tahan sampai penutup.
      if (
        n1 === 0x5b &&
        buf[i + 2] === 0x32 &&
        buf[i + 3] === 0x30 &&
        buf[i + 4] === 0x30 &&
        buf[i + 5] === 0x7e
      ) {
        let term = -1
        for (let j = i + 6; j + 5 < buf.length; j++) {
          if (
            buf[j] === 0x1b &&
            buf[j + 1] === 0x5b &&
            buf[j + 2] === 0x32 &&
            buf[j + 3] === 0x30 &&
            buf[j + 4] === 0x31 &&
            buf[j + 5] === 0x7e
          ) {
            term = j
            break
          }
        }
        if (term === -1) break // penutup belum tiba — tahan
        out.push({ key: { type: "char", ch: decodeUtf8(buf.slice(i + 6, term)) }, width: 0 })
        i = term + 6
        continue
      }
      // Mouse X10: ESC[M + 3 byte koordinat MENTAH (bukan UTF-8).
      if (n1 === 0x5b && buf[i + 2] === 0x4d) {
        if (i + 6 > buf.length) break // byte koordinat terpotong — tahan
        out.push({ key: { type: "ignore" }, width: 0 })
        i += 6
        continue
      }
      // Mouse SGR: ESC[< … M|m
      if (n1 === 0x5b && buf[i + 2] === 0x3c) {
        let j = i + 3
        while (j < buf.length && buf[j] !== 0x4d && buf[j] !== 0x6d) j++
        if (j >= buf.length) break // terminator belum tiba — tahan
        out.push({ key: { type: "ignore" }, width: 0 })
        i = j + 1
        continue
      }
      // CSI (ESC[) / SS3 (ESC O): sekuens ASCII sampai byte final.
      if (n1 === 0x5b || n1 === 0x4f) {
        let j = i + 2
        while (
          j < buf.length &&
          !isCsiFinal(buf[j]!) &&
          (isCsiParam(buf[j]!) || (buf[j]! >= 0x20 && buf[j]! <= 0x2f))
        ) {
          j++
        }
        if (j < buf.length && isCsiFinal(buf[j]!)) {
          const seq = String.fromCharCode(...buf.slice(i, j + 1))
          const d = decodeKey(seq, 0)
          out.push(d ?? { key: { type: "ignore" }, width: 0 })
          i = j + 1
          continue
        }
        if (j === i + 2) {
          // "ESC["/"ESC O" di ujung chunk = CSI belum lengkap (final di chunk
          // berikut), BUKAN Esc biasa. Tahan agar panah split tak jadi esc.
          // (ESC[ yang benar-benar lengkap selalu punya byte final dan sudah
          // ditangani di atas.)
          break
        }
        break // ada parameter tapi belum ada byte final — tahan
      }
      // ESC + byte lain: ESC tunggal (lengkap, tidak menunggu apa pun).
      out.push({ key: { type: "esc" }, width: 0 })
      i += 1
      continue
    }
    if (b < 0x80) {
      const d = asciiKey(b)
      out.push(d ?? { key: { type: "char", ch: String.fromCharCode(b) }, width: 0 })
      i += 1
      continue
    }
    // Multi-byte UTF-8 — pastikan seluruh sekuens sudah tiba.
    const n = utf8CharLen(b)
    if (i + n > buf.length) break
    const bytes = buf.slice(i, i + n)
    const contOk = bytes.slice(1).every((x) => (x & 0xc0) === 0x80)
    if (!contOk) {
      out.push({ key: { type: "char", ch: "\ufffd" }, width: 0 })
      i += 1
      continue
    }
    out.push({ key: { type: "char", ch: decodeUtf8(bytes) }, width: 0 })
    i += n
  }
  state.pending = buf.slice(i)
  return out
}

/**
 * Pending berupa Esc tunggal yang tertahan di ujung chunk ([0x1b])?
 * Hanya kasus ini yang di-flush via timer ~50ms oleh pemanggil: sekuens lain
 * yang tertahan (UTF-8/paste/mouse/CSI berparameter) menunggu chunk berikut
 * dan tak boleh dipaksa jadi esc.
 */
export function hasPendingLoneEsc(state: DecoderState): boolean {
  return state.pending.length === 1 && state.pending[0] === 0x1b
}

/**
 * Paksa pending Esc tunggal menjadi key esc (dipanggil timer pemanggil bila
 * tak ada byte lanjutan). No-op bila pending bukan Esc tunggal.
 */
export function flushLoneEsc(state: DecoderState): DecodedKey[] {
  if (!hasPendingLoneEsc(state)) return []
  state.pending = []
  return [{ key: { type: "esc" }, width: 0 }]
}

// ── Pompa key stream + flush lone-ESC ──
//
// Decoder menahan ESC di ujung chunk (tak bisa bedakan Esc tunggal vs paruh
// panah split secara sinkron). Pompa ini membungkus pola yang dipakai SEMUA
// konsumen interaktif (askLine/askSecret/picker/manager): decode chunk →
// teruskan key sinkron → bila pending Esc tunggal, tunggu ~50ms (pola
// lone-ESC yang sama saat busy di cli/repl.ts); byte lanjutan membatalkan
// timer dan melengkapi sekuens, sunyi berarti Esc asli → flush sebagai esc.
//
// Tanpa pompa tiap konsumen harus menulis timer sendiri (duplikasi 5× dan
// drift); tanpa timer panah split jadi esc+"[A" (batal prompt + teks nyasar).
// Timer di-unref agar tak menahan exit proses/test.
export interface KeyStreamPump {
  /** Decode chunk + kirim key sinkron; arm flush bila Esc tertahan. */
  push(chunk: Uint8Array): void
  /** Matikan timer (panggil di cleanup agar flush tak jalan setelah selesai). */
  dispose(): void
}

export function createKeyStreamPump(opts: {
  state: DecoderState
  /** Dipanggil untuk key sinkron maupun hasil flush; return true = selesai. */
  onKeys: (keys: DecodedKey[]) => boolean
  escMs?: number
}): KeyStreamPump {
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  return {
    push(chunk: Uint8Array): void {
      clear()
      const done = opts.onKeys(decodeKeysStream(chunk, opts.state))
      if (done) return
      if (hasPendingLoneEsc(opts.state)) {
        timer = setTimeout(() => {
          timer = undefined
          const flushed = flushLoneEsc(opts.state)
          if (flushed.length) opts.onKeys(flushed)
        }, opts.escMs ?? 50)
        try {
          ;(timer as unknown as { unref?: () => void }).unref?.()
        } catch {}
      }
    },
    dispose(): void {
      clear()
    },
  }
}

export function decodeKey(s: string, i: number): DecodedKey | null {
  const c = s[i]!
  const code = c.charCodeAt(0)
  if (code === 0x1b) {
    // Bracketed paste: ESC[200~ … ESC[201~ — emit satu char "paste" per segmen
    if (
      s[i + 1] === "[" &&
      s[i + 2] === "2" &&
      s[i + 3] === "0" &&
      s[i + 4] === "0" &&
      s[i + 5] === "~"
    ) {
      const endIdx = s.indexOf("\x1b[201~", i + 6)
      if (endIdx !== -1) {
        return { key: { type: "char", ch: s.slice(i + 6, endIdx) }, width: endIdx + 6 - i }
      }
    }
    // Laporan mouse. X10: ESC [ M + 3 byte mentah (yang BUKAN huruf final, jadi
    // scanCsi tidak bisa mengukurnya). SGR: ESC [ < … M/m. Keduanya dibuang —
    // tanpa ini byte koordinat masuk sebagai teks ("teks" jadi "teks 00").
    if (s[i + 1] === "[" && s[i + 2] === "M") return { key: { type: "ignore" }, width: 6 }
    if (s[i + 1] === "[" && s[i + 2] === "<") {
      let j = i + 3
      while (j < s.length && s[j] !== "M" && s[j] !== "m") j++
      return { key: { type: "ignore" }, width: j - i + 1 }
    }
    if (s[i + 1] === "[" || s[i + 1] === "O") {
      const kind = s[i + 2]
      if (kind === "A") return { key: { type: "up" }, width: 3 }
      if (kind === "B") return { key: { type: "down" }, width: 3 }
      if (kind === "C") return { key: { type: "right" }, width: 3 }
      if (kind === "D") return { key: { type: "left" }, width: 3 }
      if (kind === "H") return { key: { type: "home" }, width: 3 }
      if (kind === "F") return { key: { type: "end" }, width: 3 }
      // Varian VT: ESC[1~ Home, ESC[4~ End, ESC[3~ Delete, ESC[7~/[8~ Home/End
      if (kind === "1" && s[i + 3] === "~") return { key: { type: "home" }, width: 4 }
      if (kind === "7" && s[i + 3] === "~") return { key: { type: "home" }, width: 4 }
      if (kind === "4" && s[i + 3] === "~") return { key: { type: "end" }, width: 4 }
      if (kind === "8" && s[i + 3] === "~") return { key: { type: "end" }, width: 4 }
      if (kind === "3" && s[i + 3] === "~") return { key: { type: "delete" }, width: 4 }
      // PgUp/PgDn — App TUI memakainya untuk scroll transkrip (I18).
      if (kind === "5" && s[i + 3] === "~") return { key: { type: "pageup" }, width: 4 }
      if (kind === "6" && s[i + 3] === "~") return { key: { type: "pagedown" }, width: 4 }
      // Shift+Tab (backtab) ESC [ Z — dipakai REPL linier untuk cycle mode.
      // Tanpa cabang eksplisit ini ia jatuh ke catch-all "esc" di bawah,
      // sehingga tipe "shift-tab" tidak pernah dihasilkan decodeKeys.
      if (kind === "Z") return { key: { type: "shift-tab" }, width: 3 }
      // ESC [ … lainnya -> konsumsi saja
      return { key: { type: "esc" }, width: Math.max(3, scanCsi(s, i)) }
    }
    return { key: { type: "esc" }, width: 1 }
  }
  if (code === 0x01) return { key: { type: "home" }, width: 1 } // Ctrl+A
  if (code === 0x05) return { key: { type: "end" }, width: 1 } // Ctrl+E
  // Ctrl+O (15) & Ctrl+R (18) sebagai key types sendiri
  if (code === 0x0f) return { key: { type: "ctrl-o" }, width: 1 }
  if (code === 0x12) return { key: { type: "ctrl-r" }, width: 1 }
  if (code === 0x14) return { key: { type: "ctrl-t" }, width: 1 }
  if (code === 0x0e) return { key: { type: "ctrl-n" }, width: 1 } // Ctrl+N
  if (code === 0x7f || code === 0x08) return { key: { type: "backspace" }, width: 1 }
  // Sinkron dengan asciiKey di atas: LF = newline, CR = submit.
  if (c === "\n") return { key: { type: "ctrl-j" }, width: 1 }
  if (c === "\r") return { key: { type: "enter" }, width: 1 }
  if (c === "\t") return { key: { type: "tab" }, width: 1 }
  if (code === 0x03) return { key: { type: "ctrl-c" }, width: 1 }
  if (code === 0x04) return { key: { type: "ctrl-d" }, width: 1 }
  if (code === 0x15) return { key: { type: "ctrl-u" }, width: 1 }
  if (code === 0x17) return { key: { type: "ctrl-w" }, width: 1 }
  // Kontrol C0 lain yang tidak punya arti di sini (Ctrl+L, Ctrl+K, Ctrl+Z,
  // dst.) DIBUANG, bukan diteruskan sebagai karakter.
  //
  // Sebelumnya semuanya jatuh ke cabang "char" di bawah dan masuk ke baris
  // input sebagai byte tak tampak — Ctrl+L+Ctrl+K+Ctrl+T pada "teks"
  // mengirimkan "teks\f\u000b\u0014" ke model. Tidak terlihat di layar, tapi
  // ikut terkirim dan bisa membingungkan model atau merusak render.
  if (code < 0x20 || code === 0x7f) return { key: { type: "ignore" }, width: 1 }
  // Multi-byte: s sudah decoded UTF-16 - ukur unit per code point.
  const width = code >= 0xd800 && code <= 0xdbff ? 2 : 1
  const ch = s.slice(i, i + width)
  return { key: { type: "char", ch }, width }
}

function scanCsi(s: string, i: number): number {
  // konsumsi sampai huruf final (mis. ESC [ 1 ; 5 A)
  let j = i + 2
  while (j < s.length && !/[a-zA-Z]/.test(s[j]!)) j++
  return j - i + 1
}
