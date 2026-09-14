import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { resolve as resolvePath } from "node:path"
import type { Tool, ToolContext } from "#minicore"
import { LIMITS } from "../constants.ts"
import { isCwdOutsideRoot, isPathOutsideRoot } from "../policy/jail.ts"

// re-export untuk backward compat (helper kini terpusat di policy/scrub)
export { SECRET_ENV_RE, sanitizeSpawnEnv, stripSecretsEnv } from "../policy/scrub.ts"

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

// MINICODE_SANDBOX_STRICT=1: jangan pernah fallback diam-diam ke eksekusi
// langsung bila isolasi yang diminta tak tersedia — tolak eksplisit.
// Default (tanpa flag) tetap warn+lanjut agar kompatibel (mis. Windows yang
// tak punya bubblewrap/seatbelt). Fail-closed opt-in, bukan default-on.
function sandboxStrict(): boolean {
  const v = (process.env.MINICODE_SANDBOX_STRICT ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

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
}

const jobs = new Map<string, BackgroundJob>()

function reapFinishedJobs(): void {
  const now = Date.now()
  for (const [id, j] of jobs) {
    if (j.done && now - j.startedAt > LIMITS.BASH_BACKGROUND_MAX_LIFETIME_MS) jobs.delete(id)
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
      const r = spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], {
        stdio: "ignore",
      })
      if (r.status === 0) return
    } else if (p.pid !== undefined) {
      // POSIX: bunuh seluruh grup proses (shell wrapper + cucu seperti
      // `node -e`). Spawn foreground memakai detached:true agar shell jadi
      // group leader; kill(-pid) menutup tree-nya.
      try {
        process.kill(-p.pid, "SIGKILL")
        return
      } catch {}
    }
  } catch {}
  try {
    p.kill("SIGKILL")
  } catch {}
}

/** Hentikan semua job — dipanggil saat CLI keluar agar tidak ada proses yatim. */
export function killAllBackgroundJobs(): void {
  for (const [id, j] of jobs) {
    try {
      if (!j.done) j.proc.kill("SIGKILL")
    } catch {}
    jobs.delete(id)
  }
}

export function listBackgroundJobs(): { id: string; cmd: string; done: boolean }[] {
  return [...jobs.values()].map((j) => ({ id: j.id, cmd: j.cmd, done: j.done }))
}

function startBackground(cmd: string, cwd: string | undefined): string {
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

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command (default timeout 30s, max output 20k chars, exit code prefixed). Set background:true for long-running processes (dev server, watcher), then collect output via bash_output and stop with bash_kill. Prefer git_status/git_diff/git_log tools over raw `git` commands: raw git executes repository-configured hooks, filters and diff drivers. Destructive, network-exfiltrating, env-dumping, and inline-interpreter commands are blocked. On Windows the shell is cmd.exe (use dir, echo %VAR%, type).",
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
      const id = startBackground(cmd as string, resolvedCwd)
      return `background job started: ${id}\ncmd: ${String(cmd).slice(0, 200)}\ncollect output: bash_output({ id: "${id}" })`
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
          return `exit ${res.code}\n${capMarked(text, 20000)}`
        return capMarked(text, 20000)
      }
      if (sandboxStrict()) {
        throw new Error(
          "[sandbox] MINICODE_SANDBOX=docker but docker unavailable and MINICODE_SANDBOX_STRICT=1 — refusing direct execution",
        )
      }
      process.stderr.write(
        "[warn] MINICODE_SANDBOX=docker but docker unavailable — falling back to direct execution\n",
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
          return `exit ${res.code}\n${capMarked(text, 20000)}`
        return capMarked(text, 20000)
      }
      if (sandboxStrict()) {
        throw new Error(
          "[sandbox] OS sandbox unavailable and MINICODE_SANDBOX_STRICT=1 — refusing direct execution",
        )
      }
      process.stderr.write(
        "[warn] MINICODE_SANDBOX=os but OS sandbox unavailable — falling back to direct execution\n",
      )
    }

    return await new Promise((resolveOut, reject) => {
      const p = spawn(cmd as string, {
        shell: true,
        cwd: resolvedCwd,
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
      ctx.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t)
          if (killTimer) clearTimeout(killTimer)
          if (process.platform === "win32") killTree(p)
          else p.kill("SIGTERM")
          killTimer = setTimeout(() => {
            killTree(p)
          }, 1000)
        },
        { once: true },
      )
      p.on("close", () => {
        clearTimeout(t)
        if (killTimer) clearTimeout(killTimer)
      })
    })
  },
}

export const bashOutputTool: Tool = {
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
    const job = jobs.get(String(id))
    if (!job) {
      const live = listBackgroundJobs()
      throw new Error(
        `job "${id}" not found${live.length ? ` — active: ${live.map((j) => j.id).join(", ")}` : ""}`,
      )
    }
    const fresh = job.chunks.slice(job.cursor)
    job.cursor = job.chunks.length
    const status = job.done ? `finished (exit ${job.exitCode ?? "?"})` : "running"
    if (fresh.length === 0) return `[${job.id}] ${status} — no new output yet`
    return capMarked(`[${job.id}] ${status}\n${fresh.join("")}`, LIMITS.BASH_OUTPUT_MAX_CHARS)
  },
}

export const bashKillTool: Tool = {
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
    const job = jobs.get(String(id))
    if (!job) throw new Error(`job "${id}" not found`)
    if (job.done) return `[${job.id}] already finished (exit ${job.exitCode ?? "?"})`
    try {
      job.proc.kill("SIGTERM")
    } catch {}
    setTimeout(() => {
      try {
        if (!job.done) job.proc.kill("SIGKILL")
      } catch {}
    }, 1000)
    return `[${job.id}] stopped`
  },
}
