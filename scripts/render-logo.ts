// Skrip one-off: rasterisasi logo SVG (path poligon) jadi block-character art.
// Dipakai untuk membangkitkan ASCII/block logo yang dipakai boot-screen TUI.
// Bukan bagian dari gate; hanya alat bantu generate (zero-dependency, bun).

const D = `M9560 6730 l0 -260 -12 -1 -13 -2 -315 -1 -315 -1 -12 -8 -13 -8 0 -229 0 -230 -302 -2 -303 -3 -5 -230 -5 -230 -360 0 -360 0 -3 -222 -2 -223 -330 -2 -330 -2 -22 0 -23 -1 -3 223 -2 222 -118 2 -117 2 -170 1 -170 0 -5 225 -5 225 -285 3 -284 2 -7 12 -8 12 1 220 1 221 -651 3 -652 2 -2 -77 -2 -78 -1 -155 0 -155 -275 -5 -275 -5 -3 -1217 -2 -1218 272 -2 273 -3 5 -270 5 -270 660 0 660 0 3 263 2 262 300 0 300 0 2 198 3 197 367 3 368 2 2 193 3 192 348 3 347 2 1 -37 1 -38 2 -160 1 -160 305 -5 305 -5 5 -195 5 -195 170 -1 170 -1 168 -1 167 -2 0 -260 0 -260 993 2 992 3 3 273 2 272 275 0 275 0 -2 1463 -3 1462 -277 3 -278 2 -2 258 -3 257 -717 3 -718 2 0 -260z m1070 -1970 l0 -1230 -382 2 -383 3 -3 193 -2 192 -445 0 -445 0 -2 193 -3 192 -617 3 -618 2 0 185 0 185 283 2 282 3 5 195 5 195 307 3 308 2 2 218 3 217 328 3 327 2 0 228 0 229 7 6 6 7 519 0 518 0 0 -1230z m-4968 538 l3 -223 583 -3 582 -2 0 -195 0 -195 -322 -2 -323 -3 -3 -182 -2 -183 -353 -2 -352 -3 -3 -202 -2 -203 -128 -1 -127 -2 -260 -2 -260 -3 -12 10 -13 10 0 798 0 797 7 6 6 7 488 0 489 0 2 -222z`

type Pt = [number, number]

interface Poly {
  pts: Pt[]
}

// Parse path (M/m L/l H/h V/v Z/z) -> array of polygons (world coords).
function parse(d: string): Poly[] {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+/g) ?? []
  const polys: Poly[] = []
  let cur: Pt[] = []
  let i = 0
  let cmd = ""
  let x = 0
  let y = 0
  let subStart: Pt = [0, 0]
  const toAbs = (px: number, py: number, rel: boolean): Pt => (rel ? [x + px, y + py] : [px, py])

  const closeAndPush = () => {
    if (cur.length >= 3) polys.push({ pts: cur })
    cur = []
  }

  while (i < tokens.length) {
    const t = tokens[i]!
    if (/[a-zA-Z]/.test(t)) {
      cmd = t
      i++
      continue
    }
    const num = () => Number(tokens[i]!)
    switch (cmd) {
      case "M": {
        closeAndPush()
        const px = num()
        i++
        const py = num()
        i++
        const a = toAbs(px, py, false)
        x = a[0]
        y = a[1]
        subStart = a
        cur.push(a)
        cmd = "L" // subsequent pairs = lineto
        break
      }
      case "m": {
        closeAndPush()
        const px = num()
        i++
        const py = num()
        i++
        const a = toAbs(px, py, true)
        x = a[0]
        y = a[1]
        subStart = a
        cur.push(a)
        cmd = "l"
        break
      }
      case "L": {
        const px = num()
        i++
        const py = num()
        i++
        const a = toAbs(px, py, false)
        x = a[0]
        y = a[1]
        cur.push(a)
        break
      }
      case "l": {
        const px = num()
        i++
        const py = num()
        i++
        const a = toAbs(px, py, true)
        x = a[0]
        y = a[1]
        cur.push(a)
        break
      }
      case "H":
      case "h": {
        const px = num()
        i++
        x = cmd === "H" ? px : x + px
        cur.push([x, y])
        break
      }
      case "V":
      case "v": {
        const py = num()
        i++
        y = cmd === "V" ? py : y + py
        cur.push([x, y])
        break
      }
      case "Z":
      case "z": {
        cur.push(subStart)
        closeAndPush()
        i++
        break
      }
      default: {
        // unknown/bezier — skip safely (this path has none)
        i++
      }
    }
  }
  closeAndPush()
  return polys
}

// Apply SVG transform translate(0,1024) scale(0.1,-0.1)
function transform(polys: Poly[]): Poly[] {
  return polys.map((p) => ({
    pts: p.pts.map(([px, py]) => [0.1 * px, -0.1 * py + 1024] as Pt),
  }))
}

function bounds(polys: Poly[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of polys)
    for (const [x, y] of p.pts) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  return { minX, minY, maxX, maxY }
}

function inside(polys: Poly[], px: number, py: number): boolean {
  for (const p of polys) {
    let hit = false
    const n = p.pts.length
    for (let k = 0, j = n - 1; k < n; j = k++) {
      const [xi, yi] = p.pts[k]!
      const [xj, yj] = p.pts[j]!
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit
    }
    if (hit) return true
  }
  return false
}

function render(polys: Poly[], cols: number): string {
  const b = bounds(polys)
  const w = b.maxX - b.minX
  const h = b.maxY - b.minY
  const rows = Math.max(1, Math.round((cols * h) / w))
  const out: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ""
    for (let c = 0; c < cols; c++) {
      const wx = b.minX + ((c + 0.5) / cols) * w
      const wy = b.maxY - ((r + 0.5) / rows) * h
      line += inside(polys, wx, wy) ? "█" : " "
    }
    out.push(line)
  }
  // trim trailing spaces only (keep leading for centering offsets)
  return out.map((l) => l.replace(/ +$/, "")).join("\n")
}

const polys = transform(parse(D))
const b = bounds(polys)
console.log(
  `bbox: x[${b.minX.toFixed(1)}, ${b.maxX.toFixed(1)}] y[${b.minY.toFixed(1)}, ${b.maxY.toFixed(1)}] ratio=${((b.maxX - b.minX) / (b.maxY - b.minY)).toFixed(3)}`,
)
for (const cols of [40, 34, 28]) {
  const rows = render(polys, cols)
    .split("\n")
    .map((r) => r.replace(/ +$/, ""))
  console.log(`\n=== ${cols} cols / ${rows.length} rows (TS array) ===`)
  console.log(`export const LOGO_${cols} = [`)
  for (const r of rows) console.log(`  ${JSON.stringify(r)},`)
  console.log(`]`)
}
