// P14.1/P14.2 — kontrak intent terstruktur + ekstraksi histori berprovenance.
//
// BATAS KERAS modul ini:
//
//   1. READ-ONLY. Tidak ada INSERT/UPDATE/DELETE, tidak ada lease, tidak ada
//      scheduler. Ia membaca artefak durable yang SUDAH ada.
//   2. Intent HANYA berasal dari artefak terstruktur. Pesan bebas pengguna
//      (`user.message`) TIDAK PERNAH dipindai untuk "janji" atau "komitmen".
//      Roadmap P14 melarang menganggap brainstorming sebagai tugas; menebak
//      komitmen dari prosa adalah pelanggaran batas itu, bukan fitur.
//   3. Kategori yang tidak bisa dibuktikan = UNKNOWN. Tidak ada kategori yang
//      ditebak dari judul, kata kunci, atau kemiripan teks.
//
// Sumber intent yang diakui (semuanya eksplisit, semuanya durable):
//
//   plan.updated      langkah rencana yang masih pending/active/blocked
//   approval.requested + approval.settled
//                     menunggu jawaban pengguna / ditolak pengguna
//   delegation (sesi anak dengan parent_session_id)
//                     pekerjaan yang diserahkan ke sub-agent
//   run INTERRUPTED   eksekusi terputus tanpa hasil terminal
//
// Modul ini TIDAK menyentuh TaskStore sama sekali. Penggabungan dengan task
// kanonik dilakukan oleh proyeksi (`open-work.ts`), dan hanya sebagai
// penanda/provenance — tidak pernah sebagai perubahan status.

import type { DomainEvent } from "../presentation/events.ts"
import type { TaskStatus, TaskVerification } from "../task/model.ts"

/** Kategori intent yang dikontrak P14.1. */
export type OpenWorkState =
  | "OPEN"
  | "PARTIAL"
  | "BLOCKED"
  | "WAITING_FOR_USER"
  | "DELEGATED"
  | "FAILED_NEEDS_FOLLOWUP"
  | "UNKNOWN"
  | "COMPLETED"
  | "CANCELLED"
  | "DECLINED"

/** Jenis bukti yang boleh menghasilkan kandidat. */
export type CommitmentSource = "TASK" | "PLAN_STEP" | "APPROVAL" | "DELEGATION" | "RUN"

/**
 * Satu kandidat intent dari histori.
 *
 * `taskId` hanya diisi bila artefak SENDIRI membawa id kanonik (mis. langkah
 * `plan.updated` payloadVersion=2). Modul ini tidak pernah mencocokkan judul
 * ke task — itu pekerjaan rekonsiliasi proyeksi, dan hasilnya tetap penanda.
 */
export interface IntentCandidate {
  readonly source: CommitmentSource
  readonly state: OpenWorkState
  readonly sessionId: string
  readonly taskId: string | null
  /** Ringkasan pendek yang aman tampil; bukan salinan seluruh riwayat. */
  readonly summary: string
  /** Bukti asal yang dapat ditelusuri. */
  readonly provenance: IntentProvenance
  /** Alasan state; selalu eksplisit, tidak pernah kosong. */
  readonly reason: string
  /** Status mentah artefak sumber (mis. "active", "deny") — provenance, bukan state. */
  readonly artifactStatus: string | null
  readonly observedAtIso: string
  /** Apakah kandidat ini sudah tertutup secara terminal. */
  readonly terminal: boolean
}

export interface IntentProvenance {
  readonly sessionId: string
  readonly eventSeq: number | null
  readonly turnId: number | null
  readonly planId: string | null
  readonly stepId: string | null
  readonly approvalId: string | null
  readonly childSessionId: string | null
  readonly runId: string | null
  readonly taskId: string | null
}

