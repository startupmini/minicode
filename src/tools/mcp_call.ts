import type { Tool } from "#minicore"
import {
  callMcpTool,
  capMcpText,
  extractMcpText,
  getMcpPrompt,
  getMcpServerIds,
  mcpInventory,
  readMcpResource,
} from "../mcp/client.ts"
import { fenceUntrustedToolOutput, isAlreadyFenced, scrubSecrets } from "../policy/scrub.ts"

export const mcpListTool: Tool = {
  name: "mcp_list",
  description:
    "List connected MCP servers with their tools, resources, and prompts. Call this first, before mcp_call / mcp_read / mcp_prompt.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute(_input, ctx) {
    ctx.signal.throwIfAborted()
    const inv = mcpInventory()
    if (inv.length === 0) return "(no MCP servers connected — add one via minicode config mcp add)"
    const lines: string[] = []
    for (const s of inv) {
      lines.push(
        `# ${s.id} (${s.kind}) — ${s.tools.length} tools, ${s.resources.length} resources, ${s.prompts.length} prompts`,
      )
      for (const t of s.tools)
        lines.push(`  tool     ${t.name}${t.description ? `: ${t.description.slice(0, 110)}` : ""}`)
      for (const r of s.resources)
        lines.push(
          `  resource ${r.uri}${r.name ? ` (${r.name})` : ""}${r.mimeType ? ` [${r.mimeType}]` : ""}`,
        )
      for (const p of s.prompts) {
        const args = (p.arguments ?? []).map((a) => `${a.name}${a.required ? "*" : ""}`).join(", ")
        lines.push(
          `  prompt   ${p.name}${args ? `(${args})` : ""}${p.description ? `: ${p.description.slice(0, 90)}` : ""}`,
        )
      }
    }
    return lines.join("\n")
  },
}

export const mcpCallTool: Tool = {
  name: "mcp_call",
  description:
    "Call a tool on a connected MCP server. Parameters: server id, tool name, and arguments. " +
    "The server runs OUTSIDE minicode policy: a call may read/write files, network, or processes " +
    "on the server side — one approval covers one server+tool+args call only.",
  parameters: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "ID MCP server (lihat dari mcp_list)",
      },
      tool: {
        type: "string",
        description: "Name of the tool to call",
      },
      args: {
        type: "object",
        description: "Arguments for the tool (key-value object)",
        additionalProperties: true,
      },
    },
    required: ["server", "tool"],
    additionalProperties: false,
  },
  async execute({ server, tool, args }, ctx) {
    const sid = server as string
    const tn = tool as string
    const a = (args as Record<string, unknown>) ?? {}

    ctx.signal.throwIfAborted()

    const ids = getMcpServerIds()
    if (!ids.includes(sid)) {
      return `[mcp] server '${sid}' is not connected. Registered servers: ${ids.join(", ") || "(none)"}`
    }

    try {
      const result = await callMcpTool(sid, tn, a, ctx.signal)
      const content = extractMcpText(result)
      const capped = capMcpText(content)
      return isAlreadyFenced(capped)
        ? capped
        : fenceUntrustedToolOutput(`mcp_call:${sid}.${tn}`, capped)
    } catch (e) {
      return `[mcp] error: ${scrubSecrets((e as Error).message)}`
    }
  },
}

/** Pesan kesalahan seragam untuk server yang tak terdaftar. */
function notConnected(sid: string): string {
  const ids = getMcpServerIds()
  return `[mcp] server '${sid}' is not connected. Registered servers: ${ids.join(", ") || "(none)"}`
}

export const mcpReadTool: Tool = {
  name: "mcp_read",
  description:
    "Baca resource dari MCP server (spec resources/read). URI diambil dari mcp_list. Read-only.",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "ID MCP server" },
      uri: { type: "string", description: "Resource URI, e.g. file:///x or db://table" },
    },
    required: ["server", "uri"],
    additionalProperties: false,
  },
  async execute({ server, uri }, ctx) {
    ctx.signal.throwIfAborted()
    const sid = String(server ?? "")
    const u = String(uri ?? "").trim()
    if (!u) throw new Error("uri is required")
    if (!getMcpServerIds().includes(sid)) return notConnected(sid)
    try {
      const text = await readMcpResource(sid, u, ctx.signal)
      if (!text) return `[mcp] resource '${u}' is empty or returned no text`
      const capped = capMcpText(text)
      return isAlreadyFenced(capped) ? capped : fenceUntrustedToolOutput(`mcp_read:${sid}`, capped)
    } catch (e) {
      return `[mcp] error: ${scrubSecrets((e as Error).message)}`
    }
  },
}

export const mcpPromptTool: Tool = {
  name: "mcp_prompt",
  description:
    "Fetch a prompt template from an MCP server (spec prompts/get) — the server renders its arguments. The result is text to use as context.",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "ID MCP server" },
      name: { type: "string", description: "Nama prompt (lihat mcp_list)" },
      args: {
        type: "object",
        description: "Argumen prompt (object key-value)",
        additionalProperties: true,
      },
    },
    required: ["server", "name"],
    additionalProperties: false,
  },
  async execute({ server, name, args }, ctx) {
    ctx.signal.throwIfAborted()
    const sid = String(server ?? "")
    const pn = String(name ?? "").trim()
    if (!pn) throw new Error("name is required")
    if (!getMcpServerIds().includes(sid)) return notConnected(sid)
    try {
      const text = await getMcpPrompt(sid, pn, (args as Record<string, unknown>) ?? {}, ctx.signal)
      if (!text) return `[mcp] prompt '${pn}' returned no message`
      const capped = capMcpText(text)
      return isAlreadyFenced(capped)
        ? capped
        : fenceUntrustedToolOutput(`mcp_prompt:${sid}`, capped)
    } catch (e) {
      return `[mcp] error: ${scrubSecrets((e as Error).message)}`
    }
  },
}
