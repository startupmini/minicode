// [Fase 6A / ACE-01] Pilar 1 ACE-Lite — Deterministic Consequence Controller.
//
// Menerjemahkan bukti eksekusi (verifikasi, jenis kegagalan, jumlah percobaan,
// kesegaran bukti baru) menjadi verdict + kelas kegagalan + tindakan pemulihan
// berikutnya. Modul ini PURE dan deterministik: tanpa I/O, tanpa clock, tanpa
// jaringan — masukan yang sama selalu menghasilkan keputusan yang sama.
//
// Batas lapisan: `src/policy/` hanya boleh mengimpor pustaka standar Node dan
// modul policy lain (lihat test/ui-boundary.test.ts). Karena itu tipe ACE juga
// diimpor oleh session/runtime-header.ts dan composition root, bukan sebaliknya.
//
// [ACE-INV-01] HARD CONSTRAINT: percobaan manipulasi evaluator SELALU
// mengalahkan metrik lain. Tidak ada kombinasi input yang boleh mengubah
// EVALUATOR_TAMPER_ATTEMPT menjadi PASS — verdict-nya BLOCKED, dan satu-satunya
// tindakan legal adalah STOP_AND_REPORT.

export type AceVerdict = "PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE"

export type AceFailureClass =
  | "NONE"
  | "TRANSIENT_ENV"
  | "FUNCTIONAL_TEST_FAIL"
  | "REGRESSION_DETECTED"
  | "REPEATED_NO_EVIDENCE"
  | "INSUFFICIENT_EVIDENCE"
  | "PERMISSION_OR_EXTERNAL_BLOCKER"
  | "EVALUATOR_TAMPER_ATTEMPT"

export type AceNextAction =
  | "COMPLETE_AFTER_VERIFICATION"
  | "RETRY_TRANSIENT"
  | "ANALYZE_FAILURE"
  | "REVISE_HYPOTHESIS"
  | "GATHER_EVIDENCE"
  | "CHANGE_STRATEGY"
  | "REQUEST_HUMAN"
  | "STOP_AND_REPORT"

export type AceFailureType =
  | "network_error"
  | "rate_limit"
  | "timeout"
  | "functional"
  | "regression"
  | null

// [Fase 9 / 9.1] Operational Rollback Switch — `MINICODE_ACE_ENABLED`.
//
// Operator harus bisa menonaktifkan ACE-Lite secara bersih (rollback instan
// atau baseline murni) tanpa mengubah kode. Default `true` (aktif) agar seluruh
// test `p18` dan `p19` tetap hijau tanpa env var. Nilai yang dianggap "off"
// (case-insensitive, di-trim): "0", "false", "off", "no". Selain itu → aktif.
//
// PENTING: sakelar ini TIDAK menyentuh hard-safety/permission policy maupun
// Evaluator Tamper Guard — keduanya tetap berjalan apa pun nilainya (safety
// constraint tidak boleh dimatikan oleh sakelar fitur).
const ACE_DISABLE_VALUES = new Set(["0", "false", "off", "no"])

export function isAceEnabled(env?: Record<string, string | undefined>): boolean {
  const raw = (env?.MINICODE_ACE_ENABLED ?? process.env.MINICODE_ACE_ENABLED)?.trim().toLowerCase()
  if (raw === undefined || raw === "") return true
  return !ACE_DISABLE_VALUES.has(raw)
}

export interface ConsequenceDecision {
  readonly verdict: AceVerdict
  readonly failureClass: AceFailureClass
  readonly nextAction: AceNextAction
  readonly rationale: string
  readonly newEvidenceSinceLastAttempt?: boolean
}

export interface ConsequenceEvaluationInput {
  /** Verifikasi berbasis bukti sudah lulus sepenuhnya. */
  readonly verificationPassed?: boolean
  /** Bukti upaya manipulasi evaluator (edit gate test / injeksi .skip/.todo). */
  readonly evaluatorTamperAttempt?: boolean
  /** Jenis kegagalan yang teramati. */
  readonly failureType?: AceFailureType
  /** Error sementara (jaringan/rate-limit/timeout) yang aman diulang. */
  readonly isTransientError?: boolean
  /** Berapa kali kegagalan identik terjadi berturut-turut SEBELUM percobaan ini. */
  readonly repeatedFailureCount?: number
  /** Agen membaca bukti diagnostik baru sejak kegagalan terakhir. */
  readonly newEvidenceSinceLastAttempt?: boolean
  /** Terhalang izin/approval atau dependensi eksternal yang tak bisa dipulihkan agen. */
  readonly blockedByPermissionOrExternalBlocker?: boolean
  /** Budget turn/USD habis. */
  readonly budgetExhausted?: boolean
  /** Belum ada bukti yang cukup untuk memutuskan. */
  readonly insufficientEvidence?: boolean
  /** Baseline/evaluator berubah sehingga kegagalan fungsional = regresi. */
  readonly baselineContentChanged?: boolean
}

