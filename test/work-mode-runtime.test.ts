// Kontrak runtime WorkMode (P12 S2.2 Slice 5) — transisi mode pada sesi yang
// SEDANG BERJALAN, bukan hanya tampilan.
//
// Yang dibuktikan di sini (bukan sekadar parser/footer):
// 1. Permission ceiling handler membaca WorkMode terbaru (__setWorkMode).
// 2. Tool visibility yang dilihat kernel ikut berubah (registry.list() hidup).
// 3. Hooks mengikuti WorkMode AKTIF (bukan snapshot saat session dibuat).
// 4. Delegasi berikutnya mewarisi WorkMode parent yang aktif.
// 5. WorkMode tak bisa dinaikkan otomatis oleh argumen delegasi/anak.
// 6. Command `/work-mode` benar-benar mengubah state (TUI end-to-end).
// 7. Footer mencerminkan kombinasi WorkMode + permission mode.
//
// WorkMode adalah lapis intent di ATAS permission mode: tidak pernah
// menempelkan permission mode (INV-WM1), dan permission mode tak pernah
// dilewati oleh ceiling WorkMode.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolCall } from "#minicore"
import { FakeProvider } from "#minicore/test/fakes.ts"
import type { CliSession } from "../cli/setup.ts"
import { runTui } from "../cli/tui.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import { setupToolLayer } from "../src/app/tool-layer.ts"
import { shouldRunHooks } from "../src/hooks/run.ts"
import { createPermissionHandler, type PermissionMode } from "../src/policy/permission.ts"
import { createWorkModePermissionHandler, type WorkMode } from "../src/policy/work-mode.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  EXPLORE_TOOL_NAMES,
  type SubAgentSpec,
  setSubAgentSessionFactory,
  setSubAgentWorkMode,
} from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"
import { paintFooterMode, renderFooter } from "../src/ui/footer.ts"
import { installFakeTty, KEY } from "./helpers/tui-harness.ts"

const dirs: string[] = []
const roots: string[] = []

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-wm-rt-"))
  roots.push(d)
  return d
}

let tty: ReturnType<typeof installFakeTty> | null = null
afterEach(async () => {
  tty?.restore()
  tty = null
  clearSubAgentSessionFactory()
  for (const d of roots.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {})
})

const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  name,
  args: args as never,
})

type LiveHandler = {
  check(c: ToolCall, d?: unknown): Promise<"allow" | "deny">
  __setMode(m: PermissionMode): void
  __getMode(): PermissionMode
  __setWorkMode(m: WorkMode): void
  __getWorkMode(): WorkMode
}

function liveHandler(workMode: WorkMode, pm: PermissionMode, root: string): LiveHandler {
  const base = createPermissionHandler({ mode: pm, root })
  return createWorkModePermissionHandler({ workMode, base, root }) as unknown as LiveHandler
}

describe("1. permission ceiling mengikuti WorkMode terbaru", () => {
  test("EXECUTE → DISCUSS: write ditolak, read tetap boleh", async () => {
    const root = tmpRoot()
    const h = liveHandler("EXECUTE", "auto", root)
    const write = call("w0", "write_file", { path: "a.txt", content: "x" })
    expect(await h.check(write, {})).toBe("allow")
    h.__setWorkMode("DISCUSS")
    expect(h.__getWorkMode()).toBe("DISCUSS")
    expect(await h.check(call("w1", "write_file", { path: "a.txt", content: "x" }), {})).toBe(
      "deny",
    )
    expect(await h.check(call("r1", "read_file", { path: "a.txt" }), {})).toBe("allow")
  })

  test("DISCUSS → PLAN: ceiling bergerak, tak melebihi ceiling PLAN", async () => {
    const root = tmpRoot()
    const h = liveHandler("DISCUSS", "auto", root)
    // DISCUSS: todo_write (tool rencana) DITOLAK.
    expect(await h.check(call("t0", "todo_write", { todos: [] }), {})).toBe("deny")
    h.__setWorkMode("PLAN")
    // PLAN: todo_write boleh (bagian set-plan), tapi tulis file/bash tetap deny.
    expect(await h.check(call("t1", "todo_write", { todos: [] }), {})).toBe("allow")
    expect(await h.check(call("w1", "write_file", { path: "a.txt", content: "x" }), {})).toBe(
      "deny",
    )
    expect(await h.check(call("b1", "bash", { cmd: "echo hi" }), {})).toBe("deny")
  })

  test("WorkMode tidak menggeser permission mode dasar (INV-WM1)", async () => {
    const root = tmpRoot()
    const h = liveHandler("PLAN", "auto", root)
    h.__setWorkMode("EXECUTE")
    // EXECUTE + PM auto: write boleh (identitas base).
    expect(await h.check(call("w0", "write_file", { path: "a.txt", content: "x" }), {})).toBe(
      "allow",
    )
  })

  test("permission mode → readonly tetap membatasi meski WorkMode PLAN/EXECUTE", async () => {
    const root = tmpRoot()
    for (const wm of ["PLAN", "EXECUTE"] as const) {
      const h = liveHandler(wm, "auto", root)
      h.__setMode("readonly")
      expect(
        await h.check(call(`w-${wm}`, "write_file", { path: "a.txt", content: "x" }), {}),
      ).toBe("deny")
      expect(await h.check(call(`r-${wm}`, "read_file", { path: "a.txt" }), {})).toBe("allow")
    }
  })
})

