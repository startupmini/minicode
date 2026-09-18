// Tool executor boundary. The kernel ships a sequential strategy; a parallel
// strategy can be added later by implementing the same interface, without
// changing the kernel. Each call runs the same deterministic pipeline:
// resolve → permission → validate → execute → normalize/truncate.

import { validateArgs } from "./tool.ts";
import type { ToolRegistry } from "./tool.ts";
import type { PermissionHandler } from "./permission.ts";
import type { EventBus } from "./events.ts";
import type { SessionState } from "./session.ts";
import type { Execution } from "./session.ts";
import type { ToolCall, ToolResult } from "./types.ts";
import { DEFAULT_CHARS_PER_TOKEN } from "./tokens.ts";
import { abortError } from "./errors.ts";
import { snapshotExecution, snapshotState, snapshotToolCall } from "./snapshot.ts";

export interface ExecutorDeps {
  readonly registry: ToolRegistry;
  readonly permissions: PermissionHandler;
  readonly events: EventBus;
  readonly signal: AbortSignal;
  readonly state: Readonly<SessionState>;
  readonly maxResultTokens: number;
  readonly cwd?: string;
  readonly permissionMode?: string;
}

export interface ToolExecutor {
  execute(calls: readonly ToolCall[], deps: ExecutorDeps): Promise<readonly ToolResult[]>;
}

const errorResult = (call: ToolCall, message: string): ToolResult => ({
  role: "tool",
  toolCallId: call.id,
  name: call.name,
  content: message,
  isError: true,
});

export async function runCall(call: ToolCall, deps: ExecutorDeps): Promise<ToolResult> {
  throwIfAborted(deps.signal);
  const safeCall = snapshotToolCall(call);
  const tool = deps.registry.get(safeCall.name);
  if (!tool) return errorResult(safeCall, `unknown tool: ${safeCall.name}`);

  // The permission handler is user/policy code and may throw. Treat a crash
  // exactly like a tool error: a deterministic error result (observation),
  // never a raw rejection that escapes run() without an error taxonomy.
  let decision: Awaited<ReturnType<PermissionHandler["check"]>>;
  const permissionDeps: ExecutorDeps = { ...deps, state: snapshotState(deps.state) };
  try {
    decision = await deps.permissions.check(snapshotToolCall(safeCall), permissionDeps);
  } catch (error) {
    throwIfAborted(deps.signal);
    return errorResult(safeCall, `permission error: ${error instanceof Error ? error.message : String(error)}`);
  }
  throwIfAborted(deps.signal);
  if (decision === "deny") {
    // Optional handler diagnostic, surfaced so the model observes an
    // actionable reason ("permission denied: <reason>"). Diagnostic-only:
    // describeDenial must never fail the denial itself — hence the guard.
    let suffix = "";
    try {
      const r = await deps.permissions.describeDenial?.(snapshotToolCall(safeCall));
      if (typeof r === "string" && r.trim()) suffix = `: ${r.trim().slice(0, 160)}`;
    } catch {
      /* reason is diagnostic-only; the denial stands */
    }
    return errorResult(safeCall, `permission denied${suffix}`);
  }

  const parsed = validateArgs(tool.parameters, safeCall.args);
  if (!parsed.ok) return errorResult(safeCall, `invalid arguments: ${parsed.message}`);
  throwIfAborted(deps.signal);

  const ctx = {
    signal: deps.signal,
    state: snapshotState(deps.state),
    emit: deps.events.emit,
    cwd: deps.cwd,
    permissionMode: deps.permissionMode,
  };
  // Started and completed events carry separate result objects so listeners
  // that retain the execution reference never observe later mutation.
  const started: Execution = { call: safeCall, result: { role: "tool", toolCallId: safeCall.id, name: safeCall.name, content: "" } };
  deps.events.emit({ type: "execution:started", execution: snapshotExecution(started) });
  let result: ToolResult;
  try {
    const content = await tool.execute(parsed.value, ctx);
    throwIfAborted(deps.signal);
    result = { role: "tool", toolCallId: safeCall.id, name: safeCall.name, content: serializeContent(content, deps.maxResultTokens) };
  } catch (error) {
    throwIfAborted(deps.signal);
    result = {
      role: "tool",
      toolCallId: safeCall.id,
      name: safeCall.name,
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
  deps.events.emit({ type: "execution:completed", execution: snapshotExecution({ call: safeCall, result }) });
  return result;
}

export function sequentialExecutor(): ToolExecutor {
  return {
    async execute(calls, deps) {
      const results: ToolResult[] = [];
      for (const call of calls) {
        throwIfAborted(deps.signal);
        results.push(await runCall(call, deps));
      }
      return results;
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function serializeContent(value: unknown, maxTokens: number): unknown {
  if (value instanceof Uint8Array) return value;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const maxChars = maxTokens * DEFAULT_CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  const headLen = Math.max(0, Math.floor(maxChars * 0.7));
  const tailLen = Math.max(0, maxChars - headLen - 12);
  return `${text.slice(0, headLen)}\n…[truncated]…\n${text.slice(-tailLen)}`;
}
