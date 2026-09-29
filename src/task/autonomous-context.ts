// PHASE 6R — AUTONOMOUS EXECUTION CONTEXT.
//
// 6N F5/§7 established the problem: the production kernel's turn is a WHOLE
// CONVERSATION MERGE behind a single running slot, with a session-global abort.
// An autonomous turn cannot reuse the user's session: it would merge into the
// user's conversation, contend for one busy slot, share one abort channel, and
// emit into the interactive presentation stream at a moment the user did not ask
// for.
//
// 6O ADR-1 selected Model B: a PRIVATE CHILD SESSION per dispatched work item.
// This module is that boundary, and nothing else.
//
// THE CENTRAL SEPARATION — read this twice, it is the whole design:
//
//   TASK namespace      = the PARENT session. The task being executed IS a row
//                         in the parent's namespace, and the lineage/ownership
//                         facts (6P) and incarnation guard (6Q) are all expressed
//                         in terms of that namespace. Moving it would relocate the
//                         task and break every invariant 6P/6Q established.
//   CONVERSATION namespace = a CHILD session id. History, busy slot, abort
//                         controller, event bus and counters all belong to it, so
//                         the autonomous turn shares NONE of them with the user.
//
// A context that conflated the two would either pollute the user's conversation
// or lose track of which task it is executing. They are deliberately different
// namespaces and the type system names them differently.
//
// [DESIGN DECISION] This module holds NO global/singleton state. A context is
// constructed with everything it needs (DI), so isolation cannot depend on
// module-level configuration that another call could mutate.

import type { TaskStore } from "./store.ts"

// ── identity ─────────────────────────────────────────────────────────────────

/**
 * [PHASE 6R] The deterministic conversation-session id of one autonomous
 * execution.
 *
 * It is derived from (parent, task, generation) so it is reproducible from
 * durable facts alone — no registry, no allocation, nothing to leak.
 *
 * [DESIGN DECISION] The shape is deliberately one an INTERACTIVE session id can
 * never have. Production session ids are 8 hex characters
 * (`cli/commands/acp.ts:334` -> `randomUUID().slice(0, 8)`); this contains a
 * `~` and a `#` and is far longer, so an autonomous context can never be
 * confused with — or collide with — a user's session. `isAutonomousSessionId`
 * is the recogniser, and `assertNotAutonomousSessionId` is used on every
 * interactive entry point that must refuse an autonomous id.
 */
export function autonomousSessionId(
  parentSessionId: string,
  taskId: string,
  execGeneration: number,
): string {
  return `auto~${parentSessionId}~${taskId}~${execGeneration}`
}

/** True for an id produced by `autonomousSessionId`. */
export function isAutonomousSessionId(sessionId: string): boolean {
  return sessionId.startsWith("auto~") && sessionId.split("~").length === 4
}

/** Parse an autonomous id back into its parts, or null if it is not one. */
export function parseAutonomousSessionId(
  sessionId: string,
): { parentSessionId: string; taskId: string; execGeneration: number } | null {
  if (!isAutonomousSessionId(sessionId)) return null
  const parts = sessionId.split("~")
  const [, parentSessionId, taskId, gen] = parts
  const n = Number(gen)
  if (parentSessionId === undefined || taskId === undefined) return null
  if (!Number.isSafeInteger(n) || n < 1) return null
  return { parentSessionId, taskId, execGeneration: n }
}

// ── tool scope ───────────────────────────────────────────────────────────────

/**
 * [PHASE 6R][DESIGN DECISION] The ONLY tool set an autonomous context may hold.
 *
 * 6O ADR-7 selected this, and the reason is recorded in the source it came from:
 * `src/tools/task.ts:170-172` — *"satu approval delegate_task menjadi N aksi
 * tak-disetujui"*. One approval becoming N unapproved actions.
 *
 * An autonomous executor is strictly MORE dangerous than a sub-agent, because no
 * human is watching its approvals, and the kernel has no `DEFER` decision
 * (`vendor/minicore/src/core/permission.ts:12` returns only `allow` | `deny`, and
 * a handler needing approval is expected to BLOCK until it resolves). An
 * unattended turn that could write would therefore be either blocked forever or
 * auto-approved. Restricting the tool set means the question never arises.
 *
 * This is a subset of `EXPLORE_TOOL_NAMES` (read/search/reason), which is the
 * same scope `delegate_task` forces for a `plan`/`readonly`/`ask` parent.
 */
