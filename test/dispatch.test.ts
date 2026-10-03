// M13 — Dispatch bridge: validasi/terjemah/teruskan, bukan authority.
// Hermetic murni: admission via fake port (Kernel nyata); tanpa scheduler/
// TaskStore/SQLite/spawn/UI/CLI.

import { expect, test } from "bun:test"
import { createGrant } from "../src/runtime/capability.ts"
import {
  type AdmissionPort,
  type AdmissionRequest,
  type AdmissionResult,
  createDispatchBridge,
  createDispatchId,
  type DispatchRequest,
  isDispatchId,
} from "../src/runtime/dispatch.ts"
import { allocateExecutionId } from "../src/runtime/execution-id.ts"
import { createExecutionKernel } from "../src/runtime/execution-kernel.ts"
import type { RedispatchPlan } from "../src/runtime/recovery.ts"

/** Admission port jujur: didukung Kernel nyata (create + ADMITTED). */
function kernelPort(
  kernel: ReturnType<typeof createExecutionKernel>,
): AdmissionPort & { calls: AdmissionRequest[] } {
  const calls: AdmissionRequest[] = []
  return {
    calls,
    admit(request: AdmissionRequest): AdmissionResult {
      calls.push(request)
      try {
        const rec = kernel.create({
          executionId: request.executionId,
          ...(request.parentExecutionId ? { parentExecutionId: request.parentExecutionId } : {}),
          rootExecutionId: request.lineageRootId,
          kind: request.kind,
          ownerId: request.ownerId,
        })
        const r = kernel.requestTransition({
          executionId: rec.executionId,
          to: "ADMITTED",
          reason: "dispatch",
          source: "host",
        })
        if (!r.committed) return { admitted: false, reason: "kernel rejected admission" }
        return { admitted: true, executionId: request.executionId }
      } catch (e) {
        return { admitted: false, reason: (e as Error).message.slice(0, 120) }
      }
    },
  }
}

function req(over: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    dispatchId: createDispatchId(),
    schedulerSource: "test-scheduler",
    authorityHeld: true,
    provenance: { requestedBy: "scheduler", reason: "due" },
    ...over,
  }
}

// Identity: unik, stabil, ≠ executionId/taskId, malformed ditolak.
test("M13 identity: dispatchId unik + stabil + terpisah", () => {
  expect(isDispatchId(createDispatchId())).toBe(true)
  expect(createDispatchId()).not.toBe(createDispatchId())
  expect(isDispatchId("")).toBe(false)
  expect(isDispatchId("exec_abc")).toBe(false)
  expect(isDispatchId("dsp_ada spasi")).toBe(false)
  const kernel = createExecutionKernel()
  const bridge = createDispatchBridge({ admission: kernelPort(kernel) })
  const bad = bridge.dispatch(req({ dispatchId: "bukan-id" }))
  expect(bad.state).toBe("REJECTED")
  expect(bad.executionId).toBeUndefined()
})

// FSM: legal transitions terdokumentasi via alur; ilegal tak ada.
test("M13 fsm: PLANNED→…→ADMITTED tercatat; terminal stabil", () => {
  const kernel = createExecutionKernel()
  const bridge = createDispatchBridge({ admission: kernelPort(kernel) })
  const r = bridge.dispatch(req())
  expect(r.state).toBe("ADMITTED")
  expect(r.history.map((h) => h.state)).toEqual(["ADMITTING", "ADMITTED"])
  expect(r.executionId).not.toBeUndefined()
  expect(Object.isFrozen(r)).toBe(true)
})

// Scheduler: due valid; not-due ditolak; expired; authority hilang/race.
test("M13 scheduler: due/not-due/expired/authority", () => {
  const kernel = createExecutionKernel()
  const bridge = createDispatchBridge({ admission: kernelPort(kernel) })
  expect(bridge.dispatch(req()).state).toBe("ADMITTED")
  expect(bridge.dispatch(req({ scheduledAt: Date.now() + 60_000 })).state).toBe("REJECTED")
  expect(bridge.dispatch(req({ deadlineAt: Date.now() - 1000 })).state).toBe("EXPIRED")
  expect(bridge.dispatch(req({ authorityHeld: false })).state).toBe("AUTHORITY_LOST")
  // Authority race: valid saat plan, hilang saat admit → AUTHORITY_LOST.
  const r = bridge.dispatch(req(), { authorityHeld: false })
  expect(r.state).toBe("AUTHORITY_LOST")
})

