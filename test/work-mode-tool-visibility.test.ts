// Kontrak visibilitas tool WorkMode (P12 S2.2) — ceiling di lapisan tool layer.
//
// INV-WM1: WorkMode TIDAK PERNAH memperluas akses yang sudah dibatasi permission
// mode; ia hanya mempersempit. Filter di `src/app/tool-layer.ts` digabung sebagai
// IRISAN (tool harus lolos filter permission mode DAN filter WorkMode). Slice ini
// BUKAN defense-in-depth permission (deny tetap di handler) — ia menghindari model
// membuang langkah mencoba tool yang pasti ditolak, dan menutup kebocoran tool
// MCP runtime ke posture non-EXECUTE.

import { describe, expect, test } from "bun:test"
import type { Tool } from "#minicore"
import { applyWorkModeFilter, setupToolLayer, workModeVisible } from "../src/app/tool-layer.ts"
import {
  LOCAL_READONLY_TOOL_NAMES,
  NETWORK_READ_TOOL_NAMES,
  READONLY_TOOL_NAMES,
} from "../src/policy/tool-contract.ts"
import { allTools } from "../src/tools/index.ts"
import { EXPLORE_TOOL_NAMES } from "../src/tools/task.ts"

// Tool bawaan (tanpa MCP/LSP — cfg kosong). Semua panggilan di file ini memakai
// `{ providers: [] }` sehingga MCP/LSP tidak ter-spawn; yang diuji adalah nama
// tool yang benar-benar terlihat pada daftar statis.
const cfgEmpty = { providers: [] } as never
const nameOf = (ts: readonly Tool[]) => ts.map((t) => t.name)

const WRITE_TOOLS = [
  "write_file",
  "edit",
  "apply_patch",
  "move_file",
  "delete_file",
  "bash",
  "code_run",
  "write_memory",
  "forget_memory",
  "git_commit",
  "mcp_call",
  "mcp_read",
  "mcp_prompt",
  "ask_user",
]

const PLAN_EXTRA = ["todo_write", "delegate_task", "submit_result"] as const

describe("work-mode tool visibility — fixture", () => {
  test("himpunan kontrak baca (EXPLORE=12, LOCAL_READONLY=16, READONLY=18) ada di allTools", () => {
    const names = new Set(nameOf(allTools))
    expect(EXPLORE_TOOL_NAMES.length).toBe(12)
    expect(LOCAL_READONLY_TOOL_NAMES.length).toBe(16)
    expect(READONLY_TOOL_NAMES.size).toBe(18)
    for (const n of EXPLORE_TOOL_NAMES) expect(names.has(n)).toBe(true)
    for (const n of LOCAL_READONLY_TOOL_NAMES) expect(names.has(n)).toBe(true)
    for (const n of READONLY_TOOL_NAMES) expect(names.has(n)).toBe(true)
  })

  test("predikat workModeVisible: EXECUTE = identitas, DISCUSS = 16 local read, PLAN = 18/21 sesuai PM", () => {
    expect(workModeVisible("read_file", "EXECUTE")).toBe(true)
    expect(workModeVisible("write_file", "EXECUTE")).toBe(true)
    // DISCUSS (Q1=A1, Q2=A2): 16 local read visible, network read disembunyikan.
    expect(workModeVisible("read_file", "DISCUSS")).toBe(true)
    expect(workModeVisible("read_image", "DISCUSS")).toBe(true)
    expect(workModeVisible("git_diff", "DISCUSS")).toBe(true)
    expect(workModeVisible("lsp_references", "DISCUSS")).toBe(true)
    expect(workModeVisible("lsp_symbols", "DISCUSS")).toBe(true)
    expect(workModeVisible("web_fetch", "DISCUSS")).toBe(false)
    expect(workModeVisible("web_search", "DISCUSS")).toBe(false)
    expect(workModeVisible("write_file", "DISCUSS")).toBe(false)
    // PLAN default/auto: 18 READONLY_TOOL_NAMES + 3 PLAN_EXTRA = 21.
    expect(workModeVisible("read_file", "PLAN")).toBe(true)
    expect(workModeVisible("web_fetch", "PLAN")).toBe(true)
    expect(workModeVisible("web_search", "PLAN")).toBe(true)
    expect(workModeVisible("todo_write", "PLAN")).toBe(true)
    expect(workModeVisible("delegate_task", "PLAN")).toBe(true)
    expect(workModeVisible("submit_result", "PLAN")).toBe(true)
    expect(workModeVisible("write_file", "PLAN")).toBe(false)
    expect(workModeVisible("bash", "PLAN")).toBe(false)
    // PLAN × allowlist/readonly (G5): PLAN_EXTRA disembunyikan agar visible === callable.
    expect(workModeVisible("todo_write", "PLAN", "allowlist")).toBe(false)
    expect(workModeVisible("delegate_task", "PLAN", "readonly")).toBe(false)
    expect(workModeVisible("read_file", "PLAN", "allowlist")).toBe(true)
  })
})

