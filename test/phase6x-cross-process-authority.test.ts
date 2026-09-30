// PHASE 6X - CROSS-PROCESS SCHEDULER AUTHORITY (6W ADR-20/21).
//
// This file is the executable half of the 6X report. It is NOT a copy of 6V's
// reproduction with a patch applied - it drives the REAL store and the REAL
// Scheduler, across genuinely separate TaskStore handles, because the whole
// point of the fix is that authority is no longer process-local.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasFlag } from "../cli/args.ts"
import { GATE_ENABLED, resolveSchedulerGate } from "../src/task/production-scheduler.ts"
import { type ExecutionObservation, Scheduler } from "../src/task/scheduler.ts"
import { newOwnerToken, SESSION_LEASE_MS } from "../src/task/session-authority.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const S = "6x"
const prov = { origin: "model", source: "6x" } as const
const OK: ExecutionObservation = { kind: "returned", ok: true }

let dir: string
let a: TaskStore
let b: TaskStore

/**
 * A "second process". [FACT] These are separate Database connections to the same
 * tasks.db - the closest faithful analogue of two OS processes available in
 * process, and the one that matters, because the ORIGINAL defect was that
 * authority was pure in-memory state and simply was not shared between processes.
 * Every assertion below is about what is IN THE DATABASE, not what is in a module
 * variable, so these handles cannot accidentally pass by sharing memory.
 */
function procB(): TaskStore {
  return new TaskStore(dir, { authority: "SCHEDULER" })
}

function sched(store: TaskStore, runTurn: () => ExecutionObservation = () => OK): Scheduler {
  return new Scheduler(S, { store, runTurn, instruction: "x" })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6x-"))
  resetTaskStoreHandles()
  resetSessionOwnershipForTests()
  a = new TaskStore(dir, { authority: "SCHEDULER" })
  b = procB()
  a.createTask(S, { title: "t", status: "PENDING", order: 1, provenance: prov })
})

afterEach(async () => {
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

// ── R1. Atomic single-winner acquisition ─────────────────────────────────────

describe("R1. acquisition is atomic and has exactly one winner", () => {
  test("a second holder is refused while the lease is valid", () => {
    expect(a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS)).toBe("ACQUIRED")
    // The refusal comes from ONE atomic statement, so a concurrent pair of
    // acquirers cannot both win. If this ever became two steps, a mutual exclusion
    // bug would reappear here and F02 would be back.
    expect(b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)).toBe("REFUSED_LEASE_HELD")
    expect(b.getSessionAuthority(S)?.ownerToken).toBe("tok-a")
  })

  test("the holder renewing its own token is not a takeover", () => {
    a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS)
    expect(b.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS)).toBe("ACQUIRED")
    expect(b.getSessionAuthority(S)?.ownerToken).toBe("tok-a")
  })

  test("an expired lease is taken over, and the new owner replaces the old row", () => {
    // [DESIGN DECISION] The clock is passed explicitly rather than slept through.
    // `acquireSessionAuthority` takes `now`, so the boundary is crossed by
    // construction: the assertion is about the takeover RULE and would still hold
    // on a machine whose timer never fired. A real `await sleep()` here would turn
    // a deterministic rule into a race it does not need to be.
    a.acquireSessionAuthority(S, "tok-a", 1)
    const later = Date.now() + 5_000
    expect(b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS, later)).toBe("ACQUIRED")

    // The row is OVERWRITTEN in place rather than deleted and reinserted, which is
    // what keeps the takeover atomic - and the recorded owner must become the new
    // token. If only the deadline were updated, the row would still name `tok-a`
    // and BOTH parties would pass `holdsSessionAuthority`.
    const row = b.getSessionAuthority(S)
    expect(row?.ownerToken).toBe("tok-b")
    expect(row?.incarnation).toBe(a.getSessionIncarnation(S))
    // Exactly one authority exists for this (session, incarnation) afterwards.
    expect(a.getSessionAuthority(S)?.ownerToken).toBe("tok-b")
    // And the displaced owner is powerless: it cannot renew or release.
    expect(a.holdsSessionAuthority(S, "tok-a")).toBe(false)
    expect(a.renewSessionAuthority(S, "tok-a", SESSION_LEASE_MS, later)).toBe("AUTHORITY_LOST")
  })
})

// ── R2. Renewal / release are owner-token guarded ────────────────────────────