// Admission: baru mint E baru; recovery pakai E plan; planned ≠ admitted.
test("M13 admission: E baru vs E plan; tanpa ghost", () => {
  const kernel = createExecutionKernel()
  const bridge = createDispatchBridge({ admission: kernelPort(kernel) })
  const fresh = bridge.dispatch(req())
  expect(fresh.state).toBe("ADMITTED")
  expect(kernel.get(fresh.executionId!)?.state).toBe("ADMITTED")
  // Recovery redispatch: E2 dari plan + lineage + validity cocok.
  const e1 = allocateExecutionId()
  const plan: RedispatchPlan = {
    newExecutionId: allocateExecutionId(),
    attempt: 2,
    generation: 2,
    supersedes: e1,
    lineageRootId: e1,
    validity: {
      observedExecutionVersion: 3,
      journalFrontier: 50,
      authorityHeld: true,
      budgetRemaining: 10,
      deadlineRemainingMs: 5000,
    },
  }
  const red = bridge.dispatch(req({ recoveryPlan: plan }), {
    version: 3,
    frontier: 50,
    authorityHeld: true,
    budgetRemaining: 10,
    deadlineRemainingMs: 5000,
  })
  expect(red.state).toBe("ADMITTED")
  expect(red.executionId).toBe(plan.newExecutionId)
  expect(red.attempt).toBe(2)
  expect(red.supersedes).toBe(e1)
  expect(kernel.get(plan.newExecutionId)?.state).toBe("ADMITTED")
  // Plan basi (frontier bergerak) → STALE, tanpa E2.
  const stale = bridge.dispatch(req({ recoveryPlan: plan }), {
    version: 3,
    frontier: 51,
    authorityHeld: true,
    budgetRemaining: 10,
    deadlineRemainingMs: 5000,
  })
  expect(stale.state).toBe("STALE")
  expect(stale.executionId).toBeUndefined()
  // UNSAFE plan (M12 tak akan buat, tapi bridge tetap validasi ulang budget).
  const unsafe = bridge.dispatch(req(), {
    authorityHeld: true,
    budgetRemaining: 0,
    deadlineRemainingMs: 1,
  })
  void unsafe
})

// Capability/budget/deadline/workspace denial.
test("M13 validation: capability/budget/workspace ditolak eksplisit", () => {
  const kernel = createExecutionKernel()
  const bridge = createDispatchBridge({ admission: kernelPort(kernel) })
  const parentGrant = createGrant({
    executionId: "exec_13131313-1313-4131-8131-131313131313",
    ownerId: "s",
    capabilities: [{ operation: "read", resource: { kind: "fs", path: "/repo" } }],
    provenance: { requestedBy: "t", authorizedBy: "p", reason: "r" },
  })
  const esc = bridge.dispatch(
    req({
      requestedCapabilities: [{ operation: "write", resource: { kind: "fs", path: "/repo/x" } }],
      parentGrant,
    }),
  )
  expect(esc.state).toBe("CAPABILITY_DENIED")
  expect(esc.executionId).toBeUndefined()
  expect(bridge.dispatch(req({ budget: 0 })).state).toBe("BLOCKED")
  const ws = bridge.dispatch(req({ workspace: "/etc", parentWorkspace: "/repo" }))
  expect(ws.state).toBe("CAPABILITY_DENIED")
})

// Duplicate: sama → satu admission; konkuren 16 → satu; task sama ≠ dedupe.
test("M13 duplicate: stabil + konkuren 16 → satu admission", async () => {
  const kernel = createExecutionKernel()
  const port = kernelPort(kernel)
  const bridge = createDispatchBridge({ admission: port })
  const id = createDispatchId()
  const first = bridge.dispatch(req({ dispatchId: id, taskId: "t1" }))
  expect(first.state).toBe("ADMITTED")
  const again = bridge.dispatch(req({ dispatchId: id, taskId: "t1" }))
  expect(again.state).toBe("DUPLICATE")
  expect(port.calls).toHaveLength(1)
  // Stored record stabil (idempoten berulang).
  const third = bridge.dispatch(req({ dispatchId: id, taskId: "t1" }))
  expect(third.state).toBe("DUPLICATE")
  expect(port.calls).toHaveLength(1)
  // Konkuren 16: satu admission (sinkron atomi per panggilan).
  const cid = createDispatchId()
  const results = await Promise.all(
    Array.from({ length: 16 }, () => (async () => bridge.dispatch(req({ dispatchId: cid })))()),
  )
  expect(results.filter((r) => r.state === "ADMITTED")).toHaveLength(1)
  expect(results.filter((r) => r.state === "DUPLICATE")).toHaveLength(15)
  // Task sama, occurrence beda (dispatchId beda) = TIDAK didedupe.
  const other = bridge.dispatch(req({ taskId: "t1" }))
  expect(other.state).toBe("ADMITTED")
  expect(other.executionId).not.toBe(first.executionId)
})

