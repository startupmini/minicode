import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { getMemoryStats, reconcileMemoryStores } from "../../src/memory/vector.ts"
import { c } from "../../src/ui/render/theme.ts"

const MEMORY_HELP = `minicode memory — vector RAG store stats

  minicode memory status [--json]     rows, size, models, hit-rate (default)
  minicode memory reconcile [--json]  samakan vector.db ↔ .minicode/MEMORY.md`

interface MemoryTraceRow {
  memoryHits?: number
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function fmtDate(ts: number | null): string {
  if (ts == null) return "-"
  try {
    return new Date(ts).toISOString().slice(0, 10)
  } catch {
    return "-"
  }
}

// Hit-rate RAG dari traces.jsonl: rata-rata memoryHits per run yang mencatatnya.
function readHitRate(cwd?: string): { runs: number; avgHits: number } {
  let runs = 0
  let total = 0
  try {
    const lines = readFileSync(resolve(cwd ?? ".", ".minicode", "traces.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
    for (const l of lines) {
      try {
        const t = JSON.parse(l) as MemoryTraceRow
        if (typeof t.memoryHits === "number") {
          runs++
          total += t.memoryHits
        }
      } catch {}
    }
  } catch {}
  return { runs, avgHits: runs ? total / runs : 0 }
}

export async function handleMemory(
  args: string[],
  getArg: (name: string) => string | undefined,
): Promise<never> {
  // Satu saluran stderr bersama (dihitung inventaris writer sebagai satu site).
  const err = (msg: string): void => console.error(msg)
  const sub = args[1]
  if (sub === "--help" || sub === "-h") {
    console.log(MEMORY_HELP)
    process.exit(0)
  }
  // [PROMPT 06 · Area E / D4] `reconcileMemoryStores` sebelumnya TIDAK punya
  // call site produksi sama sekali: pesan `write_memory` menyuruh user
  // menjalankan `minicode memory reconcile` padahal subcommand itu tak ada —
  // split-brain (file-only / vector-only) hanya bisa dipulihkan lewat test.
  // Perintah ini memberi jalur pemulihan yang benar-benar dapat dijalankan.
  if (sub === "reconcile") {
    const cwdArg = getArg("--cwd")
    const asJson = getArg("--json") !== undefined || args.includes("--json")
    try {
      const res = await reconcileMemoryStores(cwdArg)
      const dot = "\u00b7"
      console.log(
        asJson
          ? JSON.stringify(res)
          : `reconciled ${res.reconciled} entri ${dot} diadopsi dari vector ${res.vectorOnlyAdopted} ${dot} ditambah dari file ${res.fileOnlyAdded} ${dot} superseded dilewati ${res.supersededSkipped} ${dot} baris superseded dibersihkan ${res.supersededFileRemoved} ${dot} legacy perlu review ${res.legacySuspectLines}`,
      )
      process.exit(0)
    } catch (e) {
      // Fail-closed dengan pesan actionable: DB tak terbuka (mis. path rusak)
      // bukan alasan mencetak stack trace mentah ke user.
      err(`memory reconcile gagal: ${(e as Error).message}`)
      process.exit(1)
    }
  }
  if (sub && sub !== "status" && !sub.startsWith("-")) {
    err(`unknown memory subcommand "${sub}" — see: minicode memory status`)
    process.exit(2)
  }
  const cwdArg = getArg("--cwd")
  const asJson = getArg("--json") !== undefined || args.includes("--json")
  const s = getMemoryStats(cwdArg)
  const { runs, avgHits } = readHitRate(cwdArg)
  // P13 P1 DoD: scope efektif ikut tampil agar silent shadowing terlihat.
  const scope = process.env.MINICODE_MEMORY_SCOPE ?? "cwd"
  if (asJson) {
    console.log(
      JSON.stringify({
        rows: s.rows,
        liveRows: s.liveRows,
        supersededRows: s.supersededRows,
        dbBytes: s.dbBytes,
        walBytes: s.walBytes,
        shmBytes: s.shmBytes,
        models: s.models,
        dims: s.dims,
        categories: s.categories,
        scope,
        oldest: s.oldest,
        newest: s.newest,
        traceRuns: runs,
        avgMemoryHits: Math.round(avgHits * 100) / 100,
      }),
    )
    process.exit(0)
  }
  const dot = "\u00b7"
  const lines: string[] = [
    `\n${c.bold("Memory")}  ${s.rows} rows (${s.liveRows} live ${dot} ${s.supersededRows} superseded) ${dot} ${fmtBytes(s.dbBytes + s.walBytes + s.shmBytes)} ` +
      `(db ${fmtBytes(s.dbBytes)} ${dot} wal ${fmtBytes(s.walBytes)} ${dot} shm ${fmtBytes(s.shmBytes)})`,
  ]
  if (s.models.length)
    lines.push(`  models: ${s.models.map((m) => `${m.model}×${m.count}`).join(", ")}`)
  if (s.dims.length)
    lines.push(`  dims: ${s.dims.map((d) => `${d.dim || "none"}×${d.count}`).join(", ")}`)
  if (s.categories.length)
    lines.push(
      `  categories: ${s.categories.map((m) => `${m.category}×${m.count}`).join(", ")} (scope: ${scope})`,
    )
  lines.push(`  range: ${fmtDate(s.oldest)} → ${fmtDate(s.newest)}`)
  lines.push(
    runs > 0
      ? `  RAG hit-rate: ${avgHits.toFixed(2)} hits/run over ${runs} traced runs`
      : c.dim(`  (no memoryHits in traces yet — run once to measure hit-rate)`),
  )
  lines.push("")
  console.log(lines.join("\n"))
  process.exit(0)
}
