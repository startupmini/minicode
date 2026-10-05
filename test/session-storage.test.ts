// P2.3 — Kerangka penyimpanan (STORAGE ONLY, tanpa semantik aktif).
//
// Membuktikan: tabel threads/runs/history_projections + kolom dorman ada,
// migrasi idempoten + non-destruktif, epoch/identitas/pesan/task utuh, dan
// runtime TAK mematerialisasi baris Thread/Run (netralitas perilaku).

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  branchSession,
  DEFAULT_THREAD_ID,
  deleteSession,
  listSessionTakeovers,
  loadSession,
  readWriterEpoch,
  saveSession,
  shrinkThreadHistory,
  takeoverSessionEpoch,
} from "../src/session/persistence.ts"
import { TaskStore } from "../src/task/store.ts"

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p23-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function dbPath(cwd: string): string {
  return join(cwd, ".minicode", "sessions.db")
}

function columns(cwd: string, table: string): string[] {
  const db = new Database(dbPath(cwd), { readonly: true })
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    )
  } finally {
    db.close()
  }
}

function indexes(cwd: string): string[] {
  const db = new Database(dbPath(cwd), { readonly: true })
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name)
  } finally {
    db.close()
  }
}

function count(cwd: string, table: string): number {
  const db = new Database(dbPath(cwd), { readonly: true })
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  } finally {
    db.close()
  }
}

test("P2.3: tabel threads/runs/history_projections ada dengan kolom minimum", async () => {
  const cwd = ws()
  await saveSession("probe", cwd, undefined, [], undefined)
  for (const col of [
    "thread_id",
    "session_id",
    "parent_thread_id",
    "fork_event_seq",
    "head_seq",
    "status",
    "read_only",
    "created_at",
  ]) {
    expect(columns(cwd, "threads")).toContain(col)
  }
  for (const col of [
    "run_id",
    "session_id",
    "thread_id",
    "status",
    "started_at",
    "ended_at",
    "last_persisted_seq",
    "pending_tool_ids",
    "recovery_status",
    "created_at",
  ]) {
    expect(columns(cwd, "runs")).toContain(col)
  }
  for (const col of [
    "thread_id",
    "projection_id",
    "base_seq",
    "summary_text",
    "included_ranges",
    "built_at",
  ]) {
    expect(columns(cwd, "history_projections")).toContain(col)
  }
  const idx = indexes(cwd)
  // P2.4: idx_messages_thread diganti udx_messages_thread_seq (UNIQUE
  // komposit) — perubahan reviewed, bukan drift.
  for (const name of [
    "idx_threads_session",
    "idx_runs_session",
    "idx_runs_thread",
    "idx_projections_thread",
    "udx_messages_thread_seq",
    "idx_messages_run",
  ]) {
    expect(idx).toContain(name)
  }
  expect(idx).not.toContain("idx_messages_thread")
})

test("P2.3: kolom dorman messages + default_thread_id sessions ada, default aman", async () => {
  const cwd = ws()
  await saveSession("probe", cwd, undefined, [{ role: "user", content: "h" }], { t: 1 })
  for (const col of [
    "thread_id",
    "event_id",
    "run_id",
    "migrated",
    "migrated_compacted",
    "projection_note",
  ]) {
    expect(columns(cwd, "messages")).toContain(col)
  }
  expect(columns(cwd, "sessions")).toContain("default_thread_id")
  expect(columns(cwd, "sessions")).toContain("writer_epoch")
  // Default dorman di level DDL: NULL/0 — legacy tak-berskala, bukan klaim
  // keanggotaan. (P2.4: baris yang ditulis saveSession membawa th_default;
  // P2.5: baris yang ditulis saveSession membawa event_id alokasi. NULL
  // hanya untuk baris pra-backfill / mentah.)
  const db = new Database(dbPath(cwd), { readonly: true })
  try {
    const row = db
      .prepare(
        "SELECT thread_id, event_id, run_id, migrated, migrated_compacted, projection_note FROM messages LIMIT 1",
      )
      .get() as Record<string, unknown>
    expect(row.thread_id).toBe("th_default")
    expect(row.event_id).toMatch(/^evt_[0-9a-f-]{36}$/)
    expect(row.run_id).toBeNull()
    expect(row.migrated).toBe(0)
    expect(row.migrated_compacted).toBe(0)
    expect(row.projection_note).toBeNull()
    const s = db.prepare("SELECT default_thread_id, writer_epoch FROM sessions LIMIT 1").get() as {
      default_thread_id: unknown
      writer_epoch: unknown
    }
    // P2.4: saveSession mengikat default_thread_id (bukan NULL lagi).
    expect(s.default_thread_id).toBe("th_default")
    expect(s.writer_epoch).toBe(0)
  } finally {
    db.close()
  }
})

