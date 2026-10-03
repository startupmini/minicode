// M8 — Execution Kernel: SATU-SATUNYA authoritative lifecycle owner.
//
// Kenapa berkas ini ada (P1 ADR-001/010, M8): sebelum M8, lifecycle execution
// implisit/tersebar — vendor Session memiliki turn loop, Host memiliki guard
// host-level, Registry menahan snapshot observasi — tanpa satu otoritas yang
// memvalidasi + meng-commit transisi lifecycle. Modul ini adalah otoritas itu.
//
// Prinsip yang dikunci (jangan dilonggarkan tanpa ADR baru):
//   Kernel decides. Host requests. Registry observes. Backend reports. Agent interprets.
// - SATU stream transisi serial per Execution: semua mutasi melewati SATU fungsi
//   commit() sinkron (JS run-to-completion = serialisasi; tanpa mutex/thread).
//   Commit point = mutasi state atomik di sini — BUKAN network/callback/event/
//   registry/backend/scheduler arrival. First committed terminal wins.
// - Terminal sticky absolut: sesudah terminal, SEMUA request terminal berikutnya
//   = duplicate_terminal_ignored (sama) / late_result_ignored (beda); SEMUA
//   request non-terminal = rejected. Tak ada COMPLETED→CANCELLED (atau sebaliknya).
// - Reason + provenance WAJIB (non-empty reason, source label, timestamp, order).
//   Timeout/budget/authority/resource TAK PERNAH collapse ke FAILED generik.
// - WAITING→COMPLETED langsung DITOLAK (completion harus lewat RESUMED→RUNNING;
//   RESUMED transient yang di-commit, bukan dilewat). RESUMED→CANCELLING
//   diizinkan (cancel harus servable dari semua non-terminal).
// - BUKAN: supervisor/retry (M9), persistence (M11), recovery (M12), scheduler
//   bridge (M13), TUI/CLI/SQLite/journal/policy/agent-reasoning. Tak ada import
//   selain M1 identity (+ node:crypto untuk id bila caller tak memberi).
// - Vendor Session TAK DISENTUH (engine internal, bukan authority baru);
//   Host/Registry/Backend TAK DIUBAH di sini (integrasi = requestTransition
//   seam, wiring milik M9/M14/M15). Live process resume BUKAN P1. //
//   [P1 M16] Id yang di-mint memakai allocator M1 (anti-tabrakan + metrik), bukan
//   randomUUID inline: dua tempat men-*cetak* id eksekusi = dua authority. Jalur ini,
//   yang paling sering dipakai produksi (M15 admission), kini ter-meterik dan
//   collision-safe seperti yang lain.

import { allocateUniqueExecutionId, type ExecutionKind, isExecutionId } from "./execution-id.ts"

/** Non-terminal lifecycle states (otoritas Kernel). */
export type ExecutionLifecycleState =
  | "CREATED"
  | "ADMITTED"
  | "RUNNING"
  | "WAITING"
  | "RESUMED"
  | "CANCELLING"
  | "TERMINATING"

/** Terminal lifecycle states — absorbing, immutable pasca-commit. */
export type ExecutionTerminalState =
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "BUDGET_EXCEEDED"
  | "AUTHORITY_LOST"
  | "RESOURCE_EXCEEDED"

export type ExecutionState = ExecutionLifecycleState | ExecutionTerminalState

const TERMINALS: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "BUDGET_EXCEEDED",
  "AUTHORITY_LOST",
  "RESOURCE_EXCEEDED",
])

export function isExecutionTerminalState(state: unknown): state is ExecutionTerminalState {
  return typeof state === "string" && TERMINALS.has(state)
}

/**
 * Tabel transisi eksplisit (otoritatif). BUKAN dokumentasi — validator
 * menggunakannya sebagai satu-satunya kebenaran legalitas.
 * Penyimpangan sadar dari draft: WAITING→COMPLETED langsung DITOLAK (harus
 * lewat RESUMED→RUNNING); RESUMED→CANCELLING DIIZINKAN (cancel servable dari
 * semua non-terminal). Keduanya didokumentasikan + diuji.
 */
