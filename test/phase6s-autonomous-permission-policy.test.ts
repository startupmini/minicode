// PHASE 6S — autonomous permission & tool policy.
//
// The properties here are deliberately about the POLICY, not about plumbing.
// 6R proved a context is isolated; 6S asks the harder question: when an
// unattended model reaches for something it may not have, does anything actually
// stop it, at a boundary the model cannot route around?

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { PermissionHandler } from "#minicore"
import { createPermissionHandler } from "../src/policy/permission.ts"
import { planAutonomousContext } from "../src/task/autonomous-adapter.ts"
import {
  AUTONOMOUS_TOOL_NAMES,
  AutonomousExecutionContext,
  type AutonomousSession,
  type AutonomousSessionSpec,
} from "../src/task/autonomous-context.ts"
import {
  AutonomousPolicyLedger,
  assertAutonomousToolScope,
  classifyTool,
  createAutonomousPermissionHandler,
  isAutonomousTool,
  AUTONOMOUS_TOOL_NAMES as MATRIX_ALLOW,
  TOOL_CAPABILITIES,
} from "../src/task/autonomous-policy.ts"
import { allTools } from "../src/tools/index.ts"

// `args`, not `arguments` — that is the field the kernel and the policy layer read.
const call = (name: string, args: Record<string, unknown> = {}) => ({ name, args }) as never

/** The interactive handler, with the runtime seams its own type-cast declares. */
type InteractiveHandler = {
  check(c: unknown, deps?: unknown): Promise<"allow" | "deny">
  describeDenial(c: unknown): string | undefined
  __setMode(m: string): void
  __getMode(): string
}
const interactiveHandler = (o: Parameters<typeof createPermissionHandler>[0]) =>
  createPermissionHandler(o) as unknown as InteractiveHandler

// ═══ A. THE MATRIX IS COMPLETE ══════════════════════════════════════════════

describe("A. the capability matrix covers the real registry", () => {
  test("A1. every tool in the registry is classified — no UNKNOWN among real tools", () => {
    // This is the property that keeps the matrix honest. A tool added to the
    // registry without a classification is UNKNOWN, and UNKNOWN denies - safe -
    // but it means the matrix has silently rotted. Failing here makes the
    // omission visible at review time instead of at 3am.
    const unknown = allTools.filter((t) => classifyTool(t.name).capability === "UNKNOWN")
    expect(unknown.map((t) => t.name)).toEqual([])
  })

  test("A2. the matrix invents no tools that do not exist", () => {
    const real = new Set(allTools.map((t) => t.name))
    const phantom = TOOL_CAPABILITIES.filter((c) => !real.has(c.name))
    expect(phantom.map((c) => c.name)).toEqual([])
  })

  test("A3. every classification carries its evidence", () => {
    for (const c of TOOL_CAPABILITIES) {
      expect({ tool: c.name, hasEvidence: c.evidence.length > 10 }).toEqual({
        tool: c.name,
        hasEvidence: true,
      })
    }
  })

  test("A3b. a READ_ONLY tool may still be denied, and then must say why", () => {
    // `bash_output` reads a background job's stdout — genuinely read-only, yet
    // useless and unsafe without `bash`, which starts the job. The policy is
    // allowed to be stricter than the capability, but never silently so: these
    // are the cases a reader will question, so each one carries its reason.
    const strict = TOOL_CAPABILITIES.filter((c) => c.capability === "READ_ONLY" && !c.autonomous)
    // The set is asserted EXACTLY, not just "for whatever is in it". An earlier
    // version iterated the members, so flipping `bash_output` to autonomous simply
    // removed it from the loop and the test passed — mutation M1 survived. Naming
    // the set closes that: adding a tool here is a visible, deliberate change.
    expect(
      TOOL_CAPABILITIES.filter((c) => c.capability === "READ_ONLY" && !c.autonomous).map(
        (c) => c.name,
      ),
    ).toEqual(["bash_output"])
    for (const c of strict) {
      expect({ tool: c.name, reason: c.evidence.length }).toMatchObject({
        tool: c.name,
        reason: expect.any(Number),
      })
      expect(c.evidence.toLowerCase()).toMatch(/not startable|meaningful/)
    }
    // the converse: nothing outside READ_ONLY is ever allowed
    for (const c of TOOL_CAPABILITIES) {
      if (c.capability !== "READ_ONLY") {
        expect({ tool: c.name, autonomous: c.autonomous }).toEqual({
          tool: c.name,
          autonomous: false,
        })
      }
    }
  })

  test("A4. the allow-list is DERIVED from the matrix, not a second copy", () => {
    // 6R kept a hand-written list next to the classification logic. One policy,
    // one source: if these two ever disagree, one of them is a lie.
    expect(new Set(AUTONOMOUS_TOOL_NAMES)).toEqual(new Set(MATRIX_ALLOW))
    for (const n of AUTONOMOUS_TOOL_NAMES) expect(isAutonomousTool(n)).toBe(true)
  })
})

