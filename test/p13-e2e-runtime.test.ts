// P13.5 - Integrasi end-to-end runtime produksi lewat daemon yang di-host.
//
// Yang dibuktikan file ini (bukan klaim seluruh fase):
//   1. Jalur nyata `startDaemonHostedRuntime --runtime owned` merangkai
//      komposisi runtime, readiness, admission, eksekusi, status/provenance,
//      dan shutdown yang menunggu cleanup.
//   2. Dua konsumen melihat SATU runtime kanonik; memutus satu konsumen tidak
//      menghentikan runtime/scheduler atau konsumen lain.
//   3. Ack + reconnect memakai identitas logis dan offset durable yang sama.
//   4. Mode legacy `off` tetap menjalankan turn tanpa membangun runtime/jurnal
//      dan tanpa menyalakan scheduler.
//   5. Runtime yang sudah berhenti / supervisi yang terdegradasi menolak kerja
//      baru secara fail-closed, tanpa mengeksekusi callback dan tanpa
//      menghapus record durable.
//   6. Shutdown menunggu kerja yang masih terlacak dan menutup jurnal; riwayat
//      terminal tetap terbaca setelah reopen.
//
// Batas klaim:
// - ACP belum terhubung ke daemon runtime bersama; fakta itu tidak diubah di
//   sini (lihat laporan P13.5).
// - Telemetri konsumen tetap NON-AUTORITATIF dan hanya dibaca di proses ini;
//   file ini tidak menambah operasi/field protokol baru.
//
// Hermetik: workspace + HOME temp, provider HTTP lokal, port ephemeral.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type DaemonHostedRuntime, startDaemonHostedRuntime } from "../cli/commands/daemon.ts"
import type { CliSession } from "../cli/setup.ts"
import { DaemonClient } from "../src/daemon/client.ts"
import type { DaemonScope, ServerMessage } from "../src/daemon/protocol.ts"
import { readConsumerOffset } from "../src/daemon/store.ts"
import type { RuntimeComposition } from "../src/runtime/composition.ts"
import { openExecutionJournal } from "../src/runtime/execution-journal.ts"
import type { KernelTransitionEvent } from "../src/runtime/execution-kernel.ts"
import type { RuntimeProductionMode } from "../src/runtime/production-execution.ts"
import { runtimeJournalPath } from "../src/runtime/production-runtime.ts"
import {
  currentRuntimeView,
  installRuntimeStatusProvider,
} from "../src/runtime/runtime-status-provider.ts"
import { admitTaskWork } from "../src/runtime/runtime-task-admission.ts"
import { presentationHead } from "../src/session/persistence.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { type FakeProvider, type FakeReply, startFakeProvider } from "./helpers/fake-provider.ts"

const dirs: string[] = []
const fixtures: HostedFixture[] = []
const envBackup = new Map<string, string | undefined>()
let sessionSeq = 0

interface HostedFixture {
  readonly dir: string
  readonly provider: FakeProvider
  readonly started: DaemonHostedRuntime
  readonly session: CliSession
  readonly runtime: RuntimeComposition | null
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p135-"))
  dirs.push(dir)
  return dir
}

function getArgFrom(argv: string[]): (name: string) => string | undefined {
  return (name: string) => {
    const i = argv.indexOf(name)
    if (i === -1) return undefined
    const v = argv[i + 1]
    return v !== undefined && !v.startsWith("-") ? v : undefined
  }
}

function isolateHome(home: string): void {
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor<T>(
  fn: () => T | null | undefined | false,
  message: string,
  timeoutMs = 6_000,
): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(message)
    await sleep(10)
  }
}

function record(client: DaemonClient): ServerMessage[] {
  const seen: ServerMessage[] = []
  client.on((e) => {
    if (e.kind === "message") seen.push(e.msg)
  })
  return seen
}

function eventsOf(seen: ServerMessage[]): Extract<ServerMessage, { t: "event" }>[] {
  return seen.filter((m): m is Extract<ServerMessage, { t: "event" }> => m.t === "event")
}

