// Provider-agnostic recovery. Adapters normalize provider-specific errors into
// ProviderError categories; this policy decides what the kernel does about them.

import type { ProviderError, RecoveryAction } from "./errors.ts";

export interface RecoveryPolicy {
  onError(error: ProviderError, attempt: number): RecoveryAction;
  onLength(compacted: boolean): RecoveryAction;
}

export const maxProviderRetries = 3;

export const defaultRecoveryPolicy: RecoveryPolicy = {
  onError(error, attempt) {
    switch (error.category) {
      case "auth":
      case "invalid_request":
        return { type: "throw" };
      case "context_length_exceeded":
        return { type: "force_compact_and_retry" };
      default:
        if (attempt > maxProviderRetries) return { type: "throw" };
        return { type: "retry", delayMs: backoffDelay(attempt, error.retryAfterMs) };
    }
  },
  onLength(compacted) {
    return compacted ? { type: "throw" } : { type: "force_compact_and_retry" };
  },
};

const RETRY_AFTER_MAX_MS = 30_000;

function backoffDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter != null) return Math.min(retryAfter, RETRY_AFTER_MAX_MS);
  return Math.min(1_000 * 2 ** (attempt - 1), 8_000);
}