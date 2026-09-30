// PHASE 6AB - SCHEDULER OPERATOR OBSERVABILITY.
//
// WHY A SEPARATE MODULE
//
// Phase 6AA proved the enablement gate is correct and that `--enable-scheduler`
// produces a real, authority-holding Scheduler - and that every one of the ten-plus
// `SchedulerEvent` variants and four `TriggerEvent` variants was constructed and
// then DISCARDED, because production passed no sink to either constructor.
//
// This module is the missing sink, reduced to the smallest thing that answers the
// nine questions §7 asks:
//
//   1. Is Scheduler enabled?          -> `probe()` / OFF state
//   2. Did it acquire authority?     -> active flag (start() throws without a lease)
//   3. Did a trigger occur?          -> trigger:* events
//   4. Which task was selected?      -> task:selected
//   5. Did execution start?          -> task:execution_started
//   6. Did execution return?         -> task:execution_completed / _abandoned
//   7. Was it cancelled?             -> task:execution_completed{ok:false} + cycle reason
//   8. Did authority disappear?      -> cycle:stopped{reason:"authority-lost"}
//   9. Did the Scheduler stop?       -> explicit noteStopped() from the stop route
//
// [DESIGN DECISION] NO new event type is introduced and NO existing event is
// reinterpreted. Every answer above is already present in the two event unions as
// 6T defined them; 6AA's finding was that nothing was listening, not that the
// vocabulary was insufficient. Adding an event would have been a semantic change
// to a layer §23 puts out of scope.
//
// [DESIGN DECISION] The probe is authoritative; events are a refinement. An
// operator asking "is it on?" must never be told "idle" by a stale in-memory
// counter while the handle says the Scheduler is stopped - or "running" while the
// handle was never constructed at all. So `state()` takes the handle first and
// only consults `hint` for the distinction between idle, executing and error.
//
// [DESIGN DECISION] Nothing here throws and nothing here awaits. A diagnostic that
// can crash a cycle is worse than a missing diagnostic - the same rule 6T applied
// to `Scheduler.emit` and `TriggerCoordinator.emit`, applied once more here so
// the three layers cannot disagree about who is allowed to fail.

import type { CycleStop, SchedulerEvent } from "./scheduler.ts"
import type { TriggerEvent } from "./trigger.ts"

/**
 * [PHASE 6AB][DESIGN DECISION] The four operator-visible conditions §7 requires,
 * plus the error case. This is the whole of the public observability contract:
 * an operator never reads a counter to answer "is it working", only this.
 */
export type SchedulerOperatorState =
  /** Gate shut. No Scheduler exists, nothing is constructed, nothing can be fired. */
  | "OFF"
  /** Constructed, holds authority, no cycle in flight. Waiting for a trigger. */
  | "ON_IDLE"
  /** A cycle is in flight, or autonomous execution is running. */
  | "ON_EXECUTING"
  /** Constructed once, no longer active: operator stop, shutdown, or lost authority. */
  | "ON_STOPPED"
  /** A cycle failed, or the graph was invalid. Authority may still be held. */
  | "ON_ERROR"

/** The minimum a caller must expose for the probe to be meaningful. */
export interface SchedulerProbe {
  readonly enabled: boolean
  readonly constructed: boolean
  isActive(): boolean
}

/** Bounded in-memory activity log. An observation, never a durable fact. */
export interface SchedulerNotice {
  readonly at: number
  readonly line: string
}

export interface SchedulerStatusSnapshot {
  readonly state: SchedulerOperatorState
  /** Counts since process start. Deliberately not persisted - see module header. */
  readonly counts: Readonly<{
    triggersRequested: number
    evaluations: number
    coalesced: number
    refused: number
    executions: number
    failures: number
  }>
  /** Set when the state is ON_ERROR, so an operator sees the cause not the class. */
  readonly lastError: string | null
  readonly lastTaskId: string | null
  readonly lastCycleStop: string | null
  readonly recent: readonly SchedulerNotice[]
}

const MAX_NOTICES = 40

/**
 * The operator projection. One instance per process, owned by the composition
 * root - never stored in TaskStore, TaskGraph or any durable state, because none
 * of it is a fact about the world.
 */
export class SchedulerObservability {
  private hint: "idle" | "executing" | "error" | "stopped" = "idle"
  private stoppedReason: string | null = null
  private lastError: string | null = null
  private lastTaskId: string | null = null
  private lastCycleStop: string | null = null
  private notices: SchedulerNotice[] = []
  private sink: ((line: string) => void) | null = null
  private counts = {
    triggersRequested: 0,
    evaluations: 0,
    coalesced: 0,
    refused: 0,
    executions: 0,
    failures: 0,
  }

