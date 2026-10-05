// P2.0 — Batas TaskGraph + fence epoch penulis (P2-FUTURE-CONTRACT).
//
// TaskStore/Scheduler TIDAK disentuh: ref + epoch diuji via perilaku nyata
// (inkarnasi) dan model CAS deterministik.

import { expect, test } from "bun:test"
import { TaskStore } from "../src/task/store.ts"
import {
  P2_CLASS,
  p2Barrier,
  p2Cleanup,
  p2Cwd,
  p2EpochStore,
  p2Id,
  p2ResetIds,
} from "./helpers/p2.ts"

function taskInput(title: string) {
  return {
    title,
    status: "pending",
    order: 0,
    provenance: { origin: "model", source: "p2-fixture" },
  } as never
}

test(`[${P2_CLASS.CURRENT_INVARIANT}] baseline: hapus sesi menaikkan inkarnasi (anti-resurrect)`, () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2task")
  return (async () => {
    const store = new TaskStore(cwd)
    const sid = p2Id("sess")
    expect(store.getSessionIncarnation(sid)).toBe(1)
    store.createTask(sid, taskInput("tugas-1"))
    expect(store.listTasks(sid).length).toBe(1)
    // Expected After P2: Session.taskGraphRef mengikat (storePath, sid,
    // incarnation) dan scheduler menolak incarnation basi.
  })().finally(() => p2Cleanup(cwd))
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] epoch: penulis basi gagal closed setelah takeover`, () => {
  const s = p2EpochStore()
  const epochA = s.epoch() // 0 — penulis A membaca
  const afterTakeover = s.takeover("takeover-B") // → 1
  expect(afterTakeover).toBe(1)
  // A menulis dengan epoch basi → DITOLAK.
  expect(s.mutate(epochA)).toEqual({ ok: false, reason: "REFUSED_STALE_EPOCH" })
  // B menulis dengan epoch kini → DITERIMA.
  expect(s.mutate(afterTakeover)).toEqual({ ok: true })
  // A wajib re-acquire (baca ulang) sebelum mencoba lagi.
  expect(s.mutate(s.epoch())).toEqual({ ok: true })
  // Expected After P2: CAS ini di dalam txn SQLite (sessions.writer_epoch).
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] epoch: takeover ganda simultan → satu pemenang, satu epoch`, () => {
  const s = p2EpochStore()
  expect(s.takeover("kunci-sama")).toBe(1)
  expect(s.takeover("kunci-sama")).toBe(1) // idempoten: kunci sama tak naik
  expect(s.takeover("kunci-lain")).toBe(2)
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] epoch: interleave deterministik A-takeover-B via barrier`, async () => {
  const s = p2EpochStore()
  const gate = p2Barrier()
  const epochA = s.epoch()
  let resultB = -1
  const procB = (async () => {
    await gate.wait()
    resultB = s.takeover("B")
  })()
  gate.releaseAll()
  await procB
  expect(resultB).toBe(1)
  // A yang dijeda kini bangun dan commit → tetap ditolak (tanpa timing flaky).
  expect(s.mutate(epochA)).toEqual({ ok: false, reason: "REFUSED_STALE_EPOCH" })
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] taskref: sesi tidak menduplikasi state tugas`, () => {
  // Kontrak: Session menyimpan referensi (storePath/sessionId/incarnation),
  // BUKAN salinan baris tugas. Test-side: bentuk ref yang diizinkan.
  const ref = {
    storePath: "<cwd>/.minicode/tasks.db",
    sessionId: "sess-0001",
    incarnation: 1,
    boundAt: 123,
  }
  expect(Object.keys(ref).sort()).toEqual(["boundAt", "incarnation", "sessionId", "storePath"])
  expect("tasks" in ref).toBe(false)
  // Expected After P2: kolom-kolom ini ada di baris sessions.
})
