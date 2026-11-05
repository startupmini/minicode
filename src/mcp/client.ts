import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { Tool, ToolContext } from "#minicore"
import { LIMITS } from "../constants.ts"
import { scrubSecrets } from "../policy/scrub.ts"
import { McpHttpTransport, type McpTransportLike } from "./http-transport.ts"
import { McpTransport } from "./transport.ts"

// [Fase 8 / 8.2] MCP Schema Fingerprint Pinning.
//
// Bahaya yang ditutup: server MCP bisa mengubah skema toolnya SETELAH pin
// (mis. mengganti `inputSchema` menjadi looser, atau mengubah deskripsi agar
// model melakukan sesuatu yang berbeda), tanpa sepengetahuan pengguna. Tanpa
// pin, setiap refresh `tools/list` menerima skema baru secara diam-diam dan
// `mcp_call` tetap berjalan — ini adalah jalur supply-chain drift yang diam.
//
// Kontrak:
// - `computeMcpToolSchemaHash(tool)` = SHA-256 atas JSON kanonik
//   `{ name, description, inputSchema }` (kunci diurutkan → deterministik).
// - `McpSchemaPinRegistry` menyimpan pin per `serverId:toolName`.
//   ▸ `pin()`   — pin hash saat tool pertama kali didaftarkan/discover.
//   ▸ `verify()` — cek hash skema saat ini vs pin; drift → `MCP_SCHEMA_DRIFT_DETECTED`.
//   ▸ `approveMcpSchemaUpdate(serverId, toolName)` — izinkan skema baru
//     (hash baru menggantikan pin), eksplisit dari sisi pengguna.
// - `wrapTools()` memanggil `verify()` saat men-generate wrapper (setiap
//   `connectAll`/refresh) sehingga drift terdeteksi SEBELUM pemanggilan.
// - `callMcpTool()` juga memverifikasi ulang saat pemanggilan (fail-closed).

export function computeMcpToolSchemaHash(tool: {
  name: string
  description?: string
  inputSchema?: unknown
}): string {
  const canonical = JSON.stringify(
    {
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? {},
    },
    // Kunci diurutkan → deterministik lintas JS object insertion order.
    (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value) ? sortObjectKeys(value) : value,
  )
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

function sortObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]!
  return out
}

/** P2.3: sleep yang dapat dibatalkan oleh signal sesi/koneksi. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * P2.3: klasifikasi recoverable. Auth/schema/protocol TIDAK boleh diulang tanpa
 * batas; kegagalan transport/process boleh. Abort bukan recoverable (berhenti).
 */
function isRecoverableMcpError(e: Error): boolean {
  const m = `${e.name} ${e.message}`.toLowerCase()
  if (/abort/.test(m)) return false
  if (/schema_drift|mcp_schema_drift/.test(m)) return false
  if (/401|403|unauthor|forbidden|invalid.?token|auth/.test(m)) return false
  if (/protocol|invalid json|invalid params|method not found/.test(m)) return false
  return /exited|econnrefused|econnreset|epipe|closed|transport|fetch failed|network|socket|timeout/.test(
    m,
  )
}

export class McpSchemaPinRegistry {
  private readonly pins = new Map<string, string>()
  /**
   * P2.3: pin HARUS bertahan lintas restart. Tanpa persistensi, proses baru
   * mem-pin ulang skema yang sudah berubah dan drift diterima diam-diam.
   * Path null = mode in-memory (unit test / embedding tanpa workspace).
   */
  private path: string | null = null
  private loaded = false

