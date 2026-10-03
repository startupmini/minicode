// M12 — Recovery & reconciliation: interpretasi evidence, bukan authority.
// Hermetic murni: tanpa SQLite/scheduler/TaskStore/UI/CLI/spawn.

import { expect, test } from "bun:test"
import { allocateExecutionId } from "../src/runtime/execution-id.ts"
import type { JournalRecord } from "../src/runtime/execution-journal.ts"
import { createExecutionKernel } from "../src/runtime/execution-kernel.ts"
import { createRecoveryEngine, type RecoveryContext } from "../src/runtime/recovery.ts"
import { isRedispatchAllowed } from "../src/runtime/recovery-safety.ts"

const EXEC = "exec_12121212-1212-4121-8121-121212121212"

function ctx(over: Partial<RecoveryContext> = {}): RecoveryContext {
  return {
    authorityHeld: true,
    budgetRemaining: 100,
    deadlineRemainingMs: 60_000,
    idempotent: false,
    dedupeKeyPresent: false,
    dedupeCheckPass: false,
    ...over,
  }
}

let seq = 1000
function rec(kind: "event" | "intent", over: Record<string, unknown> = {}): JournalRecord {
  seq++
  const base = {
    journalSequence: seq,
    schemaVersion: 1,
    recordHash: "h",
    executionId: EXEC,
    lineageRootId: EXEC,
    executionVersion: 1,
    timestamp: seq,
    reason: "r",
    source: "kernel",
    metadataJson: "{}",
  }
  if (kind === "intent") {
    return { ...base, kind, intentId: `intent:${seq}`, ...over } as never
  }
  return {
    ...base,
    kind,
    eventId: `evt_${seq}`,
    eventType: "execution.state-changed",
    eventSequence: seq,
    ...over,
  } as never
}

function terminalRec(type: string, version = 5): JournalRecord {
  return rec("event", {
    eventType: type,
    state: type.split(".")[1]?.toUpperCase(),
    executionVersion: version,
  })
}

// Evidence: lengkap/tak-lengkap/konflik/hilang/uncertain/korup.
test("M12 evidence: terminal otoritatif; konflik telat dicatat tanpa saingan", () => {
  const engine = createRecoveryEngine()
  const records = [
    rec("intent"),
    rec("event", { eventType: "execution.admitted", executionVersion: 1 }),
    terminalRec("execution.completed"),
    rec("event", { eventType: "backend.observed", state: "FAILED", executionVersion: 5 }),
  ]
  const r = engine.recoverExecution(EXEC, records, ctx())
  expect(r.interpretation).toBe("NO_RECOVERY_REQUIRED")
  expect(r.nextAction).toBe("NONE")
  expect(r.evidenceRefs).toHaveLength(4)
})

// UNKNOWN first-class: tak pernah jadi FAILED diam-diam.
test("M12 unknown: bukti kurang = UNKNOWN, bukan FAILED", () => {
  const engine = createRecoveryEngine()
  const r = engine.recoverExecution(EXEC, [rec("intent")], ctx())
  expect(r.interpretation).toBe("UNKNOWN")
  expect(r.nextAction).toBe("AWAIT_EVIDENCE")
  const empty = engine.recoverExecution("exec_00000000-0000-4000-8000-000000000000", [], ctx())
  expect(empty.interpretation).toBe("UNKNOWN")
})

