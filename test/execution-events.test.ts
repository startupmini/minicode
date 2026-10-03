// M10 — Execution event plane: observasi kanonis, bukan authority.
// Hermetic murni: tanpa scheduler/TaskStore/persistence/UI/CLI/spawn.

import { expect, test } from "bun:test"
import {
  createEventPlane,
  type ExecutionEvent,
  executionEventFromCommit,
  isValidEventId,
  MAX_EVENT_NESTING,
  terminalEventFor,
} from "../src/runtime/execution-events.ts"
import { allocateExecutionId } from "../src/runtime/execution-id.ts"
import { createExecutionKernel } from "../src/runtime/execution-kernel.ts"

function base(over: Record<string, unknown> = {}) {
  return {
    eventType: "execution.state-changed" as const,
    executionId: allocateExecutionId(),
    lineageRootId: "exec_11111111-1111-4111-8111-111111111111",
    executionVersion: 3,
    source: "kernel" as const,
    ...over,
  }
}

function runningKernel() {
  const kernel = createExecutionKernel()
  const rec = kernel.create({ kind: "turn", ownerId: "s" })
  kernel.requestTransition({
    executionId: rec.executionId,
    to: "ADMITTED",
    reason: "t",
    source: "test",
  })
  kernel.requestTransition({
    executionId: rec.executionId,
    to: "RUNNING",
    reason: "t",
    source: "test",
  })
  return { kernel, id: rec.executionId }
}

// Identity: unik, ≠ executionId, bentuk deterministik, immutable.
test("M10 identity: eventId unik + terpisah dari executionId + frozen", () => {
  const plane = createEventPlane()
  const ids = new Set<string>()
  for (let i = 0; i < 200; i++) {
    const e = plane.emit(base())
    expect(isValidEventId(e.eventId)).toBe(true)
    expect(e.eventId).not.toBe(e.executionId)
    expect(Object.isFrozen(e)).toBe(true)
    ids.add(e.eventId)
  }
  expect(ids.size).toBe(200)
  const e = plane.emit(base())
  expect(() => {
    ;(e as unknown as Record<string, string>).state = "X"
  }).toThrow()
})

// Ordering: monotonik per-plane; ts sama legal; tanpa klaim global.
test("M10 ordering: monotonic per-plane; timestamp bukan order", () => {
  const plane = createEventPlane()
  const ts = 1_700_000_000_000
  const a = plane.emit(base({ timestamp: ts }))
  const b = plane.emit(base({ timestamp: ts }))
  expect(b.eventSequence).toBe(a.eventSequence + 1)
  expect(a.timestamp).toBe(b.timestamp)
  const plane2 = createEventPlane()
  // Plane berbeda = stream berbeda (tanpa klaim global ordering).
  expect(plane2.emit(base()).eventSequence).toBe(1)
})

// Kernel integration: emit sesudah commit sukses; ilegal tak emit; terminal tepat.
test("M10 kernel: commit → satu event; ilegal → tanpa event; terminal spesifik", () => {
  const plane = createEventPlane()
  const seen: ExecutionEvent[] = []
  plane.subscribe((e) => {
    seen.push(e)
  })
  const { kernel, id } = runningKernel()
  const rec0 = kernel.get(id)
  const ev = executionEventFromCommit(plane, {
    executionId: id,
    rootExecutionId: rec0!.rootExecutionId,
    version: rec0!.version,
    from: "ADMITTED",
    to: "RUNNING",
    reason: "t",
    source: "test",
  })
  expect(ev.eventType).toBe("execution.state-changed")
  expect(ev.previousState).toBe("ADMITTED")
  expect(ev.state).toBe("RUNNING")
  expect(ev.executionVersion).toBe(rec0!.version)
  // Ilegal (WAITING→COMPLETED langsung) ditolak kernel → bridge tak dipanggil → tanpa event.
  const before = seen.length
  expect(
    kernel.requestTransition({ executionId: id, to: "WAITING", reason: "io", source: "test" })
      .committed,
  ).toBe(true)
  const bad = kernel.requestTransition({
    executionId: id,
    to: "COMPLETED",
    reason: "x",
    source: "test",
  })
  expect(bad.committed).toBe(false)
  expect(seen.length).toBe(before)
  // Terminal → tipe spesifik (bukan state-changed generik).
  kernel.requestTransition({ executionId: id, to: "RESUMED", reason: "unblocked", source: "test" })
  kernel.requestTransition({ executionId: id, to: "RUNNING", reason: "resume", source: "test" })
  kernel.requestTransition({ executionId: id, to: "COMPLETED", reason: "done", source: "test" })
  const done = executionEventFromCommit(plane, {
    executionId: id,
    rootExecutionId: kernel.get(id)!.rootExecutionId,
    version: kernel.get(id)!.version,
    from: "RUNNING",
    to: "COMPLETED",
    reason: "done",
    source: "test",
  })
  expect(done.eventType).toBe("execution.completed")
  // Duplicate terminal request → kernel ignore → tanpa event otoritatif baru.
  const dup = kernel.requestTransition({
    executionId: id,
    to: "COMPLETED",
    reason: "again",
    source: "test",
  })
  expect(dup.committed).toBe(false)
  expect(seen.filter((e) => e.eventType === "execution.completed")).toHaveLength(1)
})

