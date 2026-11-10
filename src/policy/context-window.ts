import { readFile } from "node:fs/promises"
import type { MinicodeConfig } from "../config.ts"
import { findContextWindowFromCatalog } from "./context-window-catalog.ts"
import { contextWindowsCachePath } from "./pricing.ts"

/** App fallback for providers that do not publish model metadata.
 * Operators can set an exact `ProviderEntry.contextWindows` value or use the
 * explicit `--context-window` override when a gateway exposes aliases.
 *
 * SENGAJA beda dari `DEFAULT_ALIAS_CONTEXT_WINDOW_TOKENS` (128K): ini adalah
 * batas-bawah aman untuk model yang BENAR-BENAR tak dikenal (nilai minimal yang
 * didukung hampir semua model), sedangkan default alias router memilih 128K
 * karena model aslinya pasti model besar — hanya identitasnya yang disembunyikan
 * oleh alias `auto`/`best`. Menyatukan keduanya ke satu nilai akan membuat
 * salah satu sisi salah arah: 32K → alias dikompaksi prematur; 128K → model
 * belum-tentu-mendukung melampaui jendela. */
export const DEFAULT_FALLBACK_CONTEXT_WINDOW_TOKENS = 32_000

// Alias router (`auto`/`best`/...) model aslinya tak diketahui dari config.
// Default konservatif 128K (bukan 32K) supaya kompaksi tidak prematur; bila
// aktual lebih besar (mis. 1M), jalur recovery 400→compact-and-retry tetap
// menyelamatkan. User bisa set `provider.contextWindows` untuk nilai eksak.
export const DEFAULT_ALIAS_CONTEXT_WINDOW_TOKENS = 131_072
const ROUTER_ALIAS_RE = /^(auto|best|default|cheapest|router)([:_-]|$)/i

export interface ContextWindowResolution {
  readonly tokens: number
  readonly source:
    | "override"
    | "model"
    | "provider-default"
    | "catalog"
    | "models-dev"
    | "safe-default"
  readonly model?: string
  readonly providerId?: string
  /** R9/T8 — hadir bila katalog built-in dan overlay models.dev saling beda
   * >2× (katalog mungkin ketinggalan zaman). Murni diagnostik: pemanggil boleh
   * memperingatkan user; resolusi TETAP pakai katalog (over-estimate ditoleransi
   * lewat jalur recovery). */
  readonly drift?: { catalogTokens: number; overlayTokens: number }
}

function validWindow(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 20_000_000
  )
}

// ── Overlay models.dev (jendela konteks) ────────────────────────────────────
// Diisi dari cache `context-windows.json` saat startup (sync sekali lewat
// `minicode pricing sync`). Bukan sumber wajib — hanya memperluas cakupan di
// luar katalog built-in. State dimuat async lalu dibaca sinkron di bawah.

let contextWindowOverlay: Record<string, number> | null = null

/** Reset state modul — untuk test hermetic. */
export function __resetContextWindowOverlay(): void {
  contextWindowOverlay = null
}

/** Suntik overlay — untuk test (jalur produksi lewat loadContextWindowOverlay). */
export function __setContextWindowOverlay(map: Record<string, number> | null): void {
  contextWindowOverlay = map
}

/** Muat cache jendela konteks dari disk (sekali per proses). */
export async function loadContextWindowOverlay(): Promise<Record<string, number>> {
  if (contextWindowOverlay) return contextWindowOverlay
  try {
    const raw = await readFile(contextWindowsCachePath(), "utf8")
    const parsed = JSON.parse(raw) as { models?: Record<string, unknown> }
    if (parsed && typeof parsed.models === "object" && parsed.models) {
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(parsed.models)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0)
          out[k.toLowerCase()] = Math.floor(v)
      }
      contextWindowOverlay = out
      return out
    }
  } catch {
    // tak ada cache = normal
  }
  contextWindowOverlay = {}
  return contextWindowOverlay
}

/** Cari jendela konteks dari overlay models.dev (sinkron, setelah dimuat). */
export function findContextWindowFromOverlay(model: string): number | undefined {
  const map = contextWindowOverlay
  if (!map || Object.keys(map).length === 0) return undefined
  const m = model.toLowerCase()
  if (map[m] !== undefined) return map[m]
  // Segmen (pemisah `/`/`:`) dicocokkan dengan kunci overlay sebagai prefiks —
  // pola sama dengan findPrice sehingga `deepseek-v4-flash` menang atas `deepseek`.
  let best: { k: string; v: number } | undefined
  for (const seg of m.split(/[/:]/)) {
    if (!seg) continue
    for (const [k, v] of Object.entries(map)) {
      if (
        seg === k ||
        seg.startsWith(`${k}.`) ||
        seg.startsWith(`${k}-`) ||
        seg.startsWith(`${k}_`)
      ) {
        if (!best || k.length > best.k.length) best = { k, v }
      }
    }
  }
  return best?.v
}

