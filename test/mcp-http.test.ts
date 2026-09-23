// Fase 3.3 — transport MCP Streamable HTTP.
//
// Diuji terhadap server HTTP nyata (Bun.serve di localhost) alih-alih mock
// fetch: yang ingin dibuktikan adalah perilaku di atas kabel — content-type
// negotiation, event SSE terpotong antar chunk, session header, dan penolakan
// redirect. Mock fetch akan melewatkan justru bagian yang rawan.
import { afterEach, describe, expect, test } from "bun:test"
import { McpHttpTransport, readJsonResponse, readSseResponse } from "../src/mcp/http-transport.ts"

type Handler = (req: Request) => Response | Promise<Response>

let server: ReturnType<typeof Bun.serve> | null = null

function serve(handler: Handler): string {
  server = Bun.serve({ port: 0, fetch: handler })
  return `http://127.0.0.1:${server.port}/mcp`
}

afterEach(() => {
  server?.stop(true)
  server = null
})

const jsonRpc = (id: unknown, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result })

// Semua test memakai localhost, jadi allowPrivateHost wajib — itu sendiri
// bagian dari kontrak yang diuji di blok "keamanan".
const mk = (url: string, headers?: Record<string, string>) =>
  new McpHttpTransport({ url, headers, allowPrivateHost: true })

describe("MCP http: transport dasar", () => {
  test("request/response JSON biasa", async () => {
    const url = serve(async (req) => {
      const body = (await req.json()) as { id: number; method: string }
      expect(req.method).toBe("POST")
      expect(req.headers.get("content-type")).toContain("application/json")
      return new Response(jsonRpc(body.id, { tools: [{ name: "ping" }] }), {
        headers: { "content-type": "application/json" },
      })
    })
    const t = mk(url)
    await t.connect()
    const res = (await t.request("tools/list")) as { tools: { name: string }[] }
    expect(res.tools[0]!.name).toBe("ping")
  })

  test("error JSON-RPC diterjemahkan ke throw dengan pesan server", async () => {
    const url = serve(async (req) => {
      const body = (await req.json()) as { id: number }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        }),
        { headers: { "content-type": "application/json" } },
      )
    })
    const t = mk(url)
    await t.connect()
    await expect(t.request("nope")).rejects.toThrow(/Method not found/)
  })

  test("HTTP non-2xx menyertakan status dan potongan body", async () => {
    const url = serve(() => new Response("boom detail", { status: 503 }))
    const t = mk(url)
    await t.connect()
    await expect(t.request("tools/list")).rejects.toThrow(/503.*boom detail/s)
  })

  test("body bukan JSON memberi pesan jelas, bukan crash parser", async () => {
    const url = serve(
      () =>
        new Response("<html>proxy error</html>", {
          headers: { "content-type": "application/json" },
        }),
    )
    const t = mk(url)
    await t.connect()
    await expect(t.request("tools/list")).rejects.toThrow(/not valid JSON/)
  })

  test("timeout dilaporkan sebagai timeout, bukan error jaringan generik", async () => {
    // Server sengaja tak pernah membalas: request PASTI kena timeout klien,
    // tanpa bergantung pada seberapa cepat mesin menjalankan sleep.
    const url = serve(() => new Promise<Response>(() => {}))
    const t = mk(url)
    await t.connect()
    await expect(t.request("slow", {}, 150)).rejects.toThrow(/timeout 150ms/)
  })
})

