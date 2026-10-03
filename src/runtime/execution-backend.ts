// M5 — Execution backend adapter: interface + kapabilitas jujur + 4 backend.
//
// Kenapa berkas ini ada (P1 ADR-001, M5): runtime harus membedakan "apa yang
// seharusnya terjadi" (semantik runtime) dari "apa yang fisiknya mungkin"
// (mekanisme backend) TANPA mengetahui detail OS/proses/sandbox. Sebelum M5,
// pengetahuan itu tersebar di tools/bash.ts, sandbox/*, code_run, MCP/LSP
// client — tiap jalur punya kill/wait implisit sendiri.
//
// BUKAN: Execution FSM (M8), supervisor/retry (M9), persistence (M11),
// recovery (M12), scheduler bridge (M13), capability engine (M6), DAG/remote/
// live-resume. Aturan yang dikunci (jangan dilonggarkan tanpa ADR baru):
// - A/B/C/D TIDAK PERNAH sinonim. A+B = jaminan semantik runtime; C =
//   kontrak backend spesifik; D = hanya bila terbukti via wait+close.
//   `cancel requested ≠ terminated ≠ physical death proven`.
// - Tanpa retry di mana pun pada lapis ini (M9 yang memiliki retry).
// - Backend tak membuat executionId (M1); handle `be_*` = namespace backend
//   sendiri, opaque, non-user-controlled, bukan lifecycle authority.
// - Opaque handle: caller tak pernah memegang raw ChildProcess.
// - Sandbox shims membungkus runner existing run-to-completion; kill
//   preemptif mid-flight = unsupported yang DINYATAKAN (jujur, sesuai evidence
//   code_run: abort menghentikan penungguan, container bisa hidup sampai
//   timeout runner). Jangan klaim D untuk container.
// - MCP/LSP/background-jobs TIDAK dibungkus di sini (lifecycle berbeda:
//   closeAll/closeAllLsp tetap pemilik; background = tool scope, detached = M7).
// - Security parity: spawn SELALU via sanitizeSpawnEnv + resolveTrustedExecutable
//   (F-23), sama seperti jalur existing. Tak ada pelonggaran guard.

import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { sanitizeSpawnEnv } from "../policy/scrub.ts"
import { dockerAvailable, runInDocker } from "../sandbox/docker.ts"
import { osSandboxAvailable, osSandboxTypeName, runInOsSandbox } from "../sandbox/os.ts"

/** Backend fisik yang dikenal M5. Remote = deferred (bukan P1). */
export type BackendKind = "host" | "docker" | "bwrap" | "seatbelt"

/** Tingkat klaim kapabilitas — deklarasi jujur berbasis evidence, bukan asumsi. */
export type GuaranteeLevel = "SUPPORTED" | "BEST_EFFORT" | "UNSUPPORTED" | "UNKNOWN"

/**
 * B (logical execution stopped) BUKAN kapabilitas backend — ia adalah semantik
 * runtime (Kernel M8). Backend tak pernah menentukan lifecycle logis Execution;
 * ia hanya menyampaikan observasi fisik (cancel/termination requested, exited,
 * proven-dead, timeout, vanished, unknown, orphan) yang nanti diinterpretasi
 * runtime. Nilai tunggal ini mencegah B terisi SUPPORTED/BEST_EFFORT seolah
 * backend punya lifecycle authority (FINAL QA: B != backend capability).
 */
export type LogicalStopLevel = "DELEGATED_TO_RUNTIME"

export interface BackendCapability {
  /** A = stop waiting (observasi/pembatalan penungguan yang didukung backend). */
  readonly a: GuaranteeLevel
  /** B = SELALU DELEGATED_TO_RUNTIME (bukan kapabilitas backend). */
  readonly b: LogicalStopLevel
  /** C = backend termination requested (permintaan terminasi backend). */
  readonly c: GuaranteeLevel
  /** D = physical termination proven (kematian fisik terbukti). */
  readonly d: GuaranteeLevel
  readonly cpu: GuaranteeLevel
  readonly memory: GuaranteeLevel
  readonly pid: GuaranteeLevel
  readonly network: GuaranteeLevel
  readonly fs: GuaranteeLevel
  /** Bukti per-baris (file:line / perilaku teramati). */
  readonly notes: readonly string[]
}

