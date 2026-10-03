// M9 — Mechanical supervisor: klasifikasi + eskalasi + retry-gated, BUKAN agen.
//
// Kenapa berkas ini ada (P1 ADR-005, M9): kegagalan mekanis (timeout, backend
// mati, orphan, authority loss, crash-loop) sebelumnya ditangani ad-hoc per
// subsystem (provider recovery bounded, scheduler lease, bash killTree) tanpa
// satu tempat yang memisahkan "aksi mekanis" dari "recovery semantik". Modul
// ini adalah tempat itu: ia MEMINTA transisi ke Kernel (satu-satunya penulis),
// mengeksekusi eskalasi backend via interface M5, dan me-reject retry tak aman.
//
// BUKAN: lifecycle authority (Kernel M8), retry provider/tool existing (tak
// disentuh), scheduler executor/bridge (M13), persistence/recovery engine
// (M11/M12), semantic recovery — tool-choice/plan/retry-meaning (Agent/Task),
// live resume, DAG/remote. Aturan yang dikunci (jangan dilonggarkan tanpa ADR):
// - Tak ada direct state mutation: SEMUA perubahan lifecycle via
//   kernel.requestTransition; supervisor hanya request/report/observe.
// - Retry terminology: retry-in-execution (E sama, tanpa efek baru) ≠
//   re-dispatch (E baru + generation + supersedes) ≠ recovery ≠ resume.
// - Default at-most-once: UNKNOWN + non-idempotent = NO auto re-dispatch.
//   Re-dispatch HANYA via predicate formal (authority && budget && deadline &&
//   (not-started || (idempotent && key && verified) || (verifier-confirm))).
// - Intensity bounded: burst dalam window → escalate-stop (tak ada loop abadi).
// - Deadline/budget/authority TAK PERNAH dihidupkan ulang oleh retry.
// - Child failure ≠ parent failure; detached tak kena parent-cancel (M7).
// - Backend dilalui via interface M5 (tanpa spawn/kill langsung di sini).
// - State supervisor in-memory (retry count, intensity window, dedupe); restart
//   loss = normal (rekonstruksi milik M11/M12, bukan store durable di sini).

import { planParentCancellation } from "./child-execution.ts"
import {
  type BackendHandle,
  type BackendWaitResult,
  createHostBackend,
  type ExecutionBackend,
} from "./execution-backend.ts"
import { allocateExecutionId } from "./execution-id.ts"
import {
  type CancelReason,
  type ExecutionKernel,
  type ExecutionTerminalState,
  terminalForCancelReason,
} from "./execution-kernel.ts"

// ── Klasifikasi mekanis (deterministik; prioritas = tie-break terdokumentasi) ──

export type FailureClassification =
  | "timeout"
  | "budget-exceeded"
  | "backend-failure"
  | "backend-noncooperative"
  | "orphan"
  | "authority-lost"
  | "resource-exceeded"
  | "startup-failure"
  | "process-lost"
  | "claim-conflict"

export interface FailureEvidence {
  readonly backendResult?: BackendWaitResult["status"]
  /** Backend melaporkan error eksekusi (bukan status wait; mis. spawn gagal). */
  readonly backendError?: string
  readonly cancelRequestedButAlive?: boolean
  readonly authorityLost?: boolean
  readonly budgetExhausted?: boolean
  readonly timedOut?: boolean
  readonly orphanSuspected?: boolean
  readonly resourceViolated?: boolean
  readonly startupFailed?: boolean
  readonly processLost?: boolean
  readonly claimConflict?: boolean
}

/**
 * Klasifikasi murni. Prioritas (bila multi-evidence): startup-failure >
 * authority-lost > budget > timeout > orphan > resource > claim-conflict >
 * backend-noncooperative > backend-failure > process-lost. Tanpa evidence
 * yang cocok = null (UNKNOWN tetap UNKNOWN — tak ditebak).
 */
export function classifyFailure(evidence: FailureEvidence): FailureClassification | null {
  if (!evidence) return null
  if (evidence.startupFailed) return "startup-failure"
  if (evidence.authorityLost) return "authority-lost"
  if (evidence.budgetExhausted) return "budget-exceeded"
  if (evidence.timedOut) return "timeout"
  if (evidence.orphanSuspected) return "orphan"
  if (evidence.resourceViolated) return "resource-exceeded"
  if (evidence.claimConflict) return "claim-conflict"
  if (evidence.cancelRequestedButAlive) return "backend-noncooperative"
  if (evidence.backendResult === "unknown" || evidence.backendResult === "orphan") return "orphan"
  if (
    evidence.backendError !== undefined ||
    evidence.backendResult === "vanished" ||
    evidence.processLost
  )
    return "backend-failure"
  if (evidence.backendResult === "timeout") return "backend-noncooperative"
  return null
}

