// OpenAI-compatible provider adapter. Covers OpenAI, OpenRouter, Ollama,
// DeepSeek, vLLM, and any other /chat/completions endpoint. Lives OUTSIDE the
// kernel; implements the ModelProvider contract.

import { ProviderError } from "../core/errors.ts";
import type { ModelProvider, ProviderEvent, StreamRequest } from "../core/provider.ts";
import type { ToolSchema } from "../core/tool.ts";
import type { Content, Message } from "../core/types.ts";

// Provider-metadata side-map: toolCallId -> extra provider payload (e.g.
// Gemini thought_signature / extra_content). It must NOT travel inside
// `args` — the executor rejects unknown properties (all schemas are
// additionalProperties:false), so smuggling it there fails validation.
// Side-map keeps args clean; consume-once + cap so long sessions can't leak.
// The map lives per provider INSTANCE (inside createOpenAICompatProvider):
// a module-level map would be shared across concurrent sessions, and
// index-based fallback ids (`call_0`) could then echo one session's metadata
// into another session's history replay.

/** Sniff a well-known image format from magic bytes; undefined when unknown. */
function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return undefined;
}

/** Configuration for an OpenAI-compatible chat completions endpoint. */
export interface OpenAICompatConfig {
  /** Adapter id reported on the ModelProvider. Defaults to "openai-compat". */
  id?: string;
  /** Base URL of the API, e.g. "https://api.openai.com/v1". Trailing slashes are trimmed. */
  baseUrl: string;
  /** Models this endpoint serves (used by the runtime for routing). */
  models: readonly string[];
  /** Model used when a request carries none. */
  defaultModel?: string;
  /** Bearer token; omitted entirely when absent (e.g. local endpoints). */
  apiKey?: string;
  /** Extra headers; these override the default content-type/authorization. */
  headers?: Readonly<Record<string, string>>;
  /**
   * Send stream_options.include_usage (P4). Some strict OpenAI-compat
   * endpoints reject the unknown field with 400; when enabled the adapter
   * retries once without it. Defaults to true.
   */
  includeUsage?: boolean;
  /** Generic reasoning effort knob — mapped per-wire (openai reasoning_effort, anthropic thinking). */
  reasoningEffort?: string;
}

/**
 * Build a ModelProvider for any OpenAI-compatible /chat/completions endpoint.
 * Wire errors are normalized to ProviderError categories; network-level
 * failures (DNS, connection refused) surface as `ProviderError("network")`;
 * user aborts propagate as-is so the kernel can map them to `aborted`.
 */