/**
 * Matriks kapabilitas evidence-based (M5 §14). Dibaca dari invocation aktual,
 * bukan dari nama teknologi:
 * - host: killTree grup/taskkill ADA (bash.ts:96-124); tanpa flag CPU/mem/pids;
 *   network hanya guard; FS hanya jail pre-check (TOCTOU terdokumentasi).
 * - docker: invocation --cpus/--memory/--pids-limit/--network/--read-only ADA
 *   (docker.ts:58-87); kill eksplisit container TAK ADA (hanya wrapper SIGKILL).
 * - bwrap: --unshare-net/--die-with-parent/--cap-drop/bind ADA, tanpa limit
 *   CPU/mem/pids (os.ts:104-135). seatbelt: deny default + deny network* ADA,
 *   policy = restriksi BUKAN kill guarantee (os.ts:91-98).
 */
export const BACKEND_CAPABILITIES: Record<BackendKind, BackendCapability> = {
  host: {
    a: "SUPPORTED",
    b: "DELEGATED_TO_RUNTIME",
    c: "SUPPORTED",
    d: "BEST_EFFORT",
    cpu: "UNSUPPORTED",
    memory: "UNSUPPORTED",
    pid: "UNSUPPORTED",
    network: "UNSUPPORTED",
    fs: "BEST_EFFORT",
    notes: [
      "A: AbortSignal/close observation menghentikan waiter (bash.ts:334-348).",
      "B: DELEGATED_TO_RUNTIME — logical stop diputuskan runtime (Kernel M8); backend hanya berhenti menunggu.",
      "C: SIGTERM / taskkill /T /F / kill(-pid,SIGKILL) grup (bash.ts:96-124).",
      "D: BEST_EFFORT — daemonized double-fork lolos grup; klaim hanya via wait+close.",
      "CPU/memori/PID: tanpa flag enforcement di invocation host.",
      "Network: hanya bash-guard (bukan isolasi).",
      "FS: jail pre-check realpath; TOCTOU redirect-form terdokumentasi (bash.ts:215-222).",
    ],
  },
  docker: {
    a: "SUPPORTED",
    b: "DELEGATED_TO_RUNTIME",
    c: "BEST_EFFORT",
    d: "BEST_EFFORT",
    cpu: "SUPPORTED",
    memory: "SUPPORTED",
    pid: "SUPPORTED",
    network: "SUPPORTED",
    fs: "SUPPORTED",
    notes: [
      "A: timeout wrapper SIGKILL + close observation (docker.ts:116-127).",
      "B: DELEGATED_TO_RUNTIME — logical stop diputuskan runtime.",
      "C: BEST_EFFORT — kill eksplisit container TAK ADA di invocation; hanya wrapper.",
      "D: BEST_EFFORT — close wrapper ≠ bukti container mati; jangan klaim D container.",
      "CPU/mem/PID/net/FS: --cpus/--memory/--pids-limit 32/--network none/--read-only+cap-drop+user (docker.ts:58-87).",
    ],
  },
  bwrap: {
    a: "SUPPORTED",
    b: "DELEGATED_TO_RUNTIME",
    c: "SUPPORTED",
    d: "BEST_EFFORT",
    cpu: "UNSUPPORTED",
    memory: "UNSUPPORTED",
    pid: "UNSUPPORTED",
    network: "SUPPORTED",
    fs: "SUPPORTED",
    notes: [
      "A: timeout wrapper SIGKILL + close observation (os.ts:181-191).",
      "B: DELEGATED_TO_RUNTIME — logical stop diputuskan runtime.",
      "C: wrapper SIGKILL + --die-with-parent (os.ts:128-129).",
      "D: BEST_EFFORT — tanpa wait-proof namespace; jangan klaim D.",
      "CPU/mem/PID: tanpa flag limit di invocation.",
      "Network: --unshare-net (bridge opt-out terdokumentasi).",
      "FS: --ro-bind/--bind/--tmpfs/--cap-drop ALL.",
    ],
  },
  seatbelt: {
    a: "SUPPORTED",
    b: "DELEGATED_TO_RUNTIME",
    c: "SUPPORTED",
    d: "BEST_EFFORT",
    cpu: "UNSUPPORTED",
    memory: "UNSUPPORTED",
    pid: "UNSUPPORTED",
    network: "SUPPORTED",
    fs: "SUPPORTED",
    notes: [
      "A: timeout wrapper SIGKILL + close observation (os.ts:181-191).",
      "B: DELEGATED_TO_RUNTIME — logical stop diputuskan runtime.",
      "C: wrapper SIGKILL; policy seatbelt = RESTRIKSI, bukan kill guarantee.",
      "D: BEST_EFFORT — jangan samakan policy dengan physical proof.",
      "CPU/mem/PID: tanpa enforcement di profile.",
      "Network: (deny network*); FS: (deny default)+(subpath cwd).",
    ],
  },
}

