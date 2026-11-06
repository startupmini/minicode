import { expect, test } from "bun:test"
import { delegateTaskTool, setSubAgentSessionFactory } from "../src/tools/task.ts"

const ctx = { signal: new AbortController().signal, cwd: process.cwd(), emit: () => {} } as never

test("delegate_task tanpa factory injeksi fail-closed", async () => {
  const out = await delegateTaskTool.execute({ prompt: "x" }, ctx)
  expect(String(out)).toContain("session factory not configured")
})

test("delegate_task memakai factory injeksi composition root", async () => {
  // Jamin getProvider punya jalan keluar walau config kosong (CI): fallback env.
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-hermetic"
  let specSeen: { permissionMode?: string; maxSteps?: number } | undefined
  setSubAgentSessionFactory(async (spec) => {
    specSeen = spec
    return {
      events: { on: () => () => {} },
      run: async () => ({ finalText: "ringkasan sub-agen", usage: { steps: 2 } }),
    }
  })
  const out = await delegateTaskTool.execute({ prompt: "jelajahi struktur" }, ctx)
  expect(String(out)).toContain("sub-agent (explore) done: ringkasan sub-agen [steps 2]")
  expect(specSeen?.permissionMode).toBe("auto")
  expect(specSeen?.maxSteps).toBeGreaterThan(0)
})
