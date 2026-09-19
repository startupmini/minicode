// Dialog interaktif mode TUI: approval, tanya teks, baca baris mini.
//
// SEMUA berjalan in-flow di dalam alt-screen (append blok ke dokumen +
// baca key/bytes mentah) — TANPA suspend ke buffer utama (pola lama yang
// dihapus). Semantik disalin dari padanan liniernya:
// - approval: y/yes→allow, a/always→always, selain itu deny (termasuk
//   Enter kosong/Esc/Ctrl+C/tombol lain) — sama seperti promptAsk.
// - ask teks: kosong/Esc/Ctrl+C = batal (null) — sama seperti promptAskText.
// - mini line: editing penuh via box sementara (tanpa history/dropdown).
//
// Race Esc-vs-abort diwarisi persis dari linier (busy listener inti tetap
// terpasang selama approval mid-turn): didokumentasikan, bukan regresi.

import { sanitizeAnsiLine } from "../src/ui/render/sanitize.ts"
import { c } from "../src/ui/render/theme.ts"
import { createTuiInput, type TuiInputBox } from "../src/ui/tui/input.ts"
import type { TuiApprovalCall, TuiApprovalVerdict } from "../src/ui/tui/session.ts"

export interface TuiDialogDeps {
  /** Append baris ke dokumen + repaint. */
  append(lines: string[]): void
  /** Paksa repaint penuh (sesudah dialog menutup). */
  render(): void
  /** Pastikan raw mode (best-effort, askLine mengelola sendiri). */
  ensureRaw(): void
  /** Box input yang dilukis driver (null = box utama). */
  setInputBox(box: TuiInputBox | null): void
}

/** Ringkasan aksi seperti promptAsk (command/path/query/json, 100 char). */
export function approvalSummary(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>
  let s: string
  if (typeof a.command === "string") s = `Command: ${a.command.slice(0, 100)}`
  else if (typeof a.path === "string") s = `File: ${a.path}`
  else if (typeof a.query === "string") s = `Query: ${a.query}`
  else {
    let json = ""
    try {
      json = JSON.stringify(a) ?? ""
    } catch {
      json = String(args)
    }
    s = `Args: ${json.slice(0, 100)}`
  }
  return sanitizeAnsiLine(s)
}

function readKeysOnce(): Promise<Buffer> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      try {
        process.stdin.removeListener("data", onData)
      } catch {}
      resolve(chunk)
    }
    try {
      process.stdin.setRawMode(true)
    } catch {}
    process.stdin.resume()
    process.stdin.on("data", onData)
  })
}

export async function runTuiApproval(
  deps: TuiDialogDeps,
  call: TuiApprovalCall,
): Promise<TuiApprovalVerdict> {
  // Bell paritas promptAsk (bunyi saja bila diizinkan + TTY).
  if (process.env.MINICODE_BELL !== "0" && process.stdout.isTTY) {
    try {
      process.stdout.write("\x07")
    } catch {}
  }
  const toolName = sanitizeAnsiLine(call.name)
  deps.append([
    `${c.warning(c.bold("Approval required"))}`,
    `  ${c.bold("Tool:")} ${c.info(toolName)}`,
    `  ${approvalSummary(call.args)}`,
    `  ${c.bold("[y]")} Allow once  ${c.bold("[a]")} Always  ${c.bold("[n]")} Deny`,
  ])
  deps.render()
  const chunk = await readKeysOnce()
  const b = chunk[0] ?? 0
  const verdict: TuiApprovalVerdict =
    b === 0x79 || b === 0x59 ? "allow" : b === 0x61 || b === 0x41 ? "always" : "deny"
  deps.append([`  → ${verdict}`])
  deps.render()
  return verdict
}

/** Baca satu baris teks dengan editing penuh (box sementara). */
export async function readMiniLine(deps: TuiDialogDeps, prompt: string): Promise<string | null> {
  const box = createTuiInput({ prompt, history: [], complete: () => [] })
  deps.setInputBox(box)
  deps.ensureRaw()
  deps.render()
  try {
    return await new Promise<string | null>((resolve) => {
      const done = (v: string | null): void => {
        try {
          process.stdin.removeListener("data", onData)
        } catch {}
        deps.setInputBox(null)
        deps.render()
        resolve(v)
      }
      const onData = (chunk: Buffer): void => {
        let paint = false
        for (const ev of box.feed(chunk)) {
          if (ev.type === "submit") {
            done(ev.line)
            return
          }
          if (ev.type === "cancel") {
            done(null)
            return
          }
          if (ev.type === "render") paint = true
          // key event (tab dkk.): abaikan di mini reader (bukan prompt utama).
        }
        if (paint) deps.render()
      }
      try {
        process.stdin.setRawMode(true)
      } catch {}
      process.stdin.resume()
      process.stdin.on("data", onData)
    })
  } finally {
    deps.setInputBox(null)
  }
}

export async function runTuiAskText(
  deps: TuiDialogDeps,
  question: string,
  options?: string[],
): Promise<string | null> {
  const q = sanitizeAnsiLine(question).slice(0, 2000)
  const lines = [`${c.warning(c.bold("Agent asks"))}`, `  ${q}`]
  if (options?.length) {
    options.forEach((o, i) => {
      lines.push(`  ${c.dim(`${i + 1}.`)} ${sanitizeAnsiLine(o)}`)
    })
  }
  deps.append(lines)
  const ans = await readMiniLine(deps, `${c.bold("Your answer")} (empty = cancel): `)
  if (ans == null || !ans.trim()) return null
  return ans.trim()
}
