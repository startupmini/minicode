// Integrasi TuiApp di atas FakeTty — proteksi kontrak I17-I20.
// Tiap test gagal-di-kode-lama: tanpa App, tak ada frame fullscreen,
// pairing alt-screen, viewport scroll, maupun status bar.
//
// Catatan timing: repaint App sinkron di dalam handler key, jadi setelah
// `await tty.send(...)` frame SUDAH final dan `tty.screen()` menegaskan
// state — bukan race. Hanya paint awal & submit async yang butuh
// waitForOutput.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { UiPresentationActivity } from "../src/ui/contract.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { formatTimer, TuiApp, type TuiHost, thinkingDots } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

beforeEach(() => setSessionLocale("en"))

let tty: ReturnType<typeof installFakeTty> | null = null
afterEach(() => {
  tty?.restore()
  tty = null
  resetAltScreenDepth()
  resetLocaleState()
})

function setup(opts: { columns?: number; rows?: number; isTTY?: boolean } = {}) {
  const columns = opts.columns ?? 60
  const rows = opts.rows ?? 14
  tty = installFakeTty({ columns, rows, isTTY: opts.isTTY })
  const bus = createFakeBus()
  const transcript = new Transcript(bus as never)
  const calls: string[] = []
  const copied: string[] = []
  let slowGate: (() => void) | null = null
  let pinnedActivity: UiPresentationActivity | undefined
  const host: TuiHost = {
    bus: bus as never,
    getStatus: () => ({
      footer: { mode: "auto", model: "test-model", cwd: "/kerja", context: "1k" },
      busy: false,
      ...(pinnedActivity ? { pinnedActivity } : {}),
    }),
    listCommands: (prefix) => ["/model", "/help", "/exit"].filter((c) => c.startsWith(prefix)),
    submit: async (text) => {
      calls.push(text)
      if (text === "/exit") return { quit: true }
      if (text === "/boom") throw new Error("gagal disengaja")
      if (text === "/slow") await new Promise<void>((r) => (slowGate = r))
    },
    copySelection: (text) => {
      copied.push(text)
      return true
    },
    abort: () => {},
    cycleMode: () => {},
    toggleCompact: () => {},
    toggleReasoning: () => {},
  }
  const app = new TuiApp(transcript, host)
  const screenText = () => tty!.screen().join("\n")
  // Lepaskan turn lambat + beri kesempatan microtask finally (busy=false)
  // jalan SEBELUM key berikutnya diproses. Tanpa flush, send() harness
  // dispatch SINKRON sementara continuation promise masih antre → Ctrl+D
  // tiba saat busy=true dan diabakan (race, bukan bug App).
  const releaseSlow = async () => {
    slowGate?.()
    await new Promise((r) => setTimeout(r, 20))
  }
  return {
    bus,
    transcript,
    app,
    calls,
    copied,
    releaseSlow,
    screenText,
    setPinnedActivity: (next: UiPresentationActivity | undefined) => {
      pinnedActivity = next
    },
  }
}
describe("TuiApp", () => {
  test("boot: frame penuh tepat rows + enter/exit berpasangan (I17)", async () => {
    const { app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    expect(tty!.screen()).toHaveLength(14)
    expect(tty!.all()).toContain("\x1b[?1049h")
    expect(tty!.all()).toContain("\x1b[?1002h")
    expect(tty!.all()).toContain("\x1b[?1006h")
    await tty!.send(KEY.ctrlD)
    const res = await runP
    expect(res.started).toBe(true)
    expect(res.frames).toBeGreaterThan(0)
    expect(tty!.all()).toContain("\x1b[?1049l")
    expect(tty!.all()).toContain("\x1b[?1006l")
    expect(tty!.all()).toContain("\x1b[?1002l")
    expect(tty!.all()).toContain("\x1b[?1000l")
  })
  test("MINICODE_MOUSE_SELECTION=0 mematikan tracking TUI", async () => {
    const previous = process.env.MINICODE_MOUSE_SELECTION
    process.env.MINICODE_MOUSE_SELECTION = "0"
    const { app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    expect(tty!.all()).not.toContain("\x1b[?1002h")
    await tty!.send(KEY.ctrlD)
    await runP
    if (previous === undefined) delete process.env.MINICODE_MOUSE_SELECTION
    else process.env.MINICODE_MOUSE_SELECTION = previous
  })
  test("ketik + Enter: submit terpanggil + gema di transkrip", async () => {
    const { app, calls, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("halo")
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("› halo"))
    expect(calls).toEqual(["halo"])
    expect(screenText()).toContain("› halo")
    await new Promise((r) => setTimeout(r, 20))
    expect(screenText()).toMatch(/^minicode ›$/m)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("submit melempar → baris error tampil, sesi lanjut (tak ada jalur diam)", async () => {
    const { app, calls } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/boom")
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("gagal disengaja"))
    expect(calls).toEqual(["/boom"])
    await tty!.send(KEY.ctrlD)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("/exit via submit {quit} keluar + layar dikembalikan", async () => {
    const { app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/exit")
    await tty!.send(KEY.enter)
    const res = await runP
    expect(res.started).toBe(true)
    expect(tty!.all()).toContain("\x1b[?1049l")
  })
  test("Ctrl+D baris berisi diabaikan; baris kosong keluar (I19)", async () => {
    const { app, calls } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("x")
    await tty!.send(KEY.ctrlD)
    expect(tty!.all()).not.toContain("\x1b[?1049l")
    expect(calls).toEqual([])
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
    expect(tty!.all()).toContain("\x1b[?1049l")
  })
  test("timer idle redup dan timer turn putih", async () => {
    const { app, releaseSlow } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    expect(tty!.all()).toContain("\x1b[38;2;72;72;72m00.00.00")
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("› /slow"))
    expect(tty!.all()).toContain("\x1b[37m00\x1b[39m")
    expect(tty!.all()).toContain("\x1b[38;2;72;72;72m00\x1b[39m")
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("status bar: mode + model + konteks di baris dasar (I20)", async () => {
    const { app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    const frame = tty!.screen()
    const last = frame[frame.length - 1]!
    expect(last).toContain("auto")
    expect(last).toContain("test-model")
    expect(last).toContain("1k")
    expect(frame[frame.length - 2]).toBe("")
    expect(last).toContain("00.00.00")
    expect(last).not.toContain("•")
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("busy tanpa event: timer fixed-format tanpa dots sebelum reasoning", async () => {
    const { app, releaseSlow, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("› /slow"))
    const footer = () => tty!.screen().find((line) => /\d{2}\.\d{2}\.\d{2}/.test(line)) ?? ""
    expect(footer()).not.toMatch(/\.{1,3}\s+00.00.00/)
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running)\b/)
    expect(screenText()).not.toMatch(/^minicode ›$/m)
    await new Promise((r) => setTimeout(r, 1100))
    expect(footer()).toMatch(/\d{2}\.\d{2}\.\d{2}/)
    expect(footer()).not.toMatch(/\d+s/)
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running)\b/)
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("timer format fixed HH.MM.SS", () => {
    expect(formatTimer(0)).toBe("00.00.00")
    expect(formatTimer(1_999)).toBe("00.00.01")
    expect(formatTimer(60_000)).toBe("00.01.00")
    expect(formatTimer(3_600_000)).toBe("01.00.00")
  })
  test("thinking dots mengikuti clock, bukan paint count", () => {
    expect(thinkingDots(0, 0, false)).toBe("...")
    expect(thinkingDots(200, 0, false)).toBe("..")
    expect(thinkingDots(400, 0, false)).toBe(".")
    expect(thinkingDots(600, 0, false)).toBe("..")
    expect(thinkingDots(800, 0, false)).toBe("...")
    expect(thinkingDots(9999, 0, true)).toBe("...")
  })
  test("busy + motion off: marker dots statis tanpa label", async () => {
    const previous = process.env.MINICODE_MOTION
    process.env.MINICODE_MOTION = "0"
    try {
      const { app, bus, releaseSlow, screenText } = setup()
      const runP = app.run()
      await tty!.ready()
      await tty!.waitForOutput((o) => o.includes("00.00.00"))
      await tty!.send("/slow")
      await tty!.send(KEY.enter)
      await tty!.waitForOutput((o) => o.includes("› /slow"))
      bus.emit("provider:extension", { kind: "reasoning", data: { text: "hmm" } })
      await new Promise((r) => setTimeout(r, 40))
      const composer = () => tty!.screen().find((line) => line.trim().startsWith(".")) ?? ""
      const first = composer()
      expect(first).toBe("...")
      await new Promise((r) => setTimeout(r, 500))
      expect(composer()).toBe(first)
      expect(tty!.screen().some((line) => /\d{2}\.\d{2}\.\d{2}/.test(line))).toBe(true)
      expect(screenText()).not.toMatch(/\b(Working|Thinking|Running)\b/)
      await releaseSlow()
      await tty!.send(KEY.ctrlD)
      await runP
    } finally {
      if (previous === undefined) delete process.env.MINICODE_MOTION
      else process.env.MINICODE_MOTION = previous
    }
  })
  test("reasoning dan text: hanya dots yang berubah, label tidak pernah tampil", async () => {
    const { app, bus, releaseSlow, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("› /slow"))
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "hmm" } })
    await new Promise((r) => setTimeout(r, 40))
    expect(tty!.screen().some((line) => /^\s*\.{1,3}\s*$/.test(line))).toBe(true)
    expect(screenText()).not.toContain("… thinking")
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running)\b/)
    tty!.clear()
    bus.emit("provider:text", { text: "jawaban" })
    await tty!.waitForOutput((o) => o.includes("00"))
    expect(tty!.screen().some((line) => /^\s*\.{1,3}\s*$/.test(line))).toBe(false)
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running)\b/)
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("activity snapshot tampil sebagai status tool tanpa label atau elapsed", async () => {
    const { app, releaseSlow, screenText, setPinnedActivity } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("› /slow"))
    setPinnedActivity({
      toolCallId: "call-1",
      name: "read_file",
      target: "src/server.ts",
      status: "running",
      tsStart: Date.now() - 3000,
    })
    app.repaint()
    const composer = tty!.screen().find((line) => line.includes("read_file src/server.ts")) ?? ""
    const footer = tty!.screen().find((line) => /\d{2}\.\d{2}\.\d{2}/.test(line)) ?? ""
    expect(composer).toContain("read_file src/server.ts")
    expect(footer).toMatch(/\d{2}\.\d{2}\.\d{2}/)
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running)\b|\d+s/)
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("PgUp/PgDn scroll viewport; ketikan baru kembali ke ekor (I18)", async () => {
    const { app, transcript, screenText } = setup({ rows: 12 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    transcript.pushInfo(Array.from({ length: 30 }, (_, i) => `baris-${i}`))
    await tty!.send("x")
    await tty!.waitForOutput((o) => o.includes("baris-29"))
    expect(screenText()).not.toContain("baris-0")
    // Satu halaman ke atas: ekor hilang, baris tengah tampil.
    await tty!.send(KEY.pgUp)
    expect(screenText()).not.toContain("baris-29")
    expect(screenText()).toContain("baris-20")
    // Dua halaman lagi → kepala terlihat.
    await tty!.send(KEY.pgUp)
    await tty!.send(KEY.pgUp)
    expect(screenText()).toContain("baris-0")
    // Satu halaman ke bawah menjauhi kepala…
    await tty!.send(KEY.pgDown)
    expect(screenText()).not.toContain("baris-0")
    // …ketikan baru kembali ke ekor.
    await tty!.send("y")
    expect(screenText()).toContain("baris-29")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("mouse wheel scroll transkrip tanpa memindahkan histori", async () => {
    const { app, transcript, screenText } = setup({ rows: 12 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    transcript.pushInfo(Array.from({ length: 30 }, (_, i) => `baris-${i}`))
    await tty!.send("x")
    await tty!.waitForOutput((o) => o.includes("baris-29"))
    await tty!.send(KEY.mouseWheelUpSgr)
    expect(screenText()).not.toContain("baris-29")
    expect(screenText()).toContain("minicode › x")
    await tty!.send(KEY.mouseWheelDownSgr)
    expect(screenText()).toContain("baris-29")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("drag transcript + Ctrl+C menyalin selection logis", async () => {
    const { app, transcript, copied, screenText } = setup({ rows: 12 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    transcript.pushInfo(Array.from({ length: 30 }, (_, i) => `baris-${i}`))
    await tty!.send("x")
    await tty!.waitForOutput((o) => o.includes("baris-29"))
    const screen = tty!.screen()
    const visible = screen
      .map((line, index) => ({ line, row: index + 1 }))
      .filter((item) => item.line.startsWith("baris-"))
    expect(visible.length).toBeGreaterThan(1)
    const start = visible[0]!.row
    const end = visible[Math.min(2, visible.length - 1)]!.row
    const endX = (visible[Math.min(2, visible.length - 1)]!.line.length ?? 0) + 1
    await tty!.send(`\x1b[<0;1;${start}M`)
    await tty!.send(`\x1b[<32;${endX};${end}M`)
    await tty!.send(`\x1b[<0;${endX};${end}m`)
    expect(tty!.all()).toContain("\x1b[7m")
    await tty!.send(KEY.ctrlC)
    expect(copied[0]).toBe("baris-21\nbaris-22\nbaris-23")
    expect(screenText()).toContain("selection copied")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("drag selection tetap bisa dipakai saat turn busy", async () => {
    const { app, transcript, copied, releaseSlow } = setup({ rows: 12 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    transcript.pushInfo(Array.from({ length: 20 }, (_, i) => `busy-${i}`))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("› /slow"))
    const visible = tty!
      .screen()
      .map((line, index) => ({ line, row: index + 1 }))
      .filter((item) => item.line.startsWith("busy-"))
    const start = visible[0]!.row
    const end = visible[1]!.row
    const endX = visible[1]!.line.length + 1
    await tty!.send(`\x1b[<0;1;${start}M`)
    await tty!.send(`\x1b[<32;${endX};${end}M`)
    await tty!.send(`\x1b[<0;${endX};${end}m`)
    await tty!.send(KEY.ctrlC)
    expect(copied[0]).toContain("busy-")
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("klik prompt memindahkan kursor tanpa mengubah histori", async () => {
    const { app, copied } = setup({ rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("hello")
    const promptRow = tty!.screen().findIndex((line) => line.includes("minicode › hello")) + 1
    expect(promptRow).toBeGreaterThan(0)
    await tty!.send(`\x1b[<0;14;${promptRow}M\x1b[<0;14;${promptRow}m`)
    await tty!.send("X")
    expect(tty!.screen().join("\n")).toContain("minicode › heXllo")
    expect(copied).toEqual([])
    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("Up/Down = histori (bukan scroll) (I18)", async () => {
    const { app, calls } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("satu")
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("› satu"))
    expect(calls).toEqual(["satu"])
    await tty!.send(KEY.up)
    await tty!.send(KEY.enter)
    // Polling calls (gema "› satu" tak bisa dibedakan di byte).
    const deadline = Date.now() + 2000
    while (calls.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(calls).toEqual(["satu", "satu"])
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("dropdown / tampil di atas input; Esc menutup (I16)", async () => {
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/")
    await tty!.waitForOutput((o) => o.includes("commands"))
    expect(screenText()).toContain("/model")
    // Esc butuh flush lone-ESC (~50ms) — settle pendek membuatnya hilang.
    await tty!.send(KEY.esc, 90)
    expect(screenText()).not.toContain("commands")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("submit saat busy diabaikan total, bukan antre diam-diam", async () => {
    const { app, calls, releaseSlow } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("› /slow"))
    // Ketikan + Enter saat busy = sunyi total (paritas REPL: stdin busy hanya
    // abort). Penolakan terjadi SEBELUM host.submit (tak antre diam-diam).
    await tty!.send("kedua")
    await tty!.send(KEY.enter)
    await new Promise((r) => setTimeout(r, 60))
    expect(calls).toEqual(["/slow"])
    expect(tty!.all()).not.toContain("\x1b[?1049l")
    await releaseSlow()
    // Baris kosong (beku) — langsung Ctrl+D untuk keluar.
    await tty!.send(KEY.ctrlD)
    await runP
    void app
  })
  test("non-TTY → started:false (fallback jujur, tanpa alt-screen)", async () => {
    const { app } = setup({ isTTY: false })
    const res = await app.run()
    expect(res.started).toBe(false)
    expect(tty!.all()).not.toContain("\x1b[?1049h")
  })
  test("terminal sempit (rows<10) → started:false", async () => {
    const { app } = setup({ rows: 8 })
    const res = await app.run()
    expect(res.started).toBe(false)
    expect(tty!.all()).not.toContain("\x1b[?1049h")
  })
  test("suspend menahan flush lone-ESC: popup tak tertimpa full-paint", async () => {
    // Gagal-di-kode-lama: timer 50ms lone-ESC yang dipersenjatai SEBELUM
    // suspend menembak sesudah popup terbuka → paintCurrent menimpa region
    // popup + memutasi state. Settle 10ms < flush 50ms: timer masih pending
    // saat suspend() dipanggil sinkron sesudahnya.
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("x")
    await tty!.send(KEY.esc, 10)
    app.suspend()
    await new Promise((r) => setTimeout(r, 120))
    app.resume()
    expect(screenText()).toContain("› x")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("suspend: layar redup + input dibekukan; resume: kembali normal", async () => {
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    expect(app.isSuspended()).toBe(false)
    app.suspend()
    expect(app.isSuspended()).toBe(true)
    const dimmedFrame = tty!.screen()
    expect(dimmedFrame[dimmedFrame.length - 2]).toBe("")
    expect(dimmedFrame[dimmedFrame.length - 1]).toContain("auto")
    // Backdrop redup tertulis sebagai frame (bukan hitam polos).
    expect(tty!.all()).toContain("\x1b[2m")
    // Ketikan selama suspend TIDAK masuk baris input (anti double-handling
    // dengan view popup yang memegang stdin).
    await tty!.send("x")
    expect(screenText()).not.toContain("› x")
    app.resume()
    expect(app.isSuspended()).toBe(false)
    await tty!.send("y")
    expect(screenText()).toContain("› y")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("suspend berlebih/resume berlebih idempoten", async () => {
    const { app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    app.suspend()
    app.suspend()
    expect(app.isSuspended()).toBe(true)
    app.resume()
    expect(app.isSuspended()).toBe(true)
    app.resume()
    expect(app.isSuspended()).toBe(false)
    // Resume tanpa suspend sebelumnya = no-op, sesi jalan terus.
    app.resume()
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("busy: semua input diabaikan kecuali abort + scroll", async () => {
    const { app, releaseSlow, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("› /slow"))
    // Ketikan + Enter + Tab saat busy: semua sunyi (bukan antre, bukan quit,
    // bukan pindah mode). Hanya Esc (abort) + wheel/PgUp/PgDn + Ctrl+D kosong.
    await tty!.send("zzz")
    await tty!.send(KEY.enter)
    await tty!.send(KEY.tab)
    await new Promise((r) => setTimeout(r, 60))
    expect(screenText()).not.toContain("z")
    expect(tty!.all()).not.toContain("\x1b[?1049l")
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
    void app
  })
  test("busy + Ctrl+D baris-kosong = abort + quit (jalan keluar abort macet)", async () => {
    // Gagal-di-kode-lama: busy memblokir SEMUA termasuk Ctrl+D — provider
    // non-kooperatif = sesi hanya bisa dibunuh kill -9.
    const { app, calls } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("› /slow"))
    expect(calls).toEqual(["/slow"])
    await tty!.send(KEY.ctrlD)
    const res = await runP
    expect(res.started).toBe(true)
    expect(tty!.all()).toContain("\x1b[?1049l")
    void app
  })
  test("busy + Esc ganda = abort lalu quit; tunggal = abort saja", async () => {
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("› /slow"))
    // Esc pertama: abort, tetap hidup (tanpa EXIT).
    await tty!.send(KEY.esc, 90)
    await new Promise((r) => setTimeout(r, 100))
    expect(tty!.all()).not.toContain("\x1b[?1049l")
    expect(screenText()).toContain("abort sent")
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running|Stopping)\b/)
    // Esc kedua <1.5 dtk: quit.
    await tty!.send(KEY.esc, 90)
    await runP
    expect(tty!.all()).toContain("\x1b[?1049l")
  })
  test("busy + Ctrl+C diabaikan; Esc yang abort", async () => {
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("› /slow"))
    await tty!.send(KEY.ctrlC, 90)
    expect(screenText()).not.toContain("abort sent")
    await tty!.send(KEY.esc, 90)
    expect(screenText()).toContain("abort sent")
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running|Stopping)\b/)
    await tty!.send(KEY.esc, 90)
    await runP
    expect(tty!.all()).toContain("\x1b[?1049l")
  })
  test("stream bus me-repaint live tanpa keypress (layar tak buta saat turn)", async () => {
    const { app, bus } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    tty!.clear()
    bus.emit("provider:text", { text: "token-live" })
    bus.emit("turn:completed", {})
    // Tanpa satu pun keypress: teks sudah di layar (coalesce 30ms).
    await tty!.waitForOutput((o) => o.includes("token-live"), 2000)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("scroll ke atas + stream = indikator, ketikan kembali ke ekor", async () => {
    const { app, bus, transcript, screenText } = setup({ rows: 12 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    transcript.pushInfo(Array.from({ length: 20 }, (_, i) => `lama-${i}`))
    await tty!.send("x")
    await tty!.waitForOutput((o) => o.includes("lama-19"))
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.pgUp)
    expect(screenText()).not.toContain("lama-19")
    bus.emit("provider:text", { text: "baru-0" })
    bus.emit("turn:completed", {})
    await tty!.waitForOutput((o) => o.includes("below"))
    expect(screenText()).toContain("PgDn")
    // Ketikan baru kembali ke ekor + indikator hilang.
    await tty!.send("y")
    expect(screenText()).not.toContain("below")
    expect(screenText()).toContain("baru-0")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("kursor baris-wrap tengah: kolom tepat, bukan EOL", async () => {
    // Gagal-di-kode-lama: baris tengah selalu diparkir di ujung baris.
    // Terminal 30 kolom: "minicode › "(11) + 50 "a" → baris 30/30/1.
    // Kursor di unit 30 (targetWidth 41) = baris visual 1, kolom 12.
    const { app } = setup({ columns: 30, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("a".repeat(50))
    for (let i = 0; i < 20; i++) await tty!.send(KEY.left)
    expect(tty!.all()).toContain("\x1b[12;12H")
    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
    void app
  })
  test("input panjang: jendela mengikuti kursor (bukan ekor buta)", async () => {
    // 8 baris logis > MAX 5: ekor tampil; Home → kursor ke atas → jendela
    // gulir ke atas. Gagal-di-kode-lama: kursor diparkir di baris salah.
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7")
    expect(screenText()).toContain("l7")
    expect(screenText()).toContain("l3")
    expect(screenText()).not.toContain("l0")
    await tty!.send(KEY.home)
    expect(screenText()).toContain("l0")
    expect(screenText()).not.toContain("l7")
    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
    void app
  })
  test("idle awal: prompt langsung tampil; Esc menutup, karakter membuka lagi", async () => {
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    expect(screenText()).toMatch(/^minicode ›$/m)
    expect(screenText()).toContain("00.00.00")
    await tty!.send(KEY.left)
    expect(screenText()).toMatch(/^minicode ›$/m)
    await tty!.send(KEY.esc, 90)
    expect(screenText()).not.toMatch(/^minicode ›$/m)
    await tty!.send("a")
    expect(screenText()).toContain("minicode › a")
    await tty!.send(KEY.backspace)
    expect(screenText()).toContain("minicode ›")
    expect(screenText()).not.toContain("ask anything")
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("resume merebut raw mode: dropdown / muncul setelah popup tutup", async () => {
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    // Simulasi view popup tutup: cleanup view mematikan raw mode.
    app.suspend()
    ;(process.stdin as unknown as { setRawMode(v: boolean): void }).setRawMode(false)
    app.resume()
    // Mekanisme: listener App terpasang saat raw (bukan cooked). Tanpa
    // rebut-raw ini 0 — di terminal nyata ketikan ditahan sampai Enter.
    expect(tty!.promptListeners()).toBe(1)
    // Ujung-ke-ujung: ketik "/" → dropdown rekomendasi muncul lagi.
    await tty!.send("/")
    await tty!.waitForOutput((o) => o.includes("commands"))
    expect(screenText()).toContain("/model")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("terminal menciut tengah sesi: bingkai jujur + hanya Ctrl+D jalan", async () => {
    // Gagal-di-kode-lama: layout rusak (wrap pecah, kursor liar) tanpa jalan
    // keluar yang terlihat.
    const { app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    tty!.resize(60, 5)
    await tty!.waitForOutput((o) => o.includes("too small"))
    // Ketikan normal diabakan saat menciut.
    await tty!.send("zzz")
    // Ctrl+D tetap keluar.
    await tty!.send(KEY.ctrlD)
    await runP
    expect(tty!.all()).toContain("\x1b[?1049l")
  })
  test("releaseTerminal keluar alt-screen + cooked; reacquire hidup lagi", async () => {
    // Gagal-di-kode-lama: spawn anak mewarisi buffer ?1049h + raw mode
    // (double-ENTER, EXIT anak merobek buffer parent, stdin macet).
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    app.suspend()
    app.releaseTerminal()
    expect(tty!.all()).toContain("\x1b[?1049l")
    expect(tty!.promptListeners()).toBe(0)
    // Hidup lagi (jalur spawn gagal): ENTER baru + input jalan.
    expect(app.reacquireTerminal()).toBe(true)
    app.resume()
    expect(tty!.promptListeners()).toBe(1)
    await tty!.send("/")
    await tty!.waitForOutput((o) => o.includes("commands"))
    expect(screenText()).toContain("/model")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
    expect(tty!.all()).toContain("\x1b[?1049l")
  })
})