const TRANSITIONS: Record<ExecutionLifecycleState, ReadonlySet<ExecutionState>> = {
  CREATED: new Set(["ADMITTED", "CANCELLING"]),
  ADMITTED: new Set(["RUNNING", "CANCELLING", "RESOURCE_EXCEEDED"]),
  RUNNING: new Set([
    "WAITING",
    "CANCELLING",
    "TERMINATING",
    "COMPLETED",
    "FAILED",
    "RESOURCE_EXCEEDED",
  ]),
  WAITING: new Set(["RESUMED", "CANCELLING", "RESOURCE_EXCEEDED"]),
  RESUMED: new Set(["RUNNING", "CANCELLING", "RESOURCE_EXCEEDED"]),
  CANCELLING: new Set([
    "CANCELLED",
    "TIMED_OUT",
    "BUDGET_EXCEEDED",
    "AUTHORITY_LOST",
    "RESOURCE_EXCEEDED",
  ]),
  TERMINATING: new Set(["CANCELLED", "FAILED", "RESOURCE_EXCEEDED"]),
}

export function isLegalTransition(from: ExecutionState, to: ExecutionState): boolean {
  if (isExecutionTerminalState(from)) return false
  return TRANSITIONS[from as ExecutionLifecycleState]?.has(to) ?? false
}

/** Sumber request yang diizinkan (ekstensibel M13; TANPA policy di sini). */
export type TransitionRequestSource =
  | "host"
  | "scheduler"
  | "backend"
  | "timeout"
  | "budget"
  | "parent"
  | "verifier"
  | "agent-loop"
  | "supervisor"
  | "test"

/** Alasan pembatalan kanonis → terminal mapping (tak pernah FAILED generik). */
export type CancelReason =
  | "user"
  | "timeout"
  | "budget"
  | "authority"
  | "resource"
  | "parent"
  | "shutdown"

export function terminalForCancelReason(reason: CancelReason): ExecutionTerminalState {
  switch (reason) {
    case "timeout":
      return "TIMED_OUT"
    case "budget":
      return "BUDGET_EXCEEDED"
    case "authority":
      return "AUTHORITY_LOST"
    case "resource":
      return "RESOURCE_EXCEEDED"
    case "user":
    case "parent":
    case "shutdown":
      return "CANCELLED"
  }
}

/** Request transisi: data inert (BUKAN commit). Commit hanya via kernel. */
export interface TransitionRequest {
  readonly executionId: string
  readonly to: ExecutionState
  /** Wajib non-empty (provenance; penolakan tanpa alasan = invalid). */
  readonly reason: string
  readonly source: TransitionRequestSource
  readonly causality?: string
}

export interface TransitionProvenance {
  readonly reason: string
  readonly source: TransitionRequestSource
  readonly causality?: string
  /** Timestamp commit (Date.now; observasi, bukan ordering authority). */
  readonly at: number
  /** Counter monotonik per-execution (ordering authority dalam execution). */
  readonly order: number
}

export interface ExecutionRecord {
  readonly executionId: string
  readonly parentExecutionId?: string
  readonly rootExecutionId: string
  readonly kind: ExecutionKind
  readonly ownerId: string
  readonly state: ExecutionState
  readonly reason: string | null
  readonly provenance: TransitionProvenance | null
  readonly createdAt: number
  readonly updatedAt: number
  /** Counter transisi monotonik (naik tiap commit; terminal tak mereset). */
  readonly version: number
  readonly terminalAt: number | null
}

export interface KernelTransitionEvent {
  readonly executionId: string
  readonly from: ExecutionState
  readonly to: ExecutionState
  readonly reason: string
  readonly source: TransitionRequestSource
  readonly order: number
  readonly at: number
}

export type TransitionResult =
  | { readonly committed: true; readonly record: ExecutionRecord }
  | {
      readonly committed: false
      readonly outcome: "rejected-invalid" | "duplicate-terminal-ignored" | "late-result-ignored"
      readonly current: ExecutionRecord
    }

export interface KernelMetrics {
  readonly transitionAccepted: number
  readonly transitionRejected: number
  readonly terminalCommitted: number
  readonly duplicateTerminalIgnored: number
  readonly lateResultIgnored: number
  readonly invalidTransition: number
  readonly observerErrors: number
  readonly executions: number
}

