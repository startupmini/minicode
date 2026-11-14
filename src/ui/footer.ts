// Status bar TUI: 1 baris status (tanpa garis — keputusan clean).
//
// Modul murni render tanpa IO/timer: dipakai App TUI sebagai baris dasar.
// Frame animasi spark dan angka konteks DIKIRIM pemanggil lewat FooterStatus,
// jadi render tetap deterministik dan bisa diuji tanpa menunggu waktu.
//
// Gaya (keputusan produk): footer hampir tak terlihat; field dipisahkan
// dengan spasi dan warna, tanpa bullet separator. Work Mode ada di kiri;
// Permission Mode berwarna cyan di sisi kanan, dekat penggunaan konteks.
import { sanitizeAnsiLine } from "./render/sanitize.ts"
import { c, glyphs, supportsUtf8, themeCapabilityKey } from "./render/theme.ts"
import { displayWidth, truncateToWidth } from "./render/width.ts"

export type TimerHighlight = "seconds" | "minutes" | "hours"

export interface FooterStatus {
  /** Permission mode efektif sesi ini (umumnya AUTO atau ASK). */
  mode: string
  /** Bila true, bash dibatasi ke allow-list (lapis kapabilitas, bukan mode). */
  strictBash?: boolean
  /** WorkMode aktif sesi; identitas internal EXECUTE ditampilkan sebagai Build. */
  workMode?: string
  model: string
  cwd: string
  /** Jumlah konteks polos (mis. "14.2k"). Kosong = tak ditampilkan. */
  context?: string
  /**
   * F-CTX-1: metrik usage (biaya + window %), sudah diformat pemanggil
   * (mis. "$0.0601 42%"). Kosong = tak ditampilkan. Render hanya meletakkan;
   * angka dihitung di lapisan cli (bukan di sini) agar tak ada estimasi.
   */
  metrics?: string
  /**
   * Frame animasi spark: 0 = idle (spark redup statis), >0 = busy (pulse
   * putih↔abu). Chrome yang menaikkan frame saat turn berjalan; render hanya
   * memetakan frame → glyph berwarna.
   */
  sparkFrame?: number
  /** Jumlah job bash background hidup (dihitung di cli — batas lapisan).
   * >= 1 = badge `◷ N` berputar; 0/undefined = tanpa badge. */
  backgroundJobs?: number
  /** Frame animasi badge job (dinaikkan clock idle di app.ts, bukan turn). */
  backgroundFrame?: number
  activity?: string
  timer?: string
  timerActive?: boolean
  timerHighlight?: TimerHighlight
}

/** Lebar tetap kolom agar perubahan WorkMode tidak menggeser model/CWD. */
const WORK_MODE_VALUE_WIDTH = 7

/** Buang prefix provider (`acme::deepseek-v4` → `deepseek-v4`). */
export function shortModel(id: string): string {
  const i = id.lastIndexOf("::")
  return i >= 0 ? id.slice(i + 2) : id
}

function titleCaseMode(value: string, fallback: string): string {
  const clean = sanitizeAnsiLine(value).trim()
  if (!clean) return fallback
  return clean
    .toLowerCase()
    .replace(/(^|[\s_-])([a-z])/g, (_match, sep: string, letter: string) => {
      return `${sep}${letter.toUpperCase()}`
    })
}

function workModeValue(workMode?: string): string {
  const normalized = (workMode || "DISCUSS").toUpperCase()
  if (normalized === "EXECUTE" || normalized === "BUILD") return "Build"
  if (normalized === "DISCUSS") return "Discuss"
  if (normalized === "PLAN") return "Plan"
  return titleCaseMode(workMode ?? "", "Build")
}

type ModeLabelStyle = "full" | "compact" | "value"

/** Work Mode memakai warna semantik; nilai title case tanpa label (v0.24:
 * footer lebih lega — nilai saja, pembeda sumbu = warna). */
export function paintWorkMode(workMode?: string, _style: ModeLabelStyle = "full"): string {
  const value = workModeValue(workMode)
  const normalized = sanitizeAnsiLine(workMode || "DISCUSS").toUpperCase()
  const labelWidth = displayWidth(sanitizeAnsiLine(value))
  const colorValue = normalized === "DISCUSS" || normalized === "PLAN" ? c.warning : c.success
  return `${colorValue(value)}${" ".repeat(Math.max(0, WORK_MODE_VALUE_WIDTH - labelWidth))}`
}

/** Permission Mode selalu cyan agar terpisah dari Work Mode. `unrestricted`:
 * label disembunyikan — cukup titik terbuka ○ (lihat paintBashStrict). */
export function paintPermissionMode(mode: string, _style: ModeLabelStyle = "full"): string {
  if (mode === "unrestricted") return ""
  const value = titleCaseMode(mode, "Auto")
  return c.info(value)
}

