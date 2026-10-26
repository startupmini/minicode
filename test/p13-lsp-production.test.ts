// P13.2 — Jalur produksi LSP: konfigurasi → spawn → registrasi → restart → cleanup.
//
// Milik P13.2 (penutup). Suite P13.1 (kontrak) dan P13.2 (supervisi proses)
// terpisah dan tak disentuh.
//
// Yang dibuktikan file ini adalah jalur PRODUKSI, bukan替 substitute:
//   - config `lspServers` (config global yang dipercaya) → `setupToolLayer` →
//     `configureServers()` → session LSP → spawn nyata → registrasi ke
//     SUPERVISI runtime yang sama.
//   - keluar tak terduga → bounded restart → sesi LSP diinisialisasi ULANG dan
//     dokumen yang terbuka dibuka ulang (tanpa duplikat, tanpa isi basi).
//   - shutdown rapi → anak dihentikan + DITUNGGU → tak ada proses milik kita
//     yang tersisa hidup (bukti level OS).
//   - konfigurasi LSP kosong → startup tetap benar, dan TIDAK ada klaim
//     "proses anak sedang hidup".
//
// Hermetic: workspace + HOME temp per test, provider tiruan (tak ada turn
// model yang dijalankan), server LSP tiruan = skrip lokal nyata (bun -e).

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliSession } from "../cli/setup.ts"
import { clearLspServers, lspDiagnostics } from "../src/lsp/client.ts"
import {
  createProductionRuntime,
  observeProductionRuntime,
  RUNTIME_GATE_ENABLED,
} from "../src/runtime/production-runtime.ts"
import { deriveRuntimeView } from "../src/runtime/runtime-status.ts"
import { currentRuntimeView } from "../src/runtime/runtime-status-provider.ts"

const dirs: string[] = []
const envBackup = new Map<string, string | undefined>()

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-lsp-"))
  dirs.push(dir)
  return dir
}

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

