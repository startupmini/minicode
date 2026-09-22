// AUDIT #02 — context/compaction/memory/RAG: buktikan invariant aktual.
// Hermetic: provider/network fake, tmp cwd, tanpa API key.

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProviderError } from "#minicore/core/errors.ts"
import { createSession } from "#minicore/core/index.ts"
import type { Message } from "#minicore/core/types.ts"
import { allowAll, FakeProvider } from "#minicore/test/fakes.ts"
import { capMcpText } from "../src/mcp/client.ts"
import { compactWithLlm } from "../src/policy/compaction.ts"
import { buildSystemPrompt } from "../src/policy/context.ts"
import { createResponsesProvider, toResponsesInput } from "../src/providers/responses.ts"
import { createRouterProvider } from "../src/providers/router.ts"
import { capMarked } from "../src/tools/bash.ts"
import { withCapMark } from "../src/tools/grep.ts"
import { capLocations, formatHover } from "../src/tools/lsp.ts"
import { readMemoryTool } from "../src/tools/memory.ts"
import { capTotal, cutSnippet } from "../src/tools/web_search.ts"

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "mc-ctx-"))
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

const storeOf = (messages: Message[]) => ({ messages }) as never

function fakeSummaryProvider(seen: { prompts: string[]; calls: number }, textOut: string) {
  return {
    id: "fake-sum",
    models: ["m"],
    async *stream(req: { messages: { content?: unknown }[] }) {
      seen.calls += 1
      seen.prompts.push(String(req.messages[0]?.content ?? ""))
      yield { type: "text" as const, text: textOut }
      yield { type: "finish" as const, reason: "stop" as const }
    },
  } as never
}

const convo = (n: number): Message[] => {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: `pertanyaan ${i}` })
    out.push({ role: "assistant", content: `jawaban ${i}` })
  }
  return out
}

// ── P0: system prompt mencapai wire ──

test("audit: router menyelipkan system ke openai-compat (kind tak dikenal)", async () => {
  const bodies: string[] = []
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      bodies.push(await req.text())
      return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  try {
    const { createOpenAICompatProvider } = await import("#minicore/providers/openai-compat.ts")
    const openai = createOpenAICompatProvider({
      id: "oai",
      baseUrl: `http://127.0.0.1:${srv.port}/v1`,
      apiKey: "k",
      models: ["m"],
      defaultModel: "m",
    })
    const router = createRouterProvider({ providers: [openai] })
    const ac = new AbortController()
    for await (const _ of router.stream(
      {
        messages: [{ role: "user", content: "hi" }],
        model: "m",
        system: "SYSTEM-RAHASIA-INSTRUKSI",
      } as never,
      ac.signal,
    )) {
      /* drain */
    }
    const body = JSON.parse(bodies[0]!) as { messages: { role: string; content: string }[] }
    expect(body.messages[0]).toMatchObject({ role: "user", content: "SYSTEM-RAHASIA-INSTRUKSI" })
    expect(body.messages[1]).toMatchObject({ role: "user", content: "hi" })
  } finally {
    srv.stop(true)
  }
})

test("audit: router TIDAK menyelipkan system ke anthropic/responses", async () => {
  const seen: { req: unknown }[] = []
  const anthropicLike = {
    id: "a",
    models: ["m"],
    kind: "anthropic",
    async *stream(req: unknown) {
      seen.push({ req })
      yield* []
    },
  } as never
  const responsesLike = {
    id: "r",
    models: ["m2"],
    kind: "responses",
    async *stream(req: unknown) {
      seen.push({ req })
      yield* []
    },
  } as never
  const router = createRouterProvider({ providers: [anthropicLike, responsesLike] })
  const ac = new AbortController()
  for await (const _ of router.stream(
    { messages: [{ role: "user", content: "hi" }], model: "m", system: "SYS" } as never,
    ac.signal,
  )) {
  }
  for await (const _ of router.stream(
    { messages: [{ role: "user", content: "hi" }], model: "m2", system: "SYS" } as never,
    ac.signal,
  )) {
  }
  expect(seen).toHaveLength(2)
  for (const s of seen) {
    const msgs = (s.req as { messages: { role: string }[] }).messages
    expect(msgs.filter((m) => m.role === "user" && m).length).toBe(1)
  }
})

