// P14.2/P14.4/P14.6 — PROYEKSI open-work lintas sesi. READ-ONLY, MURNI di
// atas sumber kanonik yang sudah ada:
//
//   tasks.db    (TaskStore)  → status task = SATU-SATUNYA otoritas
//   sessions.db (persistence)→ meta sesi   = bukti asal/provenance
//   presentation_events      → histori intent terstruktur (P14.2 penuh)
//   runs                     → eksekusi yang terputus (P14.1 RUN)
//   checkpoint manifest      → inventaris artefak progress (P14.0)
//
// Modul ini TIDAK PERNAH menulis: tidak ada INSERT/UPDATE/DELETE, tidak ada
// lease yang diakuisisi, tidak ada scheduler yang dipicu. Ia adalah indeks
// lintas sesi — persis batas yang ditetapkan roadmap P14: "Hasil agregasi
// adalah indeks/proyeksi lintas sesi. TaskStore tetap menjadi authority
// status tugas."
//
// Tiga aturan kejujuran yang dijaga di sini:
//
//   1. UNKNOWN dilabel, bukan disembunyikan. Task tanpa baris sesi di
//      sessions.db = `SESSION_MISSING` — provenance tidak bisa ditelusuri,
//      dan itu dinyatakan apa adanya.
//   2. Kemiripan judul BUKAN bukti identitas. Penanda duplikat lintas sesi
//      hanya UNPROVEN; penggabungan tetap hanya lewat
//      `TaskStore.declareTaskDuplicate` yang eksplisit + ber-evidence.
//   3. Closure feedback tidak menyimpulkan. Entri "closed" adalah baris yang
//      SUDAH terminal di TaskStore (atau barisnya sudah tidak ada) DAN punya
//      provenance P14, atau artefak intent yang eksplisit terminal dengan
//      klaimnya dilabel verified/unverified. Status task selalu dibaca ulang
//      dari tabel tasks saat proyeksi berjalan — duplikat yang dibuka kembali
//      oleh operator otomatis muncul kembali sebagai open, tanpa tulisan apa
//      pun dari lapisan ini.
//
// Intent dari histori HANYA berasal dari artefak terstruktur (plan/approval/
// delegation/run) — lihat `open-work-intent.ts`. Pesan bebas pengguna tidak
// pernah dipindai untuk "komitmen": roadmap P14 melarang menganggap
// brainstorming sebagai tugas.

import { resolve as resolvePath } from "node:path"
import type { TaskStatus, TaskVerification } from "../task/model.ts"
import type { ExecutionOwner, TaskMerge, TaskTransfer, UnfinishedWorkItem } from "../task/store.ts"
import { TaskStore } from "../task/store.ts"
import { readCheckpointInventorySync } from "./checkpoint.ts"
import {
  buildWorkInventory,
  classifySessionScopes,
  extractIntentCandidates,
  type IntentCandidate,
  nextActionFor,
  type OpenWorkState,
  taskWorkState,
  type WorkInventory,
  type WorkPriorityLevel,
  type WorkRunRow,
  workPriority,
} from "./open-work-intent.ts"
import {
  type RunInventoryRow,
  readAllPresentationEventsReadOnly,
  readRunRowsReadOnly,
  readSessionInventoryRows,
  readSessionMetaRows,
  type SessionInventoryRow,
} from "./persistence.ts"

/**
 * Batas usia default sebelum item disebut STALE (7 hari).
 *
 * Angka ini hanya soal PENANDA prioritas, bukan keputusan otoritas: item
 * stale tetap valid dan tetap boleh diadopsi/dilanjutkan. Konstanta bernama
 * supaya mengubahnya adalah tindakan yang terlihat.
 */
export const DEFAULT_OPEN_WORK_STALE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Kategori open-work — pemetaan MEKANIS dari `TaskStatus`, bukan inferensi.
 * Setiap kategori berpasangan eksak dengan satu status; tidak ada tebakan
 * "mungkin menunggu user" dari teks judul.
 */
