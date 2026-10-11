// F-03 (P5 §C2) — Background bash job diikat sid kanonik pemiliknya.
//
// Meliputi: akses sesi yang sama (A), penolakan inspect/cancel lintas-sesi
// dengan pesan identik "tidak dikenal" non-disclosing (B, C), dua sesi
// produksi dalam satu proses (D), tanpa enumerasi id asing (E), lifecycle
// lintas pemilik (F), kompatibilitas mundur instans default (G), serta wiring
// composition root via setupToolLayer(jobOwnerSid) dan createCliSession.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Tool, ToolContext } from "#minicore"
import { createCliSession } from "../cli/setup.ts"
import { setupToolLayer } from "../src/app/tool-layer.ts"
import type { MinicodeConfig } from "../src/config.ts"
import {
  bashOutputTool,
  bashTool,
  createBashJobTools,
  killAllBackgroundJobs,
  listBackgroundJobs,
} from "../src/tools/bash.ts"

const ctx = { signal: new AbortController().signal, emit() {} } as unknown as ToolContext
const isWin = process.platform === "win32"
const echoCmd = "echo halo-f03"
const sleepCmd = isWin ? "ping -n 30 127.0.0.1" : "sleep 30"

afterEach(() => {
  killAllBackgroundJobs()
})

// Pola polling ber-deadline dari phase1 (mekanisme, bukan kecepatan spawn).
async function waitUntil(cond: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await Bun.sleep(25)
  }
  return cond()
}

async function startBg(bash: Tool, cmd: string): Promise<string> {
  const r = (await bash.execute({ cmd, background: true }, ctx)) as string
  const id = /(bg_[0-9a-f]+)/.exec(r)?.[1]
  if (!id) throw new Error(`job id tidak ada di output: ${r}`)
  return id
}

async function errMsg(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => "",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  )
}

describe("F-03 factory ownership", () => {
  test("A: sesi yang sama boleh baca job miliknya sendiri", async () => {
    const { bash, bashOutput } = createBashJobTools("f03-a")
    const id = await startBg(bash, echoCmd)
    const ok = await waitUntil(() => listBackgroundJobs().find((j) => j.id === id)?.done === true)
    expect(ok).toBe(true)
    expect((await bashOutput.execute({ id }, ctx)) as string).toContain("halo-f03")
  })

  test("B: sesi lain ditolak inspect — pesan identik dengan id tak dikenal", async () => {
    const A = createBashJobTools("f03-b-a")
    const B = createBashJobTools("f03-b-b")
    const id = await startBg(A.bash, echoCmd)
    const msgForeign = await errMsg(B.bashOutput.execute({ id }, ctx))
    expect(msgForeign).toBe(`job "${id}" not found`)
    const msgUnknown = await errMsg(B.bashOutput.execute({ id: "bg_00000000" }, ctx))
    expect(msgForeign).toBe(msgUnknown.replace("bg_00000000", id))
    // Tak ada potongan output/status milik A yang bocor ke B.
    expect(msgForeign).not.toContain("halo-f03")
    expect(msgForeign).not.toContain("running")
    expect(msgForeign).not.toContain("finished")
    // A tetap sah atas job yang sama.
    const ok = await waitUntil(() => listBackgroundJobs().find((j) => j.id === id)?.done === true)
    expect(ok).toBe(true)
    expect((await A.bashOutput.execute({ id }, ctx)) as string).toContain("halo-f03")
  })

  test("C: sesi lain ditolak kill — job tetap hidup, pemilik tetap bisa kill", async () => {
    const A = createBashJobTools("f03-c-a")
    const B = createBashJobTools("f03-c-b")
    const id = await startBg(A.bash, sleepCmd)
    const msg = await errMsg(B.bashKill.execute({ id }, ctx))
    expect(msg).toBe(`job "${id}" not found`)
    expect(listBackgroundJobs().find((j) => j.id === id)?.done).toBe(false)
    // A masih bisa ambil output running — percobaan B tak membunuh job.
    expect((await A.bashOutput.execute({ id }, ctx)) as string).toContain("running")
    expect((await A.bashKill.execute({ id }, ctx)) as string).toContain("stopped")
  })

  test("E: pesan not-found men-daftar HANYA id milik pemanggil", async () => {
    const A = createBashJobTools("f03-e-a")
    const B = createBashJobTools("f03-e-b")
    const idA1 = await startBg(A.bash, sleepCmd)
    const idA2 = await startBg(A.bash, sleepCmd)
    const idB1 = await startBg(B.bash, sleepCmd)
    const msgB = await errMsg(B.bashOutput.execute({ id: "bg_00000000" }, ctx))
    expect(msgB).toContain(idB1)
    expect(msgB).not.toContain(idA1)
    expect(msgB).not.toContain(idA2)
    const msgA = await errMsg(A.bashOutput.execute({ id: "bg_00000000" }, ctx))
    expect(msgA).toContain(idA1)
    expect(msgA).toContain(idA2)
    expect(msgA).not.toContain(idB1)
  })

  test("F: killAllBackgroundJobs tetap pembersih level-proses lintas pemilik", async () => {
    const A = createBashJobTools("f03-f-a")
    const B = createBashJobTools("f03-f-b")
    await startBg(A.bash, sleepCmd)
    await startBg(B.bash, sleepCmd)
    expect(listBackgroundJobs().length).toBe(2)
    killAllBackgroundJobs()
    expect(listBackgroundJobs().length).toBe(0)
  })

  test("G: instans default (tanpa sid) kompatibel lama — null==null", async () => {
    const id = await startBg(bashTool, echoCmd)
    const ok = await waitUntil(() => listBackgroundJobs().find((j) => j.id === id)?.done === true)
    expect(ok).toBe(true)
    expect((await bashOutputTool.execute({ id }, ctx)) as string).toContain("halo-f03")
  })

  test("G: createBashJobTools menolak sid kosong (fail-closed)", () => {
    expect(() => createBashJobTools("")).toThrow(/non-empty/)
  })
})

