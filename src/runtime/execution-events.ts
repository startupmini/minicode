// M10 — Execution event plane: observasi kanonis, BUKAN authority.
//
// Kenapa berkas ini ada (P1 M10): lifecycle Kernel (M8), aksi supervisor (M9),
// dan observasi backend (M5) butuh satu aliran observasi yang koheren untuk
// diagnosis — tanpa menjadikan aliran itu penulis lifecycle, store durable,
// atau jembatan scheduler. Sebelum M10, observasi tersebar per-subsystem.
//
// Prinsip yang dikunci (jangan dilonggarkan tanpa ADR baru):
//   Kernel decides (commit) → Event Plane observes (emit) → observers/metrics/M11.
//   TAK PERNAH sebaliknya. Commit sukses + emit gagal = tetap committed.
//   Event ≠ durable (persistensi = M11). Event ≠ replay/recovery (M12).
// - Tiga domain sequence TERPISAH: executionVersion (versi state otoritatif
//   Kernel, diobservasi) ≠ eventSequence (urutan emit dalam plane ini) ≠
//   journalSequence (TIDAK ADA di M10 — milik M11).
// - eventId (`evt_<uuid>`) ≠ executionId (satu execution → banyak event).
// - Ordering = per-plane monotonic; BUKAN global; timestamp tak pernah
//   difabrikasi menjadi order (ts sama + sequence beda = legal).
// - Observer terisolasi (throw dihitung, commit/sink tak terpengaruh), tanpa
//   worker/timer/queue tersembunyi; nested emit sinkron diizinkan dengan
//   guard kedalaman (anti-deadlock/stack-blowup), bukan dilarang diam-diam.
// - Event frozen snapshot (tanpa referensi mutable ke Execution); metadata
//   hanya korelasi (tanpa secret/prompt/history/output —boundary diuji).
// - Tak ada import scheduler/TaskStore/persistence/journal/UI/CLI/backend-spawn.
//   Tak ada API: setState/mutate/complete/fail/cancel/admit/persist/recover/claim.

import { randomUUID } from "node:crypto"

/** Taksonomi M10: lifecycle (dari commit Kernel) + observasi mekanis. */
export type ExecutionEventType =
  | "execution.created"
  | "execution.state-changed"
  | "execution.completed"
  | "execution.failed"
  | "execution.cancelled"
  | "execution.timed-out"
  | "execution.budget-exceeded"
  | "execution.authority-lost"
  | "execution.resource-exceeded"
  | "execution.orphaned"
  | "backend.observed"
  | "backend.action-requested"
  | "supervisor.observed"
  | "supervisor.action"
  | "supervisor.redispatch-planned"

/** Lifecycle terminal → tipe event (satu-ke-satu, tanpa collapse). */
const TERMINAL_EVENT: Record<string, ExecutionEventType> = {
  COMPLETED: "execution.completed",
  FAILED: "execution.failed",
  CANCELLED: "execution.cancelled",
  TIMED_OUT: "execution.timed-out",
  BUDGET_EXCEEDED: "execution.budget-exceeded",
  AUTHORITY_LOST: "execution.authority-lost",
  RESOURCE_EXCEEDED: "execution.resource-exceeded",
}

export function terminalEventFor(state: string): ExecutionEventType | null {
  return TERMINAL_EVENT[state] ?? null
}

/**
 * [P1 M16] Satu-satunya definisi "event ini terminal".
 *
 * Sebelumnya M12 menyalin daftar tujuh tipe terminal ke modulnya sendiri; begitu
 * suatu state terminal baru ditambah, M12 akan diam-diam gagal mengenali bukti
 * terminal dan menafsirkannya sebagai `UNKNOWN`. Satu taksonomi, satu predicate —
 * dan konsumennya (M12) memakai yang ini, bukan daftarnya sendiri.
 */
const TERMINAL_EVENT_VALUES: ReadonlySet<string> = new Set(Object.values(TERMINAL_EVENT))

export function isTerminalEventType(type: unknown): type is ExecutionEventType {
  return typeof type === "string" && TERMINAL_EVENT_VALUES.has(type)
}

/** Sumber provenance. Label asal observasi — BUKAN klaim authority. */
export type EventSource =
  | "kernel"
  | "supervisor"
  | "backend"
  | "host"
  | "user"
  | "agent"
  | "scheduler"
  | "test"

export interface ExecutionEvent {
  readonly eventId: string
  readonly eventType: ExecutionEventType
  readonly executionId: string
  readonly parentExecutionId?: string
  readonly lineageRootId: string
  /** ms epoch (observasi; BUKAN ordering authority). */
  readonly timestamp: number
  /** Urutan emit dalam plane ini (monotonik per-plane; BUKAN global). */
  readonly eventSequence: number
  /** Versi state otoritatif yang diobservasi (domain Kernel; ≠ eventSequence). */
  readonly executionVersion: number
  readonly source: EventSource
  readonly causality?: string
  readonly reason?: string
  readonly state?: string
  readonly previousState?: string
  readonly attempt?: number
  readonly generation?: number
  readonly supersedes?: string
  /** Metadata korelasi tambahan TANPA secret/prompt/history/output. */
  readonly metadata?: Readonly<Record<string, string>>
}

