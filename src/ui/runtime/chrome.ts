// Footer lengket (sticky) — chrome terminal REPL.
//
// Mengunci 2 baris dasar terminal untuk footer (blank + status, tanpa garis)
// lewat scroll-region DECSTBM (`\x1b[1;{top}r`): output turn hanya di area
// atas, footer tidak pernah ikut scroll. Sama dengan kontrak transient
// statusline.ts: TIDAK pernah melempar, fail-closed, self-disable bila runtime
// bermasalah, dan selalui reset region pada detach/exit agar terminal tidak
// ditinggalkan rusak.
//
// Gaya `MINICODE_FOOTER`:
//   off    → tanpa footer sama sekali (dan pipa selalu none: 0 byte)
//   print  → footer dicetak sebagai baris scrollback biasa (tidak lengket)
//   sticky → paksa lengket (bila terminal mampu; selain itu jatuh ke print)
//   auto   → lengket bila mampu, print bila tidak (DEFAULT)
//
// Mengapa DECSTBM dan bukan alternate screen: alternaate screen menyembunyikan
// seluruh scrollback pengguna — melanggar kontrak shell-native. Scroll-region
// justru TIDAK memindahkan scrollback: region adalah jendela scroll TAMBAHAN,
// konten lama tetap utuh di atasnya.
import { type FooterStatus, renderFooter } from "../footer.ts"

export type FooterMode = "off" | "print" | "sticky" | "auto"

export interface FooterChromeOptions {
  /** Status yang dirender tiap present — di-resolve pemanggil (mode live, cwd). */
  status: () => FooterStatus
  /** Non-interactive (exec/pipe): pemanggil mematikan footer total. */
  enabled?: boolean
}

export interface FooterChrome {
  readonly mode: "sticky" | "print" | "none"
  /** Baris dasar yang wajib disisakan editor/prompt (sticky=3, lainnya 0). */
  reserveRows(): number
  /**
   * Panggil tepat sebelum prompt idle: sticky → pastikan region + repaint
   * footer + posisikan kursor di baris input; print → cetak footer sebagai
   * baris scrollback. Idempotent; tidak pernah melempar.
   */
  present(): void
  /**
   * Repaint footer DI TEMPAT tanpa memindahkan kursor — dipakai perubahan
   * status saat prompt aktif (mis. Shift+Tab ganti mode). Sticky: repaint 3
   * baris dasar; print/none: no-op (footer berikutnya dicetak di idle).
   */
  refresh(): void
  /**
   * Tandai turn berjalan/selesai. Busy → spark di footer berdenyut (timer
   * repaint ~150ms, fail-safe: tak pernah melempar, mati sendiri bila runtime
   * rewel); idle → spark redup statis. Dipanggil dari controller turn, jadi
   * abort (Ctrl+C/Esc) otomatis kembali redup lewat finally.
   */
  setBusy(busy: boolean): void
  /**
   * Reset region + restore scrollback, lalu cetak footer sekali sebagai baris
   * normal. Panggil di SEMUA jalur keluar (close/exit/SIGINT/on("exit")).
   */
  detach(): void
}

// ── State pemilih mode (module-level agar input.ts bisa baca jatah baris) ──

let activeReserve = 0

/** Jatah baris dasar yang sedang dipakai chrome (0 bila tidak lengket). */
export function footerReserveRows(): number {
  return activeReserve
}

const RESET_REGION = "\x1b[r"
const CLEAR = "\x1b[2K"
const SYNC_START = "\x1b[?2026h"
const SYNC_END = "\x1b[?2026l"
// DECSC/DECRC (save/restore cursor). Dipakai agar penulisan direct-address
// footer + DECSTBM tidak pernah menggeser posisi ketik: sebagian terminal
// (emulasi VT100) memindahkan kursor ke home saat scroll-region di-set, dan
// `refresh()` dipanggil saat prompt aktif — tanpa save/restore, repaint
// berikutnya menimpa baris footer.
const SAVE_CURSOR = "\x1b7"
const RESTORE_CURSOR = "\x1b8"