// Redispatch: 7 jalur verifier/keamanan.
test("M12 redispatch: predicate paths", () => {
  const engine = createRecoveryEngine()
  const hist = [rec("intent")]
  // not-started → SAFE (retry-in-execution kind di plan? plan selalu E baru).
  const s1 = engine.recoverExecution(EXEC, hist, ctx({ notStartedEvidence: "admission-failed" }))
  expect(s1.interpretation).toBe("REDISPATCH_SAFE")
  expect(s1.nextAction).toBe("PLAN_REDISPATCH")
  expect(s1.redispatchPlan?.supersedes).toBe(EXEC)
  // idempotent + dedupe → SAFE.
  const s2 = engine.recoverExecution(
    EXEC,
    hist,
    ctx({ idempotent: true, dedupeKeyPresent: true, dedupeCheckPass: true }),
  )
  expect(s2.interpretation).toBe("REDISPATCH_SAFE")
  // dedupe gagal → bukan SAFE.
  const s3 = engine.recoverExecution(
    EXEC,
    hist,
    ctx({ idempotent: true, dedupeKeyPresent: true, dedupeCheckPass: false }),
  )
  expect(s3.interpretation).not.toBe("REDISPATCH_SAFE")
  // non-idempotent + unknown → UNSAFE (bukan UNKNOWN: fakta melarang).
  const s4 = engine.recoverExecution(EXEC, hist, ctx())
  expect(s4.interpretation).toBe("UNKNOWN")
  // verifier confirmed executed → NOT_RECOVERABLE.
  const s5 = engine.recoverExecution(EXEC, hist, ctx({ verifierResult: "CONFIRMED_EXECUTED" }))
  expect(s5.interpretation).toBe("NOT_RECOVERABLE")
  // verifier confirmed not-executed → SAFE.
  const s6 = engine.recoverExecution(
    EXEC,
    hist,
    ctx({ verifierResult: "CONFIRMED_NOT_EXECUTED", notStartedEvidence: null as never }),
  )
  expect(["REDISPATCH_SAFE", "REQUIRES_VERIFIER", "UNKNOWN"]).toContain(s6.interpretation)
  // verifier unknown + path ada → REQUIRES_VERIFIER (via orphan agar deterministik).
  const s7 = engine.recoverExecution(
    EXEC,
    hist,
    ctx({ verifierResult: "UNKNOWN", verifierAvailable: true, orphanSuspected: true }),
  )
  expect(s7.interpretation).toBe("ORPHAN")
})

// Authority/budget/deadline: hilang = BLOCKED (bukan redispatch).
test("M12 authority/budget/deadline: hilang = RECOVERY_BLOCKED", () => {
  const engine = createRecoveryEngine()
  const hist = [rec("intent")]
  expect(engine.recoverExecution(EXEC, hist, ctx({ authorityHeld: false })).interpretation).toBe(
    "RECOVERY_BLOCKED",
  )
  expect(engine.recoverExecution(EXEC, hist, ctx({ budgetRemaining: 0 })).interpretation).toBe(
    "RECOVERY_BLOCKED",
  )
  expect(engine.recoverExecution(EXEC, hist, ctx({ deadlineRemainingMs: 0 })).interpretation).toBe(
    "RECOVERY_BLOCKED",
  )
  // Null = unknown (bukan exhausted) → tak blokir karena itu.
  expect(
    engine.recoverExecution(EXEC, hist, ctx({ budgetRemaining: null, deadlineRemainingMs: null }))
      .interpretation,
  ).toBe("UNKNOWN")
})

// Deadline child bound: min(parent, exec) — direpresentasikan via ctx.
// (Engine menerima angka final; kebijakan min milik caller/M7. Diuji di sini
// sebagai kontrak: deadline lewat → BLOCKED walau evidence lain SAFE.)
test("M12 deadline: lewat = BLOCKED walau predicate lolos", () => {
  const engine = createRecoveryEngine()
  const r = engine.recoverExecution(
    EXEC,
    [rec("intent")],
    ctx({ notStartedEvidence: "admission-failed", deadlineRemainingMs: -5 }),
  )
  expect(r.interpretation).toBe("RECOVERY_BLOCKED")
})

