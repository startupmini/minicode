// P13.2 â€” Integrasi akhir: lifecycle daemon yang di-supervisi.
//
// Milik P13.2 (bab closing P13.2). Suite P13.1 (kontrak) dan P13.2 (supervisi
// proses) terpisah dan tak disentuh; integrasi P13.3 (kontinuitas task durable)
// bukan di sini.
//
// Yang dibuktikan file ini (bukan klaim pawai):
//   1. Komposisi yang benar-benar di-host daemon MEMILIKI jalur ownership
//      proses (supervisi terpasang, bukan flag).
//   2. Status yang disajikan daemon = status runtime kanonik sesi yang di-host
//      (satu model, satu sumber) â€” dan TIDAK mengklaim supervisi kalau
//      pemasangan/setup-nya gagal.
//   3. Shutdown daemon yang rapi MENUTUP sesi yang di-host dan MENUNGGU
//      lifecycle-nya selesai.
//   4. Anak proses yang disupervisi milik daemon TIDAK tersisa hidup.
//   5. Kegagalan shutdown dilaporkan, dan sisa cleanup TIDAK dilewati diam-diam.
//
// Hermetic: workspace + HOME temp per test, provider tiruan (tak ada turn
// yang dijalankan), loopback dengan port ephemeral. Anak proses yang dipakai
// untuk bukti OS-level = skrip lokal nyata (bun -e).

import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { schedulerEnabledForDaemon, startDaemonHostedRuntime } from "../cli/commands/daemon.ts"
import { DaemonClient } from "../src/daemon/client.ts"
import { DaemonHost } from "../src/daemon/host.ts"
import type { ManagedChild } from "../src/runtime/process-supervision.ts"
import { resolveRuntimeMode } from "../src/runtime/production-execution.ts"
import { currentRuntimeView } from "../src/runtime/runtime-status-provider.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"

const dirs: string[] = []
const envBackup = new Map<string, string | undefined>()

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p132d-"))
  dirs.push(dir)
  return dir
}

/**
 * Workspace + config provider tiruan.
 *
 * Config ditulis di HOME terisolasi (config GLOBAL) â€” bukan `.minicode/` lokal:
 * config lokal adalah input repo tak dipercaya (audit #07) dan daemon tak
 * mengaktifkan `allowLocalConfig`. Provider tiruan tak pernah dipanggil (tak
 * ada turn) â†’ tanpa jaringan.
 */
function workspace(): string {
  const dir = tempDir()
  const home = join(dir, "home")
  mkdirSync(join(home, ".minicode"), { recursive: true })
  writeFileSync(
    join(home, ".minicode", "config.json"),
    JSON.stringify({
      providers: [
        { id: "fake", baseUrl: "http://localhost:9", apiKey: "sk-test", models: ["gpt-4o-mini"] },
      ],
    }),
    "utf8",
  )
  return dir
}

/** Isolasi HOME: config/DB global mesin tak boleh ikut dibaca atau ternoda. */
function isolateHome(dir: string): void {
  const home = join(dir, "home")
  mkdirSync(join(home, ".minicode"), { recursive: true })
  for (const key of ["HOME", "USERPROFILE", "MINICODE_HOME"]) {
    envBackup.set(key, process.env[key])
    process.env[key] = home
  }
}

function restoreHome(): void {
  for (const [key, value] of envBackup) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  envBackup.clear()
}

