// Responsive + adversarial: terminal sempit, sangat lebar, resize cepat,
// konten besar — semua harus stabil tanpa panic/overflow/kehilangan state.
// Skill §14, §17, §34 (adversarial matrix).

import { describe, expect, test } from "bun:test"
import { createTuiScreen } from "../src/ui/tui/screen.ts"
import { createGridEmulator } from "./helpers/screen-grid.ts"
import { installFakeTty } from "./helpers/tui-harness.ts"

function rig(rows: number, cols: number) {
  const tty = installFakeTty({ rows, columns: cols })
  const grid = createGridEmulator(cols, rows)
  const feed = () => {
    const out = tty.chunks().join("")
    grid.feed(out)
    tty.clear()
    return out
  }
  return { tty, grid, feed }
}

describe("responsive: layout elastis", () => {
  for (const [cols, rows] of [
    [20, 12],
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const) {
    test(`${cols}x${rows} — status selalu baris terakhir, input terlihat`, () => {
      const { tty, grid, feed } = rig(rows, cols)
      try {
        const s = createTuiScreen()
        s.enter()
        s.setDocument(["hello world, ini baris panjang yang harus terpotong rapi"])
        // Status pendek agar tidak tepat memenuhi lebar (memicu wrap palsu di emulator, bukan terminal asli).
        s.present({
          status: "STATUS",
          input: ["minicode › test"],
          cursor: { line: 0, col: 14 },
          showCursor: true,
        })
        feed()
        expect(grid.text(rows)).toContain("STATUS")
        expect(grid.text(rows - 1)).toContain("minicode › test")
        expect(grid.text(1).length).toBeLessThanOrEqual(cols)
        s.dispose()
      } finally {
        tty.restore()
      }
    })
  }

  test("sangat sempit 20 cols: truncation ellipsis, tanpa panic", () => {
    const { tty, grid, feed } = rig(12, 20)
    try {
      const s = createTuiScreen()
      s.enter()
      s.setDocument(["a".repeat(100)])
      s.present({
        status: "STATUS yang sangat panjang melebihi lebar terminal sempit",
        input: ["minicode › halo dunia yang panjang sekali"],
        cursor: { line: 0, col: 5 },
        showCursor: true,
      })
      feed()
      expect(grid.text(12).length).toBeLessThanOrEqual(20)
      expect(grid.text(11).length).toBeLessThanOrEqual(20)
      s.dispose()
    } finally {
      tty.restore()
    }
  })

  test("empty state terlihat di semua ukuran (20–200)", () => {
    for (const cols of [20, 80, 200]) {
      const { tty, grid, feed } = rig(24, cols)
      try {
        const s = createTuiScreen()
        s.enter()
        s.setDocument([])
        s.present({
          status: "S",
          input: ["minicode › "],
          cursor: { line: 0, col: 11 },
          showCursor: true,
        })
        feed()
        const all = Array.from({ length: 24 }, (_, i) => grid.text(i + 1)).join("\n")
        expect(all).toContain("No messages yet")
        s.dispose()
      } finally {
        tty.restore()
      }
    }
  })
})

describe("resilience: resize & content besar", () => {
  test("rapid resize 80x24 → 40x12 → 200x60 → 80x24 tanpa kehilangan state", () => {
    const { tty, grid, feed } = rig(24, 80)
    try {
      const s = createTuiScreen()
      s.enter()
      s.setDocument(Array.from({ length: 10 }, (_, i) => `line ${i}`))
      s.present({
        status: "S",
        input: ["minicode › hi"],
        cursor: { line: 0, col: 13 },
        showCursor: true,
      })
      feed()
      // Rapid storm
      for (const [c, r] of [
        [40, 12],
        [200, 60],
        [80, 24],
      ] as const) {
        tty.resize(c, r)
        grid.setSize(c, r)
        s.invalidate()
        s.present({
          status: "S",
          input: ["minicode › hi"],
          cursor: { line: 0, col: 13 },
          showCursor: true,
        })
        feed()
        expect(grid.rows()).toBe(r)
        expect(grid.cols()).toBe(c)
        expect(grid.text(r)).toBe("S")
      }
      s.dispose()
    } finally {
      tty.restore()
    }
  })

  test("huge log 5000 baris: bounded, viewport rendering, tanpa OOM", () => {
    const { tty, grid, feed } = rig(24, 80)
    try {
      const s = createTuiScreen()
      s.enter()
      s.setDocument(Array.from({ length: 6000 }, (_, i) => `L${i}`))
      s.present({
        status: "S",
        input: ["minicode › "],
        cursor: { line: 0, col: 11 },
        showCursor: true,
      })
      feed()
      // Cap 5000: L0..L999 terbuang, paling atas L1000
      s.scrollBy(-100000)
      s.present({
        status: "S",
        input: ["minicode › "],
        cursor: { line: 0, col: 11 },
        showCursor: true,
      })
      feed()
      expect(grid.text(1)).toBe("L1000")
      s.dispose()
    } finally {
      tty.restore()
    }
  })

  test("present identik setelah resize tanpa perubahan: NOL byte", () => {
    const { tty, feed } = rig(24, 80)
    try {
      const s = createTuiScreen()
      s.enter()
      s.setDocument(["a"])
      s.present({
        status: "S",
        input: ["minicode › hi"],
        cursor: { line: 0, col: 14 },
        showCursor: true,
      })
      feed() // first paint
      s.present({
        status: "S",
        input: ["minicode › hi"],
        cursor: { line: 0, col: 14 },
        showCursor: true,
      })
      expect(tty.chunks().join("")).toBe("")
      s.dispose()
    } finally {
      tty.restore()
    }
  })
})