describe("DISCUSS × permission mode — tepat 16 tool baca lokal tanpa network read", () => {
  for (const pm of ["auto", "ask", "plan", "allow-all", "allowlist", "readonly"] as const) {
    test(`DISCUSS × ${pm}: tepat 16 LOCAL_READONLY_TOOL_NAMES`, async () => {
      const { sessionTools } = await setupToolLayer(
        cfgEmpty,
        "full",
        pm,
        undefined,
        undefined,
        "DISCUSS",
      )
      const names = nameOf(sessionTools)
      expect(names).toHaveLength(16)
      for (const w of WRITE_TOOLS) expect(names).not.toContain(w)
      for (const net of NETWORK_READ_TOOL_NAMES) expect(names).not.toContain(net)
      for (const n of LOCAL_READONLY_TOOL_NAMES) expect(names).toContain(n)
      for (const n of names) expect(LOCAL_READONLY_TOOL_NAMES).toContain(n)
    })
  }
})

describe("PLAN × permission mode — tidak memperluas permission mode (visible === callable)", () => {
  for (const pm of ["auto", "ask", "plan", "allow-all"] as const) {
    test(`PLAN × ${pm}: tepat 21 tool (18 READONLY + 3 PLAN_EXTRA)`, async () => {
      const { sessionTools } = await setupToolLayer(
        cfgEmpty,
        "full",
        pm,
        undefined,
        undefined,
        "PLAN",
      )
      const names = nameOf(sessionTools)
      const allowed = new Set([...READONLY_TOOL_NAMES, ...PLAN_EXTRA])
      expect(names).toHaveLength(21)
      for (const n of allowed) expect(names).toContain(n)
      for (const n of names) expect(allowed.has(n)).toBe(true)
      for (const w of ["write_file", "bash", "code_run", "write_memory", "git_commit"]) {
        expect(names).not.toContain(w)
      }
    })
  }

  for (const pm of ["readonly", "allowlist"] as const) {
    test(`PLAN × ${pm}: tepat 18 READONLY_TOOL_NAMES tanpa PLAN_EXTRA (G5 tertutup)`, async () => {
      const { sessionTools } = await setupToolLayer(
        cfgEmpty,
        "full",
        pm,
        undefined,
        undefined,
        "PLAN",
      )
      const names = nameOf(sessionTools)
      expect(names).toHaveLength(18)
      for (const n of READONLY_TOOL_NAMES) expect(names).toContain(n)
      for (const n of names) expect(READONLY_TOOL_NAMES).toContain(n)
      for (const extra of PLAN_EXTRA) expect(names).not.toContain(extra)
    })
  }
})

