// Reducer presentasi murni (§15 plan) — satu-satunya penulis PresentationState.
//
// DILANGGAN: jam acak / berkas / jaringan / env / terminal. Semua waktu
// tiba sebagai data event (ts, durationMs) dari adapter. Counter diagnostik
// di LUAR state semantik (objek terpisah) — §30.
//
// Semantik kunci:
// · first-terminal-wins — terminal kedua toolCallId sama diabaikan + counter
// · force-close I-A08 — turn settle → approval terbuka → cancelled(parent-ended)
// · deriveSupersedes — retry-link deterministik dari eventSeq (§10)
// · rebuildFromDurable — crash/restart: open → interrupted, approval → force-close

import { type DomainEvent, DURABILITY } from "./events.ts"
import { labelTool, targetOf } from "./label.ts"
import {
  type ActivityEntry,
  type ApprovalEntry,
  activityKey,
  type PresentationState,
  type ToolStatus,
  type TurnEntry,
  type TurnStatus,
  turnKey,
} from "./model.ts"

export interface ReducerDiagnostics {
  eventsIn: number
  /** Terminal kedua untuk id sama (first-terminal-wins). */
  duplicateTerminal: number
  /** Event setelah entry terminal (progress/late settle). */
  lateEvent: number
  /** Terminal/progress tanpa started. */
  orphanTool: number
  /** Settle tanpa requested. */
  orphanApproval: number
  /** Turn settle ganda. */
  duplicateTurn: number
}

export function createReducerDiagnostics(): ReducerDiagnostics {
  return {
    eventsIn: 0,
    duplicateTerminal: 0,
    lateEvent: 0,
    orphanTool: 0,
    orphanApproval: 0,
    duplicateTurn: 0,
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

function isToolTerminal(status: ToolStatus): boolean {
  return TOOL_TERMINAL.has(status)
}

function isTurnTerminal(status: TurnStatus): boolean {
  return TURN_TERMINAL.has(status)
}

function ensureTurn(
  state: PresentationState,
  sessionId: string,
  turnId: number,
  seq: number,
  ts: number,
): TurnEntry {
  const tKey = turnKey(sessionId, turnId)
  const existing = state.turns.get(tKey)
  if (existing) return existing
  const entry: TurnEntry = {
    kind: "turn",
    seq,
    turnId,
    sessionId,
    status: "running",
    tsStart: ts,
  }
  state.turns.set(tKey, entry)
  if (!state.order.some((o) => o.kind === "turn" && o.id === tKey)) {
    state.order.push({ kind: "turn", id: tKey, seq })
  }
  return entry
}

/**
 * Predikat retry (§10): same turn + same qualified+target + old ∈ {failed,denied}
 * + old.endSeq < new.startSeq. Paralel tumpang-tindih TIDAK ditautkan.
 * Pilih kandidat terminal-seq terbesar bila >1.
 */
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
    if (a.sessionId !== probe.sessionId) continue
    if (a.turnId !== probe.turnId) continue
    if (a.toolCallId === probe.excludeId) continue
    if (a.identity.qualified !== probe.qualified) continue
    if ((a.target ?? undefined) !== (probe.target ?? undefined)) continue
    if (a.status !== "failed" && a.status !== "denied") continue
    if (a.endSeq === undefined || a.endSeq >= probe.startSeq) continue
    if (!best || a.endSeq > best.endSeq) best = { id: a.toolCallId, endSeq: a.endSeq }
  }
  return best?.id
}

function forceCloseTurn(
  state: PresentationState,
  sessionId: string,
  turnId: number,
  seq: number,
): void {
  // I-A08: approval terbuka turn ini → settled{cancelled(parent-ended)}.
  for (const ap of state.approvals.values()) {
    if (ap.turnId !== turnId || ap.state !== "requested") continue
    // approvalId milik turn; cocokkan sessionId via tool bila ada — turnId
    // cukup karena approvalId unik per sesi runtime.
    ap.state = "settled"
    ap.outcome = { decision: "cancelled", by: "system", reason: "parent-ended" }
    ap.seq = seq
  }
  // Running tools turn itu → cancelled(parent-ended) — bukan failed (kegagalan
  // milik turn, bukan tiap tool). interrupted TIDAK di sini (itu rebuild).
  for (const a of state.activities.values()) {
    if (a.sessionId !== sessionId || a.turnId !== turnId) continue
    if (a.status !== "running") continue
    a.status = "cancelled"
    a.endSeq = seq
    a.tsEnd = a.tsEnd ?? seq
    a.error = undefined
    a.summary = a.summary ?? "cancelled (parent-ended)"
  }
}

