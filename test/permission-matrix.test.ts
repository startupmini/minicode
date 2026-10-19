// Matriks Permission × Tool (37 tool × 6 mode).
// Ekspektasi di-derive dari src/policy/permission.ts (bukan dokumentasi):
// bila handler berubah, test ini yang harus ikut berubah secara sadar.
// Hermetic: root tmp per test, tanpa eksekusi tool (hanya decision check).

import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionHandler, type PermissionMode } from "../src/policy/permission.ts"
import { isMcpToolName } from "../src/presentation/label.ts"
import { allTools } from "../src/tools/index.ts"

// Cerminan src/policy/permission.ts — duplikasi sadar agar perubahan set
// ketahuan (test gagal = keputusan klasifikasi berubah, periksa dulu).
const READONLY = new Set([
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
])
const FILE_WRITE = new Set(["write_file", "edit", "apply_patch", "move_file", "delete_file"])
const INTERNAL_WRITE = new Set([
  "write_memory",
  "forget_memory",
  "todo_write",
  "submit_result",
  "bash_output",
  "bash_kill",
])
const GATED = new Set([
  "delegate_task",
  "mcp_call",
  "mcp_read",
  "mcp_prompt",
  "git_commit",
  "ask_user",
])
const NO_PROMPT = new Set(["todo_write", "submit_result", "bash_output", "bash_kill"])

// Argumen benign di dalam root (check hanya baca field ini, tak mengeksekusi).
const ARGS: Record<string, Record<string, unknown>> = {
  read_file: { path: "probe.txt" },
  write_file: { path: "probe.txt", content: "x" },
  edit: { path: "probe.txt", oldString: "a", newString: "b" },
  apply_patch: { path: "probe.txt", patches: [{ search: "a", replace: "b" }] },
  glob: { pattern: "*.ts" },
  grep: { pattern: "x" },
  move_file: { from: "a.txt", to: "b.txt" },
  delete_file: { path: "probe.txt" },
  read_image: { path: "i.png" },
  bash: { cmd: "echo hi" },
  bash_output: { id: "bg_1" },
  bash_kill: { id: "bg_1" },
  git_status: {},
  git_diff: {},
  git_log: {},
  git_commit: { message: "m" },
  lsp_diagnostics: { file: "a.ts" },
  lsp_definition: { file: "a.ts" },
  lsp_references: { file: "a.ts" },
  lsp_hover: { file: "a.ts" },
  lsp_symbols: { file: "a.ts" },
  lsp_workspace_symbols: { query: "x" },
  mcp_list: {},
  mcp_call: { server: "s", tool: "t" },
  mcp_read: { server: "s", uri: "u" },
  mcp_prompt: { server: "s", name: "n" },
  read_memory: { query: "x" },
  write_memory: { text: "x" },
  forget_memory: { query: "x" },
  todo_write: { todos: [] },
  todo_read: {},
  delegate_task: { prompt: "x" },
  submit_result: { result: {} },
  ask_user: { question: "x?" },
  web_fetch: { url: "https://example.com" },
  web_search: { query: "x" },
  code_run: { lang: "node", code: "1" },
}

const NAMES = Object.keys(ARGS).sort()

test("registry allTools tepat 37 nama yang dicakup matriks", () => {
  expect(allTools.map((t) => t.name).sort()).toEqual(NAMES)
  expect(NAMES).toHaveLength(37)
})

type Ask = (call: { name: string; args?: unknown }) => Promise<"allow" | "deny" | "always">

function decide(mode: PermissionMode, root: string, name: string, ask?: Ask): Promise<string> {
  const h = createPermissionHandler({ mode, root, ...(ask ? { ask } : {}) })
  return h.check({ name, args: ARGS[name] ?? {} } as never, {} as never) as Promise<string>
}

// Varian decide dengan args bebas: kasus tepi jail butuh path/cwd spesifik
// (di luar root, berkas sensitif) yang tidak ada di ARGS benign.
function decideArgs(
  mode: PermissionMode,
  root: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const h = createPermissionHandler({ mode, root })
  return h.check({ name, args } as never, {} as never) as Promise<string>
}

// promptAskOr (jalur GATED) menolak bila non-TTY walau ask fn ada —
// ekspektasi harus sadar TTY agar tidak flaky antara lokal dan CI.
const TTY = !!process.stdin.isTTY

