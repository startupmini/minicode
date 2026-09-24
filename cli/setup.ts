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
import type { DomainEvent } from "../src/presentation/events.ts"
import { createInitialState, type PresentationState } from "../src/presentation/model.ts"
import {
  createReducerDiagnostics,
  type ReducerDiagnostics,
  reduce,
} from "../src/presentation/reducer.ts"
import {
  type ContentEntry,
  type ContentStore,
  createContentStore,
} from "../src/presentation/store.ts"
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
import { listPersistedTurns, loadSession, saveSession } from "../src/session/persistence.ts"
import { snapshotTree } from "../src/session/shadow-git.ts"
import type { Skill } from "../src/skills/loader.ts"
import {
  classifyToolResult,
  denyReasonOf,
  summarizeArgs,
  writeStepTrace,
} from "../src/telemetry/trace.ts"
import { setAskApprovalHook, setAskTextFn } from "../src/tools/ask_user.ts"
import { killAllBackgroundJobs } from "../src/tools/bash.ts"
import { setSubAgentParentRouting } from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"
import { promptAsk, promptAskText } from "../src/ui/approval/prompt.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import type {
  UiPresentationActivity,
  UiPresentationEvent,
  UiPresentationSnapshot,
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
  /** Fase 3 dark-launch: counter shadow reducer (divergensi harus 0). */
  getShadowDiagnostics: () => {
    divergence: number
    eventsIn: number
    duplicateTerminal: number
    lateEvent: number
    orphanTool: number
    orphanApproval: number
    duplicateTurn: number
  }
  /** Fase 4: content store untuk /expand [id] (flag-gated di tui). */
  expandContent: (toolCallId: string) => ContentEntry[]
  getPresentationSnapshot: () => UiPresentationSnapshot
  onPresentationEvent: (handler: (event: UiPresentationEvent) => void) => () => void
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
    verbose,
    allowAll,
    ask,
    plan,
    allowlist,
    verify,
    budget,
    budgetStrict,
    toolScope,
    allowLocalConfig,
    maxSteps,
    contextWindowTokens,
    keepRecentTurns,
    timeoutMs,
    rateLimiter,
    sandboxNotice,
  } = opts
  const modelRef = { current: modelOverride }

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
  // Fase 3 dark-launch: reducer berjalan paralel (shadow) — hasil DIBUANG,
  // tidak mengontrol output. Divergensi = reduce melempar (harusnya 0).
  let shadowState: PresentationState | null = null
  let shadowDiag: ReducerDiagnostics | null = null
  let shadowDivergence = 0
  let shadowUnsub: (() => void) | null = null
  const presentationSubscribers = new Set<(event: UiPresentationEvent) => void>()
  // Fase 4: content store in-memory (selalu aktif — zero user-visible change;
  // hanya expand(id) yang flag-gated MINICODE_PRESENTATION_V2 di tui).
  let contentStore: ContentStore | null = null
  const getShadowDiagnostics = (): {
    divergence: number
    eventsIn: number
    duplicateTerminal: number
    lateEvent: number
    orphanTool: number
    orphanApproval: number
    duplicateTurn: number
  } => ({
    divergence: shadowDivergence,
    eventsIn: shadowDiag?.eventsIn ?? 0,
    duplicateTerminal: shadowDiag?.duplicateTerminal ?? 0,
    lateEvent: shadowDiag?.lateEvent ?? 0,
    orphanTool: shadowDiag?.orphanTool ?? 0,
    orphanApproval: shadowDiag?.orphanApproval ?? 0,
    duplicateTurn: shadowDiag?.duplicateTurn ?? 0,
  })
  const getPresentationSnapshot = (): UiPresentationSnapshot => {
    if (!shadowState) return { activities: [], turns: [] }
    const activities: UiPresentationActivity[] = [...shadowState.activities.values()].map((a) => ({
      seq: a.seq,
      turnId: a.turnId,
      sessionId: a.sessionId,
      toolCallId: a.toolCallId,
      name: a.identity.name,
      ...(a.target ? { target: a.target } : {}),
      status: a.status as UiToolStatus,
      tsStart: a.tsStart,
      ...(a.tsEnd !== undefined ? { tsEnd: a.tsEnd } : {}),
      ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
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
    return { activities, turns }
  }
  const toPresentationEvent = (event: DomainEvent): UiPresentationEvent | null => {
    switch (event.type) {
      case "tool.started":
        return {
          type: event.type,
          seq: event.eventSeq,
          turnId: event.turnId,
          toolCallId: event.toolCallId,
          name: event.identity?.name,
          target: event.argsSummary?.target,
          status: "running",
          tsStart: event.ts,
        }
      case "tool.completed":
      case "tool.failed":
      case "tool.denied":
      case "tool.cancelled":
        return {
          type: event.type,
          seq: event.eventSeq,
          turnId: event.turnId,
          toolCallId: event.toolCallId,
          status:
            event.type === "tool.completed"
              ? "completed"
              : event.type === "tool.failed"
                ? "failed"
                : event.type === "tool.denied"
                  ? "denied"
                  : "cancelled",
          message:
            "message" in event && typeof event.message === "string" ? event.message : undefined,
        }
      case "turn.completed":
        return {
          type: event.type,
          seq: event.eventSeq,
          turnId: event.turnId,
          summary: event.summary,
        }
      default:
        return null
    }
  }
  const publishPresentationEvent = (event: Parameters<typeof toPresentationEvent>[0]): void => {
    const projected = toPresentationEvent(event)
    if (!projected) return
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

  // todo_write/todo_read menyimpan state per sesi di .minicode/todos/<id>.json
  todoSession.id = sessionId
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
  // Adaptor mulai mengamati sejak bus hidup (closure onApprovalEvent di atas
  // aman: check() pertama selalu terjadi setelah wiring ini, saat run()).
  presentation = createPresentationAdapter(session.events, {
    sessionId,
    ...(contentStore ? { contentStore } : {}),
  })
  // Shadow reducer (Fase 3): consume DomainEvent yang sama, hasil dibuang.
  // Flag env MINICODE_PRESENTATION_V2 tidak diperlukan di sini — shadow selalu
  // jalan (observability), output TUI/linear masih sink lama.
  try {
    shadowState = createInitialState(sessionId)
    shadowDiag = createReducerDiagnostics()
    shadowUnsub = presentation.onEvent((e) => {
      try {
        if (shadowState && shadowDiag) reduce(shadowState, e, shadowDiag)
      } catch {
        shadowDivergence++
      }
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
    const turn = e.result.usage.turns
    const desc = `turn ${turn}`
    if (pre.mode === "git") {
      // Tree post-turn diambil sekarang, setelah semua tool selesai.
      const after = await snapshotTree(cwd ?? ".", sessionId, `post-${turn}`)
      recordCheckpointFromTrees(sessionId, turn, pre.tree, after?.tree, desc, cwd).catch(() => {})
      return
    }
    if (pre.snapshots.length === 0) return
    // Non-git: redo harus menangkap SEMUA perubahan termasuk bash/git,
    // bukan hanya edit/write_file. Ambil snapshot penuh post-turn.
    let redo = redoSnapshots
    try {
      const { LIMITS } = await import("../src/constants.ts")
      const post = await snapshotWorkspace(cwd ?? ".", LIMITS.WORKSPACE_SNAPSHOT_LIMIT)
      if (post.length) redo = post
    } catch {}
    recordCheckpointFromSnapshots(sessionId, turn, pre.snapshots, desc, cwd, redo).catch(() => {})
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
          await session.run(prompt, { model: modelRef.current, signal: ctl.signal })
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
    const broken = await checkBaseline(
      (s) => runVerify(verifyCommand, cwd ?? process.cwd(), undefined, s ?? signal),
      signal,
    )
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
        verify: (s) => runVerify(verifyCommand, cwd ?? process.cwd(), undefined, s ?? signal),
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
    // /copy, bufferSection untuk /expand). One-shot/exec (enterRepl false)
    // tetap melukis seperti dulu.
    detachSimple = attachSimpleLogger(session.events, { verbose, quiet: enterRepl === true })
    if (enterRepl === true) {
      turnStatus = null
      return
    }
    turnStatus = attachTurnStatus(session.events, {
      initialModel: effectiveInitialModel,
      getModel: () => modelRef.current ?? effectiveInitialModel,
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
      await saveSession(sessionId, cwd, undefined, session.state.history, usageData)
      if (resumeId) await saveSession(resumeId, cwd, undefined, session.state.history, usageData)
      // Riwayat durable → mutasi turn ini boleh di-finalize (sweep record).
      // Gagal finalize tak menggagalkan persist (warn di dalam).
      await finalizeJournal(sessionId, cwd).catch((e) => {
        process.stderr.write(`[warn] journal finalize failed: ${(e as Error).message}\n`)
      })
    } catch {}
  }

  async function close(): Promise<void> {
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
    /** Fase 3 dark-launch: counter shadow reducer (divergensi harus 0). */
    getShadowDiagnostics,
    getPresentationSnapshot,
    onPresentationEvent: (handler) => {
      presentationSubscribers.add(handler)
      return () => presentationSubscribers.delete(handler)
    },
    /** Fase 4: query content store untuk /expand [id] (buka-ulang identik). */
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