/** Ringkasan inventaris sesi/artefak (P14.0). */
export interface WorkInventory {
  readonly workspace: string
  readonly sessions: {
    readonly total: number
    readonly inScope: number
    readonly foreignWorkspace: number
    readonly unboundWorkspace: number
    readonly childSessions: number
  }
  readonly tasks: {
    readonly total: number
    readonly open: number
    readonly terminal: number
  }
  readonly presentationEvents: {
    readonly total: number
    readonly byType: Readonly<Record<string, number>>
  }
  readonly runs: {
    readonly total: number
    readonly active: number
    readonly interrupted: number
    readonly terminal: number
  }
  readonly checkpoints: {
    readonly sessionsWithManifest: number
    readonly entries: number
    readonly corrupt: number
  }
  readonly plans: {
    readonly events: number
    readonly openSteps: number
    readonly closedSteps: number
  }
  readonly approvals: {
    readonly requested: number
    readonly settled: number
    readonly pending: number
  }
  readonly subAgents: {
    readonly childSessions: number
    readonly resultsProduced: number
    readonly failedTurns: number
  }
  readonly excludedSessions: readonly {
    readonly sessionId: string
    readonly reason: "FOREIGN_WORKSPACE" | "UNBOUND_WORKSPACE"
  }[]
}

/** Baris sesi yang sudah dinormalisasi untuk inventaris. */
export interface WorkSessionRow {
  readonly id: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly cwd: string | null
  readonly parentSessionId: string | null
}

export interface ExtractIntentOptions {
  readonly workspace: string
  readonly sessions: readonly WorkSessionRow[]
  readonly events: readonly DomainEvent[]
  readonly runs: readonly WorkRunRow[]
  /** Batas kandidat per sumber; mencegah portofolio tumbuh tanpa batas. */
  readonly maxCandidates?: number
}

export interface WorkRunRow {
  readonly runId: string
  readonly sessionId: string
  readonly status: "CREATED" | "RUNNING" | "COMPLETED" | "INTERRUPTED" | "FAILED"
  readonly startedAtMs: number
  readonly endedAtMs: number | null
  readonly recoveryStatus: string | null
}

const DEFAULT_MAX_CANDIDATES = 500

/**
 * Batas cakupan pencarian (P14.0).
 *
 * Sesi milik SATU workspace dibandingkan lewat `cwd` yang tersimpan di baris
 * sesi. Sesi tanpa `cwd` (warisan pra-binding) TIDAK ditebak sebagai milik
 * workspace ini — ia dilaporkan sebagai `UNBOUND_WORKSPACE` dan dikeluarkan,
 * karena menganggapnya "milik sini" adalah klaim yang tidak bisa dibuktikan.
 * Perbandingan path case-insensitive di Windows adalah kenyataan filesystem,
 * bukan preferensi.
 */
export type SessionScope = "IN_SCOPE" | "FOREIGN_WORKSPACE" | "UNBOUND_WORKSPACE"

export function scopeSession(
  workspace: string,
  sessionCwd: string | null | undefined,
): SessionScope {
  // Baris legacy boleh membawa NULL (bentuk lama pra-binding): itu bukan
  // milik workspace ini dan tidak boleh melempar — UNBOUND, gagal-jujur.
  if (sessionCwd === null || sessionCwd === undefined || sessionCwd.trim() === "")
    return "UNBOUND_WORKSPACE"
  const norm = (p: string): string => {
    const stripped = p.replace(/[\\/]+$/, "").replace(/\\/g, "/")
    return process.platform === "win32" ? stripped.toLowerCase() : stripped
  }
  return norm(sessionCwd) === norm(workspace) ? "IN_SCOPE" : "FOREIGN_WORKSPACE"
}

/**
 * Klasifikasi cakupan SELURUH sesi, termasuk sesi anak sub-agent.
 *
 * `createChildSession` menulis baris anak TANPA binding cwd sendiri (cwd='');
 * satu-satunya bukti workspace anak adalah lineage-nya. Maka: anak mewarisi
 * klasifikasi leluhur TERMULAIKANNYA (yang punya binding). Tanpa aturan ini,
 * seluruh hasil sub-agent — yang roadmap P14 eksplisit masukkan — tidak
 * terlihat oleh inventaris/ekstraksi.
 *
 * Lineage korup (siklus) gagal-jujur: sesi dalam siklus diklasifikasikan
 * dari bindingnya sendiri (biasanya UNBOUND), tidak pernah menggantung
 * tak-terbatas.
 */
