// Benchmark hot-path KETIKAN TUI (composer), tanpa terminal nyata/jaringan.
//
// [KENAPA] `bench-render.ts` mengukur transkrip/reducer, bukan jalur yang
// dieksekusi ULANG tiap keypress. Keluhan "TUI terasa lambat saat mengetik"
// hanya bisa dijawab dengan mengukur TuiApp sungguhan: applyKey → wrap
// composer (baris+kursor sekali) → getStatus/renderFooter → diff-write. Skrip ini
// memakai fake TTY in-process supaya paint tetap SINKRON (sama seperti
// produksi) tanpa round-trip PTY yang menutupi biaya CPU.
//
// Dua bagian:
//   1. per-keystroke  — TuiApp + fake TTY, p50/p95/max per key.
//   2. komponen       — batch-mean fungsi murni (applyKey, wrap, footer,
//                       resolveContextWindow) untuk atribusi biaya.
//
// Angka absolut bergantung mesin. Yang bermakna: RASIO antar komponen dan
// delta sebelum/sesudah perbaikan pada mesin yang sama. TIDAK ada ambang dan
// TIDAK dipakai sebagai gerbang CI.
//
// Jalankan manual:
//   bun scripts/bench-typing.ts [--json]

import type { MinicodeConfig } from "../src/config.ts"
import { __setContextWindowOverlay, resolveContextWindow } from "../src/policy/context-window.ts"
import { renderFooter } from "../src/ui/footer.ts"
import { setSessionLocale } from "../src/ui/i18n/locale.ts"
import { applyKey, toGraphemes } from "../src/ui/input/prompt-engine.ts"
import { chunkByWidth } from "../src/ui/render/width.ts"
import { TuiApp, type TuiHost, type TuiStatusSnapshot } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "../test/helpers/tui-harness.ts"

const JSON_OUT = process.argv.includes("--json")
const COLS = 100
const ROWS = 30
const MODEL = "deepseek-v4.1-flash-free"
const UNLISTED_MODEL = "unlisted-long-tail-model"
const PROMPT_PREFIX = "› "

// ── Fake TTY minimal ────────────────────────────────────────────────────────
//
// test/helpers/tui-harness.ts sengaja menunggu ~15 ms per `send()` supaya
// assertion layar stabil. Jeda itu jauh lebih besar dari biaya paint yang mau
// diukur, jadi bench ini memakai transport sendiri: listener stdin dipanggil
// LANGSUNG, dan tulis stdout hanya dihitung (tidak diparse). Kontrak yang
// ditiru hanya yang disentuh TuiApp: isTTY, raw mode, listener data/resize,
// dan write.

interface BenchTty {
  /** Kirim satu chunk byte secara SINKRON (setara satu read dari terminal). */
  press(data: string): void
  listenerCount(): number
  writes(): number
  restore(): void
}