afterEach(() => {
  restoreHome()
  clearLspServers()
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

/**
 * Server LSP tiruan yang JUJUR: ia bicara framing LSP sungguhan, menjawab
 * handshake `initialize`, mencatat setiap `didOpen` yang diterimanya, lalu
 * keluar sendiri (kode 7) untuk memicu jalur "keluar tak terduga".
 */
function fakeLspServer(logPath: string, exitAfterMs: number): string {
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
    if (msg.method === "textDocument/didOpen") {
      const td = (msg.params && msg.params.textDocument) || {}
      fs.appendFileSync(${JSON.stringify(logPath)}, "didOpen v=" + td.version + " len=" + String(td.text || "").length + "\\n")
    }
    if (msg.method === "shutdown") send({ jsonrpc: "2.0", id: msg.id, result: null })
    if (msg.method === "exit") { fs.appendFileSync(${JSON.stringify(logPath)}, "stopped\\n"); process.exit(0) }
  }
})
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(logPath)}, "died\\n")
  process.exit(7)
}, ${exitAfterMs})
`
}

/** Workspace + config global (provider tiruan + server LSP tiruan). */
function workspaceWithLsp(
  makeLsp?: (log: string) => {
    command: string
    args: string[]
    env?: Record<string, string>
  },
): {
  dir: string
  log: string
} {
  const dir = tempDir()
  const log = join(dir, "lsp.log")
  const home = join(dir, "home")
  mkdirSync(join(home, ".minicode"), { recursive: true })
  const config: Record<string, unknown> = {
    providers: [
      { id: "fake", baseUrl: "http://localhost:9", apiKey: "sk-test", models: ["gpt-4o-mini"] },
    ],
  }
  const lsp = makeLsp?.(log)
  if (lsp) {
    config.lspServers = [
      { ext: ".ts", command: lsp.command, args: lsp.args, ...(lsp.env ? { env: lsp.env } : {}) },
    ]
  }
  writeFileSync(join(home, ".minicode", "config.json"), JSON.stringify(config), "utf8")
  return { dir, log }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(25)
  }
  return predicate()
}

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

function pidFromLog(log: string): number | null {
  if (!existsSync(log)) return null
  const m = /pid=(\d+)/.exec(readFileSync(log, "utf8"))
  return m ? Number(m[1]) : null
}

function countLines(log: string, needle: string): number {
  if (!existsSync(log)) return 0
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.includes(needle)).length
}

// ── 1 & 2. Spawn nyata lewat jalur produksi + registrasi ke supervisi ───────

describe("P13.2 — server LSP terkonfigurasi: spawn + registrasi (jalur produksi)", () => {
  test("server LSP terkonfigurasi benar-benar di-spawn dan terdaftar di supervisi runtime", async () => {
    const { dir, log } = workspaceWithLsp((logPath) => ({
      command: process.execPath,
      args: ["-e", fakeLspServer(logPath, 60_000)],
      env: { LSP_TEST_LOG: logPath },
    }))
    isolateHome(dir)

    // Jalur produksi: sesi nyata → tool layer → configureServers → runtime.
    const session = await createCliSession({
      cwd: dir,
      allowLocalConfig: true,
      sessionId: "lsp-prod-1",
      prompt: "halo",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
      runtimeMode: "constructed",
    })
    try {
      const supervision = session.productionRuntime.runtime()!.supervision
      expect(supervision).not.toBeNull()
      // Belum ada anak: server LSP baru spawn saat tool LSP dipakai.
      expect(supervision!.status().managed).toBe(0)

      // Pemakaian tool LSP → server di-spawn (proses NYATA).
      await lspDiagnostics(join(dir, "a.ts"), "const a = 1\n", 500, dir).catch(() => {})

      const spawned = await waitFor(() => countLines(log, "start") >= 1, 8_000)
      expect(spawned).toBe(true)
      // [2] Anak terdaftar di jalur ownership proses runtime yang SAMA.
      const registered = await waitFor(() => supervision!.status().managed === 1, 5_000)
      expect(registered).toBe(true)
      // Status kanonik membedakan "kapabilitas terpasang" dari "anak hidup".
      const view = currentRuntimeView()
      expect(view.advertisedCapabilities).toContain("process-supervision")
      expect(view.supervisedChildren).toBe(1)
    } finally {
      await session.close()
    }
  })
})

// ── 3. Keluar tak terduga → bounded restart lewat jalur produksi ─────────────

describe("P13.2 — keluar tak terduga → bounded restart (jalur produksi)", () => {
  test("server LSP yang mati tak terduga → restart bounded oleh policy runtime", async () => {
    const { dir, log } = workspaceWithLsp((logPath) => ({
      command: process.execPath,
      args: ["-e", fakeLspServer(logPath, 150)],
      env: { LSP_TEST_LOG: logPath },
    }))
    isolateHome(dir)

    const session = await createCliSession({
      cwd: dir,
      allowLocalConfig: true,
      sessionId: "lsp-prod-2",
      prompt: "halo",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
      runtimeMode: "constructed",
    })
    try {
      const supervision = session.productionRuntime.runtime()!.supervision!
      await lspDiagnostics(join(dir, "a.ts"), "const a = 1\n", 300, dir).catch(() => {})

      // Server mati sendiri (keluar tak terduga) → supervisor me-restart-nya.
      const restarted = await waitFor(() => countLines(log, "start") >= 2, 10_000)
      expect(restarted).toBe(true)
      // Counter restart naik setelah restart BERHASIL (handshake selesai), jadi
      // tunggu counter-nya — bukan hanya jejak spawn.
      const counted = await waitFor(() => supervision.status().restarts >= 1, 10_000)
      expect(counted).toBe(true)
      // Restart TERBATAS: jumlah restart tak meledak tanpa batas.
      expect(supervision.status().restarts).toBeLessThanOrEqual(3)
    } finally {
      await session.close()
    }
  })

  test("restart membuka ulang dokumen yang terbuka (tanpa duplikat, tanpa isi basi)", async () => {
    const { dir, log } = workspaceWithLsp((logPath) => ({
      command: process.execPath,
      args: ["-e", fakeLspServer(logPath, 150)],
      env: { LSP_TEST_LOG: logPath },
    }))
    isolateHome(dir)

    const session = await createCliSession({
      cwd: dir,
      allowLocalConfig: true,
      sessionId: "lsp-prod-3",
      prompt: "halo",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
      runtimeMode: "constructed",
    })
    try {
      await lspDiagnostics(join(dir, "a.ts"), "const a = 1\n", 300, dir).catch(() => {})
      // Dokumen terbuka pada server PERTAMA.
      const openedFirst = await waitFor(() => countLines(log, "didOpen") >= 1, 8_000)
      expect(openedFirst).toBe(true)

      // Server mati → restart → server BARU harus menerima didOpen LAGI
      // (state dokumen dipulihkan), dan hanya SATU didOpen per instance server.
      const reopened = await waitFor(() => countLines(log, "didOpen") >= 2, 10_000)
      expect(reopened).toBe(true)
      const didOpens = countLines(log, "didOpen")
      const starts = countLines(log, "start")
      // Tanpa duplikat: satu didOpen per server yang hidup.
      expect(didOpens).toBeLessThanOrEqual(starts)
      // Tanpa isi basi: isi yang dikirim ulang adalah teks terakhir (12 char).
      const lines = readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("didOpen"))
      expect(lines.length).toBeGreaterThanOrEqual(2)
      for (const line of lines) expect(line).toContain("len=12")
    } finally {
      await session.close()
    }
  })
})

// ── 5. Shutdown rapi: anak dihentikan + ditunggu ───────────────────────────

describe("P13.2 — shutdown rapi membersihkan anak LSP", () => {
  test("shutdown sesi menghentikan server LSP dan TIDAK meninggalkan proses hidup", async () => {
    const { dir, log } = workspaceWithLsp((logPath) => ({
      command: process.execPath,
      args: ["-e", fakeLspServer(logPath, 60_000)],
      env: { LSP_TEST_LOG: logPath },
    }))
    isolateHome(dir)

    const session = await createCliSession({
      cwd: dir,
      allowLocalConfig: true,
      sessionId: "lsp-prod-4",
      prompt: "halo",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
      runtimeMode: "constructed",
    })
    await lspDiagnostics(join(dir, "a.ts"), "const a = 1\n", 500, dir).catch(() => {})
    const up = await waitFor(() => countLines(log, "start") >= 1, 8_000)
    expect(up).toBe(true)
    const pid = pidFromLog(log)
    expect(pid).not.toBeNull()
    expect(processGone(pid!)).toBe(false)

    await session.close()

    // Bukti level OS: proses server LSP tidak ada lagi.
    const gone = await waitFor(() => processGone(pid!), 8_000)
    expect(gone).toBe(true)
    // Fase cleanup proses tercatat di hasil shutdown runtime.
    const cleanup = session.productionRuntime
      .shutdownResult()
      ?.phases.find((p) => p.phase === "process-cleanup")
    expect(cleanup).toBeDefined()
  })
})

// ── 6. Konfigurasi LSP kosong: startup benar, tak ada klaim anak hidup ─────

describe("P13.2 — konfigurasi LSP kosong", () => {
  test("tanpa lspServers → startup tak crash, dan TIDAK ada klaim anak hidup", async () => {
    const { dir } = workspaceWithLsp()
    isolateHome(dir)

    const session = await createCliSession({
      cwd: dir,
      allowLocalConfig: true,
      sessionId: "lsp-none-1",
      prompt: "halo",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
      verify: false,
      runtimeMode: "constructed",
    })
    try {
      const supervision = session.productionRuntime.runtime()!.supervision!
      expect(supervision.status().managed).toBe(0)
      // Kapabilitas "process-supervision" = jalur terpasang; BUKAN klaim bahwa
      // ada proses anak hidup. Keduanya dibedakan.
      const view = currentRuntimeView()
      expect(view.advertisedCapabilities).toContain("process-supervision")
      expect(view.supervisedChildren).toBe(0)
      expect(view.health).toBe("HEALTHY")
    } finally {
      await session.close()
    }
  })
})

// ── 7. Kegagalan establishment → tak ada klaim sehat/supervisi ───────────────

describe("P13.2 — kegagalan establishment supervisi", () => {
  test("supervisi gagal established → runtime degraded, kapabilitas tak diiklankan", async () => {
    const dir = tempDir()
    isolateHome(dir)
    const handle = await createProductionRuntime(RUNTIME_GATE_ENABLED, () => ({
      sessionId: "lsp-fail-1",
      workspaceCwd: dir,
      journalPath: join(dir, "journal.db"),
      processSupervisionFactory: () => {
        throw new Error("supervisi tak bisa dibuat")
      },
    }))
    try {
      const facts = observeProductionRuntime(handle)
      const view = deriveRuntimeView(facts)
      expect(view.advertisedCapabilities).not.toContain("process-supervision")
      expect(view.availableCapabilities).not.toContain("process-supervision")
      expect(view.health).not.toBe("HEALTHY")
      expect(view.supervisedChildren).toBe(0)
    } finally {
      await handle.stop()
    }
  })
})
