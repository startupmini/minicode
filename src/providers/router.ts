import { Buffer } from "node:buffer"
import { ProviderError } from "#minicore/core/errors.ts"
import type { ModelProvider, ProviderEvent, StreamRequest } from "#minicore/core/provider.ts"
import type { Message } from "#minicore/core/types.ts"
import { LIMITS } from "../constants.ts"
import type { RateLimiter } from "../policy/ratelimit.ts"

export interface RouterConfig {
  providers: ModelProvider[]
  defaultProviderId?: string
  // P2 cap
  maxRetryAfterMs?: number // default LIMITS.RETRY_AFTER_MAX_MS
  // Token bucket rate limiter (opsional) — cegah request beruntun kena 429
  limiter?: RateLimiter
}

// C4 fix: convert Uint8Array tool content to base64 before an openai-compat
// provider sees it. Anthropic handles Uint8Array natively (image →
// source.base64 + media_type in toAnthropicMessages) — converting up-front
// broke that image path, so the fix is applied per-provider below.
function fixRequest(req: StreamRequest): StreamRequest {
  const messages = req.messages.map((m) => {
    if (m.role === "tool" && (m as unknown as { content: unknown }).content instanceof Uint8Array) {
      const c = (m as unknown as { content: Uint8Array }).content
      return { ...m, content: Buffer.from(c).toString("base64") } as unknown as typeof m
    }
    return m
  })
  return { ...req, messages }
}

function needsBinaryFix(p: ModelProvider): boolean {
  return (p as unknown as { kind?: string }).kind !== "anthropic"
}

// P0 konteks: adapter openai-compat (vendor, frozen) TIDAK mengirim
// request.system ke wire (buildBody-nya tak membaca field itu), dan bertipe
// kernel tanpa role "system" (toMessages me-null-kan role tak dikenal).
// Akibatnya seluruh system prompt (MEMORY, repomap, AGENTS.md, recovery)
// hilang diam-diam pada semua provider non-Anthropic/non-Responses.
// Perbaikan di router (satu-satunya seam app-layer sebelum wire): selipkan
// system sebagai pesan user PERTAMA. Bukan developer/system role (vendor
// me-null-kan), bukan merge ke user pertama (provenance lebih buruk).
// Anthropic mengirim system native; Responses diurus via `instructions`
// di adapter-nya sendiri — keduanya dilewati di sini.
function needsSystemMessage(p: ModelProvider): boolean {
  const kind = (p as unknown as { kind?: string }).kind
  return kind !== "anthropic" && kind !== "responses"
}

function withSystemMessage(req: StreamRequest): StreamRequest {
  if (!req.system?.trim()) return req
  if (req.messages.length > 0 && (req.messages[0] as { role?: string }).role === "system")
    return req
  return {
    ...req,
    messages: [{ role: "user", content: req.system } as Message, ...req.messages],
  }
}

// Fallback provider mungkin tidak mendukung nama model request asli (mis. gpt-4o
// dipakai ke Anthropic). Substitusi ke model default provider agar tidak 400.
// Return model efektif untuk cost attribution.
function requestFor(
  current: ModelProvider,
  fixed: StreamRequest,
): { req: StreamRequest; effectiveModel?: string; substituted: boolean } {
  if (fixed.model && !current.models.includes(fixed.model) && current.models[0]) {
    return {
      req: { ...fixed, model: current.models[0] },
      effectiveModel: current.models[0],
      substituted: true,
    }
  }
  return { req: fixed, substituted: false }
}

