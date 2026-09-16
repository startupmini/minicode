import { afterEach, expect, test } from "bun:test"
import { isPrivateHost } from "../src/lib/net.ts"
import { webFetchTool } from "../src/tools/web_fetch.ts"

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
