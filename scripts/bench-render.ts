// P2.2 — reproducible rendering/event benchmark (no live provider).
//
// Workloads are synthetic and deterministic. The goal is to expose tail
// latency and projection/recompute cost, not to emulate a model. Run with:
//   bun scripts/bench-render.ts [--json]
//
// Warm-up runs are discarded. p50/p95/max are reported, plus a simple
// throughput number. No network, no terminal, no timers.

import type { DomainEvent } from "../src/presentation/events.ts"
import { createInitialState, reduce } from "../src/presentation/reducer.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "../test/helpers/tui-harness.ts"

const JSON_OUT = process.argv.includes("--json")

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx] ?? 0
}

function measure(name: string, iters: number, fn: () => void): BenchRow {
  for (let i = 0; i < Math.min(3, iters); i++) fn()
  const times: number[] = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const total = times.reduce((a, b) => a + b, 0)
  return {
    name,
    iters,
    p50Ms: round(percentile(times, 50)),
    p95Ms: round(percentile(times, 95)),
    maxMs: round(times[times.length - 1] ?? 0),
    meanMs: round(total / times.length),
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

interface BenchRow {
  name: string
  iters: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  meanMs: number
}

function transcriptWith(lines: number, make: (i: number) => string): Transcript {
  const t = new Transcript(createFakeBus() as never)
  for (let i = 0; i < lines; i++) {
    t.push(make(i), { kind: i % 3 === 0 ? "assistant" : "system" })
  }
  return t
}

function shortLine(i: number): string {
  return i % 5 === 0 ? `## heading ${i}` : `tool ${i} completed target/file-${i}.ts`
}

function longProse(i: number): string {
  return `assistant answer ${i}: ${"lorem ipsum dolor sit amet ".repeat(4)}`
}

function unicodeLine(i: number): string {
  return `中文测试 ${i} 🚀 emoji ✅ ${"データ".repeat(3)}`
}

function benchTranscripts(): { rows: BenchRow[]; heapDeltaKb: number } {
  const before = process.memoryUsage().heapUsed
  const short = transcriptWith(50, shortLine)
  const long = transcriptWith(2000, shortLine)
  const prose = transcriptWith(1000, longProse)
  const unicode = transcriptWith(1000, unicodeLine)

  const rows: BenchRow[] = []
  rows.push(measure("short-50 / view 80x24", 60, () => void short.view(80, 24, 0)))
  rows.push(measure("long-2000 / view 80x24", 30, () => void long.view(80, 24, 0)))
  rows.push(measure("long-2000 / scroll back 500", 30, () => void long.view(80, 24, 500)))
  rows.push(measure("long-2000 / resize 40x24", 20, () => void long.view(40, 24, 0)))
  rows.push(measure("long-2000 / resize 120x24", 20, () => void long.view(120, 24, 0)))
  rows.push(measure("prose-1000 / view 100x30", 30, () => void prose.view(100, 30, 0)))
  rows.push(measure("unicode-1000 / view 80x24", 30, () => void unicode.view(80, 24, 0)))
  rows.push(measure("long-2000 / wrappedLength", 30, () => void long.wrappedLength(80)))

  // Streaming burst: 500 deltas, then one viewport. Measures event processing
  // plus pending-block projection (the live tail is intentionally not cached).
  const burst = new Transcript(createFakeBus() as never)
  rows.push(
    measure("burst-500 deltas + view", 15, () => {
      for (let i = 0; i < 500; i++) burst.stream(`token-${i} `)
      void burst.view(80, 24, 0)
    }),
  )

  // Many tool-like ledger lines (committed), then viewport.
  const tools = transcriptWith(1000, (i) => `✓ tool-${i} target-${i} completed`)
  rows.push(measure("tools-1000 / view 80x24", 30, () => void tools.view(80, 24, 0)))

  // Approval/status/diagnostic style lines mixed in.
  const mixed = new Transcript(createFakeBus() as never)
  for (let i = 0; i < 500; i++) {
    mixed.push(i % 4 === 0 ? `▪ t${i} completed [unverified]` : shortLine(i), {
      kind: i % 2 === 0 ? "assistant" : "system",
    })
  }
  rows.push(measure("mixed-500 ledger / view 80x24", 30, () => void mixed.view(80, 24, 0)))

  const heapDeltaKb = Math.round((process.memoryUsage().heapUsed - before) / 1024)
  return { rows, heapDeltaKb }
}

function benchReducer(): BenchRow[] {
  const rows: BenchRow[] = []
  rows.push(
    measure("reducer / 5000 tool events", 15, () => {
      let state = createInitialState("bench")
      for (let i = 0; i < 5000; i++) {
        const ev = toolEvent(i)
        state = reduce(state, ev)
      }
    }),
  )
  rows.push(
    measure("reducer / 1000 turn events", 20, () => {
      let state = createInitialState("bench")
      for (let i = 0; i < 1000; i++) {
        state = reduce(state, turnEvent(i))
      }
    }),
  )
  return rows
}

function base(seq: number, type: string): Record<string, unknown> {
  return { eventSeq: seq, ts: 1000 + seq, sessionId: "bench", turnId: 1, type, v: 1 }
}

function toolEvent(i: number): DomainEvent {
  return {
    ...base(i, "tool.completed"),
    type: "tool.completed",
    toolCallId: `call-${i}`,
    stepId: 1,
    identity: { origin: "builtin", name: "read_file", qualified: "read_file" },
    argsSummary: { target: `file-${i}.ts` },
    status: "completed",
    durationMs: 1,
    summary: `ok ${i}`,
  } as unknown as DomainEvent
}

function turnEvent(i: number): DomainEvent {
  return {
    ...base(i, "turn.completed"),
    type: "turn.completed",
    summary: {
      ok: true,
      steps: 1,
      tools: 1,
      toolsFailed: 0,
      toolsDenied: 0,
      filesChanged: 0,
      durationMs: 1,
    },
  } as unknown as DomainEvent
}

const { rows: renderRows, heapDeltaKb } = benchTranscripts()
const reducerRows = benchReducer()

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        runtime: "bun",
        heapDeltaKb,
        rows: [...renderRows, ...reducerRows],
      },
      null,
      2,
    ),
  )
} else {
  console.log("P2 render/event benchmark (synthetic, no provider)")
  console.log(
    [
      "workload".padEnd(34),
      "p50".padStart(9),
      "p95".padStart(9),
      "max".padStart(9),
      "mean".padStart(9),
    ].join(" "),
  )
  for (const r of [...renderRows, ...reducerRows]) {
    console.log(
      [
        r.name.padEnd(34),
        `${r.p50Ms}ms`.padStart(9),
        `${r.p95Ms}ms`.padStart(9),
        `${r.maxMs}ms`.padStart(9),
        `${r.meanMs}ms`.padStart(9),
      ].join(" "),
    )
  }
  console.log(`heap delta after transcript build: ${heapDeltaKb} KiB`)
}
