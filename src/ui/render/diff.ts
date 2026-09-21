// Diff renderer - Ubuntu Server style: indentasi + warna, tanpa border.
import { sanitizeAnsi, sanitizeAnsiLine } from "./sanitize.ts"
import { c } from "./theme.ts"
import { truncateToWidth } from "./width.ts"

export interface DiffLine {
  type: "add" | "delete" | "context"
  oldLine?: number
  newLine?: number
  content: string
}

/**
 * Diff baris heuristik O(n·m) tanpa alokasi slice per langkah (dulu
 * `slice(i).includes(...)` yang meng-copy sisa array tiap iterasi).
 *
 * Aturan dua sisi: bila baris baru tak ada di sisa lama → add; bila baris
 * lama tak ada di sisa baru → delete; bila KEDUANYA muncul di sisi lain
 * (reorder ambigu, mis. lama `[a,b]` vs baru `[b,a,b]`) → dahulukan add agar
 * baris lama tetap tersedia untuk match berikut (3 op, bukan 4).
 * Cukup untuk diff card edit/apply_patch (DIFF_MAX_LINES=24) — TIDAK untuk
 * file besar (>2000 baris); Myers tetap tidak dibutuhkan di sini.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n")
  const newLines = newText.split("\n")
  const result: DiffLine[] = []
  let i = 0,
    j = 0,
    oldNum = 1,
    newNum = 1

  // indexOf dari posisi (tanpa slice) — O(n) tanpa alokasi per langkah.
  const oldHasFrom = (s: string, from: number): boolean => oldLines.indexOf(s, from) !== -1
  const newHasFrom = (s: string, from: number): boolean => newLines.indexOf(s, from) !== -1

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      result.push({ type: "context", content: oldLines[i]! })
      i++
      j++
    } else if (j < newLines.length && (i >= oldLines.length || !oldHasFrom(newLines[j]!, i))) {
      result.push({ type: "add", newLine: newNum++, content: newLines[j]! })
      j++
    } else if (i < oldLines.length && (j >= newLines.length || !newHasFrom(oldLines[i]!, j))) {
      result.push({ type: "delete", oldLine: oldNum++, content: oldLines[i]! })
      i++
    } else if (j < newLines.length) {
      // Reorder ambigu: keduanya ada di sisi lain — add dulu.
      result.push({ type: "add", newLine: newNum++, content: newLines[j]! })
      j++
    } else {
      result.push({ type: "delete", oldLine: oldNum++, content: oldLines[i]! })
      i++
    }
  }
  return result
}

// ── Sorot kata berubah ──
// Baris add/delete yang berpasangan (pola hunk unified: run delete lalu run
// add) dibedakan per KATA, bukan sebaris penuh — mata langsung ke token yang
// berubah. LCS DP kecil: baris kode pendek sehingga O(kata^2) per pasangan
// tidak terasa; cap baris global tetap DIFF_MAX_LINES.
const tokenizeWords = (s: string): string[] => s.split(/(\s+)/).filter((t) => t !== "")

/** Masker token yang berubah dari LCS dua baris (true = beda). Diekspor untuk test. */
export function markChangedWords(
  oldLine: string,
  newLine: string,
): { oldMask: boolean[]; newMask: boolean[] } {
  const a = tokenizeWords(oldLine)
  const b = tokenizeWords(newLine)
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const oldMask = new Array<boolean>(n).fill(true)
  const newMask = new Array<boolean>(m).fill(true)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      oldMask[i] = false
      newMask[j] = false
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
    else j++
  }
  return { oldMask, newMask }
}

const paintWords = (text: string, mask: boolean[], paint: (s: string) => string): string => {
  const toks = tokenizeWords(text)
  // Bila hampir semua token beda, bold semuanya = noise — tampilkan polos.
  const changed = mask.filter(Boolean).length
  if (toks.length === 0 || changed / toks.length > 0.6) return text
  return toks.map((t, k) => (mask[k] ? paint(t) : t)).join("")
}

// Render diff with 1 line context around changes
export function renderDiffCard(
  filePath: string,
  oldText: string,
  newText: string,
  opts: { maxLines?: number; width?: number } = {},
): string {
  // Path & isi dari tool/model/berkas = tak-terpercaya: sanitasi sebelum
  // dirender. Tanpa ini `\n` di path menjadi baris diff palsu dan `ESC[2J`
  // lolos via `cut` (truncate menyalin escape apa pun sebelum F-04).
  const safePath = sanitizeAnsiLine(filePath)
  const diff = computeLineDiff(sanitizeAnsi(oldText), sanitizeAnsi(newText))
  const changes = diff.filter((d) => d.type !== "context")
  if (changes.length === 0) return c.muted("  (no changes)")
  // Pasangan del/add untuk sorot kata: kelompokkan run perubahan beruntun,
  // pasangkan del ke-i dengan add ke-i (pola hunk unified).
  const wordMask = new Map<number, boolean[]>()
  {
    let i = 0
    while (i < diff.length) {
      if (diff[i]!.type === "context") {
        i++
        continue
      }
      const dels: number[] = []
      const adds: number[] = []
      while (i < diff.length && diff[i]!.type !== "context") {
        if (diff[i]!.type === "delete") dels.push(i)
        else adds.push(i)
        i++
      }
      const n = Math.min(dels.length, adds.length)
      for (let k = 0; k < n; k++) {
        const { oldMask, newMask } = markChangedWords(
          diff[dels[k]!]!.content,
          diff[adds[k]!]!.content,
        )
        wordMask.set(dels[k]!, oldMask)
        wordMask.set(adds[k]!, newMask)
      }
    }
  }

  const max = opts.maxLines ?? 12
  // Baris diff bisa sepanjang baris kode aslinya. Tanpa batas, satu baris 300
  // karakter membungkus sendiri di terminal dan merusak frame TUI yang
  // menghitung tinggi per baris. Default mengikuti lebar terminal.
  const width = opts.width ?? (process.stdout.columns || 80)
  const cut = (s: string) => truncateToWidth(s, Math.max(8, width - 1))

  const lines: string[] = [c.accent(c.bold(cut(`  ${safePath}`)))]
  // collect indices of changes plus 1 context line before/after
  const include = new Set<number>()
  diff.forEach((d, i) => {
    if (d.type !== "context") {
      include.add(i)
      if (i > 0 && diff[i - 1]?.type === "context") include.add(i - 1)
      if (i + 1 < diff.length && diff[i + 1]?.type === "context") include.add(i + 1)
    }
  })
  let count = 0
  for (let i = 0; i < diff.length; i++) {
    if (!include.has(i)) continue
    if (count >= max) {
      const added = changes.filter((d) => d.type === "add").length
      const removed = changes.filter((d) => d.type === "delete").length
      lines.push(c.muted(`    ... (+${added} \u2212${removed})`))
      break
    }
    const d = diff[i]!
    if (d.type === "add") {
      const mask = wordMask.get(i)
      const body = mask ? paintWords(d.content, mask, (s) => c.bold(s)) : d.content
      lines.push(c.success(cut(`  + ${body}`)))
    } else if (d.type === "delete") {
      const mask = wordMask.get(i)
      const body = mask ? paintWords(d.content, mask, (s) => c.bold(s)) : d.content
      lines.push(c.error(cut(`  - ${body}`)))
    } else lines.push(c.dim(cut(`    ${d.content}`)))
    count++
  }
  return lines.join("\n")
}
