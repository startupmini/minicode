import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { assertSafeWriteTarget, resolveSafePath } from "../lib/safe-open.ts"
import { appendLspDiagnostics } from "../policy/verifier.ts"

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Create or overwrite a file with text content (atomic write, creates parent directories). Max 5M chars (~20MB). Cannot write outside the workspace, to secret paths (.env, .ssh, node_modules) or to .minicode/ state — write your own notes in the workspace instead. Prefer edit for small changes to an existing file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "path relative to the workspace (e.g. src/a.ts)" },
      content: { type: "string", description: "full file content to write" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute({ path, content }, ctx) {
    ctx.signal.throwIfAborted()
    const p = path as string
    const root = (ctx as { cwd?: string }).cwd ?? process.cwd()
    // Verifikasi path terpusat (logis + target nyata) — detail di safe-open.ts.
    const { real: realAbs } = await resolveSafePath(p, root)
    // Tolak menimpa symlink final (swap antara cek dan tulis gagal tutup).
    await assertSafeWriteTarget(resolve(root, p), root)
    // guard large write — chars vs bytes (emoji/CJK 4x)
    const c = content as string
    if (c.length > LIMITS.WRITE_FILE_MAX_CHARS)
      throw new Error(`content too large: ${c.length} chars (max 5M)`)
    if (Buffer.byteLength(c, "utf8") > LIMITS.WRITE_FILE_MAX_CHARS * 4)
      throw new Error(`content too large: ${Buffer.byteLength(c, "utf8")} bytes > ~20M`)
    // atomic: write tmp (O_EXCL + randomUUID) then rename — anti-hijack & atomic
    await atomicWriteText(realAbs, c)
    const st = await stat(realAbs).catch(() => null)
    const base = `wrote ${realAbs} (${st?.size ?? c.length} bytes)`
    return await appendLspDiagnostics(realAbs, c, base, undefined, root)
  },
}
