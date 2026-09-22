// Test driver layar TUI (`src/ui/tui/screen.ts`) — asersi VISUAL via
// emulator grid (bukan byte). Pola: tulis lewat screen (fake TTY) → feed
// byte baru ke emulator → asersi grid/kursor/alt. Byte-level (zero-byte,
// sekuens enter/leave) tetap diasersi langsung dari chunks.

import { afterEach, describe, expect, test } from "bun:test"
import { createTuiScreen } from "../src/ui/tui/screen.ts"
import { createGridEmulator } from "./helpers/screen-grid.ts"
import { installFakeTty } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
})

interface Rig {
  grid: ReturnType<typeof createGridEmulator>
  feedFresh(): string
}

function rig(rows: number, cols: number): Rig {
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

describe("tui screen: enter/leave", () => {
  test("status CHA (rata kanan footer) bertahan melewati truncate screen", () => {
    // Kontrak I13/I16: footer merapatkan konteks via CHA `ESC[nG`; screen
    // men-truncate tiap baris — CHA wajib selamat, kalau tidak konteks
    // kehilangan posisi rata kanannya (regresi senyap).
    const r = rig(8, 40)
    const s = createTuiScreen()
    s.enter()
    r.feedFresh()
    s.present({
      status: "abc\x1b[11G14.2k",
      input: input1,
      cursor: cursorEnd,
      showCursor: true,
    })
    r.feedFresh()
    // Baris status = baris terakhir (8); konteks mendarat di kolom 11 (CHA).
    expect(r.grid.text(8).indexOf("14.2k")).toBe(10)
    s.dispose()
  })

  test("baris dokumen/input disanitasi (SGR lewat, kontrol dibuang)", () => {
    // Jaring terakhir screen: sisa kontrol dari regresi writer (mis. alur
    // capture) tak boleh sampai ke terminal. Status dikecualikan (CHA).
    const r = rig(8, 40)
    const s = createTuiScreen()
    s.enter()
    r.feedFresh()
    s.setDocument(["aman\x1b[2J\x1b[?1049hJAHAT", "\x1b[32mhijau\x1b[39m"])
    s.present({ status: "S", input: input1, cursor: cursorEnd, showCursor: true })
    const out = r.feedFresh()
    expect(out).not.toContain("\x1b[2J")
    expect(out).not.toContain("\x1b[?1049h")
    expect(out).toContain("\x1b[32m")
    expect(r.grid.text(5)).toContain("amanJAHAT")
    expect(r.grid.text(6)).toContain("hijau")
    s.dispose()
  })

  test("baris ber-tab diekspan agar tak meluap viewport", () => {
    // Terminal mengekspan tab ke tab-stop; displayWidth menghitung 0 — tanpa
    // ekspansi, baris kode ber-tab membungkus liar dan merusak grid.
    const r = rig(8, 20)
    const s = createTuiScreen()
    s.enter()
    r.feedFresh()
    s.setDocument(["\tindented", "a\tb"])
    s.present({ status: "S", input: input1, cursor: cursorEnd, showCursor: true })
    r.feedFresh()
    expect(r.grid.text(5)).toBe("        indented")
    expect(r.grid.text(6)).toBe("a       b")
    s.dispose()
  })

  test("enter: ?1049h sekali, grid bersih, idempoten", () => {
    const r = rig(10, 40)
    const s = createTuiScreen()
    s.enter()
    const out = r.feedFresh()
    expect(out).toContain("\x1b[?1049h")
    expect(r.grid.altActive()).toBe(true)
    expect(r.grid.text(1)).toBe("")
    s.enter()
    expect(r.feedFresh()).toBe("")
    s.dispose()
  })

  test("leave: ?1049l + kembalikan buffer main, idempoten", () => {
    const r = rig(10, 40)
    // Konten shell sebelum masuk (di luar alt-screen).
    r.grid.feed("PS C:\\>\r\n")
    const s = createTuiScreen()
    s.enter()
    r.feedFresh()
    s.setDocument(["a"])
    s.present({ status: "S", input: input1, cursor: cursorEnd, showCursor: true })
    r.feedFresh()
    expect(r.grid.altActive()).toBe(true)
    s.leave()
    const out = r.feedFresh()
    expect(out).toContain("\x1b[?1049l")
    expect(r.grid.altActive()).toBe(false)
    expect(r.grid.text(1)).toBe("PS C:\\>")
    s.leave()
    expect(r.feedFresh()).toBe("")
    s.dispose()
  })

  test("dispose tanpa enter: nol byte", () => {
    rig(10, 40)
    const s = createTuiScreen()
    s.dispose()
    expect(tty!.chunks().join("")).toBe("")
  })
})

describe("tui screen: layout viewport", () => {
  test("transkrip jangkar-bawah + input + status TERAKHIR", () => {
    const r = rig(10, 40)
    const s = createTuiScreen()
    s.enter()
    s.setDocument(["a", "b", "c"])
    s.present({ status: "STATUS", input: input1, cursor: cursorEnd, showCursor: true })
    r.feedFresh()
    // Transkrip 8 baris (1..8): dokumen 3 baris di 6,7,8; atas kosong.
    // Input baris 9, STATUS baris 10 (jangkar bawah permanen).
    expect(r.grid.text(1)).toBe("")
    expect(r.grid.text(5)).toBe("")
    expect(r.grid.text(6)).toBe("a")
    expect(r.grid.text(7)).toBe("b")
    expect(r.grid.text(8)).toBe("c")
    expect(r.grid.text(9)).toBe("minicode › halo")
    expect(r.grid.text(10)).toBe("STATUS")
    expect(r.grid.cursor()).toEqual({ r: 9, c: 16 })
  })

  test("input multiline tumbuh ke atas, status/input kekal posisi", () => {
    const r = rig(10, 40)
    const s = createTuiScreen()
    s.enter()
    s.setDocument(["x"])
    const input = ["l1", "l2", "l3"]
    s.present({ status: "S", input, cursor: { line: 2, col: 3 }, showCursor: true })
    r.feedFresh()
    // R=10, input 3 baris → input 7,8,9; STATUS 10; "x" di dasar transkrip.
    expect(r.grid.text(5)).toBe("")
    expect(r.grid.text(6)).toBe("x")
    expect(r.grid.text(7)).toBe("l1")
    expect(r.grid.text(8)).toBe("l2")
    expect(r.grid.text(9)).toBe("l3")
    expect(r.grid.text(10)).toBe("S")
    expect(r.grid.cursor()).toEqual({ r: 9, c: 3 })
  })

  test("layar mungil tak crash + selalu penuh", () => {
    const r = rig(4, 20)
    const s = createTuiScreen()
    s.enter()
    s.setDocument(["a", "b", "c", "d", "e"])
    s.present({
      status: "S",
      input: ["i1", "i2", "i3", "i4", "i5"],
      cursor: { line: 4, col: 1 },
      showCursor: true,
    })
    r.feedFresh()
    // R=4: input ambil ekor 2 baris (i4,i5) → input 2,3; STATUS 4; transkrip 1.
    expect(r.grid.rows()).toBe(4)
    expect(r.grid.text(1)).toBe("e")
    expect(r.grid.text(2)).toBe("i4")
    expect(r.grid.text(3)).toBe("i5")
    expect(r.grid.text(4)).toBe("S")
    s.dispose()
  })
})

describe("tui screen: dirty diff + resize", () => {
  test("present identik: nol byte", () => {
    rig(10, 40)
    const s = createTuiScreen()
    s.enter()
    s.setDocument(["a"])
    const p = { status: "S", input: input1, cursor: cursorEnd, showCursor: true }
    s.present(p)
    tty!.clear()
    s.present(p)
    expect(tty!.chunks().join("")).toBe("")
    s.dispose()
  })

  test("hanya baris berubah yang ditulis ulang", () => {
    rig(10, 40)
    const s = createTuiScreen()
    s.enter()
    s.setDocument(["a"])
    s.present({ status: "S1", input: input1, cursor: cursorEnd, showCursor: true })
    tty!.clear()
    // Status di baris 10 (terakhir) → tepat satu CUP ke baris 10.
    s.present({ status: "S2", input: input1, cursor: cursorEnd, showCursor: true })
    const out = tty!.chunks().join("")
    expect(out.split("\x1b[10;1H").length - 1).toBe(1)
    expect(out).not.toContain("\x1b[9;1H")
    s.dispose()
  })

  test("resize: invalidate + present me-relayout penuh tanpa fosil", () => {
    const r = rig(10, 40)
    const s = createTuiScreen()
    s.enter()
    s.setDocument(["a", "b"])
    s.present({ status: "S", input: input1, cursor: cursorEnd, showCursor: true })
    r.feedFresh()
    // Susut ke 6 baris (kolom tetap): status pindah 9→5, baris lama bersih.
    tty!.resize(40, 6)
    r.grid.setSize(40, 6)
    s.invalidate()
    s.present({ status: "S", input: input1, cursor: { line: 0, col: 16 }, showCursor: true })
    r.feedFresh()
    expect(r.grid.rows()).toBe(6)
    expect(r.grid.text(5)).toBe("minicode › halo")
    expect(r.grid.text(6)).toBe("S")
    // Transkrip 4 baris, dokumen 2 → jangkar bawah: 3,4 = a,b; 1,2 kosong.
    expect(r.grid.text(1)).toBe("")
    expect(r.grid.text(2)).toBe("")
    expect(r.grid.text(3)).toBe("a")
    expect(r.grid.text(4)).toBe("b")
    s.dispose()
  })
})

describe("tui screen: scroll + cap dokumen", () => {
  test("follow menempel ekor; scrollBy pin; scrollToEnd kembali", () => {
    const r = rig(10, 40)
    const s = createTuiScreen()
    s.enter()
    s.setDocument(Array.from({ length: 20 }, (_, i) => `L${i}`))
    s.present({ status: "S", input: input1, cursor: cursorEnd, showCursor: true })
    r.feedFresh()
    // Transkrip 8 baris: L12..L19.
    expect(r.grid.text(1)).toBe("L12")
    expect(r.grid.text(8)).toBe("L19")
    s.scrollBy(-5)
    s.present({ status: "S", input: input1, cursor: cursorEnd, showCursor: true })
    r.feedFresh()
    expect(r.grid.text(1)).toBe("L7")
    // Append saat pin: viewport tak bergerak.
    s.appendLine("L20")
    s.present({ status: "S", input: input1, cursor: cursorEnd, showCursor: true })
    r.feedFresh()
    expect(r.grid.text(1)).toBe("L7")
    s.scrollToEnd()
    s.present({ status: "S", input: input1, cursor: cursorEnd, showCursor: true })
    r.feedFresh()
    expect(r.grid.text(8)).toBe("L20")
    s.dispose()
  })

  test("dokumen di-cap (tak tumbuh tanpa batas)", () => {
    const r = rig(10, 40)
    const s = createTuiScreen()
    s.enter()
    s.setDocument(Array.from({ length: 6000 }, (_, i) => `L${i}`))
    // Cap 5000: L0..L999 dibuang. Scroll ke paling atas → L1000.
    s.scrollBy(-100000)
    s.present({ status: "S", input: input1, cursor: cursorEnd, showCursor: true })
    r.feedFresh()
    expect(r.grid.text(1)).toBe("L1000")
    s.dispose()
  })

  test("scrollPage satu halaman; PageDown di dasar kembali follow", () => {
    const r = rig(10, 40)
    const s = createTuiScreen()
    s.enter()
    s.setDocument(Array.from({ length: 20 }, (_, i) => `L${i}`))
    expect(s.pinnedAbove()).toBe(0)
    // Transkrip 8 baris (L12..L19); satu halaman = 8.
    s.scrollPage(true)
    expect(s.pinnedAbove()).toBe(8)
    s.present({ status: "S", input: input1, cursor: cursorEnd, showCursor: true })
    r.feedFresh()
    expect(r.grid.text(1)).toBe("L4")
    // PageDown: 4+8 >= maxTop(12) → kembali follow, pin 0.
    s.scrollPage(false)
    expect(s.pinnedAbove()).toBe(0)
    s.present({ status: "S", input: input1, cursor: cursorEnd, showCursor: true })
    r.feedFresh()
    expect(r.grid.text(8)).toBe("L19")
    s.dispose()
  })

  test("terminal 1-2 baris: status selalu dapat baris", () => {
    // Gagal di kode lama: out.slice(0, r) membuang baris status.
    const r2 = rig(2, 40)
    const s2 = createTuiScreen()
    s2.enter()
    r2.feedFresh()
    s2.setDocument(["a", "b", "c"])
    s2.present({ status: "S", input: input1, cursor: cursorEnd, showCursor: true })
    r2.feedFresh()
    expect(r2.grid.text(2)).toBe("S")
    s2.dispose()
    const r1 = rig(1, 40)
    const s1 = createTuiScreen()
    s1.enter()
    r1.feedFresh()
    s1.present({ status: "S", input: input1, cursor: cursorEnd, showCursor: true })
    r1.feedFresh()
    expect(r1.grid.text(1)).toBe("S")
    s1.dispose()
  })

  test("kursor + visibilitas mengikuti present", () => {
    const r = rig(10, 40)
    const s = createTuiScreen()
    s.enter()
    s.present({ status: "S", input: input1, cursor: { line: 0, col: 3 }, showCursor: false })
    r.feedFresh()
    expect(r.grid.cursor()).toEqual({ r: 9, c: 3 })
    expect(r.grid.cursorVisible()).toBe(false)
    s.dispose()
  })
})
