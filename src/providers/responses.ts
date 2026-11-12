import { ProviderError } from "#minicore/core/errors.ts"
import type { ModelProvider, ProviderEvent, StreamRequest } from "#minicore/core/provider.ts"
import { allowedEfforts, thinkingFamily } from "./effort.ts"
import {
  appendToolArgument,
  boundedSseBody,
  parseProviderToolArguments,
  readProviderErrorBody,
} from "./sse-bounds.ts"

export interface ResponsesConfig {
  id?: string
  baseUrl: string
  apiKey?: string
  models: readonly string[]
  defaultModel?: string
  reasoningEffort?: string
}

// Minimal Responses API adapter — /v1/responses, previous_response_id chaining, store:false
// Untuk P11 P1.1: providerHint "responses" → wire ini, bukan chat/completions.
// Implementasi streaming SSE mirip openai-compat, tapi endpoint berbeda.
//
// Chaining: response id terakhir per model disimpan per-instance provider,
// bukan global — global bocor antar sesi CLI paralel yang sharing model sama.
// Instance dibuat per sesi via buildProviderList, jadi isolasi sesi gratis.
const allChains = new Set<Map<string, string>>()
export function clearResponsesChain(): void {
  // Global clear untuk compat — bersihkan semua instance yang pernah dibuat
  for (const m of allChains) m.clear()
}

/**
 * Petakan riwayat kernel ke Responses input items TANPA menghancurkan linkage.
 * Versi lama me-JSON-kan seluruh pesan (tool_calls, tool_call_id, reasoning,
 * multimodal hilang) sehingga turn lanjutan buta terhadap tool-nya sendiri.
 * Multimodal non-teks tetap di-stringify (keterbatasan jujur: Responses
 * input teks; image akan ditangani bila adapter mendukung part image).
 */
export function toResponsesInput(
  messages: readonly {
    role: string
    content?: unknown
    toolCalls?: unknown
    toolCallId?: string
    isError?: boolean
  }[],
): unknown[] {
  const out: unknown[] = []
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? null)
    if (m.role === "assistant" && Array.isArray((m as { toolCalls?: unknown }).toolCalls)) {
      if (text) out.push({ role: "assistant", content: text })
      for (const c of (m as unknown as { toolCalls: { id: string; name: string; args: unknown }[] })
        .toolCalls) {
        out.push({
          type: "function_call",
          call_id: c.id,
          name: c.name,
          arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? {}),
        })
      }
      continue
    }
    if (m.role === "tool") {
      const t = m as unknown as { toolCallId?: string; content?: unknown; isError?: boolean }
      const content = typeof t.content === "string" ? t.content : JSON.stringify(t.content ?? null)
      out.push({
        type: "function_call_output",
        call_id: t.toolCallId ?? "",
        output: t.isError ? `ERROR: ${content}` : content,
      })
      continue
    }
    out.push({ role: m.role, content: text })
  }
  return out
}

