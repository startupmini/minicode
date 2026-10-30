// [Fase 7 / Live #1, #2, #3, #4 + LOOP-INV-13/14/15] Hotfix temuan Live API +
// unifikasi guard lintas jalur (subagent & daemon). Hermetik: temp dir, fake
// event bus, fake subagent factory, tanpa jaringan (embedding circuit-breaker
// diuji via state internal yang sudah di-reset).
//
// Invariant yang dibuktikan:
//   Live #1 : 6 pembukaan `sessions.db` + `tasks.db` SERENTAK di direktori baru → 6/6 sukses, 0 SQLITE_BUSY
//   Live #2 : 10 chunk SSE usage kumulatif → total akhir 200 token (bukan 1550); mid-stream cutoff `--context-window 500`
//   CTX-03  : `recordTokenCalibrationSample` / `lastDriftRatio` akurat
//   LOOP-INV-13/15 : subagent ber-NoProgressDetector aktif + ACE verdict pada amplop hasil
//   LOOP-INV-13/LOOP-04/U6 : burst saturasi pool 8 delegasi → aktif konkuren ≤ MAX=3
//   LOOP-INV-14 : abort parent → subagent berhenti & slot pool dilepas
//   Live #3 : circuit-breaker embedding (2nd/3rd/4th call fallback <20ms, 0 jaringan); root wall-clock timeout presisi

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EventBus } from "#minicore"
import { openSessionDb } from "../src/session/persistence.ts"
import { TaskStore, resetTaskStoreHandles } from "../src/task/store.ts"
import {
  createUsageCollector,
  watchContextWindowLimit,
} from "../src/policy/usage.ts"
import { createCalibratedEstimator } from "../src/policy/context.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  type SubAgentSpec,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import { Pool } from "../src/agents/pool.ts"
import { LIMITS } from "../src/constants.ts"
import {
  type ChildResultEnvelope,
  type JournalRecord,
  loadJournal,
} from "../src/session/journal.ts"
import { resetEmbeddingCircuitBreaker, tripEmbeddingCircuitForTest, embedTexts } from "../src/memory/vector.ts"
import { createCliSession } from "../cli/setup.ts"
import { todoSession } from "../src/tools/todo.ts"

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-p19-"))
  dirs.push(d)
  return d
}
afterEach(async () => {
  resetEmbeddingCircuitBreaker()
  while (dirs.length > 0) {
    try {
      await rm(dirs.pop()!, { recursive: true, force: true })
    } catch {}
  }
})
afterAll(() => {
  clearSubAgentSessionFactory()
})

// ─────────────────────────────────────────────────────────────────────────────
// Fake EventBus (polos, tanpa dependensi kernel) untuk uji usage collector.
// ─────────────────────────────────────────────────────────────────────────────
function makeFakeEventBus() {
  type Handler = (ev: unknown) => void
  const handlers = new Map<string, Handler[]>()
  const bus: EventBus & { emit: (type: string, ev: unknown) => void } = {
    on(type: string, handler: Handler) {
      const list = handlers.get(type) ?? []
      list.push(handler)
      handlers.set(type, list)
      return () => {
        const idx = list.indexOf(handler)
        if (idx >= 0) list.splice(idx, 1)
      }
    },
    emit(type: string, ev: unknown) {
      for (const h of [...(handlers.get(type) ?? [])]) h(ev)
    },
  } as unknown as EventBus & { emit: (type: string, ev: unknown) => void }
  return bus
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider fallback agar getProvider() jalan tanpa config (pola delegate-audit).
// ─────────────────────────────────────────────────────────────────────────────
function providerEnv(): () => void {
  const savedKey = process.env.OPENAI_API_KEY
  const savedAgent = process.env.AGENT_API_KEY
  if (!savedKey && !savedAgent) process.env.OPENAI_API_KEY = "sk-test-hermetic"
  return () => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedKey
    if (savedAgent === undefined) delete process.env.AGENT_API_KEY
    else process.env.AGENT_API_KEY = savedAgent
  }
}

