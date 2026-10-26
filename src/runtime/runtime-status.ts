// P13.1 — Kontrak status runtime kanonik + logika murni.
//
// Empat sumbu DIPISAH, satu tanggung jawab per sumbu:
//
//   phase       = lifecycle runtime      (ABSENT/STARTING/ACTIVE/STOPPING/STOPPED)
//   admission   = boleh terima kerja durable BARU? (ALLOW/SCOPED/REFUSE)
//   health      = kesehatan proses yang diamati (HEALTHY/DEGRADED/UNHEALTHY/UNKNOWN)
//   termination = kenapa tak bisa lanjut (NONE/REQUESTED/HALTED/FAILED)
//
// Kenapa dipisah: draft pertama mencampur HALTED/FAILED ke dalam "readiness",
// sehingga satu nilai menjawab "apakah boleh jalan?" sekaligus "kok mati?" —
// dua pertanyaan yang jawabannya berbeda, dan pencampurannya membuat
// fail-closed mustahil ditegakkan.
//
// KOSAKATA YANG TIDAK BOLEH DICAMPUR:
//
//   SchedulerState        (src/task/scheduler.ts)  = state SCHEDULER, bukan runtime.
//   RefusalCode          (src/daemon/protocol.ts)  = penolakan OPERASI (bukan penyebab runtime).
//   HaltReason           (src/daemon/protocol.ts)  = alasan berhenti atas permintaan.
//   FailureClassification(src/runtime/supervisor.ts)= PENYEBAB kegagalan (bukan penolakan).
//   UNKNOWN                                     = ketidakpastian bukti/pengamatan,
//                                                  BUKAN outcome terminal.
//
// Modul ini MURNI: tak ada I/O, tak ada jam internal, tak ada state global.
// Semuanya masuk lewat argumen, sehingga hasilnya deterministik dan bisa
// diuji tanpa infra.

import type { HaltReason } from "../daemon/protocol.ts"
import {
  advertisedRuntimeCapabilities,
  capabilityAvailable,
  type DurableWorkRequirementMap,
  type RuntimeCapability,
  requirementFor,
} from "./runtime-capabilities.ts"
import type {
  RuntimeEvidence,
  RuntimeFacts,
  RuntimeFlushReport,
  RuntimePhase,
  RuntimeTermination,
} from "./runtime-status-facts.ts"
import type { FailureClassification } from "./supervisor.ts"

// Tipe fakta + bentuk hasil drain milik modul netral (runtime-status-facts.ts)
// supaya berkas ini tak perlu mengimpor composition.ts — graf import
// src/runtime/** tetap bebas siklus (guard m16 G1). Re-export supaya pemanggil
// lama (dan surface kontrak) tak berubah.
export type {
  RuntimeEvidence,
  RuntimeFacts,
  RuntimeFlushReport,
  RuntimePhase,
  RuntimeTermination,
} from "./runtime-status-facts.ts"

// ── Empat sumbu (satu tanggung jawab masing-masing) ─────────────────────────

/** Keputusan admission untuk kerja durable BARU. */
export type RuntimeAdmission = "ALLOW" | "SCOPED" | "REFUSE"

/** Kesehatan proses yang diamati. UNKNOWN = tak bisa diamati, bukan "buruk". */
export type RuntimeHealth = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN"

/** Kondisi bukti: lengkap, basi (bertentangan), atau belum diketahui. */
export type RuntimeEvidenceState = "COMPLETE" | "STALE" | "MISSING"

// Kosakata runtime (dipublikasi sebagai nilai agar bisa DIVERIFIKASI, bukan
// hanya dijanjikan tipe): satu nilai per sumbu, tak ada nilai yang dipakai dua
// sumbu. Kalau suatu saat ada nilai yang ambigu, tes kontrak ini gagal.

/** Semua fase lifecycle runtime yang sah. */
export const RUNTIME_PHASES: readonly RuntimePhase[] = [
  "ABSENT",
  "STARTING",
  "ACTIVE",
  "STOPPING",
  "STOPPED",
] as const

/** Semua keputusan admission yang sah. */
export const RUNTIME_ADMISSIONS: readonly RuntimeAdmission[] = [
  "ALLOW",
  "SCOPED",
  "REFUSE",
] as const

