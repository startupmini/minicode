// P13.2 — Integrasi & fault injection: supervision proses produksi.
//
// Milik P13.2 SAJA. Tes kontrak P13.1 (test/p13-runtime-contract.test.ts)
// terpisah dan tak disentuh; integrasi P13.3 (kontinuitas task durable) juga
// bukan di sini.
//
// Batas yang DIUTUSKAN: file ini membuktikanjalur ownership proses NYATA —
// komposisi/runtime yangbenar-benar memegang daftar anak, server LSP yang benar-benar
// di-spawn, anak yang benar-benar mati, dan shutdown yang benar-benar
// MENUNGGU anak berhenti. Klaim "supervisi produksi terverifikasi" TIDAK boleh
// dibuat dari tes kontrak murni saja.
//
// Hermetic: proses anak nyata yang di-spawn adalah skrip lokal (bun -e) —
// tanpa jaringan, tanpa provider, tanpa berkas repo yang disentuh. Semua path
// temp per test.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearLspServers,
  configureServers,
  lspDiagnostics,
  setLspProcessSupervisor,
} from "../src/lsp/client.ts"
import { createRuntimeComposition, type RuntimeComposition } from "../src/runtime/composition.ts"
import { createProcessSupervision, type ManagedChild } from "../src/runtime/process-supervision.ts"
import {
  createProductionRuntime,
  observeProductionRuntime,
  RUNTIME_GATE_ENABLED,
} from "../src/runtime/production-runtime.ts"
import { createRequirementMap, EMPTY_REQUIREMENT_MAP } from "../src/runtime/runtime-capabilities.ts"
import {
  admitDurableWork,
  deriveRuntimeView,
  type RuntimeView,
} from "../src/runtime/runtime-status.ts"

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p132-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  setLspProcessSupervisor(null)
  clearLspServers()
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

function composition(
  dir: string,
  over: {
    readonly processSupervisionPolicy?: {
      readonly maxAttempts?: number
      readonly backoffBaseMs?: number
      readonly backoffMaxMs?: number
      readonly intensityWindowMs?: number
      readonly maxIntensity?: number
      readonly escalationWaitMs?: number
    }
    readonly processSupervisionFactory?: () => never
  } = {},
): RuntimeComposition {
  return createRuntimeComposition({
    sessionId: "sess-p132",
    workspaceCwd: dir,
    journalPath: join(dir, "journal.db"),
    ...(over.processSupervisionPolicy
      ? { processSupervisionPolicy: over.processSupervisionPolicy }
      : {}),
    ...(over.processSupervisionFactory
      ? { processSupervisionFactory: over.processSupervisionFactory }
      : {}),
  })
}

/**
 * Skrip anak proses NYATA: menulis jejak ke `logPath`, lalu keluar sendiri
 * (kode 7) setelah `exitAfterMs`. Digunakan sebagai "anak yang mati tak
 * terduga" — bukan mock: prosesnya benar-benar ada lalu benar-benar mati.
 */
function dyingChildScript(logPath: string, exitAfterMs: number): string {
  return `
const fs = require("node:fs")
fs.appendFileSync(${JSON.stringify(logPath)}, "start\\n")
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(logPath)}, "exit\\n")
  process.exit(7)
}, ${exitAfterMs})
`
}

/**
 * Skrip server LSP tiruan: menjawab handshake `initialize`/`shutdown`, lalu
 * keluar sendiri. Membuktikan jalur registrar produksi (LSP) dengan PROSES
 * NYATA, bukan double in-memory.
 */
