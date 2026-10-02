// M7 — Parent/child execution contract: satu spec, tree, attenuasi, detached.
// Hermetic murni: tanpa factory/Pool/session/persistence/scheduler/backend.

import { expect, test } from "bun:test"
import { createGrant } from "../src/runtime/capability.ts"
import {
  admitChild,
  type ChildExecutionSpec,
  describeChildTree,
  isDetachedExpired,
  planParentCancellation,
} from "../src/runtime/child-execution.ts"
import { createRootCorrelation } from "../src/runtime/execution-id.ts"

const OWNER = "sess-m7"
const PARENT_WS = "/repo"

function parent() {
  return createRootCorrelation("turn", OWNER)
}

function parentGrant() {
  return createGrant({
    executionId: "exec_77777777-7777-4777-8777-777777777777",
    ownerId: OWNER,
    capabilities: [
      { operation: "read", resource: { kind: "fs", path: "/repo" } },
      { operation: "write", resource: { kind: "fs", path: "/repo/output" } },
    ],
    provenance: { requestedBy: "test", authorizedBy: "policy:test", reason: "parent" },
  })
}

function spec(over: Partial<ChildExecutionSpec> = {}): ChildExecutionSpec {
  return {
    parent: parent(),
    kind: "child",
    ownerId: OWNER,
    mode: "explore",
    requestedCapabilities: [{ operation: "read", resource: { kind: "fs", path: "/repo/src" } }],
    parentGrant: parentGrant(),
    workspaceCwd: "/repo/src",
    parentWorkspaceCwd: PARENT_WS,
    ...over,
  }
}

function admitted(over: Partial<ChildExecutionSpec> = {}) {
  const r = admitChild(spec(over))
  if (!r.admitted) throw new Error(`expected admission (${r.reason})`)
  return r.admission
}

// Identity P1–P3.
test("M7 identity: E2 baru, parent/root benar, immutable", () => {
  const p = parent()
  const a = admitted({ parent: p })
  expect(a.correlation.executionId).not.toBe(p.executionId)
  expect(a.correlation.parentExecutionId).toBe(p.executionId)
  expect(a.correlation.rootExecutionId).toBe(p.rootExecutionId)
  expect(Object.isFrozen(a.correlation)).toBe(true)
})

// Capability: subset + eskalasi + cross-owner.
test("M7 capability: subset granted; eskalasi/cross-owner ditolak", () => {
  const ok = admitChild(spec())
  expect(ok.admitted).toBe(true)
  const esc = admitChild(
    spec({
      requestedCapabilities: [{ operation: "write", resource: { kind: "fs", path: "/repo/src" } }],
    }),
  )
  expect(esc.admitted).toBe(false)
  const xowner = admitChild(spec({ ownerId: "sess-lain" }))
  expect(xowner.admitted).toBe(false)
})

// Deadline: warisan sisa, clamp, expired, tanpa fresh time.
test("M7 deadline: min(sisa), clamp, exhausted ditolak", () => {
  const a = admitted({ parentRemainingDeadlineMs: 60_000, deadlineMs: 120_000 })
  expect(a.effectiveDeadlineMs).toBe(60_000)
  const b = admitted({ parentRemainingDeadlineMs: 60_000, deadlineMs: 10_000 })
  expect(b.effectiveDeadlineMs).toBe(10_000)
  expect(admitChild(spec({ parentRemainingDeadlineMs: 0 })).admitted).toBe(false)
  expect(admitChild(spec({ deadlineMs: -5 })).admitted).toBe(false)
  // Tanpa sisa diketahui: ceiling backend existing (bukan fresh tak terbatas).
  const c = admitted({ deadlineMs: 9_999_999_999 })
  expect(c.effectiveDeadlineMs).toBeLessThanOrEqual(900_000)
})

// Budget: subtractive + reservasi + over-ask + exhausted.
test("M7 budget: sub-budget + reservasi; overcommit tanpa threading didokumentasikan", () => {
  const a = admitted({ mode: "explore", budgetSteps: 3, parentRemainingSteps: 100 })
  expect(a.budgetSteps).toBe(3)
  expect(a.parentRemainingAfter).toBe(97)
  // Cap mode: explore=5 (evidence LIMITS) — request 40 → 5.
  const capped = admitted({ mode: "explore", budgetSteps: 40 })
  expect(capped.budgetSteps).toBe(5)
  // Sisa 2 → efektif 2 (bukan 5).
  const low = admitted({ mode: "explore", budgetSteps: 5, parentRemainingSteps: 2 })
  expect(low.budgetSteps).toBe(2)
  expect(low.parentRemainingAfter).toBe(0)
  expect(admitChild(spec({ parentRemainingSteps: 0 })).admitted).toBe(false)
  // Reservation threading mencegah overcommit: 100 → 85 → 70 (cap plan=15 evidence LIMITS).
  const first = admitted({ mode: "plan", budgetSteps: 15, parentRemainingSteps: 100 })
  expect(first.budgetSteps).toBe(15)
  expect(first.parentRemainingAfter).toBe(85)
  const second = admitted({
    mode: "plan",
    budgetSteps: 90,
    parentRemainingSteps: first.parentRemainingAfter!,
  })
  expect(second.budgetSteps).toBe(15)
  expect(second.parentRemainingAfter).toBe(70)
})

// Workspace: inherit bounded; escape ditolak.
test("M7 workspace: dalam-parent valid; luar ditolak", () => {
  expect(admitted({ workspaceCwd: "/repo/src" }).workspaceCwd).toBe("/repo/src")
  expect(admitChild(spec({ workspaceCwd: "/etc" })).admitted).toBe(false)
  expect(admitChild(spec({ workspaceCwd: "/repo/../outside" })).admitted).toBe(false)
})

