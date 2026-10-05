// P2.4 — Aktivasi Thread + default Thread (runtime SEMANTICS, bukan skema).
//
// Membuktikan: sesi baru/threadless mendapat th_default atomik; histori
// legacy byte-identik pasca-backfill; isolasi (session,thread,seq); pagar
// epoch; head cache; archive/parent rules; tanpa traversal/merge.

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  archiveThread,
  branchSession,
  createThread,
  DEFAULT_THREAD_ID,
  ensureDefaultThread,
  getDefaultThread,
  getThread,
  loadSession,
  loadThreadHistory,
  readWriterEpoch,
  StaleWriterError,
  saveSession,
  ThreadArchivedError,
  ThreadParentError,
  takeoverSessionEpoch,
} from "../src/session/persistence.ts"

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p24-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function dbPath(cwd: string): string {
  return join(cwd, ".minicode", "sessions.db")
}

function histHash(cwd: string, sid: string): string {
  const loaded = loadSession(sid, cwd)!
  return JSON.stringify(loaded.messages)
}

test("P2.4: sesi baru mendapat default Thread atomik; save kedua tak duplikat", async () => {
  const cwd = ws()
  expect(getDefaultThread("n", cwd)).toBeNull()
  await saveSession("n", cwd, undefined, [{ role: "user", content: "h" }], { t: 1 })
  const t = getDefaultThread("n", cwd)!
  expect(t.thread_id).toBe(DEFAULT_THREAD_ID)
  expect(t.session_id).toBe("n")
  expect(t.status).toBe("active")
  expect(t.read_only).toBe(0)
  expect(t.head_seq).toBe(0)
  await saveSession(
    "n",
    cwd,
    undefined,
    [
      { role: "user", content: "h" },
      { role: "assistant", content: "j" },
    ],
    { t: 2 },
  )
  const db = new Database(dbPath(cwd), { readonly: true })
  try {
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM threads WHERE session_id = ?").get("n") as {
        n: number
      }
    ).n
    expect(n).toBe(1)
  } finally {
    db.close()
  }
  expect(getDefaultThread("n", cwd)!.head_seq).toBe(1)
})

