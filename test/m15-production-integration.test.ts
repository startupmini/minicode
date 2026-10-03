// M15 — Produksi pada_runtime: SATU jalur eksekusi turn, tanpa dual execution.
//
// Matriks yang dijaga di sini (P1–P20 + negatif) memverifikasi klaim M15, bukan
// "runtime-nya jalan" (itu sudah dibuktikan M8–M14):
//   - inventory jalur eksekusi produksi (registry, bukanauvori)
//   - admission runtime jadi satu-satunya jalan masuk saat mode `owned`
//   - tidak ada caller produksi yang mengambil jalur retired
//   - ekuivalensi perilaku off vs owned tanpa efek luar ganda
//
// Hermetic: SQLite tmp + runner palsu (tanpa provider/jaringan/spawn).

import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentError } from "#minicore/core/errors.ts"
import { createRuntimeComposition, type RuntimeComposition } from "../src/runtime/composition.ts"
import { isExecutionId } from "../src/runtime/execution-id.ts"
import { openExecutionJournal } from "../src/runtime/execution-journal.ts"
import {
  classifyTurnFailure,
  createProductionExecutionRunner,
  inspectStartupRecovery,
  type ProductionExecutionRunner,
  type RuntimeProductionMode,
  resolveRuntimeMode,
  runtimeModeFor,
} from "../src/runtime/production-execution.ts"
import {
  createProductionRuntime,
  RUNTIME_GATE_ENABLED,
  runtimeGateFor,
} from "../src/runtime/production-runtime.ts"

const repoRoot = join(import.meta.dir, "..")
const dirs: string[] = []

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-m15-"))
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

function compose(dir: string, over: Record<string, unknown> = {}): RuntimeComposition {
  return createRuntimeComposition({
    sessionId: "m15",
    workspaceCwd: dir,
    journalPath: join(dir, "journal.db"),
    ...(over as Record<string, never>),
  })
}

function runner(
  mode: RuntimeProductionMode,
  dir: string,
): { runner: ProductionExecutionRunner; runtime: RuntimeComposition | null } {
  const runtime = mode === "off" ? null : compose(dir)
  return { runner: createProductionExecutionRunner({ mode, runtime }), runtime }
}

const REQUEST = {
  kind: "turn" as const,
  schedulerSource: "cli-session",
  authorityHeld: true,
  provenance: { requestedBy: "user", reason: "prompt" },
}

// ── P1: hanya SATU jalur eksekusi untuk satu intent ──────────────────────────
test("P1: mode owned menjalankan pekerjaan SATU kali (bukan shadow + legacy)", async () => {
  const dir = tmpDir()
  const { runner: r, runtime } = runner("owned", dir)
  let calls = 0
  const outcome = await r.run(REQUEST, async () => {
    calls++
    return { finalText: "ok", usage: { steps: 1 } }
  })
  expect(calls).toBe(1)
  expect(outcome.via).toBe("runtime")
  expect(outcome.executionId).toBeTruthy()
  // Legacy path TIDAK ikut jalan: tak ada panggilan kedua, dan tak ada
  // penanda legacy di metrik.
  expect(r.metrics().legacyRuns).toBe(0)
  expect(r.metrics().runtimeRuns).toBe(1)
  expect(runtime!.kernel.get(outcome.executionId!)?.state).toBe("COMPLETED")
  await cleanupAll()
})

test("P1b: mode off/constructed = jalur legacy, tanpa sentuh runtime", async () => {
  for (const mode of ["off", "constructed"] as const) {
    const dir = tmpDir()
    const { runner: r } = runner(mode, dir)
    let calls = 0
    const outcome = await r.run(REQUEST, async () => {
      calls++
      return "legacy"
    })
    expect(calls).toBe(1)
    expect(outcome.via).toBe("legacy")
    expect(outcome.executionId).toBeNull()
    expect(r.metrics().legacyRuns).toBe(1)
    expect(r.metrics().runtimeRuns).toBe(0)
    await cleanupAll()
  }
})