// Owner isolation.
test("M7 owner: mismatch ditolak; grant terikat owner", () => {
  const a = admitted()
  expect(a.grant.ownerId).toBe(OWNER)
  expect(admitChild(spec({ ownerId: "" })).admitted).toBe(false)
})

// Detached: lengkap valid; kurang ditolak; lineage immutable; scope independen.
test("M7 detached: kontrak eksplisit atau tolak", () => {
  const p = parent()
  const d = admitted({
    parent: p,
    detached: { ownerId: "owner-baru", ttlMs: 60_000, killPath: "owner-cancel" },
  })
  expect(d.detached).not.toBeNull()
  expect(d.cancelScope).toEqual({ kind: "detached", owner: "owner-baru" })
  // lineage_root immutable: root tetap root parent.
  expect(d.correlation.rootExecutionId).toBe(p.rootExecutionId)
  expect(d.correlation.parentExecutionId).toBe(p.executionId)
  expect(
    admitChild(spec({ detached: { ownerId: "", ttlMs: 60_000, killPath: "k" } })).admitted,
  ).toBe(false)
  expect(admitChild(spec({ detached: { ownerId: "o", ttlMs: 0, killPath: "k" } })).admitted).toBe(
    false,
  )
  expect(
    admitChild(spec({ detached: { ownerId: "o", ttlMs: 60_000, killPath: "" } })).admitted,
  ).toBe(false)
  // Attached default: scope parent, tanpa TTL (tak ada outlive implisit).
  const attached = admitted()
  expect(attached.detached).toBeNull()
  expect(attached.cancelScope).toEqual({ kind: "parent" })
})

test("M7 detached TTL: observasi kedaluwarsa (eksekusi kill milik owner)", () => {
  expect(isDetachedExpired(1000, 60_000, 61_000)).toBe(true)
  expect(isDetachedExpired(1000, 60_000, 60_999)).toBe(false)
  expect(isDetachedExpired(NaN, 60_000, 61_000)).toBe(true)
})

// Terminal child: parent cancel = NO-OP + audit; live = request.
test("M7 cancel-plan: terminal no-op; live requested; tanpa mutasi", () => {
  const live = "exec_aaaaaaa1-1111-4111-8111-111111111111"
  const done = "exec_bbbbbbb2-2222-4222-8222-222222222222"
  const plan = planParentCancellation([
    { executionId: live, terminal: false },
    { executionId: done, terminal: true },
  ])
  expect(plan.cancelRequested).toEqual([live])
  expect(plan.noopTerminal).toEqual([done])
  expect(Object.isFrozen(plan.cancelRequested)).toBe(true)
  expect(Object.isFrozen(plan.noopTerminal)).toBe(true)
})

// Multiple children: unik + parent/root sama; tanpa batas satu-anak.
test("M7 multi: C1/C2/C3 unik, parent/root sama", () => {
  const p = parent()
  const kids = [admitted({ parent: p }), admitted({ parent: p }), admitted({ parent: p })]
  const ids = new Set(kids.map((k) => k.correlation.executionId))
  expect(ids.size).toBe(3)
  for (const k of kids) {
    expect(k.correlation.parentExecutionId).toBe(p.executionId)
    expect(k.correlation.rootExecutionId).toBe(p.rootExecutionId)
  }
  const tree = describeChildTree(
    p.executionId,
    kids.map((k) => ({ executionId: k.correlation.executionId, kind: "child", detached: false })),
  )
  expect(tree.count).toBe(3)
  expect(tree.parent).toBe(p.executionId)
})

// Result/failure separation: helper tak menyentuh parent terminal.
test("M7 separation: plan cancel hanya referensi id anak", () => {
  const plan = planParentCancellation([{ executionId: "exec_c1", terminal: false }])
  expect(JSON.stringify(plan)).not.toMatch(/COMPLETED|FAILED|parent/)
})

// Boundary: tanpa FSM/supervisor/persistence/scheduler/backend-spawn/registry/pool.
test("M7 boundary: modul murni kontrak (tanpa otoritas tetangga)", async () => {
  const src = await Bun.file("src/runtime/child-execution.ts").text()
  for (const forbidden of [
    "session/journal",
    "session/persistence",
    "task/store",
    "task/scheduler",
    "child_process",
    "sqlite",
    "sqlite",
    "createExecutionRegistry",
    "setTimeout",
    "setInterval",
    "createRuntimeHost",
    "delegateTaskTool",
    "pairing",
    "Pool",
  ]) {
    expect(src.includes(forbidden), forbidden).toBe(false)
  }
  expect(src.includes("attenuateGrant")).toBe(true)
  expect(src.includes("createChildCorrelation")).toBe(true)
})

// Invalid spec shapes → deterministic deny (bukan throw domain).
test("M7 invalid: bentuk tak-valid ditolak deterministik", () => {
  expect(admitChild(null as never).admitted).toBe(false)
  expect(admitChild(spec({ kind: "turn" as never })).admitted).toBe(false)
  expect(admitChild(spec({ mode: "agent" as never })).admitted).toBe(false)
  expect(admitChild(spec({ workspaceCwd: "" })).admitted).toBe(false)
  expect(
    admitChild(
      spec({ requestedCapabilities: [{ operation: "read", resource: { kind: "fs", path: "" } }] }),
    ).admitted,
  ).toBe(false)
})