export function createResponsesProvider(config: ResponsesConfig): ModelProvider {
  const baseUrl = config.baseUrl.replace(/\/+$/, "")
  const endpoint = `${baseUrl}/responses`
  const lastResponseByModel = new Map<string, string>()
  allChains.add(lastResponseByModel)
  const provider: ModelProvider & { kind: "responses"; clearResponsesChain?: () => void } = {
    id: config.id ?? "responses",
    models: config.models,
    // brand kind: router memakai ini untuk (a) skip binary-fix gaya Anthropic,
    // (b) skip penyelipan system-message (diurus via `instructions` di bawah).
    kind: "responses",
    clearResponsesChain: () => lastResponseByModel.clear(),
    async *stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      const modelKey = request.model ?? config.defaultModel ?? config.models[0] ?? "default"
      const prev = lastResponseByModel.get(modelKey)
      // Effort hanya untuk keluarga OpenAI reasoning dengan level yang
      // didukung model itu (mis. pro = high saja); sisanya omit — default
      // bawaan model yang berlaku. Tanpa ini model non-reasoning 400.
      const wantEffort = config.reasoningEffort
      const sendEffort =
        wantEffort &&
        thinkingFamily(modelKey) === "openai-reasoning" &&
        allowedEfforts(modelKey).includes(wantEffort as "low" | "medium" | "high")
          ? wantEffort
          : undefined
      const body = JSON.stringify({
        model: request.model ?? config.defaultModel ?? config.models[0],
        input: toResponsesInput(request.messages),
        tools: request.tools?.length
          ? request.tools.map((t) => ({
              type: "function",
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            }))
          : undefined,
        // System prompt KERNEL (MEMORY, repomap, instruksi) — versi lama
        // membuangnya total (body tanpa field ini). Responses API punya
        // field khusus; jangan selipkan sebagai user message.
        ...(request.system?.trim() ? { instructions: request.system } : {}),
        stream: true,
        store: false,
        ...(sendEffort ? { reasoning: { effort: sendEffort } } : {}),
        // Rantai konteks antar turn; tanpa ini server memperlakukan tiap
        // request sebagai sesi baru (biaya konteks + hilang ingatan server).
        ...(prev ? { previous_response_id: prev } : {}),
      })
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      }
      let res: Response
      try {
        res = await fetch(endpoint, { method: "POST", headers, body, signal })
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") throw e
        throw new ProviderError("network", e instanceof Error ? e.message : String(e))
      }
      if (!res.ok) {
        // Bila request gagal saat membawa previous_response_id, hapus ID tersebut
        // agar turn berikutnya tidak macet permanen pada ID yang kedaluwarsa/ditolak.
        if (prev) lastResponseByModel.delete(modelKey)
        const txt = await readProviderErrorBody(res, signal).catch(() => "")
        const retryAfter = res.headers.get("retry-after")
        if (res.status === 429) {
          const ms = retryAfter ? Number(retryAfter) * 1000 : undefined
          throw new ProviderError(
            "rate_limit",
            `rate limited (${res.status}): ${txt.slice(0, 500)}`,
            Number.isFinite(ms) ? ms : undefined,
          )
        }
        // Samakan dengan adapter lain: 401/403 = auth (fail-fast, tanpa
        // retry buta). Sebelumnya jatuh ke "unknown" lalu di-retry 3x.
        if (res.status === 401 || res.status === 403) {
          throw new ProviderError("auth", `auth rejected (${res.status}): ${txt.slice(0, 500)}`)
        }
        // Samakan dengan adapter lain: konteks kepanjangan = compact-and-retry
        // di loop, bukan retry-buta 3x lalu throw. Frasa diselaraskan dengan
        // openai-compat/anthropic (`context_length`, `maximum context`,
        // `prompt is too long`) + `context window`. Sengaja TANPA kata
        // telanjang `token`/`too long`/`context`: "invalid token" atau
        // "tokenizer error" bukan kepanjangan konteks — mengklasifikasikannya
        // sebagai context_length_exceeded menghancurkan riwayat sia-sia.
        if (
          (res.status === 400 || res.status === 422) &&
          /context_length|maximum context|prompt is too long|context window/i.test(txt)
        ) {
          throw new ProviderError(
            "context_length_exceeded",
            `context too long (${res.status}): ${txt.slice(0, 500)}`,
          )
        }
        throw new ProviderError(
          res.status >= 500 ? "server" : "unknown",
          `${res.status}: ${txt.slice(0, 500)}`,
        )
      }
      if (!res.body) throw new ProviderError("network", "empty response body")
      // Simplified SSE: forward text deltas
      const boundedBody = boundedSseBody(res.body, signal, "Responses")
      const reader = boundedBody.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      // F-01: akumulasi function_call per item (Responses tidak punya delta
      // gaya chat completions; argumen mengalir via
      // response.function_call_arguments.delta lalu item final via
      // response.output_item.done). Tanpa ini tool yang dideklarasikan di
      // request tidak pernah dieksekusi — agen tampak selesai padahal buta.
      const pendingCalls = new Map<
        string,
        { id: string; name: string; args: string; argsBytes: number }
      >()
      let pendingToolArgBytes = 0
      let finished = false
      const yieldCall = function* (
        id: string,
        name: string,
        argsRaw: string,
      ): Generator<ProviderEvent> {
        if (finished) {
          // Cermin openai-compat: tool setelah finish = stream rusak, jangan
          // eksekusi ganda diam-diam — gagal keras sebagai network retryable.
          throw new ProviderError("network", "tool call after finish")
        }
        yield {
          type: "tool_call",
          id: id || name,
          name,
          args: parseProviderToolArguments(argsRaw, "Responses"),
        }
      }
      let reachedEof = false
      try {
        while (true) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError")
          const { done, value } = await reader.read()
          if (done) {
            reachedEof = true
            break
          }
          buf += decoder.decode(value, { stream: true })
          let idx = buf.indexOf("\n")
          while (idx >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, "")
            buf = buf.slice(idx + 1)
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim()
              // F-02: [DONE] = akhir stream yang sukses. Versi lama `return`
              // tanpa finish sehingga kernel melempar "stream ended without a
              // finish reason" + 3 retry sia-sia atas respons yang valid.
              if (payload === "[DONE]") {
                for (const [, acc] of pendingCalls) {
                  yield* yieldCall(acc.id, acc.name, acc.args)
                }
                pendingCalls.clear()
                pendingToolArgBytes = 0
                if (!finished) {
                  finished = true
                  yield { type: "finish", reason: "stop" }
                }
                return
              }
              if (!payload) {
                idx = buf.indexOf("\n")
                continue
              }
              let data: Record<string, unknown>
              try {
                data = JSON.parse(payload) as Record<string, unknown>
              } catch {
                throw new ProviderError("invalid_request", "Responses returned malformed SSE JSON")
              }
              // response.completed → simpan id untuk chaining turn berikut.
              // Format nyata: {type:"response.completed", response:{id:"resp_…"}}.
              const dtype = data.type as string | undefined
              if (dtype === "response.completed" || dtype === "completed") {
                const resp = data.response as { id?: unknown; usage?: unknown } | undefined
                const rid = resp?.id ?? data.id
                if (typeof rid === "string" && rid) lastResponseByModel.set(modelKey, rid)
                // Tanpa usage event, Responses tak pernah menyumbang token ke
                // budget/cost (buta spend). Bentuk shape sama dengan adapter
                // openai-compat agar kolektor tak perlu tahu provider.
                const u = resp?.usage as
                  | { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown }
                  | undefined
                if (
                  u &&
                  (u.input_tokens != null || u.output_tokens != null || u.total_tokens != null)
                ) {
                  yield {
                    type: "extension",
                    kind: "usage",
                    data: {
                      inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : undefined,
                      outputTokens:
                        typeof u.output_tokens === "number" ? u.output_tokens : undefined,
                      totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : undefined,
                    },
                  }
                }
              }
              const reasoningText =
                (dtype === "response.reasoning_summary_text.delta" ||
                  dtype === "response.reasoning_text.delta") &&
                typeof data.delta === "string"
                  ? data.delta
                  : ""
              if (reasoningText) {
                yield { type: "extension", kind: "reasoning", data: { text: reasoningText } }
              }
              const rawDelta: unknown = (data.delta as unknown) ?? data
              const drec = (
                typeof rawDelta === "object" && rawDelta !== null
                  ? (rawDelta as Record<string, unknown>)
                  : {}
              ) as Record<string, unknown> & { output_text?: string }
              // Bentuk function_call Responses: item diumumkan via
              // output_item.added, argumen mengalir via
              // function_call_arguments.delta, item final via output_item.done.
              //Juga tangani bentuk ringkas satu-event {type:"function_call",...}
              // yang dipakai sebagian gateway.
              const item = data.item as
                | {
                    id?: unknown
                    type?: unknown
                    call_id?: unknown
                    name?: unknown
                    arguments?: unknown
                  }
                | undefined
              if (dtype === "response.output_item.added" && item?.type === "function_call") {
                const key =
                  typeof item.id === "string" && item.id
                    ? item.id
                    : typeof item.call_id === "string"
                      ? item.call_id
                      : `item_${pendingCalls.size}`
                const cid = typeof item.call_id === "string" && item.call_id ? item.call_id : key
                const prior = pendingCalls.get(key)
                if (prior) pendingToolArgBytes -= prior.argsBytes
                const initialArgs = typeof item.arguments === "string" ? item.arguments : ""
                const boundedArgs = appendToolArgument(
                  "",
                  0,
                  initialArgs,
                  pendingToolArgBytes,
                  "Responses",
                )
                pendingToolArgBytes = boundedArgs.pendingBytes
                pendingCalls.set(key, {
                  id: cid,
                  name: typeof item.name === "string" ? item.name : "",
                  args: boundedArgs.value,
                  argsBytes: boundedArgs.bytes,
                })
              } else if (dtype === "response.function_call_arguments.delta") {
                const key =
                  typeof data.item_id === "string" && data.item_id
                    ? data.item_id
                    : ([...pendingCalls.keys()].pop() ?? "")
                const acc = pendingCalls.get(key)
                if (acc && typeof data.delta === "string") {
                  const boundedArgs = appendToolArgument(
                    acc.args,
                    acc.argsBytes,
                    data.delta,
                    pendingToolArgBytes,
                    "Responses",
                  )
                  acc.args = boundedArgs.value
                  acc.argsBytes = boundedArgs.bytes
                  pendingToolArgBytes = boundedArgs.pendingBytes
                }
              } else if (dtype === "response.output_item.done" && item?.type === "function_call") {
                const key =
                  typeof item.id === "string" && pendingCalls.has(item.id)
                    ? item.id
                    : ([...pendingCalls.keys()].pop() ?? "")
                const acc = pendingCalls.get(key)
                const id = (typeof item.call_id === "string" && item.call_id) || acc?.id || key
                const name = (typeof item.name === "string" && item.name) || acc?.name || ""
                const argsRaw =
                  (typeof item.arguments === "string" && item.arguments) || acc?.args || ""
                pendingCalls.delete(key)
                if (acc) pendingToolArgBytes -= acc.argsBytes
                if (name) yield* yieldCall(id, name, argsRaw)
              } else if (data.type === "function_call" && typeof data.name === "string") {
                const id =
                  typeof data.call_id === "string"
                    ? data.call_id
                    : typeof data.id === "string"
                      ? data.id
                      : data.name
                yield* yieldCall(
                  id,
                  data.name,
                  typeof data.arguments === "string" ? data.arguments : "",
                )
              }
              const isToolEvent =
                dtype === "response.output_item.added" ||
                dtype === "response.function_call_arguments.delta" ||
                dtype === "response.function_call_arguments.done" ||
                dtype === "response.output_item.done" ||
                dtype === "function_call"
              const text =
                reasoningText || isToolEvent
                  ? undefined
                  : ((typeof rawDelta === "string" ? rawDelta : undefined) ??
                    drec.text ??
                    drec.content ??
                    drec.output_text)
              if (typeof text === "string" && text) yield { type: "text", text }
              const finish =
                (data as { finish_reason?: string }).finish_reason ??
                (drec as { finish_reason?: string }).finish_reason
              if (finish) {
                finished = true
                yield {
                  type: "finish",
                  reason:
                    finish === "length"
                      ? "length"
                      : finish === "tool_calls"
                        ? "tool_calls"
                        : "stop",
                }
              }
            }
            idx = buf.indexOf("\n")
          }
        }
      } finally {
        if (!reachedEof) await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      // Gateway yang menyelesaikan stream tanpa output_item.done tetap flush
      // item tertahan; parser sudah membatasi dan memvalidasi JSON argumennya.
      for (const [, acc] of pendingCalls) {
        yield* yieldCall(acc.id, acc.name, acc.args)
      }
      pendingCalls.clear()
      pendingToolArgBytes = 0
      if (!finished) yield { type: "finish", reason: "stop" }
    },
  }
  return provider
}
