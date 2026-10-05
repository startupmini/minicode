// P2.6 — Run durable + kursor (produksi).
//
// Membuktikan: identitas kanonik, kepemilikan (sesi,thread), lifecycle
// minimal + terminal-idempoten/konflik, kursor atomik + monoton + validasi,
// fence epoch, takeover_epoch, tombstone crash, pending dormant, isolasi
// sesi, dan jalur komposisi (turn → RUNNING → terminal; resume menombak).

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliSession } from "../cli/setup.ts"
import { acquireSessionWriter } from "../src/session/authority.ts"
import {
  advanceRunCursor,
  appendHistoryEvent,
  assessRunRecoveryStatus,
  branchSession,
  completeRun,
  createRun,
  DEFAULT_THREAD_ID,
  failRun,
  getActiveRun,
  getRun,
  interruptRun,
  isRunId,
  listSessionRuns,
  loadSession,
  loadThreadHistory,
  RunCursorError,
  RunRunningExistsError,
  RunStatusError,
  RunTerminalConflictError,
  readWriterEpoch,
  StaleWriterError,
  saveSession,
  setRunPendingTools,
  takeoverSessionEpoch,
  tombstoneDeadRuns,
  transitionRun,
} from "../src/session/persistence.ts"

function ws(withConfig = false): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p26-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  if (withConfig) {
    writeFileSync(
      join(dir, ".minicode", "config.json"),
      JSON.stringify({
        providers: [
          { id: "fake", baseUrl: "http://localhost:9", apiKey: "sk-test", models: ["m"] },
        ],
      }),
      "utf8",
    )
  }
  return dir
}

function baseOpts(cwd: string, extra: Record<string, unknown> = {}) {
  return {
    cwd,
    allowLocalConfig: true,
    sessionId: "",
    prompt: "hi",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
    ...extra,
  }
}

const T0 = 1_700_000_000_000
const LEASE = 300_000

async function seed(cwd: string, sid: string, n = 2): Promise<void> {
  const msgs = Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `m${i}`,
  }))
  await saveSession(sid, cwd, undefined, msgs, { t: 1 })
}

test("P2.6.1-5: identitas + kepemilikan — create/load, tepat satu (sesi,thread)", async () => {
  const cwd = ws()
  await seed(cwd, "s", 2)
  const r = createRun("s", DEFAULT_THREAD_ID, cwd)
  expect(isRunId(r.run_id)).toBe(true)
  expect(r.session_id).toBe("s")
  expect(r.thread_id).toBe(DEFAULT_THREAD_ID)
  expect(r.status).toBe("CREATED")
  expect(r.last_persisted_seq).toBe(1)
  expect(r.pending_tool_ids).toBe("[]")
  expect(r.recovery_status).toBe("NONE")
  expect(r.takeover_epoch).toBe(readWriterEpoch("s", cwd))
  expect(r.ended_at).toBeNull()
  expect(getRun(r.run_id, cwd)).toEqual(r)
  expect(listSessionRuns("s", cwd).map((x) => x.run_id)).toEqual([r.run_id])
  expect(getActiveRun("s", cwd)).toBeNull()
  // Thread sesi lain ditolak (kepemilikan silang korup).
  await seed(cwd, "other", 1)
  expect(() => createRun("s", "th_asing", cwd)).toThrow(/thread not found/)
  // Sesi tak ada ditolak.
  expect(() => createRun("hantu", DEFAULT_THREAD_ID, cwd)).toThrow(/session not found/)
  // Format run_id divalidasi (bukan exec_/sembarang).
  expect(isRunId("exec_123")).toBe(false)
  expect(() => createRun("s", DEFAULT_THREAD_ID, cwd, { runId: "bukan-id" })).toThrow(
    /invalid run id/,
  )
})

