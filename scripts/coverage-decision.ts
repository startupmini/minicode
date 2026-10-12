// Logika keputusan coverage gate yang MURNI (tanpa IO, tanpa proses).
//
// Dipakai oleh `scripts/coverage-gate.ts` (eksekusi + cetak + exit code) dan
// diuji langsung oleh `test/coverage-gate-decision.test.ts` — fungsi yang sama
// menentukan lolos/gagal di kedua tempat, bukan aproksimasi khusus-test.
// Kontrak: status test dan liputan dievaluasi independen; keduanya
// dilaporkan bila gagal; laporan hilang/rusak = gagal eksplisit,
// bukan lolos diam-diam.
// keduanya dilaporkan bila gagal; laporan hilang/rusak = gagal eksplisit,
// bukan lolos diam-diam.
export interface AggregateCoverage {
  funcs: number
  lines: number
}

export interface GateThresholds {
  minFuncs: number
  minLines: number
}

/** [path, min funcs, min lines] — sama bentuknya dengan CRITICAL_FILES. */
export type CriticalFloor = readonly [path: string, minFuncs: number, minLines: number]

export interface GateEvaluation {
  /** Gagal total pada baris ringkasan; 0 bila tak ada. */
  failCount: number
  /** Nama test gagal (baris `(fail) ...`). */
  failNames: string[]
  /** Kegagalan katastrofik runner (crash tanpa pass); null bila run normal. */
  runFailure: string | null
  /** Null bila baris "All files" tak bisa diurai. */
  aggregate: AggregateCoverage | null
  /** Pelanggaran ambang agregat (teks siap cetak). */
  aggregateFailures: string[]
  /** Pelanggaran lantai per-berkas + berkas hilang (teks siap cetak). */
  criticalFailures: string[]
  /** Gagal uraian laporan; null bila laporan terurai. */
  parseError: string | null
}

/** Jumlah gagal + nama test dari ringkasan reporter dots. */
export function parseFailures(output: string): { count: number; names: string[] } {
  const m = /^\s*(\d+) fail\s*$/m.exec(output)
  const count = m ? Number(m[1]) : 0
  const names = (output.match(/^\(fail\).*$/gm) ?? []).map((l) => l.slice(0, 160))
  return { count: Number.isFinite(count) ? count : 0, names }
}

/** Baris "All files | funcs | lines |" — null bila tak ditemukan. */
export function parseAggregate(output: string): AggregateCoverage | null {
  const m = /^\s*All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/m.exec(output)
  if (!m) return null
  const funcs = Number(m[1])
  const lines = Number(m[2])
  if (!Number.isFinite(funcs) || !Number.isFinite(lines)) return null
  return { funcs, lines }
}

/** Baris laporan satu berkas (pemisah path platform apa pun) — null bila absen. */
export function fileCoverage(
  output: string,
  path: string,
): { funcs: number; lines: number } | null {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\//g, "[\\\\/]")
  const m = new RegExp(`^\\s*${esc}\\s*\\|\\s*([\\d.]+)\\s*\\|\\s*([\\d.]+)\\s*\\|`, "m").exec(output)
  if (!m) return null
  const funcs = Number(m[1])
  const lines = Number(m[2])
  if (!Number.isFinite(funcs) || !Number.isFinite(lines)) return null
  return { funcs, lines }
}

/** Evaluasi penuh satu output runner/laporan. Tidak pernah melempar. */
export function evaluateGate(
  output: string,
  thresholds: GateThresholds,
  criticalFiles: readonly CriticalFloor[],
  runFailure: string | null = null,
): GateEvaluation {
  const { count: failCount, names: failNames } = parseFailures(output)
  const aggregate = parseAggregate(output)
  const aggregateFailures: string[] = []
  const criticalFailures: string[] = []
  let parseError: string | null = null
  if (!aggregate) {
    parseError = "[coverage-gate] baris 'All files' tidak ditemukan di output coverage"
  } else {
    if (aggregate.funcs < thresholds.minFuncs) {
      aggregateFailures.push(
        `[coverage-gate] FAIL funcs ${aggregate.funcs.toFixed(2)}% < ${thresholds.minFuncs}%`,
      )
    }
    if (aggregate.lines < thresholds.minLines) {
      aggregateFailures.push(
        `[coverage-gate] FAIL lines ${aggregate.lines.toFixed(2)}% < ${thresholds.minLines}%`,
      )
    }
  }
  for (const [path, minF, minL] of criticalFiles) {
    const f = fileCoverage(output, path)
    if (!f) {
      criticalFailures.push(
        `[coverage-gate] FAIL ${path}: tidak ada di laporan coverage (dipindah/rename?)`,
      )
      continue
    }
    if (f.funcs < minF) {
      criticalFailures.push(
        `[coverage-gate] FAIL ${path}: funcs ${f.funcs.toFixed(2)}% < ${minF}%`,
      )
    }
    if (f.lines < minL) {
      criticalFailures.push(
        `[coverage-gate] FAIL ${path}: lines ${f.lines.toFixed(2)}% < ${minL}%`,
      )
    }
  }
  return {
    failCount,
    failNames,
    runFailure,
    aggregate,
    aggregateFailures,
    criticalFailures,
    parseError,
  }
}

/** Keputusan exit: 0 hanya bila SEMUA hijau (test + uraian + ambang + lantai). */
export function gateExitCode(ev: GateEvaluation): 0 | 1 {
  if (ev.runFailure !== null) return 1
  if (ev.failCount > 0) return 1
  if (ev.parseError !== null) return 1
  if (ev.aggregateFailures.length > 0) return 1
  if (ev.criticalFailures.length > 0) return 1
  return 0
}
