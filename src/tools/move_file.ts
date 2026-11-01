import { mkdir, rename, stat } from "node:fs/promises"
import { dirname } from "node:path"
import type { Tool } from "#minicore"
import { resolveSafePath } from "../lib/safe-open.ts"
import { trashFile } from "../lib/trash.ts"

export const moveFileTool: Tool = {
  name: "move_file",
  description:
    "Move/rename a file within workspace (atomic rename). Supports moving to new directory (auto-creates parents).",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "source path relative to cwd" },
      to: { type: "string", description: "destination path relative to cwd" },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  async execute({ from, to }, ctx) {
    ctx.signal.throwIfAborted()
    const root = ctx.cwd ?? process.cwd()
    const f = from as string
    const t = to as string
    // Verifikasi kedua ujung via pemilik tunggal (logis + target nyata) —
    // detail di safe-open.ts. Beda dengan tool satu-berkas hanya karena
    // move punya dua ujung; substring pesan ("outside workspace",
    // "blocked sensitive file") dipertahankan agar test regex tetap hijau.
    const { abs: absFrom, real: realFrom } = await resolveSafePath(f, root)
    const st = await stat(realFrom).catch(() => null)
    if (!st) throw new Error(`source not found: ${f}`)
    const { abs: absTo } = await resolveSafePath(t, root)
    await mkdir(dirname(absTo), { recursive: true, mode: 0o700 }).catch(() => {})
    // S3 — dest yang sudah ada dibackup ke trash dulu (jangan timpa diam-diam).
    // absTo sudah terverifikasi nyata oleh resolveSafePath, jadi tak perlu
    // realpath ulang di sini.
    let backup = ""
    const destStat = await stat(absTo).catch(() => null)
    if (destStat) {
      if (destStat.isDirectory()) throw new Error(`destination is a directory: ${t}`)
      const trashed = await trashFile(root, absTo)
      backup = ` (previous dest backed up to ${trashed})`
    }
    await rename(absFrom, absTo)
    return `moved ${f} -> ${t}${backup}`
  },
}
