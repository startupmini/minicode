// Kebijakan proyeksi presentasi — murni, tanpa IO/clock/env/TTY/ANSI/i18n.
//
// Kenapa berkas ini ada: TUI, linear, exec, dan ACP menafsirkan
// PresentationState sendiri-sendiri sehingga status/target/durasi bisa
// divergen (OAP-001). Modul ini adalah SATU tempat keputusan node semantik:
// node mana yang tampil per mode, deskripsi activity/turn, running pin,
// envelope machine, dan digest divergensi. Renderer hanya layout, paint,
// sanitasi, dan pemotongan lebar; sanitasi tetap di sisi render
// (sanitizeAnsi) dan tidak pernah di sini.

import { LIMITS } from "../constants.ts"
import type { ContentRef, TurnSummary } from "./events.ts"
import type {
  ActivityEntry,
  DiagnosticEntry,
  FindingEntry,
  PlanEntry,
  PresentationState,
  ReasoningEntry,
  ResultEntry,
  SystemEntry,
  ToolStatus,
  TurnEntry,
} from "./model.ts"

export type ProjectionMode = "normal" | "verbose" | "debug" | "machine"

export interface ProjectionContext {
  mode: ProjectionMode
  /** Jam tepi (ms) untuk keputusan elapsed; wajib di-inject agar murni. */
  now?: number
}

// ── Deskripsi semantik (tanpa paint/sanitasi/truncate) ──

export interface ActivityDescription {
  toolCallId: string
  name: string
  target?: string
  status: ToolStatus
  summary?: string
  message?: string
  durationMs?: number
  denyReason?: string
  receiptPaths: string[]
  testSummary?: { passed: number; failed: number; summary: string }
  retryOf?: string
  childCount: number
  isChild: boolean
  expandRef?: ContentRef
  error?: { cause?: string; message: string; hint?: string }
  tsStart: number
  tsEnd?: number
}

/**
 * Bentuk activity struktural yang diterima policy — dipenuhi ActivityEntry
 * model maupun snapshot UI tanpa impor lintas lapisan.
 */
export interface ActivityLike {
  toolCallId: string
  name?: string
  target?: string
  status: ToolStatus
  summary?: string
  durationMs?: number
  denyReason?: string
  receipt?: { paths?: string[]; test?: { passed: number; failed: number; summary: string } }
  supersedes?: string
  parentToolCallId?: string
  expandRef?: ContentRef
  error?: { cause?: string; message: string; hint?: string }
  tsStart: number
  tsEnd?: number
}

export function describeActivity(
  activity: ActivityEntry | ActivityLike,
  opts: { childCount?: number } = {},
): ActivityDescription {
  const source = activity as ActivityLike & { identity?: { name: string } }
  const name = source.identity?.name ?? source.name ?? "tool"
  return {
    toolCallId: activity.toolCallId,
    name,
    ...(activity.target ? { target: activity.target } : {}),
    status: activity.status,
    ...(activity.summary ? { summary: activity.summary } : {}),
    ...(activity.error ? { message: activity.error.message } : {}),
    ...(activity.durationMs !== undefined ? { durationMs: activity.durationMs } : {}),
    ...(activity.denyReason ? { denyReason: activity.denyReason } : {}),
    receiptPaths: [...(activity.receipt?.paths ?? [])],
    ...(activity.receipt?.test ? { testSummary: { ...activity.receipt.test } } : {}),
    ...(activity.supersedes ? { retryOf: activity.supersedes } : {}),
    childCount: opts.childCount ?? 0,
    isChild: activity.parentToolCallId !== undefined,
    ...(activity.expandRef ? { expandRef: { ...activity.expandRef } } : {}),
    ...(activity.error
      ? {
          error: {
            cause: activity.error.cause,
            message: activity.error.message,
            ...(activity.error.hint ? { hint: activity.error.hint } : {}),
          },
        }
      : {}),
    tsStart: activity.tsStart,
    ...(activity.tsEnd !== undefined ? { tsEnd: activity.tsEnd } : {}),
  }
}

export interface TurnDescription {
  turnId: number
  status: TurnEntry["status"]
  summary?: TurnSummary
  checkpointId?: string
  error?: string
}

/** Bentuk turn struktural — dipenuhi TurnEntry model maupun snapshot UI. */
export interface TurnLike {
  turnId: number
  status: TurnEntry["status"]
  summary?: TurnSummary
  checkpointId?: string
  error?: string
}

