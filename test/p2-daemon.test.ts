// P2.12 — test daemon host, IPC, replay/live-tail, kontrol, persetujuan.
//
// Semua test hermetic: direktori temp sendiri (MINICODE_HOME + .minicode
// lokal), loopback dengan port ephemeral. Tak ada test yang menyentuh berkas
// milik repo atau menunggu proses lain.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ApprovalBroker } from "../src/daemon/approvals.ts"
import {
  hasScope,
  issueCapabilityFromEndpoint,
  mintCapability,
  verifyCapability,
} from "../src/daemon/capability.ts"
import { ChildSupervisor } from "../src/daemon/children.ts"
import { DaemonClient, probeDaemon } from "../src/daemon/client.ts"
import {
  type ControlActions,
  type ControlRequest,
  dispatchControl,
  IdempotencyStore,
} from "../src/daemon/control.ts"
import {
  clearDiscovery,
  discover,
  readEndpoint,
  writeEndpoint,
  writeLease,
} from "../src/daemon/discovery.ts"
import { createStoreFeed } from "../src/daemon/feed.ts"
import { encodeFrame, FrameDecoder, FrameError } from "../src/daemon/framing.ts"
import { DaemonHost } from "../src/daemon/host.ts"
import { MAX_FRAME_BYTES, type ServerMessage } from "../src/daemon/protocol.ts"
import { checkStorage, ResourceMonitor } from "../src/daemon/resource.ts"
import { sanitizeIncoming, sanitizeLabel } from "../src/daemon/sanitize.ts"
import {
  canTransition,
  createApproval,
  getApproval,
  listApprovals,
  markPendingApprovalsUnknown,
  readConsumerOffset,
  transitionApproval,
  writeConsumerOffset,
} from "../src/daemon/store.ts"
import { BoundedQueue, Subscription, SubscriptionRegistry } from "../src/daemon/subscription.ts"
import { Telemetry } from "../src/daemon/telemetry.ts"
import type { DomainEvent } from "../src/presentation/events.ts"
import { appendPresentationEvents } from "../src/session/persistence.ts"

// ---------------------------------------------------------------------------
// Utilitas
// ---------------------------------------------------------------------------

let home = ""
let dir = ""
const openHosts: DaemonHost[] = []

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), "mc-p212-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

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

function toolCompleted(seq: number): DomainEvent {
  return {
    ...base(seq),
    type: "tool.completed",
    toolCallId: `c${seq}`,
    durationMs: 5,
    summary: "ok",
    expandRef: { toolCallId: `c${seq}`, idx: 0 },
  } as DomainEvent
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mc-p212-home-"))
  process.env.MINICODE_HOME = home
  freshDir()
})

afterEach(async () => {
  for (const h of openHosts.splice(0)) await h.shutdown("test")
  delete process.env.MINICODE_HOME
})

async function startHost(extra: Record<string, unknown> = {}): Promise<DaemonHost> {
  const known = new Set((extra.known as string[] | undefined) ?? ["s1"])
  delete extra.known
  const h = await DaemonHost.start({
    cwd: dir,
    port: 0,
    // Registry HARUS mengembalikan undefined untuk sesi tak dikenal — kalau
    // selalu mengembalikan feed, sesi mana pun dianggap ada dan guard
    // NOT_FOUND tak pernah bisa terbukti.
    feeds: {
      get: (sid) => (known.has(sid) ? createStoreFeed(sid, dir) : undefined),
      known: () => [...known],
    },
    actions: null,
    leaseIntervalMs: 1_000,
    ...extra,
  })
  openHosts.push(h)
  return h
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

describe("framing berpalang panjang", () => {
  test("roundtrip utuh", () => {
    const dec = new FrameDecoder()
    const out = dec.push(encodeFrame({ t: "ping", id: "a" }))
    expect(out).toEqual([{ t: "ping", id: "a" }])
    expect(dec.pendingBytes).toBe(0)
  })

  test("chunk yang terpotong di tengah frame tetap utuh", () => {
    const dec = new FrameDecoder()
    const frame = encodeFrame({ t: "ping", id: "potong-payload-cukup-panjang" })
    const first = dec.push(frame.subarray(0, 3))
    expect(first).toEqual([])
    const second = dec.push(frame.subarray(3, 9))
    expect(second).toEqual([])
    const third = dec.push(frame.subarray(9))
    expect(third).toEqual([{ t: "ping", id: "potong-payload-cukup-panjang" }])
  })

  test("beberapa frame dalam satu chunk dipisah dengan benar", () => {
    const dec = new FrameDecoder()
    const joined = Buffer.concat([
      encodeFrame({ i: 1 }),
      encodeFrame({ i: 2 }),
      encodeFrame({ i: 3 }),
    ])
    expect(dec.push(joined)).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }])
  })

  test("frame raksasa ditolak sebelum dialokasikan", () => {
    const dec = new FrameDecoder()
    const head = Buffer.alloc(4)
    head.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => dec.push(head)).toThrow(FrameError)
  })

  test("payload bukan JSON ditolak", () => {
    const dec = new FrameDecoder()
    const body = Buffer.from("bukan-json", "utf8")
    const frame = Buffer.alloc(4 + body.length)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)
    expect(() => dec.push(frame)).toThrow("frame payload bukan JSON valid")
  })

  test("encode menolak payload yang melebihi batas", () => {
    const big = "x".repeat(MAX_FRAME_BYTES + 10)
    expect(() => encodeFrame({ t: "event", big })).toThrow("FRAME_TOO_LARGE")
  })
})

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

