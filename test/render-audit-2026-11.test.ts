// Regresi audit renderer 2026-11-12.
//
// Tiap test di sini gagal di kode SEBELUM perbaikan: satu temuan Critical
// (proyeksi pending O(n²)), empat High di primitif render (state-SGR,
// indentasi wrap, SGR opak di highlight, cap diff), satu Medium lebar tabel,
// satu Medium i18n kop sesi, dan satu Medium viewport form (dialog focusRow).
import { afterEach, describe, expect, test } from "bun:test"
import { resetLocaleState, setSessionLocale, t } from "../src/ui/i18n/locale.ts"
import { applyKey, createState } from "../src/ui/input/prompt-engine.ts"
import { markChangedWords, renderDiffCard } from "../src/ui/render/diff.ts"
import { highlightCode } from "../src/ui/render/highlight.ts"
import { sanitizeAnsiLine } from "../src/ui/render/sanitize.ts"
import { renderSessionSummary } from "../src/ui/render/session-summary.ts"
import { renderGridTable } from "../src/ui/render/table-grid.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth, truncateToWidth } from "../src/ui/render/width.ts"
import { wordWrap } from "../src/ui/render/wrap.ts"
import { dialogBox } from "../src/ui/screens/dialog.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"

afterEach(() => resetLocaleState())

// ── CRITICAL-1: pending tidak diproyeksikan ulang dari nol ──────────────────
describe("pending transcript: proyeksi baris final dimemo", () => {
  const bus = { on: () => () => {}, emit: () => {} }

  test("baris yang sudah final dipakai ULANG (identitas objek sama) antar delta", () => {
    const tr = new Transcript(bus as never)
    const line = (i: number) => `baris ${i} jawaban yang cukup panjang untuk dibungkus.\n`
    tr.stream(Array.from({ length: 12 }, (_, i) => line(i)).join(""))
    const first = tr.viewport(48, 80, 0).rows.filter((r) => r.text.trim() !== "")
    tr.stream(`${line(12)}${line(13)}`)
    const second = tr.viewport(48, 80, 0).rows.filter((r) => r.text.trim() !== "")

    // Cari baris penanda yang sudah ada sebelum delta: objek TranscriptRow
    // yang sama hanya bisa terjadi bila proyeksi baris itu tidak diulang.
    const marker = first.find((r) => r.text.includes("baris 3 "))
    expect(marker).toBeDefined()
    const reused = second.find((r) => r.text === marker!.text)
    expect(reused).toBe(marker!)
    // Sebagian besar baris lama harus terpakai ulang, bukan diproyeksikan baru.
    const shared = first.filter((r) => second.some((s) => s === r)).length
    expect(shared).toBeGreaterThanOrEqual(first.length - 1)
  })

  test("pending besar tetap satu paint yang wajar (bukan kuadratik per frame)", () => {
    const tr = new Transcript(bus as never)
    const para = "Ini satu baris jawaban panjang dengan beberapa kata dan `kode`.\n"
    tr.stream(para.repeat(Math.ceil(400_000 / para.length)).slice(0, 400_000))
    tr.viewport(80, 40, 0)
    // Delta kecil: yang mahal (proyeksi 400 KB) tak boleh diulang. Ambang longgar
    // agar tidak flaky; kode lama butuh ~650 ms untuk SATU paint ini.
    const t0 = performance.now()
    tr.stream("tambahan kecil\n")
    tr.viewport(80, 40, 0)
    expect(performance.now() - t0).toBeLessThan(400)
  })
})

// ── HIGH-7: state SGR diproses berurutan ───────────────────────────────────
describe("truncateToWidth: SGR majemuk", () => {
  test("reset-lalu-warna (`0;31`) tetap ditutup", () => {
    expect(truncateToWidth("\x1b[0;31mhi", 10)).toBe("\x1b[0;31mhi\x1b[0m")
  })
  test("warna-lalu-reset-sebagian (`39;31`) tetap ditutup", () => {
    expect(truncateToWidth("\x1b[39;31mhi", 10)).toBe("\x1b[39;31mhi\x1b[0m")
  })
  test("extended color (`38;2;…`) tidak salah dibaca sebagai reset", () => {
    expect(truncateToWidth("\x1b[38;2;255;0;0mhi", 10)).toBe("\x1b[38;2;255;0;0mhi\x1b[0m")
  })
  test("reset tunggal tidak menambah reset ekstra", () => {
    expect(truncateToWidth("\x1b[0mhi", 10)).toBe("\x1b[0mhi")
  })
})

