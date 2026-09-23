// Adversarial permission audit: jalur indirect, bypass, dan scope.
// Setiap test membuktikan perilaku dari execution path, bukan asumsi.

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addMemory, searchHybrid } from "../src/memory/vector.ts"
import { matchAllowlist } from "../src/policy/allowlist.ts"
import { createPermissionHandler, type PermissionMode } from "../src/policy/permission.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  EXPLORE_TOOL_NAMES,
  type SubAgentSpec,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import { webSearchTool } from "../src/tools/web_search.ts"

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "mc-adv-"))
}

function check(
  mode: PermissionMode,
  root: string,
  name: string,
  args: Record<string, unknown> = {},
  ask?: (call: { name: string; args?: unknown }) => Promise<"allow" | "deny" | "always">,
  allowLocal = false,
): Promise<string> {
  const h = createPermissionHandler({
    mode,
    root,
    ...(ask ? { ask } : {}),
    allowLocalConfig: allowLocal,
  })
  return h.check({ name, args } as never, {} as never) as Promise<string>
}

// ── Jail di allow-all: allow-all TIDAK berarti bebas filesystem ──

test("allow-all tetap menolak tulis di luar root", async () => {
  const root = tmpRoot()
  try {
    expect(
      await check("allow-all", root, "write_file", { path: join(tmpdir(), "x.txt"), content: "x" }),
    ).toBe("deny")
    expect(await check("allow-all", root, "read_file", { path: "/etc/passwd" })).toBe("deny")
    expect(
      await check("allow-all", root, "move_file", { from: "a", to: join(tmpdir(), "b") }),
    ).toBe("deny")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("allow-all tetap menolak symlink keluar workspace", async () => {
  const root = tmpRoot()
  const outside = join(tmpdir(), "mc-adv-outside.txt")
  try {
    writeFileSync(outside, "rahasia")
    symlinkSync(outside, join(root, "tautan.txt"))
  } catch {
    return // symlink butuh privilege (Windows/CI) — lewati, bukan pass palsu
  }
  try {
    expect(await check("allow-all", root, "read_file", { path: "tautan.txt" })).toBe("deny")
    expect(await check("allow-all", root, "write_file", { path: "tautan.txt", content: "x" })).toBe(
      "deny",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { force: true })
  }
})

test("allow-all tetap enforce bash-guard penuh (bukan bypass)", async () => {
  const root = tmpRoot()
  try {
    // Klaim lama "allow-all melewati bash-guard" SALAH — kode enforce penuh.
    expect(await check("allow-all", root, "bash", { cmd: "rm -rf /" })).toBe("deny")
    expect(await check("allow-all", root, "bash", { cmd: "cat .env" })).toBe("deny")
    expect(await check("allow-all", root, "bash", { cmd: "echo hi" })).toBe("allow")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("file sensitif ditolak di semua mode termasuk auto", async () => {
  const root = tmpRoot()
  try {
    for (const mode of ["auto", "allow-all", "allowlist"] as const) {
      expect(await check(mode, root, "write_file", { path: ".env", content: "x" })).toBe("deny")
      expect(await check(mode, root, "read_file", { path: ".env" })).toBe("deny")
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── readonly: nol mutasi, langsung maupun tak langsung ──

test("readonly menolak seluruh mutasi file/git/memory/task", async () => {
  const root = tmpRoot()
  try {
    const deny = [
      ["write_file", { path: "a.txt", content: "x" }],
      ["edit", { path: "a.txt", oldString: "a", newString: "b" }],
      ["apply_patch", { path: "a.txt", patches: [] }],
      ["move_file", { from: "a", to: "b" }],
      ["delete_file", { path: "a" }],
      ["git_commit", { message: "m" }],
      ["write_memory", { text: "x" }],
      ["forget_memory", { query: "x" }],
      ["todo_write", { todos: [] }],
      ["delegate_task", { prompt: "x" }],
      ["submit_result", { result: {} }],
      ["ask_user", { question: "x?" }],
      ["mcp_call", { server: "s", tool: "t" }],
      ["code_run", { lang: "node", code: "1" }],
      ["bash", { cmd: "echo hi" }],
    ] as const
    for (const [name, args] of deny) {
      const got = await check("readonly", root, name, args)
      if (got !== "deny") throw new Error(`readonly × ${name}: got ${got}`)
    }
    // …tetapi network read-only eksplisit diizinkan (semantik terdokumentasi:
    // "read-only filesystem" ≠ "tanpa egress"). Bukan lubang, tapi harus sadar.
    expect(await check("readonly", root, "web_fetch", { url: "https://example.com" })).toBe("allow")
    expect(await check("readonly", root, "web_search", { query: "x" })).toBe("allow")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── plan: benar-benar tanpa side effect (kecuali artefak rencana) ──

test("plan hanya mengizinkan read-only + todo_write/delegate_task/submit_result", async () => {
  const root = tmpRoot()
  try {
    for (const [name, args, want] of [
      ["write_file", { path: "a.txt", content: "x" }, "deny"],
      ["edit", { path: "a.txt", oldString: "a", newString: "b" }, "deny"],
      ["apply_patch", { path: "a.txt", patches: [] }, "deny"],
      ["move_file", { from: "a", to: "b" }, "deny"],
      ["delete_file", { path: "a" }, "deny"],
      ["git_commit", { message: "m" }, "deny"],
      ["write_memory", { text: "x" }, "deny"],
      ["forget_memory", { query: "x" }, "deny"],
      ["mcp_call", { server: "s", tool: "t" }, "deny"],
      ["mcp_read", { server: "s", uri: "u" }, "deny"],
      ["code_run", { lang: "node", code: "1" }, "deny"],
      ["bash", { cmd: "echo hi" }, "deny"],
      ["ask_user", { question: "x?" }, "deny"],
      ["todo_write", { todos: [] }, "allow"],
      ["delegate_task", { prompt: "x" }, "allow"],
      ["submit_result", { result: {} }, "allow"],
      ["read_file", { path: "a.txt" }, "allow"],
    ] as const) {
      const got = await check("plan", root, name, args)
      if (got !== want) throw new Error(`plan × ${name}: got ${got}, want ${want}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── allowlist: fail-closed + guard dulu ──

test("allowlist fail-closed: unknown tool, gated, code_run ditolak", async () => {
  const root = tmpRoot()
  try {
    expect(await check("allowlist", root, "evil_tool", {})).toBe("deny")
    expect(await check("allowlist", root, "mcp_call", { server: "s", tool: "t" })).toBe("deny")
    expect(await check("allowlist", root, "code_run", { lang: "node", code: "1" })).toBe("deny")
    expect(await check("allowlist", root, "git_commit", { message: "m" })).toBe("deny")
    // Guard jalan SEBELUM pola allowlist: "cat *" cocok pola tapi target sensitif.
    expect(await check("allowlist", root, "bash", { cmd: "cat .env" })).toBe("deny")
    expect(await check("allowlist", root, "bash", { cmd: "rm -rf /" })).toBe("deny")
    expect(await check("allowlist", root, "bash", { cmd: "echo hi" })).toBe("allow")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("allowlist bash DOKUMENTASI: npx/bun-run lolos pola = eksekusi arbitrer", async () => {
  // Pola default diizinkan "npx *", "bun run *", "bun x *" — semuanya bisa
  // menjalankan kode arbitrer (fetch paket + run script). Ini by-design
  // ("read-only + build") tetapi BUKAN tanpa side effect: jangan samakan
  // allowlist dengan sandbox. Test ini mengunci perilaku aktualnya.
  const root = tmpRoot()
  try {
    expect(await check("allowlist", root, "bash", { cmd: "bun run anything" })).toBe("allow")
    expect(await check("allowlist", root, "bash", { cmd: "npx foo" })).toBe("allow")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ask [a] scope: per tool + prefix arg, tersimpan per-proyek ──

test("ask always: scope per tool+args, persist per-proyek, tanpa leakage", async () => {
  // Persist per-proyek = allowlist LOKAL → butuh opt-in (aturan audit #07);
  // tanpa flag, repo tak bisa memberi dirinya always (lihat
  // test/local-config-optin.test.ts).
  const root = tmpRoot()
  try {
    let calls = 0
    const ask = async () => {
      calls++
      return "always" as const
    }
    expect(await check("ask", root, "bash", { cmd: "echo hi" }, ask, true)).toBe("allow")
    expect(calls).toBe(1)
    // Panggilan kedua sama persis: cocok allowlist tersimpan, tanpa tanya lagi.
    let asked2 = false
    const ask2 = async () => {
      asked2 = true
      return "deny" as const
    }
    expect(await check("ask", root, "bash", { cmd: "echo hi" }, ask2, true)).toBe("allow")
    expect(asked2).toBe(false)
    // Arg BERBEDA tidak ikut lolos (scope = name + full arg, bukan "*").
    let asked3 = false
    const ask3 = async () => {
      asked3 = true
      return "deny" as const
    }
    expect(await check("ask", root, "bash", { cmd: "echo lain" }, ask3, true)).toBe("deny")
    expect(asked3).toBe(true)
    // Tool BERBEDA tidak ikut lolos.
    expect(await check("ask", root, "write_file", { path: "a", content: "x" }, ask2, true)).toBe(
      "deny",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("matchAllowlist: wildcard eksplisit vs literal tersimpan", () => {
  const call = (name: string, args: unknown) => ({ name, args }) as never
  expect(matchAllowlist(call("bash", { cmd: "echo hi" }), ['bash:{"cmd":"echo hi"}'])).toBe(true)
  expect(matchAllowlist(call("bash", { cmd: "echo lain" }), ['bash:{"cmd":"echo hi"}'])).toBe(false)
  expect(matchAllowlist(call("bash", { cmd: "apa saja" }), ["bash:*"])).toBe(true)
  expect(matchAllowlist(call("write_file", { path: "a" }), ["bash:*"])).toBe(false)
})

test("matchAllowlist: tanda ? di-escape secara harfiah (bukan regex quantifier / wildcard)", () => {
  const call = (name: string, args: unknown) => ({ name, args }) as never
  expect(matchAllowlist(call("bash", { cmd: "help?" }), ['bash:{"cmd":"help?"}'])).toBe(true)
  expect(matchAllowlist(call("bash", { cmd: "helpx" }), ['bash:{"cmd":"help?"}'])).toBe(false)
  expect(() => matchAllowlist(call("bash", { cmd: "test" }), ["?"])).not.toThrow()
})

// ── MCP dotted: tak pernah auto-allow ──

test("tool MCP runtime (srv.tool) selalu gated kecuali allow-all", async () => {
  const root = tmpRoot()
  try {
    for (const mode of ["readonly", "plan", "allowlist", "ask", "auto"] as const) {
      const got = await check(mode, root, "srv.tool", {})
      if (got !== "deny") throw new Error(`${mode} × srv.tool: got ${got}`)
    }
    expect(await check("allow-all", root, "srv.tool", {})).toBe("allow")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── delegate_task: forced explore + anti-rekursi + isolasi job ──

test("delegate_task parent plan/readonly dipaksa explore read-only", async () => {
  if (!process.env.OPENAI_API_KEY && !process.env.AGENT_API_KEY)
    process.env.OPENAI_API_KEY = "sk-test-hermetic"
  let seen: SubAgentSpec | undefined
  setSubAgentSessionFactory(async (spec) => {
    seen = spec
    return {
      events: { on: () => () => {} },
      run: async () => ({ finalText: "ok", usage: { steps: 1 } }),
    }
  })
  const ctx = (mode?: string) =>
    ({
      signal: new AbortController().signal,
      emit: () => {},
      cwd: tmpdir(),
      permissionMode: mode,
    }) as never
  for (const parent of ["plan", "readonly"]) {
    seen = undefined
    const out = (await delegateTaskTool.execute(
      { prompt: "x", mode: "plan" },
      ctx(parent),
    )) as string
    expect(out).toContain("sub-agent (explore) done")
    const names = new Set(((seen as SubAgentSpec | undefined)?.tools ?? []).map((t) => t.name))
    for (const w of [
      "write_file",
      "edit",
      "bash",
      "mcp_call",
      "code_run",
      "delegate_task",
      "write_memory",
      "git_commit",
    ])
      expect(names.has(w)).toBe(false)
    expect(names.has("read_file")).toBe(true)
  }
  clearSubAgentSessionFactory()
})

test("delegate_task parent auto + mode plan = child bertulis (jalur eskalasi sadar)", async () => {
  if (!process.env.OPENAI_API_KEY && !process.env.AGENT_API_KEY)
    process.env.OPENAI_API_KEY = "sk-test-hermetic"
  let seen2: SubAgentSpec | undefined
  setSubAgentSessionFactory(async (spec) => {
    seen2 = spec
    return {
      events: { on: () => () => {} },
      run: async () => ({ finalText: "ok", usage: { steps: 1 } }),
    }
  })
  const ctx = { signal: new AbortController().signal, emit: () => {}, cwd: tmpdir() } as never
  const out = (await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctx)) as string
  expect(out).toContain("sub-agent (plan) done")
  // Diizinkan HANYA karena outer gate (GATED) meminta approval delegate_task
  // di auto/ask — child auto di sini by-design, bukan bypass.
  expect(new Set((seen2?.tools ?? []).map((t) => t.name)).has("write_file")).toBe(true)
  clearSubAgentSessionFactory()
})

// ── read_memory/RAG: tanpa tulis access_count di readonly/plan ──

async function seedVector(cwd: string): Promise<string> {
  mkdirSync(join(cwd, ".minicode"), { recursive: true })
  await addMemory("audit probe pencatatan unik", { cwd })
  return join(cwd, ".minicode", "vector.db")
}

function accessCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db.query("SELECT COALESCE(SUM(access_count),0) AS n FROM memory").get() as {
      n: number
    }
    return row.n
  } finally {
    db.close()
  }
}

test("searchHybrid default menaikkan access_count; trackAccess:false tidak", async () => {
  const root = tmpRoot()
  try {
    const dbPath = await seedVector(root)
    expect(accessCount(dbPath)).toBe(0)
    await searchHybrid("audit probe", { cwd: root, topK: 5 })
    expect(accessCount(dbPath)).toBeGreaterThan(0)
    const before = accessCount(dbPath)
    await searchHybrid("audit probe", { cwd: root, topK: 5, trackAccess: false })
    expect(accessCount(dbPath)).toBe(before)
  } finally {
    // sqlite WAL di Windows kadang masih terkunci sepersekian detik — pola
    // repo: async rm + telan gagal (memory-p1.test.ts).
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

// ── cancellation: web_search fail-fast tanpa network ──

test("web_search sinyal aborted menolak sebelum network", async () => {
  const c = new AbortController()
  c.abort(new Error("batal"))
  const ctx = { signal: c.signal } as never
  let threw = ""
  try {
    await webSearchTool.execute({ query: "x" }, ctx)
  } catch (e) {
    threw = (e as Error).message
  }
  expect(threw.length).toBeGreaterThan(0)
})

// ── jail argumen per-tool: git paths, lsp file, bash cwd ──

test("jail argumen: git paths, lsp file, bash cwd di luar root ditolak", async () => {
  const root = tmpRoot()
  try {
    expect(await check("auto", root, "git_commit", { message: "m", paths: ["/etc/passwd"] })).toBe(
      "deny",
    )
    // git_commit = GATED: paths di dalam root lolos JAIL tetapi tetap perlu
    // approval — headless (tanpa ask fn) = deny. Dua gerbang independen.
    const allowAsk = async () => "allow" as const
    const gatedDenyNoTty = !process.stdin.isTTY
    expect(
      await check("auto", root, "git_commit", { message: "m", paths: ["a.txt"] }, allowAsk),
    ).toBe(gatedDenyNoTty ? "deny" : "allow")
    expect(await check("auto", root, "lsp_definition", { file: "/etc/passwd" })).toBe("deny")
    expect(await check("auto", root, "bash", { cmd: "echo hi", cwd: "/.." })).toBe("deny")
    expect(await check("auto", root, "glob", { pattern: "*.ts", cwd: "/.." })).toBe("deny")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── Kunci .minicode/** penuh (audit #13): daftar-nama terbukti rapuh ──
// Kasus nyata: `write_file .minicode/test-write.txt` lolos karena namanya
// tak terdaftar. Kini segmen .minicode/ apa pun ditolak untuk tool tulis.

test("allow-all menolak tulis/edit/hapus ke .minicode/<apa-pun>", async () => {
  const root = tmpRoot()
  try {
    expect(await check("allow-all", root, "write_file", { path: ".minicode/notes.md" })).toBe(
      "deny",
    )
    expect(await check("allow-all", root, "write_file", { path: ".minicode/.trash/x" })).toBe(
      "deny",
    )
    expect(await check("allow-all", root, "edit", { path: ".minicode/custom.json" })).toBe("deny")
    expect(await check("allow-all", root, "delete_file", { path: ".minicode/notes.md" })).toBe(
      "deny",
    )
    // BACA tetap boleh (observability) — yang dikunci hanya tulis.
    expect(await check("allow-all", root, "read_file", { path: ".minicode/notes.md" })).toBe(
      "allow",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("move restore dari .trash ke workspace lolos; selain itu dua arah deny", async () => {
  const root = tmpRoot()
  try {
    // Restore sah: bukan deny (allow-all → allow; mode lain ikut mode check).
    expect(
      await check("allow-all", root, "move_file", {
        from: join(".minicode", ".trash", "a.txt"),
        to: "docs/a.txt",
      }),
    ).toBe("allow")
    // Menanam ke state: deny.
    expect(
      await check("allow-all", root, "move_file", { from: "docs/a.txt", to: ".minicode/x.txt" }),
    ).toBe("deny")
    // Menggeser state keluar (sebar bukti): deny.
    expect(
      await check("allow-all", root, "move_file", {
        from: join(".minicode", "sessions.db"),
        to: "docs/s.db",
      }),
    ).toBe("deny")
    // Trash ke trash = tetap state: deny (hanya keluar workspace yang sah).
    expect(
      await check("allow-all", root, "move_file", {
        from: join(".minicode", ".trash", "a.txt"),
        to: join(".minicode", "b.txt"),
      }),
    ).toBe("deny")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("allow-all menolak hive kredensial Windows (kasus sesi nyata)", async () => {
  const root = tmpRoot()
  try {
    const hive = (...segs: string[]) => join(root, ...segs)
    expect(
      await check("allow-all", root, "read_file", {
        path: hive("Windows", "System32", "config", "SAM"),
      }),
    ).toBe("deny")
    expect(
      await check("allow-all", root, "read_file", {
        path: hive("windows", "system32", "config", "system"),
      }),
    ).toBe("deny")
    expect(await check("allow-all", root, "read_file", { path: hive("x", "ntds.dit") })).toBe(
      "deny",
    )
    expect(
      await check("allow-all", root, "write_file", {
        path: hive("Windows", "System32", "config", "SECURITY"),
      }),
    ).toBe("deny")
    // Negatif: kata mirip tanpa induk config/ + file biasa tetap lolos jail
    // (deny lain dari mode tak dihitung — allow-all = allow bila jail lolos).
    expect(await check("allow-all", root, "read_file", { path: "docs/system.txt" })).toBe("allow")
    expect(await check("allow-all", root, "read_file", { path: "docs/ntds-notes.md" })).toBe(
      "allow",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── konsistensi list-vs-enforcement: yang terlihat harus boleh ──

test("EXPLORE list vs READONLY permission: over-hiding terdokumentasi", async () => {
  // 6 tool ini DIIZINKAN permission readonly/plan tetapi DISEMBUNYIKAN dari
  // model oleh EXPLORE_TOOL_NAMES (tool-layer). Aman (fail-closed ke arah
  // menyembunyikan), tetapi inkonsistensi sadar — test ini menguncinya agar
  // perubahan salah satu sisi ketahuan.
  const readonlyAllowed = [
    "read_file",
    "glob",
    "grep",
    "git_status",
    "git_diff",
    "git_log",
    "web_fetch",
    "web_search",
    "read_memory",
    "todo_read",
    "mcp_list",
    "lsp_diagnostics",
    "lsp_definition",
    "lsp_references",
    "lsp_hover",
    "lsp_symbols",
    "lsp_workspace_symbols",
    "read_image",
  ]
  const hidden = readonlyAllowed.filter((n) => !EXPLORE_TOOL_NAMES.includes(n))
  expect(hidden.sort()).toEqual(
    ["git_diff", "lsp_references", "lsp_symbols", "read_image", "web_fetch", "web_search"].sort(),
  )
})
