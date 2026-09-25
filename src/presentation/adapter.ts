// Adaptor semantik lama → DomainEvent V2.1 (Fase 1).
//
// Kenapa berkas ini ada: kernel meng-emit event miskin (deny/unknown/validate
// tanpa event — executor.ts:44-73; abort/timeout diam — session.ts:240-248;
// finalText dibuang UI; approval hanya callback). Berkas ini merekonstruksi
// lifecycle yang hilang TANPA mengubah kernel: deny dari step.results,
// turn-settle dari driver (noteRunSettled), approval dari hook permission.
//
// Aturan: aditif + read-only terhadap runtime. Jam (Date.now) dan counter
// HANYA di sini (tepi), bukan di reducer (Fase 3, murni). Semua handler
// dibungkus try/catch: observability tak boleh menggagalkan turn (pola yang
// sama dengan isolasi per-handler di events kernel). Dual-subscribe dengan
// sink lama — perilaku user NOL berubah pada Fase 1.

import { classifyToolResult, denyReasonOf, summarizeArgs } from "../telemetry/trace.ts"
import type {
  ApprovalEventHook,
  ApprovalHookEvent,
  ApprovalRequestedEvent,
  ApprovalSettledEvent,
  ArgsSummary,
  CancelReason,
  ChildSessionLink,
  DomainEvent,
  EventBusLike,
  FailCause,
  PlanStep,
  SemanticSeverity,
  ToolIdentity,
  TurnSummary,
} from "./events.ts"
import { type ContentStore, MAX_SECTION_CHARS } from "./store.ts"

export interface AdapterDiagnostics {
  eventsIn: number
  emitted: number
  deniedReconstructed: number
  turnsSettled: number
  approvals: number
  /** Terminal kedua untuk id sama / settle tanpa start / open yatim. */
  anomalies: number
  errors: number
  /** Forward anak tanpa pasangan delegate_task yang bisa ditebak (Fase 2). */
  orphanChild: number
  userMessages: number
  /** Bentuk execution rusak — event dilewati, bukan crash (Fase 2). */
  malformedExecution: number
}

export interface RunSettleInfo {
  /** ctl.signal.aborted (turn sendiri gugur). */
  aborted: boolean
  /** Signal parent (REPL/Ctrl+C) gugur — pemicu user. */
  parentAborted: boolean
}

export type TurnSummaryProvider = (input: {
  sessionId: string
  turnId: number
  fallback: TurnSummary
}) => TurnSummary

export interface PresentationAdapter {
  onEvent(handler: (e: DomainEvent) => void): () => void
  /** Dipanggil permission/ask_user via hook DI (bukan event bus). */
  publishApproval(e: ApprovalHookEvent): void
  noteUserMessage(info: { text: string; promptRef?: string; turnId?: number }): void
  /** Dipanggil driver (runOnce) saat session.run reject — kernel diam di sini. */
  noteRunSettled(error: unknown, info: RunSettleInfo): void
  noteFileChanged(info: {
    toolCallId: string
    paths: string[]
    journalSeq?: number
    checkpointId?: string
    sessionId?: string
    turnId?: number
  }): void
  noteTestCompleted(info: {
    toolCallId: string
    passed: number
    failed: number
    summary: string
    sessionId?: string
    turnId?: number
  }): void
  noteCheckpoint(info: { checkpointId: string; paths?: string[]; turnId?: number }): void
  setTurnSummaryProvider(provider: TurnSummaryProvider | undefined): void
  getDiagnostics(): AdapterDiagnostics
  dispose(): void
}

/** Parse SEKALI di sini — renderer dilarang mem-parse string (anti-pattern). */
export function parseQualifiedName(qualified: string): ToolIdentity {
  const q = String(qualified ?? "tool")
  const dot = q.indexOf(".")
  if (dot <= 0) return { origin: "builtin", name: q, qualified: q }
  return { origin: "mcp", namespace: q.slice(0, dot), name: q.slice(dot + 1), qualified: q }
}

