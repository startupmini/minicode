import { type ChildProcess, spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { LIMITS } from "../constants.ts"
import { sanitizeSpawnEnv } from "../policy/scrub.ts"

export class McpTransport {
  private proc: ChildProcess | null = null
  private rl: ReturnType<typeof createInterface> | null = null
  private pending = new Map<
    string | number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private seq = 0
  private closed = false
  // abort HANYA saat close() — bukan timeout, agar server tidak mati sendiri
  private killSignal = new AbortController()

  async connect(command: string, args: string[], env: Record<string, string> = {}): Promise<void> {
    if (this.proc) throw new Error("transport already connected")

    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      // env kredensial di-strip; env eksplisit config server menang setelahnya
      env: sanitizeSpawnEnv(process.env, env),
      signal: this.killSignal.signal,
    })

    this.proc.on("error", (err) => this.failAll(err))
    this.proc.on("exit", (code) => {
      if (!this.closed) this.failAll(new Error(`MCP server exited with code ${code}`))
    })
    this.proc.stderr?.on("data", (d: Buffer) =>
      process.stderr.write(`[mcp:${command}] ${d.toString().trim()}\n`),
    )
    // ensure previous rl closed if reconnecting (defensive)
    if (this.rl)
      try {
        this.rl.close()
      } catch {}

    this.rl = createInterface({ input: this.proc.stdout! })
    this.rl.on("line", (line) => {
      if (!line.trim()) return
      try {
        const msg = JSON.parse(line)
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          clearTimeout(p.timer)
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
          else p.resolve(msg.result)
        }
      } catch (e) {
        process.stderr.write(`[mcp] ignoring invalid JSON from server: ${(e as Error).message}\n`)
      }
    })
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = LIMITS.MCP_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // Batal sebelum tulis: jangan kirim request ke server yang sudah tak ditunggu.
    signal?.throwIfAborted()
    const id = ++this.seq
    this.write({ jsonrpc: "2.0", id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const entry = { resolve, reject, timer }
      this.pending.set(id, entry)
      // stdio JSON-RPC tak punya pembatalan di-kabel: abort hanya menghentikan
      // PENUNGGUAN di sisi kita (server child tetap hidup sampai close/timeout
      // dan efek yang sudah terjadi di server TIDAK dibatalkan).
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(id)) return
          this.pending.delete(id)
          clearTimeout(timer)
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error(`MCP request ${method} aborted`),
          )
        },
        { once: true },
      )
    })
  }

  private writeQueue: string[] = []
  private draining = false

  notify(method: string, params: Record<string, unknown> = {}) {
    this.write({ jsonrpc: "2.0", method, params })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.writeQueue = []
    this.draining = false
    this.failAll(new Error("transport closed"))
    if (this.rl) this.rl.close()
    try {
      this.proc?.stdin?.end()
    } catch {}
    this.killSignal.abort()
    if (this.proc) {
      await new Promise<void>((r) => {
        const p = this.proc!
        const t = setTimeout(() => {
          try {
            p.kill("SIGKILL")
          } catch {}
          r()
        }, 2_000)
        p.once("exit", () => {
          clearTimeout(t)
          r()
        })
      })
    }
    this.proc = null
  }

  private write(msg: unknown) {
    if (!this.proc?.stdin) throw new Error("transport not connected")
    let line: string
    try {
      line = `${JSON.stringify(msg)}\n`
    } catch {
      throw new Error("circular JSON in MCP message")
    }
    if (this.draining) {
      this.writeQueue.push(line)
      return
    }
    const ok = this.proc.stdin.write(line)
    if (!ok) {
      this.draining = true
      this.proc.stdin.once("drain", () => {
        this.draining = false
        this.flushQueue()
      })
    }
  }

  private flushQueue() {
    if (!this.proc?.stdin || this.draining) return
    while (this.writeQueue.length > 0) {
      const next = this.writeQueue.shift()!
      const ok = this.proc.stdin.write(next)
      if (!ok) {
        this.draining = true
        this.proc.stdin.once("drain", () => {
          this.draining = false
          this.flushQueue()
        })
        break
      }
    }
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}