export type OpenWorkCategory =
  | "OPEN"
  | "IN_PROGRESS"
  | "VERIFYING"
  | "BLOCKED"
  | "FAILED_NEEDS_FOLLOWUP"
  | "RETRYING"

export function openWorkCategory(status: TaskStatus): OpenWorkCategory {
  switch (status) {
    case "PENDING":
      return "OPEN"
    case "IN_PROGRESS":
      return "IN_PROGRESS"
    case "VERIFYING":
      return "VERIFYING"
    case "BLOCKED":
      return "BLOCKED"
    case "FAILED":
      return "FAILED_NEEDS_FOLLOWUP"
    case "RETRYING":
      return "RETRYING"
    default:
      // Fail-closed: status terminal tidak pernah menjadi item open-work.
      // `listUnfinishedWork` memang hanya mengembalikan status non-terminal,
      // jadi mencapai cabang ini berarti ada bug di discovery — jangan
      // ditebak kategorinya.
      throw new Error(`open-work: terminal status is never an open item: ${status}`)
  }
}

/**
 * Kunci kemiripan judul — HANYA untuk penanda presentasi.
 *
 * Normalisasi: huruf kecil, buang semua karakter non-alnum, rangkum jadi satu
 * spasi. Deterministik dan murni. Kunci yang sama TIDAK berarti dua task
 * adalah pekerjaan yang sama (tugas berulang yang sengaja independen akan
 * berbagi kunci); penggabungan tetap harus lewat `declareTaskDuplicate`.
 */
