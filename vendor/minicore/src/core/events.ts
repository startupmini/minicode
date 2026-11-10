// Typed event bus for observability and lifecycles.

import type { Execution, Step, TurnResult } from "./session.ts";

export type AgentEvent =
  | { type: "turn:started"; turn: number }
  | { type: "turn:completed"; result: TurnResult }
  | { type: "turn:interrupted" }
  | { type: "step:started"; step: Step }
  | { type: "step:completed"; step: Step }
  | { type: "execution:started"; execution: Execution }
  | { type: "execution:completed"; execution: Execution }
  | { type: "provider:text"; text: string }
  | { type: "provider:extension"; kind: string; data: unknown }
  | { type: "context:compacted"; reason: string };

export type AgentEventType = AgentEvent["type"];

export interface EventBus {
  on<const T extends AgentEventType | "*">(
    type: T,
    handler: T extends "*" ? (event: AgentEvent) => void : (event: Extract<AgentEvent, { type: T }>) => void,
  ): () => void;
  emit(event: AgentEvent): void;
}

export interface EventBusOptions {
  /**
   * Reports errors thrown by event listeners. Observers must never be able to
   * break the agent: emit catches every handler, reports the failure here, and
   * continues with the remaining listeners. Defaults to console.error.
   */
  onHandlerError?: (error: unknown, event: AgentEvent) => void;
}

export function createEventBus(options?: EventBusOptions): EventBus {
  const handlers = new Map<string, Set<(event: AgentEvent) => void>>();
  const report =
    options?.onHandlerError ??
    ((error: unknown, event: AgentEvent) => {
      console.error(`event handler for "${event.type}" failed`, error);
    });
  return {
    on(type, handler) {
      const wrapped = handler as (event: AgentEvent) => void;
      const set = handlers.get(type) ?? new Set<(event: AgentEvent) => void>();
      set.add(wrapped);
      handlers.set(type, set);
      return () => {
        set.delete(wrapped);
      };
    },
    emit(event) {
      // Per-handler isolation: a crashing observer (UI, logging, metrics) must
      // neither kill the turn nor escape into surrounding try/catches (which
      // used to turn listener crashes into spurious retries). The error is
      // reported and the remaining listeners still run.
      const run = (handler: (event: AgentEvent) => void) => {
        try {
          handler(event);
        } catch (error) {
          try {
            report(error, event);
          } catch {
            // The reporter itself must not be able to break the emit.
          }
        }
      };
      const set = handlers.get(event.type);
      if (set) for (const handler of set) run(handler);
      const all = handlers.get("*");
      if (all) for (const handler of all) run(handler);
    },
  };
}