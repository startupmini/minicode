// Token bucket rate limiter — mencegah request LLM beruntun kena 429.
// Capacity = burst allowance; refill per ms dari rpm.
import { LIMITS } from "../constants.ts"

export class RateLimiter {
  private readonly capacity: number
  private readonly refillPerMs: number
  private tokens: number
  private lastRefill: number

  constructor(capacity: number, refillPerMs: number) {
    this.capacity = Number.isSafeInteger(capacity) && capacity >= 1 ? capacity : 1
    this.refillPerMs = Number.isFinite(refillPerMs) && refillPerMs > 0 ? refillPerMs : 1 / 60_000
    this.tokens = this.capacity
    this.lastRefill = performance.now()
  }

  private refill(): void {
    const now = performance.now()
    const elapsed = now - this.lastRefill
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs)
      this.lastRefill = now
    }
  }

  /** Ambil 1 token; tunggu dibatalkan bila pemanggilnya timeout/cancel. */
  async acquire(signal?: AbortSignal): Promise<void> {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
      this.refill()
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const waitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerMs))
      // Node/Bun clamp delays above 2^31-1ms to 1ms. Chunk long waits so a
      // very low configured RPM cannot accidentally become a hot loop.
      const boundedWaitMs = Math.min(waitMs, LIMITS.MAX_TIMER_DELAY_MS)
      await waitAbortable(boundedWaitMs, signal)
    }
  }

  /** Info status (untuk /status). */
  info(): { capacity: number; available: number; rpm: number } {
    this.refill()
    return {
      capacity: this.capacity,
      available: this.tokens,
      rpm: Math.round(this.refillPerMs * 60_000),
    }
  }
}

// Buat limiter dari rpm (requests per minute). Burst = min(rpm, 10).
export function createRateLimiter(rpm: number): RateLimiter {
  const safe = Number.isFinite(rpm) && rpm > 0 ? rpm : 60
  const capacity = Math.max(1, Math.min(Math.floor(safe), 10))
  return new RateLimiter(capacity, safe / 60_000)
}

export function waitAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
    function cleanup() {
      signal?.removeEventListener("abort", onAbort)
    }
  })
}