function fakeLspScript(logPath: string, exitAfterMs: number): string {
  return `
const fs = require("node:fs")
fs.appendFileSync(${JSON.stringify(logPath)}, "start pid=" + process.pid + "\\n")
let buf = Buffer.alloc(0)
function send(msg) {
  const payload = Buffer.from(JSON.stringify(msg), "utf8")
  process.stdout.write("Content-Length: " + payload.length + "\\r\\n\\r\\n")
  process.stdout.write(payload)
}
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const sep = buf.indexOf("\\r\\n\\r\\n")
    if (sep === -1) break
    const m = /Content-Length:\\s*(\\d+)/i.exec(buf.slice(0, sep).toString())
    if (!m) { buf = buf.slice(sep + 4); continue }
    const len = Number(m[1])
    if (buf.length < sep + 4 + len) break
    const body = buf.slice(sep + 4, sep + 4 + len).toString()
    buf = buf.slice(sep + 4 + len)
    let msg = null
    try { msg = JSON.parse(body) } catch {}
    if (!msg) continue
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } })
    if (msg.method === "shutdown") send({ jsonrpc: "2.0", id: msg.id, result: null })
    if (msg.method === "exit") { fs.appendFileSync(${JSON.stringify(logPath)}, "exit\\n"); process.exit(0) }
  }
})
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(logPath)}, "exit\\n")
  process.exit(7)
}, ${exitAfterMs})
`
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * True bila proses dengan pid itu SUDAH MATI.
 *
 * Dibukti dari OS (bukan dari log skrip): `kill(pid, 0)` melempar ESRCH kalau
 * prosesnya tidak ada. Log skrip tak bisa jadi bukti — proses bisa mati tanpa
 * sempat menulis apa pun.
 */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

/** Baca pid anak dari jejak skrip ("start pid=<n>"). */
function pidFromLog(logPath: string): number | null {
  if (!existsSync(logPath)) return null
  const m = /pid=(\d+)/.exec(readFileSync(logPath, "utf8"))
  return m ? Number(m[1]) : null
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(25)
  }
  return predicate()
}

// ── 1. Komposisi nyatabenar-benar Lampirkan supervisor ──────────────────────────────

describe("P13.2 — attachment supervisor lewat jalur komposisi nyata", () => {
  test("komposisi produksi membuat instance supervisi", () => {
    const dir = tempDir()
    const c = composition(dir)
    expect(c.supervision).not.toBeNull()
    expect(c.supervisionStatus()?.attached).toBe(true)
    expect(c.supervisionStatus()?.operational).toBe(true)
    expect(c.supervisionStatus()?.managed).toBe(0)
  })

  test("handle produksi membaca status supervisi dari komposisi (bukan flag manual)", async () => {
    const dir = tempDir()
    const handle = await createProductionRuntime(RUNTIME_GATE_ENABLED, () => ({
      sessionId: "sess-p132",
      workspaceCwd: dir,
      journalPath: join(dir, "journal.db"),
    }))
    const facts = observeProductionRuntime(handle)
    expect(facts.evidence.supervisionExpected).toBe(true)
    expect(facts.evidence.supervisorAttached).toBe(true)
    expect(facts.attachment.supervisor).toBe(true)
  })

  test("gate tertutup → tak ada runtime, jadi tak ada klaim supervisi", async () => {
    const handle = await createProductionRuntime({ enabled: false, source: "absent" }, () => {
      throw new Error("tak boleh dipanggil")
    })
    const facts = observeProductionRuntime(handle)
    expect(facts.phase).toBe("ABSENT")
    expect(facts.attachment.supervisor).toBe(false)
  })
})

// ── 2. Iklan kapabilitas hanya setelah attachment valid ─────────────────────

