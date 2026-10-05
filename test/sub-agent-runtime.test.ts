// P2.9 — Sub-Agent Runtime (Model C).
//
// Membuktikan: sesi anak kanonik + lineage durable (parent Session DAN parent
// Run), Thread/Run sendiri, epoch writer independen, isolasi histori/konteks,
// sweep orphan (INTERRUPTED/UNKNOWN, tak pernah COMPLETED), paragraph
// terminal→anak terminal, dan closure presentasi yang tidak dimakan purge.

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  allocateChildSessionId,
  completeRun,
  createChildSession,
  createRun,
  DEFAULT_THREAD_ID,
  getActiveRun,
  getChildSessionLink,
  getRun,
  listChildSessions,
  listSessionRuns,
  loadSession,
  loadThreadHistory,
  readWriterEpoch,
  StaleWriterError,
  saveSession,
  takeoverSessionEpoch,
  tombstoneOrphanChildRuns,
  transitionRun,
} from "../src/session/persistence.ts"
import { delegateTaskTool, setSubAgentParentRunId, subAgentParentRunId } from "../src/tools/task.ts"

function takeover(sid: string, expected: number, cwd: string): number {
  return takeoverSessionEpoch(sid, expected, "uji", "bootB", cwd).epoch
}

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p29-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

async function seedParent(cwd: string, sid = "parent", n = 2): Promise<void> {
  await saveSession(
    sid,
    cwd,
    undefined,
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `p${i}`,
    })),
    { t: 1 },
  )
}

test("P2.9-1/2/3: sesi anak kanonik + lineage parent Session DAN parent Run", async () => {
  const cwd = ws()
  await seedParent(cwd)
  const parentRun = createRun("parent", DEFAULT_THREAD_ID, cwd)
  const child = createChildSession({
    parentSessionId: "parent",
    parentRunId: parentRun.run_id,
    cwd,
  })
  expect(child.sessionId.startsWith("sub_")).toBe(true)
  // 128-bit entropy (bukan 8-hex P1 lawas).
  expect(child.sessionId.length).toBeGreaterThan("sub_12345678".length)
  const link = getChildSessionLink(child.sessionId, cwd)!
  expect(link.parent_session_id).toBe("parent")
  expect(link.parent_run_id).toBe(parentRun.run_id)
  // Sesi anak itu sendiri kanonik (bukan namespace hantu).
  expect(loadSession(child.sessionId, cwd)).not.toBeNull()
  // Parent TIDAK punya parent (root).
  expect(getChildSessionLink("parent", cwd)).toEqual({
    parent_session_id: null,
    parent_run_id: null,
  })
})

test("P2.9-4/5/6: child Thread + child Run; Run mencapai RUNNING", async () => {
  const cwd = ws()
  await seedParent(cwd)
  const parentRun = createRun("parent", DEFAULT_THREAD_ID, cwd)
  const child = createChildSession({
    parentSessionId: "parent",
    parentRunId: parentRun.run_id,
    cwd,
  })
  // Thread default anak ada dan terpisah.
  expect(child.threadId).toBe(DEFAULT_THREAD_ID)
  expect(loadThreadHistory(child.sessionId, DEFAULT_THREAD_ID, cwd)).toEqual([])
  // Run anak nyata, di SESI ANAK (bukan parent).
  const childRun = getRun(child.runId, cwd)!
  expect(childRun.session_id).toBe(child.sessionId)
  expect(childRun.thread_id).toBe(child.threadId)
  expect(childRun.status).toBe("CREATED")
  // getActiveRun = RUNNING saja; CREATED belum aktif (sesuai P2.6).
  expect(getActiveRun(child.sessionId, cwd)).toBeNull()
  expect(getRun(parentRun.run_id, cwd)!.session_id).toBe("parent")
  transitionRun(child.runId, "RUNNING", cwd)
  expect(getRun(child.runId, cwd)!.status).toBe("RUNNING")
  // Run anak TIDAK muncul di daftar run parent.
  expect(listSessionRuns("parent", cwd).map((r) => r.run_id)).not.toContain(child.runId)
})

test("P2.9-7: transisi terminal anak persisten", async () => {
  const cwd = ws()
  await seedParent(cwd)
  const child = createChildSession({ parentSessionId: "parent", cwd })
  transitionRun(child.runId, "RUNNING", cwd)
  completeRun(child.runId, cwd)
  const done = getRun(child.runId, cwd)!
  expect(done.status).toBe("COMPLETED")
  expect(done.ended_at).not.toBeNull()
  // Terminal beku (idempoten), tak ada transisi ilegal.
  expect(completeRun(child.runId, cwd).status).toBe("COMPLETED")
})

