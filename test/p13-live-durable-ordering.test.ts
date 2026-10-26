// P13.6 — Forensik urutan live vs durable: kontrak fail-closed SETELAH fix.
//
// Temuan (dibuktikan deterministik pada kode pra-fix dengan versi
// defect-proof dari berkas ini — lihat laporan P13.6 §1): pra-fix,
// `publishDomainEvent` berjalan SINKRON di jalur onEvent, sehingga event
// durable live sampai ke konsumen SEBELUM append presentasi (async,
// setTimeout(0)). Konsumen bisa meng-ack event yang belum durable; bila
// append gagal/proses mati di jendela itu, offset durable melampaui sejarah
// yang benar-benar ada, dan konsumen-konsumen melihat sejarah DIVERGEN.
//
// Kontrak yang dibuktikan di sini (pasca-fix):
//   1. Append gagal ⇒ feed live FAIL-CLOSED: tidak ada event yang tampil,
//      tidak ada ack yang mungkin, offset tetap -1, turn tetap selesai
//      (degraded-loud, bukan crash sesi).
//   2. Pemulihan: setelah append sehat kembali, SETIAP event live yang diterima
//      sudah durable (seq <= presentationHead PADA SAAT diterima), ack
//      tersimpan dan tidak pernah melampaui head, dan replay konsumen lain
//      = himpunan seq yang sama (tidak ada sejarah privat).
//   3. Jalur normal (tanpa injeksi): invariant seq <= head pada setiap
//      penerimaan live tetap berlaku.
//
// Injeksi: gate deterministik pada seam `presentationAppend` (produksi tak
// mengeset; default = append sesungguhnya). Tanpa tidur arbiter.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type DaemonHostedRuntime, startDaemonHostedRuntime } from "../cli/commands/daemon.ts"
import type { CliSession } from "../cli/setup.ts"
import { DaemonClient } from "../src/daemon/client.ts"
import type { ServerMessage } from "../src/daemon/protocol.ts"
import { readConsumerOffset } from "../src/daemon/store.ts"
import type { DomainEvent } from "../src/presentation/events.ts"
import { installRuntimeStatusProvider } from "../src/runtime/runtime-status-provider.ts"
import {
  appendPresentationEvents,
  type PresentationPersistStats,
  presentationHead,
} from "../src/session/persistence.ts"
import { resetTaskStoreHandles } from "../src/task/store.ts"
import { startFakeProvider } from "./helpers/fake-provider.ts"

const dirs: string[] = []
const providers: ReturnType<typeof startFakeProvider>[] = []
const starts: DaemonHostedRuntime[] = []
const envBackup = new Map<string, string | undefined>()

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p136-order-"))
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

function eventMsgs(seen: ServerMessage[]): Extract<ServerMessage, { t: "event" }>[] {
  return seen.filter((m): m is Extract<ServerMessage, { t: "event" }> => m.t === "event")
}

function eventSeqs(seen: ServerMessage[]): number[] {
  return eventMsgs(seen).map((m) => m.seq)
}

/**
 * Perekam dengan pemeriksaan invariant PADA SAAT penerimaan: setiap event
 * live harus sudah durable (seq <= presentationHead) tepat ketika tiba.
 * Ini lebih kuat daripada memeriksa head di akhir: head monoton, jadi cek
 * di akhir bisa lolos meski event lebih awal pernah mendahului durability.
 */
function recordWithHeadCheck(
  client: DaemonClient,
  sid: string,
  dir: string,
): { seen: ServerMessage[]; violations: number[] } {
  const seen: ServerMessage[] = []
  const violations: number[] = []
  client.on((e) => {
    if (e.kind !== "message") return
    seen.push(e.msg)
    if (e.msg.t === "event") {
      const head = presentationHead(sid, dir)
      if (head < e.msg.seq) violations.push(e.msg.seq)
    }
  })
  return { seen, violations }
}

interface AppendGate {
  readonly presentationAppend: (events: readonly DomainEvent[]) => Promise<PresentationPersistStats>
  readonly calls: readonly (readonly DomainEvent[])[]
  release: () => void
}

function makeAppendGate(sid: string, dir: string): AppendGate {
  const calls: (readonly DomainEvent[])[] = []
  let failing = true
  return {
    calls,
    release: () => {
      failing = false
    },
    presentationAppend: (events) => {
      calls.push(events)
      if (failing) return Promise.reject(new Error("p13.6 injected append failure"))
      // Mode lolos = append SESUNGGUHNYA (seam menggantikan, bukan membungkus).
      return appendPresentationEvents(sid, dir, events)
    },
  }
}

interface Owned {
  readonly dir: string
  readonly gate: AppendGate
  readonly started: DaemonHostedRuntime
  readonly session: CliSession
}

