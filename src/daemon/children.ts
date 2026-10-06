// P2.12 — pengawas anak (child) milik daemon.
//
// Dua aturan yang dijaga di sini, bukan di pemanggil:
//
//  1. ANAK TIDAK PERNAH DIADOPSI. Bila daemon mati dan hidup lagi, anak yang
//     dulu berjalan bukan miliknya lagi — ia tak tahu apakah anak itu masih
//     hidup, sudah selesai, atau sudah diganti. Mengklaimnya kembali akan
//     membuat dua pihak percaya diri memerintah proses yang sama. Karena itu
//     dibuat. Karena itu tidak ada jalur adopsi: sisa anak dari generasi lama
//     dibiarkan jatuh ke jalur tombstone kanonik yang sudah ada (resume),
//     bukan diadopsi.
//
//  2. PID BUKAN otoritas. PID dicatat untuk manusia membaca log; status
//     kehidupan anak TIDAK PERNAH disimpulkan dari "PID masih ada" (PID bisa
//     didaur ulang). Status resmi anak = `unknown` kecuali daemon yang
//     MENCIPTAKAN anak itu sendiri menerima laporan selesai.

import { sanitizeLabel } from "./sanitize.ts"
import type { Telemetry } from "./telemetry.ts"

export type ChildStatus = "running" | "finished" | "lost"

export interface ChildRecord {
  childId: string
  sid: string
  runId: string | null
  /** Diagnosis manusia saja — tidak pernah dipakai menentukan status. */
  pid: number
  startedAt: number
  endedAt: number | null
  status: ChildStatus
  /** Nonce acak; dipasang daemon ini dan TIDAK pernah diteruskan ke IPC. */
  token: string
}

export interface ChildSupervisorDeps {
  telemetry: Telemetry
  now?: () => number
}

export class ChildSupervisor {
  readonly #children = new Map<string, ChildRecord>()
  readonly #deps: ChildSupervisorDeps

  constructor(deps: ChildSupervisorDeps) {
    this.#deps = deps
  }

  register(init: {
    childId: string
    sid: string
    runId?: string | null
    pid: number
    token: string
  }): ChildRecord {
    const now = this.#deps.now?.() ?? Date.now()
    const rec: ChildRecord = {
      childId: sanitizeLabel(init.childId, 120),
      sid: sanitizeLabel(init.sid, 120),
      runId: init.runId ?? null,
      pid: init.pid,
      startedAt: now,
      endedAt: null,
      status: "running",
      token: init.token,
    }
    this.#children.set(rec.childId, rec)
    this.#deps.telemetry.inc("child.registered")
    return rec
  }

  /** Catat laporan selesai yang datang dari jalur yang menciptakan anak. */
  finish(childId: string): ChildRecord | null {
    const rec = this.#children.get(childId)
    if (!rec) return null
    if (rec.status === "running") {
      rec.status = "finished"
      rec.endedAt = this.#deps.now?.() ?? Date.now()
      this.#deps.telemetry.inc("child.finished")
    }
    return rec
  }

  /**
   * Tandai anak yang kehilangan pelapor. Sengaja BUKAN "lost = mati": kita
   * tidak tahu apakah ia mati atau hanya pelapornya yang hilang. Yang pasti
   * hanyalah: tak ada yang bisa dikonfirmasi lagi.
   */
  markUnknown(childId: string): ChildRecord | null {
    const rec = this.#children.get(childId)
    if (!rec || rec.status !== "running") return null
    rec.status = "lost"
    rec.endedAt = this.#deps.now?.() ?? Date.now()
    return rec
  }

  get(childId: string): ChildRecord | null {
    return this.#children.get(childId) ?? null
  }

  list(sid?: string): ChildRecord[] {
    const all = [...this.#children.values()]
    return sid ? all.filter((c) => c.sid === sid) : all
  }

  /** Anak yang masih diklaim berjalan oleh generasi ini. */
  running(): ChildRecord[] {
    return this.list().filter((c) => c.status === "running")
  }

  /**
   * Tutup pengawasan: semua yang masih `running` menjadi `lost`.
   *
   * Sengaja tidak "finished" dan tidak "failed" — keduanya adalah KLAIM atas
   * hasil. Daemon berhenti tanpa menerima laporan selesai; yang jujur hanya
   * "tak bisa dikonfirmasi".
   */
  shutdown(): number {
    let n = 0
    for (const rec of this.#children.values()) {
      if (rec.status === "running") {
        rec.status = "lost"
        rec.endedAt = this.#deps.now?.() ?? Date.now()
        n++
      }
    }
    return n
  }

  get size(): number {
    return this.#children.size
  }

  clear(): void {
    this.#children.clear()
  }

  /** Laporan ringkas — TIDAK memuat token (token tak pernah keluar modul ini). */
  report(): Array<Omit<ChildRecord, "token">> {
    return this.list().map(({ token: _token, ...rest }) => rest)
  }
}
