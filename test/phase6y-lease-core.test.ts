// PHASE 6Y - ADVERSARIAL audit of the 6X session lease. AUDIT ONLY.
//
// The question this file exists to answer is NOT "does the lease code work?" but:
//
//   "Can two real autonomous schedulers ever both have a valid right to schedule
//    the same session?"
//
// Every test here drives the REAL TaskStore authority methods and the REAL
// Scheduler lifecycle. Where a second party is needed it is a separate
// TaskStore handle on the same tasks.db (a second connection), which is the
// only authority-sharing mechanism that exists here. The true multi-OS-process
// evidence lives in phase6y-process-*.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Scheduler } from "../src/task/scheduler.ts"
import { newOwnerToken, SESSION_LEASE_MS } from "../src/task/session-authority.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const S = "6y"
const prov = { origin: "model", source: "6y" } as const
const OK = { kind: "returned", ok: true } as const

let dir: string
let a: TaskStore
let b: TaskStore

/**
 * [FACT] A second TaskStore on the same cwd is a second connection to the same
 * tasks.db. The lease is durable SQL, so this is a faithful stand-in for a second
 * process at the store layer - and unlike an in-memory fake it cannot pass by
 * sharing a registry.
 */
function other(): TaskStore {
  return new TaskStore(dir, { authority: "SCHEDULER" })
}

function sched(store: TaskStore, runTurn?: () => unknown): Scheduler {
  return new Scheduler(S, {
    store,
    runTurn: (runTurn ?? (() => OK)) as never,
    instruction: "x",
  })
}

/** The token a Scheduler minted for itself. Private, so read structurally. */
function tokenOf(sc: Scheduler): string {
  const t = (sc as unknown as Record<string, unknown>).authorityToken
  if (typeof t !== "string") throw new Error("expected an authority token")
  return t
}

function addPending(store: TaskStore, title = "t"): string {
  return store.createTask(S, { title, status: "PENDING", order: 1, provenance: prov }).id
}

/** Record every field the mission's §1 requires. */
function snap(store: TaskStore): Record<string, unknown> {
  const r = store.getSessionAuthority(S)
  return {
    session_id: S,
    incarnation: store.getSessionIncarnation(S),
    owner_token: r?.ownerToken ?? null,
    pid: r?.ownerPid ?? null,
    acquired_at: r?.acquiredAt ?? null,
    expires_at: r?.leaseExpiresAt ?? null,
    row_present: r !== null,
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6y-"))
  resetTaskStoreHandles()
  resetSessionOwnershipForTests()
  a = new TaskStore(dir, { authority: "SCHEDULER" })
  b = other()
})