  /**
   * The presentation hook. Set by the TUI driver AFTER construction.
   *
   * [PHASE 6AB][DESIGN DECISION] Set late on purpose. `createProductionScheduler`
   * is awaited inside `createCliSession`, which runs BEFORE the Transcript
   * exists, so a sink wired at construction could only ever write into a
   * half-initialised UI. Anything emitted before a sink attaches is retained in
   * the bounded log and still reachable through `status()`, so early events are
   * delayed rather than lost.
   */
  onSchedulerNotice(handler: ((line: string) => void) | null): void {
    this.sink = handler
  }

  /** True once the composition root constructed a real (non-inert) handle. */
  private enabled(probe: SchedulerProbe | null): boolean {
    return probe?.enabled === true && probe.constructed
  }

  /** Absorbs one SchedulerEvent. Never throws. */
  noteSchedulerEvent(event: SchedulerEvent): void {
    try {
      switch (event.kind) {
        case "task:recovered":
          this.record(`recovered ${event.taskIds.length} interrupted attempt(s)`)
          break

        case "task:selected":
          this.lastTaskId = event.taskId
          this.hint = "executing"
          this.record(`selected ${event.taskId}`)
          break

        case "task:claimed":
          this.hint = "executing"
          this.lastTaskId = event.taskId
          this.record(`claimed ${event.taskId} (revision ${event.revision})`)
          break

        case "task:claim_rejected":
          // A refused claim is NORMAL - it is the stale race working. It is
          // reported, never escalated to an error state.
          this.record(`claim rejected for ${event.taskId}: ${event.outcome}`)
          break

        case "task:dispatch_started":
          this.hint = "executing"
          this.lastTaskId = event.taskId
          this.record(`dispatch started for ${event.taskId}`)
          break

        case "task:execution_started":
          this.hint = "executing"
          this.counts.executions++
          this.lastTaskId = event.taskId
          this.record(`executing ${event.taskId}`)
          break

        case "task:execution_completed":
          this.record(`execution finished for ${event.taskId}: ok=${String(event.ok)}`)
          break

        case "task:execution_abandoned":
          // The attempt ended but nothing durable could be recorded. Distinct from
          // a failure: the task is intact and a later owner may retry it.
          this.counts.failures++
          this.lastError = `execution abandoned (${event.outcome})`
          this.hint = "error"
          this.record(`execution abandoned for ${event.taskId}: ${event.outcome}`)
          break

        case "cycle:invalid_graph":
          this.counts.failures++
          this.lastError = "task graph is invalid"
          this.hint = "error"
          this.record("cycle refused: invalid task graph")
          break

        case "cycle:stopped":
          this.record(this.describeCycleStop(event.reason))
          // [PHASE 6AB][DESIGN DECISION] ONLY the two reasons 6Q/6X document as
          // "self-disposed" may set the stopped hint. Every other reason merely
          // ended a cycle.
          //
          // Inferring stop from, say, `ownership-unavailable` would make
          // `/scheduler status` assert "STOPPED" while `isActive()` said true -
          // an operator told a falsehood by a diagnostic, which is the one
          // failure mode observability exists to prevent. Where self-disposal
          // actually happened the probe reports it anyway, and the probe is
          // authoritative.
          if (event.reason === "authority-lost" || event.reason === "session-superseded") {
            this.hint = "stopped"
            this.stoppedReason = String(event.reason)
            this.lastError = "session authority was lost"
          } else if (event.reason === "ownership-unavailable") {
            // Authority could not be taken. Recorded as a fault, NOT as a stop.
            this.counts.failures++
            this.lastError = "session authority is held by another process"
            this.hint = "error"
          } else {
            this.hint = "idle"
          }
          break
      }
    } catch {
      // Observability is not authority. A malformed event must not take the
      // cycle down; the count of failures here is itself not worth recording.
    }
  }

  /** Absorbs one TriggerEvent. Never throws. */
  noteTriggerEvent(event: TriggerEvent): void {
    try {
      switch (event.kind) {
        case "trigger:evaluated":
          this.counts.evaluations++
          this.hint = "executing"
          this.record(`trigger evaluated (${event.source})`)
          break

        case "trigger:coalesced":
          this.counts.coalesced++
          this.record(`trigger coalesced into running cycle (${event.source})`)
          break

        case "trigger:refused":
          this.counts.refused++
          this.record(`trigger refused: ${event.outcome} (${event.source})`)
          break

        case "trigger:cycle_failed":
          this.counts.failures++
          this.lastError = event.detail
          this.hint = "error"
          this.record(`cycle failed: ${event.detail}`)
          break
      }
    } catch {
      /* deliberately swallowed - same rule as noteSchedulerEvent */
    }
  }

