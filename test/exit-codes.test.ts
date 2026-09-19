// Kontrak exit code CLI: 0 sukses/help, 1 gagal runtime, 2 salah pakai.
// Salah pakai = argumen hilang/malformed + subcommand asing (aturan: lookup
// yang gagal — provider/skill/sesi tak dikenal — tetap 1, itu kegagalan
// operasi bukan pemakaian). Subprocess + HOME hermetic (pola
// cli-config-coverage.test.ts) agar DB/config global mesin tak ikut.

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "..")
const entry = join(repoRoot, "cli", "index.ts")

function run(args: string[], cwd: string, home: string) {
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      NO_COLOR: "1",
      MINICODE_HOME: home,
      HOME: home,
      USERPROFILE: home,
    },
  })
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

function hermeticWs() {
  const dir = mkdtempSync(join(tmpdir(), "minicode-exit-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  const home = join(dir, "home")
  mkdirSync(join(home, ".minicode"), { recursive: true })
  return { dir, home }
}

describe("exit code: salah pakai = 2", () => {
  test("tanpa prompt + exec tanpa prompt", () => {
    const { dir, home } = hermeticWs()
    try {
      // Tanpa prompt dan stdin bukan TTY = pemakaian salah, bukan runtime.
      let r = run([], dir, home)
      expect(r.code).toBe(2)
      expect(r.out).toContain("usage:")
      r = run(["exec", "--cwd", dir], dir, home)
      expect(r.code).toBe(2)
      expect(r.out).toContain("usage:")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("subcommand asing di semua handler", () => {
    const { dir, home } = hermeticWs()
    try {
      for (const args of [
        ["sessions", "bogus", "--cwd", dir],
        ["memory", "bogus", "--cwd", dir],
        ["skills", "bogus", "--cwd", dir],
        ["pricing", "bogus", "--cwd", dir],
        ["auth", "bogus", "--cwd", dir],
        ["mcp", "bogus", "--cwd", dir],
        ["config", "bogus", "--cwd", dir],
        ["config", "mcp", "bogus", "--cwd", dir],
        ["config", "lsp", "bogus", "--cwd", dir],
      ]) {
        const r = run(args, dir, home)
        expect(r.code).toBe(2)
        expect(r.out.toLowerCase()).toContain("unknown")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("argumen wajib hilang", () => {
    const { dir, home } = hermeticWs()
    try {
      for (const args of [
        ["sessions", "export", "--cwd", dir],
        ["skills", "show", "--cwd", dir],
        ["pricing", "show", "--cwd", dir],
        ["auth", "logout", "--cwd", dir],
        ["config", "add", "--cwd", dir],
        ["config", "remove", "--cwd", dir],
        ["config", "mcp", "remove", "--cwd", dir],
        ["config", "lsp", "add", "--cwd", dir],
      ]) {
        const r = run(args, dir, home)
        expect(r.code).toBe(2)
        expect(r.out).toContain("usage:")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("exit code: runtime tetap 1, sukses/help tetap 0", () => {
  test("lookup gagal + setup gagal = 1", () => {
    const { dir, home } = hermeticWs()
    try {
      // Lookup gagal = operasi gagal, bukan salah pakai.
      let r = run(["sessions", "export", "tidak-ada", "--cwd", dir], dir, home)
      expect(r.code).toBe(1)
      expect(r.out).toContain("not found")
      r = run(["skills", "show", "ghost", "--cwd", dir], dir, home)
      expect(r.code).toBe(1)
      // Setup gagal (tanpa provider) = runtime.
      r = run(["exec", "--json", "--cwd", dir, "halo"], dir, home)
      expect(r.code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("help + doctor offline = 0", () => {
    const { dir, home } = hermeticWs()
    try {
      expect(run(["--help"], dir, home).code).toBe(0)
      expect(run(["sessions", "--help", "--cwd", dir], dir, home).code).toBe(0)
      expect(run(["doctor", "--cwd", dir], dir, home).code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
