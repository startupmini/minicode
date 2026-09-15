#!/usr/bin/env bun
// Eval gate agregat untuk baterai kepintaran (audit #14).
//
// Mirip coverage-gate: ambang dikunci di sini, dinaikkan bila baterai
// mengalahkan ambang secara stabil. Menolak angka n=1 dikutip sebagai
// peringkat — gate hanya menilai run yang diberikan, bukan mengklaimnya.
//
// Usage:
//   bun bench/eval-gate.ts [--results bench/results.json]
//     [--min-rate 1] [--max-median-tokens 0=tanpa-batas] [--allow-partial]
//
// Exit 0 = lolos; 1 = gagal (dengan baris FAIL yang jelas).

interface TaskResult {
  id?: string
  passedCount?: number
  runs?: number
  medianTokens?: number
}

interface EvalSummary {
  resolveRate?: number
  results?: TaskResult[]
  runsPerTask?: number
  model?: string | null
  timestamp?: string
}

export interface GateOptions {
  minRate: number
  maxMedianTokens: number // 0 = tanpa batas
  allowPartial: boolean
}

export interface GateVerdict {
  ok: boolean
  failures: string[]
  summary: string
}

/** Murni + diekspor agar bisa diuji tanpa file (pola repo). */
export function evaluateGate(summary: EvalSummary, opts: GateOptions): GateVerdict {
  const failures: string[] = []
  const rate = typeof summary.resolveRate === "number" ? summary.resolveRate : NaN
  if (!Number.isFinite(rate)) {
    failures.push("resolveRate hilang/bukan angka di results")
  } else if (rate < opts.minRate) {
    failures.push(`resolve rate ${rate} < min ${opts.minRate}`)
  }
  const results = Array.isArray(summary.results) ? summary.results : []
  if (results.length === 0) failures.push("tidak ada hasil task di results")
  for (const r of results) {
    const id = r.id ?? "(tanpa-id)"
    const runs = r.runs ?? summary.runsPerTask ?? 1
    const passed = r.passedCount ?? 0
    if (passed < runs && !(opts.allowPartial && passed > 0)) {
      failures.push(`task ${id}: ${passed}/${runs} lolos`)
    }
    if (opts.maxMedianTokens > 0 && typeof r.medianTokens === "number") {
      if (r.medianTokens > opts.maxMedianTokens) {
        failures.push(`task ${id}: median ${r.medianTokens} token > max ${opts.maxMedianTokens}`)
      }
    }
  }
  const ok = failures.length === 0
  const model = summary.model ? ` model=${summary.model}` : ""
  return {
    ok,
    failures,
    summary: ok
      ? `[eval-gate] PASS rate=${rate}${model} (${results.length} task)`
      : `[eval-gate] FAIL (${failures.length}): ${failures.slice(0, 5).join("; ")}`,
  }
}

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : undefined
}

if (import.meta.main) {
  const path = getArg("--results") ?? "bench/results.json"
  const minRate = Number(getArg("--min-rate") ?? "1")
  const maxMedianTokens = Number(getArg("--max-median-tokens") ?? "0")
  const allowPartial = process.argv.includes("--allow-partial")
  let summary: EvalSummary
  try {
    const { readFileSync } = await import("node:fs")
    const raw = JSON.parse(readFileSync(path, "utf8")) as { summary?: EvalSummary } & EvalSummary
    summary = (raw.summary ?? raw) as EvalSummary
  } catch (e) {
    console.error(`[eval-gate] tak bisa baca ${path}: ${(e as Error).message}`)
    process.exit(1)
  }
  const verdict = evaluateGate(summary, {
    minRate: Number.isFinite(minRate) ? minRate : 1,
    maxMedianTokens: Number.isFinite(maxMedianTokens) ? maxMedianTokens : 0,
    allowPartial,
  })
  console.log(verdict.summary)
  for (const f of verdict.failures) console.error(`  - ${f}`)
  process.exit(verdict.ok ? 0 : 1)
}
