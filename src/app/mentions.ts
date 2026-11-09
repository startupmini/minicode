import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { safeReadFileCapped } from "../lib/safe-open.ts"
import { isPathOutsideRoot, isSensitive } from "../policy/jail.ts"

const MAX_INJECT = 2_000

/** Ambil @mentions dari line → ganti dengan blok konteks file. */
export function parseMentions(line: string): string[] {
  const out: string[] = []
  for (const m of line.matchAll(/@([^\s]+)/g)) {
    const p = m[1]!
    if (p.startsWith(".") && !p.startsWith("./")) continue // @.env dsb
    out.push(p)
  }
  return out
}

export async function resolveMentionContent(
  raw: string,
  cwd: string,
): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
  if (isPathOutsideRoot(abs, cwd) || isSensitive(abs))
    return { ok: false, reason: "rejected (jail)" }
  try {
    const [real, realRoot] = await Promise.all([realpath(abs), realpath(cwd)])
    if (isPathOutsideRoot(real, realRoot) || isSensitive(real))
      return { ok: false, reason: "rejected (jail)" }
    const { text: txt, truncated } = await safeReadFileCapped(real, realRoot, MAX_INJECT)
    const rel = relative(realRoot, real).replace(/\\/g, "/")
    const body = truncated ? `${txt}\n… (truncated: first ${MAX_INJECT} bytes)` : txt
    return { ok: true, content: `\n[file: ${rel}]\n${body}\n[/file]\n` }
  } catch {
    return { ok: false, reason: "file not found" }
  }
}

export async function expandMentions(
  line: string,
  cwd: string,
): Promise<{ prompt: string; notes: string[] }> {
  const notes: string[] = []
  let prompt = line
  for (const p of parseMentions(line)) {
    const r = await resolveMentionContent(p, cwd)
    if (r.ok) prompt = prompt.replace(`@${p}`, () => r.content)
    else notes.push(`@${p}: ${r.reason}`)
  }
  return { prompt, notes }
}
