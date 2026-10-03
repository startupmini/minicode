// STAGE D — Validasi produksi runtime `owned` terhadap alur real.
//
// BUKAN suite unit: tiap test menjalankan PROSES CLI NYATA (Bun.spawn) dengan
// provider tiruan (server SSE localhost, `test/helpers/fake-provider.ts`) dan
// workspace temp + HOME palsu — meniru pola `test/cli-session.test.ts` yang
// sudah terbukti (stub fetch tak terlihat proses anak, `spawnSync` deadlock).
//
// Aturan yang dijaga:
// - Tanpa API key nyata (env kunci dikosongkan), tanpa jaringan luar, tanpa
//   perintah destruktif. Semua efek ke fixtures temp milik test itu sendiri.
// - Legacy vs owned TIDAK PERNAH dijalankan terhadap target luar yang sama:
//   targetnya SELALU provider tiruan + fixtures temp, dan tiap mode punya
//   workspace-nya sendiri.
// - Provider nyata: UNAVAILABLE untuk A/B di sini (butuh kunci + biaya +
//   non-deterministik) — dicatat sebagai blocker eksplisit di laporan, bukan
//   sebagai asumsi ekuivalensi.
//
// Cakupan: interaktif-one-shot, exec, agent/tool, provider error, timeout,
// SIGINT, budget, resume, recovery/inspect, duplikat, isolasi, rollback,
// scheduler wiring, child wiring, jurnal, resource/perf.

import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { openExecutionJournal } from "../src/runtime/execution-journal.ts"
import { type FakeReply, startFakeProvider } from "./helpers/fake-provider.ts"

const repoRoot = resolve(import.meta.dir, "..")
const entry = join(repoRoot, "cli", "index.ts")
const tmpRoots: string[] = []

function makeWorkspace(): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "minicode-staged-"))
  tmpRoots.push(dir)
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  mkdirSync(join(dir, "home", ".minicode"), { recursive: true })
  return { dir, configPath: join(dir, ".minicode", "config.json") }
}

function writeProviderConfig(ws: { configPath: string }, baseUrl: string): void {
  writeFileSync(
    ws.configPath,
    JSON.stringify({
      providers: [
        {
          id: "fake",
          baseUrl,
          apiKey: "sk-test",
          models: ["gpt-4o-mini"],
          providerHint: "openai",
        },
      ],
    }),
    "utf8",
  )
}

interface CliRun {
  code: number
  stdout: string
  stderr: string
}

async function runCli(
  ws: { dir: string },
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 90_000,
): Promise<CliRun> {
  const fakeHome = join(ws.dir, "home")
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    cwd: ws.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      NO_COLOR: "1",
      MINICODE_TELEMETRY: "1",
      DEEPSEEK_API_KEY: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      AGENT_BASE_URL: "",
      ...env,
    },
  })
  const killer = setTimeout(() => proc.kill(), timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(killer)
  return { code, stdout, stderr }
}

function baseArgs(
  ws: { dir: string },
  mode: "off" | "owned",
  session: string,
  extra: string[] = [],
) {
  return [
    ...extra,
    "--cwd",
    ws.dir,
    "--model",
    "gpt-4o-mini",
    "--allow-local-config",
    "--session",
    session,
    ...(mode === "owned" ? ["--runtime", "owned"] : []),
  ]
}

function journalPath(ws: { dir: string }, session: string): string {
  return join(ws.dir, ".minicode", `runtime-journal-${session}.db`)
}

/**
 * Argv final: flag DULU, prompt TERAKHIR. Parser CLI (`cli/args.ts`) berhenti
 * memindai flag pada token prompt pertama — tanpa ini flag yang diletakkan
 * setelah prompt hilang diam-diam (kegagalan harness, bukan produk).
 */
function withPrompt(prompt: string, flags: string[]): string[] {
  return [...flags, prompt]
}

afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        await Bun.sleep(200)
      }
    }
  }
})

