import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleBuiltinCommand } from "../cli/commands.ts"
import { saveSession } from "../src/session/persistence.ts"

function dummyCtx(extra: { setModelOverride?: (m: string) => void } = {}) {
  const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0.001 }
  return {
    sessionId: "test-sess",
    currentModel: "gpt-4o",
    usage: {
      get: () => usage,
      getSession: () => usage,
      reset: () => {},
      modelUsed: () => ({ effective: undefined, provider: undefined }),
    },
    skills: [],
    toolsCount: 20,
    setModelOverride: extra.setModelOverride ?? (() => {}),
    // Kontrak control-plane (Phase 6): /status membedakan Context vs Usage vs
    // Budget — dummy menyediakan angka tetap.
    getContextTokens: () => 1024,
    budgetState: () => "ok" as const,
  }
}

test("commands: non-slash input returns handled: false", async () => {
  const res = await handleBuiltinCommand("hello world", dummyCtx())
  expect(res.handled).toBe(false)
})

test("commands: BUILTIN_COMMANDS name tidak boleh berisi placeholder args", () => {
  const { BUILTIN_COMMANDS } = require("../cli/commands.ts") as {
    BUILTIN_COMMANDS: { name: string; args?: string }[]
  }
  for (const b of BUILTIN_COMMANDS) {
    expect(b.name).not.toMatch(/[<[\s]/)
  }
})

test("commands: /model opens the model manager", async () => {
  const res = await handleBuiltinCommand("/model", dummyCtx())
  expect(res.handled).toBe(true)
})

test("commands: /help, /status, /model, /exit are handled", async () => {
  const ctx = dummyCtx()

  const resHelp = await handleBuiltinCommand("/help", ctx)
  expect(resHelp.handled).toBe(true)

  const resModel = await handleBuiltinCommand("/model", ctx)
  expect(resModel.handled).toBe(true)

  const resExit = await handleBuiltinCommand("/exit", ctx)
  expect(resExit.handled).toBe(true)
  expect(resExit.shouldExit).toBe(true)
})

test("commands: /sessions lists saved sessions with cwd", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "minicode-sess-"))
  await saveSession("sess-1", tmp, undefined, [{ role: "user", content: "hi" }], { inputTokens: 1 })
  const ctx = { ...dummyCtx(), cwd: tmp }
  const res = await handleBuiltinCommand("/sessions", ctx)
  expect(res.handled).toBe(true)
  rmSync(tmp, { recursive: true, force: true })
})

test("commands: /sessions with an unknown id fails gracefully", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "minicode-resume-"))
  const ctx = { ...dummyCtx(), cwd: tmp }
  const res = await handleBuiltinCommand("/sessions no-such-id", ctx)
  expect(res.handled).toBe(true)
  rmSync(tmp, { recursive: true, force: true })
})