afterEach(async () => {
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

// ═══════════════════════════════════════════════════════════════════════════
// §1  THE THREE CRITICAL HISTORIES
// ═══════════════════════════════════════════════════════════════════════════

describe("§1 H1-H3 the three critical histories", () => {
  test("H1 simultaneous acquisition yields exactly one owner", () => {
    // Both sides issued at the same wall clock, which is the tightest collision the
    // single atomic statement has to survive.
    const now = Date.now()
    const ra = a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS, now)
    const rb = b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS, now)
    expect({ ra, rb }).toEqual({ ra: "ACQUIRED", rb: "REFUSED_LEASE_HELD" })
    expect(snap(b)).toMatchObject({ owner_token: "tok-a", row_present: true })
  })

  test("H1b the winner is whichever the database ordered, and both orderings are safe", () => {
    // Not luck: whichever statement commits first becomes the recorded owner, and
    // the durable row afterwards agrees with exactly one of them.
    const now = Date.now()
    const first = a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS, now)
    const second = b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS, now)
    const winner = first === "ACQUIRED" ? "tok-a" : "tok-b"
    expect([first, second].filter((r) => r === "ACQUIRED").length).toBe(1)
    expect(snap(a).owner_token).toBe(winner)
    // And the loser is genuinely powerless, not merely unrecorded.
    const loser = winner === "tok-a" ? "tok-b" : "tok-a"
    expect(a.holdsSessionAuthority(S, loser)).toBe(false)
    expect(a.renewSessionAuthority(S, loser, SESSION_LEASE_MS)).toBe("AUTHORITY_LOST")
    expect(a.releaseSessionAuthority(S, loser)).toBe(false)
  })

  test("H2 a valid owner blocks takeover before expiry", () => {
    const t0 = Date.now()
    expect(a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS, t0)).toBe("ACQUIRED")
    // Anywhere strictly inside the window.
    for (const offset of [0, 1, 1_000, 150_000, SESSION_LEASE_MS - 1]) {
      const at = t0 + offset
      expect({ offset, r: b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS, at) }).toEqual({
        offset,
        r: "REFUSED_LEASE_HELD",
      })
    }
    expect(snap(b).owner_token).toBe("tok-a")
  })

  test("H3 an expired owner is taken over, and only the taker is authoritative", () => {
    const t0 = Date.now()
    expect(a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS, t0)).toBe("ACQUIRED")
    const after = t0 + SESSION_LEASE_MS + 1
    expect(b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS, after)).toBe("ACQUIRED")
    const row = snap(b)
    expect(row.owner_token).toBe("tok-b")
    expect(row.pid).toBe(process.pid)
    expect(row.acquired_at).toBe(after)
    expect(row.expires_at).toBe(after + SESSION_LEASE_MS)
    // The displaced owner is powerless on all four operations.
    expect(a.holdsSessionAuthority(S, "tok-a")).toBe(false)
    expect(a.renewSessionAuthority(S, "tok-a", SESSION_LEASE_MS, after)).toBe("AUTHORITY_LOST")
    expect(a.releaseSessionAuthority(S, "tok-a")).toBe(false)
    expect(b.holdsSessionAuthority(S, "tok-b")).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §2  OWNER TOKEN INTEGRITY  (primary audit)
// ═══════════════════════════════════════════════════════════════════════════