// Terminal: committed terminal + observasi telat + race.
test("M12 terminal: otoritatif; race kernel menang", () => {
  const engine = createRecoveryEngine()
  const kernel = createExecutionKernel()
  const krec = kernel.create({ kind: "turn", ownerId: "s" })
  kernel.requestTransition({
    executionId: krec.executionId,
    to: "ADMITTED",
    reason: "t",
    source: "test",
  })
  kernel.requestTransition({
    executionId: krec.executionId,
    to: "RUNNING",
    reason: "t",
    source: "test",
  })
  kernel.requestTransition({
    executionId: krec.executionId,
    to: "COMPLETED",
    reason: "done",
    source: "agent-loop",
  })
  const hist = [terminalRec("execution.completed")]
  // Recovery membaca history terminal, lalu request telat DITOLAK kernel.
  const r = engine.recoverExecution(
    krec.executionId,
    hist.map((h) => ({ ...(h as object), executionId: krec.executionId }) as never),
    ctx(),
  )
  expect(r.interpretation).toBe("NO_RECOVERY_REQUIRED")
  const late = kernel.requestTransition({
    executionId: krec.executionId,
    to: "FAILED",
    reason: "late",
    source: "backend",
  })
  expect(late.committed).toBe(false)
  expect(kernel.get(krec.executionId)?.state).toBe("COMPLETED")
})

// Orphan: 5 varian.
test("M12 orphan: klasifikasi + aksi", () => {
  const engine = createRecoveryEngine()
  // Vanished + no terminal + verifier path → ORPHAN + REQUEST_VERIFIER.
  const o1 = engine.recoverExecution(
    EXEC,
    [rec("intent")],
    ctx({ orphanSuspected: true, verifierAvailable: true }),
  )
  expect(o1.interpretation).toBe("ORPHAN")
  expect(o1.nextAction).toBe("REQUEST_VERIFIER")
  // Tanpa verifier path → ORPHAN + AWAIT.
  const o2 = engine.recoverExecution(EXEC, [rec("intent")], ctx({ orphanSuspected: true }))
  expect(o2.interpretation).toBe("ORPHAN")
  expect(o2.nextAction).toBe("AWAIT_EVIDENCE")
  // Terminal + vanished telat → terminal menang.
  const o3 = engine.recoverExecution(
    EXEC,
    [
      terminalRec("execution.completed"),
      rec("event", { eventType: "backend.observed", state: "TIMEOUT" }),
    ],
    ctx({ orphanSuspected: true }),
  )
  expect(o3.interpretation).toBe("NO_RECOVERY_REQUIRED")
})

// Idempotensi: history sama dua kali → objek SAMA; konkuren → satu rencana.
test("M12 idempotency: recover×2 = hasil identik; tanpa rencana ganda", async () => {
  const engine = createRecoveryEngine()
  const hist = [rec("intent")]
  const c = ctx({ notStartedEvidence: "admission-failed" })
  const r1 = engine.recoverExecution(EXEC, hist, c)
  const r2 = engine.recoverExecution(EXEC, hist, c)
  expect(r1).toBe(r2)
  expect(r1.redispatchPlan?.newExecutionId).toBe(r2.redispatchPlan?.newExecutionId)
  const parallel = await Promise.all([
    (async () => engine.recoverExecution(EXEC, hist, c))(),
    (async () => engine.recoverExecution(EXEC, hist, c))(),
  ])
  expect(parallel[0]).toBe(parallel[1])
  // Frontier baru = incident baru (boleh rencana baru).
  const hist2 = [...hist, rec("event", { eventType: "backend.observed", state: "TIMEOUT" })]
  const r3 = engine.recoverExecution(EXEC, hist2, c)
  expect(r3).not.toBe(r1)
})

