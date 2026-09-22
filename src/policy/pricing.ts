// Tabel harga model: bawaan (offline) + overlay opsional dari models.dev.
//
// Keputusan desain: **tidak ada fetch otomatis**. Tabel bawaan tetap jadi
// sumber default supaya `minicode` bekerja offline dan deterministik. Data
// models.dev hanya dipakai bila user menariknya sendiri (`minicode pricing
// sync`) — karena request otomatis ke pihak ketiga saat startup menambah
// latensi dan membocorkan pola pemakaian (IP + waktu) tanpa diminta.
//
// Cache disimpan di `~/.minicode/pricing.json`, hanya field biaya yang diambil
// (response penuh 4,4 MB → cache <200 KB), dengan TTL supaya data lama tetap
// dipakai bila jaringan mati alih-alih jatuh ke "N/A".

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { LIMITS } from "../constants.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { homeDir } from "../lib/db-path.ts"
import { isPrivateHostWithDns } from "../lib/net.ts"

export interface ModelPrice {
  /** USD per 1 juta token. */
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

// Tabel bawaan — cukup untuk model yang paling sering dipakai, dan tetap
// akurat tanpa jaringan.
export const BUILTIN_PRICING: Record<string, ModelPrice> = {
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5 },
  "gpt-5": { input: 5, output: 15, cacheRead: 1.25 },
  "gpt-5-mini": { input: 0.5, output: 1.5, cacheRead: 0.12 },
  "gpt-5-nano": { input: 0.1, output: 0.4, cacheRead: 0.02 },
  o1: { input: 15, output: 60, cacheRead: 7.5 },
  o3: { input: 2, output: 8, cacheRead: 0.5 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "deepseek-chat": { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
  "deepseek-reasoner": { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
  "deepseek-v4": { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
  "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
  "gemini-2.0": { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.25 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cacheRead: 0.31 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.075 },
  "gemini-3-pro": { input: 1.25, output: 10, cacheRead: 0.31 },
  "gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.12 },
  "qwen3-coder-plus": { input: 1, output: 5, cacheRead: 0.1 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
}

// Dinamis: MINICODE_HOME bisa diset setelah modul dimuat (oleh test hermetic
// atau env wrapper). Const module-level membeku saat import — fungsi selalu
// mengevaluasi ulang.

export function pricingCachePath(): string {
  return join(homeDir(), ".minicode", "pricing.json")
}

const MODELS_DEV_URL = "https://models.dev/api.json"

interface PricingCache {
  fetchedAt: number
  source: string
  /** modelId → harga. Kunci di-lowercase agar lookup konsisten. */
  models: Record<string, ModelPrice>
}

/** Overlay in-memory; null = belum dimuat pada proses ini. */
let overlay: Record<string, ModelPrice> | null = null
let overlayMeta: { fetchedAt: number; count: number } | null = null

/** Reset state modul — untuk test. */
export function __resetPricingOverlay(): void {
  overlay = null
  overlayMeta = null
}

/**
 * Muat cache dari disk bila ada dan belum kedaluwarsa.
 *
 * Data kedaluwarsa TETAP dipakai (dengan catatan di `meta`): harga lama lebih
 * berguna daripada tidak ada harga sama sekali, dan user bisa `pricing sync`
 * kapan pun. Yang penting jangan diam-diam menembak jaringan.
 */
export async function loadPricingOverlay(): Promise<Record<string, ModelPrice>> {
  if (overlay) return overlay
  try {
    const raw = await readFile(pricingCachePath(), "utf8")
    const parsed = JSON.parse(raw) as PricingCache
    if (parsed && typeof parsed.models === "object" && parsed.models) {
      overlay = normalizePriceMap(parsed.models)
      overlayMeta = { fetchedAt: parsed.fetchedAt ?? 0, count: Object.keys(overlay).length }
      return overlay
    }
  } catch {
    // tak ada cache = normal
  }
  overlay = {}
  return overlay
}

export function pricingOverlayMeta(): { fetchedAt: number; count: number; stale: boolean } | null {
  if (!overlayMeta) return null
  return {
    ...overlayMeta,
    stale: Date.now() - overlayMeta.fetchedAt > LIMITS.PRICING_CACHE_TTL_MS,
  }
}

function toModelPrice(
  input: unknown,
  output: unknown,
  cacheRead: unknown,
  cacheWrite: unknown,
): ModelPrice | null {
  // F-06: harga negatif/NaN/Infinity dari overlay lokal (atau payload aneh)
  // tidak boleh menjadi biaya negatif — biaya negatif MENGURANGI sessionCost
  // sehingga --budget tak pernah memicu. Negatif = data rusak = unknown.
  if (typeof input !== "number" || typeof output !== "number") return null
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null
  if (input < 0 || output < 0) return null
  const cleanCache = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined
  const cr = cleanCache(cacheRead)
  const cw = cleanCache(cacheWrite)
  return {
    input,
    output,
    ...(cr !== undefined ? { cacheRead: cr } : {}),
    ...(cw !== undefined ? { cacheWrite: cw } : {}),
  }
}

function normalizePriceMap(src: Record<string, unknown>): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {}
  for (const [k, v] of Object.entries(src)) {
    const p = v as Partial<ModelPrice>
    const parsed = toModelPrice(p.input, p.output, p.cacheRead, p.cacheWrite)
    if (!parsed) continue
    out[k.toLowerCase()] = parsed
  }
  return out
}

/** Bentuk minimal entri models.dev yang kita pedulikan. Diekspor untuk test. */
export interface ModelsDevPayload {
  [providerId: string]: {
    models?: Record<
      string,
      {
        id?: string
        cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
      }
    >
  }
}

/**
 * Ekstrak hanya harga dari payload models.dev.
 *
 * Response penuh ~4,4 MB dan memuat deskripsi, modality, limit — kita hanya
 * butuh biaya. Ekstraksi dipisah agar bisa diuji tanpa jaringan.
 *
 * Satu model id sering ditawarkan beberapa provider dengan harga berbeda.
 * Contoh nyata (terukur): `qwen3-coder-plus` muncul di 6 provider — dua di
 * antaranya $0 (paket berlangganan), sisanya $1/M. Mengambil "yang pertama"
 * berarti harga akhir bergantung urutan iterasi objek, dan pada kasus ini
 * menghasilkan **$0** — estimasi biaya nol dan `--budget` tak pernah memicu.
 *
 * Strategi: buang kandidat gratis bila ada yang berbayar (paket berlangganan
 * bukan harga per-token yang bisa diestimasi), lalu ambil **median** — bukan
 * min (menyesatkan ke bawah) dan bukan max (alarmis).
 */
export function extractPricing(payload: ModelsDevPayload): Record<string, ModelPrice> {
  const candidates = new Map<string, ModelPrice[]>()
  for (const provider of Object.values(payload ?? {})) {
    for (const [key, model] of Object.entries(provider?.models ?? {})) {
      const cost = model?.cost
      const entry = toModelPrice(cost?.input, cost?.output, cost?.cache_read, cost?.cache_write)
      if (!entry) continue
      const id = (model.id ?? key).toLowerCase()
      if (!id) continue
      const list = candidates.get(id)
      if (list) list.push(entry)
      else candidates.set(id, [entry])
    }
  }

  const out: Record<string, ModelPrice> = {}
  for (const [id, list] of candidates) {
    const chosen = pickRepresentativePrice(list)
    if (chosen) out[id] = chosen
  }
  return out
}

/** Median harga, mengabaikan entri gratis bila ada yang berbayar. Diekspor untuk test. */
export function pickRepresentativePrice(list: ModelPrice[]): ModelPrice | undefined {
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  const paid = list.filter((p) => p.input > 0 || p.output > 0)
  const pool = paid.length > 0 ? paid : list
  const median = (nums: number[]): number => {
    const s = [...nums].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
  }
  const cacheReads = pool.map((p) => p.cacheRead).filter((v): v is number => typeof v === "number")
  const cacheWrites = pool
    .map((p) => p.cacheWrite)
    .filter((v): v is number => typeof v === "number")
  return {
    input: median(pool.map((p) => p.input)),
    output: median(pool.map((p) => p.output)),
    ...(cacheReads.length ? { cacheRead: median(cacheReads) } : {}),
    ...(cacheWrites.length ? { cacheWrite: median(cacheWrites) } : {}),
  }
}

export interface SyncResult {
  count: number
  bytes: number
  path: string
}

/**
 * Tarik harga dari models.dev dan simpan ke cache.
 * HANYA dipanggil dari perintah eksplisit — bukan dari jalur run biasa.
 */
export async function syncPricing(url: string = MODELS_DEV_URL): Promise<SyncResult> {
  try {
    const hostname = new URL(url).hostname
    if (await isPrivateHostWithDns(hostname)) throw new Error(`private host rejected: ${hostname}`)
  } catch (e) {
    if ((e as Error).message.includes("private host")) throw e
  }
  const res = await fetch(url, {
    signal: AbortSignal.timeout(LIMITS.PRICING_FETCH_TIMEOUT_MS * 4),
    headers: { accept: "application/json" },
    redirect: "manual",
  })
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location")
    if (loc) {
      try {
        const nextHost = new URL(loc, url).hostname
        if (await isPrivateHostWithDns(nextHost))
          throw new Error(`private host rejected: ${nextHost}`)
      } catch (e) {
        if ((e as Error).message.includes("private host")) throw e
      }
    }
    throw new Error(`models.dev → redirect ${res.status} not followed`)
  }
  if (!res.ok) throw new Error(`models.dev → HTTP ${res.status}`)
  // Hard-cap agar payload spoof tidak OOM (asli 4.4 MB, cap 2 MB cukup)
  const text = await res
    .text()
    .then((t) =>
      t.length > LIMITS.WEB_FETCH_BODY_HARD_CAP_CHARS
        ? t.slice(0, LIMITS.WEB_FETCH_BODY_HARD_CAP_CHARS)
        : t,
    )
  let payload: ModelsDevPayload
  try {
    payload = JSON.parse(text) as ModelsDevPayload
  } catch {
    throw new Error("models.dev membalas non-JSON")
  }
  const models = extractPricing(payload)
  const count = Object.keys(models).length
  if (count === 0) throw new Error("no prices could be extracted from models.dev")

  const cache: PricingCache = { fetchedAt: Date.now(), source: url, models }
  const serialized = JSON.stringify(cache)
  await atomicWriteText(pricingCachePath(), serialized)
  overlay = models
  overlayMeta = { fetchedAt: cache.fetchedAt, count }
  return { count, bytes: serialized.length, path: pricingCachePath() }
}

/**
 * Cari harga untuk nama model.
 *
 * Pencocokan per-segmen (pemisah `/` dan `:`) dengan kunci terpanjang lebih
 * dulu — supaya `claude-sonnet-4-5` menang atas `claude-sonnet-4`, dan
 * `my-gpt-4o-wrapper` TIDAK cocok dengan `gpt-4o`.
 *
 * Overlay (models.dev) diperiksa lebih dulu karena lebih baru; bawaan menjadi
 * jaring pengaman.
 */
export function findPrice(
  model: string,
  overlayMap: Record<string, ModelPrice> = overlay ?? {},
): ModelPrice | undefined {
  const m = model.toLowerCase()

  // Varian gratis (`:free` di OpenRouter) benar-benar $0. Tanpa cek ini,
  // pencocokan per-segmen mengabaikan sufiks dan memungut harga varian
  // berbayarnya: `z-ai/glm-5.2:free` dilaporkan $1,25/M padahal OpenRouter
  // menyatakan prompt=0 completion=0. Terverifikasi lewat /api/v1/models.
  // Kunci eksplisit di overlay tetap didahulukan (bila models.dev punya entri
  // untuk id ber-`:free`, itu lebih otoritatif).
  // Bentuk Zen (`-free`, mis. `deepseek-v4-flash-free`) diperlakukan sama:
  // tanpa ini ia cocok segmen `deepseek` dan sesi gratis 919rb token
  // dilaporkan $0,13 — merusak `--budget` dan angka /status.
  if (m.endsWith(":free") || /-free$/.test(m)) {
    const explicit = overlayMap[m] ?? BUILTIN_PRICING[m]
    if (explicit) return explicit
    return { input: 0, output: 0 }
  }

  const segments = m.split(/[/:]/)

  for (const table of [overlayMap, BUILTIN_PRICING]) {
    const keys = Object.keys(table).sort((a, b) => b.length - a.length)
    for (const k of keys) {
      const kl = k.toLowerCase()
      for (const s of segments) {
        if (
          s === kl ||
          s.startsWith(`${kl}.`) ||
          s.startsWith(`${kl}_`) ||
          s.startsWith(`${kl}-`)
        ) {
          return table[k]
        }
      }
    }
  }
  return undefined
}
