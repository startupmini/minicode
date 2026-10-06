// P2.12 — klien IPC minimal (dipakai CLI `minicode daemon …` dan test).
//
// Sengaja ada di `src/`, bukan `cli/`: test butuh klien tanpa menjalankan
// seluruh CLI, dan modul non-ui tidak boleh mengimpor `cli/`. Klien ini juga
// PEMBUKTI liveness sesungguhnya — `discover()` hanya menghasilkan "suspect",
// dan status "alive" hanya boleh lahir dari probe koneksi yang berhasil di
// sini (recency != liveness).

import { connect, type Socket } from "node:net"
import { type DiscoveryResult, discover, readEndpoint } from "./discovery.ts"
import { encodeFrame, FrameDecoder } from "./framing.ts"
import { DAEMON_PROTOCOL, type ServerMessage, type SubscribeFrom } from "./protocol.ts"

export interface ConnectTarget {
  host: string
  port: number
}

export type ClientEvent =
  | { kind: "message"; msg: ServerMessage }
  | { kind: "closed"; reason: string }
  | { kind: "protocol-error"; message: string }

export interface ProbeResult {
  alive: boolean
  reason: string
  target: ConnectTarget | null
  discovery: DiscoveryResult
}

/**
 * Probe kehidupan daemon: baca endpoint -> coba TCP connect.
 *
 * SATU-SATUNYA tempat yang boleh menyata `alive: true`. Semua pemanggil lain
 * memakai hasil di sini, bukan umur file.
 */
export async function probeDaemon(cwd?: string, timeoutMs = 800): Promise<ProbeResult> {
  const discovery = discover(cwd)
  if (!discovery.endpoint) {
    return {
      alive: false,
      reason: discovery.reason ?? "tidak ada endpoint",
      target: null,
      discovery,
    }
  }
  const target: ConnectTarget = { host: discovery.endpoint.host, port: discovery.endpoint.port }
  try {
    await withTimeout(openAndClose(target), timeoutMs, "probe timeout")
    return { alive: true, reason: "probe koneksi berhasil", target, discovery }
  } catch (e) {
    return { alive: false, reason: String((e as Error).message ?? e), target, discovery }
  }
}

function openAndClose(target: ConnectTarget): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: target.host, port: target.port })
    const done = (fn: () => void) => {
      sock.removeAllListeners()
      sock.destroy()
      fn()
    }
    sock.once("connect", () => done(resolve))
    sock.once("error", (e) => done(() => reject(e)))
  })
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms)
    t.unref?.()
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export interface DaemonClientOptions {
  target: ConnectTarget
  capability: string
  consumer: string
}

export class DaemonClient {
  readonly #sock: Socket
  readonly #decoder = new FrameDecoder()
  readonly #listeners = new Set<(e: ClientEvent) => void>()
  #closed = false
  welcome: Extract<ServerMessage, { t: "welcome" }> | null = null
  #pendingControl = new Map<string, (msg: ServerMessage) => void>()

