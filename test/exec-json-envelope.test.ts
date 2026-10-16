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
      expect(summary.schema).toBe("minicode.output.v1")
      expect(summary.type).toBe("summary")
      expect(summary.ok).toBe(false)
      expect(summary.error).toMatchObject({ category: "CONFIGURATION_ERROR" })
      expect(String((summary.error as { message: string }).message).length).toBeGreaterThan(0)
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

// ── P11.2: prompt diambil dari argv scoped TANPA token subcommand.
// Tanpa provider, sesi gagal SETELAH prompt dibangun — envelope failure
// tetap memuat prompt yang sama dengan yang dikirim ke model, jadi jalur
// produksi penuh (router → handleExec) teruji tanpa request jaringan.
// Guard lama `args[0] === "exec"` hanya benar bila exec token pertama;
// dengan flag global mendahului, token "exec" + nilai flag bocor ke prompt.
describe("exec: prompt scoping (P11.2)", () => {
  /** Jalankan argv di ws hermetic; "<DIR>" diganti direktori ws. */
  function failurePrompt(argv: string[]): unknown {
    const { dir, home } = hermeticWs()
    try {
      const r = run(
        argv.map((a) => (a === "<DIR>" ? dir : a)),
        dir,
        home,
      )
      expect(r.code).toBe(1)
      const lines = r.stdout.split("\n").filter(Boolean)
      expect(lines.length).toBe(1)
      const summary = JSON.parse(lines[0]!) as Record<string, unknown>
      expect(summary.ok).toBe(false)
      expect(summary.error).toMatchObject({ category: "CONFIGURATION_ERROR" })
      return summary.prompt
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("A/B: exec-first dan flag-first menghasilkan prompt identik", () => {
    expect(failurePrompt(["exec", "--json", "--cwd", "<DIR>", "tugas cepat"])).toBe("tugas cepat")
    expect(failurePrompt(["--json", "exec", "--cwd", "<DIR>", "tugas cepat"])).toBe("tugas cepat")
  })

  test("D: kata exec milik user tidak dipangkas", () => {
    // exec di tengah prompt + sebagai kata pertama prompt.
    expect(failurePrompt(["--json", "exec", "--cwd", "<DIR>", "tugas", "exec", "ulang"])).toBe(
      "tugas exec ulang",
    )
    expect(failurePrompt(["exec", "--json", "--cwd", "<DIR>", "exec", "ulang"])).toBe("exec ulang")
  })
})
