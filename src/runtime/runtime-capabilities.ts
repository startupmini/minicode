// P13.1 — Deklarasi kapabilitas runtime: SATU sumber kebenaran.
//
// Kenapa berkas ini ada: kapabilitas yang DIKLAIM harus berasal dari deklarasi
// eksplisit di lapisan runtime, dibaca daemon DAN CLI lewat simbol yang sama.
// Dua daftar = dua jawaban = bug yang tak terlihat (persis kelas dual-authority
// yang sudah dikejar di lapisan lain repo ini).
//
// BEDA dari M6 (`src/runtime/capability.ts`): M6 adalah izin EKSEKUSI per
// eksekusi (request → grant → approval, anak ⊆ parent). Yang di sini adalah
// pernyataan KETERSEDIAAN runtime — "apakah lapisan ini bisa doingkat SEKARANG",
// bukan "apakah operasi ini diizinkan". Mencampur keduanya menghasilkan
// "runtime punya kapabilitas" yang sebenarnya "eksekusi ini diizinkan".
//
// Batas yang disengaja (P13.1):
// - `process-supervision` ADA di kosakata tapi TIDAK boleh diiklankan. Supervisor
//   sekarang hanya dipakai untuk pembatalan eksekusi (`production-execution.ts`),
//   BELUM supervising proses anak (restart/retry/escalation) — itu milestone
//   P13.2. Mengiklankan sebelum attach = janji yang tak bisa dibuktikan.
// - TaskStore & Scheduler milik lapisan task (`src/task/`). Kapabilitas di sini
//   adalah PERNYATAAN KETERSEDIAAN, bukan klaim kepemilikan: otoritas task tetap
//   milik TaskStore, dan runtime tak pernah menulis task state sendiri.

/**
 * Kapabilitas runtime. Kosakata KANONIK: nilai di sini adalah satu-satunya
 * yang boleh dipakai di wire, di log, dan di status.
 */
export type RuntimeCapability =
  /** Jurnal eksekusi durable tersedia (history tak hilang saat restart). */
  | "durable-journal"
  /** TaskStore (otoritas task) terbuka dan bisa dipakai runtime ini. */
  | "durable-task-store"
  /** Scheduler terpasang — sumber dispatch kerja durable. */
  | "task-scheduler"
  /** Supervisor proses terpasang (P13.2+; belum diiklankan di P13.1). */
  | "process-supervision"

/** Semua kapabilitas yang MAYAKINI dikenal (bukan berarti semuanya diiklankan). */
export const RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = [
  "durable-journal",
  "durable-task-store",
  "task-scheduler",
  "process-supervision",
] as const

/**
 * Fakta PEMASANGAN (bukan flag niaga): apa yang benar-benar terpasang pada
 * runtime ini. Dipasok composition root dari handle nyata.
 *
 * `supervisor` sengaja `false` di P13.1 — tak ada yang memasang supervisor ke
 * jalur produksi, jadi mengiklankannya akan jadi kebohongan yang tak teruji.
 */
export interface RuntimeAttachment {
  /** Runtime dibangun dengan jurnal durable. */
  readonly journal: boolean
  /** TaskStore otoritas task tersedia untuk runtime ini. */
  readonly taskStore: boolean
  /** Scheduler terpasang. */
  readonly scheduler: boolean
  /** Supervisor proses terpasang (P13.2+). */
  readonly supervisor: boolean
}

/**
 * Bukti KETERSEDIAAN per kapabilitas.
 *
 * Tri-state dipakai sengaja: `true` = terverifikasi ada, `false` = terverifikasi
 * tidak ada, `null` = belum diketahui. `null` tak pernah dihitung sebagai
 * "boleh" — ketidakpastian bukti harus fail-closed, bukan di optimismakan.
 */
export interface RuntimeCapabilityEvidence {
  /** Jurnal durable terbuka dan tak ada append gagal pada incarnation ini. */
  readonly journalWritable: boolean | null
  /** TaskStore otoritas task bisa dibuka. */
  readonly storeOpen: boolean | null
  /** Scheduler terpasang. */
  readonly schedulerAttached: boolean | null
  /** Supervisor terpasang (null = belum ada kemampuan diklaim, P13.2). */
  readonly supervisorAttached: boolean | null
}

