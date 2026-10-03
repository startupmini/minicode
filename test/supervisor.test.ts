// M9 — Mechanical supervisor: klasifikasi, eskalasi bounded, retry-gated.
// Hermetic kecuali backend host nyata berumur pendek (pola M5).

import { expect, test } from "bun:test"
import { createHostBackend } from "../src/runtime/execution-backend.ts"
import { allocateExecutionId } from "../src/runtime/execution-id.ts"
import { createExecutionKernel } from "../src/runtime/execution-kernel.ts"
import {
  classifyFailure,
  createSupervisor,
  isRedispatchAllowed,
  nextBackoffMs,
  type RedispatchSafety,
  type SupervisedAttempt,
} from "../src/runtime/supervisor.ts"

const NODE = JSON.stringify(process.execPath)
const sleeper = (ms: number): string => `${NODE} -e "setTimeout(()=>{},${ms})"`
const sigtermIgnorer = (ms: number): string =>
  `${NODE} -e "process.on('SIGTERM',()=>{});setTimeout(()=>{},${ms})"`

function runningExec() {
  const kernel = createExecutionKernel()
  const rec = kernel.create({ kind: "turn", ownerId: "s" })
  kernel.requestTransition({
    executionId: rec.executionId,
    to: "ADMITTED",
    reason: "t",
    source: "test",
  })
  kernel.requestTransition({
    executionId: rec.executionId,
    to: "RUNNING",
    reason: "t",
    source: "test",
  })
  return { kernel, id: rec.executionId }
}

function supervised() {
  const { kernel, id } = runningExec()
  const sup = createSupervisor({ kernel })
  return { kernel, sup, id }
}

const safeBase: RedispatchSafety = {
  authorityHeld: true,
  budgetRemaining: 100,
  deadlineRemainingMs: 60_000,
  effectDefinitelyNotStarted: false,
  idempotent: false,
  dedupeKeyPresent: false,
  dedupeCheckPass: false,
  verifierConfirmedNotExecuted: false,
  evidenceRecorded: false,
}

const attempt = (over: Partial<SupervisedAttempt> = {}): SupervisedAttempt => ({
  executionId: allocateExecutionId(),
  attempt: 1,
  generation: 1,
  ...over,
})

// S1 — Observation: backend failure diterima + diklasifikasi.
test("S1 observation: backend failure diklasifikasi mekanis", () => {
  const { sup } = supervised()
  expect(sup.classify({ backendError: "spawn ENOENT" })).toBe("backend-failure")
  expect(sup.classify({ backendResult: "vanished" })).toBe("backend-failure")
  expect(sup.classify({ backendResult: "timeout" })).toBe("backend-noncooperative")
  expect(sup.classify({})).toBeNull()
  expect(sup.classify({ timedOut: true, budgetExhausted: true })).toBe("budget-exceeded")
  expect(sup.metrics().supervisorObserved).toBeGreaterThan(0)
})

// S2 — Timeout → Kernel CANCELLING(reason=timeout), terminal via mapping.
test("S2 timeout: request CANCELLING + settle TIMED_OUT via kernel", () => {
  const { kernel, sup, id } = supervised()
  const r = sup.requestCancel(id, "timeout")
  expect(r).toEqual({ requested: true, outcome: "cancelling-requested" })
  expect(kernel.get(id)?.state).toBe("CANCELLING")
  const s = sup.settleCancellation(id, "timeout")
  expect(s).toEqual({ requested: true, outcome: "terminal-requested", terminal: "TIMED_OUT" })
  expect(kernel.get(id)?.state).toBe("TIMED_OUT")
  expect(kernel.get(id)?.reason).toBe("timeout")
})

// S3 — Budget → BUDGET_EXCEEDED (bukan FAILED generik).
test("S3 budget: kernel terminal BUDGET_EXCEEDED", () => {
  const { kernel, sup, id } = supervised()
  expect(classifyFailure({ budgetExhausted: true })).toBe("budget-exceeded")
  sup.requestCancel(id, "budget")
  const s = sup.settleCancellation(id, "budget")
  expect(s.terminal).toBe("BUDGET_EXCEEDED")
  expect(kernel.get(id)?.state).toBe("BUDGET_EXCEEDED")
})

// S4 — Orphan: deteksi + eskalasi-rekonsiliasi (tanpa invent completion).
test("S4 orphan: mark + klasifikasi, tanpa terminal inventaris", () => {
  const { kernel, sup, id } = supervised()
  expect(sup.classify({ orphanSuspected: true })).toBe("orphan")
  expect(sup.classify({ backendResult: "orphan" })).toBe("orphan")
  const mark = sup.markOrphan(id, "handle unreachable, intent durable")
  expect(mark.action).toBe("escalate-reconcile")
  expect(sup.metrics().supervisorOrphan).toBe(1)
  expect(kernel.get(id)?.state).toBe("RUNNING")
})