/** Handle opaque backend — namespace `be_*`, BUKAN executionId (M1). */
export interface BackendHandle {
  readonly id: string
  readonly kind: BackendKind
}

export interface BackendExecRequest {
  readonly cmd: string
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly env?: Record<string, string>
}

/** Status observasi fisik — BUKAN lifecycle authority (itu M8). */
export type BackendObserveStatus = "running" | "exited" | "failed" | "unknown"

export interface BackendObservation {
  readonly status: BackendObserveStatus
  readonly exitCode?: number | null
  readonly error?: string
}

export type BackendCancelResult =
  | { readonly status: "cancel-requested"; readonly via: string }
  | { readonly status: "already-settled"; readonly exitCode?: number | null }
  | { readonly status: "unsupported"; readonly reason: string }

export type BackendTerminateResult =
  | { readonly status: "termination-requested"; readonly via: string }
  | { readonly status: "already-settled"; readonly exitCode?: number | null }
  | { readonly status: "unsupported"; readonly reason: string }

export type BackendWaitResult =
  | { readonly status: "completed"; readonly exitCode: number | null }
  | { readonly status: "proven-dead"; readonly exitCode: number | null }
  | { readonly status: "timeout" }
  | { readonly status: "vanished" }
  | { readonly status: "unknown"; readonly detail: string }
  | { readonly status: "orphan"; readonly detail: string }

export interface BackendDisposeResult {
  readonly disposed: true
  /** True bila dispose membersihkan proses hidup (anti-yatim; best-effort). */
  readonly cleanupKillAttempted: boolean
}

export type BackendAdmitResult =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: string }
export type BackendStartResult =
  | { readonly started: true; readonly handle: BackendHandle }
  | { readonly started: false; readonly reason: string }

export interface ExecutionBackend {
  readonly kind: BackendKind
  readonly capabilities: BackendCapability
  admit(req: BackendExecRequest): BackendAdmitResult
  start(req: BackendExecRequest): Promise<BackendStartResult>
  observe(handle: BackendHandle): BackendObservation
  cancel(handle: BackendHandle, reason: string): BackendCancelResult
  terminate(handle: BackendHandle, reason: string): BackendTerminateResult
  wait(handle: BackendHandle, timeoutMs?: number): Promise<BackendWaitResult>
  dispose(handle: BackendHandle): BackendDisposeResult
}

/** Bound default wait (ms). Konservatif; configurable per-call. */
export const DEFAULT_BACKEND_WAIT_MS = 5_000

/**
 * [P1 M16] SATU allocator untuk id handle backend (namespace `be_`).
 *
 * Sebelumnya dua adapter (host + docker) masing-masing mencetak `be_<8 hex>`;
 * itu dua sumber untuk satu namespace dan pemanggil bisa menulis handle dengan
 * prefix berbeda di jalur berbeda. Sekarang satu fungsi, satu format.
 */
function allocateBackendHandleId(): string {
  return `be_${randomUUID().slice(0, 8)}`
}

// ── Mekanik kill bersama (cermin bash.ts:96-124 + F-23; didokumentasikan,
// bukan diimpor dari tool layer agar backend tak bergantung pada tools). ──

