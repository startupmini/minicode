// Tool abstraction: declarative schemas + deterministic argument validation.

import type { AgentEvent } from "./events.ts";
import type { SessionState } from "./session.ts";

export interface JSONSchema {
  readonly type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly required?: readonly string[];
  readonly items?: JSONSchema;
  readonly enum?: readonly unknown[];
  readonly additionalProperties?: boolean;
}

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;
}

export interface ToolContext {
  readonly signal: AbortSignal;
  readonly state: Readonly<SessionState>;
  readonly cwd?: string;
  /**
   * Session permission mode at dispatch time (e.g. "auto" | "plan").
   * Optional for backward compatibility; tools that adapt to read-only
   * sessions read this instead of guessing from prompt text. Resolved per
   * turn from SessionConfig (plain string or live getter).
   */
  readonly permissionMode?: string;
  emit(event: AgentEvent): void;
}

export interface Tool<P = unknown> extends ToolSchema {
  execute(input: P, ctx: ToolContext): Promise<unknown>;
}

export type ArgsResult<A = unknown> = { ok: true; value: A } | { ok: false; message: string };

const error = (message: string): { ok: false; message: string } => ({ ok: false, message });

// Assignment via `out[key] = value` would treat "__proto__" as a setter and
// swap the result object's prototype (prototype pollution). defineProperty
// always creates an own property instead.
function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Deterministically validate `args` against a JSON schema (kernel built-in). */
export function validateArgs<A = unknown>(schema: JSONSchema, args: unknown): ArgsResult<A> {
  if (schema.properties || schema.type === "object") {
    if (typeof args !== "object" || args === null || Array.isArray(args)) return error("expected an object");
    const record = args as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of schema.required ?? []) {
      if (!(key in record)) return error(`missing required property: ${key}`);
    }
    for (const [key, value] of Object.entries(record)) {
      const sub = schema.properties?.[key];
      if (sub) {
        const result = validateArgs(sub, value);
        if (!result.ok) return error(`${key}: ${result.message}`);
        setOwn(out, key, result.value);
      } else if (schema.additionalProperties === false) {
        return error(`unknown property: ${key}`);
      } else {
        setOwn(out, key, value);
      }
    }
    return { ok: true, value: out as A };
  }
  if (schema.enum) {
    if (!schema.enum.some((v) => Object.is(v, args))) return error("value not allowed");
    return { ok: true, value: args as A };
  }
  switch (schema.type) {
    case "string":
      return typeof args === "string" ? { ok: true, value: args as A } : error("expected string");
    case "number":
      return typeof args === "number" && Number.isFinite(args) ? { ok: true, value: args as A } : error("expected number");
    case "integer":
      return typeof args === "number" && Number.isInteger(args) ? { ok: true, value: args as A } : error("expected integer");
    case "boolean":
      return typeof args === "boolean" ? { ok: true, value: args as A } : error("expected boolean");
    case "null":
      return args === null ? { ok: true, value: args as A } : error("expected null");
    case "array": {
      if (!Array.isArray(args)) return error("expected an array");
      if (!schema.items) return { ok: true, value: args as A };
      const out: unknown[] = [];
      for (const item of args) {
        const result = validateArgs(schema.items, item);
        if (!result.ok) return error(result.message);
        out.push(result.value);
      }
      return { ok: true, value: out as A };
    }
    default:
      return { ok: true, value: args as A };
  }
}

export interface ToolRegistry {
  get(name: string): Tool | undefined;
  list(): readonly Tool[];
}

export function createToolRegistry(tools: readonly Tool[]): ToolRegistry {
  const map = new Map<string, Tool>(tools.map((tool) => [tool.name, tool]));
  return {
    get: (name) => map.get(name),
    list: () => tools,
  };
}