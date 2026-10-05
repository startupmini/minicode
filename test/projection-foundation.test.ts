// P2.7 — Projection Foundation (produksi).
//
// Membuktikan: identitas "summary" tetap, base_seq eksklusif, ranges kanonik,
// validitas lima-status deterministik, jangkar EventId, build/rebuild atomik
// berpagar epoch, isolasi Thread, netralitas Run, penghapusan rewrite implisit,
// kebijakan shrink-live-run, provenance, dan migrasi anchor_event_id.

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireSessionWriter } from "../src/session/authority.ts"
import {
  appendHistoryEvent,
  backfillHistoryEventIds,
  buildProjection,
  completeRun,
  createRun,
  createThread,
  DEFAULT_THREAD_ID,
  getProjection,
  getProjectionStatus,
  getThreadHead,
  loadSession,
  loadThreadHistory,
  ProjectionValidationError,
  RefusedHistoryRewriteError,
  RefusedShrinkLiveRunError,
  rebuildProjection,
  StaleWriterError,
  SUMMARY_PROJECTION_ID,
  saveSession,
  shrinkThreadHistory,
  transitionRun,
} from "../src/session/persistence.ts"

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p27-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

async function seed(cwd: string, sid: string, n = 4): Promise<void> {
  const msgs = Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `m${i}`,
  }))
  await saveSession(sid, cwd, undefined, msgs, { t: 1 })
}

function hashMessages(cwd: string, sid: string): string {
  return JSON.stringify(loadSession(sid, cwd)!.messages)
}

const T0 = 1_700_000_000_000
const LEASE = 300_000

test("P2.7-1: projection create/read round-trip", async () => {
  const cwd = ws()
  await seed(cwd, "s", 4)
  const built = buildProjection("s", DEFAULT_THREAD_ID, "ringkasan 0-3", cwd, {
    expectedEpoch: 0,
  })
  expect(built.projection_id).toBe(SUMMARY_PROJECTION_ID)
  expect(built.base_seq).toBe(4)
  expect(built.included_ranges).toBe("[[0,4]]")
  expect(built.anchor_event_id).not.toBeNull()
  const read = getProjection("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)!
  expect(read).toEqual(built)
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "CURRENT",
  )
  // ID asing gagal loud (fail-closed, tanpa spekulasi jenis).
  expect(() => getProjection("s", DEFAULT_THREAD_ID, "bogus", cwd)).toThrow(
    ProjectionValidationError,
  )
  expect(() =>
    buildProjection("s", DEFAULT_THREAD_ID, "x", cwd, {
      expectedEpoch: 0,
      projectionId: "bogus",
    }),
  ).toThrow(ProjectionValidationError)
})

test("P2.7-2: projection_id sama di dua Thread = independen", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  createThread("s", cwd, { threadId: "th_kedua" })
  const a = buildProjection("s", DEFAULT_THREAD_ID, "ringkas-A", cwd, { expectedEpoch: 0 })
  const b = buildProjection("s", "th_kedua", "", cwd, { expectedEpoch: 0 })
  expect(b.base_seq).toBe(0)
  expect(b.included_ranges).toBe("[]")
  // Catatan: build thread kosong menuntut summary "" (emisi kanonik).
  expect(a.summary_text).toBe("ringkas-A")
  expect(getProjection("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)!.summary_text).toBe(
    "ringkas-A",
  )
  expect(getProjection("s", "th_kedua", SUMMARY_PROJECTION_ID, cwd)!.summary_text).toBe("")
  expect(a.base_seq).toBe(3)
})

