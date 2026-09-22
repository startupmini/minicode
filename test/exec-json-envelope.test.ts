// Regresi F-A audit terminal UI/UX: `exec --json` yang gagal di fase setup
// (tanpa provider, sebelum sesi terbentuk) harus tetap pulang membawa satu
// baris summary ok:false di stdout — bukan stream kosong yang memaksa parser
// CI menebak dari exit code saja. Subprocess + HOME hermetic agar config
// global mesin ini tak ikut terbaca (pola cli-config-coverage.test.ts).

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
      // Hapus kunci provider agar subprocess tidak mencoba request jaringan
      // nyata saat mesin host punya API key terpasang (temuan audit #08).
      OPENAI_API_KEY: undefined,
      AGENT_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      TOKENHARBOR_API_KEY: undefined,
      TH_API_KEY: undefined,
    },
  })
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

function hermeticWs() {
  const dir = mkdtempSync(join(tmpdir(), "minicode-execenv-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  const home = join(dir, "home")
  mkdirSync(join(home, ".minicode"), { recursive: true })
  return { dir, home }
}

describe("exec --json: kegagalan setup membawa envelope", () => {
  test("tanpa provider -> stdout 1 baris summary ok:false + exit 1", () => {
    const { dir, home } = hermeticWs()
    try {
      // Flag sebelum prompt (konvensi CLI: flag setelah kata prompt = teks).
      const r = run(["exec", "--json", "--cwd", dir, "halo"], dir, home)
      expect(r.code).toBe(1)
      const lines = r.stdout.split("\n").filter(Boolean)
      expect(lines.length).toBe(1)
      const summary = JSON.parse(lines[0]!) as Record<string, unknown>
      expect(summary.type).toBe("summary")
      expect(summary.ok).toBe(false)
      expect(typeof summary.error).toBe("string")
      expect(String(summary.error).length).toBeGreaterThan(0)
      expect(summary.prompt).toBe("halo")
      // Jalur manusia tidak berubah: pesan tetap di stderr.
      expect(r.stderr).toContain("no provider configured")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("tanpa --json -> stdout tetap kosong (perilaku lama)", () => {
    const { dir, home } = hermeticWs()
    try {
      const r = run(["exec", "--cwd", dir, "halo"], dir, home)
      expect(r.code).toBe(1)
      expect(r.stdout).toBe("")
      expect(r.stderr).toContain("no provider configured")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
