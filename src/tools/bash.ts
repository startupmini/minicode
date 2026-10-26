import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { resolve as resolvePath } from "node:path"
import type { Tool, ToolContext } from "#minicore"
import { LIMITS } from "../constants.ts"
import { isCwdOutsideRoot, isPathOutsideRoot } from "../policy/jail.ts"

// re-export untuk backward compat (helper kini terpusat di policy/scrub)
export { SECRET_ENV_RE, sanitizeSpawnEnv, stripSecretsEnv } from "../policy/scrub.ts"

import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { sandboxExplicitFallbackAllowed, sandboxStrict } from "../policy/sandbox-policy.ts"
import { sanitizeSpawnEnv, scrubSecrets } from "../policy/scrub.ts"
import { dockerAvailable, runInDocker } from "../sandbox/docker.ts"
import { osSandboxAvailable, runInOsSandbox } from "../sandbox/os.ts"

// ── Output buffer dengan cap saat streaming ──
// Cap diterapkan SAAT data masuk, bukan slice di akhir: command dengan output
// raksasa (`yes`, `cat file-1GB`) tidak boleh membawa proses ke OOM.
class CappedBuffer {
  private out = ""
  private err = ""
  truncated = false
  constructor(private readonly cap: number) {}

  append(target: "out" | "err", chunk: Buffer | string): string {
    const s = typeof chunk === "string" ? chunk : chunk.toString()
    const cur = target === "out" ? this.out : this.err
    if (cur.length >= this.cap) {
      this.truncated = true
      return ""
    }
    const room = this.cap - cur.length
    if (s.length > room) this.truncated = true
    const piece = s.slice(0, Math.max(0, room))
    if (target === "out") this.out += piece
    else this.err += piece
    return piece
  }

  /** Teks gabungan, sudah di-scrub, dengan marker truncation. */
  text(): string {
    const joined = (this.out + (this.err ? `\n[stderr]\n${this.err}` : "")).trim()
    return scrubSecrets(joined) + (this.truncated ? "\n… [output truncated]" : "")
  }
}

// F-03: request sandbox EKSPLISIT (MINICODE_SANDBOX=docker/os/...) tanpa
// backend juga fail-closed secara default — lihat sandboxRefusalReason di
// policy/sandbox-policy.ts (dipakai CLI) + cabang di bawah (dipakai jalur
// env-langsung seperti MCP/sub-agen). Downgrade diam-diam ke host membuat
// operator yakin terisolasi padahal tidak — satu baris [warn] bukan
// persetujuan. Fallback eksplisit tetap tersedia via
// MINICODE_SANDBOX_ALLOW_FALLBACK=1 (untuk mesin tanpa backend yang operator
// sadari), dan tanpa MINICODE_SANDBOX sama sekali perilaku tetap direct.

// Penanda truncation: output yang dipotong diam-diam tampak lengkap dan
// menyesatkan model (temuan audit #02). Selalu tandai bila dipotong.
export function capMarked(text: string, cap: number): string {
  return text.length > cap
    ? `${text.slice(0, cap)}\n… [truncated: showing first ${cap} chars]`
    : text
}

// ── Background jobs ──
// Perlu untuk dev server / watcher / test panjang: proses hidup melewati batas
// satu turn, output-nya diambil bertahap lewat bash_output.
interface BackgroundJob {
  id: string
  cmd: string
  startedAt: number
  proc: ReturnType<typeof spawn>
  buffer: CappedBuffer
  /** Offset baca terakhir supaya bash_output hanya mengembalikan yang baru. */
  cursor: number
  chunks: string[]
  exitCode: number | null
  done: boolean
  /**
   * F-03 (P5 §C2): sid kanonik pemilik job — diikat saat start dari instans
   * tool yang sudah di-composition (createBashJobTools), BUKAN dari argumen
   * tool. null = instans default tanpa sid (library/test legacy); jalur
   * produksi selalu terikat sid lewat composition root.
   */
  ownerSid: string | null
}

const jobs = new Map<string, BackgroundJob>()

// F-03 (P5 §C2): gerbang akses job. Hanya pemilik (sid sama, null==null untuk
// jalur legacy) yang boleh inspect/cancel. Kegagalan karena kepemilikan
// menghasilkan TIDAK ADA — pemanggil tak bisa membedakan "job milik sesi lain"
// dari "id tak dikenal" (non-disclosing).
function ownedJob(id: string, callerSid: string | null): BackgroundJob | undefined {
  const j = jobs.get(id)
  if (!j || j.ownerSid !== callerSid) return undefined
  return j
}

