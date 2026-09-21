// Siklus alternate-screen modal (src/ui/runtime/screen.ts, kontrak I16):
// enter/exit SELALU berpasangan (termasuk nested + exception), null-screen
// nol byte + fail-closed di non-TTY/dumb.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { altScreenDepth, openAltScreen, resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined
beforeEach(() => {
  // Isolasi antar-file: view lain yang gagal di tengah test bisa meninggalkan
  // depth > 0 (enter tanpa close) sehingga open() berikutnya terlihat nested
  // dan tak menulis ENTER fisik. Reset eksplisit, bukan mengandalkan urutan.
  resetAltScreenDepth()
})
afterEach(() => {
  tty?.restore()
  tty = undefined
})

test("open/close berpasangan: 1049h lalu 1049l tepat sekali", () => {
  tty = installFakeTty({ columns: 80, rows: 24 })
  const s = openAltScreen()
  expect(s.ok).toBe(true)
  expect(s.cols).toBe(80)
  expect(s.rows).toBe(24)
  s.paint(["hello"])
  s.close()
  const out = tty.all()
  expect(out).toContain("\x1b[?1049h")
  expect(out).toContain("\x1b[?1049l")
  expect(out.indexOf("\x1b[?1049h")).toBeLessThan(out.indexOf("\x1b[?1049l"))
  // Idempoten: close ganda tak menulis exit ganda.
  s.close()
  expect(tty.all().split("\x1b[?1049l").length - 1).toBe(1)
})

test("nested: enter fisik sekali, exit di lapis terluar", () => {
  tty = installFakeTty({ columns: 80, rows: 24 })
  const outer = openAltScreen()
  const inner = openAltScreen()
  expect(outer.ok && inner.ok).toBe(true)
  expect(altScreenDepth()).toBe(2)
  inner.close()
  expect(altScreenDepth()).toBe(1)
  expect(tty.all()).not.toContain("\x1b[?1049l")
  outer.close()
  expect(altScreenDepth()).toBe(0)
  expect(tty.all()).toContain("\x1b[?1049l")
})

test("non-TTY = null-screen: ok false, paint/close nol byte", () => {
  tty = installFakeTty({ isTTY: false })
  const s = openAltScreen()
  expect(s.ok).toBe(false)
  s.paint(["hello"])
  s.close()
  expect(tty.all()).toBe("")
  expect(tty.allErr()).toBe("")
})

test("TERM=dumb = null-screen", () => {
  // Mutasi TERM manual DILARANG di sini: install di bawah menangkap env saat
  // itu sebagai "ambient", sehingga restore() afterEach menghidupkan lagi
  // nilai transient ke file test berikutnya (bug nyata: tui-app gagal massal
  // setelah file ini). Simulasi dumb milik harness (vt:false) yang menulis
  // SETELAH menangkap ambient sehingga restore selalu benar.
  tty = installFakeTty({ vt: false })
  const s = openAltScreen()
  expect(s.ok).toBe(false)
  s.paint(["x"])
  s.close()
  expect(tty.all()).toBe("")
})

test("paint tak pernah melempar walau stdout rusak", () => {
  tty = installFakeTty()
  const s = openAltScreen()
  const orig = process.stdout.write
  process.stdout.write = (() => {
    throw new Error("rusak")
  }) as never
  try {
    expect(() => s.paint(["x"])).not.toThrow()
    expect(() => s.close()).not.toThrow()
  } finally {
    process.stdout.write = orig
  }
})

test("paintRegion: tulis region tanpa clear — konten luar tak tersentuh", () => {
  tty = installFakeTty({ columns: 40, rows: 10 })
  const s = openAltScreen()
  s.paintRegion(["kotak-1", "kotak-2"], 4)
  s.close()
  const out = tty.all()
  // Cursor-addressed per baris + hapus-baris, TANPA clear layar / HOME+2J.
  expect(out).toContain("\x1b[4;1H\x1b[2Kkotak-1")
  expect(out).toContain("\x1b[5;1H\x1b[2Kkotak-2")
  expect(out).not.toContain("\x1b[2J")
  // Enter/exit alt-screen tetap berpasangan.
  expect(out).toContain("\x1b[?1049h")
  expect(out).toContain("\x1b[?1049l")
})

test("paintRegion: render menyusut/bergeser membersihkan sisa (tanpa hantu)", () => {
  tty = installFakeTty({ columns: 40, rows: 12 })
  const s = openAltScreen()
  s.paintRegion(["baris-a", "baris-b", "baris-c", "baris-d"], 3)
  // Kotak baru lebih pendek + posisi beda (simulasi filter menyusut).
  s.paintRegion(["kecil-1"], 5)
  s.close()
  const frame = tty.screen().join("\n")
  expect(frame).toContain("kecil-1")
  expect(frame).not.toContain("baris-a")
  expect(frame).not.toContain("baris-d")
})

test("clearRegion: tutup menghapus area popup sendiri", () => {
  tty = installFakeTty({ columns: 40, rows: 12 })
  const s = openAltScreen()
  s.paintRegion(["sementara-1", "sementara-2"], 4)
  s.clearRegion()
  s.close()
  const frame = tty.screen().join("\n")
  expect(frame).not.toContain("sementara-1")
  expect(frame).not.toContain("sementara-2")
})

test("paintRegion([]) = no-op murni (bukan clear, bukan lacak)", () => {
  tty = installFakeTty({ columns: 40, rows: 12 })
  const s = openAltScreen()
  s.paintRegion(["tetap"], 4)
  s.paintRegion([], 4)
  s.close()
  // Baris lama utuh (tak terhapus), tak ada byte EL/CUP tambahan.
  expect(tty.screen().join("\n")).toContain("tetap")
  const cups = tty.all().split("\x1b[4;1H").length - 1
  expect(cups).toBe(1)
})
