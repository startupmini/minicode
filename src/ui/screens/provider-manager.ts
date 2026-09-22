// Provider Manager window — VS Code palette. Murni presentasi: render daftar,
// loop keyboard, dan dialog a/d/e; semua akses config lewat callback yang
// di-inject controller (cli/provider-manager.ts).

import { t } from "../i18n/locale.ts"
import {
  createDecoderState,
  createKeyStreamPump,
  type DecodedKey,
  type DecoderState,
} from "../input/prompt-engine.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs, stripAnsi } from "../render/theme.ts"
import { displayWidth, padToWidth, truncateToWidth } from "../render/width.ts"
import { type AltScreen, openAltScreen } from "../runtime/screen.ts"
import { boxLeftPad, dialogBox } from "./dialog.ts"
import { runForm, validateRequired, validateUrl } from "./form.ts"
import { runPicker } from "./picker.ts"

const dim = (s: string): string => c.dim(s)

/** Lebar kotak popup provider TETAP (lebih lebar: kolom URL panjang). */
const PROVIDER_BOX_W = 76

export interface ProviderRow {
  id: string
  baseUrl: string
  models: number
  hint?: string
  firstModel?: string
}

export interface ProviderPresetView {
  id: string
  label: string
  baseUrl: string
}

export interface ProviderActionResult {
  ok?: string
  err?: string
}

export interface ProviderManagerViewOptions {
  initialRows: ProviderRow[]
  presets: readonly ProviderPresetView[]
  currentModel?: string
  /** true bila ada cwd — dialog tambah menawarkan scope global/lokal. */
  askScope: boolean
  onSelect(row: ProviderRow): void
  /** Ambil baris terbaru dari controller setelah tiap aksi. */
  loadRows(): Promise<ProviderRow[]>
  onAdd(input: {
    preset?: ProviderPresetView
    baseUrl: string
    apiKey: string
    scope: "global" | "local"
  }): Promise<ProviderActionResult>
  onDelete(row: ProviderRow): Promise<ProviderActionResult>
  onEditDefaults(row: ProviderRow): Promise<{ baseUrl: string; apiKey: string } | null>
  onEditSave(
    row: ProviderRow,
    input: { baseUrl: string; apiKey: string },
  ): Promise<ProviderActionResult>
  /**
   * Batas waktu aksi jaringan (ms) — DI untuk test (default 60 dtk).
   * Tanpa ini test watchdog menunggu semenit.
   */
  actionTimeoutMs?: number
}

