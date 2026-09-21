// i18n nol-dependensi — kamus statis + resolusi berlapis, pola yang sama
// dengan theme.ts: SEMUA dibaca via getter/fungsi saat DIPAKAI, jangan simpan
// hasil `t()` atau `currentLocale()` ke const module-scope (bahasa terkunci
// saat import — kesalahan yang sama seperti c/glyphs; dijaga test).
//
// Prioritas (keputusan produk): sesi (/lang) > MINICODE_LANG > state.json
// `lang` > locale OS (LANG/LC_ALL awalan `id`) > en. Kunci hilang di locale
// fallback en (tak pernah crash, tak pernah kunci mentah).
import { en } from "./en.ts"
import { id } from "./id.ts"

export type Locale = "en" | "id"
export type MsgKey = keyof typeof en

const dicts: Record<Locale, Record<MsgKey, string>> = { en, id }

/** Runtime switch sesi (/lang). Mengalahkan env + config selama sesi hidup. */
let sessionLocale: Locale | null = null
/** `lang` state.json (di-inject composition root dari state termuat). */
let configLocale: Locale | null = null

export function setSessionLocale(locale: Locale | null): void {
  sessionLocale = locale
}

export function setConfigLocale(locale: Locale | null): void {
  configLocale = locale
}

/** Untuk test: kembalikan ke steril (tanpa ini env bocor antar-file). */
export function resetLocaleState(): void {
  sessionLocale = null
  configLocale = null
}

function parseLocale(raw: string | undefined): Locale | null {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "id" || v.startsWith("id_") || v.startsWith("id-")) return "id"
  if (v === "en" || v.startsWith("en_") || v.startsWith("en-")) return "en"
  return null
}

/** Locale aktif SAAT INI (baca tiap panggil — jangan cache). */
export function currentLocale(): Locale {
  if (sessionLocale) return sessionLocale
  const env = parseLocale(process.env.MINICODE_LANG)
  if (env) return env
  if (configLocale) return configLocale
  const sys = process.env.LANG ?? process.env.LC_ALL ?? ""
  // Prefix `id` (id_ID.UTF-8, id_ID, id): sistem berbahasa Indonesia.
  if (/^id([_.@-]|$)/i.test(sys.trim())) return "id"
  return "en"
}

/**
 * Ambil string UI + interpolasi `{nama}`. Params tak dikenal dibiarkan
 * apa adanya (terlihat saat dev, bukan crash saat produksi).
 */
export function t(key: MsgKey, params?: Record<string, string | number>): string {
  const locale = currentLocale()
  const template = dicts[locale][key] ?? dicts.en[key] ?? key
  if (!params) return template
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  )
}
