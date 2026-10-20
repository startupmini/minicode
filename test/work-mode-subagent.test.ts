// Kontrak pewarisan WorkMode ke subagent (P12 S2.2, Slice 3) — prioritas
// keamanan tertinggi.
//
// MASALAH YANG DITUTUP: ToolContext.permissionMode hanya membawa permission
// mode (bukan WorkMode), dan kontrak vendor tak boleh diubah. Akibatnya jalur
// `PLAN × auto` (delegate_task di-approve; parentMode="auto" → forcedExplore
// false) melahirkan anak `auto` mode "plan" dengan tool penuh (29 nama,
// termasuk write_file/bash) — eskalasi terhadap ceiling WorkMode induk.
//
// SOLUSI: WorkMode induk disuntikkan ke task.ts dari composition root
// (setSubAgentWorkMode, pola identik setSubAgentParentRunId), lalu diwariskan
// ke SubAgentSpec → child createMinicodeSession → ceiling WorkMode anak
// menahan tulis (INV-WM1). Tanpa setter (default) perilaku lama utuh.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolCall } from "#minicore"
import { createPermissionHandler, type PermissionMode } from "../src/policy/permission.ts"
import { composeWorkModePermissionHandler } from "../src/policy/work-mode.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  EXPLORE_TOOL_NAMES,
  type SubAgentSpec,
  setSubAgentSessionFactory,
  setSubAgentWorkMode,
} from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "mc-wm-sub-"))
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

// Provider fallback agar getProvider() jalan tanpa config (pola hardening,
// sama seperti delegate-audit.test.ts).
function providerEnv(): () => void {
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

const ctxFor = (cwd: string, permissionMode?: string) =>
  ({
    signal: new AbortController().signal,
    emit: () => {},
    cwd,
    ...(permissionMode ? { permissionMode } : {}),
  }) as never

function fakeFactory(seen: SubAgentSpec[]) {
  return async (spec: SubAgentSpec) => {
    seen.push(spec)
    return {
      events: { on: () => () => {} },
      run: async () => ({ finalText: "ringkasan anak", usage: { steps: 2 } }),
    }
  }
}

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await cleanup(d)
  clearSubAgentSessionFactory()
})

async function runDelegate(workMode: "PLAN" | "DISCUSS", pm: PermissionMode, modeArg: string) {
  const restore = providerEnv()
  const dir = tmpRoot()
  dirs.push(dir)
  const prevTodo = todoSession.id
  todoSession.id = "p-wm-sub"
  const seen: SubAgentSpec[] = []
  setSubAgentSessionFactory(fakeFactory(seen))
  setSubAgentWorkMode(() => workMode)
  try {
    await delegateTaskTool.execute({ prompt: "x", mode: modeArg }, ctxFor(dir, pm))
    return { spec: seen[0]!, seen }
  } finally {
    todoSession.id = prevTodo
    restore()
  }
}

describe("parent PLAN — child tidak mewarisi EXECUTE hanya karena argumen mode child", () => {
  test("parent PLAN × auto + mode 'plan' → child workMode PLAN, tools explore (bukan 29)", async () => {
    const { spec } = await runDelegate("PLAN", "auto", "plan")
    // Propagar: WorkMode induk diwariskan ke child, TIDAK jatuh ke EXECUTE.
    expect(spec.workMode).toBe("PLAN")
    // Visibilitas: ceiling WorkMode child menyembunyikan tool tulis/eksekusi —
    // jalur lama yang berisiko (mode "plan" parent auto = 29 tool) TERTUTUP.
    const names = spec.tools.map((t) => t.name)
    for (const n of names) expect(EXPLORE_TOOL_NAMES).toContain(n)
    expect(names).toHaveLength(EXPLORE_TOOL_NAMES.length)
    for (const w of ["write_file", "bash", "code_run", "edit"]) expect(names).not.toContain(w)
  })

  test("parent PLAN × auto + mode 'explore' → child workMode PLAN, tools explore", async () => {
    const { spec } = await runDelegate("PLAN", "auto", "explore")
    expect(spec.workMode).toBe("PLAN")
    const names = spec.tools.map((t) => t.name)
    for (const n of names) expect(EXPLORE_TOOL_NAMES).toContain(n)
  })
})

describe("parent DISCUSS — child juga read-only", () => {
  test("parent DISCUSS × auto + mode 'plan' → child workMode DISCUSS, tools explore", async () => {
    const { spec } = await runDelegate("DISCUSS", "auto", "plan")
    expect(spec.workMode).toBe("DISCUSS")
    const names = spec.tools.map((t) => t.name)
    for (const n of names) expect(EXPLORE_TOOL_NAMES).toContain(n)
  })
})

describe("tanpa WorkMode induk — kompatibilitas perilaku lama", () => {
  test("default (tanpa setSubAgentWorkMode) → child workMode EXECUTE, tools penuh", async () => {
    const restore = providerEnv()
    const dir = tmpRoot()
    dirs.push(dir)
    const prevTodo = todoSession.id
    todoSession.id = "p-wm-none"
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(fakeFactory(seen))
    // TIDAK memanggil setSubAgentWorkMode → default undefined → EXECUTE.
    try {
      await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "auto"))
      const spec = seen[0]!
      expect(spec.workMode).toBe("EXECUTE")
      // Perilaku lama: mode "plan" child mendapat tool penuh (29, non-denylist).
      const names = new Set(spec.tools.map((t) => t.name))
      expect(names.has("write_file")).toBe(true)
      expect(names.has("bash")).toBe(true)
    } finally {
      todoSession.id = prevTodo
      restore()
    }
  })
})

