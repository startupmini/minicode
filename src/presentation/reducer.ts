import type { ChildSessionLink, TurnSummary } from "./events.ts"
import { type DomainEvent, DURABILITY } from "./events.ts"
import { labelTool } from "./label.ts"
import {
  type ActivityEntry,
  type ApprovalEntry,
  activityKey,
  approvalKey,
  type ConversationEntry,
  conversationKey,
  createInitialState,
  type DiagnosticEntry,
  type FindingEntry,
  MAX_STATE_ENTRIES,
  type PlanEntry,
  type PresentationState,
  type ReasoningEntry,
  type ResultEntry,
  type SystemEntry,
  type ToolStatus,
  type TurnEntry,
  type TurnStatus,
  turnKey,
} from "./model.ts"

export interface ReducerDiagnostics {
  eventsIn: number
  duplicateTerminal: number
  lateEvent: number
  orphanTool: number
  orphanApproval: number
  duplicateTurn: number
  unknownEvent: number
  orphanEvidence: number
}

export function createReducerDiagnostics(): ReducerDiagnostics {
  return {
    eventsIn: 0,
    duplicateTerminal: 0,
    lateEvent: 0,
    orphanTool: 0,
    orphanApproval: 0,
    duplicateTurn: 0,
    unknownEvent: 0,
    orphanEvidence: 0,
  }
}

const TOOL_TERMINAL = new Set<ToolStatus>([
  "completed",
  "failed",
  "denied",
  "cancelled",
  "interrupted",
])
const TURN_TERMINAL = new Set<TurnStatus>(["completed", "failed", "cancelled", "interrupted"])
const MUTATION_TOOLS = new Set([
  "bash",
  "edit",
  "write_file",
  "apply_patch",
  "delete_file",
  "git_commit",
])

function isToolTerminal(status: ToolStatus): boolean {
  return TOOL_TERMINAL.has(status)
}

function isTurnTerminal(status: TurnStatus): boolean {
  return TURN_TERMINAL.has(status)
}

function addOrder(
  state: PresentationState,
  kind: PresentationState["order"][number]["kind"],
  id: string,
  seq: number,
): void {
  if (!state.order.some((o) => o.kind === kind && o.id === id)) state.order.push({ kind, id, seq })
}

function removeOrder(
  state: PresentationState,
  kind: PresentationState["order"][number]["kind"],
  id: string,
): void {
  for (let i = state.order.length - 1; i >= 0; i--) {
    if (state.order[i]!.kind === kind && state.order[i]!.id === id) state.order.splice(i, 1)
  }
}

function ensureTurn(
  state: PresentationState,
  sessionId: string,
  turnId: number,
  seq: number,
  ts: number,
  promptRef?: string,
): TurnEntry {
  const key = turnKey(sessionId, turnId)
  const existing = state.turns.get(key)
  if (existing) {
    if (promptRef && !existing.promptRef) existing.promptRef = promptRef
    return existing
  }
  const entry: TurnEntry = {
    kind: "turn",
    seq,
    turnId,
    sessionId,
    ...(promptRef ? { promptRef } : {}),
    status: "running",
    tsStart: ts,
    evidenceComplete: true,
  }
  state.turns.set(key, entry)
  addOrder(state, "turn", key, seq)
  return entry
}

function approvalMapKey(state: PresentationState, sessionId: string, approvalId: string): string {
  return sessionId === state.sessionId ? approvalId : approvalKey(sessionId, approvalId)
}

function evidenceActivity(
  state: PresentationState,
  event: Extract<
    DomainEvent,
    {
      type:
        | "file.changed"
        | "test.completed"
        | "tool.completed"
        | "tool.failed"
        | "tool.denied"
        | "tool.cancelled"
    }
  > & { parentLink?: ChildSessionLink },
  diag: ReducerDiagnostics,
): ActivityEntry {
  const key = activityKey(event.sessionId, event.toolCallId)
  const existing = state.activities.get(key)
  if (existing) return existing
  if (event.type.startsWith("tool.")) diag.orphanTool++
  diag.orphanEvidence++
  ensureTurn(state, event.sessionId, event.turnId, event.eventSeq, event.ts)
  const entry: ActivityEntry = {
    kind: "tool",
    seq: event.eventSeq,
    turnId: event.turnId,
    stepId: 0,
    toolCallId: event.toolCallId,
    sessionId: event.sessionId,
    identity: { origin: "builtin", name: event.toolCallId, qualified: event.toolCallId },
    ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
    status: "completed",
    tsStart: event.ts,
    tsEnd: event.ts,
    durationMs: 0,
    incomplete: true,
  }
  state.activities.set(key, entry)
  addOrder(state, "tool", key, event.eventSeq)
  return entry
}

