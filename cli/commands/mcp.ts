import { resolve as resolvePath } from "node:path"
import { configureMcpSchemaPins, mcpSchemaPinRegistry } from "../../src/mcp/client.ts"

const MCP_HELP = `minicode mcp — run minicode as an MCP server / inspect schema pins

  minicode mcp serve [--allow-all] [--all-tools] [--cwd <dir>]
  minicode mcp pins [--json] [--cwd <dir>]
  minicode mcp approve <server>.<tool> <new-hash> [--cwd <dir>]
  minicode mcp capabilities [--json]

  --allow-all   allow all tools without permission gating
  --all-tools   expose all tools, not only safe ones
  --cwd <dir>   workspace root (pins are stored per workspace)

  Schema pins live in <cwd>/.minicode/mcp-schema-pins.json. A drift is
  fail-closed; approve explicitly with the current hash from the drift message.

  MCP servers USED by minicode are configured via:
    minicode config mcp <add|list|remove>`

// Satu situs writer per stream (writer-inventory max: 2).
const out = (line = ""): void => console.log(line)
const err = (line: string): void => console.error(line)

export async function handleMcp(
  args: string[],
  getArg: (name: string) => string | undefined,
  _help: string,
): Promise<never> {
  const sub = args[1]
  const cwdArg = getArg("--cwd")
  if (sub === "serve") {
    const { serveMcp } = await import("../../src/mcp/server.ts")
    await serveMcp({
      allowAll: args.includes("--allow-all"),
      allTools: args.includes("--all-tools"),
      root: cwdArg ? resolvePath(cwdArg) : undefined,
    })
    process.exit(0)
  }
  if (sub === "pins") {
    const cwd = cwdArg ? resolvePath(cwdArg) : undefined
    configureMcpSchemaPins(cwd)
    const pins = mcpSchemaPinRegistry.list()
    if (getArg("--json") !== undefined || args.includes("--json")) {
      out(JSON.stringify({ pins }))
    } else if (pins.length === 0) {
      out("no MCP schema pins recorded for this workspace")
    } else {
      for (const p of pins) out(`${p.serverId}.${p.toolName}  ${p.hash}`)
    }
    process.exit(0)
  }
  if (sub === "capabilities") {
    // Jujur: kami menyatakan apa yang BENAR-BENAR didukung client. Server-
    // initiated notifications belum disurfacekan transport, jadi subscriptions
    // TIDAK diklaim aktif.
    const caps = {
      tools: true,
      resources: true,
      prompts: true,
      pagination: true,
      reconnect: { supported: true, maxAttempts: 3, backoff: "exponential+jitter" },
      subscriptions: false,
      notifications: false,
      note: "server-initiated notifications/resources-updated are not surfaced by this transport",
    }
    out(
      getArg("--json") !== undefined || args.includes("--json")
        ? JSON.stringify(caps)
        : JSON.stringify(caps, null, 2),
    )
    process.exit(0)
  }
  if (sub === "approve") {
    const target = args[2]
    const hash = args[3] ?? getArg("--hash")
    if (!target?.includes(".") || !hash || !/^[0-9a-f]{64}$/i.test(hash)) {
      err("usage: minicode mcp approve <server>.<tool> <64-hex-sha256> [--cwd <dir>]")
      process.exit(2)
    }
    const i = target.indexOf(".")
    const serverId = target.slice(0, i)
    const toolName = target.slice(i + 1)
    const cwd = cwdArg ? resolvePath(cwdArg) : undefined
    configureMcpSchemaPins(cwd)
    mcpSchemaPinRegistry.approveMcpSchemaUpdate(serverId, toolName, hash.toLowerCase())
    out(`approved ${serverId}.${toolName} -> ${hash.toLowerCase()}`)
    process.exit(0)
  }
  // Help kontekstual, bukan HELP global 45 baris. Subcommand asing = salah
  // pakai (exit 2), bukan gagal runtime (exit 1).
  const asking = sub === undefined || sub === "--help" || sub === "-h"
  if (!asking) err(`unknown mcp subcommand: ${sub}\n`)
  out(MCP_HELP)
  process.exit(asking ? 0 : 2)
}