describe("child menerapkan ceiling WorkMode PLAN — operasi tulis ditolak", () => {
  // Bukti handler-layer bahwa spec.workMode "PLAN" dipasang pada
  // createMinicodeSession menghasilkan ceiling yang menolak tulis (sama
  // dengan jalur produksi: cli/index.ts factory meneruskan spec.workMode).
  //
  // [ISOLASI] Paksa non-TTY selama test: gate approver membaca
  // `process.stdin.isTTY`, yang bisa disetel true oleh test lain di suite
  // penuh — tanpa paksaan ini, "headless deny" jadi bergantung ambient
  // (pola sama di test/agent-contract.test.ts).
  const forceNonTty = (): (() => void) => {
    const prev = process.stdin.isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
    return () => {
      Object.defineProperty(process.stdin, "isTTY", { value: prev, configurable: true })
    }
  }
  test("workMode PLAN × PM auto: write_file deny, read_file allow, headless no prompt", async () => {
    const dir = tmpRoot()
    dirs.push(dir)
    const restoreTty = forceNonTty()
    let prompts = 0
    const base = createPermissionHandler({
      mode: "auto",
      root: dir,
      ask: async () => {
        prompts++
        return "allow"
      },
    })
    const h = composeWorkModePermissionHandler({
      workMode: "PLAN",
      base,
      root: dir,
    }) as unknown as {
      check(c: ToolCall, d: unknown): Promise<"allow" | "deny">
    }
    const write: ToolCall = { id: "w1", name: "write_file", args: { path: "p.txt", content: "x" } }
    try {
      expect(await h.check(write, {})).toBe("deny")
      expect(prompts).toBe(0)
      const read: ToolCall = { id: "r1", name: "read_file", args: { path: "p.txt" } }
      expect(await h.check(read, {})).toBe("allow")
      expect(prompts).toBe(0)
    } finally {
      restoreTty()
    }
  })

  test("workMode PLAN × PM auto headless: delegate_task deny tanpa prompt (gated approval unavailable)", async () => {
    const dir = tmpRoot()
    dirs.push(dir)
    const restoreTty = forceNonTty()
    let prompts = 0
    const base = createPermissionHandler({
      mode: "auto",
      root: dir,
      ask: async () => {
        prompts++
        return "allow"
      },
    })
    const h = composeWorkModePermissionHandler({
      workMode: "PLAN",
      base,
      root: dir,
    }) as unknown as {
      check(c: ToolCall, d: unknown): Promise<"allow" | "deny">
    }
    // Headless (tanpa TTY) — approval tidak tersedia, TIDAK boleh diloloskan.
    const c: ToolCall = { id: "g1", name: "delegate_task", args: { prompt: "x" } }
    try {
      expect(await h.check(c, {})).toBe("deny")
      expect(prompts).toBe(0)
    } finally {
      restoreTty()
    }
  })
})

describe("interleaving dua parent — WorkMode dibaca LIVE per delegate (bukan snapshot)", () => {
  // Pertanyaan audit Tahap A: apakah WorkMode subagent terisolasi per parent?
  // `setSubAgentWorkMode` adalah state module-global (pola `setSubAgentParentRunId`),
  // dan arsitektur MiniCode membangun SATU createCliSession (parent) per proses
  // (index/exec/acp/daemon). Jadi tidak ada dua parent aktif bersamaan yang bisa
  // saling menimpa WorkMode dalam satu proses.
  //
  // Yang diuji di sini adalah inti mekanisme: `subAgentWorkMode()` dibaca LIVE
  // saat delegate_task dieksekusi (fn disuntikkan), BUKAN value yang terkunci di
  // setter pertama. Jadi bila sesi baru dibangun (setter dipanggil ulang), semua
  // delegate berikutnya memakai WorkMode sesi baru — tidak ada snapshot basi
  // yang mengikat child ke parent lama.
  test("dua parent bergantian (PLAN → EXECUTE → PLAN) — tiap child mewarisi WorkMode saat eksekusinya", async () => {
    const restore = providerEnv()
    const dir = tmpRoot()
    dirs.push(dir)
    const prevTodo = todoSession.id
    todoSession.id = "p-wm-inter"
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(fakeFactory(seen))
    try {
      // Parent #1: PLAN.
      setSubAgentWorkMode(() => "PLAN")
      await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "auto"))
      const first = seen[0]!
      expect(first.workMode).toBe("PLAN")
      // Parent #1 berakhir, sesi #2 dibangun: EXECUTE (WorkMode berubah).
      setSubAgentWorkMode(() => "EXECUTE")
      await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "auto"))
      const second = seen[1]!
      expect(second.workMode).toBe("EXECUTE")
      // Parent #3 kembali ke PLAN: setter baru, delegate berikutnya ikut.
      setSubAgentWorkMode(() => "PLAN")
      await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "auto"))
      const third = seen[2]!
      expect(third.workMode).toBe("PLAN")
      // Bukti urutan: tiga child berbeda, masing-masing dari parent yang benar.
      expect(seen).toHaveLength(3)
    } finally {
      todoSession.id = prevTodo
      restore()
    }
  })
})