async function connectClient(
  host: DaemonHostedRuntime["host"],
  who: string,
  scopes: DaemonScope[] = ["subscribe", "read:session"],
): Promise<DaemonClient> {
  const capability = host.issueCapability({ scopes, who })
  return DaemonClient.connect({
    target: { host: "127.0.0.1", port: host.port },
    capability,
    consumer: who,
  })
}

/**
 * Berlangganan lalu tunggu batas replay/live. Listener dipasang SEBELUM
 * subscribe supaya event yang tiba selama handshake tidak hilang dari bukti.
 */
async function subscribeAndRecord(
  client: DaemonClient,
  sid: string,
  from: 0 | "tail" | "resume",
): Promise<ServerMessage[]> {
  const seen = record(client)
  client.subscribe(sid, from)
  await waitFor(
    () => seen.some((m) => m.t === "tail_marker"),
    `konsumen ${client.welcome?.consumer ?? "?"} tidak mencapai tail_marker`,
  )
  return seen
}

/**
 * Sesi produksi nyata dengan provider lokal. `mode` off tidak membangun
 * runtime/jurnal sama sekali; owned membangun komposisi penuh + scheduler.
 */
async function startHosted(
  mode: RuntimeProductionMode,
  replies: FakeReply[],
): Promise<HostedFixture> {
  const dir = tempDir()
  const home = join(dir, "home")
  const provider = startFakeProvider(replies)
  mkdirSync(join(home, ".minicode"), { recursive: true })
  writeFileSync(
    join(home, ".minicode", "config.json"),
    JSON.stringify({
      providers: [
        {
          id: "fake",
          baseUrl: provider.baseUrl,
          apiKey: "sk-test",
          models: ["gpt-4o-mini"],
        },
      ],
    }),
    "utf8",
  )
  isolateHome(home)

  const sessionId = `p135-e2e-${++sessionSeq}`
  const argv =
    mode === "off"
      ? ["--prompt", "halo", "--session", sessionId]
      : ["--runtime", mode, "--prompt", "halo", "--session", sessionId]
  const started = await startDaemonHostedRuntime({
    sub: argv,
    getArg: getArgFrom(argv),
    cwd: dir,
  })
  const session = started.session
  if (!session) throw new Error("sesi yang di-host tidak terbentuk")
  const fixture: HostedFixture = {
    dir,
    provider,
    started,
    session,
    runtime: session.productionRuntime.runtime(),
  }
  fixtures.push(fixture)
  return fixture
}

function taskRequest(taskId: string) {
  return {
    kind: "background" as const,
    schedulerSource: "autonomous" as const,
    authorityHeld: true,
    ownerId: "scheduler",
    taskId,
    provenance: { requestedBy: "scheduler", reason: "p13.5-e2e" },
  }
}

function createClaimedTask(fx: HostedFixture, title: string): TaskStore {
  const store = new TaskStore(fx.dir, { authority: "SCHEDULER" })
  const task = store.createTask(fx.session.sessionId, {
    title,
    status: "PENDING",
    order: 1,
    provenance: { origin: "model", source: "p13.5-e2e" },
  })
  const claim = store.claimTask(fx.session.sessionId, task.id, task.revision)
  expect(claim.outcome).toBe("CLAIM_ACCEPTED")
  return store
}

