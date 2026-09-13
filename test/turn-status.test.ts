// Lifecycle garis status turn (attachTurnStatus): Satu baris transient di
// stderr selama turn berjalan. Yang DIKUNCI di sini adalah determinisme
// transisi — bukan keindahan teks:
//   - turn:started TIDAK langsung melukis (jendela pra-event polos agar tulis
//     asing — mis. catatan [router] — tak pernah tertimpa garis ini)
//   - reasoning → "Thinking" tampil
//   - tool berjalan → label tool (nama + target) menggantikan "Thinking"
//   - teks model mengalir → garis HILANG (tidak menimpa area teks)
//   - tool berikutnya SETELAH teks → garis HIDUP LAGI (dulu mati permanen)
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
    await sleep(250) // beberapa tick interval seandainya bocor
    expect(err()).toBe("")
    // Tool mulai → lukisan dengan label tool (bukan "Thinking").
    bus.emit("execution:started", {
      execution: { call: { name: "read_file", args: { path: "src/auth.ts" } } },
    })
    await sleep(60)
    expect(err()).toContain("read_file src/auth.ts")
    status.detach()
  }, 4000)

  test("reasoning ext menampilkan Thinking; teks menyembunyikan; tool berikutnya menghidupkan lagi", async () => {
    const { bus, status } = setup()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: {} })
    await sleep(40)
    expect(err()).toContain("✦")
    tty!.clear()
    bus.emit("provider:text", { text: "menjawab\n" })
    await sleep(60)
    expect(err()).not.toContain("✦")
    // Tool baru dimulai SETELAH teks → garis harus hidup kembali (regresi:
    // dulu onText menghentikan interval dan tak pernah restart).
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
    await sleep(200)
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

  test("garis status ikon putih + titik animasi, tanpa timer", async () => {
    const { bus, status } = setup()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: {} })
    await sleep(200)
    // Ikon ✦ + titik animasi, tidak ada timer detik
    expect(err()).toContain("✦")
    expect(err()).toMatch(/✦·{1,3}/)
    expect(err()).not.toMatch(/\d+s/)
    status.detach()
  }, 5000)

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
