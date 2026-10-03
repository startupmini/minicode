// M15 — Production reroute: SATU jalur eksekusi turn, tanpa dual execution.
//
// Kenapa berkas ini ada (P1 M15): sampai M14, Runtime (M8–M14) terpasang rapi
// tapi TIDAK menjadi jalur produksi — `session.run()` dipanggil langsung oleh
// composition root, sub-agen, dan scheduler, sehingga lifecycle turn tidak punya
// authority yang jelas dan tidak pernah masuk jurnal durable M11. M15 tidak
// menulis lifecycle semantics baru: ia MEMINDAHKAN pencatatan lifecycle turn ke
// Kernel yang sudah ada (M8) melalui admission M13, sementaraSI eksekusi fisiknya
// tetap milik lapisan yang sudah terbukti benar (vendor MiniCore + tool executor).
//
// Aturan yang dikunci (jangan dilonggarkan tanpa ADR baru):
// - Mode `owned` = SATU jalur. Legacy `session.run()` dipanggil INSIDE runner
//   yang sama, bukan dua kali. Tidak ada shadow path yang menjalankan efek luar
//   dua kali; kalau admission ditolak, pekerjaan TIDAK dijalankan sama sekali
//   (fail-closed), bukan "jalankan legacy saja".
// - Mode `constructed` = runtime dibangun (journal terbuka, evidence siap) tapi
//   eksekusi tetap legacy. Itu Stage A/B, BUKAN shadow execution: nol efek
//   tambahan, nol eksekusi ganda.
// - Mode `off` = tak ada runtime; jalur legacy persis seperti sebelum M15.
// - Pemetaan hasil (COMPLETED/FAILED/CANCELLED/TIMED_OUT/BUDGET_EXCEEDED) memakai
//   taksonomi yang SUDAH ADA (AgentError.kind). Tidak ada taksonomi baru; error
//   asli selalu dilempar ulang apa adanya sehinggaatribusi error tak berubah.
// - Setiap pekerjaan yang runtime pedati didaftarkan ke `track()` sehingga
//   drain M14 benar-benar menutup eksekusi milik runtime (utang M14 resolved).
// - Tanpa efek samping di modul ini: tidak ada spawn, tidak ada network, tidak
//   ada akses langsung ke TaskStore/scheduler/UI/CLI.

import { AgentError } from "#minicore/core/errors.ts"
import type { RuntimeComposition } from "./composition.ts"
import { dispatchIntentId } from "./composition.ts"
import { createDispatchId, type DispatchRecord } from "./dispatch.ts"
import {
  type CancelReason,
  type ExecutionTerminalState,
  isExecutionTerminalState,
} from "./execution-kernel.ts"

/** Token CLI untuk mode produksi runtime (deterministik per invokasi). */
export const RUNTIME_MODE_FLAG = "--runtime"

/**
 * Tiga tahap, bukan boolean. Alasannya: M14 membuktikan "dapat dibangun" dan M15
 * membuktikan "dapat menjadi pemilik" — dua klaim berbeda, dan mencampurkannya
 * dalam satu flag_boolean membuat rollback dan audit kabur.
 * - `off`         : Stage A — tak ada runtime (default, jalur legacy utuh).
 * - `constructed` : Stage B — runtime + journal dibangun, eksekusi masih legacy.
 * - `owned`       : Stage C/D — admission wajib lewat M13 + Kernel.
 */
export const RUNTIME_MODES = ["off", "constructed", "owned"] as const
export type RuntimeProductionMode = (typeof RUNTIME_MODES)[number]

export interface RuntimeModeResolution {
  readonly mode: RuntimeProductionMode
  /** Pesan untuk operator bila input tak dikenal (fail-closed ke `off`). */
  readonly warning?: string
}

/**
 * Parse mode dari argv. Token tak dikenal / tak lengkap = `off` + warning:
 * gate yang gagal parse tak boleh jatuh ke mode yang lebih agresif.
 */
export function resolveRuntimeMode(argv: readonly string[]): RuntimeModeResolution {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === "--") break
    if (token !== RUNTIME_MODE_FLAG) continue
    const value = argv[i + 1]
    if (value !== undefined && (RUNTIME_MODES as readonly string[]).includes(value))
      return { mode: value as RuntimeProductionMode }
    return {
      mode: "off",
      warning: `invalid ${RUNTIME_MODE_FLAG} value "${value ?? ""}" — expected one of ${RUNTIME_MODES.join(
        "|",
      )}; continuing with ${"off"}`,
    }
  }
  return { mode: "off" }
}

