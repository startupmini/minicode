import type { RecoveryAction } from "#minicore/core/errors.ts"
import { ProviderError } from "#minicore/core/errors.ts"
import type { PermissionHandler, Session, SessionConfig } from "#minicore/core/index.ts"
import { createSession as createCoreSession } from "#minicore/core/index.ts"
import { defaultRecoveryPolicy } from "#minicore/core/recovery.ts"
import { estimateMessages, estimateSystem, estimateTools } from "#minicore/core/tokens.ts"
import { LIMITS } from "../constants.ts"
import {
  buildSystemPrompt,
  createCalibratedEstimator,
  minicodeEstimator,
} from "../policy/context.ts"
import { parallelExecutor } from "../policy/executor.ts"
import {
  createNoProgressDetector,
  type NoProgressDetector,
  type NoProgressOptions,
  type NoProgressPosture,
} from "../policy/no-progress.ts"
import {
  createPermissionHandler,
  type PermissionAsk,
  type PermissionMode,
} from "../policy/permission.ts"
import { contractForTool } from "../policy/tool-contract.ts"
import { maxTurnsExceededError } from "../policy/usage.ts"
import { createWorkModePermissionHandler, type WorkMode } from "../policy/work-mode.ts"
import type { ApprovalEventHook } from "../presentation/events.ts"

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

/**
 * P12 S2.2 Slice 5 — kontrol WorkMode runtime (DISCUSS/PLAN/EXECUTE). Mirip
 * PermissionControl: handler WorkMode menyimpan WorkMode MUTABLE dan kernel
 * mengkonsultasi handler per tool call, jadi setWorkMode menggeser ceiling
 * tanpa mengganti handler. Composition root menangkap handle ini dan
 * meneruskannya ke footer/subagent/hooks (live, bukan snapshot).
 */
export type WorkModeControl = {
  setWorkMode(m: WorkMode): void
  getWorkMode(): WorkMode
}

