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
      // [Area B · PROMPT 06] "approval-stale" = user menyetujui, tapi target
      // file berubah selama prompt ⇒ fail-closed (additive, tak mengubah
      // makna reason yang sudah ada).
      reason?:
        | "declined"
        | "headless"
        | "no-ask"
        | "no-view"
        | "prompt-error"
        | "parent-aborted"
        | "approval-stale"
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
  testSummary?: { passed: number; failed: number; summary: string }
  evidenceComplete?: boolean
  durationMs: number
}

/** Bukti konsekuensi (receipt) — view atas journal/checkpoint, bukan tracker baru. */
export interface Receipt {
  toolCallId: string
  sessionId?: string
  turnId?: number
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
  kind?: "output" | "diff" | "reasoning" | "diagnostic"
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
  /**
   * F-AGENT-1: id Run kanonik anak (`allocateRunId`) — identitas eksekusi yang
   * membedakan penyelesaian/retry anak, BUKAN childSessionId (identity session)
   * maupun parentToolCallId (taut ke pemanggil). Absen = jalur lama belum
   * membawanya (tetap sah, hanya tanpa identitas run anak).
   */
  runId?: string
}

/**
 * P1.6: versi skema event durable. Additive: event lama tanpa `v` dibaca sebagai
 * v1 (decoder tidak mensyaratkan field ini), sehingga penambahan field opsional
 * tetap kompatibel. Naikkan hanya bila field wajib berubah/bermakna baru.
 */
export const EVENT_SCHEMA_VERSION = 1

interface Base {
  eventSeq: number
  ts: number
  sessionId: string
  turnId: number
  /** Versi skema durable; absen = v1 (kompatibilitas replay lama). */
  v?: number
  // M1 correlator (ADR-002, additive-optional): korelasi execution tanpa
  // mengganti domain identity. Absent = event legacy / jalur belum wiring
  // (M10 yang memasang penuh); parser lama tetap membaca (decode hanya
  // mensyaratkan Base + shape per-tipe, lihat persistence.ts).
  /** Identity instance execution (allocated `exec_<UUIDv4>` / derived 32-hex). */
  executionId?: string
  /** Parent execution (absent pada root — bukan null/placeholder). */
  parentExecutionId?: string
  /** Root forest korelasi (immutable; retry/detach tak boleh rewrite — M7). */
  rootExecutionId?: string
  /** Kind datar M1: turn | tool_call | task | child | background. */
  executionKind?: string
  /** Owner menurut arsitektur (session/task id); bukan authority user input. */
  ownerId?: string
}

