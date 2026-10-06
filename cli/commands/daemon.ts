// P2.12 — perintah `minicode daemon …`: composition root untuk host daemon.
//
// Semua penimbunan lintas-lapisan terjadi DI SINI (bukan di src/daemon):
// src/daemon tidak boleh mengimpor cli/, dan sebaliknya. `ControlActions`,
// `FeedRegistry`, dan capability diterbitkan dari sini.
//
// Keluaran mengikuti docs/TERMINAL_CONTRACT.md: perintah human = stdout polos
// (tanpa ANSI/cursor control), diagnostik = stderr. Setiap jalur mengumpulkan
// output ke array lalu menulis SEKALI — bukan satu tulis per baris —
// agar jumlah writer tetap kecil dan terinventaris.

import { issueCapabilityFromEndpoint } from "../../src/daemon/capability.ts"
import { DaemonClient, probeDaemon } from "../../src/daemon/client.ts"
import type { ControlActions, HostedSessionInfo } from "../../src/daemon/control.ts"
import { type DaemonEndpoint, readEndpoint } from "../../src/daemon/discovery.ts"
import type { SessionFeed } from "../../src/daemon/feed.ts"
import { createStoreFeed } from "../../src/daemon/feed.ts"
import type { DaemonHost } from "../../src/daemon/host.ts"
import { DAEMON_SCOPES, type DaemonScope } from "../../src/daemon/protocol.ts"
import { sanitizeLabel } from "../../src/daemon/sanitize.ts"
import { flagNameOf, valueFlags } from "../args.ts"
import type { CliSession } from "../setup.ts"

export async function handleDaemon(
  args: string[],
  getArg: (name: string) => string | undefined,
  HELP: string,
): Promise<void> {
  const sub = args[0] === "daemon" ? args.slice(1) : args
  const first = firstPositional(sub)
  // Bantuan cetak `<mulai|...>` (bahasa Indonesia) tapi perintahnya `start`;
  // terima keduanya supaya yang menyalin dari --help tidak kena "unknown".
  const action = first === "mulai" ? "start" : (first ?? "status")
  // argv handler subcommand SELALU diawali positional subcommand, sehingga
  // `hasFlag` berhenti di token pertama (boundary prompt). Konvensi repo:
  // handler memakai `args.includes` langsung — lihat catatan di cli/args.ts.
  const json = sub.includes("--json")
  const cwdRaw = getArg("--cwd")
  const cwd = cwdRaw ? cwdRaw : undefined

  if (action === "help" || sub.includes("--help") || sub.includes("-h")) {
    process.stdout.write(DAEMON_HELP + "\n")
    // Nilai dispatch DIABAIKAN cli/index.ts (lihat catatannya: handler subcommand
    // keluar sendiri). Tanpa exit, proses jatuh ke jalur prompt biasa dan
    // "minicode daemon help" justru mencoba menjalankan sesi.
    process.exit(0)
  }

  if (action === "start") {
    await startDaemon(sub, getArg, cwd, json)
    return
  }

  if (action === "status") {
    await statusDaemon(cwd, json)
    return
  }

  if (action === "stop") {
    await stopDaemon(cwd, json)
    return
  }

  if (action === "issue") {
    await issueCapability(cwd, getArg, json)
    return
  }

  if (action === "sessions") {
    await listSessions(cwd, json)
    return
  }

  process.stderr.write(`unknown daemon subcommand: ${sanitizeLabel(action, 40)}\n${DAEMON_HELP}\n`)
  void HELP
  process.exit(2)
}

const DAEMON_HELP = `minicode daemon <mulai|status|stop|issue|sessions|help>

  start   [--port N] [--cwd D] [--prompt P] [--session S] [--json]
          Jalankan host daemon (blocking). Tanpa --prompt hanya melayani
          konsumen; dengan --prompt sesi di-host di dalam proses daemon.
  status  [--cwd D] [--json]
          Baca endpoint + PROBE koneksi. "alive" hanya bila probe berhasil.
  stop    [--cwd D] [--json]
          Minta daemon berhenti lewat kontrol (admin scope).
  issue   --scopes <a,b> --who <nama> [--ttl <ms>] [--cwd D] [--json]
          Terbitkan capability bercakupan dari berkas endpoint.
  sessions[--cwd D] [--json]
          Daftar sesi yang di-host daemon.`

/**
 * Token positional pertama yang benar-benar subcommand: lewati flag dan
 * NILAINYA (daftar `valueFlags` di cli/args.ts). Tanpa ini,
 * `daemon --cwd D:\x` akan membaca "D:\x" sebagai nama subcommand.
 */
function firstPositional(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token) continue
    if (token === "--") return argv[i + 1]
    const flag = flagNameOf(token)
    if (flag) {
      if (valueFlags.has(flag) && !token.includes("=")) i++
      continue
    }
    // flag tak dikenal: jangan dianggap subcommand (konsisten dengan hasFlag)
    if (token.startsWith("-")) continue
    return token
  }
  return undefined
}

