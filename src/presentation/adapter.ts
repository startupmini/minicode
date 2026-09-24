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
  ToolIdentity,
  TurnSummary,
} from "./events.ts"

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
  /** Bentuk execution rusak — event dilewati, bukan crash (Fase 2). */
  malformedExecution: number
}

export interface RunSettleInfo {
  /** ctl.signal.aborted (turn sendiri gugur). */
  aborted: boolean
  /** Signal parent (REPL/Ctrl+C) gugur — pemicu user. */
  parentAborted: boolean
}

export interface PresentationAdapter {
  onEvent(handler: (e: DomainEvent) => void): () => void
  /** Dipanggil permission/ask_user via hook DI (bukan event bus). */
  publishApproval(e: ApprovalHookEvent): void
  /** Dipanggil driver (runOnce) saat session.run reject — kernel diam di sini. */
  noteRunSettled(error: unknown, info: RunSettleInfo): void
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

export function createPresentationAdapter(
  source: EventBusLike,
  opts: { sessionId: string },
): PresentationAdapter {
  const sessionId = opts.sessionId
  let seq = 0
  let currentTurn = 0
  let turnStartTs = 0
  let currentStep = 0
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

  const turnSummary = (): TurnSummary => ({
    toolsOk: counts.ok,
    toolsFailed: counts.failed,
    toolsDenied: counts.denied,
    toolsCancelled: counts.cancelled,
    toolsInterrupted: 0,
    filesChanged: 0,
    durationMs: Math.max(0, Date.now() - turnStartTs),
  })

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
    turnStartTs = Date.now()
    resetTurnCounters()
    publish({ ...base(currentTurn), type: "turn.started", turnId: currentTurn, promptRef: "" })
  })

  sub("turn:completed", (e: { result?: unknown }) => {
    const r = (e?.result ?? {}) as { finalText?: unknown }
    const text = typeof r.finalText === "string" ? r.finalText : ""
    if (text) {
      publish({
        ...base(currentTurn),
        type: "model.completed",
        turnId: currentTurn,
        text,
        truncated: false,
      })
    }
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
      const emitBase = childId ? childBase(currentTurn, childId, parentLink) : base(currentTurn)
      const withLink = <T extends DomainEvent>(ev: T): T =>
        parentLink ? { ...ev, parentLink } : ev
      if (!result.isError) {
        if (count) counts.ok++
        publish(
          withLink({
            ...emitBase,
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
            ...emitBase,
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
          ...emitBase,
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
    if (e?.kind !== "reasoning") return
    const text = (e.data as { text?: unknown } | null)?.text
    if (typeof text !== "string" || !text) return
    publish({ ...base(currentTurn), type: "reasoning.delta", turnId: currentTurn, delta: text })
  })

  sub("context:compacted", (e: { reason?: unknown }) => {
    publish({
      ...base(currentTurn),
      type: "context.compacted",
      reason: typeof e?.reason === "string" ? e.reason : "",
    })
  })

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
    publishApproval,
    noteRunSettled,
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
    },
  }
}

export type { ApprovalEventHook, ChildSessionLink }
