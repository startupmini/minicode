// Compaction: a deterministic, LLM-free strategy. Replaces old turns with a
// bounded summary while preserving the recent tail verbatim. It never splits
// an assistant tool_call message from its following tool results.

import type { ContextStore } from "./history.ts";
import type { Message } from "./types.ts";
import { contentToText, safeStringify } from "./tokens.ts";

export interface CompactionStrategy {
  readonly kind: string;
  compact(store: ContextStore, opts: { keepRecentTurns: number }): readonly Message[];
  /**
   * Optional async compaction. If present, the loop prefers this over `compact`
   * (sync). Must return the new messages array (or same if no compaction needed).
   * The loop expects this to respect `signal` (abort → reject). If it throws,
   * the loop falls back to `compact` (sync mechanical) — never crash the loop.
   * The signal is the turn's abort signal (user abort, session.abort, timeout).
   */
  compactAsync?(store: ContextStore, opts: { keepRecentTurns: number }, signal: AbortSignal): Promise<readonly Message[]>;
  /**
   * Lapisan pertama sebelum kompaksi penuh: pangkas ISI hasil tool lama
   * menjadi sentinel pendek. Opsional dan aditif — tanpa ini perilaku lama utuh.
   *
   * Mengembalikan daftar pesan baru (atau yang sama bila tak memangkas) dan
   * WAJIB mempertahankan pasangan `assistant(toolCalls)` → `tool` serta pesan
   * lain apa adanya. Loop memakai hasilnya hanya bila jumlah token benar-benar
   * turun, jadi implementasi tak perlu (dan tak boleh) menebak sendiri.
   */
  microcompact?(store: ContextStore, opts: { budgetTokens?: number }): readonly Message[];
}

export const mechanicalCompaction: CompactionStrategy = {
  kind: "mechanical",
  compact(store, { keepRecentTurns }) {
    const messages = store.messages;
    let kept = 0;
    let turns = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      kept++;
      if (messages[i]!.role === "user") turns++;
      if (turns >= keepRecentTurns) break;
    }
    // Never leave a tool result dangling: extend the kept region across a
    // tool's call batch (assistant → tool results) so results stay paired.
    while (kept < messages.length) {
      const cut = messages.length - kept;
      const firstKept = messages[cut]!;
      const prev = messages[cut - 1];
      const extendsPair =
        firstKept.role === "tool" &&
        prev !== undefined &&
        (prev.role === "tool" || (prev.role === "assistant" && prev.toolCalls !== undefined && prev.toolCalls.length > 0));
      if (extendsPair) kept++;
      else break;
    }
    if (kept >= messages.length) return messages;
    const prefix = messages.slice(0, messages.length - kept);
    const summary: Message = {
      role: "user",
      content: `Previous context:\n${prefix.map(compactLine).join("\n")}`,
    };
    return [summary, ...messages.slice(-kept)];
  },
};

function compactLine(message: Message): string {
  switch (message.role) {
    case "user":
      return `- user: ${head(contentToText(message.content), 400)}`;
    case "assistant": {
      const calls = (message.toolCalls ?? [])
        .map((call) => `${call.name}(${head(safeStringify(call.args), 80)})`)
        .join(", ");
      return `- assistant${calls ? ` [calls: ${calls}]` : ""}: ${head(contentToText(message.content), 400)}`;
    }
    case "tool":
      if (message.isError) return `- tool(${message.name}): ${head(String(message.content), 200)}`;
      return `- tool(${message.name}): <result omitted>`;
    default:
      return "";
  }
}

function head(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}