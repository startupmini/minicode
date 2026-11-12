// View persetujuan tool — murni presentasi.
// Lapisan policy tidak mengimpor file ini; ia di-inject sebagai callback dari
// composition root (cli/setup.ts -> createMinicodeSession -> permission).
//
// Warga TUI: bila approval sink terdaftar (cli/tui.ts saat App aktif), blok
// pertanyaan dicatat ke transkrip + layar di-repaint SEBELUM user menjawab
// (jejak keputusan permanen, terlihat saat menjawab). Tanpa sink = tulis
// langsung warisan (one-shot/exec). Input jawaban tetap askLine inline di
// baris kursor — aman dari App karena input App dibekukan saat busy (hanya
// abort yang lolos; Esc/Ctrl+C di sini = abort turn + deny, fail-closed).

import { t } from "../i18n/locale.ts"
import { askLine } from "../input/input.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c } from "../render/theme.ts"
import { truncateToWidth } from "../render/width.ts"
import { getApprovalSink } from "../tui/transcript.ts"

/** Subset struktural tool call yang dibutuhkan view — tanpa tipe kernel. */
export interface ApprovalRequest {
  name: string
  args?: unknown
  /** F-APPROVAL-1: tier risiko efek samping (dari policy, sudah dikanonkan). */
  riskTier?: string
  /** F-APPROVAL-1: pratinjau diff ringkas (dari policy, sudah di-scrub secret). */
  diffPreview?: string
  /**
   * P1.2: apakah `always` benar-benar dapat dipersist untuk call ini. Policy
   * menolak menyimpan args > 2 KB (allowlist tidak boleh menjadi blanket-allow);
   * UI wajib menyembunyikan opsi yang no-op.
   */
  canAlways?: boolean
}

// F-APPROVAL-1: label tier risiko yang terlokalisasi — view TIDAK import policy,
// jadi cuma memetakan string tier kanonik → kunci i18n. Tier tak dikenal =
// undefined (tidak menebak label palsu; baris risiko dihilangkan).
function tierLabel(riskTier?: string): string | undefined {
  switch (riskTier) {
    case "PURE_READ":
      return t("appr.tier.pure")
    case "WORKSPACE_MUTATION":
      return t("appr.tier.workspace")
    case "LOCAL_ENV_MUTATION":
      return t("appr.tier.localenv")
    case "EXTERNAL_IRREVERSIBLE":
      return t("appr.tier.external")
    case "UNKNOWN":
      return t("appr.tier.unknown")
    default:
      return undefined
  }
}

