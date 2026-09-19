// Emulator grid layar untuk test TUI (`src/ui/tui/`).
//
// Mengapa ada: `tui-harness.ts` hanya menangkap byte — cukup untuk
// mengasersi ADA/TIDAKNYA sekuens, tapi buta terhadap keadaan VISUAL
// (teks di baris berapa? kursor di mana? alt-screen aktif?). Emulator ini
// mem-parse subset sekuens yang dipakai renderer kita + pola umum menjadi
// grid sel, sehingga test bisa mengasersi tampilan, bukan byte.
//
// Cakupan SENGAJA minimal (tercantum agar tak dianggap bug):
// CUP/H/f, CHA G, VPA d, CUU/D/F/B, CNL/CPL E/F, EL K, ED J, ECH X,
// IL/DL L/M (dibatasi margin), DECSTBM r, ?1049h/l, ?25l/h, ?2026h/l,
// ?2004h/l (abaikan), DECSC/DECRC 7/8, ANSISYSSC u/s, RI M, full-reset c,
// OSC (dilewat), SGR (diabaikan — emulator layout-only, bukan warna),
// \r \n \t \b. Tanpa emulasi REFLOW saat resize (renderer selalu full
// repaint sesudah resize, jadi fidelity reflow tak dibutuhkan).
// Lebar CJK/emoji via displayWidth (2 kolom); SGR tak dihitung.

import { displayWidth } from "../../src/ui/render/width.ts"

export interface GridCursor {
  r: number
  c: number
}

export interface GridEmulator {
  feed(s: string): void
  /** Teks baris viewport 1-indexed, trailing blank dipangkas. */
  text(row: number): string
  rows(): number
  cols(): number
  cursor(): GridCursor
  altActive(): boolean
  cursorVisible(): boolean
  region(): { top: number; bottom: number }
  /** Baris yang ter-scroll keluar viewport buffer utama (alt: dibuang). */
  scrollback(): string[]
  /** Ganti ukuran (TANPA reflow — lihat catatan di atas). */
  setSize(cols: number, rows: number): void
}

interface Cell {
  ch: string
  /** Lebar kolom (0 = lanjutan sel lebar-2). */
  w: number
}

function blankRow(cols: number): Cell[] {
  return Array.from({ length: cols }, () => ({ ch: " ", w: 1 }))
}

function rowText(row: Cell[]): string {
  return row
    .map((c) => (c.w === 0 ? "" : c.ch))
    .join("")
    .replace(/ +$/, "")
}

