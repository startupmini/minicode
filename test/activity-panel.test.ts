// Panel aktivitas (Fase 2): grup tool + baris ringkas. Unit test murni —
// tidak butuh TUI/PTY. Renderer (transcript/simple) diuji terpisah.
import { describe, expect, test } from "bun:test"
import type { UiPresentationActivity } from "../src/ui/contract.ts"
import { setSessionLocale } from "../src/ui/i18n/locale.ts"
import { activityGroup } from "../src/ui/render/activity-group.ts"
import { groupActivities, groupLine, renderActivityPanel } from "../src/ui/render/activity-panel.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

function act(overrides: Partial<UiPresentationActivity> = {}): UiPresentationActivity {
  return {
    toolCallId: "call-1",
    name: "read_file",
    status: "completed",
    tsStart: 1,
    ...overrides,
  }
}

describe("activityGroup (klasifikasi keluarga)", () => {
  test("tool baca masuk explore", () => {
    for (const name of ["read_file", "read_image", "glob", "grep"]) {
      expect(activityGroup(name)).toBe("explore")
    }
  })
  test("tool tulis masuk edit", () => {
    for (const name of ["edit", "apply_patch", "write_file", "delete_file", "move_file"]) {
      expect(activityGroup(name)).toBe("edit")
    }
  })
  test("tool eksekusi masuk execute", () => {
    for (const name of ["bash", "code_run", "mcp_call", "git_commit"]) {
      expect(activityGroup(name)).toBe("execute")
    }
  })
  test("tool sumber eksternal masuk feed", () => {
    for (const name of ["web_search", "web_fetch", "read_memory", "delegate_task"]) {
      expect(activityGroup(name)).toBe("feed")
    }
  })
  test("tool tak dikenal fallback other", () => {
    expect(activityGroup("acak_provider")).toBe("other")
  })
})

describe("groupActivities", () => {
  test("mengelompokkan + menghitung status", () => {
    const groups = groupActivities([
      act({ name: "read_file", status: "completed" }),
      act({ name: "grep", status: "completed" }),
      act({ name: "bash", status: "failed" }),
      act({ name: "bash", status: "running" }),
    ])
    expect(groups.get("explore")).toMatchObject({ count: 2, ok: 2, failed: 0 })
    expect(groups.get("execute")).toMatchObject({ count: 2, ok: 0, failed: 1, running: 1 })
  })

  test("nama tool unik (maks 3)", () => {
    const groups = groupActivities([
      act({ name: "grep" }),
      act({ name: "read_file" }),
      act({ name: "glob" }),
      act({ name: "lsp_diagnostics" }),
    ])
    expect(groups.get("explore")?.names.length).toBeLessThanOrEqual(3)
  })

  test("kosong tidak menghasilkan apa pun", () => {
    expect(renderActivityPanel([])).toEqual([])
  })
})

describe("groupLine / renderActivityPanel", () => {
  test("baris grup: label + hitungan", () => {
    const line = groupLine(groupActivities([act({ name: "read_file" })]).get("explore")!)
    expect(stripAnsi(line)).toContain("+ explore")
    expect(stripAnsi(line)).toContain("1 tools")
    expect(stripAnsi(line)).toContain("1 ok")
  })

  test("renders satu baris per grup, tanpa duplikasi", () => {
    const out = renderActivityPanel([
      act({ name: "read_file" }),
      act({ name: "grep" }),
      act({ name: "bash" }),
    ])
    expect(out).toHaveLength(2)
    expect(stripAnsi(out.join("\n"))).toContain("explore")
    expect(stripAnsi(out.join("\n"))).toContain("execute")
  })

  test("maxRows membatasi jumlah baris", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      act({ name: i % 2 === 0 ? "read_file" : "bash" }),
    )
    expect(renderActivityPanel(many, { maxRows: 1 })).toHaveLength(1)
  })

  test("semua teks tool tersanitasi (tidak ada ANSI mentah)", () => {
    const out = renderActivityPanel([act({ name: "read_file\x1b[31m" })])
    expect(out.join("\n")).not.toContain("\x1b[31m")
  })
})