export function createOpenAICompatProvider(config: OpenAICompatConfig): ModelProvider {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "accept": "text/event-stream",
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
  };

  // Per-instance provider-metadata side-map (see comment at top of file).
  const providerMetaByCallId = new Map<string, unknown>();
  function stashProviderMeta(id: string, meta: unknown): void {
    if (!id || meta == null) return;
    providerMetaByCallId.set(id, meta);
    // Cap: drop the oldest entry when a very long session piles up.
    if (providerMetaByCallId.size > 500) {
      const first = providerMetaByCallId.keys().next();
      if (!first.done) providerMetaByCallId.delete(first.value);
    }
  }
  function takeProviderMeta(id: string): unknown {
    const v = providerMetaByCallId.get(id);
    if (v != null) providerMetaByCallId.delete(id);
    return v;
  }

  return {
    id: config.id ?? "openai-compat",
    models: config.models,
    async *stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      const includeUsage = config.includeUsage ?? true;
      const buildBody = (withUsage: boolean): string =>
        JSON.stringify({
          model: request.model ?? config.defaultModel,
          messages: toMessages(request.messages, takeProviderMeta),
          tools: request.tools?.length ? toTools(request.tools) : undefined,
          stream: true,
          // JSON.stringify drops undefined keys, so the field is omitted entirely.
          stream_options: withUsage ? { include_usage: true } : undefined,
          // DeepSeek-style thinking: provider seperti b.ai butuh reasoning_content
          // di history saat thinking aktif. OFF via env agar multi-turn aman.
          // MINICORE_THINKING adalah nama resmi; MINICODE_THINKING (brand lama)
          // dipertahankan sebagai fallback kompatibilitas.
          ...((process.env.MINICORE_THINKING ?? process.env.MINICODE_THINKING) === "off" ? { enable_thinking: false } : {}),
          ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        });
      let body = buildBody(includeUsage);
      let response = await fetchOrThrow(endpoint, headers, body, signal);
      // P4: strict OpenAI-compat endpoints reject the unknown stream_options
      // field with 400. Retry once without it; a second 400 is a real error.
      if (!response.ok && includeUsage && response.status === 400) {
        body = buildBody(false);
        response = await fetchOrThrow(endpoint, headers, body, signal);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw toProviderError(response.status, text, response.headers);
      }
      if (!response.body) throw new ProviderError("network", "empty response body");

      const calls = new Map<number, { id: string; name: string; args: string }>();
      const order: number[] = [];
      // A non-conforming provider may repeat finish_reason across chunks; emit
      // the accumulated tool calls and the finish event only once, otherwise
      // the kernel would see (and execute) the same tool call twice.
      let finished = false;
      for await (const chunk of sse(response.body, signal)) {
        const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
        // P8 + race: beberapa provider (b.ai dll) mengirim `usage` pada chunk
        // TERAKHIR setelah finish_reason. Jangan di-drop karena `finished`.
        if (usage && (usage.prompt_tokens != null || usage.completion_tokens != null || usage.total_tokens != null)) {
          yield {
            type: "extension",
            kind: "usage",
            data: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens },
          };
        }
        if (finished) {
          const postTool = (chunk as { choices?: Array<{ delta?: Record<string, unknown> }> }).choices?.[0]?.delta?.tool_calls;
          if (Array.isArray(postTool)) throw new ProviderError("network", "tool deltas after finish_reason");
          continue;
        }
        const choices = chunk.choices as
          | Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>
          | undefined;
        const first = choices?.[0];
        if (!first) continue;
        const delta = first.delta ?? {};
        // Beberapa provider (mis. b.ai/Gemini) mengirim chunk berisi content
        // SETELAH finish_reason — jangan di-forward (kernel tolak event setelah finish).
        const content = delta.content;
        if (!finished && typeof content === "string" && content.length > 0) yield { type: "text", text: content };
        // Reasoning is surfaced as an extension event, never a kernel
        // primitive. Handles DeepSeek-style delta.reasoning_content (string or
        // content-part array) and OpenAI o-series delta.reasoning (string).
        const rawReasoning = (delta as { reasoning_content?: unknown; reasoning?: unknown }).reasoning_content ??
          (delta as { reasoning?: unknown }).reasoning;
        let reasoningText: string | undefined;
        if (typeof rawReasoning === "string") reasoningText = rawReasoning;
        else if (Array.isArray(rawReasoning)) {
          reasoningText = (rawReasoning as Array<{ type?: string; text?: unknown }>)
            .filter((part) => part?.type === "text" && typeof part.text === "string")
            .map((part) => part.text as string)
            .join("");
        }
        if (!finished && reasoningText && reasoningText.length > 0) {
          yield { type: "extension", kind: "reasoning", data: { text: reasoningText } };
        }
        const toolDeltas = delta.tool_calls;
        if (Array.isArray(toolDeltas)) {
          // A conforming provider sends every tool delta before finish_reason.
          // Deltas that arrive after `finished` would be accumulated but never
          // emitted, silently turning a broken stream into an empty success;
          // fail loud as a retryable network error instead.
          if (finished) {
            throw new ProviderError("network", "tool deltas after finish_reason");
          }
          for (const td of toolDeltas as Array<Record<string, unknown>>) {
            const index = Number(td.index ?? 0);
            const acc = calls.get(index) ?? { id: "", name: "", args: "" };
            calls.set(index, acc);
            if (order.indexOf(index) < 0) order.push(index);
            if (typeof td.id === "string" && td.id) acc.id = td.id;
            // Preserve provider metadata (thought_signature / extra_content)
            // verbatim in the side-map — never in args — for echo on
            // history replay in toMessages.
            const extra =
              (td as Record<string, unknown>).extra_content ??
              (td as Record<string, unknown>).thought_signature ??
              (td as Record<string, unknown>).providerMeta;
            if (extra != null) (acc as Record<string, unknown>)._extra = extra;
            const fnExtra =
              (td.function as Record<string, unknown> | undefined)?.extra_content ??
              (td.function as Record<string, unknown> | undefined)?.thought_signature;
            if (fnExtra != null) (acc as Record<string, unknown>)._extra = fnExtra;
            const fn = td.function as { name?: unknown; arguments?: unknown } | undefined;
            if (fn) {
              // A tool name is never split across deltas (only `arguments` is),
              // and some providers repeat the full name on every chunk. Take the
              // first non-empty name instead of concatenating, which used to
              // turn a repeated name into "echoecho" (unknown tool error).
              if (typeof fn.name === "string" && fn.name) acc.name = acc.name || fn.name;
              if (typeof fn.arguments === "string") acc.args += fn.arguments;
            }
          }
        }
        if (!finished && first.finish_reason) {
          finished = true;
          for (const index of order) {
            const acc = calls.get(index) as unknown as { id: string; name: string; args: string; _extra?: unknown };
            if (!acc) continue;
            let args: unknown = acc.args;
            if (acc.args) {
              try {
                args = JSON.parse(acc.args);
              } catch {
                args = { raw: acc.args };
              }
            }
            // Args stay clean (the executor rejects unknown properties);
            // provider metadata is filed in the side-map by call id.
            const callId = acc.id || `call_${index}`
            if (acc._extra != null) stashProviderMeta(callId, acc._extra);
            yield { type: "tool_call", id: callId, name: acc.name, args };
          }
          // P6: content_filter (OpenAI safety filter) must not be invisible as
          // a plain "stop" — surface it as an extension event so observers can
          // distinguish a blocked response from a normal completion.
          if (first.finish_reason === "content_filter") {
            yield { type: "extension", kind: "content_filter", data: {} };
          }
          yield { type: "finish", reason: mapFinishReason(first.finish_reason) };
        }
      }
      // Provider quirky bisa berakhir tanpa finish_reason (mis. [DONE] langsung).
      // Emit finish("stop") agar kernel tidak menganggap stream terputus.
      if (!finished) {
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}

