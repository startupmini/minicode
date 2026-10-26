import type { Tool } from "#minicore"
import type { MinicodeConfig } from "../config.ts"
import { configureServers as lspConfigure } from "../lsp/client.ts"
import { connectAll as mcpConnectAll } from "../mcp/client.ts"
import { isMcpToolName } from "../presentation/label.ts"
import type { CanonicalScope } from "../session/verification.ts"
import { createBashJobTools } from "../tools/bash.ts"
import { withEvidence } from "../tools/evidence.ts"
import { allTools, withMcpTools } from "../tools/index.ts"
import { EXPLORE_TOOL_NAMES } from "../tools/task.ts"

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export type ToolScope = "full" | "explore"

const PLAN_EXTRA = new Set(["todo_write", "delegate_task", "submit_result"])

// WorkMode ceiling (P12 S2.2) — lapisan intent di ATAS permission mode.
// Invariant INV-WM1: WorkMode TIDAK PERNAH memperluas akses; ia hanya
// mempersempit. Karena itu filter di bawah digabung sebagai IRISAN dengan
// filter permission mode: nama tool harus lolos KEDUANYA. Kombinasi
// workMode=PLAN × permissionMode=readonly → irisan tetap explore (tidak
// memperluas visibilitas readonly), sesuai matriks REV-2 sel PLAN×readonly.
//
// Murni + diekspor untuk test (pola repo: pure/diekspor-untuk-test). Tes MCP
// visibility memanggilnya dengan tool bertitik tanpa men-spawn server MCP.
export function workModeVisible(name: string, workMode: "DISCUSS" | "PLAN" | "EXECUTE"): boolean {
  if (workMode === "DISCUSS") return EXPLORE_TOOL_NAMES.includes(name)
  if (workMode === "PLAN") return EXPLORE_TOOL_NAMES.includes(name) || PLAN_EXTRA.has(name)
  // EXECUTE = tanpa ceiling tambahan (perilaku lama).
  return true
}

export function applyWorkModeFilter<T extends Tool>(
  tools: readonly T[],
  workMode: "DISCUSS" | "PLAN" | "EXECUTE",
): T[] {
  return tools.filter((t) => workModeVisible(t.name, workMode))
}

export type ToolEvidenceMode = "events" | "canonical"

