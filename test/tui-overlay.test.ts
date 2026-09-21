// Test permanen untuk temuan bug-hunter UI ronde 2: setiap komponen interaktif
// harus menghormati ukuran terminal SUNGGUHAN (termasuk yang sangat kecil), dan
// teks dari model tidak boleh bisa mengendalikan terminal.
//
// (2026-09: blok fullscreen & screen VT dihapus bersama komponennya — REPL
// linier menggantikan fullscreen, alternate screen tidak ada lagi. Assertion
// sanitasi teks tidak terpercaya di-retarget ke printer linier simple.ts.)

import { afterEach, describe, expect, test } from "bun:test"
import type { EventBus } from "#minicore/core/index.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import { ESC, stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { runPicker } from "../src/ui/screens/picker.ts"
import { createFakeBus, type FakeTty, installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
})

const lines = (t: FakeTty) => stripAnsi(t.all()).split("\n")

describe("picker popup: region di atas layar, hormat ukuran terminal", () => {
  test("label CJK panjang dipotong ke lebar kolom", async () => {
    tty = installFakeTty({ columns: 40, rows: 20 })
    const p = runPicker({
      title: "Uji",
      items: [
        { name: "这是一个非常长的中文模型名称需要被截断处理", provider: "提供者", value: "a" },
        { name: "b".repeat(120), provider: "p", value: "b" },
      ],
      onPick: () => {},
      onCancel: () => {},
    })
    await tty.ready()
    // paintRegion cursor-addressed: ukur via parser screen, bukan byte mentah
    // (CSI CUP/EL bukan SGR dan tak di-strip oleh stripAnsi).
    for (const l of tty.screen()) expect(displayWidth(l)).toBeLessThanOrEqual(40)
    await tty.send(KEY.esc, 30)
    await p
  })

  test("terminal 3 baris: tolak BERSUARA + batal (tanpa inline, tanpa gantung)", async () => {
    tty = installFakeTty({ columns: 60, rows: 3 })
    const items = Array.from({ length: 30 }, (_, i) => ({
      name: `m${i}`,
      provider: "p",
      value: `${i}`,
    }))
    let cancelled = false
    const p = runPicker({
      title: "Pendek",
      items,
      onPick: () => {},
      onCancel: () => (cancelled = true),
    })
    await p
    // Jalur overlay inline dihapus: popup butuh layar mampu. Tanpa listener
    // stdin (ready() akan timeout) — langsung settle + pesan + onCancel.
    expect(cancelled).toBe(true)
    expect(tty.all()).toContain("needs an interactive terminal")
  })

  test("resize mengecil langsung diikuti", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const items = Array.from({ length: 40 }, (_, i) => ({
      name: `model-${i}`,
      provider: "provider-panjang",
      value: `${i}`,
    }))
    const p = runPicker({ title: "R", items, onPick: () => {}, onCancel: () => {} })
    await tty.ready()
    tty.resize(40, 10)
    await tty.send("", 40)
    for (const l of tty.screen()) expect(displayWidth(l)).toBeLessThanOrEqual(40)
    await tty.send(KEY.esc, 30)
    await p
  })

  test("filter dengan metakarakter regex tidak melempar", async () => {
    tty = installFakeTty({ rows: 20 })
    const p = runPicker({
      title: "T",
      items: [{ name: "a.b", provider: "p", value: "1" }],
      filterable: true,
      onPick: () => {},
      onCancel: () => {},
    })
    await tty.ready()
    for (const ch of "([{*+?^$|\\") await tty.send(ch, 3)
    // Tidak melempar = sampai di sini.
    await tty.send(KEY.esc, 20)
    await tty.send(KEY.esc, 20)
    await p
  })

  test("daftar kosong: Enter memanggil onCancel", async () => {
    tty = installFakeTty({ rows: 20 })
    let hasil: string | null | undefined
    const p = runPicker({
      title: "Kosong",
      items: [],
      onPick: (v) => {
        hasil = v
      },
      onCancel: () => {
        hasil = null
      },
    })
    await tty.ready()
    await tty.send(KEY.enter, 40)
    await p
    expect(hasil).toBeNull()
  })

  test("label tak-terpercaya disanitasi, bukan passthrough ANSI", async () => {
    // Sumber label (nama model/provider, cwd sesi) turun dari config/DB/file
    // — barisnya bisa mengandung escape bila data kotor. truncateToWidth
    // menyalin SEMUA sekuens escape (termasuk 2J/1049h), jadi sanitasi wajib
    // di titik bangun label. Kode lama: lolos mentah ke terminal.
    // CATATAN modal: bingkai screen.paint sendiri menulis 2J (clear buffer
    // alt — tak merusak scrollback), jadi yang ditegaskan = RANGKAIAN SERANG
    // dari data, bukan byte bingkai.
    tty = installFakeTty({ columns: 60, rows: 20 })
    const p = runPicker({
      title: "T",
      items: [{ name: "m\x1b[2JAHAT", provider: "p\x1b[?1049h", value: "v" }],
      onPick: () => {},
      onCancel: () => {},
    })
    await tty.ready()
    const out = tty.all()
    expect(out).not.toContain("m\x1b[2JAHAT")
    expect(out).not.toContain("p\x1b[?1049h")
    expect(stripAnsi(out)).toContain("mAHAT")
    await tty.send(KEY.esc, 30)
    await p
  })

  test("baris manager dengan id kotor disanitasi", async () => {
    const { runModelManagerView } = await import("../src/ui/screens/model-manager.ts")
    tty = installFakeTty({ columns: 60, rows: 20 })
    const p = runModelManagerView({
      initialRows: [{ id: "p::m\x1b[2JAHAT", active: false }],
      onSelect: () => {},
      loadRows: async () => [],
      onDelete: async () => [],
    })
    await tty.ready()
    const out = tty.all()
    expect(out).not.toContain("m\x1b[2JAHAT")
    expect(stripAnsi(out)).toContain("mAHAT")
    await tty.send(KEY.esc, 30)
    await p
  })
})