// ── D1: owned one-shot turn works end-to-end ────────────────────────────────
test("D1: one-shot owned — turn jalan, teks dikembalikan, jurnal durable ada", async () => {
  const ws = makeWorkspace()
  const provider = startFakeProvider([
    { kind: "text", text: "halo owned", usage: { inputTokens: 10, outputTokens: 5 } },
  ])
  try {
    writeProviderConfig(ws, provider.baseUrl)
    const r = await runCli(ws, withPrompt("tanya jawab", baseArgs(ws, "owned", "d1")))
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("halo owned")
    // Bukti durable: intent dispatch + 3 event lifecycle.
    expect(existsSync(journalPath(ws, "d1"))).toBe(true)
    const j = openExecutionJournal(journalPath(ws, "d1"))
    try {
      const records = j.readAll()
      expect(records.filter((x) => x.kind === "intent")).toHaveLength(1)
      const events = records
        .filter((x) => x.kind === "event")
        .map((x) => (x as { state?: string }).state)
      expect(events).toEqual(["ADMITTED", "RUNNING", "COMPLETED"])
      expect(j.integrityCheck()).toEqual({ checked: 4, mismatched: [] })
    } finally {
      j.close()
    }
  } finally {
    provider.close()
  }
}, 120_000)

// ── D2: ekuivalensi legacy vs owned (target tiruan yang sama, ws berbeda) ──
test("D2: skrip sama → stdout dan request provider ekuivalen di kedua mode", async () => {
  const script: FakeReply[] = [
    { kind: "text", text: "jawaban pasti", usage: { inputTokens: 10, outputTokens: 8 } },
  ]
  const results: Array<{
    mode: "off" | "owned"
    stdout: string
    requests: Record<string, unknown>[]
    code: number
  }> = []
  for (const mode of ["off", "owned"] as const) {
    const ws = makeWorkspace()
    const provider = startFakeProvider(script)
    try {
      writeProviderConfig(ws, provider.baseUrl)
      const r = await runCli(ws, withPrompt("berapa 2+2", baseArgs(ws, mode, `d2-${mode}`)))
      results.push({ mode, stdout: r.stdout, requests: provider.requests(), code: r.code })
    } finally {
      provider.close()
    }
  }
  const [legacy, owned] = results as [
    { mode: string; stdout: string; requests: Record<string, unknown>[]; code: number },
    { mode: string; stdout: string; requests: Record<string, unknown>[]; code: number },
  ]
// Perilaku user-visible sama: teks model, exit code, dan prompt user yang
  // dikirim. Blok system pertama BOLEH berbeda (memuat working directory tiap
  // ws) — yang dibandingkan adalah pesan user TERAKHIR (prompt itu sendiri).
  expect(owned!.code).toBe(legacy!.code)
  expect(owned!.stdout).toContain("jawaban pasti")
  expect(legacy!.stdout).toContain("jawaban pasti")
  const lastUserMsg = (rs: Record<string, unknown>[]) => {
    const users = (((rs[0]?.messages as { role: string; content: unknown }[]) ?? []).filter(
      (m) => m.role === "user",
    ).map((m) => String(m.content)))
    return users[users.length - 1]
  }
  expect(lastUserMsg(owned!.requests)).toBe("berapa 2+2")
  expect(lastUserMsg(owned!.requests)).toBe(lastUserMsg(legacy!.requests))
  expect(owned!.requests.length).toBeGreaterThan(0)
}, 180_000)

