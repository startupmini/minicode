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
  test("tanpa sink + stdout pipe → deny tanpa tanya (F-09, anti-cemar pipe)", async () => {
    // stdin TTY (user bisa jawab) tapi stdout di-pipe: prompt tak terlihat dan
    // askLine/blok mencemari output program → fail-closed deny.
    tty = installFakeTty({ columns: 80, rows: 24 })
    expect(getApprovalSink()).toBeNull()
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
    try {
      await expect(promptAsk({ name: "bash", args: { command: "ls" } })).resolves.toBe("deny")
      await expect(promptAskText("apa ini?")).resolves.toBeNull()
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
    }
  })
  test("riskTier + diffPreview dirender di kartu approval (F-APPROVAL-1)", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const blocks: string[][] = []
    setApprovalSink({
      pushBlock: (lines) => blocks.push(lines),
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
    })
    const p = promptAsk({
      name: "delete_file",
      args: { path: "secret.txt" },
      riskTier: "EXTERNAL_IRREVERSIBLE",
      diffPreview: "- secret.txt",
    })
    await tty.ready()
    await tty.send("n")
    await tty.send(KEY.enter)
    expect(await p).toBe("deny")
    const q = stripAnsi(blocks[0]!.join("\n"))
    expect(q).toContain("Risk:")
    expect(q).toContain("irreversible external effect")
    expect(q).toContain("Diff:")
    expect(q).toContain("- secret.txt")
  })
  test("modal: paintRegion melukis kotak (bukan tulis inline) + clearRegion saat selesai", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    let painted = 0
    let cleared = 0
    let paintedText = ""
    setApprovalSink({
      pushBlock: () => {},
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
      paintRegion: (lines) => {
        painted++
        paintedText = lines.join("\n")
      },
      clearRegion: () => cleared++,
    })
    const p = promptAsk({ name: "bash", args: { command: "rm -rf /" } })
    await tty.ready()
    await tty.waitForOutput(() => painted >= 1)
    // Kotak dialog ter-render (konten tool tampil), dan bukan tulis stdout polos.
    expect(painted).toBeGreaterThanOrEqual(1)
    expect(stripAnsi(paintedText)).toContain("bash")
    expect(stripAnsi(paintedText)).toContain("rm -rf /")
    await tty.send("n")
    await tty.send(KEY.enter)
    expect(await p).toBe("deny")
    expect(cleared).toBe(1)
  })
})

describe("approval: navigasi daftar opsi (AUD-005, kontrak I25)", () => {
  // I25 mewajibkan `↑↓`/home/end di SEMUA permukaan berdaftar. Sebelumnya tiga
  // opsi approval hanya bisa DIKETIK (y/a/n) walau tampil sebagai daftar.
  const setupSink = () => {
    const paints: string[] = []
    setApprovalSink({
      pushBlock: () => {},
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
      paintRegion: (lines) => paints.push(lines.join("\n")),
      clearRegion: () => {},
    })
    return paints
  }

  test("↓ memilih Always, ↑ kembali ke Allow", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const paints = setupSink()
    const p = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: true })
    await tty.ready()
    // Sorotan awal di opsi pertama (allow).
    expect(stripAnsi(paints.at(-1) ?? "")).toContain("Allow once")
    await tty.send(KEY.down)
    await tty.send(KEY.enter)
    expect(await p).toBe("always")
  })

  test("End memilih opsi terakhir (Deny) lalu Enter", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    setupSink()
    const p = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: true })
    await tty.ready()
    await tty.send(KEY.end)
    await tty.send(KEY.enter)
    expect(await p).toBe("deny")
  })

  test("tanpa canAlways daftar hanya dua opsi; End = deny, bukan always", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const paints = setupSink()
    const p = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: false })
    await tty.ready()
    // Opsi Always tidak boleh muncul sama sekali.
    expect(stripAnsi(paints.at(-1) ?? "")).not.toContain("Always")
    await tty.send(KEY.end)
    await tty.send(KEY.enter)
    expect(await p).toBe("deny")
  })

  test("klik-cepat tetap bekerja: `a` langsung selalu-izinkan", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    setupSink()
    const p = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: true })
    await tty.ready()
    await tty.send("a")
    expect(await p).toBe("always")
  })

  test("`s` (selalu) memilih Always, `t` (tidak) memilih Deny", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    setupSink()
    const p1 = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: true })
    await tty.ready()
    await tty.send("s")
    expect(await p1).toBe("always")
    tty.restore()
    tty = installFakeTty({ columns: 100, rows: 24 })
    setupSink()
    const p2 = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: true })
    await tty.ready()
    await tty.send("t")
    expect(await p2).toBe("deny")
  })

  test("Esc = deny (batal hanya tool ini, bukan abort turn)", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    setupSink()
    const p = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: true })
    await tty.ready()
    await tty.send(KEY.esc)
    expect(await p).toBe("deny")
  })
})
