import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { DomainEvent } from "../src/presentation/events.ts"
import { createInitialState, type PresentationState } from "../src/presentation/model.ts"
import {
  correlationId,
  describeActivity,
  describeTurn,
  type MachineEventInput,
  type MachineSeverity,
  type MachineStatus,
  machineError,
  machineEventId,
  machineSeverity,
  machineStatus,
  matchTurnBySummary,
  pinnedRunningActivity,
  projectionDigest,
  selectNodes,
  toMachineEnvelope,
} from "../src/presentation/projection.ts"
import { createReducerDiagnostics, reduce } from "../src/presentation/reducer.ts"

let seq = 0
function base(e: Partial<DomainEvent> & { type: DomainEvent["type"] }): DomainEvent {
  seq++
  return { eventSeq: seq, ts: 1000 + seq, sessionId: "s1", turnId: 1, ...e } as DomainEvent
}

function feed(state: PresentationState, events: DomainEvent[]): void {
  const diag = createReducerDiagnostics()
  for (const e of events) reduce(state, e, diag)
}

function toolStarted(id: string): DomainEvent {
  return base({
    type: "tool.started",
    toolCallId: id,
    stepId: 0,
    identity: { origin: "builtin", name: "read_file", qualified: "read_file" },
    argsSummary: { target: "a.ts", text: "path=a.ts" },
  })
}

function toolTerminal(id: string): DomainEvent {
  return base({
    type: "tool.completed",
    toolCallId: id,
    durationMs: 120,
    summary: "ok",
    expandRef: { toolCallId: id, idx: 0 },
  })
}

// ── deskripsi semantik ──

describe("describeActivity/describeTurn", () => {
  test("memetakan field activity tanpa paint/sanitasi", () => {
    seq = 0
    const state = createInitialState("s1")
    feed(state, [toolStarted("c1"), toolTerminal("c1")])
    const activity = state.activities.get("s1:c1")!
    const desc = describeActivity(activity, { childCount: 2 })
    expect(desc).toMatchObject({
      toolCallId: "c1",
      name: "read_file",
      target: "a.ts",
      status: "completed",
      summary: "ok",
      durationMs: 120,
      childCount: 2,
      isChild: false,
    })
    expect(desc.receiptPaths).toEqual([])
    expect(desc.error).toBeUndefined()
  })

  test("matchTurnBySummary menemukan turn pemilik", () => {
    seq = 0
    const state = createInitialState("s1")
    feed(state, [
      base({ type: "turn.started", promptRef: "p" }),
      base({
        type: "turn.completed",
        summary: {
          toolsOk: 1,
          toolsFailed: 0,
          toolsDenied: 0,
          toolsCancelled: 0,
          toolsInterrupted: 0,
          filesChanged: 0,
          durationMs: 5,
        },
      }),
    ])
    const turn = state.turns.get("s1:1")!
    expect(describeTurn(turn).turnId).toBe(1)
    expect(
      matchTurnBySummary([...state.turns.values()], {
        toolsOk: 0,
        toolsFailed: 0,
        toolsDenied: 0,
        filesChanged: 0,
      })?.turnId,
    ).toBe(1)
  })

  test("pinnedRunningActivity root didahulukan + ambang elapsed", () => {
    seq = 0
    const state = createInitialState("s1")
    feed(state, [toolStarted("root"), toolStarted("child")])
    const child = state.activities.get("s1:child")!
    child.parentToolCallId = "root"
    const activities = [...state.activities.values()]
    const pinned = pinnedRunningActivity(activities, 1_000_000)
    expect(pinned?.activity.toolCallId).toBe("root")
    expect(pinned?.showElapsed).toBe(true)
    const fresh = pinnedRunningActivity(activities, state.activities.get("s1:root")!.tsStart + 100)
    expect(fresh?.showElapsed).toBe(false)
  })
})

// ── seleksi node per mode ──