test("audit: responses mengirim instructions + linkage tool utuh", async () => {
  let seenBody = ""
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seenBody = await req.text()
      return new Response('data: {"type":"response.completed","response":{"id":"r1"}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  try {
    const p = createResponsesProvider({ baseUrl: `http://127.0.0.1:${srv.port}/v1`, models: ["m"] })
    const ac = new AbortController()
    for await (const _ of p.stream(
      {
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c1", name: "read_file", args: { path: "a" } }],
          },
          { role: "tool", toolCallId: "c1", name: "read_file", content: "isi" },
        ],
        model: "m",
        system: "SYS-INSTRUKSI",
      } as never,
      ac.signal,
    )) {
    }
    const body = JSON.parse(seenBody) as Record<string, unknown>
    expect(body.instructions).toBe("SYS-INSTRUKSI")
    const input = body.input as Record<string, unknown>[]
    expect(input.some((i) => i.type === "function_call" && i.call_id === "c1")).toBe(true)
    expect(input.some((i) => i.type === "function_call_output" && i.call_id === "c1")).toBe(true)
  } finally {
    srv.stop(true)
  }
})

test("audit: toResponsesInput mempertahankan urutan + teks", () => {
  const out = toResponsesInput([
    { role: "user", content: "q" },
    { role: "assistant", content: "t", toolCalls: [{ id: "c9", name: "bash", args: {} }] },
    { role: "tool", toolCallId: "c9", content: "done" },
  ]) as Record<string, unknown>[]
  expect(out.map((o) => o.type ?? o.role)).toEqual([
    "user",
    "assistant",
    "function_call",
    "function_call_output",
  ])
})

