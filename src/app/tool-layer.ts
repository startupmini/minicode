import type { Tool } from "#minicore"
import type { MinicodeConfig } from "../config.ts"
import { configureServers as lspConfigure } from "../lsp/client.ts"
import { connectAll as mcpConnectAll } from "../mcp/client.ts"
import { isMcpToolName } from "../presentation/label.ts"
import type { CanonicalScope } from "../session/verification.ts"
import { withEvidence } from "../tools/evidence.ts"
import { allTools, withMcpTools } from "../tools/index.ts"
import { EXPLORE_TOOL_NAMES } from "../tools/task.ts"

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export type ToolScope = "full" | "explore"

const PLAN_EXTRA = new Set(["todo_write", "delegate_task", "submit_result"])

export type ToolEvidenceMode = "events" | "canonical"

export async function setupToolLayer(
  cfg: MinicodeConfig,
  scope: ToolScope = "full",
  permissionMode?: string,
  verification?: CanonicalScope,
): Promise<{ sessionTools: Tool[]; evidenceMode: ToolEvidenceMode }> {
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
  try {
    if (cfg.mcpServers?.length) {
      const mcpTools = await mcpConnectAll(cfg.mcpServers)
      if (mcpTools.length) {
        // Plan/readonly: filter MCP juga, bukan balik ke allTools (bug lama).
        sessionTools = withMcpTools(sessionTools, mcpTools)
        if (permissionMode === "plan" || permissionMode === "readonly") {
          sessionTools = sessionTools.filter(
            (t) => !isMcpToolName(t.name) || EXPLORE_TOOL_NAMES.includes(t.name),
          )
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[mcp] init failed: ${errMsg(e)}\n`)
  }
  try {
    if (cfg.lspServers?.length) lspConfigure(cfg.lspServers)
  } catch (e) {
    process.stderr.write(`[mcp] init failed: ${errMsg(e)}\n`)
  }
  if (verification) {
    // P2.10 canonical coverage: one awaited intent/receipt pair per covered
    // registry invocation. Special paths keep their explicit instrumentation.
    sessionTools = sessionTools.map((tool) => withEvidence(tool, verification))
  }
  return { sessionTools, evidenceMode: verification ? "canonical" : "events" }
}
