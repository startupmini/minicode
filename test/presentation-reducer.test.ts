// Fase 3 Presentasi V2.1 — reducer murni + labeler + determinisme.
//
// Kenapa file terpisah: area "presentation model" belum punya rumah; test
// reducer independen dari harness adapter (event fixture literal, tanpa bus).
//
// Yang dijaga:
// · determinisme — eventSeq sama → deep-equal state
// · replay(durable) == live (abaikan live-only)
// · first-terminal-wins + counter
// · force-close approval I-A08 + interrupted-on-rebuild
// · deriveSupersedes 5 aturan + edge paralel
// · tanpa Date.now/random/fs/net di model/reducer (grep)
// · labeler tunggal targetOf/labelTool/summarizeResult

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { DomainEvent } from "../src/presentation/events.ts"
import {
  labelTool,
  previewArgs,
  statusLabel,
  summarizeResult,
  targetOf,
} from "../src/presentation/label.ts"
import {
  activityKey,
  approvalKey,
  cloneState,
  conversationKey,
  createInitialState,
  MAX_STATE_ENTRIES,
  type PresentationState,
  turnKey,
} from "../src/presentation/model.ts"
import {
  createReducerDiagnostics,
  deriveSupersedes,
  deriveTurnSummary,
  type ReducerDiagnostics,
  rebuildFromDurable,
  reduce,
  refreshTurnSummary,
} from "../src/presentation/reducer.ts"

// ── helpers ──

let seq = 0
function base(e: Partial<DomainEvent> & { type: DomainEvent["type"] }): DomainEvent {
  seq++
  return {
    eventSeq: seq,
    ts: 1000 + seq,
    sessionId: "s1",
    turnId: 1,
    ...e,
  } as DomainEvent
}

function feed(state: PresentationState, events: DomainEvent[], diag?: ReducerDiagnostics): void {
  const d = diag ?? createReducerDiagnostics()
  for (const e of events) reduce(state, e, d)
}

/** Deep-equal snapshot tanpa field live-only (progress boleh hilang di rebuild). */
function snapshot(s: PresentationState): unknown {
  const c = cloneState(s)
  for (const a of c.activities.values()) delete a.progress
  return c
}

function toolStarted(
  id: string,
  opts: {
    qualified?: string
    target?: string
    turnId?: number
    sessionId?: string
    startSeq?: number
    stepId?: number
  } = {},
): DomainEvent {
  const name = opts.qualified ?? "read_file"
  const dot = name.indexOf(".")
  const identity =
    dot > 0
      ? {
          origin: "mcp" as const,
          namespace: name.slice(0, dot),
          name: name.slice(dot + 1),
          qualified: name,
        }
      : { origin: "builtin" as const, name, qualified: name }
  seq = opts.startSeq !== undefined ? Math.max(seq, opts.startSeq - 1) : seq
  return base({
    type: "tool.started",
    toolCallId: id,
    turnId: opts.turnId ?? 1,
    stepId: opts.stepId ?? 0,
    identity,
    argsSummary: {
      ...(opts.target ? { target: opts.target } : {}),
      text: opts.target ? `path=${opts.target}` : "",
    },
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  })
}

function toolTerminal(
  id: string,
  kind: "completed" | "failed" | "denied" | "cancelled",
  opts: { turnId?: number; sessionId?: string; durationMs?: number } = {},
): DomainEvent {
  const common = {
    toolCallId: id,
    turnId: opts.turnId ?? 1,
    durationMs: opts.durationMs ?? 5,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  }
  if (kind === "completed") {
    return base({
      type: "tool.completed",
      ...common,
      summary: "ok",
      expandRef: { toolCallId: id, idx: 0 },
    })
  }
  if (kind === "failed") {
    return base({
      type: "tool.failed",
      ...common,
      cause: "exec" as const,
      message: "exit 1",
      expandRef: { toolCallId: id, idx: 0 },
    })
  }
  if (kind === "denied") {
    return base({ type: "tool.denied", ...common, reason: "jail" as const, message: "denied" })
  }
  return base({ type: "tool.cancelled", ...common, reason: "user" as const })
}

function turnStarted(turnId = 1, sessionId = "s1"): DomainEvent {
  return base({ type: "turn.started", turnId, sessionId, promptRef: "p" })
}

function turnCompleted(
  turnId = 1,
  summary?: Partial<{
    toolsOk: number
    toolsFailed: number
    toolsDenied: number
    toolsCancelled: number
    toolsInterrupted: number
    filesChanged: number
    durationMs: number
  }>,
  sessionId = "s1",
): DomainEvent {
  return base({
    type: "turn.completed",
    turnId,
    sessionId,
    summary: {
      toolsOk: 0,
      toolsFailed: 0,
      toolsDenied: 0,
      toolsCancelled: 0,
      toolsInterrupted: 0,
      filesChanged: 0,
      durationMs: 0,
      ...summary,
    },
  })
}

// ── model / createInitialState ──

