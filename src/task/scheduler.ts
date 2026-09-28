// Phase 6C — Scheduler core: headless, dependency-injected, single-session,
// serial. NEW ARCHITECTURE.
//
// Implements the Phase 6A design lock. NOT wired into production: nothing in
// src/ constructs a Scheduler, and this module imports nothing that could.
//
// ── WHAT IT IS ───────────────────────────────────────────────────────────────
//
// Three questions have three owners, kept strictly apart:
//
//   TaskGraph  "what is executable right now, and why?"   (read-only)
//   Scheduler  "what do we attempt next, and under what lifecycle/recovery rules?"
//   TaskStore  "what is durably true?"                      (sole writer)
//
// ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
//
//   * no SQLite, no bun:sqlite, no TaskStore internals
//   * no readiness reimplementation — `readyTasks()` is consumed verbatim
//   * no graph semantics, no dependency derivation, no blocker inference
//   * never writes COMPLETED, never verifies, never manufactures evidence
//   * never calls parallelExecutor, tools, providers or permissions
//   * no retry policy, no lease, no heartbeat, no priority, no fairness
//   * no message-history or transcript reads for task truth
//   * presentation_events is never an input
//
// ── SHAPE PROVENANCE ─────────────────────────────────────────────────────────
//
// HISTORICAL DESIGN EVIDENCE (recovered `p77-repro.ts` call sites) justifies the
// SHAPE only: `new Scheduler(sessionId, { store, runTurn, instruction })`,
// `discover()`, `getActiveClaim()`. Those are signatures a test once used. They
// are not evidence of any behaviour, and none is inferred from them.
//
// NOT adopted, having no evidence anywhere: `canExecute`, `blockingDeps`,
// `topological`, `sourceRevision`. Those names appeared in a brief and were
// never found in any artifact; 5A recorded them as unsourced.
//
// ── V1 DEPLOYMENT INVARIANT ──────────────────────────────────────────────────
//
// A session must not be concurrently driven by independent Scheduler instances
// across OS processes. Session ownership is process-local (Phase 6B) and cannot
// see another OS process, so this module does not pretend to prevent it. It
// prevents concurrent ownership *within* a process, and refuses to act when
// ownership is uncertain.

import { TaskGraph } from "./graph.ts"
import type { ClaimOutcome, TaskSnapshot } from "./model.ts"
import type { SessionOwner } from "./session-ownership.ts"
import {
  acquireSessionOwnership,
  ownsSession,
  releaseSessionOwnership,
} from "./session-ownership.ts"
import type { TaskStore } from "./store.ts"

// ── lifecycle ────────────────────────────────────────────────────────────────

export type SchedulerState = "CREATED" | "RUNNING" | "IDLE" | "STOPPING" | "STOPPED"

/** Why a cycle ended. Never inferred from events. */
export type CycleStop =
  | "no-candidates"
  | "invalid-graph"
  | "claim-rejected-stale"
  | "claim-not-found"
  | "claim-wrong-state"
  | "ownership-unavailable"
  | "already-dispatched"
  | "not-running"

/** Why a work item could not be handed to the agent loop. */
export type DispatchFailure = "scheduler-not-running" | "bridge-threw" | "bridge-not-callable"

export type ExecutionObservation =
  /** The turn returned. `ok` is an OBSERVATION, not a verdict on the work. */
  | { readonly kind: "returned"; readonly ok: boolean; readonly detail?: string }
  /** The turn threw or rejected. The attempt WAS established. */
  | { readonly kind: "rejected"; readonly detail: string }

/**
 * The work item handed to the agent loop.
 *
 * Contains exactly the three locked fields, and nothing derived from message
 * history: the composition root decides how to run it.
 */
export interface SchedulerWorkItem {
  readonly taskId: string
  readonly title: string
  readonly instruction: string
  readonly sessionId: string
}

/**
 * The injected execution bridge. Scheduler authorizes; this runs.
 *
 * A `dispatch-failed` (a synchronous throw before the promise exists) means the
 * attempt was never established, which is materially different from a rejected
 * turn. Scheduler must not fake that distinction with an invented flag — it is
 * derived from whether the call returned a promise at all.
 */
export type RunTurn = (
  work: SchedulerWorkItem,
) => Promise<ExecutionObservation> | ExecutionObservation

/**
 * Observations. Strictly one-way: they are emitted, never consumed. Scheduler
 * state is never reconstructed from them.
 */
