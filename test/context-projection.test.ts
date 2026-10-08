// P3.4 — Durable Context Projection Producer: tests.
//
// Membuktikan: produsen membangun baris proyeksi dari state KANONIK, menulis
// HANYA history_projections (derived), tak menyentuh messages/head/run,
// deterministik, idempoten-semantik, ter-scope identitas, recovery lewat rebuild,
// dan — inti milestone — selector dapat mengonsumsi proyeksi produksi sehingga
// `summary-plus-tail` menjadi perilaku produksi nyata.

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  deriveSummaryFromCanonical,
  produceSummaryProjection,
  readConsumableSummaryProjection,
  summaryProjectionStatus,
} from "../src/session/context-projection.ts"
import { selectContext } from "../src/session/context-selector.ts"
import {
  DEFAULT_THREAD_ID,
  getProjection,
  getThreadHead,
  loadSession,
  loadThreadHistoryWithSeq,
  SUMMARY_PROJECTION_ID,
  saveSession,
  shrinkThreadHistory,
} from "../src/session/persistence.ts"

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p34-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

/** Histori "berat" agar fold benar-benar terjadi (prefix panjang). */
function history(turns: number): unknown[] {
  const msgs: unknown[] = []
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: "user", content: `t${i} ` + "x".repeat(40) })
    msgs.push({ role: "assistant", content: `a${i} ` + "y".repeat(40) })
  }
  return msgs
}

async function seed(cwd: string, sid: string, turns = 6): Promise<void> {
  await saveSession(sid, cwd, undefined, history(turns), { turns })
}

function canonFingerprint(cwd: string, sid: string): string {
  return JSON.stringify(loadSession(sid, cwd)!.messages)
}

function tableFingerprint(cwd: string, table: string, sid: string): string {
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    const hasSession = cols.some((c) => c.name === "session_id")
    const rows = hasSession
      ? db.prepare(`SELECT * FROM ${table} WHERE session_id = ?`).all(sid)
      : db.prepare(`SELECT * FROM ${table}`).all()
    return JSON.stringify(rows)
  } finally {
    db.close()
  }
}

// ── Production creation ──────────────────────────────────────────────────────

test("P3.4-1: canonical → projection dibuat (produksi), kanonik utuh", async () => {
  const cwd = ws()
  await seed(cwd, "s")
  const before = canonFingerprint(cwd, "s")
  const res = produceSummaryProjection("s", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 2 },
  })
  expect(res.produced).toBe(true)
  expect(res.baseSeq).toBeGreaterThan(0)
  // Baris proyeksi benar-benar ada di history_projections.
  const row = getProjection("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)
  expect(row).not.toBeNull()
  expect(row!.base_seq).toBe(res.baseSeq!)
  // Kanonik TIDAK berubah.
  expect(canonFingerprint(cwd, "s")).toBe(before)
})

test("P3.4-2: idempoten semantik — sumber sama + policy sama → baris ekuivalen", async () => {
  const cwd = ws()
  await seed(cwd, "s")
  const r1 = produceSummaryProjection("s", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 2 },
  })
  const b1 = r1.row!.base_seq
  const t1 = r1.row!.summary_text
  const r2 = produceSummaryProjection("s", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 2 },
  })
  expect(r2.row!.base_seq).toBe(b1)
  expect(r2.row!.summary_text).toBe(t1)
  // Tetap SATU baris proyeksi (replace, bukan akumulasi).
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    const n = db
      .prepare(
        "SELECT COUNT(*) AS n FROM history_projections WHERE session_id = ? AND projection_id = ?",
      )
      .get("s", SUMMARY_PROJECTION_ID) as { n: number }
    expect(n.n).toBe(1)
  } finally {
    db.close()
  }
})

test("P3.4-3: tak ada prefix untuk diringkas → no-op (tanpa baris)", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [{ role: "user", content: "only" }], { turns: 1 })
  const res = produceSummaryProjection("s", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 5 },
  })
  expect(res.produced).toBe(false)
  expect(getProjection("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)).toBeNull()
})

// ── Identity / scope ─────────────────────────────────────────────────────────

test("P3.4-4: scope identitas — proyeksi session lain tak dipakai", async () => {
  const cwd = ws()
  await seed(cwd, "sA")
  await seed(cwd, "sB")
  produceSummaryProjection("sA", cwd, { expectedEpoch: 0, policy: { keepRecentTurns: 2 } })
  // sB belum diproduksi.
  expect(getProjection("sA", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)).not.toBeNull()
  expect(getProjection("sB", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)).toBeNull()
  expect(readConsumableSummaryProjection("sB", cwd, DEFAULT_THREAD_ID)).toBeNull()
})

