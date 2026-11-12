import { Buffer } from "node:buffer"
import { abortError, ProviderError } from "#minicore/core/errors.ts"
import { LIMITS } from "../constants.ts"

export interface SseBounds {
  maxFrameBytes?: number
  maxTotalBytes?: number
}

export interface ToolArgumentBounds {
  maxArgumentBytes?: number
  maxPendingBytes?: number
}

/** Baca stream per chunk dengan batas byte sebelum parser SSE membangun buffer baris. */
export function boundedSseBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  provider: string,
  bounds: SseBounds = {},
): ReadableStream<Uint8Array> {
  const maxFrameBytes = bounds.maxFrameBytes ?? LIMITS.PROVIDER_SSE_FRAME_MAX_BYTES
  const maxTotalBytes = bounds.maxTotalBytes ?? LIMITS.PROVIDER_SSE_TOTAL_MAX_BYTES
  if (signal.aborted) throw abortError(signal)
  const reader = body.getReader()
  let streamBytes = 0
  let lineBytes = 0
  let frameBytes = 0
  let reachedEof = false
  let released = false
  const release = () => {
    if (released) return
    released = true
    signal.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener("abort", onAbort, { once: true })
  const cancelSource = async (reason?: unknown) => {
    if (!reachedEof) await reader.cancel(reason).catch(() => {})
    release()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal.aborted) throw abortError(signal)
        const { done, value } = await reader.read()
        if (signal.aborted) throw abortError(signal)
        if (done) {
          reachedEof = true
          if (lineBytes !== 0 || frameBytes !== 0) {
            throw new ProviderError(
              "invalid_request",
              `${provider} returned an incomplete SSE frame`,
            )
          }
          controller.close()
          release()
          return
        }
        streamBytes += value.byteLength
        if (streamBytes > maxTotalBytes) {
          throw new ProviderError(
            "invalid_request",
            `${provider} SSE stream exceeds ${maxTotalBytes} bytes`,
          )
        }
        for (const byte of value) {
          if (byte === 0x0a) {
            frameBytes++
            if (frameBytes > maxFrameBytes) {
              throw new ProviderError(
                "invalid_request",
                `${provider} SSE frame exceeds ${maxFrameBytes} bytes`,
              )
            }
            if (lineBytes === 0) frameBytes = 0
            lineBytes = 0
          } else {
            lineBytes++
            frameBytes++
            if (lineBytes > maxFrameBytes || frameBytes > maxFrameBytes) {
              throw new ProviderError(
                "invalid_request",
                `${provider} SSE frame exceeds ${maxFrameBytes} bytes`,
              )
            }
          }
        }
        controller.enqueue(value)
      } catch (error) {
        await cancelSource(error)
        controller.error(error)
      }
    },
    cancel: cancelSource,
  })
}

/** Body error dibaca secukupnya untuk kategori/pesan, lalu sisa stream dibuang.
 * `signal` membuat pembacaan abort-aware: server yang mengembalikan status error
 * lalu menstall body-nya tidak boleh menggantung reader selamanya — cancel reader
 * saat abort sehingga jalur error tetap terbatas waktu. */
export async function readProviderErrorBody(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) return ""
  if (signal?.aborted) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let reachedEof = false
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    while (size < LIMITS.PROVIDER_ERROR_BODY_MAX_BYTES) {
      if (signal?.aborted) break
      const { done, value } = await reader.read()
      if (signal?.aborted) break
      if (done) {
        reachedEof = true
        break
      }
      const remaining = LIMITS.PROVIDER_ERROR_BODY_MAX_BYTES - size
      const part = value.byteLength > remaining ? value.subarray(0, remaining) : value
      chunks.push(part)
      size += part.byteLength
      if (part.byteLength < value.byteLength) break
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
  } finally {
    signal?.removeEventListener("abort", onAbort)
    if (!reachedEof) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function appendToolArgument(
  current: string,
  currentBytes: number,
  delta: string,
  pendingBytes: number,
  provider: string,
  bounds: ToolArgumentBounds = {},
): { value: string; bytes: number; pendingBytes: number } {
  const deltaBytes = Buffer.byteLength(delta, "utf8")
  const bytes = currentBytes + deltaBytes
  const nextPendingBytes = pendingBytes + deltaBytes
  const maxArgumentBytes = bounds.maxArgumentBytes ?? LIMITS.PROVIDER_TOOL_ARGS_MAX_BYTES
  const maxPendingBytes = bounds.maxPendingBytes ?? LIMITS.PROVIDER_TOOL_ARGS_PENDING_MAX_BYTES
  if (bytes > maxArgumentBytes) {
    throw new ProviderError(
      "invalid_request",
      `${provider} tool arguments exceed ${maxArgumentBytes} bytes`,
    )
  }
  if (nextPendingBytes > maxPendingBytes) {
    throw new ProviderError(
      "invalid_request",
      `${provider} pending tool arguments exceed ${maxPendingBytes} bytes`,
    )
  }
  return { value: current + delta, bytes, pendingBytes: nextPendingBytes }
}

export function parseProviderToolArguments(raw: string, provider: string): unknown {
  if (Buffer.byteLength(raw, "utf8") > LIMITS.PROVIDER_TOOL_ARGS_MAX_BYTES) {
    throw new ProviderError(
      "invalid_request",
      `${provider} tool arguments exceed ${LIMITS.PROVIDER_TOOL_ARGS_MAX_BYTES} bytes`,
    )
  }
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new ProviderError("invalid_request", `${provider} returned malformed tool arguments`)
  }
}
