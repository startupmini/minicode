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

import {
  type CancelReason,
  type ExecutionHandle,
  newExecutionHandle,
  type PerTurnCancellation,
} from "./execution-cancellation.ts"
import { TaskGraph } from "./graph.ts"
import type { ClaimOutcome, TaskSnapshot } from "./model.ts"
import { selectTask } from "./scheduling-policy.ts"
import { newOwnerToken, SESSION_LEASE_MS, SESSION_RENEW_INTERVAL_MS } from "./session-authority.ts"
import type { SessionOwner } from "./session-ownership.ts"

// Re-exported so a composition root needs one import to wire a cancellation-aware
// bridge, and so the Scheduler's public vocabulary stays in one file.
export type { CancelReason, ExecutionHandle } from "./execution-cancellation.ts"

import {
  acquireSessionOwnership,
  ownsSession,
  releaseSessionOwnership,
} from "./session-ownership.ts"
import type { AttemptRecordOutcome, TaskStore } from "./store.ts"

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
  /**
   * [PHASE 6T] The runtime was already busy when the cycle was evaluated.
   *
   * NON-CONSUMING, and that is the entire point of the outcome. No claim, no
   * generation, no owner, no attempt lineage. The task is left exactly as it was
   * and the next trigger re-evaluates it.
   */
  | "contended"
  /** [PHASE 6T] Contention was known before evaluation began; nothing was read. */
  | "pre-cancelled"
  /**
   * [PHASE 6T] The session this instance was serving no longer exists in the
   * lifetime it started for. Self-disposed; ownership released for a replacement.
   */
  | "session-superseded"
  /** [PHASE 6X] Cross-process authority was lost; the instance self-disposed. */
  | "authority-lost"

/** Why a work item could not be handed to the agent loop. */
export type DispatchFailure =
  | "scheduler-not-running"
  | "bridge-threw"
  | "bridge-not-callable"
  /**
   * [PHASE 6Q] The turn ended but no active claim identified which generation it
   * belonged to, so no lineage was recorded. Distinct from a persistence error:
   * the instance stays usable, which is the whole point.
   */
  | "attempt-unidentified"

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
  /**
   * [PHASE 6T] The per-execution cancellation handle for THIS dispatch.
   *
   * Optional so every existing bridge keeps compiling unchanged. A bridge that
   * ignores it simply cannot be cancelled mid-turn — which is a capability gap,
   * not a correctness gap, and the composition root chooses whether to close it.
   */
  active?: ExecutionHandle,
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
  /**
   * [PHASE 6Q] The attempt ended but its completion could NOT be recorded, because
   * the session was deleted under it or a later generation superseded it. Nothing
   * was written; the task is left for the next owner to decide.
   */
  | {
      readonly kind: "task:execution_abandoned"
      readonly taskId: string
      readonly outcome: AttemptRecordOutcome
    }
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
  /**
   * [PHASE 6X] Pre-existing authority token, when the composition root owns the
   * lease. Omit and the Scheduler mints its own at start().
   */
  readonly authorityToken?: string
}

export interface ActiveClaim {
  readonly taskId: string
  /**
   * The revision AFTER the accepted claim. Never the pre-claim revision, never
   * the graph's revision, never a timestamp, never `sourceMaxRevision` -
   * a release must address the state the claim actually produced.
   */
  readonly claimRevision: number
  /**
   * [PHASE 6I] The EXECUTION GENERATION created by the accepted claim, returned
   * by `claimTask` from the same atomic statement that set `IN_PROGRESS`.
   *
   * This is the identity an attempt belongs to, and it is deliberately NOT the
   * revision: `claimRevision` changes on every unrelated task write, which is
   * exactly what let a stale completion protect a later generation (6G D1).
   * `execGeneration` advances only when a claim is accepted.
   */
  readonly execGeneration: number
  /**
   * [PHASE 6Q] The session INCARNATION the claim was made under.
   *
   * `taskId` is allocated per session and restarts at `t1`, so a session deleted
   * and recreated under the same id has task ids indistinguishable from the
   * deleted ones - and a `execGeneration` that a fresh claim can legitimately
   * match. This token is how a late execution recognises that the row it is
   * about to touch belongs to a DIFFERENT session lifetime. Deletion bumps it.
   */
  readonly sessionIncarnation: number
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
   * [PHASE 6T] The cancellation handle for the turn currently in flight, or null.
   *
   * One at a time, because V1 is serial — the same guarantee `inFlight` provides
   * for cycles. Replacing it rather than stacking is deliberate: a second handle
   * could only mean a second concurrent turn, which this Scheduler never starts.
   */
  private active: PerTurnCancellation | null = null

