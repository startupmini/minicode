// Fase 1 Presentasi V2.1 — penjaga bahwa adaptor semantik benar-benar
// merekonstruksi lifecycle yang HILANG di runtime kernel:
//   · deny tidak pernah meng-emit execution:* (executor.ts:44-73 return awal)
//   · abort/timeout/budget diam total (session.ts hanya sukses → turn:completed)
//   · approval hanya callback — tidak ada event bus approval
//   · finalText finalText dibuang UI (hanya di TurnResult)
//
// Setiap test di sini MEMBUTUHKAN adapter — tanpa adapter (kode lama) tidak ada
// stream DomainEvent sama sekali, jadi assertion "event X terbit" otomatis
// gagal. Hermetic: fake bus lokal, tanpa TTY/jaringan/API key.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createPermissionHandler } from "../src/policy/permission.ts"
import {
  createPresentationAdapter,
  findingsFromSubmitResult,
  parseQualifiedName,
} from "../src/presentation/adapter.ts"
import type { ApprovalHookEvent, DomainEvent, EventBusLike } from "../src/presentation/events.ts"
import { askUserTool, setAskApprovalHook, setAskTextFn } from "../src/tools/ask_user.ts"

// ── Fake bus mirip EventBus kernel (on/emit per-type, unsubscribe fungsi) ──

function fakeBus(): EventBusLike & {
  emit: (type: string, payload: unknown) => void
} {
  const handlers = new Map<string, Set<(e: any) => void>>()
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set<(e: any) => void>()
      set.add(handler)
      handlers.set(type, set)
      return () => set.delete(handler)
    },
    emit(type, payload) {
      const set = handlers.get(type)
      if (set) for (const h of [...set]) h(payload)
    },
  }
}

function collect(adapter: ReturnType<typeof createPresentationAdapter>): DomainEvent[] {
  const out: DomainEvent[] = []
  adapter.onEvent((e) => out.push(e))
  return out
}

const TTY_SAVED = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY }

beforeEach(() => {
  setAskTextFn(undefined)
  setAskApprovalHook(undefined)
})

afterEach(() => {
  setAskTextFn(undefined)
  setAskApprovalHook(undefined)
  Object.defineProperty(process.stdin, "isTTY", {
    value: TTY_SAVED.stdin,
    configurable: true,
  })
  Object.defineProperty(process.stdout, "isTTY", {
    value: TTY_SAVED.stdout,
    configurable: true,
  })
})

function setTty(stdin: boolean, stdout = stdin): void {
  Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true })
  Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true })
}

// ── Kosakata ──

test("parseQualifiedName: builtin tanpa titik, MCP ber-namespace", () => {
  expect(parseQualifiedName("read_file")).toEqual({
    origin: "builtin",
    name: "read_file",
    qualified: "read_file",
  })
  expect(parseQualifiedName("srv.search")).toEqual({
    origin: "mcp",
    namespace: "srv",
    name: "search",
    qualified: "srv.search",
  })
  // String kosong ≠ null/undefined: default "tool" hanya untuk nullish —
  // kontrak parse SEKALI, renderer menerima apa adanya.
  expect(parseQualifiedName("")).toEqual({ origin: "builtin", name: "", qualified: "" })
})

test("noteUserMessage menerbitkan user.message semantic dengan turnId eksplisit", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  a.noteUserMessage({ text: "perbaiki parser", promptRef: "prompt-1", turnId: 7 })
  const event = events.find((e) => e.type === "user.message")
  expect(event?.type === "user.message" && event.text).toBe("perbaiki parser")
  expect(event?.type === "user.message" && event.turnId).toBe(7)
  expect(event?.type === "user.message" && event.promptRef).toBe("prompt-1")
  expect(a.getDiagnostics().userMessages).toBe(1)
  a.dispose()
})

// ── Lifecycle tool ──

test("execution:started/completed → tool.started/completed (durasi ≥ 0)", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  bus.emit("execution:started", {
    execution: { call: { id: "c1", name: "read_file", args: { path: "a.txt" } }, result: {} },
  })
  bus.emit("execution:completed", {
    execution: {
      call: { id: "c1", name: "read_file", args: { path: "a.txt" } },
      result: { isError: false, content: "isi" },
    },
  })
  const started = events.find((e) => e.type === "tool.started")
  const completed = events.find((e) => e.type === "tool.completed")
  expect(started?.type === "tool.started" && started.toolCallId).toBe("c1")
  expect(started?.type === "tool.started" && started.identity.origin).toBe("builtin")
  expect(completed?.type === "tool.completed" && completed.durationMs).toBeGreaterThanOrEqual(0)
  expect(completed?.type === "tool.completed" && completed.expandRef.toolCallId).toBe("c1")
  a.dispose()
})