describe("2. wiring sesi — kontrol WorkMode hidup di composition root", () => {
  test("onWorkMode memberi handle; setWorkMode mengubah state handler", async () => {
    const root = tmpRoot()
    let control: { setWorkMode(m: WorkMode): void; getWorkMode(): WorkMode } | undefined
    await createMinicodeSession({
      provider: new FakeProvider([]),
      tools: [],
      cwd: root,
      permissionMode: "auto",
      workMode: "EXECUTE",
      onWorkMode: (ctl) => {
        control = ctl
      },
    })
    expect(control).toBeDefined()
    expect(control!.getWorkMode()).toBe("EXECUTE")
    control!.setWorkMode("PLAN")
    expect(control!.getWorkMode()).toBe("PLAN")
  })

  test("sesi dengan handler terinjeksi tidak diberi kontrol WorkMode (fail-closed)", async () => {
    const root = tmpRoot()
    let wired = false
    const base = createPermissionHandler({ mode: "auto", root })
    await createMinicodeSession({
      provider: new FakeProvider([]),
      tools: [],
      cwd: root,
      permissionMode: "readonly",
      permissionHandler: base,
      onWorkMode: () => {
        wired = true
      },
    })
    expect(wired).toBe(false)
  })
})

describe("3. tool visibility mengikuti WorkMode aktif (daftar yang dilihat kernel)", () => {
  test("setWorkMode mengubah daftar tool LIVE (array dipegang kernel dimutasi in-place)", async () => {
    const { sessionTools, setWorkMode } = await setupToolLayer(
      { providers: [] } as never,
      "full",
      "auto",
      undefined,
      undefined,
      "EXECUTE",
    )
    const full = sessionTools.length
    expect(setWorkMode).toBeDefined()
    setWorkMode!("DISCUSS")
    // Array yang sama (identitas objek) — kernel menyimpan referensi ini.
    expect(sessionTools.length).toBeLessThan(full)
    for (const n of sessionTools.map((t) => t.name)) expect(EXPLORE_TOOL_NAMES).toContain(n)
    setWorkMode!("PLAN")
    expect(sessionTools.length).toBeLessThan(full)
    expect(sessionTools.map((t) => t.name)).toContain("todo_write")
    setWorkMode!("EXECUTE")
    expect(sessionTools.length).toBe(full)
  })

  test("kernel melihat daftar tool yang diperbarui (context tokens menyusut)", async () => {
    const root = tmpRoot()
    const { sessionTools, setWorkMode } = await setupToolLayer(
      { providers: [] } as never,
      "full",
      "auto",
      undefined,
      undefined,
      "EXECUTE",
    )
    const session = await createMinicodeSession({
      provider: new FakeProvider([]),
      tools: sessionTools,
      cwd: root,
      permissionMode: "auto",
      workMode: "EXECUTE",
    })
    const before = session.contextTokens
    setWorkMode!("DISCUSS")
    // contextTokens dihitung dari `registry.list()` — jadi bila daftar tool
    // kernel ikut berubah, estimasi konteks juga berubah (bukti nyata, bukan
    // asumsi soal array yang dimutasi).
    expect(session.contextTokens).toBeLessThan(before)
  })
})