/**
 * Kapabilitas yang runtime ini DIKLAIM.
 *
 * Iklan berasal dari fakta pemasangan nyata, bukan dari daftar statis: begitu
 * proses supervision benar-benar terpasang (P13.2), ia masuk otomatis — dan
 * selama belum, tidak pernah muncul.
 */
export function advertisedRuntimeCapabilities(
  attachment: RuntimeAttachment,
): readonly RuntimeCapability[] {
  const out: RuntimeCapability[] = []
  if (attachment.journal) out.push("durable-journal")
  if (attachment.taskStore) out.push("durable-task-store")
  if (attachment.scheduler) out.push("task-scheduler")
  if (attachment.supervisor) out.push("process-supervision")
  return out
}

/**
 * Apakah kapabilitas itu SEDANG tersedia?
 *
 * Fail-closed: `null` (belum diketahui) = TIDAK tersedia. Bukti yang tak ada
 * tak pernah diartikan sebagai izin.
 */
export function capabilityAvailable(
  capability: RuntimeCapability,
  evidence: RuntimeCapabilityEvidence,
): boolean {
  switch (capability) {
    case "durable-journal":
      return evidence.journalWritable === true
    case "durable-task-store":
      return evidence.storeOpen === true
    case "task-scheduler":
      return evidence.schedulerAttached === true
    case "process-supervision":
      return evidence.supervisorAttached === true
  }
}

// ── Peta eksplisit jenis kerja durable → kapabilitas yang dibutuhkan ─────────
//
// Kenapa peta, bukan nama: nama jenis kerja bukan bukti. "work-kind-x" tak
// pernah berarti "punya akses ke jurnal" — mengira begitu adalah inferensi
// yang salah arah (allowlist dari nama = kelas bug yang berulang). Pemetaan
// hanya sah bila DITULIS eksplisit dan diuji.

/** Kebutuhan satu jenis kerja durable terhadap kapabilitas runtime. */
export interface DurableWorkRequirement {
  /** Pengenal jenis kerja (dipakai sebagai kunci peta, BUKAN sebagai bukti). */
  readonly workKind: string
  /** Kapabilitas yang WAJIB tersedia agar jenis kerja ini boleh jalan. */
  readonly requiredCapabilities: readonly RuntimeCapability[]
}

/** Peta kebutuhan: jenis kerja → kebutuhan kapabilitas. */
export type DurableWorkRequirementMap = ReadonlyMap<string, DurableWorkRequirement>

/**
 * Peta kosong — DEFAULT produksi P13.1.
 *
 * P13.1 tidak mendeklarasikan kelas kerja produksi: kelas kerja nyata adalah
 * keputusan P13.2 (tergantung bentuk dispatch yang benar-benar dipakai). Ships
 * kosong ⇒ admission durable work = REFUSE sampai peta sah didaftarkan. Itu
 * fail-closed yang jujur, bukan placeholder yang menyesatkan.
 */
export const EMPTY_REQUIREMENT_MAP: DurableWorkRequirementMap = new Map<
  string,
  DurableWorkRequirement
>()

/** Bangun peta kebutuhan dari daftar eksplisit (duplikat = entri terakhir). */
export function createRequirementMap(
  entries: readonly DurableWorkRequirement[],
): DurableWorkRequirementMap {
  const map = new Map<string, DurableWorkRequirement>()
  for (const entry of entries) {
    if (!entry || typeof entry.workKind !== "string" || entry.workKind.length === 0) continue
    map.set(entry.workKind, {
      workKind: entry.workKind,
      requiredCapabilities: [...entry.requiredCapabilities],
    })
  }
  return map
}

/**
 * Ambil kebutuhan untuk satu jenis kerja.
 *
 * `null` = tak ada peta eksplisit. Pemanggil WAJIB memperlakukan `null` sebagai
 * "tolak" (fail-closed), bukan "boleh".
 */
export function requirementFor(
  map: DurableWorkRequirementMap,
  workKind: string,
): DurableWorkRequirement | null {
  if (!map || typeof workKind !== "string" || workKind.length === 0) return null
  return map.get(workKind) ?? null
}
