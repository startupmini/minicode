// P13.2 — Supervision proses: SATU jalur ownership proses milik runtime.
//
// Kenapa berkas ini ada: P13.1 mengunci KONTRAK status runtime, tapi belum
// ada SATU tempat yang memiliki proses anak milik runtime. Tiap subsystem
// menggulirkan cara kill-nya sendiri (bash.ts killTree, mcp/transport.ts,
// lsp/client.ts), sehingga "tidak ada child process yang terlepas" mustahil
// dibuktikan dan crash bisa meninggalkan yatim.
//
// Batas yang dikunci:
// - Modul ini TIDAK menjalankan proses (guard arsitektur G10: hanya M5 boleh
//   spawn). Ia MEMILIKI daftar anak, MEMUTUSKAN recovery bounded, dan
//   MENGAWAT cleanup saat shutdown.
// - Bukan process management OS-wide: yang dikelola hanya anak yang runtime
//   ini spawn/miliki. Tak ada apa pun di luar runtime ini yang disentuh.
// - Pemulihan task durable = P13.3. Modul ini tak pernah mengulang kerja
//   pengguna: restart HANYA untuk anak yang restart-nya tak bisa mengulang efek
//   samping (restartSafety === "safe"). Anak "unsafe" di-eskalasi jujur, bukan
//   direstart.
// - Tak ada antrean durable dan bukan task store kedua: TaskStore tetap
//   otoritas task.
//
// Policy TAK dikarang di sini: percobaan/backoff/eskalasi memakai kembali
// SupervisionPolicy (supervisor.ts) dan nextBackoffMs().

import { nextBackoffMs, type SupervisionPolicy } from "./supervisor.ts"

/**
 * Whether restarting this child can repeat a user-visible side effect.
 *
 * "safe"    — restarting cannot replay user work (e.g. a helper server that
 *             only answers requests). Bounded restart is allowed.
 * "unsafe"  — restarting could repeat work (e.g. a background command). It is
 *             NEVER auto-restarted; the supervisor escalates instead.
 */
export type ManagedChildRestartSafety = "safe" | "unsafe"

/** Observation of one managed child (physical observation, not a lifecycle decision). */
export interface ManagedChildObservation {
  readonly status: "running" | "exited" | "failed" | "unknown"
  readonly exitCode?: number | null
  readonly detail?: string
}

/**
 * Port of a managed child.
 *
 * The registrar (the layer that spawns the process) implements this; the
 * runtime only observes, decides recovery, and awaits cleanup. That keeps the
 * runtime free of process execution while still being the single owner.
 */
export interface ManagedChild {
  /** Stable id (used as the recovery key). */
  readonly id: string
  /** Kind of child (diagnostic only, e.g. "lsp-server"). */
  readonly kind: string
  /** Whether an automatic restart may repeat user work. */
  readonly restartSafety: ManagedChildRestartSafety
  /** Current physical observation. */
  observe(): ManagedChildObservation
  /** Stop the child and wait until it is gone (best effort, must not throw). */
  stop(reason: string): Promise<void>
  /** Start the child again. Only called when restartSafety === "safe". */
  restart?(): Promise<void>
}

/** Truthful snapshot of the supervision state. */
export interface ProcessSupervisionStatus {
  /** The supervision path is attached to this runtime. */
  readonly attached: boolean
  /** Number of children currently registered. */
  readonly managed: number
  /** Successful bounded restarts performed. */
  readonly restarts: number
  /** Number of truthful escalations (recovery gave up). */
  readonly escalations: number
  /** Last escalation reason (diagnostic, no secrets). */
  readonly lastEscalation: string | null
  /**
   * True while the supervision is operational. False after an escalation —
   * a runtime whose supervision gave up must not claim it is supervised.
   */
  readonly operational: boolean
}

/** The single process-ownership path of a runtime. */
export interface ProcessSupervision {
  /** Register (or replace) a managed child. */
  register(child: ManagedChild): void
  /**
   * Report that a child exited unexpectedly. Resolves when the recovery
   * attempt (restart + backoff) has finished. Never throws.
   */
  notifyExit(childId: string, observation: ManagedChildObservation): Promise<void>
  /** Stop every registered child and await the cleanup. */
  shutdown(): Promise<{ stopped: number; failed: number }>
  /** Truthful snapshot. */
  status(): ProcessSupervisionStatus
}

export interface ProcessSupervisionOptions {
  /** Existing supervision policy (attempts, backoff, intensity, escalation wait). */
  readonly policy?: SupervisionPolicy
  /** Clock (injected for deterministic tests). */
  readonly now?: () => number
  /** Sleeper (injected for deterministic tests — the backoff must be awaitable). */
  readonly sleep?: (ms: number) => Promise<void>
  /** Upper bound of managed children (guards against unbounded registries). */
  readonly maxManagedChildren?: number
}

const DEFAULT_MAX_MANAGED_CHILDREN = 64

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

/**
 * Create the runtime's process-ownership path.
 *
 * Recovery is BOUNDED twice, using the existing policy:
 * - `maxAttempts` — consecutive restart attempts per child.
 * - `maxIntensity` within `intensityWindowMs` — a flapping child is escalated
 *   instead of being restarted forever.
 */
