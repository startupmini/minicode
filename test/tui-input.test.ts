// Test kotak input TUI (`src/ui/tui/input.ts`): state machine murni, tanpa
// TTY. Semantik HARUS identik dengan askLine (lihat komentar di sumber):
// tiap test di sini adalah cermin perilaku REPL linier di dunia TUI.

import { describe, expect, test } from "bun:test"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { createTuiInput } from "../src/ui/tui/input.ts"

const enc = new TextEncoder()
const PROMPT = "minicode › "

function box(history: string[] = ["h1", "h2"]) {
  return createTuiInput({
    prompt: PROMPT,
    history,
    complete: (q) =>
      q.startsWith("/") ? ["/help", "/history"].filter((c) => c.startsWith(q)) : [],
  })
}

function text(b: ReturnType<typeof box>, maxCols = 80) {
  return b.render(maxCols)
}

describe("tui input: scroll transkrip", () => {
  test("PageUp/PageDown jadi event scroll, state input utuh", () => {
    // Gagal di kode lama: PgUp jatuh ke catch-all "esc" (batal pada baris
    // kosong!) atau applyKey me-return undefined → crash `r.state`.
    const b = box()
    b.feed(enc.encode("draf"))
    expect(b.feed(enc.encode("\x1b[5~"))).toEqual([{ type: "scroll", dir: -1 }])
    expect(b.feed(enc.encode("\x1b[6~"))).toEqual([{ type: "scroll", dir: 1 }])
    expect(b.line).toBe("draf")
  })
})

describe("tui input: ketik + submit + cancel", () => {
  test("ketik lalu Enter = submit ter-trim", () => {
    const b = box()
    // Satu event render per keypress (driver me-repaint sekali per batch).
    const evs = b.feed(enc.encode("halo "))
    expect(evs).toHaveLength(5)
    expect(evs.every((e) => e.type === "render")).toBe(true)
    const ev = b.feed(enc.encode("\r"))
    expect(ev).toEqual([{ type: "submit", line: "halo" }])
    expect(b.line).toBe("halo ")
  })

  test("Enter kosong = submit string kosong (bukan cancel)", () => {
    const b = box()
    expect(b.feed(enc.encode("\r"))).toEqual([{ type: "submit", line: "" }])
  })

  test("Ctrl+C = cancel; Esc baris kosong = cancel", () => {
    expect(box().feed(enc.encode("\x03"))).toEqual([{ type: "cancel" }])
    expect(box().feed(enc.encode("\x04"))).toEqual([{ type: "cancel" }])
    expect(box().feed(enc.encode("\x1b"))).toEqual([{ type: "cancel" }])
  })

  test("Esc pada baris berisi TIDAK cancel (draf aman)", () => {
    const b = box()
    b.feed(enc.encode("draf"))
    expect(b.feed(enc.encode("\x1b"))).toEqual([])
    expect(b.line).toBe("draf")
  })

  test("reset mengosongkan baris + history-browse", () => {
    const b = box()
    b.feed(enc.encode("x"))
    b.reset()
    expect(b.line).toBe("")
    expect(b.feed(enc.encode("\r"))).toEqual([{ type: "submit", line: "" }])
  })
})

describe("tui input: history seperti shell", () => {
  test("Up = terbaru dulu; Down kembali ke draf tersimpan", () => {
    const b = box()
    b.feed(enc.encode("draf"))
    b.feed(enc.encode("\x1b[A"))
    expect(b.line).toBe("h2")
    b.feed(enc.encode("\x1b[A"))
    expect(b.line).toBe("h1")
    // Mentok atas: tetap (tanpa event).
    expect(b.feed(enc.encode("\x1b[A"))).toEqual([])
    expect(b.line).toBe("h1")
    b.feed(enc.encode("\x1b[B"))
    expect(b.line).toBe("h2")
    b.feed(enc.encode("\x1b[B"))
    expect(b.line).toBe("draf")
  })

  test("tanpa history: panah diam", () => {
    const b = box([])
    expect(b.feed(enc.encode("\x1b[A"))).toEqual([])
    expect(b.line).toBe("")
  })

  test("mengetik setelah recall memutus history", () => {
    const b = box()
    b.feed(enc.encode("\x1b[A"))
    expect(b.line).toBe("h2")
    b.feed(enc.encode("!"))
    expect(b.line).toBe("h2!")
    // Navigasi mulai lagi dari terbaru (bukan lanjut ke h1).
    b.feed(enc.encode("\x1b[A"))
    expect(b.line).toBe("h2")
  })
})

describe("tui input: dropdown slash", () => {
  test('"/" membuka menu; Down+Enter memilih → submit pilihan', () => {
    const b = box()
    b.feed(enc.encode("/"))
    let r = text(b)
    const plain = r.lines.map((l) => stripAnsi(l)).join("\n")
    expect(plain).toContain("/help")
    expect(plain).toContain("/history")
    // Belum ada yang dipilih.
    expect(plain).not.toContain("› /help")
    b.feed(enc.encode("\x1b[B"))
    r = text(b)
    expect(r.lines.map((l) => stripAnsi(l)).join("\n")).toContain("› /help")
    expect(b.feed(enc.encode("\r"))).toEqual([{ type: "submit", line: "/help" }])
  })

  test("Esc menutup menu dulu (bukan cancel); filter menyempitkan", () => {
    const b = box()
    b.feed(enc.encode("/he"))
    expect(
      text(b)
        .lines.map((l) => stripAnsi(l))
        .join("\n"),
    ).toContain("/help")
    expect(
      text(b)
        .lines.map((l) => stripAnsi(l))
        .join("\n"),
    ).not.toContain("/history")
    // Esc pertama: tutup menu, tetap editing.
    expect(b.feed(enc.encode("\x1b"))).toEqual([{ type: "render" }])
    expect(b.line).toBe("/he")
    // Esc kedua pada baris berisi: diam (draf aman).
    expect(b.feed(enc.encode("\x1b"))).toEqual([])
  })
})