describe("P13.2 — Iklan kapabilitas process-supervision", () => {
  function viewOf(c: RuntimeComposition): RuntimeView {
    return deriveRuntimeView({
      phase: "ACTIVE",
      termination: "NONE",
      evidence: {
        gateEnabled: true,
        constructed: true,
        closed: false,
        journalWritable: true,
        storeOpen: true,
        schedulerAttached: true,
        supervisorAttached: c.supervisionStatus()?.operational === true,
        supervisionExpected: true,
        pendingJournalAppends: 0,
      },
      attachment: {
        journal: true,
        taskStore: true,
        scheduler: true,
        supervisor: c.supervision !== null,
      },
      supervisedChildren: c.supervisionStatus()?.managed ?? 0,
    })
  }

  test("sebelum attachment (establishment gagal) → kapabilitas TAK diiklankan", () => {
    const dir = tempDir()
    const c = composition(dir, {
      processSupervisionFactory: () => {
        throw new Error("supervisi tak bisa dibuat")
      },
    })
    expect(c.supervision).toBeNull()
    const v = viewOf(c)
    expect(v.advertisedCapabilities).not.toContain("process-supervision")
    expect(v.availableCapabilities).not.toContain("process-supervision")
  })

  test("sesudah attachment valid → kapabilitas diiklankan DAN tersedia", () => {
    const dir = tempDir()
    const c = composition(dir)
    const v = viewOf(c)
    expect(v.advertisedCapabilities).toContain("process-supervision")
    expect(v.availableCapabilities).toContain("process-supervision")
  })

  test("supervisi yang sudah escalation → diiklankan tapi TAK tersedia (runtime degraded)", () => {
    const dir = tempDir()
    const c = composition(dir)
    // Eskalasi = recovery menyerah → supervisi tak lagi bisa bekerja.
    c.supervision!.register({
      id: "child-x",
      kind: "unit",
      restartSafety: "unsafe",
      observe: () => ({ status: "failed", exitCode: 1 }),
      stop: async () => {},
    })
    void c.supervision!.notifyExit("child-x", { status: "failed", exitCode: 1 })
    const v = viewOf(c)
    expect(v.advertisedCapabilities).toContain("process-supervision")
    expect(v.availableCapabilities).not.toContain("process-supervision")
    expect(v.health).toBe("DEGRADED")
  })
})

// ── 3. Anak mati tak terduga → restart bounded + backoff ────────────────────

describe("P13.2 — bounded restart/backoff atas anak nyata", () => {
  test("anak proses nyata yang mati tak terduga → restart dengan backoff bounded", async () => {
    const dir = tempDir()
    const log = join(dir, "child.log")
    const script = dyingChildScript(log, 10)
    const restarts: number[] = []
    const sleeps: number[] = []
    const supervision = createProcessSupervision({
      policy: { maxAttempts: 3, backoffBaseMs: 40, backoffMaxMs: 100 },
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    const child: ManagedChild = {
      id: "child-real",
      kind: "unit",
      restartSafety: "safe",
      observe: () => ({ status: "running" }),
      stop: async () => {},
      restart: async () => {
        restarts.push(Date.now())
        // Restart = proses NYATA baru yang akan mati lagi shortly after.
        const { spawn } = await import("node:child_process")
        const proc = spawn(process.execPath, ["-e", script], { stdio: "ignore" })
        proc.on("exit", () => {
          void supervision.notifyExit("child-real", { status: "failed", exitCode: 7 })
        })
      },
    }
    supervision.register(child)

    // Pemicu pertama: anak mati.
    const { spawn } = await import("node:child_process")
    const first = spawn(process.execPath, ["-e", script], { stdio: "ignore" })
    first.on("exit", () => {
      void supervision.notifyExit("child-real", { status: "failed", exitCode: 7 })
    })

    const grew = await waitFor(() => restarts.length >= 2, 8_000)
    expect(grew).toBe(true)
    // Backoff naik (bounded oleh backoffMaxMs), bukan restart tanpa jeda.
    expect(sleeps.length).toBeGreaterThanOrEqual(2)
    expect(sleeps[0]).toBeGreaterThan(0)
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]!)
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(100)
    expect(supervision.status().restarts).toBeGreaterThanOrEqual(2)
  })

  test("anak 'unsafe' (restart bisa mengulang efek) TAK direstart — di-eskalasi", async () => {
    let restarts = 0
    const supervision = createProcessSupervision({ policy: { maxAttempts: 3 } })
    supervision.register({
      id: "child-unsafe",
      kind: "unit",
      restartSafety: "unsafe",
      observe: () => ({ status: "failed", exitCode: 1 }),
      stop: async () => {},
      restart: async () => {
        restarts++
      },
    })
    await supervision.notifyExit("child-unsafe", { status: "failed", exitCode: 1 })
    expect(restarts).toBe(0)
    expect(supervision.status().escalations).toBe(1)
    expect(supervision.status().lastEscalation).toContain("restart unsafe")
    expect(supervision.status().operational).toBe(false)
  })
})