/** Bentuk nilai untuk option composition root (dipakai CLI + test). */
export function runtimeModeFor(value: RuntimeProductionMode | undefined): RuntimeProductionMode {
  return (RUNTIME_MODES as readonly string[]).includes(value ?? "")
    ? (value as RuntimeProductionMode)
    : "off"
}

export interface TurnExecutionRequest {
  readonly kind: "turn" | "task" | "child" | "background"
  /** Siapa yang meminta (scheduler / user-session / delegate …) — provenance. */
  readonly schedulerSource: string
  /** Authority pemanggil atas eksekusi ini (dinyatakan, bukan ditebak). */
  readonly authorityHeld: boolean
  readonly provenance: { requestedBy: string; reason: string }
  readonly taskId?: string
  /**
   * Owner lifecycle eksekusi ini. Default: `taskId` → `provenance.requestedBy`
   * (rantai fallback M13). Dipakai setup.ts untuk turn user (sessionId), supaya
   * "siapa pemilik turn ini" menjawab dari identitas, bukan dari nama sumber.
   */
  readonly ownerId?: string
  readonly parentExecutionId?: string
  readonly lineageRootId?: string
  readonly budget?: number | null
  readonly deadlineAt?: number | null
  readonly attempt?: number
  readonly generation?: number
  /** Dispatch id eksplisit (idempotensi lintas retry pemanggil). */
  readonly dispatchId?: string
}

/**
 * Klasifikasi HASIL ke terminal Kernel memakai taksonomi yang sudah ada.
 *
 * [Stage D decision] `max_steps_exceeded` → `RESOURCE_EXCEEDED` (bukan FAILED,
 * bukan BUDGET_EXCEEDED). Alasannya domain, bukan estetika taksonomi: cap langkah
 * adalah kuota kerja komputasional (resource bound), bukan kegagalan turn dan
 * bukan pagu uang — kernelling sudah punya terminal persis untuk itu dan tiga
 * transisi legalnya (ADMITTED/RUNNING/CANCELLING → RESOURCE_EXCEEDED) menutupi
 * semua keadaan turn saat cap tercapai. Kompatibilitas: keputusan ini hanya
 * memengaruhi record kernel di mode `owned`; jalur legacy tak punya kernel state,
 * dan klasifikasi presentasi (`noteRunSettled`) tak berubah. Reason asli tetap
 * membawa kind vendor (`turn-max-steps-exceeded`) supaya tak ada info hilang.
 */
export function classifyTurnFailure(error: unknown): {
  terminal: ExecutionTerminalState
  reason: string
  /**
   * Cancel-kind M9 untuk dua langkah settle (RUNNING→CANCELLING→terminal).
   * `null` = terminal langsung legal (COMPLETED/FAILED/RESOURCE_EXCEEDED).
   */
  cancelReason: CancelReason | null
} {
  const kind =
    error instanceof AgentError
      ? error.kind
      : typeof (error as { kind?: unknown } | null)?.kind === "string"
        ? String((error as { kind: string }).kind)
        : null
  switch (kind) {
    case "aborted":
      return { terminal: "CANCELLED", reason: "turn-aborted", cancelReason: "user" }
    case "timeout":
      return { terminal: "TIMED_OUT", reason: "turn-timeout", cancelReason: "timeout" }
    case "budget_exceeded":
      return { terminal: "BUDGET_EXCEEDED", reason: "turn-budget-exceeded", cancelReason: "budget" }
    case "max_steps_exceeded":
      return {
        terminal: "RESOURCE_EXCEEDED",
        reason: "turn-max-steps-exceeded",
        cancelReason: null,
      }
    default:
      return {
        terminal: "FAILED",
        reason: `turn-failed${kind ? `:${kind}` : ""}`,
        cancelReason: null,
      }
  }
}

export interface TurnExecutionOutcome<T> {
  /** `legacy` = jalur lama (mode off/constructed); `runtime` = M15 reroute. */
  readonly via: "legacy" | "runtime"
  readonly executionId: string | null
  readonly dispatchId: string
  /** State Kernel terakhir (terminal untuk mode runtime). */
  readonly state: string
  readonly result?: T
}

export interface RuntimeNotAdmittedError extends Error {
  readonly code: "RUNTIME_NOT_OWNED" | "RUNTIME_NOT_ADMITTED"
  readonly dispatch: DispatchRecord | null
}

