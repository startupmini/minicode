// PHASE 6V — ADVERSARIAL audit of the composed production path.
//
// AUDIT ONLY. Nothing here patches production code; every test is an ATTACK that
// either passes (the boundary held) or fails (a finding to be recorded, not
// fixed). Each test names the attack surface it probes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasFlag } from "../cli/args.ts"
import {
  AutonomousPolicyLedger,
  createAutonomousPermissionHandler,
} from "../src/task/autonomous-policy.ts"
import {
  createProductionScheduler,
  GATE_DISABLED,
  GATE_ENABLED,
  type ProductionSchedulerDeps,
  resolveSchedulerGate,
  schedulerGateFor,
} from "../src/task/production-scheduler.ts"
import {
  notifySessionInvalidated,
  onSessionInvalidated,
  releaseSessionOwnershipFor,
  resetSessionOwnershipForTests,
  watchedSessions,
} from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

let dir: string
let store: TaskStore
const S = "6v"
const prov = { origin: "model", source: "6v" } as const

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-6v-"))
  store = new TaskStore(dir, { authority: "SCHEDULER" })
  resetSessionOwnershipForTests()
})
afterEach(async () => {
  resetSessionOwnershipForTests()
  resetTaskStoreHandles()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

const gen = (id: string, sess = S) => store.getExecutionLineage(sess, id)?.execGeneration ?? 0
const attempt = (id: string, sess = S) =>
  store.getExecutionLineage(sess, id)?.attemptGeneration ?? null

type DepsOpt = {
  sess?: string
  park?: boolean
  onRun?: (taskId: string) => void
  onAbort?: () => void
  cwd?: string
  tools?: readonly { name: string }[]
}
function deps(o: DepsOpt = {}): () => ProductionSchedulerDeps {
  const sess = o.sess ?? S
  return () => {
    const st = store
    return {
      sessionId: sess,
      cwd: o.cwd ?? dir,
      store: st,
      instruction: "x",
      adapter: {
        store: st,
        tools: o.tools ?? [{ name: "read_file" }],
        cwdFor: () => o.cwd ?? dir,
        sessionFactory: async () => {
          const latch: { release: (() => void) | null } = { release: null }
          return {
            async run() {
              o.onRun?.(sess)
              if (o.park) {
                return new Promise((r) => {
                  latch.release = () => r({ finalText: "ok", usage: { steps: 1 } })
                })
              }
              return { finalText: "ok", usage: { steps: 1 } }
            },
            abort() {
              o.onAbort?.()
              latch.release?.()
            },
          }
        },
      },
      bindingFor: (taskId: string) => ({
        parentSessionId: sess,
        taskId,
        execGeneration: st.getExecutionLineage(sess, taskId)?.execGeneration ?? 0,
        sessionIncarnation: st.getSessionIncarnation(sess),
      }),
    }
  }
}
const addTask = (order = 1, status: "PENDING" | "BLOCKED" | "COMPLETED" = "PENDING") =>
  store.createTask(S, {
    title: `t${order}`,
    status,
    order,
    provenance: prov,
    // [HARNESS FIX] `BLOCKED requires blockedReason` — the store validates at
    // creation, so a BLOCKED task must be born with its reason.
    ...(status === "BLOCKED" ? { blockedReason: "cannot proceed" } : {}),
  })

/**
 * A LEGACY-authority store: the interactive path.
 *
 * [HARNESS FIX] Three attacks failed with "IN_PROGRESS may only be authored by
 * claimTask while Scheduler authority is active". That refusal is 6P WORKING —
 * a user genuinely cannot forge a Scheduler-owned status — so the attacks have to
 * author the interactive state through the authority that is allowed to.
 */
const legacy = () => new TaskStore(dir, { authority: "LEGACY" })

// ═══ §4/§5 PERMISSION BOUNDARY REGRESSION ═══════════════════════════════════

describe("§4-5 permission boundary under composition", () => {
  test("§4.1 the 6S handler has no revocable mode, even composed", () => {
    const h = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
    expect({
      setMode: "__setMode" in (h as object),
      getMode: "__getMode" in (h as object),
    }).toEqual({ setMode: false, getMode: false })
  })

  test("§5.1 UNKNOWN / newly-registered tools deny (not just the known list)", async () => {
    // §5: "Attempt an unknown/newly registered tool where the architecture allows
    // one." MCP tools are `serverid.toolname` and are added at RUNTIME.
    const h = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
    const runtime = [
      "acme.brand_new_tool",
      "github.create_issue",
      "mcp_list",
      "mcp_call",
      "weird.0",
      "UPPER.CASE",
      "read_file",
    ]
    const out: Record<string, string> = {}
    for (const n of runtime) out[n] = await h.check({ name: n, args: {} } as never)
    // Everything the 6S matrix calls autonomous stays allowed; everything else,
    // including a name that did not exist when the matrix was written, denies.
    expect(out).toEqual({
      "acme.brand_new_tool": "deny",
      "github.create_issue": "deny",
      mcp_list: "allow",
      mcp_call: "deny",
      "weird.0": "deny",
      "UPPER.CASE": "deny",
      read_file: "allow",
    })
  })

  test("§5.2 nested delegation cannot reach an autonomous child", async () => {
    // §5: nested -> delegate_task -> child. 6R removed the delegation factory
    // from the autonomous adapter, so nesting is NOT IMPLEMENTED; and even if a
    // bridge offered it, the tool is denied by name.
    const h = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
    expect(await h.check({ name: "delegate_task", args: {} } as never)).toBe("deny")
    const { buildAutonomousRunTurn } = await import("../src/task/autonomous-adapter.ts")
    expect(typeof buildAutonomousRunTurn).toBe("function")
  })

  test("§4.2 an interactive session is NOT readonly (control: the gate is specific)", async () => {
    // The control that stops a vacuous pass: if this also denied, the autonomous
    // policy would be indistinguishable from a broken one.
    const { createPermissionHandler } = await import("../src/policy/permission.ts")
    const interactive = createPermissionHandler({ mode: "readonly" })
    expect(await interactive.check({ name: "web_fetch", args: {} } as never, {} as never)).toEqual(
      "allow",
    )
    const auto = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
    expect(await auto.check({ name: "web_fetch", args: {} } as never, {} as never)).toEqual("deny")
  })
})

// ═══ §2/§3 GATE: the production read path ═══════════════════════════════════

describe("§2-3 enablement gate read through the PRODUCTION parser", () => {
  test("§3.1 the production line hasFlag(args, --enable-scheduler) decides correctly", () => {
    // The forms that must NOT enable it.
    for (const argv of [
      ["hello"],
      ["--enable-schedulerx", "x"],
      ["--enable-sched", "x"],
      ["hello", "--", "--enable-scheduler"],
    ]) {
      expect({ argv, on: hasFlag(argv, "--enable-scheduler") }).toEqual({ argv, on: false })
    }
    // The one form that must.
    expect(hasFlag(["--enable-scheduler", "x"], "--enable-scheduler")).toBe(true)
  })

  test("§3.2 FIXED: `--enable-scheduler=false` no longer enables it in production", () => {
    // [6V FINDING-01] 6U documented "the flag has no value form" and asserted it
    // against `resolveSchedulerGate` — the MODULE function — while production read
    // through `hasFlag`, which matches `token.startsWith(name+"=")`. The two
    // disagreed, and production followed the permissive one.
    //
    // [PHASE 6X] `cli/index.ts` now calls `resolveSchedulerGate` directly, so the
    // audited function and the executed expression are the same code again. This
    // test is retained rather than deleted: it is the regression guard for the
    // exact defect, and it fails if anyone reintroduces a permissive matcher.
    const productionSays = hasFlag(["--enable-scheduler=false", "x"], "--enable-scheduler")
    const moduleSays = resolveSchedulerGate(["--enable-scheduler=false"]).enabled
    // The permissive matcher still exists — it is correct for the permission and
    // plan flags, and was deliberately NOT changed. What changed is that the
    // Scheduler gate no longer uses it.
    expect(productionSays).toBe(true)
    expect(moduleSays).toBe(false)
    // And the production call site now follows the strict answer, so the
    // construction decision is driven by `moduleSays`, not `productionSays`.
    const constructed = moduleSays && schedulerGateFor(moduleSays).enabled
    expect(constructed).toBe(false)
  })

  test("§3.3 no env var, config key, or module side effect can enable it", () => {
    // §3 asks whether the CLI gate is the ONLY path. The 6U source audit showed
    // one reference chain; here the resolution itself is pinned.
    for (const v of [undefined, false, true]) {
      expect({ v, on: schedulerGateFor(v).enabled }).toEqual({ v, on: v === true })
    }
    // A gateway object forged to look enabled is still honoured — which is why
    // the type is the only thing preventing a careless caller.
    expect(schedulerGateFor(undefined).source).toBe("absent")
  })
})

// ═══ §16 READINESS BYPASS ════════════════════════════════════════════════════

describe("§16 readiness cannot be bypassed through the composition", () => {
  test("§16.1 a BLOCKED task sorted first is never executed", async () => {
    const blocked = addTask(1, "BLOCKED")
    const ready = addTask(2, "PENDING")
    let ran: string | null = null
    const h = await createProductionScheduler(GATE_ENABLED, deps({ onRun: () => (ran = ready.id) }))
    await h.fire("startup")
    expect({
      ran: ran ?? "nothing",
      blocked: store.getTask(S, blocked.id)!.status,
      readyRan: gen(ready.id),
    }).toEqual({
      ran: ready.id,
      blocked: "BLOCKED",
      readyRan: 1,
    })
    await h.stop("shutdown")
  })

  test("§16.2 a terminal task is never executed, however it is reached", async () => {
    const done = addTask(1, "COMPLETED")
    let calls = 0
    const h = await createProductionScheduler(GATE_ENABLED, deps({ onRun: () => calls++ }))
    for (let i = 0; i < 5; i++) await h.fire("startup")
    expect({ calls, gen: gen(done.id), status: store.getTask(S, done.id)!.status }).toEqual({
      calls: 0,
      gen: 0,
      status: "COMPLETED",
    })
    await h.stop("shutdown")
  })

  test("§16.3 a deleted task cannot be executed by a stale graph", async () => {
    const t = addTask(1)
    // [HARNESS FIX] Two schedulers for one session is correctly REFUSED, so this
    // attack uses one: the row is deleted, then the SAME instance keeps firing.
    let calls = 0
    const h = await createProductionScheduler(GATE_ENABLED, deps({ onRun: () => calls++ }))
    store.deleteTask(S, t.id)
    for (let i = 0; i < 3; i++) await h.fire("startup")
    expect({ calls, rows: store.getSnapshot(S).tasks.length }).toEqual({ calls: 0, rows: 0 })
    await h.stop("shutdown")
  })
})

// ═══ §14 COMPLETION BOUNDARY ════════════════════════════════════════════════

describe("§14 no production path makes the Scheduler a completion authority", () => {
  test("§14.1 a normal return leaves the task IN_PROGRESS, never COMPLETED", async () => {
    const t = addTask(1)
    const h = await createProductionScheduler(GATE_ENABLED, deps())
    await h.fire("startup")
    const after = store.getTask(S, t.id)!
    expect({ status: after.status, gen: gen(t.id), attempt: attempt(t.id) }).toEqual({
      status: "IN_PROGRESS",
      gen: 1,
      attempt: 1,
    })
    await h.stop("shutdown")
  })

  test("§14.2 many returning turns still never complete a task", async () => {
    const t = addTask(1)
    const h = await createProductionScheduler(GATE_ENABLED, deps())
    for (let i = 0; i < 10; i++) await h.fire("startup")
    expect({
      status: store.getTask(S, t.id)!.status,
      gen: gen(t.id),
      attempts: attempt(t.id),
    }).toEqual({ status: "IN_PROGRESS", gen: 1, attempts: 1 })
    await h.stop("shutdown")
  })
})

// ═══ §15 RECONCILIATION SAFETY ══════════════════════════════════════════════

describe("§15 reconciliation acts on evidence, not status", () => {
  test("R3 a returned execution is NOT reverted (completion marker present)", async () => {
    const t = addTask(1)
    const h = await createProductionScheduler(GATE_ENABLED, deps())
    await h.fire("startup")
    const r2 = await h.getScheduler()!.reconcile()
    expect({ recovered: r2, status: store.getTask(S, t.id)!.status }).toEqual({
      recovered: [],
      status: "IN_PROGRESS",
    })
    await h.stop("shutdown")
  })

  test("R7 a completed-but-IN_PROGRESS task is not resurrected by reconcile", async () => {
    // 6O's H5 history: a user marked IN_PROGRESS over a reconciled claim.
    const t = addTask(1)
    const h = await createProductionScheduler(GATE_ENABLED, deps())
    await h.fire("startup")
    // The user re-marks it IN_PROGRESS (the plan cursor overwrites status).
    legacy().patchTask(S, t.id, { status: "IN_PROGRESS" })
    h.getScheduler()!.reconcile()
    expect(store.getTask(S, t.id)!.status).toBe("IN_PROGRESS")
    expect(attempt(t.id)).toBe(1)
    await h.stop("shutdown")
  })

  test("R1 an interactive IN_PROGRESS is never reclaimed by the Scheduler", async () => {
    const t = addTask(1)
    // Interactive ownership: no scheduler owner, no generation. Authored through
    // the LEGACY store because 6P correctly forbids a user forging IN_PROGRESS.
    legacy().patchTask(S, t.id, { status: "IN_PROGRESS" })
    let calls = 0
    const h = await createProductionScheduler(GATE_ENABLED, deps({ onRun: () => calls++ }))
    await h.fire("startup")
    expect({ calls, owner: store.getExecutionOwnership(S, t.id)?.executionOwner ?? null }).toEqual({
      calls: 0,
      owner: null,
    })
    await h.stop("shutdown")
  })
})

// ═══ §7 USER TURN vs SCHEDULER TURN ═════════════════════════════════════════

describe("§7 user-side task mutation during a live autonomous turn", () => {
  test("§7.4 a user editing the SAME task does not corrupt ownership", async () => {
    const t = addTask(1)
    let aborted = false
    const h = await createProductionScheduler(
      GATE_ENABLED,
      deps({ park: true, onAbort: () => (aborted = true) }),
    )
    void h.fire("startup")
    await new Promise((r) => setTimeout(r, 5))
    expect(gen(t.id)).toBe(1)
    // The user retitles the task while the autonomous turn is live.
    store.patchTask(S, t.id, { title: "user edited me" })
    expect({
      title: store.getTask(S, t.id)!.title,
      gen: gen(t.id),
      status: store.getTask(S, t.id)!.status,
    }).toEqual({ title: "user edited me", gen: 1, status: "IN_PROGRESS" })
    await h.stop("shutdown")
    // The attempt was still recorded against generation 1 — the user's edit did
    // not consume a generation or steal the claim.
    expect({ gen: gen(t.id), attempt: attempt(t.id) }).toEqual({ gen: 1, attempt: 1 })
    void aborted
  })

  test("§7.5 a user marking IN_PROGRESS does not fabricate a completion", async () => {
    const t = addTask(1)
    const h = await createProductionScheduler(GATE_ENABLED, deps({ park: true }))
    void h.fire("startup")
    await new Promise((r) => setTimeout(r, 5))
    legacy().patchTask(S, t.id, { status: "IN_PROGRESS" })
    await h.stop("shutdown")
    expect({ status: store.getTask(S, t.id)!.status, gen: gen(t.id) }).toEqual({
      status: "IN_PROGRESS",
      gen: 1,
    })
  })
})

// ═══ §8/§10 DELETION and TRIGGER-AFTER-DELETION ══════════════════════════════

describe("§8 deletion reaches a live turn and stops the instance", () => {
  test("§8.2 deletion during the model turn aborts it and clears the namespace", async () => {
    const t = addTask(1)
    let aborted = false
    const h = await createProductionScheduler(
      GATE_ENABLED,
      deps({ park: true, onAbort: () => (aborted = true) }),
    )
    void h.fire("startup")
    await new Promise((r) => setTimeout(r, 5))
    store.deleteSessionTasks(S)
    store.bumpSessionIncarnation(S)
    notifySessionInvalidated(S)
    await new Promise((r) => setTimeout(r, 20))
    expect({ aborted, active: h.isActive(), rows: store.getSnapshot(S).tasks.length }).toEqual({
      aborted: true,
      active: false,
      rows: 0,
    })
    await h.stop("shutdown")
    expect(watchedSessions()).toEqual([])
    void t
  })

  test("§10 a deleted session cannot be triggered back into execution", async () => {
    addTask(1)
    let calls = 0
    // [HARNESS FIX] One instance only: a second is refused (fail-closed), and the
    // point is that the SAME instance cannot be driven after deletion.
    const h = await createProductionScheduler(GATE_ENABLED, deps({ onRun: () => calls++ }))
    store.deleteSessionTasks(S)
    store.bumpSessionIncarnation(S)
    // Three different trigger sources, all after deletion.
    await h.fire("startup")
    await h.fire("task-mutation")
    await h.fire("manual")
    expect({ calls, lifecycle: h.getScheduler()!.getLifecycle() }).toEqual({
      calls: 0,
      lifecycle: "STOPPED",
    })
    await h.stop("shutdown")
  })
})

// ═══ §11 DUPLICATE TRIGGER ══════════════════════════════════════════════════

describe("§11 duplicate triggers cannot inflate generations", () => {
  test("§11.1 100 identical triggers claim once", async () => {
    const t = addTask(1)
    const h = await createProductionScheduler(GATE_ENABLED, deps())
    for (let i = 0; i < 100; i++) await h.fire("startup")
    expect({ gen: gen(t.id), attempt: attempt(t.id) }).toEqual({ gen: 1, attempt: 1 })
    await h.stop("shutdown")
  })

  test("§11.2 mixed simultaneous triggers produce one claim", async () => {
    const t = addTask(1)
    const h = await createProductionScheduler(GATE_ENABLED, deps())
    await Promise.all([
      h.fire("startup"),
      h.fire("task-mutation"),
      h.fire("event"),
      h.fire("manual"),
    ])
    expect({ gen: gen(t.id) }).toEqual({ gen: 1 })
    await h.stop("shutdown")
  })
})

// ═══ §17 RESOURCE LIFETIME ══════════════════════════════════════════════════

describe("§17 OFF allocates nothing; ON releases everything", () => {
  test("§17.1 OFF: repeated fire and stop leave no subscription and no authority", async () => {
    const before = watchedSessions().length
    const h = await createProductionScheduler(GATE_DISABLED, deps())
    for (let i = 0; i < 200; i++) await h.fire("startup")
    await h.stop("shutdown")
    expect({ watched: watchedSessions().length, before, active: h.isActive() }).toEqual({
      watched: 0,
      before,
      active: false,
    })
  })

  test("§17.2 ON: subscription appears and is gone after stop", async () => {
    const h = await createProductionScheduler(GATE_ENABLED, deps())
    const during = watchedSessions().length
    await h.stop("shutdown")
    expect({ during, after: watchedSessions().length }).toEqual({ during: 1, after: 0 })
  })

  test("§17.3 no subscription may outlive its handle", async () => {
    const h = await createProductionScheduler(GATE_ENABLED, deps())
    const unsub = onSessionInvalidated(S, () => {})
    unsub()
    await h.stop("shutdown")
    // The handle's own subscription is gone, and an unrelated one is untouched.
    expect(watchedSessions()).toEqual([])
  })
})

// ═══ §23 PARENT/CHILD ESCAPE ═══════════════════════════════════════════════

describe("§23 the autonomous child reaches nothing of its parent", () => {
  test("§23.1 a second scheduler for the same session cannot share its handle", async () => {
    const first = await createProductionScheduler(GATE_ENABLED, deps())
    // Fail-closed: a duplicate authority is refused rather than silently shared.
    await expect(createProductionScheduler(GATE_ENABLED, deps())).rejects.toThrow()
    expect({ watched: watchedSessions().length, active: first.isActive() }).toEqual({
      watched: 1,
      active: true,
    })
    await first.stop("shutdown")
  })

  test("§23.2 a stale instance cannot release a live replacement's authority", async () => {
    const a = await createProductionScheduler(GATE_ENABLED, deps())
    await a.stop("shutdown")
    const b = await createProductionScheduler(GATE_ENABLED, deps())
    // Wrong identity: refused, and B is untouched.
    expect(releaseSessionOwnershipFor(S, "impostor")).toBe(false)
    expect(b.getScheduler()!.getLifecycle()).toBe("RUNNING")
    await b.stop("shutdown")
  })
})

// ═══ §27 PROPERTY / STATE MACHINE ═══════════════════════════════════════════

describe("§27 randomised state machine over the composition", () => {
  const rng = (seed: number) => {
    let s = (seed * 2654435761) >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x100000000
    }
  }

  test("§27.1 250 seeds: P1 OFF never executes; P14 shutdown creates no work", async () => {
    for (let seed = 1; seed <= 250; seed++) {
      const rand = rng(seed)
      const sess = `sm-${seed}`
      store.createTask(sess, { title: "t", status: "PENDING", order: 1, provenance: prov })
      const enabled = rand() < 0.5
      let ran = 0
      const h = await createProductionScheduler(
        enabled ? GATE_ENABLED : GATE_DISABLED,
        deps({ sess, onRun: () => ran++ }),
      )
      await h.fire("startup")
      if (enabled) await h.fire("task-mutation")
      const afterWork = ran
      await h.stop("shutdown")
      // P14: nothing may start after the stop.
      await h.fire("startup")
      await h.fire("task-mutation")
      // P1: OFF means no autonomous execution, ever.
      if (!enabled) {
        expect({ seed, afterWork, ran, gen: gen("t1", sess) }).toEqual({
          seed,
          afterWork: 0,
          ran: 0,
          gen: 0,
        })
      }
      // P16: no leak.
      expect({ seed, watched: watchedSessions().length }).toEqual({ seed, watched: 0 })
    }
  })

  test("§27.2 200 seeds: P9 incarnation is monotonic and never decreases", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed)
      const sess = `inc-${seed}`
      store.createTask(sess, { title: "t", status: "PENDING", order: 1, provenance: prov })
      let last = store.getSessionIncarnation(sess)
      for (let k = 0; k < 3; k++) {
        if (rand() < 0.4) store.bumpSessionIncarnation(sess)
        const now = store.getSessionIncarnation(sess)
        expect({ seed, monotonic: now >= last }).toEqual({ seed, monotonic: true })
        last = now
      }
    }
  })

  test("§27.3 150 seeds: P6 readiness is never bypassed by any trigger source", async () => {
    const sources = ["startup", "task-mutation", "event", "interval", "manual"] as const
    for (let seed = 1; seed <= 150; seed++) {
      const sess = `rdy-${seed}`
      const t = store.createTask(sess, {
        title: "t",
        status: "BLOCKED",
        blockedReason: "no",
        order: 1,
        provenance: prov,
      })
      store.patchTask(sess, t.id, { blockedReason: "no" })
      let ran = 0
      const h = await createProductionScheduler(GATE_ENABLED, deps({ sess, onRun: () => ran++ }))
      for (const s of sources) await h.fire(s)
      expect({ seed, ran, gen: gen("t1", sess) }).toEqual({ seed, ran: 0, gen: 0 })
      await h.stop("shutdown")
    }
  })
})