describe("model", () => {
  test("createInitialState kosong + cloneState deep-equal", () => {
    const s = createInitialState("s1")
    expect(s.sessionId).toBe("s1")
    expect(s.seq).toBe(0)
    expect(s.activities.size).toBe(0)
    expect(s.turns.size).toBe(0)
    const c = cloneState(s)
    expect(snapshot(c)).toEqual(snapshot(s))
  })

  test("turnKey / activityKey termasuk sessionId (anak numbering sendiri)", () => {
    expect(turnKey("sub_a", 3)).toBe("sub_a:3")
    expect(activityKey("sub_a", "c1")).toBe("sub_a:c1")
    expect(approvalKey("s1", "a1")).toBe("s1:a1")
    expect(conversationKey("s1", 1, "assistant")).toBe("s1:1:assistant")
  })

  // cloneState harus menyalin SEMUA wadah (turns/activities/approvals/
  // conversation/order) — callback map yang tak pernah dijalani membuat
  // funcs model.ts di bawah lantai 90% walau lines 100%.
  test("cloneState menyalin turns/activities/approvals/conversation/order", () => {
    const s = createInitialState("s1")
    s.turns.set(turnKey("s1", 1), {
      kind: "turn",
      seq: 1,
      turnId: 1,
      sessionId: "s1",
      status: "running",
      tsStart: 1,
    })
    s.activities.set(activityKey("s1", "t1"), {
      kind: "tool",
      seq: 2,
      turnId: 1,
      stepId: 0,
      toolCallId: "t1",
      sessionId: "s1",
      identity: { origin: "builtin", name: "bash", qualified: "bash" },
      status: "failed",
      tsStart: 1,
      error: { cause: "exec", message: "exit 1" },
      expandRef: { toolCallId: "t1", idx: 0 },
      receipt: {
        toolCallId: "t1",
        paths: ["a.ts"],
        journalSeq: 1,
        stats: { added: 1, removed: 0 },
        test: { passed: 1, failed: 0, summary: "ok" },
        cmd: { exit: 0 },
      },
    })
    s.approvals.set("s1:a1", {
      kind: "approval",
      seq: 3,
      turnId: 1,
      sessionId: "s1",
      approvalId: "a1",
      toolCallId: "t1",
      identity: { origin: "builtin", name: "bash", qualified: "bash" },
      state: "settled",
      outcome: { decision: "allow", by: "user" },
    })
    s.conversation.push({
      kind: "message",
      id: "s1:1:user",
      seq: 4,
      sessionId: "s1",
      turnId: 1,
      role: "user",
      text: "halo",
      truncated: false,
    })
    s.reasoning.push({
      kind: "reasoning",
      id: "rsn-1",
      seq: 5,
      sessionId: "s1",
      turnId: 1,
      truncated: false,
      expandRef: { toolCallId: "r1", idx: 0 },
    })
    s.system.push({
      kind: "system",
      id: "sys-1",
      seq: 6,
      sessionId: "s1",
      turnId: 1,
      systemKind: "notice",
      text: "note",
      severity: "info",
    })
    s.plans.set("p1", {
      kind: "plan",
      planId: "p1",
      seq: 7,
      sessionId: "s1",
      turnId: 1,
      status: "open",
      steps: [{ stepId: "s1", status: "pending" }],
      expandRef: { toolCallId: "p", idx: 0 },
    })
    s.findings.set("f1", {
      kind: "finding",
      findingId: "f1",
      seq: 8,
      sessionId: "s1",
      turnId: 1,
      category: "risk",
      severity: "warning",
      summary: "finding",
      evidence: ["e1"],
    })
    s.results.set("r1", {
      kind: "result",
      resultId: "r1",
      seq: 9,
      sessionId: "s1",
      turnId: 1,
      status: "completed",
      summary: "result",
      expandRef: { toolCallId: "r", idx: 0 },
      receipt: { toolCallId: "r", paths: ["r.ts"] },
    })
    s.diagnostics.push({
      kind: "diagnostic",
      id: "d1",
      seq: 10,
      sessionId: "s1",
      turnId: 1,
      category: "test",
      severity: "info",
      message: "diagnostic",
    })
    s.evicted.push({ kind: "message", id: "old", seq: 0, reason: "bounded" })
    s.order.push({ kind: "message", id: "s1:1", seq: 4 })
    const c = cloneState(s)
    expect(c.turns).toEqual(s.turns)
    expect(c.activities).toEqual(s.activities)
    expect(c.approvals).toEqual(s.approvals)
    expect(c.conversation).toEqual(s.conversation)
    expect(c.reasoning).toEqual(s.reasoning)
    expect(c.system).toEqual(s.system)
    expect(c.plans).toEqual(s.plans)
    expect(c.findings).toEqual(s.findings)
    expect(c.results).toEqual(s.results)
    expect(c.diagnostics).toEqual(s.diagnostics)
    expect(c.evicted).toEqual(s.evicted)
    expect(c.order).toEqual(s.order)
    // deep: objek baru — bukan referensi sama
    expect(c.turns.get(turnKey("s1", 1))).not.toBe(s.turns.get(turnKey("s1", 1)))
    const aOrig = s.activities.get(activityKey("s1", "t1"))
    const aClone = c.activities.get(activityKey("s1", "t1"))
    expect(aClone).not.toBe(aOrig)
    expect(aClone?.error).not.toBe(aOrig?.error)
    expect(aClone?.receipt).not.toBe(aOrig?.receipt)
    expect(c.conversation[0]).not.toBe(s.conversation[0])
    expect(c.order[0]).not.toBe(s.order[0])
    expect(c.reasoning[0]?.expandRef).not.toBe(s.reasoning[0]?.expandRef)
    expect(c.plans.get("p1")?.steps[0]).not.toBe(s.plans.get("p1")?.steps[0])
    expect(c.findings.get("f1")?.evidence).not.toBe(s.findings.get("f1")?.evidence)
  })
})

