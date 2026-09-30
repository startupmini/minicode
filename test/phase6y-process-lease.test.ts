// PHASE 6Y §3/§4/§12 - real OS processes.
//
// [DESIGN DECISION] 6V reproduced F02 with two TaskStore handles in ONE process. That
// was enough to show the logic was wrong, but not to show the BUG was fixed: the
// original defect was that authority was invisible across processes, and in one
// process the in-memory registry IS shared. These tests therefore spawn real `bun`
// processes against one tasks.db.
//
// Every rendezvous here is a FILE, never a sleep. A sleep-based barrier would make
// the race probabilistic and a mutant could pass by luck.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"

const REPO = import.meta.dir.replace(/[\\/]test$/, "").replace(/\\/g, "/")
const S = "6y-proc"
const LEASE = 300_000
const prov = { origin: "model", source: "6y-proc" } as const

let dir: string
/**
 * The parent's own read handle. Deliberately separate from the seeded one so an
 * assertion never reads through the same object it just wrote.
 */
let a: import("../src/task/store.ts").TaskStore

/**
 * The child. Roles:
 *   acquire  - barrier-gated, then attempts ONE acquisition and reports the result
 *   cycle    - acquires, holds a live claim, then attempts a full Scheduler cycle
 *   renew    - acquires, then renews on a timer for a fixed duration
 */
const CHILD = `
const fs = await import("node:fs")
const { Scheduler } = await import("__REPO_ROOT__/src/task/scheduler.ts")
const { TaskStore } = await import("__REPO_ROOT__/src/task/store.ts")

const cwd = process.argv[2]
const role = process.argv[3]
const barrier = process.argv[4]   // wait for this before acting, "-" = do not wait
const signal = process.argv[7]   // write "held:..." here, "-" = do not signal
const sessionArg = process.argv[6]
const token = process.argv[5] ?? ""
const args = process.argv.slice(8)
const SESS = sessionArg ?? "__SESSION__"
const LEASE = __LEASE__
const prov = { origin: "model", source: "6y-proc" }
const OK = { kind: "returned", ok: true }
const report = (o) => console.log("__REPORT__" + JSON.stringify(o))
process.on("uncaughtException", (e) => { console.log("__REPORT__" + JSON.stringify({ role, token, error: String(e && e.message), stack: String(e && e.stack).slice(0, 300) })); process.exit(3) })

const store = new TaskStore(cwd, { authority: "SCHEDULER" })

/** Wait on a FILE, never on a timer. A sleep would make the race a coin flip. */
async function awaitFile(path, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(path)) {
    if (Date.now() > deadline) throw new Error("barrier timeout: " + path)
    await Bun.sleep(2)
  }
  return fs.readFileSync(path, "utf8")
}

if (role === "acquire") {
  if (barrier !== "-") await awaitFile(barrier)   // everyone is armed, unless solo
  const before = Date.now()
  const r = store.acquireSessionAuthority(SESS, token, LEASE, before)
  const row = store.getSessionAuthority(SESS)
  report({
    role, token, result: r, before,
    rowToken: row ? row.ownerToken : null,
    rowPid: row ? row.ownerPid : null,
    rowExpires: row ? row.leaseExpiresAt : null,
    rowIncarnation: row ? row.incarnation : null,
  })
  process.exit(0)
}

if (role === "cycle") {
  // [DESIGN DECISION] The Scheduler mints its OWN token inside start(). The child
  // must NOT pre-acquire with a different one: it would hold a lease the Scheduler
  // could not use, so start() would be refused for the wrong reason and every
  // process would look like a loser. Instead, arm on the barrier, then let start()
  // be the thing that competes for the lease - which is the production path.
  if (barrier !== "-") await awaitFile(barrier)
  // [DESIGN DECISION] The turn is bounded by an internal timer rather than by the
  // parent. An earlier version released the turn only after cycle() returned - but
  // cycle() AWAITS the turn, so the winner deadlocked against itself. The timer
  // keeps the claim genuinely live long enough for every loser to be refused, and
  // guarantees the process always terminates.
  let release
  const held = new Promise((res) => { release = res })
  const cap = setTimeout(() => release(), 4000)
  const sc = new Scheduler(SESS, { store, runTurn: async () => { await held; return OK }, instruction: "x" })
  let started = "ok"
  try { sc.start() } catch (e) { started = String(e && e.message) }
  if (started !== "ok") {
    clearTimeout(cap)
    // Refused at the lease. Report exactly how far it got, so a mutant that lets a
    // loser through shows up as a claim or a cycle rather than as a vague failure.
    report({ role, token, started, claimed: false, cycleStop: null, lineage: null, recovered: null })
    process.exit(0)
  }
  const t = store.listTasks(SESS).find((x) => x.title === "shared")
  if (t === undefined) {
    report({ role, token, started, error: "no shared task in " + SESS, tasks: store.listTasks(SESS).map((x) => x.title) })
    process.exit(0)
  }
  const claim = store.claimTask(SESS, t.id, t.revision)
  if (signal !== "-") fs.writeFileSync(signal, "held:" + claim.outcome)
  const res = await sc.cycle()
  clearTimeout(cap)
  release()
  const after = store.getTask(SESS, t.id)
  const row = store.getSessionAuthority(SESS)
  report({
    role, token, started,
    claimed: claim.outcome === "CLAIM_ACCEPTED",
    claim: claim.outcome, cycleStop: res.stop, lineage: res.dispatched && res.dispatched.lineage,
    statusAfter: after ? after.status : null, recovered: res.recovered,
    rowToken: row ? row.ownerToken : null,
  })
  await sc.stop()
  process.exit(0)
}

if (role === "renew") {
  const r = store.acquireSessionAuthority(SESS, token, LEASE)
  if (r !== "ACQUIRED") { report({ role, token, acquired: false }); process.exit(0) }
  // [DESIGN DECISION] The parent controls this process's LIFETIME via a stop file.
  // A fixed duration is a race: the child would exit, RELEASE the lease, and every
  // later attempt would legitimately succeed - so "B was refused" would be testing
  // the child's exit timing, not the lease. Renewing until told to stop makes the
  // window deterministic and lets the test assert the release semantics separately.
  const stopFile = args[0]
  const intervalMs = Number(args[1] ?? 25)
  const renewals = []
  const started = Date.now()
  while (!fs.existsSync(stopFile)) {
    const at = Date.now()
    renewals.push({ at: at - started, r: store.renewSessionAuthority(SESS, token, LEASE, at) })
    await Bun.sleep(intervalMs)
  }
  const row = store.getSessionAuthority(SESS)
  report({
    role, token, acquired: true, renewals,
    heldForMs: Date.now() - started,
    rowToken: row ? row.ownerToken : null,
    rowExpires: row ? row.leaseExpiresAt : null,
    finalHeld: store.holdsSessionAuthority(SESS, token),
  })
  store.releaseSessionAuthority(SESS, token)
  process.exit(0)
}
`