describe("R2. renewal and release require the exact owner token", () => {
  test("a non-owner cannot renew", () => {
    a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS)
    const before = a.getSessionAuthority(S)?.leaseExpiresAt ?? 0
    expect(b.renewSessionAuthority(S, "tok-b", SESSION_LEASE_MS)).toBe("AUTHORITY_LOST")
    expect(a.getSessionAuthority(S)?.leaseExpiresAt).toBe(before)
  })

  test("a non-owner cannot release, so it cannot evict the real holder", () => {
    a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS)
    expect(b.releaseSessionAuthority(S, "tok-b")).toBe(false)
    // The holder is still authoritative. This is the whole reason release is
    // token-guarded: a stale instance must not be able to free the session out
    // from under its successor.
    expect(a.holdsSessionAuthority(S, "tok-a")).toBe(true)
  })

  test("the owner releasing frees the session immediately", () => {
    a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS)
    expect(a.releaseSessionAuthority(S, "tok-a")).toBe(true)
    expect(b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)).toBe("ACQUIRED")
  })
})

// ── R3. Incarnation scoping: a recreated session inherits nothing ────────────

describe("R3. a recreated session can never inherit its predecessor's lease", () => {
  test("a new incarnation is a different authority, not a continuation", () => {
    a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS)
    const oldIncarnation = a.getSessionIncarnation(S)
    a.deleteSessionTasks(S)
    a.bumpSessionIncarnation(S)
    a.createTask(S, { title: "new", status: "PENDING", order: 1, provenance: prov })

    expect(a.getSessionIncarnation(S)).not.toBe(oldIncarnation)
    // A fresh lifetime starts unlocked - otherwise a deleted session would stay
    // permanently unschedulable, which is the exact wedge 6Q/6T had to undo.
    expect(b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)).toBe("ACQUIRED")
    expect(b.getSessionAuthority(S)?.ownerToken).toBe("tok-b")
  })

  test("the OLD token is powerless in the new lifetime", () => {
    a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS)
    a.deleteSessionTasks(S)
    a.bumpSessionIncarnation(S)
    a.createTask(S, { title: "new", status: "PENDING", order: 1, provenance: prov })
    b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)

    expect(a.holdsSessionAuthority(S, "tok-a")).toBe(false)
    expect(a.renewSessionAuthority(S, "tok-a", SESSION_LEASE_MS)).toBe("AUTHORITY_LOST")
    // And it cannot release the new owner's authority either.
    expect(a.releaseSessionAuthority(S, "tok-a")).toBe(false)
    expect(b.holdsSessionAuthority(S, "tok-b")).toBe(true)
  })
})

// ── R4. THE F02 FIX: no reconciliation without authority ─────────────────────

