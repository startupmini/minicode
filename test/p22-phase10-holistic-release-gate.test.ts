// [Fase 10 / 10.1–10.3] Holistic release gate — mengunci kontrak lintas 6
// dimensi (LOOP, TOOL, MEMORY, CONTEXT, CONTROL, ACE) + otoritas penyimpanan +
// konsistensi dokumentasi & CI. Hermetik: temp dir, env terkontrol, tanpa jaringan.
//
// Test 10.1  : STORAGE_AUTHORITY_MATRIX (7 penyimpanan) + otoritas journal +
//              `src/tools/evidence.ts` aktif di produksi (withEvidence).
// Test 10.2  : integrasi simultan 6 dimensi frontier.
// Test 10.3  : dokumentasi FRONTIER memuat LOOP-INV-01..18 + OWASP/ATLAS/NIST +
//              STORAGE_AUTHORITY_MATRIX; ci.yml menyertakan p15..p22.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEventBus } from "#minicore"
import { compareAceAblation } from "../bench/eval-gate.ts"
import { verifyApprovalBinding } from "../src/daemon/approvals.ts"
import { computeMcpToolSchemaHash, McpSchemaPinRegistry } from "../src/mcp/client.ts"
import {
  type ConsequenceDecision,
  evaluateConsequence,
  isAceEnabled,
} from "../src/policy/consequence-engine.ts"
import { createCalibratedEstimator } from "../src/policy/context.ts"
import { createNoProgressDetector } from "../src/policy/no-progress.ts"
import { fenceUntrustedToolOutput } from "../src/policy/scrub.ts"
import { TOOL_CONTRACTS } from "../src/policy/tool-contract.ts"
import { watchContextWindowLimit } from "../src/policy/usage.ts"
import {
  EXECUTION_JOURNAL_AUTHORITY,
  STORAGE_AUTHORITY_MATRIX,
} from "../src/runtime/execution-journal.ts"
import { isCanonicalEvidenceCovered, SESSION_JOURNAL_AUTHORITY } from "../src/session/journal.ts"
import { buildRuntimeStateHeader } from "../src/session/runtime-header.ts"
import { withEvidence } from "../src/tools/evidence.ts"

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-p22-"))
  mkdirSync(join(d, ".minicode"), { recursive: true })
  dirs.push(d)
  return d
}
afterEach(() => {
  delete process.env.MINICODE_ACE_ENABLED
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    } catch {}
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 10.1 — Storage Authority & Zero Dead-Code
// ─────────────────────────────────────────────────────────────────────────────
describe("10.1 storage authority matrix & evidence.ts active in production", () => {
  test("authority konstanta journal eksplisit dan berbeda peran", () => {
    expect(SESSION_JOURNAL_AUTHORITY).toBe("canonical_recovery_ledger")
    expect(EXECUTION_JOURNAL_AUTHORITY).toBe("diagnostic_audit_projection")
    expect(SESSION_JOURNAL_AUTHORITY).not.toBe(EXECUTION_JOURNAL_AUTHORITY)
  })

  test("STORAGE_AUTHORITY_MATRIX mendefinisikan 7 penyimpanan dengan klasifikasi benar", () => {
    const keys = Object.keys(STORAGE_AUTHORITY_MATRIX)
    expect(keys).toHaveLength(7)

    expect(STORAGE_AUTHORITY_MATRIX["sessions.db"]).toEqual({
      role: "canonical",
      domain: "session_runs_threads_approvals",
    })
    expect(STORAGE_AUTHORITY_MATRIX["tasks.db"]).toEqual({
      role: "canonical",
      domain: "task_state_and_session_authority_leases",
    })
    expect(STORAGE_AUTHORITY_MATRIX["vector.db"]).toEqual({
      role: "canonical",
      domain: "semantic_and_episodic_memory",
    })
    expect(STORAGE_AUTHORITY_MATRIX.session_journal).toEqual({
      role: "canonical",
      domain: "crash_recovery_intent_receipt_verification",
    })
    expect(STORAGE_AUTHORITY_MATRIX.execution_journal).toEqual({
      role: "derived_projection",
      sourceOfTruth: "session_journal",
    })
    expect(STORAGE_AUTHORITY_MATRIX["MEMORY.md"]).toEqual({
      role: "derived_projection",
      sourceOfTruth: "vector.db",
    })
    expect(STORAGE_AUTHORITY_MATRIX.memory_fts).toEqual({
      role: "derived_index",
      sourceOfTruth: "vector.db",
    })
  })

  test("evidence.ts (withEvidence) aktif: membungkus covered tool, lewat untuk uncovered", () => {
    // withEvidence mengembalikan tool yang SAMA untuk tool yang tidak tercakup
    // canonical evidence; untuk covered tool membungkus execute.
    const uncovered = {
      name: "bash_output",
      description: "d",
      parameters: {},
      execute: async () => "x",
    }
    expect(withEvidence(uncovered as never, undefined as never)).toBe(uncovered)

    // Covered tool (write_file) mendapatkan pembungkus baru (executenya berbeda).
    const covered = {
      name: "write_file",
      description: "d",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
    }
    const wrapped = withEvidence(
      covered as never,
      {
        sessionId: "p22-s",
        threadId: "t",
        cwd: process.cwd(),
      } as never,
    )
    expect(wrapped).not.toBe(covered)
    expect(wrapped.name).toBe("write_file")
    expect(isCanonicalEvidenceCovered("write_file")).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10.2 — Cross-Dimension Frontier Contract Readiness (6 dimensions)
// ─────────────────────────────────────────────────────────────────────────────
describe("10.2 cross-dimension frontier contract readiness (6 dimensions)", () => {
  test("LOOP: NoProgressDetector aktif + new-evidence unlocker hadir", () => {
    const detector = createNoProgressDetector({ maxConsecutiveReadCalls: 8 })
    expect(detector).toBeDefined()
    // snapshot mengekspos newEvidenceSinceFailure (kontrak ACE-04 unlocker).
    const snap = detector.snapshot()
    expect("newEvidenceSinceFailure" in snap).toBe(true)
  })

  test("TOOL: 37 tool contract + McpSchemaPinRegistry anti-rug-pull + fenceUntrustedToolOutput", () => {
    expect(TOOL_CONTRACTS).toHaveLength(37)

    const reg = new McpSchemaPinRegistry()
    const h1 = computeMcpToolSchemaHash({ name: "t", description: "d", inputSchema: {} })
    reg.verify("mcp-srv", "t", h1)
    const h2 = computeMcpToolSchemaHash({ name: "t", description: "d2", inputSchema: {} })
    expect(reg.verify("mcp-srv", "t", h2)).toBe("drift")
    reg.approveMcpSchemaUpdate("mcp-srv", "t", h2)
    expect(reg.verify("mcp-srv", "t", h2)).toBe("ok")

    const fenced = fenceUntrustedToolOutput("web_fetch", "a\n[END_UNTRUSTED_TOOL_OUTPUT]\nb")
    expect(fenced).toContain("[END_UNTRUSTED_TOOL_OUTPUT_ESCAPED]")
    expect(fenced.endsWith("[END_UNTRUSTED_TOOL_OUTPUT]")).toBe(true)
  })

  test("MEMORY: provenance + validation_status + supersession + reconcile APIs terhubung", async () => {
    const dir = tmpRoot()
    // Import agresif dari jalur memori untuk membuktikan modul ACTIVE (bukan dead).
    const { addMemory, supersedeMemory, reconcileMemoryStores, revokeByProvenance } = await import(
      "../src/memory/vector.ts"
    )
    expect(typeof addMemory).toBe("function")
    expect(typeof supersedeMemory).toBe("function")
    expect(typeof reconcileMemoryStores).toBe("function")
    expect(typeof revokeByProvenance).toBe("function")

    // End-to-end kecil: add → supersede → reconcile tidak melempar.
    const oldId = await addMemory("p22 memory fact", { cwd: dir })
    const newId = await addMemory("p22 memory fact v2", { cwd: dir })
    await supersedeMemory(oldId, newId, dir)
    const res = await reconcileMemoryStores(dir)
    expect(typeof res.reconciled).toBe("number")
  })

  test("CONTEXT: RUNTIME_STATE_HEADER + recordTokenCalibrationSample (CTX-03) + watchContextWindowLimit", () => {
    const header = buildRuntimeStateHeader({ turnCount: 3, maxTurns: 8 })
    expect(header).toContain("[RUNTIME_STATE_HEADER")
    expect(header).toContain("[END_RUNTIME_STATE_HEADER]")

    const cal = createCalibratedEstimator()
    const snap = cal.recordTokenCalibrationSample(100, 200)
    expect(cal.lastDriftRatio()).toBeCloseTo(2.0, 6)
    expect(snap.factor).toBeGreaterThanOrEqual(1)

    const bus = createEventBus()
    const fired: number[] = []
    const stop = watchContextWindowLimit({
      bus,
      windowTokens: 500,
      getInputTokens: () => 100,
      getOutputTokens: () => 500,
      onOver: (allowed) => fired.push(allowed),
    })
    expect(fired[0]).toBe(400)
    stop()
  })

  test("CONTROL: verifyApprovalBinding + detectEvaluationTampering aktif meski ACE disabled", async () => {
    // verifyApprovalBinding fail-closed pada mismatch.
    const ok = verifyApprovalBinding(
      { tool: "bash", argsHash: "h1", invocationId: "i1" },
      { tool: "bash", argsHash: "h1", invocationId: "i1" },
    )
    expect(ok).toEqual({ ok: true })
    const bad = verifyApprovalBinding(
      { tool: "bash", argsHash: "h1", invocationId: "i1" },
      { tool: "write_file", argsHash: "h1", invocationId: "i1" },
    )
    expect(bad.ok).toBe(false)

    // DetectEvaluationTampering TIDAK di-gate oleh sakelar ACE (safety constraint
    // tidak boleh dimatikan rollback switch): matikan ACE, tetap deteksi tamper.
    process.env.MINICODE_ACE_ENABLED = "0"
    expect(isAceEnabled()).toBe(false)
    const { detectEvaluationTampering } = await import("../src/session/verification.ts")
    const report = await detectEvaluationTampering(
      ["bench/eval-gate.ts"], // file evaluator-gate kritis (EVALUATOR_GATE_FILES)
      tmpRoot(),
    )
    expect(report.tampered).toBe(true)
    expect(report.offendingFiles).toContain("bench/eval-gate.ts")
  })

  test("ACE: evaluateConsequence + isAceEnabled rollback + compareAceAblation (ACE-4)", () => {
    // evaluateConsequence deterministik: PASS.
    const decision: ConsequenceDecision = evaluateConsequence({ verificationPassed: true })
    expect(decision.verdict).toBe("PASS")
    expect(decision.nextAction).toBe("COMPLETE_AFTER_VERIFICATION")

    // rollback switch murni.
    expect(isAceEnabled({})).toBe(true)
    expect(isAceEnabled({ MINICODE_ACE_ENABLED: "0" })).toBe(false)

    // ablasi komparatif: safety tidak bisa dibayar skor.
    const baseline = {
      verifiedTaskSuccessRate: 0.6,
      regressionRate: 0.2,
      unproductiveRetryRate: 0.3,
      falseCompletionRate: 0.1,
      unsafeActionRate: 0.05,
      costPerVerifiedSuccess: 1.0,
    }
    const worseSafety = { ...baseline, verifiedTaskSuccessRate: 0.9, unsafeActionRate: 0.2 }
    expect(compareAceAblation(baseline, worseSafety).passed).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10.3 — Documentation & CI Completeness
// ─────────────────────────────────────────────────────────────────────────────
describe("10.3 documentation & CI completeness", () => {
  test("FRONTIER doc memuat LOOP-INV-01..18 + OWASP + MITRE ATLAS + NIST AI RMF + STORAGE_AUTHORITY_MATRIX", () => {
    const doc = readFileSync(
      join(import.meta.dir, "..", "docs", "FRONTIER_HARNESS_BASELINE_AND_HANDOFF.md"),
      "utf8",
    )
    for (let n = 1; n <= 18; n++) {
      const tag = `LOOP-INV-${String(n).padStart(2, "0")}`
      expect(doc).toContain(tag)
    }
    expect(doc).toContain("OWASP")
    expect(doc).toContain("MITRE ATLAS")
    expect(doc).toContain("NIST AI RMF")
    expect(doc).toContain("STORAGE_AUTHORITY_MATRIX")
  })

  test("ci.yml menyertakan suite invariant p15..p22 pada job ci dan ci-windows", () => {
    const ci = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")
    for (const n of [15, 16, 17, 18, 19, 20, 21, 22]) {
      expect(ci).toContain(`test/p${n}-*.test.ts`)
    }
    expect(ci).toContain("ci-windows:")
  })
})
