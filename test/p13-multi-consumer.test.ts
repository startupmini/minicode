// P13.4 — beberapa konsumen bersamaan pada SATU runtime kanonik.
//
// Yang dibuktikan file ini (bukan klaim seluruh fase):
//   1. Dua konsumen melihat status runtime + provenance yang sama.
//   2. Putusnya satu konsumen tidak menghentikan runtime/konsumen lain.
//   3. Dua koneksi dengan identitas logis sama punya stream live sendiri;
//      menutup salah satu tidak mencabut langganan yang lain.
//   4. Reconnect memakai offset durable + batas replay/live yang benar, dan
//      capability inkarnasi lama ditolak.
//   5. Scope, stale-incarnation, dan idempotensi tetap menolak operasi salah.
//   6. Backpressure/overflow satu konsumen tidak melewati konsumen lain dan
//      tidak mengubah status runtime menjadi gagal.
//
// P13.3 (admission/ownership task durable) diuji di file lifecycle existing;
// file ini tidak membuat jalur task kedua.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { connect, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { issueCapabilityFromEndpoint } from "../src/daemon/capability.ts"
import { DaemonClient } from "../src/daemon/client.ts"
import type { ControlActions } from "../src/daemon/control.ts"
import { readEndpoint } from "../src/daemon/discovery.ts"
import type { SessionFeed } from "../src/daemon/feed.ts"
import { encodeFrame, FrameDecoder } from "../src/daemon/framing.ts"
import { DaemonHost } from "../src/daemon/host.ts"
import {
  DAEMON_PROTOCOL,
  type ServerMessage,
  type SessionFrontiers,
} from "../src/daemon/protocol.ts"
import { readConsumerOffset } from "../src/daemon/store.ts"
import type { DomainEvent } from "../src/presentation/events.ts"
import { deriveRuntimeView } from "../src/runtime/runtime-status.ts"
import { installRuntimeStatusProvider } from "../src/runtime/runtime-status-provider.ts"

const SID = "s1"

let dir = ""
let feed: MemoryFeed
const hosts: DaemonHost[] = []

function event(seq: number, text = "x"): DomainEvent {
  return {
    sessionId: SID,
    eventSeq: seq,
    turnId: 1,
    ts: 1_700_000_000_000 + seq,
    type: "provider:text",
    text,
  } as unknown as DomainEvent
}

/**
 * Feed in-memory yang meniru kontrak SessionFeed: replay membaca `events`,
 * live memanggil listener yang terpasang. Sengaja bukan toko kedua — ini
 * fixture test, bukan jalur produksi.
 */
class MemoryFeed implements SessionFeed {
  readonly sid = SID
  readonly hosted = true
  #events: DomainEvent[] = []
  #live = new Set<(event: DomainEvent) => void>()

  head(): number {
    return this.#events.at(-1)?.eventSeq ?? 0
  }

  frontiers(): SessionFrontiers {
    const head = this.head()
    return {
      writerEpoch: 0,
      presentationHead: head,
      messageHead: head,
      runId: null,
      runStatus: null,
    }
  }

  readRange(
    fromSeq: number,
    limit: number,
  ): { events: DomainEvent[]; rejected: number; head: number } {
    const events = this.#events.filter((e) => e.eventSeq >= fromSeq).slice(0, limit)
    return { events, rejected: 0, head: this.head() }
  }

  liveSubscribe(fn: (event: DomainEvent) => void): () => void {
    this.#live.add(fn)
    return () => this.#live.delete(fn)
  }

  append(next: DomainEvent): void {
    this.#events.push(next)
    for (const fn of [...this.#live]) fn(next)
  }
}

/** View runtime kanonik sintetis: ACTIVE + admission ALLOW + semua attachment. */
function activeView() {
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
      supervisorAttached: false,
      supervisionExpected: false,
      pendingJournalAppends: 0,
    },
    attachment: { journal: true, taskStore: true, scheduler: true, supervisor: false },
    supervisedChildren: 0,
    lastFlush: null,
  })
}

