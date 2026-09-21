// Layar alternate-screen — pemilik `?1049h/?1049l` (kontrak I16). TUI
// fullscreen hidup di sini dari start sampai quit; popup komposit (dialog
// ala popup) dilukis TANPA clear via paintRegion di atas konten pemilik
// layar, sehingga transkrip di belakang tetap tampil.
//
// Aturan pakai (lihat dialog.ts untuk isi, view memanggil):
//   const screen = openAltScreen()
//   if (!screen.ok) { /* tolak bersuara + batal */ return }
//   try { ... screen.paint(frame) ... } finally { screen.close() }
// Refcount menutup modal nested (effort-picker di dalam manager): tulis
// enter/exit fisik hanya di lapis terluar; handle dalam = no-op paint-through.
const ENTER = "\x1b[?1049h"
const EXIT = "\x1b[?1049l"
const HOME = "\x1b[H"
const CLEAR_ALL = "\x1b[2J"
// Reset scroll-region — unconditional + idempoten: region aktif peninggalan
// akan memotong paint fullscreen; tulis SEBELUM enter dan SESUDAH exit agar
// buffer utama kembali steril apa pun yang terjadi di dalam.
// region aktif akan memotong paint fullscreen modal; tulis SEBELUM enter dan
// SESUDAH exit agar buffer utama kembali steril apa pun yang terjadi di dalam.
const RESET_REGION = "\x1b[r"
const SYNC_START = "\x1b[?2026h"
const SYNC_END = "\x1b[?2026l"

let depth = 0
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // Jaring terakhir (best-effort, sinkron): modal yatim mengunci layar di
  // buffer alt. `kill -9` tak tercakup — ketik `reset` (residual kontrak).
  process.on("exit", () => {
    if (depth > 0) {
      try {
        process.stdout.write(EXIT)
      } catch {}
      depth = 0
    }
  })
}

export interface AltScreen {
  /** False = tak mampu (non-TTY/dumb) — paint/close no-op, caller fallback. */
  readonly ok: boolean
  readonly cols: number
  readonly rows: number
  /** Lukis satu frame penuh (tepat `rows` baris dari dialog.ts). */
  paint(lines: string[]): void
  /**
   * Lukis REGION TANPA clear: popup di atas konten pemilik layar (App TUI).
   * Tiap baris ditulis di `topRow+i` (1-based) setelah hapus-baris; baris di
   * luar region TAK tersentuh sehingga transkrip di belakang tetap tampil.
   * Siklus hidup region: handle mengingat region terakhir; render yang
   * menyusut/bergeser membersihkan union lama+baru (tanpa ini sisa kotak
   * lama tertinggal sebagai baris hantu). Pemilik layar me-repaint penuh
   * saat popup tutup (App.resume).
   */
  paintRegion(lines: string[], topRow: number): void
  /**
   * Hapus region terakhir yang dilukis handle ini (spasi) — dipanggil view
   * saat tutup sebelum pemilik me-repaint. Idempoten, tak pernah melempar.
   */
  clearRegion(): void
  /** Idempoten; exit fisik hanya di lapis terluar. Tak pernah melempar. */
  close(): void
}

const NULL_COLS = 80
const NULL_ROWS = 24

function nullScreen(): AltScreen {
  return {
    ok: false,
    cols: process.stdout.columns || NULL_COLS,
    rows: process.stdout.rows || NULL_ROWS,
    paint: () => {},
    paintRegion: () => {},
    clearRegion: () => {},
    close: () => {},
  }
}

/** Buka layar modal. Fail-closed: kembalikan null-screen bila tak mampu. */
export function openAltScreen(): AltScreen {
  installExitHook()
  if (!process.stdin.isTTY || !process.stdout.isTTY) return nullScreen()
  if ((process.env.TERM ?? "") === "dumb") return nullScreen()
  let closed = false
  const nested = depth > 0
  if (!nested) {
    try {
      process.stdout.write(RESET_REGION)
      process.stdout.write(ENTER)
    } catch {
      return nullScreen()
    }
  }
  depth++
  // Region terakhir handle ini (siklus hidup popup komposit) — per-handle
  // (closure), bukan global: popup nested (effort di dalam manager) melacak
  // areanya masing-masing.
  let lastRegion: { top: number; height: number } | null = null
  return {
    ok: true,
    // Getter LIVE (bukan snapshot saat open) — resize di tengah modal wajib
    // memakai geometri saat paint (kontrak I11); snapshot membeku = bingkai
    // meluap setelah resize (pelajaran sama seperti c/glyphs di theme.ts).
    get cols() {
      return process.stdout.columns || NULL_COLS
    },
    get rows() {
      return process.stdout.rows || NULL_ROWS
    },
    paint(lines: string[]): void {
      if (closed) return
      try {
        process.stdout.write(SYNC_START)
        process.stdout.write(HOME)
        process.stdout.write(CLEAR_ALL)
        process.stdout.write(lines.join("\r\n"))
        process.stdout.write(SYNC_END)
      } catch {}
    },
    paintRegion(lines: string[], topRow: number): void {
      if (closed) return
      // Melukis nol baris = no-op murni (bukan clear): pemanggil yang ingin
      // menghapus memakai clearRegion() eksplisit.
      if (!lines.length) return
      try {
        const top = Math.max(1, Math.floor(topRow) || 1)
        const h = lines.length
        // Union region lama + baru: kotak yang menyusut/bergeser (filter,
        // notice hilang) harus menghapus sisa bingkainya sendiri — pemilik
        // layar tak tahu geometri popup.
        let clearTop = top
        let clearBottom = top + Math.max(0, h - 1)
        if (lastRegion) {
          clearTop = Math.min(clearTop, lastRegion.top)
          clearBottom = Math.max(clearBottom, lastRegion.top + lastRegion.height - 1)
        }
        let out = SYNC_START
        for (let r = clearTop; r <= clearBottom; r++) {
          const i = r - top
          // Baris diasumsi satu-baris-tersanitasi dari dialogBox (tanpa \n —
          // \n akan menggeser kursor dan merusak baris berikut; split defensif).
          const row = i >= 0 && i < h ? ((lines[i] ?? "").split("\n")[0] ?? "") : ""
          out += `\x1b[${r};1H\x1b[2K${row}`
        }
        out += SYNC_END
        process.stdout.write(out)
        lastRegion = h > 0 ? { top, height: h } : null
      } catch {}
    },
    clearRegion(): void {
      if (closed) return
      if (!lastRegion) return
      try {
        let out = SYNC_START
        for (let r = lastRegion.top; r < lastRegion.top + lastRegion.height; r++) {
          out += `\x1b[${r};1H\x1b[2K`
        }
        out += SYNC_END
        process.stdout.write(out)
      } catch {}
      lastRegion = null
    },
    close(): void {
      if (closed) return
      closed = true
      lastRegion = null
      depth = Math.max(0, depth - 1)
      if (depth === 0) {
        try {
          process.stdout.write(EXIT)
        } catch {}
        try {
          process.stdout.write(RESET_REGION)
        } catch {}
      }
    },
  }
}

/** Introspeksi untuk test: kedalaman modal aktif. */
export function altScreenDepth(): number {
  return depth
}

/**
 * Reset kedalaman (HANYA untuk isolasi test antar-file): view yang gagal
 * di tengah test bisa meninggalkan depth > 0 sehingga file test berikutnya
 * melihat open() sebagai nested dan tak ada ENTER fisik tertulis.
 */
export function resetAltScreenDepth(): void {
  depth = 0
}