// ── Policy + safety predicate (SATU definisi; M12 memakai yang ini) ──

export interface SupervisionPolicy {
  /** Total attempts maksimum termasuk pertama (default 3, konservatif). */
  readonly maxAttempts?: number
  /** Backoff awal ms (default 1000, konservatif; caller-owned sleep). */
  readonly backoffBaseMs?: number
  /** Backoff maksimum ms (default 8000). */
  readonly backoffMaxMs?: number
  /** Window intensitas ms (default 60_000). */
  readonly intensityWindowMs?: number
  /** Maksimum failure dalam window sebelum escalate-stop (default 5). */
  readonly maxIntensity?: number
  /** Bound wait eskalasi ms (default 5000, cermin backend wait). */
  readonly escalationWaitMs?: number
}

export const DEFAULT_SUPERVISION_POLICY: Required<SupervisionPolicy> = {
  maxAttempts: 3,
  backoffBaseMs: 1000,
  backoffMaxMs: 8000,
  intensityWindowMs: 60_000,
  maxIntensity: 5,
  escalationWaitMs: 5000,
}

/** Backoff eksponensial murni (perhitungan saja; sleep milik caller). */
export function nextBackoffMs(failureCount: number, policy: SupervisionPolicy = {}): number {
  const p = { ...DEFAULT_SUPERVISION_POLICY, ...policy }
  if (!Number.isFinite(failureCount) || failureCount < 1) return p.backoffBaseMs
  return Math.min(p.backoffBaseMs * 2 ** (failureCount - 1), p.backoffMaxMs)
}

export interface SupervisedAttempt {
  readonly executionId: string
  readonly attempt: number
  readonly generation: number
  readonly supersedes?: string
}

// Kontrak keselamatan kanonis tunggal (M12 §36): definisi di recovery-safety.ts;
// supervisor hanya konsumen mekanis. Re-export untuk kompatibilitas M9.
import { isRedispatchAllowed, type RedispatchSafety } from "./recovery-safety.ts"

export type { RedispatchSafety }
export { isRedispatchAllowed }

// ── Supervisor coordinator (state in-memory; tanpa durable store) ──

export interface SupervisorMetrics {
  readonly supervisorObserved: number
  readonly supervisorActionRequested: number
  readonly supervisorRetryAttempt: number
  readonly supervisorRedispatch: number
  readonly supervisorBackoff: number
  readonly supervisorEscalation: number
  readonly supervisorOrphan: number
  readonly supervisorAuthorityLoss: number
  readonly supervisorRetrySuppressed: number
}

export interface EscalationResult {
  readonly cancelResult: string
  readonly waitAfterCancel: BackendWaitResult["status"]
  readonly terminated: boolean
  readonly waitAfterTerminate: BackendWaitResult["status"] | null
  readonly boundedMs: number
}

