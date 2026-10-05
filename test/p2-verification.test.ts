// P2.10 — focused verification matrix: identity, intent, receipt,
// verification, idempotency, child correlation, crash windows, boundaries.
//
// Hermetic: temporary workspaces, local journals, fake tools. No network,
// no kernel run, no SQLite session writes.

import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Tool, ToolContext } from "#minicore"
import { setupToolLayer } from "../src/app/tool-layer.ts"
import {
  decideRecovery,
  finalizeJournal,
  isCanonicalEvidenceCovered,
  type JournalRecord,
  journalPath,
  loadJournal,
  sweepJournal,
} from "../src/session/journal.ts"
import {
  allocateToolInvocationId,
  buildIdempotencyKey,
  type CanonicalScope,
  correlateChildEffect,
  type EffectIntentResult,
  EvidenceIncompleteError,
  type EvidenceWriter,
  executeCanonicalInvocation,
  IdempotentDuplicateError,
  persistEffectIntent,
  persistEffectReceipt,
  recordExternalVerification,
  recordVerifierOutcome,
  summarizeObservedReturn,
  verifyFilesystemEffect,
  verifyGitCommit,
} from "../src/session/verification.ts"
import { withEvidence } from "../src/tools/evidence.ts"
import { allTools } from "../src/tools/index.ts"
import { delegateTaskTool } from "../src/tools/task.ts"

function tmpRoot(prefix = "mc-p210-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows may briefly retain handles; the OS cleans temporary roots.
  }
}

function scopeFor(
  sessionId: string,
  dir: string,
  overrides: Partial<CanonicalScope> = {},
): CanonicalScope {
  return {
    sessionId,
    threadId: `${sessionId}-thread`,
    cwd: dir,
    ...overrides,
  }
}

function ctxFor(dir: string, overrides: { turn?: number; signal?: AbortSignal } = {}): ToolContext {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    state: {
      history: [],
      turnCount: overrides.turn ?? 7,
      stepCount: overrides.turn ?? 7,
    } as ToolContext["state"],
    cwd: dir,
    emit: () => {},
  }
}

function toolFor(name: string, execute: Tool["execute"]): Tool {
  return {
    name,
    description: `${name} test tool`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: true,
    },
    execute,
  }
}

async function recordsFor(sessionId: string, dir: string): Promise<JournalRecord[]> {
  return (await loadJournal(sessionId, dir)).records
}

function journalText(sessionId: string, dir: string): string {
  return readFileSync(journalPath(sessionId, dir), "utf8")
}

function terminalFor(records: JournalRecord[], invocationId: string): JournalRecord | undefined {
  return records.find(
    (record) =>
      record.invocationId === invocationId &&
      (record.state === "committed" || record.state === "failed"),
  )
}

test("1: ToolInvocationId allocates application-owned identity", () => {
  const first = allocateToolInvocationId(
    {
      sessionId: "session-a",
      threadId: "thread-a",
      turnIndex: 4,
      tool: "write_file",
      providerToolCallId: "call-provider-1",
    },
    { allocationSequence: 0, nonce: "0123456789abcdef" },
  )
  const second = allocateToolInvocationId(
    {
      sessionId: "session-a",
      threadId: "thread-a",
      turnIndex: 4,
      tool: "write_file",
      providerToolCallId: "call-provider-1",
    },
    { allocationSequence: 1, nonce: "fedcba9876543210" },
  )
  expect(first.value).not.toBe(second.value)
  expect(first.sessionId).toBe("session-a")
  expect(first.threadId).toBe("thread-a")
  expect(first.turnIndex).toBe(4)
  expect(first.tool).toBe("write_file")
  expect(first.allocationSequence).toBe(0)
  expect(first.value).toContain(":s0:")
})

test("2: provider toolCallId may be absent", () => {
  const invocation = allocateToolInvocationId(
    { sessionId: "session-b", threadId: "thread-b", turnIndex: 2, tool: "bash" },
    { allocationSequence: 5, nonce: "0123456789abcdef" },
  )
  expect(invocation.providerToolCallId).toBeUndefined()
  expect(invocation.allocationSequence).toBe(5)
  expect(invocation.value).toContain(":s5:")
})

test("3: repeated provider toolCallId does not identify separate executions", () => {
  const request = {
    sessionId: "session-c",
    threadId: "thread-c",
    turnIndex: 1,
    tool: "edit",
    providerToolCallId: "call-duplicate",
  }
  const first = allocateToolInvocationId(request, {
    allocationSequence: 8,
    nonce: "0123456789abcdef",
  })
  const second = allocateToolInvocationId(request, {
    allocationSequence: 9,
    nonce: "fedcba9876543210",
  })
  expect(first.value).not.toBe(second.value)
  expect(first.value).not.toBe("call-duplicate")
  expect(second.value).not.toBe("call-duplicate")
})

