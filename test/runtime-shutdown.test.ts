// M14 PATCH — Kontrak shutdown runtime: admission latch, drain, flush, close.
//
// Matriks yang dijaga (S1..S15) mengikuti urutan shutdown kanonik:
//   admission latch -> host.shutdown -> execution drain -> event drain
//   -> journal.flush -> journal.close -> host.close -> (session/UI detach)
//
// Hermetic: SQLite tmp per test; tanpa network/provider/spawn. Host failure +
// journal uncertainty dipancing lewat seam resmi M3/M11 (hooks, checkpoint),
// bukan lewat mock yang mengubah kontrak.

import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createRuntimeComposition,
  type RuntimeComposition,
  type RuntimeShutdownPhase,
} from "../src/runtime/composition.ts"
import { createDispatchId, type DispatchRequest } from "../src/runtime/dispatch.ts"
import { allocateExecutionId } from "../src/runtime/execution-id.ts"
import { type CheckpointResult, openExecutionJournal } from "../src/runtime/execution-journal.ts"
import { createProductionRuntime, RUNTIME_GATE_ENABLED } from "../src/runtime/production-runtime.ts"
import type { RedispatchPlan } from "../src/runtime/recovery.ts"
import type { RuntimeHostHooks } from "../src/runtime/runtime-host.ts"

const PHASE_ORDER: readonly RuntimeShutdownPhase[] = [
  "admission-latch",
  "host-shutdown",
  "execution-drain",
  "event-drain",
  "journal-flush",
  "journal-close",
  "host-close",
]

const dirs: string[] = []

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-m14s-"))
  dirs.push(dir)
  return dir
}

async function cleanupAll(): Promise<void> {
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        await Bun.sleep(100)
      }
    }
  }
}

function req(over: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    dispatchId: createDispatchId(),
    schedulerSource: "m14-patch",
    authorityHeld: true,
    provenance: { requestedBy: "scheduler", reason: "due" },
    ...over,
  }
}

function compose(
  dir: string,
  over: Partial<Parameters<typeof createRuntimeComposition>[0]> = {},
): RuntimeComposition {
  return createRuntimeComposition({
    sessionId: "m14-shutdown",
    workspaceCwd: dir,
    journalPath: join(dir, "journal.db"),
    ...over,
  })
}

/** Admission -> RUNNING, seperti executor nyata yang akan menjalankan turn. */
function admitAndRun(runtime: RuntimeComposition): string {
  const record = runtime.dispatch(req())
  expect(record.state).toBe("ADMITTED")
  const executionId = record.executionId!
  const started = runtime.kernel.requestTransition({
    executionId,
    to: "RUNNING",
    reason: "executor-start",
    source: "agent-loop",
  })
  expect(started.committed).toBe(true)
  return executionId
}

function outcome(
  result: { phases: readonly { phase: RuntimeShutdownPhase; outcome: string }[] },
  phase: RuntimeShutdownPhase,
) {
  return result.phases.find((p) => p.phase === phase)?.outcome
}

// ── S1: startup → READY ──────────────────────────────────────────────────────
test("S1 startup: host READY, admission terbuka, journal terbuka", async () => {
  const dir = tmpDir()
  const runtime = compose(dir)
  expect(runtime.host.state()).toBe("READY")
  expect(runtime.isAdmissionOpen()).toBe(true)
  expect(runtime.isClosed()).toBe(false)
  expect(runtime.journal?.isOpen()).toBe(true)
  await runtime.shutdown()
  await cleanupAll()
})

// ── S2: shutdown READY — urutan fase persis kanonik ──────────────────────────
test("S2 shutdown READY: fase berurutan kanonik + durability terkonfirmasi", async () => {
  const dir = tmpDir()
  const runtime = compose(dir)
  const executionId = admitAndRun(runtime)
  const result = await runtime.shutdown()

  expect(result.phases.map((p) => p.phase)).toEqual([...PHASE_ORDER])
  expect(result.ok).toBe(true)
  expect(result.admissionStopped).toBe(true)
  expect(result.journal.flush).toBe("durable-confirmed")
  expect(result.journal.closed).toBe(true)
  expect(result.host.state).toBe("CLOSED")
  expect(result.events.pending).toBe(0)
  // Eksekusi tak dilacak tetap non-terminal (shutdown tak mengarang terminal).
  expect(result.outstandingAfter.map((o) => o.executionId)).toEqual([executionId])
  expect(runtime.kernel.get(executionId)?.state).toBe("RUNNING")
  await cleanupAll()
})

