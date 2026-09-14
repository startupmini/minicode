// Section collapse (+ / - / /expand / /minimize): output besar (thinking,
// bash, edit, content tool) dikecilkan jadi satu baris `  + label` saat
// MINICODE_MINIMIZE_TOOL=1 (default REPL) — isi di-buffer, bukan dicetak.
// Env kosong = expanded = perilaku lama. Toggle live membaca reasoning.visible
// dan MINICODE_MINIMIZE_TOOL per event (pola detail.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { EventBus } from "#minicore/core/index.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import {
  bufferSection,
  getBufferedSections,
  resetBufferedSections,
  setSectionMinimized,
} from "../src/ui/render/collapse.ts"
import { setReasoningVisible } from "../src/ui/render/reasoning.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined

beforeEach(() => {
  tty = installFakeTty({ columns: 80, rows: 24 })
  setReasoningVisible(false)
  delete process.env.MINICODE_MINIMIZE_TOOL
  delete process.env.MINICODE_MINIMIZE_ANSWER
  resetBufferedSections()
})

afterEach(() => {
  tty?.restore()
  tty = undefined
  setReasoningVisible(false)
  delete process.env.MINICODE_MINIMIZE_TOOL
  delete process.env.MINICODE_MINIMIZE_ANSWER
  resetBufferedSections()
})

const attach = () => {
  const bus = createFakeBus()
  const detach = attachSimpleLogger(bus as unknown as EventBus, {})
  return {
    bus,
    detach,
    err: () => stripAnsi(tty!.allErr()),
    all: () => stripAnsi(tty!.combined()),
  }
}

const done = (name: string, args: Record<string, unknown>, content: string, isError = false) => ({
  execution: {
    call: { name, args },
    result: { isError, content },
  },
})

describe("collapse: thinking section", () => {
  test("minimized default: satu baris + thinking, isi di-buffer bukan dicetak", () => {
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "pemikiran rahasia\n" } })
    bus.emit("provider:text", { text: "jawaban\n" })
    bus.emit("turn:completed", {})
    detach()
    expect(err()).toContain("+ thinking")
    expect(err()).not.toContain("pemikiran rahasia")
    expect(
      getBufferedSections().some(
        (s) => s.label === "thinking" && s.text.includes("pemikiran rahasia"),
      ),
    ).toBe(true)
  })

  test("expanded: header - thinking + teks mengalir", () => {
    setReasoningVisible(true)
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "pemikiran terlihat\n" } })
    detach()
    expect(err()).toContain("− thinking")
    expect(err()).toContain("pemikiran terlihat")
  })

  test("toggle mid-thinking: expand flush buffer, collapse buffer lagi", () => {
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "satu\n" } })
    // expand: header - thinking + buffer lama ikut dicetak, lalu stream
    setReasoningVisible(true)
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "dua\n" } })
    expect(err()).toContain("− thinking")
    expect(err()).toContain("satu")
    expect(err()).toContain("dua")
    // collapse lagi: header + thinking + buffer baru
    setReasoningVisible(false)
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "tiga\n" } })
    expect(err()).toContain("+ thinking")
    expect(err()).not.toContain("tiga")
    bus.emit("turn:completed", {})
    detach()
    expect(getBufferedSections().some((s) => s.text.includes("tiga"))).toBe(true)
  })
})

describe("collapse: tool section", () => {
  test("minimized: bash hanya satu baris + bash $ cmd, output di-buffer", () => {
    setSectionMinimized("tool", true)
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:started", {
      execution: { call: { name: "bash", args: { cmd: "ls -la" } } },
    })
    bus.emit("execution:completed", done("bash", { cmd: "ls -la" }, "file1\nfile2\nfile3\n"))
    bus.emit("turn:completed", {})
    detach()
    expect(err()).toContain("+ bash $ ls -la")
    expect(err()).not.toContain("file1")
    expect(
      getBufferedSections().some((s) => s.label === "bash $ ls -la" && s.text.includes("file3")),
    ).toBe(true)
  })

  test("minimized: edit satu baris + edit path, isi di-buffer", () => {
    setSectionMinimized("tool", true)
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit(
      "execution:completed",
      done("edit", { path: "src/a.ts", oldString: "lama", newString: "baru" }, "ok"),
    )
    detach()
    expect(err()).toContain("+ edit src/a.ts")
    expect(err()).not.toContain("lama")
    expect(getBufferedSections().some((s) => s.label === "edit src/a.ts")).toBe(true)
  })

  test("expanded (env kosong): output penuh tercetak — perilaku lama utuh", () => {
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:completed", done("bash", { cmd: "echo hi" }, "hi\n"))
    detach()
    expect(err()).toContain("hi")
  })

  test("error tool selalu tampil walau dikecilkan", () => {
    setSectionMinimized("tool", true)
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:completed", done("read_file", { path: "x.ts" }, "gagal membaca", true))
    detach()
    expect(err()).toContain("› read_file: gagal membaca")
    expect(err()).not.toContain("+ read_file")
  })

  test("toggle tool saat aktif: expand = output penuh, minimize = buffer lagi", () => {
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:started", { execution: { call: { name: "bash", args: { cmd: "b" } } } })
    // expand (seperti tombol +): tool berikutnya dicetak penuh
    setSectionMinimized("tool", false)
    bus.emit("execution:completed", done("bash", { cmd: "b" }, "terlihat\n"))
    expect(err()).toContain("terlihat")
    // minimize lagi: tool berikutnya dikecilkan
    setSectionMinimized("tool", true)
    bus.emit("execution:completed", done("bash", { cmd: "c" }, "tersembunyi\n"))
    expect(err()).not.toContain("tersembunyi")
    detach()
    expect(getBufferedSections().some((s) => s.text.includes("tersembunyi"))).toBe(true)
  })
})