export function describeTurn(turn: TurnLike): TurnDescription {
  return {
    turnId: turn.turnId,
    status: turn.status,
    ...(turn.summary ? { summary: turn.summary } : {}),
    ...(turn.checkpointId ? { checkpointId: turn.checkpointId } : {}),
    ...(turn.error ? { error: turn.error } : {}),
  }
}

/** Ringkasan turn yang dibandingkan (hanya field yang dicocokkan). */
export interface TurnSummaryLike {
  toolsOk: number
  toolsFailed: number
  toolsDenied: number
  filesChanged: number
}

/** Cari turn pemilik sebuah summary (pengganti pencocokan lapangan di renderer). */
export function matchTurnBySummary<T extends TurnLike>(
  turns: T[],
  summary: TurnSummaryLike,
): T | undefined {
  return turns.find((candidate) => {
    const value = candidate.summary
    return (
      value?.toolsOk === summary.toolsOk &&
      value?.toolsFailed === summary.toolsFailed &&
      value?.toolsDenied === summary.toolsDenied &&
      value?.filesChanged === summary.filesChanged
    )
  })
}

export interface PinnedRunning<T> {
  activity: T
  /** Kebijakan ambang elapsed: tampilkan durasi bila berjalan >= 2 detik. */
  showElapsed: boolean
}

export interface RunningLike {
  toolCallId: string
  status: ToolStatus
  parentToolCallId?: string
  tsStart: number
}

/** Satu activity berjalan yang dipin ke status bar (root didahulukan). */
export function pinnedRunningActivity<T extends RunningLike>(
  activities: T[],
  now: number,
): PinnedRunning<T> | undefined {
  const running = activities.filter((a) => a.status === "running")
  const pinned = running.find((a) => !a.parentToolCallId) ?? running[0]
  if (!pinned) return undefined
  return { activity: pinned, showElapsed: elapsedVisible(pinned.tsStart, now) }
}

/** Ambang elapsed terpusat: durasi live tampil bila berjalan >= 2 detik. */
export function elapsedVisible(tsStart: number, now: number): boolean {
  return now - tsStart >= 2000
}

export interface ActivitySuffixParts {
  status: ToolStatus
  durationMs?: number
  denyReason?: string
  receiptPaths: string[]
  retry: boolean
}

/** Bagian suffix ledger yang dipilih policy (renderer hanya format). */
export function activitySuffixParts(desc: ActivityDescription): ActivitySuffixParts {
  return {
    status: desc.status,
    ...(desc.durationMs !== undefined ? { durationMs: desc.durationMs } : {}),
    ...(desc.denyReason ? { denyReason: desc.denyReason } : {}),
    receiptPaths: [...desc.receiptPaths],
    retry: desc.retryOf !== undefined,
  }
}

// ── Seleksi node per mode ──

export type ProjectionNodeKind =
  | "message"
  | "turn"
  | "tool"
  | "approval"
  | "reasoning"
  | "system"
  | "plan"
  | "finding"
  | "result"
  | "diagnostic"

export interface ProjectionNode {
  kind: ProjectionNodeKind
  id: string
  seq: number
  data:
    | ActivityEntry
    | TurnEntry
    | FindingEntry
    | ResultEntry
    | DiagnosticEntry
    | SystemEntry
    | PlanEntry
    | { kind: "message"; text: string; role: "user" | "assistant" }
    | ReasoningEntry
    | { kind: "approval" }
}

function findActivity(state: PresentationState, id: string): ActivityEntry | undefined {
  return [...state.activities.values()].find((a) => `${a.sessionId}:${a.toolCallId}` === id)
}

function findTurn(state: PresentationState, id: string): TurnEntry | undefined {
  return state.turns.get(id)
}

/**
 * Node semantik yang boleh tampil untuk satu mode. Normal menyembunyikan
 * detail internal (reasoning penuh, approval mentah, progress); verbose
 * membuka target/durasi/receipt/retry; debug membuka semua + identitas;
 * machine mengembalikan urutan lifecycle durable.
 */
