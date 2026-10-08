// P3.3 (N5) — Resume-seam integration test.
//
// Membuktikan integrasi PRODUKSI (bukan hanya unit selector): jalur resume nyata
// `createCliSession` memakai P3.3 selector dan meneruskan `canonicalFrontier`
// (N1), sehingga freshness DIHITUNG (bukan hard-code "fresh"). Test ini merah
// bila `canonicalFrontier` dihapus dari seam resume (lihat guard struktural).

import { expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliSession } from "../cli/setup.ts"
import { saveSession } from "../src/session/persistence.ts"

function wsWithConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p33-resume-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  writeFileSync(
    join(dir, ".minicode", "config.json"),
    JSON.stringify({
      providers: [{ id: "fake", baseUrl: "http://localhost:9", apiKey: "sk-test", models: ["m"] }],
    }),
    "utf8",
  )
  return dir
}

function baseOpts(cwd: string, extra: Record<string, unknown> = {}) {
  return {
    cwd,
    allowLocalConfig: true,
    sessionId: "",
    prompt: "hi",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
    ...extra,
  }
}

/** Tangkap baris `[select ...]` dari stderr selama resume. */
async function resumeCapture(
  cwd: string,
  sid: string,
): Promise<{ stderr: string; history: string[] }> {
  const chunks: string[] = []
  const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    chunks.push(a.map(String).join(" "))
  })
  let cli: Awaited<ReturnType<typeof createCliSession>> | null = null
  try {
    cli = await createCliSession(baseOpts(cwd, { resumeId: sid }))
    const history = cli.session.state.history.map((m) =>
      String((m as { content: unknown }).content),
    )
    return { stderr: chunks.join("\n"), history }
  } finally {
    spy.mockRestore()
    await cli?.close()
  }
}

test("N5-1: resume nyata memakai selector dan memuat histori lengkap", async () => {
  const cwd = wsWithConfig()
  await saveSession(
    "r1",
    cwd,
    undefined,
    [
      { role: "user", content: "A" },
      { role: "assistant", content: "B" },
      { role: "user", content: "C" },
    ],
    { turns: 2 },
  )
  const { stderr, history } = await resumeCapture(cwd, "r1")
  // Selector benar-benar jalan di jalur nyata (baris provenance muncul).
  expect(stderr).toContain("[select sid=r1")
  // Histori kanonik dimuat utuh (view full-history).
  expect(history).toEqual(["A", "B", "C"])
  // Freshness DIHITUNG (bukan kosong); untuk view==kanonis = fresh.
  expect(stderr).toMatch(/basis=full-history freshness=fresh head=2/)
})

test("N5-2: resume dengan proyeksi CURRENT → basis summary-plus-tail (freshness terhitung)", async () => {
  const cwd = wsWithConfig()
  await saveSession(
    "r2",
    cwd,
    undefined,
    [
      { role: "user", content: "A" },
      { role: "assistant", content: "B" },
      { role: "user", content: "C" },
      { role: "assistant", content: "D" },
    ],
    { turns: 2 },
  )
  // Bangun proyeksi CURRENT via API kanonik (bukan mock) — cakupan penuh.
  const { buildProjection, DEFAULT_THREAD_ID } = await import("../src/session/persistence.ts")
  buildProjection("r2", DEFAULT_THREAD_ID, "ringkas", cwd, { expectedEpoch: 0 })
  const { stderr, history } = await resumeCapture(cwd, "r2")
  expect(stderr).toContain("[select sid=r2")
  // Ringkasan proyeksi jadi pesan pertama + ekor kanonik.
  expect(history[0]).toContain("Previous context")
  expect(stderr).toMatch(/basis=summary-plus-tail/)
})

test("N5-3 (guard): seam resume MENERUSKAN canonicalFrontier ke selectContext", () => {
  // Guard struktural: bila `canonicalFrontier` dihapus dari seam, freshness
  // kembali hard-code "fresh" dan test ini gagal — mencegah regresi N1.
  const src = readFileSync(join(import.meta.dir, "..", "cli", "setup.ts"), "utf8")
  // Ada pemanggilan selectContext dengan canonicalFrontier di dekatnya.
  const idx = src.indexOf("selectContext({")
  expect(idx).toBeGreaterThan(-1)
  const window = src.slice(idx, idx + 600)
  expect(window).toContain("canonicalFrontier")
  // Frontier diturunkan dari P3.2 (bukan dikarang).
  expect(src).toContain("deriveFrontierFromDurable")
  expect(src).toContain("rowsToCanonicalRefs")
})
