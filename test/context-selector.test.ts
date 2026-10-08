// P3.3 — Canonical Context Selector: regression + contract tests.
//
// Setiap test non-vacuous: ada mutasi/properti yang membuatnya gagal bila
// logika seleksi dilewati (lihat §mutation di P3_3_IMPLEMENTATION_REPORT.md).
// Invariant inti: selector derived/read-only, deterministik, provenance-bound,
// sadar-kesegaran (P3.2 deskriptif), sadar-budget, tanpa otoritas kedua.

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { estimateMessage } from "#minicore/core/tokens.ts"
import type { Message } from "#minicore/core/types.ts"
import { stripContextOnly } from "../src/session/context-assembly.ts"
import {
  assessContextFreshness,
  type CanonicalEventRef,
  compareContextFrontier,
  deriveFrontierFromDurable,
  deriveHistoryCommit,
} from "../src/session/context-identity.ts"
import {
  ALL_SELECTION_BASES,
  isSelectionBasis,
  type SelectContextInput,
  safeBaseSeq,
  selectContext,
} from "../src/session/context-selector.ts"
import {
  DEFAULT_THREAD_ID,
  loadThreadHistoryWithSeq,
  saveSession,
} from "../src/session/persistence.ts"

const u = (c: string): Message => ({ role: "user", content: c })
const a = (c: string): Message => ({ role: "assistant", content: c })

/** Baris durable palsu (murni; bentuk {seq, message}). */
function rows(msgs: readonly Message[]): { seq: number; message: Message }[] {
  return msgs.map((m, i) => ({ seq: i, message: m }))
}

const HISTORY = [u("A"), a("B"), u("C"), a("D"), u("E")]

function base(over: Partial<SelectContextInput> = {}): SelectContextInput {
  return {
    sessionId: "s1",
    threadId: DEFAULT_THREAD_ID,
    rows: rows(HISTORY),
    revision: 0,
    policy: { budgetTokens: 100_000 },
    ...over,
  }
}

function contents(msgs: readonly Message[]): unknown[] {
  return msgs.map((m) => (m as { content: unknown }).content)
}

function refFromRow(r: { seq: number; message: unknown }): CanonicalEventRef {
  const m = r.message as { role: string; content: unknown }
  return {
    seq: r.seq,
    role: m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }
}

function frontierOf(input: SelectContextInput, baseSeq = 0) {
  const covered = baseSeq <= 0 ? input.rows : input.rows.filter((r) => r.seq >= baseSeq)
  return deriveFrontierFromDurable({
    sessionId: input.sessionId,
    threadId: input.threadId,
    rows: covered.map(refFromRow),
    revision: input.revision,
  })
}

// ── Basic ────────────────────────────────────────────────────────────────────

test("P3.3-1: empty history → empty view, frontier null, UNKNOWN (tidak melempar)", () => {
  const sel = selectContext(base({ rows: [] }))
  expect(sel.messages).toEqual([])
  expect(sel.frontier).toBeNull()
  expect(sel.freshness).toBe("unknown")
  expect(sel.selectionBasis).toBe("fallback-unknown")
  expect(sel.budget.fits).toBe(true)
})

test("P3.3-2: single event → full-history, frontier mengikat 1 baris", () => {
  const sel = selectContext(base({ rows: rows([u("solo")]) }))
  expect(contents(sel.messages)).toEqual(["solo"])
  expect(sel.selectionBasis).toBe("full-history")
  expect(sel.frontier?.baseSeq).toBe(0)
  expect(sel.frontier?.headSeq).toBe(0)
  expect(sel.source).toBe("messages")
})

test("P3.3-3: normal history → full-history, seluruh baris, urut", () => {
  const sel = selectContext(base())
  expect(contents(sel.messages)).toEqual(["A", "B", "C", "D", "E"])
  expect(sel.selectionBasis).toBe("full-history")
  expect(sel.freshness).toBe("fresh")
  expect(sel.budget.fits).toBe(true)
})

// ── Ordering / identity / frontier ────────────────────────────────────────────

test("P3.3-4: urutan kanonik dipertahankan; tidak ada duplikat", () => {
  const sel = selectContext(base())
  const seqs = sel.messages.length
  expect(seqs).toBe(5)
  expect(contents(sel.messages)).toEqual(["A", "B", "C", "D", "E"])
  expect(new Set(contents(sel.messages)).size).toBe(5)
})

