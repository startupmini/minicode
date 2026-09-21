import type { UiBus } from "../contract.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs } from "../render/theme.ts"
import { displayWidth, truncateToWidth } from "../render/width.ts"
import { acquireTransientPaint, paintWrite, registerStatusLine } from "../runtime/statusline.ts"

// Turn status line — satu baris transient di stderr, hidup hanya pada fase
// turn yang TIDAK memproduksi teks (berpikir / tool berjalan). Teks model
// adalah output utama; garis status tidak pernah menimpa area teks.
//
// Garis memakai ikon + titik animasi sebagai heartbeat — sinyal "masih
// hidup" tanpa teks panjang. Tanpa ini turn yang stall terlihat mati diam.
//
// Lifecycle deterministik:
//   turn:started          → state nyala, BELUM melukis. Lukisan mulai pada
//                           reasoning/execution pertama, ATAU grace 250ms bila
//                           belum ada event (keheningan total terasa macet).
//   reasoning (extension) → "Thinking", KECUALI fase menulis sudah dimulai
//                           (latch textSeen) — interleave reasoning/teks model
//                           reasoning takkan strobo on/off.
//   execution:started     → label kerja nyata (nama tool + target), latch dibuka
//   provider:text         → garis HILANG + latch (teks mengalir)
//   execution:completed   → kembali "Thinking" bila masih fase sunyi
//   turn:completed        → bersih + reset
//   endTurn()             → bersih + reset, DIPANGGIL DRIVER setelah turn
//                           settle apa pun (kernel TIDAK emit turn:completed
//                           pada gagal/abort — tanpa ini garis status basi
//                           melukis di atas prompt idle setelah error/Ctrl+C)
// Output lain memakai runWithoutStatus() (suspend sesaat → resume bila aturan
// masih terpenuhi), jadi garis tidak pernah tertinggal di scrollback.
// Kursor disembunyikan selama garis melukis agar tak terbaca sebagai bagian
// indikator (pola spinner.ts). Didaftarkan sekali per proses — aman
// dipanggil berulang karena tiap attach me-restore di stopPaint/endTurn.
process.on("exit", () => {
  try {
    if (process.stderr.isTTY) process.stderr.write("\x1b[?25h")
  } catch {}
})

export interface TurnStatusHandle {
  detach(): void
  /** Bersihkan + reset garis; aman dipanggil kapan pun (idempotent). */
  endTurn(): void
}