test("P3.4-5: scope identitas — thread default benar; thread lain independen", async () => {
  const cwd = ws()
  await seed(cwd, "s")
  produceSummaryProjection("s", cwd, { expectedEpoch: 0, policy: { keepRecentTurns: 2 } })
  // Proyeksi mendarat di thread default yang benar.
  expect(getProjection("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)).not.toBeNull()
  // Thread lain (belum ada baris) = tak ada proyeksi.
  expect(getProjection("s", "th_lain", SUMMARY_PROJECTION_ID, cwd)).toBeNull()
})

// ── Coverage ─────────────────────────────────────────────────────────────────

test("P3.4-6: coverage — baseSeq = baris diringkas (keepRecentTurns=2 → ekor 2 turn)", async () => {
  const cwd = ws()
  await seed(cwd, "s", 8) // 16 baris, 8 turn
  const rows = loadThreadHistoryWithSeq("s", DEFAULT_THREAD_ID, cwd)
  expect(rows.length).toBe(16)
  const res = produceSummaryProjection("s", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 2 },
  })
  // keepRecentTurns=2 → ekor = 2 turn = 4 baris; prefix diringkas = 16 - 4 = 12.
  expect(res.baseSeq).toBe(12)
  expect(getThreadHead("s", DEFAULT_THREAD_ID, cwd)).toBe(15)
})

test("P3.4-7: derivasi murni deterministik (input tak dimutasi)", () => {
  const msgs = history(6).map((m) => m as { role: string; content: string })
  const before = JSON.stringify(msgs)
  const a = deriveSummaryFromCanonical(msgs as never, { keepRecentTurns: 2 })
  const b = deriveSummaryFromCanonical(msgs as never, { keepRecentTurns: 2 })
  expect(a).toEqual(b)
  expect(JSON.stringify(msgs)).toBe(before)
  expect(a!.baseSeq).toBeGreaterThan(0)
})

// ── Freshness / invalidation ─────────────────────────────────────────────────

test("P3.4-8: freshness — proyeksi parsial selalu STALE (cakupan < head+1)", async () => {
  const cwd = ws()
  await seed(cwd, "s", 6)
  const produced = produceSummaryProjection("s", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 2 },
  })
  const head = getThreadHead("s", DEFAULT_THREAD_ID, cwd)
  // Parsial: base_seq < head+1 → STALE pada semantik P2.7.
  expect(produced.baseSeq!).toBeLessThan(head + 1)
  expect(summaryProjectionStatus("s", cwd).state).toBe("STALE")
})

test("P3.4-9: freshness — cakupan parsial = STALE namun tetap consumable (P3.0 §8 D6)", async () => {
  const cwd = ws()
  await seed(cwd, "s", 6)
  produceSummaryProjection("s", cwd, { expectedEpoch: 0, policy: { keepRecentTurns: 2 } })
  const st = summaryProjectionStatus("s", cwd)
  // Proyeksi parsial: head belum tertutup → STALE, bukan CORRUPT/UNKNOWN.
  expect(st.state).toBe("STALE")
  // STALE berjangkar-utuh = coverage-valid → boleh dikonsumsi selector.
  const proj = readConsumableSummaryProjection("s", cwd)
  expect(proj).not.toBeNull()
  expect(proj!.baseSeq).toBeGreaterThan(0)
})

test("P3.4-10: invalidation — shrink menghapus proyeksi (producer berikutnya melempar/mengisi ulang)", async () => {
  const cwd = ws()
  await seed(cwd, "s", 8)
  produceSummaryProjection("s", cwd, { expectedEpoch: 0, policy: { keepRecentTurns: 2 } })
  expect(getProjection("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)).not.toBeNull()
  // Shrink eksplisit (berpagar epoch) menghapus proyeksi thread dalam txn yang sama.
  shrinkThreadHistory("s", DEFAULT_THREAD_ID, history(3), cwd, { expectedEpoch: 0 })
  expect(getProjection("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)).toBeNull()
  // Produsen dapat membangun ulang dari kanonik baru (recovery).
  const res = produceSummaryProjection("s", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 1 },
  })
  // 3 turn × 2 = 6 baris; keep 1 turn = 2 baris ekor → ada prefix → produced.
  expect(res.produced).toBe(true)
})

// ── Content / ordering ───────────────────────────────────────────────────────

test("P3.4-11: konten — ringkasan berasal dari kanonik, urutan terjaga, tanpa event asing", async () => {
  const cwd = ws()
  await seed(cwd, "s", 6)
  const res = produceSummaryProjection("s", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 2 },
  })
  // Ringkasan memakai konvensi kernel "Previous context:".
  expect(res.row!.summary_text).toContain("Previous context:")
  // Tak ada duplikasi baris kanonik (proyeksi bukan salinan history).
  const row = getProjection("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)!
  expect(row.included_ranges).toBe(JSON.stringify([[0, res.baseSeq!]]))
  expect(row.anchor_event_id).toBeTruthy()
})

// ── Failure safety ───────────────────────────────────────────────────────────

test("P3.4-12: kegagalan produksi TIDAK mengubah kanonik", async () => {
  const cwd = ws()
  await seed(cwd, "s", 6)
  const before = canonFingerprint(cwd, "s")
  const messagesBefore = tableFingerprint(cwd, "messages", "s")
  // Epoch salah → buildProjection melempar (StaleWriterError); kanonik harus utuh.
  let threw = false
  try {
    produceSummaryProjection("s", cwd, { expectedEpoch: 9999, policy: { keepRecentTurns: 2 } })
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
  expect(canonFingerprint(cwd, "s")).toBe(before)
  expect(tableFingerprint(cwd, "messages", "s")).toBe(messagesBefore)
})

test("P3.4-13: histori kosong → no-op, tanpa throw", () => {
  const cwd = ws()
  const res = produceSummaryProjection("empty", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 2 },
  })
  expect(res.produced).toBe(false)
  expect(res.detail).toContain("empty")
})

