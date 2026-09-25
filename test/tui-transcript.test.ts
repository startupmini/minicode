// Unit Transcript: koleksi event → baris logis → viewport.
import { describe, expect, test } from "bun:test"
import type { UiPresentationActivity, UiPresentationSnapshot } from "../src/ui/contract.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

function setup() {
  const bus = createFakeBus()
  const t = new Transcript(bus as never)
  return { bus, t }
}

function activity(overrides: Partial<UiPresentationActivity> = {}): UiPresentationActivity {
  return {
    toolCallId: "call-1",
    name: "write_file",
    target: "a.ts",
    status: "completed",
    tsStart: Date.now(),
    ...overrides,
  }
}

function setupPresentation(snapshot: UiPresentationSnapshot) {
  const bus = createFakeBus()
  let handler: ((event: never) => void) | undefined
  const t = new Transcript(bus as never, {
    getSnapshot: () => snapshot,
    onPresentationEvent: (next) => {
      handler = next as (event: never) => void
      return () => {
        handler = undefined
      }
    },
  })
  return {
    bus,
    t,
    emit(type: string, payload: Record<string, unknown>) {
      handler?.({ type, ...payload } as never)
    },
  }
}

describe("Transcript", () => {
  test("teks model mengalir sebagai ekor hidup lalu commit saat turn selesai", () => {
    const { bus, t } = setup()
    bus.emit("provider:text", { text: "halo " })
    // Belum commit tapi terlihat di viewport (ekor hidup).
    expect(t.view(40, 3, 0).join("\n")).toContain("halo")
    bus.emit("provider:text", { text: "dunia" })
    bus.emit("turn:completed", {})
    expect(t.size()).toBe(1)
    expect(t.view(40, 3, 0)[2]).toBe("halo dunia")
  })
  test("buffer live punya cap dan menandai truncasi", () => {
    const bus = createFakeBus()
    const t = new Transcript(bus as never, { maxPendingChars: 10 })
    bus.emit("provider:text", { text: "012345" })
    bus.emit("provider:text", { text: "6789ABC" })
    expect(t.view(40, 3, 0).join("\n")).toContain("truncated")
    bus.emit("turn:completed", {})
    expect(t.view(40, 3, 0).join("\n")).toContain("truncated")
  })
  test("ledger tool sukses satu baris › nama target", () => {
    const { t, emit } = setupPresentation({
      activities: [activity({ status: "completed" })],
      turns: [],
    })
    emit("tool.completed", { seq: 1, turnId: 1, toolCallId: "call-1", status: "completed" })
    const out = t.view(60, 2, 0).join("\n")
    expect(out).toContain("write_file a.ts")
    expect(out).toContain("completed")
  })
  test("ledger error satu baris merah diawali ›", () => {
    const { t, emit } = setupPresentation({
      activities: [
        activity({
          toolCallId: "bash-1",
          name: "bash",
          target: undefined,
          status: "failed",
        }),
      ],
      turns: [],
    })
    emit("tool.failed", {
      seq: 1,
      turnId: 1,
      toolCallId: "bash-1",
      status: "failed",
      message: "boom\nbaris2",
    })
    const out = t.view(60, 2, 0).join("\n")
    expect(out).toContain("bash")
    expect(out).toContain("failed")
    expect(out).toContain("boom")
    expect(out).not.toContain("baris2")
  })
  test("nama tool tak terpercaya disanitasi (tak bisa clear-screen)", () => {
    const { t, emit } = setupPresentation({
      activities: [activity({ toolCallId: "x1", name: "x\x1b[2J", target: undefined })],
      turns: [],
    })
    emit("tool.completed", { seq: 1, turnId: 1, toolCallId: "x1", status: "completed" })
    expect(t.view(60, 2, 0).join("")).not.toContain("\x1b[2J")
  })
  test("jawaban model me-render markdown inline (bold/code/heading)", () => {
    const { bus, t } = setup()
    bus.emit("provider:text", { text: "## Ringkasan\nHasil **tebal** dan `kode`." })
    const out = t.view(60, 4, 0).join("\n")
    expect(out).toContain("Ringkasan")
    expect(out).toContain("tebal")
    expect(out).toContain("kode")
    expect(out).not.toContain("**")
    expect(out).not.toContain("##")
    expect(out).not.toContain("`kode`")
  })
  test("code fence model menyembunyikan delimiter dan menjaga isi literal", () => {
    const { bus, t } = setup()
    bus.emit("provider:text", { text: "```\n**bukan bold**\n```" })
    const out = t.view(60, 4, 0).join("\n")
    expect(out).toContain("**bukan bold**")
    expect(out).not.toContain("```")
  })
  test("gema user tidak me-render markdown (literal)", () => {
    const { t } = setup()
    t.pushUser("pakai **bintang** ya")
    expect(t.view(60, 2, 0).join("\n")).toContain("**bintang**")
  })
  test("gema user + error + info + clear", () => {
    const { t } = setup()
    t.pushUser("tanya\nlanjut")
    t.pushError("gagal <x>")
    t.pushInfo(["satu", "dua"])
    const out = t.view(40, 6, 0).join("\n")
    expect(out).toContain("minicode › tanya")
    expect(out).toContain("✗ gagal <x>")
    expect(out).toContain("dua")
    t.clear()
    expect(t.size()).toBe(0)
    expect(t.view(40, 2, 0)).toEqual(["", ""])
  })
  test("view selalu tepat height (padding) + scrollBack menggeser", () => {
    const { t } = setup()
    t.pushInfo(["a", "b", "c", "d"])
    expect(t.view(40, 6, 0)).toEqual(["", "", "a", "b", "c", "d"])
    expect(t.view(40, 2, 2)).toEqual(["a", "b"])
  })
  test("cap 5000 membuang tertua dan menambahkan marker", () => {
    const { t } = setup()
    const lines = Array.from({ length: 5010 }, (_, i) => `l${i}`)
    t.pushInfo(lines)
    expect(t.size()).toBe(5001)
    expect(t.view(100, 1, 5000)[0]).toContain("10 early lines")
  })
  test("total() monotonik kebal evict (basis indikator F-08)", () => {
    // size() menyusut saat cap membuang tertua → newCount negatif/hilang.
    const { t } = setup()
    t.pushInfo(Array.from({ length: 5010 }, (_, i) => `l${i}`))
    expect(t.size()).toBe(5001)
    expect(t.total()).toBe(5010)
    t.pushInfo(["baru"])
    expect(t.total()).toBe(5011)
  })
  test("projection selection menyalin logical text tanpa wrap/prefix", () => {
    const { t } = setup()
    t.pushInfo(["alpha beta", "gamma"])
    t.pushUser("prompt\nnext")
    const rows = t.viewport(40, 8, 0).rows
    const alpha = rows.find((row) => row.text.includes("alpha"))!
    const prompt = rows.find((row) => row.text.includes("minicode"))!
    const alphaStart = t.pointAt(alpha, 0)!
    const alphaEnd = t.pointAt(alpha, 5)!
    expect(t.selectionText(alphaStart, alphaEnd)).toBe("alpha")
    const promptStart = t.pointAt(prompt, 11)!
    expect(t.selectionText(promptStart, promptStart)).toBe("")
  })
  test("selection wrapped tetap satu logical source tanpa newline artefaktual", () => {
    const { t } = setup()
    t.pushInfo(["abcdefghijklmnopqrst"])
    const rows = t.viewport(10, 4, 0).rows.filter((row) => row.selectable)
    const start = t.pointAt(rows[0]!, 1)!
    const end = t.pointAt(rows[1]!, 10)!
    expect(t.selectionText(start, end)).toBe("bcdefghijklmnopqrst")
  })
  test("user prompt wrapped tetap copy tanpa prefix chrome", () => {
    const { t } = setup()
    t.pushUser("abcdefghijkl")
    const rows = t.viewport(10, 4, 0).rows.filter((row) => row.selectable)
    const start = t.pointAt(rows[0]!, 0)!
    const last = rows[rows.length - 1]!
    const end = t.pointAt(last, displayWidth(last.text))!
    expect(t.selectionText(start, end)).toBe("abcdefghijkl")
  })
  test("tabel selection memakai TSV tanpa border/padding", () => {
    const { t } = setup()
    t.pushInfo(["| A | B |\n| --- | --- |\n| x | y |"])
    const rows = t.viewport(40, 8, 0).rows.filter((row) => row.selectable)
    const start = t.pointAt(rows[0]!, 0)!
    const end = t.pointAt(rows[rows.length - 1]!, 40)!
    expect(t.selectionText(start, end)).toBe("A\tB\nx\ty")
  })
  test("wrappedLength = jumlah baris visual view (kunci scroll)", () => {
    const { t } = setup()
    t.pushInfo(["a", "b", "c"])
    expect(t.wrappedLength(40)).toBe(3)
    expect(t.view(40, 3, 0).filter((l) => l !== "").length).toBe(3)
  })
  test("kompaksi konteks jadi baris redup", () => {
    const { bus, t } = setup()
    bus.emit("context:compacted", { reason: "penuh" })
    expect(t.view(40, 2, 0).join("\n")).toContain("compacted")
  })
  test("thinking minimized: transcript bersih, indikator dots dimiliki App", () => {
    const { bus, t } = setup()
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "hmm " } })
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "mikirmodelrahasia" } })
    const live = t.view(40, 3, 0).join("\n")
    expect(live).not.toContain("thinking")
    expect(live).not.toContain("mikirmodelrahasia")
    bus.emit("turn:completed", {})
    expect(t.view(40, 3, 0).join("\n")).not.toContain("thinking")
  })
  test("thinking expanded: mengalir redup per baris", async () => {
    const { setReasoningVisible } = await import("../src/ui/render/reasoning.ts")
    setReasoningVisible(true)
    try {
      const { bus, t } = setup()
      bus.emit("provider:extension", { kind: "reasoning", data: { text: "baris-satu\nbaris-dua" } })
      const live = t.view(60, 4, 0).join("\n")
      expect(live).toContain("baris-satu")
      expect(live).not.toContain("… thinking")
    } finally {
      setReasoningVisible(false)
    }
  })
})