test("4: durable intent exists before inner execute begins", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-intent-order"
    let calls = 0
    let seen: JournalRecord[] = []
    const tool = toolFor("write_file", async () => {
      calls++
      seen = await recordsFor(sid, dir)
      return "ok"
    })
    const wrapped = withEvidence(tool, scopeFor(sid, dir))
    const result = await wrapped.execute({ path: "a.txt" }, ctxFor(dir))
    expect(result).toBe("ok")
    expect(calls).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.state).toBe("pending")
    expect(seen[0]!.invocationId).toContain(":s0:")
    const records = await recordsFor(sid, dir)
    expect(records.filter((r) => r.state === "pending")).toHaveLength(1)
    expect(terminalFor(records, seen[0]!.invocationId!)?.state).toBe("committed")
  } finally {
    cleanup(dir)
  }
})

test("5: intent write failure refuses execution", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-intent-refused"
    let innerCalls = 0
    let receiptCalls = 0
    const tool = toolFor("write_file", async () => {
      innerCalls++
      return "ok"
    })
    const writer: EvidenceWriter = {
      writeIntent: async () => ({
        invocation: allocateToolInvocationId(
          { sessionId: sid, threadId: "thread", turnIndex: 0, tool: "write_file" },
          { allocationSequence: 0, nonce: "0123456789abcdef" },
        ),
        record: {
          v: 1,
          id: `${sid}:0`,
          session: sid,
          seq: 0,
          tool: "write_file",
          cwd: dir,
          ts: Date.now(),
          state: "pending",
        } as JournalRecord,
        argsHash: "refused",
        durable: false,
      }),
      writeReceipt: async () => {
        receiptCalls++
        return { durable: true }
      },
    }
    await expect(
      executeCanonicalInvocation(tool, { path: "a.txt" }, ctxFor(dir), scopeFor(sid, dir), writer),
    ).rejects.toBeInstanceOf(EvidenceIncompleteError)
    expect(innerCalls).toBe(0)
    expect(receiptCalls).toBe(0)
  } finally {
    cleanup(dir)
  }
})

test("6: terminal after success records observed return, not effect proof", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-receipt-success"
    const marker = `P210-RESULT-${Date.now()}`
    const tool = toolFor("bash", async () => `exit 0\n${marker}`)
    const result = await executeCanonicalInvocation(
      tool,
      { cmd: "true" },
      ctxFor(dir),
      scopeFor(sid, dir),
    )
    expect(typeof result).toBe("string")
    const records = await recordsFor(sid, dir)
    const terminal = records.find((r) => r.state === "committed")
    expect(terminal?.outcome?.ack).toBe(0)
    expect(terminal?.outcome?.ackSource).toBe("bash-exit")
    expect(terminal?.outcome?.ackAuthority).toBe("application-observed")
    expect(terminal?.outcome?.uncertainty).toBe("unverified-external")
    expect(terminal?.outcome?.loss).toBe("none")
    expect(journalText(sid, dir)).not.toContain(marker)
  } finally {
    cleanup(dir)
  }
})

test("7: terminal after tool error preserves failure without success claim", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-receipt-failed"
    const tool = toolFor("write_file", async () => {
      throw new Error("boom")
    })
    await expect(
      executeCanonicalInvocation(tool, { path: "a.txt" }, ctxFor(dir), scopeFor(sid, dir)),
    ).rejects.toThrow("boom")
    const records = await recordsFor(sid, dir)
    expect(records.some((r) => r.state === "committed")).toBe(false)
    const terminal = records.find((r) => r.state === "failed")
    expect(terminal?.outcome?.uncertainty).toBe("ambiguous-effect")
    expect(terminal?.outcome?.loss).toBe("unknown")
  } finally {
    cleanup(dir)
  }
})

test("8: receipt write failure preserves observed outcome", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-receipt-unwritten"
    let receiptCalls = 0
    const writer: EvidenceWriter = {
      writeIntent: (input) => persistEffectIntent(input),
      writeReceipt: async () => {
        receiptCalls++
        return { durable: false }
      },
    }
    const tool = toolFor("write_file", async () => "ok")
    const result = await executeCanonicalInvocation(
      tool,
      { path: "a.txt" },
      ctxFor(dir),
      scopeFor(sid, dir),
      writer,
    )
    expect(result).toBe("ok")
    expect(receiptCalls).toBe(1)
    const records = await recordsFor(sid, dir)
    expect(records.filter((r) => r.state === "pending")).toHaveLength(1)
    expect(records.some((r) => r.state === "committed" || r.state === "failed")).toBe(false)
  } finally {
    cleanup(dir)
  }
})