export function deriveSupersedes(
  state: PresentationState,
  probe: {
    sessionId: string
    turnId: number
    qualified: string
    target?: string
    startSeq: number
    excludeId?: string
  },
): string | undefined {
  let best: { id: string; endSeq: number } | undefined
  for (const a of state.activities.values()) {
    if (a.sessionId !== probe.sessionId || a.turnId !== probe.turnId) continue
    if (a.toolCallId === probe.excludeId) continue
    if (a.identity.qualified !== probe.qualified) continue
    if ((a.target ?? undefined) !== (probe.target ?? undefined)) continue
    if (a.status !== "failed" && a.status !== "denied") continue
    if (a.endSeq === undefined || a.endSeq >= probe.startSeq) continue
    if (!best || a.endSeq > best.endSeq) best = { id: a.toolCallId, endSeq: a.endSeq }
  }
  return best?.id
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "")
}

export function deriveTurnSummary(
  state: PresentationState,
  sessionId: string,
  turnId: number,
  fallback?: TurnSummary,
): TurnSummary {
  const turn = state.turns.get(turnKey(sessionId, turnId))
  const activities = [...state.activities.values()].filter(
    (a) => a.sessionId === sessionId && a.turnId === turnId,
  )
  let toolsOk = 0
  let toolsFailed = 0
  let toolsDenied = 0
  let toolsCancelled = 0
  let toolsInterrupted = 0
  const paths = new Set<string>()
  let passed = 0
  let failed = 0
  const testSummaries: string[] = []
  let checkpointId: string | undefined
  let evidenceComplete = turn?.evidenceComplete ?? true
  for (const activity of activities) {
    if (activity.status === "completed") toolsOk++
    else if (activity.status === "failed") toolsFailed++
    else if (activity.status === "denied") toolsDenied++
    else if (activity.status === "cancelled") toolsCancelled++
    else if (activity.status === "interrupted") toolsInterrupted++
    const receipt = activity.receipt
    if (!receipt) {
      if (MUTATION_TOOLS.has(activity.identity.qualified)) evidenceComplete = false
      continue
    }
    for (const path of receipt.paths ?? []) paths.add(normalizedPath(path))
    if (receipt.checkpointId) checkpointId = receipt.checkpointId
    if (receipt.test) {
      passed += receipt.test.passed
      failed += receipt.test.failed
      if (receipt.test.summary) testSummaries.push(receipt.test.summary)
    }
  }
  if (turn?.checkpointId) checkpointId = turn.checkpointId
  const durationMs =
    turn?.tsEnd !== undefined ? Math.max(0, turn.tsEnd - turn.tsStart) : (fallback?.durationMs ?? 0)
  return {
    toolsOk,
    toolsFailed,
    toolsDenied,
    toolsCancelled,
    toolsInterrupted,
    filesChanged: paths.size,
    ...(checkpointId ? { checkpointId } : {}),
    ...(testSummaries.length > 0
      ? { testSummary: { passed, failed, summary: testSummaries.join("; ") } }
      : {}),
    evidenceComplete,
    durationMs,
  }
}

export function refreshTurnSummary(
  state: PresentationState,
  sessionId: string,
  turnId: number,
  fallback?: TurnSummary,
): void {
  const turn = state.turns.get(turnKey(sessionId, turnId))
  if (turn) turn.summary = deriveTurnSummary(state, sessionId, turnId, fallback)
}

function forceCloseTurn(
  state: PresentationState,
  sessionId: string,
  turnId: number,
  seq: number,
  tsEnd: number,
): void {
  for (const ap of state.approvals.values()) {
    if (ap.sessionId !== sessionId || ap.turnId !== turnId || ap.state !== "requested") continue
    ap.state = "settled"
    ap.outcome = { decision: "cancelled", by: "system", reason: "parent-ended" }
    ap.seq = seq
  }
  for (const a of state.activities.values()) {
    if (a.sessionId !== sessionId || a.turnId !== turnId || a.status !== "running") continue
    a.status = "cancelled"
    a.endSeq = seq
    a.tsEnd = a.tsEnd ?? tsEnd
    a.durationMs = a.durationMs ?? Math.max(0, a.tsEnd - a.tsStart)
    a.error = undefined
    a.summary = a.summary ?? "cancelled (parent-ended)"
  }
}

