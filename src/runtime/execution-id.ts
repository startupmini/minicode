// M1 — Execution correlator: SATU allocator + korelasi identitas.
//
// Kenapa berkas ini ada (P1 ADR-002, FINAL QA P1–P5): setiap execution harus
// punya SATU identitas korelasi yang stabil (same execution = same executionId),
// terpisah dari domain IDs (session/turn/task/toolCall/eventSeq). Sebelum M1,
// korelasi hanya implisit (sessionId ganda, approval counter reset, toolCallId
// milik provider) sehingga reload/restart dapat mengubah identitas diam-diam.
//
// BUKAN FSM, BUKAN registry authority, BUKAN recovery — hanya alokasi +
// korelasi + normalisasi legacy. Authority lifecycle tetap milik kernel (M8);
// registry otoritatif tetap milik durable (M2 hanya observasi).
//
// Aturan yang dikunci di sini (jangan dilonggarkan tanpa ADR baru):
// - `allocateExecutionId()` = SATU-SATUNYA allocator id acak (CSPRNG UUIDv4).
//   Jangan sebar `crypto.randomUUID()` ke modul lain — panggil helper ini.
// - Format `exec_<uuid>`; prefix presentation-only, uniqueness dari 128-bit.
// - Correlation object di-freeze (immutable pasca-admission).
// - Id turunan legacy deterministik (SHA-256 locator) BERBEDA BENTUK dari id
//   alokasi (32 hex tanpa strip vs UUID strip) agar tak tertukar authority.
// - Tanpa locator stabil = uncorrelated group, BUKAN UUID baru per load.

import { createHash, randomUUID } from "node:crypto"

/** Prefix presentation-only. BUKAN sumber uniqueness. */
export const EXECUTION_ID_PREFIX = "exec_"

/** Kind datar M1 — metadata, bukan hierarchy class (M7/M8 yang memakai). */
export type ExecutionKind = "turn" | "tool_call" | "task" | "child" | "background"

/**
 * Korelasi execution M1. Kontrak memory (BUKAN nullable shortcut):
 * executionId/kind/ownerId/rootExecutionId WAJIB; parentExecutionId opsional
 * hanya karena root tidak punya parent. Dibuat via constructor di bawah yang
 * mem-freeze object (immutable pasca-admission).
 */
export interface ExecutionCorrelation {
  readonly executionId: string
  readonly kind: ExecutionKind
  readonly ownerId: string
  readonly rootExecutionId: string
  readonly parentExecutionId?: string
  /** True = diturunkan deterministik dari locator legacy (bukan alokasi). */
  readonly derived?: true
}

/** Pola UUIDv4 lowercase (randomUUID Node) — authority alokasi acak. */
const ALLOCATED_RE = /^exec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** Pola turunan deterministik: 32 hex tanpa strip (SHA-256 slice). */
const DERIVED_RE = /^exec_[0-9a-f]{32}$/

/** True untuk kedua bentuk (alokasi + turunan). Bukan validasi authority. */
export function isExecutionId(value: unknown): value is string {
  return typeof value === "string" && (ALLOCATED_RE.test(value) || DERIVED_RE.test(value))
}

/** True hanya untuk id alokasi acak (otoritas allocator M1). */
export function isAllocatedExecutionId(value: unknown): value is string {
  return typeof value === "string" && ALLOCATED_RE.test(value)
}

/** True hanya untuk id turunan deterministik legacy (bukan authority baru). */
export function isDerivedExecutionId(value: unknown): value is string {
  return typeof value === "string" && DERIVED_RE.test(value)
}

// ── Observability minimal M1 (bukan canonical event system — itu M10) ──

export interface ExecutionIdMetrics {
  allocated: number
  derived: number
  uncorrelated: number
  collisions: number
}

const metrics: ExecutionIdMetrics = { allocated: 0, derived: 0, uncorrelated: 0, collisions: 0 }

/** Snapshot copy (bukan live view) agar observer tak memutasi counter. */
export function getExecutionIdMetrics(): ExecutionIdMetrics {
  return { ...metrics }
}

// ── Allocator: SATU-SATUNYA sumber id acak (jangan panggil randomUUID langsung) ──

/**
 * Alokasi id execution baru: `exec_<UUIDv4 CSPRNG 128-bit>`.
 * Authority = Runtime Host / runtime allocator (M1: helper ini; Host formal M3).
 * User input TIDAK BOLEH menjadi authority — allocator tak menerima id dari luar.
 * Retry/re-dispatch TIDAK BOLEH memanggil ini untuk execution yang sudah ada
 * (attempt baru = execution baru; execution lama immutable).
 */
export function allocateExecutionId(): string {
  const id = `${EXECUTION_ID_PREFIX}${randomUUID()}`
  metrics.allocated++
  return id
}

/**
 * Alokasi anti-tabrakan terhadap himpunan yang dikenal (admission guard M1).
 * Bila stub/generator menghasilkan duplikat: JANGAN overwrite/merge — catat
 * collision, coba lagi dengan nilai baru. Mengembalikan id yang tidak ada di
 * `known`. Registry otoritatif (M2/M8) memakai helper ini saat admission.
 */
export function allocateUniqueExecutionId(
  known: { has(id: string): boolean },
  random: () => string = allocateExecutionId,
  maxAttempts = 100,
): string {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = random()
    if (!known.has(id)) return id
    metrics.collisions++
  }
  throw new Error("allocateUniqueExecutionId: collision persists (refusing to overwrite)")
}

