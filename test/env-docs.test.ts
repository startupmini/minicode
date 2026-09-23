// Drift-check F9: tiap MINICODE_* yang dibaca kode produksi (src/ + cli/)
// WAJIB terdokumentasi di docs/environment.md. Temuan audit: 4 knob
// (DEBUG_STARTUP, KEYSTORE_DISABLE, KEYSTORE_FORCE_DPAPI, MINIMIZE_TOOL)
// dipakai di kode tetapi absen dari semua dokumen — knob yang tak
// terdokumentasi = knob yang tak bisa dipakai user dengan benar.
// Pengecualian eksplisit (disertai alasan) ada di EXEMPT, bukan diam-diam.
import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const repoRoot = process.cwd()

/** Variabel yang sengaja tak didokumentasikan + mengapa. */
const EXEMPT = new Map<string, string>([
  // Hanya dipakai test/debug internal; mendokumentasikannya mengundang user
  // mengandalkannya.
  ["MINICODE_DEBUG_BUS", "dump diagnosis event bus khusus pengembang"],
  ["MINICODE_FOOTER", "kunci tampilan footer untuk test render"],
])

test("env MINICODE_* di kode produksi terdokumentasi di docs/environment.md", () => {
  const r = spawnSync("git", ["ls-files", "src", "cli"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  })
  expect(r.status).toBe(0)
  const re = /process\.env\.(MINICODE_[A-Z0-9_]+)/g
  const used = new Set<string>()
  for (const f of r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.endsWith(".ts"))) {
    const src = readFileSync(join(repoRoot, f), "utf8")
    for (const m of src.matchAll(re)) used.add(m[1]!)
  }
  const envDoc = readFileSync(join(repoRoot, "docs/environment.md"), "utf8")
  const missing = [...used].filter((v) => !envDoc.includes(v)).filter((v) => !EXEMPT.has(v))
  expect(missing).toEqual([])
})