export const AUTONOMOUS_TOOL_NAMES: readonly string[] = [
  "read_file",
  "glob",
  "grep",
  "read_memory",
  "todo_read",
  "git_status",
  "git_log",
  "lsp_diagnostics",
  "lsp_definition",
  "lsp_hover",
  "lsp_workspace_symbols",
  "mcp_list",
]

/** Tools an autonomous context may never hold, named explicitly for diagnosis. */
export const FORBIDDEN_AUTONOMOUS_TOOLS: readonly string[] = [
  "write_file",
  "edit_file",
  "bash",
  "bash_output",
  "bash_kill",
  "git_commit",
  "git_apply",
  "todo_write",
  "delegate_task",
  "submit_result",
  "ask_user",
  "write_memory",
  "forget_memory",
  "mcp_call",
]

/**
 * [PHASE 6R] Structural enforcement of the autonomous tool scope.
 *
 * Throws when a tool outside `AUTONOMOUS_TOOL_NAMES` is present. This is a
 * GATE, not advice: a composition root that wires a wider tool set fails at
 * context construction rather than silently granting an unattended executor
 * shell, filesystem writes, or the ability to mutate its own task list.
 *
 * The allow-list is what is enforced. `FORBIDDEN_AUTONOMOUS_TOOLS` is diagnostic
 * only — it names the interesting cases so the error message is useful, and so a
 * test can assert on intent.
 */
export function assertAutonomousToolScope(toolNames: readonly string[]): void {
  const allowed = new Set(AUTONOMOUS_TOOL_NAMES)
  const forbidden = new Set(FORBIDDEN_AUTONOMOUS_TOOLS)
  const offending = toolNames.filter((n) => !allowed.has(n))
  if (offending.length === 0) return
  const named = offending.filter((n) => forbidden.has(n))
  const detail = named.length > 0 ? ` (explicitly forbidden: ${named.join(", ")})` : ""
  throw new Error(
    `autonomous execution context refused: tool scope is not read-only. Offending: ${offending.join(", ")}${detail}`,
  )
}

// ── the injected session primitive ───────────────────────────────────────────

/**
 * [PHASE 6R] The structural subset of a child session this module uses.
 *
 * Deliberately the SAME shape as `SubAgentSession` in `src/tools/task.ts`, so the
 * existing sub-agent session factory can satisfy it unchanged. [DESIGN DECISION]
 * Reusing that seam is what keeps 6R from becoming a second session system.
 */
export interface AutonomousSession {
  run(
    input: string,
    opts: { signal: AbortSignal; model?: string },
  ): Promise<{ finalText?: string; usage: { steps: number } }>
  abort(): void
  /** Present on the kernel Session (`vendor/minicore/.../session.ts:278`). */
  cleanup?(): void
}

export interface AutonomousSessionSpec {
  readonly provider: unknown
  readonly tools: readonly { name: string }[]
  readonly cwd: string
  readonly permissionMode: "readonly"
  readonly maxSteps: number
  readonly timeoutMs: number
  readonly systemExtra: string
  /** The CHILD session id. Metadata only — never the parent. */
  readonly sessionId: string
  readonly parentSessionId: string
  readonly model?: string
}

// ── outcomes ─────────────────────────────────────────────────────────────────

/**
 * [PHASE 6R][DESIGN DECISION] The autonomous turn contract.
 *
 * 6N §7 required that normal/error/cancellation be DISTINCT rather than collapsed
 * into one generic exception, so a caller can tell "the model failed" from "the
 * user pressed stop" from "the session I belonged to is gone". `cancelled` and
 * `session-superseded` in particular must not be mistaken for a work failure:
 * neither is evidence that the task was not done.
 */
export type AutonomousOutcome =
  | "returned"
  | "error"
  | "cancelled"
  | "session-superseded"
  | "task-superseded"
  | "permission-denied"