/** Semua nilai kesehatan proses yang sah. */
export const RUNTIME_HEALTHS: readonly RuntimeHealth[] = [
  "HEALTHY",
  "DEGRADED",
  "UNHEALTHY",
  "UNKNOWN",
] as const

/**
 * Semua terminasi yang sah. Perhatikan: TIDAK ada "UNKNOWN" — ketidakpastian
 * bukti hidup di `RuntimeEvidenceState`, bukan sebagai outcome terminal.
 */
export const RUNTIME_TERMINATIONS: readonly RuntimeTermination[] = [
  "NONE",
  "REQUESTED",
  "HALTED",
  "FAILED",
] as const

// ── View (output kanonik) ───────────────────────────────────────────────────

/** Status runtime yang dikonsumsi daemon maupun CLI. */
export interface RuntimeView {
  readonly phase: RuntimePhase
  readonly admission: RuntimeAdmission
  readonly health: RuntimeHealth
  readonly termination: RuntimeTermination
  readonly evidenceState: RuntimeEvidenceState
  readonly evidence: RuntimeEvidence
  /** Kapabilitas yang DIKLAIM runtime ini. */
  readonly advertisedCapabilities: readonly RuntimeCapability[]
  /** Kapabilitas yang saat ini benar-benar tersedia. */
  readonly availableCapabilities: readonly RuntimeCapability[]
  /** Kapabilitas yang diklaim tapi tak tersedia (penyebab degradasi). */
  readonly unavailableCapabilities: readonly RuntimeCapability[]
  /**
   * Jumlah anak proses yang tercatat di jalur ownership proses runtime.
   *
   * INI BEDA dari kapabilitas `process-supervision`: kapabilitas berarti "jalur
   * supervisi terpasang", angka ini berarti "ada anak yang tercatat". Runtime
   * dengan jalur terpasang tapi tanpa anak (mis. belum ada LSP yang dikonfigurasi)
   * tetap healthy — ia siap menerima kerja, hanya tak ada proses anak yang
   * dikuasai. Tanpa pemisahan ini, pembaca status bisa salah menyimpulkan
   * "runtime sudah menjalankan proses" dari sekadar melihat kapabilitasnya.
   */
  readonly supervisedChildren: number
  /** Alasan halt (hanya bila termination = REQUESTED | HALTED). */
  readonly haltReason?: HaltReason
  /** Penyebab kegagalan (hanya bila termination = FAILED). */
  readonly failure?: FailureClassification
  /** Catatan diagnostik singkat. BUKAN input keputusan — hanya untuk ditampilkan. */
  readonly note?: string
  /** Hasil drain terakhir — BUKAN bukti readiness. */
  readonly lastFlush: RuntimeFlushReport | null
}

// ── Validasi kombinasi status/reason ────────────────────────────────────────

/** Pelanggaran kontrak (kombinasi status/reason yang tak sah). */
export class RuntimeContractError extends Error {
  readonly violations: readonly string[]

  constructor(violations: readonly string[]) {
    super(`kontrak runtime dilanggar: ${violations.join("; ")}`)
    this.name = "RuntimeContractError"
    this.violations = violations
  }
}

/**
 * Periksa kombinasi phase/termination/reason yang SAH.
 *
 * Yang diperiksa di sini HANYA kombinasi yang mustahil (bug di sisi producer).
 * Bukti basi/tak diketahui BUKAN pelanggaran kontrak — itu kondisi nyata yang
 * harus menghasilkan fail-closed (REFUSE), bukan error.
 *
 * Aturan:
 * - `haltReason` sah hanya untuk REQUESTED | HALTED; `failure` sah hanya untuk
 *   FAILED; keduanya tak boleh muncul bersamaan.
 * - REQUESTED → phase harus STOPPING (halt belum selesai).
 * - HALTED | FAILED → phase harus STOPPED (sudah berhenti).
 * - NONE → phase tak boleh STOPPING | STOPPED (berhenti tanpa terminasi = kontradiksi).
 * - ABSENT → tak boleh punya terminasi apa pun (runtime tak pernah ada).
 */
