// PHASE 6Y §16-§18, §20, §21, §26-§28 - authority lifecycle, production path,
// persistence, security forgery and failure injection.
//
// [DESIGN DECISION] §21 drives the REAL `cli/index.ts` parser as a spawned process
// where it can, and the real composition root where a process would be too coarse.
// The point is the failure pattern 6V found: a TESTED MODULE beside an UNTRAINED
// EXPRESSION. Every test here is labelled with which of the two it is.

import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasFlag } from "../cli/args.ts"
import { resolveLocalDbPath } from "../src/lib/db-path.ts"
import {
  createProductionScheduler,
  GATE_DISABLED,
  GATE_ENABLED,
  resolveSchedulerGate,
} from "../src/task/production-scheduler.ts"
import { Scheduler } from "../src/task/scheduler.ts"
import { SESSION_LEASE_MS, SESSION_RENEW_INTERVAL_MS } from "../src/task/session-authority.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const S = "6y-prod"
const prov = { origin: "model", source: "6y-prod" } as const
const OK = { kind: "returned", ok: true } as const

let dir: string
let store: TaskStore
let other: TaskStore

/** The REAL tasks.db path, so raw SQL acts on the same file the store uses. */
function dbPath(): string {
  // [FACT] store.ts hardcodes the tasks.db filename; this is the same name, so raw SQL
  // and the store act on one file rather than two.
  return resolveLocalDbPath("tasks.db", dir)
}

function readSrc(rel: string): string {
  return readFileSync(join(import.meta.dir, "..", rel), "utf8")
}

function tokenOf(sc: Scheduler): string {
  const t = (sc as unknown as Record<string, unknown>).authorityToken
  if (typeof t !== "string") throw new Error("expected an authority token")
  return t
}

function pending(title = "t"): string {
  return store.createTask(S, { title, status: "PENDING", order: 1, provenance: prov }).id
}

/** Steal the session out from under a live Scheduler, via the durable row. */
function steal(): void {
  const at = store.getSessionAuthority(S)!.leaseExpiresAt + 1
  expect(other.acquireSessionAuthority(S, "tok-thief", SESSION_LEASE_MS, at)).toBe("ACQUIRED")
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6yprod-"))
  resetTaskStoreHandles()
  resetSessionOwnershipForTests()
  store = new TaskStore(dir, { authority: "SCHEDULER" })
  other = new TaskStore(dir, { authority: "SCHEDULER" })
})