test("P2.3: DB legacy (skema lama hand-rolled) migrasi non-destruktif + idempoten", async () => {
  const cwd = ws()
  const p = dbPath(cwd)
  const raw = new Database(p)
  try {
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER, cwd TEXT, system TEXT);
      CREATE TABLE messages (session_id TEXT, seq INTEGER, role TEXT, content TEXT, toolCalls TEXT, toolCallId TEXT, name TEXT, ts INTEGER, PRIMARY KEY(session_id, seq));
      CREATE TABLE turns (session_id TEXT, turn_idx INTEGER, usage TEXT, ts INTEGER, PRIMARY KEY(session_id, turn_idx));
      CREATE TABLE presentation_events (session_id TEXT NOT NULL, event_seq INTEGER NOT NULL, type TEXT NOT NULL, turn_id INTEGER NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id, event_seq));
    `)
    const now = Date.now()
    raw
      .prepare("INSERT INTO sessions (id, created_at, cwd, system) VALUES (?, ?, ?, ?)")
      .run("warisan", now, cwd, "sys")
    raw
      .prepare("INSERT INTO messages (session_id, seq, role, content) VALUES (?, ?, ?, ?)")
      .run("warisan", 0, "user", JSON.stringify("halo lama"))
  } finally {
    raw.close()
  }
  const before = loadSession("warisan", cwd)
  expect(before!.messages.length).toBe(1)
  // Migrasi via open(): kolom + tabel muncul, data utuh, epoch 0.
  // P2.7: saveSession append-only — re-save dengan payload legacy yang
  // menormalisasi (toolCalls NULL mentah → "null") kini DITOLAK eksplisit;
  // jalur eksplisit shrinkThreadHistory yang dipakai di sini.
  shrinkThreadHistory("warisan", DEFAULT_THREAD_ID, [{ role: "user", content: "halo lama" }], cwd, {
    expectedEpoch: 0,
  })
  expect(columns(cwd, "messages")).toContain("thread_id")
  expect(columns(cwd, "sessions")).toContain("default_thread_id")
  expect(readWriterEpoch("warisan", cwd)).toBe(0)
  const after = loadSession("warisan", cwd)!
  expect(after.messages.length).toBe(1)
  expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  // Migrasi dua kali: skema + data stabil (idempoten).
  const sig = (dbPath: string): string => {
    const db = new Database(dbPath, { readonly: true })
    try {
      return JSON.stringify(
        (
          db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all() as unknown[]
        ).map((r) => r),
      )
    } finally {
      db.close()
    }
  }
  const sig1 = sig(p)
  await saveSession("warisan", cwd, "sys", [{ role: "user", content: "halo lama" }], undefined)
  expect(sig(p)).toBe(sig1)
  expect(loadSession("warisan", cwd)!.messages.length).toBe(1)
})

test("P2.3: migrasi mempertahankan epoch + identitas + alias", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [{ role: "user", content: "h" }], { t: 1 })
  expect(takeoverSessionEpoch("s", 0, "uji", "bootB", cwd).outcome).toBe("advanced")
  const { tryRecordSessionAlias } = await import("../src/session/persistence.ts")
  expect(tryRecordSessionAlias("sebutan", "sebutan", "s", "uji", cwd)).toEqual({
    ok: true,
    created: true,
  })
  // Operasi pasca-migrasi (open ulang implisit tiap call): semua utuh.
  expect(readWriterEpoch("s", cwd)).toBe(1)
  expect(listSessionTakeovers("s", cwd).length).toBe(1)
  const { lookupSessionAlias } = await import("../src/session/persistence.ts")
  expect(lookupSessionAlias("sebutan", cwd)?.canonical).toBe("s")
  expect(loadSession("s", cwd)!.messages.length).toBe(1)
})

test("P2.3: netralitas runtime — operasi existing tak mematerialisasi Thread/Run", async () => {
  const cwd = ws()
  await saveSession("a", cwd, undefined, [{ role: "user", content: "h" }], { t: 1 })
  await saveSession("a", cwd, undefined, [{ role: "user", content: "h" }], { t: 1 })
  await branchSession("a", "b", cwd)
  await deleteSession("b", cwd)
  // P2.4 MENGAKTIFKAN materialisasi default Thread (satu per sesi — kontrak,
  // bukan "diam-diam"); runs/projections TETAP nol (P2.5/2.7).
  expect(count(cwd, "threads")).toBe(1)
  expect(count(cwd, "runs")).toBe(0)
  expect(count(cwd, "history_projections")).toBe(0)
  // Perilaku baca tulis tak berubah: roundtrip identik.
  expect(loadSession("a", cwd)!.messages.length).toBe(1)
})

test("P2.3: tasks.db tak tersentuh skema sesi", async () => {
  const cwd = ws()
  const store = new TaskStore(cwd)
  store.createTask("s", {
    title: "t",
    status: "PENDING",
    order: 1,
    provenance: { origin: "model", source: "p23" },
  } as never)
  await saveSession("s", cwd, undefined, [{ role: "user", content: "h" }], { t: 1 })
  expect(store.listTasks("s").length).toBe(1)
  expect(store.getSessionIncarnation("s")).toBe(1)
})