describe("F-03 wiring composition root (tool-layer)", () => {
  test("jobOwnerSid mengikat instance; tanpa param tetap instance default", async () => {
    const cfg = {} as MinicodeConfig
    const bound = await setupToolLayer(cfg, "full", undefined, undefined, "f03-tl-a")
    const bashBound = bound.sessionTools.find((t) => t.name === "bash")
    const outBound = bound.sessionTools.find((t) => t.name === "bash_output")
    expect(bashBound).toBeTruthy()
    expect(outBound).toBeTruthy()
    expect(bashBound).not.toBe(bashTool)
    const unbound = await setupToolLayer(cfg)
    expect(unbound.sessionTools.find((t) => t.name === "bash")).toBe(bashTool)
    // Enforcement lewat instance hasil wiring: pemilik boleh, sid lain ditolak.
    const id = await startBg(bashBound as Tool, echoCmd)
    const other = createBashJobTools("f03-tl-b")
    expect(await errMsg(other.bashOutput.execute({ id }, ctx))).toBe(`job "${id}" not found`)
    const ok = await waitUntil(() => listBackgroundJobs().find((j) => j.id === id)?.done === true)
    expect(ok).toBe(true)
    expect((await (outBound as Tool).execute({ id }, ctx)) as string).toContain("halo-f03")
  })
})

describe("F-03 dua CliSession dalam satu proses (jalur produksi)", () => {
  function ws(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-f03-"))
    mkdirSync(join(dir, ".minicode"), { recursive: true })
    writeFileSync(
      join(dir, ".minicode", "config.json"),
      JSON.stringify({
        providers: [
          { id: "fake", baseUrl: "http://localhost:9", apiKey: "sk-test", models: ["m"] },
        ],
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

  test("D: job milik sesi A tak bisa di-inspect/cancel sesi B", async () => {
    const cwd = ws()
    const sA = await createCliSession(baseOpts(cwd, { sessionId: "f03sesi-a" }))
    const sB = await createCliSession(baseOpts(cwd, { sessionId: "f03sesi-b" }))
    try {
      const toolOf = (s: { sessionTools: Tool[] }, name: string): Tool => {
        const t = s.sessionTools.find((x) => x.name === name)
        expect(t).toBeTruthy()
        return t as Tool
      }
      const bashA = toolOf(sA, "bash")
      const outA = toolOf(sA, "bash_output")
      const outB = toolOf(sB, "bash_output")
      const killB = toolOf(sB, "bash_kill")
      // Instance terikat sid berbeda — dua sesi, dua dunia job.
      expect(bashA).not.toBe(toolOf(sB, "bash"))
      const id = await startBg(bashA, echoCmd)
      expect(await errMsg(outB.execute({ id }, ctx))).toBe(`job "${id}" not found`)
      expect(await errMsg(killB.execute({ id }, ctx))).toBe(`job "${id}" not found`)
      // Job tidak rusak oleh percobaan B; A tetap sah.
      const ok = await waitUntil(() => listBackgroundJobs().find((j) => j.id === id)?.done === true)
      expect(ok).toBe(true)
      expect((await outA.execute({ id }, ctx)) as string).toContain("halo-f03")
    } finally {
      await sA.close()
      await sB.close()
      killAllBackgroundJobs()
    }
  })
})
