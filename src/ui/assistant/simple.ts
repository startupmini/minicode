// Printer linier — satu-satunya renderer output agen (one-shot & REPL linier).
// Output append-only ke scrollback terminal, tanpa alternate screen. Tool call
// inline dan EXPANDED by default (transparansi shell); mode compact via
// MINICODE_COMPACT=1 atau setCompactMode (/compact).
import { Buffer } from "node:buffer"
import type { UiBus, UiStep } from "../contract.ts"
import {
  bufferSection,
  collapse,
  resetBufferedSections,
  sectionMinimized,
} from "../render/collapse.ts"
import { detail } from "../render/detail.ts"
import { renderDiffCard } from "../render/diff.ts"
import { formatFriendly, friendlyError, friendlyFromCategory } from "../render/errors.ts"
import { formatArgsPreview, formatProviderError, formatUsage } from "../render/format.ts"
import { highlightCode } from "../render/highlight.ts"
import { decorateMarkdown, type FenceMatch, parseFence } from "../render/markdown.ts"
import { reasoning } from "../render/reasoning.ts"
import { sanitizeAnsi, sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs } from "../render/theme.ts"
import { formatWrapped } from "../render/wrap.ts"
import { runWithoutStatus } from "../runtime/statusline.ts"

export interface SimpleOptions {
  verbose?: boolean
}

// Buffer output turn terakhir untuk /copy: teks model (sudah sanitize, sama
// seperti yang terlihat) + isi hasil tool string. BUKAN transcript penuh —
// scrollback milik terminal; ini konten yang berguna ditempel ulang. Cap agar
// sesi panjang tak membengkakkan memori.
const LAST_TURN_MAX_CHARS = 200_000
let lastTurnText = ""
/** Isi output turn terakhir (teks model + hasil tool). */
export function getLastTurnText(): string {
  return lastTurnText
}
const rememberTurn = (s: string) => {
  if (!s) return
  lastTurnText += s
  if (lastTurnText.length > LAST_TURN_MAX_CHARS)
    lastTurnText = lastTurnText.slice(-LAST_TURN_MAX_CHARS)
}

/**
 * Tulis teks ke clipboard terminal via OSC 52 (`ESC ] 52 ; c ; base64 BEL`).
 *
 * Sekuens ini SENGAJA dikecualikan dari sanitizeAnsi: sanitizer menjaga teks
 * TAK TERPERCAYA (model/tool), sedangkan payload di sini dibuat sendiri dari
 * buffer yang sudah sanitize + base64 murni — tidak ada byte kontrol asing
 * yang bisa lolos. Banyak terminal memblokir OSC 52 default; pemanggil wajib
 * menyampaikan fallback-nya ke user. Return false bila bukan TTY.
 */
export function writeClipboardOsc52(text: string): boolean {
  if (!process.stdout.isTTY) return false
  const b64 = Buffer.from(text, "utf8").toString("base64")
  process.stdout.write(`\x1b]52;c;${b64}\x07`)
  return true
}

const wOut = (s: string) => runWithoutStatus(() => process.stdout.write(s))
const wErr = (s: string) => runWithoutStatus(() => process.stderr.write(s))

// Error provider terakhir turn ini — diingat, BUKAN dicetak langsung.
// Alasan: error tengah-turn sering pulih via fallback router; mencetak tiap
// event + sekali lagi di catch driver = dua blok ✗ untuk satu kegagalan.
// Driver (index.ts/repl.ts) mencetak sekali via takePendingError().
let pendingError: string | null = null
/** Ambil + kosongkan error tertunda (consume-once per turn). */
export function takePendingError(): string | null {
  const e = pendingError
  pendingError = null
  return e
}

