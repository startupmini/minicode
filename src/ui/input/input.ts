import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { stripAnsi } from "../render/theme.ts"
import { displayWidth, escapeLength, truncateToWidth } from "../render/width.ts"
import {
  applyKey,
  buildRenderSpec,
  createDecoderState,
  createState,
  type DecoderState,
  decodeKeysStream,
  MAX_VISIBLE,
  type PromptKey,
  pointLength,
  toGraphemes,
} from "./prompt-engine.ts"

const HISTORY_FILE = join(homedir(), ".minicode", "history")
const MAX_HISTORY = 1000

export async function loadHistory(file = HISTORY_FILE): Promise<string[]> {
  try {
    const content = await readFile(file, "utf8")
    const out: string[] = []
    for (const line of content.split("\n")) {
      if (!line) continue
      // Format baru: satu JSON string per baris (mendukung newline di entri
      // multiline). Format lama: baris plain — tetap dibaca apa adanya.
      if (line.startsWith('"')) {
        try {
          const v: unknown = JSON.parse(line)
          if (typeof v === "string" && v) {
            out.push(v)
            continue
          }
        } catch {
          // Bukan JSON valid — jatuh ke plain di bawah.
        }
      }
      const t = line.trim()
      if (t) out.push(t)
    }
    return out.slice(-MAX_HISTORY)
  } catch {
    return []
  }
}

