// P3.2 — Context Identity + Frontier: regression tests.
//
// Setiap test di sini non-vacuous: ada mutasi spesifik yang membuatnya
// gagal ( diverifikasi di P3.2 report §12 — mutation A/B/C/D). Invariant:
// derived state boleh mengobservasi authority, tak boleh diam-diam menjadi
// authority; identity != sequence; context != persistence authority.

import { describe, expect, test } from "bun:test"
import { isExecutionId } from "../src/runtime/execution-id.ts"
import type { CanonicalEventRef, ContextFrontier } from "../src/session/context-identity.ts"
import {
  assessContextFreshness,
  compareContextFrontier,
  countDurableCompactions,
  deriveAnchorEventId,
  deriveContextFrontier,
  deriveContextIdentity,
  deriveFrontierFromDurable,
  deriveHistoryCommit,
  isAnchorEventId,
  isContextFrontier,
  isHistoryCommit,
} from "../src/session/context-identity.ts"

// Baris dalam bentuk DURABLE (seperti yang dibaca loadSession dari SQLite:
// content sudah safeContent/scrub/cap — bukan objek runtime).
function row(seq: number, content: string, role = "user"): CanonicalEventRef {
  return { seq, role, content }
}

function history(n: number, prefix = "msg"): CanonicalEventRef[] {
  const rows: CanonicalEventRef[] = []
  for (let i = 0; i < n; i++) rows.push(row(i, `${prefix}-${i}`))
  return rows
}

function fullFrontier(
  sessionId: string,
  rows: readonly CanonicalEventRef[],
  revision = 0,
  threadId?: string,
): ContextFrontier | null {
  return deriveFrontierFromDurable({ sessionId, threadId, rows, revision })
}

// Frontier atas cakupan parsial (view jendela): komitmen dihitung dari baris
// yang DICAKUP selector, bukan seluruh canonical.
function viewFrontier(
  sessionId: string,
  covered: readonly CanonicalEventRef[],
  baseSeq: number,
  revision = 0,
): ContextFrontier {
  return deriveContextFrontier({
    sessionId,
    baseSeq,
    head: covered[covered.length - 1]!,
    revision,
    historyCommit: deriveHistoryCommit(covered),
  })
}

describe("P3.2 identity equality", () => {
  test("fakta kanonis sama = identity sama (deterministik)", () => {
    const rows = history(5)
    const a = deriveFrontierFromDurable({ sessionId: "s1", rows, revision: 0 })
    const b = deriveFrontierFromDurable({ sessionId: "s1", rows, revision: 0 })
    expect(a).toEqual(b)
    expect(a!.anchorEventId).toBe(b!.anchorEventId)
  })

  test("baseSeq adalah bagian identity (base beda = identity beda)", () => {
    const rows = history(6)
    const full = deriveContextIdentity({ sessionId: "s1", baseSeq: 0, head: rows[5]! })
    const window = deriveContextIdentity({ sessionId: "s1", baseSeq: 3, head: rows[5]! })
    // Jangkar head sama (event kanonis sama) tetapi identity beda: base
    // membedakan view penuh vs view jendela — tak boleh collapse.
    expect(window.anchorEventId).toBe(full.anchorEventId)
    expect(window).not.toEqual(full)
  })
})