function killTree(proc: { pid?: number; kill(signal: number | NodeJS.Signals): boolean }): void {
  try {
    if (process.platform === "win32" && proc.pid !== undefined) {
      const r = spawnSync(
        resolveTrustedExecutable("taskkill"),
        ["/pid", String(proc.pid), "/T", "/F"],
        {
          stdio: "ignore",
          env: sanitizeSpawnEnv(process.env),
        },
      )
      if (r.status === 0) return
    } else if (proc.pid !== undefined) {
      try {
        process.kill(-proc.pid, "SIGKILL")
        return
      } catch {}
    }
  } catch {}
  try {
    proc.kill("SIGKILL")
  } catch {}
}

// ── Host adapter: implementasi penuh di atas node:child_process ──

interface HostRecord {
  proc: ChildProcess
  startedAt: number
  done: boolean
  exitCode: number | null
  error: string | null
  killInitiatedByUs: boolean
  waiters: Set<(r: BackendWaitResult) => void>
  timer: ReturnType<typeof setTimeout> | null
}

function settleHostRecord(rec: HostRecord, result: BackendWaitResult): void {
  if (rec.timer) {
    clearTimeout(rec.timer)
    rec.timer = null
  }
  for (const w of [...rec.waiters]) {
    rec.waiters.delete(w)
    try {
      w(result)
    } catch {}
  }
}

function hostTerminalResult(rec: HostRecord): BackendWaitResult {
  // completed = keluar sendiri; proven-dead = close sesudah kill dari kita.
  // Keduanya HANYA dari event close yang terobservasi — bukan klaim buta.
  if (rec.error && !rec.done) return { status: "unknown", detail: rec.error }
  if (rec.killInitiatedByUs) return { status: "proven-dead", exitCode: rec.exitCode }
  return { status: "completed", exitCode: rec.exitCode }
}

