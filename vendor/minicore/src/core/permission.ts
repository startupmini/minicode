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
   * Optional diagnostic for the most recent denial of `call`, so the model
   * can steer instead of retrying blindly until max steps. Invoked right
   * after `check` returns "deny"; returning undefined/"" keeps the plain
   * denial message. Optional — handlers without it behave as before.
   */
  describeDenial?(call: ToolCall): Promise<string | undefined> | string | undefined;
}