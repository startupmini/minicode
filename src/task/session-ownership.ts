// Phase 6B — session ownership, so reconciliation can fail closed.
//
// NEW ARCHITECTURE. This is the P3 prerequisite for the Phase 6A reconciliation
// contract. It is deliberately small, process-local, and honest about what it
// cannot guarantee.
//
// ── THE PROBLEM ──────────────────────────────────────────────────────────────
//
// 6A allows reconciliation to revert stranded `IN_PROGRESS` / `VERIFYING` work
// back to `PENDING`. That is only safe if the execution context that owns them
// is gone. Without any ownership signal, a reconciler cannot tell "stranded by a
// crash" from "actively running right now in another context", and reverting
// live work is worse than not reconciling at all.
//
// ── WHAT WAS EVALUATED (6B §8) ──────────────────────────────────────────────
//
// VERIFIED, all in the current source:
//
//   A. deployment invariant  — viable, and the only one expressible with no new
//                              durable state. Adopted, but as a *convention*
//                              plus a mechanical guard, never as a promise.
//   B. process-local owner   — ADOPTED here. Explicit, testable, Windows/Bun
//                              safe, no second task authority.
//   C. durable owner row     — REJECTED. `task_meta` could hold one, but that is
//                              a new durable authority, which 6B §19 lists as a
//                              stop condition.
//   D. OS / process lock     — REJECTED. `src/lib/safe-open.ts` uses `O_EXCL`
//                              for atomic writes, not session locking; there is
//                              no session lock to reuse.
//   E. lease / heartbeat     — REJECTED. Explicitly out of V1 scope. A lease also
//                              cannot survive a machine crash without expiry
//                              logic, i.e. it would be a second authority.
//   F. existing mechanism    — `src/session/journal.ts` "advisory" refers to
//                              DEGRADED JOURNAL HEALTH under append failure, not
//                              session ownership. Not a candidate.
//
// ── THE LIMITATION, LOCKED RATHER THAN PAPERED OVER ─────────────────────────
//
// This registry is PROCESS-LOCAL. It cannot see another OS process. Therefore:
//
//   * If this process does not own the session, reconciliation REFUSES.
//   * If another process DOES own the session, this process still sees
//     "not owned" and refuses. The refusal is the safe direction: the cost of a
//     false refusal is that stranded work waits, which is recoverable; the cost
//     of a false reconciliation is reverting live work, which may not be.
//
//   So the guarantee is asymmetric and deliberately so: **safe against false
//     reconciliation, at the price of refusing cross-process reconciliation
//     entirely.** Cross-process reconciliation is therefore NOT IMPLEMENTED and
//     must not be enabled by removing this check.

/** Opaque identity of the in-process owner of a session. */
export type SessionOwner = { readonly token: symbol; readonly label: string }

export type ReleaseReason = "stopped" | "session-removed" | "replaced"

/**
 * One owner per session, per process.
 *
 * Module-level because ownership is a property of the PROCESS, not of any
 * TaskStore instance — two TaskStore instances over the same database in one
 * process must agree about who owns a session.
 *
 * It is the ONLY process-global state introduced by Phase 6B, and it holds
 * ownership only. It is not a task authority: it cannot read or write a task,
 * and every durable mutation still goes through TaskStore.
 */
const owners = new Map<string, SessionOwner>()

/**
 * Take ownership of `sessionId` for this process.
 *
 * A second acquisition of the same session is refused rather than silently
 * stealing, so a double-attach is visible instead of a silent last-writer-wins.
 */
export function acquireSessionOwnership(sessionId: string, label: string): SessionOwner | null {
  if (owners.has(sessionId)) return null
  const owner: SessionOwner = { token: Symbol(label), label }
  owners.set(sessionId, owner)
  return owner
}

/** True only when `owner` is the owner this process recorded for `sessionId`. */
export function ownsSession(sessionId: string, owner: SessionOwner | null | undefined): boolean {
  if (owner === null || owner === undefined) return false
  const current = owners.get(sessionId)
  return current !== undefined && current.token === owner.token
}

export function releaseSessionOwnership(
  sessionId: string,
  owner: SessionOwner,
  _reason: ReleaseReason = "stopped",
): boolean {
  if (!ownsSession(sessionId, owner)) return false
  owners.delete(sessionId)
  return true
}

/** Sessions currently owned by this process. Diagnostics only. */
export function ownedSessions(): readonly string[] {
  return [...owners.keys()]
}

/**
 * Test-only. Clears all ownership.
 *
 * NOT a production affordance: nothing outside tests may call this, because it
 * would let a caller manufacture the "not owned" state that reconciliation
 * needs in order to refuse.
 */
export function resetSessionOwnershipForTests(): void {
  owners.clear()
}