test("P2.7-3: base_seq eksklusif + batas", async () => {
  const cwd = ws()
  await seed(cwd, "s", 10)
  // Default = liput semua: head 9 → base 10.
  expect(buildProjection("s", DEFAULT_THREAD_ID, "semua", cwd, { expectedEpoch: 0 }).base_seq).toBe(
    10,
  )
  // Parsial [0..4] → base 5 (baris 5 tak-tercakup → langsung STALE, jujur).
  const partial = buildProjection("s", DEFAULT_THREAD_ID, "parsial", cwd, {
    expectedEpoch: 0,
    baseSeq: 5,
  })
  expect(partial.base_seq).toBe(5)
  expect(partial.included_ranges).toBe("[[0,5]]")
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "STALE",
  )
  // Kosong vakum: base 0 + summary "" → CURRENT.
  const empty = buildProjection("s", DEFAULT_THREAD_ID, "", cwd, {
    expectedEpoch: 0,
    baseSeq: 0,
  })
  expect(empty.base_seq).toBe(0)
  // Di luar [0, head+1] ditolak penulis (bukan klaim mustahil).
  expect(() =>
    buildProjection("s", DEFAULT_THREAD_ID, "x", cwd, { expectedEpoch: 0, baseSeq: 11 }),
  ).toThrow(ProjectionValidationError)
  expect(() =>
    buildProjection("s", DEFAULT_THREAD_ID, "x", cwd, { expectedEpoch: 0, baseSeq: -1 }),
  ).toThrow(ProjectionValidationError)
  // Emisi kanonik ditegakkan: cakupan kosong ⟺ ringkasan kosong.
  expect(() =>
    buildProjection("s", DEFAULT_THREAD_ID, "isi", cwd, { expectedEpoch: 0, baseSeq: 0 }),
  ).toThrow(ProjectionValidationError)
})

test("P2.7-4: ranges kanal deterministik", async () => {
  const cwd = ws()
  await seed(cwd, "s", 4)
  const built = buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  // Byte-deterministik: bandingkan string, bukan struktur.
  expect(built.included_ranges).toBe("[[0,4]]")
  expect(JSON.parse(built.included_ranges)).toEqual([[0, 4]])
})

test("P2.7-5: CURRENT saat cakupan = head + jangkar cocok", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  buildProjection("s", DEFAULT_THREAD_ID, "ok", cwd, { expectedEpoch: 0 })
  const st = getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)
  expect(st.state).toBe("CURRENT")
})

test("P2.7-6: STALE saat head maju", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  buildProjection("s", DEFAULT_THREAD_ID, "ok", cwd, { expectedEpoch: 0 })
  appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "baru" }, cwd)
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "STALE",
  )
})

test("P2.7-7: STALE saat event batas berubah identitas", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  buildProjection("s", DEFAULT_THREAD_ID, "ok", cwd, { expectedEpoch: 0 })
  // Ancaman N→N: baris batas diganti identitas TANPA jalur shrink berpagar
  // (simulasi tulisan luar-kontrak via SQL mentah — persis yang harus
  // ditangkap jangkar, bukan dipercaya buta).
  const db = new Database(join(cwd, ".minicode", "sessions.db"))
  try {
    db.prepare("UPDATE messages SET event_id = ? WHERE session_id = ? AND seq = 2").run(
      "evt_asing",
      "s",
    )
  } finally {
    db.close()
  }
  // Kepala sama (2), tapi jangkar event_id tak cocok → STALE, bukan CURRENT.
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "STALE",
  )
})

function handRow(
  cwd: string,
  overrides: Partial<{
    base_seq: number
    summary_text: string
    included_ranges: string
    anchor_event_id: string | null
  }>,
): void {
  const db = new Database(join(cwd, ".minicode", "sessions.db"))
  try {
    db.prepare(
      "INSERT OR REPLACE INTO history_projections (session_id, thread_id, projection_id, base_seq, summary_text, included_ranges, built_at, anchor_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "s",
      DEFAULT_THREAD_ID,
      SUMMARY_PROJECTION_ID,
      overrides.base_seq ?? 2,
      overrides.summary_text ?? "tangan",
      overrides.included_ranges ?? "[[0,2]]",
      1,
      overrides.anchor_event_id === undefined ? "evt_tangan" : overrides.anchor_event_id,
    )
  } finally {
    db.close()
  }
}

