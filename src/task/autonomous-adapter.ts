// PHASE 6R — SCHEDULER ADAPTER.
//
// The Scheduler already takes an injected `runTurn`. This module supplies a
// `runTurn` that executes in an AUTONOMOUS EXECUTION CONTEXT rather than in the
// user's conversation, and it is the ONLY place the two meet.
//
// [DESIGN DECISION] Nothing here constructs a `Scheduler` and nothing here is
// called from production startup. The adapter is a plain factory a composition
// root would inject; building it does not make the Scheduler reachable, and the
// production construction count stays 0.
//
// [DESIGN DECISION] The mapping from a dispatched work item to a context is
// TOTAL and EXPLICIT — every field the context needs is present on the work item
// or the config, and none is guessed. `buildAutonomousRunTurn` refuses to run
// when a required input is missing rather than substituting a default, because a
// default here would mean an executor running in the wrong workspace or against
// the wrong generation.

import {
  type AutonomousContextConfig,
  type AutonomousContextEvent,
  AutonomousExecutionContext,
  type AutonomousSession,
  type AutonomousSessionSpec,
  type AutonomousTurnResult,
  assertAutonomousToolScope,
} from "./autonomous-context.ts"
import type { ExecutionObservation, SchedulerWorkItem } from "./scheduler.ts"
import type { TaskStore } from "./store.ts"

/** The durable facts a Scheduler execution carries, read at claim time. */
export interface AutonomousExecutionBinding {
  readonly parentSessionId: string
  readonly taskId: string
  readonly execGeneration: number
  readonly sessionIncarnation: number
}

export interface AutonomousAdapterConfig {
  readonly store: TaskStore
  readonly sessionFactory: (spec: AutonomousSessionSpec) => Promise<AutonomousSession>
  readonly tools: readonly { name: string }[]
  readonly provider?: unknown
  readonly model?: string
  readonly maxSteps?: number
  readonly timeoutMs?: number
  /** [DESIGN DECISION] REQUIRED. Never defaulted to `process.cwd()`. */
  readonly cwdFor: (sessionId: string) => string
  readonly onContextEvent?: (event: AutonomousContextEvent) => void
}

/**
 * [PHASE 6R] Map a Scheduler's own lifecycle result onto the autonomous contract.
 *
 * The Scheduler's `ExecutionObservation` has exactly two shapes, so this mapping
 * is small; the value is that it is EXPLICIT and total rather than an inline
 * ternary, and that it never claims more than it knows.
 *
 * [DESIGN DECISION] `ok` is an observation, never a verdict: a returned turn is
 * not a completed task, and this function must not blur that. The Scheduler's
 * lineage/ownership machinery (6P/6Q) does the actual recording.
 */
export function toExecutionObservation(result: AutonomousTurnResult): ExecutionObservation {
  if (result.outcome === "returned") {
    return { kind: "returned", ok: result.ok, detail: result.finalText ?? undefined }
  }
  return { kind: "rejected", detail: `${result.outcome}: ${result.detail ?? "no detail"}` }
}

/**
 * [PHASE 6R] The context for one dispatched work item, or a refusal.
 *
 * Exported separately so a composition root (or a test) can inspect exactly what
 * an execution WOULD look like without running one.
 */
export function planAutonomousContext(
  work: SchedulerWorkItem,
  binding: AutonomousExecutionBinding,
  config: AutonomousAdapterConfig,
): AutonomousContextConfig {
  const missing: string[] = []
  if (!binding.parentSessionId) missing.push("parentSessionId")
  if (!binding.taskId) missing.push("taskId")
  if (!Number.isSafeInteger(binding.execGeneration) || binding.execGeneration < 1) {
    missing.push("execGeneration")
  }
  if (!Number.isSafeInteger(binding.sessionIncarnation) || binding.sessionIncarnation < 1) {
    missing.push("sessionIncarnation")
  }
  if (!config.cwdFor) missing.push("cwdFor")
  if (missing.length > 0) {
    throw new Error(
      `autonomous adapter refused to plan an execution; missing durable binding: ${missing.join(", ")}`,
    )
  }
  return {
    parentSessionId: binding.parentSessionId,
    taskId: binding.taskId,
    taskTitle: work.title,
    instruction: work.instruction,
    execGeneration: binding.execGeneration,
    sessionIncarnation: binding.sessionIncarnation,
    cwd: config.cwdFor(binding.parentSessionId),
    ...(config.model ? { model: config.model } : {}),
    ...(config.maxSteps ? { maxSteps: config.maxSteps } : {}),
    ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
    sessionFactory: config.sessionFactory,
    tools: config.tools,
    ...(config.onContextEvent ? { onEvent: config.onContextEvent } : {}),
  }
}

/**
 * [PHASE 6R] Build the `runTurn` the Scheduler will call.
 *
 * The returned function is a `RunTurn`: it receives a `SchedulerWorkItem`,
 * executes it in a private child context, and returns an observation. It holds
 * NO Scheduler state and creates NO global state, so several adapters can exist
 * at once without interfering.
 */
export function buildAutonomousRunTurn(
  bindingFor: (taskId: string) => AutonomousExecutionBinding,
  config: AutonomousAdapterConfig,
): (work: SchedulerWorkItem) => Promise<ExecutionObservation> {
  // Fail at ADAPTER construction, not on first dispatch: a wider tool set is a
  // configuration error and should never reach the point of granting an
  // unattended executor write access.
  assertAutonomousToolScope(config.tools.map((t) => t.name))

  return async (work: SchedulerWorkItem): Promise<ExecutionObservation> => {
    // [DESIGN DECISION] A refusal to plan is allowed to THROW. The Scheduler
    // treats a synchronous throw from the bridge as a DISPATCH failure and
    // releases the claim, which is correct: an execution that was never planned
    // must not be recorded as an attempt that happened.
    const context = new AutonomousExecutionContext(
      planAutonomousContext(work, bindingFor(work.taskId), config),
    )
    try {
      const result = await context.execute()
      return toExecutionObservation(result)
    } finally {
      // The context owns the child session, the AbortController and the provider
      // resources. Disposal is unconditional and idempotent, so no path can leak
      // them - including the error path.
      context.dispose()
    }
  }
}

/** Exported for symmetry: the concrete context type the adapter produces. */
export type { AutonomousExecutionContext }
