import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveDbPath } from "../src/lib/db-path.ts"
import { loadLatestContextGeneration, saveContextGeneration } from "../src/session/persistence.ts"

const dirs: string[] = []

// WAL/shm handle kadang masih terkunci sesaat setelah close di Windows —
// retry dulu sebelum rm (pola yang sama dipakai persistence-rewrite.test.ts).
// Bila tetap terkunci, best-effort: sisa tmpdir bukan failure.
async function rmDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "minicode-context-generation-"))
  // WAJIB: tanpa `.minicode`, resolveDbPath() jatuh ke ~/.minicode global —
  // test lalu menulis ke sessions.db milik user sungguhan dan mengotori
  // antar-run (pola yang sama dipakai makeWorkspace() di cli-session.test.ts).
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rmDir(dir)
})

describe("context generations", () => {
  test("round-trip mempertahankan reasoning dan tool error", async () => {
    const dir = workspace()
    const messages = [
      { role: "user", content: "perbaiki bug" },
      {
        role: "assistant",
        content: "",
        reasoning: "langkah penting",
        toolCalls: [{ id: "call-1", name: "bash", args: { cmd: "bun test" } }],
      },
      { role: "tool", name: "bash", toolCallId: "call-1", content: "gagal", isError: true },
    ]
    const saved = await saveContextGeneration("session-1", dir, {
      messages,
      turnCount: 1,
      stepCount: 1,
      model: "provider::model",
      trigger: "turn",
    })
    expect(saved?.generation).toBe(1)
    expect(saved?.provider).toBe("provider")
    const loaded = loadLatestContextGeneration("session-1", dir)
    const loadedMessages = loaded?.messages ?? []
    expect(loadedMessages).toEqual(messages)
    expect((loadedMessages[1] as { reasoning?: string }).reasoning).toBe("langkah penting")
    expect((loadedMessages[2] as { isError?: boolean }).isError).toBe(true)
  })

  test("generasi naik, idempoten, dan hanya menyimpan parent terbaru", async () => {
    const dir = workspace()
    const first = [{ role: "user", content: "satu" }]
    const second = [...first, { role: "assistant", content: "dua" }]
    const third = [...second, { role: "user", content: "tiga" }]
    const g1 = await saveContextGeneration("session-2", dir, {
      messages: first,
      turnCount: 1,
      stepCount: 1,
    })
    const same = await saveContextGeneration("session-2", dir, {
      messages: first,
      turnCount: 1,
      stepCount: 1,
    })
    expect(same?.generation).toBe(g1?.generation)
    const g2 = await saveContextGeneration("session-2", dir, {
      messages: second,
      turnCount: 2,
      stepCount: 1,
    })
    expect(g2?.parentGeneration).toBe(1)
    const g3 = await saveContextGeneration("session-2", dir, {
      messages: third,
      turnCount: 3,
      stepCount: 1,
    })
    expect(g3?.generation).toBe(3)
    const db = new Database(resolveDbPath("sessions.db", dir))
    const rows = db
      .prepare(
        "SELECT generation FROM context_generations WHERE session_id = ? ORDER BY generation",
      )
      .all("session-2") as { generation: number }[]
    db.close()
    expect(rows.map((row) => row.generation)).toEqual([2, 3])
  })

  test("generasi terbaru korup jatuh ke parent yang valid", async () => {
    const dir = workspace()
    await saveContextGeneration("session-3", dir, {
      messages: [{ role: "user", content: "parent" }],
      turnCount: 1,
      stepCount: 1,
    })
    await saveContextGeneration("session-3", dir, {
      messages: [{ role: "user", content: "child" }],
      turnCount: 2,
      stepCount: 1,
    })
    const db = new Database(resolveDbPath("sessions.db", dir))
    db.prepare(
      "UPDATE context_generations SET messages = ? WHERE session_id = ? AND generation = 2",
    ).run("not-json", "session-3")
    db.close()
    const loaded = loadLatestContextGeneration("session-3", dir)
    expect(loaded?.generation).toBe(1)
    expect(loaded?.messages).toEqual([{ role: "user", content: "parent" }])
  })

  test("payload besar ditandai truncated, bukan growth tanpa batas", async () => {
    const dir = workspace()
    const messages = Array.from({ length: 160 }, (_, i) => ({
      role: "user",
      content: `${i}:${"x".repeat(40_000)}`,
    }))
    const saved = await saveContextGeneration("session-4", dir, {
      messages,
      turnCount: 1,
      stepCount: 1,
    })
    expect(saved?.truncated).toBe(true)
    expect(saved?.messages.length).toBeLessThan(messages.length)
  })
})
