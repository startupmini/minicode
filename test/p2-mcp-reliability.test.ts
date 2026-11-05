// P2.3 — MCP reliability: persistent schema pins, pagination, and multi-session
// connection ownership. Hermetic: real local HTTP MCP server, temp workspace.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  closeAll,
  computeMcpToolSchemaHash,
  connectAll,
  getMcpServerIds,
  McpSchemaPinRegistry,
  mcpConnectionAlive,
  mcpInventory,
  mcpSchemaPinRegistry,
  simulateMcpTransportFailure,
} from "../src/mcp/client.ts"

setDefaultTimeout(30_000)

let server: ReturnType<typeof Bun.serve> | null = null
const dirs: string[] = []

type RpcHandler = (method: string, params: Record<string, unknown>) => unknown

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p2-mcp-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  dirs.push(dir)
  return dir
}

function serveMcp(handler: RpcHandler): string {
  server?.stop(true)
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "DELETE") return new Response("", { status: 204 })
      const body = (await req.json()) as {
        id?: number
        method: string
        params?: Record<string, unknown>
      }
      if (body.id === undefined) return new Response("", { status: 202 })
      let result: unknown
      try {
        result = handler(body.method, body.params ?? {})
      } catch (e) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: (e as Error).message },
          }),
          { headers: { "content-type": "application/json" } },
        )
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      })
    },
  })
  return `http://127.0.0.1:${server.port}/mcp`
}

function tool(
  name: string,
  description = "ping",
): { name: string; description?: string; inputSchema?: unknown } {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  }
}

afterEach(async () => {
  await closeAll({ force: true })
  server?.stop(true)
  server = null
  mcpSchemaPinRegistry.reset()
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    } catch {}
  }
})

describe("P2.3 MCP schema pins", () => {
  test("pin bertahan lintas instance; drift terdeteksi; approve memindahkan pin", () => {
    const dir = workspace()
    const path = join(dir, ".minicode", "mcp-schema-pins.json")
    const a = "a".repeat(64)
    const b = "b".repeat(64)

    const first = new McpSchemaPinRegistry()
    first.configure(path)
    expect(first.verify("s", "ping", a)).toBe("pinned")
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "s:ping": a })

    const second = new McpSchemaPinRegistry()
    second.configure(path)
    expect(second.verify("s", "ping", b)).toBe("drift")
    second.approveMcpSchemaUpdate("s", "ping", b)

    const third = new McpSchemaPinRegistry()
    third.configure(path)
    expect(third.verify("s", "ping", b)).toBe("ok")
  })

  test("drift setelah pin lama menyembunyikan tool (fail-closed), bukan expose", async () => {
    const dir = workspace()
    const old = tool("ping", "old description")
    const newTool = tool("ping", "new description")
    const oldHash = computeMcpToolSchemaHash(old)
    writeFileSync(
      join(dir, ".minicode", "mcp-schema-pins.json"),
      JSON.stringify({ "s:ping": oldHash }),
      "utf8",
    )
    const url = serveMcp((method) => {
      if (method === "initialize")
        return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
      if (method === "tools/list") return { tools: [newTool] }
      return {}
    })
    const tools = await connectAll([{ id: "s", url, allowPrivateHost: true }], dir)
    expect(tools).toHaveLength(0)
    expect(mcpInventory()[0]?.tools).toHaveLength(1)
  })
})

describe("P2.3 MCP pagination & multi-session", () => {
  test("tools/list mengikuti nextCursor sampai halaman terakhir", async () => {
    const dir = workspace()
    const url = serveMcp((method, params) => {
      if (method === "initialize")
        return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
      if (method === "tools/list") {
        return params.cursor === "p2"
          ? { tools: [tool("second")] }
          : { tools: [tool("first")], nextCursor: "p2" }
      }
      return {}
    })
    const tools = await connectAll([{ id: "s", url, allowPrivateHost: true }], dir)
    expect(tools.map((t) => t.name).sort()).toEqual(["s.first", "s.second"])
  })

  test("reconnect bounded: transport mati dihidupkan ulang; pemanggilan berhasil", async () => {
    const dir = workspace()
    let calls = 0
    const url = serveMcp((method) => {
      if (method === "initialize")
        return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
      if (method === "tools/list") return { tools: [tool("ping")] }
      if (method === "tools/call") {
        calls++
        return { content: [{ type: "text", text: "pong" }] }
      }
      return {}
    })
    const cfg = { id: "s", url, allowPrivateHost: true }
    const tools = await connectAll([cfg], dir)
    expect(mcpConnectionAlive("s")).toBe(true)

    await simulateMcpTransportFailure("s")
    expect(mcpConnectionAlive("s")).toBe(false)

    const out = await tools[0]!.execute({ q: "x" }, {
      signal: new AbortController().signal,
    } as never)
    expect(out).toContain("pong")
    expect(calls).toBe(1)
    expect(mcpConnectionAlive("s")).toBe(true)
  })

  test("drift setelah reconnect tetap fail-closed (tidak lolos ke tool baru)", async () => {
    const dir = workspace()
    let description = "ping v1"
    const url = serveMcp((method) => {
      if (method === "initialize")
        return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
      if (method === "tools/list") return { tools: [tool("ping", description)] }
      return { content: [{ type: "text", text: "pong" }] }
    })
    const tools = await connectAll([{ id: "s", url, allowPrivateHost: true }], dir)
    await simulateMcpTransportFailure("s")
    description = "ping v2 (changed)"
    await expect(
      tools[0]!.execute({ q: "x" }, { signal: new AbortController().signal } as never),
    ).rejects.toThrow(/MCP_SCHEMA_DRIFT_DETECTED/)
  })

  test("server mati permanen: reconnect berhenti setelah batas, bukan loop tanpa akhir", async () => {
    const dir = workspace()
    const url = serveMcp((method) => {
      if (method === "initialize")
        return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
      if (method === "tools/list") return { tools: [tool("ping")] }
      return {}
    })
    const tools = await connectAll([{ id: "s", url, allowPrivateHost: true }], dir)
    await simulateMcpTransportFailure("s")
    server?.stop(true)
    server = null
    await expect(
      tools[0]!.execute({ q: "x" }, { signal: new AbortController().signal } as never),
    ).rejects.toThrow(/reconnect failed/i)
  })

  test("sesi kedua mendapat tool; closeAll tidak mematikan server sesi lain", async () => {
    const dir = workspace()
    const url = serveMcp((method) => {
      if (method === "initialize")
        return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
      if (method === "tools/list") return { tools: [tool("ping")] }
      return {}
    })
    const cfg = { id: "s", url, allowPrivateHost: true }
    const first = await connectAll([cfg], dir)
    const second = await connectAll([cfg], dir)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)

    await closeAll()
    expect(getMcpServerIds()).toContain("s")
    await closeAll()
    expect(getMcpServerIds()).not.toContain("s")
  })
})
