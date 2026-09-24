// Printer linier — satu-satunya renderer output agen (one-shot & REPL linier).
// Output append-only ke scrollback terminal, tanpa alternate screen. Tool call
// inline dan EXPANDED by default (transparansi shell); mode compact via
// MINICODE_COMPACT=1 atau setCompactMode (/compact).
import { Buffer } from "node:buffer"
import type {
  UiBus,
  UiPresentationActivity,
  UiPresentationEvent,
  UiPresentationSnapshot,
  UiStep,
} from "../contract.ts"
import { t } from "../i18n/locale.ts"
import {
  clearCollapsedSections,
  collapse,
  rememberCollapsedSection,
  sectionMinimized,
} from "../render/collapse.ts"
import { detail } from "../render/detail.ts"
import { renderDiffCard } from "../render/diff.ts"
import { formatFriendly, friendlyError, friendlyFromCategory } from "../render/errors.ts"
import { formatArgsPreview, formatProviderError, formatUsage } from "../render/format.ts"
import { highlightCode } from "../render/highlight.ts"
import { decorateMarkdown, type FenceMatch, parseFence } from "../render/markdown.ts"
import { reasoning } from "../render/reasoning.ts"
import {
  cleanUntrusted,
  createStreamSanitizer,
  sanitizeAnsi,
  sanitizeAnsiLine,
  stripSgr,
} from "../render/sanitize.ts"
import { c, glyphs, stripAnsi } from "../render/theme.ts"
import { displayWidth, truncateToWidth } from "../render/width.ts"
import { formatWrapped } from "../render/wrap.ts"
import { runWithoutStatus } from "../runtime/statusline.ts"

export interface SimpleOptions {
  verbose?: boolean
  /**
   * Mode senyap untuk TUI fullscreen: semua tulis ke stdout/stderr DITEKAN,
   * tapi state tetap jalan (rememberTurn untuk /copy, rememberCollapsedSection untuk
   * /expand, pendingError untuk driver). Tanpa ini printer linier mengotori
   * alt-screen di sela repaint App — kontrak I3 (App penulis tunggal layar).
   */
  quiet?: boolean
  getSnapshot?: () => UiPresentationSnapshot | null
  onPresentationEvent?: (handler: (event: UiPresentationEvent) => void) => () => void
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
  // Samakan dengan yang terlihat: kebijakan pipa (F2) berlaku juga untuk /copy.
  lastTurnText += process.stdout.isTTY ? s : stripSgr(s)
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

const wOutDirect = (s: string) =>
  runWithoutStatus(() => process.stdout.write(process.stdout.isTTY ? s : stripSgr(s)))
const wErrDirect = (s: string) =>
  runWithoutStatus(() => process.stderr.write(process.stdout.isTTY ? s : stripSgr(s)))

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
  // Shadow module-level wOut/wErr: saat quiet, paint ditekan tapi SEMUA state
  // (rememberTurn, rememberCollapsedSection, pendingError, sanitizer) tetap jalan.
  // Shadowing disengaja agar ~20 call-site tak perlu diubah satu per satu.
  const wOut = opts.quiet ? (_: string) => {} : wOutDirect
  const wErr = opts.quiet ? (_: string) => {} : wErrDirect
  let streamBuffer = ""
  // Sanitizer sadar-stream per aliran teks (temuan F1): ekor escape yang
  // terpotong di batas chunk ditahan dan disambung ke chunk berikut SEBELUM
  // sanitasi — tanpa ini "ESC[" + "32m" tampil literal. Satu instans per
  // aliran (model/reasoning/bash) agar state ekor tak tercampur. Ekor yang
  // tersisa saat turn selesai/detach DIBUANG (flush di bawah): escape tanpa
  // teks lanjutan tak punya efek tampak kecuali mutasi state terminal.
  const textSan = createStreamSanitizer()
  const reasoningSan = createStreamSanitizer()
  const bashSan = createStreamSanitizer()
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
  // Batas buffer thinking + marker head-drop (F3): bila kepala dibuang,
  // operator wajib tahu dari /expand bahwa isi tak lengkap — jangan biarkan
  // ia percaya seluruh thinking tersedia. Terminologi mengikuti marker
  // truncasi lain ("… (N more…)", ", capped 1MB").
  const THINKING_BUF_MAX = 200_000
  const THINKING_TRUNCATED_MARKER = "… (earlier thinking truncated)\n"
  // Sisa baris reasoning yang belum ber-newline (mode expanded): di-flush
  // per baris utuh agar tampilan rapi, bukan salad fragmen per chunk.
  let reasoningLine = ""

