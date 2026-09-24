// Fase 2 Presentasi V2.1 — identitas end-to-end + parent-link sub-anak.
//
// · toolCallId provider → kontrak → DomainEvent tidak boleh hilang
// · forward anak (tag forwardedChild) membawa parentLink LENGKAP bila pasangan
//   bisa ditebak (tepat satu delegate_task pending)
// · paralel ambigu TIDAK ditebak (orphan, bukan taut salah — §12)
// · bentuk execution rusak dilewati + counter (assertExecutionShape)
// · ledger/summary parent: N tool anak ≠ N baris — tally parent hanya milik
//   call parent (delegate_task sendiri)
//
// Tanpa adapter (kode lama) tidak ada DomainEvent sama sekali — setiap
// assertion "ada parentLink" otomatis gagal. Hermetic: fake bus lokal.

import { expect, test } from "bun:test"
import { assertExecutionShape, createPresentationAdapter } from "../src/presentation/adapter.ts"
import type { DomainEvent, EventBusLike, ToolStartedEvent } from "../src/presentation/events.ts"
import type { UiExecution, UiStep } from "../src/ui/contract.ts"

function fakeBus(): EventBusLike & {
  emit: (type: string, payload: unknown) => void
} {
  const handlers = new Map<string, Set<(e: any) => void>>()
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set<(e: any) => void>()
      set.add(handler)
      handlers.set(type, set)
      return () => set.delete(handler)
    },
    emit(type, payload) {
      const set = handlers.get(type)
      if (set) for (const h of [...set]) h(payload)
    },
  }
}

function collect(adapter: ReturnType<typeof createPresentationAdapter>): DomainEvent[] {
  const out: DomainEvent[] = []
  adapter.onEvent((e) => out.push(e))
  return out
}

function startedPayload(
  id: string,
  name: string,
  args: unknown = {},
  forwardedChild?: string,
): unknown {
  return {
    execution: { call: { id, name, args }, result: {} },
    ...(forwardedChild ? { forwardedChild } : {}),
  }
}

function completedPayload(
  id: string,
  name: string,
  content: unknown,
  isError: boolean,
  forwardedChild?: string,
): unknown {
  return {
    execution: { call: { id, name, args: {} }, result: { isError, content } },
    ...(forwardedChild ? { forwardedChild } : {}),
  }
}

// ── Kontrak: id tidak hilang di batas presentasi ──

test("kontrak UiExecution/UiStep membawa id + results ringkas (aditif)", () => {
  const ex: UiExecution = {
    call: { id: "c_1", name: "read_file", args: { path: "a" } },
    result: { isError: false, content: "x" },
  }
  expect(ex.call.id).toBe("c_1")
  const step: UiStep = {
    index: 1,
    toolCalls: [{ id: "c_1", name: "read_file" }],
    results: [{ toolCallId: "c_1", isError: false }],
  }
  expect(step.results?.[0]?.toolCallId).toBe("c_1")
  // Subscriber lama tanpa id tetap valid (field opsional).
  const legacy: UiExecution = { call: { name: "bash" }, result: {} }
  expect(legacy.call.id).toBeUndefined()
})

test("id provider → tool.started.toolCallId identik (utuh end-to-end)", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  bus.emit("execution:started", startedPayload("callu-abc", "write_file", { path: "x.ts" }))
  const started = events.find((e): e is ToolStartedEvent => e.type === "tool.started")
  expect(started?.toolCallId).toBe("callu-abc")
  a.dispose()
})

// ── assertExecutionShape ──

test("assertExecutionShape: bentuk valid vs rusak", () => {
  expect(
    assertExecutionShape({
      execution: { call: { id: "1", name: "bash", args: {} }, result: {} },
    }),
  ).toBe(true)
  expect(assertExecutionShape(null)).toBe(false)
  expect(assertExecutionShape({})).toBe(false)
  expect(assertExecutionShape({ execution: null })).toBe(false)
  expect(assertExecutionShape({ execution: { call: { name: "bash" } } })).toBe(false)
  expect(assertExecutionShape({ execution: { call: { id: "", name: "bash" } } })).toBe(false)
  expect(assertExecutionShape({ execution: { call: { id: "1", name: "" } } })).toBe(false)
})

