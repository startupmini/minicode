// P3.7 — Advanced A+C full-coverage fold renderer: tests.
//
// Membuktikan: renderer murni deterministik me-render SELURUH baris kanonik
// [0, N) menjadi satu ringkasan (baseSeq == N, CURRENT-capable); tiap baris
// tepat satu baris ringkasan (bukti cakupan menurut konstruksi); state material
// (goal/keputusan/task/tool/error/fakta) dipertahankan akurat; filler boleh
// dipadatkan; secret di-scrub via path yang SUDAH ADA; baris hilang/tak-
// kontinyu/bentuk tak-didukung → penolakan eksplisit (bukan klaim palsu).

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  produceSummaryProjection,
  readConsumableSummaryProjection,
} from "../src/session/context-projection.ts"
import { selectContext } from "../src/session/context-selector.ts"
import {
  FoldError,
  type FoldSourceRow,
  FULL_HISTORY_FOLD_VERSION,
  renderFullHistoryFold,
} from "../src/session/full-history-fold.ts"
import {
  DEFAULT_THREAD_ID,
  getProjection,
  getProjectionStatus,
  loadThreadHistoryWithSeq,
  SUMMARY_PROJECTION_ID,
  saveSession,
} from "../src/session/persistence.ts"

function rowsOf(msgs: readonly unknown[]): FoldSourceRow[] {
  return msgs.map((message, seq) => ({ seq, message }))
}

const u = (content: string) => ({ role: "user", content })
const a = (content: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content,
  ...extra,
})
const t = (name: string, toolCallId: string, content: unknown, isError = false) => ({
  role: "tool",
  name,
  toolCallId,
  content,
  ...(isError ? { isError: true } : {}),
})

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p37-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

// ── Fold semantics ───────────────────────────────────────────────────────────

test("P3.7-1: histori campuran → satu baris per baris, baseSeq == N", () => {
  const rows = rowsOf([
    u("Goal: migrate auth to src/auth.ts"),
    a("approved, starting now"),
    {
      role: "assistant",
      content: "reading",
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "src/a.ts" } }],
    },
    t("read_file", "c1", "const x = 1"),
    a("done"),
  ])
  const out = renderFullHistoryFold(rows)
  expect(out.baseSeq).toBe(5)
  expect(out.rowCount).toBe(5)
  expect(out.lineCount).toBe(5)
  expect(out.includedRanges).toEqual([[0, 5]])
  expect(out.policyVersion).toBe(FULL_HISTORY_FOLD_VERSION)
})

test("P3.7-2: goal/keputusan/task dipertahankan akurat", () => {
  const rows = rowsOf([
    u("Goal: ship v2; constraint: no network calls"),
    a("Decision: use SQLite; approved by owner"),
    u("Next: write tests, then docs"),
  ])
  const text = renderFullHistoryFold(rows).summaryText
  expect(text).toContain("ship v2")
  expect(text).toContain("no network calls")
  expect(text).toContain("Decision: use SQLite")
  expect(text).toContain("approved by owner")
  expect(text).toContain("write tests")
})

test("P3.7-3: tool action + hasil bermakna + error dipertahankan", () => {
  const rows = rowsOf([
    a("running migration", { toolCalls: [{ id: "c9", name: "bash", args: { cmd: "bun test" } }] }),
    t("bash", "c9", "3 passed, 0 failed"),
    a("retrying", { toolCalls: [{ id: "c10", name: "write_file", args: { path: "out.txt" } }] }),
    t("write_file", "c10", "EACCES: permission denied", true),
  ])
  const text = renderFullHistoryFold(rows).summaryText
  expect(text).toContain("bash")
  expect(text).toContain("bun test")
  expect(text).toContain("3 passed, 0 failed")
  expect(text).toContain("EACCES: permission denied")
  expect(text).toContain("ERROR")
})

