// Status bar TUI: 1 baris status (tanpa garis — keputusan clean).
//
// Modul murni render tanpa IO/timer: dipakai App TUI sebagai baris dasar.
// Frame animasi spark dan angka konteks DIKIRIM pemanggil lewat FooterStatus,
// jadi render tetap deterministik dan bisa diuji tanpa menunggu waktu.
//
// Gaya (keputusan produk): footer hampir tak terlihat — garis + teks status
// abu-abu gelap; SATU-SATUNYA yang berwarna adalah token mode (mapping sama
// dengan prompt lama: plan kuning, ask biru, sisanya hijau).
//
// Tata letak: `✦ mode • model • cwd ……… 14.2k` — konteks rata kanan. Mode
// di-pad ke lebar tetap agar teks di kanannya TIDAK bergeser saat mode berganti
// (Shift+Tab): tanpa padding, `auto`→`allowlist` menggeser seluruh baris.
import { sanitizeAnsiLine } from "./render/sanitize.ts"
import { c, glyphs } from "./render/theme.ts"
import { displayWidth, padToWidth, truncateToWidth } from "./render/width.ts"

export interface FooterStatus {
  mode: string
  model: string
  cwd: string
  /** Jumlah konteks polos (mis. "14.2k"). Kosong = tak ditampilkan. */
  context?: string
  /**
   * Frame animasi spark: 0 = idle (spark redup statis), >0 = busy (pulse
   * putih↔abu). Chrome yang menaikkan frame saat turn berjalan; render hanya
   * memetakan frame → glyph berwarna.
   */
  sparkFrame?: number
  activity?: string
}

/** Lebar tetap kolom mode — `allowlist`/`allow-all` (9) adalah yang terpanjang. */
const MODE_WIDTH = 9

/** Buang prefix provider (`acme::deepseek-v4` → `deepseek-v4`). */
export function shortModel(id: string): string {
  const i = id.lastIndexOf("::")
  return i >= 0 ? id.slice(i + 2) : id
}

/**
 * Warna + PAD token mode. Padding dilakukan sebelum pewarnaan supaya lebar
 * kolom mode tetap sama untuk semua mode (anti-geser), sementara warna tetap
 * dipilih dari nama mode asli.
 */
export function paintFooterMode(mode: string): string {
  // Padding per KOLOM (bukan padEnd karakter): CJK/emoji = 2 kolom, dan
  // displayWidth sudah dipakai di bawah — konsisten satu penggaris.
  // Mode satu-baris: newline dari input tak terpercaya wajib dibuang agar tak
  // memecah frame lengket 2-baris chrome.ts.
  const padded = padToWidth(sanitizeAnsiLine(mode), MODE_WIDTH)
  return mode === "plan" ? c.warning(padded) : mode === "ask" ? c.info(padded) : c.success(padded)
}

/** Spark glyph: redup saat idle, pulse putih↔abu saat busy (frame genap/ganjil). */
function sparkGlyph(frame: number): string {
  const g = glyphs.thinkingIcon
  if (frame <= 0) return c.faint(g)
  return frame % 2 === 0 ? c.white(g) : c.gray(g)
}

/**
 * Perpendek path agar muat di terminal sedang tanpa membuang CWD sepenuhnya.
 * Mis. "D:\git\minicode\src\ui" -> "...\src\ui"
 * atau "/home/user/projects/minicode/src" -> ".../minicode/src"
 */
export function shortenPath(p: string, maxSegments = 2): string {
  if (!p) return ""
  const isWin = p.includes("\\")
  const sep = isWin ? "\\" : "/"
  const clean = p.replace(/[\\/]+$/, "")
  const parts = clean.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= maxSegments) return clean
  const tail = parts.slice(-maxSegments).join(sep)
  return `...${sep}${tail}`
}

/**
 * Render 1 baris footer untuk lebar `columns` (+ 1 baris kosong di atasnya
 * bila dilukis lengket). Tanpa garis separator — clean (keputusan user).
 * Non-TTY/dimati diputuskan pemanggil (mekanisme), bukan di sini.
 */
export function renderFooter(s: FooterStatus, columns: number): string[] {
  const cols = Math.max(10, Math.floor(columns) || 80)

  const spark = sparkGlyph(s.sparkFrame ?? 0)
  const activity = s.activity ? `  ${c.info(sanitizeAnsiLine(s.activity))}` : ""
  const lead = `${spark}${activity}  `
  const mode = paintFooterMode(s.mode)
  const dot = c.gray("•")
  const sep = `    ${dot}    `
  // Satu-baris: cwd/model bisa berisi newline (nama dir) — sanitizeAnsiLine
  // agar \n tak memecah frame lengket ke scrollback (displayWidth menghitung
  // \n = 0 sehingga align mengira muat).
  const model = c.gray(sanitizeAnsiLine(shortModel(s.model)))
  const cwdTxt = c.gray(sanitizeAnsiLine(s.cwd))
  const shortCwdTxt = c.gray(sanitizeAnsiLine(shortenPath(s.cwd)))

  const full = `${lead}${mode}${sep}${model}${sep}${cwdTxt}`
  const shortened = `${lead}${mode}${sep}${model}${sep}${shortCwdTxt}`
  const mid = `${lead}${mode}${sep}${model}`
  const lean = `${lead}${mode}`

  const target = Math.max(4, cols - 1)
  const ctx = s.context ? sanitizeAnsiLine(s.context) : ""
  const ctxW = ctx ? displayWidth(ctx) : 0

  // Rata kanan: konteks didorong ke kolom `target` dengan gap ideal ≥6
  // agar rapi dan tidak mepet (keluhan: terlalu rapat → 1→2→4→6).
  // Bila tak muat, konteks diprioritaskan — kiri dipotong duluan lewat
  // tangga di bawah, bukan konteks yang dilepas.
  const align = (left: string): string => {
    const lw = displayWidth(left)
    if (!ctx) return left
    if (lw + ctxW + 2 > target) return left
    const gap = Math.max(6, target - lw - ctxW)
    return `${left}${" ".repeat(gap)}${c.gray(ctx)}`
  }

  // Tangga prioritas buang saat sempit: cwd penuh → cwd diperpendek → model (spark+mode+context kekal).
  const candidates = shortCwdTxt !== cwdTxt ? [full, shortened, mid, lean] : [full, mid, lean]
  for (const left of candidates) {
    const line = align(left)
    if (displayWidth(line) <= target) return [line]
  }
  // Bahkan `lean` tak muat (terminal sangat sempit): potong keras.
  return [truncateToWidth(align(lean), target, "…")]
}
