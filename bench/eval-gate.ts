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
//     [--observe-tokens]
//
// Exit 0 = lolos; 1 = gagal (dengan baris FAIL yang jelas).
// --observe-tokens = pelanggaran token jadi peringatan (exit tetap 0 bila
// rate lolos) — untuk 2–3 run pertama sebelum ambang dikunci.

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
  /** F2.2 mode observasi (keputusan pemilik): pelanggaran token dicatat
   * sebagai peringatan, TIDAK menggagalkan. Dipakai 2–3 run pertama untuk
   * mengunci ambang yang realistis sebelum menegakkannya. */
  observeTokens?: boolean
}

export interface GateVerdict {
  ok: boolean
  failures: string[]
  /** Peringatan observasi: tak memengaruhi ok. */
  warnings: string[]
  summary: string
}

/** Murni + diekspor agar bisa diuji tanpa file (pola repo). */
export function evaluateGate(summary: EvalSummary, opts: GateOptions): GateVerdict {
  const failures: string[] = []
  const warnings: string[] = []
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
      const msg = `task ${id}: median ${r.medianTokens} token > max ${opts.maxMedianTokens}`
      // Mode observasi: catat, jangan gagalkan (ambang belum dikunci).
      if (r.medianTokens > opts.maxMedianTokens) {
        if (opts.observeTokens) warnings.push(`[observe] ${msg}`)
        else failures.push(msg)
      }
    }
  }
  const ok = failures.length === 0
  const model = summary.model ? ` model=${summary.model}` : ""
  const warnSuffix = warnings.length ? ` (+${warnings.length} observe)` : ""
  return {
    ok,
    failures,
    warnings,
    summary: ok
      ? `[eval-gate] PASS rate=${rate}${model} (${results.length} task)${warnSuffix}`
      : `[eval-gate] FAIL (${failures.length}): ${failures.slice(0, 5).join("; ")}${warnSuffix}`,
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
  const observeTokens = process.argv.includes("--observe-tokens")
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
    observeTokens,
  })
  console.log(verdict.summary)
  for (const f of verdict.failures) console.error(`  - ${f}`)
  for (const w of verdict.warnings) console.log(`  ~ ${w}`)
  process.exit(verdict.ok ? 0 : 1)
}
