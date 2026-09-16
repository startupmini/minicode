import { isAbsolute, resolve } from "node:path"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { safeOpenRead } from "../lib/safe-open.ts"
import { scrubSecrets } from "../policy/scrub.ts"

// defense-in-depth: also jail inside tool (permission layer is primary)

/**
 * Format isi file sebagai `N: <line>` dengan paging.
 *
 * Sebelum ini tool hanya bisa membaca file utuh, jadi file di atas
 * READ_FILE_MAX_BYTES sama sekali tak terjangkau. Nomor baris juga penting:
 * tanpa itu model harus menghitung sendiri saat menyusun `edit`/`apply_patch`
 * dan sering salah rujuk.
 *
 * Diekspor untuk test.
 */
export function formatLines(
  raw: string,
  opts: { offset?: number; limit?: number } = {},
): { text: string; totalLines: number; from: number; to: number } {
  // File yang diakhiri newline tidak menghasilkan baris kosong tambahan.
  const all = raw.split("\n")
  if (all.length > 1 && all[all.length - 1] === "") all.pop()
  const totalLines = all.length

  const rawOffset = Number(opts.offset ?? 1)
  // 1-indexed; offset 0 diperlakukan sebagai 1 supaya model tak perlu menebak.
  const from = Number.isFinite(rawOffset) ? Math.max(1, Math.floor(rawOffset)) : 1
  const rawLimit = Number(opts.limit ?? LIMITS.READ_FILE_DEFAULT_LINE_LIMIT)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(1, Math.floor(rawLimit)), LIMITS.READ_FILE_MAX_LINE_LIMIT)
    : LIMITS.READ_FILE_DEFAULT_LINE_LIMIT

  if (from > totalLines) {
    return {
      text: `(offset ${from} is past the end of the file — ${totalLines} lines total)`,
      totalLines,
      from,
      to: from,
    }
  }

  const to = Math.min(totalLines, from + limit - 1)
  const width = String(to).length
  const body = all
    .slice(from - 1, to)
    .map((line, i) => {
      const n = String(from + i).padStart(width, " ")
      const capped =
        line.length > LIMITS.READ_FILE_MAX_LINE_CHARS
          ? `${line.slice(0, LIMITS.READ_FILE_MAX_LINE_CHARS)}… [line truncated]`
          : line
      return `${n}: ${capped}`
    })
    .join("\n")

  const remaining = totalLines - to
  const footer =
    remaining > 0
      ? `\n… ${remaining} more lines (continue: offset=${to + 1})`
      : from > 1
        ? "\n(end of file)"
        : ""
  return { text: body + footer, totalLines, from, to }
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a text file in the workspace with line numbers. Output is N: <line> and a footer telling the next offset. Large files MUST be read in chunks via offset/limit (max 2MB per file, 5000 lines per call, 2000 chars per line). Prefer this over `cat` in bash. Cannot read outside the workspace, secrets, or node_modules.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "path relative to the workspace (e.g. src/a.ts)" },
      offset: { type: "number", description: "starting line (1-indexed, default 1)" },
      limit: { type: "number", description: "number of lines (default 2000, max 5000)" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute({ path, offset, limit }, ctx) {
    ctx.signal.throwIfAborted()
    const p = path as string
    const root = (ctx as { cwd?: string }).cwd ?? process.cwd()
    const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
    // Semua verifikasi path (jail + sensitif + O_NOFOLLOW) terjadi di SATU
    // titik saat open — detail di safe-open.ts. Tidak ada resolve/stat
    // terpisah: handle dipakai untuk stat (cap ukuran) lalu baca.
    let handle: Awaited<ReturnType<typeof safeOpenRead>>["handle"]
    try {
      ;({ handle } = await safeOpenRead(abs, root))
    } catch (e) {
      // ENOENT → pesan seragam; sisanya (jail/sensitif/ELOOP/raw IO) apa adanya
      const msg = (e as Error).message ?? ""
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || msg.includes("ENOENT"))
        throw new Error(`file not found: ${p}`)
      throw e
    }
    let raw: string
    try {
      const st = await handle.stat().catch(() => null)
      if (!st) throw new Error(`file not found: ${p}`)
      if (st.isDirectory()) throw new Error(`path is a directory, not a file: ${p}`)

      const paged = offset != null || limit != null
      // Hard cap absolut 50M bahkan untuk paged — cegah OOM 1GB via offset/limit
      const HARD_CAP = 50 * 1024 * 1024
      if (st.size > HARD_CAP)
        throw new Error(`file too large: ${p} (${st.size} bytes > ${HARD_CAP}) — hard cap`)
      // File raksasa tetap bisa dibaca SELAMA pemanggil menyebut rentang baris.
      // Tanpa offset/limit kita menolak seperti sebelumnya agar tidak diam-diam
      // memotong konteks yang model kira utuh.
      if (st.size > LIMITS.READ_FILE_MAX_BYTES && !paged) {
        throw new Error(
          `file too large: ${p} (${st.size} bytes > ${LIMITS.READ_FILE_MAX_BYTES}) — read it in chunks with offset/limit`,
        )
      }
      raw = await handle.readFile("utf8")
    } finally {
      await handle.close().catch(() => {})
    }
    const { text } = formatLines(raw, {
      offset: offset as number | undefined,
      limit: limit as number | undefined,
    })
    return scrubSecrets(text)
  },
}
