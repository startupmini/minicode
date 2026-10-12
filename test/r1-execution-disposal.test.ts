// R1 (P9.0 remediasi) — kontrak disposal record eksekusi backend:
// pemanggil-pemilik; timeout TIDAK membuang record eksekusi hidup; dispose
// hanya pasca-terminal (escalate); akses pasca-dispose jujur "unknown";
// siklus berulang tak menumpuk record; shutdown komposisi membersihkan
// miliknya. Deterministik: semua asersi dari hasil wait/observe yang
// di-await (close terobservasi = bukti terminal), proses nyata berumur
// pendek — pola M5/supervisor tests, tanpa sleep ordering.
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntimeComposition } from "../src/runtime/composition.ts"
import {
  BACKEND_CAPABILITIES,
  type BackendHandle,
  type BackendWaitResult,
  createHostBackend,
  type ExecutionBackend,
} from "../src/runtime/execution-backend.ts"
import { createExecutionKernel } from "../src/runtime/execution-kernel.ts"
import { createSupervisor } from "../src/runtime/supervisor.ts"

const NODE = JSON.stringify(process.execPath)
const sleeper = (ms: number): string => `${NODE} -e "setTimeout(()=>{},${ms})"`
const quickExit = (code: number): string => `${NODE} -e "process.exit(${code})"`
const sigtermIgnorer = (ms: number): string =>
  `${NODE} -e "process.on('SIGTERM',()=>{});setTimeout(()=>{},${ms})"`

/** Residensi perilaku: observe jujur "no such handle" bila record sudah dibuang. */
function resident(backend: ExecutionBackend, handle: BackendHandle): boolean {
  const o = backend.observe(handle)
  return !(o.status === "unknown" && (o.error ?? "").includes("no such handle"))
}

/** Backend berskrip untuk urutan dispose↔terminal — deterministik lintas platform. */
function scriptedBackend(script: { wait1: BackendWaitResult; wait2: BackendWaitResult }): {
  backend: ExecutionBackend
  calls: string[]
} {
  const calls: string[] = []
  let waitIdx = 0
  const handle: BackendHandle = { id: "be_skrip", kind: "host" }
  const backend: ExecutionBackend = {
    kind: "host",
    capabilities: BACKEND_CAPABILITIES.host,
    admit: () => ({ admitted: true }),
    start: async () => ({ started: true as const, handle }),
    observe: () => ({ status: "running" as const }),
    cancel: () => {
      calls.push("cancel")
      return { status: "cancel-requested" as const, via: "skrip" }
    },
    terminate: () => {
      calls.push("terminate")
      return { status: "termination-requested" as const, via: "skrip" }
    },
    wait: async () => {
      calls.push(`wait:${waitIdx}`)
      const r = waitIdx === 0 ? script.wait1 : script.wait2
      waitIdx++
      return r
    },
    dispose: () => {
      calls.push("dispose")
      return { disposed: true as const, cleanupKillAttempted: false }
    },
    disposeAll: () => ({ disposed: 0 }),
  }
  return { backend, calls }
}

/** Start deterministik: gagal = setup error, bukan asersi palsu. */
async function started(backend: ExecutionBackend, cmd: string): Promise<BackendHandle> {
  const s = await backend.start({ cmd })
  if (!s.started) throw new Error(`setup gagal: ${s.reason}`)
  return s.handle
}

// ── R1-a: timeout mempertahankan record eksekusi hidup ───────────────────────
test("R1-a: wait timeout → record eksekusi hidup tetap tersedia bagi pemiliknya", async () => {
  const backend = createHostBackend()
  const h = await started(backend, sleeper(30_000))
  const w = await backend.wait(h, 150)
  expect(w).toEqual({ status: "timeout" })
  expect(backend.observe(h).status).toBe("running")
  // Owner masih bisa memantau ulang: record TIDAK dibuang oleh timeout.
  const w2 = await backend.wait(h, 100)
  expect(w2).toEqual({ status: "timeout" })
  // Bersih milik test: abandon kontraktual (terminate → terminal terobservasi → dispose).
  backend.terminate(h, "test-cleanup")
  const end = await backend.wait(h, 8000)
  expect(["proven-dead", "completed"]).toContain(end.status)
  backend.dispose(h)
}, 30000)