test("P2.6.6-11: lifecycle minimal + terminal idempoten vs konflik", async () => {
  const cwd = ws()
  await seed(cwd, "s", 1)
  const r = createRun("s", DEFAULT_THREAD_ID, cwd)
  expect(transitionRun(r.run_id, "RUNNING", cwd).status).toBe("RUNNING")
  expect(getActiveRun("s", cwd)!.run_id).toBe(r.run_id)
  expect(transitionRun(r.run_id, "COMPLETED", cwd).status).toBe("COMPLETED")
  // Terminal→sama idempoten (ended_at pertama menang).
  const again = transitionRun(r.run_id, "COMPLETED", cwd)
  expect(again.status).toBe("COMPLETED")
  expect(again.ended_at).toBe(getRun(r.run_id, cwd)!.ended_at)
  // Wrapper terminal: FAILED via failRun, INTERRUPTED via interruptRun.
  const rf = createRun("s", DEFAULT_THREAD_ID, cwd)
  transitionRun(rf.run_id, "RUNNING", cwd)
  expect(failRun(rf.run_id, cwd).status).toBe("FAILED")
  const ri = createRun("s", DEFAULT_THREAD_ID, cwd)
  transitionRun(ri.run_id, "RUNNING", cwd)
  expect(interruptRun(ri.run_id, cwd).status).toBe("INTERRUPTED")
  expect(interruptRun(ri.run_id, cwd).recovery_status).toBe("NONE")
  // Terminal→beda DITOLAK (first wins, bukan last-writer-wins).
  expect(() => transitionRun(r.run_id, "FAILED", cwd)).toThrow(RunTerminalConflictError)
  expect(getRun(r.run_id, cwd)!.status).toBe("COMPLETED")
  // Ilegal: mundur ke non-terminal.
  const r2 = createRun("s", DEFAULT_THREAD_ID, cwd)
  expect(() => transitionRun(r2.run_id, "COMPLETED", cwd)).not.toThrow()
  expect(() => transitionRun(r2.run_id, "RUNNING", cwd)).toThrow(RunStatusError)
  // CREATED langsung terminal (tak pernah jalan) diizinkan eksplisit.
  const r3 = createRun("s", DEFAULT_THREAD_ID, cwd)
  expect(transitionRun(r3.run_id, "INTERRUPTED", cwd).status).toBe("INTERRUPTED")
})

test("P2.6.12-18: kursor — advance valid, monoton, validasi, asing ditolak", async () => {
  const cwd = ws()
  await seed(cwd, "s", 3)
  const r = createRun("s", DEFAULT_THREAD_ID, cwd)
  expect(r.last_persisted_seq).toBe(2)
  transitionRun(r.run_id, "RUNNING", cwd)
  // Tanpa event durable di seq → ditolak (beyond head).
  expect(() => advanceRunCursor(r.run_id, 9, cwd)).toThrow(RunCursorError)
  // Maju valid.
  expect(advanceRunCursor(r.run_id, 2, cwd).last_persisted_seq).toBe(2)
  // Mundur ditolak (tanpa rewind di P2.6).
  await saveSession(
    "s",
    cwd,
    undefined,
    [
      ...(loadSession("s", cwd)!.messages as { role: string; content: unknown }[]),
      { role: "user", content: "baru" },
    ],
    { t: 2 },
  )
  expect(advanceRunCursor(r.run_id, 3, cwd).last_persisted_seq).toBe(3)
  expect(() => advanceRunCursor(r.run_id, 2, cwd)).toThrow(RunCursorError)
  // Idempoten pada nilai sama.
  expect(advanceRunCursor(r.run_id, 3, cwd).last_persisted_seq).toBe(3)
  // Terminal membekukan kursor.
  completeRun(r.run_id, cwd)
  expect(() => advanceRunCursor(r.run_id, 3, cwd)).toThrow(RunStatusError)
  // Histori run lain tak bisa diadopsi: cap baris seq-0 milik runA, majukan runB.
  const ra = createRun("s", DEFAULT_THREAD_ID, cwd)
  transitionRun(ra.run_id, "RUNNING", cwd)
  await saveSession(
    "s",
    cwd,
    undefined,
    [
      ...(loadSession("s", cwd)!.messages as { role: string; content: unknown }[]),
      { role: "user", content: "milik-A" },
    ],
    { t: 3 },
    { runId: ra.run_id },
  )
  completeRun(ra.run_id, cwd)
  const rb = createRun("s", DEFAULT_THREAD_ID, cwd)
  transitionRun(rb.run_id, "RUNNING", cwd)
  expect(() => advanceRunCursor(rb.run_id, 4, cwd)).toThrow(RunCursorError)
})

