// Hardening boundary: residu audit Tool Contract × Permission.
// Fokus: MCP abort, LSP abort, code_run fail-closed, secret env, hooks abort,
// late-approval, delegate cancel. Hermetic: stub lokal, tanpa network/API key.

import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearLspServers, closeAllLsp, configureServers } from "../src/lsp/client.ts"
import { closeAll as closeAllMcp } from "../src/mcp/client.ts"
import { McpHttpTransport } from "../src/mcp/http-transport.ts"
import { McpTransport } from "../src/mcp/transport.ts"
import { matchAllowlist } from "../src/policy/allowlist.ts"
import { createPermissionHandler } from "../src/policy/permission.ts"
import { codeRunTool, shSingleQuote } from "../src/tools/code_run.ts"
import { gitCommitTool } from "../src/tools/git.ts"
import { lspWorkspaceSymbolsTool } from "../src/tools/lsp.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import { isolateGitConfigForTests } from "./helpers/isolated-git-config.ts"

isolateGitConfigForTests()

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "mc-hard-"))
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

afterEach(async () => {
  try {
    await closeAllMcp()
  } catch {}
  try {
    await closeAllLsp()
  } catch {}
  clearLspServers()
  clearSubAgentSessionFactory()
})

// Stub MCP stdio: diam total (tak pernah balas) — untuk uji abort penungguan.
async function hangStub(): Promise<string> {
  const dir = tmpRoot()
  const f = join(dir, "hang.mjs")
  await writeFile(f, "process.stdin.resume();\n")
  return f
}

// ── shSingleQuote: fondasi keamanan routing code_run ──

test("shSingleQuote menutup injeksi shell", () => {
  expect(shSingleQuote("abc")).toBe("'abc'")
  expect(shSingleQuote("a'b")).toBe(`'a'\\''b'`)
  expect(shSingleQuote("$(rm -rf /)")).toBe(`'$(rm -rf /)'`)
  expect(shSingleQuote("x\ny")).toBe("'x\ny'")
  expect(shSingleQuote("")).toBe("''")
})

// ── code_run: fail-closed tanpa backend ──

test("code_run menolak tanpa flag dan tanpa backend (fail-closed)", async () => {
  const saved = process.env.MINICODE_SANDBOX
  const ctx = { signal: new AbortController().signal, cwd: tmpdir() } as never
  try {
    delete process.env.MINICODE_SANDBOX
    await expect(codeRunTool.execute({ lang: "node", code: "1" }, ctx)).rejects.toThrow(
      /requires MINICODE_SANDBOX/,
    )
    // Flag diset tetapi backend tak ada = tolak, BUKAN fallback ke host.
    const { dockerAvailable } = await import("../src/sandbox/docker.ts")
    if (!dockerAvailable()) {
      process.env.MINICODE_SANDBOX = "docker"
      await expect(codeRunTool.execute({ lang: "node", code: "1" }, ctx)).rejects.toThrow(
        /not available/,
      )
    }
    const { osSandboxAvailable } = await import("../src/sandbox/os.ts")
    if (!osSandboxAvailable()) {
      process.env.MINICODE_SANDBOX = "os"
      await expect(codeRunTool.execute({ lang: "node", code: "1" }, ctx)).rejects.toThrow(
        /no OS sandbox is available/,
      )
    }
  } finally {
    if (saved === undefined) delete process.env.MINICODE_SANDBOX
    else process.env.MINICODE_SANDBOX = saved
  }
})

test("code_run menolak NUL byte sebelum runner", async () => {
  const saved = process.env.MINICODE_SANDBOX
  process.env.MINICODE_SANDBOX = "os"
  try {
    const ctx = { signal: new AbortController().signal, cwd: tmpdir() } as never
    await expect(codeRunTool.execute({ lang: "node", code: "a\0b" }, ctx)).rejects.toThrow(/NUL/)
  } finally {
    if (saved === undefined) delete process.env.MINICODE_SANDBOX
    else process.env.MINICODE_SANDBOX = saved
  }
})

// ── MCP HTTP: abort benar-benar membatalkan fetch ──

