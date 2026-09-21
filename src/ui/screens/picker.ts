// Modal picker - searchable, VS Code palette

import { t } from "../i18n/locale.ts"
import {
  createDecoderState,
  createKeyStreamPump,
  type DecodedKey,
  type DecoderState,
  toGraphemes,
} from "../input/prompt-engine.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, stripAnsi } from "../render/theme.ts"
import { displayWidth, truncateToWidth } from "../render/width.ts"
import { type AltScreen, openAltScreen } from "../runtime/screen.ts"
import { boxLeftPad, dialogBox } from "./dialog.ts"

export interface PickerItem {
  name: string
  provider: string
  value: string
}

export interface PickerOptions {
  title: string
  items: PickerItem[]
  onPick: (value: string) => void
  onCancel: () => void
  placeholder?: string
  filterable?: boolean
}

const dim = (s: string): string => c.dim(s),
  ACC_DIM = (s: string) => c.accent(s)

/** Lebar kotak popup picker TETAP (keputusan rasa: geometri stabil). */
const PICKER_BOX_W = 64

// Tandai substring query di label agar user tahu KENAPA item cocok.
// Operasi pada teks plain (sebelum truncate) — SGR bold nol kolom.
function highlightMatch(label: string, query: string): string {
  if (!query) return label
  const idx = label.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return label
  return (
    label.slice(0, idx) +
    c.bold(label.slice(idx, idx + query.length)) +
    label.slice(idx + query.length)
  )
}