export function selectNodes(state: PresentationState, mode: ProjectionMode): ProjectionNode[] {
  const out: ProjectionNode[] = []
  for (const ref of state.order) {
    if (ref.kind === "tool") {
      const activity = findActivity(state, ref.id)
      if (!activity) continue
      out.push({ kind: "tool", id: ref.id, seq: ref.seq, data: activity })
      continue
    }
    if (ref.kind === "turn") {
      const turn = findTurn(state, ref.id)
      if (!turn) continue
      out.push({ kind: "turn", id: ref.id, seq: ref.seq, data: turn })
      continue
    }
    if (ref.kind === "message") {
      if (mode === "machine") continue
      const entry = state.conversation.find((m) => m.id === ref.id)
      if (!entry) continue
      out.push({
        kind: "message",
        id: ref.id,
        seq: ref.seq,
        data: { kind: "message", text: entry.text, role: entry.role },
      })
      continue
    }
    if (ref.kind === "reasoning") {
      if (mode === "normal") continue
      const entry = state.reasoning.find((r) => r.id === ref.id)
      if (!entry) continue
      out.push({ kind: "reasoning", id: ref.id, seq: ref.seq, data: entry })
      continue
    }
    if (ref.kind === "system") {
      const entry = state.system.find((s) => s.id === ref.id)
      if (!entry) continue
      if (mode === "normal" && entry.systemKind !== "checkpoint" && entry.systemKind !== "recovery")
        continue
      out.push({ kind: "system", id: ref.id, seq: ref.seq, data: entry })
      continue
    }
    if (ref.kind === "plan") {
      const entry = state.plans.get(ref.id)
      if (!entry) continue
      if (mode === "normal" && entry.status !== "open") continue
      out.push({ kind: "plan", id: ref.id, seq: ref.seq, data: entry })
      continue
    }
    if (ref.kind === "finding" || ref.kind === "result") {
      const entry = ref.kind === "finding" ? state.findings.get(ref.id) : state.results.get(ref.id)
      if (!entry) continue
      out.push({ kind: ref.kind, id: ref.id, seq: ref.seq, data: entry })
      continue
    }
    if (ref.kind === "diagnostic") {
      const entry = state.diagnostics.find((d) => d.id === ref.id)
      if (!entry) continue
      if (mode === "normal" && entry.severity === "info") continue
      out.push({ kind: "diagnostic", id: ref.id, seq: ref.seq, data: entry })
      continue
    }
    if (ref.kind === "approval") {
      if (mode === "normal" || mode === "machine") continue
      out.push({ kind: "approval", id: ref.id, seq: ref.seq, data: { kind: "approval" } })
    }
  }
  return out
}

/** Digest deterministik untuk harness divergensi (FNV-1a 32-bit, hex). */
export function projectionDigest(nodes: ProjectionNode[]): string {
  let hash = 0x811c9dc5
  const text = JSON.stringify(nodes.map((n) => [n.kind, n.id, n.seq]))
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

// ── Machine envelope (exec JSONL; ACP memakai framing JSON-RPC + mapping sama) ──

export const MACHINE_SCHEMA = "minicode.output.v1"

export type MachineSeverity = "info" | "warning" | "error" | "critical"
export type MachineStatus =
  | "started"
  | "active"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled"
  | "interrupted"
  | "partial"
  | "recovered"

/**
 * Input struktural untuk envelope machine. Field opsional disengaja longgar
 * agar kompatibel dengan UiPresentationEvent tanpa impor src/ui (batas
 * lapisan); pembacaan selalu defensif via guard asString/asNumber/asRecord.
 */
export interface MachineEventInput {
  type: string
  seq?: number
  turnId?: number
  stepId?: number
  toolCallId?: string
  approvalId?: string
  name?: string
  qualified?: string
  target?: string
  status?: string
  tsStart?: number
  durationMs?: number
  message?: unknown
  cause?: unknown
  reason?: unknown
  error?: unknown
  outcome?: unknown
  via?: string
  summary?: unknown
  promptRef?: string
  delta?: unknown
  text?: unknown
  truncated?: boolean
  toolSummary?: unknown
  hint?: unknown
  expandRef?: unknown
  receipt?: unknown
  parentToolCallId?: string
  paths?: unknown
  journalSeq?: number
  checkpointId?: string
  test?: unknown
  compactionReason?: string
  planId?: string
  findingId?: string
  resultId?: string
  category?: unknown
  severity?: unknown
  action?: unknown
  steps?: unknown
  evidence?: unknown
}

export interface MachineEnvelope {
  schema: typeof MACHINE_SCHEMA
  eventId: string
  type: string
  timestamp: string
  sessionId: string
  turnId?: number
  correlationId?: string
  source: "derived"
  severity: MachineSeverity
  status: MachineStatus
  visibility: ["machine"]
  payload: Record<string, unknown>
}

export interface MachineContext {
  sessionId: string
  /** Jam tepi (ms epoch); wajib di-inject agar deterministik di test. */
  timestamp: number
}

const VALID_SEVERITIES: readonly string[] = ["info", "warning", "error", "critical"]

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function capText(value: unknown, max: number): { text: string; truncated: boolean } | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  if (value.length <= max) return { text: value, truncated: false }
  return { text: value.slice(0, max), truncated: true }
}