/** Resolve a budget in the same order as the router: explicit provider pin,
 * then first provider advertising a bare model, then the provider fallback.
 * Unknown aliases use a conservative budget and remain visible to callers. */
export function resolveContextWindow(
  config: MinicodeConfig,
  model?: string,
  override?: number,
): ContextWindowResolution {
  if (validWindow(override))
    return { tokens: override, source: "override", ...(model ? { model } : {}) }

  let providerId: string | undefined
  let modelId = model
  let provider = undefined as MinicodeConfig["providers"][number] | undefined
  if (model?.includes("::")) {
    const sep = model.indexOf("::")
    providerId = model.slice(0, sep)
    modelId = model.slice(sep + 2)
    provider = config.providers.find((entry) => entry.id === providerId)
  } else if (model) {
    provider = config.providers.find((entry) => entry.models?.includes(model))
    providerId = provider?.id
  } else {
    provider = config.providers[0]
    providerId = provider?.id
    modelId = provider?.models?.[0]
  }

  const exact = modelId ? provider?.contextWindows?.[modelId] : undefined
  if (validWindow(exact)) {
    return {
      tokens: exact,
      source: "model",
      ...(modelId ? { model: modelId } : {}),
      ...(providerId ? { providerId } : {}),
    }
  }
  const providerDefault = provider?.contextWindows?.["*"]
  if (validWindow(providerDefault)) {
    return {
      tokens: providerDefault,
      source: "provider-default",
      ...(modelId ? { model: modelId } : {}),
      ...(providerId ? { providerId } : {}),
    }
  }
  // Jaring pengaman built-in: kenali keluarga model umum (deepseek, gpt, claude,
  // gemini, …) tanpa config, supaya model baru tak langsung jatuh ke 32k.
  if (modelId) {
    const catalogTokens = findContextWindowFromCatalog(modelId)
    if (validWindow(catalogTokens)) {
      // R9/T8 — katalog diutamakan (kurasi manual) tapi bisa basi. Bila overlay
      // models.dev (cache dari `pricing sync`) punya nilai > 2× beda, tandai
      // drift supaya setup memperingatkan user — resolusi tetap katalog (aman:
      // over-estimate turun anggun via compact-and-retry).
      const overlayTokens = findContextWindowFromOverlay(modelId)
      const drift =
        validWindow(overlayTokens) && catalogTokens > 0
          ? Math.max(overlayTokens / catalogTokens, catalogTokens / overlayTokens)
          : 0
      return {
        tokens: catalogTokens,
        source: "catalog",
        ...(modelId ? { model: modelId } : {}),
        ...(providerId ? { providerId } : {}),
        ...(drift > 2 ? { drift: { catalogTokens, overlayTokens: overlayTokens as number } } : {}),
      }
    }
  }
  // Overlay models.dev (bila user pernah `minicode pricing sync`): mencakup
  // model long-tail di luar katalog built-in. Dibawah katalog karena katalog
  // dikurasi manual dan tak bergantung pada cache yang bisa kedaluwarsa.
  if (modelId) {
    const overlayTokens = findContextWindowFromOverlay(modelId)
    if (validWindow(overlayTokens)) {
      return {
        tokens: overlayTokens,
        source: "models-dev",
        ...(modelId ? { model: modelId } : {}),
        ...(providerId ? { providerId } : {}),
      }
    }
  }
  // Alias router (`auto`, `best`, ...) — model asli tak dapat dipastikan tanpa
  // konfigurasi. Pakai default konservatif 128K (bukan 32K) agar kompaksi tak
  // prematur; sumber tetap "safe-default" supaya warning di cli/setup.ts tetap
  // menyala dan meminta user set nilai eksak.
  if (modelId && ROUTER_ALIAS_RE.test(modelId)) {
    return {
      tokens: DEFAULT_ALIAS_CONTEXT_WINDOW_TOKENS,
      source: "safe-default",
      ...(modelId ? { model: modelId } : {}),
      ...(providerId ? { providerId } : {}),
    }
  }
  return {
    tokens: DEFAULT_FALLBACK_CONTEXT_WINDOW_TOKENS,
    source: "safe-default",
    ...(modelId ? { model: modelId } : {}),
    ...(providerId ? { providerId } : {}),
  }
}
