// Kontrak terminal MiniCode (docs/TERMINAL_CONTRACT.md) — test invariant
// KONSOLIDASI: ownership & lifecycle, bukan snapshot teks. Assertion
// behavioral: hitung marker, cek newline, cek tidak ada tulis setelah
// detach/endTurn, cek arbitrase owner. Detail per-area ada di
// transient-arbitration / turn-status / tui-format (peta proteksi).

import { afterEach, describe, expect, test } from "bun:test"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import { attachTurnStatus, type TurnStatusHandle } from "../src/ui/assistant/turn-status.ts"
import { setCompactMode } from "../src/ui/render/detail.ts"
import { setReasoningVisible } from "../src/ui/render/reasoning.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { acquireTransientPaint, isTransientPainting } from "../src/ui/runtime/statusline.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ESC = String.fromCharCode(27)

let tty: FakeTty | undefined
let status: TurnStatusHandle | null = null

afterEach(() => {
  status?.detach()
  status = null
  setCompactMode(false)
  setReasoningVisible(false)
  // Section collapse dibaca per-event dari env — bocor antar test dalam
  // file yang sama akan mengubah cabang › vs + secara diam-diam.
  delete process.env.MINICODE_MINIMIZE_TOOL
  tty?.restore()
  tty = undefined
})

function turnPainter(): { bus: ReturnType<typeof createFakeBus>; status: TurnStatusHandle } {
  tty = installFakeTty({ columns: 80, rows: 24 })
  const bus = createFakeBus()
  const s = attachTurnStatus(bus as never)
  status = s
  return { bus, status: s }
}

describe("terminal contract: ownership arbitrator", () => {
  test("satu owner per kind; overlap kind beda = warning sekali per pasangan", () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    tty.clear()
    // Kind unik per run: set warning sekali-per-pasangan bersifat proses-global
    // (lihat implementasi), jadi kind tetap menghindari tabrakan antar test.
    const turn = acquireTransientPaint("kind-alpha", () => {})
    expect(isTransientPainting()).toBe(true)
    // Klaim kedua ber-kind sama: senyap (turn-status ganti tool berulang).
    const turn2 = acquireTransientPaint("kind-alpha", () => {})
    expect(tty!.allErr()).toBe("")
    // Kind beda saat owner aktif: signal overlap (sekali per pasangan).
    const spin = acquireTransientPaint("kind-beta", () => {})
    const first = tty!.allErr()
    expect(first).toContain("[transient-paint] kind-beta starts while kind-alpha active")
    tty!.clear()
    const spin2 = acquireTransientPaint("kind-beta", () => {})
    expect(tty!.allErr()).toBe("") // tidak dobel per pasangan
    spin2.release()
    spin.release()
    turn2.release()
    turn.release()
    expect(isTransientPainting()).toBe(false)
  })

  test("tulis asing saat owner aktif: dikomit + memicu repaint (paintNow)", () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    tty.clear()
    let repaints = 0
    const own = acquireTransientPaint("turn", () => {
      repaints++
    })
    process.stderr.write("[router] substituting model\n")
    expect(tty!.allErr()).toContain(`${ESC}[2K[router] substituting model`)
    expect(repaints).toBeGreaterThanOrEqual(1)
    own.release()
  })

  test("tanpa owner, tulis asing lewat apa adanya (wrapper inert)", () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    tty.clear()
    process.stderr.write("[warn] idle diagnostic\n")
    expect(tty!.allErr()).toBe("[warn] idle diagnostic\n")
  })
})

describe("terminal contract: tidak ada tulis setelah detach/endTurn", () => {
  test("event kerja SETELAH detach tidak melukis apa pun", async () => {
    const { bus, status: s } = turnPainter()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: {} })
    await sleep(50)
    expect(tty!.allErr()).toContain("✦")
    s.detach()
    status = null
    tty!.clear()
    // Event telat dari kernel (late tool/reasoning) — tidak boleh melukis.
    bus.emit("execution:started", {
      execution: { call: { name: "bash", args: { cmd: "late" } } },
    })
    bus.emit("provider:text", { text: "telat\n" })
    await sleep(300)
    expect(tty!.allErr()).toBe("")
  }, 4000)

  test("endTurn idempotent; event telat setelah endTurn tidak melukis", async () => {
    const { bus, status: s } = turnPainter()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:started", {
      execution: { call: { name: "bash", args: { cmd: "npm test" } } },
    })
    await sleep(60)
    expect(tty!.allErr()).toContain("bash npm test")
    s.endTurn()
    s.endTurn() // idempotent
    tty!.clear()
    bus.emit("execution:started", {
      execution: { call: { name: "bash", args: { cmd: "late-settle" } } },
    })
    await sleep(300)
    expect(tty!.allErr()).toBe("")
    s.detach()
    status = null
  }, 4000)
})