test("P2.7-8: CORRUPT untuk ranges malformed", async () => {
  const cwd = ws()
  await seed(cwd, "s", 4)
  for (const bad of ["{oops", "[0,5]", "[[0,5],[4,7]]", "[[5,3]]", "[[-1,2]]", "[[0,2],[2,4]]"]) {
    handRow(cwd, { included_ranges: bad })
    expect(
      getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd),
      `ranges ${bad}`,
    ).toEqual({ state: "CORRUPT", detail: expect.any(String) })
  }
})

test("P2.7-9: CORRUPT untuk base_seq di luar kemungkinan", async () => {
  const cwd = ws()
  await seed(cwd, "s", 4)
  handRow(cwd, { base_seq: 99, included_ranges: "[[0,99]]" })
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "CORRUPT",
  )
  // base_seq != ujung cakupan juga struktural salah.
  handRow(cwd, { base_seq: 3, included_ranges: "[[0,2]]" })
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "CORRUPT",
  )
})

test("P2.7-10: build gagal = tanpa baris parsial; sumber utuh", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  const before = hashMessages(cwd, "s")
  expect(() =>
    buildProjection("s", DEFAULT_THREAD_ID, "x", cwd, { expectedEpoch: 0, baseSeq: 99 }),
  ).toThrow(ProjectionValidationError)
  expect(getProjection("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)).toBeNull()
  expect(hashMessages(cwd, "s")).toBe(before)
  // Status baris absen = UNKNOWN ("tak ada proyeksi"), bukan histori kosong.
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "UNKNOWN",
  )
  expect(loadThreadHistory("s", DEFAULT_THREAD_ID, cwd).length).toBe(3)
})

test("P2.7-11: rebuild idempoten dari messages", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  const v1 = buildProjection("s", DEFAULT_THREAD_ID, "sama", cwd, { expectedEpoch: 0 })
  const v2 = rebuildProjection("s", DEFAULT_THREAD_ID, "sama", cwd, { expectedEpoch: 0 })
  // Ekuivalen semantik (built_at stempel waktu boleh beda).
  const { built_at: _a, ...rest1 } = v1
  const { built_at: _b, ...rest2 } = v2
  expect(rest2).toEqual(rest1)
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "CURRENT",
  )
  // Rebuild memulihkan dari STALE.
  appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "baru" }, cwd)
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "STALE",
  )
  rebuildProjection("s", DEFAULT_THREAD_ID, "sama2", cwd, { expectedEpoch: 0 })
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "CURRENT",
  )
  expect(loadThreadHistory("s", DEFAULT_THREAD_ID, cwd).length).toBe(4)
})

test("P2.7-12: tulis proyeksi menuntut expectedEpoch", async () => {
  const cwd = ws()
  await seed(cwd, "s", 2)
  // Tanpa pagar → ditolak (bukan jalur tak-berpagar).
  expect(() =>
    buildProjection("s", DEFAULT_THREAD_ID, "x", cwd, {} as { expectedEpoch: number }),
  ).toThrow(ProjectionValidationError)
  // Penulis basi → REFUSED_STALE_EPOCH (otoritas sesi tunggal).
  const a = acquireSessionWriter({ sessionId: "s", cwd, bootId: "bootA", now: T0 })
  if (!a.ok) throw new Error("A gagal")
  const b = acquireSessionWriter({ sessionId: "s", cwd, bootId: "bootB", now: T0 + LEASE + 1 })
  if (!b.ok) throw new Error("B gagal")
  expect(() => buildProjection("s", DEFAULT_THREAD_ID, "x", cwd, { expectedEpoch: 0 })).toThrow(
    StaleWriterError,
  )
  expect(() => shrinkThreadHistory("s", DEFAULT_THREAD_ID, [], cwd, { expectedEpoch: 0 })).toThrow(
    StaleWriterError,
  )
})

