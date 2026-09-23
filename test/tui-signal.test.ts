// Proteksi TUI-001 (temuan audit audit-tui): sinyal fatal saat sesi TUI hidup
// harus me-restore terminal (raw off + alt-screen exit) lalu exit 128+n.
// File terpisah: test menyentuh handler sinyal level proses — isolasi ketat
// dari test TUI lain (setiap app di-quit penuh agar handler ikut dilepas;
// handler App melepas dirinya sendiri di cleanup run()).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { TuiApp, type TuiHost } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty } from "./helpers/tui-harness.ts"

beforeEach(() => setSessionLocale("en"))
let tty: ReturnType<typeof installFakeTty> | null = null
afterEach(async () => {
  // Sesi yang belum quit: akhiri dulu agar handler sinyal dilepas — tanpa
  // ini handler App bocor ke test berikutnya (Bun berbagi process global).
  await finishLastSession()
  tty?.restore()
  tty = null
  resetAltScreenDepth()
  resetLocaleState()
})

function bootApp() {
  tty = installFakeTty({ columns: 60, rows: 14 })
  const bus = createFakeBus()
  const transcript = new Transcript(bus as never)
  const host: TuiHost = {
    bus: bus as never,
    getStatus: () => ({ footer: { mode: "auto", model: "m", cwd: "/k" }, busy: false }),
    listCommands: () => [],
    submit: async () => undefined,
    abort: () => {},
    cycleMode: () => {},
    toggleCompact: () => {},
    toggleReasoning: () => {},
  }
  lastApp = new TuiApp(transcript, host)
  runPromise = lastApp.run()
  return runPromise
}

/** App terakhir yang di-boot — untuk quit normal di akhir test. */
let lastApp: TuiApp | null = null
let runPromise: Promise<unknown> | null = null

/** Kembalikan app terakhir (pastikan bootApp sudah dipanggil). */
function appForQuit(): TuiApp {
  if (!lastApp) throw new Error("bootApp belum dipanggil")
  return lastApp
}

/** Selesaikan sesi terakhir bila belum quit (anti bocor antar test). */
async function finishLastSession(): Promise<void> {
  if (lastApp && runPromise) {
    lastApp.requestQuit()
    await runPromise
    lastApp = null
    runPromise = null
  }
}

/** Stub process.exit untuk menangkap kode tanpa membunuh runner test. */
function stubExit(): { exits: number[]; restore: () => void } {
  const exits: number[] = []
  const orig = process.exit
  process.exit = ((code?: number) => {
    exits.push(code ?? 0)
    return undefined as never
  }) as typeof process.exit
  return { exits, restore: () => (process.exit = orig) }
}

describe("TUI-001: sinyal fatal me-restore terminal", () => {
  test("SIGTERM saat TUI hidup: raw off + alt-screen exit + exit 143", async () => {
    const runP = bootApp()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("minicode"))
    const { exits, restore } = stubExit()
    try {
      process.emit("SIGTERM")
      await new Promise((r) => setTimeout(r, 10))
    } finally {
      restore()
    }
    expect(exits).toEqual([143])
    // Restore: buffer alt dikembalikan + raw mode mati.
    expect(tty!.all()).toContain("\x1b[?1049l")
    expect(tty!.isRaw()).toBe(false)
    // Terakhir: quit normal memastikan cleanup melepas handler (count 0)
    // — pasangan ketat, sinyal berikutnya kembali ke default proses.
    appForQuit().requestQuit()
    await runP
    expect(process.listenerCount("SIGTERM")).toBe(0)
    expect(process.listenerCount("SIGHUP")).toBe(0)
  })

  test("SIGHUP → exit 129; tanpa sesi TUI sinyal tidak di-intercept", async () => {
    // Sentinel: bukti emit TIDAK di-intercept App (handler belum terpasang).
    let sentinel = false
    const onSighup = () => {
      sentinel = true
    }
    process.on("SIGHUP", onSighup)
    try {
      process.emit("SIGHUP")
      expect(sentinel).toBe(true)
      bootApp()
      await tty!.ready()
      await tty!.waitForOutput((o) => o.includes("minicode"))
      const { exits, restore } = stubExit()
      try {
        process.emit("SIGHUP")
        await new Promise((r) => setTimeout(r, 10))
      } finally {
        restore()
      }
      expect(exits).toEqual([129])
      expect(tty!.all()).toContain("\x1b[?1049l")
    } finally {
      process.removeListener("SIGHUP", onSighup)
    }
    await finishLastSession()
    expect(process.listenerCount("SIGTERM")).toBe(0)
    expect(process.listenerCount("SIGHUP")).toBe(0)
  })
})
