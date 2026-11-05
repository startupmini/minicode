// PROMPT 06 · Area C — observabilitas fase stream daemon (replay → live).
//
// Yang dijaga (integration, bukan klaim):
// 1. Fase AWAL stream dilaporkan di pesan `subscribed` (konsumen tak perlu
//    menebak apakah replay akan datang).
// 2. Fase LIVE dilaporkan di `tail_marker` — dan keduanya berasal dari LATCH
//    per-subscription yang sama (satu sumber kebenaran, bukan nilai yang
//    ditulis ulang di server).
// 3. Badge presentasi: fase wire dipetakan eksplisit ke kosakata provenance
//    TAMPILAN, dan memakai penanda yang SUDAH ada di lapisan presentasi.
// 4. Isolasi per-subscription: dua sesi/konsumen dengan fase berbeda tak
//    saling menimpa.
// 5. Reconnect: fase yang dilaporkan mencerminkan sisa replay yang BENAR.
// 6. Urutan wire: subscribed → event → replay_done → tail_marker.
//
// Test memakai daemon host NYATA + klien NYATA di loopback (tanpa mock).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { issueCapabilityFromEndpoint } from "../src/daemon/capability.ts"
import { DaemonClient } from "../src/daemon/client.ts"
import { readEndpoint } from "../src/daemon/discovery.ts"
import { createStoreFeed } from "../src/daemon/feed.ts"
import { DaemonHost } from "../src/daemon/host.ts"
import type { ServerMessage } from "../src/daemon/protocol.ts"
import type { DomainEvent } from "../src/presentation/events.ts"
import { provenanceMark } from "../src/presentation/projection.ts"
import { appendPresentationEvents } from "../src/session/persistence.ts"

let home = ""
let dir = ""
const openHosts: DaemonHost[] = []
const openClients: DaemonClient[] = []

function base(seq: number) {
  return { sessionId: "s1", eventSeq: seq, turnId: 1, ts: 1_700_000_000_000 + seq }
}