// ── HIGH-6: indentasi jalur linear ─────────────────────────────────────────
describe("wordWrap: indentasi dipertahankan", () => {
  test("run spasi awal tidak dibuang", () => {
    const out = wordWrap(`${"    "}${"x".repeat(30)}`, 20)
    const lines = out.split("\n")
    expect(lines[0]).toBe(`    ${"x".repeat(16)}`)
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(20)
  })
  test("marker list tetap menempel pada indentasinya", () => {
    const lines = wordWrap(`  - ${"y".repeat(30)}`, 20).split("\n")
    expect(lines[0]).toBe("  -")
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(20)
  })
  test("indentasi + kata yang muat bersama tidak dipisah", () => {
    expect(wordWrap("    kata pendek", 20)).toBe("    kata pendek")
  })
})

// ── HIGH-4: SGR opak saat highlight ────────────────────────────────────────
describe("highlight: SGR tidak dipecah tokenizer", () => {
  function withTruecolor<T>(fn: () => T): T {
    const savedTty = process.stdout.isTTY
    const savedColor = process.env.COLORTERM
    const savedNoColor = process.env.NO_COLOR
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
    process.env.COLORTERM = "truecolor"
    delete process.env.NO_COLOR
    try {
      return fn()
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: savedTty, configurable: true })
      if (savedColor === undefined) delete process.env.COLORTERM
      else process.env.COLORTERM = savedColor
      if (savedNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = savedNoColor
    }
  }

  test("SGR majemuk dari model tidak menyisakan teks `1;31m`", () => {
    withTruecolor(() => {
      const out = highlightCode("\x1b[1;31mmerah\x1b[0m", "ts")
      expect(stripAnsi(out)).toBe("merah")
    })
  })

  test("truecolor `38;2;r;g;b` juga utuh", () => {
    withTruecolor(() => {
      const out = highlightCode("\x1b[38;2;255;0;0mred\x1b[0m", "ts")
      expect(stripAnsi(out)).toBe("red")
    })
  })

  test("kode sah tetap di-highlight (bukan semua dibiarkan)", () => {
    withTruecolor(() => {
      const out = highlightCode("const x = 1", "ts")
      expect(out).not.toBe("const x = 1")
      expect(stripAnsi(out)).toBe("const x = 1")
    })
  })
})

// ── HIGH-5: diff tidak kuadratik/OOM ───────────────────────────────────────
describe("diff: batas input", () => {
  const words = (n: number, suffix = "") =>
    Array.from({ length: n }, (_, i) => `w${i}${suffix}`).join(" ")

  test("LCS kata dilepas di atas batas sel (bukan alokasi ratusan MB)", () => {
    const t0 = performance.now()
    const mask = markChangedWords(words(8000), words(8000, "x"))
    expect(performance.now() - t0).toBeLessThan(200)
    // Semua token ditandai berubah → paintWords menampilkan baris polos.
    expect(mask.oldMask.every(Boolean)).toBe(true)
    expect(mask.newMask.every(Boolean)).toBe(true)
  })

  test("input raksasa dipotong dan pemotongannya TERLIHAT", () => {
    const big = "x".repeat(100_000)
    const out = stripAnsi(renderDiffCard("f.ts", big, `${big}y`, { maxLines: 12 }))
    expect(out).toContain(t("diff.truncated"))
  })

  test("diff kecil tetap normal", () => {
    const out = stripAnsi(renderDiffCard("f.ts", "a\nb\nc", "a\nB\nc", { maxLines: 12 }))
    expect(out).toContain("- b")
    expect(out).toContain("+ B")
  })
})