test("P3.3-5: identitas (sessionId, threadId) diteruskan apa adanya", () => {
  const sel = selectContext(base({ sessionId: "sess-x", threadId: "th-9" }))
  expect(sel.sessionId).toBe("sess-x")
  expect(sel.threadId).toBe("th-9")
  expect(sel.frontier?.sessionId).toBe("sess-x")
  expect(sel.frontier?.threadId).toBe("th-9")
})

test("P3.3-6: frontier menyimpan headSeq/lastSeenSeq/revision/historyCommit", () => {
  const sel = selectContext(base({ revision: 3 }))
  expect(sel.frontier?.headSeq).toBe(4)
  expect(sel.frontier?.lastSeenSeq).toBe(4)
  expect(sel.frontier?.revision).toBe(3)
  expect(sel.frontier?.historyCommit).toMatch(/^ctxhist_[0-9a-f]{32}$/)
  // historyCommit == komitmen seluruh cakupan (provenance mengikat isi).
  expect(sel.frontier?.historyCommit).toBe(deriveHistoryCommit(rows(HISTORY).map(refFromRow)))
})

// ── Freshness (P3.2 integration) ──────────────────────────────────────────────

test("P3.3-7: EQUAL — view penuh setara frontier kanonis → fresh", () => {
  const input = base()
  const canonical = frontierOf(input)!
  const sel = selectContext({ ...input, canonicalFrontier: canonical })
  expect(sel.freshness).toBe("fresh")
  expect(compareContextFrontier(sel.frontier!, canonical)).toBe("EQUAL")
})

test("P3.3-8: valid advance — kanonis maju → selector membangun ulang view penuh", () => {
  const prior = selectContext(base())
  // Kanonik maju 1 baris.
  const grown = base({ rows: rows([...HISTORY, a("F")]) })
  const canonical = frontierOf(grown)!
  const sel = selectContext({ ...grown, canonicalFrontier: canonical })
  expect(sel.freshness).toBe("fresh")
  expect(contents(sel.messages)).toEqual(["A", "B", "C", "D", "E", "F"])
  expect(compareContextFrontier(prior.frontier!, sel.frontier!)).toBe("B_AHEAD")
})

test("P3.3-9: DIVERGED — sisi kanonis berbeda isi → label jujur, view kanonik penuh", () => {
  const input = base()
  // Frontier kanonis dengan isi TENGAH berbeda (panjang sama) — F-05.
  const diverged = deriveFrontierFromDurable({
    sessionId: "s1",
    threadId: input.threadId,
    rows: [
      { seq: 0, role: "user", content: "A" },
      { seq: 1, role: "assistant", content: "B" },
      { seq: 2, role: "user", content: "X-diverge" },
      { seq: 3, role: "assistant", content: "D" },
      { seq: 4, role: "user", content: "E" },
    ],
    revision: 0,
  })!
  const sel = selectContext({ ...input, canonicalFrontier: diverged })
  expect(sel.freshness).toBe("diverged")
  expect(sel.selectionBasis).toBe("fallback-unknown")
  // View tetap aman-terlebar (kanonik penuh), bukan dipersempit diam-diam.
  expect(contents(sel.messages)).toEqual(["A", "B", "C", "D", "E"])
})

test("P3.3-10: UNKNOWN — frontier kanonis null → label UNKNOWN, tidak dipromosikan", () => {
  const sel = selectContext(base({ canonicalFrontier: null }))
  expect(sel.freshness).toBe("unknown")
  expect(sel.selectionBasis).toBe("fallback-unknown")
})

test("P3.3-11: laporan P3.2 dipakai apa adanya (assess == selector freshness)", () => {
  const input = base()
  const canonical = frontierOf(input)!
  const sel = selectContext({ ...input, canonicalFrontier: canonical })
  expect(sel.freshness).toBe(assessContextFreshness(sel.frontier!, canonical))
})

// ── Coverage / selection basis ────────────────────────────────────────────────

test("P3.3-12: summary-plus-tail → ringkasan durable + ekor kanonik", () => {
  const input = base({ projection: { baseSeq: 3, summaryText: "ringkas [0,3)" } })
  const sel = selectContext(input)
  expect(sel.selectionBasis).toBe("summary-plus-tail")
  expect(sel.source).toBe("projection")
  expect(sel.coveredSeq).toBe(3)
  expect(sel.messages[0]).toEqual({
    role: "user",
    content: "Previous context [0,3):\nringkas [0,3)",
  })
  expect(contents(sel.messages).slice(1)).toEqual(["D", "E"])
  // Partial coverage eksplisit: baseSeq > 0.
  expect(sel.frontier?.baseSeq).toBe(3)
  // Artefak context-only tersedia untuk jalur persist.
  expect(sel.contextOnly).toEqual({
    role: "user",
    content: "Previous context [0,3):\nringkas [0,3)",
  })
})

