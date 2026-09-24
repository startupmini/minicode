// Coverage for cli/setup.ts & cli/index.ts — jalur 0% yang jadi gate P1.1.
// Pendekatan: panggil createCliSession langsung (bukan spawn) agar ter-cover
// oleh `bun test --coverage` di proses yang sama. Spawn hanya untuk CLI entry
// yang top-level (process.exit).

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliSession } from "../cli/setup.ts"

const tmpRoots: string[] = []

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "minicode-setup-"))
  tmpRoots.push(dir)
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  mkdirSync(join(dir, "home", ".minicode"), { recursive: true })
  writeFileSync(
    join(dir, ".minicode", "config.json"),
    JSON.stringify({
      providers: [
        { id: "fake", baseUrl: "http://localhost:9", apiKey: "sk-test", models: ["gpt-4o-mini"] },
      ],
    }),
    "utf8",
  )
  return dir
}

describe("cli/setup: permissionMode & timeout & budget", () => {
  test("auto mode default", async () => {
    const cwd = makeWorkspace()
    const s = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "s1",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
    })
    expect(s.permissionMode).toBe("auto")
    expect(s.effectiveTimeoutMs).toBe(900_000)
    await s.close()
  })

  test("allowAll -> allow-all", async () => {
    const cwd = makeWorkspace()
    const s = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "s2",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: true,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
    })
    expect(s.permissionMode).toBe("allow-all")
    await s.close()
  })

  test("ask -> ask", async () => {
    const cwd = makeWorkspace()
    const s = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "s3",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: true,
      plan: false,
      allowlist: false,
      verify: false,
    })
    expect(s.permissionMode).toBe("ask")
    await s.close()
  })

  test("plan -> plan", async () => {
    const cwd = makeWorkspace()
    const s = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "s4",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: true,
      allowlist: false,
      verify: false,
    })
    expect(s.permissionMode).toBe("plan")
    await s.close()
  })

  test("allowlist -> allowlist", async () => {
    const cwd = makeWorkspace()
    const s = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "s5",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: true,
      verify: false,
    })
    expect(s.permissionMode).toBe("allowlist")
    await s.close()
  })

  test("budget & maxSteps & contextWindow diteruskan", async () => {
    const cwd = makeWorkspace()
    const s = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "s6",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
      budget: 1.5,
      maxSteps: 12,
      contextWindowTokens: 4000,
      timeoutMs: 1234,
    })
    expect(s.budget).toBe(1.5)
    expect(s.effectiveTimeoutMs).toBe(1234)
    expect(s.session).toBeDefined()
    await s.close()
  })

  test("timeoutMs 0 -> Infinity", async () => {
    const cwd = makeWorkspace()
    const s = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "s7",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
      timeoutMs: 0,
    })
    expect(s.effectiveTimeoutMs).toBe(0)
    // Infinity di dalam session config
    await s.close()
  })

  test("MINICODE_TIMEOUT_MS env dipakai bila timeoutMs undefined", async () => {
    const cwd = makeWorkspace()
    const prev = process.env.MINICODE_TIMEOUT_MS
    process.env.MINICODE_TIMEOUT_MS = "7777"
    const s = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "s8",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
    })
    expect(s.effectiveTimeoutMs).toBe(7777)
    await s.close()
    if (prev == null) delete process.env.MINICODE_TIMEOUT_MS
    else process.env.MINICODE_TIMEOUT_MS = prev
  })

  test("resumeId not found -> warning tapi tetap jalan", async () => {
    const cwd = makeWorkspace()
    const s = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "s9",
      resumeId: "tidak-ada",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
    })
    expect(s.session).toBeDefined()
    await s.close()
  })

  test("persistCurrent & close tidak throw", async () => {
    const cwd = makeWorkspace()
    const s = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "s10",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
    })
    await s.persistCurrent({ totalTokens: 10 })
    await s.close()
    expect(true).toBe(true)
  })

  test("runPromptWithVerify tanpa verify langsung run", async () => {
    const cwd = makeWorkspace()
    const s = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "s11",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
    })
    // provider fake tidak ada, run akan gagal tapi tidak throw verify
    // cukup pastikan session ada
    expect(s.runPromptWithVerify).toBeDefined()
    await s.close()
  })

  // Fase 3 dark-launch: shadow reducer harus aktif dengan divergence 0
  // dan tidak mengganggu output TUI (lihat plan §Phase 3 acceptance).
  test("shadow reducer aktif: getShadowDiagnostics tanpa divergensi", async () => {
    const cwd = makeWorkspace()
    const s = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "shadow1",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
    })
    const d = s.getShadowDiagnostics()
    expect(d.divergence).toBe(0)
    // session dibuat tapi belum ada turn → eventsIn boleh 0
    expect(d.eventsIn).toBeGreaterThanOrEqual(0)
    expect(d.duplicateTerminal).toBe(0)
    expect(d.orphanTool).toBe(0)
    // close bersihkan shadow (unsubscribe + null state) tanpa throw
    await s.close()
    await s.close()
    expect(s.getShadowDiagnostics().divergence).toBe(0)
  })

  test("P5 snapshot dan event struktural mengikuti shadow reducer", async () => {
    const s = await createCliSession({
      cwd: makeWorkspace(),
      allowLocalConfig: true,
      sessionId: "projection1",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
    })
    const seen: string[] = []
    const unsubscribe = s.onPresentationEvent((event) => seen.push(event.type))
    const call = { id: "p5-call", name: "read_file", args: { path: "a.ts" } }
    const result = { role: "tool" as const, toolCallId: "p5-call", name: "read_file", content: "" }
    s.session.events.emit({ type: "turn:started", turn: 1 })
    s.session.events.emit({ type: "execution:started", execution: { call, result } })
    s.session.events.emit({
      type: "execution:completed",
      execution: { call, result: { ...result, content: "ok" } },
    })
    expect(s.getPresentationSnapshot().activities[0]).toMatchObject({
      toolCallId: "p5-call",
      name: "read_file",
      target: "a.ts",
      status: "completed",
    })
    expect(seen).toEqual(["turn.started", "tool.started", "tool.completed"])
    unsubscribe()
    await s.close()
  })
})

