// M8 — Authoritative execution FSM: satu owner, commit serial, terminal sticky.
// Hermetic murni: tanpa vendor/CLI/persistence/scheduler/supervisor.

import { expect, test } from "bun:test"
import { allocateExecutionId } from "../src/runtime/execution-id.ts"
import {
  createExecutionKernel,
  type ExecutionState,
  isExecutionTerminalState,
  isLegalTransition,
  type TransitionRequest,
  terminalForCancelReason,
  translateBackendObservation,
} from "../src/runtime/execution-kernel.ts"

function req(
  executionId: string,
  to: ExecutionState,
  reason = "test",
  source: TransitionRequest["source"] = "test",
): TransitionRequest {
  return { executionId, to, reason, source }
}

function runningKernel() {
  const kernel = createExecutionKernel()
  const rec = kernel.create({ kind: "turn", ownerId: "s" })
  const r = kernel.requestTransition(req(rec.executionId, "ADMITTED"))
  if (!r.committed) throw new Error("setup failed")
  const r2 = kernel.requestTransition(req(rec.executionId, "RUNNING"))
  if (!r2.committed) throw new Error("setup failed")
  return { kernel, id: rec.executionId }
}

// Tabel legal: setiap baris YES dari kontrak.
test("M8 table: semua transisi legal di-commit", () => {
  const legal: [ExecutionState, ExecutionState][] = [
    ["CREATED", "ADMITTED"],
    ["CREATED", "CANCELLING"],
    ["ADMITTED", "RUNNING"],
    ["ADMITTED", "CANCELLING"],
    ["ADMITTED", "RESOURCE_EXCEEDED"],
    ["RUNNING", "WAITING"],
    ["RUNNING", "CANCELLING"],
    ["RUNNING", "TERMINATING"],
    ["RUNNING", "COMPLETED"],
    ["RUNNING", "FAILED"],
    ["RUNNING", "RESOURCE_EXCEEDED"],
    ["WAITING", "RESUMED"],
    ["WAITING", "CANCELLING"],
    ["WAITING", "RESOURCE_EXCEEDED"],
    ["RESUMED", "RUNNING"],
    ["RESUMED", "CANCELLING"],
    ["RESUMED", "RESOURCE_EXCEEDED"],
    ["CANCELLING", "CANCELLED"],
    ["CANCELLING", "TIMED_OUT"],
    ["CANCELLING", "BUDGET_EXCEEDED"],
    ["CANCELLING", "AUTHORITY_LOST"],
    ["CANCELLING", "RESOURCE_EXCEEDED"],
    ["TERMINATING", "CANCELLED"],
    ["TERMINATING", "FAILED"],
    ["TERMINATING", "RESOURCE_EXCEEDED"],
  ]
  for (const [from, to] of legal) {
    expect(isLegalTransition(from, to), `${from}→${to}`).toBe(true)
    const kernel = createExecutionKernel()
    const rec = kernel.create({ kind: "turn", ownerId: "s" })
    // Drive ke `from` lewat rantai terpendek yang valid.
    const chain: ExecutionState[] =
      from === "CREATED"
        ? []
        : from === "ADMITTED"
          ? ["ADMITTED"]
          : from === "RUNNING"
            ? ["ADMITTED", "RUNNING"]
            : from === "WAITING"
              ? ["ADMITTED", "RUNNING", "WAITING"]
              : from === "RESUMED"
                ? ["ADMITTED", "RUNNING", "WAITING", "RESUMED"]
                : from === "CANCELLING"
                  ? ["CANCELLING"]
                  : ["ADMITTED", "RUNNING", "TERMINATING"]
    for (const s of chain) {
      const r = kernel.requestTransition(req(rec.executionId, s))
      expect(r.committed, `${from} setup ${s}`).toBe(true)
    }
    const terminal = ["CANCELLING", "TERMINATING"].includes(from)
      ? [
          "CANCELLED",
          "TIMED_OUT",
          "BUDGET_EXCEEDED",
          "AUTHORITY_LOST",
          "RESOURCE_EXCEEDED",
          "FAILED",
        ].includes(to)
        ? to
        : "CANCELLED"
      : to
    void terminal
    const res = kernel.requestTransition(req(rec.executionId, to))
    expect(res.committed, `${from}→${to}`).toBe(true)
  }
})

