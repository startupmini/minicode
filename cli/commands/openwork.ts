// P14.4 — portofolio open-work lintas sesi (CLI read-only) + P14.3 merge
// eksplisit. Satu subcommand, lima aksi:
//
//   minicode openwork [--session <id>] [--status <S>] [--state <S>]
//                     [--priority <P0..P3>] [--min-age-days <n>] [--blocked]
//                     [--depends-on <taskId>] [--stale-days <n>] [--closed]
//                     [--json]
//   minicode openwork inventory [--json]
//   minicode openwork context --session <id> --task <taskId> [--json]
//   minicode openwork export --out <path> [--format json|md] [--force] [filters...]
//   minicode openwork merge --session <id> --keep <taskId> --drop <taskId>
//                           --evidence "<alasan>"
//
// Kontrak output (TERMINAL_CONTRACT I2/I28):
//   - human  → stdout, dikumpulkan lalu ditulis SEKALI (OAP-008) lewat
//     printLines/emitJson — dua sink bersama untuk SEMUA aksi.
//   - --json → SATU objek JSON di stdout, tanpa apa pun yang lain.
//   - exit 0 sukses (termasuk daftar kosong) · 1 gagal runtime/lookup/refusal
//     kebijakan (termasuk kegagalan tulis ekspor) · 2 salah pakai.
//
// Teks tak-terpercaya (judul task, ringkasan intent, evidence operator, id
// sesi dari DB) tidak pernah dicetak mentah di luar tabel: renderList
// menyani tiap sel, dan baris bebas (ringkasan merge, refusal, ekspor MD)
// lewat sanitizeAnsi eksplisit.
//
// Batas otoritas yang dijaga DI SINI: subcommand ini tidak pernah
// mengeksekusi apa pun. Resume/laju hidup dikerjakan jalur yang sudah ada
// (--adopt-task + /scheduler run + gate continuity P13.3).

import { existsSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { atomicWriteText } from "../../src/lib/atomic-write.ts"
import { readCheckpointInventorySync } from "../../src/session/checkpoint.ts"
import {
  formatAge,
  type OpenWorkEntry,
  type OpenWorkReport,
  projectOpenWork,
} from "../../src/session/open-work.ts"
import {
  nextActionFor,
  type OpenWorkState,
  type WorkPriorityLevel,
} from "../../src/session/open-work-intent.ts"
import { isTaskId, isTaskStatus, type TaskStatus } from "../../src/task/model.ts"
import { TaskStore } from "../../src/task/store.ts"
import { sanitizeAnsi, sanitizeAnsiLine } from "../../src/ui/render/sanitize.ts"
import { c } from "../../src/ui/render/theme.ts"
import { truncateToWidth } from "../../src/ui/render/width.ts"

const OPENWORK_STATES: readonly OpenWorkState[] = [
  "OPEN",
  "PARTIAL",
  "BLOCKED",
  "WAITING_FOR_USER",
  "DELEGATED",
  "FAILED_NEEDS_FOLLOWUP",
  "UNKNOWN",
  "COMPLETED",
  "CANCELLED",
  "DECLINED",
]

const PRIORITY_LEVELS: readonly WorkPriorityLevel[] = ["P0", "P1", "P2", "P3"]

const OPENWORK_HELP = `minicode openwork — cross-session unfinished work (P14, read-only)

  minicode openwork [--session <id>] [--status <S>] [--state <S>] [--priority <P>]
                     [--min-age-days <n>] [--blocked] [--depends-on <taskId>]
                     [--stale-days <n>] [--closed] [--json]
      Portfolio of unfinished work across sessions in THIS workspace, with
      state, priority, blockers, dependencies, next action, and provenance
      (transfer source, plan steps, age). Structured intent from history
      (pending approvals, delegated child sessions, interrupted runs, plan
      steps without a canonical task) is listed separately. Similar titles
      across sessions are flagged UNPROVEN — they are never merged for you.

  minicode openwork inventory [--json]
      P14.0 read-only inventory: sessions, workspace binding, tasks, plan
      artifacts, approvals, runs, checkpoints, sub-agent outcomes, and which
      sessions were excluded (foreign/unbound workspace) with reasons.

  minicode openwork context --session <id> --task <taskId> [--json]
      P14.5 context pack for one task: canonical fields, blockers,
      dependencies, plan evidence, checkpoint availability, freshness, and
      the resume checklist. Read-only — openwork never executes anything;
      permission/WorkMode/continuity are enforced by the resume path.

  minicode openwork export --out <path> [--format json|md] [--force] [filters...]
      P14.4 export: write the portfolio (including inventory) to a file,
      atomically. json = machine envelope; md = sanitized human report.
      Refuses to overwrite an existing file unless --force.

  minicode openwork merge --session <id> --keep <taskId> --drop <taskId> --evidence "<why>"
      Explicitly close <drop> as a CANCELLED duplicate of <keep> (same session).
      The duplicate is CANCELLED, never COMPLETED. Your evidence text is kept
      in an append-only audit ledger. Cross-session duplicates must be adopted
      first (--adopt-task), then merged within one session.`

// ── dua sink bersama (OAP-008): SEMUA keluaran aksi lewat sini ──────────────

/** Mesin: SATU objek JSON di stdout, tanpa baris lain (kontrak I2). */
function emitJson(value: unknown): void {
  console.log(JSON.stringify(value))
}

/** Manusia: baris dikumpulkan, ditulis SEKALI. */
function printLines(lines: readonly string[]): void {
  console.log(lines.join("\n"))
}

function usageError(message: string): never {
  console.error(`${message}\n\n${OPENWORK_HELP}`)
  process.exit(2)
}

/**
 * Kegagalan runtime/lookup/refusal kebijakan (exit 1, I28) — SATU writer
 * stderr untuk semua jalur gagal manusia (OAP-008). Pesan sudah disani
 * pemanggilnya bila membawa teks operator.
 */
function exit1(message: string): never {
  console.error(message)
  process.exit(1)
}

function line(value: string, width: number): string {
  return truncateToWidth(sanitizeAnsiLine(value), width, "…")
}

function flagsOf(e: OpenWorkEntry): string {
  const flags: string[] = []
  if (e.stale) flags.push("STALE")
  if (e.provenance === "SESSION_MISSING") flags.push("PROVENANCE-UNKNOWN")
  if (e.transferredFromSessionId !== null) {
    flags.push(`FROM:${e.transferredFromSessionId}`)
  }
  if (e.similarCount > 1) flags.push(`SIMILAR×${e.similarCount}(UNPROVEN)`)
  if (e.duplicate !== null && e.duplicate.sessions.length > 1) {
    flags.push(`DUP-GROUP×${e.duplicate.count}(UNPROVEN)`)
  }
  return flags.join(" · ")
}

interface ListFilters {
  readonly sessionId?: string
  readonly status?: TaskStatus
  readonly state?: OpenWorkState
  readonly priority?: WorkPriorityLevel
  readonly minAgeDays?: number
  readonly blockedOnly?: boolean
  readonly dependsOn?: string
  readonly includeClosed: boolean
  readonly staleMs?: number
}

function parseListFilters(getArg: (name: string) => string | undefined): ListFilters {
  const sessionId = getArg("--session")
  const statusRaw = getArg("--status")
  let status: TaskStatus | undefined
  if (statusRaw !== undefined) {
    if (!isTaskStatus(statusRaw)) {
      usageError(
        `invalid --status value: "${statusRaw}" (expected one of PENDING|IN_PROGRESS|VERIFYING|BLOCKED|FAILED|RETRYING|COMPLETED|CANCELLED)`,
      )
    }
    status = statusRaw
  }
  const stateRaw = getArg("--state")
  let state: OpenWorkState | undefined
  if (stateRaw !== undefined) {
    if (!OPENWORK_STATES.includes(stateRaw as OpenWorkState)) {
      usageError(
        `invalid --state value: "${stateRaw}" (expected one of ${OPENWORK_STATES.join("|")})`,
      )
    }
    state = stateRaw as OpenWorkState
  }
  const priorityRaw = getArg("--priority")
  let priority: WorkPriorityLevel | undefined
  if (priorityRaw !== undefined) {
    if (!PRIORITY_LEVELS.includes(priorityRaw as WorkPriorityLevel)) {
      usageError(`invalid --priority value: "${priorityRaw}" (expected one of P0|P1|P2|P3)`)
    }
    priority = priorityRaw as WorkPriorityLevel
  }
  const minAgeRaw = getArg("--min-age-days")
  let minAgeDays: number | undefined
  if (minAgeRaw !== undefined) {
    const n = Number(minAgeRaw)
    if (!Number.isFinite(n) || n < 0) {
      usageError(`invalid --min-age-days value: "${minAgeRaw}" (expected a non-negative number)`)
    }
    minAgeDays = n
  }
  const dependsOn = getArg("--depends-on")
  if (dependsOn !== undefined && !isTaskId(dependsOn)) {
    usageError(`invalid --depends-on value: "${dependsOn}" (expected canonical id like t1)`)
  }
  const staleDaysRaw = getArg("--stale-days")
  let staleMs: number | undefined
  if (staleDaysRaw !== undefined) {
    const n = Number(staleDaysRaw)
    if (!Number.isFinite(n) || n < 0) {
      usageError(`invalid --stale-days value: "${staleDaysRaw}" (expected a non-negative number)`)
    }
    staleMs = n * 24 * 60 * 60 * 1000
  }
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(minAgeDays !== undefined ? { minAgeDays } : {}),
    ...(getArg("--blocked") !== undefined || process.argv.includes("--blocked")
      ? { blockedOnly: true }
      : {}),
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    includeClosed: getArg("--closed") !== undefined || process.argv.includes("--closed"),
    ...(staleMs !== undefined ? { staleMs } : {}),
  }
}

function ageOfClosed(closedAt: string | null, now: number): string {
  if (closedAt === null) return "-"
  const t = Date.parse(closedAt)
  if (!Number.isFinite(t)) return "-"
  return formatAge(Math.max(0, now - t))
}