export async function appendHistory(entry: string, file = HISTORY_FILE): Promise<void> {
  const clean = entry.trim()
  if (!clean) return
  try {
    const existing = await loadHistory(file)
    const filtered = existing.filter((e) => e !== clean)
    filtered.push(clean)
    const capped = filtered.slice(-MAX_HISTORY)
    await mkdir(join(homedir(), ".minicode"), { recursive: true }).catch(() => {})
    await writeFile(file, `${capped.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8")
  } catch {}
}

// ── ANSI support detection (sekali per process, cached) ──
// Semua console modern (Windows Terminal, VS Code, conhost Windows 10+,
// macOS/Linux TTY) memproses VT sequences. JANGAN menggantungkan dropdown
// pada probe DSR - conhost PS5.1 tidak selalu membalas \x1b[6n padahal VT
// bekerja (itulah kenapa dropdown 'hilang' kembali ke inline).
// Opt-out eksplisit: MINICODE_DROPDOWN=0 (console benar-benar legacy).
let ansiCache: Promise<boolean> | undefined

export async function detectAnsi(): Promise<boolean> {
  if (process.env.MINICODE_DROPDOWN === "0") return false
  if (!process.stdin.isTTY) return false
  ansiCache ??= Promise.resolve(true)
  return ansiCache
}

export interface AskLineOptions {
  /**
   * Prefix prompt: string statis ATAU fungsi yang dipanggil setiap render.
   * Bentuk fungsi membuat perubahan eksternal — mis. cycle mode REPL via
   * Shift+Tab — langsung terlihat tanpa mengulang askLine.
   */
  prompt?: string | (() => string)
  hints?: (line: string) => string[]
  groupOf?: (text: string) => string // opsional: label grup (commands/skills)
  /**
   * Riwayat eksplisit (menggantikan loadHistory dari file). Dipakai test agar
   * hermetic tanpa menyentuh ~/.minicode/history milik mesin.
   */
  history?: string[]
  /**
   * Batas idle tanpa keypress (ms); lewat = batal sendiri (null). Default
   * 90.000 seperti picker/manager — raw-mode yang digenggam tanpa input
   * rawan macet/segfault saat ConPTY mati. `0` = mati, dipakai prompt utama
   * REPL: null di sana dihitung Ctrl+C (2x = exit), jadi auto-batal akan
   * mengeluarkan user yang diam 3 menit.
   */
  idleMs?: number
  /**
   * Dipanggil untuk setiap keypress SEBELUM logika bawaan (history, applyKey).
   * Return truthy = key sudah ditangani pemanggil; askLine melewatkan handling
   * default dan tetap me-render ulang. Dipakai REPL linier untuk Shift+Tab
   * (cycle mode), Tab kosong (toggle plan/build), dan Ctrl+O (toggle compact).
   * `line` = isi baris saat ini (untuk Tab kosong).
   */
  onKey?: (key: PromptKey, line: string) => boolean
}

// Input interaktif satu baris + floating dropdown suggestions (dimmed).
// - ANSI (Windows Terminal/VS Code/macOS/Linux): dropdown baris di bawah prompt,
//   seleksi › hijau, navigasi ↑/↓, Tab = complete tetap editing, Enter = complete + submit.
// - Legacy console (tanpa VT): fallback inline hints di baris yang sama.
// Semua logika transisi ada di prompt-engine.ts (pure) - di sini hanya IO + render.
export async function askLine(opts: AskLineOptions = {}): Promise<string | null> {
  const { glyphs } = await import("../render/theme.ts")
  // Diselesaikan per pemakaian (bukan sekali di awal) supaya prompt berbentuk
  // fungsi — mis. prefix mode REPL yang berubah lewat Shift+Tab — tergambar baru.
  const promptOf = (): string =>
    typeof opts.prompt === "function" ? opts.prompt() : (opts.prompt ?? `${glyphs.prompt} `)

  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let settled = false
      const done = (v: string | null) => {
        if (settled) return
        settled = true
        resolve(v)
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      // Pipe EOF tanpa newline: rl.question tak pernah memanggil balik —
      // tanpa ini REPL gantung selamanya menunggu input yang tak datang.
      rl.on("close", () => done(null))
      rl.question(promptOf(), (a) => {
        rl.close()
        done(a.trim())
      })
    })
  }

  const ansi = await detectAnsi()
  const { c } = await import("../render/theme.ts")
  const DIM = "\x1b[2m",
    RESTORE = "\x1b[22m",
    CLEAR = "\x1b[2K",
    SYNC_START = "\x1b[?2026h",
    SYNC_END = "\x1b[?2026l"
  const hints = (l: string) => opts.hints?.(l) ?? []

  // History navigation via Up/Down when menu not open (append mode)
  const historyCache = opts.history ?? (await loadHistory())
  let historyIdx = -1
  let savedLine = ""

  // Reverse-i-search ala readline (Ctrl+R): filter substring historyCache,
  // tampil inline sebagai prompt pengganti — tanpa overlay/picker. Dulu
  // Ctrl+R di-decode prompt-engine tapi tak dipakai ("bekas picker history
  // fullscreen"). Hasil ditampilkan sebagai state.line sementara; draf asli
  // kembali utuh bila pencarian dibatalkan (Esc/Ctrl+C).
  let search: { query: string; idx: number; saved: string } | null = null
  const searchMatches = (): string[] => {
    if (!search) return []
    const q = search.query.toLowerCase()
    const out: string[] = []
    for (let i = historyCache.length - 1; i >= 0; i--) {
      const h = historyCache[i]!
      if (!q || h.toLowerCase().includes(q)) out.push(h)
    }
    return out
  }
  const effPrompt = (): string => {
    const base = promptOf()
    if (!search) return base
    const ok = searchMatches().length > 0
    return `${ok ? "(reverse-i-search)" : "(failed reverse-i-search)"}\`${search.query}': `
  }

  return new Promise((resolve, reject) => {
    // Raw mode harus dikembalikan BAGI BAGIAN body yang error: bila renderAnsi
    // melempar (mis. lebar terminal abnormal), terminal tidak boleh tertinggal
    // dalam raw + listener lama menumpuk (dulu REPL catch{continue} lalu
    // askLine berikutnya memasang listener kedua → MaxListenersExceeded).
    const decoder: DecoderState = createDecoderState()
    let done = false
    let onData!: (chunk: Buffer) => void
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
    }
    const cleanup = () => {
      if (done) return
      done = true
      clearIdle()
      try {
        process.stdin.setRawMode(false)
      } catch {}
      // SENGAJA tanpa pause(): stdin TTY mengalir seumur proses — siklus
      // pause→resume berulang mematikan pengiriman 'data' selamanya di
      // Bun Windows (list tampil tapi semua tombol mati, bahkan Ctrl+C).
      // Kepemilikan = siapa yang memegang listener; melepas listener cukup.
      // Pause hanya di teardown sesi (close()) agar one-shot bisa exit.
      if (onData) process.stdin.removeListener("data", onData)
    }
    const finish = (v: string | null) => {
      cleanup()
      resolve(v)
    }
    const fail = (e: unknown) => {
      cleanup()
      reject(e)
    }

    try {
      process.stdin.setRawMode(true)
      process.stdin.resume()
    } catch (e) {
      reject(e)
      return
    }

    let state = createState()
    let prevRows = 0 // jumlah baris dropdown yang tergambar (untuk clear)
    let prevInputRows = 1 // jumlah baris input visual frame lalu (multiline)
    let prevCursorRow = 0 // baris kursor frame lalu (0 = anchor)
    let printedW = 0 // lebar teks yang ditulis (fallback inline)

    const matches = (): string[] => hints(state.line)

    // ── render ANSI: dropdown floating di bawah prompt ──
    // Horizontal scroll mengikuti KURSOR, bukan hanya ujung baris: saat user
    // menyunting di tengah prompt panjang, bagian yang sedang diedit harus
    // terlihat. Semua ukuran dalam KOLOM terminal — CJK/emoji dua kolom.
    // Sebelumnya memakai `.length` (karakter), sehingga baris CJK 53 kolom
    // dianggap "muat" di terminal 30 kolom lalu membungkus sendiri.
    // Ambil run SGR di awal baris (biasanya gaya prompt): potongan tengah
    // memang plain (teks user), tapi jendela dari awal harus mempertahankan
    // warna prompt. Tanpa ini stripAnsi membuat prompt pudar begitu baris
    // lebih panjang dari terminal.
    const takeLeadSgr = (s: string): string => {
      let out = ""
      let i = 0
      while (s[i] === "\x1b") {
        const len = escapeLength(s, i)
        if (len <= 0) break
        const seq = s.slice(i, i + len)
        if (!seq.endsWith("m")) break
        out += seq
        i += len
      }
      return out
    }
    const scrollableLine = (line: string, cursorCol: number): { text: string; col: number } => {
      const cols = process.stdout.columns || 80
      if (displayWidth(line) <= cols - 1) return { text: line, col: cursorCol }
      // Bekerja pada teks bersih: potongan tengah tidak bisa mempertahankan
      // sekuens ANSI dengan benar tanpa melacak state warna.
      const lead = takeLeadSgr(line)
      const clean = stripAnsi(line)
      const pts = toGraphemes(clean)
      // Lebar kumulatif per posisi karakter.
      const colAt: number[] = [0]
      for (const ch of pts) colAt.push(colAt[colAt.length - 1]! + displayWidth(ch))
      // Jendela scroll tidak boleh melebihi terminal sendiri: `max(8, cols-4)`
      // di cols=5 menghasilkan keep 8 > cols → baris membungkus lagi.
      const keep = Math.min(Math.max(8, cols - 4), Math.max(4, cols - 1))
      // Cari indeks awal terkecil yang membuat kursor masuk jendela `keep`.
      let start = 0
      while (start < pts.length && cursorCol - colAt[start]! >= keep) start++
      const ell = start > 0 ? "…" : ""
      const body = truncateToWidth(pts.slice(start).join(""), keep - displayWidth(ell), "")
      return {
        // Awalan SGR (nol kolom) hanya relevan saat jendela dari awal —
        // saat start>0 prompt sudah tergulir keluar dan body memang plain.
        text: (start > 0 ? c.dim(ell) : lead) + body,
        col: displayWidth(ell) + (cursorCol - colAt[start]!),
      }
    }

    /** Pindahkan kursor terminal ke kolom logis (1-based di ANSI). */
    const placeCursor = (col: number) => {
      process.stdout.write(`\x1b[${Math.max(1, col + 1)}G`)
    }

    // Render input multiline (Ctrl+J): tiap baris visual digambar di baris
    // terminal sendiri; kursor diposisikan di baris+kolom logisnya. Baris
    // non-kursor digambar dari awal (cukup, karena teks user plain); baris
    // kursor lewat scrollableLine (jendela + warna prompt bila di baris 0).
    const scrollableMultiline = (
      prompt: string,
      line: string,
      cursor: number,
    ): { texts: string[]; cursorRow: number; cursorCol: number } => {
      const segs = line.split("\n")
      let acc = 0
      let cursorRow = 0
      let cursorInRow = 0
      for (let r = 0; r < segs.length; r++) {
        const glen = pointLength(segs[r]!)
        if (cursor <= acc + glen) {
          cursorRow = r
          cursorInRow = cursor - acc
          break
        }
        acc += glen + 1
        if (r === segs.length - 1) {
          cursorRow = r
          cursorInRow = glen
        }
      }
      const promptW = displayWidth(prompt)
      const texts: string[] = []
      let cursorCol = 0
      for (let r = 0; r < segs.length; r++) {
        const full = r === 0 ? prompt + segs[r]! : segs[r]!
        if (r === cursorRow) {
          const colW = displayWidth(toGraphemes(segs[r]!).slice(0, cursorInRow).join(""))
          const v = scrollableLine(full, (r === 0 ? promptW : 0) + colW)
          texts.push(v.text)
          cursorCol = v.col
        } else {
          texts.push(scrollableLine(full, 0).text)
        }
      }
      return { texts, cursorRow, cursorCol }
    }

    const renderAnsi = () => {
      // Satu frame = satu unit sinkron: terminal menahan tampil sampai SYNC_END,
      // sehingga navigasi dropdown (atas/bawah) tak berkedip/robek. Terminal
      // tanpa dukungan mengabaikan sekuens ini (sudah dipakai clearOverlay).
      process.stdout.write(SYNC_START)
      const rows = process.stdout.rows || 24
      // Baris input visual ikut memakan tinggi: kurangi jatah dropdown agar
      // blok input + dropdown tetap muat di terminal pendek.
      const nInGuess = state.line.split("\n").length
      // Sisakan ruang untuk prompt + 1 baris status agar dropdown tidak
      // membungkus di terminal pendek.
      const maxVisible = Math.max(1, Math.min(MAX_VISIBLE, rows - 3 - (nInGuess - 1)))
      const spec = buildRenderSpec(state, effPrompt(), matches(), opts.groupOf, maxVisible)
      const view = scrollableMultiline(effPrompt(), state.line, state.cursor)
      const nIn = view.texts.length
      const maxRows = Math.max(prevRows, spec.totalRows)
      const maxIn = Math.max(prevInputRows, nIn)
      // Kembali ke anchor: render lalu menaruh kursor di baris R.
      if (prevCursorRow > 0) process.stdout.write(`\x1b[${prevCursorRow}A`)
      // Blok input (anchor + lanjutan), bersihkan sisa frame lama yang susut.
      process.stdout.write(`\r${CLEAR}${view.texts[0]}`)
      for (let k = 1; k < maxIn; k++)
        process.stdout.write(`\r\n${CLEAR}${k < nIn ? view.texts[k]! : ""}`)
      // Turun ke bawah-blok-input aktual (bukan sisa frame lama yang susut).
      const gapUp = maxIn - nIn
      if (gapUp > 0) process.stdout.write(`\x1b[${gapUp}A`)
      // Blok dropdown di bawah input, bersihkan sisa frame lama.
      for (let k = 0; k < maxRows; k++) process.stdout.write(`\r\n${CLEAR}`)
      if (maxRows > 0) process.stdout.write(`\x1b[${maxRows}A`)

      if (spec.rows.length > 0) {
        const cols = process.stdout.columns || 80
        process.stdout.write("\r\n")
        for (let i = 0; i < spec.rows.length; i++) {
          const row = spec.rows[i]!
          if (row.kind === "header") {
            process.stdout.write(
              CLEAR + c.accent(c.bold(truncateToWidth(row.text, cols))) + RESTORE,
            )
          } else {
            const isPicked = row.picked
            const prefix = isPicked ? `  ${c.accent("›")} ` : "    "
            // Item dropdown juga dipotong ke lebar terminal.
            const label = truncateToWidth(row.text, Math.max(4, cols - 4))
            const text = isPicked ? c.accent(c.bold(label)) : label
            if (isPicked) {
              process.stdout.write(CLEAR + prefix + text + RESTORE)
            } else {
              process.stdout.write(CLEAR + DIM + prefix + text + RESTORE)
            }
          }
          if (i < spec.rows.length - 1) process.stdout.write("\r\n")
        }
        if (spec.moreCount > 0) {
          process.stdout.write("\r\n")
          process.stdout.write(`${CLEAR + DIM}    … ${spec.moreCount} more${RESTORE}`)
        }
        // Kembali ke anchor (melewati dropdown + baris input lanjutan).
        process.stdout.write(`\x1b[${spec.totalRows + (nIn - 1)}A`)
        // Gambar ulang blok input (pastikan bersih setelah naik).
        process.stdout.write(`\r${CLEAR}${view.texts[0]}`)
        for (let k = 1; k < nIn; k++) process.stdout.write(`\r\n${CLEAR}${view.texts[k]!}`)
      }

      // Naik dari baris input terakhir ke baris kursor, lalu ke kolom logis.
      const upToCursor = nIn - 1 - view.cursorRow
      if (upToCursor > 0) process.stdout.write(`\x1b[${upToCursor}A`)
      // Kursor sungguhan di posisi logis — bukan selalu di ujung baris.
      placeCursor(view.cursorCol)
      process.stdout.write(SYNC_END)
      prevRows = spec.totalRows
      prevInputRows = nIn
      prevCursorRow = view.cursorRow
    }

    // ── render inline (legacy console, tanpa ANSI) ──
    const renderInline = () => {
      const hs = matches()
      const prompt = effPrompt()
      // Konsol legacy tak menghitung baris: gepengkan multiline untuk display
      // (nilai submit tetap utuh ber-newline).
      const flat =
        state.line.indexOf("\n") === -1
          ? state.line
          : `${state.line.replace(/\n/g, " ")} (+${state.line.split("\n").length - 1} lines)`
      const content = hs.length
        ? `${prompt}${flat}    ${hs.slice(0, 5).join("  ")}`
        : `${prompt}${flat}`
      // Fallback non-ANSI tetap harus mengukur lebar per KOLOM terminal.
      // Jika memakai .length, CJK/emoji meninggalkan jejak saat baris memendek.
      const contentW = displayWidth(content)
      const pad = printedW - contentW
      process.stdout.write(`\r${" ".repeat(printedW)}\r${content}${pad > 0 ? " ".repeat(pad) : ""}`)
      printedW = contentW
    }

    const render = ansi ? renderAnsi : renderInline

    // Hapus overlay dropdown sepenuhnya (delete lines, bukan clear) supaya
    // tidak menyisakan gap kosong. Cursor kembali ke baris anchor.
    const clearOverlay = () => {
      if (prevRows <= 0) return
      process.stdout.write(SYNC_START)
      // turun ke baris overlay pertama, hapus satu per satu (baris bawah
      // shift-up otomatis tiap \x1b[1M), lalu naik balik ke anchor.
      process.stdout.write("\r\n")
      for (let k = 0; k < prevRows; k++) {
        process.stdout.write(CLEAR)
        process.stdout.write("\x1b[1M")
      }
      process.stdout.write("\x1b[1A")
      process.stdout.write(SYNC_END)
      prevRows = 0
    }

    // Tampilkan cocokkan pencarian sebagai baris (sementara; draf asli di
    // search.saved dan kembali utuh bila dibatalkan).
    const searchShow = () => {
      const ms = searchMatches()
      const m = ms.length ? ms[Math.min(search!.idx, ms.length - 1)]! : ""
      state = { ...state, line: m, cursor: pointLength(m), sel: -1, menuOpen: false }
      render()
    }
    // Echo baris final ke scrollback lalu selesaikan askLine. Multiline:
    // kursor bisa di baris R>0 — naik ke anchor dulu agar clearOverlay (yang
    // mengasumsikan kursor di anchor) dan echo menimpa blok input tepat.
    const doSubmit = (cancelled: boolean) => {
      const v = cancelled ? null : state.line.trim()
      if (ansi) {
        const segs = state.line.split("\n")
        let crow = 0
        let acc = 0
        for (let r = 0; r < segs.length; r++) {
          const glen = pointLength(segs[r]!)
          if (state.cursor <= acc + glen) {
            crow = r
            break
          }
          acc += glen + 1
          crow = r
        }
        if (crow > 0) process.stdout.write(`\x1b[${crow}A`)
        clearOverlay()
        const cols = process.stdout.columns || 80
        const prompt = effPrompt()
        // Baris pertama lewat scrollableLine (jendela horizontal, sama
        // seperti dulu); baris lanjutan cukup dipotong ke lebar terminal.
        const first = scrollableLine(`${prompt}${segs[0]!}`, 0).text
        process.stdout.write(`\r${CLEAR}${first}\r\n`)
        for (let k = 1; k < segs.length; k++)
          process.stdout.write(`${CLEAR + truncateToWidth(segs[k]!, cols)}\r\n`)
      } else {
        process.stdout.write(`\r${CLEAR}${effPrompt()}${state.line}\r\n`)
      }
      finish(v)
    }

    // Idle-timeout: nol keypress selama idleMs = batal sendiri via jalur
    // submit normal (draf ikut ter-echo ke scrollback, tak hilang bisu).
    // Reset di tiap chunk — mengetik/menahan tombol apa pun memperpanjang.
    const resetIdle = () => {
      const ms = opts.idleMs ?? 90_000
      if (done || !ms) return
      clearIdle()
      idleTimer = setTimeout(() => {
        doSubmit(true)
      }, ms)
      // Jangan tahan process hidup hanya karena timer ini.
      try {
        ;(idleTimer as unknown as { unref?: () => void }).unref?.()
      } catch {}
    }

    onData = (chunk: Buffer) => {
      resetIdle()
      const keys = decodeKeysStream(chunk, decoder)
      for (const d of keys) {
        // Hook pemanggil: key yang ditangani sendiri (return truthy) dilewati
        // dari logika bawaan; render() di akhir chunk tetap menggambar efeknya.
        // SAAT SEARCH AKTIF hook DILEWATI: tanpa ini Tab/Shift+Tab/Ctrl+O yang
        // dicegat REPL (cycle mode/compact) membajak keypad pencarian — user
        // yang search-nya gagal lalu menekan Tab malah mengganti mode.
        if (!search && opts.onKey?.(d.key, state.line)) continue
        // Reverse-i-search: Ctrl+R masuk/putar, sisanya dikelola di bawah.
        if (d.key.type === "ctrl-r") {
          if (historyCache.length === 0) continue
          if (!search) {
            search = { query: "", idx: 0, saved: state.line }
            historyIdx = -1
            searchShow()
          } else {
            const ms = searchMatches()
            if (ms.length) {
              search.idx = (search.idx + 1) % ms.length
              searchShow()
            }
          }
          continue
        }
        if (search) {
          if (d.key.type === "enter") {
            // Bash: Enter mengeksekusi baris hasil pencarian.
            search = null
            historyIdx = -1
            savedLine = ""
            doSubmit(false)
            return
          }
          if (d.key.type === "esc" || d.key.type === "ctrl-c" || d.key.type === "ctrl-d") {
            // Batal cari saja (bukan batal baris): kembalikan draf. Ctrl+D ikut
            // agar konsisten dengan Ctrl+C — tanpa ini Ctrl+D saat search
            // membuang draf (beda dari perilaku readline).
            const back = search.saved
            search = null
            state = { ...state, line: back, cursor: pointLength(back), sel: -1, menuOpen: false }
            historyIdx = -1
            render()
            continue
          }
          if (d.key.type === "char") {
            search.query += d.key.ch
            search.idx = 0
            searchShow()
            continue
          }
          if (d.key.type === "ctrl-u") {
            // Hapus query — jangan auto-accept hasil lalu clear baris, karena
            // itu membuang draf asli (search.saved) yang seharusnya pulang.
            search.query = ""
            search.idx = 0
            searchShow()
            continue
          }
          if (d.key.type === "backspace") {
            const q = toGraphemes(search.query)
            q.pop()
            search.query = q.join("")
            search.idx = 0
            searchShow()
            continue
          }
          if (d.key.type === "up") {
            const ms = searchMatches()
            if (search.idx < ms.length - 1) {
              search.idx++
              searchShow()
            }
            continue
          }
          if (d.key.type === "down") {
            if (search.idx > 0) {
              search.idx--
              searchShow()
            }
            continue
          }
          // Tombol lain: terima hasil ke baris lalu proses normal di bawah.
          const ms = searchMatches()
          const m = ms.length ? ms[Math.min(search.idx, ms.length - 1)]! : search.saved
          search = null
          state = { ...state, line: m, cursor: pointLength(m), sel: -1, menuOpen: false }
          historyIdx = -1
        }
        // Esc pada baris KOSONG tanpa menu = batal prompt (null) — dipakai
        // dialog (Provider >, Base URL >, dsb.) agar Esc konsisten dengan
        // picker/manager. Esc pada baris berisi TIDAK batal: draf tidak boleh
        // hilang karena salah tekan (menu yang terbuka tetap ditutup applyKey).
        if (!search && d.key.type === "esc" && !state.menuOpen && state.line === "") {
          doSubmit(true)
          return
        }
        // Navigasi history saat dropdown tertutup.
        //
        // Sebelumnya entri history DIGABUNGKAN ke teks yang sedang ditulis
        // ("halo" + panah atas -> "halo <entri>"), yang menghancurkan prompt
        // yang sedang disusun. Semua shell mengganti baris; kita ikut. Baris
        // yang sedang ditulis disimpan dan kembali saat user turun melewati
        // entri terbaru.
        if ((d.key.type === "up" || d.key.type === "down") && !state.menuOpen) {
          const setLine = (line: string) => {
            state = { ...state, line, cursor: pointLength(line), sel: -1, menuOpen: false }
            render()
          }
          if (d.key.type === "up") {
            if (historyIdx < historyCache.length - 1) {
              if (historyIdx === -1) savedLine = state.line
              historyIdx++
              setLine(historyCache[historyCache.length - 1 - historyIdx] ?? "")
            }
          } else if (historyIdx > 0) {
            historyIdx--
            setLine(historyCache[historyCache.length - 1 - historyIdx] ?? "")
          } else if (historyIdx === 0) {
            historyIdx = -1
            setLine(savedLine)
          }
          continue
        }
        // Mengetik/menghapus/memindah kursor setelah menjelajah history
        // memutus mode history — semua shell begitu (setiap edit = edit baris
        // baru, bukan lanjut navigasi). Sebelumnya ctrl-w/ctrl-u/tab/panah
        // tidak me-reset historyIdx, jadi setelah recall history lalu Ctrl+W
        // panah bawah tetap kembali ke entri history lain.
        if (
          d.key.type === "char" ||
          d.key.type === "ctrl-j" ||
          d.key.type === "backspace" ||
          d.key.type === "delete" ||
          d.key.type === "ctrl-w" ||
          d.key.type === "ctrl-u" ||
          d.key.type === "tab" ||
          d.key.type === "left" ||
          d.key.type === "right"
        ) {
          historyIdx = -1
          savedLine = ""
        }
        const r = applyKey(state, d.key, hints)
        state = r.state
        if (r.action === "submit" || r.action === "cancel") {
          // Empty Enter = "" (not null) - REPL continues; null = cancel (break)
          doSubmit(r.action === "cancel")
          return
        }
      }
      // Satu render per chunk - paste 50+ char tidak meng-redraw 50 kali.
      try {
        render()
      } catch (e) {
        fail(e)
      }
    }

    process.stdin.on("data", onData)
    resetIdle()
    try {
      render()
    } catch (e) {
      fail(e)
    }
  })
}