export function validateRuntimeFacts(facts: RuntimeFacts): string[] {
  const violations: string[] = []
  const { phase, termination, haltReason, failure } = facts

  if (haltReason !== undefined && termination !== "REQUESTED" && termination !== "HALTED")
    violations.push(`haltReason hanya sah untuk REQUESTED|HALTED (dapat ${termination})`)
  if (failure !== undefined && termination !== "FAILED")
    violations.push(`failure hanya sah untuk FAILED (dapat ${termination})`)
  if (haltReason !== undefined && failure !== undefined)
    violations.push("haltReason dan failure tak boleh muncul bersamaan")

  if (termination === "REQUESTED" && phase !== "STOPPING")
    violations.push(`REQUESTED hanya sah pada phase STOPPING (dapat ${phase})`)
  if ((termination === "HALTED" || termination === "FAILED") && phase !== "STOPPED")
    violations.push(`${termination} hanya sah pada phase STOPPED (dapat ${phase})`)
  if (termination === "NONE" && (phase === "STOPPING" || phase === "STOPPED"))
    violations.push(`phase ${phase} wajib punya terminasi`)
  if (phase === "ABSENT" && termination !== "NONE")
    violations.push(`phase ABSENT tak boleh punya terminasi (dapat ${termination})`)

  return violations
}

// ── Penurunan view (murni) ──────────────────────────────────────────────────

function deriveEvidenceState(facts: RuntimeFacts): RuntimeEvidenceState {
  const ev = facts.evidence
  const { phase } = facts

  // STALE: bukti bertentangan dengan fakta lifecycle. Contoh: phase ACTIVE
  // padahal handle sudah ditutup, atau runtime "constructed" saat fase ABSENT.
  if (phase === "ABSENT" && ev.constructed) return "STALE"
  if (phase === "STOPPED" && !ev.closed) return "STALE"
  if (phase === "STARTING" && ev.closed) return "STALE"
  if (phase === "ACTIVE" || phase === "STOPPING") {
    if (!ev.constructed || !ev.gateEnabled || ev.closed) return "STALE"
  }

  // MISSING: bukti WAJIB belum diketahui. Yang wajib = bukti untuk kapabilitas
  // yang memang diiklankan runtime ini (kapabilitas tak diiklankan tak boleh
  // menggagalkan readiness — "tidak ada" ≠ "belum diketahui").
  const advertised = advertisedRuntimeCapabilities(facts.attachment)
  if (advertised.includes("durable-journal") && ev.journalWritable === null) return "MISSING"
  if (advertised.includes("durable-task-store") && ev.storeOpen === null) return "MISSING"
  if (advertised.includes("task-scheduler") && ev.schedulerAttached === null) return "MISSING"
  if (advertised.includes("process-supervision") && ev.supervisorAttached === null) return "MISSING"

  return "COMPLETE"
}

function deriveHealth(
  facts: RuntimeFacts,
  evidenceState: RuntimeEvidenceState,
  unavailable: readonly RuntimeCapability[],
): RuntimeHealth {
  if (facts.termination === "FAILED") return "UNHEALTHY"
  if (facts.phase === "STOPPING") return "DEGRADED"
  if (facts.phase !== "ACTIVE") return "UNKNOWN"
  if (evidenceState !== "COMPLETE") return "UNKNOWN"
  // Supervisi diharapkan tapi tak operasional → runtime DEGRADED, bukan
  // "sehat". Tanpa aturan ini, establishment yang gagal akan tampil sebagai
  // runtime yang-armed — persis klaim palsu yang P13.2 minta dicegah.
  if (facts.evidence.supervisionExpected && facts.evidence.supervisorAttached !== true)
    return "DEGRADED"
  return unavailable.length > 0 ? "DEGRADED" : "HEALTHY"
}

function deriveAdmission(
  facts: RuntimeFacts,
  evidenceState: RuntimeEvidenceState,
  unavailable: readonly RuntimeCapability[],
): RuntimeAdmission {
  if (facts.phase !== "ACTIVE") return "REFUSE"
  if (facts.termination !== "NONE") return "REFUSE"
  if (evidenceState !== "COMPLETE") return "REFUSE"
  // Supervisi diminta tapi tak operasional → tak boleh SCOPED "sehat": kerja
  // durable baru menunggu supervision yang utuh.
  if (facts.evidence.supervisionExpected && facts.evidence.supervisorAttached !== true)
    return "REFUSE"
  return unavailable.length > 0 ? "SCOPED" : "ALLOW"
}

