// P9.2.2.1 — Format baris peringatan recovery delegasi satu-shot.
//
// Modul murni tanpa efek samping: boleh diimpor test tanpa menjalankan CLI
// (cli/index.ts adalah skrip executable — formatter TAK BOLEH tinggal di
// sana). Warna tetap di boundary pemanggil (c.yellow), di sini teks polos.
// Nol penulis langsung (console/process.stdout) — jaga begitu agar
// inventaris writer tak berubah.
//
// Aturan tampilan: ringkasan anak adalah observasi model yang tak tepercaya.
// Secret sudah disanitasi saat persist (P9.2.1); di sini netralkan perilaku
// terminal (ANSI/escape/kontrol/baris) dengan helper mapan, BUKAN framework
// baru. Tak ada string di sini yang menjadi instruksi untuk model — ini
// stderr operator, bukan prompt.
import type { ChildStatus } from "../src/session/journal.ts"
import { isDisplayableChildStatus } from "../src/session/journal.ts"
import { sanitizeAnsiLine, stripSgr } from "../src/ui/render/sanitize.ts"

/**
 * Batas preview per anak (satuan code-unit UTF-16, konsisten dengan batas
 * 2000 durable di verification.ts): ringkasan durable tak pernah dicetak
 * utuh di baris peringatan. Nilai 240 menjaga satu baris tetap terbaca di
 * terminal sempit bersama imbuhan status — display-only, bukan retensi.
 */
export const RECOVERY_PREVIEW_MAX = 240

/** Input minimal formatter: identitas + observasi tervalidasi (boleh absen). */
export interface DelegateRecoveryEntry {
  readonly childSessionId: string
  readonly childStatus?: ChildStatus
  readonly resultSummary?: string
  readonly truncated?: boolean
}

/** Hasil preview: teks final + dari mana pemotongan berasal (jujur dua sumbu). */
export interface RecoveryPreview {
  readonly text: string
  readonly displayTruncated: boolean
  readonly persistedTruncated: boolean
}

/**
 * Potong ringkasan untuk satu baris terminal. Urutan mengikat (§7 misi):
 * sanitasi display dulu, lalu batasi, lalu tandai, lalu pembungkus warna
 * (di pemanggil). SGR dibuang juga (di luar warna pembungkus c.yellow —
 * SGR anak tak boleh mengubah presentasi baris). Lone surrogate di ujung
 * potongan dibuang (satu unit lebih pendek, bukan karakter rusak).
 */
export function boundRecoveryPreview(
  summary: string,
  persistedTruncated: boolean,
): RecoveryPreview {
  // U+2028/U+2029 dinetralkan jadi spasi di sini (jalur display, BUKAN
  // sanitizer global — preseden cleanCell di src/ui/render/table.ts:16):
  // keduanya batas baris logis yang dipertahankan sanitizeAnsiLine, dan
  // baris peringatan ini berkontrak satu baris fisik maupun logis.
  const safe = stripSgr(sanitizeAnsiLine(summary)).replace(/[\u2028\u2029]/g, " ")
  let text = safe
  let cut = 0
  if (text.length > RECOVERY_PREVIEW_MAX) {
    cut = text.length - RECOVERY_PREVIEW_MAX
    text = text.slice(0, RECOVERY_PREVIEW_MAX)
    if (/[\uD800-\uDBFF]$/.test(text)) {
      text = text.slice(0, -1)
      cut += 1
    }
  }
  if (cut > 0 && persistedTruncated) {
    return {
      text: `${text}…[+${cut} more, persisted truncated]`,
      displayTruncated: true,
      persistedTruncated: true,
    }
  }
  if (cut > 0) {
    return { text: `${text}…[+${cut} more]`, displayTruncated: true, persistedTruncated: false }
  }
  if (persistedTruncated) {
    return {
      text: `${text}…[persisted truncated]`,
      displayTruncated: false,
      persistedTruncated: true,
    }
  }
  return { text, displayTruncated: false, persistedTruncated: false }
}

/**
 * Satu baris peringatan per anak. Deterministik murni: tanpa IO, tanpa tulis
 * jurnal/sesi, tanpa eksekusi/retry. Tanpa amplop usable (record legacy atau
 * rusak) = baris legacy byte-identik — JANGAN ubah string legacy di bawah
 * tanpa ADR (test warisan menguncinya).
 */
export function formatDelegateRecoveryLine(entry: DelegateRecoveryEntry): string {
  const legacy =
    `[recovery] turn failed after sub-agent ${entry.childSessionId} ` +
    `completed — its effects stand; verify before re-delegating`
  // Keduanya wajib ada DAN status harus dikenal (predikat bersama dengan
  // pembaca — status asing tak boleh jadi teks status menyesatkan di lapisan
  // mana pun). Ringkasan WAJIB string: null/angka/objek dari jurnal
  // tulisan-tangan = rusak → fallback legacy. String kosong tetap valid
  // (observasi kosong yang jujur, bukan data hilang). Data yang diragukan →
  // fallback legacy, bukan tebakan setengah.
  if (!isDisplayableChildStatus(entry.childStatus) || typeof entry.resultSummary !== "string")
    return legacy
  const preview = boundRecoveryPreview(entry.resultSummary, entry.truncated === true)
  // `receipt: committed` akurat di sini karena pembaca (committedDelegatesSince)
  // hanya menghasilkan baris committed; ditulis eksplisit agar status observasi
  // anak TAK PERNAH dibaca sebagai vonis sukses eksekusi. Sufiks verifikasi
  // dipertahankan: efek yang selamat tetap harus diverifikasi.
  return (
    `[recovery] turn failed after sub-agent ${entry.childSessionId} ` +
    `(observed child status: ${entry.childStatus}; receipt: committed) — ` +
    `prior child output: ${preview.text} — effects stand; verify before re-delegating`
  )
}
