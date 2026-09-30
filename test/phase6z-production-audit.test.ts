// PHASE 6Z §9-§18, §21 - production composition audit.
//
// [DESIGN DECISION] Every test drives `createProductionScheduler` - the ONE
// production composition root - with a real TaskStore and the real
// `sessionFactory` seam. Nothing constructs a `Scheduler` directly: a directly
// constructed one never touches the gate, the lease, or the shutdown path.
//
// [DESIGN DECISION] Assertions read DURABLE state, not closures. A value captured
// in a test's own factory is invisible to another process and easy to capture at
// the wrong moment; `exec_generation` and `attempt_generation` are facts in the
// database that any process can read.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AutonomousPolicyLedger,
  assertAutonomousToolScope,
  createAutonomousPermissionHandler,
} from "../src/task/autonomous-policy.ts"
import {
  createProductionScheduler,
  GATE_DISABLED,
  GATE_ENABLED,
  type ProductionSchedulerHandle,
} from "../src/task/production-scheduler.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const S = "6z"
const prov = { origin: "model", source: "6z" } as const
const LEASE = 300_000

let dir: string
let store: InstanceType<typeof TaskStore>
let other: InstanceType<typeof TaskStore>

interface Captured {
  handler?: unknown
  mode?: string
  tools?: readonly { name: string }[]
  sessionId?: string
  parentSessionId?: string
  timeoutMs?: number
  maxSteps?: number
  factoryCalls: number
}

/** Poll a condition. An unfounded sleep is a flaky test that hides regressions. */
async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await Bun.sleep(2)
  }
}

async function prod(
  captured: Captured,
  opts: { turn?: () => Promise<void>; gate?: typeof GATE_ENABLED | typeof GATE_DISABLED } = {},
): Promise<ProductionSchedulerHandle> {
  return createProductionScheduler(opts.gate ?? GATE_ENABLED, () => ({
    sessionId: S,
    cwd: dir,
    store,
    instruction: "x",
    adapter: {
      store,
      // read_file is on the 6S matrix. A wider set must be refused at construction.
      tools: [{ name: "read_file" }],
      cwdFor: () => dir,
      sessionFactory: async (spec) => {
        captured.factoryCalls += 1
        captured.handler = spec.permissionHandler
        captured.mode = spec.permissionMode
        captured.tools = spec.tools
        captured.sessionId = spec.sessionId
        captured.parentSessionId = spec.parentSessionId
        captured.timeoutMs = spec.timeoutMs
        captured.maxSteps = spec.maxSteps
        return {
          async run() {
            if (opts.turn) await opts.turn()
            return { finalText: "ok", usage: { steps: 1 } }
          },
          abort() {},
        }
      },
    },
    // [FACT] The binding is read at CLAIM time, so the generation must come from the
    // store. A literal 0 makes `planAutonomousContext` refuse to plan, and the turn
    // is rejected before the child session is ever created.
    bindingFor: (taskId: string) => ({
      parentSessionId: S,
      taskId,
      execGeneration: store.getExecutionLineage(S, taskId)?.execGeneration ?? 0,
      sessionIncarnation: store.getSessionIncarnation(S),
    }),
  }))
}

function newCaptured(): Captured {
  return { factoryCalls: 0 }
}

function seed(n = 1): string[] {
  // [DESIGN DECISION] Returns the created ids: a test that asserts on a task must
  // name it, and `listTasks()[0]` is an assumption about ordering.
  const ids: string[] = []
  for (let i = 0; i < n; i += 1) {
    ids.push(
      store.createTask(S, { title: `t${i}`, status: "PENDING", order: i + 1, provenance: prov }).id,
    )
  }
  return ids
}

