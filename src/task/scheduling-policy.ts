// PHASE 6T — SCHEDULING POLICY.
//
// TaskGraph answers: WHAT IS READY?
// This module answers: WHICH of those, NOW?
//
// [DESIGN DECISION] The boundary is drawn so that readiness is never recomputed
// here. `selectTask` receives an already-ordered list of ready ids and applies
// ORDERING ONLY. A second implementation of "ready" is the classic way a
// scheduler starts disagreeing with its own graph about what is runnable, and
// the disagreement is invisible until it strands work.

import type { TaskSnapshot } from "./model.ts"

/**
 * [FACT] The order TaskGraph already publishes.
 *
 * `graph.ts:63-67` — `compareNodes` sorts by `order` ASC, then `id` ASC as a
 * deterministic tiebreak, and `readyTasks()` walks that order. The Scheduler has
 * always taken `ready[0]`, so this was never an accident of implementation: it
 * has been this policy since 6C, just unnamed.
 */
export type SelectionPolicy = "ORDER_ASC_THEN_ID_ASC"

/** The only selection policy. Present as a union so adding one is a type error. */
export const SELECTION_POLICY: SelectionPolicy = "ORDER_ASC_THEN_ID_ASC"

export interface SelectionResult {
  readonly taskId: string | null
  readonly policy: SelectionPolicy
  /** Why nothing was selected. Distinguishes "no work" from "no eligible work". */
  readonly reason: "selected" | "no-ready-tasks" | "unreadable"
}

/**
 * [PHASE 6T] Choose the task to run.
 *
 * @param ready Already-ordered ready ids. NOT re-derived, NOT filtered, NOT
 *        reordered. Whatever TaskGraph said is what this sees.
 * @param snapshot Used ONLY to prove a selected id is still claimable in the
 *        currency the graph was built from. It is deliberately not used to
 *        substitute a different task: that would be selection policy silently
 *        becoming readiness policy.
 */
export function selectTask(ready: readonly string[], snapshot: TaskSnapshot): SelectionResult {
  if (ready.length === 0) {
    return { taskId: null, policy: SELECTION_POLICY, reason: "no-ready-tasks" }
  }
  // [FACT] The first candidate. `ready` arrives pre-sorted from the graph, so
  // "first" IS the policy — ORDER ASC, then ID ASC.
  const candidate = ready[0]!
  if (snapshot.tasks.find((t) => t.id === candidate) === undefined) {
    // The graph was built from this same snapshot, so this is unreachable in
    // practice. Reported rather than guessed at: a policy that invents a
    // replacement here would be deciding readiness, which is not its job.
    return { taskId: null, policy: SELECTION_POLICY, reason: "unreadable" }
  }
  return { taskId: candidate, policy: SELECTION_POLICY, reason: "selected" }
}

// ── contention policy ─────────────────────────────────────────────────────────

/**
 * [PHASE 6T] What to do when the runtime cannot take another execution.
 *
 * The mission's requirement is exact: *contention is not task execution*. A
 * rejected capacity check must not increment a generation, alter ownership,
 * create attempt lineage, mark a task failed, or mark it completed.
 */
export type ContentionPolicy =
  /** Do nothing this cycle. The task stays ready and untouched. [SELECTED] */
  | "SKIP_CYCLE"
  /** Block until capacity frees. Rejected: an unbounded wait with no owner. */
  | "WAIT"
  /** Re-evaluate after a delay. Rejected: a timer, and a lifecycle to own. */
  | "RETRY_LATER"
  /**
   * Take the task and run it when capacity appears. Rejected: it consumes a
   * generation for work that has not run — the exact defect 6T exists to fix.
   */
  | "CLAIM_AND_DEFER"

export const CONTENTION_POLICY: ContentionPolicy = "SKIP_CYCLE"

/** Why contention was detected. Both paths must leave the task untouched. */
export type ContentionSource = "pre-claim-probe" | "atomic-claim-predicate"

