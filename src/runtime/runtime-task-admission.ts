// P13.3 Stage A — Peta jenis kerja → kapabilitas runtime (KONTRAK, bukan tebakan).
//
// Kenapa berkas ini ada: P13.1 sudah menjadikan "boleh terima kerja durable
// baru?" sebagai keputusan PER JENIS KERJA (`admitDurableWork`), tapi peta
// jenis-kerja → kapabilitas belum pernah diisi. Tanpa peta, keputusan itu hanya
// jadi hiasan: semua jenis kerja akan ditolak (peta kosong) atau semua jenis
// kerja akan diterima (peta longgar). Peta ini adalah sumber kebenarannya.
//
// KOSAKATA JENIS KERJA — BUKAN ciptaan modul ini. Issuer resminya sudah ada:
// `src/runtime/production-execution.ts` (`TurnExecutionRequest.kind`) dan
// `src/runtime/dispatch.ts` (union yang sama). Modul ini hanya MENDAFTARKAN
// jenis yang memang ada di produksi:
//
//   "background" — pekerjaan otonom dari Scheduler (src/task/autonomous-context.ts:
//                  `runner.run({ kind: "background", schedulerSource: "autonomous" })`)
//   "child"     — sesi anak yang didelegasikan (src/tools/task.ts:
//                  `runner.run({ kind: "child", ... })`)
//   "turn"      — turn interaktif pengguna (default M13: src/runtime/dispatch.ts
//                  `kind: request.kind ?? "turn"`)
//   "task"      — ADA di union TIPE, tapi TIDAK ADA producer-nya di produksi
//                  (hasil inventaris repo: tak ada satu pun `kind: "task"` yang
//                  dibuat). Karena itu TIDAK dipetakan: jenis yang tak dipetakan
//                  ditolak (fail-closed), bukan diterka.
//
// KEBUTUHAN KAPABILITAS — tiap butir punya jalur kode yang MENYAKSIKAN kebutuhannya:
//
//   durable-task-store
//     Scheduler MEMAKAI TaskStore sebagai otoritas: claim atomik + revisi
//     (src/task/scheduler.ts `store.claimTask(sessionId, taskId, current.revision,
//     { exclusive: true })`) lalu commit di akhir siklus. Durable work tanpa
//     TaskStore = tidak ada claim, tidak ada otoritas, tidak ada recovery.
//
//   task-scheduler
//     Kerja "background" lahir dari siklus Scheduler (claim di atas); admission
//     runtime tanpa scheduler terpasang berarti tidak ada yang meng-offer kerja
//     itu dan lifecycle-nya tak punya pemilik siklus.
//
// YANG SENGAJA TIDAK DIKLASAKAN: `durable-journal`. Jurnal runtime adalah
// HISTORY EKSEKUSI (intent dispatch + event kernel), bukan syarat kerja:
// mode non-durable (`journalRequired: false`, dipakai mode runtime
// `constructed`) secara resmi berjalan tanpa jurnal — jadi menjadikannya
// syarat akan dustyakan gerbang untuk konfigurasi yang sah. Yang TIDAK boleh
// hilang adalah otoritas task (TaskStore) dan pemiliknya (scheduler).
//
// SEMUA BUTIR HANYA YANG BISA DIBUKTI DARI KODE. Tidak ada kapabilitas yang
// diANGGAP lebih tinggi dari yang marched by real code path.

import {
  createRequirementMap,
  type DurableWorkRequirementMap,
  type RuntimeCapability,
} from "./runtime-capabilities.ts"
import { type AdmissionDecision, admitDurableWork, type RuntimeView } from "./runtime-status.ts"

/**
 * Peta kebutuhan kapabilitas per jenis kerja.
 *
 * Dibuat dari `createRequirementMap` (P13.1) supaya bentuknya persis bentuk
 * yang dipakai `admitDurableWork` — tak ada daftar kedua yang bisa berbeda.
 */
export const TASK_WORK_REQUIREMENTS: DurableWorkRequirementMap = createRequirementMap([
  {
    // Claim atomik di TaskStore (otoritas task) + pemilik siklus (scheduler).
    workKind: "background",
    requiredCapabilities: ["durable-task-store", "task-scheduler"],
  },
  {
    // Sesi anak: TIDAK ada claim TaskStore (anak bukan task otonom) dan TIDAK ada
    // siklus scheduler — history-nya milik store sesi, bukan TaskStore.
    workKind: "child",
    requiredCapabilities: [],
  },
  {
    // Turn interaktif: sama — bukan task otonom, jadi tak butuh TaskStore/scheduler.
    workKind: "turn",
    requiredCapabilities: [],
  },
])

/** Jenis kerja yang punya peta. "task" TIDAK termasuk (tak ada producer-nya). */
export const MAPPED_WORK_KINDS: readonly string[] = ["background", "child", "turn"]

/**
 * Keputusan admission untuk satu jenis kerja nyata.
 *
 * Fail-closed di setiap celah:
 * - Jenis tak dikenal / tak dipetakan ⇒ REFUSE (nama tak pernah jadi izin).
 * - Kapabilitas yang dibutuhkan tak tersedia ⇒ REFUSE, dan disebut mana.
 * - Bukti runtime tak lengkap/basi ⇒ REFUSE (dari `admitDurableWork`).
 *
 * Tidak ada jalur yang "menerka" allowlist dari nama jenis kerja.
 */
export function admitTaskWork(view: RuntimeView, workKind: string): AdmissionDecision {
  return admitDurableWork(view, { workKind, requirements: TASK_WORK_REQUIREMENTS })
}

/** Bukti kebutuhan kapabilitas untuk satu jenis kerja (untuk diagnostik/test). */
export function requiredCapabilitiesFor(workKind: string): readonly RuntimeCapability[] {
  const entry = TASK_WORK_REQUIREMENTS.get(workKind)
  return entry ? entry.requiredCapabilities : []
}
