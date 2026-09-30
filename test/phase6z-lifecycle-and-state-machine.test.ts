// PHASE 6Z §5, §13, §20 - lease lifecycle, cross-process PRODUCTION, and the
// production state machine.
//
// [DESIGN DECISION] The cross-process test drives `createProductionScheduler` in
// REAL `bun` processes, not two TaskStore handles. 6Y proved the lease under two
// connections; 6Z must prove the COMPOSITION, because a lease that works while the
// composition is bypassed is not a production property.

import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveLocalDbPath } from "../src/lib/db-path.ts"
import { createProductionScheduler, GATE_ENABLED } from "../src/task/production-scheduler.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const S = "6z-lc"
const prov = { origin: "model", source: "6z-lc" } as const
const LEASE = 300_000
const REPO = import.meta.dir.replace(/[\\/]test$/, "").replace(/\\/g, "/")

let dir: string
let store: InstanceType<typeof TaskStore>
let other: InstanceType<typeof TaskStore>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6zlc-"))
  resetTaskStoreHandles()
  resetSessionOwnershipForTests()
  store = new TaskStore(dir, { authority: "SCHEDULER" })
  other = new TaskStore(dir, { authority: "SCHEDULER" })
})
afterEach(async () => {
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

function seedTasks(n = 1, s = S): string[] {
  const ids: string[] = []
  for (let i = 0; i < n; i += 1) {
    ids.push(
      store.createTask(s, { title: `t${i}`, status: "PENDING", order: i + 1, provenance: prov }).id,
    )
  }
  return ids
}

/** Row count for a session, read with raw SQL so nothing goes through the store API. */
function rowCount(session: string): number {
  const src = readFileSync(join(import.meta.dir, "..", "src/lib/db-path.ts"), "utf8")
  expect(src).toContain("export function resolveLocalDbPath")
  const db = new Database(resolveLocalDbPath("tasks.db", dir))
  try {
    const r = db
      .query("SELECT COUNT(*) AS n FROM session_authority WHERE session_id = ?")
      .get(session) as { n: number }
    return Number(r.n)
  } finally {
    db.close()
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// §5  LEASE ROW LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

describe("§5 lease row lifecycle", () => {
  test("an active row is never read, and a current-incarnation read ignores history", () => {
    store.acquireSessionAuthority(S, "tok-1", LEASE)
    const inc1 = store.getSessionIncarnation(S)
    // Delete + recreate, exactly as the canonical path orders it.
    store.bumpSessionIncarnation(S)
    store.deleteSessionTasks(S)
    seedTasks(1)
    const inc2 = store.getSessionIncarnation(S)
    expect(inc2).not.toBe(inc1)

    // [FACT] The read is keyed on the CURRENT incarnation, so the historical row
    // under incarnation 1 is invisible. It cannot grant or withhold authority.
    expect(store.getSessionAuthority(S)).toBeNull()
    expect(store.holdsSessionAuthority(S, "tok-1")).toBe(false)
    // A new owner acquires freely - history does not lock the new lifetime.
    expect(other.acquireSessionAuthority(S, "tok-2", LEASE)).toBe("ACQUIRED")
  })

  test("row count grows linearly with delete/recreate cycles and is never read", () => {
    // [FACT] This is the 6Y observation, quantified. Each cycle leaves exactly one
    // row behind under the retired incarnation.
    store.acquireSessionAuthority(S, "tok-0", LEASE)
    const start = rowCount(S)
    for (let c = 0; c < 8; c += 1) {
      store.bumpSessionIncarnation(S)
      store.deleteSessionTasks(S)
      store.acquireSessionAuthority(S, `tok-${c + 1}`, LEASE)
    }
    expect(rowCount(S)).toBe(start + 8)
    // The 9th row is the only one any authority decision consults.
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("tok-8")
    expect(
      new Set([1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => store.getSessionAuthority(S, i)?.ownerToken))
        .size,
    ).toBe(9)
  })

  test("cleanup of retired incarnations would be safe IF performed - proved, not assumed", () => {
    // [DESIGN DECISION] 6Z is asked to DETERMINE whether cleanup is required, and
    // this test establishes the facts that judgement depends on, without performing
    // the deletion. The two properties a cleanup would need are:
    //   (a) it cannot touch the CURRENT row, and
    //   (b) a stale token cannot reach a new incarnation.
    store.acquireSessionAuthority(S, "tok-old", LEASE)
    const retiredInc = store.getSessionIncarnation(S)
    store.bumpSessionIncarnation(S)
    store.deleteSessionTasks(S)
    store.acquireSessionAuthority(S, "tok-new", LEASE)
    const currentInc = store.getSessionIncarnation(S)
    expect(retiredInc).not.toBe(currentInc)

    // (a) The old row is addressable and distinguishable by incarnation alone.
    expect(store.getSessionAuthority(S, retiredInc)?.ownerToken).toBe("tok-old")
    expect(store.getSessionAuthority(S, currentInc)?.ownerToken).toBe("tok-new")
    // (b) A stale token is powerless against the current incarnation, whether by
    // renew, release, or an acquisition attempt.
    expect(store.renewSessionAuthority(S, "tok-old", LEASE)).toBe("AUTHORITY_LOST")
    expect(store.releaseSessionAuthority(S, "tok-old")).toBe(false)
    expect(store.acquireSessionAuthority(S, "tok-old", LEASE)).toBe("REFUSED_LEASE_HELD")
    // And the current authority is untouched by all three.
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("tok-new")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §13  CROSS-PROCESS, REAL PRODUCTION COMPOSITION
// ═══════════════════════════════════════════════════════════════════════════

const CHILD = `
const fs = await import("node:fs")
const { GATE_ENABLED, createProductionScheduler } = await import("__REPO__/src/task/production-scheduler.ts")
const { TaskStore } = await import("__REPO__/src/task/store.ts")
const cwd = process.argv[2]
const role = process.argv[3]
const barrier = process.argv[4]
const prov = { origin: "model", source: "6z-proc" }
const report = (o) => console.log("__REPORT__" + JSON.stringify(o))
const wait = async (p, ms) => { const d = Date.now() + ms; while (!p && Date.now() < d) await Bun.sleep(2); return p }

const store = new TaskStore(cwd, { authority: "SCHEDULER" })

// [DESIGN DECISION] The handle is built INSIDE a role branch, never at module
// scope. Constructing it at module scope would make the contender fail in exactly
// the way it is meant to, but before its own reporting could run - so the failure
// would look like a crash rather than a refusal.
const mkHandle = (onFactory) =>
  createProductionScheduler(GATE_ENABLED, () => ({
    sessionId: "__SESSION__",
    cwd,
    store,
    instruction: "x",
    adapter: {
      store,
      tools: [{ name: "read_file" }],
      cwdFor: () => cwd,
      sessionFactory: async () => {
        if (onFactory) await onFactory()
        return { async run() { return { finalText: "ok", usage: { steps: 1 } } }, abort() {} }
      },
    },
    bindingFor: (taskId) => ({
      parentSessionId: "__SESSION__",
      taskId,
      execGeneration: store.getExecutionLineage("__SESSION__", taskId)?.execGeneration ?? 0,
      sessionIncarnation: store.getSessionIncarnation("__SESSION__"),
    }),
  }))

if (role === "holder") {
  const h = await mkHandle(async () => { await wait(fs.existsSync(barrier + ".release"), 8000) })
  const r = await h.fire("startup")
  fs.writeFileSync(barrier, "held")
  await wait(fs.existsSync(barrier + ".release"), 60000)
  report({
    role,
    constructed: h.constructed,
    authority: h.getScheduler().hasAuthority(),
    stop: r && r.cycle && r.cycle.stop,
    status: store.listTasks("__SESSION__")[0].status,
  })
  await h.stop("shutdown")
  report({ role, afterStop: store.getSessionAuthority("__SESSION__") })
  process.exit(0)
}

if (role === "contender") {
  await wait(fs.existsSync(barrier), 60000)
  // THE ATTACK: a real, enabled production composition for the SAME session. Its
  // sessionFactory throws if reached, so reaching it at all would be a bypass.
  let refused = null
  let h2 = null
  try {
    h2 = await mkHandle(async () => { throw new Error("SHOULD NEVER BE REACHED") })
    await h2.fire("startup")
    refused = "NOT_REFUSED"
  } catch (e) {
    refused = String((e && e.message) || e)
  }
  // The live claim in the other process must be untouched.
  const t = store.listTasks("__SESSION__")[0]
  report({ role, refused, authority: h2 ? h2.getScheduler().hasAuthority() : null, status: t.status })
  fs.writeFileSync(barrier + ".release", "1")
  process.exit(0)
}
`

describe("§13 cross-process PRODUCTION composition", () => {
  test("two enabled production processes: one authority, one live execution", async () => {
    seedTasks(1)
    const child = join(dir, "child.ts")
    writeFileSync(child, CHILD.replaceAll("__REPO__", REPO).replaceAll("__SESSION__", S), "utf8")
    const barrier = join(dir, "b")
    const spawn = (role: string) =>
      Bun.spawn(["bun", child, dir, role, barrier], {
        cwd: REPO,
        stdout: "pipe",
        stderr: "pipe",
      })
    const collect = async (p: ReturnType<typeof spawn>) => {
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ])
      if (code !== 0) throw new Error(`child ${code}: ${err.slice(0, 400)}`)
      return out
    }
    const parseAll = (s: string): Record<string, unknown>[] =>
      s
        .split("\n")
        .filter((l) => l.startsWith("__REPORT__"))
        .map((l) => JSON.parse(l.slice("__REPORT__".length)) as Record<string, unknown>)

    const holder = spawn("holder")
    // Wait for the barrier file the holder writes, so the contender is never merely
    // lucky: a sleep would make this a coin flip and a mutant could pass by luck.
    const deadline = Date.now() + 60_000
    while (!existsSync(barrier) && Date.now() < deadline) await Bun.sleep(5)
    const contender = spawn("contender")

    const [holderOut, contenderOut] = await Promise.all([collect(holder), collect(contender)])
    const holderReports = parseAll(holderOut)
    const contenderReport = parseAll(contenderOut)[0]

    // The holder really is the production authority with a real claim in flight.
    expect(holderReports[0]).toMatchObject({ constructed: true, authority: true })
    // The contender is REFUSED AT THE LEASE, naming the lease rather than anything
    // process-local - that distinction is the whole of 6X/6Y.
    expect(contenderReport?.refused).toMatch(/lease held by another process/)
    // [FACT] Stronger than "a handle with no authority": the refusal happens during
    // `createProductionScheduler`, so the contender never obtained a handle at all
    // and no Scheduler, trigger, or child context was ever built on its side.
    expect(contenderReport?.authority).toBeNull()
    // No double execution: the live claim survived the contender's attempt.
    expect(contenderReport?.status).toBe("IN_PROGRESS")
    // And after the holder stops, its lease is gone - no orphan authority.
    expect(holderReports[1]).toMatchObject({ afterStop: null })
  }, 180_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// §20  PRODUCTION STATE MACHINE, MANY SEEDS
// ═══════════════════════════════════════════════════════════════════════════

/** Deterministic PRNG, so a failing seed is replayable. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe("§20 production state machine over randomized seeds", () => {
  test("150 seeds x 30 steps, one handle, with deletion and recreation interleaved", async () => {
    for (let seed = 1; seed <= 150; seed += 1) {
      resetSessionOwnershipForTests()
      store = new TaskStore(dir, { authority: "SCHEDULER" })
      other = new TaskStore(dir, { authority: "SCHEDULER" })
      const next = rng(seed)
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T

      seedTasks(1 + Math.floor(next() * 3))
      const c = { factoryCalls: 0 }
      const h = await createProductionScheduler(GATE_ENABLED, () => ({
        sessionId: S,
        cwd: dir,
        store,
        instruction: "x",
        adapter: {
          store,
          tools: [{ name: "read_file" }],
          cwdFor: () => dir,
          sessionFactory: async () => {
            c.factoryCalls += 1
            return {
              async run() {
                return { finalText: "ok", usage: { steps: 1 } }
              },
              abort() {},
            }
          },
        },
        bindingFor: (taskId: string) => ({
          parentSessionId: S,
          taskId,
          execGeneration: store.getExecutionLineage(S, taskId)?.execGeneration ?? 0,
          sessionIncarnation: store.getSessionIncarnation(S),
        }),
      }))

      let stopped = false
      for (let step = 0; step < 30; step += 1) {
        const op = pick([
          "fire",
          "fire",
          "fire",
          "delete",
          "recreate",
          "rivalAcquire",
          "stoppedFire",
        ] as const)
        switch (op) {
          case "fire":
            if (!stopped) await h.fire(pick(["startup", "explicit-command", "task-mutation"]))
            break
          case "delete":
            if (!stopped) {
              store.bumpSessionIncarnation(S)
              store.deleteSessionTasks(S)
            }
            break
          case "recreate":
            store.deleteSessionTasks(S)
            seedTasks(1 + Math.floor(next() * 2))
            break
          case "rivalAcquire":
            // A second process must never take a VALID lease.
            if (store.getSessionAuthority(S)?.leaseExpiresAt !== undefined) {
              other.acquireSessionAuthority(S, "rival", LEASE)
            }
            break
          case "stoppedFire":
            if (!stopped) {
              await h.stop("shutdown")
              stopped = true
            }
            // P13 property: a fire after stop creates no work.
            expect(await h.fire("startup")).toBeNull()
            break
        }

        // ── INVARIANTS after every step ──────────────────────────────────
        const row = store.getSessionAuthority(S)
        if (stopped) {
          // No authority leak, ever, once stopped.
          expect(row).toBeNull()
        }
        // At most one owner is recorded, and it is the Scheduler's own token when
        // the handle is live.
        if (row !== null) {
          const sc = h.getScheduler() as unknown as { authorityToken?: string }
          // At most ONE recorded owner, and while the handle is live it is this
          // instance's own token - never a rival's.
          expect(row.ownerToken === sc.authorityToken).toBe(true)
        }
        // A rival never becomes the owner of a VALID lease.
        if (row !== null && row.ownerToken === "rival") {
          expect(row.leaseExpiresAt).toBeLessThanOrEqual(Date.now())
        }
        // No fabricated completion: the Scheduler writes only IN_PROGRESS/PENDING.
        expect(store.listTasks(S).every((t) => t.status !== "COMPLETED")).toBe(true)
      }

      if (!stopped) await h.stop("shutdown")
      // No lifecycle wedge, and no orphan authority at the end of any seed.
      expect(h.getScheduler()?.getLifecycle()).toBe("STOPPED")
      expect(store.getSessionAuthority(S)).toBeNull()
    }
  }, 900_000)
})