test("deny TANPA execution event (kasus keranjang executor) → tool.denied dari step.results", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  bus.emit("step:completed", {
    step: {
      results: [
        {
          toolCallId: "d1",
          name: "write_file",
          isError: true,
          content: "permission denied: jail: outside workspace",
        },
      ],
    },
  })
  const denied = events.filter((e) => e.type === "tool.denied")
  expect(denied).toHaveLength(1)
  expect(denied[0]!.type === "tool.denied" && denied[0]!.toolCallId).toBe("d1")
  expect(a.getDiagnostics().deniedReconstructed).toBe(1)
  // Ganda terminal pada id sama = anomali, event kedua TIDAK terbit.
  bus.emit("step:completed", {
    step: {
      results: [
        {
          toolCallId: "d1",
          name: "write_file",
          isError: true,
          content: "permission denied: jail",
        },
      ],
    },
  })
  expect(events.filter((e) => e.type === "tool.denied")).toHaveLength(1)
  a.dispose()
})

test("execution error yang lolos gate → tool.failed (bukan denied)", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  bus.emit("execution:started", {
    execution: { call: { id: "f1", name: "bash", args: { cmd: "false" } }, result: {} },
  })
  bus.emit("execution:completed", {
    execution: {
      call: { id: "f1", name: "bash", args: { cmd: "false" } },
      result: { isError: true, content: "exit code 1" },
    },
  })
  const failed = events.find((e) => e.type === "tool.failed")
  expect(failed?.type === "tool.failed" && failed.cause).toBe("exec")
  expect(events.some((e) => e.type === "tool.denied")).toBe(false)
  a.dispose()
})

test("pairToolResults sintetis: error + pernah started → tool.failed; tanpa started = anomali", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  // Kasus 1: started ada → sintetis harus menutup lifecycle.
  bus.emit("execution:started", {
    execution: { call: { id: "y1", name: "bash", args: { cmd: "x" } }, result: {} },
  })
  bus.emit("step:completed", {
    step: {
      results: [{ toolCallId: "y1", name: "bash", isError: true, content: "boom" }],
    },
  })
  expect(events.some((e) => e.type === "tool.failed" && e.toolCallId === "y1")).toBe(true)
  // Kasus 2: tanpa started (adapter dipasang telat) → jangan mengarang event.
  bus.emit("step:completed", {
    step: {
      results: [{ toolCallId: "late", name: "bash", isError: true, content: "boom" }],
    },
  })
  expect(events.some((e) => "toolCallId" in e && e.toolCallId === "late")).toBe(false)
  expect(a.getDiagnostics().anomalies).toBeGreaterThanOrEqual(1)
  a.dispose()
})

// ── Turn ──

test("turn:started + turn:completed → turn.* + model.completed(finalText)", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  bus.emit("turn:started", { turn: 3 })
  bus.emit("turn:completed", { result: { finalText: "jawaban final" } })
  expect(
    events.some((e) => e.type === "turn.started" && e.turnId === 3 && e.promptRef === "turn:3"),
  ).toBe(true)
  expect(events.some((e) => e.type === "model.completed" && e.text === "jawaban final")).toBe(true)
  expect(events.some((e) => e.type === "turn.completed")).toBe(true)
  a.dispose()
})

test("result generic tidak menyalin finalText besar", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  const finalText = `ringkasan\n${"x".repeat(100_000)}`
  bus.emit("turn:started", { turn: 1 })
  bus.emit("turn:completed", { result: { finalText } })
  const result = events.find((event) => event.type === "result.produced")
  expect(result?.type === "result.produced" && result.summary).toBe("ringkasan")
  expect(result?.type === "result.produced" && result.summary.length).toBeLessThanOrEqual(200)
  a.dispose()
})

