// P2.12 — toko durable daemon: offset konsumen + mesin persetujuan.
//
// Kenapa di sini, bukan di persistence.ts: persistence.ts adalah pemilik
// SKEMA (DDL ada di `open()`), sedangkan kebijakan transisi/monotonisitas adalah
// perilaku daemon. Memisahkan keduanya membuat aturan "apa yang boleh berubah"
// bisa diuji tanpa membuka SQLite, dan DDL tetap satu-satunya di `open()`.

import { openWorkspaceSessionDb } from "../session/persistence.ts"
import type { ApprovalState } from "./protocol.ts"
import { sanitizeLabel } from "./sanitize.ts"

// ---------------------------------------------------------------------------
// Offset konsumen
// ---------------------------------------------------------------------------

/**
 * Baca offset ack terakhir. `-1` = belum pernah ack (konsumen mulai dari
 * awal / tail sesuai permintaannya sendiri, bukan dari sini).
 */
export function readConsumerOffset(consumerId: string, sid: string, cwd?: string): number {
  const db = openWorkspaceSessionDb(cwd)
  try {
    const row = db
      .prepare(
        "SELECT last_acked_seq AS seq FROM consumer_offsets WHERE consumer_id = ? AND session_id = ?",
      )
      .get(consumerId, sid) as { seq: number | null } | null
    return row?.seq ?? -1
  } finally {
    db.close()
  }
}

/**
 * Ack konsumen. MONOTONIK: ack mundur (bawaan koneksi lambat yang tiba
 * setelah ack lebih baru) diabaikan — kalau tidak, seekbolak-ke-depan akan
 * memutar konsumen mundur lalu memainkan ulang event yang sudah diproses.
 * Konsumen yang memang mau mulai ulang memakai `subscribe from=N` secara
 * eksplisit (reset terpisah di bawah), bukan lewat ack terselip.
 *
 * Mengembalikan offset tersimpan setelah tulis.
 */
export function writeConsumerOffset(
  consumerId: string,
  sid: string,
  seq: number,
  cwd?: string,
): number {
  if (!Number.isInteger(seq) || seq < -1) throw new Error("writeConsumerOffset: seq invalid")
  const db = openWorkspaceSessionDb(cwd)
  try {
    const now = Date.now()
    return db.transaction(() => {
      const cur = db
        .prepare(
          "SELECT last_acked_seq AS seq FROM consumer_offsets WHERE consumer_id = ? AND session_id = ?",
        )
        .get(consumerId, sid) as { seq: number | null } | null
      const prev = cur?.seq ?? -1
      const next = Math.max(prev, seq)
      if (cur === null) {
        db.prepare(
          "INSERT INTO consumer_offsets(consumer_id, session_id, last_acked_seq, updated_at) VALUES(?,?,?,?)",
        ).run(consumerId, sid, next, now)
      } else if (next !== prev) {
        db.prepare(
          "UPDATE consumer_offsets SET last_acked_seq = ?, updated_at = ? WHERE consumer_id = ? AND session_id = ?",
        ).run(next, now, consumerId, sid)
      }
      return next
    })()
  } finally {
    db.close()
  }
}

/** Reset eksplisit (konsumen meminta mulai dari awal/tail) — bukan hasil ack. */
export function resetConsumerOffset(consumerId: string, sid: string, to = -1, cwd?: string): void {
  const db = openWorkspaceSessionDb(cwd)
  try {
    db.prepare(
      "UPDATE consumer_offsets SET last_acked_seq = ?, updated_at = ? WHERE consumer_id = ? AND session_id = ?",
    ).run(to, Date.now(), consumerId, sid)
  } finally {
    db.close()
  }
}

export interface ConsumerOffsetRow {
  consumerId: string
  sid: string
  lastAckedSeq: number
  updatedAt: number
}