// ── Recovery ─────────────────────────────────────────────────────────────────

test("P3.4-14: recovery — hapus proyeksi → kanonik utuh → rebuild berhasil", async () => {
  const cwd = ws()
  await seed(cwd, "s", 6)
  produceSummaryProjection("s", cwd, { expectedEpoch: 0, policy: { keepRecentTurns: 2 } })
  const canon = canonFingerprint(cwd, "s")
  // Hapus baris proyeksi (derived) langsung.
  const db = new Database(join(cwd, ".minicode", "sessions.db"))
  try {
    db.prepare("DELETE FROM history_projections WHERE session_id = ?").run("s")
  } finally {
    db.close()
  }
  expect(readConsumableSummaryProjection("s", cwd)).toBeNull()
  expect(canonFingerprint(cwd, "s")).toBe(canon) // kanonik tak tersentuh
  const res = produceSummaryProjection("s", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 2 },
  })
  expect(res.produced).toBe(true)
  expect(readConsumableSummaryProjection("s", cwd)).not.toBeNull()
})

// ── Authority proof ──────────────────────────────────────────────────────────

test("P3.4-15: AUTHORITY — ubah proyeksi TIDAK mengubah kanonik", async () => {
  const cwd = ws()
  await seed(cwd, "s", 6)
  const canonBefore = canonFingerprint(cwd, "s")
  produceSummaryProjection("s", cwd, { expectedEpoch: 0, policy: { keepRecentTurns: 2 } })
  produceSummaryProjection("s", cwd, { expectedEpoch: 0, policy: { keepRecentTurns: 4 } })
  const db = new Database(join(cwd, ".minicode", "sessions.db"))
  try {
    db.prepare("DELETE FROM history_projections WHERE session_id = ?").run("s")
  } finally {
    db.close()
  }
  expect(canonFingerprint(cwd, "s")).toBe(canonBefore)
})

test("P3.4-16: AUTHORITY — produsen TIDAK menulis messages/turns/threads/runs", async () => {
  const cwd = ws()
  await seed(cwd, "s", 6)
  const tables = ["messages", "turns", "threads", "runs", "sessions"]
  const before = Object.fromEntries(tables.map((t) => [t, tableFingerprint(cwd, t, "s")]))
  produceSummaryProjection("s", cwd, { expectedEpoch: 0, policy: { keepRecentTurns: 2 } })
  for (const t of tables) {
    // sessions.updated_at tak berubah karena produsen tak menulis sessions.
    expect(tableFingerprint(cwd, t, "s")).toBe(before[t]!)
  }
})

// ── Determinism ──────────────────────────────────────────────────────────────

test("P3.4-17: determinisme — sumber sama → ringkasan & baseSeq sama", async () => {
  const cwd = ws()
  await seed(cwd, "s", 6)
  const a = deriveSummaryFromCanonical(history(6) as never, { keepRecentTurns: 3 })
  const b = deriveSummaryFromCanonical(history(6) as never, { keepRecentTurns: 3 })
  expect(a).toEqual(b)
  void cwd
})

// ── PRODUCTION PATH PROOF (milestone core) ───────────────────────────────────

test("P3.4-18: PRODUKSI — kanonik → produsen → history_projections → selector summary-plus-tail", async () => {
  const cwd = ws()
  await seed(cwd, "s", 6)
  // 1) Produsen produksi menulis proyeksi dari kanonik.
  const produced = produceSummaryProjection("s", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 2 },
  })
  expect(produced.produced).toBe(true)
  // 2) Selector membaca proyeksi NYATA (coverage-valid) dan memakai summary-plus-tail.
  const proj = readConsumableSummaryProjection("s", cwd)
  expect(proj).not.toBeNull()
  const rows = loadThreadHistoryWithSeq("s", DEFAULT_THREAD_ID, cwd)
  const sel = selectContext({
    sessionId: "s",
    threadId: DEFAULT_THREAD_ID,
    rows,
    revision: 0,
    projection: proj!,
    policy: { budgetTokens: 1_000_000 },
  })
  expect(sel.selectionBasis).toBe("summary-plus-tail")
  expect(sel.coveredSeq).toBe(proj!.baseSeq)
  expect(sel.contextOnly).toBeDefined()
  expect(sel.messages[0]!.content).toContain("Previous context")
  // 3) Kanonik utuh.
  expect(loadThreadHistoryWithSeq("s", DEFAULT_THREAD_ID, cwd).length).toBe(rows.length)
})