function renderListHuman(report: OpenWorkReport, filters: ListFilters, cwd: string): string[] {
  const lines: string[] = []
  const scope = filters.sessionId === undefined ? "" : ` · session=${filters.sessionId}`
  const similarNote =
    report.counts.similarGroups > 0
      ? ` · ${report.counts.similarGroups} similar group(s) UNPROVEN`
      : ""
  const conflictNote = report.counts.conflicts > 0 ? ` · ${report.counts.conflicts} DIVERGENT` : ""
  lines.push(
    c.bold(
      `Open Work — ${report.counts.open} item(s) · ${report.counts.intent} intent · ${report.counts.stale} stale · ${report.counts.unknownProvenance} unknown-provenance${similarNote}${conflictNote}${scope}`,
    ),
  )
  lines.push(
    c.dim(
      `workspace: ${resolvePath(cwd)} · stale after ${formatAge(report.staleMs)} · TaskStore remains the sole status authority`,
    ),
  )
  if (report.open.length === 0 && report.intent.length === 0) {
    lines.push(c.dim("(no unfinished work in this workspace)"))
  }
  for (const e of report.open) {
    lines.push("")
    lines.push(
      `${c.cyan(line(e.sessionId, 60))}/${line(e.taskId, 12)} · ${line(e.status, 12)} · ${line(e.state, 20)} · ${e.priority.level} · ${formatAge(e.ageMs)} old`,
    )
    lines.push(`  ${c.dim("title:")} ${line(e.title, 60)}`)
    const flags = flagsOf(e)
    lines.push(`  ${c.dim("flags:")} ${line(flags.length > 0 ? flags : "none", 90)}`)
    if (e.blockers.length > 0) {
      lines.push(
        `  ${c.dim("blockers:")} ${line(e.blockers.map((b) => `${b.kind}: ${b.detail}`).join(" · "), 90)}`,
      )
    }
    if (e.dependencies.length > 0) {
      lines.push(
        `  ${c.dim("depends on:")} ${line(e.dependencies.map((d) => `${d.taskId} (${d.status}${d.satisfied ? "" : ", unsatisfied"})`).join(" · "), 90)}`,
      )
    }
    if (e.verification !== null) {
      lines.push(
        `  ${c.dim("verification:")} ${line(`${e.verification.verdict} @ ${e.verification.checkedAt}`, 80)}`,
      )
    }
    if (e.planSteps.length > 0) {
      lines.push(
        `  ${c.dim("plan evidence:")} ${line(e.planSteps.map((p) => `${p.stepId}=${p.claimedStatus}@turn${p.turnId}`).join(" · "), 90)}`,
      )
    }
    lines.push(`  ${c.dim("next:")} ${line(e.nextAction, 90)}`)
  }
  for (const ic of report.intent) {
    lines.push("")
    lines.push(
      `${c.magenta(line(`INTENT·${ic.source}`, 24))} · ${line(ic.state, 20)} · ${formatAge(Math.max(0, Date.parse(report.generatedAtIso) - Date.parse(ic.observedAtIso)))} old`,
    )
    lines.push(`  ${c.dim("summary:")} ${line(ic.summary, 70)}`)
    lines.push(`  ${c.dim("session:")} ${line(ic.sessionId, 60)}`)
    const prov = ic.provenance
    const provBits = [
      prov.eventSeq !== null ? `event=${prov.eventSeq}` : null,
      prov.turnId !== null ? `turn=${prov.turnId}` : null,
      prov.planId !== null ? `plan=${prov.planId}` : null,
      prov.stepId !== null ? `step=${prov.stepId}` : null,
      prov.approvalId !== null ? `approval=${prov.approvalId}` : null,
      prov.childSessionId !== null ? `child=${prov.childSessionId}` : null,
      prov.runId !== null ? `run=${prov.runId}` : null,
      prov.taskId !== null ? `task=${prov.taskId}` : null,
    ].filter((s): s is string => s !== null)
    lines.push(`  ${c.dim("provenance:")} ${line(provBits.join(" · "), 90)}`)
    lines.push(`  ${c.dim("reason:")} ${line(ic.reason, 90)}`)
    lines.push(`  ${c.dim("next:")} ${line(nextActionFor(ic.state), 90)}`)
  }
  if (report.duplicateGroups.length > 0) {
    lines.push("")
    lines.push(
      c.bold(`Similar groups — ${report.duplicateGroups.length} (UNPROVEN, never auto-merged)`),
    )
    for (const g of report.duplicateGroups) {
      const divergence = g.divergentStates ? c.yellow(" · DIVERGENT states") : ""
      lines.push(
        `  ${line(`"${g.key}" ×${g.count} across ${g.sessions.length} session(s)`, 70)}${divergence}`,
      )
      lines.push(`  ${c.dim("sessions:")} ${line(g.sessions.join(" · "), 90)}`)
    }
  }
  if (filters.includeClosed) {
    lines.push("")
    if (report.closed.length === 0) {
      lines.push(c.dim("Closure feedback: no P14-provenanced work is closed yet."))
    } else {
      lines.push(
        c.bold(`Closure feedback — ${report.counts.closed} closed item(s) with P14 provenance`),
      )
      const nowMs = Date.parse(report.generatedAtIso)
      for (const e of report.closed) {
        const age = ageOfClosed(e.closedAt, nowMs)
        const taskId = e.taskId === null ? "(no task)" : e.taskId
        const origin =
          e.kind === "TRANSFERRED"
            ? ` · FROM ${line(e.transferredFromSessionId ?? "?", 60)}`
            : e.kind === "MERGED_DUPLICATE"
              ? ` · duplicate-of ${line(e.mergeSurvivorId ?? "?", 12)}`
              : ` · intent ${line(e.intentState ?? "?", 20)}`
        const shownStatus = e.status ?? e.intentState ?? "?"
        lines.push("")
        lines.push(
          `${c.cyan(line(e.sessionId, 60))}/${line(taskId, 12)} · ${line(String(shownStatus), 12)} · closed ${age} ago · claim ${line(e.claim, 12)}${origin}`,
        )
        if (e.title !== null) lines.push(`  ${c.dim("title:")} ${line(e.title, 60)}`)
        if (e.kind === "MERGED_DUPLICATE" && e.mergeEvidence !== null) {
          lines.push(`  ${c.dim("evidence:")} ${line(e.mergeEvidence, 70)}`)
        }
        lines.push(`  ${c.dim("reason:")} ${line(e.reason, 90)}`)
      }
    }
  }
  lines.push("")
  lines.push(
    c.dim(
      "Continue explicitly: minicode --session <target> --adopt-task <source>/<task> — the scheduler is never started by adoption.",
    ),
  )
  return lines
}

