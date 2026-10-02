// M7 — Parent/child execution contract: SATU canonical spec untuk delegate +
// autonomous, BUKAN dua validasi berbeda.
//
// Kenapa berkas ini ada (P1 ADR-003): delegate_task (src/tools/task.ts) dan
// autonomous execution (src/task/autonomous-*) masing-masing menemukan ulang
// warisan cwd/model/sinyal, cap langkah, dan isolasi — tanpa kontrak bersama
// untuk identitas, capability, deadline, budget, dan detached. Modul ini
// menyatukan VALIDASI + DERIVASI pra-eksekusi; eksekusi aktual tetap milik
// jalur existing (factory sesi anak + antrean konkurensi + session.run),
// lifecycle authority milik Kernel (M8), klaim milik TaskStore/Scheduler,
// recovery milik M12.
//
// BUKAN: DAG (tree saja — tepat satu parent), nested umum, Execution FSM,
// supervisor/retry, recovery, scheduler bridge, persistence redesign, kill
// fisik (M5), capability enforcement (M6 + jail/guard), production wiring
// (delegate_task/autonomous TAK DIUBAH di sini — adopsi = M14).
// Aturan yang dikunci (jangan dilonggarkan tanpa ADR baru):
// - E_child baru via M1 allocator (tak pernah reuse parent/task/session id).
// - childGrant ⊆ parentGrant via M6 attenuateGrant (TANPA algoritma kedua).
// - childDeadline ≤ parentRemaining (clamp, bukan fresh time; tak pernah gain).
// - Sub-budget subtractive dengan reservation arithmetic; model current =
//   fixed-cap consumptive (evidence: cap explore/plan + hard-cap di task.ts +
//   LIMITS) — overcommit antar sibling dicegah HANYA bila caller merangkai
//   remainingAfter (didokumentasikan jujur, bukan diklaim).
// - Parent cancel → cancel REQUEST untuk live child; terminal child = NO-OP +
//   audit (tak pernah COMPLETED→CANCELLED). Tak ada mutasi terminal di sini.
// - Attached default tak boleh silent-outlive parent; detached eksplisit butuh
//   owner + TTL + killPath + audit; lineage_root immutable, cancel_scope
//   independen. Detached ≠ background (kelas lifecycle vs scope — terpisah).
// - Workspace child di dalam parent (M6 isPathWithin); model routing = metadata
//   (bukan capability). Tak ada import FSM/supervisor/persistence/scheduler/
//   backend-spawn — modul murni (H12-style boundary test menjaganya).

import { LIMITS } from "../constants.ts"
import {
  attenuateGrant,
  type Capability,
  type CapabilityGrant,
  isPathWithin,
} from "./capability.ts"
import { createChildCorrelation, type ExecutionCorrelation } from "./execution-id.ts"

/** Mode anak yang dikenal current system (evidence: task.ts explore/plan). */
export type ChildMode = "explore" | "plan"

export interface DetachedSpec {
  /** Owner baru yang bertanggung jawab (bukan authority arbitrer user). */
  readonly ownerId: string
  /** TTL ms — tanpa TTL = tolak (tak ada outlive tanpa batas). */
  readonly ttlMs: number
  /** Deskriptor kill path (mis. "owner-cancel", "ttl-sweep"); dieksekusi pemilik, bukan M7. */
  readonly killPath: string
}

/** Canonical child spec — SATU bentuk untuk delegate maupun autonomous. */
export interface ChildExecutionSpec {
  readonly parent: ExecutionCorrelation
  readonly kind: "child"
  readonly ownerId: string
  readonly mode: ChildMode
  /** Batas langkah yang diminta (default = cap mode). */
  readonly budgetSteps?: number
  /** Sisa langkah parent yang diketahui (bila tak diketahui = fixed-cap saja). */
  readonly parentRemainingSteps?: number
  /** Deadline yang diminta ms (default = sisa parent / cap backend). */
  readonly deadlineMs?: number
  /** Sisa deadline parent ms (bila tak diketahui = cap backend). */
  readonly parentRemainingDeadlineMs?: number
  /** Kapabilitas yang diminta untuk anak (harus ⊆ parent grant). */
  readonly requestedCapabilities: readonly Capability[]
  /** Grant parent sebagai upper bound (wajib). */
  readonly parentGrant: CapabilityGrant
  /** Workspace anak (default = parent workspace yang diteruskan caller). */
  readonly workspaceCwd: string
  /** Workspace parent (batas atas). */
  readonly parentWorkspaceCwd: string
  /** Routing model warisan (metadata, BUKAN capability). */
  readonly modelRouting?: string
  /** Backend hint (mis. "host"); enforcement milik M5 (bukan eksekusi di sini). */
  readonly backendHint?: string
  /** Attached default; detached eksplisit = independen + wajib TTL/owner/kill. */
  readonly detached?: DetachedSpec
}

