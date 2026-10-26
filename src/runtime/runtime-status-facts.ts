// P13.3 Stage A — Fakta runtime: TIPE + satu pemetaan murni, dipakai beberapa
// pemanggil.
//
// Kenapa modul netral: pemetaan "state runtime → fakta kontrak" dibutuhkan
// oleh (a) composition (yang tahu state internalnya) dan (b) production-runtime
// (yang memegang handle). Meletakkannya di salah satu dari keduanya membuat
// siklus import, jadi ia diletakkan di modul ini — tanpa state, tanpa I/O.
//
// Modul ini juga jadi pemilik TIPE fakta (RuntimeFacts/RuntimeEvidence) dan
// bentuk hasil drain (RuntimeFlushReport), supaya `runtime-status.ts` tak perlu
// mengimpor `composition.ts` — dan dengan begitu graf import src/runtime/**
// tetap bebas siklus (guard m16 G1).
//
// Murni: semua primitif masuk lewat argumen. Tidak ada jam internal, tidak ada
// sumber data tersembunyi.

import type { HaltReason } from "../daemon/protocol.ts"
import type { FlushResult } from "./execution-journal.ts"
import type { RuntimeAttachment } from "./runtime-capabilities.ts"
import type { FailureClassification } from "./supervisor.ts"

/**
 * Bentuk hasil drain jurnal runtime.
 *
 * PADA: bentuk "drain selesai + berapa append yangnyelesai" — BUKAN probe
 * readiness. Keberadaan drain yang berhasil tak berarti persistence-nya utuh
 * saat ini (dan sebaliknya, drain yang belum jalan tak berarti persistence-nya
 * rusak) — dua hal yang beda, jadi bentuknya dipisah dari bukti readiness.
 */
export interface RuntimeFlushReport {
  readonly journal: FlushResult["status"] | "disabled"
  /** Append yang sudah selesai pada drain ini. */
  readonly drained: number
  /** Append yang MASIH jalan saat batas drain tercapai (dilaporkan, bukan didiamkan). */
  readonly unfinished: number
}

/** Status flush jurnal (dipakai laporan drain di atas). */
export type { FlushResult }

/**
 * Bukti operative runtime.
 *
 * Tri-state: `true` = terverifikasi ada, `false` = terverifikasi tidak ada,
 * `null` = belum diketahui. `null` tak pernah berarti "boleh" — ia berarti
 * "belum boleh", karena bukti yang tak ada tak bisa menopang keputusan.
 */
export interface RuntimeEvidence {
  /** Gate runtime terbuka (konfigurasi mengaktifkan runtime). */
  readonly gateEnabled: boolean
  /** Runtime benar-benar dibangun (komposisi selesai). */
  readonly constructed: boolean
  /** Runtime sudah ditutup (composition.close selesai). */
  readonly closed: boolean
  /**
   * Bukti persistence: jurnal durable terbuka DAN tak ada append gagal pada
   * incarnation ini. `null` = belum diketahui.
   */
  readonly journalWritable: boolean | null
  /** Bukti storage: TaskStore otoritas task bisa dibuka. `null` = belum diketahui. */
  readonly storeOpen: boolean | null
  /** Scheduler terpasang. `null` = belum diketahui. */
  readonly schedulerAttached: boolean | null
  /**
   * Supervisor terpasang. `null` = belum ada kemampuan diklaim (P13.1: proses
   * anak belum disupervisi — lihat runtime-capabilities.ts).
   */
  readonly supervisorAttached: boolean | null
  /**
   * Supervisi proses DIHARAPKAN runtime ini (komposisi dikonfigurasi untuk
   * supervisi) tapi TIDAK tersedia: establishment gagal, atau recovery
   * kehabisan percobaan. Runtime jadi DEGRADED — bukan HEALTHY — dan
   * kapabilitas `process-supervision` TIDAK diiklankan (tak ada yang diklaim
   * punya). Tanpa medan ini, kegagalan establishment akan terlihat sebagai
   * runtime yang sehat-normal.
   */
  readonly supervisionExpected: boolean
  /** Append jurnal yang belum selesai (proxy pekerjaan yang menunggu checkpoint). */
  readonly pendingJournalAppends: number
}

/** Fakta runtime yang diturunkan dari state nyata (input kontrak status). */
export interface RuntimeFacts {
  /** Fase lifecycle runtime. */
  readonly phase: RuntimePhase
  /** Terminasi: apa yang terjadi pada runtime ini. */
  readonly termination: RuntimeTermination
  /** Alasan halt — HANYA sah bila termination = REQUESTED | HALTED. */
  readonly haltReason?: HaltReason
  /** Penyebab kegagalan — HANYA sah bila termination = FAILED. */
  readonly failure?: FailureClassification
  /** Bukti operative. */
  readonly evidence: RuntimeEvidence
  /** Fakta pemasangan (dasar deklarasi kapabilitas). */
  readonly attachment: RuntimeAttachment
  /**
   * Jumlah anak proses yang tercatat di jalur ownership proses runtime.
   *
   * INI BEDA dari kapabilitas `process-supervision`: kapabilitas berarti "jalur
   * supervisi terpasang", angka ini berarti "ada anak yang tercatat". Runtime
   * dengan jalur terpasang tapi tanpa anak (mis. belum ada LSP yang dikonfigurasi)
   * tetap healthy: ia siap menerima kerja, hanya tak ada proses anak yang
   * dikuasai. Tanpa pemisahan ini, pembaca status bisa salah menyimpulkan
   * "runtime sudah menjalankan proses" dari sekadar melihat kapabilitasnya.
   */
  readonly supervisedChildren: number
  /** Hasil drain terakhir. BUKAN bukti readiness. */
  readonly lastFlush?: RuntimeFlushReport | null
}