// S5 — Authority loss → CANCELLING(authority) + AUTHORITY_LOST.
test("S5 authority: loss → AUTHORITY_LOST via kernel", () => {
  const { kernel, sup, id } = supervised()
  expect(sup.classify({ authorityLost: true })).toBe("authority-lost")
  sup.requestCancel(id, "authority")
  const s = sup.settleCancellation(id, "authority")
  expect(s.terminal).toBe("AUTHORITY_LOST")
  expect(kernel.get(id)?.state).toBe("AUTHORITY_LOST")
  expect(sup.metrics().supervisorAuthorityLoss).toBe(0)
})

// S6 — Cancel escalation: cancel → wait → terminate → wait (bounded).
test("S6 escalation: cancel→wait→terminate→wait bounded", async () => {
  const backend = createHostBackend()
  const started = await backend.start({ cmd: sigtermIgnorer(30_000) })
  if (!started.started) throw new Error("setup failed")
  const { sup } = supervised()
  const t0 = Date.now()
  const res = await sup.escalate(started.handle, "test", { backend, waitMs: 400 })
  expect(Date.now() - t0).toBeLessThan(15_000)
  expect(res.cancelResult).toBe("cancel-requested")
  if (process.platform !== "win32") {
    // POSIX: SIGTERM diabaikan → wait timeout → terminate → proven-dead.
    expect(res.waitAfterCancel).toBe("timeout")
    expect(res.terminated).toBe(true)
    expect(res.waitAfterTerminate).toBe("proven-dead")
  } else {
    // Windows: cancel = taskkill tree (langsung mati) → selesai di tahap cancel.
    expect(["proven-dead", "completed"]).toContain(res.waitAfterCancel)
    expect(res.terminated).toBe(false)
    expect(res.waitAfterTerminate).toBeNull()
  }
  expect(sup.metrics().supervisorEscalation).toBe(1)
  backend.dispose(started.handle)
}, 30000)

// S7 — Non-cooperative backend: bounded, jujur.
test("S7 non-cooperative: cancel tak membunuh (POSIX) + eskalasi menutup", async () => {
  const backend = createHostBackend()
  const started = await backend.start({ cmd: sigtermIgnorer(20_000) })
  if (!started.started) throw new Error("setup failed")
  const { sup } = supervised()
  expect(sup.classify({ cancelRequestedButAlive: true })).toBe("backend-noncooperative")
  const res = await sup.escalate(started.handle, "test", { backend, waitMs: 300 })
  if (process.platform !== "win32") {
    expect(res.waitAfterCancel).toBe("timeout")
    expect(res.terminated).toBe(true)
    expect(res.waitAfterTerminate).toBe("proven-dead")
  } else {
    expect(["proven-dead", "completed"]).toContain(res.waitAfterCancel)
    expect(res.waitAfterTerminate).toBeNull()
  }
  backend.dispose(started.handle)
}, 30000)

// S8 — Retry suppression: UNKNOWN non-idempotent → NO retry.
test("S8 suppression: UNKNOWN + non-idempotent = tolak", () => {
  const { sup } = supervised()
  const d = sup.decideRetry(attempt(), { ...safeBase }, 1)
  expect(d).toEqual({
    allowed: false,
    reason: "UNKNOWN non-idempotent effect (at-most-once default)",
  })
  expect(isRedispatchAllowed({ ...safeBase })).toBe(false)
  expect(sup.metrics().supervisorRetrySuppressed).toBe(1)
})

// S9 — Retry allow: not-started → intra; idempotent+key → redispatch; verifier → redispatch.
test("S9 allow: tiga jalur aman predicate", () => {
  const { sup } = supervised()
  const r1 = sup.decideRetry(attempt(), { ...safeBase, effectDefinitelyNotStarted: true }, 1)
  expect(r1).toEqual({ allowed: true, kind: "retry-in-execution" })
  const r2 = sup.decideRetry(
    attempt(),
    { ...safeBase, idempotent: true, dedupeKeyPresent: true, dedupeCheckPass: true },
    1,
  )
  expect(r2).toEqual({ allowed: true, kind: "redispatch-new-execution" })
  const r3 = sup.decideRetry(
    attempt(),
    { ...safeBase, verifierConfirmedNotExecuted: true, evidenceRecorded: true },
    1,
  )
  expect(r3).toEqual({ allowed: true, kind: "redispatch-new-execution" })
  // Tanpa authority/budget/deadline → tolak + alasan tepat.
  expect(sup.decideRetry(attempt(), { ...safeBase, authorityHeld: false }, 1)).toEqual({
    allowed: false,
    reason: "authority not held",
  })
  expect(sup.decideRetry(attempt(), { ...safeBase, budgetRemaining: 0 }, 1)).toEqual({
    allowed: false,
    reason: "budget exhausted",
  })
  expect(sup.decideRetry(attempt(), { ...safeBase, deadlineRemainingMs: 0 }, 1)).toEqual({
    allowed: false,
    reason: "deadline expired",
  })
})

