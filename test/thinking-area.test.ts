// Fase 3: area thinking. Reasoning dirender sebagai blok LIVE maks 10 baris
// (header `+ thinking`, penanda "… N more lines") alih-alih stream per baris
// yang menumpuk permanen; saat turn selesai diringkas 1 baris + detail penuh
// masuk /expand. Mode area hanya aktif saat panel aktivitas ON.
import { afterEach, describe, expect, test } from "bun:test"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

afterEach(() => {
  resetLocaleState()
})

function setup(opts: { activityPanel: boolean; reasoningVisible?: boolean }) {
  setSessionLocale("en")
  const bus = createFakeBus()
  let handler: ((event: unknown) => void) | undefined
  const uiState = new UiSessionState({
    activityPanel: opts.activityPanel,
    reasoningVisible: opts.reasoningVisible ?? true,
  })
  const t = new Transcript(bus as never, {
    getSnapshot: () => ({ activities: [], turns: [] }),
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
    uiState,
    emit(event: Record<string, unknown>) {
      handler?.(event)
    },
    reason(text: string) {
      bus.emit("provider:extension", { kind: "reasoning", data: { text } })
    },
  }
}

const lines = (t: Transcript, height = 12) =>
  t
    .view(80, height, 0)
    .map(stripAnsi)
    .filter((l) => l.trim() !== "")

describe("area thinking (TUI)", () => {
  test("mode area: blok live muncul, belum di-commit per baris", () => {
    const { t, reason } = setup({ activityPanel: true })
    reason("baris-satu\nbaris-dua")
    const view = lines(t)
    expect(view.some((l) => l.includes("+ thinking"))).toBe(true)
    expect(view.some((l) => l.includes("baris-satu"))).toBe(true)
    expect(view.some((l) => l.includes("baris-dua"))).toBe(true)
    // Belum ada baris permanen: area dirender live.
    expect(t.size()).toBe(0)
  })

  test("mode area: dibatasi 10 baris terakhir + penanda lebih", () => {
    const { t, reason } = setup({ activityPanel: true })
    reason(
      Array.from({ length: 20 }, (_, i) => `l${i}`)
        .join("\n")
        .concat("\n"),
    )
    const view = lines(t, 20)
    expect(view.some((l) => l.includes("more lines"))).toBe(true)
    expect(view.some((l) => l.includes("l19"))).toBe(true)
    // l0 sudah keluar dari jendela 10 baris terakhir.
    expect(view.some((l) => l.includes("l0"))).toBe(false)
  })

  test("mode area: turn selesai → ringkas 1 baris + detail di /expand", () => {
    const { t, uiState, reason, emit } = setup({ activityPanel: true })
    reason("alpha\nbeta\ngamma")
    emit({ type: "turn.completed", seq: 1, turnId: 1 })
    const all = lines(t, 20).join("\n")
    expect(all).toContain("+ thinking")
    expect(all).toContain("3 lines")
    // Detail penuh tetap tersedia untuk /expand.
    const secs = uiState.collapsedSectionsSnapshot()
    expect(secs.some((s) => s.text.includes("alpha") && s.text.includes("gamma"))).toBe(true)
  })

  test("mode area: setelah turn selesai tidak ada duplikasi blok", () => {
    const { t, reason, emit } = setup({ activityPanel: true })
    reason("a\nb")
    emit({ type: "turn.completed", seq: 1, turnId: 1 })
    const all = lines(t, 20)
    const headers = all.filter((l) => l.includes("+ thinking"))
    expect(headers).toHaveLength(1)
  })

  test("panel OFF: perilaku legacy (stream per baris, tanpa header area)", () => {
    const { t, reason } = setup({ activityPanel: false })
    reason("satu\ndua")
    const view = lines(t)
    expect(view.some((l) => l.includes("satu"))).toBe(true)
    expect(view.some((l) => l.includes("+ thinking"))).toBe(false)
    // Satu baris sudah di-commit (legacy) + ekor hidup.
    expect(t.size()).toBe(1)
  })

  test("reasoning disembunyikan: tidak ada area sama sekali", () => {
    const { t, reason } = setup({ activityPanel: true, reasoningVisible: false })
    reason("rahasia")
    const view = lines(t)
    expect(view.some((l) => l.includes("rahasia"))).toBe(false)
    expect(view.some((l) => l.includes("+ thinking"))).toBe(false)
  })
})
