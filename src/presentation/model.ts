import type {
  ApprovalOutcome,
  ContentRef,
  DenyReason,
  FailCause,
  PlanStep,
  Receipt,
  SemanticSeverity,
  ToolIdentity,
  TurnSummary,
} from "./events.ts"

export type ToolStatus = "running" | "completed" | "failed" | "denied" | "cancelled" | "interrupted"
export type TurnStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted"
export type PlanStatus = "open" | "completed" | "cancelled"
export type ResultStatus = "completed" | "failed" | "cancelled"
export type SystemKind = "context_compacted" | "recovery" | "checkpoint" | "notice"
export const MAX_STATE_ENTRIES = 4096

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
  endSeq?: number
  progress?: string
  summary?: string
  denyReason?: DenyReason
  error?: { cause: FailCause; message: string; hint?: string }
  supersedes?: string
  approvalId?: string
  expandRef?: ContentRef
  receipt?: Receipt
  incomplete?: boolean
}

export interface TurnEntry {
  kind: "turn"
  seq: number
  turnId: number
  sessionId: string
  promptRef?: string
  status: TurnStatus
  tsStart: number
  tsEnd?: number
  summary?: TurnSummary
  error?: string
  checkpointId?: string
  evidenceComplete?: boolean
}

export interface ApprovalEntry {
  kind: "approval"
  seq: number
  turnId: number
  sessionId: string
  approvalId: string
  toolCallId: string
  identity: ToolIdentity
  state: "requested" | "settled"
  outcome?: ApprovalOutcome
}

export interface ConversationEntry {
  kind: "message"
  id: string
  seq: number
  sessionId: string
  turnId: number
  role: "user" | "assistant"
  text: string
  truncated: boolean
  promptRef?: string
  sourceRef?: string
  expandRef?: ContentRef
}

export interface ReasoningEntry {
  kind: "reasoning"
  id: string
  seq: number
  sessionId: string
  turnId: number
  truncated: boolean
  expandRef: ContentRef
}

export interface SystemEntry {
  kind: "system"
  id: string
  seq: number
  sessionId: string
  turnId: number
  systemKind: SystemKind
  text: string
  reason?: string
  severity: SemanticSeverity
}

export interface PlanEntry {
  kind: "plan"
  planId: string
  seq: number
  sessionId: string
  turnId: number
  status: PlanStatus
  steps: PlanStep[]
  expandRef?: ContentRef
}

export interface FindingEntry {
  kind: "finding"
  findingId: string
  seq: number
  sessionId: string
  turnId: number
  category: string
  severity: SemanticSeverity
  summary: string
  evidence: string[]
}

export interface ResultEntry {
  kind: "result"
  resultId: string
  seq: number
  sessionId: string
  turnId: number
  status: ResultStatus
  summary: string
  action?: string
  expandRef?: ContentRef
  receipt?: Receipt
}

export interface DiagnosticEntry {
  kind: "diagnostic"
  id: string
  seq: number
  sessionId: string
  turnId: number
  category: string
  severity: SemanticSeverity
  message: string
  cause?: string
  action?: string
}

export type PresentationEntry =
  | ActivityEntry
  | TurnEntry
  | ApprovalEntry
  | ConversationEntry
  | ReasoningEntry
  | SystemEntry
  | PlanEntry
  | FindingEntry
  | ResultEntry
  | DiagnosticEntry

export type PresentationEntryKind = PresentationEntry["kind"]

export interface EntryRef {
  kind: PresentationEntryKind
  id: string
  seq: number
}

export interface EvictionMarker {
  kind: PresentationEntryKind
  id: string
  seq: number
  reason: "bounded"
}

export interface PresentationState {
  sessionId: string
  seq: number
  turns: Map<string, TurnEntry>
  activities: Map<string, ActivityEntry>
  approvals: Map<string, ApprovalEntry>
  conversation: ConversationEntry[]
  reasoning: ReasoningEntry[]
  system: SystemEntry[]
  plans: Map<string, PlanEntry>
  findings: Map<string, FindingEntry>
  results: Map<string, ResultEntry>
  diagnostics: DiagnosticEntry[]
  order: EntryRef[]
  evicted: EvictionMarker[]
}

export function turnKey(sessionId: string, turnId: number): string {
  return `${sessionId}:${turnId}`
}

export function activityKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`
}

export function approvalKey(sessionId: string, approvalId: string): string {
  return `${sessionId}:${approvalId}`
}

export function conversationKey(
  sessionId: string,
  turnId: number,
  role: "user" | "assistant",
): string {
  return `${sessionId}:${turnId}:${role}`
}

function copyRef(ref: ContentRef | undefined): ContentRef | undefined {
  return ref ? { ...ref } : undefined
}

function copyReceipt(receipt: Receipt | undefined): Receipt | undefined {
  if (!receipt) return undefined
  return {
    ...receipt,
    ...(receipt.paths ? { paths: [...receipt.paths] } : {}),
    ...(receipt.stats ? { stats: { ...receipt.stats } } : {}),
    ...(receipt.test ? { test: { ...receipt.test } } : {}),
    ...(receipt.cmd ? { cmd: { ...receipt.cmd } } : {}),
  }
}

export function createInitialState(sessionId: string): PresentationState {
  return {
    sessionId,
    seq: 0,
    turns: new Map(),
    activities: new Map(),
    approvals: new Map(),
    conversation: [],
    reasoning: [],
    system: [],
    plans: new Map(),
    findings: new Map(),
    results: new Map(),
    diagnostics: [],
    order: [],
    evicted: [],
  }
}

export function cloneState(s: PresentationState): PresentationState {
  return {
    sessionId: s.sessionId,
    seq: s.seq,
    turns: new Map(
      [...s.turns].map(([k, v]) => [
        k,
        {
          ...v,
          ...(v.summary ? { summary: { ...v.summary } } : {}),
        },
      ]),
    ),
    activities: new Map(
      [...s.activities].map(([k, v]) => [
        k,
        {
          ...v,
          identity: { ...v.identity },
          ...(v.error ? { error: { ...v.error } } : {}),
          ...(v.expandRef ? { expandRef: copyRef(v.expandRef) } : {}),
          receipt: copyReceipt(v.receipt),
        },
      ]),
    ),
    approvals: new Map(
      [...s.approvals].map(([k, v]) => [
        k,
        {
          ...v,
          identity: { ...v.identity },
          ...(v.outcome ? { outcome: { ...v.outcome } } : {}),
        },
      ]),
    ),
    conversation: s.conversation.map((m) => ({
      ...m,
      ...(m.expandRef ? { expandRef: copyRef(m.expandRef) } : {}),
    })),
    reasoning: s.reasoning.map((r) => ({ ...r, expandRef: { ...r.expandRef } })),
    system: s.system.map((e) => ({ ...e })),
    plans: new Map(
      [...s.plans].map(([k, v]) => [
        k,
        {
          ...v,
          steps: v.steps.map((step) => ({ ...step })),
          ...(v.expandRef ? { expandRef: copyRef(v.expandRef) } : {}),
        },
      ]),
    ),
    findings: new Map([...s.findings].map(([k, v]) => [k, { ...v, evidence: [...v.evidence] }])),
    results: new Map(
      [...s.results].map(([k, v]) => [
        k,
        {
          ...v,
          ...(v.expandRef ? { expandRef: copyRef(v.expandRef) } : {}),
          receipt: copyReceipt(v.receipt),
        },
      ]),
    ),
    diagnostics: s.diagnostics.map((d) => ({ ...d })),
    order: s.order.map((o) => ({ ...o })),
    evicted: s.evicted.map((e) => ({ ...e })),
  }
}
