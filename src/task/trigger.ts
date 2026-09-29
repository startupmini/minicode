// PHASE 6T — TRIGGER.
//
// A trigger says: EVALUATE NOW.
//
// It does not say which task to run, whether one is ready, or whether anything
// will be claimed. Those are the policy's job, and the claim's. Merging the three
// is how a scheduler ends up doing durable work because someone poked it.
//
// ── WHY THIS FILE IS SMALL ────────────────────────────────────────────────────
//
// [FACT] The runtime has no periodic timer anywhere (survey 6T §2: the only
// `setInterval` calls in src/ paint a spinner and a status line), no task-mutation
// event (TaskStore writes are silent), and no task-shaped event on the kernel bus
// (`AgentEvent` carries turn/step/provider events only). There is therefore
// nothing to hook and nothing to poll, and a trigger layer built on any of them
// would be inventing infrastructure to justify itself.
//
// [DESIGN DECISION] So the trigger is a DECISION, not a mechanism: "may an
// evaluation start right now, and who is allowed to ask?" Transport is injected
// and absent. A future timer or a future task-mutation hook would call `fire()`;
// neither exists, neither is assumed, and the Scheduler still cannot be reached
// from production.
//
// ── TRIGGER vs CLAIM (6T §27) ───────────────────────────────────────────────
//
//   trigger  → "evaluate now"          no durable effect whatsoever
//   claim    → "this task is mine"     advances generation, writes ownership
//
// A refused trigger is recorded in memory and touches no row. A refused claim is
// reported by the same atomic statement that would have performed it. The
// coordinator below can therefore never leave durable state behind, and it has no
// store reference at all — the absence is the proof.

/**
 * [FACT] Where an evaluation request came from. Classification from survey §2:
 *
 *  - `startup`        AVAILABLE BUT UNUSED — a composition root exists at
 *                      `cli/setup.ts:950`; nothing calls `cycle()` there.
 *  - `task-mutation`  AVAILABLE BUT UNUSED — `TaskStore.patchTask`/`createTask`
 *                      emit nothing, so there is no signal to subscribe to.
 *  - `explicit-command` AVAILABLE BUT UNUSED — `cli/router.ts` has 13 subcommands,
 *                      none task-related; adding one is an enablement decision
 *                      and out of scope.
 *  - `interval`       NOT IMPLEMENTED, and deliberately not added: a repeating
 *                      timer is the one option that would require assuming
 *                      MiniCode is a long-running server. It is not.
 *  - `event`          AVAILABLE BUT UNUSED — the kernel bus is per-session and
 *                      carries no task events.
 *  - `manual`         TEST ONLY — this is what the property tests use.
 */
export type TriggerSource =
  | "startup"
  | "task-mutation"
  | "explicit-command"
  | "interval"
  | "event"
  | "manual"

/** What the coordinator did with a request. An observation, never durable state. */
export type TriggerOutcome =
  /** A cycle started, or joined the one already running. */
  | "EVALUATED"
  /** A cycle was already running; the request was folded into the follow-up. */
  | "COALESCED"
  /** The scheduler is not running. Nothing was started and nothing was written. */
  | "REFUSED_NOT_RUNNING"
  /** A cycle is already queued to re-run, so this request changed nothing. */
  | "REFUSED_ALREADY_PENDING"

export interface TriggerResult {
  readonly outcome: TriggerOutcome
  readonly source: TriggerSource
  /** Cycle result, when a cycle actually ran. `null` for every refusal. */
  readonly cycle: unknown | null
}

export interface TriggerOptions {
  /**
   * Runs one evaluation. Injected, and in production this is `Scheduler.cycle`.
   * Kept as an argument rather than imported so the coordinator has no dependency
   * on the Scheduler and therefore no way to reach one.
   */
  readonly runCycle: () => Promise<unknown>
  /** Lifecycle probe. Absent means "assume running", which is the test default. */
  readonly isRunning?: () => boolean
  /** Optional observation sink. Absence means events are dropped, not queued. */
  readonly onEvent?: (event: TriggerEvent) => void
}

export type TriggerEvent =
  | { readonly kind: "trigger:evaluated"; readonly source: TriggerSource }
  | { readonly kind: "trigger:coalesced"; readonly source: TriggerSource }
  | {
      readonly kind: "trigger:refused"
      readonly source: TriggerSource
      readonly outcome: TriggerOutcome
    }
  | {
      readonly kind: "trigger:cycle_failed"
      readonly source: TriggerSource
      readonly detail: string
    }

/**
 * [PHASE 6T] THE TRIGGER COORDINATOR.
 *
 * [DESIGN DECISION] Scope is PER SESSION, and that is inherited rather than
 * chosen. The Scheduler is already per-session (`Scheduler(sessionId, …)`), the
 * task namespace is the session, and 6Q's incarnation makes a session's tasks
 * unusable after deletion. A per-process trigger would have to reason about which
 * session it meant; a per-session one has exactly one namespace and no such
 * question. Per-task triggering is not expressible and is not wanted: a task
 * cannot ask to be run without something already knowing it exists.
 *
 * Concurrency: V1 runs at most one cycle, and requests arriving during it are
 * COALESCED — either joined to the running cycle, or recorded as a single pending
 * re-run. There is deliberately no queue: a queue would let N rapid task
 * mutations become N evaluations, which is precisely the duplicate-trigger waste
 * the design is meant to prevent. One pending re-run is enough, because a cycle
 * re-reads the whole snapshot and would see every change that motivated the
 * intermediate requests anyway.
 */