export function classifySessionScopes(
  workspace: string,
  sessions: readonly WorkSessionRow[],
): Map<string, SessionScope> {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const cache = new Map<string, SessionScope>()
  const classify = (s: WorkSessionRow, seen: ReadonlySet<string>): SessionScope => {
    const memo = cache.get(s.id)
    if (memo !== undefined) return memo
    if (s.parentSessionId !== null && !seen.has(s.id)) {
      const parent = byId.get(s.parentSessionId)
      const scope =
        parent !== undefined
          ? classify(parent, new Set([...seen, s.id]))
          : scopeSession(workspace, s.cwd) // induk tak ada di inventaris: binding sendiri
      cache.set(s.id, scope)
      return scope
    }
    const scope = scopeSession(workspace, s.cwd)
    cache.set(s.id, scope)
    return scope
  }
  const out = new Map<string, SessionScope>()
  for (const s of sessions) out.set(s.id, classify(s, new Set()))
  return out
}

const TERMINAL_STATES: ReadonlySet<OpenWorkState> = new Set(["COMPLETED", "CANCELLED", "DECLINED"])

export function isTerminalIntentState(state: OpenWorkState): boolean {
  return TERMINAL_STATES.has(state)
}

/** Potong ringkasan agar portofolio tidak menyimpan salinan riwayat. */
function clip(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

function provenanceOf(
  sessionId: string,
  ev: DomainEvent | null,
  extra: Partial<IntentProvenance> = {},
): IntentProvenance {
  return {
    sessionId,
    eventSeq: ev?.eventSeq ?? null,
    turnId: ev?.turnId ?? null,
    planId: null,
    stepId: null,
    approvalId: null,
    childSessionId: null,
    runId: null,
    taskId: null,
    ...extra,
  }
}

/**
 * Status langkah plan → state intent.
 *
 * `active` = PARTIAL (dikerjakan, belum tuntas), `pending` = OPEN,
 * `blocked` = BLOCKED. `completed`/`cancelled` adalah terminal dan TIDAK
 * dipromosikan kembali menjadi open (larangan P14).
 */
export function planStepState(status: string): OpenWorkState {
  switch (status) {
    case "active":
      return "PARTIAL"
    case "pending":
      return "OPEN"
    case "blocked":
      return "BLOCKED"
    case "completed":
      return "COMPLETED"
    case "cancelled":
      return "CANCELLED"
    default:
      // Status asing = tidak bisa dibuktikan. Jangan menebak.
      return "UNKNOWN"
  }
}

/** Pastikan kandidat tidak pernah melebihi batas tanpa terlihat. */
function push(candidates: IntentCandidate[], cand: IntentCandidate, max: number): boolean {
  if (candidates.length >= max) return false
  candidates.push(cand)
  return true
}

function extractPlanSteps(
  events: readonly DomainEvent[],
  inScope: ReadonlySet<string>,
  out: IntentCandidate[],
  max: number,
): void {
  // `plan.updated` adalah SNAPSHOT, bukan delta: adaptor menerbitkannya setiap
  // `todo_write` sukses dengan SELURUH daftar langkah sesi. Tanpa kolaps, satu
  // langkah muncul sekali per snapshot — versi lama (pending/active) tetap
  // tampil sebagai kandidat duplikat di samping status terbaru, dan portofolio
  // menduplikasi riwayat.
  //
  // Kunci kolaps = SESI, bukan `planId`: `planId` memuat nomor turn
  // (`plan:<session>:<turn>`), sementara daftar todo adalah milik SESI. Langkah
  // pending yang sama akan muncul lagi di snapshot turn berikutnya, jadi
  // mengunci per-planId tetap menduplikasi riwayat lintas turn. Snapshot
  // TERAKHIR per sesi adalah kebenaran terkini: ia menggantikan snapshot
  // sebelumnya, termasuk langkah yang sudah dihapus dari daftar.
  const latest = new Map<string, DomainEvent & { type: "plan.updated" }>()
  for (const ev of events) {
    if (ev.type !== "plan.updated") continue
    if (!inScope.has(ev.sessionId)) continue
    const prev = latest.get(ev.sessionId)
    // eventSeq adalah urutan append durable; `>=` membuat posisi baca terakhir
    // menang bila seq sama (tidak ada urutan lain yang lebih kuat).
    if (prev === undefined || ev.eventSeq >= prev.eventSeq) latest.set(ev.sessionId, ev)
  }
  for (const ev of latest.values()) {
    for (const step of ev.steps) {
      const state = planStepState(step.status)
      const canonical = typeof step.taskId === "string" ? step.taskId : null
      if (
        !push(
          out,
          {
            source: "PLAN_STEP",
            state,
            sessionId: ev.sessionId,
            taskId: canonical,
            summary: clip(step.title ?? step.stepId),
            provenance: provenanceOf(ev.sessionId, ev, {
              planId: ev.planId,
              stepId: step.stepId,
              taskId: canonical,
            }),
            reason: `plan step status=${step.status}`,
            observedAtIso: new Date(ev.ts).toISOString(),
            artifactStatus: step.status,
            terminal: isTerminalIntentState(state),
          },
          max,
        )
      )
        return
    }
  }
}

function extractApprovals(
  events: readonly DomainEvent[],
  inScope: ReadonlySet<string>,
  out: IntentCandidate[],
  max: number,
): void {
  // Permintaan persetujuan tanpa `settled` = WAITING_FOR_USER. `settled` dengan
  // deny = DECLINED (terminal): penolakan pengguna TIDAK boleh hidup lagi
  // sebagai open loop.
  const settled = new Map<string, DomainEvent & { type: "approval.settled" }>()
  for (const ev of events) {
    if (ev.type === "approval.settled") settled.set(`${ev.sessionId}\u0000${ev.approvalId}`, ev)
  }
  for (const ev of events) {
    if (ev.type !== "approval.requested") continue
    if (!inScope.has(ev.sessionId)) continue
    const answer = settled.get(`${ev.sessionId}\u0000${ev.approvalId}`)
    // "allow" BUKAN bukti pekerjaan selesai — hanya bukti izin diberikan.
    // Memalsukan COMPLETED di sini melanggar larangan "jangan diam-diam
    // membuat status selesai". Approval yang di-allow TIDAK menghasilkan
    // kandidat; loop-nya tertutup tanpa klaim penyelesaian.
    if (answer !== undefined && answer.outcome.decision !== "deny") continue
    const state: OpenWorkState = answer === undefined ? "WAITING_FOR_USER" : "DECLINED"
    const reason =
      answer === undefined
        ? "approval requested, no settled outcome"
        : `approval denied by ${answer.outcome.by}`
    const summary = clip(`approval ${ev.identity.qualified}: ${ev.argsSummary.text}`)
    if (
      !push(
        out,
        {
          source: "APPROVAL",
          state,
          sessionId: ev.sessionId,
          taskId: null,
          summary,
          provenance: provenanceOf(ev.sessionId, ev, { approvalId: ev.approvalId }),
          reason,
          observedAtIso: new Date(ev.ts).toISOString(),
          artifactStatus: answer === undefined ? "requested" : "deny",
          terminal: isTerminalIntentState(state),
        },
        max,
      )
    )
      return
  }
}

function extractDelegations(
  sessions: readonly WorkSessionRow[],
  events: readonly DomainEvent[],
  inScope: ReadonlySet<string>,
  out: IntentCandidate[],
  max: number,
): void {
  // Sesi anak = pekerjaan yang DISERAHKAN. Hasilnya dibaca dari artefak
  // eksplisit: `result.produced` (terminal-ish) dan `turn.failed`. Sesi anak
  // tanpa hasil terminal = DELEGATED (belum selesai), bukan sukses diam-diam.
  const produced = new Map<string, DomainEvent>()
  const failed = new Map<string, DomainEvent>()
  for (const ev of events) {
    if (ev.type === "result.produced") produced.set(ev.sessionId, ev)
    if (ev.type === "turn.failed") failed.set(ev.sessionId, ev)
  }
  for (const s of sessions) {
    if (s.parentSessionId === null) continue
    if (!inScope.has(s.id)) continue
    const result = produced.get(s.id)
    const failure = failed.get(s.id)
    let state: OpenWorkState
    let reason: string
    let ev: DomainEvent | null = null
    if (result !== undefined && result.type === "result.produced") {
      ev = result
      state =
        result.status === "completed"
          ? "COMPLETED"
          : result.status === "failed"
            ? "FAILED_NEEDS_FOLLOWUP"
            : "CANCELLED"
      reason = `delegated result ${result.status}`
    } else if (failure !== undefined && failure.type === "turn.failed") {
      ev = failure
      state = "FAILED_NEEDS_FOLLOWUP"
      reason = `delegated turn failed (${failure.error.cause})`
    } else {
      state = "DELEGATED"
      reason = "delegated child session has no terminal result"
    }
    if (
      !push(
        out,
        {
          source: "DELEGATION",
          state,
          sessionId: s.id,
          taskId: null,
          summary: clip(`delegated to ${s.id}`),
          provenance: provenanceOf(s.id, ev, { childSessionId: s.id }),
          reason,
          observedAtIso: new Date(ev?.ts ?? s.updatedAtMs).toISOString(),
          artifactStatus:
            result !== undefined && result.type === "result.produced"
              ? result.status
              : failure !== undefined && failure.type === "turn.failed"
                ? "turn.failed"
                : "open",
          terminal: isTerminalIntentState(state),
        },
        max,
      )
    )
      return
  }
}

function extractRuns(
  runs: readonly WorkRunRow[],
  inScope: ReadonlySet<string>,
  out: IntentCandidate[],
  max: number,
): void {
  // RUNNING tidak dilaporkan sebagai open loop: runtime hidup adalah keadaan
  // normal, bukan pekerjaan yang terlupa. INTERRUPTED-lah yang meninggalkan
  // pekerjaan setengah jadi, dan itu dilabel jujur (bukan UNKNOWN sukses).
  for (const r of runs) {
    if (!inScope.has(r.sessionId)) continue
    if (r.status !== "INTERRUPTED") continue
    if (
      !push(
        out,
        {
          source: "RUN",
          state: "FAILED_NEEDS_FOLLOWUP",
          sessionId: r.sessionId,
          taskId: null,
          summary: clip(`interrupted run ${r.runId}`),
          provenance: provenanceOf(r.sessionId, null, { runId: r.runId }),
          reason: `run interrupted (recovery=${r.recoveryStatus ?? "NONE"})`,
          observedAtIso: new Date(r.endedAtMs ?? r.startedAtMs).toISOString(),
          artifactStatus: r.status,
          terminal: false,
        },
        max,
      )
    )
      return
  }
}

/**
 * Kandidat intent dari seluruh artefak terstruktur, dalam urutan deterministik.
 *
 * Batas `maxCandidates` dipakai bersama oleh semua sumber supaya portofolio
 * tidak bisa tumbuh tanpa batas dari sesi dengan ribuan event.
 */
export function extractIntentCandidates(opts: ExtractIntentOptions): IntentCandidate[] {
  const max = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  const inScope = new Set(
    [...classifySessionScopes(opts.workspace, opts.sessions)]
      .filter(([, scope]) => scope === "IN_SCOPE")
      .map(([id]) => id),
  )

  const out: IntentCandidate[] = []
  extractPlanSteps(opts.events, inScope, out, max)
  if (out.length < max) extractApprovals(opts.events, inScope, out, max)
  if (out.length < max) extractDelegations(opts.sessions, opts.events, inScope, out, max)
  if (out.length < max) extractRuns(opts.runs, inScope, out, max)
  out.sort((a, b) => {
    const at = Date.parse(a.observedAtIso)
    const bt = Date.parse(b.observedAtIso)
    if (at !== bt) return bt - at
    const ak = `${a.sessionId}\u0000${a.provenance.eventSeq ?? -1}\u0000${a.summary}`
    const bk = `${b.sessionId}\u0000${b.provenance.eventSeq ?? -1}\u0000${b.summary}`
    return ak < bk ? -1 : ak > bk ? 1 : 0
  })
  return out
}

// ── P14.1/P14.4 — derivasi state, prioritas, dan next action (MURNI) ────────

/**
 * State P14.1 untuk task kanonik. Pemetaan mekanis + dua override berbasis
 * bukti eksplisit: verifikasi gagal dan dependensi tak tuntas. Tidak ada
 * tebakan dari judul.
 */
export function taskWorkState(
  status: TaskStatus,
  evidence: { verification?: TaskVerification | null; unresolvedDependency?: boolean } = {},
): { state: OpenWorkState; reason: string } {
  if (evidence.verification?.verdict === "failed") {
    return { state: "FAILED_NEEDS_FOLLOWUP", reason: "verification failed" }
  }
  if (evidence.unresolvedDependency === true) {
    return { state: "BLOCKED", reason: "depends on unfinished work" }
  }
  switch (status) {
    case "PENDING":
      return { state: "OPEN", reason: "task pending" }
    case "IN_PROGRESS":
      return { state: "PARTIAL", reason: "task in progress" }
    case "VERIFYING":
      return { state: "PARTIAL", reason: "task awaiting verification" }
    case "BLOCKED":
      return { state: "BLOCKED", reason: "task blocked" }
    case "FAILED":
      return { state: "FAILED_NEEDS_FOLLOWUP", reason: "task failed" }
    case "RETRYING":
      return { state: "FAILED_NEEDS_FOLLOWUP", reason: "task retrying after failure" }
    default:
      // Fail-closed: status terminal tidak punya state open. Menyimpulkan
      // kategori open dari status tertutup adalah bug, bukan fitur.
      throw new Error(`open-work-intent: terminal status has no open state: ${status}`)
  }
}

/** Tingkat prioritas portofolio — heuristik presentasi, BUKAN otoritas. */
export type WorkPriorityLevel = "P0" | "P1" | "P2" | "P3"

const STATE_RANK: Readonly<Record<OpenWorkState, number>> = {
  BLOCKED: 0,
  FAILED_NEEDS_FOLLOWUP: 0,
  WAITING_FOR_USER: 1,
  DELEGATED: 1,
  UNKNOWN: 1,
  PARTIAL: 2,
  OPEN: 3,
  COMPLETED: 4,
  CANCELLED: 4,
  DECLINED: 4,
}

export function workPriority(
  state: OpenWorkState,
  stale: boolean,
): { level: WorkPriorityLevel; reason: string } {
  const rank = STATE_RANK[state]
  // Item stale dinaikkan SATU tingkat: umur adalah sinyal, bukan bukti, dan
  // tidak pernah melompati item yang gagal/terblokir.
  const boosted = stale && rank > 0 ? rank - 1 : rank
  const level = (
    boosted === 0 ? "P0" : boosted === 1 ? "P1" : boosted === 2 ? "P2" : "P3"
  ) as WorkPriorityLevel
  const reason = stale && rank > 0 ? `${state} (stale, boosted)` : `${state}`
  return { level, reason }
}

/**
 * Next action eksplisit per state. Tidak ada yang otomatis: setiap nilai
 * mengarah ke jalur otoritas yang sudah ada (lifecycle TaskStore, jawaban
 * approval di sesi sumber, atau inspeksi operator).
 */
export function nextActionFor(state: OpenWorkState, detail = ""): string {
  const suffix = detail.trim().length > 0 ? ` — ${detail.trim()}` : ""
  switch (state) {
    case "OPEN":
      return `start via existing lifecycle (TaskStore), or adopt into an active session${suffix}`
    case "PARTIAL":
      return `resume: rebuild context from provenance, then continue via TaskStore/Scheduler${suffix}`
    case "BLOCKED":
      return `resolve blocker first${suffix}`
    case "FAILED_NEEDS_FOLLOWUP":
      return `review failure evidence, then retry via existing lifecycle${suffix}`
    case "WAITING_FOR_USER":
      return `answer the pending approval/ask in the source session${suffix}`
    case "DELEGATED":
      return `check the sub-agent outcome in the child session${suffix}`
    case "UNKNOWN":
      return `inspect provenance manually — state cannot be proven from evidence${suffix}`
    default:
      return `terminal — no next action${suffix}`
  }
}

// ── P14.0 — inventaris lintas sumber (agregasi MURNI atas baris) ─────────────

export interface InventoryInput {
  readonly workspace: string
  readonly sessions: readonly WorkSessionRow[]
  readonly events: readonly DomainEvent[]
  readonly runs: readonly WorkRunRow[]
  readonly candidates: readonly IntentCandidate[]
  readonly taskCounts: { total: number; open: number; terminal: number }
  readonly checkpoints: { sessionsWithManifest: number; entries: number; corrupt: number }
}

export function buildWorkInventory(input: InventoryInput): WorkInventory {
  // Lineage-aware: sesi anak mewarisi cakupan leluhur termulaiannya
  // (lihat classifySessionScopes) — hasil sub-agent tetap terlihat.
  const scopes = classifySessionScopes(input.workspace, input.sessions)
  const inScopeIds = new Set(
    [...scopes].filter(([, scope]) => scope === "IN_SCOPE").map(([id]) => id),
  )
  const excluded: { sessionId: string; reason: "FOREIGN_WORKSPACE" | "UNBOUND_WORKSPACE" }[] = []
  let foreign = 0
  let unbound = 0
  let childSessions = 0
  for (const s of input.sessions) {
    const scope = scopes.get(s.id)
    if (scope === "FOREIGN_WORKSPACE") {
      foreign++
      excluded.push({ sessionId: s.id, reason: "FOREIGN_WORKSPACE" })
    } else if (scope === "UNBOUND_WORKSPACE") {
      unbound++
      excluded.push({ sessionId: s.id, reason: "UNBOUND_WORKSPACE" })
    } else if (s.parentSessionId !== null) {
      childSessions++
    }
  }
  const byType: Record<string, number> = {}
  let planEvents = 0
  let requested = 0
  let settled = 0
  const resultsProduced = new Set<string>()
  const failedTurns = new Set<string>()
  for (const ev of input.events) {
    if (!inScopeIds.has(ev.sessionId)) continue
    byType[ev.type] = (byType[ev.type] ?? 0) + 1
    if (ev.type === "plan.updated") planEvents++
    if (ev.type === "approval.requested") requested++
    if (ev.type === "approval.settled") settled++
  }
  for (const s of input.sessions) {
    if (s.parentSessionId === null || !inScopeIds.has(s.id)) continue
    for (const ev of input.events) {
      if (ev.sessionId !== s.id) continue
      if (ev.type === "result.produced") resultsProduced.add(s.id)
      if (ev.type === "turn.failed") failedTurns.add(s.id)
    }
  }
  let activeRuns = 0
  let interruptedRuns = 0
  let terminalRuns = 0
  let totalRuns = 0
  for (const r of input.runs) {
    if (!inScopeIds.has(r.sessionId)) continue
    totalRuns++
    if (r.status === "RUNNING" || r.status === "CREATED") activeRuns++
    else if (r.status === "INTERRUPTED") interruptedRuns++
    else terminalRuns++
  }
  let openPlanSteps = 0
  let closedPlanSteps = 0
  let pendingApprovals = 0
  for (const c of input.candidates) {
    if (c.source === "PLAN_STEP") {
      if (c.terminal) closedPlanSteps++
      else openPlanSteps++
    }
    if (c.source === "APPROVAL" && c.state === "WAITING_FOR_USER") pendingApprovals++
  }
  return {
    workspace: input.workspace,
    sessions: {
      total: input.sessions.length,
      inScope: inScopeIds.size,
      foreignWorkspace: foreign,
      unboundWorkspace: unbound,
      childSessions,
    },
    tasks: input.taskCounts,
    presentationEvents: { total: Object.values(byType).reduce((a, b) => a + b, 0), byType },
    runs: {
      total: totalRuns,
      active: activeRuns,
      interrupted: interruptedRuns,
      terminal: terminalRuns,
    },
    checkpoints: input.checkpoints,
    plans: { events: planEvents, openSteps: openPlanSteps, closedSteps: closedPlanSteps },
    approvals: { requested, settled, pending: pendingApprovals },
    subAgents: {
      childSessions,
      resultsProduced: resultsProduced.size,
      failedTurns: failedTurns.size,
    },
    excludedSessions: excluded,
  }
}
