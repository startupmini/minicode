// Benchmark runner: jalankan tugas sample terhadap minicode, ukur resolve rate,
// steps, token, durasi. `--fake` untuk smoke tanpa API key (dipakai CI).
// `--runs <n>`: jumlah run per task (default 1; 2 = stabil/median).
// `--memory on|off`: RAG + auto-memory nyala/mati (ukur nilai memory diferensial).
// `--model <provider::model>`: pin model (default: router default).
// `--provider <id>`: batasi ke satu provider (WAJIB untuk run berbayar).
// `--max-steps <n>`, `--timeout <ms>`: rem biaya per task.
// `--tasks <path.json>`: ganti BENCH_TASKS dengan task eksternal.
// `--out <path>`: file laporan JSON (default bench/results.json).
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelProvider } from "#minicore"
import { createRagLayer } from "../src/app/rag-layer.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import { loadConfig } from "../src/config.ts"
import { addMemory } from "../src/memory/vector.ts"
import { createUsageCollector } from "../src/policy/usage.ts"
import { buildProviderList } from "../src/providers/build.ts"
import { createRouterProvider } from "../src/providers/router.ts"
import { allTools } from "../src/tools/index.ts"
import { BENCH_TASKS, loadExternalTasks } from "./tasks.ts"

const fake = process.argv.includes("--fake")
const runsArgIdx = process.argv.indexOf("--runs")
const runs =
  runsArgIdx !== -1 && Number(process.argv[runsArgIdx + 1]) > 0
    ? Number(process.argv[runsArgIdx + 1])
    : 1
const memIdx = process.argv.indexOf("--memory")
const memoryOn = memIdx === -1 || (process.argv[memIdx + 1] ?? "on").toLowerCase() !== "off"
const outIdx = process.argv.indexOf("--out")
const outPath =
  outIdx !== -1 && process.argv[outIdx + 1] ? process.argv[outIdx + 1]! : "bench/results.json"