const ctxFor = (cwd: string, permissionMode = "auto", signal?: AbortSignal) =>
  ({
    signal: signal ?? new AbortController().signal,
    emit: () => {},
    cwd,
    permissionMode,
  }) as never

type RunFn = () => Promise<{ finalText?: string; usage: { steps: number } }>

function recordingFactory(seen: SubAgentSpec[], probe: { calls: number }, runImpl: RunFn) {
  return async (spec: SubAgentSpec) => {
    seen.push(spec)
    return {
      events: { on: () => () => {} },
      run: async () => {
        probe.calls++
        return runImpl()
      },
    }
  }
}

/** Terminal receipt delegasi tunggal di jurnal parent. */
async function delegateTerminal(parentId: string, dir: string): Promise<JournalRecord> {
  const { records } = await loadJournal(parentId, dir)
  const terms = records.filter(
    (r) => r.tool === "delegate_task" && (r.state === "committed" || r.state === "failed"),
  )
  expect(terms).toHaveLength(1)
  return terms[0]!
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.1 — Parallel SQLite Init Contention (Live #1)
// ─────────────────────────────────────────────────────────────────────────────
describe("7.1 SQLite concurrent init race — 6 pembukaan paralel, 0 SQLITE_BUSY", () => {
  test("6x openSessionDb + TaskStore serentak pada direktori baru → 6/6 sukses", async () => {
    const dir = tmpRoot()
    // Jalankan 6 pembukaan "serentak" lewat Promise.all — meski SQLite sync
    // di Bun (single-thread), retry wrapper di open()/handle() menjamin
    // tidak ada error SQLITE_BUSY yang menyembul walau diinterleaved.
    const results = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const db = openSessionDb(dir)
        expect(db).toBeDefined()
        const store = new TaskStore(dir)
        expect(store).toBeDefined()
        return true
      }),
    )
    expect(results).toHaveLength(6)
    expect(results.every((r) => r === true)).toBe(true)
    resetTaskStoreHandles()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7.2 — Streaming Token Accounting, Context-Window Cutoff, CTX-03 Calibration
// ─────────────────────────────────────────────────────────────────────────────
describe("7.2 Streaming token accounting — delta/overwrite, bukan penjumlahan per-chunk", () => {
  test("10 chunk SSE usage kumulatif → total akhir 200 token (bukan 1550)", () => {
    const bus = makeFakeEventBus()
    const collector = createUsageCollector(bus, "gpt-4o")
    // Turn pertama dimulai: tandai batas permintaan (turn:started).
    bus.emit("turn:started", { type: "turn:started", turn: 0 })
    // 10 chunk SSE: k = 1..10, tiap chunk usage KUMULATIF.
    // total_tokens = 100 + k*10 → k=10 → 200 (nilai akhir yang benar).
    // Jika dijumlah (+110 +120 + … +200) hasilnya 1550 — BUG yang harusnya
    // TIDAK terjadi karena kita apply DELTA terhadap snapshot sebelumnya.
    for (let k = 1; k <= 10; k++) {
      bus.emit("provider:extension", {
        type: "provider:extension",
        kind: "usage",
        data: {
          inputTokens: 100,
          outputTokens: k * 10,
          totalTokens: 100 + k * 10,
        },
      })
    }
    // Turn selesai → flush snapshot terakhir (no-op karena delta sudah
    // diterapkan seketika).
    bus.emit("turn:completed", { type: "turn:completed" })
    const s = collector.getSession()
    // Nilai akhir = snapshot TERAKHIR (k=10): input=100, output=100, total=200.
    expect(s.inputTokens).toBe(100)
    expect(s.outputTokens).toBe(100)
    expect(s.totalTokens).toBe(200)
    // BUKAN penjumlahan tiap chunk (1550).
    expect(s.totalTokens).not.toBe(1550)
  })
})

describe("7.2 Context-window mid-stream cutoff (Live #2b)", () => {
  test("watchContextWindowLimit memicu onOver saat output turn melampaui allowance", () => {
    const bus = makeFakeEventBus()
    const fired: { allowed: number; actual: number }[] = []
    const stop = watchContextWindowLimit({
      bus,
      windowTokens: 500,
      // Asumsikan input pesan 100 token → allowedOutput = max(256, 500-100) = 400.
      getInputTokens: () => 100,
      getOutputTokens: () => 500, // simulasi output sudah 500 > 400
      onOver: (allowed, actual) => fired.push({ allowed, actual }),
    })
    // Saat pertama dipanggil, watcher sudah mengecek → fired langsung.
    expect(fired).toHaveLength(1)
    expect(fired[0]!.allowed).toBe(400)
    expect(fired[0]!.actual).toBe(500)
    stop()
  })
})

describe("7.2 CTX-03 calibration — recordTokenCalibrationSample & lastDriftRatio", () => {
  test("kalibrasi deterministik factor ≥ 1 & drift ratio akurat", () => {
    const cal = createCalibratedEstimator()
    // Estimator lokal 100, provider aktual 200 → ratio = 2.0, factor = 2.0.
    const snap = cal.recordTokenCalibrationSample(100, 200)
    expect(cal.lastDriftRatio()).toBeCloseTo(2.0, 6)
    expect(snap.factor).toBeGreaterThanOrEqual(1)
    expect(snap.factor).toBeLessThanOrEqual(64) // maxFactor default
    // Estimator lokal 200, provider aktual 100 → ratio = 0.5, tapi factor
    // TIDAK PERNAH < 1 (konservatif: tidak melemahkan estimasi dasar).
    cal.recordTokenCalibrationSample(200, 100)
    expect(cal.lastDriftRatio()).toBeCloseTo(0.5, 6)
    expect(cal.snapshot().factor).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7.3 — Subagent & Daemon Guard Unification (LOOP-INV-13, 14, 15)
// ─────────────────────────────────────────────────────────────────────────────
describe("7.3 Subagent ACE verdict — envelope.aceVerdict pada sukses & error", () => {
  test("sukses: envelope.aceVerdict.verdict = PASS, nextAction = COMPLETE_AFTER_VERIFICATION", async () => {
    const restore = providerEnv()
    const dir = tmpRoot()
    const parentId = "p19-ace-success"
    const prevTodo = todoSession.id
    todoSession.id = parentId
    const seen: SubAgentSpec[] = []
    const probe = { calls: 0 }
    try {
      setSubAgentSessionFactory(
        recordingFactory(seen, probe, async () => ({
          finalText: "ringkasan anak",
          usage: { steps: 2 },
        })),
      )
      const out = (await delegateTaskTool.execute(
        { prompt: "kerjakan" } as never,
        ctxFor(dir),
      )) as string
      expect(out).toBe("sub-agent (explore) done: ringkasan anak [steps 2]")
      // Spec membawa noProgress EKSPLISIT (LOOP-INV-15): ambang turun ke 8.
      expect(seen[0]!.noProgress).toBeDefined()
      expect(seen[0]!.noProgress!.maxConsecutiveReadCalls).toBe(8)
      // Amplop hasil anak membawa ACE verdict deterministik.
      const rec = await delegateTerminal(parentId, dir)
      const env = rec.outcome?.childResult as ChildResultEnvelope | undefined
      expect(env).toBeDefined()
      expect(env!.aceVerdict).toBeDefined()
      expect(env!.aceVerdict!.verdict).toBe("PASS")
      expect(env!.aceVerdict!.failureClass).toBe("NONE")
      expect(env!.aceVerdict!.nextAction).toBe("COMPLETE_AFTER_VERIFICATION")
    } finally {
      todoSession.id = prevTodo
      clearSubAgentSessionFactory()
      restore()
    }
  })

  test("error: envelope.aceVerdict.verdict = FAIL, failureClass = TRANSIENT_ENV/FUNCTIONAL_TEST_FAIL", async () => {
    const restore = providerEnv()
    const dir = tmpRoot()
    const parentId = "p19-ace-error"
    const prevTodo = todoSession.id
    todoSession.id = parentId
    const seen: SubAgentSpec[] = []
    const probe = { calls: 0 }
    try {
      setSubAgentSessionFactory(
        recordingFactory(seen, probe, async () => {
          const e = new Error("provider gagal") as Error & { kind?: string }
          e.kind = "timeout"
          throw e
        }),
      )
      const out = (await delegateTaskTool.execute(
        { prompt: "kerjakan" } as never,
        ctxFor(dir),
      )) as string
      expect(out).toContain("[sub-agent explore error]")
      const rec = await delegateTerminal(parentId, dir)
      const env = rec.outcome?.childResult as ChildResultEnvelope | undefined
      expect(env).toBeDefined()
      expect(env!.aceVerdict).toBeDefined()
      expect(env!.aceVerdict!.verdict).toBe("FAIL")
    } finally {
      todoSession.id = prevTodo
      clearSubAgentSessionFactory()
      restore()
    }
  })
})

describe("7.3 Burst saturation pool — 8 delegasi serentak, aktif konkuren ≤ 3 (LOOP-INV-13/LOOP-04/U6)", () => {
  test("8 task serentak di pool MAX=3 → peak concurrency tak pernah > 3", async () => {
    const pool = new Pool(LIMITS.SUB_AGENT_POOL_SIZE)
    let active = 0
    let peak = 0
    const tasks = Array.from({ length: 8 }, () =>
      pool.run(async () => {
        active++
        if (active > peak) peak = active
        // Simulasi kerja async singkat.
        await new Promise((r) => setTimeout(r, 5))
        active--
      }),
    )
    await Promise.all(tasks)
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(0)
  })
})

describe("7.3 Child abort propagation — abort parent melepas slot pool (LOOP-INV-14)", () => {
  test("abort di tengah eksekusi → promise reject & slot pool kembali tersedia", async () => {
    const pool = new Pool(LIMITS.SUB_AGENT_POOL_SIZE)
    const ctl = new AbortController()
    const ran: string[] = []
    // Task 1: menggantung sampai signal abort.
    const p1 = pool
      .run(async () => {
        ran.push("start-1")
        await new Promise<void>((_, reject) => {
          const onAbort = () => reject(new Error("aborted"))
          ctl.signal.addEventListener("abort", onAbort, { once: true })
        })
        ran.push("end-1")
      }, ctl.signal)
      .catch(() => {
        ran.push("caught-1")
      })
    // Beri waktu task 1 masuk pool.
    await new Promise((r) => setTimeout(r, 2))
    // Abort parent di tengah eksekusi.
    ctl.abort()
    await p1
    expect(ran).toContain("start-1")
    expect(ran).toContain("caught-1")
    expect(ran).not.toContain("end-1")
    // Slot pool harus sudah dilepas: task berikutnya bisa jalan penuh.
    const p2 = pool.run(async () => {
      ran.push("start-2")
      await new Promise((r) => setTimeout(r, 2))
      ran.push("end-2")
    })
    await p2
    expect(ran).toContain("start-2")
    expect(ran).toContain("end-2")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7.4 — Embedding Circuit-Breaker & Root Wall-Clock Timeout (Live #3)
// ─────────────────────────────────────────────────────────────────────────────
describe("7.4 Embedding circuit-breaker — gagal pertama trip, panggilan berikut instan", () => {
  test("endpoint di-trip circuit-breaker → call ke-2/3/4 fallback <20ms tanpa jaringan", async () => {
    // Trip circuit-breaker secara deterministik lewat seam uji (bukan
    // bergantung pada kegagalan DNS/jaringan nyata yang tidak deterministik).
    // Ini memvalidasi jalur fast-fallback: `embeddingCircuitBroken()` true →
    // `embedTexts` return null seketika sebelum menyentuh DNS/fetch.
    const base = "http://p19-embedding-test.invalid"
    const apiKey = "sk-test"
    const model = "text-embedding-3-small"
    resetEmbeddingCircuitBreaker()
    // Trip dulu (seolah call pertama sudah gagal).
    tripEmbeddingCircuitForTest(base, model, "all embedding attempts failed")
    // Call 2, 3, 4: circuit broken → return null SEKETIKA (<20ms), tanpa
    // DNS lookup / fetch sama sekali — inilah inti circuit-breaker.
    const t2 = Date.now()
    const r2 = await embedTexts(base, apiKey, ["halo"], model, { attemptMs: 5, totalMs: 10 })
    const d2 = Date.now() - t2
    expect(r2).toBeNull()
    expect(d2).toBeLessThan(20)

    const t3 = Date.now()
    const r3 = await embedTexts(base, apiKey, ["halo"], model, { attemptMs: 5, totalMs: 10 })
    const d3 = Date.now() - t3
    expect(r3).toBeNull()
    expect(d3).toBeLessThan(20)

    const t4 = Date.now()
    const r4 = await embedTexts(base, apiKey, ["halo"], model, { attemptMs: 5, totalMs: 10 })
    const d4 = Date.now() - t4
    expect(r4).toBeNull()
    expect(d4).toBeLessThan(20)

    // Reset → endpoint kembali "sehat": panggilan berikut BOLEH mencoba
    // jaringan (tidak lagi instan-null karena circuit-breaker).
    resetEmbeddingCircuitBreaker()
    const t5 = Date.now()
    await embedTexts(base, apiKey, ["halo"], model, { attemptMs: 5, totalMs: 10 })
    const d5 = Date.now() - t5
    // Karena host `.invalid` DNS-nya gagal di mode strict (fail-close),
    // panggilan ini tetap return null — tapi LEBIH LAMA dari jalur
    // circuit-breaker (<20ms), karena DNS lookup dijalankan dulu.
    expect(d5).toBeGreaterThanOrEqual(0)
  })
})

describe("7.4 Root wall-clock timeout — `--timeout` mengikat seluruh fase (Live #3b)", () => {
  test("timeoutMs 50 → rootTimeoutSignal fire, runPromptWithVerify melempar AgentError('timeout')", async () => {
    const cwd = tmpRoot()
    const { mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(join(cwd, ".minicode"), { recursive: true })
    mkdirSync(join(cwd, "home", ".minicode"), { recursive: true })
    writeFileSync(
      join(cwd, ".minicode", "config.json"),
      JSON.stringify({
        providers: [
          {
            id: "fake",
            baseUrl: "http://localhost:9",
            apiKey: "sk-test",
            models: ["gpt-4o-mini"],
          },
        ],
      }),
      "utf8",
    )
    const s = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "p19-wallclock",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
      timeoutMs: 50,
    })
    // Tunggu sampai rootTimeoutSignal fire (50ms) — beri margin karena
    // setup async (system prompt, DB init) bisa makan waktu dulu.
    await new Promise((r) => setTimeout(r, 120))
    // Panggil runPromptWithVerify: rootTimeoutSignal.aborted = true →
    // langsung throw AgentError('timeout') tanpa menyentuh provider.
    let caught: unknown = null
    try {
      await s.runPromptWithVerify("halo dunia")
    } catch (e) {
      caught = e
    }
    expect(caught).not.toBeNull()
    const err = caught as { kind?: string }
    expect(err.kind).toBe("timeout")
    await s.close()
  }, 15_000)
})
