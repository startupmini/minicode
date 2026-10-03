// Setup CLI: orchestrator thin - delegates to src/app/* layers

import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import type { Message, Session, Tool } from "#minicore"
import { createProviderLayer } from "../src/app/provider-layer.ts"
import { createRagLayer } from "../src/app/rag-layer.ts"
import { createMinicodeSession, type PermissionControl } from "../src/app/session.ts"
import { setupToolLayer } from "../src/app/tool-layer.ts"
import type { MinicodeConfig } from "../src/config.ts"
import { loadLastModel, localConfigNotice } from "../src/config.ts"
import { runRunHooks, shouldRunHooks } from "../src/hooks/run.ts"
import { homeDir } from "../src/lib/db-path.ts"
import { closeAllLsp as lspCloseAll } from "../src/lsp/client.ts"
import { closeAll as mcpCloseAll } from "../src/mcp/client.ts"
import { addMemory } from "../src/memory/vector.ts"
import { createLlmCompaction } from "../src/policy/compaction.ts"
import type { RateLimiter } from "../src/policy/ratelimit.ts"
import {
  budgetExceededError,
  createUsageCollector,
  primePricing,
  watchBudgetLimit,
} from "../src/policy/usage.ts"
import {
  buildBaselineNote,
  buildVerifySnippet,
  checkBaseline,
  detectVerifyCommand,
  formatVerifyNotice,
  runVerify,
  runWithSelfHeal,
} from "../src/policy/verifier.ts"
import { createPresentationAdapter, type PresentationAdapter } from "../src/presentation/adapter.ts"
import { type DomainEvent, DURABILITY } from "../src/presentation/events.ts"
import { createInitialState, type PresentationState } from "../src/presentation/model.ts"
import {
  describeActivity,
  elapsedVisible,
  matchTurnBySummary,
} from "../src/presentation/projection.ts"
import {
  createReducerDiagnostics,
  deriveTurnSummary,
  type ReducerDiagnostics,
  rebuildFromDurable,
  reduce,
} from "../src/presentation/reducer.ts"
import {
  type ContentEntry,
  type ContentStore,
  createContentStore,
} from "../src/presentation/store.ts"
import {
  createProductionExecutionRunner,
  inspectStartupRecovery,
  type ProductionExecutionRunner,
  type RuntimeProductionMode,
  runtimeModeFor,
  type StartupRecoveryReport,
} from "../src/runtime/production-execution.ts"
import {
  createProductionRuntime,
  type ProductionRuntimeHandle,
  runtimeGateFor,
  runtimeJournalPath,
} from "../src/runtime/production-runtime.ts"
import {
  beginTurnSnapshot,
  reconcileUndoRedoPointer,
  recordCheckpointFromSnapshots,
  recordCheckpointFromTrees,
  snapshotWorkspace,
  validateResumeWorkspace,
} from "../src/session/checkpoint.ts"
import {
  attachMutationJournal,
  finalizeJournal,
  planRecoveryForSession,
} from "../src/session/journal.ts"
import {
  appendPresentationEvents,
  listPersistedTurns,
  loadPresentationEvents,
  loadSession,
  saveSession,
} from "../src/session/persistence.ts"
import { snapshotTree } from "../src/session/shadow-git.ts"
import type { Skill } from "../src/skills/loader.ts"
import type { AutonomousSessionSpec } from "../src/task/autonomous-context.ts"
import {
  createProductionScheduler,
  type ProductionSchedulerHandle,
  schedulerGateFor,
} from "../src/task/production-scheduler.ts"
import { SchedulerObservability } from "../src/task/scheduler-observability.ts"
import { createTaskIdentityResolver } from "../src/task/sync.ts"
import {
  classifyToolResult,
  denyReasonOf,
  summarizeArgs,
  writeStepTrace,
} from "../src/telemetry/trace.ts"
import { setAskApprovalHook, setAskTextFn } from "../src/tools/ask_user.ts"
import { killAllBackgroundJobs } from "../src/tools/bash.ts"
import { setSubAgentExecutionRunner, setSubAgentParentRouting } from "../src/tools/task.ts"
import {
  reconcileCompletionEvidence,
  setCompletionEvidence,
  todoSession,
} from "../src/tools/todo.ts"
import { promptAsk, promptAskText } from "../src/ui/approval/prompt.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import type {
  UiPresentationActivity,
  UiPresentationDiagnostic,
  UiPresentationEvent,
  UiPresentationFinding,
  UiPresentationMessage,
  UiPresentationPlan,
  UiPresentationReasoning,
  UiPresentationResult,
  UiPresentationSnapshot,
  UiPresentationSystem,
  UiPresentationTurn,
  UiToolStatus,
  UiTurnSummary,
} from "../src/ui/contract.ts"
import { c } from "../src/ui/render/theme.ts"
import { runSetupWizard } from "./wizard.ts"

export interface CliSessionOptions {
  cwd?: string
  sessionId: string
  resumeId?: string
  modelOverride?: string
  providerOverride?: string
  prompt: string
  enterRepl: boolean
  machineOutput?: boolean
  verbose: boolean
  allowAll: boolean
  ask: boolean
  plan: boolean
  allowlist: boolean
  verify: boolean
  /** Audit #07 P0 opt-in: baca .minicode/config.json + allowlist lokal.
   * Default mati (fail-closed); diteruskan ke provider-layer, permission
   * handler, dan perintah REPL yang me-refresh provider. */
  allowLocalConfig?: boolean
  budget?: number
  /** Harness-P1: fail-closed bila cost sesi tak dikenal (model tanpa harga). */
  budgetStrict?: boolean
  /** Harness-P2: scope tool sesi — explore = subset read-only. */
  toolScope?: "full" | "explore"
  /**
   * [PHASE 6U] Opt-in autonomous Scheduler. DEFAULT OFF - `undefined` and
   * `false` behave identically, and for both the composition root is never called.
   *
   * [DESIGN DECISION] A CLI flag rather than a config key or an env var, so it
   * cannot be inherited by a sub-agent, an MCP server, or an unrelated project.
   * See `src/task/production-scheduler.ts` for why the alternatives were rejected.
   */
  schedulerEnabled?: boolean
  /**
   * [P1 M15] Mode produksi runtime. `off` (default) = jalur legacy utuh;
   * `constructed` = runtime + jurnal dibangun, eksekusi masih legacy;
   * `owned` = admission WAJIB lewat M13 → Kernel (satu jalur, fail-closed).
   *
   * [DESIGN DECISION] Mode, bukan boolean. Boolean M14 (`constructed`) tak dapat
   * membedakan "runtime untuk observasi" dari "runtime yang memiliki eksekusi",
   * dan dua klaim itu tidak boleh ter confuse saat rollback. Nilai tak dikenal
   * gagal ke `off`.
   */
  runtimeMode?: RuntimeProductionMode
  maxSteps?: number
  contextWindowTokens?: number
  /** F3.2: override keepRecentTurns kompaksi kernel (berapa turn terakhir
   * dipertahankan saat kompaksi). Default = kernel (DEFAULT_KEEP_RECENT_TURNS).
   * Diisi dari env MINICODE_COMPACT_KEEP_TURNS (bilangan >=1, selain itu
   * diabaikan + warn di composition root). */
  keepRecentTurns?: number
  timeoutMs?: number
  rateLimiter?: RateLimiter
  concurrency?: number
  writeConcurrency?: number
  /** Notice sandbox — hanya bila user eksplisit meminta mode (flag/env tak
   * kosong): mis. daemon tak tersedia atau mode tak dikenal. Notice rutin
   * (auto-os / auto-allowlist) sengaja disembunyikan: mode sudah terlihat di
   * prefiks prompt. Dicetak di sini (setelah provider layer lolos) supaya
   * invokasi yang mati sebelumnya tetap senyap. */
  sandboxNotice?: string
}

