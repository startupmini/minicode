// P1 HYGIENE — F1a / F1b / F2 / F6. Minimal, generik, tanpa mengubah semantik.
// Masing-masing test membuktikan SATU temuan audit sudah tertutup, bukan
// sekadar "fungsi baru ada".

import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { buildResumeSpawnArgs } from "../cli/commands.ts"
import {
  type AdmissionPort,
  type AdmissionRequest,
  type AdmissionResult,
  createDispatchBridge,
  createDispatchId,
  type DispatchRequest,
} from "../src/runtime/dispatch.ts"
import { allocateExecutionId } from "../src/runtime/execution-id.ts"
import { createExecutionKernel } from "../src/runtime/execution-kernel.ts"
import { resolveRuntimeMode } from "../src/runtime/production-execution.ts"
import {
  createRecoveryEngine,
  type RecoveryContext,
  type RedispatchPlan,
} from "../src/runtime/recovery.ts"
import { isRedispatchAllowed, type RedispatchSafety } from "../src/runtime/recovery-safety.ts"
import { createSupervisor, type SupervisedAttempt } from "../src/runtime/supervisor.ts"

const repoRoot = join(import.meta.dir, "..")

// ── F1b: popup-resume meneruskan mode runtime apa adanya ─────────────────────
test("F1b: buildResumeSpawnArgs meneruskan off/constructed/owned tanpa ubah", () => {
  const entry = "/repo/cli/index.ts"
  expect(buildResumeSpawnArgs(entry, "sess-1", "/ws", "owned")).toEqual([
    entry,
    "--resume=sess-1",
    "--cwd=/ws",
    "--runtime",
    "owned",
  ])
  expect(buildResumeSpawnArgs(entry, "sess-1", "/ws", "constructed")).toEqual([
    entry,
    "--resume=sess-1",
    "--cwd=/ws",
    "--runtime",
    "constructed",
  ])
  expect(buildResumeSpawnArgs(entry, "sess-1", "/ws", "off")).toEqual([
    entry,
    "--resume=sess-1",
    "--cwd=/ws",
    "--runtime",
    "off",
  ])
  // Absen = tanpa flag (child default off; perilaku sebelum F1b).
  expect(buildResumeSpawnArgs(entry, "sess-1", "/ws", undefined)).toEqual([
    entry,
    "--resume=sess-1",
    "--cwd=/ws",
  ])
  // Tanpa cwd = tanpa --cwd (identitas resume tetap target, bukan cwd).
  expect(buildResumeSpawnArgs(entry, "sess-1", undefined, "owned")).toEqual([
    entry,
    "--resume=sess-1",
    "--runtime",
    "owned",
  ])
})

test("F1b: argv resume di-parse kembali ke mode yang sama (round-trip argv)", () => {
  for (const mode of ["off", "constructed", "owned"] as const) {
    const argv = buildResumeSpawnArgs("/repo/cli/index.ts", "sess-9", "/ws", mode)
    // argv anak = tanpa entryPath (process.argv.slice(2) di cli/index.ts).
    expect(resolveRuntimeMode(argv.slice(1)).mode).toBe(mode)
  }
  // Tanpa flag = off (fail-closed), bukan upgrade diam-diam.
  expect(
    resolveRuntimeMode(
      buildResumeSpawnArgs("/repo/cli/index.ts", "sess-9", "/ws", undefined).slice(1),
    ).mode,
  ).toBe("off")
})

// ── F2: non-finite safety input ditolak di SEMUA batas kanonis ──────────────
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

function recCtx(over: Partial<RecoveryContext> = {}): RecoveryContext {
  return {
    authorityHeld: true,
    budgetRemaining: 100,
    deadlineRemainingMs: 60_000,
    idempotent: false,
    dedupeKeyPresent: false,
    dedupeCheckPass: false,
    ...over,
  }
}

test("F2: predicate menolak NaN/±Infinity (budget & deadline)", () => {
  const allowBase: RedispatchSafety = { ...safeBase, effectDefinitelyNotStarted: true }
  expect(isRedispatchAllowed(allowBase)).toBe(true)
  for (const bad of [NaN, Infinity, -Infinity]) {
    expect(isRedispatchAllowed({ ...allowBase, budgetRemaining: bad })).toBe(false)
    expect(isRedispatchAllowed({ ...allowBase, deadlineRemainingMs: bad })).toBe(false)
  }
})