test("P3.7-4: fakta eksak dipertahankan (path, hash, angka, error)", () => {
  const rows = rowsOf([
    u("Deploy build 9f3a2c to /srv/app with threshold 128000"),
    t("bash", "c1", "error: ENOENT no such file 'cfg.yaml'"),
  ])
  const text = renderFullHistoryFold(rows).summaryText
  expect(text).toContain("9f3a2c")
  expect(text).toContain("/srv/app")
  expect(text).toContain("128000")
  expect(text).toContain("ENOENT")
})

test("P3.7-5: reasoning/ketidakpastian dipertahankan sebagai penanda", () => {
  const rows = rowsOf([
    a("maybe ok", { reasoning: "not fully verified" }),
    u("Unresolved: which driver?"),
  ])
  const text = renderFullHistoryFold(rows).summaryText
  expect(text).toContain("not fully verified")
  expect(text).toContain("Unresolved: which driver?")
})

test("P3.7-6: secret di-scrub via path yang SUDAH ADA", () => {
  const rows = rowsOf([u("Use api_key = sk-abcdefghijklmnopqrstuvwx for staging")])
  const text = renderFullHistoryFold(rows).summaryText
  expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwx")
  expect(text).toContain("[REDACTED]")
})

test("P3.7-7: deterministik lintas pemanggilan (isi identik byte)", () => {
  const rows = rowsOf([u("hello"), a("world"), t("bash", "c1", "ok")])
  const x = renderFullHistoryFold(rows)
  const y = renderFullHistoryFold(rows)
  expect(x.summaryText).toBe(y.summaryText)
  expect(x).toEqual(y)
})

test("P3.7-8: versi policy terikat pada output", () => {
  const out = renderFullHistoryFold(rowsOf([u("x")]))
  expect(out.policyVersion).toBe("full-history-fold-v1")
})

test("P3.7-9: input tak dimutasi", () => {
  const rows = rowsOf([u("a"), a("b")])
  const before = JSON.stringify(rows)
  renderFullHistoryFold(rows)
  expect(JSON.stringify(rows)).toBe(before)
})

// ── Coverage & identity ──────────────────────────────────────────────────────

test("P3.7-10: baris hilang → tolak (bukan klaim palsu)", () => {
  expect(() =>
    renderFullHistoryFold([
      { seq: 0, message: u("a") },
      { seq: 2, message: u("c") },
    ]),
  ).toThrow(FoldError)
})

test("P3.7-11: histori kosong → tolak", () => {
  expect(() => renderFullHistoryFold([])).toThrow(FoldError)
})

test("P3.7-12: peran tak-didukung → tolak (jangan lewatkan diam)", () => {
  expect(() =>
    renderFullHistoryFold([{ seq: 0, message: { role: "alien", content: "x" } }]),
  ).toThrow(FoldError)
})

test("P3.7-13: tool tanpa identitas → tolak (bukan tebak pairing)", () => {
  expect(() =>
    renderFullHistoryFold([{ seq: 0, message: { role: "tool", content: "x" } }]),
  ).toThrow(FoldError)
})

test("P3.7-14: pesan tanpa konten → tolak", () => {
  expect(() => renderFullHistoryFold([{ seq: 0, message: { role: "user" } }])).toThrow(FoldError)
})

// ── P3.4 integration ─────────────────────────────────────────────────────────

test("P3.7-15: full-history via produsen P3.4 → CURRENT (base_seq == head+1)", async () => {
  const cwd = ws()
  const msgs: unknown[] = []
  for (let i = 0; i < 4; i++) {
    msgs.push({ role: "user", content: `t${i}` })
    msgs.push({ role: "assistant", content: `a${i}` })
  }
  await saveSession("s", cwd, undefined, msgs, { turns: 4 })
  const res = produceSummaryProjection("s", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 2, fold: "full-history" },
  })
  expect(res.produced).toBe(true)
  expect(res.baseSeq).toBe(8)
  const st = getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)
  expect(st.state).toBe("CURRENT")
  // P3.3 mengonsumsi sebagai summary-plus-tail via kontrak yang sudah ada.
  const proj = readConsumableSummaryProjection("s", cwd, DEFAULT_THREAD_ID)
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
  expect(sel.messages[0]!.content).toContain("Previous context")
})