test("turn summary memakai provider canonical dan checkpoint evidence", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  a.setTurnSummaryProvider(({ turnId, fallback }) => ({
    ...fallback,
    filesChanged: 2,
    checkpointId: `cp-${turnId}`,
  }))
  bus.emit("turn:started", { turn: 3 })
  a.noteFileChanged({ toolCallId: "w1", paths: ["a.ts"], turnId: 3 })
  a.noteCheckpoint({ checkpointId: "cp-3", turnId: 3 })
  bus.emit("turn:completed", { result: { finalText: "done" } })
  const completed = events.find((event) => event.type === "turn.completed")
  expect(completed?.type === "turn.completed" && completed.summary.filesChanged).toBe(2)
  expect(completed?.type === "turn.completed" && completed.summary.checkpointId).toBe("cp-3")
  expect(events.some((event) => event.type === "checkpoint.created")).toBe(true)
  a.dispose()
})

test("noteTestCompleted menerbitkan evidence test terstruktur", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  a.noteTestCompleted({ toolCallId: "t1", passed: 2, failed: 0, summary: "2 pass" })
  expect(events.find((event) => event.type === "test.completed")).toMatchObject({
    toolCallId: "t1",
    passed: 2,
    failed: 0,
  })
  a.dispose()
})

test("noteRunSettled: parent-aborted → turn.cancelled(user) + cascade tool/approval", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  bus.emit("execution:started", {
    execution: { call: { id: "open", name: "bash", args: { cmd: "sleep 99" } }, result: {} },
  })
  a.publishApproval({
    kind: "requested",
    approvalId: "ap_x",
    call: { name: "write_file", args: {} },
    via: "prompt",
  })
  a.noteRunSettled(new Error("aborted"), { aborted: false, parentAborted: true })
  const cancelled = events.filter((e) => e.type === "turn.cancelled")
  expect(cancelled).toHaveLength(1)
  expect(cancelled[0]!.type === "turn.cancelled" && cancelled[0]!.reason).toBe("user")
  expect(events.some((e) => e.type === "tool.cancelled" && e.reason === "parent-aborted")).toBe(
    true,
  )
  expect(
    events.some(
      (e) =>
        e.type === "approval.settled" &&
        e.approvalId === "ap_x" &&
        e.outcome.decision === "cancelled",
    ),
  ).toBe(true)
  a.dispose()
})

test("noteRunSettled: kind timeout / budget_exceeded / agent error", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const cases: Array<{
    err: unknown
    info: { aborted: boolean; parentAborted: boolean }
    expectCancelled?: string
    expectFailedCause?: string
  }> = [
    {
      err: Object.assign(new Error("timeout"), { kind: "timeout" }),
      info: { aborted: false, parentAborted: false },
      expectCancelled: "timeout",
    },
    {
      err: Object.assign(new Error("budget"), { kind: "budget_exceeded" }),
      info: { aborted: false, parentAborted: false },
      expectCancelled: "budget",
    },
    {
      err: new Error("provider exploded"),
      info: { aborted: false, parentAborted: false },
      expectFailedCause: "agent",
    },
  ]
  for (const c of cases) {
    const events = collect(a)
    a.noteRunSettled(c.err, c.info)
    if (c.expectCancelled) {
      const t = events.find((e) => e.type === "turn.cancelled")
      expect(t?.type === "turn.cancelled" && t.reason).toBe(c.expectCancelled as never)
    } else {
      const f = events.find((e) => e.type === "turn.failed")
      expect(f?.type === "turn.failed" && f.error.cause).toBe(c.expectFailedCause as never)
    }
    // Reset: event berikutnya start dari kosong — collect() menambah handler baru;
    // handler lama tetap hidup tapi array lokal segar, aman.
  }
  a.dispose()
})

// ── Model / reasoning / kompaksi ──

test("provider:text → model.delta; provider:extension reasoning → reasoning.delta", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  bus.emit("provider:text", { text: "halo" })
  bus.emit("provider:extension", { kind: "usage", data: { inputTokens: 1 } })
  bus.emit("provider:extension", { kind: "reasoning", data: { text: "pikir" } })
  expect(events.some((e) => e.type === "model.delta" && e.delta === "halo")).toBe(true)
  expect(events.some((e) => e.type === "reasoning.delta" && e.delta === "pikir")).toBe(true)
  expect(events.some((e) => e.type === "model.delta" && e.delta === "")).toBe(false)
  a.dispose()
})

