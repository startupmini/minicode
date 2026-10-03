// PHASE 6T — per-turn cancellation handle.
//
// 6R gave the autonomous context its own AbortController. 6Q proved that session
// deletion makes LATE WRITES safe, but that it does not stop live work — the
// execution kept burning a turn after its session was gone, and 6Q had to make
// the write harmless rather than make the work stop.
//
// This module supplies the missing piece: a handle the lifecycle can hold, and
// the active execution can attach to, so cancellation is an ACTIVE operation
// rather than a retroactive excuse.
//
// ── CANCELLATION vs RECOVERY (phase 6T §28) ────────────────────────────────
//
// These are different mechanisms and this file must not merge them:
//
//   CANCELLATION  an active runtime operation, needs a live handle to reach into
//   RECOVERY     durable evidence that execution is gone, needs no cooperation
//
// 6Q's incarnation check IS recovery, and it stays exactly as it is — it is the
// final safety boundary and it works when the process is gone. Cancellation is an
// optimisation layered in front of it: it ends work sooner when someone is still
// present to signal. Deleting the durable protection because a cancel path now
// exists would be trading a guarantee for a convenience.

/** Reason a turn was cancelled. An observation, never a durable fact. */
export type CancelReason =
  | "session-deleted"
  | "scheduler-stopped"
  | "shutdown"
  | "emergency-stop"
  | "superseded"

/**
 * [PHASE 6T] The per-execution cancellation handle.
 *
 * Deliberately NOT an `AbortController`. The 6R context already owns the real
 * one; this is the *address* of that one, published so the lifecycle can reach
 * it without holding a reference to the context (and therefore without being able
 * to touch anything else the context owns).
 */
export interface ExecutionHandle {
  /** Unique per execution. Two handles are never interchangeable. */
  readonly executionId: string
  /** Monotonic: true once cancellation was requested, and it never goes back. */
  readonly cancelled: boolean
  /** Why, once known. `null` while the turn is still allowed to run. */
  readonly reason: CancelReason | null
  /**
   * Request cancellation. Idempotent, and safe to call any number of times, from
   * anywhere, before or after the turn attached.
   *
   * [DESIGN DECISION] Cancellation is a REQUEST, and it is recorded even when
   * nothing is listening yet. An execution that attaches *after* a cancel must
   * find itself already cancelled, because the alternative — dropping the request
   * because the handle was not wired up yet — is a race with a silent winner.
   */
  cancel(reason: CancelReason): void
  /**
   * Register the live turn's abort function.
   *
   * If cancellation was already requested, the callback fires immediately with
   * the original reason. Attaching twice replaces the previous callback: the last
   * attachment is the live one, and the earlier turn is over.
   */
  attach(abort: (reason: CancelReason) => void): void
}

/**
 * [PHASE 6T] THE HANDLE.
 *
 * Requirements, and how each is met:
 *
 *   per-execution    constructed per dispatch, never pooled or reused
 *   unique           a monotonic counter, so ids cannot collide within a process
 *   disposable       `dispose()` drops the callback so a dead turn is not retained
 *   not shared       the Scheduler holds only the CURRENT handle, and clears it
 *                    when the turn ends
 *   repeatable       `cancel()` sets a flag and returns; calling it twice is
 *                    indistinguishable from calling it once
 */
export class PerTurnCancellation implements ExecutionHandle {
  readonly executionId: string

  private abortFn: ((reason: CancelReason) => void) | null = null
  private cancelReason: CancelReason | null = null
  private disposed = false

  constructor(executionId: string) {
    this.executionId = executionId
  }

  get cancelled(): boolean {
    return this.cancelReason !== null
  }

  get reason(): CancelReason | null {
    return this.cancelReason
  }

  cancel(reason: CancelReason): void {
    // First reason WINS. A later, more specific reason does not overwrite the one
    // that actually stopped the turn, so the recorded cause stays truthful.
    if (this.cancelReason !== null) return
    this.cancelReason = reason
    // A throwing abort must not prevent the flag from being set, and must not
    // propagate into the caller that is merely stopping a scheduler.
    try {
      this.abortFn?.(reason)
    } catch {
      // The turn is going away regardless; the request is already recorded.
    }
  }

  attach(abort: (reason: CancelReason) => void): void {
    if (this.disposed) return
    this.abortFn = abort
    if (this.cancelReason !== null) {
      try {
        abort(this.cancelReason)
      } catch {
        // Same reasoning as `cancel`.
      }
    }
  }

  /**
   * [PHASE 6T] Release the callback.
   *
   * Called when the turn ends. Without it the handle would retain the context's
   * closure for as long as the Scheduler lives, and a `cancel()` arriving after
   * the turn finished would reach into a dead execution.
   */
  dispose(): void {
    this.disposed = true
    this.abortFn = null
  }
}

let counter = 0

/**
 * [PHASE 6T] A fresh, unique handle.
 *
 * The counter is module-level but that is safe: it is a monotonic name generator,
 * not shared state. Two executions can never be handed the same identity, and
 * nothing can be *cancelled* through it by accident, because the handle is only
 * reachable from the Scheduler that created it.
 *
 * [P1 M15] Prefix `cancel-`, BUKAN `exec-`. Handle ini BUKAN execution identity:
 * ia adalah alamat pembatalan dalam memori, tidak pernah masuk jurnal durable dan
 * tak pernah dibandingkan dengan id eksekusi runtime. Prefiks `exec-` pernah
 * menabrak namespace `exec_<uuid>` milik M1 (`isExecutionId`), jadi dua "execution
 * id" berbeda bisa tampak sama di log — dan M15 swore there is exactly one
 * execution-identity authority. Mengganti prefix menghapus tabrakan itu tanpa
 * mengubah satu pun semantik pembatalan.
 */
export function newExecutionHandle(): PerTurnCancellation {
  counter += 1
  return new PerTurnCancellation(`cancel-${counter}`)
}

/** Test-only reset, so ids are reproducible across runs. */
export function resetExecutionHandleCounterForTests(): void {
  counter = 0
}
