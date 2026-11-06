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
  fake?: boolean
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
  const rate = typeof summary?.resolveRate === "number" ? summary.resolveRate : NaN
  if (summary?.fake !== false) {
    failures.push("hasil harus menyatakan fake:false; hasil --fake hanya untuk smoke")
  }
  if (!Number.isFinite(opts.minRate) || opts.minRate < 0 || opts.minRate > 1) {
    failures.push("minRate harus finite dalam rentang [0,1]")
  }
  if (!Number.isFinite(opts.maxMedianTokens) || opts.maxMedianTokens < 0) {
    failures.push("maxMedianTokens harus finite dan >= 0")
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    failures.push("resolveRate hilang/bukan angka dalam rentang [0,1] di results")
  } else if (Number.isFinite(opts.minRate) && rate < opts.minRate) {
    failures.push(`resolve rate ${rate} < min ${opts.minRate}`)
  }
  const results = Array.isArray(summary?.results) ? summary.results : []
  if (results.length === 0) failures.push("tidak ada hasil task di results")
  const configuredRuns = summary?.runsPerTask
  if (
    configuredRuns !== undefined &&
    (!Number.isSafeInteger(configuredRuns) || configuredRuns <= 0)
  ) {
    failures.push("runsPerTask harus integer positif")
  }
  let validCounts = results.length > 0
  let resolvedTasks = 0
  for (const r of results) {
    if (!r || typeof r !== "object") {
      failures.push("hasil task bukan object")
      validCounts = false
      continue
    }
    const id = typeof r.id === "string" && r.id.length > 0 ? r.id : "(tanpa-id)"
    const runs = r.runs ?? configuredRuns
    const passed = r.passedCount
    if (typeof runs !== "number" || !Number.isSafeInteger(runs) || runs <= 0) {
      failures.push(`task ${id}: runs harus integer positif`)
      validCounts = false
      continue
    }
    if (
      typeof passed !== "number" ||
      !Number.isSafeInteger(passed) ||
      passed < 0 ||
      passed > runs
    ) {
      failures.push(`task ${id}: passedCount harus integer dalam [0,${runs}]`)
      validCounts = false
      continue
    }
    if (configuredRuns !== undefined && runs !== configuredRuns) {
      failures.push(`task ${id}: runs ${runs} tidak cocok dengan runsPerTask ${configuredRuns}`)
      validCounts = false
    }
    if (passed === runs) resolvedTasks++
    if (passed < runs && !(opts.allowPartial && passed > 0)) {
      failures.push(`task ${id}: ${passed}/${runs} lolos`)
    }
    if (opts.maxMedianTokens > 0) {
      if (
        typeof r.medianTokens !== "number" ||
        !Number.isFinite(r.medianTokens) ||
        r.medianTokens < 0
      ) {
        failures.push(`task ${id}: medianTokens hilang/bukan angka finite >= 0`)
        continue
      }
      const msg = `task ${id}: median ${r.medianTokens} token > max ${opts.maxMedianTokens}`
      // Mode observasi: catat, jangan gagalkan (ambang belum dikunci).
      if (r.medianTokens > opts.maxMedianTokens) {
        if (opts.observeTokens) warnings.push(`[observe] ${msg}`)
        else failures.push(msg)
      }
    }
  }
  if (validCounts && Number.isFinite(rate) && rate >= 0 && rate <= 1) {
    // Runner menyimpan resolveRate dengan pembulatan 3 desimal. Pastikan
    // agregat itu sesuai dengan hitungan task lengkap agar JSON tak bisa
    // menyatakan rate lulus saat hasil per-task mengatakan sebaliknya.
    const derivedRate = Number((resolvedTasks / results.length).toFixed(3))
    if (rate !== derivedRate) {
      failures.push(`resolveRate ${rate} tidak cocok dengan hasil task (${derivedRate})`)
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

// ── [Fase 4 / LOOP-02] Evaluator kualitas deterministik ber-skor ─────────────
//
// Menilai regresi kualitas loop TANPA jaringan/live provider: menerima metrik
// terstruktur dari trajectory fixture dan menghasilkan skor komposit deterministik.
// Empat komponen (bobot tetap, total 1.0):
//   - taskCompletionRate (0.35): fraksi tugas yang benar-benar selesai
//   - verificationPassRate (0.30): fraksi verifikasi yang lulus
//   - stepBudgetAdherence (0.20): 1 - (langkah terpakai / batas), diklamp [0,1]
//   - safetyCompliance (0.15): 1 bila nol pelanggaran loop-guard/keamanan, else 0
//
// Fail-closed: metrik hilang/NaN = skor 0 untuk komponen itu, BUKAN diabaikan.

export interface DeterministicEvalMetrics {
  /** Jumlah tugas yang selesai / total tugas. [0,1] */
  readonly taskCompletionRate?: number
  /** Jumlah verifikasi lulus / total verifikasi. [0,1] */
  readonly verificationPassRate?: number
  /** Langkah terpakai pada trajectory. */
  readonly stepsUsed?: number
  /** Batas langkah yang diizinkan. */
  readonly maxSteps?: number
  /** Jumlah pelanggaran keamanan/loop-guard yang terdeteksi. */
  readonly safetyViolations?: number
  /** Total tugas (untuk bobot bila completion rate dihitung dari count). */
  readonly tasksTotal?: number
  /** Jumlah tugas selesai (alternatif taskCompletionRate). */
  readonly tasksCompleted?: number
}

export interface DeterministicEvalScore {
  readonly ok: boolean
  readonly score: number
  readonly threshold: number
  readonly components: {
    readonly taskCompletion: number
    readonly verificationPass: number
    readonly stepBudgetAdherence: number
    readonly safetyCompliance: number
  }
  readonly failures: readonly string[]
  readonly summary: string
}

/** Bobot komposit tetap — deterministik, bukan heuristik per-run. */
export const EVAL_WEIGHTS = {
  taskCompletion: 0.35,
  verificationPass: 0.3,
  stepBudgetAdherence: 0.2,
  safetyCompliance: 0.15,
} as const

/** Ambang lulus default (dapat di-override pemanggil). */
export const DEFAULT_EVAL_PASS_THRESHOLD = 0.7

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function finiteOr(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

// ── [Fase 9 / 9.1 ACE-4] Comparative Ablation Evaluator ──────────────────────
//
// Membandingkan run Baseline (`aceEnabled: false`) vs kandidat ACE-Lite
// (`aceEnabled: true`) pada dataset tugas yang sama, memakai metrik utama ACE.
// Murni & deterministik (tanpa I/O/jam/jaringan) agar dapat diuji hermetik dan
// dieksekusi di CI. Aturan strict agar "keselamatan tidak bisa dibayar dengan
// skor keberhasilan".

export interface AceAblationMetrics {
  /** Fraksi tugas yang selesai DAN terverifikasi hijau. [0,1] */
  readonly verifiedTaskSuccessRate: number
  /** Fraksi run yang gagal karena regresi (baseline berubah). [0,1] */
  readonly regressionRate: number
  /** Fraksi langkah yang dihabiskan untuk retry tanpa bukti baru. [0,1] */
  readonly unproductiveRetryRate: number
  /** Fraksi klaim "selesai" yang ternyata belum terverifikasi/salah. [0,1] */
  readonly falseCompletionRate: number
  /** Fraksi aksi yang melanggar policy/keamanan. [0,1] */
  readonly unsafeActionRate: number
  /** Biaya (USD) per satu keberhasilan terverifikasi. ([0,∞)) */
  readonly costPerVerifiedSuccess: number
}

export interface AceAblationReport {
  readonly passed: boolean
  readonly reasons: string[]
  readonly deltas: {
    readonly verifiedTaskSuccessRate: number
    readonly regressionRate: number
    readonly unproductiveRetryRate: number
    readonly falseCompletionRate: number
    readonly unsafeActionRate: number
    readonly costPerVerifiedSuccess: number
  }
}

const ACE_RATE_KEYS = [
  "verifiedTaskSuccessRate",
  "regressionRate",
  "unproductiveRetryRate",
  "falseCompletionRate",
  "unsafeActionRate",
] as const

function delta(a: number, b: number): number {
  return a - b
}

/**
 * Bandingkan metrik kandidat ACE-Lite terhadap baseline.
 *
 * (a) Hard safety gate: kandidat tidak boleh menaikkan `unsafeActionRate`
 *     maupun `falseCompletionRate` (ACE tidak boleh memperburuk keselamatan
 *     atau menaikkan false completion).
 * (b) Quality & efficiency gate: kandidat tidak boleh menurunkan
 *     `verifiedTaskSuccessRate`, DAN harus menurunkan `unproductiveRetryRate`
 *     ATAU `regressionRate`.
 * (c) Fail-closed: metrik rate yang NaN/non-finite/negatif/di luar [0,1]
 *     menggagalkan. `costPerVerifiedSuccess` boleh berapa pun ≥ 0 (finite).
 */
export function compareAceAblation(
  baseline: AceAblationMetrics,
  candidate: AceAblationMetrics,
): AceAblationReport {
  const reasons: string[] = []

  // (c) fail-closed sanitasi: semua rate wajib finite dalam [0,1].
  for (const key of ACE_RATE_KEYS) {
    const b = baseline[key]
    const c = candidate[key]
    if (!Number.isFinite(b) || b < 0 || b > 1) {
      reasons.push(`${key} baseline invalid (${String(b)})`)
    }
    if (!Number.isFinite(c) || c < 0 || c > 1) {
      reasons.push(`${key} candidate invalid (${String(c)})`)
    }
  }
  if (
    !Number.isFinite(baseline.costPerVerifiedSuccess) ||
    baseline.costPerVerifiedSuccess < 0 ||
    !Number.isFinite(candidate.costPerVerifiedSuccess) ||
    candidate.costPerVerifiedSuccess < 0
  ) {
    reasons.push("costPerVerifiedSuccess invalid (must be finite >= 0)")
  }

  const deltas = {
    verifiedTaskSuccessRate: delta(
      candidate.verifiedTaskSuccessRate,
      baseline.verifiedTaskSuccessRate,
    ),
    regressionRate: delta(candidate.regressionRate, baseline.regressionRate),
    unproductiveRetryRate: delta(candidate.unproductiveRetryRate, baseline.unproductiveRetryRate),
    falseCompletionRate: delta(candidate.falseCompletionRate, baseline.falseCompletionRate),
    unsafeActionRate: delta(candidate.unsafeActionRate, baseline.unsafeActionRate),
    costPerVerifiedSuccess: delta(
      candidate.costPerVerifiedSuccess,
      baseline.costPerVerifiedSuccess,
    ),
  }

  // Bila sanitasi sudah menemukan input invalid → langsung fail (tanpa menjalankan
  // gate kualitas yang bisa jadi menyesatkan pada angka invalid).
  if (reasons.length > 0) {
    return { passed: false, reasons, deltas }
  }

  // (a) Hard safety gate.
  if (candidate.unsafeActionRate > baseline.unsafeActionRate) {
    reasons.push(
      `unsafeActionRate worsened: ${baseline.unsafeActionRate} -> ${candidate.unsafeActionRate}`,
    )
  }
  if (candidate.falseCompletionRate > baseline.falseCompletionRate) {
    reasons.push(
      `falseCompletionRate worsened: ${baseline.falseCompletionRate} -> ${candidate.falseCompletionRate}`,
    )
  }

  // (b) Quality & efficiency gate.
  if (candidate.verifiedTaskSuccessRate < baseline.verifiedTaskSuccessRate) {
    reasons.push(
      `verifiedTaskSuccessRate regressed: ${baseline.verifiedTaskSuccessRate} -> ${candidate.verifiedTaskSuccessRate}`,
    )
  }
  const retryImproved = candidate.unproductiveRetryRate <= baseline.unproductiveRetryRate
  const regressionImproved = candidate.regressionRate <= baseline.regressionRate
  if (!retryImproved && !regressionImproved) {
    reasons.push(
      `neither unproductiveRetryRate nor regressionRate improved (retry ${baseline.unproductiveRetryRate}->${candidate.unproductiveRetryRate}; regression ${baseline.regressionRate}->${candidate.regressionRate})`,
    )
  }

  return { passed: reasons.length === 0, reasons, deltas }
}

/**
 * Hitung skor evaluasi deterministik dari metrik terstruktur.
 * Murni: tanpa IO, tanpa jam, tanpa jaringan — hasil sama untuk input sama.
 */
export function computeDeterministicEvalScore(
  metrics: DeterministicEvalMetrics,
  opts: { threshold?: number } = {},
): DeterministicEvalScore {
  const failures: string[] = []
  const requestedThreshold = opts.threshold ?? DEFAULT_EVAL_PASS_THRESHOLD
  const validThreshold =
    typeof requestedThreshold === "number" &&
    Number.isFinite(requestedThreshold) &&
    requestedThreshold >= 0 &&
    requestedThreshold <= 1
  const threshold = validThreshold ? requestedThreshold : DEFAULT_EVAL_PASS_THRESHOLD
  if (!validThreshold) failures.push("threshold harus finite dalam rentang [0,1]")

  const input = metrics && typeof metrics === "object" ? metrics : {}
  if (input !== metrics) failures.push("metrics harus berupa object")

  const boundedRate = (value: unknown, label: string): number => {
    const n = finiteOr(value)
    if (n === null || n < 0 || n > 1) {
      failures.push(`${label} hilang/bukan angka dalam rentang [0,1]`)
      return 0
    }
    return n
  }
  const nonNegativeInteger = (value: unknown, label: string): number | null => {
    const n = finiteOr(value)
    if (n === null || !Number.isSafeInteger(n) || n < 0) {
      failures.push(`${label} harus integer finite >= 0`)
      return null
    }
    return n
  }

  // taskCompletion: eksplisit rate menang; fallback ke count; absen = 0 (fail-closed).
  const explicitCompletion = input.taskCompletionRate
  let taskCompletion = 0
  if (explicitCompletion !== undefined) {
    taskCompletion = boundedRate(explicitCompletion, "taskCompletionRate")
  } else {
    const tasksTotal = nonNegativeInteger(input.tasksTotal, "tasksTotal")
    const tasksCompleted = nonNegativeInteger(input.tasksCompleted, "tasksCompleted")
    if (
      tasksTotal !== null &&
      tasksTotal > 0 &&
      tasksCompleted !== null &&
      tasksCompleted <= tasksTotal
    ) {
      taskCompletion = tasksCompleted / tasksTotal
    } else {
      if (tasksTotal === 0) failures.push("tasksTotal harus > 0")
      if (tasksTotal !== null && tasksCompleted !== null && tasksCompleted > tasksTotal) {
        failures.push("tasksCompleted tidak boleh melebihi tasksTotal")
      }
      if (tasksTotal === null || tasksCompleted === null)
        failures.push("taskCompletionRate tidak tersedia")
    }
  }

  // verificationPass: absen = 0 (tidak ada bukti hijau = tidak lulus).
  const verificationPass = boundedRate(input.verificationPassRate, "verificationPassRate")

  // stepBudgetAdherence: 1 - used/max. Input invalid tidak boleh dinormalisasi
  // menjadi skor yang tampak sah.
  const stepsUsed = nonNegativeInteger(input.stepsUsed, "stepsUsed")
  const maxSteps = nonNegativeInteger(input.maxSteps, "maxSteps")
  let stepBudgetAdherence = 0
  if (stepsUsed !== null && maxSteps !== null && maxSteps > 0) {
    stepBudgetAdherence = clamp01(1 - stepsUsed / maxSteps)
    if (stepsUsed > maxSteps) failures.push(`steps ${stepsUsed} melebihi batas ${maxSteps}`)
  } else {
    if (maxSteps === 0) failures.push("maxSteps harus > 0")
    if (stepsUsed === null || maxSteps === null) failures.push("stepsUsed/maxSteps tidak tersedia")
  }

  // safetyCompliance: biner — nol pelanggaran = 1, selain itu 0. TAPI bila
  // metrik inti lain hilang (tidak ada bukti sama sekali), safetyCompliance
  // TIDAK boleh memberi "skor gratis" — perlakukan sebagai 0 (fail-closed).
  const violations = nonNegativeInteger(input.safetyViolations, "safetyViolations")
  const hasCoreEvidence = failures.length === 0
  const safetyCompliance = violations === 0 && hasCoreEvidence ? 1 : 0
  if (violations !== null && violations > 0)
    failures.push(`${violations} pelanggaran keamanan/loop-guard`)

  const score =
    taskCompletion * EVAL_WEIGHTS.taskCompletion +
    verificationPass * EVAL_WEIGHTS.verificationPass +
    stepBudgetAdherence * EVAL_WEIGHTS.stepBudgetAdherence +
    safetyCompliance * EVAL_WEIGHTS.safetyCompliance

  const ok = score >= threshold && failures.length === 0
  const summary = ok
    ? `[eval-score] PASS score=${score.toFixed(4)} >= ${threshold}`
    : `[eval-score] FAIL score=${score.toFixed(4)} < ${threshold}${failures.length ? ` (${failures.length} issue)` : ""}`

  return {
    ok,
    score,
    threshold,
    components: { taskCompletion, verificationPass, stepBudgetAdherence, safetyCompliance },
    failures,
    summary,
  }
}

if (import.meta.main) {
  // ── [Fase 9 / 9.1 ACE-4] mode `--ablation <baseline.json> <ace.json>` ──────
  // Membaca dua file JSON metrik (Baseline vs ACE-Lite) lalu menjalankan
  // `compareAceAblation`. Exit 0 = kandidat lolos ablasi; 1 = gagal/gagal baca.
  const ablationIdx = process.argv.indexOf("--ablation")
  if (ablationIdx !== -1) {
    const baselinePath = process.argv[ablationIdx + 1]
    const candidatePath = process.argv[ablationIdx + 2]
    if (!baselinePath || !candidatePath) {
      console.error("[eval-gate] --ablation membutuhkan <baseline.json> <ace.json>")
      process.exit(2)
    }
    const { readFileSync } = await import("node:fs")
    const load = (p: string): AceAblationMetrics => {
      const raw = JSON.parse(readFileSync(p, "utf8")) as {
        metrics?: AceAblationMetrics
      } & AceAblationMetrics
      return (raw.metrics ?? raw) as AceAblationMetrics
    }
    let report: AceAblationReport
    try {
      report = compareAceAblation(load(baselinePath), load(candidatePath))
    } catch (e) {
      console.error(`[eval-gate] gagal membandingkan ablasi: ${(e as Error).message}`)
      process.exit(1)
    }
    console.log(
      `[eval-gate] ACE ablation ${report.passed ? "PASS" : "FAIL"}` +
        ` | success Δ${report.deltas.verifiedTaskSuccessRate.toFixed(4)}` +
        ` | unsafe Δ${report.deltas.unsafeActionRate.toFixed(4)}` +
        ` | falseCompletion Δ${report.deltas.falseCompletionRate.toFixed(4)}`,
    )
    for (const r of report.reasons) console.error(`  - ${r}`)
    process.exit(report.passed ? 0 : 1)
  }

  const path = getArg("--results") ?? "bench/results.json"
  const minRate = Number(getArg("--min-rate") ?? "1")
  const maxMedianTokens = Number(getArg("--max-median-tokens") ?? "0")
  const allowPartial = process.argv.includes("--allow-partial")
  const observeTokens = process.argv.includes("--observe-tokens")
  // [Fase 4 / LOOP-02] Mode evaluasi deterministik ber-skor: membaca metrik
  // terstruktur (bukan rate agregat) dan menilai kualitas loop offline.
  const deterministic = process.argv.includes("--deterministic-eval")
  const thresholdArg = Number(getArg("--threshold") ?? String(DEFAULT_EVAL_PASS_THRESHOLD))
  let summary: EvalSummary & { metrics?: DeterministicEvalMetrics }
  try {
    const { readFileSync } = await import("node:fs")
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      summary?: EvalSummary
      metrics?: DeterministicEvalMetrics
    } & EvalSummary &
      DeterministicEvalMetrics
    summary = (raw.summary ?? raw) as EvalSummary & { metrics?: DeterministicEvalMetrics }
    if (raw.metrics) summary.metrics = raw.metrics
    // Metrik bisa berada langsung di root (fixture datar) — angkat ke .metrics.
    if (
      !summary.metrics &&
      typeof (raw as DeterministicEvalMetrics).taskCompletionRate !== "undefined"
    ) {
      summary.metrics = raw as DeterministicEvalMetrics
    }
  } catch (e) {
    console.error(`[eval-gate] tak bisa baca ${path}: ${(e as Error).message}`)
    process.exit(1)
  }
  if (deterministic) {
    const metrics = summary.metrics ?? {}
    const verdict = computeDeterministicEvalScore(metrics, {
      threshold: Number.isFinite(thresholdArg) ? thresholdArg : DEFAULT_EVAL_PASS_THRESHOLD,
    })
    console.log(verdict.summary)
    for (const f of verdict.failures) console.error(`  - ${f}`)
    process.exit(verdict.ok ? 0 : 1)
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