export class TriggerCoordinator {
  private readonly runCycle: () => Promise<unknown>
  private readonly isRunning: () => boolean
  private readonly onEvent: ((e: TriggerEvent) => void) | undefined

  private inFlight: Promise<unknown> | null = null
  private pending = false
  private disposed = false

  /** Counters for observability. In-memory; an observation, not a durable fact. */
  private counts = { evaluated: 0, coalesced: 0, refused: 0, cyclesRun: 0, failures: 0 }

  constructor(opts: TriggerOptions) {
    this.runCycle = opts.runCycle
    this.isRunning = opts.isRunning ?? (() => true)
    this.onEvent = opts.onEvent
  }

  /**
   * Request an evaluation.
   *
   * Never throws: a trigger is a request, and a request that crashes its caller
   * would take down whatever asked for it. A failing cycle is reported through
   * `onEvent` and counted, then the coordinator returns to idle.
   */
  async fire(source: TriggerSource): Promise<TriggerResult> {
    if (this.disposed) {
      return this.refuse(source, "REFUSED_NOT_RUNNING")
    }
    if (!this.isRunning()) {
      // [DESIGN DECISION] Refuse BEFORE touching anything. A trigger against a
      // stopped scheduler must not read a snapshot, build a graph, or reach the
      // store — the refusal is the entire behaviour, and its purity is what makes
      // "a refused trigger creates no durable state" a structural claim.
      return this.refuse(source, "REFUSED_NOT_RUNNING")
    }

    if (this.inFlight !== null) {
      // A cycle is running. Record that another is wanted and join this one.
      this.pending = true
      this.counts.coalesced++
      this.emit({ kind: "trigger:coalesced", source })
      return { outcome: "COALESCED", source, cycle: null }
    }

    this.counts.evaluated++
    this.emit({ kind: "trigger:evaluated", source })
    const cycle = await this.drain(source)
    return { outcome: "EVALUATED", source, cycle }
  }

  /**
   * Run a cycle, then honour at most ONE pending re-run.
   *
   * The `while` is bounded because `pending` is cleared before the next cycle
   * starts: triggers arriving during the follow-up set it again, and this phase
   * ends with `pending === false` even under a continuous trigger storm. An
   * unbounded drain would be an infinite loop wearing a queue's clothes.
   */
  private async drain(source: TriggerSource): Promise<unknown> {
    let last: unknown = null
    do {
      this.pending = false
      this.inFlight = this.runCycle()
      this.counts.cyclesRun++
      try {
        last = await this.inFlight
      } catch (e) {
        // [DESIGN DECISION] CONTINUE, do not stop. A cycle that throws is a
        // failed EVALUATION, not evidence that the scheduler is broken. The
        // scheduler's own contract already resolves almost every failure into a
        // CycleResult; anything reaching here is a defect in the bridge or the
        // store, and neither should poison the trigger.
        this.counts.failures++
        const detail = e instanceof Error ? e.message : String(e)
        this.emit({ kind: "trigger:cycle_failed", source, detail })
      } finally {
        this.inFlight = null
      }
    } while (this.pending && !this.disposed)
    return last
  }

  private emit(event: TriggerEvent): void {
    // A throwing sink must never take the trigger layer down: observations are
    // observability, not authority, and a diagnostic that can crash a cycle is
    // worse than a missing diagnostic. Same rule as Scheduler.emit.
    try {
      this.onEvent?.(event)
    } catch {
      /* deliberately swallowed */
    }
  }

  private refuse(source: TriggerSource, outcome: TriggerOutcome): TriggerResult {
    this.counts.refused++
    this.emit({ kind: "trigger:refused", source, outcome })
    return { outcome, source, cycle: null }
  }

  /** True while a cycle is running or a re-run is owed. */
  get busy(): boolean {
    return this.inFlight !== null || this.pending
  }

  getStats(): Readonly<typeof this.counts> {
    return { ...this.counts }
  }

  /**
   * [PHASE 6T] Stop accepting triggers and refuse any that arrive later.
   *
   * [DESIGN DECISION] Deliberately does NOT cancel an in-flight cycle. `dispose`
   * is the trigger layer's half of shutdown; stopping the WORK is the Scheduler's
   * half (`cancelActive`), and conflating them would let a trigger cleanup reach
   * into execution — the exact layering 6T §1 forbids. `awaitSettled()` is how a
   * shutdown sequence waits for the cycle without either layer overstepping.
   */
  dispose(): void {
    this.disposed = true
    this.pending = false
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Await any running cycle. Resolves even if it rejected. Never rejects. */
  async awaitSettled(): Promise<void> {
    while (this.inFlight !== null) {
      try {
        await this.inFlight
      } catch {
        // Already reported through the event sink; a shutdown must not throw.
      }
    }
  }
}