function toMessages(messages: readonly Message[], takeMeta: (id: string) => unknown): unknown[] {
  return messages.map((message) => {
    switch (message.role) {
      case "user":
        return { role: "user", content: toContent(message.content) };
      case "assistant":
        return {
          role: "assistant",
          content: toContent(message.content),
          // DeepSeek-style thinking: provider butuh reasoning_content di history
          // saat thinking mode aktif, agar multi-turn tidak 400.
          ...((message as { reasoning?: string }).reasoning ? { reasoning_content: (message as { reasoning?: string }).reasoning } : {}),
          tool_calls: message.toolCalls?.length
              ? message.toolCalls.map((call) => {
                // Echo provider metadata from the side-map (consume-once);
                // args are sent exactly as received, with no hidden keys.
                const extra = takeMeta(call.id)
                return {
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                  ...(extra != null ? { extra_content: extra } : {}),
                }
              })
            : undefined,
        };
      case "tool": {
        const content = message.content;
        // Binary tool results must never reach the wire as a JSON index map
        // ({"0":1,...}): sniffed images travel as an image_url data-URL part;
        // any other binary becomes an explicit placeholder string.
        if (content instanceof Uint8Array) {
          const mime = sniffImageMime(content);
          const wire = mime
            ? [{ type: "image_url", image_url: { url: `data:${mime};base64,${bytesToBase64(content)}` } }]
            : `[binary: ${content.byteLength} bytes]`;
          return { role: "tool", tool_call_id: message.toolCallId, content: wire };
        }
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: typeof content === "string" ? content : JSON.stringify(content),
        };
      }
    }
  });
}