export interface ChildAdmission {
  readonly correlation: ExecutionCorrelation
  readonly grant: CapabilityGrant
  /** Deadline efektif anak (clamp ≤ sisa parent; tak pernah fresh). */
  readonly effectiveDeadlineMs: number | null
  /** Budget langkah efektif anak. */
  readonly budgetSteps: number
  /** Sisa parent sesudah reservasi (bila parentRemainingSteps diketahui). */
  readonly parentRemainingAfter: number | null
  readonly workspaceCwd: string
  readonly cancelScope:
    | { readonly kind: "parent" }
    | { readonly kind: "detached"; readonly owner: string }
  readonly detached: DetachedSpec | null
}

function modeStepCap(mode: ChildMode): number {
  // Evidence: SUB_AGENT_BUDGET_EXPLORE/PLAN + hard-cap DEFAULT_MAX_STEPS (task.ts).
  const cap = mode === "explore" ? LIMITS.SUB_AGENT_BUDGET_EXPLORE : LIMITS.SUB_AGENT_BUDGET_PLAN
  return Math.min(cap, LIMITS.DEFAULT_MAX_STEPS)
}

/**
 * Validasi + derivasi admission anak (murni, tanpa efek samping), sesuai urutan:
 * parent → identity → capability → deadline → budget → workspace → detached →
 * metadata. Gagal = {admitted:false, reason} (tak pernah throw untuk alasan
 * domain; throw hanya untuk bentuk tak-valid pemrogram).
 */
export function admitChild(
  spec: ChildExecutionSpec,
  now: number = Date.now(),
): { admitted: true; admission: ChildAdmission } | { admitted: false; reason: string } {
  void now
  if (!spec?.parent?.executionId || !spec.parent?.rootExecutionId)
    return { admitted: false, reason: "invalid parent correlation" }
  if (spec.kind !== "child") return { admitted: false, reason: "kind must be 'child'" }
  if (!spec.ownerId) return { admitted: false, reason: "ownerId is required" }
  if (spec.mode !== "explore" && spec.mode !== "plan")
    return { admitted: false, reason: "mode must be explore|plan" }
  if (!spec.parentGrant) return { admitted: false, reason: "parentGrant is required (upper bound)" }
  if (!spec.workspaceCwd || !spec.parentWorkspaceCwd)
    return { admitted: false, reason: "workspaceCwd + parentWorkspaceCwd are required" }

  // 2. Identity baru (E2 ≠ E1; root diwariskan tanpa rewrite).
  let correlation: ExecutionCorrelation
  try {
    correlation = createChildCorrelation(spec.parent, spec.kind, spec.ownerId)
  } catch {
    return { admitted: false, reason: "invalid parent correlation" }
  }

  // 3. Capability: attenuasi via M6 (tanpa algoritma kedua).
  const attenuated = attenuateGrant(spec.parentGrant, {
    executionId: correlation.executionId,
    ownerId: spec.ownerId,
    capabilities: spec.requestedCapabilities,
    requestedBy: "m7:admitChild",
  })
  if (!("granted" in attenuated))
    return { admitted: false, reason: `capability: ${attenuated.denied}` }

  // 4. Deadline: ≤ sisa parent; tak diketahui = ceiling backend existing.
  // Evidence ceiling: SUB_AGENT_TIMEOUT_MS (task.ts:259 factory timeout).
  const backendCeiling = LIMITS.SUB_AGENT_TIMEOUT_MS
  let effectiveDeadlineMs: number | null
  if (spec.parentRemainingDeadlineMs !== undefined) {
    if (spec.parentRemainingDeadlineMs <= 0)
      return { admitted: false, reason: "parent deadline already exhausted" }
    const wanted = spec.deadlineMs ?? spec.parentRemainingDeadlineMs
    if (wanted <= 0) return { admitted: false, reason: "invalid deadlineMs" }
    effectiveDeadlineMs = Math.min(wanted, spec.parentRemainingDeadlineMs)
  } else if (spec.deadlineMs !== undefined) {
    if (spec.deadlineMs <= 0) return { admitted: false, reason: "invalid deadlineMs" }
    effectiveDeadlineMs = Math.min(spec.deadlineMs, backendCeiling)
  } else {
    effectiveDeadlineMs = backendCeiling
  }

  // 5. Budget subtractive: fixed-cap consumptive (model current) + reservasi
  // bila sisa diketahui. Tanpa sisa = cap mode (jujur: tanpa proteksi overcommit
  // antar sibling — caller harus merangkai parentRemainingAfter).
  const cap = modeStepCap(spec.mode)
  const wantedSteps = spec.budgetSteps ?? cap
  if (!Number.isFinite(wantedSteps) || wantedSteps <= 0)
    return { admitted: false, reason: "invalid budgetSteps" }
  const boundedSteps = Math.min(Math.floor(wantedSteps), cap)
  let parentRemainingAfter: number | null = null
  let budgetSteps = boundedSteps
  if (spec.parentRemainingSteps !== undefined) {
    if (spec.parentRemainingSteps <= 0)
      return { admitted: false, reason: "parent budget exhausted" }
    budgetSteps = Math.min(boundedSteps, Math.floor(spec.parentRemainingSteps))
    if (budgetSteps <= 0) return { admitted: false, reason: "parent budget exhausted" }
    parentRemainingAfter = spec.parentRemainingSteps - budgetSteps
  }

  // 6. Workspace: di dalam parent (M6; enforcement symlink milik jail).
  let workspaceOk = false
  try {
    workspaceOk = isPathWithin(spec.parentWorkspaceCwd, spec.workspaceCwd)
  } catch {
    workspaceOk = false
  }
  if (!workspaceOk) return { admitted: false, reason: "workspace outside parent scope" }

  // 7. Detached: eksplisit + lengkap, atau attached default.
  let detached: DetachedSpec | null = null
  let cancelScope: ChildAdmission["cancelScope"] = { kind: "parent" }
  if (spec.detached !== undefined) {
    const d = spec.detached
    if (!d.ownerId || !Number.isFinite(d.ttlMs) || d.ttlMs <= 0 || !d.killPath)
      return { admitted: false, reason: "detached requires ownerId + positive ttlMs + killPath" }
    detached = { ownerId: d.ownerId, ttlMs: d.ttlMs, killPath: d.killPath }
    cancelScope = { kind: "detached", owner: d.ownerId }
  }

  return {
    admitted: true,
    admission: {
      correlation,
      grant: attenuated.granted,
      effectiveDeadlineMs,
      budgetSteps,
      parentRemainingAfter,
      workspaceCwd: spec.workspaceCwd,
      cancelScope,
      detached,
    },
  }
}