/**
 * Prompt rahasia (tanpa echo). Return null = DIBATALKAN user (Esc/Ctrl+C/
 * Ctrl+D) — beda dari submit kosong (""), supaya pemanggil bisa membedakan
 * "batal" dari "Enter tanpa isi" (yang dulu sama-sama jatuh ke pesan
 * "required", membuat batal dikira error).
 */
export async function askSecret(
  promptText: string,
  opts: { idleMs?: number } = {},
): Promise<string | null> {
  if (!process.stdin.isTTY) return null

  return new Promise((resolve, reject) => {
    const decoder: DecoderState = createDecoderState()
    let done = false
    let onData!: (chunk: Buffer) => void
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
    }
    const cleanup = () => {
      if (done) return
      done = true
      clearIdle()
      try {
        process.stdin.setRawMode(false)
      } catch {}
      // Tanpa pause — lihat cleanup askLine (stdin mengalir seumur proses).
      if (onData) process.stdin.removeListener("data", onData)
    }
    const finish = (value: string | null) => {
      cleanup()
      process.stdout.write("\n")
      resolve(value)
    }
    const fail = (e: unknown) => {
      cleanup()
      reject(e)
    }
    // Sama seperti askLine: idle tanpa keypress = batal (null), bukan
    // gantung dengan raw-mode digenggam.
    const resetIdle = () => {
      const ms = opts.idleMs ?? 90_000
      if (done || !ms) return
      clearIdle()
      idleTimer = setTimeout(() => {
        finish(null)
      }, ms)
      try {
        ;(idleTimer as unknown as { unref?: () => void }).unref?.()
      } catch {}
    }

    process.stdout.write(promptText)
    let secret = ""

    onData = (chunk: Buffer) => {
      resetIdle()
      try {
        for (const d of decodeKeysStream(chunk, decoder)) {
          const k = d.key
          if (k.type === "enter") {
            finish(secret.trim())
            return
          } else if (k.type === "esc" || k.type === "ctrl-c" || k.type === "ctrl-d") {
            // Esc/Ctrl+C/Ctrl+D = BATALKAN PROMPT, bukan matikan proses.
            //
            // Dulu di sini `process.exit(130)`. Di raw mode Ctrl+C tidak
            // menghasilkan SIGINT, jadi itu emulasi manual — tapi `askSecret`
            // dipanggil dari `runProviderManager`, sebuah dialog di dalam REPL
            // yang hidup. Menekan Ctrl+C saat salah ketik API key mematikan
            // seluruh sesi beserta riwayatnya, bukan menutup dialognya.
            finish(null)
            return
          } else if (k.type === "backspace") {
            // Hapus satu GRAPHEME (bukan code point/UTF-16 unit): emoji ZWJ
            // dan flag tidak meninggalkan setengah.
            const graphemes = toGraphemes(secret)
            if (graphemes.length > 0) {
              graphemes.pop()
              secret = graphemes.join("")
              process.stdout.write("\b \b")
            }
          } else if (k.type === "ctrl-u") {
            // Hapus SEMUA (mis. salah paste API key) — tanpa ini satu-satunya
            // jalan adalah Backspace satu-satu.
            const n = toGraphemes(secret).length
            secret = ""
            if (n > 0) process.stdout.write(`${"\b \b".repeat(n)}`)
          } else if (k.type === "ctrl-w") {
            // Hapus satu "kata" (sampai spasi terakhir) — sama dengan prompt
            // teks biasa.
            const graphemes = toGraphemes(secret)
            const cut = secret.replace(/\S+\s*$/, "")
            const removed = graphemes.length - toGraphemes(cut).length
            if (removed > 0) {
              secret = cut
              process.stdout.write(`${"\b \b".repeat(removed)}`)
            }
          } else if (k.type === "char") {
            // Sekuens kontrol dari paste dibuang — secret tidak boleh
            // mengandung newline/C0 (Enter adalah satu-satunya terminasi).
            const clean = k.ch
              .replace(/\r\n|\r|\n|\t/g, "")
              // biome-ignore lint/suspicious/noControlCharactersInRegex: membuang kontrol dari paste
              .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
            if (clean) {
              secret += clean
              process.stdout.write("*".repeat(toGraphemes(clean).length))
            }
          }
        }
      } catch (e) {
        fail(e)
      }
    }

    process.stdin.resume()
    try {
      process.stdin.setRawMode(true)
    } catch (e) {
      fail(e)
      return
    }
    process.stdin.on("data", onData)
    resetIdle()
  })
}