function eventSuffix(type: string): string {
  const i = type.lastIndexOf(".")
  return i >= 0 ? type.slice(i + 1) : type
}

export function machineEventId(
  sessionId: string,
  turnId: number | undefined,
  seq: number | undefined,
): string {
  return `${sessionId}:${turnId ?? 0}:${seq ?? 0}`
}

export function machineTimestamp(timestamp: number): string {
  return new Date(Number.isFinite(timestamp) ? timestamp : 0).toISOString()
}

export function machineSeverity(event: MachineEventInput): MachineSeverity {
  const explicit = asString(event.severity)
  if (explicit && (VALID_SEVERITIES as readonly string[]).includes(explicit))
    return explicit as MachineSeverity
  const suffix = eventSuffix(event.type)
  if (suffix === "failed" || suffix === "interrupted" || event.error !== undefined) return "error"
  if (suffix === "denied" || suffix === "cancelled") return "warning"
  return "info"
}

export function machineStatus(event: MachineEventInput): MachineStatus {
  if (event.type === "approval.settled") {
    const decision = asRecord(event.outcome)?.decision
    if (decision === "deny") return "denied"
    if (decision === "cancelled") return "cancelled"
    return "completed"
  }
  if (event.type === "plan.updated") {
    const status = asString(event.status)
    return status === "open" ? "active" : ((status as MachineStatus | undefined) ?? "active")
  }
  if (event.type === "result.produced") {
    const status = asString(event.status)
    if (status === "failed" || status === "cancelled") return status
    return "completed"
  }
  if (event.type === "finding.detected") return "completed"
  if (event.type === "diagnostic.raised") return "active"
  const suffix = eventSuffix(event.type)
  if (
    suffix === "started" ||
    suffix === "completed" ||
    suffix === "failed" ||
    suffix === "denied" ||
    suffix === "cancelled" ||
    suffix === "interrupted" ||
    suffix === "partial" ||
    suffix === "recovered"
  )
    return suffix
  if (suffix === "progress" || suffix === "delta") return "active"
  return "active"
}

export function correlationId(event: MachineEventInput): string | undefined {
  return (
    asString(event.toolCallId) ??
    asString(event.approvalId) ??
    asString(event.planId) ??
    asString(event.findingId) ??
    asString(event.resultId) ??
    asString(event.checkpointId) ??
    asString(event.promptRef)
  )
}

const PAYLOAD_TEXT_MAX = LIMITS.MCP_OUTPUT_MAX_CHARS

function cappedPayloadText(value: unknown): Record<string, unknown> | undefined {
  const capped = capText(value, PAYLOAD_TEXT_MAX)
  if (!capped) return undefined
  return { text: capped.text, ...(capped.truncated ? { truncated: true } : {}) }
}

