// PROMPT 06 · Area F — gate paritas CI (pola test yang DIEKSEKUSI, bukan
// sekadar tertera di berkas workflow).
//
// Yang dijaga (integration):
// 1. `ci-windows` menjalankan step test dengan `shell: bash`. pwsh TIDAK
//    mengekspansi glob → `test/p15-*.test.ts` dst. jadi filter literal yang
//    tidak cocok satu pun file, dan seluruh suite p15..p24 dilewati diam-diam
//    (bukti lokal tercatat: `bun test test/p15-*.test.ts` tanpa ekspansi
//    menjalankan 0 file dari pola itu).
// 2. Pola mati dihapus: `test/test/*.test.ts` dan `test/bench/eval-gate.test.ts`
//    — keduanya tidak pernah ada di repo (glob = 0 file), jadi step test selalu
//    memunculkan "filters did not match" tanpa nilai proteksi.
// 3. Pola p15..p24 tetap tercantum di JOB UBUNTU dan CI WINDOWS (regresi yang
//    sudah dikunci p21/p22/p23, dipertahankan di sini sebagai satu rangkaian
//    Area F — jangan ada job yang diam-diam menghapus subset-nya).
//
// Catatan jujur: ekspansi bash lokal Windows/Linux TIDAK meniru shell Windows
// runner. Assertion di sini pada `shell: bash` — konfigurasi yang menghilangkan
// akar penyebab (pwsh) — bukan klaim eksekusi runner Windows.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ciPath = join(import.meta.dir, "..", ".github", "workflows", "ci.yml")
const ci = readFileSync(ciPath, "utf8")

describe("Area F: ci.yml glob & shell parity", () => {
  test("step test ci-windows memakai shell: bash (pwsh tidak mengekspansi)", () => {
    const idxWindows = ci.indexOf("ci-windows:")
    expect(idxWindows).toBeGreaterThan(0)
    const windows = ci.slice(idxWindows)
    const testIdx = windows.indexOf("Test jalur Windows")
    expect(testIdx).toBeGreaterThan(0)
    // Baris `shell: bash` harus muncul SEBELUM command test-nya.
    const shellIdx = windows.slice(0, testIdx).lastIndexOf("shell: bash")
    expect(shellIdx).toBeGreaterThan(0)
  })

  test("pola mati (test/test/*.test.ts, test/bench/eval-gate.test.ts) dihapus", () => {
    expect(ci).not.toContain("test/test/*.test.ts")
    expect(ci).not.toContain("test/bench/eval-gate.test.ts")
  })

  test("suite p15..p24 hadir di job ubuntu DAN ci-windows", () => {
    const idxWindows = ci.indexOf("ci-windows:")
    const ubuntu = ci.slice(0, idxWindows)
    const windows = ci.slice(idxWindows)
    for (let n = 15; n <= 24; n++) {
      expect(ubuntu, `ubuntu p${n}`).toContain(`test/p${n}-*.test.ts`)
      expect(windows, `windows p${n}`).toContain(`test/p${n}-*.test.ts`)
    }
  })
})
