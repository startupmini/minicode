// [Area B · PROMPT 06] Pengikatan persetujuan ↔ operasi yang BENAR-BENAR
// dieksekusi.
//
// Masalah yang ditutup: `edit`/`apply_patch` MEMBACA ULANG file saat eksekusi,
// sementara preview yang dilihat user berasal dari state SAAT approval. Bila
// file berubah di antara keduanya (proses lain, tool paralel, sub-agent),
// operasi yang dijalankan bukan yang disetujui — persetujuan jadi basi.
//
// Mekanisme (dua titik, satu objek state):
// · CAPTURE (sebelum prompt): sidik jari argumen (SHA-256 kanonis) + isi file
//   target — "apa yang dilihat user".
// · GRANT (setelah user setuju): simpan sidik jari itu untuk operasi ini saja.
// · VERIFY (batas eksekusi): hitung ulang; beda ⇒ basi ⇒ TOLAK (fail-closed).
//
// Kenapa verifikasi di barrier efek (`src/app/session.ts` `beforeToolEffect`):
// antara `permissions.check()` dan `tool.execute` kernel hanya menjalankan
// langkah sinkron, TAPI aplikasi menambah await (intent jurnal + no-progress)
// di dalam handler. Barrier adalah titik terakhir sesudah semua await itu dan
// sebelum "allow" kembali ke kernel — efektif batas eksekusi, tanpa membungkus
// tool (yang merusak identitas array tool live milik WorkMode).
//
// Lapis pertama diverifikasi SAAT user menyetujui supaya persetujuan basi
// ditolak sebelum intent jurnal ditulis.
//
// Batas jujur: efek `bash` tak bisa difingerprint — yang terikat hanya
// argumennya. Pada `always`/allowlist tak ada prompt ⇒ tak ada grant yang bisa
// diverifikasi untuk call berikutnya; grant tetap dibuat untuk call berjalan.

import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { canonicalArgsHash } from "./no-progress.ts"

/** Tool yang TARGET-nya file di workspace — satu-satunya yang bisa di-fingerprint. */
const FILE_TARGET_TOOLS = new Set(["write_file", "edit", "apply_patch", "delete_file", "move_file"])

/**
 * Batas fingerprint KONTEN. File lebih besar dari ini di-fingerprint lewat
 * size+mtime (bukan hash isi): approval untuk file raksasa tetap bisa
 * dideteksi berubah, tanpa membaca ratusan MB dua kali per prompt.
 */
export const MAX_CONTENT_FINGERPRINT_BYTES = 2 * 1024 * 1024

/** Sidik jari "file tidak ada" — BEDA dari hash file kosong. */
export const MISSING_TARGET = "missing"
/** Sidik jari "path ada tapi bukan file biasa" (mis. direktori). */
export const NOT_A_FILE = "not-a-file"

/** Sidik jari satu target file. */
export interface ApprovalTarget {
  /** Path absolut target. */
  readonly path: string
  /** Hash isi (file kecil) / size+mtime (file besar) / MISSING_TARGET. */
  readonly fingerprint: string
}

/** Bukti persetujuan untuk SATU operasi. */
export interface ApprovalBinding {
  /** Nama tool yang disetujui. */
  readonly tool: string
  /** SHA-256 argumen kanonis (identik dengan `hashArgs`/`canonicalArgsHash`). */
  readonly argsHash: string
  /** Target file yang jadi bukti (kosong untuk tool tanpa target file). */
  readonly targets: readonly ApprovalTarget[]
}

/**
 * Path absolut target file untuk tool tertentu.
 *
 * `move_file` punya DUA ujung (from + to): keduanya jadi bukti, karena
 * perubahan salah satu ujung mengubah operasi yang disetujui.
 */