test("P2.7-13: build tak menyentuh messages", async () => {
  const cwd = ws()
  await seed(cwd, "s", 5)
  const before = hashMessages(cwd, "s")
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  rebuildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  expect(hashMessages(cwd, "s")).toBe(before)
  expect(getThreadHead("s", DEFAULT_THREAD_ID, cwd)).toBe(4)
})

test("P2.7-14: baris migrated warisan dapat diproyeksikan", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  backfillHistoryEventIds("s", cwd)
  buildProjection("s", DEFAULT_THREAD_ID, "warisan", cwd, { expectedEpoch: 0 })
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "CURRENT",
  )
})

test("P2.7-15: shrink menandai migrated_compacted + tetap dapat diproyeksikan", async () => {
  const cwd = ws()
  await seed(cwd, "s", 4)
  // Ringkas 4 → 2 baris (summary + ekor): slot baru = provenance shrink.
  const tail = (loadSession("s", cwd)!.messages as { role: string; content: unknown }[]).slice(-1)
  const compacted = [{ role: "user", content: "ringkasan: m0-m2" }, ...tail]
  const { oldHead, newHead } = shrinkThreadHistory("s", DEFAULT_THREAD_ID, compacted, cwd, {
    expectedEpoch: 0,
  })
  expect(oldHead).toBe(3)
  expect(newHead).toBe(1)
  let eidBefore = ""
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    // Adopsi itu POSISIONAL (got.seq === i): ringkasan baru di 0 → flag 1,
    // ekor bergeser 3→1 (posisi berubah = slot baru) → flag 1 + event_id fresh.
    for (const seq of [0, 1]) {
      const flag = db
        .prepare("SELECT migrated_compacted AS f FROM messages WHERE session_id = ? AND seq = ?")
        .get("s", seq) as { f: number }
      expect(flag.f).toBe(1)
    }
    eidBefore = (
      db
        .prepare("SELECT event_id AS e FROM messages WHERE session_id = ? AND seq = 1")
        .get("s") as { e: string }
    ).e
  } finally {
    db.close()
  }
  // N→N satu slot berubah: slot tetap (posisi+isi sama) MEMPERTAHANKAN
  // event_id (identitas P2.5 utuh); slot berubah dapat id fresh.
  const cur = loadSession("s", cwd)!.messages as { role: string; content: unknown }[]
  const changed = cur.map((m, i) => (i === 0 ? { role: m.role, content: "LAIN" } : m))
  shrinkThreadHistory("s", DEFAULT_THREAD_ID, changed, cwd, { expectedEpoch: 0 })
  const db2 = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    const kept = db2
      .prepare("SELECT event_id AS e FROM messages WHERE session_id = ? AND seq = 1")
      .get("s") as { e: string }
    expect(kept.e).toBe(eidBefore)
    const fresh = db2
      .prepare("SELECT event_id AS e FROM messages WHERE session_id = ? AND seq = 0")
      .get("s") as { e: string }
    expect(fresh.e).not.toBe(eidBefore)
  } finally {
    db2.close()
  }
  buildProjection("s", DEFAULT_THREAD_ID, "ringkas-tercatat", cwd, { expectedEpoch: 0 })
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "CURRENT",
  )
})

test("P2.7-16: validitas netral-Run (multi-run + NULL)", async () => {
  const cwd = ws()
  await seed(cwd, "s", 2)
  const ra = createRun("s", DEFAULT_THREAD_ID, cwd)
  transitionRun(ra.run_id, "RUNNING", cwd)
  appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "assistant", content: "A" }, cwd, {
    runId: ra.run_id,
  })
  completeRun(ra.run_id, cwd)
  // Baris NULL (tanpa run) + baris milik runA: status tetap CURRENT.
  appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "biasa" }, cwd)
  buildProjection("s", DEFAULT_THREAD_ID, "campuran", cwd, { expectedEpoch: 0 })
  const st = getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)
  expect(st.state).toBe("CURRENT")
  // Status tak memakai run_id/kursor: bentuk API tanpa input Run adalah buktinya.
})

