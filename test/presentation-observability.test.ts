// P1 Observability & Interaction — penjaga aditif untuk F-CTRL-1, F-CTRL-2,
// F-CTX-1, F-CTX-2, F-TASK-1, F-TOOL-1, F-APPROVAL-1, F-DAEMON-1, F-AGENT-1.
//
// Yang dijaga (semua aditif, tanpa mengubah event lama):
// · adaptor memproyeksikan 4 event baru + schemaDrift/riskTier/diffPreview
// · reducer menurunkan consequence/cutoff → diagnostics, task.status → system,
//   context.window → no-op (NON-durable, tak boleh masuk histori)
// · proyeksi machine: severity/status/payload untuk type baru
// · persistence: durable round-trip, context.window DITOLAK dari durable log
// · DURABILITY: replay/reconstruction compat (event lama tak tersentuh)

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPresentationAdapter } from "../src/presentation/adapter.ts"
import type { DomainEvent, EventBusLike } from "../src/presentation/events.ts"
import { createInitialState } from "../src/presentation/model.ts"
import {
  type MachineEventInput,
  machinePayload,
  machineSeverity,
  machineStatus,
  toMachineEnvelope,
} from "../src/presentation/projection.ts"
import { createReducerDiagnostics, reduce } from "../src/presentation/reducer.ts"
import {
  appendPresentationEvents,
  loadPresentationEventsWithStats,
} from "../src/session/persistence.ts"

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

let seq = 0
function ev(partial: Partial<DomainEvent> & { type: DomainEvent["type"] }): DomainEvent {
  seq++
  return {
    eventSeq: seq,
    ts: 1000 + seq,
    sessionId: "s1",
    turnId: 1,
    ...partial,
  } as DomainEvent
}

