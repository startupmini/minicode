// P14 — Adopsi pekerjaan lintas sesi dengan otoritas eksplisit.
//
// Modul ini adalah LAPIS ORKESTRASI, bukan otoritas kedua. Ia hanya:
//
//   1. mengambil lease penulis sesi SUMBER (admission + fence epoch),
//   2. memverifikasi bahwa sesi TUJUAN masih dipegang token pemanggil,
//   3. menyerahkan SATU task unfinished ke TaskStore lewat
//      `transferTaskAuthority` (satu transaksi: baris task + ledger),
//   4. melepas lease sumber, termasuk saat transfer ditolak.
//
// Semua keputusan status/revisi/lineage tetap milik TaskStore. Modul ini tidak
// pernah menyalin task, tidak membuat task baru, tidak menandai selesai, dan
// tidak memicu scheduler. Adopsi yang berhasil hanya berarti "baris task kini
// berada di namespace sesi tujuan dengan bukti transfer"; apakah pekerjaan itu
// aman dilanjutkan tetap diputuskan continuity gate + claim baru.
//
// Kenapa lease sumber diambil lebih dulu, bukan sekadar membaca baris:
// penulis lama yang masih hidup bisa menulis di antara pembacaan dan transfer.
// Lease membuat kita pemilik admission, dan takeover epoch di sessions.db
// membuat penulis lama basi secara durable (renew/release-nya gagal).

import { sanitizeSessionPart } from "../lib/session-id.ts"
import { isTaskId, type Task } from "../task/model.ts"
import { TaskStore, type TaskTransfer, type TaskTransferOutcome } from "../task/store.ts"
import { acquireSessionWriter, releaseSessionWriter, writerTokenFor } from "./authority.ts"

/** Spesifikasi CLI `--adopt-task <source>/<taskId>`. */
export interface AdoptTaskSpec {
  readonly sourceSessionId: string
  readonly taskId: string
}

/**
 * Parse `<source>/<taskId>`.
 *
 * `lastIndexOf` disengaja: id sesi kanonik tidak mengandung `/`, tetapi input
 * operator bisa saja membawa path-ish prefix. Bagian setelah slash TERAKHIR
 * adalah task id; sisa di kiri adalah id sesi sumber. Task id divalidasi dengan
 * predikat kanonik yang sama dengan TaskStore, jadi bentuk salah tidak pernah
 * sampai ke database.
 */
export function parseAdoptTaskArg(raw: string): AdoptTaskSpec | null {
  const slash = raw.lastIndexOf("/")
  if (slash <= 0 || slash === raw.length - 1) return null
  const sourceRaw = raw.slice(0, slash).trim()
  const taskRaw = raw.slice(slash + 1).trim()
  if (sourceRaw.length === 0 || !isTaskId(taskRaw)) return null
  const sourceSessionId = sanitizeSessionPart(sourceRaw)
  if (sourceSessionId.length === 0) return null
  return { sourceSessionId, taskId: taskRaw }
}

/**
 * Outcome tingkat adopsi = outcome transfer TaskStore + kegagalan admission
 * yang terjadi SEBELUM transfer sempat dipanggil.
 *
 * `TRANSFERRED` sengaja dipetakan ke `ADOPTED`: operator melihat satu kata
 * yang menyatakan hasil akhir, sementara `storeOutcome` tetap tersedia untuk
 * audit/tes.
 */
export type AdoptionOutcome =
  | "ADOPTED"
  | "INVALID_REQUEST"
  | "REFUSED_SOURCE_BUSY"
  | "REFUSED_TARGET_AUTHORITY"
  | Exclude<TaskTransferOutcome, "TRANSFERRED">

export interface AdoptionResult {
  readonly outcome: AdoptionOutcome
  readonly detail: string
  /** Task setelah berpindah (revisi baru), atau null bila tidak ada. */
  readonly task: Task | null
  readonly transfer: TaskTransfer | null
  readonly unresolvedRelations: readonly string[]
  /** Epoch sessions.db sesi sumber setelah admission; null bila tak dicoba. */
  readonly sourceEpoch: number | null
  /** True bila token lama kehilangan lease DAN epoch sumber dinaikkan. */
  readonly fencedFormerOwner: boolean
  readonly sourceIncarnation: number | null
  readonly targetIncarnation: number | null
  readonly expectedRevision: number | null
  /** Outcome mentah TaskStore; null bila transfer tidak pernah dipanggil. */
  readonly storeOutcome: TaskTransferOutcome | null
}

export interface AdoptUnfinishedTaskRequest {
  readonly sourceSessionId: string
  readonly targetSessionId: string
  readonly taskId: string
  /**
   * Token penulis sesi tujuan yang SEDANG memegang lease. Di produksi ini
   * token admission composition root; tidak pernah dicetak oleh modul ini.
   */
  readonly targetOwnerToken: string
  readonly bootId: string
  readonly cwd?: string
  readonly now?: number
  /**
   * Nilai yang diharapkan. Bila absen, modul membacanya SETELAH lease sumber
   * dipegang, lalu TaskStore memeriksanya ulang di dalam transaksi. Override
   * eksplisit dipakai tes untuk membuktikan penolakan stale.
   */
  readonly expectedRevision?: number
  readonly expectedSourceIncarnation?: number
  readonly expectedTargetIncarnation?: number
}

/** Refusal yang boleh ditampilkan sebagai pesan operator, bukan stack trace. */
export class AdoptionRefusedError extends Error {
  readonly code = "P14_ADOPTION_REFUSED"
  readonly result: AdoptionResult
  constructor(result: AdoptionResult) {
    super(`[adopt] ${result.outcome}: ${result.detail}`)
    this.name = "AdoptionRefusedError"
    this.result = result
  }
}

