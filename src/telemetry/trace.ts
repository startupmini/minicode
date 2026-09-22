import { appendFile, chmod, mkdir, readFile, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { LIMITS } from "../constants.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { scrubSecrets } from "../policy/scrub.ts"

export interface RunTrace {
  sessionId: string
  timestamp: string
  prompt: string
  durationMs: number
  steps: number
  turns: number
  inputTokens: number
  outputTokens: number
  cost?: number
  model?: string
  ok: boolean
  error?: string
  /** P2.3: jumlah hit RAG memory yang di-inject ke system prompt run ini. */
  memoryHits?: number
  /** Harness-P0: true bila cost sesi melewati --budget (fail-open bila cost null). */
  overBudget?: boolean
}

// Harness-P1: satu baris JSON per tool/step di .minicode/step-traces.jsonl.
// Trace per-run tak bisa menjawab "di mana contract gagal?" — ini bisa:
// tiap eksekusi tool (termasuk deny) + ringkasan tiap step tercatat.
export interface StepTrace {
  sessionId: string
  timestamp: string
  kind: "tool" | "step"
  step: number
  tool?: string
  ok?: boolean
  /** true bila hasil diawali "permission denied"/"permission error". */
  denied?: boolean
  /** alasan deny yang sudah dinormalisasi (mis. bash-guard, jail, allowlist). */
  denyReason?: string
  durationMs?: number
  /** ringkasan argumen yang di-scrub (tanpa isi file/kode penuh). */
  args?: string
  /** khusus kind=step: jumlah tool dan yang error. */
  tools?: number
  errors?: number
  /** mode sandbox saat step berjalan — isolasi apa yang sebenarnya aktif. */
  sandbox?: string
  /** F1.2: token kumulatif SESI saat baris ditulis (usage.getSession()).
   * Monoton naik per sesi — replay file menghasilkan kurva token tanpa
   * perlu join ke traces.jsonl. Opsional: baris lama tak memilikinya. */
  totalTokens?: number
}

// Kunci argumen yang aman diringkas; `content`/`code`/body lain SENGAJA
// dibuang (bisa megabyte + berisi secret) — yang dicatat hanya pointer.
const ARG_KEYS = [
  "path",
  "from",
  "to",
  "cmd",
  "pattern",
  "query",
  "prompt",
  "file",
  "id",
  "url",
  "dir",
  "lang",
  "name",
]

export function summarizeArgs(args: unknown): string {
  if (args == null) return ""
  if (typeof args === "string") return scrubSecrets(args.slice(0, 120))
  if (typeof args !== "object") return scrubSecrets(String(args).slice(0, 120))
  const rec = args as Record<string, unknown>
  const parts: string[] = []
  for (const k of ARG_KEYS) {
    const v = rec[k]
    if (typeof v === "string" && v) parts.push(`${k}=${v.slice(0, 120)}`)
    else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${v}`)
  }
  return scrubSecrets(parts.join(" ").slice(0, 300))
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === "string" ? p : typeof p?.text === "string" ? (p.text as string) : "",
      )
      .join("\n")
  }
  return ""
}

// Klasifikasi observasi tool: deny permission adalah sinyal harness lapis-1
// (kuota, jail, allowlist) — tanpa ini deny tak terlihat di event stream
// karena kernel hanya meng-emit execution:* untuk call yang lolos gate.
export function classifyToolResult(result: {
  isError?: boolean
  content: unknown
}): "ok" | "denied" | "error" {
  if (!result.isError) return "ok"
  const t = resultText(result.content).toLowerCase()
  if (t.startsWith("permission denied") || t.startsWith("permission error")) return "denied"
  return "error"
}

/** Alasan deny yang dinormalisasi untuk observability (SPEC). */
export function denyReasonOf(result: { isError?: boolean; content: unknown }): string | undefined {
  const t = resultText(result.content)
  if (!t.toLowerCase().startsWith("permission")) return undefined
  // Ambil baris pertama, potong prefix "permission denied: "
  const first = t.split("\n")[0] ?? t
  const m = /permission (?:denied|error):?\s*(.*)/i.exec(first)
  const reason = (m?.[1] ?? first).trim().slice(0, 80)
  if (!reason) return "unknown"
  // Normalisasi: jail, bash-guard, allowlist, sensitive, outside
  if (/outside workspace|symlink/i.test(reason)) return "jail"
  if (/sensitive/i.test(reason)) return "sensitive"
  if (/allowlist/i.test(reason)) return "allowlist"
  if (/bash|guard|destructive|interpreter|env-dump/i.test(reason)) return "bash-guard"
  return reason.slice(0, 40)
}

// Opt-out privasi: MINICODE_TELEMETRY=0/false/off → tidak ada file ditulis.
function telemetryEnabled(): boolean {
  const v = (process.env.MINICODE_TELEMETRY ?? "").trim().toLowerCase()
  return v !== "0" && v !== "false" && v !== "off"
}

// Telemetry ringan: satu baris JSON per run di .minicode/traces.jsonl.
// Tanpa OTel — cukup untuk agregasi manual / metrik sederhana.
export async function writeTrace(cwd: string | undefined, trace: RunTrace): Promise<void> {
  if (!telemetryEnabled()) return
  try {
    const dir = resolve(cwd ?? ".", ".minicode")
    await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {})
    const file = join(dir, "traces.jsonl")
    // prompt/error/model di-redact sebelum persist — bisa berisi secret/PII
    const safe: RunTrace = {
      ...trace,
      prompt: scrubSecrets(trace.prompt.slice(0, 2000)),
      ...(trace.error ? { error: scrubSecrets(trace.error.slice(0, 1000)) } : {}),
      ...(trace.model ? { model: scrubSecrets(trace.model) } : {}),
    }
    await appendFile(file, `${JSON.stringify(safe)}\n`, "utf8")
    await chmod(file, 0o600).catch(() => {})
    // Rotate: keep TRACE_MAX_LINES baris terakhir (tmp+rename agar anti-korupsi)
    try {
      const txt = await readFile(file, "utf8")
      const lines = txt.split("\n").filter(Boolean)
      if (lines.length > LIMITS.TRACE_MAX_LINES) {
        await atomicWriteText(file, `${lines.slice(-LIMITS.TRACE_MAX_LINES).join("\n")}\n`)
      }
    } catch {}
  } catch {}
}

export async function writeStepTrace(cwd: string | undefined, step: StepTrace): Promise<void> {
  if (!telemetryEnabled()) return
  try {
    const dir = resolve(cwd ?? ".", ".minicode")
    await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {})
    const file = join(dir, "step-traces.jsonl")
    const safe: StepTrace = { ...step, ...(step.args ? { args: scrubSecrets(step.args) } : {}) }
    await appendFile(file, `${JSON.stringify(safe)}\n`, "utf8")
    await chmod(file, 0o600).catch(() => {})
    try {
      const txt = await readFile(file, "utf8")
      const lines = txt.split("\n").filter(Boolean)
      if (lines.length > LIMITS.TRACE_MAX_LINES) {
        await atomicWriteText(file, `${lines.slice(-LIMITS.TRACE_MAX_LINES).join("\n")}\n`)
      }
    } catch {}
  } catch {}
}

// Audit #10 §17: penghapusan sesi wajib mencakup jejak telemetry miliknya.
// traces.jsonl/step-traces.jsonl adalah berkas bersama per-workspace (untuk
// `minicode stats`), sehingga baris sesi yang dihapus bertahan sebagai
// residual reachable — reproducer: writeTrace marker → deleteSession → marker
// masih terbaca. Fungsi ini membuang HANYA baris dengan sessionId cocok via
// rewrite atomik; baris korup (tak ter-parse) DIPERTAHANKAN (fail-closed:
// jangan hapus yang tak bisa diatribusikan).
//
// Tradeoff jujur: rewrite read-filter-write balapan dengan append konkuren
// (trace sesi lain yang ditulis tepat di jendela ini bisa hilang — kehilangan
// observability, bukan kebocoran). Dipanggil best-effort dari deleteSession.
export async function purgeSessionTraces(
  sessionId: string,
  cwd: string | undefined,
): Promise<number> {
  let removed = 0
  for (const name of ["traces.jsonl", "step-traces.jsonl"]) {
    try {
      const file = join(resolve(cwd ?? ".", ".minicode"), name)
      let txt: string
      try {
        txt = await readFile(file, "utf8")
      } catch {
        continue // tak ada berkas = tak ada residual
      }
      const lines = txt.split("\n").filter(Boolean)
      if (lines.length === 0) continue
      const keep: string[] = []
      for (const line of lines) {
        try {
          const row = JSON.parse(line) as { sessionId?: unknown }
          if (row.sessionId === sessionId) {
            removed++
            continue
          }
        } catch {
          // baris korup: pertahankan (lihat kontrak di atas)
        }
        keep.push(line)
      }
      if (keep.length === lines.length) continue // tak ada milik sesi ini
      if (keep.length === 0) await unlink(file).catch(() => {})
      else await atomicWriteText(file, `${keep.join("\n")}\n`)
    } catch {}
  }
  return removed
}
// Harness-P3: agregat step-trace untuk `minicode stats` — data observability
// per-step (P1.2) kembali menjadi keputusan: deny-rate, tool paling sering
// ditolak/gagal, mode sandbox yang terlihat. Pure agar bisa diuji.
export interface StepSummary {
  tools: number
  ok: number
  denied: number
  errors: number
  denyRate: number
  topDenied: { tool: string; n: number }[]
  topErrors: { tool: string; n: number }[]
  sandboxes: string[]
  topDenyReasons: { reason: string; n: number }[]
  /** F1.2: max totalTokens antar baris = taksiran akhir kumulatif sesi.
   * 0 bila tak ada baris bertoken (format lama). */
  peakTotalTokens: number
}

export function summarizeStepTraces(rows: StepTrace[]): StepSummary {
  const tools = rows.filter((r) => r.kind === "tool")
  let ok = 0
  let denied = 0
  let errors = 0
  const deniedBy = new Map<string, number>()
  const errBy = new Map<string, number>()
  const reasonBy = new Map<string, number>()
  const sandboxes = new Set<string>()
  let peakTotalTokens = 0
  for (const t of tools) {
    const name = t.tool ?? "?"
    if (t.denied) {
      denied++
      deniedBy.set(name, (deniedBy.get(name) ?? 0) + 1)
      const r = t.denyReason ?? "unknown"
      reasonBy.set(r, (reasonBy.get(r) ?? 0) + 1)
    } else if (t.ok === false) {
      errors++
      errBy.set(name, (errBy.get(name) ?? 0) + 1)
    } else {
      ok++
    }
    if (t.sandbox) sandboxes.add(t.sandbox)
  }
  const top = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tool, n]) => ({ tool, n }))
  const topReason = [...reasonBy.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, n]) => ({ reason, n }))
  // Peak dihitung dari SEMUA baris (tool + step) — baris step-kind juga
  // membawa totalTokens kumulatif; baris lama (tanpa field) diabaikan.
  for (const t of rows) {
    const v = t.totalTokens
    if (typeof v === "number" && Number.isFinite(v) && v > peakTotalTokens) peakTotalTokens = v
  }
  return {
    tools: tools.length,
    ok,
    denied,
    errors,
    denyRate: tools.length ? denied / tools.length : 0,
    topDenied: top(deniedBy),
    topErrors: top(errBy),
    sandboxes: [...sandboxes],
    topDenyReasons: topReason,
    peakTotalTokens,
  }
}
