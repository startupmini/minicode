// M13 — Dispatch bridge: validasi/terjemah/teruskan WHAT/WHEN → CAN/HOW.
//
// Kenapa berkas ini ada (P1 M13): scheduler (WHAT/WHEN) dan runtime (CAN/HOW)
// tak boleh saling memanggil langsung — scheduler tak boleh menulis lifecycle,
// runtime tak boleh memutuskan jadwal. Bridge ini adalah batas terjemahan:
// validasi authority/budget/deadline/capability/parent-child, revalidasi plan
// M12, dedupe dispatch-id, teruskan SATU admission request ke AdmissionPort
// (milik Host/Kernel di produksi; fake-diuji di sini). BUKAN scheduler kedua,
// BUKAN execution engine kedua.
//
// BUKAN: lifecycle authority (Kernel), state transition (M8), supervisor
// (M9), recovery interpretation (M12 — hanya konsumsi plan), persistence
// (M11), capability enforcement (M6/M5), agent reasoning, scheduler policy,
// TaskStore claims, timer/queue/worker. Aturan yang dikunci:
// - dispatchId ≠ executionId ≠ taskId (namespace dsp_*; stabil per logical occurrence).
// - Dispatch FSM ≠ Execution FSM (PLANNED/VALIDATING/READY/ADMITTING/ADMITTED +
//   REJECTED/EXPIRED/AUTHORITY_LOST/BLOCKED/FAILED; tanpa COMPLETED).
// - planned ≠ admitted: id dialokasi ≠ eksekusi ada (tanpa ghost execution).
// - Predicate redispatch SATU (recovery-safety, via hasil M12 — tanpa fork).
// - Authority race jujur: snapshot lokal + revalidasi saat admit; tanpa itu
//   TOCTOU dinyatakan (tanpa distributed lock di fase ini).
// - Tanpa import scheduler/TaskStore/SQLite/spawn/UI/CLI; tanpa timer.

import { randomUUID } from "node:crypto"
import {
  type Capability,
  type CapabilityGrant,
  isCapabilitySubset,
  isPathWithin,
} from "./capability.ts"
import { allocateExecutionId } from "./execution-id.ts"
import { createRecoveryEngine, type RedispatchPlan } from "./recovery.ts"

/** Engine M12 untuk isPlanCurrent SAJA (tanpa recoverExecution di sini). */
const planValidator = createRecoveryEngine()

/** Namespace dispatch id (stabil per logical occurrence; BUKAN executionId). */
export const DISPATCH_ID_PREFIX = "dsp_"

export function createDispatchId(): string {
  return `${DISPATCH_ID_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 12)}`
}

export function isDispatchId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 4 &&
    value.length <= 128 &&
    /^dsp_[A-Za-z0-9_-]+$/.test(value)
  )
}

export type DispatchState =
  | "PLANNED"
  | "VALIDATING"
  | "READY"
  | "ADMITTING"
  | "ADMITTED"
  | "REJECTED"
  | "EXPIRED"
  | "AUTHORITY_LOST"
  | "BLOCKED"
  | "FAILED"
  | "STALE"
  | "CAPABILITY_DENIED"
  | "BUDGET_EXCEEDED"
  | "DUPLICATE"
  | "UNCERTAIN_DUPLICATE"

export type DispatchOutcome = DispatchState

export interface DispatchRequest {
  readonly dispatchId: string
  readonly schedulerSource: string
  readonly taskId?: string
  readonly claimRevision?: number
  readonly claimGeneration?: number
  readonly incarnation?: string
  readonly authorityHeld: boolean
  readonly executionId?: string
  readonly intentId?: string
  readonly parentExecutionId?: string
  readonly lineageRootId?: string
  /** Kind eksekusi yang diminta (default "turn" bila absen). */
  readonly kind?: AdmissionRequest["kind"]
  /** Owner lifecycle/resource (fallback: taskId, lalu schedulerSource — eksplisit). */
  readonly ownerId?: string
  readonly priority?: number
  readonly scheduledAt?: number
  readonly deadlineAt?: number | null
  readonly budget?: number | null
  readonly requestedCapabilities?: readonly Capability[]
  readonly parentGrant?: CapabilityGrant
  readonly workspace?: string
  readonly parentWorkspace?: string
  readonly modelRouting?: string
  readonly backendHint?: string
  readonly recoveryPlan?: RedispatchPlan
  readonly attempt?: number
  readonly generation?: number
  readonly supersedes?: string
  readonly parentTerminal?: boolean
  readonly detached?: { ownerId: string; ttlMs: number; killPath: string }
  readonly parentDeadlineRemainingMs?: number | null
  readonly parentBudgetRemainingMs?: number | null
  readonly provenance: { requestedBy: string; reason: string }
  readonly metadata?: Record<string, string>
}

