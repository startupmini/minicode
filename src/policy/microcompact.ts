import type { Message } from "#minicore/core/types.ts"

/**
 * Microcompact — pangkas ISI hasil tool lama jadi sentinel pendek: tanpa
 * membuang pesan, tanpa LLM, tanpa menyentuh pasangan `assistant(toolCalls)`
 * → `tool` yang masih berlangsung.
 *
 * KENAPA: pada sesi panjang hasil tool adalah penyumbang payload terbesar
 * (>90% karakter konteks di lapangan). Kompaksi penuh mahal + lossy; memangkas
 * isi lama jauh lebih murah dan mempertahankan struktur percakapan. Lapisan
 * pertama sebelum kompaksi penuh, bukan penggantinya.
 *
 * KENAPA keepRecent=5: model masih butuh hasil terakhir untuk menyimpulkan
 * langkah berikutnya; 5 = titik kumpul lintas implementasi harness produksi.
 *
 * KENAPA gating tiga syarat: memangkas hasil kecil tak menghemat apa pun tapi
 * membuang informasi. Sepadan hanya bila (a) hemat berarti, (b) hasil tool
 * mendominasi, (c) bukan di tengah batch tool yang belum selesai.
 */

/** Tool yang hasilnya DAPAT dipulihkan (dibaca ulang kapan saja). Tool
 * kontrol-sesi (`todo`, `memory`) SENGAJA tidak masuk: isinya keadaan yang tak
 * bisa direkonstruksi dari filesystem — memangkasnya menghapus kebenaran. */
export const MICROCOMPACT_RECOVERABLE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "grep",
  "glob",
  "bash",
  "bash_output",
  "code_run",
  "web_fetch",
  "web_search",
  "list_dir",
  "view_file",
])

/** Awalan sentinel. Stabil supaya bisa dikenali ulang (idempoten) dan supaya
 * model tahu isinya dipangkas, bukan kosong. */
export const MICROCOMPACT_SENTINEL_PREFIX = "[hasil tool lama dipangkas"

export interface MicrocompactOptions {
  /** Hasil tool TERBARU yang dipertahankan utuh. Default 5. */
  keepRecent?: number
  /** Estimator token (disuntik agar modul tetap murni). */
  estimateTokens: (text: string) => number
  /** Hemat minimum agar pemangkasan sepadan. Default 20.000 token. */
  minSavingTokens?: number
  /** Porsi total hasil tool agar pemangkasan dipertimbangkan (default 40%). */
  minToolShare?: number
  /** Budget konteks efektif (jendela - reserve). Wajib untuk syarat (b). */
  budgetTokens?: number
}

export interface MicrocompactResult {
  readonly messages: readonly Message[]
  readonly clearedCount: number
  readonly savedTokens: number
  /** Diisi bila tak memangkas — dibedakan dari "tak ada yang bisa dipangkas"
   * supaya pemanggil tidak melaporkan no-op palsu. */
  readonly skippedReason?: "below-saving" | "below-share" | "no-candidates" | "in-flight-batch"
}

/** Konten pesan → teks untuk diukur. Objek bersarang di-stringify aman. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (content === null || content === undefined) return ""
  try {
    return JSON.stringify(content) ?? ""
  } catch {
    return String(content)
  }
}

/**
 * Indeks hasil tool yang berada dalam batch AKTIF (toolCall terakhir dari
 * assistant terakhir yang belum punya hasil lengkap).
 *
 * KENAPA penting: memangkas sebagian hasil dari satu batch multi-tool membuat
 * model melihat observasi setengah jadi — lebih menyesatkan daripada konteks
 * penuh. Batch dianggap aktif selama ia adalah grup `tool` terakhir.
 */
function activeBatchIds(messages: readonly Message[]): Set<string> {
  const lastAssistantIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "assistant") return i
    return -1
  })()
  if (lastAssistantIdx < 0) return new Set()
  // Semua hasil tool SETELAH assistant terakhir (bila ada) adalah batch aktif.
  const ids = new Set<string>()
  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    const m = messages[i]
    if (m?.role === "tool") ids.add(m.toolCallId)
  }
  return ids
}

/**
 * Murni (input tak dimutasi). Semua syarat harus lulus, jika tidak pesan
 * dikembalikan apa adanya: (1) kandidat = hasil tool yang dapat dipulihkan di
 * luar batch aktif, (2) melebihi `keepRecent`, (3) hemat ≥ `minSavingTokens`,
 * (4) total hasil tool ≥ `minToolShare` × budget.
 */
export function applyMicrocompact(
  messages: readonly Message[],
  opts: MicrocompactOptions,
): MicrocompactResult {
  const keepRecent = Math.max(1, opts.keepRecent ?? 5)
  const minSaving = Math.max(0, opts.minSavingTokens ?? 20_000)
  const minShare = opts.minToolShare ?? 0.4
  const inFlight = activeBatchIds(messages)

  // Dari belakang: `keepRecent` terbaru dipertahankan.
  const candidates: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "tool") continue
    if (!MICROCOMPACT_RECOVERABLE_TOOLS.has(m.name)) continue
    if (inFlight.has(m.toolCallId)) continue
    const text = contentText(m.content)
    if (text.startsWith(MICROCOMPACT_SENTINEL_PREFIX)) continue // sudah dipangkas
    candidates.push(i)
  }
  if (candidates.length === 0)
    return { messages, clearedCount: 0, savedTokens: 0, skippedReason: "no-candidates" }
  // `candidates` terurut dari belakang; `keepRecent` pertama = terbaru.
  const victims = candidates.slice(keepRecent)
  if (victims.length === 0)
    return { messages, clearedCount: 0, savedTokens: 0, skippedReason: "no-candidates" }

  // (b): hasil tool harus mendominasi budget, kalau tidak ia hanya membuang
  // informasi demi sedikit token.
  const toolTokens = candidates.reduce(
    (sum, i) => sum + opts.estimateTokens(contentText(messages[i]!.content)),
    0,
  )
  if (opts.budgetTokens !== undefined && opts.budgetTokens > 0) {
    if (toolTokens < opts.budgetTokens * minShare)
      return { messages, clearedCount: 0, savedTokens: 0, skippedReason: "below-share" }
  }

  let clearedCount = 0
  let savedTokens = 0
  const out = messages.slice()
  for (const idx of victims) {
    const m = messages[idx] as Extract<Message, { role: "tool" }>
    const original = contentText(m.content)
    const wasError = m.isError === true
    const sentinel = `${MICROCOMPACT_SENTINEL_PREFIX}: ${m.name} ${original.length} char${wasError ? ", gagal" : ""}. Jalankan ulang tool ini bila isinya masih dibutuhkan.]`
    // Hemat = token asli - token sentinel (sentinel tetap memakan token).
    const saving = opts.estimateTokens(original) - opts.estimateTokens(sentinel)
    out[idx] = { ...m, content: sentinel }
    clearedCount++
    // Sentinel bisa lebih panjang dari aslinya: jangan catat "hemat" palsu.
    savedTokens += Math.max(0, saving)
  }

  // (c): hemat harus berarti. Bila tidak, batalkan seluruh operasi.
  if (savedTokens < minSaving)
    return { messages, clearedCount: 0, savedTokens: 0, skippedReason: "below-saving" }

  return { messages: out, clearedCount, savedTokens }
}
