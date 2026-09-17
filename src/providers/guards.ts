// Penjaga stream provider (F-11 timeout, F-16 text-cap).
//
// Dua lubang yang ditutup di SATU titik (buildProviderList) sehingga berlaku
// untuk SEMUA adapter termasuk vendor openai-compat yang tak boleh disentuh:
//  1. Tanpa fetch timeout, server hung = turn hung sampai timeout turn.
//  2. Akumulasi `text` provider tanpa cap = OOM pada stream raksasa.
//
// Bentuk wrapper meniru pola withStrippedRetry, DITAMBAH preservasi properti
// (`...provider`: kind untuk router, clearResponsesChain untuk responses).
// Abort parent diteruskan apa adanya (tak pernah ditelan/dikonversi); hanya
// timeout MILIK guard yang diklasifikasikan ulang menjadi ProviderError
// "server" agar tak dikira network-putus atau abort-user.
import { abortError, ProviderError } from "#minicore/core/errors.ts"
import type { ModelProvider, ProviderEvent, StreamRequest } from "#minicore/core/provider.ts"
import { LIMITS } from "../constants.ts"

export function withStreamGuards(
  provider: ModelProvider,
  opts: { timeoutMs?: number; maxTextChars?: number; maxReasonChars?: number } = {},
): ModelProvider {
  const timeoutMs = opts.timeoutMs ?? LIMITS.PROVIDER_REQUEST_TIMEOUT_MS
  const maxTextChars = opts.maxTextChars ?? LIMITS.PROVIDER_TEXT_MAX_CHARS
  // Reasoning = bukan bagian jawaban; cap agresif (2MB logis ≈ 500k token —
  // jauh di atas reasoning sah mana pun, jauh di bawah OOM).
  const maxReasonChars = opts.maxReasonChars ?? LIMITS.PROVIDER_REASON_MAX_CHARS
  return {
    ...provider,
    id: provider.id,
    get models() {
      return provider.models
    },
    async *stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      if (signal.aborted) throw abortError(signal)
      const ctl = new AbortController()
      const onParentAbort = () => ctl.abort(signal.reason)
      if (signal.aborted) ctl.abort(signal.reason)
      else signal.addEventListener("abort", onParentAbort, { once: true })
      const timer = setTimeout(
        () => ctl.abort(new Error(`provider request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
      // Jangan menahan exit proses bila turn sudah selesai dari sisi lain.
      ;(timer as unknown as { unref?: () => void }).unref?.()
      let timedOut = false
      const onLinkedAbort = () => {
        if (!signal.aborted) timedOut = true
      }
      ctl.signal.addEventListener("abort", onLinkedAbort, { once: true })
      let textChars = 0
      let reasonChars = 0
      let marked = false
      let reasonMarked = false
      try {
        for await (const ev of provider.stream(request, ctl.signal)) {
          // F-16 diperluas (investigasi Phase 5): extension "reasoning" juga
          // diakumulasi kernel (loop `reasoning += ev.data.text` TANPA cap) —
          // dulu hanya ev.type "text" yang dipotong, sehingga reasoning stream
          // adalah satu-satunya jalur akumulasi tak terbatas (terbukti probe
          // E-2: 200MB+ chars, heap tumbuh, tanpa cap). Cap terpisah karena
          // reasoning bukan bagian jawaban — boleh dipotong agresif tanpa
          // merusak konten hasil.
          if (ev.type === "text" && typeof ev.text === "string" && ev.text) {
            if (textChars >= maxTextChars) continue
            textChars += ev.text.length
            if (textChars > maxTextChars) {
              const keep = ev.text.slice(0, ev.text.length - (textChars - maxTextChars))
              if (keep) yield { type: "text", text: keep }
              if (!marked) {
                marked = true
                yield { type: "text", text: "\n… [provider text truncated: turn cap exceeded]" }
              }
              continue
            }
          } else if (ev.type === "extension" && ev.kind === "reasoning") {
            const d = ev.data as { text?: unknown } | undefined
            if (typeof d?.text === "string" && d.text) {
              if (reasonChars >= maxReasonChars) continue
              reasonChars += d.text.length
              if (reasonChars > maxReasonChars) {
                const keep = d.text.slice(0, d.text.length - (reasonChars - maxReasonChars))
                if (keep) yield { type: "extension", kind: "reasoning", data: { text: keep } }
                if (!reasonMarked) {
                  reasonMarked = true
                  yield {
                    type: "extension",
                    kind: "reasoning",
                    data: { text: "\n… [reasoning truncated: cap exceeded]" },
                  }
                }
                continue
              }
            }
          }
          yield ev
        }
      } catch (e) {
        if (timedOut)
          throw new ProviderError("server", `provider request timed out after ${timeoutMs}ms`)
        throw e
      } finally {
        clearTimeout(timer)
        signal.removeEventListener("abort", onParentAbort)
        ctl.signal.removeEventListener("abort", onLinkedAbort)
      }
    },
  }
}