// Batas tampilan expanded — ADAPTIF terhadap tinggi terminal, bukan konstanta
// mati. Scrollback memang tak terbatas, tapi satu tool yang memuntahkan 10
// ribu baris di terminal 10 baris tetap menenggelamkan konteks; sebaliknya di
// terminal 60 baris preview 20 baris pelit. Dievaluasi LAZY per render (jangan
// simpan ke const — lihat P0.1).
const termRows = (): number => process.stdout.rows || 24
const TOOL_OUT_MAX_LINES = (): number => Math.max(10, termRows() - 6)
const CONTENT_PREVIEW_LINES = (): number => Math.max(6, Math.floor(termRows() / 3))
const DIFF_MAX_LINES = 24
// Tool yang hasilnya adalah KONTEN yang memang ingin dilihat user (bukan cuma
// status aksi) — di mode expanded isinya ikut dicetak.
const CONTENT_TOOLS = new Set([
  "read_file",
  "grep",
  "glob",
  "web_fetch",
  "web_search",
  "bash_output",
])

/** Gabungkan blok search/replace apply_patch menjadi sepasang teks lama/baru. */
function patchBlocks(patches: unknown): [string, string] {
  const list = Array.isArray(patches) ? (patches as { search?: string; replace?: string }[]) : []
  return [list.map((p) => p.search ?? "").join("\n"), list.map((p) => p.replace ?? "").join("\n")]
}