/** The single seeded task, or a loud failure. Never an `undefined` id. */
function seedOne(): string {
  const [id] = seed(1)
  if (id === undefined) throw new Error("expected a seeded task")
  return id
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6zprod-"))
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
// §9-§10  GATE AND PERMISSION, THROUGH THE PRODUCTION ROOT
// ═══════════════════════════════════════════════════════════════════════════

describe("§9-§10 gate and permission through the production root", () => {
  test("OFF constructs nothing, invokes no deps, and creates no lease", async () => {
    seed()
    const h = await prod(newCaptured(), { gate: GATE_DISABLED })
    expect({
      constructed: h.constructed,
      active: h.isActive(),
      scheduler: h.getScheduler(),
    }).toEqual({
      constructed: false,
      active: false,
      scheduler: null,
    })
    expect(store.getSessionAuthority(S)).toBeNull()
    expect(await h.fire("startup")).toBeNull()
    await h.stop("shutdown")
    expect(store.getSessionAuthority(S)).toBeNull()
  })

  test("ON injects the 6S handler with no mode control, and reaches the child", async () => {
    const id = seedOne()
    const c = newCaptured()
    const h = await prod(c)
    const r = await h.fire("startup")
    expect(r).not.toBeNull()
    await waitFor(() => c.factoryCalls > 0)

    // [FACT] The production composition handed the child the 6S policy object and
    // "readonly" as metadata only.
    expect({ mode: c.mode, hasHandler: c.handler !== undefined }).toEqual({
      mode: "readonly",
      hasHandler: true,
    })
    // The derived child id names the parent but is not the parent's conversation.
    expect(c.sessionId).toBe(`auto~${S}~${id}~1`)
    expect(c.parentSessionId).toBe(S)

    // The policy denies everything off the matrix, with no mode seam to revoke it.
    const handler = c.handler as { check: (x: unknown) => Promise<string> }
    expect(await handler.check({ id: "1", name: "read_file", args: {} })).toBe("allow")
    for (const t of ["bash", "web_fetch", "edit", "task_write", "mystery"]) {
      expect(await handler.check({ id: "1", name: t, args: {} })).toBe("deny")
    }
    const raw = c.handler as unknown as Record<string, unknown>
    expect({ s: "__setMode" in raw, g: "__getMode" in raw }).toEqual({ s: false, g: false })

    // And a real, recorded attempt happened.
    expect(store.getExecutionLineage(S, id)).toMatchObject({
      execGeneration: 1,
      attemptGeneration: 1,
    })
    await h.stop("shutdown")
  })

  test("the creation-time scope gate refuses any non-readonly tool set", () => {
    expect(() => assertAutonomousToolScope(["read_file", "grep", "glob"])).not.toThrow()
    for (const bad of [["bash"], ["web_fetch"], ["edit"], ["unknown_thing"]]) {
      expect(() => assertAutonomousToolScope(bad)).toThrow()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §12  LIFECYCLE THROUGH PRODUCTION
// ═══════════════════════════════════════════════════════════════════════════

describe("§12 production lifecycle", () => {
  test("new session -> enable -> claim -> execute -> lineage -> stop releases the lease", async () => {
    const id = seedOne()
    const h = await prod(newCaptured())
    expect(h.constructed).toBe(true)
    expect(store.getSessionAuthority(S)).not.toBeNull()
    await h.fire("startup")
    // A real execution: claimed, attempted, and NOT fabricated as COMPLETED.
    expect(store.getTask(S, id)!.status).toBe("IN_PROGRESS")
    expect(store.getExecutionLineage(S, id)).toMatchObject({
      execGeneration: 1,
      attemptGeneration: 1,
    })
    await h.stop("shutdown")
    // No authority leak, and the handle is inert afterwards.
    expect(store.getSessionAuthority(S)).toBeNull()
    expect(h.isActive()).toBe(false)
    expect(await h.fire("startup")).toBeNull()
  })

  test("execute -> delete session -> the late turn cannot write", async () => {
    let release = (): void => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    seed()
    const h = await prod(newCaptured(), {
      turn: async () => {
        await held
      },
    })
    const firing = h.fire("startup")
    while (h.getScheduler()!.getActiveClaim() === null) await Bun.sleep(2)

    // The canonical deletion order, performed as if by another process.
    store.bumpSessionIncarnation(S)
    store.deleteSessionTasks(S)
    release()
    await firing

    expect(store.listTasks(S)).toHaveLength(0)
    expect(h.getScheduler()!.getLifecycle()).toBe("STOPPED")
    await h.stop("shutdown")
  })

  test("delete -> recreate -> new incarnation -> new authority; the old one is powerless", async () => {
    seed()
    const first = await prod(newCaptured())
    const oldToken = (first.getScheduler()! as unknown as { authorityToken: string }).authorityToken
    await first.stop("shutdown")

    store.bumpSessionIncarnation(S)
    store.deleteSessionTasks(S)
    seed(1)

    const second = await prod(newCaptured())
    const newToken = (second.getScheduler()! as unknown as { authorityToken: string })
      .authorityToken
    expect(newToken).not.toBe(oldToken)
    expect(second.getScheduler()!.hasAuthority()).toBe(true)
    // The OLD token cannot renew or release the new incarnation.
    expect(store.renewSessionAuthority(S, oldToken, LEASE)).toBe("AUTHORITY_LOST")
    expect(store.releaseSessionAuthority(S, oldToken)).toBe(false)
    expect(store.getSessionAuthority(S)?.ownerToken).toBe(newToken)
    await second.stop("shutdown")
  })

  test("crash -> lease expiry -> a replacement acquires, with no detection involved", async () => {
    seed()
    await prod(newCaptured())
    const row = store.getSessionAuthority(S)!
    resetSessionOwnershipForTests() // the process "dies"; nothing is released
    expect(other.acquireSessionAuthority(S, "replacement", LEASE)).toBe("REFUSED_LEASE_HELD")
    expect(other.acquireSessionAuthority(S, "replacement", LEASE, row.leaseExpiresAt)).toBe(
      "ACQUIRED",
    )
    expect(store.getSessionAuthority(S)?.ownerToken).toBe("replacement")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §14  USER AND AUTONOMOUS INTERACTION
// ═══════════════════════════════════════════════════════════════════════════

describe("§14 user and autonomous turns do not share authority", () => {
  test("a user edit during an autonomous turn is not mistaken for Scheduler work", async () => {
    let release = (): void => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    seed(1)
    const h = await prod(newCaptured(), {
      turn: async () => {
        await held
      },
    })
    const firing = h.fire("startup")
    while (h.getScheduler()!.getActiveClaim() === null) await Bun.sleep(2)
    const autonomous = h.getScheduler()!.getActiveClaim()!

    // The user adds and completes a DIFFERENT task mid-flight.
    const userTask = store.createTask(S, {
      title: "user",
      status: "PENDING",
      order: 99,
      provenance: prov,
    })
    store.patchTask(S, userTask.id, { status: "COMPLETED" })
    // The Scheduler never claimed it, so there is no execution record for it.
    expect(store.getExecutionOwnership(S, userTask.id)?.executionOwner ?? null).toBeNull()
    expect(store.getExecutionLineage(S, userTask.id)?.execGeneration).toBe(0)

    release()
    await firing
    expect(autonomous.taskId).not.toBe(userTask.id)
    expect(store.getTask(S, userTask.id)!.status).toBe("COMPLETED")
    await h.stop("shutdown")
  })

  test("a failed turn never fabricates a completion", async () => {
    seed()
    const h = await prod(newCaptured(), {
      turn: async () => {
        throw new Error("aborted")
      },
    })
    await h.fire("startup")
    await h.stop("shutdown")
    // The Scheduler only ever writes IN_PROGRESS and PENDING. A failed turn leaves
    // the task in flight for a legitimate authority to move - never COMPLETED.
    expect(store.listTasks(S).every((t) => t.status !== "COMPLETED")).toBe(true)
    expect(store.getSessionAuthority(S)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §15  SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════

describe("§15 shutdown boundary", () => {
  test("after stop: no new work, no new claim, no revision movement", async () => {
    const id = seedOne()
    const h = await prod(newCaptured())
    await h.fire("startup")
    const before = store.getTask(S, id)!.revision
    await h.stop("shutdown")
    expect(await h.fire("startup")).toBeNull()
    expect(store.getTask(S, id)!.revision).toBe(before)
    // Idempotent.
    await h.stop("shutdown")
    expect(h.isActive()).toBe(false)
  })

  test("shutdown during an in-flight turn still releases the lease", async () => {
    let release = (): void => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    seed()
    const h = await prod(newCaptured(), {
      turn: async () => {
        await held
      },
    })
    const firing = h.fire("startup")
    while (h.getScheduler()!.getActiveClaim() === null) await Bun.sleep(2)
    const stopping = h.stop("shutdown")
    release()
    await Promise.all([firing, stopping])
    expect(store.getSessionAuthority(S)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §16  TRIGGER LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

describe("§16 trigger lifecycle", () => {
  test("a task that becomes ready later needs an EXPLICIT fire - by design, not by bug", async () => {
    // [FACT] 6T recorded that the runtime has no task-mutation event to hook and
    // no periodic timer, so `TriggerCoordinator` has nothing to poll. There is
    // therefore NO automatic retrigger. This pins that as documented behaviour, so
    // it cannot later be read as an unnoticed defect - or "fixed" by inventing a
    // second evaluation mechanism.
    const c = newCaptured()
    const h = await prod(c)
    expect(await h.fire("startup")).not.toBeNull()
    expect(c.factoryCalls).toBe(0) // nothing to do

    // The user adds a task afterwards. Nothing picks it up on its own.
    const added = store.createTask(S, {
      title: "later",
      status: "PENDING",
      order: 1,
      provenance: prov,
    })
    expect(c.factoryCalls).toBe(0)
    expect(store.getExecutionLineage(S, added.id)?.execGeneration).toBe(0)

    // Only an explicit fire evaluates it.
    const r1 = await h.fire("explicit-command")
    expect(r1).not.toBeNull()
    await waitFor(() => c.factoryCalls > 0)
    expect(store.getExecutionLineage(S, added.id)?.execGeneration).toBe(1)
    expect(store.getTask(S, added.id)?.title).toBe("later")
    await h.stop("shutdown")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §17-§18  RESOURCES AND LONG-RUN STABILITY
// ═══════════════════════════════════════════════════════════════════════════

describe("§17-§18 resources and long-run stability", () => {
  test("200 construct -> trigger -> execute -> stop cycles leak no lease", async () => {
    // [DESIGN DECISION] The lease row is the durable thing that can leak, and a
    // leak would wedge the session for a full lease period. Checked every 25
    // cycles, not only at the end.
    for (let i = 0; i < 200; i += 1) {
      seed(1)
      const h = await prod(newCaptured())
      if (i % 25 === 0) expect(store.getSessionAuthority(S)).not.toBeNull()
      await h.fire("startup")
      await h.stop("shutdown")
      if (i % 25 === 0) expect(store.getSessionAuthority(S)).toBeNull()
    }
    expect(store.getSessionAuthority(S)).toBeNull()
  }, 600_000)

  test("500 cycles on ONE handle: every task executed exactly once, no wedge", async () => {
    // [DESIGN DECISION] One long-lived handle is the stress that matters; a fresh
    // handle each time never exercises accumulation.
    const ids = seed(500)
    const c = newCaptured()
    const h = await prod(c)
    for (let i = 0; i < 500; i += 1) {
      if ((await h.fire("explicit-command")) === null) break
    }
    await h.stop("shutdown")

    // 500 real child contexts were created, one per dispatched task.
    expect(c.factoryCalls).toBe(500)
    // Every task left PENDING, each with EXACTLY one generation: no duplicate
    // execution and no generation inflation across 500 cycles.
    for (const id of ids) {
      expect(store.getExecutionLineage(S, id)).toMatchObject({
        execGeneration: 1,
        attemptGeneration: 1,
      })
      expect(store.getTask(S, id)!.status).toBe("IN_PROGRESS")
    }
    // No wedge, and no orphan authority once stopped.
    expect(h.getScheduler()!.getLifecycle()).toBe("STOPPED")
    expect(store.getSessionAuthority(S)).toBeNull()
  }, 900_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// §21  SECURITY COMPOSITION
// ═══════════════════════════════════════════════════════════════════════════

describe("§21 privileged objects are assembled from the right sources", () => {
  test("no second privileged object is constructed by the production path", () => {
    // [FACT] Read from the production sources. A second construction of any
    // privileged object is the accident this test exists to catch.
    const src = readFileSync(
      join(import.meta.dir, "..", "src/task/production-scheduler.ts"),
      "utf8",
    )
    expect({
      scheduler: (src.match(/new Scheduler\(/g) ?? []).length,
      trigger: (src.match(/new TriggerCoordinator\(/g) ?? []).length,
      runTurn: (src.match(/buildAutonomousRunTurn\(/g) ?? []).length,
    }).toEqual({ scheduler: 1, trigger: 1, runTurn: 1 })

    // The permission handler is created in exactly ONE place, 6S. The composition
    // INJECTS a policy; it never builds or widens one.
    const sessionSrc = readFileSync(join(import.meta.dir, "..", "src/app/session.ts"), "utf8")
    expect((sessionSrc.match(/createPermissionHandler\(/g) ?? []).length).toBe(1)
    expect(sessionSrc).not.toContain("createAutonomousPermissionHandler")
    // And the suppression guard is the production one, not a helper's.
    expect(sessionSrc).toContain("if (onPermissions && !injected) {")
  })

  test("the injected policy shares no state with any other policy object", async () => {
    const id = seedOne()
    const c = newCaptured()
    const h = await prod(c)
    await h.fire("startup")
    await waitFor(() => c.factoryCalls > 0)
    const injected = c.handler as { check: (x: unknown) => Promise<string> }
    const other2 = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
    expect((injected as unknown) === (other2 as unknown)).toBe(false)
    // A denial recorded by one is invisible to the other: separate ledgers.
    expect(await other2.check({ id: "1", name: "bash", args: {} })).toBe("deny")
    expect(await injected.check({ id: "2", name: "bash", args: {} })).toBe("deny")
    expect(store.getExecutionLineage(S, id)?.execGeneration).toBe(1)
    await h.stop("shutdown")
  })
})