describe("P3.2 identity != sequence", () => {
  test("A: seq sama, isi beda = anchor beda (F-05: N→N rewrite terdeteksi)", () => {
    const a = deriveAnchorEventId("s1", "main", row(2, "jawaban-awal"))
    const b = deriveAnchorEventId("s1", "main", row(2, "jawaban-ditulis-ulang"))
    expect(a).not.toBe(b)
  })

  test("A2: rewrite prefix panjang-sama mengubah frontier, bukan seq", () => {
    const before = fullFrontier("s1", [row(0, "a"), row(1, "b"), row(2, "c")])!
    const after = fullFrontier("s1", [row(0, "a"), row(1, "B"), row(2, "c")])!
    expect(before.headSeq).toBe(after.headSeq)
    // Jangkar head SAMA (event head tak berubah) — identity 4-tuple tak
    // cukup. Komitmen isi beda: frontier mendeteksinya sebagai DIVERGED.
    expect(before.anchorEventId).toBe(after.anchorEventId)
    expect(before.historyCommit).not.toBe(after.historyCommit)
    expect(compareContextFrontier(before, after)).toBe("DIVERGED")
    expect(assessContextFreshness(before, after)).toBe("diverged")
  })

  test("B: seq sama di session berbeda = context berbeda (fork tak collision)", () => {
    // branchSession menyalin rows dengan seq SAMA ke id baru — seq bukan
    // primary identity, jadi anchor harus beda.
    const rows = history(4)
    const src = fullFrontier("src-session", rows)!
    const fork = fullFrontier("dst-session", rows)!
    expect(src.anchorEventId).not.toBe(fork.anchorEventId)
    expect(compareContextFrontier(src, fork)).toBe("UNKNOWN")
  })

  test("B2: posisi logis sama, cakupan beda = tak pernah EQUAL", () => {
    const rows = history(6)
    const full = fullFrontier("s1", rows)!
    const window = viewFrontier("s1", [rows[3]!, rows[4]!, rows[5]!], 3)
    expect(full.anchorEventId).toBe(window.anchorEventId)
    expect(full.historyCommit).not.toBe(window.historyCommit)
    expect(compareContextFrontier(full, window)).toBe("DIVERGED")
  })

  test("C: replay tak minting identity baru (JSON round-trip durable stabil)", () => {
    const rows = history(5)
    const before = fullFrontier("s1", rows)!
    // Simulasi tulis→baca durable: JSON round-trip seperti saveSession→loadSession.
    const replayed = JSON.parse(JSON.stringify(rows)) as CanonicalEventRef[]
    const after = fullFrontier("s1", replayed)!
    expect(after).toEqual(before)
  })

  test("D: append memajukan frontier tanpa menulis ulang identity lama", () => {
    const old = fullFrontier("s1", history(3))!
    const snapshot = { ...old }
    const grown = fullFrontier("s1", history(5))!
    expect(old).toEqual(snapshot)
    expect(Object.isFrozen(old)).toBe(true)
    expect(grown.anchorEventId).not.toBe(old.anchorEventId)
    expect(compareContextFrontier(old, grown)).toBe("B_AHEAD")
  })

  test("E: identity selamat dari rekonstruksi ulang (tanpa runtime state)", () => {
    const durableJson = JSON.stringify(history(7))
    const first = deriveFrontierFromDurable({
      sessionId: "s1",
      rows: JSON.parse(durableJson) as CanonicalEventRef[],
      revision: 0,
    })!
    // "Hancurkan" semua referensi: bangun ulang murni dari JSON durable.
    const second = deriveFrontierFromDurable({
      sessionId: "s1",
      rows: JSON.parse(durableJson) as CanonicalEventRef[],
      revision: 0,
    })!
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.threadId).toBe(first.threadId)
    expect(second.baseSeq).toBe(first.baseSeq)
    expect(second.headSeq).toBe(first.headSeq)
    expect(second.anchorEventId).toBe(first.anchorEventId)
    expect(second.revision).toBe(first.revision)
    expect(compareContextFrontier(first, second)).toBe("EQUAL")
  })
})

describe("P3.2 frontier comparison", () => {
  test("EQUAL refleksif untuk derivasi identik", () => {
    const rows = history(4)
    const a = fullFrontier("s1", rows)!
    const b = fullFrontier("s1", rows)!
    expect(compareContextFrontier(a, b)).toBe("EQUAL")
    expect(compareContextFrontier(a, a)).toBe("EQUAL")
  })

  test("append satu sisi = A_AHEAD / B_AHEAD (simetris)", () => {
    const a = fullFrontier("s1", history(3))!
    const b = fullFrontier("s1", history(6))!
    expect(compareContextFrontier(a, b)).toBe("B_AHEAD")
    expect(compareContextFrontier(b, a)).toBe("A_AHEAD")
  })

  test("thread beda dalam session sama = DIVERGED (tabrakan terdeteksi)", () => {
    const rows = history(4)
    const t1 = fullFrontier("s1", rows, 0, "t1")!
    const t2 = fullFrontier("s1", rows, 0, "t2")!
    expect(t1.anchorEventId).not.toBe(t2.anchorEventId)
    expect(compareContextFrontier(t1, t2)).toBe("DIVERGED")
  })

  test("revisi beda = DIVERGED (kompaksi menulis ulang ruang sekuens)", () => {
    // Pra-kompaksi: 101 pesan rev 0. Pasca-kompaksi: ringkasan + 39 pesan rev 1.
    const pre = fullFrontier("s1", history(101), 0)!
    const postRows: CanonicalEventRef[] = [
      row(0, "ringkasan-kompaksi"),
      ...history(39, "baru").map((r) => ({ ...r, seq: r.seq + 1 })),
    ]
    const post = fullFrontier("s1", postRows, 1)!
    // Head menyusut (100 → 39): tanpa revisi ini terbaca "A_AHEAD" — SALAH
    // dan berbahaya. Dengan revisi: DIVERGED, identity lama tetap utuh.
    expect(post.headSeq).toBeLessThan(pre.headSeq)
    expect(compareContextFrontier(pre, post)).toBe("DIVERGED")
    expect(pre.anchorEventId).not.toBe(post.anchorEventId)
  })

  test("session beda = UNKNOWN (tak ada basis bersama)", () => {
    const a = fullFrontier("sa", history(3))!
    const b = fullFrontier("sb", history(3))!
    expect(compareContextFrontier(a, b)).toBe("UNKNOWN")
  })

  test("input invalid = UNKNOWN (null, undefined, bentuk rusak)", () => {
    const good = fullFrontier("s1", history(3))!
    expect(compareContextFrontier(null, good)).toBe("UNKNOWN")
    expect(compareContextFrontier(good, undefined)).toBe("UNKNOWN")
    expect(compareContextFrontier(null, null)).toBe("UNKNOWN")
    expect(compareContextFrontier({ ...good, anchorEventId: "bukan-anchor" }, good)).toBe("UNKNOWN")
    expect(compareContextFrontier({ ...good, revision: -1 }, good)).toBe("UNKNOWN")
  })
})