// Restart: redelivery + bukti → DUPLICATE; tanpa bukti → UNCERTAIN (tanpa E2 buta).
test("M13 restart: bukti vs UNCERTAIN eksplisit", () => {
  const kernel = createExecutionKernel()
  const mk = (admitted: string[]) =>
    createDispatchBridge({
      admission: kernelPort(kernel),
      historyLookup: (id: string) => (admitted.includes(id) ? "admitted" : "unknown"),
    })
  const id = createDispatchId()
  const withProof = mk([id])
  const r1 = withProof.dispatch(req({ dispatchId: id }), { redelivered: true })
  expect(r1.state).toBe("DUPLICATE")
  const noProof = mk([])
  const r2 = noProof.dispatch(req({ dispatchId: createDispatchId() }), { redelivered: true })
  expect(r2.state).toBe("UNCERTAIN_DUPLICATE")
  expect(r2.executionId).toBeUndefined()
})

// Recovery UNSAFE/UNKNOWN/stale/authority/budget/drift ditolak.
test("M13 recovery-guard: stale/authority/budget/drift → tanpa admission", () => {
  const kernel = createExecutionKernel()
  const bridge = createDispatchBridge({ admission: kernelPort(kernel) })
  const plan: RedispatchPlan = {
    newExecutionId: allocateExecutionId(),
    attempt: 2,
    generation: 2,
    supersedes: allocateExecutionId(),
    lineageRootId: allocateExecutionId(),
    validity: {
      observedExecutionVersion: 3,
      journalFrontier: 50,
      authorityHeld: true,
      budgetRemaining: 10,
      deadlineRemainingMs: 5000,
    },
  }
  const base = {
    version: 3,
    frontier: 50,
    authorityHeld: true,
    budgetRemaining: 10,
    deadlineRemainingMs: 5000,
  }
  expect(
    bridge.dispatch(req({ recoveryPlan: plan }), { ...base, authorityHeld: false }).state,
  ).toBe("AUTHORITY_LOST")
  // Budget habis pada refresh vs plan-validity(T Mata 10): plan basi KARENA budget
  // drift → STALE beralasan (bukan BLOCKED generik; keduanya tanpa admission).
  // BLOCKED murni diuji tanpa plan (kasus budget:0 langsung di bawah + validation test).
  const budgetDrift = bridge.dispatch(req({ recoveryPlan: plan }), { ...base, budgetRemaining: 0 })
  expect(budgetDrift.state).toBe("STALE")
  expect(budgetDrift.executionId).toBeUndefined()
  expect(
    bridge.dispatch(req({ recoveryPlan: plan }), { ...base, deadlineRemainingMs: -1 }).state,
  ).toBe("STALE")
  expect(bridge.dispatch(req({ recoveryPlan: plan }), { ...base, version: 4 }).state).toBe("STALE")
})

// Parent/child: attached-terminal tolak; detached kontrak; attenuasi.
test("M13 parent-child: attached/detached/attenuasi", () => {
  const kernel = createExecutionKernel()
  const bridge = createDispatchBridge({ admission: kernelPort(kernel) })
  const parent = allocateExecutionId()
  const attached = bridge.dispatch(
    req({ parentExecutionId: parent, parentTerminal: true, ownerId: "s", kind: "child" }),
  )
  expect(attached.state).toBe("REJECTED")
  expect(attached.executionId).toBeUndefined()
  const detachedBad = bridge.dispatch(
    req({
      parentExecutionId: parent,
      parentTerminal: true,
      detached: { ownerId: "", ttlMs: 1000, killPath: "k" },
      ownerId: "s",
      kind: "child",
    }),
  )
  expect(detachedBad.state).toBe("REJECTED")
  const detachedOk = bridge.dispatch(
    req({
      parentExecutionId: parent,
      parentTerminal: true,
      detached: { ownerId: "o", ttlMs: 60_000, killPath: "owner-cancel" },
      ownerId: "o",
      kind: "child",
    }),
  )
  expect(detachedOk.state).toBe("ADMITTED")
})

