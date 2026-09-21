// Bingkai dialog modal (src/ui/screens/dialog.ts, kontrak I11/I16): frame
// SELAYAR tepat `rows` baris, clamp kolom, fallback ASCII, judul, truncate
// defensif. Murni (tanpa IO) — deterministik penuh.
import { expect, test } from "bun:test"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { dialogBox, dialogFrame } from "../src/ui/screens/dialog.ts"

const plain = (lines: string[]) => lines.map((l) => stripAnsi(l))
const textOf = (out: string[]) => plain(out).join("\n")

test("frame tepat rows baris, judul + isi + footer muat", () => {
  const out = dialogFrame({ title: "Models", body: ["a", "b"], footer: "Esc close" }, 80, 24)
  expect(out).toHaveLength(24)
  const text = plain(out).join("\n")
  expect(text).toContain("Models")
  expect(text).toContain("a")
  expect(text).toContain("Esc close")
  for (const l of out) expect(displayWidth(stripAnsi(l))).toBeLessThanOrEqual(80)
})

test("konten CJK/emoji dipotong per kolom, SGR/surrogate utuh", () => {
  const out = dialogFrame({ title: "T", body: ["字".repeat(100), "ok"] }, 40, 12)
  expect(out).toHaveLength(12)
  for (const l of out) expect(displayWidth(stripAnsi(l))).toBeLessThanOrEqual(40)
  expect(plain(out).join("\n")).toContain("ok")
})

test("isi melebihi layar dipotong defensif + marker", () => {
  const body = Array.from({ length: 100 }, (_, i) => `baris-${i}`)
  const out = dialogFrame({ title: "T", body, footer: "f" }, 60, 12)
  expect(out).toHaveLength(12)
  // 100 isi vs jatah 12-4(chrome)-1(marker)=7 → 93 terpotong, marker tampil.
  // Border bawah tetap ada (regresi: dulu total r0+1 hingga border terbuang).
  expect(plain(out).join("\n")).toContain("93")
  expect(plain(out).join("\n")).toContain("└")
})

test("fallback ASCII tanpa MINICODE_ASCII tak ada glyph box", () => {
  const prev = process.env.MINICODE_ASCII
  process.env.MINICODE_ASCII = "1"
  try {
    const out = dialogFrame({ title: "T", body: ["x"], footer: "f" }, 40, 10)
    const text = plain(out).join("\n")
    expect(text).not.toContain("┌")
    expect(text).not.toContain("─")
    expect(text).toContain("+")
    expect(text).toContain("T")
  } finally {
    if (prev === undefined) delete process.env.MINICODE_ASCII
    else process.env.MINICODE_ASCII = prev
  }
})

test("terminal mini tak melempar, tetap rows baris", () => {
  const out = dialogFrame({ title: "T".repeat(200), body: ["x".repeat(200)] }, 10, 5)
  expect(out).toHaveLength(5)
})

test("judul kosong = tanpa baris judul (chrome menyesuaikan)", () => {
  const withTitle = dialogFrame({ title: "T", body: ["a", "b"] }, 40, 12)
  const noTitle = dialogFrame({ title: "", body: ["a", "b"] }, 40, 12)
  expect(textOf(withTitle)).toContain("T")
  expect(textOf(noTitle)).not.toContain("T")
  // Tinggi kotak = indeks border bawah − border atas + 1 (border ┌┘ tak
  // mengandung │, jadi hitung via ┌/└, bukan via │).
  const boxH = (o: string[]) => {
    const p = textOf(o).split("\n")
    return p.findIndex((l) => l.includes("└")) - p.findIndex((l) => l.includes("┌")) + 1
  }
  expect(boxH(noTitle)).toBe(boxH(withTitle) - 1)
  expect(noTitle).toHaveLength(12)
})

test("maxWidth/maxHeight mengecilkan kotak (dialog mungil)", () => {
  const out = dialogFrame({ title: "", body: ["a", "b", "c"], maxWidth: 30, maxHeight: 8 }, 100, 24)
  expect(out).toHaveLength(24)
  const p = textOf(out).split("\n")
  const top = p.findIndex((l) => l.includes("┌"))
  const bottom = p.findIndex((l) => l.includes("└"))
  // border atas + 3 isi + border bawah = 5 ≤ maxHeight 8.
  expect(bottom - top + 1).toBe(5)
  const widestBox = Math.max(...p.slice(top, bottom + 1).map((l) => displayWidth(l.trimStart())))
  expect(widestBox).toBeLessThanOrEqual(30)
  for (const l of out) expect(displayWidth(stripAnsi(l))).toBeLessThanOrEqual(100)
})

test("dialogBox: kotak saja tanpa backdrop + tanpa bayangan (popup komposit)", () => {
  const box = dialogBox({ title: "", body: ["a", "bb"] }, 80, 24)
  // 1 border + 2 isi + 1 border = 4 baris; terpusat vertikal.
  expect(box.height).toBe(4)
  expect(box.lines).toHaveLength(4)
  expect(box.topRow).toBe(Math.floor((24 - 4) / 2) + 1)
  const text = plain(box.lines).join("\n")
  expect(text).toContain("┌")
  expect(text).toContain("└")
  // Bayangan ▓ dihapus (artefak strip di Windows Terminal) — tak ada lagi.
  expect(text).not.toContain("▓")
  expect(text).not.toContain("#")
  for (const l of box.lines) expect(displayWidth(stripAnsi(l))).toBeLessThanOrEqual(80)
})

test("dialogFrame: backdrop redup ░ bukan hitam polos", () => {
  const out = dialogFrame({ title: "", body: ["x"], maxWidth: 20, maxHeight: 6 }, 40, 12)
  expect(out).toHaveLength(12)
  const p = textOf(out).split("\n")
  // Baris backdrop (di luar kotak) berisi pola shade, bukan kosong.
  const top = p.findIndex((l) => l.includes("┌"))
  expect(top).toBeGreaterThan(0)
  expect(p[0]).toContain("░")
  expect(p[p.length - 1]).toContain("░")
})

test("minWidth: kotak tak pernah lebih sempit dari minimum (geometri stabil)", () => {
  const narrow = dialogBox({ title: "", body: ["x"], minWidth: 40, maxWidth: 40 }, 100, 24)
  const wide = dialogBox({ title: "", body: ["x".repeat(50)], minWidth: 40, maxWidth: 40 }, 100, 24)
  const w = (b: typeof narrow) => displayWidth(stripAnsi(b.lines[0]!.trimStart()))
  // Konten pendek maupun panjang: lebar kotak IDENTIK (min=max=TETAP).
  expect(w(narrow)).toBe(40)
  expect(w(wide)).toBe(40)
  expect(w(narrow)).toBe(w(wide))
})

test("bodyTop: indeks body[0] = 1 border + 1 judul-bila-ada", () => {
  // Gagal-di-kode-lama: view menebak offset manual → kursor meleset 1-2
  // baris tiap judul ditambah/dihapus.
  const titled = dialogBox({ title: "T", body: ["a", "b"] }, 80, 24)
  expect(titled.bodyTop).toBe(2)
  expect(stripAnsi(titled.lines[titled.bodyTop]!)).toContain("a")
  const bare = dialogBox({ title: "", body: ["a", "b"] }, 80, 24)
  expect(bare.bodyTop).toBe(1)
  expect(stripAnsi(bare.lines[bare.bodyTop]!)).toContain("a")
})
