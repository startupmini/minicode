// P3.5 — Runtime Context Adapter: tests.
//
// Membuktikan: metadata ContextSelection TERBAWA melewati batas seed (bukan
// hanya messages); ModelContextProvenance DIKONSTRUKSI dan mencapai lifecycle;
// jembatan headless menulis marker durable context.compacted lewat primitif
// yang SUDAH ADA (idempoten, berpagar); UNKNOWN tetap UNKNOWN; dan adapter
// TIDAK BISA menembus batas publikasi P3.1/P2.7.

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliSession } from "../cli/setup.ts"
import {
  attachHeadlessCompactionBridge,
  bridgeCompactionToDurable,
  nextPresentationEventSeq,
  provenanceFromSelection,
  runtimeMetadataFromSelection,
} from "../src/session/context-adapter.ts"
import {
  countDurableCompactions,
  deriveFrontierFromDurable,
} from "../src/session/context-identity.ts"
import { selectContext } from "../src/session/context-selector.ts"
import {
  DEFAULT_THREAD_ID,
  loadPresentationEvents,
  saveSession,
} from "../src/session/persistence.ts"

const u = (content: string) => ({ role: "user", content })
const a = (content: string) => ({ role: "assistant", content })

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p35-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function wsWithConfig(): string {
  const dir = ws()
  writeFileSync(
    join(dir, ".minicode", "config.json"),
    JSON.stringify({
      providers: [{ id: "fake", baseUrl: "http://localhost:9", apiKey: "sk-test", models: ["m"] }],
    }),
    "utf8",
  )
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

const HISTORY = [u("A"), a("B"), u("C"), a("D"), u("E")]
const rowsOf = (msgs: readonly unknown[]) => msgs.map((message, seq) => ({ seq, message }))

function selectFull(sid = "s1", extra: Record<string, unknown> = {}) {
  return selectContext({
    sessionId: sid,
    threadId: DEFAULT_THREAD_ID,
    rows: rowsOf(HISTORY),
    revision: 0,
    policy: { budgetTokens: 100_000 },
    ...extra,
  })
}

// ── Runtime seed: metadata survives ───────────────────────────────────────────

test("P3.5-1: metadata dari ContextSelection TERBAWA (identity/frontier/basis/freshness)", () => {
  const sel = selectFull()
  const meta = runtimeMetadataFromSelection(sel, 0)
  expect(meta.sessionId).toBe("s1")
  expect(meta.threadId).toBe(DEFAULT_THREAD_ID)
  expect(meta.identity).toEqual({
    sessionId: "s1",
    threadId: DEFAULT_THREAD_ID,
    baseSeq: sel.frontier!.baseSeq,
    anchorEventId: sel.frontier!.anchorEventId,
  })
  expect(meta.frontier).toBe(sel.frontier)
  expect(meta.selectionBasis).toBe(sel.selectionBasis)
  expect(meta.freshness).toBe(sel.freshness)
  expect(meta.coveredSeq).toBe(sel.coveredSeq)
})

test("P3.5-2: revision DIPROPAGASI, tak difabricate (dari frontier; fallback kanonis bila frontier null)", () => {
  const sel = selectFull()
  expect(runtimeMetadataFromSelection(sel, 7).revision).toBe(sel.frontier!.revision)
  const empty = selectContext({
    sessionId: "s1",
    threadId: DEFAULT_THREAD_ID,
    rows: [],
    revision: 0,
    policy: { budgetTokens: 100_000 },
  })
  expect(empty.frontier).toBeNull()
  expect(runtimeMetadataFromSelection(empty, 0).revision).toBe(0)
  expect(runtimeMetadataFromSelection(empty, 9).revision).toBe(9)
  expect(runtimeMetadataFromSelection(empty, 9).freshness).toBe("unknown")
})

test("P3.5-3: UNKNOWN tetap UNKNOWN (seleksi kosong → provenance absen, tak dikarang)", () => {
  const empty = selectContext({
    sessionId: "s1",
    threadId: DEFAULT_THREAD_ID,
    rows: [],
    revision: 0,
    policy: { budgetTokens: 100_000 },
  })
  const meta = runtimeMetadataFromSelection(empty, 0)
  expect(meta.frontier).toBeNull()
  expect(meta.identity).toBeNull()
  expect(meta.freshness).toBe("unknown")
  expect(meta.provenance).toBeUndefined()
  expect(provenanceFromSelection(empty)).toBeUndefined()
})

// ── Provenance ────────────────────────────────────────────────────────────────

test("P3.5-4: ModelContextProvenance DIKONSTRUKSI dari seleksi (identity + frontier + basis)", () => {
  const sel = selectFull()
  const prov = provenanceFromSelection(sel)
  expect(prov).toBeDefined()
  expect(prov!.contextIdentity).toEqual({
    sessionId: "s1",
    threadId: DEFAULT_THREAD_ID,
    baseSeq: sel.frontier!.baseSeq,
    anchorEventId: sel.frontier!.anchorEventId,
  })
  expect(prov!.canonicalFrontier).toBe(sel.frontier!)
  expect(prov!.selectionBasis).toBe(sel.selectionBasis)
  // projectionRevision TIDAK dikarang (seleksi bukan dari proyeksi berversi).
  expect("projectionRevision" in prov!).toBe(false)
  // Terbawa dalam carrier metadata (satu sumber, tanpa skema ganda).
  expect(runtimeMetadataFromSelection(sel, 0).provenance).toEqual(prov)
})

// ── Runtime seed integration (real production path) ───────────────────────────

test("P3.5-5: resume nyata mengekspos runtimeContextMetadata (produksi, bukan mock)", async () => {
  const cwd = wsWithConfig()
  await saveSession("r1", cwd, undefined, [u("A"), a("B"), u("C")], { turns: 2 })
  const cli = await createCliSession(baseOpts(cwd, { resumeId: "r1" }))
  try {
    const meta = cli.runtimeContextMetadata
    expect(meta).toBeDefined()
    expect(meta!.sessionId).toBe("r1")
    expect(meta!.threadId).toBe(DEFAULT_THREAD_ID)
    expect(meta!.frontier).not.toBeNull()
    expect(meta!.frontier!.headSeq).toBe(2)
    expect(meta!.selectionBasis).toBe("full-history")
    expect(meta!.freshness).toBe("fresh")
    expect(meta!.provenance).toBeDefined()
    expect(meta!.provenance!.selectionBasis).toBe("full-history")
    // Hanya messages yang masuk kernel — metadata tetap host-side.
    expect(cli.session.state.history.map((m) => (m as { content: unknown }).content)).toEqual([
      "A",
      "B",
      "C",
    ])
  } finally {
    await cli.close()
  }
})

test("P3.5-6: sesi BARU (tanpa resume) → metadata absen (tak ada klaim kesegaran)", async () => {
  const cwd = wsWithConfig()
  const cli = await createCliSession(baseOpts(cwd, { sessionId: "fresh-id" }))
  try {
    expect(cli.runtimeContextMetadata).toBeUndefined()
  } finally {
    await cli.close()
  }
})

// ── Identity/frontier isolation through the adapter ───────────────────────────

test("P3.5-7: scoping — metadata sesi A tak bisa dipakai untuk sesi B", () => {
  const s1 = selectFull("A")
  const s2 = selectFull("B")
  const m1 = runtimeMetadataFromSelection(s1, 0)
  const m2 = runtimeMetadataFromSelection(s2, 0)
  expect(m1.frontier!.anchorEventId).not.toBe(m2.frontier!.anchorEventId)
  expect(m1.provenance!.contextIdentity.sessionId).toBe("A")
  expect(m2.provenance!.contextIdentity.sessionId).toBe("B")
})

// ── Headless compaction bridge ────────────────────────────────────────────────

test("P3.5-8: jembatan headless menulis marker durable (produksi nyata)", async () => {
  const cwd = ws()
  await saveSession("h1", cwd, undefined, [u("A"), a("B")], { turns: 1 })
  const before = countDurableCompactions(loadPresentationEvents("h1", cwd))
  const res = await bridgeCompactionToDurable({
    sessionId: "h1",
    cwd,
    expectedEpoch: 0,
    reason: "test-headless",
    turnId: 1,
    ts: 1_700_000_000_000,
  })
  expect(res.bridged).toBe(true)
  const after = countDurableCompactions(loadPresentationEvents("h1", cwd))
  expect(after).toBe(before + 1)
  // Marker membawa identitas + reason (provenance minimal).
  const last = loadPresentationEvents("h1", cwd).at(-1)!
  expect(last.type).toBe("context.compacted")
  expect((last as { reason?: unknown }).reason).toBe("test-headless")
})

test("P3.5-9: attachHeadlessCompactionBridge — event bus kernel → durable (produksi)", async () => {
  const cwd = ws()
  await saveSession("h2", cwd, undefined, [u("A"), a("B")], { turns: 1 })
  // Bus buatan meniru EventBus kernel (on mengembalikan detach).
  const handlers = new Map<string, Set<(e: { reason?: unknown }) => void>>()
  const bus = {
    on(type: "context:compacted", handler: (e: { reason?: unknown }) => void) {
      const set = handlers.get(type) ?? new Set<(e: { reason?: unknown }) => void>()
      set.add(handler)
      handlers.set(type, set)
      return () => {
        set.delete(handler)
      }
    },
    emit(type: "context:compacted", event: { reason?: unknown }) {
      for (const h of [...(handlers.get(type) ?? [])]) h(event)
    },
  }
  const detach = attachHeadlessCompactionBridge({
    sessionId: "h2",
    cwd,
    events: bus,
    epochOf: () => 0,
  })
  const before = countDurableCompactions(loadPresentationEvents("h2", cwd))
  bus.emit("context:compacted", { reason: "pressure:high" })
  // Bridge fire-and-forget; tunggu tulis durable.
  for (
    let i = 0;
    i < 50 && countDurableCompactions(loadPresentationEvents("h2", cwd)) === before;
    i++
  ) {
    await Bun.sleep(20)
  }
  detach()
  expect(countDurableCompactions(loadPresentationEvents("h2", cwd))).toBe(before + 1)
})

test("P3.5-10: pengiriman ulang aman (idempoten primitif) — event sama → dedup", async () => {
  const cwd = ws()
  await saveSession("h3", cwd, undefined, [u("A"), a("B")], { turns: 1 })
  const seq = nextPresentationEventSeq("h3", cwd)
  const first = await bridgeCompactionToDurable({
    sessionId: "h3",
    cwd,
    expectedEpoch: 0,
    reason: "same",
    turnId: 1,
    ts: 1000,
    eventSeq: seq,
  })
  expect(first.bridged).toBe(true)
  // Ulangi dengan IDENTITAS SAMA (eventSeq + payload sama) → dedup, bukan ganda.
  const second = await bridgeCompactionToDurable({
    sessionId: "h3",
    cwd,
    expectedEpoch: 0,
    reason: "same",
    turnId: 1,
    ts: 1000,
    eventSeq: seq,
  })
  expect(second.bridged).toBe(false)
  expect(second.detail).toContain("dup=1")
  expect(countDurableCompactions(loadPresentationEvents("h3", cwd))).toBe(1)
})

test("P3.5-11: kegagalan bridge TIDAK merusak kanonik (epoch salah → ditolak eksplisit)", async () => {
  const cwd = ws()
  await saveSession("h4", cwd, undefined, [u("A"), a("B")], { turns: 1 })
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  const before = JSON.stringify(
    db
      .prepare("SELECT seq, role, content FROM messages WHERE session_id = ? ORDER BY seq")
      .all("h4"),
  )
  db.close()
  const res = await bridgeCompactionToDurable({
    sessionId: "h4",
    cwd,
    expectedEpoch: 9999,
    reason: "x",
    turnId: 1,
  })
  expect(res.bridged).toBe(false)
  const db2 = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    expect(
      JSON.stringify(
        db2
          .prepare("SELECT seq, role, content FROM messages WHERE session_id = ? ORDER BY seq")
          .all("h4"),
      ),
    ).toBe(before)
  } finally {
    db2.close()
  }
  // DAN marker tak tertulis (revision tak maju).
  expect(countDurableCompactions(loadPresentationEvents("h4", cwd))).toBe(0)
})