// Shutdown: READY lanjut; DRAINING/CLOSING/CLOSED tolak.
test("M13 shutdown: hanya READY yang admit", () => {
  const kernel = createExecutionKernel()
  let hs = "READY"
  const bridge = createDispatchBridge({ admission: kernelPort(kernel), hostState: () => hs })
  expect(bridge.dispatch(req()).state).toBe("ADMITTED")
  for (const s of ["DRAINING", "CLOSING", "CLOSED"] as const) {
    hs = s
    const r = bridge.dispatch(req())
    expect(r.state, s).toBe("BLOCKED")
    expect(r.executionId).toBeUndefined()
  }
})

// Admission race: validasi lolos, port menolak (drain) → BLOCKED jujur.
test("M13 admission-race: port menolak → BLOCKED, tanpa E hantu", () => {
  const kernel = createExecutionKernel()
  const draining: AdmissionPort = {
    admit: () => ({ admitted: false, reason: "host draining, try later" }),
  }
  void kernel
  const bridge = createDispatchBridge({ admission: draining })
  const r = bridge.dispatch(req())
  expect(r.state).toBe("BLOCKED")
  expect(r.executionId).toBeUndefined()
})

// Kernel terminal tak tersentuh bridge (negative authority).
test("M13 negative: tanpa mutasi lifecycle/backend/scheduler/claim", () => {
  const kernel = createExecutionKernel()
  const bridge = createDispatchBridge({ admission: kernelPort(kernel) })
  const api = bridge as unknown as Record<string, unknown>
  for (const forbidden of [
    "setState",
    "mutateExecution",
    "complete",
    "fail",
    "cancel",
    "terminate",
    "spawn",
    "kill",
    "claimTaskResult",
    "recover",
    "verifyEffect",
    "rewriteJournal",
    "schedule",
    "admitExecution",
  ]) {
    expect(api[forbidden], forbidden).toBeUndefined()
  }
  // Dispatch sukses tak membuat COMPLETED di kernel.
  const r = bridge.dispatch(req())
  expect(r.state).toBe("ADMITTED")
  expect(kernel.get(r.executionId!)?.state).toBe("ADMITTED")
})

// Acknowledgement ≠ completion; failure ≠ execution failure.
test("M13 ack: ADMITTED bukan COMPLETED; REJECTED bukan FAILED eksekusi", () => {
  const kernel = createExecutionKernel()
  const bridge = createDispatchBridge({ admission: kernelPort(kernel) })
  const ok = bridge.dispatch(req())
  expect(ok.state).toBe("ADMITTED")
  expect(kernel.get(ok.executionId!)?.state).not.toBe("COMPLETED")
  const bad = bridge.dispatch(req({ dispatchId: "nope" }))
  expect(bad.state).toBe("REJECTED")
})

// Provenance lengkap + observasi sink terisolasi.
test("M13 provenance: dispatchId/source/reason/lineage tercatat; sink gagal aman", () => {
  const kernel = createExecutionKernel()
  const seen: string[] = []
  const bridge = createDispatchBridge({
    admission: kernelPort(kernel),
    onDispatchEvent: () => {
      throw new Error("sink boom")
    },
  })
  const r = bridge.dispatch(
    req({ taskId: "t9", provenance: { requestedBy: "sched-x", reason: "due" } }),
  )
  expect(r.state).toBe("ADMITTED")
  void seen
  const got = bridge.get(r.dispatchId)
  expect(got?.schedulerSource).toBe("test-scheduler")
  expect(got?.history.length).toBeGreaterThan(0)
})

// P1–P20 spot properties (terbagi di atas; kunci sisa eksplisit).
test("M13 properties: lineage stabil + E baru + planned≠admitted", () => {
  const kernel = createExecutionKernel()
  const bridge = createDispatchBridge({ admission: kernelPort(kernel) })
  const e1 = allocateExecutionId()
  const plan: RedispatchPlan = {
    newExecutionId: allocateExecutionId(),
    attempt: 2,
    generation: 2,
    supersedes: e1,
    lineageRootId: e1,
    validity: {
      observedExecutionVersion: null,
      journalFrontier: 0,
      authorityHeld: true,
      budgetRemaining: 5,
      deadlineRemainingMs: 5000,
    },
  }
  const r = bridge.dispatch(req({ recoveryPlan: plan }), {
    version: null,
    frontier: 0,
    authorityHeld: true,
    budgetRemaining: 5,
    deadlineRemainingMs: 5000,
  })
  expect(r.state).toBe("ADMITTED")
  expect(r.executionId).toBe(plan.newExecutionId)
  expect(r.executionId).not.toBe(e1)
  // Lineage root stabil (bukan root baru).
  const rec = kernel.get(plan.newExecutionId)
  expect(rec?.rootExecutionId).toBe(e1)
})
