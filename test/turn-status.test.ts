// Lifecycle garis status turn (attachTurnStatus): Satu baris transient di
// stderr selama turn berjalan. Yang DIKUNCI di sini adalah determinisme
// transisi — bukan keindahan teks:
//   - turn:started TIDAK langsung melukis; grace 250ms menutup keheningan
//     total (jendela pra-event polos agar tulis asing tak tertimpa garis)
//   - reasoning → "Thinking" tampil (kecuali fase menulis sudah dimulai)
//   - tool berjalan → label tool (nama + target) menggantikan "Thinking"
//   - teks model mengalir → garis HILANG + latch (reasoning susulan tetap
//     sembunyi sampai tool berikutnya — anti-strobo)
//   - tool berikutnya SETELAH teks → garis HIDUP LAGI + latch dibuka
//   - turn selesai / endTurn() → garis dibersihkan dan tidak pernah muncul
//     lagi (endTurn = jalur driver saat kernel TIDAK emit turn:completed,
//     yaitu gagal/abort)

import { afterEach, describe, expect, test } from "bun:test"
import { attachTurnStatus } from "../src/ui/assistant/turn-status.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let tty: FakeTty | undefined

afterEach(() => {
  tty?.restore()
  tty = undefined
})

const err = () => stripAnsi(tty!.allErr())

function setup(cols = 80) {
  tty = installFakeTty({ columns: cols, rows: 24 })
  const bus = createFakeBus()
  const status = attachTurnStatus(bus as never)
  return { bus, status }
}

describe("turn-status: lifecycle deterministik", () => {
  test("turn:started belum melukis; reasoning/tool memulai lukisan", async () => {
    const { bus, status } = setup()
    bus.emit("turn:started", { turn: 1 })
    await sleep(100) // jauh sebelum grace 250ms — hening total
    expect(err()).toBe("")
    // Tool mulai → lukisan dengan label tool (bukan "Thinking").
    bus.emit("execution:started", {
      execution: { call: { name: "read_file", args: { path: "src/auth.ts" } } },
    })
    await sleep(60)
    expect(err()).toContain("read_file src/auth.ts")
    status.detach()
  }, 4000)

  test("grace 250ms: hening dulu, Thinking muncul tanpa event kerja", async () => {
    const { bus, status } = setup()
    bus.emit("turn:started", { turn: 1 })
    await sleep(100)
    expect(err()).toBe("")
    await sleep(300) // total >250ms: grace melukis Thinking
    expect(err()).toContain("✦")
    status.detach()
  }, 4000)

  test("reasoning susulan saat menulis tetap sembunyi (anti-strobo latch)", async () => {
    const { bus, status } = setup()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: {} })
    await sleep(40)
    expect(err()).toContain("✦")
    bus.emit("provider:text", { text: "menjawab\n" })
    await sleep(40)
    tty!.clear()
    // Reasoning interleave DI TENGAH jawaban: garis harus TETAP mati.
    // Tanpa latch, tiap chunk reasoning menyalakan garis lagi (strobo).
    bus.emit("provider:extension", { kind: "reasoning", data: {} })
    await sleep(200)
    expect(err()).not.toContain("✦")
    // Tool baru membuka latch: thinking antar-tool tampil lagi.
    bus.emit("execution:started", {
      execution: { call: { name: "grep", args: { path: "src" } } },
    })
    await sleep(60)
    expect(err()).toContain("grep src")
    status.detach()
  }, 4000)

  test("turn selesai → garis dibersihkan dan diam", async () => {
    const { bus, status } = setup()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: {} })
    await sleep(40)
    bus.emit("turn:completed", {})
    tty!.clear()
    await sleep(250) // beberapa tick interval seandainya bocor
    expect(err()).toBe("")
    status.detach()
  }, 4000)

  test("endTurn saat TANPA turn:completed (gagal/abort) → bersih dan tetap bersih", async () => {
    // Regresi inti: kernel hanya emit turn:completed di jalur sukses. Setelah
    // error/Ctrl+C driver memanggil endTurn; tanpa itu painter basi menimpa
    // prompt idle (stale status line).
    const { bus, status } = setup()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:started", {
      execution: { call: { name: "bash", args: { cmd: "npm test" } } },
    })
    await sleep(60)
    expect(err()).toContain("bash npm test")
    status.endTurn() // driver: turn settle karena abort, tanpa turn:completed
    tty!.clear()
    await sleep(250)
    expect(err()).toBe("")
    // Turn berikutnya butuh event kerja baru untuk melukis lagi — state lama
    // tidak bocor (turnOn sudah false).
    bus.emit("turn:started", { turn: 2 })
    await sleep(150) // di bawah grace 250ms — state lama tidak bocor
    expect(err()).toBe("")
    status.detach()
  }, 4000)

  test("resize saat melukis: label memakai lebar baru (tidak tertinggal potongan lama)", async () => {
    const longPath = "src/modules/very/deeply/nested/component-with-long-name.ts"
    const { bus, status } = setup(40)
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:started", {
      execution: { call: { name: "edit", args: { path: longPath } } },
    })
    await sleep(60)
    const at40 = err()
    expect(at40).toContain("edit src/modules/")
    expect(at40).not.toContain(longPath) // terpotong di kolom 40
    tty!.clear()
    tty!.resize(120, 24)
    await sleep(350) // beberapa tick dengan lebar baru
    expect(err()).toContain(longPath) // kini muat — repaint memakai cols baru
    status.detach()
  }, 4000)
})

describe("turn-status: heartbeat", () => {
  test("formatElapsed: detik, menit, jam (kompat)", async () => {
    const { formatElapsed } = await import("../src/ui/assistant/turn-status.ts")
    expect(formatElapsed(0)).toBe("0s")
    expect(formatElapsed(5900)).toBe("5s")
    expect(formatElapsed(59999)).toBe("59s")
    expect(formatElapsed(60000)).toBe("1m00s")
    expect(formatElapsed(83000)).toBe("1m23s")
    expect(formatElapsed(3599999)).toBe("59m59s")
    expect(formatElapsed(3600000)).toBe("1h00m")
    expect(formatElapsed(-500)).toBe("0s")
  })

  test("garis status ikon putih + titik animasi spasi, tanpa timer", async () => {
    const { bus, status } = setup()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: {} })
    await sleep(200)
    // Ikon ✦ + titik spasi ("·", "· ·", "· · ·"), tidak ada timer detik
    expect(err()).toContain("✦")
    expect(err()).toMatch(/✦  ·( ·){0,2}/)
    expect(err()).not.toMatch(/\d+s/)
    status.detach()
  }, 5000)

  test("kursor disembunyikan saat melukis, dikembalikan saat berhenti", async () => {
    const { bus, status } = setup()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: {} })
    await sleep(60)
    // Mentah (stripAnsi membuang sekuens privat): hide saat acquire...
    expect(tty!.allErr()).toContain("\x1b[?25l")
    status.endTurn()
    // ...show saat berhenti. Tanpa ini kursor hilang permanen.
    expect(tty!.allErr()).toContain("\x1b[?25h")
    status.detach()
  }, 4000)

  test("ikon hilang saat turn selesai", async () => {
    const { bus, status } = setup()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: {} })
    await sleep(60)
    status.endTurn()
    tty!.clear()
    await sleep(300)
    expect(err()).toBe("")
    status.detach()
  }, 4000)
})
