// P2.2 — Admission penulis sesi: lease = admission, epoch = pagar mutasi.
//
// Model otoritatif (lihat blueprint v2 §17):
//
//   tasks.db :: authority lease  →  BOLEH mulai menulis? (admission)
//   sessions.db :: writer_epoch  →  TULISAN ini masih sah? (pagar, CAS in-txn)
//
// Cek lease saja tak pernah cukup (TOCTOU lintas-berkas); CAS epoch di dalam
// transaksi sessions.db-lah pagarnya. Modul ini mengorkestrasi keduanya
// TANPA transaksi lintas-berkas (yang ditolak Architecture Gate).
//
// Token penulis = `cli:<bootId>:<pid>`: unik per boot, tak pernah dicetak
// utuh (observability hanya eksistensi/pid/expiry, bukan token).

import { isLeaseActive, newOwnerToken, SESSION_LEASE_MS } from "../task/session-authority.ts"
import { TaskStore } from "../task/store.ts"
import { readWriterEpoch, StaleWriterError, takeoverSessionEpoch } from "./persistence.ts"

export class SessionBusyError extends Error {
  readonly code = "REFUSED_LEASE_HELD"
  readonly sessionId: string
  constructor(sessionId: string, holderPid: number | null, expiresAt: number | null) {
    super(
      `[session] sid=${sessionId} is actively owned by another writer` +
        (holderPid !== null ? ` (pid ${holderPid}` : " (pid unknown") +
        (expiresAt !== null ? `, lease until ${new Date(expiresAt).toISOString()}` : "") +
        ") — refusing second writer (single-writer contract)",
    )
    this.name = "SessionBusyError"
    this.sessionId = sessionId
  }
}

export interface WriterAdmission {
  readonly token: string
  readonly epoch: number
  readonly fresh: boolean
  readonly tookOver: boolean
}

export type AcquireWriterOutcome =
  | { ok: true; admission: WriterAdmission }
  | { ok: false; error: SessionBusyError }

export function writerTokenFor(bootId: string): string {
  return `cli:${bootId}:${process.pid}:${newOwnerToken()}`
}

function holderSummary(
  sessionId: string,
  cwd?: string,
  now = Date.now(),
): { active: boolean; pid: number | null; expiresAt: number | null } {
  try {
    const store = new TaskStore(cwd)
    const row = store.getSessionAuthority(sessionId)
    if (!row) return { active: false, pid: null, expiresAt: null }
    return {
      active: isLeaseActive(row.leaseExpiresAt, now),
      pid: row.ownerPid,
      expiresAt: row.leaseExpiresAt,
    }
  } catch {
    return { active: false, pid: null, expiresAt: null }
  }
}

// Admission + (bila perlu) takeover, lalu baca epoch pasca-takeover.
// Urutan ini penting: epoch dibaca SETELAH bump apa pun, sehingga
// expectedEpoch pemanggil selalu generasi terbaru yang sah.
export function acquireSessionWriter(opts: {
  sessionId: string
  cwd?: string
  bootId: string
  token?: string
  reason?: string
  now?: number
}): AcquireWriterOutcome {
  const { sessionId, cwd, bootId } = opts
  const now = opts.now ?? Date.now()
  const token = opts.token ?? writerTokenFor(bootId)
  const store = new TaskStore(cwd)
  const pre = store.getSessionAuthority(sessionId)
  if (pre && pre.ownerToken !== token && isLeaseActive(pre.leaseExpiresAt, now)) {
    return {
      ok: false,
      error: new SessionBusyError(sessionId, pre.ownerPid, pre.leaseExpiresAt),
    }
  }
  const acquired = store.acquireSessionAuthority(sessionId, token, SESSION_LEASE_MS, now)
  if (acquired === "REFUSED_LEASE_HELD") {
    const holder = holderSummary(sessionId, cwd, now)
    return {
      ok: false,
      error: new SessionBusyError(sessionId, holder.pid, holder.expiresAt),
    }
  }
  // Kita pemegang lease. Takeover (bump epoch) HANYA bila baris lease
  // sebelumnya milik token LAIN (aktif/expired) — akuisisi fresh atau
  // re-acquire token sendiri tak menyentuh epoch (§16).
  let epoch = readWriterEpoch(sessionId, cwd)
  let tookOver = false
  if (pre && pre.ownerToken !== token) {
    const bump = takeoverSessionEpoch(
      sessionId,
      epoch,
      opts.reason ?? "lease-takeover",
      bootId,
      cwd,
    )
    epoch = bump.epoch
    tookOver = bump.outcome === "advanced"
  }
  return { ok: true, admission: { token, epoch, fresh: !pre, tookOver } }
}

export function renewSessionWriter(
  sessionId: string,
  token: string,
  cwd?: string,
  now = Date.now(),
): "AUTHORITY_HELD" | "AUTHORITY_LOST" {
  const store = new TaskStore(cwd)
  return store.renewSessionAuthority(sessionId, token, SESSION_LEASE_MS, now)
}

// Lepas lease, best-effort. Token-guarded di store: hanya pemegang yang bisa
// melepas; penerus tak pernah terusir oleh pendahulu basi. Tak melempar.
export function releaseSessionWriter(sessionId: string, token: string, cwd?: string): boolean {
  try {
    return new TaskStore(cwd).releaseSessionAuthority(sessionId, token)
  } catch {
    return false
  }
}

export function describeSessionHolder(
  sessionId: string,
  cwd?: string,
  now = Date.now(),
): { active: boolean; pid: number | null; expiresAt: number | null } {
  return holderSummary(sessionId, cwd, now)
}

// Pemeriksaan kesegaran pra-turn: epoch masih cocok (CAS akan lolos) DAN
// lease masih milik kita (perpanjangan oportunistik saat aktif). Murni
// observasi + renew; keputusan akhir tetap CAS di transaksi tulis.
export function checkWriterFresh(
  sessionId: string,
  token: string,
  expectedEpoch: number,
  cwd?: string,
  now = Date.now(),
): { fresh: boolean; epoch: number; renewed: boolean } {
  const epoch = readWriterEpoch(sessionId, cwd)
  if (epoch !== expectedEpoch) return { fresh: false, epoch, renewed: false }
  let renewed = false
  try {
    renewed =
      new TaskStore(cwd).renewSessionAuthority(sessionId, token, SESSION_LEASE_MS, now) ===
      "AUTHORITY_HELD"
  } catch {
    renewed = false
  }
  return { fresh: renewed, epoch, renewed }
}

export { StaleWriterError }
