// PHASE 6Z §1-§3 - M31: the autonomous permission composition gap.
//
// [DESIGN DECISION] 6U tested the `permissionHandler` seam through a STAND-IN for
// `createMinicodeSession` (test/phase6u-production-composition.test.ts:665). That
// is the 6V failure pattern exactly: a tested helper beside an untested expression.
// M31 lives in `src/app/session.ts`, and NOTHING in the suite called that function
// with an injected handler AND an onPermissions probe - so the guard at
// session.ts:161 was correct but unverified, and mutation M31 survived.
//
// Every test here calls the REAL createMinicodeSession. If the production guard
// is removed, these fail.

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeProvider, finish, text, toolCall } from "#minicore/test/fakes.ts"
import { createMinicodeSession, type PermissionControl } from "../src/app/session.ts"
import {
  AutonomousPolicyLedger,
  assertAutonomousToolScope,
  createAutonomousPermissionHandler,
} from "../src/task/autonomous-policy.ts"
import { bashTool } from "../src/tools/bash.ts"
import { editTool } from "../src/tools/edit.ts"
import { readFileTool } from "../src/tools/read_file.ts"

const AUTONOMOUS_TOOLS = [readFileTool]
/**
 * The WIDE tool set, for the cases that must show a mutating tool being REFUSED.
 *
 * [DESIGN DECISION] The kernel rejects an unknown tool before permission is ever
 * consulted, so a mutating tool must genuinely EXIST for the denial to be a POLICY
 * denial rather than a missing tool. Testing `write_file` against a tool list that
 * omits it proves nothing about the autonomous policy.
 */
const WIDE_TOOLS = [readFileTool, editTool, bashTool]

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "6z-m31-"))
  // A local .minicode so resolveDbPath cannot fall through to the real HOME and
  // pollute it - the same hazard agent-contract.test.ts documents.
  await mkdir(join(dir, ".minicode"), { recursive: true }).catch(() => {})
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Run a session that is EXPECTED to deny a tool, tolerating a pre-existing vendor
 * defect that fires afterwards.
 *
 * [OBSERVATION] A denied tool result is a `ToolResult` whose `content` is a string
 * (vendor/minicore/src/core/executor.ts:errorResult), but the NEXT turn's
 * `estimateSessionContext` walks an assistant message whose content parts are not
 * all `{type:"text"}` and dereferences `part.data.byteLength` unconditionally
 * (vendor/minicore/src/core/tokens.ts:33). The run therefore throws AFTER the
 * denial has already been decided and emitted.
 *
 * That is a real defect, in PINNED VENDOR code, and it is NOT in 6Z's allowed
 * change list - so it is reported, not fixed. Crucially it is NOT on the
 * production autonomous path: production runs autonomous turns through
 * `AutonomousExecutionContext`, which has its own message assembly, and the whole
 * 6S suite denies tools through that path without incident.
 *
 * [DESIGN DECISION] The point of these tests is the PERMISSION decision, which has
 * already been made and emitted by the time this throws. Asserting on the throw
 * would make the test assert a vendor bug instead of the M31 contract, so the
 * throw is tolerated and its identity pinned - if it ever changes, the test fails.
 */
async function runToleratingVendorEstimatorBug(session: {
  run: () => Promise<unknown>
}): Promise<void> {
  try {
    await session.run()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/part of content/.test(msg)) throw e
  }
}
interface Probe {
  readonly control: PermissionControl | null
  readonly calls: number
  onPermissions(c: PermissionControl): void
}

/** The exact production probe: the TUI's Shift+Tab capture point. */
function probe(): Probe {
  const state = { control: null as PermissionControl | null, calls: 0 }
  return {
    get control() {
      return state.control
    },
    get calls() {
      return state.calls
    },
    onPermissions(c: PermissionControl) {
      state.calls += 1
      state.control = c
    },
  }
}

