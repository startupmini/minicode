// Layar TUI alternate-screen: model dokumen-baris + viewport + dirty diff.
//
// Peran: SATU-SATUNYA penulis piksel mode TUI (pengganti chrome sticky +
// overlay absolut yang rapuh terhadap resize). Prinsip yang menutup kelas
// bug footer-resize: (1) tak ada lukisan absolut di luar viewport ini —
// resize = re-layout + redraw penuh dari state, tak ada yang bisa basi;
// (2) repaint identik menulis NOL byte (dirty-check per baris);
// (3) tak ada space-fill selebar terminal (reflow ghost) — baris dipotong
// ke lebar kolom via truncateToWidth, sel kosong bukan karakter.
//
// Batas lapisan (dijaga test/ui-boundary): modul ini HANYA boleh impor
// `src/ui/*` + node builtin. Konten (teks model, ledger, footer, input)
// di-render pemanggil (driver `cli/`, komposisi `renderFooter`,
// `prompt-engine`) lalu diserahkan sebagai string — screen tak tahu model,
// provider, tool, atau config apa pun. Driver memiliki loop + event resize;
// screen menyediakan `invalidate()` agar resize berikutnya full repaint.
//
// Geometri dibaca live dari stdout seperti `chrome.ts` (bukan disimpan).
//
// Performance budget (§28, §27): input→feedback <50ms (1 frame, no await),
// render p95 <33ms (viewport only, dirty diff per line, bounded 5000),
// startup <300ms (lazy history), memory idle <100MB (cap doc). Diukur
// via harness + live WT; optimasi hanya setelah profiling (§33).
//
// Layout constraints (skill 5.1, responsive §14):
// - status: fixed 1 row, always visible (never collapse)
// - input: min 1, max R-2, flexible (grows upward, steals from transcript)
// - transcript: min 1, flexible, bottom-anchored (empty = blank top)
// - collapse priority: transcript only (status+input never collapse)
// - narrow (≥20 cols) → primary only, no truncation silent (ellipsis)
// - tiny (<40 cols) still renders 1 col without panic (clamp + truncate)
import { c } from "../render/theme.ts"
import { truncateToWidth } from "../render/width.ts"

export interface TuiCursor {
  /** Indeks baris DALAM blok input (0-based, blok = array `input` apa adanya).
   * Layar yang menyesuaikan ke viewport (potong ekor + geser kursor) —
   * driver tak perlu tahu geometri. */
  line: number
  /** Kolom tampil dalam baris itu. */
  col: number
}

export interface TuiPresentOptions {
  /** Baris status (sudah jadi, mis. `renderFooter(...)`). Tepat 1 baris. */
  status: string
  /** Blok input, baris visual atas→bawah (sudah di-wrap pemanggil). */
  input: string[]
  /** Posisi kursor absolut layar (dihitung driver dari layout). */
  cursor: TuiCursor
  /** Kursor terlihat (idle) vs sembunyi (busy/redraw). */
  showCursor: boolean
}

export interface TuiScreen {
  readonly altActive: boolean
  readonly rows: number
  readonly cols: number
  /** Masuk alt-screen (`?1049h`). Idempoten; nol byte bila sudah aktif. */
  enter(): void
  /** Keluar (`?25h` + `?1049l` + `\r\n` agar output berikut di baris segar —
   * tanpa newline, restore kursor mendarat satu baris terlalu tinggi).
   * Idempoten; wajib dipanggil di SEMUA jalur keluar (I16). */
  leave(): void
  /** Ganti seluruh dokumen (baris logis, boleh memuat SGR). */
  setDocument(lines: string[]): void
  /** Tambah di ekor (cap: buang tertua). Follow bertahan; pin bertahan. */
  appendLine(line: string): void
  /** Follow = viewport menempel ekor dokumen (default true). */
  setFollow(follow: boolean): void
  /** Geser viewport relatif (negatif = ke atas); mematikan follow. */
  scrollBy(n: number): void
  /** Kembali menempel ekor. */
  scrollToEnd(): void
  /** Lukis frame penuh (dirty diff per baris). Tak pernah melempar. */
  present(p: TuiPresentOptions): void
  /** Tandai frame basi → present berikutnya full repaint (dipakai driver
   * saat resize, sebelum present ulang dengan data segar). */
  invalidate(): void
  /** Lepas listener + leave() bila aktif. */
  dispose(): void
}

