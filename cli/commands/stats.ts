import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { RuntimeView } from "../../src/runtime/runtime-status.ts"
import { currentRuntimeView } from "../../src/runtime/runtime-status-provider.ts"
import { type StepTrace, summarizeStepTraces } from "../../src/telemetry/trace.ts"
import { c } from "../../src/ui/render/theme.ts"

interface TraceRow {
  ok?: boolean
  inputTokens?: number
  outputTokens?: number
  cost?: number
  durationMs?: number
}

/**
 * Ringkasan status runtime untuk output manusia.
 *
 * Memakai model kanonik yang SAMA dengan yang dipakai daemon (runtime-status.ts)
 * — bukan hitungan status sendiri. Kalau perhitungan ini diulang di tempat
 * lain, kita punya dua sumber status; itu yang dilarang pemilik repo ini.
 */
function runtimeStatusSummary(view: RuntimeView): string {
  const caps = view.advertisedCapabilities.length > 0 ? view.advertisedCapabilities.join(",") : "-"
  const missing =
    view.unavailableCapabilities.length > 0
      ? ` · tak-tersedia=${view.unavailableCapabilities.join(",")}`
      : ""
  const note = view.note ? ` · ${view.note}` : ""
  return `phase=${view.phase} · admission=${view.admission} · health=${view.health} · termination=${view.termination} · bukti=${view.evidenceState} · kapabilitas=${caps} · anak-ter-supervisi=${view.supervisedChildren}${missing}${note}`
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

  // [P13.1] Status runtime: dari model kanonik, bukan sumber status kedua.
  // Proses `minicode stats` berdiri sendiri (tak ada sesi runtime di dalamnya),
  // jadi view-nya ABSENT — itu jawaban jujur, bukan kegagalan.
  const runtimeView = currentRuntimeView()

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
        runtime: runtimeView,
      }),
    )
    process.exit(0)
  }
  // [P13.1] Keluaran manusia dikumpulkan lalu ditulis SEKALI (OAP-008: jumlah
  // writer di berkas ini hanya boleh turun, bukan naik). Baris status runtime
  // masuk ke kumpulan yang sama — bukan writer tambahan.
  const human: string[] = [
    `Runs: ${total} · Resolved: ${ok}/${total} · Tokens in=${inputTokens} out=${outputTokens} · Cost: $${cost.toFixed(4)} · Avg ${avgMs}ms`,
    `Runtime: ${runtimeStatusSummary(runtimeView)}`,
  ]
  if (total === 0) human.push(c.dim(`  (no traces yet in ${file})`))
  if (steps.tools > 0) {
    const topDeny = steps.topDenied.map((t) => `${t.tool}×${t.n}`).join(", ")
    const topReason = steps.topDenyReasons.map((r) => `${r.reason}×${r.n}`).join(", ")
    // F1.2: peak token kumulatif antar step — satu angka "seboros apa sesi ini".
    const peak = steps.peakTotalTokens > 0 ? ` · Peak tok: ${steps.peakTotalTokens}` : ""
    human.push(
      `Tools: ${steps.tools} · Denied: ${steps.denied} (${(steps.denyRate * 100).toFixed(1)}%) · Errors: ${steps.errors}${topDeny ? ` · Top denied: ${topDeny}` : ""}${topReason ? ` · Reason: ${topReason}` : ""}${steps.sandboxes.length ? ` · Sandbox: ${steps.sandboxes.join(",")}` : ""}${peak}`,
    )
  }
  console.log(human.join("\n"))
  process.exit(0)
}
