import { expect, test } from "bun:test"
import { renderTable } from "../src/ui/render/table.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"

test("table: renders empty state", () => {
  const table = renderTable([{ header: "Name", key: "name" }], [])
  expect(stripAnsi(table)).toContain("(no entries)")
})

test("table: renders headers and aligned data rows", () => {
  const columns = [
    { header: "ID", key: "id", width: 8 },
    { header: "Score", key: "score", width: 6, align: "right" as const },
  ]
  const data = [
    { id: "item1", score: 95 },
    { id: "item2", score: 100 },
  ]

  const table = renderTable(columns, data)
  const clean = stripAnsi(table)
  expect(clean).toContain("ID")
  expect(clean).toContain("Score")
  expect(clean).toContain("item1")
  expect(clean).toContain("95")
  expect(clean).toContain("item2")
  expect(clean).toContain("100")
})

// Regresi: `width` dulu hanya MINIMUM, jadi satu nilai panjang melebarkan kolom
// dan header berhenti berbaris dengan body (nyata di `config list`).
test("table: width adalah batas keras, kolom tetap berbaris", () => {
  const columns = [
    { header: "Provider ID", key: "id", width: 14 },
    { header: "Base URL", key: "url", width: 20 },
  ]
  const data = [
    { id: "pendek", url: "https://a" },
    { id: "free-empero-org-v1-bkin-yang-panjang", url: "https://contoh.example.com/v1/endpoint" },
  ]
  const lines = stripAnsi(renderTable(columns, data)).split("\n")
  // Semua baris (separator, header, body) punya lebar tampak identik.
  const widths = new Set(lines.map((l) => l.length))
  expect(widths.size).toBe(1)
  // Nilai kepanjangan dipotong dengan elipsis, tidak melebarkan kolom.
  expect(lines.some((l) => l.includes("\u2026"))).toBe(true)
  // Tiap sel " isi " (width+2), antar sel satu spasi: 16 + 1 + 22 = 39.
  for (const line of lines) expect(line.length).toBe(14 + 2 + 1 + 20 + 2)
})

test("table: tanpa width kolom menyesuaikan isi terpanjang", () => {
  const table = renderTable([{ header: "N", key: "n" }], [{ n: "a" }, { n: "panjang sekali" }])
  expect(stripAnsi(table)).toContain("panjang sekali")
})

test("table: nilai berwarna tetap sejajar (ANSI tidak dihitung)", () => {
  const colored = "\x1b[36mabc\x1b[39m"
  const lines = stripAnsi(
    renderTable([{ header: "H", key: "v", width: 6 }], [{ v: colored }, { v: "xy" }]),
  ).split("\n")
  const widths = new Set(lines.map((l) => l.length))
  expect(widths.size).toBe(1)
})

// ── Temuan bug-hunter UI ────────────────────────────────────────────────────

// Satu newline dalam nilai memecah baris tabel jadi dua dan menggeser seluruh
// kolom sesudahnya. Nilai datang dari config/frontmatter — bisa berisi apa pun.
test("table: newline dalam nilai tidak memecah baris", () => {
  const out = renderTable([{ header: "H", key: "v", width: 10 }], [{ v: "a\nb" }])
  const lines = stripAnsi(out).split("\n")
  expect(lines.length).toBe(3) // separator + header + 1 baris data
  expect(lines[2]).toContain("a b")
})

test("table: tab dan carriage return juga dinormalkan", () => {
  const out = renderTable([{ header: "H", key: "v", width: 12 }], [{ v: "a\tb\r\nc" }])
  const lines = stripAnsi(out).split("\n")
  expect(lines.length).toBe(3)
  expect(new Set(lines.map((l) => l.length)).size).toBe(1)
})

// `"".repeat(-5)` melempar RangeError; width datang dari pemanggil.
test("table: width negatif atau NaN tidak melempar", () => {
  for (const w of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => renderTable([{ header: "H", key: "v", width: w }], [{ v: "abc" }])).not.toThrow()
  }
})

test("table: tanpa kolom memberi pesan, bukan melempar", () => {
  expect(stripAnsi(renderTable([], [{ v: "x" }]))).toContain("no columns")
})

// CJK memakan dua kolom; tabel harus tetap berbaris di terminal sungguhan.
test("table: CJK sejajar per KOLOM terminal, bukan per karakter", () => {
  const lines = stripAnsi(
    renderTable([{ header: "Nama", key: "v", width: 10 }], [{ v: "这是中文" }, { v: "abcd" }]),
  ).split("\n")
  // displayWidth semua baris identik (bukan .length, karena CJK 1 char = 2 kolom)
  const widths = new Set(lines.map((l) => displayWidth(l)))
  expect(widths.size).toBe(1)
})

test("table: emoji tidak melebihi lebar kolom", () => {
  const lines = stripAnsi(
    renderTable([{ header: "H", key: "v", width: 8 }], [{ v: "😀😀😀😀😀😀" }]),
  ).split("\n")
  for (const l of lines) expect(displayWidth(l)).toBe(10) // 8 + 2 spasi bantalan
})

test("table: terminal sempit + banyak kolom jadi vertikal, bukan elipsis", () => {
  const prev = process.stdout.columns
  Object.defineProperty(process.stdout, "columns", { value: 20, configurable: true })
  try {
    const out = stripAnsi(
      renderTable(
        [
          { header: "ID", key: "id" },
          { header: "Model", key: "m" },
          { header: "URL", key: "u" },
          { header: "Status", key: "s" },
        ],
        [{ id: "gw", m: "m1", u: "https://x", s: "ok" }],
      ),
    )
    expect(out).toContain("ID: gw")
    expect(out).toContain("Status: ok")
    expect(out).not.toContain("…")
  } finally {
    Object.defineProperty(process.stdout, "columns", { value: prev, configurable: true })
  }
})

test("table: fallback vertikal tak melebihi lebar terminal (header ikut dihitung)", () => {
  // Audit TUI P1-6: kode lama memotong value ke termW PENUH lalu menambah
  // "header: " di depan → baris pasti > termW dan wrap sendiri.
  const prev = process.stdout.columns
  Object.defineProperty(process.stdout, "columns", { value: 20, configurable: true })
  try {
    const out = stripAnsi(
      renderTable(
        [
          { header: "ID", key: "id" },
          { header: "Model", key: "m" },
          { header: "URL", key: "u" },
          { header: "Status", key: "s" },
        ],
        [{ id: "gw", m: "model-sangat-panjang-xxxxx", u: "https://example.com/abc", s: "ok" }],
      ),
    )
    for (const line of out.split("\n")) {
      if (!line) continue
      expect(displayWidth(line)).toBeLessThanOrEqual(20)
    }
  } finally {
    Object.defineProperty(process.stdout, "columns", { value: prev, configurable: true })
  }
})