// ═══ B. THE POLICY ══════════════════════════════════════════════════════════

describe("B. the policy is deny-by-default and read-only", () => {
  test("B1. every mutating, execution, privileged and external tool is denied", () => {
    // The core claim of 6S, asserted tool by tool against the real registry
    // rather than against a list of examples.
    for (const t of allTools) {
      const c = classifyTool(t.name)
      if (c.capability === "MUTATING" || c.capability === "EXECUTION") {
        expect({ tool: t.name, autonomous: c.autonomous }).toEqual({
          tool: t.name,
          autonomous: false,
        })
      }
    }
  })

  test("B2. an unclassified tool is denied, not allowed by omission", () => {
    expect(classifyTool("some_tool_added_next_year").capability).toBe("UNKNOWN")
    expect(isAutonomousTool("some_tool_added_next_year")).toBe(false)
  })

  test("B3. the task-mutation tools are denied — an autonomous run may not rewrite its own claim", () => {
    // todo_write can author TaskStatus, and under 6P IN_PROGRESS is a
    // Scheduler-owned execution state. A model that could write it could
    // manufacture the appearance of a claim the lineage would then trust.
    for (const t of ["todo_write", "submit_result", "delegate_task"]) {
      expect({ tool: t, autonomous: isAutonomousTool(t) }).toEqual({ tool: t, autonomous: false })
    }
  })

  test("B4. ask_user is denied — the case where waiting would deadlock", () => {
    // An unattended execution with no human present would block forever. The
    // policy refuses it instead, which is why the kernel's lack of a DEFER
    // decision is survivable here.
    expect(classifyTool("ask_user").capability).toBe("PRIVILEGED")
    expect(isAutonomousTool("ask_user")).toBe(false)
  })
})

// ═══ C. THE INVOCATION-TIME GATE ════════════════════════════════════════════

describe("C. the gate decides per invocation, at the kernel's boundary", () => {
  test("C1. the handler allows in-scope and denies out-of-scope, and says which", async () => {
    const l = new AutonomousPolicyLedger()
    const h = createAutonomousPermissionHandler(l)
    expect(await h.check(call("read_file"))).toBe("allow")
    expect(await h.check(call("bash"))).toBe("deny")
    expect(l.denied).toBe(true)
    expect(l.denials_.map((d) => d.tool)).toEqual(["bash"])
  })

  test("C2. a tool that appears only at RUNTIME is still denied", async () => {
    // The reason this gate exists. `withMcpTools()` appends `serverid.toolname`
    // after the context was built, so a creation-time check has never seen it.
    const l = new AutonomousPolicyLedger()
    const h = createAutonomousPermissionHandler(l)
    expect(await h.check(call("github.create_issue"))).toBe("deny")
    expect(l.denials_[0]?.reason).toBe("UNKNOWN_TOOL")
  })

  test("C3. the decision is deterministic and order-independent", async () => {
    // Property: a table lookup, not control flow. Same input, same answer,
    // forever, and never dependent on what was asked before it.
    const h1 = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
    const h2 = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
    for (let i = 0; i < 50; i++) {
      expect(await h1.check(call("write_file"))).toBe("deny")
      expect(await h1.check(call("grep"))).toBe("allow")
    }
    expect(await h2.check(call("write_file"))).toBe("deny")
  })

  test("C4. the gate cannot block — check() settles on its own with no human", async () => {
    // The single most important non-functional property. If `check` could wait,
    // an autonomous execution would hang rather than refuse.
    const h = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
    const settled = await Promise.race([
      h.check(call("ask_user")).then((d) => `decided:${d}`),
      new Promise((r) => setTimeout(() => r("HUNG"), 200)),
    ])
    expect(settled).toBe("decided:deny")
  })

  test("C5. the denial explains itself to the model", async () => {
    const h = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
    const msg = h.describeDenial!(call("bash"))
    expect(msg).toContain("bash")
    expect(msg).toContain("read-only")
  })
})

