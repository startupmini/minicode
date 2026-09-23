// Penjaga peta struktur hidup (audit F6): tiap berkas src/** yang terlacak git
// WAJIB muncul di docs/ARCHITECTURE.html, DAN pin kernel di peta WAJIB sinkron
// dengan vendor/minicore/VENDOR.md. Dua arah drift sudah pernah terjadi —
// src/ui/runtime/motion.ts (berkas baru) tidak ada di peta, dan pin kernel
// `ae9d1be` vs source commit `0d33571` di VENDOR.md. AGENTS.md mewajibkan peta
// diperbarui saat struktur berubah; tanpa penjaga mesin, "wajib" = doa.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const repoRoot = process.cwd()

function trackedFiles(pattern: RegExp): string[] {
  const r = spawnSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 })
  if (r.status !== 0) return []
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => pattern.test(s))
}

describe("peta struktur hidup (docs/ARCHITECTURE.html)", () => {
  test("tiap berkas src/** muncul di peta (per nama berkas)", () => {
    const html = readFileSync(join(repoRoot, "docs/ARCHITECTURE.html"), "utf8")
    const files = trackedFiles(/^src\/.*\.ts$/)
    expect(files.length).toBeGreaterThan(100)
    const missing = files.filter((f) => !html.includes(f.split("/").pop()!))
    expect(missing).toEqual([])
  })

  test("pin kernel di peta sinkron dengan VENDOR.md", () => {
    const vendor = readFileSync(join(repoRoot, "vendor/minicore/VENDOR.md"), "utf8")
    const short = /source commit: `([0-9a-f]{7})/.exec(vendor)?.[1]
    expect(short).toBeTruthy()
    const html = readFileSync(join(repoRoot, "docs/ARCHITECTURE.html"), "utf8")
    expect(html).toContain(`kernel ${short}`)
  })
})
