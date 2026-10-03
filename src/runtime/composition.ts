// M14 — Runtime composition root: BUILD + WIRE, bukan decide/mutate/recover.
//
// Kenapa berkas ini ada (P1 M14): M1–M13 dibangun per-modul dan "prepared but
// controlled" — lengkap + teruji, tapi belum dirangkai menjadi SATU runtime.
// Modul ini adalah rangkaiannya: satu host, satu kernel, satu plane, satu
// journal, satu supervisor, satu bridge, satu recovery — dirangkai dengan
// kepemilikan eksplisit, tanpa otoritas kedua dan tanpa mengubah siapa pun.
//
// Batas yang dikunci (jangan dilonggarkan tanpa ADR baru):
// - Composition = construct + connect. Ia TIDAK memutuskan, TIDAK memutasi
//   lifecycle di luar port yang sudah ada, TIDAK menafsirkan recovery, TIDAK
//   mengeksekusi backend, TIDAK menyentuh policy/scheduler/task/session/UI.
//   Semua keputusan tetap milik modul asalnya (M8/M9/M12/M13/M5).
// - Session != Runtime Host != Execution. Modul ini tidak punya konsep sesi
//   yang bisa mengubah state sesi; ia hanya membawa sessionId sebagai label.
// - SATU komposisi = SATU dunia. Tidak ada singleton global, tidak ada state
//   mutable di module scope: dua komposisi (session/workspace berbeda) tidak
//   mungkin saling melihat event, jurnal, atau dispatch satu sama lain.
// - Journal path EKSPLISIT dari caller. Tidak ada default global dan tidak ada
//   penoran dari acak: resume berarti caller memberikan path yang SAMA.
// - Journal wajib secara default (fail-closed): open gagal = konstruksi gagal.
//   "Tak ada jurnal" hanya boleh terjadi bila mode non-durable diminta eksplisit.
//
// === MODEL SHUTDOWN (satu-satunya urutan; lihat runShutdown) ===
//
//   admission latch  ->  host.shutdown()  ->  execution drain
//   ->  event delivery drain  ->  journal.flush()  ->  journal.close()
//   ->  host.close()  ->  (pemanggil: session/UI detach)
//
// Kenapa urutan itu, berdasarkan kepemilikan yang BENAR-BENAR ada (bukan nama):
// - Latch admission milik composition (satu boolean monoton). Port admission
//   mengeceknya LEBIH DALAM dari hostState M13, jadi penolakan tetap deterministik
//   walau host masih READY (jeda antara latch dan host.shutdown() adalah async).
// - host.shutdown() = latch admitting/run + hook onShutdown milik PEMILIK. Hook
//   itu adalah tempat owner menghentikan produsen event; karena itu hook berjalan
//   SEBELUM drain/flush, bukan sesudah.
// - Execution drain = menunggu kerja in-flight yang DIDAFTARKAN runtime (track())
//   (track()). Executions non-terminal yang TIDAK dilacak TIDAK ditulis ulang:
//   shutdown tak pernah mengarang COMPLETED; ia melapor, dan M12 yang menafsirkan.
// - Event delivery drain: M10 emit() sepenuhnya sinkron (tak ada antrean), jadi
//   satu-satunya pengiriman async adalah append M11. Drain menunggu append yang
//   masih jalan, termasuk yang muncul selama drain itu sendiri.
// - journal.flush() setelah drain: inilah batas durability. Setelah flush, hook
//   berhenti append (barrier) — sehingga tak ada append SETELAH flush, dan
//   Pastinya tak ada reopen yang diam-diam.
// - journal.close() sesudah flush: bukti durable sudah dicatat; gagalnya close
//   tak boleh membatalkan bukti itu.
// - host.close() TERAKHIR: host tak memegang jurnal, jadi menutupnya lebih dulu
//   hanya menambah cara kegagalan membatalkan batas durability. Hook onClose yang
//   melempar dilaporkan eksplisit (tidak ditelan) lewat RuntimeShutdownResult.
//
// BUKAN FSM kedua: composition tak punya state machine lifecycle. Authority
// lifecycle tetap RuntimeHost (CREATED/STARTING/READY/DRAINING/CLOSING/CLOSED);
// latch composition cuma menjawab satu pertanyaan monoton: "admission masih
// dibuka?" — true lalu false, tak pernah kembali true.
//
// drainTimeoutMs = batas DRAIN saja (tak memaksa hasil jadi "sukses"): drain
// yang tak tuntas dilaporkan sebagai "uncertain", bukan dipoles jadi hijau.

