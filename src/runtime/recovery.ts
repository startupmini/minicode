// M12 — Recovery & reconciliation: INTERPRETASI bukti durable, BUKAN authority.
//
// Kenapa berkas ini ada (P1 M12): jurnal M11 menyimpan history; seseorang harus
// memutuskan arti history itu (UNKNOWN? aman redispatch? butuh verifier?) TANPA
// menjadi lifecycle authority kedua. Modul ini adalah interpreter itu: membaca
// evidence (via API M11, tanpa SQL langsung), menghasilkan RecoveryResult/
// RecoveryPlan, dan (bila dibenarkan) membangun request Kernel yang divalidasi
// + di-commit Kernel — tak pernah mutasi langsung.
//
// Rantai yang dikunci (jangan dibalik tanpa ADR baru):
//   Journal (evidence) → M12 interpretasi → decision/plan → Kernel request →
//   Kernel validasi + commit. M12 TAK PERNAH menulis state, claim, schedule,
//   journal, atau redispatch aktual (plan ≠ eksekusi).
// - UNKNOWN first-class: bukti kurang = UNKNOWN (bukan FAILED, bukan aman).
// - Predicate redispatch SATU (recovery-safety.ts): M9 konsumen mekanis, M12
//   konsumen semantik — tanpa fork.
// - Terminal Kernel otoritatif: history terminal → NO_RECOVERY_REQUIRED;
//   observasi telat tak pernah menyaingi (dicatat, bukan diputuskan).
// - Idempotensi recovery: incident key = executionId + frontier journal;
//   history sama → hasil SAMA (tanpa rencana ganda); konkuren sync → deterministik.
// - Plan basi: validity snapshot (version/frontier/authority/budget/deadline);
//   berubah = stale (bukan perintah irevokabel).
// - Anak: attached mewarisi interpretasi cancel parent; detached dilestarikan
//   (owner/TTL/kill milik M7); failure anak ≠ terminal parent.
// - BUKAN: replay/rebuild/reconcile-engineredispatch-actual/scheduler-bridge/
//   persistence/timer/worker/queue. Tanpa import SQLite/scheduler/TaskStore/UI/CLI.

import { isTerminalEventType } from "./execution-events.ts"
import { allocateExecutionId } from "./execution-id.ts"
import type { JournalRecord } from "./execution-journal.ts"
import type { TransitionRequest } from "./execution-kernel.ts"
import { hasDedupeProof, isRedispatchAllowed, type RedispatchSafety } from "./recovery-safety.ts"

export type RecoveryInterpretation =
  | "NO_RECOVERY_REQUIRED"
  | "STALE"
  | "RECOVERABLE"
  | "UNKNOWN"
  | "UNCORRELATED"
  | "ORPHAN"
  | "REDISPATCH_SAFE"
  | "REDISPATCH_UNSAFE"
  | "REQUIRES_VERIFIER"
  | "REQUIRES_OPERATOR"
  | "RECOVERY_BLOCKED"
  | "NOT_RECOVERABLE"

export type EvidenceStrength =
  | "AUTHORITATIVE"
  | "DURABLE"
  | "OBSERVED"
  | "REQUESTED"
  | "INFERRED"
  | "UNKNOWN"

export type VerifierResult = "CONFIRMED_EXECUTED" | "CONFIRMED_NOT_EXECUTED" | "UNKNOWN"

/** Penyedia bukti eksternal. Verifier = evidence provider (tak menyentuh kernel). */
export interface Verifier {
  verify(input: { executionId: string }): VerifierResult
}

export type RecoveryNextAction =
  | "NONE"
  | "REQUEST_CANCEL"
  | "AWAIT_EVIDENCE"
  | "REQUEST_VERIFIER"
  | "PLAN_REDISPATCH"
  | "ESCALATE_OPERATOR"

export interface RecoveryProvenance {
  readonly rule: string
  readonly at: number
  readonly journalFrontier: number
  readonly observedExecutionVersion: number | null
}