test("MCP http: parent abort membatalkan request yang menggantung", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json().catch(() => ({}))) as { id?: unknown; method?: string }
      if (body.method === "hang") return new Promise<Response>(() => {}) // gantung selamanya
      return Response.json({ jsonrpc: "2.0", id: body.id ?? 1, result: { ok: true } })
    },
  })
  try {
    const t = new McpHttpTransport({
      url: `http://127.0.0.1:${server.port}/mcp`,
      allowPrivateHost: true,
    })
    // Jalur normal tetap utuh setelah penambahan signal.
    expect(await t.request("ok", {}, 5000)).toEqual({ ok: true })
    // Abort: harus menolak CEPAT, bukan menunggu timeout 30 dtk.
    const c = new AbortController()
    const p = t.request("hang", {}, 30_000, c.signal)
    setTimeout(() => c.abort(new Error("batal-induk")), 100)
    const t0 = Date.now()
    await expect(p).rejects.toThrow(/batal-induk/)
    expect(Date.now() - t0).toBeLessThan(10_000)
    // Sinyal yang sudah aborted menolak sebelum network.
    const c2 = new AbortController()
    c2.abort()
    await expect(t.request("ok", {}, 5000, c2.signal)).rejects.toThrow()
  } finally {
    server.stop(true)
  }
})

// ── MCP stdio: abort menghentikan penungguan, bukan server ──

test("MCP stdio: abort menolak menunggu; server tetap hidup sampai close", async () => {
  const stub = await hangStub()
  const dir = stub.slice(0, stub.lastIndexOf("/"))
  const t = new McpTransport()
  try {
    await t.connect(process.execPath, [stub])
    const c = new AbortController()
    const p = t.request("tools/list", {}, 30_000, c.signal)
    setTimeout(() => c.abort(new Error("batal-induk")), 100)
    const t0 = Date.now()
    await expect(p).rejects.toThrow(/batal-induk/)
    expect(Date.now() - t0).toBeLessThan(10_000)
  } finally {
    await t.close()
    await cleanup(dir)
  }
})

// ── LSP: abort menghentikan penungguan tool ──

test("LSP workspace/symbol yang menggantung kalah oleh abort", async () => {
  const stub = await hangStub()
  const dir = stub.slice(0, stub.lastIndexOf("/"))
  try {
    // ext unik agar tak mencemari registry global antar file test.
    configureServers([{ ext: "mockhz", command: process.execPath, args: [stub] }])
    const c = new AbortController()
    const ctx = { signal: c.signal, cwd: tmpdir() } as never
    const p = lspWorkspaceSymbolsTool.execute({ query: "x" }, ctx) as Promise<string>
    setTimeout(() => c.abort(new Error("batal-induk")), 200)
    const t0 = Date.now()
    const out = await p
    // Tool menangkap abort menjadi string [lsp] — bukan success, bukan hang.
    expect(out).toMatch(/\[lsp\].*batal-induk/i)
    expect(Date.now() - t0).toBeLessThan(10_000)
  } finally {
    await cleanup(dir)
  }
})

// ── Permission: cancel-before-execution + late approval ──

