import { expect, test } from "bun:test"
import * as minicore from "#minicore"
import { ProviderError } from "#minicore/core/errors.ts"
import type { ModelProvider } from "#minicore/core/provider.ts"
import { createPresentationAdapter } from "../src/presentation/adapter.ts"
import type { DomainEvent } from "../src/presentation/events.ts"
import { toMachineEnvelope } from "../src/presentation/projection.ts"
import { withStreamGuards } from "../src/providers/guards.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"

test("provider retry invalidates live output while final history and usage stay truthful", async () => {
  const prevTTY = process.stdout.isTTY
  const prevStdoutWrite = process.stdout.write.bind(process.stdout)
  const prevStderrWrite = process.stderr.write.bind(process.stderr)
  const writes: string[] = []
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
  ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (chunk: string) => {
    writes.push(`stdout:${chunk}`)
    return true
  }
  ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (chunk: string) => {
    writes.push(`stderr:${chunk}`)
    return true
  }

  let calls = 0
  const provider: ModelProvider = {
    id: "retry-test",
    models: ["retry-test"],
    async *stream() {
      calls++
      if (calls === 1) {
        yield { type: "extension", kind: "usage", data: { inputTokens: 11, outputTokens: 2 } }
        yield { type: "text", text: "PARTIAL\n" }
        throw new ProviderError("network", "simulated disconnect")
      }
      yield { type: "extension", kind: "usage", data: { inputTokens: 13, outputTokens: 1 } }
      yield { type: "text", text: "FINAL\n" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const session = minicore.createSession({
    provider: withStreamGuards(provider, { timeoutMs: 5_000 }),
    permissions: { check: async () => "allow" as const },
    contextWindowTokens: 30_000,
    recovery: {
      onError: () => ({ type: "retry", delayMs: 0 }),
      onLength: () => ({ type: "throw" }),
    },
  })
  const adapter = createPresentationAdapter(session.events, { sessionId: "retry-session" })
  const domainEvents: DomainEvent[] = []
  const unsubscribePresentation = adapter.onEvent((event) => domainEvents.push(event))
  const transcript = new Transcript(session.events as never, {
    onPresentationEvent: (handler) => adapter.onEvent(handler as never),
  })
  const uiState = new UiSessionState()
  const detachLogger = attachSimpleLogger(session.events as never, { uiState })
  const usageEvents: { inputTokens?: number; outputTokens?: number }[] = []
  const unsubscribeUsage = session.events.on("provider:extension", (event) => {
    const value = event as { kind?: unknown; data?: unknown }
    if (value.kind === "usage")
      usageEvents.push(value.data as { inputTokens?: number; outputTokens?: number })
  })

  try {
    const result = await session.run("retry once", {})
    expect(calls).toBe(2)
    expect(result.finalText).toBe("FINAL\n")
    expect(JSON.stringify(session.state.history)).toContain("FINAL")
    expect(JSON.stringify(session.state.history)).not.toContain("PARTIAL")

    const rendered = transcript.view(100, 10, 0).join("\n")
    expect(rendered).toContain("FINAL")
    expect(rendered).toContain("attempt 1")
    expect(rendered).not.toContain("PARTIAL")
    expect(uiState.getLastTurnText()).toContain("FINAL")
    expect(uiState.getLastTurnText()).not.toContain("PARTIAL")

    const deltas = domainEvents.filter((event) => event.type === "model.delta")
    expect(
      deltas
        .filter((event) => event.attemptId === 1)
        .map((event) => event.delta)
        .join(""),
    ).toBe("PARTIAL\n")
    expect(
      deltas
        .filter((event) => event.attemptId === 2)
        .map((event) => event.delta)
        .join(""),
    ).toBe("FINAL\n")
    const invalidation = domainEvents.find((event) => event.type === "diagnostic.raised")
    expect(invalidation).toMatchObject({
      category: "PROVIDER_ATTEMPT_INVALIDATED",
      attemptId: 1,
    })
    expect(
      invalidation &&
        toMachineEnvelope(invalidation, { sessionId: "retry-session", timestamp: 1 })?.payload,
    ).toMatchObject({ attemptId: 1 })
    expect(domainEvents.find((event) => event.type === "model.completed")).toMatchObject({
      text: "FINAL\n",
    })

    expect(usageEvents).toEqual([
      { inputTokens: 11, outputTokens: 2 },
      { inputTokens: 13, outputTokens: 1 },
    ])
    const combinedWrites = writes.join("")
    expect(combinedWrites.indexOf("PARTIAL")).toBeLessThan(
      combinedWrites.indexOf("partial output above is excluded"),
    )
    expect(combinedWrites.indexOf("partial output above is excluded")).toBeLessThan(
      combinedWrites.indexOf("FINAL"),
    )
  } finally {
    unsubscribeUsage()
    detachLogger()
    transcript.dispose()
    unsubscribePresentation()
    adapter.dispose()
    ;(process.stdout as unknown as { write: typeof process.stdout.write }).write = prevStdoutWrite
    ;(process.stderr as unknown as { write: typeof process.stderr.write }).write = prevStderrWrite
    if (prevTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY
    else Object.defineProperty(process.stdout, "isTTY", { value: prevTTY, configurable: true })
  }
})
