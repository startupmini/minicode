// Hardening F-05: perubahan isi dengan panjang SAMA harus tetap durable.
// Skenario: save → kompaksi mengganti N pesan dengan N pesan berbeda → save
// → reload. Kode lama memakai messages.length sebagai proksi perubahan
// sehingga tulis kedua dilewat dan resume memuat sejarah basi.
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DomainEvent } from "../src/presentation/events.ts"
import { rebuildFromDurable } from "../src/presentation/reducer.ts"
import {
  appendPresentationEvents,
  branchSession,
  deleteSession,
  loadPresentationEvents,
  loadSession,
  saveSession,
} from "../src/session/persistence.ts"

function localCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-persist-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

const msg = (role: string, content: string) => ({ role, content })

// WAL/shm handle terkadang masih terkunci sesaat setelah close di Windows —
// retry sebelum rm (pola yang sama dipakai persistence-ttl.test.ts). Bila
// tetap terkunci, best-effort: jangan jadikan sisa tmpdir sebagai failure.
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

test("F-05: rewrite sama-panjang durable setelah reload", async () => {
  const cwd = localCwd()
  try {
    const id = "sess-rewrite-1"
    await saveSession(id, cwd, "sys", [msg("user", "satu"), msg("user", "dua")], { t: 1 })
    // Kompaksi: 2 pesan → 2 pesan BERBEDA (summary + tail).
    await saveSession(id, cwd, "sys", [msg("user", "RINGKASAN-KOMP AKSI"), msg("user", "dua")], {
      t: 2,
    })
    const loaded = loadSession(id, cwd)
    expect(loaded).not.toBeNull()
    expect(loaded!.messages.map((m) => (m as { content: unknown }).content)).toEqual([
      "RINGKASAN-KOMP AKSI",
      "dua",
    ])
  } finally {
    await rmDir(cwd)
  }
})

test("F-05: re-save identik tidak menambah baris turn hantu", async () => {
  const cwd = localCwd()
  try {
    const id = "sess-resave-1"
    const messages = [msg("user", "satu"), msg("user", "dua")]
    await saveSession(id, cwd, "sys", messages, { t: 1 })
    await saveSession(id, cwd, "sys", messages, { t: 1 })
    const loaded = loadSession(id, cwd)
    expect(loaded).not.toBeNull()
    expect(loaded!.messages.length).toBe(2)
  } finally {
    await rmDir(cwd)
  }
})

test("F-05: append murni tetap incremental + turn tercatat", async () => {
  const cwd = localCwd()
  try {
    const id = "sess-append-1"
    await saveSession(id, cwd, "sys", [msg("user", "satu")], { t: 1 })
    await saveSession(id, cwd, "sys", [msg("user", "satu"), msg("user", "dua")], { t: 2 })
    const loaded = loadSession(id, cwd)
    expect(loaded!.messages.map((m) => (m as { content: unknown }).content)).toEqual([
      "satu",
      "dua",
    ])
  } finally {
    await rmDir(cwd)
  }
})

const presentationEvent = (
  overrides: Partial<DomainEvent> & { type: DomainEvent["type"] },
): DomainEvent =>
  ({
    eventSeq: 1,
    ts: 1000,
    sessionId: "s1",
    turnId: 1,
    ...overrides,
  }) as DomainEvent

test("presentation event log idempotent, durable-only, dan branch ikut", async () => {
  const cwd = localCwd()
  try {
    const id = "presentation-1"
    await saveSession(id, cwd, "sys", [], undefined)
    const events = [
      presentationEvent({ type: "user.message", text: "halo", promptRef: "p" }),
      presentationEvent({ eventSeq: 2, type: "model.delta", delta: "live" }),
      presentationEvent({
        eventSeq: 3,
        type: "tool.completed",
        toolCallId: "t1",
        durationMs: 2,
        summary: "ok",
        expandRef: { toolCallId: "t1", idx: 0 },
      }),
    ]
    await appendPresentationEvents(id, cwd, events)
    await appendPresentationEvents(id, cwd, events)
    const loaded = loadPresentationEvents(id, cwd)
    expect(loaded.map((event) => event.type)).toEqual(["user.message", "tool.completed"])
    expect(loaded[0]?.type === "user.message" && loaded[0].text).toBe("halo")
    await branchSession(id, "presentation-2", cwd)
    expect(loadPresentationEvents("presentation-2", cwd).map((event) => event.eventSeq)).toEqual([
      1, 3,
    ])
  } finally {
    await rmDir(cwd)
  }
})