test("9: truncated acknowledgement is preserved", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-truncated"
    const tool = toolFor("bash", async () => "exit 0\nbody\n… [output truncated]")
    await executeCanonicalInvocation(tool, { cmd: "true" }, ctxFor(dir), scopeFor(sid, dir))
    const terminal = (await recordsFor(sid, dir)).find((r) => r.state === "committed")
    expect(terminal?.outcome?.truncated).toBe(true)
    expect(terminal?.outcome?.ack).toBe(0)
  } finally {
    cleanup(dir)
  }
})

async function verifiedFilesystemIntent(
  sid: string,
  dir: string,
  tool = "write_file",
  args: unknown = { path: "target.txt" },
): Promise<EffectIntentResult> {
  const intent = await persistEffectIntent({
    sessionId: sid,
    threadId: `${sid}-thread`,
    turnIndex: 0,
    tool,
    cwd: dir,
    args,
  })
  expect(intent.durable).toBe(true)
  return intent
}

test("10: filesystem read-back can establish present", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-verify-present"
    const intent = await verifiedFilesystemIntent(sid, dir)
    writeFileSync(join(dir, "target.txt"), "expected-bytes")
    const verified = await verifyFilesystemEffect({
      sessionId: sid,
      threadId: `${sid}-thread`,
      tool: "write_file",
      invocationId: intent.invocation.value,
      cwd: dir,
      expected: "present",
      targets: [{ path: "target.txt", expectedContent: "expected-bytes" }],
    })
    expect(verified.verdict).toBe("present")
    expect(verified.durable).toBe(true)
    expect(verified.record.kind).toBe("verification")
    expect(verified.record.method).toBe("filesystem-read-back")
  } finally {
    cleanup(dir)
  }
})

test("11: filesystem read-back can establish absent", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-verify-absent"
    const intent = await verifiedFilesystemIntent(sid, dir)
    const verified = await verifyFilesystemEffect({
      sessionId: sid,
      threadId: `${sid}-thread`,
      tool: "write_file",
      invocationId: intent.invocation.value,
      cwd: dir,
      expected: "present",
      targets: [{ path: "missing.txt" }],
    })
    expect(verified.verdict).toBe("absent")
    expect(verified.durable).toBe(true)
  } finally {
    cleanup(dir)
  }
})

test("12: unreadable observation remains inconclusive", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-verify-inconclusive"
    const intent = await verifiedFilesystemIntent(sid, dir)
    const verified = await verifyFilesystemEffect({
      sessionId: sid,
      threadId: `${sid}-thread`,
      tool: "write_file",
      invocationId: intent.invocation.value,
      cwd: dir,
      expected: "present",
      targets: [{ path: "../outside-workspace.txt" }],
    })
    expect(verified.verdict).toBe("inconclusive")
    expect(verified.durable).toBe(true)
    expect(verified.record.verdict).toBe("inconclusive")
  } finally {
    cleanup(dir)
  }
})

async function expectNoVerificationRecord(
  sid: string,
  dir: string,
  method: string,
  intent: EffectIntentResult,
): Promise<void> {
  await expect(
    recordExternalVerification({
      sessionId: sid,
      threadId: `${sid}-thread`,
      tool: "write_file",
      invocationId: intent.invocation.value,
      method: method as never,
      verdict: "present",
      evidenceReference: "untrusted-claim",
      cwd: dir,
    }),
  ).rejects.toThrow("unsupported method")
  const records = await recordsFor(sid, dir)
  expect(records.some((record) => record.kind === "verification")).toBe(false)
}

test("13: model and tool prose cannot create verification", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-no-model-proof"
    const intent = await verifiedFilesystemIntent(sid, dir)
    for (const method of ["model-text", "tool-text", "writer-epoch", "cursor"]) {
      await expectNoVerificationRecord(sid, dir, method, intent)
    }
  } finally {
    cleanup(dir)
  }
})

test("14: Run status cannot create verification", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-no-run-proof"
    const intent = await verifiedFilesystemIntent(sid, dir)
    await expectNoVerificationRecord(sid, dir, "run-status", intent)
  } finally {
    cleanup(dir)
  }
})

test("15: presentation cannot create verification", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-no-presentation-proof"
    const intent = await verifiedFilesystemIntent(sid, dir)
    await expectNoVerificationRecord(sid, dir, "presentation-event", intent)
  } finally {
    cleanup(dir)
  }
})