// S10 — Retry identity: re-dispatch = E baru + generation + supersedes.
test("S10 identity: E1≠E2, generation+1, supersedes", () => {
  const { sup } = supervised()
  const a1 = attempt({ attempt: 1, generation: 2 })
  const a2 = sup.planRedispatch(a1)
  expect(a2.executionId).not.toBe(a1.executionId)
  expect(a2.attempt).toBe(2)
  expect(a2.generation).toBe(3)
  expect(a2.supersedes).toBe(a1.executionId)
  expect(Object.isFrozen(a2)).toBe(true)
})

// S11 — Crash loop: backoff eksponensial + intensity bound.
test("S11 intensity: burst → escalate-stop; backoff deterministik", () => {
  expect(nextBackoffMs(1)).toBe(1000)
  expect(nextBackoffMs(2)).toBe(2000)
  expect(nextBackoffMs(3)).toBe(4000)
  expect(nextBackoffMs(10)).toBe(8000)
  expect(nextBackoffMs(10, { backoffBaseMs: 500, backoffMaxMs: 1500 })).toBe(1500)
  const { sup } = supervised()
  const id = allocateExecutionId()
  for (let i = 0; i < 5; i++) {
    expect(sup.noteFailure(id, `f${i}`).duplicate).toBe(false)
    expect(sup.checkIntensity(id).ok).toBe(true)
  }
  expect(sup.noteFailure(id, "f5").duplicate).toBe(false)
  const check = sup.checkIntensity(id)
  expect(check.ok).toBe(false)
  expect(sup.metrics().supervisorBackoff).toBe(1)
})

// S12 — Terminal race: laporan telat → ignored (kernel menang).
test("S12 terminal-race: late report tak overwrite", () => {
  const { kernel, sup, id } = supervised()
  sup.requestCancel(id, "user")
  sup.settleCancellation(id, "user")
  expect(kernel.get(id)?.state).toBe("CANCELLED")
  expect(sup.noteLateReport(id)).toEqual({ action: "ignored-audit", state: "CANCELLED" })
  const again = sup.requestCancel(id, "timeout")
  expect(again.requested).toBe(false)
})

// S13 — Child isolation: child failure ≠ parent failure.
test("S13 child: failure anak tak fail parent; detached dihormati", () => {
  const { kernel, sup, id } = supervised()
  const child = kernel.create({
    executionId: allocateExecutionId(),
    parentExecutionId: id,
    rootExecutionId: id,
    kind: "child",
    ownerId: "s",
  })
  expect(
    kernel.requestTransition({
      executionId: child.executionId,
      to: "ADMITTED",
      reason: "t",
      source: "test",
    }).committed,
  ).toBe(true)
  expect(
    kernel.requestTransition({
      executionId: child.executionId,
      to: "RUNNING",
      reason: "t",
      source: "test",
    }).committed,
  ).toBe(true)
  expect(
    kernel.requestTransition({
      executionId: child.executionId,
      to: "FAILED",
      reason: "boom",
      source: "test",
    }).committed,
  ).toBe(true)
  expect(kernel.get(id)?.state).toBe("RUNNING")
  // Attached live → propagate; terminal → noop; detached → skip.
  const plan = sup.planChildCancel(
    [
      { executionId: child.executionId, terminal: true },
      { executionId: "exec_99999999-9999-4999-8999-999999999999", terminal: false },
      { executionId: "exec_88888888-8888-4888-8888-888888888888", terminal: false },
    ],
    new Set(["exec_88888888-8888-4888-8888-888888888888"]),
  )
  expect(plan.cancelRequested).toEqual(["exec_99999999-9999-4999-8999-999999999999"])
  expect(plan.noopTerminal).toEqual([child.executionId])
  expect(plan.detachedSkipped).toEqual(["exec_88888888-8888-4888-8888-888888888888"])
})

