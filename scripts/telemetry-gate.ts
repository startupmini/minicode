// Telemetry gate — cek resolve-rate dari traces.jsonl.
// Target: resolved/total >= 0.3 (dari bench baseline; warn, bukan block).
//
// [Fase 9 / 9.3 CTL-06] Mode `--require-min-runs` (alias `--self-test`):
// alih-alih skip diam-diam saat data kurang, exit non-zero agar jalur evaluasi
// aktif di CI tidak terlewati karena traces.jsonl tidak ada/kurang 3 run.
// Default lama (`--self-test` absent) tetap skip → exit 0 agar integrasi lama
// yang tidak pernah menulis trace tidak gagal mendadak.
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const argv = process.argv.slice(2)
const requireMinRuns = argv.includes("--require-min-runs") || argv.includes("--self-test")
const cwd = argv.find((a) => !a.startsWith("--")) ?? "."
const file = resolve(cwd, ".minicode", "traces.jsonl")

if (!existsSync(file)) {
  if (requireMinRuns) {
    console.error("[gate] ERROR: traces.jsonl missing while --require-min-runs set")
    process.exit(1)
  }
  console.log("[gate] no traces.jsonl — skipping telemetry gate")
  process.exit(0)
}

const rawTraces = readFileSync(file, "utf8")
  .replace(/^\uFEFF/, "") // Strip UTF-8 BOM if present (prevent parse crash)
  .split("\n")
  .filter(Boolean)

let traces: { ok?: boolean }[]
try {
  traces = rawTraces.map((l) => JSON.parse(l))
} catch (e) {
  console.error(`[gate] ERROR: Invalid JSON in traces.jsonl`, (e as Error).message)
  process.exit(1)
}

const ok = traces.filter((t) => t.ok).length
const rate = traces.length ? ok / traces.length : 0
const TARGET = 0.3

console.log(
  `[gate] runs=${traces.length} resolved=${ok}/${traces.length} rate=${rate.toFixed(2)} (target ${TARGET})`,
)
if (traces.length < 3) {
  if (requireMinRuns) {
    console.error(
      `[gate] ERROR: insufficient runs (${traces.length} < 3) while --require-min-runs set`,
    )
    process.exit(1)
  }
  console.log("[gate] too few runs — passing (insufficient data)")
  process.exit(0)
}
if (rate < TARGET) {
  console.warn(`[gate] WARN: resolve rate ${rate.toFixed(2)} < ${TARGET}`)
  process.exit(1)
}
process.exit(0)