describe("4. delegasi mewarisi WorkMode parent yang AKTIF", () => {
  const providerEnv = (): (() => void) => {
    const savedKey = process.env.OPENAI_API_KEY
    const savedAgent = process.env.AGENT_API_KEY
    if (!savedKey && !savedAgent) process.env.OPENAI_API_KEY = "sk-test-hermetic"
    return () => {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = savedKey
      if (savedAgent === undefined) delete process.env.AGENT_API_KEY
      else process.env.AGENT_API_KEY = savedAgent
    }
  }
  const ctxFor = (cwd: string, pm: string) =>
    ({
      signal: new AbortController().signal,
      emit: () => {},
      cwd,
      permissionMode: pm,
    }) as never

  test("setelah WorkMode parent berubah, child mewarisi mode terbaru", async () => {
    const restore = providerEnv()
    const dir = tmpRoot()
    dirs.push(dir)
    const prevTodo = todoSession.id
    todoSession.id = "p-wm-rt"
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(async (spec: SubAgentSpec) => {
      seen.push(spec)
      return {
        events: { on: () => () => {} },
        run: async () => ({ finalText: "ok", usage: { steps: 1 } }),
      }
    })
    let wm: WorkMode = "EXECUTE"
    // Handle kontrol seperti composition root: fn live ke state aktif.
    setSubAgentWorkMode(() => wm)
    try {
      await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "auto"))
      expect(seen[0]!.workMode).toBe("EXECUTE")
      // Operator menaikkan work mode parent (aksI eksplisit di TUI).
      wm = "PLAN"
      await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "auto"))
      expect(seen[1]!.workMode).toBe("PLAN")
      // Child tak pernah lebih lebar: tools anak ikut ceiling WorkMode.
      for (const n of seen[1]!.tools.map((t) => t.name)) expect(EXPLORE_TOOL_NAMES).toContain(n)
    } finally {
      todoSession.id = prevTodo
      restore()
    }
  })

  test("argumen delegasi tak bisa menaikkan WorkMode parent", async () => {
    const restore = providerEnv()
    const dir = tmpRoot()
    dirs.push(dir)
    const prevTodo = todoSession.id
    todoSession.id = "p-wm-rt2"
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(async (spec: SubAgentSpec) => {
      seen.push(spec)
      return {
        events: { on: () => () => {} },
        run: async () => ({ finalText: "ok", usage: { steps: 1 } }),
      }
    })
    const wm: WorkMode = "PLAN"
    setSubAgentWorkMode(() => wm)
    try {
      // Model meminta mode "plan" (bukan explore) — tak boleh menaikkan parent.
      await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "auto"))
      expect(seen[0]!.workMode).toBe("PLAN")
      expect(wm).toBe("PLAN")
    } finally {
      todoSession.id = prevTodo
      restore()
    }
  })
})

describe("5. hooks mengikuti WorkMode AKTIF, bukan snapshot", () => {
  test("predicate mengikuti handle kontrol yang berubah", () => {
    let wm: WorkMode = "EXECUTE"
    expect(shouldRunHooks("auto", wm)).toBe(true)
    wm = "DISCUSS"
    expect(shouldRunHooks("auto", wm)).toBe(false)
    wm = "PLAN"
    expect(shouldRunHooks("auto", wm)).toBe(true)
  })

  // Bukti perilaku (bukan grep sumber): `test/work-mode-hooks.test.ts`
  // menjalankan jalur production `createCliSession` → `runPromptWithVerify` →
  // `runHooksGated` → hook Node yang menulis marker, lalu menurunkan WorkMode
  // ke DISCUSS pada SESI YANG SAMA dan membuktikan hook berikutnya dilewati.
  // Assertion bentuk (membaca sumber `cli/setup.ts`) sengaja dihapus: grep
  // sumber jadi basi begitu kode diperbaiki (Prinsip 1 PLAN.md) dan tidak
  // membuktikan apa pun soal perilaku.
})

describe("6. footer mencerminkan kombinasi WorkMode + permission mode", () => {
  test("EXECUTE: label permission mode seperti sebelumnya", () => {
    expect(paintFooterMode("auto", "EXECUTE")).toContain("auto")
    expect(paintFooterMode("auto", "EXECUTE")).not.toContain("EXECUTE")
    expect(paintFooterMode("auto")).toContain("auto")
  })
  test("DISCUSS/PLAN: label dibedakan", () => {
    expect(paintFooterMode("auto", "DISCUSS")).toContain("DISCUSS·auto")
    expect(paintFooterMode("auto", "PLAN")).toContain("PLAN·auto")
    expect(paintFooterMode("readonly", "PLAN")).toContain("PLAN·readonly")
  })
  test("renderFooter menyertakan label WorkMode", () => {
    const line = renderFooter({ mode: "auto", workMode: "PLAN", model: "m1", cwd: "cwd" }, 80)[0]!
    expect(line).toContain("PLAN·auto")
    const plain = renderFooter({ mode: "auto", model: "m1", cwd: "cwd" }, 80)[0]!
    expect(plain).not.toContain("PLAN")
  })
})

