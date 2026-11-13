// Lifecycle popup bersama — satu sumber untuk idle-timer jendela interaktif
// (picker, form, model/provider manager, wizard).
//
// Masalah yang dipecahkan (audit D1): keempat layar menulis ulang pola idle
// yang sama dengan nuansa kecil berbeda — raw-mode digenggam tanpa input saat
// ConPTY mati/fokus hilang membuat popup "macet" (dan Bun Windows rawan
// segfault setelah ±133 dtk idle, lihat picker.ts). Dengan satu helper,
// semantiknya seragam: SEMUA timer di-unref (tak menahan proses), fase batal
// selalu ada, dan `dispose()` membuat reset berikutnya no-op (anti-timer-bocor
// sesudah selesai).
//
// Dua gaya yang didukung:
//   1. Satu tahap (picker/manager): cancelMs tercapai → langsung batal.
//   2. Dua tahap (form, audit TUI-004): warnMs → peringatan (draft DIPERTAHAN-
//      kan, render footer merah); cancelMs lagi tanpa keypress → batal.
//      TOTAL tetap warnMs + cancelMs.

export interface IdleTimerOptions {
  /** Fase 1 (opsional): jeda diam → peringatan. Tanpa ini = langsung batal. */
  warnMs?: number
  /** Fase 1 (tanpa warnMs) / fase 2 (dengan warnMs): jeda → batal. */
  cancelMs: number
  /** Dipanggil saat peringatan (hanya bila warnMs diisi). */
  onWarn?: () => void
  /** Dipanggil saat batal karena diam. Wajib. */
  onCancel: () => void
}

export interface IdleTimer {
  /** Restart timer (dipanggil tiap keypress/aktivitas). No-op sesudah dispose. */
  reset(): void
  /** Hentikan timer tanpa mematikan (dipanggil suspend/pause). */
  clear(): void
  /** Matikan selamanya: clear + reset berikutnya no-op (dipakai saat finish). */
  dispose(): void
}

/** Buat idle-timer dua-fase dengan unref otomatis. */
export function createIdleTimer(opts: IdleTimerOptions): IdleTimer {
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const unref = (t: ReturnType<typeof setTimeout>) => {
    // jangan tahan proses hidup hanya karena timer ini (stdin stub test bisa
    // tanpa API unref — anggap aman).
    try {
      ;(t as unknown as { unref?: () => void }).unref?.()
    } catch {}
  }
  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const fireCancel = () => {
    if (disposed) return
    opts.onCancel()
  }
  const reset = () => {
    if (disposed) return
    clear()
    if (opts.warnMs != null) {
      timer = setTimeout(() => {
        // Tahap 1: peringatan — konten tidak dibuang, render ulang oleh caller.
        if (disposed) return
        try {
          opts.onWarn?.()
        } catch {}
        timer = setTimeout(fireCancel, opts.cancelMs)
        unref(timer)
      }, opts.warnMs)
    } else {
      timer = setTimeout(fireCancel, opts.cancelMs)
    }
    unref(timer)
  }
  const dispose = () => {
    disposed = true
    clear()
  }
  return { reset, clear, dispose }
}
