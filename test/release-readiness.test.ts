// Release readiness gate (audit rilis npm): metadata, bin, kontrak instalasi.
// Semua statis/offline — instalasi/eksekusi biner aktual dibuktikan manual
// per rilis (lihat laporan audit), bukan di sini agar suite tetap hermetic.
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const repoRoot = join(import.meta.dir, "..")
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  version?: string
  bin?: Record<string, string>
  files?: string[]
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  engines?: Record<string, string>
}
const read = (p: string): string => readFileSync(join(repoRoot, p), "utf8")

describe("release: metadata paket", () => {
  test("version semver tunggal, dibaca CLI dari package.json (bukan konstanta)", () => {
    expect(pkg.version ?? "").toMatch(/^\d+\.\d+\.\d+$/)
    // CLI tidak meng-hardcode versi rilis: readVersion() baca package.json.
    const cli = read("cli/index.ts")
    expect(cli).toContain("package.json")
    expect(cli).not.toContain(`"${pkg.version}"`)
    expect(cli).not.toContain(`'${pkg.version}'`)
  })

  test("setiap entri files ada di repo (case-sensitive, bukan Windows-fold)", () => {
    // Regresi nyata: entri `docs/ARCHITECTURE.md` tak pernah masuk tarball
    // karena berkasnya `architecture.md` (npm match case-sensitive, diam-diam
    // skip). existsSync Windows memaafkan — jadi bandingkan nama eksak.
    for (const entry of pkg.files ?? []) {
      const norm = entry.replace(/^\.\//, "").replace(/\/$/, "")
      const parts = norm.split("/")
      let dir = repoRoot
      for (const part of parts) {
        const names: string[] = readdirSync(dir)
        const hit = names.find((n) => n === part)
        expect(hit, `files entry missing (exact case): ${entry}`).toBeTruthy()
        dir = join(dir, part)
      }
    }
  })

  test("bin menunjuk file ada + shebang bun", () => {
    const bins = Object.entries(pkg.bin ?? {})
    expect(bins.length).toBeGreaterThan(0)
    for (const [, target] of bins) {
      const rel = target.replace(/^\.\//, "")
      expect(existsSync(join(repoRoot, rel))).toBe(true)
      expect(read(rel).split("\n")[0]?.trim()).toBe("#!/usr/bin/env bun")
    }
  })

  test("setiap entri files ada di repo; tanpa skrip lifecycle install", () => {
    for (const f of pkg.files ?? []) {
      expect(existsSync(join(repoRoot, f))).toBe(true)
    }
    for (const k of [
      "preinstall",
      "install",
      "postinstall",
      "prepare",
      "prepublishOnly",
      "prepack",
      "postpack",
    ]) {
      expect(pkg.scripts?.[k]).toBeUndefined()
    }
    expect(pkg.dependencies ?? {}).toEqual({})
  })

  test("engines mendeklarasikan bun (kontrak runtime jujur)", () => {
    expect(pkg.engines?.bun ?? "").toMatch(/bun|>=/)
  })

  test("repository/homepage/bugs menunjuk startupmini", () => {
    const raw = read("package.json")
    expect(raw).toContain("startupmini/minicode")
    expect(raw).not.toContain("ngodingsendiri")
  })
})

describe("release: satu kontrak instalasi di semua permukaan", () => {
  // Kontrak instalasi (2026-09-17): paket pindah dari `@miniroom/minicode` ke
  // `minicode-ai`. Riwayat: scope `@miniroom` 404 saat PUT (rilis 0.9.24/0.9.25
  // gagal); nama bare `minicode` ditolak aturan kemiripan registry (mirip
  // `mini-code`); `minicode-cli` milik pihak lain. `minicode-ai` tersedia dan
  // disetujui pemilik. Bin tetap `minicode`; nama scoped lama tidak boleh
  // tersisa di permukaan install mana pun.
  test("instalasi = `minicode-ai` + Bun-first; nama lama tak boleh tersisa", () => {
    for (const f of ["README.md", "docs/getting-started.md", "scripts/web/landing1.ts"]) {
      const src = read(f)
      expect(src).toContain("npm install -g minicode-ai")
      expect(src).not.toContain("@miniroom/minicode")
      expect(src).not.toMatch(/npm install -g minicode(?!-ai)/)
    }
    const firstIdx = (src: string, needles: string[]): number => {
      const hits = needles.map((n) => src.indexOf(n)).filter((i) => i >= 0)
      return hits.length ? Math.min(...hits) : -1
    }
    for (const f of ["README.md", "docs/getting-started.md"]) {
      const src = read(f)
      // Case-insensitive + bebas angka: yang diwajibkan ADALAH lantai versi
      // bun sebelum perintah install, bukan angka persis — angka memang bergerak
      // naik (1.0 → 1.1.13 saat AbortSignal.any jadi wajib) dan pola kaku membuat
      // permukaan yang jujur versinya justru gagal kontrak (audit 2026-09-23).
      const bunIdx = firstIdx(src.toLowerCase(), ["bun >=", "bun ≥"])
      expect(bunIdx).toBeGreaterThanOrEqual(0)
      expect(bunIdx).toBeLessThan(src.indexOf("npm install -g minicode-ai"))
    }
  })

  test("uninstall/update mendokumentasikan state preservation", () => {
    const src = read("docs/getting-started.md")
    expect(src).toContain("npm uninstall -g minicode-ai")
    expect(src).toMatch(/tidak pernah menghapus state/i)
  })
})