async function startHost(
  opts: {
    actions?: ControlActions | null
    maxQueuePerSubscription?: number
    maxQueuePerConsumer?: (consumerId: string) => number | undefined
  } = {},
): Promise<DaemonHost> {
  const host = await DaemonHost.start({
    cwd: dir,
    port: 0,
    feeds: {
      get: (sid) => (sid === SID ? feed : undefined),
      known: () => [SID],
    },
    actions: opts.actions ?? null,
    leaseIntervalMs: 1_000,
    ...(opts.maxQueuePerSubscription !== undefined
      ? { maxQueuePerSubscription: opts.maxQueuePerSubscription }
      : {}),
    ...(opts.maxQueuePerConsumer !== undefined
      ? { maxQueuePerConsumer: opts.maxQueuePerConsumer }
      : {}),
  })
  hosts.push(host)
  return host
}

async function connectClient(
  host: DaemonHost,
  scopes: Parameters<DaemonHost["issueCapability"]>[0]["scopes"],
  who: string,
): Promise<DaemonClient> {
  const capability = host.issueCapability({ scopes, who })
  return DaemonClient.connect({
    target: { host: "127.0.0.1", port: host.port },
    capability,
    consumer: who,
  })
}

function record(client: DaemonClient): ServerMessage[] {
  const seen: ServerMessage[] = []
  client.on((e) => {
    if (e.kind === "message") seen.push(e.msg)
  })
  return seen
}

async function waitFor<T>(
  fn: () => T | null | undefined | false,
  message: string,
  timeoutMs = 4_000,
): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(message)
    await Bun.sleep(10)
  }
}

function eventsOf(seen: ServerMessage[]): Extract<ServerMessage, { t: "event" }>[] {
  return seen.filter((m): m is Extract<ServerMessage, { t: "event" }> => m.t === "event")
}

function errorsOf(seen: ServerMessage[]): string[] {
  return seen
    .filter((m): m is Extract<ServerMessage, { t: "error" }> => m.t === "error")
    .map((m) => m.code)
}

/**
 * Klien mentah yang berhenti membaca SETELAH handshake. Hanya dipakai untuk
 * memastikan jalur backpressure nyata (bukan fixture antrean).
 */
async function pausedSubscriber(host: DaemonHost, who = "slow"): Promise<Socket> {
  const capability = host.issueCapability({ scopes: ["subscribe"], who })
  const sock = connect({ host: "127.0.0.1", port: host.port })
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve())
    sock.once("error", reject)
  })
  sock.on("error", () => {})
  const decoder = new FrameDecoder()
  let welcomed = false
  let tailMarker = false
  sock.on("data", (chunk: Buffer) => {
    for (const raw of decoder.push(chunk)) {
      const msg = raw as ServerMessage
      if (msg.t === "welcome") welcomed = true
      if (msg.t === "tail_marker") tailMarker = true
    }
  })
  sock.write(
    encodeFrame({
      t: "hello",
      protocol: DAEMON_PROTOCOL,
      cap: capability,
      consumer: who,
    }),
  )
  await waitFor(() => welcomed, "slow consumer tidak menerima welcome")
  sock.write(encodeFrame({ t: "subscribe", sid: SID, from: "tail", consumer: who }))
  await waitFor(() => tailMarker, "slow consumer tidak mencapai tail_marker")
  sock.pause()
  return sock
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-p134-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  feed = new MemoryFeed()
  installRuntimeStatusProvider(activeView)
})

