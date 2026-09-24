import { afterEach, describe, expect, test } from "bun:test"
import { runAcpSession } from "../cli/commands/acp.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import type {
  UiPresentationActivity,
  UiPresentationEvent,
  UiPresentationSnapshot,
} from "../src/ui/contract.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { setCompactMode } from "../src/ui/render/detail.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined

afterEach(() => {
  tty?.restore()
  tty = undefined
  setCompactMode(false)
  delete process.env.MINICODE_PRESENTATION_V2
  resetLocaleState()
})

function activity(overrides: Partial<UiPresentationActivity> = {}): UiPresentationActivity {
  return {
    toolCallId: "call-1",
    name: "write_file",
    target: "src/a.ts",
    status: "completed",
    tsStart: 1000,
    ...overrides,
  }
}

function linearSetup() {
  tty = installFakeTty({ columns: 100, rows: 24 })
  const bus = createFakeBus()
  let snapshot: UiPresentationSnapshot = { activities: [], turns: [] }
  let presentationHandler: ((event: UiPresentationEvent) => void) | undefined
  const detach = attachSimpleLogger(bus as never, {
    presentationV2: true,
    getSnapshot: () => snapshot,
    onPresentationEvent: (handler) => {
      presentationHandler = handler
      return () => {
        presentationHandler = undefined
      }
    },
  })
  return {
    bus,
    detach,
    setSnapshot(next: UiPresentationSnapshot) {
      snapshot = next
    },
    emitPresentation(event: UiPresentationEvent) {
      presentationHandler?.(event)
    },
    out: () => stripAnsi(tty!.combined()),
  }
}

function acpSetup() {
  let rawHandler: ((event: unknown) => void) | undefined
  let presentationHandler: ((event: UiPresentationEvent) => void) | undefined
  const snapshot: UiPresentationSnapshot = { activities: [], turns: [] }
  const session = {
    session: {
      events: {
        on: (type: string, handler: (event: unknown) => void) => {
          if (type === "*") rawHandler = handler
          return () => {}
        },
      },
      state: { stepCount: 1, turnCount: 1 },
    },
    usage: {
      getSession: () => ({ inputTokens: 4, outputTokens: 2, totalTokens: 6 }),
    },
    modelRef: { current: "fake::m" },
    getPresentationSnapshot: () => snapshot,
    onPresentationEvent: (handler: (event: UiPresentationEvent) => void) => {
      presentationHandler = handler
      return () => {
        presentationHandler = undefined
      }
    },
    runPromptWithVerify: async () => {
      rawHandler?.({ type: "provider:text", text: "halo" })
      presentationHandler?.({
        type: "turn.started",
        seq: 1,
        turnId: 1,
      })
      snapshot.activities.push(
        activity({ status: "running", durationMs: undefined, receipt: undefined }),
      )
      presentationHandler?.({
        type: "tool.started",
        seq: 2,
        turnId: 1,
        toolCallId: "call-1",
        name: "write_file",
        qualified: "write_file",
        target: "src/a.ts",
        status: "running",
        tsStart: 1000,
      })
      snapshot.activities[0]!.status = "denied"
      presentationHandler?.({
        type: "tool.denied",
        seq: 3,
        turnId: 1,
        toolCallId: "call-1",
        status: "denied",
        message: "permission denied",
      })
      presentationHandler?.({
        type: "approval.requested",
        seq: 4,
        turnId: 1,
        approvalId: "approval-1",
        toolCallId: "call-1",
        name: "write_file",
        qualified: "write_file",
        target: "src/a.ts",
        via: "system",
      })
      presentationHandler?.({
        type: "approval.settled",
        seq: 5,
        turnId: 1,
        approvalId: "approval-1",
        toolCallId: "call-1",
        outcome: { decision: "deny", by: "system", reason: "headless" },
      })
      presentationHandler?.({
        type: "turn.completed",
        seq: 6,
        turnId: 1,
        summary: {
          toolsOk: 0,
          toolsFailed: 0,
          toolsDenied: 1,
          toolsCancelled: 0,
          toolsInterrupted: 0,
          filesChanged: 0,
          durationMs: 40,
        },
      })
    },
    close: async () => {},
  }
  return {
    session,
    createSession: (async () => session) as never,
  }
}

describe("P6 linear projection", () => {
  test("status denied dari presentation menggantikan raw error tanpa duplikasi", () => {
    setSessionLocale("en")
    const { bus, detach, setSnapshot, emitPresentation, out } = linearSetup()
    setSnapshot({ activities: [activity({ status: "denied" })], turns: [] })
    emitPresentation({
      type: "tool.denied",
      toolCallId: "call-1",
      status: "denied",
    })
    bus.emit("execution:completed", {
      execution: {
        call: { id: "call-1", name: "write_file", args: { path: "src/a.ts" } },
        result: { isError: true, content: "permission denied" },
      },
    })
    detach()
    const text = out()
    expect(text).toContain("write_file src/a.ts")
    expect(text).toContain("denied")
    expect(text.match(/write_file src\/a\.ts/g)).toHaveLength(1)
  })

  test("completed mem projecting duration dan receipt dari snapshot", () => {
    setSessionLocale("en")
    const { bus, detach, setSnapshot, out } = linearSetup()
    setSnapshot({
      activities: [
        activity({
          durationMs: 120,
          receipt: { paths: ["src/a.ts"] },
        }),
      ],
      turns: [],
    })
    bus.emit("execution:completed", {
      execution: {
        call: { id: "call-1", name: "write_file", args: { path: "src/a.ts" } },
        result: { isError: false, content: "3 chars" },
      },
    })
    detach()
    const text = out()
    expect(text).toContain("120ms")
    expect(text).toContain("receipt src/a.ts")
  })
})

describe("P6 ACP lifecycle projection", () => {
  test("tool, approval, turn lifecycle terstruktur tanpa response ganda", async () => {
    process.env.MINICODE_PRESENTATION_V2 = "1"
    const f = acpSetup()
    const out: string[] = []
    await runAcpSession(
      31,
      { prompt: "x" },
      {
        write: (line) => out.push(line),
        onDone: () => {},
        startFlight: () => {},
        shouldExit: () => false,
        exit: () => {},
        createSession: f.createSession,
      },
    )
    const notes = out.map((line) => JSON.parse(line) as Record<string, unknown>)
    const types = notes.map((note) => note.type)
    expect(types).toContain("tool.started")
    expect(types).toContain("tool.denied")
    expect(types).toContain("approval.requested")
    expect(types).toContain("approval.settled")
    expect(types).toContain("turn.completed")
    expect(notes.find((note) => note.type === "tool.denied")).toMatchObject({
      toolCallId: "call-1",
      status: "denied",
    })
    expect(notes.find((note) => note.type === "approval.settled")).toMatchObject({
      approvalId: "approval-1",
      outcome: { decision: "deny", by: "system" },
    })
    expect(notes[notes.length - 1]).toMatchObject({ id: 31, result: { ok: true } })
  })
})
