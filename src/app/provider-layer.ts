import { createOpenAICompatProvider } from "#minicore/providers/openai-compat.ts"
import { loadConfig, type MinicodeConfig } from "../config.ts"
import type { RateLimiter } from "../policy/ratelimit.ts"
import { createAnthropicProvider } from "../providers/anthropic.ts"
import { buildProviderListAsync } from "../providers/build.ts"
import { withStreamGuards } from "../providers/guards.ts"
import { createRouterProvider } from "../providers/router.ts"

let currentRouter: ReturnType<typeof createRouterProvider> | null = null
export async function reloadProviders(
  cwd?: string,
  opts: { allowLocal?: boolean } = {},
): Promise<void> {
  if (!currentRouter) return
  const cfg = await loadConfig(cwd, { allowLocal: opts.allowLocal })
  const providers = await buildProviderListAsync(cfg)
  const r = currentRouter as unknown as { updateProviders: (list: unknown[]) => void }
  if (typeof r.updateProviders === "function") r.updateProviders(providers)
}

export async function createProviderLayer(opts: {
  cwd?: string
  prompt: string
  enterRepl: boolean
  rateLimiter?: RateLimiter
  providerOverride?: string
  /** Teruskan flag --allow-local-config (default deny — repo tak bisa
   * menyuntik endpoint provider). */
  allowLocalConfig?: boolean
  /** Setup first-run (wizard) — di-inject dari cli/. Tanpa injeksi, kosong
   * berarti langsung error "no provider configured". */
  setupWhenEmpty?: () => Promise<boolean>
}): Promise<{ cfg: MinicodeConfig; router: ReturnType<typeof createRouterProvider> }> {
  const cfg = await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })
  type Provider = ReturnType<typeof createOpenAICompatProvider>
  let providers = await buildProviderListAsync(cfg)

  // Agnostik: --provider <id> paksa satu provider tanpa ubah config file
  if (opts.providerOverride) {
    const filtered = providers.filter(
      (p) => (p as unknown as { id: string }).id === opts.providerOverride,
    )
    if (filtered.length) {
      providers = filtered
    } else {
      process.stderr.write(
        `[warn] --provider "${opts.providerOverride}" not found, using default order\n`,
      )
    }
  } else if (process.env.MINICODE_PROVIDER_ORDER) {
    // MINICODE_PROVIDER_ORDER="openai,anthropic,deepseek" → reorder agnostik tanpa edit config
    const order = process.env.MINICODE_PROVIDER_ORDER.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    if (order.length) {
      const byId = new Map(providers.map((p) => [(p as unknown as { id: string }).id, p] as const))
      const reordered: typeof providers = []
      for (const id of order) {
        const p = byId.get(id)
        if (p) {
          reordered.push(p)
          byId.delete(id)
        }
      }
      for (const p of byId.values()) reordered.push(p)
      providers = reordered
    }
  }
  if (providers.length === 0) {
    const baseUrl = process.env.AGENT_BASE_URL ?? "https://api.openai.com/v1"
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.AGENT_API_KEY
    if (apiKey)
      providers.push(
        // Investigasi Phase 5 (I8): fallback env-var dibuat lewat
        // withStreamGuards yang SAMA dengan jalur config (build.ts) — dulu
        // dibuat langsung, tanpa timeout per-request dan tanpa text-cap
        // (kontrak "satu titik bangun ter-guard" dilewati jalur ini).
        withStreamGuards(
          createOpenAICompatProvider({
            baseUrl,
            apiKey,
            models: [process.env.AGENT_MODEL ?? "gpt-4o-mini"],
            defaultModel: process.env.AGENT_MODEL ?? "gpt-4o-mini",
          }),
        ),
      )
    const anthKey = process.env.ANTHROPIC_API_KEY
    if (anthKey)
      providers.push(
        withStreamGuards(
          createAnthropicProvider({
            apiKey: anthKey,
            models: [process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4"],
          }) as unknown as Provider,
        ),
      )
  }
  if (providers.length === 0 && (opts.enterRepl || opts.prompt)) {
    const ok = opts.setupWhenEmpty ? await opts.setupWhenEmpty() : false
    if (ok) {
      const cfg2 = await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })
      cfg.providers = cfg2.providers
      providers = await buildProviderListAsync(cfg2)
    }
  }
  if (providers.length === 0) {
    console.error(
      "no provider configured — run `minicode` for setup wizard,\nor: minicode auth login (free, no API key), minicode config add --baseUrl <url> --apiKey <key>, or set OPENAI_API_KEY",
    )
    process.exit(1)
  }
  const router = createRouterProvider({
    providers,
    ...(opts.rateLimiter ? { limiter: opts.rateLimiter } : {}),
  })
  currentRouter = router
  return { cfg, router }
}