afterEach(async () => {
  installRuntimeStatusProvider(null)
  for (const host of hosts.splice(0)) {
    try {
      await host.shutdown("test")
    } catch {}
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

describe("P13.4 — dua konsumen pada runtime yang sama", () => {
  test("status runtime, snapshot, dan provenance konsisten", async () => {
    feed.append(event(1))
    feed.append(event(2))
    const host = await startHost()

    const a = await connectClient(host, ["subscribe", "read:session"], "consumer-a")
    const b = await connectClient(host, ["subscribe", "read:session"], "consumer-b")
    const seenA = record(a)
    const seenB = record(b)

    a.subscribe(SID, 0)
    b.subscribe(SID, 0)
    await waitFor(
      () => seenA.some((m) => m.t === "tail_marker") && seenB.some((m) => m.t === "tail_marker"),
      "kedua konsumen tidak mencapai tail_marker",
    )

    // Event baru setelah tail marker = LIVE, dan harus sampai ke KEDUA
    // konsumen dengan seq yang sama.
    feed.append(event(3))
    await waitFor(
      () => eventsOf(seenA).some((e) => e.seq === 3) && eventsOf(seenB).some((e) => e.seq === 3),
      "event live tidak sampai ke kedua konsumen",
    )

    const statusA = await a.control("daemon.status", {}, "status-a")
    const statusB = await b.control("daemon.status", {}, "status-b")
    expect(statusA.ok).toBe(true)
    expect(statusB.ok).toBe(true)
    if (!statusA.ok || !statusB.ok) return

    const resultA = statusA.result as { incarnation: string; runtime: unknown }
    const resultB = statusB.result as { incarnation: string; runtime: unknown }
    expect(resultA.incarnation).toBe(host.incarnation)
    expect(resultB.incarnation).toBe(host.incarnation)
    expect(resultA.runtime).toEqual(resultB.runtime)
    expect(resultA.runtime).toMatchObject({
      phase: "ACTIVE",
      admission: "ALLOW",
      health: "HEALTHY",
    })

    const eventsA = eventsOf(seenA)
    const eventsB = eventsOf(seenB)
    expect(eventsA.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(eventsB.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(eventsA.map((e) => e.provenance)).toEqual(["REPLAY", "REPLAY", "LIVE"])
    expect(eventsB.map((e) => e.provenance)).toEqual(eventsA.map((e) => e.provenance))

    const snapshotA = seenA.find((m) => m.t === "snapshot")
    const snapshotB = seenB.find((m) => m.t === "snapshot")
    expect(snapshotA).toBeDefined()
    expect(snapshotB).toBeDefined()
    if (snapshotA?.t === "snapshot" && snapshotB?.t === "snapshot") {
      expect(snapshotA.snapshot.provenance).toBe("REPLAY")
      expect(snapshotB.snapshot.provenance).toBe("REPLAY")
      expect(snapshotA.snapshot.frontiers).toEqual(snapshotB.snapshot.frontiers)
    }

    a.close()
    b.close()
  })

  test("satu konsumen putus: runtime dan konsumen lain tetap hidup", async () => {
    feed.append(event(1))
    const host = await startHost()
    const a = await connectClient(host, ["subscribe", "read:session"], "gone")
    const b = await connectClient(host, ["subscribe", "read:session"], "stays")
    const seenB = record(b)

    a.subscribe(SID, 0)
    b.subscribe(SID, 0)
    await waitFor(() => eventsOf(seenB).length === 1, "konsumen B tidak menerima replay")

    a.close()
    await waitFor(() => host.server.connectionCount === 1, "koneksi A tidak dilepas")
    feed.append(event(2))
    await waitFor(
      () => eventsOf(seenB).some((e) => e.seq === 2),
      "konsumen B berhenti setelah A putus",
    )

    const status = await b.control("daemon.status", {}, "after-disconnect")
    expect(status.ok).toBe(true)
    if (status.ok) {
      expect(status.result).toMatchObject({
        incarnation: host.incarnation,
        runtime: { phase: "ACTIVE", admission: "ALLOW" },
      })
    }
    expect(host.closing).toBe(false)
    b.close()
  })

  test("identitas konsumen sama: dua koneksi tidak saling menutup langganan", async () => {
    const host = await startHost()
    // Capability yang SAMA dipakai dua koneksi: identitas logis sama, tetapi
    // masing-masing adalah konsumen live yang independen.
    const capability = host.issueCapability({ scopes: ["subscribe"], who: "shared" })
    const target = { host: "127.0.0.1", port: host.port }
    const a = await DaemonClient.connect({ target, capability, consumer: "shared" })
    const b = await DaemonClient.connect({ target, capability, consumer: "shared" })
    const seenA = record(a)
    const seenB = record(b)

    a.subscribe(SID, "tail")
    b.subscribe(SID, "tail")
    await waitFor(
      () => seenA.some((m) => m.t === "tail_marker") && seenB.some((m) => m.t === "tail_marker"),
      "salah satu langganan identitas sama tidak aktif",
    )

    feed.append(event(1))
    await waitFor(
      () => eventsOf(seenA).some((e) => e.seq === 1) && eventsOf(seenB).some((e) => e.seq === 1),
      "langganan identitas sama saling menutup",
    )

    a.close()
    await waitFor(() => host.server.connectionCount === 1, "koneksi A tidak dilepas")
    feed.append(event(2))
    await waitFor(() => eventsOf(seenB).some((e) => e.seq === 2), "teardown A mencabut langganan B")
    expect(b.closed).toBe(false)
    b.close()
  })

  test("reconnect memakai offset + batas replay/live; inkarnasi basi ditolak", async () => {
    feed.append(event(1))
    feed.append(event(2))
    const host = await startHost()
    const capability = host.issueCapability({ scopes: ["subscribe"], who: "resumer" })
    const target = { host: "127.0.0.1", port: host.port }

    const first = await DaemonClient.connect({ target, capability, consumer: "resumer" })
    const seenFirst = record(first)
    first.subscribe(SID, 0)
    await waitFor(() => eventsOf(seenFirst).length === 2, "replay awal tidak lengkap")
    expect(eventsOf(seenFirst).map((e) => e.seq)).toEqual([1, 2])
    first.ack(SID, 2)
    await waitFor(
      () => readConsumerOffset("resumer", SID, dir) === 2,
      "ack 2 tidak tersimpan durable",
    )
    first.close()

    // Event yang lahir saat konsumen putus tetap durable; reconnect harus
    // memulainya dari offset 3, bukan mengulang 1/2.
    feed.append(event(3))
    const second = await DaemonClient.connect({ target, capability, consumer: "resumer" })
    expect(second.welcome?.incarnation).toBe(host.incarnation)
    const seenSecond = record(second)
    second.subscribe(SID, "resume")
    await waitFor(() => eventsOf(seenSecond).length === 1, "resume tidak mengirim event 3")
    expect(eventsOf(seenSecond).map((e) => ({ seq: e.seq, provenance: e.provenance }))).toEqual([
      { seq: 3, provenance: "REPLAY" },
    ])

    // Sesudah tail marker, event baru = LIVE; tidak ada duplikat replay.
    await waitFor(
      () => seenSecond.some((m) => m.t === "tail_marker"),
      "resume tidak mencapai tail_marker",
    )
    feed.append(event(4))
    await waitFor(() => eventsOf(seenSecond).some((e) => e.seq === 4), "event live 4 tidak tiba")
    expect(eventsOf(seenSecond).map((e) => e.seq)).toEqual([3, 4])
    expect(eventsOf(seenSecond).at(-1)?.provenance).toBe("LIVE")

    // Capability bertanda tangan sah tetapi inkarnasi lama: tolak tegas, bukan
    // diam-diam menyambung ke dunia yang berbeda.
    const ep = readEndpoint(dir)
    expect(ep).not.toBeNull()
    if (ep) {
      const stale = issueCapabilityFromEndpoint(
        { ...ep, incarnation: "inc_lama" },
        { scopes: ["subscribe"], who: "stale" },
      )
      await expect(
        DaemonClient.connect({ target, capability: stale, consumer: "stale" }),
      ).rejects.toThrow("STALE_INCARNATION")
    }

    second.close()
  })

  test("scope dan idempotensi tetap menolak operasi yang salah", async () => {
    let listCalls = 0
    const actions: ControlActions = {
      listSessions: () => {
        listCalls++
        return []
      },
      sessionStatus: () => null,
      interrupt: () => ({ ok: false, code: "RUN_TERMINAL", message: "tidak ada run" }),
      cancel: () => ({ ok: false, code: "RUN_TERMINAL", message: "tidak ada run" }),
      shutdown: () => {},
    }
    const host = await startHost({ actions })

    const observer = await connectClient(host, ["read:session"], "observer")
    const observer2 = await connectClient(host, ["read:session"], "observer-2")
    const subscriber = await connectClient(host, ["subscribe"], "subscriber")
    const observerSeen = record(observer)

    // Cakupan baca tidak boleh berubah menjadi langganan, dan cakupan
    // subscribe tidak boleh menjalankan operasi kontrol.
    observer.subscribe(SID, 0)
    await waitFor(
      () => errorsOf(observerSeen).includes("SCOPE_DENIED"),
      "subscribe tanpa scope tidak ditolak",
    )
    const denied = await subscriber.control("daemon.status", {}, "no-read")
    expect(denied.ok).toBe(false)
    expect(denied.refusal?.code).toBe("SCOPE_DENIED")

    const first = await observer.control("session.list", {}, "idem-shared")
    expect(first.ok).toBe(true)
    expect(listCalls).toBe(1)
    const retry = await observer.control("session.list", {}, "idem-shared")
    expect(retry.ok).toBe(true)
    expect(listCalls).toBe(1)

    // Konsumen LAIN dengan idem sama bukan replay: namespace idempotensi
    // dipisah per identitas konsumen.
    const other = await observer2.control("session.list", {}, "idem-shared")
    expect(other.ok).toBe(true)
    expect(listCalls).toBe(2)
    const conflict = await observer2.control("session.list", { probe: true }, "idem-shared")
    expect(conflict.ok).toBe(false)
    expect(conflict.refusal?.code).toBe("IDEMPOTENT_REPLAY")

    observer.close()
    observer2.close()
    subscriber.close()
  })

  test("overflow satu konsumen tidak melewati konsumen lain atau runtime", async () => {
    // Batas antrean per-konsumen: `slowbac` ditahan sejak awal, `fast` normal.
    // Seam ini hanya untuk menguji jalur `#fanout` nyata tanpa bergantung pada
    // besar buffer kernel mesin uji.
    const host = await startHost({
      maxQueuePerConsumer: (who) => (who === "slowbac" ? 0 : undefined),
    })
    // Konsumen lambat HARUS lebih dulu di daftar fan-out: bug lama `return`
    // melewati konsumen SESUDAHNYA. Kalau urutannya dibalik, tes ini lolos
    // tanpa membuktikan apa pun.
    const slowbac = await pausedSubscriber(host, "slowbac")
    const fast = await connectClient(host, ["subscribe", "read:session"], "fast")
    const seen = record(fast)
    fast.subscribe(SID, "tail")
    await waitFor(
      () => seen.some((m) => m.t === "tail_marker"),
      "konsumen cepat tidak mencapai tail_marker",
    )

    try {
      // Konsumen lambat menerima event pertama, lalu antreannya penuh. Event
      // berikutnya harus tetap sampai ke konsumen cepat — dulu `return`
      // melewati seluruh sisa daftar konsumen untuk seq itu.
      for (let seq = 1; seq <= 4; seq++) {
        feed.append(event(seq))
        await Bun.sleep(20)
      }
      await waitFor(
        () => host.telemetry.get("events.dropped.overflow") > 0,
        "overflow konsumen lambat tidak terdeteksi",
      )
      // Kontrak yang diuji: konsumen cepat menerima SEMUA seq, termasuk seq
      // yang membuat konsumen lambat overflow. Teardown socket lambat terjadi
      // lewat timer paksa-tutup; itu bukan bagian kontrak fan-out.
      await waitFor(
        () => eventsOf(seen).some((e) => e.seq === 4),
        "konsumen cepat kehilangan seq saat konsumen lain overflow",
      )
      expect(eventsOf(seen).map((e) => e.seq)).toEqual([1, 2, 3, 4])

      const status = await fast.control("daemon.status", {}, "after-overflow")
      expect(status.ok).toBe(true)
      if (status.ok) {
        expect(status.result).toMatchObject({
          runtime: { phase: "ACTIVE", admission: "ALLOW" },
        })
      }
      expect(host.closing).toBe(false)
      expect(fast.closed).toBe(false)
    } finally {
      slowbac.destroy()
      fast.close()
    }
  })
})