test("execution rusak → dilewati + malformedExecution (bukan crash)", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  bus.emit("execution:started", { execution: { call: { name: "bash" } } })
  bus.emit("execution:completed", { execution: null })
  expect(events).toHaveLength(0)
  expect(a.getDiagnostics().malformedExecution).toBeGreaterThanOrEqual(2)
  a.dispose()
})

// ── Parent-link sequential ──

test("forward anak sequential: parentLink lengkap di started+completed", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "parent-1" })
  const events = collect(a)
  // Induk mulai (tanpa tag) → antre pasangan.
  bus.emit("execution:started", startedPayload("dt_1", "delegate_task", { prompt: "x" }))
  // Anak forward (tag) → tepat 1 pending → taut.
  bus.emit("execution:started", startedPayload("k_child", "read_file", { path: "a" }, "sub_aa11"))
  bus.emit(
    "execution:completed",
    completedPayload("k_child", "read_file", "isi", false, "sub_aa11"),
  )
  // Induk selesai → keluar dari antre.
  bus.emit("execution:completed", completedPayload("dt_1", "delegate_task", "done", false))

  const childStarted = events.find(
    (e): e is ToolStartedEvent => e.type === "tool.started" && e.toolCallId === "k_child",
  )
  expect(childStarted).toBeTruthy()
  expect(childStarted?.parentLink).toEqual({
    parentToolCallId: "dt_1",
    childSessionId: "sub_aa11",
    parentSessionId: "parent-1",
  })
  // sessionId DomainEvent = anak (bukan parent) — korelasi hierarchy §9.
  expect(childStarted?.sessionId).toBe("sub_aa11")

  const childDone = events.find((e) => e.type === "tool.completed" && e.toolCallId === "k_child")
  expect(childDone?.type === "tool.completed" && childDone.parentLink?.parentToolCallId).toBe(
    "dt_1",
  )
  expect(childDone?.sessionId).toBe("sub_aa11")

  // Call parent sendiri tetap tanpa parentLink (bukan forward).
  const parentStarted = events.find(
    (e): e is ToolStartedEvent => e.type === "tool.started" && e.toolCallId === "dt_1",
  )
  expect(parentStarted?.parentLink).toBeUndefined()
  expect(parentStarted?.sessionId).toBe("parent-1")
  expect(a.getDiagnostics().orphanChild).toBe(0)
  a.dispose()
})

test("forward anak gagal (deny) tetap membawa parentLink", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "p" })
  const events = collect(a)
  bus.emit("execution:started", startedPayload("dt_x", "delegate_task"))
  bus.emit("execution:started", startedPayload("k_denied", "write_file", { path: "z" }, "sub_bb"))
  bus.emit(
    "execution:completed",
    completedPayload(
      "k_denied",
      "write_file",
      "permission denied: jail: outside workspace",
      true,
      "sub_bb",
    ),
  )
  const denied = events.find((e) => e.type === "tool.denied" && e.toolCallId === "k_denied")
  expect(denied?.type === "tool.denied" && denied.parentLink?.parentToolCallId).toBe("dt_x")
  a.dispose()
})

// ── Paralel: tanpa taut (jangan tebak) ──

test("paralel dua delegate_task pending → forward TANPA parentLink + orphanChild", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "p" })
  const events = collect(a)
  bus.emit("execution:started", startedPayload("dt_a", "delegate_task", { prompt: "a" }))
  bus.emit("execution:started", startedPayload("dt_b", "delegate_task", { prompt: "b" }))
  // Dua pending → ambigu → jangan tebak taut.
  bus.emit("execution:started", startedPayload("k_1", "read_file", {}, "sub_c1"))
  bus.emit("execution:started", startedPayload("k_2", "read_file", {}, "sub_c2"))

  const linked = events.filter(
    (e) =>
      (e.type === "tool.started" || e.type === "tool.completed") &&
      "parentLink" in e &&
      e.parentLink,
  )
  expect(linked).toHaveLength(0)
  expect(a.getDiagnostics().orphanChild).toBeGreaterThanOrEqual(1)
  // Event tetap terbit (observability) — hanya tautnya yang absen.
  expect(events.some((e) => e.type === "tool.started" && e.toolCallId === "k_1")).toBe(true)
  expect(events.some((e) => e.type === "tool.started" && e.toolCallId === "k_2")).toBe(true)
  a.dispose()
})

