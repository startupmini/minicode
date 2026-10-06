// P2.12 — host daemon: siklus hidup, berkas endpoint/lease, dan shutdown
// berurutan.
//
// Kenapa satu tempat mengatur urutan: shutdown yang salah urutan meninggalkan
// sisa yang mahal — konsumen yang mengira masih terhubung, persetujuan yang
// menggantung tanpa jawab, lease basi yang membuat daemon baru terlihat hidup
// padahal sudah mati. Urutan di bawah diekspos sebagai langkah bernomor agar
// bisa DIUJI, bukan cuma dikomentari.

import { randomBytes, randomUUID } from "node:crypto"
import { ApprovalBroker } from "./approvals.ts"
import { mintCapability } from "./capability.ts"
import { ChildSupervisor } from "./children.ts"
import { type ControlActions, IdempotencyStore } from "./control.ts"
import { clearDiscovery, type DaemonEndpoint, writeEndpoint, writeLease } from "./discovery.ts"
import type { DaemonScope } from "./protocol.ts"
import { ResourceMonitor } from "./resource.ts"
import { sanitizeLabel } from "./sanitize.ts"
import { DaemonServer, type FeedRegistry } from "./server.ts"
import { markPendingApprovalsUnknown } from "./store.ts"
import { Telemetry } from "./telemetry.ts"

export type ShutdownStep =
  | "mark-closing"
  | "halt-consumers"
  | "settle-approvals"
  | "stop-monitors"
  | "close-connections"
  | "retire-children"
  | "clear-discovery"

export interface DaemonHostOptions {
  cwd?: string
  host?: string
  /** 0 = port ephemeral (dipilih OS) — dipakai test & starter yang tak tahu port. */
  port?: number
  feeds: FeedRegistry
  actions?: ControlActions | null
  /** Label workspace untuk diagnosis (dibasuh). */
  workspace?: string
  leaseIntervalMs?: number
  /** TTL default capability yang diterbitkan host. */
  capabilityTtlMs?: number
  /**
   * Kanal diagnostik host. Bukan sekadar kenyamanan: test & pengendali
   * non-interaktif harus bisa menangkap pesan tanpa menempel di stderr
   * proses, dan satu kanal artinya tak ada tulis yang lolos dari audit.
   */
  warn?: (msg: string) => void
}

export class DaemonHost {
  readonly incarnation: string
  readonly telemetry = new Telemetry()
  readonly approvals: ApprovalBroker
  readonly children: ChildSupervisor
  readonly idem = new IdempotencyStore()
  readonly server: DaemonServer
  readonly resource: ResourceMonitor

  readonly #secret: Buffer
  readonly #opts: DaemonHostOptions
  readonly #warn: (msg: string) => void
  #leaseTimer: ReturnType<typeof setInterval> | null = null
  #closing = false
  #shutdownSteps: ShutdownStep[] = []
  #endpointPath: string | null = null
  #port = 0

