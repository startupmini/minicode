// Preferensi gerak (temuan audit TUI-006): status busy tidak boleh bergantung
// pada animasi. MINICODE_MOTION=0 mematikan pulse spark dsb. — pola lazy env
// yang sama dengan theme.ts (dibaca saat DIPAKAI, bukan dibekukan saat import,
// agar env runtime & test tetap berpengaruh).

/** True bila animasi/transisi visual harus dimatikan. */
export function motionReduced(): boolean {
  const v = process.env.MINICODE_MOTION
  return v != null && v !== "" && v !== "1"
}