export type SchedulerEvent =
  | { readonly kind: "task:recovered"; readonly taskIds: readonly string[] }
  | { readonly kind: "task:selected"; readonly taskId: string }
  | { readonly kind: "task:claimed"; readonly taskId: string; readonly revision: number }
  | {
      readonly kind: "task:claim_rejected"
      readonly taskId: string
      readonly outcome: ClaimOutcome
    }
  | { readonly kind: "task:dispatch_started"; readonly taskId: string }
  | { readonly kind: "task:execution_started"; readonly taskId: string }
  | { readonly kind: "task:execution_completed"; readonly taskId: string; readonly ok: boolean }
  | { readonly kind: "cycle:invalid_graph" }
  | { readonly kind: "cycle:stopped"; readonly reason: CycleStop }

export interface SchedulerOptions {
  readonly store: TaskStore
  readonly runTurn: RunTurn
  /** The instruction template handed to the agent loop with every work item. */
  readonly instruction: string
  /** Optional observation sink. Absence means events are dropped, not queued. */
  readonly onEvent?: (event: SchedulerEvent) => void
  /** Optional cancellation the composition root owns. Scheduler never invents one. */
  readonly cancellation?: { readonly isCancelled: () => boolean }
}

export interface ActiveClaim {
  readonly taskId: string
  /**
   * The revision AFTER the accepted claim. Never the pre-claim revision, never
   * the graph's revision, never a timestamp, never `sourceMaxRevision` — a
   * release must address the state the claim actually produced.
   */
  readonly claimRevision: number
}

export class SchedulerError extends Error {
  readonly reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.name = "SchedulerError"
    this.reason = reason
  }
}

export class Scheduler {
  readonly sessionId: string

  private readonly store: TaskStore
  private readonly runTurn: RunTurn
  private readonly instruction: string
  private readonly onEvent: ((e: SchedulerEvent) => void) | undefined
  private readonly cancellation: { readonly isCancelled: () => boolean } | undefined

  private state: SchedulerState = "CREATED"
  private owner: SessionOwner | null = null
  private claim: ActiveClaim | null = null

  /**
   * V1 is SERIAL. A cycle in progress makes any further call wait for it, which
   * is why N concurrent `cycle()` calls can never produce two dispatches. This
   * is the Scheduler serializing ITSELF — TaskStore is not asked to do it.
   */
  private inFlight: Promise<CycleResult> | null = null