export interface AdmissionRequest {
  readonly executionId: string
  readonly parentExecutionId?: string
  readonly lineageRootId: string
  readonly kind: "turn" | "task" | "child" | "background"
  readonly ownerId: string
  readonly attempt?: number
  readonly generation?: number
  readonly supersedes?: string
  readonly workspace?: string
  readonly backendHint?: string
}

export type AdmissionResult =
  | { readonly admitted: true; readonly executionId: string }
  | { readonly admitted: false; readonly reason: string }

/** Batas admission milik Host/Kernel di produksi; fake-diuji di sini. */
export interface AdmissionPort {
  admit(request: AdmissionRequest): AdmissionResult
}

export interface DispatchRecord {
  readonly dispatchId: string
  readonly state: DispatchState
  readonly schedulerSource: string
  readonly executionId?: string
  readonly taskId?: string
  readonly attempt?: number
  readonly generation?: number
  readonly supersedes?: string
  readonly reason: string
  readonly authorityAtAdmit?: boolean
  readonly duplicateOf?: string
  readonly history: readonly { state: DispatchState; at: number; reason: string }[]
}

export interface DispatchObservation {
  readonly dispatchId: string
  readonly state: DispatchState
  readonly at: number
  readonly executionId?: string
  readonly reason: string
}

export interface DispatchMetrics {
  readonly planned: number
  readonly admitted: number
  readonly rejected: number
  readonly duplicates: number
  readonly stale: number
  readonly entries: number
}

export interface DispatchBridgeDeps {
  readonly admission: AdmissionPort
  /** Status host untuk pre-check (READY sajamelanjutkan; absen = lewati cek). */
  readonly hostState?: () => string
  /** Riwayat durable untuk cross-restart (absen = DUPLICATE_UNCERTAIN jujur). */
  readonly historyLookup?: (dispatchId: string) => "admitted" | "unknown"
  /** Revalidator plan M12 (default: logika validitas bawaan tanpa engine). */
  readonly now?: () => number
  /** Sink observasi opsional (terisolasi; bukan taksonomi M10). */
  readonly onDispatchEvent?: (event: DispatchObservation) => void
}

function isValidDispatchId(value: unknown): value is string {
  return isDispatchId(value)
}

function invalidReason(req: Partial<DispatchRequest>): string | null {
  if (!req || typeof req !== "object") return "malformed request"
  if (!isValidDispatchId(req.dispatchId)) return "malformed dispatchId"
  if (typeof req.schedulerSource !== "string" || req.schedulerSource.length === 0)
    return "malformed schedulerSource"
  if (typeof req.authorityHeld !== "boolean") return "malformed authorityHeld"
  if (
    req.provenance === undefined ||
    typeof req.provenance.requestedBy !== "string" ||
    typeof req.provenance.reason !== "string"
  )
    return "malformed provenance"
  for (const [k, v] of [
    ["priority", req.priority],
    ["attempt", req.attempt],
    ["generation", req.generation],
    ["budget", req.budget],
  ] as const) {
    if (v !== undefined && !Number.isFinite(v as number)) return `malformed ${k}`
  }
  if (req.metadata !== undefined) {
    if (typeof req.metadata !== "object" || req.metadata === null) return "malformed metadata"
    for (const [k, v] of Object.entries(req.metadata)) {
      if (typeof v !== "string" || v.length > 4096) return "malformed metadata value"
      void k
    }
  }
  if (req.workspace !== undefined) {
    if (
      typeof req.workspace !== "string" ||
      req.workspace.length === 0 ||
      req.workspace.includes("\0")
    )
      return "malformed workspace"
  }
  return null
}