export async function setupToolLayer(
  cfg: MinicodeConfig,
  scope: ToolScope = "full",
  permissionMode?: string,
  verification?: CanonicalScope,
  jobOwnerSid?: string,
  workMode: "DISCUSS" | "PLAN" | "EXECUTE" = "EXECUTE",
): Promise<{
  sessionTools: Tool[]
  evidenceMode: ToolEvidenceMode
  /** P12 S2.2 Slice 5 - set WorkMode runtime (visibilitas tool). */
  setWorkMode?: (m: "DISCUSS" | "PLAN" | "EXECUTE") => void
}> {
  let sessionTools: Tool[] = allTools
  // Harness-P2: scope explore = subset read-only (sama seperti sub-agen).
  // MCP runtime ikut terpotong (nama bertitik tak ada di daftar) — least privilege.
  if (scope === "explore")
    sessionTools = allTools.filter((t) => EXPLORE_TOOL_NAMES.includes(t.name))
  // Paket perbaikan (1): plan/readonly sembunyikan tool tulis dari daftar agar
  // model tak buang langkah mencoba yang pasti ditolak. Daftar fixed per sesi
  // (ikuti docs/HARNESS.md batasan sadar).
  if (permissionMode === "readonly") {
    sessionTools = sessionTools.filter((t) => EXPLORE_TOOL_NAMES.includes(t.name))
  } else if (permissionMode === "plan") {
    sessionTools = sessionTools.filter(
      (t) => EXPLORE_TOOL_NAMES.includes(t.name) || PLAN_EXTRA.has(t.name),
    )
  }
  // F-03 (P5 §C2): background bash job diikat ke sid kanonik sesi ini.
  // Rebind instance SEBELUM withEvidence agar pembungkus evidence membungkus
  // instance yang sudah terikat sid (bukan sebaliknya). Hanya jika nama ada di
  // daftar — filter explore/plan di atas tetap berlaku (least privilege).
  if (jobOwnerSid) {
    const owned = createBashJobTools(jobOwnerSid)
    const rebind = new Map<string, Tool>([
      ["bash", owned.bash],
      ["bash_output", owned.bashOutput],
      ["bash_kill", owned.bashKill],
    ])
    sessionTools = sessionTools.map((t) => rebind.get(t.name) ?? t)
  }
  try {
    if (cfg.mcpServers?.length) {
      const mcpTools = await mcpConnectAll(cfg.mcpServers)
      if (mcpTools.length) {
        // Plan/readonly: filter MCP juga, bukan balik ke allTools (bug lama).
        sessionTools = withMcpTools(sessionTools, mcpTools)
      }
    }
  } catch (e) {
    process.stderr.write(`[mcp] init failed: ${errMsg(e)}\n`)
  }
  try {
    if (cfg.lspServers?.length) lspConfigure(cfg.lspServers)
  } catch (e) {
    // Label "[lsp]" — BUKAN "[mcp]": mengarang label yang salah membuat
    // operator mengira MCP yang rusak, padahal yang gagal adalah registrasi
    // server LSP.
    process.stderr.write(`[lsp] init failed: ${errMsg(e)}\n`)
  }
  if (verification) {
    // P2.10 canonical coverage: one awaited intent/receipt pair per covered
    // registry invocation. Special paths keep their explicit instrumentation.
    sessionTools = sessionTools.map((tool) => withEvidence(tool, verification))
  }
  // P12 S2.2 Slice 5 - visibilitas tool runtime.
  //
  // Kenapa mutasi IN-PLACE: kernel menyimpan registry dari array yang sama
  // (`createToolRegistry(config.tools)` menyimpan referensi; `list()` mengembalikannya
  // apa adanya) dan `loop.ts` memetakan `registry.list()` per request. Jadi
  // mengganti isi array yang dipegang kernel mengubah daftar tool yang dilihat
  // model pada turn BERIKUTNYA tanpa perlu ganti handler/session.
  //
  // Batas jujur: `registry.get(name)` tetap memakai map yang dibuat saat
  // konstruksi, jadi tool yang disembunyikan masih bisa dipanggil model bila
  // ia menebak namanya. Yang MENOLAK tetap permission ceiling handler
  // (WorkMode non-EXECUTE) - visibilitas hanya lapisan UX/least-privilege,
  // bukan gerbang keamanan.
  const preWorkMode = sessionTools
  const mcpBlockedByPermission = permissionMode === "plan" || permissionMode === "readonly"
  const computeVisible = (wm: "DISCUSS" | "PLAN" | "EXECUTE"): Tool[] => {
    let list = preWorkMode
    // Tool MCP runtime ber-nama bertitik ditolak pada plan/readonly (kontrak
    // lama) dan pada WorkMode non-EXECUTE (ceiling tak memuat tool MCP).
    if (mcpBlockedByPermission || wm !== "EXECUTE") {
      list = list.filter((t) => !isMcpToolName(t.name) || EXPLORE_TOOL_NAMES.includes(t.name))
    }
    return applyWorkModeFilter(list, wm)
  }
  // Array LIVE: identitas objek ini yang dipegang kernel.
  const visible: Tool[] = computeVisible(workMode)
  const setWorkMode = (wm: "DISCUSS" | "PLAN" | "EXECUTE"): void => {
    const next = computeVisible(wm)
    visible.length = 0
    visible.push(...next)
  }
  return {
    sessionTools: visible,
    evidenceMode: verification ? "canonical" : "events",
    setWorkMode,
  }
}