test("user.message durable menjadi conversation user dan tidak terduplikasi", () => {
  const state = createInitialState("s1")
  const first = base({
    type: "user.message",
    text: "perbaiki parser",
    promptRef: "p1",
  })
  reduce(state, first)
  reduce(
    state,
    base({ type: "user.message", text: "perbaiki parser", promptRef: "p1", eventSeq: 2 }),
  )
  expect(state.conversation).toHaveLength(1)
  expect(state.conversation[0]).toMatchObject({ role: "user", text: "perbaiki parser", turnId: 1 })
  expect(state.seq).toBe(2)
})

// ── determinisme ──

describe("determinisme", () => {
  test("eventSeq sama → deep-equal state", () => {
    seq = 0
    const evs = [
      turnStarted(1),
      toolStarted("t1", { target: "a.ts" }),
      toolTerminal("t1", "completed"),
      turnCompleted(1, { toolsOk: 1 }),
    ]
    const a = createInitialState("s1")
    const b = createInitialState("s1")
    // bangun ulang eventSeq identik
    seq = 0
    const evs2 = [
      turnStarted(1),
      toolStarted("t1", { target: "a.ts" }),
      toolTerminal("t1", "completed"),
      turnCompleted(1, { toolsOk: 1 }),
    ]
    feed(a, evs)
    feed(b, evs2)
    expect(snapshot(a)).toEqual(snapshot(b))
  })

  test("reduce tanpa mutate input event list", () => {
    const s = createInitialState("s1")
    const e = turnStarted(1)
    const before = { ...e }
    reduce(s, e)
    expect(e).toEqual(before)
  })
})

// ── replay == live ──

describe("replay durable", () => {
  test("replay(durable) == live (abaikan delta live-only)", () => {
    const liveEvents: DomainEvent[] = [
      turnStarted(1),
      toolStarted("t1", { target: "x.ts" }),
      base({ type: "tool.progress", toolCallId: "t1", message: "50%" }),
      base({ type: "model.delta", delta: "h" }),
      toolTerminal("t1", "completed"),
      base({
        type: "model.completed",
        text: "jawab",
        truncated: false,
      }),
      turnCompleted(1, { toolsOk: 1 }),
    ]
    const live = createInitialState("s1")
    feed(live, liveEvents)
    const rebuilt = rebuildFromDurable(liveEvents)
    expect(snapshot(rebuilt.state)).toEqual(snapshot(live))
  })

  test("durable filter: progress/delta tidak ikut rebuild", () => {
    const events = [
      turnStarted(1),
      toolStarted("t1"),
      base({ type: "tool.progress", toolCallId: "t1", message: "x" }),
      toolTerminal("t1", "completed"),
      turnCompleted(1),
    ]
    const { state } = rebuildFromDurable(events)
    const a = state.activities.get(activityKey("s1", "t1"))
    expect(a?.progress).toBeUndefined()
    expect(a?.status).toBe("completed")
  })
})

// ── first-terminal-wins ──

describe("first-terminal-wins", () => {
  test("terminal kedua diabaikan + duplicateTerminal tepat", () => {
    const diag = createReducerDiagnostics()
    const s = createInitialState("s1")
    feed(s, [turnStarted(1), toolStarted("t1"), toolTerminal("t1", "completed")], diag)
    const afterFirst = cloneState(s)
    reduce(s, toolTerminal("t1", "failed"), diag)
    const afterSecond = s.activities.get(activityKey("s1", "t1"))
    expect(afterSecond?.status).toBe("completed")
    expect(afterSecond).toEqual(afterFirst.activities.get(activityKey("s1", "t1")))
    expect(diag.duplicateTerminal).toBe(1)
  })

  test("progress setelah terminal → lateEvent", () => {
    const diag = createReducerDiagnostics()
    const s = createInitialState("s1")
    feed(s, [turnStarted(1), toolStarted("t1"), toolTerminal("t1", "completed")], diag)
    reduce(s, base({ type: "tool.progress", toolCallId: "t1", message: "late" }), diag)
    expect(diag.lateEvent).toBe(1)
    expect(s.activities.get(activityKey("s1", "t1"))?.progress).toBeUndefined()
  })

  test("terminal tanpa started → orphanTool + entry incomplete", () => {
    const diag = createReducerDiagnostics()
    const s = createInitialState("s1")
    feed(s, [turnStarted(1), toolTerminal("ghost", "completed")], diag)
    expect(diag.orphanTool).toBe(1)
    const a = s.activities.get(activityKey("s1", "ghost"))
    expect(a?.status).toBe("completed")
    expect(a?.incomplete).toBe(true)
  })

  test("turn settle ganda → duplicateTurn", () => {
    const diag = createReducerDiagnostics()
    const s = createInitialState("s1")
    feed(s, [turnStarted(1), turnCompleted(1), turnCompleted(1)], diag)
    expect(diag.duplicateTurn).toBe(1)
    expect(s.turns.get(turnKey("s1", 1))?.status).toBe("completed")
  })
})

