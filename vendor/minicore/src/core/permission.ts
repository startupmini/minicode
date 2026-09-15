// Permission boundary. The kernel commits to consulting this handler before
// every tool execution; it never enforces its own policy.

import type { ToolCall } from "./types.ts";
import type { ExecutorDeps } from "./executor.ts";

/**
 * Only "deny" blocks execution. A handler that needs interactive approval
 * (e.g. a CLI prompt) is expected to block until it resolves the decision
 * internally and then return "allow" or "deny".
 */
export type Decision = "allow" | "deny";

export interface PermissionHandler {
  check(call: ToolCall, deps: ExecutorDeps): Promise<Decision>;
  /**
   * Additive seam (minicode, bukan upstream): alasan deny terakhir untuk
   * `call`, agar model bisa koreksi arah alih-alih retry buta sampai
   * max_steps. Dipanggil kernel tepat setelah `check` mengembalikan "deny";
   * return undefined/"" = pesan deny polos seperti dulu. Opsional — handler
   * lama tanpa method ini tetap jalan tanpa perubahan perilaku.
   */
  describeDenial?(call: ToolCall): Promise<string | undefined> | string | undefined;
}