function result(
  outcome: AdoptionOutcome,
  detail: string,
  extra: Partial<AdoptionResult> = {},
): AdoptionResult {
  return {
    outcome,
    detail,
    task: null,
    transfer: null,
    unresolvedRelations: [],
    sourceEpoch: null,
    fencedFormerOwner: false,
    sourceIncarnation: null,
    targetIncarnation: null,
    expectedRevision: null,
    storeOutcome: null,
    ...extra,
  }
}

/**
 * Adopsi satu task unfinished dari sesi sumber ke sesi tujuan.
 *
 * Tidak melempar untuk penolakan yang terklasifikasi — semuanya menjadi
 * `AdoptionResult`. Error penyimpanan yang tak terduga tetap dilempar supaya
 * tidak disamarkan sebagai "ditolak" (yang bisa membuat operator mengira
 * datanya aman padahal IO rusak).
 */
export function adoptUnfinishedTask(req: AdoptUnfinishedTaskRequest): AdoptionResult {
  if (!isTaskId(req.taskId)) {
    return result("INVALID_REQUEST", `not a canonical task id: ${req.taskId}`)
  }
  if (req.sourceSessionId.length === 0 || req.targetSessionId.length === 0) {
    return result("INVALID_REQUEST", "source and target session ids must be non-empty")
  }
  if (req.sourceSessionId === req.targetSessionId) {
    return result("REFUSED_SELF_TRANSFER", "source and target sessions are identical")
  }
  if (req.targetOwnerToken.length === 0 || req.bootId.length === 0) {
    return result("REFUSED_TARGET_AUTHORITY", "target owner token and boot id are required")
  }

  const store = new TaskStore(req.cwd)
  const now = req.now ?? Date.now()
  const sourceToken = writerTokenFor(req.bootId)

  // Langkah 1 — admission sumber. Penulis hidup = REFUSED, bukan takeover
  // paksa. Lease kedaluwarsa = takeover, dan epoch sumber dinaikkan sehingga
  // pemilik lama tidak bisa renew/release/menulis lagi. Kegagalan IO yang tak
  // terklasifikasi dibiarkan melempar: jangan menyamarkannya sebagai "busy".
  const admission = acquireSessionWriter({
    sessionId: req.sourceSessionId,
    cwd: req.cwd,
    bootId: req.bootId,
    token: sourceToken,
    reason: "p14-adopt-task",
    now,
  })
  if (!admission.ok) {
    return result("REFUSED_SOURCE_BUSY", admission.error.message)
  }

  try {
    const sourceIncarnation =
      req.expectedSourceIncarnation ?? store.getSessionIncarnation(req.sourceSessionId)
    const targetIncarnation =
      req.expectedTargetIncarnation ?? store.getSessionIncarnation(req.targetSessionId)

    // Langkah 2 — sesi tujuan harus masih milik token yang memanggil. Ini
    // bukan duplikasi cek TaskStore: refusal di sini terjadi SEBELUM baris
    // disentuh, dan pesannya membedakan "target bukan milikmu" dari
    // "sumber basi".
    if (!store.holdsSessionAuthority(req.targetSessionId, req.targetOwnerToken, now)) {
      return result(
        "REFUSED_TARGET_AUTHORITY",
        `target lease for ${req.targetSessionId} is not held by the calling token`,
        {
          sourceEpoch: admission.admission.epoch,
          fencedFormerOwner: admission.admission.tookOver,
          sourceIncarnation,
          targetIncarnation,
        },
      )
    }

    const current = store.getTask(req.sourceSessionId, req.taskId)
    if (current === null) {
      return result("NOT_FOUND", `no task ${req.taskId} in ${req.sourceSessionId}`, {
        sourceEpoch: admission.admission.epoch,
        fencedFormerOwner: admission.admission.tookOver,
        sourceIncarnation,
        targetIncarnation,
      })
    }

    // Revisi dibaca SETELAH lease dipegang; transfer tetap memeriksanya ulang
    // di dalam transaksi. Ini menutup jendela antara pembacaan dan mutasi.
    const expectedRevision = req.expectedRevision ?? current.revision

    const applied = store.transferTaskAuthority({
      taskId: req.taskId,
      fromSessionId: req.sourceSessionId,
      fromIncarnation: sourceIncarnation,
      toSessionId: req.targetSessionId,
      toIncarnation: targetIncarnation,
      expectedRevision,
      sourceOwnerToken: sourceToken,
      targetOwnerToken: req.targetOwnerToken,
      now,
    })

    return result(applied.outcome === "TRANSFERRED" ? "ADOPTED" : applied.outcome, applied.detail, {
      task: applied.task,
      transfer: applied.transfer,
      unresolvedRelations: applied.unresolvedRelations,
      sourceEpoch: admission.admission.epoch,
      fencedFormerOwner: admission.admission.tookOver,
      sourceIncarnation,
      targetIncarnation,
      expectedRevision,
      storeOutcome: applied.outcome,
    })
  } finally {
    // Langkah 3 — lepas lease sumber SELALU. Bila transfer berhasil, baris
    // task sudah tidak ada di namespace sumber; bila gagal, sesi sumber tetap
    // dapat dipakai operator. Epoch yang sudah dinaikkan tetap menjadi pagar
    // durable terhadap penulis lama.
    releaseSessionWriter(req.sourceSessionId, sourceToken, req.cwd)
  }
}