/** Durasi ringkas — dipertahankan untuk kompatibilitas test eksternal. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
}

export function attachTurnStatus(
  bus: UiBus,
  opts: {
    initialModel?: string
    getModel?: () => string | undefined
    /**
     * Teks statistik tambahan (mis. token/biaya sesi) — DI dari composition
     * root agar UI tak perlu impor lapisan policy/usage. Undefined = mati
     * (default hemat: shell tetap bersih).
     */
    getStats?: () => string | undefined
  } = {},
): TurnStatusHandle {
  if (!process.stderr.isTTY) return { detach: () => {}, endTurn: () => {} }
  const isWinLegacy =
    process.platform === "win32" &&
    !(
      process.env.WT_SESSION ||
      process.env.TERM_PROGRAM ||
      process.env.ANSICON ||
      process.env.ConEmuANSI
    )
  if (isWinLegacy) return { detach: () => {}, endTurn: () => {} }

  let intervalId: ReturnType<typeof setInterval> | undefined
  let fi = 0
  // State mesin garis — interval hanya menulis ulang label terkini.
  let turnOn = false
  let textOn = false
  // Latch fase: sekali teks mengalir, reasoning susulan (interleave chunk
  // model reasoning) TIDAK menghidupkan garis lagi sampai tool berikutnya.
  // Tanpa ini garis strobo on/off mengikuti alternasi chunk — terlihat
  // "kebalik": berisik saat menulis, padahal harusnya hening.
  let textSeen = false
  // Grace timer: turn:started tidak langsung melukis (jendela catatan router),
  // tapi keheningan total >250ms terasa macet — tampilkan Thinking bila belum
  // ada event kerja. Turn cepat (<250ms) tak pernah nge-flash.
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let label = "Thinking"
  // Kecepatan reasoning: diukur dari frekuensi chunk reasoning yang masuk.
  // Interval animasi mengikuti — cepat bila model berpikir cepat.
  let intervalMs = 150
  let lastReasoningMs: number | null = null
  const recentDeltas: number[] = []
  // Kepemilikan transient stderr selama interval hidup — lihat statusline.ts.
  let owned: { release(): void } | null = null

  const shouldPaint = (): boolean => turnOn && !textOn
  const paint = () => {
    let extra = ""
    try {
      const s = opts.getStats?.()
      if (s) extra = ` · ${s}`
    } catch {}
    // Titik animasi eksplisit, ganti tiap 3 tick (~0,4 detik pada 120ms):
    // sinyal "masih hidup" yang tak ambigu tapi tenang. Tak pernah bare:
    // selalu ≥1 titik. Titik dipisah spasi ("· · ·") agar tak mepet ikon.
    // Ikon thinking SPARKLE ✦ kelip lambat: putih ↔ abu tiap 3 tick
    // (glow halus, bukan strobo) — glyph monokrom jadi warna ANSI terlihat;
    // kecepatan refresh mengikuti intervalMs yang adaptif terhadap
    // kecepatan reasoning model (minimum 120ms).
    const tickGroup = Math.floor(fi / 3)
    const dots = Array(1 + (tickGroup % 3))
      .fill(glyphs.dot)
      .join(" ")
    // Garis dilukis ke stderr via paintWrite — ukur dari stderr (jatuh ke
    // stdout bila tak ada). stdout|pipe + stderr TTY memakai fallback 80 yang
    // salah: terminal 120 terpotong berlebih, terminal 40 wrap sendiri.
    const cols = process.stderr.columns ?? process.stdout.columns ?? 80
    // Sinyal "alive" (spark pulse) kini MILIK FOOTER, bukan thinking line:
    // satu sumber agar tak ada dua denyut. Thinking = titik saja; tool line
    // tetap pakai spinner braille (itu progres, bukan spark).
    const body =
      label === "Thinking"
        ? `${dots}`
        : `${c.info(glyphs.spinnerFrames[fi % glyphs.spinnerFrames.length]!)} ${label}  ${dots}`
    const full = body + extra
    // Terminal sangat sempit: potongan label bisa tinggal 1 huruf ("t") —
    // dalam kasus itu tampilkan titiknya saja daripada label rusak.
    // Terminal normal: potong biasa (label terpotong tetap informatif).
    const maxW = Math.max(4, cols - 1)
    const shown =
      displayWidth(full) <= maxW ? full : maxW <= 12 ? dots : truncateToWidth(full, maxW)
    paintWrite(`\r\x1b[2K${shown}`)
    fi++
  }
  const stopPaint = () => {
    if (owned) {
      owned.release()
      owned = null
    }
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = undefined
    }
    paintWrite("\r\x1b[2K")
    // Kembalikan kursor yang disembunyikan saat acquire — tanpa ini terminal
    // terlihat mati (kursor hilang permanen lebih buruk dari flicker).
    try {
      paintWrite("\x1b[?25h")
    } catch {}
  }
  const restartInterval = () => {
    if (!intervalId) return
    clearInterval(intervalId)
    intervalId = setInterval(paint, intervalMs)
  }

  const clearGrace = () => {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = undefined
    }
  }
  const startPaint = (next: string) => {
    label = next
    if (!shouldPaint()) return
    clearGrace()
    if (!intervalId) {
      fi = 0
      // Repaint segera setelah tulis asing dikomit (lihat statusline.ts).
      owned = acquireTransientPaint("turn", () => {
        if (shouldPaint()) startPaint(label)
      })
      // Sembunyikan kursor selama melukis agar tak terbaca sebagai bagian
      // indikator ("✦···|"); dikembalikan di stopPaint.
      try {
        paintWrite("\x1b[?25l")
      } catch {}
      paint()
      intervalId = setInterval(paint, intervalMs)
    } else paint()
  }
  const resetTurn = () => {
    turnOn = false
    textOn = false
    textSeen = false
    label = "Thinking"
    intervalMs = 150
    lastReasoningMs = null
    recentDeltas.length = 0
    clearGrace()
    stopPaint()
  }

  // Dipakai renderer via runWithoutStatus: hentikan repaint sebentar, lalu
  // hidupkan lagi bila aturan masih terpenuhi. Saat garis SEDANG TIDAK melukis
  // (mis. teks mengalir), suspend tidak menulis apa pun — \r\x1b[2K yang
  // serampangan bisa memotong baris parsial milik penulis lain.
  let paused = false
  const handle = {
    suspend() {
      paused = !!intervalId
      if (intervalId) stopPaint()
    },
    resume() {
      if (paused && shouldPaint()) startPaint(label)
      paused = false
    },
  }
  registerStatusLine(handle)

  const toolLabel = (e: { execution: { call: { name: string; args?: unknown } } }): string => {
    const name = e.execution.call.name
    const args = (e.execution.call.args ?? {}) as Record<string, unknown>
    let target = ""
    if (typeof args.path === "string") target = args.path
    else if (typeof args.file === "string") target = args.file
    else if (typeof args.cmd === "string") target = args.cmd
    else if (typeof args.command === "string") target = args.command
    // Potong panjang di sini (batas 80/200), potong LEBAR per-paint agar resize
    // langsung berefek. truncateToWidth: tak belah SGR/surrogate — slice mentah
    // bisa mendarat di tengah `\x1b[31m` dan menyisakan escape gantung yang
    // lolos paintWrite.
    // Nama + argumen datang dari model (tak terpercaya): sanitasi sebelum
    // masuk paintWrite — truncateToWidth memotong lebar, bukan sekuens kontrol.
    const cleanName = sanitizeAnsiLine(name)
    const cleanTarget =
      target.length > 80
        ? truncateToWidth(sanitizeAnsiLine(target), 80, "")
        : sanitizeAnsiLine(target)
    const label2 = cleanTarget ? `${cleanName} ${cleanTarget}` : cleanName
    return label2.length > 200 ? truncateToWidth(label2, 200, "") : label2
  }

  const detach = [
    bus.on("turn:started", () => {
      turnOn = true
      textOn = false
      textSeen = false
      label = "Thinking"
      // Sengaja tidak langsung melukis — jendela sebelum event pertama (mis.
      // catatan [router] di awal stream) dibiarkan polos agar tidak ada tulis
      // asing yang bisa tertimpa/terhapus garis ini. Grace 250ms menutup
      // lubangnya: keheningan lebih lama terasa macet, bukan sopan.
      clearGrace()
      graceTimer = setTimeout(() => {
        graceTimer = undefined
        // Hanya bila belum ada yang melukis (tool duluan menang) dan masih
        // dalam fase sunyi — jangan timpa label tool / fase teks.
        if (!intervalId && shouldPaint() && label === "Thinking") startPaint("Thinking")
      }, 250)
    }),
    bus.on("provider:text", () => {
      // Teks model = output utama; garis status tidak boleh menimpa area teks.
      // Latch: reasoning susulan (interleave) tidak menghidupkan lagi.
      textOn = true
      textSeen = true
      clearGrace()
      stopPaint()
    }),
    bus.on("provider:extension", (e: { kind: string }) => {
      if (e.kind === "reasoning") {
        // Fase menulis sudah dimulai → tetap sembunyi (anti-strobo).
        if (textSeen) return
        // Adaptasi kecepatan: ukur jarak antar chunk reasoning
        const now = Date.now()
        if (lastReasoningMs != null) {
          const d = now - lastReasoningMs
          if (d > 10 && d < 2000) {
            recentDeltas.push(d)
            if (recentDeltas.length > 6) recentDeltas.shift()
            const avg = recentDeltas.reduce((a, b) => a + b, 0) / recentDeltas.length
            const nextMs = avg < 120 ? 120 : avg < 250 ? 150 : avg < 500 ? 220 : 320
            if (nextMs !== intervalMs) {
              intervalMs = nextMs
              restartInterval()
            }
          }
        }
        lastReasoningMs = now
        textOn = false
        startPaint("Thinking")
      } else if (e.kind === "error") stopPaint()
    }),
    bus.on("execution:started", (e: { execution: { call: { name: string; args?: unknown } } }) => {
      // Fase kerja baru: latch teks dibuka lagi (thinking antar-tool tampil).
      textOn = false
      textSeen = false
      startPaint(toolLabel(e))
    }),
    bus.on("execution:completed", () => {
      // Tool selesai: kembali ke "Thinking" selama model belum mengeluarkan teks.
      textSeen = false
      if (shouldPaint()) startPaint("Thinking")
    }),
    bus.on("turn:completed", resetTurn),
  ]

  return {
    endTurn: resetTurn,
    detach: () => {
      resetTurn()
      registerStatusLine(null)
      for (const d of detach) d()
    },
  }
}