export interface AutonomousTurnResult {
  readonly outcome: AutonomousOutcome
  readonly ok: boolean
  readonly detail?: string
  readonly finalText?: string
  readonly steps: number
  /** The child session this ran in, for attribution and diagnosis. */
  readonly childSessionId: string
}

export type AutonomousContextState =
  | "created"
  | "initializing"
  | "ready"
  | "executing"
  | "settled"
  | "disposed"

// ── the context ──────────────────────────────────────────────────────────────

export interface AutonomousContextConfig {
  /** The session that OWNS the task. Task namespace == this session. */
  readonly parentSessionId: string
  readonly taskId: string
  readonly taskTitle: string
  readonly instruction: string
  /** The generation the Scheduler claimed; part of the child identity. */
  readonly execGeneration: number
  /** [6Q] The parent incarnation the claim was made under. */
  readonly sessionIncarnation: number
  /**
   * The workspace the task belongs to. [DESIGN DECISION] REQUIRED, never
   * defaulted to `process.cwd()`: 6R §11 requires the autonomous execution to
   * run deterministically in the task's workspace, and a silent fallback is how
   * an executor ends up reading or writing the wrong project.
   */
  readonly cwd: string
  readonly model?: string
  readonly maxSteps?: number
  readonly timeoutMs?: number
  readonly provider?: unknown
  /**
   * Child-session factory (DI). In production this is `createMinicodeSession`;
   * in tests it is a fake. [DESIGN DECISION] No default: a context must never
   * construct a real provider chain implicitly.
   */
  readonly sessionFactory: (spec: AutonomousSessionSpec) => Promise<AutonomousSession>
  readonly tools: readonly { name: string }[]
  readonly onEvent?: (event: AutonomousContextEvent) => void
}

export type AutonomousContextEvent =
  | { readonly kind: "context:created"; readonly childSessionId: string }
  | { readonly kind: "context:ready"; readonly childSessionId: string }
  | { readonly kind: "turn:started"; readonly childSessionId: string }
  | {
      readonly kind: "turn:settled"
      readonly childSessionId: string
      readonly outcome: AutonomousOutcome
    }
  | { readonly kind: "context:disposed"; readonly childSessionId: string }

export class AutonomousContextError extends Error {
  readonly reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.name = "AutonomousContextError"
    this.reason = reason
  }
}

/**
 * [PHASE 6R] One autonomous execution: a private child conversation session
 * bound to exactly one claimed task of one parent session.
 *
 * LIFECYCLE: create -> initialize -> execute -> settled -> dispose. Every
 * terminal path lands in `dispose`, and `dispose` is idempotent, so no execution
 * can leave a listener, an AbortController, or a provider resource behind.
 */
export class AutonomousExecutionContext {
  readonly childSessionId: string
  readonly parentSessionId: string
  readonly taskId: string
  readonly execGeneration: number
  readonly sessionIncarnation: number
  readonly cwd: string

  private readonly config: AutonomousContextConfig
  private state: AutonomousContextState = "created"
  private session: AutonomousSession | null = null
  /**
   * [DESIGN DECISION] Its OWN AbortController. The parent's abort is never wired
   * in and this one is never exposed, so cancelling a user turn cannot cancel an
   * autonomous execution and vice versa. Cancellation of THIS context only.
   */
  private readonly abort: AbortController = new AbortController()
  private cancelRequested = false

  constructor(config: AutonomousContextConfig) {
    // [DESIGN DECISION] Identity is derived, never supplied, so two contexts for
    // the same work are literally the same identity and cannot silently diverge.
    this.childSessionId = autonomousSessionId(
      config.parentSessionId,
      config.taskId,
      config.execGeneration,
    )
    this.parentSessionId = config.parentSessionId
    this.taskId = config.taskId
    this.execGeneration = config.execGeneration
    this.sessionIncarnation = config.sessionIncarnation
    this.cwd = config.cwd
    this.config = config
  }

  getState(): AutonomousContextState {
    return this.state
  }

  getSession(): AutonomousSession | null {
    return this.session
  }

  private emit(event: AutonomousContextEvent): void {
    try {
      this.config.onEvent?.(event)
    } catch {
      // An observer may never fail an execution - same rule as Scheduler.emit.
    }
  }