function freezeRecord(r: ExecutionRecord): ExecutionRecord {
  return Object.freeze({ ...r })
}

export interface ExecutionKernel {
  /** Buat execution CREATED (mint id M1 bila absent; validasi bentuk). */
  create(spec: {
    executionId?: string
    parentExecutionId?: string
    rootExecutionId?: string
    kind: ExecutionKind
    ownerId: string
  }): ExecutionRecord
  /**
   * Minta transisi. SATU-SATUNYA penulis state. Sinkron-atomik: validasi +
   * mutasi dalam satu section run-to-completion (serialisasi tanpa mutex).
   */
  requestTransition(req: TransitionRequest): TransitionResult
  /** Snapshot frozen copy atau undefined (observasi; bukan authority kedua). */
  get(executionId: string): ExecutionRecord | undefined
  /** Hook observasi transisi (M10/M11/registry future). Throw terisolasi. */
  onTransition(handler: (event: KernelTransitionEvent) => void): () => void
  metrics(): KernelMetrics
}

export function createExecutionKernel(): ExecutionKernel {
  const store = new Map<string, ExecutionRecord>()
  const handlers = new Set<(event: KernelTransitionEvent) => void>()
  const m = {
    transitionAccepted: 0,
    transitionRejected: 0,
    terminalCommitted: 0,
    duplicateTerminalIgnored: 0,
    lateResultIgnored: 0,
    invalidTransition: 0,
    observerErrors: 0,
  }

  const emit = (event: KernelTransitionEvent): void => {
    for (const h of [...handlers]) {
      try {
        h(event)
      } catch {
        // Observer throw terisolasi: commit tak terpengaruh (kontrak bus M2).
        m.observerErrors++
      }
    }
  }

  // Commit point KANONIS: satu-satunya mutasi state. Sinkron penuh —
  // tak ada await/yield antara baca-CAS-tulis (serialisasi struktural).
  const commit = (
    current: ExecutionRecord,
    to: ExecutionState,
    reason: string,
    source: TransitionRequestSource,
    causality: string | undefined,
    now: number,
  ): ExecutionRecord => {
    const version = current.version + 1
    const terminal = isExecutionTerminalState(to)
    const next: ExecutionRecord = freezeRecord({
      ...current,
      state: to,
      reason,
      provenance: Object.freeze({
        reason,
        source,
        ...(causality !== undefined ? { causality } : {}),
        at: now,
        order: version,
      }),
      updatedAt: now,
      version,
      terminalAt: terminal ? now : current.terminalAt,
    })
    store.set(current.executionId, next)
    m.transitionAccepted++
    if (terminal) m.terminalCommitted++
    emit({
      executionId: current.executionId,
      from: current.state,
      to,
      reason,
      source,
      order: version,
      at: now,
    })
    return next
  }

  return {
    create(spec: {
      executionId?: string
      parentExecutionId?: string
      rootExecutionId?: string
      kind: ExecutionKind
      ownerId: string
    }): ExecutionRecord {
      const executionId = spec.executionId ?? allocateUniqueExecutionId(store)
      if (!isExecutionId(executionId)) throw new Error("kernel.create: invalid executionId")
      if (store.has(executionId))
        throw new Error("kernel.create: duplicate executionId (no overwrite)")
      if (spec.parentExecutionId !== undefined && !isExecutionId(spec.parentExecutionId))
        throw new Error("kernel.create: invalid parentExecutionId (no guessing)")
      const rootExecutionId = spec.rootExecutionId ?? executionId
      if (!isExecutionId(rootExecutionId)) throw new Error("kernel.create: invalid rootExecutionId")
      if (!spec.kind || !spec.ownerId) throw new Error("kernel.create: kind + ownerId required")
      const now = Date.now()
      const rec = freezeRecord({
        executionId,
        ...(spec.parentExecutionId ? { parentExecutionId: spec.parentExecutionId } : {}),
        rootExecutionId,
        kind: spec.kind,
        ownerId: spec.ownerId,
        state: "CREATED" as const,
        reason: null,
        provenance: null,
        createdAt: now,
        updatedAt: now,
        version: 0,
        terminalAt: null,
      })
      store.set(executionId, rec)
      return freezeRecord({ ...rec })
    },

    requestTransition(req: TransitionRequest): TransitionResult {
      const now = Date.now()
      const current = typeof req?.executionId === "string" ? store.get(req.executionId) : undefined
      // Bentuk tak-valid / execution tak dikenal / reason kosong = programmer
      // error fail-closed (throw deterministik, TANPA mutasi). Invalid TABLE
      // pada execution dikenal = return rejected (di bawah).
      if (
        !current ||
        typeof req?.to !== "string" ||
        typeof req?.reason !== "string" ||
        req.reason.length === 0
      ) {
        throw new Error(
          "kernel.requestTransition: unknown execution or empty reason (no silent coerce)",
        )
      }
      // Terminal state: SEMUA request berikutnya adalah observasi audit, bukan transisi.
      if (isExecutionTerminalState(current.state)) {
        if (current.state === req.to) {
          m.duplicateTerminalIgnored++
          return {
            committed: false,
            outcome: "duplicate-terminal-ignored",
            current: freezeRecord({ ...current }),
          }
        }
        m.lateResultIgnored++
        return {
          committed: false,
          outcome: "late-result-ignored",
          current: freezeRecord({ ...current }),
        }
      }
      if (!isLegalTransition(current.state, req.to)) {
        m.transitionRejected++
        m.invalidTransition++
        return {
          committed: false,
          outcome: "rejected-invalid",
          current: freezeRecord({ ...current }),
        }
      }
      const record = commit(current, req.to, req.reason, req.source, req.causality, now)
      return { committed: true, record: freezeRecord({ ...record }) }
    },

    get(executionId: string): ExecutionRecord | undefined {
      const rec = store.get(executionId)
      return rec ? freezeRecord({ ...rec }) : undefined
    },

    onTransition(handler: (event: KernelTransitionEvent) => void): () => void {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },

    metrics(): KernelMetrics {
      return {
        transitionAccepted: m.transitionAccepted,
        transitionRejected: m.transitionRejected,
        terminalCommitted: m.terminalCommitted,
        duplicateTerminalIgnored: m.duplicateTerminalIgnored,
        lateResultIgnored: m.lateResultIgnored,
        invalidTransition: m.invalidTransition,
        observerErrors: m.observerErrors,
        executions: store.size,
      }
    },
  }
}