  // Section answer (jawaban model): default minimize di REPL — teks lengkap
  // TETAP ditulis (buffer), tampilan default satu baris `  + answer (N)`.
  // /copy tak tersentuh (rememberTurn selalu jalan sebelum sink).
  let answerBuf = ""
  let answerTruncated = false
  const ANSWER_BUF_MAX = 1_000_000
  // Jawaban tak pernah disembunyikan di pipa/CI (output mesin harus utuh)
  // dan --verbose selalu menampilkan semua.
  const answerHidden = (): boolean =>
    sectionMinimized("answer") && !!process.stdout.isTTY && !opts.verbose
  const emitAnswer = (s: string) => {
    if (!answerHidden()) {
      wOut(s)
      return
    }
    if (answerBuf.length < ANSWER_BUF_MAX) {
      // Jangan belah surrogate pair di batas cap: slice mentah bisa
      // menyisakan lead-surrogate yatim yang tampil sebagai U+FFFD di /expand.
      let chunk = s.slice(0, ANSWER_BUF_MAX - answerBuf.length)
      const last = chunk.charCodeAt(chunk.length - 1)
      if (chunk.length > 0 && last >= 0xd800 && last <= 0xdbff) chunk = chunk.slice(0, -1)
      answerBuf += chunk
      if (answerBuf.length >= ANSWER_BUF_MAX) answerTruncated = true
    } else {
      answerTruncated = true
    }
  }

  /** Potong ke ≤max KOLOM terminal di batas kata (fallback potong keras).
   * Versi lama memakai s.length/slice karakter: CJK/emoji 2-kolom meluap dan
   * slice mentah bisa membelah sekuens SGR/surrogate — truncateToWidth aman
   * untuk keduanya (tak pernah belah escape, tutup atribut terbuka). */
  const truncateWords = (s: string, max: number): string => {
    if (displayWidth(s) <= max) return s
    let out = ""
    for (const w of s.split(" ")) {
      const cand = out ? `${out} ${w}` : w
      if (displayWidth(cand) > max) break
      out = cand
    }
    // Satu kata raksasa tanpa spasi: potong keras yang aman-SGR, tanpa elipsis
    // (label ringkas, bukan tajuk terpotong).
    if (!out) return truncateToWidth(s, max, "")
    return out
  }

  /** Label satu-baris ringkas per tool (bukan dump JSON argumen). */
  const fallbackToolLabel = (
    name: string,
    args: Record<string, unknown>,
    target?: string,
  ): string => {
    if (name === "todo_write" || name === "todo_read") {
      const list = args.todos
      const n = Array.isArray(list) ? list.length : 0
      return n > 0 ? `${name} ${n} items` : name
    }
    if (name === "bash") {
      const cmdStr = (args.cmd as string) ?? (args.command as string)
      if (typeof cmdStr === "string")
        return `bash $ ${truncateWords(sanitizeAnsiLine(String(cmdStr)), 80)}`
      return name
    }
    const short = truncateWords(sanitizeAnsiLine(target ?? formatArgsPreview(args)), 120)
    // Nama tool ikut dari event model — sanitasi di label akhir (perbandingan
    // === di atas tetap pakai nama mentah).
    const tagged = short ? `${name} ${short}` : name
    return sanitizeAnsiLine(tagged)
  }