test("reasoning delta dipromosikan menjadi completed dan result final", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  bus.emit("turn:started", { turn: 1 })
  bus.emit("provider:extension", { kind: "reasoning", data: { text: "think" } })
  bus.emit("turn:completed", { result: { finalText: "answer" } })
  expect(events.find((event) => event.type === "reasoning.completed")).toMatchObject({
    truncated: false,
    expandRef: { kind: "reasoning" },
  })
  expect(events.find((event) => event.type === "result.produced")).toMatchObject({
    status: "completed",
    summary: "answer",
  })
  a.dispose()
})

test("submit_result memancarkan result semantic dari tool sukses", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  bus.emit("execution:started", {
    execution: { call: { id: "submit1", name: "submit_result", args: { summary: "done" } } },
  })
  bus.emit("execution:completed", {
    execution: {
      call: { id: "submit1", name: "submit_result", args: { summary: "done" } },
      result: { isError: false, content: "submitted" },
    },
  })
  expect(events.find((event) => event.type === "result.produced")).toMatchObject({
    resultId: "submit:submit1",
    summary: "done",
  })
  a.dispose()
})

test("submit_result dengan findings eksplisit memancarkan finding.detected", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  const args = {
    summary: "done",
    result: {
      status: "ok",
      findings: [
        {
          category: "security",
          severity: "warning",
          summary: "Hardcoded credential",
          evidence: ["src/a.ts", 42, ""],
        },
        { category: "", severity: "warning", summary: "tanpa kategori" },
        { category: "security", severity: "unknown", summary: "severity tak valid" },
      ],
    },
  }
  bus.emit("execution:started", {
    execution: { call: { id: "submit2", name: "submit_result", args } },
  })
  bus.emit("execution:completed", {
    execution: {
      call: { id: "submit2", name: "submit_result", args },
      result: { isError: false, content: "submitted" },
    },
  })
  const findings = events.filter((event) => event.type === "finding.detected")
  expect(findings).toHaveLength(1)
  expect(findings[0]).toMatchObject({
    findingId: "finding:submit2:1",
    category: "security",
    severity: "warning",
    summary: "Hardcoded credential",
    evidence: ["src/a.ts"],
  })
  expect(
    findingsFromSubmitResult(
      {
        result: {
          findings: Array.from({ length: 7 }, (_, i) => ({
            category: "c",
            severity: "info",
            summary: `s${i}`,
          })),
        },
      },
      "submit3",
    ),
  ).toHaveLength(5)
  expect(
    findingsFromSubmitResult(
      {
        result: {
          findings: [{ category: "c", severity: "info", summary: "s", evidence: "e" }],
        },
      },
      "submit4",
    )[0]?.evidence,
  ).toEqual(["e"])
  a.dispose()
})

test("todo_write memancarkan plan.updated SETELAH tool sukses", () => {
  // Kontrak berubah: plan event dulu terbit di `execution:started` dari argumen
  // mentah, sehingga `status:"completed"` bisa tertahan durable meski
  // `saveTodos` gagal. Sekarang terbit di `execution:completed`, dan statusnya
  // diturunkan dari normalizer yang sama dengan file todo.
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  const call = {
    id: "todo1",
    name: "todo_write",
    args: {
      todos: [
        { content: "Inspect", status: "in_progress" },
        { content: "Ship", status: "pending" },
      ],
    },
  }
  bus.emit("execution:started", { execution: { call } })
  // Belum selesai → belum ada klaim apa pun ke durable log.
  expect(events.find((event) => event.type === "plan.updated")).toBeUndefined()
  bus.emit("execution:completed", { execution: { call, result: { content: "ok" } } })
  expect(events.find((event) => event.type === "plan.updated")).toMatchObject({
    status: "open",
    steps: [
      { stepId: "1", status: "active" },
      { stepId: "2", status: "pending" },
    ],
  })
  a.dispose()
})

test("provider extension error menjadi diagnostic semantic", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  bus.emit("provider:extension", { kind: "error", data: { message: "rate limited" } })
  expect(events.find((event) => event.type === "diagnostic.raised")).toMatchObject({
    category: "PROVIDER_ERROR",
    severity: "error",
    message: "rate limited",
  })
  a.dispose()
})

test("context:compacted → context.compacted dengan reason", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  bus.emit("context:compacted", { reason: "recovery" })
  expect(events.some((e) => e.type === "context.compacted" && e.reason === "recovery")).toBe(true)
  a.dispose()
})

// ── Approval (hook DI, 6 jalur) ──