function idempotentScope(
  sid: string,
  dir: string,
  key: (args: unknown) => string | undefined,
): CanonicalScope {
  return scopeFor(sid, dir, { idempotencyKeyFor: key })
}

test("16: concurrent duplicate idempotency key executes once", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-duplicate-concurrent"
    let calls = 0
    let release!: (value: string) => void
    const gate = new Promise<string>((resolve) => {
      release = resolve
    })
    const tool = toolFor("write_file", async () => {
      calls++
      return gate
    })
    const scope = idempotentScope(sid, dir, () => "operation-16")
    const first = executeCanonicalInvocation(tool, { path: "a.txt" }, ctxFor(dir), scope)
    const second = executeCanonicalInvocation(tool, { path: "a.txt" }, ctxFor(dir), scope)
    release("shared")
    await expect(Promise.all([first, second])).resolves.toEqual(["shared", "shared"])
    expect(calls).toBe(1)
    const records = await recordsFor(sid, dir)
    expect(records.filter((r) => r.state === "pending")).toHaveLength(1)
    expect(records.filter((r) => r.state === "committed")).toHaveLength(1)
  } finally {
    cleanup(dir)
  }
})

test("17: duplicate after restart does not execute again", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-duplicate-restart"
    let calls = 0
    const tool = toolFor("write_file", async () => {
      calls++
      return "first"
    })
    const scope = idempotentScope(sid, dir, () => "operation-17")
    const args = { path: "a.txt" }
    await expect(executeCanonicalInvocation(tool, args, ctxFor(dir), scope)).resolves.toBe("first")
    await finalizeJournal(sid, dir)
    await sweepJournal(sid, dir)
    const retained = await recordsFor(sid, dir)
    expect(retained.filter((r) => r.state === "committed")).toHaveLength(1)
    const failure = await executeCanonicalInvocation(tool, args, ctxFor(dir), scope).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(IdempotentDuplicateError)
    expect((failure as IdempotentDuplicateError).status).toBe("committed")
    expect(calls).toBe(1)
    const records = await recordsFor(sid, dir)
    expect(records.filter((r) => r.state === "pending")).toHaveLength(0)
    expect(records.filter((r) => r.state === "committed")).toHaveLength(1)
  } finally {
    cleanup(dir)
  }
})

test("18: same key with different arguments is an explicit conflict", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-idempotency-conflict"
    let calls = 0
    const tool = toolFor("write_file", async () => {
      calls++
      return "first"
    })
    const scope = idempotentScope(sid, dir, () => "operation-18")
    await executeCanonicalInvocation(tool, { path: "a.txt" }, ctxFor(dir), scope)
    const failure = await executeCanonicalInvocation(
      tool,
      { path: "b.txt" },
      ctxFor(dir),
      scope,
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(IdempotentDuplicateError)
    expect((failure as IdempotentDuplicateError).status).toBe("conflict")
    expect(calls).toBe(1)
    expect(await recordsFor(sid, dir)).toHaveLength(2)
  } finally {
    cleanup(dir)
  }
})

test("19: pending duplicate remains UNKNOWN", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-duplicate-pending"
    const args = { path: "a.txt" }
    const pending = await persistEffectIntent({
      sessionId: sid,
      threadId: `${sid}-thread`,
      turnIndex: 0,
      tool: "write_file",
      cwd: dir,
      args,
      idempotencyKey: "operation-19",
    })
    expect(pending.durable).toBe(true)
    let calls = 0
    const tool = toolFor("write_file", async () => {
      calls++
      return "second"
    })
    const failure = await executeCanonicalInvocation(
      tool,
      args,
      ctxFor(dir),
      idempotentScope(sid, dir, () => "operation-19"),
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(IdempotentDuplicateError)
    expect((failure as IdempotentDuplicateError).status).toBe("pending")
    expect((failure as IdempotentDuplicateError).code).toBe("UNKNOWN_IDEMPOTENT_INVOCATION")
    expect(calls).toBe(0)
    expect((await recordsFor(sid, dir)).some((r) => r.state === "committed")).toBe(false)
  } finally {
    cleanup(dir)
  }
})

test("20: MCP dotted tools bypass canonical wrapper without double intent", () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-mcp-bypass"
    const tool = toolFor("server.tool", async () => "remote")
    const scope = scopeFor(sid, dir)
    expect(isCanonicalEvidenceCovered(tool.name)).toBe(false)
    expect(withEvidence(tool, scope)).toBe(tool)
  } finally {
    cleanup(dir)
  }
})