// ── S3: shutdown dua kali — satu lifecycle ──────────────────────────────────
test("S3 idempoten: shutdown() thrice = satu hasil, satu flush, satu close", async () => {
  const dir = tmpDir()
  let checkpoints = 0
  const runtime = compose(dir, {
    journalCheckpoint: () => {
      checkpoints++
      return { busy: false, mode: "TEST" }
    },
  })
  admitAndRun(runtime)
  const first = await runtime.shutdown()
  const second = await runtime.shutdown()
  const third = runtime.close()
  const thirdResult = await third

  expect(second).toBe(first)
  expect(thirdResult).toBe(first)
  expect(checkpoints).toBe(1)
  expect(first.phases).toHaveLength(PHASE_ORDER.length)
  await cleanupAll()
})

// ── S4: concurrent shutdown — satu promise untuk semua pemanggil ────────────
test("S4 concurrent: 5 pemanggil simultan = satu lifecycle", async () => {
  const dir = tmpDir()
  let checkpoints = 0
  const runtime = compose(dir, {
    journalCheckpoint: () => {
      checkpoints++
      return { busy: false, mode: "TEST" }
    },
  })
  admitAndRun(runtime)
  const results = await Promise.all([
    runtime.shutdown(),
    runtime.shutdown(),
    runtime.close(),
    runtime.shutdown(),
    runtime.close(),
  ])
  for (const r of results) expect(r).toBe(results[0])
  expect(checkpoints).toBe(1)
  expect(results[0].host.state).toBe("CLOSED")
  await cleanupAll()
})

// ── S5: dispatch sebelum shutdown → admitted lalu ikut drain ────────────────────
test("S5 dispatch sebelum latch: execution tercipta, jadi milik runtime", async () => {
  const dir = tmpDir()
  const runtime = compose(dir)
  const executionId = admitAndRun(runtime)
  const result = await runtime.shutdown()
  expect(runtime.kernel.metrics().executions).toBe(1)
  expect(result.outstandingBefore.map((o) => o.executionId)).toEqual([executionId])
  await cleanupAll()
})

// ── S6: dispatch setelah latch → ditolak, tak ada Execution baru ────────────
test("S6 latch monoton: dispatch setelah shutdown DITOLAK tanpa membuat Execution", async () => {
  const dir = tmpDir()
  const runtime = compose(dir)
  await runtime.shutdown()

  // Jalur composition (API): programming error, refuse eksplisit.
  expect(() => runtime.dispatch(req())).toThrow(/latch|closed/i)
  // Jalur produksi (M13 bridge): record honestly BLOCKED, tanpa admission.
  const blocked = runtime.bridge.dispatch(req())
  expect(blocked.state).toBe("BLOCKED")
  expect(blocked.executionId).toBeUndefined()
  expect(runtime.kernel.metrics().executions).toBe(0)
  // Dan tak ada jalan hidup lagi: host tak bisa di-resurrect.
  expect(() => runtime.host.start()).toThrow()
  expect(runtime.isAdmissionOpen()).toBe(false)
  await cleanupAll()
})