export function listConsumerOffsets(sid: string, cwd?: string): ConsumerOffsetRow[] {
  const db = openWorkspaceSessionDb(cwd)
  try {
    const rows = db
      .prepare(
        "SELECT consumer_id, session_id, last_acked_seq, updated_at FROM consumer_offsets WHERE session_id = ? ORDER BY consumer_id",
      )
      .all(sid) as {
      consumer_id: string
      session_id: string
      last_acked_seq: number
      updated_at: number
    }[]
    return rows.map((r) => ({
      consumerId: r.consumer_id,
      sid: r.session_id,
      lastAckedSeq: r.last_acked_seq,
      updatedAt: r.updated_at,
    }))
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Persetujuan durable
// ---------------------------------------------------------------------------

export interface ApprovalRow {
  approvalId: string
  sid: string
  runId: string | null
  tool: string
  summary: string
  state: ApprovalState
  requestedAt: number
  expiresAt: number | null
  decidedAt: number | null
  decision: string | null
  incarnation: string
}

/** Transisi yang sah. UNKNOWN = terminal (hasil tak pernah diketahui). */
const ALLOWED: Record<ApprovalState, readonly ApprovalState[]> = {
  requested: ["pending", "accepted", "denied", "expired", "cancelled", "UNKNOWN"],
  pending: ["accepted", "denied", "expired", "cancelled", "UNKNOWN"],
  accepted: [],
  denied: [],
  expired: [],
  cancelled: [],
  UNKNOWN: [],
}

export function canTransition(from: ApprovalState, to: ApprovalState): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

export class ApprovalTransitionError extends Error {
  readonly code = "APPROVAL_INVALID_STATE"
  constructor(
    readonly id: string,
    readonly from: ApprovalState,
    readonly to: ApprovalState,
  ) {
    super(`approval ${id}: ${from} -> ${to} tidak sah`)
    this.name = "ApprovalTransitionError"
  }
}

function toRow(r: Record<string, unknown>): ApprovalRow {
  return {
    approvalId: String(r.approval_id),
    sid: String(r.session_id),
    runId: r.run_id === null || r.run_id === undefined ? null : String(r.run_id),
    tool: String(r.tool),
    summary: String(r.summary ?? ""),
    state: String(r.state) as ApprovalState,
    requestedAt: Number(r.requested_at),
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
    decidedAt: r.decided_at === null || r.decided_at === undefined ? null : Number(r.decided_at),
    decision: r.decision === null || r.decision === undefined ? null : String(r.decision),
    incarnation: String(r.incarnation),
  }
}

export function createApproval(
  row: Omit<ApprovalRow, "state" | "decidedAt" | "decision"> & { state?: ApprovalState },
  cwd?: string,
): ApprovalRow {
  const state: ApprovalState = row.state ?? "requested"
  const db = openWorkspaceSessionDb(cwd)
  try {
    db.prepare(
      `INSERT INTO daemon_approvals
        (approval_id, session_id, run_id, tool, summary, state, requested_at, expires_at, decided_at, decision, incarnation)
       VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?)`,
    ).run(
      row.approvalId,
      row.sid,
      row.runId,
      sanitizeLabel(row.tool, 64),
      sanitizeLabel(row.summary, 500),
      state,
      row.requestedAt,
      row.expiresAt,
      row.incarnation,
    )
    return { ...row, state, decidedAt: null, decision: null }
  } finally {
    db.close()
  }
}

export function getApproval(id: string, cwd?: string): ApprovalRow | null {
  const db = openWorkspaceSessionDb(cwd)
  try {
    const r = db.prepare("SELECT * FROM daemon_approvals WHERE approval_id = ?").get(id) as Record<
      string,
      unknown
    > | null
    return r ? toRow(r) : null
  } finally {
    db.close()
  }
}

export function listApprovals(sid: string, cwd?: string): ApprovalRow[] {
  const db = openWorkspaceSessionDb(cwd)
  try {
    const rows = db
      .prepare("SELECT * FROM daemon_approvals WHERE session_id = ? ORDER BY requested_at DESC")
      .all(sid) as Record<string, unknown>[]
    return rows.map(toRow)
  } finally {
    db.close()
  }
}

/**
 * Pindahkan state. Melempar `ApprovalTransitionError` bila tak sah —
 * kegagalan transisi = bug pemanggil, bukan kondisi dunia, sehingga jangan
 * ditelan diam-diam.
 */
export function transitionApproval(
  id: string,
  to: ApprovalState,
  opts: { decision?: string | null; decidedAt?: number | null },
  cwd?: string,
): ApprovalRow {
  const db = openWorkspaceSessionDb(cwd)
  try {
    return db.transaction(() => {
      const r = db
        .prepare("SELECT * FROM daemon_approvals WHERE approval_id = ?")
        .get(id) as Record<string, unknown> | null
      if (!r) throw new Error(`approval ${id} tidak ditemukan`)
      const cur = toRow(r)
      if (!canTransition(cur.state, to)) throw new ApprovalTransitionError(id, cur.state, to)
      const decidedAt = opts.decidedAt ?? (to === "pending" ? null : Date.now())
      const decision = to === "pending" ? null : (opts.decision ?? null)
      db.prepare(
        "UPDATE daemon_approvals SET state = ?, decided_at = ?, decision = ? WHERE approval_id = ?",
      ).run(to, decidedAt, decision, id)
      return { ...cur, state: to, decidedAt, decision }
    })()
  } finally {
    db.close()
  }
}

/**
 * Ketika daemon START: semua persetujuan yang belum pernah memperoleh
 * keputusan (requested/pending) berpindah ke UNKNOWN.
 *
 * Kenapa UNKNOWN, bukan `denied`: `denied` adalah KEPUTUSAN — mencatat
 * "ditolak" padahal tidak ada siapa pun yang menolak = mengarang hasil.
 * UNKNOWN jujur: tak ada yang bisa melanjutkan keputusan lama setelah
 * prosesnya mati, dan konsumen yang melihatnya harus memperlakukan ulang
 * sebagai pertanyaan baru, bukan jawaban.
 *
 * Mengembalikan jumlah baris yang dipindahkan.
 */
export function markPendingApprovalsUnknown(incarnation: string, cwd?: string): number {
  const db = openWorkspaceSessionDb(cwd)
  try {
    const info = db
      .prepare(
        `UPDATE daemon_approvals
            SET state = 'UNKNOWN', decided_at = ?, decision = 'daemon-restart', incarnation = ?
          WHERE state IN ('requested','pending')`,
      )
      .run(Date.now(), incarnation)
    return Number(info.changes ?? 0)
  } finally {
    db.close()
  }
}

/** Persetujuan yang masih menunggu keputusan (dipakai saat replay attach). */
export function listOpenApprovals(sid: string, cwd?: string): ApprovalRow[] {
  return listApprovals(sid, cwd).filter((a) => a.state === "requested" || a.state === "pending")
}
