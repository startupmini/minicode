#!/usr/bin/env bun
// Sinkronkan kernel MiniCore ke vendor/minicore/ supaya `bun install` jalan
// tanpa clone sibling ../minicore.
//
// MiniCode membawa satu overlay aditif untuk admission context per model dan
// system prompt dinamis. Overlay disimpan sebagai patch terukur, supaya
// sinkronisasi dari sumber resmi tidak menghapus seam yang dipakai runtime.
//
// Usage:
//   bun scripts/vendor-minicore.ts          # sync dari ../minicore + overlay
//   bun scripts/vendor-minicore.ts --check  # verifikasi source, overlay, dan pin

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { SHIPPED_EXCLUDE, vendorFileHash, vendorShippedHash } from "../test/helpers/vendor-hash.ts"

const repoRoot = resolve(import.meta.dir, "..")
const source = process.env.MINICODE_MINICORE_SOURCE
  ? resolve(process.env.MINICODE_MINICORE_SOURCE)
  : resolve(repoRoot, "..", "minicore")
const target = resolve(repoRoot, "vendor", "minicore")
const overlay = resolve(repoRoot, "scripts", "vendor-overlays", "minicode-context.patch")
const overlayRepoPath = "scripts/vendor-overlays/minicode-context.patch"
const checkOnly = process.argv.includes("--check")

// Hanya yang dibutuhkan runtime + fixture test yang dipakai test minicode.
// Test/docs/experiments MiniCore lainnya tetap di repo asal.
const INCLUDE_DIRS = ["src"]
const INCLUDE_FILES = ["package.json", "LICENSE", "test/fakes.ts"]

function listFiles(dir: string, base: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listFiles(full, base, out)
    else out.push(relative(base, full).replace(/\\/g, "/"))
  }
  return out
}

function collect(root: string): string[] {
  const files: string[] = []
  for (const d of INCLUDE_DIRS) files.push(...listFiles(join(root, d), root))
  for (const f of INCLUDE_FILES) if (existsSync(join(root, f))) files.push(f)
  return files.sort()
}

function sourceHead(root: string): string | null {
  const r = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })
  return r.status === 0 ? r.stdout.trim() : null
}

function readPin(): {
  sourceCommit: string | null
  sourceHash: string | null
  files: number | null
  hash: string | null
  shippedHash: string | null
  overlayHash: string | null
} {
  try {
    const md = readFileSync(join(target, "VENDOR.md"), "utf8")
    const number = (pattern: RegExp): number | null => {
      const value = pattern.exec(md)?.[1]
      return value ? Number(value) : null
    }
    return {
      sourceCommit: /^- source commit: `([0-9a-f]+)`/m.exec(md)?.[1] ?? null,
      sourceHash: /^- source hash: `([0-9a-f]+)`/m.exec(md)?.[1] ?? null,
      files: number(/^- files: (\d+)/m),
      hash: /^- hash: `([0-9a-f]+)`/m.exec(md)?.[1] ?? null,
      shippedHash: /^- shipped hash: `([0-9a-f]+)`/m.exec(md)?.[1] ?? null,
      overlayHash: /^- overlay sha256: `([0-9a-f]+)`/m.exec(md)?.[1] ?? null,
    }
  } catch {
    return {
      sourceCommit: null,
      sourceHash: null,
      files: null,
      hash: null,
      shippedHash: null,
      overlayHash: null,
    }
  }
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function stageFiles(fromRoot: string, files: string[]): string {
  const staged = mkdtempSync(join(tmpdir(), "minicode-minicore-stage-"))
  for (const f of files) {
    const to = join(staged, f)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(join(fromRoot, f), to)
  }
  return staged
}

function applyOverlay(root: string): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(overlay)) return { ok: false, reason: `overlay hilang: ${overlayRepoPath}` }
  // Patch tanpa konteks meminimalkan whitespace bising. Hash source di bawah
  // wajib cocok dengan pin sebelum patch boleh diterapkan.
  const r = spawnSync("git", ["apply", "--unidiff-zero", "-p3", overlay], {
    cwd: root,
    encoding: "utf8",
  })
  if (r.status === 0) return { ok: true }
  return { ok: false, reason: (r.stderr || r.stdout || "git apply gagal").trim() }
}