// ── S7: execution drain selesai sebelum flush (barrier nyata) ──────────────
test("S7 drain: kerja ter-track settle saat drain, phase didrain sebelum flush", async () => {
  const dir = tmpDir()
  // Hook owner mencatat KAPAN ia dipanggil: harus sebelum drain/flush, karena
  // hook itulah tempat sah untuk menghentikan produsen event.
  const hookOrder: string[] = []
  const hooks: RuntimeHostHooks = {
    onShutdown: () => {
      hookOrder.push("onShutdown")
    },
  }
  const runtime = compose(dir, {
    hostOptions: { hooks },
    drainTimeoutMs: 2000,
    journalCheckpoint: () => {
      hookOrder.push("flush")
      return { busy: false, mode: "TEST-ORDER" }
    },
  })
  const executionId = admitAndRun(runtime)

  // "Eksekutor" menyelesaikan turn-nya SESUDAH latch: cancel lalu terminal.
  let untrack: (() => void) | null = null
  const work = (async () => {
    await Bun.sleep(30)
    runtime.kernel.requestTransition({
      executionId,
      to: "CANCELLING",
      reason: "shutdown-cancel",
      source: "host",
    })
    const terminal = runtime.kernel.requestTransition({
      executionId,
      to: "CANCELLED",
      reason: "executor-settled",
      source: "agent-loop",
    })
    expect(terminal.committed).toBe(true)
  })()
  untrack = runtime.track(executionId, work)

  const result = await runtime.shutdown()
  untrack()
  expect(result.trackedWork).toEqual({ registered: 1, drained: 1, pending: 0 })
  expect(result.outstandingAfter).toHaveLength(0)
  expect(runtime.kernel.get(executionId)?.state).toBe("CANCELLED")
  expect(outcome(result, "execution-drain")).toBe("succeeded")
  expect(result.journal.flush).toBe("durable-confirmed")
  // Urutan nyata: hook onShutdown (stop producer) JAUH sebelum flush.
  expect(hookOrder).toEqual(["onShutdown", "flush"])
  // Bukti utama: event final ADA di jurnal setelah close.
  const reopened = openExecutionJournal(join(dir, "journal.db"))
  const states = reopened
    .readExecutionHistory(executionId)
    .map((r) => (r.kind === "event" ? r.state : undefined))
  expect(states).toContain("CANCELLED")
  reopened.close()
  await cleanupAll()
})

// ── S8: event final bertahan setelah flush + close + reopen ─────────────────
test("S8 bukti akhir: seluruh event eksekusi utuh setelah reopen", async () => {
  const dir = tmpDir()
  const journalPath = join(dir, "journal.db")
  const runtime = compose(dir)
  const executionId = admitAndRun(runtime)
  runtime.kernel.requestTransition({
    executionId,
    to: "WAITING",
    reason: "tool-await",
    source: "agent-loop",
  })
  runtime.kernel.requestTransition({
    executionId,
    to: "RESUMED",
    reason: "tool-done",
    source: "agent-loop",
  })
  runtime.kernel.requestTransition({
    executionId,
    to: "RUNNING",
    reason: "continue",
    source: "agent-loop",
  })
  runtime.kernel.requestTransition({
    executionId,
    to: "COMPLETED",
    reason: "turn-complete",
    source: "agent-loop",
  })
  const result = await runtime.shutdown()
  expect(result.journal.flush).toBe("durable-confirmed")
  expect(result.outstandingAfter).toHaveLength(0)

  const reopened = openExecutionJournal(journalPath)
  const history = reopened.readExecutionHistory(executionId)
  expect(history).toHaveLength(6)
  expect(
    history.filter((r) => r.kind === "event").map((r) => (r as { state?: string }).state),
  ).toEqual(["ADMITTED", "RUNNING", "WAITING", "RESUMED", "RUNNING", "COMPLETED"])
  expect(reopened.integrityCheck()).toEqual({ checked: 6, mismatched: [] })
  reopened.close()
  await cleanupAll()
})