export interface RedispatchPlan {
  readonly newExecutionId: string
  readonly attempt: number
  readonly generation: number
  readonly supersedes: string
  readonly lineageRootId: string
  readonly parentExecutionId?: string
  readonly validity: {
    readonly observedExecutionVersion: number | null
    readonly journalFrontier: number
    readonly authorityHeld: boolean
    readonly budgetRemaining: number | null
    readonly deadlineRemainingMs: number | null
  }
}

export interface RecoveryResult {
  readonly executionId: string
  readonly interpretation: RecoveryInterpretation
  readonly evidenceStrength: EvidenceStrength
  readonly reasons: readonly string[]
  readonly evidenceRefs: readonly number[]
  readonly nextAction: RecoveryNextAction
  readonly redispatchPlan: RedispatchPlan | null
  readonly requiresVerifier: boolean
  readonly provenance: RecoveryProvenance
}

export interface RecoveryContext {
  readonly authorityHeld: boolean
  readonly budgetRemaining: number | null
  readonly deadlineRemainingMs: number | null
  readonly idempotent: boolean
  readonly dedupeKeyPresent: boolean
  readonly dedupeCheckPass: boolean
  /** Hasil verifier yang SUDAH dijalankan caller (M12 tak menjalankan verifier). */
  readonly verifierResult?: VerifierResult | null
  /** Jalur verifier tersedia (bila ya, UNKNOWN boleh menjadi REQUIRES_VERIFIER). */
  readonly verifierAvailable?: boolean
  /** Bukti konkret efek tak-pernah-mulai (admission-gagal/backend-lapor/gate). */
  readonly notStartedEvidence?:
    | "admission-failed"
    | "backend-reported"
    | "no-intent-with-gate"
    | null
  /** Proses restart diketahui (marker basi) — syarat klasifikasi STALE. */
  readonly processRestarted?: boolean
  /** Ketidakpastian daya tahan dari flush (M11 uncertain). */
  readonly durabilityUncertain?: boolean
  /** Orphan terdeteksi M9 (handle hilang tanpa terminal). */
  readonly orphanSuspected?: boolean
  /** Parent terminal diketahui (attached mewarisi interpretasi cancel). */
  readonly parentTerminal?: boolean
  /** Child detached: parent-terminal TAK mewarisi cancel (kontrak M7). */
  readonly detachedChild?: boolean
  /** Korupsi jurnal dilaporkan M11. */
  readonly journalCorrupt?: boolean
  /** Record warisan tanpa provenance memadai. */
  readonly uncorrelated?: boolean
  /** attempt/generation saat ini (untuk rencana redispatch). */
  readonly attempt?: number
  readonly generation?: number
  readonly parentExecutionId?: string
  readonly lineageRootId?: string
}

// [P1 M16] Tidak ada daftar terminal LOKAL di sini: taksonomi event milik M10
// (`isTerminalEventType`). Salinan kedua pernah hidup di baris ini dan akan
// gagal diam-diam begitu M10 menambah terminal baru.
interface Aggregated {
  hasTerminal: boolean
  terminalTypes: string[]
  hasIntent: boolean
  backendCompleted: boolean
  backendFailed: boolean
  backendObserved: boolean
  maxVersion: number | null
  frontier: number
  refs: number[]
}

function aggregate(records: readonly JournalRecord[]): Aggregated {
  const agg: Aggregated = {
    hasTerminal: false,
    terminalTypes: [],
    hasIntent: false,
    backendCompleted: false,
    backendFailed: false,
    backendObserved: false,
    maxVersion: null,
    frontier: 0,
    refs: [],
  }
  for (const r of records) {
    if (!r || typeof r.journalSequence !== "number") continue
    agg.frontier = Math.max(agg.frontier, r.journalSequence)
    agg.refs.push(r.journalSequence)
    if (r.kind === "intent") {
      agg.hasIntent = true
      continue
    }
    if (r.kind !== "event") continue
    if (isTerminalEventType(r.eventType)) {
      agg.hasTerminal = true
      if (!agg.terminalTypes.includes(r.eventType)) agg.terminalTypes.push(r.eventType)
    }
    if (r.eventType === "backend.observed") {
      agg.backendObserved = true
      if (r.state === "COMPLETED") agg.backendCompleted = true
      if (r.state === "FAILED") agg.backendFailed = true
    }
    if (typeof r.executionVersion === "number") {
      agg.maxVersion =
        agg.maxVersion === null ? r.executionVersion : Math.max(agg.maxVersion, r.executionVersion)
    }
  }
  return agg
}

