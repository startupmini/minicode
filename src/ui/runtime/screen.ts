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
import { type Cell, diffCellLine, parseCells } from "../render/cells.ts"
import { truncateToWidth } from "../render/width.ts"
import {
  __resetTransientForTest,
  beginInteractiveScreen,
  consumeScreenDrift,
} from "./statusline.ts"

const ENTER = "\x1b[?1049h"
const EXIT = "\x1b[?1049l"
const HOME = "\x1b[H"
const CLEAR_ALL = "\x1b[2J"
/** Reset atribut (warna/efek) + tampilkan kursor — ditulis saat exit supaya
 * prompt shell kembali bersih (tidak ada sisa warna frame terakhir / kursor
 * tersembunyi yang membuat terminal "berantakan" setelah Ctrl+D). */
const RESET_ATTRS = "\x1b[0m"
const SHOW_CURSOR = "\x1b[?25h"
// Reset scroll-region — unconditional + idempoten: region aktif peninggalan
// akan memotong paint fullscreen; tulis SEBELUM enter dan SESUDAH exit agar
// buffer utama kembali steril apa pun yang terjadi di dalam.
// region aktif akan memotong paint fullscreen modal; tulis SEBELUM enter dan
// SESUDAH exit agar buffer utama kembali steril apa pun yang terjadi di dalam.
const RESET_REGION = "\x1b[r"
const SYNC_START = "\x1b[?2026h"
const SYNC_END = "\x1b[?2026l"
/** Satu sekuens exit atomik: reset atribut → tampilkan kursor → tutup sync
 * update → keluar alt-screen → reset region. Ditulis SEBAGAI SATU tulis agar
 * terminal tak pernah tertinggal setengah pulih, dan agar jumlah writer di
 * berkas ini tidak melewati batas inventaris OAP-008 (writer-inventory.test.ts
 * menolak penulis yang bertambah diam-diam). */
const EXIT_SEQUENCE = RESET_ATTRS + SHOW_CURSOR + SYNC_END + EXIT + RESET_REGION
/** Ekspor untuk pemanggil yang melukis kursor di luar paint() (app.ts) —
 * kursor WAJIB di dalam blok sync yang sama dengan framenya (TUI-007). */
export const SYNC_UPDATE_START = SYNC_START
export const SYNC_UPDATE_END = SYNC_END