describe("terminal contract: ledger & streaming", () => {
  const done = (name: string, args: Record<string, unknown>, content: string, isError = false) => ({
    execution: { call: { name, args }, result: { isError, content } },
  })

  test("event duplikat identik = baris ledger terpisah, bukan gabungan", () => {
    setCompactMode(true)
    const { bus, detach } = (() => {
      tty = installFakeTty({ columns: 80, rows: 24 })
      const bus = createFakeBus()
      return { bus, detach: attachSimpleLogger(bus as never) }
    })()
    bus.emit("execution:completed", done("read_file", { path: "a.ts" }, "isi a"))
    bus.emit("execution:completed", done("read_file", { path: "a.ts" }, "isi a"))
    bus.emit("provider:text", { text: "baris teks\nbaris teks\n" })
    detach()
    const ledger = tty!.allErr()
    const lines = stripAnsi(ledger)
      .split("\n")
      .filter((l) => l.length > 0)
    expect(lines.filter((l) => l.startsWith("  › read_file a.ts"))).toHaveLength(2)
    for (const l of lines) expect(l.indexOf("›")).toBe(l.lastIndexOf("›")) // tanpa dua marker sebaris
    const out = tty!.all()
    expect(out.split("baris teks")).toHaveLength(3) // dua baris utuh, tidak menyatu
  })

  test("semua branch ledger: satu marker per baris, setiap baris ber-newline (compact)", () => {
    setCompactMode(true)
    const { bus, detach } = (() => {
      tty = installFakeTty({ columns: 80, rows: 24 })
      const bus = createFakeBus()
      return { bus, detach: attachSimpleLogger(bus as never) }
    })()
    bus.emit("execution:completed", done("read_file", { path: "r.ts" }, "konten", false))
    bus.emit("execution:completed", done("bash", { cmd: "ls" }, "a\nb\nc", false))
    bus.emit("execution:completed", done("write_file", { path: "w.ts" }, "0 chars"))
    bus.emit("execution:completed", done("edit", { path: "e.ts" }, "ok"))
    bus.emit("execution:completed", done("grep", { path: "src" }, "gagal singkat", true))
    detach()
    const raw = tty!.allErr()
    const lines = stripAnsi(raw).split("\n")
    for (const l of lines) {
      if (!l.trim()) continue
      expect(
        l.startsWith("  › ") || l.startsWith("    "),
        `baris ledger tidak dikenal: ${JSON.stringify(l)}`,
      ).toBe(true)
      expect(l.indexOf("›"), l).toBe(l.lastIndexOf("›"))
    }
    // Setiap baris utuh diakhiri newline (tidak ada marker yang menempel).
    // Reset warna boleh datang SETELAH newline — periksa teks bersih.
    expect(stripAnsi(raw).endsWith("\n")).toBe(true)
  })

  test("long session: 3 turn × 12 tool tetap ledger satu-baris per tool", () => {
    setCompactMode(true)
    const { bus, detach } = (() => {
      tty = installFakeTty({ columns: 80, rows: 24 })
      const bus = createFakeBus()
      return { bus, detach: attachSimpleLogger(bus as never) }
    })()
    for (let t = 0; t < 3; t++) {
      bus.emit("turn:started", { turn: t + 1 })
      for (let i = 0; i < 12; i++) {
        bus.emit("execution:completed", done("read_file", { path: `t${t}-f${i}.ts` }, `isi ${i}\n`))
      }
      bus.emit("provider:text", { text: `jawaban turn ${t + 1}\n` })
      bus.emit("turn:completed", {})
    }
    detach()
    const ledger = stripAnsi(tty!.allErr())
    const markers = ledger.split("\n").filter((l) => l.startsWith("  › read_file"))
    expect(markers).toHaveLength(36)
    for (const m of markers) {
      expect(m.indexOf("›"), m).toBe(m.lastIndexOf("›"))
    }
    // Tidak ada satu pun baris yang menggabungkan dua path tool.
    for (const l of markers) {
      expect(l.includes(".ts  "), l).toBe(false)
    }
    // Konten tool tidak bocor ke ledger compact; teks model utuh di stdout.
    expect(tty!.allErr()).not.toContain("isi 0")
    expect(tty!.all().split("jawaban turn")).toHaveLength(4)
  })
})