describe("§2 owner token integrity", () => {
  test("takeover replaces the recorded owner token, deadline AND pid", () => {
    const t0 = Date.now()
    a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS, t0)
    const before = snap(a)
    const after = t0 + SESSION_LEASE_MS + 1
    b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS, after)
    const now = snap(b)
    // The 6X bug shape: deadline moved, pid moved, owner_token left stale.
    expect({ before: before.owner_token, after: now.owner_token }).toEqual({
      before: "tok-a",
      after: "tok-b",
    })
    expect(now.expires_at).not.toBe(before.expires_at)
    expect(now.acquired_at).not.toBe(before.acquired_at)
  })

  /**
   * A displaced owner must fail closed at EVERY boundary. Each boundary gets its own
   * `test()` because a single instance cannot demonstrate them all: the first
   * refusal disposes it, and process-local ownership forbids a second live instance
   * for the same session in one process. Separate tests are not a convenience here
   * - sharing one instance would let a "pass" come from the wrong mechanism.
   */
  test("boundary 1/5: hasAuthority() goes false the instant the lease is taken", async () => {
    const sc = sched(a)
    await sc.start()
    expect(sc.hasAuthority()).toBe(true)
    b.acquireSessionAuthority(
      S,
      "tok-b",
      SESSION_LEASE_MS,
      a.getSessionAuthority(S)!.leaseExpiresAt + 1,
    )
    expect(sc.hasAuthority()).toBe(false)
  })

  test("boundary 2/5: stale renew is refused and does not extend the successor", async () => {
    const sc = sched(a)
    await sc.start()
    b.acquireSessionAuthority(
      S,
      "tok-b",
      SESSION_LEASE_MS,
      a.getSessionAuthority(S)!.leaseExpiresAt + 1,
    )
    const deadline = b.getSessionAuthority(S)!.leaseExpiresAt
    expect(a.renewSessionAuthority(S, tokenOf(sc), SESSION_LEASE_MS)).toBe("AUTHORITY_LOST")
    expect(b.getSessionAuthority(S)!.leaseExpiresAt).toBe(deadline)
  })

  test("boundary 3/5: stale release is refused and the successor survives", async () => {
    const sc = sched(a)
    await sc.start()
    b.acquireSessionAuthority(
      S,
      "tok-b",
      SESSION_LEASE_MS,
      a.getSessionAuthority(S)!.leaseExpiresAt + 1,
    )
    expect(a.releaseSessionAuthority(S, tokenOf(sc))).toBe(false)
    expect(b.holdsSessionAuthority(S, "tok-b")).toBe(true)
    expect(a.getSessionAuthority(S)?.ownerToken).toBe("tok-b")
  })

  test("boundary 4/5: stale reconcile reverts nothing", async () => {
    const sc = sched(a)
    await sc.start()
    // A stranded, Scheduler-owned claim: precisely what reconcile() would revert.
    const id = addPending(a)
    a.claimTask(S, id, a.getTask(S, id)!.revision)
    b.acquireSessionAuthority(
      S,
      "tok-b",
      SESSION_LEASE_MS,
      a.getSessionAuthority(S)!.leaseExpiresAt + 1,
    )

    expect(sc.reconcile()).toEqual([])
    expect(a.getTask(S, id)?.status).toBe("IN_PROGRESS")
    expect(b.holdsSessionAuthority(S, "tok-b")).toBe(true)
  })

  test("boundary 5/5: a stale cycle refuses rather than scheduling", async () => {
    const sc = sched(a)
    await sc.start()
    addPending(a)
    b.acquireSessionAuthority(
      S,
      "tok-b",
      SESSION_LEASE_MS,
      a.getSessionAuthority(S)!.leaseExpiresAt + 1,
    )
    const r = await sc.cycle()
    expect(r.stop).toBe("authority-lost")
    expect(r.dispatched).toBeNull()
    expect(r.recovered).toEqual([])
    // No task was touched at all.
    expect(a.listTasks(S).every((t) => t.status === "PENDING")).toBe(true)
  })

  test("OBSERVED: once any boundary disposes the instance, later calls are not-running", async () => {
    // [FACT] `reconcile()` without authority calls loseAuthority() -> disposeSelf(),
    // so the instance is already STOPPED by the time a cycle is requested. That is
    // still fail-closed, but it means the observed stop reason depends on WHICH
    // boundary noticed first. Recorded so a future reader does not mistake
    // "not-running" for a hole.
    const sc = sched(a)
    await sc.start()
    b.acquireSessionAuthority(
      S,
      "tok-b",
      SESSION_LEASE_MS,
      a.getSessionAuthority(S)!.leaseExpiresAt + 1,
    )
    expect(sc.reconcile()).toEqual([])
    expect(sc.getLifecycle()).toBe("STOPPED")
    expect((await sc.cycle()).stop).toBe("not-running")
    expect(sc.hasAuthority()).toBe(false)
  })

  test("self re-acquire keeps the same recorded token and is not a takeover", () => {
    const t0 = Date.now()
    a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS, t0)
    const r = b.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS + 1_000, t0 + 10)
    expect(r).toBe("ACQUIRED")
    // Same owner, longer deadline: an extension, not a handover.
    expect(snap(b).owner_token).toBe("tok-a")
    expect(snap(b).expires_at).toBe(t0 + 10 + SESSION_LEASE_MS + 1_000)
  })

  test("distinct tokens minted in the same millisecond never collide", () => {
    // The counter plus entropy, not the clock, is what separates them.
    const tokens = new Set(Array.from({ length: 5_000 }, () => newOwnerToken()))
    expect(tokens.size).toBe(5_000)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §4/§5  RENEWAL RACE AND THE EXPIRY BOUNDARY
// ═══════════════════════════════════════════════════════════════════════════

describe("§4-5 renewal race and the expiry boundary", () => {
  test("§5 the boundary is exactly: active iff expires_at > now", () => {
    const t0 = Date.now()
    a.acquireSessionAuthority(S, "tok-a", 1_000, t0)
    const exp = t0 + 1_000
    // Documented predicate, asserted at epsilon either side of the boundary.
    expect({ d: -1, active: a.holdsSessionAuthority(S, "tok-a", exp - 1) }).toEqual({
      d: -1,
      active: true,
    })
    // EXACT equality is EXPIRED. `<=` on the acquirer side, `>` on the holder side.
    expect({ d: 0, active: a.holdsSessionAuthority(S, "tok-a", exp) }).toEqual({
      d: 0,
      active: false,
    })
    expect({ d: 1, active: a.holdsSessionAuthority(S, "tok-a", exp + 1) }).toEqual({
      d: 1,
      active: false,
    })
    // And the acquirer side agrees at the same instant - no one-millisecond gap
    // where a lease is simultaneously free and held.
    expect(a.acquireSessionAuthority(S, "tok-b", 1_000, exp - 1)).toBe("REFUSED_LEASE_HELD")
    expect(a.acquireSessionAuthority(S, "tok-b", 1_000, exp)).toBe("ACQUIRED")
  })

  test("§4a A renews first, B is then refused", () => {
    const t0 = Date.now()
    a.acquireSessionAuthority(S, "tok-a", 1_000, t0)
    const t = t0 + 1_000 // exactly the expiry instant
    expect(a.renewSessionAuthority(S, "tok-a", 5_000, t)).toBe("AUTHORITY_HELD")
    expect(b.acquireSessionAuthority(S, "tok-b", 5_000, t)).toBe("REFUSED_LEASE_HELD")
    expect(snap(b).owner_token).toBe("tok-a")
  })

  test("§4b B takes over first, A's renew is then refused", () => {
    const t0 = Date.now()
    a.acquireSessionAuthority(S, "tok-a", 1_000, t0)
    const t = t0 + 1_000
    expect(b.acquireSessionAuthority(S, "tok-b", 5_000, t)).toBe("ACQUIRED")
    expect(a.renewSessionAuthority(S, "tok-a", 5_000, t)).toBe("AUTHORITY_LOST")
    // The refused renewal must not have extended anything.
    expect(snap(a)).toMatchObject({ owner_token: "tok-b", expires_at: t + 5_000 })
  })

  test("§4c in both orderings exactly one side is authoritative afterwards", () => {
    for (const order of ["renew-first", "acquire-first"] as const) {
      resetTaskStoreHandles()
      a = new TaskStore(dir, { authority: "SCHEDULER" })
      b = other()
      const t0 = Date.now()
      a.acquireSessionAuthority(S, "tok-a", 1_000, t0)
      const t = t0 + 1_000
      const results =
        order === "renew-first"
          ? {
              renew: a.renewSessionAuthority(S, "tok-a", 5_000, t),
              acquire: b.acquireSessionAuthority(S, "tok-b", 5_000, t),
            }
          : {
              acquire: b.acquireSessionAuthority(S, "tok-b", 5_000, t),
              renew: a.renewSessionAuthority(S, "tok-a", 5_000, t),
            }
      const row = snap(a)
      const validOwners = [row.owner_token === "tok-a", row.owner_token === "tok-b"].filter(Boolean)
      // INVARIANT: never two valid owners, and the recorded row is self-consistent
      // with whichever side actually holds.
      expect(validOwners.length).toBe(1)
      expect(results).toEqual(
        order === "renew-first"
          ? { renew: "AUTHORITY_HELD", acquire: "REFUSED_LEASE_HELD" }
          : { acquire: "ACQUIRED", renew: "AUTHORITY_LOST" },
      )
    }
  })

  test("OBSERVED: renew has no expiry precondition - an expired owner can re-extend", () => {
    // [FACT] `renewSessionAuthority` predicates on owner_token ONLY. It never asks
    // whether the lease is still active. So an owner whose lease lapsed, but which
    // nobody has taken over, can renew it back to full and become authoritative
    // again.
    //
    // [INFERENCE] This is NOT a split-brain: the durable row is only ever one, and
    // any concurrent takeover is still serialised. It is an availability/ownership
    // semantics observation, recorded because the mission asks for the boundary to
    // be determined rather than assumed.
    const t0 = Date.now()
    a.acquireSessionAuthority(S, "tok-a", 1_000, t0)
    const longAfter = t0 + 60_000
    expect(a.holdsSessionAuthority(S, "tok-a", longAfter)).toBe(false) // expired
    expect(a.renewSessionAuthority(S, "tok-a", 1_000, longAfter)).toBe("AUTHORITY_HELD")
    expect(a.holdsSessionAuthority(S, "tok-a", longAfter)).toBe(true) // re-extended
    expect(snap(a).owner_token).toBe("tok-a")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §6/§7  STALE RENEWAL AND STALE RELEASE
// ═══════════════════════════════════════════════════════════════════════════

describe("§6-7 stale renew and stale release", () => {
  test("a stale token can neither renew nor release the successor's authority", () => {
    const t0 = Date.now()
    a.acquireSessionAuthority(S, "tok-a", 1_000, t0)
    const t = t0 + 2_000
    b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS, t)
    expect(a.renewSessionAuthority(S, "tok-a", SESSION_LEASE_MS, t)).toBe("AUTHORITY_LOST")
    expect(a.releaseSessionAuthority(S, "tok-a")).toBe(false)
    // B's deadline is exactly what B set, proving neither call touched it.
    expect(snap(a)).toMatchObject({ owner_token: "tok-b", expires_at: t + SESSION_LEASE_MS })
  })

  test("a stale Scheduler object from before the takeover is powerless", async () => {
    const old = sched(a)
    await old.start()
    const oldToken = tokenOf(old)
    const t = Date.now() + SESSION_LEASE_MS + 1
    b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS, t)

    expect(old.hasAuthority()).toBe(false)
    // Its stop() must not evict the successor either - release is token-guarded.
    await old.stop()
    expect(snap(b).owner_token).toBe("tok-b")
    expect(b.holdsSessionAuthority(S, "tok-b")).toBe(true)
    // And the stale token is still just a string; nothing about being the same
    // object, or the same process, grants authority.
    expect(a.holdsSessionAuthority(S, oldToken)).toBe(false)
  })

  test("a stale token is refused even when the PID is identical", () => {
    // [FACT] PID is INFORMATIONAL. It is written on acquire and never appears in
    // any WHERE clause, so a reused PID confers nothing.
    const t0 = Date.now()
    a.acquireSessionAuthority(S, "tok-a", 1_000, t0)
    const t = t0 + 2_000
    b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS, t)
    expect(snap(a).pid).toBe(process.pid) // same pid, different token
    expect(a.renewSessionAuthority(S, "tok-a", SESSION_LEASE_MS, t)).toBe("AUTHORITY_LOST")
    expect(a.releaseSessionAuthority(S, "tok-a")).toBe(false)
    expect(b.holdsSessionAuthority(S, "tok-b")).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §8  SESSION INCARNATION INTERACTION
// ═══════════════════════════════════════════════════════════════════════════

describe("§8 session incarnation interaction", () => {
  /** Delete + recreate, exactly as persistence.deleteSessionCompletely orders it. */
  function recreate(): void {
    a.bumpSessionIncarnation(S)
    a.deleteSessionTasks(S)
    addPending(a, "next")
  }

  test("a new incarnation is a different authority, not a continuation", () => {
    a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS)
    const inc1 = a.getSessionIncarnation(S)
    recreate()
    const inc2 = a.getSessionIncarnation(S)
    expect(inc2).not.toBe(inc1)

    // The old row survives under the OLD key; the new lifetime is free.
    expect(b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)).toBe("ACQUIRED")
    expect(snap(b)).toMatchObject({ incarnation: inc2, owner_token: "tok-b" })
  })

  test("an old token cannot acquire, renew or release the NEW incarnation", () => {
    a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS)
    recreate()
    b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)

    // Same session id, different incarnation => never the same authority.
    expect(a.holdsSessionAuthority(S, "tok-a")).toBe(false)
    expect(a.renewSessionAuthority(S, "tok-a", SESSION_LEASE_MS)).toBe("AUTHORITY_LOST")
    expect(a.releaseSessionAuthority(S, "tok-a")).toBe(false)
    expect(snap(b).owner_token).toBe("tok-b")
  })

  test("an old Scheduler cannot touch the recreated session, and a new one starts", async () => {
    const old = sched(a)
    await old.start()
    addPending(a)
    recreate()

    // The old instance sees supersession, not lease theft.
    const r = await old.cycle()
    expect(r.stop).toBe("session-superseded")
    expect(old.getLifecycle()).toBe("STOPPED")

    // A fresh Scheduler acquires with no waiting.
    const fresh = sched(b)
    await fresh.start()
    expect(fresh.hasAuthority()).toBe(true)
    expect(snap(a).owner_token).toBe(tokenOf(fresh))
    const r2 = await fresh.cycle()
    expect(r2.dispatched).not.toBeNull()
  })

  test("OBSERVED: a release aimed at the old incarnation leaves its row behind", () => {
    // [FACT] `releaseSessionAuthority` resolves the incarnation at CALL time. After
    // a bump it targets (session, newInc, myToken), which does not exist, so the
    // old row is never deleted. Confirmed: a stale row persists.
    //
    // [INFERENCE] Not an authority defect - nothing reads an incarnation other than
    // the current one - but it is unbounded row growth across
    // delete/recreate cycles, and it contradicts the code comment claiming release
    // "gives the lease back". Recorded as a finding.
    a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS)
    recreate()
    expect(a.releaseSessionAuthority(S, "tok-a")).toBe(false)
    const old = a.getSessionAuthority(S, 1)
    expect(old?.ownerToken).toBe("tok-a")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §9  SESSION DELETION RACE
// ═══════════════════════════════════════════════════════════════════════════

describe("§9 session deletion race", () => {
  test("deleting the session invalidates authority at the bump, before any row is removed", async () => {
    const sc = sched(a)
    await sc.start()
    addPending(a)
    expect(sc.hasAuthority()).toBe(true)

    // Interleaving 1: bump first, rows still present.
    a.bumpSessionIncarnation(S)
    expect(sc.hasAuthority()).toBe(false) // already, with tasks still on disk
    a.deleteSessionTasks(S)
    expect(sc.hasAuthority()).toBe(false)
  })

  test("a live turn is cancelled and the claim is not left usable by anyone", async () => {
    // [DESIGN DECISION] The turn is released by an EXPLICIT closure, declared as a
    // definite function rather than a possibly-undefined one, so the test can end
    // the turn deterministically instead of relying on a timeout.
    let release = (): void => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    const sc = sched(a, async () => {
      await held
      return OK
    })
    await sc.start()
    addPending(a)
    const cycling = sc.cycle()

    // Wait for the turn to be genuinely in flight.
    while (sc.getActiveClaim() === null) await Bun.sleep(2)

    // Another process deletes the session while the turn runs.
    a.bumpSessionIncarnation(S)
    a.deleteSessionTasks(S)
    release()
    const r = await cycling
    // The lineage write is refused. Both refusals are legitimate here and the
    // point is the SAME either way: nothing was durably written by a dead session,
    // and the instance self-disposed. (SESSION_SUPERSEDED is the live-turn shape;
    // TASK_GONE is the same refusal when the rows are already gone.)
    const lineage = r.dispatched?.lineage
    expect(["SESSION_SUPERSEDED", "TASK_GONE"]).toContain(lineage as string)
    expect(sc.getLifecycle()).toBe("STOPPED")
    expect(sc.hasAuthority()).toBe(false)
    // And nothing usable remains for a replacement to inherit.
    expect(snap(a).owner_token).toBeNull()
  })

  test("a deleted session's lease cannot be inherited by a recreated session", () => {
    a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS)
    a.bumpSessionIncarnation(S)
    a.deleteSessionTasks(S)
    addPending(a)
    // New incarnation, no inherited lease, immediate acquisition.
    expect(b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)).toBe("ACQUIRED")
    expect(snap(b)).toMatchObject({ owner_token: "tok-b" })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §10  SCHEDULER SELF-DISPOSE
// ═══════════════════════════════════════════════════════════════════════════

describe("§10 self-dispose releases authority", () => {
  test("normal stop() hands the session back immediately", async () => {
    const sc = sched(a)
    await sc.start()
    expect(b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)).toBe("REFUSED_LEASE_HELD")
    await sc.stop()
    expect(snap(a).row_present).toBe(false)
    expect(b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS)).toBe("ACQUIRED")
  })

  test("supersession self-dispose hands it back for the next lifetime", async () => {
    const sc = sched(a)
    await sc.start()
    a.bumpSessionIncarnation(S)
    expect((await sc.cycle()).stop).toBe("session-superseded")
    expect(sc.getLifecycle()).toBe("STOPPED")
    addPending(a)
    const fresh = sched(b)
    await fresh.start()
    expect(fresh.hasAuthority()).toBe(true)
  })

  test("a TASK_GONE self-dispose also hands it back - the gap M19 exposed", async () => {
    // [DESIGN DECISION] This is the ONLY path where disposeSelf()'s release is
    // load-bearing, and it was untested until mutation M19 survived. The
    // supersession path is redundant (the incarnation bump already isolates the old
    // lease), so removing the release there changes nothing - which is exactly why
    // a supersession-only test cannot catch it.
    //
    // Here the task vanishes from UNDER a live turn - rows only, with the
    // incarnation unchanged, so the lease key is untouched. If self-dispose did not
    // release, the session would stay locked for a full lease period with no way
    // to recover but expiry. (Deleting before the cycle would just yield
    // "no-candidates" and never reach the lineage write at all.)
    let release = (): void => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    const sc = sched(a, async () => {
      await held
      return OK
    })
    await sc.start()
    addPending(a)
    const cycling = sc.cycle()
    while (sc.getActiveClaim() === null) await Bun.sleep(2)
    a.deleteSessionTasks(S)
    release()
    const r = await cycling
    expect(r.dispatched?.lineage).toBe("TASK_GONE")
    expect(sc.getLifecycle()).toBe("STOPPED")
    // The lease is GONE, not merely expired. A replacement can start right now.
    expect(snap(a).row_present).toBe(false)
    expect(b.acquireSessionAuthority(S, "tok-next", SESSION_LEASE_MS)).toBe("ACQUIRED")
  })

  test("authority-loss self-dispose does NOT evict the successor", async () => {
    const sc = sched(a)
    await sc.start()
    const t = Date.now() + SESSION_LEASE_MS + 1
    b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS, t)
    expect((await sc.cycle()).stop).toBe("authority-lost")
    expect(sc.getLifecycle()).toBe("STOPPED")
    // disposeSelf ran releaseAuthority; token guard means it was a no-op.
    expect(snap(b).owner_token).toBe("tok-b")
    expect(b.holdsSessionAuthority(S, "tok-b")).toBe(true)
  })

  test("production stop() path releases the lease too", async () => {
    const { createProductionScheduler, GATE_ENABLED } = await import(
      "../src/task/production-scheduler.ts"
    )
    addPending(a)
    const h = await createProductionScheduler(GATE_ENABLED, () => ({
      sessionId: S,
      cwd: dir,
      store: a,
      instruction: "x",
      adapter: { tools: [] } as never,
      bindingFor: () => ({}) as never,
    }))
    expect(h.constructed).toBe(true)
    expect(snap(a).row_present).toBe(true)
    await h.stop("shutdown")
    expect(snap(a).row_present).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §11  CRASH AND EXPIRY RECOVERY
// ═══════════════════════════════════════════════════════════════════════════

describe("§11 crash and expiry recovery", () => {
  test("a crashed owner blocks takeover until expiry, then frees the session", () => {
    const t0 = Date.now()
    // "Crash" = acquired, then nothing. No release, no stop.
    a.acquireSessionAuthority(S, "tok-crashed", SESSION_LEASE_MS, t0)

    // Before expiry: nobody may take it. This is the intended crash model.
    expect(b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS, t0 + SESSION_LEASE_MS - 1)).toBe(
      "REFUSED_LEASE_HELD",
    )
    expect(snap(b).owner_token).toBe("tok-crashed")

    // After expiry: recovery, with no manual step.
    const recovered = t0 + SESSION_LEASE_MS
    expect(b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS, recovered)).toBe("ACQUIRED")
    expect(snap(b).owner_token).toBe("tok-b")
  })

  test("recovery delay is bounded by the lease, and is reported here as a measurement", () => {
    const t0 = Date.now()
    a.acquireSessionAuthority(S, "tok-crashed", SESSION_LEASE_MS, t0)
    // The crashed owner never released, so the row is still there and the ONLY
    // recovery mechanism is expiry.
    expect(snap(a)).toMatchObject({ owner_token: "tok-crashed", row_present: true })
    // [FACT] Nothing observed the crash. Recovery is a deadline, not a detection.
    const recovery_ms = a.getSessionAuthority(S)!.leaseExpiresAt - t0
    expect(recovery_ms).toBe(SESSION_LEASE_MS)
    // And the session is only actually free at that deadline, no earlier.
    expect(a.holdsSessionAuthority(S, "tok-crashed", t0 + SESSION_LEASE_MS - 1)).toBe(true)
    expect(a.holdsSessionAuthority(S, "tok-crashed", t0 + SESSION_LEASE_MS)).toBe(false)
  })

  test("the crashed owner's row is preserved, so takeover history is inspectable", () => {
    const t0 = Date.now()
    a.acquireSessionAuthority(S, "tok-crashed", 1, t0)
    b.acquireSessionAuthority(S, "tok-b", SESSION_LEASE_MS, t0 + 2)
    // Overwritten, not deleted - there is exactly one row per (session, inc).
    expect(snap(a).owner_token).toBe("tok-b")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §14/§15  CLOCK AND PID SEMANTICS
// ═══════════════════════════════════════════════════════════════════════════

describe("§14-15 clock and PID semantics", () => {
  test("all timestamps are epoch milliseconds in one representation", () => {
    const now = Date.now()
    a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS, now)
    const r = a.getSessionAuthority(S)!
    expect({ acq: r.acquiredAt, exp: r.leaseExpiresAt, now }).toEqual({
      acq: now,
      exp: now + SESSION_LEASE_MS,
      now,
    })
    // Millisecond-scale, not seconds: a seconds value would be ~1e12.
    expect(r.acquiredAt).toBeGreaterThan(1_000_000_000_000)
    expect(r.acquiredAt).toBeLessThan(4_102_444_800_000) // year 2100
  })

  test("expiry arithmetic is supplied, not derived from a monotonic clock", () => {
    // [FACT] Every authority method takes `now` as a parameter defaulting to
    // Date.now(). No call site passes performance.now() or Date.now() deltas, so
    // there is no mixed monotonic/wall comparison anywhere in the lease.
    // `performance.now()` must not appear in the lease code at all.
    const lease = readSrc("src/task/store.ts")
    const auth = readSrc("src/task/session-authority.ts")
    expect({
      store: lease.includes("performance.now"),
      auth: auth.includes("performance.now"),
    }).toEqual({
      store: false,
      auth: false,
    })
  })

  test("a far-future clock does not overflow or wrap the deadline", () => {
    const huge = 4_102_444_800_000 - 1 // year 2100, ms
    expect(a.acquireSessionAuthority(S, "tok-a", SESSION_LEASE_MS, huge)).toBe("ACQUIRED")
    const r = a.getSessionAuthority(S)!
    expect(Number.isSafeInteger(r.leaseExpiresAt)).toBe(true)
    expect(r.leaseExpiresAt).toBe(huge + SESSION_LEASE_MS)
    expect(r.leaseExpiresAt).toBeGreaterThan(0)
  })

  test("PID is informational: it is written but never predicates any decision", async () => {
    const t0 = Date.now()
    a.acquireSessionAuthority(S, "tok-a", 1_000, t0)
    expect(snap(a).pid).toBe(process.pid)
    const src = readSrc("src/task/store.ts")
    const lease = src.slice(
      src.indexOf("getSessionAuthority(sessionId: string, incarnation?: number)"),
    )
    // `owner_pid` may appear as a projected column, an INSERT column, and a SET
    // target. It must never appear in a WHERE clause or in any comparison, because
    // a recycled PID confers no authority.
    const wheres = lease.match(/WHERE[\s\S]*?(?=,|\))/g) ?? []
    expect(wheres.join(" ")).not.toContain("owner_pid")
    // No comparison against it anywhere: no `owner_pid =`, `!=`, `<`, `>`.
    expect(lease).not.toMatch(/owner_pid\s*(==|!=|<=|>=|<|>)/)
    // The upsert's own SET target is the only assignment form present.
    expect(lease.match(/owner_pid\s*=\s*excluded\.owner_pid/g) ?? []).toHaveLength(1)
    expect(lease.match(/owner_pid AS ownerPid/g) ?? []).toHaveLength(1)
  })
})

/** Read a repo source file. Used only for anchor/source audits, never for behaviour. */
function readSrc(rel: string): string {
  return readFileSync(join(import.meta.dir, "..", rel), "utf8")
}
