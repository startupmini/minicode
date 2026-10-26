// Test subcommand CLI: help kontekstual, exit code, dan --json.
//
// Sebelumnya `config`, `config mcp`, `config lsp`, dan `mcp` tanpa argumen
// mencetak HELP global 45 baris lalu exit 0 — user tidak tahu apa yang salah dan
// skrip tidak bisa mendeteksi kesalahan pemakaian.

import { describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { ControlActions } from "../src/daemon/control.ts"
import { readEndpoint } from "../src/daemon/discovery.ts"
import { DaemonHost } from "../src/daemon/host.ts"

const repoRoot = resolve(import.meta.dir, "..")
const entry = join(repoRoot, "cli", "index.ts")

interface Run {
  code: number
  stdout: string
  stderr: string
  out: string
}

function run(args: string[], cwd = repoRoot): Run {
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  })
  const stdout = r.stdout ?? ""
  const stderr = r.stderr ?? ""
  return { code: r.status ?? -1, stdout, stderr, out: stdout + stderr }
}

describe("cli: versi", () => {
  test("--version mencetak versi dari package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8").replace(/^\uFEFF/, ""),
    ) as { version: string }
    const r = run(["--version"])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe(pkg.version)
  })

  test("-v sama dengan --version", () => {
    expect(run(["-v"]).stdout.trim()).toBe(run(["--version"]).stdout.trim())
  })

  test("--help --json memuat versi yang sama", () => {
    const r = run(["--help", "--json"])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout) as { version: string; options: unknown[] }
    expect(parsed.version).toBe(run(["--version"]).stdout.trim())
    expect(parsed.options.length).toBeGreaterThan(5)
  })

  test("--tui dicatat usang di help teks + help JSON", () => {
    // Temuan audit F8: flag yang diterima tapi diam = user mengira ia bekerja.
    const r = run(["--help"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("--tui")
    expect(r.stdout).toContain("deprecated")
    const j = JSON.parse(run(["--help", "--json"]).stdout) as {
      options: { flag: string; desc: string }[]
    }
    const tui = j.options.find((o) => o.flag === "--tui")
    expect(tui?.desc).toMatch(/deprecated/i)
  })

  test("--help menyebut binding baru (Home/End, setengah halaman, keluar dua-tap)", () => {
    const r = run(["--help"])
    expect(r.stdout).toContain("Home/End")
    expect(r.stdout).toContain("half page")
    expect(r.stdout).toContain("twice = quit")
  })

  test("--tui memicu peringatan deprecation di stderr, exit tetap sepadan", () => {
    // Peringatan hanya di stderr (kontrak stdout bersih untuk machine-readable).
    const withTui = run(["--help", "--tui"])
    expect(withTui.stderr).toContain("[deprecated] --tui")
    expect(withTui.stdout).toContain("Minicode - coding agent")
    expect(withTui.code).toBe(0)
  })
})

describe("cli: help kontekstual + exit code", () => {
  // Tanpa argumen = user meminta petunjuk -> exit 0, help spesifik.
  // Catatan: `pricing` dan `auth` tanpa argumen punya default berguna
  // (`pricing` -> status), jadi help-nya diminta lewat --help.
  const contextual: [string[], string][] = [
    [["config"], "minicode config"],
    [["config", "mcp"], "minicode config mcp"],
    [["config", "lsp"], "minicode config lsp"],
    [["mcp"], "minicode mcp"],
    [["skills", "--help"], "minicode skills"],
    [["sessions", "--help"], "minicode sessions"],
    [["pricing", "--help"], "minicode pricing"],
    [["auth"], "minicode auth"],
  ]
  for (const [args, expected] of contextual) {
    test(`${args.join(" ")} -> help spesifik, exit 0`, () => {
      const r = run(args)
      expect(r.code).toBe(0)
      expect(r.out).toContain(expected)
      // Bukan HELP global: tidak memuat daftar Options lengkap.
      expect(r.out).not.toContain("--context-window")
    })
  }

  // Subcommand asing = salah pakai -> exit 2 supaya skrip bisa mendeteksi
  // dan membedakannya dari gagal runtime (exit 1).
  const unknown: string[][] = [
    ["config", "bogus"],
    ["config", "mcp", "bogus"],
    ["config", "lsp", "bogus"],
    ["mcp", "bogus"],
    ["skills", "bogus"],
    ["sessions", "bogus"],
    ["pricing", "bogus"],
    ["auth", "bogus"],
  ]
  for (const args of unknown) {
    test(`${args.join(" ")} -> exit 2 + mentions unknown subcommand`, () => {
      const r = run(args)
      expect(r.code).toBe(2)
      expect(r.out.toLowerCase()).toContain("unknown")
      expect(r.out.toLowerCase()).toContain("subcommand")
    })
  }
})