describe("P3.2 stale / diverged / unknown", () => {
  test("FRESH: frontier sama dengan kanonis", () => {
    const rows = history(5)
    const ctx = fullFrontier("s1", rows)!
    const canonical = fullFrontier("s1", rows)!
    expect(assessContextFreshness(ctx, canonical)).toBe("fresh")
  })

  test("STALE: kanonis append setelah context dibangun", () => {
    const ctx = fullFrontier("s1", history(100))!
    const canonical = fullFrontier("s1", history(103))!
    expect(assessContextFreshness(ctx, canonical)).toBe("stale")
  })

  test("DIVERGED: seq sama, anchor beda (rewrite tanpa revisi)", () => {
    const ctx = fullFrontier("s1", [row(0, "a"), row(1, "b")])!
    const canonical = fullFrontier("s1", [row(0, "a"), row(1, "B")])!
    expect(assessContextFreshness(ctx, canonical)).toBe("diverged")
  })

  test("DIVERGED: revisi kanonis naik (kompaksi di bawah context)", () => {
    const ctx = fullFrontier("s1", history(101), 0)!
    const postRows: CanonicalEventRef[] = [
      row(0, "ringkasan-kompaksi"),
      ...history(39, "baru").map((r) => ({ ...r, seq: r.seq + 1 })),
    ]
    const canonical = fullFrontier("s1", postRows, 1)!
    expect(assessContextFreshness(ctx, canonical)).toBe("diverged")
  })

  test("UNKNOWN: context dari masa depan (revisi melampaui kanonis)", () => {
    const ctx = fullFrontier("s1", history(3), 2)!
    const canonical = fullFrontier("s1", history(3), 1)!
    expect(assessContextFreshness(ctx, canonical)).toBe("unknown")
  })

  test("UNKNOWN: context melampaui head kanonis pada revisi sama", () => {
    const ctx = fullFrontier("s1", history(10))!
    const canonical = fullFrontier("s1", history(7))!
    expect(assessContextFreshness(ctx, canonical)).toBe("unknown")
  })

  test("UNKNOWN: salah satu sisi kosong / invalid", () => {
    const canonical = fullFrontier("s1", history(3))!
    expect(assessContextFreshness(null, canonical)).toBe("unknown")
    expect(assessContextFreshness(canonical, null)).toBe("unknown")
    expect(assessContextFreshness(null, null)).toBe("unknown")
    expect(assessContextFreshness(undefined, canonical)).toBe("unknown")
  })

  test("UNKNOWN: context bukan dari session ini", () => {
    const ctx = fullFrontier("lain", history(3))!
    const canonical = fullFrontier("s1", history(3))!
    expect(assessContextFreshness(ctx, canonical)).toBe("unknown")
  })

  test("FRESH tak bergantung base (view jendela pada head sama tetap fresh)", () => {
    const rows = history(6)
    const window = viewFrontier("s1", [rows[3]!, rows[4]!, rows[5]!], 3)
    const canonical = fullFrontier("s1", rows)!
    // Kesegaran soal head, bukan cakupan: jendela tak basi hanya karena parsial.
    expect(assessContextFreshness(window, canonical)).toBe("fresh")
  })

  test("historyCommit deterministik, sensitif isi, buta urutan input", () => {
    const rows = history(5)
    const shuffled = [rows[3]!, rows[0]!, rows[4]!, rows[1]!, rows[2]!]
    expect(deriveHistoryCommit(shuffled)).toBe(deriveHistoryCommit(rows))
    expect(deriveHistoryCommit([row(0, "a"), row(1, "b")])).not.toBe(
      deriveHistoryCommit([row(0, "a"), row(1, "B")]),
    )
    expect(isHistoryCommit(deriveHistoryCommit(rows))).toBe(true)
    expect(isHistoryCommit("ctxev_00000000000000000000000000000000")).toBe(false)
    expect(() => deriveHistoryCommit([])).toThrow()
    expect(() => deriveHistoryCommit([row(0, "a"), row(0, "b")])).toThrow()
  })
})