describe("selectNodes", () => {
  function richState(): PresentationState {
    seq = 0
    const state = createInitialState("s1")
    feed(state, [
      toolStarted("c1"),
      toolTerminal("c1"),
      base({
        type: "reasoning.completed",
        truncated: false,
        expandRef: { toolCallId: "r1", idx: 0 },
      }),
      base({ type: "context.compacted", reason: "pressure" }),
      base({
        type: "plan.updated",
        planId: "p1",
        status: "open",
        steps: [{ stepId: "s1", status: "pending" }],
      }),
      base({
        type: "finding.detected",
        findingId: "f1",
        category: "risk",
        severity: "warning",
        summary: "cek",
      }),
      base({ type: "result.produced", resultId: "r1", status: "completed", summary: "ok" }),
      base({ type: "diagnostic.raised", category: "c", severity: "info", message: "m" }),
      base({
        type: "approval.requested",
        approvalId: "a1",
        identity: { origin: "builtin", name: "bash", qualified: "bash" },
        argsSummary: { text: "x" },
        via: "prompt",
      }),
    ])
    return state
  }

  test("normal menyembunyikan reasoning/approval/info diagnostik", () => {
    const kinds = selectNodes(richState(), "normal").map((n) => n.kind)
    expect(kinds).toContain("tool")
    expect(kinds).toContain("plan")
    expect(kinds).toContain("finding")
    expect(kinds).toContain("result")
    expect(kinds).not.toContain("reasoning")
    expect(kinds).not.toContain("approval")
    expect(kinds).not.toContain("diagnostic")
  })

  test("verbose/debug membuka reasoning/approval/diagnostic", () => {
    const verbose = selectNodes(richState(), "verbose").map((n) => n.kind)
    expect(verbose).toContain("reasoning")
    expect(verbose).toContain("approval")
    expect(verbose).toContain("diagnostic")
    const debug = selectNodes(richState(), "debug").map((n) => n.kind)
    expect(debug).toContain("reasoning")
    expect(debug).toContain("approval")
  })

  test("machine hanya lifecycle durable berurutan", () => {
    const nodes = selectNodes(richState(), "machine")
    const seqs = nodes.map((n) => n.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(nodes.some((n) => n.kind === "message")).toBe(false)
    expect(nodes.some((n) => n.kind === "approval")).toBe(false)
  })

  test("digest deterministik dan berubah saat state berubah", () => {
    const a = projectionDigest(selectNodes(richState(), "normal"))
    const b = projectionDigest(selectNodes(richState(), "normal"))
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    seq = 0
    const changed = richState()
    feed(changed, [toolStarted("extra")])
    expect(projectionDigest(selectNodes(changed, "normal"))).not.toBe(a)
  })
})

// ── machine envelope ──

describe("toMachineEnvelope", () => {
  const ctx = { sessionId: "s1", timestamp: 1_789_000_000_000 }

  test("envelope kanonik lengkap + deterministik", () => {
    const event: MachineEventInput = {
      type: "tool.completed",
      seq: 17,
      turnId: 1,
      toolCallId: "call-1",
      status: "completed",
      durationMs: 42,
    }
    const first = toMachineEnvelope(event, ctx)!
    expect(first).toMatchObject({
      schema: "minicode.output.v1",
      eventId: "s1:1:17",
      type: "tool.completed",
      timestamp: new Date(1_789_000_000_000).toISOString(),
      sessionId: "s1",
      turnId: 1,
      correlationId: "call-1",
      source: "derived",
      severity: "info",
      status: "completed",
      visibility: ["machine"],
    })
    expect(first.payload).toMatchObject({ toolCallId: "call-1", durationMs: 42 })
    expect(toMachineEnvelope(event, ctx)).toEqual(first)
  })

  test("tabel severity/status per tipe", () => {
    const cases: Array<[MachineEventInput, MachineSeverity, MachineStatus]> = [
      [{ type: "tool.failed" }, "error", "failed"],
      [{ type: "tool.denied" }, "warning", "denied"],
      [{ type: "turn.cancelled" }, "warning", "cancelled"],
      [{ type: "model.delta", delta: "x" }, "info", "active"],
      [{ type: "approval.settled", outcome: { decision: "deny", by: "user" } }, "info", "denied"],
      [{ type: "plan.updated", status: "open" }, "info", "active"],
      [{ type: "finding.detected" }, "info", "completed"],
      [{ type: "diagnostic.raised", severity: "error" }, "error", "active"],
    ]
    for (const [event, severity, status] of cases) {
      expect(machineSeverity(event)).toBe(severity)
      expect(machineStatus(event)).toBe(status)
    }
  })

  test("correlationId memilih id paling spesifik", () => {
    expect(correlationId({ type: "tool.started", toolCallId: "c1" })).toBe("c1")
    expect(correlationId({ type: "approval.requested", approvalId: "a1" })).toBe("a1")
    expect(correlationId({ type: "turn.started", promptRef: "turn:2" })).toBe("turn:2")
    expect(correlationId({ type: "turn.started" })).toBeUndefined()
  })

  test("payload di-whitelist dan teks panjang di-cap", () => {
    const envelope = toMachineEnvelope(
      {
        type: "model.completed",
        seq: 3,
        text: "x".repeat(200_000),
        unknownFutureField: "must-not-leak",
      } as MachineEventInput,
      ctx,
    )!
    expect(envelope.payload).toMatchObject({ truncated: true })
    expect((envelope.payload.text as string).length).toBeLessThanOrEqual(100_000)
    expect(envelope.payload).not.toHaveProperty("unknownFutureField")
  })

  test("eventId stabil dari session/turn/seq", () => {
    expect(machineEventId("s", 2, 9)).toBe("s:2:9")
    expect(toMachineEnvelope({ type: "" }, ctx)).toBeNull()
  })
})

describe("machineError", () => {
  test("tabel kategori error", () => {
    expect(
      machineError({ name: "NoProviderError", message: "no provider configured" }),
    ).toMatchObject({
      category: "CONFIGURATION_ERROR",
    })
    expect(machineError({ kind: "budget_exceeded", message: "budget exceeded" }).category).toBe(
      "USER_ERROR",
    )
    expect(machineError({ kind: "timeout", message: "timed out" })).toMatchObject({
      category: "AGENT_ERROR",
    })
    expect(machineError({ kind: "aborted", message: "aborted" })).toMatchObject({
      category: "USER_ERROR",
      message: "aborted",
    })
    expect(machineError({ category: "auth", message: "no key" }).category).toBe("PROVIDER_ERROR")
    expect(machineError(new Error("model meledak")).category).toBe("AGENT_ERROR")
  })
})

describe("purity projection", () => {
  test("tanpa clock/random/env/IO di projection.ts", () => {
    const src = readFileSync(join(process.cwd(), "src/presentation/projection.ts"), "utf8")
    expect(src).not.toMatch(/Date\.now|Math\.random|process\.env|from\s+["']node:/)
    expect(src).not.toMatch(/from\s+["']\.\.\/ui\//)
  })
})
