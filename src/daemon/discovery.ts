// P2.12 — penemuan daemon: endpoint + lease kehidupan.
//
// Kenapa file, bukan registry terpusat: daemon adalah milik SATU workspace
// (`<cwd>/.minicode`), sama seperti sesinya. Registry lintas-workspace akan
// membuat sesi proyek A terlihat dari proyek B — kebocoran scope yang tak
// diminta siapa pun.
//
// Dua aturan keras:
//   1. PID BUKAN otoritas. PID dapat didaur ulang oleh OS; mencocokkan PID
//      "masih hidup" = klaim yang bisa salah. PID dicatat untuk diagnosis
//      manusia, TIDAK PERNAH untuk memutuskan.
//   2. Recency BUKAN liveness. File yang masih hangat bisa jadi milik proses
//      yang baru saja crash. Status "alive" hanya boleh datang dari probe
//      koneksi yang berhasil; lease segar hanya menghasilkan "suspect" —
//      ada kandidat, belum terbukti.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { resolveLocalDbPath } from "../lib/db-path.ts"

export const ENDPOINT_FILE = "daemon-endpoint.json"
export const LEASE_FILE = "daemon-lease.json"

/** Lease dianggap basi bila lebih tua dari ini (heartbeat jauh lebih sering). */
export const LEASE_STALE_MS = 15_000

export interface DaemonEndpoint {
  version: 1
  port: number
  host: string
  /** Incarnation daemon — diputar setiap start; kembar = bukan milik kita. */
  incarnation: string
  startedAt: number
  /** Label workspace (dibasuh) — diagnosis, bukan kunci keputusan. */
  workspace: string
  /**
   * AKAR KEPERCAYAAN LOKAL (base64url, 32 byte acak).
   *
   * Daemon tak dapat menunggu "capability" dari klien yang belum terautentikasi
   * — itu lingkaran. Jadi berkas endpoint (0600, di dalam `.minicode/` yang
   * gitignored) menjadi sumber kepercayaan: siapa pun yang bisa membacanya
   * berada di level akses yang sama dengan kepemilikan repo itu sendiri, dan
   * dari situ ia MENERBITKAN capability bercakupan + ber-TTL.
   *
   * Konsekuensi yang disadari: secret ada di disk. Imbalannya: secret tidak
   * pernah lewat IPC, capability yang beredar tetap terbatas cakupan dan
   * waktu, dan restart memutar inkarnasi sehingga capability lama mati.
   */
  bootstrap: string
}

export interface DaemonLease {
  version: 1
  incarnation: string
  /** Diagnosis manusia saja — TIDAK PERNAH jadi dasar keputusan. */
  pid: number
  updatedAt: number
}

export type DiscoveryStatus = "none" | "stale" | "suspect" | "foreign"

export interface DiscoveryResult {
  status: DiscoveryStatus
  endpoint: DaemonEndpoint | null
  lease: DaemonLease | null
  /** Alasan manusia (sanitasi) untuk status non-ok. */
  reason?: string
  endpointPath: string
  leasePath: string
}

function endpointPath(cwd?: string): string {
  return resolveLocalDbPath(ENDPOINT_FILE, cwd)
}

function leasePath(cwd?: string): string {
  return resolveLocalDbPath(LEASE_FILE, cwd)
}

/** Tulis atomik (tmp + rename) supaya pembaca tak pernah melihat file separuh. */
function writeAtomic(path: string, value: unknown, mode = 0o600): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode })
  renameSync(tmp, path)
}

export function writeEndpoint(ep: DaemonEndpoint, cwd?: string): string {
  const p = endpointPath(cwd)
  mkdirSync(resolve(p, ".."), { recursive: true, mode: 0o700 })
  writeAtomic(p, ep, 0o600)
  return p
}

export function readEndpoint(cwd?: string): DaemonEndpoint | null {
  const p = endpointPath(cwd)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as DaemonEndpoint
    if (
      !raw ||
      raw.version !== 1 ||
      typeof raw.port !== "number" ||
      !Number.isInteger(raw.port) ||
      raw.port <= 0 ||
      raw.port > 65535 ||
      typeof raw.incarnation !== "string" ||
      raw.incarnation.length === 0 ||
      typeof raw.bootstrap !== "string" ||
      raw.bootstrap.length < 32
    ) {
      return null
    }
    return { ...raw, host: typeof raw.host === "string" ? raw.host : "127.0.0.1" }
  } catch {
    return null
  }
}

