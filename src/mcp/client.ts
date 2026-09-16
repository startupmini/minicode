import type { Tool, ToolContext } from "#minicore"
import { LIMITS } from "../constants.ts"
import { scrubSecrets } from "../policy/scrub.ts"
import { McpHttpTransport, type McpTransportLike } from "./http-transport.ts"
import { McpTransport } from "./transport.ts"

// MODEL KEPERCAYAAN MCP (baca sebelum mengubah file ini):
//
// Permission MiniCode HANYA mengontrol pemanggilan (invocation): tool apa di
// server mana dengan argumen apa, satu approval per panggilan (di auto/ask;
// ditolak di readonly/plan/allowlist; bebas di allow-all).
//
// Server TIDAK dianggap trusted wrapper: capability di balik server
// (filesystem, network, process, state, API eksternal, kredensial) TIDAK
// dapat diketahui statis dan TIDAK diklasifikasikan — anggap setiap
// `tools/call` sebagai UNCLASSIFIED EXTERNAL CAPABILITY dengan efek arbitrer.
// Satu-satunya batas sisi-MiniCode: validasi server-id, scrubSecrets +
// cap 100k pada hasil, dan SSRF guard untuk transport HTTP.
// Pembatalan parent menghentikan penungguan (dan request HTTP), tetapi TIDAK
// membunuh proses stdio server maupun membatalkan efek yang sudah terjadi.

export interface McpServerConfig {
  id: string
  /** stdio: perintah yang di-spawn. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Streamable HTTP endpoint. Bila ada, dipakai alih-alih stdio. */
  url?: string
  headers?: Record<string, string>
  allowPrivateHost?: boolean
}

interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** Resource yang di-expose server (spec: `resources/list`). */
export interface McpResourceDef {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

/** Prompt template yang di-expose server (spec: `prompts/list`). */
export interface McpPromptDef {
  name: string
  description?: string
  arguments?: { name: string; description?: string; required?: boolean }[]
}

const activeConnections = new Map<string, McpConnection>()

class McpConnection {
  /** Transport konkret; tipe union agar `connect` yang berbeda tetap tersalur. */
  private readonly http: McpHttpTransport | null
  private readonly stdio: McpTransport | null
  transport: McpTransportLike
  tools: McpToolDef[] = []
  resources: McpResourceDef[] = []
  prompts: McpPromptDef[] = []
  ready = false

  constructor(public config: McpServerConfig) {
    // Transport dipilih dari bentuk config: `url` → HTTP, else stdio.
    if (config.url) {
      this.http = new McpHttpTransport({
        url: config.url,
        headers: config.headers,
        allowPrivateHost: config.allowPrivateHost,
      })
      this.stdio = null
      this.transport = this.http
    } else {
      this.stdio = new McpTransport()
      this.http = null
      this.transport = this.stdio
    }
  }

  get kind(): "http" | "stdio" {
    return this.http ? "http" : "stdio"
  }

