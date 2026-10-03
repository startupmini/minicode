// M14 — Runtime composition root: SATU perakitan, nol otoritas kedua.
// Hermetic: SQLite tmp per test; tanpa network/provider/UI/CLI/spawn.

import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntimeComposition, type RuntimeComposition } from "../src/runtime/composition.ts"
import { createDispatchId, type DispatchRequest } from "../src/runtime/dispatch.ts"
import type { RecoveryContext } from "../src/runtime/recovery.ts"

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mc-m14-"))
}

async function cleanup(dir: string): Promise<void> {
  // Windows: SQLite melepas file-handle tak selalu sinkron dengan close, jadi
  // rm dicoba ulangbounded (pola yang sama dengan uji jurnal M11).
  let last: unknown = null
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (e) {
      last = e
      await Bun.sleep(100)
    }
  }
  throw last
}

function journalPathIn(dir: string, name = "journal.db"): string {
  return join(dir, name)
}

function req(over: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    dispatchId: createDispatchId(),
    schedulerSource: "m14-test-scheduler",
    authorityHeld: true,
    provenance: { requestedBy: "scheduler", reason: "due" },
    ...over,
  }
}

function recoveryCtx(over: Partial<RecoveryContext> = {}): RecoveryContext {
  return {
    authorityHeld: false,
    budgetRemaining: null,
    deadlineRemainingMs: null,
    idempotent: true,
    dedupeKeyPresent: false,
    dedupeCheckPass: false,
    verifierAvailable: false,
    ...over,
  }
}

function compose(dir: string, over: Partial<Parameters<typeof createRuntimeComposition>[0]> = {}) {
  return createRuntimeComposition({
    sessionId: "m14-session",
    workspaceCwd: dir,
    journalPath: journalPathIn(dir),
    ...over,
  })
}

// ── identity + validasi: tidak ada identitas yang diturunkan di sini ─────────
test("M14 identity: sessionId diteruskan apa adanya; opsi invalid ditolak", () => {
  const dir = tmpDir()
  const runtime = compose(dir)
  try {
    expect(runtime.sessionId).toBe("m14-session")
    expect(runtime.workspaceCwd).toBe(dir)
    expect(runtime.durable).toBe(true)
    expect(runtime.journal).not.toBeNull()
  } finally {
    void runtime.close()
  }
  const cases: Array<Record<string, unknown>> = [
    { sessionId: "" },
    { workspaceCwd: "" },
    { journalPath: "" },
    { journalPath: "a\0b.db" },
    { backend: "teleport" },
  ]
  for (const patch of cases) {
    expect(() =>
      createRuntimeComposition({
        sessionId: "s",
        workspaceCwd: dir,
        journalPath: journalPathIn(dir),
        ...(patch as Record<string, never>),
      }),
    ).toThrow()
  }
})

// ── I1: dispatch end-to-end → kernel ADMITTED + event + jurnal ────────────────
test("M14 I1: admission lewat bridge tercatat di kernel, plane, dan journal", async () => {
  const dir = tmpDir()
  const runtime = compose(dir)
  try {
    const events: string[] = []
    runtime.plane.subscribe((e) => events.push(`${e.eventType}:${e.state ?? ""}`))
    const record = runtime.dispatch(req())
    expect(record.state).toBe("ADMITTED")
    expect(record.executionId).toBeDefined()

    // Kernel = lifecycle authority: record ADMITTED dengan provenance.
    const kernelRecord = runtime.kernel.get(record.executionId!)
    expect(kernelRecord?.state).toBe("ADMITTED")
    expect(kernelRecord?.rootExecutionId).toBe(record.executionId)

    // Event plane = observasi saja (tak memegang state).
    expect(events.some((e) => e.includes("ADMITTED"))).toBe(true)

    // Journal = history: commit yang sama terekam durable.
    const flushed = await runtime.flush()
    expect(flushed.journal).toBe("durable-confirmed")
    expect(flushed.unfinished).toBe(0)
    expect(runtime.journal?.readExecutionHistory(record.executionId!).length).toBeGreaterThan(0)
  } finally {
    await runtime.close()
    await cleanup(dir)
  }
})

// ── I2: idempotensi dispatch — tak ada execution ganda ───────────────────────
test("M14 I2: dispatch duplikat tidak admission ulang", async () => {
  const dir = tmpDir()
  const runtime = compose(dir)
  try {
    const request = req()
    const first = runtime.dispatch(request)
    const second = runtime.dispatch(request)
    expect(first.state).toBe("ADMITTED")
    expect(second.state).toBe("DUPLICATE")
    expect(second.executionId).toBe(first.executionId)
    expect(runtime.kernel.metrics().executions).toBe(1)
  } finally {
    await runtime.close()
    await cleanup(dir)
  }
})