function isWinLegacy(): boolean {
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

/** Sticky butuh VT DECSTBM + baris cukup (2 dasar + ≥9 area kerja). */
function capable(rows: number): boolean {
  if (isWinLegacy()) return false
  if (rows < 10) return false
  return true
}

/** Posisi 1-indexed dari 2 baris dasar (blank + status, tanpa garis). */
const FOOTER_ROWS = 2

export function createFooterChrome(opts: FooterChromeOptions): FooterChrome {
  // Pipa/redirect: nol byte — kontrak deterministik machine output.
  if (!opts.enabled || !process.stdout.isTTY) return makeNone()
  const env = (process.env.MINICODE_FOOTER ?? "auto") as string
  const want: FooterMode = env === "off" || env === "print" || env === "sticky" ? env : "auto"
  const rows = () => process.stdout.rows || 24

  const sticky = want === "sticky" || want === "auto"
  const useSticky = sticky && capable(rows())
  // sticky yang diminta tapi terminal tak mampu → print (tetap ada footer,
  // hanya tidak lengket) — bukan none.
  const mode: "sticky" | "print" | "none" =
    !sticky && want === "off" ? "none" : useSticky ? "sticky" : "print"
  if (mode === "none") return makeNone()
  if (mode === "print") return makePrint(opts)

  // ── Sticky ──
  let regionOn = false
  let detached = false
  let resizeBound: (() => void) | null = null
  // Pulse spark: frame naik saat busy. Timer HANYA hidup selama turn; idle =
  // frame 0 (spark redup). Fail-safe: callback timer dibungkus try/catch dan
  // tak pernah menyentuh jalur turn — animasi mati, turn tetap jalan.
  let frame = 0
  let pulseTimer: ReturnType<typeof setInterval> | undefined
  const stopPulse = (): void => {
    if (pulseTimer) {
      clearInterval(pulseTimer)
      pulseTimer = undefined
    }
  }

  // Lukis 2 baris dasar TANPA menggeser kursor pemanggil (DECSC/DECRC).
  // Penting untuk refresh() saat prompt aktif: repaint footer tidak boleh
  // memindahkan posisi ketik, kalau tidak render berikutnya menimpa footer.
  const paintFooter = (r: number): void => {
    const cols = process.stdout.columns || 80
    const [status] = renderFooter({ ...opts.status(), sparkFrame: frame }, cols)
    process.stdout.write(SAVE_CURSOR)
    // Blank di r-1, status di r (tanpa garis — clean).
    process.stdout.write(`\x1b[${r - 1};1H${CLEAR}`)
    process.stdout.write(`\x1b[${r};1H${CLEAR}${status}`)
    process.stdout.write(RESTORE_CURSOR)
  }

  const enableRegion = (r: number): void => {
    if (detached) return
    // DECSTBM memindahkan kursor ke home di sebagian emulasi VT — simpan/
    // kembalikan agar set region tidak melompatkan kursor ketik.
    process.stdout.write(SAVE_CURSOR)
    // Region atas = 1..r-2 (footer blank+status menempati r-1..r).
    process.stdout.write(`\x1b[1;${r - 2}r`)
    process.stdout.write(RESTORE_CURSOR)
    regionOn = true
  }

  const onResize = (): void => {
    try {
      if (!regionOn || detached) return
      const r = rows()
      if (r < 10) {
        // Terlalu pendek: lepas region agar tidak aneh; present berikutnya
        // akan me-reset ulang bila sudah muat. DECSTBM reset juga bisa
        // memindahkan kursor → save/restore seperti enableRegion.
        process.stdout.write(SAVE_CURSOR)
        process.stdout.write(RESET_REGION)
        process.stdout.write(RESTORE_CURSOR)
        regionOn = false
        return
      }
      enableRegion(r)
      paintFooter(r)
    } catch {}
  }

  const handle: FooterChrome = {
    mode,
    reserveRows() {
      // Setelah detach, tidak ada jatah lagi (reset region sudah lepas).
      return detached ? 0 : FOOTER_ROWS
    },
    refresh() {
      if (detached) return
      try {
        const r = rows()
        if (r < 10 || !regionOn) return
        paintFooter(r)
      } catch {}
    },
    setBusy(busy: boolean) {
      if (detached) return
      try {
        if (busy) {
          if (pulseTimer) return
          // Frame naik pelan (2 tick/frame) agar glow halus, bukan strobo.
          pulseTimer = setInterval(() => {
            try {
              frame += 1
              const r = rows()
              if (regionOn && r >= 10) paintFooter(r)
            } catch {
              // Runtime rewel: matikan animasi, jangan pernah gagalkan turn.
              stopPulse()
            }
          }, 150)
        } else {
          stopPulse()
          frame = 0
          const r = rows()
          if (regionOn && r >= 10) paintFooter(r) // kembali redup seketika
        }
      } catch {}
    },
    present() {
      if (detached) return
      try {
        const r = rows()
        if (r < 10) return // terminal terlalu pendek — jangan sentuh apa pun
        if (!regionOn) {
          enableRegion(r)
          if (!resizeBound) {
            resizeBound = onResize
            try {
              process.stdout.on("resize", onResize)
            } catch {}
          }
        }
        // Satu frame sinkron agar repaint footer tidak robek.
        process.stdout.write(SYNC_START)
        paintFooter(r)
        // Kursor ke baris input (tepat di atas blank footer — kini 2 baris total).
        process.stdout.write(`\x1b[${r - 2};1H`)
        process.stdout.write(SYNC_END)
      } catch {}
    },
    detach() {
      if (detached) return
      detached = true
      stopPulse()
      try {
        if (resizeBound) {
          try {
            process.stdout.off("resize", onResize)
          } catch {}
          resizeBound = null
        }
        if (regionOn) {
          process.stdout.write(RESET_REGION)
          regionOn = false
        }
        if (activeReserve === FOOTER_ROWS) activeReserve = 0
        // Cetak footer sekali sebagai baris normal agar layar terakhir tetap
        // memberi konteks tanpa region.
        if (mode === "sticky") {
          const cols = process.stdout.columns || 80
          const [status] = renderFooter(opts.status(), cols)
          process.stdout.write(`\n${status}\n`)
        }
      } catch {}
    },
  }
  activeReserve = FOOTER_ROWS
  return handle
}

function makePrint(opts: FooterChromeOptions): FooterChrome {
  activeReserve = 0
  const handle: FooterChrome = {
    mode: "print",
    reserveRows() {
      return 0
    },
    refresh() {},
    setBusy() {},
    present() {
      try {
        if (!process.stdout.isTTY) return
        const cols = process.stdout.columns || 80
        const [status] = renderFooter(opts.status(), cols)
        process.stdout.write(`\n${status}\n`)
      } catch {}
    },
    detach() {},
  }
  return handle
}

function makeNone(): FooterChrome {
  activeReserve = 0
  return {
    mode: "none",
    reserveRows: () => 0,
    present() {},
    refresh() {},
    setBusy() {},
    detach() {},
  }
}