test("forward tanpa delegate_task sama sekali → orphan, tanpa taut", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "p" })
  const events = collect(a)
  bus.emit("execution:started", startedPayload("k_orph", "bash", {}, "sub_zz"))
  const started = events.find(
    (e): e is ToolStartedEvent => e.type === "tool.started" && e.toolCallId === "k_orph",
  )
  expect(started?.parentLink).toBeUndefined()
  expect(a.getDiagnostics().orphanChild).toBeGreaterThanOrEqual(1)
  a.dispose()
})

// ── Summary parent: N anak ≠ N tally ──

test("tool anak sukses/gagal TIDAK menghitung ke summary turn parent", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "p" })
  const events = collect(a)
  bus.emit("turn:started", { turn: 1 })
  bus.emit("execution:started", startedPayload("dt_1", "delegate_task"))
  bus.emit("execution:started", startedPayload("k_ok", "read_file", {}, "sub_s1"))
  bus.emit("execution:completed", completedPayload("k_ok", "read_file", "ok", false, "sub_s1"))
  bus.emit("execution:started", startedPayload("k_bad", "bash", {}, "sub_s1"))
  bus.emit("execution:completed", completedPayload("k_bad", "bash", "exit 1", true, "sub_s1"))
  bus.emit("execution:completed", completedPayload("dt_1", "delegate_task", "done", false))
  bus.emit("turn:completed", { result: { finalText: "-" } })

  const done = events.find((e) => e.type === "turn.completed")
  // Anak ok + anak gagal diabaikan tally; hanya delegate_task (parent) = 1 ok.
  expect(done?.type === "turn.completed" && done.summary.toolsOk).toBe(1)
  expect(done?.type === "turn.completed" && done.summary.toolsFailed).toBe(0)
  a.dispose()
})

// ── Lifecycle ganda ──

test("setelah induk selesai, forward telat baru → tanpa taut lama (queue kosong)", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "p" })
  const events = collect(a)
  bus.emit("execution:started", startedPayload("dt_1", "delegate_task"))
  bus.emit("execution:completed", completedPayload("dt_1", "delegate_task", "ok", false))
  // Queue kosong — forward setelah induk settle tidak menempel ke id lama.
  bus.emit("execution:started", startedPayload("k_late", "bash", {}, "sub_late"))
  const started = events.find(
    (e): e is ToolStartedEvent => e.type === "tool.started" && e.toolCallId === "k_late",
  )
  expect(started?.parentLink).toBeUndefined()
  a.dispose()
})

test("dua anak berbeda pada SATU induk pending bertaut ke induk yang sama", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "p" })
  const events = collect(a)
  bus.emit("execution:started", startedPayload("dt_1", "delegate_task"))
  bus.emit("execution:started", startedPayload("k1", "read_file", {}, "sub_1"))
  bus.emit("execution:started", startedPayload("k2", "grep", {}, "sub_1"))
  const l1 = events.find(
    (e): e is ToolStartedEvent => e.type === "tool.started" && e.toolCallId === "k1",
  )
  const l2 = events.find(
    (e): e is ToolStartedEvent => e.type === "tool.started" && e.toolCallId === "k2",
  )
  // Kedua forward childSessionId berbeda sub_1 — keduanya sama-sama 1 pending.
  expect(l1?.parentLink?.parentToolCallId).toBe("dt_1")
  expect(l2?.parentLink?.parentToolCallId).toBe("dt_1")
  a.dispose()
})
