// Budget total embedding (audit ronde 2 W10): endpoint lambat-menjawab tak
// boleh menahan RAG setup ~21 dtk (6 attempt × 3,5 dtk). Lewat budget total =
// fallback keyword, bukan hang.
//
// Hermetic: IP literal 8.8.8.8 melewati cek DNS tanpa network
// (isPrivateHostWithDns short-circuit untuk /^[\d.]+$/); fetch di-stub.

import { afterEach, describe, expect, test } from "bun:test"
import { embedTexts } from "../src/memory/vector.ts"

const origFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = origFetch
})

describe("embedTexts budget total", () => {
  test("fetch gantung selamanya → null saat budget total habis (bukan 6× attempt)", async () => {
    // Stub meniru endpoint lambat yang patuh abort (seperti fetch asli):
    // pending sampai signal abort, lalu menolak.
    globalThis.fetch = ((_url: unknown, opts?: { signal?: AbortSignal }) => {
      // Hindari unhandled rejection bila abort datang tanpa await aktif.
      const p = new Promise<never>((_, rej) => {
        opts?.signal?.addEventListener("abort", () =>
          rej(new DOMException("The operation timed out.", "TimeoutError")),
        )
      })
      p.catch(() => {})
      return p
    }) as unknown as typeof fetch
    const t0 = Date.now()
    // attempt 200ms × 6 = 1200ms+ di kode lama; budget 300ms di kode baru.
    const r = await embedTexts("http://8.8.8.8/v1", "k", ["halo"], undefined, {
      attemptMs: 200,
      totalMs: 300,
    })
    expect(r).toBeNull()
    expect(Date.now() - t0).toBeLessThan(900)
  })

  test("jalur sukses tak diputus budget (200 cepat → vektor)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
        status: 200,
      })) as unknown as typeof fetch
    const r = await embedTexts("http://8.8.8.8/v1", "k", ["halo"], undefined, {
      attemptMs: 2000,
      totalMs: 5000,
    })
    expect(r).toEqual([[0.1, 0.2]])
  })
})
