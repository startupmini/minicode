// MCP resources & prompts — konsumsi dari sisi client (Fase 5).
//
// Server minicode sudah lama menyajikan resources/prompts, tapi CLIENT hanya
// memakai tools/list + tools/call. Test ini menguji sisi yang baru terhadap
// server HTTP nyata, termasuk perilaku server yang TIDAK mendukung keduanya
// (kasus mayoritas) — kegagalan opsional tak boleh membatalkan koneksi.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { closeAll, connectAll, mcpInventory } from "../src/mcp/client.ts"
import { createPermissionHandler } from "../src/policy/permission.ts"

setDefaultTimeout(30_000)

let server: ReturnType<typeof Bun.serve> | null = null

type RpcHandler = (method: string, params: Record<string, unknown>) => unknown

/** Server MCP HTTP minimal yang perilakunya ditentukan handler. */
function serveMcp(handler: RpcHandler): string {
  server?.stop(true)
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "DELETE") return new Response("", { status: 204 })
      const body = (await req.json()) as {
        id?: number
        method: string
        params?: Record<string, unknown>
      }
      // notifikasi (tanpa id) cukup di-ack
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

afterEach(async () => {
  await closeAll()
  server?.stop(true)
  server = null
})

/** Server lengkap: tools + resources + prompts. */
const fullServer: RpcHandler = (method, params) => {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {}, prompts: {} },
      }
    case "tools/list":
      return { tools: [{ name: "ping", description: "cek koneksi" }] }
    case "resources/list":
      return {
        resources: [
          { uri: "file:///readme", name: "Readme", mimeType: "text/markdown" },
          { uri: "db://users", name: "Users", description: "tabel user" },
        ],
      }
    case "resources/read": {
      const uri = String(params.uri ?? "")
      if (uri === "file:///readme") {
        return { contents: [{ uri, mimeType: "text/markdown", text: "# Judul\nisi readme" }] }
      }
      if (uri === "db://users") {
        // beberapa contents sekaligus
        return {
          contents: [
            { uri, text: "alice" },
            { uri, text: "bob" },
          ],
        }
      }
      if (uri === "bin://blob") {
        return { contents: [{ uri, mimeType: "image/png", blob: "QUJD".repeat(500) }] }
      }
      if (uri === "empty://x") return { contents: [] }
      throw new Error(`resource tidak ditemukan: ${uri}`)
    }
    case "prompts/list":
      return {
        prompts: [
          {
            name: "review",
            description: "Review perubahan",
            arguments: [
              { name: "diff", required: true },
              { name: "gaya", required: false },
            ],
          },
        ],
      }
    case "prompts/get": {
      const name = String(params.name ?? "")
      if (name !== "review") throw new Error(`prompt tidak ditemukan: ${name}`)
      const args = (params.arguments ?? {}) as Record<string, unknown>
      return {
        description: "Review perubahan",
        messages: [
          { role: "system", content: { type: "text", text: "Kamu reviewer teliti." } },
          { role: "user", content: [{ type: "text", text: `Review: ${args.diff ?? "(kosong)"}` }] },
        ],
      }
    }
    default:
      throw new Error(`Method not found: ${method}`)
  }
}