test("publishApproval: requested → settled 6 outcome", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  // 1 allow
  a.publishApproval({
    kind: "requested",
    approvalId: "a1",
    call: { id: "c", name: "git_commit", args: {} },
    via: "prompt",
  })
  a.publishApproval({
    kind: "settled",
    approvalId: "a1",
    call: { id: "c", name: "git_commit", args: {} },
    outcome: { decision: "allow", by: "user" },
  })
  // 2 allow-always
  a.publishApproval({
    kind: "requested",
    approvalId: "a2",
    call: { name: "bash", args: {} },
    via: "prompt",
  })
  a.publishApproval({
    kind: "settled",
    approvalId: "a2",
    call: { name: "bash", args: {} },
    outcome: { decision: "allow-always", by: "user" },
  })
  // 3 deny user
  a.publishApproval({
    kind: "requested",
    approvalId: "a3",
    call: { name: "delete_file", args: {} },
    via: "prompt",
  })
  a.publishApproval({
    kind: "settled",
    approvalId: "a3",
    call: { name: "delete_file", args: {} },
    outcome: { decision: "deny", by: "user", reason: "declined" },
  })
  // 4 deny system headless
  a.publishApproval({
    kind: "requested",
    approvalId: "a4",
    call: { name: "mcp_call", args: {} },
    via: "system",
  })
  a.publishApproval({
    kind: "settled",
    approvalId: "a4",
    call: { name: "mcp_call", args: {} },
    outcome: { decision: "deny", by: "system", reason: "headless" },
  })
  // 5 cancelled parent-aborted
  a.publishApproval({
    kind: "requested",
    approvalId: "a5",
    call: { name: "bash", args: {} },
    via: "prompt",
  })
  a.publishApproval({
    kind: "settled",
    approvalId: "a5",
    call: { name: "bash", args: {} },
    outcome: { decision: "cancelled", by: "system", reason: "parent-aborted" },
  })
  // 6 allow system (auto path)
  a.publishApproval({
    kind: "requested",
    approvalId: "a6",
    call: { name: "read_file", args: {} },
    via: "system",
  })
  a.publishApproval({
    kind: "settled",
    approvalId: "a6",
    call: { name: "read_file", args: {} },
    outcome: { decision: "allow", by: "system" },
  })

  const requested = events.filter((e) => e.type === "approval.requested")
  const settled = events.filter((e) => e.type === "approval.settled")
  expect(requested).toHaveLength(6)
  expect(settled).toHaveLength(6)
  const decisions = settled.map((e) => (e.type === "approval.settled" ? e.outcome.decision : ""))
  expect(decisions).toEqual(["allow", "allow-always", "deny", "deny", "cancelled", "allow"])
  // eventSeq naik monoton di seluruh approval (requested/settled berselang).
  const seqs = events.map((e) => e.eventSeq)
  expect(seqs).toHaveLength(12)
  expect(seqs).toEqual([...Array(12)].map((_, i) => i + 1))
  a.dispose()
})

// ── Integrasi permission handler (DI onApprovalEvent) ──

test("permission: tanpa allowlist match TIDAK emit approval (deny policy, bukan prompt)", async () => {
  const events: ApprovalHookEvent[] = []
  // Env dibaca SAAT createPermissionHandler — set dulu, baru bikin handler.
  const saved = process.env.MINICODE_BASH_ALLOWLIST
  process.env.MINICODE_BASH_ALLOWLIST = "never-match-zzz"
  try {
    const h = createPermissionHandler({
      mode: "allowlist",
      root: process.cwd(),
      allowLocalConfig: false,
      onApprovalEvent: (e) => events.push(e),
    })
    // bash di allowlist mode TANPA match pattern → deny langsung tanpa prompt
    // (keputusan policy, bukan persetujuan user — bedakan dari gated prompt).
    const decision = await h.check(
      { id: "c1", name: "bash", args: { cmd: "rm -rf /tmp/x" } } as never,
      {} as never,
    )
    expect(decision).toBe("deny")
    expect(events).toHaveLength(0)
  } finally {
    if (saved === undefined) delete process.env.MINICODE_BASH_ALLOWLIST
    else process.env.MINICODE_BASH_ALLOWLIST = saved
  }
})