function applyListFilters(report: OpenWorkReport, filters: ListFilters): OpenWorkReport {
  const hasFilter =
    filters.status !== undefined ||
    filters.state !== undefined ||
    filters.priority !== undefined ||
    filters.minAgeDays !== undefined ||
    filters.blockedOnly === true ||
    filters.dependsOn !== undefined
  if (!hasFilter) return report

  const minAgeMs = filters.minAgeDays !== undefined ? filters.minAgeDays * 24 * 60 * 60 * 1000 : 0
  const open = report.open.filter((e) => {
    if (filters.status !== undefined && e.status !== filters.status) return false
    if (filters.state !== undefined && e.state !== filters.state) return false
    if (filters.priority !== undefined && e.priority.level !== filters.priority) return false
    if (filters.minAgeDays !== undefined && e.ageMs < minAgeMs) return false
    if (filters.blockedOnly === true && e.blockers.length === 0) return false
    if (
      filters.dependsOn !== undefined &&
      !e.dependencies.some((d) => d.taskId === filters.dependsOn)
    ) {
      return false
    }
    return true
  })
  const intent =
    filters.state === undefined
      ? report.intent
      : report.intent.filter((ic) => ic.state === filters.state)
  return {
    ...report,
    open,
    intent,
    counts: {
      ...report.counts,
      open: open.length,
      intent: intent.length,
      stale: open.filter((e) => e.stale).length,
      unknownProvenance: open.filter((e) => e.provenance === "SESSION_MISSING").length,
    },
  }
}

function projectionOptions(filters: ListFilters, includeInventory: boolean) {
  return {
    ...(filters.staleMs !== undefined ? { staleMs: filters.staleMs } : {}),
    ...(filters.sessionId !== undefined ? { sessionId: filters.sessionId } : {}),
    includeClosed: filters.includeClosed,
    includeIntent: true,
    includeInventory,
  }
}

function handleList(getArg: (name: string) => string | undefined): never {
  const cwd = getArg("--cwd") ?? process.cwd()
  const asJson = getArg("--json") !== undefined || process.argv.includes("--json")
  const filters = parseListFilters(getArg)

  const report = projectOpenWork({ cwd, ...projectionOptions(filters, false) })
  const filtered = applyListFilters(report, filters)

  if (asJson) {
    emitJson(filtered)
    process.exit(0)
  }
  printLines(renderListHuman(filtered, filters, cwd))
  process.exit(0)
}

function handleMerge(getArg: (name: string) => string | undefined): never {
  const cwd = getArg("--cwd") ?? process.cwd()
  const asJson = getArg("--json") !== undefined || process.argv.includes("--json")
  const sessionId = getArg("--session")
  const keep = getArg("--keep")
  const drop = getArg("--drop")
  const evidence = getArg("--evidence")

  if (
    sessionId === undefined ||
    keep === undefined ||
    drop === undefined ||
    evidence === undefined
  ) {
    usageError(
      'openwork merge requires --session <id> --keep <taskId> --drop <taskId> --evidence "<why>"',
    )
  }
  if (evidence.trim().length === 0) {
    usageError("openwork merge requires non-empty --evidence — similar wording is not proof")
  }

  const store = new TaskStore(cwd)
  const survivor = store.getTask(sessionId, keep)
  if (survivor === null) {
    exit1(`task "${keep}" not found in session "${sessionId}"`)
  }
  const duplicate = store.getTask(sessionId, drop)
  if (duplicate === null) {
    exit1(`task "${drop}" not found in session "${sessionId}"`)
  }

  const result = store.declareTaskDuplicate({
    sessionId,
    survivorId: keep,
    duplicateId: drop,
    evidence,
    // Revisi dibaca BARU-BARU INI: menangkap stale berurutan, semantik yang
    // sama dengan patchTask (bukan CAS — itu kontrak substrat yang ada).
    expectedRevision: duplicate.revision,
  })

  if (result.outcome !== "DECLARED") {
    if (asJson) {
      emitJson(result)
      process.exit(1)
    }
    exit1(sanitizeAnsi(`[openwork] merge refused: ${result.outcome} — ${result.detail}`))
  }

  if (asJson) {
    emitJson(result)
    process.exit(0)
  }
  // Baris bebas: evidence adalah teks operator — disani eksplisit. Kedua
  // baris dikumpulkan jadi SATU panggilan tulis (OAP-008).
  printLines([
    sanitizeAnsi(
      `[openwork] closed ${drop} as duplicate of ${keep} (CANCELLED, not COMPLETED) — evidence: ${evidence}`,
    ),
    c.dim(
      `audit ledger: ${result.merge?.mergeId ?? "?"} · duplicate revision ${result.duplicate?.revision ?? "?"} · reversal is an ordinary lifecycle write (ledger keeps the declaration)`,
    ),
  ])
  process.exit(0)
}

