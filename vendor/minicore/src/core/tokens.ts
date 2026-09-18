// Token estimation: an injectable policy. The kernel's default is a plain
// chars/4 heuristic — swap it per model without touching the kernel.
// Truncation in executor.ts must stay in the same unit as this heuristic, so
// the chars-per-token factor lives here as the single source of truth.

import type { ToolSchema } from "./tool.ts";
import type { Content, Message } from "./types.ts";

export const DEFAULT_CHARS_PER_TOKEN = 4;

export type TokenEstimator = (text: string) => number;

export const defaultTokenEstimator: TokenEstimator = (text) => Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN);

export function contentToText(content: Content): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : `[image:${part.mime}]`)).join("\n");
}

/**
 * Token estimate for inline image bytes. The text placeholder above would
 * price a 100KB image at ~15 tokens, hiding it from budget pressure until
 * the context genuinely overflows — so image parts are priced from their
 * base64 wire size instead.
 */
export function estimateImageTokens(byteLength: number): number {
  return Math.ceil(Math.ceil((byteLength * 4) / 3) / DEFAULT_CHARS_PER_TOKEN);
}

function estimateContent(content: Content, est: TokenEstimator): number {
  if (typeof content === "string") return est(content);
  let total = 0;
  for (const part of content) {
    if (part.type === "text") total += est(part.text);
    else total += estimateImageTokens(part.data.byteLength);
  }
  return total;
}

/**
 * JSON.stringify that never throws: cyclic values (possible only from hostile
 * or buggy input) fall back to a plain string instead of leaking a raw
 * TypeError through the kernel's deterministic error taxonomy.
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function estimateMessage(message: Message, est: TokenEstimator): number {
  switch (message.role) {
    case "user":
      return estimateContent(message.content, est);
    case "assistant":
      return estimateContent(message.content, est) + est(safeStringify(message.toolCalls ?? [])) + est(message.reasoning ?? "");
    case "tool": {
      const c = message.content;
      // Binary tool results (e.g. images): JSON.stringify of a Uint8Array
      // explodes into a {"0":..} map, faking pressure and triggering
      // premature compaction. Price it as image bytes instead.
      if (c instanceof Uint8Array) return estimateImageTokens(c.byteLength);
      return est(typeof c === "string" ? c : safeStringify(c ?? null));
    }
    default:
      return 0;
  }
}

export function estimateMessages(messages: readonly Message[], est: TokenEstimator): number {
  let total = 0;
  for (const message of messages) total += estimateMessage(message, est);
  return total;
}

/** The fixed per-request cost of the tool schemas sent with every call. */
export function estimateTools(tools: readonly ToolSchema[], est: TokenEstimator): number {
  let total = 0;
  for (const tool of tools) total += est(tool.name) + est(tool.description) + est(safeStringify(tool.parameters));
  return total;
}

/** The fixed per-request cost of the system prompt. */
export function estimateSystem(system: string | undefined, est: TokenEstimator): number {
  return system ? est(system) : 0;
}

/**
 * Single source for the current context size: messages + system + tools —
 * everything sent per request. Shared by the loop (pressure evaluation)
 * and the Session getter (observability) so no duplicate estimator can
 * drift. Pure over its arguments; takes the store shape instead of
 * SessionInternal to avoid a session<->loop circular import.
 */
export function estimateSessionContext(
  store: { messages: readonly Message[] },
  system: string | undefined,
  tools: readonly ToolSchema[],
  est: TokenEstimator,
): number {
  return (
    estimateMessages(store.messages, est) +
    estimateSystem(system, est) +
    estimateTools(tools, est)
  );
}