test("permission: headless gated (tanpa TTY) → requested+settled(deny system), keputusan deny utuh", async () => {
  setTty(false)
  const events: ApprovalHookEvent[] = []
  const askCalls: string[] = []
  const h = createPermissionHandler({
    mode: "ask",
    root: process.cwd(),
    ask: async (call) => {
      askCalls.push(call.name)
      return "allow"
    },
    onApprovalEvent: (e) => events.push(e),
  })
  // git_commit = GATED → promptAskOr (bukan read_file yang auto-allow).
  const decision = await h.check(
    { id: "g1", name: "git_commit", args: { message: "m" } } as never,
    {} as never,
  )
  expect(decision).toBe("deny")
  expect(askCalls).toEqual([]) // headless tidak boleh memanggil view
  expect(events.map((e) => e.kind)).toEqual(["requested", "settled"])
  const settled = events[1]
  expect(
    settled?.kind === "settled" && settled.outcome.decision === "deny" && settled.outcome.by,
  ).toBe("system")
})

test("permission: prompt TTY allow → requested+settled(allow user), keputusan allow", async () => {
  setTty(true)
  const events: ApprovalHookEvent[] = []
  const h = createPermissionHandler({
    mode: "ask",
    root: process.cwd(),
    ask: async () => "allow",
    onApprovalEvent: (e) => events.push(e),
  })
  const decision = await h.check(
    { id: "g2", name: "git_commit", args: { message: "m" } } as never,
    {} as never,
  )
  expect(decision).toBe("allow")
  expect(events.map((e) => e.kind)).toEqual(["requested", "settled"])
  const settled = events[1]
  expect(settled?.kind === "settled" && settled.outcome).toEqual({ decision: "allow", by: "user" })
})

test("permission: prompt TTY deny → outcome deny by user (alasan tetap declined by user)", async () => {
  setTty(true)
  const events: ApprovalHookEvent[] = []
  const h = createPermissionHandler({
    mode: "ask",
    root: process.cwd(),
    ask: async () => "deny",
    onApprovalEvent: (e) => events.push(e),
  })
  const decision = await h.check(
    { id: "g3", name: "git_commit", args: { message: "m" } } as never,
    {} as never,
  )
  expect(decision).toBe("deny")
  const settled = events[1]
  expect(settled?.kind === "settled" && settled.outcome.decision).toBe("deny")
})

test("permission: hook yang melempar TIDAK menggagalkan gate (observability isolation)", async () => {
  setTty(true)
  const h = createPermissionHandler({
    mode: "ask",
    root: process.cwd(),
    ask: async () => "allow",
    onApprovalEvent: () => {
      throw new Error("observer boom")
    },
  })
  const decision = await h.check(
    { id: "g4", name: "git_commit", args: { message: "m" } } as never,
    {} as never,
  )
  expect(decision).toBe("allow")
})

test("permission: abort di tengah prompt → cancelled + deny (late approval tertutup)", async () => {
  setTty(true)
  const ctl = new AbortController()
  const events: ApprovalHookEvent[] = []
  // ABORT SEBELUM masuk prompt: check() early-return deny TANPA event
  // (contract: cancellation mengalahkan approval; tidak ada requested yang
  // menggantung — lihat permission.ts check() signal?.aborted).
  const abortedFirst = new AbortController()
  abortedFirst.abort()
  const hAbort = createPermissionHandler({
    mode: "ask",
    root: process.cwd(),
    ask: async () => "allow",
    onApprovalEvent: (e) => events.push(e),
  })
  const early = await hAbort.check(
    { id: "g0", name: "git_commit", args: {} } as never,
    { signal: abortedFirst.signal } as never,
  )
  expect(early).toBe("deny")
  expect(events).toHaveLength(0)

  // ABORT di tengah prompt: requested+settled(cancelled) harus terbit.
  const mid: ApprovalHookEvent[] = []
  const h = createPermissionHandler({
    mode: "ask",
    root: process.cwd(),
    // View yang TIDAK PERNAH menjawab: raceAbort menang lewat signal abort
    // (late-approval = deny). Bila view ikut resolve saat abort, jawaban
    // user bisa membuka gerbang — persis bug yang dicegah raceAbort.
    ask: () => new Promise(() => {}),
    onApprovalEvent: (e) => mid.push(e),
  })
  const p = h.check(
    { id: "g5", name: "git_commit", args: {} } as never,
    {
      signal: ctl.signal,
    } as never,
  )
  // Biarkan handler MASUK gatedPrompt dulu (allowlist async), baru abort —
  // abort sebelum prompt = early-return check() tanpa event (diuji di atas).
  await new Promise((r) => setTimeout(r, 10))
  ctl.abort()
  const decision = await p
  expect(decision).toBe("deny")
  expect(mid.map((e) => e.kind)).toEqual(["requested", "settled"])
  const settled = mid[1]
  expect(settled?.kind === "settled" && settled.outcome).toEqual({
    decision: "cancelled",
    by: "system",
    reason: "parent-aborted",
  })
})

