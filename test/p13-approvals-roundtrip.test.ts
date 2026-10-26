// P13.6 — Forensik persetujuan sesi hosted: round-trip penuh lewat daemon.
//
// Temuan yang diuji (P13.6 Stage A, lihat P13_5_REPORT.md §8 butir 4):
// `ApprovalBroker` + op kontrol `approval.*` + UNKNOWN-on-restart + DENY-on-
// shutdown semuanya ADA sejak P2.12, tetapi TIDAK ADA composition root yang
// memasangnya ke sesi yang di-host daemon — ask sesi hosted masih memakai
// prompt TTY, dan di proses daemon non-TTY itu selalu deny. Seluruh bidang
// persetujuan daemon jadi kode mati untuk satu-satunya sesi yang seharusnya
// dilayaninya. Perbaikannya wiring composition root (cli/commands/daemon.ts
// memasang `asPermissionAsk`), TANPA operasi/endpoint/field protokol baru.
//
// Yang dibuktikan file ini lewat komposisi produksi nyata:
//   1. Tool ask-gated pada sesi hosted menghasilkan USULAN persetujuan yang
//      benar-benar sampai ke konsumen ber-scope `approve` (baris durable
//      `requested` → `pending`), keputusan `accept` dari konsumen mengekusi
//      tool dan meninggalkan baris `accepted` — konsumen TIDAK pernah jadi
//      otoritas; baris SQLite-lah yang memutus.
//   2. Keputusan `deny` menolak eksekusi (file tidak dibuat) tanpa merusak
//      turn — turn tetap COMPLETED dengan tool denied.
//   3. Shutdown daemon dengan persetujuan masih menggantung = DENY + baris
//      `cancelled` (bukan izin), dan shutdown MENUNGGU turn yang sedang
//      meminta persetujuan itu selesai.
//
// Hermetik: workspace + HOME temp, provider HTTP lokal, port ephemeral.
// Restart ⇒ UNKNOWN sudah diuji di unit (test/p2-daemon.test.ts) — tidak
// diduplikasi di sini.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type DaemonHostedRuntime, startDaemonHostedRuntime } from "../cli/commands/daemon.ts"
import type { CliSession } from "../cli/setup.ts"
import { DaemonClient } from "../src/daemon/client.ts"
import type { DaemonScope, ServerMessage } from "../src/daemon/protocol.ts"
import { listApprovals } from "../src/daemon/store.ts"
import { installRuntimeStatusProvider } from "../src/runtime/runtime-status-provider.ts"
import { resetTaskStoreHandles } from "../src/task/store.ts"
import { type FakeReply, startFakeProvider } from "./helpers/fake-provider.ts"

const dirs: string[] = []
const fixtures: Fixture[] = []
const envBackup = new Map<string, string | undefined>()
let sessionSeq = 0

interface Fixture {
  readonly dir: string
  readonly provider: ReturnType<typeof startFakeProvider>
  readonly started: DaemonHostedRuntime
  readonly session: CliSession
}