export interface Supervisor {
  classify(evidence: FailureEvidence): FailureClassification | null
  /** Eskalasi cancel→wait→terminate→wait via backend M5 (bounded; tanpa tulis lifecycle). */
  escalate(
    handle: BackendHandle,
    reason: string,
    opts?: { waitMs?: number; backend?: ExecutionBackend },
  ): Promise<EscalationResult>
  /** Minta CANCELLING ke kernel dengan reason (terminal dipetakan mekanis). */
  requestCancel(
    executionId: string,
    reason: CancelReason,
    source?: "supervisor",
  ): { requested: boolean; outcome: string }
  /** Petakan reason → terminal dan minta ke kernel (mapping tabel, bukan judgment). */
  settleCancellation(
    executionId: string,
    reason: CancelReason,
  ): { requested: boolean; outcome: string; terminal: ExecutionTerminalState }
  /** Laporan telat pasca-terminal → ignore-audit (tak pernah overwrite). */
  noteLateReport(executionId: string): { action: "ignored-audit"; state: string | undefined }
  /** Keputusan retry/re-dispatch gated (tak mengeksekusi efek). */
  decideRetry(
    attempt: SupervisedAttempt,
    safety: RedispatchSafety,
    failureCount: number,
  ):
    | { allowed: true; kind: "retry-in-execution" | "redispatch-new-execution" }
    | { allowed: false; reason: string }
  /** Rencanakan re-dispatch: E baru + generation + supersedes (tanpa efek). */
  planRedispatch(attempt: SupervisedAttempt): SupervisedAttempt
  /** Dedup laporan failure ganda (fingerprint per execution). */
  noteFailure(executionId: string, fingerprint: string): { duplicate: boolean }
  /** Intensity check: burst dalam window → escalate-stop. */
  checkIntensity(executionId: string, nowMs?: number): { ok: true } | { ok: false; reason: string }
  /** Orphan: deteksi + eskalasi-rekonsiliasi (tanpa invent completion/failure). */
  markOrphan(
    executionId: string,
    evidence: string,
  ): { executionId: string; action: "escalate-reconcile"; at: number }
  /** Child: attached-live → propagate-request; terminal → noop; detached → hormati scope. */
  planChildCancel(
    children: readonly { executionId: string; terminal: boolean }[],
    detachedIds?: ReadonlySet<string>,
  ): {
    cancelRequested: readonly string[]
    noopTerminal: readonly string[]
    detachedSkipped: readonly string[]
  }
  metrics(): SupervisorMetrics
}