function trimState(state: PresentationState): void {
  const trimArray = <T extends { seq: number }>(
    values: T[],
    kind: PresentationState["order"][number]["kind"],
    id: (value: T) => string,
    removable: (value: T) => boolean = () => true,
  ): void => {
    while (values.length > MAX_STATE_ENTRIES) {
      const index = values.findIndex(removable)
      if (index < 0) return
      const [removed] = values.splice(index, 1)
      if (!removed) return
      const key = id(removed)
      state.evicted.push({ kind, id: key, seq: removed.seq, reason: "bounded" })
      removeOrder(state, kind, key)
    }
  }
  trimArray(state.conversation, "message", (v) => v.id)
  trimArray(state.reasoning, "reasoning", (v) => v.id)
  trimArray(state.system, "system", (v) => v.id)
  trimArray(state.diagnostics, "diagnostic", (v) => v.id)
  const trimMap = <T extends { seq: number }>(
    values: Map<string, T>,
    kind: PresentationState["order"][number]["kind"],
    removable: (value: T) => boolean,
  ): void => {
    while (values.size > MAX_STATE_ENTRIES) {
      const entry = [...values.entries()].find(([, value]) => removable(value))
      if (!entry) return
      values.delete(entry[0])
      state.evicted.push({ kind, id: entry[0], seq: entry[1].seq, reason: "bounded" })
      removeOrder(state, kind, entry[0])
    }
  }
  trimMap(state.turns, "turn", (v) => isTurnTerminal(v.status))
  trimMap(state.activities, "tool", (v) => isToolTerminal(v.status))
  trimMap(state.approvals, "approval", (v) => v.state === "settled")
  trimMap(state.plans, "plan", () => true)
  trimMap(state.findings, "finding", () => true)
  trimMap(state.results, "result", () => true)
  if (state.evicted.length > MAX_STATE_ENTRIES)
    state.evicted.splice(0, state.evicted.length - MAX_STATE_ENTRIES)
  if (state.order.length > MAX_STATE_ENTRIES * 2)
    state.order.splice(0, state.order.length - MAX_STATE_ENTRIES * 2)
}