function noSourceVerdict(): { message: string; synced: boolean } {
  const files = collect(target)
  const currentHash = vendorFileHash(target, files)
  const pin = readPin()
  const currentOverlayHash = existsSync(overlay) ? fileSha256(overlay) : null
  const synced =
    pin.files === files.length && pin.hash === currentHash && pin.overlayHash === currentOverlayHash
  const verdict = synced
    ? `sinkron dengan pin (${currentHash})`
    : `TIDAK sinkron dengan pin (kerja ${currentHash}, tercatat ${pin.hash ?? "-"})`
  return { message: `(${files.length} file, ${currentHash}) — ${verdict}`, synced }
}

function failCheck(message: string): never {
  console.error(`[vendor] TIDAK sinkron — ${message}`)
  console.error("[vendor] jalankan: bun run vendor:minicore")
  process.exit(1)
}

const vendorFiles = collect(target)
const pin = readPin()
const overlayHash = existsSync(overlay) ? fileSha256(overlay) : null

if (!existsSync(source)) {
  const verdict = noSourceVerdict()
  console.log(
    `[vendor] ../minicore tidak ada — memakai vendor/minicore yang sudah ada ${verdict.message}`,
  )
  if (checkOnly && !verdict.synced) process.exit(1)
  if (vendorFiles.length === 0) {
    console.error("[vendor] vendor/minicore kosong — tidak bisa lanjut")
    process.exit(1)
  }
  process.exit(0)
}

const sourceFiles = collect(source)
if (sourceFiles.length === 0) {
  const verdict = noSourceVerdict()
  console.log(
    `[vendor] source ${source} kosong — memakai vendor/minicore yang sudah ada ${verdict.message}`,
  )
  if (checkOnly && !verdict.synced) process.exit(1)
  if (vendorFiles.length === 0) {
    console.error(`[vendor] tidak ada file untuk disalin dari ${source}`)
    process.exit(1)
  }
  process.exit(0)
}

const sourceCommit = sourceHead(source)
const sourceHash = vendorFileHash(source, sourceFiles)
const vendorHash = vendorFileHash(target, vendorFiles)
const sameSet =
  sourceFiles.length === vendorFiles.length && sourceFiles.every((f, i) => f === vendorFiles[i])

if (checkOnly) {
  if (sourceCommit && pin.sourceCommit && sourceCommit !== pin.sourceCommit) {
    failCheck(`source commit ${sourceCommit} berbeda dari pin ${pin.sourceCommit}`)
  }
  if (pin.overlayHash !== overlayHash) {
    failCheck(
      `fingerprint overlay ${overlayHash ?? "-"} berbeda dari pin ${pin.overlayHash ?? "-"}`,
    )
  }
  if (
    sameSet &&
    sourceHash === vendorHash &&
    pin.files === vendorFiles.length &&
    pin.hash === vendorHash
  ) {
    console.log(
      `[vendor] sinkron (${vendorFiles.length} file, ${vendorHash}; source ${sourceCommit ?? "fixture"})`,
    )
    process.exit(0)
  }

  // Sumber upstream dipin tanpa overlay; periksa salinan sementara agar
  // `--check` tetap read-only. Fixture test yang sudah identik dengan vendor
  // lolos jalur hash langsung di atas.
  const sourceMatchesPin =
    pin.sourceHash === sourceHash && (!sourceCommit || sourceCommit === pin.sourceCommit)
  if (sourceMatchesPin && sameSet) {
    const staged = stageFiles(source, sourceFiles)
    let overlayMatches = false
    let overlayFailure: string | null = null
    try {
      const applied = applyOverlay(staged)
      if (!applied.ok) {
        overlayFailure = applied.reason
      } else {
        const expectedFiles = collect(staged)
        const expectedHash = vendorFileHash(staged, expectedFiles)
        overlayMatches =
          expectedFiles.length === vendorFiles.length &&
          expectedFiles.every((f, i) => f === vendorFiles[i]) &&
          expectedHash === vendorHash &&
          pin.files === vendorFiles.length &&
          pin.hash === vendorHash
      }
    } finally {
      rmSync(staged, { recursive: true, force: true })
    }
    if (overlayMatches) {
      console.log(
        `[vendor] sinkron dengan overlay (${vendorFiles.length} file, ${vendorHash}; source ${sourceCommit})`,
      )
      process.exit(0)
    }
    if (overlayFailure)
      failCheck(`overlay tidak bisa diterapkan pada ${sourceCommit}: ${overlayFailure}`)
  }
  failCheck(
    `source ${sourceFiles.length}/${sourceHash} vs vendor ${vendorFiles.length}/${vendorHash}`,
  )
}