// ── Translation boundary: observasi backend → request lifecycle (murni) ──

export type BackendObservationKind =
  | "completed"
  | "failed"
  | "proven-dead"
  | "timeout"
  | "vanished"
  | "unknown"
  | "orphan"

/**
 * Terjemahkan hasil fisik backend menjadi request lifecycle — atau null
 * (TANPA klaim lifecycle). Aturan jujur:
 * - "completed" self-exit → COMPLETED hanya dari RUNNING/WAITING (WAITING lewat
 *   rantai RESUMED di lapisan pemanggil; helper ini tak melompati rantai).
 * - "failed" → FAILED (RUNNING saja; WAITING butuh konteks approval — null).
 * - "proven-dead" → CANCELLING dengan reason pemanggil (terminal datang dari
 *   reason, bukan dari fakta mati). Tanpa reason aktif → null.
 * - "timeout"/"vanished"/"unknown"/"orphan" → null (dilaporkan ke M9/M12,
 *   bukan lifecycle). Timeout WAIT backend ≠ timeout deadline runtime.
 */
export function translateBackendObservation(
  state: ExecutionState,
  observation: BackendObservationKind,
  activeCancelReason?: string,
): { to: ExecutionState; reason: string } | null {
  if (isExecutionTerminalState(state)) return null
  switch (observation) {
    case "completed":
      if (state === "RUNNING") return { to: "COMPLETED", reason: "backend reported completion" }
      return null
    case "failed":
      if (state === "RUNNING") return { to: "FAILED", reason: "backend reported failure" }
      return null
    case "proven-dead":
      if ((state === "RUNNING" || state === "WAITING" || state === "RESUMED") && activeCancelReason)
        return { to: "CANCELLING", reason: activeCancelReason }
      return null
    case "timeout":
    case "vanished":
    case "unknown":
    case "orphan":
      return null
  }
}