test("P3.3-13: summary dengan batas TAK AMAN → jatuh ke histori penuh (bukan split tool)", () => {
  // Pasangan assistant(toolCalls) di seq 2 + tool-result di seq 3; base=3 memotong.
  const toolHistory: Message[] = [
    u("A"),
    a("B"),
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read_file", args: {} }],
    } as Message,
    { role: "tool", toolCallId: "c1", name: "read_file", content: "hasil" } as Message,
  ]
  const input = base({ rows: rows(toolHistory), projection: { baseSeq: 3, summaryText: "r" } })
  const sel = selectContext(input)
  // Batas 3 memisahkan assistant(toolCalls)@2 dari tool-result@3 → tak aman;
  // geser maju ke 4 (> head=3) → mundur ke histori penuh (aman-terlebar).
  expect(sel.selectionBasis).toBe("full-history")
  expect(sel.frontier?.baseSeq).toBe(0)
  expect(contents(sel.messages).length).toBe(4)
  // Tidak ada tool-result yatim (semua 4 baris utuh & berpasangan).
  expect(sel.contextOnly).toBeUndefined()
})

test("P3.3-14: coverage penuh (baseSeq=0) → bukan parsial", () => {
  const sel = selectContext(base())
  expect(sel.frontier?.baseSeq).toBe(0)
  expect(sel.coveredSeq).toBe(0)
  expect(sel.selectionBasis).toBe("full-history")
})

test("P3.3-15: safeBaseSeq menggeser batas tak aman ke batas aman", () => {
  const toolHistory = rows([
    u("A"),
    a("B"),
    { role: "assistant", content: "", toolCalls: [{ id: "c", name: "t", args: {} }] } as Message,
    { role: "tool", toolCallId: "c", name: "t", content: "r" } as Message,
  ])
  // base=3 memotong assistant(toolCalls)@2 dari tool-result@3 → geser ke 4 (>head=3)→0.
  expect(safeBaseSeq(toolHistory, 3)).toBe(0)
  // base=2 aman (memula di assistant; bukan hasil tool yatim di depan).
  expect(safeBaseSeq(toolHistory, 2)).toBe(2)
  // base<=0 selalu penuh.
  expect(safeBaseSeq(toolHistory, 0)).toBe(0)
})

// ── Budget ────────────────────────────────────────────────────────────────────

test("P3.3-16: under budget → full-history, fits=true", () => {
  const sel = selectContext(base({ policy: { budgetTokens: 10_000 } }))
  expect(sel.selectionBasis).toBe("full-history")
  expect(sel.budget.fits).toBe(true)
  expect(sel.budget.estimatedTokens).toBeLessThanOrEqual(10_000)
})

test("P3.3-17: over budget → budget-tail (ekor terbaru), prefix dijatuhkan", () => {
  // Semua pesan `user` pendek: estimator chars/4 → 1 token masing-masing.
  const text = rows([u("A"), u("B"), u("C"), u("D"), u("E")])
  const sel = selectContext(base({ rows: text, policy: { budgetTokens: 2 } }))
  expect(sel.selectionBasis).toBe("budget-tail")
  expect(sel.budget.fits).toBe(true)
  expect(contents(sel.messages)).toEqual(["D", "E"])
  // Partial coverage eksplisit (prefix dijatuhkan = eviction, bukan fold).
  expect(sel.frontier!.baseSeq).toBe(3)
})

test("P3.3-18: budget 0 (satu pesan pun tak muat) → empty view jujur, fits=false", () => {
  const sel = selectContext(base({ policy: { budgetTokens: 0 } }))
  expect(sel.selectionBasis).toBe("budget-tail")
  expect(sel.messages).toEqual([])
  expect(sel.budget.fits).toBe(false)
  expect(sel.detail).toContain("insufficient budget")
})

test("P3.3-19: exact boundary — seluruh histori pas tepat → full-history", () => {
  const est = (t: string) => Math.ceil(t.length / 4)
  const total = rows(HISTORY).reduce((n, r) => n + estimateMessage(r.message, est), 0)
  const sel = selectContext(base({ policy: { budgetTokens: total, estimator: est } }))
  expect(sel.selectionBasis).toBe("full-history")
  expect(sel.budget.estimatedTokens).toBe(total)
  expect(sel.budget.fits).toBe(true)
})

test("P3.3-20: reservedForSystemAndTools diteruskan apa adanya (laporan, bukan keputusan)", () => {
  const sel = selectContext(base({ policy: { budgetTokens: 100, reservedForSystemAndTools: 42 } }))
  expect(sel.budget.reservedForSystemAndTools).toBe(42)
  expect(sel.budget.limitTokens).toBe(100)
})

