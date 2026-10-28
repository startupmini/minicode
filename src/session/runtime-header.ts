// [Fase 4 / LOOP-13, LOOP-INV-16, LOOP-G18] Runtime State Header — Dual-Buffer
// Operational Context yang Survives Compaction.
//
// Header deterministik yang disuntikkan langsung dari sumber durable
// (TaskStore, persistence, pending tools, usage) pada saat perakitan konteks,
// sehingga fakta operasional kritis tidak hilang akibat kompaksi riwayat percakapan.
//
// Batas keras modul ini:
//   - MURNI: hanya rendering string dari state terstruktur.
//   - Tidak ada I/O, tidak ada write, tidak ada mutation.
//   - Format stabil (tidak bergantung pada model eksternal).

import type { Usage as UsageSession } from "../policy/usage.ts"
import { TaskStore } from "../task/store.ts"

/** State operasonal minimal yang diperlukan untuk rendering header. */
export interface OperationalStateSnapshot {
  readonly runId?: string
  readonly turnCount: number
  readonly maxTurns?: number | null
  readonly budgetRemainingUsd?: number | null
  readonly pendingToolIds?: readonly string[]
  readonly unknownOutcomeTools?: readonly string[] // tool call yang timeout = UNKNOWN
  readonly pendingApprovals?: readonly { id: string; action?: string }[]
  readonly inProgressTasks?: number
  readonly verifyingTasks?: number
  readonly blockedTasks?: number
  readonly completedVerifiedTasks?: number
  readonly activeTasks?: readonly {
    readonly id: string
    readonly status: string
    readonly verificationVerdict?: "passed" | "failed" | "stale"
  }[]
}

/**
 * Render header operasional deterministik yang aman masuk ke prompt.
 * Format dibungkus tag tegas agar model memperlakukan sebagai metadata
 * operasional, bukan instruksi user biasa.
 */
export function buildRuntimeStateHeader(state: OperationalStateSnapshot): string {
  const lines: string[] = []
  lines.push("[RUNTIME_STATE_HEADER — AUTHORITATIVE_OPERATIONAL_STATE]")

  // Baris satu: identitas run & progress turn + budget
  const runIdStr = state.runId ? `${state.runId}` : "-"
  const maxTurnsStr =
    state.maxTurns === undefined || state.maxTurns === null
      ? `${state.turnCount}/unbounded`
      : `${state.turnCount}/${state.maxTurns}`
  const budgetStr =
    state.budgetRemainingUsd === undefined || state.budgetRemainingUsd === null
      ? "?"
      : `$${state.budgetRemainingUsd.toFixed(6)}`
  lines.push(`run_id: ${runIdStr} | turn: ${maxTurnsStr} | budget_remaining_usd: ${budgetStr}`)

  // Baris dua: tool tracking + approval pending
  const pendingList =
    state.pendingToolIds && state.pendingToolIds.length > 0
      ? `[${state.pendingToolIds.join(",")}]`
      : "[]"
  const unknownList =
    state.unknownOutcomeTools && state.unknownOutcomeTools.length > 0
      ? `[${state.unknownOutcomeTools.join(",")}]`
      : "[]"
  const approvalsList =
    state.pendingApprovals && state.pendingApprovals.length > 0
      ? `[${state.pendingApprovals.map((a) => a.id).join(",")}]`
      : "[]"
  lines.push(
    `pending_tool_ids: ${pendingList} | unknown_outcome_tools: ${unknownList} | pending_approvals: ${approvalsList}`,
  )

  // Baris tiga: ringkasan task counter
  const counters: string[] = []
  if (typeof state.inProgressTasks === "number")
    counters.push(`in_progress=${state.inProgressTasks}`)
  if (typeof state.verifyingTasks === "number") counters.push(`verifying=${state.verifyingTasks}`)
  if (typeof state.blockedTasks === "number") counters.push(`blocked=${state.blockedTasks}`)
  if (typeof state.completedVerifiedTasks === "number")
    counters.push(`completed_verified=${state.completedVerifiedTasks}`)
  const summary = counters.length > 0 ? counters.join(" ") : "none"
  lines.push(`tasks_summary: ${summary}`)

  // Baris empat: daftar aktif singkat (task_id + status + verdict bila ada)
  if (state.activeTasks && state.activeTasks.length > 0) {
    const activeLines = state.activeTasks.map((t) => {
      const v = t.verificationVerdict ? ` [verdict:${t.verificationVerdict}]` : ""
      return `  - ${t.id}: ${t.status}${v}`
    })
    lines.push(`active_tasks: ${activeLines.join("; ")}`)
  }

  lines.push("[END_RUNTIME_STATE_HEADER]")
  return lines.join("\n")
}

/**
 * Wrap context assembly dengan injection header jika state tersedia.
 * Fungsi helper untuk diintegrasikan ke `assembleContext` atau pemanggil lain.
 */
export function injectRuntimeHeaderIntoContent(
  content: string,
  state: OperationalStateSnapshot | null,
): string {
  if (!state) return content
  const header = buildRuntimeStateHeader(state)
  return `${header}\n\n${content}`
}

/** Build snapshot dari sumber-sumber operasional yang ada di CLI. */
export function collectOperationalState(
  sessionId: string,
  cwd: string,
  usage: { getSession(): UsageSession; getTurnCount(): number },
  maxTurns?: number | null,
): OperationalStateSnapshot | null {
  try {
    const store = new TaskStore(cwd)
    const tasks = store.listTasks(sessionId)

    const inProgressTasks = tasks.filter((t) => t.status === "IN_PROGRESS").length
    const verifyingTasks = tasks.filter((t) => t.status === "VERIFYING").length
    const blockedTasks = tasks.filter((t) => t.status === "BLOCKED").length
    const completedVerifiedTasks = tasks.filter((t) => {
      if (t.status !== "COMPLETED") return false
      return t.evidence?.some(
        (e) => e.kind === "verify" && JSON.parse(e.detail).verdict === "passed",
      )
    }).length

    const activeTasks = tasks
      .filter((t) => ["IN_PROGRESS", "VERIFYING", "BLOCKED", "PENDING"].includes(t.status))
      .slice(0, 16) // Limit tampilan ke 16 task aktif saja
      .map((t) => ({
        id: t.id,
        status: t.status,
        verificationVerdict: t.evidence?.find((e) => e.kind === "verify")
          ? JSON.parse(t.evidence[t.evidence.length - 1]!.detail).verdict
          : undefined,
      }))

    return {
      runId: undefined, // DIISI oleh caller dari session state
      turnCount: usage.getTurnCount(),
      maxTurns: maxTurns,
      budgetRemainingUsd: (() => {
        const c = usage.getSession().cost
        return typeof maxTurns === "number" || typeof c !== "number"
          ? undefined
          : Math.max(0, 1 - c)
      })(),
      pendingToolIds: undefined, // DIISI oleh caller dari pending-tools state
      unknownOutcomeTools: undefined, // DIISI oleh caller dari journal state
      pendingApprovals: undefined, // DIISI oleh caller dari presentation_events
      inProgressTasks,
      verifyingTasks,
      blockedTasks,
      completedVerifiedTasks,
      activeTasks: activeTasks.length > 0 ? activeTasks : undefined,
    }
  } catch {
    return null
  }
}