// ── force-close approval (I-A08) ──

describe("force-close approval", () => {
  test("turn settle menutup approval open → cancelled(parent-ended)", () => {
    const diag = createReducerDiagnostics()
    const s = createInitialState("s1")
    feed(
      s,
      [
        turnStarted(1),
        toolStarted("t1"),
        base({
          type: "approval.requested",
          approvalId: "ap1",
          toolCallId: "t1",
          identity: { origin: "builtin", name: "bash", qualified: "bash" },
          argsSummary: { text: "cmd" },
          via: "prompt" as const,
        }),
        turnCompleted(1),
      ],
      diag,
    )
    const ap = s.approvals.get("ap1")
    expect(ap?.state).toBe("settled")
    expect(ap?.outcome).toEqual({
      decision: "cancelled",
      by: "system",
      reason: "parent-ended",
    })
    // tool yang masih running ikut cancelled(parent-ended), bukan failed
    expect(s.activities.get(activityKey("s1", "t1"))?.status).toBe("cancelled")
  })

  test("approval settle ganda → first-settle-wins", () => {
    const diag = createReducerDiagnostics()
    const s = createInitialState("s1")
    feed(
      s,
      [
        turnStarted(1),
        base({
          type: "approval.requested",
          approvalId: "ap1",
          toolCallId: undefined,
          identity: { origin: "builtin", name: "ask_user", qualified: "ask_user" },
          argsSummary: { text: "q" },
          via: "system" as const,
        }),
        base({
          type: "approval.settled",
          approvalId: "ap1",
          toolCallId: undefined,
          outcome: { decision: "deny", by: "system", reason: "headless" },
        }),
        base({
          type: "approval.settled",
          approvalId: "ap1",
          toolCallId: undefined,
          outcome: { decision: "allow", by: "user" },
        }),
      ],
      diag,
    )
    expect(s.approvals.get("ap1")?.outcome).toEqual({
      decision: "deny",
      by: "system",
      reason: "headless",
    })
    expect(diag.duplicateTerminal).toBe(1)
  })

  test("settle tanpa requested → orphanApproval + entry settled", () => {
    const diag = createReducerDiagnostics()
    const s = createInitialState("s1")
    feed(
      s,
      [
        turnStarted(1),
        base({
          type: "approval.settled",
          approvalId: "apX",
          toolCallId: "tX",
          outcome: { decision: "allow", by: "system" },
        }),
      ],
      diag,
    )
    expect(diag.orphanApproval).toBe(1)
    expect(s.approvals.get("apX")?.state).toBe("settled")
  })
})

// ── interrupted-on-rebuild ──

describe("rebuild interrupted", () => {
  test("running tool + open approval + open turn → interrupted / force-close", () => {
    const events = [
      turnStarted(1),
      toolStarted("t1"),
      base({
        type: "approval.requested",
        approvalId: "ap1",
        toolCallId: "t1",
        identity: { origin: "builtin", name: "bash", qualified: "bash" },
        argsSummary: { text: "x" },
        via: "prompt" as const,
      }),
      // crash: tanpa terminal
    ]
    const { state } = rebuildFromDurable(events)
    expect(state.activities.get(activityKey("s1", "t1"))?.status).toBe("interrupted")
    expect(state.approvals.get("ap1")?.state).toBe("settled")
    expect(state.approvals.get("ap1")?.outcome).toEqual({
      decision: "cancelled",
      by: "system",
      reason: "parent-ended",
    })
    expect(state.turns.get(turnKey("s1", 1))?.status).toBe("interrupted")
  })

  test("setelah rebuild, id lama terminal — first-terminal-wins (retry = id baru)", () => {
    const events = [turnStarted(1), toolStarted("t1")]
    const { state } = rebuildFromDurable(events)
    expect(state.activities.get(activityKey("s1", "t1"))?.status).toBe("interrupted")
    const diag = createReducerDiagnostics()
    reduce(state, toolTerminal("t1", "completed"), diag)
    expect(state.activities.get(activityKey("s1", "t1"))?.status).toBe("interrupted")
    expect(diag.duplicateTerminal).toBe(1)
  })
})

// ── deriveSupersedes ──

