import type { RecoveryAction } from "#minicore/core/errors.ts"
import { ProviderError } from "#minicore/core/errors.ts"
import type { Session, SessionConfig } from "#minicore/core/index.ts"
import { createSession as createCoreSession } from "#minicore/core/index.ts"
import { defaultRecoveryPolicy } from "#minicore/core/recovery.ts"
import { LIMITS } from "../constants.ts"
import { buildSystemPrompt, minicodeEstimator } from "../policy/context.ts"
import { parallelExecutor } from "../policy/executor.ts"
import {
  createPermissionHandler,
  type PermissionAsk,
  type PermissionMode,
} from "../policy/permission.ts"

// P2 cap wrapper: limit retryAfter to 30s without mutating original error.
// F-12: sanitasi PENUH di satu titik sentral (mencakup adapter vendor yang
// tak boleh disentuh): non-finite (Infinity/NaN) atau negatif → buang
// (pakai backoff kernel); sangat besar → cap. Tanpa ini retryAfter=Infinity
// menjadi setTimeout(Infinity) ≈ 1ms → hot fast-retry, bukan tunggu lama.
// Diekspor agar teruji langsung (pola repo: pure/diekspor-untuk-test).
export const cappedRecovery = {
  onError(error: ProviderError, attempt: number): RecoveryAction {
    const ra = error.retryAfterMs
    if (ra != null && (!Number.isFinite(ra) || ra < 0)) {
      const clean = new ProviderError(error.category, error.message, undefined)
      Object.assign(clean, { cause: (error as unknown as { cause?: unknown }).cause })
      return defaultRecoveryPolicy.onError(clean, attempt)
    }
    if (ra != null && ra > LIMITS.RETRY_AFTER_MAX_MS) {
      const capped = new ProviderError(error.category, error.message, LIMITS.RETRY_AFTER_MAX_MS)
      // preserve extra fields if any
      Object.assign(capped, { cause: (error as unknown as { cause?: unknown }).cause })
      return defaultRecoveryPolicy.onError(capped, attempt)
    }
    return defaultRecoveryPolicy.onError(error, attempt)
  },
  onLength(compacted: boolean): RecoveryAction {
    return defaultRecoveryPolicy.onLength(compacted)
  },
}

export type PermissionControl = {
  setMode(m: "auto" | "readonly" | "plan" | "allow-all" | "ask" | "allowlist"): void
  getMode(): "auto" | "readonly" | "plan" | "allow-all" | "ask" | "allowlist"
}

export async function createMinicodeSession(
  opts: Partial<
    Omit<SessionConfig, "permissions" | "estimator" | "recovery" | "system" | "executor">
  > & {
    systemExtra?: string
    cwd?: string
    permissionMode?: "auto" | "readonly" | "plan" | "allow-all" | "ask" | "allowlist"
    /** Teruskan flag --allow-local-config ke permission handler (allowlist
     * lokal). Default deny — lihat loadAllowlist. */
    allowLocalConfig?: boolean
    concurrency?: number
    writeConcurrency?: number
    turnCount?: number
    stepCount?: number
    /** Menerima handle kontrol mode permission. Kernel tidak mengekspos
     * `config`, jadi satu-satunya cara mengubah mode saat runtime (mis.
     * Shift+Tab di TUI) adalah menangkap handler di sini. */
    onPermissions?: (control: PermissionControl) => void
    /** View persetujuan tool (di-inject dari cli/; tanpa ini mode interaktif
     * menolak semua prompt — aman untuk headless/library). */
    ask?: PermissionAsk
  },
): Promise<Session> {
  const planHint =
    opts.permissionMode === "plan"
      ? "\n\nPLAN MODE: You are in read-only planning mode. Do NOT modify files, run bash, or use write/edit tools. Only read, search, and reason — then output a concrete implementation plan."
      : ""
  const system = await buildSystemPrompt({
    cwd: opts.cwd,
    extra: (opts.systemExtra ?? "") + planHint,
    signal: (opts as unknown as { signal?: AbortSignal }).signal,
  })
  const {
    concurrency,
    writeConcurrency,
    cwd,
    permissionMode,
    allowLocalConfig,
    systemExtra: _extra,
    provider,
    onPermissions,
    ask,
    turnCount,
    stepCount,
    ...rest
  } = opts
  if (!provider) throw new Error("createMinicodeSession: provider is required")
  // F-09: sanitasi batas di lapisan app (mencakup pemanggil library langsung,
  // bukan hanya CLI yang sudah sanitasi di cli/setup.ts + cli/index.ts).
  // Tanpa ini: timeoutMs NaN/negatif = abort instan; maxSteps 0/negatif =
  // selalu throw, Infinity = loop luar tak terbatas; concurrency 0 = zero
  // worker → hasil undefined (korupsi diam-diam). Nilai tak valid → default
  // kernel (hilangkan kunci), bukan error — sesi tetap jalan aman.
  {
    const t = (rest as Record<string, unknown>).timeoutMs
    if (typeof t === "number" && (!Number.isFinite(t) || t < 0))
      delete (rest as Record<string, unknown>).timeoutMs
    const m = (rest as Record<string, unknown>).maxSteps
    if (typeof m !== "number" || !Number.isFinite(m) || m < 1)
      delete (rest as Record<string, unknown>).maxSteps
    else (rest as Record<string, unknown>).maxSteps = Math.floor(m)
  }
  const safeConcurrency =
    typeof concurrency === "number" && Number.isFinite(concurrency) && concurrency > 0
      ? Math.floor(concurrency)
      : undefined
  const safeWriteConcurrency =
    typeof writeConcurrency === "number" &&
    Number.isFinite(writeConcurrency) &&
    writeConcurrency > 0
      ? Math.floor(writeConcurrency)
      : undefined
  const permissions = createPermissionHandler({
    mode: permissionMode ?? "auto",
    root: cwd,
    ask,
    allowLocalConfig,
  })
  const withMode = permissions as typeof permissions & {
    __setMode(m: PermissionMode): void
    __getMode(): PermissionMode
  }
  if (onPermissions) {
    onPermissions({
      setMode: (m) => withMode.__setMode(m),
      getMode: () => withMode.__getMode(),
    })
  }
  // Teruskan mode live ke kernel agar ToolContext.permissionMode selalu
  // mencerminkan Shift+Tab saat itu (bukan snapshot saat sesi dibuat).
  const livePermissionMode = (): PermissionMode => withMode.__getMode()
  return createCoreSession({
    ...rest,
    provider,
    system,
    permissions,
    permissionMode: livePermissionMode,
    estimator: minicodeEstimator,
    recovery: cappedRecovery,
    executor: parallelExecutor({
      concurrency: safeConcurrency ?? LIMITS.EXECUTOR_CONCURRENCY,
      writeConcurrency: safeWriteConcurrency ?? LIMITS.EXECUTOR_WRITE_CONCURRENCY,
    }),
    cwd,
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(stepCount !== undefined ? { stepCount } : {}),
  })
}