function tmpRoot(): string {
  // `.minicode` lokal mem-pin resolveDbPath ke workspace (tidak pernah global).
  const dir = mkdtempSync(join(tmpdir(), "minicode-obs-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

// ── Adaptor: event baru ──

describe("adapter: 4 event baru + enrichment", () => {
  test("noteConsequenceDecided → consequence.decided terstruktur (F-CTRL-1/2)", () => {
    const a = createPresentationAdapter(fakeBus(), { sessionId: "s1" })
    const events = collect(a)
    a.noteConsequenceDecided({
      verdict: "FAIL",
      failureClass: "FUNCTIONAL_TEST_FAIL",
      nextAction: "ANALYZE_FAILURE",
      rationale: "tidak ada bukti hijau",
      newEvidenceSinceLastAttempt: true,
      turnId: 4,
    })
    const e = events.find((x) => x.type === "consequence.decided")
    expect(e).toMatchObject({
      type: "consequence.decided",
      turnId: 4,
      verdict: "FAIL",
      failureClass: "FUNCTIONAL_TEST_FAIL",
      nextAction: "ANALYZE_FAILURE",
      rationale: "tidak ada bukti hijau",
      newEvidenceSinceLastAttempt: true,
    })
    a.dispose()
  })

  test("noteContextWindow → context.window NON-durable, angka nyata (F-CTX-1)", () => {
    const a = createPresentationAdapter(fakeBus(), { sessionId: "s1" })
    const events = collect(a)
    a.noteContextWindow({
      usedTokens: 1200,
      windowTokens: 8192,
      percent: 14.6,
      costUsd: 0.0601,
      providerModel: "acme::deepseek-v4",
      turnId: 2,
    })
    const e = events.find((x) => x.type === "context.window")
    expect(e).toMatchObject({
      type: "context.window",
      usedTokens: 1200,
      windowTokens: 8192,
      percent: 14.6,
      costUsd: 0.0601,
      providerModel: "acme::deepseek-v4",
    })
    a.dispose()
  })

  test("noteContextCutoff → context.cutoff durable (F-CTX-2)", () => {
    const a = createPresentationAdapter(fakeBus(), { sessionId: "s1" })
    const events = collect(a)
    a.noteContextCutoff({
      reason: "budget exceeded: $0.0610 > $0.0500",
      usedTokens: 9000,
      windowTokens: 8192,
      turnId: 3,
    })
    const e = events.find((x) => x.type === "context.cutoff")
    expect(e).toMatchObject({
      type: "context.cutoff",
      reason: "budget exceeded: $0.0610 > $0.0500",
      usedTokens: 9000,
      windowTokens: 8192,
    })
    a.dispose()
  })

  test("noteTaskStatus → task.status kanonik + DAG (F-TASK-1)", () => {
    const a = createPresentationAdapter(fakeBus(), { sessionId: "s1" })
    const events = collect(a)
    a.noteTaskStatus({
      taskId: "t1",
      status: "COMPLETED",
      parentId: "t0",
      dependsOn: ["t0"],
      revision: 2,
      turnId: 5,
    })
    const e = events.find((x) => x.type === "task.status")
    expect(e).toMatchObject({
      type: "task.status",
      taskId: "t1",
      status: "COMPLETED",
      parentId: "t0",
      dependsOn: ["t0"],
      revision: 2,
    })
    a.dispose()
  })

  test("tool.failed dengan marker drift skema → schemaDrift terstruktur (F-TOOL-1)", () => {
    const bus = fakeBus()
    const a = createPresentationAdapter(bus, { sessionId: "s1" })
    const events = collect(a)
    bus.emit("execution:started", {
      execution: { call: { id: "m1", name: "srv.search", args: {} }, result: {} },
    })
    bus.emit("execution:completed", {
      execution: {
        call: { id: "m1", name: "srv.search", args: {} },
        result: {
          isError: true,
          content:
            'MCP_SCHEMA_DRIFT_DETECTED: tool "gitlab.issues" schema changed since pin — approve via approveMcpSchemaUpdate()',
        },
      },
    })
    const failed = events.find((x) => x.type === "tool.failed")
    expect(failed?.type === "tool.failed" && failed.schemaDrift).toEqual({
      serverId: "gitlab",
      toolName: "issues",
    })
    a.dispose()
  })

  test("publishApproval requested dengan riskTier/diffPreview → approval.requested (F-APPROVAL-1)", () => {
    const a = createPresentationAdapter(fakeBus(), { sessionId: "s1" })
    const events = collect(a)
    a.publishApproval({
      kind: "requested",
      approvalId: "a1",
      call: { id: "c1", name: "delete_file", args: { path: "x" } },
      via: "prompt",
      riskTier: "EXTERNAL_IRREVERSIBLE",
      diffPreview: "-x",
    })
    const e = events.find((x) => x.type === "approval.requested")
    expect(e).toMatchObject({
      type: "approval.requested",
      riskTier: "EXTERNAL_IRREVERSIBLE",
      diffPreview: "-x",
    })
    a.dispose()
  })
})

// ── F-AGENT-1: identitas run anak dari runtime sampai activity ──

describe("F-AGENT-1: childRunId → ChildSessionLink → ActivityEntry", () => {
  test("forward anak membawa childRunId → parentLink.runId + activity.runId", () => {
    const bus = fakeBus()
    const a = createPresentationAdapter(bus, { sessionId: "s1" })
    const events = collect(a)
    // Induk: satu call delegate_task pending → taut child boleh dibentuk.
    bus.emit("execution:started", {
      execution: { call: { id: "d1", name: "delegate_task", args: {} } },
    })
    // Anak: event forward bertag childSessionId + childRunId (dipasang
    // delegate_task, src/tools/task.ts).
    bus.emit("execution:started", {
      forwardedChild: "sub_0123456789abcdef0123456789abcdef",
      childRunId: "run_abcdef0123456789",
      execution: { call: { id: "c1", name: "read_file", args: { path: "a.ts" } } },
    })
    const started = events.find((e) => e.type === "tool.started" && e.toolCallId === "c1")
    expect(started?.type === "tool.started" && started.parentLink).toMatchObject({
      parentToolCallId: "d1",
      childSessionId: "sub_0123456789abcdef0123456789abcdef",
      runId: "run_abcdef0123456789",
    })
    // Reducer: identitas run mendarat di ActivityEntry (tak ditelan).
    const state = createInitialState("s1")
    for (const e of events) reduce(state, e)
    const entry = state.activities.get("sub_0123456789abcdef0123456789abcdef:c1")
    expect(entry).toMatchObject({
      parentToolCallId: "d1",
      childSessionId: "sub_0123456789abcdef0123456789abcdef",
      runId: "run_abcdef0123456789",
    })
    a.dispose()
  })
})

// ── Reducer: state P1 ──

describe("reducer: consequence/cutoff/task/context.window", () => {
  test("consequence.decided → DiagnosticEntry ACE, severity gagal = error (F-CTRL-1)", () => {
    for (const [verdict, severity] of [
      ["FAIL", "error"],
      ["BLOCKED", "error"],
      ["PASS", "warning"],
      ["INCONCLUSIVE", "warning"],
    ] as const) {
      const state = createInitialState("s1")
      reduce(
        state,
        ev({
          type: "consequence.decided",
          verdict,
          failureClass: "FUNCTIONAL_TEST_FAIL",
          nextAction: "ANALYZE_FAILURE",
          rationale: "alasan",
        }),
      )
      const d = state.diagnostics[0]!
      expect(d).toMatchObject({ kind: "diagnostic", category: "ACE", severity })
      expect(d.verdict).toBe(verdict)
    }
  })

  test("consequence.decided menyimpan newEvidenceSinceLastAttempt (F-CTRL-2)", () => {
    const state = createInitialState("s1")
    reduce(
      state,
      ev({
        type: "consequence.decided",
        verdict: "FAIL",
        failureClass: "TRANSIENT_ENV",
        nextAction: "RETRY_TRANSIENT",
        rationale: "flaky",
        newEvidenceSinceLastAttempt: true,
      }),
    )
    expect(state.diagnostics[0]).toMatchObject({
      category: "ACE",
      cause: "TRANSIENT_ENV",
      action: "RETRY_TRANSIENT",
      newEvidenceSinceLastAttempt: true,
    })
  })

  test("context.cutoff → DiagnosticEntry CONTEXT_CUTOFF warning (F-CTX-2)", () => {
    const state = createInitialState("s1")
    reduce(state, ev({ type: "context.cutoff", reason: "budget exceeded" }))
    expect(state.diagnostics[0]).toMatchObject({
      kind: "diagnostic",
      category: "CONTEXT_CUTOFF",
      severity: "warning",
      message: "budget exceeded",
    })
  })

  test("task.status → SystemEntry notice + deps (F-TASK-1)", () => {
    const state = createInitialState("s1")
    reduce(
      state,
      ev({
        type: "task.status",
        taskId: "t1",
        status: "COMPLETED",
        dependsOn: ["t0"],
      }),
    )
    expect(state.system[0]).toMatchObject({
      kind: "system",
      systemKind: "notice",
      text: "t1 completed",
      reason: "dependsOn=[t0]",
      severity: "info",
    })
  })

  test("context.window adalah no-op: tak menyentuh state/seq (F-CTX-1)", () => {
    const state = createInitialState("s1")
    const before = JSON.stringify(state.diagnostics) + JSON.stringify(state.order)
    reduce(
      state,
      ev({
        type: "context.window",
        usedTokens: 1200,
        windowTokens: 8192,
        percent: 14.6,
      }),
      createReducerDiagnostics(),
    )
    expect(state.diagnostics).toHaveLength(0)
    expect(state.system).toHaveLength(0)
    expect(state.order).toHaveLength(0)
    expect(JSON.stringify(state.diagnostics) + JSON.stringify(state.order)).toBe(before)
  })
})

// ── Proyeksi machine ──

describe("proyeksi machine: type baru", () => {
  const cases: Array<
    [MachineEventInput, ReturnType<typeof machineSeverity>, ReturnType<typeof machineStatus>]
  > = [
    [{ type: "consequence.decided", verdict: "FAIL" }, "error", "failed"],
    [{ type: "consequence.decided", verdict: "PASS" }, "info", "completed"],
    [{ type: "consequence.decided", verdict: "BLOCKED" }, "error", "interrupted"],
    [{ type: "context.cutoff" }, "warning", "interrupted"],
    [{ type: "context.window" }, "info", "active"],
    [{ type: "task.status", taskStatus: "COMPLETED" }, "info", "completed"],
    [{ type: "task.status", taskStatus: "FAILED" }, "error", "failed"],
    [{ type: "task.status", taskStatus: "BLOCKED" }, "warning", "interrupted"],
  ]
  for (const [event, severity, status] of cases) {
    test(`severity/status ${event.type} (${String(event.verdict ?? event.taskStatus ?? "")})`, () => {
      expect(machineSeverity(event)).toBe(severity)
      expect(machineStatus(event)).toBe(status)
    })
  }

  test("machinePayload melempar field baru + filter unknown", () => {
    const payload = machinePayload({
      type: "task.status",
      taskId: "t1",
      taskStatus: "COMPLETED",
      dependsOn: ["t0"],
      revision: 2,
    } as MachineEventInput)
    expect(payload).toMatchObject({
      taskId: "t1",
      taskStatus: "COMPLETED",
      dependsOn: ["t0"],
      revision: 2,
    })

    const ace = machinePayload({
      type: "consequence.decided",
      verdict: "FAIL",
      failureClass: "X",
      nextAction: "Y",
      newEvidenceSinceLastAttempt: true,
    } as MachineEventInput)
    expect(ace).toMatchObject({
      verdict: "FAIL",
      failureClass: "X",
      nextAction: "Y",
      newEvidenceSinceLastAttempt: true,
    })

    const task = machinePayload({
      type: "task.status",
      taskId: "t1",
      taskStatus: "COMPLETED",
      taskVerification: { verdict: "unverified", checkedAt: "" },
    } as MachineEventInput)
    expect(task).toMatchObject({
      taskId: "t1",
      taskStatus: "COMPLETED",
      taskVerification: { verdict: "unverified", checkedAt: "" },
    })
  })

  test("envelope anak memakai session/run anak, bukan session induk", () => {
    const envelope = toMachineEnvelope(
      {
        type: "tool.completed",
        seq: 7,
        turnId: 1,
        sessionId: "sub_child_1",
        childSessionId: "sub_child_1",
        runId: "run_child_1",
      } as MachineEventInput,
      { sessionId: "parent_1", timestamp: 1 },
    )!
    expect(envelope.sessionId).toBe("sub_child_1")
    expect(envelope.eventId).toContain("sub_child_1")
    expect(envelope.eventId).not.toContain("parent_1")
    expect(envelope.payload).toMatchObject({
      childSessionId: "sub_child_1",
      runId: "run_child_1",
    })
  })

  test("envelope teks panjang di-cap + field tak dikenal tak bocor", () => {
    const envelope = toMachineEnvelope(
      {
        type: "model.completed",
        seq: 3,
        text: "x".repeat(200_000),
        secretField: "must-not-leak",
      } as MachineEventInput,
      { sessionId: "s1", timestamp: 1 },
    )!
    expect(envelope.payload).not.toHaveProperty("secretField")
  })
})

// ── Persistence: durable round-trip, non-durable ditolak ──

describe("persistence: P1 events", () => {
  test("decoder: v1/legacy diterima, versi masa depan & payload rusak ditolak", async () => {
    const dir = tmpRoot()
    try {
      const good = ev({
        type: "task.status",
        taskId: "t1",
        status: "COMPLETED",
        revision: 1,
        v: 1,
      })
      const legacy = ev({ type: "task.status", taskId: "t2", status: "PENDING", revision: 1 })
      const future = ev({ type: "task.status", taskId: "t3", status: "PENDING", v: 2 })
      const badLink = ev({
        type: "task.status",
        taskId: "t4",
        status: "PENDING",
        parentLink: { parentToolCallId: 1, childSessionId: "x" },
      } as never)
      const badVerify = ev({
        type: "task.status",
        taskId: "t5",
        status: "COMPLETED",
        verification: { verdict: "nope", checkedAt: "x" },
      } as never)
      const stats = await appendPresentationEvents("s1", dir, [
        good,
        legacy,
        future,
        badLink,
        badVerify,
      ])
      expect(stats.written).toBe(5)
      const loaded = loadPresentationEventsWithStats("s1", dir)
      expect(loaded.events.map((e) => (e as { taskId?: string }).taskId)).toEqual(["t1", "t2"])
      expect(loaded.rejected).toBe(3)
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  })

  test("consequence/cutoff/task durable round-trip; context.window ditolak", async () => {
    const dir = tmpRoot()
    try {
      const durable = [
        ev({
          type: "consequence.decided",
          verdict: "FAIL",
          failureClass: "PERMISSION_OR_EXTERNAL_BLOCKER",
          nextAction: "REQUEST_HUMAN",
          rationale: "blocked",
        }),
        ev({ type: "context.cutoff", reason: "budget exceeded", usedTokens: 9000 }),
        ev({ type: "task.status", taskId: "t1", status: "COMPLETED", revision: 1 }),
        ev({ type: "context.window", usedTokens: 1000, windowTokens: 8192 }),
      ]
      const stats = await appendPresentationEvents("s1", dir, durable)
      expect(stats.written).toBe(3) // context.window NON-durable → dilewati
      const loaded = loadPresentationEventsWithStats("s1", dir)
      expect(loaded.events).toHaveLength(3)
      const types = (loaded.events.map((e) => e.type) as string[]).sort()
      expect(types).toEqual(["consequence.decided", "context.cutoff", "task.status"].sort())
    } finally {
      // Windows bisa menahan handle SQLite sesaat; OS akan membersihkan dir temp.
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  })
})

describe("DURABILITY: replay/reconstruction compat (D-6) + event baru", () => {
  test("event lama tak berubah; context.window non-durable", async () => {
    const { DURABILITY } = await import("../src/presentation/events.ts")
    // Event lama terjaga persis (tak disentuh ekspansi ini).
    expect(DURABILITY["tool.failed"]).toEqual({ durable: true, replayable: true })
    expect(DURABILITY["turn.cancelled"]).toEqual({ durable: true, replayable: true })
    expect(DURABILITY["model.delta"]).toEqual({ durable: false, replayable: false })
    // Event baru.
    expect(DURABILITY["consequence.decided"]).toEqual({ durable: true, replayable: true })
    expect(DURABILITY["context.window"]).toEqual({ durable: false, replayable: false })
    expect(DURABILITY["context.cutoff"]).toEqual({ durable: true, replayable: true })
    expect(DURABILITY["task.status"]).toEqual({ durable: true, replayable: true })
  })
})
