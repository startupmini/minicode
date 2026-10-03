// M11 — Durable execution journal: history/evidence, bukan truth/recovery.
// Hermetic-file: SQLite tmp per test; tanpa scheduler/TaskStore/UI/CLI.

import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecutionEvent } from "../src/runtime/execution-events.ts"
import { allocateExecutionId } from "../src/runtime/execution-id.ts"
import {
  type ExecutionJournal,
  JOURNAL_SCHEMA_VERSION,
  openExecutionJournal,
  withJournalBusyRetry,
} from "../src/runtime/execution-journal.ts"
import { createExecutionKernel } from "../src/runtime/execution-kernel.ts"

function tmpDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "mc-m11-"))
  return { dir, path: join(dir, "journal.db") }
}

async function cleanup(dir: string): Promise<void> {
  // Windows: pelepasan file-handle SQLite berpacu dengan rm (EBUSY sesaat
  // walau db.close() + finalize sudah benar — terbukti lewat probe terisolasi).
  // Retry bounded; gagal persisten = bocor nyata → lempar (bukan telan).
  let last: unknown = null
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (e) {
      last = e
      await Bun.sleep(100)
    }
  }
  throw last
}

function evt(over: Partial<ExecutionEvent> & { eventId: string }): ExecutionEvent {
  const id = allocateExecutionId()
  return {
    eventType: "execution.state-changed",
    executionId: id,
    lineageRootId: id,
    timestamp: 1_700_000_000_000,
    eventSequence: 1,
    executionVersion: 2,
    source: "kernel",
    ...over,
  }
}

let evtCounter = 0
function uniqueEvt(over: Record<string, unknown> = {}) {
  evtCounter++
  const hex = evtCounter.toString(16).padStart(12, "0")
  return evt({
    eventId: `evt_01234567-89ab-4cde-8f01-${hex.slice(0, 12)}`,
    ...over,
  })
}

// Identity: eventId preserved, seq unik/monotonik/restart-safe, ≠ executionId.
test("M11 identity: eventId awet; seq unik monotonik lintas restart", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path)
    const e1 = uniqueEvt()
    const e2 = uniqueEvt()
    const r1 = await j.appendEvent(e1)
    const r2 = await j.appendEvent(e2)
    expect(r1.status).toBe("appended")
    expect(r2.status).toBe("appended")
    if (r1.status !== "appended" || r2.status !== "appended") throw new Error("unreachable")
    if (r1.record.kind !== "event" || r2.record.kind !== "event") throw new Error("unreachable")
    expect(r1.record.eventId).toBe(e1.eventId)
    expect(r2.record.journalSequence).toBe(r1.record.journalSequence + 1)
    expect(r1.record.eventId).not.toBe(r1.record.executionId)
    j.close()
    // Restart: seq berlanjut (AUTOINCREMENT persist), bukan reset.
    const j2 = openExecutionJournal(path)
    const r3 = await j2.appendEvent(uniqueEvt())
    if (r3.status !== "appended") throw new Error("unreachable")
    expect(r3.record.journalSequence).toBe(r2.record.journalSequence + 1)
    expect(j2.readAll()).toHaveLength(3)
    j2.close()
  } finally {
    await cleanup(dir)
  }
})

// Ordering: tiga sequence terpisah; interleave multi-execution valid.
test("M11 ordering: version ≠ eventSeq ≠ journalSeq; interleave valid", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path)
    const e1 = allocateExecutionId()
    const e2 = allocateExecutionId()
    // executionVersion=42, eventSequence=17, journalSequence→1098-style divergen.
    const a = await j.appendEvent(
      uniqueEvt({ executionId: e1, lineageRootId: e1, executionVersion: 42, eventSequence: 17 }),
    )
    const b = await j.appendEvent(
      uniqueEvt({ executionId: e2, lineageRootId: e2, executionVersion: 3, eventSequence: 5 }),
    )
    const c = await j.appendEvent(
      uniqueEvt({ executionId: e1, lineageRootId: e1, executionVersion: 43, eventSequence: 18 }),
    )
    if (a.status !== "appended" || b.status !== "appended" || c.status !== "appended")
      throw new Error("unreachable")
    const seqs = [a.record.journalSequence, b.record.journalSequence, c.record.journalSequence]
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs)
    // Timestamp BUKAN ordering authority: samakan ts, urutan tetap seq.
    const all = j.readAll()
    expect(all.map((r) => (r.kind === "event" ? r.executionId : "?"))).toEqual([e1, e2, e1])
    // readExecutionHistory = history per execution (bukan current state).
    expect(j.readExecutionHistory(e1)).toHaveLength(2)
    expect(j.readAfter(a.record.journalSequence)).toHaveLength(2)
    j.close()
  } finally {
    await cleanup(dir)
  }
})