// Ilegal: terminal→apapun, lompatan, WAITING→COMPLETED langsung.
test("M8 invalid: ditolak tanpa mutasi + audit", () => {
  const illegal: [ExecutionState, ExecutionState][] = [
    ["COMPLETED", "CANCELLED"],
    ["CANCELLED", "COMPLETED"],
    ["FAILED", "RUNNING"],
    ["TIMED_OUT", "TIMED_OUT"],
    ["CREATED", "RUNNING"],
    ["CREATED", "COMPLETED"],
    ["ADMITTED", "COMPLETED"],
    ["ADMITTED", "WAITING"],
    ["RUNNING", "ADMITTED"],
    ["RUNNING", "RESUMED"],
    ["WAITING", "COMPLETED"],
    ["WAITING", "RUNNING"],
    ["RESUMED", "COMPLETED"],
    ["CANCELLING", "COMPLETED"],
    ["TERMINATING", "COMPLETED"],
  ]
  for (const [from, to] of illegal) {
    expect(isLegalTransition(from, to), `${from}→${to}`).toBe(false)
  }
  const { kernel, id } = runningKernel()
  const before = kernel.get(id)?.version
  const res = kernel.requestTransition(req(id, "ADMITTED"))
  expect(res.committed).toBe(false)
  if (res.committed) throw new Error("unreachable")
  expect(res.outcome).toBe("rejected-invalid")
  expect(kernel.get(id)?.version).toBe(before)
  expect(kernel.get(id)?.state).toBe("RUNNING")
  expect(kernel.metrics().invalidTransition).toBe(1)
})

// Rantai RESUMED (approval-shaped): WAITING→RESUMED→RUNNING→COMPLETED.
test("M8 waiting-chain: approval unblock lewat RESUMED", () => {
  const { kernel, id } = runningKernel()
  expect(kernel.requestTransition(req(id, "WAITING", "approval"))).toEqual(
    expect.objectContaining({ committed: true }),
  )
  expect(kernel.requestTransition(req(id, "RESUMED", "approval-resolved"))).toEqual(
    expect.objectContaining({ committed: true }),
  )
  expect(kernel.requestTransition(req(id, "RUNNING", "resume"))).toEqual(
    expect.objectContaining({ committed: true }),
  )
  const done = kernel.requestTransition(req(id, "COMPLETED", "done"))
  expect(done.committed).toBe(true)
})

// Race: pasangan terminal berlomba — tepat satu commit per execution.
// Serialisasi run-to-completion: commit atomik sinkron, sehingga interleave
// urutan panggil = satu pemenang deterministik (first-committed wins).
for (const [cancelTerminal, cancelReason] of [
  ["CANCELLED", "user"],
  ["TIMED_OUT", "timeout"],
  ["BUDGET_EXCEEDED", "budget"],
  ["AUTHORITY_LOST", "authority"],
  ["FAILED", "backend-failure"],
] as const) {
  test(`M8 race 100×: ${cancelTerminal} vs COMPLETED — satu terminal`, async () => {
    for (let i = 0; i < 100; i++) {
      const { kernel, id } = runningKernel()
      // Urutan dibalik tiap iterasi: pemenang = yang commit duluan.
      const firstComplete = i % 2 === 0
      if (firstComplete) {
        expect(kernel.requestTransition(req(id, "COMPLETED", "fin", "agent-loop")).committed).toBe(
          true,
        )
        const late =
          cancelTerminal === "FAILED"
            ? kernel.requestTransition(req(id, "FAILED", "late", "backend"))
            : kernel.requestTransition(req(id, "CANCELLING", "late", "host"))
        expect(late.committed).toBe(false)
        if (late.committed) throw new Error("unreachable")
        expect(late.outcome).toBe("late-result-ignored")
        expect(kernel.get(id)?.state).toBe("COMPLETED")
      } else {
        if (cancelTerminal === "FAILED") {
          expect(kernel.requestTransition(req(id, "FAILED", "boom", "backend")).committed).toBe(
            true,
          )
        } else {
          expect(
            kernel.requestTransition(req(id, "CANCELLING", cancelReason, "host")).committed,
          ).toBe(true)
          expect(
            kernel.requestTransition(req(id, cancelTerminal, cancelReason, "host")).committed,
          ).toBe(true)
        }
        const late = kernel.requestTransition(req(id, "COMPLETED", "late-fin", "agent-loop"))
        expect(late.committed).toBe(false)
        if (late.committed) throw new Error("unreachable")
        expect(late.outcome).toBe("late-result-ignored")
        expect(kernel.get(id)?.state).toBe(cancelTerminal)
      }
    }
  }, 30000)
}

