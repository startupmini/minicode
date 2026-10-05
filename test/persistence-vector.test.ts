import { afterAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { addMemory, deleteMemoryByQuery, searchHybrid } from "../src/memory/vector.ts"
import {
  DEFAULT_THREAD_ID,
  deleteSession,
  loadSession,
  saveSession,
  shrinkThreadHistory,
} from "../src/session/persistence.ts"

// pakai OS temp dir — hermetic & tidak mengotori repo root (sqlite WAL bisa
// meninggalkan file lock di Windows)
const tmp = await mkdtemp(join(tmpdir(), "minicode-persist-"))
const tmpDir = resolve(tmp, ".minicode")

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
})

test("persistence roundtrip + delete", async () => {
  await mkdir(tmpDir, { recursive: true })
  const id = `t-${randomUUID().slice(0, 6)}`
  await saveSession(
    id,
    tmp,
    "sys",
    [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi", toolCalls: [{ id: "c1", name: "echo", args: { x: 1 } }] },
      { role: "tool", toolCallId: "c1", name: "echo", content: "1" },
    ] as never,
    { turns: 1 },
  )
  const loaded = loadSession(id, tmp)
  expect(loaded?.messages.length).toBe(3)
  expect((loaded!.messages[1] as { toolCalls?: unknown[] }).toolCalls?.length).toBe(1)
  await deleteSession(id, tmp)
  expect(loadSession(id, tmp)).toBeNull()
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
})

test("persistence incremental: append-only pada turn ke-2", async () => {
  await mkdir(tmpDir, { recursive: true })
  const id = `i-${randomUUID().slice(0, 6)}`
  // turn 1: 2 pesan
  await saveSession(
    id,
    tmp,
    "sys",
    [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ] as never,
    {},
  )
  expect(loadSession(id, tmp)?.messages.length).toBe(2)
  // turn 2: 4 pesan (2 baru + 2 lama)
  await saveSession(
    id,
    tmp,
    "sys",
    [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ] as never,
    {},
  )
  expect(loadSession(id, tmp)?.messages.length).toBe(4)
  // turn 3: 5 pesan (1 baru)
  await saveSession(
    id,
    tmp,
    "sys",
    [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
    ] as never,
    {},
  )
  const loaded = loadSession(id, tmp)
  expect(loaded?.messages.length).toBe(5)
  expect((loaded!.messages[4] as { content: string }).content).toBe("u3")
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
})

test("persistence Uint8Array content disimpan sebagai placeholder", async () => {
  await mkdir(tmpDir, { recursive: true })
  const id = `b-${randomUUID().slice(0, 6)}`
  await saveSession(
    id,
    tmp,
    "sys",
    [
      { role: "user", content: new Uint8Array([0, 1, 2, 3]) },
      { role: "assistant", content: "ok" },
    ] as never,
    {},
  )
  const loaded = loadSession(id, tmp)
  const msg = loaded?.messages[0] as { content: string }
  expect(typeof msg.content).toBe("string")
  expect(msg.content).toMatch(/\[binary: 4 bytes\]/)
  expect((loaded!.messages[1] as { content: string }).content).toBe("ok")
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
})

test("persistence compaction (history menyusut) tulis ulang penuh", async () => {
  await mkdir(tmpDir, { recursive: true })
  const id = `c-${randomUUID().slice(0, 6)}`
  // simulate 3 turns
  await saveSession(
    id,
    tmp,
    "sys",
    [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ] as never,
    {},
  )
  expect(loadSession(id, tmp)?.messages.length).toBe(6)
  // compaction: hanya 2 pesan terakhir. P2.7: jalur shrink EKSPLISIT
  // (saveSession kini append-only dan menolak rewrite implisit).
  shrinkThreadHistory(
    id,
    DEFAULT_THREAD_ID,
    [
      { role: "user", content: "summary" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ] as never,
    tmp,
    { expectedEpoch: 0 },
  )
  const loaded = loadSession(id, tmp)
  expect(loaded?.messages.length).toBe(3)
  expect((loaded!.messages[0] as { content: string }).content).toBe("summary")
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
})

test("vector hybrid keyword fallback (no embedding key)", async () => {
  // Hermetic: tmp cwd DENGAN .minicode/ agar resolveDbPath lokal — versi lama
  // memakai cwd global ({}), lalu cleanup membuka ulang ~/.minicode/vector.db
  // yang di CI tidak ada → SQLITE_CANTOPEN (lolos di mesin dev karena DB
  // global sudah ada dari pemakaian nyata). Fallback keyword tak peduli cwd.
  const dir = await mkdtemp(join(tmpdir(), "vec-kw-"))
  await mkdir(join(dir, ".minicode"), { recursive: true })
  try {
    const marker = `vec-test-${randomUUID().slice(0, 6)}`
    await addMemory(`unique ${marker} content about persistence`, { cwd: dir })
    const hits = (await searchHybrid("persistence", { cwd: dir })) as unknown as {
      text: string
      score: number
    }[]
    expect(hits.some((h) => h.text.includes(marker))).toBe(true)
    expect(hits[0]?.score).toBeGreaterThanOrEqual(0)
    expect(hits[0]?.score).toBeLessThanOrEqual(1)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test("deleteMemoryByQuery SQL removes matching memories", async () => {
  await mkdir(tmpDir, { recursive: true })
  const marker = `del-vec-${randomUUID().slice(0, 6)}`
  await addMemory(`${marker} alpha`, { cwd: tmp })
  await addMemory(`${marker} beta`, { cwd: tmp })
  await addMemory("keep-this-note", { cwd: tmp })
  const deleted = await deleteMemoryByQuery(marker, tmp)
  expect(deleted).toBe(2)
  const after = await searchHybrid(marker, { cwd: tmp })
  expect(after.some((h) => h.text.includes(marker))).toBe(false)
  // yang tidak match tetap ada
  const kept = await searchHybrid("keep-this-note", { cwd: tmp })
  expect(kept.length).toBeGreaterThanOrEqual(1)
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
})

test("resume: loadSession preserves toolCallId/name dan bisa di-seed ke sesi", async () => {
  await mkdir(tmpDir, { recursive: true })
  const id = `resume-${randomUUID().slice(0, 6)}`
  const msgs = [
    { role: "user", content: "u1" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "a" } }],
    },
    { role: "tool", toolCallId: "c1", name: "read_file", content: "a-content" },
    { role: "assistant", content: "done" },
  ] as never
  await saveSession(id, tmp, "sys", msgs, {})
  const loaded = loadSession(id, tmp)
  const toolMsg = loaded?.messages[2] as {
    role: string
    toolCallId?: string
    name?: string
    content: string
  }
  expect(toolMsg.role).toBe("tool")
  expect(toolMsg.toolCallId).toBe("c1")
  expect(toolMsg.name).toBe("read_file")
  expect(toolMsg.content).toBe("a-content")
  // seed ke kernel (minicore createSession) — history penuh tersedia
  const { createSession } = await import("#minicore/core/index.ts")
  const { FakeProvider, allowAll, text, finish } = await import("#minicore/test/fakes.ts")
  const p = new FakeProvider([{ events: [text("ok"), finish("stop")] }])
  const s = createSession({
    provider: p,
    permissions: allowAll,
    initialMessages: loaded?.messages as never,
  })
  await s.run("lanjut")
  expect(s.state.history).toHaveLength(6) // 4 initial + 1 user + 1 assistant
  expect(s.state.history[2]).toMatchObject({ role: "tool", toolCallId: "c1", name: "read_file" })
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
})