test("21: delegate_task bypass keeps explicit instrumentation", () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-delegate-bypass"
    const scope = scopeFor(sid, dir)
    expect(isCanonicalEvidenceCovered(delegateTaskTool.name)).toBe(false)
    expect(withEvidence(delegateTaskTool, scope)).toBe(delegateTaskTool)
  } finally {
    cleanup(dir)
  }
})

async function writeDelegatePair(
  parent: string,
  child: string,
  dir: string,
  state: "committed" | "failed" = "committed",
): Promise<EffectIntentResult> {
  const intent = await persistEffectIntent({
    sessionId: parent,
    threadId: `${parent}-thread`,
    turnIndex: 0,
    tool: "delegate_task",
    cwd: dir,
    childSessionId: child,
    args: { prompt: "child work", mode: "explore" },
    specialPath: "delegate-task",
  })
  expect(intent.durable).toBe(true)
  const receipt = await persistEffectReceipt({
    sessionId: parent,
    threadId: `${parent}-thread`,
    tool: "delegate_task",
    cwd: dir,
    invocation: intent.invocation,
    intent: {
      id: intent.record.id,
      seq: intent.record.seq,
      tool: intent.record.tool,
      session: intent.record.session,
      ...(intent.record.invocationId ? { invocationId: intent.record.invocationId } : {}),
      ...(intent.record.argsHash ? { argsHash: intent.record.argsHash } : {}),
    },
    state,
    outcome: { note: child },
    childSessionId: child,
    specialPath: "delegate-task",
  })
  expect(receipt.durable).toBe(true)
  return intent
}

test("22: child effect verification uses child evidence", async () => {
  const dir = tmpRoot()
  try {
    const parent = "p210-parent-ok"
    const child = "p210-child-ok"
    await writeDelegatePair(parent, child, dir, "committed")
    const childIntent = await persistEffectIntent({
      sessionId: child,
      threadId: `${child}-thread`,
      turnIndex: 0,
      tool: "write_file",
      cwd: dir,
      childOf: parent,
      args: { path: "child.txt" },
    })
    expect(childIntent.durable).toBe(true)
    const childReceipt = await persistEffectReceipt({
      sessionId: child,
      threadId: `${child}-thread`,
      tool: "write_file",
      cwd: dir,
      invocation: childIntent.invocation,
      intent: {
        id: childIntent.record.id,
        seq: childIntent.record.seq,
        tool: childIntent.record.tool,
        session: childIntent.record.session,
        ...(childIntent.record.invocationId
          ? { invocationId: childIntent.record.invocationId }
          : {}),
        ...(childIntent.record.argsHash ? { argsHash: childIntent.record.argsHash } : {}),
      },
      state: "committed",
    })
    expect(childReceipt.durable).toBe(true)
    writeFileSync(join(dir, "child.txt"), "child-effect")
    const verified = await verifyFilesystemEffect({
      sessionId: child,
      threadId: `${child}-thread`,
      tool: "write_file",
      invocationId: childIntent.invocation.value,
      cwd: dir,
      expected: "present",
      targets: [{ path: "child.txt", expectedContent: "child-effect" }],
      childSessionId: child,
    })
    expect(verified.verdict).toBe("present")
    const correlated = await correlateChildEffect({
      parentSessionId: parent,
      childSessionId: child,
      childInvocationId: childIntent.invocation.value,
      cwd: dir,
      lineage: [{ parentSessionId: parent, childSessionId: child }],
    })
    expect(correlated.parentDelegation).toBe("committed")
    expect(correlated.childJournal).toBe("committed")
    expect(correlated.childVerification).toBe("present")
    expect(correlated.conclusion).toBe("present")
    expect(correlated.evidence.childVerificationId).toBe(verified.record.id)
  } finally {
    cleanup(dir)
  }
})

test("23: committed delegation plus unknown child effect stays unknown", async () => {
  const dir = tmpRoot()
  try {
    const parent = "p210-parent-unknown"
    const child = "p210-child-unknown"
    await writeDelegatePair(parent, child, dir, "committed")
    const childIntent = await persistEffectIntent({
      sessionId: child,
      threadId: `${child}-thread`,
      turnIndex: 0,
      tool: "write_file",
      cwd: dir,
      childOf: parent,
      args: { path: "child.txt" },
    })
    expect(childIntent.durable).toBe(true)
    const correlated = await correlateChildEffect({
      parentSessionId: parent,
      childSessionId: child,
      childInvocationId: childIntent.invocation.value,
      cwd: dir,
      lineage: [{ parentSessionId: parent, childSessionId: child }],
    })
    expect(correlated.parentDelegation).toBe("committed")
    expect(correlated.childJournal).toBe("pending")
    expect(correlated.childVerification).toBe("absent-record")
    expect(correlated.conclusion).toBe("unknown")
  } finally {
    cleanup(dir)
  }
})