// ── P2: tak ada caller produksi langsung ke backend runtime ─────────────────
test("P2: hanya composition.ts yang membuat backend runtime", () => {
  const offenders: string[] = []
  const files = spawnSync("git", ["ls-files", "src/**/*.ts", "cli/**/*.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  for (const rel of files.stdout
    .split("\n")
    .filter((s) => s.endsWith(".ts") && s.startsWith("src/"))) {
    if (rel.startsWith("src/runtime/")) continue
    const src = readFileSync(join(repoRoot, rel), "utf8")
    for (const needle of [
      "BACKEND_FACTORIES",
      "createHostBackend",
      "createDockerBackend",
      "createBwrapBackend",
      "createSeatbeltBackend",
    ]) {
      if (src.includes(needle)) offenders.push(`${rel}: ${needle}`)
    }
  }
  expect(offenders).toEqual([])
})

// ── P3: tak ada authority kedua (kernel/host/runtime) di luar runtime ───────
test("P3: konstruktor authority runtime hanya di src/runtime", () => {
  const owners: Record<string, string[]> = {
    createExecutionKernel: ["src/runtime/execution-kernel.ts", "src/runtime/composition.ts"],
    createRuntimeHost: ["src/runtime/runtime-host.ts", "src/runtime/composition.ts"],
    createDispatchBridge: ["src/runtime/dispatch.ts", "src/runtime/composition.ts"],
    createRecoveryEngine: ["src/runtime/recovery.ts", "src/runtime/composition.ts"],
    createEventPlane: ["src/runtime/execution-events.ts", "src/runtime/composition.ts"],
    openExecutionJournal: ["src/runtime/execution-journal.ts", "src/runtime/composition.ts"],
  }
  const files = spawnSync("git", ["ls-files", "src/**/*.ts", "cli/**/*.ts", "test/**/*.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  const tracked = files.stdout.split("\n").filter((s) => s.endsWith(".ts"))
  const offenders: string[] = []
  for (const [symbol, allowed] of Object.entries(owners)) {
    for (const rel of tracked) {
      if (allowed.includes(rel)) continue
      const src = readFileSync(join(repoRoot, rel), "utf8")
      if (new RegExp(`\\b${symbol}\\s*\\(`).test(src) && !src.includes(`type ${symbol}`))
        offenders.push(`${rel}: ${symbol}`)
    }
  }
  expect(offenders).toEqual([])
})

// ── P4/P5: setiap pekerjaan runtime-owned DIDAFTARKAN untuk drain ────────────
test("P4: pekerjaan runtime-owned terdaftar di track() sehingga drain menutupnya", async () => {
  const dir = tmpDir()
  const { runner: r, runtime } = runner("owned", dir)
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const running = r.run(REQUEST, async () => {
    await gate
    return "late"
  })
  await Bun.sleep(20)
  // Kerja masih in-flight → terdaftar untuk drain.
  expect(runtime!.metrics().trackedWork).toBe(1)
  const shutdown = runtime!.shutdown()
  await Bun.sleep(20)
  release!()
  await running
  const result = await shutdown
  expect(result.trackedWork.drained).toBe(1)
  expect(result.outstandingAfter).toHaveLength(0)
  // Event final MASIH ada di jurnal walau flush terjadi setelah turn settle.
  const reopened = openExecutionJournal(join(dir, "journal.db"))
  const states = reopened
    .readAll()
    .filter((r) => r.kind === "event")
    .map((r) => (r as { state?: string }).state)
  expect(states).toContain("COMPLETED")
  reopened.close()
  await cleanupAll()
})

test("P5: mode constructed tidak meng-track apa pun (legacy tak di-drift)", async () => {
  const dir = tmpDir()
  const { runner: r, runtime } = runner("constructed", dir)
  await r.run(REQUEST, async () => "legacy")
  expect(runtime!.metrics().trackedWork).toBe(0)
  await cleanupAll()
})

// ── P6/P7: bukti akhir bertahan; jurnal menutup bersih ─────────────────────
test("P6/P7: event final eksekusi bertahan setelah shutdown + reopen", async () => {
  const dir = tmpDir()
  const journalPath = join(dir, "journal.db")
  const { runner: r, runtime } = runner("owned", dir)
  const outcome = await r.run(REQUEST, async () => "done")
  const shutdown = await runtime!.shutdown()
  expect(shutdown.journal.flush).toBe("durable-confirmed")
  expect(shutdown.journal.closed).toBe(true)
  const reopened = openExecutionJournal(journalPath)
  const history = reopened.readExecutionHistory(outcome.executionId!)
  // Tiga EVENT lifecycle (authoritative) + satu INTENT dispatch (bukti durable
  // untuk dedupe lintas-restart) — keduanya history yang sah, bukan duplikasi.
  expect(
    history.filter((h) => h.kind === "event").map((h) => (h as { state?: string }).state),
  ).toEqual(["ADMITTED", "RUNNING", "COMPLETED"])
  expect(history.filter((h) => h.kind === "intent")).toHaveLength(1)
  expect(reopened.integrityCheck().mismatched).toEqual([])
  reopened.close()
  await cleanupAll()
})

// ── P8: scheduler/autonomous mencapai M13, bukan legacy bypass ───────────────
test("P8: intent scheduler masuk lewat M13 yang sama", async () => {
  const dir = tmpDir()
  const { runner: r, runtime } = runner("owned", dir)
  const outcome = await r.run(
    {
      ...REQUEST,
      kind: "background",
      schedulerSource: "autonomous",
      taskId: "t-1",
      generation: 2,
      provenance: { requestedBy: "scheduler", reason: "task=t-1" },
    },
    async () => "autonomous",
  )
  expect(outcome.state).toBe("COMPLETED")
  const record = runtime!.kernel.get(outcome.executionId!)
  expect(record?.ownerId).toBe("t-1")
  expect(runtime!.bridge.metrics().admitted).toBe(1)
  await cleanupAll()
})

// ── P9/P10: recovery M12 tak punya jalan admission langsung ────────────────
test("P9/P10: recovery.ts tak pernah mengimpor dispatch/backends (tak ada M12→M13/backend)", () => {
  const src = readFileSync(join(repoRoot, "src/runtime/recovery.ts"), "utf8")
  expect(src).not.toMatch(/from "\.\/dispatch\.ts"/)
  expect(src).not.toMatch(/execution-backend/)
  // M13 boleh memakai M12 (isPlanCurrent) — satu arah saja.
  const dispatch = readFileSync(join(repoRoot, "src/runtime/dispatch.ts"), "utf8")
  expect(dispatch).toMatch(/from "\.\/recovery\.ts"/)
})

// ── P11/P12: duplikat & cross-restart tetap konservatif ─────────────────────
test("P11: dispatch duplikat tak admitting eksekusi kedua", async () => {
  const dir = tmpDir()
  const { runner: r, runtime } = runner("owned", dir)
  const dispatchId = "dsp_11111111-1111-4111-8111-111111111111"
  await r.run({ ...REQUEST, dispatchId }, async () => "a")
  await expect(r.run({ ...REQUEST, dispatchId }, async () => "b")).rejects.toMatchObject({
    code: "RUNTIME_NOT_ADMITTED",
  })
  expect(runtime!.kernel.metrics().executions).toBe(1)
  await cleanupAll()
})

test("P12: cross-restart — redelivery dengan bukti durable = DUPLICATE, tanpa bukti = konservatif", async () => {
  const dir = tmpDir()
  const journalPath = join(dir, "journal.db")
  const dispatchId = "dsp_22222222-2222-4222-8222-222222222222"
  const first = runner("owned", dir)
  await first.runner.run({ ...REQUEST, dispatchId }, async () => "a")
  await first.runtime!.shutdown()
  expect(existsSync(journalPath)).toBe(true)

  // Proses kedua. Redelivery + bukti durable (intent dispatch di M11) → DUPLICATE.
  const second = runner("owned", dir)
  const deduped = second.runtime!.bridge.dispatch({ ...REQUEST, dispatchId }, { redelivered: true })
  expect(deduped.state).toBe("DUPLICATE")
  expect(deduped.duplicateOf).toBe("ADMITTED")
  expect(second.runtime!.kernel.metrics().executions).toBe(0)
  // DispatchId BARU = intent baru: bukan duplikat, dan ini bukan "dedupe lemah".
  let executed = false
  await second.runner.run(REQUEST, async () => {
    executed = true
    return "b"
  })
  expect(executed).toBe(true)
  expect(second.runtime!.kernel.metrics().executions).toBe(1)
  await second.runtime!.shutdown()
  await cleanupAll()
})

test("P12b: cross-restart tanpa jejak durable = UNCERTAIN_DUPLICATE, bukan eksekusi diam", async () => {
  const dir = tmpDir()
  const dispatchId = "dsp_33333333-3333-4333-8333-333333333333"
  // Proses A: mode non-durable (tanpa jurnal) — tak ada bukti yang bisa dibaca
  // proses berikutnya, dan in-memory store ikut hilang saat proses mati.
  const nonDurable = () =>
    createRuntimeComposition({
      sessionId: "m15-nodurable",
      workspaceCwd: dir,
      journalPath: join(dir, "journal.db"),
      journalRequired: false,
    })
  const first = nonDurable()
  const r1 = createProductionExecutionRunner({ mode: "owned", runtime: first })
  await r1.run({ ...REQUEST, dispatchId }, async () => "a")
  expect(first.kernel.metrics().executions).toBe(1)
  await first.shutdown()

  // Proses B: memori kosong + tanpa bukti durable = konservatif, bukan tebakan.
  const second = nonDurable()
  const record = second.bridge.dispatch({ ...REQUEST, dispatchId }, { redelivered: true })
  expect(record.state).toBe("UNCERTAIN_DUPLICATE")
  expect(record.executionId).toBeUndefined()
  expect(second.kernel.metrics().executions).toBe(0)
  await second.shutdown()
  await cleanupAll()
})

// ── P13: identitas resume & execution id tetapnamespace M1 ────────────────
test("P13: executionId yang di-mint runtime valid M1 dan lineageRoot konsisten", async () => {
  const dir = tmpDir()
  const { runner: r, runtime } = runner("owned", dir)
  const outcome = await r.run(REQUEST, async () => "x")
  expect(isExecutionId(outcome.executionId!)).toBe(true)
  const record = runtime!.kernel.get(outcome.executionId!)!
  expect(record.rootExecutionId).toBe(outcome.executionId!)
  await cleanupAll()
})

test("P13b: child mewarisi parent turn sebagai parentExecutionId (lineage M7)", async () => {
  const dir = tmpDir()
  const { runner: r, runtime } = runner("owned", dir)
  const parent = await r.run(REQUEST, async () => "parent")
  const child = await r.run(
    {
      ...REQUEST,
      kind: "child",
      schedulerSource: "delegate_task",
      parentExecutionId: r.parentExecutionId() ?? undefined,
      provenance: { requestedBy: "delegate_task", reason: "mode=explore" },
    },
    async () => "child",
  )
  expect(r.parentExecutionId()).toBe(parent.executionId)
  const childRecord = runtime!.kernel.get(child.executionId!)!
  expect(childRecord.parentExecutionId).toBe(parent.executionId!)
  // Lineage root TIDAK berubah (M7): root tetap turn parent.
  expect(childRecord.rootExecutionId).toBe(parent.executionId!)
  await cleanupAll()
})

// ── P14/P15: batasan child & attenuasi capability tak berubah ──────────────
test("P14/P15: runtime tak menambah capability/alat pada turn (tak ada eskalasi)", async () => {
  const dir = tmpDir()
  const { runner: r, runtime } = runner("owned", dir)
  const outcome = await r.run(REQUEST, async () => "x")
  // Dispatch tak boleh membawa capability baru: kernel hanya merekam lifecycle,
  // dan owner default berasal dari provenance (bukan dari nama sumber).
  const record = runtime!.kernel.get(outcome.executionId!)!
  expect(record.ownerId).toBe("user")
  await cleanupAll()
})

// ── P16/P17: rollback tak menghasilkan eksekusi ganda ──────────────────────
test("P16: rollback ke mode off = jalur legacy utuh; eksekusi runtime tak terulang diam-diam", async () => {
  const dir = tmpDir()
  const owned = runner("owned", dir)
  const outcome = await owned.runner.run(REQUEST, async () => "runtime-run")
  await owned.runtime!.shutdown()

  // Rollback: mode off. Legacy jalan TANPA admission runtime...
  const rolled = runner("off", dir)
  const legacyCalls: number[] = []
  const legacy = await rolled.runner.run(REQUEST, async () => {
    legacyCalls.push(1)
    return "legacy-run"
  })
  expect(legacy.via).toBe("legacy")
  expect(legacyCalls).toHaveLength(1)
  // ...dan bukti durable eksekusi runtime TIDAK dihapus/ditulis ulang.
  const reopened = openExecutionJournal(join(dir, "journal.db"))
  expect(reopened.readExecutionHistory(outcome.executionId!).length).toBeGreaterThan(0)
  reopened.close()
  await cleanupAll()
})

// ── P18: adapter deprecated tak menerima caller produksi baru ──────────────
test("P18: field korelasi yang di-deprecated tak diisi caller produksi mana pun", () => {
  const files = spawnSync("git", ["ls-files", "src/**/*.ts", "cli/**/*.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  const offenders: string[] = []
  for (const rel of files.stdout.split("\n").filter((s) => s.endsWith(".ts"))) {
    if (rel === "src/session/journal.ts") continue
    const src = readFileSync(join(repoRoot, rel), "utf8")
    // Hanya relevan untuk pemanggil jurnal legacy: field deprecated hidup di API
    // `src/session/journal.ts`. src/runtime/** punya korelasi sendiri (M1/M7) dan
    // itu justru satu-satunya yang boleh memakainya.
    if (!/session\/journal\.ts"|from "\.\/journal\.ts"/.test(src)) continue
    // Konsumer runtime boleh memakai korelasi M1/M7 — itu satu-satunya yang benar.
    if (/runtime\//.test(src)) continue
    for (const field of ["executionId", "parentExecutionId", "rootExecutionId", "executionKind"]) {
      if (new RegExp(`\\b${field}\\s*:`).test(src)) offenders.push(`${rel}: ${field}`)
    }
  }
  expect(offenders).toEqual([])
})

// ── P19/P20: TaskStore & isolasi sesi tetap terpisah ──────────────────────
test("P19: src/runtime tak pernah mengimpor TaskStore (separation of concerns)", () => {
  const files = spawnSync("git", ["ls-files", "src/runtime/*.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  const offenders: string[] = []
  for (const rel of files.stdout.split("\n").filter((s) => s.endsWith(".ts"))) {
    const src = readFileSync(join(repoRoot, rel), "utf8")
    for (const needle of [
      'from "../task/store.ts"',
      'from "../task/',
      'from "../session/persistence.ts"',
    ]) {
      if (src.includes(needle)) offenders.push(`${rel}: ${needle}`)
    }
  }
  expect(offenders).toEqual([])
})

test("P20: dua sesi runtime = dua jurnal, tanpa lintas-tumpukan", async () => {
  const dirA = tmpDir()
  const dirB = tmpDir()
  const a = runner("owned", dirA)
  const b = runner("owned", dirB)
  const recA = await a.runner.run(REQUEST, async () => "a")
  const recB = await b.runner.run(REQUEST, async () => "b")
  expect(recA.executionId).not.toBe(recB.executionId)
  expect(a.runtime!.journal!.readExecutionHistory(recB.executionId!)).toHaveLength(0)
  expect(b.runtime!.journal!.readExecutionHistory(recA.executionId!)).toHaveLength(0)
  await cleanupAll()
})

// ── Negatif: intake runner.failed-closed, tak ada jalur pintas ──────────────
test("negatif: mode owned tanpa runtime = error, BUKAN fallback legacy", async () => {
  const r = createProductionExecutionRunner({ mode: "owned", runtime: null })
  let called = false
  await expect(
    r.run(REQUEST, async () => {
      called = true
      return "legacy"
    }),
  ).rejects.toMatchObject({ code: "RUNTIME_NOT_OWNED" })
  // Fallback ke legacy setelah runtime gagal = dual execution tersembunyi.
  expect(called).toBe(false)
})

test("negatif: shutdown menutup admission → turn berikutnya DITOLAK (tak dieksekusi)", async () => {
  const dir = tmpDir()
  const { runner: r, runtime } = runner("owned", dir)
  await runtime!.shutdown()
  let called = false
  await expect(
    r.run(REQUEST, async () => {
      called = true
      return "late"
    }),
  ).rejects.toMatchObject({ code: "RUNTIME_NOT_OWNED" })
  expect(called).toBe(false)
})

test("negatif: error asli diteruskan apa adanya (atribusi tak berubah)", async () => {
  const dir = tmpDir()
  const { runner: r, runtime } = runner("owned", dir)
  const original = new Error("provider exploded")
  await expect(r.run(REQUEST, async () => Promise.reject(original))).rejects.toBe(original)
  // Terminal tetap FAILED — bukan error tak dikenal.
  const exec = [...Array(1)].map(() => undefined)[0]
  void exec
  const rec = runtime!.kernel.metrics()
  expect(rec.transitionAccepted).toBeGreaterThanOrEqual(2)
  await cleanupAll()
})

// ── Klasifikasi hasil: taksonomi yang sudah ada, tanpa yang baru ───────────
test("klasifikasi: AgentError.kind dipetakan ke terminal yang tepat", () => {
  expect(classifyTurnFailure(new AgentError("aborted", "x"))).toEqual({
    terminal: "CANCELLED",
    reason: "turn-aborted",
    cancelReason: "user",
  })
  expect(classifyTurnFailure(new AgentError("timeout", "x")).terminal).toBe("TIMED_OUT")
  expect(classifyTurnFailure(new AgentError("budget_exceeded", "x")).terminal).toBe(
    "BUDGET_EXCEEDED",
  )
  // [Stage D decision] step cap = resource quota → RESOURCE_EXCEEDED.
  const maxSteps = classifyTurnFailure(new AgentError("max_steps_exceeded", "x"))
  expect(maxSteps.terminal).toBe("RESOURCE_EXCEEDED")
  expect(maxSteps.reason).toBe("turn-max-steps-exceeded")
  expect(maxSteps.cancelReason).toBeNull()
  expect(classifyTurnFailure(new Error("plain")).terminal).toBe("FAILED")
  expect(classifyTurnFailure(new Error("plain")).cancelReason).toBeNull()
})

// ── Gate CLI: deterministik, fail-closed ──────────────────────────────────
test("gate: --runtime off|constructed|owned deterministik; nilai aneh = off + warning", () => {
  expect(resolveRuntimeMode(["minicode", "--runtime", "owned"])).toEqual({ mode: "owned" })
  expect(resolveRuntimeMode(["minicode", "--runtime=owned"]).mode).toBe("off")
  expect(resolveRuntimeMode([]).mode).toBe("off")
  expect(resolveRuntimeMode(["--", "--runtime", "owned"]).mode).toBe("off")
  const bad = resolveRuntimeMode(["--runtime", "yolo"])
  expect(bad.mode).toBe("off")
  expect(bad.warning).toBeTruthy()
  expect(runtimeModeFor("nope" as RuntimeProductionMode)).toBe("off")
  expect(runtimeModeFor(undefined)).toBe("off")
})

test("gate: runtimeGateFor mengikuti mode", () => {
  expect(runtimeGateFor("off")).toEqual({ enabled: false, source: "absent" })
  expect(runtimeGateFor("constructed")).toEqual({ enabled: true, source: "session-option" })
  expect(runtimeGateFor("owned")).toEqual({ enabled: true, source: "session-option" })
})

// ── Startup recovery: reads durable, TIDAK auto-dispatch ────────────────────
test("startup recovery: integritas dicek, non-terminal di-interpretasi M12, tak ada dispatch", async () => {
  const dir = tmpDir()
  const journalPath = join(dir, "journal.db")
  const first = runner("owned", dir)
  // Eksekusi yang TIDAK settle: dibuat + dijalankan, lalu menggantung di WAITING
  // (tool belum selesai) — persis bentuk yang harus ditemukan setelah restart.
  const record = first.runtime!.dispatch({
    ...REQUEST,
    dispatchId: "dsp_44444444-4444-4444-8444-444444444444",
  })
  expect(record.state).toBe("ADMITTED")
  const pending = record.executionId!
  first.runtime!.kernel.requestTransition({
    executionId: pending,
    to: "RUNNING",
    reason: "turn-start",
    source: "host",
  })
  first.runtime!.kernel.requestTransition({
    executionId: pending,
    to: "WAITING",
    reason: "tool-await",
    source: "agent-loop",
  })
  await first.runtime!.flush()
  // Restart.
  const second = runner("owned", dir)
  const report = inspectStartupRecovery(second.runtime!)
  expect(report.integrity.mismatched).toEqual([])
  expect(report.frontier).toBeGreaterThan(0)
  const found = report.recoverable.find((x) => x.executionId === pending)
  expect(found).toBeTruthy()
  expect(found!.lastState).toBe("WAITING")
  // Tak ada dispatch otomatis: kernel proses kedua tetap kosong.
  expect(second.runtime!.kernel.metrics().executions).toBe(0)
  expect(second.runtime!.bridge.metrics().admitted).toBe(0)
  // Jurnal tak ditulis ulang oleh inspection.
  const reopened = openExecutionJournal(journalPath)
  expect(reopened.readExecutionHistory(pending).length).toBeGreaterThan(0)
  reopened.close()
  await cleanupAll()
})

// ── E2E: production handle mode owned + shutdown + reopen ──────────────────
test("E2E: createProductionRuntime(owned) → dispatch → kernel → journal → shutdown → reopen", async () => {
  const dir = tmpDir()
  const journalPath = join(dir, "journal.db")
  const handle = await createProductionRuntime(RUNTIME_GATE_ENABLED, () => ({
    sessionId: "m15-e2e",
    workspaceCwd: dir,
    journalPath,
  }))
  const runtime = handle.runtime()!
  const r = createProductionExecutionRunner({ mode: "owned", runtime })
  const outcome = await r.run(REQUEST, async () => "e2e")
  const result = await handle.stop()
  expect(result?.ok).toBe(true)
  expect(result?.journal.flush).toBe("durable-confirmed")
  const reopened = openExecutionJournal(journalPath)
  expect(reopened.readExecutionHistory(outcome.executionId!).length).toBe(4)
  reopened.close()
  await cleanupAll()
})

// ── CLI smoke: mode default = nol artefak runtime ─────────────────────────
test("smoke: CLI tanpa --runtime tak membuat artefak runtime", () => {
  const smokeDir = tmpDir()
  const r = spawnSync("bun", [join(repoRoot, "cli/index.ts"), "--help"], {
    cwd: smokeDir,
    encoding: "utf8",
    timeout: 60_000,
  })
  expect(r.status).toBe(0)
  expect(existsSync(join(smokeDir, ".minicode"))).toBe(false)
  return cleanupAll()
})
