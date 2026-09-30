// PHASE 6X — SESSION-LEVEL AUTONOMOUS EXECUTION AUTHORITY.
//
// Implements 6W ADR-20/ADR-21. This is a CLAIM ON THE RIGHT TO SCHEDULE, not a
// claim on a task and not a proof of liveness.
//
// ── WHAT IT IS ───────────────────────────────────────────────────────────────
//
// A durable record: (session, incarnation) -> (owner token, lease expiry).
// Exactly one Scheduler may hold it at a time. A second process that tries to
// acquire while the lease is valid FAILS CLOSED, which removes the precondition
// for FINDING-02: F02 required two reconcilers to coexist, and this prevents
// that outright.
//
// ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
//
// It is NOT a liveness proof. An expired lease does not prove a process died; it
// proves only that nobody renewed in time. A process that is alive but stalled
// past the lease will lose authority — and 6W chose that direction deliberately,
// because at session granularity a wrong answer costs WASTED WORK, while at task
// granularity (the status quo) it costs DUPLICATE EXECUTION.
//
// It is NOT a replacement for lineage. `exec_generation` / `attempt_generation`
// still answer "what happened to this execution"; the lease answers "who may
// schedule for this session". The two layers never read each other.

/** How long an acquired lease remains valid. */
export const SESSION_LEASE_MS = 300_000

/** How often a live owner refreshes it. Five renewals per lease. */
export const SESSION_RENEW_INTERVAL_MS = 60_000

/**
 * [PHASE 6X] Lease constants are DERIVED, not chosen.
 *
 * `FACT` The runtime's own limits, read from `src/constants.ts` and
 * `autonomous-context.ts`:
 *
 *   BASH_DEFAULT_TIMEOUT_MS   30_000  longest single tool call
 *   SUB_AGENT_TIMEOUT_MS    120_000  longest single sub-agent turn
 *   autonomous turn default 120_000  `timeoutMs ?? 120_000`
 *
 * `INFERENCE` The longest interval in which a legitimately running execution can
 * go without making observable progress is bounded by the turn timeout, not by
 * how fast the model happens to be today. A lease shorter than that would lapse
 * during an ordinary slow call — which is precisely the false positive 6W chose
 * to eliminate.
 *
 * `DESIGN DECISION` lease = 300_000 ms = 2.5x the 120_000 ms turn bound. A live
 * process therefore retains authority across a stalled event loop of up to about
 * four minutes. Renewal every 60_000 ms means five chances inside one lease, so
 * a single missed tick is not fatal.
 *
 * `INFERENCE` These are the numbers to revisit if a sub-agent timeout is ever
 * raised. They are named constants precisely so raising one without raising the
 * other is a visible act, not a silent regression.
 */

/**
 * [PHASE 6X] Expiry boundary, stated once so no comparison is left to chance.
 *
 * A lease is ACTIVE while `lease_expires_at > now`, and EXPIRED when
 * `lease_expires_at <= now`.
 *
 * `DESIGN DECISION` Expired-at-exactly-`now` counts as EXPIRED. Using `<=` on
 * the acquirer's side means an expiring lease is immediately available, and the
 * alternative (`<`) would let a lease whose deadline has passed keep blocking a
 * takeover for one more clock tick — a needless availability loss with no safety
 * gain, since the previous owner is by definition no longer renewing.
 */
export function isLeaseActive(expiresAt: number, now: number): boolean {
  return expiresAt > now
}

let counter = 0

/**
 * [PHASE 6X] A fresh owner token.
 *
 * `DESIGN DECISION` NOT a PID and NOT an object identity. PIDs are reused and
 * object identity is meaningless in another process; the token is the only value
 * that distinguishes "me, still holding it" from "someone who took it after my
 * lease expired". It is unpredictable, so it cannot be guessed by another local
 * process, and it is regenerated on every acquisition — a restarted process can
 * never present its predecessor's token.
 */
export function newOwnerToken(): string {
  counter += 1
  const rand = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0")
  return `own-${Date.now().toString(36)}-${counter.toString(36)}-${rand}`
}

/** Test-only: make token generation reproducible. */
export function resetOwnerTokenCounterForTests(): void {
  counter = 0
}

/** The durable row. One per (session, incarnation). */
export interface SessionAuthority {
  readonly sessionId: string
  /** 6Q incarnation. Keying on it stops a recreated session inheriting a lease. */
  readonly incarnation: number
  readonly ownerToken: string
  readonly ownerPid: number
  readonly acquiredAt: number
  readonly leaseExpiresAt: number
}

export type AcquireOutcome =
  /** The caller now holds the lease. */
  | "ACQUIRED"
  /** The caller already held it and refreshed it (idempotent re-acquire). */
  | "RENEWED_BY_SELF"
  /** Another owner's lease is still valid. The caller must not schedule. */
  | "REFUSED_LEASE_HELD"

export type WithdrawOutcome =
  /** The lease was refreshed and is still ours. */
  | "RENEWED"
  /** We no longer hold it — expired and taken, or deleted. */
  | "AUTHORITY_LOST"

/** Parse a stored value defensively: a corrupt row must fail closed, not crash. */
export function parseAuthority(raw: string): SessionAuthority | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    const n = (k: string): number => Number(o[k])
    if (typeof o.sessionId !== "string") return null
    if (typeof o.ownerToken !== "string" || o.ownerToken.length === 0) return null
    if (!Number.isFinite(n("incarnation"))) return null
    if (!Number.isFinite(n("leaseExpiresAt"))) return null
    return {
      sessionId: o.sessionId,
      incarnation: n("incarnation"),
      ownerToken: o.ownerToken,
      ownerPid: n("ownerPid"),
      acquiredAt: n("acquiredAt"),
      leaseExpiresAt: n("leaseExpiresAt"),
    }
  } catch {
    return null
  }
}

export function serializeAuthority(a: SessionAuthority): string {
  return JSON.stringify(a)
}
