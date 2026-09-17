// Hardening F-03/F-24: request sandbox eksplisit tanpa backend = tolak
// (fail-closed), fallback host hanya via opt-in eksplisit; spawn foreground
// selalu di cwd sesi; echo background di-scrub.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { dockerAvailable } from "../src/sandbox/docker.ts"
import { osSandboxAvailable } from "../src/sandbox/os.ts"
import { bashKillTool, bashTool, killAllBackgroundJobs } from "../src/tools/bash.ts"

const savedSandbox = process.env.MINICODE_SANDBOX
const savedFallback = process.env.MINICODE_SANDBOX_ALLOW_FALLBACK
afterEach(() => {
  if (savedSandbox === undefined) delete process.env.MINICODE_SANDBOX
  else process.env.MINICODE_SANDBOX = savedSandbox
  if (savedFallback === undefined) delete process.env.MINICODE_SANDBOX_ALLOW_FALLBACK
  else process.env.MINICODE_SANDBOX_ALLOW_FALLBACK = savedFallback
  try {
    killAllBackgroundJobs()
  } catch {}
})

const ctxFor = (cwd: string) =>
  ({ cwd, signal: new AbortController().signal }) as unknown as Parameters<
    typeof bashTool.execute
  >[1]

describe("F-03: explicit sandbox tanpa backend = tolak", () => {
  test("docker tanpa backend menolak tanpa opt-in fallback", async () => {
    if (dockerAvailable()) return
    process.env.MINICODE_SANDBOX = "docker"
    delete process.env.MINICODE_SANDBOX_ALLOW_FALLBACK
    await expect(bashTool.execute({ cmd: "echo hi" }, ctxFor(tmpdir()))).rejects.toThrow(
      /refusing direct execution/,
    )
  })

  test("docker tanpa backend jalan bila fallback diizinkan eksplisit", async () => {
    if (dockerAvailable()) return
    process.env.MINICODE_SANDBOX = "docker"
    process.env.MINICODE_SANDBOX_ALLOW_FALLBACK = "1"
    const out = (await bashTool.execute({ cmd: "echo hi" }, ctxFor(tmpdir()))) as string
    expect(out).toContain("hi")
  })

  test("os tanpa backend menolak tanpa opt-in fallback", async () => {
    if (osSandboxAvailable()) return
    process.env.MINICODE_SANDBOX = "os"
    delete process.env.MINICODE_SANDBOX_ALLOW_FALLBACK
    await expect(bashTool.execute({ cmd: "echo hi" }, ctxFor(tmpdir()))).rejects.toThrow(
      /refusing direct execution/,
    )
  })

  test("tanpa MINICODE_SANDBOX perilaku direct tetap (bukan sandbox request)", async () => {
    delete process.env.MINICODE_SANDBOX
    const out = (await bashTool.execute({ cmd: "echo hi" }, ctxFor(tmpdir()))) as string
    expect(out).toContain("hi")
  })
})

describe("F-24: spawn foreground selalu di cwd sesi", () => {
  test("tanpa arg cwd, proses jalan di ctx.cwd", async () => {
    delete process.env.MINICODE_SANDBOX
    const dir = mkdtempSync(join(tmpdir(), "mc-cwd-"))
    try {
      const probe = process.platform === "win32" ? "cd" : "pwd"
      const out = (await bashTool.execute({ cmd: probe }, ctxFor(dir))) as string
      const norm = (s: string) => resolve(s.trim()).toLowerCase()
      expect(norm(out.split("\n")[0]!)).toBe(norm(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("F-07: echo background di-scrub", () => {
  test("secret di command line tak bocor mentah ke hasil", async () => {
    delete process.env.MINICODE_SANDBOX
    const secret = "sk-abc123XYZ987abc123XYZ987abc123"
    const out = (await bashTool.execute(
      { cmd: `curl -H "Authorization: Bearer ${secret}" http://127.0.0.1:9/`, background: true },
      ctxFor(tmpdir()),
    )) as string
    expect(out).not.toContain(secret)
    const id = /bash_output\(\{ id: "([^"]+)" \}\)/.exec(out)?.[1]
    expect(id).toBeTruthy()
    if (id) await bashKillTool.execute({ id }, ctxFor(tmpdir())).catch(() => {})
  })
})