describe("panel aktivitas di Transcript (TUI)", () => {
  function setupTui(activityPanel: boolean) {
    setSessionLocale("en")
    const bus = createFakeBus()
    let handler: ((event: unknown) => void) | undefined
    let snapshot: { activities: UiPresentationActivity[]; turns: never[] } = {
      activities: [],
      turns: [],
    }
    const uiState = new UiSessionState({ activityPanel })
    const t = new Transcript(bus as never, {
      getSnapshot: () => snapshot,
      onPresentationEvent: (next) => {
        handler = next as (event: unknown) => void
        return () => {
          handler = undefined
        }
      },
      uiState,
    })
    return {
      t,
      setSnapshot(next: { activities: UiPresentationActivity[]; turns: never[] }) {
        snapshot = next
      },
      emit(event: Record<string, unknown>) {
        handler?.(event)
      },
    }
  }

  const groupLines = (t: Transcript) =>
    t
      .view(80, 12, 0)
      .map(stripAnsi)
      .filter((line) => line.startsWith("+ "))

  test("panel ON: tool selesai di turn berjalan tampil sebagai grup live", () => {
    const { t, emit } = setupTui(true)
    emit({ type: "turn.started", seq: 1, turnId: 1 })
    emit({
      type: "tool.completed",
      seq: 2,
      turnId: 1,
      toolCallId: "c1",
      name: "read_file",
      status: "completed",
      tsStart: 1,
    })
    emit({
      type: "tool.completed",
      seq: 3,
      turnId: 1,
      toolCallId: "c2",
      name: "grep",
      status: "completed",
      tsStart: 1,
    })
    const lines = groupLines(t)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("explore")
    expect(lines[0]).toContain("2 tools")
  })

  test("panel ON: turn selesai meng-commit grup tanpa duplikat", () => {
    const { t, emit } = setupTui(true)
    emit({ type: "turn.started", seq: 1, turnId: 1 })
    emit({
      type: "tool.completed",
      seq: 2,
      turnId: 1,
      toolCallId: "c1",
      name: "read_file",
      status: "completed",
      tsStart: 1,
    })
    // Sebelum turn selesai: satu baris grup live.
    expect(groupLines(t)).toHaveLength(1)
    emit({ type: "turn.completed", seq: 3, turnId: 1 })
    // Setelah: tetap SATU (live dikosongkan, fold di-commit) — bukan dua.
    expect(groupLines(t)).toHaveLength(1)
  })

  test("panel OFF: ledger per-tool tetap tampil (tanpa grup)", () => {
    const { t, emit } = setupTui(false)
    emit({ type: "turn.started", seq: 1, turnId: 1 })
    emit({
      type: "tool.completed",
      seq: 2,
      turnId: 1,
      toolCallId: "c1",
      name: "read_file",
      status: "completed",
      tsStart: 1,
    })
    expect(groupLines(t)).toHaveLength(0)
    expect(
      t
        .view(80, 12, 0)
        .map(stripAnsi)
        .some((l) => l.includes("read_file")),
    ).toBe(true)
  })

  test("panel ON: tool yang sedang running tetap tampil (tidak ditelan panel)", () => {
    const { t, emit, setSnapshot } = setupTui(true)
    emit({ type: "turn.started", seq: 1, turnId: 1 })
    setSnapshot({
      activities: [act({ toolCallId: "c1", name: "bash", status: "running" })],
      turns: [],
    })
    emit({
      type: "tool.started",
      seq: 2,
      turnId: 1,
      toolCallId: "c1",
      name: "bash",
      status: "running",
      tsStart: Date.now(),
    })
    const text = t.view(80, 12, 0).map(stripAnsi).join("\n")
    expect(text).toContain("bash")
    expect(text).toContain("running")
    // Belum terminal → tidak ada baris grup.
    expect(groupLines(t)).toHaveLength(0)
  })
})
