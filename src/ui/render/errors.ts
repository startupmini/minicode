// Pemetaan error provider/agent → pesan yang bisa ditindaklanjuti.
//
// PENTING: modul ini punya 10 test tapi dulu TIDAK dipanggil dari mana pun di
// kode produksi. Renderer memakai formatProviderError() yang mencetak
// `[kategori] <pesan mentah>`, sehingga body JSON provider tumpah utuh ke layar.
// Terlihat pada uji live OpenRouter: satu error 429 mencetak 400+ karakter
// berisi `metadata`, `provider_error_code`, `limit_source`, dan URL dokumentasi
// — di dalam frame TUI selebar 100 kolom.

import { t } from "../i18n/locale.ts"
import { sanitizeAnsiLine } from "./sanitize.ts"
import { truncateToWidth } from "./width.ts"

export interface FriendlyError {
  message: string
  fix?: string
}

/**
 * Ambil kalimat paling berguna dari body error provider.
 *
 * Bentuk yang ditemui di lapangan:
 * - OpenAI/umum : {"error":{"message":"..."}}
 * - OpenRouter  : {"error":{"message":"Provider returned error","metadata":{"raw":"<alasan sebenarnya>","remedy_hint":"..."}}}
 *   Di sini `message` justru tidak informatif; `metadata.raw` yang menjelaskan.
 * - Cloudflare  : HTML dengan <title>host | 502: Bad gateway</title>
 */
export function extractProviderDetail(raw: string): { detail?: string; hint?: string } {
  const trimmed = raw.trim()
  // JSON: cari objek pertama yang bisa di-parse.
  const start = trimmed.indexOf("{")
  if (start !== -1) {
    try {
      const parsed = JSON.parse(trimmed.slice(start)) as {
        error?: {
          message?: string
          metadata?: { raw?: string; remedy_hint?: string; provider_name?: string }
        }
      }
      const err = parsed.error
      const meta = err?.metadata
      // metadata.raw lebih spesifik daripada message generik OpenRouter.
      const detail = firstSentence(meta?.raw ?? err?.message)
      const hint = firstSentence(meta?.remedy_hint)
      return { ...(detail ? { detail } : {}), ...(hint ? { hint } : {}) }
    } catch {
      // Body terpotong (streaming) — jatuh ke regex di bawah.
    }
  }
  // HTML: judul halaman error biasanya sudah menjelaskan.
  const title = /<title>([^<]{1,120})<\/title>/i.exec(trimmed)
  // Judul HTML dari provider tak terpercaya — sanitasi satu-baris agar tag
  // / escape tak lolos via jalur error.
  if (title) return { detail: sanitizeAnsiLine(title[1]!.trim()) }
  // Regex terakhir untuk body yang TERPOTONG (stream terputus di tengah JSON).
  // `raw` didahulukan: pada OpenRouter itu yang memuat alasan sebenarnya,
  // sementara `message` hanya "Provider returned error". Kutip penutup dibuat
  // opsional — pada body terpotong ia memang belum ada.
  for (const field of ["raw", "message"]) {
    const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,300})"?`)
    const m = re.exec(trimmed)
    const value = m?.[1]?.replace(/\\"/g, '"').trim()
    if (value) return { detail: firstSentence(value) }
  }
  return {}
}

/** Satu kalimat pertama, dipangkas — bukan paragraf berisi URL dan kode. */
function firstSentence(s?: string, max = 150): string | undefined {
  if (!s) return undefined
  const clean = s.replace(/\s+/g, " ").trim()
  if (!clean) return undefined
  const cut = /^(.{20,}?[.!?])\s/.exec(clean)
  const one = cut ? cut[1]! : clean
  // Potong per KOLOM terminal (CJK/emoji = 2) dan jangan belah SGR/surrogate;
  // input di sini belum tentu sanitize, jadi sanitasi satu-baris dulu agar
  // ESC[2J/OSC tak lolos via pesan error provider yang tak terpercaya.
  const safe = sanitizeAnsiLine(one)
  return truncateToWidth(safe, max, "…")
}

