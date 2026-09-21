import { afterEach, expect, test } from "bun:test"
import { isPrivateHost } from "../src/lib/net.ts"
import { webFetchTool } from "../src/tools/web_fetch.ts"
import { webSearchTool } from "../src/tools/web_search.ts"

const ctx = { signal: new AbortController().signal } as never

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function htmlResponse(status: number, headers: Record<string, string>, bodyChunks: string[]) {
  const encoder = new TextEncoder()
  let i = 0
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (i < bodyChunks.length) controller.enqueue(encoder.encode(bodyChunks[i++]!))
        else controller.close()
      },
    }),
    { status, headers },
  )
}

test("isPrivateHost covers loopback/private/ULA/link-local/CGNAT/metadata", () => {
  for (const h of [
    "localhost",
    "sub.localhost",
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.169.254",
    "0.1.2.3",
    "100.64.0.1",
    "metadata.google.internal",
    "foo.local",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
  ])
    expect(isPrivateHost(h)).toBe(true)
  // WHATWG URL menormalisasi hex/decimal sebelum sampai sini â€” simulasikan:
  expect(isPrivateHost(new URL("http://0x7f000001/").hostname)).toBe(true)
  expect(isPrivateHost(new URL("http://2130706433/").hostname)).toBe(true)
  for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1"]) {
    expect(isPrivateHost(h)).toBe(false)
  }
})

test("blocks direct private host without fetching", async () => {
  let called = false
  globalThis.fetch = (async () => {
    called = true
    throw new Error("should not fetch")
  }) as unknown as typeof fetch
  await expect(
    webFetchTool.execute({ url: "http://169.254.169.254/latest/meta-data/" }, ctx),
  ).rejects.toThrow(/blocked private host/)
  expect(called).toBe(false)
})

test("blocks SSRF via open redirect to private host", async () => {
  globalThis.fetch = (async () =>
    htmlResponse(
      302,
      { location: "http://169.254.169.254/latest/meta-data/" },
      [],
    )) as unknown as typeof fetch
  await expect(
    webFetchTool.execute({ url: "https://public.example.com/redir" }, ctx),
  ).rejects.toThrow(/blocked private host \(redirect target\)/)
})

test("blocks redirect to disallowed protocol", async () => {
  globalThis.fetch = (async () =>
    htmlResponse(302, { location: "file:///etc/passwd" }, [])) as unknown as typeof fetch
  await expect(
    webFetchTool.execute({ url: "https://public.example.com/redir" }, ctx),
  ).rejects.toThrow(/disallowed protocol/)
})

test("rejects redirect loops beyond MAX_REDIRECTS", async () => {
  globalThis.fetch = (async (_input?: unknown, init?: unknown) => {
    void init
    return htmlResponse(302, { location: "/next" }, [])
  }) as unknown as typeof fetch
  await expect(webFetchTool.execute({ url: "https://loop.example.com/a" }, ctx)).rejects.toThrow(
    /too many redirects/,
  )
})

test("follows safe redirects and returns content", async () => {
  let hops = 0
  globalThis.fetch = (async (input: unknown) => {
    const u = String(input)
    if (u.includes("/hop1")) {
      hops++
      return htmlResponse(302, { location: "/hop2" }, [])
    }
    if (u.includes("/hop2")) {
      hops++
      return htmlResponse(200, { "content-type": "text/plain" }, ["hello"])
    }
    hops++
    return htmlResponse(302, { location: "/hop1" }, [])
  }) as unknown as typeof fetch
  const out = await webFetchTool.execute({ url: "https://ok.example.com/start" }, ctx)
  expect(hops).toBeGreaterThanOrEqual(2)
  expect(String(out)).toContain("hello")
})

test("body hard-cap aborts oversized responses before OOM", async () => {
  const bigChunk = "x".repeat(500_000)
  globalThis.fetch = (async () =>
    htmlResponse(
      200,
      { "content-type": "text/plain" },
      Array(20).fill(bigChunk),
    )) as unknown as typeof fetch
  const out = await webFetchTool.execute(
    { url: "https://big.example.com/blob", maxChars: 5000 },
    ctx,
  )
  const text = String(out)
  expect(text).toContain("[https://big.example.com/blob")
  expect(text.length).toBeLessThan(6000)
})

test("header tak menggema userinfo/query kredensial (bug-hunt F4)", async () => {
  globalThis.fetch = (async () =>
    htmlResponse(200, { "content-type": "text/html" }, ["hi"])) as unknown as typeof fetch
  const out1 = String(
    await webFetchTool.execute({ url: "https://user:pass@public.example.com/" }, ctx),
  )
  expect(out1).not.toContain("user:pass")
  expect(out1).toContain("public.example.com")
  const out2 = String(
    await webFetchTool.execute({ url: "https://public.example.com/?api_key=SECRET123" }, ctx),
  )
  expect(out2).not.toContain("SECRET123")
  expect(out2).toContain("api_key=[REDACTED]")
})

test("DDG fallback cap streaming: stream tak-berujung tak gantung (bug-hunt)", async () => {
  // Kode lama: await res.text() — stream ini tak pernah selesai = test
  // timeout 5 dtk di kode lama. Kode baru: berhenti di hard-cap 2M.
  const encoder = new TextEncoder()
  const chunk = encoder.encode("x".repeat(65536))
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(chunk)
        },
      }),
      { status: 200, headers: { "content-type": "text/html" } },
    )) as unknown as typeof fetch
  const out = String(await webSearchTool.execute({ query: "probe-cap" }, ctx))
  expect(out.length).toBeLessThan(20000)
}, 15000)