  private constructor(sock: Socket) {
    this.#sock = sock
    sock.on("data", (chunk: string | Buffer) => {
      let msgs: unknown[]
      try {
        // Beberapa runtime memuntahkan data sebagai string bila encoding
        // diset; framing butuh byte mentah agar tidak salah hitung panjang.
        msgs = this.#decoder.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk)
      } catch (e) {
        this.#emit({ kind: "protocol-error", message: String((e as Error).message ?? e) })
        this.close("protocol-error")
        return
      }
      for (const raw of msgs) {
        if (!raw || typeof raw !== "object" || !("t" in raw)) continue
        const msg = raw as ServerMessage
        if (msg.t === "control_result") {
          const waiter = this.#pendingControl.get(msg.idem)
          if (waiter) {
            this.#pendingControl.delete(msg.idem)
            waiter(msg)
          }
        }
        this.#emit({ kind: "message", msg })
      }
    })
    sock.on("close", () => this.#emit({ kind: "closed", reason: "socket tertutup" }))
    sock.on("error", (e) =>
      this.#emit({ kind: "closed", reason: String((e as Error).message ?? e) }),
    )
  }

  static async connect(opts: DaemonClientOptions): Promise<DaemonClient> {
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ host: opts.target.host, port: opts.target.port })
      s.once("connect", () => {
        s.removeAllListeners("error")
        resolve(s)
      })
      s.once("error", reject)
    })
    const client = new DaemonClient(sock)
    await client.hello(opts.capability, opts.consumer)
    return client
  }

  on(fn: (e: ClientEvent) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  #emit(e: ClientEvent): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn(e)
      } catch {
        // Listener yang melempar tidak boleh mematikan klien untuk yang lain.
      }
    }
  }

  #send(msg: unknown): void {
    if (this.#closed) return
    this.#sock.write(encodeFrame(msg))
  }

  async hello(
    capability: string,
    consumer: string,
    timeoutMs = 2_000,
  ): Promise<Extract<ServerMessage, { t: "welcome" }>> {
    const gotWelcome = new Promise<Extract<ServerMessage, { t: "welcome" }>>((resolve, reject) => {
      const off = this.on((e) => {
        if (e.kind === "message" && e.msg.t === "welcome") {
          off()
          resolve(e.msg)
        } else if (e.kind === "message" && e.msg.t === "error") {
          off()
          reject(new Error(`${e.msg.code}: ${e.msg.message}`))
        } else if (e.kind === "closed") {
          off()
          reject(new Error(`koneksi ditutup saat hello: ${e.reason}`))
        }
      })
    })
    this.#send({ t: "hello", protocol: DAEMON_PROTOCOL, cap: capability, consumer })
    this.welcome = await withTimeout(gotWelcome, timeoutMs, "hello timeout")
    return this.welcome
  }

  /** Tunggu pesan tertentu (untuk test & handshake berurutan). */
  next(pred: (m: ServerMessage) => boolean, timeoutMs = 3_000): Promise<ServerMessage> {
    return withTimeout(
      new Promise<ServerMessage>((resolve) => {
        const off = this.on((e) => {
          if (e.kind === "message" && pred(e.msg)) {
            off()
            resolve(e.msg)
          }
        })
      }),
      timeoutMs,
      "menunggu pesan timeout",
    )
  }

  subscribe(sid: string, from: SubscribeFrom): void {
    this.#send({ t: "subscribe", sid, from, consumer: this.welcome?.consumer ?? "" })
  }

  ack(sid: string, seq: number): void {
    this.#send({ t: "ack", sid, seq, consumer: this.welcome?.consumer ?? "" })
  }

  control(
    op: string,
    args: Record<string, unknown>,
    idem: string,
    timeoutMs = 3_000,
  ): Promise<Extract<ServerMessage, { t: "control_result" }>> {
    const waiter = new Promise<Extract<ServerMessage, { t: "control_result" }>>(
      (resolve, reject) => {
        this.#pendingControl.set(idem, (m) => {
          resolve(m as Extract<ServerMessage, { t: "control_result" }>)
        })
        const off = this.on((e) => {
          if (e.kind === "closed") {
            off()
            this.#pendingControl.delete(idem)
            reject(new Error(`koneksi ditutup: ${e.reason}`))
          }
        })
      },
    )
    this.#send({ t: "control", op, idem, args, consumer: this.welcome?.consumer ?? "" })
    return withTimeout(waiter, timeoutMs, "control timeout")
  }

  ping(id: string): Promise<ServerMessage> {
    // Pasang penunggu SEBELUM mengirim: balasan bisa datang lebih cepat dari
    // penambahan listener bila urutannya dibalik.
    const waiter = this.next((m) => m.t === "pong" && m.id === id)
    this.#send({ t: "ping", id })
    return waiter
  }

  close(reason = "klien menutup"): void {
    if (this.#closed) return
    this.#send({ t: "goodbye" })
    this.#closed = true
    try {
      this.#sock.end()
    } catch {
      this.#sock.destroy()
    }
    this.#emit({ kind: "closed", reason })
  }

  get closed(): boolean {
    return this.#closed
  }
}

/** Baca endpoint langsung (tanpa probe) — untuk diagnostik. */
export function readTarget(cwd?: string): ConnectTarget | null {
  const ep = readEndpoint(cwd)
  return ep ? { host: ep.host, port: ep.port } : null
}
