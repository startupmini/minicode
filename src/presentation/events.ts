// Kosakata semantik presentasi agen — V2.1 (AGENT_PRESENTATION_ARCHITECTURE_V2_1.md).
//
// Kenapa berkas ini ada: runtime (MiniCore) meng-emit 9 event miskin tanpa
// lifecycle gagal/batal/deny dan tanpa identitas yang selamat sampai UI
// (vendor/minicore/src/core/events.ts, executor.ts:44-73 return tanpa emit,
// session.ts:248 hanya sukses). Dua sink UI menafsir event mentah
// sendiri-sendiri dan divergen. Berkas ini mendefinisikan SATU bahasa yang
// dipakai adaptor → reducer → proyeksi, sehingga TUI/linear/ACP kelak berbagi
// makna yang sama tanpa masing-masing merekonstruksi semantik runtime.
//
// Bukan framework event-sourcing: hanya tipe + tabel durability. Logika di
// adapter.ts (observasi) dan reducer.ts (Fase 3, state). Renderer tidak boleh
// mengimpor berkas ini untuk keputusan semantik — ia hanya menerima string
// final dari proyeksi.

/** Asal tool — di-parse SEKALI di adaptor, bukan di renderer. */
export interface ToolIdentity {
  /** "builtin" = tool bawaan minicode; "mcp" = `serverid.toolname` runtime. */
  origin: "builtin" | "mcp"
  /** Id server MCP (`srv` pada `srv.search`); undefined untuk builtin. */
  namespace?: string
  /** Nama lokal (`search`, BUKAN `srv.search`). */
  name: string
  /** Bentuk string tunggal yang beredar (`search` | `srv.search`). */
  qualified: string
}

/** Ringkasan argumen yang aman tampil (tanpa isi file/kode penuh). */
export interface ArgsSummary {
  /** Target utama (`path` / `$ cmd` / pola / kueri) — untuk baris ledger. */
  target?: string
  /** Ringkasan satu-baris (di-scrub secret). */
  text: string
}

/** Alasan penolakan kebijakan — nilai dikenal + string mentah ≤80 char. */
export type DenyReason =
  | "jail"
  | "sensitive"
  | "allowlist"
  | "bash-guard"
  | "mode"
  | "no-approval"
  | "user"
  | (string & {})

/** Penyebab kegagalan tool — minimal, bukan taksonomi enterprise. */
export type FailCause =
  /** Kontrak salah: unknown tool + invalid args (model salah panggil). */
  | "invalid"
  /** Tool melempar / exit≠0 / executor error. */
  | "exec"
  /** Kategori provider (auth/rate_limit/network/…). */
  | "provider"
  /** Batas agen: max_steps / recovery habis. */
  | "agent"

/** Alasan pembatalan — "budget" adalah refinement repo-grounded (AgentError
 * kind budget_exceeded ada di kernel; V2.1 generik tidak menyebutnya). */
export type CancelReason = "user" | "timeout" | "budget" | "parent-ended" | "parent-aborted"

/** Outcome persetujuan — satu event terminal `settled`, bukan dua tipe. */
export type ApprovalOutcome =
  | { decision: "allow"; by: "user" | "system" }
  /** Jawab `[a]` — efek samping allowlist di luar model, keputusan tetap tercatat. */
  | { decision: "allow-always"; by: "user" }
  | {
      decision: "deny"
      by: "user" | "system"
      reason?: "declined" | "headless" | "no-ask" | "no-view" | "prompt-error" | "parent-aborted"
    }
  | {
      decision: "cancelled"
      by: "system"
      reason: "parent-aborted" | "parent-ended" | "timeout" | "renderer-failure"
    }

/** Ringkasan turn — agregat derived (dihitung adaptor/reducer, bukan runtime). */
export interface TurnSummary {
  toolsOk: number
  toolsFailed: number
  toolsDenied: number
  toolsCancelled: number
  toolsInterrupted: number
  filesChanged: number
  checkpointId?: string
  durationMs: number
}

/** Bukti konsekuensi (receipt) — view atas journal/checkpoint, bukan tracker baru. */
export interface Receipt {
  toolCallId: string
  journalSeq?: number
  checkpointId?: string
  paths?: string[]
  stats?: { added?: number; removed?: number }
  test?: { passed: number; failed: number; summary: string }
  cmd?: { exit?: number }
}

/** Referensi konten besar — model hanya menyimpan ini, bukan isinya. */
export interface ContentRef {
  toolCallId: string
  idx: number
  /** True bila store meng-evict entry (Fase 4): proyeksi tampilkan penanda retensi. */
  dead?: boolean
}

/**
 * Tautan forward sub-anak → call `delegate_task` pemanggil (Fase 2).
 * parentToolCallId tidak tersedia di ToolContext execute — adaptor memasangkan
 * `execution:started` delegate_task (call.id) dengan forward bertag
 * `forwardedChild` saat tepat satu call induk masih terbuka (§12 V2.1);
 * paralel ambigu TIDAK ditebak (orphan, bukan taut salah).
 */
export interface ChildSessionLink {
  parentToolCallId: string
  childSessionId: string
  parentSessionId?: string
}

interface Base {
  eventSeq: number
  ts: number
  sessionId: string
  turnId: number
}