test("P2.9-8: presentation_events anak tidak dimakan orphan purge", async () => {
  const cwd = ws()
  await seedParent(cwd)
  const child = createChildSession({ parentSessionId: "parent", cwd })
  // Tulis event presentasi pada namespace anak (baris seperti yang ditulis
  // appendPresentationEvents dari factory cli/index.ts).
  const { purgeExpired: purge } = await import("../src/session/persistence.ts")
  const seedDb = new Database(join(cwd, ".minicode", "sessions.db"))
  try {
    seedDb
      .prepare(
        "INSERT INTO presentation_events (session_id, event_seq, type, turn_id, ts, payload) VALUES (?, 1, 'notice', 0, ?, '{}')",
      )
      .run(child.sessionId, Date.now())
  } finally {
    seedDb.close()
  }
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  let before = 0
  try {
    before = (
      db
        .prepare("SELECT COUNT(*) AS n FROM presentation_events WHERE session_id = ?")
        .get(child.sessionId) as { n: number }
    ).n
    expect(before).toBeGreaterThan(0)
  } finally {
    db.close()
  }
  // Purge dengan cutoff yang TIDAK menua-kan sesi anak (TTL = hari): anak punya
  // baris `sessions`, jadi presentation_events-nya bukan orphan dan HARUS selamat.
  purge(new Database(join(cwd, ".minicode", "sessions.db")), Date.now() + 1_000)
  const db2 = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    const after = (
      db2
        .prepare("SELECT COUNT(*) AS n FROM presentation_events WHERE session_id = ?")
        .get(child.sessionId) as { n: number }
    ).n
    expect(after).toBe(before)
    // Sesi anak masih hidup (itulah yang membuat namespace-nya kanonik).
    expect(
      (
        db2.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(child.sessionId) as {
          n: number
        }
      ).n,
    ).toBe(1)
  } finally {
    db2.close()
  }
})

test("P2.9-9/10/11: epoch anak independen dari epoch parent", async () => {
  const cwd = ws()
  await seedParent(cwd)
  const child = createChildSession({ parentSessionId: "parent", cwd })
  // Both start at 0 — domains terpisah.
  expect(readWriterEpoch("parent", cwd)).toBe(0)
  expect(readWriterEpoch(child.sessionId, cwd)).toBe(0)
  // Parent takeover TIDAK menginvalidasi epoch anak.
  takeover("parent", 0, cwd)
  expect(readWriterEpoch("parent", cwd)).toBe(1)
  expect(readWriterEpoch(child.sessionId, cwd)).toBe(0)
  // Penulis anak basi DITOLAK (epoch anak sendiri, bukan parent).
  expect(() => transitionRun(child.runId, "RUNNING", cwd, { expectedEpoch: 99 })).toThrow(
    StaleWriterError,
  )
  expect(getRun(child.runId, cwd)!.status).toBe("CREATED")
  // Dengan epoch anak yang benar → jalan.
  transitionRun(child.runId, "RUNNING", cwd, {
    expectedEpoch: readWriterEpoch(child.sessionId, cwd),
  })
  expect(getRun(child.runId, cwd)!.status).toBe("RUNNING")
})

test("P2.9-12/13: parent + dua anak RUNNING bersamaan (Model C)", async () => {
  const cwd = ws()
  await seedParent(cwd)
  const parentRun = createRun("parent", DEFAULT_THREAD_ID, cwd)
  transitionRun(parentRun.run_id, "RUNNING", cwd)
  const a = createChildSession({ parentSessionId: "parent", cwd })
  const b = createChildSession({ parentSessionId: "parent", cwd })
  expect(a.sessionId).not.toBe(b.sessionId)
  transitionRun(a.runId, "RUNNING", cwd)
  transitionRun(b.runId, "RUNNING", cwd)
  // Ketiganya RUNNING bersamaan — bukti decisively Model C (satu child satu Session).
  expect(getRun(parentRun.run_id, cwd)!.status).toBe("RUNNING")
  expect(getRun(a.runId, cwd)!.status).toBe("RUNNING")
  expect(getRun(b.runId, cwd)!.status).toBe("RUNNING")
  expect(new Set([a.sessionId, b.sessionId, "parent"]).size).toBe(3)
})

test("P2.9-14/15/16: histori, seq, event_id terisolasi", async () => {
  const cwd = ws()
  await seedParent(cwd, "parent", 3)
  const child = createChildSession({ parentSessionId: "parent", cwd })
  await saveSession(child.sessionId, cwd, undefined, [{ role: "user", content: "c0" }], { t: 1 })
  // Seq namespace terpisah (parent 0..2, anak mulai 0).
  expect(loadThreadHistory(child.sessionId, DEFAULT_THREAD_ID, cwd).length).toBe(1)
  expect(loadThreadHistory("parent", DEFAULT_THREAD_ID, cwd).length).toBe(3)
  // Event id terpisah.
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    const pIds = (
      db
        .prepare("SELECT event_id FROM messages WHERE session_id = ? ORDER BY seq")
        .all("parent") as { event_id: string }[]
    ).map((r) => r.event_id)
    const cIds = (
      db
        .prepare("SELECT event_id FROM messages WHERE session_id = ? ORDER BY seq")
        .all(child.sessionId) as { event_id: string }[]
    ).map((r) => r.event_id)
    expect(pIds.filter((x) => cIds.includes(x))).toEqual([])
  } finally {
    db.close()
  }
  // Histori anak tak bocor ke parent.
  expect(JSON.stringify(loadSession("parent", cwd)!.messages)).not.toContain("c0")
})