/** Fase lifecycle runtime. BUKAN `SchedulerState` — scheduler punya IDLE/RUNNING sendiri. */
export type RuntimePhase = "ABSENT" | "STARTING" | "ACTIVE" | "STOPPING" | "STOPPED"

/** Terminasi runtime: `REQUESTED` ≠ `HALTED` (halt diminta vs selesai). */
export type RuntimeTermination = "NONE" | "REQUESTED" | "HALTED" | "FAILED"

/**
 * Fakta lapisan TASK (scheduler/TaskStore).
 *
 * Lapisan task dimiliki lapisan task (`src/task/`); runtime tidak menebak
 * keberadaannya. Yang tidak diketahui dilaporkan `null` (belum diketahui), bukan
 * `false` (dinyatakan tidak ada) — dua hal yang beda dan tak boleh dicampur.
 */
export interface TaskLayerFacts {
  /** Scheduler terpasang? `null` = belum diketahui. */
  readonly schedulerAttached: boolean | null
  /** TaskStore otoritas task terbuka? `null` = belum diketahui. */
  readonly storeOpen: boolean | null
}

/** Fakta mentah runtime — semua primitif, tanpa handle (inti murni). */
export interface ProductionRuntimeFactsInput {
  readonly enabled: boolean
  readonly constructed: boolean
  readonly closed: boolean
  /** Admission runtime masih terbuka (belum masuk drain shutdown). */
  readonly admissionOpen: boolean
  /** Runtime punya jurnal durable. */
  readonly durable: boolean
  /** Append jurnal yang gagal pada incarnation ini. */
  readonly journalAppendFailures: number
  /** Append jurnal yang belum selesai. */
  readonly pendingJournalAppends: number
  /**
   * Supervisi proses ATTACHED? true = instance supervisi benar-benar ada
   * (attachment valid → kapabilitas boleh diiklankan). false = establishment
   * gagal → tak ada yang boleh mengklaim punya.
   */
  readonly supervisionEstablished: boolean
  /**
   * Supervisi proses OPERATIONAL? false = establishment GAGAL atau recovery
   * kehabisan percobaan (supervisi sudah ada tapi tak lagi bisa bekerja).
   */
  readonly supervisorAttached: boolean
  /** Jumlah anak proses yang tercatat di jalur ownership proses. */
  readonly supervisedChildren: number
  readonly schedulerAttached?: boolean | null
  readonly storeOpen?: boolean | null
  /** Hasil drain terakhir (BUKAN bukti readiness — lihat RuntimeFacts). */
  readonly lastFlush?: RuntimeFlushReport | null
}

/**
 * Inti murni jembatan: fakta mentah → fakta kontrak.
 *
 * Dipisah dari pembacaan handle supaya pemetaan fase/terminasi bisa diuji
 * tanpa membangun runtime sungguhan (deterministik, tanpa I/O).
 */
export function runtimeFactsFrom(input: ProductionRuntimeFactsInput): RuntimeFacts {
  let phase: RuntimePhase
  if (!input.enabled) phase = "ABSENT"
  else if (!input.constructed) phase = "STARTING"
  else if (input.closed) phase = "STOPPED"
  else if (!input.admissionOpen) phase = "STOPPING"
  else phase = "ACTIVE"

  let termination: RuntimeTermination = "NONE"
  let haltReason: HaltReason | undefined
  if (phase === "STOPPING") {
    // Halt DIMINTA, belum selesai — bukan "HALTED" (yang berarti sudah stop).
    termination = "REQUESTED"
    haltReason = "SHUTTING_DOWN"
  } else if (phase === "STOPPED") {
    termination = "HALTED"
    haltReason = "SHUTTING_DOWN"
  }

  const attachment: RuntimeAttachment = {
    journal: input.durable,
    taskStore: input.storeOpen === true,
    scheduler: input.schedulerAttached === true,
    // Kapabilitas diiklankan HANYA setelah attachment VALID: instance supervisi
    // benar-benar ada. Establishment yang GAGAL → tak diiklankan (tak ada yang
    // boleh mengklaim punya), dan runtime jadi DEGRADED lewat bukti
    // `supervisionExpected`.
    supervisor: input.supervisionEstablished,
  }

  const evidence: RuntimeEvidence = {
    gateEnabled: input.enabled,
    constructed: input.constructed,
    closed: input.closed,
    journalWritable: input.durable ? input.journalAppendFailures === 0 : null,
    storeOpen: input.storeOpen ?? null,
    schedulerAttached: input.schedulerAttached ?? null,
    supervisorAttached: input.supervisorAttached,
    // Runtime yang punya komposisi SELALU dikonfigurasi untuk supervisi
    // (P13.2) — jadi supervisi yang hilang = degradation, bukan "tak relevan".
    supervisionExpected: input.constructed,
    pendingJournalAppends: input.pendingJournalAppends,
  }

  return {
    phase,
    termination,
    ...(haltReason !== undefined ? { haltReason } : {}),
    evidence,
    attachment,
    supervisedChildren: input.supervisedChildren,
    ...(input.lastFlush !== undefined ? { lastFlush: input.lastFlush } : {}),
  }
}
