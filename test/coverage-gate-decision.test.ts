// C-QA — test logika keputusan coverage gate memakai implementasi ASLI
// (`scripts/coverage-decision.ts`, modul yang sama dipakai gate script).
// Fixture sintetik agar tiap kasus tak perlu satu run suite penuh.
// Kontrak yang dibuktikan tiap kasus ada di nama test-nya.
import { expect, test } from "bun:test"
import { type CriticalFloor, evaluateGate, gateExitCode } from "../scripts/coverage-decision.ts"

const MIN = { minFuncs: 85, minLines: 86 }
const LANTAI: CriticalFloor[] = [["src/a.ts", 90, 90]]

// Bantuan: tabel coverage gaya reporter dots (pemisah `|`).
function laporan(badan: string): string {
  return `..........\n${badan}`
}

const TABEL_HIJAU = `All files                     |   90.00 |   91.00 |
src/a.ts                      |   95.00 |   96.00 |`

// Kasus A — test gagal, liputan lolos: keduanya dilaporkan, gate tetap gagal.
test("A: test gagal + liputan lolos → gagal karena test, liputan tetap dievaluasi", () => {
  const out = laporan(` 15 pass
 2 fail
 0 skip
(fail) satu test [12.00ms]
(fail) dua test [3.00ms]
${TABEL_HIJAU}`)
  const ev = evaluateGate(out, MIN, LANTAI)
  expect(ev.failCount).toBe(2)
  expect(ev.failNames).toHaveLength(2)
  expect(ev.aggregate).toEqual({ funcs: 90, lines: 91 })
  expect(ev.aggregateFailures).toEqual([])
  expect(ev.criticalFailures).toEqual([])
  expect(ev.parseError).toBeNull()
  expect(gateExitCode(ev)).toBe(1)
})

// Kasus B — test lolos, liputan gagal: pelanggaran ambang dilaporkan, gate gagal.
test("B: test lolos + liputan gagal → gagal karena ambang", () => {
  const out = laporan(` 15 pass
 0 fail
All files                     |   80.00 |   81.00 |
src/a.ts                      |   95.00 |   96.00 |`)
  const ev = evaluateGate(out, MIN, LANTAI)
  expect(ev.failCount).toBe(0)
  expect(ev.aggregateFailures).toHaveLength(2)
  expect(ev.aggregateFailures[0]).toContain("funcs 80.00% < 85%")
  expect(ev.aggregateFailures[1]).toContain("lines 81.00% < 86%")
  expect(gateExitCode(ev)).toBe(1)
})

// Kasus C — keduanya gagal (termasuk lantai per-berkas): semua alasan ada.
test("C: test + agregat + lantai gagal → ketiga alasan dilaporkan", () => {
  const out = laporan(` 10 pass
 1 fail
(fail) satu test [1.00ms]
All files                     |   80.00 |   81.00 |
src/a.ts                      |   85.00 |   96.00 |`)
  const ev = evaluateGate(out, MIN, LANTAI)
  expect(ev.failCount).toBe(1)
  expect(ev.aggregateFailures).toHaveLength(2)
  expect(ev.criticalFailures).toHaveLength(1)
  expect(ev.criticalFailures[0]).toContain("src/a.ts")
  expect(ev.criticalFailures[0]).toContain("funcs 85.00% < 90%")
  expect(gateExitCode(ev)).toBe(1)
})

// Kasus D — keduanya lolos: gate lolos.
test("D: test lolos + liputan lolos → gate lolos", () => {
  const out = laporan(` 15 pass
 0 fail
${TABEL_HIJAU}`)
  const ev = evaluateGate(out, MIN, LANTAI)
  expect(ev.failCount).toBe(0)
  expect(ev.parseError).toBeNull()
  expect(gateExitCode(ev)).toBe(0)
})

// Kasus E — laporan rusak/hilang: gagal eksplisit, bukan lolos diam-diam.
test("E: tabel hilang → parse error, gate gagal", () => {
  const ev = evaluateGate(laporan("boom tanpa tabel"), MIN, LANTAI)
  expect(ev.aggregate).toBeNull()
  expect(ev.parseError).not.toBeNull()
  expect(gateExitCode(ev)).toBe(1)
})

// Kasus E2 — run katastrofik (crash tanpa pass): dilaporkan eksplisit,
// liputan tetap dievaluasi bila tabelnya ada.
test("E2: run katastrofik + tabel ada → run failure dilaporkan, liputan tetap dinilai", () => {
  const ev = evaluateGate(laporan(TABEL_HIJAU), MIN, LANTAI, "[coverage-gate] test run failed")
  expect(ev.runFailure).not.toBeNull()
  expect(ev.aggregate).toEqual({ funcs: 90, lines: 91 })
  expect(gateExitCode(ev)).toBe(1)
})

// Batas pemisah path Windows (backslash) tetap terurai.
test("pemisah backslash Windows terurai di baris per-berkas", () => {
  const out = laporan(` 1 pass
 0 fail
All files                     |   90.00 |   91.00 |
src\\policy\\jail.ts           |   93.00 |   94.00 |`)
  const ev = evaluateGate(out, MIN, [["src/policy/jail.ts", 92, 92]])
  expect(ev.criticalFailures).toEqual([])
  expect(gateExitCode(ev)).toBe(0)
})