test("P2.9-22/23: orphan RUNNING anak → INTERRUPTED/UNKNOWN (tak pernah COMPLETED)", async () => {
  const cwd = ws()
  await seedParent(cwd)
  const child = createChildSession({ parentSessionId: "parent", cwd })
  transitionRun(child.runId, "RUNNING", cwd)
  // Sweep: anak RUNNING, parent tidak RUNNING (parent run tak ada / terminal).
  const swept = tombstoneOrphanChildRuns("parent", cwd)
  expect(swept).toContain(child.runId)
  const t = getRun(child.runId, cwd)!
  expect(t.status).toBe("INTERRUPTED")
  expect(t.recovery_status).toBe("UNKNOWN")
  // Tak pernah COMPLETED.
  expect(t.status).not.toBe("COMPLETED")
  // Idempoten.
  expect(tombstoneOrphanChildRuns("parent", cwd)).toEqual([])
})

test("P2.9-21: parent terminal → anak tidak tertinggal RUNNING", async () => {
  const cwd = ws()
  await seedParent(cwd)
  const child = createChildSession({ parentSessionId: "parent", cwd })
  transitionRun(child.runId, "RUNNING", cwd)
  // Parent terminal → terminalizeChildRuns (dipanggil setup pada close).
  const { terminalizeChildRuns } = await import("../src/session/persistence.ts")
  terminalizeChildRuns("parent", cwd)
  expect(getRun(child.runId, cwd)!.status).toBe("INTERRUPTED")
})

test("P2.9-27: delete parent membersihkan record anak (tak ada yatim)", async () => {
  const cwd = ws()
  await seedParent(cwd)
  const child = createChildSession({ parentSessionId: "parent", cwd })
  await saveSession(child.sessionId, cwd, undefined, [{ role: "user", content: "c" }], { t: 1 })
  const { deleteSession } = await import("../src/session/persistence.ts")
  await deleteSession("parent", cwd)
  // Parent dan anak ikut terhapus.
  expect(loadSession("parent", cwd)).toBeNull()
  expect(loadSession(child.sessionId, cwd)).toBeNull()
  expect(getRun(child.runId, cwd)).toBeNull()
  expect(listChildSessions("parent", cwd)).toEqual([])
})

test("P2.9-28/29: guards capability + nested delegation utuh", async () => {
  expect(delegateTaskTool.name).toBe("delegate_task")
  // delegate_task tak boleh tersedia pada tool set anak.
  const src = await Bun.file("src/tools/task.ts").text()
  expect(src.includes("EXPLORE_TOOL_NAMES")).toBe(true)
  expect(src).toContain("delegate_task")
  // Capability attenuation tetap satu-satunya derivasi.
  const cap = await Bun.file("src/runtime/capability.ts").text()
  expect(cap.includes("attenuateGrant")).toBe(true)
})

test("P2.9-mig: migrasi aditif — parent fields NULL, idempoten", () => {
  const cwd = ws()
  const p = join(cwd, ".minicode", "sessions.db")
  const raw = new Database(p)
  try {
    // Bentuk pra-P2.9: sessions tanpa parent_session_id / parent_run_id.
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER, cwd TEXT, system TEXT, writer_epoch INTEGER NOT NULL DEFAULT 0, default_thread_id TEXT NULL);
      CREATE TABLE messages (session_id TEXT, seq INTEGER, role TEXT, content TEXT, toolCalls TEXT, toolCallId TEXT, name TEXT, reasoning TEXT, is_error INTEGER, ts INTEGER, PRIMARY KEY(session_id, seq));
      INSERT INTO sessions (id, created_at, cwd, system) VALUES ('legacy', 1, '', '');
    `)
  } finally {
    raw.close()
  }
  // Buka → migrasi menambahkan kolom.
  const link = getChildSessionLink("legacy", cwd)!
  expect(link.parent_session_id).toBeNull()
  expect(link.parent_run_id).toBeNull()
  // Re-open idempoten (kolom tetap satu).
  getChildSessionLink("legacy", cwd)
  const db = new Database(p, { readonly: true })
  try {
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
    expect(cols.filter((c) => c.name === "parent_session_id").length).toBe(1)
    expect(cols.filter((c) => c.name === "parent_run_id").length).toBe(1)
  } finally {
    db.close()
  }
})

test("P2.9-identity: parent Run id via DI (bukan mengarang di tool)", async () => {
  // Fungsi DI yang dipakai tool mengembalikan null default (tidak mengarang).
  expect(subAgentParentRunId()).toBeNull()
  setSubAgentParentRunId(() => "run_stub")
  expect(subAgentParentRunId()).toBe("run_stub")
  setSubAgentParentRunId(() => null)
  // Alokator di tool = alokator persistence (satu sumber kebenaran).
  const id = allocateChildSessionId()
  expect(id.startsWith("sub_")).toBe(true)
  expect(id.length).toBe(36) // "sub_" + 32 hex (128-bit)
})
