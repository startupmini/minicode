// M5 — Execution backend adapter: interface + kapabilitas jujur + A/B/C/D.
// Hermetic-kecuali-host: host adapter memakai proses nyata berumur pendek;
// shims diuji deklaratif (docker/bwrap/seatbelt tak tersedia di semua platform).

import { expect, test } from "bun:test"
import {
  BACKEND_CAPABILITIES,
  BACKEND_FACTORIES,
  type BackendKind,
  createBwrapBackend,
  createDockerBackend,
  createHostBackend,
  createSeatbeltBackend,
  type ExecutionBackend,
} from "../src/runtime/execution-backend.ts"

const NODE = JSON.stringify(process.execPath)
const quickExit = (code: number): string => `${NODE} -e "process.exit(${code})"`
const sleeper = (ms: number): string => `${NODE} -e "setTimeout(()=>{},${ms})"`
const sigtermIgnorer = (ms: number): string =>
  `${NODE} -e "process.on('SIGTERM',()=>{});setTimeout(()=>{},${ms})"`

async function startedHost(cmd: string, timeoutMs = 10_000) {
  const backend = createHostBackend()
  const started = await backend.start({ cmd, timeoutMs })
  if (!started.started) throw new Error(`test setup: backend failed to start (${started.reason})`)
  return { backend, handle: started.handle }
}

// B1 — Interface contract: 4 backend × 7 methods + kind + capabilities.
test("B1 interface: semua backend penuhi kontrak 7 method", () => {
  const backends: ExecutionBackend[] = [
    createHostBackend(),
    createDockerBackend(),
    createBwrapBackend(),
    createSeatbeltBackend(),
  ]
  expect(backends.map((b) => b.kind)).toEqual(["host", "docker", "bwrap", "seatbelt"])
  for (const b of backends) {
    for (const m of [
      "admit",
      "start",
      "observe",
      "cancel",
      "terminate",
      "wait",
      "dispose",
    ] as const) {
      expect(typeof b[m], `${b.kind}.${m}`).toBe("function")
    }
    expect(b.capabilities).toBe(BACKEND_CAPABILITIES[b.kind])
  }
  expect(Object.keys(BACKEND_FACTORIES).sort()).toEqual(["bwrap", "docker", "host", "seatbelt"])
})

// B2 — Admission: valid diterima, invalid ditolak (tanpa fallback diam-diam).
test("B2 admission: valid/invalid deterministik", () => {
  const backend = createHostBackend()
  expect(backend.admit({ cmd: quickExit(0) })).toEqual({ admitted: true })
  expect(backend.admit({ cmd: "" }).admitted).toBe(false)
  expect(backend.admit({ cmd: "x", timeoutMs: -1 }).admitted).toBe(false)
  expect(backend.admit({ cmd: "x", timeoutMs: NaN }).admitted).toBe(false)
})

// B3 — Start memanggil mekanisme fisik nyata; gagal-start ≠ terminated.
test("B3 start: exit code nyata tertangkap; gagal spawn = started:false", async () => {
  const backend = createHostBackend()
  const started = await backend.start({ cmd: quickExit(7) })
  expect(started.started).toBe(true)
  if (!started.started) throw new Error("unreachable")
  const end = await backend.wait(started.handle, 5000)
  expect(end).toEqual({ status: "completed", exitCode: 7 })
  expect(backend.dispose(started.handle)).toEqual({ disposed: true, cleanupKillAttempted: false })
  const bad = await backend.start({ cmd: quickExit(0), cwd: "C:\\jalan\\tak\\ada\\m5" })
  if (process.platform === "win32") {
    // Windows shell:true + cwd buruk → error ENOENT (bukan klaim terminated).
    expect(bad.started).toBe(false)
  } else {
    expect(typeof bad.started).toBe("boolean")
  }
})

// B4 — Observe: running vs exited.
test("B4 observe: status fisik terbaca", async () => {
  const { backend, handle } = await startedHost(sleeper(20_000))
  expect(backend.observe(handle).status).toBe("running")
  backend.terminate(handle, "test")
  const end = await backend.wait(handle, 8000)
  expect(["proven-dead", "completed"]).toContain(end.status)
  expect(backend.observe(handle).status).toBe("exited")
  backend.dispose(handle)
  expect(backend.observe(handle).status).toBe("unknown")
})