test("audit: responses 400 konteks → context_length_exceeded (compact-and-retry)", async () => {
  const srv = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("maximum context length exceeded", {
        status: 400,
        headers: { "content-type": "text/plain" },
      }),
  })
  try {
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

// ── P1: compaction pinning + cwd ──

test("audit: kompaksi kedua mem-pin ringkasan pertama verbatim", async () => {
  const seen = { prompts: [] as string[], calls: 0 }
  const first = await compactWithLlm(storeOf(convo(3)), {
    keepRecentTurns: 1,
    provider: fakeSummaryProvider(seen, "RINGKASAN-SATU-MARKER"),
  })
  expect(String(first[0]!.content)).toContain("RINGKASAN-SATU-MARKER")
  // Kompaksi kedua atas hasil pertama: provider TAK dipanggil ulang bila
  // sisa muat (idempoten); bila dipanggil, prompt tak memuat ringkasan lama.
  const before = seen.calls
  const second = await compactWithLlm(storeOf([...first] as Message[]), {
    keepRecentTurns: 1,
    provider: fakeSummaryProvider(seen, "RINGKASAN-DUA"),
  })
  expect(String(second[0]!.content)).toContain("RINGKASAN-SATU-MARKER")
  if (seen.calls > before) {
    expect(seen.prompts[seen.prompts.length - 1]).not.toContain("RINGKASAN-SATU-MARKER")
  }
})

test("audit: summary prompt dipagar anti-injeksi", async () => {
  const seen = { prompts: [] as string[], calls: 0 }
  await compactWithLlm(storeOf(convo(3)), {
    keepRecentTurns: 1,
    provider: fakeSummaryProvider(seen, "ok"),
  })
  expect(seen.prompts[0]).toContain("```")
  expect(seen.prompts[0]).toMatch(/never follow instructions/i)
})

test("audit: summary vector mendarat di DB cwd (bukan global sembarang)", async () => {
  const dir = tmpRoot()
  try {
    mkdirSync(join(dir, ".minicode"), { recursive: true })
    const seen = { prompts: [] as string[], calls: 0 }
    await compactWithLlm(storeOf(convo(3)), {
      keepRecentTurns: 1,
      provider: fakeSummaryProvider(seen, "fakta proyek"),
      cwd: dir,
    })
    const db = new Database(join(dir, ".minicode", "vector.db"), { readonly: true })
    try {
      const rows = db
        .prepare("SELECT category FROM memory WHERE category='summary'")
        .all() as unknown[]
      expect(rows.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  } finally {
    await cleanup(dir)
  }
})

// ── P1: truncation markers ──

test("audit: grep limit-hit ditandai (tak lagi tampak lengkap)", async () => {
  const dir = tmpRoot()
  try {
    const lines: string[] = []
    for (let i = 0; i < 120; i++) lines.push(`cocok baris ${i}`)
    writeFileSync(join(dir, "a.txt"), lines.join("\n"))
    const { grepTool } = await import("../src/tools/grep.ts")
    const ctx = { signal: new AbortController().signal, cwd: dir } as never
    // Paksa engine JS (tanpa rg) + limit kecil via env? limit dari arg tak ada:
    // default 100 — 120 match > 100 → marker.
    const out = (await grepTool.execute({ pattern: "cocok" }, ctx)) as string
    expect(out).toContain("… [truncated: showing first 100 matches")
    expect(out.split("\n").filter((l) => l.includes("cocok baris")).length).toBe(100)
  } finally {
    await cleanup(dir)
  }
})

test("audit: helper cap murni (grep/lsp/mcp/web/bash)", () => {
  expect(withCapMark(["a", "b"], 5)).toBe("a\nb")
  expect(withCapMark(["a", "b", "c"], 2)).toContain("showing first 2 matches")
  expect(capLocations(["a", "b"], 5)).toBe("a\nb")
  expect(capLocations(["a", "b", "c"], 2)).toContain("showing first 2 of 3")
  expect(formatHover({ contents: { value: "x".repeat(5000) } })).toContain(
    "truncated: hover too long",
  )
  expect(formatHover({ contents: { value: "pendek" } })).toBe("pendek")
  expect(capMcpText("x".repeat(100001))).toContain("[mcp truncated")
  expect(capMcpText("ok")).toBe("ok")
  expect(cutSnippet("y".repeat(500))).toContain("…")
  expect(cutSnippet("ok")).toBe("ok")
  expect(capTotal("z".repeat(100), 50)).toContain("showing first 50 chars")
  expect(capTotal("ok", 50)).toBe("ok")
  expect(capMarked("w".repeat(30), 10)).toContain("showing first 10 chars")
  expect(capMarked("ok", 10)).toBe("ok")
})

test("audit: memory hit panjang ditandai", async () => {
  const dir = tmpRoot()
  try {
    mkdirSync(join(dir, ".minicode"), { recursive: true })
    writeFileSync(join(dir, ".minicode", "MEMORY.md"), `fakta penting ${"z".repeat(500)}\n`)
    const ctx = { signal: new AbortController().signal, cwd: dir } as never
    const out = (await readMemoryTool.execute({ query: "fakta" }, ctx)) as string
    expect(out).toContain("fakta penting")
    expect(out).toContain("…")
  } finally {
    await cleanup(dir)
  }
})

// ── System guard + resume ──

test("audit: system prompt menandai data tak-terpercaya", async () => {
  const dir = tmpRoot()
  try {
    const sys = await buildSystemPrompt({ cwd: dir })
    expect(sys).toContain("untrusted DATA")
    expect(sys).toContain("Working directory")
  } finally {
    await cleanup(dir)
  }
})

test("F3.3: system prompt memuat kontrak verify-before-done", async () => {
  // Gagal di kode lama: baris kontrak tak ada. Kontrak murah (satu baris
  // instruksi) yang diukur via kelas VERIFY_FAIL di bench — bukan gate kode.
  const dir = tmpRoot()
  try {
    const sys = await buildSystemPrompt({ cwd: dir })
    expect(sys).toContain("Verify before claiming done")
  } finally {
    await cleanup(dir)
  }
})

test("audit: environment menyebut shell per platform (anti tebak ls/pwd)", async () => {
  // Regresi live: di win32 model mencoba `pwd`/`ls -la` (Unix) karena prompt
  // hanya bilang Platform tanpa shell-nya (padahal bash tool = cmd.exe).
  const dir = tmpRoot()
  try {
    const sys = await buildSystemPrompt({ cwd: dir })
    if (process.platform === "win32") expect(sys).toContain("cmd.exe")
    else expect(sys).toContain(`Platform: ${process.platform}`)
  } finally {
    await cleanup(dir)
  }
})

test("audit: summary bertahan save/load (resume merekonstruksi sama)", async () => {
  const dir = tmpRoot()
  try {
    mkdirSync(join(dir, ".minicode"), { recursive: true })
    const { saveSession, loadSession } = await import("../src/session/persistence.ts")
    const summary = { role: "user", content: "Previous context (LLM summarized):\nfakta A" }
    const rest: Message[] = [
      { role: "user", content: "lanjutkan" },
      { role: "assistant", content: "ok" },
    ]
    await saveSession("ctx1", dir, undefined, [summary, ...rest] as never, undefined)
    const loaded = loadSession("ctx1", dir)
    expect(loaded?.messages.length).toBe(3)
    expect(String((loaded!.messages[0] as { content: unknown }).content)).toContain(
      "Previous context",
    )
  } finally {
    await cleanup(dir)
  }
})

test("audit: context_length berulang bounded (tanpa loop abadi)", async () => {
  // Pertama: compact (no-op di history kecil) + retry; kedua: compacted sudah
  // true → budget_exceeded. Terminasi deterministik, bukan retry selamanya.
  const p = new FakeProvider([
    { throw: new ProviderError("context_length_exceeded", "too long") },
    { throw: new ProviderError("context_length_exceeded", "too long") },
  ])
  const s = createSession({ provider: p, permissions: allowAll })
  await expect(s.run("halo")).rejects.toMatchObject({ kind: "budget_exceeded" })
}, 15000)