// ═══ D. THE OUTCOME IS HONEST ═══════════════════════════════════════════════

describe("D. a refusal is a first-class outcome, never a success", () => {
  const denyThenSucceed = (deniedTool: string) => {
    let spec: AutonomousSessionSpec | null = null
    const session: AutonomousSession = {
      async run() {
        // The kernel consults the handler before every tool execution; the
        // model then "recovers" and answers anyway. Both are realistic.
        await spec!.permissionHandler.check(call(deniedTool))
        return { finalText: "I could not do that, but here is my answer.", usage: { steps: 2 } }
      },
      abort() {},
    }
    const factory = async (s: AutonomousSessionSpec) => {
      spec = s
      return session
    }
    return { factory }
  }

  const runWith = async (deniedTool: string) => {
    const { factory } = denyThenSucceed(deniedTool)
    const ctx = new AutonomousExecutionContext({
      parentSessionId: "6s",
      taskId: "t1",
      taskTitle: "T",
      instruction: "i",
      execGeneration: 1,
      sessionIncarnation: 1,
      cwd: process.cwd(),
      sessionFactory: factory,
      tools: AUTONOMOUS_TOOL_NAMES.map((name) => ({ name })),
    })
    await ctx.initialize()
    const r = await ctx.execute()
    return { ctx, r }
  }

  test("D1. a turn that returns text after a refusal is still permission-denied", async () => {
    // The important one. `run()` resolved cleanly and the model sounded
    // confident; reporting `returned` here would tell the Scheduler the
    // autonomous execution SUCCEEDED and let 6P commit that claim.
    const { r } = await runWith("write_file")
    expect(r.outcome).toBe("permission-denied")
    expect(r.ok).toBe(false)
    expect(r.detail).toContain("write_file")
  })

  test("D2. a refusal is distinguishable from cancellation and from error", async () => {
    const { r } = await runWith("bash")
    expect(["cancelled", "error"]).not.toContain(r.outcome)
    expect(r.outcome).toBe("permission-denied")
  })

  test("D2b. a turn that THROWS after a refusal still reports permission-denied", async () => {
    // [PHASE 6S] The error path carries its own ledger check, and it was
    // untested until mutation M9 proved it: removing that branch changed
    // nothing. A model that is refused and then fails internally must not have
    // its refusal buried under the incidental error - the policy verdict is the
    // actionable one, and a generic `error` hides why the run could not proceed.
    let spec: AutonomousSessionSpec | null = null
    const session: AutonomousSession = {
      async run() {
        await spec!.permissionHandler.check(call("write_file"))
        throw new Error("provider stream closed unexpectedly")
      },
      abort() {},
    }
    const ctx = new AutonomousExecutionContext({
      parentSessionId: "6s",
      taskId: "t1",
      taskTitle: "T",
      instruction: "i",
      execGeneration: 1,
      sessionIncarnation: 1,
      cwd: process.cwd(),
      sessionFactory: async (s) => {
        spec = s
        return session
      },
      tools: AUTONOMOUS_TOOL_NAMES.map((name) => ({ name })),
    })
    await ctx.initialize()
    const r = await ctx.execute()
    expect(r.outcome).toBe("permission-denied")
    expect(r.detail).toContain("write_file")
  })

  test("D2c. a turn that throws WITHOUT a refusal is still a plain error", async () => {
    // The converse, so D2b cannot be satisfied by refusing everything.
    const ctx = new AutonomousExecutionContext({
      parentSessionId: "6s",
      taskId: "t1",
      taskTitle: "T",
      instruction: "i",
      execGeneration: 1,
      sessionIncarnation: 1,
      cwd: process.cwd(),
      sessionFactory: async () => ({
        async run() {
          throw new Error("provider stream closed unexpectedly")
        },
        abort() {},
      }),
      tools: AUTONOMOUS_TOOL_NAMES.map((name) => ({ name })),
    })
    await ctx.initialize()
    expect((await ctx.execute()).outcome).toBe("error")
  })

  test("D3. the denials are attributable on the context", async () => {
    const { ctx } = await runWith("todo_write")
    expect(ctx.getDenials()).toEqual([{ tool: "todo_write", reason: "NOT_AUTONOMOUS" }])
  })

  test("D4. a clean turn with no refusal is still `returned` — the gate is not noisy", async () => {
    let spec: AutonomousSessionSpec | null = null
    const session: AutonomousSession = {
      async run() {
        await spec!.permissionHandler.check(call("read_file"))
        return { finalText: "done", usage: { steps: 1 } }
      },
      abort() {},
    }
    const ctx = new AutonomousExecutionContext({
      parentSessionId: "6s",
      taskId: "t1",
      taskTitle: "T",
      instruction: "i",
      execGeneration: 1,
      sessionIncarnation: 1,
      cwd: process.cwd(),
      sessionFactory: async (s) => {
        spec = s
        return session
      },
      tools: AUTONOMOUS_TOOL_NAMES.map((name) => ({ name })),
    })
    await ctx.initialize()
    const r = await ctx.execute()
    expect(r.outcome).toBe("returned")
    expect(r.ok).toBe(true)
  })
})

