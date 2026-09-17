// Hardening F-01/F-02/F-13: adapter Responses harus bisa menerima tool call,
// [DONE] harus menghasilkan finish (bukan failure), dan error non-konteks
// tidak boleh memicu compact-and-retry yang destruktif. Hermetic: Bun.serve
// lokal, tanpa jaringan.
import { afterAll, expect, test } from "bun:test"
import type { ProviderError } from "#minicore/core/errors.ts"
import type { ProviderEvent } from "#minicore/core/provider.ts"
import { clearResponsesChain, createResponsesProvider } from "../src/providers/responses.ts"

const origFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = origFetch
  clearResponsesChain()
})

function sseBody(lines: string[]): string {
  return `${lines.map((l) => `data: ${l}`).join("\n")}\n\n`
}

async function collectAll(baseUrl: string, model = "m"): Promise<ProviderEvent[]> {
  clearResponsesChain()
  const p = createResponsesProvider({ baseUrl, models: [model] })
  const ac = new AbortController()
  const out: ProviderEvent[] = []
  for await (const ev of p.stream(
    { messages: [{ role: "user", content: "hi" }], model },
    ac.signal,
  )) {
    out.push(ev)
  }
  return out
}

test("F-01: function_call via output_item.done menjadi kernel tool_call", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        sseBody([
          JSON.stringify({
            type: "response.output_item.added",
            item: { id: "item_1", type: "function_call", call_id: "call_1", name: "read_file" },
          }),
          JSON.stringify({
            type: "response.function_call_arguments.delta",
            item_id: "item_1",
            delta: '{"path"',
          }),
          JSON.stringify({
            type: "response.function_call_arguments.delta",
            item_id: "item_1",
            delta: ': "a.ts"}',
          }),
          JSON.stringify({
            type: "response.output_item.done",
            item: {
              id: "item_1",
              type: "function_call",
              call_id: "call_1",
              name: "read_file",
              arguments: '{"path": "a.ts"}',
            },
          }),
          JSON.stringify({ type: "response.completed", response: { id: "resp_1" } }),
        ]),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  try {
    const evs = await collectAll(`http://127.0.0.1:${srv.port}/v1`)
    const calls = evs.filter((e) => e.type === "tool_call")
    expect(calls.length).toBe(1)
    const c = calls[0] as unknown as { id: string; name: string; args: unknown }
    expect(c.id).toBe("call_1")
    expect(c.name).toBe("read_file")
    expect(c.args).toEqual({ path: "a.ts" })
    expect(evs.some((e) => e.type === "finish")).toBe(true)
  } finally {
    srv.stop(true)
  }
})

test("F-01: delta tanpa done tetap di-flush saat stream berakhir", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        sseBody([
          JSON.stringify({
            type: "response.output_item.added",
            item: { id: "item_9", type: "function_call", call_id: "call_9", name: "glob" },
          }),
          JSON.stringify({
            type: "response.function_call_arguments.delta",
            item_id: "item_9",
            delta: '{"pattern": "*.ts"}',
          }),
          JSON.stringify({ type: "response.completed", response: { id: "resp_9" } }),
        ]),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  try {
    const evs = await collectAll(`http://127.0.0.1:${srv.port}/v1`)
    const calls = evs.filter((e) => e.type === "tool_call")
    expect(calls.length).toBe(1)
    expect((calls[0] as unknown as { name: string }).name).toBe("glob")
  } finally {
    srv.stop(true)
  }
})

test("F-02: [DONE] tanpa finish menghasilkan finish stop, bukan failure", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hai" })}\n\ndata: [DONE]\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
  })
  try {
    const evs = await collectAll(`http://127.0.0.1:${srv.port}/v1`)
    const fin = evs.filter((e) => e.type === "finish")
    expect(fin.length).toBe(1)
    expect((fin[0] as unknown as { reason: string }).reason).toBe("stop")
  } finally {
    srv.stop(true)
  }
})

test("F-13: 400 invalid token BUKAN context_length_exceeded", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch: () => new Response("invalid token: unexpected ':' at line 1", { status: 400 }),
  })
  try {
    clearResponsesChain()
    const p = createResponsesProvider({ baseUrl: `http://127.0.0.1:${srv.port}/v1`, models: ["m"] })
    const ac = new AbortController()
    let cat = ""
    try {
      for await (const _ of p.stream(
        { messages: [{ role: "user", content: "hi" }], model: "m" },
        ac.signal,
      )) {
      }
    } catch (e) {
      cat = (e as ProviderError).category
    }
    expect(cat).not.toBe("context_length_exceeded")
  } finally {
    srv.stop(true)
  }
})

test("F-01: function_call setelah finish gagal keras (anti eksekusi ganda)", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        sseBody([
          JSON.stringify({ finish_reason: "stop" }),
          JSON.stringify({
            type: "response.output_item.done",
            item: {
              id: "late",
              type: "function_call",
              call_id: "late",
              name: "bash",
              arguments: "{}",
            },
          }),
        ]),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  try {
    clearResponsesChain()
    const p = createResponsesProvider({ baseUrl: `http://127.0.0.1:${srv.port}/v1`, models: ["m"] })
    const ac = new AbortController()
    let err = ""
    try {
      for await (const _ of p.stream(
        { messages: [{ role: "user", content: "hi" }], model: "m" },
        ac.signal,
      )) {
      }
    } catch (e) {
      err = (e as Error).message
    }
    expect(err).toContain("tool call after finish")
  } finally {
    srv.stop(true)
  }
})

test("F-13: 400 maximum context tetap context_length_exceeded", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch: () => new Response("maximum context length exceeded", { status: 400 }),
  })
  try {
    clearResponsesChain()
    const p = createResponsesProvider({ baseUrl: `http://127.0.0.1:${srv.port}/v1`, models: ["m"] })
    const ac = new AbortController()
    let cat = ""
    try {
      for await (const _ of p.stream(
        { messages: [{ role: "user", content: "hi" }], model: "m" },
        ac.signal,
      )) {
      }
    } catch (e) {
      cat = (e as ProviderError).category
    }
    expect(cat).toBe("context_length_exceeded")
  } finally {
    srv.stop(true)
  }
})
