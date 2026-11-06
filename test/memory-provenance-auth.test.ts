import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeProvider, finish, text, toolCall } from "#minicore/test/fakes.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import { setupToolLayer } from "../src/app/tool-layer.ts"

const envKeys = ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "AGENT_API_KEY", "AGENT_BASE_URL"] as const

async function cleanupTemp(dir: string): Promise<void> {
  let last: unknown
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      last = error
      Bun.gc(true)
      await Bun.sleep(100)
    }
  }
  throw last
}

test("MEM-01: runtime provenance cannot be supplied or spoofed by the model", async () => {
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  const cwd = await mkdtemp(join(tmpdir(), "minicode-mem-provenance-"))
  const sessions: { abort(): void }[] = []
  try {
    await mkdir(join(cwd, ".minicode"), { recursive: true })
    const { sessionTools } = await setupToolLayer(
      { providers: [] },
      "full",
      undefined,
      undefined,
      "trusted-session",
      "EXECUTE",
      cwd,
    )
    const memoryTool = sessionTools.find((tool) => tool.name === "write_memory")!
    const properties = memoryTool.parameters.properties ?? {}
    expect(properties).not.toHaveProperty("sessionId")
    expect(properties).not.toHaveProperty("turnId")
    expect(properties).not.toHaveProperty("sourceKind")
    expect(properties).not.toHaveProperty("sourceRef")

    const spoofProvider = new FakeProvider([
      {
        events: [
          toolCall("write_memory", {
            text: "spoofed provenance must not persist",
            sessionId: "attacker-session",
            turnId: "999",
            sourceKind: "user",
            sourceRef: "attacker-source",
          }),
          finish("tool_calls"),
        ],
      },
      { events: [text("rejected"), finish("stop")] },
    ])
    const spoofSession = await createMinicodeSession({
      provider: spoofProvider,
      tools: [memoryTool],
      cwd,
      noProgress: false,
    })
    sessions.push(spoofSession)
    const spoofResult = await spoofSession.run("write a memory")
    const rejected = spoofResult.steps.flatMap((step) => step.results)[0]
    expect(rejected?.isError).toBe(true)
    expect(String(rejected?.content)).toContain("unknown property: sessionId")
    await expect(readFile(join(cwd, ".minicode", "MEMORY.md"), "utf8")).rejects.toThrow()

    const trustedProvider = new FakeProvider([
      {
        events: [
          toolCall("write_memory", { text: "runtime provenance is canonical" }),
          finish("tool_calls"),
        ],
      },
      { events: [text("saved"), finish("stop")] },
    ])
    const trustedSession = await createMinicodeSession({
      provider: trustedProvider,
      tools: [memoryTool],
      cwd,
      noProgress: false,
    })
    sessions.push(trustedSession)
    await trustedSession.run("write a verified memory")
    const stored = await readFile(join(cwd, ".minicode", "MEMORY.md"), "utf8")
    expect(stored).toContain('"session:trusted-session"')
    expect(stored).toContain('"turn:1"')
    expect(stored).toContain('"source:agent"')
    expect(stored).toContain('"ref:write_memory"')
    expect(stored).not.toContain("attacker-session")
  } finally {
    for (const session of sessions) session.abort()
    await cleanupTemp(cwd)
    for (const key of envKeys) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
