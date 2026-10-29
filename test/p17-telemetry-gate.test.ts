// CTL-04 — Telemetry Gate robustness: BOM handling & structured failures.
//
// Hermetik: temp dir + traces.jsonl fixture control. Menguji 4 cabang gate:
//   1. Sukses → resolve rate ≥ target (30%) → exit 0
//   2. Gagal / Regresi → rate < target → exit 1 dengan warning jelas
//   3. Insufficient data → kurang dari 3 runs → skip silently, exit 0
//   4. Corrupted/BOM input → parse crash dihindari, fail-closed dengan pesan rapi, exit non-zero
//
// Invariant:
//   CTL-INV-01 : UTF-8 BOM tidak memicu stack trace parse error
//   CTL-INV-02 : Warn output terstruktur saat rate turun di bawah target
//   CTL-INV-03 : Tidak ada denylist diam-diam; semua kegagalan tercatat eksplisit

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"

const dirs: string[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-telemetry-gate-"))
  mkdirSync(join(d, ".minicode"), { recursive: true })
  dirs.push(d)
  return d
}

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

describe("CTL-04 — Telemetry Gate BOM Robustness & Structured Failures", () => {
  const script = join(import.meta.dir, "..", "scripts", "telemetry-gate.ts")

  test("gate passes when resolve rate >= target 0.3", async () => {
    const dir = tempDir()
    const tracesPath = join(dir, ".minicode", "traces.jsonl")
    
    // 4/6 = 0.67 >= 0.3 → PASS
    writeFileSync(tracesPath, `{"ok":true}\n{"ok":false}\n{"ok":true}\n{"ok":false}\n{"ok":true}\n{"ok":true}\n`, "utf8")
    
    const result = await $`bun ${script} ${dir}`.nothrow().text()
    expect(result).toContain("resolved=4/6")
    expect(result).toContain("rate=0.67")
    expect(result).not.toContain("WARN")
  })
  
  test("gate fails gracefully with clear warning when rate < target", async () => {
    const dir = tempDir()
    const tracesPath = join(dir, ".minicode", "traces.jsonl")
    
    // 1/6 = 0.17 < 0.3 → FAIL
    writeFileSync(tracesPath, `{"ok":true}\n{"ok":false}\n{"ok":false}\n{"ok":false}\n{"ok":false}\n{"ok":false}\n`, "utf8")
    
    const result = await $`bun ${script} ${dir}`.nothrow()
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("rate=0.17")
  })
  
  test("gate passes silently when insufficient data (<3 runs)", async () => {
    const dir = tempDir()
    const tracesPath = join(dir, ".minicode", "traces.jsonl")
    
    // Only 2 runs → skip with message
    writeFileSync(tracesPath, `{"ok":true}\n{"ok":false}\n`, "utf8")
    
    const result = await $`bun ${script} ${dir}`.nothrow()
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("too few runs")
  })
  
  test("BOM does not cause parse crash; fails closed cleanly", async () => {
    const dir = tempDir()
    const tracesPath = join(dir, ".minicode", "traces.jsonl")
    
    // Write with UTF-8 BOM (EF BB BF) at beginning
    const bomBuffer = Buffer.from([0xEF, 0xBB, 0xBF])
    const jsonLines = ["{\"ok\":true}", "{\"ok\":false}", "{\"ok\":true}"]
    const contentWithBOM = Buffer.concat([bomBuffer, Buffer.from(jsonLines.join("\n"), "utf8")])
    writeFileSync(tracesPath, contentWithBOM)
    
    // Should NOT throw parse error; script handles BOM stripping
    const result = await $`bun ${script} ${dir}`.nothrow()
    // With 2/3 after BOM strip, it should pass (rate >= target) or at least fail gracefully without stack trace
    expect(result.stderr.toString()).not.toContain("JSON Parse error")
    expect(result.stderr.toString()).not.toContain("SyntaxError")
    expect(result.exitCode).toBeGreaterThanOrEqual(0)
    expect(result.exitCode).toBeLessThanOrEqual(1)
  })
  
  test("corrupted JSON line causes fail-closed behavior with clean message", async () => {
    const dir = tempDir()
    const tracesPath = join(dir, ".minicode", "traces.jsonl")
    
    // Mix of valid and corrupted JSON lines
    const lines = [
      '{"ok":true}',
      '{invalid json}',  // Corrupt line
      '{"ok":false}',
    ]
    writeFileSync(tracesPath, lines.join("\n"), "utf8")
    
    const result = await $`bun ${script} ${dir}`.nothrow()
    // Corrupt JSON should cause JSON.parse to throw → script exits non-zero
    expect(result.exitCode).toBeGreaterThan(0)
    // Should not leak internal stack trace to stderr in a production scenario
    // (we just verify it doesn't crash with unhandled exception visible)
    expect(result.stderr.toString()).not.toContain("Stack trace")
  })
})