function notAdmitted(
  code: RuntimeNotAdmittedError["code"],
  message: string,
  dispatch: DispatchRecord | null = null,
): RuntimeNotAdmittedError {
  const err = new Error(message)
  return Object.assign(err, { code, dispatch }) satisfies RuntimeNotAdmittedError
}

// [P1 M16] `isRuntimeNotAdmitted` (type guard) DIHAPUS: nol pemakai di repo ini,
// dan setiap pemanggil dapat memeriksa `error.code` secara langsung. Satu
// predikat yang tak dipakai adalah dua definisi "apa itu RuntimeNotAdmitted"
// menunggu berbeda — lebih murah menghapus sekarang daripada mewariskannya.

export interface ProductionExecutionRunnerMetrics {
  readonly legacyRuns: number
  readonly runtimeRuns: number
  readonly admitted: number
  readonly rejected: number
  /** Bukti dispatch gagal ditulis ke jurnal → dedupe lintas-restart konservatif. */
  readonly intentWriteFailures: number
  readonly terminals: Readonly<Record<string, number>>
}

export interface ProductionExecutionRunner {
  readonly mode: RuntimeProductionMode
  readonly owns: boolean
  /**
   * Jalankan SATU pekerjaan turn. Dalam mode `owned`, pekerjaan WAJIB lolos
   * admission M13 lebih dulu; kalau tidak, kerja TIDAK dijalankan (fail-closed).
   */
  run<T>(
    request: TurnExecutionRequest,
    work: () => Promise<T>,
    opts?: { signal?: AbortSignal },
  ): Promise<TurnExecutionOutcome<T>>
  /**
   * Execution parent yang sedang berjalan di runner ini (kind `turn`).
   * Dipakai untuk lineage child (M7): anak HARUS punya satu parent, bukan
   * Akar sendiri. `null` = tak ada turn parent (mis. Autonomous langsung).
   */
  parentExecutionId(): string | null
  metrics(): ProductionExecutionRunnerMetrics
}