// Audit #14: baterai live butuh kontrol biaya — model/provider/steps/timeout
// eksplisit agar run tak liar (default kernel: 50 steps, 600s, provider pertama).
const strFlag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : undefined
}
const numFlag = (name: string): number | undefined => {
  const v = strFlag(name)
  const n = v == null ? NaN : Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
const benchModel = strFlag("--model")
const benchProvider = strFlag("--provider")
const benchMaxSteps = numFlag("--max-steps")
const benchTimeoutMs = numFlag("--timeout")

async function main(): Promise<void> {
  let provider: ModelProvider
  if (fake) {
    provider = {
      id: "fake",
      models: ["fake"],
      async *stream() {
        yield { type: "text", text: "done" }
        yield { type: "finish", reason: "stop" }
      },
    }
  } else {
    const cfg = await loadConfig()
    let providers = buildProviderList(cfg)
    // Pin provider bila diminta (--provider <id>): tanpa ini router default =
    // provider pertama config, dan baterai bayar bisa jalan di model salah.
    if (benchProvider) {
      const kept = providers.filter((p) => (p as unknown as { id?: string }).id === benchProvider)
      if (kept.length === 0) {
        console.error(`[bench] provider "${benchProvider}" tidak ada di config`)
        process.exit(1)
      }
      providers = kept
    }
    if (providers.length === 0) {
      console.error("no provider configured — jalankan setup wizard, atau pakai --fake")
      process.exit(1)
    }
    provider = createRouterProvider({ providers })
  }

  // --tasks <path.json>: muat task eksternal (SWE-bench-format) — ganti BENCH_TASKS
  let tasks = BENCH_TASKS
  const tasksPathIdx = process.argv.indexOf("--tasks")
  if (tasksPathIdx !== -1 && process.argv[tasksPathIdx + 1]) {
    tasks = await loadExternalTasks(process.argv[tasksPathIdx + 1]!)
  }

  // aggregator per task: median dari n run agar outlier provider tidak menyesatkan
  const results: Record<string, unknown>[] = []
  const perTask = new Map<
    string,
    { passed: number; durations: number[]; tokens: number[]; memoryHits: number[] }
  >()
  // HOME hermetic per run: DB/memory/sesi global tak bocor antar run dan tak
  // menyentuh ~/.minicode operator. Disimpan per run agar seed memory terisolasi.
  const prevHome = process.env.MINICODE_HOME
  const prevAutoMem = process.env.MINICODE_AUTO_MEMORY
  if (!memoryOn) process.env.MINICODE_AUTO_MEMORY = "0"
  for (const task of tasks) {
    const stats = {
      passed: 0,
      durations: [] as number[],
      tokens: [] as number[],
      memoryHits: [] as number[],
    }
    for (let r = 0; r < runs; r++) {
      const dir = await task.setup()
      const homeTmp = await mkdtemp(join(tmpdir(), "minicode-bench-home-"))
      process.env.MINICODE_HOME = homeTmp
      let memoryHits = 0
      let steps = 0
      let error: string | undefined
      try {
        // Seed memory global run ini (hanya bila memory on + task memintanya).
        if (memoryOn && task.seedMemory) {
          await addMemory(task.seedMemory, { cwd: homeTmp }).catch(() => {})
        }
        // RAG seperti jalur CLI asli (bukan sesi telanjang) agar memoryHits
        // terukur; mode off = tanpa systemExtra sama sekali.
        let systemExtra: string | undefined
        if (memoryOn) {
          try {
            const rag = await createRagLayer({
              cfg: { providers: [] },
              prompt: task.prompt,
              cwd: dir,
            })
            systemExtra = rag.systemExtra
            memoryHits = rag.memoryHits
          } catch {}
        }
        const session = await createMinicodeSession({
          provider,
          tools: allTools,
          cwd: dir,
          permissionMode: "auto",
          ...(systemExtra ? { systemExtra } : {}),
          ...(benchMaxSteps ? { maxSteps: benchMaxSteps } : {}),
          ...(benchTimeoutMs ? { timeoutMs: benchTimeoutMs } : {}),
        })
        const usage = createUsageCollector(session.events)
        const t0 = Date.now()
        try {
          const res = await session.run(task.prompt, benchModel ? { model: benchModel } : {})
          steps = res.usage.steps
        } catch (e) {
          error = (e as Error).message
        }
        const durationMs = Date.now() - t0
        const u = usage.get()
        const rawVerify = await task.verify(dir)
        // --fake: provider palsu tak pernah benar-benar mengedit file → anggap passed bila harness jalan tanpa error
        const verify = fake ? { ...rawVerify, passed: true } : rawVerify
        await task.cleanup(dir)
        const passed = verify.passed && !error
        stats.passed += passed ? 1 : 0
        stats.durations.push(durationMs)
        stats.tokens.push(u.totalTokens)
        stats.memoryHits.push(memoryHits)
        process.stdout.write(
          `${passed ? "PASS" : "FAIL"} ${task.id} run=${r + 1}/${runs} steps=${steps} tokens=${u.totalTokens} memHits=${memoryHits} ${durationMs}ms${error ? ` error=${error.slice(0, 80)}` : ""}\n`,
        )
        // jeda antar task untuk hindari rate limit (provider gratis/quota)
        if (!fake && error?.includes("429")) await new Promise((r) => setTimeout(r, 10000))
      } catch (e) {
        // Setup/session gagal total (bukan model error): catat, bersih, lanjut.
        process.stdout.write(
          `ERROR ${task.id} run=${r + 1}/${runs} ${(e as Error).message.slice(0, 80)}\n`,
        )
        await task.cleanup(dir).catch(() => {})
      } finally {
        await rm(homeTmp, { recursive: true, force: true }).catch(() => {})
      }
    }
    perTask.set(task.id, stats)
    const median = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]!
    results.push({
      id: task.id,
      description: task.description,
      runs,
      passedCount: stats.passed,
      medianDurationMs: median(stats.durations),
      medianTokens: median(stats.tokens),
      medianMemoryHits: median(stats.memoryHits),
    })
  }
  if (prevHome === undefined) delete process.env.MINICODE_HOME
  else process.env.MINICODE_HOME = prevHome
  if (prevAutoMem === undefined) delete process.env.MINICODE_AUTO_MEMORY
  else process.env.MINICODE_AUTO_MEMORY = prevAutoMem

  const resolved = results.filter((r) => (r as { passedCount: number }).passedCount === runs).length
  const partial = results.filter(
    (r) =>
      (r as { passedCount: number }).passedCount > 0 &&
      (r as { passedCount: number }).passedCount < runs,
  ).length
  const summary = {
    timestamp: new Date().toISOString(),
    fake,
    runsPerTask: runs,
    memory: memoryOn ? "on" : "off",
    model: benchModel ?? null,
    provider: benchProvider ?? null,
    maxSteps: benchMaxSteps ?? null,
    timeoutMs: benchTimeoutMs ?? null,
    total: results.length,
    resolved,
    partial,
    resolveRate: results.length ? Number((resolved / results.length).toFixed(3)) : 0,
  }
  // Delta vs run sebelumnya
  let deltaLine = ""
  try {
    if (existsSync(outPath)) {
      const prev = JSON.parse(readFileSync(outPath, "utf8")) as {
        resolveRate?: number
        timestamp?: string
      }
      if (typeof prev.resolveRate === "number") {
        const delta = summary.resolveRate - prev.resolveRate
        const sign = delta > 0 ? "+" : ""
        deltaLine = `  delta: ${sign}${(delta * 100).toFixed(1)}% (prev ${prev.resolveRate} @ ${String(prev.timestamp).slice(0, 10)})\n`
      }
    }
  } catch {}
  writeFileSync(outPath, JSON.stringify({ ...summary, results }, null, 2))
  process.stdout.write(
    `\nresolve rate: ${resolved}/${results.length} (${summary.resolveRate})${partial ? ` (${partial} partial)` : ""}\n${deltaLine}`,
  )
}

main().catch((e) => {
  console.error(`[bench] ${(e as Error).message}`)
  process.exit(1)
})