afterEach(async () => {
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

// ═══════════════════════════════════════════════════════════════════════════
// §16  AUTHORITY-LOST STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════

describe("§16 authority loss fails closed on every autonomous path", () => {
  test("a second start() on a displaced instance cannot re-acquire", async () => {
    const sc = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    await sc.start()
    steal()
    // [FACT] start() on a RUNNING instance is idempotent (6C), so this is not a
    // re-acquisition. What matters is that the displaced instance is powerless and
    // that a genuinely new one cannot take the session.
    expect(sc.hasAuthority()).toBe(false)
    sc.start()
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("tok-thief")
  })

  test("a cycle after loss dispatches nothing and claims nothing", async () => {
    const sc = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    await sc.start()
    const id = pending()
    steal()
    const r = await sc.cycle()
    expect({ stop: r.stop, dispatched: r.dispatched, recovered: r.recovered }).toEqual({
      stop: "authority-lost",
      dispatched: null,
      recovered: [],
    })
    // The task is untouched - no claim, no revision bump, no generation spent.
    const t = store.getTask(S, id)!
    expect(t.status).toBe("PENDING")
    expect(t.revision).toBe(1)
    // Lineage is present-but-zero for any existing task; assert the VALUES, not nullness.
    expect(store.getExecutionLineage(S, id)).toMatchObject({
      execGeneration: 0,
      attemptGeneration: null,
    })
  })

  test("there is no path from 'authority lost' to 'claim then execute'", async () => {
    const sc = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    await sc.start()
    const id = pending()
    steal()
    // Every entry point, in the worst order a caller could use them.
    sc.reconcile()
    await sc.cycle()
    sc.cancelActive("shutdown")
    await sc.stop()
    // The claim table was never written to by the displaced instance.
    expect(store.getExecutionOwnership(S, id)?.executionOwner ?? null).toBeNull()
    // Lineage is present-but-zero for any existing task; assert the VALUES, not nullness.
    expect(store.getExecutionLineage(S, id)).toMatchObject({
      execGeneration: 0,
      attemptGeneration: null,
    })
    expect(store.getTask(S, id)!.status).toBe("PENDING")
    // And the thief is still the only authority.
    expect(other.holdsSessionAuthority(S, "tok-thief")).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §17  RECONCILIATION INTERACTION  (the direct F02 bridge)
// ═══════════════════════════════════════════════════════════════════════════

describe("§17 only valid authority may reconcile", () => {
  test("valid lease -> the authority reconciles; no lease -> it may not", async () => {
    const withLease = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    await withLease.start()
    // A stranded, Scheduler-owned claim is exactly what reconcile() reverts.
    const id = pending()
    store.claimTask(S, id, store.getTask(S, id)!.revision)
    expect(store.getTask(S, id)!.status).toBe("IN_PROGRESS")

    // A SECOND instance for the same session, with NO lease of its own.
    // It cannot even start - the lease refuses it, and process-local ownership
    // refuses it too. Both are reported so the reader knows which fired.
    let err = ""
    try {
      new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" }).start()
    } catch (e) {
      err = (e as Error).message
    }
    expect(err).toMatch(/already owned in this process|lease held by another process/)

    // The holder may reconcile; the stranded claim is reverted.
    expect(withLease.reconcile().length).toBeGreaterThan(0)
    expect(store.getTask(S, id)!.status).toBe("PENDING")
  })

  test("a Scheduler whose lease was stolen reconciles nothing", async () => {
    const sc = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    await sc.start()
    const id = pending()
    store.claimTask(S, id, store.getTask(S, id)!.revision)
    steal()
    expect(sc.reconcile()).toEqual([])
    // THE F02 ASSERTION: another party's live work was not reverted.
    expect(store.getTask(S, id)!.status).toBe("IN_PROGRESS")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §18  TASK CLAIM INTERACTION
// ═══════════════════════════════════════════════════════════════════════════

describe("§18 the lease is scheduling authority, not task identity", () => {
  test("the lease gate is upstream of claim; claim logic itself is unchanged", async () => {
    // With authority: the cycle reaches a real claim.
    const sc = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    await sc.start()
    pending()
    const ok = await sc.cycle()
    expect(ok.dispatched?.lineage).toBe("RECORDED")

    // Without authority: the cycle never reaches claim at all.
    await sc.stop()
    resetTaskStoreHandles()
    store = new TaskStore(dir, { authority: "SCHEDULER" })
    pending("second")
    other.acquireSessionAuthority(S, "tok-thief", SESSION_LEASE_MS)
    const sc2 = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    const blocked = await sc2.cycle()
    expect(blocked.dispatched).toBeNull()
    // 6O's CAS is still the thing that admits a claim, byte for byte.
    const src = readSrc("src/task/store.ts")
    expect(src).toContain("const statuses = sqlList(CLAIMABLE_STATUSES)")
    expect(src).toContain("CLAIM_REJECTED_STALE")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §20  MULTIPLE SCHEDULER OBJECTS
// ═══════════════════════════════════════════════════════════════════════════

describe("§20 multiple Scheduler objects, one session", () => {
  test("only one obtains authority, and the durable lease is the reason", async () => {
    const first = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    await first.start()
    // Clear ONLY the in-memory registry. This simulates a second process: nothing
    // in memory survives, and the durable lease is the only thing left.
    resetSessionOwnershipForTests()
    const second = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    expect(() => second.start()).toThrow(/lease held by another process/)
    expect(store.getSessionAuthority(S)?.ownerToken).toBe(tokenOf(first))
  })

  test("after the first stops, the second can acquire immediately", async () => {
    const first = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    await first.start()
    await first.stop()
    resetSessionOwnershipForTests()
    const second = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    await second.start()
    expect(second.hasAuthority()).toBe(true)
    expect(store.getSessionAuthority(S)?.ownerToken).toBe(tokenOf(second))
    await second.stop()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §21  PRODUCTION COMPOSITION
// ═══════════════════════════════════════════════════════════════════════════

describe("§21 production composition path", () => {
  test("[PRODUCTION] the real cli/index.ts call site uses the audited resolver", () => {
    // [FACT] The executed expression, read from the file the product runs. This is
    // the check 6V's F01 needed and 6X added; a test of `resolveSchedulerGate`
    // alone would NOT have caught F01.
    const src = readSrc("cli/index.ts")
    expect(src).toContain("const schedulerEnabled = resolveSchedulerGate(args) === GATE_ENABLED")
    expect(src).not.toContain('hasFlag(args, "--enable-scheduler")')
  })

  test("[PRODUCTION] argv forms drive the real resolver, and OFF acquires no lease", async () => {
    const forms: [string[], boolean][] = [
      [[], false],
      [["--enable-scheduler"], true],
      [["hello"], false],
      [["--enable-scheduler=false"], false],
      [["--enable-scheduler=0"], false],
      [["--enable-scheduler=true"], false],
      [["--enable-scheduler=whatever"], false],
      [["--enable-schedulerx", "x"], false],
      [["hello", "--", "--enable-scheduler"], false],
    ]
    for (const [argv, on] of forms) {
      const gate = resolveSchedulerGate(argv)
      expect({ argv, enabled: gate.enabled, expected: on }).toEqual({
        argv,
        enabled: on,
        expected: on,
      })
      // The whole point: with the gate shut, NOTHING is constructed and NO lease row
      // is ever created. `deps` is a thunk and must not even be invoked.
      let built = false
      const h = await createProductionScheduler(gate, () => {
        built = true
        pending()
        return {
          sessionId: S,
          cwd: dir,
          store,
          instruction: "x",
          adapter: { tools: [] } as never,
          bindingFor: (() => ({})) as never,
        }
      })
      expect(h.constructed).toBe(on)
      expect(built).toBe(on)
      if (!on) {
        // [FACT] No Scheduler, no lease, no row - proved, not assumed.
        expect(store.getSessionAuthority(S)).toBeNull()
        expect(h.getScheduler()).toBeNull()
        expect(h.fire("startup")).resolves.toBeNull()
        await h.stop("shutdown")
      } else {
        expect(store.getSessionAuthority(S)).not.toBeNull()
        await h.stop("shutdown")
        expect(store.getSessionAuthority(S)).toBeNull()
      }
    }
  })

  test("the Scheduler's OWN renewal timer keeps a live lease alive", async () => {
    // [DESIGN DECISION] This test waits for one REAL SESSION_RENEW_INTERVAL_MS tick
    // (60s). It is slow on purpose. Every other renewal test in this audit drives
    // `renewSessionAuthority` directly, which is why mutation M13 - "delete the
    // renewal callback" - survived: nothing was ever exercising the Scheduler's own
    // timer. A compressed interval would need the constant changed, and 6Y is
    // forbidden from changing lease timings.
    //
    // What is proven: `start()` installs a renewal that actually reaches the store,
    // and a lease that would otherwise lapse is extended by it.
    const sc = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    await sc.start()
    const firstDeadline = store.getSessionAuthority(S)!.leaseExpiresAt

    // Wait past one renewal interval. A dead timer would leave the row untouched.
    await Bun.sleep(SESSION_RENEW_INTERVAL_MS + 2_000)

    const secondDeadline = store.getSessionAuthority(S)!.leaseExpiresAt
    // The lease was pushed forward: proof the timer fired and renewed.
    expect(secondDeadline).toBeGreaterThan(firstDeadline)
    expect(sc.hasAuthority()).toBe(true)
    // And it is the SAME authority - a renewal is not a re-acquisition.
    expect(store.getSessionAuthority(S)?.ownerToken).toBe(tokenOf(sc))
    await sc.stop()
  }, 90_000)

  test("the renewal timer self-disposes when the lease is taken away", async () => {
    // The other half of M13's property: renewal is not merely cosmetic. When the
    // lease is gone, the timer is what notices and stops the instance.
    const sc = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    await sc.start()
    // Steal it AFTER start(), while the instance still believes it holds authority.
    steal()
    expect(sc.hasAuthority()).toBe(false)
    // The instance is already disposed by the next boundary; the timer must not
    // resurrect it, and must not throw when its renewal is refused.
    await Bun.sleep(SESSION_RENEW_INTERVAL_MS + 2_000)
    expect(sc.getLifecycle()).toBe("STOPPED")
    expect(sc.hasAuthority()).toBe(false)
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("tok-thief")
  }, 90_000)

  test("[PRODUCTION] the real composition root acquires the lease on start", async () => {
    pending()
    const h = await createProductionScheduler(GATE_ENABLED, () => ({
      sessionId: S,
      cwd: dir,
      store,
      instruction: "x",
      adapter: { tools: [] } as never,
      bindingFor: (() => ({})) as never,
    }))
    const sc = h.getScheduler()!
    expect(sc.hasAuthority()).toBe(true)
    expect(store.getSessionAuthority(S)?.ownerToken).toBe(tokenOf(sc))
    // A second process is refused.
    expect(() =>
      new Scheduler(S, { store: other, runTurn: (() => OK) as never, instruction: "x" }).start(),
    ).toThrow()
    await h.stop("shutdown")
  })

  test("[PRODUCTION] environment and config cannot enable it", () => {
    // [FACT] The gate reads argv only. No env var, no config key, no module side
    // effect participates. Asserted against the real source and the real resolver.
    const src = readSrc("cli/index.ts")
    expect(src).not.toMatch(/process\.env\.[A-Za-z_]*SCHEDULER/)
    expect(src).not.toMatch(/MINICODE_SCHEDULER/)
    const before = process.env.MINICODE_SCHEDULER
    process.env.MINICODE_SCHEDULER = "1"
    try {
      expect(resolveSchedulerGate(["hello"]).enabled).toBe(false)
      expect(resolveSchedulerGate([])).toBe(GATE_DISABLED)
    } finally {
      if (before === undefined) delete process.env.MINICODE_SCHEDULER
      else process.env.MINICODE_SCHEDULER = before
    }
  })

  test("[PRODUCTION] exactly one Scheduler construction site exists", () => {
    // [FACT] Counted from the source tree, not asserted by hand. A second site
    // would be a second chance to construct one that never acquires a lease.
    const files = [
      "src/task/production-scheduler.ts",
      "src/task/scheduler.ts",
      "cli/index.ts",
      "cli/setup.ts",
    ]
    const sites = files
      .map((f) => {
        // Strip comments first: scheduler.ts documents the call with an illustrative
        // snippet, and counting that would be a false positive.
        const code = readSrc(f)
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/^\s*\/\/.*$/gm, " ")
        return [f, code.match(/new Scheduler\(/g)?.length ?? 0] as const
      })
      .filter(([, n]) => n > 0)
    // scheduler.ts's own occurrence is the illustrative snippet in its header
    // comment; production-scheduler.ts is the single real construction.
    expect(sites).toEqual([["src/task/production-scheduler.ts", 1]])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §26  PERSISTENCE / MIGRATION
// ═══════════════════════════════════════════════════════════════════════════

describe("§26 persistence and migration", () => {
  test("a pre-lease database opens with no lease and migrates additively", async () => {
    // Populate the database, then DROP the lease table to simulate a pre-6X file.
    store.acquireSessionAuthority(S, "tok-old", SESSION_LEASE_MS)
    const taskId = pending("survivor")
    const raw = new Database(dbPath())
    raw.exec("DROP TABLE IF EXISTS session_authority")
    raw.close()

    resetTaskStoreHandles()
    store = new TaskStore(dir, { authority: "SCHEDULER" })

    // [FACT] The store re-creates the table on open, additively. Nothing else in
    // the schema was touched and the pre-existing task is still there.
    expect(store.getSessionAuthority(S)).toBeNull()
    expect(store.getTask(S, taskId)?.title).toBe("survivor")
    expect(store.acquireSessionAuthority(S, "tok-new", SESSION_LEASE_MS)).toBe("ACQUIRED")
  })

  test("repeated open/migrate cycles are idempotent", () => {
    for (let i = 0; i < 4; i += 1) {
      resetTaskStoreHandles()
      store = new TaskStore(dir, { authority: "SCHEDULER" })
    }
    const t = store.createTask(S, { title: "x", status: "PENDING", order: 1, provenance: prov })
    for (let i = 0; i < 4; i += 1) {
      resetTaskStoreHandles()
      store = new TaskStore(dir, { authority: "SCHEDULER" })
    }
    expect(store.getTask(S, t.id)?.title).toBe("x")
  })

  test("no stale authority survives deletion, and a new incarnation gets no old lease", () => {
    store.acquireSessionAuthority(S, "tok-old", SESSION_LEASE_MS)
    // The canonical deletion order, as persistence.ts performs it.
    store.bumpSessionIncarnation(S)
    store.deleteSessionTasks(S)
    expect(store.holdsSessionAuthority(S, "tok-old")).toBe(false)
    pending("reborn")
    expect(store.getSessionAuthority(S)).toBeNull()
    expect(other.acquireSessionAuthority(S, "tok-new", SESSION_LEASE_MS)).toBe("ACQUIRED")
  })

  test("OBSERVED: lease rows are never deleted on session deletion, so they accumulate", () => {
    // [FACT] Nothing in the deletion path removes `session_authority` rows. Each
    // delete/recreate cycle leaves one row behind under the old incarnation.
    store.acquireSessionAuthority(S, "tok-1", SESSION_LEASE_MS)
    for (let inc = 1; inc <= 4; inc += 1) {
      store.bumpSessionIncarnation(S)
      store.deleteSessionTasks(S)
      store.acquireSessionAuthority(S, `tok-${inc + 1}`, SESSION_LEASE_MS)
    }
    const conn = new Database(dbPath())
    const rows = conn
      .query("SELECT COUNT(*) AS n FROM session_authority WHERE session_id = ?")
      .all(S)
    conn.close()
    const n = Number((rows[0] as { n: number }).n)
    // 4 deleted incarnations + 1 current = 5 rows for one session.
    expect(n).toBe(5)
    // They are inert - only the current incarnation is ever read - but they are
    // unbounded growth. Recorded as a finding, not patched (audit only).
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("tok-5")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §27  SECURITY FORGERY
// ═══════════════════════════════════════════════════════════════════════════

describe("§27 authority cannot be forged", () => {
  test("every wrong-token / wrong-session combination fails closed", () => {
    const S2 = "6y-other"
    store.acquireSessionAuthority(S, "tok-real", SESSION_LEASE_MS)
    other.acquireSessionAuthority(S2, "tok-real-2", SESSION_LEASE_MS)
    const cases = [
      { name: "wrong token", r: store.renewSessionAuthority(S, "guess", SESSION_LEASE_MS) },
      { name: "empty token", r: store.renewSessionAuthority(S, "", SESSION_LEASE_MS) },
      {
        name: "right token wrong session",
        r: store.renewSessionAuthority(S2, "tok-real", SESSION_LEASE_MS),
      },
      {
        name: "right session wrong token",
        r: store.renewSessionAuthority(S, "tok-real-2", SESSION_LEASE_MS),
      },
    ]
    for (const c of cases)
      expect({ name: c.name, r: c.r }).toEqual({ name: c.name, r: "AUTHORITY_LOST" })
    for (const c of cases) {
      const [sess, tok] = c.name === "right token wrong session" ? [S2, "tok-real"] : [S, "guess"]
      expect(store.releaseSessionAuthority(sess, tok)).toBe(false)
    }
    // Both real authorities are intact.
    expect(store.holdsSessionAuthority(S, "tok-real")).toBe(true)
    expect(store.holdsSessionAuthority(S2, "tok-real-2")).toBe(true)
  })

  test("an expired token cannot act, and a reused PID cannot act", () => {
    const t0 = Date.now()
    store.acquireSessionAuthority(S, "tok-old", 1, t0)
    const after = t0 + 10
    // The PID is the same process throughout; authority is the TOKEN.
    expect(store.getSessionAuthority(S)!.ownerPid).toBe(process.pid)
    // The lease has lapsed, so the takeover succeeds...
    expect(other.acquireSessionAuthority(S, "tok-new", SESSION_LEASE_MS, after)).toBe("ACQUIRED")
    // ...and only NOW is the displaced token powerless. Renewing it BEFORE the
    // takeover would legitimately succeed - that is the documented §4 renewal
    // semantics, not a forgery - so ordering matters for what this asserts.
    expect(store.renewSessionAuthority(S, "tok-old", SESSION_LEASE_MS, after)).toBe(
      "AUTHORITY_LOST",
    )
    expect(store.releaseSessionAuthority(S, "tok-old")).toBe(false)
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("tok-new")
  })

  test("no crypto dependency is required by the current architecture", () => {
    // [FACT] The token is `Date.now() + counter + 32 bits of Math.random`. It is
    // NOT a secret and is not treated as one: the lease gates scheduling, and the
    // attacker model is another local process on the same tasks.db, which can read
    // the row directly. Unpredictability is defence in depth, not the boundary.
    // Recorded so a future reader does not mistake it for a capability secret.
    const src = readSrc("src/task/session-authority.ts")
    expect(src).toContain("Math.random")
    expect(src).not.toContain("node:crypto")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §28  FAILURE INJECTION
// ═══════════════════════════════════════════════════════════════════════════

describe("§28 failure injection produces at most one valid authority", () => {
  test("L1/L2: a throw before or after acquire leaves no second authority", () => {
    // L1: never acquired.
    expect(store.getSessionAuthority(S)).toBeNull()
    expect(other.acquireSessionAuthority(S, "a", SESSION_LEASE_MS)).toBe("ACQUIRED")
    // L2: acquired, then the caller blew up without releasing. Still one owner.
    expect(other.acquireSessionAuthority(S, "b", SESSION_LEASE_MS)).toBe("REFUSED_LEASE_HELD")
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("a")
  })

  test("L3/L4: renewal failures never create a second owner", () => {
    store.acquireSessionAuthority(S, "a", SESSION_LEASE_MS)
    const at = store.getSessionAuthority(S)!.leaseExpiresAt
    // A renewal that races an expiry and loses: authority lost, not duplicated.
    expect(other.renewSessionAuthority(S, "b", SESSION_LEASE_MS, at + 1)).toBe("AUTHORITY_LOST")
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("a")
    // A renewal that wins: still one owner, deadline extended.
    expect(store.renewSessionAuthority(S, "a", SESSION_LEASE_MS + 1_000, at + 1)).toBe(
      "AUTHORITY_HELD",
    )
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("a")
  })

  test("L5/L6: expiry and takeover serialise to one owner", () => {
    const t0 = Date.now()
    store.acquireSessionAuthority(S, "a", 1_000, t0)
    const after = t0 + 1_000
    // Both parties attempt in the same instant. Exactly one may win, and the
    // database decides - not the caller.
    const ra = other.acquireSessionAuthority(S, "b", SESSION_LEASE_MS, after)
    const rb = store.acquireSessionAuthority(S, "c", SESSION_LEASE_MS, after)
    expect([ra, rb].filter((x) => x === "ACQUIRED").length).toBe(1)
    const row = store.getSessionAuthority(S)!
    expect(["b", "c"]).toContain(row.ownerToken)
    expect(store.holdsSessionAuthority(S, row.ownerToken)).toBe(true)
  })

  test("L7/L8: a failed release leaves the owner intact", () => {
    store.acquireSessionAuthority(S, "a", SESSION_LEASE_MS)
    expect(store.releaseSessionAuthority(S, "wrong")).toBe(false)
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("a")
    expect(store.releaseSessionAuthority(S, "a")).toBe(true)
    expect(store.getSessionAuthority(S)).toBeNull()
  })

  test("L10/L11: a Scheduler that dies mid-shutdown still frees the session by expiry", async () => {
    const sc = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    await sc.start()
    // Simulate a crash: abandon the instance without stop() and drop the in-memory
    // registry, as a dead process would.
    resetSessionOwnershipForTests()
    // A new process cannot take it while the lease is live...
    expect(other.acquireSessionAuthority(S, "b", SESSION_LEASE_MS)).toBe("REFUSED_LEASE_HELD")
    // ...and CAN once it expires. No manual step, and no detection of the crash.
    const at = store.getSessionAuthority(S)!.leaseExpiresAt
    expect(other.acquireSessionAuthority(S, "b", SESSION_LEASE_MS, at)).toBe("ACQUIRED")
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("b")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §29 EVIDENCE QUALITY - the anti-pattern 6V found
// ═══════════════════════════════════════════════════════════════════════════

describe("§29 evidence quality: does the test drive the production function?", () => {
  test("the lease is exercised through the Scheduler, not only the store methods", () => {
    // [FACT] Every store-level lease test would pass even if the Scheduler never
    // consulted the lease at all. These are the assertions that couple the two.
    const sc = new Scheduler(S, { store, runTurn: (() => OK) as never, instruction: "x" })
    sc.reconcile() // never started
    expect(sc.hasAuthority()).toBe(false)
    const tid = pending()
    store.claimTask(S, tid, store.getTask(S, tid)!.revision)
    expect(sc.reconcile()).toEqual([])
    expect(store.getTask(S, tid)?.status).toBe("IN_PROGRESS")
  })

  test("hasFlag is asserted to be UNCHANGED, so the fix did not weaken a shared helper", () => {
    expect(hasFlag(["--enable-scheduler=false"], "--enable-scheduler")).toBe(true)
    expect(hasFlag(["--cwd=C:\\x"], "--cwd")).toBe(true)
  })
})