// ── Determinism ───────────────────────────────────────────────────────────────

test("P3.3-21: determinisme — input identik → hasil setara (JSON sama)", () => {
  const input = base({ projection: { baseSeq: 3, summaryText: "r" }, revision: 2 })
  const s1 = selectContext(input)
  const s2 = selectContext(input)
  expect(JSON.stringify(s1)).toBe(JSON.stringify(s2))
})

test("P3.3-22: determinisme budget-tail — input identik → hasil sama", () => {
  const input = base({ policy: { budgetTokens: 3 } })
  expect(JSON.stringify(selectContext(input))).toBe(JSON.stringify(selectContext(input)))
})

// ── Provenance ────────────────────────────────────────────────────────────────

test("P3.3-23: provenance — historyCommit mengikat isi (mutasi tengah mengubahnya)", () => {
  const s1 = selectContext(base())
  const mutated = rows([u("A"), a("B"), u("C-mutated"), a("D"), u("E")])
  const s2 = selectContext(base({ rows: mutated }))
  expect(s1.frontier!.historyCommit).not.toBe(s2.frontier!.historyCommit)
  expect(s1.frontier!.headSeq).toBe(s2.frontier!.headSeq) // endpoint sama
})

test("P3.3-24: provenance — anchorEventId berubah saat isi kepala berubah", () => {
  const s1 = selectContext(base())
  const s2 = selectContext(base({ rows: rows([u("A"), a("B"), u("C"), a("D"), u("E2")]) }))
  expect(s1.frontier!.anchorEventId).not.toBe(s2.frontier!.anchorEventId)
})

test("P3.3-25: contextOnly round-trips melalui stripContextOnly (kontrak persist P2.8)", () => {
  const sel = selectContext(base({ projection: { baseSeq: 3, summaryText: "r" } }))
  const stripped = stripContextOnly(sel.messages, sel.contextOnly)
  expect(contents(stripped)).toEqual(["D", "E"])
})

// ── Scoping / isolation ───────────────────────────────────────────────────────

test("P3.3-26: scoping — frontier terikat sessionId/threadId yang diminta saja", () => {
  const s1 = selectContext(base({ sessionId: "A", threadId: "t1" }))
  const s2 = selectContext(base({ sessionId: "B", threadId: "t1" }))
  // Isi sama tapi session beda → anchor beda (tidak collision antar-sesi).
  expect(s1.frontier!.anchorEventId).not.toBe(s2.frontier!.anchorEventId)
  expect(s1.sessionId).toBe("A")
  expect(s2.sessionId).toBe("B")
})

test("P3.3-27: scoping — thread berbeda tidak membuat frontier EQUAL", () => {
  const s1 = selectContext(base({ threadId: "main" }))
  const s2 = selectContext(base({ threadId: "other" }))
  expect(compareContextFrontier(s1.frontier!, s2.frontier!)).toBe("DIVERGED")
})

// ── Purity / no mutation ──────────────────────────────────────────────────────

test("P3.3-28: purity — selector tidak memutasi input rows", () => {
  const inputRows = rows(HISTORY)
  const before = JSON.stringify(inputRows)
  selectContext(base({ rows: inputRows, projection: { baseSeq: 3, summaryText: "r" } }))
  expect(JSON.stringify(inputRows)).toBe(before)
})

test("P3.3-29: purity — selector TIDAK menyentuh SQLite (tanpa IO), terbukti via store tak tersentuh", async () => {
  // Bukti struktural: buat store nyata, catat fingerprint, panggil selector
  // dengan data yang sudah dimuat, buktikan DB TIDAK berubah.
  const cwd = mkdtempSync(join(tmpdir(), "mc-p33-"))
  mkdirSync(join(cwd, ".minicode"), { recursive: true })
  await saveSession("s", cwd, undefined, [u("A"), a("B"), u("C")], { t: 1 })
  const dbPath = join(cwd, ".minicode", "sessions.db")
  const fp = () => {
    const db = new Database(dbPath, { readonly: true })
    try {
      return JSON.stringify(
        db
          .prepare(
            "SELECT seq, role, content, event_id FROM messages WHERE session_id='s' ORDER BY seq",
          )
          .all(),
      )
    } finally {
      db.close()
    }
  }
  const before = fp()
  const loaded = loadThreadHistoryWithSeq("s", DEFAULT_THREAD_ID, cwd)
  selectContext({
    sessionId: "s",
    threadId: DEFAULT_THREAD_ID,
    rows: loaded,
    revision: 0,
    policy: { budgetTokens: 100_000 },
  })
  selectContext({
    sessionId: "s",
    threadId: DEFAULT_THREAD_ID,
    rows: loaded,
    revision: 0,
    projection: { baseSeq: 2, summaryText: "r" },
    policy: { budgetTokens: 2 },
  })
  expect(fp()).toBe(before)
})