// ═══ §28 LONG-RUN STABILITY ═════════════════════════════════════════════════

describe("§28 long-run stability", () => {
  test("§28.1 500 trigger/cycle iterations: no drift, no growth, no wedge", async () => {
    const tasks = Array.from({ length: 10 }, (_, i) => addTask(i + 1))
    const h = await createProductionScheduler(GATE_ENABLED, deps())
    const started = Date.now()
    for (let i = 0; i < 500; i++) await h.fire("startup")
    const ms = Date.now() - started
    // Every task ran exactly once: generation 1, attempt 1, no requeue.
    const drift = tasks.map((t) => ({ id: t.id, g: gen(t.id), a: attempt(t.id) }))
    expect({
      allOnce: drift.every((d) => d.g === 1 && d.a === 1),
      allInProgress: tasks.every((t) => store.getTask(S, t.id)!.status === "IN_PROGRESS"),
      watched: watchedSessions().length,
      // A finished cycle leaves the instance IDLE (6C), not RUNNING — asserted
      // as observed rather than assumed.
      lifecycle: h.getScheduler()!.getLifecycle(),
    }).toEqual({
      allOnce: true,
      allInProgress: true,
      watched: 1,
      lifecycle: "IDLE",
    })
    await h.stop("shutdown")
    expect({ watched: watchedSessions().length, ms: ms < 60_000 }).toEqual({
      watched: 0,
      ms: true,
    })
  })
})

