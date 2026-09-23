#!/usr/bin/env bun
// Gate distribusi: pastikan tarball npm memuat semua yang dibutuhkan runtime
// dan TIDAK memuat rahasia atau sampah.
//
// Kenapa perlu gate, bukan sekadar `npm pack`? Field `files` mudah tertinggal
// saat file baru ditambahkan — dan kegagalannya hanya muncul setelah publish,
// saat user pertama menjalankan `minicode` dan mendapat "Cannot find module".
// Script ini membangun daftar file yang benar-benar ikut, lalu memverifikasi:
//
//   1. Setiap import runtime dari `cli/` dan `src/` bisa di-resolve di tarball.
//   2. Tidak ada berkas rahasia/artifact (.env, auth.json, *.db, .tgz, .minicode).
//   3. `bin` menunjuk file yang ikut terkemas.
//   4. Vendor kernel lengkap (tanpa itu `bun install` bersih akan gagal).
//   5. Ukuran wajar — deteksi kalau `node_modules` atau test ikut terbawa.
//
// Usage: bun scripts/pack-check.ts [--verbose]

// `@lydell/node-pty` DIPIN EKSAK (tanpa caret; lihat `bun.lock`):
// modul native berprebuild per platform; versi beta berikutnya butuh validasi
// probe PTY ulang di Linux + Windows sebelum diadopsi. Tetap devDependency
// end-user `npm install -g` tidak boleh ikut mengunduh biner native test-only.
// (JSON tak mengizinkan komentar — catatan ini hidup di sini agar alasan pin
// tetap tercatat; salinan ringkasnya ada di docs/contributing.md.)
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const VERBOSE = process.argv.includes("--verbose")
const repoRoot = resolve(import.meta.dir, "..")

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++
    if (VERBOSE) console.log(`  ok    ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

// ── daftar file yang akan ikut ──
// `npm pack --dry-run --json` memberi daftar pasti. Bila npm tak ada, hitung
// sendiri dari `files` — kurang akurat tapi lebih baik daripada tak memeriksa.
interface PackFile {
  path: string
}

function filesFromNpm(): string[] | null {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    shell: process.platform === "win32",
  })
  if (r.status !== 0 || !r.stdout.trim()) return null
  try {
    const parsed = JSON.parse(r.stdout) as { files?: PackFile[] }[]
    const files = parsed[0]?.files
    if (!Array.isArray(files)) return null
    return files.map((f) => f.path.replace(/\\/g, "/"))
  } catch {
    return null
  }
}

const npmFiles = filesFromNpm()
if (!npmFiles) {
  console.error("[pack-check] `npm pack --dry-run --json` gagal — tidak bisa memverifikasi tarball")
  console.error("[pack-check] pastikan npm tersedia di PATH")
  process.exit(1)
}

console.log(`\n=== PACK CHECK ===\n${npmFiles.length} file akan ikut dalam tarball\n`)

const packed = new Set(npmFiles)
const inPack = (p: string): boolean => packed.has(p.replace(/\\/g, "/"))

// ── 1. entry point ──
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  bin?: Record<string, string>
  files?: string[]
}
const binPaths = Object.values(pkg.bin ?? {}).map((p) => p.replace(/^\.\//, ""))
check("bin terdefinisi", binPaths.length > 0)
for (const b of binPaths) {
  check(`bin "${b}" ikut terkemas`, inPack(b))
}

// ── 2. resolusi import runtime ──
// Telusuri graf import dari tiap entry, dan pastikan semua target relatif ikut.
// Import bare (`minicore`, `node:*`, `bun:*`) diperiksa terpisah.
const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["'](\.[^"']+)["']/g
const DYNAMIC_IMPORT = /import\(\s*["'](\.[^"']+)["']\s*\)/g
const BARE_IMPORT = /from\s+["'](minicore(?:\/[^"']*)?)["']/g

function readIfPacked(rel: string): string | null {
  if (!inPack(rel)) return null
  const abs = join(repoRoot, rel)
  return existsSync(abs) ? readFileSync(abs, "utf8") : null
}

const visited = new Set<string>()
const missing: { from: string; target: string }[] = []
const bareTargets = new Set<string>()

function walk(rel: string): void {
  const norm = rel.replace(/\\/g, "/")
  if (visited.has(norm)) return
  visited.add(norm)
  const src = readIfPacked(norm)
  if (src === null) return

  const dir = norm.split("/").slice(0, -1).join("/")
  const collect = (re: RegExp) => {
    re.lastIndex = 0
    let m: RegExpExecArray | null = re.exec(src)
    while (m !== null) {
      const spec = m[1]!
      const target = relative(repoRoot, resolve(repoRoot, dir, spec)).replace(/\\/g, "/")
      if (!inPack(target)) missing.push({ from: norm, target })
      else walk(target)
      m = re.exec(src)
    }
  }
  collect(RELATIVE_IMPORT)
  collect(DYNAMIC_IMPORT)

  BARE_IMPORT.lastIndex = 0
  let b: RegExpExecArray | null = BARE_IMPORT.exec(src)
  while (b !== null) {
    bareTargets.add(b[1]!)
    b = BARE_IMPORT.exec(src)
  }
}

for (const b of binPaths) walk(b)

check(
  `graf import lengkap (${visited.size} modul ditelusuri)`,
  missing.length === 0,
  missing
    .slice(0, 5)
    .map((m) => `${m.from} → ${m.target}`)
    .join("; "),
)

// ── 3. vendor kernel ──
// Semua spesifier `minicore/...` harus ada di vendor yang terkemas.
const vendorMissing: string[] = []
for (const spec of bareTargets) {
  const sub = spec === "minicore" ? "src/core/index.ts" : spec.replace(/^minicore\//, "src/")
  const vendorPath = `vendor/minicore/${sub}`
  if (!inPack(vendorPath)) vendorMissing.push(`${spec} → ${vendorPath}`)
}
check(
  `vendor kernel lengkap (${bareTargets.size} spesifier)`,
  vendorMissing.length === 0,
  vendorMissing.slice(0, 5).join("; "),
)
check("vendor/minicore/package.json ikut", inPack("vendor/minicore/package.json"))

// ── 4. tidak ada rahasia / sampah ──
// Pola ini yang paling sering bocor lewat npm: berkas kredensial, database
// lokal, artifact build, dan direktori state.
const FORBIDDEN: [RegExp, string][] = [
  [/(^|\/)\.env(\.|$)/i, "berkas env"],
  [/(^|\/)auth\.json$/i, "kredensial OAuth"],
  [/(^|\/)pricing\.json$/i, "cache lokal"],
  [/\.db$|\.db-wal$|\.db-shm$/i, "database sqlite"],
  [/\.tgz$/i, "artifact npm pack"],
  [/(^|\/)\.minicode\//i, "direktori state"],
  [/(^|\/)node_modules\//i, "dependensi"],
  [/(^|\/)\.git\//i, "metadata git"],
  [/(^|\/)test\//i, "berkas test"],
  [/(^|\/)experiments\//i, "eksperimen"],
  [/(^|\/)bench\//i, "benchmark"],
  [/(^|\/)\.tmp-/i, "direktori sementara"],
  [/id_rsa|\.pem$|\.p12$|\.pfx$/i, "kunci privat"],
  [/(^|\/)traces\.jsonl$/i, "telemetry"],
]
for (const [re, label] of FORBIDDEN) {
  const hits = npmFiles.filter((f) => re.test(f))
  check(`tidak memuat ${label}`, hits.length === 0, hits.slice(0, 3).join(", "))
}

// ── 5. dokumentasi minimal ──
for (const doc of ["README.md", "LICENSE"]) {
  check(`${doc} ikut`, inPack(doc))
}

// ── 5b. tautan dokumen relatif ──
// Temuan audit F4: tarball hanya membawa 4 berkas docs, sementara README.md
// menautkan getting-started/quickstart/choosing-mode dan docs/README.md
// menautkan 23 halaman sibling — semuanya 404 bagi pembaca paket lokal
// (node_modules) dan bagi apa pun yang membaca tarball. Gate ini menjaga janji
// "dokumen yang dikirim bisa dibaca": setiap tautan relatif antar-berkas .md
// di markdown yang IKUT paket harus menunjuk berkas yang juga ikut.
const MD_LINK = /\]\(([^)\s#]+\.md)\)/g
const docLinkMissing: string[] = []
for (const f of npmFiles) {
  if (!f.endsWith(".md")) continue
  const src = readIfPacked(f)
  if (src === null) continue
  const dir = f.split("/").slice(0, -1).join("/")
  MD_LINK.lastIndex = 0
  let m: RegExpExecArray | null = MD_LINK.exec(src)
  while (m !== null) {
    const raw = m[1]!
    if (!/^(https?:|mailto:)/.test(raw)) {
      const target = relative(repoRoot, resolve(repoRoot, dir, raw)).replace(/\\/g, "/")
      if (!inPack(target)) docLinkMissing.push(`${f} → ${raw}`)
    }
    m = MD_LINK.exec(src)
  }
}
check(
  "tautan dokumen relatif menunjuk berkas yang ikut paket",
  docLinkMissing.length === 0,
  docLinkMissing.slice(0, 5).join("; ") +
    (docLinkMissing.length > 5 ? ` (+${docLinkMissing.length - 5} lagi)` : ""),
)

// ── 6. ukuran wajar ──
const sizeR = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: 120_000,
  shell: process.platform === "win32",
})
let unpackedKb = 0
try {
  const parsed = JSON.parse(sizeR.stdout) as { unpackedSize?: number }[]
  unpackedKb = Math.round((parsed[0]?.unpackedSize ?? 0) / 1024)
} catch {}
console.log(`\nukuran unpacked: ${unpackedKb} KB`)
check(
  "ukuran di bawah 2 MB (tak ada node_modules/test terbawa)",
  unpackedKb < 2048,
  `${unpackedKb} KB`,
)

// ── ringkasan ──
console.log(`\n=== HASIL ===\npass ${pass} · fail ${fail}`)
if (failures.length) {
  console.log("\nkegagalan:")
  for (const f of failures) console.log(`  - ${f}`)
  console.log("\nPerbaiki `files` di package.json, lalu jalankan ulang.")
}
process.exit(fail === 0 ? 0 : 1)
