// Proteksi perbaikan temuan audit audit-tui (TUI-002, TUI-005, TUI-006,
// TUI-007, TUI-004). TUI-001 (sinyal fatal) punya file sendiri:
// test/tui-signal.test.ts — karena menyentuh handler level proses.
//
// Pola dari test/tui-app.test.ts: repaint App sinkron per keypress, jadi
// setelah `await tty.send(...)` frame SUDAH final. Catatan penting:
// transcript.push() TIDAK memicu repaint — test lama selalu mengirim
// keypress sebelum menunggu output; ikuti pola itu.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resetLocaleState, setSessionLocale, t } from "../src/ui/i18n/locale.ts"
import { motionReduced } from "../src/ui/runtime/motion.ts"
import { openAltScreen, resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { TuiApp, type TuiHost } from "../src/ui/tui/app.ts"
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

function setup(opts: { columns?: number; rows?: number } = {}) {
  tty = installFakeTty({ columns: opts.columns ?? 60, rows: opts.rows ?? 14 })
  const bus = createFakeBus()
  const transcript = new Transcript(bus as never)
  let slowGate: (() => void) | null = null
  const host: TuiHost = {
    bus: bus as never,
    getStatus: () => ({
      footer: { mode: "auto", model: "test-model", cwd: "/kerja", context: "1k" },
      busy: false,
    }),
    listCommands: (prefix) => ["/model", "/help", "/exit"].filter((c) => c.startsWith(prefix)),
    submit: async (text) => {
      if (text === "/slow") await new Promise<void>((r) => (slowGate = r))
      return undefined
    },
    abort: () => {},
    cycleMode: () => {},
    toggleCompact: () => {},
    toggleReasoning: () => {},
  }
  const app = new TuiApp(transcript, host)
  // PENTING (quirk Bun): helper TIDAK boleh me-return promise PENDING langsung
  // (runP) — await helper menunggu promise itu selesai (flatten), padahal
  // sesi memang harus tetap hidup. Bungkus dalam objek: return { runP }.
  const boot = async () => {
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("minicode"))
    return { runP }
  }
  // Ekspos gate submit /slow agar test bisa menyelesaikannya (tanpa promise
  // menggantung lintas test yang bisa mencemari sesi berikutnya).
  return { app, transcript, boot, getSlowGate: () => slowGate }
}