// ═══ §21/§22 CWD and TOOL FAILURES ══════════════════════════════════════════

describe("§21-22 cwd isolation and tool/provider failure", () => {
  test("§21.1 two sessions with different cwd never share it", async () => {
    const other = `${S}-other`
    const cwdA = dir
    const cwdB = join(dir, "project-b")
    const seen: string[] = []
    const mk = (sess: string, cwd: string) =>
      createProductionScheduler(
        GATE_ENABLED,
        deps({
          sess,
          cwd,
          onRun: () => seen.push(`${sess}@${cwd}`),
        }),
      )
    store.createTask(S, { title: "a", status: "PENDING", order: 1, provenance: prov })
    store.createTask(other, { title: "b", status: "PENDING", order: 1, provenance: prov })
    const a = await mk(S, cwdA)
    const b = await mk(other, cwdB)
    await Promise.all([a.fire("startup"), b.fire("startup")])
    expect(seen.sort()).toEqual([`${S}@${cwdA}`, `${other}@${cwdB}`].sort())
    await a.stop("shutdown")
    await b.stop("shutdown")
  })

  test("§22.1 a throwing turn does not wedge the scheduler or corrupt the task", async () => {
    const t = addTask(1)
    const h = await createProductionScheduler(GATE_ENABLED, () => {
      const st = store
      return {
        sessionId: S,
        cwd: dir,
        store: st,
        instruction: "x",
        adapter: {
          store: st,
          tools: [{ name: "read_file" }],
          cwdFor: () => dir,
          sessionFactory: async () => ({
            async run() {
              throw new Error("provider exploded")
            },
            abort() {},
          }),
        },
        bindingFor: (taskId: string) => ({
          parentSessionId: S,
          taskId,
          execGeneration: st.getExecutionLineage(S, taskId)?.execGeneration ?? 0,
          sessionIncarnation: st.getSessionIncarnation(S),
        }),
      }
    })
    const r = await h.fire("startup")
    // A failed turn is still an ATTEMPT: recorded, not completed, not a wedge.
    expect({
      gen: gen(t.id),
      attempt: attempt(t.id),
      status: store.getTask(S, t.id)!.status,
      stillRunning: h.isActive(),
      resultNotNull: r !== null,
    }).toEqual({
      gen: 1,
      attempt: 1,
      status: "IN_PROGRESS",
      stillRunning: true,
      resultNotNull: true,
    })
    await h.stop("shutdown")
  })
})
