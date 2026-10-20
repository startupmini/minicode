import { spawn } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { sanitizeSpawnEnv } from "../policy/scrub.ts"

export interface RunHookCtx {
  phase: "pre" | "post"
  prompt?: string
  cwd?: string
  result?: unknown
}

/**
 * Guard mode untuk hooks (audit #10 P1): hooks berjalan di luar permission
 * system — di mode tanpa-eksekusi (plan/readonly) hook TETAP mengeksekusi
 * tanpa gate bila tidak dijaga, melanggar kontrak read-only. Diekspor agar
 * composition root + test memakai predikat yang sama.
 *
 * P12 S2.2 — WorkMode-aware. WorkMode DISCUSS adalah posture read-only penuh
 * (ceiling handler menolak semua tool tulis/eksekusi, termasuk delegate), jadi
 * hooks (eksekusi Node di luar permission system) juga TIDAK boleh jalan —
 * walau permissionMode="auto". PLAN/EXECUTE mempertahankan perilaku lama:
 * keputusan murni dari permission mode. Param workMode opsional agar pemanggil
 * lama tanpa WorkMode tetap kompatibel (default undefined = perilaku lama).
 */
export function shouldRunHooks(
  permissionMode: string,
  workMode?: "DISCUSS" | "PLAN" | "EXECUTE",
): boolean {
  if (workMode === "DISCUSS") return false
  return permissionMode !== "plan" && permissionMode !== "readonly"
}

// 6.4 — hooks global opt-in: ~/.minicode/hooks/{pre,post}*.js dan
// .minicode/hooks/{pre,post}*.js. Berjalan sebagai node script terpisah
// dengan konteks di env MINICODE_HOOK_CTX (JSON). Opt-in via MINICODE_HOOKS=1
// supaya tidak mengubah perilaku default (aman, tanpa efek samping).
export function findRunHooks(cwd?: string): { pre: string[]; post: string[] } {
  const dirs: string[] = [join(homedir(), ".minicode", "hooks")]
  if (cwd) dirs.push(resolve(cwd, ".minicode", "hooks"))
  const out = { pre: [] as string[], post: [] as string[] }
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".js")) continue
      if (f.includes("pre")) out.pre.push(join(dir, f))
      else if (f.includes("post")) out.post.push(join(dir, f))
    }
  }
  return out
}

export async function runRunHooks(
  phase: "pre" | "post",
  ctx: RunHookCtx,
  signal?: AbortSignal,
): Promise<void> {
  if (process.env.MINICODE_HOOKS !== "1") return
  // Hook = arbitrary Node.js di luar permission system (berjalan di SEMUA
  // mode bila opt-in) — karenanya: tanpa secret di env (baca dari berkas bila
  // perlu), dan hormati pembatalan sesi (lewati sisa hook bila aborted).
  // MINICODE_HOOK_CTX sendiri memuat prompt user apa adanya — prompt yang
  // ditempeli kredensial akan terlihat hook; itu inheren dari desain.
  if (signal?.aborted) return
  const hooks = findRunHooks(ctx.cwd)
  for (const file of hooks[phase]) {
    if (signal?.aborted) return
    // Audit #10 P2 observability: hook adalah eksekusi di luar permission
    // system — operator wajib bisa melihat APA yang jalan (nama berkas saja;
    // output hook tetap dibuang, isi tak pernah di-log).
    try {
      process.stderr.write(`[hooks] ${phase}: ${file.split(/[\\/]/).pop()}\n`)
    } catch {}
    await new Promise<void>((res) => {
      const p = spawn(process.execPath, [file], {
        env: sanitizeSpawnEnv(process.env, { MINICODE_HOOK_CTX: JSON.stringify(ctx) }),
        stdio: "ignore",
      })
      const timer = setTimeout(() => {
        try {
          p.kill("SIGTERM")
          setTimeout(() => {
            try {
              p.kill("SIGKILL")
            } catch {}
          }, 1000)
        } catch {}
      }, 5000)
      p.on("error", () => {
        clearTimeout(timer)
        res()
      })
      p.on("exit", () => {
        clearTimeout(timer)
        res()
      })
    })
  }
}
