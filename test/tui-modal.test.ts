// Test modal popup TUI (`src/ui/tui/modal.ts` + komposit `screen.ts`) —
// asersi VISUAL via emulator grid + unit murni. Pola: rig fake TTY +
// present({modal}) → feed byte → asersi grid/kursor; byte-level (dirty-check)
// diasersi dari chunks. Kontrak I17.

import { afterEach, describe, expect, test } from "bun:test"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import {
  compositeModal,
  renderModalBox,
  stampLine,
  type TuiModalContent,
} from "../src/ui/tui/modal.ts"
import { createTuiScreen } from "../src/ui/tui/screen.ts"
import { createGridEmulator } from "./helpers/screen-grid.ts"
import { installFakeTty } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
})

function rig(rows: number, cols: number) {
  tty = installFakeTty({ rows, columns: cols })
  const grid = createGridEmulator(cols, rows)
  return {
    grid,
    feedFresh() {
      const out = tty!.chunks().join("")
      grid.feed(out)
      tty!.clear()
      return out
    },
  }
}

const input1 = ["minicode › halo"]
const cursorEnd = { line: 0, col: 16 }

function spec(over: Partial<TuiModalContent> = {}): TuiModalContent {
  return {
    title: "Model",
    rows: ["prov::m1", "prov::m2-long-name", "prov::m3"],
    selected: 1,
    footer: "↑↓ pilih · Enter ✓ · Esc batal",
    cursor: { row: 1, col: 4 },
    ...over,
  }
}

describe("modal murni: renderModalBox", () => {
  test("bingkai utuh + lebar seragam + judul", () => {
    const box = renderModalBox(spec(), 80, 24)
    for (const row of box.rows) expect(displayWidth(row)).toBe(box.width)
    const plain = box.rows.map((r) => stripAnsi(r))
    expect(plain[0]).toMatch(/^┌.*┐$/)
    expect(plain[0]).toContain("Model")
    expect(plain[plain.length - 1]).toMatch(/^└.*┘$/)
    expect(plain[1]).toContain("prov::m1")
  })

  test("baris terpilih ditandai, seleksi dijepit", () => {
    tty = installFakeTty({ rows: 24, columns: 80 })
    const box = renderModalBox(spec({ selected: 99 }), 80, 24)
    expect(stripAnsi(box.rows[3]!)).toContain("› prov::m3")
    expect(box.rows[3]!).toContain("\x1b[")
  })

  test("windowing mengikuti seleksi + indikator more", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `m${i}`)
    const box = renderModalBox(spec({ rows, selected: 29, footer: undefined }), 80, 12)
    // Kurang lebih: 12 baris viewport - 2 border - 0 footer = ~10 konten.
    expect(box.visibleCount).toBeLessThan(30)
    expect(box.offset + box.visibleCount).toBe(30)
    expect(stripAnsi(box.rows.join("\n"))).toContain("↑")
    expect(stripAnsi(box.rows.join("\n"))).toContain("m29")
  })

  test("terminal mungil: clamp tanpa panic, minimal 1 baris konten", () => {
    const box = renderModalBox(spec(), 20, 8)
    expect(box.width).toBeLessThanOrEqual(20)
    expect(box.height).toBeLessThanOrEqual(8)
    for (const row of box.rows) expect(displayWidth(row)).toBeLessThanOrEqual(20)
  })

  test("label jaringan disanitasi (SGR lewat, kontrol dibuang)", () => {
    const box = renderModalBox(
      spec({ rows: ["aman\x1b[2J\x1b[?1049hJAHAT", "\x1b[32mhijau\x1b[39m"] }),
      80,
      24,
    )
    const raw = box.rows.join("\n")
    expect(raw).not.toContain("\x1b[2J")
    expect(raw).not.toContain("\x1b[?1049h")
    expect(raw).toContain("\x1b[32m")
    expect(stripAnsi(raw)).toContain("amanJAHAT")
  })

  test("kosong: emptyText + kursor parkir aman", () => {
    const box = renderModalBox(
      spec({ rows: [], selected: 0, emptyText: "belum ada", footer: undefined }),
      80,
      24,
    )
    expect(stripAnsi(box.rows.join("\n"))).toContain("belum ada")
    expect(box.cursorRow).toBeGreaterThanOrEqual(0)
    expect(box.cursorCol).toBeGreaterThanOrEqual(0)
  })

  test("CJK dihitung 2 kolom (border tetap selaras)", () => {
    const box = renderModalBox(spec({ rows: ["模型一号模型一号模型"] }), 40, 24)
    for (const row of box.rows) expect(displayWidth(row)).toBe(box.width)
  })

  test("kursor konten dipetakan ke dalam box (border/judul diperhitungkan)", () => {
    const box = renderModalBox(spec(), 80, 24)
    // Konten baris 1 ("prov::m2-long-name"), kolom teks 4.
    // Baris box = 1 (border judul) + 1 → 2; kolom = 2 + 2 + 4 = 8.
    expect(box.cursorRow).toBe(2)
    expect(box.cursorCol).toBe(8)
  })

  test("kursor baris filter di bawah konten + offset windowing", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `m${i}`)
    const box = renderModalBox(
      {
        title: "T",
        rows,
        selected: 0,
        filter: { value: "m2", cursorCol: 2 },
        // col = offset dalam VALUE filter (tanpa label "Filter: ").
        cursor: { row: 30, col: 2 },
      },
      80,
      12,
    )
    expect(box.hasFilter).toBe(true)
    // Baris filter = 1 + visibleCount (+1 baris "… more"); kolom = 2 + 8 + 2.
    expect(box.cursorRow).toBe(1 + box.visibleCount + 1)
    expect(box.cursorCol).toBe(2 + 8 + 2)
  })
})

