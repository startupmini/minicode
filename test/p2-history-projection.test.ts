// P2.0 — Kontrak histori kanonik + guard kompaksi/proyeksi
// (CURRENT-INVARIANT + P2-FUTURE-CONTRACT + ARCHITECTURE-GUARD).
//
// Guard merge-blocking: sumber sebelum/sesudah kompaksi-save-reload harus
// identik untuk sesi P2-native. Karena rewrite-branch masih ada kini, guard
// kedua mendokumentasikan celah secara eksplisit (lolos = celah terdeteksi).

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { loadSession, saveSession } from "../src/session/persistence.ts"
import {
  P2_CLASS,
  p2Allocator,
  p2Cleanup,
  p2Cwd,
  p2HistoryHash,
  p2Id,
  p2Msgs,
  p2ResetIds,
} from "./helpers/p2.ts"

test(`[${P2_CLASS.CURRENT_INVARIANT}] roundtrip: save→load→save→load identik (harness deteksi perubahan)`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2hist")
  try {
    const id = p2Id("sess")
    const msgs = p2Msgs(4, "rt")
    await saveSession(id, cwd, undefined, msgs, { turns: 1 })
    type Row = { role: string; content: unknown }
    const rows = (loadSession(id, cwd)!.messages as Row[]).map((m) => ({
      role: m.role,
      content: String(m.content),
    }))
    const h1 = p2HistoryHash(rows)
    await saveSession(id, cwd, undefined, msgs, { turns: 1 })
    const loaded = loadSession(id, cwd)!
    const h2 = p2HistoryHash(
      (loaded.messages as Row[]).map((m) => ({ role: m.role, content: String(m.content) })),
    )
    expect(h2).toBe(h1)
    expect(loaded.messages.length).toBe(4)
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] identitas event: duplikat vs konflik`, () => {
  const alloc = p2Allocator()
  expect(alloc.alloc("th_default", "evt_1", "hashA")).toEqual({ seq: 0 })
  // EventId sama + payload sama → DUPLICATE (idempoten, tanpa seq baru).
  expect(alloc.alloc("th_default", "evt_1", "hashA")).toEqual({ dup: true })
  expect(alloc.max("th_default")).toBe(0)
  // EventId sama + payload beda → IDENTITY_CONFLICT (tindak lanjut: tolak).
  expect(alloc.alloc("th_default", "evt_1", "hashB")).toEqual({ conflict: true })
  // Thread lain punya namespace sendiri.
  expect(alloc.alloc("th_cabang", "evt_2", "hashA")).toEqual({ seq: 0 })
  // Expected After P2: alokator ini hidup di dalam txn mutasi (bukan memori).
})

test(`[${P2_CLASS.ARCHITECTURE_GUARD}] P2.7: cabang DELETE+reinsert implisit saveSession WAJIB HILANG`, () => {
  // P2.7 menghapus cabang "history menyusut (compaction/reset) ... → tulis
  // ulang penuh" (DELETE FROM messages + re-INSERT implisit). Guard ini adalah
  // hasil BALIK dari guard celah P2.0: pola berbahaya tersebut wajib HILANG;
  // penggantinya eksplisit (shrinkThreadHistory: berpagar, provenance,
  // invalidasi proyeksi). Kembalinya pola = regresi arsitektur.
  const src = readFileSync("src/session/persistence.ts", "utf8")
  const hasDeleteRewrite =
    src.includes("DELETE FROM messages WHERE session_id = ?") && src.includes("tulis ulang penuh")
  expect(hasDeleteRewrite).toBe(false)
  // Companion: DELETE FROM messages yang sah HANYA bentuk eksplisit — (a) purge
  // yatim, (b) hapus sesi utuh, (c) cascade anak Sub-Agent (P2.9), (d) shrink
  // eksplisit. Varian lama (cakup NULL-transisional) maupun varian tersembunyi
  // = regresi.
  const deletes = src.match(/DELETE\s+FROM\s+messages\b[^"\n]*/gi) ?? []
  expect(deletes.length).toBe(4)
  const forms = deletes.map((d) => d.trim()).sort()
  expect(forms.some((d) => d.includes("NOT IN (SELECT id FROM sessions)"))).toBe(true)
  // DuaDELETE "WHERE session_id = ?" sah: sesi itu sendiri + cascade per anak.
  expect(forms.filter((d) => d === "DELETE FROM messages WHERE session_id = ?").length).toBe(2)
  expect(
    forms.filter((d) => d === "DELETE FROM messages WHERE session_id = ? AND thread_id = ?").length,
  ).toBe(1)
  // Bentuk NULL-transisional hanya sah di BACA kompatibel (loadSession P2.4),
  // tak pernah di DELETE: tak ada penghapus yang memakai cakupan itu.
  const deleteLines = src.split("\n").filter((l) => /DELETE\s+FROM\s+messages\b/i.test(l))
  for (const l of deleteLines) {
    expect(l.includes("OR thread_id IS NULL")).toBe(false)
  }
  expect(src.includes("shrinkThreadHistory")).toBe(true)
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] proyeksi: hapus proyeksi → replay sumber utuh (kontrak model)`, () => {
  // Kontrak yang kelak diuji ke SQLite: sumber otoritatif, proyeksi sekali pakai.
  const source = p2Msgs(6, "src")
  const projections = new Map([["p1", { baseSeq: 3, summary: "ringkasan" }]])
  const replay = [...source]
  projections.delete("p1")
  expect(p2HistoryHash(replay)).toBe(p2HistoryHash(source))
  // Expected After P2: replay dari tabel messages; proyeksi di history_projections.
})

test(`[${P2_CLASS.MIGRATION}] legacy compacted: sumber ringkas wajib bertanda (gap kini)`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2leg")
  try {
    const id = p2Id("sess")
    // Fixture histori yang SUDAH diringkas era pra-P2 (satu summary user).
    await saveSession(id, cwd, undefined, [{ role: "user", content: "ringkasan: ..." }], {
      turns: 1,
    })
    const loaded = loadSession(id, cwd)!
    expect(loaded.messages.length).toBe(1)
    // EXPECTED PRE-P2 FAILURE: setelah migrasi P2, baris warisan semacam ini
    // membawa migrated_compacted=true + provenance "historically incomplete".
    // Hari ini tidak ada kolomnya — assertion gap dicatat di test skema.
  } finally {
    await p2Cleanup(cwd)
  }
})