  constructor(sessionId: string, opts: SchedulerOptions) {
    this.sessionId = sessionId
    this.store = opts.store
    this.runTurn = opts.runTurn
    this.instruction = opts.instruction
    this.onEvent = opts.onEvent
    this.cancellation = opts.cancellation
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  getLifecycle(): SchedulerState {
    return this.state
  }

  /**
   * Acquire session ownership, then begin scheduling.
   *
   * Idempotent while running. Refused after STOPPED: a stopped Scheduler never
   * begins new work, and a silent no-op would make a dead subsystem look alive.
   *
   * Fails closed when ownership is unavailable — a competing in-process owner
   * blocks this instance rather than being worked around.
   */
  start(): void {
    if (this.state === "STOPPED") {
      throw new SchedulerError("stopped", "scheduler is STOPPED and cannot be restarted")
    }
    if (this.state === "RUNNING" || this.state === "IDLE") return

    if (this.owner === null) {
      const owner = acquireSessionOwnership(this.sessionId, "scheduler")
      if (owner === null) {
        // Another owner exists in this process. Fail closed; do not guess.
        this.state = "STOPPED"
        throw new SchedulerError(
          "ownership-unavailable",
          `session ${this.sessionId} is already owned in this process`,
        )
      }
      this.owner = owner
    }
    this.state = "RUNNING"
  }

  /**
   * Prevent future dispatch. Does NOT cancel tasks, does NOT delete, does NOT
   * silently release an in-flight claim, and writes no durable state merely
   * because stopping happened. Safe to call repeatedly.
   *
   * STOPPED is not CANCELLED. A claimed task stays IN_PROGRESS until some
   * legitimate transition (a verifier, an operator, or a later reconciliation by
   * an owner) moves it.
   */
  async stop(): Promise<void> {
    if (this.state === "STOPPED" || this.state === "STOPPING") return
    this.state = "STOPPING"
    // Let an in-flight cycle finish so a dispatch is never half-abandoned.
    if (this.inFlight !== null) {
      try {
        await this.inFlight
      } catch {
        // An in-flight failure is already reported through the cycle result.
      }
    }
    this.state = "STOPPED"
    if (this.owner !== null) {
      releaseSessionOwnership(this.sessionId, this.owner, "stopped")
      this.owner = null
    }
  }

  getActiveClaim(): ActiveClaim | null {
    return this.claim
  }

  // ── the cycle ──────────────────────────────────────────────────────────────

  /**
   * One cycle. Serialized: concurrent callers join the in-flight cycle rather
   * than starting a second one.
   */
  async cycle(): Promise<CycleResult> {
    if (this.inFlight !== null) {
      // Join the running cycle. This is the whole of V1 concurrency control.
      return this.inFlight
    }
    const run = this.runCycle().finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private async runCycle(): Promise<CycleResult> {
    if (this.state !== "RUNNING" && this.state !== "IDLE") {
      return { stop: "not-running", dispatched: null, recovered: [] }
    }

    // 1. Reconciliation first, so a cycle never plans around stranded work.
    const recovered = this.reconcile()

    // An active claim means work is already associated with this Scheduler. Do
    // not select anything else.
    if (this.claim !== null) {
      return { stop: "already-dispatched", dispatched: null, recovered }
    }

    // 2. Fresh snapshot. 3. Fresh graph. Never cached across cycles: a claim
    //    changes revision, so the graph is stale the moment it is used.
    const snapshot: TaskSnapshot = this.store.getSnapshot(this.sessionId)
    const graph = new TaskGraph(snapshot)

    // 4. An invalid graph aborts the cycle. No dispatch, no claim.
    if (!graph.validity().valid) {
      this.emit({ kind: "cycle:invalid_graph" })
      return { stop: "invalid-graph", dispatched: null, recovered }
    }

    // 5. Readiness is CONSUMED, never recomputed.
    const ready = graph.readyTasks()

    this.state = "IDLE"

    // 6. V1 selection: first candidate in TaskGraph's deterministic order.
    //    No queue, no priority, no fairness.
    const taskId = ready[0]
    if (taskId === undefined) {
      this.emit({ kind: "cycle:stopped", reason: "no-candidates" })
      return { stop: "no-candidates", dispatched: null, recovered }
    }
    this.emit({ kind: "task:selected", taskId })

    // 7. Re-read the authoritative row. The graph's view is NOT currency.
    const current = this.store.getTask(this.sessionId, taskId)
    if (current === null) {
      this.emit({ kind: "task:claim_rejected", taskId, outcome: "NOT_FOUND" })
      this.emit({ kind: "cycle:stopped", reason: "claim-not-found" })
      return { stop: "claim-not-found", dispatched: null, recovered }
    }

    // 8. Atomic, revision-guarded claim. Never retried in a loop, never slept on.
    const claimResult = this.store.claimTask(this.sessionId, taskId, current.revision)
    if (claimResult.outcome !== "CLAIM_ACCEPTED") {
      this.emit({ kind: "task:claim_rejected", taskId, outcome: claimResult.outcome })
      const stop: CycleStop =
        claimResult.outcome === "CLAIM_REJECTED_STALE"
          ? "claim-rejected-stale"
          : claimResult.outcome === "NOT_FOUND"
            ? "claim-not-found"
            : "claim-wrong-state"
      this.emit({ kind: "cycle:stopped", reason: stop })
      return { stop, dispatched: null, recovered }
    }

    // 9. Record the POST-claim revision. This is the release currency.
    const accepted = claimResult.task
    if (accepted === null) {
      // Cannot happen: a 1-row UPDATE always leaves a readable row. Treat as a
      // persistence inconsistency rather than pretending it is fine.
      throw new SchedulerError("persistence", "claim accepted but task is unreadable")
    }
    this.claim = { taskId, claimRevision: accepted.revision }
    this.emit({ kind: "task:claimed", taskId, revision: accepted.revision })

    // 10. Dispatch through the injected bridge only.
    const dispatched = await this.dispatch({
      taskId,
      title: accepted.title,
      instruction: this.instruction,
      sessionId: this.sessionId,
    })
    return {
      stop: dispatched.ok ? "already-dispatched" : "already-dispatched",
      dispatched,
      recovered,
    }
  }

  private async dispatch(work: SchedulerWorkItem): Promise<DispatchResult> {
    // An injected cancellation contract may refuse NEW work. It cannot abort an
    // in-flight agent loop — that ability is the composition root's, not ours.
    if (
      this.state === "STOPPING" ||
      this.state === "STOPPED" ||
      this.cancellation?.isCancelled() === true
    ) {
      // Stop (or cancellation) happened after the claim. The claim is NOT
      // silently released; the task stays IN_PROGRESS for a legitimate authority
      // to move. Cancelling is not releasing.
      return { ok: false, failure: "scheduler-not-running", observation: null, released: false }
    }
    this.emit({ kind: "task:dispatch_started", taskId: work.taskId })

    let produced: Promise<ExecutionObservation> | ExecutionObservation
    try {
      produced = this.runTurn(work)
    } catch (e) {
      // A. Dispatch/setup failure: the attempt was NEVER established. The claim
      //    is released back to PENDING so the task is not stranded by our own
      //    inability to start it.
      const detail = e instanceof Error ? e.message : String(e)
      this.emit({ kind: "task:execution_completed", taskId: work.taskId, ok: false })
      const released = this.releaseClaim("dispatch-failed")
      return {
        ok: false,
        failure: "bridge-threw",
        observation: { kind: "rejected", detail },
        released,
      }
    }

    if (
      !(produced instanceof Promise) &&
      typeof (produced as ExecutionObservation)?.kind !== "string"
    ) {
      const released = this.releaseClaim("dispatch-failed")
      return { ok: false, failure: "bridge-not-callable", observation: null, released }
    }

    this.emit({ kind: "task:execution_started", taskId: work.taskId })

    // B. Execution began. Its outcome is an OBSERVATION. Scheduler does not
    //    decide whether the work succeeded and never writes COMPLETED.
    let observation: ExecutionObservation
    try {
      observation = await produced
    } catch (e) {
      observation = { kind: "rejected", detail: e instanceof Error ? e.message : String(e) }
    }
    this.emit({
      kind: "task:execution_completed",
      taskId: work.taskId,
      ok: observation.kind === "returned" && observation.ok,
    })

    // The claim is released from this Scheduler's bookkeeping, but the task's
    // durable status is NOT rewritten here: a returned turn is not a verdict,
    // and the verifier owns the next transition. Clearing the local claim lets
    // a later cycle act; a later cycle re-reads authoritative state first.
    this.claim = null
    return {
      ok: observation.kind === "returned" && observation.ok,
      failure: null,
      observation,
      released: true,
    }
  }

  /**
   * Revert THIS Scheduler's own claim from IN_PROGRESS back to PENDING using the
   * POST-claim revision. Only justified for the case the design locked: the
   * claim succeeded but dispatch could not be established, so the task is
   * stranded by our own failure to start it.
   *
   * Never used because execution returned an error, because stop() was called,
   * or because verification is pending — those belong to other authorities.
   */
  private releaseClaim(why: "dispatch-failed"): boolean {
    const active = this.claim
    if (active === null) return false
    // The reason is an observation, not a durable fact: it tells an operator why
    // the task went back to PENDING without inventing a status for it.
    this.emit({ kind: "cycle:stopped", reason: "claim-wrong-state" })
    void why
    const result = this.store.reconcileStranded(
      this.sessionId,
      active.taskId,
      active.claimRevision,
      {
        ownsSession: ownsSession(this.sessionId, this.owner),
      },
    )
    this.claim = null
    return result.outcome === "RECONCILED"
  }

  // ── reconciliation ──────────────────────────────────────────────────────────

  /**
   * Revert stranded in-flight tasks. Runs at the START of every cycle — the P77
   * lesson, where a scheduler went IDLE with no in-process path back.
   *
   * Ownership-aware and fail-closed: without positively-held ownership this
   * refuses rather than guessing, because reverting live work is worse than
   * leaving it stranded.
   */
  reconcile(): readonly string[] {
    const owned = ownsSession(this.sessionId, this.owner)
    if (!owned) {
      this.emit({ kind: "cycle:stopped", reason: "ownership-unavailable" })
      return []
    }
    const snapshot = this.store.getSnapshot(this.sessionId)
    const stranded: string[] = []
    for (const task of snapshot.tasks) {
      // Only the two in-flight states are ever targets. Terminal and operator
      // states are untouched by construction, not by a later check.
      if (task.status !== "IN_PROGRESS" && task.status !== "VERIFYING") continue
      // Never revert the task this Scheduler is actively executing.
      if (this.claim?.taskId === task.id) continue
      const result = this.store.reconcileStranded(this.sessionId, task.id, task.revision, {
        ownsSession: owned,
      })
      if (result.outcome === "RECONCILED") stranded.push(task.id)
    }
    if (stranded.length > 0) this.emit({ kind: "task:recovered", taskIds: stranded })
    return stranded
  }

  private emit(event: SchedulerEvent): void {
    // A throwing sink must never take the Scheduler down; observations are not
    // authority and cannot be load-bearing.
    try {
      this.onEvent?.(event)
    } catch {
      /* deliberately swallowed: an observer cannot be allowed to fail a cycle */
    }
  }
}

export interface DispatchResult {
  readonly ok: boolean
  readonly failure: DispatchFailure | null
  readonly observation: ExecutionObservation | null
  readonly released: boolean
}

export interface CycleResult {
  readonly stop: CycleStop
  readonly dispatched: DispatchResult | null
  readonly recovered: readonly string[]
}
