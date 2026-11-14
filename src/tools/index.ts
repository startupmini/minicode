export { askUserTool } from "./ask_user.ts"
export { bashKillTool, bashOutputTool, bashTool } from "./bash.ts"
export { codeRunTool } from "./code_run.ts"
export { deleteFileTool } from "./delete_file.ts"
export { editTool } from "./edit.ts"
export { gitCommitTool, gitDiffTool, gitLogTool, gitPushTool, gitStatusTool } from "./git.ts"
export { globTool } from "./glob.ts"
export { grepTool } from "./grep.ts"
export {
  lspDefinitionTool,
  lspDiagnosticsTool,
  lspHoverTool,
  lspReferencesTool,
  lspSymbolsTool,
  lspWorkspaceSymbolsTool,
} from "./lsp.ts"
export { mcpCallTool, mcpListTool, mcpPromptTool, mcpReadTool } from "./mcp_call.ts"
export { forgetMemoryTool, readMemoryTool, writeMemoryTool } from "./memory.ts"
export { moveFileTool } from "./move_file.ts"
export { applyPatchTool } from "./patch.ts"
export { readFileTool } from "./read_file.ts"
export { readImageTool } from "./read_image.ts"
export { submitResultTool } from "./submit_result.ts"
export { delegateTaskTool } from "./task.ts"
export { todoReadTool, todoSession, todoWriteTool } from "./todo.ts"
export { webFetchTool } from "./web_fetch.ts"
export { writeFileTool } from "./write_file.ts"

import type { Tool } from "#minicore"
import { askUserTool } from "./ask_user.ts"
import { bashKillTool, bashOutputTool, bashTool } from "./bash.ts"
import { codeRunTool } from "./code_run.ts"
import { deleteFileTool } from "./delete_file.ts"
import { editTool } from "./edit.ts"
import { gitCommitTool, gitDiffTool, gitLogTool, gitPushTool, gitStatusTool } from "./git.ts"
import { globTool } from "./glob.ts"
import { grepTool } from "./grep.ts"
import {
  lspDefinitionTool,
  lspDiagnosticsTool,
  lspHoverTool,
  lspReferencesTool,
  lspSymbolsTool,
  lspWorkspaceSymbolsTool,
} from "./lsp.ts"
import { mcpCallTool, mcpListTool, mcpPromptTool, mcpReadTool } from "./mcp_call.ts"
import { forgetMemoryTool, readMemoryTool, writeMemoryTool } from "./memory.ts"
import { moveFileTool } from "./move_file.ts"
import { applyPatchTool } from "./patch.ts"
import { readFileTool } from "./read_file.ts"
import { readImageTool } from "./read_image.ts"
import { submitResultTool } from "./submit_result.ts"
import { delegateTaskTool } from "./task.ts"
import { todoReadTool, todoWriteTool } from "./todo.ts"
import { webFetchTool } from "./web_fetch.ts"
import { webSearchTool } from "./web_search.ts"
import { writeFileTool } from "./write_file.ts"

export const allTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editTool,
  applyPatchTool,
  globTool,
  grepTool,
  bashTool,
  bashOutputTool,
  bashKillTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  gitPushTool,
  webFetchTool,
  webSearchTool,
  readMemoryTool,
  writeMemoryTool,
  forgetMemoryTool,
  todoWriteTool,
  todoReadTool,
  delegateTaskTool,
  mcpListTool,
  mcpCallTool,
  mcpReadTool,
  mcpPromptTool,
  lspDiagnosticsTool,
  lspDefinitionTool,
  lspReferencesTool,
  lspHoverTool,
  lspSymbolsTool,
  lspWorkspaceSymbolsTool,
  moveFileTool,
  deleteFileTool,
  readImageTool,
  codeRunTool,
  submitResultTool,
  askUserTool,
]

// MCP server tools (prefixed "serverid.toolname") di-append runtime via connectAll()
export function withMcpTools(base: Tool[], mcpTools: Tool[]): Tool[] {
  const seen = new Set(base.map((t) => t.name))
  return [...base, ...mcpTools.filter((t) => !seen.has(t.name))]
}
