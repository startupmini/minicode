// P13.1 — Seam DI status runtime: SATU sumber status untuk daemon & CLI.
//
// Kenapa berkas ini ada: model status runtime (runtime-status.ts) murni, tapi
// konsumennya (CLI, daemon) butuh "status runtime SEKARANG" tanpa masing-masing
// membangun runtime sendiri. Tanpa seam ini, tiap konsumen akan menghitung
// statusnya sendiri — itu persis dual-authority yang dilarang repo ini.
//
// Pola yang dipakai sama dengan DI lain repo ini (mis. `setSubAgentExecutionRunner`):
// composition root memasang penyedia, konsumen membaca. Tanpa pemasang, pembaca
// mendapat view ABSENT kanonik — bukan error dan bukan tebakan.
//
// CATATAN: ini BUKAN state runtime. Yang di sini hanya cara meng-query status.
// Kalau sembarang pihak menulis ke sini, status yang tampil bukan status runtime
// itu. Penulis tunggal: composition root.

import { deriveRuntimeView, type RuntimeFacts, type RuntimeView } from "./runtime-status.ts"

/** Penyedia status runtime: mengembalikan view kanonik saat ini. */
export type RuntimeStatusProvider = () => RuntimeView

let provider: RuntimeStatusProvider | null = null

/** Pasang penyedia status (composition root). `null` melepas pemasangan. */
export function installRuntimeStatusProvider(next: RuntimeStatusProvider | null): void {
  provider = next
}

/**
 * View ABSENT kanonik — dipakai saat tak ada runtime terpasang.
 *
 * `closed: true` konsisten dengan handle inert produksi (`isClosed()` selalu
 * true saat gate tertutup), jadi view ini bukan kondisi aneh tapi keadaan
 * normal proses yang memang tak menjalankan runtime.
 */
export function absentRuntimeView(note?: string): RuntimeView {
  const facts: RuntimeFacts = {
    phase: "ABSENT",
    termination: "NONE",
    evidence: {
      gateEnabled: false,
      constructed: false,
      closed: true,
      journalWritable: null,
      storeOpen: null,
      schedulerAttached: null,
      supervisorAttached: null,
      // Tak ada runtime ⇒ tak ada supervisi yang diharapkan (bukan "supervisi
      // hilang" — runtime-nya memang tak ada).
      supervisionExpected: false,
      pendingJournalAppends: 0,
    },
    attachment: { journal: false, taskStore: false, scheduler: false, supervisor: false },
    supervisedChildren: 0,
  }
  const view = deriveRuntimeView(facts)
  return note === undefined ? view : { ...view, note }
}

/**
 * View runtime saat ini.
 *
 * Tak pernah melempar: konsumen status (CLI/daemon) lebih baik melihat
 * "tidak ada runtime" daripada ikut mati karena penyedia-nya salah. Kegagalan
 * penyedia dilaporkan lewat `note`, bukan lewat exception.
 */
export function currentRuntimeView(): RuntimeView {
  if (!provider) return absentRuntimeView("tak ada runtime terpasang pada proses ini")
  try {
    return provider()
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return absentRuntimeView(`penyedia status runtime gagal: ${reason}`)
  }
}