/** Badge pembatas bash allow-list: titik selalu tampil — terang/kuning saat
 * aktif, redup/abu saat nonaktif (lapis kapabilitas, terpisah dari mode
 * persetujuan). Saat `unrestricted` aktif, titik jadi ○ MERAH — satu-satunya
 * penanda mode itu, jadi dirender jelas (bukan redup). */
export function paintBashStrict(strictBash?: boolean, unrestricted = false): string {
  if (unrestricted) return c.red(glyphs.unlock)
  return strictBash ? c.yellow(glyphs.lock) : c.gray(glyphs.lock)
}

/** Spark glyph: redup saat idle, pulse putih↔abu saat busy (frame genap/ganjil). */
function sparkGlyph(frame: number): string {
  const g = glyphs.thinkingIcon
  if (frame <= 0) return c.faint(g)
  return frame % 2 === 0 ? c.white(g) : c.gray(g)
}

// Badge job background: jam flat berputar PELAN (fase beda dari spark),
// monokrom; fallback ASCII `[BG:n]`.
const WAITING_GLYPHS = ["◷", "◶", "◵", "◴"] as const
const WAITING_ASCII = ["[BG:", "|", "/", "-"] as const

/** Frame -> glyph badge tunggu. `count` = jumlah job hidup; 0 = string kosong. */
export function waitingGlyph(count: number, frame = 0): string {
  if (count <= 0) return ""
  const n = Math.max(1, Math.floor(count))
  if (!supportsUtf8()) return `${WAITING_ASCII[0]}${n}]`
  const phase = Math.abs(Math.floor(frame)) % WAITING_GLYPHS.length
  return `${WAITING_GLYPHS[phase]} ${n}`
}

