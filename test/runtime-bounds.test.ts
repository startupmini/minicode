// Hardening F-09/F-12: batas runtime tak valid tidak boleh punya perilaku
// implisit (abort instan, loop tak terbatas, worker nol, hot-retry).
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProviderError } from "#minicore/core/errors.ts"
import { FakeProvider, finish, text, toolCall } from "#minicore/test/fakes.ts"
import { cappedRecovery, createMinicodeSession } from "../src/app/session.ts"

test("F-12: retryAfter Infinity/NaN/negatif → backoff, besar → cap", () => {
  const inf = cappedRecovery.onError(new ProviderError("rate_limit", "x", Infinity), 1)
  expect(inf).toEqual({ type: "retry", delayMs: 1000 })
  const nan = cappedRecovery.onError(new ProviderError("rate_limit", "x", NaN), 2)
  expect(nan).toEqual({ type: "retry", delayMs: 2000 })
  const neg = cappedRecovery.onError(new ProviderError("rate_limit", "x", -5000), 1)
  expect(neg).toEqual({ type: "retry", delayMs: 1000 })
  const huge = cappedRecovery.onError(new ProviderError("rate_limit", "x", 3_600_000), 1)
  expect(huge).toEqual({ type: "retry", delayMs: 30_000 })
  const ok = cappedRecovery.onError(new ProviderError("rate_limit", "x", 5000), 1)
  expect(ok).toEqual({ type: "retry", delayMs: 5000 })
  const none = cappedRecovery.onError(new ProviderError("server", "boom"), 3)
  expect(none).toEqual({ type: "retry", delayMs: 4000 })
})

const echoTool = {
  name: "echoTool",
  description: "echo",
  parameters: {
    type: "object",
    properties: { a: { type: "number" } },
    additionalProperties: false,
  },
  execute: async (args: unknown) => `echo:${JSON.stringify(args)}`,
} as never

async function runWithBounds(extra: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bounds-"))
  try {
    const provider = new FakeProvider([
      { events: [toolCall("echoTool", { a: 1 }), finish("tool_calls")] },
      { events: [text("selesai"), finish("stop")] },
    ])
    const session = await createMinicodeSession({
      provider,
      tools: [echoTool],
      permissionMode: "allow-all",
      cwd: dir,
      ...extra,
    })
    const res = await session.run("kerjakan", {})
    return res.finalText ?? ""
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test("F-09: maxSteps 0/negatif/Infinity → default aman, turn jalan", async () => {
  expect(await runWithBounds({ maxSteps: 0 })).toContain("selesai")
  expect(await runWithBounds({ maxSteps: -3 })).toContain("selesai")
  expect(await runWithBounds({ maxSteps: Infinity })).toContain("selesai")
})

test("F-09: timeoutMs NaN/negatif → default aman, turn jalan", async () => {
  expect(await runWithBounds({ timeoutMs: NaN })).toContain("selesai")
  expect(await runWithBounds({ timeoutMs: -100 })).toContain("selesai")
})

test("F-09: concurrency 0/negatif → default aman, hasil tool terdefinisi", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bounds-"))
  try {
    const provider = new FakeProvider([
      { events: [toolCall("echoTool", { a: 1 }), finish("tool_calls")] },
      { events: [text("selesai"), finish("stop")] },
    ])
    const session = await createMinicodeSession({
      provider,
      tools: [echoTool],
      permissionMode: "allow-all",
      cwd: dir,
      concurrency: 0,
    })
    const seen: unknown[] = []
    session.events.on("execution:completed", (e) => seen.push(e.execution.result))
    const res = await session.run("kerjakan", {})
    expect(res.finalText).toContain("selesai")
    expect(seen.length).toBe(1)
    expect(seen[0]).toBeDefined()
    // sukses = tanpa flag error (isError opsional, hanya true saat gagal)
    expect((seen[0] as { isError?: boolean }).isError).not.toBe(true)
    expect(String((seen[0] as { content?: unknown }).content)).toContain('"a":1')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