// Linearisasi eksplisit: dua terminal konkuren → satu commit + audit kedua.
test("M8 linearization: dua terminal konkuren, kedua diaudit", async () => {
  const { kernel, id } = runningKernel()
  const [r1, r2] = await Promise.all([
    (async () => kernel.requestTransition(req(id, "COMPLETED", "fin", "agent-loop")))(),
    (async () => {
      const c = kernel.requestTransition(req(id, "CANCELLING", "user", "host"))
      if (!c.committed) return c
      return kernel.requestTransition(req(id, "CANCELLED", "user", "host"))
    })(),
  ])
  const committed = [r1, r2].filter((r) => r.committed)
  expect(committed).toHaveLength(1)
  const m = kernel.metrics()
  expect(m.terminalCommitted).toBe(1)
  expect(m.lateResultIgnored + m.duplicateTerminalIgnored).toBe(1)
  expect(isExecutionTerminalState(kernel.get(id)?.state)).toBe(true)
})

// Provenance lestari across race.
test("M8 provenance: pemenang menyimpan reason/source/causality/order", async () => {
  const { kernel, id } = runningKernel()
  const c = kernel.requestTransition({
    executionId: id,
    to: "CANCELLING",
    reason: "user",
    source: "host",
    causality: "esc",
  })
  expect(c.committed).toBe(true)
  const t = kernel.requestTransition({
    executionId: id,
    to: "CANCELLED",
    reason: "user",
    source: "host",
    causality: "esc",
  })
  expect(t.committed).toBe(true)
  const rec = kernel.get(id)
  expect(rec?.reason).toBe("user")
  expect(rec?.provenance?.source).toBe("host")
  expect(rec?.provenance?.causality).toBe("esc")
  expect(rec?.provenance?.order).toBe(rec?.version)
  expect(typeof rec?.provenance?.at).toBe("number")
})

// Late backend: CANCELLED lalu completed-observation → tetap + ignored.
test("M8 late-backend: CANCELLED tak tertimpa completed telat", () => {
  const { kernel, id } = runningKernel()
  expect(kernel.requestTransition(req(id, "CANCELLING", "user", "host")).committed).toBe(true)
  expect(kernel.requestTransition(req(id, "CANCELLED", "user", "host")).committed).toBe(true)
  const late = translateBackendObservation("CANCELLED", "completed")
  expect(late).toBeNull()
  const r = kernel.requestTransition(req(id, "COMPLETED", "backend-late", "backend"))
  expect(r.committed).toBe(false)
  if (r.committed) throw new Error("unreachable")
  expect(r.outcome).toBe("late-result-ignored")
  expect(kernel.get(id)?.state).toBe("CANCELLED")
})

// Cancel/timeout sesudah COMPLETED: no-op, reason preserved.
test("M8 cancel-after-complete + timeout-after-complete: no-op", () => {
  const { kernel, id } = runningKernel()
  expect(kernel.requestTransition(req(id, "COMPLETED", "done", "agent-loop")).committed).toBe(true)
  for (const to of ["CANCELLING", "TIMED_OUT", "CANCELLED"] as ExecutionState[]) {
    const r = kernel.requestTransition(req(id, to, "late", "host"))
    expect(r.committed).toBe(false)
  }
  expect(kernel.get(id)?.state).toBe("COMPLETED")
  expect(kernel.get(id)?.reason).toBe("done")
  const dup = kernel.requestTransition(req(id, "COMPLETED", "again", "agent-loop"))
  expect(dup.committed).toBe(false)
  if (dup.committed) throw new Error("unreachable")
  expect(dup.outcome).toBe("duplicate-terminal-ignored")
})

