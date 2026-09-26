// Kontrak presentasi — satu-satunya jendela komunikasi antara lapisan UI dan
// sistem di luarnya.
//
// Aturan arah dependensi (dijaga test/ui-boundary.test.ts):
// - src/ui/ TIDAK BOLEH mengimpor cli/, src/ non-ui, atau #minicore.
// - src/ non-ui TIDAK BOLEH mengimpor src/ui/ — komunikasi lewat kontrak ini
//   dan callback yang di-inject dari cli/ (composition root).
//
// Semua event kernel dipetakan ke tipe STRUKTURAL di sini. EventBus kernel
// (#minicore) kompatibel secara struktural dengan UiBus, jadi cli/ bisa
// menyerahkan bus kernel apa adanya tanpa adapter runtime.

export interface UiToolCallRef {
  /**
   * toolCallId dari provider (ToolCall.id) — diaditif Fase 2 Presentasi V2.1.
   * Opsional agar subscriber lama yang hanya butuh name/args tidak rusak;
   * kernel selalu mengisi ini (snapshotToolCall), cast `as unknown` di
   * cli/tui.ts tidak lagi buta terhadap identitas.
   */
  id?: string
  name: string
  args?: unknown
}

/** Hasil tool ringkas di step (Fase 2) — bukan payload penuh ToolResult. */
export interface UiStepResultRef {
  toolCallId?: string
  isError?: boolean
  content?: unknown
}

export interface UiStep {
  index: number
  toolCalls: readonly UiToolCallRef[]
  /** Opsional: ringkas results (kernel step:completed membawa ini penuh). */
  results?: readonly UiStepResultRef[]
}

export interface UiExecution {
  call: UiToolCallRef
  result: { isError?: boolean; content?: unknown }
}

/**
 * Subset event agen yang dikonsumsi lapisan presentasi. Field meniru bentuk
 * payload kernel (flat, ber-`type`) tetapi didefinisikan ulang di sini supaya
 * UI tidak pernah menyentuh tipe vendor.
 */
export type UiEvent =
  | { type: "turn:started"; turn: number }
  | { type: "turn:completed"; result?: unknown }
  | { type: "step:started"; step: UiStep }
  | { type: "step:completed"; step: UiStep }
  | { type: "execution:started"; execution: UiExecution }
  | { type: "execution:completed"; execution: UiExecution }
  | { type: "provider:text"; text: string }
  | { type: "provider:extension"; kind: string; data: unknown }
  | { type: "context:compacted"; reason: string }

export type UiEventType = UiEvent["type"]

/**
 * Bus event yang dibaca lapisan presentasi. Handler dilonggarkan ke `any`
 * dengan sengaja: `on` milik EventBus kernel bersifat generik-kondisional, dan
 * versi bertipe ketat (`handler: (event: Extract<UiEvent, {type: K}>) => void`)
 * membuat kernel TIDAK assignable karena kontravariansi parameter. Tiap view
 * menganotasi bentuk payload yang ia render sendiri (lihat assistant/*).
 */
export interface UiBus {
  on(type: UiEventType, handler: (event: any) => void): () => void
}

export type UiToolStatus =
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled"
  | "interrupted"

export interface UiTurnSummary {
  toolsOk: number
  toolsFailed: number
  toolsDenied: number
  toolsCancelled: number
  toolsInterrupted: number
  filesChanged: number
  checkpointId?: string
  testSummary?: { passed: number; failed: number; summary: string }
  evidenceComplete?: boolean
  durationMs: number
}

export interface UiPresentationError {
  cause?: string
  message: string
  hint?: string
}

export interface UiPresentationReceipt {
  sessionId?: string
  turnId?: number
  paths?: string[]
  checkpointId?: string
  stats?: { added?: number; removed?: number }
  test?: { passed: number; failed: number; summary: string }
  cmd?: { exit?: number }
}

export interface UiPresentationActivity {
  seq?: number
  turnId?: number
  sessionId?: string
  toolCallId: string
  name: string
  qualified?: string
  target?: string
  status: UiToolStatus
  tsStart: number
  tsEnd?: number
  durationMs?: number
  summary?: string
  error?: UiPresentationError
  denyReason?: string
  receipt?: UiPresentationReceipt
  parentToolCallId?: string
  supersedes?: string
  expandRef?: { toolCallId: string; idx: number }
}

export interface UiPresentationTurn {
  turnId: number
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted"
  summary?: UiTurnSummary
}

export interface UiPresentationMessage {
  id: string
  sessionId: string
  turnId: number
  role: "user" | "assistant"
  text: string
  truncated: boolean
  promptRef?: string
}

export interface UiPresentationReasoning {
  id: string
  sessionId: string
  turnId: number
  truncated: boolean
  expandRef: { toolCallId: string; idx: number }
}

