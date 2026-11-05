// P2.3 — daemon run control: interrupt must reach the actual running turn.
// Hermetic: fake provider that hangs, temp HOME/workspace, loopback daemon.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDaemonHostedRuntime } from "../cli/commands/daemon.ts"
import { DaemonClient } from "../src/daemon/client.ts"
import { startFakeProvider } from "./helpers/fake-provider.ts"

setDefaultTimeout(30_000)

const dirs: string[] = []
const envBackup = new Map<string, string | undefined>()

function workspace(): { dir: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "mc-p2-daemon-"))
  const home = join(dir, "home")
  mkdirSync(join(home, ".minicode"), { recursive: true })
  dirs.push(dir)
  return { dir, home }
}

function writeProvider(home: string, baseUrl: string): void {
  writeFileSync(
    join(home, ".minicode", "config.json"),
    JSON.stringify({
      providers: [{ id: "fake", baseUrl, apiKey: "sk-test", models: ["gpt-4o-mini"] }],
    }),
    "utf8",
  )
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

function getArgFrom(argv: string[]): (name: string) => string | undefined {
  return (name: string) => {
    const i = argv.indexOf(name)
    if (i === -1) return undefined
    const v = argv[i + 1]
    return v !== undefined && !v.startsWith("-") ? v : undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = fn()
    if (value !== undefined) return value
    if (Date.now() > end) throw new Error("waitFor timeout")
    await sleep(25)
  }
}

afterEach(() => {
  restoreHome()
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

describe("P2.3 daemon run control", () => {
  test("run.interrupt menghentikan run yang benar-benar RUNNING", async () => {
    const { dir, home } = workspace()
    isolateHome(home)
    const provider = startFakeProvider([{ kind: "hang" }])
    writeProvider(home, provider.baseUrl)
    try {
      const argv = ["--prompt", "halo"]
      const started = await startDaemonHostedRuntime({
        sub: argv,
        getArg: getArgFrom(argv),
        cwd: dir,
        autoRunPrompt: true,
      })
      const session = started.session
      expect(session).not.toBeNull()
      const sid = session!.sessionId

      const cap = started.host.issueCapability({ scopes: ["control:session"], who: "tester" })
      const client = await DaemonClient.connect({
        target: { host: "127.0.0.1", port: started.host.port },
        capability: cap,
        consumer: "tester",
      })
      try {
        const running = await waitFor(() => {
          const s = session!.runState()
          return s.runId && s.status === "RUNNING" ? s : undefined
        })
        expect(running.runId).toBeTruthy()

        const interrupted = await client.control(
          "run.interrupt",
          { sid, runId: running.runId },
          `interrupt-${Date.now()}`,
        )
        expect(interrupted.ok).toBe(true)

        const terminal = await waitFor(() => {
          const s = session!.runState()
          return s.status === "INTERRUPTED" ? s : undefined
        })
        expect(terminal.runId).toBe(running.runId)
      } finally {
        client.close()
        await started.host.shutdown("test")
      }
    } finally {
      provider.close()
    }
  })

  test("runId yang salah tidak meng-abort run lain", async () => {
    const { dir, home } = workspace()
    isolateHome(home)
    const provider = startFakeProvider([{ kind: "hang" }])
    writeProvider(home, provider.baseUrl)
    try {
      const argv = ["--prompt", "halo"]
      const started = await startDaemonHostedRuntime({
        sub: argv,
        getArg: getArgFrom(argv),
        cwd: dir,
        autoRunPrompt: true,
      })
      const session = started.session!
      const sid = session.sessionId
      const cap = started.host.issueCapability({ scopes: ["control:session"], who: "tester" })
      const client = await DaemonClient.connect({
        target: { host: "127.0.0.1", port: started.host.port },
        capability: cap,
        consumer: "tester",
      })
      try {
        await waitFor(() => {
          const s = session.runState()
          return s.runId && s.status === "RUNNING" ? s : undefined
        })
        const res = await client.control(
          "run.interrupt",
          { sid, runId: "run_tidak_ada" },
          `wrong-${Date.now()}`,
        )
        expect(res.ok).toBe(false)
        if (!res.ok) expect(res.refusal?.code).toBe("RUN_TERMINAL")
        // Run asli masih hidup.
        expect(session.runState().status).toBe("RUNNING")
      } finally {
        client.close()
        await started.host.shutdown("test")
      }
    } finally {
      provider.close()
    }
  })
})