// Parent/child independen: cancel parent tak sentuh record child.
test("M8 parent-child: cancel parent bukan mutasi child terminal", () => {
  const kernel = createExecutionKernel()
  const p = kernel.create({ kind: "turn", ownerId: "s" })
  const c = kernel.create({
    executionId: allocateExecutionId(),
    parentExecutionId: p.executionId,
    rootExecutionId: p.executionId,
    kind: "child",
    ownerId: "s",
  })
  for (const to of ["ADMITTED", "RUNNING"] as ExecutionState[]) {
    expect(kernel.requestTransition(req(c.executionId, to)).committed).toBe(true)
  }
  expect(
    kernel.requestTransition(req(c.executionId, "COMPLETED", "child done", "agent-loop")).committed,
  ).toBe(true)
  // Parent dibatalkan penuh — record child tak tersentuh.
  expect(kernel.requestTransition(req(p.executionId, "CANCELLING", "user", "host")).committed).toBe(
    true,
  )
  expect(kernel.requestTransition(req(p.executionId, "CANCELLED", "user", "host")).committed).toBe(
    true,
  )
  expect(kernel.get(c.executionId)?.state).toBe("COMPLETED")
  expect(kernel.get(p.executionId)?.state).toBe("CANCELLED")
})

// Negative authority: hanya kernel yang commit.
test("M8 authority: request inert; selain kernel tak ada penulis", () => {
  const kernel = createExecutionKernel()
  const rec = kernel.create({ kind: "task", ownerId: "t1" })
  const api = kernel as unknown as Record<string, unknown>
  for (const forbidden of [
    "setState",
    "complete",
    "fail",
    "cancel",
    "writeTerminal",
    "forceState",
    "mutate",
  ]) {
    expect(api[forbidden], forbidden).toBeUndefined()
  }
  // Request object saja tak mengubah apa pun.
  const inert: TransitionRequest = req(rec.executionId, "RUNNING", "x", "scheduler")
  void inert
  expect(kernel.get(rec.executionId)?.state).toBe("CREATED")
  expect(Object.isFrozen(kernel.get(rec.executionId))).toBe(true)
  expect(() => {
    ;(kernel.get(rec.executionId) as unknown as { state: string }).state = "COMPLETED"
  }).toThrow()
})

// Security: reason wajib; id tak-valid ditolak; provenance tercatat (audit trail).
test("M8 security: empty reason + bad id + unknown execution ditolak", () => {
  const kernel = createExecutionKernel()
  const rec = kernel.create({ kind: "turn", ownerId: "s" })
  expect(() => kernel.requestTransition(req(rec.executionId, "ADMITTED", "", "host"))).toThrow()
  expect(() => kernel.create({ kind: "turn", ownerId: "s", executionId: "palsu" })).toThrow()
  expect(() =>
    kernel.requestTransition(
      req("exec_00000000-0000-4000-8000-000000000000", "RUNNING", "x", "host"),
    ),
  ).toThrow()
  expect(() =>
    kernel.create({ kind: "turn", ownerId: "s", executionId: rec.executionId }),
  ).toThrow()
  // State tetap CREATED (tanpa mutasi parsial).
  expect(kernel.get(rec.executionId)?.state).toBe("CREATED")
})

// Timeout/budget/authority/resource: reason eksplisit, bukan FAILED generik.
test("M8 reasons: timeout/budget/authority/resource terdiferensiasi", () => {
  for (const [reason, terminal] of [
    ["timeout", "TIMED_OUT"],
    ["budget", "BUDGET_EXCEEDED"],
    ["authority", "AUTHORITY_LOST"],
    ["resource", "RESOURCE_EXCEEDED"],
    ["user", "CANCELLED"],
    ["parent", "CANCELLED"],
    ["shutdown", "CANCELLED"],
  ] as const) {
    expect(terminalForCancelReason(reason)).toBe(terminal)
    const { kernel, id } = runningKernel()
    expect(kernel.requestTransition(req(id, "CANCELLING", reason, "host")).committed).toBe(true)
    const t = kernel.requestTransition(req(id, terminal, reason, "host"))
    expect(t.committed, reason).toBe(true)
    expect(kernel.get(id)?.reason).toBe(reason)
  }
})