/**
 * Tulis keluaran SEKALI, lalu (opsional) keluar.
 *
 * `exitCode = null` hanya untuk jalur yang TIDAK boleh berakhir di sini —
 * `start` masih harus melayani konsumen setelah baris "listening" tercetak.
 * Semua subcommand lain selalu keluar, karena `dispatch` di cli/index.ts
 * mengabaikan hasilnya (komentar di sana: handler memanggil process.exit).
 */
function emit(lines: string[], json: string | null, exitCode: number | null = null): void {
  // SATU tulisan per stream — lihat komentar kepala berkas.
  if (json !== null) process.stdout.write(json + "\n")
  else if (lines.length > 0) process.stdout.write(lines.join("\n") + "\n")
  if (exitCode !== null) process.exit(exitCode)
}

function fail(json: unknown, human: string, code = 1): never {
  process.stderr.write(human + "\n")
  if (json !== null) process.stdout.write(JSON.stringify(json) + "\n")
  process.exit(code)
}

async function openClient(
  cwd: string | undefined,
  scopes: DaemonScope[],
  who: string,
): Promise<{ client: DaemonClient; ep: DaemonEndpoint }> {
  const ep = readEndpoint(cwd)
  if (!ep) fail(null, "daemon: tidak ada endpoint — jalankan `minicode daemon start` dulu", 3)
  const cap = issueCapabilityFromEndpoint(ep, { scopes, who })
  const client = await DaemonClient.connect({
    target: { host: ep.host, port: ep.port },
    capability: cap,
    consumer: who,
  })
  return { client, ep }
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function startDaemon(
  _sub: string[],
  getArg: (name: string) => string | undefined,
  cwd: string | undefined,
  json: boolean,
): Promise<void> {
  const portRaw = getArg("--port")
  const port = portRaw !== undefined && /^\d+$/.test(portRaw) ? Number(portRaw) : 0
  const prompt = getArg("--prompt")
  const sessionFlag = getArg("--session") ?? ""

  const { DaemonHost } = await import("../../src/daemon/host.ts")
  const feeds = new Map<string, SessionFeed>()
  const hosted = new Map<string, HostedSessionInfo>()

  // Holder terpisah: aksi dipanggil BELUM tentu saat host sudah ada (bisa
  // lewat kontrol lebih dulu), dan `const` berikutnya akan menolak dibaca
  // sebelum inisialisasi. Dengan holder, "host belum siap" = penolakan jujur.
  let hostRef: DaemonHost | null = null

  // Aksi kontrol dibangun dari state yang benar-benar diketahui proses ini.
  // Tanpa sesi yang di-host, operasi yang butuh aksi MENOLAK — bukan berpura-
  // pura berhasil (lihat control.ts).
  const actions: ControlActions = {
    listSessions: () => [...hosted.values()],
    sessionStatus: (sid) => hosted.get(sid) ?? null,
    interrupt: (sid) => {
      void sid
      return { ok: false, code: "RUN_TERMINAL", message: "tidak ada jalur interupsi pada sesi ini" }
    },
    cancel: (sid) => {
      void sid
      return {
        ok: false,
        code: "RUN_TERMINAL",
        message: "tidak ada jalur pembatalan pada sesi ini",
      }
    },
    shutdown: (reason) => {
      const h = hostRef
      if (!h) return
      void h
        .shutdown(reason)
        .then(() => process.exit(0))
        .catch(() => process.exit(1))
    },
  }

  const host: DaemonHost = await DaemonHost.start({
    ...(cwd !== undefined ? { cwd } : {}),
    port,
    feeds: {
      get: (sid) => feeds.get(sid) ?? createStoreFeed(sid, cwd),
      known: () => [...feeds.keys()],
    },
    actions,
    ...(sessionFlag ? { workspace: sessionFlag } : {}),
  })
  hostRef = host

  let ctx: CliSession | null = null
  if (prompt !== undefined && prompt.trim().length > 0) {
    const { createCliSession } = await import("../setup.ts")
    ctx = await createCliSession({
      cwd,
      sessionId: sessionFlag,
      prompt,
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: true,
      plan: false,
      allowlist: false,
      verify: false,
    })
    const durable = createStoreFeed(ctx.sessionId, cwd)
    const session = ctx
    feeds.set(session.sessionId, {
      // Durable (kepala/frontier/replay) diambil dari toko, live dari sesi
      // hidup. Memakai kepala durable untuk replay sengaja: replay MEMBACA
      // toko, jadi angka yang dibaca konsumen harus memang milik toko.
      sid: session.sessionId,
      hosted: true,
      head: durable.head,
      frontiers: durable.frontiers,
      readRange: durable.readRange,
      liveSubscribe: (fn) => session.onPresentationEvent((e) => fn(e as never)),
    })
    hosted.set(session.sessionId, {
      sid: session.sessionId,
      hosted: true,
      writerEpoch: session.writerEpoch,
      runId: null,
      runStatus: null,
      presentationHead: durable.head(),
    })
  }

  const lines = [
    `daemon: listening on ${host.port} (incarnation ${host.incarnation})`,
    `endpoint: ${host.endpointPath ?? "?"}`,
    `capability: ${host.issueCapability({ scopes: [...DAEMON_SCOPES], who: "operator" })}`,
  ]
  const payload = {
    ok: true,
    port: host.port,
    incarnation: host.incarnation,
    endpoint: host.endpointPath,
    hostedSessions: [...hosted.keys()],
  }
  emit(lines, json ? JSON.stringify(payload) : null)

  const onSignal = () => {
    void host.shutdown("signal").then(() => process.exit(0))
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  // Biarkan proses hidup melayani konsumen; server listen menahan event loop.
  await new Promise<void>(() => {
    /* sengaja tak pernah selesai sampai signal/control shutdown */
  })
}

// ---------------------------------------------------------------------------
// status / stop / issue / sessions
// ---------------------------------------------------------------------------

async function statusDaemon(cwd: string | undefined, json: boolean): Promise<void> {
  const probe = await probeDaemon(cwd)
  const payload = {
    alive: probe.alive,
    reason: probe.reason,
    status: probe.discovery.status,
    incarnation: probe.discovery.endpoint?.incarnation ?? null,
    port: probe.discovery.endpoint?.port ?? null,
    leaseAgeMs: probe.discovery.lease ? Date.now() - probe.discovery.lease.updatedAt : null,
  }
  const lines = probe.alive
    ? [
        `daemon: alive on ${probe.target?.host}:${probe.target?.port}`,
        `incarnation: ${payload.incarnation ?? "?"}`,
        `lease age: ${payload.leaseAgeMs ?? "?"}ms`,
      ]
    : [`daemon: not alive (${probe.reason})`, `discovery: ${probe.discovery.status}`]
  emit(lines, json ? JSON.stringify(payload) : null, probe.alive ? 0 : 3)
}

async function stopDaemon(cwd: string | undefined, json: boolean): Promise<void> {
  const probe = await probeDaemon(cwd)
  if (!probe.alive)
    fail(
      json ? JSON.stringify({ ok: false, reason: probe.reason }) : null,
      `daemon: ${probe.reason}`,
      3,
    )
  try {
    const { client } = await openClient(cwd, ["admin"], "operator")
    const res = await client.control("daemon.shutdown", { reason: "cli" }, `stop-${Date.now()}`)
    client.close()
    emit(
      res.ok ? ["daemon: shutdown diminta"] : [`daemon: ditolak ${res.refusal?.code ?? ""}`],
      json ? JSON.stringify({ ok: res.ok, refusal: res.refusal ?? null }) : null,
      res.ok ? 0 : 1,
    )
  } catch (e) {
    fail(null, `daemon: gagal menghubungi — ${String((e as Error).message ?? e)}`, 1)
  }
}

async function issueCapability(
  cwd: string | undefined,
  getArg: (name: string) => string | undefined,
  json: boolean,
): Promise<void> {
  const who = getArg("--who") ?? "consumer"
  const raw = getArg("--scopes") ?? ""
  const ttlRaw = getArg("--ttl")
  const scopes = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is DaemonScope => (DAEMON_SCOPES as readonly string[]).includes(s))
  if (scopes.length === 0) {
    fail(
      null,
      `daemon issue: --scopes wajib berisi salah satu dari: ${DAEMON_SCOPES.join(", ")}`,
      2,
    )
  }
  const ep = readEndpoint(cwd)
  if (!ep) fail(null, "daemon issue: tidak ada endpoint", 3)
  const ttl = ttlRaw !== undefined && /^\d+$/.test(ttlRaw) ? Number(ttlRaw) : undefined
  const token = issueCapabilityFromEndpoint(ep, {
    scopes,
    who,
    ...(ttl !== undefined ? { ttlMs: ttl } : {}),
  })
  emit([token], json ? JSON.stringify({ ok: true, capability: token, scopes, who }) : null, 0)
}

async function listSessions(cwd: string | undefined, json: boolean): Promise<void> {
  try {
    const { client } = await openClient(cwd, ["read:session"], "operator")
    const res = await client.control("session.list", {}, `list-${Date.now()}`)
    client.close()
    if (!res.ok)
      fail(
        json ? JSON.stringify({ ok: false, refusal: res.refusal }) : null,
        `daemon: ${res.refusal?.code} ${res.refusal?.message}`,
        1,
      )
    const rows = Array.isArray(res.result) ? (res.result as HostedSessionInfo[]) : []
    const lines =
      rows.length === 0
        ? ["(tidak ada sesi yang di-host)"]
        : rows.map((r) => `${r.sid} head=${r.presentationHead} run=${r.runStatus ?? "-"}`)
    emit(lines, json ? JSON.stringify({ ok: true, sessions: rows }) : null, 0)
  } catch (e) {
    fail(null, `daemon: gagal menghubungi — ${String((e as Error).message ?? e)}`, 1)
  }
}