// B5 — Cancel = request (tanpa klaim D).
test("B5 cancel: request diteruskan; tanpa klaim kematian", async () => {
  const { backend, handle } = await startedHost(sleeper(20_000))
  const res = backend.cancel(handle, "user abort")
  expect(res.status).toBe("cancel-requested")
  expect(JSON.stringify(res)).not.toMatch(/terminated|proven-dead/)
  await backend.wait(handle, 8000)
  backend.dispose(handle)
})

// B6 — Terminate: strong path + wait membuktikan (bukan mengklaim buta).
test("B6 terminate: termination-requested + wait bounded", async () => {
  const { backend, handle } = await startedHost(sleeper(20_000))
  const res = backend.terminate(handle, "escalation")
  expect(res.status).toBe("termination-requested")
  expect(JSON.stringify(res)).not.toMatch(/proven-dead/)
  const t0 = Date.now()
  const end = await backend.wait(handle, 8000)
  expect(Date.now() - t0).toBeLessThan(15_000)
  expect(end.status).toBe("proven-dead")
  backend.dispose(handle)
})

// B7 — Wait bounded: timeout = berhenti menunggu (A), proses boleh hidup.
test("B7 wait: timeout bounded tanpa klaim mati", async () => {
  const { backend, handle } = await startedHost(sleeper(30_000))
  const t0 = Date.now()
  const res = await backend.wait(handle, 150)
  expect(Date.now() - t0).toBeLessThan(5000)
  expect(res).toEqual({ status: "timeout" })
  expect(backend.observe(handle).status).toBe("running")
  backend.terminate(handle, "cleanup")
  await backend.wait(handle, 8000)
  backend.dispose(handle)
})

// B8 — Dispose idempoten.
test("B8 dispose: ganda aman; unknown handle aman", async () => {
  const { backend, handle } = await startedHost(quickExit(0))
  await backend.wait(handle, 5000)
  expect(backend.dispose(handle)).toEqual({ disposed: true, cleanupKillAttempted: false })
  expect(backend.dispose(handle)).toEqual({ disposed: true, cleanupKillAttempted: false })
  expect(backend.dispose({ id: "be_tidakada", kind: "host" })).toEqual({
    disposed: true,
    cleanupKillAttempted: false,
  })
})

// B9 — Cancellation race: start → cancel → wait deterministik + bounded.
test("B9 race: start→cancel→wait tanpa hang", async () => {
  const backend = createHostBackend()
  const started = await backend.start({ cmd: sleeper(30_000) })
  expect(started.started).toBe(true)
  if (!started.started) throw new Error("unreachable")
  const t0 = Date.now()
  const c = backend.cancel(started.handle, "race")
  expect(c.status).toBe("cancel-requested")
  const end = await backend.wait(started.handle, 8000)
  expect(Date.now() - t0).toBeLessThan(15_000)
  expect(["proven-dead", "completed", "timeout"]).toContain(end.status)
  backend.dispose(started.handle)
})

// B10 — Eskalasi: cancel → timeout → terminate → wait.
test("B10 escalation: non-kooperatif naik ke terminate + terbukti", async () => {
  const { backend, handle } = await startedHost(sigtermIgnorer(30_000))
  backend.cancel(handle, "step-1")
  const afterCancel = await backend.wait(handle, 400)
  if (process.platform !== "win32") {
    // POSIX: SIGTERM diabaikan → masih hidup (cancel tak membunuh: TERBUKTI).
    expect(afterCancel).toEqual({ status: "timeout" })
  } else {
    // Windows: taskkill di cancel — hasil boleh apa pun asal well-formed + bounded.
    expect(["timeout", "proven-dead", "completed"]).toContain(afterCancel.status)
  }
  backend.terminate(handle, "step-2")
  const end = await backend.wait(handle, 8000)
  expect(end.status).toBe("proven-dead")
  backend.dispose(handle)
}, 30000)

// B11 — Non-cooperative: cancel tak menghasilkan klaim mati.
test("B11 non-cooperative: cancel report jujur (tanpa D)", async () => {
  const { backend, handle } = await startedHost(sigtermIgnorer(20_000))
  const res = backend.cancel(handle, "test")
  expect(res.status).toBe("cancel-requested")
  expect("via" in res).toBe(true)
  backend.terminate(handle, "cleanup")
  await backend.wait(handle, 8000)
  backend.dispose(handle)
}, 30000)

// B12 — Late completion: tak menimpa hasil tercatat.
test("B12 late: hasil tercatat stabil; cancel pasca-selesai = already-settled", async () => {
  const { backend, handle } = await startedHost(quickExit(4))
  const first = await backend.wait(handle, 5000)
  expect(first).toEqual({ status: "completed", exitCode: 4 })
  expect(backend.cancel(handle, "late")).toEqual({ status: "already-settled", exitCode: 4 })
  expect(await backend.wait(handle, 1000)).toEqual(first)
  backend.dispose(handle)
})