// Ekspektasi per mode untuk argumen benign (kasus tepi di adversarial test).
function expected(mode: PermissionMode, ask: boolean, name: string): "allow" | "deny" {
  if (mode === "allow-all") return "allow"
  if (mode === "readonly") return READONLY.has(name) ? "allow" : "deny"
  if (mode === "plan")
    return READONLY.has(name) ||
      name === "todo_write" ||
      name === "delegate_task" ||
      name === "submit_result"
      ? "allow"
      : "deny"
  if (mode === "allowlist") {
    if (name === "bash") return "allow" // "echo hi" cocok "echo *", lolos guard
    if (GATED.has(name) || isMcpToolName(name)) return "deny"
    if (FILE_WRITE.has(name) || INTERNAL_WRITE.has(name)) return "allow"
    return READONLY.has(name) ? "allow" : "deny" // sisa = code_run → deny
  }
  if (mode === "ask") {
    if (READONLY.has(name) || NO_PROMPT.has(name)) return "allow"
    if (name === "bash") return ask ? "allow" : "deny" // "echo hi" lolos guard
    if (GATED.has(name)) return ask && TTY ? "allow" : "deny" // promptAskOr butuh TTY
    return ask ? "allow" : "deny" // file/internal/code_run perlu prompt
  }
  // auto headless, tanpa MINICODE_SANDBOX
  if (READONLY.has(name)) return "allow"
  if (GATED.has(name) || isMcpToolName(name)) return "deny"
  if (FILE_WRITE.has(name) || INTERNAL_WRITE.has(name)) return "allow"
  if (name === "code_run") return "deny"
  if (name === "bash") return "allow"
  return "deny"
}

const MODES: PermissionMode[] = ["auto", "ask", "readonly", "plan", "allowlist", "allow-all"]