import {
  createDispatchBridge,
  type DispatchBridge,
  type DispatchMetrics,
  type DispatchRefresh,
  type DispatchRequest,
} from "./dispatch.ts"
import { BACKEND_FACTORIES, type BackendKind, type ExecutionBackend } from "./execution-backend.ts"
import {
  createEventPlane,
  type EventPlane,
  type EventPlaneMetrics,
  type EventSource,
  executionEventFromCommit,
} from "./execution-events.ts"
import {
  type CheckpointResult,
  type ExecutionJournal,
  type FlushResult,
  type JournalMetrics,
  type JournalRecord,
  openExecutionJournal,
} from "./execution-journal.ts"
import {
  createExecutionKernel,
  type ExecutionKernel,
  type ExecutionState,
  isExecutionTerminalState,
  type KernelMetrics,
  type TransitionRequestSource,
} from "./execution-kernel.ts"
import {
  createRecoveryEngine,
  type RecoveryContext,
  type RecoveryEngine,
  type RecoveryResult,
} from "./recovery.ts"
import {
  createRuntimeHost,
  type HostLifecycleState,
  type RuntimeHost,
  type RuntimeHostOptions,
} from "./runtime-host.ts"
import { createSupervisor, type SupervisionPolicy, type Supervisor } from "./supervisor.ts"

export interface RuntimeCompositionOptions {
  /**
   * Label identitas sesi. Diteruskan apa adanya — TIDAK PERNAH diturunkan dari
   * acak di sini: identitas itu milik caller, dan resume harus memakai identitas
   * lama, bukan identitas pengganti.
   */
  readonly sessionId: string
  /** Workspace tempat runtime ini hidup (informasi; batas tetap milik policy). */
  readonly workspaceCwd: string
  /**
   * Path jurnal durable. WAJIB eksplisit: caller yang tahu storage-nya
   * (resume = path yang sama; sesi baru = path sendiri per workspace).
   */
  readonly journalPath: string
  /** Backend fisik (default "host" — backend yang sama dengan proses CLI). */
  readonly backend?: BackendKind
  /**
   * Fail-closed bila jurnal tak bisa dibuka (default). `false` = mode
   * non-durable eksplisit: TANPA jurnal, history restart hilang, dan
   * `recover()` hanya bisa membaca apa yang ada di memori.
   */
  readonly journalRequired?: boolean
  /** Batas drain (ms; default 5000). Drain tak tuntas = "uncertain", bukan hijau. */
  readonly drainTimeoutMs?: number
  readonly supervisorPolicy?: SupervisionPolicy
  readonly now?: () => number
  /**
   * Seam/test hook milik M3 (onShutdown/onClose). Composition tetap memanggil
   * API publik host — tak ada mutasi state internal dari sini. Produksi tak
   * mengeset ini; test memakainya untuk membuktikan fase drain dan kegagalan
   * host.close() tidak merusak batas jurnal.
   */
  readonly hostOptions?: RuntimeHostOptions
  /**
   * Seam checkpoint M11 (passthrough). M11 sendiri menandainya sebagai seam uji;
   * di sini hanya diteruskan agar "durability-uncertain" bisa dibuktikan tanpa
   * mencoret kontrak M11.
   */
  readonly journalCheckpoint?: () => CheckpointResult
}

export interface RuntimeFlushReport {
  readonly journal: FlushResult["status"] | "disabled"
  /** Append yang sudah selesai pada drain ini. */
  readonly drained: number
  /** Append yang MASIH jalan saat batas drain tercapai (dilaporkan, bukan didiamkan). */
  readonly unfinished: number
}

/** Fase shutdown berurutan. Urutan = urutan eksekusi. */
export type RuntimeShutdownPhase =
  | "admission-latch"
  | "host-shutdown"
  | "execution-drain"
  | "event-drain"
  | "journal-flush"
  | "journal-close"
  | "host-close"

