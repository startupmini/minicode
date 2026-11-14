// Mode `unrestricted` di LAPISAN TOOL (defense-in-depth dalam tool):
// flag `relaxed` dibaca dari `ToolContext.permissionMode === "unrestricted"`
// (helper `contextUnrestricted`) — jail path luar-workspace DIBUKA, tapi
// kredensial/sensitive `.env`/`.ssh`/`.minicode/` TETAP diblokir (full akses
// di sini = akses path bebas, bukan tulis/eksfiltrasi secret).
// Kebalikan dari lapisan permission (short-circuit "allow") yang diuji di
// `test/unrestricted-mode.test.ts` — di sini yang diuji adalah gerbang NYATA
// di dalam tool setelah permission lolos.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Tool, ToolContext } from "#minicore"
import { sanitizeSpawnEnv } from "../src/policy/scrub.ts"
import { GATED_TOOLS } from "../src/policy/tool-contract.ts"
import { gitPushTool } from "../src/tools/git.ts"
import { readFileTool } from "../src/tools/read_file.ts"
import { writeFileTool } from "../src/tools/write_file.ts"

const roots: string[] = []
function makeRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-unrestricted-tools-"))
  roots.push(d)
  return d
}
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

function ctx(root: string, relaxed = false): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd: root,
    permissionMode: relaxed ? "unrestricted" : "auto",
    state: {} as never,
    emit() {},
  } as unknown as ToolContext
}

async function run(tool: Tool, args: Record<string, unknown>, c: ToolContext): Promise<string> {
  return (await tool.execute(args, c)) as string
}

async function runErr(tool: Tool, args: Record<string, unknown>, c: ToolContext): Promise<string> {
  try {
    await tool.execute(args, c)
    return ""
  } catch (e) {
    return (e as Error).message
  }
}

describe("unrestricted di lapisan tool (relaxed via ToolContext.permissionMode)", () => {
  test("write_file luar workspace: ditolak (auto), diizinkan (unrestricted)", async () => {
    const root = makeRoot()
    const outside = makeRoot()
    const target = join(outside, "sub", "nested.txt")
    mkdirSync(join(outside, "sub"), { recursive: true })
    // Mode auto (default): jail di dalam tool menolak.
    expect(await runErr(writeFileTool, { path: target, content: "x" }, ctx(root))).toContain(
      "outside workspace",
    )
    // Mode unrestricted: path luar diizinkan.
    await writeFileTool.execute({ path: target, content: "halo-luar" }, ctx(root, true))
    expect(readFileSync(target, "utf8")).toBe("halo-luar")
  })

  test("read_file luar workspace: ditolak (auto), dibaca (unrestricted)", async () => {
    const root = makeRoot()
    const outside = makeRoot()
    const target = join(outside, "info.txt")
    writeFileSync(target, "isi-luar")
    expect(await runErr(readFileTool, { path: target }, ctx(root))).toContain("outside workspace")
    const out = await run(readFileTool, { path: target }, ctx(root, true))
    expect(out).toContain("isi-luar")
  })

  test("file sensitif (.env / .ssh) TETAP diblokir walau unrestricted", async () => {
    const root = makeRoot()
    const outside = makeRoot()
    const envPath = join(outside, ".env")
    writeFileSync(envPath, "TOKEN=secret")
    // Unrestricted membuka path, tapi bukan kredensial.
    expect(await runErr(writeFileTool, { path: envPath, content: "x" }, ctx(root, true))).toContain(
      "sensitive",
    )
    expect(await runErr(readFileTool, { path: envPath }, ctx(root, true))).toContain("sensitive")
  })

  test("git_push terdaftar sebagai tool gated (audit trail)", () => {
    expect(gitPushTool.name).toBe("git_push")
    expect(GATED_TOOLS.has("git_push")).toBe(true)
  })

  test("git_push menolak remote/branch berawalan '-' (option injection)", async () => {
    const root = makeRoot()
    // Validasi ref terjadi SEBELUM cek repo: temp dir bukan repo pun menolak
    // dengan pesan validasi, bukan "not a git repository".
    expect(await runErr(gitPushTool, { remote: "--receive-pack=evil" }, ctx(root))).toContain(
      "must not start with '-'",
    )
    expect(await runErr(gitPushTool, { branch: "-x" }, ctx(root))).toContain(
      "must not start with '-'",
    )
  })
})

describe("sanitizeSpawnEnv passthrough kredensial git (hanya unrestricted)", () => {
  test("default: GH_TOKEN/GITHUB_TOKEN/SSH_AUTH_SOCK di-strip", () => {
    const env = sanitizeSpawnEnv({
      PATH: "x",
      GITHUB_TOKEN: "ghp_secret",
      GH_TOKEN: "ghp_secret2",
      SSH_AUTH_SOCK: "/tmp/ssh-x",
      NPM_TOKEN: "npm-secret",
    })
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    expect(env.NPM_TOKEN).toBeUndefined()
    expect(env.PATH).toBe("x")
  })

  test("allowGitCredentials: GH_TOKEN/GITHUB_TOKEN/SSH_AUTH_SOCK lolos, lain tetap strip", () => {
    const env = sanitizeSpawnEnv(
      {
        PATH: "x",
        GITHUB_TOKEN: "ghp_secret",
        GH_TOKEN: "ghp_secret2",
        SSH_AUTH_SOCK: "/tmp/ssh-x",
        NPM_TOKEN: "npm-secret",
        OPENAI_API_KEY: "sk-openai",
      },
      undefined,
      true,
    )
    expect(env.GITHUB_TOKEN).toBe("ghp_secret")
    expect(env.GH_TOKEN).toBe("ghp_secret2")
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-x")
    // Kredensial non-git TETAP di-strip.
    expect(env.NPM_TOKEN).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })
})