export interface UiPresentationSystem {
  id: string
  sessionId: string
  turnId: number
  kind: "context_compacted" | "recovery" | "checkpoint" | "notice"
  text: string
  reason?: string
  severity: "info" | "warning" | "error" | "critical"
}

export interface UiPresentationPlan {
  planId: string
  sessionId: string
  turnId: number
  status: "open" | "completed" | "cancelled"
  steps: Array<{
    stepId: string
    title?: string
    status: "pending" | "active" | "completed" | "cancelled" | "blocked"
  }>
}

export interface UiPresentationFinding {
  findingId: string
  sessionId: string
  turnId: number
  category: string
  severity: "info" | "warning" | "error" | "critical"
  summary: string
  evidence: string[]
}

export interface UiPresentationResult {
  resultId: string
  sessionId: string
  turnId: number
  status: "completed" | "failed" | "cancelled"
  summary: string
  action?: string
}

export interface UiPresentationDiagnostic {
  id: string
  sessionId: string
  turnId: number
  category: string
  severity: "info" | "warning" | "error" | "critical"
  message: string
  cause?: string
  action?: string
}

/** Deskripsi activity dari policy kanonik (tanpa paint/sanitasi/truncate). */
export interface ActivityPolicyDescription {
  toolCallId: string
  name: string
  target?: string
  status: UiToolStatus
  summary?: string
  message?: string
  durationMs?: number
  denyReason?: string
  receiptPaths: string[]
  testSummary?: { passed: number; failed: number; summary: string }
  retryOf?: string
  childCount: number
  isChild: boolean
  expandRef?: { toolCallId: string; idx: number }
  error?: { cause?: string; message: string; hint?: string }
  tsStart: number
  tsEnd?: number
}

/**
 * Kumpulan keputusan proyeksi kanonik untuk renderer. Di-inject composition
 * root dari `src/presentation/`; absen = logika inline legacy di renderer.
 * Renderer tidak boleh mengimpor `src/presentation` langsung — batas lapisan.
 */
export interface PresentationPolicy {
  describeActivity: (
    activity: UiPresentationActivity,
    opts?: { childCount?: number },
  ) => ActivityPolicyDescription
  matchTurn: (turns: UiPresentationTurn[], summary: UiTurnSummary) => UiPresentationTurn | undefined
  elapsedVisible: (tsStart: number, now: number) => boolean
}

export interface UiPresentationSnapshot {
  activities: UiPresentationActivity[]
  turns: UiPresentationTurn[]
  conversation?: UiPresentationMessage[]
  reasoning?: UiPresentationReasoning[]
  system?: UiPresentationSystem[]
  plans?: UiPresentationPlan[]
  findings?: UiPresentationFinding[]
  results?: UiPresentationResult[]
  diagnostics?: UiPresentationDiagnostic[]
}

export interface UiApprovalOutcome {
  decision: "allow" | "allow-always" | "deny" | "cancelled"
  by: "user" | "system"
  reason?: string
}

export interface UiPresentationEvent {
  type:
    | "user.message"
    | "turn.started"
    | "turn.completed"
    | "turn.failed"
    | "turn.cancelled"
    | "model.delta"
    | "model.completed"
    | "reasoning.delta"
    | "reasoning.completed"
    | "tool.started"
    | "tool.progress"
    | "tool.completed"
    | "tool.failed"
    | "tool.denied"
    | "tool.cancelled"
    | "approval.requested"
    | "approval.settled"
    | "file.changed"
    | "test.completed"
    | "context.compacted"
    | "plan.updated"
    | "finding.detected"
    | "result.produced"
    | "diagnostic.raised"
    | "checkpoint.created"
  seq?: number
  turnId?: number
  stepId?: number
  toolCallId?: string
  approvalId?: string
  name?: string
  qualified?: string
  target?: string
  status?: UiToolStatus
  tsStart?: number
  durationMs?: number
  message?: string
  cause?: string
  reason?: string
  error?: string
  outcome?: UiApprovalOutcome
  via?: "prompt" | "system"
  summary?: UiTurnSummary
  promptRef?: string
  delta?: string
  text?: string
  truncated?: boolean
  toolSummary?: string
  hint?: string
  expandRef?: { toolCallId: string; idx: number }
  receipt?: UiPresentationReceipt
  parentToolCallId?: string
  paths?: string[]
  journalSeq?: number
  checkpointId?: string
  test?: { passed: number; failed: number; summary: string }
  compactionReason?: string
  planId?: string
  findingId?: string
  resultId?: string
  category?: string
  severity?: "info" | "warning" | "error" | "critical"
  action?: string
  steps?: Array<{
    stepId: string
    title?: string
    status: "pending" | "active" | "completed" | "cancelled" | "blocked"
  }>
  evidence?: string[]
}
