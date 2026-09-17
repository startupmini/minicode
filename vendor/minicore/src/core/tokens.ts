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
 * Additive seam (minicode): estimasi token sadar-gambar. Gambar inline
 * membawa byte base64 (~bytes/3 token) — placeholder `[image:mime]` lama
 * membuat gambar 100k hanya ~15 token (tak terlihat budget → kompaksi tak
 * jalan sampai konteks benar-benar jebol). Rumus sama dengan
 * src/policy/context.ts estimateImageTokens agar laporan read_image dan
 * budget konsisten.
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
      // Hasil tool biner (mis. gambar): JSON.stringify Uint8Array meledak
      // jadi {"0":..} raksasa → tekanan palsu → kompaksi prematur. Estimasi
      // sebagai gambar, bukan string JSON.
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
 * Seam kontrak control-plane (Phase 6): SATU sumber angka konteks —
 * messages + system + tools, semuanya yang dikirim per request. Dipakai
 * loop (pressure) DAN Session getter (ekspos ke driver/UI/budget) sehingga
 * tidak ada estimator duplikat untuk kebutuhan tampilan. Fungsi murni atas
 * argumen — tidak ada ketergantungan SessionInternal (menghindari circular
 * import session↔loop).
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