const TRANSIENT_TYPES = new Set<AceFailureType>(["network_error", "rate_limit", "timeout"])

/**
 * Evaluasi deterministik. Urutan aturan adalah kontrak — jangan diubah tanpa
 * memperbarui test/p18-ace-lite-engine.test.ts karena tiap cabang diuji
 * eksplisit.
 */
export function evaluateConsequence(input: ConsequenceEvaluationInput): ConsequenceDecision {
  const newEvidence = input.newEvidenceSinceLastAttempt === true

  // 1. HARD CONSTRAINT — manipulasi evaluator tidak pernah bisa lolos.
  if (input.evaluatorTamperAttempt === true) {
    return {
      verdict: "BLOCKED",
      failureClass: "EVALUATOR_TAMPER_ATTEMPT",
      nextAction: "STOP_AND_REPORT",
      rationale: "evaluator tamper attempt detected — refusing every verified claim",
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 2. Bukti verifikasi lengkap dan sah.
  if (input.verificationPassed === true) {
    return {
      verdict: "PASS",
      failureClass: "NONE",
      nextAction: "COMPLETE_AFTER_VERIFICATION",
      rationale: "all verification criteria satisfied with fresh evidence",
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 3. Budget habis = berhenti, bukan retry tanpa batas.
  if (input.budgetExhausted === true) {
    return {
      verdict: "BLOCKED",
      failureClass: "INSUFFICIENT_EVIDENCE",
      nextAction: "STOP_AND_REPORT",
      rationale: "budget exhausted before verification completed",
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 4. Blocker eksternal/izin — agen tidak bisa menyelesaikan sendiri.
  if (input.blockedByPermissionOrExternalBlocker === true) {
    return {
      verdict: "BLOCKED",
      failureClass: "PERMISSION_OR_EXTERNAL_BLOCKER",
      nextAction: "REQUEST_HUMAN",
      rationale: "permission denied or external dependency unavailable",
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 5. Error sementara yang aman diulang.
  const functionalFailure = input.failureType === "functional" || input.failureType === "regression"
  const transient =
    !functionalFailure &&
    (input.isTransientError === true || TRANSIENT_TYPES.has(input.failureType ?? null))
  if (transient) {
    return {
      verdict: "FAIL",
      failureClass: "TRANSIENT_ENV",
      nextAction: "RETRY_TRANSIENT",
      rationale: `transient environment failure (${input.failureType ?? "unknown"}) — safe to retry`,
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 6. Kegagalan berulang tanpa bukti baru → ganti strategi, bukan ulang buta.
  if ((input.repeatedFailureCount ?? 0) >= 2 && !newEvidence) {
    return {
      verdict: "FAIL",
      failureClass: "REPEATED_NO_EVIDENCE",
      nextAction: "CHANGE_STRATEGY",
      rationale: `repeated failure count ${input.repeatedFailureCount} without new evidence`,
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 7. Regresi: kegagalan fungsional setelah baseline berubah.
  if (
    input.failureType === "regression" ||
    (input.baselineContentChanged === true && input.failureType === "functional")
  ) {
    return {
      verdict: "FAIL",
      failureClass: "REGRESSION_DETECTED",
      nextAction: "REVISE_HYPOTHESIS",
      rationale: "baseline changed and functional evidence now fails — regression suspected",
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 8. Kegagalan fungsional pertama → analisis dulu.
  if (input.failureType === "functional") {
    return {
      verdict: "FAIL",
      failureClass: "FUNCTIONAL_TEST_FAIL",
      nextAction: "ANALYZE_FAILURE",
      rationale: "first functional failure — inspect evidence before changing code",
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 9. Bukti belum cukup (tanpa jenis kegagalan konkret).
  if (input.insufficientEvidence === true || input.failureType == null) {
    return {
      verdict: "INCONCLUSIVE",
      failureClass: "INSUFFICIENT_EVIDENCE",
      nextAction: "GATHER_EVIDENCE",
      rationale: "no decisive failure evidence yet — gather diagnostics",
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 10. Fallback fail-closed: jangan pernah mengarang PASS.
  return {
    verdict: "INCONCLUSIVE",
    failureClass: "INSUFFICIENT_EVIDENCE",
    nextAction: "GATHER_EVIDENCE",
    rationale: "unclassified state — more evidence required",
    newEvidenceSinceLastAttempt: newEvidence,
  }
}