describe("8. jalur produksi createCliSession — wiring composition root", () => {
  test("perubahan WorkMode live/updating tool visibility sesi nyata", async () => {
    const { startFakeProvider } = await import("./helpers/fake-provider.ts")
    const { writeFileSync, mkdirSync } = await import("node:fs")
    const cwd = mkdtempSync(join(tmpdir(), "mc-wm-prod-"))
    roots.push(cwd)
    mkdirSync(join(cwd, ".minicode"), { recursive: true })
    const provider = startFakeProvider([{ kind: "text", text: "halo" }])
    writeFileSync(
      join(cwd, ".minicode", "config.json"),
      JSON.stringify({
        providers: [{ id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["m"] }],
      }),
      "utf8",
    )
    const { createCliSession } = await import("../cli/setup.ts")
    const ctx = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
      workMode: "EXECUTE",
    })
    try {
      // Handle kontrol runtime tersedia di composition root.
      expect(ctx.workModeControl).toBeDefined()
      expect(ctx.workModeControl!.getWorkMode()).toBe("EXECUTE")
      const full = ctx.sessionTools.length
      expect(full).toBeGreaterThan(EXPLORE_TOOL_NAMES.length)
      // Transisi operator: tool yang terlihat menyusut pada SESI YANG SAMA.
      ctx.workModeControl!.setWorkMode("DISCUSS")
      expect(ctx.workModeControl!.getWorkMode()).toBe("DISCUSS")
      expect(ctx.sessionTools.length).toBeLessThan(full)
      for (const n of ctx.sessionTools.map((t) => t.name)) expect(EXPLORE_TOOL_NAMES).toContain(n)
      // Kembali ke EXECUTE: daftar penuh kembali.
      ctx.workModeControl!.setWorkMode("EXECUTE")
      expect(ctx.sessionTools.length).toBe(full)
    } finally {
      await ctx.close()
    }
  })
})

describe("7. command /work-mode (TUI end-to-end)", () => {
  const makeControl = (initial: WorkMode) => {
    let wm = initial
    return {
      setWorkMode: (m: WorkMode) => {
        wm = m
      },
      getWorkMode: () => wm,
    }
  }
  const fakeSession = (control: ReturnType<typeof makeControl>): CliSession => {
    const bus = { on: () => () => {}, emit: () => {} }
    const noop = async () => {}
    return {
      session: { events: bus as never, contextTokens: 0 },
      cfg: { providers: [] },
      cwd: tmpdir(),
      sessionId: "wm-tui",
      modelRef: {} as { current?: string },
      permissionMode: "auto",
      permissions: undefined,
      workMode: "EXECUTE",
      workModeControl: control,
      sessionTools: [],
      allLoadedSkills: [],
      allowLocalConfig: false,
      usage: {
        get: () => ({}),
        getSession: () => ({ cost: undefined, totalTokens: 0 }),
        reset: () => {},
      },
      budget: undefined,
      budgetStrict: false,
      persistCurrent: noop,
      runPromptWithVerify: noop,
      close: noop,
    } as unknown as CliSession
  }

  test("/work-mode PLAN mengubah WorkMode aktif; footer ikut berubah", async () => {
    const control = makeControl("EXECUTE")
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession(control))
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    await tty.send("/work-mode PLAN")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("work mode: PLAN"))
    expect(control.getWorkMode()).toBe("PLAN")
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })

  test("/work-mode DISCUSS dan EXECUTE mengubah WorkMode aktif", async () => {
    const control = makeControl("EXECUTE")
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession(control))
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    await tty.send("/work-mode DISCUSS")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("work mode: DISCUSS"))
    expect(control.getWorkMode()).toBe("DISCUSS")
    await tty.send("/work-mode EXECUTE")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("work mode: EXECUTE"))
    expect(control.getWorkMode()).toBe("EXECUTE")
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })

  test("input invalid: pesan error, WorkMode TIDAK berubah", async () => {
    const control = makeControl("PLAN")
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession(control))
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    await tty.send("/work-mode BOGUS")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("unknown work mode"))
    expect(control.getWorkMode()).toBe("PLAN")
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })

  test("tanpa argumen: tampilkan mode aktif + pemakaian", async () => {
    const control = makeControl("PLAN")
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession(control))
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    await tty.send("/work-mode")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("/work-mode <DISCUSS|PLAN|EXECUTE>"))
    expect(control.getWorkMode()).toBe("PLAN")
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })

  test("/mode dan Shift+Tab hanya mengubah permission mode", async () => {
    const control = makeControl("PLAN")
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession(control))
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    // /mode = permission mode.
    await tty.send("/mode readonly")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("mode: readonly"))
    expect(control.getWorkMode()).toBe("PLAN")
    // Shift+Tab = siklus permission mode (WorkMode tak ikut).
    await tty.send(KEY.shiftTab)
    expect(control.getWorkMode()).toBe("PLAN")
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })
})
