// P2.12 — pengawas sumber daya: tekanan penyimpanan + pembersihan.
//
// Kenapa tekanan disk masuk ke kontrak, bukan sekadar warning: saat SQLite
// tak bisa menulis, yang terjadi bukan "operasi gagal rapi" — sebagian transaksi
// sudah berjalan dan gagal di tengah. Kontrak menuntut daemon MENGHENTIKAN
// pekerjaan baru saat itu, bukan terus mencoba dan akhirnya mengarang hasil
// yang tampak sukses. Jadi tekanan = gerbang, bukan catatan.

import { statfsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"

/**
 * Sisa ruang minimum agar SQLite WAL + checkpoint tetap bisa bergerak.
 * 64 MiB dipilih dari pengalaman: WAL yang tak bisa di-checkpoint tumbuh tak
 * terbatas lalu mengunci write berikutnya — menunggu sampai 0 berarti sudah
 * terlambat jauh sebelum itu.
 */
export const MIN_FREE_BYTES = 64 * 1024 * 1024

export type StorageCheck =
  | { ok: true; freeBytes: number }
  | { ok: false; freeBytes: number; minFreeBytes: number; reason: string }

/**
 * Cek ruang bebas pada volume tujuan. Gagal membaca = TIDAK ok (fail-closed):
 * kita tidak tahu apakah aman, dan "tidak tahu" tidak boleh diperlakukan
 * sebagai "aman" pada jalur yang menulis durable.
 */
export function checkStorage(target: string, minFreeBytes = MIN_FREE_BYTES): StorageCheck {
  let probe = target
  try {
    // statfsSync menolak path yang bukan direktori; naikkan sampai ketemu.
    // (target bisa berupa berkas DB.)
    let cur = probe
    for (let i = 0; i < 8; i++) {
      const next = dirname(cur)
      if (next === cur) break
      cur = next
    }
    probe = cur
  } catch {
    probe = process.cwd()
  }
  try {
    const st = statfsSync(probe)
    const free = Number(st.bavail) * Number(st.bsize)
    if (!Number.isFinite(free)) {
      return {
        ok: false,
        freeBytes: 0,
        minFreeBytes,
        reason: "statfs mengembalikan nilai tak valid",
      }
    }
    if (free < minFreeBytes) {
      return {
        ok: false,
        freeBytes: free,
        minFreeBytes,
        reason: `sisa ${free}B < minimum ${minFreeBytes}B`,
      }
    }
    return { ok: true, freeBytes: free }
  } catch (e) {
    return {
      ok: false,
      freeBytes: 0,
      minFreeBytes,
      reason: `statfs gagal: ${String((e as Error).message ?? e)}`,
    }
  }
}

export type PressureState = "ok" | "storage"

export interface ResourceSnapshot {
  pressure: PressureState
  freeBytes: number
  rssBytes: number
  checkedAt: number
  reason?: string
}

export interface ResourceMonitorDeps {
  cwd?: string
  minFreeBytes?: number
  intervalMs?: number
  onPressure: (state: PressureState, snap: ResourceSnapshot) => void
}

/**
 * Periodik memeriksa ruang + memori. Perubahan tekanan SAJA yang memicu
 * callback (edge-triggered) supaya shutdown loop tak membanjiri konsumen
 * dengan pesan sama tiap tick.
 */
export class ResourceMonitor {
  readonly #deps: ResourceMonitorDeps
  #timer: ReturnType<typeof setInterval> | null = null
  #state: PressureState = "ok"
  #last: ResourceSnapshot | null = null
  #checks = 0
  #pressureEvents = 0

  constructor(deps: ResourceMonitorDeps) {
    this.#deps = deps
  }

  get state(): PressureState {
    return this.#state
  }

  get last(): ResourceSnapshot | null {
    return this.#last
  }

  get stats(): { checks: number; pressureEvents: number } {
    return { checks: this.#checks, pressureEvents: this.#pressureEvents }
  }

  probe(now = Date.now()): ResourceSnapshot {
    const check = checkStorage(this.#deps.cwd ?? process.cwd(), this.#deps.minFreeBytes)
    const next: PressureState = check.ok ? "ok" : "storage"
    const snap: ResourceSnapshot = {
      pressure: next,
      freeBytes: check.ok ? check.freeBytes : check.freeBytes,
      rssBytes: readRss(),
      checkedAt: now,
      ...(check.ok ? {} : { reason: check.reason }),
    }
    this.#checks++
    this.#last = snap
    if (next !== this.#state) {
      this.#state = next
      if (next === "storage") this.#pressureEvents++
      this.#deps.onPressure(next, snap)
    }
    return snap
  }

  start(): void {
    if (this.#timer) return
    this.probe()
    this.#timer = setInterval(() => this.probe(), Math.max(1_000, this.#deps.intervalMs ?? 30_000))
    // Jangan menahan proses hanya karena monitor hidup.
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }
}

function readRss(): number {
  try {
    return process.memoryUsage().rss
  } catch {
    return -1
  }
}

/** Path default saat tak ada cwd eksplisit — dipakai diagnosa startup. */
export function defaultProbePath(): string {
  try {
    return process.cwd()
  } catch {
    return homedir()
  }
}