// Normal completion langsung RUNNING→COMPLETED (tanpa TERMINATING).
test("M8 completion: RUNNING→COMPLETED tanpa TERMINATING", () => {
  const { kernel, id } = runningKernel()
  const r = kernel.requestTransition(req(id, "COMPLETED", "done", "agent-loop"))
  expect(r.committed).toBe(true)
  expect(kernel.get(id)?.terminalAt).not.toBeNull()
})

// Failure biasa dengan provenance.
test("M8 failure: RUNNING→FAILED + reason/causality", () => {
  const { kernel, id } = runningKernel()
  const r = kernel.requestTransition({
    executionId: id,
    to: "FAILED",
    reason: "tool boom",
    source: "agent-loop",
    causality: "tool:bash",
  })
  expect(r.committed).toBe(true)
  expect(kernel.get(id)?.provenance?.causality).toBe("tool:bash")
})

// Backend translation boundary.
test("M8 translate: observasi fisik → request atau null (jujur)", () => {
  expect(translateBackendObservation("RUNNING", "completed")).toEqual({
    to: "COMPLETED",
    reason: "backend reported completion",
  })
  expect(translateBackendObservation("WAITING", "completed")).toBeNull()
  expect(translateBackendObservation("RUNNING", "failed")).toEqual({
    to: "FAILED",
    reason: "backend reported failure",
  })
  expect(translateBackendObservation("WAITING", "failed")).toBeNull()
  expect(translateBackendObservation("RUNNING", "proven-dead", "user")).toEqual({
    to: "CANCELLING",
    reason: "user",
  })
  expect(translateBackendObservation("RUNNING", "proven-dead")).toBeNull()
  expect(translateBackendObservation("COMPLETED", "completed")).toBeNull()
  for (const o of ["timeout", "vanished", "unknown", "orphan"] as const) {
    expect(translateBackendObservation("RUNNING", o, "user"), o).toBeNull()
  }
})

// Hook observasi: terurut, terisolasi dari throw.
test("M8 hook: event terurut + observer-throw tak ganggu commit", () => {
  const kernel = createExecutionKernel()
  const seen: string[] = []
  const off = kernel.onTransition((e) => {
    seen.push(`${e.from}→${e.to}#${e.order}`)
  })
  kernel.onTransition(() => {
    throw new Error("observer boom")
  })
  const rec = kernel.create({ kind: "turn", ownerId: "s" })
  expect(kernel.requestTransition(req(rec.executionId, "ADMITTED")).committed).toBe(true)
  expect(kernel.requestTransition(req(rec.executionId, "RUNNING")).committed).toBe(true)
  expect(seen).toEqual(["CREATED→ADMITTED#1", "ADMITTED→RUNNING#2"])
  expect(kernel.metrics().observerErrors).toBe(2)
  off()
})

// Metrics lengkap.
test("M8 metrics: accepted/rejected/terminal/duplicate/late/invalid", () => {
  const kernel = createExecutionKernel()
  const rec = kernel.create({ kind: "turn", ownerId: "s" })
  kernel.requestTransition(req(rec.executionId, "ADMITTED"))
  kernel.requestTransition(req(rec.executionId, "RUNNING"))
  kernel.requestTransition(req(rec.executionId, "RUNNING"))
  kernel.requestTransition(req(rec.executionId, "COMPLETED", "done", "agent-loop"))
  kernel.requestTransition(req(rec.executionId, "COMPLETED", "again", "agent-loop"))
  kernel.requestTransition(req(rec.executionId, "CANCELLED", "late", "host"))
  const m = kernel.metrics()
  expect(m.transitionAccepted).toBe(3)
  expect(m.terminalCommitted).toBe(1)
  expect(m.duplicateTerminalIgnored).toBe(1)
  expect(m.lateResultIgnored).toBe(1)
  expect(m.invalidTransition).toBe(1)
  expect(m.executions).toBe(1)
})
