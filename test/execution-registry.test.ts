// M2 — Read-only execution registry: observasi RAM, bukan authority.
// Hermetic: tanpa kernel/network/persistence.

import { expect, test } from "bun:test"
import {
  allocateExecutionId,
  createChildCorrelation,
  createRootCorrelation,
} from "../src/runtime/execution-id.ts"
import { createExecutionRegistry, isTerminalSnapshot } from "../src/runtime/execution-registry.ts"

function liveEntry(id: string, extra: Record<string, unknown> = {}) {
  return {
    executionId: id,
    rootExecutionId: id,
    kind: "turn" as const,
    ownerId: "sess-1",
    stateSnapshot: "RUNNING",
    ...extra,
  }
}

// R1 — Registration
test("R1 registration: create → entry exists", () => {
  const reg = createExecutionRegistry()
  const id = allocateExecutionId()
  expect(reg.find(id)).toBeUndefined()
  reg.observe(liveEntry(id))
  expect(reg.find(id)?.executionId).toBe(id)
  expect(reg.size()).toBe(1)
})

// R2 — Lookup
test("R2 lookup: metadata benar; miss terhitung", () => {
  const reg = createExecutionRegistry()
  const id = allocateExecutionId()
  reg.observe(liveEntry(id, { backendRef: "host:pid-1", deadlineRef: 900_000 }))
  const found = reg.find(id)
  expect(found?.backendRef).toBe("host:pid-1")
  expect(found?.deadlineRef).toBe(900_000)
  expect(reg.find("exec_00000000-0000-4000-8000-000000000000")).toBeUndefined()
  const m = reg.metrics()
  expect(m.lookupHit).toBe(1)
  expect(m.lookupMiss).toBe(1)
})

// R3/R8 — Inspect defensif
test("R3+R8 inspect: frozen snapshot; mutasi hasil tak menyentuh internal", () => {
  const reg = createExecutionRegistry()
  const id = allocateExecutionId()
  reg.observe(liveEntry(id))
  const snap = reg.inspect(id)
  expect(Object.isFrozen(snap)).toBe(true)
  expect(() => {
    ;(snap as unknown as Record<string, string>).stateSnapshot = "COMPLETED"
  }).toThrow()
  expect(reg.find(id)?.stateSnapshot).toBe("RUNNING")
  // Dua inspect = dua copy berbeda (bukan reference internal).
  expect(reg.inspect(id)).not.toBe(reg.inspect(id))
  expect(reg.inspect(id)).toEqual(reg.inspect(id))
})

// R4 — List
test("R4 list: semua terdaftar, terurut updatedAt", () => {
  const reg = createExecutionRegistry()
  const ids = [allocateExecutionId(), allocateExecutionId(), allocateExecutionId()]
  reg.observe(liveEntry(ids[1]!, {}), 3000)
  reg.observe(liveEntry(ids[0]!), 1000)
  reg.observe(liveEntry(ids[2]!), 2000)
  const list = reg.list()
  expect(list.map((s) => s.executionId)).toEqual([ids[0]!, ids[2]!, ids[1]!])
  expect(Object.isFrozen(list[0])).toBe(true)
})

// R5 — Terminal retention/cleanup bounded (TTL = retensi memori, bukan lifecycle)
test("R5 terminal: sticky + TTL sweep + bukan bukti selesai", () => {
  const reg = createExecutionRegistry({ terminalTtlMs: 1000 })
  const id = allocateExecutionId()
  reg.observe(liveEntry(id), 0)
  reg.observe({ ...liveEntry(id), stateSnapshot: "COMPLETED" }, 500)
  expect(reg.find(id)?.stateSnapshot).toBe("COMPLETED")
  expect(reg.sweep(1499)).toBe(0)
  expect(reg.sweep(1500)).toBe(1)
  expect(reg.find(id)).toBeUndefined()
  expect(reg.metrics().terminalCleanup).toBe(1)
  // Live tak tersapu TTL.
  const live = allocateExecutionId()
  reg.observe(liveEntry(live), 0)
  expect(reg.sweep(999_999)).toBe(0)
  expect(reg.find(live)?.stateSnapshot).toBe("RUNNING")
})

// R6 — Restart: registry baru kosong; bukan bukti hilang dari durable
test("R6 restart: registry baru kosong (RAM-only, normal)", () => {
  const before = createExecutionRegistry()
  before.observe(liveEntry(allocateExecutionId()))
  expect(before.size()).toBe(1)
  const after = createExecutionRegistry()
  expect(after.size()).toBe(0)
  expect(after.list()).toEqual([])
})

