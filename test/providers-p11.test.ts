// P11 P1: Responses adapter (fake SSE + chaining), probe responses,
// reasoningEffort mapping, dan retry-after yang dihonori. Hermetic: server
// HTTP lokal + stub fetch, tanpa jaringan.

import { afterAll, expect, test } from "bun:test"
import { ProviderError } from "#minicore/core/errors.ts"
import type { ModelProvider } from "#minicore/core/provider.ts"
import { mapReasoningToThinking } from "../src/providers/build.ts"
import { clearDetectCache, detectModels } from "../src/providers/detect.ts"
import { clearResponsesChain, createResponsesProvider } from "../src/providers/responses.ts"
import { createRouterProvider } from "../src/providers/router.ts"

const origFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = origFetch
  clearDetectCache()
  clearResponsesChain()
})

function sseBody(lines: string[]): string {
  return `${lines.map((l) => `data: ${l}`).join("\n")}\n\n`
}

async function collect(p: ModelProvider, model = "m"): Promise<string[]> {
  const out: string[] = []
  const ac = new AbortController()
  for await (const ev of p.stream(
    { messages: [{ role: "user", content: "hi" }], model },
    ac.signal,
  )) {
    if (ev.type === "text") out.push(ev.text)
  }
  return out
}

test("responses: teks mengalir + store:false + finish length eksplisit", async () => {
  clearResponsesChain()
  let seenBody = ""
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seenBody = await req.text()
      return new Response(
        sseBody([
          JSON.stringify({ type: "response.output_text.delta", delta: "halo " }),
          JSON.stringify({ type: "response.output_text.delta", delta: "dunia" }),
          JSON.stringify({ finish_reason: "length" }),
        ]),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    const p = createResponsesProvider({
      baseUrl: `http://127.0.0.1:${srv.port}/v1`,
      models: ["m"],
    })
    expect(await collect(p)).toEqual(["halo ", "dunia"])
    const body = JSON.parse(seenBody) as Record<string, unknown>
    expect(body.store).toBe(false)
    expect(body.model).toBe("m")
    expect("previous_response_id" in body).toBe(false)
  } finally {
    srv.stop(true)
  }
})

test("responses: reasoning summary delta menjadi extension reasoning", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        sseBody([
          JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "memeriksa" }),
          JSON.stringify({ type: "response.output_text.delta", delta: "jawaban" }),
        ]),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  try {
    const p = createResponsesProvider({
      baseUrl: `http://127.0.0.1:${srv.port}/v1`,
      models: ["m"],
    })
    const events: string[] = []
    const ac = new AbortController()
    for await (const ev of p.stream(
      { messages: [{ role: "user", content: "hi" }], model: "m" },
      ac.signal,
    )) {
      if (ev.type === "extension" && ev.kind === "reasoning") {
        events.push(`reasoning:${(ev.data as { text: string }).text}`)
      }
      if (ev.type === "text") events.push(`text:${ev.text}`)
    }
    expect(events).toEqual(["reasoning:memeriksa", "text:jawaban"])
  } finally {
    srv.stop(true)
  }
})

test("responses: previous_response_id dirantai dari completed id", async () => {
  clearResponsesChain()
  const bodies: string[] = []
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      bodies.push(await req.text())
      return new Response(
        sseBody([
          JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
          JSON.stringify({ type: "response.completed", response: { id: "resp_abc123" } }),
        ]),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    const p = createResponsesProvider({
      baseUrl: `http://127.0.0.1:${srv.port}/v1`,
      models: ["m"],
    })
    await collect(p)
    await collect(p)
    expect(bodies.length).toBe(2)
    const second = JSON.parse(bodies[1]!) as Record<string, unknown>
    expect(second.previous_response_id).toBe("resp_abc123")
  } finally {
    srv.stop(true)
  }
})

test("responses: 429 meneruskan retryAfterMs", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch: () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
  })
  try {
    const p = createResponsesProvider({
      baseUrl: `http://127.0.0.1:${srv.port}/v1`,
      models: ["m"],
    })
    let err: unknown = null
    try {
      await collect(p)
    } catch (e) {
      err = e
    }
    expect(err instanceof ProviderError).toBe(true)
    expect((err as ProviderError).category).toBe("rate_limit")
    expect((err as ProviderError).retryAfterMs).toBe(2000)
  } finally {
    srv.stop(true)
  }
})

