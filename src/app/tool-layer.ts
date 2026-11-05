import type { Tool } from "#minicore"
import type { MinicodeConfig } from "../config.ts"
import { configureServers as lspConfigure } from "../lsp/client.ts"
import { connectAll as mcpConnectAll } from "../mcp/client.ts"
import {
  EXPLORE_TOOL_NAMES,
  LOCAL_READONLY_TOOL_NAMES,
  READONLY_TOOL_NAMES,
} from "../policy/tool-contract.ts"
import { isMcpToolName } from "../presentation/label.ts"
import type { CanonicalScope } from "../session/verification.ts"
import { createBashJobTools } from "../tools/bash.ts"
import { withEvidence } from "../tools/evidence.ts"
import { allTools, withMcpTools } from "../tools/index.ts"

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export type ToolScope = "full" | "explore"

const PLAN_EXTRA = new Set(["todo_write", "delegate_task", "submit_result"])
const LOCAL_READONLY_SET: ReadonlySet<string> = new Set(LOCAL_READONLY_TOOL_NAMES)

// WorkMode ceiling (P12 S2.2 + P0.2) — lapisan intent di ATAS permission mode.
// Invariant INV-WM1 & #7: WorkMode TIDAK PERNAH memperluas akses; `visible`
// diselaraskan penuh dengan `callable` di handler:
// - DISCUSS: tepat 16 tool PURE_READ lokal (`LOCAL_READONLY_TOOL_NAMES`);
//   `web_fetch` & `web_search` ditolak dan disembunyikan.
// - PLAN: 18 `READONLY_TOOL_NAMES` (16 lokal + 2 network read ber-approval) +
//   `PLAN_EXTRA` (kecuali bila `permissionMode` adalah `readonly`/`allowlist`
//   yang ceiling-nya `readonly`).
// - EXECUTE: tanpa ceiling WorkMode tambahan; mengikuti `permissionMode`.
export function workModeVisible(
  name: string,
  workMode: "DISCUSS" | "PLAN" | "EXECUTE",
  permissionMode?: string,
): boolean {
  if (isMcpToolName(name)) {
    return workMode === "EXECUTE" && permissionMode !== "readonly" && permissionMode !== "plan"
  }
  if (workMode === "DISCUSS") return LOCAL_READONLY_SET.has(name)
  if (workMode === "PLAN") {
    if (permissionMode === "readonly" || permissionMode === "allowlist") {
      return READONLY_TOOL_NAMES.has(name)
    }
    return READONLY_TOOL_NAMES.has(name) || PLAN_EXTRA.has(name)
  }
  // EXECUTE = tanpa ceiling WorkMode tambahan; hormati filter PermissionMode.
  if (permissionMode === "readonly") return READONLY_TOOL_NAMES.has(name)
  if (permissionMode === "plan") return READONLY_TOOL_NAMES.has(name) || PLAN_EXTRA.has(name)
  return true
}

export function applyWorkModeFilter<T extends Tool>(
  tools: readonly T[],
  workMode: "DISCUSS" | "PLAN" | "EXECUTE",
  permissionMode?: string,
): T[] {
  return tools.filter((t) => workModeVisible(t.name, workMode, permissionMode))
}

export type ToolEvidenceMode = "events" | "canonical"

export async function setupToolLayer(
  cfg: MinicodeConfig,
  scope: ToolScope = "full",
  permissionMode?: string,
  verification?: CanonicalScope,
  jobOwnerSid?: string,
  workMode: "DISCUSS" | "PLAN" | "EXECUTE" = "EXECUTE",
  cwd?: string,
): Promise<{
  sessionTools: Tool[]
  evidenceMode: ToolEvidenceMode
  /** P12 S2.2 Slice 5 - set WorkMode runtime (visibilitas tool). */
  setWorkMode?: (m: "DISCUSS" | "PLAN" | "EXECUTE") => void
  /** P0.2 - set PermissionMode runtime agar visibilitas tetap sinkron saat /mode atau Shift+Tab. */
  setPermissionMode?: (pm: string) => void
}> {
  let sessionTools: Tool[] = allTools
  // Harness-P2: scope explore = subset read-only sub-agen (tetap 12 EXPLORE_TOOL_NAMES).
  if (scope === "explore")
    sessionTools = allTools.filter((t) => EXPLORE_TOOL_NAMES.includes(t.name))
  // F-03 (P5 §C2): background bash job diikat ke sid kanonik sesi ini.
  // Rebind dilakukan pada kandidat penuh sebelum filter mode supaya transisi
  // runtime DISCUSS/PLAN/readonly → EXECUTE tetap mendapat bash terikat sid.
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
    if (cfg.mcpServers?.length && scope !== "explore") {
      // P2.3: bawa cwd agar pin skema tersimpan per-workspace.
      const mcpTools = await mcpConnectAll(cfg.mcpServers, cwd)
      if (mcpTools.length) {
        sessionTools = withMcpTools(sessionTools, mcpTools)
      }
    }
  } catch (e) {
    process.stderr.write(`[mcp] init failed: ${errMsg(e)}\n`)
  }
  try {
    if (cfg.lspServers?.length) lspConfigure(cfg.lspServers)
  } catch (e) {
    process.stderr.write(`[lsp] init failed: ${errMsg(e)}\n`)
  }
  if (verification) {
    // P2.10 canonical coverage: one awaited intent/receipt pair per covered
    // registry invocation. Special paths keep their explicit instrumentation.
    sessionTools = sessionTools.map((tool) => withEvidence(tool, verification))
  }
  // P12 S2.2 + P0.2 - visibilitas tool runtime (sinkron terhadap WorkMode DAN
  // PermissionMode). `parallelExecutor` meresolusi `registry.get(name)` dari
  // `list()` yang sama sehingga `callable === visible` di kedua arah transisi.
  const candidates = sessionTools
  let currentWm: "DISCUSS" | "PLAN" | "EXECUTE" = workMode
  let currentPm: string | undefined = permissionMode
  const computeVisible = (wm: "DISCUSS" | "PLAN" | "EXECUTE", pm?: string): Tool[] => {
    if (scope === "explore") {
      // Scope explore sudah dibatasi ke EXPLORE_TOOL_NAMES; tetap terapkan irisan WorkMode.
      return applyWorkModeFilter(candidates, wm, pm)
    }
    return applyWorkModeFilter(candidates, wm, pm)
  }
  // Array LIVE: identitas objek ini yang dipegang kernel.
  const visible: Tool[] = computeVisible(currentWm, currentPm)
  const syncVisible = (): void => {
    const next = computeVisible(currentWm, currentPm)
    visible.length = 0
    visible.push(...next)
  }
  const setWorkMode = (wm: "DISCUSS" | "PLAN" | "EXECUTE"): void => {
    currentWm = wm
    syncVisible()
  }
  const setPermissionMode = (pm: string): void => {
    currentPm = pm
    syncVisible()
  }
  return {
    sessionTools: visible,
    evidenceMode: verification ? "canonical" : "events",
    setWorkMode,
    setPermissionMode,
  }
}
