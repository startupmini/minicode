// Test subcommand CLI: help kontekstual, exit code, dan --json.
//
// Sebelumnya `config`, `config mcp`, `config lsp`, dan `mcp` tanpa argumen
// mencetak HELP global 45 baris lalu exit 0 — user tidak tahu apa yang salah dan
// skrip tidak bisa mendeteksi kesalahan pemakaian.

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "..")
const entry = join(repoRoot, "cli", "index.ts")

interface Run {
  code: number
  stdout: string
  stderr: string
  out: string
}

function run(args: string[], cwd = repoRoot): Run {
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  })
  const stdout = r.stdout ?? ""
  const stderr = r.stderr ?? ""
  return { code: r.status ?? -1, stdout, stderr, out: stdout + stderr }
}

describe("cli: versi", () => {
  test("--version mencetak versi dari package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8").replace(/^\uFEFF/, ""),
    ) as { version: string }
    const r = run(["--version"])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe(pkg.version)
  })

  test("-v sama dengan --version", () => {
    expect(run(["-v"]).stdout.trim()).toBe(run(["--version"]).stdout.trim())
  })

  test("--help --json memuat versi yang sama", () => {
    const r = run(["--help", "--json"])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout) as { version: string; options: unknown[] }
    expect(parsed.version).toBe(run(["--version"]).stdout.trim())
    expect(parsed.options.length).toBeGreaterThan(5)
  })

  test("--tui dicatat usang di help teks + help JSON", () => {
    // Temuan audit F8: flag yang diterima tapi diam = user mengira ia bekerja.
    const r = run(["--help"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("--tui")
    expect(r.stdout).toContain("deprecated")
    const j = JSON.parse(run(["--help", "--json"]).stdout) as {
      options: { flag: string; desc: string }[]
    }
    const tui = j.options.find((o) => o.flag === "--tui")
    expect(tui?.desc).toMatch(/deprecated/i)
  })

  test("--help menyebut binding baru (Home/End, setengah halaman, keluar dua-tap)", () => {
    const r = run(["--help"])
    expect(r.stdout).toContain("Home/End")
    expect(r.stdout).toContain("half page")
    expect(r.stdout).toContain("twice = quit")
  })

  test("--tui memicu peringatan deprecation di stderr, exit tetap sepadan", () => {
    // Peringatan hanya di stderr (kontrak stdout bersih untuk machine-readable).
    const withTui = run(["--help", "--tui"])
    expect(withTui.stderr).toContain("[deprecated] --tui")
    expect(withTui.stdout).toContain("Minicode - coding agent")
    expect(withTui.code).toBe(0)
  })
})

describe("cli: help kontekstual + exit code", () => {
  // Tanpa argumen = user meminta petunjuk -> exit 0, help spesifik.
  // Catatan: `pricing` dan `auth` tanpa argumen punya default berguna
  // (`pricing` -> status), jadi help-nya diminta lewat --help.
  const contextual: [string[], string][] = [
    [["config"], "minicode config"],
    [["config", "mcp"], "minicode config mcp"],
    [["config", "lsp"], "minicode config lsp"],
    [["mcp"], "minicode mcp"],
    [["skills", "--help"], "minicode skills"],
    [["sessions", "--help"], "minicode sessions"],
    [["pricing", "--help"], "minicode pricing"],
    [["auth"], "minicode auth"],
  ]
  for (const [args, expected] of contextual) {
    test(`${args.join(" ")} -> help spesifik, exit 0`, () => {
      const r = run(args)
      expect(r.code).toBe(0)
      expect(r.out).toContain(expected)
      // Bukan HELP global: tidak memuat daftar Options lengkap.
      expect(r.out).not.toContain("--context-window")
    })
  }

  // Subcommand asing = salah pakai -> exit 2 supaya skrip bisa mendeteksi
  // dan membedakannya dari gagal runtime (exit 1).
  const unknown: string[][] = [
    ["config", "bogus"],
    ["config", "mcp", "bogus"],
    ["config", "lsp", "bogus"],
    ["mcp", "bogus"],
    ["skills", "bogus"],
    ["sessions", "bogus"],
    ["pricing", "bogus"],
    ["auth", "bogus"],
  ]
  for (const args of unknown) {
    test(`${args.join(" ")} -> exit 2 + mentions unknown subcommand`, () => {
      const r = run(args)
      expect(r.code).toBe(2)
      expect(r.out.toLowerCase()).toContain("unknown")
      expect(r.out.toLowerCase()).toContain("subcommand")
    })
  }
})

