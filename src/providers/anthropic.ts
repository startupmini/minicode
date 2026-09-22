import { Buffer } from "node:buffer"
import { ProviderError } from "#minicore/core/errors.ts"
import type { ModelProvider, ProviderEvent, StreamRequest } from "#minicore/core/provider.ts"
import type { ToolSchema } from "#minicore/core/tool.ts"
import type { Content, Message } from "#minicore/core/types.ts"
import { LIMITS } from "../constants.ts"
import { thinkingFamily } from "./effort.ts"

export interface AnthropicConfig {
  id?: string
  apiKey: string
  baseUrl?: string // default https://api.anthropic.com
  models: readonly string[]
  defaultModel?: string
  maxTokens?: number
  enablePromptCaching?: boolean
  /** Budget tokens for extended thinking — yields reasoning via extension event. */
  thinking?: number
  /**
   * Knob generik — dipetakan per MODEL per request: Claude ≤4.5 → budget
   * legacy; Claude ≥4.6/5 (adaptive) → thinking adaptive + output effort;
   * lainnya → diabaikan (default vendor). Menang atas `thinking` numerik.
   */
  reasoningEffort?: string
}

/** low/medium/high → budget token thinking legacy. Diekspor untuk test. */
export function mapReasoningToThinking(effort?: string): number | undefined {
  return effort === "high" ? 4096 : effort === "medium" ? 2048 : effort === "low" ? 1024 : undefined
}

interface AnthropicRaw {
  type?: string
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    thinking?: string
    stop_reason?: string
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  message?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  index?: number
  content_block?: { type?: string; id?: string; name?: string }
}

