// Warisan sub-agen dari sesi parent (audit #14): model yang sama, limiter
// bersama, dan default provider yang dihormati. Sebelumnya anak diam-diam
// memakai default router (beda kapabilitas/harga) + limiter sendiri
// (bisa memicu 429 yang baru dihindari parent).

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RateLimiter } from "../src/policy/ratelimit.ts"
import { saveProvider } from "../src/providers/provision.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  getSubAgentProvider,
  setSubAgentParentRouting,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
  clearSubAgentSessionFactory()
})

const sse = (text: string) =>
  new Response(
    `data: {"choices":[{"delta":{"content":"${text}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ) as unknown as Response

async function seedProviders(): Promise<void> {
  // MINICODE_HOME wajib aktif saat dipanggil (ditentukan pemanggil).
  await saveProvider(
    { id: "pa", baseUrl: "http://pa.test/v1", apiKey: "k", models: ["m"] },
    { global: true },
  )
  await saveProvider(
    { id: "pb", baseUrl: "http://pb.test/v1", apiKey: "k", models: ["m"] },
    { global: true },
  )
}

// Kumpulkan semua teks dari event stream apa pun bentuknya.
async function collectAll(router: {
  stream(req: unknown, signal: AbortSignal): AsyncIterable<unknown>
}): Promise<string> {
  const ac = new AbortController()
  const parts: string[] = []
  for await (const ev of router.stream({ messages: [] }, ac.signal)) {
    const t = ev as { type?: string; text?: unknown; data?: unknown }
    if (t.type === "text" && typeof t.text === "string") parts.push(t.text)
    else if (t.data && typeof (t.data as { text?: unknown }).text === "string")
      parts.push((t.data as { text: string }).text)
    else parts.push(JSON.stringify(ev))
  }
  return parts.join("")
}

describe("sub-agent mewarisi model parent", () => {
  test("spec.model = model sesi parent (live via ToolContext)", async () => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-hermetic"
    let seen: { model?: string } | undefined
    setSubAgentSessionFactory(async (spec) => {
      seen = spec
      return {
        events: { on: () => () => {} },
        run: async () => ({ finalText: "ok", usage: { steps: 1 } }),
      }
    })
    const ctx = {
      signal: new AbortController().signal,
      emit: () => {},
      state: { model: "prov::m1" },
    } as never
    await delegateTaskTool.execute({ prompt: "x" }, ctx)
    // Kode lama: spec tak punya model (anak pakai default router).
    expect(seen?.model).toBe("prov::m1")
  })

  test("tanpa model di state → spec.model absen (factory lama tetap jalan)", async () => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-hermetic"
    let seen: { model?: string } | undefined
    setSubAgentSessionFactory(async (spec) => {
      seen = spec
      return {
        events: { on: () => () => {} },
        run: async () => ({ finalText: "ok", usage: { steps: 1 } }),
      }
    })
    const ctx = { signal: new AbortController().signal, emit: () => {} } as never
    await delegateTaskTool.execute({ prompt: "x" }, ctx)
    expect(seen?.model).toBeUndefined()
  })
})

describe("sub-agent mewarisi routing parent", () => {
  test("defaultProviderId mengarahkan bare request ke provider parent", async () => {
    const home = mkdtempSync(join(tmpdir(), "mc-subinh-"))
    const prev = process.env.MINICODE_HOME
    process.env.MINICODE_HOME = home
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async (url: unknown) => {
      const u = String(url)
      return sse(u.includes("pb.test") ? "dari-b" : "dari-a")
    }) as unknown as typeof fetch
    try {
      await seedProviders()
      setSubAgentParentRouting({ defaultProviderId: "pb" })
      const router = await getSubAgentProvider()
      // Tanpa model = pakai default router. Kode lama: defaultProviderId
      // diabaikan → rute ke pa ("dari-a").
      const text = await collectAll(router)
      expect(text).toContain("dari-b")
    } finally {
      globalThis.fetch = origFetch
      if (prev === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("limiter bersama dipakai router anak (satu bucket)", async () => {
    const home = mkdtempSync(join(tmpdir(), "mc-sublim-"))
    const prev = process.env.MINICODE_HOME
    process.env.MINICODE_HOME = home
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async () =>
      sse("ok")) as unknown as typeof fetch
    let acquires = 0
    const spy = { acquire: async () => acquires++ } as unknown as RateLimiter
    try {
      await seedProviders()
      setSubAgentParentRouting({ rateLimiter: spy })
      const router = await getSubAgentProvider()
      await collectAll(router)
      // Kode lama: limiter parent tak diteruskan → acquire tak pernah dipanggil.
      expect(acquires).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = origFetch
      if (prev === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("clearSubAgentSessionFactory me-reset routing warisan", async () => {
    const home = mkdtempSync(join(tmpdir(), "mc-subclr-"))
    const prev = process.env.MINICODE_HOME
    process.env.MINICODE_HOME = home
    ;(globalThis as unknown as { fetch: unknown }).fetch = (async (url: unknown) => {
      const u = String(url)
      return sse(u.includes("pb.test") ? "dari-b" : "dari-a")
    }) as unknown as typeof fetch
    try {
      await seedProviders()
      setSubAgentParentRouting({ defaultProviderId: "pb" })
      clearSubAgentSessionFactory()
      const router = await getSubAgentProvider()
      const text = await collectAll(router)
      expect(text).toContain("dari-a")
    } finally {
      globalThis.fetch = origFetch
      if (prev === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("sub-agent mewarisi mode allowlist parent", () => {
  // Parent allowlist melahirkan anak `auto` = shell anak lebih longgar dari
  // parent (inkonsistensi). plan/readonly tetap dipaksa explore (mode alat).
  test("parent allowlist → spec.permissionMode allowlist", async () => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-hermetic"
    let seen: { permissionMode?: string } | undefined
    setSubAgentSessionFactory(async (spec) => {
      seen = spec
      return {
        events: { on: () => () => {} },
        run: async () => ({ finalText: "ok", usage: { steps: 1 } }),
      }
    })
    const ctx = {
      signal: new AbortController().signal,
      emit: () => {},
      state: { model: "prov::m1" },
      permissionMode: "allowlist",
    } as never
    await delegateTaskTool.execute({ prompt: "x" }, ctx)
    expect(seen?.permissionMode).toBe("allowlist")
  })

  test("parent auto → spec.permissionMode tetap auto", async () => {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-hermetic"
    let seen: { permissionMode?: string } | undefined
    setSubAgentSessionFactory(async (spec) => {
      seen = spec
      return {
        events: { on: () => () => {} },
        run: async () => ({ finalText: "ok", usage: { steps: 1 } }),
      }
    })
    const ctx = {
      signal: new AbortController().signal,
      emit: () => {},
      state: { model: "prov::m1" },
    } as never
    await delegateTaskTool.execute({ prompt: "x" }, ctx)
    expect(seen?.permissionMode).toBe("auto")
  })
})
