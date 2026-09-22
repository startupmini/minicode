import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { budgetStatus } from "../src/policy/usage.ts"
import { classifyToolResult, summarizeArgs, writeStepTrace } from "../src/telemetry/trace.ts"

// P1.3 — satu predikat untuk one-shot/REPL/exec agar keputusan budget sepakat.
describe("harness P1.3: budgetStatus", () => {
  test("tanpa budget selalu ok", () => {
    expect(budgetStatus(undefined, undefined, false)).toBe("ok")
    expect(budgetStatus(undefined, undefined, true)).toBe("ok")
    expect(budgetStatus(undefined, 99, true)).toBe("ok")
  })

  test("cost dikenal: over vs ok", () => {
    expect(budgetStatus(1, 2, false)).toBe("over")
    expect(budgetStatus(1, 2, true)).toBe("over")
    expect(budgetStatus(1, 0.5, true)).toBe("ok")
    expect(budgetStatus(1, 1, false)).toBe("ok") // tepat di batas bukan over
  })

  test("cost tak dikenal: fail-open tanpa strict, fail-closed dengan strict", () => {
    expect(budgetStatus(1, undefined, false)).toBe("ok")
    expect(budgetStatus(1, undefined, true)).toBe("unknown-strict")
  })
})

let dir = ""
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ""
})

// P1.2 — observability per-step: ringkas, klasifikasi, tulis.
describe("harness P1.2: step trace", () => {
  test("summarizeArgs hanya pointer, bukan isi + secret di-scrub", () => {
    expect(summarizeArgs({ path: "a.txt", content: "x".repeat(5000) })).toBe("path=a.txt")
    expect(summarizeArgs({ cmd: "echo sk-abc123XYZ987abc123XYZ987abc123" })).toContain("[REDACTED]")
    expect(summarizeArgs({ cmd: "echo sk-abc123XYZ987abc123XYZ987abc123" })).not.toContain(
      "sk-abc123",
    )
    expect(summarizeArgs(null)).toBe("")
  })

  test("classifyToolResult: ok/denied/error", () => {
    expect(classifyToolResult({ isError: false, content: "ok" })).toBe("ok")
    expect(classifyToolResult({ content: "permission denied" })).toBe("ok") // tanpa isError bukan deny
    expect(classifyToolResult({ isError: true, content: "permission denied" })).toBe("denied")
    expect(classifyToolResult({ isError: true, content: "permission error: boom" })).toBe("denied")
    expect(classifyToolResult({ isError: true, content: "exit 1\nboom" })).toBe("error")
  })

  test("writeStepTrace menulis jsonl dengan flag denied", async () => {
    dir = await mkdtemp(join(tmpdir(), "minicode-harness-p1-"))
    await writeStepTrace(dir, {
      sessionId: "s-1",
      timestamp: new Date().toISOString(),
      kind: "tool",
      step: 0,
      tool: "bash",
      ok: false,
      denied: true,
      args: "cmd=rm -rf /",
      sandbox: "none",
    })
    const txt = await readFile(`${dir}/.minicode/step-traces.jsonl`, "utf8")
    expect(txt).toContain('"tool":"bash"')
    expect(txt).toContain('"denied":true')
    expect(txt).toContain('"sandbox":"none"')
  })

  test("F1.2: totalTokens kumulatif bertahan round-trip jsonl", async () => {
    dir = await mkdtemp(join(tmpdir(), "minicode-harness-p1-"))
    await writeStepTrace(dir, {
      sessionId: "s-2",
      timestamp: new Date().toISOString(),
      kind: "step",
      step: 3,
      tools: 2,
      errors: 0,
      sandbox: "none",
      totalTokens: 1234,
    })
    const txt = await readFile(`${dir}/.minicode/step-traces.jsonl`, "utf8")
    expect(txt).toContain('"totalTokens":1234')
  })
})
