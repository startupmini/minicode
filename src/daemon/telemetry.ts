// P2.12 — telemetri daemon.
//
// Kenapa file sendiri dan bukan variabel acak: kontrak menyatakan telemetri
// NON-AUTORITATIF — angka di sini tidak pernah dipakai mengambil keputusan
// (tidak ada "karena counter ini, boleh lanjut"). Memisahkannya membuat
// penjaga bisa MEMERIKSA bahwa tak ada kode keputusan yang membaca counter
// ini, bukan sekadar percaya komentar.

export type CounterName =
  | "connections.opened"
  | "connections.closed"
  | "connections.rejected"
  | "subscribe.attached"
  | "events.delivered"
  | "events.replayed"
  | "events.dropped.overflow"
  | "ack.accepted"
  | "ack.rejected"
  | "control.executed"
  | "control.refused"
  | "idempotent.replay"
  | "approval.requested"
  | "approval.decided"
  | "approval.unknown.onRestart"
  | "storage.pressure"
  | "child.registered"
  | "child.finished"
  | "shutdown.ordered"

const COUNTERS: readonly CounterName[] = [
  "connections.opened",
  "connections.closed",
  "connections.rejected",
  "subscribe.attached",
  "events.delivered",
  "events.replayed",
  "events.dropped.overflow",
  "ack.accepted",
  "ack.rejected",
  "control.executed",
  "control.refused",
  "idempotent.replay",
  "approval.requested",
  "approval.decided",
  "approval.unknown.onRestart",
  "storage.pressure",
  "child.registered",
  "child.finished",
  "shutdown.ordered",
]

export class Telemetry {
  readonly #counts = new Map<CounterName, number>()
  readonly startedAt = Date.now()

  constructor() {
    for (const n of COUNTERS) this.#counts.set(n, 0)
  }

  inc(name: CounterName, by = 1): void {
    // Nama di luar daftar ditolak keras: typo diam-diam menjadi counter yang
    // tak pernah terlihat di snapshot, dan dashboard akan melaporkan nol yang
    // seolah berarti "tidak pernah terjadi".
    if (!this.#counts.has(name)) throw new Error(`telemetry: counter tak dikenal ${name}`)
    this.#counts.set(name, (this.#counts.get(name) ?? 0) + by)
  }

  get(name: CounterName): number {
    return this.#counts.get(name) ?? 0
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = { uptimeMs: Date.now() - this.startedAt }
    for (const [k, v] of [...this.#counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out[k] = v
    return out
  }

  reset(): void {
    for (const n of COUNTERS) this.#counts.set(n, 0)
  }
}