test("check dengan sinyal aborted selalu deny (semua mode)", async () => {
  const root = tmpRoot()
  try {
    for (const mode of ["auto", "ask", "readonly", "plan", "allowlist", "allow-all"] as const) {
      const h = createPermissionHandler({ mode, root })
      const c = new AbortController()
      c.abort()
      const got = await h.check(
        { name: "read_file", args: { path: "a.txt" } } as never,
        {
          signal: c.signal,
        } as never,
      )
      expect(got).toBe("deny")
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("late approval setelah abort = deny (tak ada eksekusi susulan)", async () => {
  const root = tmpRoot()
  try {
    let asked = false
    const h = createPermissionHandler({
      mode: "ask",
      root,
      ask: async () => {
        asked = true
        await new Promise(() => {}) // user tak kunjung menjawab
        return "allow"
      },
    })
    const c = new AbortController()
    const p = h.check(
      { name: "write_file", args: { path: "a", content: "x" } } as never,
      {
        signal: c.signal,
      } as never,
    )
    setTimeout(() => c.abort(), 50)
    expect(await p).toBe("deny")
    expect(asked).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("retry setelah denial tetap deny (deterministik)", async () => {
  const root = tmpRoot()
  try {
    const h = createPermissionHandler({ mode: "readonly", root })
    const call = { name: "write_file", args: { path: "a", content: "x" } } as never
    expect(await h.check(call, {} as never)).toBe("deny")
    expect(await h.check(call, {} as never)).toBe("deny")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── delegate: child tidak hidup sendiri setelah parent batal ──

test("delegate_task meneruskan abort ke child dan pool pulih", async () => {
  const savedKey = process.env.OPENAI_API_KEY
  const savedAgent = process.env.AGENT_API_KEY
  if (!savedKey && !savedAgent) process.env.OPENAI_API_KEY = "sk-test-hermetic"
  try {
    let childAborted = false
    // [PROMPT 06 · Area F] Abort ditembak SETELAH anak benar-benar mulai,
    // bukan setelah 100 ms buta. Urutan nyata: persistEffectIntent (SQLite,
    // bisa >100 ms saat suite penuh/ber-instrumentasi) → pool.run → factory →
    // run anak. Kalau parent abort sebelum `pool.run`, jalur yang diuji bukan
    // "abort diteruskan ke child" melainkan "delegasi ditolak sebelum mulai"
    // (execute melempar reason) — test jadi merah flaky, bukan regresi produk.
    let markStarted: () => void = () => {}
    const childStarted = new Promise<void>((r) => {
      markStarted = r
    })
    setSubAgentSessionFactory(async () => ({
      events: { on: () => () => {} },
      run: async (_p: string, opts: { signal: AbortSignal }) => {
        markStarted()
        await new Promise<void>((_, rej) => {
          // Signal yang sudah abort tetap harus menolak (fail-closed), bukan
          // menggantung menunggu event yang tak akan datang lagi.
          if (opts.signal.aborted) {
            childAborted = true
            rej(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("aborted"))
            return
          }
          opts.signal.addEventListener(
            "abort",
            () => {
              childAborted = true
              rej(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("aborted"))
            },
            { once: true },
          )
        })
        return { finalText: "tak tercapai", usage: { steps: 0 } }
      },
    }))
    const c = new AbortController()
    const ctx = { signal: c.signal, emit: () => {}, cwd: tmpdir() } as never
    const p = delegateTaskTool.execute({ prompt: "x" }, ctx) as Promise<string>
    // Batas atas: kalau anak tak pernah mulai (pool bocor), abort tetap
    // ditembak agar test gagal dengan diagnosa, bukan menggantung 30 dtk.
    await Promise.race([childStarted, new Promise<void>((r) => setTimeout(r, 5000))])
    c.abort(new Error("batal-induk"))
    const out = await p
    // Dibatalkan = error, BUKAN success; child menerima abort yang sama.
    expect(out).toMatch(/sub-agent .* error.*batal-induk/)
    expect(childAborted).toBe(true)
    // Pool pulih: delegate berikutnya jalan normal.
    setSubAgentSessionFactory(async () => ({
      events: { on: () => () => {} },
      run: async () => ({ finalText: "pulih", usage: { steps: 1 } }),
    }))
    const c2 = new AbortController()
    const out2 = (await delegateTaskTool.execute({ prompt: "x" }, {
      signal: c2.signal,
      emit: () => {},
      cwd: tmpdir(),
    } as never)) as string
    expect(out2).toContain("pulih")
  } finally {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    if (savedAgent === undefined) delete process.env.AGENT_API_KEY
    clearSubAgentSessionFactory()
  }
})

// ── hooks: tanpa secret di env + hormati abort ──

test("hook menerima MINICODE_HOOK_CTX tetapi TANPA secret env", async () => {
  const root = tmpRoot()
  const savedHooks = process.env.MINICODE_HOOKS
  const savedSecret = process.env.HARDEN_PROBE_API_KEY
  const savedOut = process.env.PROBE_OUT
  process.env.MINICODE_HOOKS = "1"
  process.env.HARDEN_PROBE_API_KEY = "shhh-topsecret"
  const outFile = join(root, "env.json")
  process.env.PROBE_OUT = outFile
  try {
    mkdirSync(join(root, ".minicode", "hooks"), { recursive: true })
    writeFileSync(
      join(root, ".minicode", "hooks", "pre-probe.js"),
      `import fs from "node:fs";\nfs.writeFileSync(process.env.PROBE_OUT, JSON.stringify({hookCtx: process.env.MINICODE_HOOK_CTX ?? null, probe: process.env.HARDEN_PROBE_API_KEY ?? null}));\n`,
    )
    const { runRunHooks } = await import("../src/hooks/run.ts")
    await runRunHooks("pre", { phase: "pre", prompt: "halo", cwd: root })
    const seen = JSON.parse(readFileSync(outFile, "utf8")) as {
      hookCtx: string | null
      probe: string | null
    }
    expect(seen.probe).toBeNull()
    expect(seen.hookCtx).toContain('"phase":"pre"')
  } finally {
    if (savedHooks === undefined) delete process.env.MINICODE_HOOKS
    else process.env.MINICODE_HOOKS = savedHooks
    if (savedSecret === undefined) delete process.env.HARDEN_PROBE_API_KEY
    else process.env.HARDEN_PROBE_API_KEY = savedSecret
    if (savedOut === undefined) delete process.env.PROBE_OUT
    else process.env.PROBE_OUT = savedOut
    await cleanup(root)
  }
})

test("hook dilewati bila sesi sudah aborted", async () => {
  const root = tmpRoot()
  const savedHooks = process.env.MINICODE_HOOKS
  process.env.MINICODE_HOOKS = "1"
  try {
    mkdirSync(join(root, ".minicode", "hooks"), { recursive: true })
    const marker = join(root, "jalan.txt")
    writeFileSync(
      join(root, ".minicode", "hooks", "pre-probe.js"),
      `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "jalan");\n`,
    )
    const { runRunHooks } = await import("../src/hooks/run.ts")
    const c = new AbortController()
    c.abort()
    await runRunHooks("pre", { phase: "pre", cwd: root }, c.signal)
    let ran = false
    try {
      readFileSync(marker)
      ran = true
    } catch {}
    expect(ran).toBe(false)
  } finally {
    if (savedHooks === undefined) delete process.env.MINICODE_HOOKS
    else process.env.MINICODE_HOOKS = savedHooks
    await cleanup(root)
  }
})

// ── git_commit: hook repo TIDAK dijalankan (audit #10 P0, lebih kuat dari
// versi lama yang hanya mensanitasi env hook) ──

test("git hook repo tidak dijalankan; commit tetap sukses", async () => {
  try {
    const r = spawnSync("git", ["--version"], { stdio: "ignore" })
    if (r.status !== 0) return // tanpa git: lewati
  } catch {
    return
  }
  const root = tmpRoot()
  const savedSecret = process.env.HARDEN_PROBE_API_KEY
  const savedOut = process.env.HOOK_ENV_OUT
  process.env.HARDEN_PROBE_API_KEY = "shhh-topsecret"
  const outFile = join(root, "hook-env.txt")
  process.env.HOOK_ENV_OUT = outFile
  try {
    const git = (args: string[]) => spawnSync("git", args, { cwd: root, stdio: "ignore" })
    git(["init"])
    git(["config", "user.email", "t@t.t"])
    git(["config", "user.name", "t"])
    git(["config", "commit.gpgsign", "false"])
    // pre-commit hook: tuang env ke berkas (mensimulasikan hook yang memanen env).
    writeFileSync(
      join(root, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\nenv > "$HOOK_ENV_OUT"\nexit 0\n`,
    )
    chmodSync(join(root, ".git", "hooks", "pre-commit"), 0o755)
    writeFileSync(join(root, "f.txt"), "isi\n")
    const ctx = { signal: new AbortController().signal, cwd: root } as never
    const out = (await gitCommitTool.execute(
      { message: "uji hook", paths: ["f.txt"] },
      ctx,
    )) as string
    expect(out).toContain("HEAD:") // commit tetap terjadi
    // P0: hook TIDAK dijalankan sama sekali (--no-verify + hooksPath isolasi)
    // — tak ada berkas env, jadi secret tidak pernah terpapar ke kode repo.
    expect(existsSync(outFile)).toBe(false)
  } finally {
    if (savedSecret === undefined) delete process.env.HARDEN_PROBE_API_KEY
    else process.env.HARDEN_PROBE_API_KEY = savedSecret
    if (savedOut === undefined) delete process.env.HOOK_ENV_OUT
    else process.env.HOOK_ENV_OUT = savedOut
    await cleanup(root)
  }
})

// ── MCP approval scope: per server+tool, bukan melebar ──

test("approval MCP terikat server+tool+args", () => {
  const call = (name: string, args: unknown) => ({ name, args }) as never
  const saved = ['srvA.tool:{"mode":"baca"}']
  expect(matchAllowlist(call("srvA.tool", { mode: "baca" }), saved)).toBe(true)
  // Tool lain di server yang sama TIDAK ikut lolos.
  expect(matchAllowlist(call("srvA.tulis", { mode: "baca" }), saved)).toBe(false)
  // Server lain TIDAK ikut lolos.
  expect(matchAllowlist(call("srvB.tool", { mode: "baca" }), saved)).toBe(false)
  // Arg berbeda TIDAK ikut lolos.
  expect(matchAllowlist(call("srvA.tool", { mode: "tulis" }), saved)).toBe(false)
})
