// Modal picker - searchable, VS Code palette

import { t } from "../i18n/locale.ts"
import {
  createDecoderState,
  createKeyStreamPump,
  type DecodedKey,
  type DecoderState,
  toGraphemes,
} from "../input/prompt-engine.ts"
import { hintLine } from "../render/hint.ts"
import { cleanUntrusted, sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, stripAnsi } from "../render/theme.ts"
import { displayWidth, truncateToWidth } from "../render/width.ts"
import { type AltScreen, openAltScreen } from "../runtime/screen.ts"
import { beginInteractiveScreen } from "../runtime/statusline.ts"
import { boxLeftPad, dialogBox, popupBoxWidth } from "./dialog.ts"
import { createIdleTimer } from "./lifecycle.ts"

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
  filterable?: boolean
}

const dim = (s: string): string => c.dim(s)

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
    for (const it of opts.items) {
      const provider = sanitizeAnsiLine(it.provider)
      const name = sanitizeAnsiLine(it.name)
      console.log(provider ? `${provider}::${name}` : name)
    }
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
    // Lebar dibekukan saat mount (AUD-006).
    const boxWidth = popupBoxWidth(process.stdout.columns || 80)

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
      // Modal tanpa judul/footer dekoratif; sisakan border, baris pencarian
      // (bila ada), DAN satu baris hint aksi di dasar.
      if (useModal) return Math.max(1, Math.min(rows - (isFilterable ? 4 : 3), 12))
      const chrome = isFilterable ? 4 : 3
      return Math.max(1, Math.min(rows - chrome, 12))
    }
    // Lebar konten = lebar kotak (dibekukan saat mount) dikurangi chrome dialog
    // (border+padding = 4 kolom) agar dialogBox tak memotong ulang label.
    const width = () => Math.max(8, boxWidth - 4)

    // Isi untuk dialog popup (tanpa judul; hint aksi satu baris di dasar).
    const bodyLines = (): string[] => {
      const items = filteredItems()
      const v = visibleRows()
      // Hint minimalis: kunci terang, label redup (satu sumber `hintLine`).
      // Selalu tampil agar navigasi tak perlu ditebak; tidak memakan tinggi
      // daftar karena `visibleRows` sudah menyisihkan satu baris untuknya.
      const hint = hintLine([
        { key: "↑↓", label: t("hint.move") },
        { key: "Enter", label: t("hint.select") },
        { key: "Esc", label: t("hint.close") },
      ])
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
        // Filter = input user tak terpercaya — sanitasi sebelum tampil.
        const display = filter ? c.brightCyan(sanitizeAnsiLine(filter)) : ""
        lines.push(cut(`${dim(">")} ${display}${c.accent("█")}`))
      }
      if (items.length === 0) {
        lines.push(cut(dim(`  ${t("pick.noMatch", { q: sanitizeAnsiLine(filter) })}`)))
        lines.push(cut(hint))
        return lines
      }
      for (let i = 0; i < rows.length; i++) {
        const it = rows[i]!
        const picked = i === sel - scroll
        // Label provider::model ringkas; teks tetap disanitasi sebelum truncate.
        // Highlight query diterapkan sebelum truncate agar posisi kolom tepat.
        const safeProvider = sanitizeAnsiLine(it.provider)
        const rawLabel = safeProvider
          ? `${safeProvider}::${sanitizeAnsiLine(it.name)}`
          : sanitizeAnsiLine(it.name)
        const label = highlightMatch(truncateToWidth(rawLabel, w - 4), filter)
        if (picked) lines.push(`  ${c.accent("›")} ${c.accent(c.bold(label))}`)
        else lines.push(`   ${dim(label)}`)
      }
      lines.push(cut(hint))
      return lines
    }

    const render = () => {
      // Popup komposit: HANYA region kotak yang dilukis (tanpa clear) di atas
      // konten pemilik layar (transkrip App / alt-buffer wizard). Pemilik
      // Lebar beku (min=max): geometri tak bernapas saat filter berubah.
      const box = dialogBox(
        {
          title: "",
          body: bodyLines(),
          minWidth: boxWidth,
          maxWidth: boxWidth,
        },
        screen.cols,
        screen.rows,
      )
      screen.paintRegion(box.lines, box.topRow)
      // Parkir kursor pada input filter meski kosong agar teks pertama langsung
      // masuk ke pencarian; navigasi item tetap memakai tombol panah.
      // Kolom = padding kiri + border + spasi + lebar label+filter + 1.
      try {
        if (isFilterable) {
          const li = Math.min(box.lines.length - 1, box.bodyTop)
          const row = box.topRow + li
          const leftPad = boxLeftPad(stripAnsi(box.lines[li] ?? ""))
          const col = leftPad + 2 + 2 + displayWidth(stripAnsi(filter)) + 1
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
    // memang harusnya batal. Satu sumber idle via helper bersama (audit D1).
    // `cleanup`/`resolve` dirujuk sebagai closure (dievaluasi saat timer fire).
    const idle = createIdleTimer({
      cancelMs: 90_000,
      onCancel: () => {
        cleanup()
        opts.onCancel()
        resolve()
      },
    })
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
      // Tutup layar sebelum batal: openAltScreen sudah menulis ENTER fisik
      // (?1049h) — bail tanpa close membocorkan alt-screen (terminal tertinggal
      // di buffer alternatif) dan hold painter-nya (I27) tidak pernah lepas.
      try {
        screen.close()
      } catch {}
      resolve()
      return
    }
    // Raw mode (sama seperti askLine/askSecret): picker juga menghalangi
    // painter transient stderr melukis di baris yang sama. Jalur ini aktif
    // bahkan saat runPicker dipanggil langsung (bukan lewat wizard), misalnya
    // di bawah alt-screen App yang painter-nya sudah ditahan — hold nested dan
    // release-nya idempoten.
    const endScreen = beginInteractiveScreen()
    const cleanup = () => {
      if (done) return
      done = true
      try {
        pickerPump.dispose()
      } catch {}
      try {
        process.stdin.setMaxListeners(prevMaxListeners)
      } catch {}
      idle.dispose()
      // Lepas kepemilikan layar: painter boleh melukis lagi setelah ini
      // (kursor sudah kembali ke anchor, overlay sudah dibersihkan).
      endScreen()
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
      idle.reset()
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
          console.log(
            `⚠ ${t("pick.fail", {
              msg: cleanUntrusted(String((e as Error)?.message ?? e), !!process.stdout.isTTY),
            })}`,
          )
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
      idle.reset()
      render()
    } catch (e) {
      // Sama seperti di atas: setup gagal (raw-mode ConPTY rusak) harus
      // settle, bukan gantung. Kegagalan BERSUARA (satu baris scrollback),
      // bukan bisu — kelas bug "jendela kosong" hanya bisa diburu bila terlihat.
      try {
        cleanup()
      } catch {}
      try {
        console.log(
          `⚠ ${t("pick.failOpen", {
            msg: cleanUntrusted(String((e as Error)?.message ?? e), !!process.stdout.isTTY),
          })}`,
        )
      } catch {}
      try {
        opts.onCancel()
      } catch {}
      resolve()
    }
  })
}
