// P2.12 — API kontrol: cakupan, idempotensi, dan penolakan stale.
//
// Kenapa satu tempat: sembilan operasi kontrol punya aturan yang sama
// (scope → idempotensi → stale → eksekusi). Menyebar aturan itu ke handler
// masing-masing membuat satu operasi melompati validasi yang operasi lain
// patuhi — dan celah persis di situ yang dicari penyerang lokal.

import { readWriterEpoch } from "../session/persistence.ts"
import type { ApprovalBroker } from "./approvals.ts"
import type { ControlOp, DaemonScope, RefusalBody, RefusalCode, ServerMessage } from "./protocol.ts"
import { isControlOp, requiredScope } from "./protocol.ts"
import { sanitizeLabel } from "./sanitize.ts"
import type { Telemetry } from "./telemetry.ts"

export interface HostedSessionInfo {
  sid: string
  hosted: boolean
  writerEpoch: number
  runId: string | null
  runStatus: string | null
  presentationHead: number
}

/**
 * Aksi yang dilakukan host atas sesi. Dipasang dari composition root (cli/)
 * karena `src/**` non-ui tidak boleh mengimpor `cli/` — dan sebaliknya.
 * Tanpa aksi terpasang, operasi yang butuh aksi menolak (fail-closed), bukan
 * pura-pura berhasil.
 */
export interface ControlActions {
  listSessions(): HostedSessionInfo[]
  sessionStatus(sid: string): HostedSessionInfo | null
  interrupt(
    sid: string,
    runId: string | null,
  ): { ok: true } | { ok: false; code: RefusalCode; message: string }
  cancel(
    sid: string,
    runId: string | null,
  ): { ok: true } | { ok: false; code: RefusalCode; message: string }
  shutdown(reason: string): void
}

export interface ControlDeps {
  incarnation: string
  actions: ControlActions | null
  approvals: ApprovalBroker
  telemetry: Telemetry
  /** false = tekanan penyimpanan; op mutasi ditolak, op baca tetap jalan. */
  storageOk: () => boolean
  shuttingDown: () => boolean
}

export interface ControlRequest {
  consumerId: string
  scopes: readonly DaemonScope[]
  op: string
  idem: string
  args: Record<string, unknown>
}

export type ControlOutcome =
  | { ok: true; result: unknown; replayed: boolean }
  | { ok: false; refusal: RefusalBody }

function refuse(
  code: RefusalCode,
  message: string,
  detail?: RefusalBody["detail"],
): ControlOutcome {
  return { ok: false, refusal: { code, message, ...(detail ? { detail } : {}) } }
}

/**
 * Cache idempotensi. Terbatas ukuran + TTL — idempotensi tak boleh menjadi
 * ingatan yang tumbuh tanpa batas mengikuti jumlah permintaan konsumen.
 *
 * Dua perilaku yang sengaja berbeda:
 *   - kunci sama + payload sama  -> kembalikan hasil ASLI (retry aman)
 *   - kunci sama + payload beda  -> tolak IDEMPOTENT_REPLAY
 * Alasan yang kedua: mengembalikan hasil lama untuk pekerjaan berbeda akan
 * menyembunyikan bug konsumen yang memakai ulang kunci; mengeksekusi ulang
 * berarti pekerjaan terjadi dua kali. Dua-duanya lebih buruk daripada menolak
 * dengan jelas.
 */
export class IdempotencyStore {
  readonly #byKey = new Map<string, { fingerprint: string; outcome: ControlOutcome; at: number }>()
  readonly max: number
  readonly ttlMs: number

  constructor(opts: { max?: number; ttlMs?: number } = {}) {
    this.max = Math.max(1, opts.max ?? 512)
    this.ttlMs = Math.max(1_000, opts.ttlMs ?? 5 * 60_000)
  }

  lookup(key: string, fingerprint: string, now = Date.now()): ControlOutcome | null {
    const hit = this.#byKey.get(key)
    if (!hit) return null
    if (now - hit.at > this.ttlMs) {
      this.#byKey.delete(key)
      return null
    }
    if (hit.fingerprint !== fingerprint)
      return {
        ok: false,
        refusal: {
          code: "IDEMPOTENT_REPLAY",
          message: "kunci idempoten dipakai ulang dengan payload berbeda",
        },
      }
    return hit.outcome
  }

  remember(key: string, fingerprint: string, outcome: ControlOutcome, now = Date.now()): void {
    if (this.#byKey.size >= this.max) {
      // Buang yang tertua (Map mempertahankan urutan sisipan).
      const oldest = this.#byKey.keys().next().value
      if (oldest !== undefined) this.#byKey.delete(oldest)
    }
    this.#byKey.set(key, { fingerprint, outcome, at: now })
  }

