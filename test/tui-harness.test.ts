// Self-test harness TUI: sinkronisasi output-driven + once() + answerSequence.
// Harness yang flaky membuat SEMUA test interaktif flaky — ia sendiri harus diuji.
import { expect, test } from "bun:test"
import { installFakeTty } from "./helpers/tui-harness.ts"

test("harness: fake VT mengganti TERM=dumb ambient dan memulihkannya", () => {
  const prior = process.env.TERM
  process.env.TERM = "dumb"
  const tty = installFakeTty()
  try {
    expect(process.env.TERM).toBe("xterm-256color")
  } finally {
    tty.restore()
    if (prior === undefined) delete process.env.TERM
    else process.env.TERM = prior
  }
  expect(process.env.TERM).toBe(prior)
})

test("harness: waitForOutput pulang saat marker muncul", async () => {
  const tty = installFakeTty()
  try {
    const p = tty.waitForOutput((out) => out.includes("siap"), 2000)
    // Marker belum ada → masih pending; tulis lalu harus resolve.
    await new Promise((r) => setTimeout(r, 20))
    process.stdout.write("belum siap")
    await new Promise((r) => setTimeout(r, 20))
    process.stdout.write("siap")
    const out = await p
    expect(out).toContain("siap")
  } finally {
    tty.restore()
  }
})

test("harness: waitForOutput timeout melempar, bukan gantung", async () => {
  const tty = installFakeTty()
  try {
    await expect(tty.waitForOutput(() => false, 50)).rejects.toThrow()
  } finally {
    tty.restore()
  }
})

test("harness: once() melepas listener setelah satu panggilan", async () => {
  const tty = installFakeTty()
  try {
    // Komponen yang lupa removeListener + harness once() yang bocor membuat
    // send() fan-out ganda ke prompt yang sudah tutup (duplikat input).
    let calls = 0
    const stdin = process.stdin as unknown as {
      once(event: string, fn: (c: Buffer) => void): void
    }
    stdin.once("data", () => {
      calls++
    })
    await tty.send("a", 5)
    await tty.send("b", 5)
    expect(calls).toBe(1)
  } finally {
    tty.restore()
  }
})

test("harness: answerSequence ke listener raw terbaru + tunggu marker", async () => {
  const tty = installFakeTty()
  try {
    // Simulasikan dua prompt berurutan: prompt-1 pasang listener, jawab,
    // tutup (tapi bocor — lupa removeListener), prompt-2 pasang listener baru.
    // Jawaban ke-2 HANYA boleh ke listener-2, bukan fan-out ke yang bocor.
    const stdin = process.stdin as unknown as {
      setRawMode(v: boolean): void
      on(event: string, fn: (c: Buffer) => void): void
    }
    stdin.setRawMode(true)
    const got1: string[] = []
    const got2: string[] = []
    const seq = tty.answerSequence(["satu", "dua"], {
      expect: [(out) => out.includes("PROMPT-1"), (out) => out.includes("PROMPT-2")],
      timeoutMs: 2000,
    })
    await new Promise((r) => setTimeout(r, 10))
    stdin.on("data", (c: Buffer) => {
      got1.push(c.toString())
    })
    process.stdout.write("PROMPT-1")
    // Tunggu jawaban-1 terkirim sebelum prompt-2 muncul (seperti askLine nyata).
    const deadline = Date.now() + 2000
    while (got1.length === 0) {
      if (Date.now() > deadline) throw new Error("jawaban-1 tidak terkirim")
      await new Promise((r) => setTimeout(r, 5))
    }
    stdin.on("data", (c: Buffer) => {
      got2.push(c.toString())
    })
    process.stdout.write("PROMPT-2")
    await seq
    expect(got1).toEqual(["satu\r"])
    expect(got2).toEqual(["dua\r"])
  } finally {
    tty.restore()
  }
})