test("P2.7-17: saveSession implisit menolak shrink & rewrite", async () => {
  const cwd = ws()
  await seed(cwd, "s", 4)
  const shorter = (loadSession("s", cwd)!.messages as { role: string; content: unknown }[]).slice(
    0,
    2,
  )
  // Menyusut: bukan ditulis diam-diam, melainkan DITOLAK eksplisit.
  await expect(saveSession("s", cwd, undefined, shorter, { t: 2 })).rejects.toThrow(
    RefusedHistoryRewriteError,
  )
  expect(loadThreadHistory("s", DEFAULT_THREAD_ID, cwd).length).toBe(4)
  // N→N berubah isi: juga ditolak (bukan adopsi diam-diam).
  const same = (loadSession("s", cwd)!.messages as { role: string; content: unknown }[]).map(
    (m, i) => (i === 0 ? { role: m.role, content: "LAIN" } : m),
  )
  await expect(saveSession("s", cwd, undefined, same, { t: 3 })).rejects.toThrow(
    RefusedHistoryRewriteError,
  )
  expect(loadThreadHistory("s", DEFAULT_THREAD_ID, cwd).length).toBe(4)
  // Append murni tetap jalan (jalur normal utuh).
  await saveSession(
    "s",
    cwd,
    undefined,
    [
      ...(loadSession("s", cwd)!.messages as { role: string; content: unknown }[]),
      { role: "user", content: "baru" },
    ],
    { t: 4 },
  )
  expect(loadThreadHistory("s", DEFAULT_THREAD_ID, cwd).length).toBe(5)
})

test("P2.7-18: shrink live-Run ditolak; pasca-terminal jalan", async () => {
  const cwd = ws()
  await seed(cwd, "s", 4)
  const r = createRun("s", DEFAULT_THREAD_ID, cwd)
  transitionRun(r.run_id, "RUNNING", cwd)
  const shorter = (loadSession("s", cwd)!.messages as { role: string; content: unknown }[]).slice(
    0,
    2,
  )
  // Tanpa rewind/clamp: penolakan eksplisit, kursor tak tersentuh.
  expect(() =>
    shrinkThreadHistory("s", DEFAULT_THREAD_ID, shorter, cwd, { expectedEpoch: 0 }),
  ).toThrow(RefusedShrinkLiveRunError)
  expect(getThreadHead("s", DEFAULT_THREAD_ID, cwd)).toBe(3)
  expect(loadThreadHistory("s", DEFAULT_THREAD_ID, cwd).length).toBe(4)
  // Terminal-mark dulu → shrink jalan, kursor historis run tak diubah.
  completeRun(r.run_id, cwd)
  const out = shrinkThreadHistory("s", DEFAULT_THREAD_ID, shorter, cwd, { expectedEpoch: 0 })
  expect(out).toEqual({ oldHead: 3, newHead: 1 })
  expect(loadThreadHistory("s", DEFAULT_THREAD_ID, cwd).length).toBe(2)
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "UNKNOWN",
  )
})

test("P2.7-19: concurrent rebuild konvergen", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  const results = await Promise.allSettled([
    (async () => rebuildProjection("s", DEFAULT_THREAD_ID, "sama", cwd, { expectedEpoch: 0 }))(),
    (async () => rebuildProjection("s", DEFAULT_THREAD_ID, "sama", cwd, { expectedEpoch: 0 }))(),
  ])
  expect(results.filter((r) => r.status === "fulfilled").length).toBe(2)
  const rows = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => {
      const { built_at: _t, ...rest } = (
        r as PromiseFulfilledResult<ReturnType<typeof rebuildProjection>>
      ).value
      void _t
      return rest
    })
  expect(rows[0]).toEqual(rows[1])
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "CURRENT",
  )
})