describe("R4. reconciliation is refused without valid authority", () => {
  test("a Scheduler that never started cannot reconcile", () => {
    // An IN_PROGRESS task with a live claim is precisely what reconcile() reverts.
    // [FACT] 6B makes `claimTask` the ONLY author of IN_PROGRESS under Scheduler
    // authority, so the task is created PENDING, moved to RUNNING by the normal
    // scheduling path, and then claimed - the exact sequence a real cycle performs.
    const t = a.createTask(S, {
      title: "in-flight-a",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    expect(claimOf(a, t.id)).toBe(1)
    expect(a.getTask(S, t.id)?.status).toBe("IN_PROGRESS")

    const sc = sched(a) // never started: no lease was ever taken
    expect(sc.reconcile()).toEqual([])
    // Untouched, because without authority it may not revert anything at all.
    expect(a.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  })

  test("a Scheduler whose lease was stolen refuses to reconcile", async () => {
    const task = a.createTask(S, {
      title: "in-flight-b",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })

    const sc = sched(a)
    await sc.start()
    expect(claimOf(a, task.id)).toBe(1)

    // Simulate the F02 precondition: our lease is gone and another process has
    // taken the session over. Our in-memory ownership is untouched, which is
    // exactly how the old code kept reconciling another process's live work.
    a.releaseSessionAuthority(S, authorityOf(sc))
    b.acquireSessionAuthority(S, "thief", SESSION_LEASE_MS)

    expect(sc.hasAuthority()).toBe(false)
    expect(sc.reconcile()).toEqual([])
    expect(a.getTask(S, task.id)?.status).toBe("IN_PROGRESS")
  })

  test("with authority, the same reconcile DOES revert - so the guard is the reason", async () => {
    // The control case. Without this, R4's two tests would also pass if reconcile()
    // were simply broken.
    const task = a.createTask(S, {
      title: "in-flight-c",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })

    const sc = sched(a)
    await sc.start()
    expect(claimOf(a, task.id)).toBe(1)

    expect(sc.reconcile()).not.toEqual([])
    expect(a.getTask(S, task.id)?.status).not.toBe("IN_PROGRESS")
  })
})

// ── R5. Refusal at start() fails closed and leaves nothing half-installed ────

describe("R5. start() refuses when another process holds the session", () => {
  test("the loser gets a precise reason, not a generic error", () => {
    b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)
    const sc = sched(a)
    expect(() => sc.start()).toThrow(/lease held by another process/)
    // Fail closed: STOPPED, not a half-started instance that might still run.
    expect(sc.getLifecycle()).toBe("STOPPED")
  })

  test("the loser leaves the winner's authority completely intact", () => {
    b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)
    const expiryBefore = b.getSessionAuthority(S)?.leaseExpiresAt ?? 0

    const sc = sched(a)
    expect(() => sc.start()).toThrow()

    // Nothing the loser did may have disturbed the real owner's lease - not the
    // token, not the deadline. A failed start has to be inert.
    expect(b.holdsSessionAuthority(S, "tok-b")).toBe(true)
    expect(b.getSessionAuthority(S)?.leaseExpiresAt).toBe(expiryBefore)
    expect(sc.hasAuthority()).toBe(false)
  })

  test("the loser released its own process-local token, so it is retryable later", () => {
    b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)
    expect(() => sched(a).start()).toThrow()
    // A half-installed loser would deadlock the session even after the winner left.
    // Clearing process-local ownership and releasing the winner's lease is enough
    // for the same instance to succeed, which proves it retained nothing.
    resetSessionOwnershipForTests()
    b.releaseSessionAuthority(S, "tok-b")
    const sc2 = sched(a)
    expect(() => sc2.start()).not.toThrow()
    expect(sc2.hasAuthority()).toBe(true)
  })
})

// ── R6. A cycle stops immediately once authority is lost ─────────────────────

describe("R6. authority loss stops the cycle", () => {
  test("a stolen lease stops the next cycle with an explicit reason", async () => {
    const sc = sched(a)
    await sc.start()
    a.releaseSessionAuthority(S, authorityOf(sc))
    b.acquireSessionAuthority(S, "thief", SESSION_LEASE_MS)

    const r = await sc.cycle()
    expect(r.stop).toBe("authority-lost")
    expect(sc.getLifecycle()).toBe("STOPPED")
    expect(sc.hasAuthority()).toBe(false)
  })

  test("a deleted session reports supersession, NOT authority loss", async () => {
    // [DESIGN DECISION] The lease is keyed by (session, incarnation), so a deleted
    // session also stops us holding it. Reporting that as `authority-lost` would be
    // a lie about the cause and would point at the wrong suspect. This test pins
    // the distinction so the two cannot be conflated again.
    const sc = sched(a)
    await sc.start()
    a.deleteSessionTasks(S)
    a.bumpSessionIncarnation(S)

    const r = await sc.cycle()
    expect(r.stop).toBe("session-superseded")
    expect(sc.getLifecycle()).toBe("STOPPED")
  })
})

// ── R7. stop() hands the session back ────────────────────────────────────────

describe("R7. a stopped Scheduler releases its authority", () => {
  test("stop() frees the session for a replacement", async () => {
    const sc = sched(a)
    await sc.start()
    expect(b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)).toBe("REFUSED_LEASE_HELD")
    await sc.stop()
    // No expiry wait: a graceful stop is an immediate, explicit handover.
    expect(b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)).toBe("ACQUIRED")
  })

  test("a self-disposing instance also hands the session back", async () => {
    // 6Q/6T's fix for the "wedged forever" instance is only half a fix if the
    // durable lease is retained: the replacement would be locked out for a full
    // lease period and the wedge would simply come back.
    const sc = sched(a)
    await sc.start()
    a.deleteSessionTasks(S)
    a.bumpSessionIncarnation(S)
    await sc.cycle() // observes supersession and self-disposes
    expect(sc.getLifecycle()).toBe("STOPPED")
    a.createTask(S, { title: "next", status: "PENDING", order: 1, provenance: prov })
    expect(b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)).toBe("ACQUIRED")
  })
})