describe("P3.2 multi-thread isolation", () => {
  test("append di thread B tak mengubah identity thread A", () => {
    const aBefore = fullFrontier("sA", history(4, "a"), 0, "T1")!
    const bGrown = fullFrontier("sA", history(9, "b"), 0, "T2")!
    const aAfter = fullFrontier("sA", history(4, "a"), 0, "T1")!
    expect(aAfter).toEqual(aBefore)
    expect(compareContextFrontier(aAfter, bGrown)).toBe("DIVERGED")
    expect(assessContextFreshness(aAfter, bGrown)).toBe("unknown")
  })

  test("thread default = main (seam P3.9 tak collision dengan eksplisit)", () => {
    const implicit = fullFrontier("s1", history(3))!
    const explicit = fullFrontier("s1", history(3), 0, "main")!
    expect(implicit.threadId).toBe("main")
    expect(compareContextFrontier(implicit, explicit)).toBe("EQUAL")
  })
})

describe("P3.2 restart reconstruction (gate terpenting)", () => {
  test("durable → hancurkan runtime → rekonstruksi = identity + frontier sama", () => {
    const sessionId = "restart-s1"
    const durable = JSON.stringify(history(8))
    const built = deriveFrontierFromDurable({
      sessionId,
      rows: JSON.parse(durable) as CanonicalEventRef[],
      revision: 0,
    })!
    // Hancurkan: tak ada referensi runtime yang bertahan — hanya string durable.
    const rebuilt = deriveFrontierFromDurable({
      sessionId,
      rows: JSON.parse(durable) as CanonicalEventRef[],
      revision: 0,
    })!
    expect(rebuilt).toEqual(built)
    expect(compareContextFrontier(built, rebuilt)).toBe("EQUAL")
    expect(assessContextFreshness(rebuilt, built)).toBe("fresh")
  })

  test("urutan + referensi event kanonis bertahan (bukan hanya head)", () => {
    const rows = history(5)
    const rebuilt = deriveFrontierFromDurable({
      sessionId: "s1",
      rows: JSON.parse(JSON.stringify(rows)) as CanonicalEventRef[],
      revision: 0,
    })!
    expect(rebuilt.baseSeq).toBe(0)
    expect(rebuilt.headSeq).toBe(4)
    for (const r of rows) {
      const anchor = deriveAnchorEventId("s1", "main", r)
      expect(isAnchorEventId(anchor)).toBe(true)
    }
    // Jangkar head cocok dengan derivasi langsung dari baris durable-nya.
    expect(rebuilt.anchorEventId).toBe(deriveAnchorEventId("s1", "main", rows[4]!))
  })

  test("canonical kosong = null (pemanggil nilai UNKNOWN, bukan error)", () => {
    expect(deriveFrontierFromDurable({ sessionId: "s1", rows: [], revision: 0 })).toBeNull()
  })

  test("rows tak terurut tetap deterministik (diurutkan stabil per seq)", () => {
    const rows = history(5)
    const shuffled = [rows[3]!, rows[0]!, rows[4]!, rows[1]!, rows[2]!]
    const a = deriveFrontierFromDurable({ sessionId: "s1", rows, revision: 0 })!
    const b = deriveFrontierFromDurable({ sessionId: "s1", rows: shuffled, revision: 0 })!
    expect(b).toEqual(a)
  })
})

