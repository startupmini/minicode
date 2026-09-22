// View model registry — pola overlay transient yang konsisten dengan picker/
// provider-manager. Tetap shell-like: overlay sementara, hasil aksi tetap inline.
import { askLine } from "../input/input.ts"
import { createDecoderState, type DecoderState, decodeKeysStream } from "../input/prompt-engine.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs } from "../render/theme.ts"
import { padToWidth, truncateToWidth } from "../render/width.ts"
import { clearTransientOverlay, renderTransientOverlay } from "./overlay.ts"
import { runPicker } from "./picker.ts"

const DIM = "\x1b[2m",
  RESTORE = "\x1b[22m"

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
  /** Ambil baris terbaru setelah mutasi (atau saat add batal). */
  loadRows(): Promise<ModelRow[]>
  onAdd(providerId: string, model: string): Promise<ModelRow[]>
  onDelete(id: string): Promise<ModelRow[]>
  onSetEffort?(id: string, effort: "default" | "low" | "medium" | "high"): Promise<ModelRow[]>
  /**
   * Opsi effort per model id ("provider::model" atau nama mentah) — untuk
   * picker yang jujur: keluarga tanpa thinking hanya ["default"] sehingga
   * picker dilewati dan effort tersimpan tak disentuh. Default (tanpa
   * injeksi): semua opsi, perilaku lama.
   */
  getEfforts?: (id: string) => ("default" | "low" | "medium" | "high")[]
}

/** Saring baris berdasarkan substring id, case-insensitive. Murni agar bisa diuji. */
export function filterModelRows(rows: ModelRow[], q: string): ModelRow[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter((r) => r.id.toLowerCase().includes(needle))
}

