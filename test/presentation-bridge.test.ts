import { describe, expect, test } from "bun:test"
import { parseVerifyTestEvidence, toPresentationEvent } from "../cli/setup.ts"
import {
  type DomainEvent,
  type DomainEventType,
  DURABILITY,
  type FindingDetectedEvent,
  PROPOSED_EVENT_TYPES,
} from "../src/presentation/events.ts"

const base = (eventSeq: number) => ({
  eventSeq,
  ts: 1000 + eventSeq,
  sessionId: "s1",
  turnId: 3,
})

const fixtures: Record<DomainEventType, DomainEvent> = {
  "user.message": {
    ...base(1),
    type: "user.message",
    text: "perbaiki parser",
    promptRef: "prompt-1",
  },
  "turn.started": { ...base(2), type: "turn.started", promptRef: "prompt-1" },
  "turn.completed": {
    ...base(3),
    type: "turn.completed",
    summary: {
      toolsOk: 1,
      toolsFailed: 0,
      toolsDenied: 0,
      toolsCancelled: 0,
      toolsInterrupted: 0,
      filesChanged: 0,
      durationMs: 10,
    },
  },
  "turn.failed": {
    ...base(4),
    type: "turn.failed",
    error: { cause: "provider", message: "rate limited" },
  },
  "turn.cancelled": { ...base(5), type: "turn.cancelled", reason: "user" },
  "model.delta": { ...base(6), type: "model.delta", delta: "halo" },
  "model.completed": {
    ...base(7),
    type: "model.completed",
    text: "halo",
    truncated: false,
  },
  "reasoning.delta": { ...base(8), type: "reasoning.delta", delta: "<think>" },
  "reasoning.completed": {
    ...base(9),
    type: "reasoning.completed",
    truncated: false,
    expandRef: { toolCallId: "r1", idx: 0 },
  },
  "tool.started": {
    ...base(10),
    type: "tool.started",
    toolCallId: "c1",
    stepId: 0,
    identity: { origin: "builtin", name: "read_file", qualified: "read_file" },
    argsSummary: { target: "a.ts", text: "path=a.ts" },
  },
  "tool.progress": {
    ...base(11),
    type: "tool.progress",
    toolCallId: "c1",
    message: "50%",
  },
  "tool.completed": {
    ...base(12),
    type: "tool.completed",
    toolCallId: "c1",
    durationMs: 10,
    summary: "ok",
    expandRef: { toolCallId: "c1", idx: 0 },
    receipt: { toolCallId: "c1", paths: ["a.ts"], stats: { added: 1, removed: 0 } },
  },
  "tool.failed": {
    ...base(13),
    type: "tool.failed",
    toolCallId: "c1",
    durationMs: 10,
    cause: "exec",
    message: "exit 1",
    hint: "retry",
    expandRef: { toolCallId: "c1", idx: 0 },
  },
  "tool.denied": {
    ...base(14),
    type: "tool.denied",
    toolCallId: "c1",
    reason: "jail",
    message: "denied",
  },
  "tool.cancelled": {
    ...base(15),
    type: "tool.cancelled",
    toolCallId: "c1",
    reason: "parent-aborted",
  },
  "approval.requested": {
    ...base(16),
    type: "approval.requested",
    approvalId: "a1",
    toolCallId: "c1",
    identity: { origin: "builtin", name: "bash", qualified: "bash" },
    argsSummary: { text: "cmd=ls" },
    via: "prompt",
  },
  "approval.settled": {
    ...base(17),
    type: "approval.settled",
    approvalId: "a1",
    toolCallId: "c1",
    outcome: { decision: "deny", by: "user", reason: "declined" },
  },
  "file.changed": {
    ...base(18),
    type: "file.changed",
    toolCallId: "c1",
    paths: ["a.ts"],
    journalSeq: 4,
    checkpointId: "ckpt-1",
  },
  "test.completed": {
    ...base(19),
    type: "test.completed",
    toolCallId: "c1",
    passed: 3,
    failed: 0,
    summary: "all tests passed",
  },
  "context.compacted": {
    ...base(20),
    type: "context.compacted",
    reason: "pressure:high",
  },
  "plan.updated": {
    ...base(21),
    type: "plan.updated",
    planId: "p1",
    status: "open",
    steps: [{ stepId: "s1", title: "Inspect", status: "pending" }],
  },
  "finding.detected": {
    ...base(22),
    type: "finding.detected",
    findingId: "f1",
    category: "risk",
    severity: "warning",
    summary: "Check boundary",
    evidence: ["e1"],
  },
  "result.produced": {
    ...base(23),
    type: "result.produced",
    resultId: "r1",
    status: "completed",
    summary: "Done",
    action: "review",
  },
  "diagnostic.raised": {
    ...base(24),
    type: "diagnostic.raised",
    category: "recovery",
    severity: "warning",
    message: "partial evidence",
  },
  "checkpoint.created": {
    ...base(25),
    type: "checkpoint.created",
    checkpointId: "ckpt-2",
    paths: ["a.ts"],
  },
}

