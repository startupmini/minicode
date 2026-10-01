// M1 — Execution correlator: allocator tunggal + korelasi + normalisasi legacy.
// Hermetic: tanpa kernel/network; jurnal memakai tmp cwd lokal.

import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  allocateExecutionId,
  allocateUniqueExecutionId,
  createChildCorrelation,
  createRootCorrelation,
  deriveStableExecutionId,
  getExecutionIdMetrics,
  isAllocatedExecutionId,
  isDerivedExecutionId,
  isExecutionId,
  legacyLocatorKeys,
  normalizeLegacyIdentity,
} from "../src/runtime/execution-id.ts"
import {
  appendMutationIntent,
  appendMutationTerminal,
  loadJournal,
} from "../src/session/journal.ts"

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "mc-m1-"))
}

// ── Identity: uniqueness (skala penuh terdokumentasi) ──

test("M1 allocator: 1.000.000 id tanpa collision, format exec_<UUIDv4>", () => {
  const seen = new Set<string>()
  for (let i = 0; i < 1_000_000; i++) {
    const id = allocateExecutionId()
    if (seen.has(id)) throw new Error(`collision at ${i}`)
    seen.add(id)
  }
  const sample = [...seen].slice(0, 1000)
  for (const id of sample) {
    expect(isExecutionId(id)).toBe(true)
    expect(isAllocatedExecutionId(id)).toBe(true)
    expect(isDerivedExecutionId(id)).toBe(false)
    // Nibble versi UUIDv4 eksplisit (offset +5 prefix `exec_`; bukan timestamp/counter/12-hex).
    expect(id.slice(5 + 14, 5 + 15)).toBe("4")
  }
}, 180000)

// ── Mock collision: tanpa overwrite/merge, admission baru ditolak ──

test("M1 allocator: duplikat stub tidak overwrite — id baru + audit collision", () => {
  const dup = allocateExecutionId()
  const known = new Set<string>([dup])
  const before = getExecutionIdMetrics().collisions
  let calls = 0
  const id = allocateUniqueExecutionId(known, () => {
    calls++
    return calls === 1 ? dup : allocateExecutionId()
  })
  expect(id).not.toBe(dup)
  expect(known.has(dup)).toBe(true)
  expect(getExecutionIdMetrics().collisions).toBeGreaterThan(before)
})

// ── Immutability + required fields ──

test("M1 correlation: frozen, required fields ditegakkan (bukan user authority)", () => {
  const root = createRootCorrelation("turn", "sess-1")
  expect(Object.isFrozen(root)).toBe(true)
  expect(root.rootExecutionId).toBe(root.executionId)
  expect(root.parentExecutionId).toBeUndefined()
  expect(() => {
    ;(root as unknown as Record<string, string>).executionId = "exec_x"
  }).toThrow()
  expect(() => createRootCorrelation("turn", "")).toThrow()
  expect(() => createChildCorrelation(root, "child", "")).toThrow()
  expect(() =>
    createChildCorrelation(
      { executionId: "bukan-id", rootExecutionId: root.rootExecutionId },
      "child",
      "sess-1",
    ),
  ).toThrow()
})

test("M1 child: parent/root propagation benar, id baru", () => {
  const parent = createRootCorrelation("turn", "sess-1")
  const child = createChildCorrelation(parent, "child", "sess-1")
  expect(child.executionId).not.toBe(parent.executionId)
  expect(child.parentExecutionId).toBe(parent.executionId)
  expect(child.rootExecutionId).toBe(parent.rootExecutionId)
  expect(child.rootExecutionId).toBe(parent.executionId)
  // Retry TIDAK boleh mutate: attempt baru = child baru (E1 != E2).
  const retry = createChildCorrelation(parent, "child", "sess-1")
  expect(retry.executionId).not.toBe(child.executionId)
  expect(retry.parentExecutionId).toBe(child.parentExecutionId)
})

// ── Derived vs allocated: bentuk berbeda, authority berbeda ──

test("M1 derived: deterministik, stabil, dibedakan dari alokasi", () => {
  const key = legacyLocatorKeys.journal("sess-legacy", 7)
  const a = deriveStableExecutionId(key)
  const b = deriveStableExecutionId(key)
  expect(a).toBe(b)
  expect(isExecutionId(a)).toBe(true)
  expect(isDerivedExecutionId(a)).toBe(true)
  expect(isAllocatedExecutionId(a)).toBe(false)
  expect(deriveStableExecutionId("other")).not.toBe(a)
  expect(() => deriveStableExecutionId("")).toThrow()
})

// ── Legacy normalization: locator stabil vs uncorrelated ──

test("M1 normalize: existing id dipakai (tanpa regenerate); locator stabil konsisten", () => {
  const id = allocateExecutionId()
  expect(normalizeLegacyIdentity({ executionId: id, fallbackGroup: "g" })).toEqual({
    status: "correlated",
    executionId: id,
  })
  const key = legacyLocatorKeys.message("s", 3)
  const first = normalizeLegacyIdentity({ locatorKey: key, fallbackGroup: "g" })
  const second = normalizeLegacyIdentity({ locatorKey: key, fallbackGroup: "g" })
  expect(first.status).toBe("stable-locator")
  expect(second).toEqual(first)
})

test("M1 normalize: tanpa locator = uncorrelated, tanpa UUID per load", () => {
  const a = normalizeLegacyIdentity({ fallbackGroup: "legacy:sess-x" })
  const b = normalizeLegacyIdentity({ fallbackGroup: "legacy:sess-x" })
  expect(a).toEqual({ status: "uncorrelated", group: "legacy:sess-x", uncorrelated: true })
  expect(b).toEqual(a)
  expect("executionId" in a).toBe(false)
})