const TOOL_REPLY: FakeReply = {
  kind: "tool",
  id: "call_p136",
  name: "write_file",
  args: { path: "approved.txt", content: "isi-p136" },
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p136-"))
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

/** Tipe event presentasi dari pesan `event` (payload DomainEvent). */
function eventType(msg: ServerMessage): string {
  if (msg.t !== "event") return ""
  return String((msg as { event?: { type?: string } }).event?.type ?? "")
}

async function startOwned(replies: FakeReply[]): Promise<Fixture> {
  const dir = tempDir()
  const home = join(dir, "home")
  const provider = startFakeProvider(replies)
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

  const sessionId = `p136-approvals-${++sessionSeq}`
  const argv = ["--runtime", "owned", "--prompt", "halo", "--session", sessionId]
  const started = await startDaemonHostedRuntime({ sub: argv, getArg: getArgFrom(argv), cwd: dir })
  const session = started.session
  if (!session) throw new Error("sesi yang di-host tidak terbentuk")
  const fixture: Fixture = { dir, provider, started, session }
  fixtures.push(fixture)
  return fixture
}

async function connectApprover(
  host: DaemonHostedRuntime["host"],
  who: string,
): Promise<DaemonClient> {
  const scopes: DaemonScope[] = ["subscribe", "read:session", "approve"]
  const capability = host.issueCapability({ scopes, who })
  const client = await DaemonClient.connect({
    target: { host: "127.0.0.1", port: host.port },
    capability,
    consumer: who,
  })
  return client
}

afterEach(async () => {
  for (const fx of fixtures.splice(0)) {
    try {
      await fx.started.host.shutdown("cleanup-p136")
    } catch {}
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

describe("P13.6 - persetujuan sesi hosted lewat broker daemon", () => {
  test("usulan sampai ke konsumen; accept mengekusi tool dan meninggalkan baris accepted", async () => {
    const fx = await startOwned([TOOL_REPLY, { kind: "text", text: "selesai" }])
    const { host } = fx.started
    const session = fx.session
    const client = await connectApprover(host, "p136-approver")
    const seen = record(client)
    client.subscribe(session.sessionId, 0)
    await waitFor(
      () => seen.some((m) => m.t === "tail_marker"),
      "konsumen tidak mencapai tail_marker",
    )

    // Turn nyata: provider meminta write_file (ask-gated) → broker.
    const turn = session.runPromptWithVerify("tulis approved.txt")
    const proposal = await waitFor(
      () =>
        seen.find(
          (m): m is Extract<ServerMessage, { t: "approval" }> =>
            m.t === "approval" && m.approval.state === "pending",
        ),
      "usulan persetujuan tidak sampai ke konsumen ber-scope approve",
    )
    expect(proposal.approval.sid).toBe(session.sessionId)
    expect(proposal.approval.tool).toBe("write_file")

    // Keputusan konsumen → baris durable yang memutus, bukan konsumen.
    const decided = await client.control(
      "approval.decide",
      {
        sid: session.sessionId,
        approvalId: proposal.approval.approvalId,
        decision: "accept",
      },
      "p136-accept-1",
    )
    expect(decided.ok).toBe(true)
    if (decided.ok) {
      expect(decided.result).toMatchObject({ state: "accepted" })
    }

    await turn
    expect(existsSync(join(fx.dir, "approved.txt"))).toBe(true)
    expect(readFileSync(join(fx.dir, "approved.txt"), "utf8")).toBe("isi-p136")

    // Bukti presentasi: tool + turn terekam sebagai event durable.
    await waitFor(
      () => seen.some((m) => eventType(m) === "turn.completed"),
      "turn selesai tetapi event turn.completed tidak diterima",
    )
    expect(seen.some((m) => eventType(m) === "tool.completed")).toBe(true)

    const listed = await client.control("approval.list", { sid: session.sessionId }, "p136-list-1")
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      const rows = listed.result as { approvalId: string; state: string }[]
      expect(
        rows.some((r) => r.approvalId === proposal.approval.approvalId && r.state === "accepted"),
      ).toBe(true)
    }

    expect(session.executionRunner.metrics().terminals.COMPLETED).toBe(1)
    client.close()
    await host.shutdown("p136-accept")
    expect(host.shutdownErrors).toEqual([])
  }, 30_000)

  test("keputusan deny menolak eksekusi tanpa merusak turn; baris denied tersimpan", async () => {
    const fx = await startOwned([
      { ...TOOL_REPLY, args: { path: "jangan.txt", content: "x" } },
      { kind: "text", text: "selesai" },
    ])
    const { host } = fx.started
    const session = fx.session
    const client = await connectApprover(host, "p136-denier")
    const seen = record(client)
    client.subscribe(session.sessionId, 0)
    await waitFor(
      () => seen.some((m) => m.t === "tail_marker"),
      "konsumen tidak mencapai tail_marker",
    )

    const turn = session.runPromptWithVerify("tulis jangan.txt")
    const proposal = await waitFor(
      () =>
        seen.find(
          (m): m is Extract<ServerMessage, { t: "approval" }> =>
            m.t === "approval" && m.approval.state === "pending",
        ),
      "usulan persetujuan tidak sampai ke konsumen",
    )
    const decided = await client.control(
      "approval.decide",
      {
        sid: session.sessionId,
        approvalId: proposal.approval.approvalId,
        decision: "deny",
      },
      "p136-deny-1",
    )
    expect(decided.ok).toBe(true)
    if (decided.ok) {
      expect(decided.result).toMatchObject({ state: "denied" })
    }

    await turn
    expect(existsSync(join(fx.dir, "jangan.txt"))).toBe(false)
    await waitFor(
      () => seen.some((m) => eventType(m) === "turn.completed"),
      "turn tidak selesai setelah penolakan",
    )
    expect(seen.some((m) => eventType(m) === "tool.denied")).toBe(true)

    const listed = await client.control("approval.list", { sid: session.sessionId }, "p136-list-2")
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      const rows = listed.result as { approvalId: string; state: string }[]
      expect(
        rows.some((r) => r.approvalId === proposal.approval.approvalId && r.state === "denied"),
      ).toBe(true)
    }

    // Turn tetap selesai (COMPLETED) — tool denied bukan crash sesi.
    expect(session.executionRunner.metrics().terminals.COMPLETED).toBe(1)
    client.close()
    await host.shutdown("p136-deny")
    expect(host.shutdownErrors).toEqual([])
  }, 30_000)

  test("shutdown saat persetujuan menggantung: DENY + baris cancelled, dan shutdown menunggu turn", async () => {
    const fx = await startOwned([
      { ...TOOL_REPLY, args: { path: "menggantung.txt", content: "x" } },
      { kind: "text", text: "selesai" },
    ])
    const { host } = fx.started
    const session = fx.session
    const client = await connectApprover(host, "p136-pending")
    const seen = record(client)
    client.subscribe(session.sessionId, 0)
    await waitFor(
      () => seen.some((m) => m.t === "tail_marker"),
      "konsumen tidak mencapai tail_marker",
    )

    const turn = session.runPromptWithVerify("tulis menggantung.txt")
    const proposal = await waitFor(
      () =>
        seen.find(
          (m): m is Extract<ServerMessage, { t: "approval" }> =>
            m.t === "approval" && m.approval.state === "pending",
        ),
      "usulan persetujuan tidak sampai ke konsumen",
    )
    // JANGAN putuskan: biarkan persetujuan menggantung, lalu shutdown.
    // settle-approvals = DENY (bukan izin), dan close-hosted-session harus
    // MENUNGGU turn yang ask-nya baru selesai ditolak.
    await host.shutdown("p136-pending")
    await turn

    expect(existsSync(join(fx.dir, "menggantung.txt"))).toBe(false)
    expect(host.shutdownSteps).toContain("settle-approvals")
    expect(host.shutdownSteps).toContain("close-hosted-session")
    expect(host.shutdownErrors).toEqual([])

    // Baris durable pasca-shutdown: cancelled dengan keputusan daemon,
    // bukan dibiarkan pending (menunggu ttl) dan bukan accepted.
    const rows = listApprovals(session.sessionId, fx.dir)
    const row = rows.find((r) => r.approvalId === proposal.approval.approvalId)
    expect(row?.state).toBe("cancelled")
  }, 30_000)
})