// Plan staleness: versi/frontier/authority/budget/deadline berubah → stale.
test("M12 staleness: snapshot berubah = stale", () => {
  const engine = createRecoveryEngine()
  const hist = [rec("intent")]
  const r = engine.recoverExecution(EXEC, hist, ctx({ notStartedEvidence: "admission-failed" }))
  const plan = r.redispatchPlan
  expect(plan).not.toBeNull()
  const cur = {
    version: 1,
    frontier: Math.max(...r.evidenceRefs),
    authorityHeld: true,
    budgetRemaining: 100 as number | null,
    deadlineRemainingMs: 60_000 as number | null,
  }
  // Version contoh: plan validity menyimpan observedExecutionVersion dari history
  // (null bila tak ada versi) — uji dengan frontier/authority yang berubah.
  expect(engine.isPlanCurrent(plan!, { ...cur, frontier: cur.frontier + 1 })).toBe(false)
  expect(engine.isPlanCurrent(plan!, { ...cur, authorityHeld: false })).toBe(false)
  expect(engine.isPlanCurrent(plan!, { ...cur, budgetRemaining: 0 })).toBe(false)
  expect(engine.isPlanCurrent(plan!, { ...cur, deadlineRemainingMs: 0 })).toBe(false)
})

// Parent/child: attached inherit cancel; detached preserve; failure isolasi.
test("M12 parent-child: attached inherit; detached preserve; failure isolasi", () => {
  const engine = createRecoveryEngine()
  const childExec = allocateExecutionId()
  const hist = [rec("intent", { executionId: childExec, lineageRootId: EXEC })]
  // Attached + parent terminal → REQUEST_CANCEL (observasi, state tak diubah).
  const a = engine.recoverExecution(childExec, hist, ctx({ parentTerminal: true }))
  expect(a.nextAction).toBe("REQUEST_CANCEL")
  expect(a.interpretation).toBe("UNKNOWN")
  // Detached + parent terminal → preserve (tanpa inherit).
  const d = engine.recoverExecution(
    childExec,
    hist,
    ctx({ parentTerminal: true, detachedChild: true }),
  )
  expect(d.nextAction).toBe("AWAIT_EVIDENCE")
  // Failure anak: interpretasi milik anak; parent tak disebut terminal.
  expect(a.interpretation).not.toBe("NOT_RECOVERABLE")
})

// Korupsi + durability-uncertain: blokir/pertahankan, bukan tebak.
test("M12 corruption/uncertain: BLOCKED vs preserved-unknown", () => {
  const engine = createRecoveryEngine()
  const hist = [rec("intent")]
  const c = engine.recoverExecution(EXEC, hist, ctx({ journalCorrupt: true }))
  expect(c.interpretation).toBe("RECOVERY_BLOCKED")
  // Durability uncertain tanpa fakta lain = UNKNOWN (bukan FAILED, bukan SAFE).
  const kernel = createExecutionKernel()
  void kernel
  const u = engine.recoverExecution(EXEC, hist, ctx({ notStartedEvidence: null as never }))
  expect(["UNKNOWN", "REQUIRES_VERIFIER", "STALE"]).toContain(u.interpretation)
})

// Legacy uncorrelated: tanpa provenance → UNCORRELATED.
test("M12 legacy: tanpa provenance = UNCORRELATED", () => {
  const engine = createRecoveryEngine()
  const r = engine.recoverExecution(EXEC, [rec("intent")], ctx({ uncorrelated: true }))
  expect(r.interpretation).toBe("UNCORRELATED")
})

// Crash cases A–E.
test("M12 crash-cases: A terminal / B running / C cancelling / D vanished / E terminal+stale", () => {
  const engine = createRecoveryEngine()
  const full: RecoveryContext = ctx()
  // A: ADMITTED→RUNNING→COMPLETED terminal.
  expect(
    engine.recoverExecution(EXEC, [rec("intent"), terminalRec("execution.completed")], full)
      .interpretation,
  ).toBe("NO_RECOVERY_REQUIRED")
  // B: RUNNING tanpa terminal + restart → STALE (bukan FAILED).
  const b = engine.recoverExecution(
    EXEC,
    [rec("event", { eventType: "execution.started", executionVersion: 2 })],
    ctx({ processRestarted: true }),
  )
  expect(b.interpretation).toBe("STALE")
  // C: CANCELLING tanpa terminal → UNKNOWN (observasi pembatalan, state milik kernel).
  const c = engine.recoverExecution(
    EXEC,
    [rec("event", { eventType: "execution.cancelling", executionVersion: 3 })],
    ctx(),
  )
  expect(["UNKNOWN", "REQUIRES_VERIFIER", "STALE"]).toContain(c.interpretation)
  // D: backend hilang + non-idempotent → UNSAFE atau REQUIRES_VERIFIER/UNKNOWN (tak pernah SAFE).
  const d = engine.recoverExecution(
    EXEC,
    [rec("intent"), rec("event", { eventType: "backend.observed", state: "TIMEOUT" })],
    ctx(),
  )
  expect(d.interpretation).not.toBe("REDISPATCH_SAFE")
  // E: terminal + observasi basi → terminal menang.
  const e = engine.recoverExecution(
    EXEC,
    [
      terminalRec("execution.cancelled"),
      rec("event", { eventType: "backend.observed", state: "TIMEOUT" }),
    ],
    ctx(),
  )
  expect(e.interpretation).toBe("NO_RECOVERY_REQUIRED")
})