/** Empat kondisi berbeda — tak semuanya "gagal", tak semuanya "sukses". */
export type RuntimeShutdownOutcome = "succeeded" | "uncertain" | "failed" | "skipped"

export interface RuntimeShutdownPhaseReport {
  readonly phase: RuntimeShutdownPhase
  readonly outcome: RuntimeShutdownOutcome
  /** Detail ringkas untuk diagnosis (tanpa isi error yang bisa membocorkan data). */
  readonly detail?: string
}

export interface RuntimeShutdownError {
  readonly phase: RuntimeShutdownPhase
  readonly error: unknown
}

/** Eksekusi non-terminal milik runtime ini — dilaporkan, TAK PERNAH ditulis ulang. */
export interface OutstandingExecution {
  readonly executionId: string
  readonly state: ExecutionState
}

export interface RuntimeShutdownResult {
  /** True hanya bila tak ada fase "failed" (uncertain tetap.ok = true). */
  readonly ok: boolean
  readonly phases: readonly RuntimeShutdownPhaseReport[]
  readonly errors: readonly RuntimeShutdownError[]
  /** Latch admission sudah tertutup (monoton, tak pernah dibuka lagi). */
  readonly admissionStopped: boolean
  /** Non-terminal saat latch menutup (potret sebelum drain). */
  readonly outstandingBefore: readonly OutstandingExecution[]
  /** Non-terminal setelah barrier drain — inilah yang M12 tafsirkan nanti. */
  readonly outstandingAfter: readonly OutstandingExecution[]
  readonly trackedWork: {
    readonly registered: number
    readonly drained: number
    readonly pending: number
  }
  readonly events: {
    readonly drained: number
    readonly pending: number
    /** Event yang tiba SETELAH batas flush: ditolak eksplisit, tak pernah di-append. */
    readonly rejectedAfterBarrier: number
  }
  readonly journal: {
    readonly flush: FlushResult["status"] | "disabled"
    readonly closed: boolean
  }
  readonly host: { readonly state: HostLifecycleState }
}

export interface RuntimeCompositionMetrics {
  readonly closed: boolean
  readonly admissionOpen: boolean
  readonly host: ReturnType<RuntimeHost["metrics"]>
  readonly kernel: KernelMetrics
  readonly plane: EventPlaneMetrics
  readonly journal: JournalMetrics | null
  readonly bridge: DispatchMetrics
  /** Append jurnal yang gagal/tidak terrekam (observasi, bukan keputusan). */
  readonly journalAppendFailures: number
  readonly pendingAppends: number
  readonly trackedWork: number
  readonly rejectedEventsAfterBarrier: number
}

export interface RuntimeComposition {
  readonly sessionId: string
  readonly workspaceCwd: string
  /** Path yang diberikan caller; `journal` null berarti mode non-durable. */
  readonly journalPath: string
  readonly durable: boolean
  readonly host: RuntimeHost
  readonly kernel: ExecutionKernel
  readonly plane: EventPlane
  readonly journal: ExecutionJournal | null
  readonly supervisor: Supervisor
  readonly bridge: DispatchBridge
  readonly recovery: RecoveryEngine
  readonly backend: ExecutionBackend
  /** Jalur admission tunggal: Scheduler/Recovery → M13 → composition ini. */
  dispatch(
    request: DispatchRequest,
    refresh?: DispatchRefresh,
  ): ReturnType<DispatchBridge["dispatch"]>
  /** Interpretasi evidence dari jurnal (M12); tidak menulis apa pun. */
  recover(executionId: string, ctx: RecoveryContext): RecoveryResult
  /**
   * Daftarkan kerja in-flight milik runtime untuk eksekusi ini. Drain menunggu
   * semua work terdaftar (bounded) sebelum event drain/flush. Wajib untuk execution
   * yang boleh settle natural saat shutdown — tanpa ini, drain tak punya hak untuk menggantungkan diri (dan M12 yang menafsirkan
   * eksekusi yang belum terminal). Returns untrack (idempoten).
   */
  track(executionId: string, work: Promise<unknown>): () => void
  /** Non-terminal milik runtime ini (observasi, bukan keputusan lifecycle). */
  outstanding(): readonly OutstandingExecution[]
  isAdmissionOpen(): boolean
  flush(): Promise<RuntimeFlushReport>
  /**
   * Shutdown kanonik: admission latch → drain → flush → close, dengan hasil
   * terstruktur. IDEMPOTEN dan CONCURRENCY-SAFE: panggilan kedua/menyejeng
   * menerima promise & hasil yang SAMA (tak ada flush/close ganda).
   */
  shutdown(): Promise<RuntimeShutdownResult>
  /** Alias; hasil identik dengan shutdown() (satu lifecycle, bukan dua). */
  close(): Promise<RuntimeShutdownResult>
  /** Hasil shutdown terakhir, atau null bila belum ada. */
  shutdownResult(): RuntimeShutdownResult | null
  isClosed(): boolean
  metrics(): RuntimeCompositionMetrics
}

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000

