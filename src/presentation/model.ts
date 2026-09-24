// Bentuk state presentasi V2.1 (§14 plan) — murni tipe + konstruktor.
//
// Kenapa terpisah dari reducer: proyeksi dan cli boleh mengimpor tipe tanpa
// menarik logika reduce; coverage floor reducer diuji terpisah. Tanpa IO/
// clock/env — jam hanya di adapter (tepi).

import type {
  ApprovalOutcome,
  ContentRef,
  DenyReason,
  FailCause,
  Receipt,
  ToolIdentity,
  TurnSummary,
} from "./events.ts"

/** Status final tool — `running` hanya live; `interrupted` disimpulkan saat rebuild. */
export type ToolStatus = "running" | "completed" | "failed" | "denied" | "cancelled" | "interrupted"

/** Status final turn — `interrupted` = proses mati tanpa turn-settle durable. */
export type TurnStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted"

export interface ActivityEntry {
  kind: "tool"
  seq: number
  turnId: number
  stepId: number
  toolCallId: string
  sessionId: string
  parentToolCallId?: string
  identity: ToolIdentity
  target?: string
  status: ToolStatus
  tsStart: number
  tsEnd?: number
  durationMs?: number
  /** eventSeq terminal — dasar aturan supersedes (old terminal < new started). */
  endSeq?: number
  progress?: string
  summary?: string
  denyReason?: DenyReason
  error?: { cause: FailCause; message: string; hint?: string }
  supersedes?: string
  approvalId?: string
  expandRef?: ContentRef
  receipt?: Receipt
  /** Terminal tanpa tool.started (race/crash) — observability, jangan throw. */
  incomplete?: boolean
}

export interface TurnEntry {
  kind: "turn"
  seq: number
  turnId: number
  sessionId: string
  status: TurnStatus
  tsStart: number
  tsEnd?: number
  summary?: TurnSummary
  error?: string
}

export interface ApprovalEntry {
  kind: "approval"
  seq: number
  turnId: number
  approvalId: string
  toolCallId: string
  identity: ToolIdentity
  state: "requested" | "settled"
  outcome?: ApprovalOutcome
}

export interface ConversationEntry {
  kind: "message"
  seq: number
  turnId: number
  role: "user" | "assistant"
  text: string
  truncated: boolean
  expandRef?: ContentRef
}

export interface ReasoningEntry {
  kind: "reasoning"
  seq: number
  turnId: number
  truncated: boolean
  expandRef: ContentRef
}

export interface SystemEntry {
  kind: "system"
  seq: number
  turnId: number
  text: string
}

export type PresentationEntry =
  | ActivityEntry
  | TurnEntry
  | ApprovalEntry
  | ConversationEntry
  | ReasoningEntry
  | SystemEntry

/** Penunjuk urutan tampil — resolve ke entry via Map/array pemilik. */
export interface EntryRef {
  kind: PresentationEntry["kind"]
  /** toolCallId | approvalId | `${sessionId}:${turnId}` | `${kind}:${seq}` */
  id: string
  seq: number
}

/**
 * Core state presentasi — kecil, replayable; konten besar hanya via ContentRef
 * (ContentStore sibling Fase 4, bukan nested di sini).
 */
export interface PresentationState {
  sessionId: string
  /** eventSeq terakhir yang diterapkan — basis replay/determinisme. */
  seq: number
  /** key = `${sessionId}:${turnId}` (anak numbering sendiri). */
  turns: Map<string, TurnEntry>
  /** key = `${sessionId}:${toolCallId}`. */
  activities: Map<string, ActivityEntry>
  approvals: Map<string, ApprovalEntry>
  conversation: ConversationEntry[]
  order: EntryRef[]
}

export function turnKey(sessionId: string, turnId: number): string {
  return `${sessionId}:${turnId}`
}

export function activityKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`
}

export function createInitialState(sessionId: string): PresentationState {
  return {
    sessionId,
    seq: 0,
    turns: new Map(),
    activities: new Map(),
    approvals: new Map(),
    conversation: [],
    order: [],
  }
}

/** Snapshot deep-equal-friendly (test determinisme/replay; bukan jalur panas). */
export function cloneState(s: PresentationState): PresentationState {
  return {
    sessionId: s.sessionId,
    seq: s.seq,
    turns: new Map([...s.turns].map(([k, v]) => [k, { ...v }])),
    activities: new Map(
      [...s.activities].map(([k, v]) => [
        k,
        {
          ...v,
          error: v.error ? { ...v.error } : undefined,
          receipt: v.receipt ? { ...v.receipt } : undefined,
        },
      ]),
    ),
    approvals: new Map([...s.approvals].map(([k, v]) => [k, { ...v }])),
    conversation: s.conversation.map((m) => ({ ...m })),
    order: s.order.map((o) => ({ ...o })),
  }
}