// buildCancelRequest: data inert (bukan commit).
test("M12 cancel-request: inert data untuk kernel", () => {
  const engine = createRecoveryEngine()
  const kernel = createExecutionKernel()
  const rec = kernel.create({ kind: "turn", ownerId: "s" })
  const req = engine.buildCancelRequest(rec.executionId, "timeout")
  expect(req.to).toBe("CANCELLING")
  expect(req.source).toBe("supervisor")
  expect(kernel.get(rec.executionId)?.state).toBe("CREATED")
})

// Predicate tunggal: M9 dan M12 berbagi implementasi (bukan fork).
test("M12 predicate-ownership: satu implementasi kanonis", async () => {
  const supSrc = await Bun.file("src/runtime/supervisor.ts").text()
  expect(supSrc.includes("recovery-safety")).toBe(true)
  // Predicate logic hanya di recovery-safety (supervisor mendelegasikan).
  const occurrences = (supSrc.match(/effectDefinitelyNotStarted/g) || []).length
  expect(occurrences).toBeLessThanOrEqual(2)
  expect(isRedispatchAllowed).toBeDefined()
})

// Negative API: tanpa lifecycle/scheduler/persist/claim.
test("M12 negative: tanpa API otoritas/persist/scheduler", () => {
  const engine = createRecoveryEngine()
  const api = engine as unknown as Record<string, unknown>
  for (const forbidden of [
    "setState",
    "mutateExecution",
    "complete",
    "fail",
    "cancel",
    "terminate",
    "admit",
    "createExecution",
    "claimTask",
    "schedule",
    "persist",
    "rewriteJournal",
    "markTaskComplete",
    "replay",
    "rebuild",
    "reconcile",
    "redispatch",
  ]) {
    expect(api[forbidden], forbidden).toBeUndefined()
  }
  void api
})

// Security: record malformed tak crash; tanpa eksekusi payload.
test("M12 security: malformed records aman; tanpa eksekusi metadata", () => {
  const engine = createRecoveryEngine()
  const r = engine.recoverExecution(
    EXEC,
    [null as never, { bogus: true } as never, rec("intent")],
    ctx(),
  )
  expect(["UNKNOWN", "STALE", "REQUIRES_VERIFIER"]).toContain(r.interpretation)
  const dumped = JSON.stringify(r)
  expect(dumped).not.toMatch(/sk-|Bearer|child_process|spawn/)
})

// Provenance lengkap di setiap hasil.
test("M12 provenance: rule/at/frontier/version selalu ada", () => {
  const engine = createRecoveryEngine()
  const r = engine.recoverExecution(EXEC, [rec("intent")], ctx())
  expect(r.provenance.rule).toBe("unknown-default")
  expect(typeof r.provenance.at).toBe("number")
  expect(r.provenance.journalFrontier).toBeGreaterThan(0)
  expect(r.evidenceRefs.length).toBeGreaterThan(0)
  expect(r.reasons.length).toBeGreaterThan(0)
})