export function createGridEmulator(initCols = 80, initRows = 24): GridEmulator {
  let cols = initCols
  let rows = initRows
  // Dua buffer (main + alt), masing-masing grid penuh + scrollback main.
  let grid: Cell[][] = []
  let mainGrid: Cell[][] = []
  let mainCursor: GridCursor = { r: 1, c: 1 }
  const scrollback: string[] = []
  let alt = false
  let cursor: GridCursor = { r: 1, c: 1 }
  let saved: GridCursor = { r: 1, c: 1 }
  let visible = true
  let region = { top: 1, bottom: initRows }

  const resetGrid = (): void => {
    grid = Array.from({ length: rows }, () => blankRow(cols))
    cursor = { r: 1, c: 1 }
    region = { top: 1, bottom: rows }
  }
  resetGrid()

  const clampCursor = (): void => {
    cursor.r = Math.max(1, Math.min(cursor.r, rows))
    cursor.c = Math.max(1, Math.min(cursor.c, cols))
  }

  const writeChar = (ch: string): void => {
    const w = displayWidth(ch)
    if (w <= 0) return
    // Wrap standar: tak muat → baris baru dulu (dengan semantik scroll).
    if (cursor.c + w - 1 > cols) {
      cursor.c = 1
      lineFeed()
    }
    const row = grid[cursor.r - 1]!
    row[cursor.c - 1] = { ch, w }
    if (w === 2 && cursor.c < cols) row[cursor.c] = { ch: "", w: 0 }
    cursor.c = Math.min(cols + 1, cursor.c + w)
    if (cursor.c > cols) {
      cursor.c = 1
      lineFeed()
    }
  }

  const scrollRegion = (): void => {
    // Geser [top..bottom] ke atas 1; baris top keluar (scrollback bila main).
    const topLine = grid[region.top - 1]!
    if (!alt) scrollback.push(rowText(topLine))
    for (let r = region.top; r < region.bottom; r++) grid[r - 1] = grid[r]!
    grid[region.bottom - 1] = blankRow(cols)
  }

  const scrollFull = (): void => {
    const topLine = grid[0]!
    if (!alt) scrollback.push(rowText(topLine))
    for (let r = 1; r < rows; r++) grid[r - 1] = grid[r]!
    grid[rows - 1] = blankRow(cols)
  }

  const lineFeed = (): void => {
    if (cursor.r < region.top || cursor.r > region.bottom) {
      // Di luar margin: turun biasa; lewat layar → scroll penuh.
      if (cursor.r >= rows) scrollFull()
      else cursor.r++
      return
    }
    if (cursor.r === region.bottom) scrollRegion()
    else cursor.r++
  }

  const eraseLine = (n: number): void => {
    const row = grid[cursor.r - 1]!
    if (n === 2) {
      grid[cursor.r - 1] = blankRow(cols)
    } else if (n === 1) {
      for (let i = 0; i < cursor.c && i < cols; i++) row[i] = { ch: " ", w: 1 }
    } else {
      for (let i = cursor.c - 1; i < cols; i++) row[i] = { ch: " ", w: 1 }
    }
  }

  const eraseDisplay = (n: number): void => {
    if (n === 2 || n === 3) {
      for (let r = 0; r < rows; r++) grid[r] = blankRow(cols)
      if (n === 2) cursor = { r: 1, c: 1 }
      return
    }
    if (n === 1) {
      for (let r = 0; r < cursor.r; r++) grid[r] = blankRow(cols)
      eraseLine(1)
    } else {
      eraseLine(0)
      for (let r = cursor.r; r < rows; r++) grid[r] = blankRow(cols)
    }
  }

  const deleteLines = (n: number): void => {
    // Dibatasi margin (sesuai dok VT + perilaku WT/conhost).
    const top = Math.max(cursor.r, region.top)
    const bottom = region.bottom
    if (top > bottom) return
    const count = Math.min(n, bottom - top + 1)
    for (let k = 0; k < count; k++) {
      for (let r = top; r < bottom; r++) grid[r - 1] = grid[r]!
      grid[bottom - 1] = blankRow(cols)
    }
  }

  const insertLines = (n: number): void => {
    const top = Math.max(cursor.r, region.top)
    const bottom = region.bottom
    if (top > bottom) return
    const count = Math.min(n, bottom - top + 1)
    for (let k = 0; k < count; k++) {
      for (let r = bottom; r > top; r--) grid[r - 1] = grid[r - 2]!
      grid[top - 1] = blankRow(cols)
    }
  }

  const num = (v: string | undefined, dflt: number): number => {
    const n = v === undefined || v === "" ? dflt : Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
  }

  function csi(params: string, priv: boolean, fin: string): void {
    const p = params.split(";")
    if (priv) {
      const n = num(p[0], 0)
      if (n === 1049) {
        if (fin === "h" && !alt) {
          // Simpan main + kursor, pindah buffer bersih tanpa scrollback.
          mainGrid = grid
          mainCursor = { ...cursor }
          grid = Array.from({ length: rows }, () => blankRow(cols))
          cursor = { r: 1, c: 1 }
          region = { top: 1, bottom: rows }
          alt = true
        } else if (fin === "l" && alt) {
          grid = mainGrid.length === rows ? mainGrid : grid
          cursor = { ...mainCursor }
          region = { top: 1, bottom: rows }
          alt = false
        }
        return
      }
      // ?25h/l visibilitas kursor; ?2026h/l, ?2004h/l, lainnya: abaikan.
      if (n === 25) visible = fin === "h"
      return
    }
    switch (fin) {
      case "A":
        cursor.r -= num(p[0], 1)
        break
      case "B":
        cursor.r += num(p[0], 1)
        break
      case "C":
        cursor.c += num(p[0], 1)
        break
      case "D":
        cursor.c -= num(p[0], 1)
        break
      case "E":
        cursor.c = 1
        for (let i = 0; i < num(p[0], 1); i++) lineFeed()
        break
      case "F":
        cursor.c = 1
        cursor.r -= num(p[0], 1)
        break
      case "G":
        cursor.c = num(p[0], 1)
        break
      case "H":
      case "f": {
        cursor.r = num(p[0], 1)
        cursor.c = num(p[1], 1)
        break
      }
      case "d":
        cursor.r = num(p[0], 1)
        break
      case "J":
        eraseDisplay(num(p[0], 0))
        break
      case "K":
        eraseLine(num(p[0], 0))
        break
      case "L":
        insertLines(num(p[0], 1))
        break
      case "M":
        deleteLines(num(p[0], 1))
        break
      case "X": {
        // ECH: blank-kan n sel dari kursor (tanpa geser).
        const row = grid[cursor.r - 1]!
        const count = Math.min(num(p[0], 1), cols - cursor.c + 1)
        for (let i = 0; i < count; i++) row[cursor.c - 1 + i] = { ch: " ", w: 1 }
        break
      }
      case "m":
        break // SGR: layout-only, warna diabaikan (tercatat di header).
      case "r": {
        // DECSTBM: kosong = reset penuh; di luar jangkauan = abaikan (WT).
        if (params === "") {
          region = { top: 1, bottom: rows }
          break
        }
        const t = num(p[0], 1)
        const b = num(p[1], rows)
        if (t < b && b <= rows) region = { top: t, bottom: b }
        break
      }
      case "s":
        saved = { ...cursor }
        break
      case "u":
        cursor = { ...saved }
        break
      default:
        break
    }
    clampCursor()
  }

  function feed(s: string): void {
    let i = 0
    while (i < s.length) {
      const ch = s[i]!
      if (ch === "\x1b") {
        const nx = s[i + 1]
        if (nx === "[") {
          // CSI ... final-byte (A-Z, a-z). Private `?` didukung.
          let j = i + 2
          let priv = false
          if (s[j] === "?") {
            priv = true
            j++
          }
          let params = ""
          while (j < s.length && !/[a-zA-Z]/.test(s[j]!)) {
            params += s[j]
            j++
          }
          if (j >= s.length) break // sekuens terpotong: berhenti (chunk parsial)
          const fin = s[j]!
          csi(params, priv, fin)
          i = j + 1
          continue
        }
        if (nx === "]") {
          // OSC: lewati sampai BEL atau ESC\.
          let j = i + 2
          while (j < s.length && s[j] !== "\x07" && !(s[j] === "\\" && s[j - 1] === "\x1b")) j++
          i = j + 1
          continue
        }
        if (nx === "7") {
          saved = { ...cursor }
          i += 2
          continue
        }
        if (nx === "8") {
          cursor = { ...saved }
          clampCursor()
          i += 2
          continue
        }
        if (nx === "M") {
          // RI: di top margin → scroll region ke bawah; selain itu naik.
          if (cursor.r === region.top) {
            for (let r = region.bottom; r > region.top; r--) grid[r - 1] = grid[r - 2]!
            grid[region.top - 1] = blankRow(cols)
          } else {
            cursor.r = Math.max(1, cursor.r - 1)
          }
          i += 2
          continue
        }
        if (nx === "c") {
          resetGrid()
          alt = false
          i += 2
          continue
        }
        i += 1 // ESC tak dikenal: buang.
        continue
      }
      if (ch === "\r") {
        cursor.c = 1
        i++
        continue
      }
      if (ch === "\n") {
        cursor.c = 1
        lineFeed()
        i++
        continue
      }
      if (ch === "\t") {
        cursor.c = Math.min(cols, cursor.c + (8 - ((cursor.c - 1) % 8)))
        i++
        continue
      }
      if (ch === "\b") {
        cursor.c = Math.max(1, cursor.c - 1)
        i++
        continue
      }
      if (ch === "\x07" || ch === "\x00") {
        i++ // BEL/NUL: abaikan.
        continue
      }
      // Karakter tampil (for.. di pemanggil menangani surrogate; di sini
      // konsumsi satu unit kode — displayWidth per karakter BMP sudah tepat
      // untuk CJK; emoji multi-unit dihitung per surrogate (aproksimasi
      // terdokumentasi: harness layout, bukan shaping engine).
      writeChar(ch)
      i++
    }
  }

  return {
    feed,
    text(row: number) {
      if (row < 1 || row > rows) return ""
      return rowText(grid[row - 1]!)
    },
    rows: () => rows,
    cols: () => cols,
    cursor: () => ({ ...cursor }),
    altActive: () => alt,
    cursorVisible: () => visible,
    region: () => ({ ...region }),
    scrollback: () => [...scrollback],
    setSize(c: number, r: number) {
      cols = Math.max(1, c)
      rows = Math.max(1, r)
      // Tanpa reflow (lihat header): grid dipotong/dipad, kursor di-clamp.
      const kept = grid.slice(0, rows).map((row) => {
        const next = row.slice(0, cols)
        while (next.length < cols) next.push({ ch: " ", w: 1 })
        return next
      })
      while (kept.length < rows) kept.push(blankRow(cols))
      grid = kept
      region = { top: 1, bottom: rows }
      clampCursor()
    },
  }
}