// ── Constructor korelasi (frozen; root/parent rule dikunci) ──

function assertCorrelationInput(kind: unknown, ownerId: unknown): void {
  if (typeof kind !== "string" || kind.length === 0)
    throw new Error("ExecutionCorrelation: kind is required")
  if (typeof ownerId !== "string" || ownerId.length === 0)
    throw new Error("ExecutionCorrelation: ownerId is required (never user-controlled authority)")
}

/**
 * Korelasi root: rootExecutionId = executionId, tanpa parent.
 * ownerId = identitas owner menurut arsitektur kini (session/task id),
 * BUKAN klaim dari user input (otorisasi tetap via policy/permission).
 */
export function createRootCorrelation(kind: ExecutionKind, ownerId: string): ExecutionCorrelation {
  assertCorrelationInput(kind, ownerId)
  const executionId = allocateExecutionId()
  return Object.freeze({
    executionId,
    kind,
    ownerId,
    rootExecutionId: executionId,
  })
}

/**
 * Korelasi child: id BARU (child ≠ parent), parentExecutionId = parent id,
 * rootExecutionId = parent root (diwariskan TANPA rewrite — retry/detach penuh
 * ditangani M7 dengan lineage_root vs cancel_scope terpisah).
 * Parent tak valid (tanpa required fields) = throw, bukan tebak.
 */
export function createChildCorrelation(
  parent: Pick<ExecutionCorrelation, "executionId" | "rootExecutionId">,
  kind: ExecutionKind,
  ownerId: string,
): ExecutionCorrelation {
  assertCorrelationInput(kind, ownerId)
  if (!parent || !isExecutionId(parent.executionId) || !isExecutionId(parent.rootExecutionId))
    throw new Error("createChildCorrelation: valid parent correlation is required (no guessing)")
  return Object.freeze({
    executionId: allocateExecutionId(),
    kind,
    ownerId,
    rootExecutionId: parent.rootExecutionId,
    parentExecutionId: parent.executionId,
  })
}

// ── Legacy normalization (stabil, tanpa tulis-ulang riwayat) ──

/** Namespace derivasi (ganti bila skema locator berubah → id baru eksplisit). */
const DERIVE_NAMESPACE = "m1-legacy-v1:"

/**
 * Turunkan id stabil deterministik dari locator key.
 * BUKAN alokasi: tidak menambah `allocated`, tidak menjadi authority baru,
 * dibedakan bentuk (32 hex tanpa strip) + flag `derived:true` oleh pemanggil.
 * Sama locator = sama id pada setiap load/restart/concurrent — tanpa storage.
 */
export function deriveStableExecutionId(locatorKey: string): string {
  if (!locatorKey) throw new Error("deriveStableExecutionId: locatorKey is required")
  const digest = createHash("sha256")
    .update(DERIVE_NAMESPACE + locatorKey)
    .digest("hex")
    .slice(0, 32)
  const id = `${EXECUTION_ID_PREFIX}${digest}`
  metrics.derived++
  return id
}

/** Kunci locator stabil — HANYA dari basis yang terbukti di repository. */
export const legacyLocatorKeys = {
  /** Journal: identitas utama `${session}:${seq}`, seq monotonik per-file. */
  journal: (session: string, seq: number): string => `journal:${session}:${seq}`,
  /** Messages: PK (session_id, seq). */
  message: (sessionId: string, seq: number): string => `message:${sessionId}:${seq}`,
  /** Presentation events: PK (session_id, event_seq). */
  presentationEvent: (sessionId: string, eventSeq: number): string =>
    `event:${sessionId}:${eventSeq}`,
  /** Turn: session + turn index. */
  turn: (sessionId: string, turnIdx: number): string => `turn:${sessionId}:${turnIdx}`,
  /** Claim/attempt: taskId + revision + generation (+incarnation bila ada). */
  claim: (taskId: string, revision: number, generation: number, incarnation?: string): string =>
    `claim:${taskId}:r${revision}:g${generation}${incarnation ? `:${incarnation}` : ""}`,
} as const

export type LegacyNormalization =
  | { status: "correlated"; executionId: string }
  | { status: "stable-locator"; locatorKey: string; executionId: string }
  | { status: "uncorrelated"; group: string; uncorrelated: true }

/**
 * Normalisasi SATU arah (load-time, tanpa mutasi storage):
 * - record sudah bawa executionId valid → pakai itu (jangan regenerate);
 * - locator stabil ada → id turunan deterministik (stabil lintas load);
 * - selain itu → uncorrelated group (BUKAN UUID baru per load; tanpa
 *   individual cancel/retry/re-dispatch — hanya agregat observasi).
 */
export function normalizeLegacyIdentity(input: {
  executionId?: unknown
  locatorKey?: string
  fallbackGroup: string
}): LegacyNormalization {
  if (isExecutionId(input.executionId))
    return { status: "correlated", executionId: input.executionId }
  if (input.locatorKey) {
    return {
      status: "stable-locator",
      locatorKey: input.locatorKey,
      executionId: deriveStableExecutionId(input.locatorKey),
    }
  }
  metrics.uncorrelated++
  return { status: "uncorrelated", group: input.fallbackGroup, uncorrelated: true as const }
}
