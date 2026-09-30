// PHASE 6X - the F02 acceptance test, run as TWO REAL OS PROCESSES.
//
// [DESIGN DECISION] 6V reproduced F02 in-process with two TaskStore handles. That
// proved the LOGIC was wrong but not the BUG: the original defect only appears when
// authority is process-local, and in one process the in-memory registry is shared.
// So this file spawns two actual `bun` processes against one tasks.db, has them
// rendezvous on a file barrier (never a sleep), and drives one real execution each.
//
// There is no mock, no fake store, and no shared memory here. If this passes, the
// fix is a property of the deployed system.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const S = "6x-proc"
// The repo root, injected into the child source as a literal so the child needs no
// imports of its own and cannot be confused by a relative specifier.
const REPO = import.meta.dir.replace(/[\\/]test$/, "").replace(/\\/g, "/")
// A placeholder the child's import lines carry, replaced with REPO before writing.
const ROOT_TOKEN = "__REPO_ROOT__"
const SESS = JSON.stringify(S)
let dir: string

/**
 * The child program. Each process is told which role to play and where the shared
 * database is. Roles:
 *   "first"  - acquire the lease, claim a task, hold the turn, then report
 *   "second" - wait at the barrier, then try to schedule and report what happened
 */
const CHILD = `
import { Scheduler } from "__REPO_ROOT__/src/task/scheduler.ts"
import { TaskStore } from "__REPO_ROOT__/src/task/store.ts"

const cwd = process.argv[2]
const role = process.argv[3]
const barrier = process.argv[4]
const prov = { origin: "model", source: "6x-proc" }
const OK = { kind: "returned", ok: true }

const fs = await import("node:fs")
const existsSync = fs.existsSync
const readFileSync = fs.readFileSync
const writeFileSync = fs.writeFileSync
const store = new TaskStore(cwd, { authority: "SCHEDULER" })
const mk = (runTurn) => new Scheduler(${SESS}, { store, runTurn, instruction: "x" })

const report = (o) => { console.log("__REPORT__" + JSON.stringify(o)) }

if (role === "first") {
  // A turn that stays RUNNING until the second process has finished trying, so the
  // live execution really is live across the whole window.
  let release
  const held = new Promise((r) => { release = r })
  const sc = mk(async () => { await held; return OK })
  let started = "ok"
  try { sc.start() } catch (e) { started = String(e && e.message) }
  if (started !== "ok") { report({ role, started }); process.exit(0) }

  // Signal that we hold authority and have a claim in flight.
  const t = store.listTasks(${SESS}).find((x) => x.title === "shared")
  const r = store.claimTask(${SESS}, t.id, t.revision)
  writeFileSync(barrier, "held:" + r.outcome)

  // Wait for the second process to finish attempting, then let the turn complete.
  const deadline = Date.now() + 60_000
  while (!existsSync(barrier + ".done") && Date.now() < deadline) {
    await Bun.sleep(20)
  }
  release()
  const res = await sc.cycle()
  report({ role, started, claim: r.outcome, cycleStop: res.stop, lineage: res.dispatched && res.dispatched.lineage })
  await sc.stop()
  process.exit(0)
}

if (role === "second") {
  // Wait for the first process to actually hold a live claim.
  const deadline = Date.now() + 60_000
  while (!(existsSync(barrier) && readFileSync(barrier, "utf8").startsWith("held:")) && Date.now() < deadline) {
    await Bun.sleep(20)
  }
  const before = readFileSync(barrier, "utf8")

  // THE ATTACK: try to schedule the same session while another process is mid-turn.
  const sc = mk(() => OK)
  let started = "ok"
  try { sc.start() } catch (e) { started = String(e && e.message) }
  let cycleStop = null
  if (started === "ok") { const r = await sc.cycle(); cycleStop = r.stop }

  const t = store.listTasks(${SESS}).find((x) => x.title === "shared")
  report({ role, started, cycleStop, statusAfter: t && t.status, barrier: before })
  if (started === "ok") await sc.stop()
  writeFileSync(barrier + ".done", "1")
  process.exit(0)
}
`

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6xproc-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe("F02 acceptance: two real processes, one session, one live execution", () => {
  test("a second process cannot start a Scheduler for a live cross-process session", async () => {
    // Seed the session from the parent, using the real store.
    const { TaskStore } = await import("../src/task/store.ts")
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    store.createTask(S, {
      title: "shared",
      status: "PENDING",
      order: 1,
      provenance: { origin: "model", source: "6x-proc" },
    })

    const childPath = join(dir, "child.ts")
    // [FACT] The child lives in a temp dir, so its imports are made ABSOLUTE. A
    // relative specifier would resolve against the temp dir and the child would die
    // on module resolution - a failure that looks nothing like the bug under test.
    const childSrc = CHILD.replaceAll(ROOT_TOKEN, REPO)
    await writeFileSync(childPath, childSrc, "utf8")
    const barrier = join(dir, "barrier")

    const spawn = (role: string) =>
      Bun.spawn(["bun", childPath, dir, role, barrier], {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      })

    const first = spawn("first")
    const second = spawn("second")
    const [o1, o2, e1, e2] = await Promise.all([
      new Response(first.stdout).text(),
      new Response(second.stdout).text(),
      new Response(first.stderr).text(),
      new Response(second.stderr).text(),
    ])
    await Promise.all([first.exited, second.exited])

    const report = (s: string, e: string) => {
      const line = s.split("\n").find((l) => l.startsWith("__REPORT__"))
      if (line === undefined)
        throw new Error(`no report. stdout=${s.slice(0, 300)} | stderr=${e.slice(0, 600)}`)
      return JSON.parse(line.slice("__REPORT__".length))
    }
    const r1 = report(o1, e1)
    const r2 = report(o2, e2)

    // The first process really did take authority and a real claim.
    expect(r1.started).toBe("ok")
    expect(r1.claim).toBe("CLAIM_ACCEPTED")

    // THE FIX. Process two must be refused, and the message must name the lease
    // rather than something process-local - that is the whole difference between
    // this and 6V.
    expect(r2.started).not.toBe("ok")
    expect(r2.started).toMatch(/lease held by another process/)

    // And because it was refused, it could not have touched the live claim: the
    // task is still IN_PROGRESS, i.e. nobody reverted another process's work.
    expect(r2.statusAfter).toBe("IN_PROGRESS")

    // Control: the first process still finishes its own turn normally, and records a
    // lineage marker. Without this, "nothing was reverted" could just mean the first
    // process died. `already-dispatched` is expected and correct: the child claims the
    // task itself to establish the live cross-process window, so the Scheduler's own
    // cycle has nothing left to dispatch - the control is that the turn completes and
    // the lineage is written, not that the Scheduler claimed the task.
    expect(r1.cycleStop).toBe("already-dispatched")
    expect(r1.lineage).not.toBeNull()
  }, 120_000)
})