export function writeLease(l: DaemonLease, cwd?: string): string {
  const p = leasePath(cwd)
  mkdirSync(resolve(p, ".."), { recursive: true, mode: 0o700 })
  writeAtomic(p, l, 0o600)
  return p
}

export function readLease(cwd?: string): DaemonLease | null {
  const p = leasePath(cwd)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as DaemonLease
    if (!raw || raw.version !== 1 || typeof raw.incarnation !== "string") return null
    if (typeof raw.updatedAt !== "number") return null
    return { ...raw, pid: typeof raw.pid === "number" ? raw.pid : -1 }
  } catch {
    return null
  }
}

/**
 * Penemuan = kueri turunan (baca endpoint + lease) + penilaian kehidupan.
 *
 * Menghasilkan status, BUKAN boolean "ada/tidak": caller yang memutuskan
 * "hidup" haruslah yang melakukan probe koneksi. Fungsi ini sengaja tak punya
 * akses jaringan agar tidak bisa "membuktikan" kehidupan yang tak ia uji.
 */
export function discover(cwd?: string, now = Date.now()): DiscoveryResult {
  const endpointPathResolved = endpointPath(cwd)
  const leasePathResolved = leasePath(cwd)
  const endpoint = readEndpoint(cwd)
  const lease = readLease(cwd)

  if (!endpoint && !lease) {
    return {
      status: "none",
      endpoint: null,
      lease: null,
      endpointPath: endpointPathResolved,
      leasePath: leasePathResolved,
    }
  }
  if (!endpoint) {
    return {
      status: "stale",
      endpoint: null,
      lease,
      reason: "lease ada tanpa endpoint (daemon mati tak rapi)",
      endpointPath: endpointPathResolved,
      leasePath: leasePathResolved,
    }
  }
  if (!lease) {
    return {
      status: "stale",
      endpoint,
      lease: null,
      reason: "endpoint ada tanpa lease (belum pernah heartbeat)",
      endpointPath: endpointPathResolved,
      leasePath: leasePathResolved,
    }
  }
  // Incarnation beda = file endpoint ditulis daemon lain, lease belum
  // menyusul (atau sebaliknya) — dua "kepala" berbeda = keadaan tak konsisten,
  // bukan daemon yang sehat.
  if (lease.incarnation !== endpoint.incarnation) {
    return {
      status: "foreign",
      endpoint,
      lease,
      reason: "incarnation endpoint != lease",
      endpointPath: endpointPathResolved,
      leasePath: leasePathResolved,
    }
  }
  const age = now - lease.updatedAt
  if (!Number.isFinite(age) || age > LEASE_STALE_MS) {
    return {
      status: "stale",
      endpoint,
      lease,
      reason: `lease ${Math.round(age)}ms > ${LEASE_STALE_MS}ms (segarnya habis)`,
      endpointPath: endpointPathResolved,
      leasePath: leasePathResolved,
    }
  }
  // Segar = kandidat. BUKAN "hidup" — caller wajib probe.
  return {
    status: "suspect",
    endpoint,
    lease,
    endpointPath: endpointPathResolved,
    leasePath: leasePathResolved,
  }
}

/**
 * Hapus endpoint/lease HANYA bila milik incarnation kita.
 *
 * Tanpa penguncian incarnation, daemon yang baru start bisa menghapus berkas
 * milik penggantinya (atau sebaliknya) saat shutdown lambat — yang tersisa
 * adalah daemon hidup tanpa penemuan, terlihat "mati" padahal jalan.
 */
export function clearDiscovery(incarnation: string, cwd?: string): boolean {
  let removed = 0
  for (const p of [endpointPath(cwd), leasePath(cwd)]) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as { incarnation?: string }
      if (raw?.incarnation !== incarnation) continue
      unlinkSync(p)
      removed++
    } catch {
      // File sudah tak ada / tak terbaca — bukan kegagalan yang perlu dilaporkan.
    }
  }
  return removed > 0
}
