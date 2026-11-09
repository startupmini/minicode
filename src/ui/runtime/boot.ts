// Boot screen — logo minicode dengan reveal typewriter selama phase startup.
//
// Menggantikan spinner satu-baris di cli/index.ts (cek update + setup sesi).
// Melukis block-art logo baris-demi-baris (reveal) di atas status line berputar,
// lalu membersihkan SEMUAnya (restore kursor + clear-below) saat phase selesai —
// jadi scrollback tetap steril, sama seperti spinner lama.
//
// Best-effort & TTY-only: non-TTY / terminal sempit / stderr rusak jatuh ke
// spinner teks biasa (atau no-op). Target di stderr supaya stdout one-shot/--json
// tetap murni mesin.

import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs } from "../render/theme.ts"
import { BOOT_LOGO_ROWS, BOOT_LOGO_WIDTH } from "./boot-logo.ts"
import { createSpinner, type SpinnerOptions } from "./spinner.ts"
import { acquireTransientPaint, paintWrite } from "./statusline.ts"

export interface BootScreen {
  update: (message: string) => void
  stop: (finalMessage?: string) => void
  success: (message: string) => void
  error: (message: string) => void
}

/**
 * Boot screen animasi logo.
 *
 * `delayMs`/`intervalMs` semantiknya sama dengan `createSpinner`: delay menahan
 * frame pertama (fase cepat seperti cek update), interval mengatur kecepatan
 * reveal row (typewriter) sekaligus spinner status.
 */
export function createBootScreen(initialMessage = "", opts: SpinnerOptions = {}): BootScreen {
  const isTTY = process.stderr.isTTY
  const cols = process.stderr.columns || 80
  // Terminal terlalu sempit untuk logo → pakai spinner teks biasa (tetap
  // informatif, tanpa luber melipat logo).
  if (!isTTY || cols < BOOT_LOGO_WIDTH + 2) {
    return createSpinner(initialMessage, opts)
  }

  const intervalMs = opts.intervalMs ?? 110
  const delayMs = opts.delayMs ?? 0
  const leftPad = Math.max(1, Math.floor((cols - BOOT_LOGO_WIDTH) / 2))
  const pad = " ".repeat(leftPad)

  let message = sanitizeAnsiLine(initialMessage)
  let frameIdx = 0
  let revealed = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let delayTimer: ReturnType<typeof setTimeout> | undefined
  let owned: { release(): void } | null = null
  let painted = false
  let stopped = false

  const logoLine = (row: string): string => `${pad}${c.gray(row)}`

  // Gambar ulang seluruh blok dari posisi tersimpan (idempoten). `\x1b[u`
  // mengembalikan kursor ke titik `\x1b[s` (atas logo) tiap tick, lalu semua
  // baris revealed + status line ditulis dari atas — reveal jadi "mengetik ke
  // bawah", bukan menggeser.
  const paint = (): void => {
    let out = "\x1b[u"
    for (let i = 0; i < revealed; i++) {
      out += `${logoLine(BOOT_LOGO_ROWS[i]!)}\x1b[K\n`
    }
    const frame = c.info(glyphs.spinnerFrames[frameIdx % glyphs.spinnerFrames.length]!)
    frameIdx++
    out += `\r${pad}${frame} ${message}\x1b[K`
    paintWrite(out)
    painted = true
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
    // Simpan posisi (atas blok) + sembunyikan kursor. Kepemilikan transient
    // ditaruh SETELAH save agar paintWrite pertama milik kita sendiri.
    paintWrite("\x1b[?25l\x1b[s")
    owned = acquireTransientPaint("boot", paint)
    // Frame pertama langsung tampilkan satu baris (reveal mulai terlihat).
    if (revealed === 0) revealed = 1
    paint()
    timer = setInterval(() => {
      if (stopped) return
      if (revealed < BOOT_LOGO_ROWS.length) revealed++
      paint()
    }, intervalMs)
  }

  const teardown = (): void => {
    if (delayTimer) {
      clearTimeout(delayTimer)
      delayTimer = undefined
    }
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
    if (owned) {
      owned.release()
      owned = null
    }
    // Hanya bersihkan bila pernah melukis (delay belum selesai = tak ada jejak).
    if (painted) {
      paintWrite("\x1b[u\x1b[J\x1b[?25h")
    }
    painted = false
  }

  start()

  return {
    update(newMessage: string): void {
      message = sanitizeAnsiLine(newMessage)
    },
    stop(finalMessage?: string): void {
      if (stopped) return
      stopped = true
      teardown()
      if (finalMessage) process.stderr.write(`${sanitizeAnsiLine(finalMessage)}\n`)
    },
    success(msg: string): void {
      if (stopped) return
      stopped = true
      teardown()
      process.stderr.write(`${c.green(glyphs.check)} ${sanitizeAnsiLine(msg)}\n`)
    },
    error(msg: string): void {
      if (stopped) return
      stopped = true
      teardown()
      process.stderr.write(`${c.red(glyphs.cross)} ${sanitizeAnsiLine(msg)}\n`)
    },
  }
}