export function createProcessSupervision(opts: ProcessSupervisionOptions = {}): ProcessSupervision {
  const policy = opts.policy ?? {}
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const maxManagedChildren = opts.maxManagedChildren ?? DEFAULT_MAX_MANAGED_CHILDREN

  const children = new Map<string, ManagedChild>()
  /** Percobaan restart berurutan per anak (dibuang bila anak lama sehat). */
  const attempts = new Map<string, number>()
  /** Waktu keluar terakhir per anak — dasar untuk reset anggaran percobaan. */
  const lastExitAt = new Map<string, number>()
  /** Exit timestamps per child, for the intensity window. */
  const exits = new Map<string, number[]>()
  /** Children whose recovery was given up — they are no longer restarted. */
  const escalated = new Set<string>()

  let restarts = 0
  let escalationCount = 0
  let lastEscalation: string | null = null
  let shuttingDown = false

  const escalate = (child: ManagedChild, reason: string): void => {
    escalated.add(child.id)
    escalationCount += 1
    lastEscalation = `${child.kind}:${child.id}: ${reason}`
  }

  const inIntensityWindow = (childId: string, at: number): boolean => {
    const windowMs = policy.intensityWindowMs ?? 60_000
    const max = policy.maxIntensity ?? 5
    const stamps = (exits.get(childId) ?? []).filter((t) => at - t < windowMs)
    stamps.push(at)
    exits.set(childId, stamps)
    return stamps.length > max
  }

  const notifyExit = async (
    childId: string,
    observation: ManagedChildObservation,
  ): Promise<void> => {
    const child = children.get(childId)
    if (!child) return
    // Shutdown is not an "unexpected exit" — the owner asked for the stop.
    if (shuttingDown) return
    if (escalated.has(child.id)) return

    const at = now()
    // Anggaran percobaan bersifat "burst": anak yang sudah lama sehat (keluar
    // terakhirnya di luar window) mendapat anggaran BARU. Tanpa ini, anak
    // yang mati sekali sebulan akan kehabisan anggaran setelah tiga kali —
    // dan kehabisan anggaran berarti tak pernah lagi disupervisi.
    const windowMs = policy.intensityWindowMs ?? 60_000
    const previousExit = lastExitAt.get(child.id)
    if (previousExit === undefined || at - previousExit > windowMs) attempts.set(child.id, 0)
    lastExitAt.set(child.id, at)

    const attempt = (attempts.get(child.id) ?? 0) + 1
    attempts.set(child.id, attempt)
    // Observasi fisik ikut dibawa ke pesan eskalasi (kode keluar = bukti, bukan
    // tebakan) — tapi TIDAK jadi keputusan: keputusan diambil dari policy.
    const observed = `exit=${observation.exitCode ?? "?"} status=${observation.status}`

    const maxAttempts = policy.maxAttempts ?? 3
    if (attempt > maxAttempts) {
      escalate(child, `restart attempts exhausted (${maxAttempts}) · ${observed}`)
      return
    }
    if (inIntensityWindow(child.id, at)) {
      escalate(child, `restart intensity exceeded · ${observed}`)
      return
    }
    if (child.restartSafety !== "safe") {
      // NEVER auto-restart a child whose restart could repeat user work.
      escalate(
        child,
        `restart unsafe (would repeat side effects) — escalated, not restarted · ${observed}`,
      )
      return
    }
    if (!child.restart) {
      escalate(child, `child cannot be restarted · ${observed}`)
      return
    }

    const delay = nextBackoffMs(attempt, policy)
    try {
      await sleep(delay)
    } catch {
      // Sleeper failure is not a child failure — do not escalate on it.
      return
    }
    try {
      await child.restart()
      restarts += 1
    } catch (e) {
      // Restart yang GAGAL = jalur pemulihan rusak (bukan anak yang lagi
      // flapping). Eskalasi SEKARANG: diam-diam mencoba lagi hanya menyembunyikan
      // breakage sampai kehabisan waktu.
      escalate(child, `restart failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    register(child: ManagedChild): void {
      if (!child || typeof child.id !== "string" || child.id.length === 0) return
      if (!children.has(child.id) && children.size >= maxManagedChildren) {
        // Anak tak boleh didaftarkan lewat batas: anak tanpa pemilik adalah
        // persis "child yang terlepas" yang modul ini ada untuk mencegahnya.
        // Penolakan ini DIKABARKAN lewat eskalasi, bukan diam-diam.
        escalate(child, `managed child limit reached (${maxManagedChildren})`)
        return
      }
      children.set(child.id, child)
      if (!attempts.has(child.id)) attempts.set(child.id, 0)
    },

    notifyExit,

    async shutdown(): Promise<{ stopped: number; failed: number }> {
      shuttingDown = true
      let stopped = 0
      let failed = 0
      for (const child of [...children.values()]) {
        try {
          await child.stop("runtime shutdown")
          stopped += 1
        } catch {
          failed += 1
        }
      }
      children.clear()
      attempts.clear()
      lastExitAt.clear()
      exits.clear()
      return { stopped, failed }
    },

    status(): ProcessSupervisionStatus {
      return {
        attached: true,
        managed: children.size,
        restarts,
        escalations: escalationCount,
        lastEscalation,
        operational: escalationCount === 0,
      }
    },
  }
}
