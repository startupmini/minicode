// P2.10 canonical tool wrapper: await intent → inner execute → await receipt.
//
// This wrapper lives at the tool layer so every covered registry execution
// passes through one canonical evidence path. Special paths keep their own
// single intent/terminal pair: delegate_task writes explicitly, dotted MCP
// tools stay on the existing path, and MCP server mode has awaited wiring.

import type { Tool, ToolContext } from "#minicore"
import { isCanonicalEvidenceCovered } from "../session/journal.ts"
import { type CanonicalScope, executeCanonicalInvocation } from "../session/verification.ts"

const UNWRAPPED = Symbol.for("minicode.p210.unwrapped-tool")

type MaybeWrappedTool = Tool & { [UNWRAPPED]?: Tool }

/** Wrap one covered registry tool without changing its name, schema, or result. */
export function withEvidence(tool: Tool, scope: CanonicalScope): Tool {
  if (!isCanonicalEvidenceCovered(tool.name)) return tool
  const inner = (tool as MaybeWrappedTool)[UNWRAPPED] ?? tool
  const wrapped: Tool = {
    ...inner,
    async execute(input: unknown, ctx: ToolContext): Promise<unknown> {
      // Awaited intent precedes inner execute; awaited receipt follows return.
      // No inner execution begins before durable invocation identity exists.
      return executeCanonicalInvocation(inner, input, ctx, scope)
    },
  }
  ;(wrapped as MaybeWrappedTool)[UNWRAPPED] = inner
  return wrapped
}