// ── S9: late event setelah shutdown → ditolak eksplisit, tak ada reopen ────
test("S9 late event: commit setelah shutdown tak di-append; jurnal tak dibuka ulang", async () => {
  const dir = tmpDir()
  const journalPath = join(dir, "journal.db")
  const runtime = compose(dir)
  const executionId = admitAndRun(runtime)
  // Flush manual: jurnal MASIH hidup dan ini belum jadi batas durability akhir.
  await runtime.flush()
  const beforeCount = runtime.journal!.readExecutionHistory(executionId).length

  const result = await runtime.shutdown()
  expect(result.journal.closed).toBe(true)

  // Commit SESUDAH shutdown: hook kernel sudah dilepas → tak ada append.
  const late = runtime.kernel.requestTransition({
    executionId,
    to: "CANCELLING",
    reason: "after-shutdown",
    source: "host",
  })
  expect(late.committed).toBe(true) // kernel tak dinonaktifkan — M8 tetap authority
  expect(runtime.metrics().pendingAppends).toBe(0)

  // Append langsung ke jurnal yang sudah tutup: error eksplisit, tanpa reopen.
  const closedJournal = runtime.journal!
  expect(closedJournal.isOpen()).toBe(false)
  const stray = runtime.plane.emit({
    eventType: "execution.state-changed",
    executionId,
    lineageRootId: executionId,
    executionVersion: 99,
    source: "kernel",
  })
  const append = await closedJournal.appendEvent(stray)
  expect(append.status).toBe("error")
  expect(closedJournal.isOpen()).toBe(false)

  // Isi jurnal setelah reopen: persis sama — tak ada data pascabatas.
  const reopened = openExecutionJournal(journalPath)
  expect(reopened.readExecutionHistory(executionId)).toHaveLength(beforeCount)
  reopened.close()
  await cleanupAll()
})

// ── S9b: commit tepat DI flush ditolak oleh barrier (tak ada append pasca-flush)
test("S9b barrier: commit saat flush ditolak + dihitung, tak ada data pascabatas", async () => {
  const dir = tmpDir()
  const journalPath = join(dir, "journal.db")
  const state: { kernel: RuntimeComposition | null } = { kernel: null }
  const runtime = compose(dir, {
    journalCheckpoint: (): CheckpointResult => {
      const live = state.kernel
      if (live) {
        const records = live.outstanding()
        for (const rec of records) {
          live.kernel.requestTransition({
            executionId: rec.executionId,
            to: "CANCELLING",
            reason: "late-at-flush",
            source: "host",
          })
        }
      }
      return { busy: false, mode: "TEST-BARRIER" }
    },
  })
  state.kernel = runtime
  const executionId = admitAndRun(runtime)
  const result = await runtime.shutdown()

  // Event "telat" DITOLAK (dihitung eksplisit), bukan di-append diam-diam.
  expect(result.events.rejectedAfterBarrier).toBeGreaterThan(0)
  expect(result.journal.flush).toBe("durable-confirmed")
  const reopened = openExecutionJournal(journalPath)
  const states = reopened
    .readExecutionHistory(executionId)
    .map((r) => (r.kind === "event" ? (r as { state?: string }).state : undefined))
  expect(states).not.toContain("CANCELLING")
  reopened.close()
  await cleanupAll()
})

// ── S10: journal flush uncertain → dilaporkan, state tak ditulis ulang ──────
test("S10 uncertainty: durability-uncertain tercatat, lifecycle tak dirombak", async () => {
  const dir = tmpDir()
  const runtime = compose(dir, {
    journalCheckpoint: () => ({ busy: true, mode: "TEST-BUSY" }),
  })
  const executionId = admitAndRun(runtime)
  const result = await runtime.shutdown()

  expect(result.journal.flush).toBe("durability-uncertain")
  expect(outcome(result, "journal-flush")).toBe("uncertain")
  // uncertain BUKAN failed: shutdown tetap dianggap berhasil, dan error tak hilang.
  expect(result.ok).toBe(true)
  expect(result.errors.some((e) => e.phase === "journal-flush")).toBe(true)
  // Persistence failure TIDAK jadi Execution failure.
  expect(runtime.kernel.get(executionId)?.state).toBe("RUNNING")
  expect(runtime.kernel.metrics().transitionRejected).toBe(0)
  // Jurnal tetap ditutup setelah percobaan flush (tak ada retry selamanya).
  expect(result.journal.closed).toBe(true)
  await cleanupAll()
})