// ── R1-b: terminal dikonsumsi dulu; dispose menghapus; akses pasca jujur ─────
test("R1-b: dispose pasca-terminal → record hilang, akses pasca jujur, dispose ulang aman", async () => {
  const backend = createHostBackend()
  const h = await started(backend, quickExit(3))
  const end = await backend.wait(h, 5000)
  expect(end).toEqual({ status: "completed", exitCode: 3 })
  expect(backend.dispose(h)).toEqual({ disposed: true, cleanupKillAttempted: false })
  const wAfter = await backend.wait(h, 50)
  expect(wAfter).toEqual({
    status: "unknown",
    detail: "no such handle (disposed or foreign)",
  })
  expect(backend.observe(h).status).toBe("unknown")
  // Idempoten: tak ada resurrect/korupsi.
  expect(backend.dispose(h)).toEqual({ disposed: true, cleanupKillAttempted: false })
  expect(backend.observe(h).status).toBe("unknown")
}, 30000)

// ── R1-c: dispose saat eksekusi hidup ────────────────────────────────────────
test("R1-c: dispose saat hidup → kill tree best-effort + waiter in-flight selesai jujur", async () => {
  const backend = createHostBackend()
  const h = await started(backend, sleeper(30_000))
  const inFlight = backend.wait(h, 8000)
  const d = backend.dispose(h)
  expect(d.disposed).toBe(true)
  expect(d.cleanupKillAttempted).toBe(true)
  const settled = await inFlight
  expect(settled).toEqual({ status: "unknown", detail: "disposed" })
  expect(backend.observe(h).status).toBe("unknown")
}, 30000)

// ── R1-d: siklus berulang tak menumpuk record ────────────────────────────────
test("R1-d: 5 siklus timeout→abandon→terminal→dispose → residensi kembali kosong", async () => {
  const backend = createHostBackend()
  const handles: BackendHandle[] = []
  for (let i = 0; i < 5; i++) {
    const h = await started(backend, sleeper(20_000))
    const w = await backend.wait(h, 30)
    expect(w).toEqual({ status: "timeout" })
    backend.terminate(h, `abandon-${i}`)
    const end = await backend.wait(h, 8000)
    // proven-dead/completed = close TEROBSERVASI → bukti deterministik proses mati,
    // bukan klaim buta; tak ada proses milik test yang tertinggal.
    expect(["proven-dead", "completed"]).toContain(end.status)
    backend.dispose(h)
    handles.push(h)
  }
  for (const h of handles) expect(resident(backend, h)).toBe(false)
}, 60000)

// ── R1-e: re-read sah sebelum dispose ────────────────────────────────────────
test("R1-e: waiter belakangan membaca hasil terminal identik selama record belum dibuang", async () => {
  const backend = createHostBackend()
  const h = await started(backend, quickExit(5))
  const first = await backend.wait(h, 5000)
  expect(first).toEqual({ status: "completed", exitCode: 5 })
  const again = await backend.wait(h, 5000)
  expect(again).toEqual(first)
  backend.dispose(h)
}, 30000)

// ── Isolasi: dispose satu tak menyentuh record lain ──────────────────────────
test("R1: dispose satu eksekusi tidak menghapus record eksekusi lain", async () => {
  const backend = createHostBackend()
  const h1 = await started(backend, sleeper(30_000))
  const h2 = await started(backend, sleeper(30_000))
  backend.dispose(h1)
  expect(resident(backend, h1)).toBe(false)
  expect(backend.observe(h2).status).toBe("running")
  backend.dispose(h2)
  expect(resident(backend, h2)).toBe(false)
}, 30000)