export function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/** Umur manusiawi yang deterministik dari `ageMs` (tidak pernah negatif). */
export function formatAge(ageMs: number): string {
  const ms = Math.max(0, Math.floor(ageMs))
  if (ms < 60_000) return "now"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

// ── P14.1/P14.4 — bidang portofolio. SEMUANYA proyeksi, bukan otoritas ──────

/** Satu blocker eksplisit; detail wajib, tidak pernah "unknown" kosong. */
export interface WorkBlocker {
  readonly kind: "TASK_BLOCKED" | "DEPENDENCY" | "VERIFICATION" | "PROVENANCE"
  readonly detail: string
}

/** Dependensi kanonik task, direkonsiliasi ke status TaskStore saat baca. */
export interface WorkDependency {
  readonly taskId: string
  readonly title: string | null
  readonly status: TaskStatus | "MISSING"
  /** Hanya COMPLETED yang memuaskan; selain itu blocker eksplisit. */
  readonly satisfied: boolean
}

/** Bukti plan terstruktur yang menunjuk task ini (provenance P14.2 penuh). */
export interface PlanStepEvidence {
  readonly planId: string
  readonly stepId: string
  readonly claimedStatus: string
  readonly eventSeq: number
  readonly turnId: number
  readonly observedAtIso: string
}

/**
 * Grup duplikat lintas sesi — SELALU `UNPROVEN`.
 *
 * Kontrak P14.3: kemiripan lintas sesi diungkapkan sebagai konflik/kandidat,
 * tidak pernah digabung otomatis. Perpindahan otoritas tetap wajib lewat
 * adopsi eksplisit; merge tetap satu-sesi. `divergentStates` = item dalam
 * grup mengklaim state berbeda — konflik yang harus dilihat operator.
 */
export interface DuplicateGroupRef {
  readonly key: string
  readonly count: number
  readonly sessions: readonly string[]
  readonly divergentStates: boolean
  readonly proven: false
}

/** Entri open-work: task non-terminal + provenance + penanda. */
export interface OpenWorkEntry {
  readonly sessionId: string
  readonly taskId: string
  readonly title: string
  readonly status: TaskStatus
  readonly category: OpenWorkCategory
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly ageMs: number
  readonly sessionIncarnation: number
  /** `SESSION_MISSING` = tidak ada baris sessions.db → provenance UNKNOWN. */
  readonly provenance: "SESSION_PRESENT" | "SESSION_MISSING"
  readonly sessionUpdatedAtMs: number | null
  readonly stale: boolean
  readonly executionOwner: ExecutionOwner | null
  readonly execGeneration: number
  readonly attemptGeneration: number | null
  readonly transferredFromSessionId: string | null
  readonly transferredAt: string | null
  /** Kunci kemiripan (presentasi saja; bukan bukti identitas). */
  readonly titleKey: string
  /** Berapa item open berbagi kunci judul. >1 = kandidat serupa UNPROVEN. */
  readonly similarCount: number
  /** State P14.1 berbasis bukti; beda dari `category` yang mekanis per status. */
  readonly state: OpenWorkState
  readonly stateReason: string
  readonly priority: { level: WorkPriorityLevel; reason: string }
  readonly blockers: readonly WorkBlocker[]
  readonly dependencies: readonly WorkDependency[]
  readonly nextAction: string
  readonly verification: TaskVerification | null
  /** Langkah plan terstruktur yang menunjuk task ini (provenance P14.2). */
  readonly planSteps: readonly PlanStepEvidence[]
  /** Grup duplikat lintas sesi (task + intent); SELALU UNPROVEN. */
  readonly duplicate: DuplicateGroupRef | null
}

/**
 * Entri closure feedback: pekerjaan dengan provenance P14 yang SUDAH tertutup
 * di TaskStore, atau barisnya sudah tidak ada.
 *
 * `kind` menjawab "provenance penutupan apa yang dimiliki item ini":
 * transfer lintas sesi, atau deklarasi duplikat. Status SELALU dibaca ulang
 * dari tabel tasks — proyeksi tidak pernah menyimpan salinan status.
 */
export interface ClosedWorkEntry {
  readonly kind: "TRANSFERRED" | "MERGED_DUPLICATE" | "INTENT"
  readonly sessionId: string
  /** Null untuk closure intent tanpa task kanonik (mis. approval DECLINED). */
  readonly taskId: string | null
  readonly title: string | null
  /** Status KANONIK saat ini, atau "MISSING" bila barisnya sudah tidak ada. */
  readonly status: TaskStatus | "MISSING" | null
  readonly closedAt: string | null
  readonly revision: number | null
  readonly transferredFromSessionId: string | null
  readonly transferredAt: string | null
  readonly mergeSurvivorId: string | null
  readonly mergeEvidence: string | null
  // ── P14.1/P14.6 — state intent + label klaim untuk closure artefak ──
  /** State P14.1 dari closure ini (untuk kind INTENT; null bila task-based). */
  readonly intentState: OpenWorkState | null
  /**
   * Label kejujuran klaim penyelesaian: `verified` = task kanonik dengan
   * verification passed; `unverified` = klaim artefak tanpa verifikasi
   * (ditampilkan apa adanya, BUKAN disembunyikan); `not-applicable` =
   * DECLINED/CANCELLED (tidak ada klaim penyelesaian untuk diverifikasi).
   */
  readonly claim: "verified" | "unverified" | "not-applicable"
  /** Alasan closure eksplisit — wajib untuk kind INTENT. */
  readonly reason: string
}

export interface OpenWorkReport {
  readonly generatedAtIso: string
  readonly staleMs: number
  readonly open: readonly OpenWorkEntry[]
  /**
   * Kandidat intent open dari histori terstruktur (P14.2 penuh): approval
   * yang menunggu, delegasi sub-agent tanpa hasil terminal, run terputus,
   * langkah plan tanpa task kanonik. SEMUANYA proyeksi berprovenance; tidak
   * ada satu pun yang otomatis dieksekusi.
   */
  readonly intent: readonly IntentCandidate[]
  /** Grup duplikat lintas sesi (task + intent) — SELALU UNPROVEN. */
  readonly duplicateGroups: readonly DuplicateGroupRef[]
  readonly closed: readonly ClosedWorkEntry[]
  /** Inventaris P14.0; null kecuali diminta eksplisit. */
  readonly inventory: WorkInventory | null
  /** Event presentasi yang gagal didekode — bukti tak terbaca, tidak disembunyikan. */
  readonly rejectedEvents: number
  readonly counts: {
    readonly open: number
    readonly stale: number
    readonly unknownProvenance: number
    /** Jumlah kunci judul yang dibagi >1 item open (kandidat UNPROVEN). */
    readonly similarGroups: number
    readonly closed: number
    /** Kandidat intent open (non-terminal, tanpa task kanonik). */
    readonly intent: number
    /** Grup duplikat lintas sesi (count > 1, lintas task+intent). */
    readonly duplicateGroups: number
    /** Grup duplikat yang state-nya saling bertentangan (wajib dilihat). */
    readonly conflicts: number
  }
}

export interface ProjectOpenWorkOptions {
  readonly cwd?: string
  /** Waktu evaluasi; default `Date.now()`. Tes menyuntikkan nilai tetap. */
  readonly now?: number
  /** Ambang STALE; default `DEFAULT_OPEN_WORK_STALE_MS`. */
  readonly staleMs?: number
  /** Batasi ke satu sesi (namespace TaskStore). */
  readonly sessionId?: string
  /** Sertakan seksi closure feedback (default false: hanya open). */
  readonly includeClosed?: boolean
  /** Sertakan ekstraksi intent dari histori (default true). */
  readonly includeIntent?: boolean
  /** Sertakan inventaris P14.0 (default false; membaca lebih banyak sumber). */
  readonly includeInventory?: boolean
  /** Batas kandidat intent (default di modul kontrak). */
  readonly maxIntentCandidates?: number
}

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["COMPLETED", "CANCELLED"])

