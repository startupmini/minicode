// P2.12 — pembasuh teks masuk IPC (label konsumen, pesan penolakan, ringkasan
// tool dari jaringan/lokal).
//
// Kenapa ada salinan lokal: `src/ui/render/sanitize.ts` berada di lapisan UI dan
// batas lapisan (test/ui-boundary.test.ts) MELARANG `src/**` non-ui mengimpor
// `src/ui/**`. Daemon tetap wajib membasuh input tak terpercaya sebelum
// disimpan/diteruskan — sanitizer lokal yang sederhana lebih baik daripada
// membiarkan ANSI/jalur kendali mengalir ke konsumen.
//
// Cakupannya disengaja sempit (satu string, tanpa state): cukup untuk label dan
// pesan, bukan stream teks model — stream itu tidak melewati jalur ini.
//
// Pola dibangun lewat String.fromCharCode(27) bukan literal ESC: berkas yang
// memuat byte kontrol mentah merusak tooling teks dan sering tak sengaja
// ter-strip oleh formatter — siluman yang paling sulit dicari.

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

// OSC: ESC ] … (BEL | ESC \). Dicek SEBELUM CSI: body OSC sering memuat "ESC ["
// sehingga urutan membalikkan hasilnya jadi sisa teks nyasar.
const OSC = new RegExp(ESC + "\\][^" + ESC + BEL + "]*(?:" + BEL + "|" + ESC + "\\\\)", "g")
// CSI: ESC [ params intermediate final.
const CSI = new RegExp(ESC + "\\[[0-9;?]*[ -/]*[@-~]", "g")
// Escape lain (ESC SP F …) — cukup buang dua-byte-nya.
const OTHER_ESC = new RegExp(ESC + "[ -/]*[@-~]", "g")
// C0 tanpa \n \t (kebutuhan teks biasa) + DEL. Ditulis lewat `new RegExp`
// bukan literal regex: literal akan memaksa byte kontrol ke dalam sumber
// (melanggar aturan yang sama seperti komentar di atas), sementara
// `noControlCharactersInRegex` justru melarang literal semacam itu.
// biome-ignore lint/complexity/useRegexLiterals: lihat alasan di atas.
const CTRL = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g")

export function sanitizeIncoming(s: string): string {
  if (typeof s !== "string" || s.length === 0) return ""
  return s.replace(OSC, "").replace(CSI, "").replace(OTHER_ESC, "").replace(CTRL, "")
}

/** Batasi panjang + basuh — untuk field yang nanti ikut dicetak/disimpan. */
export function sanitizeLabel(s: unknown, max = 120): string {
  if (typeof s !== "string" || s.length === 0) return ""
  return sanitizeIncoming(s).slice(0, max)
}

/** Basuh rekursif — untuk payload JSON yang datang dari peer. */
export function sanitizeJsonObject(value: unknown): unknown {
  if (typeof value === "string") return sanitizeIncoming(value)
  if (Array.isArray(value)) return value.map(sanitizeJsonObject)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizeLabel(k, 64)] = sanitizeJsonObject(v)
    }
    return out
  }
  return value
}
