import type { MinicodeConfig } from "../config.ts"

/** App fallback for providers that do not publish model metadata.
 * Operators can set an exact `ProviderEntry.contextWindows` value or use the
 * explicit `--context-window` override when a gateway exposes aliases. */
export const DEFAULT_FALLBACK_CONTEXT_WINDOW_TOKENS = 32_000

export interface ContextWindowResolution {
  readonly tokens: number
  readonly source: "override" | "model" | "provider-default" | "safe-default"
  readonly model?: string
  readonly providerId?: string
}

function validWindow(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 20_000_000
  )
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
  return {
    tokens: DEFAULT_FALLBACK_CONTEXT_WINDOW_TOKENS,
    source: "safe-default",
    ...(modelId ? { model: modelId } : {}),
    ...(providerId ? { providerId } : {}),
  }
}