function toMs(iso: string): number {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/**
 * Proyeksikan open-work lintas sesi untuk SATU workspace.
 *
 * Cakupan mengikuti `tasks.db` (per-workspace): sesi proyek lain memang tak
 * terlihat, dan itu batas yang benar — tanpa aturan merge lintas-proyek,
 * menggabungkan keduanya akan menyatukan pekerjaan yang berbeda. Sesi dari
 * histori dibatasi lebih jauh oleh binding `cwd` baris sesi (P14.0): sesi
 * milik workspace lain dilabel FOREIGN_WORKSPACE dan dikeluarkan; sesi tanpa
 * binding dilabel UNBOUND_WORKSPACE — tidak ada yang ditebak milik sini.
 */
export function projectOpenWork(opts: ProjectOpenWorkOptions = {}): OpenWorkReport {
  const now = opts.now ?? Date.now()
  const staleMs = opts.staleMs ?? DEFAULT_OPEN_WORK_STALE_MS
  const store = new TaskStore(opts.cwd)
  const workspace = resolvePath(opts.cwd ?? process.cwd())

  const items: readonly UnfinishedWorkItem[] = store.listUnfinishedWork(opts.sessionId)
  const sessionMeta = new Map(readSessionMetaRows(opts.cwd).map((r) => [r.id, r]))

  // ── sumber histori + runtime (P14.0/P14.2) — semua jalur baca read-only ──
  const wantHistory = opts.includeIntent !== false || opts.includeInventory === true
  const inventoryRows: readonly SessionInventoryRow[] = wantHistory
    ? readSessionInventoryRows(opts.cwd)
    : []
  const eventLoad = wantHistory
    ? readAllPresentationEventsReadOnly(opts.cwd)
    : { events: [], rejected: 0 }
  /** Event presentasi yang gagal didekode — dilaporkan, tidak disembunyikan. */
  const rejectedEvents: number = eventLoad.rejected
  const runRows: readonly RunInventoryRow[] = wantHistory ? readRunRowsReadOnly(opts.cwd) : []
  const workSessions = inventoryRows.map((r) => ({
    id: r.id,
    createdAtMs: r.created_at,
    updatedAtMs: r.updated_at,
    cwd: r.cwd,
    parentSessionId: r.parent_session_id,
  }))
  const workRuns: readonly WorkRunRow[] = runRows
    .filter(
      (
        r,
      ): r is RunInventoryRow & {
        status: "CREATED" | "RUNNING" | "COMPLETED" | "INTERRUPTED" | "FAILED"
      } =>
        r.status === "CREATED" ||
        r.status === "RUNNING" ||
        r.status === "COMPLETED" ||
        r.status === "INTERRUPTED" ||
        r.status === "FAILED",
    )
    .map((r) => ({
      runId: r.run_id,
      sessionId: r.session_id,
      status: r.status,
      startedAtMs: r.started_at,
      endedAtMs: r.ended_at,
      recoveryStatus: r.recovery_status,
    }))
  const rawCandidates = extractIntentCandidates({
    workspace,
    sessions: workSessions,
    events: eventLoad.events,
    runs: workRuns,
    ...(opts.maxIntentCandidates !== undefined ? { maxCandidates: opts.maxIntentCandidates } : {}),
  })
  // Filter `--session` berlaku konsisten untuk task DAN intent: bila operator
  // membatasi laporan ke satu sesi, kandidat sesi lain bukan bagian laporan
  // yang diminta.
  const candidates: readonly IntentCandidate[] =
    opts.includeIntent === false
      ? []
      : opts.sessionId !== undefined
        ? rawCandidates.filter((c) => c.sessionId === opts.sessionId)
        : rawCandidates

  // Kunci kemiripan dihitung dulu agar `similarCount` akurat untuk semua item.
  const titleKeys = items.map((i) => normalizeTitleKey(i.task.title))
  const keyCounts = new Map<string, number>()
  for (const key of titleKeys) {
    if (key.length === 0) continue
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)
  }

  const open: OpenWorkEntry[] = items.map((item, idx) => {
    const meta = sessionMeta.get(item.sessionId)
    const ageMs = Math.max(0, now - toMs(item.task.updatedAt))
    const titleKey = titleKeys[idx] ?? ""

    // ── P14.4: dependensi direkonsiliasi ke status kanonik saat baca ──
    const dependencies: WorkDependency[] = item.task.dependsOn.map((depId) => {
      const dep = store.getTask(item.sessionId, depId)
      const status: TaskStatus | "MISSING" = dep?.status ?? "MISSING"
      return {
        taskId: depId,
        title: dep?.title ?? null,
        status,
        satisfied: status === "COMPLETED",
      }
    })

    // ── P14.1: state berbasis bukti, bukan tebakan ──
    const unresolvedDep = dependencies.find((d) => !d.satisfied)
    const { state, reason: stateReason } = taskWorkState(item.task.status, {
      verification: item.task.verification,
      unresolvedDependency: unresolvedDep !== undefined,
    })

    // ── P14.4: blocker eksplisit (blocker kosong = tidak ada yang diklaim) ──
    const blockers: WorkBlocker[] = []
    if (item.task.blockedReason !== null && item.task.blockedReason.trim() !== "") {
      blockers.push({ kind: "TASK_BLOCKED", detail: item.task.blockedReason })
    }
    for (const d of dependencies) {
      if (!d.satisfied) {
        blockers.push({ kind: "DEPENDENCY", detail: `${d.taskId} (${d.status})` })
      }
    }
    if (item.task.verification?.verdict === "failed") {
      blockers.push({
        kind: "VERIFICATION",
        detail: item.task.verification.detail ?? "verification failed",
      })
    }

    const priority = workPriority(state, ageMs >= staleMs)
    const topBlocker = blockers[0]?.detail ?? ""
    const planSteps: PlanStepEvidence[] = candidates
      .filter(
        (c): boolean =>
          c.source === "PLAN_STEP" &&
          c.sessionId === item.sessionId &&
          c.provenance.taskId === item.task.id,
      )
      .map((c) => ({
        planId: c.provenance.planId ?? "",
        stepId: c.provenance.stepId ?? "",
        claimedStatus: c.artifactStatus ?? "?",
        eventSeq: c.provenance.eventSeq ?? -1,
        turnId: c.provenance.turnId ?? -1,
        observedAtIso: c.observedAtIso,
      }))

    return {
      sessionId: item.sessionId,
      taskId: item.task.id,
      title: item.task.title,
      status: item.task.status,
      category: openWorkCategory(item.task.status),
      revision: item.task.revision,
      createdAt: item.task.createdAt,
      updatedAt: item.task.updatedAt,
      ageMs,
      sessionIncarnation: item.sessionIncarnation,
      provenance: meta === undefined ? "SESSION_MISSING" : "SESSION_PRESENT",
      sessionUpdatedAtMs: meta === undefined ? null : meta.updated_at,
      stale: ageMs >= staleMs,
      executionOwner: item.executionOwner,
      execGeneration: item.execGeneration,
      attemptGeneration: item.attemptGeneration,
      transferredFromSessionId: item.transferredFromSessionId,
      transferredAt: item.transferredAt,
      titleKey,
      similarCount: titleKey.length === 0 ? 1 : (keyCounts.get(titleKey) ?? 1),
      state,
      stateReason,
      priority,
      blockers,
      dependencies,
      nextAction: nextActionFor(state, topBlocker),
      verification: item.task.verification ?? null,
      planSteps,
      // Diisi setelah grup duplikat lintas sesi dihitung di bawah.
      duplicate: null,
    }
  })
  // Tertua dulu (portofolio = prioritas lanjutan), tie-breaker deterministik.
  open.sort((a, b) => {
    if (a.ageMs !== b.ageMs) return b.ageMs - a.ageMs
    if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
  })

  const similarGroups = [...keyCounts.values()].filter((n) => n > 1).length

  // ── P14.3 penuh: grup duplikat LINTAS SESI (task + intent), SELALU UNPROVEN ──
  // Kemiripan tidak pernah jadi merge otomatis; perpindahan otoritas tetap
  // lewat adopsi eksplisit, merge tetap satu-sesi. Grup hanya MENGUNGKAP:
  // count, sesi mana saja, dan apakah state-nya saling bertentangan.
  const groupAgg = new Map<
    string,
    { count: number; sessions: Set<string>; states: Set<OpenWorkState> }
  >()
  const addToGroups = (key: string, sessionId: string, state: OpenWorkState): void => {
    if (key.length === 0) return
    let g = groupAgg.get(key)
    if (g === undefined) {
      g = { count: 0, sessions: new Set(), states: new Set() }
      groupAgg.set(key, g)
    }
    g.count++
    g.sessions.add(sessionId)
    g.states.add(state)
  }
  for (const e of open) addToGroups(e.titleKey, e.sessionId, e.state)

  // ── P14.2: pisahkan kandidat intent ─────────────────────────────────────
  // (1) plan step dengan taskId yang task-nya OPEN → diwakili task kanonik,
  //     bukan item duplikat (bukti menempel di entry.planSteps);
  // (2) plan step dengan taskId yang task-nya TERMINAL → TIDAK dihidupkan
  //     kembali (larangan P14); masuk closure INTENT dengan konflik klaim
  //     plan vs status kanonik yang diungkapkan eksplisit;
  // (3) sisanya (approval menunggu/ditolak, delegasi, run terputus, langkah
  //     plan tanpa task / baris task hilang) → open bila non-terminal,
  //     closure bila terminal.
  const openIntent: IntentCandidate[] = []
  const closedIntentCandidates: IntentCandidate[] = []
  const supersededPlanClaims: {
    candidate: IntentCandidate
    taskStatus: TaskStatus
    taskUpdatedAt: string
    verified: boolean
  }[] = []
  for (const c of candidates) {
    if (c.source === "PLAN_STEP" && c.provenance.taskId !== null) {
      const task = store.getTask(c.sessionId, c.provenance.taskId)
      if (task !== null) {
        // Klaim plan menunjuk task kanonik yang ADA → task adalah otoritas.
        if (!TERMINAL_STATUSES.has(task.status)) {
          continue // (1) task masih open: entry task mewakili, bukti di planSteps
        }
        // (2) task terminal: jangan hidupkan kembali; ungkap konflik klaim.
        supersededPlanClaims.push({
          candidate: c,
          taskStatus: task.status,
          taskUpdatedAt: task.updatedAt,
          verified: task.verification?.verdict === "passed",
        })
        continue
      }
      // Baris task hilang: klaim plan tetap bukti terstruktur, dilanjutkan
      // dengan state dari plan step itu sendiri (jujur, tanpa menebak).
    }
    if (c.terminal) closedIntentCandidates.push(c)
    else openIntent.push(c) // (3)
  }
  // Kandidat intent open juga masuk peta grup duplikat.
  for (const c of openIntent) addToGroups(normalizeTitleKey(c.summary), c.sessionId, c.state)

  const duplicateGroups: DuplicateGroupRef[] = [...groupAgg.entries()]
    .filter(([, v]) => v.count > 1)
    .map(([key, v]) => ({
      key,
      count: v.count,
      sessions: [...v.sessions].sort(),
      divergentStates: v.states.size > 1,
      proven: false as const,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const duplicateByKey = new Map(duplicateGroups.map((g) => [g.key, g]))
  // Entri bersifat readonly: hubungkan grup duplikat lewat pemetaan baru,
  // bukan mutasi properti (proyeksi tidak pernah mengubah apa pun setelah
  // konstruksi — konsisten dengan kontrak kemurniannya).
  const openWithDuplicates: readonly OpenWorkEntry[] = open.map((e) =>
    e.titleKey.length > 0 && duplicateByKey.has(e.titleKey)
      ? { ...e, duplicate: duplicateByKey.get(e.titleKey) ?? null }
      : e,
  )
  const conflicts = duplicateGroups.filter((g) => g.divergentStates).length

  // ── closure feedback (P14.6) ─────────────────────────────────────────────
  // Task-based: hanya item dengan provenance P14 (ledger transfer/merge);
  // closure feedback adalah jawaban atas "pekerjaan yang diadopsi/didedup —
  // sudah tertutupkah?", bukan daftar seluruh task terminal yang pernah ada.
  // Intent-based: artefak terstruktur yang eksplisit terminal, DENGAN label
  // klaim (verified/unverified/not-applicable) supaya klaim penyelesaian
  // tanpa verifikasi tidak pernah tampil seolah-olah terbukti.
  const closed: ClosedWorkEntry[] = []
  if (opts.includeClosed === true) {
    const inScope = (sessionId: string): boolean =>
      opts.sessionId === undefined || sessionId === opts.sessionId

    const transfers: readonly TaskTransfer[] = store
      .listTaskTransfers()
      .filter((t) => inScope(t.toSessionId))
    for (const t of transfers) {
      const task = store.getTask(t.toSessionId, t.taskId)
      if (task !== null && !TERMINAL_STATUSES.has(task.status)) continue
      closed.push({
        kind: "TRANSFERRED",
        sessionId: t.toSessionId,
        taskId: t.taskId,
        title: task?.title ?? null,
        status: task?.status ?? "MISSING",
        closedAt: task?.updatedAt ?? null,
        revision: task?.revision ?? null,
        transferredFromSessionId: t.fromSessionId,
        transferredAt: t.transferredAt,
        mergeSurvivorId: null,
        mergeEvidence: null,
        intentState: null,
        claim:
          task === null
            ? "not-applicable"
            : task.status === "CANCELLED"
              ? "not-applicable"
              : task.verification?.verdict === "passed"
                ? "verified"
                : "unverified",
        reason:
          task === null
            ? "task row removed after transfer (ledger is the evidence)"
            : `canonical status ${task.status}`,
      })
    }

    const merges: readonly TaskMerge[] = store.listTaskMerges().filter((m) => inScope(m.sessionId))
    for (const m of merges) {
      const dup = store.getTask(m.sessionId, m.duplicateId)
      // Duplikat yang dibuka kembali operator TIDAK masuk daftar closed —
      // ia jujur muncul kembali di seksi open. Ledger tetap memuat
      // deklarasi lama sebagai sejarah audit.
      if (dup !== null && !TERMINAL_STATUSES.has(dup.status)) continue
      closed.push({
        kind: "MERGED_DUPLICATE",
        sessionId: m.sessionId,
        taskId: m.duplicateId,
        title: dup?.title ?? null,
        status: dup?.status ?? "MISSING",
        closedAt: dup?.updatedAt ?? m.mergedAt,
        revision: dup?.revision ?? m.duplicateRevision,
        transferredFromSessionId: null,
        transferredAt: null,
        mergeSurvivorId: m.survivorId,
        mergeEvidence: m.evidence,
        intentState: null,
        claim: "not-applicable",
        reason: `duplicate of ${m.survivorId}: ${m.evidence}`,
      })
    }

    // Klaim plan yang tersapu status kanonik terminal — konflik diungkap, tidak
    // disembunyikan, dan TIDAK menghidupkan kembali apa pun (larangan P14).
    for (const s of supersededPlanClaims) {
      closed.push({
        kind: "INTENT",
        sessionId: s.candidate.sessionId,
        taskId: s.candidate.provenance.taskId,
        title: s.candidate.summary,
        status: s.taskStatus,
        closedAt: s.taskUpdatedAt,
        revision: null,
        transferredFromSessionId: null,
        transferredAt: null,
        mergeSurvivorId: null,
        mergeEvidence: null,
        intentState: s.taskStatus === "COMPLETED" ? "COMPLETED" : "CANCELLED",
        claim:
          s.taskStatus === "CANCELLED" ? "not-applicable" : s.verified ? "verified" : "unverified",
        reason: `canonical task ${s.taskStatus} supersedes plan claim (${s.candidate.reason})`,
      })
    }

    // Artefak intent yang eksplisit terminal (approval DECLINED, plan step
    // completed/cancelled tanpa task, delegasi dengan hasil terminal).
    for (const c of closedIntentCandidates) {
      if (!inScope(c.sessionId)) continue
      closed.push({
        kind: "INTENT",
        sessionId: c.sessionId,
        taskId: c.provenance.taskId,
        title: c.summary,
        status: null,
        closedAt: c.observedAtIso,
        revision: null,
        transferredFromSessionId: null,
        transferredAt: null,
        mergeSurvivorId: null,
        mergeEvidence: null,
        intentState: c.state,
        claim: c.state === "COMPLETED" ? "unverified" : "not-applicable",
        reason: c.reason,
      })
    }

    closed.sort((a, b) => {
      const at = toMs(a.closedAt ?? "")
      const bt = toMs(b.closedAt ?? "")
      if (at !== bt) return bt - at
      if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1
      const atid = a.taskId ?? ""
      const btid = b.taskId ?? ""
      return atid < btid ? -1 : atid > btid ? 1 : 0
    })
  }

  // ── inventaris P14.0 (hanya bila diminta — membaca lebih banyak sumber) ──
  let inventory: WorkInventory | null = null
  if (opts.includeInventory === true) {
    const allTasks = store.listAllTasks()
    const openCount = store.listUnfinishedWork().length
    const sessionScopes = classifySessionScopes(workspace, workSessions)
    let sessionsWithManifest = 0
    let checkpointEntries = 0
    let corruptManifests = 0
    for (const s of workSessions) {
      if (sessionScopes.get(s.id) !== "IN_SCOPE") continue
      const cp = readCheckpointInventorySync(s.id, opts.cwd)
      if (!cp.exists) continue
      sessionsWithManifest++
      if (cp.corrupt) {
        corruptManifests++
        continue
      }
      checkpointEntries += cp.checkpointCount
    }
    inventory = buildWorkInventory({
      workspace,
      sessions: workSessions,
      events: eventLoad.events,
      runs: workRuns,
      candidates,
      taskCounts: {
        total: allTasks.length,
        open: openCount,
        terminal: allTasks.length - openCount,
      },
      checkpoints: {
        sessionsWithManifest,
        entries: checkpointEntries,
        corrupt: corruptManifests,
      },
    })
  }

  return {
    generatedAtIso: new Date(now).toISOString(),
    staleMs,
    open: openWithDuplicates,
    intent: openIntent,
    duplicateGroups,
    closed,
    inventory,
    rejectedEvents,
    counts: {
      open: open.length,
      stale: open.filter((e) => e.stale).length,
      unknownProvenance: open.filter((e) => e.provenance === "SESSION_MISSING").length,
      similarGroups,
      closed: closed.length,
      intent: openIntent.length,
      duplicateGroups: duplicateGroups.length,
      conflicts,
    },
  }
}
