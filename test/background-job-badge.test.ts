// Badge job background (v0.24) — dua bagian:
//   1. `onBackgroundJobFinished` (src/tools/bash.ts) mengumumkan selesainya
//      job TEPAT SEKALI (error + close tidak boleh emit dua kali).
//   2. `waitingGlyph` (src/ui/footer.ts) merender badge `◷ N` monokrom dengan
//      fallback ASCII `[BG:n]`, nol bila tak ada job.
//
// Efek samping lintas-proses: bagian 1 men-spawn child sungguhan (echo), sama
// pola `test/f03-job-ownership.test.ts`. Bagian 2 murni render (deterministik).
import { afterEach, describe, expect, test } from "bun:test"
import type { Tool, ToolContext } from "#minicore"
import {
  createBashJobTools,
  killAllBackgroundJobs,
  listBackgroundJobs,
  onBackgroundJobFinished,
} from "../src/tools/bash.ts"
import { waitingGlyph } from "../src/ui/footer.ts"

const ctx = {
  signal: new AbortController().signal,
  cwd: process.cwd(),
  emit() {},
} as unknown as ToolContext

afterEach(() => {
  killAllBackgroundJobs()
})

async function waitUntil(cond: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await Bun.sleep(20)
  }
  return cond()
}

async function startBg(bash: Tool, cmd: string): Promise<string> {
  const r = (await bash.execute({ cmd, background: true }, ctx)) as string
  const id = /(bg_[0-9a-f]+)/.exec(r)?.[1]
  if (!id) throw new Error(`job id tidak ada di output: ${r}`)
  return id
}

describe("onBackgroundJobFinished (event selesai job)", () => {
  test("emit sekali saat job selesai, dengan id + exit code", async () => {
    const { bash } = createBashJobTools("badge-emit")
    const seen: { id: string; code: number | null }[] = []
    const unsub = onBackgroundJobFinished((id, code) => seen.push({ id, code }))
    try {
      const id = await startBg(bash, "echo badge-ok")
      const ok = await waitUntil(() => seen.length > 0, 15_000)
      expect(ok).toBe(true)
      expect(seen.length).toBe(1)
      expect(seen[0]!.id).toBe(id)
      expect(seen[0]!.code).toBe(0)
      // Error (kalau ada) tak menyusul sebagai emit kedua — close sudah emit.
      await waitUntil(() => listBackgroundJobs().find((j) => j.id === id)?.done === true)
      await Bun.sleep(30)
      expect(seen.length).toBe(1)
    } finally {
      unsub()
    }
  })

  test("unsubscribe idempoten: setelah lepas, tak ada emit lagi", async () => {
    const { bash } = createBashJobTools("badge-unsub")
    let fired = false
    const unsub = onBackgroundJobFinished(() => {
      fired = true
    })
    unsub()
    unsub() // idempoten, bukan error
    await startBg(bash, "echo badge-none")
    await waitUntil(() => listBackgroundJobs().some((j) => j.done))
    expect(fired).toBe(false)
  })
})

describe("waitingGlyph (badge ◷ N)", () => {
  test("nol job = string kosong; >=1 = glyph + angka menempel", () => {
    expect(waitingGlyph(0)).toBe("")
    expect(waitingGlyph(-1)).toBe("")
    expect(waitingGlyph(1)).toBe("◷ 1")
    expect(waitingGlyph(3)).toBe("◷ 3")
  })

  test("frame memutar glyph", () => {
    const glyphs = new Set(["◷", "◶", "◵", "◴"])
    for (let f = 0; f < 12; f++) {
      const out = waitingGlyph(1, f)
      const g = out[0]
      expect(glyphs.has(g!)).toBe(true)
      expect(out).toContain("1")
    }
    // Dua frame berurutan beda glyph.
    expect(waitingGlyph(1, 0)).not.toBe(waitingGlyph(1, 1))
  })
})