function paintTimer(text: string, active: boolean, highlight: TimerHighlight = "seconds"): string {
  if (!active) return c.gray(text)
  const parts = text.split(".")
  if (parts.length !== 3) return c.white(text)
  const rank: Record<TimerHighlight, number> = { seconds: 1, minutes: 2, hours: 3 }
  const level = rank[highlight]
  const part = (value: string, required: number): string =>
    level >= required ? c.white(value) : c.faint(value)
  return `${part(parts[0]!, 3)}${c.faint(".")}${part(parts[1]!, 2)}${c.faint(".")}${part(parts[2]!, 1)}`
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
 * Cache satu-entri: footer dirender ulang SETIAP paint, padahal isinya jarang
 * berubah (idle: mode/model/cwd/konteks tetap). Key memuat SEMUA field +
 * kapabilitas tema supaya cache tak menyajikan output basi setelah env/lebar
 * berubah. Satu entri cukup: perubahan beruntun (mis. timer busy) memang selalu
 * miss, dan entri lama tak berguna lagi.
 */
let footerCache: { key: string; line: string } | null = null

function footerCacheKey(s: FooterStatus, cols: number): string {
  // JSON.stringify = pemisah tak ambigu; nilai model/cwd bisa memuat karakter
  // apa pun (termasuk separator buatan), dan tabrakan key = footer salah.
  return JSON.stringify([
    themeCapabilityKey(),
    cols,
    s.mode,
    s.strictBash === true,
    s.workMode ?? "",
    s.model,
    s.cwd,
    s.context ?? "",
    s.metrics ?? "",
    s.sparkFrame ?? 0,
    s.backgroundJobs ?? 0,
    s.backgroundFrame ?? 0,
    s.activity ?? "",
    s.timer ?? "",
    s.timerActive === true,
    s.timerHighlight ?? "",
  ])
}

/**
 * Render 1 baris footer untuk lebar `columns` (+ 1 baris kosong di atasnya
 * bila dilukis lengket). Tanpa garis separator — clean (keputusan user).
 * Non-TTY/dimati diputuskan pemanggil (mekanisme), bukan di sini.
 */
export function renderFooter(s: FooterStatus, columns: number): string[] {
  const cols = Math.max(10, Math.floor(columns) || 80)
  const key = footerCacheKey(s, cols)
  const cached = footerCache
  // Kembalikan array BARU tiap panggilan: pemanggil bebas memutasi hasilnya
  // tanpa merusak cache.
  if (cached && cached.key === key) return [cached.line]
  const line = buildFooterLine(s, cols)
  footerCache = { key, line }
  return [line]
}

function buildFooterLine(s: FooterStatus, cols: number): string {
  const spark = sparkGlyph(s.sparkFrame ?? 0)
  const badge =
    s.backgroundJobs != null && s.backgroundJobs >= 1
      ? `${c.muted(waitingGlyph(s.backgroundJobs, s.backgroundFrame ?? 0))}  `
      : ""
  const timerText = s.timer ? sanitizeAnsiLine(s.timer) : ""
  const timer = timerText
    ? `${paintTimer(timerText, s.timerActive === true, s.timerHighlight)}  `
    : ""
  const lead = `${spark}  ${badge}${timer}`
  const fieldGap = "  "
  // Satu-baris: cwd/model bisa berisi newline (nama dir) — sanitizeAnsiLine
  // agar \n tak memecah frame lengket ke scrollback (displayWidth menghitung
  // \n = 0 sehingga align mengira muat).
  const model = c.gray(sanitizeAnsiLine(shortModel(s.model)))
  const cwdTxt = c.muted(sanitizeAnsiLine(s.cwd))
  const shortCwdTxt = c.muted(sanitizeAnsiLine(shortenPath(s.cwd)))
  const target = Math.max(4, cols - 1)
  const ctx = s.context ? sanitizeAnsiLine(s.context) : ""
  const metrics = s.metrics ? sanitizeAnsiLine(s.metrics) : ""
  const contextParts = [ctx, metrics].filter(Boolean).map((part) => c.gray(part))
  const leftWithCwdFor = (style: ModeLabelStyle): string[] => {
    const work = paintWorkMode(s.workMode, style)
    return [
      `${lead}${work}${fieldGap}${model}${fieldGap}${cwdTxt}`,
      ...(shortCwdTxt !== cwdTxt
        ? [`${lead}${work}${fieldGap}${model}${fieldGap}${shortCwdTxt}`]
        : []),
    ]
  }
  const leftWithoutCwdFor = (style: ModeLabelStyle): string[] => {
    const work = paintWorkMode(s.workMode, style)
    return [`${lead}${work}${fieldGap}${model}`]
  }
  const leftModeOnlyFor = (style: ModeLabelStyle): string => {
    return `${lead}${paintWorkMode(s.workMode, style)}`
  }
  const rightFor = (style: ModeLabelStyle): string =>
    [
      ...contextParts,
      paintPermissionMode(s.mode, style),
      paintBashStrict(s.strictBash, s.mode === "unrestricted"),
    ]
      .filter(Boolean)
      .join(fieldGap)
  const align = (left: string, right: string): string | undefined => {
    const leftWidth = displayWidth(left)
    const rightWidth = displayWidth(right)
    const gapWidth = target - leftWidth - rightWidth
    if (gapWidth < 1) return undefined
    return `${left}${" ".repeat(gapWidth)}${right}`
  }

  // Pertahankan label penuh selama muat; jika tidak, padatkan kedua label
  // bersama-sama sebelum menghilangkan konteks atau memotong salah satu mode.
  const labelPairGroups: ReadonlyArray<ReadonlyArray<readonly [ModeLabelStyle, ModeLabelStyle]>> = [
    [
      ["full", "full"],
      ["compact", "compact"],
    ],
    [["value", "value"]],
    [
      ["full", "compact"],
      ["compact", "full"],
    ],
    [
      ["compact", "value"],
      ["value", "compact"],
    ],
    [
      ["full", "value"],
      ["value", "full"],
    ],
  ]
  for (const pairGroup of labelPairGroups) {
    for (const leftCandidates of [leftWithCwdFor, leftWithoutCwdFor]) {
      for (const [workStyle, permissionStyle] of pairGroup) {
        for (const left of leftCandidates(workStyle)) {
          const line = align(left, rightFor(permissionStyle))
          if (line && displayWidth(line) <= target) return line
        }
      }
    }
  }
  for (const pairGroup of labelPairGroups) {
    for (const [workStyle, permissionStyle] of pairGroup) {
      const line = align(leftModeOnlyFor(workStyle), rightFor(permissionStyle))
      if (line && displayWidth(line) <= target) return line
    }
  }

  // Terminal sangat sempit: pertahankan spark dan dua nilai mode, hilangkan
  // timer/model/CWD/label sebelum konteks; potong konteks lebih dahulu.
  const workValue = paintWorkMode(s.workMode, "value")
  const permissionValue = paintPermissionMode(s.mode, "value")
  const strictValue = paintBashStrict(s.strictBash, s.mode === "unrestricted")
  const shortWorkValue = workValue.trimEnd()
  const modeOnly = `${spark} ${shortWorkValue} ${[permissionValue, strictValue].filter(Boolean).join(" ")}`
  if (ctx || metrics) {
    const context = [ctx, metrics].filter(Boolean).join("  ")
    const baseWidth = displayWidth(modeOnly)
    const contextBudget = target - baseWidth - 2
    if (contextBudget > 0) {
      const shortenedContext = truncateToWidth(context, contextBudget, "…")
      const withContext = `${spark} ${shortWorkValue} ${c.gray(shortenedContext)} ${[permissionValue, strictValue].filter(Boolean).join(" ")}`
      if (displayWidth(withContext) <= target) return withContext
    }
  }
  if (displayWidth(modeOnly) <= target) return modeOnly
  return truncateToWidth(modeOnly, target, "…")
}
