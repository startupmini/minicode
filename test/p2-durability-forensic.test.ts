// P2.10 FINAL DURABILITY FORENSIC — restart evidence, not mocks.
//
// Each test writes journal state in a CHILD process, SIGKILLs it only after
// the awaited write API resolved (READY on stdout), then inspects the journal
// from this process (the "restart"). This proves post-await records survive
// process death — the exact boundary §17 asks about.
//
// Hermetic: temp workspace per test, child script written into it at runtime.
// No network, no kernel run, no SQLite.

import { expect, setDefaultTimeout, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { journalPath, loadJournal } from "../src/session/journal.ts"

setDefaultTimeout(30_000)

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p210d-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows may briefly retain handles; the OS cleans temporary roots.
  }
}

// Child: performs the awaited journal write(s), prints READY only after the
// API resolved, then parks until killed. READY therefore proves the write
// completed inside a process that is subsequently SIGKILLed.
function childScript(journalModule: string): string {
  return `import {
  appendMutationIntent,
  appendMutationTerminal,
  appendVerificationRecord,
} from ${JSON.stringify(journalModule)}
const [kind, session, dir] = process.argv.slice(2) as [string, string, string]
if (kind === "intent") {
  const r = await appendMutationIntent({ session, tool: "write_file", cwd: dir, paths: ["a.txt"], argsHash: "00" })
  console.log(\`READY \${r.id}\`)
} else if (kind === "receipt") {
  const r = await appendMutationIntent({ session, tool: "write_file", cwd: dir, paths: ["a.txt"], argsHash: "00" })
  await appendMutationTerminal(session, dir, r.id, r.seq, "write_file", "committed", { note: "k" })
  console.log(\`READY \${r.id}\`)
} else if (kind === "verification") {
  const r = await appendMutationIntent({ session, tool: "write_file", cwd: dir, paths: ["a.txt"], argsHash: "00" })
  const v = await appendVerificationRecord({
    session,
    tool: "write_file",
    invocationId: "inv:forensic:0",
    method: "filesystem-read-back",
    verdict: "present",
    evidenceReference: "forensic-subprocess",
    cwd: dir,
  })
  console.log(\`READY \${v.record.id}\`)
} else {
  console.log("READY unknown-kind")
}
await new Promise(() => {})
`
}

function waitForReady(child: ChildProcess, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ""
    const timer = setTimeout(() => reject(new Error("child never printed READY")), timeoutMs)
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString()
      const line = out.split("\n").find((l) => l.startsWith("READY "))
      if (line) {
        clearTimeout(timer)
        resolve(line.trim())
      }
    })
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

function waitForExit(child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(() => reject(new Error("child did not exit after kill")), timeoutMs)
    child.on("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// Write in child, SIGKILL after READY, inspect from parent (= restart).
async function writeThenKill(
  kind: "intent" | "receipt" | "verification",
  session: string,
  dir: string,
): Promise<{ killed: boolean; ready: string }> {
  const scriptPath = join(dir, "forensic-child.ts")
  writeFileSync(
    scriptPath,
    childScript(join(process.cwd(), "src", "session", "journal.ts")),
    "utf8",
  )
  const child = spawn(process.execPath, [scriptPath, kind, session, dir], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  try {
    const ready = await waitForReady(child)
    const signaled = child.kill("SIGKILL")
    await waitForExit(child)
    return { killed: signaled, ready }
  } finally {
    try {
      child.kill("SIGKILL")
    } catch {}
  }
}

test("forensic: awaited intent survives SIGKILL + restart", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210d-intent"
    const { killed, ready } = await writeThenKill("intent", sid, dir)
    expect(killed).toBe(true)
    expect(ready).toContain(`${sid}:`)
    const loaded = await loadJournal(sid, dir)
    expect(loaded.status).toBe("valid")
    expect(loaded.records).toHaveLength(1)
    expect(loaded.records[0]!.state).toBe("pending")
    expect(loaded.records[0]!.tool).toBe("write_file")
    // Pending after kill = UNKNOWN, never promoted by the kill itself.
    expect(loaded.records[0]!.state).not.toBe("committed")
  } finally {
    cleanup(dir)
  }
})

test("forensic: awaited receipt survives SIGKILL + restart", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210d-receipt"
    const { killed } = await writeThenKill("receipt", sid, dir)
    expect(killed).toBe(true)
    const loaded = await loadJournal(sid, dir)
    expect(loaded.status).toBe("valid")
    expect(loaded.records).toHaveLength(2)
    expect(loaded.records.map((r) => r.state)).toEqual(["pending", "committed"])
    expect(loaded.records[1]!.outcome?.note).toBe("k")
  } finally {
    cleanup(dir)
  }
})

test("forensic: awaited verification record survives SIGKILL + restart", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210d-verification"
    const { killed, ready } = await writeThenKill("verification", sid, dir)
    expect(killed).toBe(true)
    const loaded = await loadJournal(sid, dir)
    expect(loaded.status).toBe("valid")
    const verification = loaded.records.find((r) => r.kind === "verification")
    expect(verification?.verdict).toBe("present")
    expect(verification?.id).toBe(ready.replace("READY ", ""))
  } finally {
    cleanup(dir)
  }
})

test("forensic: torn tail from a mid-append crash never becomes a record", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210d-torn"
    const { killed } = await writeThenKill("intent", sid, dir)
    expect(killed).toBe(true)
    // Simulate the crash landing mid-append: a partial line with no newline.
    appendFileSync(journalPath(sid, dir), `{"v":1,"id":"${sid}:999`, "utf8")
    const loaded = await loadJournal(sid, dir)
    // The corrupt tail is discarded; the valid prefix stays authoritative.
    expect(loaded.truncatedTail).toBe(true)
    expect(loaded.records).toHaveLength(1)
    expect(loaded.records[0]!.state).toBe("pending")
    expect(loaded.records.some((r) => r.id === `${sid}:999`)).toBe(false)
  } finally {
    cleanup(dir)
  }
})