/**
 * Redaksi rahasia minimal untuk jalur tampil (temuan audit #03, diperketat
 * audit #10 §8/§10/§11).
 *
 * src/ui DILARANG mengimpor policy/scrub.ts (ui-boundary), jadi pola penuh
 * tinggal di sana sebagai kanonis. Yang di sini hanya jaring pengaman untuk
 * kasus konkret: proxy/server menggemakan kredensial ke dalam body error
 * (mis. `Authorization: Bearer …`), yang lalu dirender verbatim oleh
 * formatError. Bukan pengganti scrubSecrets — hanya untuk pesan error.
 *
 * Dua bentuk ditangani BERURUTAN (temuan audit #10, reproducer: header
 * Authorization Bearer — sebelumnya hanya `Authorization:` yang teredaksi
 * sebagai key=value sehingga token aslinya tetap tampil):
 *  1. `Bearer <token>` spasi (bentuk header HTTP yang sah — tanpa `:`/`=`).
 *  2. `key=value`/`key: value` untuk kata-kunci kredensial + cookie/session.
 * `sessionid` dibatasi lowercase eksplisit (audit #11 §18: pola insensitif
 * ikut menyamarkan identifier `sessionId` di pesan error).
 * Guard nilai quoted/berdigit/panjang dipakai di kedua pola kv (audit #11
 * §18: tanpa guard, `token: string` dan SQL `session_id = ?` ikut tersamarkan
 * sehingga diagnostik sah buta).
 */
