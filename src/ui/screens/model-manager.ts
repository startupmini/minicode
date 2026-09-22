// View model registry — pola popup komposit yang konsisten dengan picker/// provider-manager. Tetap shell-like: overlay sementara, hasil aksi tetap inline.

import { t } from "../i18n/locale.ts"
import {
  createDecoderState,
  createKeyStreamPump,
  type DecodedKey,
  type DecoderState,
  toGraphemes,
} from "../input/prompt-engine.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs, stripAnsi } from "../render/theme.ts"
import { displayWidth, truncateToWidth } from "../render/width.ts"
import { type AltScreen, openAltScreen } from "../runtime/screen.ts"
import { boxLeftPad, dialogBox } from "./dialog.ts"
import { runForm } from "./form.ts"
import { runPicker } from "./picker.ts"

const dim = (s: string): string => c.dim(s)

export interface ModelRow {
  /** Format "providerId::model". */
  id: string
  active: boolean
  /** Effort tersimpan provider ini; absen/"default" = tanpa badge. */
  effort?: string
}

export interface ModelManagerViewOptions {
  initialRows: ModelRow[]
  /** Filter awal (dari `/model <cari>`) — null/"" = tanpa filter. */
  initialFilter?: string
  onSelect(id: string): void | Promise<void>
  /** Ambil baris terbaru setelah mutasi. */
  loadRows(): Promise<ModelRow[]>
  onDelete(id: string): Promise<ModelRow[]>
  onSetEffort?(id: string, effort: "default" | "low" | "medium" | "high"): Promise<ModelRow[]>
  /**
   * Opsi effort per model id ("provider::model" atau nama mentah) — untuk
   * picker yang jujur: keluarga tanpa thinking hanya ["default"] sehingga
   * picker dilewati dan effort tersimpan tak disentuh. Default (tanpa
   * injeksi): semua opsi, perilaku lama.
   */
  getEfforts?: (id: string) => ("default" | "low" | "medium" | "high")[]
  /**
   * Batas waktu aksi jaringan (ms) — DI untuk test (default 60 dtk).
   * Tanpa ini test watchdog menunggu semenit.
   */
  actionTimeoutMs?: number
}

/** Saring baris berdasarkan substring id, case-insensitive. Murni agar bisa diuji. */
export function filterModelRows(rows: ModelRow[], q: string): ModelRow[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter((r) => r.id.toLowerCase().includes(needle))
}

/** Lebar kotak dialog /model: TETAP 64 kolom (keputusan rasa: geometri stabil,
 * tak pernah melompat mengikuti konten). Satu sumber untuk width() dan
 * maxWidth dialogBox — keduanya HARUS sepakat agar label tak terpotong ulang. */
const MODAL_BOX_W = 64