describe("TUI-002: Home/End jump + Shift+PgUp/PgDn half-page", () => {
  test("Home saat prompt kosong = lompat top; End = ekor; baris berisi = editing", async () => {
    const { transcript, boot } = setup({ rows: 12 })
    const { runP } = await boot()
    transcript.pushInfo(Array.from({ length: 30 }, (_, i) => `baris-${i}`))
    // Keypress memicu repaint → baris terakhir terlihat (pola test lama).
    await tty!.send("x")
    await tty!.waitForOutput((o) => o.includes("baris-29"))
    // Home saat baris berisi = editing (kursor awal baris) — transkrip tetap.
    await tty!.send(KEY.home)
    expect(tty!.screen().join("\n")).toContain("baris-29")
    // Kosongkan baris (kursor pindah ke akhir dulu — Home tadi menaruhnya
    // di awal, backspace di posisi 0 tak menghapus apa pun) → prompt kosong
    // → Home sekarang LOMPAT ke top (setengah layar pertama berisi baris-0..9).
    await tty!.send(KEY.end, 30)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.home)
    const top = tty!.screen().join("\n")
    expect(top).toContain("baris-0")
    // End = kembali ke ekor.
    await tty!.send(KEY.end, 60)
    await tty!.waitForOutput((o) => o.includes("baris-29"))
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("Home saat dropdown terbuka tetap jalur engine (tidak menjumpai top)", async () => {
    const { transcript, boot } = setup()
    const { runP } = await boot()
    transcript.pushInfo(Array.from({ length: 25 }, (_, i) => `isi-${i}`))
    await tty!.send("/")
    await tty!.waitForOutput((o) => o.includes("commands"))
    await tty!.send(KEY.home)
    // Dropdown tetap terbuka — Home tidak diubah jadi jump saat menu aktif.
    expect(tty!.screen().join("\n")).toContain("commands")
    // Keluar bersih: Esc menutup dropdown (baris "/" tetap), hapus baris
    // dulu — Ctrl+D saat baris berisi diabaikan (kontrak I19). Settle 90ms:
    // flush lone-ESC butuh ~50ms. Kursor ke akhir dulu (Home tadi
    // menaruhnya di awal; backspace di posisi 0 tak menghapus apa pun).
    await tty!.send(KEY.esc, 90)
    await tty!.send(KEY.end, 30)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("Shift+PgUp/PgDn = setengah halaman", async () => {
    const { transcript, boot } = setup({ rows: 12 })
    const { runP } = await boot()
    transcript.pushInfo(Array.from({ length: 30 }, (_, i) => `x-${i}`))
    await tty!.send("x")
    await tty!.waitForOutput((o) => o.includes("x-29"))
    // Shift+PgUp: naik setengah halaman — ekor hilang tapi belum di top
    // (setengah < satu halaman penuh; x-0 belum terlihat).
    await tty!.send("\x1b[5;2~")
    const mid = tty!.screen().join("\n")
    expect(mid).not.toContain("x-29")
    expect(mid).not.toContain("x-0")
    // Shift+PgDn dua kali: kembali ke ekor (0.5+0.5 ≥ satu halaman).
    await tty!.send("\x1b[6;2~", 60)
    await tty!.send("\x1b[6;2~", 60)
    await tty!.waitForOutput((o) => o.includes("x-29"))
    // Kosongkan baris dulu — Ctrl+D saat baris berisi diabaikan (I19).
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("dekode ESC[5;2~ → pageup modifier 2 (unit decodeKeys)", async () => {
    const { decodeKeys } = await import("../src/ui/input/prompt-engine.ts")
    const keys = decodeKeys(new TextEncoder().encode("\x1b[5;2~"))
    const pg = keys.filter((k) => k.key.type === "pageup")
    expect(pg.length).toBe(1)
    expect((pg[0]!.key as { modifier?: number }).modifier).toBe(2)
    // TANPA residu: width harus 6 byte — width 5 membuat '~' bocor jadi
    // keystroke char (prompt tiba-tiba berisi '~' tiap Shift+PgUp).
    expect(keys.length).toBe(1)
    // Tanpa modifier tetap polos (regresi varian lama ESC[5~).
    const plain = decodeKeys(new TextEncoder().encode("\x1b[5~"))
    expect(plain[0]!.key.type).toBe("pageup")
    expect((plain[0]!.key as { modifier?: number }).modifier ?? 0).toBe(0)
    // Response DSR kursor (ESC[5;34R) TIDAK boleh dibajak jadi pageup —
    // hanya terminator '~' yang sah; sisanya catch-all esc tanpa residu char.
    const dsr = decodeKeys(new TextEncoder().encode("\x1b[5;34R"))
    expect(dsr.some((k) => k.key.type === "pageup")).toBe(false)
    expect(dsr.some((k) => k.key.type === "char")).toBe(false)
    // Modifier multi-digit (kombinasi xterm >9, mis. alt+shift=23).
    const multi = decodeKeys(new TextEncoder().encode("\x1b[5;23~"))
    expect(multi.length).toBe(1)
    expect((multi[0]!.key as { modifier?: number }).modifier).toBe(23)
    // Varian PgDn bermodifier + ctrl (dekode utuh; App pakai shift saja).
    const ctrl = decodeKeys(new TextEncoder().encode("\x1b[6;5~"))
    expect(ctrl.length).toBe(1)
    expect(ctrl[0]!.key.type).toBe("pagedown")
    expect((ctrl[0]!.key as { modifier?: number }).modifier).toBe(5)
    // F5 (ESC[15~) tetap tidak terpicu cabang kind '1'/'5'.
    const f5 = decodeKeys(new TextEncoder().encode("\x1b[15~"))
    expect(f5.some((k) => k.key.type === "pageup" || k.key.type === "home")).toBe(false)
  })
})

describe("TUI-005: hint abort pertama saat busy", () => {
  test("abort pertama menampilkan hint; abort kedua quit", async () => {
    const { boot, getSlowGate } = setup()
    const { runP } = await boot()
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("› /slow"))
    // Esc pertama: abort + hint muncul di layar.
    await tty!.send(KEY.esc, 90)
    await new Promise((r) => setTimeout(r, 80))
    expect(tty!.screen().join("\n")).toContain("press Esc/Ctrl+C again")
    // Esc kedua: quit (jalan keluar terjaga — hint tak mengubah semantik).
    await tty!.send(KEY.esc, 90)
    await runP
    expect(tty!.all()).toContain("\x1b[?1049l")
    // Selesaikan submit yang tertunda agar tak ada promise menggantung.
    getSlowGate()?.()
  })
})

describe("TUI-006: MINICODE_MOTION=0 spark statis", () => {
  test("motionReduced() membaca env saat dipakai", () => {
    const orig = process.env.MINICODE_MOTION
    try {
      delete process.env.MINICODE_MOTION
      expect(motionReduced()).toBe(false)
      process.env.MINICODE_MOTION = "1"
      expect(motionReduced()).toBe(false)
      process.env.MINICODE_MOTION = "0"
      expect(motionReduced()).toBe(true)
      process.env.MINICODE_MOTION = ""
      expect(motionReduced()).toBe(false)
      // Semantik eksplisit (audit minor): nilai off lain dikenali, nilai tak
      // dikenal fail-closed ke animasi hidup (bukan menebak).
      for (const v of ["false", "off", "no", "FALSE", " Off "]) {
        process.env.MINICODE_MOTION = v
        expect(motionReduced()).toBe(true)
      }
      for (const v of ["yes", "true", "banana"]) {
        process.env.MINICODE_MOTION = v
        expect(motionReduced()).toBe(false)
      }
    } finally {
      if (orig === undefined) delete process.env.MINICODE_MOTION
      else process.env.MINICODE_MOTION = orig
    }
  })

  test("MOTION=0: status bar identik antar repaint (tanpa pulse)", async () => {
    const orig = process.env.MINICODE_MOTION
    process.env.MINICODE_MOTION = "0"
    try {
      const { boot } = setup()
      const { runP } = await boot()
      const f1 = tty!.screen()
      await tty!.send("a")
      const f2 = tty!.screen()
      expect(f1[f1.length - 1]).toBe(f2[f2.length - 1])
      await tty!.send(KEY.backspace)
      await tty!.send(KEY.ctrlD)
      await runP
    } finally {
      if (orig === undefined) delete process.env.MINICODE_MOTION
      else process.env.MINICODE_MOTION = orig
    }
  })
})

describe("TUI-007: kursor di dalam blok sync-update", () => {
  test("CUP parkir kursor dibungkus ?2026 dalam write yang sama", async () => {
    const { boot } = setup()
    const { runP } = await boot()
    await tty!.send("halo")
    const out = tty!.all()
    // Satu penulisan App: SYNC_START, sembunyikan kursor, CUP parkir,
    // tampilkan kursor, SYNC_END — kursor tidak pernah di luar blok sync
    // (temuan audit TUI-007: tearing di emulator tanpa ?2026).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: pola escape ANSI sengaja
    const re = /\x1b\[\?2026h\x1b\[\?25l\x1b\[\d+;\d+H\x1b\[\?25h\x1b\[\?2026l/
    expect(re.test(out)).toBe(true)
    // Kosongkan baris dulu — Ctrl+D saat baris berisi diabaikan (I19).
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
})

describe("TUI-004: form idle dua-tahap (unit waktu pendek)", () => {
  test("konstanta 80+10 dtk = semantik 90 dtk lama + footer peringatan ada", async () => {
    const form = await import("../src/ui/screens/form.ts")
    expect(form.IDLE_WARN_MS).toBe(80_000)
    expect(form.IDLE_CANCEL_MS).toBe(10_000)
    expect(form.IDLE_WARN_MS + form.IDLE_CANCEL_MS).toBe(90_000)
    expect(t("form.idleWarning", { s: 10 })).toContain("10")
    // End-to-end ringan: form tetap hidup & submit normal (tak diregresi).
    tty = installFakeTty({ columns: 80, rows: 24 })
    const screen = openAltScreen()
    expect(screen.ok).toBe(true)
    const p = form.runForm(
      { title: "Uji", fields: [{ id: "a", label: "A", kind: "text" as const }] },
      screen,
    )
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("Uji"))
    await tty.send("v")
    await tty.send(KEY.enter, 30)
    const res = await p
    expect(res.cancelled).toBe(false)
    expect(res.values?.a).toBe("v")
    screen.close()
  })
})