test("P2.7-20: hapus proyeksi → replay sumber utuh", async () => {
  const cwd = ws()
  await seed(cwd, "s", 4)
  buildProjection("s", DEFAULT_THREAD_ID, "r", cwd, { expectedEpoch: 0 })
  const before = hashMessages(cwd, "s")
  const db = new Database(join(cwd, ".minicode", "sessions.db"))
  try {
    db.prepare("DELETE FROM history_projections WHERE session_id = ?").run("s")
  } finally {
    db.close()
  }
  expect(getProjection("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)).toBeNull()
  expect(hashMessages(cwd, "s")).toBe(before)
  expect(loadThreadHistory("s", DEFAULT_THREAD_ID, cwd).length).toBe(4)
})

test("P2.7 migrasi: anchor_event_id aditif + idempoten + preservasi", () => {
  const cwd = ws()
  const dbPath = join(cwd, ".minicode", "sessions.db")
  // Bentuk P2.6: tabel TANPA anchor_event_id + satu baris warisan.
  const raw = new Database(dbPath)
  try {
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, cwd TEXT NOT NULL, system TEXT NOT NULL);
      CREATE TABLE messages (session_id TEXT, seq INTEGER, role TEXT, content TEXT, toolCalls TEXT, toolCallId TEXT, name TEXT, reasoning TEXT, is_error INTEGER, ts INTEGER, PRIMARY KEY(session_id, seq));
      CREATE TABLE threads (session_id TEXT NOT NULL, thread_id TEXT NOT NULL, parent_thread_id TEXT NULL, fork_event_seq INTEGER NULL, head_seq INTEGER NOT NULL DEFAULT -1, status TEXT NOT NULL DEFAULT 'active', read_only INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY(session_id, thread_id), CHECK(head_seq >= -1), CHECK(fork_event_seq IS NULL OR fork_event_seq >= 0));
      CREATE TABLE history_projections (session_id TEXT NOT NULL, thread_id TEXT NOT NULL, projection_id TEXT NOT NULL, base_seq INTEGER NOT NULL DEFAULT 0, summary_text TEXT NOT NULL DEFAULT '', included_ranges TEXT NOT NULL DEFAULT '[]', built_at INTEGER NOT NULL, PRIMARY KEY(session_id, thread_id, projection_id), CHECK(base_seq >= 0));
      INSERT INTO sessions (id, created_at, updated_at, cwd, system) VALUES ('s', 1, 1, '', '');
      INSERT INTO threads (session_id, thread_id, head_seq, created_at) VALUES ('s', 'th_default', 1, 1);
      INSERT INTO messages (session_id, seq, role, content) VALUES ('s', 0, 'user', 'a'), ('s', 1, 'assistant', 'b');
      INSERT INTO history_projections (session_id, thread_id, projection_id, base_seq, summary_text, included_ranges, built_at) VALUES ('s', 'th_default', 'summary', 2, 'lama', '[[0,2]]', 1);
    `)
  } finally {
    raw.close()
  }
  // Open via persistence: kolom ditambahkan, baris warisan utuh (anchor NULL).
  const kept = getProjection("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)!
  expect(kept.summary_text).toBe("lama")
  expect(kept.anchor_event_id).toBeNull()
  // Jujur: baris pra-anchor tak bisa membuktikan validitas → CORRUPT (bukan CURRENT).
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "CORRUPT",
  )
  // Re-open idempoten: kolom tetap satu, baris tetap satu.
  getProjection("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)
  const check = new Database(dbPath, { readonly: true })
  try {
    const cols = check.prepare("PRAGMA table_info(history_projections)").all() as { name: string }[]
    expect(cols.filter((c) => c.name === "anchor_event_id").length).toBe(1)
    const n = check.prepare("SELECT COUNT(*) AS n FROM history_projections").get() as { n: number }
    expect(n.n).toBe(1)
  } finally {
    check.close()
  }
})