function toolStarted(seq: number): DomainEvent {
  return {
    ...base(seq),
    type: "tool.started",
    toolCallId: `c${seq}`,
    stepId: 1,
    identity: { origin: "builtin", name: "write_file", qualified: "write_file" },
    argsSummary: { target: "a.ts" },
  } as DomainEvent
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mc-c-phase-home-"))
  process.env.MINICODE_HOME = home
  dir = mkdtempSync(join(tmpdir(), "mc-c-phase-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
})

afterEach(async () => {
  for (const c of openClients.splice(0)) {
    try {
      c.close()
    } catch {}
  }
  for (const h of openHosts.splice(0)) await h.shutdown("test")
  delete process.env.MINICODE_HOME
})

async function startHost(known: string[] = ["s1"]): Promise<DaemonHost> {
  const set = new Set(known)
  const h = await DaemonHost.start({
    cwd: dir,
    port: 0,
    feeds: {
      get: (sid) => (set.has(sid) ? createStoreFeed(sid, dir) : undefined),
      known: () => [...set],
    },
    actions: null,
    leaseIntervalMs: 1_000,
  })
  openHosts.push(h)
  return h
}

async function connectClient(consumer: string): Promise<DaemonClient> {
  const ep = readEndpoint(dir)!
  const cap = issueCapabilityFromEndpoint(ep, { scopes: ["subscribe"], who: consumer })
  const client = await DaemonClient.connect({
    target: { host: ep.host, port: ep.port },
    capability: cap,
    consumer,
  })
  openClients.push(client)
  return client
}

describe("Area C: fase stream di wire (subscribed → tail_marker)", () => {
  test("subscribe dengan replay → subscribed.phase = replay; setelah tail_marker = live", async () => {
    await appendPresentationEvents("s1", dir, [toolStarted(1), toolStarted(2)])
    await startHost()

    const client = await connectClient("tester")
    const seen: ServerMessage[] = []
    client.on((e) => {
      if (e.kind === "message") seen.push(e.msg)
    })
    client.subscribe("s1", 0)
    await client.next((m) => m.t === "tail_marker", 5_000)

    const subscribed = seen.find((m) => m.t === "subscribed")
    expect(subscribed).toBeDefined()
    if (subscribed?.t !== "subscribed") throw new Error("tanpa subscribed")
    // Fase AWAL: masih ada event durable yang akan dikirim → replay.
    expect(subscribed.phase).toBe("replay")

    const marker = seen.find((m) => m.t === "tail_marker")
    if (marker?.t !== "tail_marker") throw new Error("tanpa tail_marker")
    expect(marker.phase).toBe("live")

    // Latch klien mencerminkan transisi itu.
    expect(client.phaseOf("s1")).toBe("live")
  })

  test("badge presentasi: fase replay → ' [replay]', fase live → tanpa badge", async () => {
    await appendPresentationEvents("s1", dir, [toolStarted(1)])
    await startHost()
    const client = await connectClient("tester")

    // Sebelum subscribe: tak ada fase → tak ada badge (bukan "replay" karangan).
    expect(client.phaseOf("s1")).toBeUndefined()
    expect(client.streamProvenance("s1")).toBeUndefined()
    expect(provenanceMark(client.streamProvenance("s1"))).toBe("")

    const seen: ServerMessage[] = []
    client.on((e) => {
      if (e.kind === "message") seen.push(e.msg)
    })
    client.subscribe("s1", 0)
    // Tunggu sampai burst selesai, lalu periksa apa yang DIKIRIM. Jangan
    // memakai `next(subscribed)` di sini: listener `next` dipasang SESUDAH
    // subscribe, sedangkan seluruh burst (subscribed + event + replay_done +
    // tail_marker) bisa tiba dalam satu chunk — pesan `subscribed` sudah lewat
    // sebelum waiter terpasang. Yang benar ditanyakan: "apa yang dilihat
    // konsumen pada saat subscribe?" — itu isi field `phase` pada pesan
    // `subscribed` yang terekam di `seen`.
    await client.next((m) => m.t === "tail_marker", 5_000)
    const subscribed = seen.find((m) => m.t === "subscribed")
    if (subscribed?.t !== "subscribed") throw new Error("tanpa subscribed")
    expect(subscribed.phase).toBe("replay")
    // Badge presentasi untuk fase yang dilihat konsumen saat itu: mapping
    // eksplisit wire → kosakata tampilan, lalu penanda presentasi.
    expect(provenanceMark(subscribed.phase === "replay" ? "replay" : "live")).toBe(" [replay]")

    // Latch sekarang = live (transisi sudah terjadi).
    expect(client.phaseOf("s1")).toBe("live")
    expect(client.streamProvenance("s1")).toBe("live")
    // Live tidak pernah diberi badge (aturan provenans: badge hanya non-live).
    expect(provenanceMark(client.streamProvenance("s1"))).toBe("")
    expect(seen.some((m) => m.t === "event")).toBe(true)
  })

  test("subscribe tail (tak ada replay) → subscribed.phase = live sejak awal", async () => {
    await appendPresentationEvents("s1", dir, [toolStarted(1)])
    await startHost()
    const client = await connectClient("tester")
    const seen: ServerMessage[] = []
    client.on((e) => {
      if (e.kind === "message") seen.push(e.msg)
    })
    client.subscribe("s1", "tail")
    await client.next((m) => m.t === "tail_marker", 5_000)
    const subscribed = seen.find((m) => m.t === "subscribed")
    if (subscribed?.t !== "subscribed") throw new Error("tanpa subscribed")
    expect(subscribed.phase).toBe("live")
    // Tak ada event replay yang dikirim.
    expect(seen.filter((m) => m.t === "event").length).toBe(0)
  })

  test("urutan wire: subscribed → event → replay_done → tail_marker", async () => {
    await appendPresentationEvents("s1", dir, [toolStarted(1), toolStarted(2)])
    await startHost()
    const client = await connectClient("tester")
    const types: string[] = []
    client.on((e) => {
      if (e.kind === "message") types.push(e.msg.t)
    })
    client.subscribe("s1", 0)
    await client.next((m) => m.t === "tail_marker", 5_000)

    const iSubscribed = types.indexOf("subscribed")
    const iReplayDone = types.indexOf("replay_done")
    const iTail = types.indexOf("tail_marker")
    expect(iSubscribed).toBeGreaterThanOrEqual(0)
    expect(iReplayDone).toBeGreaterThan(iSubscribed)
    expect(iTail).toBeGreaterThan(iReplayDone)
    // Semua event replay berada DI ANTARA subscribed dan replay_done.
    for (const [i, t] of types.entries()) {
      if (t === "event") expect(i).toBeGreaterThan(iSubscribed)
      if (t === "event") expect(i).toBeLessThan(iReplayDone)
    }
  })
})

describe("Area C: isolasi fase per-subscription", () => {
  test("dua sesi: satu replay, satu live — fase tak saling menimpa", async () => {
    await appendPresentationEvents("s1", dir, [toolStarted(1)])
    await startHost(["s1", "s2"])
    const client = await connectClient("tester")
    const seen: ServerMessage[] = []
    client.on((e) => {
      if (e.kind === "message") seen.push(e.msg)
    })
    // s1 punya event durable (replay), s2 kosong (langsung live).
    client.subscribe("s1", 0)
    client.subscribe("s2", "tail")
    await client.next((m) => m.t === "tail_marker", 5_000)

    const phases = new Map<string, string>()
    for (const m of seen) {
      if (m.t === "subscribed") phases.set(m.sid, m.phase)
    }
    expect(phases.get("s1")).toBe("replay")
    expect(phases.get("s2")).toBe("live")
    // Latch klien per-sesi: keduanya terpisah.
    expect(client.phaseOf("s1")).toBe("live")
    expect(client.phaseOf("s2")).toBe("live")
  })

  test("dua konsumen: consumer A replay, consumer B live — latch terpisah", async () => {
    await appendPresentationEvents("s1", dir, [toolStarted(1)])
    await startHost()
    const a = await connectClient("konsumen-a")
    const b = await connectClient("konsumen-b")

    const seenA: ServerMessage[] = []
    a.on((e) => {
      if (e.kind === "message") seenA.push(e.msg)
    })
    const seenB: ServerMessage[] = []
    b.on((e) => {
      if (e.kind === "message") seenB.push(e.msg)
    })

    a.subscribe("s1", 0)
    b.subscribe("s1", "tail")
    await a.next((m) => m.t === "tail_marker", 5_000)
    await b.next((m) => m.t === "tail_marker", 5_000)

    const phaseA = seenA.find((m) => m.t === "subscribed")
    const phaseB = seenB.find((m) => m.t === "subscribed")
    if (phaseA?.t !== "subscribed" || phaseB?.t !== "subscribed")
      throw new Error("tanpa subscribed")
    expect(phaseA.phase).toBe("replay")
    expect(phaseB.phase).toBe("live")
    // Masing-masing klien punya latch sendiri.
    expect(a.phaseOf("s1")).toBe("live")
    expect(b.phaseOf("s1")).toBe("live")
  })
})

describe("Area C: reconnect mencerminkan sisa replay yang benar", () => {
  test("resume dari offset yang tertinggal → fase replay; offset sudah di head → live", async () => {
    await appendPresentationEvents("s1", dir, [toolStarted(1), toolStarted(2)])
    await startHost()

    // Konsumen pertama: replay penuh, lalu ack sampai seq 1.
    const c1 = await connectClient("konsumen")
    c1.subscribe("s1", 0)
    await c1.next((m) => m.t === "tail_marker", 5_000)
    c1.ack("s1", 1)
    await Bun.sleep(100)
    c1.close()

    // Konsumen kedua dengan identitas logis sama: resume dari offset 1 →
    // masih ada seq 2 yang belum dikirim → fase replay.
    const c2 = await connectClient("konsumen")
    const seen2: ServerMessage[] = []
    c2.on((e) => {
      if (e.kind === "message") seen2.push(e.msg)
    })
    c2.subscribe("s1", "resume")
    await c2.next((m) => m.t === "tail_marker", 5_000)
    const sub2 = seen2.find((m) => m.t === "subscribed")
    if (sub2?.t !== "subscribed") throw new Error("tanpa subscribed")
    expect(sub2.fromSeq).toBe(2)
    expect(sub2.phase).toBe("replay")
    // Hanya sisa yang dikirim (bukan replay penuh).
    const replayed = seen2.filter((m) => m.t === "event")
    expect(replayed.length).toBe(1)
  })

  test("resume saat offset sudah di head → langsung live (tak ada replay)", async () => {
    await appendPresentationEvents("s1", dir, [toolStarted(1)])
    await startHost()

    const c1 = await connectClient("konsumen")
    c1.subscribe("s1", 0)
    await c1.next((m) => m.t === "tail_marker", 5_000)
    c1.ack("s1", 1)
    await Bun.sleep(100)
    c1.close()

    const c2 = await connectClient("konsumen")
    const seen2: ServerMessage[] = []
    c2.on((e) => {
      if (e.kind === "message") seen2.push(e.msg)
    })
    c2.subscribe("s1", "resume")
    await c2.next((m) => m.t === "tail_marker", 5_000)
    const sub2 = seen2.find((m) => m.t === "subscribed")
    if (sub2?.t !== "subscribed") throw new Error("tanpa subscribed")
    expect(sub2.fromSeq).toBe(2)
    expect(sub2.phase).toBe("live")
    expect(seen2.filter((m) => m.t === "event").length).toBe(0)
  })
})