export function createRouterProvider(config: RouterConfig): ModelProvider {
  const maxRetry = config.maxRetryAfterMs ?? LIMITS.RETRY_AFTER_MAX_MS
  // byId dan defaultId dihitung per-stream agar provider yang baru ditambah via /provider
  // langsung dikenali tanpa restart. Provider list bisa berubah mid-session.
  const getById = () => new Map(config.providers.map((p) => [p.id, p]))
  const getDefaultId = () => config.defaultProviderId ?? config.providers[0]?.id ?? "router"
  const getModels = () => config.providers.flatMap((p) => [...p.models])

  const router: ModelProvider & { updateProviders: (list: ModelProvider[]) => void } = {
    id: "router",
    get models() {
      return getModels()
    },
    updateProviders(list: ModelProvider[]) {
      config.providers.splice(0, config.providers.length, ...list)
    },
    async *stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      // route by model name — first match wins (default/daftar urutan provider)
      // Format "providerId::modelName" = PIN eksplisit (kontrak): provider itu
      // saja, tanpa fallback lintas provider dan tanpa substitusi diam-diam.
      // Gagal = error jujur dari provider yang dipilih agar user memilih
      // model lanjutannya sendiri (keputusan: no-auto-switch, terutama ke
      // model berbayar). Model bare (tanpa `::`) tetap perilaku lama.
      let target: ModelProvider | undefined
      let model: string | undefined = request.model
      let pinned = false
      if (model?.includes("::")) {
        const sep = model.indexOf("::")
        const pid = model.slice(0, sep)
        const m = model.slice(sep + 2)
        target = getById().get(pid)
        if (!target)
          throw new ProviderError(
            "invalid_request",
            `unknown provider "${pid}" in model "${request.model}" — see: minicode providers`,
          )
        pinned = true
        model = m || undefined
      }
      if (!target && model) {
        for (const p of config.providers)
          if (p.models.includes(model)) {
            target = p
            break
          }
      }
      target ??= getById().get(getDefaultId()) ?? config.providers[0]
      if (!target) throw new ProviderError("unknown", "no provider configured")

      // Pin: model harus ada di provider itu — bukan substitusi diam-diam
      // (yang dulu melempar user ke model berbayar provider lain).
      if (pinned && model && !target.models.includes(model)) {
        const avail = target.models.slice(0, 8).join(", ")
        const more = target.models.length > 8 ? ` (+${target.models.length - 8} more)` : ""
        throw new ProviderError(
          "invalid_request",
          `model "${model}" not on ${target.id} (${target.models.length} models: ${avail}${more}) — pick one via /model`,
        )
      }

      // fallback on rate_limit/server/network
      const tried = new Set<string>()
      const retried429For = new Set<string>()
      let current: ModelProvider | undefined = target
      while (current) {
        tried.add(current.id)
        let hasYieldedContent = false
        try {
          // rate limit: tunggu token bucket sebelum tiap request
          if (config.limiter) await config.limiter.acquire()
          const fixed = needsBinaryFix(current) ? fixRequest(request) : request
          const withSys = needsSystemMessage(current) ? withSystemMessage(fixed) : fixed
          const { req, effectiveModel, substituted } = requestFor(current, { ...withSys, model })
          if (substituted && effectiveModel) {
            // Tampilkan nama model SETELAH strip prefix `provider::` — versi
            // lama mencetak request.model mentah sehingga terbaca seolah user
            // yang memilih provider fallback ("not on openrouter").
            process.stderr.write(
              `[router] model "${model}" not on ${current.id} → substituting "${effectiveModel}"\n`,
            )
            yield {
              type: "extension",
              kind: "effective-model",
              data: { requested: request.model, effective: effectiveModel, provider: current.id },
            }
          } else if (current !== target) {
            // Fallback provider (non-substitusi) — model sama tapi provider beda.
            // Label spinner/status harus tahu provider mana yang dipakai.
            yield {
              type: "extension",
              kind: "effective-model",
              data: { requested: model, effective: model, provider: current.id },
            }
          }
          for await (const ev of current.stream(req, signal)) {
            // Tandai bila konten substantif sudah keluar ke caller: sekali konten
            // keluar, stream tak bisa lagi di-fallback diam-diam ke provider lain
            // karena akan menduplikasi respons dari awal di sisi user.
            if (
              ev.type === "text" ||
              ev.type === "tool_call" ||
              (ev.type === "extension" && ev.kind === "reasoning")
            ) {
              hasYieldedContent = true
            }
            yield ev
          }
          return
        } catch (e) {
          if (e instanceof ProviderError) {
            // Stream yang sudah separuh terkirim ke klien tidak boleh di-restart dari awal
            if (hasYieldedContent) throw e
            // cap retryAfter without mutating original
            let err: ProviderError = e
            if (e.retryAfterMs != null && e.retryAfterMs > maxRetry) {
              err = new ProviderError(e.category, e.message, maxRetry)
            }
            // P11 P1.3 — honori retry-after. Audit #14: fallback DULU bila ada
            // alternatif — jangan bakar sleep (maks 30 dtk) saat provider
            // berikutnya menganggur; tunggu hanya bila tidak ada alternatif
            // (atau ter-pin), lalu ulangi provider sama di tempat. retried429For
            // mencegah loop: tiap provider hanya pernah menunggu sekali.
            // Sleep abort-aware: Ctrl+C/timeout tidak boleh hang 30 dtk.
            if (
              err.category === "rate_limit" &&
              err.retryAfterMs != null &&
              !retried429For.has(current.id)
            ) {
              retried429For.add(current.id)
              if (!pinned) {
                const next = config.providers.find((p) => !tried.has(p.id))
                if (next) {
                  current = next
                  continue
                }
              }
              const waitMs = Math.min(err.retryAfterMs, maxRetry)
              if (signal.aborted) throw new DOMException("Aborted", "AbortError")
              let onAbort: (() => void) | undefined
              try {
                await Promise.race([
                  Bun.sleep(waitMs),
                  new Promise<void>((_, rej) => {
                    onAbort = () => rej(new DOMException("Aborted", "AbortError"))
                    if (signal.aborted) onAbort()
                    else signal.addEventListener("abort", onAbort, { once: true })
                  }),
                ])
              } finally {
                if (onAbort) signal.removeEventListener("abort", onAbort)
              }
              // Pin: tetap di provider yang dipilih (tunggu lalu ulangi di
              // tempat) — jangan pindah ke provider lain.
              if (pinned) continue
              // tunggu-di-tempat: ulangi provider sama sekali
              continue
            }
            const canFallback =
              !pinned &&
              (err.category === "server" || err.category === "network") &&
              tried.size < config.providers.length
            // rate_limit tanpa retryAfter → fallback ke provider lain (bakar-daftar hanya bila tanpa retryAfter)
            const canFallbackRateLimit =
              !pinned &&
              err.category === "rate_limit" &&
              err.retryAfterMs == null &&
              tried.size < config.providers.length
            if (canFallback || canFallbackRateLimit) {
              const next = config.providers.find((p) => !tried.has(p.id))
              if (next) {
                current = next
                continue
              }
            }
            throw err
          }
          throw e
        }
      }
    },
  }
  return router as ModelProvider
}
