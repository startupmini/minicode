// Gate kapabilitas mode TUI (kontrak I16).
//
// Sejak REPL linier dihapus, tak ada lagi pilihan mode: interaktif SELALU
// TUI bila terminal mampu, dan gagal jujur (bukan fallback diam-diam) bila
// tidak. Flag `--no-tui` dan env `MINICODE_TUI` ikut dihapus (tak ada yang
// dipilih di antara dua mode).
//
// Aturan (urutan penting):
//   1. Non-TTY (pipe/redirect/CI) → bukan interaktif (ditangani pemanggil;
//      fungsi ini hanya dipanggil untuk jalur REPL).
//   2. `TERM=dumb` → tak mampu (praktik standar).
//   3. Console legacy Windows → tak mampu (tanpa VT modern: DECSTBM/sticky
//      pun tak jalan di sana; aturan satu sumber, dipindah dari chrome.ts
//      yang dihapus).
//   4. Tinggi eksplisit <10 baris → tak mampu (lantai usability; tak
//      diketahui (=0/undefined) = diizinkan, alt-screen valid di ukuran apa
//      pun).
//
// Murni kecuali default (baca process bila argumen sys tak diberi) agar
// tabel pemetaan teruji penuh di OS apa pun via injeksi.

export type TuiMode = "tui" | "linear"

/** Console legacy Windows (tanpa VT modern). Dipindah verbatim dari
 * chrome.ts yang dihapus — satu sumber aturan, dipakai gate ini. */
export function isWinLegacy(): boolean {
  return (
    process.platform === "win32" &&
    !(
      process.env.WT_SESSION ||
      process.env.TERM_PROGRAM ||
      process.env.ANSICON ||
      process.env.ConEmuANSI
    )
  )
}

export interface TuiSys {
  env: Record<string, string | undefined>
  isTTY: boolean
  rows: number
  legacy: boolean
}

function defaultSys(): TuiSys {
  return {
    env: process.env as Record<string, string | undefined>,
    isTTY: process.stdout.isTTY === true,
    rows: process.stdout.rows || 0,
    legacy: isWinLegacy(),
  }
}

export function resolveTuiMode(sys?: Partial<TuiSys>): TuiMode {
  const d = defaultSys()
  const s: TuiSys = {
    env: sys?.env ?? d.env,
    isTTY: sys?.isTTY ?? d.isTTY,
    rows: sys?.rows ?? d.rows,
    legacy: sys?.legacy ?? d.legacy,
  }
  if (!s.isTTY) return "linear"
  if (s.env.TERM === "dumb") return "linear"
  if (s.legacy) return "linear"
  if (s.rows > 0 && s.rows < 10) return "linear"
  return "tui"
}