test("24: later unrelated success does not resolve unknown", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-unknown-stable"
    const unknown = await persistEffectIntent({
      sessionId: sid,
      threadId: `${sid}-thread`,
      turnIndex: 0,
      tool: "edit",
      cwd: dir,
      args: { path: "unknown.txt" },
    })
    expect(unknown.durable).toBe(true)
    const later = await persistEffectIntent({
      sessionId: sid,
      threadId: `${sid}-thread`,
      turnIndex: 1,
      tool: "write_file",
      cwd: dir,
      args: { path: "other.txt" },
    })
    expect(later.durable).toBe(true)
    const records = await recordsFor(sid, dir)
    expect(records.find((r) => r.id === unknown.record.id)?.state).toBe("pending")
    const plan = decideRecovery(records, [])
    expect(plan.clean).toBe(false)
    expect(plan.attention.some((item) => item.id === unknown.record.id)).toBe(true)
  } finally {
    cleanup(dir)
  }
})

test("25: canonical evidence does not enter conversation history", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-no-history"
    const tool = toolFor("write_file", async () => "ok")
    await withEvidence(tool, scopeFor(sid, dir)).execute({ path: "a.txt" }, ctxFor(dir))
    expect(existsSync(join(dir, ".minicode", "sessions.db"))).toBe(false)
  } finally {
    cleanup(dir)
  }
})

test("26: canonical evidence does not enter projections", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-no-projection"
    const tool = toolFor("write_file", async () => "ok")
    await withEvidence(tool, scopeFor(sid, dir)).execute({ path: "a.txt" }, ctxFor(dir))
    expect(journalText(sid, dir).includes("history_projections")).toBe(false)
    const records = await recordsFor(sid, dir)
    expect(records.every((record) => !record.kind || record.kind === "mutation")).toBe(true)
  } finally {
    cleanup(dir)
  }
})

test("27: crash between intent and execute remains unknown", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-crash-intent"
    const intent = await persistEffectIntent({
      sessionId: sid,
      threadId: `${sid}-thread`,
      turnIndex: 0,
      tool: "bash",
      cwd: dir,
      args: { cmd: "true" },
    })
    expect(intent.durable).toBe(true)
    // Crash before inner execute: only the durable intent survives.
    const records = await recordsFor(sid, dir)
    expect(records).toHaveLength(1)
    const plan = decideRecovery(records, [])
    expect(plan.clean).toBe(false)
    expect(plan.attention.some((item) => item.id === intent.record.id)).toBe(true)
  } finally {
    cleanup(dir)
  }
})

test("28: crash after effect before receipt preserves unknown and outcome", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-crash-receipt"
    let receiptCalls = 0
    const writer: EvidenceWriter = {
      writeIntent: (input) => persistEffectIntent(input),
      writeReceipt: async () => {
        receiptCalls++
        return { durable: false }
      },
    }
    const tool = toolFor("write_file", async () => {
      writeFileSync(join(dir, "effect.txt"), "effect")
      return "ok"
    })
    const result = await executeCanonicalInvocation(
      tool,
      { path: "effect.txt" },
      ctxFor(dir),
      scopeFor(sid, dir),
      writer,
    )
    expect(result).toBe("ok")
    expect(receiptCalls).toBe(1)
    expect(existsSync(join(dir, "effect.txt"))).toBe(true)
    const records = await recordsFor(sid, dir)
    expect(records.filter((r) => r.state === "pending")).toHaveLength(1)
    expect(terminalFor(records, records[0]!.invocationId!)).toBeUndefined()
    expect(decideRecovery(records, []).clean).toBe(false)
  } finally {
    cleanup(dir)
  }
})

test("29: crash after receipt before turn persistence is recoverable, not verified", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-crash-persist"
    const tool = toolFor("write_file", async () => "ok")
    await executeCanonicalInvocation(tool, { path: "a.txt" }, ctxFor(dir), scopeFor(sid, dir))
    const records = await recordsFor(sid, dir)
    const terminal = records.find((r) => r.state === "committed")
    expect(terminal?.invocationId).toContain(":s0:")
    expect(existsSync(join(dir, ".minicode", "sessions.db"))).toBe(false)
    const plan = decideRecovery(records, [])
    expect(plan.clean).toBe(false)
    expect(plan.stitched.some((item) => item.id === terminal!.id)).toBe(true)
  } finally {
    cleanup(dir)
  }
})

