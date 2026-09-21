// Unit Transcript: koleksi event → baris logis → viewport.
import { describe, expect, test } from "bun:test"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

function setup() {
  const bus = createFakeBus()
  const t = new Transcript(bus as never)
  return { bus, t }
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
  test("ledger tool sukses satu baris › nama target", () => {
    const { bus, t } = setup()
    bus.emit("execution:completed", {
      execution: { call: { name: "write_file", args: { path: "a.ts" } }, result: {} },
    })
    expect(t.view(60, 2, 0).join("\n")).toContain("› write_file a.ts")
  })
  test("ledger error satu baris merah diawali ›", () => {
    const { bus, t } = setup()
    bus.emit("execution:completed", {
      execution: {
        call: { name: "bash", args: { cmd: "false" } },
        result: { isError: true, content: "boom\nbaris2" },
      },
    })
    const out = t.view(60, 2, 0).join("\n")
    expect(out).toContain("› bash")
    expect(out).toContain("boom")
    expect(out).not.toContain("baris2")
  })
  test("nama tool tak terpercaya disanitasi (tak bisa clear-screen)", () => {
    const { bus, t } = setup()
    bus.emit("execution:completed", {
      execution: { call: { name: "x\x1b[2J", args: {} }, result: {} },
    })
    expect(t.view(60, 2, 0).join("")).not.toContain("\x1b[2J")
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
  test("cap 5000 membuang tertua", () => {
    const { t } = setup()
    const lines = Array.from({ length: 5010 }, (_, i) => `l${i}`)
    t.pushInfo(lines)
    expect(t.size()).toBe(5000)
    expect(t.view(40, 1, 4999)[0]).toBe("l10")
  })
  test("kompaksi konteks jadi baris redup", () => {
    const { bus, t } = setup()
    bus.emit("context:compacted", { reason: "penuh" })
    expect(t.view(40, 2, 0).join("\n")).toContain("compacted")
  })
  test("/expand: isi tool sukses dibuffer, sekali ambil habis", () => {
    const { bus, t } = setup()
    bus.emit("execution:completed", {
      execution: {
        call: { name: "read_file", args: { path: "a.ts" } },
        result: { content: "isi berkas\nbaris dua" },
      },
    })
    const got = t.takeBufferedSections()
    expect(got).toHaveLength(1)
    expect(got[0]!.label).toContain("read_file")
    expect(got[0]!.text).toContain("isi berkas")
    // Ambil kedua = kosong (arsip dibuka).
    expect(t.takeBufferedSections()).toHaveLength(0)
  })
  test("/expand: error dan konten kosong tak dibuffer", () => {
    const { bus, t } = setup()
    bus.emit("execution:completed", {
      execution: { call: { name: "bash", args: {} }, result: { isError: true, content: "boom" } },
    })
    bus.emit("execution:completed", {
      execution: { call: { name: "x", args: {} }, result: { content: "   " } },
    })
    expect(t.takeBufferedSections()).toHaveLength(0)
  })
  test("thinking minimized: penanda hidup, isi ke /expand, tanpa baris", () => {
    const { bus, t } = setup()
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "hmm " } })
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "mikirmodelrahasia" } })
    const live = t.view(40, 3, 0).join("\n")
    expect(live).toContain("thinking")
    expect(live).not.toContain("mikirmodelrahasia")
    bus.emit("turn:completed", {})
    // Penanda hilang, isi masuk buffer expand.
    expect(t.view(40, 3, 0).join("\n")).not.toContain("thinking")
    const got = t.takeBufferedSections()
    expect(got).toHaveLength(1)
    expect(got[0]!.label).toBe("thinking")
    expect(got[0]!.text).toContain("mikirmodelrahasia")
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