  async connect(): Promise<void> {
    if (this.http) {
      await this.http.connect()
    } else {
      if (!this.config.command) throw new Error("MCP config needs `command` or `url`")
      await this.stdio!.connect(this.config.command, this.config.args ?? [], this.config.env ?? {})
    }

    let handshakeOk = false
    // `server/discover` adalah ekstensi non-standar; hanya masuk akal untuk
    // stdio lokal. Server HTTP mengikuti spec → langsung `initialize`.
    if (this.kind === "stdio") {
      try {
        const disc = (await this.transport.request(
          "server/discover",
          {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "minicode", version: "0.1.0" },
              "io.modelcontextprotocol/clientCapabilities": { tools: {} },
            },
          },
          2_000,
        )) as Record<string, unknown>
        if (disc?.capabilities) handshakeOk = true
      } catch {
        // jatuh ke initialize di bawah
      }
    }
    if (!handshakeOk) {
      await this.transport.request(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          // Deklarasikan seluruh kapabilitas yang kita KONSUMSI. Server memakai
          // ini untuk memutuskan apa yang layak diiklankan; sebelumnya kita
          // hanya menyebut `tools` sehingga server yang sopan tidak menawarkan
          // resources/prompts sama sekali.
          capabilities: { tools: {}, resources: {}, prompts: {} },
          clientInfo: { name: "minicode", version: "0.1.0" },
        },
        LIMITS.MCP_HANDSHAKE_TIMEOUT_MS,
      )
      // wajib per spec: notification initialized setelah initialize
      this.transport.notify("notifications/initialized", {})
      handshakeOk = true
    }
    if (!handshakeOk) throw new Error("handshake failed")

    const result = (await this.transport.request("tools/list", {})) as Record<string, unknown>
    if (result && Array.isArray(result.tools)) this.tools = result.tools as McpToolDef[]

    // Resources & prompts bersifat OPSIONAL di spec: banyak server tidak
    // mengimplementasikannya dan membalas "method not found". Kegagalan di sini
    // tidak boleh membatalkan koneksi yang tool-nya sudah berhasil dimuat.
    this.resources = await this.listSafely<McpResourceDef>("resources/list", "resources")
    this.prompts = await this.listSafely<McpPromptDef>("prompts/list", "prompts")

    this.ready = true
  }

  private async listSafely<T>(method: string, key: string): Promise<T[]> {
    try {
      const res = (await this.transport.request(method, {}, LIMITS.MCP_HANDSHAKE_TIMEOUT_MS)) as
        | Record<string, unknown>
        | undefined
      const arr = res?.[key]
      return Array.isArray(arr) ? (arr as T[]) : []
    } catch {
      return []
    }
  }

  /** Baca satu resource. Return teks gabungan dari semua `contents`. */
  async readResource(uri: string, signal?: AbortSignal): Promise<string> {
    const res = (await this.transport.request("resources/read", { uri }, undefined, signal)) as
      | { contents?: unknown[] }
      | undefined
    const contents = Array.isArray(res?.contents) ? res.contents : []
    if (contents.length === 0) return ""
    const parts: string[] = []
    for (const c of contents) {
      const item = c as { text?: unknown; blob?: unknown; uri?: unknown; mimeType?: unknown }
      if (typeof item.text === "string") {
        parts.push(item.text)
      } else if (typeof item.blob === "string") {
        // Blob base64: jangan tumpahkan ribuan karakter base64 ke konteks model.
        parts.push(
          `[binary ${String(item.mimeType ?? "application/octet-stream")}, ${item.blob.length} base64 chars — skipped]`,
        )
      }
    }
    return parts.join("\n")
  }

  /** Ambil prompt template yang sudah di-render server. */
  async getPrompt(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const res = (await this.transport.request(
      "prompts/get",
      {
        name,
        arguments: args,
      },
      undefined,
      signal,
    )) as { messages?: unknown[]; description?: string } | undefined
    const msgs = Array.isArray(res?.messages) ? res.messages : []
    const lines: string[] = []
    if (res?.description) lines.push(`# ${res.description}`)
    for (const m of msgs) {
      const msg = m as { role?: unknown; content?: unknown }
      const role = typeof msg.role === "string" ? msg.role : "user"
      // content bisa objek tunggal {type,text} atau array blok
      const blocks = Array.isArray(msg.content) ? msg.content : [msg.content]
      const text = blocks
        .map((b) => {
          const blk = b as { type?: unknown; text?: unknown }
          if (typeof blk?.text === "string") return blk.text
          if (typeof b === "string") return b
          return ""
        })
        .filter(Boolean)
        .join("\n")
      if (text) lines.push(`[${role}] ${text}`)
    }
    return lines.join("\n")
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const result = (await this.transport.request(
      "tools/call",
      {
        name,
        arguments: args,
      },
      undefined,
      signal,
    )) as Record<string, unknown>
    if (result && typeof result.isError === "boolean" && result.isError) {
      const content = Array.isArray(result.content)
        ? result.content.map((c: any) => c.text ?? JSON.stringify(c)).join("\n")
        : String(result.content)
      throw new Error(`MCP tool ${name}: ${content}`)
    }
    return result
  }

  wrapTools(serverId: string): Tool[] {
    return this.tools.map((t) => ({
      name: `${serverId}.${t.name}`,
      description: t.description ?? `MCP tool from ${serverId}`,
      parameters: (t.inputSchema ?? {
        type: "object",
        properties: {},
        additionalProperties: true,
      }) as Tool["parameters"],
      async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
        const conn = activeConnections.get(serverId)
        if (!conn) throw new Error(`MCP server ${serverId} not connected`)
        _ctx.signal.throwIfAborted()
        const result = await conn.callTool(t.name, input ?? {}, _ctx.signal)
        const content = extractMcpText(result)
        return capMcpText(content)
      },
    }))
  }

  async close(): Promise<void> {
    await this.transport.close()
  }
}