// ── 4. Percobaan habis → eskalasi jujur ────────────────────────────────────

describe("P13.2 — eskalasi saat recovery habis", () => {
  test("percobaan restart habis → eskalasi, bukan restart tanpa batas", async () => {
    let restarts = 0
    const supervision = createProcessSupervision({
      policy: { maxAttempts: 2, backoffBaseMs: 1, backoffMaxMs: 2, intensityWindowMs: 60_000 },
      sleep: async () => {},
    })
    supervision.register({
      id: "child-flapping",
      kind: "unit",
      restartSafety: "safe",
      observe: () => ({ status: "failed", exitCode: 1 }),
      stop: async () => {},
      restart: async () => {
        restarts++
      },
    })
    // Tiga keluar BERDEKAT (burst) → anggaran percobaan habis.
    await supervision.notifyExit("child-flapping", { status: "failed", exitCode: 1 })
    await supervision.notifyExit("child-flapping", { status: "failed", exitCode: 1 })
    await supervision.notifyExit("child-flapping", { status: "failed", exitCode: 1 })
    expect(restarts).toBe(2)
    expect(supervision.status().escalations).toBe(1)
    expect(supervision.status().lastEscalation).toContain("attempts exhausted")
    // Setelah eskalasi, anak tak boleh direstart lagi.
    await supervision.notifyExit("child-flapping", { status: "failed", exitCode: 1 })
    expect(restarts).toBe(2)
  })

  test("restart yang GAGAL → eskalasi segera (jalur pemulihan rusak)", async () => {
    let restarts = 0
    const supervision = createProcessSupervision({
      policy: { maxAttempts: 5, backoffBaseMs: 1, backoffMaxMs: 2 },
      sleep: async () => {},
    })
    supervision.register({
      id: "child-broken",
      kind: "unit",
      restartSafety: "safe",
      observe: () => ({ status: "failed", exitCode: 1 }),
      stop: async () => {},
      restart: async () => {
        restarts++
        throw new Error("binary hilang")
      },
    })
    await supervision.notifyExit("child-broken", { status: "failed", exitCode: 1 })
    expect(restarts).toBe(1)
    expect(supervision.status().escalations).toBe(1)
    expect(supervision.status().lastEscalation).toContain("restart failed")
    expect(supervision.status().operational).toBe(false)
  })

  test("anak yang lama sehat dapat anggaran baru (tak kehabisan selamanya)", async () => {
    let restarts = 0
    let now = 1_000
    const supervision = createProcessSupervision({
      policy: { maxAttempts: 2, backoffBaseMs: 1, backoffMaxMs: 2, intensityWindowMs: 1_000 },
      now: () => now,
      sleep: async () => {},
    })
    supervision.register({
      id: "child-rare",
      kind: "unit",
      restartSafety: "safe",
      observe: () => ({ status: "failed", exitCode: 1 }),
      stop: async () => {},
      restart: async () => {
        restarts++
      },
    })
    await supervision.notifyExit("child-rare", { status: "failed", exitCode: 1 })
    now += 10_000
    await supervision.notifyExit("child-rare", { status: "failed", exitCode: 1 })
    now += 10_000
    await supervision.notifyExit("child-rare", { status: "failed", exitCode: 1 })
    // Tiga kali, tapi masing-masing setelah anak lama sehat → tak ada eskalasi.
    expect(restarts).toBe(3)
    expect(supervision.status().escalations).toBe(0)
  })

  test("intensitas(restart terlalu sering) → eskalasi, bukan restart tanpa batas", async () => {
    let restarts = 0
    const supervision = createProcessSupervision({
      policy: {
        maxAttempts: 10,
        backoffBaseMs: 1,
        backoffMaxMs: 1,
        intensityWindowMs: 60_000,
        maxIntensity: 2,
      },
      sleep: async () => {},
    })
    supervision.register({
      id: "child-hot",
      kind: "unit",
      restartSafety: "safe",
      observe: () => ({ status: "failed", exitCode: 1 }),
      stop: async () => {},
      restart: async () => {
        restarts++
      },
    })
    for (let i = 0; i < 4; i++) {
      await supervision.notifyExit("child-hot", { status: "failed", exitCode: 1 })
    }
    expect(restarts).toBeLessThanOrEqual(3)
    expect(supervision.status().escalations).toBe(1)
  })
})

