// Defensive snapshots for crossing host/provider/observer boundaries. The
// kernel keeps mutable buffers internally, but external adapters, tools,
// executors, and event listeners must not receive references that can corrupt
// runtime state or alter in-flight actions.

import type { Execution, SessionState, Step, TurnResult } from "./session.ts";
import type { ToolSchema } from "./tool.ts";
import type { AssistantMessage, Content, ContentPart, Message, ToolCall, ToolResult } from "./types.ts";

export function snapshotMessages(messages: readonly Message[]): Message[] {
  return messages.map(snapshotMessage);
}

function snapshotMessage(message: Message): Message {
  switch (message.role) {
    case "user":
      return { role: "user", content: snapshotContent(message.content) };
    case "assistant":
      return snapshotAssistant(message);
    case "tool":
      return snapshotToolResult(message);
  }
}

export function snapshotToolCall(call: ToolCall): ToolCall {
  return {
    id: call.id,
    name: call.name,
    args: snapshotValue(call.args),
  };
}

export function snapshotToolResult(result: ToolResult): ToolResult {
  const out: ToolResult = {
    role: "tool",
    toolCallId: result.toolCallId,
    name: result.name,
    content: snapshotValue(result.content),
  };
  return result.isError === undefined ? out : { ...out, isError: result.isError };
}

export function snapshotToolSchemas(tools: readonly ToolSchema[]): ToolSchema[] {
  return tools.map((toolSchema) => ({
    name: toolSchema.name,
    description: toolSchema.description,
    parameters: snapshotValue(toolSchema.parameters),
  }));
}

export function snapshotState(state: Readonly<SessionState>): SessionState {
  return {
    history: snapshotMessages(state.history),
    turnCount: state.turnCount,
    stepCount: state.stepCount,
    model: state.model,
  };
}

export function snapshotExecution(execution: Execution): Execution {
  return {
    call: snapshotToolCall(execution.call),
    result: snapshotToolResult(execution.result),
  };
}

export function snapshotStep(step: Step): Step {
  return {
    index: step.index,
    toolCalls: step.toolCalls.map(snapshotToolCall),
    results: step.results.map(snapshotToolResult),
  };
}

export function snapshotTurnResult(result: TurnResult): TurnResult {
  return {
    finalText: result.finalText,
    steps: result.steps.map(snapshotStep),
    usage: { turns: result.usage.turns, steps: result.usage.steps },
  };
}

function snapshotAssistant(message: AssistantMessage): AssistantMessage {
  const base: AssistantMessage = {
    role: "assistant",
    content: snapshotContent(message.content),
  };
  const withReasoning = message.reasoning === undefined ? base : { ...base, reasoning: message.reasoning };
  return message.toolCalls === undefined
    ? withReasoning
    : { ...withReasoning, toolCalls: message.toolCalls.map(snapshotToolCall) };
}

function snapshotContent(content: Content): Content {
  if (typeof content === "string") return content;
  return content.map(snapshotContentPart);
}

function snapshotContentPart(part: ContentPart): ContentPart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return { type: "image", mime: part.mime, data: part.data.slice() };
  }
}

function snapshotValue<T>(value: T): T {
  if (value instanceof Uint8Array) return value.slice() as T;
  try {
    return structuredClone(value);
  } catch {
    return clonePlainValue(value) as T;
  }
}

function clonePlainValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  if (value instanceof Uint8Array) return value.slice();
  if (typeof value === "function") return value;
  const existing = seen.get(value);
  if (existing) return existing;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(clonePlainValue(item, seen));
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  // Known limitation (documented): non-plain objects (Date, RegExp, class
  // instances, …) are returned AS-IS — the same reference crosses the
  // boundary. Plain objects/arrays/binary are deep-copied; exotic types are
  // kept so cloning never corrupts them, at the cost of shared identity.
  if (proto !== Object.prototype && proto !== null) return value;
  const out = Object.create(proto) as Record<string, unknown>;
  seen.set(value, out);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(out, key, {
      value: clonePlainValue(child, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