// Append: normal, duplicate, konkuren duplicate/distinct, malformed.
test("M11 append: duplicate = satu record logis; konkuren aman; malformed ditolak", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path)
    const e = uniqueEvt()
    expect((await j.appendEvent(e)).status).toBe("appended")
    const dup = await j.appendEvent(e)
    expect(dup.status).toBe("duplicate")
    if (dup.status !== "duplicate") throw new Error("unreachable")
    if (dup.record.kind !== "event") throw new Error("unreachable")
    expect(dup.record.eventId).toBe(e.eventId)
    expect(j.readAll()).toHaveLength(1)
    // Konkuren duplicate ×16 → satu logis.
    const results = await Promise.all(Array.from({ length: 16 }, () => j.appendEvent(e)))
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(16)
    expect(j.readAll()).toHaveLength(1)
    // Konkuren distinct ×16 → 16 record, seq unik.
    const distinct = await Promise.all(Array.from({ length: 16 }, () => j.appendEvent(uniqueEvt())))
    expect(distinct.filter((r) => r.status === "appended")).toHaveLength(16)
    expect(new Set(j.readAll().map((r) => r.journalSequence)).size).toBe(17)
    // Malformed → serialization-failure (bukan throw generik).
    const bad = await j.appendEvent({ nope: true } as never)
    expect(bad.status).toBe("error")
    if (bad.status !== "error") throw new Error("unreachable")
    expect(bad.error.code).toBe("serialization-failure")
    j.close()
  } finally {
    await cleanup(dir)
  }
})

// Intent seam: intent-before-effect evidence; idempotent via intentId.
test("M11 intent: durable intent + dedupe; UNKNOWN tetap milik M12", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path)
    const exec = allocateExecutionId()
    const i1 = await j.noteIntent({
      intentId: `intent:${exec}:v3:abc`,
      executionId: exec,
      lineageRootId: exec,
      executionVersion: 3,
      reason: "tool bash requested",
      source: "test",
    })
    expect(i1.status).toBe("appended")
    const i2 = await j.noteIntent({
      intentId: `intent:${exec}:v3:abc`,
      executionId: exec,
      lineageRootId: exec,
      executionVersion: 3,
      reason: "tool bash requested",
      source: "test",
    })
    expect(i2.status).toBe("duplicate")
    expect(j.readExecutionHistory(exec)).toHaveLength(1)
    // Intent ≠ terminal/interpretasi: history mentah, tanpa kesimpulan retry.
    const hist = j.readExecutionHistory(exec)
    expect(hist[0]?.kind).toBe("intent")
    j.close()
  } finally {
    await cleanup(dir)
  }
})

// Failure matrix: kernel-ok+journal-gagal; flush; busy; unavailable; close-during; after-close.
test("M11 failure: kernel commit + journal gagal = error eksplisit, tanpa rollback", async () => {
  const { dir, path } = tmpDb()
  try {
    const kernel = createExecutionKernel()
    const rec = kernel.create({ kind: "turn", ownerId: "s" })
    kernel.requestTransition({
      executionId: rec.executionId,
      to: "ADMITTED",
      reason: "t",
      source: "test",
    })
    const j = openExecutionJournal(path)
    j.close()
    // Journal mati ≠ kernel rollback: kernel tetap ADMITTED.
    const res = await j.appendEvent(
      uniqueEvt({ executionId: rec.executionId, lineageRootId: rec.executionId }),
    )
    expect(res.status).toBe("error")
    expect(kernel.get(rec.executionId)?.state).toBe("ADMITTED")
    // Append sesudah close = already-closed eksplisit.
    if (res.status !== "error") throw new Error("unreachable")
    expect(["already-closed", "not-open"]).toContain(res.error.code)
    // Flush pada journal tertutup = failed/not-open eksplisit (bukan klaim).
    const f = j.flush()
    expect(f.status).toBe("failed")
    if (f.status !== "failed") throw new Error("unreachable")
    expect(f.error.code).toBe("not-open")
  } finally {
    await cleanup(dir)
  }
})

