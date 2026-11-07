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
import { VerifyWorkModeConflictError } from "../../src/policy/work-mode.ts"
import { DURABILITY } from "../../src/presentation/events.ts"
import {
  type RuntimeProductionMode,
  resolveRuntimeMode,
} from "../../src/runtime/production-execution.ts"
import { listSessionRuns } from "../../src/session/persistence.ts"
import { displayWorkMode, flagNameOf, resolveWorkModeFlag, valueFlags } from "../args.ts"
import type { CliSession, CliSessionOptions } from "../setup.ts"

export async function handleDaemon(
  // P11.3 — router mengirim argv scoped TANPA token subcommand ("daemon"):
  // flag global yang dikenal (sebelum subcommand) + semua token sesudahnya.
  // Irisan lokal `args[0] === "daemon"` lama hanya benar bila daemon token
  // pertama; dengan flag global mendahului, token routing dibaca sebagai
  // nama aksi ("unknown daemon subcommand: daemon", exit 2 palsu). Handler
  // mempercayai argv yang sudah scoped — jangan iris lagi di sini.
  sub: string[],
  getArg: (name: string) => string | undefined,
  HELP: string,
): Promise<void> {
  const first = firstPositional(sub)
  // Bantuan cetak `<mulai|...>` (bahasa Indonesia) tapi perintahnya `start`;
  // terima keduanya supaya yang menyalin dari --help tidak kena "unknown".
  const action = first === "mulai" ? "start" : (first ?? "status")
  // `--json` dibaca via includes (tak tergantung posisi): argv scoped selalu
  // memuat flag global + token setelah subcommand. `getArg` (= subGetArg
  // router) membaca --cwd/--port/--prompt/--who/--scopes/--ttl di mana pun.
  const json = sub.includes("--json")
  const cwdRaw = getArg("--cwd")
  const cwd = cwdRaw ? cwdRaw : undefined

  if (action === "help" || sub.includes("--help") || sub.includes("-h")) {
    process.stdout.write(`${DAEMON_HELP}\n`)
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

  start   [--port N] [--cwd D] [--prompt P] [--session S] [--runtime <mode>] [--work-mode <mode>] [--json]
          Jalankan host daemon (blocking). Tanpa --prompt hanya melayani
          konsumen; dengan --prompt sesi di-host di dalam proses daemon.
          --runtime constructed|owned menyalakan runtime ter-supervisi pada
          sesi yang di-host (default: off = jalur legacy).
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
  if (json !== null) process.stdout.write(`${json}\n`)
  else if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`)
  if (exitCode !== null) process.exit(exitCode)
}

/**
 * Tulis diagnostik manusia ke stderr + payload JSON ke stdout, lalu keluar.
 *
 * `json` adalah payload MENTAH (objek) — encoding terjadi SEKALI di sini;
 * `null` = jalur ini memang tak punya kontrak JSON. Jalur kegagalan `stop` dan
 * `sessions` dulu mewariskan string yang SUDAH `JSON.stringify`, jadi payload
 * ter-encode dua kali: stdout berisi string-JSON terbungkus dan
 * `JSON.parse(stdout)` pada konsumen mesin menghasilkan string, bukan objek.
 * Jangan me-stringify di call site.
 */
function fail(json: unknown, human: string, code = 1): never {
  process.stderr.write(`${human}\n`)
  if (json !== null) process.stdout.write(`${JSON.stringify(json)}\n`)
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

/**
 * P13.3 Stage C — kebijakan scheduler daemon.
 *
 * Hanya jalur eksplisit `--runtime owned` yang menyalakan scheduler. Default
 * legacy (`off`) dan `constructed` TIDAK menyalakannya: keduanya bukan jalur
 * ownership runtime yang menyediakan admission, TaskStore, dan lease yang
 * dibutuhkan kerja durable. Mengecualikan satu pun dari itu berarti scheduler
 * berjalan tanpa bukti yang menjadi syarat kontinuitasnya.
 */
export function schedulerEnabledForDaemon(mode: RuntimeProductionMode): boolean {
  return mode === "owned"
}

export async function startDaemonHostedRuntime(opts: {
  readonly sub: readonly string[]
  readonly getArg: (name: string) => string | undefined
  readonly cwd: string | undefined
  /**
   * [P13.6] Seam uji deterministik: injeksi append presentasi untuk tes
   * forensik live-vs-durable. Produksi TIDAK mengeset ini (default jalur
   * append sesungguhnya).
   */
  readonly presentationAppend?: CliSessionOptions["presentationAppend"]
  /**
   * P2.3: jalankan `--prompt` yang di-host. Default false agar tes komposisi
   * yang tidak ingin turn tetap deterministik; `startDaemon` (produksi)
   * menyalakannya.
   */
  readonly autoRunPrompt?: boolean
}): Promise<DaemonHostedRuntime> {
  const { sub, getArg, cwd } = opts
  const portRaw = getArg("--port")
  const port = portRaw !== undefined && /^\d+$/.test(portRaw) ? Number(portRaw) : 0
  const prompt = getArg("--prompt")
  const sessionFlag = getArg("--session") ?? ""
  // [P13.2] Mode runtime memakai FLAG GLOBAL YANG SAMA dengan CLI, default
  // "off" → jalur legacy utuh (tak ada runtime yang dibangun, tak ada jurnal
  // runtime, tak ada perubahan pada cara turn dieksekusi). Daemon yang mau
  // menjalankan runtime ter-supervisi memintanya eksplisit.
  const runtimeMode = resolveRuntimeMode(sub).mode
  // [P13.3 Stage C] Scheduler mengikuti mode runtime, bukan flag terpisah:
  // daemon `owned` memang ingin kerja durable berlanjut; mode lain tetap inert.
  const schedulerEnabled = schedulerEnabledForDaemon(runtimeMode)
  // Daemon mengikuti default DISCUSS serta fallback DISCUSS untuk nilai invalid.
  const workModeResolved = resolveWorkModeFlag(getArg)

  const { DaemonHost } = await import("../../src/daemon/host.ts")
  const feeds = new Map<string, SessionFeed>()
  const hosted = new Map<string, HostedSessionInfo>()

  // Holder terpisah: aksi dipanggil BELUM tentu saat host sudah ada (bisa
  // lewat kontrol lebih dulu), dan `const` berikutnya akan menolak dibaca
  // sebelum inisialisasi. Dengan holder, "host belum siap" = penolakan jujur.
  let hostRef: DaemonHost | null = null

  // [P13.2] Holder sesi: host dibuat lebih dulu, sesi menyusul. Penutupan sesi
  // harus idempoten (shutdown bisa dipanggil berkali-kali) dan harus MENUNGGU
  // lifecycle sesi selesai — termasuk pembersihan anak proses yang disupervisi.
  let sessionRef: CliSession | null = null
  let sessionClosed = false
  // P2.3: satu controller untuk run yang sedang berjalan. Interrupt/cancel
  // meng-abort run ini (bukan hanya mengembalikan status palsu).
  let activeRunCtl: AbortController | null = null
  const closeHostedSession = async (): Promise<void> => {
    if (sessionClosed) return
    sessionClosed = true
    try {
      activeRunCtl?.abort(new Error("daemon shutdown"))
    } catch {}
    activeRunCtl = null
    const s = sessionRef
    sessionRef = null
    if (!s) return
    await s.close()
  }

  // P2.3: abort run yang benar-benar berjalan. runId dari state kanonik; call
  // dengan runId lain ditolak agar sinyal tidak salah arah ke sesi/run lain.
  const abortHostedRun = (
    sid: string,
    runId: string | null,
    reason: string,
  ): { ok: true } | { ok: false; code: "RUN_TERMINAL" | "SESSION_MISMATCH"; message: string } => {
    const s = sessionRef
    if (!s || s.sessionId !== sid)
      return { ok: false, code: "SESSION_MISMATCH", message: "sesi bukan milik daemon ini" }
    const state = s.runState()
    if (!state.runId || state.status !== "RUNNING")
      return { ok: false, code: "RUN_TERMINAL", message: "tidak ada run aktif untuk dihentikan" }
    if (runId !== null && runId !== state.runId)
      return { ok: false, code: "RUN_TERMINAL", message: `run ${runId} bukan run aktif` }
    if (!activeRunCtl || activeRunCtl.signal.aborted)
      return { ok: false, code: "RUN_TERMINAL", message: "run tidak dapat diinterupsi" }
    activeRunCtl.abort(new Error(reason))
    return { ok: true }
  }

  // Aksi kontrol dibangun dari state yang benar-benar diketahui proses ini.
  // Tanpa sesi yang di-host, operasi yang butuh aksi MENOLAK — bukan berpura-
  // pura berhasil (lihat control.ts).
  const actions: ControlActions = {
    listSessions: () => [...hosted.values()],
    sessionStatus: (sid) => hosted.get(sid) ?? null,
    interrupt: (sid, runId) => abortHostedRun(sid, runId, "interrupted by daemon operator"),
    cancel: (sid, runId) => abortHostedRun(sid, runId, "cancelled by daemon operator"),
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
    // [P13.2] Sesi yang di-host ditutup saat daemon berhenti: lifecycle-nya
    // (jurnal runtime + anak proses yang disupervisi) SELESAI sebelum daemon
    // menutup dirinya. Tanpa ini, proses anak bisa tertinggal (yatim).
    closeHostedSession: async () => {
      await closeHostedSession()
    },
    ...(sessionFlag ? { workspace: sessionFlag } : {}),
  })
  hostRef = host

  let ctx: CliSession | null = null
  if (prompt !== undefined && prompt.trim().length > 0) {
    const { createCliSession } = await import("../setup.ts")
    try {
      ctx = await createCliSession({
        cwd,
        sessionId: sessionFlag,
        prompt,
        enterRepl: false,
        verbose: false,
        allowAll: false,
        ask: true,
        // [P13.6] Ask-mode pada sesi hosted: prompt TTY selalu deny di proses
        // daemon non-TTY. Satu-satunya jembatan sah adalah broker persetujuan
        // durable (approvals.ts): baris tersimpan, konsumen scope `approve`
        // mengusulkan lewat `approval.decide`, restart ⇒ UNKNOWN, shutdown ⇒
        // DENY. Tanpa pemasangan ini, seluruh op approval tidak tersambung ke
        // sesi mana pun (fail-closed, bukan crash).
        permissionAsk: host.approvals.asPermissionAsk({
          sid: () => sessionRef?.sessionId ?? "",
          runId: () => null,
        }),
        plan: false,
        allowlist: false,
        verify: sub.includes("--verify"),
        workMode: workModeResolved.workMode,
        workModeExplicit: workModeResolved.explicit,
        // [P13.2] Mode runtime yang sama dengan CLI → komposisi yang di-host
        // punya jalur ownership proses + status kanonik yang sama.
        runtimeMode,
        // [P13.3 Stage C] Hanya `owned` yang menyalakan scheduler; `off` dan
        // `constructed` mengirim false sehingga gate tetap inert.
        schedulerEnabled,
        // [P13.6] Seam uji forensik (produksi tak mengeset).
        ...(opts.presentationAppend ? { presentationAppend: opts.presentationAppend } : {}),
      })
    } catch (e) {
      // [P13.2] Sesi gagal dibangun → daemon TIDAK boleh meninggalkan socket
      // listening di belakang: host hidup tanpa sesi = daemon zombie yang tak
      // bisa dilayani dan tak berguna. Host ditutup lebih dulu, lalu kegagalan
      // ASLI diteruskan (bukan ditelan).
      try {
        await host.shutdown("session-setup-failed")
      } catch {
        // Kegagalan shutdown host tak menutupi kegagalan sesi yang sebenarnya.
      }
      throw e
    }
    sessionRef = ctx
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
      // [P13.5] Feed live memakai DomainEvent mentah, BUKAN proyeksi UI.
      // Proyeksi memakai `seq`, sedangkan kontrak feed/replay memakai
      // `eventSeq`; cast lama membuat seluruh event live diabaikan fanout.
      // Hanya event durable yang diteruskan supaya bahasa live = bahasa replay
      // (delta non-durable tetap milik UI, bukan riwayat sesi).
      liveSubscribe: (fn) =>
        session.onDomainEvent((event) => {
          if (!DURABILITY[event.type]?.durable) return
          fn(event)
        }),
    })
    hosted.set(session.sessionId, {
      sid: session.sessionId,
      hosted: true,
      writerEpoch: session.writerEpoch,
      // P2.3: status dibaca LIVE dari run kanonik sesi, bukan snapshot null.
      get runId() {
        return session.runState().runId
      },
      get runStatus() {
        return session.runState().status
      },
      presentationHead: durable.head(),
      get workMode() {
        return displayWorkMode(session.workMode)
      },
      // P2.3: recovery run terakhir yang durable — setelah restart run mati
      // tampil INTERRUPTED + recovery UNKNOWN, tidak pernah disamarkan LIVE.
      get recoveryStatus() {
        try {
          const runs = listSessionRuns(session.sessionId, cwd)
          const last = runs[runs.length - 1]
          return last?.recovery_status ?? null
        } catch {
          return null
        }
      },
    })

    if (opts.autoRunPrompt === true && prompt !== undefined && prompt.trim().length > 0) {
      const ctl = new AbortController()
      activeRunCtl = ctl
      void session
        .runPromptWithVerify(prompt, ctl.signal)
        .catch((e) => {
          if (!ctl.signal.aborted) {
            process.stderr.write(`[daemon] hosted run failed: ${(e as Error).message}\n`)
          }
        })
        .finally(() => {
          if (activeRunCtl === ctl) activeRunCtl = null
        })
    }
  } else if (sub.includes("--verify") && workModeResolved.workMode !== "EXECUTE") {
    // P0.2 (Q4): fail-closed sekalipun daemon start dipanggil dengan --verify
    // tanpa --prompt pada mode non-EXECUTE.
    try {
      await host.shutdown("verify-work-mode-conflict")
    } catch {
      /* abaikan error shutdown */
    }
    throw new VerifyWorkModeConflictError(workModeResolved.workMode)
  }

  return {
    host,
    session: ctx,
    closeHostedSession,
    workMode: displayWorkMode(ctx?.workMode ?? workModeResolved.workMode),
    ...(workModeResolved.warning ? { workModeWarning: workModeResolved.warning } : {}),
  }
}

/**
 * [P13.2] Hasil start daemon: host + sesi yang di-host.
 *
 * Dipisah dari `startDaemon` supaya lifecycle-nya bisa diuji tanpa menjalankan
 * perintah yang "tak pernah selesai" (loop serve). Fungsi ini TIDAK menulis ke
 * stdout/stderr — semua keluaran tetap milik `startDaemon` (writer inventory).
 */
export interface DaemonHostedRuntime {
  readonly host: DaemonHost
  /** Sesi yang di-host (null bila daemon dijalankan tanpa `--prompt`). */
  readonly session: CliSession | null
  /** Tutup sesi yang di-host (idempoten). Dipakai daemon saat shutdown. */
  readonly closeHostedSession: () => Promise<void>
  /** P0.2 (Q5): WorkMode efektif daemon / sesi yang di-host. */
  readonly workMode: "DISCUSS" | "PLAN" | "BUILD"
  /** P0.2 (Q5): Peringatan bila nilai `--work-mode` / env tidak valid. */
  readonly workModeWarning?: string
}

async function startDaemon(
  sub: string[],
  getArg: (name: string) => string | undefined,
  cwd: string | undefined,
  json: boolean,
): Promise<void> {
  let started: DaemonHostedRuntime
  try {
    started = await startDaemonHostedRuntime({ sub, getArg, cwd, autoRunPrompt: true })
  } catch (e) {
    if (e instanceof VerifyWorkModeConflictError) {
      fail(json ? { ok: false, code: "USER_ERROR", reason: e.message } : null, e.message, 2)
    }
    throw e
  }
  const { host, session, workMode, workModeWarning } = started

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
    hostedSessions: session ? [session.sessionId] : [],
    workMode,
    ...(workModeWarning ? { warning: workModeWarning } : {}),
  }
  emit(lines, json ? JSON.stringify(payload) : null)

  const onSignal = () => {
    void host
      .shutdown("signal")
      .then(() => process.exit(0))
      // Kegagalan shutdown (mis. sesi yang di-host tak bisa ditutup) TIDAK boleh
      // hilang: proses keluar dengan kode gagal, bukan "beres".
      .catch(() => process.exit(1))
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
    // Objek mentah, bukan string: `fail()` yang meng-encode (lihat kontraknya).
    fail(json ? { ok: false, reason: probe.reason } : null, `daemon: ${probe.reason}`, 3)
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
      // Objek mentah — `fail()` meng-encode sekali (D-1).
      fail(
        json ? { ok: false, refusal: res.refusal } : null,
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
