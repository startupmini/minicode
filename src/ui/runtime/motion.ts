// Preferensi gerak (temuan audit TUI-006): status busy tidak boleh bergantung
// pada animasi. MINICODE_MOTION=0 mematikan pulse spark dsb. — pola lazy env
// yang sama dengan theme.ts (dibaca saat DIPAKAI, bukan dibekukan saat import,
// agar env runtime & test tetap berpengaruh).

/**
 * True bila animasi/transisi visual harus dimatikan.
 *
 * Semantik nilai eksplisit (audit minor 2026-09-23): "0"/"false"/"off"/"no" = matikan;
 * kosong/undefined/"1" = animasi hidup. Nilai tak dikenal (mis. "banana")
 * TIDAK diam-diam mengubah perilaku (fail-closed ke default hidup).
 */
export function motionReduced(): boolean {
  const v = (process.env.MINICODE_MOTION ?? "").trim().toLowerCase()
  return v === "0" || v === "false" || v === "off" || v === "no"
}
