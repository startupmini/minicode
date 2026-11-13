import { resolve } from "node:path"
import type { RecoveryAction } from "#minicore/core/errors.ts"
import { AgentError, ProviderError } from "#minicore/core/errors.ts"
import type {
  BudgetPolicy,
  ModelProvider,
  PermissionHandler,
  ProviderEvent,
  Session,
  SessionConfig,
} from "#minicore/core/index.ts"
import { createSession as createCoreSession } from "#minicore/core/index.ts"
import { defaultRecoveryPolicy } from "#minicore/core/recovery.ts"
import {
  estimateMessages,
  estimateSystem,
  estimateTools,
  safeStringify,
} from "#minicore/core/tokens.ts"
import { LIMITS } from "../constants.ts"
// [Area B · PROMPT 06] Binding persetujuan ↔ operasi yang dieksekusi.
import { ApprovalBindingStore, verifyApprovalBinding } from "../policy/approval-binding.ts"
import {
  buildSystemPrompt,
  createCalibratedEstimator,
  createIncrementalTokenCounter,
  minicodeEstimator,
} from "../policy/context.ts"
import { contextBudgetFor, outputReserveFor } from "../policy/context-budget.ts"
import { nextLadderStep } from "../policy/context-escalation.ts"
import { DEFAULT_FALLBACK_CONTEXT_WINDOW_TOKENS } from "../policy/context-window.ts"
import { parallelExecutor } from "../policy/executor.ts"
import {
  canonicalArgsHash,
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
import { getCachedTokenizer, loadTokenizer } from "../policy/tokenizer-registry.ts"
import { contractForTool } from "../policy/tool-contract.ts"
import { maxTurnsExceededError } from "../policy/usage.ts"
import { createWorkModePermissionHandler, type WorkMode } from "../policy/work-mode.ts"
import type { ApprovalEventHook } from "../presentation/events.ts"

// Kebijakan kompaksi lebih agresif: ringkas lebih DINI (medium mulai 65%,
// high 85%) daripada default kernel (75%/90%), supaya konteks jarang menyentuh
// dinding. Murni host-side — kernel mengizinkan `budget` di-inject, tanpa
// mengubah vendor. Diekspor agar teruji langsung.
export const aggressiveBudgetPolicy: BudgetPolicy = {
  evaluate({ usedTokens, limitTokens }) {
    const ratio = usedTokens / Math.max(1, limitTokens)
    if (ratio >= 1) return "critical"
    if (ratio >= 0.85) return "high"
    if (ratio >= 0.65) return "medium"
    return "low"
  },
  shouldCompact(pressure) {
    return pressure !== "low"
  },
}

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
  setMode(
    m: "auto" | "readonly" | "plan" | "allow-all" | "ask" | "allowlist" | "unrestricted",
  ): void
  getMode(): "auto" | "readonly" | "plan" | "allow-all" | "ask" | "allowlist" | "unrestricted"
  /** Bila true, bash dibatasi ke allow-list (lapis kapabilitas, terpisah mode). */
  getRestrictBash?(): boolean
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

/**
 * Guidance system-prompt ber-keyed WorkMode (lapis intent), BUKAN PermissionMode.
 *
 * DISCUSS = investigasi baca-saja yang berorientasi diskusi: model membaca,
 * mencari, dan bernalar, lalu MENYAJIKAN temuan/opsi/trade-off untuk didiskusikan
 * dengan user — bukan menulis atau mengeksekusi apa pun. PLAN = investigasi/
 * planning formal dengan prompt SENDIRI (independen dari `planHint` milik
 * PermissionMode di bawah; lapisan intent ≠ lapisan permission). EXECUTE = tidak
 * menambah apa pun (identitas).
 *
 * Ini *guidance* (behavior), bukan enforcement — enforcement tetap milik ceiling
 * handler `work-mode.ts`. Diekspor agar teruji langsung (pola repo pure/export).
 */
export function workModeHint(workMode: WorkMode): string {
  if (workMode === "DISCUSS") {
    return (
      "\n\nDISCUSS MODE: You are in read-only investigation and discussion mode. " +
      "Do NOT modify files, run bash, or use write/edit tools. " +
      "Read, search, and reason — investigate the question, then discuss findings, options, and trade-offs with the user. " +
      "Do not implement or execute any change."
    )
  }
  if (workMode === "PLAN") {
    return (
      "\n\nPLAN MODE: You are in planning mode. " +
      "Do NOT modify files, run bash, or use write/edit tools. " +
      "Only read, search, and reason — investigate thoroughly, then produce a concrete implementation plan."
    )
  }
  return ""
}

export async function createMinicodeSession(
  opts: Partial<
    Omit<SessionConfig, "permissions" | "estimator" | "recovery" | "system" | "executor">
  > & {
    systemExtra?: string
    /** Bahasa chat model (di-inject dari composition root via currentLocale()).
     * "id" → direktif Indonesia, "en" → direktif Inggris. Undefined = tanpa
     * direktif (perilaku lama; dipakai test/bench yang tak mem-pipe locale). */
    lang?: "en" | "id"
    cwd?: string
    /** Live model identity used for per-model token calibration. */
    getContextModel?: () => string | undefined
    permissionMode?:
      | "auto"
      | "readonly"
      | "plan"
      | "allow-all"
      | "ask"
      | "allowlist"
      | "unrestricted"
    /**
     * [mode-architecture] Lapis kapabilitas bash TERPISAH dari permission mode.
     * Bila true, `auto` membatasi bash ke allow-list (fallback "no-sandbox").
     */
    restrictBash?: boolean
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
    /**
     * Dipanggil saat jendela konteks dinaikkan otomatis setelah overflow
     * terverifikasi. Composition root memakainya untuk memberi tahu user
     * (footer/log) dan — bila diinginkan — mempersistensikan nilai baru.
     * Tidak pernah dipanggil untuk 429/402/auth/jaringan.
     */
    onContextWindowEscalated?: (info: {
      model: string
      fromTokens: number
      toTokens: number
      observedTokens: number
    }) => void
    /**
     * [Area B · PROMPT 06] Penyimpanan binding persetujuan milik SESI.
     *
     * Default: dibuat baru per sesi (lihat implementasi). Composition root
     * boleh mengoper instance sendiri bila perlu membagikannya dengan lapisan
     * lain; bila tidak, tiap sesi punya store sendiri sehingga bukti
     * persetujuan tak pernah lintas sesi.
     */
    approvalBindings?: ApprovalBindingStore
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
  // Normalisasi root sekali di composition agar ToolContext selalu memiliki path tepercaya.
  const defaultCwd = resolve(opts.cwd ?? process.cwd())
  // Fail-closed lebih awal (sebelum provider/system prompt): WorkMode non-
  // EXECUTE di atas handler terinjeksi belum punya komposisi yang terbukti
  // aman — jangan pernah membungkus atau melewati policy yang diinjeksi 6S.
  const resolvedWorkMode: WorkMode = opts.workMode ?? "EXECUTE"
  if (opts.permissionHandler !== undefined && resolvedWorkMode !== "EXECUTE") {
    throw new Error(
      `createMinicodeSession: workMode ${resolvedWorkMode} dengan permissionHandler terinjeksi belum didukung (fail-closed S2.1)`,
    )
  }
  const PLAN_PM_HINT =
    "\n\nPLAN MODE: You are in read-only planning mode. Do NOT modify files, run bash, or use write/edit tools. Only read, search, and reason — then output a concrete implementation plan."
  // P0.2 (G-PROMPT-RT): rakit bagian dasar sekali, lalu tambahkan `planHint`
  // (PermissionMode) + `workModeHint` (WorkMode) secara LIVE per-turn lewat
  // pembungkus provider supaya transisi runtime `/work-mode` maupun `/mode`
  // tercermin langsung di StreamRequest.system tanpa mengedit vendor/minicore.
  const baseSystem = await buildSystemPrompt({
    cwd: defaultCwd,
    extra: opts.systemExtra ?? "",
    signal: (opts as unknown as { signal?: AbortSignal }).signal,
    lang: opts.lang,
  })
  const {
    concurrency,
    writeConcurrency,
    permissionMode,
    restrictBash,
    workMode: _workMode,
    allowLocalConfig,
    systemExtra: _extra,
    getContextModel: _getContextModel,
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
    approvalBindings: _approvalBindings,
    ...rest
  } = opts
  if (!provider) throw new Error("createMinicodeSession: provider is required")
  // [Area B · PROMPT 06] Penyimpanan binding persetujuan milik SESI ini.
  // Dibuat di sini (bukan global) supaya dua sesi dalam satu proses tak
  // saling memakai bukti persetujuan. Root = cwd sesi (sama dengan yang
  // dipakai tool untuk resolve path target).
  const approvalBindings = _approvalBindings ?? new ApprovalBindingStore(defaultCwd)
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
    else if (typeof t === "number" && t > LIMITS.MAX_TIMER_DELAY_MS)
      (rest as Record<string, unknown>).timeoutMs = LIMITS.MAX_TIMER_DELAY_MS
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
  //
  // Tool Access Policy: set tool terotorisasi = tool yang terlihat/terdaftar
  // (termasuk MCP runtime dari server terkonfigurasi). Dipakai `auto` untuk
  // membedakan MCP sah dari MCP tak-terkonfigurasi (fail-closed deny).
  const authorizedTools = new Set((rest.tools ?? []).map((t) => t.name))
  const permissions =
    opts.permissionHandler ??
    createWorkModePermissionHandler({
      workMode: resolvedWorkMode,
      base: createPermissionHandler({
        mode: permissionMode ?? "auto",
        root: defaultCwd,
        ask,
        allowLocalConfig,
        restrictBash,
        onApprovalEvent,
        authorizedTools,
        // [Area B · PROMPT 06] Store per-sesi: persetujuan dari sesi A tak
        // bisa dipakai sebagai bukti di sesi B.
        approvalBindings,
      }),
      root: defaultCwd,
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
  const isAllToolsPureRead = (): boolean =>
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
    if (isAllToolsPureRead()) return "explore"
    return "active"
  }
  const effectiveRoot = defaultCwd
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
  //   3. `beforeToolEffect` writes intent jurnal secara awaited.
  //
  // [Area B · PROMPT 06] Barrier ini juga BATAS EKSEKUSI verifikasi
  // persetujuan: setelah awaital intent jurnal + no-progress di atas, yang
  // tersisa ke `tool.execute` hanya kode sinkron kernel
  // (`permissions.check` → `validateArgs` → emit → execute), jadi verifikasi
  // di sini efektif sama dengan memeriksa tepat sebelum eksekusi. Membungkus
  // tool TIDAK dipakai: itu mengganti objek di array tool LIVE yang dipegang
  // kernel/`setWorkMode` (regresi `test/work-mode-runtime.test.ts`).
  //
  // Alasan deny "approval stale" dicatat terpisah karena handler base
  // menyimpan alasannya di peta privat; kernel membacanya lewat
  // `describeDenial` yang kita override.
  const staleDenyReasons = new Map<string, string>()
  // Barrier selalu dipasang (bukan hanya bila detector/journal ada): di sini
  // verifikasi persetujuan terjadi, dan ia harus berlaku di SETIAP konfigurasi
  // — termasuk sesi tanpa jurnal dan tanpa detektor.
  const withEffectBarrier: PermissionHandler = {
    ...permissions,
    check: async (call, deps) => {
      const decision = await permissions.check(call, deps)
      // Kernel vendored saat ini hanya memblokir literal "deny". Validasi di
      // composition root ini menjaga production dispatch fail-closed tanpa
      // mengubah salinan MiniCore yang wajib disinkronkan dari repo sumber.
      // Handler ASK yang sah tetap menunggu approval lalu mengembalikan allow/deny.
      if (decision !== "allow") return "deny"
      // Ambil (konsumsi) bukti persetujuan milik call ini — sekali saja.
      // Diambil SEBELUM await supaya tak ada binding tersisa kalau barrier
      // memblokir call (tak ada deny lalu tak ada jejak).
      const binding = approvalBindings.take(call.name, canonicalArgsHash(call.args))
      if (detector !== null) {
        await detector.beforeToolEffectCheck(call, effectiveRoot)
      }
      if (beforeToolEffect !== undefined) {
        await beforeToolEffect(call)
      }
      // Verifikasi lapis-2 (batas eksekusi): fail-closed saat target berubah
      // sejak user menyetujui.
      const verdict = verifyApprovalBinding(binding)
      if (verdict.kind === "stale") {
        const id = (call as { id?: string } | null)?.id
        if (id) {
          if (staleDenyReasons.size > 500)
            staleDenyReasons.delete(staleDenyReasons.keys().next().value as string)
          staleDenyReasons.set(id, `approval stale: ${verdict.reason}`)
        }
        return "deny"
      }
      return "allow"
    },
    describeDenial: (call) => {
      const id = (call as { id?: string } | null)?.id
      if (id) {
        const reason = staleDenyReasons.get(id)
        if (reason) {
          staleDenyReasons.delete(id)
          return reason
        }
      }
      return permissions.describeDenial?.(call)
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
      // restrictBash adalah opsi tetap (bukan state handler) — dibaca langsung
      // dari closure, bukan lewat wrapper WorkMode yang tak meneruskannya.
      getRestrictBash: () => restrictBash === true,
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
  const computeLiveSystem = (): string => {
    const pm = injected ? opts.permissionMode : withMode.__getMode()
    const wm = injected ? resolvedWorkMode : (wmCtl.__getWorkMode?.() ?? resolvedWorkMode)
    const planHint = pm === "plan" ? PLAN_PM_HINT : ""
    return baseSystem + planHint + workModeHint(wm)
  }
  // [CTX] Kalibrasi dipisahkan per identitas model agar berpindah ke model
  // lain tidak membawa rasio tokenizer/provider dari sesi sebelumnya.
  const calibrations = new Map<string, ReturnType<typeof createCalibratedEstimator>>()
  const contextModelKey = (model?: string): string => model?.trim() || "__default__"
  const calibrationFor = (model?: string) => {
    const key = contextModelKey(model)
    let calibration = calibrations.get(key)
    if (!calibration) {
      calibration = createCalibratedEstimator()
      calibrations.set(key, calibration)
    }
    return calibration
  }
  let activeContextModel = opts.model
  const currentContextModel = () => {
    const selected = _getContextModel?.() ?? activeContextModel
    try {
      return provider.contextModelIdentity?.(selected) ?? selected
    } catch {
      return selected
    }
  }
  // Estimator presisi: pakai tokenizer EXACT (bila vocab tersedia/cache) lalu
  // jatuh ke estimasi density + kalibrasi usage. Menutup under-count chars/4
  // pada model open (deepseek/qwen/mistral/gemma/phi) tanpa tokenizer ter-bundle.
  const preciseEstimator = (model: string | undefined, text: string): number => {
    const tok = model ? getCachedTokenizer(model) : null
    if (tok) return Math.ceil(tok.countTokens(text))
    return calibrationFor(model).estimator(text)
  }
  const calibratedEstimator = (text: string) => preciseEstimator(currentContextModel(), text)
  // Warm tokenizer model saat ini di belakang layar (fire-and-forget): unduh vocab
  // dari HuggingFace bila tersedia, cache lokal; request berikutnya otomatis presisi.
  void loadTokenizer(currentContextModel() ?? "").catch(() => {})
  let lastRequestLocalEstimate: { model: string; tokens: number } | undefined
  // Input asli terakhir yang dilaporkan provider (`usage.prompt_tokens`). Dipakai
  // sebagai ANCHOR (lantai) estimasi admission: estimator chars/4 under-count
  // kode/JSON hingga beberapa kali lipat, sehingga tanpa anchor request berikutnya
  // bisa melampaui jendela tanpa disadari. Nilai yang progresif-kumulatif dari
  // gateway tetap aman karena kita hanya mengambil nilai TERBESAR per turn.
  let lastProviderInputTokens: number | undefined
  let lastRequestMessageCount = 0
  const contextWindowForModel = (model?: string): number => {
    // Eskalasi adaptif menang atas resolusi statis: ia adalah bukti dari
    // endpoint bahwa jendela lebih besar daripada tebakan. Tetap tunduk pada
    // nilai eksak operator? TIDAK: operator yang memasang flag eksplisit sudah
    // dihormati di `contextWindowBase`, namun bila flag itu TERBUKTI kurang
    // (overflow nyata terjadi), menaikkan satu anak tangga lebih benar daripada
    // mengulang kegagalan yang sama.
    const escalated = escalatedWindows.get(escalationKey(model))
    if (escalated !== undefined) return escalated
    return contextWindowBase(model)
  }
  // Batas output model: dipakai sebagai reserve output (bukan angka tetap 20k).
  // Dicari dari metadata provider (`maxOutputTokens`, diisi dari `/models` bila
  // endpoint melaporkannya); tanpa metadata → `undefined` = reserve default.
  const maxOutputTokensForModel = (model?: string): number | undefined => {
    try {
      const fromCore = rest.maxOutputTokensForModel?.(model)
      if (typeof fromCore === "number" && Number.isSafeInteger(fromCore) && fromCore > 0)
        return fromCore
      const fromProvider = (
        provider as { maxOutputTokensForModel?: (m?: string) => number }
      ).maxOutputTokensForModel?.(model)
      if (
        typeof fromProvider === "number" &&
        Number.isSafeInteger(fromProvider) &&
        fromProvider > 0
      )
        return fromProvider
    } catch {}
    return undefined
  }
  // ── Eskalasi adaptif jendela konteks ───────────────────────────────────
  // Nilai yang dinaikkan SESI INI saja (bukan ditulis ke config: perubahan
  // konfigurasi harus lewat /sync atau niat operator). Kunci = `provider::model`
  // ternormalisasi; nilai = jendela hasil eskalasi.
  const escalatedWindows = new Map<string, number>()
  const escalationKey = (model?: string): string => {
    const raw = model ?? currentContextModel() ?? "default"
    return raw.includes("::") ? raw : `${provider.id}::${raw}`
  }
  /** Jendela "dasar" sebelum eskalasi: hasil resolusi biasa, tanpa eskalasi. */
  const contextWindowBase = (model?: string): number => {
    const explicit = rest.contextWindowTokens
    try {
      const resolved =
        rest.contextWindowTokensForModel?.(model) ?? provider.contextWindowTokensForModel?.(model)
      if (typeof resolved === "number" && Number.isSafeInteger(resolved) && resolved > 0)
        return resolved
    } catch {}
    return typeof explicit === "number" && Number.isSafeInteger(explicit) && explicit > 0
      ? explicit
      : DEFAULT_FALLBACK_CONTEXT_WINDOW_TOKENS
  }
  /**
   * Naikkan jendela satu anak tangga setelah overflow terverifikasi.
   *
   * KENAPA otomatis: user yang sedang bekerja tidak bisa tahu ada anak tangga
   * berikutnya — dan sesi yang mati di tengah jalan jauh lebih mahal daripada
   * satu eskalasi. Namun ia tetap BOUNDED: satu langkah per kejadian, tak
   * pernah melebihi batas atas, dan hasilnya hanya berlaku untuk sesi ini.
   */
  const escalateContextWindow = (model: string | undefined, observedTokens: number) => {
    const key = escalationKey(model)
    const base = escalatedWindows.get(key) ?? contextWindowBase(model)
    // Bila pengamatan sudah jelas melampaui jendela dasar, naik dari nilai
    // pengamatan; kalau tidak, naik dari jendela yang sekarang dipakai.
    const from = Math.max(base, Number.isFinite(observedTokens) ? observedTokens : 0)
    const next = nextLadderStep(from)
    if (next === undefined || next <= base) return
    escalatedWindows.set(key, next)
    try {
      rest.onContextWindowEscalated?.({
        model: key,
        fromTokens: base,
        toTokens: next,
        observedTokens,
      })
    } catch {}
  }

  const dynamicProvider: ModelProvider = {
    id: provider.id,
    get models() {
      return provider.models
    },
    async *stream(req, signal) {
      const system = computeLiveSystem()
      const model = req.model ?? currentContextModel()
      let limit = contextWindowForModel(model)
      const maxOutputTokens = maxOutputTokensForModel(model)
      const estimatorModel = model?.includes("::") ? model : (currentContextModel() ?? model)
      let calibration = calibrationFor(estimatorModel)
      let estimator = (text: string) => preciseEstimator(estimatorModel, text)
      let admittedFactor = calibration.snapshot().factor
      const tools = req.tools ?? []
      const localInputTokens =
        estimateMessages(req.messages, minicodeEstimator) +
        estimateSystem(system, minicodeEstimator) +
        estimateTools(tools, minicodeEstimator)
      let inputTokens =
        estimateMessages(req.messages, estimator) +
        estimateSystem(system, estimator) +
        estimateTools(tools, estimator)
      // Anchor ukuran nyata: jangan biarkan estimasi (chars/4, bisa under-count
      // 2–5× pada kode/JSON) jatuh di bawah input asli terakhir provider. Input
      // hanya tumbuh antar-turn normal; bila jumlah pesan menyusut (kompaksi,
      // rewind/checkpoint, atau clear), reset anchor agar tidak memicu overflow palsu.
      if (req.messages.length < lastRequestMessageCount) {
        lastProviderInputTokens = undefined
      }
      lastRequestMessageCount = req.messages.length
      if (lastProviderInputTokens !== undefined && lastProviderInputTokens > inputTokens) {
        inputTokens = lastProviderInputTokens
      }
      lastRequestLocalEstimate = {
        model: contextModelKey(estimatorModel),
        tokens: localInputTokens,
      }
      // Sisakan ruang framing dan respons minimum. Tanpa reserve, request yang
      // tepat menyentuh batas provider tetap ditolak setelah biaya dibakar.
      // Reserve dihitung dari anggaran konteks terpusat (`context-budget.ts`):
      // `min(max_output_tokens, 20k)` dengan lantai 4k dan lantai 2% jendela.
      // Nilai lama `min(256, limit/10)` praktis nol untuk jendela besar, jadi
      // model berjendela 1M tetap kehabisan ruang jawaban di ambang batas.
      let reserve = outputReserveFor(limit, maxOutputTokens)
      let outputAllowance = Math.max(0, limit - inputTokens - reserve)
      let outputTokens = 0
      const streamedText = createIncrementalTokenCounter()
      const streamedReasoning = createIncrementalTokenCounter()
      const contextLimitEvent = (input: number, output: number): ProviderEvent => ({
        type: "extension",
        kind: "context-window-limit",
        data: {
          inputTokens: input,
          outputTokens: output,
          windowTokens: limit,
          // Diagnostik: factor kalibrasi (>=1) dan estimasi lokal tanpa
          // kalibrasi (chars/4). Bila factor besar sementara localInput kecil,
          // cutoff ini palsu (inflasi kalibrasi) — bukan konteks benar-benar penuh.
          factor: calibration.snapshot().factor,
          localInputTokens: localInputTokens,
          storeMessages: req.messages.length,
        },
      })
      const overflow = (actualInput = inputTokens, actualOutput = outputTokens) => {
        // context_length_exceeded (bukan budget_exceeded) supaya kernel menempuh
        // jalur recovery `force_compact_and_retry`: meringkas lalu coba lagi,
        // alih-alih mati `✗ Context window exceeded`. Bounded — loop recovery
        // menolak bila kompaksi no-op (compactedForRecovery sudah set).
        //
        // Eskalasi adaptif: overflow INI adalah bukti terverifikasi bahwa jendela
        // yang kita pakai terlalu kecil ATAU penuh. Naikkan satu anak tangga untuk
        // sesi ini supaya percobaan berikutnya (dan turn berikut) punya ruang.
        // Hanya dipanggil pada jalur yang benar-benar kehabisan konteks — bukan
        // 429/402/auth/jaringan.
        escalateContextWindow(model, actualInput + actualOutput)
        return new ProviderError(
          "context_length_exceeded",
          `context window budget reached for the selected model: input ${actualInput} + output ${actualOutput} exceeds ${limit} tokens; reduce the prompt/tools or select a larger context window`,
        )
      }
      const requestController = new AbortController()
      const forwardAbort = () => requestController.abort(signal.reason)
      if (signal.aborted) forwardAbort()
      else signal.addEventListener("abort", forwardAbort, { once: true })
      try {
        if (inputTokens + reserve >= limit) {
          const error = overflow(inputTokens, 0)
          requestController.abort(error)
          yield contextLimitEvent(inputTokens, 0)
          throw error
        }

        for await (const event of provider.stream({ ...req, system }, requestController.signal)) {
          if (event.type === "extension" && event.kind === "effective-model") {
            const effective = event.data as { effective?: unknown; provider?: unknown } | undefined
            if (
              typeof effective?.effective === "string" &&
              typeof effective.provider === "string"
            ) {
              // Router fallback/substitution is a different model boundary.
              // Keep the smaller of the requested and effective capacities so
              // a failed primary provider cannot silently widen the budget.
              const effectiveModel = `${effective.provider}::${effective.effective}`
              const effectiveLimit = contextWindowForModel(effectiveModel)
              limit = Math.min(limit, effectiveLimit)
              calibration = calibrationFor(effectiveModel)
              estimator = (text: string) => preciseEstimator(effectiveModel, text)
              admittedFactor = calibration.snapshot().factor
              inputTokens = Math.max(
                inputTokens,
                estimateMessages(req.messages, estimator) +
                  estimateSystem(system, estimator) +
                  estimateTools(tools, estimator),
              )
              reserve = outputReserveFor(limit, maxOutputTokens)
              outputAllowance = Math.max(0, limit - inputTokens - reserve)
            }
          }
          const currentFactor = calibration.snapshot().factor
          if (currentFactor > admittedFactor) {
            inputTokens = Math.max(
              inputTokens,
              estimateMessages(req.messages, estimator) +
                estimateSystem(system, estimator) +
                estimateTools(tools, estimator),
            )
            reserve = outputReserveFor(limit, maxOutputTokens)
            outputAllowance = Math.max(0, limit - inputTokens - reserve)
          }
          admittedFactor = currentFactor
          let added = 0
          if (event.type === "text") {
            added = streamedText.add(event.text, calibration.snapshot().factor)
          } else if (event.type === "tool_call") {
            added = estimator(event.name) + estimator(safeStringify(event.args))
          } else if (event.type === "extension" && event.kind === "reasoning") {
            const reasoning = (event.data as { text?: unknown } | undefined)?.text
            if (typeof reasoning === "string") {
              added = streamedReasoning.add(reasoning, calibration.snapshot().factor)
            }
          }
          if (added > 0 && outputTokens + added > outputAllowance) {
            const error = overflow(inputTokens, outputTokens + added)
            requestController.abort(error)
            yield contextLimitEvent(inputTokens, outputTokens + added)
            throw error
          }
          outputTokens += added
          yield event as ProviderEvent
        }
      } catch (error) {
        // Generic 400 "invalid_request" dari gateway (tiprouter dll) yang BISA
        // sebenarnya konteks kepanjangan meski teksnya tak menyebut "context".
        // Reklasifikasi sebagai context_length_exceeded supaya kernel menempuh
        // compact-and-retry (bounded + no-op-safe) alih-alih mati fatal. Ambang
        // tanngal
        // `localInputTokens >= contextReclassifyThreshold(limit)` — ambang
        // RELATIF jendela (`min(50_000, window*0.5)`), bukan 50.000 mutlak.
        // Angka mutlak membuat model berjendela < 50k mustahil menempuh
        // compact-and-retry: jendelanya penuh jauh sebelum ambang tercapai,
        // sehingga 400 generik selalu mati fatal.
        if (
          error instanceof ProviderError &&
          (error.category === "invalid_request" || error.category === "unknown") &&
          localInputTokens >= contextBudgetFor(limit, maxOutputTokens).reclassifyThreshold
        ) {
          throw overflow(inputTokens, outputTokens)
        }
        throw error
      } finally {
        signal.removeEventListener("abort", forwardAbort)
        if (!requestController.signal.aborted) {
          requestController.abort(new AgentError("aborted", "provider stream closed"))
        }
      }
    },
  }
  const liveToolSchemas = () =>
    registeredTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
  const core = createCoreSession({
    ...rest,
    contextWindowTokens: contextWindowForModel(currentContextModel()),
    contextWindowTokensForModel: contextWindowForModel,
    maxOutputTokensForModel: maxOutputTokensForModel,
    // Kompaksi lebih agresif (host-side): ringkas mulai 65% jendela, bukan 75%.
    budget: aggressiveBudgetPolicy,
    provider: dynamicProvider,
    system: computeLiveSystem(),
    systemForContext: computeLiveSystem,
    permissions: withEffectBarrier,
    permissionMode: livePermissionMode,
    estimator: calibratedEstimator,
    recovery: cappedRecovery,
    executor: parallelExecutor({
      concurrency: safeConcurrency ?? LIMITS.EXECUTOR_CONCURRENCY,
      writeConcurrency: safeWriteConcurrency ?? LIMITS.EXECUTOR_WRITE_CONCURRENCY,
    }),
    cwd: defaultCwd,
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(stepCount !== undefined ? { stepCount } : {}),
  })
  core.events.on("context:compacted", () => {
    lastProviderInputTokens = undefined
  })
  core.events.on("provider:extension", (e) => {
    if (e.kind !== "usage") return
    const d = e.data as
      | {
          inputTokens?: number
          totalTokens?: number
          model?: string
          provider?: string
          source?: string
        }
      | undefined
    if (!d || d.source === "compaction") return
    const reportedModel =
      typeof d.model === "string" && d.model.length > 0
        ? typeof d.provider === "string" && d.provider.length > 0
          ? `${d.provider}::${d.model}`
          : d.model
        : currentContextModel()
    const fallbackLocal =
      estimateSystem(computeLiveSystem(), minicodeEstimator) +
      estimateTools(liveToolSchemas(), minicodeEstimator) +
      estimateMessages(core.state.history, minicodeEstimator)
    const localEstimatedTokens = lastRequestLocalEstimate?.tokens ?? fallbackLocal
    // Anchor input nyata (nilai terbesar per turn, toleran pada laporan
    // progresif-kumulatif gateway) untuk lantai admission request berikutnya.
    if (typeof d.inputTokens === "number" && d.inputTokens > 0) {
      lastProviderInputTokens =
        lastProviderInputTokens === undefined
          ? d.inputTokens
          : Math.max(lastProviderInputTokens, d.inputTokens)
    }
    calibrationFor(reportedModel).observeProviderUsage({
      localEstimatedTokens,
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
  // R11/T3 (opt-in, default off) — anggaran volume-baca per turn. Guard token
  // hanya peka tekanan TOKEN, bukan tekanan working-memory: model berjendela
  // raksasa (1M) bisa membaca ribuan baris tanpa memicu kompaksi, lalu
  // kualitas nalarnya menurun diam-diam (lih. evidence dogfooding: audit UI
  // berhenti minta-konfirmasi setelah membaca ~5k baris tanpa kompaksi).
  // Observer ini MENGHITUNG total char hasil tool per turn dan memperingatkan
  // sekali bila melewati ambang — membantu operator mengenali kasus "penuh
  // karena perhatian, bukan jendela". Opt-in lewat MINICODE_READ_VOLUME_GUARD=1
  // supaya perilaku default TIDAK berubah.
  if (process.env.MINICODE_READ_VOLUME_GUARD === "1") {
    let turnReadChars = 0
    let warnedThisTurn = false
    core.events.on("execution:completed", (e) => {
      if ((e as { forwardedChild?: unknown }).forwardedChild != null) return
      const result = e.execution?.result as { content?: unknown } | undefined
      const text = typeof result?.content === "string" ? result.content : ""
      turnReadChars += text.length
      if (!warnedThisTurn && turnReadChars > LIMITS.TURN_READ_VOLUME_GUARD_CHARS) {
        warnedThisTurn = true
        process.stderr.write(
          `[context] read-volume tinggi turn ini (${turnReadChars} chars ≈ ${Math.round(turnReadChars / 4)} token) tanpa kompaksi — bila task panjang, minta model menulis progres ke file/memory agar fakta tak hilang.\n`,
        )
      }
    })
    core.events.on("turn:completed", () => {
      turnReadChars = 0
      warnedThisTurn = false
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
  return {
    get state() {
      return core.state
    },
    get events() {
      return core.events
    },
    get contextTokens() {
      return core.contextTokens
    },
    run(input: string, runOpts?: { signal?: AbortSignal; model?: string }) {
      activeContextModel = runOpts?.model ?? opts.model
      const modelForRun = activeContextModel
      return core.run(input, runOpts).catch((error: unknown) => {
        // Kernel melaporkan kehabisan konteks sebagai `budget_exceeded` dengan
        // `details.reason` = `fixpoint` atau `critical`. Keduanya BUKTI
        // terverifikasi bahwa jendela yang dipakai terlalu kecil untuk sesi ini
        // — sama sahnya dengan penolakan provider. Tanpa eskalasi di sini,
        // sesi yang sudah di titik tetap langsung mati padahal endpoint mungkin
        // punya kapasitas jauh lebih besar.
        //
        // Bukan pemicu: `max_steps_exceeded`, `max_turns`, `aborted`, timeout,
        // dan error provider non-konteks — menaikkan jendela tak akan menolong.
        if (error instanceof AgentError && error.kind === "budget_exceeded") {
          const reason = error.details?.reason
          if (reason === "fixpoint" || reason === "critical") {
            const used =
              typeof error.details?.fixedTokens === "number" ? error.details.fixedTokens : 0
            escalateContextWindow(modelForRun, used)
          }
        }
        throw error
      })
    },
    abort() {
      core.abort()
    },
  }
}