export function createAnthropicProvider(config: AnthropicConfig): ModelProvider {
  // Normalisasi baseUrl: bila sudah berakhir /v1, jangan dobel (/v1/v1/messages).
  const baseUrl = (config.baseUrl ?? "https://api.anthropic.com")
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "")
  const endpoint = `${baseUrl}/v1/messages`
  const enableCache = config.enablePromptCaching !== false

  // brand `kind` dipakai router agar tahu konten Uint8Array ditangani native
  const provider: ModelProvider & { kind: "anthropic" } = {
    id: config.id ?? "anthropic",
    models: config.models,
    kind: "anthropic",
    async *stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      // System prompt with optional ephemeral cache control for 90% cost savings on long runs
      const systemPayload = request.system
        ? enableCache
          ? [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }]
          : request.system
        : undefined

      const toolsPayload = request.tools?.length
        ? toAnthropicTools(request.tools, enableCache)
        : undefined

      // Thinking per model: legacy budget (≤4.5), adaptive (≥4.6/5), atau
      // omit (lainnya + default). `thinking` numerik = back-compat eksplisit.
      const model = request.model ?? config.defaultModel ?? config.models[0]
      const family = thinkingFamily(model ?? "")
      const effortBudget =
        config.reasoningEffort && family === "claude-legacy"
          ? mapReasoningToThinking(config.reasoningEffort)
          : undefined
      const adaptiveEffort =
        config.reasoningEffort && family === "claude-adaptive" ? config.reasoningEffort : undefined
      const legacyBudget = effortBudget ?? config.thinking
      const effectiveMaxTokens = legacyBudget
        ? Math.max(config.maxTokens ?? 8192, legacyBudget + 1024)
        : (config.maxTokens ?? 8192)
      const body = JSON.stringify({
        model: request.model ?? config.defaultModel ?? config.models[0],
        max_tokens: effectiveMaxTokens,
        system: systemPayload,
        messages: toAnthropicMessages(request.messages),
        tools: toolsPayload,
        ...(legacyBudget ? { thinking: { type: "enabled", budget_tokens: legacyBudget } } : {}),
        // Adaptive: tanpa budget & tanpa beta thinking (dikelola model);
        // depth dikendalikan output_config.effort (low/medium/high).
        ...(adaptiveEffort
          ? { thinking: { type: "adaptive" }, output_config: { effort: adaptiveEffort } }
          : {}),
        stream: true,
      })

      // Beta thinking hanya untuk mode legacy (adaptive tak butuh header).
      const betaThinking = legacyBudget ? ", thinking-2024-12-16" : ""
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": `prompt-caching-2024-07-31${betaThinking}`,
        accept: "text/event-stream",
      }

      let response: Response
      try {
        response = await fetch(endpoint, { method: "POST", headers, body, signal })
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e
        throw new ProviderError("network", (e as Error).message)
      }
      if (!response.ok) {
        const txt = await response.text().catch(() => "")
        throw toAnthropicError(response.status, txt, response.headers)
      }
      if (!response.body) throw new ProviderError("network", "empty response body")

      // buffer for tool inputs across deltas — per-stream (was global, now isolated)
      const pendingTools = new Map<number, { id: string; name: string; args: string }>()

      // Anthropic SSE: event: ...\ndata: {...}
      let currentEvent = ""
      for await (const chunk of sseAnthropic(response.body, signal)) {
        if (chunk.event) currentEvent = chunk.event
        const data = chunk.data
        if (!data) continue
        // handle different event types
        const raw = data as AnthropicRaw
        if (currentEvent === "content_block_delta") {
          const delta = raw.delta
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            yield { type: "text", text: delta.text }
          }
        } else if (currentEvent === "message_delta") {
          const d = raw.delta
          const stop = d?.stop_reason
          if (stop) {
            if (stop === "tool_use") yield { type: "finish", reason: "tool_calls" }
            else if (stop === "max_tokens") {
              yield {
                type: "extension",
                kind: "warning",
                data: { text: "⚠ response truncated: hit max_tokens — raise via config maxTokens" },
              }
              yield { type: "finish", reason: "length" }
            } else yield { type: "finish", reason: "stop" }
          }
          // Anthropic also sends usage in message_delta
          const usage = raw.usage ?? (d as unknown as { usage?: AnthropicRaw["usage"] })?.usage
          if (usage && (usage.input_tokens != null || usage.output_tokens != null)) {
            yield {
              type: "extension",
              kind: "usage",
              data: {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                cacheReadTokens: usage.cache_read_input_tokens,
                cacheWriteTokens: usage.cache_creation_input_tokens,
                cacheIncluded: true,
              },
            }
          }
        } else if (raw.type === "message_start") {
          const usage = raw.message?.usage
          if (usage) {
            yield {
              type: "extension",
              kind: "usage",
              data: {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                cacheReadTokens: usage.cache_read_input_tokens,
                cacheWriteTokens: usage.cache_creation_input_tokens,
                cacheIncluded: true,
              },
            }
          }
        }
        // content_block_start for tool_use
        if (raw.type === "content_block_start") {
          const block = raw.content_block
          if (block?.type === "tool_use") {
            pendingTools.set(raw.index ?? 0, { id: block.id!, name: block.name!, args: "" })
          }
        }
        if (raw.type === "content_block_delta") {
          const d = raw.delta
          if (d?.type === "input_json_delta") {
            const idx = raw.index ?? 0
            const p = pendingTools.get(idx)
            if (p) p.args += d.partial_json ?? ""
          }
          if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
            yield { type: "extension", kind: "reasoning", data: { text: d.thinking } }
          }
        }
        if (raw.type === "content_block_stop") {
          const idx = raw.index ?? 0
          const p = pendingTools.get(idx)
          if (p) {
            let args: unknown = p.args
            try {
              args = p.args ? JSON.parse(p.args) : {}
            } catch {
              args = { raw: p.args }
            }
            yield { type: "tool_call", id: p.id, name: p.name, args }
            pendingTools.delete(idx)
          }
        }
      }
    },
  }
  return provider
}

// Deteksi tipe gambar dari magic bytes — tool result biner yang jelas gambar
// dikirim sebagai blok image (media_type benar), selain itu fallback base64.
function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image/png"
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif"
  if (b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return "image/webp"
  return null
}