describe("collapse: answer section", () => {
  const minimizeAnswer = () => {
    process.env.MINICODE_MINIMIZE_ANSWER = "1"
  }

  test("minimized: jawaban di-buffer, satu baris + answer (N chars) di akhir", () => {
    minimizeAnswer()
    const { bus, detach, err, all } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:text", { text: "jawaban lengkap\nbaris dua\n" })
    // Selama streaming: tidak ada teks jawaban di scrollback.
    expect(all()).not.toContain("jawaban lengkap")
    bus.emit("turn:completed", {})
    detach()
    expect(err()).toContain("+ answer (")
    expect(err()).toContain("chars)")
    // Baris minimize wajib memberi tahu cara membuka — tanpa ini jawaban
    // yang dikecilkan terlihat "bisu" (tak ada off-switch yang bisa ditemukan).
    expect(err()).toContain("/expand to read")
    const buf = getBufferedSections()
    const ans = buf.find((s) => s.label === "answer")
    expect(ans?.stream).toBe("stdout")
    expect(ans?.text).toContain("jawaban lengkap")
  })

  test("expanded (env kosong): jawaban mengalir seperti dulu", () => {
    const { bus, detach, all } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:text", { text: "terlihat langsung\n" })
    bus.emit("turn:completed", {})
    detach()
    expect(all()).toContain("terlihat langsung")
    expect(getBufferedSections().length).toBe(0)
  })

  test("expand live: buffer lama tercetak + lanjut stream", () => {
    minimizeAnswer()
    const { bus, detach, all } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:text", { text: "bagian satu\n" })
    expect(all()).not.toContain("bagian satu")
    // Tombol + : minimize mati → header + flush + stream.
    delete process.env.MINICODE_MINIMIZE_ANSWER
    bus.emit("provider:text", { text: "bagian dua\n" })
    expect(all()).toContain("bagian satu")
    expect(all()).toContain("bagian dua")
    detach()
  })

  test("todo_write diringkas jadi N items (bukan dump JSON)", () => {
    setSectionMinimized("tool", true)
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit(
      "execution:completed",
      done("todo_write", { todos: [{ content: "a", status: "pending" }] }, "ok"),
    )
    detach()
    expect(err()).toContain("+ todo_write 1 items")
    expect(err()).not.toContain('"content"')
  })
})

describe("collapse: buffer & reset", () => {
  test("bufferSection cap per-entry", () => {
    bufferSection("x", "y".repeat(500_000))
    const buf = getBufferedSections()
    expect(buf[buf.length - 1]!.text.length).toBeLessThanOrEqual(200_000)
  })

  test("bufferSection cap total: tertua dibuang, terbaru dipertahankan", () => {
    bufferSection("a", "a".repeat(200_000))
    bufferSection("b", "b".repeat(200_000))
    bufferSection("c", "c".repeat(200_000))
    const buf = getBufferedSections()
    const total = buf.reduce((n, s) => n + s.text.length, 0)
    expect(total).toBeLessThanOrEqual(500_000)
    expect(buf[buf.length - 1]!.label).toBe("c")
    expect(buf.some((s) => s.label === "a")).toBe(false)
  })

  test("alur /expand: baca buffer lalu kosongkan (tanpa cetak ganda)", () => {
    bufferSection("bash $ ls", "file1\n")
    expect(getBufferedSections().length).toBe(1)
    // repl /expand membaca lalu memanggil reset — tiru urutannya persis.
    const shown = getBufferedSections()
      .map((s) => `── ${s.label} ──\n${s.text}`)
      .join("\n")
    expect(shown).toContain("file1")
    resetBufferedSections()
    expect(getBufferedSections().length).toBe(0)
  })

  test("turn:started membersihkan buffer turn sebelumnya", () => {
    setSectionMinimized("tool", true)
    const { bus, detach } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:completed", done("bash", { cmd: "a" }, "isi\n"))
    expect(getBufferedSections().length).toBe(1)
    bus.emit("turn:started", { turn: 2 })
    expect(getBufferedSections().length).toBe(0)
    detach()
  })
})