test("P3.7-16: perilaku mechanical default TAK BERUBAH (parsial tetap parsial)", async () => {
  const cwd = ws()
  const msgs: unknown[] = []
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: "user", content: `t${i}` })
    msgs.push({ role: "assistant", content: `a${i}` })
  }
  await saveSession("s", cwd, undefined, msgs, { turns: 6 })
  const res = produceSummaryProjection("s", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 2 },
  })
  expect(res.produced).toBe(true)
  expect(res.baseSeq!).toBeLessThan(12)
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "STALE",
  )
})

test("P3.7-17: produsen HANYA menulis history_projections (kanonik utuh)", async () => {
  const cwd = ws()
  const msgs: unknown[] = []
  for (let i = 0; i < 4; i++) {
    msgs.push({ role: "user", content: `t${i}` })
    msgs.push({ role: "assistant", content: `a${i}` })
  }
  await saveSession("s", cwd, undefined, msgs, { turns: 4 })
  const db = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  const before = JSON.stringify(
    db
      .prepare("SELECT seq, role, content FROM messages WHERE session_id = ? ORDER BY seq")
      .all("s"),
  )
  db.close()
  const res = produceSummaryProjection("s", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 2, fold: "full-history" },
  })
  expect(res.produced).toBe(true)
  expect(getProjection("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)).not.toBeNull()
  const db2 = new Database(join(cwd, ".minicode", "sessions.db"), { readonly: true })
  try {
    expect(
      JSON.stringify(
        db2
          .prepare("SELECT seq, role, content FROM messages WHERE session_id = ? ORDER BY seq")
          .all("s"),
      ),
    ).toBe(before)
  } finally {
    db2.close()
  }
})

// ── Failure ──────────────────────────────────────────────────────────────────

test("P3.7-18: epoch basi → build ditolak, kanonik utuh, tanpa baris", async () => {
  const cwd = ws()
  const msgs: unknown[] = []
  for (let i = 0; i < 4; i++) {
    msgs.push({ role: "user", content: `t${i}` })
    msgs.push({ role: "assistant", content: `a${i}` })
  }
  await saveSession("s", cwd, undefined, msgs, { turns: 4 })
  let threw = false
  try {
    produceSummaryProjection("s", cwd, {
      expectedEpoch: 9999,
      policy: { keepRecentTurns: 2, fold: "full-history" },
    })
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
  expect(getProjection("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd)).toBeNull()
})

test("P3.7-19: ringkasan epoch-valid lalu append → STALE jujur (bukan CURRENT palsu)", async () => {
  const cwd = ws()
  const msgs: unknown[] = []
  for (let i = 0; i < 4; i++) {
    msgs.push({ role: "user", content: `t${i}` })
    msgs.push({ role: "assistant", content: `a${i}` })
  }
  await saveSession("s", cwd, undefined, msgs, { turns: 4 })
  produceSummaryProjection("s", cwd, {
    expectedEpoch: 0,
    policy: { keepRecentTurns: 2, fold: "full-history" },
  })
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "CURRENT",
  )
  await saveSession(
    "s",
    cwd,
    undefined,
    [...msgs, { role: "user", content: "t4" }, { role: "assistant", content: "a4" }],
    { turns: 5 },
    { expectedEpoch: 0 },
  )
  // Head maju → STALE jujur; ringkasan lama tak diklaim CURRENT.
  expect(getProjectionStatus("s", DEFAULT_THREAD_ID, SUMMARY_PROJECTION_ID, cwd).state).toBe(
    "STALE",
  )
})