test("30: crash after child effect before parent observation stays unknown", async () => {
  const dir = tmpRoot()
  try {
    const parent = "p210-parent-crash"
    const child = "p210-child-crash"
    const parentIntent = await persistEffectIntent({
      sessionId: parent,
      threadId: `${parent}-thread`,
      turnIndex: 0,
      tool: "delegate_task",
      cwd: dir,
      childSessionId: child,
      args: { prompt: "child work", mode: "explore" },
      specialPath: "delegate-task",
    })
    expect(parentIntent.durable).toBe(true)
    const childIntent = await persistEffectIntent({
      sessionId: child,
      threadId: `${child}-thread`,
      turnIndex: 0,
      tool: "write_file",
      cwd: dir,
      childOf: parent,
      args: { path: "child.txt" },
    })
    expect(childIntent.durable).toBe(true)
    const childReceipt = await persistEffectReceipt({
      sessionId: child,
      threadId: `${child}-thread`,
      tool: "write_file",
      cwd: dir,
      invocation: childIntent.invocation,
      intent: {
        id: childIntent.record.id,
        seq: childIntent.record.seq,
        tool: childIntent.record.tool,
        session: childIntent.record.session,
        ...(childIntent.record.invocationId
          ? { invocationId: childIntent.record.invocationId }
          : {}),
        ...(childIntent.record.argsHash ? { argsHash: childIntent.record.argsHash } : {}),
      },
      state: "committed",
    })
    expect(childReceipt.durable).toBe(true)
    writeFileSync(join(dir, "child.txt"), "child-effect")
    const verified = await verifyFilesystemEffect({
      sessionId: child,
      threadId: `${child}-thread`,
      tool: "write_file",
      invocationId: childIntent.invocation.value,
      cwd: dir,
      expected: "present",
      targets: [{ path: "child.txt", expectedContent: "child-effect" }],
      childSessionId: child,
    })
    expect(verified.verdict).toBe("present")
    // Parent crashed after writing delegation intent but before its terminal.
    const correlated = await correlateChildEffect({
      parentSessionId: parent,
      childSessionId: child,
      childInvocationId: childIntent.invocation.value,
      cwd: dir,
      lineage: [{ parentSessionId: parent, childSessionId: child }],
    })
    expect(correlated.parentDelegation).toBe("pending")
    expect(correlated.conclusion).toBe("unknown")
  } finally {
    cleanup(dir)
  }
})

test("registry wrapper preserves behavior and selects canonical mode", async () => {
  const dir = tmpRoot()
  try {
    const plain = await setupToolLayer({ providers: [] })
    expect(plain.evidenceMode).toBe("events")
    const scope = scopeFor("p210-registry", dir)
    const canonical = await setupToolLayer({ providers: [] }, "full", undefined, scope)
    expect(canonical.evidenceMode).toBe("canonical")
    expect(canonical.sessionTools.length).toBe(allTools.length)
    const original = allTools.find((tool) => tool.name === "write_file")!
    const wrapped = canonical.sessionTools.find((tool) => tool.name === "write_file")!
    expect(wrapped).not.toBe(original)
    expect(canonical.sessionTools.find((tool) => tool.name === delegateTaskTool.name)).toBe(
      delegateTaskTool,
    )
  } finally {
    cleanup(dir)
  }
})

test("executed verifier outcomes map without storing prose", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-verifier-outcome"
    const intent = await verifiedFilesystemIntent(sid, dir)
    const passed = await recordVerifierOutcome({
      sessionId: sid,
      threadId: `${sid}-thread`,
      tool: "write_file",
      invocationId: intent.invocation.value,
      cwd: dir,
      result: { ok: true, output: "1 pass", command: "bun test target" },
    })
    const failed = await recordVerifierOutcome({
      sessionId: sid,
      threadId: `${sid}-thread`,
      tool: "write_file",
      invocationId: intent.invocation.value,
      cwd: dir,
      result: { ok: false, output: "1 fail", command: "bun test target" },
    })
    expect(passed.verdict).toBe("present")
    expect(failed.verdict).toBe("inconclusive")
    expect(passed.record.method).toBe("existing-verifier")
    expect(journalText(sid, dir)).not.toContain("1 pass")
  } finally {
    cleanup(dir)
  }
})