function buildSafety(ctx: RecoveryContext, notStarted: boolean): RedispatchSafety {
  return {
    authorityHeld: ctx.authorityHeld,
    budgetRemaining: ctx.budgetRemaining,
    deadlineRemainingMs: ctx.deadlineRemainingMs,
    effectDefinitelyNotStarted: notStarted,
    idempotent: ctx.idempotent,
    dedupeKeyPresent: ctx.dedupeKeyPresent,
    dedupeCheckPass: ctx.dedupeCheckPass,
    verifierConfirmedNotExecuted: ctx.verifierResult === "CONFIRMED_NOT_EXECUTED",
    evidenceRecorded: ctx.verifierResult !== undefined && ctx.verifierResult !== null,
  }
}

export interface RecoveryEngine {
  recoverExecution(
    executionId: string,
    records: readonly JournalRecord[],
    ctx: RecoveryContext,
  ): RecoveryResult
  isPlanCurrent(
    plan: RedispatchPlan,
    current: {
      version: number | null
      frontier: number
      authorityHeld: boolean
      budgetRemaining: number | null
      deadlineRemainingMs: number | null
    },
  ): boolean
  buildCancelRequest(executionId: string, reason: string): TransitionRequest
  metrics(): { recoveries: number; redispatchPlanned: number; suppressed: number }
}

