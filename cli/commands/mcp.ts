import { resolve as resolvePath } from "node:path"

const MCP_HELP = `minicode mcp — run minicode as an MCP server

  minicode mcp serve [--allow-all] [--all-tools] [--cwd <dir>]

  --allow-all   allow all tools without permission gating
  --all-tools   expose all tools, not only safe ones
  --cwd <dir>   workspace root to expose

  MCP servers USED by minicode are configured via:
    minicode config mcp <add|list|remove>`

export async function handleMcp(
  args: string[],
  getArg: (name: string) => string | undefined,
  _help: string,
): Promise<never> {
  const sub = args[1]
  if (sub === "serve") {
    const { serveMcp } = await import("../../src/mcp/server.ts")
    const cwdArg = getArg("--cwd")
    await serveMcp({
      allowAll: args.includes("--allow-all"),
      allTools: args.includes("--all-tools"),
      root: cwdArg ? resolvePath(cwdArg) : undefined,
    })
    process.exit(0)
  }
  // Help kontekstual, bukan HELP global 45 baris. Subcommand asing = salah
  // pakai (exit 2), bukan gagal runtime (exit 1).
  const asking = sub === undefined || sub === "--help" || sub === "-h"
  if (!asking) console.error(`unknown mcp subcommand: ${sub}\n`)
  console.log(MCP_HELP)
  process.exit(asking ? 0 : 2)
}