for (const mode of MODES) {
  test(`matriks ${mode} × 37 tool (headless, tanpa ask fn)`, async () => {
    const savedSandbox = process.env.MINICODE_SANDBOX
    const savedAllow = process.env.MINICODE_BASH_ALLOWLIST
    delete process.env.MINICODE_SANDBOX
    delete process.env.MINICODE_BASH_ALLOWLIST
    const root = mkdtempSync(join(tmpdir(), "mc-matrix-"))
    try {
      for (const name of NAMES) {
        const got = await decide(mode, root, name)
        const want = expected(mode, false, name)
        if (got !== want) throw new Error(`matriks ${mode} × ${name}: got ${got}, want ${want}`)
      }
    } finally {
      if (savedSandbox !== undefined) process.env.MINICODE_SANDBOX = savedSandbox
      if (savedAllow !== undefined) process.env.MINICODE_BASH_ALLOWLIST = savedAllow
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test("matriks ask + auto dengan ask=allow (TTY tersimulasikan)", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-matrix-ask-"))
  try {
    const allow: Ask = async () => "allow"
    for (const name of NAMES) {
      const gotAsk = await decide("ask", root, name, allow)
      if (gotAsk !== expected("ask", true, name))
        throw new Error(`ask+allow × ${name}: got ${gotAsk}`)
      // auto memakai jalur prompt yang sama untuk gated (butuh TTY juga)
      if (GATED.has(name)) {
        const gotAuto = await decide("auto", root, name, allow)
        const wantAuto = TTY ? "allow" : "deny"
        if (gotAuto !== wantAuto) throw new Error(`auto+allow × ${name}: got ${gotAuto}`)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("code_run di auto mengikuti MINICODE_SANDBOX", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-matrix-cr-"))
  const saved = process.env.MINICODE_SANDBOX
  try {
    delete process.env.MINICODE_SANDBOX
    expect(await decide("auto", root, "code_run")).toBe("deny")
    process.env.MINICODE_SANDBOX = "os"
    expect(await decide("auto", root, "code_run")).toBe("allow")
  } finally {
    if (saved === undefined) delete process.env.MINICODE_SANDBOX
    else process.env.MINICODE_SANDBOX = saved
    rmSync(root, { recursive: true, force: true })
  }
})

// ── Perluasan S1 (P12): kasus tepi jail di dalam matriks ──
//
// Blok jail permission.ts (komentar "universal file-path jail — harus sebelum
// allow-all") dieksekusi SEBELUM dispatch mode. Kasus di bawah memetakannya
// ke seluruh 6 mode; deny dibuktikan pada mode yang tanpa jail akan allow
// (allow-all/allowlist/auto/readonly untuk tool baca), bukan sekadar deny
// bawaan mode ketat. Hermetik: root/outside tmp per test, tanpa eksekusi tool.

test("matriks jail: operasi keluar root ditolak di semua mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-matrix-jail-"))
  const outside = mkdtempSync(join(tmpdir(), "mc-matrix-out-"))
  try {
    const outsideFile = join(outside, "x.txt")
    for (const mode of MODES) {
      // Tulis ke luar root: allow-all/allowlist akan allow tanpa jail.
      expect(await decideArgs(mode, root, "write_file", { path: outsideFile, content: "x" })).toBe(
        "deny",
      )
      // Baca ke luar root: mode baca (auto/readonly/plan/ask) akan allow.
      expect(await decideArgs(mode, root, "read_file", { path: outsideFile })).toBe("deny")
      // move_file punya DUA ujung (from+to): keduanya harus dijail.
      expect(await decideArgs(mode, root, "move_file", { from: outsideFile, to: "b.txt" })).toBe(
        "deny",
      )
      expect(await decideArgs(mode, root, "move_file", { from: "a.txt", to: outsideFile })).toBe(
        "deny",
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("matriks jail: berkas sensitif ditolak di semua mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-matrix-sens-"))
  try {
    for (const mode of MODES) {
      // auto/allow-all/allowlist akan allow baca/tulis .env tanpa cek sensitif.
      expect(await decideArgs(mode, root, "read_file", { path: ".env" })).toBe("deny")
      expect(await decideArgs(mode, root, "write_file", { path: ".env", content: "x" })).toBe(
        "deny",
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("matriks jail: tulis state .minicode/ ditolak di mode permisif", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-matrix-owned-"))
  try {
    // Mode di mana tool tulis file memang diizinkan tanpa kunci owned-state —
    // deny di sini membuktikan kunci .minicode/ (bukan efek mode ketat).
    for (const mode of ["auto", "allow-all", "allowlist"] as const) {
      expect(
        await decideArgs(mode, root, "write_file", {
          path: ".minicode/allowlist.json",
          content: "x",
        }),
      ).toBe("deny")
      expect(
        await decideArgs(mode, root, "edit", {
          path: ".minicode/allowlist.json",
          oldString: "a",
          newString: "b",
        }),
      ).toBe("deny")
      expect(await decideArgs(mode, root, "delete_file", { path: ".minicode/sessions.db" })).toBe(
        "deny",
      )
      // Menggeser state keluar workspace = menyebar bukti; tetap deny.
      expect(
        await decideArgs(mode, root, "move_file", {
          from: ".minicode/sessions.db",
          to: "docs/s.db",
        }),
      ).toBe("deny")
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("matriks jail: cwd di luar root ditolak untuk bash/glob/grep/git_*", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-matrix-cwd-"))
  const outside = mkdtempSync(join(tmpdir(), "mc-matrix-cwd-out-"))
  try {
    for (const mode of ["auto", "allow-all", "allowlist"] as const) {
      expect(await decideArgs(mode, root, "bash", { cmd: "echo hi", cwd: outside })).toBe("deny")
      expect(await decideArgs(mode, root, "glob", { pattern: "*.ts", cwd: outside })).toBe("deny")
      expect(await decideArgs(mode, root, "grep", { pattern: "x", cwd: outside })).toBe("deny")
      expect(await decideArgs(mode, root, "git_status", { cwd: outside })).toBe("deny")
      expect(await decideArgs(mode, root, "git_diff", { cwd: outside })).toBe("deny")
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("matriks allow-all: inspeksi bash tetap aktif (bukan bypass)", async () => {
  const root = mkdtempSync(join(tmpdir(), "mc-matrix-bashguard-"))
  try {
    // Destruktif & akses rahasia ditolak walau allow-all; perintah jinak lolos.
    expect(await decideArgs("allow-all", root, "bash", { cmd: "rm -rf /" })).toBe("deny")
    expect(await decideArgs("allow-all", root, "bash", { cmd: "cat .env" })).toBe("deny")
    expect(await decideArgs("allow-all", root, "bash", { cmd: "echo hi" })).toBe("allow")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