// ── Selection basis typing ────────────────────────────────────────────────────

test("P3.3-30: SelectionBasis typed — hanya 4 nilai sah, tidak ada string bebas", () => {
  expect(ALL_SELECTION_BASES).toEqual([
    "full-history",
    "summary-plus-tail",
    "budget-tail",
    "fallback-unknown",
  ])
  expect(isSelectionBasis("full-history")).toBe(true)
  expect(isSelectionBasis("budget-tail")).toBe(true)
  expect(isSelectionBasis("llm-ranked")).toBe(false)
  expect(isSelectionBasis("")).toBe(false)
  expect(isSelectionBasis(42)).toBe(false)
})

test("P3.3-31: hasil selalu punya selectionBasis yang sah", () => {
  const cases = [
    base({ rows: [] }),
    base(),
    base({ projection: { baseSeq: 3, summaryText: "r" } }),
    base({ policy: { budgetTokens: 0 } }),
    base({ canonicalFrontier: null }),
  ]
  for (const c of cases) {
    expect(isSelectionBasis(selectContext(c).selectionBasis)).toBe(true)
  }
})

// ── P3.1/P2.7 boundary: selector cannot bypass publication safety ────────────
//
// Selector adalah pembaca murni. Outputnya (mis. budget-tail yang menjatuhkan
// prefix) BUKAN penulisan kanonik. Bila view itu coba dipublikasikan, P2.7
// MENOLAK shrink implisit — selector tak memegang wewenang apa pun atas kanonik.
// Selector sendiri tidak mengimpor persistence.ts (bukti struktural tak menulis).

test("P3.3-32: output budget-tail (prefix dijatuhkan) DITOLAK P2.7 saat dipublikasikan", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mc-p33-bound-"))
  mkdirSync(join(cwd, ".minicode"), { recursive: true })
  // Kanonik penuh (5 pesan).
  await saveSession("s", cwd, undefined, [u("A"), a("B"), u("C"), a("D"), u("E")], { t: 1 })

  // Selector memilih budget-tail (2 user pesan terakhir) dari data KANONIK.
  const loaded = loadThreadHistoryWithSeq("s", DEFAULT_THREAD_ID, cwd)
  const sel = selectContext({
    sessionId: "s",
    threadId: DEFAULT_THREAD_ID,
    rows: loaded,
    revision: 0,
    policy: { budgetTokens: 2 },
  })
  expect(sel.selectionBasis).toBe("budget-tail")

  // "Publikasikan" view terpilih (prefix dijatuhkan) — P2.7 menolak rewrite
  // implisit; kanonik TIDAK tersentuh. Selector tak punya wewenang menembusnya.
  let refused = false
  try {
    await saveSession("s", cwd, undefined, sel.messages, undefined, { expectedEpoch: 0 })
  } catch (e) {
    refused = e instanceof Error && e.name === "RefusedHistoryRewriteError"
  }
  expect(refused).toBe(true)

  // Kanonik utuh (5 baris) — selector tak mengubah apa pun.
  const still = loadThreadHistoryWithSeq("s", DEFAULT_THREAD_ID, cwd)
  expect(still.map((r) => (r.message as { content: unknown }).content)).toEqual([
    "A",
    "B",
    "C",
    "D",
    "E",
  ])
})

test("P3.3-33: selector TIDAK mengimpor persistence (bukti struktural derived-only)", () => {
  // Modul selector hanya mengimpor context-identity (P3.2, murni) +
  // context-assembly (P2.8, murni) + kernel types/tokens. Bukti struktural:
  // sumber tak memuat import persistence/sqlite (tanpa jalur tulis/IO).
  const src = readFileSync(
    join(import.meta.dir, "..", "src", "session", "context-selector.ts"),
    "utf8",
  )
  expect(src).not.toMatch(/from\s+["'].*persistence/)
  expect(src).not.toMatch(/from\s+["']bun:sqlite["']/)
  // Tidak ada pemanggilan runtime clock/random di KODE (determinisme juga
  // dibuktikan langsung oleh P3.3-21/22 via JSON-equality).
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
  expect(code).not.toMatch(/Date\.now\s*\(|Math\.random\s*\(|randomUUID\s*\(/)
})