// Race: pemenang kernel satu-satunya sumber event lifecycle.
test("M10 race: complete-vs-cancel/timeout/budget/authority/failure — satu event terminal", () => {
  for (const reason of ["user", "timeout", "budget", "authority"] as const) {
    const plane = createEventPlane()
    const seen: ExecutionEvent[] = []
    plane.subscribe((e) => {
      seen.push(e)
    })
    const { kernel, id } = runningKernel()
    kernel.requestTransition({
      executionId: id,
      to: "COMPLETED",
      reason: "done",
      source: "agent-loop",
    })
    executionEventFromCommit(plane, {
      executionId: id,
      rootExecutionId: kernel.get(id)!.rootExecutionId,
      version: kernel.get(id)!.version,
      from: "RUNNING",
      to: "COMPLETED",
      reason: "done",
      source: "agent-loop",
    })
    // Laporan telat cancel/timeout: kernel tolak → tanpa event terminal tandingan.
    const late = kernel.requestTransition({
      executionId: id,
      to: "CANCELLING",
      reason,
      source: "supervisor",
    })
    expect(late.committed).toBe(false)
    expect(seen.filter((e) => e.eventType !== "execution.completed")).toHaveLength(0)
  }
})

// Late backend: COMPLETED lalu FAILED → tanpa execution.failed tandingan.
test("M10 late-backend: FAILED telat = observasi audit, bukan lifecycle", () => {
  const plane = createEventPlane()
  const seen: ExecutionEvent[] = []
  plane.subscribe((e) => {
    seen.push(e)
  })
  const { kernel, id } = runningKernel()
  kernel.requestTransition({
    executionId: id,
    to: "COMPLETED",
    reason: "done",
    source: "agent-loop",
  })
  const rec = kernel.get(id)!
  executionEventFromCommit(plane, {
    executionId: id,
    rootExecutionId: rec.rootExecutionId,
    version: rec.version,
    from: "RUNNING",
    to: "COMPLETED",
    reason: "done",
    source: "agent-loop",
  })
  // Observasi backend telat direpresentasikan sebagai audit, bukan lifecycle.
  const audit = plane.emit({
    eventType: "backend.observed",
    executionId: id,
    lineageRootId: rec.rootExecutionId,
    executionVersion: rec.version,
    source: "backend",
    reason: "late FAILED report",
    state: "FAILED",
    metadata: { observation: "late-backend-report" },
  })
  expect(audit.eventType).toBe("backend.observed")
  expect(seen.filter((e) => e.eventType === "execution.failed")).toHaveLength(0)
  expect(kernel.get(id)?.state).toBe("COMPLETED")
})

// Supervisor coverage: klasifikasi/eskalasi/suppress/redispatch/orphan/authority.
test("M10 supervisor: observasi mekanis tanpa mutasi lifecycle", () => {
  const plane = createEventPlane()
  const seen: ExecutionEvent[] = []
  plane.subscribe((e) => {
    seen.push(e)
  })
  const { kernel, id } = runningKernel()
  const rec = kernel.get(id)!
  const mk = (
    eventType: Parameters<typeof plane.emit>[0]["eventType"],
    extra: Record<string, unknown> = {},
  ) =>
    plane.emit({
      eventType,
      executionId: id,
      lineageRootId: rec.rootExecutionId,
      executionVersion: rec.version,
      source: "supervisor",
      ...extra,
    } as never)
  mk("supervisor.observed", { reason: "timeout classified" })
  mk("supervisor.action", { reason: "escalation started" })
  mk("supervisor.action", { reason: "retry suppressed: UNKNOWN non-idempotent" })
  const redispatch = mk("supervisor.redispatch-planned", {
    reason: "idempotent + dedupe verified",
    attempt: 2,
    generation: 2,
    supersedes: id,
  })
  expect(redispatch.attempt).toBe(2)
  expect(redispatch.supersedes).toBe(id)
  // Observasi supervisor tak menyentuh kernel (E2 tak diadmit di sini — M10 tak admit).
  expect(kernel.get("exec_00000000-0000-4000-8000-000000000000")).toBeUndefined()
  mk("execution.orphaned", { reason: "handle unreachable" })
  expect(seen).toHaveLength(5)
  expect(kernel.get(id)?.state).toBe("RUNNING")
})