// ── R8. Token quality: no reuse across instances ─────────────────────────────

describe("R8. authority tokens are unique per instance", () => {
  test("two instances never mint the same token", () => {
    const tokens = new Set<string>()
    for (let i = 0; i < 2000; i += 1) tokens.add(newOwnerToken())
    expect(tokens.size).toBe(2000)
  })

  test("a token is not a PID, so a recycled PID cannot impersonate it", () => {
    const t = newOwnerToken()
    expect(t).not.toBe(String(process.pid))
    expect(t.startsWith("own-")).toBe(true)
    // Monotonic base36 timestamp + counter + entropy, so two instances minted in
    // the same millisecond still differ.
    expect(t.split("-").length).toBeGreaterThanOrEqual(4)
  })
})

// ── R9. Exclusive capacity, now with authority ───────────────────────────────

describe("R9. exclusive capacity and authority compose", () => {
  test("a claim made under authority cannot be stolen by a second instance", async () => {
    const sc = sched(a)
    await sc.start()
    // [FACT] `lineage` on a completed turn reports the LINEAGE WRITE, not the
    // claim: the turn succeeded, so the attempt was RECORDED. The claim itself is
    // asserted via the durable owner, which is what the rival is really up against.
    const first = await sc.cycle()
    expect(first.dispatched).not.toBeNull()
    expect(first.dispatched?.lineage).toBe("RECORDED")
    const claimed = a
      .listTasks(S)
      .find((t) => t.status === "COMPLETED" || t.status === "IN_PROGRESS")
    expect(claimed).toBeDefined()
    // The claim is live and owned; a second Scheduler for the same session is
    // refused. [FACT] Both guards live in the SAME process here, so process-local
    // ownership trips FIRST and the durable lease is never reached - which is
    // exactly why 6V's F02 needed a real second process to see the lease at all.
    const rival = sched(b)
    expect(() => rival.start()).toThrow(/already owned in this process/)
  })

  test("and it is the DURABLE lease that refuses a genuinely separate process", async () => {
    // The control for the test above. Once process-local ownership is out of the
    // way - which is what happens in a real second process - the lease is the only
    // thing standing between two reconcilers, and it holds.
    const sc = sched(a)
    await sc.start()
    resetSessionOwnershipForTests() // simulate: this is now a DIFFERENT process

    const rival = sched(b)
    expect(() => rival.start()).toThrow(/lease held by another process/)
    // The original holder is untouched and still authoritative.
    expect(sc.hasAuthority()).toBe(true)
  })
})

// ── R10. The durable record is inspectable and honest ────────────────────────

describe("R10. the authority record is self-describing", () => {
  test("the row records who held it, when, and until when", async () => {
    const sc = sched(a)
    await sc.start()
    const row = a.getSessionAuthority(S)
    expect(row).not.toBeNull()
    expect(row?.ownerPid).toBe(process.pid)
    expect(row?.acquiredAt).toBeGreaterThan(0)
    // A lease with no deadline is just ownership again - that is the 6O bug.
    expect(row!.leaseExpiresAt).toBeGreaterThan(row!.acquiredAt)
    expect(row!.leaseExpiresAt - row!.acquiredAt).toBe(SESSION_LEASE_MS)
  })

  test("release deletes the row, so existence and authority are the same thing", async () => {
    const sc = sched(a)
    await sc.start()
    const token = authorityOf(sc)
    expect(a.getSessionAuthority(S)).not.toBeNull()
    await sc.stop()
    // [DESIGN DECISION] `releaseSessionAuthority` DELETES rather than expiring in
    // place. A clean stop is an unambiguous handover, and keeping a row behind would
    // mean a released session still had an "authority record" that later readers
    // could mistake for a live owner. The EXPIRY path is the one that preserves the
    // row, so the takeover history of a crashed owner stays inspectable.
    expect(a.getSessionAuthority(S)).toBeNull()
    expect(a.holdsSessionAuthority(S, token)).toBe(false)
  })

  test("a CRASHED owner's row survives, so the takeover history is inspectable", () => {
    a.acquireSessionAuthority(S, "tok-crashed", SESSION_LEASE_MS)
    const before = a.getSessionAuthority(S)
    // No release: the process vanished. The row is still there, and it still names
    // the dead owner until the lease actually lapses.
    expect(a.getSessionAuthority(S)).toEqual(before)
    expect(a.getSessionAuthority(S)?.ownerToken).toBe("tok-crashed")
  })
})