// Siapkan source + overlay di temp dulu. Kalau patch tidak cocok, vendor yang
// sedang dipakai aplikasi tidak berubah setengah jalan.
const staged = stageFiles(source, sourceFiles)
try {
  if (sourceHash !== vendorHash) {
    const sourceMatchesPin =
      pin.sourceHash === sourceHash && (!sourceCommit || sourceCommit === pin.sourceCommit)
    if (!sourceMatchesPin) {
      rmSync(staged, { recursive: true, force: true })
      console.error(
        `[vendor] source ${sourceHash} bukan base yang dipin (${pin.sourceHash ?? "-"}); rebase overlay sebelum sync`,
      )
      process.exit(1)
    }
    const applied = applyOverlay(staged)
    if (!applied.ok) {
      rmSync(staged, { recursive: true, force: true })
      console.error(
        `[vendor] overlay tidak bisa diterapkan pada ${sourceCommit ?? "source tanpa commit"}: ${applied.reason}`,
      )
      process.exit(1)
    }
  }

  const stagedFiles = collect(staged)
  const stagedHash = vendorFileHash(staged, stagedFiles)
  const stagedShippedHash = vendorShippedHash(staged, stagedFiles)
  const head = sourceCommit ?? "unknown"
  let written = 0

  for (const f of vendorFiles) {
    if (stagedFiles.includes(f)) continue
    unlinkSync(join(target, f))
    written++
  }
  for (const f of stagedFiles) {
    const from = join(staged, f)
    const to = join(target, f)
    const next = readFileSync(from)
    if (existsSync(to) && statSync(to).size === next.length && readFileSync(to).equals(next))
      continue
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, next)
    written++
  }

  writeFileSync(
    join(target, "VENDOR.md"),
    [
      "# vendor/minicore — JANGAN EDIT MANUAL",
      "",
      "Salinan MiniCore dari source commit yang dipin, ditambah overlay host yang",
      "diperiksa dari patch di `scripts/vendor-overlays/minicode-context.patch`.",
      "Overlay memberi admission context per model dan system prompt dinamis;",
      "simpan seam ini saat menyinkronkan source upstream.",
      "",
      `- source commit: \`${head}\``,
      `- source hash: \`${sourceHash}\``,
      `- overlay sha256: \`${overlayHash ?? "-"}\``,
      `- files: ${stagedFiles.length}`,
      `- hash: \`${stagedHash}\``,
      `- shipped hash: \`${stagedShippedHash}\` (${stagedFiles.length - SHIPPED_EXCLUDE.size} file) — fingerprint file vendor yang ikut paket npm`,
      "  (hash di atas mencakup test/fakes.ts yang sengaja tidak ikut paket;",
      "   verifikasi dari paket terbit: hitung hash vendor/minicore di dalam tarball)",
      "",
      "Perbarui dengan `bun run vendor:minicore` (butuh `../minicore`).",
      "`bun run vendor:check` memverifikasi source, overlay, dan fingerprint final.",
      "",
    ].join("\n"),
  )

  console.log(
    `[vendor] ${written} file diperbarui dari ${source} + overlay (${stagedFiles.length} total, ${sourceHash} -> ${stagedHash})`,
  )
} finally {
  rmSync(staged, { recursive: true, force: true })
}
