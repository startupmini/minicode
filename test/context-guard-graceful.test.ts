// Jalur graceful saat konteks nyaris penuh: guard host (provider) melempar
// context_length_exceeded (bukan budget_exceeded terminal) sehingga kernel
// menempuh force_compact_and_retry — meringkas lalu coba lagi, bukan mati
// "Context window exceeded".
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeProvider, finish, text } from "#minicore/test/fakes.ts"
import { createMinicodeSession } from "../src/app/session.ts"

function collectEvents(bus: { on: (e: string, h: (e: unknown) => void) => () => void }) {
  const events: { type: string; kind?: string; reason?: string }[] = []
  const unsubs: (() => void)[] = []
  unsubs.push(
    bus.on("provider:extension", (e) => {
      events.push({ type: "provider:extension", ...(e as { kind?: string }) })
    }),
  )
  unsubs.push(
    bus.on("context:compacted", (e) => {
      events.push({ type: "context:compacted", ...(e as { reason?: string }) })
    }),
  )
  return {
    events,
    unsubscribe: () =>
      unsubs.forEach((u) => {
        u()
      }),
  }
}

describe("context guard graceful (host-side)", () => {
  test("output meledak melewati allowance → context_length_exceeded → recovery compaction", async () => {
    // Konteks kecil: system+tools ≈ ratusan token (pressure low, tanpa kompaksi
    // kernel), tapi output raksasa melewati outputAllowance → guard host menembak.
    const p = new FakeProvider([{ events: [text("y".repeat(40_000)), finish("stop")] }])
    const s = await createMinicodeSession({
      provider: p,
      cwd: mkdtempSync(join(tmpdir(), "mc-guard-")),
      contextWindowTokens: 2_000,
      keepRecentTurns: 0,
    })
    const { events, unsubscribe } = collectEvents(s.events as never)
    try {
      await s.run("h", {}).catch(() => {})
      // Guard host menembak: context-window-limit di-emit (bukan mati diam-diam).
      const limit = events.filter((e) => e.kind === "context-window-limit")
      expect(limit.length).toBeGreaterThan(0)
      // Jalur graceful: guard melempar context_length_exceeded → kernel menempuh
      // force_compact_and_retry (event context:compacted reason "recovery").
      // Sebelum perubahan ini, guard melempar budget_exceeded terminal TANPA
      // event recovery ini.
      const compacted = events.filter(
        (e) => e.type === "context:compacted" && e.reason === "recovery",
      )
      expect(compacted.length).toBeGreaterThan(0)
    } finally {
      unsubscribe()
    }
  }, 15000)
})