  get size(): number {
    return this.#byKey.size
  }

  clear(): void {
    this.#byKey.clear()
  }
}

function fingerprintOf(op: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort()
  const parts = keys.map((k) => k + "=" + stableString(args[k]))
  return op + "|" + parts.join("&")
}

function stableString(v: unknown): string {
  if (v === null || v === undefined) return "null"
  if (typeof v !== "object") return String(v)
  if (Array.isArray(v)) return "[" + v.map(stableString).join(",") + "]"
  const rec = v as Record<string, unknown>
  return (
    "{" +
    Object.keys(rec)
      .sort()
      .map((k) => k + ":" + stableString(rec[k]))
      .join(",") +
    "}"
  )
}

/**
 * Jalankan satu operasi kontrol urut: scope → idempotensi → stale → aksi.
 *
 * Urutan itu penting: mengecek idempotensi SEBELUM scope akan membocorkan
 * "operasi ini pernah dijalankan" kepada konsumen yang tak punya izin
 * menjalankannya.
 */
export function dispatchControl(
  req: ControlRequest,
  deps: ControlDeps,
  idem: IdempotencyStore,
): ControlOutcome {
  const telemetry = deps.telemetry

  if (!isControlOp(req.op)) {
    telemetry.inc("control.refused")
    return refuse("PROTOCOL_ERROR", `operasi tak dikenal: ${sanitizeLabel(req.op, 64)}`)
  }
  const op: ControlOp = req.op
  const need = requiredScope(op)
  if (!req.scopes.includes(need)) {
    telemetry.inc("control.refused")
    return refuse("SCOPE_DENIED", `operasi ${op} membutuhkan cakupan ${need}`, { need })
  }
  if (typeof req.idem !== "string" || req.idem.length === 0 || req.idem.length > 200) {
    telemetry.inc("control.refused")
    return refuse("PROTOCOL_ERROR", "idem wajib berupa string 1..200 karakter")
  }

  const key = req.consumerId + String.fromCharCode(1) + req.idem
  const fp = fingerprintOf(op, req.args)
  const prior = idem.lookup(key, fp)
  if (prior) {
    if (prior.ok) {
      telemetry.inc("idempotent.replay")
      return { ...prior, replayed: true }
    }
    telemetry.inc("control.refused")
    return prior
  }

  const outcome = runOp(op, req, deps)
  // Hanya hasil sukses yang diingat: kegagalan bisa bersifat sementara
  // (tekanan disk, lease lepas) dan wajib bisa dicoba ulang dengan idem sama.
  if (outcome.ok) idem.remember(key, fp, outcome)
  telemetry.inc(outcome.ok ? "control.executed" : "control.refused")
  return outcome
}