afterEach(async () => {
  for (const fx of fixtures.splice(0)) {
    try {
      await fx.started.host.shutdown("cleanup")
    } catch {
      // Kegagalan sudah diuji di suite shutdown; cleanup test tidak boleh
      // menutupi kegagalan asli test.
    }
    try {
      fx.provider.close()
    } catch {}
  }
  resetTaskStoreHandles()
  installRuntimeStatusProvider(null)
  restoreHome()
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

describe("P13.5 - lifecycle runtime owned lewat daemon nyata", () => {
  test("startup -> dua konsumen -> turn -> admission durable -> status -> shutdown berurutan", async () => {
    const fx = await startHosted("owned", [
      { kind: "text", text: "balasan-satu" },
      { kind: "text", text: "balasan-dua" },
      { kind: "text", text: "balasan-tiga" },
    ])
    const { host } = fx.started
    const session = fx.session
    const runtime = fx.runtime
    expect(runtime).not.toBeNull()
    if (!runtime) return

    // 1. Startup: komposisi, readiness, journal, scheduler, supervisi.
    expect(session.runtimeMode).toBe("owned")
    expect(runtime.journal).not.toBeNull()
    expect(existsSync(runtime.journalPath)).toBe(true)
    expect(session.productionScheduler.isActive()).toBe(true)
    expect(runtime.supervisionStatus()).toMatchObject({
      attached: true,
      operational: true,
    })
    expect(session.startupRecovery).not.toBeNull()
    expect(session.startupRecovery?.corrupt).toBe(false)

    const startup = currentRuntimeView()
    expect(startup).toMatchObject({
      phase: "ACTIVE",
      admission: "ALLOW",
      health: "HEALTHY",
      evidenceState: "COMPLETE",
    })
    expect(startup.availableCapabilities).toContain("process-supervision")

    // 2. Dua konsumen bersamaan, keduanya mulai dari replay penuh.
    const a = await connectClient(host, "e2e-a")
    const b = await connectClient(host, "e2e-b")
    const seenA = await subscribeAndRecord(a, session.sessionId, 0)
    const seenB = await subscribeAndRecord(b, session.sessionId, 0)
    expect(host.server.connectionCount).toBe(2)

    // 3. Eksekusi turn nyata lewat jalur produksi (fake provider lokal).
    const transitions: KernelTransitionEvent[] = []
    const unsubTransitions = runtime.kernel.onTransition((e) => transitions.push(e))
    try {
      await session.runPromptWithVerify("halo")
      await waitFor(
        () => eventsOf(seenA).length > 0 && eventsOf(seenB).length > 0,
        "turn selesai tetapi tidak ada event presentasi yang sampai ke kedua konsumen",
      )

      // 4. Status/provenance tetap SATU view kanonik untuk kedua konsumen.
      const statusA = await a.control("daemon.status", {}, "p135-a-status")
      const statusB = await b.control("daemon.status", {}, "p135-b-status")
      expect(statusA.ok).toBe(true)
      expect(statusB.ok).toBe(true)
      if (!statusA.ok || !statusB.ok) return
      const resultA = statusA.result as {
        incarnation: string
        runtime: typeof startup
      }
      const resultB = statusB.result as {
        incarnation: string
        runtime: typeof startup
      }
      expect(resultA.incarnation).toBe(host.incarnation)
      expect(resultB.incarnation).toBe(host.incarnation)
      expect(resultA.runtime).toEqual(resultB.runtime)
      expect(resultA.runtime).toMatchObject({ phase: "ACTIVE", admission: "ALLOW" })

      const metrics = session.executionRunner.metrics()
      expect(metrics).toMatchObject({
        legacyRuns: 0,
        runtimeRuns: 1,
        admitted: 1,
        rejected: 0,
      })
      expect(metrics.terminals.COMPLETED).toBe(1)

      const turnExec = transitions.find((e) => e.to === "COMPLETED")
      expect(turnExec).toBeDefined()
      if (!turnExec) return
      const turnHistory = runtime.journal!.readExecutionHistory(turnExec.executionId)
      expect(
        turnHistory.some(
          (r) =>
            r.kind === "event" && r.executionId === turnExec.executionId && r.state === "COMPLETED",
        ),
      ).toBe(true)

      // 4b. Bukti replay: konsumen ketiga mulai dari 0 setelah presentasi
      // durable tersedia. Event yang sama harus datang sebagai REPLAY, bukan
      // hanya dari buffer live.
      await waitFor(
        () => presentationHead(session.sessionId, fx.dir) > 0,
        "presentasi turn belum durable",
      )
      const replayConsumer = await connectClient(host, "e2e-replay")
      const seenReplay = await subscribeAndRecord(replayConsumer, session.sessionId, 0)
      const replayed = eventsOf(seenReplay)
      expect(replayed.length).toBeGreaterThan(0)
      expect(replayed.every((e) => e.provenance === "REPLAY")).toBe(true)
      replayConsumer.ack(session.sessionId, replayed.at(-1)?.seq ?? 0)
      replayConsumer.close()
      await waitFor(() => host.server.connectionCount === 2, "konsumen replay tidak dilepas")

      // 5. Ack tersimpan durable; reconnect memakai identitas LOGIS yang sama.
      const bEvents = eventsOf(seenB)
      const acked = bEvents.at(-1)?.seq ?? 0
      expect(acked).toBeGreaterThan(0)
      b.ack(session.sessionId, acked)
      await waitFor(
        () => readConsumerOffset("e2e-b", session.sessionId, fx.dir) === acked,
        "ack konsumen B tidak tersimpan durable",
      )

      // 6. Putusnya satu konsumen tidak menghentikan runtime/scheduler.
      a.close()
      await waitFor(() => host.server.connectionCount === 1, "koneksi A tidak dilepas")
      expect(host.closing).toBe(false)
      expect(session.productionScheduler.isActive()).toBe(true)

      // 7. Kerja durable `background` lewat runner produksi yang sama.
      const store = createClaimedTask(fx, "p135-background")
      const task = store.listTasks(session.sessionId)[0]!
      expect(store.getExecutionOwnership(session.sessionId, task.id)?.executionOwner).toBe(
        "scheduler",
      )
      let backgroundRuns = 0
      const background = await session.executionRunner.run(taskRequest(task.id), async () => {
        backgroundRuns++
        return "background-done"
      })
      expect(background).toMatchObject({
        via: "runtime",
        state: "COMPLETED",
        result: "background-done",
      })
      expect(background.executionId).not.toBeNull()
      expect(backgroundRuns).toBe(1)
      if (!background.executionId) return
      expect(
        runtime
          .journal!.readExecutionHistory(background.executionId)
          .some((r) => r.kind === "event" && r.state === "COMPLETED"),
      ).toBe(true)
      expect(admitTaskWork(currentRuntimeView(), "background").admission).toBe("ALLOW")
      expect(store.getExecutionOwnership(session.sessionId, task.id)?.executionOwner).toBe(
        "scheduler",
      )

      // 8. Reconnect B: mulai dari offset ack, bukan replay 1..acked.
      b.close()
      await waitFor(() => host.server.connectionCount === 0, "koneksi B tidak dilepas")
      const b2 = await connectClient(host, "e2e-b")
      const seenB2 = await subscribeAndRecord(b2, session.sessionId, "resume")
      expect(eventsOf(seenB2).filter((e) => e.seq <= acked)).toEqual([])

      // 9. Event setelah reconnect = LIVE, dan runtime tetap ACTIVE.
      await session.runPromptWithVerify("lagi")
      await waitFor(
        () => eventsOf(seenB2).some((e) => e.seq > acked),
        "turn kedua tidak mengirim event baru ke konsumen yang reconnect",
      )
      expect(currentRuntimeView()).toMatchObject({
        phase: "ACTIVE",
        admission: "ALLOW",
      })

      b2.close()
      await host.shutdown("p135-e2e")

      // 10. Shutdown: admission tertutup, jurnal ditutup, drain selesai.
      const shutdown = session.productionRuntime.shutdownResult()
      expect(shutdown).not.toBeNull()
      if (!shutdown) return
      expect(shutdown.ok).toBe(true)
      expect(shutdown.admissionStopped).toBe(true)
      expect(shutdown.trackedWork.pending).toBe(0)
      expect(shutdown.outstandingAfter).toEqual([])
      expect(shutdown.journal.closed).toBe(true)
      expect(shutdown.phases.find((p) => p.phase === "journal-close")?.outcome).toBe("succeeded")
      expect(session.productionScheduler.isActive()).toBe(false)
      expect(host.shutdownSteps).toContain("close-hosted-session")
      expect(host.shutdownErrors).toEqual([])

      // 11. Durabilitas lintas-shutdown: riwayat terminal masih terbaca.
      const reopened = openExecutionJournal(runtime.journalPath, { readonly: true })
      try {
        expect(
          reopened
            .readExecutionHistory(turnExec.executionId)
            .some((r) => r.kind === "event" && r.state === "COMPLETED"),
        ).toBe(true)
        expect(
          reopened
            .readExecutionHistory(background.executionId)
            .some((r) => r.kind === "event" && r.state === "COMPLETED"),
        ).toBe(true)
      } finally {
        reopened.close()
      }

      // Telemetri konsumen tetap non-autoritatif, tetapi cukup untuk bukti
      // bahwa kedua koneksi dan pengiriman event benar-benar terjadi.
      const telemetry = host.telemetry.snapshot()
      expect(telemetry["connections.opened"]).toBeGreaterThanOrEqual(4)
      expect(telemetry["subscribe.attached"]).toBeGreaterThanOrEqual(4)
      expect(telemetry["events.delivered"]).toBeGreaterThan(0)
      expect(telemetry["events.replayed"]).toBeGreaterThan(0)
    } finally {
      unsubTransitions()
    }
  }, 30_000)

  test("mode off: turn legacy berjalan tanpa runtime/jurnal/scheduler", async () => {
    const fx = await startHosted("off", [{ kind: "text", text: "legacy-ok" }])
    const { host } = fx.started
    const session = fx.session

    // Gate tertutup = tak ada komposisi, tak ada scheduler, tak ada jurnal.
    expect(session.runtimeMode).toBe("off")
    expect(session.productionRuntime.enabled).toBe(false)
    expect(session.productionRuntime.constructed).toBe(false)
    expect(session.productionRuntime.runtime()).toBeNull()
    expect(session.productionRuntime.isClosed()).toBe(true)
    expect(session.productionScheduler.enabled).toBe(false)
    expect(session.productionScheduler.constructed).toBe(false)
    expect(session.productionScheduler.isActive()).toBe(false)
    expect(session.executionRunner.owns).toBe(false)
    expect(session.executionRunner.mode).toBe("off")
    expect(existsSync(runtimeJournalPath(fx.dir, session.sessionId))).toBe(false)

    const absent = currentRuntimeView()
    expect(absent).toMatchObject({ phase: "ABSENT", admission: "REFUSE" })

    const consumer = await connectClient(host, "legacy-observer")
    const seen = await subscribeAndRecord(consumer, session.sessionId, 0)

    const status = await consumer.control("daemon.status", {}, "p135-off-status")
    expect(status.ok).toBe(true)
    if (status.ok) {
      const result = status.result as { runtime: typeof absent }
      expect(result.runtime).toMatchObject({ phase: "ABSENT", admission: "REFUSE" })
    }

    // Turn tetap berjalan lewat jalur legacy yang sudah ada.
    await session.runPromptWithVerify("halo")
    await waitFor(() => eventsOf(seen).length > 0, "mode off tidak mengirim event presentasi")
    const metrics = session.executionRunner.metrics()
    expect(metrics).toMatchObject({
      legacyRuns: 1,
      runtimeRuns: 0,
      admitted: 0,
      rejected: 0,
    })
    expect(metrics.terminals).toEqual({})

    consumer.close()
    await host.shutdown("p135-off")
    expect(session.productionRuntime.shutdownResult()).toBeNull()
    expect(session.productionScheduler.isActive()).toBe(false)
    expect(host.shutdownErrors).toEqual([])
  }, 30_000)

  test("runtime berhenti: admission fail-closed, callback tidak jalan, record durable utuh", async () => {
    const fx = await startHosted("owned", [{ kind: "text", text: "tidak-dipakai" }])
    const { host } = fx.started
    const session = fx.session
    const runtime = fx.runtime
    expect(runtime).not.toBeNull()
    if (!runtime) return

    expect(currentRuntimeView()).toMatchObject({ phase: "ACTIVE", admission: "ALLOW" })
    const store = createClaimedTask(fx, "p135-fail-closed")
    const task = store.listTasks(session.sessionId)[0]!
    const lineageBefore = store.getExecutionLineage(session.sessionId, task.id)
    const ownershipBefore = store.getExecutionOwnership(session.sessionId, task.id)
    const historyBefore = runtime.journal!.readAll().length

    // Berhenti = admission latch menutup. Ini jalur nyata yang juga dipakai
    // shutdown; setelah ini kerja baru tidak boleh diterima.
    const stopped = await session.productionRuntime.stop()
    expect(stopped?.ok).toBe(true)
    expect(runtime.isClosed()).toBe(true)
    expect(runtime.isAdmissionOpen()).toBe(false)

    const stoppedView = currentRuntimeView()
    expect(stoppedView.phase).toBe("STOPPED")
    expect(stoppedView.admission).toBe("REFUSE")
    expect(admitTaskWork(stoppedView, "background").admission).toBe("REFUSE")

    let executed = false
    const failure = await session.executionRunner
      .run(taskRequest(task.id), async () => {
        executed = true
        return "harus-tidak-jalan"
      })
      .catch((e: unknown) => e)
    expect(executed).toBe(false)
    expect(failure).toMatchObject({ code: "RUNTIME_NOT_OWNED" })

    // Record durable tidak dihapus/di-revert oleh penolakan admission.
    expect(store.getTask(session.sessionId, task.id)?.status).toBe("IN_PROGRESS")
    expect(store.getExecutionLineage(session.sessionId, task.id)).toEqual(lineageBefore)
    expect(store.getExecutionOwnership(session.sessionId, task.id)).toEqual(ownershipBefore)

    // Jurnal tidak mendapat intent/event dari percobaan yang ditolak.
    const reopenedBeforeHostShutdown = openExecutionJournal(runtime.journalPath, {
      readonly: true,
    })
    try {
      expect(reopenedBeforeHostShutdown.readAll().length).toBe(historyBefore)
    } finally {
      reopenedBeforeHostShutdown.close()
    }

    await host.shutdown("p135-stopped")
    expect(host.shutdownErrors).toEqual([])
    expect(session.productionScheduler.isActive()).toBe(false)
    expect(session.productionRuntime.shutdownResult()).toEqual(stopped)
  }, 30_000)

  test("shutdown menunggu kerja terlacak yang masih berjalan dan menutup jurnal", async () => {
    const fx = await startHosted("owned", [{ kind: "text", text: "tidak-dipakai" }])
    const { host } = fx.started
    const session = fx.session
    const runtime = fx.runtime
    expect(runtime).not.toBeNull()
    if (!runtime) return

    const store = createClaimedTask(fx, "p135-inflight")
    const task = store.listTasks(session.sessionId)[0]!

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = false
    const running = session.executionRunner.run(taskRequest(task.id), async () => {
      entered = true
      await gate
      return "drained"
    })
    await waitFor(
      () => entered && session.executionRunner.metrics().runtimeRuns === 1,
      "kerja in-flight tidak pernah masuk ke runner",
    )

    const shutdownPromise = host.shutdown("p135-inflight")
    // Scheduler berhenti lebih dulu, lalu runtime menutup host-nya dan BARU
    // mengambil snapshot drain. Tunggu host-shutdown benar-benar selesai
    // (`lastShutdownDurationMs` diisi di akhir), lalu beri satu giliran agar
    // continuation drain mencatat kerja ini SEBELUM gate dibuka.
    await waitFor(
      () => !session.productionScheduler.isActive(),
      "scheduler tidak berhenti sebelum runtime drain",
    )
    await waitFor(
      () => runtime.metrics().host.host.lastShutdownDurationMs !== null,
      "runtime host tidak menyelesaikan fase shutdown",
    )
    await sleep(0)
    expect(session.productionRuntime.shutdownResult()).toBeNull()

    release()
    const outcome = await running
    expect(outcome).toMatchObject({
      via: "runtime",
      state: "COMPLETED",
      result: "drained",
    })
    await shutdownPromise

    const result = session.productionRuntime.shutdownResult()
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.ok).toBe(true)
    expect(result.trackedWork.registered).toBeGreaterThanOrEqual(1)
    expect(result.trackedWork.drained).toBeGreaterThanOrEqual(1)
    expect(result.trackedWork.pending).toBe(0)
    expect(result.outstandingAfter).toEqual([])
    expect(result.journal.closed).toBe(true)
    expect(result.phases.find((p) => p.phase === "execution-drain")?.outcome).toBe("succeeded")
    expect(host.shutdownErrors).toEqual([])

    expect(outcome.executionId).not.toBeNull()
    if (!outcome.executionId) return
    const reopened = openExecutionJournal(runtime.journalPath, { readonly: true })
    try {
      expect(
        reopened
          .readExecutionHistory(outcome.executionId)
          .some((r) => r.kind === "event" && r.state === "COMPLETED"),
      ).toBe(true)
    } finally {
      reopened.close()
    }
  }, 30_000)

  test("degradasi supervisi terlihat di status; kerja baru ditolak; cleanup ditunggu", async () => {
    const fx = await startHosted("owned", [{ kind: "text", text: "tidak-dipakai" }])
    const { host } = fx.started
    const session = fx.session
    const runtime = fx.runtime
    expect(runtime).not.toBeNull()
    if (!runtime) return
    expect(runtime.supervision).not.toBeNull()
    if (!runtime.supervision) return

    const consumer = await connectClient(host, "degraded-observer")
    await subscribeAndRecord(consumer, session.sessionId, "tail")

    let stopCalls = 0
    runtime.supervision.register({
      id: "p135-unsafe",
      kind: "unit",
      restartSafety: "unsafe",
      observe: () => ({ status: "failed", exitCode: 1 }),
      stop: async () => {
        stopCalls++
      },
    })
    await runtime.supervision.notifyExit("p135-unsafe", {
      status: "failed",
      exitCode: 1,
    })
    expect(runtime.supervisionStatus()?.operational).toBe(false)

    const degraded = currentRuntimeView()
    expect(degraded.phase).toBe("ACTIVE")
    expect(degraded.health).toBe("DEGRADED")
    expect(degraded.admission).toBe("REFUSE")
    expect(degraded.advertisedCapabilities).toContain("process-supervision")
    expect(degraded.availableCapabilities).not.toContain("process-supervision")

    // Kesehatan koneksi konsumen TERPISAH dari kesehatan runtime: konsumen
    // masih terhubung dan bisa membaca status runtime yang jujur.
    expect(host.server.connectionCount).toBe(1)
    expect(host.closing).toBe(false)
    const status = await consumer.control("daemon.status", {}, "p135-degraded-status")
    expect(status.ok).toBe(true)
    if (status.ok) {
      const result = status.result as { runtime: typeof degraded }
      expect(result.runtime).toMatchObject({
        phase: "ACTIVE",
        health: "DEGRADED",
        admission: "REFUSE",
      })
    }

    // Admission fail-closed: callback TIDAK dipanggil.
    let ran = false
    const failure = await session.executionRunner
      .run(
        {
          kind: "turn",
          schedulerSource: "cli-session",
          authorityHeld: true,
          ownerId: session.sessionId,
          provenance: { requestedBy: "user", reason: "p135-degraded" },
        },
        async () => {
          ran = true
          return "harus-tidak-jalan"
        },
      )
      .catch((e: unknown) => e)
    expect(ran).toBe(false)
    expect(failure).toMatchObject({ code: "RUNTIME_NOT_ADMITTED" })

    consumer.close()
    await host.shutdown("p135-degraded")
    expect(stopCalls).toBe(1)
    expect(host.shutdownErrors).toEqual([])
    const result = session.productionRuntime.shutdownResult()
    expect(result).not.toBeNull()
    expect(result?.phases.find((p) => p.phase === "process-cleanup")?.outcome).toBe("succeeded")
  }, 30_000)
})
