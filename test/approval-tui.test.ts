// Approval sebagai warga TUI: blok tercatat di transkrip + repaint sebelum
// menjawab; keputusan tercatat. Tanpa sink = tulis langsung warisan.
import { afterEach, describe, expect, test } from "bun:test"
import { promptAsk, promptAskText } from "../src/ui/approval/prompt.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { getApprovalSink, setApprovalSink } from "../src/ui/tui/transcript.ts"
import { installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null
afterEach(() => {
  tty?.restore()
  tty = null
  setApprovalSink(null)
})

describe("approval sink TUI", () => {
  test("jawaban y → allow + blok dan keputusan tercatat + repaint", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const blocks: string[][] = []
    let repaints = 0
    setApprovalSink({
      pushBlock: (lines) => blocks.push(lines),
      repaint: () => repaints++,
      suspend: () => {},
      resume: () => {},
    })
    const p = promptAsk({ name: "bash", args: { command: "rm -rf /" } })
    await tty.ready()
    await tty.send("y")
    await tty.send(KEY.enter)
    expect(await p).toBe("allow")
    expect(blocks.length).toBe(2)
    const q = stripAnsi(blocks[0]!.join("\n"))
    expect(q).toContain("Approval required")
    expect(q).toContain("bash")
    expect(q).toContain("rm -rf /")
    expect(stripAnsi(blocks[1]!.join("\n"))).toContain("allow")
    // Repaint sebelum menjawab + sesudah keputusan.
    expect(repaints).toBeGreaterThanOrEqual(2)
    expect(getApprovalSink()).not.toBeNull()
  })
  test("Esc → deny (fail-closed)", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const blocks: string[][] = []
    setApprovalSink({
      pushBlock: (lines) => blocks.push(lines),
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
    })
    const p = promptAsk({ name: "write_file", args: { path: "a.ts" } })
    await tty.ready()
    await tty.send(KEY.esc, 90)
    expect(await p).toBe("deny")
    expect(stripAnsi(blocks.flat().join("\n"))).toContain("deny")
  })
  test("tanpa sink = tulis langsung ke stdout (warisan)", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    expect(getApprovalSink()).toBeNull()
    const p = promptAsk({ name: "bash", args: {} })
    await tty.ready()
    await tty.send("a")
    await tty.send(KEY.enter)
    expect(await p).toBe("always")
    expect(stripAnsi(tty.all())).toContain("Approval required")
  })
  test("promptAskText tercatat + jawabannya (dipotong)", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const blocks: string[][] = []
    setApprovalSink({
      pushBlock: (lines) => blocks.push(lines),
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
    })
    const p = promptAskText("Apa warna langit?", ["biru", "hijau"])
    await tty.ready()
    await tty.send("biru")
    await tty.send(KEY.enter)
    expect(await p).toBe("biru")
    const all = stripAnsi(blocks.flat().join("\n"))
    expect(all).toContain("Agent asks")
    expect(all).toContain("biru")
  })
  test("App dibekukan selama menunggu jawaban (anti double-handling)", async () => {
    // Gagal-di-kode-lama: listener App + repaint live berlomba dengan askLine
    // — prompt tak terlihat, user mengetik buta.
    tty = installFakeTty({ columns: 80, rows: 24 })
    let suspended = 0
    let resumed = 0
    setApprovalSink({
      pushBlock: () => {},
      repaint: () => {},
      suspend: () => suspended++,
      resume: () => resumed++,
    })
    const p = promptAsk({ name: "bash", args: {} })
    await tty.ready()
    // Sinkron: suspend dipanggil SEBELUM askLine menunggu jawaban.
    await tty.waitForOutput(() => suspended > 0)
    await tty.send("n")
    await tty.send(KEY.enter)
    expect(await p).toBe("deny")
    expect(suspended).toBe(1)
    expect(resumed).toBe(1)
  })
  test("jawaban dwibahasa: ya/tidak/selalu diterima", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    setApprovalSink({
      pushBlock: () => {},
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
    })
    for (const [ans, want] of [
      ["ya", "allow"],
      ["tidak", "deny"],
      ["t", "deny"],
      ["selalu", "always"],
      ["s", "always"],
    ] as const) {
      const p = promptAsk({ name: "bash", args: {} })
      await tty.ready()
      await tty.send(ans)
      await tty.send(KEY.enter)
      expect(await p, ans).toBe(want)
    }
  })
})