export function toAnthropicMessages(messages: readonly Message[]): unknown[] {
  const out: { role: string; content: unknown }[] = []
  let toolGroup:
    | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }[]
    | null = null

  const pushUser = (content: unknown) => {
    const last = out.length > 0 ? out[out.length - 1] : undefined
    if (last && last.role === "user") {
      // Invarian peran Anthropic: peran user↔assistant wajib bergantian.
      // Bila turn sebelumnya sudah user (mis. prompt steering atau tool-result),
      // satukan blok kontennya alih-alih melempar dua entri user berturut-turut.
      const toBlocks = (val: unknown): unknown[] => {
        if (Array.isArray(val)) return val
        if (typeof val === "string") return [{ type: "text", text: val }]
        return [{ type: "text", text: String(val) }]
      }
      last.content = [...toBlocks(last.content), ...toBlocks(content)]
    } else {
      out.push({ role: "user", content })
    }
  }

  const flushToolGroup = () => {
    if (toolGroup) {
      pushUser(toolGroup)
      toolGroup = null
    }
  }

  for (const m of messages) {
    if (m.role === "user") {
      flushToolGroup()
      pushUser(toContent(m.content))
    } else if (m.role === "assistant") {
      flushToolGroup()
      const content: unknown[] = []
      if (typeof m.content === "string" && m.content)
        content.push({ type: "text", text: m.content })
      else if (Array.isArray(m.content))
        for (const p of m.content)
          if (p.type === "text") content.push({ type: "text", text: p.text })
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args })
      }
      out.push({
        role: "assistant",
        content: content.length ? content : [{ type: "text", text: "" }],
      })
    } else {
      const c = m as unknown as { toolCallId: string; content: unknown; isError?: boolean }
      let entryContent: unknown
      if (typeof c.content === "string") {
        entryContent = c.content
      } else if (c.content instanceof Uint8Array) {
        // biner dari tool: bila jelas gambar → blok image base64 (spec Anthropic);
        // selain itu kirim base64 string seperti sebelumnya.
        const mime = sniffImageMime(c.content)
        const b64 = Buffer.from(c.content).toString("base64")
        entryContent = mime
          ? [{ type: "image", source: { type: "base64", media_type: mime, data: b64 } }]
          : b64
      } else {
        entryContent = JSON.stringify(c.content)
      }
      toolGroup ??= []
      const entry: {
        type: "tool_result"
        tool_use_id: string
        content: unknown
        is_error?: boolean
      } = { type: "tool_result", tool_use_id: c.toolCallId, content: entryContent }
      if (c.isError) entry.is_error = true
      toolGroup.push(entry)
    }
  }
  flushToolGroup()
  return out
}

function toContent(content: Content): unknown {
  if (typeof content === "string") return content
  return (
    content as readonly { type: string; text?: string; data?: Uint8Array; mime?: string }[]
  ).map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: p.mime,
            data: Buffer.from(p.data as Uint8Array).toString("base64"),
          },
        },
  )
}

function toAnthropicTools(tools: readonly ToolSchema[], enableCache: boolean = true): unknown[] {
  return tools.map((t, idx) => {
    const isLast = idx === tools.length - 1
    return {
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
      ...(enableCache && isLast ? { cache_control: { type: "ephemeral" } } : {}),
    }
  })
}

function toAnthropicError(status: number, body: string, headers: Headers): ProviderError {
  const detail = body.slice(0, 500)
  const retryAfter = headers.get("retry-after")
  if (status === 429) {
    const ms = retryAfter ? Number(retryAfter) * 1000 : undefined
    return new ProviderError(
      "rate_limit",
      `rate limited (${status}): ${detail}`,
      Number.isFinite(ms) ? Math.min(ms!, LIMITS.RETRY_AFTER_MAX_MS) : undefined,
    )
  }
  if (status === 401 || status === 403)
    return new ProviderError("auth", `auth failed (${status}): ${detail}`)
  if (status === 400 || status === 422) {
    const isCtx =
      body.toLowerCase().includes("maximum context") ||
      body.toLowerCase().includes("prompt is too long")
    return new ProviderError(
      isCtx ? "context_length_exceeded" : "invalid_request",
      `${status}: ${detail}`,
    )
  }
  if (status >= 500) return new ProviderError("server", `server error (${status}): ${detail}`)
  return new ProviderError("unknown", `${status}: ${detail}`)
}

async function* sseAnthropic(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let evt = ""
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError")
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf("\n")
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "")
        buffer = buffer.slice(idx + 1)
        if (line.startsWith("event:")) evt = line.slice(6).trim()
        else if (line.startsWith("data:")) {
          const payload = line.slice(5).trim()
          if (payload) {
            try {
              const data = JSON.parse(payload)
              yield { event: evt, data }
            } catch {}
          }
        } else if (line === "") {
          evt = ""
        }
        idx = buffer.indexOf("\n")
      }
    }
  } finally {
    reader.releaseLock()
  }
}