export function reduce(
  state: PresentationState,
  event: DomainEvent,
  diag: ReducerDiagnostics = createReducerDiagnostics(),
): PresentationState {
  diag.eventsIn++
  const seq = event.eventSeq
  if (DURABILITY[event.type]?.durable && seq > state.seq) state.seq = seq

  try {
    switch (event.type) {
      case "user.message": {
        ensureTurn(state, event.sessionId, event.turnId, seq, event.ts, event.promptRef)
        const id = conversationKey(event.sessionId, event.turnId, "user")
        const entry: ConversationEntry = {
          kind: "message",
          id,
          seq,
          sessionId: event.sessionId,
          turnId: event.turnId,
          role: "user",
          text: event.text,
          truncated: false,
          promptRef: event.promptRef,
        }
        const index = state.conversation.findIndex((m) => m.id === id)
        if (index >= 0) state.conversation[index] = entry
        else {
          state.conversation.push(entry)
          addOrder(state, "message", id, seq)
        }
        return state
      }
      case "turn.started":
        ensureTurn(state, event.sessionId, event.turnId, seq, event.ts, event.promptRef)
        return state
      case "tool.started": {
        ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
        const key = activityKey(event.sessionId, event.toolCallId)
        const existing = state.activities.get(key)
        if (existing) {
          if (isToolTerminal(existing.status)) diag.duplicateTerminal++
          else diag.lateEvent++
          return state
        }
        const target = event.argsSummary.target
        const entry: ActivityEntry = {
          kind: "tool",
          seq,
          turnId: event.turnId,
          stepId: event.stepId,
          toolCallId: event.toolCallId,
          sessionId: event.sessionId,
          ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
          identity: event.identity,
          ...(target ? { target } : {}),
          status: "running",
          tsStart: event.ts,
          summary: labelTool(event.identity, event.argsSummary).summary,
        }
        const supersedes = deriveSupersedes(state, {
          sessionId: event.sessionId,
          turnId: event.turnId,
          qualified: event.identity.qualified,
          target,
          startSeq: seq,
          excludeId: event.toolCallId,
        })
        if (supersedes) entry.supersedes = supersedes
        state.activities.set(key, entry)
        addOrder(state, "tool", key, seq)
        return state
      }
      case "tool.progress": {
        const a = state.activities.get(activityKey(event.sessionId, event.toolCallId))
        if (!a) {
          diag.orphanTool++
          return state
        }
        if (isToolTerminal(a.status)) diag.lateEvent++
        else a.progress = event.message
        return state
      }
      case "tool.completed":
      case "tool.failed":
      case "tool.denied":
      case "tool.cancelled": {
        const a = evidenceActivity(state, event, diag)
        if (isToolTerminal(a.status)) {
          diag.duplicateTerminal++
          return state
        }
        a.endSeq = seq
        a.tsEnd = event.ts
        if (event.type === "tool.completed") {
          a.status = "completed"
          a.durationMs = event.durationMs
          a.summary = event.summary
          a.expandRef = { ...event.expandRef }
          if (event.receipt)
            a.receipt = { ...event.receipt, sessionId: event.sessionId, turnId: event.turnId }
        } else if (event.type === "tool.failed") {
          a.status = "failed"
          a.durationMs = event.durationMs
          a.error = {
            cause: event.cause,
            message: event.message,
            ...(event.hint ? { hint: event.hint } : {}),
          }
          a.expandRef = { ...event.expandRef }
        } else if (event.type === "tool.denied") {
          a.status = "denied"
          a.denyReason = event.reason
          a.summary = a.summary ?? `denied: ${event.reason}`
        } else {
          a.status = "cancelled"
          a.summary = a.summary ?? `cancelled (${event.reason})`
        }
        refreshTurnSummary(state, event.sessionId, event.turnId)
        return state
      }
      case "approval.requested": {
        const key = approvalMapKey(state, event.sessionId, event.approvalId)
        const existing = state.approvals.get(key)
        if (existing) {
          if (existing.state === "settled") diag.duplicateTerminal++
          else diag.lateEvent++
          return state
        }
        ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
        const entry: ApprovalEntry = {
          kind: "approval",
          seq,
          turnId: event.turnId,
          sessionId: event.sessionId,
          approvalId: event.approvalId,
          toolCallId: event.toolCallId ?? "",
          identity: event.identity,
          state: "requested",
        }
        state.approvals.set(key, entry)
        addOrder(state, "approval", key, seq)
        if (event.toolCallId) {
          const activity = state.activities.get(activityKey(event.sessionId, event.toolCallId))
          if (activity && !activity.approvalId) activity.approvalId = event.approvalId
        }
        return state
      }
      case "approval.settled": {
        const key = approvalMapKey(state, event.sessionId, event.approvalId)
        let approval = state.approvals.get(key)
        if (!approval) {
          diag.orphanApproval++
          approval = {
            kind: "approval",
            seq,
            turnId: event.turnId,
            sessionId: event.sessionId,
            approvalId: event.approvalId,
            toolCallId: event.toolCallId ?? "",
            identity: { origin: "builtin", name: event.approvalId, qualified: event.approvalId },
            state: "settled",
            outcome: event.outcome,
          }
          state.approvals.set(key, approval)
          addOrder(state, "approval", key, seq)
          return state
        }
        if (approval.state === "settled") {
          diag.duplicateTerminal++
          return state
        }
        approval.state = "settled"
        approval.outcome = event.outcome
        approval.seq = seq
        return state
      }
      case "file.changed": {
        const activity = evidenceActivity(state, event, diag)
        const previous = activity.receipt
        const paths = [...new Set(event.paths.map(normalizedPath))].sort()
        if (
          previous &&
          previous.journalSeq === event.journalSeq &&
          JSON.stringify(previous.paths ?? []) === JSON.stringify(paths)
        )
          return state
        activity.receipt = {
          toolCallId: event.toolCallId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          ...(event.journalSeq !== undefined ? { journalSeq: event.journalSeq } : {}),
          ...(event.checkpointId !== undefined ? { checkpointId: event.checkpointId } : {}),
          paths,
          ...(previous?.stats ? { stats: { ...previous.stats } } : {}),
          ...(previous?.test ? { test: { ...previous.test } } : {}),
          ...(previous?.cmd ? { cmd: { ...previous.cmd } } : {}),
        }
        const turn = ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
        if (event.checkpointId) turn.checkpointId = event.checkpointId
        refreshTurnSummary(state, event.sessionId, event.turnId)
        return state
      }
      case "test.completed": {
        const activity = evidenceActivity(state, event, diag)
        const receipt = activity.receipt ?? {
          toolCallId: event.toolCallId,
          sessionId: event.sessionId,
          turnId: event.turnId,
        }
        receipt.test = { passed: event.passed, failed: event.failed, summary: event.summary }
        activity.receipt = receipt
        ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
        refreshTurnSummary(state, event.sessionId, event.turnId)
        return state
      }
      case "model.completed": {
        ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
        const id = conversationKey(event.sessionId, event.turnId, "assistant")
        const entry: ConversationEntry = {
          kind: "message",
          id,
          seq,
          sessionId: event.sessionId,
          turnId: event.turnId,
          role: "assistant",
          text: event.text,
          truncated: event.truncated,
          ...(event.expandRef ? { expandRef: { ...event.expandRef } } : {}),
        }
        const index = state.conversation.findIndex((m) => m.id === id)
        if (index >= 0) state.conversation[index] = entry
        else {
          state.conversation.push(entry)
          addOrder(state, "message", id, seq)
        }
        const resultId = `${event.sessionId}:${event.turnId}:result`
        const result: ResultEntry = {
          kind: "result",
          resultId,
          seq,
          sessionId: event.sessionId,
          turnId: event.turnId,
          status: "completed",
          summary: event.text,
          ...(event.expandRef ? { expandRef: { ...event.expandRef } } : {}),
        }
        state.results.set(resultId, result)
        addOrder(state, "result", resultId, seq)
        return state
      }
      case "reasoning.completed": {
        ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
        const id = `${event.sessionId}:${event.turnId}:reasoning:${seq}`
        const entry: ReasoningEntry = {
          kind: "reasoning",
          id,
          seq,
          sessionId: event.sessionId,
          turnId: event.turnId,
          truncated: event.truncated,
          expandRef: { ...event.expandRef, kind: "reasoning" },
        }
        const index = state.reasoning.findIndex((r) => r.id === id)
        if (index >= 0) state.reasoning[index] = entry
        else {
          state.reasoning.push(entry)
          addOrder(state, "reasoning", id, seq)
        }
        return state
      }
      case "context.compacted": {
        ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
        const id = `${event.sessionId}:${event.turnId}:system:${seq}`
        const entry: SystemEntry = {
          kind: "system",
          id,
          seq,
          sessionId: event.sessionId,
          turnId: event.turnId,
          systemKind: "context_compacted",
          text: event.reason,
          reason: event.reason,
          severity: "info",
        }
        state.system.push(entry)
        addOrder(state, "system", id, seq)
        return state
      }
      case "plan.updated": {
        ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
        const entry: PlanEntry = {
          kind: "plan",
          planId: event.planId,
          seq,
          sessionId: event.sessionId,
          turnId: event.turnId,
          status: event.status,
          steps: event.steps.map((step) => ({ ...step })),
          ...(event.expandRef ? { expandRef: { ...event.expandRef } } : {}),
        }
        state.plans.set(event.planId, entry)
        addOrder(state, "plan", event.planId, seq)
        return state
      }
      case "finding.detected": {
        ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
        const entry: FindingEntry = {
          kind: "finding",
          findingId: event.findingId,
          seq,
          sessionId: event.sessionId,
          turnId: event.turnId,
          category: event.category,
          severity: event.severity,
          summary: event.summary,
          evidence: [...(event.evidence ?? [])],
        }
        state.findings.set(event.findingId, entry)
        addOrder(state, "finding", event.findingId, seq)
        return state
      }
      case "result.produced": {
        ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
        const entry: ResultEntry = {
          kind: "result",
          resultId: event.resultId,
          seq,
          sessionId: event.sessionId,
          turnId: event.turnId,
          status: event.status,
          summary: event.summary,
          ...(event.action ? { action: event.action } : {}),
          ...(event.expandRef ? { expandRef: { ...event.expandRef } } : {}),
        }
        state.results.set(event.resultId, entry)
        addOrder(state, "result", event.resultId, seq)
        return state
      }
      case "diagnostic.raised": {
        ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
        const id = `${event.sessionId}:${event.turnId}:diagnostic:${seq}`
        const entry: DiagnosticEntry = {
          kind: "diagnostic",
          id,
          seq,
          sessionId: event.sessionId,
          turnId: event.turnId,
          category: event.category,
          severity: event.severity,
          message: event.message,
          ...(event.cause ? { cause: event.cause } : {}),
          ...(event.action ? { action: event.action } : {}),
        }
        state.diagnostics.push(entry)
        addOrder(state, "diagnostic", id, seq)
        return state
      }
      case "checkpoint.created": {
        const turn = ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
        turn.checkpointId = event.checkpointId
        const id = `${event.sessionId}:${event.turnId}:checkpoint:${seq}`
        const entry: SystemEntry = {
          kind: "system",
          id,
          seq,
          sessionId: event.sessionId,
          turnId: event.turnId,
          systemKind: "checkpoint",
          text: event.checkpointId,
          reason: event.paths?.join(", "),
          severity: "info",
        }
        state.system.push(entry)
        addOrder(state, "system", id, seq)
        refreshTurnSummary(state, event.sessionId, event.turnId)
        return state
      }
      case "turn.completed":
      case "turn.failed":
      case "turn.cancelled": {
        const turn = ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
        if (isTurnTerminal(turn.status)) {
          diag.duplicateTurn++
          return state
        }
        turn.tsEnd = event.ts
        if (event.type === "turn.completed") turn.status = "completed"
        else if (event.type === "turn.failed") {
          turn.status = "failed"
          turn.error = event.error.message
        } else {
          turn.status = "cancelled"
          turn.error = event.reason
        }
        forceCloseTurn(state, event.sessionId, event.turnId, seq, event.ts)
        refreshTurnSummary(
          state,
          event.sessionId,
          event.turnId,
          event.type === "turn.completed" ? event.summary : undefined,
        )
        return state
      }
      case "model.delta":
      case "reasoning.delta":
        return state
      default: {
        diag.unknownEvent++
        return state
      }
    }
  } finally {
    trimState(state)
  }
}

