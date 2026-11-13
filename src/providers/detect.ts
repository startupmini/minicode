import { LIMITS } from "../constants.ts"

export interface DetectedModel {
  id: string
  /**
   * Jendela konteks yang DILAPORKAN endpoint `/models`, bila ada.
   *
   * KENAPA dibaca: kapasitas endpoint yang benar-benar dipanggil adalah sumber
   * otoritatif — katalog publik bisa basi atau tidak mengenali alias gateway.
   * Nilai ini tidak dikarang: hanya diisi bila endpoint menyertakannya.
   */
  contextLength?: number
  /** Batas output model (`max_output_tokens`) bila dilaporkan. Dipakai sebagai
   * reserve output proporsional, bukan angka tetap. */
  maxOutputTokens?: number
}

export interface DetectResult {
  models: string[]
  /** Metadata per model, hanya untuk model yang endpoint-nya melaporkan
   * kapasitas. Model tanpa metadata tidak muncul di sini (tidak dikarang). */
  modelMetadata?: Record<string, DetectedModel>
  providerHint: "openai" | "anthropic" | "responses" | "unknown"
  /**
   * True bila server menjawab 401/403 di salah satu attempt: key salah/
   * kedaluwarsa. Beda dari "tanpa endpoint /models" (404, mis. Anthropic)
   * dan dari jaringan mati (tak ada respons sama sekali). Pemanggil JANGAN
   * menutupi ini dengan fallback model — laporkan unauthorized dengan jujur.
   */
  authFailed: boolean
}

// Cache in-memory per baseUrl (30 menit) — /sync yang sering dipanggil tidak
// perlu re-deteksi network tiap kali. Key = url tanpa apiKey (secrets tidak
// pernah disimpan atau di-log).
const cache = new Map<string, { at: number; result: DetectResult }>()
const CACHE_TTL_MS = 30 * 60 * 1000

export function clearDetectCache(): void {
  cache.clear()
}

export function cacheKey(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").toLowerCase()
}

function hybridHeaders(apiKey: string): Record<string, string>[] {
  if (!apiKey) return [{}]
  // hybrid: coba Bearer dan x-api-key
  return [
    { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey },
    { Authorization: `Bearer ${apiKey}` },
    { "x-api-key": apiKey },
  ]
}

/**
 * Nama field yang dipakai berbagai gateway/agregator untuk melaporkan
 * kapasitas konteks. Tidak ada standar tunggal: OpenAI-compat memakai
 * `context_length`, Anthropic-style memakai `max_input_tokens`, agregator
 * memakai `context_window` atau menyarangkan di `top_provider`.
 *
 * KENAPA daftar eksplisit, bukan tebakan berbasis substring: field bernama
 * `max_tokens` pada sebagian endpoint berarti batas OUTPUT, bukan konteks —
 * memetakannya sebagai konteks akan mengecilkan jendela secara diam-diam,
 * persis kelas bug yang ingin dihilangkan.
 */
const CONTEXT_FIELD_ALIASES = [
  "context_length",
  "context_window",
  "max_context_length",
  "max_context_tokens",
  "max_input_tokens",
  "input_token_limit",
] as const

const OUTPUT_FIELD_ALIASES = [
  "max_output_tokens",
  "max_completion_tokens",
  "max_output",
  "output_token_limit",
] as const

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  const n = Math.floor(value)
  // Batas atas jauh di atas kapasitas model publik mana pun (2M) — menolak
  // nilai rusak/absurd tanpa menolak model nyata.
  return n > 0 && n <= 20_000_000 ? n : undefined
}

function pickField(obj: Record<string, unknown>, aliases: readonly string[]): number | undefined {
  for (const key of aliases) {
    const v = positiveInt(obj[key])
    if (v !== undefined) return v
  }
  return undefined
}

/**
 * Ekstrak metadata kapasitas dari satu entri `/models`.
 *
 * Diekspor untuk test: perilaku yang paling penting diuji di sini — payload
 * tanpa field kapasitas harus menghasilkan `undefined` (bukan angka karangan).
 */
export function extractModelCapacity(entry: unknown): {
  contextLength?: number
  maxOutputTokens?: number
} {
  if (!entry || typeof entry !== "object") return {}
  const obj = entry as Record<string, unknown>
  // Agregator menyarangkan kapasitas di `top_provider`, tapi sebagian juga
  // menduplikasinya di level atas — cek keduanya, level atas menang karena
  // itu yang paling spesifik untuk model ini.
  const nested =
    obj.top_provider && typeof obj.top_provider === "object"
      ? (obj.top_provider as Record<string, unknown>)
      : undefined
  const contextLength =
    pickField(obj, CONTEXT_FIELD_ALIASES) ??
    (nested ? pickField(nested, CONTEXT_FIELD_ALIASES) : undefined)
  const maxOutputTokens =
    pickField(obj, OUTPUT_FIELD_ALIASES) ??
    (nested ? pickField(nested, OUTPUT_FIELD_ALIASES) : undefined)
  return {
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  }
}