test("responses: effort hanya untuk keluarga openai-reasoning", async () => {
  clearResponsesChain()
  const bodies: string[] = []
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      bodies.push(await req.text())
      return new Response(
        sseBody([JSON.stringify({ type: "response.output_text.delta", delta: "ok" })]),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    const p = createResponsesProvider({
      baseUrl: `http://127.0.0.1:${srv.port}/v1`,
      models: ["gpt-5.4", "mimo-v2.5-free"],
      reasoningEffort: "medium",
    })
    await collect(p, "gpt-5.4")
    await collect(p, "mimo-v2.5-free")
    const gpt = JSON.parse(bodies[0]!) as { reasoning?: { effort?: string } }
    const mimo = JSON.parse(bodies[1]!) as Record<string, unknown>
    expect(gpt.reasoning).toMatchObject({ effort: "medium" })
    expect("reasoning" in mimo).toBe(false)
  } finally {
    srv.stop(true)
  }
})

test("detect: path /responses → hint responses (wire dari probe)", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), {
      status: 200,
    })) as unknown as typeof fetch
  clearDetectCache()
  const r = await detectModels("https://api.openai.com/v1/responses", "k")
  expect(r.providerHint).toBe("responses")
  clearDetectCache()
  const r2 = await detectModels("https://api.anthropic.com/v1", "k")
  expect(r2.providerHint).toBe("anthropic")
})

test("reasoningEffort: low/medium/high → budget thinking, lain → undefined", () => {
  expect(mapReasoningToThinking("low")).toBe(1024)
  expect(mapReasoningToThinking("medium")).toBe(2048)
  expect(mapReasoningToThinking("high")).toBe(4096)
  expect(mapReasoningToThinking(undefined)).toBeUndefined()
  expect(mapReasoningToThinking("ultra" as string)).toBeUndefined()
})

function fakeStreamer(id: string, behavior: () => AsyncIterable<never>): ModelProvider {
  return {
    id,
    models: ["m"],
    async *stream(): AsyncIterable<never> {
      yield* behavior()
    },
  } as unknown as ModelProvider
}

// AsyncIterable yang langsung gagal — tanpa generator agar lint useYield
// tidak protes (generator tanpa yield adalah bau kode, bukan pola).
function thrower(e: unknown): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<never> {
      return {
        next: async () => {
          throw e
        },
      }
    },
  }
}

async function collectText(p: ModelProvider): Promise<string> {
  const ac = new AbortController()
  let out = ""
  for await (const ev of p.stream({ messages: [], model: "m" }, ac.signal)) {
    if (ev.type === "text") out += ev.text
  }
  return out
}

test("router: 429 + retryAfter → fallback DULU (jangan bakar sleep saat alternatif menganggur)", async () => {
  let callsA = 0
  const a: ModelProvider = {
    id: "a",
    models: ["m"],
    stream: () => {
      callsA++
      return thrower(new ProviderError("rate_limit", "slow", 30))
    },
  } as unknown as ModelProvider
  const b = fakeStreamer("b", async function* () {
    yield { type: "text", text: "dari-b" } as never
  })
  const r = createRouterProvider({ providers: [a, b] })
  const t0 = Date.now()
  expect(await collectText(r)).toBe("dari-b")
  // Audit #14: fallback instan ke b — A hanya dicoba sekali, tanpa menunggu
  // retry-after 30ms padahal b menganggur. Kode lama: tidur 30ms dulu, baru
  // fallback (test ini gagal di kode lama).
  expect(Date.now() - t0).toBeLessThan(25)
  expect(callsA).toBe(1)
})

test("router: provider tunggal 429 → tunggu-di-tempat sekali, lalu sukses", async () => {
  let calls = 0
  const text = (t: string) =>
    fakeStreamer("solo", async function* () {
      calls++
      if (calls === 1) throw new ProviderError("rate_limit", "slow", 20)
      yield { type: "text", text: t } as never
    })
  const r = createRouterProvider({ providers: [text("pulih")] })
  expect(await collectText(r)).toBe("pulih")
  expect(calls).toBe(2)
})

test("router: 429 ganda → menyerah (tidak loop selamanya)", async () => {
  const bad: ModelProvider = {
    id: "bad",
    models: ["m"],
    stream: () => thrower(new ProviderError("rate_limit", "slow", 10)),
  } as unknown as ModelProvider
  const r = createRouterProvider({ providers: [bad] })
  let err: unknown = null
  try {
    await collectText(r)
  } catch (e) {
    err = e
  }
  expect(err instanceof ProviderError).toBe(true)
})