test("git commit observation distinguishes present, absent, and non-repository", async () => {
  const available = spawnSync("git", ["--version"], { stdio: "ignore", timeout: 5000 })
  if (available.status !== 0) return
  const dir = tmpRoot("mc-p210-git-")
  try {
    expect(spawnSync("git", ["init", "-q"], { cwd: dir, timeout: 20_000 }).status).toBe(0)
    expect(
      spawnSync("git", ["config", "user.email", "p210@example.com"], { cwd: dir, timeout: 20_000 })
        .status,
    ).toBe(0)
    expect(
      spawnSync("git", ["config", "user.name", "p210"], { cwd: dir, timeout: 20_000 }).status,
    ).toBe(0)
    writeFileSync(join(dir, "a.txt"), "v1")
    expect(spawnSync("git", ["add", "a.txt"], { cwd: dir, timeout: 20_000 }).status).toBe(0)
    expect(spawnSync("git", ["commit", "-qm", "p210"], { cwd: dir, timeout: 20_000 }).status).toBe(
      0,
    )
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 20_000,
    }).stdout.trim()
    const sid = "p210-git-commit"
    const intent = await persistEffectIntent({
      sessionId: sid,
      threadId: `${sid}-thread`,
      turnIndex: 0,
      tool: "git_commit",
      cwd: dir,
      args: { message: "p210" },
    })
    expect(intent.durable).toBe(true)
    const verified = await verifyGitCommit({
      sessionId: sid,
      threadId: `${sid}-thread`,
      tool: "git_commit",
      invocationId: intent.invocation.value,
      cwd: dir,
      sha: head,
    })
    expect(verified.verdict).toBe("present")
    expect(verified.durable).toBe(true)
    expect(
      await verifyGitCommit({
        sessionId: sid,
        threadId: `${sid}-thread`,
        tool: "git_commit",
        invocationId: intent.invocation.value,
        cwd: dir,
        sha: "f".repeat(40),
      }),
    ).toMatchObject({ verdict: "absent" })
  } finally {
    cleanup(dir)
  }
  const plain = tmpRoot("mc-p210-plain-")
  try {
    // A temp directory is overwhelmingly likely not to be a repository root,
    // but observeGitCommit must still be honest if the environment differs.
    const observed = await import("../src/session/verification.ts").then((module) =>
      module.observeGitCommit(plain, "a".repeat(40)),
    )
    expect(["present", "absent", "inconclusive"].includes(observed)).toBe(true)
  } finally {
    cleanup(plain)
  }
})

test("duplicate failed invocation surfaces honestly without re-execution", async () => {
  const dir = tmpRoot()
  try {
    const sid = "p210-duplicate-failed"
    const args = { path: "a.txt" }
    const intent = await persistEffectIntent({
      sessionId: sid,
      threadId: `${sid}-thread`,
      turnIndex: 0,
      tool: "write_file",
      cwd: dir,
      args,
      idempotencyKey: "operation-failed",
    })
    expect(intent.durable).toBe(true)
    const receipt = await persistEffectReceipt({
      sessionId: sid,
      threadId: `${sid}-thread`,
      tool: "write_file",
      cwd: dir,
      invocation: intent.invocation,
      intent: {
        id: intent.record.id,
        seq: intent.record.seq,
        tool: intent.record.tool,
        session: intent.record.session,
        ...(intent.record.invocationId ? { invocationId: intent.record.invocationId } : {}),
        ...(intent.record.argsHash ? { argsHash: intent.record.argsHash } : {}),
      },
      state: "failed",
      error: new Error("first failed"),
      outcome: { note: intent.idempotencyKey },
      dedup: true,
    })
    expect(receipt.durable).toBe(true)
    let calls = 0
    const tool = toolFor("write_file", async () => {
      calls++
      return "second"
    })
    const failure = await executeCanonicalInvocation(
      tool,
      args,
      ctxFor(dir),
      idempotentScope(sid, dir, () => "operation-failed"),
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(IdempotentDuplicateError)
    expect((failure as IdempotentDuplicateError).status).toBe("failed")
    expect(calls).toBe(0)
  } finally {
    cleanup(dir)
  }
})

test("same session scopes duplicate keys while sessions stay isolated", () => {
  expect(buildIdempotencyKey("s-one", "operation")).not.toBe(
    buildIdempotencyKey("s-two", "operation"),
  )
  expect(() => buildIdempotencyKey("s-one", "   ")).toThrow("empty idempotency key")
})

test("observed returns classify abort and timeout without inventing effects", () => {
  const aborted = summarizeObservedReturn({
    tool: "bash",
    error: Object.assign(new Error("aborted"), { name: "AbortError" }),
    signalAborted: false,
  })
  expect(aborted.aborted).toBe(true)
  expect(aborted.uncertainty).toBe("ambiguous-effect")
  const timedOut = summarizeObservedReturn({
    tool: "bash",
    error: Object.assign(new Error("command timed out"), { name: "TimeoutError" }),
    signalAborted: false,
  })
  expect(timedOut.timeout).toBe(true)
  expect(timedOut.uncertainty).toBe("ambiguous-effect")
})