test("P2.4: legacy NULL di-backfill aditif; hash histori identik; idempoten", async () => {
  const cwd = ws()
  const p = dbPath(cwd)
  const raw = new Database(p)
  try {
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER, cwd TEXT, system TEXT);
      CREATE TABLE messages (session_id TEXT, seq INTEGER, role TEXT, content TEXT, toolCalls TEXT, toolCallId TEXT, name TEXT, ts INTEGER, PRIMARY KEY(session_id, seq));
    `)
    const now = Date.now()
    raw
      .prepare("INSERT INTO sessions (id, created_at, cwd, system) VALUES (?, ?, ?, ?)")
      .run("w", now, cwd, "")
    raw
      .prepare("INSERT INTO messages (session_id, seq, role, content, ts) VALUES (?, ?, ?, ?, ?)")
      .run("w", 0, "user", JSON.stringify("satu"), now)
    raw
      .prepare("INSERT INTO messages (session_id, seq, role, content, ts) VALUES (?, ?, ?, ?, ?)")
      .run("w", 1, "assistant", JSON.stringify("dua"), now)
  } finally {
    raw.close()
  }
  const before = histHash(cwd, "w")
  const t1 = ensureDefaultThread("w", cwd)
  expect(t1.thread_id).toBe(DEFAULT_THREAD_ID)
  expect(t1.head_seq).toBe(1)
  expect(histHash(cwd, "w")).toBe(before)
  const t2 = ensureDefaultThread("w", cwd)
  expect(t2.thread_id).toBe(t1.thread_id)
  expect(histHash(cwd, "w")).toBe(before)
  // Thread kosong: head -1.
  await saveSession("k", cwd, undefined, [], undefined)
  expect(getDefaultThread("k", cwd)!.head_seq).toBe(-1)
})

test("P2.4: isolasi — seq sama beda (sesi,thread) koeksis; duplikat ditolak", async () => {
  const cwd = ws()
  await saveSession("s1", cwd, undefined, [{ role: "user", content: "a" }], { t: 1 })
  await saveSession("s2", cwd, undefined, [{ role: "user", content: "b" }], { t: 1 })
  // (s1,th_default,0) vs (s2,th_default,0): tanpa tabrakan.
  expect(loadThreadHistory("s1", DEFAULT_THREAD_ID, cwd).length).toBe(1)
  expect(loadThreadHistory("s2", DEFAULT_THREAD_ID, cwd).length).toBe(1)
  // Duplikat (sesi,thread,seq) identik → UNIQUE menolak (bukti level-DB).
  const db = new Database(dbPath(cwd))
  try {
    expect(() =>
      db
        .prepare(
          "INSERT INTO messages (session_id, thread_id, seq, role, content, ts) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("s1", DEFAULT_THREAD_ID, 0, "user", '"x"', 0),
    ).toThrow()
  } finally {
    db.close()
  }
  // Branch: dst membawa seq sama di bawah identitas kompositnya sendiri.
  await branchSession("s1", "s1c", cwd)
  expect(loadThreadHistory("s1c", DEFAULT_THREAD_ID, cwd).length).toBe(1)
  expect(loadThreadHistory("s1", DEFAULT_THREAD_ID, cwd).length).toBe(1)
})

test("P2.4: pagar epoch — stale tak bisa ensure/create; kini bisa", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [], undefined)
  expect(takeoverSessionEpoch("s", 0, "uji", "bootB", cwd).outcome).toBe("advanced")
  expect(readWriterEpoch("s", cwd)).toBe(1)
  expect(() => ensureDefaultThread("s", cwd, { expectedEpoch: 0 })).toThrow(StaleWriterError)
  expect(() => createThread("s", cwd, { expectedEpoch: 0 })).toThrow(StaleWriterError)
  const t = ensureDefaultThread("s", cwd, { expectedEpoch: 1 })
  expect(t.thread_id).toBe(DEFAULT_THREAD_ID)
  const c = createThread("s", cwd, { expectedEpoch: 1 })
  expect(c.head_seq).toBe(-1)
  expect(c.status).toBe("active")
})

test("P2.4: head = MAX(seq); cache dapat dihitung ulang", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [{ role: "user", content: "a" }], { t: 1 })
  await saveSession(
    "s",
    cwd,
    undefined,
    [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ],
    { t: 2 },
  )
  expect(getDefaultThread("s", cwd)!.head_seq).toBe(2)
  const db = new Database(dbPath(cwd), { readonly: true })
  try {
    const m = (
      db
        .prepare("SELECT MAX(seq) AS m FROM messages WHERE session_id = ? AND thread_id = ?")
        .get("s", DEFAULT_THREAD_ID) as { m: number }
    ).m
    expect(m).toBe(getDefaultThread("s", cwd)!.head_seq)
  } finally {
    db.close()
  }
})

test("P2.4: archive — tetap terbaca, menolak tulis baru", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [{ role: "user", content: "h" }], { t: 1 })
  const archived = archiveThread("s", DEFAULT_THREAD_ID, cwd)
  expect(archived.status).toBe("archived")
  expect(loadThreadHistory("s", DEFAULT_THREAD_ID, cwd).length).toBe(1)
  await expect(
    saveSession(
      "s",
      cwd,
      undefined,
      [
        { role: "user", content: "h" },
        { role: "user", content: "x" },
      ],
      {
        t: 2,
      },
    ),
  ).rejects.toThrow(ThreadArchivedError)
  expect(loadThreadHistory("s", DEFAULT_THREAD_ID, cwd).length).toBe(1)
})

test("P2.4: parent rules — invalid/read-only/fork-seq ditolak; child tanpa copy", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [{ role: "user", content: "h" }], { t: 1 })
  expect(() => createThread("s", cwd, { parentThreadId: "tak-ada" })).toThrow(ThreadParentError)
  expect(() =>
    createThread("s", cwd, { parentThreadId: DEFAULT_THREAD_ID, forkEventSeq: 99 }),
  ).toThrow(ThreadParentError)
  // Fixture lineage read-only (bentuk migrasi P2.12): tak bisa jadi induk.
  const db = new Database(dbPath(cwd))
  try {
    db.prepare(
      "INSERT INTO threads (session_id, thread_id, parent_thread_id, fork_event_seq, head_seq, status, read_only, created_at) VALUES (?, ?, NULL, NULL, 0, 'active', 1, ?)",
    ).run("s", "thread_migr_x", Date.now())
  } finally {
    db.close()
  }
  expect(() => createThread("s", cwd, { parentThreadId: "thread_migr_x" })).toThrow(
    ThreadParentError,
  )
  // Child valid: pointer tersimpan, histori sendiri kosong, induk utuh,
  // TANPA traversal (baca child ≠ baca induk).
  const child = createThread("s", cwd, { parentThreadId: DEFAULT_THREAD_ID, forkEventSeq: 0 })
  expect(child.parent_thread_id).toBe(DEFAULT_THREAD_ID)
  expect(child.fork_event_seq).toBe(0)
  expect(loadThreadHistory("s", child.thread_id, cwd)).toEqual([])
  expect(loadThreadHistory("s", DEFAULT_THREAD_ID, cwd).length).toBe(1)
  expect(getThread("s", DEFAULT_THREAD_ID, cwd)!.head_seq).toBe(0)
})

test("P2.4: ensure konkuren — tepat satu default (tanpa sleep)", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [{ role: "user", content: "h" }], { t: 1 })
  // Hapus baris thread untuk mensimulasikan sesi threadless (bukan API publik).
  const db = new Database(dbPath(cwd))
  try {
    db.prepare("DELETE FROM threads WHERE session_id = ?").run("s")
    db.prepare("UPDATE sessions SET default_thread_id = NULL WHERE id = ?").run("s")
    db.prepare("UPDATE messages SET thread_id = NULL WHERE session_id = ?").run("s")
  } finally {
    db.close()
  }
  expect(getDefaultThread("s", cwd)).toBeNull()
  const [a, b] = await Promise.all([ensureDefaultThread("s", cwd), ensureDefaultThread("s", cwd)])
  expect(a.thread_id).toBe(b.thread_id)
  const db2 = new Database(dbPath(cwd), { readonly: true })
  try {
    const n = (
      db2.prepare("SELECT COUNT(*) AS n FROM threads WHERE session_id = ?").get("s") as {
        n: number
      }
    ).n
    expect(n).toBe(1)
  } finally {
    db2.close()
  }
  expect(histHash(cwd, "s")).toContain("h")
})