// R7 + negative authority: API mutasi otoritatif TIDAK ADA
test("R7 negative authority: complete/fail/cancel/setState tak tersedia", () => {
  const reg = createExecutionRegistry()
  const id = allocateExecutionId()
  reg.observe(liveEntry(id))
  const api = reg as unknown as Record<string, unknown>
  for (const forbidden of [
    "complete",
    "fail",
    "cancel",
    "timeout",
    "setState",
    "mutate",
    "transition",
    "write",
    "persist",
    "save",
  ]) {
    expect(api[forbidden], forbidden).toBeUndefined()
  }
  // Satu-satunya jalur tulis = observe(); invalid id ditolak (fail-closed).
  expect(() => reg.observe({ ...liveEntry(id), executionId: "bukan-id" })).toThrow()
  expect(() => reg.observe({ ...liveEntry(id), executionId: "" })).toThrow()
  expect(reg.find(id)?.stateSnapshot).toBe("RUNNING")
})

// R9 — Parent/root metadata
test("R9 parent/root: child terkorelasi tanpa detached semantics", () => {
  const reg = createExecutionRegistry()
  const parent = createRootCorrelation("turn", "sess-1")
  const child = createChildCorrelation(parent, "child", "sess-1")
  reg.observe({
    executionId: parent.executionId,
    rootExecutionId: parent.rootExecutionId,
    kind: parent.kind,
    ownerId: parent.ownerId,
    stateSnapshot: "RUNNING",
  })
  reg.observe({
    executionId: child.executionId,
    parentExecutionId: child.parentExecutionId,
    rootExecutionId: child.rootExecutionId,
    kind: child.kind,
    ownerId: child.ownerId,
    stateSnapshot: "RUNNING",
  })
  const c = reg.find(child.executionId)
  expect(c?.parentExecutionId).toBe(parent.executionId)
  expect(c?.rootExecutionId).toBe(parent.rootExecutionId)
  // Parent invalid ditebak? tidak — observe menolak.
  expect(() =>
    reg.observe({ ...liveEntry(allocateExecutionId()), parentExecutionId: "xxx" }),
  ).toThrow()
})

// R10 — Multiple executions tanpa collision
test("R10 multi: E1/E2/E3 independen", () => {
  const reg = createExecutionRegistry()
  const ids = [allocateExecutionId(), allocateExecutionId(), allocateExecutionId()]
  for (const [i, id] of ids.entries()) {
    reg.observe(liveEntry(id, { ownerId: `sess-${i}` }))
  }
  expect(reg.size()).toBe(3)
  expect(reg.find(ids[1]!)?.ownerId).toBe("sess-1")
})

// R11 — Concurrency: parallel register + inspect deterministik
test("R11 concurrency: 200 parallel observe + inspect tanpa torn object", async () => {
  const reg = createExecutionRegistry()
  const ids = Array.from({ length: 200 }, () => allocateExecutionId())
  await Promise.all(ids.map((id) => (async () => reg.observe(liveEntry(id)))()))
  expect(reg.size()).toBe(200)
  const snaps = await Promise.all(ids.map((id) => (async () => reg.find(id))()))
  expect(new Set(snaps.map((s) => s?.executionId)).size).toBe(200)
  for (const s of snaps) expect(Object.isFrozen(s)).toBe(true)
})

// R12 — Stale + kontestasi: retensi deterministik, BUKAN arbitrasi authority.
test("R12 stale: non-terminal telat diabaikan; terminal konflik = contested, bukan winner", () => {
  const reg = createExecutionRegistry()
  const id = allocateExecutionId()
  reg.observe(liveEntry(id), 100)
  reg.observe({ ...liveEntry(id), stateSnapshot: "FAILED" }, 200)
  // Observasi telat non-terminal (event basi tiba sesudah terminal) = stale, ditolak.
  reg.observe({ ...liveEntry(id), stateSnapshot: "RUNNING" }, 300)
  expect(reg.find(id)?.stateSnapshot).toBe("FAILED")
  expect(reg.find(id)?.contested).toBeUndefined()
  // Terminal kedua berbeda = KONTESTASI: retensi pertama + flag, bukan keputusan menang.
  reg.observe({ ...liveEntry(id), stateSnapshot: "CANCELLED" }, 400)
  const snap = reg.find(id)
  expect(snap?.stateSnapshot).toBe("FAILED")
  expect(snap?.contested).toBe(true)
  const m = reg.metrics()
  expect(m.staleObservation).toBe(1)
  expect(m.conflictingTerminal).toBe(1)
  expect(isTerminalSnapshot("COMPLETED")).toBe(true)
  expect(isTerminalSnapshot("RUNNING")).toBe(false)
})