function renderInventoryHuman(report: OpenWorkReport, cwd: string): string[] {
  const inv = report.inventory
  const lines: string[] = []
  if (inv === null) {
    lines.push(c.dim("(inventory not computed)"))
    return lines
  }
  lines.push(c.bold(`Open Work Inventory — workspace ${resolvePath(cwd)}`))
  lines.push(c.dim("TaskStore remains the sole status authority; this is a read-only audit."))
  lines.push("")
  lines.push(
    `sessions: ${inv.sessions.total} total · ${inv.sessions.inScope} in-scope · ${inv.sessions.foreignWorkspace} foreign-workspace · ${inv.sessions.unboundWorkspace} unbound · ${inv.sessions.childSessions} child`,
  )
  lines.push(
    `tasks: ${inv.tasks.total} total · ${inv.tasks.open} open · ${inv.tasks.terminal} terminal`,
  )
  lines.push(
    `presentation events: ${inv.presentationEvents.total} (plan.updated ${inv.plans.events} · approval.requested ${inv.approvals.requested} · approval.settled ${inv.approvals.settled})`,
  )
  lines.push(
    `runs: ${inv.runs.total} total · ${inv.runs.active} active · ${inv.runs.interrupted} interrupted · ${inv.runs.terminal} terminal`,
  )
  lines.push(
    `checkpoints: ${inv.checkpoints.sessionsWithManifest} session(s) with manifest · ${inv.checkpoints.entries} entries · ${inv.checkpoints.corrupt} corrupt`,
  )
  lines.push(
    `plans: ${inv.plans.events} event(s) · ${inv.plans.openSteps} open step(s) · ${inv.plans.closedSteps} closed step(s)`,
  )
  lines.push(
    `approvals: ${inv.approvals.requested} requested · ${inv.approvals.settled} settled · ${inv.approvals.pending} pending`,
  )
  lines.push(
    `sub-agents: ${inv.subAgents.childSessions} child session(s) · ${inv.subAgents.resultsProduced} with result · ${inv.subAgents.failedTurns} with failed turn`,
  )
  if (inv.excludedSessions.length === 0) {
    lines.push(c.dim("excluded sessions: none"))
  } else {
    lines.push(`excluded sessions: ${inv.excludedSessions.length}`)
    for (const x of inv.excludedSessions.slice(0, 20)) {
      lines.push(`  ${line(x.sessionId, 60)} · ${x.reason}`)
    }
    if (inv.excludedSessions.length > 20) {
      lines.push(c.dim(`  … and ${inv.excludedSessions.length - 20} more`))
    }
  }
  if (report.rejectedEvents > 0) {
    lines.push(
      c.yellow(
        `unreadable events: ${report.rejectedEvents} (decode rejected — evidence not hidden)`,
      ),
    )
  }
  return lines
}

function handleInventory(getArg: (name: string) => string | undefined): never {
  const cwd = getArg("--cwd") ?? process.cwd()
  const asJson = getArg("--json") !== undefined || process.argv.includes("--json")
  const report = projectOpenWork({
    cwd,
    includeClosed: false,
    includeIntent: true,
    includeInventory: true,
  })
  if (asJson) {
    emitJson({
      generatedAtIso: report.generatedAtIso,
      staleMs: report.staleMs,
      counts: report.counts,
      inventory: report.inventory,
      duplicateGroups: report.duplicateGroups,
      rejectedEvents: report.rejectedEvents,
    })
    process.exit(0)
  }
  printLines(renderInventoryHuman(report, cwd))
  process.exit(0)
}

interface ContextPack {
  readonly generatedAtIso: string
  readonly workspace: string
  readonly task: Record<string, unknown>
  readonly portfolio: Record<string, unknown> | null
  readonly closed: Record<string, unknown> | null
  readonly checkpoint: Record<string, unknown>
  readonly declaredDuplicateOf: string | null
  readonly rejectedEvents: number
  readonly resume: Record<string, unknown>
}