function checkPlanFreshness(
  plan: RedispatchPlan,
  now: number,
  ctx: {
    version: number | null
    frontier: number
    authorityHeld: boolean
    budgetRemaining: number | null
    deadlineRemainingMs: number | null
  },
): string | null {
  // Revalidasi via SATU-SATUNYA check M12 (tanpa reinterpretasi evidence di sini).
  // Alasan drift diuraikan lokal hanya untuk diagnostik (bukan predicate kedua).
  const current = {
    version: ctx.version,
    frontier: ctx.frontier,
    authorityHeld: ctx.authorityHeld,
    budgetRemaining: ctx.budgetRemaining,
    deadlineRemainingMs: ctx.deadlineRemainingMs,
  }
  if (planValidator.isPlanCurrent(plan, current)) {
    void now
    return null
  }
  if (ctx.version !== plan.validity.observedExecutionVersion) return "execution version drifted"
  if (ctx.frontier !== plan.validity.journalFrontier) return "journal frontier moved"
  if (!ctx.authorityHeld || ctx.authorityHeld !== plan.validity.authorityHeld)
    return "authority changed"
  if (
    plan.validity.budgetRemaining !== null &&
    (ctx.budgetRemaining === null || ctx.budgetRemaining <= 0)
  )
    return "budget drifted"
  if (
    plan.validity.deadlineRemainingMs !== null &&
    (ctx.deadlineRemainingMs === null || ctx.deadlineRemainingMs <= 0)
  )
    return "deadline drifted"
  return "plan no longer current"
}

export interface DispatchRefresh {
  readonly authorityHeld?: boolean
  readonly version?: number | null
  readonly frontier?: number
  readonly budgetRemaining?: number | null
  readonly deadlineRemainingMs?: number | null
  /** True bila request ini redelivery pasca-restart (bukan intent baru). */
  readonly redelivered?: boolean
}

export interface DispatchBridge {
  dispatch(request: DispatchRequest, refresh?: DispatchRefresh): DispatchRecord
  get(dispatchId: string): DispatchRecord | undefined
  metrics(): DispatchMetrics
}

interface StoredDispatch {
  record: DispatchRecord
}