/** A one-shot child: acquire a tiny lease, hold it briefly, then vanish with no release. */
const CRASHER = `
const { TaskStore } = await import("__REPO_ROOT__/src/task/store.ts")
const store = new TaskStore(process.argv[2], { authority: "SCHEDULER" })
const sess = process.argv[3]
const r = store.acquireSessionAuthority(sess, "tok-crashed", 1, Date.now())
console.log("__REPORT__" + JSON.stringify({ r, row: store.getSessionAuthority(sess) }))
// Expire without releasing: the crash model. No stop, no cleanup, no release call.
process.exit(0)
`

function childPath(): string {
  return join(dir, "child.ts")
}

function writeChild(): void {
  const src = CHILD.replaceAll("__REPO_ROOT__", REPO)
    .replaceAll("__SESSION__", S)
    .replaceAll("__LEASE__", String(LEASE))
  writeFileSync(childPath(), src, "utf8")
}

/** The renewal log a child reports. */
function renewalsOf(r: Report): { at: number; r: string }[] {
  return r.renewals as { at: number; r: string }[]
}

interface Report {
  [k: string]: unknown
}

/** Poll the DURABLE row until it satisfies `pred`, so no test guesses a sleep. */
async function waitFor(pred: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await Bun.sleep(5)
  }
}
function parse(stdout: string): Report {
  const line = stdout.split("\n").find((l) => l.startsWith("__REPORT__"))
  if (line === undefined) throw new Error(`child produced no report:\n${stdout.slice(0, 500)}`)
  return JSON.parse(line.slice("__REPORT__".length))
}