export async function runProviderManagerView(opts: ProviderManagerViewOptions): Promise<void> {
  let providers: ProviderRow[] = opts.initialRows
  let sel = 0
  let scroll = 0
  // Struk aksi transient: hasil/Canceled/error tampil sebagai baris redup
  // DALAM popup, bukan console.log ke scrollback. Dibersihkan tiap keypress
  // baru. Pengecualian sadar: "Detecting models…" (progres jaringan saat
  // popup tersuspend — tanpa itu tunggu terasa hang).
  let notice: string | null = null

  async function reload() {
    providers = await opts.loadRows()
    if (sel >= providers.length) sel = Math.max(0, providers.length - 1)
    if (scroll > sel) scroll = sel
  }

  return new Promise<void>((resolve) => {
    // Ukuran mengikuti terminal SUNGGUHAN (lihat picker.ts untuk alasan sama).
    // Popup: jatah dialog rows−4 sudah termasuk baris counter/notice, jadi
    // item dibatasi rows−5 (lihat picker.ts).
    const visibleRows = () => {
      const rows = process.stdout.rows || 24
      return Math.max(1, Math.min(rows - 5, 14))
    }
    // Lebar konten = lebar kotak TETAP (min=max, paritas picker/model) —
    // dikurangi chrome dialog (lihat picker.ts).
    const width = () =>
      Math.max(8, Math.min((process.stdout.columns || 80) - 2 - 4, PROVIDER_BOX_W - 4))

    // Isi popup (judul + hint dibingkai dialog).
    const bodyLines = (): string[] => {
      const v = visibleRows()
      if (sel < scroll) scroll = sel
      if (sel >= scroll + v) scroll = sel - v + 1
      const w = width()
      const cut = (s: string) => truncateToWidth(s, w)
      const rows = providers.slice(scroll, scroll + v)
      const lines: string[] = []
      if (providers.length === 0) {
        lines.push(cut(dim(`  ${t("prov.empty")}`)))
      } else {
        for (let i = 0; i < rows.length; i++) {
          const it = rows[i]!
          const picked = i === sel - scroll
          // Tandai provider yang sedang aktif supaya user tahu apa yang akan
          // hilang bila ia menekan d. ID/URL dari config (data kotor mungkin)
          // disanitasi seperti label picker.
          const aktif = opts.currentModel?.startsWith(`${it.id}::`)
            ? ` (${t("common.active")})`
            : ""
          // Status aktif TAK BOLEH ikut terpotong: URL dipotong dari budget
          // sisa SETELAH head+aktif (dulu truncate menelan "(aktif)" dulu
          // saat URL panjang — user tak tahu mana yang aktif).
          const head = `${padToWidth(sanitizeAnsiLine(it.id), 18)} ${t("prov.models", { n: it.models })}  `
          const urlBudget = Math.max(8, w - 4 - displayWidth(head) - displayWidth(aktif))
          const label = `${head}${truncateToWidth(sanitizeAnsiLine(it.baseUrl), urlBudget, "…")}${aktif}`
          if (picked) lines.push(`  ${c.accent("›")} ${c.accent(c.bold(label))}`)
          else lines.push(`   ${dim(label)}`)
        }
        if (providers.length > scroll + v) {
          lines.push(cut(dim(t("dlg.more", { n: providers.length - scroll - v }))))
        }
      }
      // Struk transient (jalur legacy maupun modal).
      if (notice) lines.push(cut(dim(sanitizeAnsiLine(notice))))
      return lines
    }

    const hintText = (): string =>
      t("prov.hint", {
        select: c.accent(t("verb.select")),
        add: c.accent(t("verb.add")),
        delete: c.accent(t("verb.delete")),
        edit: c.accent(t("verb.edit")),
        close: c.accent(t("verb.close")),
      })

    const render = () => {
      // Popup komposit: HANYA region kotak (tanpa clear) di atas konten
      // pemilik layar. Lebar TETAP 76 (min=max) — tak bernapas.
      const box = dialogBox(
        {
          title: t("prov.title"),
          body: bodyLines(),
          footer: hintText(),
          minWidth: PROVIDER_BOX_W,
          maxWidth: PROVIDER_BOX_W,
        },
        screen.cols,
        screen.rows,
      )
      screen.paintRegion(box.lines, box.topRow)
      // Parkir kursor di baris item aktif (paritas picker/form). Indeks via
      // box.bodyTop — tebak manual meleset tiap judul berubah.
      const itemRow = Math.min(Math.max(0, sel - scroll), Math.max(0, visibleRows() - 1))
      const li = Math.min(box.lines.length - 1, box.bodyTop + itemRow)
      const row = box.topRow + li
      try {
        const leftPad = boxLeftPad(stripAnsi(box.lines[li] ?? ""))
        process.stdout.write(`\x1b[${row};${Math.max(1, leftPad + 1)}H\x1b[?25h`)
      } catch {}
    }

    // Popup butuh layar mampu; selain itu tolak BERSUARA + batal.
    const screen: AltScreen = openAltScreen()
    const useModal = screen.ok && (process.stdout.rows || 24) >= 10
    if (!useModal) {
      try {
        console.log(`⚠ ${t("gate.tuiProvider")}`)
      } catch {}
      // Tutup layar sebelum batal: openAltScreen sudah menulis ENTER fisik —
      // bail tanpa close membocorkan alt-screen + hold painter (I27).
      try {
        screen.close()
      } catch {}
      resolve()
      return
    }

    let done = false
    let busy = false
    // Idle-timeout 90 dtk seperti picker/model-manager: tanpa ini raw-mode
    // digenggam selamanya bila stdin 'data' tak pernah datang di Windows
    // (ConPTY macet) = "masuk list macet". Timer di-unref agar tak menahan exit.
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
    }
    let resetIdle: () => void = () => {}
    /** Listener stdin terpasang? Menjaga resume() idempoten (anti-ganda). */
    let attached = false

    // Suspend: lepas raw mode + listener sementara (untuk askLine/askSecret
    // di a/d/e). Tidak menyentuh `done` - manager tetap hidup; resume()
    // menggambar ulang region popup.
    const suspend = () => {
      clearIdle()
      attached = false
      process.stdout.write("\x1b[0m\x1b[?25h")
      // setRawMode dibungkus try/catch: di Windows handle bisa rusak dan
      // melempar — tanpa ini suspend melempar lalu Promise tak pernah settle.
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
    // Resume: pasang ulang raw mode + listener + render. Idempoten: tanpa
    // garda, resume ganda (watchdog timeout lalu aksi telat selesai) memasang
    // listener stdin DUA kali → tiap tombol diproses ganda.
    const resume = () => {
      if (done) return
      if (!attached) {
        process.stdin.setMaxListeners(0)
        try {
          process.stdin.setRawMode(true)
        } catch {
          // Raw-mode gagal = tak bisa baca tombol; tutup jujur daripada gantung.
          cleanup()
          resolve()
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
    // Close final: suspend + tandai selesai (manager tidak bisa dibuka lagi).
    // Selalu resolve walau suspend melempar — tanpa try/finally Promise gantung.
    const cleanup = () => {
      if (done) return
      done = true
      clearIdle()
      try {
        providerPump.dispose()
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
      try {
        suspend()
      } catch {}
    }

    resetIdle = () => {
      if (done) return
      clearIdle()
      idleTimer = setTimeout(() => {
        // Idle 90 dtk tanpa input = batal otomatis (samakan picker).
        try {
          cleanup()
        } catch {}
        try {
          resolve()
        } catch {}
      }, 90_000)
      try {
        ;(idleTimer as unknown as { unref?: () => void }).unref?.()
      } catch {}
    }

    // SEMUA aksi a/d/e lewat sini: busy guard + suspend, lalu SELALU resume di
    // finally. Tanpa finally, exception di onAdd/askLine (atau loadRows) membuat
    // busy tetap true → onData menolak semua input → manager terkunci selamanya.
    const runAction = (fn: () => Promise<void>) =>
      (async () => {
        if (busy) return
        busy = true
        suspend()
        try {
          await fn()
        } catch (e) {
          // Pesan controller/jaringan = input tak terpercaya: sanitasi.
          notice = `${glyphs.cross} ${sanitizeAnsiLine((e as Error).message)}`
        } finally {
          busy = false
          await reload().catch(() => {})
          resume()
        }
      })()

    /**
     * Batas waktu aksi jaringan: provider non-kooperatif yang gantung membuat
     * popup mati (suspend tanpa listener/timer). Timeout = notice jujur + UI
     * pulih; aksi telat yang akhirnya selesai diabaikan hasilnya. Tunggu
     * interaksi user (form/picker) TIDAK dibatasi — hanya await jaringan.
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

    const doAdd = () => {
      if (busy) return
      busy = true
      suspend()
      ;(async () => {
        try {
          // Langkah 1: preset via picker (daftar + filter, dalam popup).
          const CUSTOM = "custom-url"
          const picked: string | null = await new Promise((resolvePick) => {
            try {
              void runPicker({
                title: t("prov.addTitle"),
                items: [
                  ...opts.presets.map((p) => ({ name: p.label, provider: "", value: p.id })),
                  { name: t("prov.customUrl"), provider: "", value: CUSTOM },
                ],
                filterable: true,
                placeholder: t("pick.placeholder"),
                onPick: (v) => resolvePick(v),
                onCancel: () => resolvePick(null),
              }).catch(() => resolvePick(null))
            } catch {
              resolvePick(null)
            }
          })
          if (picked == null) {
            notice = t("common.canceled")
            return
          }
          const preset = picked === CUSTOM ? undefined : opts.presets.find((p) => p.id === picked)
          // Langkah 2: form dalam popup (URL + key + scope + konfirmasi
          // timpa bila duplikat). SEMUA ketikan di dalam kotak.
          const duplicate = preset && providers.some((r) => r.id === preset.id)
          const fields = [
            {
              id: "url",
              label: t("prov.urlLabel"),
              kind: "text" as const,
              initial: preset?.baseUrl ?? "",
              validate: validateUrl,
            },
            {
              id: "key",
              label: t("prov.keyLabel"),
              kind: "secret" as const,
              validate: validateRequired,
            },
            ...(opts.askScope
              ? [
                  {
                    id: "scope",
                    label: t("prov.scopeLabel"),
                    kind: "select" as const,
                    options: ["global", "local"],
                  },
                ]
              : []),
            ...(duplicate
              ? [
                  {
                    id: "overwrite",
                    label: t("prov.overwriteLabel", { id: preset.id }),
                    kind: "confirm" as const,
                  },
                ]
              : []),
          ]
          const form = await runForm({ title: t("prov.addTitle"), fields }, screen)
          if (form.cancelled || !form.values) {
            notice = t("common.canceled")
            return
          }
          if (duplicate && form.values.overwrite !== "y") {
            notice = t("common.canceled")
            return
          }
          const baseUrl = (form.values.url ?? "").trim()
          const apiKey = form.values.key ?? ""
          const scope = form.values.scope === "local" ? "local" : "global"
          // Progres terlihat: render notice DULU (masih suspend = tanpa
          // listener ganda), baru await jaringan.
          notice = t("ntc.detecting")
          render()
          const res = await withWatchdog(() => opts.onAdd({ preset, baseUrl, apiKey, scope }))
          // Hasil dari jaringan/config — sanitasi sebelum tampil.
          if (res.ok) notice = `${glyphs.check} ${sanitizeAnsiLine(res.ok)}`
          else if (res.err) notice = `${glyphs.cross} ${sanitizeAnsiLine(res.err)}`
        } catch (e) {
          notice = `${glyphs.cross} ${(e as Error).message}`
        } finally {
          busy = false
          await reload().catch(() => {})
          resume()
        }
      })()
    }

    const doDelete = () => {
      if (providers.length === 0) return
      const target = providers[sel]
      if (!target) return
      return runAction(async () => {
        // Konfirmasi menyebut DAMPAK, bukan hanya nama: berapa model ikut hilang,
        // dan apakah provider ini yang sedang dipakai. Form confirm dalam popup
        // (konteks terlihat saat menjawab).
        const active = opts.currentModel?.startsWith(`${target.id}::`)
        const form = await runForm(
          {
            title: t("prov.deleteTitle"),
            fields: [
              {
                id: "ok",
                label:
                  t("prov.deleteLabel", { id: target.id, n: target.models }) +
                  (active ? t("prov.deleteActive", { model: opts.currentModel ?? "" }) : "") +
                  t("prov.deleteAsk"),
                kind: "confirm",
              },
            ],
            footer: t("prov.deleteFooter"),
          },
          screen,
        )
        if (form.cancelled || form.values?.ok !== "y") {
          notice = t("common.canceled")
          return
        }
        const res = await withWatchdog(() => opts.onDelete(target))
        if (res.ok) notice = `${glyphs.check} ${sanitizeAnsiLine(res.ok)}`
        else if (res.err) notice = `${glyphs.cross} ${sanitizeAnsiLine(res.err)}`
      })
    }

    const doEdit = () => {
      if (providers.length === 0) return
      const target = providers[sel]
      if (!target) return
      return runAction(async () => {
        const defaults = await opts.onEditDefaults(target)
        if (!defaults) {
          notice = t("ntc.notFound")
          return
        }
        // Form edit dalam popup (prefill defaults). Batal di mana pun =
        // batal total (tanpa jatuh ke "pertahankan nilai lama").
        const form = await runForm(
          {
            title: t("prov.editTitle", { id: target.id }),
            fields: [
              {
                id: "url",
                label: t("prov.urlLabel"),
                kind: "text",
                initial: defaults.baseUrl,
                validate: validateUrl,
              },
              // Key kosong = pertahankan lama (tanpa validate required).
              { id: "key", label: t("prov.keyKeepLabel"), kind: "secret", initial: "" },
            ],
            footer: t("form.footerDefault"),
          },
          screen,
        )
        if (form.cancelled || !form.values) {
          notice = t("common.canceled")
          return
        }
        // Key kosong = pertahankan lama (placeholder [****] memberi tahu).
        const baseUrl = (form.values.url ?? "").trim() || defaults.baseUrl
        const apiKey = (form.values.key ?? "").trim() || defaults.apiKey
        if (baseUrl === defaults.baseUrl && apiKey === defaults.apiKey) {
          notice = t("ntc.noChange")
        } else {
          notice = t("ntc.detecting")
          render()
          const res = await withWatchdog(() => opts.onEditSave(target, { baseUrl, apiKey }))
          if (res.ok) notice = `${glyphs.check} ${sanitizeAnsiLine(res.ok)}`
          else if (res.err) notice = `${glyphs.cross} ${sanitizeAnsiLine(res.err)}`
        }
      })
    }

    const decoder: DecoderState = createDecoderState()
    // Seperti model-manager: simpan batas listener warisan, kembalikan di
    // cleanup agar warning MaxListenersExceeded tetap berguna setelahnya.
    // Guard typeof: stdin bisa stub (test) tanpa API ini — anggap default 10.
    const prevMaxListeners =
      typeof process.stdin.getMaxListeners === "function" ? process.stdin.getMaxListeners() : 10
    // Jalur tunggal key (sinkron + flush lone-ESC 50ms). True = selesai.
    const handleProviderKeys = (keys: DecodedKey[]): boolean => {
      if (busy || done) return true
      // Struk lama dibersihkan tiap keypress baru (transient, bukan arsip).
      notice = null
      try {
        for (const d of keys) {
          switch (d.key.type) {
            case "up":
              sel = Math.max(0, sel - 1)
              render()
              break
            case "down":
              // Daftar kosong: jangan biarkan sel=-1 (Enter lalu salah tutup).
              sel = providers.length ? Math.min(providers.length - 1, sel + 1) : 0
              render()
              break
            case "home":
              // Home/End = lompat atas/bawah daftar (paritas picker/App).
              sel = 0
              scroll = 0
              render()
              break
            case "end":
              sel = providers.length ? Math.max(0, providers.length - 1) : 0
              render()
              break
            case "pageup":
            case "pagedown": {
              // Scroll daftar per halaman (paritas picker/App). Gagal-di-kode-lama:
              // tombol ini tak ditangani sama sekali padahal ada baris `… more`.
              const v = visibleRows()
              if (providers.length > v) {
                const page = Math.max(1, v - 1)
                scroll = Math.max(
                  0,
                  Math.min(
                    Math.max(0, providers.length - v),
                    scroll + (d.key.type === "pageup" ? -page : page),
                  ),
                )
                sel = Math.max(0, Math.min(providers.length - 1, sel))
                if (sel < scroll) sel = scroll
                if (sel >= scroll + v) sel = scroll + v - 1
                render()
              }
              break
            }
            case "char": {
              const ch = d.key.ch.toLowerCase()
              if (ch === "a") {
                void doAdd()
                return true
              }
              if (ch === "d") {
                void doDelete()
                return true
              }
              if (ch === "e") {
                void doEdit()
                return true
              }
              break
            }
            case "enter": {
              // Footer bilang "select"; daftar kosong tak boleh menutup layar.
              const p = providers[sel]
              if (!p) return true
              try {
                opts.onSelect(p)
              } catch {}
              cleanup()
              resolve()
              return true
            }
            case "esc":
            case "ctrl-c":
            case "ctrl-d":
              cleanup()
              resolve()
              return true
            default:
              break
          }
        }
        render()
        return false
      } catch {
        // Tanpa resolve Promise gantung selamanya (bug: cleanup saja tak cukup).
        try {
          cleanup()
        } catch {}
        try {
          resolve()
        } catch {}
        return true
      }
    }
    const providerPump = createKeyStreamPump({ state: decoder, onKeys: handleProviderKeys })
    const onData = (chunk: Buffer) => {
      resetIdle()
      try {
        providerPump.push(chunk)
      } catch {
        try {
          cleanup()
        } catch {}
        try {
          resolve()
        } catch {}
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
        cleanup()
      } catch {}
      try {
        console.log(`⚠ ${t("prov.failOpen", { msg: String((e as Error)?.message ?? e) })}`)
      } catch {}
      try {
        resolve()
      } catch {}
    }
  })
}
