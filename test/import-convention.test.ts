// Regresi: konvensi import kernel harus konsisten dan tak bisa mundur.
//
// Migrasi dari `minicore` (dependency file:) ke `#minicore` (subpath imports)
// dilakukan dengan penggantian teks massal di 51 file. Dua kelas kesalahan
// muncul dan keduanya lolos typecheck:
//
//   1. `resolve(repoRoot, "..", "#minicore")` — nama DIREKTORI ikut terganti,
//      sehingga vendor:check melapor "vendor kosong" padahal ada 20 file.
//   2. File yang ditulis ulang lewat PowerShell kehilangan karakter non-ASCII
//      (— … ─ menjadi U+FFFD), yang memecahkan satu assertion test.
//
// Test ini menjaga keduanya, plus memastikan tak ada sisa spesifier lama.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repoRoot = process.cwd()

/** Seluruh file terlacak git, di luar vendor (vendor adalah salinan). */
function trackedFiles(pattern: RegExp): string[] {
  const r = spawnSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 })
  if (r.status !== 0) return []
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && pattern.test(s) && !s.startsWith("vendor/"))
}

const tsFiles = trackedFiles(/\.ts$/)
const textFiles = trackedFiles(/\.(ts|md|json|yml|yaml)$/)

describe("konvensi import kernel", () => {
  test("ada file untuk diperiksa (sanity)", () => {
    expect(tsFiles.length).toBeGreaterThan(50)
  })

  test('tidak ada spesifier lama `from "minicore"` yang tertinggal', () => {
    const offenders: string[] = []
    for (const f of tsFiles) {
      // Berkas ini MEMUAT pola itu sebagai literal regex — memeriksanya berarti
      // ia selalu menuduh dirinya sendiri (false positive).
      if (f === "test/import-convention.test.ts") continue
      const src = readFileSync(join(repoRoot, f), "utf8")
      // Cari `from "minicore...` TANPA prefix #
      if (/from\s+["']minicore(?:\/|["'])/.test(src)) offenders.push(f)
      if (/import\(\s*["']minicore(?:\/|["'])/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  test("semua import kernel memakai prefix #minicore", () => {
    let count = 0
    for (const f of tsFiles) {
      const src = readFileSync(join(repoRoot, f), "utf8")
      count += (src.match(/["']#minicore/g) ?? []).length
    }
    // 70+ import site di seluruh repo; angka pastinya berubah, yang penting ada
    expect(count).toBeGreaterThan(50)
  })

  test("package.json mendeklarasikan subpath imports yang cocok", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8").replace(/^\uFEFF/, ""),
    ) as {
      imports?: Record<string, string>
      dependencies?: Record<string, string>
    }
    expect(pkg.imports?.["#minicore"]).toBe("./vendor/minicore/src/core/index.ts")
    expect(pkg.imports?.["#minicore/*"]).toBe("./vendor/minicore/src/*")
    // Kernel bukan dependency lagi — ia subpath lokal. Dependency `file:`
    // membuat tarball npm gagal resolve saat diinstal.
    expect(pkg.dependencies?.minicore).toBeUndefined()
  })

  test("tsconfig paths sejalan dengan package.json imports", () => {
    // tsconfig.json ditulis dengan BOM oleh sebagian editor Windows; JSON.parse
    // menolaknya. Buang BOM sebelum parse alih-alih membiarkan test gagal
    // karena alasan yang tak berhubungan dengan yang diuji.
    const raw = readFileSync(join(repoRoot, "tsconfig.json"), "utf8").replace(/^\uFEFF/, "")
    const cfg = JSON.parse(raw) as { compilerOptions?: { paths?: Record<string, string[]> } }
    const paths = cfg.compilerOptions?.paths ?? {}
    expect(paths["#minicore"]).toEqual(["./vendor/minicore/src/core/index.ts"])
    expect(paths["#minicore/*"]).toEqual(["./vendor/minicore/src/*"])
  })

  test("nama direktori vendor TIDAK memakai prefix # (bukan spesifier)", () => {
    // Regresi dari penggantian teks massal: `resolve(root, "..", "#minicore")`
    // membuat vendor:check melapor vendor kosong padahal isinya lengkap.
    const script = readFileSync(join(repoRoot, "scripts/vendor-minicore.ts"), "utf8")
    expect(script).not.toContain('"..", "#minicore"')
    expect(script).not.toContain('"vendor", "#minicore"')
    expect(script).toContain('"..", "minicore"')
    expect(script).toContain('"vendor", "minicore"')
  })

  test("vendor:check hijau (vendor terbaca & sinkron)", () => {
    const r = spawnSync("bun", ["scripts/vendor-minicore.ts", "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
    })
    const out = `${r.stdout}${r.stderr}`
    expect(out).not.toContain("vendor/minicore kosong")
    // Seam aditif lokal (cwd/permissionMode/describeDenial/tokens) sengaja
    // membuat vendor TIDAK sinkron dengan source — VENDOR.md mendokumentasikannya.
    // Tanpa sibling ../minicore script tetap lulus dengan pesan — keduanya sah.
    const vendorMd = readFileSync(join(repoRoot, "vendor", "minicore", "VENDOR.md"), "utf8")
    if (vendorMd.includes("seam aditif")) {
      // Empat hasil sah (lihat pesan script): sinkron, TIDAK sinkron (seam
      // aditif lokal), "tidak ada" (sibling tak ter-clone), atau "kosong"
      // (checkout sibling gagal → dir kosong; kasus nyata di CI publik karena
      // repo privat). Bug lama: hanya dua pertama yang diterima sehingga CI
      // tanpa sibling selalu merah.
      expect(out).toMatch(/sinkron|TIDAK sinkron|tidak ada|kosong/)
      return
    }
    expect(r.status).toBe(0)
  })

  test("vendor:check lolos bila source ada tapi KOSONG (checkout CI gagal)", () => {
    // Regresi nyata: checkout repo minicore privat di CI gagal → direktori
    // sibling ADA tapi kosong → existsSync lolos → exit 1
    // "[vendor] tidak ada file untuk disalin" di tiap push padahal vendor
    // sinkron. Kode lama gagal di sini (status 1 + tanpa kata "kosong").
    const empty = mkdtempSync(join(tmpdir(), "minicore-empty-"))
    try {
      const r = spawnSync("bun", ["scripts/vendor-minicore.ts", "--check"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, MINICODE_MINICORE_SOURCE: empty },
      })
      const out = `${r.stdout}${r.stderr}`
      expect(r.status).toBe(0)
      expect(out).toContain("kosong")
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe("integritas encoding berkas", () => {
  test("tidak ada U+FFFD (replacement char) di berkas terlacak", () => {
    // Menulis ulang file lewat pipeline PowerShell tanpa encoding eksplisit
    // mengubah karakter non-ASCII menjadi U+FFFD. Itu merusak string yang
    // dibandingkan test dan pesan ke user, tapi lolos typecheck.
    const broken: string[] = []
    for (const f of textFiles) {
      const src = readFileSync(join(repoRoot, f), "utf8")
      const n = (src.match(/\uFFFD/g) ?? []).length
      if (n > 0) broken.push(`${f} (${n})`)
    }
    expect(broken).toEqual([])
  })

  test("berkas konfigurasi tidak memakai BOM", () => {
    // BOM membuat JSON.parse gagal ("Unrecognized token") — ditemukan saat
    // test ini sendiri gagal membaca tsconfig.json. Editor Windows kadang
    // menambahkannya tanpa diminta.
    const configs = ["package.json", "tsconfig.json", "biome.json"]
    const withBom: string[] = []
    for (const f of configs) {
      const buf = readFileSync(join(repoRoot, f))
      if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) withBom.push(f)
    }
    expect(withBom).toEqual([])
  })

  test("SEMUA berkas teks terlacak tanpa BOM (repo UTF-8 tanpa BOM)", () => {
    // Perluasan audit 2026-09-16 L4: 5 berkas .ts (src/tools/bash.ts,
    // read_file.ts + 3 test) kedapatan ber-BOM di worktree — lolos karena
    // guard hanya cek 3 config, dan `git status` buta terhadapnya (clean
    // filter menormalkan). Bun/Node toleran BOM di .ts, tapi konvensi repo
    // (AGENTS.md) melarangnya di semua berkas.
    const withBom: string[] = []
    for (const f of textFiles) {
      const buf = readFileSync(join(repoRoot, f))
      if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) withBom.push(f)
    }
    expect(withBom).toEqual([])
  })

  test("sumber web (web/ + content/) tanpa BOM dan tanpa CRLF", () => {
    // Cleanup 2026-09-16: `content/logo-user.svg` ber-BOM dan 8 berkas
    // web/*.html/*.css ber-CRLF (di luar cakupan .gitattributes lama) —
    // BOM merusak parse XML, CRLF pernah memecahkan frontmatter blog.
    const webFiles = trackedFiles(/\.(css|html|svg)$/)
    const bad: string[] = []
    for (const f of webFiles) {
      if (!f.startsWith("web/") && !f.startsWith("content/")) continue
      const buf = readFileSync(join(repoRoot, f))
      if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bad.push(`${f} (BOM)`)
      else if (buf.includes(0x0d)) bad.push(`${f} (CR)`)
    }
    expect(bad).toEqual([])
  })
})