  /**
   * Called by the production stop route, not by the event stream.
   *
   * `Scheduler.stop()` releases authority and does not emit a `cycle:stopped` of
   * its own, so without this note an operator who ran `/scheduler stop` would see
   * the state flip from the probe while the activity log's last line described
   * something older. The reason is recorded so the log explains the transition.
   */
  noteStopped(reason: string): void {
    try {
      this.hint = "stopped"
      this.stoppedReason = reason
      this.record(`scheduler stopped (${reason})`)
    } catch {
      /* deliberately swallowed */
    }
  }

  /**
   * [PHASE 6AB] Derive the operator state.
   *
   * Order matters and is the whole point: OFF first (a null or inert probe means
   * the gate is shut and every event-derived hint is meaningless), then the live
   * active flag (authoritative for stopped), then the event hint.
   */
  state(probe: SchedulerProbe | null): SchedulerOperatorState {
    if (!this.enabled(probe)) return "OFF"
    const p = probe as SchedulerProbe
    if (!p.isActive()) return "ON_STOPPED"
    if (this.hint === "stopped") return "ON_STOPPED"
    if (this.hint === "executing") return "ON_EXECUTING"
    if (this.hint === "error") return "ON_ERROR"
    return "ON_IDLE"
  }

  status(probe: SchedulerProbe | null): SchedulerStatusSnapshot {
    return {
      state: this.state(probe),
      counts: { ...this.counts },
      lastError: this.lastError,
      lastTaskId: this.lastTaskId,
      lastCycleStop: this.lastCycleStop,
      recent: [...this.notices],
    }
  }

  /** Why the scheduler stopped, when it did. `null` while it is still active. */
  get stopReason(): string | null {
    return this.stoppedReason
  }

  /**
   * Why the most recent cycle ended, or `null` if none has ended yet.
   *
   * [PHASE 6AB] Public because the operator command needs to distinguish
   * "evaluated, found nothing" from "evaluated, did something" WITHOUT
   * re-deriving it from a counter. That distinction is the whole value of the
   * `run` output; a count of evaluations alone cannot express it.
   */
  get lastCycleStopReason(): string | null {
    return this.lastCycleStop
  }

  private describeCycleStop(reason: CycleStop): string {
    this.lastCycleStop = String(reason)
    switch (reason) {
      case "no-candidates":
        return "cycle finished: no ready task"
      case "invalid-graph":
        return "cycle finished: invalid task graph"
      case "claim-rejected-stale":
        return "cycle finished: claim rejected (stale)"
      case "claim-not-found":
        return "cycle finished: task disappeared before claim"
      case "claim-wrong-state":
        return "cycle finished: task was no longer claimable"
      case "ownership-unavailable":
        return "cycle finished: session authority held by another process"
      case "already-dispatched":
        return "cycle finished: work already dispatched"
      case "not-running":
        return "cycle finished: scheduler not running"
      case "contended":
        return "cycle finished: contended with another owner (no claim taken)"
      case "pre-cancelled":
        return "cycle finished: cancelled before evaluation"
      case "session-superseded":
        return "cycle finished: session superseded; scheduler self-disposed"
      case "authority-lost":
        return "cycle finished: session authority lost; scheduler self-disposed"
      default:
        return `cycle finished: ${String(reason)}`
    }
  }

  private record(line: string): void {
    const notice: SchedulerNotice = { at: Date.now(), line }
    this.notices.push(notice)
    if (this.notices.length > MAX_NOTICES) this.notices.splice(0, this.notices.length - MAX_NOTICES)
    // A throwing presentation sink must not propagate back into the cycle that
    // emitted the event - the third and last application of the same rule.
    try {
      this.sink?.(line)
    } catch {
      /* deliberately swallowed */
    }
  }
}

/**
 * Human-readable, locale-free rendering of the four operator states.
 *
 * [PHASE 6AB][DESIGN DECISION] Deliberately NOT localised. This string is not UI
 * prose - it is the value an operator compares against when deciding whether to
 * intervene, and it is asserted verbatim by the production-path tests. The
 * bilingual command help that surrounds it is localised normally.
 */
export function describeOperatorState(state: SchedulerOperatorState): string {
  switch (state) {
    case "OFF":
      return "scheduler OFF (not enabled for this process)"
    case "ON_IDLE":
      return "scheduler ON, idle (holds authority, waiting for /scheduler run)"
    case "ON_EXECUTING":
      return "scheduler ON, executing a cycle"
    case "ON_STOPPED":
      return "scheduler ON but STOPPED (no further scheduling; restart to re-enable)"
    case "ON_ERROR":
      return "scheduler ON, last cycle failed"
  }
}