test("P2.6.19-21: atomik histori+kursor; rollback utuh; restart mempertahankannya", async () => {
  const cwd = ws()
  await seed(cwd, "s", 2)
  const r = createRun("s", DEFAULT_THREAD_ID, cwd)
  transitionRun(r.run_id, "RUNNING", cwd)
  await saveSession(
    "s",
    cwd,
    undefined,
    [
      ...(loadSession("s", cwd)!.messages as { role: string; content: unknown }[]),
      { role: "user", content: "turn-ini" },
    ],
    { t: 2 },
    { runId: r.run_id },
  )
  // Kursor = head, baris baru ber-stempel run ini.
  expect(getRun(r.run_id, cwd)!.last_persisted_seq).toBe(2)
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    const row = db
      .prepare("SELECT run_id FROM messages WHERE session_id = ? AND seq = 2")
      .get("s") as { run_id: string | null }
    expect(row.run_id).toBe(r.run_id)
  } finally {
    db.close()
  }
  // Gagal (run tak ada) = rollback TOTAL: histori tak berubah, kursor diam.
  const before = JSON.stringify(loadSession("s", cwd)!.messages)
  await expect(
    saveSession(
      "s",
      cwd,
      undefined,
      [
        ...(loadSession("s", cwd)!.messages as { role: string; content: unknown }[]),
        { role: "user", content: "gagal" },
      ],
      { t: 3 },
      { runId: "run_00000000-0000-4000-8000-000000000000" },
    ),
  ).rejects.toThrow(/run not found/)
  expect(JSON.stringify(loadSession("s", cwd)!.messages)).toBe(before)
  expect(getRun(r.run_id, cwd)!.last_persisted_seq).toBe(2)
})

test("P2.6.22-23: race — satu RUNNING menang; kursor konvergen tanpa loss", async () => {
  const cwd = ws()
  await seed(cwd, "s", 4)
  const a = createRun("s", DEFAULT_THREAD_ID, cwd)
  const b = createRun("s", DEFAULT_THREAD_ID, cwd)
  const results = await Promise.allSettled([
    (async () => transitionRun(a.run_id, "RUNNING", cwd))(),
    (async () => transitionRun(b.run_id, "RUNNING", cwd))(),
  ])
  const won = results.filter((r) => r.status === "fulfilled")
  const lost = results.filter((r) => r.status === "rejected")
  expect(won.length).toBe(1)
  expect(lost.length).toBe(1)
  expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(RunRunningExistsError)
  expect(getActiveRun("s", cwd)).not.toBeNull()
  // Kursor: dua advance ke target SAMA dari posisi sama → konvergen (tanpa
  // urutan yang kalah-hilang; idempoten pada nilai sama).
  const winner = (won[0] as PromiseFulfilledResult<ReturnType<typeof transitionRun>>).value.run_id
  const head = getRun(winner, cwd)!.last_persisted_seq
  const t1 = advanceRunCursor(winner, head, cwd)
  const t2 = advanceRunCursor(winner, head, cwd)
  expect(t1.last_persisted_seq).toBe(head)
  expect(t2.last_persisted_seq).toBe(head)
})