export interface TurnStartedEvent extends Base {
  type: "turn.started"
  promptRef: string
}
export interface TurnCompletedEvent extends Base {
  type: "turn.completed"
  summary: TurnSummary
}
export interface TurnFailedEvent extends Base {
  type: "turn.failed"
  error: { cause: FailCause | "provider" | "system"; message: string }
}
export interface TurnCancelledEvent extends Base {
  type: "turn.cancelled"
  reason: CancelReason
}
export interface ModelDeltaEvent extends Base {
  type: "model.delta"
  delta: string
}
export interface ModelCompletedEvent extends Base {
  type: "model.completed"
  text: string
  truncated: boolean
  expandRef?: ContentRef
}
export interface ReasoningDeltaEvent extends Base {
  type: "reasoning.delta"
  delta: string
}
export interface ReasoningCompletedEvent extends Base {
  type: "reasoning.completed"
  truncated: boolean
  expandRef: ContentRef
}
export interface ToolStartedEvent extends Base {
  type: "tool.started"
  toolCallId: string
  stepId: number
  identity: ToolIdentity
  argsSummary: ArgsSummary
  /** Forward anak: taut ke delegate_task pemanggil (absen = tool parent biasa). */
  parentLink?: ChildSessionLink
}
export interface ToolProgressEvent extends Base {
  type: "tool.progress"
  toolCallId: string
  message: string
}
export interface ToolCompletedEvent extends Base {
  type: "tool.completed"
  toolCallId: string
  durationMs: number
  summary: string
  expandRef: ContentRef
  receipt?: Receipt
  parentLink?: ChildSessionLink
}
export interface ToolFailedEvent extends Base {
  type: "tool.failed"
  toolCallId: string
  durationMs: number
  cause: FailCause
  message: string
  hint?: string
  expandRef: ContentRef
  parentLink?: ChildSessionLink
}
export interface ToolDeniedEvent extends Base {
  type: "tool.denied"
  toolCallId: string
  reason: DenyReason
  message: string
  parentLink?: ChildSessionLink
}
export interface ToolCancelledEvent extends Base {
  type: "tool.cancelled"
  toolCallId: string
  reason: CancelReason
  parentLink?: ChildSessionLink
}
export interface ApprovalRequestedEvent extends Base {
  type: "approval.requested"
  approvalId: string
  /** Absen = pertanyaan ask_user langsung (bukan gate tool). */
  toolCallId?: string
  identity: ToolIdentity
  argsSummary: ArgsSummary
  via: "prompt" | "system"
}
export interface ApprovalSettledEvent extends Base {
  type: "approval.settled"
  approvalId: string
  toolCallId?: string
  outcome: ApprovalOutcome
}
export interface FileChangedEvent extends Base {
  type: "file.changed"
  toolCallId: string
  paths: string[]
  journalSeq?: number
  checkpointId?: string
}
export interface TestCompletedEvent extends Base {
  type: "test.completed"
  toolCallId: string
  passed: number
  failed: number
  summary: string
}
export interface ContextCompactedEvent extends Base {
  type: "context.compacted"
  reason: string
}

export type DomainEvent =
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnCancelledEvent
  | ModelDeltaEvent
  | ModelCompletedEvent
  | ReasoningDeltaEvent
  | ReasoningCompletedEvent
  | ToolStartedEvent
  | ToolProgressEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | ToolDeniedEvent
  | ToolCancelledEvent
  | ApprovalRequestedEvent
  | ApprovalSettledEvent
  | FileChangedEvent
  | TestCompletedEvent
  | ContextCompactedEvent

export type DomainEventType = DomainEvent["type"]

/** Kebijakan durable vs live (§7 V2.1): restart merekonstruksi tanpa delta. */
export const DURABILITY: Record<DomainEventType, { durable: boolean; replayable: boolean }> = {
  "turn.started": { durable: true, replayable: true },
  "turn.completed": { durable: true, replayable: true },
  "turn.failed": { durable: true, replayable: true },
  "turn.cancelled": { durable: true, replayable: true },
  "model.delta": { durable: false, replayable: false },
  "model.completed": { durable: true, replayable: true },
  "reasoning.delta": { durable: false, replayable: false },
  "reasoning.completed": { durable: true, replayable: true },
  "tool.started": { durable: true, replayable: true },
  "tool.progress": { durable: false, replayable: false },
  "tool.completed": { durable: true, replayable: true },
  "tool.failed": { durable: true, replayable: true },
  "tool.denied": { durable: true, replayable: true },
  "tool.cancelled": { durable: true, replayable: true },
  "approval.requested": { durable: true, replayable: true },
  "approval.settled": { durable: true, replayable: true },
  "file.changed": { durable: true, replayable: true },
  "test.completed": { durable: true, replayable: true },
  "context.compacted": { durable: true, replayable: true },
}

/**
 * Bus sumber yang dibaca adaptor — struktural seperti UiBus (handler `any`
 * disengaja karena `on` kernel generik-kondisional; lihat contract.ts:46-55).
 */
export interface EventBusLike {
  on(type: string, handler: (event: any) => void): () => void
}

// ── Hook persetujuan (permission/ask_user → adaptor, via DI dari cli/) ──
//
// Policy layer tidak mengimpor UI dan tidak tahu PresentationState; ia hanya
// memanggil hook ini di samping callback keputusan. Adaptor yang mengisi
// eventSeq/ts/sessionId/turnId + identity/argsSummary (satu-satunya parser).

export interface ApprovalPromptCall {
  id?: string
  name: string
  args?: unknown
}

export type ApprovalHookEvent =
  | {
      kind: "requested"
      approvalId: string
      call: ApprovalPromptCall
      via: "prompt" | "system"
    }
  | {
      kind: "settled"
      approvalId: string
      call: ApprovalPromptCall
      outcome: ApprovalOutcome
    }

export type ApprovalEventHook = (e: ApprovalHookEvent) => void
