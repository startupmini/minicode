// M4 — RuntimeHost lifecycle: HOST FSM eksplisit, BUKAN execution FSM.
//
// Kenapa berkas ini berubah (P1 ADR-001/010, M4): facade M3 hanya punya guard
// boolean (started/closed/latch) sehingga urutan shutdown/drain/close implisit.
// M4 memberi Host lifecycle internal yang deterministik agar admission dan
// shutdown dapat diputuskan tanpa menebak — tanpa mengambil alih lifecycle
// individual Execution (otoritas itu milik Kernel, M8).
//
// Distinction yang dikunci (jangan dicampur tanpa ADR baru):
//   Host FSM   : CREATED → STARTING → READY → DRAINING → CLOSING → CLOSED
//                = lifecycle RuntimeHost (apakah host menerima request baru).
//   Eksekusi   : CREATED → ADMITTED → RUNNING → … (M8, BUKAN di sini).
// Host tak pernah memutuskan COMPLETED/FAILED/CANCELLED/TIMED_OUT eksekusi.
//
// Aturan yang dikunci:
// - Delegation-only M3 dipertahankan (run = delegate terinjeksi, verbatim).
// - Admission HANYA di READY; DRAINING/CLOSING/CLOSED/STARTING/CREATED menolak
//   deterministik (DRAINING dihitung admissionRejectedDuringDrain).
// - run() baru HANYA di READY; in-flight (promise delegate yang sudah jalan)
//   tak tersentuh host (host tak memegang cancellation — itu M4-out/M8).
// - shutdown(): READY→DRAINING (+DRAINING→DRAINING idempoten); hook sekali,
//   timeout-bound, gagal → tetap DRAINING + degraded + rethrow (tak pernah
//   resurrect ke READY).
// - close(): READY/DRAINING→CLOSING→CLOSED; hook sekali; gagal → tetap CLOSED
//   + degraded + rethrow; close ganda/join = no-op; CREATED→throw.
// - Hook timeout default 30 dtk = CONSERVATIVE BORROWED bound (orde sama dengan
//   timeout MCP/bash 30 dtk di repo), BUKAN angka terukur — UNKNOWN register:
//   butuh kalibrasi beban; configurable via options. Tanpa bound, hook gantung
//   = shutdown gantung; dengan bound, keterlambatan = degraded, bukan hang.
// - Signal seam: shutdown()/close() aman dipanggil dari callback sinyal
//   (idempoten, bounded, tak throw pada pengulangan); Host TIDAK memasang
//   process.on sendiri dan TIDAK memutuskan SIGINT=abort vs shutdown (itu
//   policy mode CLI: TUI vs non-interaktif). Wiring milik composition root.
// - Tanpa import baru: tetap observation plane (M1/M2) — H12 dipertahankan.

import {
  createChildCorrelation,
  createRootCorrelation,
  type ExecutionCorrelation,
  type ExecutionKind,
} from "./execution-id.ts"
import {
  createExecutionRegistry,
  type ExecutionRegistry,
  type ExecutionSnapshot,
  type ExecutionSummary,
} from "./execution-registry.ts"

/** Delegate eksekusi existing (mis. session.run). Dipilih pemanggil, bukan Host. */
export type HostRunDelegate<TInput = unknown, TResult = unknown> = (
  input: TInput,
  opts: { signal?: AbortSignal },
) => Promise<TResult>

export interface RuntimeHostHooks {
  /** Dipanggil SEKALI saat transisi ke READY (sync; throw = tetap CREATED). */
  readonly onStart?: () => void
  /** Dipanggil SEKALI saat shutdown() pertama (boleh async; timeout-bound). */
  readonly onShutdown?: () => void | Promise<void>
  /** Dipanggil SEKALI saat close() pertama (boleh async; timeout-bound). */
  readonly onClose?: () => void | Promise<void>
}

/** Host lifecycle — HANYA lifecycle host, bukan execution (M8 memisahkan). */
export type HostLifecycleState =
  | "CREATED"
  | "STARTING"
  | "READY"
  | "DRAINING"
  | "CLOSING"
  | "CLOSED"

export interface RuntimeHostOptions {
  /** Registry observasi (default: instance baru milik host). */
  readonly registry?: ExecutionRegistry
  /** Runner default (mis. session.run existing). Absent = run() throw loud. */
  readonly runner?: HostRunDelegate
  readonly hooks?: RuntimeHostHooks
  /** Bound hook shutdown ms (default 30_000 borrowed-conservative; UNKNOWN kalibrasi). */
  readonly shutdownHookTimeoutMs?: number
  /** Bound hook close ms (default 30_000 borrowed-conservative; UNKNOWN kalibrasi). */
  readonly closeHookTimeoutMs?: number
}

export interface HostAdmissionSpec {
  readonly kind: ExecutionKind
  /** Owner menurut arsitektur; bukan authority user input (otorisasi tetap policy). */
  readonly ownerId: string
  readonly parent?: ExecutionCorrelation
  readonly deadlineRef?: number
  readonly budgetRef?: string
  readonly backendRef?: string
}