/**
 * Alasan penolakan — TOTAL atas kombinasi yang sah (validasi menjamin fase
 * dan terminasi konsisten, jadi tak ada cabang mati di sini).
 */
function refusalReason(
  phase: RuntimePhase,
  termination: RuntimeTermination,
  evidenceState: RuntimeEvidenceState,
): string {
  switch (phase) {
    case "ABSENT":
      return "runtime tidak terpasang (fase ABSENT)"
    case "STARTING":
      return "runtime belum siap menerima kerja (fase STARTING)"
    case "STOPPING":
      return "runtime sedang berhenti (fase STOPPING)"
    case "STOPPED":
      return termination === "FAILED"
        ? "runtime gagal (terminasi FAILED)"
        : "runtime sudah berhenti (fase STOPPED)"
    case "ACTIVE":
      return evidenceState === "STALE"
        ? "bukti runtime basi / bertentangan (STALE)"
        : "bukti runtime belum lengkap (MISSING)"
  }
}

/**
 * Turunkan view kanonik dari fakta.
 *
 * Lempar `RuntimeContractError` bila kombinasi status/reason mustahil —
 kombinasi yang tak mungkin adalah bug producer, dan menutupnya diam-diam
 * berarti status yang tak pernah terjadi tetap tampil sebagai "normal".
 *
 * Bukti basi/tak diketahui TIDAK melempar: ia menghasilkan admission REFUSE.
 */
export function deriveRuntimeView(facts: RuntimeFacts): RuntimeView {
  const violations = validateRuntimeFacts(facts)
  if (violations.length > 0) throw new RuntimeContractError(violations)

  const evidenceState = deriveEvidenceState(facts)
  const advertised = advertisedRuntimeCapabilities(facts.attachment)
  const capabilityEvidence = {
    journalWritable: facts.evidence.journalWritable,
    storeOpen: facts.evidence.storeOpen,
    schedulerAttached: facts.evidence.schedulerAttached,
    supervisorAttached: facts.evidence.supervisorAttached,
  }
  const available = advertised.filter((c) => capabilityAvailable(c, capabilityEvidence))
  const unavailable = advertised.filter((c) => !capabilityAvailable(c, capabilityEvidence))

  const view: RuntimeView = {
    phase: facts.phase,
    admission: deriveAdmission(facts, evidenceState, unavailable),
    health: deriveHealth(facts, evidenceState, unavailable),
    termination: facts.termination,
    evidenceState,
    evidence: facts.evidence,
    advertisedCapabilities: advertised,
    availableCapabilities: available,
    unavailableCapabilities: unavailable,
    supervisedChildren: facts.supervisedChildren,
    lastFlush: facts.lastFlush ?? null,
    ...(facts.haltReason !== undefined ? { haltReason: facts.haltReason } : {}),
    ...(facts.failure !== undefined ? { failure: facts.failure } : {}),
  }
  return view
}

// ── Admission kerja durable (per jenis kerja) ───────────────────────────────

/** Permintaan admission satu jenis kerja durable. */
export interface DurableWorkRequest {
  /** Pengenal jenis kerja (kunci peta, bukan bukti). */
  readonly workKind: string
  /** Peta kebutuhan eksplisit. Tanpa peta ⇒ REFUSE. */
  readonly requirements: DurableWorkRequirementMap
}

/** Keputusan admission untuk satu jenis kerja. */
export interface AdmissionDecision {
  /** ALLOW | SCOPED | REFUSE. */
  readonly admission: RuntimeAdmission
  /** Alasan yang bisa dibaca manusia (bukan secret). */
  readonly reason: string
  /** Kapabilitas yang dibutuhkan jenis kerja ini. */
  readonly requiredCapabilities: readonly RuntimeCapability[]
  /** Kapabilitas yang dibutuhkan tapi tak tersedia. */
  readonly missingCapabilities: readonly RuntimeCapability[]
}

