// Bar loading startup — baris tunggal blok progres (`▓░`) + persen + label
// di stderr, menggantikan teks proses verbose saat REPL dibuka. Fase startup
// memanggil `update(label, percent)`; bar melukis via `paintWrite` sehingga
// otomatis tunduk pada arbitrase statusline.ts (wizard interaktif menahannya,
// tulis asing di-commit sebagai baris permanen, non-TTY = nol byte).
//
// Fase hanyalah sinyal, bukan animasi loop: frame digambar ulang TIDAK pada
// interval, melainkan saat `update()` dipanggil. Dengan begitu bar tidak
// berkedip pada startup yang sangat cepat (delay pertama 120ms) dan tidak
// melukis apa pun bila tidak ada fase yang melaporkan progres.

import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs } from "../render/theme.ts"
import { truncateToWidth } from "../render/width.ts"
import { motionReduced } from "./motion.ts"
import { acquireTransientPaint, paintWrite } from "./statusline.ts"

// Jaga agar kursor terminal selalu ter-restore meski proses dihentikan
// (SIGINT/dll). Hook didaftarkan LAZY saat bar benar-benar menyembunyikan
// kursor: hook di scope modul menulis `ESC[?25h` ke stderr pada SETIAP proses
// yang sekadar meng-import modul ini — byte asing yang mendarat di alt-screen
// TUI walau bar tak pernah dibuat (audit 2026-11-12).
let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on("exit", () => {
    if (process.stderr.isTTY) process.stderr.write("\x1b[?25h")
  })
}

export interface LoadingBar {
  /** Ganti label + persen (0..100). Tak pernah melampaui target yang diberikan. */
  update: (label: string, percent: number) => void
  /** Hapus baris + restore kursor. Idempoten. */
  stop: () => void
}

export interface LoadingBarOptions {
  /** Tunda frame pertama (ms). Default 120 — fase cepat tak berkedip. */
  delayMs?: number
  /** Lebar maks kolom bar (default 40). */
  barWidth?: number
}

export function createLoadingBar(
  initialLabel = "",
  opts: LoadingBarOptions = {},
): LoadingBar | null {
  // Non-TTY/pipe/CI: tanpa animasi/ANSI (kontrak terminal) — bar jadi no-op.
  if (!process.stderr.isTTY) return null
  // Preferensi gerak dikurangi: tetap tampilkan progres (informatif), tapi
  // tanpa menyembunyikan kursor dan tanpa delay (tak ada sensasi animasi).
  const reduced = motionReduced()
  const delayMs = reduced ? 0 : (opts.delayMs ?? 120)
  const barWidthMax = Math.max(8, Math.min(40, opts.barWidth ?? 40))
  let label = sanitizeAnsiLine(initialLabel)
  let percent = 0
  let owned: { release(): void } | null = null
  let delayTimer: ReturnType<typeof setTimeout> | undefined
  let started = false
  let stopped = false

  const frame = (): string => {
    // Lebar terminal = kolom (bukan karakter). Bar dihitung dari `columns`;
    // sisa kolom untuk label (displayWidth-aware via truncateToWidth).
    const cols = process.stderr.columns ?? process.stdout.columns ?? 80
    const w = Math.min(barWidthMax, Math.max(8, cols - 20))
    const filled = Math.round((percent / 100) * w)
    const blocks = glyphs.blockFilled.repeat(filled) + glyphs.blockEmpty.repeat(w - filled)
    const pct = `${Math.round(percent)}%`.padStart(4)
    const labelPart = truncateToWidth(label, Math.max(4, cols - w - 14))
    return `\r${c.dim(blocks)} ${pct} ${labelPart}\x1b[K`
  }

  const paint = (): void => {
    paintWrite(frame())
  }

  const start = (): void => {
    if (stopped || started) return
    started = true
    // Sembunyikan kursor hanya saat animasi normal; mode gerak-dikurangi
    // cukup melukis baris tanpa mengubah visibilitas kursor.
    if (!reduced) {
      installExitHook()
      paintWrite("\x1b[?25l")
    }
    owned = acquireTransientPaint("loading-bar", paint)
    paint()
  }

  const scheduleStart = (): void => {
    if (delayMs > 0) {
      delayTimer = setTimeout(() => {
        delayTimer = undefined
        start()
      }, delayMs)
      // Jangan tahan process hidup hanya karena delay tampil.
      try {
        ;(delayTimer as unknown as { unref?: () => void }).unref?.()
      } catch {}
    } else {
      start()
    }
  }

  scheduleStart()

  return {
    update(newLabel: string, newPercent: number) {
      if (stopped) return
      label = sanitizeAnsiLine(newLabel)
      percent = Math.max(0, Math.min(100, newPercent))
      // Sebelum delay habis, bar belum melukis apa pun — cukup simpan label/
      // percent terbaru. `start()` (dari timer delay) memakai nilai ini, jadi
      // fase yang cepat selesai sebelum delay tidak menampilkan frame kosong.
      if (started) paint()
    },
    stop() {
      if (stopped) return
      stopped = true
      if (delayTimer) {
        clearTimeout(delayTimer)
        delayTimer = undefined
      }
      if (owned) {
        owned.release()
        owned = null
      }
      if (started) {
        paintWrite(reduced ? "\r\x1b[K" : "\r\x1b[K\x1b[?25h")
      }
      started = false
    },
  }
}