describe("deriveSupersedes", () => {
  function setupFailedThen(
    kind: "failed" | "denied" | "completed" | "cancelled",
    secondOpts: Parameters<typeof toolStarted>[1] = {},
  ): { state: PresentationState; secondId: string } {
    seq = 0
    const state = createInitialState("s1")
    const target = "a.ts"
    feed(state, [
      turnStarted(1),
      toolStarted("old", { qualified: "edit", target, startSeq: 10 }),
      toolTerminal(
        "old",
        kind === "completed" || kind === "cancelled" ? (kind as "completed") : kind,
        {},
      ),
      toolStarted("new", { qualified: "edit", target, startSeq: 50, ...secondOpts }),
    ])
    return { state, secondId: "new" }
  }

  test("failed → new call: supersedes menunjuk old", () => {
    const { state } = setupFailedThen("failed")
    expect(state.activities.get(activityKey("s1", "new"))?.supersedes).toBe("old")
  })

  test("denied → new call: supersedes menunjuk old", () => {
    const { state } = setupFailedThen("denied")
    expect(state.activities.get(activityKey("s1", "new"))?.supersedes).toBe("old")
  })

  test("completed lalu panggil lagi: TIDAK ditautkan", () => {
    const { state } = setupFailedThen("completed")
    expect(state.activities.get(activityKey("s1", "new"))?.supersedes).toBeUndefined()
  })

  test("cancelled lalu panggil lagi: TIDAK ditautkan", () => {
    const { state } = setupFailedThen("cancelled")
    expect(state.activities.get(activityKey("s1", "new"))?.supersedes).toBeUndefined()
  })

  test("beda target: TIDAK ditautkan", () => {
    seq = 0
    const state = createInitialState("s1")
    feed(state, [
      turnStarted(1),
      toolStarted("old", { qualified: "edit", target: "a.ts" }),
      toolTerminal("old", "failed"),
      toolStarted("new", { qualified: "edit", target: "b.ts" }),
    ])
    expect(state.activities.get(activityKey("s1", "new"))?.supersedes).toBeUndefined()
  })

  test("beda qualified (MCP vs builtin): TIDAK ditautkan", () => {
    seq = 0
    const state = createInitialState("s1")
    feed(state, [
      turnStarted(1),
      toolStarted("old", { qualified: "edit", target: "a.ts" }),
      toolTerminal("old", "failed"),
      toolStarted("new", { qualified: "mcp_srv.edit", target: "a.ts" }),
    ])
    expect(state.activities.get(activityKey("s1", "new"))?.supersedes).toBeUndefined()
  })

  test("beda turnId: TIDAK ditautkan (turn boundary)", () => {
    seq = 0
    const state = createInitialState("s1")
    feed(state, [
      turnStarted(1),
      toolStarted("old", { qualified: "edit", target: "a.ts", turnId: 1 }),
      toolTerminal("old", "failed", { turnId: 1 }),
      turnStarted(2),
      toolStarted("new", { qualified: "edit", target: "a.ts", turnId: 2 }),
    ])
    expect(state.activities.get(activityKey("s1", "new"))?.supersedes).toBeUndefined()
  })

  test("beda sessionId (anak vs parent): TIDAK ditautkan", () => {
    seq = 0
    const state = createInitialState("s1")
    feed(state, [
      turnStarted(1),
      toolStarted("old", { qualified: "edit", target: "a.ts" }),
      toolTerminal("old", "failed"),
      toolStarted("new", {
        qualified: "edit",
        target: "a.ts",
        sessionId: "sub_child",
      }),
    ])
    expect(state.activities.get(activityKey("sub_child", "new"))?.supersedes).toBeUndefined()
  })

  test("paralel tumpang-tindih: old belum terminal saat new started → tanpa taut", () => {
    seq = 0
    const state = createInitialState("s1")
    feed(state, [
      turnStarted(1),
      toolStarted("old", { qualified: "edit", target: "a.ts" }),
      // new mulai SEBELUM old terminal
      toolStarted("new", { qualified: "edit", target: "a.ts" }),
      toolTerminal("old", "failed"),
    ])
    expect(state.activities.get(activityKey("s1", "new"))?.supersedes).toBeUndefined()
  })

  test("rantai 3: failed→failed→completed — supersedes pendahulu langsung", () => {
    seq = 0
    const state = createInitialState("s1")
    feed(state, [
      turnStarted(1),
      toolStarted("a1", { qualified: "edit", target: "a.ts" }),
      toolTerminal("a1", "failed"),
      toolStarted("a2", { qualified: "edit", target: "a.ts" }),
      toolTerminal("a2", "failed"),
      toolStarted("a3", { qualified: "edit", target: "a.ts" }),
    ])
    expect(state.activities.get(activityKey("s1", "a2"))?.supersedes).toBe("a1")
    expect(state.activities.get(activityKey("s1", "a3"))?.supersedes).toBe("a2")
  })

  test("dua kandidat failed: pilih terminal-seq terbesar", () => {
    seq = 0
    const state = createInitialState("s1")
    feed(state, [
      turnStarted(1),
      toolStarted("f1", { qualified: "edit", target: "a.ts" }),
      toolTerminal("f1", "failed"),
      toolStarted("f2", { qualified: "edit", target: "a.ts" }),
      toolTerminal("f2", "failed"),
      toolStarted("win", { qualified: "edit", target: "a.ts" }),
    ])
    expect(state.activities.get(activityKey("s1", "win"))?.supersedes).toBe("f2")
  })

  test("deriveSupersedes direct: probe excludeId + tanpa kandidat", () => {
    const state = createInitialState("s1")
    const id = deriveSupersedes(state, {
      sessionId: "s1",
      turnId: 1,
      qualified: "edit",
      target: "x",
      startSeq: 1,
    })
    expect(id).toBeUndefined()
  })
})

// ── file.changed / test join ──