export interface CliSession {
  session: Session
  cfg: MinicodeConfig
  cwd?: string
  sessionId: string
  modelRef: { current?: string }
  effectiveInitialModel: string
  effectiveTimeoutMs: number
  permissionMode: string
  sessionTools: Tool[]
  allLoadedSkills: Skill[]
  usage: ReturnType<typeof createUsageCollector>
  budget?: number
  budgetStrict?: boolean
  /** Flag opt-in local config sesi ini — dipakai perintah REPL (/sync,
   * /provider, /model) agar konsisten dengan provider/tool yang aktif. */
  allowLocalConfig: boolean
  /** P2.3: jumlah hit RAG memory yang di-inject ke system prompt sesi ini. */
  memoryHits: number
  detachSimple: () => void
  persistCurrent: (usageData: unknown) => Promise<void>
  runPromptWithVerify: (prompt: string, signal?: AbortSignal) => Promise<void>
  /** Kontrol mode permission saat runtime (Shift+Tab / /mode di REPL). */
  permissions?: PermissionControl
  close: () => Promise<void>
  /** Counter reducer presentasi (divergensi harus 0). */
  getShadowDiagnostics: () => {
    divergence: number
    eventsIn: number
    duplicateTerminal: number
    lateEvent: number
    orphanTool: number
    orphanApproval: number
    duplicateTurn: number
    unknownEvent: number
    orphanEvidence: number
    unsupportedProjection: number
  }
  /** Content store untuk /expand [id]. */
  expandContent: (toolCallId: string) => ContentEntry[]
  expandAllContent: () => ContentEntry[]
  getPresentationSnapshot: () => UiPresentationSnapshot
  onPresentationEvent: (handler: (event: UiPresentationEvent) => void) => () => void
  /**
   * [PHASE 6AB] The trigger handle, exposed.
   *
   * 6AA's blocker was precisely that this was NOT here: `createProductionScheduler`
   * returned a real, authority-holding handle that `cli/setup.ts` kept in a local
   * and called exactly one method on - `stop()`. Nothing else in the process could
   * reach `fire()`, so an enabled Scheduler could never be made to do anything.
   *
   * [DESIGN DECISION] Ownership stays with the production runtime, which is what
   * this object is. The handle is deliberately NOT written into TaskStore,
   * TaskGraph, task state or a module-level singleton: it holds an AbortController,
   * a lease token and a subscription, none of which belong in durable state, and a
   * global would make the per-session scoping 6T designed for impossible to keep.
   * Exactly one session owns exactly one handle, and that session is `sessionId`.
   */
  productionScheduler: ProductionSchedulerHandle
  /** [P1 M14] Operator/runtime projection — the P1 runtime owner of this session. */
  productionRuntime: ProductionRuntimeHandle
  /** [P1 M15] Mode runtime sesi ini (off | constructed | owned). */
  runtimeMode: RuntimeProductionMode
  /** [P1 M15] Admission runtime untuk turn sesi ini. */
  executionRunner: ProductionExecutionRunner
  /** [P1 M15] Bukti durable saat start: integritas jurnal + tafsir M12. */
  startupRecovery: StartupRecoveryReport | null
  /** [PHASE 6AB] Operator projection fed by the Scheduler's own event stream. */
  schedulerObservability: SchedulerObservability
}

export function toPresentationEvent(event: DomainEvent): UiPresentationEvent | null {
  switch (event.type) {
    case "user.message":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        text: event.text,
        promptRef: event.promptRef,
      }
    case "turn.started":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        promptRef: event.promptRef,
      }
    case "turn.completed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        summary: event.summary,
      }
    case "turn.failed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        error: event.error.message,
        cause: event.error.cause,
      }
    case "turn.cancelled":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        reason: event.reason,
      }
    case "model.delta":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        delta: event.delta,
      }
    case "model.completed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        text: event.text,
        truncated: event.truncated,
        ...(event.expandRef ? { expandRef: event.expandRef } : {}),
      }
    case "reasoning.delta":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        delta: event.delta,
      }
    case "reasoning.completed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        truncated: event.truncated,
        expandRef: event.expandRef,
      }
    case "tool.started":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        stepId: event.stepId,
        toolCallId: event.toolCallId,
        name: event.identity.name,
        qualified: event.identity.qualified,
        target: event.argsSummary.target,
        status: "running",
        tsStart: event.ts,
        ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
      }
    case "tool.progress":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        status: "running",
        message: event.message,
      }
    case "tool.completed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        status: "completed",
        durationMs: event.durationMs,
        toolSummary: event.summary,
        expandRef: event.expandRef,
        ...(event.receipt
          ? {
              receipt: {
                ...(event.receipt.paths ? { paths: event.receipt.paths } : {}),
                ...(event.receipt.checkpointId ? { checkpointId: event.receipt.checkpointId } : {}),
                ...(event.receipt.stats ? { stats: event.receipt.stats } : {}),
                ...(event.receipt.test ? { test: event.receipt.test } : {}),
                ...(event.receipt.cmd ? { cmd: event.receipt.cmd } : {}),
              },
            }
          : {}),
        ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
      }
    case "tool.failed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        status: "failed",
        durationMs: event.durationMs,
        message: event.message,
        cause: event.cause,
        ...(event.hint ? { hint: event.hint } : {}),
        expandRef: event.expandRef,
        ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
      }
    case "tool.denied":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        status: "denied",
        message: event.message,
        reason: event.reason,
        ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
      }
    case "tool.cancelled":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        status: "cancelled",
        reason: event.reason,
        ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
      }
    case "approval.requested":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        approvalId: event.approvalId,
        toolCallId: event.toolCallId,
        name: event.identity.name,
        qualified: event.identity.qualified,
        target: event.argsSummary.target,
        via: event.via,
      }
    case "approval.settled":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        approvalId: event.approvalId,
        toolCallId: event.toolCallId,
        outcome: event.outcome,
      }
    case "file.changed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        paths: event.paths,
        ...(event.journalSeq !== undefined ? { journalSeq: event.journalSeq } : {}),
        ...(event.checkpointId ? { checkpointId: event.checkpointId } : {}),
      }
    case "test.completed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        test: { passed: event.passed, failed: event.failed, summary: event.summary },
      }
    case "context.compacted":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        reason: event.reason,
        compactionReason: event.reason,
      }
    case "plan.updated":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        planId: event.planId,
        status: event.status === "open" ? "running" : event.status,
        steps: event.steps,
        ...(event.expandRef ? { expandRef: event.expandRef } : {}),
      }
    case "finding.detected":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        findingId: event.findingId,
        category: event.category,
        severity: event.severity,
        text: event.summary,
        evidence: event.evidence,
        ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
      }
    case "result.produced":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        resultId: event.resultId,
        status: event.status === "completed" ? "completed" : event.status,
        toolSummary: event.summary,
        action: event.action,
        ...(event.expandRef ? { expandRef: event.expandRef } : {}),
      }
    case "diagnostic.raised":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        category: event.category,
        severity: event.severity,
        message: event.message,
        cause: event.cause,
        action: event.action,
      }
    case "checkpoint.created":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        checkpointId: event.checkpointId,
        paths: event.paths,
      }
    default: {
      const exhaustive: never = event
      void exhaustive
      return null
    }
  }
}

export function parseVerifyTestEvidence(
  command: string,
  output: string,
): { passed: number; failed: number; summary: string } | undefined {
  if (!/(?:test|vitest|jest|pytest|cargo\s+test)/i.test(command)) return undefined
  const passedMatch = /(\d+)\s+(?:pass(?:ed)?|successful?)/i.exec(output)
  const failedMatch = /(\d+)\s+(?:fail(?:ed|ures?)?|failing)/i.exec(output)
  if (!passedMatch && !failedMatch) return undefined
  return {
    passed: passedMatch ? Number(passedMatch[1]) : 0,
    failed: failedMatch ? Number(failedMatch[1]) : 0,
    summary:
      output
        .split(/\r?\n/)
        .find((line) => /(?:pass|fail)/i.test(line))
        ?.trim()
        .slice(0, 500) ?? "verify completed",
  }
}

