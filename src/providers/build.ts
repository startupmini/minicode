import { randomUUID } from "node:crypto"
import type { ModelProvider } from "#minicore/core/provider.ts"
import { createOpenAICompatProvider } from "#minicore/providers/openai-compat.ts"
import type { MinicodeConfig } from "../config.ts"
import { createAnthropicProvider } from "./anthropic.ts"
import { allowedEfforts, thinkingFamily, withEffortFallback } from "./effort.ts"
import { withStreamGuards } from "./guards.ts"
import { getValidAccessToken } from "./oauth.ts"
import { createResponsesProvider } from "./responses.ts"

// Satu-satunya tempat membangun daftar provider dari config (hybrid anthropic/openai-compat).
// Dipakai CLI, sub-agent (task.ts), dan MCP server agar logika tidak terduplikasi.
// PENTING: id identitas provider WAJIB diteruskan — kalau tidak, router byId
// memetakan semua provider ke id generik "openai-compat" (provider terakhir menang).
// Thinking effort: default universal = omit (tanpa param). Knob hanya dikirim
// ke keluarga terbukti (OpenAI reasoning, Claude legacy/adaptive); jalur
// openai-compat yang campur dibungkus fail-soft (strip saat 400/500).
// Diekspor agar teruji tanpa membangun provider sungguhan.
export { mapReasoningToThinking } from "./anthropic.ts"

export function buildProviderList(cfg: MinicodeConfig): ModelProvider[] {
  const out: ModelProvider[] = []
  for (const p of cfg.providers) {
    if (p.providerHint === "responses") {
      out.push(
        // F-11/F-16: guard stream (timeout + text-cap) di satu titik bangun —
        // berlaku untuk semua adapter termasuk vendor yang tak boleh disentuh.
        withStreamGuards(
          createResponsesProvider({
            id: p.id,
            baseUrl: p.baseUrl,
            apiKey: p.apiKey,
            models: p.models,
            defaultModel: p.models[0],
            ...(p.reasoningEffort ? { reasoningEffort: p.reasoningEffort } : {}),
          }),
        ),
      )
    } else if (p.providerHint === "anthropic" || p.baseUrl.includes("anthropic")) {
      // String effort diteruskan mentah; adapter memilih bentuk wire per
      // MODEL per request (legacy budget vs adaptive vs omit).
      out.push(
        withStreamGuards(
          createAnthropicProvider({
            id: p.id,
            apiKey: p.apiKey,
            baseUrl: p.baseUrl,
            models: p.models,
            defaultModel: p.models[0],
            ...(p.reasoningEffort ? { reasoningEffort: p.reasoningEffort } : {}),
          }) as unknown as ModelProvider,
        ),
      )
    } else {
      const isZen =
        p.baseUrl.includes("opencode.ai/zen") || p.id.includes("opencode") || p.id.includes("zen")
      const zenHeaders = isZen ? { "x-opencode-session": randomUUID() } : undefined
      const base = {
        id: p.id,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        models: p.models,
        defaultModel: p.models[0],
        ...(zenHeaders ? { headers: zenHeaders } : {}),
      }
      // Jalur openai-compat melayani semua keluarga (DeepSeek, free-tier,
      // custom gateway) — effort hanya untuk model reasoning yang levelnya
      // didukung; sisanya langsung tanpa effort + fail-soft bila ditolak.
      if (!p.reasoningEffort) {
        out.push(withStreamGuards(createOpenAICompatProvider(base)))
        continue
      }
      const effort = p.reasoningEffort
      out.push(
        withStreamGuards(
          withEffortFallback(
            createOpenAICompatProvider({ ...base, reasoningEffort: effort }),
            createOpenAICompatProvider(base),
            {
              providerId: p.id,
              effort,
              shouldSend: (model: string): boolean => {
                if (thinkingFamily(model) !== "openai-reasoning") return false
                return allowedEfforts(model).includes(effort as "low" | "medium" | "high")
              },
            },
          ),
        ),
      )
    }
  }
  return out
}

/**
 * Versi async: provider ber-`auth: "oauth"` mendapat access token segar dari
 * `~/.minicode/auth.json` (di-refresh bila perlu) alih-alih `apiKey` di config.
 *
 * Dipisah dari `buildProviderList` agar jalur sinkron yang sudah ada tidak
 * berubah perilaku, dan agar pemanggil yang tak peduli OAuth tak jadi async.
 * Provider OAuth yang belum login dibuang dengan peringatan — lebih baik hilang
 * dari daftar daripada mengirim header Authorization tanpa token.
 */
export async function buildProviderListAsync(cfg: MinicodeConfig): Promise<ModelProvider[]> {
  const { getSecret } = await import("../lib/keystore.ts")
  const resolved: MinicodeConfig = { ...cfg, providers: [] }
  for (const p of cfg.providers) {
    if (p.auth !== "oauth") {
      // Referensi keystore (`keystore:<nama>`) di-resolve ke secret OS di
      // sini (lapisan provisioning) — config.ts tetap IO murni. Gagal =
      // skip dengan peringatan, sama seperti OAuth yang belum login.
      if (p.apiKey.startsWith("keystore:")) {
        const secret = await getSecret(p.apiKey.slice("keystore:".length)).catch(() => null)
        if (!secret) {
          process.stderr.write(
            `[auth] provider "${p.id}" keystore entry missing/unreadable — skipped. Run: minicode config set-key ${p.id}\n`,
          )
          continue
        }
        resolved.providers.push({ ...p, apiKey: secret })
        continue
      }
      resolved.providers.push(p)
      continue
    }
    const token = await getValidAccessToken(p.id)
    if (!token) {
      process.stderr.write(
        `[auth] provider "${p.id}" uses OAuth but is not logged in (or refresh failed) — skipped. Run: minicode auth login ${p.id}\n`,
      )
      continue
    }
    resolved.providers.push({ ...p, apiKey: token })
  }
  return buildProviderList(resolved)
}