describe("receipt join", () => {
  test("file.changed menempel paths+journalSeq ke activity", () => {
    const s = createInitialState("s1")
    feed(s, [
      turnStarted(1),
      toolStarted("w1", { qualified: "write_file", target: "out.ts" }),
      base({
        type: "file.changed",
        toolCallId: "w1",
        paths: ["out.ts"],
        journalSeq: 42,
        checkpointId: "ckpt1",
      }),
      base({
        type: "file.changed",
        toolCallId: "w1",
        paths: ["out.ts"],
        journalSeq: 42,
        checkpointId: "ckpt1",
      }),
    ])
    const a = s.activities.get(activityKey("s1", "w1"))
    expect(a?.receipt?.paths).toEqual(["out.ts"])
    expect(a?.receipt?.journalSeq).toBe(42)
    expect(a?.receipt?.checkpointId).toBe("ckpt1")
  })

  test("test.completed mengisi receipt.test", () => {
    const s = createInitialState("s1")
    feed(s, [
      turnStarted(1),
      toolStarted("b1", { qualified: "bash", target: "$ bun test" }),
      base({
        type: "test.completed",
        toolCallId: "b1",
        passed: 3,
        failed: 0,
        summary: "3 pass",
      }),
    ])
    expect(s.activities.get(activityKey("s1", "b1"))?.receipt?.test).toEqual({
      passed: 3,
      failed: 0,
      summary: "3 pass",
    })
  })
})

// ── labeler ──

describe("label.ts", () => {
  test("targetOf: path > from/to > cmd > pattern > query > prompt", () => {
    expect(targetOf({ path: "a.ts" })).toBe("a.ts")
    expect(targetOf({ from: "a", to: "b" })).toBe("a → b")
    expect(targetOf({ cmd: "ls" })).toBe("$ ls")
    expect(targetOf({ command: "ls" })).toBe("$ ls")
    expect(targetOf({ pattern: "*.ts" })).toBe("*.ts")
    expect(targetOf({ query: "foo" })).toBe("foo")
    expect(targetOf({ prompt: "halo dunia" })).toBe("halo dunia")
    expect(targetOf({})).toBeUndefined()
    expect(targetOf(null)).toBeUndefined()
  })

  test("labelTool: read_file + target; bash tanpa target; MCP qualified", () => {
    const r = labelTool(
      { origin: "builtin", name: "read_file", qualified: "read_file" },
      { target: "src/a.ts", text: "path=src/a.ts" },
    )
    expect(r.summary).toBe("read_file src/a.ts")
    expect(r.target).toBe("src/a.ts")

    const b = labelTool({ origin: "builtin", name: "bash", qualified: "bash" }, { text: "cmd" })
    expect(b.summary).toBe("bash")

    const m = labelTool(
      { origin: "mcp", namespace: "srv", name: "search", qualified: "srv.search" },
      { target: "q", text: "q" },
    )
    expect(m.summary).toBe("srv.search q")
  })

  test("labelTool todo: n items dari text todos=N", () => {
    const r = labelTool(
      { origin: "builtin", name: "todo_write", qualified: "todo_write" },
      { text: "todos=3", target: undefined },
    )
    expect(r.summary).toBe("todo_write 3 items")
  })

  test("statusLabel cap MAX_LABEL + strip control", () => {
    const s = statusLabel(
      { origin: "builtin", name: "read_file", qualified: "read_file" },
      { target: `${"x".repeat(300)}\x1b[2J`, text: "" },
    )
    expect(s.length).toBeLessThanOrEqual(201)
    expect(s).not.toContain("\x1b")
  })

  test("summarizeResult: string / isError bash / content array", () => {
    expect(summarizeResult("bash", "done")).toBe("done")
    expect(summarizeResult("bash", { isError: true, content: "exit 1: bad" })).toContain("✗")
    expect(
      summarizeResult("grep", { isError: false, content: [{ type: "text", text: "hit" }] }),
    ).toBe("hit")
    expect(summarizeResult("x", null)).toBe("")
  })

  test("previewArgs fallback JSON cap", () => {
    expect(previewArgs({ path: "a.ts" })).toBe("a.ts")
    expect(previewArgs({ z: 1 })).toContain("z")
  })
})

// ── Phase 2 semantic collections and derived summaries ──