describe("capability bercakupan", () => {
  const secret = Buffer.from("0123456789abcdef0123456789abcdef")
  const inc = "inc_test"

  test("mint + verify lolos dan membawa cakupan yang diminta", () => {
    const tok = mintCapability(secret, {
      incarnation: inc,
      scopes: ["subscribe"],
      who: "u1",
      ttlMs: 60_000,
    })
    const r = verifyCapability(secret, tok, { incarnation: inc })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.payload.scopes).toEqual(["subscribe"])
  })

  test("cakupan tak dikenal dibuang saat mint", () => {
    const tok = mintCapability(secret, {
      incarnation: inc,
      scopes: ["subscribe", "superuser" as never],
      who: "u1",
      ttlMs: 60_000,
    })
    const r = verifyCapability(secret, tok, { incarnation: inc })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.payload.scopes).toEqual(["subscribe"])
  })

  test("token dimanipulasi ditolak (signature)", () => {
    const tok = mintCapability(secret, {
      incarnation: inc,
      scopes: ["admin"],
      who: "u1",
      ttlMs: 60_000,
    })
    const tampered = tok.slice(0, tok.length - 3) + "aaa"
    expect(verifyCapability(secret, tampered, { incarnation: inc })).toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    })
  })

  test("payload diganti di dalam (encoding ulang) tetap ditolak", () => {
    const tok = mintCapability(secret, {
      incarnation: inc,
      scopes: ["subscribe"],
      who: "u1",
      ttlMs: 60_000,
    })
    const body = Buffer.from(tok.slice(0, tok.lastIndexOf(".")), "base64url").toString("utf8")
    const forged = JSON.parse(body) as { scopes: string[] }
    forged.scopes = ["admin"]
    const reencoded =
      Buffer.from(JSON.stringify(forged), "utf8").toString("base64url") +
      "." +
      tok.slice(tok.lastIndexOf(".") + 1)
    expect(verifyCapability(secret, reencoded, { incarnation: inc })).toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    })
  })

  test("kedaluwarsa ditolak", () => {
    const now = 1_000_000
    const tok = mintCapability(secret, {
      incarnation: inc,
      scopes: ["subscribe"],
      who: "u1",
      ttlMs: 1_000,
      now,
    })
    expect(verifyCapability(secret, tok, { incarnation: inc, now: now + 5_000 })).toEqual({
      ok: false,
      reason: "EXPIRED",
    })
  })

  test("incarnation berbeda = capability lama mati", () => {
    const tok = mintCapability(secret, {
      incarnation: "inc_lama",
      scopes: ["admin"],
      who: "u1",
      ttlMs: 60_000,
    })
    expect(verifyCapability(secret, tok, { incarnation: "inc_baru" })).toEqual({
      ok: false,
      reason: "STALE_INCARNATION",
    })
  })

  test("admin tidak otomatis memuat cakupan lain", () => {
    expect(hasScope({ scopes: ["admin"] } as never, "approve")).toBe(false)
    expect(hasScope({ scopes: ["admin", "approve"] } as never, "approve")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Toko durable
// ---------------------------------------------------------------------------

describe("offset konsumen", () => {
  test("default -1, naik, dan ack mundur diabaikan", () => {
    expect(readConsumerOffset("c1", "s1", dir)).toBe(-1)
    expect(writeConsumerOffset("c1", "s1", 5, dir)).toBe(5)
    expect(writeConsumerOffset("c1", "s1", 3, dir)).toBe(5)
    expect(writeConsumerOffset("c1", "s1", 9, dir)).toBe(9)
    expect(readConsumerOffset("c1", "s1", dir)).toBe(9)
  })

  test("offset konsumen berbeda tidak saling memengaruhi", () => {
    writeConsumerOffset("c1", "s1", 4, dir)
    writeConsumerOffset("c2", "s1", 7, dir)
    expect(readConsumerOffset("c1", "s1", dir)).toBe(4)
    expect(readConsumerOffset("c2", "s1", dir)).toBe(7)
  })
})

describe("mesin persetujuan durable", () => {
  const row = {
    approvalId: "apr_1",
    sid: "s1",
    runId: null,
    tool: "write_file",
    summary: "a.ts",
    requestedAt: 1_000,
    expiresAt: 10_000,
    incarnation: "inc_a",
  }

  test("requested -> pending -> accepted", () => {
    createApproval({ ...row }, dir)
    transitionApproval("apr_1", "pending", {}, dir)
    const done = transitionApproval("apr_1", "accepted", { decision: "accept" }, dir)
    expect(done.state).toBe("accepted")
    expect(done.decision).toBe("accept")
  })

  test("transisi dari state terminal ditolak", () => {
    createApproval({ ...row }, dir)
    transitionApproval("apr_1", "denied", { decision: "deny" }, dir)
    expect(() => transitionApproval("apr_1", "accepted", { decision: "accept" }, dir)).toThrow(
      "tidak sah",
    )
    expect(canTransition("accepted", "pending")).toBe(false)
  })

  test("restart memindahkan yang belum terjawab ke UNKNOWN, bukan denied", () => {
    createApproval({ ...row }, dir)
    createApproval({ ...row, approvalId: "apr_2" }, dir)
    transitionApproval("apr_2", "pending", {}, dir)
    const moved = markPendingApprovalsUnknown("inc_b", dir)
    expect(moved).toBe(2)
    expect(getApproval("apr_1", dir)?.state).toBe("UNKNOWN")
    expect(getApproval("apr_2", dir)?.state).toBe("UNKNOWN")
    // Bukan denied: tidak ada yang menolak.
    expect(getApproval("apr_2", dir)?.decision).toBe("daemon-restart")
  })

  test("UNKNOWN terminal — tak bisa diklaim diterima/ditolak belakangan", () => {
    createApproval({ ...row }, dir)
    markPendingApprovalsUnknown("inc_b", dir)
    expect(() => transitionApproval("apr_1", "accepted", { decision: "accept" }, dir)).toThrow(
      "tidak sah",
    )
  })
})

// ---------------------------------------------------------------------------
// Langganan + antrean
// ---------------------------------------------------------------------------

describe("langganan & antrean terbatas", () => {
  test("antrean menolak saat penuh tanpa membuang diam-diam", () => {
    const q = new BoundedQueue<number>(3)
    expect(q.push(1)).toBe(true)
    expect(q.push(2)).toBe(true)
    expect(q.push(3)).toBe(true)
    expect(q.push(4)).toBe(false)
    expect(q.full).toBe(true)
    expect(q.drain()).toEqual([1, 2, 3])
  })

  test("attach: tail tidak mereplay, angka eksplisit mereplay, resume pakai offset", () => {
    const reg = new SubscriptionRegistry()
    const t = reg.attach(
      { consumerId: "c", sid: "s", from: "tail", head: 10, fromSeq: 0 },
      () => -1,
    )
    expect(t.fromSeq).toBe(11)
    expect(t.sub.cursor).toBe(10)

    const r = reg.attach({ consumerId: "c", sid: "s", from: 4, head: 10, fromSeq: 0 }, () => -1)
    expect(r.fromSeq).toBe(4)
    expect(r.sub.cursor).toBe(3)

    // 0 = replay dari awal, BUKAN resume: makna ini harus terpisah tegas.
    const z = reg.attach({ consumerId: "c", sid: "s", from: 0, head: 10, fromSeq: 0 }, () => 99)
    expect(z.fromSeq).toBe(0)
  })

  test("attach: resume memakai offset ack terakhir bila ada", () => {
    writeConsumerOffset("c", "s", 6, dir)
    const reg = new SubscriptionRegistry()
    const t = reg.attach(
      { consumerId: "c", sid: "s", from: "resume", head: 20, fromSeq: 0 },
      (c, s) => readConsumerOffset(c, s, dir),
    )
    expect(t.fromSeq).toBe(7)

    // Tanpa offset sama sekali: resume = tail (jangan membanjiri replay).
    const fresh = new SubscriptionRegistry()
    const u = fresh.attach(
      { consumerId: "c2", sid: "s", from: "resume", head: 20, fromSeq: 0 },
      () => -1,
    )
    expect(u.fromSeq).toBe(21)
  })

  test("ack di atas cursor ditolak (tak bisa memproses yang belum terkirim)", () => {
    const sub = new Subscription({ consumerId: "c", sid: "s", fromSeq: 5 })
    sub.cursor = 9
    expect(sub.ack(9).ok).toBe(true)
    expect(sub.ack(10)).toEqual({ ok: false, reason: "OUT_OF_RANGE" })
    expect(sub.ack(-1)).toEqual({ ok: false, reason: "OUT_OF_RANGE" })
    // Penolakan tak boleh menggeser apa pun: kursor = "terkirim", dan ack di
    // luar jangkauan berarti konsumen salah baca — bukan alasan untuk maju.
    expect(sub.cursor).toBe(9)
  })

  test("penggantian langganan lama pada kunci sama menutup yang lama", () => {
    const reg = new SubscriptionRegistry()
    const a = reg.attach({ consumerId: "c", sid: "s", from: 1, head: 0, fromSeq: 0 }, () => -1)
    const b = reg.attach({ consumerId: "c", sid: "s", from: 1, head: 0, fromSeq: 0 }, () => -1)
    expect(a.sub.closed).toBe(true)
    expect(b.sub.closed).toBe(false)
    expect(reg.size).toBe(1)
  })

  test("kunci langganan tak bisa disusupi lewat penggabungan identitas", () => {
    expect(SubscriptionRegistry.key("a b", "c")).not.toBe(SubscriptionRegistry.key("a", "b c"))
  })
})

// ---------------------------------------------------------------------------
// API kontrol
// ---------------------------------------------------------------------------

const noopActions: ControlActions = {
  listSessions: () => [
    {
      sid: "s1",
      hosted: true,
      writerEpoch: 0,
      runId: null,
      runStatus: "RUNNING",
      presentationHead: 3,
    },
  ],
  sessionStatus: (sid) =>
    sid === "s1"
      ? {
          sid: "s1",
          hosted: true,
          writerEpoch: 0,
          runId: null,
          runStatus: "RUNNING",
          presentationHead: 3,
        }
      : null,
  interrupt: () => ({ ok: true }),
  cancel: () => ({ ok: true }),
  shutdown: () => {},
}

function controlDeps(overrides: Record<string, unknown> = {}) {
  const telemetry = new Telemetry()
  return {
    deps: {
      incarnation: "inc_t",
      actions: noopActions,
      approvals: new ApprovalBroker({ incarnation: "inc_t", propose: () => {}, cwd: dir }),
      telemetry,
      storageOk: () => true,
      shuttingDown: () => false,
      ...overrides,
    },
    telemetry,
  }
}

describe("API kontrol", () => {
  test("operasi tak dikenal ditolak PROTOCOL_ERROR", () => {
    const { deps } = controlDeps()
    const r = dispatchControl(
      { consumerId: "c", scopes: ["admin"], op: "tidak.ada", idem: "i1", args: {} },
      deps,
      new IdempotencyStore(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal.code).toBe("PROTOCOL_ERROR")
  })

  test("cakupan kurang ditolak SEBELUM idempotensi dicek", () => {
    const { deps } = controlDeps()
    const idem = new IdempotencyStore()
    const r = dispatchControl(
      { consumerId: "c", scopes: ["read:session"], op: "daemon.shutdown", idem: "i1", args: {} },
      deps,
      idem,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal.code).toBe("SCOPE_DENIED")
    expect(idem.size).toBe(0)
  })

  test("idem sama + payload sama = hasil asli dikembalikan, eksekusi tak diulang", () => {
    let calls = 0
    const { deps } = controlDeps({
      actions: { ...noopActions, listSessions: () => (calls++, []) },
    })
    const idem = new IdempotencyStore()
    const req: ControlRequest = {
      consumerId: "c",
      scopes: ["read:session"],
      op: "session.list",
      idem: "k1",
      args: {},
    }
    const a = dispatchControl(req, deps, idem)
    const b = dispatchControl(req, deps, idem)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(calls).toBe(1)
    if (b.ok) expect(b.replayed).toBe(true)
  })

  test("idem sama + payload beda ditolak IDEMPOTENT_REPLAY", () => {
    const { deps } = controlDeps()
    const idem = new IdempotencyStore()
    const first = dispatchControl(
      {
        consumerId: "c",
        scopes: ["control:session"],
        op: "session.status",
        idem: "k",
        args: { sid: "s1" },
      },
      deps,
      idem,
    )
    expect(first.ok).toBe(true)
    const second = dispatchControl(
      {
        consumerId: "c",
        scopes: ["control:session"],
        op: "session.status",
        idem: "k",
        args: { sid: "s2" },
      },
      deps,
      idem,
    )
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.refusal.code).toBe("IDEMPOTENT_REPLAY")
  })

  test("kegagalan TIDAK di-cache — retry dengan idem sama boleh dicoba ulang", () => {
    let ok = false
    const { deps } = controlDeps({
      actions: {
        ...noopActions,
        interrupt: () => (ok ? { ok: true } : { ok: false, code: "LEASE_LOST", message: "x" }),
      },
    })
    const idem = new IdempotencyStore()
    const req: ControlRequest = {
      consumerId: "c",
      scopes: ["control:session"],
      op: "run.interrupt",
      idem: "k",
      args: { sid: "s1", runId: "r1" },
    }
    const a = dispatchControl(req, deps, idem)
    expect(a.ok).toBe(false)
    expect(idem.size).toBe(0)
    ok = true
    const b = dispatchControl(req, deps, idem)
    expect(b.ok).toBe(true)
  })

  test("sesi yang tidak di-host ditolak SESSION_MISMATCH", () => {
    const { deps } = controlDeps()
    const r = dispatchControl(
      {
        consumerId: "c",
        scopes: ["control:session"],
        op: "session.status",
        idem: "i",
        args: { sid: "bukan" },
      },
      deps,
      new IdempotencyStore(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal.code).toBe("SESSION_MISMATCH")
  })

  test("tekanan penyimpanan menahan operasi mutasi, bukan operasi baca", () => {
    const { deps } = controlDeps({ storageOk: () => false })
    const mut = dispatchControl(
      {
        consumerId: "c",
        scopes: ["control:session"],
        op: "run.interrupt",
        idem: "1",
        args: { sid: "s1", runId: "r" },
      },
      deps,
      new IdempotencyStore(),
    )
    expect(mut.ok).toBe(false)
    if (!mut.ok) expect(mut.refusal.code).toBe("STORAGE_PRESSURE")

    const read = dispatchControl(
      { consumerId: "c", scopes: ["read:session"], op: "session.list", idem: "2", args: {} },
      deps,
      new IdempotencyStore(),
    )
    expect(read.ok).toBe(true)
  })

  test("idempotensi store membatasi ukuran (tak tumbuh tanpa batas)", () => {
    const store = new IdempotencyStore({ max: 3 })
    for (let i = 0; i < 10; i++) {
      store.remember(`k${i}`, "fp", { ok: true, result: i, replayed: false })
    }
    expect(store.size).toBeLessThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// Persetujuan lewat broker (jalur ask)
// ---------------------------------------------------------------------------

describe("broker persetujuan", () => {
  test("konsumen yang menjawab melepas penunggu dengan allow", async () => {
    const broker = new ApprovalBroker({ incarnation: "inc", cwd: dir, propose: () => {} })
    const p = broker.request({ sid: "s1", tool: "bash", summary: "ls" })
    await Bun.sleep(10)
    const open = listApprovals("s1", dir)
    expect(open.length).toBe(1)
    const r = broker.decide(open[0]!.approvalId, "accept")
    expect(r.ok).toBe(true)
    expect(await p).toBe("allow")
  })

  test("tanpa jawaban sampai tenggat = deny, bukan izin", async () => {
    const broker = new ApprovalBroker({ incarnation: "inc", cwd: dir, propose: () => {} })
    const p = broker.request({ sid: "s1", tool: "bash", summary: "rm", ttlMs: 1_000 })
    expect(await p).toBe("deny")
    const rows = listApprovals("s1", dir)
    expect(rows[0]?.state).toBe("expired")
  })

  test("keputusan ganda dengan jawaban sama idempoten; jawaban beda ditolak", () => {
    const broker = new ApprovalBroker({ incarnation: "inc", cwd: dir, propose: () => {} })
    createApproval(
      {
        approvalId: "a1",
        sid: "s1",
        runId: null,
        tool: "bash",
        summary: "",
        requestedAt: 1,
        expiresAt: Date.now() + 60_000,
        incarnation: "inc",
      },
      dir,
    )
    const first = broker.decide("a1", "accept")
    expect(first.ok).toBe(true)
    const again = broker.decide("a1", "accept")
    expect(again.ok).toBe(true)
    const conflict = broker.decide("a1", "deny")
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.refusal.code).toBe("APPROVAL_INVALID_STATE")
  })

  test("setelah restart: keputusan ditolak APPROVAL_UNKNOWN, bukan dianggap sah", () => {
    const broker = new ApprovalBroker({ incarnation: "inc_baru", cwd: dir, propose: () => {} })
    createApproval(
      {
        approvalId: "a2",
        sid: "s1",
        runId: null,
        tool: "bash",
        summary: "",
        requestedAt: 1,
        expiresAt: Date.now() + 60_000,
        incarnation: "inc_lama",
      },
      dir,
    )
    markPendingApprovalsUnknown("inc_baru", dir)
    const r = broker.decide("a2", "accept")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal.code).toBe("APPROVAL_UNKNOWN")
  })

  test("shutdown menyelesaikan semua penunggu dengan deny", async () => {
    const broker = new ApprovalBroker({ incarnation: "inc", cwd: dir, propose: () => {} })
    const p = broker.request({ sid: "s1", tool: "bash", summary: "x" })
    await Bun.sleep(10)
    expect(broker.shutdownAll()).toBe(1)
    expect(await p).toBe("deny")
  })

  test("kegagalan menyimpan permintaan = deny (tak ada sukses yang dikarang)", async () => {
    // `.minicode` sengaja dibuat sebagai BERKAS, bukan direktori: mkdir akan
    // gagal sehingga satu-satunya jalur persetujuan (tulis baris) ikut gagal.
    const broken = mkdtempSync(join(tmpdir(), "mc-p212-broken-"))
    writeFileSync(join(broken, ".minicode"), "bukan-direktori", "utf8")
    const notes: string[] = []
    const broker = new ApprovalBroker({
      incarnation: "inc",
      cwd: broken,
      propose: () => {},
      warn: (m) => notes.push(m),
    })
    expect(await broker.request({ sid: "s1", tool: "bash", summary: "x" })).toBe("deny")
    expect(notes.join(" ")).toContain("approval record failed")
  })
})

// ---------------------------------------------------------------------------
// Anak, discovery, resource, telemetri, sanitasi
// ---------------------------------------------------------------------------

describe("pengawas anak", () => {
  test("anak yang hilang jadi lost, bukan finished", () => {
    const sup = new ChildSupervisor({ telemetry: new Telemetry() })
    sup.register({ childId: "k1", sid: "s1", pid: 1234, token: "rahasia" })
    expect(sup.running().length).toBe(1)
    expect(sup.shutdown()).toBe(1)
    expect(sup.get("k1")?.status).toBe("lost")
    expect(sup.get("k1")?.status).not.toBe("finished")
  })

  test("laporan tidak membocorkan token", () => {
    const sup = new ChildSupervisor({ telemetry: new Telemetry() })
    sup.register({ childId: "k1", sid: "s1", pid: 1, token: "rahasia" })
    expect(JSON.stringify(sup.report())).not.toContain("rahasia")
  })

  test("tak ada jalur adopsi anak generasi lain", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/daemon/children.ts", import.meta.url), "utf8"),
    )
    expect(src).not.toMatch(/\badopt\s*\(/)
  })

  test("pelaporan selesai hanya dari pelapor yang dikenal", () => {
    const sup = new ChildSupervisor({ telemetry: new Telemetry() })
    expect(sup.finish("tak-ada")).toBeNull()
    sup.register({ childId: "k1", sid: "s1", pid: 1, token: "t" })
    expect(sup.finish("k1")?.status).toBe("finished")
  })
})

describe("penemuan daemon", () => {
  test("tanpa berkas = none", () => {
    expect(discover(dir).status).toBe("none")
  })

  test("endpoint tanpa lease = stale, lease beda inkarnasi = foreign", () => {
    writeEndpoint(
      {
        version: 1,
        port: 1234,
        host: "127.0.0.1",
        incarnation: "inc_a",
        startedAt: 1,
        workspace: "",
        bootstrap: "x".repeat(40),
      },
      dir,
    )
    expect(discover(dir).status).toBe("stale")
    // Lease inkarnasi A masih basi? tidak — kita tulis segar, supaya status
    // "stale" di atas benar-benal karena TIDAK ADA lease, bukan karena basi.
    writeLease({ version: 1, incarnation: "inc_a", pid: 1, updatedAt: Date.now() }, dir)
    expect(discover(dir).status).toBe("suspect")
    writeEndpoint(
      {
        version: 1,
        port: 1234,
        host: "127.0.0.1",
        incarnation: "inc_b",
        startedAt: 1,
        workspace: "",
        bootstrap: "x".repeat(40),
      },
      dir,
    )
    expect(discover(dir).status).toBe("foreign")
  })

  test("lease basi = stale walau endpoint ada", () => {
    writeEndpoint(
      {
        version: 1,
        port: 9,
        host: "127.0.0.1",
        incarnation: "i",
        startedAt: 1,
        workspace: "",
        bootstrap: "x".repeat(40),
      },
      dir,
    )
    const stale = discover(dir, Date.now() + 60_000)
    expect(stale.status).toBe("stale")
    expect(stale.reason).toContain("lease")
  })

  test("endpoint rusak dianggap tidak ada, bukan crash", () => {
    writeFileSync(join(dir, ".minicode", "daemon-endpoint.json"), "{rusak", "utf8")
    expect(readEndpoint(dir)).toBeNull()
  })

  test("clearDiscovery tak menghapus berkas milik inkarnasi lain", () => {
    writeEndpoint(
      {
        version: 1,
        port: 9,
        host: "127.0.0.1",
        incarnation: "inc_baru",
        startedAt: 1,
        workspace: "",
        bootstrap: "x".repeat(40),
      },
      dir,
    )
    expect(clearDiscovery("inc_lama", dir)).toBe(false)
    expect(readEndpoint(dir)).not.toBeNull()
    expect(clearDiscovery("inc_baru", dir)).toBe(true)
    expect(readEndpoint(dir)).toBeNull()
  })
})

describe("resource & telemetri", () => {
  test("cek penyimpanan mengembalikan angka yang masuk akal", () => {
    const r = checkStorage(dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.freeBytes).toBeGreaterThan(0)
  })

  test("monitor edge-trigger: callback hanya saat status berubah", () => {
    const seen: string[] = []
    const m = new ResourceMonitor({ cwd: dir, minFreeBytes: 1, onPressure: (s) => seen.push(s) })
    m.probe()
    m.probe()
    m.probe()
    expect(seen).toEqual([])
    expect(m.stats.checks).toBe(3)
  })

  test("counter tak dikenal ditolak keras", () => {
    const t = new Telemetry()
    expect(() => t.inc("bukan.counter" as never)).toThrow("tak dikenal")
    t.inc("connections.opened")
    expect(t.get("connections.opened")).toBe(1)
    expect(t.snapshot().uptimeMs).toBeGreaterThanOrEqual(0)
  })
})

describe("sanitasi masuk", () => {
  test("buang sekuens ANSI dan kendali", () => {
    const ESC = String.fromCharCode(27)
    expect(sanitizeIncoming(`${ESC}[31mmerah${ESC}[0m`)).toBe("merah")
    expect(sanitizeIncoming("baris\u0007bell")).toBe("barisbell")
    expect(sanitizeIncoming("tab\tdan\nnewline")).toBe("tab\tdan\nnewline")
  })

  test("label dipangkas panjangnya", () => {
    expect(sanitizeLabel("y".repeat(500)).length).toBe(120)
    expect(sanitizeLabel(null)).toBe("")
  })
})

// ---------------------------------------------------------------------------
// End-to-end: host + IPC
// ---------------------------------------------------------------------------

describe("host daemon end-to-end", () => {
  test("probe hanya menyatakan hidup bila koneksi benar-benar berhasil", async () => {
    const h = await startHost()
    const alive = await probeDaemon(dir)
    expect(alive.alive).toBe(true)
    expect(alive.discovery.status).toBe("suspect")
    await h.shutdown("test")
    // Endpoint sudah dibersihkan -> probe tak punya kandidat lagi.
    const dead = await probeDaemon(dir)
    expect(dead.alive).toBe(false)
  })

  test("handshake: frontiers -> snapshot -> cursor -> replay -> penanda tail", async () => {
    await appendPresentationEvents("s1", dir, [toolStarted(1)])
    await appendPresentationEvents("s1", dir, [toolCompleted(2)])
    await startHost()

    const ep = readEndpoint(dir)!
    const cap = issueCapabilityFromEndpoint(ep, {
      scopes: ["subscribe", "read:session", "control:session", "approve", "admin"],
      who: "tester",
    })
    const client = await DaemonClient.connect({
      target: { host: ep.host, port: ep.port },
      capability: cap,
      consumer: "tester",
    })
    const seen: ServerMessage[] = []
    client.on((e) => {
      if (e.kind === "message") seen.push(e.msg)
    })
    client.subscribe("s1", 0)
    await Bun.sleep(200)

    const types = seen.map((m) => m.t)
    expect(types.slice(0, 5)).toEqual(["frontiers", "snapshot", "subscribed", "event", "event"])
    expect(types.indexOf("replay_done")).toBeGreaterThan(types.lastIndexOf("event"))
    expect(types[types.length - 1]).toBe("tail_marker")

    const subs = seen.find((m) => m.t === "subscribed")
    if (subs?.t === "subscribed") {
      expect(subs.fromSeq).toBe(0)
      expect(subs.cursor).toBe(-1)
      expect(subs.snapshotRejected).toBe(0)
    }
    const evs = seen.filter((m) => m.t === "event")
    expect(evs.length).toBe(2)
    for (const e of evs) {
      if (e.t === "event") expect(e.provenance).toBe("REPLAY")
    }
    const snap = seen.find((m) => m.t === "snapshot")
    if (snap?.t === "snapshot") expect(snap.snapshot.provenance).toBe("REPLAY")
    client.close()
  })

  test("ack persist offset dan reconnect lanjut dari sana", async () => {
    await appendPresentationEvents("s1", dir, [toolStarted(1)])
    await appendPresentationEvents("s1", dir, [toolCompleted(2)])
    await startHost()
    const ep = readEndpoint(dir)!
    const cap = issueCapabilityFromEndpoint(ep, { scopes: ["subscribe"], who: "c1" })

    const c1 = await DaemonClient.connect({
      target: { host: ep.host, port: ep.port },
      capability: cap,
      consumer: "c1",
    })
    const first: number[] = []
    c1.on((e) => {
      if (e.kind === "message" && e.msg.t === "event") first.push(e.msg.seq)
    })
    c1.subscribe("s1", 0)
    await Bun.sleep(150)
    expect(first).toEqual([1, 2])
    c1.ack("s1", 2)
    await Bun.sleep(80)
    expect(readConsumerOffset("c1", "s1", dir)).toBe(2)
    c1.close()

    const c2 = await DaemonClient.connect({
      target: { host: ep.host, port: ep.port },
      capability: cap,
      consumer: "c1",
    })
    const second: number[] = []
    c2.on((e) => {
      if (e.kind === "message" && e.msg.t === "event") second.push(e.msg.seq)
    })
    c2.subscribe("s1", "resume")
    await Bun.sleep(150)
    expect(second).toEqual([])
    c2.close()
  })

  test("capability salah / inkarnasi basi ditolak saat hello", async () => {
    const h = await startHost()
    const ep = readEndpoint(dir)!
    const bogus = issueCapabilityFromEndpoint(
      { ...ep, incarnation: "inc_lain" },
      { scopes: ["admin"], who: "x" },
    )
    await expect(
      DaemonClient.connect({
        target: { host: ep.host, port: ep.port },
        capability: bogus,
        consumer: "x",
      }),
    ).rejects.toThrow("STALE_INCARNATION")
    expect(h.telemetry.get("connections.rejected")).toBeGreaterThanOrEqual(1)
  })

  test("tanpa cakupan subscribe, langganan ditolak", async () => {
    await appendPresentationEvents("s1", dir, [toolStarted(1)])
    await startHost()
    const ep = readEndpoint(dir)!
    const cap = issueCapabilityFromEndpoint(ep, { scopes: ["read:session"], who: "ro" })
    const client = await DaemonClient.connect({
      target: { host: ep.host, port: ep.port },
      capability: cap,
      consumer: "ro",
    })
    const errs: string[] = []
    client.on((e) => {
      if (e.kind === "message" && e.msg.t === "error") errs.push(e.msg.code)
    })
    client.subscribe("s1", 0)
    await Bun.sleep(120)
    expect(errs).toContain("SCOPE_DENIED")
    client.close()
  })

  test("sesi tak dikenal ditolak NOT_FOUND, bukan berpura-pura kosong", async () => {
    await startHost()
    const ep = readEndpoint(dir)!
    const cap = issueCapabilityFromEndpoint(ep, { scopes: ["subscribe"], who: "c" })
    const client = await DaemonClient.connect({
      target: { host: ep.host, port: ep.port },
      capability: cap,
      consumer: "c",
    })
    const errs: string[] = []
    client.on((e) => {
      if (e.kind === "message" && e.msg.t === "error") errs.push(e.msg.code)
    })
    client.subscribe("tidak-ada", 0)
    await Bun.sleep(120)
    expect(errs).toContain("NOT_FOUND")
    client.close()
  })

  test("shutdown berurutan dan endpoint dibersihkan", async () => {
    const h = await startHost()
    expect(existsSync(join(dir, ".minicode", "daemon-endpoint.json"))).toBe(true)
    const steps = await h.shutdown("test")
    expect(steps).toEqual([
      "mark-closing",
      "halt-consumers",
      "settle-approvals",
      "stop-monitors",
      "close-connections",
      "retire-children",
      "clear-discovery",
    ])
    expect(readEndpoint(dir)).toBeNull()
    // Idempoten: panggil kedua kali tak menambah langkah.
    expect(await h.shutdown("test")).toEqual(steps)
    const probe = await probeDaemon(dir)
    expect(probe.alive).toBe(false)
  })

  test("consumer mendapat halte saat daemon berhenti", async () => {
    const h = await startHost()
    const ep = readEndpoint(dir)!
    const cap = issueCapabilityFromEndpoint(ep, { scopes: ["subscribe", "admin"], who: "c" })
    const client = await DaemonClient.connect({
      target: { host: ep.host, port: ep.port },
      capability: cap,
      consumer: "c",
    })
    const reasons: string[] = []
    client.on((e) => {
      if (e.kind === "message" && e.msg.t === "halt") reasons.push(e.msg.reason)
    })
    await h.shutdown("test")
    await Bun.sleep(150)
    expect(reasons).toContain("SHUTTING_DOWN")
  })

  test("persetujuan dibroadcast ke konsumen ber-cakupan approve", async () => {
    await startHost()
    const ep = readEndpoint(dir)!
    const withApprove = issueCapabilityFromEndpoint(ep, { scopes: ["approve"], who: "appr" })
    const without = issueCapabilityFromEndpoint(ep, { scopes: ["subscribe"], who: "sub" })

    const a = await DaemonClient.connect({
      target: { host: ep.host, port: ep.port },
      capability: withApprove,
      consumer: "appr",
    })
    const b = await DaemonClient.connect({
      target: { host: ep.host, port: ep.port },
      capability: without,
      consumer: "sub",
    })
    const gotA: string[] = []
    const gotB: string[] = []
    a.on((e) => {
      if (e.kind === "message" && e.msg.t === "approval") gotA.push(e.msg.approval.tool)
    })
    b.on((e) => {
      if (e.kind === "message" && e.msg.t === "approval") gotB.push(e.msg.approval.tool)
    })

    const host = openHosts[openHosts.length - 1]!
    // Jalur NYATA: request() mencatat baris lalu mengusulkan ke konsumen —
    // bukan memanggil broadcast secara langsung (yang tak membuktikan apa pun).
    const pending = host.approvals.request({ sid: "s1", tool: "bash", summary: "ls" })
    await Bun.sleep(200)
    expect(gotA).toEqual(["bash"])
    expect(gotB).toEqual([])
    host.approvals.shutdownAll()
    expect(await pending).toBe("deny")
    a.close()
    b.close()
  })
})