export interface EventInput {
  readonly eventType: ExecutionEventType
  readonly executionId: string
  readonly parentExecutionId?: string
  readonly lineageRootId: string
  readonly executionVersion: number
  readonly source: EventSource
  readonly causality?: string
  readonly reason?: string
  readonly state?: string
  readonly previousState?: string
  readonly attempt?: number
  readonly generation?: number
  readonly supersedes?: string
  readonly metadata?: Record<string, string>
  readonly timestamp?: number
}

export interface EventPlaneMetrics {
  readonly emitted: number
  readonly subscriberErrors: number
  readonly nestedDrops: number
  readonly subscribers: number
}

export type EventHandler = (event: ExecutionEvent) => void

/**
 * Guard reentransi sinkron: nested emit diizinkan (deterministik, terurut),
 * tetapi kedalaman dibatasi agar observer hostile tak meledakkan stack atau
 * deadlock. Batas = safety valve terdokumentasi, bukan policy lifecycle.
 */
export const MAX_EVENT_NESTING = 8

export interface EventPlane {
  /** Bangun + emit event (frozen). Tak pernah melempar karena observer. */
  emit(input: EventInput): ExecutionEvent
  /** Langganan sinkron; kembalikan unsubscribe. */
  subscribe(handler: EventHandler): () => void
  metrics(): EventPlaneMetrics
}

function isValidEventId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  )
}

export function createEventPlane(): EventPlane {
  const handlers = new Set<EventHandler>()
  let sequence = 0
  let nesting = 0
  const m = { emitted: 0, subscriberErrors: 0, nestedDrops: 0 }

  return {
    emit(input: EventInput): ExecutionEvent {
      if (!input || typeof input.executionId !== "string" || input.executionId.length === 0)
        throw new Error("event-plane.emit: executionId is required")
      if (!input.eventType || !input.lineageRootId || !input.source)
        throw new Error("event-plane.emit: eventType + lineageRootId + source are required")
      if (nesting >= MAX_EVENT_NESTING) {
        m.nestedDrops++
        throw new Error("event-plane.emit: nesting limit exceeded (hostile re-entrancy dropped)")
      }
      sequence++
      const event: ExecutionEvent = Object.freeze({
        eventId: `evt_${randomUUID()}`,
        eventType: input.eventType,
        executionId: input.executionId,
        ...(input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : {}),
        lineageRootId: input.lineageRootId,
        timestamp: input.timestamp ?? Date.now(),
        eventSequence: sequence,
        executionVersion: input.executionVersion,
        source: input.source,
        ...(input.causality !== undefined ? { causality: input.causality } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.previousState !== undefined ? { previousState: input.previousState } : {}),
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
        ...(input.generation !== undefined ? { generation: input.generation } : {}),
        ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
        ...(input.metadata ? { metadata: Object.freeze({ ...input.metadata }) } : {}),
      })
      m.emitted++
      nesting++
      try {
        for (const h of [...handlers]) {
          try {
            h(event)
          } catch {
            // Isolasi observer: satu gagal, lainnya tetap jalan; emit tak gagal.
            m.subscriberErrors++
          }
        }
      } finally {
        nesting--
      }
      return event
    },

    subscribe(handler: EventHandler): () => void {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },

    metrics(): EventPlaneMetrics {
      return {
        emitted: m.emitted,
        subscriberErrors: m.subscriberErrors,
        nestedDrops: m.nestedDrops,
        subscribers: handlers.size,
      }
    },
  }
}

// ── Bridge Kernel → plane (observasi pasca-commit; TANPA keputusan validitas) ──

export interface KernelTransitionRecord {
  readonly executionId: string
  readonly parentExecutionId?: string
  readonly rootExecutionId: string
  readonly version: number
  readonly from: string
  readonly to: string
  readonly reason: string
  readonly source: string
  readonly causality?: string
}

/**
 * Terjemahkan SATU commit otoritatif menjadi SATU event observasi.
 * Dipanggil SETELAH kernel commit sukses (oleh pemilik integrasi; M10 tak
 * memasang hook sendiri ke kernel produksi — staging prepared-but-controlled).
 * Terminal → tipe terminal spesifik; non-terminal → execution.state-changed.
 * Tak pernah memutuskan validitas (itu sudah terjadi di kernel).
 */
export function executionEventFromCommit(
  plane: EventPlane,
  commit: KernelTransitionRecord,
  opts?: { source?: EventSource; timestamp?: number },
): ExecutionEvent {
  const terminal = terminalEventFor(commit.to)
  return plane.emit({
    eventType: terminal ?? "execution.state-changed",
    executionId: commit.executionId,
    ...(commit.parentExecutionId ? { parentExecutionId: commit.parentExecutionId } : {}),
    lineageRootId: commit.rootExecutionId,
    executionVersion: commit.version,
    source: opts?.source ?? "kernel",
    ...(commit.causality !== undefined ? { causality: commit.causality } : {}),
    reason: commit.reason,
    state: commit.to,
    previousState: commit.from,
    ...(opts?.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
  })
}

export { isValidEventId }