  /**
   * Build the child session.
   *
   * [DESIGN DECISION] The tool scope is checked HERE, at construction, so a
   * misconfigured factory cannot hand an unattended executor a writable tool set
   * even for one turn.
   */
  async initialize(): Promise<void> {
    if (this.state !== "created") {
      throw new AutonomousContextError("lifecycle", `cannot initialize from ${this.state}`)
    }
    this.state = "initializing"
    assertAutonomousToolScope(this.config.tools.map((t) => t.name))
    this.emit({ kind: "context:created", childSessionId: this.childSessionId })

    this.session = await this.config.sessionFactory({
      provider: this.config.provider,
      tools: this.config.tools,
      cwd: this.cwd,
      // [DESIGN DECISION] `readonly` is fixed, not inherited. An autonomous
      // executor never receives the user's live permission mode: a human
      // widening or narrowing interactive permissions mid-session must not
      // silently change what an unattended executor may do.
      permissionMode: "readonly",
      maxSteps: this.config.maxSteps ?? 8,
      timeoutMs: this.config.timeoutMs ?? 120_000,
      systemExtra: this.systemExtra(),
      sessionId: this.childSessionId,
      parentSessionId: this.parentSessionId,
      ...(this.config.model ? { model: this.config.model } : {}),
    })
    this.state = "ready"
    this.emit({ kind: "context:ready", childSessionId: this.childSessionId })
  }

  /**
   * [PHASE 6R] The minimum sufficient context for the turn.
   *
   * [DESIGN DECISION] It contains the TASK and the workspace - never the user's
   * conversation. The user's history is not loaded, not summarised and not
   * referenced: a background worker has no use for it, and copying it is exactly
   * how an autonomous run ends up conditioned on an unrelated request. The
   * child's own `ContextStore` starts empty, so "child session" genuinely means
   * an empty conversation rather than a shared one.
   */
  private systemExtra(): string {
    return [
      "You are an AUTONOMOUS execution context, not an interactive assistant.",
      "No user is watching this turn. There is no one to answer a question, so " +
        "never call ask_user; state what you need in your final message instead.",
      "You have read-only tools. Do not attempt to modify files, run commands, " +
        "or change any task: you cannot, and trying is a failed run.",
      `Workspace: ${this.cwd}`,
      `Task: ${this.config.taskTitle}`,
      `Task instruction: ${this.config.instruction}`,
    ].join("\n")
  }

  /**
   * Run the autonomous turn.
   *
   * [DESIGN DECISION] Every outcome is a RETURN VALUE, including cancellation
   * and supersession. An unattended executor has no one to throw to, so a throw
   * here would either kill the process or be swallowed into a false "the model
   * failed".
   */
  async execute(): Promise<AutonomousTurnResult> {
    if (this.state === "disposed") {
      throw new AutonomousContextError("lifecycle", "context is disposed")
    }
    if (this.session === null) await this.initialize()
    const session = this.session!
    this.state = "executing"
    this.emit({ kind: "turn:started", childSessionId: this.childSessionId })

    const settle = (r: AutonomousTurnResult): AutonomousTurnResult => {
      this.state = "settled"
      this.emit({ kind: "turn:settled", childSessionId: this.childSessionId, outcome: r.outcome })
      return r
    }

    // A cancellation requested before the turn began is honoured, not raced.
    if (this.cancelRequested || this.abort.signal.aborted) {
      return settle({
        outcome: "cancelled",
        ok: false,
        detail: "cancelled before the turn started",
        steps: 0,
        childSessionId: this.childSessionId,
      })
    }

    this.emit({ kind: "turn:started", childSessionId: this.childSessionId })
    try {
      const res = await session.run(this.config.instruction, {
        signal: this.abort.signal,
        ...(this.config.model ? { model: this.config.model } : {}),
      })
      // A run that resolves after our own cancellation is a CANCELLED turn, not a
      // successful one: the abort may have been observed late.
      if (this.cancelRequested || this.abort.signal.aborted) {
        return settle({
          outcome: "cancelled",
          ok: false,
          detail: "cancelled during the turn",
          steps: res.usage?.steps ?? 0,
          childSessionId: this.childSessionId,
        })
      }
      return settle({
        outcome: "returned",
        ok: true,
        ...(res.finalText === undefined ? {} : { finalText: res.finalText }),
        steps: res.usage?.steps ?? 0,
        childSessionId: this.childSessionId,
      })
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      if (this.cancelRequested || this.abort.signal.aborted) {
        return settle({
          outcome: "cancelled",
          ok: false,
          detail,
          steps: 0,
          childSessionId: this.childSessionId,
        })
      }
      // The kernel reports contention as a `busy` AgentError. In an autonomous
      // context that means THIS child was already running, which is a lifecycle
      // fault rather than a work failure, and must stay distinguishable.
      if (/already running|\bbusy\b/i.test(detail)) {
        return settle({
          outcome: "error",
          ok: false,
          detail,
          steps: 0,
          childSessionId: this.childSessionId,
        })
      }
      return settle({
        outcome: "error",
        ok: false,
        detail,
        steps: 0,
        childSessionId: this.childSessionId,
      })
    }
  }