// Daftar job hidup yang boleh disebut dalam pesan not-found: HANYA milik
// pemanggil. Daftar proses-wide (lama) membocorkan id sesi lain — itulah
// kebocoran yang ditutup C2.
function liveOwnedIds(callerSid: string | null): string[] {
  return [...jobs.values()].filter((j) => !j.done && j.ownerSid === callerSid).map((j) => j.id)
}

function reapFinishedJobs(): void {
  const now = Date.now()
  for (const [id, j] of jobs) {
    if (j.done && now - j.startedAt > LIMITS.BASH_BACKGROUND_MAX_LIFETIME_MS) jobs.delete(id)
  }
}

/**
 * Sinyal ke SELURUH grup proses (POSIX). Butuh spawn `detached:true` agar
 * shell jadi group leader — tanpa itu `-pid` bukan grup yang valid dan
 * group-kill jadi tak mungkin (cucu selamat). true = sinyal sampai ke grup.
 */
function signalProcessGroup(p: ReturnType<typeof spawn>, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32" || p.pid === undefined) return false
  try {
    process.kill(-p.pid, signal)
    return true
  } catch {
    return false
  }
}

/**
 * Bunuh proses + seluruh subtree-nya. Di Windows `p.kill()` hanya membunuh
 * wrapper `cmd.exe` — cucu seperti `node -e "while(true){}"` tetap hidup,
 * menahan pipe stdio sehingga event `close` tidak pernah datang (hang
 * selamanya walau timeout sudah lewat). `taskkill /T` menutup tree-nya.
 */
function killTree(p: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === "win32" && p.pid !== undefined) {
      // F-23: resolve absolut dari PATH terpercaya — spawn dengan cwd
      // workspace bisa mengeksekusi taskkill.bat repo (hijack CWD Windows).
      // Env juga disanitasi: proses ini berjalan di timeout dengan hak penuh.
      const r = spawnSync(
        resolveTrustedExecutable("taskkill"),
        ["/pid", String(p.pid), "/T", "/F"],
        {
          stdio: "ignore",
          env: sanitizeSpawnEnv(process.env),
        },
      )
      if (r.status === 0) return
    } else if (signalProcessGroup(p, "SIGKILL")) {
      // POSIX: bunuh seluruh grup proses (shell wrapper + cucu seperti
      // `node -e`). Spawn memakai detached:true agar shell jadi group leader.
      return
    }
  } catch {}
  try {
    p.kill("SIGKILL")
  } catch {}
}

/**
 * Hentikan semua job — dipanggil saat CLI keluar agar tidak ada proses yatim.
 *
 * WAJIB tree-kill, bukan `proc.kill()`: yang dibunuh cuma wrapper shell,
 * sedangkan cucu (dev server, watcher, `node -e`) tetap hidup, menahan pipe
 * stdio, dan jadi proses yatim yang tak pernah dibersihkan. Modul ini sudah
 * punya killTree() untuk itu — jalur shutdown sebelumnya tak memakainya.
 */
export function killAllBackgroundJobs(): void {
  for (const [id, j] of jobs) {
    try {
      // `!j.done` = jangan sentuh pid yang sudah mati (risiko pid dipakai
      // ulang proses lain → taskkill /pid membunuh proses tak berkaitan).
      if (!j.done) killTree(j.proc)
    } catch {}
    jobs.delete(id)
  }
}

export function listBackgroundJobs(): { id: string; cmd: string; done: boolean }[] {
  return [...jobs.values()].map((j) => ({ id: j.id, cmd: j.cmd, done: j.done }))
}

function startBackground(cmd: string, cwd: string | undefined, ownerSid: string | null): string {
  reapFinishedJobs()
  const live = [...jobs.values()].filter((j) => !j.done).length
  if (live >= LIMITS.BASH_BACKGROUND_MAX_JOBS) {
    throw new Error(
      `too many background jobs (${live}/${LIMITS.BASH_BACKGROUND_MAX_JOBS}) — stop one with bash_kill first`,
    )
  }
  const id = `bg_${randomUUID().slice(0, 8)}`
  const proc = spawn(cmd, {
    shell: true,
    cwd,
    env: sanitizeSpawnEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    // detached agar shell jadi group leader → killTree bisa menutup SELURUH
    // grup (POSIX kill(-pid)). Tanpa ini yang bisa dibunuh cuma wrapper shell
    // dan cucu (dev server, watcher) jadi yatim saat bash_kill/shutdown.
    detached: process.platform !== "win32",
  })
  const job: BackgroundJob = {
    id,
    cmd,
    startedAt: Date.now(),
    proc,
    buffer: new CappedBuffer(LIMITS.BASH_OUTPUT_MAX_CHARS),
    cursor: 0,
    chunks: [],
    exitCode: null,
    done: false,
    ownerSid,
  }
  proc.stdout?.on("data", (d: Buffer) => {
    const piece = job.buffer.append("out", d)
    if (piece) job.chunks.push(scrubSecrets(piece))
  })
  proc.stderr?.on("data", (d: Buffer) => {
    const piece = job.buffer.append("err", d)
    if (piece) job.chunks.push(scrubSecrets(piece))
  })
  proc.on("error", (e) => {
    job.chunks.push(`[error] ${e.message}`)
    job.done = true
  })
  proc.on("close", (code) => {
    job.exitCode = code
    job.done = true
  })
  jobs.set(id, job)
  return id
}

