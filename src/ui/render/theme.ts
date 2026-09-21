import { sanitizeAnsiLine } from "./sanitize.ts"
import { displayWidth, truncateToWidth } from "./width.ts"

// Semantic color system - Ubuntu Server style.
// Warna by function, bukan appearance. Satu palet (dark); NO_COLOR > truecolor
// > 256 > 16 > mono tetap auto-detect. Fitur tema (--theme, /theme, preset)
// dihapus: tampilan tunggal, tidak ada state tema mutable.

const isWindows = process.platform === "win32"

/**
 * Apakah terminal menampilkan karakter Unicode non-ASCII dengan benar?
 *
 * Dievaluasi LAZY (bukan saat import) supaya perubahan env di runtime dan di
 * test tetap berpengaruh — sama alasannya dengan deteksi warna di bawah.
 * Sebelumnya dibekukan saat import, jadi `glyphs` selalu memakai nilai yang
 * ditentukan oleh env pada saat modul pertama dimuat.
 */
export function supportsUtf8(): boolean {
  if (process.env.MINICODE_ASCII === "1") return false
  if (!isWindows) return true
  return (
    process.env.WT_SESSION != null ||
    process.env.TERM_PROGRAM != null ||
    (process.env.LANG?.includes("UTF-8") ?? false) ||
    (process.env.LC_ALL?.includes("UTF-8") ?? false)
  )
}

// ── Color support detection ──
// Dievaluasi LAZY (bukan saat import) supaya perubahan NO_COLOR/COLORTERM di
// runtime dan pengujian tetap berpengaruh; hasilnya murah karena hanya baca env.
function noColorEnv(): boolean {
  return process.env.NO_COLOR != null && process.env.NO_COLOR !== "0"
}
function hasTruecolorEnv(): boolean {
  return process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit"
}
/** 0=mono, 1=16-color, 2=256-color, 3=truecolor */
function colorLevel(): number {
  if (noColorEnv()) return 0
  // Determinisme Unix: output ke pipe/redirect/file tidak boleh memuat ANSI,
  // apa pun TERM/COLORTERM di env (env sesi interaktif sering bocor ke proses
  // yang di-pipe). Warna hanya untuk stdout yang benar-benar terminal.
  if (!process.stdout.isTTY) return 0
  if (hasTruecolorEnv()) return 3
  if (process.env.TERM?.includes("256color")) return 2
  return 1
}

type Paint = (s: string) => string
const identity: Paint = (s) => s

function wrap(open: number | string, close: number | string): Paint {
  if (colorLevel() === 0) return identity
  const o = `\x1b[${open}m`
  const cl =
    typeof close === "number"
      ? `\x1b[${close}m`
      : String(close).startsWith("\x1b[")
        ? String(close)
        : `\x1b[${close}m`
  return (s: string) => `${o}${s}${cl}`
}

/** Warna dari kode SGR mentah (mis. "38;2;137;209;133" atau "39"). */
function paintFrom(code: string): Paint {
  if (colorLevel() === 0) return identity
  return (s: string) => `\x1b[${code}m${s}\x1b[39m`
}

// ── Token palet tunggal (VS Code Dark+ inspired) ──
const TOKENS = {
  success: "38;2;137;209;133",
  error: "38;2;244;135;113",
  warning: "38;2;204;167;0",
  info: "38;2;117;190;255",
  accent: "38;2;0;122;204",
  // Faint: abu gelap untuk garis footer — lebih redup dari `gray` (bright-black)
  // dan dari `muted` (dim). Dipakai elemen yang harus ada tapi hampir tak
  // terlihat, seperti separator baris dasar.
  faint: "38;2;72;72;72",
}

// ── Slot warna ──
//
// PENTING: slot ini WAJIB dievaluasi saat dipanggil, bukan saat modul di-import.
// Versi sebelumnya menulis `success: trueWrap(tk("success"))` di module scope,
// sehingga token warna dibekukan pada import pertama — termasuk warna `mono`
// yang seharusnya menjadi jalur aksesibilitas. Slot kini getter dengan hasil
// di-cache per level warna supaya jalur render panas tidak mengalokasi closure
// tiap panggilan.
interface Palette {
  success: Paint
  error: Paint
  warning: Paint
  info: Paint
  accent: Paint
  accentAlt: Paint
  accentBold: Paint
  gray: Paint
  faint: Paint
  red: Paint
  green: Paint
  yellow: Paint
  cyan: Paint
  blue: Paint
  magenta: Paint
  white: Paint
  brightYellow: Paint
  brightMagenta: Paint
  brightCyan: Paint
}

const paletteCache = new Map<string, Palette>()

