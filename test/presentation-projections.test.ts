import { afterEach, describe, expect, test } from "bun:test"
import {
  describeActivity,
  elapsedVisible,
  matchTurnBySummary,
} from "../src/presentation/projection.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import type {
  UiPresentationActivity,
  UiPresentationEvent,
  UiPresentationSnapshot,
} from "../src/ui/contract.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { TRANSCRIPT_CAP, Transcript, type TranscriptMeta } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty } from "./helpers/tui-harness.ts"

function setup() {
  const bus = createFakeBus()
  let snapshot: UiPresentationSnapshot = { activities: [], turns: [] }
  let handler: ((event: UiPresentationEvent) => void) | undefined
  const transcript = new Transcript(bus as never, {
    getSnapshot: () => snapshot,
    onPresentationEvent: (next) => {
      handler = next
      return () => {
        handler = undefined
      }
    },
  })
  return {
    bus,
    transcript,
    setSnapshot(next: UiPresentationSnapshot) {
      snapshot = next
    },
    emitPresentation(event: UiPresentationEvent) {
      handler?.(event)
    },
  }
}

function activity(overrides: Partial<UiPresentationActivity> = {}): UiPresentationActivity {
  return {
    toolCallId: "call-1",
    name: "read_file",
    target: "a.ts",
    status: "running",
    tsStart: Date.now(),
    ...overrides,
  }
}

afterEach(() => {
  resetLocaleState()
})