// ── MEDIUM-8: lebar tabel tidak pernah melebihi budget ─────────────────────
describe("tabel: grapheme lebar tidak meluap", () => {
  test("sel CJK di kolom sempit: setiap baris <= width", () => {
    const out = renderGridTable(
      { headers: ["A", "B", "C"], rows: [["漢字", "x", "y"]] },
      { width: 14, styleHeader: true, box: true },
    )
    const lines = out.split("\n")
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(14)
  })

  test("lebar lega: semua baris <= width juga", () => {
    const out = renderGridTable(
      { headers: ["A", "B"], rows: [["漢字テキスト", "nilai"]] },
      { width: 40, styleHeader: true, box: true },
    )
    for (const line of out.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(40)
  })
})

// ── MEDIUM-3: kop sesi lewat i18n ──────────────────────────────────────────
describe("session summary: locale id", () => {
  const summary = {
    sessionId: "abc",
    model: "gpt-x",
    totalTokens: 1234,
    cost: 0.01,
    durationMs: 90_000,
  }

  test("label memakai kamus id, bukan literal English", () => {
    setSessionLocale("id")
    const out = stripAnsi(renderSessionSummary(summary))
    expect(out).toContain(t("summary.session"))
    expect(out).toContain(t("summary.usage"))
    expect(out).toContain(t("summary.tokens"))
    expect(out).not.toContain("Usage")
  })

  test("locale en tetap English", () => {
    setSessionLocale("en")
    const out = stripAnsi(renderSessionSummary(summary))
    expect(out).toContain("Session")
    expect(out).toContain("Usage")
  })
})

// ── HIGH-2: dialog menggeser jendela ke baris fokus ────────────────────────
describe("dialogBox: focusRow", () => {
  const body = Array.from({ length: 12 }, (_, i) => `Field ${i}`)

  test("baris fokus di luar jendela awal tetap terlihat", () => {
    const box = dialogBox(
      { title: "T", body, minWidth: 40, maxWidth: 40, maxHeight: 10, focusRow: 11 },
      70,
      10,
    )
    expect(box.lines.some((l) => l.includes("Field 11"))).toBe(true)
    expect(box.bodyStart).toBeGreaterThan(0)
    // Kursor untuk baris fokus harus mendarat di baris isi, bukan marker/border.
    const cursorLine = box.bodyTop + (11 - box.bodyStart)
    expect(cursorLine).toBeLessThan(box.lines.length - 1)
    expect(box.lines[cursorLine]).toContain("Field 11")
  })

  test("tanpa focusRow jendela tetap dari atas (perilaku lama)", () => {
    const box = dialogBox({ title: "T", body, minWidth: 40, maxWidth: 40, maxHeight: 10 }, 70, 10)
    expect(box.bodyStart).toBe(0)
    expect(box.lines.some((l) => l.includes("Field 0"))).toBe(true)
  })
})

// ── Kebocoran render: gate sanitasi tidak boleh dilewati ───────────────────
describe("sanitize: karakter pemecah baris & C1", () => {
  test("U+2028/U+2029 jadi spasi di jalur satu-baris", () => {
    const LS = String.fromCharCode(0x2028)
    const PS = String.fromCharCode(0x2029)
    const out = sanitizeAnsiLine(`A${LS}B${PS}C`)
    expect(out).toBe("A B C")
    expect(out.includes(LS) || out.includes(PS)).toBe(false)
  })
})

describe("prompt-engine: paste tidak bisa menyuntik escape tanpa ESC", () => {
  test("U+009B (CSI C1) dibuang dari buffer composer", () => {
    const csi = String.fromCharCode(0x9b)
    const r = applyKey(createState(), { type: "char", ch: `a${csi}2Jb` }, () => [])
    expect(r.state.line).toBe("a2Jb")
  })

  test("separator Unicode menjadi baris baru, bukan karakter mentah", () => {
    const LS = String.fromCharCode(0x2028)
    const r = applyKey(createState(), { type: "char", ch: `satu${LS}dua` }, () => [])
    expect(r.state.line).toBe("satu\ndua")
    expect(r.state.line.includes(LS)).toBe(false)
  })
})