function buildContextPack(cwd: string, sessionId: string, taskId: string): ContextPack | null {
  const store = new TaskStore(cwd)
  const task = store.getTask(sessionId, taskId)
  if (task === null) return null
  const report = projectOpenWork({
    cwd,
    ...(sessionId !== undefined ? { sessionId } : {}),
    includeClosed: true,
    includeIntent: true,
    includeInventory: false,
  })
  const entry = report.open.find((e) => e.taskId === taskId) ?? null
  const closed = report.closed.find((e) => e.taskId === taskId) ?? null
  const cp = readCheckpointInventorySync(sessionId, cwd)
  const merges = store.listTaskMerges({ sessionId, duplicateId: taskId })
  return {
    generatedAtIso: report.generatedAtIso,
    workspace: resolvePath(cwd),
    task: {
      sessionId,
      taskId,
      title: task.title,
      status: task.status,
      revision: task.revision,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      blockedReason: task.blockedReason,
      verification: task.verification,
      provenance: task.provenance,
      dependsOn: task.dependsOn,
      evidence: task.evidence.slice(-10),
    },
    portfolio:
      entry === null
        ? null
        : {
            state: entry.state,
            stateReason: entry.stateReason,
            priority: entry.priority,
            blockers: entry.blockers,
            dependencies: entry.dependencies,
            nextAction: entry.nextAction,
            planSteps: entry.planSteps,
            duplicate: entry.duplicate,
            stale: entry.stale,
            ageMs: entry.ageMs,
            transferredFromSessionId: entry.transferredFromSessionId,
          },
    closed:
      closed === null
        ? null
        : {
            kind: closed.kind,
            status: closed.status,
            intentState: closed.intentState,
            claim: closed.claim,
            reason: closed.reason,
            closedAt: closed.closedAt,
          },
    checkpoint: {
      exists: cp.exists,
      corrupt: cp.corrupt,
      count: cp.checkpointCount,
      latestTurn: cp.latestTurn,
      latestTimestamp: cp.latestTimestamp,
    },
    declaredDuplicateOf: merges.length > 0 ? (merges[merges.length - 1]?.survivorId ?? null) : null,
    rejectedEvents: report.rejectedEvents,
    resume: {
      autoExecute: false,
      enforcedBy: [
        "P12 permission/WorkMode ceiling at session start",
        "P13.3 continuity gate before any claim",
        "TaskStore claimTask generation fencing",
        "P12/P13 budgets and cancellation",
      ],
      operatorFlow: "adopt (--adopt-task), then /scheduler run",
      note: "openwork never executes; authority/freshness are enforced by the resume path, not projected here",
    },
  }
}

function renderContextHuman(pack: ContextPack): string[] {
  const lines: string[] = []
  const t = pack.task as {
    title: string
    status: string
    revision: number
    updatedAt: string
    blockedReason: string | null
    verification: { verdict: string; checkedAt: string } | null
    dependsOn: string[]
  }
  lines.push(c.bold(`Open Work Context — ${pack.workspace}`))
  lines.push("")
  lines.push(`task: ${line(String(t.title), 70)}`)
  lines.push(`status: ${t.status} · revision ${t.revision} · updated ${t.updatedAt}`)
  if (t.blockedReason !== null) lines.push(`blocked reason: ${line(t.blockedReason, 90)}`)
  if (t.verification !== null) {
    lines.push(`verification: ${t.verification.verdict} @ ${t.verification.checkedAt}`)
  }
  if (t.dependsOn.length > 0) lines.push(`depends on: ${t.dependsOn.join(" · ")}`)
  const portfolio = pack.portfolio as {
    state: string
    priority: { level: string }
    nextAction: string
    blockers: unknown[]
  } | null
  if (portfolio !== null) {
    lines.push(`state: ${portfolio.state} · priority ${portfolio.priority.level}`)
    lines.push(`next: ${line(portfolio.nextAction, 90)}`)
    lines.push(`blockers: ${portfolio.blockers.length}`)
  } else {
    lines.push(c.dim("state: not open in the portfolio (terminal or out of scope)"))
  }
  const cp = pack.checkpoint as {
    exists: boolean
    corrupt: boolean
    count: number
    latestTurn: number | null
  }
  lines.push(
    `checkpoint: ${cp.exists ? `${cp.count} entr(ies)${cp.corrupt ? " · CORRUPT" : ""}${cp.latestTurn !== null ? ` · latest turn ${cp.latestTurn}` : ""}` : "none"}`,
  )
  if (pack.declaredDuplicateOf !== null) {
    lines.push(`declared duplicate of: ${pack.declaredDuplicateOf} (audit ledger)`)
  }
  lines.push("")
  lines.push(c.dim(String((pack.resume as { note: string }).note)))
  lines.push(
    c.dim(
      "Resume explicitly: minicode --session <target> --adopt-task <source>/<task>, then /scheduler run.",
    ),
  )
  return lines
}

function handleContext(getArg: (name: string) => string | undefined): never {
  const cwd = getArg("--cwd") ?? process.cwd()
  const asJson = getArg("--json") !== undefined || process.argv.includes("--json")
  const sessionId = getArg("--session")
  const taskId = getArg("--task")
  if (sessionId === undefined || taskId === undefined) {
    usageError("openwork context requires --session <id> --task <taskId>")
  }
  if (!isTaskId(taskId)) {
    usageError(`invalid --task value: "${taskId}" (expected canonical id like t1)`)
  }
  const pack = buildContextPack(cwd, sessionId, taskId)
  if (pack === null) {
    exit1(`task "${taskId}" not found in session "${sessionId}"`)
  }
  if (asJson) {
    emitJson(pack)
    process.exit(0)
  }
  printLines(renderContextHuman(pack))
  process.exit(0)
}