// B13 — Already-dead: semua op aman.
test("B13 already-dead: cancel/terminate/wait aman", async () => {
  const { backend, handle } = await startedHost(quickExit(0))
  await backend.wait(handle, 5000)
  expect(backend.cancel(handle, "x").status).toBe("already-settled")
  expect(backend.terminate(handle, "x").status).toBe("already-settled")
  expect((await backend.wait(handle, 1000)).status).toBe("completed")
  backend.dispose(handle)
})

// B15 — Repeated lifecycle: tanpa leak handle/error.
test("B15 repeated: 30 siklus start/wait/dispose bersih", async () => {
  const backend = createHostBackend()
  for (let i = 0; i < 30; i++) {
    const started = await backend.start({ cmd: quickExit(i % 8) })
    if (!started.started) throw new Error(`cycle ${i}: failed to start`)
    const end = await backend.wait(started.handle, 5000)
    expect(end.status).toBe("completed")
    expect(backend.dispose(started.handle).disposed).toBe(true)
  }
}, 60000)

// Matriks kapabilitas: pin deklarasi (gagal bila diubah diam-diam).
test("B-matrix: deklarasi terkunci + konsisten evidence", () => {
  const expectLevels = (kind: BackendKind, levels: Partial<Record<string, string>>): void => {
    const cap = BACKEND_CAPABILITIES[kind] as unknown as Record<string, string>
    for (const [k, v] of Object.entries(levels)) expect(cap[k], `${kind}.${k}`).toBe(v)
  }
  expectLevels("host", {
    a: "SUPPORTED",
    b: "DELEGATED_TO_RUNTIME",
    c: "SUPPORTED",
    d: "BEST_EFFORT",
    cpu: "UNSUPPORTED",
    memory: "UNSUPPORTED",
    pid: "UNSUPPORTED",
    network: "UNSUPPORTED",
    fs: "BEST_EFFORT",
  })
  expectLevels("docker", {
    a: "SUPPORTED",
    b: "DELEGATED_TO_RUNTIME",
    c: "BEST_EFFORT",
    d: "BEST_EFFORT",
    cpu: "SUPPORTED",
    memory: "SUPPORTED",
    pid: "SUPPORTED",
    network: "SUPPORTED",
    fs: "SUPPORTED",
  })
  expectLevels("bwrap", {
    a: "SUPPORTED",
    b: "DELEGATED_TO_RUNTIME",
    c: "SUPPORTED",
    d: "BEST_EFFORT",
    cpu: "UNSUPPORTED",
    memory: "UNSUPPORTED",
    pid: "UNSUPPORTED",
    network: "SUPPORTED",
    fs: "SUPPORTED",
  })
  expectLevels("seatbelt", {
    a: "SUPPORTED",
    b: "DELEGATED_TO_RUNTIME",
    c: "SUPPORTED",
    d: "BEST_EFFORT",
    cpu: "UNSUPPORTED",
    memory: "UNSUPPORTED",
    pid: "UNSUPPORTED",
    network: "SUPPORTED",
    fs: "SUPPORTED",
  })
  for (const kind of ["host", "docker", "bwrap", "seatbelt"] as const) {
    expect(BACKEND_CAPABILITIES[kind].notes.length).toBeGreaterThan(0)
  }
  // D tak pernah SUPPORTED di M5 (tanpa wait-proof per-backend di sini).
  for (const kind of ["host", "docker", "bwrap", "seatbelt"] as const) {
    expect(BACKEND_CAPABILITIES[kind].d).not.toBe("SUPPORTED")
  }
  // B tak pernah menjadi kapabilitas backend: selalu delegasi ke runtime.
  for (const kind of ["host", "docker", "bwrap", "seatbelt"] as const) {
    expect(BACKEND_CAPABILITIES[kind].b).toBe("DELEGATED_TO_RUNTIME")
  }
})

