import { expect, test } from "bun:test"
import { computeLineDiff, markChangedWords, renderDiffCard } from "../src/ui/render/diff.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"

test("diff: computeLineDiff identifies added and deleted lines", () => {
  const oldText = "line 1\nline 2\nline 3"
  const newText = "line 1\nline 2 modified\nline 3\nline 4"

  const diff = computeLineDiff(oldText, newText)
  expect(diff.some((d) => d.type === "delete" && d.content === "line 2")).toBe(true)
  expect(diff.some((d) => d.type === "add" && d.content === "line 2 modified")).toBe(true)
  expect(diff.some((d) => d.type === "add" && d.content === "line 4")).toBe(true)
})

test("diff: renderDiffCard formats bordered diff output", () => {
  const oldText = "const a = 1;"
  const newText = "const a = 2;"

  const card = renderDiffCard("src/test.ts", oldText, newText)
  expect(card).toContain("src/test.ts")
  const clean = stripAnsi(card)
  expect(clean).toContain("- const a = 1;")
  expect(clean).toContain("+ const a = 2;")
})

test("diff: path & isi tak-terpercaya disanitasi (F-04)", () => {
  // \n di path dulu menjadi baris diff palsu; ESC[2J lolos via cut.
  const card = renderDiffCard("a.ts\n+ EVIL\x1b[2J", "lama\x1b[2J", "baru")
  expect(card).not.toContain("\x1b[2J")
  // EVIL hanya di baris judul (satu baris), bukan baris diff palsu.
  expect(card.split("\n").filter((l) => l.includes("EVIL")).length).toBe(1)
  expect(stripAnsi(card)).toContain("a.ts")
})

// ── Temuan bug-hunter UI ────────────────────────────────────────────────────

// Baris diff sepanjang baris kode aslinya. Tanpa batas, satu baris 300 karakter
// membungkus sendiri di terminal dan merusak frame TUI yang menghitung tinggi
// per baris.
test("diff: baris panjang dipotong ke lebar terminal", () => {
  const card = renderDiffCard("f.ts", "x", "y".repeat(300), { width: 80 })
  for (const line of stripAnsi(card).split("\n")) {
    expect(displayWidth(line)).toBeLessThanOrEqual(80)
  }
})

test("diff: lebar bisa ditentukan pemanggil", () => {
  const card = renderDiffCard("f.ts", "x", "y".repeat(300), { width: 40 })
  for (const line of stripAnsi(card).split("\n")) {
    expect(displayWidth(line)).toBeLessThanOrEqual(40)
  }
})

test("diff: path panjang juga dipotong", () => {
  const card = renderDiffCard(`src/${"sub/".repeat(50)}a.ts`, "x", "y", { width: 60 })
  const first = stripAnsi(card).split("\n")[0]!
  expect(displayWidth(first)).toBeLessThanOrEqual(60)
})

test("diff: CJK dalam diff dihitung per kolom", () => {
  const card = renderDiffCard("f.ts", "旧", "新".repeat(60), { width: 40 })
  for (const line of stripAnsi(card).split("\n")) {
    expect(displayWidth(line)).toBeLessThanOrEqual(40)
  }
})

test("diff: tanpa perubahan memberi pesan", () => {
  expect(stripAnsi(renderDiffCard("f.ts", "sama", "sama"))).toContain("no changes")
})

test("diff: maxLines membatasi jumlah baris + ringkasan sisa", () => {
  const oldT = Array.from({ length: 40 }, (_, i) => `baris ${i}`).join("\n")
  const newT = Array.from({ length: 40 }, (_, i) => `ubah ${i}`).join("\n")
  const card = stripAnsi(renderDiffCard("f.ts", oldT, newT, { maxLines: 5 }))
  const lines = card.split("\n")
  expect(lines.length).toBeLessThanOrEqual(7) // path + 5 baris + ringkasan
  expect(card).toContain("...")
})

test("diff: berkas kosong tidak melempar", () => {
  for (const [o, n] of [
    ["", ""],
    ["", "baru"],
    ["lama", ""],
    ["\n", "\n\n"],
  ]) {
    expect(() => renderDiffCard("f.ts", o!, n!)).not.toThrow()
  }
})

test("diff: berkas besar tidak kuadratik", () => {
  const n = 2000
  const oldT = Array.from({ length: n }, (_, i) => `baris ${i}`).join("\n")
  const newT = Array.from({ length: n }, (_, i) => (i === n - 1 ? "diubah" : `baris ${i}`)).join(
    "\n",
  )
  const t0 = performance.now()
  computeLineDiff(oldT, newT)
  expect(performance.now() - t0).toBeLessThan(2000)
})

test("diff: reorder ambigu dahulukan add (lebih sedikit op)", () => {
  // Lama ["a","b"] vs baru ["b","a","b"]: kode lama menghapus "a" dulu
  // (4 op: del,ctx,add,add); heuristik dua sisi menambah "b" dulu (3 op).
  const diff = computeLineDiff("a\nb", "b\na\nb")
  expect(diff.length).toBe(3)
  expect(diff[0]).toMatchObject({ type: "add", content: "b" })
})

test("diff: kata berubah ditandai, bukan sebaris penuh", () => {
  const { oldMask, newMask } = markChangedWords("const a = 1", "const a = 2")
  // Token: const|sp|a|sp|=|sp|1 — hanya token terakhir beda.
  expect(oldMask).toEqual([false, false, false, false, false, false, true])
  expect(newMask).toEqual([false, false, false, false, false, false, true])
})

test("diff: baris yang hampir seluruhnya beda tampil polos", () => {
  const card = stripAnsi(renderDiffCard("f.ts", "aaa bbb", "xxx yyy"))
  expect(card).toContain("aaa bbb")
  expect(card).toContain("xxx yyy")
})

test("diff: kata berubah di-bold di card (COLORTERM truecolor)", () => {
  const prevCt = process.env.COLORTERM
  const prevNc = process.env.NO_COLOR
  process.env.COLORTERM = "truecolor"
  delete process.env.NO_COLOR
  // Warna digate stdout.isTTY — stub TTY agar yang diuji palet, bukan gate.
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  try {
    const card = renderDiffCard("f.ts", "const a = 1", "const a = 2")
    expect(card).toContain("const a = ")
    expect(card).toContain("\x1b[1m2\x1b[22m")
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
    if (prevCt == null) delete process.env.COLORTERM
    else process.env.COLORTERM = prevCt
    if (prevNc == null) delete process.env.NO_COLOR
    else process.env.NO_COLOR = prevNc
  }
})
