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
import { getApprovalSink } from "../tui/transcript.ts"

/** Subset struktural tool call yang dibutuhkan view — tanpa tipe kernel. */
export interface ApprovalRequest {
  name: string
  args?: unknown
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

  let actionSummary = ""
  if (args.command) actionSummary = `${t("appr.cmdLabel")} ${String(args.command).slice(0, 100)}`
  else if (args.path) actionSummary = `${t("appr.fileLabel")} ${String(args.path)}`
  else if (args.query) actionSummary = `${t("appr.queryLabel")} ${String(args.query)}`
  else {
    let json = ""
    try {
      json = JSON.stringify(args)
    } catch {
      json = String(args)
    }
    actionSummary = `${t("appr.argsLabel")} ${json.slice(0, 100)}`
  }
  actionSummary = sanitizeAnsiLine(actionSummary)

  const block = [
    ``,
    `${c.warning(c.bold(t("appr.title")))}`,
    `  ${c.bold(t("appr.tool"))} ${c.info(toolName)}`,
    `  ${actionSummary}`,
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

  const promptText = `${c.bold(t("appr.allowOnce"))}  ${c.bold(t("appr.always"))}  ${c.bold(t("appr.deny"))}: `
  let ans: string | null
  try {
    ans = (await askLine({ prompt: promptText })) ?? ""
  } finally {
    if (sink) sink.resume()
  }

  // Terima jawaban dwibahasa (prompt tampil per locale): y/yes/ya,
  // n/no/tidak/t, a/always/selalu/s. Selain itu = deny (fail-closed).
  const a = ans.trim().toLowerCase()
  const decisionKey =
    a === "a" || a === "always" || a === "selalu" || a === "s"
      ? ("appr.decAlways" as const)
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
  const q = sanitizeAnsiLine(question).slice(0, 2000)
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
    sink.pushBlock([c.muted(`  → ${sanitizeAnsiLine(out).slice(0, 200)}`)])
    sink.repaint()
  }
  return out
}