  /** Arahkan registry ke file pin workspace dan muat isinya sekali. */
  configure(path: string): void {
    if (this.path === path && this.loaded) return
    this.path = path
    this.loaded = false
    this.load()
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!this.path || !existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) this.pins.set(key, value)
      }
    } catch {
      // File rusak = fail-closed: jangan menebak pin dari data parsial.
    }
  }

  private persist(): void {
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      const sorted = [...this.pins.entries()].sort(([a], [b]) => a.localeCompare(b))
      writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`, "utf8")
      renameSync(tmp, this.path)
    } catch {
      // Gagal menulis pin tidak boleh menjatuhkan koneksi; verify tetap
      // memakai pin in-memory untuk proses ini.
    }
  }

  list(): { serverId: string; toolName: string; hash: string }[] {
    this.load()
    return [...this.pins.entries()]
      .map(([key, hash]) => {
        const i = key.indexOf(":")
        return { serverId: key.slice(0, i), toolName: key.slice(i + 1), hash }
      })
      .sort((a, b) => `${a.serverId}.${a.toolName}`.localeCompare(`${b.serverId}.${b.toolName}`))
  }

  /** Pin hash skema. Overwrite bila sudah ada? Tidak — pin pertama adalah
   *  otoritas; refresh berikutnya harus lewat `approve`. */
  pin(serverId: string, toolName: string, hash: string): void {
    this.load()
    const key = `${serverId}:${toolName}`
    if (!this.pins.has(key)) {
      this.pins.set(key, hash)
      this.persist()
    }
  }

  /** Approve eksplisit: ganti pin dengan hash baru (persetujuan pengguna). */
  approveMcpSchemaUpdate(serverId: string, toolName: string, newHash: string): void {
    this.load()
    this.pins.set(`${serverId}:${toolName}`, newHash)
    this.persist()
  }

  /** Verify: hash sama dengan pin → ok; belum ada pin → pin sekarang; beda → drift. */
  verify(serverId: string, toolName: string, hash: string): "ok" | "pinned" | "drift" {
    this.load()
    const key = `${serverId}:${toolName}`
    const pinned = this.pins.get(key)
    if (pinned === undefined) {
      this.pins.set(key, hash)
      this.persist()
      return "pinned"
    }
    return pinned === hash ? "ok" : "drift"
  }

  getPin(serverId: string, toolName: string): string | undefined {
    this.load()
    return this.pins.get(`${serverId}:${toolName}`)
  }

  /** Reset seluruh pin (uji hermetik); file hanya ditulis bila path terpasang. */
  reset(): void {
    this.pins.clear()
    this.loaded = true
    this.persist()
  }
}

export const mcpSchemaPinRegistry = new McpSchemaPinRegistry()

/** Path pin per-workspace; sengaja lokal agar proyek berbeda tak saling percaya. */
export function mcpSchemaPinPath(cwd?: string): string {
  return resolve(cwd ?? process.cwd(), ".minicode", "mcp-schema-pins.json")
}

/** Muat/arahkan pin ke workspace sebelum connect; idempoten. */
export function configureMcpSchemaPins(cwd?: string): void {
  mcpSchemaPinRegistry.configure(mcpSchemaPinPath(cwd))
}

export function mcpSchemaDriftError(
  serverId: string,
  toolName: string,
  pinned?: string,
  current?: string,
): Error {
  const detail =
    pinned && current
      ? ` pinned=${pinned.slice(0, 12)} current=${current.slice(0, 12)} — run: minicode mcp approve ${serverId}.${toolName} ${current}`
      : ` — run: minicode mcp approve ${serverId}.${toolName} <current-hash>`
  const e = new Error(
    `MCP_SCHEMA_DRIFT_DETECTED: tool "${serverId}.${toolName}" schema changed since pin${detail}`,
  ) as Error & { code: string; serverId: string; toolName: string }
  e.code = "MCP_SCHEMA_DRIFT_DETECTED"
  e.serverId = serverId
  e.toolName = toolName
  return e
}

// MODEL KEPERCAYAAN MCP (baca sebelum mengubah file ini):
//
// Permission Minicode HANYA mengontrol pemanggilan (invocation): tool apa di
// server mana dengan argumen apa, satu approval per panggilan (di auto/ask;
// ditolak di readonly/plan/allowlist; bebas di allow-all).
//
// Server TIDAK dianggap trusted wrapper: capability di balik server
// (filesystem, network, process, state, API eksternal, kredensial) TIDAK
// dapat diketahui statis dan TIDAK diklasifikasikan — anggap setiap
// `tools/call` sebagai UNCLASSIFIED EXTERNAL CAPABILITY dengan efek arbitrer.
// Satu-satunya batas sisi-Minicode: validasi server-id, scrubSecrets +
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
/**
 * P2.3: reference count per server. `closeAll()` dipanggil oleh setiap sesi;
 * tanpa refcount, menutup sesi A mematikan MCP sesi B. Server ditutup hanya
 * saat ref mencapai 0 (atau force saat teardown uji).
 */
const connectionRefs = new Map<string, number>()

class McpConnection {
  /** Transport konkret; tipe union agar `connect` yang berbeda tetap tersalur. */
  private http: McpHttpTransport | null = null
  private stdio: McpTransport | null = null
  transport: McpTransportLike
  tools: McpToolDef[] = []
  resources: McpResourceDef[] = []
  prompts: McpPromptDef[] = []
  ready = false
  /** P2.3: reconnect single-flight + ownership. */
  private reconnectInFlight: Promise<void> | null = null
  private closedByOwner = false

  constructor(public config: McpServerConfig) {
    // Transport dipilih dari bentuk config: `url` → HTTP, else stdio.
    this.transport = this.buildTransport()
  }

  private buildTransport(): McpTransportLike {
    if (this.config.url) {
      this.http = new McpHttpTransport({
        url: this.config.url,
        headers: this.config.headers,
        allowPrivateHost: this.config.allowPrivateHost,
      })
      this.stdio = null
      return this.http
    }
    this.stdio = new McpTransport()
    this.http = null
    return this.stdio
  }

  get kind(): "http" | "stdio" {
    return this.config.url ? "http" : "stdio"
  }

  /** P2.3: siap dipakai = transport hidup DAN discovery selesai. */
  isAlive(): boolean {
    return !this.closedByOwner && this.ready && !this.transport.isClosed
  }

  /**
   * Reconnect bounded: hanya untuk kegagalan transport yang recoverable.
   * Single-flight (satu loop per koneksi), abortable, backoff eksponensial +
   * jitter. Setelah connect, discovery dijalankan ulang; pin skema diverifikasi
   * ulang oleh wrapper sebelum tool benar-benar dipanggil (fail-closed).
   */
  async reconnect(signal?: AbortSignal, maxAttempts = 3): Promise<void> {
    if (this.closedByOwner) throw new Error(`MCP server ${this.config.id} is closed`)
    if (this.reconnectInFlight) return this.reconnectInFlight
    const run = (async () => {
      let lastError: Error | null = null
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        signal?.throwIfAborted()
        if (attempt > 0) {
          const backoff = Math.min(2_000, 250 * 2 ** (attempt - 1))
          const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(backoff / 4)))
          await abortableSleep(backoff + jitter, signal)
        }
        try {
          await this.transport.close().catch(() => {})
          this.ready = false
          this.transport = this.buildTransport()
          await this.connect()
          return
        } catch (e) {
          lastError = e as Error
          if (!isRecoverableMcpError(lastError)) throw lastError
        }
      }
      throw new Error(
        `MCP reconnect failed for ${this.config.id} after ${maxAttempts} attempts: ${lastError?.message ?? "unknown"}`,
      )
    })()
    this.reconnectInFlight = run
    try {
      await run
    } finally {
      this.reconnectInFlight = null
    }
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

    // P2.3: hormati `nextCursor`. Mengabaikannya membuat server >1 halaman
    // tampil sebagai daftar parsial yang disangka lengkap.
    this.tools = await this.listAll<McpToolDef>("tools/list", "tools")

    // Resources & prompts bersifat OPSIONAL di spec: banyak server tidak
    // mengimplementasikannya dan membalas "method not found". Kegagalan di sini
    // tidak boleh membatalkan koneksi yang tool-nya sudah berhasil dimuat.
    this.resources = await this.listSafely<McpResourceDef>("resources/list", "resources")
    this.prompts = await this.listSafely<McpPromptDef>("prompts/list", "prompts")

    this.ready = true
  }

  /** Baca seluruh halaman `method`; batas 100 halaman mencegah loop server jahat. */
  private async listAll<T>(method: string, key: string): Promise<T[]> {
    const out: T[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const res = (await this.transport.request(
        method,
        cursor ? { cursor } : {},
        LIMITS.MCP_HANDSHAKE_TIMEOUT_MS,
      )) as Record<string, unknown> | undefined
      const arr = res?.[key]
      if (Array.isArray(arr)) out.push(...(arr as T[]))
      const next = res?.nextCursor
      if (typeof next !== "string" || next.length === 0) return out
      cursor = next
    }
    throw new Error(`MCP_PAGINATION_LIMIT: ${method} exceeded 100 pages`)
  }

  private async listSafely<T>(method: string, key: string): Promise<T[]> {
    try {
      return await this.listAll<T>(method, key)
    } catch (e) {
      // "method not found" adalah normal untuk resources/prompts. Batas
      // pagination BUKAN normal: operator harus tahu daftar tidak lengkap.
      if ((e as Error).message.includes("MCP_PAGINATION_LIMIT")) {
        process.stderr.write(
          `[mcp] ${method}: ${(e as Error).message}; list treated as unsupported\n`,
        )
      }
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
    return this.tools
      .map((t): Tool | null => {
        // F8.2: pin/verify skema pada setiap discovery. `verify` mem-pin bila
        // pertama kali, dan menolak SELURUH tool server bila ada drift — server
        // yang mengubah skema tanpa persetujuan dianggap tidak tepercaya hingga
        // `approveMcpSchemaUpdate` eksplisit.
        const hash = computeMcpToolSchemaHash(t)
        const v = mcpSchemaPinRegistry.verify(serverId, t.name, hash)
        if (v === "drift") {
          // Fail-closed: tool drift TIDAK diekspos. Sebelumnya tool tetap masuk
          // daftar (baru ditolak saat execute) — model melihat tool yang pasti
          // gagal. Approve eksplisit lewat CLI `mcp approve`.
          process.stderr.write(
            `[mcp] ${serverId}.${t.name} schema drift detected — tool disabled; ${mcpSchemaDriftError(serverId, t.name, mcpSchemaPinRegistry.getPin(serverId, t.name), hash).message}\n`,
          )
          return null
        }
        return {
          name: `${serverId}.${t.name}`,
          description: t.description ?? `MCP tool from ${serverId}`,
          parameters: (t.inputSchema ?? {
            type: "object",
            properties: {},
            additionalProperties: true,
          }) as Tool["parameters"],
          async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
            // P2.3: pastikan koneksi hidup; reconnect bounded bila transport
            // mati. Discovery dijalankan ulang, jadi verifikasi memakai definisi
            // tool SAAT INI (bukan `t` hasil discovery lama).
            const conn = await ensureConnection(serverId, _ctx.signal)
            const current = conn.tools.find((x) => x.name === t.name)
            if (!current) throw new Error(`MCP tool ${serverId}.${t.name} missing after reconnect`)
            const hashAtCall = computeMcpToolSchemaHash(current)
            const vAtCall = mcpSchemaPinRegistry.verify(serverId, t.name, hashAtCall)
            if (vAtCall === "drift")
              throw mcpSchemaDriftError(
                serverId,
                t.name,
                mcpSchemaPinRegistry.getPin(serverId, t.name),
                hashAtCall,
              )
            _ctx.signal.throwIfAborted()
            const result = await conn.callTool(t.name, input ?? {}, _ctx.signal)
            const content = extractMcpText(result)
            return capMcpText(content)
          },
        }
      })
      .filter((t): t is Tool => t !== null)
  }

  async close(): Promise<void> {
    this.closedByOwner = true
    this.ready = false
    await this.transport.close()
  }
}

/**
 * P2.3: ambil koneksi yang SIAP. Bila transport mati, satu reconnect bounded
 * (single-flight) dijalankan; kegagalan non-recoverable dilempar apa adanya.
 */
async function ensureConnection(serverId: string, signal?: AbortSignal): Promise<McpConnection> {
  const conn = activeConnections.get(serverId)
  if (!conn) throw new Error(`MCP server ${serverId} not connected`)
  if (conn.isAlive()) return conn
  await conn.reconnect(signal)
  return conn
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

export async function connectAll(configs: McpServerConfig[], cwd?: string): Promise<Tool[]> {
  // Pin persisten per workspace: server yang skemanya berubah setelah restart
  // harus terdeteksi, bukan dipin ulang diam-diam.
  configureMcpSchemaPins(cwd)
  // Paralel: server independen — sequential membuat startup membayar jumlah
  // timeout handshake (3s/server). Urutan pesan stderr dipertahankan sesuai
  // config agar log deterministik.
  const settled = await Promise.allSettled(
    configs.map(async (cfg) => {
      const existing = activeConnections.get(cfg.id)
      // P2.3: hanya reuse koneksi yang benar-benar SIAP; koneksi mati diganti
      // agar `connected` tidak pernah berarti "socket ada tapi discovery gagal".
      if (existing?.isAlive()) return { cfg, conn: existing, reused: true }
      if (existing) {
        activeConnections.delete(cfg.id)
        connectionRefs.delete(cfg.id)
        await existing.close().catch(() => {})
      }
      const conn = new McpConnection(cfg)
      await conn.connect()
      return { cfg, conn, reused: false }
    }),
  )
  const allTools: Tool[] = []

  for (const s of settled) {
    if (s.status === "rejected") {
      const cfg = configs[settled.indexOf(s)]!
      process.stderr.write(`[mcp] ${cfg.id} failed: ${(s.reason as Error)?.message ?? s.reason}\n`)
      continue
    }
    const { cfg, conn, reused } = s.value
    // P2.3: sesi kedua HARUS mendapat tool dari koneksi yang sudah aktif,
    // bukan daftar kosong. Refcount mencegah closeAll lintas-sesi.
    const tools = conn.wrapTools(cfg.id)
    allTools.push(...tools)
    if (!reused) activeConnections.set(cfg.id, conn)
    connectionRefs.set(cfg.id, (connectionRefs.get(cfg.id) ?? 0) + 1)
    const extra = [
      conn.resources.length ? `${conn.resources.length} resources` : "",
      conn.prompts.length ? `${conn.prompts.length} prompts` : "",
    ]
      .filter(Boolean)
      .join(", ")
    process.stderr.write(
      reused
        ? `[mcp] ${cfg.id} reused existing connection (${tools.length} tools${extra ? `, ${extra}` : ""})\n`
        : `[mcp] ${cfg.id} connected via ${conn.kind} (${tools.length} tools${extra ? `, ${extra}` : ""})\n`,
    )
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
  // F8.2: verify skema ulang saat pemanggilan. Tool yang skemanya berubah
  // tanpa persetujuan ditolak fail-closed sebelum request dikirim ke server.
  const tool = conn.tools.find((t) => t.name === toolName)
  if (tool) {
    const hash = computeMcpToolSchemaHash(tool)
    const v = mcpSchemaPinRegistry.verify(serverId, toolName, hash)
    if (v === "drift") throw mcpSchemaDriftError(serverId, toolName)
  }
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

export async function closeAll(opts: { force?: boolean } = {}): Promise<void> {
  for (const [id, conn] of [...activeConnections]) {
    if (!opts.force) {
      const refs = (connectionRefs.get(id) ?? 1) - 1
      if (refs > 0) {
        connectionRefs.set(id, refs)
        continue
      }
    }
    connectionRefs.delete(id)
    activeConnections.delete(id)
    try {
      await conn.close()
    } catch {}
  }
}

export function getMcpServerIds(): string[] {
  return [...activeConnections.keys()]
}

/** P2.3: status hidup koneksi (dipakai operator/observability + test). */
export function mcpConnectionAlive(serverId: string): boolean {
  return activeConnections.get(serverId)?.isAlive() ?? false
}

/**
 * P2.3 seam: matikan transport TANPA menandai koneksi "closed by owner",
 * mensimulasikan server mati/putus. Koneksi tetap terdaftar sehingga pemanggilan
 * berikutnya menempuh jalur reconnect (bukan membuat koneksi kedua).
 */
export async function simulateMcpTransportFailure(serverId: string): Promise<void> {
  const conn = activeConnections.get(serverId)
  if (!conn) return
  await conn.transport.close().catch(() => {})
}
