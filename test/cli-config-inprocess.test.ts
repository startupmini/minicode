// In-process dispatch untuk cli/commands/config.ts + save/remove MCP/LSP.
// Berbeda dari cli-subcommands (subprocess, tak terhitung coverage) dan
// cli-config-coverage (perilaku nyata incl. bug flag-sebagai-id): berkas ini
// menaikkan coverage area lama config. Hanya jalur --local agar HOME mesin
// tak tersentuh; assert exit code + struktur, bukan kekosongan global.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dispatch } from "../cli/router.ts"
import { type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`)
  }
}

const origExit = process.exit
let tty: FakeTty | undefined

beforeEach(() => {
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0)
  }) as unknown as typeof process.exit
})
afterEach(() => {
  process.exit = origExit
  tty?.restore()
  tty = undefined
})

async function runDispatch(args: string[]): Promise<{ code: number; out: string }> {
  tty = installFakeTty({ columns: 120, rows: 40, isTTY: false })
  let code = -1
  try {
    await dispatch(
      args,
      ((name: string): string | undefined => {
        const i = args.indexOf(name)
        if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1]
        const eq = args.find((a) => a.startsWith(`${name}=`))
        return eq ? eq.slice(name.length + 1) : undefined
      }) as (name: string) => string | undefined,
      "GLOBAL HELP",
    )
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code
    else throw e
  }
  const { stripAnsi } = await import("../src/ui/render/theme.ts")
  const out = stripAnsi(tty.combined())
  tty.restore()
  tty = undefined
  return { code, out }
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "minicode-cfgin-"))
  mkdirSync(join(tmp, ".minicode"), { recursive: true })
})
afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {}
})

describe("config in-process: help/usage", () => {
  test("tanpa sub -> help exit 0; sub asing/flag nyasar -> exit 2 + help", async () => {
    let r = await runDispatch(["config"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("minicode config")
    // `--cwd` tanpa sub bukan subcommand: tolak, tapi tampilkan help
    // (bukan diam) dan sebut tokennya agar jelas salahnya di mana.
    r = await runDispatch(["config", "--cwd", tmp])
    expect(r.code).toBe(2)
    expect(r.out).toContain("minicode config")
    expect(r.out).toContain("unknown subcommand: --cwd")
    r = await runDispatch(["config", "bogus", "--cwd", tmp])
    expect(r.code).toBe(2)
    expect(r.out.toLowerCase()).toContain("unknown subcommand")
  })

  test("mcp/lsp tanpa sub dan sub asing", async () => {
    let r = await runDispatch(["config", "mcp"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("minicode config mcp")
    r = await runDispatch(["config", "mcp", "--cwd", tmp])
    expect(r.code).toBe(2)
    expect(r.out).toContain("minicode config mcp")
    r = await runDispatch(["config", "mcp", "bogus", "--cwd", tmp])
    expect(r.code).toBe(2)
    r = await runDispatch(["config", "lsp"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("minicode config lsp")
    r = await runDispatch(["config", "lsp", "bogus", "--cwd", tmp])
    expect(r.code).toBe(2)
  })

  test("flag sebagai id/ext ditolak di 5 posisi", async () => {
    for (const args of [
      ["config", "remove", "--cwd", tmp],
      ["config", "mcp", "add", "--cwd", tmp],
      ["config", "mcp", "remove", "--cwd", tmp],
      ["config", "lsp", "add", "--cwd", tmp],
      ["config", "lsp", "remove", "--cwd", tmp],
    ]) {
      const r = await runDispatch(args)
      expect(r.code).toBe(2)
      expect(r.out).toContain("usage:")
    }
  })
})

describe("config in-process: list dan roundtrip lokal", () => {
  test("list provider/mcp/lsp -> exit 0", async () => {
    for (const args of [
      ["config", "list", "--cwd", tmp],
      ["config", "mcp", "list", "--cwd", tmp],
      ["config", "lsp", "list", "--cwd", tmp],
    ]) {
      const r = await runDispatch(args)
      expect(r.code).toBe(0)
    }
  })

  test("list provider seeded -> tabel", async () => {
    writeFileSync(
      join(tmp, ".minicode", "config.json"),
      JSON.stringify({
        providers: [{ id: "px", baseUrl: "https://x.test/v1", apiKey: "k", models: ["m1"] }],
      }),
    )
    const r = await runDispatch(["config", "list", "--allow-local-config", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain("px")
  })

  test("mcp add http + list + remove --local", async () => {
    let r = await runDispatch([
      "config",
      "mcp",
      "add",
      "web",
      "--local",
      "--url",
      "https://mcp.test",
      "--cwd",
      tmp,
    ])
    expect(r.code).toBe(0)
    expect(r.out).toContain("(http)")
    r = await runDispatch(["config", "mcp", "list", "--allow-local-config", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain("(http)")
    r = await runDispatch(["config", "mcp", "remove", "web", "--local", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain("Removed MCP server web")
  })

  test("mcp add stdio + env + remove", async () => {
    let r = await runDispatch([
      "config",
      "mcp",
      "add",
      "srv",
      "--local",
      "--command",
      "echo",
      "--args",
      "a,b",
      "--env",
      "K=V",
      "--cwd",
      tmp,
    ])
    expect(r.code).toBe(0)
    expect(r.out).toContain('Saved MCP server "srv"')
    r = await runDispatch(["config", "mcp", "remove", "srv", "--local", "--cwd", tmp])
    expect(r.code).toBe(0)
  })

  test("lsp add + list + remove --local", async () => {
    let r = await runDispatch([
      "config",
      "lsp",
      "add",
      "ts",
      "--local",
      "--command",
      "tls",
      "--args",
      "--stdio",
      "--cwd",
      tmp,
    ])
    expect(r.code).toBe(0)
    expect(r.out).toContain("Saved LSP server for")
    r = await runDispatch(["config", "lsp", "list", "--allow-local-config", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain("Configured LSP Language Servers")
    r = await runDispatch(["config", "lsp", "remove", "ts", "--local", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain("Removed LSP server for ts")
  })

  test("remove provider ghost --local", async () => {
    const r = await runDispatch(["config", "remove", "ghost", "--local", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain("Removed provider ghost")
  })
})