test("F2: semantik valid tetap: null=unbounded, <=0=exhausted, positif=available", () => {
  const allowBase: RedispatchSafety = { ...safeBase, effectDefinitelyNotStarted: true }
  // null = unbounded (kontrak lama, tak berubah).
  expect(
    isRedispatchAllowed({ ...allowBase, budgetRemaining: null, deadlineRemainingMs: null }),
  ).toBe(true)
  // <= 0 = exhausted (kontrak lama, tak berubah).
  expect(isRedispatchAllowed({ ...allowBase, budgetRemaining: 0 })).toBe(false)
  expect(isRedispatchAllowed({ ...allowBase, deadlineRemainingMs: -1 })).toBe(false)
  // Positif finite = available (kontrak lama, tak berubah).
  expect(isRedispatchAllowed({ ...allowBase, budgetRemaining: 1, deadlineRemainingMs: 1 })).toBe(
    true,
  )
})

test("F2: isPlanCurrent menolak NaN/+Infinity sebagai 'current'", () => {
  const engine = createRecoveryEngine()
  const plan: RedispatchPlan = {
    newExecutionId: allocateExecutionId(),
    attempt: 2,
    generation: 2,
    supersedes: allocateExecutionId(),
    lineageRootId: allocateExecutionId(),
    validity: {
      observedExecutionVersion: 3,
      journalFrontier: 50,
      authorityHeld: true,
      budgetRemaining: 10,
      deadlineRemainingMs: 5000,
    },
  }
  const fresh = {
    version: 3,
    frontier: 50,
    authorityHeld: true,
    budgetRemaining: 10,
    deadlineRemainingMs: 5000,
  }
  expect(engine.isPlanCurrent(plan, fresh)).toBe(true)
  for (const bad of [NaN, Infinity, -Infinity]) {
    expect(engine.isPlanCurrent(plan, { ...fresh, budgetRemaining: bad })).toBe(false)
    expect(engine.isPlanCurrent(plan, { ...fresh, deadlineRemainingMs: bad })).toBe(false)
  }
  // null current vs validity non-null = stale (kontrak lama).
  expect(engine.isPlanCurrent(plan, { ...fresh, budgetRemaining: null })).toBe(false)
})

/** Admission port jujur: Kernel nyata (create + ADMITTED). */
function kernelPort(kernel: ReturnType<typeof createExecutionKernel>) {
  return {
    admit(request: AdmissionRequest): AdmissionResult {
      try {
        const rec = kernel.create({
          executionId: request.executionId,
          ...(request.parentExecutionId ? { parentExecutionId: request.parentExecutionId } : {}),
          rootExecutionId: request.lineageRootId,
          kind: request.kind,
          ownerId: request.ownerId,
        })
        const r = kernel.requestTransition({
          executionId: rec.executionId,
          to: "ADMITTED",
          reason: "dispatch",
          source: "host",
        })
        if (!r.committed) return { admitted: false, reason: "kernel rejected admission" }
        return { admitted: true, executionId: request.executionId }
      } catch (e) {
        return { admitted: false, reason: (e as Error).message.slice(0, 120) }
      }
    },
  } satisfies AdmissionPort
}

function dispatchReq(over: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    dispatchId: createDispatchId(),
    schedulerSource: "hygiene",
    authorityHeld: true,
    provenance: { requestedBy: "hygiene", reason: "f2" },
    ...over,
  }
}

function hygienePlan(): RedispatchPlan {
  const e1 = allocateExecutionId()
  return {
    newExecutionId: allocateExecutionId(),
    attempt: 2,
    generation: 2,
    supersedes: e1,
    lineageRootId: e1,
    validity: {
      observedExecutionVersion: 3,
      journalFrontier: 50,
      authorityHeld: true,
      budgetRemaining: 10,
      deadlineRemainingMs: 5000,
    },
  }
}