describe("P3.2 ordering tanpa writer epoch", () => {
  test("append interleave dua penulis tetap comparable (tak perlu epoch)", () => {
    // Dua proses menulis bergantian ke session sama (konkurensi repo ini =
    // busy-retry + INSERT OR IGNORE, tanpa kolom epoch). Canonical akhir =
    // gabungan terurut; snapshot tengah harus comparable, tak pernah DIVERGED
    // pada revisi sama.
    const w1 = [row(0, "w1-a"), row(2, "w1-b"), row(4, "w1-c")]
    const w2 = [row(1, "w2-a"), row(3, "w2-b"), row(5, "w2-c")]
    const snap1 = fullFrontier("s1", w1)!
    const merged = fullFrontier("s1", [...w1, ...w2])!
    expect(compareContextFrontier(snap1, merged)).toBe("B_AHEAD")
    expect(assessContextFreshness(snap1, merged)).toBe("stale")
    // Urutan kedatangan tak memengaruhi hasil: gabungan acak = sama.
    const reshuffled = fullFrontier("s1", [w2[2]!, w1[0]!, w2[0]!, w1[2]!, w2[1]!, w1[1]!])!
    expect(reshuffled).toEqual(merged)
  })
})

describe("P3.2 kompatibilitas P3.1 / M1 correlator", () => {
  test("anchor BUKAN execution id (namespace authority terpisah)", () => {
    const anchor = deriveAnchorEventId("s1", "main", row(0, "x"))
    expect(isAnchorEventId(anchor)).toBe(true)
    expect(isExecutionId(anchor)).toBe(false)
  })

  test("derivasi context abai field korelator (M1 additive-optional tak mengubah identity)", () => {
    const plain = row(1, "isi")
    const withCorrelator = {
      ...plain,
      executionId: "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      rootExecutionId: "exec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }
    const a = deriveAnchorEventId("s1", "main", plain)
    const b = deriveAnchorEventId("s1", "main", withCorrelator)
    expect(b).toBe(a)
  })

  test("anchor tak pernah berbentuk id jurnal session-colon-seq", () => {
    const anchor = deriveAnchorEventId("s1", "main", row(7, "x"))
    expect(anchor.startsWith("ctxev_")).toBe(true)
    expect(anchor).not.toContain(":")
  })
})

describe("P3.2 fail-closed + revision helper", () => {
  test("seq duplikat = canonical korup → throw (jangan tebak)", () => {
    expect(() =>
      deriveFrontierFromDurable({ sessionId: "s1", rows: [row(0, "a"), row(0, "b")], revision: 0 }),
    ).toThrow()
  })

  test("input invalid → throw (identity tak boleh ditebak)", () => {
    const commit = deriveHistoryCommit([row(0, "a")])
    expect(() => deriveContextIdentity({ sessionId: "", baseSeq: 0, head: row(0, "a") })).toThrow()
    expect(() =>
      deriveContextIdentity({ sessionId: "s", baseSeq: -1, head: row(0, "a") }),
    ).toThrow()
    expect(() => deriveContextIdentity({ sessionId: "s", baseSeq: 3, head: row(0, "a") })).toThrow()
    expect(() =>
      deriveContextFrontier({
        sessionId: "s",
        baseSeq: 0,
        head: row(0, "a"),
        revision: -1,
        historyCommit: commit,
      }),
    ).toThrow()
    expect(() =>
      deriveContextFrontier({
        sessionId: "s",
        baseSeq: 0,
        head: row(0, "a"),
        revision: 0,
        historyCommit: "bukan-komitmen",
      }),
    ).toThrow()
  })

  test("countDurableCompactions hanya menghitung marker durable eksak", () => {
    const events = [
      { type: "user.message" },
      { type: "context.compacted" },
      { type: "context:compacted" },
      { type: "context.compacted" },
      { type: "Context.Compacted" },
    ]
    // "context:compacted" (nama bus kernel) dan varian kapital BUKAN marker
    // durable — namespace berbeda, jangan tercampur.
    expect(countDurableCompactions(events)).toBe(2)
    expect(countDurableCompactions([])).toBe(0)
  })

  test("isContextFrontier menolak bentuk rusak", () => {
    const good = fullFrontier("s1", history(2))!
    expect(isContextFrontier(good)).toBe(true)
    expect(isContextFrontier(null)).toBe(false)
    expect(isContextFrontier("s1")).toBe(false)
    expect(isContextFrontier({ ...good, sessionId: "" })).toBe(false)
    expect(isContextFrontier({ ...good, headSeq: 1.5 })).toBe(false)
    expect(isContextFrontier({ ...good, revision: -1 })).toBe(false)
    expect(isContextFrontier({ ...good, anchorEventId: "exec_123" })).toBe(false)
    const { revision: _dropped, ...rest } = good
    expect(_dropped).toBe(0)
    expect(isContextFrontier(rest)).toBe(false)
  })
})