// ── Integrasi ask_user (setAskApprovalHook) ──

test("ask_user: tanpa view → requested+settled(no-view) + tetap throw (fail-closed utuh)", async () => {
  setAskTextFn(undefined)
  const events: ApprovalHookEvent[] = []
  setAskApprovalHook((e) => events.push(e))
  let threw = ""
  try {
    await askUserTool.execute({ question: "lanjut?" }, {
      signal: new AbortController().signal,
    } as never)
  } catch (e) {
    threw = (e as Error).message
  }
  expect(threw).toContain("no question view injected")
  expect(events.map((e) => e.kind)).toEqual(["requested", "settled"])
  const settled = events[1]
  expect(settled?.kind === "settled" && settled.outcome).toEqual({
    decision: "deny",
    by: "system",
    reason: "no-view",
  })
})

test("ask_user: view ada + TTY → requested+settled(allow), jawaban dilewatkan", async () => {
  setTty(true)
  setAskTextFn(async () => "  pilihan-a  ")
  const events: ApprovalHookEvent[] = []
  setAskApprovalHook((e) => events.push(e))
  const out = await askUserTool.execute({ question: "pilih:" }, {
    signal: new AbortController().signal,
  } as never)
  expect(out).toBe("pilihan-a")
  expect(events.map((e) => e.kind)).toEqual(["requested", "settled"])
  const settled = events[1]
  expect(settled?.kind === "settled" && settled.outcome).toEqual({
    decision: "allow",
    by: "user",
  })
})

test("ask_user: jawaban kosong → settled(deny user declined) + throw", async () => {
  setTty(true)
  setAskTextFn(async () => "   ")
  const events: ApprovalHookEvent[] = []
  setAskApprovalHook((e) => events.push(e))
  let threw = ""
  try {
    await askUserTool.execute({ question: "pilih:" }, {
      signal: new AbortController().signal,
    } as never)
  } catch (e) {
    threw = (e as Error).message
  }
  expect(threw).toContain("cancelled")
  const settled = events[1]
  expect(settled?.kind === "settled" && settled.outcome).toEqual({
    decision: "deny",
    by: "user",
    reason: "declined",
  })
})

// ── Isolasi handler yang melempar / dispose ──

test("subscriber yang melempar dihitung errors, event lain tetap terbit", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const good: string[] = []
  a.onEvent(() => {
    throw new Error("subscriber boom")
  })
  a.onEvent((e) => good.push(e.type))
  bus.emit("turn:started", { turn: 1 })
  expect(a.getDiagnostics().errors).toBeGreaterThanOrEqual(1)
  expect(good).toContain("turn.started")
  a.dispose()
})

test("dispose melepas semua langganan bus (event setelah dispose tak diteruskan)", () => {
  const bus = fakeBus()
  const a = createPresentationAdapter(bus, { sessionId: "s1" })
  const events = collect(a)
  bus.emit("turn:started", { turn: 1 })
  expect(events.length).toBeGreaterThan(0)
  a.dispose()
  const before = events.length
  bus.emit("turn:started", { turn: 2 })
  expect(events.length).toBe(before)
  expect(a.getDiagnostics().emitted).toBeGreaterThan(0)
})

describe("DURABILITY — tabel kontrak fase lanjut", () => {
  test("delta non-durable; lifecycle tool/turn/approval durable", async () => {
    const { DURABILITY } = await import("../src/presentation/events.ts")
    expect(DURABILITY["model.delta"]).toEqual({ durable: false, replayable: false })
    expect(DURABILITY["tool.progress"]).toEqual({ durable: false, replayable: false })
    expect(DURABILITY["tool.denied"]).toEqual({ durable: true, replayable: true })
    expect(DURABILITY["turn.cancelled"]).toEqual({ durable: true, replayable: true })
    expect(DURABILITY["approval.settled"]).toEqual({ durable: true, replayable: true })
    expect(DURABILITY["context.compacted"]).toEqual({ durable: true, replayable: true })
  })
})