// ── 4b. Batas & kegagalan subsidiary (tidak boleh jadi diam-diam) ──────────

describe("P13.2 — batas dan kegagalan subsidiary", () => {
  test("anak tanpa cara restart → eskalasi (bukan diam-diam)", async () => {
    const supervision = createProcessSupervision({ policy: { maxAttempts: 3 } })
    supervision.register({
      id: "child-no-restart",
      kind: "unit",
      restartSafety: "safe",
      observe: () => ({ status: "failed", exitCode: 1 }),
      stop: async () => {},
    })
    await supervision.notifyExit("child-no-restart", { status: "failed", exitCode: 1 })
    expect(supervision.status().escalations).toBe(1)
    expect(supervision.status().lastEscalation).toContain("cannot be restarted")
  })

  test("batas jumlah anak → anak tak didaftarkan, dan itu DIKABARKAN", () => {
    const supervision = createProcessSupervision({ maxManagedChildren: 2 })
    const mk = (id: string): ManagedChild => ({
      id,
      kind: "unit",
      restartSafety: "safe",
      observe: () => ({ status: "running" }),
      stop: async () => {},
      restart: async () => {},
    })
    supervision.register(mk("a"))
    supervision.register(mk("b"))
    supervision.register(mk("c"))
    expect(supervision.status().managed).toBe(2)
    expect(supervision.status().escalations).toBe(1)
    expect(supervision.status().lastEscalation).toContain("managed child limit reached")
  })

  test("sleeper yang gagal → bukan kegagalan anak (tak eskalasi)", async () => {
    let restarts = 0
    const supervision = createProcessSupervision({
      policy: { maxAttempts: 3 },
      sleep: async () => {
        throw new Error("jam internal mati")
      },
    })
    supervision.register({
      id: "child-sleepfail",
      kind: "unit",
      restartSafety: "safe",
      observe: () => ({ status: "failed", exitCode: 1 }),
      stop: async () => {},
      restart: async () => {
        restarts++
      },
    })
    await supervision.notifyExit("child-sleepfail", { status: "failed", exitCode: 1 })
    expect(restarts).toBe(0)
    expect(supervision.status().escalations).toBe(0)
  })

  test("anak yang stop-nya gagal → dihitung gagal, shutdown tetap selesai", async () => {
    const supervision = createProcessSupervision()
    supervision.register({
      id: "child-badstop",
      kind: "unit",
      restartSafety: "safe",
      observe: () => ({ status: "running" }),
      stop: async () => {
        throw new Error("tidak bisa dihentikan")
      },
      restart: async () => {},
    })
    const res = await supervision.shutdown()
    expect(res.stopped).toBe(0)
    expect(res.failed).toBe(1)
  })
})

// ── 8. Kebenaran admission durable (Step 0) ──────────────────────────────────

