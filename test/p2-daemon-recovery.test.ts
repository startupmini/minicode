// P2.3 (Session 4) — daemon restart reconstruction: a run that died is
// tombstoned on the next session start and must never be reported LIVE.
// Hermetic: temp workspace, isolated HOME, no provider call.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startDaemonHostedRuntime } from "../cli/commands/daemon.ts"
import { DaemonClient } from "../src/daemon/client.ts"
import {
  createRun,
  ensureDefaultThread,
  getRun,
  saveSession,
  tombstoneDeadRuns,
  transitionRun,
} from "../src/session/persistence.ts"
import { isolateHomeForTests } from "./helpers/hermetic-home.ts"

setDefaultTimeout(30_000)

const home = isolateHomeForTests("minicode-p23-recovery-")
mkdirSync(join(home, ".minicode"), { recursive: true })
writeFileSync(
  join(home, ".minicode", "config.json"),
  JSON.stringify({
    providers: [{ id: "fake", baseUrl: "http://127.0.0.1:9", apiKey: "sk-test", models: ["m"] }],
  }),
  "utf8",
)

function ws(): string {
  const dir = `${home}/ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function getArgFrom(argv: string[]): (name: string) => string | undefined {
  return (name: string) => {
    const i = argv.indexOf(name)
    if (i === -1) return undefined
    const v = argv[i + 1]
    return v !== undefined && !v.startsWith("-") ? v : undefined
  }
}

afterAll(() => {
  // HOME temp dibiarkan untuk OS cleanup (pola helper hermetic).
})

describe("P2.3 daemon restart reconstruction", () => {
  test("run RUNNING yang mati ditombstone dan daemon tidak melaporkan LIVE", async () => {
    const dir = ws()
    const sid = "restart-s1"
    await saveSession(sid, dir, undefined, [{ role: "user", content: "hi" }], { t: 1 })
    const thread = ensureDefaultThread(sid, dir)
    const run = createRun(sid, thread.thread_id, dir)
    transitionRun(run.run_id, "RUNNING", dir)

    // Simulasi restart: admission sesi berikutnya menombstone RUNNING yatim.
    expect(tombstoneDeadRuns(sid, dir)).toBe(1)
    expect(tombstoneDeadRuns(sid, dir)).toBe(0) // idempoten
    const row = getRun(run.run_id, dir)!
    expect(row.status).toBe("INTERRUPTED")
    expect(row.recovery_status).toBe("UNKNOWN")

    // `--prompt` membuat sesi di-host; autoRunPrompt default OFF di seam ini,
    // jadi tidak ada turn/provider yang dijalankan — kita hanya menguji status.
    const argv = ["--session", sid, "--prompt", "hi"]
    const started = await startDaemonHostedRuntime({
      sub: argv,
      getArg: getArgFrom(argv),
      cwd: dir,
    })
    const cap = started.host.issueCapability({ scopes: ["read:session"], who: "tester" })
    const client = await DaemonClient.connect({
      target: { host: "127.0.0.1", port: started.host.port },
      capability: cap,
      consumer: "tester",
    })
    try {
      const res = await client.control("session.list", {}, `list-${Date.now()}`)
      expect(res.ok).toBe(true)
      if (res.ok) {
        const list = res.result as Array<{
          sid: string
          runStatus: string | null
          recoveryStatus?: string | null
        }>
        const info = list.find((x) => x.sid === sid)
        expect(info).toBeDefined()
        // Run lama TIDAK dipresentasikan sebagai LIVE.
        expect(info?.runStatus).not.toBe("RUNNING")
        expect(info?.recoveryStatus).toBe("UNKNOWN")
      }
    } finally {
      client.close()
      await started.host.shutdown("test")
    }
  })
})