// ── I3: host pre-check — tak ada admission setelah host tidak menerima ──────
test("M14 I3: bridge memblokir admission ketika host tidak READY", async () => {
  const dir = tmpDir()
  const runtime = compose(dir)
  try {
    await runtime.host.shutdown()
    expect(runtime.host.state()).not.toBe("READY")
    const record = runtime.bridge.dispatch(req())
    expect(record.state).toBe("BLOCKED")
    expect(record.reason).toContain("host")
    expect(runtime.kernel.metrics().executions).toBe(0)
  } finally {
    await runtime.close()
    await cleanup(dir)
  }
})

// ── I4: fail-closed journal —gagalkonstruksi, bukan jurnal null diam-diam ────
test("M14 I4: journal wajib yang tak bisa dibuka = kegagalan konstruksi", async () => {
  const dir = tmpDir()
  // Direktori sebagai path DB: open pasti gagal (bukan kondisi jauh).
  const asDir = join(dir, "journal-as-dir")
  rmSync(asDir, { force: true })
  Bun.spawnSync({ cmd: ["cmd", "/c", "mkdir", asDir] })
  expect(() => compose(dir, { journalPath: asDir })).toThrow(/journal/i)
  await cleanup(dir)
})

// ── I5: isolasi antar komposisi (tak ada state global) ─────────────────────
test("M14 I5: dua komposisi terisolasi penuh", async () => {
  const dirA = tmpDir()
  const dirB = tmpDir()
  const a = compose(dirA, { sessionId: "sess-a" })
  const b = compose(dirB, { sessionId: "sess-b" })
  try {
    const seenByB: string[] = []
    b.plane.subscribe((e) => seenByB.push(e.executionId))
    const recA = a.dispatch(req())
    expect(recA.state).toBe("ADMITTED")
    expect(seenByB).toHaveLength(0)
    expect(b.kernel.metrics().executions).toBe(0)
    // Append M11 async: history hanya boleh dibaca SETELAH drain — membaca
    // sebelum flush bukan bukti apa pun (dan tak boleh diklaim sebagai durability).
    await a.flush()
    expect(a.journal?.readExecutionHistory(recA.executionId!).length).toBeGreaterThan(0)
    expect(b.journal?.readAll().filter((r) => r.executionId === recA.executionId)).toHaveLength(0)
  } finally {
    await a.close()
    await b.close()
    await cleanup(dirA)
    await cleanup(dirB)
  }
})

// ── I6: restart — recovery membaca bukti durable, bukan state in-memory ─────
test("M14 I6: composisi baru merekonstruksi dari jurnal yang sama", async () => {
  const dir = tmpDir()
  const first = compose(dir)
  const rec = first.dispatch(req())
  expect(rec.state).toBe("ADMITTED")
  await first.close()

  const second = compose(dir)
  try {
    // Terminal pada proses kedua: hanya boleh lewat kernel MILIKNYA SENDIRI,
    // bukti diambil dari jurnal proses pertama.
    const history = second.journal?.readExecutionHistory(rec.executionId!) ?? []
    expect(history.length).toBeGreaterThan(0)
    expect(second.kernel.get(rec.executionId!)).toBeUndefined()
    const interpretation = second.recover(rec.executionId!, recoveryCtx())
    expect(interpretation.executionId).toBe(rec.executionId!)
    expect(interpretation.provenance.journalFrontier).toBeGreaterThan(0)
  } finally {
    await second.close()
    await cleanup(dir)
  }
})

// ── I7: shutdown idempoten + latch admission ───────────────────────────────
test("M14 I7: close() idempoten dan menutup jalan admission", async () => {
  const dir = tmpDir()
  const runtime = compose(dir)
  runtime.dispatch(req())
  await runtime.close()
  expect(runtime.isClosed()).toBe(true)
  expect(runtime.journal?.isOpen()).toBe(false)
  expect(runtime.host.state()).toBe("CLOSED")
  // Idempoten: panggil kedua tak melempar dan tak mengubah apa pun.
  await runtime.close()
  expect(runtime.metrics().closed).toBe(true)
  // Latch: tak ada admission baru setelah close.
  expect(() => runtime.dispatch(req())).toThrow(/close/)
  await cleanup(dir)
})