export function createHostBackend(): ExecutionBackend {
  const records = new Map<string, HostRecord>()

  const get = (handle: BackendHandle): HostRecord | null => {
    if (handle.kind !== "host") return null
    return records.get(handle.id) ?? null
  }

  return {
    kind: "host",
    capabilities: BACKEND_CAPABILITIES.host,

    admit(req: BackendExecRequest): BackendAdmitResult {
      if (!req || typeof req.cmd !== "string" || req.cmd.length === 0)
        return { admitted: false, reason: "empty command" }
      if (req.cwd !== undefined && typeof req.cwd !== "string")
        return { admitted: false, reason: "invalid cwd" }
      if (req.timeoutMs !== undefined && (!Number.isFinite(req.timeoutMs) || req.timeoutMs <= 0))
        return { admitted: false, reason: "invalid timeoutMs" }
      return { admitted: true }
    },

    start(req: BackendExecRequest): Promise<BackendStartResult> {
      const admission = this.admit(req)
      if (!admission.admitted)
        return Promise.resolve({ started: false as const, reason: admission.reason })
      return new Promise((resolveStart) => {
        let settled = false
        let proc: ChildProcess
        try {
          proc = spawn(req.cmd, {
            shell: true,
            cwd: req.cwd ?? process.cwd(),
            env: sanitizeSpawnEnv(process.env, req.env),
            // detached agar group-leader → killTree grup (cermin bash.ts:297-299).
            detached: process.platform !== "win32",
          })
        } catch (e) {
          resolveStart({ started: false as const, reason: (e as Error).message })
          return
        }
        const id = allocateBackendHandleId()
        const rec: HostRecord = {
          proc,
          startedAt: Date.now(),
          done: false,
          exitCode: null,
          error: null,
          killInitiatedByUs: false,
          waiters: new Set(),
          timer: null,
        }
        proc.on("error", (e) => {
          rec.error = e.message
          rec.done = true
          settleHostRecord(rec, { status: "unknown", detail: e.message })
          if (!settled) {
            settled = true
            // Gagal spawn SEBELUM hidup: failed-to-start, BUKAN terminated.
            resolveStart({ started: false as const, reason: e.message })
          }
        })
        proc.on("close", (code) => {
          rec.exitCode = code
          rec.done = true
          settleHostRecord(rec, hostTerminalResult(rec))
        })
        records.set(id, rec)
        // nextTick: beri kesempatan error sinkron (ENOENT) sebelum klaim started.
        setImmediate(() => {
          if (!settled) {
            settled = true
            resolveStart({ started: true as const, handle: { id, kind: "host" as const } })
          }
        })
      })
    },

    observe(handle: BackendHandle): BackendObservation {
      const rec = get(handle)
      if (!rec) return { status: "unknown", error: "no such handle (disposed or foreign)" }
      if (!rec.done) return { status: "running" }
      if (rec.error && rec.exitCode === null) return { status: "failed", error: rec.error }
      return { status: "exited", exitCode: rec.exitCode }
    },

    cancel(handle: BackendHandle, reason: string): BackendCancelResult {
      const rec = get(handle)
      if (!rec) return { status: "already-settled" }
      if (rec.done) return { status: "already-settled", exitCode: rec.exitCode }
      // Cooperative: SIGTERM (win32 langsung tree — cermin bash.ts:328-337).
      // Ini REQUEST; kematian fisik HANYA via wait+close (D). Tanpa klaim D.
      rec.killInitiatedByUs = true
      try {
        if (process.platform === "win32") killTree(rec.proc)
        else rec.proc.kill("SIGTERM")
      } catch {}
      void reason
      return {
        status: "cancel-requested",
        via: process.platform === "win32" ? "killTree-taskkill" : "SIGTERM",
      }
    },

    terminate(handle: BackendHandle, reason: string): BackendTerminateResult {
      const rec = get(handle)
      if (!rec) return { status: "already-settled" }
      if (rec.done) return { status: "already-settled", exitCode: rec.exitCode }
      // Stronger attempt (bukan label ulang cancel): killTree grup.
      rec.killInitiatedByUs = true
      try {
        killTree(rec.proc)
      } catch {}
      void reason
      return {
        status: "termination-requested",
        via: process.platform === "win32" ? "taskkill-/T-/F" : "kill(-pid,SIGKILL)-group",
      }
    },

    wait(
      handle: BackendHandle,
      timeoutMs: number = DEFAULT_BACKEND_WAIT_MS,
    ): Promise<BackendWaitResult> {
      const rec = get(handle)
      if (!rec)
        return Promise.resolve({
          status: "unknown",
          detail: "no such handle (disposed or foreign)",
        })
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return Promise.reject(
          new Error("backend.wait: timeoutMs must be finite positive (bounded by contract)"),
        )
      if (rec.done) return Promise.resolve(hostTerminalResult(rec))
      return new Promise((resolveWait) => {
        const onTimeout = (): void => {
          rec.waiters.delete(resolveWait)
          rec.timer = null
          // Timeout = berhenti menunggu (A). Proses mungkin hidup — tak diklaim mati.
          resolveWait({ status: "timeout" })
        }
        rec.waiters.add(resolveWait)
        rec.timer = setTimeout(onTimeout, timeoutMs)
      })
    },

    dispose(handle: BackendHandle): BackendDisposeResult {
      const rec = get(handle)
      if (!rec) return { disposed: true as const, cleanupKillAttempted: false }
      records.delete(handle.id)
      let cleanup = false
      if (!rec.done) {
        // Anti-yatim best-effort (cleanup resources, BUKAN keputusan lifecycle):
        // hasil historis yang sudah dikembalikan tak berubah oleh ini.
        try {
          killTree(rec.proc)
          cleanup = true
        } catch {}
      }
      settleHostRecord(rec, { status: "unknown", detail: "disposed" })
      return { disposed: true as const, cleanupKillAttempted: cleanup }
    },
  }
}

// ── Sandbox shims: deklarasi + run-to-completion wrap (jujur mid-flight) ──

interface ShimCompleted {
  done: true
  code: number | null
  output: string
}

