import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PermissionHandler } from "#minicore/core/permission.ts"
import { FakeProvider, finish, text, tool, toolCall } from "#minicore/test/fakes.ts"
import { createMinicodeSession } from "../src/app/session.ts"

const script = () => [
  { events: [toolCall("mutate", {}), finish("tool_calls")] },
  { events: [text("turn finished"), finish("stop")] },
]

test("CTL-07: production session dispatch authorizes only explicit allow", async () => {
  const decisions: Array<{ label: string; value: unknown; allowed: boolean }> = [
    { label: "allow", value: "allow", allowed: true },
    { label: "deny", value: "deny", allowed: false },
    { label: "undefined", value: undefined, allowed: false },
    { label: "null", value: null, allowed: false },
    { label: "unknown", value: "maybe", allowed: false },
    { label: "unresolved ask", value: "ask", allowed: false },
  ]

  for (const decision of decisions) {
    const cwd = await mkdtemp(join(tmpdir(), "minicode-ctl07-"))
    let effects = 0
    const provider = new FakeProvider(script())
    const session = await createMinicodeSession({
      provider,
      tools: [
        tool("mutate", async () => {
          effects++
          return "SIDE_EFFECT_COMMITTED"
        }),
      ],
      cwd,
      noProgress: false,
      permissionHandler: {
        check: async () => decision.value,
      } as unknown as PermissionHandler,
    })
    const started: string[] = []
    session.events.on("execution:started", (event) => started.push(event.execution.call.name))

    try {
      const result = await session.run(`permission decision ${decision.label}`)
      const toolResult = result.steps.flatMap((step) => step.results)
      expect(effects, decision.label).toBe(decision.allowed ? 1 : 0)
      expect(started, decision.label).toEqual(decision.allowed ? ["mutate"] : [])
      expect(toolResult, decision.label).toHaveLength(1)
      expect(toolResult[0]?.isError === true, decision.label).toBe(!decision.allowed)
      if (!decision.allowed) expect(String(toolResult[0]?.content)).toContain("permission denied")

      const committedToolResults = session.state.history.filter(
        (message) => message.role === "tool",
      )
      expect(committedToolResults, decision.label).toHaveLength(1)
      expect(committedToolResults[0]?.isError === true, decision.label).toBe(!decision.allowed)
      if (decision.allowed) {
        expect(String(toolResult[0]?.content)).toBe("SIDE_EFFECT_COMMITTED")
      } else {
        expect(String(toolResult[0]?.content)).not.toContain("SIDE_EFFECT_COMMITTED")
      }
    } finally {
      session.abort()
      await rm(cwd, { recursive: true, force: true })
    }
  }
})