// Cap dokumen: transkrip panjang tetap bounded (render hanya rentang
// terlihat; cap mencegah memori tumbuh tanpa batas di sesi panjang).
// Diekspor agar driver mirror cap yang sama (dua sumber angka = drift).
export const TUI_DOC_MAX_LINES = 5000

const ALT_ENTER = "\x1b[?1049h"
const ALT_LEAVE = "\x1b[?1049l"
const HIDE_CURSOR = "\x1b[?25l"
const SHOW_CURSOR = "\x1b[?25h"
const CLEAR = "\x1b[2K"
const SYNC_START = "\x1b[?2026h"
const SYNC_END = "\x1b[?2026l"

export function createTuiScreen(): TuiScreen {
  const rowsOf = (): number => process.stdout.rows || 24
  const colsOf = (): number => process.stdout.columns || 80

  let altActive = false
  let disposed = false
  let doc: string[] = []
  let follow = true
  // scrollTop = indeks dokumen baris teratas viewport (diabaikan saat follow).
  let scrollTop = 0
  // Frame terakhir yang dilukis (R string viewport, mentah dgn SGR) —
  // bandingan dirty-check. null = wajib full repaint.
  let lastFrame: string[] | null = null
  // Kursor + visibilitas terakhir (bagian dari dirty-check NOL-byte).
  let lastCursorRow = 0
  let lastCursorCol = 0
  let lastShow = true

  // Tata letak (lihat kontrak I16): transkrip | input (tumbuh ke atas) |
  // status SELALU baris terakhir. Status di bawah (bukan di tengah) agar
  // jangkar visual tak pernah pindah saat input tumbuh — barisnya tetap,
  // hanya isinya berubah (repaint murah, anti-duplikat).
  function layout(inputLen: number): {
    transcriptRows: number
    statusRow: number
    inputRows: number
  } {
    const r = rowsOf()
    const nIn = Math.max(1, Math.min(inputLen, Math.max(1, r - 2)))
    return { transcriptRows: Math.max(1, r - nIn - 1), statusRow: r, inputRows: nIn }
  }

  function viewTop(transcriptRows: number): number {
    if (follow) return Math.max(0, doc.length - transcriptRows)
    return Math.max(0, Math.min(scrollTop, Math.max(0, doc.length - transcriptRows)))
  }

  // Tinggi transkrip frame terakhir: scrollBy butuh top EFEKTIF saat ini
  // (bukan scrollTop basi yang sudah di-clamp viewTop) sebagai basis.
  let lastTRows = 0
  function effTop(): number {
    const tRows = lastTRows > 0 ? lastTRows : Math.max(1, rowsOf() - 2)
    if (follow) return Math.max(0, doc.length - tRows)
    return Math.max(0, Math.min(scrollTop, Math.max(0, doc.length - tRows)))
  }

  function frameLines(p: TuiPresentOptions): {
    lines: string[]
    cut: number
    statusRow: number
    inputRow: number
    cursorRow: number
  } {
    const r = rowsOf()
    const cols = colsOf()
    const lay = layout(p.input.length)
    lastTRows = lay.transcriptRows
    const input = p.input.slice(-lay.inputRows)
    // Baris blok yang terpotong dari kepala (blok > area): kursor ikut geser.
    const cut = Math.max(0, p.input.length - input.length)
    const top = viewTop(lay.transcriptRows)
    const out: string[] = []
    // Jangkar BAWAH: dokumen pendek mengambang di dasar viewport (blank di
    // atas), bukan menempel di atas dengan ekor kosong di bawah.
    const visible = doc.slice(top, top + lay.transcriptRows)
    const padTop = lay.transcriptRows - visible.length
    // Empty state (§20): explain what is empty + next action, not blank.
    const emptyHint =
      doc.length === 0
        ? truncateToWidth(
            c.dim("No messages yet — type a prompt and press Enter  •  /help  •  Ctrl+R search"),
            cols,
          )
        : null
    for (let i = 0; i < lay.transcriptRows; i++) {
      let line = i < padTop ? "" : (visible[i - padTop] ?? "")
      // Center hint vertically when empty: place on last transcript row (just above input).
      if (emptyHint && i === lay.transcriptRows - 1 && !line) line = emptyHint
      out.push(truncateToWidth(line, cols))
    }
    // Input di atas status (status SELALU baris terakhir — jangkar visual).
    for (const line of input) out.push(truncateToWidth(line, cols))
    out.push(truncateToWidth(p.status, cols))
    // Selalu tepat R baris: tanpa ini baris viewport lama yang menyusut
    // (mis. input memendek) tertinggal sebagai fosil.
    while (out.length < r) out.push("")
    // Kursor blok-relatif → absolut layar. Baris input pertama = tepat di
    // atas status; potongan kepala menggeser; clamp ke area input (tak pernah
    // ke baris status / luar layar — degradasi aman).
    const shownInput = input.length
    const cursorRow =
      lay.transcriptRows + 1 + Math.max(0, Math.min(p.cursor.line - cut, shownInput - 1))
    return {
      lines: out.slice(0, r),
      cut,
      statusRow: lay.statusRow,
      inputRow: lay.transcriptRows + 1,
      cursorRow,
    }
  }

  function paint(frame: string[], cursor: { row: number; col: number }, showCursor: boolean): void {
    const r = rowsOf()
    const c = colsOf()
    // NOL byte bila seluruh frame identik (isi + kursor + visibilitas):
    // repaint buta tiap tick/event adalah sumber fosil + banjir terminal.
    if (
      lastFrame != null &&
      lastFrame.length === frame.length &&
      lastFrame.every((line, i) => line === frame[i]) &&
      lastCursorRow === cursor.row &&
      lastCursorCol === cursor.col &&
      lastShow === showCursor
    ) {
      return
    }
    process.stdout.write(SYNC_START)
    process.stdout.write(HIDE_CURSOR)
    for (let i = 0; i < frame.length; i++) {
      if (lastFrame != null && lastFrame[i] === frame[i]) continue
      // CUP absolut + CLEAR + tulis: baris lain tak tersentuh (tak ada
      // space-fill — sel kosong bukan karakter, aman dari reflow).
      process.stdout.write(`\x1b[${i + 1};1H${CLEAR}${frame[i]}`)
    }
    // Kursor ke posisi driver (di-clamp agar tak pernah keluar layar —
    // terminal akan clamp+wrap sendiri bila lolos, merusak grid).
    const cr = Math.max(1, Math.min(cursor.row, r))
    const cc = Math.max(1, Math.min(cursor.col, c))
    process.stdout.write(`\x1b[${cr};${cc}H`)
    process.stdout.write(showCursor ? SHOW_CURSOR : HIDE_CURSOR)
    process.stdout.write(SYNC_END)
    lastFrame = frame
    lastCursorRow = cursor.row
    lastCursorCol = cursor.col
    lastShow = showCursor
  }

  const handle: TuiScreen = {
    get altActive() {
      return altActive
    },
    get rows() {
      return rowsOf()
    },
    get cols() {
      return colsOf()
    },
    enter() {
      if (disposed || altActive) return
      try {
        // ?1049h = save kursor + pindah buffer + clear (atomik per spec).
        process.stdout.write(ALT_ENTER)
        altActive = true
        lastFrame = null
      } catch {}
    },
    leave() {
      if (!altActive) return
      altActive = false
      try {
        process.stdout.write(SHOW_CURSOR)
        process.stdout.write(ALT_LEAVE)
        // Newline-trap: restore kursor mendarat di baris terakhir alt-screen;
        // tanpa ini output berikut menimpa baris itu.
        process.stdout.write("\r\n")
      } catch {}
      lastFrame = null
    },
    setDocument(lines: string[]) {
      doc = lines.slice(-TUI_DOC_MAX_LINES)
      if (follow) scrollTop = Math.max(0, doc.length - 1)
    },
    appendLine(line: string) {
      doc.push(line)
      if (doc.length > TUI_DOC_MAX_LINES) doc.splice(0, doc.length - TUI_DOC_MAX_LINES)
    },
    setFollow(f: boolean) {
      follow = f
    },
    scrollBy(n: number) {
      follow = false
      // Basis dari top EFEKTIF kini (bukan scrollTop basi): tanpa ini scroll
      // dari ekor selalu di-clamp kembali ke ekor oleh viewTop.
      scrollTop = Math.max(0, effTop() + n)
    },
    scrollToEnd() {
      follow = true
    },
    present(p: TuiPresentOptions) {
      if (disposed || !altActive) return
      try {
        const f = frameLines(p)
        paint(f.lines, { row: f.cursorRow, col: p.cursor.col }, p.showCursor)
      } catch {}
    },
    invalidate() {
      lastFrame = null
    },
    dispose() {
      if (disposed) return
      disposed = true
      try {
        handle.leave()
      } catch {}
    },
  }
  return handle
}