/**
 * Apakah satu jenis kerja durable boleh diterima runtime ini?
 *
 * Fail-closed di setiap celah:
 * - Runtime tak siap (REFUSE) ⇒ tolak, tanpa pertanyaan.
 * - Tak ada PETA EKSLISIT untuk jenis kerja itu ⇒ tolak. Nama jenis kerja
 *   bukan bukti; allowlist yang disimpulkan dari nama adalah bug yang pernah
 *   terjadi dan tidak akan dikembalikan.
 * - Kapabilitas yang dibutuhkan tak tersedia ⇒ tolak, dan sebutkan mana.
 *
 * Runtime yang SEHAT tapi tak punya peta tetap ditolak: peta adalah bagian dari
 * keputusan, bukan hiasan. Peta produksi didaftarkan P13.2.
 */
export function admitDurableWork(
  view: RuntimeView,
  request: DurableWorkRequest,
): AdmissionDecision {
  const requirement = requirementFor(request.requirements, request.workKind)
  const required = requirement ? requirement.requiredCapabilities : []

  if (view.admission === "REFUSE") {
    return {
      admission: "REFUSE",
      reason: refusalReason(view.phase, view.termination, view.evidenceState),
      requiredCapabilities: required,
      missingCapabilities: [],
    }
  }

  if (!requirement) {
    return {
      admission: "REFUSE",
      reason: `tak ada peta eksplisit untuk jenis kerja "${request.workKind}"`,
      requiredCapabilities: [],
      missingCapabilities: [],
    }
  }

  const missing = required.filter((c) => !view.availableCapabilities.includes(c))
  if (missing.length > 0) {
    return {
      admission: "REFUSE",
      reason: `kapabilitas tak tersedia: ${missing.join(", ")}`,
      requiredCapabilities: required,
      missingCapabilities: missing,
    }
  }

  if (view.admission === "ALLOW") {
    return {
      admission: "ALLOW",
      reason: "runtime siap menerima kerja durable baru",
      requiredCapabilities: required,
      missingCapabilities: [],
    }
  }

  return {
    admission: "SCOPED",
    reason: `diterima dalam cakupan terbatas (kapabilitas tersedia: ${required.join(", ")})`,
    requiredCapabilities: required,
    missingCapabilities: [],
  }
}

// ── Lanjut / resume (C2) ────────────────────────────────────────────────────

/** Bukti yang dibutuhkan untuk MELANJUTKAN eksekusi yang tertahan. */
export interface ResumeEvidence {
  /** State runtime terbaca dan kini (bukan basi). */
  readonly runtimeStateCurrent: boolean | null
  /** Storage + jurnal bisa dipakai (bukan hanya tersimpan). */
  readonly storageUsable: boolean | null
  /** Lease/epoch valid. */
  readonly leaseValid: boolean | null
  /** Incarnation/authority kini. */
  readonly authorityCurrent: boolean | null
}

/** Keputusan lanjut/tahan. */
export interface ResumeDecision {
  /** Boleh eksekusi dilanjutkan? */
  readonly resume: boolean
  /** Record durable tetap tersimpan — menahan ≠ menghapus. */
  readonly recordRetained: true
  /** Bukti yang belum terpenuhi (nama). */
  readonly missing: readonly string[]
}

/**
 * Bolehkah eksekusi yang tertahan dilanjutkan?
 *
 * Aturan: butuh BUKTI POSITIF untuk keempat hal (state runtime kini, storage
 * & jurnal bisa dipakai, lease/epoch valid, incarnation/authority kini).
 * Salah satu tidak terpenuhi ⇒ TAHAN, bukan "lanjutkan saja karena
 * membatalkan tak desirable" — membatalkan memang ruinous, tapi eksekusi tanpa
 * bukti tetap eksekusi tanpa otoritas.
 *
 * Record durable SELALU dipertahankan: menahan eksekusi tak pernah berarti
 * menghapus pekerjaan.
 */
export function evaluateResume(evidence: ResumeEvidence): ResumeDecision {
  const checks: Array<[string, boolean | null]> = [
    ["runtimeStateCurrent", evidence.runtimeStateCurrent],
    ["storageUsable", evidence.storageUsable],
    ["leaseValid", evidence.leaseValid],
    ["authorityCurrent", evidence.authorityCurrent],
  ]
  const missing = checks.filter(([, value]) => value !== true).map(([name]) => name)
  return {
    resume: missing.length === 0,
    recordRetained: true,
    missing,
  }
}