/** True bila detached melewati TTL (observasi; eksekusi kill milik owner). */
export function isDetachedExpired(
  spawnedAtMs: number,
  ttlMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!Number.isFinite(spawnedAtMs) || !Number.isFinite(ttlMs) || ttlMs <= 0) return true
  return nowMs - spawnedAtMs >= ttlMs
}

export interface ChildCancelPlan {
  /** Live child → cancel REQUEST (otoritas transisi milik M8, bukan di sini). */
  readonly cancelRequested: readonly string[]
  /** Terminal child → NO-OP + audit (tak pernah mutasi terminal). */
  readonly noopTerminal: readonly string[]
}

/**
 * Propagation planning parent-cancel (murni observasi): terminal tetap terminal;
 * live mendapat cancel request. TAK ADA mutasi state di sini (M8 yang mengeksekusi).
 */
export function planParentCancellation(
  children: readonly { executionId: string; terminal: boolean }[],
): ChildCancelPlan {
  const cancelRequested: string[] = []
  const noopTerminal: string[] = []
  for (const c of children) {
    if (!c || typeof c.executionId !== "string") continue
    if (c.terminal) noopTerminal.push(c.executionId)
    else cancelRequested.push(c.executionId)
  }
  return {
    cancelRequested: Object.freeze(cancelRequested),
    noopTerminal: Object.freeze(noopTerminal),
  }
}

/** Ringkasan observasi tree (metadata; bukan graph persistence). */
export function describeChildTree(
  parentExecutionId: string,
  children: readonly { executionId: string; kind: string; detached: boolean }[],
): {
  readonly parent: string
  readonly count: number
  readonly children: readonly { executionId: string; kind: string; detached: boolean }[]
} {
  return Object.freeze({
    parent: parentExecutionId,
    count: children.length,
    children: Object.freeze(children.map((c) => Object.freeze({ ...c }))),
  })
}