// Printer linier menggantikan fullscreen: teks model & hasil tool adalah masukan
// tidak terpercaya. Tanpa sanitasi ia bisa membersihkan layar, keluar dari
// alternate screen, atau mengubah judul jendela — langsung ke scrollback.
describe("printer linier: teks tidak terpercaya tetap disanitasi", () => {
  function attach() {
    const t = installFakeTty({ columns: 80, rows: 24 })
    const bus = createFakeBus()
    const detach = attachSimpleLogger(bus as unknown as EventBus)
    return { tty: t, bus, detach }
  }

  test("sekuens kontrol dari model tidak diteruskan ke terminal", async () => {
    const h = attach()
    tty = h.tty
    h.bus.emit("provider:text", {
      text: "aman\x1b[2J\x1b[H\x1b[?1049hJAHAT\x1b]0;bajak\x07\x1b[?25l\n",
    })
    await new Promise((r) => setTimeout(r, 30))
    const out = h.tty.combined()
    expect(out).not.toContain("\x1b[2J")
    expect(out).not.toContain("\x1b[?1049h")
    expect(out).not.toContain("\x1b]0;")
    expect(out).not.toContain("\x1b[?25l")
    // Teksnya tetap tampil.
    expect(stripAnsi(out)).toContain("amanJAHAT")
    h.detach()
  })

  test("hasil tool juga disanitasi", async () => {
    const h = attach()
    tty = h.tty
    h.bus.emit("execution:completed", {
      execution: {
        call: { name: "bash", args: { cmd: "cat berkas\x1b[2J" } },
        result: { isError: true, content: "gagal\x1b[?1049l\x1b]0;x\x07" },
      },
    })
    await new Promise((r) => setTimeout(r, 30))
    const out = h.tty.combined()
    expect(out).not.toContain("\x1b[2J")
    expect(out).not.toContain("\x1b[?1049l")
    expect(out).not.toContain("\x1b]0;")
    h.detach()
  })

  test("warna dari diff card tetap lewat setelah sanitasi", async () => {
    const h = attach()
    tty = h.tty
    h.bus.emit("execution:completed", {
      execution: {
        call: { name: "edit", args: { path: "a.ts", oldString: "a\nb", newString: "a\nc" } },
        result: { isError: false, content: "" },
      },
    })
    await new Promise((r) => setTimeout(r, 30))
    // Masih ada sekuens SGR (warna) — sanitasi tidak membuang pewarnaan.
    expect(h.tty.combined()).toMatch(new RegExp(`${ESC}\\[[0-9;]*m`))
    h.detach()
  })

  test("streaming di terminal sempit tetap dalam lebar kolom", async () => {
    // Ekivalen linier dari "terminal ekstrem": printer membungkus teks model ke
    // lebar kolom terminal (wordWrap per baris), jadi baris tidak membungkus
    // sendiri di terminal 10 kolom.
    const h = attach()
    h.tty.resize(10, 5)
    tty = h.tty
    h.bus.emit("provider:text", { text: "teks panjang sekali yang tidak muat\n" })
    await new Promise((r) => setTimeout(r, 30))
    for (const l of lines(h.tty)) expect(displayWidth(l), l).toBeLessThanOrEqual(10)
    h.detach()
  })
})
