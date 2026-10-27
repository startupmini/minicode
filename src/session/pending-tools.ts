// [Fase 1 / LOOP-INV-06, LOOP-INV-10] Pelacakan operasi tool yang SEDANG
// berjalan, dipersistensikan ke `runs.pending_tool_ids`.
//
// Masalah yang ditutup: setelah proses mati mendadak (SIGKILL), runtime tidak
// punya daftar tool mana yang sedang berjalan. `setRunPendingTools` sudah ada
// sejak P2.6 tetapi **dormant** (nol pemanggil), sehingga kolomnya selalu
// `'[]'` dan recovery hanya bisa menebak dari jurnal mutasi (yang bahkan tidak
// mencatat tool read-only).
//
// Kontrak modul ini:
//
//   1. SINKRON & DURABLE. `setRunPendingTools` adalah tulis SQLite sinkron;
//      `beginToolInFlight` memanggilnya dan baru kembali setelah baris
//      ter-update. Pemanggil (event `execution:started`, yang di-emit kernel
//      SEBELUM `tool.execute`) karena itu menjamin entri sudah di disk sebelum
//      efek samping apa pun terjadi.
//   2. TIDAK PERNAH MENGGAGALKAN TOOL. Kegagalan persist (mis. baris run sudah
//      hilang karena sesi dihapus) adalah degradasi yang dilaporkan ke stderr,
//      bukan alasan membatalkan pekerjaan yang sudah lolos policy. Bukti
//      hilang lebih baik daripada tool yang tiba-tiba ditolak.
//   3. HANYA SATU RUN AKTIF per proses. CLI menjalankan satu turn pada satu
//      waktu; run id di-set saat run dibuat dan dilepas saat run terminal.
//      Tanpa run (sesi anak/legacy), modul ini no-op — bukan menebak run id.
//   4. Bukti sengaja TIDAK dibersihkan saat proses mati. `clearPendingTools`
//      hanya dipanggil pada akhir run yang benar-benar selesai; jalur
//      INTERRUPTED/FAILED membiarkan daftar menggantung sebagai bukti
//      forensik bahwa operasi itu berstatus UNKNOWN.

import { setRunPendingTools } from "./persistence.ts"

let currentRunId: string | null = null
let currentCwd: string | undefined
const inFlight = new Set<string>()

/** [Fase 1] Ikat pelacakan ke run yang sedang aktif (atau lepaskan dengan null). */
export function setPendingToolsRun(runId: string | null, cwd?: string): void {
  currentRunId = runId
  currentCwd = cwd
  // Run baru selalu mulai dari himpunan kosong: sisa run sebelumnya bukan
  // miliknya, dan membawanya akan mengarang bukti in-flight.
  if (runId !== null) inFlight.clear()
}

/** Snapshot ID yang sedang berjalan (urut stabil, untuk asersi/test). */
export function pendingToolsSnapshot(): readonly string[] {
  return [...inFlight].sort()
}

/** Nol-kan state proses (hermetic test). */
export function resetPendingToolsForTests(): void {
  currentRunId = null
  currentCwd = undefined
  inFlight.clear()
}

function persist(): void {
  if (currentRunId === null) return
  try {
    setRunPendingTools(currentRunId, [...inFlight].sort(), currentCwd)
  } catch (e) {
    // Degradasi-diam yang terlihat: tool tetap jalan, tapi kehilangan bukti
    // in-flight run ini. Dicatat supaya tidak menjadi kebohongan pasif.
    process.stderr.write(
      `[warn] pending_tools persist failed (run ${currentRunId}): ${(e as Error).message}\n`,
    )
  }
}

/**
 * Catat tool sebagai in-flight SEBELUM efeknya. Durable saat kembali karena
 * `setRunPendingTools` sinkron.
 */
export function beginToolInFlight(toolCallId: string): void {
  if (currentRunId === null || toolCallId === "") return
  if (inFlight.has(toolCallId)) return
  inFlight.add(toolCallId)
  persist()
}

/** Lepas tool dari himpunan in-flight setelah selesai (sukses/gagal/cancel). */
export function endToolInFlight(toolCallId: string): void {
  if (toolCallId === "") return
  if (!inFlight.delete(toolCallId)) return
  persist()
}

/**
 * Bersihkan daftar pada run yang berakhir NORMAL. Untuk INTERRUPTED/FAILED
 * sengaja TIDAK dipanggil: daftar yang menggantung adalah bukti.
 */
export function clearPendingTools(): void {
  inFlight.clear()
  persist()
}
