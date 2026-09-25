// Popup komposit (kontrak I16): kotak dialog di atas transkrip yang tetap
// terlihat (redup) — BUKAN layar hitam + kotak. Gagal-di-kode-lama: view
// yang melukis frame penuh (paint + clear) menghapus transkrip di belakang.
import { afterEach, describe, expect, test } from "bun:test"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { runPicker } from "../src/ui/screens/picker.ts"
import { TuiApp, type TuiHost } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null
afterEach(() => {
  tty?.restore()
  tty = null
})

function setup() {
  tty = installFakeTty({ columns: 70, rows: 16 })
  const bus = createFakeBus()
  const transcript = new Transcript(bus as never)
  const host: TuiHost = {
    bus: bus as never,
    getStatus: () => ({
      footer: { mode: "auto", model: "m", cwd: "/", context: "1k" },
      busy: false,
    }),
    listCommands: () => [],
    submit: async () => {},
    copySelection: () => true,
    abort: () => {},
    cycleMode: () => {},
    toggleCompact: () => {},
    toggleReasoning: () => {},
  }
  return { transcript, app: new TuiApp(transcript, host) }
}

describe("popup komposit", () => {
  test("/model-style: transkrip terlihat di belakang kotak popup", async () => {
    const { transcript, app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    transcript.pushUser("halo dunia")
    await tty!.send("x")
    await tty!.waitForOutput((o) => o.includes("halo dunia"))
    // Buka popup seperti controller: suspend App, view melukis region.
    const beforeSuspend = tty!.all().length
    app.suspend()
    const suspendOutput = tty!.all().slice(beforeSuspend)
    expect(suspendOutput).toContain("\x1b[?1002l")
    expect(suspendOutput).toContain("\x1b[?1000h")
    const dimmedFrame = tty!.screen()
    expect(dimmedFrame[dimmedFrame.length - 2]).toBe("")
    expect(dimmedFrame[dimmedFrame.length - 1]).toContain("auto")
    let picked = ""
    let cancelled = false
    const p = runPicker({
      title: "Models",
      items: [
        { name: "model-alpha", provider: "p1", value: "a" },
        { name: "model-beta", provider: "p1", value: "b" },
      ],
      onPick: (v) => (picked = v),
      onCancel: () => (cancelled = true),
    })
    await tty!.waitForOutput((o) => o.includes("model-alpha"))
    const frame = tty!.screen().join("\n")
    // KEDUANYA tampil dalam satu frame: isi transkrip + kotak popup.
    expect(frame).toContain("halo dunia")
    expect(frame).toContain("model-alpha")
    expect(frame).toContain("┌")
    // Popup TIDAK me-clear layar (transkrip di belakang selamat).
    const afterSuspend = tty!.all().split("\x1b[2m").pop() ?? ""
    expect(afterSuspend).not.toContain("\x1b[2J")
    // Batal → resume → transkrip utuh, kotak hilang.
    await tty!.send(KEY.esc, 90)
    await p
    expect(cancelled).toBe(true)
    expect(picked).toBe("")
    const beforeResume = tty!.all().length
    app.resume()
    expect(tty!.all().slice(beforeResume)).toContain("\x1b[?1002h")
    await tty!.send(KEY.backspace)
    const after = tty!.screen().join("\n")
    expect(after).toContain("halo dunia")
    expect(after).not.toContain("model-alpha")
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("ketikan selama popup TIDAK bocor ke baris input App", async () => {
    const { app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    app.suspend()
    const p = runPicker({
      title: "T",
      filterable: true,
      items: [{ name: "abc", provider: "", value: "abc" }],
      onPick: () => {},
      onCancel: () => {},
    })
    await tty!.waitForOutput((o) => o.includes("abc"))
    // "q" masuk ke filter popup (bukan ke input App yang dibekukan).
    await tty!.send("q")
    await tty!.waitForOutput((o) => o.includes("No matches"))
    const frame = stripAnsi(tty!.screen().join("\n"))
    expect(frame).toContain("No matches")
    await tty!.send(KEY.esc, 90)
    await tty!.send(KEY.esc, 90)
    await p
    app.resume()
    // Baris input App tetap kosong (tanpa "q" nyasar).
    const inputRow = tty!.screen()[tty!.screen().length - 2] ?? ""
    expect(inputRow).not.toContain("q")
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("filter menyusut: tidak ada baris hantu, latar di luar box utuh", async () => {
    const { transcript, app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    // Transkrip panjang: baris teratas viewport tak pernah tertutup box.
    transcript.pushInfo(Array.from({ length: 20 }, (_, i) => `konteks-${i}`))
    await tty!.send("x")
    await tty!.waitForOutput((o) => o.includes("konteks-19"))
    app.suspend()
    const items = Array.from({ length: 8 }, (_, i) => ({
      name: `model-${i}`,
      provider: "p",
      value: `${i}`,
    }))
    const p = runPicker({
      title: "M",
      filterable: true,
      items,
      onPick: () => {},
      onCancel: () => {},
    })
    await tty!.waitForOutput((o) => o.includes("model-7"))
    // Saring hingga 1 hasil: kotak menyusut drastis. ("1/8 matches" tak bisa
    // dipakai sebagai marker byte — SGR memisahkan angka dan garis miring.)
    await tty!.send("model-1")
    await tty!.waitForOutput((o) => o.includes("matches"))
    const frame = tty!.screen().join("\n")
    expect(frame).toContain("model-1")
    // Sisa kotak lama (item yang tersaring keluar) TIDAK tertinggal.
    expect(frame).not.toContain("model-7")
    expect(frame).not.toContain("model-0")
    // Latar di luar box (baris teratas viewport) tetap tampil.
    expect(frame).toContain("konteks-")
    await tty!.send(KEY.esc, 90)
    await tty!.send(KEY.esc, 90)
    await p
    app.resume()
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
})