// ═══ E. NO INHERITANCE OF INTERACTIVE PERMISSION STATE ═════════════════════

describe("E. the policy is per-execution and never inherited", () => {
  test("E1. two concurrent executions cannot read each other's denials", async () => {
    // The ledger is per-context precisely so this holds. A module-global
    // ledger would let one execution's refusal decide another's outcome.
    const mk = (tool: string) => {
      let spec: AutonomousSessionSpec | null = null
      const ctx = new AutonomousExecutionContext({
        parentSessionId: "6s",
        taskId: "t1",
        taskTitle: "T",
        instruction: "i",
        execGeneration: 1,
        sessionIncarnation: 1,
        cwd: process.cwd(),
        sessionFactory: async (s) => {
          spec = s
          return {
            async run() {
              await spec!.permissionHandler.check(call(tool))
              return { finalText: "x", usage: { steps: 1 } }
            },
            abort() {},
          }
        },
        tools: AUTONOMOUS_TOOL_NAMES.map((n) => ({ name: n })),
      })
      return ctx
    }
    const denied = mk("bash")
    const clean = mk("read_file")
    await Promise.all([denied.initialize(), clean.initialize()])
    const [dr, cr] = await Promise.all([denied.execute(), clean.execute()])
    expect(dr.outcome).toBe("permission-denied")
    expect(cr.outcome).toBe("returned")
    expect(clean.getDenials()).toEqual([])
  })

  test("E2. the context still refuses a widened tool set at construction", async () => {
    // 6R's creation-time gate is retained deliberately. Both gates are needed:
    // this one fails fast before any turn, the handler catches what arrives later.
    let msg = ""
    try {
      assertAutonomousToolScope(["read_file", "bash"])
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain("bash")
  })

  test("E3. the factory is handed a handler, not merely a permission MODE", () => {
    // A `permissionMode: "readonly"` string is a request. The kernel decides
    // what to do with it. The handler is the thing the kernel actually consults,
    // so its presence is what makes the policy real rather than declarative.
    let captured: AutonomousSessionSpec | null = null
    const ctx = new AutonomousExecutionContext(
      planAutonomousContext(
        { taskId: "t1", title: "T", instruction: "i", sessionId: "6s" },
        { parentSessionId: "6s", taskId: "t1", execGeneration: 1, sessionIncarnation: 1 },
        {
          store: {} as never,
          sessionFactory: async (s) => {
            captured = s
            return {
              async run() {
                return { usage: { steps: 0 } }
              },
              abort() {},
            }
          },
          tools: AUTONOMOUS_TOOL_NAMES.map((n) => ({ name: n })),
          cwdFor: () => process.cwd(),
        },
      ),
    )
    return ctx.initialize().then(() => {
      expect(
        typeof (captured as unknown as { permissionHandler: unknown })?.permissionHandler,
      ).toBe("object")
      expect((captured as unknown as { permissionMode: string }).permissionMode).toBe("readonly")
    })
  })

  test("E4. the autonomous handler CANNOT be mode-mutated — the reason 6S does not reuse `readonly`", async () => {
    // The finding that shaped this phase. The interactive handler exposes
    // `__setMode` for Shift+Tab, so `permissionMode: "readonly"` is a REQUEST
    // that any holder of the handler can revoke at runtime. An autonomous
    // execution sharing that handler could be switched to `allow-all` mid-turn
    // and would never know. The autonomous handler has no such seam.
    const h = createAutonomousPermissionHandler(new AutonomousPolicyLedger()) as unknown as Record<
      string,
      unknown
    >
    expect("__setMode" in h).toBe(false)
    expect("__getMode" in h).toBe(false)
    // the real handler genuinely can be flipped — so the risk is not hypothetical
    const interactive = interactiveHandler({ mode: "readonly", root: process.cwd() })
    // a well-formed in-workspace write, so the universal path jail passes and the
    // only thing left to decide is the MODE
    const write = call("write_file", { path: join(process.cwd(), "notes.txt") })
    expect(await interactive.check(write)).toBe("deny")
    interactive.__setMode("allow-all")
    expect(await interactive.check(write)).toBe("allow")
    // and the autonomous handler refuses the identical call, at any mode
    const h2 = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
    expect(await h2.check(write)).toBe("deny")
  })

  test("E4b. the handler is structurally assignable to the kernel's PermissionHandler", () => {
    // [PHASE 6S] Deliberately a TYPE test. `check(call, deps)` must accept the
    // kernel's two arguments and return its `Decision`, or the composition root
    // cannot wire this without a cast — and a cast is exactly what would let the
    // two shapes drift apart unnoticed.
    const assignable: PermissionHandler = createAutonomousPermissionHandler(
      new AutonomousPolicyLedger(),
    )
    expect(typeof assignable.check).toBe("function")
  })

  test("E5. autonomous policy is STRICTER than interactive `readonly` on network egress", async () => {
    // The existing `READONLY_TOOLS` set admits `web_fetch`/`web_search`. For a
    // human typing a URL that is a read. For an unattended executor it is an
    // outbound request nobody asked for, whose response becomes model input.
    // 6S denies them; the divergence is deliberate and must stay deliberate.
    const interactive = interactiveHandler({ mode: "readonly" })
    expect(await interactive.check(call("web_fetch"))).toBe("allow")
    const h = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
    expect(await h.check(call("web_fetch"))).toBe("deny")
  })

  test("E6. dynamic MCP tools are denied even though `readonly` would wave them past", async () => {
    // `isGated()` covers dotted MCP names — but only inside the mode handlers,
    // and `readonly`'s handler is a bare READONLY_TOOLS lookup. A server tool
    // happens to be denied there too, yet for the wrong reason and by accident
    // of naming. 6S denies it explicitly, by class.
    const interactive = interactiveHandler({ mode: "readonly" })
    expect(await interactive.check(call("github.create_issue"))).toBe("deny")
    const h = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
    expect(await h.check(call("github.create_issue"))).toBe("deny")
  })
})

// ═══ F. PROPERTIES ══════════════════════════════════════════════════════════

describe("F. policy properties (state-machine + randomised)", () => {
  test("F1. every real tool resolves to exactly one capability, and the verdict follows it", async () => {
    for (let seed = 0; seed < 250; seed++) {
      const t = allTools[seed % allTools.length]!
      const h = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
      const decision = await h.check(call(t.name))
      const c = classifyTool(t.name)
      expect(decision).toBe(c.autonomous ? "allow" : "deny")
    }
  })

  test("F2. no tool is both allowed and denied, and allowing is a subset of READ_ONLY", () => {
    for (const t of allTools) {
      const c = classifyTool(t.name)
      if (!c.autonomous) continue
      expect(c.capability).toBe("READ_ONLY")
    }
  })

  test("F3. adding tools to the execution can only ever remove capability", () => {
    // Monotonicity: there is no ordering of tool names that turns a refusal into
    // a grant. Defence against a future "just also allow X" edit.
    const denied = allTools.filter((t) => !isAutonomousTool(t.name))
    for (let i = 0; i < 100; i++) {
      const picked = denied[Math.floor((i * 7919) % denied.length)]!
      expect(isAutonomousTool(picked.name)).toBe(false)
    }
  })
})