async function startOwned(
  gateFactory: ((sid: string, dir: string) => AppendGate) | null,
  sessionId: string,
): Promise<Owned> {
  const dir = tempDir()
  const gate = gateFactory ? gateFactory(sessionId, dir) : null
  const home = join(dir, "home")
  const provider = startFakeProvider([
    { kind: "text", text: "satu" },
    { kind: "text", text: "dua" },
  ])
  providers.push(provider)
  mkdirSync(join(home, ".minicode"), { recursive: true })
  writeFileSync(
    join(home, ".minicode", "config.json"),
    JSON.stringify({
      providers: [
        { id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["gpt-4o-mini"] },
      ],
    }),
    "utf8",
  )
  isolateHome(home)
  const argv = ["--runtime", "owned", "--prompt", "halo", "--session", sessionId]
  const started = await startDaemonHostedRuntime({
    sub: argv,
    getArg: getArgFrom(argv),
    cwd: dir,
    ...(gate ? { presentationAppend: gate.presentationAppend } : {}),
  })
  starts.push(started)
  const session = started.session
  if (!session) throw new Error("sesi yang di-host tidak terbentuk")
  return { dir, gate: gate ?? makeNullGate(), started, session }
}

/** Gate non-operasional untuk tes jalur normal (tanpa injeksi). */
function makeNullGate(): AppendGate {
  return {
    calls: [],
    release: () => {},
    presentationAppend: () => Promise.reject(new Error("tidak boleh dipanggil (gate null)")),
  }
}

async function connectObserver(
  host: DaemonHostedRuntime["host"],
  who: string,
): Promise<{ client: DaemonClient; seen: ServerMessage[] }> {
  const capability = host.issueCapability({ scopes: ["subscribe"], who })
  const client = await DaemonClient.connect({
    target: { host: "127.0.0.1", port: host.port },
    capability,
    consumer: who,
  })
  const seen: ServerMessage[] = []
  client.on((e) => {
    if (e.kind === "message") seen.push(e.msg)
  })
  return { client, seen }
}