function createRunToCompletionShim(
  kind: BackendKind,
  available: () => boolean,
  unavailableReason: string,
  runToCompletion: (req: BackendExecRequest) => Promise<{ code: number | null; output: string }>,
): ExecutionBackend {
  const records = new Map<string, ShimCompleted>()
  return {
    kind,
    capabilities: BACKEND_CAPABILITIES[kind],
    admit(req: BackendExecRequest): BackendAdmitResult {
      if (!req || typeof req.cmd !== "string" || req.cmd.length === 0)
        return { admitted: false, reason: "empty command" }
      // Fail-closed tanpa silent fallback (cermin bash.ts:253-260,278-285).
      if (!available()) return { admitted: false, reason: unavailableReason }
      return { admitted: true }
    },
    async start(req: BackendExecRequest): Promise<BackendStartResult> {
      const admission = this.admit(req)
      if (!admission.admitted) return { started: false as const, reason: admission.reason }
      const id = allocateBackendHandleId()
      try {
        const res = await runToCompletion(req)
        records.set(id, { done: true, code: res.code, output: res.output })
        return { started: true as const, handle: { id, kind } }
      } catch (e) {
        return { started: false as const, reason: (e as Error).message }
      }
    },
    observe(handle: BackendHandle): BackendObservation {
      const rec = handle.kind === kind ? records.get(handle.id) : undefined
      if (!rec) return { status: "unknown", error: "no such handle (disposed or foreign)" }
      return { status: "exited", exitCode: rec.code }
    },
    cancel(handle: BackendHandle, _reason: string): BackendCancelResult {
      const rec = handle.kind === kind ? records.get(handle.id) : undefined
      if (!rec) return { status: "already-settled" }
      // Runner existing run-to-completion: tak ada handle preemptif. DINYATAKAN
      // unsupported (jujur, sesuai evidence code_run abort-hanya-menunggu).
      void _reason
      return {
        status: "unsupported",
        reason: "run-to-completion runner has no preemptive kill path (M5-out)",
      }
    },
    terminate(handle: BackendHandle, _reason: string): BackendTerminateResult {
      const rec = handle.kind === kind ? records.get(handle.id) : undefined
      if (!rec) return { status: "already-settled" }
      void _reason
      return {
        status: "unsupported",
        reason: "run-to-completion runner has no preemptive kill path (M5-out)",
      }
    },
    async wait(handle: BackendHandle): Promise<BackendWaitResult> {
      const rec = handle.kind === kind ? records.get(handle.id) : undefined
      if (!rec) return { status: "unknown", detail: "no such handle (disposed or foreign)" }
      // Runner melaporkan completion — BUKAN physical-death proof container.
      // D container tak pernah diklaim shim ini (matriks d=BEST_EFFORT).
      return { status: "completed", exitCode: rec.code }
    },
    dispose(handle: BackendHandle): BackendDisposeResult {
      const existed = handle.kind === kind && records.delete(handle.id)
      void existed
      return { disposed: true as const, cleanupKillAttempted: false }
    },
  }
}

export function createDockerBackend(): ExecutionBackend {
  return createRunToCompletionShim(
    "docker",
    () => dockerAvailable(),
    "docker unavailable (no silent host fallback)",
    (req) =>
      runInDocker(req.cmd, req.cwd ?? process.cwd(), {
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
        ...(req.env ? { env: req.env } : {}),
      }),
  )
}

function bwrapSelected(): boolean {
  return osSandboxAvailable() && osSandboxTypeName() === "bwrap"
}

function seatbeltSelected(): boolean {
  return osSandboxAvailable() && osSandboxTypeName() === "seatbelt"
}

export function createBwrapBackend(): ExecutionBackend {
  return createRunToCompletionShim(
    "bwrap",
    () => bwrapSelected(),
    "bwrap unavailable on this platform",
    (req) =>
      runInOsSandbox(req.cmd, req.cwd ?? process.cwd(), {
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
        ...(req.env ? { env: req.env } : {}),
      }),
  )
}

export function createSeatbeltBackend(): ExecutionBackend {
  return createRunToCompletionShim(
    "seatbelt",
    () => seatbeltSelected(),
    "seatbelt unavailable on this platform",
    (req) =>
      runInOsSandbox(req.cmd, req.cwd ?? process.cwd(), {
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
        ...(req.env ? { env: req.env } : {}),
      }),
  )
}

export const BACKEND_FACTORIES: Record<BackendKind, () => ExecutionBackend> = {
  host: createHostBackend,
  docker: createDockerBackend,
  bwrap: createBwrapBackend,
  seatbelt: createSeatbeltBackend,
}
