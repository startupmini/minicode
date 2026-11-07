// The model contract. The kernel only knows these normalized events; every
// provider adapter (OpenAI-compatible, Anthropic, Gemini, local…) implements
// this one interface. Reasoning/thinking is an optional "extension" event and
// is never required.

import type { Message } from "./types.ts";
import type { ToolSchema } from "./tool.ts";

/**
 * Why a provider stream ended. The kernel consults this to decide recovery:
 * `length` may trigger compaction+retry, `error`/`abort` never retry.
 */
export type FinishReason = "stop" | "tool_calls" | "length" | "abort" | "error";

/**
 * The normalized provider stream. Adapters translate their wire format into
 * exactly these events; the kernel never sees provider-specific shapes. A
 * well-formed stream always ends with a `finish` event.
 */
export type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "finish"; reason: FinishReason }
  | { type: "extension"; kind: string; data: unknown };

/** The per-request payload the kernel hands to a provider. */
export interface StreamRequest {
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
  readonly system?: string;
  readonly model?: string;
}

/** A model provider: normalized, stateless, and swappable. */
export interface ModelProvider {
  readonly id: string;
  readonly models: readonly string[];
  /** Optional host metadata for per-model admission budgets. */
  contextWindowTokensForModel?(model?: string): number;
  /** Canonical provider/model key for per-model estimator state. */
  contextModelIdentity?(model?: string): string | undefined;
  stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
