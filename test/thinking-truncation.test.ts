// Regresi F3 — buffer thinking yang memotong head harus menandainya.
// Latar: thinkingBuf.slice(-200_000) membuang kepala diam-diam sehingga
// operator percaya seluruh thinking tersedia di /expand (temuan audit F3).
// Marker mengikuti terminologi repo ("… (N more…)", ", capped 1MB").
// Test ini HARUS gagal di kode lama (tanpa marker).
import { describe, expect, test } from "bun:test"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import { clearCollapsedSections, collapsedSectionsSnapshot } from "../src/ui/render/collapse.ts"

function makeBus(): {
  on(type: string, h: (e: never) => void): () => void
  emit(type: string, ev: never): void
} {
  const map = new Map<string, ((e: never) => void)[]>()
  return {
    on(type: string, h: (e: never) => void): () => void {
      const list = map.get(type) ?? []
      list.push(h)
      map.set(type, list)
      return () => {}
    },
    emit(type: string, ev: never): void {
      for (const h of map.get(type) ?? []) h(ev)
    },
  }
}

describe("F3: marker truncasi thinking", () => {
  test("thinking >200KB: /expand membawa marker head terpotong", () => {
    clearCollapsedSections()
    const bus = makeBus()
    const detach = attachSimpleLogger(bus, {})
    bus.emit("turn:started", { turn: 0 } as never)
    // Mode minimized (default: MINICODE_SHOW_THINKING tak diset) → buffer.
    bus.emit("provider:extension", {
      kind: "reasoning",
      data: { text: "t".repeat(250_000) },
    } as never)
    bus.emit("turn:completed", {} as never)
    detach()
    const secs = collapsedSectionsSnapshot()
    const thinking = secs.find((s) => s.label === "thinking" || s.text.includes("t".repeat(100)))
    expect(thinking).toBeTruthy()
    expect(thinking!.text.length).toBeLessThanOrEqual(200_000 + 200)
    expect(thinking!.text).toContain("truncated")
    clearCollapsedSections()
  })

  test("thinking kecil: tanpa marker (tak ada yang dibuang)", () => {
    clearCollapsedSections()
    const bus = makeBus()
    const detach = attachSimpleLogger(bus, {})
    bus.emit("turn:started", { turn: 0 } as never)
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "pendek" } } as never)
    bus.emit("turn:completed", {} as never)
    detach()
    const secs = collapsedSectionsSnapshot()
    const thinking = secs.find((s) => s.text.includes("pendek"))
    expect(thinking).toBeTruthy()
    expect(thinking!.text).not.toContain("truncated")
    clearCollapsedSections()
  })
})