export async function runPicker(opts: PickerOptions): Promise<void> {
  if (!process.stdin.isTTY) {
    // Pipe/redirect: item dari config (tak-terpercaya) disanitasi agar ANSI
    // mentah tak mencemari output program (kontrak stdout non-TTY).
    console.log(`\n${opts.title}`)
    for (const [i, it] of opts.items.entries())
      console.log(`  [${i}] ${sanitizeAnsiLine(it.provider)}::${sanitizeAnsiLine(it.name)}`)
    console.log("")
    // Fail-closed: pemanggil nested (mis. pickEffort di /model) menunggu
    // onPick/onCancel — tanpa ini await-nya gantung selamanya (busy=true)
    // saat isTTY flip di tengah. Non-TTY = tak ada pilihan = batal.
    try {
      opts.onCancel()
    } catch {}
    return
  }

  return new Promise<void>((resolve) => {
    let sel = 0
    let scroll = 0
    let filter = ""
    const isFilterable = opts.filterable ?? false

    const filteredItems = (): PickerItem[] => {
      if (!isFilterable || !filter) return opts.items
      const q = filter.toLowerCase()
      return opts.items.filter(
        (it) => it.name.toLowerCase().includes(q) || it.provider.toLowerCase().includes(q),
      )
    }

    // Lebar/tinggi mengikuti terminal SUNGGUHAN.
    //
    // Sebelumnya keduanya punya lantai minimum (`Math.max(44, …)` dan
    // `Math.max(4, …)`) yang MENGABAIKAN terminal lebih kecil: pada 40 kolom
    // label 55 kolom tetap digambar, dan pada rows=3 overlay 6 baris tetap
    // dicetak — keduanya membungkus dan merusak tampilan.
    const visibleRows = () => {
      const rows = process.stdout.rows || 24
      // Sisakan ruang untuk judul, baris filter, baris footer, dan baris sisa.
      const chrome = isFilterable ? 4 : 3
      // Modal: dialog menambah border/judul/footer di luar jatah view + sisakan
      // 1 baris untuk baris counter ("… N more") agar End selalu sampai dasar.
      if (useModal) return Math.max(1, Math.min(rows - 5, 12))
      return Math.max(1, Math.min(rows - chrome, 12))
    }
    // Lebar konten = lebar kotak TETAP (min=max, keputusan rasa: geometri
    // stabil, tak bernapas saat filter) dikurangi chrome dialog
    // (border+padding = 4 kolom) agar dialogBox tak memotong ulang label.
    const width = () =>
      Math.max(8, Math.min((process.stdout.columns || 80) - 2 - 4, PICKER_BOX_W - 4))

    // Isi untuk dialog popup (tanpa judul/hint — dialog yang membingkai).
    const bodyLines = (): string[] => {
      const items = filteredItems()
      const v = visibleRows()
      if (sel >= items.length) sel = Math.max(0, items.length - 1)
      if (sel < 0) sel = 0
      if (sel < scroll) scroll = sel
      if (sel >= scroll + v) scroll = sel - v + 1
      if (items.length === 0) scroll = 0
      const rows = items.slice(scroll, scroll + v)
      const w = width()
      const cut = (s: string) => truncateToWidth(s, w)
      const lines: string[] = []
      if (isFilterable) {
        const placeholderText = opts.placeholder ?? t("pick.placeholder")
        // Filter = input user tak terpercaya — sanitasi sebelum tampil.
        const display = filter ? c.brightCyan(sanitizeAnsiLine(filter)) : dim(placeholderText)
        const label = filter ? ACC_DIM(t("pick.filter")) : dim(t("pick.filter"))
        lines.push(cut(`${label} ${display}`))
      }
      if (items.length === 0) {
        lines.push(cut(dim(`  ${t("pick.noMatch", { q: sanitizeAnsiLine(filter) })}`)))
        return lines
      }
      for (let i = 0; i < rows.length; i++) {
        const it = rows[i]!
        const picked = i === sel - scroll
        // Potong label ke KOLOM (CJK 2 kolom), sisakan ruang untuk penanda "› ".
        // Highlight query DITERAPKAN sebelum truncate agar posisi kolom tepat.
        // Nama di DEPAN (truncasi memakan ekor — id/nama adalah info
        // terpenting dan harus selamat); provider/tanggal sebagai konteks
        // ekor yang boleh terpotong. Sanitasi DULU karena truncateToWidth
        // menyalin semua escape (juga 2J).
        const rawLabel = `${sanitizeAnsiLine(it.name)}${it.provider ? ` — ${sanitizeAnsiLine(it.provider)}` : ""}`
        const label = highlightMatch(truncateToWidth(rawLabel, w - 4), filter)
        if (picked) lines.push(`  ${c.accent("›")} ${c.accent(c.bold(label))}`)
        else lines.push(`   ${dim(label)}`)
      }
      if (items.length > scroll + v) {
        lines.push(cut(dim(t("dlg.more", { n: items.length - scroll - v }))))
      } else if (isFilterable && filter) {
        lines.push(
          cut(dim(`  ${t("pick.matches", { n: items.length, total: opts.items.length })}`)),
        )
      }
      return lines
    }

    const hintText = (): string => t("pick.hint")

    const render = () => {
      // Popup komposit: HANYA region kotak yang dilukis (tanpa clear) di atas
      // konten pemilik layar (transkrip App / alt-buffer wizard). Pemilik
      // me-repaint penuh saat popup tutup. Lebar TETAP 64 (min=max).
      const box = dialogBox(
        {
          title: opts.title,
          body: bodyLines(),
          footer: hintText(),
          minWidth: PICKER_BOX_W,
          maxWidth: PICKER_BOX_W,
        },
        screen.cols,
        screen.rows,
      )
      screen.paintRegion(box.lines, box.topRow)
      // Parkir kursor: saat filter terisi, user sedang mengetik → kursor di
      // ujung teks filter (dulu selalu di baris item = ketik buta). Saat
      // filter kosong, parkir di baris item aktif (navigasi ↑↓).
      // Kolom = padding kiri + border + spasi + lebar label+filter + 1.
      try {
        if (isFilterable && filter !== "") {
          const li = Math.min(box.lines.length - 1, box.bodyTop)
          const row = box.topRow + li
          const leftPad = boxLeftPad(stripAnsi(box.lines[li] ?? ""))
          const col = leftPad + 2 + displayWidth(stripAnsi(`${t("pick.filter")} ${filter}`)) + 1
          process.stdout.write(`\x1b[${row};${Math.max(1, col)}H\x1b[?25h`)
        } else {
          const itemRow = Math.min(Math.max(0, sel - scroll), Math.max(0, visibleRows() - 1))
          const bodyOffset = isFilterable ? 1 : 0
          const li = Math.min(box.lines.length - 1, box.bodyTop + bodyOffset + itemRow)
          const row = box.topRow + li
          const leftPad = boxLeftPad(stripAnsi(box.lines[li] ?? ""))
          process.stdout.write(`\x1b[${row};${Math.max(1, leftPad + 1)}H\x1b[?25h`)
        }
      } catch {}
    }

    let done = false
    let onData!: (chunk: Buffer) => void
    let onResize!: () => void
    // Bun 1.4.0 Windows: raw-mode yang ditahan >60 dtk rawan segfault
    // (lihat laporan `panic: Segmentation fault at address 0xA0D` setelah
    // 133 dtk idle di picker). Timer idle 90 dtk auto-batal agar raw-mode
    // tidak digenggam selamanya — tanpa ini picker bisa crash Bun sebelum
    // user menekan apa pun. Bukan perubahan perilaku: idle sepanjang itu
    // memang harusnya batal.
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        cleanup()
        opts.onCancel()
        resolve()
      }, 90_000)
      // jangan tahan process tetap hidup hanya karena timer ini
      if (
        idleTimer &&
        typeof (idleTimer as unknown as { unref?: () => void }).unref === "function"
      ) {
        ;(idleTimer as unknown as { unref: () => void }).unref!()
      }
    }
    const decoder: DecoderState = createDecoderState()
    // Seperti manager: simpan batas listener warisan (guard: stdin stub test
    // tak punya getMaxListeners), kembalikan di cleanup agar warning Node
    // tetap berguna setelah sesi ini.
    const prevMaxListeners =
      typeof process.stdin.getMaxListeners === "function" ? process.stdin.getMaxListeners() : 10
    // Popup komposit: layar HARUS mampu (alt-screen + cukup tinggi). Tanpa
    // itu tak ada permukaan popup — tolak BERSUARA + batal (fail-closed).
    // Jalur overlay inline dihapus: satu-satunya tampilan interaktif adalah
    // TUI fullscreen (atau alt-buffer wizard first-run).
    const screen: AltScreen = openAltScreen()
    const useModal = screen.ok && (process.stdout.rows || 24) >= 10
    if (!useModal) {
      try {
        console.log(`⚠ ${t("gate.tuiPicker", { title: opts.title })}`)
      } catch {}
      try {
        opts.onCancel()
      } catch {}
      resolve()
      return
    }
    const cleanup = () => {
      if (done) return
      done = true
      try {
        pickerPump.dispose()
      } catch {}
      try {
        process.stdin.setMaxListeners(prevMaxListeners)
      } catch {}
      if (idleTimer) clearTimeout(idleTimer)
      // Hapus region popup sendiri; pemilik layar (App.resume) repaint penuh,
      // standalone (wizard) membuang alt-buffer utuh via close.
      try {
        screen.clearRegion()
      } catch {}
      try {
        screen.close()
      } catch {}
      process.stdout.write("\x1b[0m\x1b[?25h")
      // TIDAK menulis \r\n di sini: \r\n membuat baris kosong permanen tiap
      // picker dipakai — terlihat sebagai gap saat picker nested di dalam
      // manager (mis. Enter → Thinking effort di /model).
      try {
        process.stdin.setRawMode(false)
      } catch {}
      // Tanpa pause — stdin mengalir seumur proses (lihat cleanup askLine).
      if (onData) process.stdin.removeListener("data", onData)
      if (onResize) process.stdout.removeListener("resize", onResize)
    }

    // Jalur tunggal key (sinkron + flush lone-ESC 50ms via pump): panah split
    // tak lagi jadi esc (filter terhapus + picker tertutup). True = selesai.
    const handlePickerKeys = (keys: DecodedKey[]): boolean => {
      for (const d of keys) {
        const items = filteredItems()
        switch (d.key.type) {
          case "up":
            sel = Math.max(0, sel - 1)
            render()
            break
          case "down":
            // Daftar kosong: jangan biarkan sel=-1 (Enter setelah Down lalu
            // filter menghadirkan 1 item akan menunjuk items[-1]=undefined →
            // onCancel padahal ada hasil ter-highlight).
            sel = items.length ? Math.min(items.length - 1, sel + 1) : 0
            render()
            break
          case "char": {
            if (isFilterable) {
              filter += d.key.ch
              sel = 0
              scroll = 0
              render()
            }
            break
          }
          case "backspace": {
            if (isFilterable && filter.length > 0) {
              // Hapus satu grapheme (filter bisa berisi emoji/flag).
              const graphemes = toGraphemes(filter)
              graphemes.pop()
              filter = graphemes.join("")
              sel = 0
              scroll = 0
              render()
            }
            break
          }
          case "delete": {
            // Del = edit-teks di semua permukaan (paritas Backspace).
            if (isFilterable && filter.length > 0) {
              const graphemes = toGraphemes(filter)
              graphemes.pop()
              filter = graphemes.join("")
              sel = 0
              scroll = 0
              render()
            }
            break
          }
          case "ctrl-u": {
            // Ctrl+U = clear filter (paritas editor).
            if (isFilterable && filter.length > 0) {
              filter = ""
              sel = 0
              scroll = 0
              render()
            }
            break
          }
          case "home": {
            // Home/End = lompat atas/bawah daftar (paritas daftar App).
            sel = 0
            scroll = 0
            render()
            break
          }
          case "end": {
            sel = items.length ? Math.max(0, items.length - 1) : 0
            render()
            break
          }
          case "pageup":
          case "pagedown": {
            // Scroll daftar panjang (… N more) per halaman — paritas App.
            const vis = Math.max(1, Math.min((process.stdout.rows || 24) - 5, 12))
            if (items.length > vis) {
              const page = Math.max(1, vis - 1)
              const maxScroll = Math.max(0, items.length - vis)
              scroll = Math.max(
                0,
                Math.min(maxScroll, scroll + (d.key.type === "pageup" ? -page : page)),
              )
              sel = Math.max(0, Math.min(items.length - 1, sel))
              if (sel < scroll) sel = scroll
              if (sel >= scroll + vis) sel = scroll + vis - 1
              render()
            }
            break
          }
          case "enter": {
            const item = items[sel]
            // Perilaku dipertahankan: tanpa hasil, Enter = batal (dikunci
            // test). Bug yang diperbaiki adalah sel=-1 setelah Down di
            // daftar kosong — item "phantom" yang batal padahal ada hasil.
            cleanup()
            if (item) opts.onPick(item.value)
            else opts.onCancel()
            resolve()
            return true
          }
          case "esc": {
            // Esc pertama membersihkan filter; Esc kedua (filter kosong) keluar.
            if (isFilterable && filter.length > 0) {
              filter = ""
              sel = 0
              scroll = 0
              render()
              break
            }
            cleanup()
            opts.onCancel()
            resolve()
            return true
          }
          case "ctrl-c":
          case "ctrl-d":
            cleanup()
            opts.onCancel()
            resolve()
            return true
          default:
            break
        }
      }
      return false
    }
    const pickerPump = createKeyStreamPump({ state: decoder, onKeys: handlePickerKeys })

    onData = (chunk: Buffer) => {
      resetIdle()
      try {
        pickerPump.push(chunk)
      } catch (e) {
        // Tanpa onCancel+resolve, await runPicker gantung selamanya dan
        // busy=true bocor di pemanggil nested (= manager terkunci, terlihat
        // hang). Batal adalah satu-satunya jawaban jujur saat render rusak.
        // Kegagalan ikut BERSUARA (prinsip Fase D: tak ada jendela bisu).
        try {
          cleanup()
        } catch {}
        try {
          console.log(`⚠ ${t("pick.fail", { msg: String((e as Error)?.message ?? e) })}`)
        } catch {}
        try {
          opts.onCancel()
        } catch {}
        resolve()
      }
    }

    onResize = () => render()

    process.stdout.write("\x1b[?25l")
    try {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.setMaxListeners(0)
      process.stdin.on("data", onData)
      process.stdout.on("resize", onResize)
      resetIdle()
      render()
    } catch (e) {
      // Sama seperti di atas: setup gagal (raw-mode ConPTY rusak) harus
      // settle, bukan gantung. Kegagalan BERSUARA (satu baris scrollback),
      // bukan bisu — kelas bug "jendela kosong" hanya bisa diburu bila terlihat.
      try {
        cleanup()
      } catch {}
      try {
        console.log(`⚠ ${t("pick.failOpen", { msg: String((e as Error)?.message ?? e) })}`)
      } catch {}
      try {
        opts.onCancel()
      } catch {}
      resolve()
    }
  })
}