export function createSupervisor(deps: {
  kernel: ExecutionKernel
  backend?: ExecutionBackend
  policy?: SupervisionPolicy
  now?: () => number
}): Supervisor {
  const kernel = deps.kernel
  const defaultBackend = deps.backend ?? createHostBackend()
  const policy = { ...DEFAULT_SUPERVISION_POLICY, ...deps.policy }
  const now = deps.now ?? Date.now
  // In-memory mekanis: boleh hilang saat restart (M11/M12 merekonstruksi).
  const failures = new Map<string, { count: number; windowStart: number; stamps: number[] }>()
  const seenFingerprints = new Map<string, Set<string>>()
  const m = {
    supervisorObserved: 0,
    supervisorActionRequested: 0,
    supervisorRetryAttempt: 0,
    supervisorRedispatch: 0,
    supervisorBackoff: 0,
    supervisorEscalation: 0,
    supervisorOrphan: 0,
    supervisorAuthorityLoss: 0,
    supervisorRetrySuppressed: 0,
  }

  const trackFailure = (executionId: string): void => {
    const t = now()
    let rec = failures.get(executionId)
    if (!rec || t - rec.windowStart >= policy.intensityWindowMs) {
      rec = { count: 0, windowStart: t, stamps: [] }
      failures.set(executionId, rec)
    }
    rec.count++
    rec.stamps.push(t)
  }

  return {
    classify(evidence: FailureEvidence): FailureClassification | null {
      m.supervisorObserved++
      return classifyFailure(evidence)
    },

    async escalate(
      handle: BackendHandle,
      reason: string,
      opts?: { waitMs?: number; backend?: ExecutionBackend },
    ): Promise<EscalationResult> {
      const backend = opts?.backend ?? defaultBackend
      const waitMs = opts?.waitMs ?? policy.escalationWaitMs
      const t0 = now()
      m.supervisorEscalation++
      const cancelRes = backend.cancel(handle, reason)
      const afterCancel = await backend.wait(handle, waitMs)
      if (afterCancel.status === "completed" || afterCancel.status === "proven-dead") {
        return {
          cancelResult: cancelRes.status,
          waitAfterCancel: afterCancel.status,
          terminated: false,
          waitAfterTerminate: null,
          boundedMs: now() - t0,
        }
      }
      const termRes = backend.terminate(handle, reason)
      void termRes
      const afterTerminate = await backend.wait(handle, waitMs)
      return {
        cancelResult: cancelRes.status,
        waitAfterCancel: afterCancel.status,
        terminated: true,
        waitAfterTerminate: afterTerminate.status,
        boundedMs: now() - t0,
      }
    },

    requestCancel(
      executionId: string,
      reason: CancelReason,
      source: "supervisor" = "supervisor",
    ): { requested: boolean; outcome: string } {
      m.supervisorActionRequested++
      const res = kernel.requestTransition({ executionId, to: "CANCELLING", reason, source })
      return {
        requested: res.committed,
        outcome: res.committed ? "cancelling-requested" : res.outcome,
      }
    },

    settleCancellation(
      executionId: string,
      reason: CancelReason,
    ): { requested: boolean; outcome: string; terminal: ExecutionTerminalState } {
      const terminal = terminalForCancelReason(reason)
      m.supervisorActionRequested++
      const res = kernel.requestTransition({
        executionId,
        to: terminal,
        reason,
        source: "supervisor",
      })
      return {
        requested: res.committed,
        outcome: res.committed ? "terminal-requested" : res.outcome,
        terminal,
      }
    },

    noteLateReport(executionId: string): { action: "ignored-audit"; state: string | undefined } {
      const rec = kernel.get(executionId)
      return { action: "ignored-audit", state: rec?.state }
    },

    decideRetry(
      attempt: SupervisedAttempt,
      safety: RedispatchSafety,
      _failureCount: number,
    ):
      | { allowed: true; kind: "retry-in-execution" | "redispatch-new-execution" }
      | { allowed: false; reason: string } {
      void _failureCount
      if (!isRedispatchAllowed(safety)) {
        m.supervisorRetrySuppressed++
        if (!safety.authorityHeld) return { allowed: false, reason: "authority not held" }
        if (safety.budgetRemaining !== null && safety.budgetRemaining <= 0)
          return { allowed: false, reason: "budget exhausted" }
        if (safety.deadlineRemainingMs !== null && safety.deadlineRemainingMs <= 0)
          return { allowed: false, reason: "deadline expired" }
        return { allowed: false, reason: "UNKNOWN non-idempotent effect (at-most-once default)" }
      }
      if (safety.effectDefinitelyNotStarted) {
        m.supervisorRetryAttempt++
        return { allowed: true, kind: "retry-in-execution" }
      }
      if (attempt.attempt + 1 > (policy.maxAttempts ?? DEFAULT_SUPERVISION_POLICY.maxAttempts)) {
        m.supervisorRetrySuppressed++
        return { allowed: false, reason: "max attempts exceeded" }
      }
      m.supervisorRedispatch++
      return { allowed: true, kind: "redispatch-new-execution" }
    },

    planRedispatch(attempt: SupervisedAttempt): SupervisedAttempt {
      // E BARU + generation + supersedes. Tak pernah mutate E lama; tak ada efek.
      return Object.freeze({
        executionId: allocateExecutionId(),
        attempt: attempt.attempt + 1,
        generation: attempt.generation + 1,
        supersedes: attempt.executionId,
      })
    },

    noteFailure(executionId: string, fingerprint: string): { duplicate: boolean } {
      let set = seenFingerprints.get(executionId)
      if (!set) {
        set = new Set()
        seenFingerprints.set(executionId, set)
      }
      if (set.has(fingerprint)) return { duplicate: true }
      set.add(fingerprint)
      trackFailure(executionId)
      return { duplicate: false }
    },

    checkIntensity(
      executionId: string,
      nowMs?: number,
    ): { ok: true } | { ok: false; reason: string } {
      const t = nowMs ?? now()
      const rec = failures.get(executionId)
      if (!rec) return { ok: true }
      const inWindow = rec.stamps.filter((s) => t - s < policy.intensityWindowMs)
      if (inWindow.length > policy.maxIntensity) {
        m.supervisorBackoff++
        return { ok: false, reason: `intensity exceeded (${inWindow.length} in window)` }
      }
      return { ok: true }
    },

    markOrphan(
      executionId: string,
      evidence: string,
    ): { executionId: string; action: "escalate-reconcile"; at: number } {
      m.supervisorOrphan++
      void evidence
      return { executionId, action: "escalate-reconcile", at: now() }
    },

    planChildCancel(
      children: readonly { executionId: string; terminal: boolean }[],
      detachedIds: ReadonlySet<string> = new Set(),
    ): {
      cancelRequested: readonly string[]
      noopTerminal: readonly string[]
      detachedSkipped: readonly string[]
    } {
      // Attached via kontrak M7; detached tak tersentuh parent-cancel (dihormati).
      const attached = children.filter((c) => !detachedIds.has(c.executionId))
      const skipped = children
        .filter((c) => detachedIds.has(c.executionId))
        .map((c) => c.executionId)
      const plan = planParentCancellation(attached)
      return {
        cancelRequested: plan.cancelRequested,
        noopTerminal: plan.noopTerminal,
        detachedSkipped: Object.freeze(skipped),
      }
    },

    metrics(): SupervisorMetrics {
      return { ...m }
    },
  }
}
