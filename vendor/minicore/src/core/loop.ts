// The heart of the kernel: one deterministic model → tool → observation loop.

import { AgentError, ProviderError, abortError } from "./errors.ts";
import type { RecoveryAction } from "./errors.ts";
import type { ExecutorDeps } from "./executor.ts";
import type { StreamRequest, FinishReason } from "./provider.ts";
import { snapshotMessages, snapshotState, snapshotStep, snapshotToolCall, snapshotToolResult, snapshotToolSchemas } from "./snapshot.ts";
import { estimateSessionContext } from "./tokens.ts";
import type { ToolSchema } from "./tool.ts";
import type { ToolCall, ToolResult } from "./types.ts";
import type { SessionInternal, Step, TurnResult } from "./session.ts";

/** Resolve mode permission sesi untuk deps turn ini (string langsung atau
 * getter live). Tak pernah melempar — gagal = undefined. */
function resolvePermissionMode(mode: SessionInternal["permissionMode"]): string | undefined {
  try {
    if (typeof mode === "function") {
      const v = (mode as () => unknown)();
      return typeof v === "string" ? v : undefined;
    }
    return mode;
  } catch {
    return undefined;
  }
}

export async function executeTurn(
  s: SessionInternal,
  input: string,
  signal: AbortSignal,
  modelOverride?: string,
): Promise<TurnResult> {
  const turn = s.state.turnCount;
  s.events.emit({ type: "turn:started", turn });
  s.state.turnCount++;

  const store = s.store;
  store.append({ role: "user", content: input });

  const steps: Step[] = [];
  let stepIndex = 0;
  let finalText: string | undefined;
  // Kontrak kompaksi (Phase 6): DUA flag terpisah — budget compaction dan
  // recovery compaction punya semantics berbeda. Flag tunggal dulu mengaburkan
  // keduanya: kompaksi budget membakar satu-satunya retry recovery (padahal
  // recovery belum pernah dicoba), dan sebaliknya. Recovery flag SELALU diset
  // (anti loop abadi: force_compact_and_retry tidak dihitung maxProviderRetries);
  // budget flag diset saat kompaksi budget dicoba (kompaksi per-turn, anti
  // berulang tiap step O(n)).
  let compactedForBudget = false;
  let compactedForRecovery = false;

  while (true) {
    if (signal.aborted) throw abortError(signal);
    if (stepIndex >= s.maxSteps) throw new AgentError("max_steps_exceeded", `exceeded ${s.maxSteps} steps`);

    // Budget policy → compaction strategy (separate concerns, orchestrated here).
    // The budget counts messages plus the fixed per-request cost of the system
    // prompt and tool schemas, which are sent on every request.
    let pressure = s.budget.evaluate({
      usedTokens: contextTokens(s),
      limitTokens: s.contextWindowTokens,
    });
    if (s.budget.shouldCompact(pressure) && !compactedForBudget) {
      const before = s.store.messages.length;
      await compactStore(s, signal);
      compactedForBudget = true;
      // reason membedakan pemicu + apakah kompaksi benar-benar mengurangi
      // (no-op = tidak ada yang bisa dibuang dari messages — operator harus
      // tahu bedanya dari fixed overhead, bukan dari kompaksi sia-sia).
      const reduced = s.store.messages.length < before;
      s.events.emit({
        type: "context:compacted",
        reason: reduced ? `budget:${pressure}` : `budget:${pressure}:no-op`,
      });
      pressure = s.budget.evaluate({
        usedTokens: contextTokens(s),
        limitTokens: s.contextWindowTokens,
      });
    }
    if (pressure === "critical" && compactedForBudget) {
      throw new AgentError("budget_exceeded", "context window exceeded after compaction");
    }

    // Sample from the provider with deterministic recovery.
    const toolCalls: ToolCall[] = [];
    let text = "";
    let reasoning = ""; // DeepSeek-style thinking content
    let attempt = 0;

    while (true) {
      attempt++;
      // Each attempt starts from a clean slate: a failed attempt must not leak
      // its partial text or tool calls into the next one.
      text = "";
      reasoning = "";
      toolCalls.length = 0;
      let action: RecoveryAction | null = null;
      let errorMessage: string | undefined;
      let completed: FinishReason | undefined;
      try {
        for await (const ev of s.provider.stream(buildRequest(s, modelOverride), signal)) {
          if (signal.aborted) throw abortError(signal);
          // Setelah finish: hanya `extension` (mis. usage/reasoning tail dari
          // b.ai dll.) yang diterima — tidak boleh ada text/tool deltas baru,
          // karena itu berarti output protokol rusak dan harus retryable error.
          if (completed !== undefined) {
            if (ev.type === "extension") {
              s.events.emit({ type: "provider:extension", kind: ev.kind, data: ev.data });
              continue;
            }
            throw new ProviderError("network", "provider stream emitted an event after finish");
          }
          switch (ev.type) {
            case "text":
              text += ev.text;
              s.events.emit({ type: "provider:text", text: ev.text });
              break;
            case "extension":
              s.events.emit({ type: "provider:extension", kind: ev.kind, data: ev.data });
              if (ev.kind === "reasoning") reasoning += (ev.data as { text?: string }).text ?? "";
              break;
            case "tool_call":
              toolCalls.push(snapshotToolCall({ id: ev.id, name: ev.name, args: ev.args }));
              break;
            case "finish":
              completed = ev.reason;
              break;
          }
        }
        if (signal.aborted) throw abortError(signal);
        // A well-formed provider stream always ends with a finish event; a
        // clean shutdown without one means the response was cut short, so treat
        // it as a retryable provider error instead of silently accepting
        // partial text or incomplete tool calls.
        if (completed === undefined) {
          throw new ProviderError("network", "stream ended without a finish reason");
        }
        if (completed === "length") {
          errorMessage = "provider output reached length limit";
          // Kontrak (Phase 6): onLength membaca flag RECOVERY — bukan flag
          // budget. Dulu flag tunggal membuat kompaksi budget membakar
          // retry recovery ini.
          action = s.recovery.onLength(compactedForRecovery);
        } else if (completed === "error") {
          action = { type: "throw" };
          errorMessage = "provider finished with error reason";
        } else if (completed === "abort") {
          action = { type: "throw" };
          errorMessage = "provider aborted the stream";
        }
      } catch (error) {
        const cause = toProviderError(error, signal);
        s.events.emit({
          type: "provider:extension",
          kind: "error",
          data: { category: cause.category, message: cause.message },
        });
        errorMessage = cause.message;
        action = s.recovery.onError(cause, attempt);
      }

      if (action === null) break;
      switch (action.type) {
        case "throw":
          throw new AgentError("provider", errorMessage ?? "provider error", { cause: action });
        case "force_compact_and_retry": {
          if (compactedForRecovery)
            throw new AgentError("budget_exceeded", errorMessage ?? "context too large", { cause: action });
          await compactStore(s, signal);
          // Recovery flag SELALU diset (no-op pun): force_compact_and_retry
          // tidak dihitung maxProviderRetries — no-op berulang = loop abadi.
          compactedForRecovery = true;
          s.events.emit({ type: "context:compacted", reason: "recovery" });
          break;
        }
        case "retry":
          await delay(action.delayMs, signal);
          break;
      }
    }

    // Dispatch.
    if (signal.aborted) throw abortError(signal);
    // Reasoning (DeepSeek-style thinking) disimpan di assistant message agar
    // provider thinking-mode bisa menerima history (butuh reasoning_content).
    const reasoningNote = reasoning.length ? { reasoning } : {};
    if (toolCalls.length === 0) {
      store.append({ role: "assistant", content: text, ...reasoningNote });
      finalText = text || undefined;
      break;
    }

    const actionCalls = toolCalls.map(snapshotToolCall);
    store.append({ role: "assistant", content: text, ...reasoningNote, toolCalls: actionCalls.map(snapshotToolCall) });
    const started: Step = { index: stepIndex, toolCalls: actionCalls.map(snapshotToolCall), results: [] };
    s.events.emit({ type: "step:started", step: snapshotStep(started) });

    const deps: ExecutorDeps = {
      registry: s.registry,
      permissions: s.permissions,
      events: s.events,
      signal,
      state: snapshotState(s.state),
      maxResultTokens: s.toolResultMaxTokens,
      cwd: s.cwd,
      // Resolve per turn agar getter live (mis. ganti mode via Shift+Tab)
      // tercermin di ctx tool berikutnya. Gagal resolve = undefined (aman).
      permissionMode: resolvePermissionMode(s.permissionMode),
    };
    let rawResults: readonly ToolResult[];
    try {
      rawResults = await s.executor.execute(actionCalls.map(snapshotToolCall), deps);
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      rawResults = actionCalls.map((call) =>
        toolErrorResult(call, `executor error: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    // The executor can outlive the turn when a tool ignores the abort signal
    // and settles late. Never write those results back into the shared store
    // after the turn has settled — a late result must not leak into the next
    // run's history. (This is the only store mutation reachable across a
    // suspension that can resolve after an abort; the other appends are
    // synchronous relative to their awaits.)
    if (signal.aborted) throw abortError(signal);
    const results = pairToolResults(actionCalls, rawResults);
    store.appendAll(results.map(snapshotToolResult));

    const step: Step = {
      index: stepIndex,
      toolCalls: actionCalls.map(snapshotToolCall),
      results: results.map(snapshotToolResult),
    };
    steps.push(step);
    s.state.stepCount = stepIndex + 1;
    s.events.emit({ type: "step:completed", step: snapshotStep(step) });
    stepIndex++;
  }

  const result: TurnResult = {
    finalText,
    steps,
    usage: { turns: s.state.turnCount, steps: stepIndex },
  };
  s.state.stepCount = stepIndex;
  return result;
}

function buildRequest(s: SessionInternal, modelOverride?: string): StreamRequest {
  const tools: ToolSchema[] = s.registry.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  return {
    messages: snapshotMessages(s.store.messages),
    tools: tools.length ? snapshotToolSchemas(tools) : undefined,
    system: s.system,
    model: modelOverride ?? s.model,
  };
}

function pairToolResults(calls: readonly ToolCall[], results: readonly ToolResult[]): readonly ToolResult[] {
  const byId = new Map<string, ToolResult[]>();
  for (const result of results) {
    const list = byId.get(result.toolCallId) ?? [];
    list.push(result);
    byId.set(result.toolCallId, list);
  }
  return calls.map((call) => {
    const result = byId.get(call.id)?.shift();
    if (!result) return toolErrorResult(call, `executor returned no result for tool call: ${call.id}`);
    if (result.name !== call.name) {
      return toolErrorResult(call, `executor returned result for "${result.name}" but call expected "${call.name}"`);
    }
    return snapshotToolResult(result);
  });
}

function toolErrorResult(call: ToolCall, message: string): ToolResult {
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: message,
    isError: true,
  };
}

function toProviderError(error: unknown, signal: AbortSignal): ProviderError {
  if (signal.aborted) throw abortError(signal);
  if (error instanceof ProviderError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    throw abortError(signal);
  }
  return new ProviderError("unknown", error instanceof Error ? error.message : String(error));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    function cleanup() {
      signal.removeEventListener("abort", onAbort);
    }
  });
}

function contextTokens(s: SessionInternal): number {
  // Kontrak (Phase 6): single source di tokens.ts `estimateSessionContext` —
  // dipakai loop DAN Session getter sehingga tidak ada estimator duplikat.
  return estimateSessionContext(s.store, s.system, s.registry.list(), s.estimator);
}

// The single compaction seam. Prefers the strategy's optional async method
// (LLM summary) and always falls back to the sync strategy on failure — an
// async compactor must never be able to crash the loop.
async function compactStore(s: SessionInternal, signal: AbortSignal): Promise<void> {
  const opts = { keepRecentTurns: s.keepRecentTurns };
  if (s.compaction.compactAsync) {
    try {
      const messages = await s.compaction.compactAsync(s.store, opts, signal);
      s.store.replace(0, s.store.messages.length, messages);
      return;
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      // fall through to sync mechanical compaction
    }
  }
  s.store.replace(0, s.store.messages.length, s.compaction.compact(s.store, opts));
}
