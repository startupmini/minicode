// P2.0 — Kontrak primitif Thread (P2-FUTURE-CONTRACT + MIGRATION).
//
// Thread belum ada di produksi; aturan lineage diuji via oracle test-side
// + assertion gap skema (kolom thread_id belum ada). Setelah P2.4, oracle
// diganti implementasi nyata tanpa mengubah ekspektasi.

import { expect, test } from "bun:test"
import { saveSession } from "../src/session/persistence.ts"
import {
  P2_CLASS,
  p2Cleanup,
  p2Cwd,
  p2DbPath,
  p2HasColumn,
  p2Id,
  p2Msgs,
  p2ResetIds,
  p2ValidateFork,
} from "./helpers/p2.ts"

test(`[${P2_CLASS.FUTURE_CONTRACT}] skema: messages punya thread_id dorman (P2.3 mendarat)`, () => {
  const cwd = p2Cwd("mc-p2th")
  // P2.3: kolom ada, NULL (dorman). P2.4 yang mengaktifkan semantiknya.
  return saveSession("probe", cwd, undefined, [], undefined)
    .then(() => {
      expect(p2HasColumn(p2DbPath(cwd), "messages", "thread_id")).toBe(true)
    })
    .finally(() => p2Cleanup(cwd))
})

test(`[${P2_CLASS.MIGRATION}] default thread: sesi legacy dipetakan ke thread_default tanpa mengubah seq`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2th")
  try {
    const id = p2Id("sess")
    const msgs = p2Msgs(5, "leg")
    await saveSession(id, cwd, undefined, msgs, { turns: 1 })
    // Aturan migrasi: (session_id, seq) → (thread_default, seq) 1:1.
    // Hari ini baru terbukti di level kontrak: jumlah baris utuh.
    const { loadSession } = await import("../src/session/persistence.ts")
    const loaded = loadSession(id, cwd)
    expect(loaded!.messages.length).toBe(5)
    expect(loaded!.messages[0]).toMatchObject({ role: "user", content: "leg-u0" })
    // Expected After P2: baris-baris ini membawa thread_id=thread_default,
    // event_id evt_migr_*, dan seq 0..4 tidak berubah.
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] isolasi: dua thread dengan seq numerik sama tetap valid`, () => {
  // Oracle level kontrak: namespace seq milik thread, bukan sesi.
  const a = new Map<number, string>([
    [0, "a0"],
    [1, "a1"],
  ])
  const b = new Map<number, string>([
    [0, "b0"],
    [1, "b1"],
  ])
  expect(a.get(0)).not.toBe(b.get(0))
  expect(a.size).toBe(b.size)
  // Expected After P2: PK (thread_id, seq) mengizinkan ini di SQLite.
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] validasi fork: head/before ok, nonexistent/negatif ditolak`, () => {
  expect(p2ValidateFork(10, 10)).toEqual({ ok: true })
  expect(p2ValidateFork(10, 4)).toEqual({ ok: true })
  expect(p2ValidateFork(10, 11)).toEqual({ ok: false, reason: "nonexistent-seq" })
  expect(p2ValidateFork(10, -1)).toEqual({ ok: false, reason: "invalid-seq" })
  expect(p2ValidateFork(0, 0)).toEqual({ ok: true })
  // Expected After P2: forkThread memakai aturan persis ini di dalam txn.
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] parent dengan anak tidak boleh dihapus; migr read-only bukan induk`, () => {
  // Kontrak (test-side): guard hapus + guard fork-parent.
  const children = new Map<string, string[]>()
  children.set("th_default", ["th_anak1", "thread_migr_lama"])
  const canDelete = (thread: string): boolean => (children.get(thread) ?? []).length === 0
  const canBeParent = (thread: string): boolean => !thread.startsWith("thread_migr_")
  expect(canDelete("th_default")).toBe(false)
  expect(canDelete("th_anak1")).toBe(true)
  expect(canBeParent("thread_migr_lama")).toBe(false)
  expect(canBeParent("th_default")).toBe(true)
  // Expected After P2: guard ini hidup di lapisan thread manager.
})