function redactSecrets(s: string): string {
  // Nilai berbentuk kredensial: quoted, atau berdigit, atau panjang.
  // Identifier/type-word (`string`, `graphemes`, `?`) lolos; token realistis kena.
  // `=` termasuk agar nilai cookie berbentuk pasangan kunci-nilai utuh tersamarkan.
  const V = `(?:"[^"]+"|'[^']+'|[A-Za-z0-9_~+/=-]*\\d[A-Za-z0-9_~+/=-]*|[A-Za-z0-9_~+/=-]{12,})`
  const V4 = `(?:"[^"]+"|'[^']+'|[A-Za-z0-9_~+/=-]*\\d[A-Za-z0-9_~+/-]*|[A-Za-z0-9_~+/=-]{4,})`
  return (
    s
      // Format kunci provider konkret (subset scrub.ts — ui-boundary melarang
      // impor policy/scrub; pola generik di bawah tak menangkap `sk-ant-…`,
      // `thk_live_…`, `hf_…`, JWT tanpa konteks kv). Divalidasi bug-hunt
      // 2026-09-19: echo proxy key-key ini lolos mentah ke layar sebelumnya.
      .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[redacted]")
      .replace(/\b(thk_live_[A-Za-z0-9_-]{16,})\b/g, "[redacted]")
      .replace(/\b(hf_[A-Za-z0-9]{20,})\b/g, "[redacted]")
      .replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, "[redacted]")
      .replace(/([?&](?:api[_-]?key|apikey|token|secret|password)=)[^&\s"'<>]*/gi, "$1[redacted]")
      .replace(/\bbearer\s+["']?[A-Za-z0-9._~+/-]{6,}["']?/gi, "Bearer [redacted]")
      .replace(
        new RegExp(
          `((?:api[_-]?key|token|authorization|secret|password|client[_-]?secret|cookie)\\s*[:=]\\s*)(?!\\[redacted\\])(${V})`,
          "gi",
        ),
        "$1[redacted]",
      )
      .replace(new RegExp(`(\\bsession[-_]?id\\s*[:=]\\s*)(${V4})`, "g"), "$1[redacted]")
  )
}

// Mapping kategori formal -> pesan user-friendly. Detail provider disertakan
// sebagai satu kalimat bila ada (itu yang memberi tahu model mana yang limit,
// atau tool mana yang tidak didukung) — bukan seluruh body.
export function friendlyFromCategory(category: string, detail: string): FriendlyError {
  // Detail datang dari body error provider (proxy tak terpercaya): redact dulu
  // lalu sanitasi satu-baris agar ESC[2J/OSC/alternate-screen tak bisa lolos
  // via jalur error yang dicetak writer mentah di cli/.
  const truth = sanitizeAnsiLine(redactSecrets(detail.trim()))
  const { detail: providerDetail, hint } = extractProviderDetail(truth)
  const withDetail = (base: string) =>
    providerDetail && providerDetail.toLowerCase() !== base.toLowerCase()
      ? `${base}: ${providerDetail}`
      : base

  switch (category) {
    // Deteksi kata kunci TETAP Inggris: body error provider berbahasa Inggris
    // apa pun locale UI. Yang diterjemahkan hanya pesan/fix tampil.
    case "rate_limit":
      return {
        message: withDetail(t("err.rateLimit")),
        fix: hint ?? t("err.rateLimitFix"),
      }
    case "auth": {
      const low = truth.toLowerCase()
      if (
        low.includes("insufficient balance") ||
        low.includes("credits") ||
        low.includes("billing") ||
        low.includes("quota") ||
        low.includes("credit limit")
      ) {
        return {
          message: withDetail(t("err.balance")),
          fix: hint ?? t("err.balanceFix"),
        }
      }
      return {
        message: withDetail(t("err.auth")),
        fix: hint ?? t("err.authFix"),
      }
    }
    case "server":
      return {
        message: withDetail(t("err.server")),
        fix: hint ?? t("err.serverFix"),
      }
    case "network":
      return {
        message: withDetail(t("err.network")),
        fix: hint ?? t("err.networkFix"),
      }
    case "invalid_request":
      return {
        message: withDetail(t("err.invalid")),
        fix: hint ?? t("err.invalidFix"),
      }
    case "context_length_exceeded":
      return {
        message: withDetail(t("err.context")),
        fix: hint ?? t("err.contextFix"),
      }
    case "content_filter":
      return {
        message: withDetail(t("err.filter")),
        fix: hint ?? t("err.filterFix"),
      }
    default: {
      // Kategori "unknown" menampung status HTTP lain (mis. 402 dari vendor
      // yang frozen) — kenali pola tagihan/limit dari TEKS agar pesannya
      // tetap actionable, bukan dump mentah.
      const low = truth.toLowerCase()
      if (
        low.includes("insufficient balance") ||
        low.includes("credits") ||
        low.includes("billing") ||
        low.includes("quota") ||
        low.includes("credit limit") ||
        low.includes("requires more credits") ||
        low.includes("fewer max_tokens")
      ) {
        return {
          message: withDetail(t("err.balance")),
          fix: hint ?? t("err.balanceFix"),
        }
      }
      if (
        low.includes("rate limit") ||
        low.includes("rate_limit") ||
        low.includes("429") ||
        low.includes("freeusagelimit") ||
        low.includes("try again later")
      ) {
        return {
          message: withDetail(t("err.rateLimit")),
          fix: hint ?? t("err.rateLimitFix"),
        }
      }
      if (providerDetail) return { message: providerDetail, ...(hint ? { fix: hint } : {}) }
      // truth sudah sanitize satu-baris; potong per kolom agar CJK/emoji tak
      // meluap dan tak belah SGR/surrogate.
      return { message: truncateToWidth(truth, 160, "…") }
    }
  }
}

// Fallback string-only (AgentError: timeout/aborted/max_steps, dst.)
export function friendlyError(raw: string): FriendlyError {
  const lower = raw.toLowerCase()
  if (lower.includes("timed out") || lower.includes("timeout"))
    return {
      message: t("err.timeout"),
      fix: t("err.timeoutFix"),
    }
  if (lower.includes("max steps") || lower.includes("max_steps"))
    return {
      message: t("err.steps"),
      fix: t("err.stepsFix"),
    }
  if (lower.includes("budget")) return { message: t("err.budget"), fix: t("err.budgetFix") }
  if (lower.includes("busy")) return { message: t("err.busy"), fix: t("err.busyFix") }
  if (lower.includes("aborted")) return { message: t("err.aborted") }
  const { detail } = extractProviderDetail(raw)
  // detail sudah sanitize via firstSentence; redact tak menambah ANSI, tapi
  // bungkus lagi agar idempoten bila pemanggil mengirim mentah di masa depan.
  if (detail) return { message: sanitizeAnsiLine(redactSecrets(detail)) }
  const safe = sanitizeAnsiLine(redactSecrets(raw))
  return { message: truncateToWidth(safe, 160, "…") }
}

/** Satu baris siap tampil: pesan + saran. Dipakai renderer TUI & one-shot. */
export function formatFriendly(e: FriendlyError): string {
  return e.fix ? `${e.message}\n  → ${e.fix}` : e.message
}
