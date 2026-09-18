import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs } from "../render/theme.ts"
import { acquireTransientPaint, paintWrite } from "./statusline.ts"

// Jaga agar kursor terminal selalu ter-restore meski proses dihentikan (SIGINT/dll).
process.on("exit", () => {
  if (process.stderr.isTTY) process.stderr.write("\x1b[?25h")
})

export interface Spinner {
  update: (message: string) => void
  stop: (finalMessage?: string) => void
  success: (message: string) => void
  error: (message: string) => void
}

export interface SpinnerOptions {
  /**
   * Tunda frame pertama (ms). Dipakai fase startup yang sering selesai <200ms
   * (cek update) — tanpa delay, spinner berkedip lalu hilang. 0 = langsung.
   */
  delayMs?: number
  /** Interval antar frame (default 120ms). */
  intervalMs?: number
}

export function createSpinner(initialMessage: string = "", opts: SpinnerOptions = {}): Spinner {
  const isTTY = process.stderr.isTTY
  const intervalMs = opts.intervalMs ?? 120
  const delayMs = opts.delayMs ?? 0
  // Pesan spinner bisa datang dari hasil tool yang tidak terpercaya — SGR boleh
  // lewat, sekuens lain (mis. \x1b[2J) dibuang agar tidak merusak layar.
  let message = sanitizeAnsiLine(initialMessage)
  let frameIdx = 0
  let intervalId: ReturnType<typeof setInterval> | undefined
  let delayTimer: ReturnType<typeof setTimeout> | undefined
  // Kepemilikan transient stderr selama animasi — mutual exclusion dengan
  // garis status turn di-enforce statusline.ts (warning overlap, bukan crash).
  let owned: { release(): void } | null = null
  // Sudah pernah menulis frame? Determinan apakah stop() boleh menulis
  // pembersih `\r\x1b[K` — spinner yang belum sempat melukis (masih dalam
  // delay) tidak boleh menghapus baris milik penulis lain.
  let painted = false
  let stopped = false

  const frames = glyphs.spinnerFrames

  const tick = () => {
    const frame = c.info(frames[frameIdx % frames.length]!)
    frameIdx++
    painted = true
    paintWrite(`\r${frame} ${message}\x1b[K`)
  }

  // `withDelay` hanya untuk frame PERTAMA (delay gagal-berkedip fase startup);
  // frame lanjutan/delay kedua akan membuat spinner tak pernah muncul.
  const startPaint = (withDelay = false) => {
    if (!isTTY || stopped || intervalId || delayTimer) return
    if (withDelay && delayMs > 0) {
      delayTimer = setTimeout(() => {
        delayTimer = undefined
        startPaint()
      }, delayMs)
      // Jangan tahan process hidup hanya karena delay tampil.
      try {
        ;(delayTimer as unknown as { unref?: () => void }).unref?.()
      } catch {}
      return
    }
    // Hide cursor during spin
    paintWrite("\x1b[?25l")
    owned = acquireTransientPaint("spinner", tick)
    tick()
    intervalId = setInterval(tick, intervalMs)
  }

  const stopTimer = () => {
    if (delayTimer) {
      clearTimeout(delayTimer)
      delayTimer = undefined
    }
    if (owned) {
      owned.release()
      owned = null
    }
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = undefined
    }
    if (isTTY && painted) {
      paintWrite("\r\x1b[K\x1b[?25h")
    }
    painted = false
  }

  startPaint(delayMs > 0)

  return {
    update(newMessage: string) {
      message = sanitizeAnsiLine(newMessage)
    },
    stop(finalMessage?: string) {
      if (stopped) return
      stopped = true
      stopTimer()
      if (finalMessage) {
        process.stderr.write(`${sanitizeAnsiLine(finalMessage)}\n`)
      }
    },
    success(msg: string) {
      if (stopped) return
      stopped = true
      stopTimer()
      process.stderr.write(`${c.green(glyphs.check)} ${sanitizeAnsiLine(msg)}\n`)
    },
    error(msg: string) {
      if (stopped) return
      stopped = true
      stopTimer()
      process.stderr.write(`${c.red(glyphs.cross)} ${sanitizeAnsiLine(msg)}\n`)
    },
  }
}