/** Petakan entri mentah `/models` → id + metadata (hanya yang dilaporkan). */
function mapEntries(raw: unknown[]): {
  models: string[]
  modelMetadata?: Record<string, DetectedModel>
} {
  const models: string[] = []
  let metadata: Record<string, DetectedModel> | undefined
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const id = (entry as { id?: unknown }).id
    if (typeof id !== "string" || !id) continue
    models.push(id)
    const capacity = extractModelCapacity(entry)
    if (capacity.contextLength !== undefined || capacity.maxOutputTokens !== undefined) {
      metadata ??= {}
      metadata[id] = { id, ...capacity }
    }
  }
  return { models, ...(metadata ? { modelMetadata: metadata } : {}) }
}

async function tryFetchModels(
  baseUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{
  models: string[] | null
  modelMetadata?: Record<string, DetectedModel>
  contacted: boolean
  sawAuth: boolean
}> {
  const urls = [`${baseUrl.replace(/\/+$/, "")}/models`, `${baseUrl.replace(/\/+$/, "")}/v1/models`]
  let contacted = false
  let sawAuth = false
  for (const url of urls) {
    // timeout PER-ATTEMPT: satu fetch yang menggantung tidak memakan seluruh
    // budget sinyal luar — kombinasi via AbortSignal.any.
    const perAttempt = AbortSignal.timeout(LIMITS.DETECT_ATTEMPT_TIMEOUT_MS)
    const attemptSignal = signal ? AbortSignal.any([signal, perAttempt]) : perAttempt
    try {
      const res = await fetch(url, { headers, signal: attemptSignal })
      contacted = true // server menjawab (walau 404) — bukan jaringan mati
      // 401/403 = key salah, BUKAN "tanpa endpoint": catat agar pemanggil
      // tak menutupinya dengan fallback model (yang membuat key salah
      // terlihat sukses tersimpan).
      if (res.status === 401 || res.status === 403) sawAuth = true
      if (!res.ok) continue
      const json = (await res.json()) as { data?: unknown[]; models?: unknown[] }
      const data = json.data ?? json.models ?? []
      if (Array.isArray(data) && data.length) {
        const mapped = mapEntries(data)
        if (mapped.models.length)
          return {
            models: mapped.models,
            ...(mapped.modelMetadata ? { modelMetadata: mapped.modelMetadata } : {}),
            contacted,
            sawAuth,
          }
      }
    } catch {}
  }
  return { models: null, contacted, sawAuth }
}

export async function detectModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<DetectResult> {
  // serve dari cache bila masih segar (anti request redundant dalam 30 menit)
  const key = cacheKey(baseUrl)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result

  // CAP global — jangan pernah biarkan user menunggu lama pada gateway offline
  const sig = signal ?? AbortSignal.timeout(LIMITS.DETECT_GLOBAL_TIMEOUT_MS)
  let everContacted = false
  let everAuthFailed = false
  for (const h of hybridHeaders(apiKey)) {
    if (sig.aborted) break
    const { models, modelMetadata, contacted, sawAuth } = await tryFetchModels(baseUrl, h, sig)
    everContacted = everContacted || contacted
    everAuthFailed = everAuthFailed || sawAuth
    if (models?.length) {
      // P11 P1.4 — wire dari probe, bukan substring URL semata: path
      // /responses berarti endpoint Responses API (previous_response_id).
      // Substring host (anthropic) tetap dipakai hanya sebagai fallback
      // terakhir, bukan penentu utama. Bandingkan pada bentuk lowercase
      // (temuan audit #03: baseUrl mentah membuat host kapital lolos).
      const path = baseUrl.toLowerCase()
      const hint = path.includes("/responses")
        ? "responses"
        : path.includes("anthropic")
          ? "anthropic"
          : "openai"
      const uniqueModels = Array.from(new Set(models))
      const result: DetectResult = {
        models: uniqueModels,
        ...(modelMetadata ? { modelMetadata } : {}),
        providerHint: hint as DetectResult["providerHint"],
        authFailed: everAuthFailed,
      }
      cache.set(key, { at: Date.now(), result })
      return result
    }
  }
  // Tak satu pun attempt mendapat respons HTTP = jaringan mati, bukan
  // "provider tanpa model" (Anthropic menjawab 404 tapi tetap kontak).
  // Lempar agar /sync mencatat failed, bukan diam.
  if (!everContacted) throw new Error(`unreachable: ${baseUrl}`)
  return { models: [], providerHint: "unknown", authFailed: everAuthFailed }
}
