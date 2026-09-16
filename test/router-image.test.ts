import { expect, test } from "bun:test"
import { createAnthropicProvider } from "../src/providers/anthropic.ts"
import { createRouterProvider } from "../src/providers/router.ts"

const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"vision"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
].join("")

function makeToolMessage(content: unknown) {
  return [
    { role: "user", content: "lihat" },
    { role: "tool", toolCallId: "c1", name: "read_file", content },
  ] as never
}

test("router preserves Uint8Array tool content for anthropic (image block, C11)", async () => {
  let capturedBody = ""
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    capturedBody = init?.body ?? ""
    return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } })
  }) as unknown as typeof fetch

  try {
    const anthropic = createAnthropicProvider({
      apiKey: "k",
      models: ["claude-test"],
      maxTokens: 64,
      enablePromptCaching: false,
    })
    expect((anthropic as unknown as { kind?: string }).kind).toBe("anthropic")
    const router = createRouterProvider({ providers: [anthropic] })

    // PNG magic bytes
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    for await (const _ of router.stream(
      { model: "claude-test", messages: makeToolMessage(png), tools: [] } as never,
      new AbortController().signal,
    )) {
      break
    }

    const parsed = JSON.parse(capturedBody)
    const blocks = parsed.messages.find(
      (m: { role: string; content?: unknown }) => m.role === "user" && Array.isArray(m.content),
    ).content
    const tr = blocks.find((b: { type: string }) => b.type === "tool_result")
    expect(Array.isArray(tr.content)).toBe(true)
    expect(tr.content[0].type).toBe("image")
    expect(tr.content[0].source.media_type).toBe("image/png")
    expect(tr.content[0].source.data).toBe(Buffer.from(png).toString("base64"))
  } finally {
    globalThis.fetch = origFetch
  }
})

test("non-image binary tool content falls back to base64 string", async () => {
  let capturedBody = ""
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    capturedBody = init?.body ?? ""
    return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } })
  }) as unknown as typeof fetch

  try {
    const anthropic = createAnthropicProvider({
      apiKey: "k",
      models: ["claude-test"],
      maxTokens: 64,
      enablePromptCaching: false,
    })
    const router = createRouterProvider({ providers: [anthropic] })
    const bytes = new Uint8Array([1, 2, 3, 4]) // bukan magic bytes gambar
    for await (const _ of router.stream(
      { model: "claude-test", messages: makeToolMessage(bytes), tools: [] } as never,
      new AbortController().signal,
    )) {
      break
    }
    const parsed = JSON.parse(capturedBody)
    const blocks = parsed.messages.find(
      (m: { role: string; content?: unknown }) => m.role === "user" && Array.isArray(m.content),
    ).content
    const tr = blocks.find((b: { type: string }) => b.type === "tool_result")
    expect(typeof tr.content).toBe("string")
    expect(tr.content).toBe(Buffer.from(bytes).toString("base64"))
  } finally {
    globalThis.fetch = origFetch
  }
})