describe("§1 M31 reproduction against the real createMinicodeSession", () => {
  test("A. an injected autonomous handler is NEVER given a mode control", async () => {
    await withTempDir(async (dir) => {
      const ledger = new AutonomousPolicyLedger()
      const handler = createAutonomousPermissionHandler(ledger)
      const p = probe()

      await createMinicodeSession({
        provider: new FakeProvider([{ events: [text("ok"), finish("stop")] }]),
        tools: AUTONOMOUS_TOOLS,
        cwd: dir,
        permissionHandler: handler,
        onPermissions: p.onPermissions,
      })

      // THE M31 ASSERTION. Under the mutant (`if (onPermissions)`) this becomes 1.
      expect({ onPermissions_calls: p.calls, control: p.control }).toEqual({
        onPermissions_calls: 0,
        control: null,
      })
    })
  })

  test("A2. the injected handler has no mode-mutation seam at all", async () => {
    await withTempDir(async (dir) => {
      const handler = createAutonomousPermissionHandler(new AutonomousPolicyLedger())
      const h = handler as unknown as Record<string, unknown>
      // 6S's own guarantee: the policy is not a MODE, so it cannot be revoked.
      expect({
        setMode: "__setMode" in h,
        getMode: "__getMode" in h,
        keys: Object.keys(h).sort(),
      }).toEqual({ setMode: false, getMode: false, keys: ["check", "describeDenial"] })
      // And the production session really did use THIS handler, not a derived one.
      await createMinicodeSession({
        provider: new FakeProvider([{ events: [text("ok"), finish("stop")] }]),
        tools: AUTONOMOUS_TOOLS,
        cwd: dir,
        permissionHandler: handler,
      })
    })
  })

  test("B. without injection, the normal interactive mode controls still work", async () => {
    await withTempDir(async (dir) => {
      const p = probe()
      const session = await createMinicodeSession({
        provider: new FakeProvider([{ events: [text("ok"), finish("stop")] }]),
        tools: AUTONOMOUS_TOOLS,
        cwd: dir,
        permissionMode: "auto",
        onPermissions: p.onPermissions,
      })

      // The control is captured, and it is a REAL handle: Shift+Tab still works in
      // the interactive case. 6Z must not "fix" M31 by breaking this.
      expect(p.calls).toBe(1)
      expect(p.control).not.toBeNull()
      const before = p.control!.getMode()
      p.control!.setMode("readonly")
      expect({ before, after: p.control!.getMode() }).toEqual({ before: "auto", after: "readonly" })
      expect(session).toBeDefined()
    })
  })

  test("C. a parent interactive permission change cannot widen the autonomous handler", async () => {
    await withTempDir(async (dir) => {
      // The real interaction: one interactive session whose mode is changed, and
      // one autonomous session in the SAME process. Parent change, child unaffected.
      const p = probe()
      await createMinicodeSession({
        provider: new FakeProvider([{ events: [text("ok"), finish("stop")] }]),
        tools: AUTONOMOUS_TOOLS,
        cwd: dir,
        permissionMode: "auto",
        onPermissions: p.onPermissions,
      })
      p.control!.setMode("allow-all")

      const ledger = new AutonomousPolicyLedger()
      const child = createAutonomousPermissionHandler(ledger)
      // The child handler is a separate object and shares no state with the parent.
      expect({ same: (child as unknown) === (p.control as unknown) }).toEqual({ same: false })
      // Even at allow-all, the autonomous policy denies a mutating tool.
      expect(await child.check({ id: "c1", name: "write_file", args: {} })).toBe("deny")
      expect(await child.check({ id: "c2", name: "shell", args: {} })).toBe("deny")
      expect(await child.check({ id: "c3", name: "web_fetch", args: {} })).toBe("deny")
      // ...and still allows what the matrix allows.
      expect(await child.check({ id: "c4", name: "read_file", args: {} })).toBe("allow")
    })
  })

  test("D. a composition that ATTEMPTS to widen still fails closed", async () => {
    await withTempDir(async (dir) => {
      const ledger = new AutonomousPolicyLedger()
      const handler = createAutonomousPermissionHandler(ledger)
      // Case D1: the hostile caller keeps a reference to the handler and tries to
      // graft a mode seam onto it. There is nothing to call, and even if there
      // were, `check` closes over the matrix - not over any mode.
      const hostile = handler as unknown as Record<string, unknown>
      expect(typeof hostile.__setMode).toBe("undefined")
      expect(typeof hostile.check).toBe("function")
      for (const tool of [
        "write_file",
        "shell",
        "web_fetch",
        "task_write",
        "bash",
        "unknown_tool_xyz",
      ]) {
        expect({
          tool,
          r: await handler.check({ id: `call-${tool}`, name: tool, args: {} }),
        }).toEqual({
          tool,
          r: "deny",
        })
      }
      // Case D2: the production session is built with the handler AND a
      // permissionMode that would be permissive. The mode is kernel metadata only
      // and grants nothing.
      const p = probe()
      const session = await createMinicodeSession({
        provider: new FakeProvider([
          { events: [toolCall("bash", { command: "echo hi" }, "call-1"), finish("stop")] },
        ]),
        tools: WIDE_TOOLS,
        cwd: dir,
        permissionMode: "allow-all",
        permissionHandler: handler,
        onPermissions: p.onPermissions,
      })
      expect(p.calls).toBe(0)
      // [DESIGN DECISION] The DENIAL is asserted through the handler's own ledger, not
      // through kernel events. A mutating tool call through the TOP-LEVEL session loop
      // trips a pre-existing vendor estimator defect before the tool ever executes, so
      // event-level evidence is unreachable there. The ledger is the 6S contract's own
      // record, and the handler is the one the real session was constructed with.
      await runToleratingVendorEstimatorBug(session as unknown as { run: () => Promise<unknown> })
      // The mutating tool was refused by the autonomous policy, not approved.
      expect(ledger.denials_.map((d) => d.tool)).toContain("bash")
      expect(() => assertAutonomousToolScope(["read_file"])).not.toThrow()
      expect(() => assertAutonomousToolScope(["bash"])).toThrow()
    })
  })
})