export async function createMinicodeSession(
  opts: Partial<
    Omit<SessionConfig, "permissions" | "estimator" | "recovery" | "system" | "executor">
  > & {
    systemExtra?: string
    cwd?: string
    permissionMode?: "auto" | "readonly" | "plan" | "allow-all" | "ask" | "allowlist"
    /** S2.1: WorkMode adalah lapis intent TERPISAH dari PermissionMode.
     * Default EXECUTE = perilaku lama (base handler apa adanya). Nilai selain
     * EXECUTE memasang ceiling tipis di atas handler PM (lihat work-mode.ts);
     * belum ada permukaan CLI/TUI — wiring itu slice integrasi berikutnya. */
    workMode?: WorkMode
    /** Teruskan flag --allow-local-config ke permission handler (allowlist
     * lokal). Default deny — lihat loadAllowlist. */
    allowLocalConfig?: boolean
    concurrency?: number
    writeConcurrency?: number
    turnCount?: number
    stepCount?: number
    /**
     * [Fase 3 / LOOP-INV-11] Batas keras jumlah turn lintas resume. Bila
     * `state.turnCount >= maxTurns`, `session.run()` menolak deterministik
     * dengan `maxTurnsExceededError` (`AgentError` ber-kind `budget_exceeded`).
     */
    maxTurns?: number
    /**
     * [Fase 3 / LOOP-G19, LOOP-G27] Konfigurasi detektor no-progress &
     * oscillation. Default aktif; `false` menonaktifkan eksplisit untuk test
     * khusus.
     */
    noProgress?: NoProgressOptions | false
    /** Hook opsional agar composition root dapat mereset riwayat osilasi saat verify hijau. */
    onNoProgress?: (detector: NoProgressDetector) => void
    /** Menerima handle kontrol mode permission. Kernel tidak mengekspos
     * `config`, jadi satu-satunya cara mengubah mode saat runtime (mis.
     * Shift+Tab di TUI) adalah menangkap handler di sini. */
    onPermissions?: (control: PermissionControl) => void
    /** P12 S2.2 Slice 5 — menerima handle kontrol WorkMode runtime (setWorkMode
     * / getWorkMode). Sama seperti onPermissions: kernel tidak mengekspos
     * `config`, jadi satu-satunya cara menggeser WorkMode saat runtime (mis.
     * command `/work-mode` di TUI) adalah menangkap handler di sini. */
    onWorkMode?: (control: WorkModeControl) => void
    /** View persetujuan tool (di-inject dari cli/; tanpa ini mode interaktif
     * menolak semua prompt — aman untuk headless/library). */
    ask?: PermissionAsk
    /** Hook observability persetujuan Fase 1 (diteruskan ke permission
     *  handler; tanpa ini gate identik seperti dulu). */
    onApprovalEvent?: ApprovalEventHook
    /**
     * [PHASE 6U] Inject a permission handler, bypassing the mode-derived one.
     *
     * [DESIGN DECISION] Exists so an unattended autonomous execution can carry the
     * 6S `AutonomousPermissionHandler` instead of a `readonly` MODE. Without this
     * seam a production autonomous child would silently get the interactive
     * policy, which 6S proved is (a) revocable at runtime via `__setMode` and
     * (b) admits `web_fetch`/`web_search`. That would be a real bypass of the
     * autonomous permission policy, introduced purely by composing for
     * production.
     *
     * When provided, `permissionMode` becomes kernel metadata only and
     * `onPermissions` is not wired — there is no mode to control.
     */
    permissionHandler?: PermissionHandler
    /**
     * [Fase 1 / LOOP-INV-03] Barrier yang dijalankan kernel SEBELUM
     * `tool.execute` untuk setiap panggilan yang diizinkan policy.
     *
     * Dipanggil dari dalam `permissions.check` (setelah keputusan "allow",
     * sebelum kembali ke kernel), jadi:
     * - hanya tool yang benar-benar akan dieksekusi yang menulis bukti;
     * - kegagalan barrier menggagalkan panggilan (kernel mengubahnya menjadi
     *   hasil tool error), bukan menjalankan efek tanpa jejak.
     *
     * Composition root memakainya untuk menulis intent jurnal secara AWAITED
     * dan menandai operasi in-flight sebelum efek samping terjadi. Tanpa opsi
     * ini perilaku identik seperti sebelumnya.
     */
    beforeToolEffect?: (call: { id: string; name: string; args: unknown }) => Promise<void>
  },
): Promise<Session> {
  // Fail-closed lebih awal (sebelum provider/system prompt): WorkMode non-
  // EXECUTE di atas handler terinjeksi belum punya komposisi yang terbukti
  // aman — jangan pernah membungkus atau melewati policy yang diinjeksi 6S.
  const resolvedWorkMode: WorkMode = opts.workMode ?? "EXECUTE"
  if (opts.permissionHandler !== undefined && resolvedWorkMode !== "EXECUTE") {
    throw new Error(
      `createMinicodeSession: workMode ${resolvedWorkMode} dengan permissionHandler terinjeksi belum didukung (fail-closed S2.1)`,
    )
  }
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
    workMode: _workMode,
    allowLocalConfig,
    systemExtra: _extra,
    provider,
    onPermissions,
    onWorkMode,
    ask,
    onApprovalEvent,
    permissionHandler: _permissionHandler,
    beforeToolEffect,
    turnCount,
    stepCount,
    maxTurns,
    noProgress,
    onNoProgress,
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
  const safeMaxTurns =
    typeof maxTurns === "number" && Number.isFinite(maxTurns) && maxTurns >= 1
      ? Math.floor(maxTurns)
      : undefined
  // P12 S2.2 Slice 5 — handler WorkMode SELALU dibungkus (bukan `compose`,
  // yang mengembalikan base polos untuk EXECUTE). Alasannya runtime upgrade:
  // `compose` EXECUTE = base tanpa __setWorkMode, jadi operator tak bisa
  // menggeser EXECUTE→DISCUSS/PLAN di sesi yang sama. Wrapper EXECUTE
  // mendelegasikan keputusan ke base apa adanya (perilaku identik) tetapi
  // tetap menyediakan __setWorkMode.
  const permissions =
    opts.permissionHandler ??
    createWorkModePermissionHandler({
      workMode: resolvedWorkMode,
      base: createPermissionHandler({
        mode: permissionMode ?? "auto",
        root: cwd,
        ask,
        allowLocalConfig,
        onApprovalEvent,
      }),
      root: cwd,
    })
  const injected = opts.permissionHandler !== undefined
  const withMode = permissions as typeof permissions & {
    __setMode(m: PermissionMode): void
    __getMode(): PermissionMode
  }
  const wmCtl = permissions as typeof permissions & {
    __setWorkMode?(m: WorkMode): void
    __getWorkMode?(): WorkMode
  }
  const registeredTools = rest.tools ?? []
  const allToolsPureRead =
    registeredTools.length > 0 &&
    registeredTools.every((t) => contractForTool(t.name)?.sideEffectTier === "PURE_READ")
  const livePosture = (): NoProgressPosture => {
    if (injected) return "readonly"
    const pm = withMode.__getMode()
    if (pm === "readonly") return "readonly"
    if (pm === "plan") return "plan"
    const wm = wmCtl.__getWorkMode?.() ?? resolvedWorkMode
    if (wm === "DISCUSS") return "readonly"
    if (wm === "PLAN") return "plan"
    if (allToolsPureRead) return "explore"
    return "active"
  }
  const effectiveRoot = cwd ?? process.cwd()
  const detector: NoProgressDetector | null =
    noProgress === false
      ? null
      : createNoProgressDetector({
          ...(noProgress ?? {}),
          getPosture: noProgress?.getPosture ?? livePosture,
        })
  if (detector && onNoProgress) onNoProgress(detector)

  // [Fase 1 / LOOP-INV-03 + Fase 3 / LOOP-G19, LOOP-G27] Barrier sebelum efek:
  //   1. `detector.assertBeforeCall` memblokir panggilan yang terdeteksi
  //      no-progress / osilasi SEBELUM intent jurnal ditulis & sebelum efek.
  //   2. `detector.capturePreMutation` merekam hash pra-efek untuk osilasi.
  //   3. `beforeToolEffect` menulis intent jurnal secara awaited.
  const withEffectBarrier: PermissionHandler =
    detector === null && beforeToolEffect === undefined
      ? permissions
      : {
          ...permissions,
          check: async (call, deps) => {
            const decision = await permissions.check(call, deps)
            if (decision !== "allow") return decision
            if (detector !== null) {
              await detector.beforeToolEffectCheck(call, effectiveRoot)
            }
            if (beforeToolEffect !== undefined) {
              await beforeToolEffect(call)
            }
            return "allow"
          },
        }
  // [PHASE 6U] An INJECTED handler is not a mode, and has no mode control.
  //
  // [DESIGN DECISION] `onPermissions` and `livePermissionMode` are deliberately NOT
  // wired when a handler was injected. The 6S autonomous handler is a policy, not a
  // mode: it has no `__setMode`, and exposing one would hand a Shift+Tab caller the
  // ability to revoke read-only on an unattended executor — precisely the hole 6S
  // F1 closed. `permissionMode` stays `"readonly"` purely as kernel metadata
  // (ToolContext's label); the DECISION is the handler's.
  if (onPermissions && !injected) {
    onPermissions({
      setMode: (m) => withMode.__setMode(m),
      getMode: () => withMode.__getMode(),
    })
  }
  // P12 S2.2 Slice 5 — handle kontrol WorkMode runtime. Hanya di-wire bila
  // handler BUKAN terinjeksi (handler terinjeksi = policy, bukan mode; juga
  // tak punya __setWorkMode — fail-closed, sama seperti onPermissions).
  if (onWorkMode && !injected) {
    const wm = permissions as typeof permissions & {
      __setWorkMode(m: WorkMode): void
      __getWorkMode(): WorkMode
    }
    onWorkMode({
      setWorkMode: (m) => wm.__setWorkMode(m),
      getWorkMode: () => wm.__getWorkMode(),
    })
  }
  // Teruskan mode live ke kernel agar ToolContext.permissionMode selalu
  // mencerminkan Shift+Tab saat itu (bukan snapshot saat sesi dibuat).
  const livePermissionMode = (): PermissionMode => (injected ? "readonly" : withMode.__getMode())
  // [Fase 3 / CTX-03] Estimator terkalibrasi terhadap usage aktual provider.
  const calibration = createCalibratedEstimator()
  const toolSchemasForEstimate = registeredTools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
  const core = createCoreSession({
    ...rest,
    provider,
    system,
    permissions: withEffectBarrier,
    permissionMode: livePermissionMode,
    estimator: calibration.estimator,
    recovery: cappedRecovery,
    executor: parallelExecutor({
      concurrency: safeConcurrency ?? LIMITS.EXECUTOR_CONCURRENCY,
      writeConcurrency: safeWriteConcurrency ?? LIMITS.EXECUTOR_WRITE_CONCURRENCY,
    }),
    cwd,
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(stepCount !== undefined ? { stepCount } : {}),
  })
  core.events.on("provider:extension", (e) => {
    if (e.kind !== "usage") return
    const d = e.data as { inputTokens?: number; totalTokens?: number } | undefined
    if (!d) return
    const baseLocal =
      estimateSystem(system, minicodeEstimator) +
      estimateTools(toolSchemasForEstimate, minicodeEstimator) +
      estimateMessages(core.state.history, minicodeEstimator)
    calibration.observeProviderUsage({
      localEstimatedTokens: baseLocal,
      providerInputTokens: d.inputTokens,
      providerTotalTokens: d.totalTokens,
    })
  })
  if (detector !== null) {
    core.events.on("execution:completed", (e) => {
      if ((e as { forwardedChild?: unknown }).forwardedChild != null) return
      const call = e.execution?.call as { id?: unknown; name?: unknown; args?: unknown } | undefined
      const result = e.execution?.result as { isError?: unknown; content?: unknown } | undefined
      if (!call || typeof call.name !== "string") return
      const callId = typeof call.id === "string" ? call.id : ""
      detector.recordOutcome({
        id: callId,
        name: call.name,
        args: call.args,
        isError: result?.isError === true,
        content: typeof result?.content === "string" ? result.content : "",
      })
      void detector
        .completePostMutation(
          {
            id: callId,
            name: call.name,
            args: call.args,
            isError: result?.isError === true,
          },
          effectiveRoot,
        )
        .catch(() => {})
    })
    core.events.on("turn:completed", () => {
      detector.noteAssistantResponse()
    })
  }
  if (safeMaxTurns !== undefined) {
    const origRun = core.run.bind(core)
    core.run = async (input, runOpts) => {
      if (core.state.turnCount >= safeMaxTurns) {
        throw maxTurnsExceededError(safeMaxTurns, core.state.turnCount)
      }
      return origRun(input, runOpts)
    }
  }
  return core
}