export function createRecoveryEngine(): RecoveryEngine {
  // Idempotensi recovery: incident = executionId + frontier journal.
  // History sama → objek hasil SAMA (tanpa rencana ganda). Single-runtime;
  // konkuren sync → deterministik (tanpa lock terdistribusi — batas tercatat).
  const cache = new Map<string, RecoveryResult>()
  const m = { recoveries: 0, redispatchPlanned: 0, suppressed: 0 }

  const decide = (
    executionId: string,
    agg: Aggregated,
    ctx: RecoveryContext,
    at: number,
  ): RecoveryResult => {
    const reasons: string[] = []
    // Attached + parent terminal → warisan observasi cancel (nextAction saja;
    // interpretasi/state tak diubah; detached = preserve). M7 §29.
    const inheritParentCancel = (action: RecoveryNextAction): RecoveryNextAction => {
      if (
        ctx.parentTerminal === true &&
        ctx.detachedChild !== true &&
        action === "AWAIT_EVIDENCE"
      ) {
        reasons.push("parent terminal (attached): cancel interpretation inherited")
        return "REQUEST_CANCEL"
      }
      return action
    }
    const base = {
      executionId,
      evidenceRefs: Object.freeze([...agg.refs].sort((a, b) => a - b)),
      provenance: Object.freeze({
        rule: "",
        at,
        journalFrontier: agg.frontier,
        observedExecutionVersion: agg.maxVersion,
      }),
    }
    const finish = (
      interpretation: RecoveryInterpretation,
      evidenceStrength: EvidenceStrength,
      nextAction: RecoveryNextAction,
      extra: Partial<Pick<RecoveryResult, "redispatchPlan" | "requiresVerifier">> & {
        rule: string
      },
    ): RecoveryResult =>
      Object.freeze({
        ...base,
        interpretation,
        evidenceStrength,
        reasons: Object.freeze(reasons),
        nextAction,
        redispatchPlan: extra.redispatchPlan ?? null,
        requiresVerifier: extra.requiresVerifier ?? false,
        provenance: Object.freeze({ ...base.provenance, rule: extra.rule }),
      })

    // 1. Korupsi: blokir inferensi tak aman (bukan tebak).
    if (ctx.journalCorrupt) {
      reasons.push("journal corruption reported: history incomplete, no safe inference")
      return finish("RECOVERY_BLOCKED", "UNKNOWN", "ESCALATE_OPERATOR", {
        rule: "corruption-blocks",
      })
    }
    // 2. Warisan tanpa provenance: UNCORRELATED (bukan lineage fabrikasi).
    if (ctx.uncorrelated) {
      reasons.push("legacy record without stable provenance")
      return finish("UNCORRELATED", "UNKNOWN", "AWAIT_EVIDENCE", { rule: "legacy-uncorrelated" })
    }
    // 3. Terminal otoritatif: tak ada recovery; observasi telat dicatat.
    if (agg.hasTerminal) {
      reasons.push(`terminal history authoritative: ${agg.terminalTypes.join(",")}`)
      if (agg.terminalTypes.length > 1)
        reasons.push("late conflicting observation noted (kernel truth stands)")
      return finish("NO_RECOVERY_REQUIRED", "AUTHORITATIVE", "NONE", {
        rule: "terminal-authoritative",
      })
    }
    // 4-6. Infrastruktur: authority/budget/deadline (tak pernah dihidupkan ulang).
    if (!ctx.authorityHeld) {
      reasons.push("authority not held")
      return finish("RECOVERY_BLOCKED", "DURABLE", "ESCALATE_OPERATOR", {
        rule: "authority-required",
      })
    }
    if (ctx.budgetRemaining !== null && ctx.budgetRemaining <= 0) {
      reasons.push("budget exhausted")
      return finish("RECOVERY_BLOCKED", "DURABLE", "ESCALATE_OPERATOR", { rule: "budget-required" })
    }
    if (ctx.deadlineRemainingMs !== null && ctx.deadlineRemainingMs <= 0) {
      reasons.push("deadline expired")
      return finish("RECOVERY_BLOCKED", "DURABLE", "ESCALATE_OPERATOR", {
        rule: "deadline-required",
      })
    }
    // 7. Predicate kanonis tunggal (M9 mekanis / M12 semantis — satu definisi).
    const safety = buildSafety(ctx, ctx.notStartedEvidence != null)
    if (isRedispatchAllowed(safety)) {
      const attempt = ctx.attempt ?? 1
      const generation = ctx.generation ?? 1
      const plan: RedispatchPlan = Object.freeze({
        newExecutionId: allocateExecutionId(),
        attempt: attempt + 1,
        generation: generation + 1,
        supersedes: executionId,
        lineageRootId: ctx.lineageRootId ?? executionId,
        ...(ctx.parentExecutionId ? { parentExecutionId: ctx.parentExecutionId } : {}),
        validity: Object.freeze({
          observedExecutionVersion: agg.maxVersion,
          journalFrontier: agg.frontier,
          authorityHeld: ctx.authorityHeld,
          budgetRemaining: ctx.budgetRemaining,
          deadlineRemainingMs: ctx.deadlineRemainingMs,
        }),
      })
      m.redispatchPlanned++
      reasons.push("redispatch predicate satisfied")
      return finish("REDISPATCH_SAFE", "DURABLE", "PLAN_REDISPATCH", {
        rule: "predicate-allow",
        redispatchPlan: plan,
      })
    }
    // 8. Efek terkonfirmasi terjadi: tak ada yang perlu di-recovery (bukan error).
    if (ctx.verifierResult === "CONFIRMED_EXECUTED") {
      reasons.push("effect confirmed executed by verifier")
      return finish("NOT_RECOVERABLE", "OBSERVED", "NONE", { rule: "effect-done" })
    }
    // 9. Bahaya positif: efek mungkin terjadi (completed/gagal-parsial) +
    //    non-idempotent tanpa clearance → UNSAFE (fakta melarang, bukan kurang bukti).
    const effectMaybeHappened = agg.backendCompleted || agg.backendFailed
    if (effectMaybeHappened && !hasDedupeProof(ctx)) {
      m.suppressed++
      reasons.push("non-idempotent effect possibly happened without proof of non-execution")
      return finish("REDISPATCH_UNSAFE", "OBSERVED", "REQUEST_VERIFIER", {
        rule: "unsafe-non-idempotent",
        requiresVerifier: true,
      })
    }
    // 10. Orphan: handle hilang tanpa terminal (observasi dilestarikan).
    if (ctx.orphanSuspected) {
      reasons.push("orphan suspected: ownership expected, backend relationship untrustworthy")
      if (ctx.verifierAvailable) {
        return finish("ORPHAN", "OBSERVED", inheritParentCancel("REQUEST_VERIFIER"), {
          rule: "orphan-needs-verifier",
          requiresVerifier: true,
        })
      }
      return finish("ORPHAN", "OBSERVED", inheritParentCancel("AWAIT_EVIDENCE"), {
        rule: "orphan-unknown",
      })
    }
    // 11. Tak cukup bukti + jalur verifier ada → minta verifier.
    if (ctx.verifierAvailable) {
      reasons.push("insufficient evidence; verifier path available")
      return finish("REQUIRES_VERIFIER", "UNKNOWN", "REQUEST_VERIFIER", {
        rule: "needs-verifier",
        requiresVerifier: true,
      })
    }
    // 12. STALE: restart diketahui + history live non-terminal (bukan vonis gagal).
    if (ctx.processRestarted && (agg.hasIntent || agg.backendObserved || agg.maxVersion !== null)) {
      reasons.push("stale live history after restart (no failure assumed)")
      return finish("STALE", "DURABLE", inheritParentCancel("AWAIT_EVIDENCE"), {
        rule: "stale-live",
      })
    }
    reasons.push("insufficient evidence (no terminal, no safety, no verifier path)")
    return finish("UNKNOWN", "UNKNOWN", inheritParentCancel("AWAIT_EVIDENCE"), {
      rule: "unknown-default",
    })
  }

  return {
    recoverExecution(
      executionId: string,
      records: readonly JournalRecord[],
      ctx: RecoveryContext,
    ): RecoveryResult {
      const agg = aggregate(records.filter((r) => recordBelongsTo(r, executionId)))
      // Kunci insiden = history (frontier) + SELURUH konteks keputusan. Tanpa
      // ini, konteks berbeda pada history sama mengembalikan hasil basi
      // (defect nyata yang ditangkap test: budget-0 vs budget-null berbagi key).
      const ctxKey = stableCtxKey(ctx)
      const key = `${executionId}:${agg.frontier}:${ctxKey}`
      const hit = cache.get(key)
      if (hit) return hit
      m.recoveries++
      const result = decide(executionId, agg, ctx, Date.now())
      cache.set(key, result)
      return result
    },

    isPlanCurrent(plan, current): boolean {
      // Konservatif: versi SAMA + frontier SAMA + authority/budget/deadline
      // masih valid. Perubahan apa pun = stale (rencana bukan perintah irevokabel).
      // [P1 Hygiene F2] Nilai non-finite (NaN/±Infinity) = stale, bukan current:
      // `NaN > 0` false memang sudah stale, tapi +Infinity akan lolos sebagai
      // "available" tanpa guard eksplisit — dan pagu tak-berhingga bukan bukti.
      return (
        current.version === plan.validity.observedExecutionVersion &&
        current.frontier === plan.validity.journalFrontier &&
        current.authorityHeld === plan.validity.authorityHeld &&
        current.authorityHeld === true &&
        (plan.validity.budgetRemaining === null ||
          (current.budgetRemaining !== null &&
            Number.isFinite(current.budgetRemaining) &&
            current.budgetRemaining > 0)) &&
        (plan.validity.deadlineRemainingMs === null ||
          (current.deadlineRemainingMs !== null &&
            Number.isFinite(current.deadlineRemainingMs) &&
            current.deadlineRemainingMs > 0))
      )
    },

    buildCancelRequest(executionId: string, reason: string): TransitionRequest {
      // Data inert untuk caller teruskan ke kernel (engine tak memanggil kernel).
      return { executionId, to: "CANCELLING", reason, source: "supervisor" }
    },

    metrics() {
      // Catatan: suppressed dihitung di decide (UNSAFE path).
      return {
        recoveries: m.recoveries,
        redispatchPlanned: m.redispatchPlanned,
        suppressed: m.suppressed,
      }
    },
  }
}

function recordBelongsTo(r: JournalRecord, executionId: string): boolean {
  return !!r && (r as { executionId?: unknown }).executionId === executionId
}

/** Kunci konteks deterministik (sorted-keys; ctx hanya primitif JSON-safe). */
function stableCtxKey(ctx: RecoveryContext): string {
  const keys = Object.keys(ctx).sort()
  return keys
    .map((k) => `${k}=${JSON.stringify((ctx as unknown as Record<string, unknown>)[k])}`)
    .join(";")
}