function buildPalette(): Palette {
  const truecolor = hasTruecolorEnv()
  const mono = colorLevel() === 0
  // Aksen: 16-color fallback saat truecolor tak tersedia.
  const accent = truecolor ? paintFrom(TOKENS.accent) : wrap(94, 39)
  return {
    success: paintFrom(TOKENS.success),
    error: paintFrom(TOKENS.error),
    warning: paintFrom(TOKENS.warning),
    info: paintFrom(TOKENS.info),
    accent,
    accentAlt: truecolor ? paintFrom(TOKENS.info) : wrap(95, 39),
    accentBold: truecolor ? paintFrom(`1;${TOKENS.accent}`) : wrap(94, 39),
    // Saat mono, `gray` memakai dim (SGR 2) alih-alih bright-black (SGR 90):
    // 90 adalah warna, dan mono adalah jalur aksesibilitas yang seharusnya
    // monokrom. Dim tetap memberi hierarki visual tanpa memakai kanal warna.
    gray: mono ? attr(2, 22) : wrap(90, 39),
    // Faint: garis footer hampir tak terlihat. Mono (aksesibilitas) jatuh ke
    // dim agar tetap ada hierarki tanpa kanal warna.
    faint: mono ? attr(2, 22) : paintFrom(TOKENS.faint),
    // Alias legacy: dipetakan ke token, bukan hex hardcoded.
    red: paintFrom(TOKENS.error),
    green: paintFrom(TOKENS.success),
    yellow: paintFrom(TOKENS.warning),
    cyan: paintFrom(TOKENS.info),
    blue: accent,
    magenta: mono ? identity : wrap(35, 39),
    white: mono ? identity : wrap(37, 39),
    // Slot syntax highlight — saat mono semuanya jadi teks biasa.
    brightYellow: mono ? identity : truecolor ? wrap("38;2;215;186;125", 39) : wrap(93, 39),
    brightMagenta: mono ? identity : truecolor ? wrap("38;2;197;134;192", 39) : wrap(95, 39),
    brightCyan: mono ? identity : truecolor ? wrap("38;2;78;201;176", 39) : wrap(96, 39),
  }
}

function palette(): Palette {
  // Kunci cache memuat level warna: NO_COLOR / COLORTERM bisa berubah antar
  // proses (dan antar test), dan palette mono vs truecolor berbeda isi.
  const key = `${colorLevel()}:${hasTruecolorEnv() ? 1 : 0}`
  const cached = paletteCache.get(key)
  if (cached) return cached
  const built = buildPalette()
  paletteCache.set(key, built)
  return built
}

// Atribut non-warna (dim/bold/italic) tetap lazy juga: NO_COLOR harus
// mematikannya, dan itu dievaluasi saat pakai.
const attrCache = new Map<string, Paint>()
function attr(open: number, close: number): Paint {
  const key = `${open}:${close}:${colorLevel()}`
  const hit = attrCache.get(key)
  if (hit) return hit
  const built = wrap(open, close)
  attrCache.set(key, built)
  return built
}

/**
 * Slot warna semantik.
 *
 * GETTER — JANGAN simpan ke `const` di module scope; lihat PLAN.md P0.1.
 * Setiap properti membaca level warna saat DIPANGGIL. Menulis
 * `const HEADER = c.dim(...)` di module scope membekukan hasilnya pada import
 * pertama (NO_COLOR, COLORTERM tidak lagi berpengaruh). Kesalahan ini sudah
 * terjadi dua kali (V6, V8). Dijaga oleh
 * `test/no-frozen-runtime-value.test.ts`.
 *
 * Benar: `() => c.dim(x)`, `get header() { return c.dim(x) }`, atau baca di
 * dalam fungsi render.
 */
export const c = {
  // Text hierarchy — tidak bergantung warna.
  text: identity,
  get muted() {
    return attr(2, 22) // dim - secondary info, borders
  },
  get bold() {
    return attr(1, 22)
  },
  get italic() {
    return attr(3, 23)
  },
  get dim() {
    return attr(2, 22)
  },

  // Status
  get success() {
    return palette().success
  },
  get error() {
    return palette().error
  },
  get warning() {
    return palette().warning
  },
  get info() {
    return palette().info
  },

  // Accent
  get accent() {
    return palette().accent
  },
  get accentAlt() {
    return palette().accentAlt
  },
  get accentBold() {
    return palette().accentBold
  },
  get gray() {
    return palette().gray
  },
  get faint() {
    return palette().faint
  },

  // Legacy compat (dipakai renderer lama) — kini mengikuti token.
  get red() {
    return palette().red
  },
  get green() {
    return palette().green
  },
  get yellow() {
    return palette().yellow
  },
  get cyan() {
    return palette().cyan
  },
  get blue() {
    return palette().blue
  },
  get magenta() {
    return palette().magenta
  },
  get white() {
    return palette().white
  },

  // Syntax highlight
  get brightYellow() {
    return palette().brightYellow
  },
  get brightMagenta() {
    return palette().brightMagenta
  },
  get brightCyan() {
    return palette().brightCyan
  },
}

