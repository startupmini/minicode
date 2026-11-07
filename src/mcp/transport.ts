import { type ChildProcess, spawn } from "node:child_process"
import { LIMITS } from "../constants.ts"
import { sanitizeSpawnEnv } from "../policy/scrub.ts"

export class McpTransport {
  private proc: ChildProcess | null = null
  private stdoutFrame = Buffer.alloc(0)
  private pending = new Map<
    string | number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
      /** Lepas listener abort saat request settle (RL-5 — anti bocor). */
      unsubscribe?: () => void
    }
  >()
  private seq = 0
  private closed = false
  // abort HANYA saat close() — bukan timeout, agar server tidak mati sendiri
  private killSignal = new AbortController()

  /** P2.3: liveness untuk reconnect policy (bukan sekadar proke ada). */
  get isClosed(): boolean {
    return this.closed || this.proc === null || this.proc.exitCode !== null
  }

  async connect(command: string, args: string[], env: Record<string, string> = {}): Promise<void> {
    if (this.proc) throw new Error("transport already connected")

    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      // env kredensial di-strip; env eksplisit config server menang setelahnya
      env: sanitizeSpawnEnv(process.env, env),
      signal: this.killSignal.signal,
    })

    this.proc.on("error", (err) => this.failAll(err))
    this.proc.stdin?.on("error", (err) => {
      // Server dapat keluar tepat sebelum request ditulis. EPIPE pada stdin
      // tetap harus menjadi penolakan request, bukan uncaught exception proses.
      this.closed = true
      this.writeQueue = []
      this.draining = false
      this.failAll(err)
    })
    this.proc.on("exit", (code) => {
      if (!this.closed) this.failAll(new Error(`MCP server exited with code ${code}`))
    })
    this.proc.stderr?.on("data", (d: Buffer) =>
      process.stderr.write(`[mcp:${command}] ${d.toString().trim()}\n`),
    )
    this.stdoutFrame = Buffer.alloc(0)
    this.proc.stdout!.on("data", (chunk: Buffer) => this.consumeStdout(chunk))
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
        unsubscribe()
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const onAbort = () => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        clearTimeout(timer)
        const reason = signal?.reason
        reject(reason instanceof Error ? reason : new Error(`MCP request ${method} aborted`))
      }
      // [RL-5] Simpan pembersih listener agar request yang settle normal
      // (respon masuk / timeout) melepas `onAbort` dari signal — anti bocor.
      const unsubscribe = () => signal?.removeEventListener("abort", onAbort)
      signal?.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, { resolve, reject, timer, unsubscribe })
    })
  }

  private writeQueue: string[] = []
  private draining = false

  notify(method: string, params: Record<string, unknown> = {}) {
    this.write({ jsonrpc: "2.0", method, params })
  }

  async close(): Promise<void> {
    if (this.closed && !this.proc) return
    this.closed = true
    this.writeQueue = []
    this.draining = false
    this.failAll(new Error("transport closed"))
    try {
      this.proc?.stdin?.end()
    } catch {}
    this.killSignal.abort()
    if (this.proc) {
      const p = this.proc
      if (p.exitCode === null && p.signalCode === null) {
        await new Promise<void>((r) => {
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
    }
    this.proc = null
  }

  private write(msg: unknown) {
    const proc = this.proc
    if (!proc?.stdin) throw new Error("transport not connected")
    if (this.closed || proc.exitCode !== null || proc.stdin.destroyed) {
      throw new Error(
        `MCP transport is closed${proc.exitCode === null ? "" : ` (exit ${proc.exitCode})`}`,
      )
    }
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
    const ok = proc.stdin.write(line)
    if (!ok) {
      this.draining = true
      proc.stdin.once("drain", () => {
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

  /** Frame parsing stays incremental so a peer cannot make readline buffer an unlimited line. */
  private consumeStdout(chunk: Buffer): void {
    let start = 0
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue
      const part = chunk.subarray(start, i)
      if (this.stdoutFrame.length + part.length > LIMITS.MCP_STDIO_FRAME_MAX_BYTES) {
        this.rejectOversizedFrame(this.stdoutFrame.length + part.length)
        return
      }
      const frame = this.stdoutFrame.length === 0 ? part : Buffer.concat([this.stdoutFrame, part])
      this.stdoutFrame = Buffer.alloc(0)
      this.handleFrame(frame)
      if (this.closed) return
      start = i + 1
    }
    if (start < chunk.length) {
      const remainder = chunk.subarray(start)
      if (this.stdoutFrame.length + remainder.length > LIMITS.MCP_STDIO_FRAME_MAX_BYTES) {
        this.rejectOversizedFrame(this.stdoutFrame.length + remainder.length)
        return
      }
      this.stdoutFrame =
        this.stdoutFrame.length === 0
          ? Buffer.from(remainder)
          : Buffer.concat([this.stdoutFrame, remainder])
    }
  }

  private handleFrame(frame: Buffer): void {
    if (frame.length === 0) return
    try {
      const msg = JSON.parse(frame.toString("utf8"))
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        clearTimeout(p.timer)
        p.unsubscribe?.()
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message || "MCP server returned an error"))
        else p.resolve(msg.result)
      }
    } catch {
      process.stderr.write("[mcp] ignoring invalid JSON from server\n")
    }
  }

  private rejectOversizedFrame(size: number): void {
    const error = new Error(
      `MCP stdio frame exceeds ${LIMITS.MCP_STDIO_FRAME_MAX_BYTES} bytes (at least ${size})`,
    )
    this.closed = true
    this.stdoutFrame = Buffer.alloc(0)
    this.writeQueue = []
    this.draining = false
    this.failAll(error)
    this.killSignal.abort(error)
    try {
      this.proc?.kill("SIGKILL")
    } catch {}
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}