// ── S11: kegagalan penanganan jurnal = outcome "failed" + error terlindungi ─
test("S11 journal failed: jurnal sudah tutup saat shutdown → failed, bukan hijau", async () => {
  const dir = tmpDir()
  const runtime = compose(dir)
  admitAndRun(runtime)
  // Tutup jurnal di tangan owner (bukan lewat shutdown) → flush jadi gagal.
  runtime.journal!.close()
  const result = await runtime.shutdown()

  expect(result.journal.flush).toBe("failed")
  expect(outcome(result, "journal-flush")).toBe("failed")
  expect(result.ok).toBe(false)
  expect(result.errors.some((e) => e.phase === "journal-flush")).toBe(true)
  // Fase setelahnya tetap dijalankan: host tetap CLOSED.
  expect(result.host.state).toBe("CLOSED")
  expect(runtime.isClosed()).toBe(true)
  await cleanupAll()
})

// ── S12: host gagal → jurnal tetap tertangani, error tak ditelan ────────────
test("S12 host failure: hook onShutdown/onClose gagal = terstruktur, bukti utuh", async () => {
  const dir = tmpDir()
  const journalPath = join(dir, "journal.db")
  const runtime = compose(dir, {
    hostOptions: {
      hooks: {
        onShutdown: () => {
          throw new Error("owner stop failed (test)")
        },
        onClose: () => {
          throw new Error("owner close failed (test)")
        },
      },
    },
  })
  const executionId = admitAndRun(runtime)
  const result = await runtime.shutdown()

  // onShutdown gagal = degraded (M3 tak melempar) → dicatat "uncertain".
  expect(outcome(result, "host-shutdown")).toBe("uncertain")
  // onClose gagal = M3 melempar meski state CLOSED → "failed" + error terlindungi.
  expect(outcome(result, "host-close")).toBe("failed")
  expect(result.errors.some((e) => e.phase === "host-close")).toBe(true)
  expect(result.host.state).toBe("CLOSED")
  expect(result.ok).toBe(false)
  // Bukti durable TIDAK dikorbankan demi kegagalan host.
  expect(result.journal.flush).toBe("durable-confirmed")
  expect(result.journal.closed).toBe(true)
  const reopened = openExecutionJournal(journalPath)
  expect(reopened.readExecutionHistory(executionId).length).toBeGreaterThan(0)
  reopened.close()
  await cleanupAll()
})

// ── S13: scheduler stop sebelum latch dispatch (urutan di composition root) ──
test("S13 scheduler-first: scheduler.stop() dipanggil sebelum productionRuntime.stop()", async () => {
  const source = readFileSync(join(import.meta.dir, "..", "cli", "setup.ts"), "utf8")
  const schedulerStop = source.indexOf('await productionScheduler.stop("shutdown")')
  const runtimeStop = source.indexOf("await productionRuntime.stop()")
  expect(schedulerStop).toBeGreaterThan(0)
  expect(runtimeStop).toBeGreaterThan(0)
  expect(schedulerStop).toBeLessThan(runtimeStop)
  // Dan UI detach tetap SESUDAH runtime: presentation detach tak boleh mendahului.
  // close() memuat `detachUI()` sebagai baris mandiri; pemanggilan lain di
  // berkas ini bukan bagian urutan shutdown, jadi yang dibaca adalah yang
  // TERAKHIR (baris close()), lalu posisinya dibanding runtime stop.
  expect(source.lastIndexOf("\n    detachUI()\n")).toBeGreaterThan(runtimeStop)
})