// ── I8: mode non-durable eksplisit — jujur soal kehilangan history ─────────
test("M14 I8: journalRequired=false = mode non-durable yang dilaporkan jujur", async () => {
  const dir = tmpDir()
  const runtime = compose(dir, { journalRequired: false })
  try {
    expect(runtime.durable).toBe(false)
    expect(runtime.journal).toBeNull()
    const rec = runtime.dispatch(req())
    expect(rec.state).toBe("ADMITTED")
    const flushed = await runtime.flush()
    expect(flushed.journal).toBe("disabled")
    expect(runtime.metrics().journal).toBeNull()
    // Interpretation tanpa bukti = tak boleh mengarang Yakini.
    const interpretation = runtime.recover(rec.executionId!, recoveryCtx())
    expect(interpretation.interpretation).not.toBe("CONFIRMED_EXECUTED")
  } finally {
    await runtime.close()
    await cleanup(dir)
  }
})

// ── I9: tak ada otoritas lifecycle kedua (supervisor tetap lewat kernel) ────
test("M14 I9: supervisor: cancellation tetap melewati kernel", async () => {
  const dir = tmpDir()
  const runtime = compose(dir)
  try {
    const rec = runtime.dispatch(req())
    const executionId = rec.executionId!
    runtime.kernel.requestTransition({
      executionId,
      to: "RUNNING",
      reason: "start",
      source: "host",
    })
    // M9 mapped reason → terminal; kernel tetap satu-satunya penulis state.
    // Dari RUNNING, terminal langsung DITOLAK kernel — jadi supervisor wajib
    // lewat CANCELLING dulu (bukan jalan pintas kedua lifecycle authority).
    const cancel = runtime.supervisor.requestCancel(executionId, "user")
    expect(cancel.requested).toBe(true)
    expect(runtime.kernel.get(executionId)?.state).toBe("CANCELLING")
    const settled = runtime.supervisor.settleCancellation(executionId, "user")
    expect(settled.terminal).toBe("CANCELLED")
    expect(settled.requested).toBe(true)
    expect(runtime.kernel.get(executionId)?.state).toBe("CANCELLED")
    // Terminal sticky:-charges kedua tak boleh menimpa.
    const again = runtime.supervisor.settleCancellation(executionId, "timeout")
    expect(again.requested).toBe(false)
    expect(runtime.kernel.get(executionId)?.state).toBe("CANCELLED")
    await runtime.flush()
    const history = runtime.journal?.readExecutionHistory(executionId) ?? []
    expect(history.length).toBeGreaterThanOrEqual(3)
    expect(history.every((r) => r.kind === "event")).toBe(true)
  } finally {
    await runtime.close()
    await cleanup(dir)
  }
})

// ── I10: lapisan komposisi tidak menyeret domain/UI/CLI ──────────────────────
test("M14 I10: composition.ts tak mengimpor scheduler/TaskStore/UI/CLI/persistence", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "src", "runtime", "composition.ts"),
    "utf8",
  )
  const forbidden = [
    "../task/",
    "../tools/",
    "../policy/",
    "../ui/",
    "../cli/",
    "session/persistence",
    "session/journal",
    "node:child_process",
    "child_process",
  ]
  for (const needle of forbidden) {
    expect(source.includes(needle)).toBe(false)
  }
  // Hanya boleh mengimpor modul runtime yang sudah ada (M5/M8–M13).
  const imported = [...source.matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1] ?? "")
  expect(imported.length).toBeGreaterThan(0)
  for (const mod of imported) {
    expect([
      "execution-backend.ts",
      "execution-events.ts",
      "execution-journal.ts",
      "execution-kernel.ts",
      "recovery.ts",
      "runtime-host.ts",
      "dispatch.ts",
      "supervisor.ts",
    ]).toContain(mod)
  }
})

// ── I11: composition adalah handle tunggal yang bisa ditutup paraPemilik ─────
test("M14 I11: handle yang dikembalikan menutup semua anak runtime", async () => {
  const dir = tmpDir()
  const runtime: RuntimeComposition = compose(dir)
  runtime.dispatch(req())
  const metrics = runtime.metrics()
  expect(metrics.kernel.executions).toBe(1)
  expect(metrics.plane.emitted).toBeGreaterThan(0)
  expect(metrics.bridge.admitted).toBe(1)
  // Append M11 async: metrik jurnal baru bermakna setelah drain.
  expect(metrics.pendingAppends).toBeGreaterThanOrEqual(0)
  await runtime.flush()
  expect(runtime.metrics().journal?.appendCount ?? 0).toBeGreaterThan(0)
  expect(runtime.metrics().pendingAppends).toBe(0)
  await runtime.close()
  expect(runtime.metrics().journal?.appendCount ?? 0).toBeGreaterThan(0)
  await cleanup(dir)
})