export interface HostMetrics {
  readonly state: HostLifecycleState
  readonly started: boolean
  readonly closed: boolean
  readonly shutdownRequested: boolean
  readonly admitted: number
  readonly runs: number
  readonly runErrors: number
  readonly closes: number
  readonly shutdowns: number
  readonly registryEntries: number
  readonly startCount: number
  readonly admissionRejectedDuringDrain: number
  readonly hookFailures: number
  readonly lastShutdownDurationMs: number | null
  readonly lastCloseDurationMs: number | null
}

export interface RuntimeHost {
  /** CREATED→STARTING→READY (onStart throw = tetap CREATED + error propagates). */
  start(): void
  /** Lifecycle state host saat ini (observasi; bukan execution state). */
  state(): HostLifecycleState
  /**
   * Observasi admission — HANYA di READY. BUKAN admission FSM otoritatif
   * (itu M4-gate + M8): membuat korelasi M1 + snapshot "ADMITTED" M2.
   */
  admit(spec: HostAdmissionSpec): ExecutionCorrelation
  /**
   * Delegasikan eksekusi — HANYA di READY. Hasil/error verbatim; tanpa retry.
   */
  run<TInput, TResult>(
    input: TInput,
    opts?: { runner?: HostRunDelegate<TInput, TResult>; signal?: AbortSignal },
  ): Promise<TResult>
  /** Observasi: frozen copy atau undefined. */
  inspect(executionId: string): ExecutionSnapshot | undefined
  /** Observasi: ringkasan terurut. */
  list(): ExecutionSummary[]
  /** Metrik host + registry (copy). */
  metrics(): { host: HostMetrics; registryEntries: number }
  /** READY→DRAINING (idempoten); hook sekali, timeout-bound, gagal→degraded. */
  shutdown(): Promise<{
    shutdownRequested: true
    observedEntries: number
    state: HostLifecycleState
  }>
  /** READY/DRAINING→CLOSING→CLOSED; hook sekali; idempoten; gagal→degraded. */
  close(): Promise<void>
}

