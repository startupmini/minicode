// P2.12 — kontrak wire antara konsumen Desktop dan daemon host.
//
// Kenapa dipisah dari implementasi: nomor protokol, kode penolakan, dan kelas
// cakupan adalah FROZEN CONTRACT. Menempelkannya di server/framing membuat
// refactor internal berisiko menggeser nilai yang justru diuji silang proses
// (daemon lama × konsumen baru). Di sini hanya tipe + konstanta — tanpa I/O.

/** Nomor protokol. Naik = breaking; konsumen lama wajib ditolak tegas. */
export const DAEMON_PROTOCOL = 1

/** Batas satu frame: jejak / payload snapshot tak boleh menahan memori daemon. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** Antrean per-koneksi sebelum melanggar aturan "tak ada memori tak terbatas". */
export const MAX_QUEUE_PER_CONN = 512

/** Kelas cakupan capability — bukan role global, selalu daftar sempit. */
export type DaemonScope =
  | "subscribe" // terima snapshot + event live (baca saja)
  | "read:session" // tanya frontiers/status sesi
  | "control:session" // opsi kontrol sesi (interrupt, dll.)
  | "approve" // keputusan persetujuan durable
  | "admin" // shutdown daemon, minta daftar sesi

export const DAEMON_SCOPES: readonly DaemonScope[] = [
  "subscribe",
  "read:session",
  "control:session",
  "approve",
  "admin",
] as const

/**
 * Kode penolakan. Setiap penolakan kontrol WAJIB memakai salah satu dari ini
 * agar konsumen bisa membedakan "stale (ulangi dengan lease baru)" dari
 * "terminal (jangan diulang)" — dua hal yang sering tertukar saat daemon restart.
 */
export type RefusalCode =
  | "INVALID_CAPABILITY"
  | "SCOPE_DENIED"
  | "STALE_EPOCH"
  | "STALE_INCARNATION"
  | "LEASE_LOST"
  | "RUN_TERMINAL"
  | "SESSION_MISMATCH"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_UNKNOWN"
  | "APPROVAL_INVALID_STATE"
  | "QUEUE_OVERFLOW"
  | "STORAGE_PRESSURE"
  | "PROTOCOL_ERROR"
  | "NOT_FOUND"
  | "IDEMPOTENT_REPLAY"
  | "SHUTTING_DOWN"
  | "SCOPE_UNSUPPORTED"

/** Alasan konsumen diminta berhenti mengirim pekerjaan baru. */
export type HaltReason =
  | "SHUTTING_DOWN"
  | "STORAGE_PRESSURE"
  | "QUEUE_OVERFLOW"
  | "PROTOCOL_ERROR"
  | "REVOKED"

/** Identitas konsumen — nama/logikal, TIDAK PERNAH PID. */
export interface ConsumerIdentity {
  consumerId: string
  label?: string
}

export type SubscribeFrom =
  /** Hanya event BARU sesudah kepala saat ini — tanpa replay. */
  | "tail"
  /** Lanjut dari offset ack terakhir; bila belum pernah, sama dengan tail. */
  | "resume"
  /** Replay eksplisit mulai seq ini (0 = dari awal), lalu tail. */
  | number

export type ClientMessage =
  | { t: "hello"; protocol: number; cap: string; consumer: string }
  | { t: "subscribe"; sid: string; from: SubscribeFrom; consumer: string }
  | { t: "ack"; sid: string; seq: number; consumer: string }
  | { t: "control"; op: string; idem: string; args: Record<string, unknown>; consumer: string }
  | { t: "ping"; id: string }
  | { t: "goodbye" }

export type ServerMessage =
  | {
      t: "welcome"
      protocol: number
      incarnation: string
      scopes: DaemonScope[]
      consumer: string
    }
  | {
      t: "subscribed"
      sid: string
      consumer: string
      fromSeq: number
      cursor: number
      /**
       * Jumlah baris snapshot yang gagal didekode. WAJIB dilaporkan — bila
       * disembunyikan, konsumen mengira snapshot lengkap padahal ada lubang
       * yang tak pernah bisa ia deteksi sendiri.
       */
      snapshotRejected: number
    }
  | { t: "frontiers"; sid: string; frontiers: SessionFrontiers }
  | { t: "snapshot"; sid: string; consumer: string; snapshot: SessionSnapshot }
  | {
      t: "event"
      sid: string
      consumer: string
      seq: number
      provenance: Provenance
      event: unknown
    }
  | { t: "replay_done"; sid: string; consumer: string; upToSeq: number }
  | { t: "tail_marker"; sid: string; consumer: string; atSeq: number }
  | { t: "ack_ok"; sid: string; consumer: string; seq: number }
  | { t: "approval"; consumer: string; approval: ApprovalView }
  | { t: "control_result"; idem: string; ok: boolean; result?: unknown; refusal?: RefusalBody }
  | { t: "halt"; reason: HaltReason }
  | { t: "pong"; id: string }
  | { t: "error"; code: RefusalCode; message: string }

export interface RefusalBody {
  code: RefusalCode
  message: string
  /** Nilai yang cocok hanya untuk diagnosis — bukan otoritas. */
  detail?: Record<string, string | number | boolean | null>
}

/**
 * Provenance sebuah event di mata konsumen. LIVE = dari penulis sesi sekarang;
 * REPLAY = dibaca dari durable store; RECONSTRUCTED = hasil rebuild presentasi;
 * UNKNOWN = tak dapat dipastikan. Tak boleh pernah diratakan ke satu nilai.
 */
export type Provenance = "LIVE" | "REPLAY" | "RECONSTRUCTED" | "UNKNOWN"

/** Frontier = batas pengetahuan terakhir per toko (bukan kepemilikan). */
export interface SessionFrontiers {
  writerEpoch: number
  presentationHead: number
  messageHead: number
  runId: string | null
  runStatus: string | null
}

/**
 * Snapshot lintas toko. SENGAJA non-atomik (kontrak §): members+head+run
 * diambil dari query terpisah — yang dijanjikan hanyalah angka-angka frontier
 * beserta provenance-nya, bukan satu transaksi serentak.
 */
export interface SessionSnapshot {
  sid: string
  frontiers: SessionFrontiers
  presentation: unknown[]
  provenance: Provenance
  capturedAt: number
}

export type ApprovalState =
  | "requested"
  | "pending"
  | "accepted"
  | "denied"
  | "expired"
  | "cancelled"
  | "UNKNOWN"

export interface ApprovalView {
  approvalId: string
  sid: string
  state: ApprovalState
  tool: string
  summary: string
  createdAt: number
  expiresAt: number | null
  decidedAt: number | null
}

/** Operasi kontrol yang didukung (whitelist eksplisit — tanpa evaluasi dinamis). */
export const CONTROL_OPS = [
  "session.status",
  "session.list",
  "run.interrupt",
  "run.cancel",
  "approval.decide",
  "approval.list",
  "daemon.status",
  "daemon.shutdown",
] as const

export type ControlOp = (typeof CONTROL_OPS)[number]

export function isControlOp(v: string): v is ControlOp {
  return (CONTROL_OPS as readonly string[]).includes(v)
}

/** Cakupan minimum per operasi kontrol — ditolak lebih awal, bukan di tengah. */
export function requiredScope(op: ControlOp): DaemonScope {
  switch (op) {
    case "session.list":
    case "daemon.status":
      return "read:session"
    case "session.status":
    case "run.interrupt":
    case "run.cancel":
      return "control:session"
    case "approval.decide":
    case "approval.list":
      return "approve"
    case "daemon.shutdown":
      return "admin"
  }
}