/** MD dieksport ke file = permukaan baca manusia: teks tak-terpercaya disani. */
function mdCell(value: string): string {
  const safe = sanitizeAnsiLine(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
  return safe.length > 120 ? `${safe.slice(0, 119)}…` : safe
}

function renderMarkdownExport(report: OpenWorkReport, cwd: string, filters: ListFilters): string {
  const out: string[] = []
  out.push(`# Open Work — ${mdCell(resolvePath(cwd))}`)
  out.push("")
  out.push(`- generated: ${report.generatedAtIso}`)
  out.push(`- stale after: ${formatAge(report.staleMs)}`)
  out.push(
    `- counts: ${report.counts.open} open · ${report.counts.intent} intent · ${report.counts.stale} stale · ${report.counts.unknownProvenance} unknown-provenance · ${report.counts.closed} closed · ${report.counts.duplicateGroups} duplicate group(s) · ${report.counts.conflicts} divergent`,
  )
  out.push(`- TaskStore remains the sole status authority; this export is a read-only projection.`)
  if (filters.sessionId !== undefined) out.push(`- session filter: ${mdCell(filters.sessionId)}`)
  out.push("")
  out.push("## Open tasks")
  if (report.open.length === 0) {
    out.push("_none_")
  } else {
    for (const e of report.open) {
      out.push("")
      out.push(`### ${e.sessionId}/${e.taskId} — ${mdCell(e.title)}`)
      out.push(
        `- status: ${e.status} · state: ${e.state} · priority: ${e.priority.level} (${e.priority.reason})`,
      )
      out.push(`- age: ${formatAge(e.ageMs)} old${e.stale ? " · STALE" : ""}`)
      out.push(
        `- provenance: ${e.provenance}${e.transferredFromSessionId !== null ? ` · FROM ${e.transferredFromSessionId}` : ""}`,
      )
      if (e.blockers.length > 0) {
        for (const b of e.blockers) out.push(`- blocker (${b.kind}): ${mdCell(b.detail)}`)
      }
      for (const d of e.dependencies) {
        out.push(
          `- depends on: ${d.taskId} (${d.status}${d.satisfied ? ", satisfied" : ", UNSATISFIED"})`,
        )
      }
      if (e.verification !== null) {
        out.push(`- verification: ${e.verification.verdict} @ ${e.verification.checkedAt}`)
      }
      for (const p of e.planSteps) {
        out.push(
          `- plan evidence: step ${p.stepId} claims "${p.claimedStatus}" (turn ${p.turnId}, event ${p.eventSeq})`,
        )
      }
      if (e.duplicate !== null) {
        out.push(
          `- duplicate group (UNPROVEN): "${mdCell(e.duplicate.key)}" ×${e.duplicate.count} across ${e.duplicate.sessions.length} session(s)${e.duplicate.divergentStates ? " · DIVERGENT STATES" : ""}`,
        )
      }
      out.push(`- next: ${mdCell(e.nextAction)}`)
    }
  }
  out.push("")
  out.push("## Structured intent (from history, read-only)")
  if (report.intent.length === 0) {
    out.push("_none_")
  } else {
    for (const ic of report.intent) {
      out.push(`- [${ic.source}] ${ic.sessionId} · ${ic.state} — ${mdCell(ic.summary)}`)
      out.push(
        `  - reason: ${mdCell(ic.reason)} · provenance: event ${ic.provenance.eventSeq ?? "-"} turn ${ic.provenance.turnId ?? "-"}`,
      )
      out.push(`  - next: ${mdCell(nextActionFor(ic.state))}`)
    }
  }
  out.push("")
  out.push("## Duplicate groups (UNPROVEN — never auto-merged)")
  if (report.duplicateGroups.length === 0) {
    out.push("_none_")
  } else {
    for (const g of report.duplicateGroups) {
      out.push(
        `- "${mdCell(g.key)}" ×${g.count} · sessions: ${g.sessions.map((s) => mdCell(s)).join(", ")}${g.divergentStates ? " · DIVERGENT STATES" : ""}`,
      )
    }
  }
  if (report.closed.length > 0) {
    out.push("")
    out.push("## Closure feedback (P14 provenance)")
    for (const e of report.closed) {
      const shown = e.status ?? e.intentState ?? "?"
      out.push(
        `- ${e.sessionId}/${e.taskId ?? "(no task)"} — ${shown} · claim ${e.claim}${e.transferredFromSessionId !== null ? ` · FROM ${e.transferredFromSessionId}` : ""}${e.mergeSurvivorId !== null ? ` · duplicate-of ${e.mergeSurvivorId}` : ""}`,
      )
      out.push(`  - ${mdCell(e.reason)}`)
    }
  }
  if (report.inventory !== null) {
    const inv = report.inventory
    out.push("")
    out.push("## Inventory (P14.0)")
    out.push(
      `- sessions: ${inv.sessions.total} total · ${inv.sessions.inScope} in-scope · ${inv.sessions.foreignWorkspace} foreign · ${inv.sessions.unboundWorkspace} unbound · ${inv.sessions.childSessions} child`,
    )
    out.push(
      `- tasks: ${inv.tasks.total} total · ${inv.tasks.open} open · ${inv.tasks.terminal} terminal`,
    )
    out.push(
      `- presentation events: ${inv.presentationEvents.total} (plan ${inv.plans.events} · approvals ${inv.approvals.requested}/${inv.approvals.settled})`,
    )
    out.push(
      `- runs: ${inv.runs.total} total · ${inv.runs.active} active · ${inv.runs.interrupted} interrupted · ${inv.runs.terminal} terminal`,
    )
    out.push(
      `- checkpoints: ${inv.checkpoints.sessionsWithManifest} manifest(s) · ${inv.checkpoints.entries} entries · ${inv.checkpoints.corrupt} corrupt`,
    )
    for (const x of inv.excludedSessions) {
      out.push(`- excluded session: ${mdCell(x.sessionId)} (${x.reason})`)
    }
  }
  if (report.rejectedEvents > 0) {
    out.push("")
    out.push(
      `> ${report.rejectedEvents} presentation event(s) could not be decoded and are reported as unreadable, not hidden.`,
    )
  }
  return out.join("\n")
}

async function handleExport(getArg: (name: string) => string | undefined): Promise<never> {
  const cwd = getArg("--cwd") ?? process.cwd()
  const out = getArg("--out")
  if (out === undefined || out.trim() === "") {
    usageError("openwork export requires --out <path>")
  }
  const format = (getArg("--format") ?? "json").toLowerCase()
  if (format !== "json" && format !== "md") {
    usageError(`invalid --format value: "${getArg("--format")}" (expected json|md)`)
  }
  const force = getArg("--force") !== undefined || process.argv.includes("--force")
  const asJson = getArg("--json") !== undefined || process.argv.includes("--json")
  const filters = parseListFilters(getArg)
  const report = projectOpenWork({ cwd, ...projectionOptions(filters, true) })
  const filtered = applyListFilters(report, filters)
  const content =
    format === "json"
      ? JSON.stringify(filtered, null, 2)
      : renderMarkdownExport(filtered, cwd, filters)
  // `length` = unit UTF-16, bukan byte: judul non-ASCII akan salah lapor.
  const bytes = Buffer.byteLength(content, "utf8")

  if (existsSync(out) && !force) {
    exit1(
      sanitizeAnsi(`[openwork] export refused: "${out}" already exists (use --force to overwrite)`),
    )
  }
  try {
    await atomicWriteText(resolvePath(out), content)
  } catch (e) {
    exit1(sanitizeAnsi(`[openwork] export failed: ${String((e as Error)?.message ?? e)}`))
  }
  if (asJson) {
    emitJson({ exported: resolvePath(out), format, bytes })
    process.exit(0)
  }
  printLines([sanitizeAnsi(`[openwork] exported ${format} → ${resolvePath(out)} (${bytes} bytes)`)])
  process.exit(0)
}

/**
 * Flag subcommand ini yang MEMAKAN nilai — dipakai `actionAfter` agar nilai
 * flag tidak salah dibaca sebagai nama aksi (`openwork --stale-days 1`).
 */
const ACTION_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--cwd",
  "--session",
  "--status",
  "--state",
  "--priority",
  "--min-age-days",
  "--depends-on",
  "--stale-days",
  "--keep",
  "--drop",
  "--evidence",
  "--task",
  "--format",
  "--out",
])

