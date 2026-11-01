import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { scrubSecrets } from "../policy/scrub.ts"
import { dockerAvailable, runInDocker } from "../sandbox/docker.ts"
import { osSandboxAvailable, runInOsSandbox } from "../sandbox/os.ts"
import { capMarked } from "./bash.ts"

// code_run: snippet python/node dieksekusi LEWAT sandbox runner (docker atau
// OS sandbox), bukan spawn host langsung — versi lama hanya mengecek env flag
// lalu spawn host tanpa isolasi (klaim "sandboxed" yang salah).
//
// Batasan jujur:
// - Backend HARUS tersedia; flag tanpa backend = tolak (fail-closed, tanpa
//   fallback diam-diam ke host).
// - docker image default (node:22-alpine) membawa node, bukan python3 —
//   python butuh MINICODE_SANDBOX_IMAGE yang menyediakannya.
// - Pembatalan menghentikan PENUNGGUAN; container/proses bisa hidup sampai
//   timeout runner-nya sendiri (terdokumentasi, sama seperti MCP stdio).

/** Escape untuk disisip sebagai satu argumen single-quoted di `sh -c`. */
export function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export const codeRunTool: Tool = {
  name: "code_run",
  description:
    "Run a code snippet (python -c / node -e) inside the configured sandbox (docker or OS sandbox, network-isolated). Requires MINICODE_SANDBOX=os|docker with a working backend; refuses otherwise. Python needs an image containing python3.",
  parameters: {
    type: "object",
    properties: {
      lang: { type: "string", enum: ["python", "node"], description: "runtime" },
      code: { type: "string", description: "snippet to run" },
      timeout: { type: "number", description: "ms, default 10000" },
    },
    required: ["lang", "code"],
    additionalProperties: false,
  },
  async execute({ lang, code, timeout }, ctx) {
    ctx.signal.throwIfAborted()
    const sandbox = process.env.MINICODE_SANDBOX ?? ""
    if (sandbox !== "os" && sandbox !== "docker" && sandbox !== "bwrap" && sandbox !== "seatbelt") {
      throw new Error(
        `code_run requires MINICODE_SANDBOX=os|docker (current: ${sandbox || "none"})`,
      )
    }
    const src = code as string
    if (src.includes("\0")) throw new Error("code contains NUL byte")
    const root = ctx.cwd ?? process.cwd()
    const timeoutMs =
      typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : 10000
    // Tanpa shell perantara di sisi kita: kode jadi SATU argumen single-quoted
    // untuk `sh -c` runner — $()/backtick milik snippet, bukan shell luar.
    const inner =
      lang === "python" ? `python3 -c ${shSingleQuote(src)}` : `node -e ${shSingleQuote(src)}`
    // Fail-closed: backend yang diminta harus benar-benar ada. Fallback diam
    // ke eksekusi host akan mengkhianati janji sandbox.
    const runSandboxed =
      sandbox === "docker"
        ? () => {
            if (!dockerAvailable()) {
              throw new Error("code_run: MINICODE_SANDBOX=docker but docker is not available")
            }
            return runInDocker(inner, root, { timeoutMs })
          }
        : () => {
            if (!osSandboxAvailable()) {
              throw new Error(
                `code_run: MINICODE_SANDBOX=${sandbox} but no OS sandbox is available`,
              )
            }
            return runInOsSandbox(inner, root, { timeoutMs })
          }
    const started = runSandboxed()
    // Runner tak menerima signal: balapan agar pembatalan menolak menunggu.
    // (Container/proses bisa hidup sampai timeout runner — lihat komentar atas.)
    const onAbort = (): Promise<never> =>
      Promise.reject(ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("aborted"))
    const settled: { code: number | null; output: string } = ctx.signal.aborted
      ? await onAbort()
      : await Promise.race([
          started,
          new Promise<never>((_, rej) =>
            ctx.signal.addEventListener(
              "abort",
              () =>
                rej(ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("aborted")),
              { once: true },
            ),
          ),
        ])
    const text = capMarked(scrubSecrets(settled.output), LIMITS.BASH_OUTPUT_MAX_CHARS).trim()
    if (settled.code !== 0) return `exit ${settled.code}\n${text}`
    return text
  },
}