/** Normalisasi konten tool MCP (string | blok {text} campuran) → teks. */
export function extractMcpText(result: unknown): string {
  if (result == null) return ""
  const r = result as { content?: unknown }
  if (!Array.isArray(r.content)) return String(result)
  return r.content
    .map((c) => {
      if (typeof c === "string") return c
      if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
        return (c as { text: string }).text
      }
      return JSON.stringify(c)
    })
    .join("\n")
}

/**
 * Cap + penanda truncation MCP (temuan audit #02: slice 100k diam-diam
 * tampak utuh). Scrub dulu agar pola rahasia di dekat batas tak lolos.
 */
export function capMcpText(content: string): string {
  const clean = scrubSecrets(content)
  const cap = LIMITS.MCP_OUTPUT_MAX_CHARS
  return clean.length > cap
    ? `${clean.slice(0, cap)}\n… [mcp truncated: showing first ${cap} chars]`
    : clean
}

export async function connectAll(configs: McpServerConfig[]): Promise<Tool[]> {
  // Paralel: server independen — sequential membuat startup membayar jumlah
  // timeout handshake (3s/server). Urutan pesan stderr dipertahankan sesuai
  // config agar log deterministik.
  const settled = await Promise.allSettled(
    configs.map(async (cfg) => {
      if (activeConnections.has(cfg.id)) return { cfg, conn: null as McpConnection | null }
      const conn = new McpConnection(cfg)
      await conn.connect()
      return { cfg, conn }
    }),
  )
  const allTools: Tool[] = []

  for (const s of settled) {
    if (s.status === "rejected") {
      const cfg = configs[settled.indexOf(s)]!
      process.stderr.write(`[mcp] ${cfg.id} failed: ${(s.reason as Error)?.message ?? s.reason}\n`)
      continue
    }
    const { cfg, conn } = s.value
    if (!conn) {
      process.stderr.write(`[mcp] ${cfg.id} already connected\n`)
      continue
    }
    {
      const tools = conn.wrapTools(cfg.id)
      allTools.push(...tools)
      activeConnections.set(cfg.id, conn)
      const extra = [
        conn.resources.length ? `${conn.resources.length} resources` : "",
        conn.prompts.length ? `${conn.prompts.length} prompts` : "",
      ]
        .filter(Boolean)
        .join(", ")
      process.stderr.write(
        `[mcp] ${cfg.id} connected via ${conn.kind} (${tools.length} tools${extra ? `, ${extra}` : ""})\n`,
      )
    }
  }

  return allTools
}

export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const conn = activeConnections.get(serverId)
  if (!conn) throw new Error(`MCP server ${serverId} not connected`)
  return conn.callTool(toolName, args, signal)
}

export async function readMcpResource(
  serverId: string,
  uri: string,
  signal?: AbortSignal,
): Promise<string> {
  const conn = activeConnections.get(serverId)
  if (!conn) throw new Error(`MCP server ${serverId} not connected`)
  return conn.readResource(uri, signal)
}

export async function getMcpPrompt(
  serverId: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const conn = activeConnections.get(serverId)
  if (!conn) throw new Error(`MCP server ${serverId} not connected`)
  return conn.getPrompt(name, args, signal)
}

/** Ringkasan seluruh kapabilitas server terhubung (dipakai `mcp_list`). */
export function mcpInventory(): {
  id: string
  kind: "http" | "stdio"
  tools: McpToolDef[]
  resources: McpResourceDef[]
  prompts: McpPromptDef[]
}[] {
  return [...activeConnections.entries()].map(([id, c]) => ({
    id,
    kind: c.kind,
    tools: c.tools,
    resources: c.resources,
    prompts: c.prompts,
  }))
}

export async function closeAll(): Promise<void> {
  for (const [id, conn] of activeConnections) {
    try {
      await conn.close()
    } catch {}
    activeConnections.delete(id)
  }
}

export function getMcpServerIds(): string[] {
  return [...activeConnections.keys()]
}