// ── Glyphs - minimal, Ubuntu Server style ──
//
// GETTER — JANGAN simpan ke `const` di module scope; lihat PLAN.md P0.1.
// `supportsUtf8()` dievaluasi saat dipakai supaya `MINICODE_ASCII=1` dan
// perubahan env di test langsung berlaku. `const OK = glyphs.check` di
// `cli/commands.ts` pernah membekukannya (V8) sehingga fallback ASCII tidak
// pernah aktif. Dijaga oleh `test/no-frozen-runtime-value.test.ts`.
export const glyphs = {
  get check() {
    return supportsUtf8() ? "✓" : "[OK]"
  },
  get cross() {
    return supportsUtf8() ? "✗" : "[FAIL]"
  },
  get arrow() {
    return supportsUtf8() ? "›" : ">"
  },
  get prompt() {
    return supportsUtf8() ? "❯" : ">"
  },
  get dot() {
    return supportsUtf8() ? "·" : "."
  },
  get bullet() {
    return supportsUtf8() ? "●" : "*"
  },
  get ellipsis() {
    return supportsUtf8() ? "…" : "..."
  },
  get sparkle() {
    return supportsUtf8() ? "✦" : "*"
  },
  get spinnerFrames() {
    return supportsUtf8() ? ["·", "··", "···"] : [".", "..", "..."]
  },
  get thinkingIcon() {
    // Sparkle ✦ (bintang) — indikator thinking yang "kelip-kelip": glyph
    // monokrom, jadi warna ANSI (putih ↔ abu di turn-status) terlihat.
    // Fallback * untuk terminal tanpa UTF-8.
    return supportsUtf8() ? "✦" : "*"
  },
}

// ── Section separator ──
export function section(title: string): string {
  const width = getTerminalWidth()
  // Judul bisa berasal dari model/berkas: sanitasi satu-baris agar `\n`/ANSI
  // tak memecah separator menjadi multi-baris atau menyuntik kontrol.
  const clean = sanitizeAnsiLine(title)
  // Label lebih panjang dari terminal (judul CJK/emoji panjang): potong dulu
  // per kolom — tanpa ini dashes jatuh ke 4 dan total label+4 tetap meluap.
  const label =
    displayWidth(` ${clean} `) > Math.max(4, width - 4)
      ? truncateToWidth(` ${clean} `, Math.max(4, width - 4), "…")
      : ` ${clean} `
  // Lebar pemisah dihitung per KOLOM terminal: CJK/emoji bisa 2 kolom.
  // Clamp agar garis tak memicu wrap sendiri di terminal sempit.
  const dashes = Math.min(Math.max(4, width - displayWidth(label)), Math.max(4, width - 4))
  return c.dim(label + "─".repeat(dashes))
}

export function getTerminalWidth(): number {
  return process.stdout.columns || 80
}

// Satu sumber pola ANSI. Dibangun via `new RegExp` dari String.fromCharCode(27)
// alih-alih literal /\x1b…/ supaya tidak menyisipkan control character mentah ke
// source (lint/suspicious/noControlCharactersInRegex) — perilaku identik.
export const ESC = String.fromCharCode(27)
// CSI dengan parameter privat (`?`, `<`, `=`, `>`) juga harus tertangkap:
// ESC[?25l, ESC[?2026h, ESC[?1049h dipakai untuk kursor/sync/alternate-screen.
// Tanpa itu sekuens kontrol lolos ke teks yang seharusnya sudah bersih —
// terlihat saat output ditangkap/disanitasi untuk tampilan.
// Final CSI = 0x40–0x7E (`[@-~]`), bukan hanya huruf — tanpanya `ESC[3~`
// menyisakan `~` dan merusak hitungan kolom. DCS/APC/PM/SOS = `ESC` + satu
// huruf `P/_/^/X` (BUKAN `ESC[` + kelas karakter) — pola lama `\[P_\^X]`
// hanya cocok untuk `ESC[P`/`ESC[_` dst. sehingga payload DCS bocor.
export const ANSI_PATTERN = `${ESC}(?:\\[[0-9;?<=>]*[@-~]|\\[[0-9;?<=>]*|\\][^${ESC}\\u0007]*(?:\\u0007|${ESC}\\\\)|(?:P|_|\\^|X)[^${ESC}\\u0007]*(?:\\u0007|${ESC}\\\\)|[()#][0-~]|[0-~])`

export function stripAnsi(str: string): string {
  // regex baru per panggilan: aman dari lastIndex bersama antar pemanggil
  return str.replace(new RegExp(ANSI_PATTERN, "g"), "")
}