/** Server yang HANYA punya tools — resources/prompts melempar error. */
const toolsOnlyServer: RpcHandler = (method) => {
  if (method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
  if (method === "tools/list") return { tools: [{ name: "solo" }] }
  throw new Error(`Method not found: ${method}`)
}

describe("MCP client: discovery resources & prompts", () => {
  test("server lengkap → tools, resources, prompts terdaftar", async () => {
    const url = serveMcp(fullServer)
    const tools = await connectAll([{ id: "penuh", url, allowPrivateHost: true }])
    expect(tools.map((t) => t.name)).toEqual(["penuh.ping"])
    const inv = mcpInventory()
    expect(inv).toHaveLength(1)
    expect(inv[0]!.resources.map((r) => r.uri)).toEqual(["file:///readme", "db://users"])
    expect(inv[0]!.prompts.map((p) => p.name)).toEqual(["review"])
    expect(inv[0]!.kind).toBe("http")
  })

  test("server tanpa resources/prompts tetap terhubung (keduanya opsional)", async () => {
    // Ini kasus mayoritas di ekosistem: kegagalan method opsional tidak boleh
    // membatalkan koneksi yang tool-nya sudah berhasil dimuat.
    const url = serveMcp(toolsOnlyServer)
    const tools = await connectAll([{ id: "solo", url, allowPrivateHost: true }])
    expect(tools.map((t) => t.name)).toEqual(["solo.solo"])
    const inv = mcpInventory()
    expect(inv[0]!.resources).toEqual([])
    expect(inv[0]!.prompts).toEqual([])
  })

  test("initialize mendeklarasikan kapabilitas yang benar-benar dikonsumsi", async () => {
    let caps: unknown = null
    const url = serveMcp((method, params) => {
      if (method === "initialize") {
        caps = params.capabilities
        return { protocolVersion: "2025-06-18" }
      }
      if (method === "tools/list") return { tools: [] }
      throw new Error("Method not found")
    })
    await connectAll([{ id: "caps", url, allowPrivateHost: true }])
    // Sebelumnya hanya `tools` yang disebut, sehingga server yang sopan tak
    // menawarkan resources/prompts sama sekali.
    expect(caps).toMatchObject({ tools: {}, resources: {}, prompts: {} })
  })
})

describe("MCP client: mcp_read", () => {
  const ctx = { signal: new AbortController().signal, emit() {} } as never

  test("membaca resource teks", async () => {
    const url = serveMcp(fullServer)
    await connectAll([{ id: "s", url, allowPrivateHost: true }])
    const { mcpReadTool } = await import("../src/tools/mcp_call.ts")
    const out = (await mcpReadTool.execute({ server: "s", uri: "file:///readme" }, ctx)) as string
    expect(out).toContain("# Judul")
    expect(out).toContain("isi readme")
  })

  test("beberapa contents digabung", async () => {
    const url = serveMcp(fullServer)
    await connectAll([{ id: "s", url, allowPrivateHost: true }])
    const { mcpReadTool } = await import("../src/tools/mcp_call.ts")
    const out = (await mcpReadTool.execute({ server: "s", uri: "db://users" }, ctx)) as string
    expect(out).toBe("alice\nbob")
  })

  test("blob biner TIDAK ditumpahkan sebagai base64 ke konteks", async () => {
    // 2000 char base64 akan memakan konteks tanpa memberi informasi berguna.
    const url = serveMcp(fullServer)
    await connectAll([{ id: "s", url, allowPrivateHost: true }])
    const { mcpReadTool } = await import("../src/tools/mcp_call.ts")
    const out = (await mcpReadTool.execute({ server: "s", uri: "bin://blob" }, ctx)) as string
    expect(out).toContain("[binary image/png")
    expect(out).toContain("skipped")
    expect(out).not.toContain("QUJDQUJD")
    expect(out.length).toBeLessThan(200)
  })

  test("contents kosong memberi pesan, bukan string kosong", async () => {
    const url = serveMcp(fullServer)
    await connectAll([{ id: "s", url, allowPrivateHost: true }])
    const { mcpReadTool } = await import("../src/tools/mcp_call.ts")
    const out = (await mcpReadTool.execute({ server: "s", uri: "empty://x" }, ctx)) as string
    expect(out).toContain("is empty")
  })

  test("resource tak dikenal → pesan error server, bukan crash", async () => {
    const url = serveMcp(fullServer)
    await connectAll([{ id: "s", url, allowPrivateHost: true }])
    const { mcpReadTool } = await import("../src/tools/mcp_call.ts")
    const out = (await mcpReadTool.execute({ server: "s", uri: "x://nope" }, ctx)) as string
    expect(out).toContain("[mcp] error")
    expect(out).toContain("tidak ditemukan")
  })

  test("server tak terhubung → pesan yang menyebut server terdaftar", async () => {
    const { mcpReadTool } = await import("../src/tools/mcp_call.ts")
    const out = (await mcpReadTool.execute({ server: "hantu", uri: "x://y" }, ctx)) as string
    expect(out).toContain("is not connected")
  })

  test("uri kosong ditolak", async () => {
    const { mcpReadTool } = await import("../src/tools/mcp_call.ts")
    await expect(mcpReadTool.execute({ server: "s", uri: "  " }, ctx)).rejects.toThrow(
      /uri is required/,
    )
  })
})

describe("MCP client: mcp_prompt", () => {
  const ctx = { signal: new AbortController().signal, emit() {} } as never

  test("prompt dirender server dengan argumen", async () => {
    const url = serveMcp(fullServer)
    await connectAll([{ id: "s", url, allowPrivateHost: true }])
    const { mcpPromptTool } = await import("../src/tools/mcp_call.ts")
    const out = (await mcpPromptTool.execute(
      { server: "s", name: "review", args: { diff: "diff-saya" } },
      ctx,
    )) as string
    expect(out).toContain("Review perubahan")
    expect(out).toContain("[system] Kamu reviewer teliti.")
    expect(out).toContain("[user] Review: diff-saya")
  })

  test("content objek tunggal dan array keduanya ditangani", async () => {
    const url = serveMcp(fullServer)
    await connectAll([{ id: "s", url, allowPrivateHost: true }])
    const { mcpPromptTool } = await import("../src/tools/mcp_call.ts")
    const out = (await mcpPromptTool.execute({ server: "s", name: "review" }, ctx)) as string
    // system pakai objek tunggal, user pakai array — dua-duanya harus muncul
    expect(out.split("\n").filter((l) => l.startsWith("["))).toHaveLength(2)
  })

  test("prompt tak dikenal → pesan error server", async () => {
    const url = serveMcp(fullServer)
    await connectAll([{ id: "s", url, allowPrivateHost: true }])
    const { mcpPromptTool } = await import("../src/tools/mcp_call.ts")
    const out = (await mcpPromptTool.execute({ server: "s", name: "hantu" }, ctx)) as string
    expect(out).toContain("[mcp] error")
  })

  test("name kosong ditolak", async () => {
    const { mcpPromptTool } = await import("../src/tools/mcp_call.ts")
    await expect(mcpPromptTool.execute({ server: "s", name: "" }, ctx)).rejects.toThrow(
      /name is required/,
    )
  })
})

describe("MCP client: mcp_list menampilkan tiga kategori", () => {
  const ctx = { signal: new AbortController().signal, emit() {} } as never

  test("tools, resources, dan prompts semuanya terlihat", async () => {
    const url = serveMcp(fullServer)
    await connectAll([{ id: "s", url, allowPrivateHost: true }])
    const { mcpListTool } = await import("../src/tools/mcp_call.ts")
    const out = (await mcpListTool.execute({}, ctx)) as string
    expect(out).toContain("1 tools, 2 resources, 1 prompts")
    expect(out).toContain("tool     ping")
    expect(out).toContain("resource file:///readme")
    expect(out).toContain("prompt   review(diff*, gaya)")
  })

  test("tanpa server terhubung memberi petunjuk", async () => {
    const { mcpListTool } = await import("../src/tools/mcp_call.ts")
    const out = (await mcpListTool.execute({}, ctx)) as string
    expect(out).toContain("no MCP servers connected")
  })
})

describe("MCP resources/prompts: permission", () => {
  const h = createPermissionHandler({ mode: "auto", root: process.cwd() }) as ReturnType<
    typeof createPermissionHandler
  > & { __setMode(m: "auto" | "plan" | "readonly" | "allowlist"): void }
  const check = (name: string) => h.check({ id: "1", name, args: {} } as never, {} as never)

  test("mcp_read dan mcp_prompt di-gate meski read-only", async () => {
    // Keduanya menarik konten dari server pihak ketiga langsung ke konteks
    // model — jalur prompt-injection. Non-TTY (test/CI) → deny.
    expect(await check("mcp_read")).toBe("deny")
    expect(await check("mcp_prompt")).toBe("deny")
  })

  test("mcp_list tetap READONLY (hanya metadata server yang user daftarkan)", async () => {
    expect(await check("mcp_list")).toBe("allow")
  })

  test("readonly/plan/allowlist menolak mcp_read & mcp_prompt", async () => {
    for (const m of ["readonly", "plan", "allowlist"] as const) {
      h.__setMode(m)
      expect(await check("mcp_read")).toBe("deny")
      expect(await check("mcp_prompt")).toBe("deny")
    }
    h.__setMode("auto")
  })
})

describe("MCP connectAll paralel", () => {
  const minimal: RpcHandler = (method) => {
    if (method === "initialize")
      return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
    if (method === "tools/list") return { tools: [{ name: "ping", description: "cek" }] }
    throw new Error(`unsupported: ${method}`)
  }

  test("satu server gagal tak menggagalkan batch; pesan urut config", async () => {
    const url = serveMcp(minimal)
    const chunks: string[] = []
    const prev = process.stderr.write.bind(process.stderr)
    ;(process.stderr as unknown as { write: unknown }).write = (c: string | Uint8Array) => {
      chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"))
      return true
    }
    try {
      const tools = await connectAll([
        { id: "bagus", url, allowPrivateHost: true },
        { id: "rusak", url: "http://127.0.0.1:9/tidak-ada", allowPrivateHost: true },
      ])
      // Server bagus tetap menghasilkan tool meski tetangganya gagal total.
      expect(tools.length).toBeGreaterThan(0)
      expect(tools.every((t) => t.name.startsWith("bagus."))).toBe(true)
      // Koneksi paralel tapi pesan stderr deterministik sesuai urutan config.
      const out = chunks.join("")
      const iOk = out.indexOf("bagus connected")
      const iFail = out.indexOf("rusak failed")
      expect(iOk).toBeGreaterThanOrEqual(0)
      expect(iFail).toBeGreaterThanOrEqual(0)
      expect(iOk).toBeLessThan(iFail)
    } finally {
      ;(process.stderr as unknown as { write: unknown }).write = prev
    }
  })
})