/**
 * argv layout (fixed, so the child and the parent cannot drift):
 *   2 cwd | 3 role | 4 barrier(wait) | 5 token | 6 session | 7 signal(write) | 8.. args
 * "-" means "do not wait" / "do not signal" respectively. The wait path and the
 * signal path are SEPARATE because the winner must not wait for the very file it
 * is about to write.
 */
function spawn(
  role: string,
  barrier: string,
  signal: string,
  token: string,
  session = S,
  args: string[] = [],
) {
  return Bun.spawn(["bun", childPath(), dir, role, barrier, token, session, signal, ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function collect(p: ReturnType<typeof spawn>) {
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  // Never throw here. A rejection from Promise.all would mask the OTHER children's
  // results, and in a 12-process race the one you most need to see is usually not
  // the one that failed first.
  return { out, err, code }
}

/** Seed one PENDING task and hold the parent's own read handle. */
async function seed(): Promise<void> {
  const { TaskStore } = await import("../src/task/store.ts")
  a = new TaskStore(dir, { authority: "SCHEDULER" })
  a.createTask(S, { title: "shared", status: "PENDING", order: 1, provenance: prov })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6yproc-"))
  writeChild()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

// ═══════════════════════════════════════════════════════════════════════════
// §3  ATOMIC ACQUISITION UNDER 10+ REAL PROCESSES
// ═══════════════════════════════════════════════════════════════════════════

describe("§3 atomic acquisition across 12 real processes", () => {
  test("exactly one winner, repeated, with exactly one owner token recorded", async () => {
    await seed()
    const N = 12
    const { TaskStore } = await import("../src/task/store.ts")
    for (let round = 1; round <= 6; round += 1) {
      // A FRESH session per round, so every round is a genuine COLD race. Reusing
      // one session would make rounds 2..N all lose to round 1's still-live lease,
      // which tests nothing about contention and looks exactly like a broken lease.
      const sess = `${S}-r${round}`
      new TaskStore(dir, { authority: "SCHEDULER" }).createTask(sess, {
        title: "shared",
        status: "PENDING",
        order: 1,
        provenance: prov,
      })
      const barrier = join(dir, `barrier-${round}`)
      writeFileSync(barrier, "")
      const procs = Array.from({ length: N }, (_, i) =>
        spawn("acquire", barrier, "-", `tok-${round}-${i}`, sess),
      )
      const outs = await Promise.all(procs.map((p) => collect(p)))
      const reports = outs.map((o) => parse(o.out))

      const winners = reports.filter((r) => r.result === "ACQUIRED")
      const losers = reports.filter((r) => r.result === "REFUSED_LEASE_HELD")
      expect({ round, winners: winners.length, losers: losers.length }).toEqual({
        round,
        winners: 1,
        losers: N - 1,
      })
      // Exactly one owner token is CURRENT, and every loser's own view of the row
      // agrees on who it is. This is the cross-process consistency claim: they did
      // not share memory, they read the same durable row.
      const observed = new Set(reports.map((r) => r.rowToken))
      expect([...observed]).toEqual([winners[0]?.token])
      // And no partial row: every observer saw a complete, well-formed record.
      for (const r of reports) {
        expect(Number.isSafeInteger(r.rowExpires as number)).toBe(true)
        expect(r.rowIncarnation).toBe(1)
        expect(typeof r.rowPid).toBe("number")
      }
    }
  }, 180_000)

  test("losers never schedule, never reconcile, never claim", async () => {
    // [DESIGN DECISION] Deterministic ordering, NOT a shared pre-created barrier.
    // The winner is launched with barrier "-" so it starts immediately, and it
    // WRITES the barrier file only after it holds a live claim. The eleven losers
    // block until that file exists, so by the time they try, the winner's
    // cross-process authority is already established. Arming everyone on one
    // pre-created file would just be a race with a 1-in-12 outcome - a mutant could
    // survive by being lucky.
    await seed()
    const barrier = join(dir, "held")

    const winner = spawn("cycle", "-", barrier, "tok-winner")
    const losers = Array.from({ length: 11 }, (_, i) =>
      spawn("cycle", barrier, "-", `tok-loser-${i}`),
    )
    const [w, ...l] = await Promise.all([collect(winner), ...losers.map(collect)])

    const rw = parse(w.out)
    const rl = l.map((x) => parse(x.out))

    // The winner really did hold the lease and a real in-flight claim.
    expect(rw).toMatchObject({ started: "ok", claimed: true, claim: "CLAIM_ACCEPTED" })

    // Every loser was refused AT THE LEASE, before any Scheduler work happened.
    expect(rl.filter((r) => r.started === "ok")).toHaveLength(0)
    for (const r of rl) {
      expect(r.started).toMatch(/lease held by another process/)
      // The decisive assertions: it never claimed, never ran a cycle, never
      // recovered anything. A mutant that moves the authority check after
      // scheduling would flip exactly these.
      expect(r.claimed).toBe(false)
      expect(r.claim).toBeUndefined()
      expect(r.cycleStop).toBeNull()
      expect(r.recovered).toBeNull()
    }

    // And the winner's live claim survived all eleven attempts. This is F02 itself.
    expect(rw.statusAfter).not.toBe("PENDING")
    expect(rw.rowToken).not.toBeNull()
  }, 180_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// §4  RENEWAL RACE ACROSS PROCESSES
// ═══════════════════════════════════════════════════════════════════════════

describe("§4 renewal vs acquisition across processes", () => {
  test("a renewing owner keeps the session; releasing hands it over immediately", async () => {
    await seed()
    const stop = join(dir, "stop-A")
    const A = spawn("renew", "-", "-", "tok-A", S, [stop, "20"])
    // Wait for A to actually hold the lease before probing, via the durable row.
    await waitFor(() => a.getSessionAuthority(S)?.ownerToken === "tok-A")

    // While A is alive AND renewing, B must be refused every time.
    const attempts: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const { out } = await collect(spawn("acquire", "-", "-", "tok-B"))
      attempts.push(parse(out).result as string)
      await Bun.sleep(60)
    }
    expect(attempts).toEqual(Array<string>(5).fill("REFUSED_LEASE_HELD"))

    // Now tell A to stop. It releases on the way out, and only THEN may B take over.
    writeFileSync(stop, "1")
    const { out } = await collect(A)
    const ra = parse(out)
    expect(ra.acquired).toBe(true)
    expect(renewalsOf(ra).length).toBeGreaterThan(5)
    // Every single renewal succeeded: the owner never lost its OWN lease.
    expect(renewalsOf(ra).every((x) => x.r === "AUTHORITY_HELD")).toBe(true)
    expect(ra.finalHeld).toBe(true)

    // A clean release is an immediate handover - no expiry wait.
    expect({ row: a.getSessionAuthority(S), after: parse((await collect(spawn("acquire", "-", "-", "tok-C"))).out).result }).toEqual({
      row: null,
      after: "ACQUIRED",
    })
  }, 180_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// §12  SLOW BUT LEGITIMATE EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

describe("§12 slow but legitimate execution retains authority", () => {
  test("a live owner renewing across many intervals is never displaced", async () => {
    await seed()
    // [DESIGN DECISION] Constants are NOT modified. SESSION_RENEW_INTERVAL_MS is
    // 60s, so a real-time test of "longer than several intervals" would take
    // minutes. Instead the child is told to renew on a COMPRESSED cadence, which
    // exercises the same durable code path many times over. What this proves and
    // does not prove is stated in the report: it demonstrates the renewal/steal
    // interaction, not the real 60s cadence.
    const stop = join(dir, "stop-A")
    const A = spawn("renew", "-", "-", "tok-A", S, [stop, "40"])
    await waitFor(() => a.getSessionAuthority(S)?.ownerToken === "tok-A")

    // While A is alive and renewing, B hammers acquisition. None may succeed.
    const attempts: string[] = []
    for (let i = 0; i < 10; i += 1) {
      const { out } = await collect(spawn("acquire", "-", "-", "tok-B"))
      attempts.push(parse(out).result as string)
      await Bun.sleep(40)
    }
    writeFileSync(stop, "1")
    const { out } = await collect(A)
    const ra = parse(out)

    expect(ra.acquired).toBe(true)
    expect(renewalsOf(ra).length).toBeGreaterThan(20)
    expect(renewalsOf(ra).every((x) => x.r === "AUTHORITY_HELD")).toBe(true)
    expect(ra.finalHeld).toBe(true)
    // THE property: a live, renewing lease was never stolen, not once in ten tries.
    expect(attempts.every((r) => r === "REFUSED_LEASE_HELD")).toBe(true)
    // The deadline was pushed forward repeatedly rather than left to lapse.
    expect(ra.rowToken).toBe("tok-A")
    expect(ra.rowExpires as number).toBeGreaterThan(Date.now() + LEASE - 10_000)
  }, 180_000)

  test("OBSERVED: a process that stops renewing IS displaced once the lease lapses", async () => {
    // [FACT] This is the intended trade: bounded authority, not liveness detection.
    // A process that vanishes past its lease loses the session even though nothing
    // observed a crash. Proven with a real second process, so the takeover is real.
    await seed()
    // A separate child file rather than `bun -e`: an inline script containing
    // parentheses and quotes is rejected by cmd.exe on Windows, and that failure
    // would masquerade as a lease bug.
    const crasher = join(dir, "crasher.ts")
    writeFileSync(crasher, CRASHER.replaceAll("__REPO_ROOT__", REPO), "utf8")
    const p = Bun.spawn(["bun", crasher, dir, S], { cwd: REPO, stdout: "pipe", stderr: "pipe" })
    const { out, code } = await collect(p)
    expect(code).toBe(0)
    expect(parse(out).r).toBe("ACQUIRED")
    // It exited without releasing. The row is still there, already expired.
    const stale = a.getSessionAuthority(S)
    expect(stale?.ownerToken).toBe("tok-crashed")

    // Recovery is by EXPIRY, and nothing else.
    expect(stale!.leaseExpiresAt).toBeLessThan(Date.now())
    const { out: o2 } = await collect(spawn("acquire", "-", "-", "tok-B"))
    expect(parse(o2).result).toBe("ACQUIRED")
    expect(parse(o2).rowToken).toBe("tok-B")
  }, 180_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// §19  MULTIPLE SESSIONS
// ═══════════════════════════════════════════════════════════════════════════

describe("§19 multiple sessions are independent", () => {
  test("one session's stop does not release another's lease", async () => {
    const { TaskStore } = await import("../src/task/store.ts")
    const { Scheduler } = await import("../src/task/scheduler.ts")
    resetSessionOwnershipForTests()
    const local = new TaskStore(dir, { authority: "SCHEDULER" })
    for (const s of ["s1", "s2"]) {
      local.createTask(s, { title: "t", status: "PENDING", order: 1, provenance: prov })
    }
    const sc1 = new Scheduler("s1", {
      store: local,
      runTurn: (() => ({ kind: "returned", ok: true })) as never,
      instruction: "x",
    })
    const sc2 = new Scheduler("s2", {
      store: local,
      runTurn: (() => ({ kind: "returned", ok: true })) as never,
      instruction: "x",
    })
    await sc1.start()
    await sc2.start()
    const t1 = (sc1 as unknown as { authorityToken: string }).authorityToken
    const t2 = (sc2 as unknown as { authorityToken: string }).authorityToken
    expect(t1).not.toBe(t2)
    // Independent acquisition AND independent records.
    expect(local.getSessionAuthority("s1")?.ownerToken).toBe(t1)
    expect(local.getSessionAuthority("s2")?.ownerToken).toBe(t2)

    // Shutting one down leaves the other untouched.
    await sc1.stop()
    expect(local.getSessionAuthority("s1")).toBeNull()
    expect(local.getSessionAuthority("s2")?.ownerToken).toBe(t2)
    expect(sc2.hasAuthority()).toBe(true)
    // And s1 is immediately available again while s2 is still held.
    expect(local.acquireSessionAuthority("s1", "tok-fresh", LEASE)).toBe("ACQUIRED")
    expect(local.acquireSessionAuthority("s2", "tok-intruder", LEASE)).toBe("REFUSED_LEASE_HELD")
    await sc2.stop()
  })
})