  /**
   * Cancel THIS execution only.
   *
   * [DESIGN DECISION] Aborts the context's own controller AND the child session's
   * own abort, so both the in-flight turn and any later `run()` on the child see
   * the cancellation. It cannot reach the parent: nothing here holds a reference
   * to the parent's session or abort.
   */
  cancel(_reason = "cancelled"): void {
    if (this.state === "disposed") return
    this.cancelRequested = true
    if (!this.abort.signal.aborted) this.abort.abort(new Error("autonomous execution cancelled"))
    try {
      this.session?.abort()
    } catch {
      // Aborting a session that already ended is not an error worth propagating.
    }
  }

  get isCancelled(): boolean {
    return this.cancelRequested || this.abort.signal.aborted
  }

  /**
   * Release everything this context owns.
   *
   * Idempotent, and safe to call from any state including mid-turn: the abort is
   * fired first so an in-flight turn stops, then the child's provider resources
   * are released through the kernel's own `cleanup()`.
   */
  dispose(): void {
    if (this.state === "disposed") return
    if (!this.abort.signal.aborted) {
      this.abort.abort(new Error("autonomous context disposed"))
    }
    const session = this.session
    this.session = null
    // [6R] The child's OWN abort as well as ours. `run()` joins them, so aborting
    // ours is enough to stop the in-flight turn - but only the child's abort marks
    // the KERNEL session as aborted, which is what makes a disposed child
    // unusable for any later `run()`. Disposal that leaves the child runnable
    // would make "disposed" a claim rather than a fact.
    try {
      session?.abort()
    } catch {
      // Aborting a session that already ended is not an error worth propagating.
    }
    try {
      session?.cleanup?.()
    } catch {
      // Cleanup must never throw out of dispose: a disposal path that can fail is
      // a disposal path that leaks.
    }
    this.state = "disposed"
    this.emit({ kind: "context:disposed", childSessionId: this.childSessionId })
  }
}

// ── identity verification ────────────────────────────────────────────────────

/**
 * [PHASE 6R] Fail closed when a context does not belong to the session it claims.
 *
 * Used on every path where a context is handed a session id, so a mismatched or
 * replayed context cannot execute against the wrong namespace. [DESIGN DECISION]
 * A durable check rather than an assertion: this is the boundary where a wrong
 * answer would let an executor read or write another session's tasks.
 */
export function assertContextBelongsTo(
  context: AutonomousExecutionContext,
  sessionId: string,
  expectedIncarnation: number,
): void {
  if (context.parentSessionId !== sessionId) {
    throw new AutonomousContextError(
      "identity",
      `context belongs to session ${context.parentSessionId}, not ${sessionId}`,
    )
  }
  if (context.sessionIncarnation !== expectedIncarnation) {
    throw new AutonomousContextError(
      "identity",
      `context was created under incarnation ${context.sessionIncarnation}, current is ${expectedIncarnation}`,
    )
  }
  if (!isAutonomousSessionId(context.childSessionId)) {
    throw new AutonomousContextError(
      "identity",
      `child session id is not an autonomous id: ${context.childSessionId}`,
    )
  }
}

export type { TaskStore }