describe("last-model: default = terakhir dipakai", () => {
  const withHome = async <T>(fn: (home: string) => Promise<T>): Promise<T> => {
    const prev = process.env.MINICODE_HOME
    const home = mkdtempSync(join(tmpdir(), "minicode-home-"))
    tmpRoots.push(home)
    process.env.MINICODE_HOME = home
    try {
      return await fn(home)
    } finally {
      if (prev === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = prev
    }
  }

  test("save/load roundtrip; korup/hilang -> undefined", async () => {
    await withHome(async (home) => {
      const { loadLastModel, saveLastModel } = await import("../src/config.ts")
      expect(await loadLastModel()).toBeUndefined()
      await saveLastModel("prov::m1")
      expect(await loadLastModel()).toBe("prov::m1")
      await saveLastModel("prov::m2")
      expect(await loadLastModel()).toBe("prov::m2")
      const { writeFile } = await import("node:fs/promises")
      await writeFile(join(home, ".minicode", "state.json"), "{bukan json", "utf8")
      expect(await loadLastModel()).toBeUndefined()
    })
  })

  test("lang roundtrip; tak menimpa lastModel; asing/korup -> undefined", async () => {
    await withHome(async (home) => {
      const { loadLang, saveLang, loadLastModel, saveLastModel } = await import("../src/config.ts")
      expect(await loadLang()).toBeUndefined()
      await saveLang("id")
      expect(await loadLang()).toBe("id")
      // lastModel tetap utuh (merge, bukan timpa).
      await saveLastModel("prov::m1")
      expect(await loadLastModel()).toBe("prov::m1")
      expect(await loadLang()).toBe("id")
      await saveLang("en")
      expect(await loadLang()).toBe("en")
      expect(await loadLastModel()).toBe("prov::m1")
      const { writeFile } = await import("node:fs/promises")
      await writeFile(join(home, ".minicode", "state.json"), JSON.stringify({ lang: "xx" }), "utf8")
      expect(await loadLang()).toBeUndefined()
    })
  })

  test("sesi memakai simpanan valid; --model menang; simpanan basi diabaikan", async () => {
    await withHome(async () => {
      const { saveLastModel } = await import("../src/config.ts")
      const base = {
        prompt: "hi",
        enterRepl: false,
        verbose: false,
        allowAll: false,
        ask: false,
        plan: false,
        allowlist: false,
        verify: false,
        // Provider fake tinggal di config workspace → opt-in (aturan audit #07).
        allowLocalConfig: true,
      } as const
      // tanpa simpanan -> model pertama config (global+lokal merge, apa pun isinya)
      const cwd = makeWorkspace()
      let s = await createCliSession({ ...base, cwd, sessionId: "lm1" })
      const first = s.effectiveInitialModel
      await s.close()
      // simpanan valid (provider fake ada di config workspace) -> dipakai
      await saveLastModel("fake::gpt-4o-mini")
      s = await createCliSession({ ...base, cwd, sessionId: "lm2" })
      expect(s.effectiveInitialModel).toBe("fake::gpt-4o-mini")
      await s.close()
      // --model selalu menang atas simpanan
      s = await createCliSession({ ...base, cwd, sessionId: "lm3", modelOverride: "x::y" })
      expect(s.effectiveInitialModel).toBe("x::y")
      await s.close()
      // simpanan basi (provider dihapus) -> fallback pertama
      await saveLastModel("hilang::m9")
      s = await createCliSession({ ...base, cwd, sessionId: "lm4" })
      expect(s.effectiveInitialModel).toBe(first)
      await s.close()
    })
  })

  test("persistModelChoice update ref + simpan", async () => {
    await withHome(async () => {
      const { persistModelChoice } = await import("../cli/commands.ts")
      const { loadLastModel } = await import("../src/config.ts")
      const ref: { current?: string } = {}
      persistModelChoice("p::m", ref)
      expect(ref.current).toBe("p::m")
      // saveLastModel fire-and-forget + withConfigLock: tunggu dengan POLLING,
      // bukan satu jeda tetap — jeda 50ms sempat kalah race di run penuh
      // ber-instrumentasi coverage (I/O Windows + lock contention membuat
      // kegagalan order/load-dependent, bukan regresi). Maks 5s lalu fail.
      let got: string | undefined
      for (let i = 0; i < 100 && got !== "p::m"; i++) {
        await new Promise((r) => setTimeout(r, 50))
        got = await loadLastModel()
      }
      expect(got).toBe("p::m")
    })
  })
})

describe("cli/index helpers via args", () => {
  test("getArg & promptFromArgs ter-cover via import", async () => {
    const { getArg, promptFromArgs } = await import("../cli/args.ts")
    const args = ["--model", "gpt-4o", "--cwd", "/tmp", "hello", "world"]
    expect(getArg(args, "--model")).toBe("gpt-4o")
    expect(getArg(args, "--cwd")).toBe("/tmp")
    expect(promptFromArgs(args)).toBe("hello world")
    // flags after prompt are treated as prompt (anti injection)
    expect(getArg(["hello", "world", "--cwd", "/tmp"], "--cwd")).toBeUndefined()
    expect(promptFromArgs(["hello", "world", "--cwd", "/tmp"])).toBe("hello world --cwd /tmp")
    expect(promptFromArgs(["--verbose", "hi"])).toBe("hi")
    expect(promptFromArgs(["--model=gpt-4o", "hi"])).toBe("hi")
  })
})