function extractTarget(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined
  const a = args as Record<string, unknown>
  if (typeof a.path === "string" && a.path) return a.path
  const cmd = a.cmd ?? a.command
  if (typeof cmd === "string" && cmd) return `$ ${cmd}`
  if (typeof a.file === "string" && a.file) return a.file
  return undefined
}

function summarize(args: unknown): ArgsSummary {
  return { target: extractTarget(args), text: summarizeArgs(args) }
}

function firstLine(content: unknown, max: number): string {
  const s = typeof content === "string" ? content : String(content ?? "")
  const line = s.split("\n")[0] ?? ""
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** Ekstrak teks konten tool untuk store (string | content-block array | obj). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c
        if (c && typeof c === "object" && "text" in c) {
          const t = (c as { text?: unknown }).text
          return typeof t === "string" ? t : ""
        }
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  if (content && typeof content === "object" && "text" in content) {
    const t = (content as { text?: unknown }).text
    return typeof t === "string" ? t : ""
  }
  return ""
}

function isPermissionDenied(content: unknown): boolean {
  return classifyToolResult({ isError: true, content }) === "denied"
}

function mapToolFailCause(content: unknown): FailCause {
  const t = String(typeof content === "string" ? content : String(content ?? ""))
  if (/^\s*(unknown tool|invalid arguments)/i.test(t)) return "invalid"
  if (/max_steps|budget|context[\s\S]{0,20}exceed/i.test(t)) return "agent"
  // Sebab provider tak terdeteksi andal dari teks hasil tool — Fase 1 tidak
  // mengarangnya (documented gap; provider cause hanya dari AgentError turn).
  return "exec"
}

/**
 * Runtime assert bentuk execution (Fase 2): cast `as unknown` di cli/tui.ts
 * menutupi payload rusak — adaptor tidak boleh crash, hanya lewati + counter.
 */
export function assertExecutionShape(e: unknown): e is {
  execution: {
    call: { id: string; name: string; args?: unknown }
    result?: { isError?: boolean; content?: unknown }
  }
  forwardedChild?: string
} {
  if (typeof e !== "object" || e === null) return false
  const exec = (e as { execution?: unknown }).execution
  if (typeof exec !== "object" || exec === null) return false
  const call = (exec as { call?: unknown }).call
  if (typeof call !== "object" || call === null) return false
  const { id, name } = call as { id?: unknown; name?: unknown }
  return typeof id === "string" && id.length > 0 && typeof name === "string" && name.length > 0
}

export interface SubmittedFinding {
  findingId: string
  category: string
  severity: SemanticSeverity
  summary: string
  evidence: string[]
}