export function createProductionExecutionRunner(deps: {
  readonly mode: RuntimeProductionMode
  /** Null sah untuk mode `off`/`constructed`; WAJIB ada untuk mode `owned`. */
  readonly runtime: RuntimeComposition | null
}): ProductionExecutionRunner {
  const mode = runtimeModeFor(deps.mode)
  const owns = mode === "owned"
  const m = {
    legacyRuns: 0,
    runtimeRuns: 0,
    admitted: 0,
    rejected: 0,
    intentWriteFailures: 0,
    terminals: {} as Record<string, number>,
  }
  const currentParentExecutionId: { value: string | null } = { value: null }
  const countTerminal = (terminal: string) => {
    m.terminals[terminal] = (m.terminals[terminal] ?? 0) + 1
  }

  return {
    mode,
    owns,

    async run<T>(
      request: TurnExecutionRequest,
      work: () => Promise<T>,
      opts?: { signal?: AbortSignal },
    ): Promise<TurnExecutionOutcome<T>> {
      const dispatchId = request.dispatchId ?? createDispatchId()

      if (!owns) {
        // Stage A/B: jalur legacy, tanpa menyentuh runtime. Nol efek tambahan.
        m.legacyRuns++
        const result = await work()
        return { via: "legacy", executionId: null, dispatchId, state: "LEGACY", result }
      }

      const runtime = deps.runtime
      if (!runtime)
        throw notAdmitted(
          "RUNTIME_NOT_OWNED",
          "runtime mode is 'owned' but no Runtime composition is available (fail-closed)",
        )
      if (!runtime.isAdmissionOpen())
        throw notAdmitted(
          "RUNTIME_NOT_OWNED",
          "runtime admission is closed (shutdown in progress) — refusing to execute",
        )

      // Admission: SATU-SATUNYA jalan masuk (M13 → kernel). Dispatch ditolak ⇒
      // TIDAK ADA legacy fallback: dua jalur untuk satu operasi = dual execution.
      //
      // Lineage (M7): anak mewarisi root parent — root korelasi IMMUTABLE, jadi
      // anak tak pernah menjadi akar baru. Owner: eksplisit → pemanggil →
      // provenance (rantai fallback yang sudah ada di M13, bukan aturan baru).
      const parent = request.parentExecutionId
      const lineageRootId = request.lineageRootId ?? parent
      const ownerId = request.ownerId ?? request.taskId ?? request.provenance.requestedBy
      const record = runtime.dispatch({
        dispatchId,
        schedulerSource: request.schedulerSource,
        authorityHeld: request.authorityHeld,
        ownerId,
        ...(request.taskId ? { taskId: request.taskId } : {}),
        ...(parent ? { parentExecutionId: parent } : {}),
        ...(lineageRootId ? { lineageRootId } : {}),
        kind: request.kind,
        ...(request.budget !== undefined ? { budget: request.budget } : {}),
        ...(request.deadlineAt !== undefined ? { deadlineAt: request.deadlineAt } : {}),
        ...(request.attempt !== undefined ? { attempt: request.attempt } : {}),
        ...(request.generation !== undefined ? { generation: request.generation } : {}),
        provenance: request.provenance,
      })
      if (record.state !== "ADMITTED" || !record.executionId) {
        m.rejected++
        throw notAdmitted(
          "RUNTIME_NOT_ADMITTED",
          `dispatch ${dispatchId} not admitted (${record.state}: ${record.reason})`,
          record,
        )
      }
      const executionId = record.executionId
      m.admitted++
      // Parent lineage (M7): turn anak WAJIB menunjuk turn ini sebagai
      // parentExecutionId, bukan menjadi akar sendiri.
      if (request.kind === "turn") currentParentExecutionId.value = executionId

      // Bukti durable: intent dispatch ditulis SETELAH admission sukses dan
      // DITUNGGU, jadi redelivery lintas proses bisa dibuktikan (bukan
      // ditebak). Kegagalan menulis TIDAK membatalkan turn yang sudah admitted:
      // eksekusi tak boleh berhenti karena jurnal — angkanya dicatat supaya
      // operator tahu dedupe lintas-restart menjadi konservatif.
      if (runtime.journal) {
        try {
          const intent = await runtime.journal.noteIntent({
            intentId: dispatchIntentId(dispatchId),
            executionId,
            ...(parent ? { parentExecutionId: parent } : {}),
            lineageRootId: runtime.kernel.get(executionId)?.rootExecutionId ?? executionId,
            executionVersion: runtime.kernel.get(executionId)?.version ?? 0,
            reason: `dispatch-admission:${request.schedulerSource}`,
            source: "host",
          })
          if (intent.status === "error") m.intentWriteFailures++
        } catch {
          m.intentWriteFailures++
        }
      }

      // RUNNING commit: lifecycle authority tetap Kernel (M8).
      const running = runtime.kernel.requestTransition({
        executionId,
        to: "RUNNING",
        reason: "turn-start",
        source: "host",
      })
      if (!running.committed) {
        m.rejected++
        throw notAdmitted(
          "RUNTIME_NOT_ADMITTED",
          `execution ${executionId} refused RUNNING (${running.outcome})`,
          record,
        )
      }

      // track() menutup utang M14: pekerjaan yang masih berjalan saat shutdown
      // HARUS terdaftar, supaya flush jurnal tak mendahului event terakhirnya.
      let untrack: (() => void) | null = null
      let settled: TurnExecutionOutcome<T> | null = null
      try {
        const promise = (async () => {
          try {
            const result = await work()
            countTerminal("COMPLETED")
            const done = runtime.kernel.requestTransition({
              executionId,
              to: "COMPLETED",
              reason: "turn-complete",
              source: "host",
            })
            settled = {
              via: "runtime",
              executionId,
              dispatchId,
              state: done.committed ? "COMPLETED" : String(done.outcome),
              result,
            }
            return result
          } catch (error) {
            const { terminal, reason, cancelReason } = classifyTurnFailure(error)
            countTerminal(terminal)
            // Cancel-family MENUNTUT dua langkah M8 (RUNNING→CANCELLING→terminal):
            // commit langsung RUNNING→TIMED_OUT/CANCELLED adalah ilegal dan akan
            // ditolak kernel. Mekaniknya milik Supervisor (M9) — requestCancel
            // lalu settleCancellation dengan tabel pemetaan yang SAMA, jadi tak
            // ada mapping kedua di sini.
            let finalState: string
            if (cancelReason) {
              const cancel = runtime.supervisor.requestCancel(executionId, cancelReason)
              if (cancel.requested) {
                const done = runtime.supervisor.settleCancellation(executionId, cancelReason)
                finalState = done.requested
                  ? done.terminal
                  : String(runtime.kernel.get(executionId)?.state ?? terminal)
              } else {
                // Sudah terminal lewat jalur lain (race jujur): baca state aktual.
                finalState = String(runtime.kernel.get(executionId)?.state ?? terminal)
              }
            } else {
              const direct = runtime.kernel.requestTransition({
                executionId,
                to: terminal,
                reason,
                source: "host",
                ...(opts?.signal?.aborted
                  ? {
                      causality:
                        opts.signal.reason instanceof Error ? opts.signal.reason.name : undefined,
                    }
                  : {}),
              })
              finalState = direct.committed
                ? terminal
                : String(runtime.kernel.get(executionId)?.state ?? terminal)
            }
            settled = {
              via: "runtime",
              executionId,
              dispatchId,
              state: finalState,
            }
            // Error asli diteruskan apa adanya (atribusi error tak berubah).
            throw error
          }
        })()
        untrack = runtime.track(executionId, promise)
        m.runtimeRuns++
        const result = await promise
        return settled ?? { via: "runtime", executionId, dispatchId, state: "COMPLETED", result }
      } finally {
        untrack?.()
        // Bila promise ditolak di luar jalur `work` (mis. track/append gagal),
        // eksekusi TIDAK boleh terminal palsu: biarkan non-terminal dan
        // biarkan M12 yang menafsirkan dari bukti durable.
        if (settled === null && !runtime.isClosed()) {
          const state = runtime.kernel.get(executionId)?.state
          if (!isExecutionTerminalState(state)) {
            countTerminal("UNSETTLED")
          }
        }
      }
    },

    parentExecutionId: () => currentParentExecutionId.value,

    metrics: () => ({
      legacyRuns: m.legacyRuns,
      runtimeRuns: m.runtimeRuns,
      admitted: m.admitted,
      rejected: m.rejected,
      intentWriteFailures: m.intentWriteFailures,
      terminals: Object.freeze({ ...m.terminals }),
    }),
  }
}

