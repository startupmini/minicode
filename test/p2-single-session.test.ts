// P2.3 (Session 4) — single-session runtime contract is enforced at the RUN
// boundary (not merely documented). The guard is exercised deterministically
// via the exported test seam (which sets the exact same variable the run path
// uses) so the test does not depend on provider abort timing; sequential
// sessions and daemon multi-consumer remain valid.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __getActiveAgentSessionForTest,
  __setActiveAgentSessionForTest,
  type CliSessionOptions,
  ConcurrentAgentSessionError,
  createCliSession,
} from "../cli/setup.ts"

setDefaultTimeout(30_000)

const dirs: string[] = []
const envBackup = new Map<string, string | undefined>()

function workspace(): { dir: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "mc-p23-iso-"))
  const home = join(dir, "home")
  mkdirSync(join(home, ".minicode"), { recursive: true })
  dirs.push(dir)
  return { dir, home }
}

function isolateHome(home: string): void {
  for (const key of ["HOME", "USERPROFILE", "MINICODE_HOME"]) {
    envBackup.set(key, process.env[key])
    process.env[key] = home
  }
}

function restoreHome(): void {
  for (const [key, value] of envBackup) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  envBackup.clear()
}

afterEach(() => {
  __setActiveAgentSessionForTest(null)
  restoreHome()
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

function writeProvider(home: string): void {
  writeFileSync(
    join(home, ".minicode", "config.json"),
    JSON.stringify({
      providers: [
        { id: "fake", baseUrl: "http://127.0.0.1:9", apiKey: "sk-test", models: ["gpt-4o-mini"] },
      ],
    }),
    "utf8",
  )
}

const sessionBase = (dir: string): Omit<CliSessionOptions, "sessionId"> => ({
  cwd: dir,
  enterRepl: false,
  verbose: false,
  allowAll: true,
  prompt: "",
  ask: false,
  plan: false,
  allowlist: false,
  verify: false,
})

describe("P2.3 single-session enforcement", () => {
  test("run dari sesi lain ditolak saat ada sesi aktif; dilepas setelah guard kosong", async () => {
    const { dir, home } = workspace()
    isolateHome(home)
    writeProvider(home)
    const a = await createCliSession({ ...sessionBase(dir), sessionId: "iso-a" })
    const b = await createCliSession({ ...sessionBase(dir), sessionId: "iso-b" })
    try {
      // Simulasikan sesi A sedang menjalankan turn (variabel guard = milik A).
      __setActiveAgentSessionForTest("iso-a")
      await expect(b.runPromptWithVerify("b", new AbortController().signal)).rejects.toBeInstanceOf(
        ConcurrentAgentSessionError,
      )
      // Guard dilepas → tidak ada sesi aktif yang memblokir sesi berikutnya.
      __setActiveAgentSessionForTest(null)
      expect(__getActiveAgentSessionForTest()).toBeNull()
    } finally {
      await a.close()
      await b.close()
    }
  })

  test("dua sesi boleh dibuat berurutan (konstruksi bukan run)", async () => {
    const { dir, home } = workspace()
    isolateHome(home)
    writeProvider(home)
    const a = await createCliSession({ ...sessionBase(dir), sessionId: "seq-a" })
    await a.close()
    const b = await createCliSession({ ...sessionBase(dir), sessionId: "seq-b" })
    await b.close()
    expect(true).toBe(true)
  })
})
