import { afterEach, expect, test } from "bun:test"
import type { ModelProvider } from "#minicore/core/provider.ts"
import { createAnthropicProvider } from "../src/providers/anthropic.ts"
import { withStreamGuards } from "../src/providers/guards.ts"
import { createResponsesProvider } from "../src/providers/responses.ts"
import {
  appendToolArgument,
  boundedSseBody,
  parseProviderToolArguments,
  readProviderErrorBody,
} from "../src/providers/sse-bounds.ts"

const encoder = new TextEncoder()
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("provider SSE: rejects an oversized unterminated frame and cancels upstream", async () => {
  let cancelled = false
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data:123456789"))
    },
    cancel() {
      cancelled = true
    },
  })
  const reader = boundedSseBody(source, new AbortController().signal, "test", {
    maxFrameBytes: 8,
    maxTotalBytes: 100,
  }).getReader()

  await expect(reader.read()).rejects.toThrow(/frame exceeds 8 bytes/)
  expect(cancelled).toBe(true)
})

test("provider SSE: enforces total bytes across individually valid frames", async () => {
  let cancelled = false
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data:a\n\n"))
      controller.enqueue(encoder.encode("data:b\n\n"))
    },
    cancel() {
      cancelled = true
    },
  })
  const reader = boundedSseBody(source, new AbortController().signal, "test", {
    maxFrameBytes: 16,
    maxTotalBytes: 8,
  }).getReader()

  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data:a\n\n")
  await expect(reader.read()).rejects.toThrow(/stream exceeds 8 bytes/)
  expect(cancelled).toBe(true)
})

test("provider SSE: accepts fragmented valid UTF-8 frames within configured bounds", async () => {
  const bytes = encoder.encode("data: 🌱\n\n")
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 7))
      controller.enqueue(bytes.subarray(7))
      controller.close()
    },
  })
  const reader = boundedSseBody(source, new AbortController().signal, "test", {
    maxFrameBytes: 32,
    maxTotalBytes: 64,
  }).getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  expect(new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))).toBe(
    "data: 🌱\n\n",
  )
})

test("provider tool args: deltas and parallel pending calls share byte limits", () => {
  const bounds = { maxArgumentBytes: 5, maxPendingBytes: 7 }
  const first = appendToolArgument("", 0, "1234", 0, "test", bounds)
  expect(first).toMatchObject({ value: "1234", bytes: 4, pendingBytes: 4 })
  expect(() =>
    appendToolArgument(first.value, first.bytes, "56", first.pendingBytes, "test", bounds),
  ).toThrow(/tool arguments exceed 5 bytes/)
  expect(() => appendToolArgument("", 0, "abcd", first.pendingBytes, "test", bounds)).toThrow(
    /pending tool arguments exceed 7 bytes/,
  )
  expect(() => parseProviderToolArguments("{broken", "test")).toThrow(/malformed tool arguments/)
})

test("provider event guard: rejects oversized tool args and aborts its upstream", async () => {
  let upstreamSignal: AbortSignal | undefined
  const provider: ModelProvider = {
    id: "oversized-tool",
    models: ["m"],
    async *stream(_request, signal) {
      upstreamSignal = signal
      yield { type: "tool_call", id: "c1", name: "write_file", args: { content: "123456789" } }
    },
  }
  const guarded = withStreamGuards(provider, { maxToolArgBytes: 8, maxTotalToolArgBytes: 16 })
  await expect(
    (async () => {
      for await (const _event of guarded.stream(
        { messages: [{ role: "user", content: "write" }] },
        new AbortController().signal,
      )) {
        /* drain */
      }
    })(),
  ).rejects.toThrow(/tool arguments exceed configured byte limits/)
  expect(upstreamSignal?.aborted).toBe(true)
})

test("provider adapters reject malformed JSON frames instead of silently skipping them", async () => {
  globalThis.fetch = (async () =>
    new Response("data: {broken}\n\n", {
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch
  const responses = createResponsesProvider({
    baseUrl: "https://provider.invalid/v1",
    models: ["m"],
  })
  await expect(
    (async () => {
      for await (const _event of responses.stream(
        { messages: [{ role: "user", content: "hi" }], model: "m" },
        new AbortController().signal,
      )) {
        /* drain */
      }
    })(),
  ).rejects.toThrow(/malformed SSE JSON/)

  globalThis.fetch = (async () =>
    new Response("event: message_delta\ndata: {broken}\n\n", {
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch
  const anthropic = createAnthropicProvider({ apiKey: "test", models: ["m"] })
  await expect(
    (async () => {
      for await (const _event of anthropic.stream(
        { messages: [{ role: "user", content: "hi" }], model: "m" },
        new AbortController().signal,
      )) {
        /* drain */
      }
    })(),
  ).rejects.toThrow(/malformed SSE JSON/)
})

test("provider HTTP errors: reads only the diagnostic byte cap and cancels remainder", async () => {
  let cancelled = false
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(70_000).fill(0x61))
      },
      cancel() {
        cancelled = true
      },
    }),
    { status: 500 },
  )

  expect((await readProviderErrorBody(response)).length).toBe(65_536)
  expect(cancelled).toBe(true)
})