describe("P13.2 — kebenaran admission durable", () => {
  test("jalur durable produksi memakai PETA KANONIK (bukan peta kosong/ad-hoc)", () => {
    // Kalau suatu saat jalur produksi memakai kontrak admission, petanya harus
    // peta kanonik (runtime-task-admission.ts) — BUKAN peta yang dirakit di
    // tempat lain, dan BUKAN peta kosong (yang akan menolak semua durable work
    // produksi). Peta kelas kerja produksi adalah milik lapisan task
    // (TaskStore) dan tidak boleh dikarang di sini.
    const execSrc = readFileSync(
      join(process.cwd(), "src", "runtime", "production-execution.ts"),
      "utf8",
    )
    expect(execSrc).toContain("admitTaskWork")
    expect(execSrc).not.toContain("EMPTY_REQUIREMENT_MAP")
    expect(execSrc).not.toContain("createRequirementMap")
  })

  test("runtime sehat tak otomatis mengizinkan kelas kerja tanpa peta", () => {
    // Kontrak: `admission` runtime (ALLOW) BUKAN izin per jenis kerja. Satu
    // jenis kerja tanpa peta eksplisit tetap REFUSE — dari status runtime yang
    // sehat, dari peta kosong, maupun dari peta yang tak memuat jenis itu.
    const healthy = deriveRuntimeView({
      phase: "ACTIVE",
      termination: "NONE",
      evidence: {
        gateEnabled: true,
        constructed: true,
        closed: false,
        journalWritable: true,
        storeOpen: true,
        schedulerAttached: true,
        supervisorAttached: true,
        supervisionExpected: true,
        pendingJournalAppends: 0,
      },
      attachment: { journal: true, taskStore: true, scheduler: true, supervisor: true },
      supervisedChildren: 0,
    })
    expect(healthy.admission).toBe("ALLOW")
    expect(
      admitDurableWork(healthy, { workKind: "apa.saja", requirements: EMPTY_REQUIREMENT_MAP })
        .admission,
    ).toBe("REFUSE")
    const other = createRequirementMap([
      { workKind: "lain", requiredCapabilities: ["durable-journal"] },
    ])
    expect(admitDurableWork(healthy, { workKind: "apa.saja", requirements: other }).admission).toBe(
      "REFUSE",
    )
  })
})

// ── 5. Shutdown menunggu cleanup; anak tak ditinggal hidup ─────────────────

describe("P13.2 — shutdown menunggu anak berhenti", () => {
  test("shutdown komposisi menghentikan anak nyata dan MENUNGGU prosesnya mati", async () => {
    const dir = tempDir()
    const log = join(dir, "child.log")
    const c = composition(dir)
    const { spawn } = await import("node:child_process")
    const proc = spawn(process.execPath, ["-e", dyingChildScript(log, 60_000)], {
      stdio: "ignore",
    })
    let stopped = false
    c.supervision!.register({
      id: "child-shutdown",
      kind: "unit",
      restartSafety: "safe",
      observe: () => ({ status: "running" }),
      stop: async () => {
        stopped = true
        proc.kill("SIGKILL")
        await new Promise<void>((r) => proc.once("exit", () => r()))
      },
      restart: async () => {},
    })
    // Tunggu anak benar-benar hidup dulu — kalau tidak, shutdown bisa
    // menyalakan anak yang belum sempat berjalan.
    const up = await waitFor(
      () => existsSync(log) && readFileSync(log, "utf8").includes("start"),
      5_000,
    )
    expect(up).toBe(true)

    const result = await c.shutdown()
    const cleanup = result.phases.find((p) => p.phase === "process-cleanup")
    expect(cleanup).toBeDefined()
    expect(cleanup?.outcome).toBe("succeeded")
    expect(stopped).toBe(true)
    // Bukti dari OS: proses anak benar-benar tidak ada lagi.
    const gone = await waitFor(() => processGone(proc.pid!), 5_000)
    expect(gone).toBe(true)
  })

  test("fase process-cleanup muncul di urutan shutdown (sesudah drain, sebelum flush)", async () => {
    const dir = tempDir()
    const c = composition(dir)
    const result = await c.shutdown()
    const order = result.phases.map((p) => p.phase)
    expect(order).toContain("process-cleanup")
    expect(order.indexOf("process-cleanup")).toBeGreaterThan(order.indexOf("execution-drain"))
    expect(order.indexOf("process-cleanup")).toBeLessThan(order.indexOf("journal-flush"))
  })

  test("establishment gagal → fase process-cleanup 'skipped', bukan crash", async () => {
    const dir = tempDir()
    const c = composition(dir, {
      processSupervisionFactory: () => {
        throw new Error("supervisi tak bisa dibuat")
      },
    })
    const result = await c.shutdown()
    const cleanup = result.phases.find((p) => p.phase === "process-cleanup")
    expect(cleanup?.outcome).toBe("skipped")
  })
})

