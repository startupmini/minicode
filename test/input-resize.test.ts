// Regresi snap kiri/kanan: invalidasi jangkar input saat geometri berubah.
// Latar: prevRows/prevInputRows/prevCursorRow di askLine mengasumsikan grid
// pra-reflow; render dari jangkar basi mendarat di baris salah (kopi di area
// ketik/output + hapus baris salah). Sejak perbaikan, render pertama sesudah
// columns/rows berubah me-reset ketiganya dan menggambar dari kursor saat ini.
import { afterEach, describe, expect, test } from "bun:test"
import { askLine } from "../src/ui/input/input.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { type FakeTty, installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined

afterEach(() => {
  tty?.restore()
  tty = undefined
})

const visible = (t: FakeTty): string => stripAnsi(t.all())

describe("askLine: resize menginvalidasi jangkar render", () => {
  test("multiline: tanpa gerakan CUP ke anchor basi sesudah resize", async () => {
    tty = installFakeTty({ columns: 100, rows: 30 })
    const p = askLine({ prompt: "> " })
    await tty.ready()
    await tty.send("ab")
    await tty.send("\x0a", 30)
    await tty.send("cd") // kursor di baris 1 → prevCursorRow = 1
    tty.clear()
    tty.resize(40, 30) // snap: hanya lebar berubah, baris tetap
    await tty.send("e")
    const out = tty.chunks().join("")
    // Kode lama: `\x1b[1A` kembali ke anchor pra-reflow (baris salah).
    // Kode baru: jangkar di-reset → tanpa gerakan naik.
    expect(out).not.toContain("\x1b[1A")
    // Isi tak hilang karena reset: seluruh teks tetap tergambar.
    expect(visible(tty)).toContain("ab")
    expect(visible(tty)).toContain("cde")
    await tty.send(KEY.ctrlC, 20)
    expect(await p).toBeNull()
  })

  test("dropdown terbuka selamat dari resize: konten utuh", async () => {
    const cmds = ["/help", "/model", "/sessions", "/status", "/sync"]
    const hints = (line: string): string[] =>
      line.startsWith("/") ? cmds.filter((c) => c.startsWith(line)) : []
    tty = installFakeTty({ columns: 100, rows: 30 })
    const p = askLine({ prompt: "> ", hints })
    await tty.ready()
    await tty.send("/s")
    tty.resize(50, 24)
    await tty.send("y") // "/sy" → hanya /sync
    expect(visible(tty)).toContain("/sync")
    expect(visible(tty)).toContain("/sy")
    await tty.send(KEY.ctrlC, 20)
    expect(await p).toBeNull()
  })

  test("nilai submit utuh melewati resize ganda", async () => {
    tty = installFakeTty({ columns: 100, rows: 30 })
    const p = askLine({ prompt: "> " })
    await tty.ready()
    await tty.send("hal")
    tty.resize(140, 30)
    tty.resize(40, 24)
    await tty.send("o")
    await tty.send(KEY.enter, 30)
    expect(await p).toBe("halo")
  })

  test("resize cepat ×10 lalu ketik + submit", async () => {
    tty = installFakeTty({ columns: 100, rows: 30 })
    const p = askLine({ prompt: "> " })
    await tty.ready()
    await tty.send("ab")
    for (const [c, r] of [
      [60, 20],
      [120, 40],
      [40, 24],
      [100, 30],
      [70, 20],
      [110, 44],
      [50, 12],
      [90, 30],
      [60, 24],
      [100, 30],
    ] as [number, number][]) {
      tty.resize(c, r)
    }
    await tty.send("z")
    await tty.send(KEY.enter, 30)
    expect(await p).toBe("abz")
  })
})
