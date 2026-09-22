import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { type StepTrace, summarizeStepTraces } from "../../src/telemetry/trace.ts"
import { c } from "../../src/ui/render/theme.ts"

interface TraceRow {
  ok?: boolean
  inputTokens?: number
  outputTokens?: number
  cost?: number
  durationMs?: number
}

export async function handleStats(getArg: (name: string) => string | undefined): Promise<never> {
  const cwdArg = getArg("--cwd")
  const asJson = getArg("--json") !== undefined || process.argv.includes("--json")
  const file = resolve(cwdArg ?? ".", ".minicode", "traces.jsonl")
  let traces: TraceRow[] = []
  try {
    traces = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as TraceRow]
        } catch {
          return []
        }
      })
  } catch {}
  const total = traces.length
  const ok = traces.filter((t) => t.ok).length
  const inputTokens = traces.reduce((s, t) => s + (t.inputTokens ?? 0), 0)
  const outputTokens = traces.reduce((s, t) => s + (t.outputTokens ?? 0), 0)
  const cost = traces.reduce((s, t) => s + (t.cost ?? 0), 0)
  const avgMs = total ? Math.round(traces.reduce((s, t) => s + (t.durationMs ?? 0), 0) / total) : 0

  // Harness-P3: agregat step-trace (P1.2) — deny-rate, tool bermasalah,
  // mode sandbox. Berkas tak ada/rusak = nol, bukan crash.
  let stepRows: StepTrace[] = []
  try {
    stepRows = readFileSync(resolve(cwdArg ?? ".", ".minicode", "step-traces.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as StepTrace]
        } catch {
          return []
        }
      })
  } catch {}
  const steps = summarizeStepTraces(stepRows)

  // --json dulu diterima tanpa keluhan lalu diabaikan; kini benar-benar bekerja.
  if (asJson) {
    console.log(
      JSON.stringify({
        runs: total,
        resolved: ok,
        inputTokens,
        outputTokens,
        cost,
        avgMs,
        steps,
      }),
    )
    process.exit(0)
  }
  console.log(
    `Runs: ${total} · Resolved: ${ok}/${total} · Tokens in=${inputTokens} out=${outputTokens} · Cost: $${cost.toFixed(4)} · Avg ${avgMs}ms`,
  )
  if (total === 0) console.log(c.dim(`  (no traces yet in ${file})`))
  if (steps.tools > 0) {
    const topDeny = steps.topDenied.map((t) => `${t.tool}×${t.n}`).join(", ")
    const topReason = steps.topDenyReasons.map((r) => `${r.reason}×${r.n}`).join(", ")
    // F1.2: peak token kumulatif antar step — satu angka "seboros apa sesi ini".
    const peak = steps.peakTotalTokens > 0 ? ` · Peak tok: ${steps.peakTotalTokens}` : ""
    console.log(
      `Tools: ${steps.tools} · Denied: ${steps.denied} (${(steps.denyRate * 100).toFixed(1)}%) · Errors: ${steps.errors}${topDeny ? ` · Top denied: ${topDeny}` : ""}${topReason ? ` · Reason: ${topReason}` : ""}${steps.sandboxes.length ? ` · Sandbox: ${steps.sandboxes.join(",")}` : ""}${peak}`,
    )
  }
  process.exit(0)
}
