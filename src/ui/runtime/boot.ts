// Boot screen — logo minicode (kompak) dengan reveal typewriter selama startup.
//
// Menggantikan spinner satu-baris di cli/index.ts (cek update + setup sesi).
// Melukis logo baris-demi-baris (reveal) di atas status line berputar, lalu —
// setelah logo terlihat PENUH — menahan ±0.4 dtk (HOLD_MS) sebelum membersihkan,
// supaya user sempat melihat mark-nya walau phase-nya cepat selesai. Terakhir
// restore kursor + clear-below, scrollback tetap steril seperti spinner lama.
//
// Best-effort & TTY-only: non-TTY / terminal sempit / stderr rusak jatuh ke
// spinner teks biasa (atau no-op). Target di stderr supaya stdout one-shot/--json
// tetap murni mesin.

import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs } from "../render/theme.ts"
import { BOOT_LOGO_ROWS, BOOT_LOGO_WIDTH, paintLogoRow } from "./boot-logo.ts"
import { createSpinner, type SpinnerOptions } from "./spinner.ts"
import { acquireTransientPaint, paintWrite } from "./statusline.ts"

export interface BootScreen {
  update: (message: string) => void
  stop: (finalMessage?: string) => void
  success: (message: string) => void
  error: (message: string) => void
}

/** Jeda setelah logo penuh terlihat, sebelum di-clear / transisi. */
const HOLD_MS = 400

/**
 * Boot screen animasi logo.
 *
 * Semantik `delayMs`/`intervalMs` sama dengan `createSpinner`: delay menahan
 * frame pertama (fase cepat seperti cek update); interval mengatur kecepatan
 * reveal (typewriter) sekaligus spinner status.
 */
export function createBootScreen(initialMessage = "", opts: SpinnerOptions = {}): BootScreen {
  const isTTY = process.stderr.isTTY
  const cols = process.stderr.columns || 80
  // Terminal terlalu sempit untuk logo → pakai spinner teks biasa.
  if (!isTTY || cols < BOOT_LOGO_WIDTH + 2) {
    return createSpinner(initialMessage, opts)
  }

  const intervalMs = opts.intervalMs ?? 50
  const delayMs = opts.delayMs ?? 0
  const leftPad = Math.max(1, Math.floor((cols - BOOT_LOGO_WIDTH) / 2))

  let message = sanitizeAnsiLine(initialMessage)
  let frameIdx = 0
  let revealed = 0
  // Timestamp saat semua baris logo pertama kali tampil penuh (untuk hitung hold).
  let revealedAt: number | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let delayTimer: ReturnType<typeof setTimeout> | undefined
  let holdTimer: ReturnType<typeof setTimeout> | undefined
  let owned: { release(): void } | null = null
  let painted = false
  let stopped = false

  // Gambar ulang seluruh blok dari posisi tersimpan (idempoten). `\x1b[u`
  // kembalikan kursor ke titik `\x1b[s` (atas logo), lalu semua baris revealed +
  // status line ditulis dari atas — reveal "mengetik ke bawah", bukan geser.
  const paint = (): void => {
    let out = "\x1b[u"
    for (let i = 0; i < revealed; i++) {
      out += `${paintLogoRow(BOOT_LOGO_ROWS[i]!, leftPad)}\x1b[K\n`
    }
    const frame = c.info(glyphs.spinnerFrames[frameIdx % glyphs.spinnerFrames.length]!)
    frameIdx++
    out += `\r${" ".repeat(leftPad)}${frame} ${message}\x1b[K`
    paintWrite(out)
    painted = true
    if (revealed >= BOOT_LOGO_ROWS.length && revealedAt === null) revealedAt = Date.now()
  }

  const start = (): void => {
    if (stopped || timer || delayTimer) return
    if (delayMs > 0) {
      delayTimer = setTimeout(() => {
        delayTimer = undefined
        start()
      }, delayMs)
      try {
        ;(delayTimer as unknown as { unref?: () => void }).unref?.()
      } catch {}
      return
    }
    // Simpan posisi (atas blok) + sembunyikan kursor, lalu klaim transient.
    paintWrite("\x1b[?25l\x1b[s")
    owned = acquireTransientPaint("boot", paint)
    if (revealed === 0) revealed = 1
    paint()
    timer = setInterval(() => {
      if (stopped) return
      if (revealed < BOOT_LOGO_ROWS.length) revealed++
      paint()
    }, intervalMs)
  }

  const clearTimers = (): void => {
    if (delayTimer) {
      clearTimeout(delayTimer)
      delayTimer = undefined
    }
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  /** Pembersihan akhir: lepas owner + clear blok + (opsional) baris final. */
  const finalize = (finalLine?: string): void => {
    if (owned) {
      owned.release()
      owned = null
    }
    if (painted) {
      paintWrite("\x1b[u\x1b[J\x1b[?25h")
    }
    painted = false
    if (finalLine) process.stderr.write(`${finalLine}\n`)
  }

  const finishWithHold = (finalLine?: string): void => {
    if (stopped) return
    stopped = true
    clearTimers()
    // Belum pernah melukis (masih dalam delay) → tak ada jejak, langsung final.
    if (!painted) {
      if (finalLine) process.stderr.write(`${finalLine}\n`)
      return
    }
    // Pastikan logo penuh terlihat; spinner tetap berputar selama hold 0.4 dtk.
    if (revealed < BOOT_LOGO_ROWS.length) {
      revealed = BOOT_LOGO_ROWS.length
      paint()
    }
    const wait = Math.max(0, HOLD_MS - (revealedAt ? Date.now() - revealedAt : HOLD_MS))
    if (wait > 0) {
      holdTimer = setTimeout(() => finalize(finalLine), wait)
      try {
        ;(holdTimer as unknown as { unref?: () => void }).unref?.()
      } catch {}
    } else {
      finalize(finalLine)
    }
  }

  start()

  return {
    update(newMessage: string): void {
      message = sanitizeAnsiLine(newMessage)
    },
    stop(finalMessage?: string): void {
      finishWithHold(finalMessage ? sanitizeAnsiLine(finalMessage) : undefined)
    },
    success(msg: string): void {
      finishWithHold(`${c.green(glyphs.check)} ${sanitizeAnsiLine(msg)}`)
    },
    error(msg: string): void {
      finishWithHold(`${c.red(glyphs.cross)} ${sanitizeAnsiLine(msg)}`)
    },
  }
}