describe("canonical presentation bridge", () => {
  test("event tanpa producer ditandai proposed", () => {
    expect(PROPOSED_EVENT_TYPES).toEqual(["tool.progress"])
  })

  test("memetakan setiap DomainEventType tanpa drop", () => {
    const types = Object.keys(DURABILITY) as DomainEventType[]
    expect(types.length).toBeGreaterThan(0)
    for (const type of types) {
      const projected = toPresentationEvent(fixtures[type])
      expect(projected, type).not.toBeNull()
      expect(projected?.type, type).toBe(type)
    }
  })

  test("mempertahankan semantic payload baru pada projection", () => {
    expect(toPresentationEvent(fixtures["user.message"])).toMatchObject({
      text: "perbaiki parser",
      promptRef: "prompt-1",
    })
    expect(toPresentationEvent(fixtures["model.completed"])).toMatchObject({
      text: "halo",
      truncated: false,
    })
    expect(toPresentationEvent(fixtures["tool.completed"])).toMatchObject({
      toolSummary: "ok",
      expandRef: { toolCallId: "c1", idx: 0 },
      receipt: { paths: ["a.ts"], stats: { added: 1, removed: 0 } },
    })
    expect(toPresentationEvent(fixtures["file.changed"])).toMatchObject({
      paths: ["a.ts"],
      journalSeq: 4,
      checkpointId: "ckpt-1",
    })
    expect(toPresentationEvent(fixtures["test.completed"])).toMatchObject({
      test: { passed: 3, failed: 0, summary: "all tests passed" },
    })
    expect(toPresentationEvent(fixtures["context.compacted"])).toMatchObject({
      compactionReason: "pressure:high",
    })
    expect(toPresentationEvent(fixtures["plan.updated"])).toMatchObject({
      planId: "p1",
      steps: [{ stepId: "s1", status: "pending" }],
    })
    expect(toPresentationEvent(fixtures["finding.detected"])).toMatchObject({
      findingId: "f1",
      category: "risk",
      severity: "warning",
    })
    const childFinding: FindingDetectedEvent = {
      ...(fixtures["finding.detected"] as FindingDetectedEvent),
      parentLink: {
        parentToolCallId: "dt_1",
        childSessionId: "sub_aa11",
        parentSessionId: "parent-1",
      },
    }
    expect(toPresentationEvent(childFinding)).toMatchObject({ parentToolCallId: "dt_1" })
    expect(toPresentationEvent(fixtures["diagnostic.raised"])).toMatchObject({
      category: "recovery",
      message: "partial evidence",
    })
    expect(toPresentationEvent(fixtures["checkpoint.created"])).toMatchObject({
      checkpointId: "ckpt-2",
      paths: ["a.ts"],
    })
  })

  test("verify output terstruktur menjadi evidence test", () => {
    expect(parseVerifyTestEvidence("bun test", "3 pass\n0 fail\n")).toEqual({
      passed: 3,
      failed: 0,
      summary: "3 pass",
    })
    expect(parseVerifyTestEvidence("bun x tsc --noEmit", "ok")).toBeUndefined()
    expect(parseVerifyTestEvidence("bun test", "no counts here")).toBeUndefined()
  })

  test("event runtime yang tidak dikenal di-drop dengan aman", () => {
    const unknown = { type: "future.event" } as unknown as DomainEvent
    expect(toPresentationEvent(unknown)).toBeNull()
  })
})