test("durable log dapat direbuild menjadi state semantic yang sama", async () => {
  const cwd = localCwd()
  try {
    const id = "presentation-rebuild"
    await saveSession(id, cwd, "sys", [], undefined)
    const events: DomainEvent[] = [
      presentationEvent({ type: "turn.started", promptRef: "p1" }),
      presentationEvent({ eventSeq: 2, type: "user.message", text: "hello", promptRef: "p1" }),
      presentationEvent({
        eventSeq: 3,
        type: "tool.started",
        toolCallId: "t1",
        stepId: 0,
        identity: { origin: "builtin", name: "read_file", qualified: "read_file" },
        argsSummary: { text: "path=a.ts" },
      }),
      presentationEvent({
        eventSeq: 4,
        type: "tool.completed",
        toolCallId: "t1",
        durationMs: 3,
        summary: "ok",
        expandRef: { toolCallId: "t1", idx: 0 },
      }),
      presentationEvent({
        eventSeq: 5,
        type: "turn.completed",
        summary: {
          toolsOk: 1,
          toolsFailed: 0,
          toolsDenied: 0,
          toolsCancelled: 0,
          toolsInterrupted: 0,
          filesChanged: 0,
          durationMs: 3,
        },
      }),
    ]
    await appendPresentationEvents(id, cwd, events)
    const rebuilt = rebuildFromDurable(loadPresentationEvents(id, cwd))
    expect(rebuilt.state.conversation[0]?.text).toBe("hello")
    expect(rebuilt.state.activities.size).toBe(1)
    expect(rebuilt.state.turns.get("s1:1")?.status).toBe("completed")
  } finally {
    await rmDir(cwd)
  }
})

test("branch: parent + child finding ikut, lalu delete membersihkan", async () => {
  const cwd = localCwd()
  try {
    const src = "presentation-hierarchy"
    const dst = "presentation-hierarchy-branch"
    await saveSession(src, cwd, "sys", [], undefined)
    const parentLink = {
      parentToolCallId: "dt1",
      childSessionId: "sub_h1",
      parentSessionId: src,
    }
    const events: DomainEvent[] = [
      presentationEvent({ sessionId: src, type: "turn.started", promptRef: "p" }),
      presentationEvent({
        sessionId: src,
        eventSeq: 2,
        type: "tool.started",
        toolCallId: "dt1",
        stepId: 0,
        identity: { origin: "builtin", name: "delegate_task", qualified: "delegate_task" },
        argsSummary: { text: "delegate" },
      }),
      presentationEvent({
        sessionId: "sub_h1",
        eventSeq: 3,
        type: "tool.completed",
        toolCallId: "k1",
        durationMs: 1,
        summary: "ok",
        expandRef: { toolCallId: "k1", idx: 0 },
        parentLink,
      }),
      presentationEvent({
        sessionId: "sub_h1",
        eventSeq: 4,
        type: "finding.detected",
        findingId: "finding:k1:1",
        category: "security",
        severity: "error",
        summary: "Prompt injection",
        evidence: ["src/a.ts"],
        parentLink,
      }),
      presentationEvent({
        sessionId: src,
        eventSeq: 5,
        type: "tool.completed",
        toolCallId: "dt1",
        durationMs: 2,
        summary: "done",
        expandRef: { toolCallId: "dt1", idx: 0 },
      }),
    ]
    await appendPresentationEvents(src, cwd, events)
    await branchSession(src, dst, cwd)
    const loaded = loadPresentationEvents(dst, cwd)
    expect(loaded.map((event) => event.type)).toEqual([
      "turn.started",
      "tool.started",
      "tool.completed",
      "finding.detected",
      "tool.completed",
    ])
    expect(loaded[0]?.sessionId).toBe(dst)
    expect(loaded[3]?.type === "finding.detected" && loaded[3].sessionId).toBe("sub_h1")
    const rebuilt = rebuildFromDurable(loaded)
    expect(rebuilt.state.activities.get("sub_h1:k1")?.parentToolCallId).toBe("dt1")
    expect(rebuilt.state.findings.get("finding:k1:1")).toMatchObject({
      category: "security",
      severity: "error",
    })
    await deleteSession(dst, cwd)
    expect(loadPresentationEvents(dst, cwd)).toEqual([])
    expect(loadPresentationEvents(src, cwd)).toHaveLength(5)
  } finally {
    await rmDir(cwd)
  }
})

test("presentation event log menyaring secret dan control sequence", async () => {
  const cwd = localCwd()
  try {
    await appendPresentationEvents("presentation-secret", cwd, [
      presentationEvent({
        type: "user.message",
        text: "token sk-12345678901234567890\x1b[31m",
        promptRef: "p",
      }),
    ])
    const loaded = loadPresentationEvents("presentation-secret", cwd)
    const text = loaded[0]?.type === "user.message" ? loaded[0].text : ""
    expect(text).not.toContain("sk-12345678901234567890")
    expect(text).not.toContain("\x1b")
  } finally {
    await rmDir(cwd)
  }
})