test("P2.6.24-25: stale & takeover deterministik", async () => {
  const cwd = ws()
  await seed(cwd, "s", 1)
  const a = acquireSessionWriter({ sessionId: "s", cwd, bootId: "bootA", now: T0 })
  if (!a.ok) throw new Error("A gagal")
  const r = createRun("s", DEFAULT_THREAD_ID, cwd, { expectedEpoch: 0 })
  const b = acquireSessionWriter({ sessionId: "s", cwd, bootId: "bootB", now: T0 + LEASE + 1 })
  if (!b.ok) throw new Error("B gagal")
  expect(b.admission.epoch).toBe(1)
  // Run.takeover_epoch (0) <= session epoch (1): tercatat, tak dimutasi diam-diam.
  expect(getRun(r.run_id, cwd)!.takeover_epoch).toBe(0)
  expect(getRun(r.run_id, cwd)!.takeover_epoch!).toBeLessThanOrEqual(readWriterEpoch("s", cwd))
  // Semua mutasi run penulis basi DITOLAK.
  expect(() => transitionRun(r.run_id, "RUNNING", cwd, { expectedEpoch: 0 })).toThrow(
    StaleWriterError,
  )
  expect(() => advanceRunCursor(r.run_id, 0, cwd, { expectedEpoch: 0 })).toThrow(StaleWriterError)
  expect(() => setRunPendingTools(r.run_id, ["t1"], cwd, { expectedEpoch: 0 })).toThrow(
    StaleWriterError,
  )
  // Penulis kini bisa.
  expect(transitionRun(r.run_id, "RUNNING", cwd, { expectedEpoch: 1 }).status).toBe("RUNNING")
})

test("P2.6.26-28: crash → RUNNING menetap; tombstone UNKNOWN; tanpa redo", async () => {
  const cwd = ws()
  await seed(cwd, "s", 2)
  const r = createRun("s", DEFAULT_THREAD_ID, cwd)
  transitionRun(r.run_id, "RUNNING", cwd)
  // "Crash": tanpa terminal commit. Baris tetap RUNNING (bukan COMPLETED
  // inferensi, bukan auto-mutasi saat load).
  expect(getRun(r.run_id, cwd)!.status).toBe("RUNNING")
  expect(assessRunRecoveryStatus(getRun(r.run_id, cwd)!)).toBe("UNKNOWN")
  expect(getRun(r.run_id, cwd)!.recovery_status).toBe("NONE")
  // Tombstone (jalur resume): INTERRUPTED + UNKNOWN + ended NULL, idempoten.
  expect(tombstoneDeadRuns("s", cwd)).toBe(1)
  const t = getRun(r.run_id, cwd)!
  expect(t.status).toBe("INTERRUPTED")
  expect(t.recovery_status).toBe("UNKNOWN")
  expect(t.ended_at).toBeNull()
  expect(tombstoneDeadRuns("s", cwd)).toBe(0)
  // UNKNOWN ≠ terminal sukses/gagal; tak ada run baru tercipta; histori utuh.
  expect(t.status).not.toBe("COMPLETED")
  expect(t.status).not.toBe("FAILED")
  expect(assessRunRecoveryStatus(t)).toBe("UNKNOWN")
  expect(listSessionRuns("s", cwd).length).toBe(1)
  expect(loadThreadHistory("s", DEFAULT_THREAD_ID, cwd).length).toBe(2)
})

test("P2.6.29-30: pending_tool_ids round-trip dorman; malformed ditolak", async () => {
  const cwd = ws()
  await seed(cwd, "s", 1)
  const r = createRun("s", DEFAULT_THREAD_ID, cwd)
  expect(setRunPendingTools(r.run_id, ["call-1", "call-2"], cwd).pending_tool_ids).toBe(
    JSON.stringify(["call-1", "call-2"]),
  )
  expect(getRun(r.run_id, cwd)!.pending_tool_ids).toBe(JSON.stringify(["call-1", "call-2"]))
  expect(() => setRunPendingTools(r.run_id, "bukan-array", cwd)).toThrow(/RUN_PENDING_MALFORMED/)
  expect(() => setRunPendingTools(r.run_id, [123], cwd)).toThrow(/RUN_PENDING_MALFORMED/)
  expect(() => setRunPendingTools(r.run_id, ["x".repeat(600)], cwd)).toThrow(
    /RUN_PENDING_MALFORMED/,
  )
  // BUKAN bukti eksekusi: status/kursor tak tersentuh setter metadata.
  expect(getRun(r.run_id, cwd)!.status).toBe("CREATED")
  expect(getRun(r.run_id, cwd)!.last_persisted_seq).toBe(0)
})

