// P2.11 — focused presentation matrix: verification display, provenance,
// identity, replay, children, ACP, failure isolation, CLI/TUI consistency.
//
// Hermetic: fake bus/session/adapter/reducer paths; temp dirs for persistence
// tests; no provider, no network, no real TUI.

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAcpSession } from "../cli/commands/acp.ts"
import { createPresentationAdapter } from "../src/presentation/adapter.ts"
import type { DomainEvent, EventBusLike } from "../src/presentation/events.ts"
import { createInitialState } from "../src/presentation/model.ts"
import {
  describeActivity,
  pendingVerificationObservation,
  projectProvenance,
  provenanceMark,
  toMachineEnvelope,
  verificationMark,
} from "../src/presentation/projection.ts"
import {
  createReducerDiagnostics,
  rebuildFromDurable,
  reduce,
} from "../src/presentation/reducer.ts"
import {
  appendPresentationEvents,
  loadPresentationEventsWithStats,
} from "../src/session/persistence.ts"
import type { UiPresentationActivity, UiPresentationEvent } from "../src/ui/contract.ts"

function tmpRoot(): string {
  // A local .minicode dir pins resolveDbPath to this workspace (never global).
  const dir = mkdtempSync(join(tmpdir(), "mc-p211-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows may briefly retain handles; the OS cleans temporary roots.
  }
}

function fakeBus(): EventBusLike & { emit: (type: string, payload: unknown) => void } {
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
  const events: DomainEvent[] = []
  adapter.onEvent((e) => events.push(e))
  return events
}

const base = (eventSeq: number, extra: Record<string, unknown> = {}) => ({
  eventSeq,
  ts: 1000 + eventSeq,
  sessionId: "s1",
  turnId: 1,
  ...extra,
})

function toolStarted(seq: number, toolCallId = "c1"): DomainEvent {
  return {
    ...base(seq),
    type: "tool.started",
    toolCallId,
    stepId: 1,
    identity: { origin: "builtin", name: "write_file", qualified: "write_file" },
    argsSummary: { target: "a.ts" },
  } as DomainEvent
}

function toolCompleted(seq: number, toolCallId = "c1"): DomainEvent {
  return {
    ...base(seq),
    type: "tool.completed",
    toolCallId,
    durationMs: 5,
    summary: "ok",
    expandRef: { toolCallId, idx: 0 },
    receipt: { paths: ["a.ts"], journalSeq: 7 },
  } as DomainEvent
}

function verificationObserved(
  seq: number,
  toolCallId = "c1",
  verdict: "present" | "absent" | "inconclusive" = "present",
): DomainEvent {
  return {
    ...base(seq),
    type: "verification.observed",
    toolCallId,
    invocationId: "inv:s1:th:t0:s0",
    verdict,
    method: "filesystem-read-back",
    observedAt: 2000,
  } as DomainEvent
}

function reduceAll(events: DomainEvent[]) {
  const state = createInitialState("s1")
  const diag = createReducerDiagnostics()
  for (const e of events) reduce(state, e, diag)
  return { state, diag }
}

// ── A. Verification display ──

test("A1 intent displayed: execution:started → tool.started carries toolCallId", () => {
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(adapter)
  bus.emit("execution:started", {
    execution: { call: { id: "c-intent", name: "write_file", args: {} }, result: {} },
  })
  const started = events.find((e) => e.type === "tool.started")
  expect(started).toBeTruthy()
  expect((started as { toolCallId?: string }).toolCallId).toBe("c-intent")
  adapter.dispose()
})

test("A2 receipt displayed: tool.completed carries receipt + journalSeq linkage", () => {
  const { state } = reduceAll([toolStarted(1), toolCompleted(2)])
  const activity = state.activities.get("s1:c1")
  expect(activity?.receipt?.paths).toEqual(["a.ts"])
  expect(activity?.receipt?.journalSeq).toBe(7)
  expect(activity?.status).toBe("completed")
})

test("A3 verification present attaches without changing status", () => {
  const { state } = reduceAll([toolStarted(1), toolCompleted(2), verificationObserved(3)])
  const activity = state.activities.get("s1:c1")
  expect(activity?.status).toBe("completed")
  expect(activity?.verification).toMatchObject({
    invocationId: "inv:s1:th:t0:s0",
    verdict: "present",
    method: "filesystem-read-back",
  })
})

test("A4 verification absent attaches as explicit non-success", () => {
  const { state } = reduceAll([
    toolStarted(1),
    toolCompleted(2),
    verificationObserved(3, "c1", "absent"),
  ])
  const activity = state.activities.get("s1:c1")
  expect(activity?.status).toBe("completed")
  expect(activity?.verification?.verdict).toBe("absent")
})

test("A5 verification inconclusive attaches without promotion", () => {
  const { state } = reduceAll([
    toolStarted(1),
    toolCompleted(2),
    verificationObserved(3, "c1", "inconclusive"),
  ])
  expect(state.activities.get("s1:c1")?.verification?.verdict).toBe("inconclusive")
  expect(state.activities.get("s1:c1")?.status).toBe("completed")
})

test("A6 unknown: terminal activity without verification carries no marker data", () => {
  const { state } = reduceAll([toolStarted(1), toolCompleted(2)])
  const activity = state.activities.get("s1:c1")!
  expect(activity.verification).toBeUndefined()
  const desc = describeActivity(activity)
  expect(desc.verification).toBeUndefined()
  expect(verificationMark(desc.verification)).toBe("")
})

test("A7 late verification after tool completion attaches (last-wins)", () => {
  const state = createInitialState("s1")
  const diag = createReducerDiagnostics()
  reduce(state, toolStarted(1), diag)
  reduce(state, toolCompleted(2), diag)
  expect(state.activities.get("s1:c1")?.verification).toBeUndefined()
  reduce(state, verificationObserved(3, "c1", "inconclusive"), diag)
  expect(state.activities.get("s1:c1")?.verification?.verdict).toBe("inconclusive")
  reduce(state, verificationObserved(4, "c1", "present"), diag)
  expect(state.activities.get("s1:c1")?.verification?.verdict).toBe("present")
})

test("A8 unknown never renders as success", () => {
  expect(verificationMark(undefined)).toBe("")
  expect(
    verificationMark({ invocationId: "i", verdict: "present", method: "m", observedAt: 1 }),
  ).toBe(" [verified]")
  expect(
    verificationMark({ invocationId: "i", verdict: "absent", method: "m", observedAt: 1 }),
  ).toBe(" [unverified:absent]")
  expect(
    verificationMark({ invocationId: "i", verdict: "inconclusive", method: "m", observedAt: 1 }),
  ).toBe(" [unverified:inconclusive]")
})

// ── B. Provenance ──

test("B1 live: no watershed → no provenance marker", () => {
  expect(projectProvenance({ status: "completed" }, 9, null)).toBeUndefined()
  expect(provenanceMark(undefined)).toBe("")
})

test("B2 replay: rows at/below watershed are replay", () => {
  expect(projectProvenance({ status: "completed" }, 3, 10)).toBe("replay")
  expect(projectProvenance({ status: "completed" }, 10, 10)).toBe("replay")
  expect(projectProvenance({ status: "completed" }, 11, 10)).toBeUndefined()
  expect(provenanceMark("replay")).toBe(" [replay]")
})

test("B3 reconstructed interrupted: interrupted status below watershed", () => {
  const running = {
    ...base(1),
    type: "tool.started",
    toolCallId: "c9",
    stepId: 1,
    identity: { origin: "builtin", name: "bash", qualified: "bash" },
    argsSummary: {},
  } as DomainEvent
  const rebuilt = rebuildFromDurable([running], createReducerDiagnostics(), "s1")
  const activity = rebuilt.state.activities.get("s1:c9")!
  expect(activity.status).toBe("interrupted")
  expect(projectProvenance(activity, activity.seq, rebuilt.state.seq)).toBe("reconstructed")
  expect(provenanceMark("reconstructed")).toBe(" [reconstructed]")
})

test("B4 reconstructed parent-ended: approval settle is rebuild inference", () => {
  const requested = {
    ...base(1),
    type: "approval.requested",
    approvalId: "a1",
    toolCallId: "c1",
    identity: { origin: "builtin", name: "bash", qualified: "bash" },
    argsSummary: {},
    via: "prompt",
  } as DomainEvent
  const rebuilt = rebuildFromDurable([requested], createReducerDiagnostics(), "s1")
  const approval = rebuilt.state.approvals.get("a1")
  expect(approval?.state).toBe("settled")
  expect(approval?.outcome).toMatchObject({ decision: "cancelled", reason: "parent-ended" })
})

test("B5 unknown provenance: watershed null omits markers", () => {
  const activity: UiPresentationActivity = {
    toolCallId: "c1",
    name: "bash",
    status: "completed",
    tsStart: 1,
  }
  const desc = describeActivity(activity)
  expect(desc.provenance).toBeUndefined()
})

test("B6 machine provenance: explicit in envelope and payload", () => {
  const withProv = toMachineEnvelope(
    { type: "tool.completed", seq: 3, turnId: 1, toolCallId: "c1", provenance: "reconstructed" },
    { sessionId: "s1", timestamp: 1000 },
  )
  expect(withProv?.provenance).toBe("reconstructed")
  expect(withProv?.payload.provenance).toBe("reconstructed")
  const live = toMachineEnvelope(
    { type: "tool.completed", seq: 3, turnId: 1, toolCallId: "c1" },
    { sessionId: "s1", timestamp: 1000 },
  )
  expect(live?.provenance).toBeUndefined()
  expect("provenance" in (live?.payload ?? {})).toBe(false)
})

// ── C. Identity ──

function identEvent(seq: number, extra: Record<string, unknown>): DomainEvent {
  return { ...base(seq), ...extra } as DomainEvent
}

test("C1 identical retransmission is an idempotent duplicate", async () => {
  const dir = tmpRoot()
  try {
    const event = identEvent(1, {
      type: "tool.completed",
      toolCallId: "c1",
      durationMs: 5,
      summary: "ok",
      expandRef: { toolCallId: "c1", idx: 0 },
    })
    const first = await appendPresentationEvents("s1", dir, [event])
    const second = await appendPresentationEvents("s1", dir, [event])
    expect(first).toMatchObject({ written: 1, duplicates: 0, collisions: 0 })
    expect(second).toMatchObject({ written: 0, duplicates: 1, collisions: 0 })
    expect(loadPresentationEventsWithStats("s1", dir).events).toHaveLength(1)
  } finally {
    cleanup(dir)
  }
})

test("C2 duplicate counting survives key-order shuffling (canonical compare)", async () => {
  const dir = tmpRoot()
  try {
    const a = identEvent(1, {
      type: "tool.completed",
      toolCallId: "c1",
      durationMs: 5,
      summary: "ok",
      expandRef: { toolCallId: "c1", idx: 0 },
    })
    const b = identEvent(1, {
      summary: "ok",
      expandRef: { idx: 0, toolCallId: "c1" },
      durationMs: 5,
      toolCallId: "c1",
      type: "tool.completed",
    })
    await appendPresentationEvents("s1", dir, [a])
    const stats = await appendPresentationEvents("s1", dir, [b])
    expect(stats.duplicates).toBe(1)
    expect(stats.collisions).toBe(0)
    expect(loadPresentationEventsWithStats("s1", dir).events).toHaveLength(1)
  } finally {
    cleanup(dir)
  }
})

test("C3 identity collision preserves the existing row", async () => {
  const dir = tmpRoot()
  try {
    const first = identEvent(1, {
      type: "tool.completed",
      toolCallId: "c1",
      durationMs: 5,
      summary: "ok",
      expandRef: { toolCallId: "c1", idx: 0 },
    })
    const second = identEvent(1, {
      type: "tool.completed",
      toolCallId: "c1",
      durationMs: 999,
      summary: "different",
      expandRef: { toolCallId: "c1", idx: 0 },
    })
    await appendPresentationEvents("s1", dir, [first])
    const stats = await appendPresentationEvents("s1", dir, [second])
    expect(stats).toMatchObject({ written: 0, duplicates: 0, collisions: 1 })
    const loaded = loadPresentationEventsWithStats("s1", dir)
    expect(loaded.events).toHaveLength(1)
    expect(loaded.events[0]).toMatchObject({ durationMs: 5, summary: "ok" })
  } finally {
    cleanup(dir)
  }
})

test("C4 corrupt rows are rejected with counts, valid state preserved", async () => {
  const dir = tmpRoot()
  try {
    const good = identEvent(1, {
      type: "tool.completed",
      toolCallId: "c1",
      durationMs: 5,
      summary: "ok",
      expandRef: { toolCallId: "c1", idx: 0 },
    })
    await appendPresentationEvents("s1", dir, [good])
    const db = new Database(join(dir, ".minicode", "sessions.db"))
    try {
      db.prepare(
        "INSERT INTO presentation_events (session_id, event_seq, type, turn_id, ts, payload) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("s1", 2, "tool.completed", 1, 1002, "not-json{{{")
    } finally {
      db.close()
    }
    const loaded = loadPresentationEventsWithStats("s1", dir)
    expect(loaded.events).toHaveLength(1)
    expect(loaded.rejected).toBe(1)
  } finally {
    cleanup(dir)
  }
})

test("C5 collision never overwrites across retransmission storms", async () => {
  const dir = tmpRoot()
  try {
    const first = identEvent(1, { type: "tool.completed", toolCallId: "c1", summary: "one" })
    await appendPresentationEvents("s1", dir, [first])
    let collisions = 0
    for (let i = 0; i < 5; i++) {
      const stats = await appendPresentationEvents("s1", dir, [
        identEvent(1, { type: "tool.completed", toolCallId: "c1", summary: `other-${i}` }),
      ])
      collisions += stats.collisions
    }
    expect(collisions).toBe(5)
    expect(loadPresentationEventsWithStats("s1", dir).events[0]).toMatchObject({ summary: "one" })
  } finally {
    cleanup(dir)
  }
})

// ── D. Replay ──

test("D1 restart: rebuild matches live reduction", () => {
  const events = [toolStarted(1), toolCompleted(2), verificationObserved(3)]
  const live = reduceAll(events)
  const rebuilt = rebuildFromDurable(events, createReducerDiagnostics(), "s1")
  expect(JSON.stringify([...rebuilt.state.activities.entries()])).toBe(
    JSON.stringify([...live.state.activities.entries()]),
  )
})

test("D2 deterministic rebuild: same input twice, same state", () => {
  const events = [toolStarted(1), toolCompleted(2), verificationObserved(3)]
  const first = rebuildFromDurable(events, createReducerDiagnostics(), "s1")
  const second = rebuildFromDurable(events, createReducerDiagnostics(), "s1")
  expect(JSON.stringify([...first.state.activities.entries()])).toBe(
    JSON.stringify([...second.state.activities.entries()]),
  )
})

test("D3 repeated rebuild from stored rows is stable", async () => {
  const dir = tmpRoot()
  try {
    await appendPresentationEvents("s1", dir, [toolStarted(1), toolCompleted(2)])
    const once = rebuildFromDurable(
      loadPresentationEventsWithStats("s1", dir).events,
      createReducerDiagnostics(),
      "s1",
    )
    const twice = rebuildFromDurable(
      loadPresentationEventsWithStats("s1", dir).events,
      createReducerDiagnostics(),
      "s1",
    )
    expect(JSON.stringify([...once.state.activities.entries()])).toBe(
      JSON.stringify([...twice.state.activities.entries()]),
    )
  } finally {
    cleanup(dir)
  }
})

test("D4 missing live-only delta: deltas never persist", async () => {
  const dir = tmpRoot()
  try {
    const delta = { ...base(1), type: "model.delta", delta: "live-bytes" } as DomainEvent
    const stats = await appendPresentationEvents("s1", dir, [delta, toolStarted(2)])
    expect(stats).toMatchObject({ written: 1, duplicates: 0, collisions: 0 })
    expect(loadPresentationEventsWithStats("s1", dir).events.map((e) => e.type)).toEqual([
      "tool.started",
    ])
  } finally {
    cleanup(dir)
  }
})

test("D5 reconstructed rows carry provenance after watershed", () => {
  const running = {
    ...base(1),
    type: "tool.started",
    toolCallId: "c9",
    stepId: 1,
    identity: { origin: "builtin", name: "bash", qualified: "bash" },
    argsSummary: {},
  } as DomainEvent
  const rebuilt = rebuildFromDurable([running], createReducerDiagnostics(), "s1")
  const watershed = rebuilt.state.seq
  const provenances = [...rebuilt.state.activities.values()].map((activity) => ({
    id: activity.toolCallId,
    provenance: projectProvenance(activity, activity.seq, watershed),
  }))
  expect(provenances).toEqual([{ id: "c9", provenance: "reconstructed" }])
  expect(projectProvenance({ status: "completed" }, watershed + 1, watershed)).toBeUndefined()
})

// ── E. Children ──

function childStarted(seq: number, childId: string, toolCallId = "cc1"): DomainEvent {
  return {
    ...base(seq, { sessionId: childId }),
    type: "tool.started",
    toolCallId,
    stepId: 1,
    identity: { origin: "builtin", name: "read_file", qualified: "read_file" },
    argsSummary: { target: "b.ts" },
  } as DomainEvent
}

function childCompleted(seq: number, childId: string, toolCallId = "cc1"): DomainEvent {
  return {
    ...base(seq, { sessionId: childId }),
    type: "tool.completed",
    toolCallId,
    durationMs: 3,
    summary: "done",
    expandRef: { toolCallId, idx: 0 },
  } as DomainEvent
}

test("E1 child started namespaced under child session", () => {
  const { state } = reduceAll([childStarted(1, "sub_a")])
  expect(state.activities.get("sub_a:cc1")?.sessionId).toBe("sub_a")
  expect(state.activities.has("s1:cc1")).toBe(false)
})

test("E2 child completed recorded under child session", () => {
  const { state } = reduceAll([childStarted(1, "sub_a"), childCompleted(2, "sub_a")])
  expect(state.activities.get("sub_a:cc1")?.status).toBe("completed")
})

test("E3 child failed recorded under child session", () => {
  const failed = {
    ...base(2, { sessionId: "sub_a" }),
    type: "tool.failed",
    toolCallId: "cc1",
    durationMs: 3,
    message: "boom",
    cause: "exec",
    expandRef: { toolCallId: "cc1", idx: 0 },
  } as DomainEvent
  const { state } = reduceAll([childStarted(1, "sub_a"), failed])
  expect(state.activities.get("sub_a:cc1")?.status).toBe("failed")
})

test("E4 concurrent children stay separate without cross-link", () => {
  const { state } = reduceAll([
    childStarted(1, "sub_a", "ca1"),
    childStarted(2, "sub_b", "cb1"),
    childCompleted(3, "sub_a", "ca1"),
    childCompleted(4, "sub_b", "cb1"),
  ])
  expect(state.activities.get("sub_a:ca1")?.status).toBe("completed")
  expect(state.activities.get("sub_b:cb1")?.status).toBe("completed")
  expect(state.activities.get("sub_a:ca1")?.parentToolCallId).toBeUndefined()
  expect(state.activities.get("sub_b:cb1")?.parentToolCallId).toBeUndefined()
})

test("E5 ambiguous linkage stays orphan via adapter pairing", () => {
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(adapter)
  bus.emit("execution:started", {
    execution: { call: { id: "p1", name: "delegate_task", args: {} }, result: {} },
  })
  bus.emit("execution:started", {
    execution: { call: { id: "p2", name: "delegate_task", args: {} }, result: {} },
  })
  bus.emit("execution:started", {
    execution: { call: { id: "cc1", name: "read_file", args: {} }, result: {} },
    forwardedChild: "sub_x",
  })
  const childStart = events.find(
    (e) => e.type === "tool.started" && (e as { sessionId?: string }).sessionId === "sub_x",
  ) as { parentLink?: unknown } | undefined
  expect(childStart).toBeTruthy()
  expect(childStart?.parentLink).toBeUndefined()
  adapter.dispose()
})

test("E6 orphan child keeps namespaced row without parent link", () => {
  const orphan = {
    ...base(1, { sessionId: "sub_o" }),
    type: "tool.started",
    toolCallId: "co1",
    stepId: 1,
    identity: { origin: "builtin", name: "bash", qualified: "bash" },
    argsSummary: {},
  } as DomainEvent
  const { state } = reduceAll([orphan])
  expect(state.activities.get("sub_o:co1")).toBeTruthy()
  expect(state.activities.get("s1:co1")).toBeUndefined()
})

test("E7 child replay restores child rows independently", () => {
  const events = [childStarted(1, "sub_a"), childCompleted(2, "sub_a")]
  const rebuilt = rebuildFromDurable(events, createReducerDiagnostics(), "sub_a")
  expect(rebuilt.state.activities.get("sub_a:cc1")?.status).toBe("completed")
  expect(rebuilt.sessionId).toBe("sub_a")
})

test("E8 child verification display attaches to child activity", () => {
  // Production shape: the adapter pairs parentLink at tool.started time
  // (exact-one pending delegation); the verification event only observes.
  const linkedStart = {
    ...childStarted(1, "sub_a"),
    parentLink: { parentToolCallId: "p1", childSessionId: "sub_a" },
  } as DomainEvent
  const childVerification = {
    ...base(3, { sessionId: "sub_a" }),
    type: "verification.observed",
    toolCallId: "cc1",
    invocationId: "inv:sub_a:th:t0:s0",
    verdict: "present",
    method: "filesystem-read-back",
    observedAt: 3000,
  } as DomainEvent
  const { state } = reduceAll([linkedStart, childCompleted(2, "sub_a"), childVerification])
  const activity = state.activities.get("sub_a:cc1")!
  expect(activity.verification?.verdict).toBe("present")
  expect(activity.parentToolCallId).toBe("p1")
  expect(state.activities.has("s1:cc1")).toBe(false)
})

test("E9 context isolation: child rows never merge into parent keys", () => {
  const { state } = reduceAll([
    toolStarted(1, "c1"),
    toolCompleted(2, "c1"),
    childStarted(3, "sub_a", "c1"),
    childCompleted(4, "sub_a", "c1"),
  ])
  expect(state.activities.get("s1:c1")?.sessionId).toBe("s1")
  expect(state.activities.get("sub_a:c1")?.sessionId).toBe("sub_a")
  expect(state.activities.get("s1:c1")).not.toBe(state.activities.get("sub_a:c1"))
})

// ── F. ACP projection (via injected fake session) ──

function acpFakeSession(emit?: (fire: (event: UiPresentationEvent) => void) => void) {
  let presentationHandler: ((event: UiPresentationEvent) => void) | undefined
  return {
    session: {
      events: {
        on: () => () => {},
      },
      state: { stepCount: 1, turnCount: 1 },
    },
    usage: { getSession: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }) },
    modelRef: { current: "fake::m" },
    sessionId: "acp-s1",
    runPromptWithVerify: async () => {
      emit?.((event) => presentationHandler?.(event))
    },
    persistCurrent: async () => {},
    isWriterStale: () => false,
    writerStaleNote: () => "",
    close: async () => {},
    onPresentationEvent: (handler: (event: UiPresentationEvent) => void) => {
      presentationHandler = handler
      return () => {
        presentationHandler = undefined
      }
    },
    getPresentationSnapshot: () => ({ activities: [], turns: [] }),
  }
}

function acpDeps(fake: ReturnType<typeof acpFakeSession>, out: string[]) {
  return {
    write: (line: string) => {
      out.push(line)
    },
    onDone: () => {},
    startFlight: (_abort: () => void) => {},
    shouldExit: () => false,
    exit: (_code: number) => {},
    createSession: (async () => fake) as never,
  }
}

function acpNotes(out: string[]): Record<string, unknown>[] {
  return out.map((line) => JSON.parse(line) as Record<string, unknown>)
}

test("F1 ACP preserves child linkage on tool notifications", async () => {
  const out: string[] = []
  const fake = acpFakeSession((fire) => {
    fire({
      type: "tool.completed",
      seq: 2,
      turnId: 1,
      toolCallId: "cc1",
      status: "completed",
      parentToolCallId: "p1",
    })
  })
  await runAcpSession(1, { prompt: "x" }, acpDeps(fake, out))
  const note = acpNotes(out).find(
    (n) => n.type === "tool.completed" && (n as { toolCallId?: string }).toolCallId === "cc1",
  ) as { parentToolCallId?: string } | undefined
  expect(note?.parentToolCallId).toBe("p1")
})

test("F2 ACP exposes verification states", async () => {
  const out: string[] = []
  const fake = acpFakeSession((fire) => {
    fire({
      type: "verification.observed",
      seq: 3,
      turnId: 1,
      toolCallId: "c1",
      invocationId: "inv:s1:th:t0:s0",
      verification: {
        invocationId: "inv:s1:th:t0:s0",
        verdict: "present",
        method: "filesystem-read-back",
        observedAt: 3000,
      },
    })
  })
  await runAcpSession(2, { prompt: "x" }, acpDeps(fake, out))
  const note = acpNotes(out).find((n) => n.type === "verification.observed") as
    | { verification?: { verdict?: string } }
    | undefined
  expect(note?.verification?.verdict).toBe("present")
})

test("F3 ACP unknown: tool note without verification carries no claim", async () => {
  const out: string[] = []
  const fake = acpFakeSession((fire) => {
    fire({
      type: "tool.completed",
      seq: 2,
      turnId: 1,
      toolCallId: "c1",
      status: "completed",
    })
  })
  await runAcpSession(3, { prompt: "x" }, acpDeps(fake, out))
  const note = acpNotes(out).find((n) => n.type === "tool.completed") as
    | { verification?: unknown }
    | undefined
  expect(note && "verification" in (note as object)).toBe(false)
})

test("F4 ACP provenance passthrough is explicit", async () => {
  const out: string[] = []
  const fake = acpFakeSession((fire) => {
    fire({
      type: "tool.completed",
      seq: 2,
      turnId: 1,
      toolCallId: "c1",
      status: "completed",
      provenance: "reconstructed",
    })
  })
  await runAcpSession(4, { prompt: "x" }, acpDeps(fake, out))
  const note = acpNotes(out).find((n) => n.type === "tool.completed") as
    | { provenance?: string }
    | undefined
  expect(note?.provenance).toBe("reconstructed")
})

test("F5 ACP runs stay independent (ephemeral reconnect model)", async () => {
  const out1: string[] = []
  const out2: string[] = []
  const fake1 = acpFakeSession((fire) => {
    fire({
      type: "verification.observed",
      seq: 3,
      turnId: 1,
      toolCallId: "c1",
      invocationId: "inv:one",
      verification: { invocationId: "inv:one", verdict: "present", method: "m", observedAt: 1 },
    })
  })
  const fake2 = acpFakeSession()
  await runAcpSession(5, { prompt: "x" }, acpDeps(fake1, out1))
  await runAcpSession(6, { prompt: "x" }, acpDeps(fake2, out2))
  expect(acpNotes(out1).some((n) => n.type === "verification.observed")).toBe(true)
  expect(acpNotes(out2).some((n) => n.type === "verification.observed")).toBe(false)
})

test("F6 ACP sanitizes control sequences in projected notes", async () => {
  const out: string[] = []
  const fake = acpFakeSession((fire) => {
    fire({
      type: "verification.observed",
      seq: 3,
      turnId: 1,
      toolCallId: "c1",
      invocationId: "inv:s1",
      verification: {
        invocationId: "inv:s1",
        verdict: "present",
        method: "m",
        observedAt: 1,
      },
      message: "\x1b[31mred",
    })
  })
  await runAcpSession(7, { prompt: "x" }, acpDeps(fake, out))
  const raw = out.join("\n")
  expect(raw.includes("\x1b")).toBe(false)
})

// ── G. Failure isolation ──

test("G1 persistence failure throws outward without corrupting stored rows", async () => {
  const dir = tmpRoot()
  try {
    const good = toolCompleted(1)
    await appendPresentationEvents("s1", dir, [good])
    // Unwritable global fallback: MINICODE_HOME menunjuk berkas (bukan dir).
    const prevHome = process.env.MINICODE_HOME
    const blocker = join(dir, "blocker-file")
    writeFileSync(blocker, "x")
    process.env.MINICODE_HOME = blocker
    try {
      await expect(
        appendPresentationEvents("s1", join(dir, "nope", "missing"), [toolStarted(2)]),
      ).rejects.toThrow()
    } finally {
      if (prevHome === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = prevHome
    }
    expect(loadPresentationEventsWithStats("s1", dir).events).toHaveLength(1)
  } finally {
    cleanup(dir)
  }
})

test("G2 renderer tolerates malformed verification events", () => {
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(adapter)
  expect(() =>
    (
      adapter as unknown as { noteVerificationObserved: (info: unknown) => void }
    ).noteVerificationObserved(null),
  ).not.toThrow()
  expect(events).toHaveLength(0)
  adapter.dispose()
})

test("G3 consumer disconnect: unsubscribed handlers never fire", () => {
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, { sessionId: "s1" })
  let calls = 0
  const stop = adapter.onEvent(() => {
    calls++
  })
  stop()
  adapter.noteVerificationObserved({
    toolCallId: "c1",
    invocationId: "inv:1",
    verdict: "present",
    method: "m",
    observedAt: 1,
  })
  expect(calls).toBe(0)
  adapter.dispose()
})

test("G4 event loss: live-only types never reach durable storage", async () => {
  const dir = tmpRoot()
  try {
    const delta = { ...base(1), type: "model.delta", delta: "live-bytes" } as DomainEvent
    const stats = await appendPresentationEvents("s1", dir, [delta, toolStarted(2)])
    expect(stats).toMatchObject({ written: 1, duplicates: 0, collisions: 0 })
    expect(loadPresentationEventsWithStats("s1", dir).events.map((e) => e.type)).toEqual([
      "tool.started",
    ])
  } finally {
    cleanup(dir)
  }
})

test("G5 out-of-order delivery reduces deterministically", () => {
  const ordered = [toolStarted(1), toolCompleted(2), verificationObserved(3)]
  const shuffled = [verificationObserved(3), toolStarted(1), toolCompleted(2)]
  const fromOrdered = rebuildFromDurable(ordered, createReducerDiagnostics(), "s1")
  const fromShuffled = rebuildFromDurable(shuffled, createReducerDiagnostics(), "s1")
  expect(JSON.stringify([...fromOrdered.state.activities.entries()])).toBe(
    JSON.stringify([...fromShuffled.state.activities.entries()]),
  )
})

test("G6 helpers are synchronous and non-blocking by construction", () => {
  expect(projectProvenance({ status: "completed" }, 1, 5)).toBe("replay")
  const observation = pendingVerificationObservation(
    { toolCallId: "c1", tool: "write_file", turn: 1, argsHash: "h", sessionId: "s1" },
    [],
    new Set(),
  )
  expect(observation).toBeNull()
  expect(verificationMark(undefined)).toBe("")
  expect(provenanceMark(undefined)).toBe("")
})

// ── H. CLI/TUI consistency ──

test("H1 same policy input yields same verification semantics", () => {
  const activity: UiPresentationActivity = {
    toolCallId: "c1",
    name: "write_file",
    status: "completed",
    tsStart: 1,
    verification: { invocationId: "inv:1", verdict: "absent", method: "m", observedAt: 2 },
    provenance: "reconstructed",
  }
  const desc = describeActivity(activity)
  expect(desc.verification?.verdict).toBe("absent")
  expect(desc.provenance).toBe("reconstructed")
})

test("H2 observation-only paths never touch canonical stores", async () => {
  const dir = tmpRoot()
  try {
    const bus = fakeBus()
    const adapter = createPresentationAdapter(bus, { sessionId: "s1" })
    collect(adapter)
    bus.emit("execution:started", {
      execution: { call: { id: "c1", name: "read_file", args: {} }, result: {} },
    })
    expect(existsSync(join(dir, ".minicode", "journal-s1.jsonl"))).toBe(false)
    expect(loadPresentationEventsWithStats("s1", dir).events).toHaveLength(0)
  } finally {
    cleanup(dir)
  }
})

test("H3 deterministic markers across runs", () => {
  const input = {
    toolCallId: "c1",
    name: "bash",
    status: "completed",
    tsStart: 1,
    verification: { invocationId: "i", verdict: "present", method: "m", observedAt: 2 },
    provenance: "replay",
  } as UiPresentationActivity
  const first = describeActivity(input)
  const second = describeActivity(input)
  expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  expect(verificationMark(first.verification)).toBe(" [verified]")
  expect(provenanceMark(first.provenance)).toBe(" [replay]")
})