// Out-of-order A/B/C: urutan observasi tidak menetapkan lifecycle authority.
for (const [name, first, second] of [
  ["A: COMPLETED lalu CANCELLED", "COMPLETED", "CANCELLED"],
  ["B: CANCELLED lalu COMPLETED", "CANCELLED", "COMPLETED"],
] as const) {
  test(`R-order ${name} → retained-first + contested (bukan winner)`, () => {
    const reg = createExecutionRegistry()
    const id = allocateExecutionId()
    reg.observe(liveEntry(id), 100)
    reg.observe({ ...liveEntry(id), stateSnapshot: first }, 200)
    reg.observe({ ...liveEntry(id), stateSnapshot: second }, 300)
    const snap = reg.find(id)
    // Retensi deterministik anti-flap: yang pertama disimpan...
    expect(snap?.stateSnapshot).toBe(first)
    // ...tetapi DITANDAI terkontestasi: pembaca dilarang menjadikannya authority.
    expect(snap?.contested).toBe(true)
    expect(reg.metrics().conflictingTerminal).toBe(1)
  })
}

test("R-order C: event lama tiba belakangan → stale, snapshot tak mundur", () => {
  const reg = createExecutionRegistry()
  const id = allocateExecutionId()
  reg.observe(liveEntry(id), 100)
  reg.observe({ ...liveEntry(id), stateSnapshot: "TIMED_OUT" }, 200)
  // Event lama (mis. RUNNING dari buffer basi) tiba belakangan.
  reg.observe({ ...liveEntry(id), stateSnapshot: "RUNNING" }, 50)
  expect(reg.find(id)?.stateSnapshot).toBe("TIMED_OUT")
  expect(reg.metrics().staleObservation).toBe(1)
})

test("R-authority: observation order does not establish lifecycle authority", () => {
  const reg = createExecutionRegistry()
  const api = reg as unknown as Record<string, unknown>
  // Tak ada API yang mengklaim/menetapkan pemenang lifecycle.
  for (const forbidden of [
    "complete",
    "fail",
    "cancel",
    "timeout",
    "transition",
    "setState",
    "resolve",
    "arbitrate",
    "commitTerminal",
    "winner",
  ]) {
    expect(api[forbidden], forbidden).toBeUndefined()
  }
  // Snapshot terkontestasi tetap membawa flag — kontrak "jangan baca sebagai truth".
  const id = allocateExecutionId()
  reg.observe(liveEntry(id), 1)
  reg.observe({ ...liveEntry(id), stateSnapshot: "COMPLETED" }, 2)
  reg.observe({ ...liveEntry(id), stateSnapshot: "CANCELLED" }, 3)
  expect(reg.find(id)?.contested).toBe(true)
})

// Bound memori: cap + evict terminal-tertua-dulu, terhitung
test("R-bound: maxEntries evict terminal tertua; live dilindungi kecuali penuh", () => {
  const reg = createExecutionRegistry({ maxEntries: 3, terminalTtlMs: 60_000 })
  const [a, b, c, d] = [
    allocateExecutionId(),
    allocateExecutionId(),
    allocateExecutionId(),
    allocateExecutionId(),
  ]
  reg.observe(liveEntry(a), 10)
  reg.observe({ ...liveEntry(b), stateSnapshot: "COMPLETED" }, 20)
  reg.observe({ ...liveEntry(c), stateSnapshot: "FAILED" }, 30)
  reg.observe({ ...liveEntry(d), stateSnapshot: "CANCELLED" }, 40)
  expect(reg.size()).toBe(3)
  expect(reg.find(a)?.stateSnapshot).toBe("RUNNING")
  expect(reg.find(b)).toBeUndefined()
  expect(reg.metrics().evicted).toBe(1)
})

// Owner/kind/backendRef hanya metadata (bukan otorisasi/grant/kill)
test("R-meta: owner/kind/backendRef tersimpan tanpa makna otoritas", () => {
  const reg = createExecutionRegistry()
  const id = allocateExecutionId()
  reg.observe(liveEntry(id, { kind: "child", ownerId: "task-t4", backendRef: "docker:abc" }))
  const s = reg.inspect(id)
  expect(s?.kind).toBe("child")
  expect(s?.ownerId).toBe("task-t4")
  expect(s?.backendRef).toBe("docker:abc")
  // Tak ada API otorisasi/grant/kill pada registry.
  const api = reg as unknown as Record<string, unknown>
  for (const forbidden of ["authorize", "grant", "kill", "terminate", "allow", "deny"]) {
    expect(api[forbidden], forbidden).toBeUndefined()
  }
})