/**
 * Terapkan SATU event. Mutable-ke-dalam (state milik caller) — deterministik
 * selama eventSeq urut; tanpa side-effect selain mutasi state + diag.
 */
export function reduce(
  state: PresentationState,
  event: DomainEvent,
  diag: ReducerDiagnostics = createReducerDiagnostics(),
): PresentationState {
  diag.eventsIn++
  const seq = event.eventSeq
  // Live-only (delta/progress) TIDAK menggeser state.seq — replay durable
  // harus menghasilkan seq identik (progress memang tak pernah direkam).
  if (DURABILITY[event.type]?.durable && seq > state.seq) state.seq = seq

  switch (event.type) {
    case "turn.started": {
      ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
      return state
    }
    case "tool.started": {
      ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
      const key = activityKey(event.sessionId, event.toolCallId)
      const existing = state.activities.get(key)
      if (existing) {
        if (isToolTerminal(existing.status)) diag.duplicateTerminal++
        else diag.lateEvent++
        return state
      }
      const target = event.argsSummary.target ?? targetOf(undefined)
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
      const sup = deriveSupersedes(state, {
        sessionId: event.sessionId,
        turnId: event.turnId,
        qualified: event.identity.qualified,
        target,
        startSeq: seq,
        excludeId: event.toolCallId,
      })
      if (sup) entry.supersedes = sup
      state.activities.set(key, entry)
      state.order.push({ kind: "tool", id: event.toolCallId, seq })
      return state
    }
    case "tool.progress": {
      const key = activityKey(event.sessionId, event.toolCallId)
      const a = state.activities.get(key)
      if (!a) {
        diag.orphanTool++
        return state
      }
      if (isToolTerminal(a.status)) {
        diag.lateEvent++
        return state
      }
      a.progress = event.message
      return state
    }
    case "tool.completed":
    case "tool.failed":
    case "tool.denied":
    case "tool.cancelled": {
      const key = activityKey(event.sessionId, event.toolCallId)
      let a = state.activities.get(key)
      if (!a) {
        // Terminal tanpa started (forward race / crash-rebuild) — entry minimal.
        diag.orphanTool++
        ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
        a = {
          kind: "tool",
          seq,
          turnId: event.turnId,
          stepId: 0,
          toolCallId: event.toolCallId,
          sessionId: event.sessionId,
          identity: { origin: "builtin", name: event.toolCallId, qualified: event.toolCallId },
          status: "running",
          tsStart: event.ts,
          incomplete: true,
          parentToolCallId: event.parentLink?.parentToolCallId,
        }
        state.activities.set(key, a)
        state.order.push({ kind: "tool", id: event.toolCallId, seq })
      }
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
        a.expandRef = event.expandRef
        if (event.receipt) a.receipt = event.receipt
      } else if (event.type === "tool.failed") {
        a.status = "failed"
        a.durationMs = event.durationMs
        a.error = {
          cause: event.cause,
          message: event.message,
          ...(event.hint ? { hint: event.hint } : {}),
        }
        a.expandRef = event.expandRef
      } else if (event.type === "tool.denied") {
        a.status = "denied"
        a.denyReason = event.reason
        a.summary = a.summary ?? `denied: ${event.reason}`
      } else {
        a.status = "cancelled"
        a.summary = a.summary ?? `cancelled (${event.reason})`
      }
      return state
    }
    case "approval.requested": {
      const existing = state.approvals.get(event.approvalId)
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
        approvalId: event.approvalId,
        toolCallId: event.toolCallId ?? "",
        identity: event.identity,
        state: "requested",
      }
      state.approvals.set(event.approvalId, entry)
      state.order.push({ kind: "approval", id: event.approvalId, seq })
      if (event.toolCallId) {
        const a = state.activities.get(activityKey(event.sessionId, event.toolCallId))
        if (a && !a.approvalId) a.approvalId = event.approvalId
      }
      return state
    }
    case "approval.settled": {
      let ap = state.approvals.get(event.approvalId)
      if (!ap) {
        diag.orphanApproval++
        ap = {
          kind: "approval",
          seq,
          turnId: event.turnId,
          approvalId: event.approvalId,
          toolCallId: event.toolCallId ?? "",
          identity: { origin: "builtin", name: event.approvalId, qualified: event.approvalId },
          state: "settled",
          outcome: event.outcome,
        }
        state.approvals.set(event.approvalId, ap)
        state.order.push({ kind: "approval", id: event.approvalId, seq })
        return state
      }
      if (ap.state === "settled") {
        diag.duplicateTerminal++
        return state
      }
      ap.state = "settled"
      ap.outcome = event.outcome
      ap.seq = seq
      return state
    }
    case "file.changed": {
      const a = state.activities.get(activityKey(event.sessionId, event.toolCallId))
      if (!a) {
        diag.orphanTool++
        return state
      }
      const prev = a.receipt
      // dedup: paths sama + journalSeq sama = idempoten
      if (
        prev &&
        prev.journalSeq === event.journalSeq &&
        JSON.stringify(prev.paths ?? []) === JSON.stringify(event.paths)
      ) {
        return state
      }
      a.receipt = {
        toolCallId: event.toolCallId,
        ...(event.journalSeq !== undefined ? { journalSeq: event.journalSeq } : {}),
        ...(event.checkpointId !== undefined ? { checkpointId: event.checkpointId } : {}),
        paths: event.paths,
        ...(prev?.stats ? { stats: prev.stats } : {}),
        ...(prev?.test ? { test: prev.test } : {}),
        ...(prev?.cmd ? { cmd: prev.cmd } : {}),
      }
      return state
    }
    case "test.completed": {
      const a = state.activities.get(activityKey(event.sessionId, event.toolCallId))
      if (!a) {
        diag.orphanTool++
        return state
      }
      const receipt = a.receipt ?? { toolCallId: event.toolCallId }
      receipt.test = { passed: event.passed, failed: event.failed, summary: event.summary }
      a.receipt = receipt
      return state
    }
    case "model.completed": {
      ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
      // last-wins per (turnId, role=assistant) bila replay kirim ulang
      const idx = state.conversation.findIndex(
        (m) => m.turnId === event.turnId && m.role === "assistant",
      )
      const entry = {
        kind: "message" as const,
        seq,
        turnId: event.turnId,
        role: "assistant" as const,
        text: event.text,
        truncated: event.truncated,
        ...(event.expandRef ? { expandRef: event.expandRef } : {}),
      }
      if (idx >= 0) state.conversation[idx] = entry
      else {
        state.conversation.push(entry)
        state.order.push({ kind: "message", id: `msg:${seq}`, seq })
      }
      return state
    }
    case "reasoning.completed": {
      ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
      state.order.push({ kind: "reasoning", id: `rsn:${seq}`, seq })
      return state
    }
    case "context.compacted": {
      ensureTurn(state, event.sessionId, event.turnId, seq, event.ts)
      state.order.push({ kind: "system", id: `sys:${seq}`, seq })
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
      if (event.type === "turn.completed") {
        turn.status = "completed"
        turn.summary = event.summary
      } else if (event.type === "turn.failed") {
        turn.status = "failed"
        turn.error = event.error.message
      } else {
        turn.status = "cancelled"
        turn.error = event.reason
      }
      forceCloseTurn(state, event.sessionId, event.turnId, seq)
      return state
    }
    case "model.delta":
    case "reasoning.delta":
      // live-only — reducer tidak menyimpan stream (§17).
      return state
    default: {
      // Event tak dikenal (evolusi kontrak) — jangan throw; abaikan.
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

/**
 * Rekonstruksi dari event durable (§12): terapkan DURABILITY.durable saja,
 * lalu tutup yang terbuka — activities → interrupted, approvals → force-close,
 * turn tanpa settle → interrupted.
 */
export function rebuildFromDurable(
  durable: readonly DomainEvent[],
  diag: ReducerDiagnostics = createReducerDiagnostics(),
): { state: PresentationState; sessionId: string } {
  const first = durable.find((e) => DURABILITY[e.type]?.durable)
  const sessionId = first?.sessionId ?? ""
  const state: PresentationState = {
    sessionId,
    seq: 0,
    turns: new Map(),
    activities: new Map(),
    approvals: new Map(),
    conversation: [],
    order: [],
  }
  for (const e of durable) {
    if (!DURABILITY[e.type]?.durable) continue
    reduce(state, e, diag)
  }
  // Sesi berakhir tanpa terminal → interrupted (satu-satunya status disimpulkan).
  const endSeq = state.seq + 1
  for (const a of state.activities.values()) {
    if (a.status === "running") {
      a.status = "interrupted"
      a.endSeq = endSeq
      a.summary = a.summary ?? "interrupted — verify before retry"
    }
  }
  for (const ap of state.approvals.values()) {
    if (ap.state === "requested") {
      ap.state = "settled"
      ap.outcome = { decision: "cancelled", by: "system", reason: "parent-ended" }
      ap.seq = endSeq
    }
  }
  for (const t of state.turns.values()) {
    if (t.status === "running") {
      t.status = "interrupted"
      t.error = t.error ?? "process ended before turn settle"
    }
  }
  return { state, sessionId }
}

export type { ActivityEntry, ApprovalEntry, PresentationState, TurnEntry } from "./model.ts"
export { cloneState, createInitialState } from "./model.ts"