/** Payload machine: whitelist per tipe, tanpa ID internal mentah yang berlebih. */
export function machinePayload(event: MachineEventInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  const put = (key: string, value: unknown): void => {
    if (value !== undefined) payload[key] = value
  }
  put("stepId", asNumber(event.stepId))
  put("toolCallId", asString(event.toolCallId))
  put("approvalId", asString(event.approvalId))
  put("name", asString(event.name))
  put("qualified", asString(event.qualified))
  put("target", asString(event.target))
  put("status", asString(event.status))
  put("cause", asString(event.cause))
  put("reason", asString(event.reason))
  put("hint", asString(event.hint))
  put("via", asString(event.via))
  put("promptRef", asString(event.promptRef))
  put("delta", asString(event.delta))
  put("truncated", typeof event.truncated === "boolean" ? event.truncated : undefined)
  put("toolSummary", asString(event.toolSummary))
  put("durationMs", asNumber(event.durationMs))
  put("tsStart", asNumber(event.tsStart))
  put(
    "paths",
    Array.isArray(event.paths)
      ? event.paths.filter((p) => typeof p === "string").slice(0, 100)
      : undefined,
  )
  put("journalSeq", asNumber(event.journalSeq))
  put("checkpointId", asString(event.checkpointId))
  put("planId", asString(event.planId))
  put("findingId", asString(event.findingId))
  put("resultId", asString(event.resultId))
  put("category", asString(event.category))
  put("severity", asString(event.severity))
  put("action", asString(event.action))
  put("compactionReason", asString(event.compactionReason))
  const outcome = asRecord(event.outcome)
  if (outcome) payload.outcome = outcome
  const summary = asRecord(event.summary)
  if (summary) payload.summary = summary
  const test = asRecord(event.test)
  if (test) payload.test = test
  const receipt = asRecord(event.receipt)
  if (receipt) payload.receipt = receipt
  const expandRef = asRecord(event.expandRef)
  if (expandRef) payload.expandRef = expandRef
  if (Array.isArray(event.steps)) payload.steps = event.steps.slice(0, 100)
  if (Array.isArray(event.evidence))
    payload.evidence = event.evidence.filter((e) => typeof e === "string").slice(0, 20)
  if (event.parentToolCallId !== undefined) payload.parentToolCallId = event.parentToolCallId
  const message = cappedPayloadText(event.message)
  if (message) payload.message = message.text
  const error = cappedPayloadText(event.error)
  if (error) payload.error = error.text
  const text = cappedPayloadText(event.text)
  if (text) {
    payload.text = text.text
    if (text.truncated || event.truncated === true) payload.truncated = true
  }
  return payload
}

export function toMachineEnvelope(
  event: MachineEventInput,
  ctx: MachineContext,
): MachineEnvelope | null {
  if (!event || typeof event.type !== "string" || event.type.length === 0) return null
  const turnId = asNumber(event.turnId)
  const seq = asNumber(event.seq)
  const envelope: MachineEnvelope = {
    schema: MACHINE_SCHEMA,
    eventId: machineEventId(ctx.sessionId, turnId, seq),
    type: event.type,
    timestamp: machineTimestamp(ctx.timestamp),
    sessionId: ctx.sessionId,
    ...(turnId !== undefined ? { turnId } : {}),
    source: "derived",
    severity: machineSeverity(event),
    status: machineStatus(event),
    visibility: ["machine"],
    payload: machinePayload(event),
  }
  const correlation = correlationId(event)
  if (correlation) envelope.correlationId = correlation
  return envelope
}

export interface MachineError {
  category:
    | "USER_ERROR"
    | "CONFIGURATION_ERROR"
    | "PERMISSION_ERROR"
    | "TOOL_ERROR"
    | "FILESYSTEM_ERROR"
    | "NETWORK_ERROR"
    | "PROVIDER_ERROR"
    | "MODEL_ERROR"
    | "AGENT_ERROR"
    | "INTERNAL_ERROR"
  message: string
  action?: string
}

function firstLine(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : String(value ?? "")
  const line = text.split("\n")[0] ?? ""
  const clean = line.trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean || "unknown error"
}

/** Kategori error machine dari bentuk error struktural (tanpa impor vendor). */
export function machineError(e: unknown): MachineError {
  const obj = asRecord(e) ?? {}
  const kind = asString(obj.kind)
  const category = asString(obj.category)
  const name = asString(obj.name)
  const message = firstLine(
    asString(obj.message) ?? (e instanceof Error ? e.message : undefined) ?? e,
    500,
  )
  if (name === "NoProviderError" || /no provider configured/i.test(message))
    return { category: "CONFIGURATION_ERROR", message, action: "configure a provider" }
  if (kind === "budget_exceeded" || /over budget|unknown cost/i.test(message))
    return { category: "USER_ERROR", message, action: "raise --budget or reduce usage" }
  if (kind === "timeout" || (/timeout|timed out/i.test(message) && kind !== "aborted"))
    return { category: "AGENT_ERROR", message, action: "retry with a higher --timeout" }
  if (kind === "max_steps_exceeded" || /max.?steps/i.test(message))
    return { category: "AGENT_ERROR", message, action: "raise --max-steps" }
  if (kind === "aborted" || /^(run cancelled|turn aborted|aborted)/i.test(message))
    return { category: "USER_ERROR", message }
  if (/refusing|denied|not allowed|not permitted/i.test(message))
    return { category: "PERMISSION_ERROR", message }
  if (kind === "provider" || category !== undefined) return { category: "PROVIDER_ERROR", message }
  return { category: "AGENT_ERROR", message }
}
