// PHASE 6AA - enablement readiness: what does the flag ACTUALLY do?
//
// [DESIGN DECISION] This file answers 6AA's central question with evidence rather
// than with reports: TECHNICALLY POSSIBLE vs OPERATIONALLY READY. Every claim here
// is measured against the production wiring in `cli/setup.ts` and
// `src/task/production-scheduler.ts`, not against a test double.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createProductionScheduler,
  GATE_DISABLED,
  GATE_ENABLED,
  resolveSchedulerGate,
  schedulerGateFor,
} from "../src/task/production-scheduler.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const S = "6aa"
const prov = { origin: "model", source: "6aa" } as const
const LEASE = 300_000

let dir: string
let store: InstanceType<typeof TaskStore>

function readSrc(rel: string): string {
  return readFileSync(join(import.meta.dir, "..", rel), "utf8")
}

function seed(n = 1, s = S): string[] {
  const ids: string[] = []
  for (let i = 0; i < n; i += 1) {
    ids.push(
      store.createTask(s, { title: `t${i}`, status: "PENDING", order: i + 1, provenance: prov }).id,
    )
  }
  return ids
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6aa-"))
  resetTaskStoreHandles()
  resetSessionOwnershipForTests()
  store = new TaskStore(dir, { authority: "SCHEDULER" })
})
afterEach(async () => {
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

// ═══════════════════════════════════════════════════════════════════════════
// §1  ENABLEMENT CONTRACT
// ═══════════════════════════════════════════════════════════════════════════

describe("§1 enablement contract", () => {
  test("the production caller is exact, and `=true` is documented OFF", () => {
    const src = readSrc("cli/index.ts")
    // The executed expression.
    expect(src).toContain("const schedulerEnabled = resolveSchedulerGate(args) === GATE_ENABLED")
    // No alternate enablement path exists in the file.
    expect(src).not.toMatch(/process\.env\.[A-Za-z_]*SCHEDULER/)
    expect(src).not.toMatch(/MINICODE_SCHEDULER/)
    // The generic matcher is untouched.
    expect(readSrc("cli/args.ts")).toContain("token.startsWith(`${name}=`)")
  })

  test("the four canonical forms resolve exactly as the contract requires", () => {
    // NO FLAG -> OFF
    expect(schedulerGateFor(undefined).enabled).toBe(false)
    expect(schedulerGateFor(false).enabled).toBe(false)
    // EXPLICIT -> ON
    expect(schedulerGateFor(true).enabled).toBe(true)
    // `--enable-scheduler=true` and every other value form -> OFF, because the
    // resolver is an exact-token match. Asserted through the REAL resolver.
    for (const argv of [
      ["--enable-scheduler=true"],
      ["--enable-scheduler=false"],
      ["--enable-scheduler=0"],
      ["--enable-scheduler=1"],
      ["--enable-scheduler=whatever"],
      [],
      ["hello"],
    ]) {
      expect({ argv, on: resolveSchedulerGate(argv).enabled }).toEqual({ argv, on: false })
    }
    expect(resolveSchedulerGate(["--enable-scheduler"]).enabled).toBe(true)
  })

  test("the flag is documented in --help, truthfully (6AB corrected the text)", () => {
    const src = readSrc("cli/index.ts")
    expect(src).toContain('flag: "--enable-scheduler"')
    // [PHASE 6AB] 6AA recorded the original text as the single most misleading fact
    // an operator would meet: it promised "autonomous background task execution"
    // for a process that could not execute anything. The replacement states what the
    // flag does, how to make it act, and that triggering is MANUAL.
    expect(src).toMatch(/EXPERIMENTAL: opt in to the autonomous scheduler/)
    expect(src).toMatch(/default: off/)
    expect(src).toContain("no background timer")
    expect(src).toContain("/scheduler run")
    // And it no longer claims the thing that was never true.
    expect(src).not.toContain("allow autonomous background task execution")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §2  DEFAULT-OFF PROOF
// ═══════════════════════════════════════════════════════════════════════════

describe("§2 default-off is completely inert", () => {
  test("with the gate shut NOTHING is allocated and nothing is touched", async () => {
    seed(2)
    let depsInvoked = false
    const h = await createProductionScheduler(GATE_DISABLED, () => {
      depsInvoked = true
      throw new Error("deps must never be invoked when the gate is shut")
    })
    // Not one autonomous object exists.
    expect({
      depsInvoked,
      constructed: h.constructed,
      active: h.isActive(),
      scheduler: h.getScheduler(),
      trigger: h.getTrigger(),
      fireResult: await h.fire("startup"),
    }).toEqual({
      depsInvoked: false,
      constructed: false,
      active: false,
      scheduler: null,
      trigger: null,
      fireResult: null,
    })
    // No lease, therefore no authority and no background resource.
    expect(store.getSessionAuthority(S)).toBeNull()
    // Ordinary tasks are untouched: the user still owns them.
    expect(store.listTasks(S).map((t) => t.status)).toEqual(["PENDING", "PENDING"])
    // And no execution record of any kind.
    for (const t of store.listTasks(S)) {
      expect(store.getExecutionLineage(S, t.id)).toMatchObject({ execGeneration: 0 })
      expect(store.getExecutionOwnership(S, t.id)?.executionOwner ?? null).toBeNull()
    }
    await h.stop("shutdown")
    expect(store.getSessionAuthority(S)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §3/§5/§6  WHAT EXPLICIT-ON ACTUALLY DOES
// ═══════════════════════════════════════════════════════════════════════════

describe("§3/§5/§6 explicit-ON semantics as built", () => {
  test("ON acquires authority immediately, at construction, before any trigger", async () => {
    seed(1)
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
          throw new Error("no child session may be created without a trigger")
        },
      },
      bindingFor: (taskId: string) => ({
        parentSessionId: S,
        taskId,
        execGeneration: store.getExecutionLineage(S, taskId)?.execGeneration ?? 0,
        sessionIncarnation: store.getSessionIncarnation(S),
      }),
    }))

    // [FACT] Authority is taken at CONSTRUCTION, not at first trigger: start() is
    // called inside createProductionScheduler, and the lease row exists before any
    // fire() has happened. This is deliberate (6X) and it is what makes a second
    // process fail closed.
    expect({ constructed: h.constructed, active: h.isActive() }).toEqual({
      constructed: true,
      active: true,
    })
    expect(store.getSessionAuthority(S)).not.toBeNull()

    // [FACT] But no child session exists yet: nothing has triggered.
    expect(store.listTasks(S)[0]!.status).toBe("PENDING")
    expect(store.getExecutionLineage(S, store.listTasks(S)[0]!.id)).toMatchObject({
      execGeneration: 0,
    })
    await h.stop("shutdown")
  })

  test("the trigger is REQUIRES EXPLICIT: an ON scheduler alone executes nothing", async () => {
    // [FACT] This is the 6AA headline finding, and it is a READINESS fact, not a
    // defect: 6T designed the coordinator with no transport, because the runtime
    // emits no task-mutation event and has no periodic timer.
    seed(1)
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
          throw new Error("no child session may be created without a trigger")
        },
      },
      bindingFor: (taskId: string) => ({
        parentSessionId: S,
        taskId,
        execGeneration: store.getExecutionLineage(S, taskId)?.execGeneration ?? 0,
        sessionIncarnation: store.getSessionIncarnation(S),
      }),
    }))
    // Sitting enabled, for as long as you like, changes nothing.
    for (let i = 0; i < 40; i += 1) await Bun.sleep(10)
    const id = store.listTasks(S)[0]!.id
    expect({
      status: store.getTask(S, id)!.status,
      execGeneration: store.getExecutionLineage(S, id)?.execGeneration,
      lease: store.getSessionAuthority(S) !== null,
    }).toEqual({ status: "PENDING", execGeneration: 0, lease: true })

    // Only an explicit fire evaluates anything - and the handle is the ONLY way to
    // do that, which is why §4 below is blocking.
    const r = await h.fire("explicit-command")
    expect(r).not.toBeNull()
    await h.stop("shutdown")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §4  TRIGGER REALITY - is a fire() reachable from production?
// ═══════════════════════════════════════════════════════════════════════════

describe("§4 trigger reachability in the production wiring", () => {
  // [PHASE 6AB] The two tests below INVERTED in 6AB. They are kept, inverted,
  // rather than deleted, because a 6AA audit that simply stopped asserting the
  // absence of a trigger would let the same regression return unnoticed - and the
  // exact reason 6AA existed is that "the helper is correct" was proven while the
  // product stayed inert.
  test("CLOSED IN 6AB: production reaches fire() through exactly one command route", () => {
    // [FACT] Read from the production sources. This is the difference between
    // "technically possible" and "operationally ready".
    const setup = readSrc("cli/setup.ts")
    const commands = readSrc("cli/commands.ts")

    // 1. The handle is EXPOSED, not kept in a local. 6AA found it constructed and
    //    callable by nobody outside this file.
    expect(setup).toMatch(/^ {4}productionScheduler,$/m)

    // 2. Production calls `fire()` from exactly ONE place, and it is the operator
    //    command - not a timer, not a hook, not startup.
    const fireSites = [...commands.matchAll(/\.\s*fire\s*\(\s*"([a-z-]+)"\s*\)/g)].map((m) => m[1])
    expect(fireSites).toEqual(["explicit-command"])

    // 3. Still no automatic triggering: nothing schedules itself.
    expect(setup).not.toMatch(/setInterval[\s\S]{0,120}fire\(/)
    expect(setup).not.toMatch(/setTimeout[\s\S]{0,120}fire\(/)
  })

  test("CLOSED IN 6AB: the scheduler's event stream now reaches an operator surface", () => {
    // [FACT] The events were always well-defined. 6AA proved production passed no
    // sink, so they were constructed and discarded; auditability rested entirely on
    // durable task state. 6AB wires both sinks at the composition root.
    const prod = readSrc("src/task/production-scheduler.ts")
    expect(prod).toContain("onSchedulerEvent")
    expect(prod).toContain("onTriggerEvent")

    const setup = readSrc("cli/setup.ts")
    expect(setup).toMatch(/onSchedulerEvent\s*:/)
    expect(setup).toMatch(/onTriggerEvent\s*:/)

    // ...and the projection is exposed so the operator command can read it.
    expect(setup).toMatch(/^ {4}schedulerObservability,$/m)
    // The sinks live INSIDE the deps thunk, so OFF still constructs nothing.
    const thunkStart = setup.indexOf("async () => {")
    const sink = setup.indexOf("onSchedulerEvent:")
    const compose = setup.indexOf("createProductionScheduler(")
    expect(sink).toBeGreaterThan(thunkStart)
    expect(sink).toBeGreaterThan(compose)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §10  STARTUP FAILURE SEMANTICS
// ═══════════════════════════════════════════════════════════════════════════

describe("§10 startup failures are explicit, never silent", () => {
  test("lease unavailable -> construction THROWS; nothing half-installed", async () => {
    seed(1)
    // A live lease held by another process.
    const other = new TaskStore(dir, { authority: "SCHEDULER" })
    other.acquireSessionAuthority(S, "someone-else", LEASE)

    let threw = ""
    let h: Awaited<ReturnType<typeof createProductionScheduler>> | null = null
    try {
      h = await createProductionScheduler(GATE_ENABLED, () => ({
        sessionId: S,
        cwd: dir,
        store,
        instruction: "x",
        adapter: {
          store,
          tools: [{ name: "read_file" }],
          cwdFor: () => dir,
          sessionFactory: async () => {
            throw new Error("must not be reached")
          },
        },
        bindingFor: (t: string) => ({
          parentSessionId: S,
          taskId: t,
          execGeneration: 0,
          sessionIncarnation: 1,
        }),
      }))
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    // [FACT] Explicit, non-success, and it names the LEASE rather than a generic
    // failure. The process cannot continue believing the Scheduler is active.
    expect(threw).toMatch(/lease held by another process/)
    expect(h).toBeNull()
    // The existing owner is untouched.
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("someone-else")
    // And the ordinary user path is unaffected: the task is still theirs.
    expect(store.listTasks(S)[0]!.status).toBe("PENDING")
  })

  test("a missing provider or a throwing deps() also fails loudly", async () => {
    let msg = ""
    try {
      await createProductionScheduler(GATE_ENABLED, () => {
        throw new Error("provider chain unavailable")
      })
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    expect(msg).toMatch(/provider chain unavailable/)
    expect(store.getSessionAuthority(S)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §15/§16  ROLLBACK AND COMPATIBILITY
// ═══════════════════════════════════════════════════════════════════════════

describe("§15-16 rollback and compatibility", () => {
  test("ENABLE -> execute -> STOP -> restart OFF leaves no usable lease", async () => {
    seed(1)
    const mk = () =>
      createProductionScheduler(GATE_ENABLED, () => ({
        sessionId: S,
        cwd: dir,
        store,
        instruction: "x",
        adapter: {
          store,
          tools: [{ name: "read_file" }],
          cwdFor: () => dir,
          sessionFactory: async () => ({
            async run() {
              return { finalText: "ok", usage: { steps: 1 } }
            },
            abort() {},
          }),
        },
        bindingFor: (t: string) => ({
          parentSessionId: S,
          taskId: t,
          execGeneration: store.getExecutionLineage(S, t)?.execGeneration ?? 0,
          sessionIncarnation: store.getSessionIncarnation(S),
        }),
      }))

    const first = await mk()
    await first.fire("startup")
    expect(store.getSessionAuthority(S)).not.toBeNull()
    await first.stop("shutdown")

    // ROLLBACK: a new process WITHOUT the flag.
    const off = await createProductionScheduler(GATE_DISABLED, () => {
      throw new Error("must stay inert")
    })
    expect(off.constructed).toBe(false)
    // No lease remains usable, and nothing new starts.
    expect(store.getSessionAuthority(S)).toBeNull()
    expect(await off.fire("startup")).toBeNull()

    // RE-ENABLE: a clean new authority lifecycle begins.
    const second = await mk()
    const secondToken = (second.getScheduler() as unknown as { authorityToken: string })
      .authorityToken
    expect(store.getSessionAuthority(S)?.ownerToken).toBe(secondToken)
    await second.stop("shutdown")
    expect(store.getSessionAuthority(S)).toBeNull()
  })

  test("a stale lease from a dead process is a safe takeover, not a failure", () => {
    seed(1)
    // A crashed owner: a row nobody will ever release.
    store.acquireSessionAuthority(S, "crashed", LEASE)
    resetSessionOwnershipForTests() // the process died
    const other = new TaskStore(dir, { authority: "SCHEDULER" })
    // Blocked while nominally live ...
    expect(other.acquireSessionAuthority(S, "replacement", LEASE)).toBe("REFUSED_LEASE_HELD")
    // ... and available the moment it lapses. Recovery, by expiry.
    const exp = store.getSessionAuthority(S)!.leaseExpiresAt
    expect(other.acquireSessionAuthority(S, "replacement", LEASE, exp)).toBe("ACQUIRED")
  })

  test("a deleted session fails safe: the handle stops, nothing is inherited", async () => {
    seed(1)
    const h = await createProductionScheduler(GATE_ENABLED, () => ({
      sessionId: S,
      cwd: dir,
      store,
      instruction: "x",
      adapter: {
        store,
        tools: [{ name: "read_file" }],
        cwdFor: () => dir,
        sessionFactory: async () => ({
          async run() {
            return { finalText: "ok", usage: { steps: 1 } }
          },
          abort() {},
        }),
      },
      bindingFor: (t: string) => ({
        parentSessionId: S,
        taskId: t,
        execGeneration: store.getExecutionLineage(S, t)?.execGeneration ?? 0,
        sessionIncarnation: store.getSessionIncarnation(S),
      }),
    }))
    const oldToken = (h.getScheduler() as unknown as { authorityToken: string }).authorityToken

    // Deletion, in the canonical order.
    store.bumpSessionIncarnation(S)
    store.deleteSessionTasks(S)
    expect(h.getScheduler()!.hasAuthority()).toBe(false)
    const r = await h.getScheduler()!.cycle()
    expect(r.stop).toBe("session-superseded")
    // A recreated session does not inherit the old authority.
    seed(1)
    expect(store.getSessionAuthority(S)).toBeNull()
    expect(store.renewSessionAuthority(S, oldToken, LEASE)).toBe("AUTHORITY_LOST")
    expect(store.releaseSessionAuthority(S, oldToken)).toBe(false)
    await h.stop("shutdown")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §19  PRODUCTION CONSTRUCTION COUNT
// ═══════════════════════════════════════════════════════════════════════════

describe("§19 production construction count", () => {
  test("exactly one site, and it is unreachable when OFF", () => {
    const files = [
      "src/task/production-scheduler.ts",
      "src/task/scheduler.ts",
      "cli/index.ts",
      "cli/setup.ts",
    ]
    const sites = files
      .map((f) => {
        const code = readSrc(f)
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/^\s*\/\/.*$/gm, " ")
        return [f, code.match(/new Scheduler\(/g)?.length ?? 0] as const
      })
      .filter(([, n]) => n > 0)
    expect(sites).toEqual([["src/task/production-scheduler.ts", 1]])

    // The single site sits BEHIND the gate, and the gate short-circuits before the
    // deps thunk that reaches it.
    const prod = readSrc("src/task/production-scheduler.ts")
    const gateAt = prod.indexOf("if (!gate.enabled) return inertHandle(gate)")
    const buildAt = prod.indexOf("new Scheduler(")
    expect(gateAt).toBeGreaterThan(-1)
    expect(buildAt).toBeGreaterThan(gateAt)
  })
})