test("P2.6: appendHistoryEvent memajukan kursor dalam txn yang sama", async () => {
  const cwd = ws()
  await seed(cwd, "s", 1)
  const r = createRun("s", DEFAULT_THREAD_ID, cwd)
  transitionRun(r.run_id, "RUNNING", cwd)
  // Event dicap run ini → kursor ikut maju di commit yang sama.
  const out = appendHistoryEvent(
    "s",
    DEFAULT_THREAD_ID,
    { role: "assistant", content: "hi" },
    cwd,
    {
      runId: r.run_id,
    },
  )
  expect(out.outcome).toBe("appended")
  expect(getRun(r.run_id, cwd)!.last_persisted_seq).toBe(out.seq)
  // Event tanpa runId → kursor tak bergerak (tak ada klaim palsu).
  const plain = appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "biasa" }, cwd)
  expect(plain.outcome).toBe("appended")
  expect(getRun(r.run_id, cwd)!.last_persisted_seq).toBe(out.seq)
  // Run terminal beku: append lanjut boleh, kursor tak bergerak.
  completeRun(r.run_id, cwd)
  const after = appendHistoryEvent(
    "s",
    DEFAULT_THREAD_ID,
    { role: "user", content: "pasca" },
    cwd,
    {
      runId: r.run_id,
    },
  )
  expect(after.outcome).toBe("appended")
  expect(getRun(r.run_id, cwd)!.last_persisted_seq).toBe(out.seq)
})

test("P2.6: branch tak mewarisi run_id (tak ada Lien Run Palsu)", async () => {
  const cwd = ws()
  await seed(cwd, "src", 2)
  const r = createRun("src", DEFAULT_THREAD_ID, cwd)
  transitionRun(r.run_id, "RUNNING", cwd)
  appendHistoryEvent("src", DEFAULT_THREAD_ID, { role: "assistant", content: "milik-run" }, cwd, {
    runId: r.run_id,
  })
  await branchSession("src", "dst", cwd)
  expect(loadThreadHistory("dst", DEFAULT_THREAD_ID, cwd).length).toBe(3)
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    const leaked = db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND run_id IS NOT NULL")
      .get("dst") as { n: number }
    expect(leaked.n).toBe(0)
    // Run milik "src" tetap utuh dan tak ikut lenyap bersama cabang.
    const copied = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE session_id = ?").get("dst") as {
      n: number
    }
    expect(copied.n).toBe(0)
  } finally {
    db.close()
  }
  expect(getRun(r.run_id, cwd)!.session_id).toBe("src")
})

test("P2.6.31: legacy tanpa Run tetap valid (tanpa fabrikasi)", async () => {
  const cwd = ws()
  await seed(cwd, "s", 2)
  expect(getActiveRun("s", cwd)).toBeNull()
  expect(listSessionRuns("s", cwd)).toEqual([])
  expect(loadSession("s", cwd)!.messages.length).toBe(2)
})

// Turn nyata: retry provider tak terjangkau memang lambat, jadi timeout test
// longgar (bukan lotre pada durasi retry).
test("P2.6: komposisi — turn gagal → Run FAILED saat close; resume menombak residu", async () => {
  const cwd = ws(true)
  const c1 = await createCliSession(baseOpts(cwd, { sessionId: "turn" }))
  // Provider localhost:9 tak terjangkau → turn gagal cepat (tanpa model).
  await expect(c1.runPromptWithVerify("halo")).rejects.toThrow()
  await c1.persistCurrent({ totalTokens: 0 })
  await c1.close()
  const runs = listSessionRuns("turn", cwd)
  expect(runs.length).toBe(1)
  expect(runs[0]!.status).toBe("FAILED")
  expect(runs[0]!.ended_at).not.toBeNull()
  // Residu crash: RUNNING yang ditinggal (simulasi: tanpa close-terminal).
  const c2 = await createCliSession(baseOpts(cwd, { sessionId: "crash" }))
  await c2.persistCurrent({ totalTokens: 0 })
  const crashRun = createRun("crash", DEFAULT_THREAD_ID, cwd)
  transitionRun(crashRun.run_id, "RUNNING", cwd)
  await c2.close()
  // close() menandai live run miliknya (tak ada — currentRunId null di sini
  // karena turn tak pernah jalan), residu manual tetap RUNNING.
  expect(getRun(crashRun.run_id, cwd)!.status).toBe("RUNNING")
  const c3 = await createCliSession(baseOpts(cwd, { resumeId: "crash" }))
  await c3.close()
  const t = getRun(crashRun.run_id, cwd)!
  expect(t.status).toBe("INTERRUPTED")
  expect(t.recovery_status).toBe("UNKNOWN")
}, 60_000)