describe("phase 2 semantic state", () => {
  test("reasoning/system/plan/finding/result/diagnostic masuk state dan order", () => {
    const state = createInitialState("s1")
    feed(state, [
      base({
        type: "reasoning.completed",
        truncated: true,
        expandRef: { toolCallId: "r1", idx: 0 },
      }),
      base({ type: "context.compacted", reason: "pressure" }),
      base({
        type: "plan.updated",
        planId: "p1",
        status: "open",
        steps: [{ stepId: "s1", status: "active" }],
      }),
      base({
        type: "finding.detected",
        findingId: "f1",
        category: "risk",
        severity: "warning",
        summary: "cek",
      }),
      base({
        type: "result.produced",
        resultId: "r1",
        status: "completed",
        summary: "selesai",
      }),
      base({
        type: "diagnostic.raised",
        category: "recovery",
        severity: "info",
        message: " Evidence watched",
      }),
    ])
    expect(state.reasoning).toHaveLength(1)
    expect(state.system[0]?.systemKind).toBe("context_compacted")
    expect(state.plans.get("p1")?.steps[0]?.status).toBe("active")
    expect(state.findings.get("f1")?.evidence).toEqual([])
    expect(state.results.get("r1")?.summary).toBe("selesai")
    expect(state.diagnostics[0]?.category).toBe("recovery")
    expect(new Set(state.order.map((entry) => entry.kind)).size).toBe(7)
  })

  test("summary turunan menghitung path unik, test, checkpoint, dan late evidence", () => {
    const state = createInitialState("s1")
    feed(state, [
      turnStarted(1),
      toolStarted("w1", { qualified: "write_file", target: "a.ts" }),
      toolTerminal("w1", "completed"),
      turnCompleted(1, { filesChanged: 99, toolsOk: 99 }),
      base({ type: "file.changed", toolCallId: "w1", paths: ["a.ts", "./b.ts", "a.ts"] }),
      base({ type: "test.completed", toolCallId: "w1", passed: 3, failed: 1, summary: "3 passed" }),
      base({ type: "checkpoint.created", checkpointId: "cp-1", paths: ["a.ts"] }),
    ])
    const turn = state.turns.get(turnKey("s1", 1))
    expect(turn?.summary).toMatchObject({
      toolsOk: 1,
      filesChanged: 2,
      testSummary: { passed: 3, failed: 1, summary: "3 passed" },
      checkpointId: "cp-1",
    })
  })

  test("evidence sebelum tool.started tetap tersimpan sebagai incomplete", () => {
    const state = createInitialState("s1")
    const diag = createReducerDiagnostics()
    feed(
      state,
      [
        turnStarted(1),
        base({ type: "file.changed", toolCallId: "late", paths: ["x.ts"], journalSeq: 7 }),
        base({ type: "test.completed", toolCallId: "late", passed: 1, failed: 0, summary: "ok" }),
      ],
      diag,
    )
    const activity = state.activities.get(activityKey("s1", "late"))
    expect(activity?.incomplete).toBe(true)
    expect(activity?.receipt?.paths).toEqual(["x.ts"])
    expect(diag.orphanEvidence).toBe(1)
  })

  test("rebuild mengurutkan event dan menutup gap dengan timestamp yang konsisten", () => {
    const events = [
      base({ type: "turn.started", eventSeq: 30, ts: 3000, turnId: 1, promptRef: "p" }),
      toolStarted("t1", { startSeq: 10 }),
      toolStarted("t2", { startSeq: 20 }),
    ]
    const first = rebuildFromDurable(events).state
    const second = rebuildFromDurable([...events].reverse()).state
    expect(snapshot(first)).toEqual(snapshot(second))
    expect(first.activities.get(activityKey("s1", "t1"))?.status).toBe("interrupted")
    expect(first.activities.get(activityKey("s1", "t1"))?.tsEnd).toBe(3000)
  })

  test("summary menghitung semua status terminal dan mengabaikan tool child", () => {
    const state = createInitialState("s1")
    feed(state, [
      turnStarted(1),
      toolStarted("ok", { qualified: "read_file" }),
      toolTerminal("ok", "completed"),
      toolStarted("failed"),
      toolTerminal("failed", "failed"),
      toolStarted("denied"),
      toolTerminal("denied", "denied"),
      toolStarted("cancelled"),
      toolTerminal("cancelled", "cancelled"),
      toolStarted("child", { sessionId: "child" }),
      toolTerminal("child", "failed", { sessionId: "child" }),
    ])
    const summary = deriveTurnSummary(state, "s1", 1)
    expect(summary).toMatchObject({ toolsOk: 1, toolsFailed: 1, toolsDenied: 1, toolsCancelled: 1 })
    refreshTurnSummary(state, "missing", 99)
    expect(state.turns.has(turnKey("missing", 99))).toBe(false)
  })

  test("mutation tanpa receipt ditandai evidence partial", () => {
    const state = createInitialState("s1")
    feed(state, [
      turnStarted(1),
      toolStarted("w1", { qualified: "write_file" }),
      toolTerminal("w1", "completed"),
    ])
    expect(state.turns.get(turnKey("s1", 1))?.summary?.evidenceComplete).toBe(false)
  })

  test("cross-session approval dan evidence tidak menabrek root", () => {
    const state = createInitialState("s1")
    const diag = createReducerDiagnostics()
    feed(
      state,
      [
        base({
          type: "approval.requested",
          sessionId: "child",
          approvalId: "a1",
          identity: { origin: "builtin", name: "bash", qualified: "bash" },
          argsSummary: { text: "x" },
          via: "prompt",
        }),
        base({
          type: "approval.settled",
          sessionId: "child",
          approvalId: "a1",
          outcome: { decision: "allow", by: "user" },
        }),
      ],
      diag,
    )
    expect(state.approvals.get("child:a1")?.state).toBe("settled")
    expect(diag.orphanApproval).toBe(0)
  })

  test("bounded state menandai retensi, bukan menghapus diam-diam", () => {
    const state = createInitialState("s1")
    for (let i = 1; i <= MAX_STATE_ENTRIES + 2; i++) {
      reduce(
        state,
        {
          eventSeq: i,
          ts: i,
          sessionId: "s1",
          turnId: i,
          type: "user.message",
          text: `m${i}`,
          promptRef: `p${i}`,
        },
        createReducerDiagnostics(),
      )
    }
    expect(state.conversation.length).toBeLessThanOrEqual(MAX_STATE_ENTRIES)
    expect(state.evicted.length).toBeGreaterThan(0)
    expect(state.evicted[0]?.reason).toBe("bounded")
  })

  test("reducer menangani duplicate, orphan, failure, cancellation, dan unknown event", () => {
    const state = createInitialState("s1")
    const diag = createReducerDiagnostics()
    feed(state, [turnStarted(1), toolStarted("t1")], diag)
    reduce(state, toolStarted("t1"), diag)
    reduce(state, base({ type: "tool.progress", toolCallId: "missing", message: "x" }), diag)
    feed(
      state,
      [
        base({
          type: "approval.requested",
          approvalId: "a1",
          identity: { origin: "builtin", name: "bash", qualified: "bash" },
          argsSummary: { text: "x" },
          via: "prompt",
        }),
      ],
      diag,
    )
    reduce(
      state,
      base({
        type: "approval.requested",
        approvalId: "a1",
        identity: { origin: "builtin", name: "bash", qualified: "bash" },
        argsSummary: { text: "x" },
        via: "prompt",
      }),
      diag,
    )
    feed(state, [base({ type: "turn.failed", error: { cause: "provider", message: "no" } })], diag)
    feed(state, [base({ type: "turn.cancelled", reason: "user", turnId: 2 })], diag)
    reduce(state, { type: "future.event" } as unknown as DomainEvent, diag)
    expect(diag.lateEvent).toBeGreaterThanOrEqual(1)
    expect(diag.unknownEvent).toBe(1)
  })

  test("trimMap meng-evict entry terminal dan menambah marker", () => {
    const state = createInitialState("s1")
    for (let i = 1; i <= MAX_STATE_ENTRIES + 2; i++) {
      reduce(
        state,
        {
          eventSeq: i,
          ts: i,
          sessionId: "s1",
          turnId: i,
          type: "turn.completed",
          summary: {
            toolsOk: 0,
            toolsFailed: 0,
            toolsDenied: 0,
            toolsCancelled: 0,
            toolsInterrupted: 0,
            filesChanged: 0,
            durationMs: 0,
          },
        },
        createReducerDiagnostics(),
      )
    }
    expect(state.turns.size).toBeLessThanOrEqual(MAX_STATE_ENTRIES)
    expect(state.evicted.some((entry) => entry.kind === "turn")).toBe(true)
  })

  test("trimState menguji semua callback collection bounded", () => {
    const state = createInitialState("s1")
    for (let i = 0; i <= MAX_STATE_ENTRIES; i++) {
      state.conversation.push({ id: `m${i}`, seq: i } as never)
      state.reasoning.push({ id: `r${i}`, seq: i } as never)
      state.system.push({ id: `s${i}`, seq: i } as never)
      state.diagnostics.push({ id: `d${i}`, seq: i } as never)
      state.turns.set(`s1:${i}`, { seq: i, status: "completed" } as never)
      state.activities.set(`s1:t${i}`, { seq: i, status: "completed" } as never)
      state.approvals.set(`a${i}`, { seq: i, state: "settled" } as never)
      state.plans.set(`p${i}`, { seq: i } as never)
      state.findings.set(`f${i}`, { seq: i } as never)
      state.results.set(`r${i}`, { seq: i } as never)
    }
    reduce(
      state,
      { eventSeq: 999_999, ts: 1, sessionId: "s1", turnId: 1, type: "model.delta", delta: "x" },
      createReducerDiagnostics(),
    )
    expect(state.conversation.length).toBeLessThanOrEqual(MAX_STATE_ENTRIES)
    expect(state.plans.size).toBeLessThanOrEqual(MAX_STATE_ENTRIES)
    expect(state.results.size).toBeLessThanOrEqual(MAX_STATE_ENTRIES)
  })
})

