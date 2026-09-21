// View wizard setup pertama — murni presentasi: picker gateway + form
// URL/key dalam popup. Penyimpanan provider lewat callback `onSubmit` yang
// di-inject controller (cli/wizard.ts). SEMUA langkah dalam kotak: tak ada
// ketikan di luar popup.
import { formatError } from "../assistant/simple.ts"
import { t } from "../i18n/locale.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs } from "../render/theme.ts"
import { openAltScreen } from "../runtime/screen.ts"
import { dialogBox } from "./dialog.ts"
import { runForm, validateUrl } from "./form.ts"
import { runPicker } from "./picker.ts"

export interface WizardPreset {
  label: string
  baseUrl: string
}

export interface SetupWizardViewOptions {
  presets: readonly WizardPreset[]
  /** Simpan provider; kembalikan pesan sukses, atau lempar untuk gagal. */
  onSubmit(baseUrl: string, apiKey: string): Promise<string>
}

/** Lebar kotak wizard TETAP (paritas picker/form/manager — tak bernapas antar langkah). */
const WIZARD_BOX_W = 64

/**
 * Tunggu tanpa menahan process hidup (unref): jeda sukses/gagal wizard tak
 * boleh menahan exit bila stdin sudah ditutup. Gagal-di-kode-lama: timer
 * polos menahan event-loop 1.2/2.5 dtk.
 */
function sleepUnref(ms: number): Promise<void> {
  return new Promise((r) => {
    const timer = setTimeout(r, ms)
    try {
      ;(timer as unknown as { unref?: () => void }).unref?.()
    } catch {}
  })
}

/**
 * Wizard setup pertama — hal PERTAMA yang dilihat pengguna baru.
 *
 * Memakai `runPicker` (panah + filter) untuk gateway, lalu form dalam popup
 * untuk URL + API key. Esc di langkah mana pun = batal total.
 */
export async function runSetupWizardView(opts: SetupWizardViewOptions): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const screen = openAltScreen()
  if (!screen.ok) return false
  try {
    const CUSTOM = "\u0000custom"
    const items = [
      ...opts.presets.map((p) => ({ name: p.label, provider: "", value: p.baseUrl })),
      { name: t("prov.customUrl"), provider: "", value: CUSTOM },
    ]

    let picked: string | null = null
    await runPicker({
      title: t("wiz.gateway"),
      items,
      filterable: true,
      placeholder: t("pick.placeholder"),
      onPick: (v) => {
        picked = v
      },
      onCancel: () => {
        picked = null
      },
    })
    if (picked === null) {
      process.stdout.write(`${t("wiz.canceled")}\n`)
      return false
    }

    // URL via form dalam popup (validasi inline, bukan gagal saat detect).
    const urlForm = await runForm(
      {
        title: t("wiz.title"),
        fields: [
          {
            id: "url",
            label: picked === CUSTOM ? t("wiz.urlLabel") : `${t("wiz.urlLabel")} [${picked}]`,
            kind: "text",
            initial: picked === CUSTOM ? "" : (picked as string),
            validate: (v) => {
              const val = v.trim() || (picked === CUSTOM ? "" : (picked as string))
              if (!val) return t("form.required")
              return validateUrl(val)
            },
          },
        ],
      },
      screen,
    )
    if (urlForm.cancelled || !urlForm.values) {
      process.stdout.write(`${t("wiz.canceled")}\n`)
      return false
    }
    const rawUrl = (urlForm.values.url ?? "").trim()
    const targetUrl = rawUrl || (picked === CUSTOM ? "" : (picked as string))
    if (!targetUrl) {
      process.stdout.write(`${t("wiz.canceled")}\n`)
      return false
    }

    // Endpoint lokal (Ollama/LM Studio) tidak butuh API key; kirim placeholder
    // agar header Authorization tetap terbentuk.
    const lokal = /^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(targetUrl)
    let apiKey = "ollama"
    if (!lokal) {
      const keyForm = await runForm(
        {
          title: t("wiz.title"),
          fields: [
            {
              id: "key",
              label: t("wiz.keyLabel", { url: targetUrl }),
              kind: "secret",
              validate: (v) => (v.trim() ? null : t("form.required")),
            },
          ],
        },
        screen,
      )
      if (keyForm.cancelled || !keyForm.values) {
        process.stdout.write(`${t("wiz.canceled")}\n`)
        return false
      }
      apiKey = (keyForm.values.key ?? "").trim()
      if (!apiKey) {
        process.stdout.write(`${t("wiz.keyLater")}\n`)
        return false
      }
    }

    // Progres sebagai baris dalam kotak (bukan spinner liar di bawah popup).
    const box = dialogBox(
      {
        title: t("wiz.title"),
        body: [c.muted(t("wiz.detecting"))],
        minWidth: WIZARD_BOX_W,
        maxWidth: WIZARD_BOX_W,
      },
      screen.cols,
      screen.rows,
    )
    screen.paintRegion(box.lines, box.topRow)
    try {
      const message = await opts.onSubmit(targetUrl, apiKey)
      // Pesan dari jaringan (nama model/gateway) — sanitasi sebelum tampil.
      screen.clearRegion()
      const doneBox = dialogBox(
        {
          title: t("wiz.title"),
          body: [`${glyphs.check} ${sanitizeAnsiLine(message)}`, "", t("wiz.done")],
          minWidth: WIZARD_BOX_W,
          maxWidth: WIZARD_BOX_W,
        },
        screen.cols,
        screen.rows,
      )
      screen.paintRegion(doneBox.lines, doneBox.topRow)
      await sleepUnref(1200)
      return true
    } catch (e) {
      screen.clearRegion()
      const errBox = dialogBox(
        {
          title: t("wiz.title"),
          body: [c.error(`${glyphs.cross} ${t("wiz.detectFail", { msg: formatError(e) })}`)],
          minWidth: WIZARD_BOX_W,
          maxWidth: WIZARD_BOX_W,
        },
        screen.cols,
        screen.rows,
      )
      screen.paintRegion(errBox.lines, errBox.topRow)
      await sleepUnref(2500)
      return false
    }
  } finally {
    try {
      screen.clearRegion()
    } catch {}
    try {
      screen.close()
    } catch {}
  }
}