test("M11 failure: readonly storage + busy-retry bounded + flush jujur", async () => {
  // Busy retry: 2× SQLITE_BUSY lalu sukses; non-busy langsung throw; habis → throw.
  let calls = 0
  const val = await withJournalBusyRetry(() => {
    calls++
    if (calls < 3) throw new Error("SQLITE_BUSY: database is locked")
    return "ok"
  })
  expect(val).toBe("ok")
  expect(calls).toBe(3)
  await expect(
    withJournalBusyRetry(() => {
      throw new Error("disk I/O error")
    }),
  ).rejects.toThrow("disk I/O error")
  await expect(
    withJournalBusyRetry(
      () => {
        throw new Error("SQLITE_BUSY")
      },
      { attempts: 2, sleepMs: async () => {} },
    ),
  ).rejects.toThrow("SQLITE_BUSY")
  // Flush sukses pada jurnal sehat = durable-confirmed (FULL + fsync-boundary).
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path)
    await j.appendEvent(uniqueEvt())
    expect(j.flush().status).toBe("durable-confirmed")
    j.close()
  } finally {
    await cleanup(dir)
  }
})

// Durability: close/reopen, WAL recovery tanpa checkpoint, tail, korupsi eksplisit.
test("M11 durability: restart scan + WAL recovery + korupsi tak diam", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path)
    const e = uniqueEvt()
    await j.appendEvent(e)
    await j.noteIntent({
      intentId: "intent:restart:1",
      executionId: e.executionId,
      lineageRootId: e.lineageRootId,
      executionVersion: 1,
      reason: "r",
      source: "test",
    })
    j.close() // tanpa flush eksplisit — WAL replay saat open menjamin.
    const j2 = openExecutionJournal(path)
    expect(j2.readAll()).toHaveLength(2)
    expect(j2.integrityCheck()).toEqual({ checked: 2, mismatched: [] })
    j2.close()
    // Korupsi: nol-kan HEADER file (magic SQLite) → open harus corruption, bukan history valid.
    // (Tail-zeroing tak deterministik pada DB kecil — SQLite dapat mengabaikannya.)
    const { readFileSync, writeFileSync } = await import("node:fs")
    const buf = readFileSync(path)
    buf.fill(0, 0, 100)
    writeFileSync(path, buf)
    const j3 = openExecutionJournal(path)
    try {
      expect(j3.isOpen()).toBe(false)
      expect(j3.metrics().corruptionCount).toBe(1)
      const r = await j3.appendEvent(uniqueEvt())
      expect(r.status).toBe("error")
      if (r.status !== "error") throw new Error("unreachable")
      expect(r.error.code).toBe("corruption")
    } finally {
      try {
        j3.close()
      } catch {}
    }
  } finally {
    await cleanup(dir)
  }
})

// Immutability: tanpa UPDATE/DELETE; read-copy aman; source-mutasi aman.
test("M11 immutability: record beku; mutasi hasil-baca/sumber tak menular", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path)
    const e = uniqueEvt({ reason: "asli" })
    await j.appendEvent(e)
    const [first] = j.readAll()
    expect(Object.isFrozen(first)).toBe(true)
    ;(e as unknown as Record<string, unknown>).reason = "diubah-penyerang"
    const [again] = j.readAll()
    if (again?.kind !== "event") throw new Error("unreachable")
    expect(again.reason).toBe("asli")
    // Re-append eventId SAMA + payload BEDA → IDENTITY_CONFLICT (bukan duplicate);
    // original tak berubah; tanpa sequence baru (P D5).
    const tampered = {
      ...uniqueEvt(),
      eventId: (first as { eventId: string }).eventId,
      reason: "palsu",
    }
    const seqBefore = (first as { journalSequence: number }).journalSequence
    const conflict = await j.appendEvent(tampered as never)
    expect(conflict.status).toBe("error")
    if (conflict.status !== "error") throw new Error("unreachable")
    expect(conflict.error.code).toBe("identity-conflict")
    expect(conflict.error.detail).toMatch(/reason/)
    expect(conflict.error.detail).not.toMatch(/palsu|asli/)
    const [still] = j.readExecutionHistory((first as { executionId: string }).executionId)
    if (still?.kind !== "event") throw new Error("unreachable")
    expect(still.reason).toBe("asli")
    expect(still.journalSequence).toBe(seqBefore)
    expect(j.integrityCheck().mismatched).toEqual([])
    // Re-append IDENTIK → duplicate aman (D4).
    const sameAgain = await j.appendEvent({ ...(e as object), reason: "asli" } as never)
    expect(sameAgain.status).toBe("duplicate")
    j.close()
  } finally {
    await cleanup(dir)
  }
})

