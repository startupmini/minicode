// Kontrak WorkMode (P12 S2.1) — ceiling tipis di atas handler PermissionMode.
//
// [KENAPA HANDLER ASLI] Setiap sel memakai `createPermissionHandler` produksi
// (bukan mapper test-only): yang direplay adalah komposisi `work-mode.ts`
// (ceiling) + handler PM asli. Fixture `helpers/work-mode-matrix.ts` hanya
// ekspektasi independen hasil transkrip arah owner.
//
// [KEPUTUSAN OWNER S2.1] PLAN × auto/ask TIDAK menjadi `plan` polos:
// `delegate_task` tetap lewat gerbang approval PM asli — headless deny, dan
// prompt tetap dipanggil saat TTY + ask tersedia. Dua sel itu diuji eksplisit
// (describe "PLAN × auto/ask").
//
// [BATAS SLICE] Ini bukti handler-layer, BUKAN replay runtime penuh: tak ada
// wiring CLI/TUI, tool-layer visibility, hooks, atau sub-agen di sini.
//
// [ISOLASI S2.1.1] Turunan yang bisa membaca allowlist global user (mode ask
// untuk tool non-read-only; promptAskOr saat TTY+ask) dijalankan di proses anak
// dengan HOME/USERPROFILE temp: `GLOBAL_ALLOW` dihitung saat import, jadi env
// parent tak bisa diandalkan.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeProvider } from "#minicore/test/fakes.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import { createPermissionHandler, type PermissionMode } from "../src/policy/permission.ts"
import {
  composeWorkModePermissionHandler,
  createWorkModePermissionHandler,
  type WorkMode,
} from "../src/policy/work-mode.ts"
import { readFileTool } from "../src/tools/read_file.ts"
import type { ToolCall } from "../vendor/minicore/src/core/types.ts"
import { type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"
import { cellOf, WORK_MODE_CELLS } from "./helpers/work-mode-matrix.ts"

const ALL_MODES: PermissionMode[] = ["auto", "readonly", "plan", "allow-all", "ask", "allowlist"]

type Ask = (call: { name: string; args?: unknown }) => Promise<"allow" | "deny" | "always">

type ReasonedHandler = {
  check(c: ToolCall, deps?: unknown): Promise<"allow" | "deny">
  describeDenial(c: ToolCall): string | undefined
  __setMode(m: PermissionMode): void
  __getMode(): PermissionMode
}

let seq = 0
const call = (tag: string, name: string, args: unknown): ToolCall => ({
  id: `${tag}-${++seq}`,
  name,
  args,
})

let tty: FakeTty | undefined
const roots: string[] = []
afterEach(() => {
  tty?.restore()
  tty = undefined
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function tmpRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `mc-wm-${tag}-`))
  roots.push(root)
  return root
}

function wrap(mode: PermissionMode, workMode: WorkMode, root: string, ask?: Ask): ReasonedHandler {
  const base = createPermissionHandler({ mode, root, ...(ask ? { ask } : {}) })
  return composeWorkModePermissionHandler({ workMode, base, root }) as unknown as ReasonedHandler
}

// ── Subproses terisolasi (HOME/USERPROFILE fresh) ──
//
// [KENAPA SUBPROSES] `GLOBAL_ALLOW` di allowlist.ts dihitung SAAT IMPORT dari
// `homedir()`: mengubah process.env.HOME setelah permission.ts ter-import tidak
// berpengaruh. Jalur yang membaca allowlist global user — mode `ask` untuk tool
// non-read-only (`getAllowlist`) dan `promptAskOr` saat TTY+ask — karena itu
// dipaksa berjalan di proses anak ber-HOME temp: keputusan deterministik
// terlepas dari isi `~/.minicode/allowlist.json` mesin ini.
const repoRoot = join(import.meta.dir, "..")
const permissionModule = JSON.stringify(join(repoRoot, "src", "policy", "permission.ts"))
const workModeModule = JSON.stringify(join(repoRoot, "src", "policy", "work-mode.ts"))
const childPrelude = `
  const { createPermissionHandler } = await import(${permissionModule})
  const { createWorkModePermissionHandler, composeWorkModePermissionHandler } = await import(${workModeModule})
  const emit = (payload) => console.log(JSON.stringify(payload))
`