// Kontrak §5 normalisasi: hasil backend TAK PERNAH mendeklarasikan
// Execution logical state (COMPLETED/FAILED/CANCELLED/... = wewenang Kernel M8).
// Kosakata backend = observasi fisik lowercase; lifecycle = UPPERCASE runtime.
test("B-contract: backend result cannot declare Execution logical state", async () => {
  const EXECUTION_TERMINALS = new Set([
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
    "BUDGET_EXCEEDED",
    "AUTHORITY_LOST",
    "RESOURCE_EXCEEDED",
  ])
  const backend = createHostBackend()
  const s1 = await backend.start({ cmd: sleeper(20_000) })
  if (!s1.started) throw new Error("unreachable")
  const collected: string[] = []
  collected.push(backend.cancel(s1.handle, "x").status)
  collected.push(backend.terminate(s1.handle, "x").status)
  collected.push((await backend.wait(s1.handle, 8000)).status)
  collected.push(backend.observe(s1.handle).status)
  collected.push(backend.dispose(s1.handle).disposed ? "disposed" : "leak")
  const s2 = await backend.start({ cmd: quickExit(0) })
  if (!s2.started) throw new Error("unreachable")
  collected.push((await backend.wait(s2.handle, 5000)).status)
  backend.dispose(s2.handle)
  for (const status of collected) {
    expect(EXECUTION_TERMINALS.has(status), status).toBe(false)
  }
  // Kosakata observasi fisik yang diizinkan (lowercase + disposed).
  const allowed = new Set([
    "cancel-requested",
    "already-settled",
    "unsupported",
    "termination-requested",
    "completed",
    "proven-dead",
    "timeout",
    "vanished",
    "unknown",
    "orphan",
    "running",
    "exited",
    "failed",
    "disposed",
  ])
  for (const status of collected) {
    expect(allowed.has(status), status).toBe(true)
  }
})

// A/B/C/D evidence terpisah (bukan satu boolean terminated=true).
test("B-abcd: empat level terbukti terpisah", async () => {
  const backend = createHostBackend()
  // A: berhenti menunggu sementara proses hidup.
  const a = await backend.start({ cmd: sleeper(20_000) })
  if (!a.started) throw new Error("unreachable")
  expect(await backend.wait(a.handle, 100)).toEqual({ status: "timeout" })
  // B: logical stop = keputusan caller (discard), backend hanya lapor request.
  const cancelRes = backend.cancel(a.handle, "b-test")
  expect(cancelRes.status).toBe("cancel-requested")
  // C: terminate = request lebih kuat (via terdokumentasi, bukan bukti mati).
  const t = await backend.start({ cmd: sleeper(20_000) })
  if (!t.started) throw new Error("unreachable")
  const termRes = backend.terminate(t.handle, "c-test")
  expect(termRes.status).toBe("termination-requested")
  expect("via" in termRes).toBe(true)
  // D: hanya wait sesudah kill + close yang terobservasi.
  expect(await backend.wait(t.handle, 8000)).toEqual({
    status: "proven-dead",
    exitCode: expect.anything(),
  } as never)
  await backend.wait(a.handle, 8000)
  backend.dispose(a.handle)
  backend.dispose(t.handle)
}, 30000)

// Shim honesty: tanpa backend = admit false (tanpa fallback diam-diam);
// mid-flight preemptif = unsupported yang dinyatakan; wait tak pernah proven-dead container.
test("B-shim: sandbox jujur tentang keterbatasan", async () => {
  const docker = createDockerBackend()
  const bwrap = createBwrapBackend()
  const seatbelt = createSeatbeltBackend()
  // win32: ketiganya unavailable → admit false deterministik.
  if (process.platform === "win32") {
    expect(docker.admit({ cmd: "echo hi" }).admitted).toBe(false)
    expect(bwrap.admit({ cmd: "echo hi" }).admitted).toBe(false)
    expect(seatbelt.admit({ cmd: "echo hi" }).admitted).toBe(false)
  }
  // Handle asing/tak dikenal selalu aman (bukan crash).
  const foreign = { id: "be_asing", kind: "docker" as const }
  expect(docker.cancel(foreign, "x").status).toBe("already-settled")
  expect(docker.terminate(foreign, "x").status).toBe("already-settled")
  expect((await docker.wait(foreign)).status).toBe("unknown")
  expect(docker.dispose(foreign)).toEqual({ disposed: true, cleanupKillAttempted: false })
  expect(docker.observe(foreign).status).toBe("unknown")
})

// B14 implisit di B8; B13 di atas; invalid wait timeout ditolak (bounded contract).
test("B-wait-bound: timeout invalid ditolak (kontrak bounded)", async () => {
  const { backend, handle } = await startedHost(quickExit(0))
  await expect(backend.wait(handle, 0)).rejects.toThrow()
  await expect(backend.wait(handle, NaN)).rejects.toThrow()
  await backend.wait(handle, 5000)
  backend.dispose(handle)
})
