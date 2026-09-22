// Audit #11 — Packaging / Supply Chain / Runtime Integrity.
//
// Mengunci batas rilis TANPA membutuhkan network/registry/sibling:
//  1. Pin vendor (`VENDOR.md` files+hash) dihitung ulang dari tree — menangkap
//     edit vendor tak disengaja bahkan saat `../minicore` tak ada (celah
//     `vendor:check`: tanpa sibling ia lolos dengan pesan, lihat
//     `test/import-convention.test.ts:97`).
//  2. Permukaan pack (`files`/`bin`/scripts/`dependencies`) — file runtime
//     hilang = "Cannot find module" pasca-publish; fixture test ikut = gate
//     `gate:pack` merah; install-script = eksekusi saat install.
// Semua murni baca-lokal; pemeriksaan tarball nyata ada di `gate:pack`.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const repoRoot = process.cwd()
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  version?: string
  bin?: Record<string, string>
  files?: string[]
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  imports?: Record<string, string>
}

function listFiles(dir: string, base: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listFiles(full, base, out)
    else out.push(relative(base, full).replace(/\\/g, "/"))
  }
  return out.sort()
}

/** Cakupan `files` ala npm untuk kasus sederhana repo ini (entri dir = semua
 * di bawahnya; package.json/README/LICENSE selalu ikut). Cukup untuk guard
 * regresi — kebenaran pasti tetap di `npm pack --dry-run` (`gate:pack`). */
function coveredByFiles(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/")
  for (const entry of pkg.files ?? []) {
    const e = entry.replace(/^\.\//, "").replace(/\/$/, "")
    if (norm === e || norm.startsWith(`${e}/`)) return true
  }
  return ["package.json", "README.md", "LICENSE"].includes(norm)
}

describe("audit #11: pin vendor berlaku tanpa sibling", () => {
  const vendorDir = join(repoRoot, "vendor", "minicore")
  // Algoritma SAMA dengan scripts/vendor-minicore.ts (collect + hashOf).
  function collect(): string[] {
    const files: string[] = []
    files.push(...listFiles(join(vendorDir, "src"), vendorDir))
    for (const f of ["package.json", "LICENSE", "test/fakes.ts"]) {
      if (existsSync(join(vendorDir, f))) files.push(f)
    }
    return files.sort()
  }
  function hashOf(files: string[]): string {
    const h = createHash("sha256")
    for (const f of files) {
      h.update(f)
      h.update("\0")
      h.update(readFileSync(join(vendorDir, f)))
      h.update("\0")
    }
    return h.digest("hex").slice(0, 16)
  }

  test("VENDOR.md files+hash cocok dengan tree (dilarang edit manual)", () => {
    const md = readFileSync(join(vendorDir, "VENDOR.md"), "utf8")
    const files = Number(/^- files: (\d+)/m.exec(md)?.[1])
    const hash = /^- hash: `([0-9a-f]+)`/m.exec(md)?.[1]
    if (!hash) throw new Error("VENDOR.md hash tak terbaca")
    expect(files).toBeGreaterThan(0)
    const actual = collect()
    expect(actual.length).toBe(files)
    expect(hashOf(actual)).toBe(hash)
  })
})

describe("audit #11: permukaan pack tepat", () => {
  test("setiap file runtime src/cli ikut terkemas", () => {
    const missing: string[] = []
    for (const dir of ["src", "cli"]) {
      for (const f of listFiles(join(repoRoot, dir), repoRoot)) {
        if (!f.endsWith(".ts")) continue
        if (!coveredByFiles(f)) missing.push(f)
      }
    }
    expect(missing).toEqual([])
  })

  test("bin menunjuk file yang ikut terkemas + shebang bun", () => {
    const bins = Object.values(pkg.bin ?? {})
    expect(bins.length).toBeGreaterThan(0)
    for (const b of bins) {
      const rel = b.replace(/^\.\//, "")
      expect(coveredByFiles(rel)).toBe(true)
      // trim: working copy Windows ber-CRLF, repo menghendaki LF (.gitattributes)
      const first = readFileSync(join(repoRoot, rel), "utf8").split("\n")[0]?.trim()
      expect(first).toBe("#!/usr/bin/env bun")
    }
  })

  test("fixture test vendor SENGAJA tak ikut (aturan forbidden gate:pack)", () => {
    const vendorDir = join(repoRoot, "vendor", "minicore")
    expect(existsSync(join(vendorDir, "test", "fakes.ts"))).toBe(true)
    expect(coveredByFiles("vendor/minicore/test/fakes.ts")).toBe(false)
  })

  test("shipped hash VENDOR.md = fingerprint file vendor yang ikut paket (provenance tarball)", () => {
    // Hash 19-file tidak bisa direproduksi dari paket terbit karena fakes.ts
    // sengaja tak ikut. Angka kedua (shipped hash) menghitung HANYA file yang
    // ikut `files` — verifikator cukup vendor/minicore di dalam tarball.
    const vendorDir = join(repoRoot, "vendor", "minicore")
    const md = readFileSync(join(vendorDir, "VENDOR.md"), "utf8")
    const shipped = /^- shipped hash: `([0-9a-f]+)`/m.exec(md)?.[1]
    if (!shipped) throw new Error("VENDOR.md shipped hash tak terbaca")
    const all = [...listFiles(join(vendorDir, "src"), vendorDir), "package.json"]
      .filter((f) => f !== "test/fakes.ts")
      .sort()
    expect(all.length).toBeGreaterThan(0)
    const h = createHash("sha256")
    for (const f of all) {
      h.update(f)
      h.update("\0")
      h.update(readFileSync(join(vendorDir, f)))
      h.update("\0")
    }
    expect(h.digest("hex").slice(0, 16)).toBe(shipped)
  })

  test("pola files tak melebar ke test/bench/experiments", () => {
    for (const d of ["test/a.ts", "bench/b.ts", "experiments/c.ts"]) {
      expect(coveredByFiles(d)).toBe(false)
    }
  })

  test("tanpa install-time script (no exec saat install)", () => {
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
  })

  test("zero runtime dependencies (klaim paket)", () => {
    expect(pkg.dependencies ?? {}).toEqual({})
  })

  test("subpath #minicore menunjuk ke vendor yang terkemas", () => {
    expect(pkg.imports?.["#minicore"]).toBe("./vendor/minicore/src/core/index.ts")
    expect(pkg.imports?.["#minicore/*"]).toBe("./vendor/minicore/src/*")
    expect(coveredByFiles("vendor/minicore/src/core/index.ts")).toBe(true)
  })
})