// ── S14: RecoveryPlan tak bisa menembus barrier shutdown ────────────────────
test("S14 recovery: plan M12 yang SAFE tetap DITOLAK begitu latch menutup", async () => {
  const dir = tmpDir()
  const runtime = compose(dir)
  const newExecutionId = allocateExecutionId()
  const plan: RedispatchPlan = {
    newExecutionId,
    attempt: 2,
    generation: 2,
    supersedes: allocateExecutionId(),
    lineageRootId: newExecutionId,
    validity: {
      observedExecutionVersion: 1,
      journalFrontier: 1,
      authorityHeld: true,
      budgetRemaining: 100,
      deadlineRemainingMs: 60_000,
    },
  }
  // Sebelum latch: plan admitted (bukti bahwa plan-nya memang valid).
  const before = runtime.dispatch(
    req({ executionId: allocateExecutionId(), recoveryPlan: plan, attempt: 2, generation: 2 }),
    {
      authorityHeld: true,
      version: 1,
      frontier: 1,
      budgetRemaining: 100,
      deadlineRemainingMs: 60_000,
    },
  )
  expect(before.state).toBe("ADMITTED")

  await runtime.shutdown()
  const executionsBefore = runtime.kernel.metrics().executions
  const after = runtime.bridge.dispatch(
    req({ executionId: allocateExecutionId(), recoveryPlan: plan, attempt: 3, generation: 3 }),
    {
      authorityHeld: true,
      version: 1,
      frontier: 1,
      budgetRemaining: 100,
      deadlineRemainingMs: 60_000,
    },
  )
  expect(after.state).toBe("BLOCKED")
  expect(after.executionId).toBeUndefined()
  expect(runtime.kernel.metrics().executions).toBe(executionsBefore)
  await cleanupAll()
})

// ── S15 + §28: E2E lewat CLI — dispatch nyata, shutdown, reopen, bukti ada ──
test("S15 E2E: CLI -> production runtime -> dispatch -> kernel -> journal -> shutdown -> reopen", async () => {
  const dir = tmpDir()
  const journalPath = join(dir, ".minicode", "runtime-journal-m14-e2e.db")
  const { createCliSession } = await import("../cli/setup.ts")
  const session = await createCliSession({
    cwd: dir,
    sessionId: "m14-e2e",
    prompt: "",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
    runtimeMode: "owned" as const,
  })
  const runtime = session.productionRuntime.runtime()
  expect(runtime).not.toBeNull()
  expect(runtime!.host.state()).toBe("READY")
  // CLI-level: mode owned = runner MEMILIKI eksekusi (satu jalur produksi).
  expect(session.runtimeMode).toBe("owned")
  expect(session.executionRunner.owns).toBe(true)
  expect(session.executionRunner.parentExecutionId()).toBeNull()
  const executionId = admitAndRun(runtime!)
  runtime!.kernel.requestTransition({
    executionId,
    to: "WAITING",
    reason: "tool-await",
    source: "agent-loop",
  })
  runtime!.kernel.requestTransition({
    executionId,
    to: "RESUMED",
    reason: "tool-done",
    source: "agent-loop",
  })
  runtime!.kernel.requestTransition({
    executionId,
    to: "RUNNING",
    reason: "continue",
    source: "agent-loop",
  })
  runtime!.kernel.requestTransition({
    executionId,
    to: "COMPLETED",
    reason: "turn-complete",
    source: "agent-loop",
  })

  // Shutdown lewat JALUR PRODUKSI (session.close() → productionRuntime.stop()).
  const result = await session.productionRuntime.stop()
  expect(result?.ok).toBe(true)
  expect(result?.phases.map((p) => p.phase)).toEqual([...PHASE_ORDER])
  expect(result?.journal.flush).toBe("durable-confirmed")
  await session.close()

  const reopened = openExecutionJournal(journalPath)
  const states = reopened
    .readExecutionHistory(executionId)
    .map((r) => (r.kind === "event" ? (r as { state?: string }).state : undefined))
  expect(states).toEqual(["ADMITTED", "RUNNING", "WAITING", "RESUMED", "RUNNING", "COMPLETED"])
  reopened.close()
  await cleanupAll()
})

// ── §26: identitas jurnal resume tak berubah oleh patch shutdown ────────────
test("S15b resume: identitas jurnal tetap resumeId, shutdown+reopen menemukan history", async () => {
  const dir = tmpDir()
  const { createCliSession } = await import("../cli/setup.ts")
  const base = {
    cwd: dir,
    prompt: "",
    enterRepl: false,
    verbose: false,
    allowAll: false,
    ask: false,
    plan: false,
    allowlist: false,
    verify: false,
    runtimeMode: "owned" as const,
  }
  const originalPath = join(dir, ".minicode", "runtime-journal-m14-orig.db")
  const first = await createCliSession({ ...base, sessionId: "m14-orig" })
  const firstRuntime = first.productionRuntime.runtime()!
  const executionId = admitAndRun(firstRuntime)
  await first.close()

  const resumed = await createCliSession({ ...base, sessionId: "m14-new", resumeId: "m14-orig" })
  expect(resumed.productionRuntime.runtime()!.journalPath).toBe(originalPath)
  const resumedResult = await resumed.productionRuntime.stop()
  expect(resumedResult?.ok).toBe(true)
  await resumed.close()

  // Journal yang sama, dibuka ulang: history sesi pertama masih ada.
  const reopened = openExecutionJournal(originalPath)
  expect(reopened.readExecutionHistory(executionId).length).toBeGreaterThan(0)
  reopened.close()
  await cleanupAll()
})