export function attachSimpleLogger(bus: UiBus, opts: SimpleOptions = {}): () => void {
  let streamBuffer = ""
  // State fence dipegang DI SINI, bukan di decorateMarkdown: baris datang per
  // event streaming, sedangkan decorateMarkdown memproses satu teks utuh.
  // Sebelumnya `line.includes("```")` toggle naif → fence ~~~ tidak dikenal,
  // fence berbahasa kehilangan highlight, dan wrap salah setelah fence.
  let fence: FenceMatch | null = null

  // Section thinking: "off" (belum ada), "min" (minimized → buffer),
  // "exp" (expanded → stream live). Header `  + thinking` / `  − thinking`
  // dicetak pada transisi state — scrollback append-only, jadi toggle
  // menambah baris header baru sebagai ganti menimpa yang lama.
  let thinkState: "off" | "min" | "exp" = "off"
  let thinkingBuf = ""

  const flushThinking = () => {
    if (thinkState === "min" && thinkingBuf) {
      bufferSection("thinking", thinkingBuf)
      thinkingBuf = ""
    }
    thinkState = "off"
    collapse.setActiveSection(null)
  }

  const flushLine = (line: string) => {
    const w = process.stdout.columns || 80
    const f = parseFence(line)
    if (f) {
      if (fence === null) fence = f
      else if (f.char === fence.char && f.len >= fence.len) fence = null
      // Baris pembuka/penutup fence adalah delimiter — tidak dicetak.
      return
    }
    if (fence) {
      // Di dalam fence: isi TIDAK disentuh markdown; di-highlight bila ada
      // bahasa. Tanpa bahasa, tetap apa adanya (perbaikan V8: fence tanpa
      // bahasa tidak boleh kehilangan *value* karena dianggap italic).
      const content = fence.lang ? highlightCode(line, fence.lang) : line
      wOut(`  ${content}\n`)
      return
    }
    wOut(formatWrapped(decorateMarkdown(line), w, true))
    wOut("\n")
  }
  const flushBuf = () => {
    if (!streamBuffer) return
    const parts = streamBuffer.split("\n")
    for (let i = 0; i < parts.length - 1; i++) flushLine(parts[i]!)
    streamBuffer = parts[parts.length - 1] ?? ""
  }

  const offs: (() => void)[] = []
  offs.push(
    bus.on("turn:started", (e) => {
      // Turn baru: buffer turn sebelumnya dibuang (lihat /copy yang juga
      // reset di sini) — /expand hanya untuk turn yang baru selesai.
      thinkState = "off"
      thinkingBuf = ""
      resetBufferedSections()
      collapse.setActiveSection(null)
      lastTurnText = ""
      pendingError = null
      if (opts.verbose) wErr(c.muted(`\n── Turn ${e.turn} ──\n`))
    }),
  )
  offs.push(
    bus.on("turn:completed", () => {
      flushBuf()
      if (streamBuffer) {
        flushLine(streamBuffer)
        streamBuffer = ""
      }
      flushThinking()
      if (opts.verbose) wErr(c.muted(`\n  done\n`))
    }),
  )
  offs.push(
    bus.on("provider:text", (e) => {
      // Teks model TIDAK terpercaya: tanpa sanitasi ia bisa menyisipkan sekuens
      // kontrol (bersihkan layar, ubah judul jendela) langsung ke scrollback.
      // Versi sanitize yang SAMA masuk buffer /copy (apa yang terlihat).
      // Teks = jawaban utama, SELALU tampil (tidak pernah dikecilkan).
      flushThinking()
      const clean = sanitizeAnsi(e.text)
      streamBuffer += clean
      rememberTurn(clean)
      flushBuf()
    }),
  )
  offs.push(
    bus.on("provider:extension", (e) => {
      if (e.kind === "reasoning") {
        // Section thinking: reasoning.visible = expanded (stream), else
        // minimized (satu baris `  + thinking`, isi di-buffer untuk /expand).
        // Toggle runtime /thinking, Ctrl+T, atau tombol + / - saat busy.
        collapse.setActiveSection("thinking")
        const d = e.data as { text?: string }
        const text = d.text ?? ""
        // --verbose = semua terlihat (expanded). Kalau tidak, reasoning.visible
        // menentukan: true = stream live, false = `  + thinking` + buffer.
        const expanded = opts.verbose || reasoning.visible
        if (expanded) {
          if (thinkState !== "exp") {
            thinkState = "exp"
            wErr(c.muted(`  − thinking\n`))
            if (thinkingBuf) {
              wErr(c.muted(thinkingBuf))
              thinkingBuf = ""
            }
          }
          if (text) wErr(c.muted(text))
        } else {
          if (thinkState !== "min") {
            thinkState = "min"
            wErr(c.info(`  + thinking\n`))
          }
          if (text) {
            thinkingBuf += text
            if (thinkingBuf.length > 200_000) thinkingBuf = thinkingBuf.slice(-200_000)
          }
        }
      } else if (e.kind === "usage") {
        const u = e.data as { inputTokens?: number; outputTokens?: number }
        const txt = formatUsage(u)
        if (txt && opts.verbose) wErr(c.muted(`  ${txt}\n`))
      } else if (e.kind === "bash-output") {
        // Progres bash inkremental — hanya di --verbose supaya output default
        // tidak dibanjiri log build. Ringkasan tetap muncul di execution:completed.
        if (opts.verbose) {
          const d = e.data as { text?: string }
          if (d.text) wErr(c.muted(sanitizeAnsi(d.text)))
        }
      } else if (e.kind === "error") {
        const d = e.data as { message?: string; category?: string }
        pendingError = formatProviderError(d)
      } else if (e.kind === "content_filter") {
        wErr(c.warning(`\n! Content filter blocked\n`))
      }
    }),
  )
  offs.push(
    bus.on("step:started", (e: { step: UiStep }) => {
      if (!opts.verbose) return
      const calls = e.step.toolCalls
        .map((tc) => `${c.info(tc.name)}(${c.muted(formatArgsPreview(tc.args))})`)
        .join(", ")
      wErr(c.muted(`  Step ${e.step.index}: ${calls}\n`))
    }),
  )
  offs.push(
    bus.on("execution:started", (e) => {
      // Section aktif = tool yang sedang jalan — target tombol + / - saat busy.
      collapse.setActiveSection("tool")
      if (detail.compact) {
        // Mode compact: TIDAK ada baris start. Aktivitas ditampilkan oleh
        // garis status "Thinking"/nama tool (TTY) atau diam (non-TTY) — baris
        // `running x... ` lama tanpa newline menempel ke baris ✓ berikutnya
        // di log non-interaktif, dan mencemari stderr redirect.
        return
      }
      // Expanded: user melihat tool apa yang mulai berjalan SEBELUM hasilnya,
      // inline di aliran output — transparansi ala shell (`set -x`).
      const args = (e.execution.call.args ?? {}) as Record<string, unknown>
      wErr(
        c.muted(
          `  ${glyphs.arrow} ${e.execution.call.name} ${sanitizeAnsiLine(formatArgsPreview(args))}\n`,
        ),
      )
    }),
  )
  offs.push(
    bus.on("execution:completed", (e) => {
      const r = e.execution.result
      const name = e.execution.call.name
      const args = (e.execution.call.args ?? {}) as Record<string, unknown>
      // Hasil string ikut ke buffer /copy (versi sanitize, cap per-add agar
      // satu read_file raksasa tak langsung memenuhi buffer sendirian).
      if (!r.isError && typeof r.content === "string")
        rememberTurn(sanitizeAnsi(r.content).slice(0, 20000))
      if (r.isError) {
        // Error tool SELALU tampil penuh — tidak pernah dikecilkan.
        collapse.setActiveSection(null)
        wErr(
          c.error(`  ${glyphs.arrow} ${name}: ${sanitizeAnsi(String(r.content)).slice(0, 200)}\n`),
        )
        return
      }
      const target = typeof args.path === "string" ? args.path : undefined
      // Section tool dikecilkan: satu baris `  + label`, isi di-buffer untuk
      // /expand. Ledger lain (chevron) tetap satu baris — ini menggantikan
      // pencetakan isi (bash/edit/diff/content tool), bukan marker.
      if (sectionMinimized("tool")) {
        collapse.setActiveSection(null)
        const cmdStr = (args.cmd as string) ?? (args.command as string)
        const short = sanitizeAnsiLine(target ?? formatArgsPreview(args)).slice(0, 120)
        const label =
          name === "bash" && typeof cmdStr === "string"
            ? `bash $ ${sanitizeAnsiLine(String(cmdStr)).slice(0, 80)}`
            : `${name}${short ? ` ${short}` : ""}`
        wErr(c.info(`  + ${label}\n`))
        bufferSection(label, sanitizeAnsi(String(r.content ?? "")).trim())
        return
      }
      if (name === "write_file" && target) {
        const size = typeof r.content === "string" ? `${(r.content as string).length} chars` : ""
        wOut(
          c.success(`  ${glyphs.arrow} write_file ${target}${size ? c.muted(` (${size})`) : ""}\n`),
        )
        return
      }
      if ((name === "edit" || name === "apply_patch") && target) {
        const [oldT, newT] =
          name === "edit"
            ? [String(args.oldString ?? ""), String(args.newString ?? "")]
            : patchBlocks(args.patches)
        // Expanded: diff adalah inti perubahan — tampilkan inline. Compact
        // jatuh ke baris ringkasan seperti sebelumnya.
        if (!detail.compact && (oldT || newT)) {
          wOut(
            `${renderDiffCard(target, sanitizeAnsi(oldT), sanitizeAnsi(newT), {
              maxLines: DIFF_MAX_LINES,
            })}\n`,
          )
          return
        }
        wOut(c.success(`  ${glyphs.arrow} ${name} ${target}\n`))
        return
      }
      // todo_write: tampilkan daftarnya utuh — ini rencana kerja, bukan noise.
      if (name === "todo_write" || name === "todo_read") {
        wErr(
          c.success(`  ${glyphs.arrow} ${name}\n`) +
            c.muted(`${sanitizeAnsi(String(r.content))}\n`),
        )
        return
      }
      const cmdStr = (args.cmd as string) ?? (args.command as string)
      if (name === "bash" && typeof cmdStr === "string") {
        const cmdLabel = sanitizeAnsiLine(String(cmdStr)).slice(0, 80)
        const lines = String(r.content).trim().split("\n").filter(Boolean)
        if (detail.compact) {
          const preview =
            lines.length > 3
              ? lines.slice(0, 3).join("\n    ") + c.muted(`\n    ... (${lines.length - 3} more)`)
              : lines.join("\n    ")
          wErr(c.success(`  ${glyphs.arrow} $ ${cmdLabel}\n`) + c.muted(`    ${preview}\n`))
          return
        }
        const maxLines = TOOL_OUT_MAX_LINES()
        const shown = lines.slice(0, maxLines).map((l) => `    ${sanitizeAnsi(l)}`)
        const more =
          lines.length > maxLines ? c.muted(`\n    … (${lines.length - maxLines} more lines)`) : ""
        wErr(
          c.success(`  ${glyphs.arrow} $ ${cmdLabel}\n`) +
            (shown.length ? `${c.muted(shown.join("\n")) + more}\n` : ""),
        )
        return
      }
      // Tool penghasil KONTEN (isi berkas, hasil cari) di mode compact cukup
      // satu baris › + target — isinya milik model untuk dibaca, bukan untuk
      // membanjiri scrollback pengguna. Konten tetap bisa dilihat via expanded.
      if (detail.compact && CONTENT_TOOLS.has(name)) {
        const label = sanitizeAnsiLine(target ?? formatArgsPreview(args)).slice(0, 120)
        wErr(c.success(`  ${glyphs.arrow} ${name}${label ? ` ${label}` : ""}\n`))
        return
      }
      if (!detail.compact && CONTENT_TOOLS.has(name)) {
        // Expanded: hasil berupa KONTEN (isi berkas, hasil cari) ikut mengalir.
        const raw = sanitizeAnsi(String(r.content ?? "")).trim()
        const lines = raw ? raw.split("\n") : []
        const maxPreview = CONTENT_PREVIEW_LINES()
        const preview = lines
          .slice(0, maxPreview)
          .map((l) => `    ${l}`)
          .join("\n")
        const more =
          lines.length > maxPreview
            ? c.muted(`\n    … (${lines.length - maxPreview} more lines)`)
            : ""
        const label = sanitizeAnsiLine(target ?? formatArgsPreview(args))
        wErr(
          c.success(`  ${glyphs.arrow} ${name} ${label}\n`) +
            (preview ? `${c.muted(preview) + more}\n` : ""),
        )
        return
      }
      // Sisa tool (compact & expanded): satu baris › + label. WAJIB diakhiri
      // newline — tanpa itu baris berikutnya menempel (overlap di stderr log).
      const label = sanitizeAnsiLine(target ?? formatArgsPreview(args)).slice(0, 120)
      const first = sanitizeAnsi(String(r.content)).trim().split("\n")[0] ?? ""
      const preview = first.slice(0, 80)
      if (!detail.compact && preview) {
        wErr(
          c.success(`  ${glyphs.arrow} ${name}${label ? ` ${label}` : ""} ${c.muted(preview)}\n`),
        )
        return
      }
      wErr(c.success(`  ${glyphs.arrow} ${name}${label ? ` ${label}` : ""}\n`))
    }),
  )
  offs.push(bus.on("context:compacted", (e) => wErr(c.warning(`  ── compacted: ${e.reason}\n`))))

  return () => {
    for (const off of offs) off()
  }
}

/**
 * Error apa pun → satu pesan siap tampil.
 *
 * Sebelumnya mengembalikan `${kind}: ${message}` mentah, sehingga baris terakhir
 * yang dilihat user setelah run gagal adalah dump JSON provider — pada uji live
 * OpenRouter: `provider: rate limited (429): {"error":{...400 karakter...}}`.
 * Kini kategori dipetakan lewat src/ui/render/errors.ts, sama seperti event error.
 */
export function formatError(e: unknown): string {
  const obj = e as { kind?: string; category?: string; message?: string } | undefined
  // ProviderError punya `category`; AgentError punya `kind`.
  if (obj?.category) return formatFriendly(friendlyFromCategory(obj.category, obj.message ?? ""))
  if (obj?.kind) {
    const friendly = friendlyError(`${obj.kind}: ${obj.message ?? ""}`)
    return formatFriendly(friendly)
  }
  if (e instanceof Error) return formatFriendly(friendlyError(e.message))
  return String(e)
}