export interface ContentionDecision {
  readonly policy: ContentionPolicy
  readonly source: ContentionSource
  /** Always false. A contention rejection never performs work. */
  readonly mayClaim: false
  /** Whether a later trigger should re-evaluate this task. */
  readonly reEvaluateLater: true
}

/**
 * [PHASE 6T] THE CONTENTION DECISION.
 *
 * [DESIGN DECISION] `SKIP_CYCLE`, and the rejection is total: no claim, no
 * generation, no owner, no attempt, no status write, no retry loop. The task
 * remains exactly as the graph found it.
 *
 * Rationale for rejecting the alternatives, in the order they were considered:
 *
 *  - `WAIT` holds an in-memory wait across a user turn of unbounded length. It
 *    needs its own timeout, its own cancellation, and a decision about what to do
 *    when the wait outlasts the turn. All three are new lifecycle surface for a
 *    case that skipping already handles correctly.
 *  - `RETRY_LATER` is a timer plus the lifecycle to own it. 6T's own trigger
 *    survey found the runtime has NO periodic timer at all, so this would be
 *    inventing infrastructure. It also converts a policy decision into a
 *    background obligation that survives the thing that triggered it.
 *  - `CLAIM_AND_DEFER` is the one that looks attractive and is wrong: it spends
 *    a generation on work that will not run, which is the precise defect 6N
 *    reported and 6O designed against.
 *
 * `reEvaluateLater: true` is what keeps skipping from becoming starvation. The
 * next trigger — whatever legitimately causes one — re-reads a fresh snapshot,
 * so nothing is lost by declining to act now.
 */
export function decideContention(source: ContentionSource): ContentionDecision {
  return { policy: CONTENTION_POLICY, source, mayClaim: false, reEvaluateLater: true }
}

// ── starvation ────────────────────────────────────────────────────────────────

/**
 * [PHASE 6T] Is the selected policy starvation-free? Stated as a claim so it can
 * be tested rather than argued.
 *
 * [FACT] The mechanism is not fairness in the policy — it is that a task which
 * has run leaves the ready set. `reconcileIfNoCompletedAttempt` (store) reverts
 * `IN_PROGRESS` ONLY when the generation has no completion marker, so:
 *
 *   attempt completed  -> the marker exists -> NOT reverted -> stays IN_PROGRESS
 *                        -> not PENDING    -> not ready     -> never re-selected
 *   attempt never ran  -> no marker       -> reverted      -> PENDING -> ready again
 *
 * [INFERENCE] So a task that repeatedly fails by RETURNING does not starve its
 * successors — it leaves the ready set on its first attempt. Strict `ORDER ASC`
 * is therefore starvation-free here, without any fairness machinery.
 *
 * [INFERENCE] The same mechanism is the honest limit: there is no verifier, so a
 * task that returned is also never moved on, and it stays IN_PROGRESS forever.
 * That is not starvation of B; it is A being stuck. Both statements are true and
 * the distinction matters, because the fix for "A is stuck" (a verifier that
 * requeues it) is exactly what would REINTRODUCE starvation of B under a strict
 * order — a lower-ordered task that always requeues would win every cycle.
 *
 * [DESIGN DECISION] Therefore: if a verifier is ever added, selection must gain
 * an explicit anti-starvation rule at that moment. It is recorded here as a
 * dependency rather than pre-solved, because no verifier exists and pre-building
 * for it would be speculative.
 */
export const SELECTION_IS_STARVATION_FREE = true

/**
 * [PHASE 6T] The conditional fairness rule, stated now and NOT implemented.
 *
 * Exported so the dependency is machine-visible: when a requeueing authority
 * appears, this is the property that must hold, and `policy6t.test.ts` asserts
 * the current model satisfies the *unconditional* form.
 */
export const ANTISTARVATION_REQUIREMENT =
  "if a task can be requeued to PENDING after running, ORDER ASC alone is insufficient and selection must gain an age or attempt-count tiebreak"
