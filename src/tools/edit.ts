import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { resolveSafePath, safeReadFile } from "../lib/safe-open.ts"
import { appendLspDiagnostics } from "../policy/verifier.ts"
import { applyHashline } from "./hashline.ts"

function normalizeLf(s: string): string {
  return s.replace(/\r\n/g, "\n")
}

function stripTrailingWhitespace(s: string): string {
  return s
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
}

// Petakan index di string ternormalisasi (LF) kembali ke index string asli.
function mapOriginalIndex(original: string, nIdx: number): number {
  let oi = 0,
    ni = 0
  while (ni < nIdx && oi < original.length) {
    if (original[oi] === "\r" && original[oi + 1] === "\n")
      oi += 2 // \r\n = 1 unit LF
    else oi += 1
    ni += 1
  }
  return oi
}

export interface MatchResult {
  start: number
  end: number
  mode: "exact" | "crlf" | "trimmed" | "fuzzy"
}

// Helper: hitung range byte di cLf dari indeks baris — dipakai trimmed & fuzzy
function lineRange(
  cLfLines: string[],
  startLine: number,
  lineCount: number,
  content: string,
): { start: number; end: number } {
  const startInLf = cLfLines.slice(0, startLine).join("\n").length + (startLine > 0 ? 1 : 0)
  const endInLf = startInLf + cLfLines.slice(startLine, startLine + lineCount).join("\n").length
  return { start: mapOriginalIndex(content, startInLf), end: mapOriginalIndex(content, endInLf) }
}

// Search needle dengan toleransi bertingkat:
// 1. Exact match
// 2. CRLF vs LF match
// 3. Trimmed trailing whitespace line match
// 4. Line-by-line normalized whitespace match
export function flexibleMatch(content: string, needle: string): MatchResult | null {
  // 1. Exact match
  const direct = content.indexOf(needle)
  if (direct !== -1) return { start: direct, end: direct + needle.length, mode: "exact" }

  const cLf = normalizeLf(content)
  const nLf = normalizeLf(needle)

  // 2. CRLF vs LF match
  const nStart = cLf.indexOf(nLf)
  if (nStart !== -1)
    return {
      start: mapOriginalIndex(content, nStart),
      end: mapOriginalIndex(content, nStart + nLf.length),
      mode: "crlf",
    }

  const cLfLines = cLf.split("\n")
  // 3. Trailing whitespace tolerance
  const cTrimmed = stripTrailingWhitespace(cLf)
  const nTrimmed = stripTrailingWhitespace(nLf)
  const trimStart = cTrimmed.indexOf(nTrimmed)
  if (trimStart !== -1) {
    const lineCountBefore = cTrimmed.slice(0, trimStart).split("\n").length - 1
    const needleLineCount = nTrimmed.split("\n").length
    if (lineCountBefore + needleLineCount <= cLfLines.length) {
      const r = lineRange(cLfLines, lineCountBefore, needleLineCount, content)
      return { ...r, mode: "trimmed" }
    }
  }

  // 4. Fuzzy line-by-line match (ignoring leading/trailing whitespace per line)
  const cLines = cLfLines
  const nLines = nLf.split("\n")
  if (nLines.length > 0 && nLines.length <= cLines.length) {
    const nStripped = nLines.map((l) => l.trim())
    let matchLineIdx = -1
    for (let i = 0; i <= cLines.length - nLines.length; i++) {
      let ok = true
      for (let j = 0; j < nLines.length; j++)
        if (cLines[i + j]?.trim() !== nStripped[j]) {
          ok = false
          break
        }
      if (ok) {
        if (matchLineIdx !== -1) return null // ambiguous
        matchLineIdx = i
      }
    }
    if (matchLineIdx !== -1) {
      const r = lineRange(cLfLines, matchLineIdx, nLines.length, content)
      return { ...r, mode: "fuzzy" }
    }
  }
  return null
}

