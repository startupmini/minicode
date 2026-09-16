import { stat } from "node:fs/promises"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { assertSafeWriteTarget, resolveSafePath, safeReadFile } from "../lib/safe-open.ts"
import { flexibleMatch } from "./edit.ts"

// Apply SEARCH/REPLACE block (a la Aider) ke file. Search block harus match
// tepat sekali (dengan toleransi fuzzy). Bisa multiple patches.
export const applyPatchTool: Tool = {
  name: "apply_patch",
  description:
    "Apply SEARCH/REPLACE block(s) to a file. Each search must match exactly once. Blocks apply sequentially to the same content (max 50 blocks per call). Prefer for multiple changes in one file; use edit for a single small change.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "path relative to the workspace" },
      patches: {
        type: "array",
        description: "Array of {search, replace} blocks. Applied sequentially to the same content.",
        items: {
          type: "object",
          properties: {
            search: {
              type: "string",
              description: "code block to be replaced (exact or fuzzy match)",
            },
            replace: { type: "string", description: "replacement code block" },
          },
          required: ["search", "replace"],
          additionalProperties: false,
        },
      },
    },
    required: ["path", "patches"],
    additionalProperties: false,
  },
  async execute({ path, patches }, ctx) {
    ctx.signal.throwIfAborted()
    const p = path as string
    const root = (ctx as { cwd?: string }).cwd ?? process.cwd()
    // Verifikasi path terpusat (logis + target nyata) — detail di safe-open.ts.
    const { abs, real: realAbs } = await resolveSafePath(p, root)
    // Tolak menimpa symlink final (swap antara cek dan tulis gagal tutup).
    await assertSafeWriteTarget(abs, root)
    const st = await stat(realAbs).catch(() => null)
    if (!st) throw new Error(`file not found: ${p}`)
    if (st.size > LIMITS.READ_FILE_MAX_BYTES) throw new Error(`file too large: ${p} (${st.size})`)

    // Pakai safeReadFile (O_NOFOLLOW) agar swap symlink di antara cek dan baca gagal ELOOP.
    let content = await safeReadFile(abs, root)
    const patchList = patches as { search: string; replace: string }[]
    if (patchList.length > 50) throw new Error(`too many patches: ${patchList.length} (max 50)`)
    const applied: string[] = []

    for (let i = 0; i < patchList.length; i++) {
      ctx.signal.throwIfAborted()
      const { search: oldS, replace: newS } = patchList[i]!
      if (oldS === newS) {
        applied.push(`[${i}] skipped: oldString == newString`)
        continue
      }
      const match = flexibleMatch(content, oldS)
      if (!match) throw new Error(`patch[${i}]: search block not found in ${p}`)
      // ensure uniqueness untuk semua mode
      const second = flexibleMatch(content.slice(match.end), oldS)
      if (second) {
        throw new Error(
          `patch[${i}]: search block found multiple times in ${p} — provide more context`,
        )
      }
      content = content.slice(0, match.start) + newS + content.slice(match.end)
      if (content.length > LIMITS.WRITE_FILE_MAX_CHARS)
        throw new Error(`result too large after patch[${i}]: ${content.length} chars (max 5M)`)
      const note = match.mode !== "exact" ? ` (${match.mode} match)` : ""
      applied.push(`[${i}] replaced ${oldS.length} → ${newS.length} chars${note}`)
    }

    if (content.length > LIMITS.WRITE_FILE_MAX_CHARS)
      throw new Error(`result too large: ${content.length} chars (max 5M)`)

    await atomicWriteText(realAbs, content)

    return `applied ${applied.length} patch(es) to ${realAbs}:\n${applied.join("\n")}`
  },
}
