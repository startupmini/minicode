// P2.12 — server IPC daemon (loopback TCP).
//
// Keputusan transport: TCP loopback, bukan Unix socket / named pipe. Kontrak
// menuntut konsumen lintas-platform yang bisa dipakai Desktop di Windows;
// Unix socket tidak ada di Windows dan named pipe tidak ada di POSIX tanpa
// kode cabang. Loopback + capability bercakupan + berkas endpoint 0600
// memberi batas kepercayaan yang sama: hanya proses di mesin ini, dan hanya
// yang memegang secret.
//
// Alur per koneksi (kontrak § handshake): hello -> welcome -> subscribe ->
// frontiers -> snapshot -> cursor -> replay -> tail_marker -> LIVE.
// Replay dan live tidak boleh berbaur: event yang masih ditulis selama replay
// akan tiba dua kali bila disuntikkan di tengah — maka event live yang seq-nya
// sudah tercakup replay dibuang.

import type { Server } from "node:net"
import { createServer, type Socket } from "node:net"
import type { ApprovalBroker } from "./approvals.ts"
import { type CapabilityPayload, verifyCapability } from "./capability.ts"
import {
  type ControlActions,
  type ControlDeps,
  dispatchControl,
  type IdempotencyStore,
  toControlMessage,
} from "./control.ts"
import { buildSnapshot, REPLAY_PAGE_LIMIT, type SessionFeed } from "./feed.ts"
import { assertProtocol, encodeFrame, FrameDecoder, isRecord } from "./framing.ts"
import type { ApprovalView } from "./protocol.ts"
import {
  DAEMON_PROTOCOL,
  type DaemonScope,
  type HaltReason,
  type RefusalBody,
  type ServerMessage,
  type SubscribeFrom,
} from "./protocol.ts"
import { sanitizeJsonObject, sanitizeLabel } from "./sanitize.ts"
import { readConsumerOffset } from "./store.ts"
import { type Subscription, SubscriptionRegistry } from "./subscription.ts"
import type { Telemetry } from "./telemetry.ts"

export interface FeedRegistry {
  get(sid: string): SessionFeed | undefined
  known(): string[]
}

export interface DaemonServerDeps {
  incarnation: string
  secret: Buffer
  host: string
  port: number
  cwd?: string
  feeds: FeedRegistry
  subscriptions?: SubscriptionRegistry
  approvals: ApprovalBroker
  control: {
    actions: ControlActions | null
    idem: IdempotencyStore
    telemetry: Telemetry
    storageOk: () => boolean
    shuttingDown: () => boolean
  }
  telemetry: Telemetry
  /** Dipanggil saat daemon menerima koneksi (diagnostik). */
  onConnection?: (info: { remote: string; consumer: string }) => void
}

interface Conn {
  id: number
  socket: Socket
  decoder: FrameDecoder
  state: "new" | "ready"
  consumerId: string | null
  scopes: DaemonScope[]
  subs: Map<string, Subscription>
  paused: boolean
  closed: boolean
}

let connSeq = 0

export class DaemonServer {
  readonly #deps: DaemonServerDeps
  readonly #subs: SubscriptionRegistry
  readonly #conns = new Map<number, Conn>()
  readonly #liveUnsub = new Map<string, () => void>()
  #server: Server | null = null
  #port = 0
  #closing = false
  #startedAt = 0

  constructor(deps: DaemonServerDeps) {
    this.#deps = deps
    this.#subs = deps.subscriptions ?? new SubscriptionRegistry()
  }

  get port(): number {
    return this.#port
  }

  get connectionCount(): number {
    return this.#conns.size
  }

  get closing(): boolean {
    return this.#closing
  }