export function approvalTargetPaths(tool: string, args: unknown, root: string): string[] {
  if (!FILE_TARGET_TOOLS.has(tool)) return []
  const a = (args ?? {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === "string" ? v : "")
  if (tool === "move_file") {
    const from = str(a.from)
    const to = str(a.to)
    return [from, to].filter((p) => p !== "").map((p) => resolve(root, p))
  }
  const p = str(a.path)
  return p ? [resolve(root, p)] : []
}

/** Sidik jari target saat ini (hash isi / size+mtime / marker). */
export function fingerprintTarget(path: string): string {
  try {
    const st = statSync(path)
    if (!st.isFile()) return NOT_A_FILE
    if (st.size > MAX_CONTENT_FINGERPRINT_BYTES)
      return `size:${st.size}:mtime:${Math.trunc(st.mtimeMs)}`
    return createHash("sha256").update(readFileSync(path)).digest("hex")
  } catch {
    // Tidak ada / tak bisa dibaca = "missing" (bukan hash kosong).
    return MISSING_TARGET
  }
}

/**
 * TANGKAP bukti persetujuan — dipanggil SEBELUM prompt.
 *
 * Ini adalah "apa yang dilihat user": argumen + isi file target pada saat
 * preview dibuat. Menangkap SEBELUM prompt penting: prompt bisa berjalan
 * lama (user berpikir), dan kalau sidik jari diambil SETELAH prompt kita
 * memverifikasi state yang tidak pernah dilihat user.
 */
export function captureApprovalBinding(tool: string, args: unknown, root: string): ApprovalBinding {
  return {
    tool,
    argsHash: canonicalArgsHash(args),
    targets: approvalTargetPaths(tool, args, root).map((path) => ({
      path,
      fingerprint: fingerprintTarget(path),
    })),
  }
}

/**
 * Hasil verifikasi binding terhadap state target saat ini.
 * `stale` = operasi yang disetujui tak lagi berlaku (fail-closed).
 */
export type BindingVerdict =
  | { kind: "ok" }
  | { kind: "no-binding" }
  | { kind: "stale"; reason: string }

/**
 * Verifikasi binding approval terhadap state file target saat ini.
 *
 * `no-binding` = tak ada persetujuan yang tercatat untuk operasi ini (mis.
 * mode auto/allowlist, atau handler permission terinjeksi) → tak ada yang bisa
 * diverifikasi, dan tidak ada bukti basi → biarkan lewat.
 */
export function verifyApprovalBinding(binding: ApprovalBinding | undefined): BindingVerdict {
  if (!binding) return { kind: "no-binding" }
  if (binding.targets.length === 0) return { kind: "ok" }
  for (const t of binding.targets) {
    const now = fingerprintTarget(t.path)
    if (now === t.fingerprint) continue
    return {
      kind: "stale",
      reason:
        now === MISSING_TARGET
          ? `target ${t.path} tidak ada lagi (hilang sejak approval)`
          : `target ${t.path} berubah sejak approval — approval basi, minta ulang`,
    }
  }
  return { kind: "ok" }
}

/**
 * Penyimpanan binding persetujuan milik SATU sesi.
 *
 * Per-sesi, bukan global: dua sesi dalam satu proses tak boleh memakai
 * bukti persetujuan milik satu sama lain (Area A — isolasi instance).
 */
export class ApprovalBindingStore {
  readonly root: string
  /** Antre per (tool, argsHash) — FIFO agar urut grant = urut eksekusi. */
  readonly #pending = new Map<string, ApprovalBinding[]>()

  constructor(root: string) {
    this.root = root
  }

  static key(tool: string, argsHash: string): string {
    return `${tool}\u0000${argsHash}`
  }

  /** Catat persetujuan yang sudah diberikan user (SETELAH prompt selesai). */
  grant(binding: ApprovalBinding): void {
    const k = ApprovalBindingStore.key(binding.tool, binding.argsHash)
    const arr = this.#pending.get(k)
    if (arr) arr.push(binding)
    else this.#pending.set(k, [binding])
  }

  /** Ambil satu binding untuk (tool, argsHash) — consume-once. */
  take(tool: string, argsHash: string): ApprovalBinding | undefined {
    const k = ApprovalBindingStore.key(tool, argsHash)
    const arr = this.#pending.get(k)
    if (!arr || arr.length === 0) return undefined
    const first = arr.shift()!
    if (arr.length === 0) this.#pending.delete(k)
    return first
  }

  /** Jumlah binding yang masih tertunda (diagnostik/test). */
  get size(): number {
    let n = 0
    for (const arr of this.#pending.values()) n += arr.length
    return n
  }

  clear(): void {
    this.#pending.clear()
  }
}