describe("EXECUTE × permission mode — perilaku lama + keselarasan READONLY_TOOL_NAMES", () => {
  test("EXECUTE × auto: semua tool bawaan", async () => {
    const { sessionTools } = await setupToolLayer(
      cfgEmpty,
      "full",
      "auto",
      undefined,
      undefined,
      "EXECUTE",
    )
    expect(nameOf(sessionTools)).toHaveLength(allTools.length)
  })
  test("EXECUTE (tanpa argumen, default) × auto: semua tool bawaan", async () => {
    const { sessionTools } = await setupToolLayer(cfgEmpty, "full", "auto")
    expect(nameOf(sessionTools)).toHaveLength(allTools.length)
  })
  test("EXECUTE × readonly: tepat 18 READONLY_TOOL_NAMES", async () => {
    const { sessionTools } = await setupToolLayer(
      cfgEmpty,
      "full",
      "readonly",
      undefined,
      undefined,
      "EXECUTE",
    )
    const names = nameOf(sessionTools)
    expect(names).toHaveLength(18)
    for (const n of READONLY_TOOL_NAMES) expect(names).toContain(n)
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w)
  })
  test("EXECUTE × plan: tepat 21 tool (18 READONLY + 3 PLAN_EXTRA)", async () => {
    const { sessionTools } = await setupToolLayer(
      cfgEmpty,
      "full",
      "plan",
      undefined,
      undefined,
      "EXECUTE",
    )
    const names = nameOf(sessionTools)
    expect(names).toHaveLength(21)
    for (const n of READONLY_TOOL_NAMES) expect(names).toContain(n)
    for (const extra of PLAN_EXTRA) expect(names).toContain(extra)
  })
  test("transisi runtime setPermissionMode + setWorkMode menyinkronkan sessionTools in-place", async () => {
    const { sessionTools, setWorkMode, setPermissionMode } = await setupToolLayer(
      cfgEmpty,
      "full",
      "auto",
      undefined,
      undefined,
      "PLAN",
    )
    expect(sessionTools).toHaveLength(21)
    setPermissionMode!("allowlist")
    expect(sessionTools).toHaveLength(18)
    expect(nameOf(sessionTools)).not.toContain("todo_write")
    setWorkMode!("DISCUSS")
    expect(sessionTools).toHaveLength(16)
    expect(nameOf(sessionTools)).not.toContain("web_fetch")
    setWorkMode!("EXECUTE")
    setPermissionMode!("auto")
    expect(sessionTools).toHaveLength(allTools.length)
  })
})

describe("tool MCP mengikuti batasan WorkMode", () => {
  // Tool MCP runtime ber-nama bertitik `<server>.<tool>`. Predikat workModeVisible
  // dipakai filter MCP di setupToolLayer — test ini memverifikasi nama MCP tak
  // pernah lolos DISCUSS/PLAN (mcp_list adalah tool statis CLI, bukan ini).
  const mcpTool = (name: string): Tool =>
    ({ name, parameters: { type: "object", properties: {} } }) as unknown as Tool

  test("DISCUSS menolak tool MCP runtime bertitik", () => {
    expect(workModeVisible("github.list_repos", "DISCUSS")).toBe(false)
    expect(workModeVisible("fs.read", "DISCUSS")).toBe(false)
  })
  test("PLAN menolak tool MCP runtime bertitik", () => {
    expect(workModeVisible("github.list_repos", "PLAN")).toBe(false)
    expect(workModeVisible("fs.read", "PLAN")).toBe(false)
  })
  test("EXECUTE membolehkan tool MCP runtime (perilaku lama)", () => {
    expect(workModeVisible("github.list_repos", "EXECUTE")).toBe(true)
  })
  test("applyWorkModeFilter memfilter daftar tool campuran (bawaan + MCP)", () => {
    const mix = [...allTools, mcpTool("github.list_repos"), mcpTool("fs.read")]
    const discussedNames = nameOf(applyWorkModeFilter(mix, "DISCUSS"))
    expect(discussedNames).not.toContain("github.list_repos")
    expect(discussedNames).not.toContain("fs.read")
    for (const n of discussedNames) expect(LOCAL_READONLY_TOOL_NAMES).toContain(n)
    const plannedNames = nameOf(applyWorkModeFilter(mix, "PLAN"))
    expect(plannedNames).not.toContain("github.list_repos")
    expect(plannedNames).not.toContain("fs.read")
  })
})