function installBenchTty(columns: number, rows: number): BenchTty {
  const listeners = new Set<(chunk: Buffer) => void>()
  const resizeListeners = new Set<() => void>()
  let writeCount = 0
  const origStdin = process.stdin
  const origWrite = process.stdout.write
  const origStdoutOn = process.stdout.on
  const origStdoutOff = process.stdout.off
  const origStdoutRemove = process.stdout.removeListener
  const origCols = process.stdout.columns
  const origRows = process.stdout.rows
  const origIsTTY = process.stdout.isTTY
  const origErrIsTTY = process.stderr.isTTY
  const origErrWrite = process.stderr.write
  const origTerm = process.env.TERM
  const origColorterm = process.env.COLORTERM
  const origNoColor = process.env.NO_COLOR

  const fakeStdin = {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      fakeStdin.isRaw = value
      return fakeStdin
    },
    resume() {
      return fakeStdin
    },
    pause() {
      return fakeStdin
    },
    on(event: string, fn: (chunk: Buffer) => void) {
      if (event === "data") listeners.add(fn)
      return fakeStdin
    },
    addListener(event: string, fn: (chunk: Buffer) => void) {
      return fakeStdin.on(event, fn)
    },
    once(event: string, fn: (chunk: Buffer) => void) {
      const wrapped = (chunk: Buffer) => {
        listeners.delete(wrapped)
        fn(chunk)
      }
      return fakeStdin.on(event, wrapped)
    },
    off(event: string, fn: (chunk: Buffer) => void) {
      if (event === "data") listeners.delete(fn)
      return fakeStdin
    },
    removeListener(event: string, fn: (chunk: Buffer) => void) {
      return fakeStdin.off(event, fn)
    },
    removeAllListeners() {
      listeners.clear()
      return fakeStdin
    },
    listenerCount() {
      return 0
    },
    setMaxListeners() {
      return fakeStdin
    },
    getMaxListeners() {
      return 10
    },
    setEncoding() {
      return fakeStdin
    },
  }

  Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true })
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true })
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true })
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true })
  ;(process.stdout as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (
    chunk,
  ) => {
    writeCount++
    // decode hanya agar tipe/encoding sama seperti writer asli; isinya tidak
    // diparse — bench mengukur waktu paint, bukan parsing layar.
    if (typeof chunk !== "string") new TextDecoder().decode(chunk)
    return true
  }
  ;(process.stderr as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = () =>
    true
  ;(process.stdout as unknown as { on: (event: string, fn: () => void) => void }).on = (
    event,
    fn,
  ) => {
    if (event === "resize") resizeListeners.add(fn)
  }
  ;(process.stdout as unknown as { off: (event: string, fn: () => void) => void }).off = (
    event,
    fn,
  ) => {
    if (event === "resize") resizeListeners.delete(fn)
  }
  ;(
    process.stdout as unknown as {
      removeListener: (event: string, fn: () => void) => void
    }
  ).removeListener = (event, fn) => {
    if (event === "resize") resizeListeners.delete(fn)
  }

  // Warna/glyph produksi: truecolor + VT, tanpa NO_COLOR ambient.
  process.env.TERM = "xterm-256color"
  process.env.COLORTERM = "truecolor"
  delete process.env.NO_COLOR

  return {
    press(data) {
      const buf = Buffer.from(data, "utf8")
      for (const fn of [...listeners]) fn(buf)
    },
    listenerCount: () => listeners.size,
    writes: () => writeCount,
    restore() {
      Object.defineProperty(process, "stdin", { value: origStdin, configurable: true })
      Object.defineProperty(process.stdout, "columns", { value: origCols, configurable: true })
      Object.defineProperty(process.stdout, "rows", { value: origRows, configurable: true })
      Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true })
      Object.defineProperty(process.stderr, "isTTY", { value: origErrIsTTY, configurable: true })
      ;(process.stdout as unknown as { write: typeof origWrite }).write = origWrite
      ;(process.stdout as unknown as { on: typeof origStdoutOn }).on = origStdoutOn
      ;(process.stdout as unknown as { off: typeof origStdoutOff }).off = origStdoutOff
      ;(process.stdout as unknown as { removeListener: typeof origStdoutRemove }).removeListener =
        origStdoutRemove
      ;(process.stderr as unknown as { write: typeof origErrWrite }).write = origErrWrite
      if (origTerm === undefined) delete process.env.TERM
      else process.env.TERM = origTerm
      if (origColorterm === undefined) delete process.env.COLORTERM
      else process.env.COLORTERM = origColorterm
      if (origNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = origNoColor
      resizeListeners.clear()
      listeners.clear()
    },
  }
}

// ── Konfigurasi/status realistis ────────────────────────────────────────────

function benchConfig(): MinicodeConfig {
  return {
    providers: [
      {
        id: "p0",
        baseUrl: "http://127.0.0.1:1",
        apiKey: "bench",
        models: [MODEL, "gpt-4o-mini"],
        contextWindows: { [MODEL]: 131_072, "gpt-4o-mini": 128_000 },
      },
      ...Array.from({ length: 15 }, (_, i) => ({
        id: `p${i + 1}`,
        baseUrl: "http://127.0.0.1:1",
        apiKey: "bench",
        models: Array.from({ length: 8 }, (_, j) => `model-${i}-${j}`),
      })),
    ],
  }
}

/** Overlay models.dev sintetis: memperlihatkan biaya scan linear yang nyata. */
function installOverlay(): void {
  const overlay: Record<string, number> = {}
  for (let i = 0; i < 1000; i++) overlay[`vendor-${i}-model`] = 64_000 + i
  __setContextWindowOverlay(overlay)
}