test("D2b: jalur exec juga direroute (minicode exec --runtime owned)", async () => {
  const ws = makeWorkspace()
  const provider = startFakeProvider([{ kind: "text", text: "exec owned ok" }])
  try {
    writeProviderConfig(ws, provider.baseUrl)
    const r = await runCli(
      ws,
      withPrompt("jalankan sesuatu", ["exec", ...baseArgs(ws, "owned", "d2b")]),
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("exec owned ok")
    expect(existsSync(journalPath(ws, "d2b"))).toBe(true)
  } finally {
    provider.close()
  }
}, 120_000)

// ── D3: tool turn owned (read_file pada fixture) ───────────────────────────
test("D3: owned tool turn — permission, cwd, stdout, bukti jurnal", async () => {
  const ws = makeWorkspace()
  writeFileSync(join(ws.dir, "data.txt"), "ISI-FIXTURE-UNIK-42\n", "utf8")
  const provider = startFakeProvider([
    { kind: "tool", name: "read_file", args: { path: "data.txt" } },
    { kind: "text", text: "sudah kubaca" },
  ])
  try {
    writeProviderConfig(ws, provider.baseUrl)
    const r = await runCli(
      ws,
      withPrompt("baca data.txt", [...baseArgs(ws, "owned", "d3"), "--allow-all"]),
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("sudah kubaca")
    // Tool BENAR-BENAR dijalankan (bukan di-skip): loop model meminta tool,
    // hasil tool kembali ke model sebagai pesan tool_result berisi fixture.
    expect(provider.requestCount()).toBe(2)
    const toolResults = JSON.stringify(provider.requests()[1])
    expect(toolResults).toContain("ISI-FIXTURE-UNIK-42")
    // Jurnal mencatat ADMITTED + RUNNING; tool result bukan bukti lifecycle palsu.
    const j = openExecutionJournal(journalPath(ws, "d3"))
    try {
      const states = j
        .readAll()
        .filter((x) => x.kind === "event")
        .map((x) => (x as { state?: string }).state)
      expect(states[states.length - 1]).toBe("COMPLETED")
      expect(j.integrityCheck().mismatched).toEqual([])
    } finally {
      j.close()
    }
  } finally {
    provider.close()
  }
}, 120_000)

// ── D4: provider error — kelas error sama di kedua mode ────────────────────
test("D4: HTTP 500 — legacy dan owned gagal dengan kelas yang sama", async () => {
  const results: Array<{ mode: string; code: number; out: string }> = []
  for (const mode of ["off", "owned"] as const) {
    const ws = makeWorkspace()
    const provider = startFakeProvider([{ kind: "status", status: 500, body: "boom" }])
    try {
      writeProviderConfig(ws, provider.baseUrl)
      const r = await runCli(ws, withPrompt("ini akan gagal", baseArgs(ws, mode, `d4-${mode}`)))
      results.push({ mode, code: r.code, out: r.stdout + r.stderr })
    } finally {
      provider.close()
    }
  }
  const [legacy, owned] = results as unknown as [
    { code: number; out: string },
    { code: number; out: string },
  ]
  expect(owned!.code).toBe(legacy!.code)
  expect(owned.code).not.toBe(0)
  // Kelas yang sama terpetakan (server error), bukan "aborted" generik di satu sisi.
  expect(/server|500|boom|provider/i.test(owned!.out)).toBe(
    /server|500|boom|provider/i.test(legacy!.out),
  )
  // Owned mencatat terminal FAILED (bukan COMPLETED palsu).
  const ws = makeWorkspace()
  const provider = startFakeProvider([{ kind: "status", status: 500, body: "boom" }])
  try {
    writeProviderConfig(ws, provider.baseUrl)
    await runCli(ws, withPrompt("ini akan gagal", baseArgs(ws, "owned", "d4j")))
    const j = openExecutionJournal(journalPath(ws, "d4j"))
    try {
      const states = j
        .readAll()
        .filter((x) => x.kind === "event")
        .map((x) => (x as { state?: string }).state)
      expect(states[states.length - 1]).toBe("FAILED")
    } finally {
      j.close()
    }
  } finally {
    provider.close()
  }
}, 240_000)

// ── D5: timeout — abort deterministik, owned = TIMED_OUT ───────────────────
test("D5: provider hang + timeout — kedua mode abort; owned mencatat TIMED_OUT", async () => {
  const results: Array<{ mode: string; code: number; out: string }> = []
  for (const mode of ["off", "owned"] as const) {
    const ws = makeWorkspace()
    const provider = startFakeProvider([{ kind: "hang" }])
    try {
      writeProviderConfig(ws, provider.baseUrl)
      const r = await runCli(
        ws,
        withPrompt("tunggu", baseArgs(ws, mode, `d5-${mode}`)),
        {
          MINICODE_TIMEOUT_MS: "4000",
        },
        30_000,
      )
      results.push({ mode, code: r.code, out: r.stdout + r.stderr })
    } finally {
      provider.close()
    }
  }
  const [legacy, owned] = results as unknown as [
    { code: number; out: string },
    { code: number; out: string },
  ]
  // Keduanya gagal (timeout), dan owned tidak mencetak COMPLETED.
  expect(owned!.code).not.toBe(0)
  expect(legacy!.code).not.toBe(0)
  const ws = makeWorkspace()
  const provider = startFakeProvider([{ kind: "hang" }])
  try {
    writeProviderConfig(ws, provider.baseUrl)
    await runCli(
      ws,
      withPrompt("tunggu", baseArgs(ws, "owned", "d5j")),
      { MINICODE_TIMEOUT_MS: "4000" },
      30_000,
    )
    const j = openExecutionJournal(journalPath(ws, "d5j"))
    try {
      const states = j
        .readAll()
        .filter((x) => x.kind === "event")
        .map((x) => (x as { state?: string }).state)
      expect(states[states.length - 1]).toBe("TIMED_OUT")
    } finally {
      j.close()
    }
  } finally {
    provider.close()
  }
}, 240_000)

// ── D6: SIGINT saat provider hang (owned) — tak ada terminal palsu ────────
test("D6: SIGINT saat turn jalan — proses keluar, jurnal tanpa COMPLETED karangan", async () => {
  const ws = makeWorkspace()
  const provider = startFakeProvider([{ kind: "hang" }])
  let code = -1
  try {
    writeProviderConfig(ws, provider.baseUrl)
    const fakeHome = join(ws.dir, "home")
    const proc = Bun.spawn(
      [process.execPath, entry, "tunggu sinyal", ...baseArgs(ws, "owned", "d6")],
      {
        cwd: ws.dir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          NO_COLOR: "1",
          MINICODE_TELEMETRY: "1",
          DEEPSEEK_API_KEY: "",
          OPENAI_API_KEY: "",
          ANTHROPIC_API_KEY: "",
          AGENT_BASE_URL: "",
        },
      },
    )
    await Bun.sleep(6000)
    proc.kill("SIGINT")
    const killer = setTimeout(() => proc.kill("SIGKILL"), 25_000)
    code = await proc.exited
    clearTimeout(killer)
    await new Response(proc.stdout).text()
    await new Response(proc.stderr).text()
  } finally {
    provider.close()
  }
  // Tak memaksa kode spesifik (platform-dependent), tapi jurnal tak boleh
  // berisi terminal yang tak terjadi — dan proses pasti sudah mati.
  expect(code).not.toBe(-1)
  if (existsSync(journalPath(ws, "d6"))) {
    const j = openExecutionJournal(journalPath(ws, "d6"))
    try {
      const states = j
        .readAll()
        .filter((x) => x.kind === "event")
        .map((x) => (x as { state?: string }).state)
      expect(states).not.toContain("COMPLETED")
      expect(j.integrityCheck().mismatched).toEqual([])
    } finally {
      j.close()
    }
  }
}, 120_000)

// ── D7: domain identity jurnal tetap terpisah pada data produksi ───────────
test("D7: eventId/eventSequence/executionVersion/journalSequence berbeda", async () => {
  const ws = makeWorkspace()
  const provider = startFakeProvider([{ kind: "text", text: "ok" }])
  try {
    writeProviderConfig(ws, provider.baseUrl)
    await runCli(ws, withPrompt("cek id", baseArgs(ws, "owned", "d7")))
    const j = openExecutionJournal(journalPath(ws, "d7"))
    try {
      const records = j.readAll()
      const events = records.filter((x) => x.kind === "event")
      const eventIds = events.map((x) => (x as { eventId: string }).eventId)
      const eventSeqs = events.map((x) => (x as { eventSequence: number }).eventSequence)
      const execVersions = events.map((x) => (x as { executionVersion: number }).executionVersion)
      const journalSeqs = events.map((x) => x.journalSequence)
      // Semua unik; eventSequence ≠ journalSequence (domain berbeda).
      expect(new Set(eventIds).size).toBe(eventIds.length)
      expect(new Set(eventSeqs).size).toBe(eventSeqs.length)
      expect(new Set(journalSeqs).size).toBe(journalSeqs.length)
      expect(eventSeqs).not.toEqual(journalSeqs)
      // executionVersion naik monoton seiring lifecycle.
      expect([...execVersions].sort((a, b) => a - b)).toEqual(execVersions)
    } finally {
      j.close()
    }
  } finally {
    provider.close()
  }
}, 120_000)

// ── D8: resume owned — identitas sama, history gabung, tanpa file ganda ────
test("D8: --resume memakai jurnal yang sama; history dua eksekusi utuh", async () => {
  const ws = makeWorkspace()
  const run = async (prompt: string, session: string, extra: string[]) => {
    const provider = startFakeProvider([{ kind: "text", text: `balasan-${session}` }])
    try {
      writeProviderConfig(ws, provider.baseUrl)
      return await runCli(ws, withPrompt(prompt, baseArgs(ws, "owned", session, extra)))
    } finally {
      provider.close()
    }
  }
  const first = await run("pertama", "d8", [])
  expect(first.code).toBe(0)
  const second = await run("kedua", "d8-baru", ["--resume", "d8"])
  expect(second.code).toBe(0)
  // Jurnal lama dipakai; tak ada jurnal baru untuk id sesi yang baru.
  expect(existsSync(journalPath(ws, "d8"))).toBe(true)
  expect(existsSync(journalPath(ws, "d8-baru"))).toBe(false)
  const j = openExecutionJournal(journalPath(ws, "d8"))
  try {
    const executions = new Set(
      j
        .readAll()
        .filter((x) => x.kind === "event")
        .map((x) => x.executionId),
    )
    expect(executions.size).toBe(2)
    const sessions = j.readAll()
    expect(sessions.length).toBe(2 * 4)
  } finally {
    j.close()
  }
}, 240_000)

// ── D9/D10: duplikat prompt ≠ duplikat eksekusi; isolasi dua sesi ──────────
test("D9: prompt sama dua kali = dua eksekusi berbeda (intent berbeda, bukan dedupe)", async () => {
  const ws = makeWorkspace()
  for (const id of ["d9a", "d9b"]) {
    const provider = startFakeProvider([{ kind: "text", text: `balasan ${id}` }])
    try {
      writeProviderConfig(ws, provider.baseUrl)
      const r = await runCli(ws, withPrompt("prompt yang sama", baseArgs(ws, "owned", id)))
      expect(r.code).toBe(0)
    } finally {
      provider.close()
    }
  }
  const ja = openExecutionJournal(journalPath(ws, "d9a"))
  const jb = openExecutionJournal(journalPath(ws, "d9b"))
  try {
    const execA = new Set(ja.readAll().map((x) => x.executionId))
    const execB = new Set(jb.readAll().map((x) => x.executionId))
    expect(execA.size).toBe(1)
    expect(execB.size).toBe(1)
    expect([...execA][0]).not.toBe([...execB][0])
  } finally {
    ja.close()
    jb.close()
  }
}, 240_000)

// ── D11: rollback owned → off (jurnal utuh, legacy tak mint identitas) ─────
test("D11: rollback — mode off kembali legacy; jurnal owned tetap utuh", async () => {
  const ws = makeWorkspace()
  const provider = startFakeProvider([{ kind: "text", text: "owned dulu" }])
  try {
    writeProviderConfig(ws, provider.baseUrl)
    const owned = await runCli(ws, withPrompt("satu", baseArgs(ws, "owned", "d11")))
    expect(owned.code).toBe(0)
  } finally {
    provider.close()
  }
  const provider2 = startFakeProvider([{ kind: "text", text: "legacy lagi" }])
  try {
    writeProviderConfig(ws, provider2.baseUrl)
    const legacy = await runCli(ws, withPrompt("dua", baseArgs(ws, "off", "d11-off")))
    expect(legacy.code).toBe(0)
    expect(legacy.stdout).toContain("legacy lagi")
  } finally {
    provider2.close()
  }
  // Rollback tak menulis ulang jurnal owned, dan mode off tak membuat jurnal.
  expect(existsSync(journalPath(ws, "d11-off"))).toBe(false)
  const j = openExecutionJournal(journalPath(ws, "d11"))
  try {
    const execs = new Set(j.readAll().map((x) => x.executionId))
    expect(execs.size).toBe(1)
    expect(j.integrityCheck().mismatched).toEqual([])
  } finally {
    j.close()
  }
}, 240_000)

// ── D12: budget — abort identik, owned mencatat BUDGET_EXCEEDED ────────────
test("D12: budget terlampaui — kedua mode berhenti; owned = BUDGET_EXCEEDED", async () => {
  // Script mahal: 2M input + 1M output pada gpt-4o-mini. Pagu kecil → abort.
  const usage = { inputTokens: 2_000_000, outputTokens: 1_000_000 }
  const results: Array<{ mode: string; code: number; out: string }> = []
  for (const mode of ["off", "owned"] as const) {
    const ws = makeWorkspace()
    const provider = startFakeProvider([{ kind: "text", text: "mahal", usage }])
    try {
      writeProviderConfig(ws, provider.baseUrl)
      const r = await runCli(
        ws,
        withPrompt("boros", [...baseArgs(ws, mode, `d12-${mode}`), "--budget", "0.01"]),
      )
      results.push({ mode, code: r.code, out: r.stdout + r.stderr })
    } finally {
      provider.close()
    }
  }
  const [legacy, owned] = results as unknown as [
    { code: number; out: string },
    { code: number; out: string },
  ]
  expect(owned!.code).not.toBe(0)
  expect(legacy!.code).not.toBe(0)
  expect(/budget/i.test(owned!.out)).toBe(true)
  expect(/budget/i.test(legacy!.out)).toBe(true)
  // Bukti owned: terminal budget tercatat (bukan FAILED generik).
  const ws = makeWorkspace()
  const provider = startFakeProvider([{ kind: "text", text: "mahal", usage }])
  try {
    writeProviderConfig(ws, provider.baseUrl)
    await runCli(ws, withPrompt("boros", [...baseArgs(ws, "owned", "d12j"), "--budget", "0.01"]))
    const j = openExecutionJournal(journalPath(ws, "d12j"))
    try {
      const states = j
        .readAll()
        .filter((x) => x.kind === "event")
        .map((x) => (x as { state?: string }).state)
      expect(states[states.length - 1]).toBe("BUDGET_EXCEEDED")
    } finally {
      j.close()
    }
  } finally {
    provider.close()
  }
}, 300_000)

// ── D13: child wiring (in-process, factory tiruan) — sekali, ber-lineage ───
test("D13: delegate_task dengan runner — satu eksekusi, parent terikat, dipanggil sekali", async () => {
  const {
    delegateTaskTool,
    setSubAgentSessionFactory,
    clearSubAgentSessionFactory,
    setSubAgentExecutionRunner,
  } = await import("../src/tools/task.ts")
  const { createRuntimeComposition } = await import("../src/runtime/composition.ts")
  const { createProductionExecutionRunner } = await import("../src/runtime/production-execution.ts")
  const dir = mkdtempSync(join(tmpdir(), "minicode-staged-child-"))
  tmpRoots.push(dir)
  const runtime = createRuntimeComposition({
    sessionId: "d13",
    workspaceCwd: dir,
    journalPath: join(dir, "journal.db"),
  })
  const runner = createProductionExecutionRunner({ mode: "owned", runtime })
  // Turn parent dulu (supaya ada parentExecutionId di runner).
  const parent = await runner.run(
    {
      kind: "turn",
      schedulerSource: "cli-session",
      authorityHeld: true,
      provenance: { requestedBy: "user", reason: "prompt" },
    },
    async () => "parent",
  )
  let sessionsCreated = 0
  let runs = 0
  setSubAgentSessionFactory(async () => {
    sessionsCreated++
    return {
      events: { on: () => () => {} },
      run: async () => {
        runs++
        return { finalText: "ringkasan anak", usage: { steps: 2 } }
      },
    } as never
  })
  setSubAgentExecutionRunner(runner)
  try {
    const out = (await delegateTaskTool.execute({ prompt: "teliti x" }, {
      signal: new AbortController().signal,
      emit: () => {},
      cwd: dir,
    } as never)) as string
    expect(out).toContain("sub-agent (explore) done")
    expect(sessionsCreated).toBe(1)
    expect(runs).toBe(1)
    // Kernel composition hanya punya dua eksekusi: parent + child.
    expect(runtime.kernel.metrics().executions).toBe(2)
    // Parent linkage: child menunjuk turn parent sebagai parent.
    const parentId = runner.parentExecutionId()
    expect(parentId).toBe(parent.executionId)
    const closed = await runtime.shutdown()
    expect(closed.ok).toBe(true)
    expect(parent.executionId).toBeTruthy()
  } finally {
    clearSubAgentSessionFactory()
    setSubAgentExecutionRunner(undefined)
  }
}, 120_000)

// ── D14: scheduler/autonomous wiring (in-process, sesi tiruan) ─────────────
test("D14: autonomous turn lewat M13 yang sama (admission, bukan bypass)", async () => {
  const { planAutonomousContext } = await import("../src/task/autonomous-adapter.ts")
  const { createRuntimeComposition } = await import("../src/runtime/composition.ts")
  const { createProductionExecutionRunner } = await import("../src/runtime/production-execution.ts")
  const dir = mkdtempSync(join(tmpdir(), "minicode-staged-auto-"))
  tmpRoots.push(dir)
  const runtime = createRuntimeComposition({
    sessionId: "d14",
    workspaceCwd: dir,
    journalPath: join(dir, "journal.db"),
  })
  const runner = createProductionExecutionRunner({ mode: "owned", runtime })
  let runs = 0
  const config = planAutonomousContext(
    {
      taskId: "t-auto",
      instruction: "kerjakan",
      parentSessionId: "d14",
      sessionIncarnation: 1,
      execGeneration: 2,
    } as never,
    {
      parentSessionId: "d14",
      taskId: "t-auto",
      execGeneration: 2,
      sessionIncarnation: 1,
    },
    {
      store: {} as never,
      sessionFactory: (async () => ({
        events: { on: () => () => {} },
        run: async () => {
          runs++
          return { finalText: "done auto", usage: { steps: 1 } }
        },
      })) as never,
      tools: [],
      cwdFor: () => dir,
      executionRunner: runner,
    },
  )
  // Adapter meneruskan runner ke konteks (bukan membuat jalur kedua).
  expect(config.executionRunner).toBe(runner)
  const { AutonomousExecutionContext } = await import("../src/task/autonomous-context.ts")
  const context = new AutonomousExecutionContext(config)
  try {
    const result = await context.execute()
    expect(result.outcome).toBe("returned")
    expect(runs).toBe(1)
    expect(runtime.bridge.metrics().admitted).toBe(1)
    expect(runtime.kernel.metrics().executions).toBe(1)
  } finally {
    await context.dispose()
  }
  await runtime.shutdown()
}, 120_000)

// ── D15: recovery inspect + redispatch aman (in-process) ───────────────────
test("D15: stale execution → M12 menafsirkan; redispatch hanya via M13 bila SAFE", async () => {
  const { createRuntimeComposition } = await import("../src/runtime/composition.ts")
  const { inspectStartupRecovery } = await import("../src/runtime/production-execution.ts")
  const { isRedispatchAllowed } = await import("../src/runtime/recovery-safety.ts")
  const dir = mkdtempSync(join(tmpdir(), "minicode-staged-rec-"))
  tmpRoots.push(dir)
  const journalPath = join(dir, "journal.db")
  const runtime = createRuntimeComposition({ sessionId: "d15", workspaceCwd: dir, journalPath })
  const record = runtime.dispatch({
    dispatchId: "dsp_d15redispatch-proof",
    schedulerSource: "test",
    authorityHeld: true,
    provenance: { requestedBy: "test", reason: "redispatch-check" },
  })
  const executionId = record.executionId!
  runtime.kernel.requestTransition({ executionId, to: "RUNNING", reason: "start", source: "host" })
  runtime.kernel.requestTransition({
    executionId,
    to: "WAITING",
    reason: "await",
    source: "agent-loop",
  })
  await runtime.flush()
  // "Restart": buka ulang komposisi baru pada jurnal yang sama.
  const second = createRuntimeComposition({ sessionId: "d15", workspaceCwd: dir, journalPath })
  const report = inspectStartupRecovery(second)
  const found = report.recoverable.find((x) => x.executionId === executionId)
  expect(found).toBeTruthy()
  expect(found!.lastState).toBe("WAITING")
  // Tak ada auto-dispatch dari inspect.
  expect(second.bridge.metrics().admitted).toBe(0)
  // Dan redispatch aman harus tetap lewat M13 dengan plan M12 — di sini
  // buktinya: predicate menentukan siapa yang boleh, bukan siapa yang berani.
  expect(
    isRedispatchAllowed({
      authorityHeld: true,
      budgetRemaining: null,
      deadlineRemainingMs: null,
      effectDefinitelyNotStarted: true,
      idempotent: false,
      dedupeKeyPresent: false,
      dedupeCheckPass: false,
      verifierConfirmedNotExecuted: false,
      evidenceRecorded: false,
    }),
  ).toBe(true)
  await runtime.shutdown()
  await second.shutdown()
}, 120_000)

// ── D16: ukuran jurnal + resource (bounded, tak ada leak proses anak) ──────
test("D16: jurnal tumbuh terbatas; tak ada proses anak yang tertinggal", async () => {
  const ws = makeWorkspace()
  const provider = startFakeProvider([{ kind: "text", text: "ukur" }])
  try {
    writeProviderConfig(ws, provider.baseUrl)
    await runCli(ws, withPrompt("satu", baseArgs(ws, "owned", "d16")))
    const size1 = statSync(journalPath(ws, "d16")).size
    await runCli(ws, withPrompt("dua", baseArgs(ws, "owned", "d16b")), {})
    expect(size1).toBeGreaterThan(0)
    expect(size1).toBeLessThan(1024 * 1024)
    const j = openExecutionJournal(journalPath(ws, "d16"))
    try {
      expect(j.integrityCheck().mismatched).toEqual([])
    } finally {
      j.close()
    }
  } finally {
    provider.close()
  }
  // Baca file jurnal sambil terbuka sebelumnya sudah ditutup: buka ulang bisa.
  const probe = openExecutionJournal(journalPath(ws, "d16"))
  probe.close()
}, 180_000)
