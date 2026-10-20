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

describe("work-mode tool visibility — fixture", () => {
  test("semua nama EXPLORE_TOOL_NAMES ada di allTools", () => {
    const names = new Set(nameOf(allTools))
    for (const n of EXPLORE_TOOL_NAMES) expect(names.has(n)).toBe(true)
  })

  test("predikat workModeVisible: EXECUTE = identitas, DISCUSS/PLAN mempersempit", () => {
    expect(workModeVisible("read_file", "EXECUTE")).toBe(true)
    expect(workModeVisible("write_file", "EXECUTE")).toBe(true)
    expect(workModeVisible("read_file", "DISCUSS")).toBe(true)
    expect(workModeVisible("write_file", "DISCUSS")).toBe(false)
    // PLAN: explore + PLAN_EXTRA (todo_write/delegate_task/submit_result).
    expect(workModeVisible("read_file", "PLAN")).toBe(true)
    expect(workModeVisible("todo_write", "PLAN")).toBe(true)
    expect(workModeVisible("delegate_task", "PLAN")).toBe(true)
    expect(workModeVisible("submit_result", "PLAN")).toBe(true)
    expect(workModeVisible("write_file", "PLAN")).toBe(false)
    expect(workModeVisible("bash", "PLAN")).toBe(false)
  })
})

describe("DISCUSS × permission mode — hanya tool eksplorasi", () => {
  for (const pm of ["auto", "ask", "plan", "allow-all", "allowlist", "readonly"] as const) {
    test(`DISCUSS × ${pm}: hanya tool eksplorasi`, async () => {
      const { sessionTools } = await setupToolLayer(
        cfgEmpty,
        "full",
        pm,
        undefined,
        undefined,
        "DISCUSS",
      )
      const names = nameOf(sessionTools)
      // DISCUSS ceiling = read-only; apapun permission mode, tidak boleh bocor
      // tool tulis/eksekusi (INV-WM2 — kombinasi tetap tercekung).
      for (const w of WRITE_TOOLS) expect(names).not.toContain(w)
      for (const n of EXPLORE_TOOL_NAMES) expect(names).toContain(n)
      // Tidak ada tool di luar EXPLORE yang lolos DISCUSS.
      for (const n of names) expect(EXPLORE_TOOL_NAMES).toContain(n)
    })
  }
})

describe("PLAN × permission mode — tidak memperluas permission mode", () => {
  test("PLAN × auto: explore + tool perencanaan yang diizinkan", async () => {
    const { sessionTools } = await setupToolLayer(
      cfgEmpty,
      "full",
      "auto",
      undefined,
      undefined,
      "PLAN",
    )
    const names = nameOf(sessionTools)
    for (const n of EXPLORE_TOOL_NAMES) expect(names).toContain(n)
    for (const extra of ["todo_write", "delegate_task", "submit_result"]) {
      expect(names).toContain(extra)
    }
    // Tool tulis & eksekusi tetap tak terlihat di bawah PLAN.
    for (const w of ["write_file", "bash", "code_run", "write_memory", "git_commit"]) {
      expect(names).not.toContain(w)
    }
    // Invarian: tak ada tool di luar explore+PLAN_EXTRA.
    const allowed = new Set([...EXPLORE_TOOL_NAMES, "todo_write", "delegate_task", "submit_result"])
    for (const n of names) expect(allowed.has(n)).toBe(true)
  })

  test("PLAN × readonly: TIDAK memperluas visibilitas readonly (irisan)", async () => {
    const { sessionTools } = await setupToolLayer(
      cfgEmpty,
      "full",
      "readonly",
      undefined,
      undefined,
      "PLAN",
    )
    const names = nameOf(sessionTools)
    // readonly saja = explore only; WorkMode PLAN tidak boleh membuka
    // todo_write/delegate_task/submit_result (INV-WM1).
    for (const n of names) expect(EXPLORE_TOOL_NAMES).toContain(n)
    for (const extra of ["todo_write", "delegate_task", "submit_result"]) {
      expect(names).not.toContain(extra)
    }
  })

  test("PLAN × plan: identik dengan plan permission mode (semua diizinkan)", async () => {
    const { sessionTools } = await setupToolLayer(
      cfgEmpty,
      "full",
      "plan",
      undefined,
      undefined,
      "PLAN",
    )
    const names = nameOf(sessionTools)
    const allowed = new Set([...EXPLORE_TOOL_NAMES, "todo_write", "delegate_task", "submit_result"])
    for (const n of names) expect(allowed.has(n)).toBe(true)
    for (const n of allowed) expect(names).toContain(n)
  })
})

describe("EXECUTE × permission mode — perilaku lama dipertahankan", () => {
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
  test("EXECUTE × readonly: explore only (perilaku lama permission mode)", async () => {
    const { sessionTools } = await setupToolLayer(
      cfgEmpty,
      "full",
      "readonly",
      undefined,
      undefined,
      "EXECUTE",
    )
    const names = nameOf(sessionTools)
    for (const n of names) expect(EXPLORE_TOOL_NAMES).toContain(n)
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w)
  })
  test("EXECUTE × plan: explore + PLAN_EXTRA (perilaku lama)", async () => {
    const { sessionTools } = await setupToolLayer(
      cfgEmpty,
      "full",
      "plan",
      undefined,
      undefined,
      "EXECUTE",
    )
    const names = nameOf(sessionTools)
    for (const n of EXPLORE_TOOL_NAMES) expect(names).toContain(n)
    for (const extra of ["todo_write", "delegate_task", "submit_result"]) {
      expect(names).toContain(extra)
    }
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
    for (const n of discussedNames) expect(EXPLORE_TOOL_NAMES).toContain(n)
    const plannedNames = nameOf(applyWorkModeFilter(mix, "PLAN"))
    expect(plannedNames).not.toContain("github.list_repos")
    expect(plannedNames).not.toContain("fs.read")
  })
})