test("F2: dispatch dengan refresh NaN/±Infinity = STALE, tanpa eksekusi", () => {
  const kernel = createExecutionKernel()
  const bridge = createDispatchBridge({ admission: kernelPort(kernel) })
  const base = {
    version: 3,
    frontier: 50,
    authorityHeld: true,
    budgetRemaining: 10,
    deadlineRemainingMs: 5000,
  }
  for (const bad of [NaN, Infinity, -Infinity]) {
    const plan = hygienePlan()
    const budgetBad = bridge.dispatch(dispatchReq({ recoveryPlan: plan }), {
      ...base,
      budgetRemaining: bad,
    })
    expect(budgetBad.state).toBe("STALE")
    expect(budgetBad.executionId).toBeUndefined()
    expect(kernel.get(plan.newExecutionId)).toBeUndefined()
    const deadlineBad = bridge.dispatch(dispatchReq({ recoveryPlan: plan }), {
      ...base,
      deadlineRemainingMs: bad,
    })
    expect(deadlineBad.state).toBe("STALE")
    expect(deadlineBad.executionId).toBeUndefined()
    expect(kernel.get(plan.newExecutionId)).toBeUndefined()
  }
  // Kontrol: refresh finite yang cocok TETAP admitted (tak ada regresi).
  const plan = hygienePlan()
  const ok = bridge.dispatch(dispatchReq({ recoveryPlan: plan }), base)
  expect(ok.state).toBe("ADMITTED")
  expect(ok.executionId).toBe(plan.newExecutionId)
})

test("F2: supervisor decideRetry menekan NaN/±Infinity (tak ada jalur M9 lolos)", () => {
  const kernel = createExecutionKernel()
  const sup = createSupervisor({ kernel })
  const attempt: SupervisedAttempt = {
    executionId: allocateExecutionId(),
    attempt: 1,
    generation: 1,
  }
  for (const bad of [NaN, Infinity, -Infinity]) {
    const r1 = sup.decideRetry(
      attempt,
      { ...safeBase, effectDefinitelyNotStarted: true, budgetRemaining: bad },
      1,
    )
    expect(r1.allowed).toBe(false)
    const r2 = sup.decideRetry(
      attempt,
      { ...safeBase, effectDefinitelyNotStarted: true, deadlineRemainingMs: bad },
      1,
    )
    expect(r2.allowed).toBe(false)
  }
  // Kontrol: basis aman + not-started TETAP boleh retry (tak ada regresi).
  const ok = sup.decideRetry(attempt, { ...safeBase, effectDefinitelyNotStarted: true }, 1)
  expect(ok).toEqual({ allowed: true, kind: "retry-in-execution" })
})

test("F2: M12 tidak membuat plan dari bukti NaN (suppressed, bukan unsafe-plan)", () => {
  const engine = createRecoveryEngine()
  const result = engine.recoverExecution(
    "exec_00000000-0000-4000-8000-000000000000",
    [],
    recCtx({ budgetRemaining: NaN }),
  )
  expect(result.redispatchPlan).toBeNull()
  expect(result.nextAction).not.toBe("PLAN_REDISPATCH")
})

// ── F6: peta cocok dengan tree aktual (generik, anti-drift masa depan) ──────
test("F6: jumlah modul src/runtime di peta = jumlah berkas aktual", () => {
  // Peta mendokumentasikan working tree (termasuk berkas yang belum di-commit),
  // jadi hitung dari filesystem — bukan dari index git.
  const actual = readdirSync(join(repoRoot, "src", "runtime")).filter((f) =>
    f.endsWith(".ts"),
  ).length
  const html = readFileSync(join(repoRoot, "docs/ARCHITECTURE.html"), "utf8")
  const m = html.match(/id="g-runtime"[\s\S]*?<span class="cnt">(\d+) modul<\/span>/)
  expect(m).not.toBeNull()
  expect(Number(m![1])).toBe(actual)
})

test("F6: kartu status produksi menyatakan default off + Stage D belum disetujui", () => {
  const html = readFileSync(join(repoRoot, "docs/ARCHITECTURE.html"), "utf8")
  expect(html).toContain("--runtime off")
  // "default-on" hanya boleh muncul bersama penanda "belum disetujui".
  const mentions = [...html.matchAll(/default-on/g)].length
  expect(mentions).toBeGreaterThan(0)
  expect(html).toContain("belum disetujui")
  expect(html).toContain("P2")
})