/**
 * Status footer meniru `getStatus()` di cli/tui.ts: resolve window + format
 * metrik. `model` yang tak ada di config memaksa jalur overlay models.dev.
 */
function makeGetStatus(cfg: MinicodeConfig, model: string, usedTokens: number) {
  return (): TuiStatusSnapshot => {
    const windowTokens = resolveContextWindow(cfg, model).tokens
    const pct = Math.min(100, Math.round((usedTokens / windowTokens) * 100))
    return {
      footer: {
        mode: "auto",
        strictBash: true,
        workMode: "EXECUTE",
        model,
        cwd: "D:\\Github\\minicode\\src\\ui\\tui",
        context: "42.1k",
        metrics: `$1.23 ${pct}%`,
      },
      busy: false,
    }
  }
}

function makeHost(cfg: MinicodeConfig, model: string): TuiHost {
  return {
    bus: createFakeBus() as never,
    getStatus: makeGetStatus(cfg, model, 42_100),
    listCommands: (prefix) => ["/model", "/help", "/exit"].filter((c) => c.startsWith(prefix)),
    submit: async () => {},
    copySelection: () => true,
    abort: () => {},
    cycleWorkMode: () => {},
    togglePermissionMode: () => {},
    toggleCompact: () => {},
    toggleReasoning: () => {},
  }
}

// ── Bagian 1: per-keystroke lewat TuiApp ────────────────────────────────────

interface TypingRow {
  name: string
  transcriptLines: number
  prefillChars: number
  keys: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  meanMs: number
  keysPerSec: number
}

interface BurstRow {
  name: string
  chars: number
  totalMs: number
  perCharMs: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx] ?? 0
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

async function waitForBoot(tty: BenchTty, runDone: () => boolean): Promise<void> {
  for (let i = 0; i < 5_000; i++) {
    if (tty.listenerCount() > 0 && tty.writes() > 0) return
    if (runDone()) throw new Error("TuiApp berhenti sebelum frame pertama")
    await Bun.sleep(1)
  }
  throw new Error("TuiApp tidak memasang listener/ paint awal dalam 5 dtk")
}