export const editTool: Tool = {
  name: "edit",
  description:
    "Edit a file with a string replacement. oldString must appear exactly once in the file — include surrounding lines to make it unique. Whitespace/indentation mismatch is tolerated (fuzzy). Prefer edit for small targeted changes; use apply_patch for multiple changes. Cannot edit files outside the workspace or .minicode/ state.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "path relative to the workspace (e.g. src/a.ts)" },
      oldString: {
        type: "string",
        description: "exact existing text to be replaced (must match once)",
      },
      newString: {
        type: "string",
        description: "replacement text (empty string deletes the matched text)",
      },
    },
    required: ["path", "oldString", "newString"],
    additionalProperties: false,
  },
  async execute({ path, oldString, newString }, ctx) {
    ctx.signal.throwIfAborted()
    const p = path as string
    const root = (ctx as { cwd?: string }).cwd ?? process.cwd()
    // Verifikasi path terpusat (logis + target nyata, induk symlink ikut
    // ter-resolusi) — symlink internal tetap bisa diedit, targetnya yang dicek.
    const { abs, real: realAbs } = await resolveSafePath(p, root)
    // Cek ukuran sebelum baca penuh — hindari OOM 1GB via safeReadFile.
    // Pakai byte length via stat pada realAbs (handle belum ada), fallback ke content length.
    const { stat } = await import("node:fs/promises")
    const st = await stat(realAbs).catch(() => null)
    if (!st) throw new Error(`file not found: ${p}`)
    if (st.size > LIMITS.READ_FILE_MAX_BYTES) throw new Error(`file too large: ${p} (${st.size})`)
    // Baca via safeReadFile (O_NOFOLLOW) agar TOCTOU swap gagal ELOOP, bukan baca luar.
    const content = await safeReadFile(abs, root).catch(() => {
      throw new Error(`file not found: ${p}`)
    })
    const oldS = oldString as string
    const newS = newString as string
    if (oldS === newS) throw new Error("oldString == newString (no change)")
    // Hashline fast path (OpenCode): hanya bila line endings konsisten (hindari CRLF→LF corrupt)
    // CRLF vs LF ditangani oleh flexibleMatch mode "crlf" yang preservasi original.
    const canHashline = content.includes("\r\n") === oldS.includes("\r\n")
    let hashApply: string | null = null
    if (canHashline) {
      const hunk = applyHashline(content, oldS, newS)
      if (hunk !== null) {
        // uniqueness: if exact oldString occurs >1 times, require more context (mirror flexibleMatch)
        const firstIdx = content.indexOf(oldS)
        if (firstIdx !== -1 && content.indexOf(oldS, firstIdx + oldS.length) !== -1) {
          throw new Error(
            `oldString found multiple times in ${p} — provide more surrounding lines to make it unique`,
          )
        }
        hashApply = hunk
      }
    }
    if (hashApply !== null) {
      if (hashApply.length > LIMITS.WRITE_FILE_MAX_CHARS)
        throw new Error(`result too large: ${hashApply.length} chars (max 5M)`)
      await atomicWriteText(realAbs, hashApply)
      return await appendLspDiagnostics(
        realAbs,
        hashApply,
        `edited ${realAbs} (hashline match) (${oldS.length} → ${newS.length} chars)`,
      )
    }
    const match = flexibleMatch(content, oldS)
    if (!match) throw new Error(`oldString not found in ${p}`)

    // ensure uniqueness untuk semua mode (exact/crlf/trimmed/fuzzy) — trimmed/fuzzy
    // sebelumnya hanya dicek untuk exact/crlf sehingga duplikat diam-diam edit blok pertama
    const second = flexibleMatch(content.slice(match.end), oldS)
    if (second) {
      throw new Error(
        `oldString found multiple times in ${p} — provide more surrounding lines to make it unique`,
      )
    }

    const next = content.slice(0, match.start) + newS + content.slice(match.end)
    if (next.length > LIMITS.WRITE_FILE_MAX_CHARS)
      throw new Error(`result too large: ${next.length} chars (max 5M)`)
    // atomic (O_EXCL + randomUUID tmp)
    await atomicWriteText(realAbs, next)
    const note = match.mode !== "exact" ? ` (${match.mode} match)` : ""
    const base = `edited ${realAbs}${note} (${oldS.length} → ${newS.length} chars)`
    return await appendLspDiagnostics(realAbs, next, base)
  },
}