describe("cli: stats", () => {
  test("--json menghasilkan JSON valid, bukan diabaikan", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicode-stats-"))
    try {
      const r = run(["stats", "--json", "--cwd", tmp])
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout) as Record<string, number>
      expect(parsed.runs).toBe(0)
      expect(parsed).toHaveProperty("inputTokens")
      expect(parsed).toHaveProperty("cost")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("tanpa --json memberi ringkasan yang bisa dibaca", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicode-stats-"))
    try {
      const r = run(["stats", "--cwd", tmp])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("Runs:")
      expect(() => JSON.parse(r.stdout)).toThrow()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("cli: memory", () => {
  test("--json menghasilkan JSON valid dengan rows/bytes/models", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicode-mem-"))
    try {
      mkdirSync(join(tmp, ".minicode"), { recursive: true })
      const r = run(["memory", "--json", "--cwd", tmp])
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>
      expect(parsed.rows).toBe(0)
      expect(parsed).toHaveProperty("dbBytes")
      expect(parsed).toHaveProperty("models")
      expect(parsed).toHaveProperty("avgMemoryHits")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("tanpa --json memberi ringkasan yang bisa dibaca", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicode-mem-"))
    try {
      mkdirSync(join(tmp, ".minicode"), { recursive: true })
      const r = run(["memory", "--cwd", tmp])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("Memory")
      expect(() => JSON.parse(r.stdout)).toThrow()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("subcommand tak dikenal = exit 2", () => {
    const r = run(["memory", "bogus"])
    expect(r.code).toBe(2)
    expect(r.out.toLowerCase()).toContain("unknown")
  })
})

describe("cli: perintah tanpa LLM tetap jalan", () => {
  test("providers pada workspace kosong tidak crash", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicode-empty-"))
    try {
      const r = run(["providers", "--cwd", tmp])
      expect(r.code).toBe(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("sessions list pada workspace baru memberi pesan kosong", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicode-empty-"))
    try {
      // DB sesi lokal dipakai hanya bila .minicode/ ada; tanpa itu resolveDbPath
      // jatuh ke ~/.minicode dan akan menampilkan sesi mesin ini.
      mkdirSync(join(tmp, ".minicode"), { recursive: true })
      const r = run(["sessions", "list", "--cwd", tmp])
      expect(r.code).toBe(0)
      expect(r.out).toContain("no recorded sessions yet")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("sessions list mengumumkan scope global bila tanpa .minicode lokal", () => {
    // Regresi F-C audit terminal UI/UX: fallback ke DB global dulu diam-diam,
    // daftar lintas-workspace bisa dibaca sebagai isi workspace ini.
    const tmp = mkdtempSync(join(tmpdir(), "minicode-noscope-"))
    try {
      const r = run(["sessions", "list", "--cwd", tmp])
      expect(r.code).toBe(0)
      expect(r.out).toContain("global scope")
      expect(r.out).toContain(tmp)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("sessions list lokal tidak memuat baris scope", () => {
    const tmp = mkdtempSync(join(tmpdir(), "minicode-local-"))
    try {
      mkdirSync(join(tmp, ".minicode"), { recursive: true })
      const r = run(["sessions", "list", "--cwd", tmp])
      expect(r.code).toBe(0)
      expect(r.out).not.toContain("global scope")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("skills list menampilkan tabel yang sejajar", () => {
    const r = run(["skills", "list"])
    expect(r.code).toBe(0)
    const lines = r.stdout.split("\n").filter((l) => l.trim().startsWith("/"))
    if (lines.length > 1) {
      // Semua baris skill punya lebar sama (batas keras kolom tabel).
      const widths = new Set(lines.map((l) => l.length))
      expect(widths.size).toBe(1)
    }
  })
})

describe("cli: notice sandbox tidak bising", () => {
  test("perintah tanpa tool tidak memuat notice sandbox", () => {
    for (const args of [["--version"], ["providers"], ["stats"], ["pricing", "status"]]) {
      expect(run(args).stderr).not.toContain("[sandbox]")
    }
  })
})

// ── Fixture CLI daemon yang dipakai bersama P11.3 dan D-1.
//
// Satu jalur spawn = satu kebijakan env. Sebelumnya tiap describe menyusun
// env-nya sendiri, dan `...process.env` polos mewariskan kredensial provider
// milik mesin ini ke proses anak (temuan hygiene QA §G laporan full-system).

/** Workspace sementara: `<cwd>/.minicode` + HOME palsu terpisah. */
function hermeticWs(): { dir: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "minicode-daemon-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  const home = join(dir, "home")
  mkdirSync(join(home, ".minicode"), { recursive: true })
  return { dir, home }
}

/**
 * Env anak CLI: tanpa kredensial provider, tanpa state mesin ini.
 *
 * `MINICODE_HOME` menunjuk HOME palsu (`resolveDbPath` jatuh ke sana bila
 * `<cwd>/.minicode` tak ada), dan `NO_UPDATE_CHECK=1` menahan notifier
 * non-interaktif yang tanpa itu akan `fetch` registry.npmjs.org (jalur
 * non-`--json`; `--json` sudah di-skip sendiri oleh update-check).
 */
function hermeticEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    // Pola nama kredensial yang dipakai provider/tool di repo ini
    // (ANTHROPIC_/OPENAI_/DEEPSEEK_/AGENT_/BRAVE_/TAVILY_ API_KEY, MINICODE_KEY).
    if (/(API_KEY|_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(k)) continue
    env[k] = v
  }
  env.NO_COLOR = "1"
  env.NO_UPDATE_CHECK = "1"
  env.HOME = home
  env.USERPROFILE = home
  env.MINICODE_HOME = home
  return env
}

/** Spawn CLI di workspace hermetik yang SUDAH ada (fixture daemon hidup). */
function spawnCliIn(argv: string[], ws: { dir: string; home: string }): Run {
  const r = spawnSync(process.execPath, [entry, ...argv], {
    cwd: ws.dir,
    encoding: "utf8",
    timeout: 60_000,
    env: hermeticEnv(ws.home),
  })
  const stdout = r.stdout ?? ""
  const stderr = r.stderr ?? ""
  return { code: r.status ?? -1, stdout, stderr, out: stdout + stderr }
}

/**
 * Varian ASINKRON dari `spawnCliIn` — wajib untuk fixture host in-process.
 *
 * `spawnSync` memblokir event loop proses tes, dan host daemon itu hidup DI
 * proses ini: dengan event loop terblokir, handshake `hello` konsumen tak
 * pernah dijawab dan CLI gagal dengan "hello timeout" (bukan bug produk —
 * efek sampling). Karena itu anak di-`await`, bukan ditunggu sinkron.
 */
function spawnCliAsync(argv: string[], ws: { dir: string; home: string }): Promise<Run> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [entry, ...argv], {
      cwd: ws.dir,
      env: hermeticEnv(ws.home),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d: string) => {
      stdout += d
    })
    child.stderr.on("data", (d: string) => {
      stderr += d
    })
    const timer = setTimeout(() => {
      child.kill()
      rejectRun(new Error(`CLI tak selesai dalam 60s: ${argv.join(" ")}`))
    }, 60_000)
    child.on("error", (e) => {
      clearTimeout(timer)
      rejectRun(e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolveRun({ code: code ?? -1, stdout, stderr, out: stdout + stderr })
    })
  })
}

/**
 * Buang direktori sementara.
 *
 * Windows + bun:sqlite sering menyisakan EBUSY sesudah `Database.close()`
 * (handle dilepas saat GC, bukan saat close). Itu perilaku runtime, bukan hasil
 * tes, jadi kegagalan bersih-bersih ditelan di sini saja — seperti pola
 * `discard()` di test/p2-daemon-guards.test.ts.
 */
function discard(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  } catch {}
}

/** Workspace baru per panggilan; "<DIR>" diganti direktori ws. */
function runDaemon(argv: string[]): Run {
  const ws = hermeticWs()
  try {
    return spawnCliIn(
      argv.map((a) => (a === "<DIR>" ? ws.dir : a)),
      ws,
    )
  } finally {
    discard(ws.dir)
  }
}

// ── P11.3: daemon menerima argv scoped TANPA token routing (cermin P11.2).
// Guard lokal `args[0] === "daemon"` lama salah saat flag global mendahului:
// `minicode --json daemon status` dibaca sebagai aksi "daemon" (exit 2 palsu).
// Tanpa endpoint, `status`/`stop` deterministik (tanpa probe jaringan — probe
// hanya jalan bila berkas endpoint ada): JSON not-alive + exit 3. `start`
// SENGAJA tak diuji di sini (blocking, menahan event loop). Workspace
// hermetic (HOME palsu + cwd tmp) agar endpoint mesin ini tak ikut terbaca.
describe("cli: daemon scoped argv (P11.3)", () => {
  /** Tanpa endpoint: status = JSON not-alive + exit 3 (kontrak statusDaemon). */
  function expectNotAliveJson(r: Run): void {
    expect(r.code).toBe(3)
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>
    expect(parsed).toMatchObject({ alive: false, status: "none" })
    expect(parsed).toHaveProperty("reason")
    expect(parsed).toHaveProperty("incarnation")
    expect(parsed).toHaveProperty("port")
    expect(parsed).toHaveProperty("leaseAgeMs")
    expect(r.stderr).not.toContain("unknown daemon subcommand")
  }

  test("A: --json SEBELUM daemon -> aksi status tercapai (bukan exit 2)", () => {
    expectNotAliveJson(runDaemon(["--json", "daemon", "status", "--cwd", "<DIR>"]))
    // Value-flag global sebelum subcommand ikut tercakup.
    expectNotAliveJson(runDaemon(["--json", "--cwd", "<DIR>", "daemon", "status"]))
  })

  test("B/C: bentuk daemon-first dan biasa tak berubah", () => {
    expectNotAliveJson(runDaemon(["daemon", "--json", "status", "--cwd", "<DIR>"]))
    // Tanpa --json: baris manusia, bukan JSON, exit tetap 3.
    const human = runDaemon(["daemon", "status", "--cwd", "<DIR>"])
    expect(human.code).toBe(3)
    expect(human.stdout).toContain("daemon: not alive")
    expect(() => JSON.parse(human.stdout)).toThrow()
    // Bare `daemon` = default status (kontrak: first ?? "status").
    const bare = runDaemon(["daemon", "--cwd", "<DIR>"])
    expect(bare.code).toBe(3)
    expect(bare.stdout).toContain("daemon: not alive")
    expectNotAliveJson(runDaemon(["--json", "daemon", "--cwd", "<DIR>"]))
  })

  test("D: aksi asing tetap ditolak exit 2 (tak diubah jadi status)", () => {
    for (const argv of [
      ["daemon", "bogus", "--cwd", "<DIR>"],
      ["--json", "daemon", "bogus", "--cwd", "<DIR>"],
    ]) {
      const r = runDaemon(argv)
      expect(r.code).toBe(2)
      expect(r.out).toContain("unknown daemon subcommand: bogus")
    }
  })

  test("E: aksi lain lewat kontrak argv yang sama", () => {
    // `issue` tanpa --scopes = usage error exit 2 (tanpa endpoint).
    for (const argv of [
      ["daemon", "issue", "--cwd", "<DIR>"],
      ["--json", "daemon", "issue", "--cwd", "<DIR>"],
    ]) {
      const r = runDaemon(argv)
      expect(r.code).toBe(2)
      expect(r.stderr).toContain("--scopes wajib")
    }
    // `stop` tanpa endpoint = exit 3 (bukan exit 2 routing). Bentuk JSON-nya
    // diuji penuh di describe D-1; di sini cukup routing-nya tercapai.
    const stop = runDaemon(["--json", "daemon", "stop", "--cwd", "<DIR>"])
    expect(stop.code).toBe(3)
    expect(stop.out).not.toContain("unknown daemon subcommand")
    expect(JSON.parse(stop.stdout)).toMatchObject({ ok: false })
    // `help` tetap exit 0 di kedua urutan.
    for (const argv of [
      ["daemon", "help"],
      ["--json", "daemon", "help"],
    ]) {
      const r = runDaemon(argv)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("minicode daemon")
    }
    // Enam spawn CLI berurutan; batas default 5 dtk terlalu ketat saat suite
    // penuh berjalan paralel (pernah timeout 5,96 dtk tanpa kegagalan kode).
  }, 20_000)
})

// ── D-1: integritas JSON pada jalur KEGAGALAN daemon.
//
// `fail()` sudah meng-encode payload (JSON.stringify terjadi di sana), tapi
// `stopDaemon`/`listSessions` mewariskan string yang SUDAH di-encode — payload
// ter-encode dua kali, dan `JSON.parse(stdout)` pada konsumen mesin
// menghasilkan string, bukan objek. Assertion di sini sengaja memarse penuh:
// `toContain("ok")`/`toContain("reason")` lolos untuk bentuk yang rusak maupun
// yang benar, jadi ia tak bisa mengunci bug ini.
describe("cli: daemon JSON integritas kegagalan (D-1)", () => {
  /**
   * Host daemon NYATA di dalam proses tes (loopback, port ephemeral) sebagai
   * fixture penolakan: dengan `ControlActions` tak terpasang, `session.list`
   * menolak PROTOCOL_ERROR (fail-closed — lihat src/daemon/control.ts). Itu
   * jalur `!res.ok` di cli/commands/daemon.ts, persis jalur yang dulu
   * double-encode. Tak ada proses daemon blocking yang dijalankan, jadi tak
   * ada yang bisa tertinggal hidup; `shutdown()` + `discard()` di `finally`.
   */
  function startHost(dir: string, actions: ControlActions | null): Promise<DaemonHost> {
    return DaemonHost.start({
      cwd: dir,
      port: 0,
      feeds: { get: () => undefined, known: () => [] },
      actions,
      warn: () => {},
    })
  }

  const emptyActions: ControlActions = {
    listSessions: () => [],
    sessionStatus: () => null,
    interrupt: () => ({ ok: false, code: "RUN_TERMINAL", message: "tidak ada sesi" }),
    cancel: () => ({ ok: false, code: "RUN_TERMINAL", message: "tidak ada sesi" }),
    shutdown: () => {},
  }

  test("A: `daemon stop --json` tanpa daemon -> JSON.parse = objek, exit 3", () => {
    for (const argv of [
      ["daemon", "stop", "--json", "--cwd", "<DIR>"],
      ["--json", "daemon", "stop", "--cwd", "<DIR>"],
    ]) {
      const r = runDaemon(argv)
      expect(r.code).toBe(3)
      const parsed: unknown = JSON.parse(r.stdout)
      expect(parsed).toBeTypeOf("object")
      expect(Array.isArray(parsed)).toBe(false)
      expect(parsed).toMatchObject({ ok: false })
      expect((parsed as { reason?: unknown }).reason).toBeTypeOf("string")
      // Jalur manusia tetap di stderr dan tak boleh bercampur ke stdout.
      expect(r.stderr).toContain("daemon: ")
      expect(r.stdout.trim().startsWith("{")).toBe(true)
    }
  })

  test("B: `daemon sessions --json` pada PENOLAKAN host -> objek, exit 1", async () => {
    const ws = hermeticWs()
    const host = await startHost(ws.dir, null)
    try {
      const r = await spawnCliAsync(["daemon", "sessions", "--json", "--cwd", ws.dir], ws)
      expect(r.code).toBe(1)
      const parsed = JSON.parse(r.stdout) as { ok?: unknown; refusal?: { code?: unknown } }
      expect(parsed).toBeTypeOf("object")
      expect(Array.isArray(parsed)).toBe(false)
      expect(parsed.ok).toBe(false)
      expect(parsed.refusal?.code).toBe("PROTOCOL_ERROR")
      expect(r.stderr).toContain("PROTOCOL_ERROR")

      // Perintah yang sama punya dua jalur kegagalan; `stop` di sini lewat
      // `emit()` (daemon hidup, permintaan DITOLAK), bukan `fail()` (daemon
      // mati) — keduanya harus satu-encode dan exit-nya tetap berbeda.
      const stop = await spawnCliAsync(["daemon", "stop", "--json", "--cwd", ws.dir], ws)
      expect(stop.code).toBe(1)
      const stopParsed = JSON.parse(stop.stdout) as { ok?: unknown; refusal?: { code?: unknown } }
      expect(stopParsed).toBeTypeOf("object")
      expect(stopParsed.ok).toBe(false)
      expect(stopParsed.refusal?.code).toBe("PROTOCOL_ERROR")
    } finally {
      await host.shutdown("test")
      // Bukti tak ada sisa: endpoint/lease milik host ini dilepas sendiri.
      expect(readEndpoint(ws.dir)).toBeNull()
      discard(ws.dir)
    }
  }, 30_000)

  test("C: jalur SUKSES tetap satu-encode; manusia & stderr tak berubah", async () => {
    const ws = hermeticWs()
    const host = await startHost(ws.dir, emptyActions)
    try {
      const json = await spawnCliAsync(["daemon", "sessions", "--json", "--cwd", ws.dir], ws)
      expect(json.code).toBe(0)
      expect(JSON.parse(json.stdout)).toEqual({ ok: true, sessions: [] })

      const human = await spawnCliAsync(["daemon", "sessions", "--cwd", ws.dir], ws)
      expect(human.code).toBe(0)
      expect(human.stdout.trim()).toBe("(tidak ada sesi yang di-host)")
      expect(() => JSON.parse(human.stdout)).toThrow()
      expect(human.stderr).toBe("")
    } finally {
      await host.shutdown("test")
      expect(readEndpoint(ws.dir)).toBeNull()
      discard(ws.dir)
    }
  }, 30_000)
})