/** Jalankan app sampai quit; jangan biarkan satu skenario menggantung proses. */
async function quitApp(tty: BenchTty, run: Promise<unknown>): Promise<void> {
  tty.press("\x15") // Ctrl+U: kosongkan baris (sinkron, bukan lone-ESC)
  tty.press("\x04") // Ctrl+D di baris kosong = quit
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("TuiApp tidak quit setelah Ctrl+D")), 5_000)
  })
  try {
    await Promise.race([run, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function runTypingScenario(opts: {
  name: string
  transcriptLines: number
  prefillChars: number
  keys: number
  model?: string
}): Promise<TypingRow> {
  const tty = installBenchTty(COLS, ROWS)
  try {
    const cfg = benchConfig()
    const host = makeHost(cfg, opts.model ?? MODEL)
    const transcript = new Transcript(host.bus as never)
    for (let i = 0; i < opts.transcriptLines; i++) {
      transcript.push(`tool ${i} completed target/file-${i}.ts`, {
        kind: i % 3 === 0 ? "assistant" : "system",
      })
    }
    const app = new TuiApp(transcript, host)
    let done = false
    const run = app.run().finally(() => {
      done = true
    })
    await waitForBoot(tty, () => done)
    if (opts.prefillChars > 0) {
      // Bracketed paste = SATU char-key (satu paint), bukan N keypress.
      tty.press(`\x1b[200~${"x".repeat(opts.prefillChars)}\x1b[201~`)
    }
    // 10 key pemanasan dibuang: stabilkan JIT/cache sebelum sampel.
    for (let i = 0; i < 10; i++) tty.press("a")
    const samples: number[] = []
    for (let i = 0; i < opts.keys; i++) {
      const t0 = performance.now()
      tty.press("a")
      samples.push(performance.now() - t0)
    }
    await quitApp(tty, run)
    const sorted = [...samples].sort((a, b) => a - b)
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    return {
      name: opts.name,
      transcriptLines: opts.transcriptLines,
      prefillChars: opts.prefillChars,
      keys: opts.keys,
      p50Ms: round3(percentile(sorted, 50)),
      p95Ms: round3(percentile(sorted, 95)),
      maxMs: round3(sorted[sorted.length - 1] ?? 0),
      meanMs: round3(mean),
      keysPerSec: Math.round(1000 / mean),
    }
  } finally {
    tty.restore()
  }
}

/**
 * Satu chunk berisi N karakter = N key di decoder. Sejak paint digabung per
 * chunk, keduanya hanya menghasilkan SATU frame; selisih bracket-paste vs
 * chunk polos mengukur biaya parse/apply N key, bukan jumlah paint.
 */
async function runBurstScenario(opts: {
  chars: number
  bracketedPaste: boolean
}): Promise<BurstRow> {
  const tty = installBenchTty(COLS, ROWS)
  try {
    const cfg = benchConfig()
    const host = makeHost(cfg, MODEL)
    const transcript = new Transcript(host.bus as never)
    const app = new TuiApp(transcript, host)
    let done = false
    const run = app.run().finally(() => {
      done = true
    })
    await waitForBoot(tty, () => done)
    const payload = "a".repeat(opts.chars)
    const t0 = performance.now()
    tty.press(opts.bracketedPaste ? `\x1b[200~${payload}\x1b[201~` : payload)
    const totalMs = performance.now() - t0
    await quitApp(tty, run)
    return {
      name: opts.bracketedPaste
        ? `bracketed paste ${opts.chars} karakter (1 paint)`
        : `chunk ${opts.chars} karakter tanpa bracketed (1 paint)`,
      chars: opts.chars,
      totalMs: round3(totalMs),
      perCharMs: round3(totalMs / opts.chars),
    }
  } finally {
    tty.restore()
  }
}

// ── Bagian 2: komponen murni (batch mean) ───────────────────────────────────

interface ComponentRow {
  name: string
  nsPerOp: number
  opsPerSec: number
}

function measureBatch(name: string, fn: () => void, budgetMs = 100): ComponentRow {
  for (let i = 0; i < 3; i++) fn()
  let n = 1
  for (;;) {
    const t0 = performance.now()
    for (let i = 0; i < n; i++) fn()
    const dt = performance.now() - t0
    if (dt >= budgetMs || n >= 1 << 24) {
      const ns = (dt * 1e6) / n
      return {
        name,
        nsPerOp: Math.round(ns * 10) / 10,
        opsPerSec: Math.round(1e9 / ns),
      }
    }
    n *= 2
  }
}

function componentRows(): ComponentRow[] {
  const lengths = [200, 1_000, 5_000]
  const rows: ComponentRow[] = []
  const footerStatus = {
    mode: "auto",
    strictBash: true,
    workMode: "EXECUTE",
    model: MODEL,
    cwd: "D:\\Github\\minicode\\src\\ui\\tui",
    context: "42.1k",
    metrics: "$1.23 33%",
  }

  for (const len of lengths) {
    const line = "x".repeat(len)
    const state = { line, cursor: len, sel: -1, menuOpen: false }
    rows.push(
      measureBatch(`applyKey char · prompt ${len}`, () => {
        applyKey(state, { type: "char", ch: "a" }, () => [])
      }),
    )
    rows.push(
      measureBatch(`toGraphemes · prompt ${len}`, () => {
        toGraphemes(line)
      }),
    )
    rows.push(
      measureBatch(`wrap composer · prompt ${len} @${COLS}`, () => {
        chunkByWidth(`${PROMPT_PREFIX}${line}`, COLS)
      }),
    )
  }
  for (const width of [80, 100, 120]) {
    rows.push(
      measureBatch(`renderFooter · ${width} kolom`, () => {
        renderFooter(footerStatus, width)
      }),
    )
  }
  // Cache satu-entri: angka di atas adalah steady-state idle. Ukur juga jalur
  // miss (timer/spark berubah) supaya regresi render asli tetap terlihat.
  let footerTick = 0
  rows.push(
    measureBatch("renderFooter · 100 kolom (cache miss)", () => {
      footerTick++
      renderFooter({ ...footerStatus, sparkFrame: footerTick }, 100)
    }),
  )

  const cfg = benchConfig()
  installOverlay()
  rows.push(
    measureBatch("resolveContextWindow · model exact", () => {
      resolveContextWindow(cfg, MODEL)
    }),
  )
  rows.push(
    measureBatch("resolveContextWindow · katalog (gpt-4o-mini)", () => {
      resolveContextWindow(cfg, "gpt-4o-mini")
    }),
  )
  rows.push(
    measureBatch("resolveContextWindow · overlay 1000 entry", () => {
      resolveContextWindow(cfg, UNLISTED_MODEL)
    }),
  )
  return rows
}

// ── Main ────────────────────────────────────────────────────────────────────

setSessionLocale("en")
installOverlay()

const scenarios: TypingRow[] = []
scenarios.push(
  await runTypingScenario({
    name: "tanpa transkrip · prompt kosong",
    transcriptLines: 0,
    prefillChars: 0,
    keys: 200,
  }),
)
scenarios.push(
  await runTypingScenario({
    name: "transkrip 2000 baris · prompt kosong",
    transcriptLines: 2_000,
    prefillChars: 0,
    keys: 200,
  }),
)
scenarios.push(
  await runTypingScenario({
    name: "transkrip 2000 baris · prompt 1000",
    transcriptLines: 2_000,
    prefillChars: 1_000,
    keys: 60,
  }),
)
scenarios.push(
  await runTypingScenario({
    name: "transkrip 2000 baris · prompt 5000",
    transcriptLines: 2_000,
    prefillChars: 5_000,
    keys: 20,
  }),
)
scenarios.push(
  await runTypingScenario({
    name: "transkrip 2000 baris · overlay unlisted",
    transcriptLines: 2_000,
    prefillChars: 0,
    keys: 100,
    model: UNLISTED_MODEL,
  }),
)

const bursts = [
  await runBurstScenario({ chars: 500, bracketedPaste: true }),
  await runBurstScenario({ chars: 200, bracketedPaste: false }),
  await runBurstScenario({ chars: 500, bracketedPaste: false }),
]
const components = componentRows()

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        runtime: `bun ${typeof Bun !== "undefined" ? Bun.version : process.version}`,
        profile: { cols: COLS, rows: ROWS, model: MODEL, overlayEntries: 1000 },
        scenarios,
        bursts,
        components,
        limits: [
          "fake TTY in-process; bukan terminal/PTY nyata dan bukan jaringan",
          "angka absolut bergantung host; tidak ada ambang/gerbang CI",
          "cache JIT dan theme global memengaruhi run pertama",
        ],
      },
      null,
      2,
    ),
  )
} else {
  console.log("Benchmark hot-path ketikan TUI (synthetic, tanpa PTY/jaringan)")
  console.log("")
  console.log("== per-keystroke TuiApp (fake TTY, paint sinkron) ==")
  console.log(
    [
      "skenario".padEnd(42),
      "p50".padStart(9),
      "p95".padStart(9),
      "max".padStart(9),
      "keys/s".padStart(9),
    ].join(" "),
  )
  for (const row of scenarios) {
    console.log(
      [
        row.name.padEnd(42),
        `${row.p50Ms}ms`.padStart(9),
        `${row.p95Ms}ms`.padStart(9),
        `${row.maxMs}ms`.padStart(9),
        String(row.keysPerSec).padStart(9),
      ].join(" "),
    )
  }
  console.log("")
  console.log("== burst satu chunk (N key = N paint) ==")
  for (const row of bursts) {
    console.log(
      `${row.name.padEnd(42)} total ${String(row.totalMs).padStart(8)}ms  ${String(
        row.perCharMs,
      ).padStart(7)}ms/char`,
    )
  }
  console.log("")
  console.log("== komponen (batch mean, tanpa IO) ==")
  console.log(["workload".padEnd(48), "ns/op".padStart(12), "ops/s".padStart(12)].join(" "))
  for (const row of components) {
    console.log(
      [
        row.name.padEnd(48),
        String(row.nsPerOp).padStart(12),
        String(row.opsPerSec).padStart(12),
      ].join(" "),
    )
  }
}
