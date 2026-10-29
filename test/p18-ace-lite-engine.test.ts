// [Fase 6A / ACE-01..04] ACE-Lite: deterministic consequence controller,
// evaluator tamper guard, new-evidence unlocker, provisional lesson gate, dan
// `ace_state` pada runtime header.
//
// Hermetik: temp dir, tanpa jaringan. Setiap cabang `evaluateConsequence`
// diuji eksplisit karena urutan aturannya adalah kontrak.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  addMemory,
  promoteOrRejectLessonsBySession,
  recordCandidateLesson,
  searchHybrid,
} from "../src/memory/vector.ts"
import {
  type AceFailureClass,
  type AceNextAction,
  evaluateConsequence,
} from "../src/policy/consequence-engine.ts"
import { createNoProgressDetector } from "../src/policy/no-progress.ts"
import { assembleContext } from "../src/session/context-assembly.ts"
import { buildRuntimeStateHeader } from "../src/session/runtime-header.ts"

const dirs: string[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-p18-ace-"))
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

// ── 1. Consequence matrix: 8 failure classes + 8 next actions ────────────────

describe("ACE-01 evaluateConsequence — failure class / next action matrix", () => {
  const cases: {
    label: string
    input: Parameters<typeof evaluateConsequence>[0]
    verdict: string
    failureClass: AceFailureClass
    nextAction: AceNextAction
  }[] = [
    {
      label: "verified evidence completes the task",
      input: { verificationPassed: true },
      verdict: "PASS",
      failureClass: "NONE",
      nextAction: "COMPLETE_AFTER_VERIFICATION",
    },
    {
      label: "transient environment failure retries",
      input: { isTransientError: true, failureType: "network_error" },
      verdict: "FAIL",
      failureClass: "TRANSIENT_ENV",
      nextAction: "RETRY_TRANSIENT",
    },
    {
      label: "first functional failure analyzes",
      input: { failureType: "functional" },
      verdict: "FAIL",
      failureClass: "FUNCTIONAL_TEST_FAIL",
      nextAction: "ANALYZE_FAILURE",
    },
    {
      label: "baseline change turns functional failure into regression",
      input: { failureType: "functional", baselineContentChanged: true },
      verdict: "FAIL",
      failureClass: "REGRESSION_DETECTED",
      nextAction: "REVISE_HYPOTHESIS",
    },
    {
      label: "repeated failure without new evidence changes strategy",
      input: { failureType: "functional", repeatedFailureCount: 2 },
      verdict: "FAIL",
      failureClass: "REPEATED_NO_EVIDENCE",
      nextAction: "CHANGE_STRATEGY",
    },
    {
      label: "insufficient evidence gathers diagnostics",
      input: { insufficientEvidence: true },
      verdict: "INCONCLUSIVE",
      failureClass: "INSUFFICIENT_EVIDENCE",
      nextAction: "GATHER_EVIDENCE",
    },
    {
      label: "permission blocker requests a human",
      input: { blockedByPermissionOrExternalBlocker: true },
      verdict: "BLOCKED",
      failureClass: "PERMISSION_OR_EXTERNAL_BLOCKER",
      nextAction: "REQUEST_HUMAN",
    },
    {
      label: "evaluator tamper stops and reports",
      input: { evaluatorTamperAttempt: true },
      verdict: "BLOCKED",
      failureClass: "EVALUATOR_TAMPER_ATTEMPT",
      nextAction: "STOP_AND_REPORT",
    },
  ]

  for (const c of cases) {
    test(c.label, () => {
      const d = evaluateConsequence(c.input)
      expect(d.verdict).toBe(c.verdict as never)
      expect(d.failureClass).toBe(c.failureClass)
      expect(d.nextAction).toBe(c.nextAction)
    })
  }

  test("budget exhaustion stops instead of retrying forever", () => {
    const d = evaluateConsequence({ budgetExhausted: true })
    expect(d.verdict).toBe("BLOCKED")
    expect(d.failureClass).toBe("INSUFFICIENT_EVIDENCE")
    expect(d.nextAction).toBe("STOP_AND_REPORT")
  })

  test("ACE-INV-01: tamper OVERRIDES passing evidence", () => {
    const d = evaluateConsequence({
      evaluatorTamperAttempt: true,
      verificationPassed: true,
      budgetExhausted: true,
    })
    expect(d.verdict).toBe("BLOCKED")
    expect(d.failureClass).toBe("EVALUATOR_TAMPER_ATTEMPT")
    expect(d.nextAction).toBe("STOP_AND_REPORT")
  })

  test("transient flag cannot mask a functional failure", () => {
    const d = evaluateConsequence({ failureType: "functional", isTransientError: true })
    expect(d.failureClass).toBe("FUNCTIONAL_TEST_FAIL")
  })

  test("repeated failure WITH new evidence does not force strategy change", () => {
    const d = evaluateConsequence({
      failureType: "functional",
      repeatedFailureCount: 5,
      newEvidenceSinceLastAttempt: true,
    })
    expect(d.failureClass).toBe("FUNCTIONAL_TEST_FAIL")
    expect(d.newEvidenceSinceLastAttempt).toBe(true)
  })

  test("fallback is fail-closed, never an invented PASS", () => {
    const d = evaluateConsequence({})
    expect(d.verdict).toBe("INCONCLUSIVE")
    expect(d.nextAction).toBe("GATHER_EVIDENCE")
  })
})

// ── 2. ACE-04: new-evidence unlocker with a hard cap ─────────────────────────

describe("ACE-04 no-progress new-evidence unlocker", () => {
  const failingCall = { name: "bash", args: { command: "run-migration" } }

  function failThreeTimes(det: ReturnType<typeof createNoProgressDetector>): void {
    for (let i = 0; i < 3; i++) {
      det.recordOutcome({
        name: "bash",
        args: failingCall.args,
        isError: true,
        content: "migration exploded",
      })
    }
  }

  test("block persists without fresh evidence", () => {
    const det = createNoProgressDetector({ maxRepeatedErrors: 3 })
    failThreeTimes(det)
    expect(det.evaluateBeforeCall(failingCall).allowed).toBe(false)
    expect(det.snapshot().justifiedRetriesUsed).toBe(0)
  })

  test("one fresh diagnostic read unlocks exactly one retry", () => {
    const det = createNoProgressDetector({ maxRepeatedErrors: 3 })
    failThreeTimes(det)
    expect(det.evaluateBeforeCall(failingCall).allowed).toBe(false)

    det.recordOutcome({
      name: "read_file",
      args: { path: "schema.sql" },
      isError: false,
      content: "CREATE TABLE ...",
    })
    expect(det.snapshot().newEvidenceSinceFailure).toBe(true)

    expect(det.evaluateBeforeCall(failingCall).allowed).toBe(true)
    expect(det.snapshot().justifiedRetriesUsed).toBe(1)
    expect(det.snapshot().newEvidenceSinceFailure).toBe(false)
  })

  test("hard cap: a second evidence read does NOT unlock another retry", () => {
    const det = createNoProgressDetector({ maxRepeatedErrors: 3 })
    failThreeTimes(det)
    det.recordOutcome({ name: "read_file", args: { path: "a.sql" }, isError: false, content: "x" })
    expect(det.evaluateBeforeCall(failingCall).allowed).toBe(true)

    // Retry fails again; even more diagnostics must not reopen the gate.
    det.recordOutcome({
      name: "bash",
      args: failingCall.args,
      isError: true,
      content: "migration exploded",
    })
    det.recordOutcome({ name: "read_file", args: { path: "b.sql" }, isError: false, content: "y" })
    expect(det.evaluateBeforeCall(failingCall).allowed).toBe(false)
    expect(det.snapshot().justifiedRetriesUsed).toBe(1)
  })

  test("green verification clears the persistent block", () => {
    const det = createNoProgressDetector({ maxRepeatedErrors: 3 })
    failThreeTimes(det)
    expect(det.evaluateBeforeCall(failingCall).allowed).toBe(false)
    det.noteVerificationPassed()
    expect(det.evaluateBeforeCall(failingCall).allowed).toBe(true)
  })

  test("successful workspace mutation also counts as new evidence", () => {
    const det = createNoProgressDetector({ maxRepeatedErrors: 3 })
    failThreeTimes(det)
    det.recordOutcome({
      name: "write_file",
      args: { path: "fix.ts", content: "export {}" },
      isError: false,
    })
    expect(det.snapshot().newEvidenceSinceFailure).toBe(true)
    expect(det.evaluateBeforeCall(failingCall).allowed).toBe(true)
  })
})

// ── 3. ACE-03: provisional lesson gate ──────────────────────────────────────

describe("ACE-03 provisional lesson gate", () => {
  test("candidate lesson is hidden from default retrieval until promoted", async () => {
    const dir = tempDir()
    const sid = "p18-ace-lessons"
    await addMemory("zebraword validated durable fact", { cwd: dir, tags: ["verify"] })
    await recordCandidateLesson(sid, "candidatekoala provisional lesson", { cwd: dir })

    const beforeValidated = await searchHybrid("zebraword", { cwd: dir })
    expect(beforeValidated.length).toBe(1)
    expect(beforeValidated[0]!.text).toContain("zebraword")

    const hidden = await searchHybrid("candidatekoala", { cwd: dir })
    expect(hidden.length).toBe(0)

    const visible = await searchHybrid("candidatekoala", { cwd: dir, includeProvisional: true })
    expect(visible.length).toBe(1)
    expect(visible[0]!.provenance?.validationStatus).toBe("provisional")

    const promoted = await promoteOrRejectLessonsBySession(sid, "passed", dir)
    expect(promoted.promoted).toBeGreaterThan(0)

    const afterPromote = await searchHybrid("candidatekoala", { cwd: dir })
    expect(afterPromote.length).toBe(1)
    expect(afterPromote[0]!.provenance?.validationStatus).toBe("validated")
  })

  test("failed verdict rejects provisional lessons", async () => {
    const dir = tempDir()
    const sid = "p18-ace-reject"
    await recordCandidateLesson(sid, "rejectword candidate claim", { cwd: dir })
    const rejected = await promoteOrRejectLessonsBySession(sid, "failed", dir)
    expect(rejected.rejected).toBeGreaterThan(0)

    const afterReject = await searchHybrid("rejectword", { cwd: dir })
    expect(afterReject.length).toBe(0)
    // Even the explicit provisional view must not resurrect rejected rows as
    // validation status, but it may still list them for diagnostics.
    const diagnostics = await searchHybrid("rejectword", { cwd: dir, includeProvisional: true })
    expect(diagnostics[0]?.provenance?.validationStatus).toBe("rejected")
  })

  test("unknown verdict is a no-op (never guesses)", async () => {
    const dir = tempDir()
    const sid = "p18-ace-unknown"
    await recordCandidateLesson(sid, "unknownword candidate claim", { cwd: dir })
    const r = await promoteOrRejectLessonsBySession(sid, "unknown", dir)
    expect(r).toEqual({ promoted: 0, rejected: 0 })
    const hidden = await searchHybrid("unknownword", { cwd: dir })
    expect(hidden.length).toBe(0)
  })
})

// ── 4. ACE-01 render: ace_state in runtime header + production path ─────────

describe("ACE-01 ace_state in runtime header", () => {
  test("buildRuntimeStateHeader renders the deterministic ace_state line", () => {
    const decision = evaluateConsequence({ verificationPassed: true })
    const header = buildRuntimeStateHeader({ turnCount: 2, aceDecision: decision })
    expect(header).toContain(
      "ace_state: verdict=PASS | failure_class=NONE | next_action=COMPLETE_AFTER_VERIFICATION | new_evidence=false",
    )
  })

  test("header omits ace_state when no decision exists", () => {
    const header = buildRuntimeStateHeader({ turnCount: 1 })
    expect(header).not.toContain("ace_state:")
  })

  test("assembleContext injects ace_state via operationalState (production path)", async () => {
    const dir = tempDir()
    const sid = "p18-ace-assemble"
    const { saveSession, DEFAULT_THREAD_ID } = await import("../src/session/persistence.ts")
    await saveSession(sid, dir, "sys", [{ role: "user", content: "halo" }], {})

    const decision = evaluateConsequence({
      evaluatorTamperAttempt: true,
    })
    const view = assembleContext(sid, DEFAULT_THREAD_ID, dir, {
      turnCount: 3,
      aceDecision: decision,
    })
    const first = view.messages[0] as { content: string }
    expect(first.content).toContain("[RUNTIME_STATE_HEADER")
    expect(first.content).toContain(
      "ace_state: verdict=BLOCKED | failure_class=EVALUATOR_TAMPER_ATTEMPT | next_action=STOP_AND_REPORT",
    )
  })
})
