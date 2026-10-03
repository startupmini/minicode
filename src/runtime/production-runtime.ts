// M14/M15 — Produksi runtime composition: SATU seam,Mode bertingkat.
//
// Kenapa berkas ini ada: `createRuntimeComposition` (composition.ts) merakit satu
// runtime, tapi tidak tahu BAGAIMANA produksi memanggilnya. Tanpa lapisan ini,
// pemanggil pertama akan membangun runtime dari dalam `createCliSession`,
// dan "gate mati berarti tak ada yang dibangun" mustahil dibuktikan — cukup satu
// `await create(...)` yang tak dijaga.
//
// Pola yang dipakai persis mengikuti 6U (`src/task/production-scheduler.ts`):
// gate dicek SEBELUM konstruksi, dan dependency datang sebagai THUNK yang tak
// dipanggil saat gate tutup. Jadi "default config tak membuka journal SQLite,
// tak membangun kernel/host, dan tak menambah handler apa pun" adalah sifat
// alur kontrol — bukan janji di komentar.
//
// Batas yang disengaja:
// - Mode default `off`: tak ada runtime yang dibangun, jalur legacy utuh.
// - M15 memakai MODE bertingkat (`off` / `constructed` / `owned`, lihat
//   production-execution.ts) alih-alih boolean M14; boolean `constructed` M14
//   adalah stage "runtime ada, eksekusi belum dimiliki".
// - Tidak ada lifecycle/dispatch/recovery/dispatch policy BARU di sini: yang
//   dipanggil persis modul M8–M13 via composition.ts.

import { resolveLocalDbPath } from "../lib/db-path.ts"
import {
  createRuntimeComposition,
  type RuntimeComposition,
  type RuntimeCompositionOptions,
  type RuntimeFlushReport,
  type RuntimeShutdownResult,
} from "./composition.ts"
import { type RuntimeProductionMode, runtimeModeFor } from "./production-execution.ts"

export type RuntimeGateSource = "session-option" | "absent"

export interface RuntimeGate {
  readonly enabled: boolean
  readonly source: RuntimeGateSource
}

export const RUNTIME_GATE_DISABLED: RuntimeGate = { enabled: false, source: "absent" }
export const RUNTIME_GATE_ENABLED: RuntimeGate = { enabled: true, source: "session-option" }

/**
 * Gate M15 dibaca dari MODE, bukan boolean: `off` = tak dibangun sama sekali;
 * `constructed`/`owned` = dibangun. Nilai tak dikenal (atau `undefined`) = mati
 * secara struktur — jalur legacy utuh bila tak ada yang mengaktifkan.
 */
export function runtimeGateFor(mode: RuntimeProductionMode | undefined): RuntimeGate {
  return runtimeModeFor(mode) === "off" ? RUNTIME_GATE_DISABLED : RUNTIME_GATE_ENABLED
}

/** Dependency runtime — hanya dibutuhkan bila gate terbuka. */
export type ProductionRuntimeDeps = Omit<
  RuntimeCompositionOptions,
  "sessionId" | "workspaceCwd" | "journalPath"
> &
  Pick<RuntimeCompositionOptions, "sessionId" | "workspaceCwd" | "journalPath">

/**
 * Handle yang dipegang produksi. Setiap metode AMAN saat gate tutup dan melaporkan
 * `null`/`false` alih-alih melempar: pemanggil yang lupa memeriksa gate harus
 * berakhir "tak terjadi apa-apa", bukan "runtime jalan karena error ditelan".
 */
export interface ProductionRuntimeHandle {
  readonly enabled: boolean
  /** True setelah komposisi benar-benar dibangun (bukan setelah gate di-check). */
  readonly constructed: boolean
  isClosed(): boolean
  /** Komposisi milik sesi ini; `null` bila gate tutup. */
  runtime(): RuntimeComposition | null
  /** Drain + checkpoint jurnal; `null` bila gate tutup. */
  flush(): Promise<RuntimeFlushReport | null>
  /**
   * Tutup runtime. Meneruskan SATU shutdown lifecycle ke composition (tak ada
   * journal/host closure kedua di sini — pemilik closure tetap composition).
   * Idempoten + concurrency-safe: pemanggil kedua menerima hasil yang SAMA.
   * `null` hanya bila gate tutup (tidak ada yang harus ditutup).
   */
  stop(): Promise<RuntimeShutdownResult | null>
  /** Hasil shutdown terakhir; `null` bila belum ada / gate tutup. */
  shutdownResult(): RuntimeShutdownResult | null
}

/** Handle mati: hanya objek itself, tanpa journal/host/kernel/backend. */
function inertHandle(gate: RuntimeGate): ProductionRuntimeHandle {
  return {
    enabled: gate.enabled,
    constructed: false,
    isClosed: () => true,
    runtime: () => null,
    flush: () => Promise.resolve(null),
    stop: () => Promise.resolve(null),
    shutdownResult: () => null,
  }
}

/**
 * Path jurnal runtime: workspace-LOCAL (`.minicode/`), satu berkas per identitas
 * sesi. Dua aturan yang dijaga di sini:
 * - Path berasal dari identitas yang DIBERIKAN caller (resume memakai identitas
 *   sesi yang di-resume), tak pernah dari acak — resume harus menemukan jurnal
 *   lamanya, bukan membuat jurnal baru yang kosong.
 * - `..`, separator, dan NUL DITOLAK fail-closed: nama berkas dari identitas
 *   tak boleh pernah bisa keluar dari `.minicode/`.
 */
export function runtimeJournalPath(cwd: string, identity: string): string {
  if (typeof identity !== "string" || identity.length === 0)
    throw new Error("production-runtime: identity is required (never derived here)")
  if (identity.includes("..") || /[/\\\0]/.test(identity))
    throw new Error("production-runtime: identity must not contain path separators or '..'")
  const safe = identity.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64)
  if (safe.length === 0) throw new Error("production-runtime: identity has no usable characters")
  return resolveLocalDbPath(`runtime-journal-${safe}.db`, cwd)
}

/**
 * THE PRODUCTION COMPOSITION ROOT untuk runtime P1.
 *
 * `deps` adalah THUNK dan hanya dipanggil saat gate terbuka — itulah yang membuat
 * mode default benar-benar bebas (tak ada journal, tak ada host, tak ada event).
 */
export async function createProductionRuntime(
  gate: RuntimeGate,
  deps: () => ProductionRuntimeDeps | Promise<ProductionRuntimeDeps>,
): Promise<ProductionRuntimeHandle> {
  if (!gate.enabled) return inertHandle(gate)

  const d = await deps()
  // Konstruksi gagal (jurnal tak bisa dibuka) = fail-closed propagasi ke pemanggil:
  // runtime tanpa durability bukan runtime, dan diam-diam berjalan tanpa history
  // adalah kegagalan yang jauh lebih mahal daripada cli yang gagal start.
  const runtime = createRuntimeComposition(d)

  const handle: ProductionRuntimeHandle = {
    enabled: true,
    constructed: true,
    isClosed: () => runtime.isClosed(),
    runtime: () => runtime,
    flush: () => runtime.flush(),
    // Delegasi murni: SATU pemilik closure tetap composition, dan promise yang
    // sama dikembalikan ke semua pemanggil (tak ada flush/close kedua).
    stop: () => runtime.shutdown(),
    shutdownResult: () => runtime.shutdownResult(),
  }
  return handle
}
