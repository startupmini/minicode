// Coverage untuk cli/commands/config.ts + save/remove MCP/LSP di src/config.ts
// (area lama 36% — target coverage 81 funcs). Subprocess seperti
// cli-subcommands.test.ts; HOME palsu agar config global mesin tak ikut.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "..")
const entry = join(repoRoot, "cli", "index.ts")

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "minicode-cfgcov-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function run(args: string[], cwd: string): { code: number; out: string } {
  const home = join(cwd, "home")
  mkdirSync(join(home, ".minicode"), { recursive: true })
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1", HOME: home, USERPROFILE: home },
  })
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

describe("cli config: list/remove/usage tanpa jaringan", () => {
  test("config list kosong -> pesan, exit 0", () => {
    const dir = ws()
    try {
      const r = run(["config", "list", "--cwd", dir], dir)
      expect(r.code).toBe(0)
      expect(r.out).toContain("no providers yet")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("config list dengan provider -> tabel", () => {
    const dir = ws()
    try {
      writeFileSync(
        join(dir, ".minicode", "config.json"),
        JSON.stringify({
          providers: [
            { id: "p1", baseUrl: "https://x.test/v1", apiKey: "k", models: ["m1", "m2"] },
          ],
        }),
      )
      const r = run(["config", "list", "--allow-local-config", "--cwd", dir], dir)
      expect(r.code).toBe(0)
      expect(r.out).toContain("p1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("arg hilang / flag sebagai positional -> usage, exit 2", () => {
    // Regresi temuan nyata: `config lsp remove --cwd X` menghapus server
    // bernama "--cwd" (exit 0). Kini: usage + exit 2 di 5 posisi id/ext.
    const dir = ws()
    try {
      for (const args of [
        ["config", "add", "--cwd", dir],
        ["config", "detect", "--cwd", dir],
        ["config", "remove", "--cwd", dir],
        ["config", "mcp", "add", "--cwd", dir],
        ["config", "mcp", "remove", "--cwd", dir],
        ["config", "lsp", "add", "--cwd", dir],
        ["config", "lsp", "remove", "--cwd", dir],
      ]) {
        const r = run(args, dir)
        expect(r.code).toBe(2)
        expect(r.out).toContain("usage:")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("config remove ghost --local -> ok", () => {
    const dir = ws()
    try {
      const r = run(["config", "remove", "ghost", "--local", "--cwd", dir], dir)
      expect(r.code).toBe(0)
      expect(r.out).toContain("Removed provider ghost")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("cli config mcp/lsp: add/list/remove lokal", () => {
  test("mcp list kosong + add tanpa id -> pesan", () => {
    const dir = ws()
    try {
      let r = run(["config", "mcp", "list", "--cwd", dir], dir)
      expect(r.code).toBe(0)
      expect(r.out).toContain("no MCP servers")
      r = run(["config", "mcp", "add", "--cwd", dir], dir)
      expect(r.code).toBe(2)
      expect(r.out).toContain("usage:")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("mcp add stdio --local -> tersimpan di config lokal", () => {
    const dir = ws()
    try {
      const r = run(
        [
          "config",
          "mcp",
          "add",
          "srv",
          "--local",
          "--command",
          "echo",
          "--args",
          "hi",
          "--cwd",
          dir,
        ],
        dir,
      )
      expect(r.code).toBe(0)
      expect(r.out).toContain('Saved MCP server "srv"')
      const cfg = JSON.parse(readFileSync(join(dir, ".minicode", "config.json"), "utf8")) as {
        mcpServers: { id: string; command: string }[]
      }
      expect(cfg.mcpServers[0]?.id).toBe("srv")
      const r2 = run(["config", "mcp", "remove", "srv", "--local", "--cwd", dir], dir)
      expect(r2.code).toBe(0)
      expect(r2.out).toContain("Removed MCP server srv")
      expect(existsSync(join(dir, ".minicode", "config.json"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("mcp add http --local + list tampil (http)", () => {
    const dir = ws()
    try {
      let r = run(
        ["config", "mcp", "add", "web", "--local", "--url", "https://mcp.test", "--cwd", dir],
        dir,
      )
      expect(r.code).toBe(0)
      expect(r.out).toContain("(http)")
      r = run(["config", "mcp", "list", "--allow-local-config", "--cwd", dir], dir)
      expect(r.code).toBe(0)
      expect(r.out).toContain("(http)")
      r = run(["config", "mcp", "remove", "web", "--local", "--cwd", dir], dir)
      expect(r.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("mcp add --url salah protokol -> ditolak", () => {
    const dir = ws()
    try {
      const r = run(["config", "mcp", "add", "srv", "--url", "ftp://x", "--cwd", dir], dir)
      expect(r.code).toBe(2)
      expect(r.out).toContain("http/https")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("lsp list kosong + add/list/remove roundtrip", () => {
    const dir = ws()
    try {
      let r = run(["config", "lsp", "list", "--cwd", dir], dir)
      expect(r.code).toBe(0)
      expect(r.out).toContain("no LSP servers")
      r = run(["config", "lsp", "add", "--cwd", dir], dir)
      expect(r.code).toBe(2)
      expect(r.out).toContain("usage:")
      r = run(
        [
          "config",
          "lsp",
          "add",
          "ts",
          "--local",
          "--command",
          "typescript-language-server",
          "--cwd",
          dir,
        ],
        dir,
      )
      expect(r.code).toBe(0)
      expect(r.out).toContain("Saved LSP server for")
      r = run(["config", "lsp", "list", "--allow-local-config", "--cwd", dir], dir)
      expect(r.code).toBe(0)
      expect(r.out).toContain("Configured LSP Language Servers")
      expect(r.out).toContain(".ts")
      r = run(["config", "lsp", "remove", "--cwd", dir], dir)
      expect(r.code).toBe(2)
      r = run(["config", "lsp", "remove", "ts", "--local", "--cwd", dir], dir)
      expect(r.code).toBe(0)
      expect(r.out).toContain("Removed LSP server for ts")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