// ── purity grep (tanpa IO/clock di modul) ──

describe("purity model+reducer", () => {
  test("tanpa Date.now/random/fs/net/process.env di model.ts/reducer.ts", () => {
    const root = process.cwd()
    for (const f of ["src/presentation/model.ts", "src/presentation/reducer.ts"]) {
      const src = readFileSync(join(root, f), "utf8")
      expect(src).not.toMatch(
        /Date\.now|Math\.random|from\s+["']node:fs|from\s+["']node:net|process\.env/,
      )
    }
  })
})

// ── shadow divergence: reducer tidak melempar pada suite adapter ──

describe("shadow safety", () => {
  test("reduce tidak throw pada urutan event representatif", () => {
    const s = createInitialState("s1")
    const diag = createReducerDiagnostics()
    const events: DomainEvent[] = [
      turnStarted(1),
      toolStarted("t1", { target: "a.ts" }),
      base({ type: "tool.progress", toolCallId: "t1", message: "…" }),
      toolTerminal("t1", "failed"),
      toolStarted("t2", { target: "a.ts" }),
      toolTerminal("t2", "completed"),
      base({ type: "model.completed", text: "ok", truncated: false }),
      turnCompleted(1, { toolsOk: 1, toolsFailed: 1 }),
    ]
    for (const e of events) reduce(s, e, diag)
    expect(diag.duplicateTerminal).toBe(0)
    expect(s.turns.get(turnKey("s1", 1))?.status).toBe("completed")
    expect(s.activities.get(activityKey("s1", "t2"))?.supersedes).toBe("t1")
  })
})