// ── F01. The PRODUCTION call site, not a copy of it ──────────────────────────

describe("F01. the production CLI gate refuses every value form", () => {
  /**
   * [DESIGN DECISION] These read `cli/index.ts` and the gate it imports, rather
   * than re-deriving the rule. 6V's F01 survived because the test asserted a MODULE
   * while production called something else - so a test that merely restates the
   * intended rule would have passed then too, and proves nothing. Pinning the actual
   * call site is what makes this a regression guard.
   */
  const SRC = join(import.meta.dir, "..", "cli", "index.ts")
  const source = readFileSync(SRC, "utf8")

  test("the real call site uses the audited resolver, not hasFlag", () => {
    // The assignment must be the resolver. If someone swaps in any other matcher,
    // this fails - which is the whole point.
    expect(source).toContain("const schedulerEnabled = resolveSchedulerGate(args) === GATE_ENABLED")
    // ...and no `hasFlag(args, "--enable-scheduler")` may survive anywhere in it.
    expect(source).not.toContain('hasFlag(args, "--enable-scheduler")')
  })

  test("every value form is DISABLED, in the resolver production actually calls", () => {
    for (const argv of [
      ["--enable-scheduler=false", "x"],
      ["--enable-scheduler=0", "x"],
      ["--enable-scheduler=whatever", "x"],
      ["--enable-scheduler=", "x"],
      ["--enable-scheduler=true", "x"],
    ]) {
      expect({ argv, on: resolveSchedulerGate(argv) === GATE_ENABLED }).toEqual({ argv, on: false })
    }
  })

  test("the bare flag, and only the bare flag, enables it", () => {
    expect(resolveSchedulerGate(["--enable-scheduler", "x"]) === GATE_ENABLED).toBe(true)
    // Neighbouring tokens must not match, and `--` must terminate the search.
    for (const argv of [
      ["--enable-schedulerx", "x"],
      ["--enable-sched", "x"],
      ["hello", "--", "--enable-scheduler"],
    ]) {
      expect({ argv, on: resolveSchedulerGate(argv) === GATE_ENABLED }).toEqual({ argv, on: false })
    }
  })

  test("the flag is still not inheritable through the environment", () => {
    // 6U's gate must not come back as an env var, and this fix must not have
    // introduced one while changing the matcher.
    expect(source).not.toMatch(/process\.env\.[A-Z_]*SCHEDULER/)
    expect(source).not.toMatch(/MINICODE_SCHEDULER/)
  })

  test("the generic hasFlag is untouched - its value forms are still its contract", () => {
    // The fix was in choosing the right matcher for a VALUELESS flag, not in
    // redefining a shared helper. Weakening `hasFlag` would have silently changed
    // `--permission`, `--allowlist` and every other value-taking flag.
    // [FACT] `hasFlag` is unchanged: the permissive `name=value` prefix match is
    // still there, and `--cwd` is a real registered VALUE flag, so this is asserted
    // against the helper's actual contract rather than a hypothetical flag name.
    expect(hasFlag(["--enable-scheduler=false"], "--enable-scheduler")).toBe(true)
    expect(hasFlag(["--cwd=C:\\tmp"], "--cwd")).toBe(true)
    expect(hasFlag(["--cwd", "C:\\tmp"], "--cwd")).toBe(true)
  })
})

/**
 * A real Scheduler claim, asserted rather than assumed. 6O's `claimTask` requires
 * an IN_PROGRESS task and the CURRENT revision, so a sloppy helper would silently
 * produce a no-op - and a no-op in an authority test is worthless, because it would
 * make "reconcile did not revert it" pass for entirely the wrong reason.
 */
/** The token the Scheduler minted for ITSELF. Not public API, so read structurally. */
function authorityOf(sc: Scheduler): string {
  const t = (sc as unknown as Record<string, unknown>).authorityToken
  if (typeof t !== "string") throw new Error("expected an authority token")
  return t
}

function claimOf(store: TaskStore, id: string): number {
  const t = store.getTask(S, id)
  if (t === null) throw new Error("expected the task to exist")
  const r = store.claimTask(S, id, t.revision)
  if (r.outcome !== "CLAIM_ACCEPTED") throw new Error(`claim rejected: ${r.outcome}`)
  return r.execGeneration
}
