// Regresi: semua teks tak terpercaya (reasoning model, output tool, argumen
// tool) WAJIB lewat sanitizeAnsi sebelum ke terminal. provider:text sudah
// disanitasi sejak lama; jalur di bawah ini ditemukan mentah saat audit
// 2026-09-16 (H1/H2/M6) — payload `\x1b[2J` sampai utuh ke scrollback.
// Tiap test gagal di kode lama (tulis mentah), hijau setelah sanitasi.
import { afterEach, describe, expect, test } from "bun:test"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import { attachTurnStatus, type TurnStatusHandle } from "../src/ui/assistant/turn-status.ts"
import { setCompactMode } from "../src/ui/render/detail.ts"
import { setReasoningVisible } from "../src/ui/render/reasoning.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let tty: FakeTty | undefined
let status: TurnStatusHandle | null = null

afterEach(() => {
  status?.detach()
  status = null
  setCompactMode(false)
  setReasoningVisible(false)
  delete process.env.MINICODE_MINIMIZE_TOOL
  delete process.env.MINICODE_MINIMIZE_ANSWER
  tty?.restore()
  tty = undefined
})

function logger(opts: { verbose?: boolean } = {}) {
  tty = installFakeTty({ columns: 80, rows: 24 })
  const bus = createFakeBus()
  const detach = attachSimpleLogger(bus as never, opts)
  return { bus, detach }
}

describe("sanitasi render: teks tak terpercaya", () => {
  test("reasoning expanded: ESC pembersih layar dibuang, teks kept", () => {
    const { bus, detach } = logger({ verbose: true })
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", {
      kind: "reasoning",
      data: { text: "mikir \x1b[2J\x1b[H JAHAT\n" },
    })
    detach()
    const raw = tty!.allErr()
    expect(raw).not.toContain("\x1b[2J")
    expect(raw).not.toContain("\x1b[H")
    expect(raw).toContain("JAHAT")
  })

  test("bash compact preview: output tool berisi escape dibuang", () => {
    setCompactMode(true)
    const { bus, detach } = logger()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:completed", {
      execution: {
        call: { name: "bash", args: { cmd: "ls" } },
        result: { isError: false, content: "a\n\x1b[2J EVIL\nb\n" },
      },
    })
    detach()
    const raw = tty!.allErr()
    expect(raw).not.toContain("\x1b[2J")
    expect(raw).toContain("EVIL")
  })

  test("receipt write_file: path berisi escape dibuang", () => {
    const { bus, detach } = logger()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:completed", {
      execution: {
        call: { name: "write_file", args: { path: "a\x1b[2Jb.ts" } },
        result: { isError: false, content: "ditulis" },
      },
    })
    detach()
    const raw = tty!.all()
    expect(raw).not.toContain("\x1b[2J")
    expect(raw).toContain("write_file")
  })

  test("step:started verbose: nama + argumen tool disanitasi", () => {
    const { bus, detach } = logger({ verbose: true })
    bus.emit("turn:started", { turn: 1 })
    bus.emit("step:started", {
      step: { index: 1, toolCalls: [{ name: "bash", args: { cmd: "\x1b[2J evil" } }] },
    })
    detach()
    const raw = tty!.allErr()
    expect(raw).not.toContain("\x1b[2J")
    expect(raw).toContain("evil")
  })

  test("garis status tool: cmd berisi escape dibuang", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const bus = createFakeBus()
    status = attachTurnStatus(bus as never)
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:started", {
      execution: { call: { name: "bash", args: { cmd: "ls \x1b[2J EVIL" } } },
    })
    await sleep(60)
    const raw = tty!.allErr()
    expect(raw).not.toContain("\x1b[2J")
    expect(raw).toContain("EVIL")
  }, 4000)
})