export async function runModelManagerView(opts: ModelManagerViewOptions): Promise<void> {
  let rows = opts.initialRows
  // Mode cari: ketikan apa pun langsung jadi query (termasuk a/d — tidak ada
  // lagi shortcut huruf agar mengetik selalu menyaring di semua OS). Tambah =
  // Ctrl+N, hapus = tombol Del. Esc keluar dari mode cari, bukan tutup
  // manager. null = tak memfilter.
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
  let prevRows = 0

  return new Promise<void>((resolve) => {
    const visibleRows = () => Math.max(1, Math.min((process.stdout.rows || 24) - 4, 14))
    // Lantai lebar tak boleh melebihi terminal (floor 12 lama membungkus di
    // kolom ≤13) — sama seperti picker/provider-manager.
    const width = () => Math.max(8, (process.stdout.columns || 80) - 2)

    const buildLines = (): string[] => {
      const list = viewRows()
      const v = visibleRows()
      if (sel < scroll) scroll = sel
      if (sel >= scroll + v) scroll = sel - v + 1
      const w = width()
      const cut = (s: string) => truncateToWidth(s, w)
      const view = list.slice(scroll, scroll + v)
      const lines: string[] = []
      lines.push(
        cut(
          `${DIM}─ ${c.accent(c.bold("Models"))}${rows.length ? ` ${DIM}(${rows.length})${RESTORE}` : ""} ${DIM}─${RESTORE}`,
        ),
      )
      if (filter != null) {
        lines.push(
          cut(
            `${DIM}  Filter:${RESTORE} ${filter}█ ${DIM}(${list.length}/${rows.length})${RESTORE}`,
          ),
        )
      }
      if (!list.length) {
        lines.push(
          cut(`${DIM}  ${filter == null ? "No models configured" : "No models match"}${RESTORE}`),
        )
      } else {
        for (let i = 0; i < view.length; i++) {
          const row = view[i]!
          const picked = i === sel - scroll
          // Badge effort hanya bila non-default — default adalah kondisi normal
          // yang tak perlu diumumkan tiap baris (minimalis).
          const badge = row.effort && row.effort !== "default" ? ` [${row.effort}]` : ""
          // row.id (provider::model) BISA datang dari jaringan (hasil probe
          // GET /models) — sanitasi sebelum tampil, seperti label picker.
          const cleanId = sanitizeAnsiLine(row.id)
          const label = truncateToWidth(
            `${padToWidth(`${cleanId}${badge}`, w - 14)}${row.active ? "  active" : ""}`,
            w - 4,
          )
          if (picked) lines.push(`  ${c.accent("›")} ${c.accent(c.bold(label))}${RESTORE}`)
          else lines.push(`   ${DIM}${label}${RESTORE}`)
        }
        if (list.length > scroll + v) {
          lines.push(cut(`${DIM}… ${c.accent(String(list.length - scroll - v))} more${RESTORE}`))
        }
      }
      lines.push("")
      lines.push(
        cut(
          `${DIM}Enter:${RESTORE}${c.accent("select+thinking")}  ${DIM}Ctrl+N:${RESTORE}${c.accent("add")}  ${DIM}Del:${RESTORE}${c.accent("delete")}  ${DIM}ketik:${RESTORE}${c.accent("cari")}  ${DIM}Esc:${RESTORE}${c.accent(filter == null ? "close" : "clear filter")}${RESTORE}`,
        ),
      )
      return lines
    }

    const render = () => {
      prevRows = renderTransientOverlay(buildLines(), prevRows)
    }

    let busy = false
    let done = false
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
      prevRows = clearTransientOverlay(prevRows)
      process.stdout.write("\x1b[0m\x1b[?25h")
      // TIDAK menulis \r\n — clearTransientOverlay sudah kembali ke anchor.
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
      render()
      resetIdle()
    }

    const finish = () => {
      if (done) return
      done = true
      clearIdle()
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
          // Pesan error BISA menggema isi jaringan (URL/body probe) — sanitasi.
          console.log(`${glyphs.cross} ${sanitizeAnsiLine((e as Error).message)}`)
        } finally {
          busy = false
          await loadRowsSafe()
          resume()
        }
      })()

    const loadRowsSafe = async () => {
      try {
        rows = await opts.loadRows()
      } catch {}
      clampSel()
    }

    const addModel = () =>
      runAction(async () => {
        const providerId = await askLine({ prompt: "Provider > " })
        // Batal (Esc/Ctrl+C di baris kosong = null) harus berhenti DI SINI —
        // kalau lanjut ke prompt berikutnya, batal di prompt pertama terasa
        // seperti pindah pertanyaan.
        if (providerId == null) {
          console.log("Canceled")
          return
        }
        const model = await askLine({ prompt: "Model > " })
        if (model == null) {
          console.log("Canceled")
          return
        }
        if (!providerId.trim() || !model.trim()) {
          // Isian kosong (Enter tanpa teks) — beri tahu, jangan diam.
          console.log("Canceled")
          return
        }
        const prevCount = rows.length
        rows = await opts.onAdd(providerId.trim(), model.trim())
        // Gema input user disanitasi juga: sekali diketik `\x1b[2J` sebagai
        // nama model, baris hasil tak boleh mengeksekusinya kembali.
        const echoName = sanitizeAnsiLine(`${providerId.trim()}::${model.trim()}`)
        // Panjang tak berubah = model sudah ada (bukan error — provider
        // ditemukan, onAdd tak lempar). Laporkan jujur, bukan "added".
        if (rows.length === prevCount) console.log(`${glyphs.dot} ${echoName} already exists`)
        else console.log(`${glyphs.check} added ${echoName}`)
        clampSel()
      })

    const deleteModel = () => {
      const row = viewRows()[sel]
      if (!row) return
      return runAction(async () => {
        // Model AKTIF yang dihapus membuat prompt berikutnya kehilangan model
        // tanpa sebab yang terlihat — sebutkan seperti provider-manager.
        const prefix = row.active ? "Delete ACTIVE model" : "Delete model"
        const answer = await askLine({ prompt: `${prefix} ${sanitizeAnsiLine(row.id)}? [y/N] ` })
        if (answer?.trim().toLowerCase() === "y") {
          rows = await opts.onDelete(row.id)
          console.log(`${glyphs.check} deleted ${sanitizeAnsiLine(row.id)}`)
        } else {
          console.log("Canceled")
          rows = await opts.loadRows()
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
            title: "Thinking effort",
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
    const onData = (chunk: Buffer) => {
      if (busy) return
      if (done) return
      resetIdle()
      try {
        for (const item of decodeKeysStream(chunk, decoder)) {
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
            // Backspace & Del sama-sama memangkas query (tanpa kursor,
            // Del maju = grapheme terakhir juga). Query habis = keluar mode.
            if (item.key.type === "backspace" || item.key.type === "delete") {
              filter = Array.from(filter).slice(0, -1).join("")
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
            return
          }
          if (item.key.type === "up") sel = Math.max(0, sel - 1)
          else if (item.key.type === "down") {
            const n = viewRows().length
            sel = n ? Math.min(n - 1, sel + 1) : 0
          } else if (item.key.type === "enter") {
            const row = viewRows()[sel]
            if (!row) return // daftar kosong: jangan tutup (footer bilang select)
            if (busy) return
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
                  await opts.onSelect(row.id)
                  // "skip" = model tanpa thinking: select langsung, effort
                  // tersimpan tak disentuh (aman — pengiriman effort juga
                  // di-gate per keluarga, jadi nilai basi tak pernah terkirim).
                  if (picked !== "skip" && opts.onSetEffort) {
                    await opts.onSetEffort(row.id, picked)
                    console.log(`Thinking: ${picked} (next session)`)
                  }
                } catch (e) {
                  // Jangan tutup diam-diam: pilih model yang gagal harus
                  // terlihat, bukan dianggap sukses (manager lalu hilang).
                  console.log(`${glyphs.cross} ${sanitizeAnsiLine((e as Error).message)}`)
                } finally {
                  finish()
                }
              } catch {
                finish()
              }
            })()
            return
          } else if (item.key.type === "ctrl-n") {
            // Tambah model — shortcut non-ketik agar ketikan huruf apa pun
            // (termasuk a/d) selalu jadi query cari, di Windows & Linux.
            void addModel()
            return
          } else if (item.key.type === "delete") {
            // Di sini filter selalu null (mode cari ditangani di atas):
            // hapus model ter-highlight (dengan konfirmasi di deleteModel).
            void deleteModel()
            return
          } else if (item.key.type === "char") {
            // Ketik langsung menyaring — tanpa awalan apa pun.
            filter = item.key.ch
            sel = 0
            scroll = 0
          }
        }
        render()
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
      resetIdle()
      render()
    } catch {
      finish()
    }
  })
}