describe("P5 transcript projection", () => {
  test("running row tampil dari snapshot dengan elapsed setelah dua detik", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot } = setup()
    setSnapshot({ activities: [activity({ tsStart: Date.now() - 3000 })], turns: [] })
    const out = transcript.view(100, 4, 0).join("\n")
    expect(out).toContain("› read_file a.ts … running (3s)")
  })

  test("event turn dan approval tidak membuat phantom activity", () => {
    const { transcript, emitPresentation } = setup()
    emitPresentation({ type: "turn.started", turnId: 1 })
    emitPresentation({ type: "approval.requested", approvalId: "a-1" })
    expect(transcript.size()).toBe(0)
  })

  test("terminal event duplikat tidak menggandakan baris", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const entry = activity({ status: "completed" })
    setSnapshot({ activities: [entry], turns: [] })
    emitPresentation({ type: "tool.completed", toolCallId: entry.toolCallId, status: "completed" })
    emitPresentation({ type: "tool.completed", toolCallId: entry.toolCallId, status: "completed" })
    expect(transcript.view(100, 4, 0).filter((line) => line.includes("read_file"))).toHaveLength(1)
  })

  test("terminal status memakai glyph dan kata yang berbeda", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const entry = activity({ status: "denied" })
    setSnapshot({ activities: [entry], turns: [] })
    emitPresentation({
      type: "tool.denied",
      seq: 4,
      turnId: 1,
      toolCallId: entry.toolCallId,
      status: "denied",
    })
    const out = transcript.view(100, 4, 0).join("\n")
    expect(out).toContain("⊘ read_file a.ts denied")
  })

  test("retry dan grup anak tetap satu baris ledger induk", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const parent = activity({
      toolCallId: "parent-1",
      name: "delegate_task",
      target: undefined,
      status: "completed",
      supersedes: "old-1",
    })
    const child = activity({
      toolCallId: "child-1",
      name: "read_file",
      parentToolCallId: parent.toolCallId,
      status: "completed",
    })
    setSnapshot({ activities: [parent, child], turns: [] })
    emitPresentation({
      type: "tool.completed",
      seq: 8,
      turnId: 1,
      toolCallId: parent.toolCallId,
      status: "completed",
    })
    emitPresentation({
      type: "tool.completed",
      seq: 9,
      turnId: 1,
      toolCallId: child.toolCallId,
      status: "completed",
    })
    const out = transcript.view(100, 4, 0).join("\n")
    expect(out).toContain("delegate_task completed ↻ retry 1 child tools")
    expect(out).not.toContain("read_file a.ts completed")
  })

  // F-AGENT-1: identitas run anak (childSessionId/runId) datang dari
  // ChildSessionLink → ActivityEntry → snapshot. Bila ADA, tool anak dirender
  // sebagai baris run sendiri keyed `run_<8>`/`sub_<8>`; bila hanya
  // `parentToolCallId` (grouping legacy), tetap ditelan hitungan induk (test di
  // atas). Dua makna ini tidak boleh dicampur.
  test("F-AGENT-1: tool anak ber-runId dirender per-run, keyed run_<8>", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const parent = activity({
      toolCallId: "parent-1",
      name: "delegate_task",
      target: undefined,
      status: "completed",
    })
    const child = activity({
      toolCallId: "child-1",
      name: "read_file",
      parentToolCallId: parent.toolCallId,
      childSessionId: "sub_0123456789abcdef0123456789abcdef",
      runId: "run_abcdef0123456789abcdef0123456789",
      status: "completed",
    })
    setSnapshot({ activities: [parent, child], turns: [] })
    emitPresentation({
      type: "tool.completed",
      seq: 8,
      turnId: 1,
      toolCallId: parent.toolCallId,
      status: "completed",
    })
    emitPresentation({
      type: "tool.completed",
      seq: 9,
      turnId: 1,
      toolCallId: child.toolCallId,
      status: "completed",
    })
    const out = transcript.view(120, 20, 0).join("\n")
    // Induk tetap satu baris ringkasan delegasi…
    expect(out).toContain("delegate_task completed")
    // …dan anak tampil sebagai baris run sendiri, keyed runId (menang atas
    // childSessionId karena identitas eksekusi, bukan identitas session).
    expect(out).toContain("↳ run_abcdef01 read_file a.ts completed")
  })

  test("F-AGENT-1: tanpa runId, marker jatuh ke childSessionId sub_<8>", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const parent = activity({
      toolCallId: "parent-2",
      name: "delegate_task",
      target: undefined,
      status: "completed",
    })
    const child = activity({
      toolCallId: "child-2",
      name: "grep",
      parentToolCallId: parent.toolCallId,
      childSessionId: "sub_fedcba9876543210fedcba9876543210",
      status: "completed",
    })
    setSnapshot({ activities: [parent, child], turns: [] })
    emitPresentation({ type: "tool.completed", seq: 3, turnId: 1, toolCallId: child.toolCallId })
    const out = transcript.view(120, 20, 0).join("\n")
    expect(out).toContain("↳ sub_fedcba98 grep a.ts completed")
  })

  test("F-AGENT-1: tiga anak paralel = tiga baris run terpisah, bukan hitungan", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot } = setup()
    const parent = activity({
      toolCallId: "parent-3",
      name: "delegate_task",
      target: undefined,
      status: "running",
      tsStart: Date.now(),
    })
    const kids = (["a", "b", "c"] as const).map((ch, i) =>
      activity({
        toolCallId: `child-${ch}`,
        name: "read_file",
        target: `${ch}.ts`,
        parentToolCallId: parent.toolCallId,
        childSessionId: `sub_${ch.repeat(8)}${i}`,
        runId: `run_${ch.repeat(8)}${i}`,
        status: "running",
        tsStart: Date.now(),
      }),
    )
    setSnapshot({ activities: [parent, ...kids], turns: [] })
    const out = transcript.view(120, 30, 0).join("\n")
    // Tiap run punya baris sendiri keyed marker-nya — bukan "n child tools".
    for (const ch of ["a", "b", "c"] as const) {
      expect(out).toContain(`↳ run_${ch.repeat(8)} read_file ${ch}.ts … running`)
    }
    expect(out).not.toContain("child tools")
  })

  test("turn summary menjadi system entry dan membawa turn", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const summary = {
      toolsOk: 5,
      toolsFailed: 1,
      toolsDenied: 1,
      toolsCancelled: 0,
      toolsInterrupted: 0,
      filesChanged: 2,
      checkpointId: "t7",
      durationMs: 41000,
    }
    setSnapshot({ activities: [], turns: [{ turnId: 7, status: "completed", summary }] })
    emitPresentation({ type: "turn.completed", seq: 20, turnId: 7, summary })
    const out = transcript.view(120, 4, 0).join("\n")
    expect(out).toContain("turn 7 · 5 ok · 1 failed · 1 denied")
    expect(out).toContain("2 files · ckpt t7 · 41s")
  })

  test("evict cap memakai marker dan total tetap monotonik", () => {
    setSessionLocale("en")
    const { transcript } = setup()
    transcript.pushInfo(Array.from({ length: TRANSCRIPT_CAP + 10 }, (_, i) => `line-${i}`))
    expect(transcript.size()).toBe(TRANSCRIPT_CAP + 1)
    expect(transcript.total()).toBe(TRANSCRIPT_CAP + 10)
    expect(transcript.view(100, 1, TRANSCRIPT_CAP)[0]).toContain("10 early lines")
  })

  test("snapshot exception does not damage viewport", () => {
    const bus = createFakeBus()
    const transcript = new Transcript(bus as never, {
      getSnapshot: () => {
        throw new Error("broken")
      },
    })
    transcript.pushInfo(["safe"])
    expect(transcript.view(40, 2, 0).join("\n")).toContain("safe")
  })

  test("policy bag vs inline legacy: view identik (parity TUI)", () => {
    setSessionLocale("en")
    const summary = {
      toolsOk: 2,
      toolsFailed: 1,
      toolsDenied: 0,
      toolsCancelled: 0,
      toolsInterrupted: 0,
      filesChanged: 1,
      checkpointId: "cp1",
      durationMs: 41000,
    }
    const snapshot: UiPresentationSnapshot = {
      activities: [
        activity({
          toolCallId: "p1",
          name: "delegate_task",
          target: undefined,
          status: "completed",
          supersedes: "old-1",
        }),
        activity({ toolCallId: "c1", name: "read_file", status: "failed", parentToolCallId: "p1" }),
      ],
      turns: [{ turnId: 3, status: "completed", summary }],
    }
    const events: UiPresentationEvent[] = [
      { type: "tool.completed", seq: 8, turnId: 3, toolCallId: "p1", status: "completed" },
      {
        type: "tool.failed",
        seq: 9,
        turnId: 3,
        toolCallId: "c1",
        status: "failed",
        message: "boom",
      },
      { type: "turn.completed", seq: 20, turnId: 3, summary },
    ]
    const views: string[][] = []
    for (const policy of [
      undefined,
      { describeActivity, matchTurn: matchTurnBySummary, elapsedVisible },
    ]) {
      const bus = createFakeBus()
      const transcript = new Transcript(bus as never, {
        getSnapshot: () => snapshot,
        policy,
      })
      const handler = (
        transcript as unknown as {
          presentationEvent: (e: UiPresentationEvent) => void
        }
      ).presentationEvent.bind(transcript)
      for (const event of events) handler(event)
      views.push(transcript.view(120, 20, 0))
    }
    expect(views[1]).toEqual(views[0])
    expect(views[0]!.join("\n")).toContain("delegate_task completed")
  })

  test("projection metadata tetap terikat pada baris ledger", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const entry = activity({ status: "completed" })
    setSnapshot({ activities: [entry], turns: [] })
    emitPresentation({ type: "tool.completed", seq: 12, turnId: 3, toolCallId: entry.toolCallId })
    const meta = (transcript as unknown as { meta: TranscriptMeta[] }).meta
    expect(meta[0]).toMatchObject({ kind: "activity", seq: 12, turnId: 3, toolCallId: "call-1" })
  })
})