  /**
   * [PHASE 6T] The session incarnation this instance started under.
   *
   * [DESIGN DECISION] 6Q taught the Scheduler to self-dispose when a lineage
   * write comes back `TASK_GONE`/`SESSION_SUPERSEDED` — but that only happens on
   * the CLAIM path, while a turn is ending. A scheduler that is merely IDLE when
   * its session is deleted never writes anything, never learns, and keeps
   * holding the process-local ownership token, which wedges every replacement:
   * a recreated session cannot start, because a dead instance still owns it.
   * Proved by probe before this fix.
   *
   * The fix reuses 6Q's own fact rather than inventing a liveness mechanism: the
   * incarnation is captured at `start()` and compared at the top of every cycle.
   * If it moved, this session was deleted or superseded, and the instance's work
   * is meaningless. This STRENGTHENS 6Q — same durable evidence, checked at cycle
   * granularity instead of only at lineage-write time — and it is the answer to
   * 6T's requirement that a Scheduler never need a restart because of stale
   * internal ownership.
   */
  private incarnationAtStart: number | null = null

  // -- [PHASE 6X] cross-process authority ---------------------------------------
  /** The durable lease token for THIS authority. Null until start(). */
  private authorityToken: string | null = null
  /** Set when a lease is lost; from then on this instance must not schedule. */
  private authorityLost = false
  /** Renewal heartbeat. unref'd, and cleared on every stop path. */
  private renewTimer: ReturnType<typeof setInterval> | null = null

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
    // P2.2: token otoritas milik composition root (satu penulis per boot).
    // Tanpa ini opsi authorityToken mati (selalu mint sendiri) dan sesi +
    // scheduler-nya saling menolak lease. Bukan redesign protokol: acquire/
    // renew/release/holds tak berubah; hanya sumber token disatukan.
    this.authorityToken = opts.authorityToken ?? null
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
      // [PHASE 6W/6X] Remember which lifetime of this session we are serving, so a
      // deletion that happens while we sit idle cannot go unnoticed.
      this.incarnationAtStart = this.store.getSessionIncarnation(this.sessionId)
    }

    // [PHASE 6X] DURABLE, CROSS-PROCESS AUTHORITY.
    //
    // [DESIGN DECISION] Acquired HERE, before any cycle can run, and it is what
    // closes FINDING-02. F02 required TWO reconcilers to coexist on one session;
    // process-local ownership cannot see another OS process, so a second process
    // used to sail past it and revert the first one's live execution. This is a
    // single atomic statement, so a race has exactly one winner.
    //
    // The token is generated per `start()` and is never a PID or an object
    // identity, so a restarted process can never present its predecessor's token.
    const token = this.authorityToken ?? newOwnerToken()
    this.authorityToken = token
    const acquired = this.store.acquireSessionAuthority(this.sessionId, token, SESSION_LEASE_MS)
    if (acquired === "REFUSED_LEASE_HELD") {
      // Fail CLOSED, and release the process-local token we just took so the loser
      // leaves nothing half-installed.
      if (this.owner !== null) {
        releaseSessionOwnership(this.sessionId, this.owner, "stopped")
        this.owner = null
      }
      this.state = "STOPPED"
      throw new SchedulerError(
        "ownership-unavailable",
        `session ${this.sessionId} already has a valid autonomous lease held by another process`,
      )
    }

    // [PHASE 6X] Renewal while the scheduler is live. `unref()` so it never keeps
    // the process alive on its own, and cleared on every stop path.
    this.renewTimer = setInterval(() => {
      if (this.authorityToken === null) return
      if (
        this.store.renewSessionAuthority(this.sessionId, this.authorityToken, SESSION_LEASE_MS) ===
        "AUTHORITY_LOST"
      ) {
        this.loseAuthority()
      }
    }, SESSION_RENEW_INTERVAL_MS)
    this.renewTimer.unref?.()

    this.state = "RUNNING"
  }

  /**
   * [PHASE 6X] Authority lost: a lease expired and someone else took it, or the
   * session was deleted out from under us.
   *
   * [DESIGN DECISION] Fail closed IMMEDIATELY and loudly. The alternative —
   * carrying on and discovering the loss at the next write — would mean scheduling
   * without authority in the meantime, which is exactly what F02 exploited. We
   * cancel the in-flight turn because continuing to spend a provider on work we
   * may no longer write is worse than stopping; 6Q's incarnation check remains the
   * durable backstop if the turn completes anyway.
   */
  private loseAuthority(): void {
    if (this.state === "STOPPED") return
    this.authorityLost = true
    this.emit({ kind: "cycle:stopped", reason: "authority-lost" })
    this.cancelActive("emergency-stop")
    this.disposeSelf()
  }

  /** True only while this instance still holds valid cross-process authority. */
  hasAuthority(): boolean {
    if (this.authorityToken === null || this.authorityLost) return false
    return this.store.holdsSessionAuthority(this.sessionId, this.authorityToken)
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
    // [PHASE 6T] Ask the live turn to stop, THEN let the cycle finish unwinding.
    //
    // The await below is what makes this a graceful stop rather than a crash-like
    // one: the abort gives the turn a chance to unwind and release its resources
    // before we return, so the attempt can still be recorded as an attempt. The
    // durable outcome does not depend on this succeeding — 6Q's reconciliation
    // covers a turn that never came back.
    this.cancelActive("scheduler-stopped")
    // Let an in-flight cycle finish so a dispatch is never half-abandoned.
    if (this.inFlight !== null) {
      try {
        await this.inFlight
      } catch {
        // An in-flight failure is already reported through the cycle result.
      }
    }
    this.state = "STOPPED"
    this.releaseAuthority()
    if (this.owner !== null) {
      releaseSessionOwnership(this.sessionId, this.owner, "stopped")
      this.owner = null
    }
  }

  getActiveClaim(): ActiveClaim | null {
    return this.claim
  }

  /**
   * [PHASE 6T] The handle for the turn in flight, or null when nothing is running.
   *
   * Exposed so a lifecycle owner can observe cancellation state without being able
   * to fabricate it. Cancelling is `cancelActive`.
   */
  getActiveExecution(): ExecutionHandle | null {
    return this.active
  }

  /**
   * [PHASE 6T] CANCEL THE TURN IN FLIGHT.
   *
   * Returns true when there was something to cancel. Safe to call repeatedly and
   * safe to call when nothing is running — it simply reports that there was
   * nothing to do.
   *
   * [DESIGN DECISION] This CANCELS, it does not RELEASE. The task stays
   * IN_PROGRESS and keeps its generation: cancelling the work is not the same as
   * declaring the work finished, and a cancelled task is moved by a legitimate
   * authority (a verifier, an operator, or a later reconciliation), never by the
   * thing that stopped it. Writing a status here would be exactly the scheduler
   * inventing a verdict, which 6C/6I forbade.
   *
   * This is the LIVE half of the cancellation story. 6Q's incarnation check remains
   * the durable half and is untouched: cancelling cannot be relied on (the turn may
   * be blocked in a syscall the abort cannot reach, or the process may die first),
   * so the write-time protection stays.
   */
  cancelActive(reason: CancelReason): boolean {
    const handle = this.active
    if (handle === null) return false
    handle.cancel(reason)
    return true
  }

  /**
   * [PHASE 6Q] Synchronously end this instance because its session is gone.
   *
   * Releases the process-local ownership token and moves to `STOPPED`, so a
   * replacement Scheduler for a recreated session can acquire it.
   *
   * Deliberately NOT `stop()`: that awaits the in-flight cycle, and the only
   * caller of this method is the in-flight cycle itself, so awaiting it would
   * deadlock. Synchronous disposal is the only correct shape at this point.
   */
  /**
   * [PHASE 6X] Stop renewing and give the lease back — but only if it is still
   * OURS. A stale instance whose lease was taken over must not clear the
   * successor's authority (6X section 8).
   */
  private releaseAuthority(): void {
    if (this.renewTimer !== null) {
      clearInterval(this.renewTimer)
      this.renewTimer = null
    }
    if (this.authorityToken !== null) {
      this.store.releaseSessionAuthority(this.sessionId, this.authorityToken)
      this.authorityToken = null
    }
  }

  private disposeSelf(): void {
    // [PHASE 6X] Give the lease back here too, not just in stop(). 6Q's whole
    // point is that a self-disposed instance must leave the session USABLE, and
    // a retained lease would lock the replacement out for a full lease period.
    // Safe on the authority-lost path as well: release is token-guarded, so a
    // stale instance can only ever fail to release, never evict its successor.
    this.releaseAuthority()
    if (this.state === "STOPPED") return
    // [PHASE 6T] Stop the WORK as well as the instance.
    //
    // 6Q made a late return harmless; it did not stop the turn from running. Now
    // that a cancellation handle exists, session deletion asks the live execution
    // to stop, which is the invariant 6T requires: deletion should end autonomous
    // work as early as the runtime permits, with 6Q's incarnation check still
    // there as the final boundary if the request is ignored or arrives too late.
    //
    // Ordering matters: cancel BEFORE releasing ownership, so nothing can start a
    // replacement and race this instance's dying turn.
    this.cancelActive("session-deleted")
    // [PHASE 6X] ...and give the lease back, for the same reason: a superseded
    // session must be immediately schedulable by its replacement. Ordering is
    // unchanged - cancel first, then release.
    this.releaseAuthority()
    this.state = "STOPPED"
    this.incarnationAtStart = null
    if (this.owner !== null) {
      releaseSessionOwnership(this.sessionId, this.owner, "stopped")
      this.owner = null
    }
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

    // [PHASE 6T] IS THIS SESSION STILL THE ONE I STARTED FOR?
    //
    // Checked before anything else, because every later step assumes the task
    // namespace still means something. A session that was deleted underneath us is
    // not "an empty queue" — it is a queue that no longer exists, and treating the
    // two alike is what left an idle Scheduler holding ownership forever.
    //
    // Uses 6Q's incarnation, so it works across processes with no registry and no
    // notification from the deletion path.
    if (this.incarnationAtStart !== null) {
      const current = this.store.getSessionIncarnation(this.sessionId)
      if (current !== this.incarnationAtStart) {
        this.emit({ kind: "cycle:stopped", reason: "session-superseded" })
        this.disposeSelf()
        return { stop: "session-superseded", dispatched: null, recovered: [] }
      }
    }

    // [PHASE 6X] THE RECONCILIATION BOUNDARY.
    //
    // [DESIGN DECISION] This is the heart of the F02 fix, so it gates every durable
    // effect - before reconciliation, before readiness, before a claim. A Scheduler
    // that has lost its cross-process lease must not touch durable state at all, and
    // `reconcile()` is precisely the code that reverts other people's work.
    //
    // Deliberately AFTER the 6T incarnation check, and that ordering is the point.
    // A deleted-and-recreated session also stops us holding the lease, because the
    // lease is keyed by (session, incarnation) - but "the session I serve was
    // deleted" is the true cause and it has its own accurate diagnosis, release
    // ordering and 6Q backstop. Reporting that as `authority-lost` would be a lie
    // about WHY we stopped, and it would also point at the wrong suspect.
    // `authority-lost` therefore means exactly one thing: our lease is gone and the
    // session is still ours, so another process is the live owner.
    if (!this.hasAuthority()) {
      if (!this.authorityLost) this.loseAuthority()
      return { stop: "authority-lost", dispatched: null, recovered: [] }
    }

    // [PHASE 6T] CAPACITY, checked BEFORE anything durable happens.
    //
    // [DESIGN DECISION] This is the cheap half of the contention policy and it
    // costs nothing: if the runtime is known to be busy, the cycle stops before it
    // reads a snapshot, builds a graph, or attempts a claim. A trigger that cannot
    // be serviced must not leave a mark — 6O's requirement that "contention is
    // indistinguishable from a real attempt" is satisfied here by not acting at
    // all.
    //
    // It is NOT sufficient on its own: a probe is a read, and another process (or
    // another session) can take the slot between this check and the claim. The
    // atomic capacity predicate inside `claimTask` is the half that actually
    // holds. This one just avoids the wasted work in the overwhelmingly common
    // case of a live user turn.
    if (this.cancellation?.isCancelled() === true) {
      this.emit({ kind: "cycle:stopped", reason: "pre-cancelled" })
      return { stop: "pre-cancelled", dispatched: null, recovered: [] }
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

    // 6. Selection is a NAMED POLICY, not an expression.
    //
    // [PHASE 6T] This used to read `ready[0]` inline. That was the same
    // behaviour, but nothing recorded that it WAS a policy, so there was no place
    // to state what selection guarantees and no single function to point a
    // property test at. Routing through `selectTask` makes ORDER ASC -> ID ASC a
    // decision that can be read, argued and mutated, rather than a coincidence
    // of array indexing.
    //
    // The policy does NOT re-derive readiness; it is handed the graph's answer and
    // only chooses among it. A second readiness implementation here is the way a
    // scheduler starts disagreeing with its own graph.
    const selection = selectTask(ready, snapshot)
    const taskId = selection.taskId
    if (taskId === null) {
      this.emit({
        kind: "cycle:stopped",
        reason: selection.reason === "no-ready-tasks" ? "no-candidates" : "no-candidates",
      })
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
    //
    // [PHASE 6T] `exclusive: true` adds the capacity predicate to this same
    // statement, so losing the slot to another executor is reported exactly like
    // losing the revision race: the row is untouched, and no generation is spent.
    const claimResult = this.store.claimTask(this.sessionId, taskId, current.revision, {
      exclusive: true,
    })
    if (claimResult.outcome !== "CLAIM_ACCEPTED") {
      this.emit({ kind: "task:claim_rejected", taskId, outcome: claimResult.outcome })
      const stop: CycleStop =
        claimResult.outcome === "CLAIM_REJECTED_STALE"
          ? "claim-rejected-stale"
          : claimResult.outcome === "NOT_FOUND"
            ? "claim-not-found"
            : claimResult.outcome === "CLAIM_REJECTED_BUSY"
              ? "contended"
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
    this.claim = {
      taskId,
      claimRevision: accepted.revision,
      execGeneration: claimResult.execGeneration,
      sessionIncarnation: claimResult.sessionIncarnation,
    }
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
    // [PHASE 6T] One cleanup point for the per-turn handle.
    //
    // `dispatchTracked` has seven terminal returns and more will be added over
    // time; clearing the handle in each of them is exactly the kind of thing that
    // rots silently when a path is missed. A `finally` makes "the handle never
    // outlives its turn" a structural property instead of a per-branch intention.
    try {
      return await this.dispatchTracked(work)
    } finally {
      this.active?.dispose()
      this.active = null
    }
  }

  private async dispatchTracked(work: SchedulerWorkItem): Promise<DispatchResult> {
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
      return {
        ok: false,
        failure: "scheduler-not-running",
        observation: null,
        released: false,
        lineage: "NOT_ATTEMPTED",
      }
    }
    this.emit({ kind: "task:dispatch_started", taskId: work.taskId })

    // [PHASE 6T] Create the per-execution cancellation handle and publish it
    // BEFORE the bridge is called, so a cancel racing dispatch is recorded rather
    // than lost. The bridge attaches its abort function; if cancellation already
    // happened, `attach` fires immediately.
    //
    // Held on the instance, not in a closure, so `cancelActive()` can reach it.
    // Cleared on every terminal path below, so a dead turn is never retained.
    const handle = newExecutionHandle()
    this.active = handle

    let produced: Promise<ExecutionObservation> | ExecutionObservation
    try {
      produced = this.runTurn(work, handle)
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
        lineage: "NOT_ATTEMPTED",
      }
    }

    if (
      !(produced instanceof Promise) &&
      typeof (produced as ExecutionObservation)?.kind !== "string"
    ) {
      const released = this.releaseClaim("dispatch-failed")
      return {
        ok: false,
        failure: "bridge-not-callable",
        observation: null,
        released,
        lineage: "NOT_ATTEMPTED",
      }
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

    // [PHASE 6I] Record that this EXECUTION GENERATION's attempt ended, before
    //    dropping the in-memory claim.
    //
    //    The generation is the one the accepted claim created. It is NOT the
    //    revision, and it is NOT re-read from the task: inferring lineage from
    //    mutable task state is precisely the confusion 6G D1 exposed. An
    //    unrelated write that bumped `revision` after the claim cannot change
    //    what is recorded here.
    //
    //    `observation.ok` is deliberately NOT consulted. A rejected turn and a
    //    successful turn are both "an attempt ended"; conflating them with
    //    success is the bug this replaces. EXECUTION != VERIFICATION !=
    //    COMPLETION.
    //
    // [PHASE 6Q] THE CLAIM IS RELEASED ON EVERY TERMINAL PATH.
    //
    //    This is the fix for 6N F2, and the reason it is a restructure rather than
    //    a try/catch. Previously the claim was cleared on ONE line AFTER the
    //    lineage write, so any failure in between - above all the "session was
    //    deleted under this execution" case - escaped `cycle()` with the claim
    //    still set. `runCycle` returns `already-dispatched` whenever a claim
    //    exists, and `stop()` had already been passed, so the instance was
    //    permanently wedged AND still held session ownership, which prevented any
    //    replacement from starting.
    //
    //    The attempt HAS ended at this point, whatever the store says about
    //    recording it. So the bookkeeping is settled first, unconditionally, and
    //    the lineage write is a pure side effect whose result is reported rather
    //    than allowed to strand the instance.
    const generation = this.claim
    this.claim = null
    if (generation === null) {
      // The claim was cleared while the turn was in flight. We no longer know
      // which generation this was, so recording one would be a guess. Refuse to
      // fabricate evidence - and return rather than throw, so an unidentified
      // attempt can never become a lifecycle wedge either.
      this.emit({ kind: "task:execution_completed", taskId: work.taskId, ok: false })
      return {
        ok: observation.kind === "returned" && observation.ok,
        failure: "attempt-unidentified",
        observation,
        released: true,
        lineage: "TASK_GONE",
      }
    }
    const lineage = this.store.recordAttemptReturned(
      this.sessionId,
      generation.taskId,
      generation.execGeneration,
      generation.sessionIncarnation,
    )
    if (lineage !== "RECORDED") {
      // The attempt ended but its completion was NOT recorded. This is now an
      // ordinary, classified outcome - the session was deleted under this
      // execution, or a later generation superseded it. Nothing was written, so
      // the task is left exactly as it was and the next owner decides its fate.
      this.emit({ kind: "task:execution_abandoned", taskId: generation.taskId, outcome: lineage })
    }
    if (lineage === "TASK_GONE" || lineage === "SESSION_SUPERSEDED") {
      // [PHASE 6Q] The session this Scheduler was executing FOR no longer exists
      // (or exists as a different lifetime). That is durable evidence, learned
      // from the store rather than announced by anyone, so it works across
      // processes without a registry and without the deletion path having to know
      // that any Scheduler exists.
      //
      // Self-dispose: release the session ownership token and become STOPPED, so
      // a REPLACEMENT Scheduler can start. Without this the instance stayed IDLE
      // but kept the ownership, which is precisely the second half of 6N F2.
      //
      // `stop()` cannot be used here: it awaits the in-flight cycle, and this IS
      // the in-flight cycle, so awaiting it would deadlock.
      this.disposeSelf()
    }
    return {
      ok: observation.kind === "returned" && observation.ok,
      failure: null,
      observation,
      released: true,
      lineage,
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
   *
   * [PHASE 6F] The decision is made on EVIDENCE, not on status. The old rule
   * reverted every `IN_PROGRESS` row that was not this Scheduler's current
   * in-memory claim — which, because the claim is cleared after every dispatch,
   * reverted the Scheduler's own freshly completed work and re-executed it
   * forever. Now a generation is reverted ONLY when there is no completion
   * marker for it. Absence of a marker is the sole admissible evidence that an
   * attempt never recorded completion.
   */
  reconcile(): readonly string[] {
    // [PHASE 6X] No authority, no reconciliation. Unconditionally: this is the single
    // function that reverts another party's in-flight work, and it is exactly what
    // FINDING-02 used.
    if (!this.hasAuthority()) {
      if (!this.authorityLost) this.loseAuthority()
      return []
    }
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

      // [PHASE 6I] The lineage decision belongs to TaskStore, which owns both
      // generation columns and can make it in ONE atomic guarded statement. The
      // Scheduler contributes ownership and nothing else: it does not read the
      // lineage, does not compare generations, and has no rule of its own.
      //
      // This is what closes 6G D1. The decision cannot be influenced by an
      // unrelated task write, because `exec_generation` advances only on an
      // accepted claim - not by the title, order, dependency, evidence or status
      // writes that also advance `revision`.
      const result = this.store.reconcileIfNoCompletedAttempt(
        this.sessionId,
        task.id,
        task.revision,
        {
          ownsSession: owned,
        },
      )
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
  /**
   * [PHASE 6Q] What became of the completion marker. `RECORDED` in the normal
   * case; anything else means the session was deleted or superseded underneath
   * this execution and NOTHING was written. `NOT_ATTEMPTED` is the pre-attempt
   * shape: the bridge was never successfully entered, so there was never an
   * attempt whose completion could be recorded.
   */
  readonly lineage: AttemptRecordOutcome | "NOT_ATTEMPTED"
}

export interface CycleResult {
  readonly stop: CycleStop
  readonly dispatched: DispatchResult | null
  readonly recovered: readonly string[]
}