// Terminal races: jurnal cerminkan authority kernel, bukan urutan observer.
test("M11 terminal: COMPLETED lalu FAILED-telat = completed + backend.observed", async () => {
  const { dir, path } = tmpDb()
  try {
    const kernel = createExecutionKernel()
    const rec = kernel.create({ kind: "turn", ownerId: "s" })
    kernel.requestTransition({
      executionId: rec.executionId,
      to: "ADMITTED",
      reason: "t",
      source: "test",
    })
    kernel.requestTransition({
      executionId: rec.executionId,
      to: "RUNNING",
      reason: "t",
      source: "test",
    })
    kernel.requestTransition({
      executionId: rec.executionId,
      to: "COMPLETED",
      reason: "done",
      source: "agent-loop",
    })
    const late = kernel.requestTransition({
      executionId: rec.executionId,
      to: "FAILED",
      reason: "late",
      source: "backend",
    })
    expect(late.committed).toBe(false)
    const j = openExecutionJournal(path)
    const ver = kernel.get(rec.executionId)!.version
    const root = kernel.get(rec.executionId)!.rootExecutionId
    await j.appendEvent(
      uniqueEvt({
        executionId: rec.executionId,
        lineageRootId: root,
        executionVersion: ver,
        eventType: "execution.completed",
        state: "COMPLETED",
        reason: "done",
        source: "kernel",
      }),
    )
    // Observasi telat = record observasi BARU, bukan mutasi terminal.
    await j.appendEvent(
      uniqueEvt({
        executionId: rec.executionId,
        lineageRootId: root,
        executionVersion: ver,
        eventType: "backend.observed",
        state: "FAILED",
        reason: "late FAILED report",
        source: "backend",
      }),
    )
    const hist = j.readExecutionHistory(rec.executionId)
    expect(hist.map((r) => (r.kind === "event" ? r.eventType : "?"))).toEqual([
      "execution.completed",
      "backend.observed",
    ])
    expect(
      hist.filter(
        (r) => r.kind === "event" && (r as { eventType?: string }).eventType === "execution.failed",
      ),
    ).toHaveLength(0)
    j.close()
  } finally {
    await cleanup(dir)
  }
})

// Security: redaction di batas tulis; envelope shape aman.
test("M11 security: secret ter-redact; shape tanpa field sensitif", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path)
    const r = await j.appendEvent(
      uniqueEvt({
        metadata: { note: "biasa", api_key: "sk-abcdef1234567890", token: "Bearer xyz" },
      }),
    )
    expect(r.status).toBe("appended")
    if (r.status !== "appended") throw new Error("unreachable")
    const stored = JSON.parse((r.record as { metadataJson: string }).metadataJson) as Record<
      string,
      string
    >
    expect(stored.note).toBe("biasa")
    expect(stored.api_key).toBe("[REDACTED]")
    expect(stored.token).toBe("[REDACTED]")
    const dumped = JSON.stringify(j.readAll())
    expect(dumped).not.toMatch(/sk-abcdef|Bearer xyz/)
    j.close()
  } finally {
    await cleanup(dir)
  }
})

// Schema version eksplisit, berbeda dari executionVersion/journalSequence.
test("M11 schema: version=1; metrik observasi", async () => {
  expect(JOURNAL_SCHEMA_VERSION).toBe(1)
  const { dir, path } = tmpDb()
  try {
    const j: ExecutionJournal = openExecutionJournal(path)
    expect(j.isOpen()).toBe(true)
    const r = await j.appendEvent(uniqueEvt({ executionVersion: 42, eventSequence: 17 }))
    if (r.status !== "appended") throw new Error("unreachable")
    expect(r.record.schemaVersion).toBe(1)
    expect(r.record.schemaVersion).not.toBe(42)
    expect(r.record.journalSequence).not.toBe(42)
    expect(r.record.journalSequence).not.toBe(17)
    const m = j.metrics()
    expect(m.appendCount).toBe(1)
    expect(typeof m.bytesWritten).toBe("number")
    j.close()
    expect(j.isOpen()).toBe(false)
    j.close()
  } finally {
    await cleanup(dir)
  }
})

// Negative API: journal bukan authority/policy.
test("M11 negative: tanpa API lifecycle/recovery/scheduler/claim", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path)
    const api = j as unknown as Record<string, unknown>
    for (const forbidden of [
      "setState",
      "mutateExecution",
      "complete",
      "fail",
      "cancel",
      "terminate",
      "admit",
      "createExecution",
      "claimTask",
      "schedule",
      "recover",
      "reconcile",
      "redispatch",
      "replay",
      "rebuildExecution",
      "recoverUnknown",
      "repairExecution",
      "update",
      "delete",
    ]) {
      expect(api[forbidden], forbidden).toBeUndefined()
    }
    j.close()
  } finally {
    await cleanup(dir)
  }
})