// F-TASK-1: status task kanonik + DAG tampil sebagai baris ledger di TUI
// (bukan cuma di machine envelope).
describe("F-TASK-1: baris ledger status task", () => {
  test("task.status → baris `t1 completed parent=… dependsOn=[…] r2`", () => {
    setSessionLocale("en")
    const { transcript, emitPresentation } = setup()
    emitPresentation({
      type: "task.status",
      seq: 7,
      turnId: 1,
      taskId: "t1",
      taskStatus: "COMPLETED",
      parentId: "t0",
      dependsOn: ["t0", "t2"],
      revision: 2,
    })
    const out = transcript.view(120, 10, 0).join("\n")
    expect(out).toContain("t1 completed")
    expect(out).toContain("parent=t0")
    expect(out).toContain("dependsOn=[t0,t2]")
    expect(out).toContain("r2")
  })

  test("task.status tanpa parent/deps tetap menampilkan id + status", () => {
    setSessionLocale("en")
    const { transcript, emitPresentation } = setup()
    emitPresentation({
      type: "task.status",
      seq: 8,
      turnId: 1,
      taskId: "t9",
      taskStatus: "BLOCKED",
    })
    const out = transcript.view(120, 10, 0).join("\n")
    expect(out).toContain("t9 blocked")
    expect(out).not.toContain("dependsOn=")
  })
})

// F-AGENT-1 di renderer LINEAR (non-TTY): kegagalan tool anak paralel harus
// bisa dibedakan per run — marker `run_<8>` ikut di baris scrollback.
describe("F-AGENT-1: renderer linear (non-TTY) marker run", () => {
  test("tool anak gagal → baris `↳ run_<8>` keyed runId", () => {
    setSessionLocale("en")
    const tty = installFakeTty({ columns: 80, rows: 24 })
    try {
      const bus = createFakeBus()
      const child = activity({
        toolCallId: "child-1",
        name: "bash",
        target: "ls",
        parentToolCallId: "parent-1",
        childSessionId: "sub_0123456789abcdef0123456789abcdef",
        runId: "run_abcdef0123456789abcdef0123456789",
        status: "failed",
      })
      let handler: ((event: UiPresentationEvent) => void) | undefined
      const detach = attachSimpleLogger(bus as never, {
        getSnapshot: () => ({ activities: [child], turns: [] }),
        onPresentationEvent: (h) => {
          handler = h
          return () => {
            handler = undefined
          }
        },
      })
      handler?.({
        type: "tool.failed",
        seq: 5,
        turnId: 1,
        toolCallId: "child-1",
        status: "failed",
        message: "boom",
      })
      detach()
      const raw = tty.allErr()
      expect(raw).toContain("↳ run_abcdef01 bash ls")
      expect(raw).toContain("boom")
    } finally {
      tty.restore()
    }
  })
})
