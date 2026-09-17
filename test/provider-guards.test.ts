// Hardening F-11/F-16: stream provider punya timeoutrequest dan text-cap;
// abort parent diteruskan apa adanya; properti (kind) dipertahankan.
import { expect, test } from "bun:test"
import { ProviderError } from "#minicore/core/errors.ts"
import type { ModelProvider, ProviderEvent, StreamRequest } from "#minicore/core/provider.ts"
import { withStreamGuards } from "../src/providers/guards.ts"

function base(over: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: "p",
    models: ["m"],
    async *stream(_req: StreamRequest, _sig: AbortSignal): AsyncIterable<ProviderEvent> {
      yield { type: "text", text: "hi" }
      yield { type: "finish", reason: "stop" }
    },
    ...over,
  }
}

async function collect(p: ModelProvider, signal?: AbortSignal): Promise<ProviderEvent[]> {
  const ac = signal ? undefined : new AbortController()
  const out: ProviderEvent[] = []
  for await (const ev of p.stream(
    { messages: [{ role: "user", content: "hi" }], model: "m" },
    (signal ?? ac!.signal) as AbortSignal,
  )) {
    out.push(ev)
  }
  return out
}

test("F-11: stream menggantung dibunuh timeout guard (klasifikasi server)", async () => {
  const hanging: ModelProvider = base({
    async *stream(_req: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      await new Promise<void>((_res, rej) => {
        signal.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")), {
          once: true,
        })
      })
      yield { type: "finish", reason: "stop" }
    },
  })
  const t0 = Date.now()
  let err: unknown = null
  try {
    await collect(withStreamGuards(hanging, { timeoutMs: 50 }))
  } catch (e) {
    err = e
  }
  expect(Date.now() - t0).toBeLessThan(5000)
  expect(err).toBeInstanceOf(ProviderError)
  expect((err as ProviderError).category).toBe("server")
  expect((err as Error).message).toContain("timed out")
})

test("F-11: abort parent diteruskan, bukan dikonversi", async () => {
  const hanging: ModelProvider = base({
    async *stream(_req: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      await new Promise<void>((_res, rej) => {
        signal.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")), {
          once: true,
        })
      })
      yield { type: "finish", reason: "stop" }
    },
  })
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(new Error("user stop")), 20)
  let err: unknown = null
  try {
    await collect(withStreamGuards(hanging, { timeoutMs: 5000 }), ctl.signal)
  } catch (e) {
    err = e
  }
  expect(err).not.toBeInstanceOf(ProviderError)
})

test("F-16: teks raksasa dipotong dengan marker, event lain utuh", async () => {
  const big: ModelProvider = base({
    async *stream(): AsyncIterable<ProviderEvent> {
      yield { type: "text", text: "a".repeat(10) }
      yield { type: "tool_call", id: "c1", name: "read_file", args: {} }
      yield { type: "text", text: "b".repeat(10) }
      yield { type: "text", text: "c".repeat(10) }
      yield { type: "finish", reason: "stop" }
    },
  })
  const evs = await collect(withStreamGuards(big, { maxTextChars: 25, timeoutMs: 5000 }))
  const texts = evs.filter((e) => e.type === "text").map((e) => (e as { text: string }).text)
  const joined = texts.join("")
  expect(joined).toContain("[provider text truncated")
  expect(joined.replace("\n… [provider text truncated: turn cap exceeded]", "").length).toBe(25)
  expect(evs.some((e) => e.type === "tool_call")).toBe(true)
  expect(evs.filter((e) => e.type === "finish").length).toBe(1)
})

test("guard mempertahankan kind + id + models + props ekstra", async () => {
  const src = { ...base(), kind: "responses", clearResponsesChain: () => {} }
  const w = withStreamGuards(src as unknown as ModelProvider)
  expect((w as unknown as { kind: string }).kind).toBe("responses")
  expect(typeof (w as unknown as { clearResponsesChain: unknown }).clearResponsesChain).toBe(
    "function",
  )
  expect(w.id).toBe("p")
  expect(w.models).toEqual(["m"])
  const evs = await collect(w)
  expect(evs.map((e) => e.type)).toEqual(["text", "finish"])
})