/**
 * Aksi subcommand = token non-flag PERTAMA setelah token "openwork".
 *
 * `minicode --cwd X openwork merge` → args[1] adalah nilai flag, bukan aksi
 * (pola yang sama dengan I34: flag global mendahului subcommand tetap sah).
 * Router menjamin "openwork" adalah token cmd; di sini kita hanya mencari
 * token sesudahnya, melewati flag DAN nilai flag yang memakannya.
 */
function actionAfter(args: string[]): string | undefined {
  const at = args.indexOf("openwork")
  if (at < 0) return undefined
  let i = at + 1
  while (i < args.length) {
    const t = args[i]
    if (t === undefined) {
      i++
      continue
    }
    if (t.startsWith("-")) {
      // `--flag=value` sudah satu token; `--flag value` melompati keduanya.
      if (ACTION_VALUE_FLAGS.has(t) && !t.includes("=")) i++
      i++
      continue
    }
    return t
  }
  return undefined
}

export async function handleOpenwork(
  args: string[],
  getArg: (name: string) => string | undefined,
): Promise<never> {
  // `--help`/`-h` adalah flag, jadi `actionAfter` (yang hanya mengembalikan
  // token non-flag) tidak akan pernah melihatnya. Tanpa cek eksplisit ini,
  // `minicode openwork --help` diam-diam menjalankan aksi list — kontrak
  // help/exit 0 dilanggar dan teks bantuan tak pernah terbaca.
  if (args.includes("--help") || args.includes("-h")) {
    printLines([OPENWORK_HELP])
    process.exit(0)
  }
  const sub = actionAfter(args)
  if (sub === "merge") {
    handleMerge(getArg)
  }
  if (sub === "inventory") {
    handleInventory(getArg)
  }
  if (sub === "context") {
    handleContext(getArg)
  }
  if (sub === "export") {
    await handleExport(getArg)
  }
  if (sub !== undefined) {
    usageError(`unknown openwork action: ${sub}`)
  }
  handleList(getArg)
}
