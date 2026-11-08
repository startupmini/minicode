// Lipat aktivitas tool per turn (opencode-like, `MINICODE_MINIMIZE_ACTIVITY`):
// baris ledger per-tool ditahan saat minimize, lalu di-flush jadi satu section
// `/expand` pada turn.completed. Transparan (off) = perilaku lama.
import { describe, expect, test } from "bun:test"
import type {
  UiPresentationActivity,
  UiPresentationEvent,
  UiPresentationSnapshot,
} from "../src/ui/contract.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

function activity(overrides: Partial<UiPresentationActivity>): UiPresentationActivity {
  return {
    toolCallId: "call-1",
    name: "read_file",
    target: "a.ts",
    status: "completed",
    tsStart: 1,
    ...overrides,
  }
}

function build(minimizeActivity: boolean) {
  const bus = createFakeBus()
  const uiState = new UiSessionState({ minimizeActivity })
  const snapshot: UiPresentationSnapshot = {
    activities: [
      activity({ toolCallId: "c1", name: "read_file", target: "a.ts" }),
      activity({ toolCallId: "c2", name: "bash", target: undefined }),
    ],
    turns: [],
  }
  const transcript = new Transcript(bus as never, {
    getSnapshot: () => snapshot,
    uiState,
  })
  const emit = (event: UiPresentationEvent) =>
    (
      transcript as unknown as { presentationEvent: (e: UiPresentationEvent) => void }
    ).presentationEvent.call(transcript, event)
  return { transcript, uiState, emit }
}

describe("activity fold (minimizeActivity)", () => {
  test("setMinimizeActivity tidak menulis process.env (F-ENV-1)", () => {
    delete process.env.MINICODE_MINIMIZE_ACTIVITY
    const s = new UiSessionState()
    s.setMinimizeActivity(true)
    expect(process.env.MINICODE_MINIMIZE_ACTIVITY).toBeUndefined()
    s.setMinimizeActivity(false)
    expect(process.env.MINICODE_MINIMIZE_ACTIVITY).toBeUndefined()
  })

  test("on: baris ledger per-tool ditahan, di-flush ke /expand saat turn selesai", () => {
    const { transcript, uiState, emit } = build(true)
    emit({ type: "tool.completed", seq: 1, turnId: 1, toolCallId: "c1", status: "completed" })
    emit({ type: "tool.completed", seq: 2, turnId: 1, toolCallId: "c2", status: "completed" })
    // Selama turn: tidak ada baris ledger individual di viewport.
    expect(transcript.view(40, 10, 0).join("\n")).not.toContain("read_file")
    expect(transcript.view(40, 10, 0).join("\n")).not.toContain("bash")

    emit({ type: "turn.completed", seq: 3, turnId: 1 })
    const folded = uiState.collapsedSectionsSnapshot().find((s) => s.label === "activity")
    expect(folded).toBeTruthy()
    expect(folded!.text).toContain("read_file")
    expect(folded!.text).toContain("bash")
  })

  test("off: baris ledger per-tool tetap tampil (transparan)", () => {
    const { transcript, emit } = build(false)
    emit({ type: "tool.completed", seq: 1, turnId: 1, toolCallId: "c1", status: "completed" })
    const view = transcript.view(40, 10, 0).join("\n")
    expect(view).toContain("read_file")
  })
})