let depth = 0
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // Jaring terakhir (best-effort, sinkron): modal yatim mengunci layar di
  // buffer alt. `kill -9` tak tercakup — ketik `reset` (residual kontrak).
  // CATATAN TUI-001: handler `exit` Node TIDAK jalan pada SIGTERM/SIGHUP
  // default — restore pada sinyal fatal adalah tanggung jawab pemilik sesi
  // interaktif (TuiApp) yang memasang handler sinyalnya sendiri per-run.
  process.on("exit", () => {
    if (depth > 0) {
      try {
        // Sekuens exit lengkap (reset atribut + kursor + sync + alt-screen +
        // region) — jaring terakhir `kill`/`exit` tak langsung.
        process.stdout.write(EXIT_SEQUENCE)
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
  /** Lukis frame penuh; exception writer dipropagasikan agar owner menutup sesi. */
  paint(lines: string[], cursor?: { row: number; col: number }): void
  /**
   * Pindahkan kursor SAJA, tanpa menyentuh isi frame. Dipakai fast path
   * panah/Home/End: pergerakan kursor tak mengubah satu sel pun, jadi
   * merakit ulang frame penuh hanya membuang kerja.
   */
  moveCursor(row: number, col: number): void
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
    moveCursor: () => {},
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
      // ENTER mungkin sudah terkirim sebelum writer melempar; pulihkan
      // buffer utama sebelum menyatakan terminal tidak mampu.
      try {
        process.stdout.write(EXIT)
      } catch {}
      try {
        process.stdout.write(RESET_REGION)
      } catch {}
      return nullScreen()
    }
  }
  depth++
  // Layar memegang terminal: tahan SEMUA painter transient stderr (spinner
  // "Menyiapkan sesi…", garis status turn) selama alt-screen hidup — satu tick
  // `\r\x1b[2K` dari stderr menghapus baris prompt wizard sehingga user baru
  // melihat CLI "macet". Release idempoten per handle (nested dihitung);
  // ditahan juga untuk lapisan nested supaya close dalam tak membocorkan
  // painter ke tengah dialog luar.
  const releaseHold = beginInteractiveScreen()
  // Region terakhir handle ini (siklus hidup popup komposit) — per-handle
  // (closure), bukan global: popup nested (effort di dalam manager) melacak
  // areanya masing-masing.
  let lastRegion: { top: number; height: number } | null = null
  // [perf] Frame LOGIS tetap penuh (`rows` baris — kontrak I1); yang di-diff
  // hanyalah PENULISAN FISIK. Diff dilakukan per SEL (bukan per baris): prefix
  // yang identik dilewati, lalu ekor dari kolom berbeda pertama ditulis ulang
  // setelah EL (lihat diffCellLine). Satu huruf berubah di prompt panjang hanya
  // menulis ekornya, bukan seluruh baris. Inisialisasi/resize (jumlah
  // baris/kolom berubah) tetap clear penuh.
  // Per-handle (closure): screen baru = diff state baru, konsisten dengan
  // `lastRegion`.
  let lastFrame: string[] | null = null
  let lastCells: Cell[][] | null = null
  let lastCols = 0
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
    paint(lines: string[], cursor?: { row: number; col: number }): void {
      if (closed) return
      // SATU string per frame = SATU `write` ke pipe ConPTY. Sebelumnya frame
      // dipecah 4–5 write (sync-start, tiap baris, kursor, sync-end); di
      // Windows tiap write menyeberangi ConPTY dan biayanya jauh lebih mahal
      // daripada merakit string di JS.
      let out = SYNC_START
      const cols = process.stdout.columns || NULL_COLS
      // Tulis asing ke stderr (diagnostik/hooks) mengotori buffer di balik
      // pelacakan diff; paksa repaint penuh sekali agar tak ada fragmen asing
      // yang menempel di baris yang kebetulan tak berubah.
      const drifted = consumeScreenDrift()
      if (
        !drifted &&
        lastFrame &&
        lastCells &&
        lastFrame.length === lines.length &&
        lastCols === cols
      ) {
        // Diff per sel. Bandingkan string baris dulu (murah); hanya baris yang
        // berubah yang di-parse menjadi sel dan di-diff. Baris tak berubah =
        // nol byte, bukan CUP+EL+seluruh baris.
        for (let r = 0; r < lines.length; r++) {
          const line = lines[r]!
          if (line === lastFrame[r]) continue
          const nextCells = parseCells(line)
          out += diffCellLine(lastCells[r] ?? [], nextCells, r + 1)
          lastCells[r] = nextCells
          lastFrame[r] = line
        }
      } else {
        out += HOME + CLEAR_ALL + lines.join("\r\n")
        lastFrame = lines.slice()
        lastCells = lines.map((line) => parseCells(line))
        lastCols = cols
      }
      // Reset atribut sebelum kursor: run diff bisa berakhir dengan warna
      // aktif, dan kursor yang ditampilkan mewarisi atribut itu.
      out += RESET_ATTRS
      if (cursor) {
        const row = Math.max(1, Math.floor(cursor.row))
        const col = Math.max(1, Math.floor(cursor.col))
        // DECSCUSR `6 q` = bar tegak stabil (tak berkedip): caret tak menutupi
        // karakter di bawahnya (blok penuh), dan lebih tenang = clean & minimal.
        out += `\x1b[?25l\x1b[${row};${col}H\x1b[6 q\x1b[?25h`
      }
      out += SYNC_END
      process.stdout.write(out)
    },
    moveCursor(row: number, col: number): void {
      if (closed) return
      const r = Math.max(1, Math.floor(row))
      const c = Math.max(1, Math.floor(col))
      // Sync block + reset atribut: kursor tak boleh mewarisi warna run
      // sebelumnya, dan perpindahan kursor tak perlu menyentuh satu sel pun.
      process.stdout.write(
        `${SYNC_START}${RESET_ATTRS}\x1b[?25l\x1b[${r};${c}H\x1b[6 q\x1b[?25h${SYNC_END}`,
      )
    },
    paintRegion(lines: string[], topRow: number): void {
      if (closed) return
      // Melukis nol baris = no-op murni (bukan clear): pemanggil yang ingin
      // menghapus memakai clearRegion() eksplisit.
      if (!lines.length) return
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
        // Clamp ke lebar layar: baris lebih lebar memicu auto-wrap dan
        // menggeser seluruh region (AUD-009).
        const row = truncateToWidth(
          i >= 0 && i < h ? ((lines[i] ?? "").split("\n")[0] ?? "") : "",
          this.cols,
        )
        out += `\x1b[${r};1H\x1b[2K${row}`
      }
      out += SYNC_END
      process.stdout.write(out)
      lastRegion = h > 0 ? { top, height: h } : null
      // Region menimpa isi frame di luar pelacakan diff; paksa paint berikutnya
      // clear penuh agar sisa popup tidak tertinggal sebagai baris hantu.
      lastFrame = null
      lastCells = null
      lastCols = 0
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
      // Area popup sudah dihapus, tetapi isi frame di bawahnya tidak lagi
      // tercermin di `lastCells`; paint berikutnya harus penuh.
      lastFrame = null
      lastCells = null
      lastCols = 0
    },
    close(): void {
      if (closed) return
      closed = true
      lastRegion = null
      try {
        releaseHold()
      } catch {}
      depth = Math.max(0, depth - 1)
      if (depth === 0) {
        try {
          process.stdout.write(EXIT_SEQUENCE)
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
 * Tulis exit-sequence alt-screen SEKARANG (dipanggil handler sinyal TuiApp
 * sebelum process.exit): jaring restore saat SIGTERM/SIGHUP — handler `exit`
 * Node TIDAK jalan pada sinyal fatal default.
 */
export function forceRestoreScreenForSignal(): void {
  if (depth > 0) {
    try {
      process.stdout.write(EXIT_SEQUENCE)
    } catch {}
    depth = 0
  }
}

/**
 * Reset kedalaman (HANYA untuk isolasi test antar-file): view yang gagal
 * di tengah test bisa meninggalkan depth > 0 sehingga file test berikutnya
 * melihat open() sebagai nested dan tak ada ENTER fisik tertulis.
 */
export function resetAltScreenDepth(): void {
  depth = 0
  resetInteractiveScreenHoldForTest()
}

/**
 * Reset hold transient alternatif (HANYA untuk isolasi test antar-file):
 * view yang gagal sebelum `close()` bisa meninggalkan
 * `beginInteractiveScreen` > 0 sehingga painter file test berikutnya tetap
 * dibisukan.
 */
function resetInteractiveScreenHoldForTest(): void {
  __resetTransientForTest()
}