  const flushReasoningTail = () => {
    if (reasoningLine) {
      wErr(c.muted(`${reasoningLine}\n`))
      reasoningLine = ""
    }
  }

  // Sisa jawaban yang dikecilkan difinalkan: satu baris ringkas + isi masuk
  // buffer /expand (dibuka via stdout agar kontrak stream terjaga).
  // Dipakai turn:completed DAN detach — abort tanpa completed tak boleh
  // menghilangkan konten diam-diam (perilaku lama menampilkannya live).
  const finalizeAnswer = () => {
    if (answerBuf.length === 0) return
    // Hitung per code point (bukan UTF-16 unit): emoji surrogate dihitung 1,
    // konsisten dengan label "chars" dan tak menggandakan di /expand.
    const n = Array.from(stripAnsi(answerBuf)).length
    const cap = answerTruncated ? t("one.answerCap") : ""
    // Petunjuk /expand WAJIB di baris ini: tanpa itu jawaban yang dikecilkan
    // terlihat "bisu" (tak ada cara membuka yang bisa ditemukan user).
    wErr(c.info(t("one.answerMin", { n, cap })))
    rememberCollapsedSection("answer", answerBuf, "stdout")
    answerBuf = ""
    answerTruncated = false
  }

  const flushThinking = () => {
    flushReasoningTail()
    if (thinkState === "min" && thinkingBuf) {
      rememberCollapsedSection("thinking", thinkingBuf)
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
      emitAnswer(`  ${content}\n`)
      return
    }
    emitAnswer(formatWrapped(decorateMarkdown(line), w, true))
    emitAnswer("\n")
  }
  const flushBuf = () => {
    if (!streamBuffer) return
    const parts = streamBuffer.split("\n")
    for (let i = 0; i < parts.length - 1; i++) flushLine(parts[i]!)
    streamBuffer = parts[parts.length - 1] ?? ""
  }

  const presentationEnabled = !!opts.getSnapshot
  const presentedTerminals = new Set<string>()
  const presentationSnapshot = (): UiPresentationSnapshot | null => {
    if (!presentationEnabled || !opts.getSnapshot) return null
    try {
      return opts.getSnapshot()
    } catch {
      return null
    }
  }
  const presentationActivity = (toolCallId: string | undefined) => {
    if (!toolCallId) return undefined
    return presentationSnapshot()?.activities.find((activity) => activity.toolCallId === toolCallId)
  }
  const statusWord = (status: UiPresentationActivity["status"]): string => {
    if (status === "completed") return t("ts.statusCompleted")
    if (status === "failed") return t("ts.statusFailed")
    if (status === "denied") return t("ts.statusDenied")
    if (status === "cancelled") return t("ts.statusCancelled")
    if (status === "interrupted") return t("ts.statusInterrupted")
    return t("ts.statusRunning")
  }
  const linearSuffix = (activity: UiPresentationActivity | undefined): string => {
    if (!activity) return ""
    const parts: string[] = [statusWord(activity.status)]
    if (activity.durationMs !== undefined)
      parts.push(t("one.duration", { v: Math.max(0, Math.round(activity.durationMs)) }))
    if (activity.denyReason)
      parts.push(t("one.denyReason", { reason: sanitizeAnsiLine(activity.denyReason) }))
    const paths = activity.receipt?.paths ?? []
    if (paths.length > 0) {
      const cleanPaths = paths
        .map((path) => truncateToWidth(sanitizeAnsiLine(path), 80, ""))
        .join(", ")
      parts.push(t("one.receipt", { paths: cleanPaths }))
    }
    if (activity.supersedes) parts.push(t("ts.retry"))
    return parts.length > 0 ? ` ${c.muted(`[${parts.join(" · ")}]`)}` : ""
  }
  const paintTerminal = (status: UiPresentationActivity["status"], line: string): string => {
    if (status === "failed") return c.error(line)
    if (status === "denied") return c.warning(line)
    if (status === "completed") return c.success(line)
    return c.muted(line)
  }
  const writePresentationTerminal = (event: UiPresentationEvent): void => {
    if (!presentationEnabled) return
    if (
      event.type !== "tool.failed" &&
      event.type !== "tool.denied" &&
      event.type !== "tool.cancelled"
    ) {
      return
    }
    if (!event.toolCallId) return
    if (presentedTerminals.has(event.toolCallId)) return
    presentedTerminals.add(event.toolCallId)
    const activity = presentationActivity(event.toolCallId)
    const name = sanitizeAnsiLine(activity?.name ?? event.name ?? "tool")
    const target = activity?.target ?? event.target
    const targetText = target ? ` ${truncateToWidth(sanitizeAnsiLine(target), 120, "")}` : ""
    const status = activity?.status ?? event.status ?? "failed"
    const message = event.message ?? activity?.error?.message
    const detail = message
      ? `: ${truncateToWidth(sanitizeAnsi(String(message)), 200, "…").split("\n")[0] ?? ""}`
      : ""
    const line = `  ${glyphs.arrow} ${name}${targetText}${linearSuffix(activity)}${detail}`
    wErr(paintTerminal(status, `${line}\n`))
  }