export async function createCliSession(opts: CliSessionOptions): Promise<CliSession> {
  const {
    cwd,
    sessionId,
    resumeId,
    modelOverride,
    providerOverride,
    prompt,
    enterRepl,
    machineOutput = false,
    verbose,
    allowAll,
    ask,
    plan,
    allowlist,
    verify,
    budget,
    budgetStrict,
    toolScope,
    schedulerEnabled,
    runtimeMode,
    allowLocalConfig,
    maxSteps,
    contextWindowTokens,
    keepRecentTurns,
    timeoutMs,
    rateLimiter,
    sandboxNotice,
  } = opts
  const modelRef = { current: modelOverride }
  const presentationSessionId = resumeId ?? sessionId

  // Diagnosis startup lambat: MINICODE_DEBUG_STARTUP=1 mencetak durasi tiap
  // fase session-setup ke stderr (`[startup] rag 8432ms`). Tanpa env = diam.
  const startupPhase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const s = Date.now()
    try {
      return await fn()
    } finally {
      if (process.env.MINICODE_DEBUG_STARTUP === "1")
        process.stderr.write(`[startup] ${name} ${Date.now() - s}ms\n`)
    }
  }

  // Timeout default: --timeout > MINICODE_TIMEOUT_MS env > 15 min. 0 = Infinity.
  const envTimeout = process.env.MINICODE_TIMEOUT_MS
  let effectiveTimeoutMs =
    timeoutMs ?? (envTimeout != null && envTimeout !== "" ? Number(envTimeout) : 900_000)
  if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs < 0) {
    process.stderr.write(`[warn] invalid timeout ${effectiveTimeoutMs}, fallback to 900000\n`)
    effectiveTimeoutMs = 900_000
  }

  const permissionMode = allowAll
    ? "allow-all"
    : ask
      ? "ask"
      : plan
        ? "plan"
        : allowlist
          ? "allowlist"
          : "auto"

  // Home guard: sesi dibuka di home berisiko (glob rame, write berbahaya).
  // Standar industri: percaya-tapi-ingatkan, jangan tolak diam-diam maupun
  // pindahkan workspace (menyesatkan resume/checkpoint).
  try {
    const home = homeDir()
    const cur = resolvePath(cwd ?? process.cwd())
    if (resolvePath(home) === cur) {
      process.stderr.write(
        c.yellow(
          `[warn] workspace is home directory — consider --cwd <project> to avoid scanning the entire home\n`,
        ),
      )
    }
  } catch {}

  // Turn sebelumnya mati tak wajar (segfault/hang/kill): marker yatim masih
  // ada. Laporkan sekali + bersihkan — tanpa ini berhentinya "hilang" tanpa
  // jejak dan user tak tahu harus /resume atau mulai baru.
  try {
    const { checkStaleTurn, clearStaleTurn, formatStaleNotice } = await import(
      "../src/session/turn-marker.ts"
    )
    const stale = checkStaleTurn(cwd, sessionId)
    if (stale) {
      process.stderr.write(`${c.yellow(formatStaleNotice(stale))}\n`)
      clearStaleTurn(cwd, sessionId)
    }
  } catch {}

  const { cfg, router } = await startupPhase("provider-layer", () =>
    createProviderLayer({
      cwd,
      prompt,
      enterRepl,
      rateLimiter,
      providerOverride,
      allowLocalConfig,
      setupWhenEmpty: runSetupWizard,
    }),
  )
  // Operator wajib tahu saat config repo dipercaya — cetak sekali di awal.
  // localConfigNotice mengembalikan undefined bila flag mati atau berkas tak
  // ada, jadi tak ada noise pada alur normal.
  try {
    const notice = localConfigNotice(cwd ?? process.cwd(), allowLocalConfig === true)
    if (notice) process.stderr.write(`${c.dim(notice)}\n`)
  } catch {}
  if (sandboxNotice && !plan) process.stderr.write(`${sandboxNotice}\n`)
  // Default model = terakhir dipakai (global), bila tanpa --model dan masih
  // ada di config. Flag selalu menang; tak ada simpanan = provider pertama.
  if (!modelRef.current) {
    const saved = await loadLastModel().catch(() => undefined)
    if (saved && cfg.providers.some((p) => p.models.some((m) => `${p.id}::${m}` === saved))) {
      modelRef.current = saved
    }
  }
  const {
    systemExtra,
    skills: allLoadedSkills,
    memoryHits,
  } = await startupPhase("rag-layer", () =>
    createRagLayer({
      cfg,
      prompt,
      cwd,
      // RAG retrieval tak boleh menulis access_count di mode tanpa-mutasi.
      // "readonly" hanya ada via runtime __setMode (union startup tak memuatnya).
      trackAccess: (permissionMode as string) !== "readonly" && permissionMode !== "plan",
    }),
  )

  // resume: load full history from DB -> seed into kernel ContextStore
  let initialMessages: readonly Message[] | undefined
  let resumeTurnCount: number | undefined
  let recoveryAppendix = ""
  if (resumeId) {
    try {
      const prev = loadSession(resumeId, cwd)
      if (prev?.messages.length) {
        initialMessages = prev.messages as readonly Message[]
        resumeTurnCount = prev.turnCount
        console.error(c.dim(`[resumed session ${resumeId} (${prev.messages.length} messages)]\n`))
        // P3 — validasi resume: bukan replay buta. Bila workspace berubah
        // sejak checkpoint terakhir (edit manual / run lain), beri tahu —
        // /undo tersedia bila perlu kembali. Best-effort, tak menggagalkan resume.
        const div = await validateResumeWorkspace(cwd ?? ".", resumeId).catch(() => null)
        if (div && div.diverged > 0) {
          console.error(
            c.yellow(
              `[resume] workspace berubah sejak checkpoint terakhir (${div.diverged} file) — /undo tersedia bila perlu kembali\n`,
            ),
          )
        }
      } else {
        console.error(
          c.yellow(`[resume] session ${resumeId} not found - starting new ${sessionId}\n`),
        )
      }
    } catch (e) {
      process.stderr.write(`[warn] resume failed: ${(e as Error).message}\n`)
    }
  }

  // P0-2/P0-1 — recovery journal dibaca SEBELUM seed kernel: putuskan status
  // mutasi yang belum finalized (pending/failed/committed-tanpa-DB), lalu
  // teruskan sebagai SYSTEM appendix (bukan pesan user/assistant palsu).
  // Tanpa jurnal (sesi baru/bersih) = no-op. Tak pernah memblokir resume.
  try {
    const persistedTurns = listPersistedTurns(resumeId ?? sessionId, cwd)
    const rec = await planRecoveryForSession(resumeId ?? sessionId, cwd, { persistedTurns })
    for (const w of rec.warnings) process.stderr.write(c.yellow(`[recovery] ${w}\n`))
    if (rec.directive) {
      process.stderr.write(
        c.yellow(`[recovery] unfinished mutations need verification — see system note\n`),
      )
      recoveryAppendix = `\n\n# Recovery note (interrupted session — verify before re-executing)\n${rec.directive}`
    }
  } catch (e) {
    process.stderr.write(`[warn] recovery plan failed: ${(e as Error).message}\n`)
  }

  let durablePresentationEvents: DomainEvent[] = []
  try {
    durablePresentationEvents = loadPresentationEvents(presentationSessionId, cwd)
  } catch (e) {
    process.stderr.write(`[warn] presentation replay load failed: ${(e as Error).message}\n`)
  }
  let rebuiltPresentation: ReturnType<typeof rebuildFromDurable> | null = null
  try {
    rebuiltPresentation = rebuildFromDurable(
      durablePresentationEvents,
      createReducerDiagnostics(),
      presentationSessionId,
    )
  } catch (e) {
    process.stderr.write(`[warn] presentation replay failed: ${(e as Error).message}\n`)
  }

  // P0-3 — pointer undo/redo basi (crash apply→save): adopsi dari marker
  // jurnal bila valid. Berjalan untuk SEMUA sesi (bukan hanya --resume),
  // karena --session <id> yang dipakai ulang tanpa --resume pun bisa basi.
  // No-op bila tak ada marker / sudah konvergen. Tak pernah blokir start.
  try {
    await reconcileUndoRedoPointer(sessionId, cwd)
  } catch (e) {
    process.stderr.write(`[warn] checkpoint reconcile failed: ${(e as Error).message}\n`)
  }

  // Kontrak control-plane (Phase 6, E5): usage kompaksi LLM dikirim ke bus
  // sesi (event usage standar) — dulu blind spot accounting (kompaksi memakai
  // provider sendiri di luar bus; belanja LLM ini tak terlihat budget).
  // Late-binding: onUsage dipanggil di tengah turn, saat session sudah ada.
  let sessionEvents: {
    emit: (e: { type: "provider:extension"; kind: string; data: unknown }) => void
  } | null = null
  // Adaptor semantik presentasi Fase 1 (AGENT_PRESENTATION_ARCHITECTURE_V2_1):
  // mengamati bus kernel dan memancarkan DomainEvent ke subscriber-nya sendiri.
  // Dual-subscribe dengan sink lama — perilaku user NOL berubah pada Fase 1.
  let presentation: PresentationAdapter | null = null
  // Reducer memelihara PresentationState yang dipakai snapshot presentasi.
  // Divergensi = reduce melempar (harusnya 0).
  let shadowState: PresentationState | null = rebuiltPresentation?.state ?? null
  let shadowDiag: ReducerDiagnostics | null = rebuiltPresentation
    ? createReducerDiagnostics()
    : null
  let shadowDivergence = 0
  let unsupportedProjection = 0
  let shadowUnsub: (() => void) | null = null
  let presentationWriteTail: Promise<void> = Promise.resolve()
  let presentationFlushTimer: ReturnType<typeof setTimeout> | undefined
  const pendingPresentationEvents: DomainEvent[] = []
  const flushPresentationEvents = (): void => {
    if (presentationFlushTimer !== undefined) {
      clearTimeout(presentationFlushTimer)
      presentationFlushTimer = undefined
    }
    const batch = pendingPresentationEvents.splice(0)
    if (batch.length === 0) return
    presentationWriteTail = presentationWriteTail
      .then(() => appendPresentationEvents(presentationSessionId, cwd, batch))
      .catch((error) => {
        process.stderr.write(
          `[warn] presentation event persist failed: ${(error as Error).message}\n`,
        )
      })
  }
  const queuePresentationEvent = (event: DomainEvent): void => {
    if (!DURABILITY[event.type]?.durable) return
    pendingPresentationEvents.push(event)
    if (presentationFlushTimer === undefined) {
      presentationFlushTimer = setTimeout(flushPresentationEvents, 0)
    }
  }
  const presentationSubscribers = new Set<(event: UiPresentationEvent) => void>()
  // Content store in-memory untuk query /expand; jalur production.
  let contentStore: ContentStore | null = null
  const getShadowDiagnostics = (): {
    divergence: number
    eventsIn: number
    duplicateTerminal: number
    lateEvent: number
    orphanTool: number
    orphanApproval: number
    duplicateTurn: number
    unknownEvent: number
    orphanEvidence: number
    unsupportedProjection: number
  } => ({
    divergence: shadowDivergence,
    eventsIn: shadowDiag?.eventsIn ?? 0,
    duplicateTerminal: shadowDiag?.duplicateTerminal ?? 0,
    lateEvent: shadowDiag?.lateEvent ?? 0,
    orphanTool: shadowDiag?.orphanTool ?? 0,
    orphanApproval: shadowDiag?.orphanApproval ?? 0,
    duplicateTurn: shadowDiag?.duplicateTurn ?? 0,
    unknownEvent: shadowDiag?.unknownEvent ?? 0,
    orphanEvidence: shadowDiag?.orphanEvidence ?? 0,
    unsupportedProjection,
  })
  const getPresentationSnapshot = (): UiPresentationSnapshot => {
    if (!shadowState) return { activities: [], turns: [] }
    const activities: UiPresentationActivity[] = [...shadowState.activities.values()].map((a) => ({
      seq: a.seq,
      turnId: a.turnId,
      sessionId: a.sessionId,
      toolCallId: a.toolCallId,
      name: a.identity.name,
      qualified: a.identity.qualified,
      ...(a.target ? { target: a.target } : {}),
      status: a.status as UiToolStatus,
      tsStart: a.tsStart,
      ...(a.tsEnd !== undefined ? { tsEnd: a.tsEnd } : {}),
      ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
      ...(a.summary ? { summary: a.summary } : {}),
      ...(a.error
        ? {
            error: {
              cause: a.error.cause,
              message: a.error.message,
              ...(a.error.hint ? { hint: a.error.hint } : {}),
            },
          }
        : {}),
      ...(a.denyReason ? { denyReason: a.denyReason } : {}),
      ...(a.receipt
        ? {
            receipt: {
              ...(a.receipt.paths ? { paths: a.receipt.paths } : {}),
              ...(a.receipt.checkpointId ? { checkpointId: a.receipt.checkpointId } : {}),
              ...(a.receipt.stats ? { stats: a.receipt.stats } : {}),
              ...(a.receipt.test ? { test: a.receipt.test } : {}),
              ...(a.receipt.cmd ? { cmd: a.receipt.cmd } : {}),
            },
          }
        : {}),
      ...(a.parentToolCallId ? { parentToolCallId: a.parentToolCallId } : {}),
      ...(a.supersedes ? { supersedes: a.supersedes } : {}),
      ...(a.expandRef
        ? { expandRef: { toolCallId: a.expandRef.toolCallId, idx: a.expandRef.idx } }
        : {}),
    }))
    const turns: UiPresentationTurn[] = [...shadowState.turns.values()].map((turn) => ({
      turnId: turn.turnId,
      status: turn.status,
      ...(turn.summary ? { summary: turn.summary as UiTurnSummary } : {}),
    }))
    const conversation: UiPresentationMessage[] = shadowState.conversation.map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      role: entry.role,
      text: entry.text,
      truncated: entry.truncated,
      ...(entry.promptRef ? { promptRef: entry.promptRef } : {}),
    }))
    const reasoning: UiPresentationReasoning[] = shadowState.reasoning.map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      truncated: entry.truncated,
      expandRef: { toolCallId: entry.expandRef.toolCallId, idx: entry.expandRef.idx },
    }))
    const system: UiPresentationSystem[] = shadowState.system.map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      kind: entry.systemKind,
      text: entry.text,
      ...(entry.reason ? { reason: entry.reason } : {}),
      severity: entry.severity,
    }))
    const plans: UiPresentationPlan[] = [...shadowState.plans.values()].map((entry) => ({
      planId: entry.planId,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      status: entry.status,
      steps: entry.steps,
    }))
    const findings: UiPresentationFinding[] = [...shadowState.findings.values()].map((entry) => ({
      findingId: entry.findingId,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      category: entry.category,
      severity: entry.severity,
      summary: entry.summary,
      evidence: entry.evidence,
    }))
    const results: UiPresentationResult[] = [...shadowState.results.values()].map((entry) => ({
      resultId: entry.resultId,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      status: entry.status,
      summary: entry.summary,
      ...(entry.action ? { action: entry.action } : {}),
    }))
    const diagnostics: UiPresentationDiagnostic[] = shadowState.diagnostics.map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      category: entry.category,
      severity: entry.severity,
      message: entry.message,
      ...(entry.cause ? { cause: entry.cause } : {}),
      ...(entry.action ? { action: entry.action } : {}),
    }))
    return {
      activities,
      turns,
      conversation,
      reasoning,
      system,
      plans,
      findings,
      results,
      diagnostics,
    }
  }
  const onPresentationEvent = (handler: (event: UiPresentationEvent) => void): (() => void) => {
    presentationSubscribers.add(handler)
    return () => presentationSubscribers.delete(handler)
  }
  const publishPresentationEvent = (event: Parameters<typeof toPresentationEvent>[0]): void => {
    const projected = toPresentationEvent(event)
    if (!projected) {
      unsupportedProjection++
      return
    }
    for (const handler of [...presentationSubscribers]) {
      try {
        handler(projected)
      } catch {}
    }
  }
  const compaction = process.env.DEEPSEEK_API_KEY
    ? createLlmCompaction({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        cwd: cwd ?? process.cwd(),
        onUsage: (u) => {
          try {
            // Angka sudah dinormalisasi di compactWithLlm (negatif/NaN → skip).
            sessionEvents?.emit({
              type: "provider:extension",
              kind: "usage",
              data: {
                inputTokens: u.inputTokens,
                outputTokens: u.outputTokens,
                totalTokens: u.totalTokens,
              },
            })
          } catch {}
        },
      })
    : undefined
  const { sessionTools } = await startupPhase("tool-layer", () =>
    setupToolLayer(cfg, toolScope ?? "full", permissionMode),
  )

  // todo_write/todo_read menyimpan state per sesi di .minicode/todos/<id>.json.
  // WAJIB pakai presentationSessionId (resumeId ?? sessionId), BUKAN sessionId:
  // `sessionId` di-cek cli/index.ts adalah acak saat --resume tanpa --session,
  // jadi mengikat ke sana membuat task state hilang tepat di batas resume —
  // todo_read mengembalikan "(no todos yet)" padahal .minicode/todos/<resumeId>.json
  // ada. Id kanonik sudah didefinisikan di atas; jangan sidestep.
  todoSession.id = presentationSessionId
  todoSession.cwd = cwd
  // View pertanyaan ask_user — composition root meng-inject, tool menolak
  // jalan tanpanya (fail-closed, sama seperti `ask` pada permission).
  setAskTextFn(promptAskText)
  // Cermin observability ask_user → adaptor presentasi (perilaku tool utuh).
  setAskApprovalHook((e) => {
    presentation?.publishApproval(e)
  })
  // Warisan routing sub-agen (audit #14): anak memakai limiter BERSAMA
  // (satu bucket — tak memicu 429 yang baru dihindari parent) dan menghormati
  // --provider parent. Model diwarisi live via ToolContext (lihat task.ts).
  setSubAgentParentRouting({
    ...(rateLimiter ? { rateLimiter } : {}),
    ...(providerOverride ? { defaultProviderId: providerOverride } : {}),
  })

  let permissions: PermissionControl | undefined
  // Validasi concurrency: 0, NaN, Infinity → fallback ke default (jangan teruskan 0 ke executor)
  const safeConcurrency = (() => {
    const v = opts.concurrency
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
  })()
  const safeWriteConcurrency = (() => {
    const v = opts.writeConcurrency
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
  })()
  const session = await startupPhase("kernel-session", () =>
    createMinicodeSession({
      provider: router,
      tools: sessionTools,
      cwd,
      permissionMode,
      allowLocalConfig,
      systemExtra: (systemExtra ?? "") + recoveryAppendix,
      model: modelRef.current,
      ask: promptAsk,
      // Cermin observability persetujuan → adaptor presentasi. Keputusan gate
      // tetap milik permission handler; hook ini hanya melaporkan.
      onApprovalEvent: (e) => {
        presentation?.publishApproval(e)
      },
      onPermissions: (ctl) => {
        permissions = ctl
      },
      ...(initialMessages ? { initialMessages } : {}),
      ...(resumeTurnCount !== undefined ? { turnCount: resumeTurnCount } : {}),
      ...(maxSteps ? { maxSteps } : {}),
      ...(contextWindowTokens ? { contextWindowTokens } : {}),
      ...(keepRecentTurns ? { keepRecentTurns } : {}),
      ...(safeConcurrency ? { concurrency: safeConcurrency } : {}),
      ...(safeWriteConcurrency ? { writeConcurrency: safeWriteConcurrency } : {}),
      timeoutMs: effectiveTimeoutMs === 0 ? Infinity : effectiveTimeoutMs,
      ...(compaction ? { compaction } : {}),
    }),
  )
  // Kontrak control-plane (Phase 6): late-binding bus untuk usage kompaksi —
  // onUsage dipanggil di tengah turn, saat bus sudah hidup.
  sessionEvents = session.events
  // Content store Fase 4: adapter menaruh konten completed ke store (put
  // selalu jalan); expand(id) di tui di belakang flag.
  contentStore = createContentStore()
  let initialTurn = 0
  let initialTurnStartTs = 0
  for (const turn of shadowState?.turns.values() ?? []) {
    if (turn.turnId > initialTurn) {
      initialTurn = turn.turnId
      initialTurnStartTs = turn.tsStart
    }
  }
  // Adaptor mulai mengamati sejak bus hidup (closure onApprovalEvent di atas
  // aman: check() pertama selalu terjadi setelah wiring ini, saat run()).
  presentation = createPresentationAdapter(session.events, {
    // PF-05: WAJIB `presentationSessionId`, bukan `sessionId`. `sessionId` acak
    // saat `--resume` tanpa `--session`, sehingga `payload.sessionId` dan
    // `planId` pada event plan merujuk ke sesi fiktif sementara barisnya
    // ditulis dengan id kanonik - dua identitas untuk satu sesi, dan plan
    // bercabang alih-alih berevolusi.
    sessionId: presentationSessionId,
    ...(contentStore ? { contentStore } : {}),
    // PHASE 4A.4 - canonical task identity for the plan projection. TaskStore is
    // the authority: an id is reported only when that row really exists for this
    // session, so an unresolvable plan degrades to the positional shape instead
    // of emitting a false payloadVersion 2.
    taskIdentityProvider: createTaskIdentityResolver(cwd ?? process.cwd()),
    ...(shadowState ? { initialSeq: shadowState.seq, initialTurn, initialTurnStartTs } : {}),
  })
  try {
    if (!shadowState) shadowState = createInitialState(presentationSessionId)
    if (!shadowDiag) shadowDiag = createReducerDiagnostics()
    presentation.setTurnSummaryProvider(({ sessionId: eventSessionId, turnId, fallback }) => {
      return shadowState
        ? deriveTurnSummary(shadowState, eventSessionId, turnId, fallback)
        : fallback
    })
    shadowUnsub = presentation.onEvent((e) => {
      try {
        if (shadowState && shadowDiag) reduce(shadowState, e, shadowDiag)
      } catch {
        shadowDivergence++
      }
      queuePresentationEvent(e)
      publishPresentationEvent(e)
    })
  } catch {
    shadowDivergence++
  }

  const effectiveInitialModel = modelRef.current ?? cfg.providers[0]?.models[0] ?? "default"

  // ── Mutation journal wiring (AUDIT #01C): intent di execution:started,
  // terminal di execution:completed — keduanya post-gate kernel. Total:
  // kegagalan tulis jurnal tak pernah menggagalkan turn (degraded-loud).
  // Fase 4: onCommitted → file.changed (receipt paths+journalSeq) ke adapter.
  attachMutationJournal(session, {
    sessionId,
    cwd,
    onCommitted: (info) => {
      try {
        presentation?.noteFileChanged(info)
      } catch {}
    },
  })

  // ── Shadow checkpoint ──
  // Repo git: simpan SHA tree pre/post turn (O(delta), tanpa cap file, tidak
  // menyentuh index/HEAD user). Non-repo: fallback snapshot isi file seperti
  // sebelumnya. Keduanya menangkap perubahan dari bash/git juga, bukan cuma
  // edit/write_file.
  type TurnSnapshot = Awaited<ReturnType<typeof beginTurnSnapshot>>
  let preTurnPromise: Promise<TurnSnapshot> | null = null
  const postEditSnapshots = new Map<string, { path: string; content: string | null }>()
  session.events.on("turn:started", () => {
    preTurnPromise = beginTurnSnapshot(sessionId, cwd ?? ".")
  })
  session.events.on("execution:completed", (e) => {
    const name = e.execution.call.name
    if (name !== "edit" && name !== "write_file" && name !== "apply_patch") return
    const p = (e.execution.call.args as { path?: string })?.path
    if (!p) return
    const abs = resolvePath(cwd ?? ".", p)
    try {
      postEditSnapshots.set(p, { path: p.replace(/\\/g, "/"), content: readFileSync(abs, "utf8") })
    } catch {
      postEditSnapshots.set(p, { path: p.replace(/\\/g, "/"), content: null })
    }
  })
  session.events.on("turn:completed", async (e) => {
    const pre = await preTurnPromise
    const redoSnapshots = [...postEditSnapshots.values()]
    preTurnPromise = null
    postEditSnapshots.clear()
    if (!pre) return
    const turn =
      typeof e.result?.usage?.turns === "number" ? e.result.usage.turns : session.state.turnCount
    const desc = `turn ${turn}`
    if (pre.mode === "git") {
      const after = await snapshotTree(cwd ?? ".", sessionId, `post-${turn}`)
      const checkpoint = await recordCheckpointFromTrees(
        sessionId,
        turn,
        pre.tree,
        after?.tree,
        desc,
        cwd,
      )
      if (checkpoint) {
        presentation?.noteCheckpoint({
          checkpointId: checkpoint.id,
          turnId: turn,
          paths: [],
        })
      }
      return
    }
    if (pre.snapshots.length === 0) return
    let redo = redoSnapshots
    try {
      const { LIMITS } = await import("../src/constants.ts")
      const post = await snapshotWorkspace(cwd ?? ".", LIMITS.WORKSPACE_SNAPSHOT_LIMIT)
      if (post.length) redo = post
    } catch {}
    const checkpoint = await recordCheckpointFromSnapshots(
      sessionId,
      turn,
      pre.snapshots,
      desc,
      cwd,
      redo,
    )
    if (checkpoint) {
      presentation?.noteCheckpoint({
        checkpointId: checkpoint.id,
        turnId: turn,
        paths: (redo ?? []).map((snapshot) => snapshot.path),
      })
    }
  })

  // ── Step trace (Harness-P1) ──
  // Satu baris per tool + ringkasan per step ke .minicode/step-traces.jsonl.
  // Fire-and-forget: observability tak boleh menggagalkan turn (bus kernel
  // juga mengisolasi listener yang melempar). Deny diklasifikasi dari isi
  // observasi karena kernel hanya meng-emit execution:* untuk call yang lolos.
  const toolStarts = new Map<string, number>()
  session.events.on("execution:started", (e) => {
    try {
      toolStarts.set(e.execution.call.id, Date.now())
    } catch {}
  })
  session.events.on("execution:completed", (e) => {
    try {
      const { call, result } = e.execution
      const t0 = toolStarts.get(call.id)
      if (t0 !== undefined) toolStarts.delete(call.id)
      const kind = classifyToolResult(result)
      const reason = kind === "denied" ? denyReasonOf(result) : undefined
      void writeStepTrace(cwd, {
        sessionId,
        timestamp: new Date().toISOString(),
        kind: "tool",
        step: session.state.stepCount,
        tool: call.name,
        ok: kind === "ok",
        ...(kind === "denied" ? { denied: true } : {}),
        ...(reason ? { denyReason: reason } : {}),
        ...(t0 !== undefined ? { durationMs: Date.now() - t0 } : {}),
        args: summarizeArgs(call.args),
        sandbox: process.env.MINICODE_SANDBOX ?? "none",
        // F1.2: token kumulatif sesi saat tool selesai — bahan kurva token.
        // `usage` dideklarasikan di bawah, tapi callback ini baru jalan setelah
        // createCliSession selesai — aman dari TDZ.
        totalTokens: usage.getSession().totalTokens,
      }).catch(() => {})
    } catch {}
  })
  session.events.on("step:completed", (e) => {
    try {
      const s = e.step
      void writeStepTrace(cwd, {
        sessionId,
        timestamp: new Date().toISOString(),
        kind: "step",
        step: s.index,
        tools: s.toolCalls.length,
        errors: s.results.filter((r) => r.isError).length,
        sandbox: process.env.MINICODE_SANDBOX ?? "none",
        // F1.2: sama seperti baris tool — kumulatif sesi saat step selesai.
        totalTokens: usage.getSession().totalTokens,
      }).catch(() => {})
    } catch {}
  })
  // ── Auto-verify & self-heal ──
  const verifyCommand = verify
    ? (process.env.MINICODE_VERIFY_CMD ?? cfg.verifyCommand ?? detectVerifyCommand(cwd) ?? "")
    : ""
  const verifyActive = verifyCommand.length > 0
  // Sumber bukti completion untuk domain task (INV-003). Menyimpan hasil
  // verify TERAKHIR: pada saat `todo_write` berjalan, verify untuk turn ini
  // BELUM pernah jalan (verify terjadi setelah turn selesai), jadi bukti yang
  // relevan adalah hasil turn sebelumnya. Maknanya persis yang dibutuhkan:
  // "verify terakhir merah" -> agent tidak boleh menandai task selesai pada
  // turn berikutnya sebelum memperbaiki yang merah.
  //
  // Tanpa `--verify` (opt-in) tidak ada bukti sama sekali → `unverified`:
  // completion tetap diizinkan, tapi tidak diklaim terverifikasi.
  let lastVerify: { ok: boolean; command: string; output: string } | null = null
  setCompletionEvidence(() => {
    if (!verifyActive || !lastVerify) return { verdict: "unverified" }
    if (lastVerify.ok) return { verdict: "passed", detail: lastVerify.command }
    return {
      verdict: "failed",
      detail: `last verification failed (${lastVerify.command}): ${lastVerify.output.slice(0, 200)}`,
    }
  })
  const runVerifyWithPresentation = async (signal?: AbortSignal) => {
    const result = await runVerify(verifyCommand, cwd ?? process.cwd(), undefined, signal)
    lastVerify = { ok: result.ok, command: verifyCommand, output: result.output }
    const evidence = parseVerifyTestEvidence(verifyCommand, result.output)
    if (evidence) {
      presentation?.noteTestCompleted({
        toolCallId: `verify:${sessionId}`,
        turnId: session.state.turnCount,
        ...evidence,
      })
    }
    return result
  }
  // Audit #10 P2 observability: perintah verify (bisa dari config repo bila
  // opt-in, atau package.json) dieksekusi via shell — tampilkan SEBELUM
  // jalan pertama agar operator tahu persis apa yang dieksekusi.
  if (verifyActive) {
    process.stderr.write(c.dim(`${formatVerifyNotice(verifyCommand)}\n`))
  }
  // Audit #10 P1: hooks berjalan di luar permission system — di mode tanpa
  // eksekusi (plan/readonly) hook TETAP mengeksekusi tanpa gate, melanggar
  // kontrak read-only. Lewati + beri tahu sekali per sesi.
  const hooksAllowed = shouldRunHooks(permissionMode)
  let hooksSkippedNotice = false
  const runHooksGated = async (
    phase: "pre" | "post",
    ctx: { phase: "pre" | "post"; prompt: string; cwd?: string; result?: unknown },
    signal?: AbortSignal,
  ): Promise<void> => {
    if (!hooksAllowed) {
      if (!hooksSkippedNotice) {
        hooksSkippedNotice = true
        process.stderr.write(
          c.dim(`[hooks] skipped in ${permissionMode} mode (read-only contract)\n`),
        )
      }
      return
    }
    await runRunHooks(phase, ctx, signal)
  }

  async function runPromptWithVerify(p: string, signal?: AbortSignal): Promise<void> {
    // Listener UI segar tiap turn (pagar turn yatim — lihat attachUI).
    attachUI()
    try {
      presentation?.noteUserMessage({ text: p, turnId: session.state.turnCount })
    } catch {}
    // Tandai turn aktif: bila proses mati di tengah (segfault/kill), sesi
    // berikutnya menemukan marker yatim dan memberi tahu (bukan hilang bisu).
    // Dihapus di finally di bawah pada SEMUA jalur settle.
    const { clearTurnActive, markTurnActive } = await import("../src/session/turn-marker.ts").catch(
      () => ({}) as { clearTurnActive?: unknown; markTurnActive?: unknown },
    )
    try {
      ;(markTurnActive as ((cwd?: string, id?: string) => void) | undefined)?.(cwd, sessionId)
    } catch {}
    try {
      await runPromptWithVerifyInner(p, signal)
    } finally {
      detachUI()
      try {
        ;(clearTurnActive as ((cwd?: string, id?: string) => void) | undefined)?.(cwd, sessionId)
      } catch {}
    }
  }

  async function runPromptWithVerifyInner(p: string, signal?: AbortSignal): Promise<void> {
    // Semua session.run settle lewat sini: finally memastikan garis status
    // berhenti pada sukses MAUPUN gagal/abort (kernel hanya emit
    // turn:completed di jalur sukses — tanpa ini painter basi menimpa prompt).
    const runOnce = async (prompt: string, s?: AbortSignal) => {
      // Pemutus budget MID-TURN (audit 2026-09-16 M3): pre-check driver hanya
      // menolak prompt BARU, sehingga tool loop / siklus self-heal bisa
      // belanja tanpa batas dalam satu turn. Watcher membaca biaya LIVE dari
      // collector dan menggugurkan turn via controller gabungan begitu pagu
      // lewat (atau cost tak dikenal + pemakaian — fail-closed default). Tanpa --budget =
      // no-op (sinyal parent diteruskan apa adanya, zero-cost).
      // `formatUsd` diimpor di bawah (sebelum return) tapi selalu terinisiasi
      // sebelum runOnce pertama dipanggil — aman dipakai di closure ini.
      const ctl = new AbortController()
      const onParentAbort = () => ctl.abort(s?.reason)
      if (s) {
        if (s.aborted) ctl.abort(s.reason)
        else s.addEventListener("abort", onParentAbort, { once: true })
      }
      const stopWatch = watchBudgetLimit({
        bus: session.events,
        budget,
        strict: budgetStrict ?? false,
        getCost: () => usage.getSession().cost,
        getTokens: () => usage.getSession().totalTokens,
        onOver: (st, cost) => {
          process.stderr.write(
            st === "over" && cost != null && budget != null
              ? `[budget] ${formatUsd(cost)} > ${formatUsd(budget)} - over budget, stopping turn.\n`
              : `[budget] cost unknown (model without pricing) - over budget, stopping turn.\n`,
          )
          // F-18: abort dengan identitas kind budget_exceeded (bukan Error
          // polos) agar kernel melaporkannya sebagai budget_exceeded, bukan
          // "aborted" generik yang tak terbedakan dari Ctrl+C user.
          ctl.abort(budgetExceededError())
        },
      })
      try {
        try {
          // [P1 M15] SATU jalur eksekusi turn. Mode `off`/`constructed`:
          // `session.run` dipanggil apa adanya (perilaku sebelum M15, nol
          // overhead). Mode `owned`: lebih dulu admission M13 → Kernel, lalu
          // `session.run` yang SAMA dieksekusi di dalam eksekusi itu dan
          // didaftarkan ke `track()` (drain M14 menutup turn yang masih jalan).
          // Tidak pernah dua kali: legacy run tetap SATU-SATUNYA eksekusi fisik.
          await executionRunner.run(
            {
              kind: "turn",
              schedulerSource: "cli-session",
              authorityHeld: true,
              ownerId: presentationSessionId,
              provenance: { requestedBy: "user", reason: "prompt" },
            },
            () => session.run(prompt, { model: modelRef.current, signal: ctl.signal }),
            { signal: ctl.signal },
          )
        } catch (e) {
          // Kernel diam pada gagal/abort/timeout (turn:completed hanya sukses):
          // adaptor merekonstruksi turn.failed/cancelled dari sini. Error asli
          // selalu dilempar ulang — observability tak menutupi kegagalan.
          try {
            presentation?.noteRunSettled(e, {
              aborted: ctl.signal.aborted,
              parentAborted: s?.aborted === true,
            })
          } catch {
            // Diagnostik adaptor tak boleh menutupi error turn.
          }
          throw e
        }
      } finally {
        stopWatch()
        if (s) s.removeEventListener("abort", onParentAbort)
        turnStatus?.endTurn()
      }
    }
    if (!verifyActive) {
      await runOnce(p, signal)
      await runHooksGated(
        "post",
        { phase: "post", prompt: p, cwd, result: session.state.turnCount },
        signal,
      )
      return
    }
    // P2.1 — baseline-first: bila baseline sudah merah sebelum agen menyentuh
    // apa pun, tempelkan catatan agar agen memperbaiki dulu, bukan menumpuk
    // fitur di atas baseline rusak (yang hanya memperparah keadaan).
    let firstPrompt = p
    const broken = await checkBaseline((s) => runVerifyWithPresentation(s ?? signal), signal)
    // Abort saat baseline jalan sudah melempar dari runVerify; cek ini untuk
    // abort yang datang tepat di sela (tanpa ini turn agen jalan padahal user
    // sudah Ctrl+C).
    signal?.throwIfAborted()
    if (broken) {
      process.stderr.write(
        c.yellow(`\n[verify] baseline failing before agent run - fixing first\n`),
      )
      firstPrompt = buildBaselineNote(broken) + p
    }
    await runWithSelfHeal(
      firstPrompt,
      {
        run: async (prompt, s) => {
          // Teruskan abort REPL ke turn perbaikan: tanpa ini Ctrl+C/Esc selama
          // fix-turn diabaikan total (hanya kernel timeout 15 mnt yang menghentikan)
          // sehingga terlihat "selesai menjawab lalu macet" saat verify merah.
          // Pakai signal dari self-heal bila ada (sudah di-race antar-siklus),
          // fallback ke signal turn luar.
          await runOnce(prompt, s ?? signal)
        },
        verify: (s) => runVerifyWithPresentation(s ?? signal),
        onCycle: (cycle, max, v) => {
          if (cycle === max) {
            process.stderr.write(
              c.red(`\n[verify] still failing after ${max} attempts - leaving for user\n`),
            )
            process.stderr.write(`${v.output.slice(0, 1200)}\n`)
          } else {
            process.stderr.write(
              c.yellow(`\n[verify] attempt ${cycle}/${max} failed - self-healing…\n`),
            )
          }
        },
        onOk: (cycles) => {
          process.stderr.write(c.green(`\n[verify] ok after ${cycles} fix cycles\n`))
          // P13 P1 — turn yang lolos verify adalah bukti cara kerja yang valid:
          // simpan ringkasnya sebagai snippet (opt-out sama seperti summary).
          // Fire-and-forget: memori tak boleh menggagalkan run yang sudah hijau.
          if (process.env.MINICODE_AUTO_MEMORY !== "0") {
            void addMemory(buildVerifySnippet(p, verifyCommand, session.state.turnCount), {
              category: "snippet",
              cwd: cwd ?? process.cwd(),
            }).catch(() => {})
          }
        },
      },
      signal,
    )
    // PF-01: `todo_write` berjalan SEBELUM verify turn ini, jadi klaim
    // `completed` bisa sudah tersimpan ketika verify berubah merah (baseline
    // hijau tidak menutup celah ini - hanya baseline merah yang menutupnya).
    // Rekonsiliasi harus terjadi SETELAH self-heal selesai, di luar `runOnce`,
    // supaya verdict final itulah yang membentuk state durable.
    if (verifyActive && lastVerify && !lastVerify.ok) {
      // `reconcileCompletionEvidence` sudah best-effort + menulis diagnostik
      // sendiri, jadi pemanggil tak perlu try/catch (dan tak perlu menambah
      // writer di file ini — pagu OAP-008).
      const reconciled = await reconcileCompletionEvidence(presentationSessionId, cwd ?? ".", {
        verdict: "failed",
        detail: `last verification failed (${lastVerify.command}): ${lastVerify.output.slice(0, 200)}`,
      })
      if (reconciled) {
        presentation?.notePlanReconciled({
          todos: reconciled,
          sessionId: presentationSessionId,
          turnId: session.state.turnCount,
        })
      }
    }
    await runHooksGated(
      "post",
      { phase: "post", prompt: p, cwd, result: session.state.turnCount },
      signal,
    )
  }

  // Printer linier + status turn: dipasang SEGAR tiap turn dan dilepas saat
  // settle (sukses/gagal/abort/timeout). Cacat yang ditutup: kernel me-race
  // turn melawan timeout/abort — provider/tool non-kooperatif bisa settle
  // SETELAH run() ditolak, dan event telatnya tetap mengalir ke bus sesi
  // bersama. Tanpa pagar ini teks telat tercetak di sesi prompt berikutnya
  // ("macet"). Dengan detach, turn yatim tak punya subscriber → hening total
  // (turnStore-nya memang dibuang kernel; kini outputnya juga).
  let detachSimple: (() => void) | null = null
  let turnStatus: { detach(): void; endTurn(): void } | null = null
  const { attachTurnStatus } = await import("../src/ui/assistant/turn-status.ts")
  const { formatUsd } = await import("../src/ui/render/money.ts")
  // Dump diagnosis event bus (MINICODE_DEBUG_BUS=1): sekali per sesi agar
  // event yatim pun terlihat; tanpa env = tanpa subscribe (zero-cost).
  const { attachBusDebug } = await import("../src/ui/runtime/bus-debug.ts")
  const detachBusDebug = attachBusDebug(session.events)
  const usage = createUsageCollector(session.events, effectiveInitialModel)
  // Statusline kaya = opt-in (default mati, shell tetap bersih). Data biaya
  // disuntik sebagai callback agar UI tak perlu impor lapisan policy.
  const richStatus = process.env.MINICODE_STATUSLINE === "rich"
  const attachUI = () => {
    detachUI()
    // Mode interaktif = TUI fullscreen memiliki layar (kontrak I3: App
    // penulis tunggal). Printer linier + spinner turn-status DITEKAN agar tak
    // mengotori alt-screen — state tetap jalan (quiet: rememberTurn untuk
    // /copy, collapsed view untuk /expand). One-shot/exec (enterRepl false)
    // tetap melukis seperti dulu.
    detachSimple = attachSimpleLogger(session.events, {
      verbose,
      quiet: enterRepl === true || machineOutput,
      getSnapshot: getPresentationSnapshot,
      onPresentationEvent,
      policy: {
        describeActivity,
        matchTurn: matchTurnBySummary,
        elapsedVisible,
      },
    })
    if (enterRepl === true) {
      turnStatus = null
      return
    }
    turnStatus = attachTurnStatus(session.events, {
      initialModel: effectiveInitialModel,
      getModel: () => modelRef.current ?? effectiveInitialModel,
      activityFor: (toolCallId: string) => {
        const activity = getPresentationSnapshot().activities.find(
          (item) => item.toolCallId === toolCallId,
        )
        if (!activity) return undefined
        return {
          name: activity.name,
          ...(activity.target ? { target: activity.target } : {}),
        }
      },
      ...(richStatus
        ? {
            getStats: () => {
              const u = usage.getSession(modelRef.current)
              return `${u.totalTokens.toLocaleString()} tok${u.cost != null ? ` · ${formatUsd(u.cost)}` : ""}`
            },
          }
        : {}),
    })
  }
  const detachUI = () => {
    try {
      detachSimple?.()
    } catch {}
    detachSimple = null
    try {
      turnStatus?.detach()
    } catch {}
    turnStatus = null
  }
  // Muat overlay harga dari cache lokal (bila user pernah `pricing sync`).
  // Tidak ada request jaringan di sini — hanya baca berkas.
  void primePricing()

  async function persistCurrent(usageData: unknown) {
    try {
      flushPresentationEvents()
      await presentationWriteTail
      await saveSession(sessionId, cwd, undefined, session.state.history, usageData)
      if (resumeId) await saveSession(resumeId, cwd, undefined, session.state.history, usageData)
      // Riwayat durable → mutasi turn ini boleh di-finalize (sweep record).
      // Gagal finalize tak menggagalkan persist (warn di dalam).
      await finalizeJournal(sessionId, cwd).catch((e) => {
        process.stderr.write(`[warn] journal finalize failed: ${(e as Error).message}\n`)
      })
    } catch {}
  }

  // [PHASE 6AB] The operator projection. Created here, unconditionally and cheaply
  // (a few counters and an empty array - no I/O, no store handle, no Scheduler), so
  // the OFF case can still ANSWER "is the scheduler on?" with a truthful OFF rather
  // than by absence. It holds no reference to the Scheduler, the store or the UI:
  // it is fed events and probed against the handle.
  const schedulerObservability = new SchedulerObservability()

  // ── [P1 M14] RUNTIME COMPOSITION ───────────────────────────────────────────
  //
  // [DESIGN DECISION] One call, behind one MODE that defaults to `off`, with its
  // dependencies in a THUNK — the same shape as the Scheduler below, on purpose.
  // The alternative ("just construct it here and ignore it") satisfies the letter
  // of "gated" while opening a SQLite handle and constructing a host, a kernel
  // and a supervisor on every single run.
  //
  // [DESIGN DECISION] The journal path comes from the RESUMED identity
  // (`resumeId ?? sessionId`, the same one the presentation layer already uses),
  // not from `sessionId`. A resume that minted a fresh path would silently start
  // from an empty history while looking exactly like a successful resume. If the
  // resumed session has no runtime journal at all, the journal is created fresh
  // AT THAT PATH — never at a new path derived from the new session id.
  //
  // [P1 M15] Placed BEFORE the Scheduler composition on purpose: the runner must
  // already exist when the scheduler's deps thunk asks for it, and fail-closed
  // journal open must abort startup before any autonomous machinery is built.
  const runtimeCwd = cwd ?? process.cwd()
  const productionRuntime: ProductionRuntimeHandle = await createProductionRuntime(
    runtimeGateFor(runtimeMode),
    () => ({
      sessionId: presentationSessionId,
      workspaceCwd: runtimeCwd,
      journalPath: runtimeJournalPath(runtimeCwd, presentationSessionId),
    }),
  )

  // ── [P1 M15] EXECUTION RUNNER: admission runtime untuk setiap turn ─────────
  //
  // [DESIGN DECISION] Runner hidup di composition root, bukan di dalam Session
  // atau tool. Alasannya: jalur eksekusi yang DIREMOTE harus tetap punya satu
  // pemilik (composition root), dan `session.run()` sendiri tidak boleh tahu
  // soal dispatch/journal — supaya eksekusi legacy (mode off/constructed) tetap
  // persis seperti sebelumnya M15.
  const effectiveRuntimeMode = runtimeModeFor(runtimeMode)
  const executionRunner: ProductionExecutionRunner = createProductionExecutionRunner({
    mode: effectiveRuntimeMode,
    runtime: productionRuntime.runtime(),
  })

  // [P1 M15 §19] Bukti durable dari proses sebelumnya: integritas jurnal +
  // tafsir M12 untuk eksekusi yang berakhir non-terminal. Sengaja TIDAK
  // mendispatch (M12 hanya merencanakan; authority/budget/deadline tetap
  // berlaku) — hasil startup diekspos agar operator/REPL bisa
  // memutuskan, dan supaya startup punya bukti bahwa restart tidak diam-diam
  // mengulang pekerjaan.
  const startupRecovery: StartupRecoveryReport | null = productionRuntime.runtime()
    ? inspectStartupRecovery(productionRuntime.runtime()!, { authorityHeld: false })
    : null

  // [P1 M15] Runner dipasang ke tool sub-agen HANYA saat runtime memiliki
  // eksekusi (mode owned). Mode lain: tak ada setter call sama sekali, jadi
  // jalur legacy anak benar-benar tak tersentuh (nol overhead).
  if (executionRunner.owns) setSubAgentExecutionRunner(executionRunner)

  // ── [PHASE 6U] AUTONOMOUS SCHEDULER COMPOSITION ────────────────────────────
  //
  // [DESIGN DECISION] One call, one function, behind one boolean that defaults to
  // false. Everything that makes autonomous execution possible — the TaskStore
  // handle, the session factory, the scheduler, the trigger, the cancellation
  // subscription — lives INSIDE the `deps` thunk, which
  // `createProductionScheduler` does not invoke when the gate is shut. So the
  // default configuration cannot open a database handle, cannot allocate a
  // provider chain, cannot subscribe to a deletion channel, and cannot start
  // autonomous work even by accident.
  //
  // The gate is read from `schedulerEnabled`, which only `cli/index.ts` sets, and
  // only from an explicit `--enable-scheduler` token.
  const productionScheduler: ProductionSchedulerHandle = await createProductionScheduler(
    schedulerGateFor(schedulerEnabled),
    async () => {
      const { TaskStore } = await import("../src/task/store.ts")
      const { AUTONOMOUS_TOOL_NAMES } = await import("../src/task/autonomous-policy.ts")
      const store = new TaskStore(cwd, { authority: "SCHEDULER" })
      const autonomousCwd = cwd ?? process.cwd()

      // [DESIGN DECISION] The REAL tool objects, filtered to the 6S allow-list —
      // not freshly constructed look-alikes and not the whole session tool set. The
      // jailing inside the real `read_file` is part of the security boundary, and a
      // re-implemented tool would be a second implementation to keep correct.
      // `AUTONOMOUS_TOOL_NAMES` is the 6S matrix's own output, so this cannot widen.
      const autonomousTools = AUTONOMOUS_TOOL_NAMES.map((name) =>
        sessionTools.find((t) => t.name === name),
      ).filter((t): t is NonNullable<typeof t> => t !== undefined)

      return {
        sessionId,
        cwd: autonomousCwd,
        store,
        instruction: "Work autonomously on the assigned task. Report what you found.",
        model: modelRef.current,
        adapter: {
          store,
          tools: autonomousTools,
          provider: router,
          model: modelRef.current,
          cwdFor: () => autonomousCwd,
          // [P1 M15] Turn otonom melewati admission runtime yang sama dengan turn
          // user: M13 → Kernel, lalu eksekusi fisiknya (child session) di dalam
          // execution itu. `undefined` pada mode selain `owned` = jalur lama.
          ...(executionRunner.owns ? { executionRunner } : {}),
          // [PHASE 6U] The autonomous child session is a REAL MiniCode session
          // over the REAL provider chain — the same `router` the user session
          // uses — so autonomous work does not run a different model or a weaker
          // tool stack than the interactive session.
          sessionFactory: async (spec: AutonomousSessionSpec) =>
            createMinicodeSession({
              provider: spec.provider as never,
              tools: spec.tools as never,
              cwd: spec.cwd,
              systemExtra: spec.systemExtra,
              // [PHASE 6U] The child conversation id is NOT a kernel config field.
              timeoutMs: spec.timeoutMs,
              // [PHASE 6U][SECURITY] The 6S handler, not a `readonly` MODE. This
              // seam is what keeps 6S's policy in force in production: the
              // mode-derived handler is revocable via `__setMode` and admits
              // `web_fetch`, both of which 6S ruled out for an unattended run.
              permissionHandler: spec.permissionHandler as never,
              permissionMode: "readonly",
            }),
        },
        // [PHASE 6U] The binding is read from DURABLE state at dispatch time. The
        // claim was accepted microseconds ago, so the store's current generation IS
        // this claim's generation — and reading it durably means a binding can
        // never be a guess about in-memory state.
        bindingFor: (taskId: string) => ({
          parentSessionId: sessionId,
          taskId,
          execGeneration: store.getExecutionLineage(sessionId, taskId)?.execGeneration ?? 0,
          sessionIncarnation: store.getSessionIncarnation(sessionId),
        }),
        // [PHASE 6AB] The sinks 6AA proved nobody passed. Both events were already
        // produced by 6U/6T's constructors; wiring them here is the entire
        // observability fix. They live INSIDE the `deps` thunk, so with the gate
        // shut they are never even constructed.
        onSchedulerEvent: (e) => schedulerObservability.noteSchedulerEvent(e),
        onTriggerEvent: (e) => schedulerObservability.noteTriggerEvent(e),
      }
    },
  )

  // ── [P1 M14] RUNTIME COMPOSITION ─────────────────────────────────────────────
  //
  // [DESIGN DECISION] One call, behind one boolean that defaults to false, with
  // its dependencies in a THUNK — the same shape as the Scheduler above, on
  // purpose. The alternative ("just construct it here and ignore it") satisfies
  // the letter of "gated" while opening a SQLite handle and constructing a host,
  // a kernel and a supervisor on every single run.
  //
  // [DESIGN DECISION] The journal path comes from the RESUMED identity
  // (`resumeId ?? sessionId`, the same one the presentation layer already uses),
  // not from `sessionId`. A resume that minted a fresh path would silently start
  // from an empty history while looking exactly like a successful resume; this is
  // the class of bug `--resume` exists to prevent. If the resumed session has no
  // runtime journal at all, the journal is created fresh AT THAT PATH — never at a
  // new path derived from the new session id, which would strand the old history
  // and invent a second file for one resume.
  async function close(): Promise<void> {
    // [PHASE 6U] SHUTDOWN ORDERING. Stop autonomous work FIRST, before the
    // presentation layer is detached and before background jobs are killed.
    //
    // [DESIGN DECISION] The scheduler goes first because it is the only thing
    // here that can still start new work. Detaching UI first would leave a live
    // autonomous turn running with nothing to report to, and killing background
    // jobs first would race an autonomous turn that might legitimately use one.
    //
    // Idempotent and inert when the gate is off, so this line costs nothing in
    // the default configuration.
    try {
      await productionScheduler.stop("shutdown")
      // [PHASE 6AB] `Scheduler.stop()` releases authority without emitting a
      // `cycle:stopped`, so the projection is told explicitly. Otherwise the last
      // activity line an operator sees after exit would describe work rather than
      // the shutdown that ended it.
      if (productionScheduler.constructed) schedulerObservability.noteStopped("shutdown")
    } catch {
      // Teardown must not fail because a scheduler could not stop. Durable
      // recovery remains authoritative for anything still in flight.
    }
    // [P1 M14] Runtime goes SECOND: after autonomous work has stopped (so nothing
    // new can be admitted) but before the UI is detached and background jobs are
    // killed (so a live kernel transition still has a journal to land in). Its
    // own close order is: admission latch → host drain → execution/event drain →
    // journal flush → journal close → host close.
    //
    // Inert when the gate is off, so this line costs nothing by default.
    //
    // [DESIGN DECISION] NO extra stderr writer for an incomplete shutdown. The
    // writer inventory (OAP-008) exists so writer count in this file only goes
    // DOWN, and every other teardown path here is deliberately silent; the truth
    // is not lost either — `productionRuntime.shutdownResult()` carries the
    // structured per-phase result (including a non-confirmed durability verdict)
    // for tests and diagnostics, which is where a teardown warning would end up
    // anyway. Silent teardown + inspectable result beats a new writer slot.
    // [P1 M15] Lepas DI sub-agen saat teardown: proses boleh punya beberapa sesi
    // dalam masa pakainya (test/embed), dan runner milik sesi yang sudah tutup
    // tak boleh menerima turn baru.
    if (executionRunner.owns) setSubAgentExecutionRunner(undefined)
    try {
      await productionRuntime.stop()
    } catch {
      // Same rule as the scheduler: teardown never fails on a runtime that could
      // not close. Whatever is unrecorded stays recoverable from the journal.
    }
    flushPresentationEvents()
    await presentationWriteTail
    detachUI()
    detachBusDebug()
    try {
      shadowUnsub?.()
    } catch {}
    shadowUnsub = null
    presentationSubscribers.clear()
    shadowState = null
    shadowDiag = null
    contentStore = null
    try {
      presentation?.dispose()
    } catch {}
    presentation = null
    setAskApprovalHook(undefined)
    // background job harus mati bersama CLI — jangan tinggalkan proses yatim
    killAllBackgroundJobs()
    await mcpCloseAll()
    await lspCloseAll()
    // SATU-SATUNYA pause() mid-process yang tersisa: teardown sesi. stdin
    // TTY kini mengalir seumur proses (tanpa pause per prompt) agar siklus
    // pause→resume tak membunuh 'data' di Bun Windows; tanpa pause di sini
    // event-loop tak pernah kering dan one-shot/exec tak pernah exit.
    try {
      process.stdin.setRawMode(false)
    } catch {}
    try {
      process.stdin.pause()
    } catch {}
  }

  return {
    session,
    cfg,
    cwd,
    sessionId,
    modelRef,
    effectiveInitialModel,
    effectiveTimeoutMs,
    permissionMode,
    allowLocalConfig: allowLocalConfig === true,
    sessionTools,
    allLoadedSkills,
    usage,
    budget,
    budgetStrict,
    memoryHits,
    detachSimple: () => detachUI(),
    persistCurrent,
    runPromptWithVerify,
    permissions,
    close,
    // [PHASE 6AB] The two objects the operator control surface needs. Exposed on
    // the session, not through a registry: whoever holds a CliSession can operate
    // the Scheduler of exactly that session and no other.
    productionScheduler,
    schedulerObservability,
    // [P1 M14] Same rule as the Scheduler handle above: one session owns one
    // runtime, reachable only through the session, never through a registry.
    productionRuntime,
    /** [P1 M15] Mode runtime yang benar-benar dipakai sesi ini. */
    runtimeMode: effectiveRuntimeMode,
    /** [P1 M15] Admission runtime untuk turn sesi ini (mode off = pass-through). */
    executionRunner,
    /** [P1 M15] Laporan bukti durable saat start (integritas + tafsir M12). */
    startupRecovery,
    /** Counter reducer presentasi (divergensi harus 0). */
    getShadowDiagnostics,
    getPresentationSnapshot,
    onPresentationEvent,
    expandAllContent: (): ContentEntry[] => contentStore?.expandAll() ?? [],
    /** Query content store untuk /expand [id] (buka-ulang identik). */
    expandContent: (toolCallId: string): ContentEntry[] => {
      if (!contentStore) return []
      // Durable fallback: sqlite tool result full (hanya output; reasoning
      // di luar retensi = penanda). Best-effort — miss = tanpa konten.
      const durable = (id: string): string | undefined => {
        try {
          const sess = loadSession(resumeId ?? sessionId, cwd)
          if (!sess) return undefined
          for (const m of sess.messages as {
            role?: string
            toolCallId?: string
            content?: unknown
          }[]) {
            if (m.role === "tool" && m.toolCallId === id) {
              return typeof m.content === "string"
                ? m.content
                : m.content != null
                  ? JSON.stringify(m.content)
                  : undefined
            }
          }
        } catch {}
        return undefined
      }
      return contentStore.expand(toolCallId, durable)
    },
  }
}
