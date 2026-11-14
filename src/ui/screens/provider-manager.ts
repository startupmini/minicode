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
import { hintLine } from "../render/hint.ts"
import { cleanUntrusted, sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs, stripAnsi } from "../render/theme.ts"
import { truncateToWidth } from "../render/width.ts"
import { type AltScreen, openAltScreen } from "../runtime/screen.ts"
import { boxLeftPad, dialogBox, popupBoxWidth } from "./dialog.ts"
import { runForm, validateRequired, validateUrl } from "./form.ts"
import { createIdleTimer } from "./lifecycle.ts"
import { runPicker } from "./picker.ts"
import { withTimeout } from "./watchdog.ts"

const dim = (s: string): string => c.dim(s)

/** Lebar tetap popup provider setelah daftar diringkas ke nama provider. */
/** Lebar kotak /providers: `popupBoxWidth` — paritas picker/model/form (AUD-006). */
const providerBoxWidth = (): number => popupBoxWidth(process.stdout.columns || 80)

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
    // Ukuran mengikuti terminal sungguhan; satu baris border atas/bawah dan
    // kemungkinan notice tetap masuk ke perhitungan tinggi.
    const visibleRows = () => {
      const rows = process.stdout.rows || 24
      // Chrome tetap: 2 border + 1 baris hint aksi; notice (transient)
      // menyusutkan daftar satu baris — paritas model-manager, agar hint
      // tak pernah jadi korban potong atas dialogBox.
      const fixed = 3 + (notice ? 1 : 0)
      return Math.max(1, Math.min(rows - fixed, 14))
    }
    // Lebar konten = lebar kotak (dibekukan saat mount) dikurangi chrome
    // dialog (lihat picker.ts).
    const width = () => Math.max(8, providerBoxWidth() - 4)

    // Isi popup ringkas: nama provider dan hasil aksi sementara.
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
          // Nama provider dan status aktif cukup untuk memilih tanpa memenuhi
          // daftar dengan URL dan jumlah model.
          const aktif = opts.currentModel?.startsWith(`${it.id}::`)
            ? ` (${t("common.active")})`
            : ""
          const label = `${truncateToWidth(sanitizeAnsiLine(it.id), Math.max(8, w - 4 - aktif.length), "…")}${aktif}`
          if (picked) lines.push(`  ${c.accent("›")} ${c.accent(c.bold(label))}`)
          else lines.push(`   ${dim(label)}`)
        }
      }
      // Struk transient (jalur legacy maupun modal).
      if (notice) lines.push(cut(dim(sanitizeAnsiLine(notice))))
      // Hint aksi minimalis (kunci terang, label redup) — paritas /model.
      lines.push(
        cut(
          hintLine([
            { key: "Enter", label: t("hint.select") },
            { key: "a", label: t("hint.add") },
            { key: "e", label: t("hint.edit") },
            { key: "d", label: t("hint.delete") },
            { key: "Esc", label: t("hint.close") },
          ]),
        ),
      )
      return lines
    }

    const render = () => {
      // Popup komposit: HANYA region kotak (tanpa clear) di atas konten
      // Lebar beku (min=max, paritas picker/model).
      const box = dialogBox(
        {
          title: "",
          body: bodyLines(),
          minWidth: providerBoxWidth(),
          maxWidth: providerBoxWidth(),
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
    // (ConPTY macet) = "masuk list macet". Timer di-unref agar tak menahan
    // exit — satu sumber idle via helper bersama (audit D1). `cleanup`
    // dirujuk sebagai closure (dievaluasi saat timer fire).
    const idle = createIdleTimer({
      cancelMs: 90_000,
      onCancel: () => {
        try {
          cleanup()
        } catch {}
        try {
          resolve()
        } catch {}
      },
    })
    /** Listener stdin terpasang? Menjaga resume() idempoten (anti-ganda). */
    let attached = false

    // Suspend: lepas raw mode + listener sementara (untuk askLine/askSecret
    // di a/d/e). Tidak menyentuh `done` - manager tetap hidup; resume()
    // menggambar ulang region popup.
    const suspend = () => {
      idle.clear()
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
      idle.reset()
    }
    // Close final: suspend + tandai selesai (manager tidak bisa dibuka lagi).
    // Selalu resolve walau suspend melempar — tanpa try/finally Promise gantung.
    const cleanup = () => {
      if (done) return
      done = true
      idle.dispose()
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
    const withWatchdog = <T>(fn: () => Promise<T> | T): Promise<T> =>
      withTimeout(fn, opts.actionTimeoutMs ?? 60_000)

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
          // Pesan error jaringan/controller = input tak-terpercaya: tanpa
          // sanitasi, body provider bisa menyuntik `ESC[2J` ke popup dan
          // menghapus layar TUI (audit 2026-11-12, MEDIUM-2).
          notice = `${glyphs.cross} ${sanitizeAnsiLine((e as Error).message)}`
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
      idle.reset()
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
      idle.reset()
      render()
    } catch (e) {
      // Setup gagal = tutup + BERSUARA (Fase D): jendela kosong bisu adalah
      // kelas bug yang hanya bisa diburu bila terlihat.
      try {
        cleanup()
      } catch {}
      try {
        // Pesan setup gagal (bisa memuat body jaringan) = teks tak-terpercaya.
        console.log(
          `⚠ ${t("prov.failOpen", {
            msg: cleanUntrusted(String((e as Error)?.message ?? e), !!process.stdout.isTTY),
          })}`,
        )
      } catch {}
      try {
        resolve()
      } catch {}
    }
  })
}
