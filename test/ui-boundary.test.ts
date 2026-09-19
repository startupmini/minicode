// Penjaga batas presentation layer (`src/ui/`).
//
// Aturan arah dependensi (lihat docs/ARCHITECTURE.html):
//   cli/ ──► src/ui/ (presentation; mandiri)
//   cli/ ──► src/ (logic) ──► vendor/minicore (#minicore)
//
// 1. `src/ui/**` tidak boleh mengimpor apa pun yang keluar dari src/ui/
//    (baik `cli/` maupun `src/` non-ui) lewat path relatif.
// 2. `src/ui/**` tidak boleh mengimpor kernel `#minicore`.
// 3. `src/**` di luar `src/ui/` tidak boleh mengimpor `src/ui/`.
//
// Gaya pemeriksaan mengikuti test/import-convention.test.ts: scan berkas .ts
// yang terlacak git, kumpulkan pelanggar, tampilkan semuanya sekaligus.

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { type Dirent, readdirSync, readFileSync } from "node:fs"
import { join, posix } from "node:path"

const repoRoot = process.cwd()

function trackedFiles(pattern: RegExp): string[] {
  const r = spawnSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 })
  if (r.status !== 0) return []
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => pattern.test(s))
}

/** Berkas .ts di disk (termasuk yang belum di-stage): modul baru seperti
 * `src/ui/tui/` harus dijaga batasnya SEBELUM `git add`, bukan sesudah.
 * `git ls-files` saja buta terhadapnya — union ini menutup lubang itu.
 * Scratch di luar `src/` tetap diabaikan (bukan bagian paket). */
function onDiskFiles(pattern: RegExp): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(join(repoRoot, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = posix.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(rel)
      } else if (e.name.endsWith(".ts") && pattern.test(rel)) out.push(rel)
    }
  }
  walk("src")
  return out
}

/** Ekstrak semua spesifier import (from/import/import()/require) dari sumber. */
function specifiersOf(src: string): string[] {
  const out: string[] = []
  const re = /(?:\bfrom|\bimport|\brequire)\s*\(?["']([^"']+)["']/g
  for (const m of src.matchAll(re)) out.push(m[1]!)
  return out
}

/** Resolve spesifier relatif terhadap direktori berkas; null jika bukan relatif. */
function resolveSpec(fileDir: string, spec: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null
  return posix.normalize(posix.join(fileDir, spec))
}

const uiFiles = [
  ...new Set([...trackedFiles(/^src\/ui\/.*\.ts$/), ...onDiskFiles(/^src\/ui\/.*\.ts$/)]),
]
const srcFiles = [...new Set([...trackedFiles(/^src\/.*\.ts$/), ...onDiskFiles(/^src\/.*\.ts$/)])]

describe("batas presentation layer (src/ui)", () => {
  test("ada berkas src/ui untuk diperiksa (sanity)", () => {
    expect(uiFiles.length).toBeGreaterThan(15)
  })

  test("src/ui/** tidak mengimpor keluar dari src/ui/ (cli/ atau src/ non-ui)", () => {
    const offenders: string[] = []
    for (const f of uiFiles) {
      const dir = posix.dirname(f)
      const src = readFileSync(join(repoRoot, f), "utf8")
      for (const spec of specifiersOf(src)) {
        const resolved = resolveSpec(dir, spec)
        if (resolved != null && !resolved.startsWith("src/ui/")) {
          offenders.push(`${f}: "${spec}" -> ${resolved}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test("src/ui/** tidak mengimpor kernel #minicore", () => {
    const offenders: string[] = []
    for (const f of uiFiles) {
      const src = readFileSync(join(repoRoot, f), "utf8")
      for (const spec of specifiersOf(src)) {
        if (spec === "#minicore" || spec.startsWith("#minicore/")) {
          offenders.push(`${f}: "${spec}"`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test("src/** non-ui tidak mengimpor src/ui/", () => {
    const offenders: string[] = []
    for (const f of srcFiles) {
      if (f.startsWith("src/ui/")) continue
      const dir = posix.dirname(f)
      const src = readFileSync(join(repoRoot, f), "utf8")
      for (const spec of specifiersOf(src)) {
        const resolved = resolveSpec(dir, spec)
        if (resolved?.startsWith("src/ui/")) {
          offenders.push(`${f}: "${spec}" -> ${resolved}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