function getArgFrom(argv: string[]): (name: string) => string | undefined {
  return (name: string) => {
    const i = argv.indexOf(name)
    if (i === -1) return undefined
    const v = argv[i + 1]
    return v !== undefined && !v.startsWith("-") ? v : undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** True bila proses dengan pid itu sudah tidak ada (bukti level OS). */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

/** Anak proses NYATA yang hidup lama (bukti OS-level, bukan log skrip). */
function spawnSleeper(): { pid: number; kill: () => void } {
  const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" })
  const pid = proc.pid
  if (pid === undefined) throw new Error("gagal spawn anak uji")
  return {
    pid,
    kill: () => {
      try {
        proc.kill("SIGKILL")
      } catch {}
    },
  }
}

afterEach(() => {
  restoreHome()
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

// â”€â”€ 1 & 2. Komposisi yang di-host + status kanonik yang disajikan daemon â”€â”€

describe("P13.2 â€” komposisi yang di-host daemon", () => {
  test("komposisi nyata yang di-host memasang runtime ter-supervisi", async () => {
    const dir = workspace()
    isolateHome(dir)
    const argv = ["--runtime", "constructed", "--prompt", "halo"]
    const started = await startDaemonHostedRuntime({
      sub: argv,
      getArg: getArgFrom(argv),
      cwd: dir,
    })
    try {
      const session = started.session
      expect(session).not.toBeNull()
      const runtime = session!.productionRuntime.runtime()
      expect(runtime).not.toBeNull()
      // Attachment nyata: instance supervisi ADA di komposisi yang di-host.
      expect(runtime!.supervision).not.toBeNull()
      expect(runtime!.supervisionStatus()?.attached).toBe(true)
      expect(runtime!.supervisionStatus()?.operational).toBe(true)
    } finally {
      await started.host.shutdown("test")
    }
  })

  test("daemon menyajikan status runtime kanonik yang SAMA dengan sesi yang di-host", async () => {
    const dir = workspace()
    isolateHome(dir)
    const argv = ["--runtime", "constructed", "--prompt", "halo"]
    const started = await startDaemonHostedRuntime({
      sub: argv,
      getArg: getArgFrom(argv),
      cwd: dir,
    })
    try {
      // Model yang sama: view kanonik proses ini.
      const local = currentRuntimeView()
      expect(local.advertisedCapabilities).toContain("process-supervision")
      expect(local.availableCapabilities).toContain("process-supervision")

      // Daemon menyajikan view yang SAMA lewat op kontrol yang sudah ada.
      const cap = started.host.issueCapability({ scopes: ["read:session"], who: "tester" })
      const client = await DaemonClient.connect({
        target: { host: "127.0.0.1", port: started.host.port },
        capability: cap,
        consumer: "tester",
      })
      const res = await client.control("daemon.status", {}, `id-${Date.now()}`)
      client.close()
      expect(res.ok).toBe(true)
      if (!res.ok) return
      const result = res.result as { runtime?: typeof local }
      expect(result.runtime?.phase).toBe(local.phase)
      expect(result.runtime?.advertisedCapabilities).toContain("process-supervision")
      expect(result.runtime?.availableCapabilities).toContain("process-supervision")
    } finally {
      await started.host.shutdown("test")
    }
  })

  test("mode runtime daemon dibaca dari flag global yang SAMA dengan CLI (bukan hardcode)", async () => {
    // [P13.3 Stage B] Menutup celah pelaporan: mode daemon HARUS berasal dari
    // resolver yang sama dengan CLI, pada argv miliknya sendiri. Bukti sumber
    // (daemon.ts memanggil resolver dan meneruskan hasilnya ke createCliSession)
    // + bukti perilaku (dengan flag â†’ runtime ada; tanpa flag â†’ jalur legacy).
    const daemonSrc = readFileSync(join(process.cwd(), "cli", "commands", "daemon.ts"), "utf8")
    expect(daemonSrc).toContain("resolveRuntimeMode(sub)")
    expect(daemonSrc).toContain("schedulerEnabledForDaemon(runtimeMode)")
    // Keduanya HARUS berada di dalam objek createCliSession. Jangan pin pola
    // whitespace/komentar: pin seperti itu rapuh dan tidak menambah bukti.
    const call = daemonSrc.slice(daemonSrc.indexOf("createCliSession({"))
    expect(call).toContain("runtimeMode,")
    expect(call).toContain("schedulerEnabled,")

    // Resolusi yang sama dipakai CLI:constructed/owned valid, nilai lain â†’ off.
    expect(resolveRuntimeMode(["--runtime", "constructed"]).mode).toBe("constructed")
    expect(resolveRuntimeMode(["--runtime", "owned"]).mode).toBe("owned")
    expect(resolveRuntimeMode(["--runtime", "ngawur"]).mode).toBe("off")
    expect(resolveRuntimeMode([]).mode).toBe("off")
  })

  test("[P13.3 Stage C] scheduler daemon HANYA aktif pada --runtime owned", () => {
    // Default legacy `off` dan `constructed` TIDAK boleh menyalakan scheduler.
    expect(schedulerEnabledForDaemon("owned")).toBe(true)
    expect(schedulerEnabledForDaemon("constructed")).toBe(false)
    expect(schedulerEnabledForDaemon("off")).toBe(false)
  })

  test("[P13.3 Stage C] --runtime owned menyalakan scheduler; shutdown menutupnya SETELAH sesi", async () => {
    const dir = workspace()
    isolateHome(dir)
    const argv = ["--runtime", "owned", "--prompt", "halo"]
    const started = await startDaemonHostedRuntime({
      sub: argv,
      getArg: getArgFrom(argv),
      cwd: dir,
    })
    const session = started.session
    expect(session).not.toBeNull()
    try {
      // Mode owned = jalur yang benar-benar punya runtime + journal + admission.
      expect(session!.productionScheduler.enabled).toBe(true)
      expect(session!.productionScheduler.constructed).toBe(true)
      expect(session!.productionScheduler.isActive()).toBe(true)
      expect(session!.productionRuntime.runtime()?.journal).not.toBeNull()
    } finally {
      await started.host.shutdown("test")
    }

    // Scheduler BERHENTI sebelum/bersamaan dengan sesi; setelah shutdown tidak
    // ada lagi pemegang lease/turn yang hidup.
    expect(session!.productionScheduler.isActive()).toBe(false)
    expect(session!.productionRuntime.shutdownResult()).not.toBeNull()
    expect(started.host.shutdownSteps).toContain("close-hosted-session")
  })

  test("[P13.3 Stage C] --runtime owned: gate kontinuitas PRODUKSI benar-benar mengizinkan rekonsiliasi aman", async () => {
    const dir = workspace()
    isolateHome(dir)
    const argv = ["--runtime", "owned", "--prompt", "halo"]
    const started = await startDaemonHostedRuntime({
      sub: argv,
      getArg: getArgFrom(argv),
      cwd: dir,
    })
    const session = started.session
    expect(session).not.toBeNull()
    const seed = new TaskStore(dir, { authority: "SCHEDULER" })
    try {
      // Claim durable tanpa pernah dispatch = bentuk crash-after-claim.
      const t = seed.createTask(session!.sessionId, {
        title: "crash-after-claim",
        status: "PENDING",
        order: 1,
        provenance: { origin: "model", source: "p133c-daemon" },
      })
      const c = seed.claimTask(session!.sessionId, t.id, t.revision)
      expect(c.outcome).toBe("CLAIM_ACCEPTED")
      expect(seed.getExecutionLineage(session!.sessionId, t.id)).toEqual({
        execGeneration: 1,
        attemptGeneration: null,
      })

      // Gate NYATA dari cli/setup.ts: runtime owned + store/jurnal terbaca +
      // admission `background` + seluruh tool otonom READ_ONLY. Tanpa wiring
      // yang benar, reconcile akan HOLD dan daftar ini kosong.
      const sc = session!.productionScheduler.getScheduler()
      expect(sc).not.toBeNull()
      expect(sc!.reconcile()).toEqual([t.id])
      expect(seed.getTask(session!.sessionId, t.id)?.status).toBe("PENDING")
      expect(seed.getExecutionOwnership(session!.sessionId, t.id)?.executionOwner).toBeNull()
      // Lineage tetap ada; revert bukan penghapusan record.
      expect(seed.getExecutionLineage(session!.sessionId, t.id)).toEqual({
        execGeneration: 1,
        attemptGeneration: null,
      })
    } finally {
      await started.host.shutdown("test")
      resetTaskStoreHandles()
    }
  })

  test("[P13.4] dua konsumen melihat runtime owned yang sama; admission + ownership P13.3 utuh", async () => {
    const dir = workspace()
    isolateHome(dir)
    const argv = ["--runtime", "owned", "--prompt", "halo"]
    const started = await startDaemonHostedRuntime({
      sub: argv,
      getArg: getArgFrom(argv),
      cwd: dir,
    })
    const session = started.session
    expect(session).not.toBeNull()
    const seed = new TaskStore(dir, { authority: "SCHEDULER" })
    const capA = started.host.issueCapability({ scopes: ["read:session"], who: "obs-a" })
    const capB = started.host.issueCapability({ scopes: ["read:session"], who: "obs-b" })
    const target = { host: "127.0.0.1", port: started.host.port }
    const a = await DaemonClient.connect({ target, capability: capA, consumer: "obs-a" })
    const b = await DaemonClient.connect({ target, capability: capB, consumer: "obs-b" })
    try {
      const view = currentRuntimeView()
      expect(view.phase).toBe("ACTIVE")
      expect(view.admission).toBe("ALLOW")
      expect(view.availableCapabilities).toContain("process-supervision")

      // Dua konsumen bersamaan: view runtime identik, inkarnasi sama.
      const ra = await a.control("daemon.status", {}, "p134-a")
      const rb = await b.control("daemon.status", {}, "p134-b")
      expect(ra.ok).toBe(true)
      expect(rb.ok).toBe(true)
      if (!ra.ok || !rb.ok) return
      const va = ra.result as { incarnation: string; runtime: typeof view }
      const vb = rb.result as { incarnation: string; runtime: typeof view }
      expect(va.incarnation).toBe(started.host.incarnation)
      expect(vb.incarnation).toBe(started.host.incarnation)
      expect(va.runtime).toEqual(vb.runtime)
      expect(va.runtime.admission).toBe("ALLOW")

      // P13.3 tetap utuh: task durable dapat di-claim dan dimiliki scheduler.
      const t = seed.createTask(session!.sessionId, {
        title: "p134-multi-consumer",
        status: "PENDING",
        order: 1,
        provenance: { origin: "model", source: "p134-multi-consumer" },
      })
      const c = seed.claimTask(session!.sessionId, t.id, t.revision)
      expect(c.outcome).toBe("CLAIM_ACCEPTED")
      expect(seed.getExecutionOwnership(session!.sessionId, t.id)?.executionOwner).toBe("scheduler")

      // Satu konsumen putus: runtime + scheduler + ownership tak berubah.
      a.close()
      await sleep(80)
      expect(started.host.closing).toBe(false)
      expect(session!.productionScheduler.isActive()).toBe(true)
      expect(seed.getExecutionOwnership(session!.sessionId, t.id)?.executionOwner).toBe("scheduler")
      const after = await b.control("daemon.status", {}, "p134-b-after")
      expect(after.ok).toBe(true)
      if (after.ok) {
        expect(after.result).toMatchObject({
          runtime: { phase: "ACTIVE", admission: "ALLOW" },
        })
      }
    } finally {
      b.close()
      await started.host.shutdown("test")
      resetTaskStoreHandles()
    }
    expect(session!.productionScheduler.isActive()).toBe(false)
  })

  test("setup sesi yang GAGAL â†’ daemon tak mengklaim supervisi (dan tak tinggalkan host hidup)", async () => {
    const dir = tempDir()
    isolateHome(dir)
    // Tanpa config provider, sesi tak bisa dibangun â†’ setup gagal.
    const argv = ["--runtime", "constructed", "--prompt", "halo"]
    let failed = false
    try {
      await startDaemonHostedRuntime({ sub: argv, getArg: getArgFrom(argv), cwd: dir })
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
    // Gagal â‰  mengklaim sehat/supervisi.
    const view = currentRuntimeView()
    expect(view.advertisedCapabilities).not.toContain("process-supervision")
    expect(view.availableCapabilities).not.toContain("process-supervision")
    expect(view.health).not.toBe("HEALTHY")
    // Host TAK boleh meninggalkan socket listening di belakang: berkas endpoint
    // (yang ditulis host hidup) sudah dibersihkan saat host ditutup.
    expect(existsSync(join(dir, ".minicode", "daemon-endpoint.json"))).toBe(false)
  })

  test("mode runtime default (off) â†’ daemon tetap di jalur legacy, tanpa klaim supervisi", async () => {
    const dir = workspace()
    isolateHome(dir)
    const argv = ["--prompt", "halo"]
    const started = await startDaemonHostedRuntime({
      sub: argv,
      getArg: getArgFrom(argv),
      cwd: dir,
    })
    try {
      expect(started.session!.productionRuntime.runtime()).toBeNull()
      const view = currentRuntimeView()
      expect(view.advertisedCapabilities).not.toContain("process-supervision")
    } finally {
      await started.host.shutdown("test")
    }
  })
})

// â”€â”€ 3 & 4. Shutdown rapi: sesi ditutup, anak proses tak tersisa â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("P13.2 â€” shutdown daemon menutup sesi yang di-host", () => {
  test("shutdown daemon menutup sesi dan MENUNGGU lifecycle-nya selesai", async () => {
    const dir = workspace()
    isolateHome(dir)
    const argv = ["--runtime", "constructed", "--prompt", "halo"]
    const started = await startDaemonHostedRuntime({
      sub: argv,
      getArg: getArgFrom(argv),
      cwd: dir,
    })
    const session = started.session!
    // Sebelum shutdown: runtime belum ditutup.
    expect(session.productionRuntime.shutdownResult()).toBeNull()

    await started.host.shutdown("test")

    // Setelah shutdown: lifecycle sesi sudah SELESAI (bukan "dimulai").
    // Hasil shutdown runtime = bukti close() sudah jalan sampai habis.
    const result = session.productionRuntime.shutdownResult()
    expect(result).not.toBeNull()
    const cleanup = result?.phases.find((p) => p.phase === "process-cleanup")
    expect(cleanup).toBeDefined()
    // Daemon juga mencatat langkah "close-hosted-session".
    expect(started.host.shutdownSteps).toContain("close-hosted-session")
  })

  test("anak proses yang disupervisi milik daemon TIDAK tersisa hidup setelah shutdown", async () => {
    const dir = workspace()
    isolateHome(dir)
    const argv = ["--runtime", "constructed", "--prompt", "halo"]
    const started = await startDaemonHostedRuntime({
      sub: argv,
      getArg: getArgFrom(argv),
      cwd: dir,
    })
    const session = started.session!
    const supervision = session.productionRuntime.runtime()!.supervision
    expect(supervision).not.toBeNull()

    // Anak NYATA yang disupervisi runtime milik daemon.
    const sleeper = spawnSleeper()
    const child: ManagedChild = {
      id: "daemon-child",
      kind: "unit",
      restartSafety: "safe",
      observe: () => ({ status: "running" }),
      stop: async () => {
        sleeper.kill()
        await sleep(50)
      },
      restart: async () => {},
    }
    supervision!.register(child)
    expect(processGone(sleeper.pid)).toBe(false)

    await started.host.shutdown("test")

    // Bukti level OS: prosesnya tidak ada lagi.
    expect(processGone(sleeper.pid)).toBe(true)
  })

  test("shutdown kedua tetap idempoten (langkah sama, tak ada sesi yang ditutup dua kali)", async () => {
    const dir = workspace()
    isolateHome(dir)
    const argv = ["--runtime", "constructed", "--prompt", "halo"]
    const started = await startDaemonHostedRuntime({
      sub: argv,
      getArg: getArgFrom(argv),
      cwd: dir,
    })
    await started.host.shutdown("test")
    const first = [...started.host.shutdownSteps]
    const second = await started.host.shutdown("test")
    expect(second).toEqual(first)
  })
})

// â”€â”€ 5. Kegagalan shutdown: dilaporkan, cleanup tak dilewati â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("P13.2 â€” kegagalan shutdown dilaporkan", () => {
  test("sesi yang tak bisa ditutup â†’ kegagalan tercatat, sisa cleanup tetap jalan", async () => {
    const dir = tempDir()
    const host = await DaemonHost.start({
      cwd: dir,
      port: 0,
      feeds: { get: () => null as never, known: () => [] },
      closeHostedSession: async () => {
        throw new Error("sesi gagal ditutup")
      },
    })
    let rejected = false
    try {
      await host.shutdown("test")
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
    // Kegagalan TERLIHAT (tak hilang diam-diam).
    expect(host.shutdownErrors.length).toBe(1)
    expect(host.shutdownErrors[0]?.message).toContain("sesi gagal ditutup")
    // Sisa cleanup TIDAK dilewati.
    const steps = host.shutdownSteps
    expect(steps).toContain("close-hosted-session")
    expect(steps).toContain("stop-monitors")
    expect(steps).toContain("close-connections")
    expect(steps).toContain("retire-children")
    expect(steps).toContain("clear-discovery")
  })

  test("tanpa sesi yang di-host â†’ tak ada langkah close-hosted-session", async () => {
    const dir = tempDir()
    const host = await DaemonHost.start({
      cwd: dir,
      port: 0,
      feeds: { get: () => null as never, known: () => [] },
    })
    await host.shutdown("test")
    expect(host.shutdownSteps).not.toContain("close-hosted-session")
    expect(host.shutdownErrors).toEqual([])
  })
})
