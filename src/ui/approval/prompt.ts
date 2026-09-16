// View persetujuan tool — readline + warna, murni presentasi.
// Lapisan policy tidak mengimpor file ini; ia di-inject sebagai callback dari
// composition root (cli/setup.ts -> createMinicodeSession -> permission).
import { askLine } from "../input/input.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c } from "../render/theme.ts"

/** Subset struktural tool call yang dibutuhkan view — tanpa tipe kernel. */
export interface ApprovalRequest {
  name: string
  args?: unknown
}

export async function promptAsk(call: ApprovalRequest): Promise<"allow" | "deny" | "always"> {
  if (!process.stdin.isTTY) return "deny"
  // Non-visual feedback bisa dimatikan untuk aksesibilitas/recording.
  // Bell hanya bila stdout TTY: byte `\x07` di stdout pipe mengotori output
  // program (kontrak: stdout = output PROGRAM, bukan diagnostik).
  if (process.env.MINICODE_BELL !== "0" && process.stdout.isTTY) process.stdout.write("\x07")
  // Live-region untuk screen reader: baris polos tanpa ANSI agar terbaca
  // sebagai teks, bukan escape mentah. Bell saja mengganggu tanpa informasi.
  if (process.env.MINICODE_A11Y === "1")
    process.stderr.write(`[approval required: ${sanitizeAnsiLine(call.name)}]\n`)

  // toolName/actionSummary berasal dari model/MCP (tidak terpercaya). Tanpa
  // sanitasi, `\x1b[2J\x1b[H` di dalam args.command akan membersihkan layar
  // terminal user saat prompt persetujuan tampil (sama seperti provider:text).
  const toolName = sanitizeAnsiLine(call.name)
  const args = (call.args ?? {}) as Record<string, unknown>

  let actionSummary = ""
  if (args.command) actionSummary = `Command: ${String(args.command).slice(0, 100)}`
  else if (args.path) actionSummary = `File: ${String(args.path)}`
  else if (args.query) actionSummary = `Query: ${String(args.query)}`
  else {
    let json = ""
    try {
      json = JSON.stringify(args)
    } catch {
      json = String(args)
    }
    actionSummary = `Args: ${json.slice(0, 100)}`
  }
  actionSummary = sanitizeAnsiLine(actionSummary)

  process.stdout.write(`\n${c.warning(c.bold("Approval required"))}\n`)
  process.stdout.write(`  ${c.bold("Tool:")} ${c.info(toolName)}\n`)
  process.stdout.write(`  ${actionSummary}\n`)

  const promptText = `${c.bold("[y]")} Allow once  ${c.bold("[a]")} Always  ${c.bold("[n]")} Deny: `
  const ans = (await askLine({ prompt: promptText })) ?? ""

  const a = ans.trim().toLowerCase()
  if (a === "a" || a === "always") return "always"
  if (a === "y" || a === "yes") return "allow"
  return "deny"
}

/** View pertanyaan ask_user — di-inject ke src/tools/ask_user.ts dari cli/setup.ts.
 * Teks pertanyaan berasal dari model (tidak terpercaya): disanitasi sebelum
 * tampil agar tak bisa membersihkan layar via escape sequence. Return null
 * bila user membatalkan (Esc/Ctrl+C → askLine null) atau jawaban kosong. */
export async function promptAskText(question: string, options?: string[]): Promise<string | null> {
  if (!process.stdin.isTTY) return null
  const q = sanitizeAnsiLine(question).slice(0, 2000)
  process.stdout.write(`\n${c.warning(c.bold("Agent asks"))}\n`)
  process.stdout.write(`  ${q}\n`)
  if (options?.length) {
    options.forEach((o, i) => {
      process.stdout.write(`  ${c.dim(`${i + 1}.`)} ${sanitizeAnsiLine(o)}\n`)
    })
  }
  const ans = await askLine({ prompt: `${c.bold("Your answer")} (empty = cancel): ` })
  if (ans == null || !ans.trim()) return null
  return ans.trim()
}