export function rebuildFromDurable(
  durable: readonly DomainEvent[],
  diag: ReducerDiagnostics = createReducerDiagnostics(),
  fallbackSessionId = "",
): { state: PresentationState; sessionId: string } {
  const ordered = durable
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => DURABILITY[event.type]?.durable)
    .sort(
      (a, b) => a.event.eventSeq - b.event.eventSeq || a.event.ts - b.event.ts || a.index - b.index,
    )
  const first = ordered[0]?.event
  const sessionId = first?.sessionId ?? fallbackSessionId
  const state = createInitialState(sessionId)
  for (const { event } of ordered) reduce(state, event, diag)
  const lastTs = ordered.reduce((max, { event }) => Math.max(max, event.ts), 0)
  const endSeq = state.seq + 1
  for (const activity of state.activities.values()) {
    if (activity.status !== "running") continue
    activity.status = "interrupted"
    activity.endSeq = endSeq
    activity.tsEnd = lastTs || activity.tsStart
    activity.durationMs = Math.max(0, activity.tsEnd - activity.tsStart)
    activity.summary = activity.summary ?? "interrupted — verify before retry"
  }
  for (const approval of state.approvals.values()) {
    if (approval.state !== "requested") continue
    approval.state = "settled"
    approval.outcome = { decision: "cancelled", by: "system", reason: "parent-ended" }
    approval.seq = endSeq
  }
  for (const turn of state.turns.values()) {
    if (turn.status !== "running") continue
    turn.status = "interrupted"
    turn.tsEnd = lastTs || turn.tsStart
    turn.error = turn.error ?? "process ended before turn settle"
  }
  for (const turn of state.turns.values()) refreshTurnSummary(state, turn.sessionId, turn.turnId)
  return { state, sessionId }
}

export { cloneState, createInitialState } from "./model.ts"
export type {
  ActivityEntry,
  ApprovalEntry,
  DiagnosticEntry,
  FindingEntry,
  PlanEntry,
  PresentationState,
  ReasoningEntry,
  ResultEntry,
  SystemEntry,
  TurnEntry,
}
