import { expect, test } from "bun:test"
import { ProviderError } from "#minicore/core/errors.ts"
import { validateArgs } from "#minicore/core/tool.ts"
import { createOpenAICompatProvider } from "#minicore/providers/openai-compat.ts"
import { RateLimiter } from "../src/policy/ratelimit.ts"
import { createAnthropicProvider } from "../src/providers/anthropic.ts"
import { createRouterProvider } from "../src/providers/router.ts"

test("anthropic maps 429 retryAfter capped 30s", async () => {
  const origFetch = globalThis.fetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response("rate limit", {
      status: 429,
      headers: { "retry-after": "3600" },
    }) as unknown as Response
  const p = createAnthropicProvider({ apiKey: "k", models: ["claude-sonnet-4"] })
  try {
    for await (const _ of p.stream(
      { messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    )) {
    }
    expect(false).toBe(true)
  } catch (e) {
    expect((e as ProviderError).category).toBe("rate_limit")
    expect((e as ProviderError).retryAfterMs).toBe(30_000)
  }
  globalThis.fetch = origFetch
})

test("anthropic maps context_length", async () => {
  const origFetch = globalThis.fetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response("prompt is too long", { status: 400, headers: {} }) as unknown as Response
  const p = createAnthropicProvider({ apiKey: "k", models: ["claude-sonnet-4"] })
  try {
    for await (const _ of p.stream(
      { messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    )) {
    }
    expect(false).toBe(true)
  } catch (e) {
    expect((e as ProviderError).category).toBe("context_length_exceeded")
  }
  globalThis.fetch = origFetch
})

test("anthropic maps context_length via 'input is too long' phrase (F5)", async () => {
  const origFetch = globalThis.fetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response("input is too long: 200000 tokens > 128000", {
      status: 400,
      headers: {},
    }) as unknown as Response
  const p = createAnthropicProvider({ apiKey: "k", models: ["claude-sonnet-4"] })
  try {
    for await (const _ of p.stream(
      { messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    )) {
    }
    expect(false).toBe(true)
  } catch (e) {
    expect((e as ProviderError).category).toBe("context_length_exceeded")
  }
  globalThis.fetch = origFetch
})

test("openai-compat [DONE] melepas body stream (cancel) — F2", async () => {
  let cancelled = false
  const origFetch = globalThis.fetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\ndata: [DONE]\n\n'))
        },
        cancel() {
          cancelled = true
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ) as unknown as Response
  const p = createOpenAICompatProvider({ apiKey: "k", baseUrl: "https://x/v1", models: ["m"] })
  for await (const _ of p.stream(
    { messages: [{ role: "user", content: "hi" }], model: "m" },
    new AbortController().signal,
  )) {
  }
  globalThis.fetch = origFetch
  expect(cancelled).toBe(true)
})

test("router first match wins for shared model names", async () => {
  const primary: any = {
    id: "primary",
    models: ["shared-model"],
    async *stream() {
      yield { type: "text", text: "from-primary" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const secondary: any = {
    id: "secondary",
    models: ["shared-model"],
    async *stream() {
      yield { type: "text", text: "from-secondary" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const router = createRouterProvider({ providers: [primary, secondary] })
  const out: string[] = []
  for await (const ev of router.stream(
    { messages: [{ role: "user", content: "hi" }], model: "shared-model" },
    new AbortController().signal,
  )) {
    if (ev.type === "text") out.push(ev.text)
  }
  expect(out.join("")).toBe("from-primary")
})

test("router providerId::model forces specific provider", async () => {
  const primary: any = {
    id: "primary",
    models: ["shared-model"],
    async *stream() {
      yield { type: "text", text: "from-primary" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const secondary: any = {
    id: "secondary",
    models: ["shared-model"],
    async *stream() {
      yield { type: "text", text: "from-secondary" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const router = createRouterProvider({ providers: [primary, secondary] })
  const out: string[] = []
  for await (const ev of router.stream(
    { messages: [{ role: "user", content: "hi" }], model: "secondary::shared-model" },
    new AbortController().signal,
  )) {
    if (ev.type === "text") out.push(ev.text)
  }
  expect(out.join("")).toBe("from-secondary")
})

test("router fallback on rate_limit", async () => {
  const bad: any = {
    id: "bad",
    models: ["m1"],
    // biome-ignore lint/correctness/useYield: fake provider yang selalu gagal - throw sebelum yield pertama
    async *stream() {
      throw new ProviderError("rate_limit", "rl", 100)
    },
  }
  const good: any = {
    id: "good",
    models: ["m2"],
    async *stream() {
      yield { type: "text", text: "ok" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const router = createRouterProvider({ providers: [bad, good] })
  const out: string[] = []
  for await (const ev of router.stream(
    { messages: [{ role: "user", content: "hi" }], model: "m1" },
    new AbortController().signal,
  )) {
    if (ev.type === "text") out.push(ev.text)
  }
  expect(out.join("")).toBe("ok")
})

test("router C4 fix Uint8Array -> base64", async () => {
  let captured: any = null
  const inner: any = {
    id: "inner",
    models: ["m"],
    async *stream(req: any) {
      captured = req
      yield { type: "text", text: "hi" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const router = createRouterProvider({ providers: [inner] })
  const bytes = new Uint8Array([1, 2, 3])
  for await (const _ of router.stream(
    { messages: [{ role: "tool", toolCallId: "c1", name: "t", content: bytes } as any] },
    new AbortController().signal,
  )) {
  }
  expect(typeof captured.messages[0].content).toBe("string")
  expect(captured.messages[0].content).toBe(Buffer.from(bytes).toString("base64"))
})

test("anthropic groups consecutive tool results into one user message", async () => {
  let body: any = null
  const origFetch = globalThis.fetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (_url: unknown, init: any) => {
    body = JSON.parse(init.body)
    const sse =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }) as unknown as Response
  }
  const p = createAnthropicProvider({ apiKey: "k", models: ["claude-sonnet-4"] })
  const messages = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", name: "read_file", args: { path: "a" } },
        { id: "c2", name: "git_status", args: {} },
      ],
    },
    { role: "tool", toolCallId: "c1", name: "read_file", content: "a-content" },
    { role: "tool", toolCallId: "c2", name: "git_status", content: "clean" },
    { role: "assistant", content: "here is the result" },
    { role: "user", content: "next" },
  ] as any
  try {
    for await (const _ of p.stream({ messages }, new AbortController().signal)) {
    }
  } catch {}
  globalThis.fetch = origFetch
  expect(body).not.toBeNull()
  // cari assistant yang memuat tool_use; pesan berikutnya harus user tunggal berisi 2 tool_result
  const idx = body.messages.findIndex(
    (m: any) => m.role === "assistant" && m.content?.some((c: any) => c.type === "tool_use"),
  )
  const next = body.messages[idx + 1]
  expect(next.role).toBe("user")
  expect(next.content).toHaveLength(2)
  expect(next.content[0].type).toBe("tool_result")
  expect(next.content[1].type).toBe("tool_result")
  expect(next.content[0].tool_use_id).toBe("c1")
  expect(next.content[1].tool_use_id).toBe("c2")
  // role harus bergantian — tidak boleh ada dua "user" berturut-turut dari tool results
  for (let i = 1; i < body.messages.length; i++) {
    if (body.messages[i].role === "user" && body.messages[i - 1].role === "user") {
      expect(true).toBe(false) // jangan sampai ada user berurutan
    }
  }
})

test("router fallback substitutes model not supported by target provider", async () => {
  const received: any[] = []
  const bad: any = {
    id: "bad",
    models: ["gpt-4o"],
    // biome-ignore lint/correctness/useYield: fake provider yang selalu gagal - throw sebelum yield pertama
    async *stream() {
      throw new ProviderError("rate_limit", "rl", 100)
    },
  }
  const good: any = {
    id: "good",
    models: ["claude-sonnet-4"],
    async *stream(req: any) {
      received.push(req)
      yield { type: "text", text: "ok" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const router = createRouterProvider({ providers: [bad, good] })
  const out: string[] = []
  for await (const ev of router.stream(
    { messages: [{ role: "user", content: "hi" }], model: "gpt-4o" },
    new AbortController().signal,
  )) {
    if (ev.type === "text") out.push(ev.text)
  }
  expect(out.join("")).toBe("ok")
  // request ke provider kedua harus memakai model miliknya, bukan gpt-4o
  expect(received[0]?.model).toBe("claude-sonnet-4")
})

test("router emits effective-model extension saat substitusi model fallback", async () => {
  const bad: any = {
    id: "bad",
    models: ["m1"],
    // biome-ignore lint/correctness/useYield: fake provider yang selalu gagal - throw sebelum yield pertama
    async *stream() {
      throw new ProviderError("rate_limit", "rl", 100)
    },
  }
  const good: any = {
    id: "good",
    models: ["substituted-model"],
    async *stream() {
      yield { type: "text", text: "ok" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const router = createRouterProvider({ providers: [bad, good] })
  let eff: Record<string, unknown> | null = null
  for await (const ev of router.stream(
    { messages: [{ role: "user", content: "hi" }], model: "gpt-4o" },
    new AbortController().signal,
  )) {
    if (ev.type === "extension" && ev.kind === "effective-model")
      eff = ev.data as Record<string, unknown>
  }
  expect(eff).toEqual({ requested: "gpt-4o", effective: "substituted-model", provider: "good" })
})

test("router caps retryAfter + coba ulang di tempat sekali", async () => {
  const bad: any = {
    id: "bad",
    models: ["m"],
    // biome-ignore lint/correctness/useYield: fake provider yang selalu gagal - throw sebelum yield pertama
    async *stream() {
      // retryAfter 5 dtk > cap 100 ms: dipotong tanpa mutasi error asli.
      // Provider tunggal → tunggu-di-tempat 100 ms + coba ulang sekali.
      throw new ProviderError("rate_limit", "rl", 5_000)
    },
  }
  const router = createRouterProvider({ providers: [bad], maxRetryAfterMs: 100 })
  try {
    for await (const _ of router.stream(
      { messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    )) {
    }
    expect(false).toBe(true)
  } catch (e) {
    expect((e as ProviderError).retryAfterMs).toBe(100)
  }
})

test("router membuang Retry-After NaN/negatif sebelum memutuskan retry", async () => {
  for (const malformed of [Number.NaN, -1]) {
    let calls = 0
    const provider: any = {
      id: "single",
      models: ["m"],
      // biome-ignore lint/correctness/useYield: provider always fails before its first event
      async *stream() {
        calls++
        throw new ProviderError("rate_limit", "bad retry-after", malformed)
      },
    }
    const router = createRouterProvider({ providers: [provider] })
    try {
      for await (const _event of router.stream(
        { messages: [{ role: "user", content: "hi" }] },
        new AbortController().signal,
      )) {
      }
      expect(false).toBe(true)
    } catch (error) {
      expect((error as ProviderError).retryAfterMs).toBeUndefined()
      expect(calls).toBe(1)
    }
  }
})

test("router membatalkan antrean limiter saat deadline request habis", async () => {
  const limiter = new RateLimiter(1, 1 / 1000)
  await limiter.acquire()
  let providerCalls = 0
  const provider: any = {
    id: "limited",
    models: ["m"],
    async *stream() {
      providerCalls++
      yield { type: "finish", reason: "stop" }
    },
  }
  const router = createRouterProvider({ providers: [provider], limiter })
  const controller = new AbortController()
  const started = Date.now()
  const run = (async () => {
    for await (const _event of router.stream(
      { messages: [{ role: "user", content: "hi" }], model: "m" },
      controller.signal,
    )) {
    }
  })()
  setTimeout(() => controller.abort(new Error("request deadline")), 20)
  let caught: unknown
  try {
    await run
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toBe("request deadline")
  expect(providerCalls).toBe(0)
  expect(Date.now() - started).toBeLessThan(500)
})

test("router membatalkan dan membersihkan tidur Retry-After", async () => {
  let providerCalls = 0
  const provider: any = {
    id: "pinned",
    models: ["m"],
    // biome-ignore lint/correctness/useYield: provider always fails before its first event
    async *stream() {
      providerCalls++
      throw new ProviderError("rate_limit", "slow down", 30_000)
    },
  }
  const router = createRouterProvider({ providers: [provider] })
  const controller = new AbortController()
  const started = Date.now()
  const run = (async () => {
    for await (const _event of router.stream(
      { messages: [{ role: "user", content: "hi" }], model: "pinned::m" },
      controller.signal,
    )) {
    }
  })()
  setTimeout(() => controller.abort(new Error("run deadline")), 20)
  let caught: unknown
  try {
    await run
  } catch (error) {
    caught = error
  }
  expect((caught as Error | undefined)?.message).toBe("run deadline")
  expect(providerCalls).toBe(1)
  expect(Date.now() - started).toBeLessThan(500)
})

test("anthropic thinking: adds thinking block + beta header, emits reasoning", async () => {
  let body: any = null
  let beta = ""
  const origFetch = globalThis.fetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (_url: unknown, init: any) => {
    body = JSON.parse(init.body)
    beta = init.headers["anthropic-beta"]
    const sse =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }) as unknown as Response
  }
  const p = createAnthropicProvider({ apiKey: "k", models: ["claude-sonnet-4"], thinking: 1000 })
  const events: string[] = []
  try {
    for await (const ev of p.stream(
      { messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    )) {
      if (ev.type === "extension" && ev.kind === "reasoning")
        events.push((ev.data as { text: string }).text)
    }
  } catch {}
  globalThis.fetch = origFetch
  expect(body.thinking).toMatchObject({ type: "enabled", budget_tokens: 1000 })
  expect(beta).toContain("thinking-2024-12-16")
  expect(events.join("")).toContain("Let me think")
})

async function anthropicBody(
  config: Record<string, unknown>,
  model?: string,
): Promise<{ body: any; beta: string }> {
  let body: any = null
  let beta = ""
  const origFetch = globalThis.fetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (_url: unknown, init: any) => {
    body = JSON.parse(init.body)
    beta = init.headers["anthropic-beta"] ?? ""
    const sse =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }) as unknown as Response
  }
  const p = createAnthropicProvider({ apiKey: "k", models: ["m"], ...(config as object) } as never)
  try {
    for await (const _ of p.stream(
      { messages: [{ role: "user", content: "hi" }], ...(model ? { model } : {}) },
      new AbortController().signal,
    )) {
    }
  } catch {}
  globalThis.fetch = origFetch
  return { body, beta }
}

test("anthropic effort: legacy (4.5) = budget + beta; adaptive (opus-5) = adaptive tanpa beta", async () => {
  const legacy = await anthropicBody({ reasoningEffort: "medium" }, "claude-sonnet-4-5")
  expect(legacy.body.thinking).toMatchObject({ type: "enabled", budget_tokens: 2048 })
  expect(legacy.beta).toContain("thinking-2024-12-16")

  const adaptive = await anthropicBody({ reasoningEffort: "high" }, "claude-opus-5")
  expect(adaptive.body.thinking).toMatchObject({ type: "adaptive" })
  expect(adaptive.body.output_config).toMatchObject({ effort: "high" })
  expect(adaptive.beta).not.toContain("thinking-2024-12-16")
  expect(adaptive.beta).toContain("prompt-caching")
})

test("anthropic effort: model non-claude = omit total (tanpa thinking, tanpa beta)", async () => {
  const r = await anthropicBody({ reasoningEffort: "medium" }, "deepseek-chat")
  expect("thinking" in r.body).toBe(false)
  expect(r.beta).not.toContain("thinking")
})

test("anthropic vision: user image content dikirim base64", async () => {
  let body: any = null
  const origFetch = globalThis.fetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (_url: unknown, init: any) => {
    body = JSON.parse(init.body)
    const sse =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }) as unknown as Response
  }
  const p = createAnthropicProvider({ apiKey: "k", models: ["claude-sonnet-4"] })
  const img = new Uint8Array([137, 80, 78, 71])
  try {
    for await (const _ of p.stream(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              { type: "image", data: img, mime: "image/png" },
            ],
          },
        ],
      },
      new AbortController().signal,
    )) {
    }
  } catch {}
  globalThis.fetch = origFetch
  const userMsg = body.messages.find((m: any) => m.role === "user")
  const imagePart = userMsg.content.find((c: any) => c.type === "image")
  expect(imagePart).toBeTruthy()
  expect(imagePart.source.media_type).toBe("image/png")
  expect(imagePart.source.data).toBe(Buffer.from(img).toString("base64"))
})

test("openai-compat thought_signature: args bersih, echo via side-map", async () => {
  // Regresi S1: versi lama menaruh __extra_content di args → validateArgs
  // menolak ("unknown property") sehingga tool call Gemini thinking gagal.
  const origFetch = globalThis.fetch
  const bodies: any[] = []
  const sig = { google: { thought_signature: "sig-abc-123" } }
  const toolChunk = `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"},"extra_content":${JSON.stringify(sig)}}]}}]}\n\n`
  const finishChunk = `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`
  let n = 0
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (_url: unknown, init: any) => {
    bodies.push(JSON.parse(init.body))
    n++
    // request ke-2 (replay history): langsung finish tanpa tool
    const sse =
      n === 1
        ? toolChunk + finishChunk
        : `data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }) as unknown as Response
  }
  const p = createOpenAICompatProvider({ baseUrl: "https://x/v1", apiKey: "k", models: ["m"] })
  const calls: any[] = []
  try {
    for await (const ev of p.stream(
      { messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    )) {
      if (ev.type === "tool_call") calls.push(ev)
    }
  } catch {}
  globalThis.fetch = origFetch
  expect(calls.length).toBe(1)
  const args = calls[0]!.args as Record<string, unknown>
  // args harus bersih — executor validateArgs additionalProperties:false
  expect("__extra_content" in args).toBe(false)
  expect(args).toEqual({ path: "a.txt" })
  const schema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  } as const
  expect(validateArgs(schema, args).ok).toBe(true)

  // replay: history berisi tool call di atas → body ke-2 harus echo extra_content
  const origFetch2 = globalThis.fetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (_url: unknown, init: any) => {
    bodies.push(JSON.parse(init.body))
    return new Response(
      `data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ) as unknown as Response
  }
  try {
    for await (const _ of p.stream(
      {
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_1", name: "read_file", args }],
          } as any,
        ],
      },
      new AbortController().signal,
    )) {
    }
  } catch {}
  globalThis.fetch = origFetch2
  const replay = bodies[bodies.length - 1]
  const tc = replay.messages
    .find((m: any) => m.role === "assistant")
    ?.tool_calls?.find((t: any) => t.id === "call_1")
  expect(tc).toBeTruthy()
  expect(tc.extra_content).toEqual(sig)
  // arguments yang dikirim tidak mengandung kunci siluman
  expect(tc.function.arguments).toBe(JSON.stringify({ path: "a.txt" }))
})