  private constructor(opts: DaemonHostOptions) {
    this.#opts = opts
    this.#warn = opts.warn ?? ((msg) => process.stderr.write(msg + "\n"))
    this.incarnation = `inc_${randomUUID()}`
    // Secret HANYA di memori proses ini. Bila bocor ke berkas, siapa pun yang
    // bisa membaca berkas itu bisa menerbitkan capability admin.
    this.#secret = randomBytes(32)
    this.children = new ChildSupervisor({ telemetry: this.telemetry })
    this.approvals = new ApprovalBroker({
      incarnation: this.incarnation,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      propose: (view) => {
        this.telemetry.inc("approval.requested")
        this.server.broadcastApproval(view)
      },
      warn: (msg) => this.#warn(msg),
    })
    this.server = new DaemonServer({
      incarnation: this.incarnation,
      secret: this.#secret,
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 0,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      feeds: opts.feeds,
      approvals: this.approvals,
      control: {
        actions: opts.actions ?? null,
        idem: this.idem,
        telemetry: this.telemetry,
        storageOk: () => this.resource.state === "ok",
        shuttingDown: () => this.#closing,
      },
      telemetry: this.telemetry,
    })
    this.resource = new ResourceMonitor({
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      onPressure: (state, snap) => {
        if (state === "storage") {
          this.telemetry.inc("storage.pressure")
          this.#warn(
            `[daemon] tekanan penyimpanan: ${snap.reason ?? "unknown"} — pekerjaan baru ditahan`,
          )
        }
      },
    })
  }

  static async start(opts: DaemonHostOptions): Promise<DaemonHost> {
    const host = new DaemonHost(opts)
    await host.#boot()
    return host
  }

  async #boot(): Promise<void> {
    const { port } = await this.server.start()
    this.#port = port

    const ep: DaemonEndpoint = {
      version: 1,
      port,
      host: this.#opts.host ?? "127.0.0.1",
      incarnation: this.incarnation,
      startedAt: Date.now(),
      workspace: sanitizeLabel(this.#opts.workspace ?? "", 120),
      // Akar kepercayaan untuk klien menerbitkan capability sendiri —
      // lihat komentar panjang di `DaemonEndpoint.bootstrap`.
      bootstrap: this.#secret.toString("base64url"),
    }
    this.#endpointPath = writeEndpoint(ep, this.#opts.cwd)
    this.#beatLease()
    const interval = Math.max(1_000, this.#opts.leaseIntervalMs ?? 5_000)
    this.#leaseTimer = setInterval(() => this.#beatLease(), interval)
    this.#leaseTimer.unref?.()

    // UNKNOWN untuk persetujuan yang menggantung: dilakukan SEBELUM konsumen
    // mana pun boleh melihat — kalau tidak, ada jendela di mana konsumen
    // membaca "pending" yang tak pernah akan dijawab siapa pun.
    const unknown = this.approvalsUnknownOnStart()
    if (unknown > 0) {
      this.#warn(`[daemon] ${unknown} persetujuan tak terjawab dari generasi sebelumnya -> UNKNOWN`)
    }

    this.resource.start()
  }

  /** Transisi persetujuan lama ke UNKNOWN saat start. Jumlah baris berpindah. */
  approvalsUnknownOnStart(): number {
    const n = markPendingApprovalsUnknown(this.incarnation, this.#opts.cwd)
    if (n > 0) this.telemetry.inc("approval.unknown.onRestart", n)
    return n
  }

  #beatLease(): void {
    if (this.#closing) return
    writeLease(
      {
        version: 1,
        incarnation: this.incarnation,
        pid: process.pid,
        updatedAt: Date.now(),
      },
      this.#opts.cwd,
    )
  }

  get port(): number {
    return this.#port
  }

  get closing(): boolean {
    return this.#closing
  }

  get shutdownSteps(): readonly ShutdownStep[] {
    return this.#shutdownSteps
  }

  get endpointPath(): string | null {
    return this.#endpointPath
  }

  /** Terbitkan capability bercakupan untuk konsumen. Secret tak pernah ikut. */
  issueCapability(opts: { scopes: DaemonScope[]; who: string; ttlMs?: number }): string {
    return mintCapability(this.#secret, {
      incarnation: this.incarnation,
      scopes: opts.scopes,
      ttlMs: opts.ttlMs ?? this.#opts.capabilityTtlMs ?? 10 * 60_000,
      who: opts.who,
    })
  }

  /**
   * Shutdown berurutan. Idempoten — dipanggil lagi setelah selesai hanya
   * mengembalikan langkah yang sama, bukan menjalankan ulang.
   *
   * Urutan (dites satu per satu):
   *  1 mark-closing       -> kontrol baru ditolak SHUTTING_DOWN
   *  2 halt-consumers     -> konsumen berhenti mengirim pekerjaan
   *  3 settle-approvals   -> persetujuan menggantung = DENY, tak digantung
   *  4 stop-monitors      -> lease + resource berhenti menulis
   *  5 close-connections  -> socket ditutup
   *  6 retire-children    -> anak yang tak terkonfirmasi -> lost (bukan finished)
   *  7 clear-discovery    -> berkas endpoint/lease milik kita dilepas
   */
  async shutdown(reason: string): Promise<ShutdownStep[]> {
    if (this.#closing) return [...this.#shutdownSteps]
    this.#closing = true
    this.#track("mark-closing")

    this.server.broadcastHalt("SHUTTING_DOWN")
    this.#track("halt-consumers")

    this.approvals.shutdownAll()
    this.#track("settle-approvals")

    if (this.#leaseTimer) clearInterval(this.#leaseTimer)
    this.#leaseTimer = null
    this.resource.stop()
    this.#track("stop-monitors")

    await this.server.close()
    this.#track("close-connections")

    this.children.shutdown()
    this.#track("retire-children")

    clearDiscovery(this.incarnation, this.#opts.cwd)
    this.#track("clear-discovery")

    this.telemetry.inc("shutdown.ordered")
    void reason
    return [...this.#shutdownSteps]
  }

  #track(step: ShutdownStep): void {
    if (!this.#shutdownSteps.includes(step)) this.#shutdownSteps.push(step)
  }
}