describe("tui input: kunci driver diteruskan mentah", () => {
  test("tab/shift-tab/ctrl-o/ctrl-t/ctrl-n tak mengubah state", () => {
    const b = box()
    b.feed(enc.encode("ab"))
    for (const bytes of ["\x09", "\x1b[Z", "\x0f", "\x14", "\x0e"]) {
      const ev = b.feed(enc.encode(bytes))
      expect(ev).toEqual([
        { type: "key", key: expect.objectContaining({ type: expect.any(String) }) },
      ])
    }
    expect(b.line).toBe("ab")
  })
})

describe("tui input: reverse-i-search", () => {
  test("Ctrl+R → ketik → Enter menerima cocok terbaru", () => {
    const b = box(["git status", "git diff", "bun test"])
    expect(b.feed(enc.encode("\x12"))).toEqual([{ type: "render" }])
    let r = text(b)
    expect(stripAnsi(r.lines[0] ?? "")).toContain("(reverse-i-search)")
    b.feed(enc.encode("git"))
    r = text(b)
    // Terbaru dulu: "git diff" sebelum "git status".
    expect(stripAnsi(r.lines[0] ?? "")).toContain("git diff")
    b.feed(enc.encode("\x1b[A")) // lebih tua
    r = text(b)
    expect(stripAnsi(r.lines[0] ?? "")).toContain("git status")
    b.feed(enc.encode("\x1b[B")) // kembali muda
    b.feed(enc.encode("\r")) // terima
    expect(b.line).toBe("git diff")
    // Keluar dari mode search: ketik normal lagi.
    b.feed(enc.encode("!"))
    expect(b.line).toBe("git diff!")
  })

  test("Esc/Ctrl+C membatalkan tanpa mengubah draf", () => {
    const b = box(["h1"])
    b.feed(enc.encode("draf"))
    b.feed(enc.encode("\x12"))
    b.feed(enc.encode("h"))
    expect(b.feed(enc.encode("\x1b"))).toEqual([{ type: "render" }])
    expect(b.line).toBe("draf")
    b.feed(enc.encode("\x12"))
    expect(b.feed(enc.encode("\x03"))).toEqual([{ type: "render" }])
    expect(b.line).toBe("draf")
  })

  test("tanpa cocok: Enter kembali ke draf", () => {
    const b = box(["h1"])
    b.feed(enc.encode("\x12"))
    b.feed(enc.encode("zzz"))
    expect(stripAnsi(text(b).lines[0] ?? "")).toContain("(no match)")
    b.feed(enc.encode("\r"))
    expect(b.line).toBe("")
  })

  test("tombol lain keluar search lalu diproses normal", () => {
    const b = box(["h1"])
    b.feed(enc.encode("\x12"))
    // Kiri bukan tombol search → keluar search, lalu jalan sebagai biasa.
    b.feed(enc.encode("\x1b[D"))
    b.feed(enc.encode("x"))
    expect(b.line).toBe("x")
  })
})

describe("tui input: multiline + kursor kolom", () => {
  test("Ctrl+J menyisipkan newline; kursor di baris kedua", () => {
    const b = box()
    b.feed(enc.encode("x"))
    b.feed(enc.encode("\x0a"))
    b.feed(enc.encode("y"))
    const r = text(b)
    expect(r.lines[0]).toBe(`${PROMPT}x`)
    expect(r.lines[1]).toBe("y")
    expect(r.cursorLine).toBe(1)
    expect(r.cursorCol).toBe(1)
  })

  test("kolom kursor menghitung prefix + CJK", () => {
    const b = box()
    b.feed(enc.encode("abあ"))
    const r = text(b)
    // "minicode › " = 11 kolom + a(1) + b(1) + あ(2) = 15.
    expect(r.cursorLine).toBe(0)
    expect(r.cursorCol).toBe(15)
  })

  test("emoji terbelah antar chunk tetap satu char (streaming decoder)", () => {
    const b = box()
    const bytes = enc.encode("😀")
    expect(b.feed(bytes.slice(0, 2))).toEqual([])
    expect(b.feed(bytes.slice(2))).toEqual([{ type: "render" }])
    expect(b.line).toBe("😀")
    expect(text(b).lines[0]).toBe(`${PROMPT}😀`)
  })

  test("grapheme Thai terhapus bertahap (aturan engine)", () => {
    const b = box()
    // U+0E19 U+0E49 U+0E33: satu suku kata, hapus per diakritik.
    b.feed(enc.encode("กิำ"))
    const before = b.line
    b.feed(enc.encode("\x7f"))
    expect(b.line.length).toBeLessThan(before.length)
    expect(b.line.length).toBeGreaterThan(0)
  })
})
