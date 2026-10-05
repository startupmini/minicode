// P2.0 — Kontrak identitas sesi (P2-FUTURE-CONTRACT + CURRENT-INVARIANT).
//
// Kelas tiap test tercantum di nama. Test P2-FUTURE-CONTRACT yang
// mendokumentasikan celah kini ditulis sebagai assertion celah eksplisit
// (lolos dengan menandai gap) + oracle test-side yang fully green; saat P2.1
// mendarat, assertion celah DIBALIK menjadi assertion kontrak. Jangan
// melemahkan ekspektasi — balikkan sesuai kolom "Expected After P2".

import { expect, test } from "bun:test"
import { sanitizeSessionPart } from "../src/lib/session-id.ts"
import { loadSession, saveSession } from "../src/session/persistence.ts"
import {
  P2_CLASS,
  type P2IdentityCandidate,
  p2Cleanup,
  p2Cwd,
  p2HistoryHash,
  p2Id,
  p2ResetIds,
  p2ResolveCanonical,
} from "./helpers/p2.ts"

// P2.1: tak ada lagi regex sanitasi di call-site CLI — satu-satunya aturan
// adalah sanitizeSessionPart. Guard statisnya hidup di
// p2-architecture-guards.test.ts (regex duplikat = pelanggaran).

test(`[${P2_CLASS.FUTURE_CONTRACT}] B: sanitizer kanonik tunggal, idempoten, bounded`, () => {
  for (const id of ["sess-1", "a1b2c3d4", "sub_ab12cd34"]) {
    expect(sanitizeSessionPart(id)).toBe(id)
  }
  expect(sanitizeSessionPart(".foo")).toBe("foo")
  expect(sanitizeSessionPart("x".repeat(100))).toHaveLength(60)
  // Idempoten: sanitasi ganda = sanitasi sekali (syarat stabilitas kunci).
  for (const raw of ["a/b", "...", ".foo", "x".repeat(100), "a..b", " spasi "]) {
    expect(sanitizeSessionPart(sanitizeSessionPart(raw))).toBe(sanitizeSessionPart(raw))
  }
})

function cand(over: Partial<P2IdentityCandidate> & { id: string }): P2IdentityCandidate {
  return {
    updatedAt: 1000,
    historyCount: 3,
    historyHash: "h",
    taskCount: 0,
    incarnation: 1,
    fsKey: over.id,
    ...over,
  }
}

test(`[${P2_CLASS.FUTURE_CONTRACT}] A: sesi tersimpan dapat dimuat ulang dengan kunci sama (pra-alias)`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2id")
  try {
    const id = p2Id("sess")
    const msgs = [
      { role: "user", content: "halo" },
      { role: "assistant", content: "hai" },
    ]
    await saveSession(id, cwd, undefined, msgs, { turns: 1 })
    // Simulasi restart: baca ulang dari direktori yang sama.
    const loaded = loadSession(id, cwd)
    expect(loaded).not.toBeNull()
    expect(loaded!.messages.length).toBe(2)
    // Expected After P2: kunci yang sama resolve via session_aliases ke
    // canonical SessionId (satu jalur tulis).
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] B2: penyatuan drift 64-vs-60 (P2.1: satu batas 60)`, () => {
  // P2.1: CLI tak lagi memotong 64 — resolveSessionIdentity mendelegasi ke
  // sanitizeSessionPart (60). Guard duplikat-regex ada di arsitektur guard.
  expect(sanitizeSessionPart("x".repeat(100))).toHaveLength(60)
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] C: dual-ID dimigrasi ke satu kanonik + alias tanpa kehilangan baris`, () => {
  const a = cand({ id: "sesi-lama", updatedAt: 2000, historyCount: 5, historyHash: "h1" })
  const b = cand({ id: "sesi-baru", updatedAt: 3000, historyCount: 2, historyHash: "h2" })
  const out = p2ResolveCanonical([a, b])
  expect(out.kind).toBe("canonical")
  if (out.kind !== "canonical") throw new Error("tak terduga")
  // Resensi menang atas jumlah (aturan 5): anti "more history wins".
  expect(out.canonicalId).toBe("sesi-baru")
  expect(out.losersMigrated).toEqual(["sesi-lama"])
  // Expected After P2: losersMigrated menjadi thread_migr_* read-only,
  // bukan baris yang digabung/dihapus.
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] D: dua ID task-authoritative wajib operator-choice`, () => {
  const a = cand({ id: "a", taskCount: 2, incarnation: 1 })
  const b = cand({ id: "b", taskCount: 1, incarnation: 1 })
  const out = p2ResolveCanonical([a, b])
  expect(out.kind).toBe("operator_choice")
  if (out.kind !== "operator_choice") throw new Error("tak terduga")
  expect(out.reason).toBe("dual-task-authority")
  expect(new Set(out.candidates)).toEqual(new Set(["a", "b"]))
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] E: history-rich vs task-authoritative → kanonik = tugas`, () => {
  const rich = cand({
    id: "kaya",
    historyCount: 200,
    historyHash: "hr",
    taskCount: 0,
    updatedAt: 9999,
  })
  const live = cand({
    id: "hidup",
    historyCount: 3,
    historyHash: "hl",
    taskCount: 4,
    updatedAt: 1000,
  })
  const out = p2ResolveCanonical([rich, live])
  expect(out.kind).toBe("canonical")
  if (out.kind !== "canonical") throw new Error("tak terduga")
  expect(out.canonicalId).toBe("hidup")
  expect(out.losersMigrated).toEqual(["kaya"])
  // Expected After P2: "kaya" menjadi thread_migr_kaya read-only + provenance.
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] F: kolisi sanitizer tidak boleh auto-merge`, () => {
  const a = cand({ id: "a/b", fsKey: "a-b" })
  const b = cand({ id: "a-b", fsKey: "a-b" })
  const out = p2ResolveCanonical([a, b])
  expect(out.kind).toBe("operator_choice")
  if (out.kind !== "operator_choice") throw new Error("tak terduga")
  expect(out.reason).toBe("fs-key-collision")
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] G: histori identik → deterministik (id terkecil), bukan panjang`, () => {
  const p = p2HistoryHash([
    { role: "user", content: "x" },
    { role: "assistant", content: "y" },
  ])
  const out = p2ResolveCanonical([
    cand({ id: "zeta", historyHash: p, historyCount: 2 }),
    cand({ id: "alpha", historyCount: 2, historyHash: p }),
  ])
  expect(out.kind).toBe("canonical")
  if (out.kind !== "canonical") throw new Error("tak terduga")
  expect(out.canonicalId).toBe("alpha")
})

test(`[${P2_CLASS.CURRENT_INVARIANT}] sanitizer kanonik stabil + aman path`, () => {
  expect(sanitizeSessionPart("sess-1")).toBe("sess-1")
  expect(sanitizeSessionPart("...")).toBe("x")
  expect(sanitizeSessionPart("a/b")).toBe("a-b")
  expect(sanitizeSessionPart(".foo")).toBe("foo")
})