/**
 * [P1 M15] Intent id durable untuk satu keputusan dispatch.
 *
 * Satu fungsi, satu format — dipakai penulis (runner) DAN pembaca (dedupe M13),
 * supaya "saya sudah menulis bukti" dan "saya melihat bukti itu" tak pernah
 * berbeda definisi.
 */
export function dispatchIntentId(dispatchId: string): string {
  return `dispatch:${dispatchId}`
}

/**
 * Sumber kernel → label event M10. Pemetaan TIDAK bijective dan itu disengaja:
 * label yang tak ada padanannya jatuh ke "kernel" (label committer yang benar)
 * alih-alih mengarang label yang menyiratkan asal lain. Provenance asli tetap
 * di record kernel + journal (lihat catatan di kepala berkas).
 */
function eventSourceFor(source: TransitionRequestSource): EventSource {
  switch (source) {
    case "host":
    case "scheduler":
    case "backend":
    case "agent-loop":
    case "supervisor":
    case "test":
      return source === "agent-loop" ? "agent" : source
    default:
      return "kernel"
  }
}

interface TrackedWork {
  readonly executionId: string
  readonly promise: Promise<unknown>
  settled: boolean
  error: unknown
}

export function createRuntimeComposition(opts: RuntimeCompositionOptions): RuntimeComposition {
  // ── validasi identitas (fail-closed; tak ada tebakan) ──────────────────────
  if (!opts || typeof opts !== "object") throw new Error("composition: options object is required")
  if (typeof opts.sessionId !== "string" || opts.sessionId.length === 0)
    throw new Error("composition: sessionId is required and must not be derived here")
  if (typeof opts.workspaceCwd !== "string" || opts.workspaceCwd.length === 0)
    throw new Error("composition: workspaceCwd is required")
  if (typeof opts.journalPath !== "string" || opts.journalPath.length === 0)
    throw new Error("composition: journalPath is required (no global default)")
  if (opts.journalPath.includes("\0"))
    throw new Error("composition: journalPath must not contain NUL")

  const journalRequired = opts.journalRequired !== false
  const drainTimeoutMs =
    typeof opts.drainTimeoutMs === "number" && opts.drainTimeoutMs >= 0
      ? opts.drainTimeoutMs
      : DEFAULT_DRAIN_TIMEOUT_MS
  const now = opts.now ?? Date.now

  // ── konstruksi komponen (urutan = urutan ketergantungan) ──────────────────
  const backendKind = opts.backend ?? "host"
  const factory = BACKEND_FACTORIES[backendKind]
  if (!factory) throw new Error(`composition: unknown backend "${String(backendKind)}"`)
  const backend = factory()
  const plane = createEventPlane()
  const kernel = createExecutionKernel()
  const supervisor = createSupervisor({
    kernel,
    backend,
    ...(opts.supervisorPolicy ? { policy: opts.supervisorPolicy } : {}),
    now,
  })
  const recovery = createRecoveryEngine()
  const host = createRuntimeHost(opts.hostOptions ?? {})
  host.start()

  // ── journal (fail-closed) ──────────────────────────────────────────────────
  let journal: ExecutionJournal | null = null
  if (journalRequired) {
    journal = openExecutionJournal(
      opts.journalPath,
      opts.journalCheckpoint ? { checkpoint: opts.journalCheckpoint } : {},
    )
    if (!journal.isOpen()) {
      // Konstruksi gagal dan host tak boleh tertinggal READY di belakang objek
      // yang tak pernah dikembalikan. Nutup dulu, baru lempar.
      try {
        void host.shutdown()
      } catch {}
      try {
        void host.close()
      } catch {}
      throw new Error("composition: journal failed to open (fail-closed; no silent null journal)")
    }
  }

  // ── latch + barrier (satu boolean monoton; BUKAN state machine) ────────────
  let admissionOpen = true
  /** true setelah flush terakhir: hook berhenti append (tak ada append pasca-flush). */
  let durabilityBarrierPassed = false
  let rejectedAfterBarrier = 0

  /** Eksekusi yang runtime ini admit sendiri (satu-satunya lifecycle yang "dimiliki"). */
  const ownedExecutions = new Set<string>()
  const trackedWork = new Set<TrackedWork>()

  // ── kernel commit → plane (observasi) + journal (history) ─────────────────
  // Hook ini PASIF: ia tidak menolak, tidak memperbaiki, tidak memutar balik.
  // Kegagalan append = metrik + durability-uncertain saat flush, tak pernah
  // "hapus event supaya tampak bersih" (M11 yang memutuskan, bukan sini).
  const pendingAppends = new Set<Promise<unknown>>()
  // Penghitung eksplisit (bukan `pending.size`): urutan microtask `.finally`
  // tak perlu ditebak untuk tahu berapa append yang benar-benar mendarat.
  let settledAppends = 0
  let appendFailures = 0
  const unsubscribeKernel = kernel.onTransition((t) => {
    try {
      const record = kernel.get(t.executionId)
      const event = executionEventFromCommit(
        plane,
        {
          executionId: t.executionId,
          ...(record?.parentExecutionId ? { parentExecutionId: record.parentExecutionId } : {}),
          rootExecutionId: record?.rootExecutionId ?? t.executionId,
          version: record?.version ?? 0,
          from: t.from,
          to: t.to,
          reason: t.reason,
          source: t.source,
        },
        { source: eventSourceFor(t.source), timestamp: t.at },
      )
      // Barrier durability: setelah flush terakhir, event TIDAK di-append dan
      // jurnal tak pernah dibuka ulang. Dihitung eksplisit (bukan "hilang diam").
      if (durabilityBarrierPassed) {
        rejectedAfterBarrier++
        return
      }
      if (!journal) return
      const appended: Promise<unknown> = journal
        .appendEvent(event)
        .then((r) => {
          if (r.status === "error") appendFailures++
        })
        .catch(() => {
          appendFailures++
        })
        .then(() => {
          settledAppends++
        })
      pendingAppends.add(appended)
      void appended.finally(() => {
        pendingAppends.delete(appended)
      })
    } catch {
      // Observasi tak boleh menjatuhkan commit kernel yang sudah sah.
    }
  })

  // ── admission: SATU-SATUNYA jalan dari bridge ke runtime ───────────────────
  // admitted ⇔ kernel punya record ADMITTED. Gagal = reason jujur ke M13 supaya
  // state dispatch-nya benar (BLOCKED/REJECTED), bukan "sukses".
  // Latch diperiksa LEBIH DALAM dari hostState: jeda antara latch composition dan
  // host.shutdown() itu async, jadi satu-satunya cara Deterministik menutup
  // admission adalah memeriksa latch itu sendiri.
  const bridge = createDispatchBridge({
    admission: {
      admit: (req) => {
        if (!admissionOpen)
          return { admitted: false, reason: "runtime admission closed (shutdown latch)" }
        try {
          const record = kernel.create({
            executionId: req.executionId,
            ...(req.parentExecutionId ? { parentExecutionId: req.parentExecutionId } : {}),
            rootExecutionId: req.lineageRootId,
            kind: req.kind,
            ownerId: req.ownerId,
          })
          const result = kernel.requestTransition({
            executionId: record.executionId,
            to: "ADMITTED",
            reason: "dispatch-admission",
            source: "host",
          })
          if (!result.committed)
            return { admitted: false, reason: `kernel refused admission (${result.outcome})` }
          ownedExecutions.add(record.executionId)
          return { admitted: true, executionId: record.executionId }
        } catch (e) {
          return { admitted: false, reason: (e as Error).message.slice(0, 120) }
        }
      },
    },
    hostState: () => host.state(),
    // [P1 M15] Bukti durable untuk dedupe lintas-restart: M13 hanya memakai
    // jawaban "admitted" bila caller menyatakan redelivery (`redelivered: true`),
    // dan JURNAL M11 adalah satu-satunya sumber kebenaran itu. Tanpa lookup →
    // M13 jatuh ke UNCERTAIN_DUPLICATE (konservatif), bukan menebak.
    historyLookup: (dispatchId: string) => {
      if (!journal) return "unknown"
      return journal
        .readAll()
        .some((r) => r.kind === "intent" && r.intentId === dispatchIntentId(dispatchId))
        ? ("admitted" as const)
        : ("unknown" as const)
    },
    now,
  })

  let closed = false
  let shutdownPromise: Promise<RuntimeShutdownResult> | null = null
  let shutdownReport: RuntimeShutdownResult | null = null

  function outstanding(): OutstandingExecution[] {
    const out: OutstandingExecution[] = []
    for (const executionId of ownedExecutions) {
      const record = kernel.get(executionId)
      if (record && !isExecutionTerminalState(record.state))
        out.push({ executionId, state: record.state })
    }
    return out.sort((a, b) => (a.executionId < b.executionId ? -1 : 1))
  }

  /** Tunggu append yang jalan; ulangi bila append BARU muncul selama drain. */
  async function drainAppends(budgetMs: number): Promise<{ drained: number; pending: number }> {
    const settledBefore = settledAppends
    const deadline = Date.now() + budgetMs
    while (pendingAppends.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const batch = [...pendingAppends]
      let timer: ReturnType<typeof setTimeout> | undefined
      const bounded = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining)
        timer.unref?.()
      })
      await Promise.race([Promise.allSettled(batch).then(() => undefined), bounded])
      if (timer) clearTimeout(timer)
    }
    return { drained: settledAppends - settledBefore, pending: pendingAppends.size }
  }

  /** Tunggu kerja yang di-track runtime (bounded). Error kerja dikembalikan apa adanya. */
  async function drainTrackedWork(budgetMs: number): Promise<{
    registered: number
    drained: number
    pending: number
    errors: unknown[]
  }> {
    const entries = [...trackedWork]
    if (entries.length === 0) return { registered: 0, drained: 0, pending: 0, errors: [] }
    let timer: ReturnType<typeof setTimeout> | undefined
    const bounded = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs)
      timer.unref?.()
    })
    await Promise.race([
      Promise.allSettled(entries.map((e) => e.promise)).then(() => undefined),
      bounded,
    ])
    if (timer) clearTimeout(timer)
    const pendingEntries = entries.filter((e) => !e.settled)
    return {
      registered: entries.length,
      drained: entries.length - pendingEntries.length,
      pending: pendingEntries.length,
      errors: entries.map((e) => e.error).filter((e) => e !== null && e !== undefined),
    }
  }

  async function runShutdown(): Promise<RuntimeShutdownResult> {
    const phases: RuntimeShutdownPhaseReport[] = []
    const errors: RuntimeShutdownError[] = []
    const phase = (
      name: RuntimeShutdownPhase,
      outcome: RuntimeShutdownOutcome,
      detail?: string,
    ) => {
      phases.push({ phase: name, outcome, ...(detail !== undefined ? { detail } : {}) })
    }

    // ── 1. admission latch (monoton; inline, sebelum semua yang async) ────────
    admissionOpen = false
    phase("admission-latch", "succeeded", "admission closed (monotonic)")

    const outstandingBefore = outstanding()

    // ── 2. host.shutdown(): latch admitting/run + hook onShutdown (owner stop) ─
    const hookFailuresBefore = host.metrics().host.hookFailures
    try {
      await host.shutdown()
      const degraded = host.metrics().host.hookFailures > hookFailuresBefore
      phase(
        "host-shutdown",
        degraded ? "uncertain" : "succeeded",
        degraded
          ? "onShutdown hook failed (host degraded, stays DRAINING; journal still handled)"
          : `host=${host.state()}`,
      )
    } catch (e) {
      phase("host-shutdown", "failed", (e as Error).message.slice(0, 160))
      errors.push({ phase: "host-shutdown", error: e })
    }

    // ── 3. execution drain: kerja in-flight yang di-track + barrier ────────────
    // Eksekusi non-terminal TAK diubah state-nya di sini: shutdown tak pernah
    // mengarang COMPLETED/CANCELLED. Yang draining adalah kerja in-flight-nya.
    const tracked = await drainTrackedWork(drainTimeoutMs)
    if (tracked.errors.length > 0) {
      phase("execution-drain", "failed", `${tracked.errors.length} tracked work rejected`)
      for (const error of tracked.errors) errors.push({ phase: "execution-drain", error })
    } else if (tracked.pending > 0) {
      phase(
        "execution-drain",
        "uncertain",
        `${tracked.pending}/${tracked.registered} tracked work unfinished at ${drainTimeoutMs}ms`,
      )
    } else {
      phase(
        "execution-drain",
        "succeeded",
        `tracked=${tracked.registered} outstanding=${outstandingBefore.length}`,
      )
    }
    const outstandingAfter = outstanding()

    // ── 4. event delivery drain (M10 sinkron; M11 append async) ──────────────
    const events = await drainAppends(drainTimeoutMs)
    phase(
      "event-drain",
      events.pending > 0 ? "uncertain" : "succeeded",
      `drained=${events.drained} pending=${events.pending} rejectedAfterBarrier=${rejectedAfterBarrier}`,
    )

    // ── 5. barrier + journal flush = batas durability TERAKHIR ─────────────────
    // BARRIER DULU, sebelum flush(): dari titik ini tak ada append baru yang
    // mulai — sehingga mustahil ada event yang committed SETELAH batas
    // durability (data pascabatas = klaim palsu "durable-confirmed"). Jeda
    // antara drain dan baris ini sinkron, jadi tak ada user code yang bisa
    // menyisipkan commit di antaranya.
    durabilityBarrierPassed = true
    let flushStatus: FlushResult["status"] | "disabled" = "disabled"
    if (!journal) {
      phase("journal-flush", "skipped", "non-durable mode (no journal)")
    } else {
      const flushed = journal.flush()
      flushStatus = flushed.status
      const outcome: RuntimeShutdownOutcome =
        flushed.status === "durable-confirmed"
          ? "succeeded"
          : flushed.status === "durability-uncertain"
            ? "uncertain"
            : "failed"
      phase("journal-flush", outcome, flushed.status)
      if (flushed.status !== "durable-confirmed")
        errors.push({ phase: "journal-flush", error: flushed })
    }

    // ── 6. journal close (SATU pemilik: composition) ─────────────────────────
    let journalClosed = false
    if (!journal) {
      phase("journal-close", "skipped", "non-durable mode (no journal)")
    } else {
      try {
        journal.close()
        // M11 close() tak melempar (idempoten) → verifikasi via post-condition,
        // bukan "tidak ada exception = sukses".
        journalClosed = !journal.isOpen()
        phase(
          "journal-close",
          journalClosed ? "succeeded" : "failed",
          journalClosed ? "closed after flush" : "still open after close()",
        )
        if (!journalClosed)
          errors.push({
            phase: "journal-close",
            error: new Error("journal still open after close"),
          })
      } catch (e) {
        phase("journal-close", "failed", (e as Error).message.slice(0, 160))
        errors.push({ phase: "journal-close", error: e })
      }
    }

    // ── 7. host close TERAKHIR (host tak memegang jurnal; durability sudah aman) ─
    try {
      await host.close()
      phase(
        "host-close",
        host.state() === "CLOSED" ? "succeeded" : "failed",
        `host=${host.state()}`,
      )
      if (host.state() !== "CLOSED")
        errors.push({ phase: "host-close", error: new Error(`host not CLOSED (${host.state()})`) })
    } catch (e) {
      // Host M3 melempar bila hook onClose gagal — meski state sudah CLOSED.
      phase("host-close", "failed", (e as Error).message.slice(0, 160))
      errors.push({ phase: "host-close", error: e })
    }

    closed = true
    // Hook dilepas sebagai langkah TERAKHIR: commit selama drain tetap terekam
    // (append-nya ikut ter-drain di fase 4), sementara commit yang datang
    // sesudah barrier durability sudah ditolak eksplisit di atas (dihitung,
    // bukan dibuang diam-diam).
    try {
      unsubscribeKernel()
    } catch {}
    const result: RuntimeShutdownResult = Object.freeze({
      ok: !phases.some((p) => p.outcome === "failed"),
      phases: Object.freeze(phases.slice()),
      errors: Object.freeze(errors.slice()),
      admissionStopped: true,
      outstandingBefore: Object.freeze(outstandingBefore.slice()),
      outstandingAfter: Object.freeze(outstandingAfter.slice()),
      trackedWork: Object.freeze({
        registered: tracked.registered,
        drained: tracked.drained,
        pending: tracked.pending,
      }),
      events: Object.freeze({ ...events, rejectedAfterBarrier }),
      journal: Object.freeze({ flush: flushStatus, closed: journalClosed }),
      host: Object.freeze({ state: host.state() }),
    })
    shutdownReport = result
    return result
  }

  const api: RuntimeComposition = {
    sessionId: opts.sessionId,
    workspaceCwd: opts.workspaceCwd,
    journalPath: opts.journalPath,
    durable: journal !== null,

    host,
    kernel,
    plane,
    journal,
    supervisor,
    bridge,
    recovery,
    backend,

    dispatch(request, refresh) {
      if (!admissionOpen)
        throw new Error("composition: dispatch refused — admission latch closed (shutdown)")
      return bridge.dispatch(request, refresh)
    },

    recover(executionId, ctx) {
      // Bukti = history jurnal (M11), bukan state in-memory: interpretasi harus
      // bisa dilakukan ulang setelah restart dengan hasil yang sama.
      const records: readonly JournalRecord[] = journal
        ? journal.readExecutionHistory(executionId)
        : []
      return recovery.recoverExecution(executionId, records, ctx)
    },

    track(executionId: string, work: Promise<unknown>): () => void {
      if (!admissionOpen)
        throw new Error("composition: track() refused — admission latch closed (shutdown)")
      if (typeof executionId !== "string" || executionId.length === 0)
        throw new Error("composition: track() requires executionId")
      if (!work || typeof (work as Promise<unknown>).then !== "function")
        throw new Error("composition: track() requires a promise")
      const entry: TrackedWork = {
        executionId,
        settled: false,
        error: null,
        promise: Promise.resolve(work).then(
          () => {
            entry.settled = true
          },
          (e) => {
            entry.settled = true
            entry.error = e
          },
        ),
      }
      trackedWork.add(entry)
      return () => {
        trackedWork.delete(entry)
      }
    },

    outstanding,

    isAdmissionOpen: () => admissionOpen,

    async flush(): Promise<RuntimeFlushReport> {
      const drained = await drainAppends(drainTimeoutMs)
      if (!journal)
        return { journal: "disabled", drained: drained.drained, unfinished: drained.pending }
      const flushed = journal.flush()
      return {
        journal: flushed.status,
        drained: drained.drained,
        unfinished: drained.pending,
      }
    },

    shutdown(): Promise<RuntimeShutdownResult> {
      // Idempoten + concurrency-safe: satu promise untuk semua pemanggil, dan
      // tak ada flush/close kedua yang bisa balapan dengan yang pertama.
      if (!shutdownPromise) shutdownPromise = runShutdown()
      return shutdownPromise
    },

    close(): Promise<RuntimeShutdownResult> {
      return api.shutdown()
    },

    shutdownResult(): RuntimeShutdownResult | null {
      return shutdownReport
    },

    isClosed: () => closed,

    metrics: () => ({
      closed,
      admissionOpen,
      host: host.metrics(),
      kernel: kernel.metrics(),
      plane: plane.metrics(),
      journal: journal ? journal.metrics() : null,
      bridge: bridge.metrics(),
      journalAppendFailures: appendFailures,
      pendingAppends: pendingAppends.size,
      trackedWork: trackedWork.size,
      rejectedEventsAfterBarrier: rejectedAfterBarrier,
    }),
  }

  return api
}