/**
 * Pemeriksaan startup untuk runtime yang punya jurnal (M15 §19): validasi
 * integritas + tafsir M12 untuk eksekusi yang berakhir non-terminal.
 *
 * Sengaja TIDAK mendispatch apa pun: M12 hanya merencanakan, dan redispatch tetap
 * tunduk pada authority/budget/deadline/idempotensi. Fungsi ini jadi bukti,
 * bukan aksi.
 */
export interface StartupRecoveryReport {
  readonly integrity: { checked: number; mismatched: readonly number[] }
  readonly frontier: number
  readonly recoverable: readonly {
    readonly executionId: string
    readonly lastState: string
    readonly interpretation: string
    readonly nextAction: string
    readonly requiresVerifier: boolean
    readonly redispatchPlan: unknown
  }[]
  readonly corrupt: boolean
}

export function inspectStartupRecovery(
  runtime: RuntimeComposition,
  ctx: {
    readonly authorityHeld?: boolean
    readonly budgetRemaining?: number | null
    readonly deadlineRemainingMs?: number | null
  } = {},
): StartupRecoveryReport {
  const journal = runtime.journal
  if (!journal)
    return {
      integrity: { checked: 0, mismatched: [] },
      frontier: 0,
      recoverable: [],
      corrupt: false,
    }
  const integrity = journal.integrityCheck()
  const records = journal.readAll()
  const frontier = records.reduce((max, r) => Math.max(max, r.journalSequence), 0)
  const byExecution = new Map<string, string>()
  for (const record of records) {
    if (record.kind !== "event") continue
    if (record.state) byExecution.set(record.executionId, record.state)
  }
  const recoverable: {
    executionId: string
    lastState: string
    interpretation: string
    nextAction: string
    requiresVerifier: boolean
    redispatchPlan: unknown
  }[] = []
  for (const [executionId, lastState] of byExecution) {
    if (isExecutionTerminalState(lastState)) continue
    const result = runtime.recover(executionId, {
      authorityHeld: ctx.authorityHeld ?? false,
      budgetRemaining: ctx.budgetRemaining ?? null,
      deadlineRemainingMs: ctx.deadlineRemainingMs ?? null,
      idempotent: true,
      dedupeKeyPresent: false,
      dedupeCheckPass: false,
      verifierAvailable: false,
      journalCorrupt: integrity.mismatched.length > 0,
    })
    recoverable.push({
      executionId,
      lastState,
      interpretation: result.interpretation,
      nextAction: result.nextAction,
      requiresVerifier: result.requiresVerifier,
      redispatchPlan: result.redispatchPlan,
    })
  }
  return {
    integrity,
    frontier,
    recoverable,
    corrupt: integrity.mismatched.length > 0,
  }
}