describe("MCP http: aliran SSE", () => {
  test("balasan diambil dari event SSE", async () => {
    const url = serve(async (req) => {
      const body = (await req.json()) as { id: number }
      const stream = `event: message\ndata: ${jsonRpc(body.id, { ok: true })}\n\n`
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    })
    const t = mk(url)
    await t.connect()
    expect(await t.request("ping")).toEqual({ ok: true })
  })

  test("notifikasi sebelum balasan dilewati", async () => {
    const url = serve(async (req) => {
      const body = (await req.json()) as { id: number }
      const stream =
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { p: 1 } })}\n\n` +
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { p: 2 } })}\n\n` +
        `data: ${jsonRpc(body.id, { done: true })}\n\n`
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    })
    const t = mk(url)
    await t.connect()
    expect(await t.request("long")).toEqual({ done: true })
  })

  test("event yang terpotong antar chunk tetap terbaca utuh", async () => {
    const url = serve(async (req) => {
      const body = (await req.json()) as { id: number }
      const payload = jsonRpc(body.id, { split: "berhasil" })
      const mid = Math.floor(payload.length / 2)
      const stream = new ReadableStream({
        async start(c) {
          const enc = new TextEncoder()
          // potong TEPAT di tengah payload JSON
          c.enqueue(enc.encode(`data: ${payload.slice(0, mid)}`))
          await Bun.sleep(20)
          c.enqueue(enc.encode(`${payload.slice(mid)}\n\n`))
          c.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    })
    const t = mk(url)
    await t.connect()
    expect(await t.request("chunked")).toEqual({ split: "berhasil" })
  })

  test("CRLF sebagai pemisah event juga didukung", async () => {
    const url = serve(async (req) => {
      const body = (await req.json()) as { id: number }
      return new Response(`data: ${jsonRpc(body.id, { crlf: true })}\r\n\r\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    })
    const t = mk(url)
    await t.connect()
    expect(await t.request("crlf")).toEqual({ crlf: true })
  })

  test("event non-JSON dilewati, tidak menggagalkan request", async () => {
    const url = serve(async (req) => {
      const body = (await req.json()) as { id: number }
      const stream = `: komentar keepalive\n\ndata: bukan-json\n\ndata: ${jsonRpc(body.id, { survived: true })}\n\n`
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    })
    const t = mk(url)
    await t.connect()
    expect(await t.request("noisy")).toEqual({ survived: true })
  })

  test("aliran berakhir tanpa balasan → error, bukan hang", async () => {
    const url = serve(
      () =>
        new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notif" })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    )
    const t = mk(url)
    await t.connect()
    await expect(t.request("orphan")).rejects.toThrow(/returned no response/)
  })
})

describe("MCP http: sesi & protokol", () => {
  test("Mcp-Session-Id disimpan dan dikirim ulang", async () => {
    const seen: (string | null)[] = []
    const url = serve(async (req) => {
      const body = (await req.json()) as { id: number; method: string }
      seen.push(req.headers.get("mcp-session-id"))
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (body.method === "initialize") headers["mcp-session-id"] = "sesi-abc"
      return new Response(jsonRpc(body.id, { protocolVersion: "2025-06-18" }), { headers })
    })
    const t = mk(url)
    await t.connect()
    await t.request("initialize")
    await t.request("tools/list")
    expect(seen[0]).toBeNull() // request pertama belum punya sesi
    expect(seen[1]).toBe("sesi-abc") // request kedua menyertakannya
  })

  test("protocolVersion hasil initialize dikirim di request berikutnya", async () => {
    const versions: (string | null)[] = []
    const url = serve(async (req) => {
      const body = (await req.json()) as { id: number; method: string }
      versions.push(req.headers.get("mcp-protocol-version"))
      return new Response(jsonRpc(body.id, { protocolVersion: "2099-01-01" }), {
        headers: { "content-type": "application/json" },
      })
    })
    const t = mk(url)
    await t.connect()
    await t.request("initialize")
    await t.request("tools/list")
    expect(versions[1]).toBe("2099-01-01")
  })

  test("header kustom (Authorization) diteruskan", async () => {
    let auth: string | null = null
    const url = serve(async (req) => {
      const body = (await req.json()) as { id: number }
      auth = req.headers.get("authorization")
      return new Response(jsonRpc(body.id, {}), {
        headers: { "content-type": "application/json" },
      })
    })
    const t = mk(url, { authorization: "Bearer rahasia" })
    await t.connect()
    await t.request("ping")
    expect(auth as string | null).toBe("Bearer rahasia")
  })

  test("notify tidak menunggu balasan dan tidak melempar", async () => {
    let hit = 0
    const url = serve(() => {
      hit++
      return new Response("", { status: 202 })
    })
    const t = mk(url)
    await t.connect()
    t.notify("notifications/initialized")
    // Poll dengan deadline, bukan sleep tetap: notify sengaja fire-and-forget,
    // jadi kita menunggu server MENERIMA request — bukan menebak berapa lama
    // event loop butuh. Sleep tetap membuat test flaky saat mesin sibuk.
    const deadline = Date.now() + 5000
    while (hit === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(hit).toBe(1)
  })

  test("close mengirim DELETE bila ada sesi", async () => {
    const methods: string[] = []
    const url = serve(async (req) => {
      methods.push(req.method)
      if (req.method === "DELETE") return new Response("", { status: 204 })
      const body = (await req.json()) as { id: number }
      return new Response(jsonRpc(body.id, {}), {
        headers: { "content-type": "application/json", "mcp-session-id": "s1" },
      })
    })
    const t = mk(url)
    await t.connect()
    await t.request("initialize")
    await t.close()
    expect(methods).toContain("DELETE")
  })

  test("request setelah close ditolak", async () => {
    const url = serve(async (req) => {
      const body = (await req.json()) as { id: number }
      return new Response(jsonRpc(body.id, {}), {
        headers: { "content-type": "application/json" },
      })
    })
    const t = mk(url)
    await t.connect()
    await t.close()
    await expect(t.request("ping")).rejects.toThrow(/already closed/)
  })
})

describe("MCP http: keamanan", () => {
  test("host privat ditolak tanpa opt-in eksplisit", async () => {
    // Ini penjaga SSRF: server MCP yang menunjuk ke localhost / metadata
    // endpoint tidak boleh dihubungi hanya karena tertulis di config.
    const t = new McpHttpTransport({ url: "http://127.0.0.1:9/mcp" })
    await expect(t.connect()).rejects.toThrow(/private host rejected/)
  })

  test("F-21: request() validasi ulang tanpa connect dulu", async () => {
    // Validasi bukan hanya saat connect: sesi berumur panjang + DNS berubah
    // setelah connect tetap tertahan di tiap request.
    const t = new McpHttpTransport({ url: "http://127.0.0.1:9/mcp" })
    await expect(t.request("ping")).rejects.toThrow(/private host rejected/)
  })

  test("metadata endpoint cloud ditolak", async () => {
    const t = new McpHttpTransport({ url: "http://169.254.169.254/latest/meta-data" })
    await expect(t.connect()).rejects.toThrow(/private host rejected/)
  })

  test("allowPrivateHost mengizinkan server lokal", async () => {
    const t = new McpHttpTransport({ url: "http://127.0.0.1:9/mcp", allowPrivateHost: true })
    await t.connect() // tidak melempar
  })

  test("protokol non-http ditolak saat konstruksi", () => {
    expect(() => new McpHttpTransport({ url: "file:///etc/passwd" })).toThrow(
      /unsupported protocol/,
    )
    expect(() => new McpHttpTransport({ url: "ftp://x/y" })).toThrow(/unsupported protocol/)
  })

  test("URL tidak valid ditolak saat konstruksi", () => {
    expect(() => new McpHttpTransport({ url: "bukan-url" })).toThrow(/invalid URL/)
  })

  test("redirect TIDAK diikuti (permukaan SSRF)", async () => {
    const url = serve(
      () => new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } }),
    )
    const t = mk(url)
    await t.connect()
    await expect(t.request("ping")).rejects.toThrow(/redirect not followed/)
  })

  test("balasan raksasa dibatasi, bukan OOM", async () => {
    const url = serve(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              const enc = new TextEncoder()
              const chunk = enc.encode("x".repeat(64 * 1024))
              // jauh melewati MCP_OUTPUT_MAX_CHARS
              for (let i = 0; i < 4000; i++) c.enqueue(chunk)
              c.close()
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    )
    const t = mk(url)
    await t.connect()
    await expect(t.request("flood")).rejects.toThrow(/batas ukuran/)
  })

  test("F7: notify() ke host privat TIDAK mengirim (bukan fire-and-forget tanpa cek)", async () => {
    // Skenario: egress ke 127.0.0.1 tanpa allowPrivateHost. Tanpa cek, server
    // lokal akan menerima POST notifikasi sebelum request pertama.
    let hits = 0
    const url = serve(() => {
      hits++
      return new Response(jsonRpc(0, {}), { headers: { "content-type": "application/json" } })
    })
    const t = new McpHttpTransport({ url })
    t.notify("ping", {})
    await new Promise((r) => setTimeout(r, 200))
    expect(hits).toBe(0)
  })

  test("F7: setelah host terbukti privat, request berikutnya tetap ditolak", async () => {
    // blockedPrivate = keputusan sekali-berlaku: sesi yang sudah ditolak tak
    // bisa "dingin" lagi memakai jalur yang sama.
    const t = new McpHttpTransport({ url: "http://127.0.0.1:9/mcp" })
    await expect(t.connect()).rejects.toThrow(/private host rejected/)
    await expect(t.request("ping")).rejects.toThrow(/private host rejected/)
    // close() pada transport terblokir tidak melempar (cleanup harus aman)
    // dan tidak mengirim DELETE.
    await t.close()
  })

  test("F7: close() tanpa sessionId tidak menyentuh jaringan", async () => {
    // DELETE hanya bermakna bila server memberi session id; tanpanya close
    // murni state lokal.
    let hits = 0
    const url = serve(() => {
      hits++
      return new Response(jsonRpc(0, {}), { headers: { "content-type": "application/json" } })
    })
    const t = mk(url)
    await t.close()
    await new Promise((r) => setTimeout(r, 100))
    expect(hits).toBe(0)
  })
})

describe("MCP http: helper parsing", () => {
  test("readJsonResponse memilih elemen batch yang punya result", async () => {
    const res = new Response(
      JSON.stringify([
        { jsonrpc: "2.0", method: "notif" },
        { jsonrpc: "2.0", id: 1, result: { dipilih: true } },
      ]),
    )
    const parsed = await readJsonResponse(res)
    expect(parsed?.result).toEqual({ dipilih: true })
  })

  test("readJsonResponse pada body kosong → null", async () => {
    expect(await readJsonResponse(new Response(""))).toBeNull()
  })

  test("readJsonResponse dengan expectId menolak id yang tidak cocok", async () => {
    // Regresi dari experiments/extreme-mcp-adversarial.ts: tanpa cek id,
    // balasan untuk request lain diterima sebagai hasil dan `result: undefined`
    // menjalar ke pemanggil sebagai "sukses".
    const wrongId = new Response(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }))
    expect(await readJsonResponse(wrongId, 1)).toBeNull()
    const rightId = new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: 1 } }))
    expect((await readJsonResponse(rightId, 1))?.result).toEqual({ ok: 1 })
  })

  test("readJsonResponse dengan expectId menolak notifikasi tanpa id", async () => {
    const notif = new Response(JSON.stringify({ jsonrpc: "2.0", method: "notifications/x" }))
    expect(await readJsonResponse(notif, 1)).toBeNull()
  })

  test("readJsonResponse pada body 'null' → null, bukan crash", async () => {
    expect(await readJsonResponse(new Response("null"), 1)).toBeNull()
  })

  test("readSseResponse mengabaikan id yang tidak cocok", async () => {
    const res = new Response(`data: ${jsonRpc(99, { salah: true })}\n\n`)
    expect(await readSseResponse(res, 1)).toBeNull()
  })

  test("readSseResponse menerima beberapa baris data dalam satu event", async () => {
    const payload = jsonRpc(1, { multiline: true })
    const half = Math.floor(payload.length / 2)
    const res = new Response(`data: ${payload.slice(0, half)}\ndata: ${payload.slice(half)}\n\n`)
    const parsed = await readSseResponse(res, 1)
    expect(parsed?.result).toEqual({ multiline: true })
  })
})

describe("MCP http: balasan yang tak menjawab request", () => {
  test("server membalas id lain → error, bukan sukses dengan result undefined", async () => {
    const url = serve(
      () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 4242, result: { bukan: "punyamu" } }), {
          headers: { "content-type": "application/json" },
        }),
    )
    const t = mk(url)
    await t.connect()
    await expect(t.request("ping")).rejects.toThrow(/returned no response/)
  })

  test("server hanya mengirim notifikasi → error", async () => {
    const url = serve(
      () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" }), {
          headers: { "content-type": "application/json" },
        }),
    )
    const t = mk(url)
    await t.connect()
    await expect(t.request("ping")).rejects.toThrow(/returned no response/)
  })
})