function runOp(op: ControlOp, req: ControlRequest, deps: ControlDeps): ControlOutcome {
  const args = req.args
  const sid = typeof args.sid === "string" ? args.sid : ""

  if (
    op === "daemon.status" ||
    op === "daemon.shutdown" ||
    op === "session.list" ||
    op === "approval.list"
  ) {
    if (deps.shuttingDown() && op !== "daemon.status") {
      return refuse("SHUTTING_DOWN", "daemon sedang berhenti")
    }
  }

  switch (op) {
    case "daemon.status": {
      return {
        ok: true,
        result: {
          incarnation: deps.incarnation,
          shuttingDown: deps.shuttingDown(),
          storageOk: deps.storageOk(),
          actions: deps.actions !== null,
        },
        replayed: false,
      }
    }

    case "daemon.shutdown": {
      if (!deps.actions)
        return refuse("PROTOCOL_ERROR", "host tidak terpasang - tak ada yang bisa dihentikan")
      const reason = sanitizeLabel(String(args.reason ?? "control"), 120)
      const actions = deps.actions
      // TUNDAA satu putaran event loop: berhenti secara langsung akan menutup
      // koneksi operator SEBELUM frame control_result sempat terkirim, sehingga
      // pemanggil CLI melihat "socket tertutup" untuk perintah yang sebenarnya
      // berhasil. Keputusan tetap dibuat sekarang; hanya eksekusinya yang nanti.
      setImmediate(() => actions.shutdown(reason))
      return { ok: true, result: { accepted: true, reason }, replayed: false }
    }

    case "session.list": {
      if (!deps.actions) return refuse("PROTOCOL_ERROR", "host tidak terpasang")
      return { ok: true, result: deps.actions.listSessions(), replayed: false }
    }

    case "session.status": {
      if (!sid) return refuse("SESSION_MISMATCH", "args.sid wajib diisi")
      if (!deps.actions) return refuse("PROTOCOL_ERROR", "host tidak terpasang")
      const info = deps.actions.sessionStatus(sid)
      if (!info)
        return refuse("SESSION_MISMATCH", `sesi ${sanitizeLabel(sid, 64)} tidak di-host daemon ini`)
      return { ok: true, result: info, replayed: false }
    }

    case "approval.list": {
      if (!sid) return refuse("SESSION_MISMATCH", "args.sid wajib diisi")
      return { ok: true, result: deps.approvals.list(sid), replayed: false }
    }

    case "approval.decide": {
      const approvalId = typeof args.approvalId === "string" ? args.approvalId : ""
      const decisionRaw = typeof args.decision === "string" ? args.decision : ""
      if (!approvalId) return refuse("SESSION_MISMATCH", "args.approvalId wajib diisi")
      if (decisionRaw !== "accept" && decisionRaw !== "deny") {
        return refuse("PROTOCOL_ERROR", 'args.decision harus "accept" atau "deny"')
      }
      const r = deps.approvals.decide(approvalId, decisionRaw)
      if (!r.ok) return { ok: false, refusal: r.refusal }
      if (sid && r.row.sid !== sid) {
        // Approval milik sesi lain: menolaknya menggagalkan keputusan yang
        // sebenarnya valid, jadi jangan — laporkan kecocokan yang salah saja.
        return refuse("SESSION_MISMATCH", "approval bukan milik sesi yang disebut", {
          actual: r.row.sid,
        })
      }
      deps.telemetry.inc("approval.decided")
      return { ok: true, result: { approvalId, state: r.row.state }, replayed: false }
    }

    case "run.interrupt":
    case "run.cancel": {
      if (!sid) return refuse("SESSION_MISMATCH", "args.sid wajib diisi")
      if (!deps.storageOk())
        return refuse("STORAGE_PRESSURE", "penyimpanan di bawah tekanan — operasi mutasi ditahan")
      if (!deps.actions) return refuse("PROTOCOL_ERROR", "host tidak terpasang")
      const info = deps.actions.sessionStatus(sid)
      if (!info)
        return refuse("SESSION_MISMATCH", `sesi ${sanitizeLabel(sid, 64)} tidak di-host daemon ini`)
      // Pagaran epoch: konsumen yang menyebut epoch harus cocok dengan dunia
      // sekarang. Epoch beda = otoritas penulis telah pindah; perintah dari
      // penampil lama tidak boleh menyentuh sesi yang kini milik penulis lain.
      if (typeof args.expectedEpoch === "number") {
        const actual = readWriterEpoch(sid)
        if (actual !== args.expectedEpoch) {
          return refuse("STALE_EPOCH", "epoch penulis berpindah — perintah basi ditolak", {
            expected: args.expectedEpoch,
            actual,
          })
        }
      }
      const runId = typeof args.runId === "string" ? args.runId : info.runId
      if (!runId) return refuse("RUN_TERMINAL", "tidak ada run aktif untuk diinterupsi")
      if (
        info.runStatus === "COMPLETED" ||
        info.runStatus === "FAILED" ||
        info.runStatus === "INTERRUPTED"
      ) {
        return refuse(
          "RUN_TERMINAL",
          `run ${sanitizeLabel(runId, 64)} sudah ${info.runStatus} — tak bisa diulang`,
        )
      }
      // LEASE_LOST: daemon mem-host sesi ini tetapi penulisnya sudah basi —
      // perintah akan diabaikan oleh sesi yang sudah menyerahkan otoritas.
      if (!info.hosted) {
        return refuse("LEASE_LOST", "sesi bukan milik daemon ini (penulis di proses lain)")
      }
      const res =
        op === "run.interrupt"
          ? deps.actions.interrupt(sid, runId)
          : deps.actions.cancel(sid, runId)
      if (!res.ok) return { ok: false, refusal: { code: res.code, message: res.message } }
      return { ok: true, result: { sid, runId, op }, replayed: false }
    }
  }
  return refuse("PROTOCOL_ERROR", "operasi tak dikenal")
}

/** Susun pesan `control_result` dari hasil dispatch. */
export function toControlMessage(outcome: ControlOutcome, idem: string): ServerMessage {
  if (outcome.ok) return { t: "control_result", idem, ok: true, result: outcome.result }
  return { t: "control_result", idem, ok: false, refusal: outcome.refusal }
}