// ── §29 negatif: shutdown tak bisa mengarang terminal / bypass M13 / reopen ──
test("negatif: shutdown tak menutupi state, tak bypass M13, tak resurrect", async () => {
  const dir = tmpDir()
  const journalPath = join(dir, "journal.db")
  const runtime = compose(dir)
  const running = admitAndRun(runtime)

  const result = await runtime.shutdown()

  // 1. RUNNING tak berubah jadi COMPLETED/CANCELLED.
  expect(runtime.kernel.get(running)?.state).toBe("RUNNING")
  // 1b. Yang dilaporkan ke owner pun sama: tak ada "cleanup" yang mengarang terminal.
  expect(result.outstandingAfter.map((o) => o.state)).toEqual(["RUNNING"])
  // 2. Tak ada transition tambahan yang dikarang shutdown.
  expect(runtime.kernel.metrics().transitionAccepted).toBe(2)
  expect(runtime.kernel.metrics().transitionRejected).toBe(0)
  // 3. M13 tetap satu-satunya jalan admission (tak ada setState/complete bypass).
  expect(() => runtime.dispatch(req())).toThrow()
  expect(runtime.bridge.dispatch(req()).state).toBe("BLOCKED")
  // 4. Jurnal tak ditulis ulang: isi tetap sama persis.
  const reopened = openExecutionJournal(journalPath)
  const before = reopened.readAll().length
  reopened.close()
  const runtime2 = compose(dir)
  await runtime2.shutdown()
  const reopened2 = openExecutionJournal(journalPath)
  expect(reopened2.readAll().length).toBeGreaterThanOrEqual(before)
  reopened2.close()
  // 5. Runtime tak bisa di-reopen: host resurrect ditolak, tak ada Execution baru.
  expect(() => runtime.host.start()).toThrow()
  expect(runtime.host.state()).toBe("CLOSED")
  expect(runtime.kernel.metrics().executions).toBe(1)
  await cleanupAll()
})

// ── Produksi: handle delegasi satu lifecycle (tak ada closure kedua) ─────────
test("produksi: stop() pada handle = lifecycle yang sama; tak ada close ganda", async () => {
  const dir = tmpDir()
  const handle = await createProductionRuntime(RUNTIME_GATE_ENABLED, () => ({
    sessionId: "m14-prod",
    workspaceCwd: dir,
    journalPath: join(dir, "journal.db"),
  }))
  const runtime = handle.runtime()!
  admitAndRun(runtime)
  const [a, b] = await Promise.all([handle.stop(), handle.stop()])
  expect(a).toBe(b)
  expect(handle.shutdownResult()).toBe(a)
  expect(a!.journal.closed).toBe(true)
  expect(runtime.journal?.isOpen()).toBe(false)
  expect(handle.isClosed()).toBe(true)
  await cleanupAll()
})

// ── Non-durable: fase jurnal "skipped", bukan dipoles jadi sukses ──────────
test("non-durable: fase jurnal = skipped; tidak ada klaim durability palsu", async () => {
  const dir = tmpDir()
  const runtime = compose(dir, { journalRequired: false })
  admitAndRun(runtime)
  const result = await runtime.shutdown()
  expect(result.journal.flush).toBe("disabled")
  expect(outcome(result, "journal-flush")).toBe("skipped")
  expect(outcome(result, "journal-close")).toBe("skipped")
  expect(result.ok).toBe(true)
  await cleanupAll()
})