export function createDispatchBridge(deps: DispatchBridgeDeps): DispatchBridge {
  const store = new Map<string, StoredDispatch>()
  const m = { planned: 0, admitted: 0, rejected: 0, duplicates: 0, stale: 0 }
  const now = deps.now ?? Date.now
  const emit = (record: DispatchRecord): void => {
    try {
      deps.onDispatchEvent?.({
        dispatchId: record.dispatchId,
        state: record.state,
        at: Date.now(),
        ...(record.executionId ? { executionId: record.executionId } : {}),
        reason: record.reason,
      })
    } catch {}
  }
  const save = (
    dispatchId: string,
    partial: Omit<DispatchRecord, "dispatchId" | "history" | "state" | "reason"> & {
      history?: DispatchRecord["history"]
    },
    transition: { state: DispatchState; reason: string },
  ): DispatchRecord => {
    const prev = store.get(dispatchId)
    const entry = { state: transition.state, at: now(), reason: transition.reason }
    const record: DispatchRecord = Object.freeze({
      dispatchId,
      state: transition.state,
      schedulerSource: partial.schedulerSource,
      ...(partial.executionId ? { executionId: partial.executionId } : {}),
      ...(partial.taskId ? { taskId: partial.taskId } : {}),
      ...(partial.attempt !== undefined ? { attempt: partial.attempt } : {}),
      ...(partial.generation !== undefined ? { generation: partial.generation } : {}),
      ...(partial.supersedes ? { supersedes: partial.supersedes } : {}),
      reason: transition.reason,
      history: Object.freeze([...(prev?.record.history ?? []), entry]),
    })
    store.set(dispatchId, { record })
    emit(record)
    return record
  }

  const fail = (
    dispatchId: string,
    base: Omit<DispatchRecord, "dispatchId" | "history" | "state" | "reason"> & { reason?: string },
    state: DispatchState,
    reason: string,
  ): DispatchRecord => {
    m.rejected++
    return save(dispatchId, { ...base, schedulerSource: base.schedulerSource }, { state, reason })
  }

  return {
    dispatch(request: DispatchRequest, refresh?: DispatchRefresh): DispatchRecord {
      const t0 = now()
      void t0
      // 1. Bentuk (malformed ≠ retryable sebagai valid).
      const malformed = invalidReason(request)
      // 2. Dedupe stabil SEBELUM validasi mahal — kecuali malformed.
      const seen = store.get(request.dispatchId)
      if (malformed) {
        // Malformed tetap dicatat (observasi) tanpa execution.
        m.rejected++
        return save(
          request.dispatchId,
          {
            schedulerSource:
              typeof request.schedulerSource === "string" ? request.schedulerSource : "unknown",
          },
          { state: "REJECTED", reason: malformed },
        )
      }
      if (seen) {
        // Idempoten: acknowledgement SAMA tanpa menumbuhkan history tersimpan
        // (tanpa E baru, tanpa mutasi). Stored record tak berubah.
        m.duplicates++
        const dup: DispatchRecord = Object.freeze({
          ...seen.record,
          state: "DUPLICATE" as const,
          duplicateOf: seen.record.state,
          reason: `duplicate of ${seen.record.state}`,
        })
        emit(dup)
        return dup
      }
      // 2b. Redelivery pasca-restart tanpa memori lokal: JANGAN buta buat E2.
      // Cross-restart hanya aman bila bukti durable tersedia; selain itu
      // UNCERTAIN eksplisit yang konservatif (tidak admit, tidak tolak final).
      if (refresh?.redelivered === true) {
        const known = deps.historyLookup ? deps.historyLookup(request.dispatchId) : "unknown"
        if (known === "admitted") {
          m.duplicates++
          const dup: DispatchRecord = Object.freeze({
            dispatchId: request.dispatchId,
            state: "DUPLICATE" as const,
            schedulerSource: request.schedulerSource,
            reason: "duplicate confirmed by durable evidence",
            duplicateOf: "ADMITTED" as const,
            history: Object.freeze([
              {
                state: "DUPLICATE" as const,
                at: now(),
                reason: "duplicate confirmed by durable evidence",
              },
            ]),
          })
          store.set(request.dispatchId, { record: dup })
          emit(dup)
          return dup
        }
        return save(
          request.dispatchId,
          { schedulerSource: request.schedulerSource },
          {
            state: "UNCERTAIN_DUPLICATE",
            reason: "redelivered after restart without durable evidence",
          },
        )
      }
      const base = {
        schedulerSource: request.schedulerSource,
        ...(request.taskId ? { taskId: request.taskId } : {}),
        ...(request.attempt !== undefined ? { attempt: request.attempt } : {}),
        ...(request.generation !== undefined ? { generation: request.generation } : {}),
        ...(request.supersedes ? { supersedes: request.supersedes } : {}),
      }
      // 3. Authority snapshot lokal (TOCTOU jujur: dicek ulang saat admit).
      const authorityNow = refresh?.authorityHeld ?? request.authorityHeld
      if (!request.authorityHeld || !authorityNow) {
        return fail(
          request.dispatchId,
          base,
          "AUTHORITY_LOST",
          "scheduler authority absent at dispatch",
        )
      }
      // 4. Schedule timing: masa lalu-kedaluwarsa vs belum-due (bridge tak menjadwal).
      if (
        request.deadlineAt !== undefined &&
        request.deadlineAt !== null &&
        now() >= request.deadlineAt
      ) {
        return fail(request.dispatchId, base, "EXPIRED", "deadline already passed")
      }
      if (request.scheduledAt !== undefined && request.scheduledAt > now()) {
        return fail(
          request.dispatchId,
          base,
          "REJECTED",
          "not-due (bridge holds no schedule queue)",
        )
      }
      // 5. Budget: tak ada mint, tak ada reset, tak ada double-count di sini.
      if (request.budget !== undefined && request.budget !== null && request.budget <= 0) {
        return fail(request.dispatchId, base, "BLOCKED", "budget exhausted")
      }
      // 6. Capability: subset terhadap parent grant bila keduanya ada (M6 reuse).
      if (request.requestedCapabilities && request.parentGrant) {
        for (const cap of request.requestedCapabilities) {
          const covered = request.parentGrant.capabilities.some((p) => isCapabilitySubset(cap, p))
          if (!covered) {
            return fail(
              request.dispatchId,
              base,
              "CAPABILITY_DENIED",
              "requested capability exceeds parent grant",
            )
          }
        }
      }
      // 7. Workspace: di dalam parent bila keduanya ada (M6 reuse; enforcement milik jail).
      if (request.workspace && request.parentWorkspace) {
        let inside = false
        try {
          inside = isPathWithin(request.parentWorkspace, request.workspace)
        } catch {
          inside = false
        }
        if (!inside)
          return fail(
            request.dispatchId,
            base,
            "CAPABILITY_DENIED",
            "workspace outside parent scope",
          )
      }
      // 8. Parent/child: terminal parent + attached → tolak (detached butuh kontrak penuh).
      if (request.parentExecutionId && request.parentTerminal === true && !request.detached) {
        return fail(
          request.dispatchId,
          base,
          "REJECTED",
          "parent terminal (attached child dispatch rejected)",
        )
      }
      if (request.detached) {
        const d = request.detached
        if (!d.ownerId || !Number.isFinite(d.ttlMs) || d.ttlMs <= 0 || !d.killPath) {
          return fail(request.dispatchId, base, "REJECTED", "detached requires owner+ttl+killPath")
        }
      }
      // 9. Recovery plan: revalidasi TANPA reinterpretasi (M12 punya makna).
      let lineageExecutionId: string | undefined
      let lineage = {
        attempt: request.attempt,
        generation: request.generation,
        supersedes: request.supersedes,
      }
      if (request.recoveryPlan) {
        const plan = request.recoveryPlan
        const stale = checkPlanFreshness(plan, now(), {
          version: refresh?.version ?? null,
          frontier: refresh?.frontier ?? -1,
          authorityHeld: authorityNow,
          budgetRemaining: refresh?.budgetRemaining ?? request.budget ?? null,
          deadlineRemainingMs:
            refresh?.deadlineRemainingMs ??
            (request.deadlineAt != null ? request.deadlineAt - now() : null),
        })
        if (stale) {
          m.stale++
          return fail(request.dispatchId, base, "STALE", `recovery plan stale: ${stale}`)
        }
        lineageExecutionId = plan.newExecutionId
        lineage = {
          attempt: plan.attempt,
          generation: plan.generation,
          supersedes: plan.supersedes,
        }
      }
      // 10. Host pre-check (bila disediakan): hanya READY yang lanjut.
      if (deps.hostState) {
        const hs = deps.hostState()
        if (hs !== "READY") {
          return fail(request.dispatchId, base, "BLOCKED", `host not accepting (${hs})`)
        }
      }
      // 11. Admission via port (SATU-SATUNYA jalan ke runtime). ExecutionId:
      // plan (redispatch lineage) atau mint baru M1 — tak pernah reuse E lama.
      // Owner: eksplisit → taskId → schedulerSource (rantai fallback eksplisit).
      // lineageRoot: request eksplisit → plan (redispatch P13) → E baru.
      // admissionBase TANPA executionId dipakai untuk jalur gagal (planned ≠
      // admitted: id yang tak pernah diadmit tak boleh menempel di record).
      const executionId = lineageExecutionId ?? allocateExecutionId()
      const admissionOwner = request.ownerId ?? request.taskId ?? request.schedulerSource
      const admissionRoot =
        request.lineageRootId ?? request.recoveryPlan?.lineageRootId ?? executionId
      const admissionBase = {
        ...base,
        executionId,
        ...(lineage.attempt !== undefined ? { attempt: lineage.attempt } : {}),
        ...(lineage.generation !== undefined ? { generation: lineage.generation } : {}),
        ...(lineage.supersedes ? { supersedes: lineage.supersedes } : {}),
      }
      m.planned++
      const admitting = save(request.dispatchId, admissionBase, {
        state: "ADMITTING",
        reason: "forwarding to admission port",
      })
      void admitting
      let admitted: AdmissionResult
      try {
        admitted = deps.admission.admit({
          executionId,
          ...(request.parentExecutionId ? { parentExecutionId: request.parentExecutionId } : {}),
          lineageRootId: admissionRoot,
          kind: request.kind ?? "turn",
          ownerId: admissionOwner,
          ...(lineage.attempt !== undefined ? { attempt: lineage.attempt } : {}),
          ...(lineage.generation !== undefined ? { generation: lineage.generation } : {}),
          ...(lineage.supersedes ? { supersedes: lineage.supersedes } : {}),
          ...(request.workspace ? { workspace: request.workspace } : {}),
          ...(request.backendHint ? { backendHint: request.backendHint } : {}),
        })
      } catch (e) {
        return fail(
          request.dispatchId,
          base,
          "FAILED",
          `admission port threw: ${(e as Error).message.slice(0, 120)}`,
        )
      }
      if (!admitted.admitted) {
        const reason = admitted.reason
        const state = /drain|clos|shut/i.test(reason)
          ? "BLOCKED"
          : /author/i.test(reason)
            ? "AUTHORITY_LOST"
            : "BLOCKED"
        return fail(request.dispatchId, base, state as DispatchState, reason)
      }
      m.admitted++
      return save(request.dispatchId, admissionBase, {
        state: "ADMITTED",
        reason: "admitted by runtime boundary",
      })
    },

    get(dispatchId: string): DispatchRecord | undefined {
      return store.get(dispatchId)?.record
    },

    metrics(): DispatchMetrics {
      return {
        planned: m.planned,
        admitted: m.admitted,
        rejected: m.rejected,
        duplicates: m.duplicates,
        stale: m.stale,
        entries: store.size,
      }
    },
  }
}