export async function runModelManagerView(opts: ModelManagerViewOptions): Promise<void> {
  let rows = opts.initialRows // Mode cari: ketikan apa pun langsung jadi query. Hapus = tombol Del.
  // Esc keluar dari mode cari, bukan tutup manager. null = tak memfilter.
  let filter: string | null = null
  const initial = opts.initialFilter?.trim()
  if (initial) filter = initial
  const viewRows = (): ModelRow[] => (filter == null ? rows : filterModelRows(rows, filter))
  const clampSel = () => {
    sel = Math.min(Math.max(0, sel), Math.max(0, viewRows().length - 1))
  }
  let sel = Math.max(
    0,
    rows.findIndex((r) => r.active),
  )
  clampSel()
  let scroll = 0
  // Struk aksi transient: hasil delete/Canceled/error tampil sebagai baris
  // redup DALAM popup, bukan console.log ke scrollback. Dibersihkan tiap
  // keypress baru — terlihat sampai tombol berikut ditekan.
  let notice: string | null = null

  return new Promise<void>((resolve) => {
    const visibleRows = () => {
      const rows = process.stdout.rows || 24
      // Popup: jatah dialog rows−4 sudah termasuk baris counter/notice, jadi
      // item dibatasi rows−5 (lihat picker.ts). Dialog mungil /model: maks 8.
      return Math.max(1, Math.min(rows - 5, 8))
    }
    // Lantai lebar tak boleh melebihi terminal. Lebar konten = lebar kotak
    // tetap dikurangi chrome dialog (border+padding = 4) agar sepakat dengan
    // dialogBox (tanpa potong ulang). innerMax dialog = cols−6, jadi konten
    // = cols−6 juga (dulu cols−4 → potong-ganda 2 kolom di terminal sempit).
    const width = () => Math.max(8, Math.min((process.stdout.columns || 80) - 6, MODAL_BOX_W - 4))

    // Isi MINIMAL dialog /model (tanpa judul/footer/hitungan/penanda —
    // seleksi murni warna). Search selalu tampil, daftar tanpa `›`.
    const bodyLinesModal = (): string[] => {
      const list = viewRows()
      const v = visibleRows()
      if (sel < scroll) scroll = sel
      if (sel >= scroll + v) scroll = sel - v + 1
      const w = width()
      const cut = (s: string) => truncateToWidth(s, w)
      const view = list.slice(scroll, scroll + v)
      const lines: string[] = []
      lines.push(cut(`${dim(">")} ${c.brightCyan(sanitizeAnsiLine(filter ?? ""))}█`))
      if (!list.length) {
        lines.push(cut(dim(`  ${filter == null ? t("model.empty") : t("model.noMatch")}`)))
      } else {
        for (let i = 0; i < view.length; i++) {
          const row = view[i]!
          const picked = i === sel - scroll
          const badge = row.effort && row.effort !== "default" ? ` [${row.effort}]` : ""
          // Penanda aktif di luar budget truncasi (paritas provider-manager):
          // nama yang dipotong, status yang selamat.
          const active = row.active ? ` (${t("common.active")})` : ""
          const nameBudget = Math.max(8, w - 4 - displayWidth(active))
          const label = `${truncateToWidth(`${sanitizeAnsiLine(row.id)}${badge}`, nameBudget, "…")}${active}`
          if (picked) lines.push(`  ${c.accent(c.bold(label))}`)
          else lines.push(`  ${dim(label)}`)
        }
      }
      if (notice) lines.push(cut(dim(sanitizeAnsiLine(notice))))
      return lines
    }

    const render = () => {
      // Popup komposit: HANYA region kotak (tanpa clear) di atas transkrip
      // App. Lebar TETAP 64 (min=max) — tak pernah melompat mengikuti konten.
      const box = dialogBox(
        {
          title: t("model.title"),
          body: bodyLinesModal(),
          footer: modelHint(),
          minWidth: MODAL_BOX_W,
          maxWidth: MODAL_BOX_W,
          maxHeight: 14,
        },
        screen.cols,
        screen.rows,
      )
      screen.paintRegion(box.lines, box.topRow)
      // Parkir kursor di posisi ketik query (tepat sebelum penanda █ di
      // baris search body[0]): kolom = padding + border + spasi + "> " +
      // lebar filter + 1. Parkir di ujung baris (padding void) terlihat
      // rusak — kursor melayang jauh dari █.
      try {
        const li = Math.min(box.lines.length - 1, box.bodyTop)
        const row = box.topRow + li
        const leftPad = boxLeftPad(stripAnsi(box.lines[li] ?? ""))
        const col = Math.max(
          1,
          Math.min(
            screen.cols || 80,
            leftPad + 2 + 2 + displayWidth(sanitizeAnsiLine(filter ?? "")) + 1,
          ),
        )
        process.stdout.write(`\x1b[${row};${col}H\x1b[?25h`)
      } catch {}
    }

    /** Hint footer /model: Del/type-to-filter jadi discoverable (dulu tanpa
     * footer — user baru tak tahu cara hapus/saring). */
    const modelHint = (): string =>
      `${c.accent(t("model.typeFilter"))} · Del:${c.accent(t("verb.delete"))} · Enter:${c.accent(t("verb.select"))} · Esc:${c.accent(t("verb.close"))}`

    // Popup butuh layar mampu; selain itu tolak BERSUARA + batal.
    const screen: AltScreen = openAltScreen()
    const useModal = screen.ok && (process.stdout.rows || 24) >= 10
    if (!useModal) {
      try {
        console.log(`⚠ ${t("gate.tuiModel")}`)
      } catch {}
      // Tutup layar sebelum batal: openAltScreen sudah menulis ENTER fisik —
      // bail tanpa close membocorkan alt-screen + hold painter (I27).
      try {
        screen.close()
      } catch {}
      resolve()
      return
    }

    let busy = false
    let done = false
    /** Listener stdin terpasang? Menjaga resume() idempoten (anti-ganda). */
    let attached = false
    // Bun Windows: raw-mode yang ditahan tanpa input rawan digenggam selamanya
    // (lihat idleTimer 90 dtk di picker.ts — segfault setelah 133 dtk idle).
    // Manager ini sebelumnya TANPA idleTimer: bila stdin 'data' tak pernah
    // datang (ConPTY macet/fokus hilang/busy bocor), Promise tak pernah settle
    // dan raw-mode dipegang selamanya = "masuk list model macet". Samakan
    // dengan picker: idle 90 dtk = batal otomatis.
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
    }
    // Didefinisikan di bawah (function hoisting via let) — dipanggil finish.
    let resetIdle: () => void = () => {}

    const suspend = () => {
      clearIdle()
      attached = false
      process.stdout.write("\x1b[0m\x1b[?25h")
      // TANPA pause — stdin mengalir seumur proses (lihat cleanup askLine).
      try {
        process.stdin.setRawMode(false)
      } catch {}
      try {
        process.stdin.removeListener("data", onData)
      } catch {}
      try {
        process.stdout.removeListener("resize", onResize)
      } catch {}
    }

    const resume = () => {
      if (done) return
      // Idempoten: tanpa garda, resume ganda (mis. watchdog timeout lalu
      // aksi telat selesai) memasang listener stdin DUA kali → tiap tombol
      // diproses ganda. Gagal-di-kode-lama.
      if (!attached) {
        process.stdin.setMaxListeners(0)
        try {
          process.stdin.setRawMode(true)
        } catch {
          // Raw-mode gagal (ConPTY Windows) = tak bisa baca tombol; lebih baik
          // tutup jujur daripada gantung dengan layar mati.
          finish()
          return
        }
        process.stdin.resume()
        process.stdin.on("data", onData)
        process.stdout.on("resize", onResize)
        attached = true
      }
      render()
      resetIdle()
    }

    const finish = () => {
      if (done) return
      done = true
      clearIdle()
      // Kembalikan batas listener warisan (lihat prevMaxListeners): warning
      // MaxListenersExceeded kembali berguna setelah sesi ini selesai.
      try {
        managerPump.dispose()
      } catch {}
      try {
        process.stdin.setMaxListeners(prevMaxListeners)
      } catch {}
      // Hapus region popup sendiri sebelum pemilik me-repaint (App.resume).
      try {
        screen.clearRegion()
      } catch {}
      try {
        screen.close()
      } catch {}
      // suspend() tak boleh menggagalkan resolve: setRawMode bisa melempar
      // di Windows bila handle sudah rusak — tanpa try/finally Promise gantung
      // selamanya (resolve tak tercapai).
      try {
        suspend()
      } catch {
      } finally {
        resolve()
      }
    }

    resetIdle = () => {
      if (done) return
      clearIdle()
      idleTimer = setTimeout(() => {
        finish()
      }, 90_000)
      // Jangan tahan process hidup hanya karena timer ini.
      try {
        ;(idleTimer as unknown as { unref?: () => void }).unref?.()
      } catch {}
    }

    const runAction = (fn: () => Promise<void>) =>
      (async () => {
        if (busy) return
        busy = true
        suspend()
        try {
          await fn()
        } catch (e) {
          // Pesan error dari controller/jaringan = input tak terpercaya:
          // sanitasi (tanpa ini ESC[2J dari pesan merusak layar).
          notice = `${glyphs.cross} ${sanitizeAnsiLine((e as Error).message)}`
        } finally {
          busy = false
          await loadRowsSafe()
          resume()
        }
      })()

    /**
     * Batas waktu aksi jaringan (onDelete/onSelect/onSetEffort): provider/tool
     * non-kooperatif yang gantung selamanya membuat popup mati (suspend tanpa
     * listener/timer). Timeout = notice jujur + UI pulih; aksi telat yang
     * akhirnya selesai diabaikan hasilnya (tanpa resolve ganda — resolve
     * hanya lewat finish alur normal). Bisa dioverride test via opts.
     */
    const withWatchdog = async <T>(fn: () => Promise<T> | T): Promise<T> => {
      const ms = opts.actionTimeoutMs ?? 60_000
      let timer: ReturnType<typeof setTimeout> | undefined
      const p = Promise.resolve().then(fn)
      // Rejection telat TANPA handler = unhandledRejection (bun: crash).
      p.catch(() => {})
      try {
        return await Promise.race([
          p,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(t("ntc.timeout"))), ms)
            try {
              ;(timer as unknown as { unref?: () => void }).unref?.()
            } catch {}
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    const loadRowsSafe = async () => {
      try {
        rows = await opts.loadRows()
      } catch {}
      clampSel()
    }

    const deleteModel = () => {
      const row = viewRows()[sel]
      if (!row) return
      return runAction(async () => {
        // Model AKTIF yang dihapus membuat prompt berikutnya kehilangan model
        // tanpa sebab yang terlihat — sebutkan. Konfirmasi dalam popup.
        const form = await runForm(
          {
            title: t("model.deleteTitle"),
            fields: [
              {
                id: "ok",
                label: row.active
                  ? t("model.delActive", { id: row.id })
                  : t("model.del", { id: row.id }),
                kind: "confirm",
              },
            ],
            footer: t("model.deleteFooter"),
          },
          screen,
        )
        if (!form.cancelled && form.values?.ok === "y") {
          rows = await withWatchdog(() => opts.onDelete(row.id))
          notice = `${glyphs.check} ${t("ntc.deleted", { id: row.id })}`
        } else {
          notice = t("common.canceled")
          rows = await withWatchdog(() => opts.loadRows())
        }
        clampSel()
      })
    }

    // Picker effort dipakai alur Enter — HANYA bila modelnya mendukung
    // (lihat getEffortOptions): model tanpa thinking langsung select tanpa
    // picker dan tanpa menyentuh effort tersimpan. Dipanggil saat manager
    // di-suspend, sehingga raw mode/lisener milik picker, bukan manager.
    const pickEffort = (
      modelId: string,
    ): Promise<"default" | "low" | "medium" | "high" | null | "skip"> => {
      const options = opts.getEfforts?.(modelId) ?? ["default", "low", "medium", "high"]
      if (options.length <= 1) return Promise.resolve("skip")
      return new Promise<string | null>((resolvePick) => {
        // Fail-closed: runPicker non-TTY kini memanggil onCancel, tapi bila
        // runPicker melempar/menolak sebelum itu, resolve null agar busy tak
        // bocor true selamanya (= manager terkunci, terlihat hang).
        try {
          void runPicker({
            title: t("effort.title"),
            items: options.map((name) => ({ name, provider: "", value: name })),
            onPick: (v) => resolvePick(v),
            onCancel: () => resolvePick(null),
          }).catch(() => resolvePick(null))
        } catch {
          resolvePick(null)
        }
      }).then((picked) =>
        picked && ["default", "low", "medium", "high"].includes(picked)
          ? (picked as "default" | "low" | "medium" | "high")
          : null,
      )
    }

    const decoder: DecoderState = createDecoderState()
    // Batas listener warisan SEBELUM dimatikan: setMaxListeners(0) menutupi
    // kebocoran listener masa depan secara global — simpan & kembalikan di
    // finish agar warning Node kembali berguna setelah sesi ini.
    // Guard typeof: stdin bisa stub (test) tanpa API ini — anggap default 10.
    const prevMaxListeners =
      typeof process.stdin.getMaxListeners === "function" ? process.stdin.getMaxListeners() : 10
    const handleManagerKeys = (keys: DecodedKey[]): boolean => {
      if (busy || done) return true
      try {
        // Struk lama dibersihkan tiap keypress baru (transient, bukan arsip).
        notice = null
        for (const item of keys) {
          // Mode cari: semua ketikan masuk ke query, Esc keluar dari mode
          // cari — bukan tutup manager.
          if (filter != null) {
            if (
              item.key.type === "esc" ||
              item.key.type === "ctrl-c" ||
              item.key.type === "ctrl-d"
            ) {
              filter = null
              sel = 0
              scroll = 0
              continue
            }
            if (item.key.type === "char") {
              filter += item.key.ch
              sel = 0
              scroll = 0
              continue
            }
            if (item.key.type === "ctrl-u") {
              // Ctrl+U = clear query (paritas editor, sama dengan picker).
              filter = null
              sel = 0
              scroll = 0
              continue
            }
            // Backspace & Del sama-sama memangkas query (tanpa kursor,
            // Del maju = grapheme terakhir juga). Query habis = keluar mode.
            // toGraphemes: emoji/flag utuh (paritas picker/form/askLine).
            if (item.key.type === "backspace" || item.key.type === "delete") {
              const g = toGraphemes(filter)
              g.pop()
              filter = g.join("")
              if (!filter) filter = null
              sel = 0
              scroll = 0
              continue
            }
          } else if (
            item.key.type === "esc" ||
            item.key.type === "ctrl-c" ||
            item.key.type === "ctrl-d"
          ) {
            finish()
            return true
          }
          if (item.key.type === "up") sel = Math.max(0, sel - 1)
          else if (item.key.type === "down") {
            const n = viewRows().length
            sel = n ? Math.min(n - 1, sel + 1) : 0
          } else if (item.key.type === "home") {
            // Home/End = lompat atas/bawah daftar (paritas picker/App).
            sel = 0
            scroll = 0
          } else if (item.key.type === "end") {
            const n = viewRows().length
            sel = n ? Math.max(0, n - 1) : 0
          } else if (item.key.type === "pageup" || item.key.type === "pagedown") {
            // Scroll daftar per halaman (paritas picker/App). Gagal-di-kode-lama:
            // memakai panjang LIST sebagai jatah visible → kondisi tak pernah
            // benar → PgUp/PgDn mati total.
            const list = viewRows()
            const v = visibleRows()
            if (list.length > v) {
              const page = Math.max(1, v - 1)
              const dir = item.key.type === "pageup" ? -page : page
              scroll = Math.max(0, Math.min(Math.max(0, list.length - v), scroll + dir))
              sel = Math.max(0, Math.min(list.length - 1, sel))
              if (sel < scroll) sel = scroll
              if (sel >= scroll + v) sel = scroll + v - 1
            }
          } else if (item.key.type === "enter") {
            const row = viewRows()[sel]
            if (!row) return true // daftar kosong: jangan tutup (footer bilang select)
            if (busy) return true
            busy = true
            suspend()
            // Alur: picker effort DULU, baru select+simpan. Dibalik (select
            // dulu) akan butuh rollback saat Esc — dipilih yang tanpa rollback:
            // Esc = batal total, kembali ke daftar tanpa select/simpan.
            ;(async () => {
              try {
                const picked = await pickEffort(row.id)
                if (!picked) {
                  busy = false
                  await loadRowsSafe()
                  resume()
                  return
                }
                try {
                  await withWatchdog(() => opts.onSelect(row.id))
                  // "skip" = model tanpa thinking: select langsung, effort
                  // tersimpan tak disentuh (aman — pengiriman effort juga
                  // di-gate per keluarga, jadi nilai basi tak pernah terkirim).
                  if (picked !== "skip" && opts.onSetEffort) {
                    await withWatchdog(() => opts.onSetEffort!(row.id, picked))
                    // Struk via notice (rute yang sama dengan receipts lain);
                    // manager langsung tutup sesudahnya, jadi baris ini hanya
                    // terlihat bila alur berubah me-resume — badge effort di
                    // daftar tetap sumber kebenaran yang bisa dibuka ulang.
                    notice = t("effort.saved", { effort: picked })
                  }
                  finish()
                } catch (e) {
                  // Pilih model yang gagal HARUS terlihat dan kembali ke daftar
                  // untuk retry (pola resume() seperti a/d/e provider-manager),
                  // bukan menutup manager dan kehilangan konteks daftar.
                  // Pesan controller = input tak terpercaya: sanitasi.
                  notice = `${glyphs.cross} ${sanitizeAnsiLine((e as Error).message)}`
                  busy = false
                  await loadRowsSafe()
                  resume()
                }
              } catch {
                finish()
              }
            })()
            return true
          } else if (item.key.type === "delete") {
            // Di sini filter selalu null (mode cari ditangani di atas):
            // hapus model ter-highlight (dengan konfirmasi di deleteModel).
            void deleteModel()
            return true
          } else if (item.key.type === "char") {
            // Ketik langsung menyaring — tanpa awalan apa pun.
            filter = item.key.ch
            sel = 0
            scroll = 0
          }
        }
        render()
        return false
      } catch {
        finish()
        return true
      }
    }
    const managerPump = createKeyStreamPump({ state: decoder, onKeys: handleManagerKeys })
    const onData = (chunk: Buffer) => {
      resetIdle()
      try {
        managerPump.push(chunk)
      } catch {
        finish()
      }
    }

    const onResize = () => render()

    process.stdout.write("\x1b[?25l")
    try {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.setMaxListeners(0)
      process.stdin.on("data", onData)
      process.stdout.on("resize", onResize)
      attached = true
      resetIdle()
      render()
    } catch (e) {
      // Setup gagal = tutup + BERSUARA (Fase D): jendela kosong bisu adalah
      // kelas bug yang hanya bisa diburu bila terlihat.
      try {
        finish()
      } catch {}
      try {
        console.log(`⚠ ${t("model.failOpen", { msg: String((e as Error)?.message ?? e) })}`)
      } catch {}
    }
  })
}