export interface UserMessageEvent extends Base {
  type: "user.message"
  text: string
  promptRef: string
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
  /** Guard-local provider stream attempt; invalidation diagnostics reference it. */
  attemptId?: number
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
  /** Guard-local provider stream attempt; failed reasoning is rolled back. */
  attemptId?: number
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
  /**
   * F-TOOL-1: drift skema MCP terstruktur (bukan `message` yang mengandung
   * string error mentah). Absen = kegagalan bukan drift skema (atau jalur
   * legacy yang belum mendeteksinya).
   */
  schemaDrift?: McpSchemaDrift
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
  /** F-APPROVAL-1: tier risiko efek samping tool (dari kontrak tool). */
  riskTier?: SideEffectTierDisplay
  /**
   * F-APPROVAL-1: pratinjau diff ringkas untuk preview persetujuan (satu baris,
   * sudah di-scrub secret). Absen = tidak ada diff yang tersedia/tidak relevan.
   */
  diffPreview?: string
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

export type SemanticSeverity = "info" | "warning" | "error" | "critical"
export type PlanStepStatus = "pending" | "active" | "completed" | "cancelled" | "blocked"

/**
 * One step of a plan.
 *
 * PHASE 3B: `taskId` is the canonical identity; `ordinal` is display position.
 *
 * `stepId` is NOT identity. It is a positional label (`String(i + 1)`) that
 * predates canonical task ids and is still consumed by projection, reducer and
 * ACP, so it is retained for compatibility and explicitly documented as
 * non-canonical. It is also deliberately NOT mirrored from `taskId`: mirroring
 * would change what existing consumers observe.
 *
 * Both new fields are OPTIONAL and additive. Durable `plan.updated` rows written
 * before this change carry neither, and still satisfy the `isValidEventShape`
 * gate in `src/session/persistence.ts`, so replay is unaffected.
 */
export interface PlanStep {
  /** Positional compatibility label. NOT canonical identity. */
  stepId: string
  /** Canonical TaskStore identity (`t<n>`), present only on payloadVersion=2. */
  taskId?: string
  /** Display position within the plan. Explicitly not identity. */
  ordinal?: number
  title?: string
  status: PlanStepStatus
}

export interface PlanUpdatedEvent extends Base {
  type: "plan.updated"
  planId: string
  status: "open" | "completed" | "cancelled"
  /**
   * `2` means step identity is `taskId`-based and every step carries a
   * `taskId`. Absent means positional `stepId` only. The adapter emits `2` only
   * when identity resolution is total, so `payloadVersion === 2` is a truthful
   * statement that this event carries no positional identity.
   */
  payloadVersion?: 2
  steps: PlanStep[]
  expandRef?: ContentRef
}

export interface FindingDetectedEvent extends Base {
  type: "finding.detected"
  findingId: string
  category: string
  severity: SemanticSeverity
  summary: string
  evidence?: string[]
  /** Forward anak: taut ke delegate_task pemanggil (absen = finding sesi biasa). */
  parentLink?: ChildSessionLink
}

export interface ResultProducedEvent extends Base {
  type: "result.produced"
  resultId: string
  status: "completed" | "failed" | "cancelled"
  summary: string
  action?: string
  expandRef?: ContentRef
}

export interface DiagnosticRaisedEvent extends Base {
  type: "diagnostic.raised"
  category: string
  severity: SemanticSeverity
  message: string
  /** Provider attempt whose live output was invalidated, when applicable. */
  attemptId?: number
  cause?: string
  action?: string
}

export interface CheckpointCreatedEvent extends Base {
  type: "checkpoint.created"
  checkpointId: string
  paths?: string[]
}

/**
 * Observasi verifikasi P2.11 — BUKAN bukti baru, melainkan proyeksi observasi
 * atas intent/terminal/verdict yang sudah durable di jurnal mutasi.
 *
 * `verdict` hanya present|absent|inconclusive: ketiadaan event ini untuk suatu
 * invokasi berarti UNKNOWN (diturunkan di proyeksi, bukan di sini). Event ini
 * tidak pernah mengubah status/history/lifecycle activity — hanya menempelkan
 * `verification` untuk display. `evidenceReference` TIDAK dibawa ke sini
 * (tetap di jurnal); yang dibawa hanya identitas + verdict + metode.
 */
// ── Literal tampilan (didefinisikan ulang di sini) ──
//
// Lapisan presentasi TIDAK mengimpor `src/policy`/`src/task` untuk keputusan
// semantik: literal-literal ini adalah salinan ringkas dari kosakata domain
// yang hanya untuk display (pola yang sama dengan `VerificationDisplayVerdict`).
// Renderer memakai nilai final dari proyeksi; definisi ulang ini memutus
// dependensi lapisan tanpa mengarang nilai baru.

/** Verdict consequence (F-CTRL-1) — cermin `AceVerdict` di policy. */
export type ConsequenceVerdict = "PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE"

/** Kelas kegagalan consequence — cermin `AceFailureClass`. */
export type ConsequenceFailureClass =
  | "NONE"
  | "TRANSIENT_ENV"
  | "FUNCTIONAL_TEST_FAIL"
  | "REGRESSION_DETECTED"
  | "REPEATED_NO_EVIDENCE"
  | "INSUFFICIENT_EVIDENCE"
  | "PERMISSION_OR_EXTERNAL_BLOCKER"
  | "EVALUATOR_TAMPER_ATTEMPT"

/** Aksi lanjut consequence — cermin `AceNextAction`. */
export type ConsequenceNextAction =
  | "COMPLETE_AFTER_VERIFICATION"
  | "RETRY_TRANSIENT"
  | "ANALYZE_FAILURE"
  | "REVISE_HYPOTHESIS"
  | "GATHER_EVIDENCE"
  | "CHANGE_STRATEGY"
  | "REQUEST_HUMAN"
  | "STOP_AND_REPORT"

/** Tier efek samping untuk approval (F-APPROVAL-1) — cermin `SideEffectTier`. */
export type SideEffectTierDisplay =
  | "PURE_READ"
  | "WORKSPACE_MUTATION"
  | "LOCAL_ENV_MUTATION"
  | "EXTERNAL_IRREVERSIBLE"
  | "UNKNOWN"

/** Status task kanonik (F-TASK-1) — cermin `TaskStatus` di `src/task`. */
export type TaskStatusDisplay =
  | "PENDING"
  | "IN_PROGRESS"
  | "VERIFYING"
  | "BLOCKED"
  | "FAILED"
  | "RETRYING"
  | "COMPLETED"
  | "CANCELLED"

/** Drift skema MCP terstruktur (F-TOOL-1) — BUKAN string error mentah. */
export interface McpSchemaDrift {
  /** Id server MCP (`srv` pada `srv.search`). */
  serverId: string
  /** Nama tool lokal (`search`). */
  toolName: string
}

export type VerificationDisplayVerdict = "present" | "absent" | "inconclusive"

/** Tampilan verifikasi per activity — observasi, bukan otoritas efek. */
export interface VerificationDisplay {
  invocationId: string
  verdict: VerificationDisplayVerdict
  method: string
  observedAt: number
}

export interface VerificationObservedEvent extends Base {
  type: "verification.observed"
  toolCallId: string
  invocationId: string
  verdict: VerificationDisplayVerdict
  method: string
  observedAt: number
  /** Forward anak: taut ke delegate_task pemanggil (absen = observasi sesi biasa). */
  parentLink?: ChildSessionLink
}

/**
 * F-CTRL-1/F-CTRL-2: keputusan consequence terstruktur (ACE) — BUKAN string
 * stderr. Diterjemahkan dari `ConsequenceDecision` di policy ke literal display
 * yang stabil. `newEvidenceSinceLastAttempt` membawa alasan "VERIFYING / Tamper
 * Guard" yang tadinya hanya terlihat di stderr.
 */
export interface ConsequenceDecidedEvent extends Base {
  type: "consequence.decided"
  verdict: ConsequenceVerdict
  failureClass: ConsequenceFailureClass
  nextAction: ConsequenceNextAction
  rationale: string
  /** Bukti baru sejak percobaan terakhir (F-CTRL-2); absen = tidak dilacak. */
  newEvidenceSinceLastAttempt?: boolean
}

/**
 * F-CTX-1: meter jendela konteks live — NON-durable (tidak pernah dipersist),
 * hanya untuk footer/machine. `percent` dihitung pemanggil dari angka nyata;
 * `costUsd`/`providerModel` opsional karena pricing model bisa tak dikenal.
 */
export interface ContextWindowEvent extends Base {
  type: "context.window"
  usedTokens: number
  windowTokens: number
  /** 0–100 (boleh desimal); absen = tidak dapat dihitung (window tak dikenal). */
  percent?: number
  costUsd?: number
  providerModel?: string
}

/**
 * F-CTX-2: pemotongan mi-stream dari `watchContextWindowLimit`/`watchBudgetLimit`
 * yang DURABLE — masuk transkrip, bukan hanya stderr, agar operator tahu persis
 * di mana stream dipangkas saat replay.
 */
export interface ContextCutoffEvent extends Base {
  type: "context.cutoff"
  reason: string
  usedTokens?: number
  windowTokens?: number
}

/**
 * F-TASK-1: transisi status task kanonik (`t<n>`) + DAG (parent/dependsOn).
 * Id/status dibawa apa adanya dari TaskStore; renderer hanya menampilkan.
 */
export interface TaskStatusEvent extends Base {
  type: "task.status"
  taskId: string
  status: TaskStatusDisplay
  parentId?: string
  dependsOn?: string[]
  revision?: number
  /**
   * P1.5: bukti verifikasi yang menempel pada task. `COMPLETED` tanpa
   * `verdict=passed` BUKAN "PASS" — UI wajib menandainya unverified.
   */
  verification?: { verdict: "passed" | "failed" | "unverified"; checkedAt: string }
}

export type DomainEvent =
  | UserMessageEvent
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
  | PlanUpdatedEvent
  | FindingDetectedEvent
  | ResultProducedEvent
  | DiagnosticRaisedEvent
  | CheckpointCreatedEvent
  | VerificationObservedEvent
  | ConsequenceDecidedEvent
  | ContextWindowEvent
  | ContextCutoffEvent
  | TaskStatusEvent

export type DomainEventType = DomainEvent["type"]

export const PROPOSED_EVENT_TYPES = ["tool.progress"] as const satisfies readonly DomainEventType[]

/** Kebijakan durable vs live (§7 V2.1): restart merekonstruksi tanpa delta. */
export const DURABILITY: Record<DomainEventType, { durable: boolean; replayable: boolean }> = {
  "user.message": { durable: true, replayable: true },
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
  "plan.updated": { durable: true, replayable: true },
  "finding.detected": { durable: true, replayable: true },
  "result.produced": { durable: true, replayable: true },
  "diagnostic.raised": { durable: true, replayable: true },
  "checkpoint.created": { durable: true, replayable: true },
  "verification.observed": { durable: true, replayable: true },
  "consequence.decided": { durable: true, replayable: true },
  "context.window": { durable: false, replayable: false },
  "context.cutoff": { durable: true, replayable: true },
  "task.status": { durable: true, replayable: true },
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
      /** F-APPROVAL-1: tier risiko efek samping (dihitung pemanggil dari kontrak). */
      riskTier?: SideEffectTierDisplay
      /** F-APPROVAL-1: pratinjau diff ringkas (sudah di-scrub secret). */
      diffPreview?: string
    }
  | {
      kind: "settled"
      approvalId: string
      call: ApprovalPromptCall
      outcome: ApprovalOutcome
    }

export type ApprovalEventHook = (e: ApprovalHookEvent) => void