// ── R1-f: eskalasi — urutan terminal-dulu (backend nyata) ─────────────────────
test("R1-f: escalate membuang record SETELAH terminal terbukti (backend nyata)", async () => {
  const backend = createHostBackend()
  const h = await started(backend, sigtermIgnorer(30_000))
  const sup = createSupervisor({ kernel: createExecutionKernel() })
  const res = await sup.escalate(h, "r1-f", { backend, waitMs: 400 })
  const terminal = res.waitAfterTerminate ?? res.waitAfterCancel
  expect(["proven-dead", "completed"]).toContain(terminal)
  // Pasca-eskalasi record dibuang — oleh pemilik jalur eskalasi, pasca-terminal.
  expect(resident(backend, h)).toBe(false)
  expect(sup.metrics().supervisorEscalation).toBe(1)
}, 30000)

// ── R1-f: eskalasi — TIDAK membuang bila terminal tak terbukti (skrip) ───────
test("R1-f: escalate TANPA terminal (double timeout) → record TIDAK dibuang", async () => {
  const { backend, calls } = scriptedBackend({
    wait1: { status: "timeout" },
    wait2: { status: "timeout" },
  })
  const sup = createSupervisor({ kernel: createExecutionKernel() })
  const res = await sup.escalate({ id: "be_skrip", kind: "host" }, "r1-f", {
    backend,
    waitMs: 10,
  })
  expect(res.waitAfterCancel).toBe("timeout")
  expect(res.waitAfterTerminate).toBe("timeout")
  expect(calls).toEqual(["cancel", "wait:0", "terminate", "wait:1"])
}, 30000)

// ── R1-f: eskalasi — dispose tepat di akhir setelah terminal kedua (skrip) ───
test("R1-f: escalate dengan terminal tahap kedua → dispose sebagai langkah TERAKHIR", async () => {
  const { backend, calls } = scriptedBackend({
    wait1: { status: "timeout" },
    wait2: { status: "proven-dead", exitCode: null },
  })
  const sup = createSupervisor({ kernel: createExecutionKernel() })
  const res = await sup.escalate({ id: "be_skrip", kind: "host" }, "r1-f", {
    backend,
    waitMs: 10,
  })
  expect(res.waitAfterTerminate).toBe("proven-dead")
  expect(calls).toEqual(["cancel", "wait:0", "terminate", "wait:1", "dispose"])
}, 30000)

// ── R1-f: eskalasi — cabang pertama (cancel cukup) juga dispose pasca-terminal ─
test("R1-f: escalate cabang pertama (terminal pasca-cancel) → dispose langsung (skrip)", async () => {
  const { backend, calls } = scriptedBackend({
    wait1: { status: "proven-dead", exitCode: null },
    wait2: { status: "timeout" },
  })
  const sup = createSupervisor({ kernel: createExecutionKernel() })
  const res = await sup.escalate({ id: "be_skrip", kind: "host" }, "r1-f", {
    backend,
    waitMs: 10,
  })
  expect(res.terminated).toBe(false)
  expect(res.waitAfterTerminate).toBeNull()
  expect(calls).toEqual(["cancel", "wait:0", "dispose"])
}, 30000)

// ── R1-g: shutdown komposisi membersihkan record miliknya ────────────────────
test("R1-g: shutdown komposisi membuang record backend miliknya + lapor di detail drain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-r1g-"))
  try {
    const runtime = createRuntimeComposition({
      sessionId: "r1-g",
      workspaceCwd: dir,
      journalPath: join(dir, "journal.db"),
    })
    const h = await started(runtime.backend, sleeper(20_000))
    expect(resident(runtime.backend, h)).toBe(true)
    const res = await runtime.shutdown()
    expect(res.ok).toBe(true)
    // Record dibuang oleh shutdown; akses pasca jujur.
    expect(resident(runtime.backend, h)).toBe(false)
    const w = await runtime.backend.wait(h, 50)
    expect(w.status).toBe("unknown")
    // Pembersihan teramati lewat detail fase (bukan sekadar metode terpanggil).
    const drain = res.phases.find((p) => p.phase === "execution-drain")
    expect(drain?.detail).toContain("backendDisposed=1")
  } finally {
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        await Bun.sleep(100)
      }
    }
  }
}, 30000)