// S14 — Detached: parent-cancel tak sentuh detached.
test("S14 detached: scope independen", () => {
  const { sup } = supervised()
  const plan = sup.planChildCancel(
    [{ executionId: "exec_77777777-7777-4777-8777-777777777777", terminal: false }],
    new Set(["exec_77777777-7777-4777-8777-777777777777"]),
  )
  expect(plan.cancelRequested).toEqual([])
  expect(plan.detachedSkipped).toHaveLength(1)
})

// S15 — Duplicate action: fingerprint sama dua kali → kedua diabaikan.
test("S15 duplicate: failure report ganda tak gandakan retry", () => {
  const { sup } = supervised()
  const id = allocateExecutionId()
  expect(sup.noteFailure(id, "boom@a1").duplicate).toBe(false)
  expect(sup.noteFailure(id, "boom@a1").duplicate).toBe(true)
  expect(sup.noteFailure(id, "boom@a2").duplicate).toBe(false)
})

// Races: timeout+complete, budget+complete, authority+complete, cancel+backend-failure.
test("M9 races: terminal menang; supervisor tak overwrite", () => {
  const { kernel, sup, id } = supervised()
  kernel.requestTransition({
    executionId: id,
    to: "COMPLETED",
    reason: "done",
    source: "agent-loop",
  })
  for (const reason of ["timeout", "budget", "authority", "user"] as const) {
    const r = sup.requestCancel(id, reason)
    expect(r.requested, reason).toBe(false)
  }
  expect(kernel.get(id)?.state).toBe("COMPLETED")
  expect(sup.noteLateReport(id).state).toBe("COMPLETED")
})

// P1–P12 properties.
test("M9 properties P1-P12", async () => {
  const backend = createHostBackend()
  const started = await backend.start({ cmd: sleeper(5000) })
  if (!started.started) throw new Error("setup failed")
  const { kernel, sup } = supervised()
  // P1: supervisor tak pernah mutasi langsung (hanya via requestTransition — API check).
  const api = sup as unknown as Record<string, unknown>
  for (const f of ["complete", "fail", "setState", "writeTerminal", "mutate", "transition"]) {
    expect(api[f], f).toBeUndefined()
  }
  // P2: terminal tak terima terminal baru (via supervisor path).
  const { id } = runningExec2(kernel)
  kernel.requestTransition({ executionId: id, to: "COMPLETED", reason: "d", source: "test" })
  expect(sup.requestCancel(id, "user").requested).toBe(false)
  // P5: re-dispatch = E baru.
  const a2 = sup.planRedispatch(attempt())
  expect(a2.executionId).not.toBe(attempt().executionId)
  // P6/P7/P8: predicate menolak deadline/budget/authority habis.
  expect(isRedispatchAllowed({ ...safeBase, deadlineRemainingMs: -1 })).toBe(false)
  expect(isRedispatchAllowed({ ...safeBase, budgetRemaining: 0 })).toBe(false)
  expect(isRedispatchAllowed({ ...safeBase, authorityHeld: false })).toBe(false)
  // P11: eskalasi bounded (diukur).
  const t0 = Date.now()
  await sup.escalate(started.handle, "p11", { backend, waitMs: 200 })
  expect(Date.now() - t0).toBeLessThan(10_000)
  backend.dispose(started.handle)
  // P9/P10: covered S13/S14. P3/P4: covered S8/S9. P12: covered S15. P2: covered di atas.
})

function runningExec2(kernel: ReturnType<typeof createExecutionKernel>) {
  const rec = kernel.create({ kind: "turn", ownerId: "s" })
  kernel.requestTransition({
    executionId: rec.executionId,
    to: "ADMITTED",
    reason: "t",
    source: "test",
  })
  kernel.requestTransition({
    executionId: rec.executionId,
    to: "RUNNING",
    reason: "t",
    source: "test",
  })
  return { id: rec.executionId }
}

// Security: supervisor tak beri capability/authority/owner baru; sinyal tepercaya.
test("M9 security: tanpa eskalasi authority/capability/owner", () => {
  const { sup } = supervised()
  const api = sup as unknown as Record<string, unknown>
  for (const f of [
    "grant",
    "authorize",
    "setOwner",
    "mintExecutionId",
    "bypassBudget",
    "bypassDeadline",
    "sandbox",
    "kill",
  ]) {
    expect(api[f], f).toBeUndefined()
  }
  // decideRetry tak menerima owner baru / executionId arbitrer sebagai authority.
  const d = sup.decideRetry(
    attempt({ executionId: "exec_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" }),
    { ...safeBase, effectDefinitelyNotStarted: true },
    1,
  )
  expect(d).toEqual({ allowed: true, kind: "retry-in-execution" })
})