async function runIsolated(script: string): Promise<Record<string, unknown>> {
  const home = await mkdtemp(join(tmpdir(), "mc-wm-home-"))
  try {
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`runner terisolasi gagal (exit ${code}): ${err}`)
    const line = out.trim().split("\n").filter(Boolean).at(-1) ?? ""
    if (!line) throw new Error("runner terisolasi tanpa output")
    return JSON.parse(line) as Record<string, unknown>
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

// Korpus argumen deterministik (check hanya membaca field; tak mengeksekusi).
const CORPUS: readonly (readonly [string, Record<string, unknown>])[] = [
  ["read_file", { path: "probe.txt" }],
  ["write_file", { path: "probe.txt", content: "x" }],
  ["bash", { cmd: "echo hi" }],
  ["todo_write", { todos: [] }],
  ["submit_result", { result: {} }],
  ["delegate_task", { prompt: "x" }],
  ["code_run", { lang: "node", code: "1" }],
  ["write_memory", { text: "x" }],
  ["mcp_call", { server: "s", tool: "t" }],
]

// Di luar READONLY_TOOLS (termasuk tiga ekstra plan) — ceiling DISCUSS harus
// menolaknya TANPA memanggil handler PM (karena itu prompt tak boleh muncul).
const OUTSIDE_READONLY: readonly string[] = [
  "write_file",
  "edit",
  "apply_patch",
  "move_file",
  "delete_file",
  "bash",
  "todo_write",
  "delegate_task",
  "submit_result",
  "write_memory",
  "forget_memory",
  "mcp_call",
  "git_commit",
  "ask_user",
  "code_run",
]

const ARGS: Record<string, Record<string, unknown>> = Object.fromEntries(CORPUS)

// ── Fixture & komposisi ──

describe("S2.1 — fixture & komposisi", () => {
  test("fixture mencakup 18 sel unik", () => {
    expect(WORK_MODE_CELLS).toHaveLength(18)
    const keys = WORK_MODE_CELLS.map((c) => `${c.workMode}|${c.permissionMode}`)
    expect(new Set(keys).size).toBe(18)
  })

  test("factory menolak base tanpa __getMode/__setMode (fail-closed)", () => {
    const bare = { check: async () => "allow" as const }
    expect(() =>
      createWorkModePermissionHandler({
        workMode: "PLAN",
        base: bare as never,
        root: tmpRoot("nocontrol"),
      }),
    ).toThrow(/__getMode/)
  })
})

// ── Requirement 1: EXECUTE = identitas untuk keenam PM ──

describe("EXECUTE — identitas keenam PermissionMode", () => {
  for (const mode of ALL_MODES) {
    test(`EXECUTE × ${mode}: base dipakai apa adanya (identitas objek + kontrol mode)`, () => {
      const root = tmpRoot(`exec-${mode}`)
      const base = createPermissionHandler({ mode, root })
      const composed = composeWorkModePermissionHandler({ workMode: "EXECUTE", base, root })
      // Identitas objek: EXECUTE tidak membungkus/mengganti handler PM.
      expect(composed).toBe(base)
      expect((composed as unknown as ReasonedHandler).__getMode()).toBe(mode)
    })
  }

  test("EXECUTE × 6 PM × 9 tool: keputusan identik dengan handler referensi (HOME terisolasi)", async () => {
    const root = tmpRoot("exec-corpus")
    // Mode `ask` (dan sebagian jalur `auto`) membaca allowlist global — seluruh
    // korpus perbandingan dijalankan di anak ber-HOME temp, bukan in-process.
    const r = await runIsolated(`
      ${childPrelude}
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
      const root = ${JSON.stringify(root)}
      const MODES = ${JSON.stringify(ALL_MODES)}
      const CORPUS = ${JSON.stringify(CORPUS)}
      const results = []
      for (const mode of MODES) {
        const base = createPermissionHandler({ mode, root })
        const composed = composeWorkModePermissionHandler({ workMode: "EXECUTE", base, root })
        const ref = createPermissionHandler({ mode, root })
        const decisions = []
        for (const [name, args] of CORPUS) {
          const a = await composed.check({ id: "ex-a-" + mode + "-" + name, name, args }, {})
          const b = await ref.check({ id: "ex-b-" + mode + "-" + name, name, args }, {})
          decisions.push([name, a, b])
        }
        results.push({ mode, identity: composed === base, decisions })
      }
      emit({ home: process.env.HOME, results })
    `)
    // Bukti isolasi: HOME anak bukan HOME user.
    expect(String(r.home)).not.toBe(process.env.HOME)
    expect(String(r.home).startsWith(tmpdir())).toBe(true)
    const results = r.results as Array<{
      mode: string
      identity: boolean
      decisions: Array<[string, string, string]>
    }>
    expect(results.map((entry) => entry.mode)).toEqual(ALL_MODES)
    const notIdentity: string[] = []
    const mismatches: string[] = []
    for (const entry of results) {
      if (!entry.identity) notIdentity.push(entry.mode)
      for (const [name, a, b] of entry.decisions) {
        if (a !== b) mismatches.push(`${entry.mode} × ${name}: composed=${a} referensi=${b}`)
      }
    }
    expect(notIdentity).toEqual([])
    expect(mismatches).toEqual([])
  })
})

// ── Requirement 2: DISCUSS = ceiling read-only ──

describe("DISCUSS — ceiling read-only", () => {
  for (const mode of ALL_MODES) {
    test(`DISCUSS × ${mode}: luar ceiling deny tanpa prompt; dalam ceiling allow`, async () => {
      // TTY + ask capaz-allow: kalau ceiling bocor ke base (mis. ask/auto),
      // prompt pasti terpanggil — assertion prompts=0 membuktikannya tidak.
      tty = installFakeTty({ isTTY: true })
      const root = tmpRoot(`discuss-${mode}`)
      let prompts = 0
      const h = wrap(mode, "DISCUSS", root, async () => {
        prompts++
        return "allow"
      })
      for (const name of OUTSIDE_READONLY) {
        const c = call(`disc-${mode}-${name}`, name, ARGS[name] ?? {})
        expect(await h.check(c, {} as never)).toBe("deny")
      }
      expect(prompts).toBe(0)
      // Dalam ceiling: base tetap memutuskan (semua PM allow read-only).
      for (const name of ["read_file", "web_fetch", "web_search"]) {
        expect(
          await h.check(call(`disc-in-${mode}-${name}`, name, ARGS[name] ?? {}), {} as never),
        ).toBe("allow")
      }
      expect(prompts).toBe(0)
    })
  }

  test("DISCUSS × allow-all: jail tetap menahan baca luar root & berkas sensitif", async () => {
    const root = tmpRoot("discuss-jail")
    const h = wrap("allow-all", "DISCUSS", root)
    const outside = call("disc-jail-out", "read_file", { path: "../rahasia.txt" })
    expect(await h.check(outside, {} as never)).toBe("deny")
    expect(h.describeDenial(outside)).toBe("jail: outside workspace")
    const sensitive = call("disc-jail-env", "read_file", { path: join(root, ".env") })
    expect(await h.check(sensitive, {} as never)).toBe("deny")
    expect(h.describeDenial(sensitive)).toBe("jail: sensitive file")
  })
})

// ── Requirement 3: PLAN menolak di luar ceiling plan ──

const OUTSIDE_PLAN: readonly string[] = [
  "write_file",
  "edit",
  "apply_patch",
  "move_file",
  "delete_file",
  "bash",
  "code_run",
  "write_memory",
  "forget_memory",
  "mcp_call",
  "git_commit",
  "ask_user",
]

describe("PLAN — ceiling plan vs read-only", () => {
  test("PLAN × auto: di luar ceiling plan ditolak (tanpa menyentuh base)", async () => {
    tty = installFakeTty({ isTTY: true })
    const root = tmpRoot("plan-auto-out")
    let prompts = 0
    const h = wrap("auto", "PLAN", root, async () => {
      prompts++
      return "allow"
    })
    for (const name of OUTSIDE_PLAN) {
      expect(await h.check(call(`plan-out-${name}`, name, ARGS[name] ?? {}), {} as never)).toBe("deny")
    }
    expect(prompts).toBe(0)
    expect(await h.check(call("plan-in-read", "read_file", { path: "probe.txt" }), {} as never)).toBe("allow")
  })

  test("PLAN × plan & allow-all: ekstra plan tetap ada; bash di luar ceiling", async () => {
    for (const mode of ["plan", "allow-all"] as const) {
      const root = tmpRoot(`plan-native-${mode}`)
      let prompts = 0
      // TTY + ask allow: bukti ekstra plan tidak memicu prompt (plan/allow-all
      // memang tak pernah prompt; ini kontrol negatif).
      const h = wrap(mode, "PLAN", root, async () => {
        prompts++
        return "allow"
      })
      for (const name of ["read_file", "todo_write", "submit_result", "delegate_task"]) {
        expect(await h.check(call(`plan-native-${mode}-${name}`, name, ARGS[name]!), {} as never)).toBe(
          "allow",
        )
      }
      expect(prompts).toBe(0)
      // Bash tetap di luar ceiling plan (tidak sampai ke base).
      const bash = call(`plan-native-${mode}-bash`, "bash", { cmd: "echo hi" })
      expect(await h.check(bash, {} as never)).toBe("deny")
      expect(h.describeDenial(bash)).toBe("plan mode")
    }
  })

  test("PLAN × plan & allow-all: jail independen tetap menahan baca luar root", async () => {
    for (const mode of ["plan", "allow-all"] as const) {
      const root = tmpRoot(`plan-jail-${mode}`)
      const h = wrap(mode, "PLAN", root)
      const outside = call(`plan-jail-${mode}`, "read_file", { path: "../rahasia.txt" })
      expect(await h.check(outside, {} as never)).toBe("deny")
      expect(h.describeDenial(outside)).toBe("jail: outside workspace")
    }
  })

  test("PLAN × allowlist/readonly: ceiling read-only lebih ketat dari base", async () => {
    for (const mode of ["allowlist", "readonly"] as const) {
      const root = tmpRoot(`plan-strict-${mode}`)
      const h = wrap(mode, "PLAN", root)
      // Dalam ceiling read-only: tetap allow walau base allowlist/readonly.
      expect(await h.check(call(`plan-strict-${mode}-r`, "read_file", { path: "probe.txt" }), {} as never)).toBe(
        "allow",
      )
      // Di luar ceiling: base allowlist akan allow (write_file/write_memory/
      // bash echo) — ceiling read-only menahannya lebih dulu.
      for (const name of ["write_file", "write_memory", "bash", "todo_write", "submit_result", "delegate_task"]) {
        const c = call(`plan-strict-${mode}-${name}`, name, ARGS[name] ?? {})
        expect(await h.check(c, {} as never)).toBe("deny")
        expect(h.describeDenial(c)).toBe("read-only mode")
      }
    }
  })
})

// ── Requirement 4/5 + 8: gerbang approval PLAN × auto/ask ──

/**
 * Probe satu skenario gerbang di anak ber-HOME temp: allowlist global user
 * tidak boleh memengaruhi keputusan maupun jumlah prompt.
 */
async function runGateProbe(opts: {
  mode: "auto" | "ask"
  tty: boolean
  answer: "allow" | "deny"
}): Promise<Record<string, unknown>> {
  const root = tmpRoot(`gate-${opts.mode}-${opts.tty ? "tty" : "headless"}-${opts.answer}`)
  return runIsolated(`
    ${childPrelude}
    Object.defineProperty(process.stdin, "isTTY", { value: ${opts.tty}, configurable: true })
    const root = ${JSON.stringify(root)}
    let asks = 0
    const base = createPermissionHandler({ mode: ${JSON.stringify(opts.mode)}, root, ask: async () => { asks++; return ${JSON.stringify(opts.answer)} } })
    const h = createWorkModePermissionHandler({ workMode: "PLAN", base, root })
    const c = { id: "gate-probe", name: "delegate_task", args: { prompt: "x" } }
    const decision = await h.check(c, {})
    emit({ decision, asks, reason1: h.describeDenial(c), reason2: h.describeDenial(c) })
  `)
}

describe("PLAN × auto/ask — gerbang approval delegate_task dipertahankan", () => {
  test("PLAN × auto headless: deny tanpa prompt, alasan dari base PM", async () => {
    const r = await runGateProbe({ mode: "auto", tty: false, answer: "allow" })
    expect(r.decision).toBe("deny")
    expect(r.asks).toBe(0)
    // Ceiling plan ALLOW (delegate ada di set plan) tetapi base auto deny —
    // bukti ceiling tidak menggantikan keputusan base (requirement 8).
    expect(r.reason1).toBe("gated approval unavailable")
    expect(r.reason2).toBeUndefined()
  })

  test("PLAN × auto TTY: prompt dipanggil; allow/deny user dihormati", async () => {
    const allow = await runGateProbe({ mode: "auto", tty: true, answer: "allow" })
    expect(allow.decision).toBe("allow")
    expect(allow.asks).toBe(1)
    const deny = await runGateProbe({ mode: "auto", tty: true, answer: "deny" })
    expect(deny.decision).toBe("deny")
    expect(deny.asks).toBe(1)
    expect(deny.reason1).toBe("declined by user")
  })

  test("PLAN × ask headless: deny tanpa prompt", async () => {
    const r = await runGateProbe({ mode: "ask", tty: false, answer: "allow" })
    expect(r.decision).toBe("deny")
    expect(r.asks).toBe(0)
    expect(r.reason1).toBe("gated approval unavailable")
  })

  test("PLAN × ask TTY: prompt dipanggil tepat sekali; deny user dihormati", async () => {
    const allow = await runGateProbe({ mode: "ask", tty: true, answer: "allow" })
    expect(allow.decision).toBe("allow")
    expect(allow.asks).toBe(1)
    const deny = await runGateProbe({ mode: "ask", tty: true, answer: "deny" })
    expect(deny.decision).toBe("deny")
    expect(deny.asks).toBe(1)
  })
})

// ── Requirement 9/10: metadata PM utuh; ceiling tak hilang saat __setMode ──

describe("runtime mode — WorkMode tidak bocor; ceiling tak bisa dicabut", () => {
  test("__getMode melaporkan PM asli; __setMode diteruskan", () => {
    const root = tmpRoot("rt-meta")
    const h = wrap("auto", "PLAN", root)
    expect(h.__getMode()).toBe("auto")
    h.__setMode("allow-all")
    expect(h.__getMode()).toBe("allow-all")
  })

  test("DISCUSS: ganti PM ke allow-all tetap tidak membuka tulis", async () => {
    const root = tmpRoot("rt-discuss")
    const h = wrap("auto", "DISCUSS", root)
    expect(await h.check(call("rt-d1", "write_file", { path: "p.txt", content: "x" }), {} as never)).toBe("deny")
    h.__setMode("allow-all")
    expect(h.__getMode()).toBe("allow-all")
    expect(await h.check(call("rt-d2", "write_file", { path: "p.txt", content: "x" }), {} as never)).toBe("deny")
    expect(await h.check(call("rt-d3", "read_file", { path: "p.txt" }), {} as never)).toBe("allow")
  })

  test("PLAN × allowlist → __setMode(auto): seleksi ceiling ikut mode saat ini", async () => {
    const root = tmpRoot("rt-plan")
    const h = wrap("allowlist", "PLAN", root)
    expect(await h.check(call("rt-p1", "write_file", { path: "p.txt", content: "x" }), {} as never)).toBe("deny")
    expect(await h.check(call("rt-p2", "todo_write", { todos: [] }), {} as never)).toBe("deny")
    h.__setMode("auto")
    // Ceiling plan bertahan (write tetap ditolak), ekstra plan kembali terbuka,
    // dan gerbang base auto tetap berlaku (delegate headless deny).
    expect(await h.check(call("rt-p3", "write_file", { path: "p.txt", content: "x" }), {} as never)).toBe("deny")
    expect(await h.check(call("rt-p4", "todo_write", { todos: [] }), {} as never)).toBe("allow")
    expect(await h.check(call("rt-p5", "delegate_task", { prompt: "x" }), {} as never)).toBe("deny")
  })
})

// ── Requirement 11: describeDenial read-once dari pemilik keputusan ──

describe("describeDenial — alasan dari handler yang memutuskan", () => {
  test("ceiling deny: alasan ceiling, baca-sekali", async () => {
    const root = tmpRoot("dd-ceiling")
    const h = wrap("auto", "DISCUSS", root)
    const c = call("dd-c", "write_file", { path: "p.txt", content: "x" })
    expect(await h.check(c, {} as never)).toBe("deny")
    expect(h.describeDenial(c)).toBe("read-only mode")
    expect(h.describeDenial(c)).toBeUndefined()
  })

  test("base deny di dalam ceiling: alasan base, bukan alasan ceiling", async () => {
    tty = installFakeTty({ isTTY: false })
    const root = tmpRoot("dd-base")
    const h = wrap("auto", "PLAN", root)
    const c = call("dd-b", "delegate_task", { prompt: "x" })
    expect(await h.check(c, {} as never)).toBe("deny")
    expect(h.describeDenial(c)).toBe("gated approval unavailable")
    expect(h.describeDenial(c)).toBeUndefined()
  })

  test("allow tak punya alasan; membaca alasan tak mengubah keputusan berikutnya", async () => {
    const root = tmpRoot("dd-allow")
    const h = wrap("auto", "DISCUSS", root)
    const ok = call("dd-ok", "read_file", { path: "probe.txt" })
    expect(await h.check(ok, {} as never)).toBe("allow")
    expect(h.describeDenial(ok)).toBeUndefined()
    const c = call("dd-again", "bash", { cmd: "echo hi" })
    expect(await h.check(c, {} as never)).toBe("deny")
    expect(h.describeDenial(c)).toBe("read-only mode")
    expect(await h.check(c, {} as never)).toBe("deny")
    expect(h.describeDenial(c)).toBe("read-only mode")
  })
})

// ── Requirement 12: abort tetap deny tanpa prompt ──

describe("abort — perilaku lama dipertahankan di bawah WorkMode", () => {
  test("signal sudah aborted: deny tanpa prompt, tanpa alasan", async () => {
    const root = tmpRoot("abort")
    let prompts = 0
    const h = wrap("auto", "PLAN", root, async () => {
      prompts++
      return "allow"
    })
    const controller = new AbortController()
    controller.abort()
    const c = call("abort-1", "delegate_task", { prompt: "x" })
    expect(await h.check(c, { signal: controller.signal })).toBe("deny")
    expect(prompts).toBe(0)
    expect(h.describeDenial(c)).toBeUndefined()
  })
})

// ── Requirement 12: K-1 always utuh lewat wrapper (subproses HOME terisolasi) ──

describe("K-1 always — persistensi repo-lokal tetap utuh melalui wrapper", () => {
  test("PLAN × ask 'always': tulis <root>/.minicode/allowlist.json + grant sesi", async () => {
    const root = tmpRoot("always")
    const args = { prompt: "p12-wm-always" }
    const script = `
      ${childPrelude}
      const { existsSync, readFileSync } = await import("node:fs")
      const { join } = await import("node:path")
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
      const root = ${JSON.stringify(root)}
      const args = ${JSON.stringify(args)}
      let asks = 0
      const base = createPermissionHandler({ mode: "ask", root, ask: async () => { asks++; return "always" } })
      const h = createWorkModePermissionHandler({ workMode: "PLAN", base, root })
      const first = await h.check({ id: "wm-a1", name: "delegate_task", args }, {})
      const asksAfterFirst = asks
      const second = await h.check({ id: "wm-a2", name: "delegate_task", args }, {})
      const asksAfterSecond = asks
      const file = join(root, ".minicode", "allowlist.json")
      const allowed = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).allowed : null
      emit({ first, second, asksAfterFirst, asksAfterSecond, allowed, key: "delegate_task:" + JSON.stringify(args) })
    `
    const r = await runIsolated(script)
    expect(r.first).toBe("allow")
    expect(r.asksAfterFirst).toBe(1)
    // Grant sesi in-memory hidup di handler base (wrapper hanya mendelegasikan).
    expect(r.second).toBe("allow")
    expect(r.asksAfterSecond).toBe(1)
    expect(r.allowed).toEqual([r.key])
  })
})

// ── Wiring sesi: fail-closed handler terinjeksi; metadata PM utuh ──

describe("createMinicodeSession — wiring S2.1 (handler-layer saja)", () => {
  test("workMode non-EXECUTE + permissionHandler terinjeksi → fail-closed", async () => {
    const base = createPermissionHandler({ mode: "auto", root: tmpRoot("inj") })
    await expect(createMinicodeSession({ permissionHandler: base, workMode: "PLAN" })).rejects.toThrow(
      /workMode/,
    )
  })

  test("workMode PLAN × PM auto: onPermissions melaporkan 'auto', bukan WorkMode", async () => {
    const dir = tmpRoot("session")
    await mkdir(join(dir, ".minicode"), { recursive: true })
    let mode: string | undefined
    await createMinicodeSession({
      provider: new FakeProvider([]),
      tools: [readFileTool],
      cwd: dir,
      permissionMode: "auto",
      workMode: "PLAN",
      onPermissions: (c) => {
        mode = c.getMode()
      },
    })
    expect(mode).toBe("auto")
  })

  test("tanpa workMode (default EXECUTE): mode PM dilaporkan apa adanya", async () => {
    const dir = tmpRoot("session-default")
    await mkdir(join(dir, ".minicode"), { recursive: true })
    let mode: string | undefined
    await createMinicodeSession({
      provider: new FakeProvider([]),
      tools: [readFileTool],
      cwd: dir,
      permissionMode: "plan",
      onPermissions: (c) => {
        mode = c.getMode()
      },
    })
    expect(mode).toBe("plan")
  })
})

// Fixture dipakai juga sebagai lookup eksplisit agar drift tabel ketahuan di
// dua sumbu: data fixture vs perilaku produksi.
test("fixture: sel PLAN × auto/ask ber-ceiling plan (gerbang base dipertahankan)", () => {
  expect(cellOf("PLAN", "auto").ceiling).toBe("plan")
  expect(cellOf("PLAN", "ask").ceiling).toBe("plan")
  expect(cellOf("PLAN", "allowlist").ceiling).toBe("readonly")
  expect(cellOf("DISCUSS", "allow-all").ceiling).toBe("readonly")
})