test("P2.6: takeover_epoch ≤ session epoch, tercatat saat create", async () => {
  const cwd = ws()
  await seed(cwd, "s", 1)
  expect(takeoverSessionEpoch("s", 0, "uji", "bootB", cwd).outcome).toBe("advanced")
  const r = createRun("s", DEFAULT_THREAD_ID, cwd, { expectedEpoch: 1 })
  expect(r.takeover_epoch).toBe(1)
  expect(r.takeover_epoch!).toBeLessThanOrEqual(readWriterEpoch("s", cwd))
})

test("P2.6: migrasi runs aditif — P2.3 tanpa takeover_epoch → naik; idempoten", async () => {
  const cwd = ws()
  const dbPath = join(cwd, ".minicode", "sessions.db")
  // Bentuk P2.3: tabel runs TANPA kolom takeover_epoch + indeks partial belum ada.
  const raw = new Database(dbPath)
  try {
    raw.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'CREATED', started_at INTEGER NOT NULL, ended_at INTEGER NULL,
        last_persisted_seq INTEGER NOT NULL DEFAULT 0, pending_tool_ids TEXT NOT NULL DEFAULT '[]',
        recovery_status TEXT NULL, created_at INTEGER NOT NULL, CHECK(last_persisted_seq >= 0)
      );
      CREATE TABLE messages (session_id TEXT, seq INTEGER, role TEXT, content TEXT, toolCalls TEXT, toolCallId TEXT, name TEXT, reasoning TEXT, is_error INTEGER, ts INTEGER, PRIMARY KEY(session_id, seq));
      CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, cwd TEXT NOT NULL, system TEXT NOT NULL);
      INSERT INTO runs (run_id, session_id, thread_id, status, started_at, last_persisted_seq, recovery_status, created_at)
        VALUES ('run_legacy1', 's', 'th_default', 'RUNNING', 1, 2, NULL, 1);
    `)
  } finally {
    raw.close()
  }
  // Sesi "s" belum ada sebagai baris (raw hanya menyuntik run_legacy1 yang
  // menunjuknya). seed memicu open() (migrasi aditif kolom) lalu menciptakan
  // baris sesi + default Thread — prasyarat createRun di bawah.
  await seed(cwd, "s", 1)
  // Open via persistence: kolom takeover_epoch ditambahkan aditif, baris utuh.
  const r = getRun("run_legacy1", cwd)
  expect(r).not.toBeNull()
  expect(r!.session_id).toBe("s")
  expect(r!.status).toBe("RUNNING")
  expect(r!.takeover_epoch).toBeNull()
  // Run masih berfungsi pasca-migrasi; sesi masih RUNNING. Indeks partial
  // RUNNING UNIQUE kini terpasang → RUNNING kedua ditolak DB (harus diuji
  // SELAMA legacy masih RUNNING, sebelum transisi di bawah).
  const second = createRun("s", DEFAULT_THREAD_ID, cwd)
  expect(() => transitionRun(second.run_id, "RUNNING", cwd)).toThrow(RunRunningExistsError)
  // Transisi terminal sah setelah konflik terbukti.
  expect(
    transitionRun("run_legacy1", "INTERRUPTED", cwd, { recoveryStatus: "UNKNOWN" }).status,
  ).toBe("INTERRUPTED")
  // Re-open idempoten: buka ulang tak menggandakan kolom / indeks / baris.
  expect(getRun("run_legacy1", cwd)!.status).toBe("INTERRUPTED")
})
