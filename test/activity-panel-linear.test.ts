// Panel aktivitas di jalur LINEAR (Fase 2): saat `ui.activityPanel` ON,
// turn:completed mencetak blok ringkas per keluarga tool (append-only ke
// stderr) — terpisah dari baris ledger per-tool yang tetap hidup. Unit test
// memakai attachSimpleLogger langsung (tanpa proses anak).
import { afterEach, describe, expect, test } from "bun:test"
import { describeActivity } from "../src/presentation/projection.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import type {
  PresentationPolicy,
  UiPresentationActivity,
  UiPresentationSnapshot,
} from "../src/ui/contract.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined

afterEach(() => {
  tty?.restore()
  tty = undefined
  resetLocaleState()
})

const policy: PresentationPolicy = {
  describeActivity,
  matchTurn: () => undefined,
  elapsedVisible: () => true,
  verificationMark: () => "",
  provenanceMark: () => "",
}

function act(overrides: Partial<UiPresentationActivity> = {}): UiPresentationActivity {
  return {
    toolCallId: "call-1",
    name: "read_file",
    status: "completed",
    tsStart: 1000,
    ...overrides,
  }
}

function linearSetup(activityPanel: boolean) {
  tty = installFakeTty({ columns: 100, rows: 24, isTTY: true })
  const bus = createFakeBus()
  let snapshot: UiPresentationSnapshot = { activities: [], turns: [] }
  const uiState = new UiSessionState({ activityPanel })
  const detach = attachSimpleLogger(bus as never, {
    getSnapshot: () => snapshot,
    uiState,
    policy,
  })
  return {
    bus,
    detach,
    uiState,
    setSnapshot(next: UiPresentationSnapshot) {
      snapshot = next
    },
    out: () => stripAnsi(tty!.combined()),
  }
}

describe("panel aktivitas linear (Fase 2)", () => {
  test("activityPanel OFF: turn selesai tanpa blok ringkas", () => {
    const { bus, detach, setSnapshot, out } = linearSetup(false)
    try {
      setSnapshot({
        activities: [act({ name: "bash", status: "completed" })],
        turns: [],
      })
      bus.emit("turn:completed", {})
      expect(out()).not.toContain("activity")
      expect(out()).not.toContain("+ ")
    } finally {
      detach()
    }
  })

  test("activityPanel ON: blok ringkas per keluarga tool saat turn selesai", () => {
    const { bus, detach, setSnapshot, out } = linearSetup(true)
    try {
      setSnapshot({
        activities: [
          act({ name: "read_file", status: "completed" }),
          act({ name: "grep", status: "completed" }),
          act({ name: "bash", status: "completed" }),
        ],
        turns: [],
      })
      bus.emit("turn:completed", {})
      const text = out()
      expect(text).toContain("activity")
      expect(text).toContain("+ explore")
      expect(text).toContain("+ execute")
    } finally {
      detach()
    }
  })

  test("activityPanel ON tapi tanpa activity: tidak mencetak apa pun", () => {
    const { bus, detach, setSnapshot, out } = linearSetup(true)
    try {
      setSnapshot({ activities: [], turns: [] })
      bus.emit("turn:completed", {})
      expect(out()).not.toContain("activity")
    } finally {
      detach()
    }
  })

  test("label grup mengikuti bahasa sesi (id)", () => {
    const { bus, detach, setSnapshot, out } = linearSetup(true)
    // installFakeTty mem-pin locale ke en; override SETELAH install.
    setSessionLocale("id")
    try {
      setSnapshot({
        activities: [act({ name: "web_search", status: "completed" })],
        turns: [],
      })
      bus.emit("turn:completed", {})
      expect(out()).toContain("+ sumber")
    } finally {
      detach()
    }
  })
})