// ── 6. Kegagalan establishment tak boleh jadi klaim sehat ───────────────────

describe("P13.2 — kegagalan establishment tak jadi klaim sehat", () => {
  test("supervisi gagal established → runtime DEGRADED, kapabilitas tak diiklankan", async () => {
    const dir = tempDir()
    const handle = await createProductionRuntime(RUNTIME_GATE_ENABLED, () => ({
      sessionId: "sess-p132",
      workspaceCwd: dir,
      journalPath: join(dir, "journal.db"),
      processSupervisionFactory: () => {
        throw new Error("supervisi tak bisa dibuat")
      },
    }))
    const facts = observeProductionRuntime(handle)
    const v = deriveRuntimeView(facts)
    expect(facts.evidence.supervisionExpected).toBe(true)
    expect(facts.evidence.supervisorAttached).toBe(false)
    expect(v.advertisedCapabilities).not.toContain("process-supervision")
    expect(v.health).not.toBe("HEALTHY")
    expect(v.health).toBe("DEGRADED")
    // Admission fail-closed: runtime tak boleh menerima kerja durable baru
    // saat jalurnya OWNERSHIP proses tak utuh.
    expect(v.admission).toBe("REFUSE")
  })
})

// ── 7. Registrar produksi: server LSP sebagai anak yang dikelola ────────────

describe("P13.2 — registrar produksi (server LSP)", () => {
  test("server LSP yang mati tak terduga → restart bounded lewat jalur komposisi", async () => {
    const dir = tempDir()
    const log = join(dir, "lsp.log")
    const c = composition(dir, {
      processSupervisionPolicy: {
        maxAttempts: 2,
        backoffBaseMs: 20,
        backoffMaxMs: 40,
        intensityWindowMs: 60_000,
        maxIntensity: 10,
      },
    })
    setLspProcessSupervisor(c.supervision)
    configureServers([
      {
        ext: ".ts",
        command: process.execPath,
        args: ["-e", fakeLspScript(log, 120)],
      },
    ])

    // Panggil API LSP nyata → server di-spawn.
    await lspDiagnostics(join(dir, "a.ts"), "const x = 1\n", 300, dir).catch(() => {})

    const restarted = await waitFor(() => (c.supervisionStatus()?.restarts ?? 0) >= 1, 8_000)
    expect(restarted).toBe(true)
    // Proses anak benar-benar di-spawn ulang (jejak "start" kedua).
    const spawns = await waitFor(
      () => (readFileSync(log, "utf8").match(/start/g) ?? []).length >= 2,
      5_000,
    )
    expect(spawns).toBe(true)
    // Anak terdaftar di jalur ownership proses runtime.
    expect(c.supervisionStatus()?.managed).toBeGreaterThanOrEqual(1)

    await c.shutdown()
  })

  test("shutdown runtime menghentikan server LSP dan menunggu", async () => {
    const dir = tempDir()
    const log = join(dir, "lsp.log")
    const c = composition(dir)
    setLspProcessSupervisor(c.supervision)
    configureServers([
      {
        ext: ".ts",
        command: process.execPath,
        args: ["-e", fakeLspScript(log, 60_000)],
      },
    ])
    await lspDiagnostics(join(dir, "a.ts"), "const x = 1\n", 300, dir).catch(() => {})
    const started = await waitFor(() => readFileSync(log, "utf8").includes("start"), 5_000)
    expect(started).toBe(true)

    await c.shutdown()
    const cleanup = c.shutdownResult()?.phases.find((p) => p.phase === "process-cleanup")
    expect(cleanup?.outcome).toBe("succeeded")
    // Bukti dari OS: proses server LSP benar-benar tidak ada lagi (tak ada
    // child yang terlepas).
    const pid = pidFromLog(log)
    expect(pid).not.toBeNull()
    const gone = await waitFor(() => processGone(pid!), 5_000)
    expect(gone).toBe(true)
  })
})