// F-03: instans tool bash terikat satu sid pemilik. Instans default (export
// di bawah) memakai null — jalur library/test tanpa komposisi sid; sesi
// produksi memakai createBashJobTools(sid) lewat composition root.
function makeBashTool(ownerSid: string | null): Tool {
  return {
    name: "bash",
    description:
      "Run a shell command (default timeout 30s, max output 20k chars, exit code prefixed). Set background:true for long-running processes (dev server, watcher), then collect output via bash_output and stop with bash_kill. Prefer git_status/git_diff/git_log tools over raw `git` commands: raw git executes repository-configured hooks, filters and diff drivers. Destructive, network-exfiltrating, env-dumping, and inline-interpreter commands are blocked. If the shell allowlist denies a command: do NOT retry blindly — file reads/writes belong to read_file/write_file/edit, and a full shell needs the operator to rerun with --allow-all or --sandbox docker. On Windows the shell is cmd.exe (use dir, echo %VAR%, type).",
    parameters: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "command to run (shell: cmd.exe on Windows)" },
        cwd: {
          type: "string",
          description: "working directory relative to the workspace (default: workspace root)",
        },
        timeoutMs: { type: "number", description: "timeout in ms (default 30000)" },
        background: {
          type: "boolean",
          description:
            "run without waiting for completion; returns a job id for bash_output/bash_kill",
        },
      },
      required: ["cmd"],
      additionalProperties: false,
    },
    async execute({ cmd, cwd, timeoutMs, background }, ctx) {
      const sessionRoot = (ctx as { cwd?: string }).cwd ?? process.cwd()
      const c = cwd as string | undefined
      if (c && (isCwdOutsideRoot(c, sessionRoot) || isPathOutsideRoot(c, sessionRoot)))
        throw new Error(`cwd outside workspace: ${c}`)
      const resolvedCwd = c ? resolvePath(sessionRoot, c) : undefined
      const effectiveCwd = resolvedCwd ?? sessionRoot
      // Catatan TOCTOU (bug-hunt 2026-09-19, tervalidasi e2e): cek-cwd di atas
      // (isCwdOutsideRoot = realpath) menutup varian cwd-form — swap setelah
      // titik ini masih menang SEBELUM spawn (jendela mikrodetik pada alur
      // executor normal; butuh penulis konkuren jahat). Varian redirect-form
      // (`> sub/f` tanpa arg cwd) tak punya recheck saat spawn: shell me-resolve
      // symlink — tak bisa ditutup murah dari sini (shell mengikuti symlink by
      // design; safe-open O_NOFOLLOW hanya untuk tool file). Mitigasi: --sandbox
      // untuk isolasi penuh; lihat permission.ts jail + safe-open.ts.
      const timeout = timeoutMs ?? LIMITS.BASH_DEFAULT_TIMEOUT_MS

      if (background === true) {
        // Sandbox tidak diterapkan di jalur background: container/namespace
        // ephemeral mati bersama call-nya, jadi menjanjikan isolasi di sini
        // akan menyesatkan. Tolak eksplisit daripada diam-diam tanpa sandbox.
        if (process.env.MINICODE_SANDBOX) {
          throw new Error(
            "background:true is not supported while --sandbox is active (the process must outlive the turn)",
          )
        }
        const id = startBackground(cmd as string, resolvedCwd, ownerSid)
        // F-07: echo perintah di-scrub seperti output foreground — command line
        // bisa membawa secret (`curl -H "Authorization: Bearer …"`), dan versi
        // lama menaruhnya mentah ke konteks model.
        return `background job started: ${id}\ncmd: ${scrubSecrets(String(cmd)).slice(0, 200)}\ncollect output: bash_output({ id: "${id}" })`
      }

      // Docker sandbox mode — run in ephemeral isolated container
      if (process.env.MINICODE_SANDBOX === "docker") {
        if (dockerAvailable()) {
          const res = await runInDocker(cmd as string, effectiveCwd, {
            timeoutMs: timeout,
            env: sanitizeSpawnEnv(process.env) as Record<string, string>,
          })
          const text = scrubSecrets(res.output)
          if (res.code !== 0 && res.code !== null)
            return `exit ${res.code}\n${capMarked(text, LIMITS.BASH_OUTPUT_MAX_CHARS)}`
          return capMarked(text, LIMITS.BASH_OUTPUT_MAX_CHARS)
        }
        if (sandboxStrict() || !sandboxExplicitFallbackAllowed()) {
          throw new Error(
            "[sandbox] MINICODE_SANDBOX=docker but docker unavailable — refusing direct execution (explicit sandbox request must not silently downgrade; set MINICODE_SANDBOX_ALLOW_FALLBACK=1 to allow host fallback explicitly)",
          )
        }
        process.stderr.write(
          "[warn] MINICODE_SANDBOX=docker but docker unavailable — falling back to direct execution (explicit MINICODE_SANDBOX_ALLOW_FALLBACK=1)\n",
        )
      }
      // OS-native sandbox (Seatbelt macOS / bubblewrap Linux) — Codex/Gemini-like without Docker
      if (
        process.env.MINICODE_SANDBOX === "os" ||
        process.env.MINICODE_SANDBOX === "seatbelt" ||
        process.env.MINICODE_SANDBOX === "bwrap"
      ) {
        if (osSandboxAvailable()) {
          const res = await runInOsSandbox(cmd as string, effectiveCwd, {
            timeoutMs: timeout,
            env: sanitizeSpawnEnv(process.env) as Record<string, string>,
          })
          const text = scrubSecrets(res.output)
          if (res.code !== 0 && res.code !== null)
            return `exit ${res.code}\n${capMarked(text, LIMITS.BASH_OUTPUT_MAX_CHARS)}`
          return capMarked(text, LIMITS.BASH_OUTPUT_MAX_CHARS)
        }
        if (sandboxStrict() || !sandboxExplicitFallbackAllowed()) {
          throw new Error(
            "[sandbox] OS sandbox unavailable — refusing direct execution (explicit sandbox request must not silently downgrade; set MINICODE_SANDBOX_ALLOW_FALLBACK=1 to allow host fallback explicitly)",
          )
        }
        process.stderr.write(
          "[warn] MINICODE_SANDBOX=os but OS sandbox unavailable — falling back to direct execution (explicit MINICODE_SANDBOX_ALLOW_FALLBACK=1)\n",
        )
      }

      return await new Promise((resolveOut, reject) => {
        const p = spawn(cmd as string, {
          shell: true,
          // F-24: selalu effectiveCwd (sessionRoot bila arg cwd absen), bukan
          // undefined (= inherit process.cwd()). Jail/permission dievaluasi
          // terhadap sessionRoot — eksekusi harus di direktori yang sama.
          cwd: effectiveCwd,
          env: sanitizeSpawnEnv(process.env),
          signal: ctx.signal,
          // detached agar shell jadi group leader → killTree bisa bunuh
          // seluruh grup (POSIX kill(-pid)). Tanpa ini cucu yatim menahan pipe.
          detached: process.platform !== "win32",
        })
        const buf = new CappedBuffer(LIMITS.BASH_OUTPUT_MAX_CHARS)
        // Progres inkremental: command panjang (bun test, build) tidak lagi
        // membisu sampai selesai. Event ini opsional bagi UI.
        const emitChunk = (piece: string) => {
          if (!piece) return
          try {
            ctx.emit?.({
              type: "provider:extension",
              kind: "bash-output",
              data: { text: scrubSecrets(piece) },
            })
          } catch {}
        }
        p.stdout.on("data", (d: Buffer) => emitChunk(buf.append("out", d)))
        p.stderr.on("data", (d: Buffer) => emitChunk(buf.append("err", d)))
        p.on("error", reject)
        p.on("close", (code) => {
          const text = buf.text()
          if (code !== 0) resolveOut(`exit ${code}\n${text}`)
          else resolveOut(text)
        })
        let killTimer: ReturnType<typeof setTimeout> | undefined
        const t = setTimeout(() => {
          // Windows: SIGTERM hanya membunuh cmd.exe wrapper — cucu (node -e)
          // bisa belum lahir (spawn lambat) atau yatim sambil menahan pipe.
          // Eskalasi taskkill /pid-shell-yang-sudah-mati lalu gagal total.
          // Jadi di win32 langsung tree-kill saat timeout, tanpa jeda.
          if (process.platform === "win32") killTree(p)
          else p.kill("SIGTERM")
          killTimer = setTimeout(() => {
            killTree(p)
          }, 2000)
        }, timeout)
        const onAbort = () => {
          clearTimeout(t)
          if (killTimer) clearTimeout(killTimer)
          if (process.platform === "win32") killTree(p)
          else p.kill("SIGTERM")
          killTimer = setTimeout(() => {
            killTree(p)
          }, 1000)
        }
        ctx.signal.addEventListener("abort", onAbort, { once: true })
        p.on("close", () => {
          ctx.signal.removeEventListener("abort", onAbort)
          clearTimeout(t)
          if (killTimer) clearTimeout(killTimer)
        })
      })
    },
  }
}