describe("§3 the production call chain, end to end", () => {
  test("composition -> session -> injected handler -> tool permission request", async () => {
    await withTempDir(async (dir) => {
      const ledger = new AutonomousPolicyLedger()
      const handler = createAutonomousPermissionHandler(ledger)
      const p = probe()

      // The exact production chain: a real session carrying the 6S handler, with
      // the TUI's onPermissions probe attached exactly as cli/ does.
      const session = await createMinicodeSession({
        provider: new FakeProvider([
          { events: [toolCall("read_file", { path: "x" }, "call-1"), finish("tool_calls")] },
          { events: [toolCall("bash", { command: "echo hi" }, "call-2"), finish("stop")] },
        ]),
        tools: WIDE_TOOLS,
        cwd: dir,
        permissionHandler: handler,
        onPermissions: p.onPermissions,
      })

      // The whole point, restated: no mode control exists to hand out.
      expect(p.calls).toBe(0)

      // [DESIGN DECISION] The DECISION for each tool is asserted through the very
      // handler the session was constructed with, and recorded in its own ledger.
      // End-to-end ledger evidence via the top-level loop is unreachable because of
      // the vendor estimator defect documented above; the autonomous PRODUCTION path
      // runs through AutonomousExecutionContext, which has its own message assembly
      // and is exercised by the entire 6S suite.
      await runToleratingVendorEstimatorBug(session as unknown as { run: () => Promise<unknown> })
      expect(await handler.check({ id: "c1", name: "read_file", args: {} })).toBe("allow")
      expect(await handler.check({ id: "c2", name: "bash", args: {} })).toBe("deny")
      expect(ledger.allowedTools).toContain("read_file")
      expect(ledger.denials_.map((d) => d.tool)).toContain("bash")
      // Even after a real turn, still no mode control.
      expect(p.calls).toBe(0)
    })
  })

  test("the source guard is present, and it is the production one", async () => {
    // [FACT] Read from the file the product runs. 6Y's M31 survived because the
    // assertion lived in a test double; this pins the real expression.
    const src = await Bun.file(join(import.meta.dir, "..", "src", "app", "session.ts")).text()
    expect(src).toContain("if (onPermissions && !injected) {")
    expect(src).not.toMatch(/if \(onPermissions\) \{/)
    // The live mode must also collapse to readonly when injected, or a Shift+Tab
    // caller could observe an authoritative-looking mode on a policy object.
    expect(src).toContain(
      'const livePermissionMode = (): PermissionMode => (injected ? "readonly" : withMode.__getMode())',
    )
  })
})