/**
 * Batas hook konservatif default (ms). BORROWED, bukan terukur: orde sama
 * dengan timeout MCP/bash 30 dtk yang sudah ada di repo. UNKNOWN register:
 * kalibrasi beban diperlukan sebelum dianggap SLA.
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000

async function runHookBounded(
  hook: (() => void | Promise<void>) | undefined,
  timeoutMs: number,
  label: string,
): Promise<{ ok: boolean; durationMs: number }> {
  const t0 = Date.now()
  if (!hook) return { ok: true, durationMs: Date.now() - t0 }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => hook()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`runtime-host: ${label} hook timeout`)),
          timeoutMs,
        )
      }),
    ])
    return { ok: true, durationMs: Date.now() - t0 }
  } catch {
    return { ok: false, durationMs: Date.now() - t0 }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createRuntimeHost(opts: RuntimeHostOptions = {}): RuntimeHost {
  const registry = opts.registry ?? createExecutionRegistry()
  const boundRunner = opts.runner
  const hooks = opts.hooks
  const shutdownHookTimeoutMs = opts.shutdownHookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const closeHookTimeoutMs = opts.closeHookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  // CREATED = factory return, belum start (bagian rantai CREATION→STARTING).
  let state: HostLifecycleState = "CREATED"
  let hooksStarted = false
  let hooksClosed = false
  let hooksShutdown = false
  const m = {
    admitted: 0,
    runs: 0,
    runErrors: 0,
    closes: 0,
    shutdowns: 0,
    startCount: 0,
    admissionRejectedDuringDrain: 0,
    hookFailures: 0,
    lastShutdownDurationMs: null as number | null,
    lastCloseDurationMs: null as number | null,
  }

  const metricsSnapshot = (): { host: HostMetrics; registryEntries: number } => ({
    host: {
      state,
      started: state !== "CREATED" && state !== "STARTING",
      closed: state === "CLOSED",
      shutdownRequested: state === "DRAINING" || state === "CLOSING" || state === "CLOSED",
      admitted: m.admitted,
      runs: m.runs,
      runErrors: m.runErrors,
      closes: m.closes,
      shutdowns: m.shutdowns,
      registryEntries: registry.size(),
      startCount: m.startCount,
      admissionRejectedDuringDrain: m.admissionRejectedDuringDrain,
      hookFailures: m.hookFailures,
      lastShutdownDurationMs: m.lastShutdownDurationMs,
      lastCloseDurationMs: m.lastCloseDurationMs,
    },
    registryEntries: registry.size(),
  })

  return {
    start(): void {
      if (state === "READY") return
      if (state === "CLOSED" || state === "CLOSING" || state === "DRAINING")
        throw new Error(`runtime-host: start() in ${state} (no resurrection)`)
      if (state === "STARTING") throw new Error("runtime-host: reentrant start() in STARTING")
      // CREATED → STARTING. Sinkron: tak ada interleaving; reentransi via
      // onStart yang memanggil start() ditolak deterministik di atas.
      state = "STARTING"
      if (!hooksStarted) {
        hooksStarted = true
        try {
          hooks?.onStart?.()
        } catch (e) {
          // Init gagal = tak pernah READY; kembali CREATED agar retry mungkin.
          // Error diteruskan (tak ditelan); tanpa state baru (M4 melarang).
          state = "CREATED"
          hooksStarted = false
          throw e
        }
      }
      state = "READY"
      m.startCount++
    },

    state(): HostLifecycleState {
      return state
    },

    admit(spec: HostAdmissionSpec): ExecutionCorrelation {
      if (state !== "READY") {
        if (state === "DRAINING") m.admissionRejectedDuringDrain++
        throw new Error(`runtime-host: admit() in ${state} (admission only in READY)`)
      }
      if (!spec?.kind || !spec.ownerId)
        throw new Error("runtime-host: admit() requires kind and ownerId (never user authority)")
      const correlation = spec.parent
        ? createChildCorrelation(spec.parent, spec.kind, spec.ownerId)
        : createRootCorrelation(spec.kind, spec.ownerId)
      registry.observe({
        executionId: correlation.executionId,
        ...(correlation.parentExecutionId
          ? { parentExecutionId: correlation.parentExecutionId }
          : {}),
        rootExecutionId: correlation.rootExecutionId,
        kind: correlation.kind,
        ownerId: correlation.ownerId,
        stateSnapshot: "ADMITTED",
        ...(spec.deadlineRef !== undefined ? { deadlineRef: spec.deadlineRef } : {}),
        ...(spec.budgetRef !== undefined ? { budgetRef: spec.budgetRef } : {}),
        ...(spec.backendRef !== undefined ? { backendRef: spec.backendRef } : {}),
      })
      m.admitted++
      return correlation
    },

    async run<TInput, TResult>(
      input: TInput,
      callOpts?: { runner?: HostRunDelegate<TInput, TResult>; signal?: AbortSignal },
    ): Promise<TResult> {
      // run() baru = admission kerja baru → HANYA di READY. In-flight (promise
      // delegate yang sudah di-await) tak tersentuh host (bukan authority).
      if (state !== "READY")
        throw new Error(`runtime-host: run() in ${state} (new runs only in READY)`)
      const runner = (callOpts?.runner ?? boundRunner) as
        | HostRunDelegate<TInput, TResult>
        | undefined
      if (!runner)
        throw new Error(
          "runtime-host: run() with no runner bound (M3 facade delegates only — bind existing session.run; never invents execution)",
        )
      m.runs++
      try {
        return await runner(input, { ...(callOpts?.signal ? { signal: callOpts.signal } : {}) })
      } catch (e) {
        m.runErrors++
        throw e
      }
    },

    inspect(executionId: string): ExecutionSnapshot | undefined {
      if (state === "CREATED" || state === "STARTING" || state === "CLOSED") return undefined
      return registry.inspect(executionId)
    },

    list(): ExecutionSummary[] {
      if (state === "CREATED" || state === "STARTING" || state === "CLOSED") return []
      return registry.list()
    },

    metrics(): { host: HostMetrics; registryEntries: number } {
      return metricsSnapshot()
    },

    async shutdown(): Promise<{
      shutdownRequested: true
      observedEntries: number
      state: HostLifecycleState
    }> {
      if (state !== "READY" && state !== "DRAINING")
        throw new Error(`runtime-host: shutdown() in ${state}`)
      // Latch dulu (admit ditolak deterministik), baru hook — urutan ini yang
      // membuat admit+shutdown konkuren deterministik.
      state = "DRAINING"
      m.shutdowns++
      if (!hooksShutdown) {
        hooksShutdown = true
        const r = await runHookBounded(hooks?.onShutdown, shutdownHookTimeoutMs, "shutdown")
        m.lastShutdownDurationMs = r.durationMs
        if (!r.ok) m.hookFailures++
      }
      // Gagal hook = degraded + tetap DRAINING; TAK PERNAH resurrect ke READY.
      // Error hook tak ditelan-tanpa-jejak: tercatat di hookFailures +
      // lastShutdownDurationMs (observability), transisi tetap selesai agar
      // shutdown total dan bounded (hook melempar tak boleh membuat shutdown
      // harus diulang — itu lifecycle-nya sendiri).
      return { shutdownRequested: true as const, observedEntries: registry.size(), state }
    },

    async close(): Promise<void> {
      if (state === "CLOSED" || state === "CLOSING") return
      if (state === "CREATED" || state === "STARTING")
        throw new Error(`runtime-host: close() in ${state}`)
      // READY/DRAINING → CLOSING. State dimajukan SEBELUM hook agar gagal hook
      // tak bisa resurrect; CLOSED ditetapkan di finally (selalu terminal).
      state = "CLOSING"
      m.closes++
      let hookError: unknown = null
      if (!hooksClosed) {
        hooksClosed = true
        const r = await runHookBounded(hooks?.onClose, closeHookTimeoutMs, "close")
        m.lastCloseDurationMs = r.durationMs
        if (!r.ok) {
          m.hookFailures++
          hookError = new Error("runtime-host: close hook failed (degraded, still CLOSED)")
        }
      }
      state = "CLOSED"
      if (hookError) throw hookError
    },
  }
}