function makeBashOutputTool(ownerSid: string | null): Tool {
  return {
    name: "bash_output",
    description:
      "Get NEW output from a background job (since the last read). Includes the exit status once it has finished.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "job id dari bash background:true" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute({ id }, ctx: ToolContext) {
      ctx.signal.throwIfAborted()
      // F-03: kepemilikan diperiksa SEBELUM output/status apa pun dibocorkan;
      // pesan untuk job sesi lain = persis "tidak dikenal", tanpa daftar id asing.
      const job = ownedJob(String(id), ownerSid)
      if (!job) {
        const live = liveOwnedIds(ownerSid)
        throw new Error(
          `job "${id}" not found${live.length ? ` — active: ${live.join(", ")}` : ""}`,
        )
      }
      const fresh = job.chunks.slice(job.cursor)
      job.cursor = job.chunks.length
      const status = job.done ? `finished (exit ${job.exitCode ?? "?"})` : "running"
      if (fresh.length === 0) return `[${job.id}] ${status} — no new output yet`
      return capMarked(`[${job.id}] ${status}\n${fresh.join("")}`, LIMITS.BASH_OUTPUT_MAX_CHARS)
    },
  }
}

function makeBashKillTool(ownerSid: string | null): Tool {
  return {
    name: "bash_kill",
    description: "Stop a background job (SIGTERM then SIGKILL).",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "job id" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute({ id }, ctx: ToolContext) {
      ctx.signal.throwIfAborted()
      // F-03: sama seperti bash_output — penolakan identik dengan id tak dikenal,
      // tanpa mengungkap status (hidup/selesai) milik sesi lain.
      const job = ownedJob(String(id), ownerSid)
      if (!job) throw new Error(`job "${id}" not found`)
      if (job.done) return `[${job.id}] already finished (exit ${job.exitCode ?? "?"})`
      // Bunuh TREE, bukan cuma wrapper shell: `proc.kill()` di Windows hanya
      // menebas cmd.exe — cucu (watcher, `node -e`) tetap hidup, menahan pipe
      // stdio sehingga job tak pernah selesai dan prosesnya yatim.
      // POSIX diberi jeda SIGTERM ke grup dulu (graceful); Windows langsung
      // tree-kill, karena proc.kill hanya menebas cmd.exe sedangkan
      // taskkill /T butuh akar yang masih hidup.
      if (process.platform === "win32") killTree(job.proc)
      else if (!signalProcessGroup(job.proc, "SIGTERM")) {
        try {
          job.proc.kill("SIGTERM")
        } catch {}
      }
      setTimeout(() => {
        try {
          if (!job.done) killTree(job.proc)
        } catch {}
      }, 1000)
      return `[${job.id}] stopped`
    },
  }
}

// Instans default TANPA sid: jalur library/test lama tetap berfungsi (caller
// null mengakses job null). Sesi produksi WAJIB memakai createBashJobTools.
export const bashTool: Tool = makeBashTool(null)
export const bashOutputTool: Tool = makeBashOutputTool(null)
export const bashKillTool: Tool = makeBashKillTool(null)

/**
 * F-03 (P5 §C2): instans bash/bash_output/bash_kill yang menyandang satu sid
 * pemilik kanonik. Dipanggil composition root (tool-layer untuk sesi CLI,
 * serveMcp dengan contextId per-instance) — sid DIJAHIT sebagai closure saat
 * perakitan, bukan dari argumen tool yang bisa dipalsukan pemanggil.
 */
export function createBashJobTools(ownerSid: string): {
  bash: Tool
  bashOutput: Tool
  bashKill: Tool
} {
  if (typeof ownerSid !== "string" || !ownerSid)
    throw new Error("createBashJobTools: ownerSid must be a non-empty canonical session id")
  return {
    bash: makeBashTool(ownerSid),
    bashOutput: makeBashOutputTool(ownerSid),
    bashKill: makeBashKillTool(ownerSid),
  }
}