  const offs: (() => void)[] = []
  if (opts.onPresentationEvent) {
    offs.push(opts.onPresentationEvent((event) => writePresentationTerminal(event)))
  }
  offs.push(
    bus.on("turn:started", (e) => {
      // Turn baru: buffer turn sebelumnya dibuang (lihat /copy yang juga
      // reset di sini) — /expand hanya untuk turn yang baru selesai.
      thinkState = "off"
      thinkingBuf = ""
      reasoningLine = ""
      answerBuf = ""
      answerTruncated = false
      clearCollapsedSections()
      collapse.setActiveSection(null)
      lastTurnText = ""
      pendingError = null
      presentedTerminals.clear()

      if (opts.verbose) wErr(c.muted(t("one.turnHead", { n: e.turn })))
    }),
  )
  offs.push(
    bus.on("turn:completed", () => {
      flushBuf()
      if (streamBuffer) {
        flushLine(streamBuffer)
        streamBuffer = ""
      }
      // Ekor escape yang tertahan (F1) dibuang di sini — deterministik, tak
      // pernah bocor mentah; begitu pula saat detach/abort di bawah.
      textSan.flush()
      reasoningSan.flush()
      bashSan.flush()
      flushThinking()
      finalizeAnswer()
      if (opts.verbose) wErr(c.muted(t("one.done")))
    }),
  )
  offs.push(
    bus.on("provider:text", (e) => {
      // Teks model TIDAK terpercaya: tanpa sanitasi ia bisa menyisipkan sekuens
      // kontrol (bersihkan layar, ubah judul jendela) langsung ke scrollback.
      // Versi sanitize yang SAMA masuk buffer /copy (apa yang terlihat).
      // Teks = jawaban; section-nya ikut collapse (minimize → buffer + expand
      // via + / /expand), kecuali pipa/CI/verbose yang selalu stream.
      flushThinking()
      collapse.setActiveSection("answer")
      if (!answerHidden() && answerBuf.length > 0) {
        wErr(c.muted(t("one.answerOpen")))
        wOut(answerBuf)
        answerBuf = ""
        answerTruncated = false
      }
      const clean = cleanUntrusted(textSan.push(e.text), !!process.stdout.isTTY)
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
            wErr(c.muted(t("one.thinkOpen")))
            if (thinkingBuf) {
              wErr(c.muted(thinkingBuf))
              thinkingBuf = ""
            }
          }
          // Line-buffered: kumpulkan sampai newline agar tampilan rapi
          // (bukan salad fragmen per chunk); sisa di-flush saat fase berakhir.
          if (text) {
            // Teks reasoning TAK TERPERCAYA seperti provider:text — sanitasi
            // saat masuk (bukan saat flush) agar tak ada jalur cetak yang lupa.
            // Sadar-stream (F1) + kebijakan pipa (F2) seperti teks model.
            reasoningLine += cleanUntrusted(reasoningSan.push(text), !!process.stdout.isTTY)
            const parts = reasoningLine.split("\n")
            for (let i = 0; i < parts.length - 1; i++) wErr(c.muted(`${parts[i]}\n`))
            reasoningLine = parts[parts.length - 1] ?? ""
          }
        } else {
          if (thinkState !== "min") {
            thinkState = "min"
            // Sisa baris expanded yang belum selesai dicetak dulu (terlihat),
            // baru header minimize — konten tak hilang, tak menempel.
            flushReasoningTail()
            wErr(c.info(t("one.thinkMin")))
          }
          if (text) {
            // Sama: buffer thinking ikut tercemar bila mentah (flush expanded
            // mencetaknya verbatim + /expand menampilkannya lagi). Sadar-stream
            // (F1) + kebijakan pipa (F2); marker truncasi di bawah (F3).
            thinkingBuf += cleanUntrusted(reasoningSan.push(text), !!process.stdout.isTTY)
            if (thinkingBuf.length > THINKING_BUF_MAX) {
              // Total ber-marker dibatasi THINKING_BUF_MAX (= cap per-entry
              // rememberCollapsedSection) agar tak ada pemotongan diam-diam kedua di hilir.
              // Tail-slice jangan mulai di tengah surrogate pair: trail
              // yatim di awal tampil sebagai U+FFFD saat /expand.
              const body = thinkingBuf.startsWith(THINKING_TRUNCATED_MARKER)
                ? thinkingBuf.slice(THINKING_TRUNCATED_MARKER.length)
                : thinkingBuf
              let tail = body.slice(-(THINKING_BUF_MAX - THINKING_TRUNCATED_MARKER.length))
              const first = tail.charCodeAt(0)
              if (tail.length > 0 && first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1)
              thinkingBuf = THINKING_TRUNCATED_MARKER + tail
            }
          }
        }
      } else if (e.kind === "usage") {
        const u = e.data as { inputTokens?: number; outputTokens?: number }
        const txt = formatUsage(u)
        if (txt && opts.verbose) wErr(c.muted(`  ${txt}\n`))
      } else if (e.kind === "bash-output") {
        // Progres bash inkremental — hanya di --verbose supaya output default
        // tidak dibanjiri log build. Ringkasan tetap muncul di execution:completed.
        // Sadar-stream (F1): progres datang per event seperti teks model.
        if (opts.verbose) {
          const d = e.data as { text?: string }
          if (d.text) wErr(c.muted(cleanUntrusted(bashSan.push(d.text), !!process.stdout.isTTY)))
        }
      } else if (e.kind === "error") {
        const d = e.data as { message?: string; category?: string }
        pendingError = formatProviderError(d)
      } else if (e.kind === "content_filter") {
        wErr(c.warning(t("one.contentBlocked")))
      }
    }),
  )
  offs.push(
    bus.on("step:started", (e: { step: UiStep }) => {
      if (!opts.verbose) return
      const calls = e.step.toolCalls
        // Nama + argumen dari model (tak terpercaya): sanitasi sebelum tampil.
        .map(
          (tc) =>
            `${c.info(sanitizeAnsiLine(tc.name))}(${c.muted(sanitizeAnsiLine(formatArgsPreview(tc.args)))})`,
        )
        .join(", ")
      wErr(c.muted(t("one.step", { i: e.step.index, calls })))
    }),
  )
  offs.push(
    bus.on("execution:started", (e) => {
      // Section aktif = tool yang sedang jalan — target tombol + / - saat busy.
      collapse.setActiveSection("tool")
      // Ganti fase: sisa baris thinking yang belum ber-newline dicetak dulu
      // agar tak menempel ke baris tool.
      flushReasoningTail()
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
          `  ${glyphs.arrow} ${sanitizeAnsiLine(e.execution.call.name)} ${sanitizeAnsiLine(formatArgsPreview(args))}\n`,
        ),
      )
    }),
  )
  offs.push(
    bus.on("execution:completed", (e) => {
      const callId = e.execution.call.id
      const activity = presentationActivity(callId)
      if (activity && activity.status !== "completed" && callId && presentedTerminals.has(callId)) {
        return
      }
      const r = e.execution.result
      const name = e.execution.call.name
      const args = (e.execution.call.args ?? {}) as Record<string, unknown>
      const suffix = linearSuffix(activity)
      const isError = activity ? activity.status !== "completed" : r.isError === true
      // Hasil string ikut ke buffer /copy (versi sanitize, cap per-add agar
      // satu read_file raksasa tak langsung memenuhi buffer sendirian).
      if (!isError && typeof r.content === "string")
        rememberTurn(truncateToWidth(sanitizeAnsi(r.content), 20000, ""))
      if (isError) {
        // Error tool ditampilkan ringkas per baris (cap 200 kolom + marker) —
        // tanpa marker user tak bisa bedakan "pesan 200 kolom" vs "terpotong".
        collapse.setActiveSection(null)
        wErr(
          c.error(
            `  ${glyphs.arrow} ${sanitizeAnsiLine(name)}${suffix}: ${truncateToWidth(sanitizeAnsi(String(r.content)), 200, "…")}\n`,
          ),
        )
        return
      }
      const target = typeof args.path === "string" ? args.path : undefined
      // Section tool dikecilkan: satu baris `  + label`, isi di-buffer untuk
      // /expand. Ledger lain (chevron) tetap satu baris — ini menggantikan
      // pencetakan isi (bash/edit/diff/content tool), bukan marker.
      if (sectionMinimized("tool")) {
        collapse.setActiveSection(null)
        const label = activity?.summary
          ? sanitizeAnsiLine(activity.summary)
          : fallbackToolLabel(name, args, target)
        wErr(c.info(`  + ${label}${suffix}\n`))
        rememberCollapsedSection(label, sanitizeAnsi(String(r.content ?? "")).trim())
        return
      }
      if (name === "write_file" && target) {
        const size = typeof r.content === "string" ? `${(r.content as string).length} chars` : ""
        // Target dari argumen model — sanitasi agar path berisi escape tak
        // membersihkan layar saat receipt sukses tampil.
        const cleanTarget = sanitizeAnsiLine(target)
        wOut(
          c.success(
            `  ${glyphs.arrow} write_file ${cleanTarget}${size ? c.muted(` (${size})`) : ""}${suffix}\n`,
          ),
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
            `${renderDiffCard(sanitizeAnsiLine(target), sanitizeAnsi(oldT), sanitizeAnsi(newT), {
              maxLines: DIFF_MAX_LINES,
            })}\n`,
          )
          return
        }
        wOut(
          c.success(
            `  ${glyphs.arrow} ${sanitizeAnsiLine(name)} ${sanitizeAnsiLine(target)}${suffix}\n`,
          ),
        )
        return
      }
      // todo_write: tampilkan daftarnya utuh — ini rencana kerja, bukan noise.
      if (name === "todo_write" || name === "todo_read") {
        // Nama tool dari event model (tak terpercaya): sanitasi seperti cabang
        // lain agar ESC[2J/OSC tak lolos via label.
        const cleanName = sanitizeAnsiLine(name)
        wErr(
          c.success(`  ${glyphs.arrow} ${cleanName}${suffix}\n`) +
            c.muted(`${sanitizeAnsi(String(r.content))}\n`),
        )
        return
      }
      const cmdStr = (args.cmd as string) ?? (args.command as string)
      if (name === "bash" && typeof cmdStr === "string") {
        const cmdLabel = truncateToWidth(sanitizeAnsiLine(String(cmdStr)), 80, "")
        // Output tool tak terpercaya (bisa berisi isi berkas): sanitasi SEKALI
        // di sini — cabang compact di bawah dan expanded map di-sanitize lagi
        // (idempoten) sehingga tak ada cabang yang mentah.
        const lines = sanitizeAnsi(String(r.content)).trim().split("\n").filter(Boolean)
        if (detail.compact) {
          const preview =
            lines.length > 3
              ? lines.slice(0, 3).join("\n    ") + c.muted(t("one.more3", { n: lines.length - 3 }))
              : lines.join("\n    ")
          wErr(
            c.success(`  ${glyphs.arrow} $ ${cmdLabel}${suffix}\n`) + c.muted(`    ${preview}\n`),
          )
          return
        }
        const maxLines = TOOL_OUT_MAX_LINES()
        const shown = lines.slice(0, maxLines).map((l) => `    ${sanitizeAnsi(l)}`)
        const more =
          lines.length > maxLines ? c.muted(t("one.moreLines", { n: lines.length - maxLines })) : ""
        wErr(
          c.success(`  ${glyphs.arrow} $ ${cmdLabel}${suffix}\n`) +
            (shown.length ? `${c.muted(shown.join("\n")) + more}\n` : ""),
        )
        return
      }
      // Tool penghasil KONTEN (isi berkas, hasil cari) di mode compact cukup
      // satu baris › + target — isinya milik model untuk dibaca, bukan untuk
      // membanjiri scrollback pengguna. Konten tetap bisa dilihat via expanded.
      if (detail.compact && CONTENT_TOOLS.has(name)) {
        const label = activity?.summary
          ? sanitizeAnsiLine(activity.summary)
          : truncateWords(sanitizeAnsiLine(target ?? formatArgsPreview(args)), 120)

        wErr(
          c.success(
            `  ${glyphs.arrow} ${sanitizeAnsiLine(name)}${label ? ` ${label}` : ""}${suffix}\n`,
          ),
        )
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
          c.success(`  ${glyphs.arrow} ${sanitizeAnsiLine(name)} ${label}\n`) +
            (preview ? `${c.muted(preview) + more}\n` : ""),
        )
        return
      }
      // Sisa tool (compact & expanded): satu baris › + label. WAJIB diakhiri
      // newline — tanpa itu baris berikutnya menempel (overlap di stderr log).
      const label = activity?.summary
        ? sanitizeAnsiLine(activity.summary)
        : truncateWords(sanitizeAnsiLine(target ?? formatArgsPreview(args)), 120)
      const first = sanitizeAnsi(String(r.content)).trim().split("\n")[0] ?? ""
      const preview = truncateToWidth(first, 80, "")
      const cleanName = sanitizeAnsiLine(name)
      if (!detail.compact && preview) {
        wErr(
          c.success(
            `  ${glyphs.arrow} ${cleanName}${label ? ` ${label}` : ""}${suffix} ${c.muted(preview)}\n`,
          ),
        )
        return
      }
      wErr(c.success(`  ${glyphs.arrow} ${cleanName}${label ? ` ${label}` : ""}${suffix}\n`))
    }),
  )
  offs.push(
    bus.on("context:compacted", (e) =>
      wErr(
        c.warning(`${t("ts.compacted", { reason: sanitizeAnsiLine(String(e.reason ?? "")) })}\n`),
      ),
    ),
  )

  return () => {
    // Sisa parsal di-flush dulu (jangan hilang diam-diam), baru lepas.
    // Tanpa ini detach di tengah baris membuang ekornya — dan di jalur abort
    // (tanpa turn:completed) sisa streamBuffer bocor ke turn berikutnya.
    if (streamBuffer) {
      flushLine(streamBuffer)
      streamBuffer = ""
    }
    // Ekor escape tertahan (F1) dibuang di sini juga: abort/error/budget
    // tanpa turn:completed tak boleh meninggalkan ANSI tail.
    textSan.flush()
    reasoningSan.flush()
    bashSan.flush()
    flushReasoningTail()
    flushThinking()
    finalizeAnswer()
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