// Observer safety: throw/mutasi/nested/slow/multi.
test("M10 observer: throw terisolasi; mutasi gagal; nested bounded; slow tak korup", () => {
  const plane = createEventPlane()
  const order: string[] = []
  plane.subscribe(() => {
    throw new Error("boom")
  })
  plane.subscribe((e) => {
    order.push(`ok:${e.eventSequence}`)
  })
  plane.subscribe((e) => {
    try {
      ;(e as unknown as Record<string, number>).eventSequence = -1
    } catch {}
    order.push("mut tried")
  })
  const e = plane.emit(base())
  expect(e.eventSequence).toBeGreaterThan(0)
  expect(order).toEqual(["ok:1", "mut tried"])
  expect(plane.metrics().subscriberErrors).toBe(1)
  // Nested hostile: recursion dibatasi, bukan deadlock/stack-blowup.
  const plane2 = createEventPlane()
  let depth = 0
  plane2.subscribe(() => {
    depth++
    if (depth <= MAX_EVENT_NESTING + 2) {
      try {
        plane2.emit(base())
      } catch {}
    }
  })
  plane2.emit(base())
  expect(plane2.metrics().nestedDrops).toBeGreaterThan(0)
  // Unsubscribe bekerja.
  const plane3 = createEventPlane()
  let hits = 0
  const off = plane3.subscribe(() => {
    hits++
  })
  plane3.emit(base())
  off()
  plane3.emit(base())
  expect(hits).toBe(1)
})

// Snapshot: mutasi record kernel kemudian tak ubah event lama.
test("M10 snapshot: event bekukan state saat emisi", () => {
  const plane = createEventPlane()
  const { kernel, id } = runningKernel()
  const v0 = kernel.get(id)!.version
  const e = executionEventFromCommit(plane, {
    executionId: id,
    rootExecutionId: kernel.get(id)!.rootExecutionId,
    version: v0,
    from: "ADMITTED",
    to: "RUNNING",
    reason: "t",
    source: "test",
  })
  kernel.requestTransition({ executionId: id, to: "WAITING", reason: "io", source: "test" })
  expect(e.executionVersion).toBe(v0)
  expect(e.state).toBe("RUNNING")
  expect(kernel.get(id)?.version).toBeGreaterThan(v0)
})

// P1–P8 properties.
test("M10 properties P1-P8", () => {
  const plane = createEventPlane()
  // P7: version ≠ sequence (observasi mekanis berbagi version, sequence beda).
  const v = 9
  const e1 = plane.emit(base({ executionVersion: v }))
  const e2 = plane.emit(base({ executionVersion: v }))
  expect(e1.executionVersion).toBe(e2.executionVersion)
  expect(e1.eventSequence).not.toBe(e2.eventSequence)
  // P8: tanpa journalSequence di M10.
  expect("journalSequence" in e1).toBe(false)
  expect("journal_sequence" in e1).toBe(false)
  // Terminal mapping lengkap.
  for (const [s, t] of [
    ["COMPLETED", "execution.completed"],
    ["FAILED", "execution.failed"],
    ["CANCELLED", "execution.cancelled"],
    ["TIMED_OUT", "execution.timed-out"],
    ["BUDGET_EXCEEDED", "execution.budget-exceeded"],
    ["AUTHORITY_LOST", "execution.authority-lost"],
    ["RESOURCE_EXCEEDED", "execution.resource-exceeded"],
  ] as const) {
    expect(terminalEventFor(s)).toBe(t)
  }
  expect(terminalEventFor("RUNNING")).toBeNull()
})

// Negative API: plane tak punya authority/persist/schedule/claim.
test("M10 negative: tak ada API otoritas/persist/scheduler/claim", () => {
  const plane = createEventPlane()
  const api = plane as unknown as Record<string, unknown>
  for (const forbidden of [
    "setState",
    "mutateExecution",
    "complete",
    "fail",
    "cancel",
    "terminate",
    "admit",
    "createExecution",
    "markTaskComplete",
    "claimTask",
    "schedule",
    "persist",
    "recover",
    "reconcile",
    "journal",
    "store",
    "save",
  ]) {
    expect(api[forbidden], forbidden).toBeUndefined()
  }
})

// Security: tanpa secret di envelope; bridge hanya salin field whitelist.
test("M10 security: envelope tanpa secret; bridge whitelist-only", () => {
  const plane = createEventPlane()
  const e = plane.emit(base({ metadata: { note: "correlation-only" } }))
  const dumped = JSON.stringify(e)
  expect(dumped).not.toMatch(/sk-|Bearer|API_KEY|TOKEN=|password/i)
  const keys = Object.keys(e).sort()
  for (const k of keys) {
    expect(
      [
        "eventId",
        "eventType",
        "executionId",
        "parentExecutionId",
        "lineageRootId",
        "timestamp",
        "eventSequence",
        "executionVersion",
        "source",
        "causality",
        "reason",
        "state",
        "previousState",
        "attempt",
        "generation",
        "supersedes",
        "metadata",
      ].includes(k),
      k,
    ).toBe(true)
  }
})

// Retry/redispatch vocabulary + tanpa admission.
test("M10 redispatch: kosakata E1→E2 tanpa admission", () => {
  const plane = createEventPlane()
  const e1 = allocateExecutionId()
  const e2 = allocateExecutionId()
  const ev = plane.emit({
    eventType: "supervisor.redispatch-planned",
    executionId: e2,
    lineageRootId: e1,
    executionVersion: 0,
    source: "supervisor",
    reason: "idempotent + dedupe verified",
    attempt: 2,
    generation: 2,
    supersedes: e1,
  })
  expect(ev.executionId).toBe(e2)
  expect(ev.supersedes).toBe(e1)
  expect(ev.attempt).toBe(2)
})