describe("modal murni: stampLine + compositeModal", () => {
  test("overlay menutup segmen kolom tepat", () => {
    expect(stampLine("abcdefghij", 3, "XX", 2)).toBe("abcXXfghij")
  })

  test("SGR dasar diwariskan, bukan dihitung", () => {
    const out = stampLine("\x1b[32mabcdefghij\x1b[39m", 3, "XX", 2)
    expect(stripAnsi(out)).toBe("abcXXfghij")
    expect(out).toContain("\x1b[32m")
  })

  test("wide-char terbelah batas diganti spasi (kolom selaras)", () => {
    // "a字cdef": kolom 0:a, 1-2:字, 3:c... potong di kolom 2.
    const out = stampLine("a字cdef", 2, "XX", 2)
    expect(displayWidth(out.slice(0, out.indexOf("XX")))).toBe(2)
    expect(stripAnsi(out)).toContain("XX")
  })

  test("komposit terpusat di frame", () => {
    const frame = Array.from({ length: 10 }, () => "·".repeat(30))
    const box = renderModalBox(spec({ rows: ["a"], footer: undefined }), 30, 10)
    const out = compositeModal(frame, 10, 30, box)
    expect(out).toHaveLength(10)
    const top = Math.floor((10 - box.height) / 2)
    expect(stripAnsi(out[top]!)).toContain("Model")
    // Baris di luar box tak tersentuh.
    expect(out[0]).toBe(frame[0])
    expect(out[out.length - 1]).toBe(frame[frame.length - 1])
  })
})

describe("modal via screen: present + grid", () => {
  test("popup tampil di tengah, kursor di dalam modal, input disembunyikan", () => {
    const r = rig(12, 40)
    const s = createTuiScreen()
    s.enter()
    r.feedFresh()
    s.setDocument(["doc-line-1", "doc-line-2"])
    s.present({
      status: "S",
      input: input1,
      cursor: cursorEnd,
      showCursor: true,
      modal: spec({ rows: ["prov::m1", "prov::m2"], selected: 0, footer: undefined }),
    })
    const out = r.feedFresh()
    // Border atas + judul + highlight terpilih terlihat di grid.
    const joined = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => r.grid.text(n)).join("\n")
    expect(joined).toContain("Model")
    expect(joined).toContain("prov::m1")
    expect(joined).toContain("prov::m2")
    // Kursor diparkir di baris terpilih dalam box (bukan di input).
    const cur = r.grid.cursor()
    expect(cur.r).toBeGreaterThan(1)
    expect(cur.r).toBeLessThan(12)
    // Repaint identik = NOL byte (dirty-check mencakup modal).
    expect(r.feedFresh()).toBe("")
    void out
    s.dispose()
  })

  test("modal hilang saat spec dihapus (tak ada fosil bingkai)", () => {
    const r = rig(12, 40)
    const s = createTuiScreen()
    s.enter()
    r.feedFresh()
    s.present({
      status: "S",
      input: input1,
      cursor: cursorEnd,
      showCursor: true,
      modal: spec({ rows: ["a"] }),
    })
    r.feedFresh()
    s.present({ status: "S", input: input1, cursor: cursorEnd, showCursor: true })
    const out = r.feedFresh()
    expect(out).not.toContain("┌")
    expect(out).not.toContain("└")
    s.dispose()
  })
})