describe("cli: stats", () => {
  test("--json menghasilkan JSON valid, bukan diabaikan", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicode-stats-"))
    try {
      const r = run(["stats", "--json", "--cwd", tmp])
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout) as Record<string, number>
      expect(parsed.runs).toBe(0)
      expect(parsed).toHaveProperty("inputTokens")
      expect(parsed).toHaveProperty("cost")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("tanpa --json memberi ringkasan yang bisa dibaca", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicode-stats-"))
    try {
      const r = run(["stats", "--cwd", tmp])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("Runs:")
      expect(() => JSON.parse(r.stdout)).toThrow()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("cli: memory", () => {
  test("--json menghasilkan JSON valid dengan rows/bytes/models", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicode-mem-"))
    try {
      mkdirSync(join(tmp, ".minicode"), { recursive: true })
      const r = run(["memory", "--json", "--cwd", tmp])
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>
      expect(parsed.rows).toBe(0)
      expect(parsed).toHaveProperty("dbBytes")
      expect(parsed).toHaveProperty("models")
      expect(parsed).toHaveProperty("avgMemoryHits")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("tanpa --json memberi ringkasan yang bisa dibaca", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicode-mem-"))
    try {
      mkdirSync(join(tmp, ".minicode"), { recursive: true })
      const r = run(["memory", "--cwd", tmp])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("Memory")
      expect(() => JSON.parse(r.stdout)).toThrow()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("subcommand tak dikenal = exit 2", () => {
    const r = run(["memory", "bogus"])
    expect(r.code).toBe(2)
    expect(r.out.toLowerCase()).toContain("unknown")
  })
})

describe("cli: perintah tanpa LLM tetap jalan", () => {
  test("providers pada workspace kosong tidak crash", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicode-empty-"))
    try {
      const r = run(["providers", "--cwd", tmp])
      expect(r.code).toBe(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("sessions list pada workspace baru memberi pesan kosong", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicode-empty-"))
    try {
      // DB sesi lokal dipakai hanya bila .minicode/ ada; tanpa itu resolveDbPath
      // jatuh ke ~/.minicode dan akan menampilkan sesi mesin ini.
      mkdirSync(join(tmp, ".minicode"), { recursive: true })
      const r = run(["sessions", "list", "--cwd", tmp])
      expect(r.code).toBe(0)
      expect(r.out).toContain("no recorded sessions yet")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("sessions list mengumumkan scope global bila tanpa .minicode lokal", () => {
    // Regresi F-C audit terminal UI/UX: fallback ke DB global dulu diam-diam,
    // daftar lintas-workspace bisa dibaca sebagai isi workspace ini.
    const tmp = mkdtempSync(join(tmpdir(), "minicode-noscope-"))
    try {
      const r = run(["sessions", "list", "--cwd", tmp])
      expect(r.code).toBe(0)
      expect(r.out).toContain("global scope")
      expect(r.out).toContain(tmp)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("sessions list lokal tidak memuat baris scope", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicode-local-"))
    try {
      mkdirSync(join(tmp, ".minicode"), { recursive: true })
      const r = run(["sessions", "list", "--cwd", tmp])
      expect(r.code).toBe(0)
      expect(r.out).not.toContain("global scope")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("skills list menampilkan tabel yang sejajar", () => {
    const r = run(["skills", "list"])
    expect(r.code).toBe(0)
    const lines = r.stdout.split("\n").filter((l) => l.trim().startsWith("/"))
    if (lines.length > 1) {
      // Semua baris skill punya lebar sama (batas keras kolom tabel).
      const widths = new Set(lines.map((l) => l.length))
      expect(widths.size).toBe(1)
    }
  })
})

describe("cli: notice sandbox tidak bising", () => {
  test("perintah tanpa tool tidak memuat notice sandbox", () => {
    for (const args of [["--version"], ["providers"], ["stats"], ["pricing", "status"]]) {
      expect(run(args).stderr).not.toContain("[sandbox]")
    }
  })
})