// ── Freshness through the carried metadata ────────────────────────────────────

test("P3.5-12: kesegaran dari metadata yang dibawa (EQUAL/STALE/DIVERGED/UNKNOWN)", () => {
  const input = {
    sessionId: "s1",
    threadId: DEFAULT_THREAD_ID,
    rows: rowsOf(HISTORY),
    revision: 0,
    policy: { budgetTokens: 100_000 },
  } as const
  const canonical = deriveFrontierFromDurable({
    sessionId: "s1",
    threadId: DEFAULT_THREAD_ID,
    rows: rowsOf(HISTORY).map((r) => ({
      seq: r.seq,
      role: (r.message as { role: string }).role,
      content: String((r.message as { content: unknown }).content),
    })),
    revision: 0,
  })!
  // EQUAL → fresh.
  const fresh = selectContext({ ...input, canonicalFrontier: canonical })
  expect(runtimeMetadataFromSelection(fresh, 0).freshness).toBe("fresh")
  // UNKNOWN (null) → unknown, provenance absen bila frontier null.
  const unk = selectContext({ ...input, canonicalFrontier: null })
  expect(runtimeMetadataFromSelection(unk, 0).freshness).toBe("unknown")
  // DIVERGED → fallback-unknown tetap dilabeli (tak dipromosikan).
  const diverged = deriveFrontierFromDurable({
    sessionId: "s1",
    threadId: DEFAULT_THREAD_ID,
    rows: rowsOf(HISTORY).map((r, i) => ({
      seq: r.seq,
      role: (r.message as { role: string }).role,
      content: i === 2 ? "X-diverge" : String((r.message as { content: unknown }).content),
    })),
    revision: 0,
  })!
  const div = selectContext({ ...input, canonicalFrontier: diverged })
  expect(runtimeMetadataFromSelection(div, 0).freshness).toBe("diverged")
  expect(runtimeMetadataFromSelection(div, 0).selectionBasis).toBe("fallback-unknown")
})

// ── Publication boundary (adapter cannot write canonical) ─────────────────────

test("P3.5-13: adapter TAK BISA menulis kanonik (struktural: tanpa import persistence-writer)", () => {
  // Modul adapter HANYA boleh menulis lewat appendPresentationEvents (jembatan
  // presentation-event); tak ada jalur ke saveSession/messages. Bukti: sumber
  // tak memuat import saveSession/persistence-writer.
  const src = readFileSync(
    join(import.meta.dir, "..", "src", "session", "context-adapter.ts"),
    "utf8",
  )
  expect(src).not.toMatch(/saveSession|shrinkThreadHistory/)
  expect(src).not.toMatch(/from\s+["']bun:sqlite["']/)
  expect(src).not.toMatch(/INSERT INTO messages|UPDATE messages|DELETE FROM messages/)
})