export async function promptAsk(call: ApprovalRequest): Promise<"allow" | "deny" | "always"> {
  if (!process.stdin.isTTY) return "deny"
  const sink = getApprovalSink()
  // Tanpa sink (one-shot/exec) + stdout di-pipe: prompt tak terlihat user DAN
  // askLine/blok akan mencemari stdout (kontrak: stdout = output PROGRAM).
  // Fail-closed: tolak daripada mencemari pipe (kontrak I23).
  if (!sink && !process.stdout.isTTY) return "deny"
  // Non-visual feedback bisa dimatikan untuk aksesibilitas/recording.
  // Bell hanya bila stdout TTY: byte `\x07` di stdout pipe mengotori output
  // program (kontrak: stdout = output PROGRAM, bukan diagnostik).
  if (process.env.MINICODE_BELL !== "0" && process.stdout.isTTY) process.stdout.write("\x07")
  // Live-region untuk screen reader: baris polos tanpa ANSI agar terbaca
  // sebagai teks, bukan escape mentah. Bell saja mengganggu tanpa informasi.
  if (process.env.MINICODE_A11Y === "1")
    process.stderr.write(`${t("appr.a11y", { name: sanitizeAnsiLine(call.name) })}\n`)

  // toolName/actionSummary berasal dari model/MCP (tidak terpercaya). Tanpa
  // sanitasi, `\x1b[2J\x1b[H` di dalam args.command akan membersihkan layar
  // terminal user saat prompt persetujuan tampil (sama seperti provider:text).
  const toolName = sanitizeAnsiLine(call.name)
  const args = (call.args ?? {}) as Record<string, unknown>

  // Sanitasi DULU, potong SESUDAH: `slice` mentah bisa membelah surrogate
  // pair (byte U+FFFD di layar) dan memotong sekuens ANSI di tengah sehingga
  // ekor `\x1b[` menggantung (terminal menelan output berikutnya sebagai
  // parameter CSI) — audit 2026-11-12, MEDIUM-1.
  const summarize = (value: unknown, max: number): string =>
    truncateToWidth(sanitizeAnsiLine(String(value)), max, "…")
  let actionSummary = ""
  if (args.command) actionSummary = `${t("appr.cmdLabel")} ${summarize(args.command, 100)}`
  else if (args.path) actionSummary = `${t("appr.fileLabel")} ${summarize(args.path, 100)}`
  else if (args.query) actionSummary = `${t("appr.queryLabel")} ${summarize(args.query, 100)}`
  else {
    let json = ""
    try {
      json = JSON.stringify(args)
    } catch {
      json = String(args)
    }
    actionSummary = `${t("appr.argsLabel")} ${summarize(json, 100)}`
  }
  actionSummary = sanitizeAnsiLine(actionSummary)

  // F-APPROVAL-1: bila policy sudah memberi pratinjau diff yang representatif +
  // dibasuh secret, tampilkan itu sebagai baris "apa yang akan terjadi" —
  // lebih jujur dari ringkasan args. Fallback ringkasan args (di atas) tetap
  // dipakai untuk jalur tanpa diff (mis. promptAsk dipanggil langsung/test).
  // Diff juga input tak terpercaya (bisa memuat ANSI dari path/konten) → sanitasi.
  const diffPreview = call.diffPreview ? sanitizeAnsiLine(call.diffPreview) : ""
  const riskText = tierLabel(call.riskTier)

  const block = [
    ``,
    `${c.warning(c.bold(t("appr.title")))}`,
    `  ${c.bold(t("appr.tool"))} ${c.info(toolName)}`,
    ...(riskText ? [`  ${c.dim(t("appr.risk"))} ${c.info(riskText)}`] : []),
    `  ${diffPreview ? `${t("appr.diff")} ${diffPreview}` : actionSummary}`,
  ]
  if (sink) {
    sink.pushBlock(block)
    sink.repaint()
    // Bekukan App selama menunggu jawaban (pola popup komposit): tanpa ini
    // listener App + repaint live berlomba dengan askLine — prompt tak
    // terlihat, user mengetik buta. Esc/Ctrl+C di sini = deny (batal hanya
    // tool ini), BUKAN abort turn — turn lanjut dengan tool lain.
    sink.suspend()
  } else {
    for (const l of block) process.stdout.write(`${l}\n`)
  }

  const alwaysAvailable = call.canAlways !== false
  const promptText = alwaysAvailable
    ? `${c.bold(t("appr.allowOnce"))}  ${c.bold(t("appr.always"))}  ${c.bold(t("appr.deny"))}: `
    : `${c.bold(t("appr.allowOnce"))}  ${c.bold(t("appr.deny"))}: `
  let ans: string | null
  try {
    ans = (await askLine({ prompt: promptText })) ?? ""
  } finally {
    if (sink) sink.resume()
  }

  // Terima jawaban dwibahasa (prompt tampil per locale): y/yes/ya,
  // n/no/tidak/t, a/always/selalu/s. Selain itu = deny (fail-closed).
  const a = ans.trim().toLowerCase()
  const wantsAlways = a === "a" || a === "always" || a === "selalu" || a === "s"
  const decisionKey = wantsAlways
    ? // Opsi yang tidak ditampilkan tidak boleh diterima diam-diam; fail-closed.
      alwaysAvailable
      ? ("appr.decAlways" as const)
      : ("appr.decDeny" as const)
    : a === "y" || a === "yes" || a === "ya"
      ? ("appr.decAllow" as const)
      : ("appr.decDeny" as const)
  const decision = t(decisionKey)
  // Keputusan dicatat di transkrip (jejak audit); warisan mengandalkan
  // scrollback askLine yang terhapus repaint.
  if (sink) {
    sink.pushBlock([c.muted(`  → ${decision}`)])
    sink.repaint()
  }
  return decisionKey === "appr.decAlways"
    ? "always"
    : decisionKey === "appr.decAllow"
      ? "allow"
      : "deny"
}

/** View pertanyaan ask_user — di-inject ke src/tools/ask_user.ts dari cli/setup.ts.
 * Teks pertanyaan berasal dari model (tidak terpercaya): disanitasi sebelum
 * tampil agar tak bisa membersihkan layar via escape sequence. Return null
 * bila user membatalkan (Esc/Ctrl+C → askLine null) atau jawaban kosong. */
export async function promptAskText(question: string, options?: string[]): Promise<string | null> {
  if (!process.stdin.isTTY) return null
  const textSink = getApprovalSink()
  // Paritas promptAsk: tanpa sink + stdout pipe = jawab tak terlihat & pipe
  // tercemar → batal fail-closed.
  if (!textSink && !process.stdout.isTTY) return null
  // Potong SESUDAH sanitasi lewat truncateToWidth (bukan `slice`): `slice`
  // bisa menyisakan `\x1b[` menggantung di ekor potongan.
  const q = truncateToWidth(sanitizeAnsiLine(question), 2000, "…")
  const block = [
    ``,
    `${c.warning(c.bold(t("appr.askTitle")))}`,
    `  ${q}`,
    ...(options?.length
      ? options.map((o, i) => `  ${c.dim(`${i + 1}.`)} ${sanitizeAnsiLine(o)}`)
      : []),
  ]
  const sink = textSink
  if (sink) {
    sink.pushBlock(block)
    sink.repaint()
    sink.suspend()
  } else {
    for (const l of block) process.stdout.write(`${l}\n`)
  }
  let ans: string | null
  try {
    ans = await askLine({ prompt: `${c.bold(t("appr.answerPrompt"))}` })
  } finally {
    if (sink) sink.resume()
  }
  if (ans == null || !ans.trim()) return null
  const out = ans.trim()
  if (sink) {
    // Gema jawaban juga dipotong lewat truncateToWidth: `slice` bisa membelah
    // surrogate pair (emoji → U+FFFD) atau menyisakan escape menggantung.
    sink.pushBlock([c.muted(`  → ${truncateToWidth(sanitizeAnsiLine(out), 200, "…")}`)])
    sink.repaint()
  }
  return out
}