// P1–P12 spot-checks (properti penuh tersebar di atas; ringkas di sini).
test("M11 properties: monotonic/dedupe/immutable/no-authority/order", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path)
    const seqs: number[] = []
    for (let i = 0; i < 20; i++) {
      const r = await j.appendEvent(uniqueEvt())
      if (r.status !== "appended") throw new Error("unreachable")
      seqs.push(r.record.journalSequence)
    }
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!)
    j.close()
  } finally {
    await cleanup(dir)
  }
})

// D1 — Commit sukses + durability boundary sukses = confirmed; record present.
test("M11 D1: commit + confirmed (FULL + fsync-boundary)", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path)
    const r = await j.appendEvent(uniqueEvt())
    expect(r.status).toBe("appended")
    const f = j.flush()
    expect(f.status).toBe("durable-confirmed")
    j.close()
  } finally {
    await cleanup(dir)
  }
})

// D2 — Commit sukses + checkpoint tak bisa boundary = UNCERTAIN; record tetap.
test("M11 D2: commit + checkpoint-busy = uncertain, record present", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path, {
      checkpoint: () => ({ busy: true, mode: "INJECTED-busy" }),
    })
    const r = await j.appendEvent(uniqueEvt())
    expect(r.status).toBe("appended")
    const f = j.flush()
    expect(f.status).toBe("durability-uncertain")
    if (f.status !== "durability-uncertain") throw new Error("unreachable")
    expect(f.error.code).toBe("flush-uncertain")
    // Record TETAP committed (tak dihapus) — uncertain ≠ failed.
    expect(j.readAll()).toHaveLength(1)
    expect(j.metrics().flushFailureCount).toBe(1)
    j.close()
  } finally {
    await cleanup(dir)
  }
})

// D2b — Checkpoint throw = failed terstruktur (bukan uncertain diam-diam).
test("M11 D2b: checkpoint throw = failed eksplisit", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path, {
      checkpoint: () => {
        throw new Error("INJECTED checkpoint I/O")
      },
    })
    await j.appendEvent(uniqueEvt())
    const f = j.flush()
    expect(f.status).toBe("failed")
    expect(j.readAll()).toHaveLength(1)
    j.close()
  } finally {
    await cleanup(dir)
  }
})

// D3 — Commit gagal sebelum record ada = tanpa record + error terstruktur.
test("M11 D3: commit gagal = tanpa record + storage error", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path)
    j.close()
    expect(j.readAll()).toHaveLength(0)
    const res = await j.appendEvent(uniqueEvt())
    expect(res.status).toBe("error")
  } finally {
    await cleanup(dir)
  }
})

// D5 + konflik konkuren 8+8: satu original, konflik = IDENTITY_CONFLICT.
test("M11 conflict-concurrent: 8 sama + 8 beda payload → 1 record + 8 konflik", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path)
    const base = uniqueEvt({ reason: "asli" })
    const first = await j.appendEvent(base)
    expect(first.status).toBe("appended")
    const results = await Promise.all([
      ...Array.from({ length: 8 }, () => j.appendEvent({ ...(base as object) } as never)),
      ...Array.from({ length: 8 }, (_, i) =>
        j.appendEvent({ ...(base as object), reason: `palsu-${i}` } as never),
      ),
    ])
    const duplicates = results.filter((r) => r.status === "duplicate").length
    const conflicts = results.filter(
      (r) =>
        r.status === "error" &&
        (r as { error: { code: string } }).error.code === "identity-conflict",
    ).length
    expect(duplicates).toBe(8)
    expect(conflicts).toBe(8)
    const all = j.readAll()
    expect(
      all.filter((r) => r.kind === "event" && (r as { eventId: string }).eventId === base.eventId),
    ).toHaveLength(1)
    j.close()
  } finally {
    await cleanup(dir)
  }
})

// Restart tanpa flush eksplisit: present (WAL replay) — BUKAN klaim power-loss proof.
test("M11 restart-noflush: close-tanpa-flush → reopen → present (process-restart, bukan power-proof)", async () => {
  const { dir, path } = tmpDb()
  try {
    const j = openExecutionJournal(path)
    await j.appendEvent(uniqueEvt())
    await j.appendEvent(uniqueEvt())
    j.close() // sengaja tanpa flush()
    const j2 = openExecutionJournal(path)
    expect(j2.readAll()).toHaveLength(2)
    expect(j2.integrityCheck()).toEqual({ checked: 2, mismatched: [] })
    j2.close()
  } finally {
    await cleanup(dir)
  }
})