afterEach(async () => {
  for (const s of starts.splice(0)) {
    try {
      await s.host.shutdown("cleanup-p136-order")
    } catch {}
  }
  for (const p of providers.splice(0)) {
    try {
      p.close()
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

describe("P13.6 - urutan live vs durable (fail-closed pasca-fix)", () => {
  test("append gagal => feed live fail-closed: tanpa event, tanpa ack, turn tetap selesai", async () => {
    const { dir, gate, started, session } = await startOwned(makeAppendGate, "p136-order-a")
    const sid = session.sessionId

    const a = await connectObserver(started.host, "p136-a")
    a.client.subscribe(sid, 0)
    await waitFor(
      () => a.seen.some((m) => m.t === "tail_marker"),
      "konsumen A tidak mencapai tail_marker",
    )

    // Turn 1 berjalan; SETIAP append presentasi gagal (injeksi deterministik).
    await session.runPromptWithVerify("halo")
    await waitFor(
      () => gate.calls.flat().length >= 4,
      "append presentasi tidak pernah dicoba (seam tidak tersambung)",
    )

    // Fail-closed: tidak ada satu pun event yang tampil live.
    expect(eventSeqs(a.seen)).toEqual([])
    expect(presentationHead(sid, dir)).toBe(-1)
    // Tidak ada seq yang bisa di-ack; server juga menolak ack liar.
    a.client.ack(sid, 0)
    await waitFor(() => a.seen.some((m) => m.t === "error"), "ack liar tidak ditolak server")
    expect(readConsumerOffset("p136-a", sid, dir)).toBe(-1)
    // Kegagalan append adalah degraded-loud, bukan crash sesi: turn tetap
    // COMPLETED dan runner sehat.
    expect(session.executionRunner.metrics().terminals.COMPLETED).toBe(1)

    a.client.close()
    await started.host.shutdown("p136-order-a")
    expect(started.host.shutdownErrors).toEqual([])
  }, 30_000)

  test("pemulihan: live = durable-confirmed saat diterima; ack <= head; sejarah semua konsumen identik", async () => {
    const { dir, gate, started, session } = await startOwned(makeAppendGate, "p136-order-b")
    const sid = session.sessionId
    const host = started.host

    const a = await connectObserver(host, "p136-b")
    a.client.subscribe(sid, 0)
    await waitFor(
      () => a.seen.some((m) => m.t === "tail_marker"),
      "konsumen A tidak mencapai tail_marker",
    )

    // Fase gagal: turn 1 — tidak ada yang tampil live.
    await session.runPromptWithVerify("halo")
    await waitFor(() => gate.calls.flat().length >= 4, "append presentasi turn 1 tidak dicoba")
    expect(eventSeqs(a.seen)).toEqual([])

    // Pemulihan: append sehat kembali. Konsumen kedua B ikut berlangganan
    // (replay kosong: head masih -1) sebelum turn 2 — keduanya live.
    gate.release()
    const b = await connectObserver(host, "p136-c")
    b.client.subscribe(sid, 0)
    await waitFor(
      () => b.seen.some((m) => m.t === "tail_marker"),
      "konsumen B tidak mencapai tail_marker",
    )

    const recA = recordWithHeadCheck(a.client, sid, dir)
    const recB = recordWithHeadCheck(b.client, sid, dir)
    await session.runPromptWithVerify("lagi")

    // Konvergensi deterministik (bukan sleep): konsumen dikatakan lengkap
    // bila seq live terbesarnya == kepala durable. Event live pasca-fix
    // hanya bisa terbit SETELAH append, jadi konsumen yang tertinggal
    // pemublishan terakhir akan tertangkap poll ini — termasuk event
    // pasca-turn (mis. checkpoint) bila ada.
    const converged = (seen: ServerMessage[]) => {
      const seqs = eventSeqs(seen)
      return seqs.length > 0 && Math.max(...seqs) === presentationHead(sid, dir)
    }
    const liveA = await waitFor(
      () => (converged(recA.seen) ? eventSeqs(recA.seen) : null),
      "konsumen A tidak konvergen ke sejarah durable",
    )
    await waitFor(
      () => converged(recB.seen) && eventSeqs(recB.seen).length === liveA.length,
      "konsumen B tidak menerima himpunan event yang sama",
    )

    // INVARIANT: setiap event live SUDAH durable tepat saat diterima.
    expect(recA.violations).toEqual([])
    expect(recB.violations).toEqual([])
    const head = presentationHead(sid, dir)
    expect(Math.max(...liveA)).toBeLessThanOrEqual(head)

    // Ack: tersimpan durable dan tidak pernah melampaui head.
    const acked = Math.max(...liveA)
    a.client.ack(sid, acked)
    await waitFor(
      () => readConsumerOffset("p136-b", sid, dir) === acked,
      "ack A tidak tersimpan durable",
    )
    expect(readConsumerOffset("p136-b", sid, dir)).toBeLessThanOrEqual(presentationHead(sid, dir))

    // Sejarah identik: konsumen ketiga mereplay dari 0. View C = replay +
    // live apa pun yang datang setelah tail (dide-dup) harus SAMA dengan
    // view live A dan B — seq turn 1 yang gagal durable tidak pernah tampil
    // ke SIAPA PUN (tidak ada lagi sejarah privat seperti defect pra-fix).
    const c = await connectObserver(host, "p136-d")
    c.client.subscribe(sid, 0)
    await waitFor(
      () => c.seen.some((m) => m.t === "replay_done"),
      "konsumen C tidak menerima replay_done",
    )
    await waitFor(() => converged(c.seen), "konsumen C tidak konvergen ke sejarah durable")
    const uniq = (seqs: number[]) => [...new Set(seqs)].sort((x, y) => x - y)
    const viewA = uniq(eventSeqs(recA.seen))
    const viewB = uniq(eventSeqs(recB.seen))
    const viewC = uniq(eventSeqs(c.seen))
    expect(viewB).toEqual(viewA)
    expect(viewC).toEqual(viewA)
    expect(presentationHead(sid, dir)).toBe(Math.max(...viewA))

    a.client.close()
    b.client.close()
    c.client.close()
    await host.shutdown("p136-order-b")
    expect(host.shutdownErrors).toEqual([])
  }, 30_000)

  test("jalur normal (tanpa injeksi): setiap event live sudah durable saat diterima", async () => {
    const { dir, started, session } = await startOwned(null, "p136-order-c")
    const sid = session.sessionId
    const a = await connectObserver(started.host, "p136-e")
    const rec = recordWithHeadCheck(a.client, sid, dir)
    a.client.subscribe(sid, 0)
    await waitFor(
      () => rec.seen.some((m) => m.t === "tail_marker"),
      "konsumen tidak mencapai tail_marker",
    )
    await session.runPromptWithVerify("halo")
    const seqs = await waitFor(
      () => (eventSeqs(rec.seen).length > 0 ? eventSeqs(rec.seen) : null),
      "turn tidak tampil live",
    )
    expect(rec.violations).toEqual([])
    expect(presentationHead(sid, dir)).toBeGreaterThanOrEqual(Math.max(...seqs))
    a.client.close()
    await started.host.shutdown("p136-order-c")
  }, 30_000)
})