  async start(): Promise<{ port: number }> {
    const server = createServer({ noDelay: true }, (socket) => this.#onConnection(socket))
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e)
      server.once("error", onErr)
      server.listen(this.#deps.port, this.#deps.host, () => {
        server.off("error", onErr)
        resolve()
      })
    })
    const addr = server.address()
    if (addr === null || typeof addr === "string")
      throw new Error("daemon: alamat loopback tak terbaca")
    this.#port = addr.port
    this.#startedAt = Date.now()
    return { port: this.#port }
  }

  #onConnection(socket: Socket): void {
    this.#deps.telemetry.inc("connections.opened")
    const conn: Conn = {
      id: ++connSeq,
      socket,
      decoder: new FrameDecoder(),
      state: "new",
      consumerId: null,
      scopes: [],
      subs: new Map(),
      paused: false,
      closed: false,
    }
    this.#conns.set(conn.id, conn)

    socket.on("data", (chunk: Buffer) => {
      try {
        const msgs = conn.decoder.push(chunk)
        for (const m of msgs) this.#onMessage(conn, m)
      } catch (e) {
        this.#sendError(conn, "PROTOCOL_ERROR", String((e as Error).message ?? e))
        this.#halt(conn, "PROTOCOL_ERROR")
      }
    })
    socket.on("drain", () => {
      conn.paused = false
      this.#pump(conn)
    })
    const teardown = () => this.#teardown(conn)
    socket.on("close", teardown)
    socket.on("error", teardown)
  }

  #teardown(conn: Conn): void {
    if (conn.closed) return
    conn.closed = true
    this.#deps.telemetry.inc("connections.closed")
    if (conn.consumerId) {
      this.#subs.dropConsumer(conn.consumerId)
      this.#pruneLive()
    }
    this.#conns.delete(conn.id)
    conn.subs.clear()
    try {
      // Jangan langkas-langkas: `destroy()` pada socket yang masih memegang
      // tulisan tertunda (mis. frame control_result "shutdown diterima")
      // membuangnya, lalu pemanggil CLI gagal padahal perintah sukses.
      // `end()` mengosongkan buffer ke peer lebih dulu; paksa tutup sesudahnya.
      conn.socket.end()
      const sock = conn.socket
      const timer = setTimeout(() => {
        try {
          sock.destroy()
        } catch {
          /* sudah tertutup */
        }
      }, 150)
      timer.unref?.()
    } catch {
      // Socket sudah mati — bukan kegagalan yang perlu ditangani.
    }
  }

  #send(conn: Conn, msg: ServerMessage): boolean {
    if (conn.closed) return false
    try {
      const ok = conn.socket.write(encodeFrame(msg))
      if (!ok) conn.paused = true
      return true
    } catch {
      this.#teardown(conn)
      return false
    }
  }

  #sendError(conn: Conn, code: RefusalBody["code"], message: string): void {
    this.#send(conn, { t: "error", code, message: sanitizeLabel(message, 400) })
  }

  /** Hentikan konsumen dengan alasan tegas + tutup koneksi. */
  #halt(conn: Conn, reason: HaltReason): void {
    if (conn.closed) return
    this.#send(conn, { t: "halt", reason })
    try {
      conn.socket.end()
    } catch {
      this.#teardown(conn)
    }
    setTimeout(() => this.#teardown(conn), 50).unref?.()
  }

  // -------------------------------------------------------------------------
  // Pesan masuk
  // -------------------------------------------------------------------------

  #onMessage(conn: Conn, raw: unknown): void {
    if (!isRecord(raw) || typeof raw.t !== "string") {
      this.#sendError(conn, "PROTOCOL_ERROR", "pesan bukan objek bertipe")
      this.#halt(conn, "PROTOCOL_ERROR")
      return
    }
    switch (raw.t) {
      case "hello":
        this.#onHello(conn, raw)
        return
      case "ping":
        this.#send(conn, { t: "pong", id: String(raw.id ?? "") })
        return
      case "goodbye":
        this.#teardown(conn)
        return
      default:
        break
    }
    if (conn.state !== "ready") {
      this.#sendError(conn, "INVALID_CAPABILITY", "hello diperlukan sebelum operasi lain")
      this.#halt(conn, "PROTOCOL_ERROR")
      return
    }
    switch (raw.t) {
      case "subscribe":
        this.#onSubscribe(conn, raw)
        return
      case "ack":
        this.#onAck(conn, raw)
        return
      case "control":
        this.#onControl(conn, raw)
        return
      default:
        this.#sendError(
          conn,
          "PROTOCOL_ERROR",
          `t tak dikenal: ${sanitizeLabel(String(raw.t), 40)}`,
        )
        this.#halt(conn, "PROTOCOL_ERROR")
    }
  }

  #onHello(conn: Conn, raw: Record<string, unknown>): void {
    try {
      assertProtocol({ protocol: raw.protocol })
    } catch (e) {
      this.#deps.telemetry.inc("connections.rejected")
      this.#sendError(conn, "PROTOCOL_ERROR", (e as Error).message)
      this.#teardown(conn)
      return
    }
    const check = verifyCapability(this.#deps.secret, String(raw.cap ?? ""), {
      incarnation: this.#deps.incarnation,
    })
    if (!check.ok) {
      this.#deps.telemetry.inc("connections.rejected")
      // STALE_INCARNATION vs INVALID_CAPABILITY harus terbedakan: yang pertama
      // berarti "daemon sudah ganti, minta capability baru", yang kedua
      // berarti "capability ini memang tidak sah".
      const code = check.reason === "STALE_INCARNATION" ? "STALE_INCARNATION" : "INVALID_CAPABILITY"
      this.#sendError(conn, code, `capability ditolak: ${check.reason}`)
      this.#teardown(conn)
      return
    }
    const payload: CapabilityPayload = check.payload
    conn.state = "ready"
    conn.scopes = payload.scopes
    conn.consumerId = sanitizeLabel(payload.who, 120) || `consumer-${conn.id}`
    this.#send(conn, {
      t: "welcome",
      protocol: DAEMON_PROTOCOL,
      incarnation: this.#deps.incarnation,
      scopes: payload.scopes,
      consumer: conn.consumerId,
    })
    this.#deps.onConnection?.({
      remote: conn.socket.remoteAddress ?? "?",
      consumer: conn.consumerId,
    })
  }

  #onSubscribe(conn: Conn, raw: Record<string, unknown>): void {
    const sid = typeof raw.sid === "string" ? raw.sid : ""
    if (!sid) {
      this.#sendError(conn, "SESSION_MISMATCH", "sid wajib diisi")
      return
    }
    if (!conn.scopes.includes("subscribe")) {
      this.#sendError(conn, "SCOPE_DENIED", "subscribe membutuhkan cakupan subscribe")
      return
    }
    const feed = this.#deps.feeds.get(sid)
    if (!feed) {
      // Sesi tidak dikenal: bukan SESSION_MISMATCH (itu untuk perbedaan milik),
      // tapi NOT_FOUND — konsumen bertanya tentang sesi yang tak ada sama sekali.
      this.#sendError(
        conn,
        "NOT_FOUND",
        `sesi ${sanitizeLabel(sid, 64)} tidak tersedia di daemon ini`,
      )
      return
    }
    const head = feed.head()
    const fromRaw = raw.from
    const from: SubscribeFrom =
      fromRaw === "tail" || fromRaw === "resume"
        ? fromRaw
        : typeof fromRaw === "number" && Number.isFinite(fromRaw)
          ? fromRaw
          : // Nilai tak dikenal = resume (default paling aman: tak membanjiri
            // konsumen dengan replay penuh, dan tak kehilangan progres ack).
            "resume"
    const consumer = conn.consumerId ?? `consumer-${conn.id}`

    const { sub, fromSeq } = this.#subs.attach(
      { consumerId: consumer, sid, from, head, fromSeq: 0, cwd: this.#deps.cwd },
      (c, s) => readConsumerOffset(c, s, this.#deps.cwd),
    )
    conn.subs.set(sid, sub)
    this.#deps.telemetry.inc("subscribe.attached")

    // Pasang listener live SEBELUM membaca toko. Keduanya sinkron hari ini,
    // tetapi urutan ini membuat celah "event tiba di antara replay dan
    // langganan" mustahil terjadi bila salah satu jalur kelak menjadi async:
    // apa pun yang tiba lebih dulu sudah berada di antrean dan akan difilter
    // terhadap cursor replay, bukan hilang begitu saja.
    this.#ensureLive(sid)

    // 1) frontiers  2) snapshot  3) cursor
    const frontiers = feed.frontiers()
    this.#send(conn, { t: "frontiers", sid, frontiers })
    const { snapshot, rejected } = buildSnapshot(feed)
    this.#send(conn, { t: "snapshot", sid, consumer, snapshot })
    this.#send(conn, {
      t: "subscribed",
      sid,
      consumer,
      fromSeq,
      cursor: sub.cursor,
      snapshotRejected: rejected,
    })

    // 4) replay — hanya bila memang ada yang harus dikirim.
    let replayTo = sub.cursor
    if (fromSeq <= head) {
      let cursor = fromSeq - 1
      for (;;) {
        const page = feed.readRange(cursor + 1, REPLAY_PAGE_LIMIT)
        if (page.events.length === 0) break
        for (const ev of page.events) {
          const seq = numberOr(ev.eventSeq, -1)
          if (seq < fromSeq) continue
          if (
            !this.#send(conn, { t: "event", sid, consumer, seq, provenance: "REPLAY", event: ev })
          )
            return
          cursor = seq
          sub.cursor = seq
          this.#deps.telemetry.inc("events.replayed")
        }
        if (page.events.length < REPLAY_PAGE_LIMIT) break
      }
      replayTo = sub.cursor
    }
    this.#send(conn, { t: "replay_done", sid, consumer, upToSeq: replayTo })
    // 5) penanda live-tail: segala sesuatu SETELAH pesan ini adalah LIVE dan
    //    boleh saja belum durable — konsumen harus memperlakukannya beda.
    this.#send(conn, { t: "tail_marker", sid, consumer, atSeq: replayTo })
    // 6) kosongkan antrean live yang terkumpul selama replay (yang seq-nya
    //    sudah terkirim otomatis terbuang di #pump).
    this.#pump(conn)
  }

  #onAck(conn: Conn, raw: Record<string, unknown>): void {
    const sid = typeof raw.sid === "string" ? raw.sid : ""
    const seq = typeof raw.seq === "number" ? raw.seq : -1
    const sub = conn.subs.get(sid)
    if (!sub) {
      this.#sendError(conn, "SESSION_MISMATCH", "ack tanpa langganan aktif")
      return
    }
    const res = sub.ack(seq)
    if (!res.ok) {
      this.#deps.telemetry.inc("ack.rejected")
      this.#sendError(
        conn,
        res.reason === "CLOSED" ? "SHUTTING_DOWN" : "PROTOCOL_ERROR",
        res.reason === "CLOSED"
          ? "langganan sudah ditutup"
          : `ack ${seq} di luar jangkauan (cursor ${sub.cursor})`,
      )
      return
    }
    this.#deps.telemetry.inc("ack.accepted")
    this.#send(conn, { t: "ack_ok", sid, consumer: conn.consumerId ?? "", seq: res.persisted })
  }

  #onControl(conn: Conn, raw: Record<string, unknown>): void {
    const args = isRecord(raw.args) ? (sanitizeJsonObject(raw.args) as Record<string, unknown>) : {}
    const outcome = dispatchControl(
      {
        consumerId: conn.consumerId ?? `consumer-${conn.id}`,
        scopes: conn.scopes,
        op: String(raw.op ?? ""),
        idem: String(raw.idem ?? ""),
        args,
      },
      {
        incarnation: this.#deps.incarnation,
        actions: this.#deps.control.actions,
        approvals: this.#deps.approvals,
        telemetry: this.#deps.control.telemetry,
        storageOk: this.#deps.control.storageOk,
        shuttingDown: this.#deps.control.shuttingDown,
      } satisfies ControlDeps,
      this.#deps.control.idem,
    )
    this.#send(conn, toControlMessage(outcome, String(raw.idem ?? "")))
  }

  // -------------------------------------------------------------------------
  // Fan-out live
  // -------------------------------------------------------------------------

  #ensureLive(sid: string): void {
    if (this.#liveUnsub.has(sid)) return
    const feed = this.#deps.feeds.get(sid)
    if (!feed) return
    const unsub = feed.liveSubscribe((event) => this.#fanout(sid, event))
    this.#liveUnsub.set(sid, unsub)
  }

  #pruneLive(): void {
    // Lepas live untuk sesi yang tak lagi punya konsumen tertarik.
    for (const [sid, unsub] of [...this.#liveUnsub]) {
      const stillWanted = [...this.#conns.values()].some((c) => !c.closed && c.subs.has(sid))
      if (!stillWanted) {
        unsub()
        this.#liveUnsub.delete(sid)
      }
    }
  }

  #fanout(sid: string, event: { eventSeq?: number }): void {
    const seq = numberOr(event.eventSeq, -1)
    if (seq < 0) return
    for (const conn of [...this.#conns.values()]) {
      if (conn.closed) continue
      const sub = conn.subs.get(sid)
      if (!sub || sub.closed) continue
      // Event yang sudah tercakup replay = duplikat; lewati.
      if (seq <= sub.cursor) continue
      if (!sub.enqueue({ seq, provenance: "LIVE", event })) {
        this.#deps.telemetry.inc("events.dropped.overflow")
        sub.close()
        this.#halt(conn, "QUEUE_OVERFLOW")
        return
      }
      this.#pump(conn)
    }
  }

  /** Dorong isi antrean live ke socket; berhenti bila socket menahan tulisan. */
  #pump(conn: Conn): void {
    if (conn.closed || conn.paused) return
    for (const [, sub] of conn.subs) {
      for (;;) {
        if (conn.closed || conn.paused) return
        const item = sub.takeFirst()
        if (!item) break
        if (item.provenance !== "LIVE") continue
        // Sudah terkirim lewat replay: mengirim ulang membuat konsumen melihat
        // dua event identik dengan seq sama.
        if (item.seq <= sub.cursor) continue
        const sent = this.#send(conn, {
          t: "event",
          sid: sub.sid,
          consumer: conn.consumerId ?? "",
          seq: item.seq,
          provenance: item.provenance,
          event: item.event,
        })
        if (!sent) return
        sub.cursor = item.seq
        this.#deps.telemetry.inc("events.delivered")
      }
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast + shutdown
  // -------------------------------------------------------------------------

  /** Usulan persetujuan -> konsumen ber-cakupan approve. */
  broadcastApproval(view: ApprovalView): number {
    let n = 0
    for (const conn of [...this.#conns.values()]) {
      if (conn.closed || !conn.scopes.includes("approve")) continue
      if (this.#send(conn, { t: "approval", consumer: conn.consumerId ?? "", approval: view })) n++
    }
    return n
  }

  /** Beri tahu SEMUA konsumen bahwa daemon berhenti. */
  broadcastHalt(reason: HaltReason): number {
    let n = 0
    for (const conn of [...this.#conns.values()]) {
      if (this.#send(conn, { t: "halt", reason })) n++
    }
    return n
  }

  async close(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    this.broadcastHalt("SHUTTING_DOWN")
    for (const unsub of this.#liveUnsub.values()) unsub()
    this.#liveUnsub.clear()
    this.#subs.clear()
    for (const conn of [...this.#conns.values()]) this.#teardown(conn)
    const server = this.#server
    this.#server = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Koneksi yang menolak menutup diri tidak boleh menahan shutdown.
      setTimeout(() => resolve(), 500).unref?.()
    })
  }

  get startedAt(): number {
    return this.#startedAt
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}
