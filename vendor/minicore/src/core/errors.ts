// Provider-agnostic error taxonomy and recovery actions.

/** The deterministic reasons a kernel `run()` can settle with. */
export type AgentErrorKind =
  | "busy"
  | "aborted"
  | "timeout"
  | "max_steps_exceeded"
  | "budget_exceeded"
  | "provider";

/** Kernel-side failure, always carrying a `kind` from `AgentErrorKind`. */
export class AgentError extends Error {
  readonly name = "AgentError";
  constructor(
    readonly kind: AgentErrorKind,
    message: string,
    options?: {
      cause?: unknown
      /** Diagnostik terstruktur untuk kegagalan yang butuh ANGKA, bukan hanya
       * prosa (mis. `budget_exceeded` dengan `reason: "fixpoint"` + berapa
       * token tersisa). Pemanggil bisa menampilkan sebab yang tepat alih-alih
       * menyuruh user "coba lagi" pada kondisi yang tak akan berubah. */
      details?: Record<string, unknown>
    },
  ) {
    super(message, options);
    if (options?.details) this.details = options.details;
  }
  /** Rincian mesin-terbaca; `undefined` bila tak ada. */
  readonly details?: Record<string, unknown>;
}

/**
 * Turn an aborted signal into the AgentError it carries. When the kernel
 * aborts a signal with a reason (e.g. a timeout), that reason is preserved so
 * callers can distinguish "timed out" from "user aborted".
 */
export function abortError(signal: AbortSignal): AgentError {
  return signal.reason instanceof AgentError ? signal.reason : new AgentError("aborted", "turn aborted");
}

/** Normalized provider failure categories produced by adapters. */
export type ProviderErrorCategory =
  | "rate_limit"
  | "network"
  | "server"
  | "auth"
  | "invalid_request"
  | "context_length_exceeded"
  | "unknown";

/** Provider-side failure, normalized by an adapter into a category. */
export class ProviderError extends Error {
  readonly name = "ProviderError";
  constructor(
    readonly category: ProviderErrorCategory,
    message: string,
    readonly retryAfterMs?: number,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

/** What the recovery policy tells the loop to do after a provider failure. */
export type RecoveryAction =
  | { type: "retry"; delayMs: number }
  | { type: "force_compact_and_retry" }
  | { type: "throw" };