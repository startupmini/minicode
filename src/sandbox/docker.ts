import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { LIMITS } from "../constants.ts"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { sanitizeSpawnEnv } from "../policy/scrub.ts"

let dockerOk: boolean | null = null

// Cek docker CLI tersedia (cache hasilnya).
export function dockerAvailable(): boolean {
  if (dockerOk !== null) return dockerOk
  try {
    // F-23: resolve absolut dari PATH terpercaya — di Windows spawn mencari
    // CWD lebih dulu sehingga docker.bat di workspace bisa membajak cek ini.
    const r = spawnSync(
      resolveTrustedExecutable("docker"),
      ["version", "--format", "{{.Server.Version}}"],
      {
        stdio: "ignore",
        timeout: 5000,
      },
    )
    dockerOk = r.status === 0
  } catch {
    dockerOk = false
  }
  return dockerOk
}

// Konversi path workspace untuk -v mount. Windows: C:\x → //c/x (Docker Desktop / MSYS).
function workspaceMount(cwd: string): string {
  const abs = resolve(cwd)
  if (process.platform === "win32") {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(abs)
    if (m) return `//${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}`
  }
  return abs
}

export interface DockerRunOptions {
  image?: string
  network?: "none" | "bridge"
  memory?: string
  cpus?: number
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

let dockerSpawnForTest: typeof spawn | null = null

/** Seam untuk mensimulasikan lifecycle Docker tanpa daemon dalam tes. */
export function setDockerSpawnForTest(spawner: typeof spawn | null): void {
  dockerSpawnForTest = spawner
}

function dockerExecutable(): string {
  return dockerSpawnForTest ? "docker" : resolveTrustedExecutable("docker")
}

function spawnDocker(args: string[], env: NodeJS.ProcessEnv) {
  return (dockerSpawnForTest ?? spawn)(dockerExecutable(), args, {
    stdio: "ignore",
    env,
  })
}

/** Minta daemon menghapus container; timeout membuat kegagalan cleanup eksplisit. */
function removeContainer(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolveResult) => {
    let done = false
    const p = spawnDocker(["rm", "--force", name], env)
    const finish = (removed: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolveResult(removed)
    }
    const timer = setTimeout(() => {
      p.kill("SIGKILL")
      finish(false)
    }, LIMITS.DOCKER_CLEANUP_TIMEOUT_MS)
    p.on("error", () => finish(false))
    p.on("close", (code) => finish(code === 0))
  })
}

// Run command di dalam container ephemeral, terisolasi (--network none,
// memori/CPU cap), mount workspace read-write. Return { code, output }.
export function runInDocker(
  command: string,
  cwd: string,
  opts: DockerRunOptions = {},
): Promise<{ code: number | null; output: string }> {
  if (opts.signal?.aborted) {
    return Promise.resolve({ code: null, output: "[docker] aborted before container start" })
  }
  const image = opts.image ?? process.env.MINICODE_SANDBOX_IMAGE ?? "node:22-alpine"
  const mount = workspaceMount(cwd)
  const containerName = `minicode-${randomUUID()}`
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "-i",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "32",
    "--tmpfs",
    "/tmp",
    "-v",
    `${mount}:${mount}`,
    "-w",
    mount,
    "--network",
    "none",
    "--memory",
    opts.memory ?? process.env.MINICODE_SANDBOX_MEMORY ?? "512m",
    "--cpus",
    String(opts.cpus ?? 1),
    "--user",
    "1000:1000",
    image,
    "sh",
    "-c",
    command,
  ]

  return new Promise((resolveResult) => {
    // env selalu disanitasi dari hasil merge final — secret (API_KEY/TOKEN/...)
    // tidak pernah diwarisi container walau caller lupa strip.
    const env = sanitizeSpawnEnv(process.env, opts.env)
    const p = (dockerSpawnForTest ?? spawn)(dockerExecutable(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    })
    // Cap buffer saat streaming — output container raksasa tidak menumpuk di RAM.
    const OUT_CAP = LIMITS.DOCKER_OUTPUT_MAX_CHARS
    let out = "",
      err = ""
    let truncated = false
    const appendCapped = (target: "out" | "err", d: Buffer | string): void => {
      const s = typeof d === "string" ? d : d.toString()
      const cur = target === "out" ? out : err
      if (cur.length >= OUT_CAP) {
        truncated = true
        return
      }
      const room = OUT_CAP - cur.length
      if (s.length > room) truncated = true
      const piece = s.slice(0, Math.max(0, room))
      if (target === "out") out += piece
      else err += piece
    }
    p.stdout.on("data", (d) => appendCapped("out", d))
    p.stderr.on("data", (d) => appendCapped("err", d))
    const timeout =
      typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : LIMITS.DOCKER_TIMEOUT_MS
    let settled = false
    let closed = false
    let stopReason: "timeout" | "abort" | undefined
    let stopPromise: Promise<boolean> | undefined
    let t: ReturnType<typeof setTimeout>
    const signal = opts.signal
    const finalize = (code: number | null, suffix = "") => {
      if (settled) return
      settled = true
      clearTimeout(t)
      signal?.removeEventListener("abort", onAbort)
      const marker = truncated ? "\n… [output truncated]" : ""
      const output = (out + (err ? `\n[stderr]\n${err}` : "")).trim() + marker + suffix
      resolveResult({ code, output })
    }
    const requestStop = (reason: "timeout" | "abort") => {
      if (stopReason || settled) return
      stopReason = reason
      clearTimeout(t)
      stopPromise = removeContainer(containerName, env).catch(() => false)
      void stopPromise.then((removed) => {
        if (!closed) p.kill("SIGKILL")
        if (closed) {
          const detail = removed
            ? "daemon container removal confirmed"
            : "daemon cleanup unconfirmed"
          const reasonText = reason === "timeout" ? `timed out after ${timeout}ms` : "aborted"
          finalize(null, `\n[docker] ${reasonText}; ${detail}`)
        }
      })
    }
    const onAbort = () => requestStop("abort")
    t = setTimeout(() => requestStop("timeout"), timeout)
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) requestStop("abort")
    }
    p.on("error", (e) => {
      closed = true
      if (stopReason) {
        void (stopPromise ?? Promise.resolve(false)).then((removed) => {
          const detail = removed
            ? "daemon container removal confirmed"
            : "daemon cleanup unconfirmed"
          finalize(null, `\n[docker] ${stopReason}; ${detail}`)
        })
      } else {
        finalize(null, `[docker] ${e.message}`)
      }
    })
    p.on("close", (code) => {
      closed = true
      clearTimeout(t)
      if (stopReason) {
        void (stopPromise ?? Promise.resolve(false)).then((removed) => {
          const detail = removed
            ? "daemon container removal confirmed"
            : "daemon cleanup unconfirmed"
          const reasonText = stopReason === "timeout" ? `timed out after ${timeout}ms` : "aborted"
          finalize(null, `\n[docker] ${reasonText}; ${detail}`)
        })
      } else {
        finalize(code)
      }
    })
  })
}