// Temuan hanya boleh lahir dari struktur eksplisit `submit_result`, bukan dari
// menebak teks bebas. Bentuk tak valid dilewati agar kontrak ketat.
const findingSeverities: readonly SemanticSeverity[] = ["info", "warning", "error", "critical"]
function cleanFindingText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim().replace(/\s+/g, " ")
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max)}…` : text
}
function cleanFindingEvidence(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  const out: string[] = []
  for (const item of items.slice(0, 10)) {
    const text = cleanFindingText(item, 200)
    if (text) out.push(text)
  }
  return out
}
export function findingsFromSubmitResult(args: unknown, callId: string): SubmittedFinding[] {
  if (typeof args !== "object" || args === null || !callId) return []
  const result = (args as { result?: unknown }).result
  if (typeof result !== "object" || result === null) return []
  const raw = (result as { findings?: unknown }).findings
  if (!Array.isArray(raw)) return []
  const findings: SubmittedFinding[] = []
  for (const [index, item] of raw.slice(0, 5).entries()) {
    if (typeof item !== "object" || item === null) continue
    const value = item as {
      category?: unknown
      severity?: unknown
      summary?: unknown
      evidence?: unknown
    }
    const category = cleanFindingText(value.category, 80)
    const summary = cleanFindingText(value.summary, 500)
    if (!category || !summary) continue
    if (!findingSeverities.includes(value.severity as SemanticSeverity)) continue
    findings.push({
      findingId: `finding:${callId}:${index + 1}`,
      category,
      severity: value.severity as SemanticSeverity,
      summary,
      evidence: cleanFindingEvidence(value.evidence),
    })
  }
  return findings
}

export function createPresentationAdapter(
  source: EventBusLike,
  opts: {
    sessionId: string
    contentStore?: ContentStore
    initialSeq?: number
    initialTurn?: number
    initialTurnStartTs?: number
  },
): PresentationAdapter {
  const sessionId = opts.sessionId
  const contentStore = opts.contentStore
  let seq = opts.initialSeq ?? 0
  let currentTurn = opts.initialTurn ?? 0
  let turnStartTs = opts.initialTurnStartTs ?? 0
  let turnSummaryProvider: TurnSummaryProvider | undefined
  let currentStep = 0
  let reasoningText = ""
  let reasoningTruncated = false
  const toolStarts = new Map<string, number>()
  const openTools = new Map<
    string,
    { name: string; parentLink?: ChildSessionLink; childSessionId?: string }
  >()
  const terminalTools = new Set<string>()
  const openApprovals = new Map<string, boolean>()
  // Fase 2: pasangan sub-anak — FIFO call.id delegate_task yang started tapi
  // belum completed; map childSessionId → taut. Paralel (>1 pending) TIDAK
  // ditebak (§12: fallback tanpa-link, jangan atribusi salah).
  const pendingDelegateCalls: string[] = []
  const childLinks = new Map<string, ChildSessionLink>()
  const counts = { ok: 0, failed: 0, denied: 0, cancelled: 0 }
  const handlers = new Set<(e: DomainEvent) => void>()
  const diag: AdapterDiagnostics = {
    eventsIn: 0,
    emitted: 0,
    deniedReconstructed: 0,
    turnsSettled: 0,
    approvals: 0,
    anomalies: 0,
    errors: 0,
    orphanChild: 0,
    userMessages: 0,
    malformedExecution: 0,
  }

  const publish = (e: DomainEvent): void => {
    diag.emitted++
    for (const h of [...handlers]) {
      try {
        h(e)
      } catch {
        diag.errors++
      }
    }
  }
  const base = (turnId: number) => ({ eventSeq: ++seq, ts: Date.now(), sessionId, turnId })
  /** Forward anak: sessionId DomainEvent = anak; parentLink bila sudah dipasangkan. */
  const childBase = (turnId: number, childId: string, parentLink?: ChildSessionLink) => ({
    eventSeq: ++seq,
    ts: Date.now(),
    sessionId: childId,
    turnId,
    ...(parentLink ? { parentLink } : {}),
  })
  const reasoningRef = (): { toolCallId: string; idx: number; kind: "reasoning" } => ({
    toolCallId: `reasoning:${sessionId}:${currentTurn}`,
    idx: 0,
    kind: "reasoning",
  })
  const finishReasoning = (): void => {
    if (!reasoningText) return
    const ref = reasoningRef()
    if (contentStore) {
      try {
        contentStore.put(ref, reasoningText, {
          kind: "reasoning",
          stream: "stderr",
          truncated: reasoningTruncated,
        })
      } catch {
        diag.errors++
      }
    }
    publish({
      ...base(currentTurn),
      type: "reasoning.completed",
      turnId: currentTurn,
      truncated: reasoningTruncated,
      expandRef: ref,
    })
    reasoningText = ""
    reasoningTruncated = false
  }
  const planFromTodoArgs = (
    args: unknown,
  ): { steps: PlanStep[]; status: "open" | "completed" | "cancelled" } | undefined => {
    if (typeof args !== "object" || args === null) return undefined
    const raw = (args as { todos?: unknown }).todos
    if (!Array.isArray(raw) || raw.length === 0) return undefined
    const steps: PlanStep[] = []
    for (const [index, item] of raw.slice(0, 100).entries()) {
      if (typeof item !== "object" || item === null) continue
      const value = item as { content?: unknown; status?: unknown }
      const title = typeof value.content === "string" ? value.content.trim().slice(0, 200) : ""
      if (!title) continue
      const status =
        value.status === "completed" || value.status === "cancelled"
          ? value.status
          : value.status === "in_progress"
            ? "active"
            : "pending"
      steps.push({ stepId: String(index + 1), title, status })
    }
    if (steps.length === 0) return undefined
    const status = steps.every((step) => step.status === "completed")
      ? "completed"
      : steps.every((step) => step.status === "cancelled")
        ? "cancelled"
        : "open"
    return { steps, status }
  }

  const markTerminal = (id: string): boolean => {
    if (terminalTools.has(id)) {
      diag.anomalies++
      return false
    }
    terminalTools.add(id)
    openTools.delete(id)
    toolStarts.delete(id)
    return true
  }

  const noteDelegateStarted = (callId: string, name: string, forwarded?: string): void => {
    // Forward anak tidak mendaftar sebagai induk; hanya call parent asli.
    if (forwarded) return
    if (name === "delegate_task") pendingDelegateCalls.push(callId)
  }

  const noteDelegateSettled = (callId: string, name: string, forwarded?: string): void => {
    if (forwarded) return
    if (name !== "delegate_task") return
    const i = pendingDelegateCalls.indexOf(callId)
    if (i >= 0) pendingDelegateCalls.splice(i, 1)
  }

  /**
   * Pasangkan forward anak dengan induk: tepat SATU call delegate_task pending
   * → taut; nol = orphan; >1 = paralel ambigu → tanpa taut (jangan tebak).
   */
  const resolveChildLink = (childId: string): ChildSessionLink | undefined => {
    const hit = childLinks.get(childId)
    if (hit) return hit
    if (pendingDelegateCalls.length !== 1) {
      diag.orphanChild++
      return undefined
    }
    const link: ChildSessionLink = {
      parentToolCallId: pendingDelegateCalls[0]!,
      childSessionId: childId,
      parentSessionId: sessionId,
    }
    childLinks.set(childId, link)
    return link
  }

  const extractForward = (e: unknown): string | undefined => {
    const f = (e as { forwardedChild?: unknown } | null)?.forwardedChild
    return typeof f === "string" && f ? f : undefined
  }

  const cascadeOpenTools = (reason: CancelReason): void => {
    for (const [id, meta] of openTools) {
      if (!markTerminal(id)) continue
      // Tool anak tidak menghitung ke tally turn parent (1 baris delegasi).
      if (!meta.childSessionId) counts.cancelled++
      const sid = meta.childSessionId
      if (sid && meta.parentLink) {
        publish({
          ...childBase(currentTurn, sid, meta.parentLink),
          type: "tool.cancelled",
          toolCallId: id,
          reason,
        })
      } else {
        publish({ ...base(currentTurn), type: "tool.cancelled", toolCallId: id, reason })
      }
    }
  }

  const closeOpenApprovals = (): void => {
    for (const approvalId of openApprovals.keys()) {
      openApprovals.delete(approvalId)
      publish({
        ...base(currentTurn),
        type: "approval.settled",
        approvalId,
        outcome: { decision: "cancelled", by: "system", reason: "parent-ended" },
      })
    }
  }

  const turnSummary = (): TurnSummary => {
    const fallback: TurnSummary = {
      toolsOk: counts.ok,
      toolsFailed: counts.failed,
      toolsDenied: counts.denied,
      toolsCancelled: counts.cancelled,
      toolsInterrupted: 0,
      filesChanged: 0,
      durationMs: Math.max(0, Date.now() - turnStartTs),
    }
    return turnSummaryProvider?.({ sessionId, turnId: currentTurn, fallback }) ?? fallback
  }

  const resetTurnCounters = (): void => {
    counts.ok = 0
    counts.failed = 0
    counts.denied = 0
    counts.cancelled = 0
  }

  const unsubs: (() => void)[] = []
  const sub = (type: string, fn: (e: any) => void): void => {
    try {
      unsubs.push(
        source.on(type, (e: any) => {
          diag.eventsIn++
          try {
            fn(e)
          } catch {
            diag.errors++
          }
        }),
      )
    } catch {
      diag.errors++
    }
  }

  sub("turn:started", (e: { turn?: unknown }) => {
    // Turn baru dengan tool yatim = anomali (kernel men-settle semua sebelum
    // selesai, kecuali abort yang lewat noteRunSettled): tutup paksa + hitung.
    if (openTools.size > 0) {
      diag.anomalies++
      cascadeOpenTools("parent-ended")
    }
    currentTurn = typeof e?.turn === "number" ? e.turn : currentTurn + 1
    currentStep = 0
    reasoningText = ""
    reasoningTruncated = false
    turnStartTs = Date.now()
    resetTurnCounters()
    publish({
      ...base(currentTurn),
      type: "turn.started",
      turnId: currentTurn,
      promptRef: `turn:${currentTurn}`,
    })
  })

  sub("turn:completed", (e: { result?: unknown }) => {
    const r = (e?.result ?? {}) as { finalText?: unknown }
    const text = typeof r.finalText === "string" ? r.finalText : ""
    finishReasoning()
    if (text) {
      publish({
        ...base(currentTurn),
        type: "model.completed",
        turnId: currentTurn,
        text,
        truncated: false,
      })
    }
    publish({
      ...base(currentTurn),
      type: "result.produced",
      turnId: currentTurn,
      resultId: `result:${sessionId}:${currentTurn}`,
      status: "completed",
      summary: text || "turn completed",
    })
    diag.turnsSettled++
    publish({
      ...base(currentTurn),
      type: "turn.completed",
      turnId: currentTurn,
      summary: turnSummary(),
    })
  })

  sub("step:started", (e: { step?: { index?: unknown } }) => {
    if (typeof e?.step?.index === "number") currentStep = e.step.index
  })

  sub("step:completed", (e: { step?: { results?: unknown } }) => {
    const results = Array.isArray(e?.step?.results)
      ? (e.step.results as Record<string, unknown>[])
      : []
    // Rekonstruksi yang hilang: kernel tidak meng-emit execution:* untuk call
    // yang gagal di gate (executor.ts:44-73) dan untuk hasil sintetis executor
    // (pairToolResults/loop-catch) — satu-satunya jejak adalah results.
    for (const r of results) {
      const id = typeof r.toolCallId === "string" ? r.toolCallId : undefined
      if (!id || terminalTools.has(id) || !r.isError) continue
      if (isPermissionDenied(r.content)) {
        terminalTools.add(id)
        openTools.delete(id)
        counts.denied++
        diag.deniedReconstructed++
        publish({
          ...base(currentTurn),
          type: "tool.denied",
          toolCallId: id,
          reason: denyReasonOf({ isError: true, content: r.content }) ?? "unknown",
          message: firstLine(r.content, 200),
        })
        continue
      }
      // Hasil error tanpa execution event DAN pernah started = sintetis
      // executor (tanpa ini lifecycle-nya yatim selamanya). Tanpa started
      // (adapter dipasang telat) jangan mengarang — lewati + hitung.
      if (!openTools.has(id)) {
        diag.anomalies++
        continue
      }
      const t0 = toolStarts.get(id)
      terminalTools.add(id)
      openTools.delete(id)
      toolStarts.delete(id)
      counts.failed++
      publish({
        ...base(currentTurn),
        type: "tool.failed",
        toolCallId: id,
        durationMs: t0 !== undefined ? Math.max(0, Date.now() - t0) : 0,
        cause: "exec",
        message: firstLine(r.content, 200),
        expandRef: { toolCallId: id, idx: 0 },
      })
    }
  })

  sub(
    "execution:started",
    (e: {
      execution?: { call?: { id?: unknown; name?: unknown; args?: unknown } }
      forwardedChild?: unknown
    }) => {
      if (!assertExecutionShape(e)) {
        diag.malformedExecution++
        return
      }
      const call = e.execution.call
      const childId = extractForward(e)
      noteDelegateStarted(call.id, call.name, childId)
      const parentLink = childId ? resolveChildLink(childId) : undefined
      toolStarts.set(call.id, Date.now())
      openTools.set(call.id, {
        name: call.name,
        ...(parentLink ? { parentLink } : {}),
        ...(childId ? { childSessionId: childId } : {}),
      })
      const plan = call.name === "todo_write" ? planFromTodoArgs(call.args) : undefined
      if (plan) {
        const planSessionId = childId ?? sessionId
        publish({
          ...(childId ? childBase(currentTurn, childId, parentLink) : base(currentTurn)),
          type: "plan.updated",
          planId: `plan:${planSessionId}:${currentTurn}`,
          status: plan.status,
          steps: plan.steps,
        })
      }
      if (childId) {
        publish({
          ...childBase(currentTurn, childId, parentLink),
          type: "tool.started",
          toolCallId: call.id,
          turnId: currentTurn,
          stepId: currentStep,
          identity: parseQualifiedName(call.name),
          argsSummary: summarize(call.args),
        })
        return
      }
      publish({
        ...base(currentTurn),
        type: "tool.started",
        toolCallId: call.id,
        turnId: currentTurn,
        stepId: currentStep,
        identity: parseQualifiedName(call.name),
        argsSummary: summarize(call.args),
      })
    },
  )

  sub(
    "execution:completed",
    (e: {
      execution?: {
        call?: { id?: unknown; name?: unknown; args?: unknown }
        result?: { isError?: unknown; content?: unknown }
      }
      forwardedChild?: unknown
    }) => {
      if (!assertExecutionShape(e) || !e.execution.result) {
        diag.malformedExecution++
        return
      }
      const call = e.execution.call
      const result = e.execution.result
      const childId = extractForward(e)
      noteDelegateSettled(call.id, call.name, childId)
      const meta = openTools.get(call.id)
      const parentLink = meta?.parentLink ?? (childId ? resolveChildLink(childId) : undefined)
      const t0 = toolStarts.get(call.id)
      const durationMs = t0 !== undefined ? Math.max(0, Date.now() - t0) : 0
      if (!markTerminal(call.id)) return
      // Anak tidak menghitung ke summary parent — ledger parent = 1 baris
      // delegasi (delegate_task sendiri), bukan N tool anak.
      const count = !childId
      // Setiap event terminal butuh eventSeq sendiri: basis bersama membuat
      // INSERT OR IGNORE durable melewatkan event berikutnya dengan seq sama.
      const nextBase = () =>
        childId ? childBase(currentTurn, childId, parentLink) : base(currentTurn)
      const withLink = <T extends DomainEvent>(ev: T): T =>
        parentLink ? { ...ev, parentLink } : ev
      // Fase 4: konten completed → store (put selalu jalan — zero user-visible
      // change; hanya expand(id) yang flag-gated di tui).
      if (contentStore) {
        try {
          const text = contentText(result.content)
          if (text) {
            contentStore.put({ toolCallId: call.id, idx: 0 }, text, {
              kind: "output",
              stream: result.isError ? "stderr" : "stdout",
              truncated: false,
            })
          }
        } catch {
          diag.errors++
        }
      }
      if (!result.isError) {
        if (count) counts.ok++
        if (call.name === "submit_result") {
          const args = call.args as { summary?: unknown }
          publish(
            withLink({
              ...nextBase(),
              type: "result.produced",
              resultId: `submit:${call.id}`,
              status: "completed",
              summary:
                typeof args.summary === "string" ? args.summary : "structured result submitted",
            }),
          )
          for (const finding of findingsFromSubmitResult(call.args, call.id)) {
            publish(
              withLink({
                ...nextBase(),
                type: "finding.detected",
                turnId: currentTurn,
                ...finding,
              }),
            )
          }
        }
        publish(
          withLink({
            ...nextBase(),
            type: "tool.completed" as const,
            toolCallId: call.id,
            durationMs,
            summary: firstLine(result.content, 200),
            expandRef: { toolCallId: call.id, idx: 0 },
          }),
        )
        return
      }
      // Pertahanan lapis-dua: hasil deny yang lolos dengan execution event
      // (tak terjadi via runCall kernel, tapi bisa via forward/executor custom).
      if (isPermissionDenied(result.content)) {
        if (count) counts.denied++
        diag.deniedReconstructed++
        publish(
          withLink({
            ...nextBase(),
            type: "tool.denied" as const,
            toolCallId: call.id,
            reason: denyReasonOf({ isError: true, content: result.content }) ?? "unknown",
            message: firstLine(result.content, 200),
          }),
        )
        return
      }
      if (count) counts.failed++
      publish(
        withLink({
          ...nextBase(),
          type: "tool.failed" as const,
          toolCallId: call.id,
          durationMs,
          cause: mapToolFailCause(result.content),
          message: firstLine(result.content, 200),
          expandRef: { toolCallId: call.id, idx: 0 },
        }),
      )
    },
  )

  sub("provider:text", (e: { text?: unknown }) => {
    if (typeof e?.text !== "string" || !e.text) return
    publish({ ...base(currentTurn), type: "model.delta", turnId: currentTurn, delta: e.text })
  })

  sub("provider:extension", (e: { kind?: unknown; data?: unknown }) => {
    if (e?.kind === "error") {
      const data = e.data as { message?: unknown; error?: unknown } | null
      const message =
        typeof data?.message === "string"
          ? data.message
          : typeof data?.error === "string"
            ? data.error
            : "provider extension error"
      publish({
        ...base(currentTurn),
        type: "diagnostic.raised",
        turnId: currentTurn,
        category: "PROVIDER_ERROR",
        severity: "error",
        message: message.slice(0, 500),
      })
      return
    }
    if (e?.kind !== "reasoning") return
    const text = (e.data as { text?: unknown } | null)?.text
    if (typeof text !== "string" || !text) return
    if (reasoningText.length < MAX_SECTION_CHARS) {
      const remaining = MAX_SECTION_CHARS - reasoningText.length
      reasoningText += text.slice(0, remaining)
      if (text.length > remaining) reasoningTruncated = true
    } else {
      reasoningTruncated = true
    }
    publish({ ...base(currentTurn), type: "reasoning.delta", turnId: currentTurn, delta: text })
  })

  sub("context:compacted", (e: { reason?: unknown }) => {
    publish({
      ...base(currentTurn),
      type: "context.compacted",
      reason: typeof e?.reason === "string" ? e.reason : "",
    })
  })

  const noteUserMessage: PresentationAdapter["noteUserMessage"] = ({ text, promptRef, turnId }) => {
    try {
      if (!text) return
      diag.userMessages++
      const resolvedTurn = turnId ?? currentTurn
      publish({
        ...base(resolvedTurn),
        type: "user.message",
        text,
        promptRef: promptRef ?? `turn:${resolvedTurn}`,
      })
    } catch {
      diag.errors++
    }
  }

  const publishApproval: PresentationAdapter["publishApproval"] = (e) => {
    try {
      const identity = parseQualifiedName(String(e.call?.name ?? "tool"))
      const argsSummary = summarize(e.call?.args)
      const toolCallId = typeof e.call?.id === "string" ? e.call.id : undefined
      diag.approvals++
      if (e.kind === "requested") {
        openApprovals.set(e.approvalId, true)
        const out: ApprovalRequestedEvent = {
          ...base(currentTurn),
          type: "approval.requested",
          approvalId: e.approvalId,
          identity,
          argsSummary,
          via: e.via,
        }
        if (toolCallId !== undefined) out.toolCallId = toolCallId
        publish(out)
        return
      }
      openApprovals.delete(e.approvalId)
      const settled: ApprovalSettledEvent = {
        ...base(currentTurn),
        type: "approval.settled",
        approvalId: e.approvalId,
        outcome: e.outcome,
      }
      if (toolCallId !== undefined) settled.toolCallId = toolCallId
      publish(settled)
    } catch {
      diag.errors++
    }
  }

  const noteFileChanged: PresentationAdapter["noteFileChanged"] = (info) => {
    try {
      publish({
        ...base(info.turnId ?? currentTurn),
        ...(info.sessionId ? { sessionId: info.sessionId } : {}),
        type: "file.changed",
        toolCallId: info.toolCallId,
        paths: info.paths,
        ...(info.journalSeq !== undefined ? { journalSeq: info.journalSeq } : {}),
        ...(info.checkpointId !== undefined ? { checkpointId: info.checkpointId } : {}),
      })
    } catch {
      diag.errors++
    }
  }

  const noteTestCompleted: PresentationAdapter["noteTestCompleted"] = (info) => {
    try {
      publish({
        ...base(info.turnId ?? currentTurn),
        ...(info.sessionId ? { sessionId: info.sessionId } : {}),
        type: "test.completed",
        toolCallId: info.toolCallId,
        passed: info.passed,
        failed: info.failed,
        summary: info.summary,
      })
    } catch {
      diag.errors++
    }
  }

  const noteCheckpoint: PresentationAdapter["noteCheckpoint"] = (info) => {
    try {
      publish({
        ...base(info.turnId ?? currentTurn),
        type: "checkpoint.created",
        checkpointId: info.checkpointId,
        ...(info.paths ? { paths: info.paths } : {}),
      })
    } catch {
      diag.errors++
    }
  }

  const noteRunSettled: PresentationAdapter["noteRunSettled"] = (error, info) => {
    try {
      diag.turnsSettled++
      const kind = (error as { kind?: unknown } | null)?.kind
      if (info.parentAborted) {
        cascadeOpenTools("parent-aborted")
        closeOpenApprovals()
        publish({
          ...base(currentTurn),
          type: "turn.cancelled",
          turnId: currentTurn,
          reason: "user",
        })
        return
      }
      if (kind === "timeout") {
        cascadeOpenTools("timeout")
        closeOpenApprovals()
        publish({
          ...base(currentTurn),
          type: "turn.cancelled",
          turnId: currentTurn,
          reason: "timeout",
        })
        return
      }
      if (kind === "budget_exceeded") {
        cascadeOpenTools("budget")
        closeOpenApprovals()
        publish({
          ...base(currentTurn),
          type: "turn.cancelled",
          turnId: currentTurn,
          reason: "budget",
        })
        return
      }
      if (kind === "aborted" || info.aborted) {
        cascadeOpenTools("parent-aborted")
        closeOpenApprovals()
        publish({
          ...base(currentTurn),
          type: "turn.cancelled",
          turnId: currentTurn,
          reason: "user",
        })
        return
      }
      cascadeOpenTools("parent-ended")
      closeOpenApprovals()
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : String(error ?? "")
      publish({
        ...base(currentTurn),
        type: "turn.failed",
        turnId: currentTurn,
        error: {
          cause: kind === "provider" ? "provider" : "agent",
          message: message.slice(0, 500),
        },
      })
    } catch {
      diag.errors++
    }
  }

  return {
    onEvent(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    noteUserMessage,
    publishApproval,
    noteRunSettled,
    noteFileChanged,
    noteTestCompleted,
    noteCheckpoint,
    setTurnSummaryProvider(provider) {
      turnSummaryProvider = provider
    },
    getDiagnostics() {
      return { ...diag }
    },
    dispose() {
      for (const u of unsubs) {
        try {
          u()
        } catch {
          // Lepas listener tak boleh melempar.
        }
      }
      unsubs.length = 0
      handlers.clear()
      pendingDelegateCalls.length = 0
      childLinks.clear()
      openTools.clear()
      toolStarts.clear()
      openApprovals.clear()
      terminalTools.clear()
      turnSummaryProvider = undefined
    },
  }
}

export type { ApprovalEventHook, ChildSessionLink }