test("M1 normalize: concurrent loader pada locator sama = id sama", async () => {
  const key = legacyLocatorKeys.claim("t4", 7, 2, "inc-9")
  const results = await Promise.all(
    Array.from({ length: 16 }, async () =>
      normalizeLegacyIdentity({ locatorKey: key, fallbackGroup: "g" }),
    ),
  )
  const ids = new Set(results.map((r) => ("executionId" in r ? r.executionId : "?")))
  expect(ids.size).toBe(1)
})

// ── Persistence: write → load → same; restart (baca-ulang file) → same ──

test("M1 journal: executionId passthrough intent→terminal→load stabil", async () => {
  const cwd = tmpRoot()
  try {
    const root = createRootCorrelation("turn", "m1-sess")
    const intent = await appendMutationIntent({
      session: "m1-sess",
      tool: "write_file",
      cwd,
      executionId: root.executionId,
      rootExecutionId: root.rootExecutionId,
      executionKind: root.kind,
      ownerId: root.ownerId,
    })
    expect(intent.executionId).toBe(root.executionId)
    await appendMutationTerminal(
      "m1-sess",
      cwd,
      intent.id,
      intent.seq,
      "write_file",
      "committed",
      undefined,
      undefined,
      {
        executionId: root.executionId,
        rootExecutionId: root.rootExecutionId,
        executionKind: root.kind,
        ownerId: root.ownerId,
      },
    )
    // Load 1 (proses kini) vs load 2 (simulasi restart: baca file ulang).
    const first = await loadJournal("m1-sess", cwd)
    const second = await loadJournal("m1-sess", cwd)
    const ids = (rs: typeof first.records) =>
      rs.filter((r) => r.id === intent.id).map((r) => r.executionId)
    expect(ids(first.records)).toEqual([root.executionId, root.executionId])
    expect(ids(second.records)).toEqual(ids(first.records))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("M1 journal: record tanpa correlation tetap legacy-valid (old consumer)", async () => {
  const cwd = tmpRoot()
  try {
    const intent = await appendMutationIntent({ session: "m1-legacy", tool: "bash", cwd })
    expect(intent.executionId).toBeUndefined()
    const loaded = await loadJournal("m1-legacy", cwd)
    expect(loaded.records.some((r) => r.id === intent.id)).toBe(true)
    // Normalisasi memakai locator stabil jurnal (session+seq), bukan regenerate.
    const key = legacyLocatorKeys.journal("m1-legacy", intent.seq)
    const n1 = normalizeLegacyIdentity({ locatorKey: key, fallbackGroup: "g" })
    const n2 = normalizeLegacyIdentity({ locatorKey: key, fallbackGroup: "g" })
    expect(n1).toEqual(n2)
    expect(n1.status).toBe("stable-locator")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

// ── Event compatibility: lama terbaca, baru round-trip ──

test("M1 event: Base lama tanpa correlation tetap valid; baru round-trip utuh", async () => {
  const { reduce } = await import("../src/presentation/reducer.ts")
  const { createReducerDiagnostics } = await import("../src/presentation/reducer.ts")
  const { createInitialState } = await import("../src/presentation/model.ts")
  const state = createInitialState("m1-evt")
  const diag = createReducerDiagnostics()
  // Event lama (tanpa correlation) — harus tetap reduce tanpa throw.
  reduce(
    state,
    {
      eventSeq: 1,
      ts: Date.now(),
      sessionId: "m1-evt",
      turnId: 0,
      type: "turn.started",
      promptRef: "p1",
    } as never,
    diag,
  )
  // Event baru dengan correlation — JSON round-trip (encode path) utuh.
  const withCorr = {
    eventSeq: 2,
    ts: Date.now(),
    sessionId: "m1-evt",
    turnId: 0,
    type: "turn.completed",
    summary: {
      toolsOk: 0,
      toolsFailed: 0,
      toolsDenied: 0,
      toolsCancelled: 0,
      toolsInterrupted: 0,
      filesChanged: 0,
      durationMs: 1,
    },
    executionId: allocateExecutionId(),
    rootExecutionId: undefined as never,
  }
  const root = createRootCorrelation("turn", "m1-evt")
  const full = {
    ...withCorr,
    executionId: root.executionId,
    rootExecutionId: root.rootExecutionId,
    executionKind: root.kind,
    ownerId: root.ownerId,
  }
  const revived = JSON.parse(JSON.stringify(full)) as typeof full
  expect(revived.executionId).toBe(root.executionId)
  expect(revived.rootExecutionId).toBe(root.rootExecutionId)
  // Event baru berkorelasi juga harus reduce tanpa throw (field tambahan diabaikan).
  reduce(state, revived as never, diag)
})

// ── Observability minimal M1 ──

test("M1 metrics: allocated/derived/uncorrelated/collisions tercatat", () => {
  const before = getExecutionIdMetrics()
  allocateExecutionId()
  deriveStableExecutionId("m1-metrics-key")
  normalizeLegacyIdentity({ fallbackGroup: "m1-metrics-group" })
  const after = getExecutionIdMetrics()
  expect(after.allocated).toBeGreaterThan(before.allocated)
  expect(after.derived).toBeGreaterThan(before.derived)
  expect(after.uncorrelated).toBeGreaterThan(before.uncorrelated)
})