function toContent(content: Content): unknown {
  if (typeof content === "string") return content;
  const parts: unknown[] = [];
  for (const part of content) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    else parts.push({ type: "image_url", image_url: { url: `data:${part.mime};base64,${bytesToBase64(part.data)}` } });
  }
  return parts;
}

function bytesToBase64(bytes: Uint8Array): string {
  // btoa rejects inputs beyond ~0x80000000 bytes in some engines, and one giant
  // string concat is wasteful for multi-MB images. Chunk the input. The chunk
  // size is a multiple of 3 so every chunk ends on a base64 group boundary:
  // concatenating the raw outputs reproduces the whole-buffer encoding exactly
  // (only the final chunk carries '=' padding, which is then the correct
  // padding for the whole buffer). A non-multiple-of-3 chunk size breaks the
  // alignment and produces invalid base64 — see the chunked-base64 test.
  let out = "";
  const chunk = 0x7fe0; // 32736 = 10912 × 3
  for (let i = 0; i < bytes.length; i += chunk) {
    let part = "";
    const end = Math.min(i + chunk, bytes.length);
    for (let j = i; j < end; j++) part += String.fromCharCode(bytes[j]!);
    out += btoa(part);
  }
  return out;
}

function toTools(tools: readonly ToolSchema[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function mapFinishReason(reason: string): "stop" | "tool_calls" | "length" {
  if (reason === "tool_calls" || reason === "function_call") return "tool_calls";
  if (reason === "length") return "length";
  return "stop";
}

async function fetchOrThrow(url: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<Response> {
  // Network-level failures (DNS, refused, dropped) must surface as a
  // retryable ProviderError("network"), not a raw TypeError that the kernel
  // would later guess at as "unknown". A user abort is not a network failure:
  // propagate the AbortError as-is so the kernel maps it to AgentError aborted.
  try {
    return await fetch(url, { method: "POST", headers, body, signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ProviderError("network", error instanceof Error ? error.message : String(error));
  }
}

async function* sse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw new Error("AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        if (payload) {
          try {
            yield JSON.parse(payload) as Record<string, unknown>;
          } catch {
            // Skip malformed SSE payloads; the next chunk may complete them.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function toProviderError(status: number, body: string, headers: Headers): ProviderError {
  const detail = body.slice(0, 500);
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"));
  if (status === 429) {
    return new ProviderError("rate_limit", `rate limited (${status}): ${detail}`, retryAfterMs);
  }
  if (status === 401 || status === 403) return new ProviderError("auth", `auth failed (${status}): ${detail}`);
  if (status === 400 || status === 404 || status === 422) {
    // Providers phrase context overflow differently: OpenAI "maximum context
    // length", OpenRouter-style "context_length_exceeded", Anthropic "prompt
    // is too long", Gemini-style "input is too long". Missing a phrase turns
    // a compact-and-retry case into a terminal invalid_request throw.
    const lower = body.toLowerCase();
    const isContext = ["context_length", "context length", "maximum context", "prompt is too long", "input is too long"].some((phrase) =>
      lower.includes(phrase),
    );
    return new ProviderError(isContext ? "context_length_exceeded" : "invalid_request", `${status}: ${detail}`);
  }
  if (status >= 500) return new ProviderError("server", `server error (${status}): ${detail}`);
  return new ProviderError("unknown", `${status}: ${detail}`);
}

/**
 * Parse a `Retry-After` header in either RFC form — delta-seconds ("120")
 * or HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT") — into milliseconds from
 * now. Returns undefined when absent or unparsable; a past date yields 0.
 */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1_000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}
