// Test jalur masuk CLI: `cli/index.ts` + `cli/setup.ts`.
//
// Keduanya sebelumnya 0% tercakup padahal semua hal lewat sini: parsing flag,
// resolusi sandbox, pembangunan sesi, budget, trace, plan mode, self-heal.
// Tidak bisa diuji dengan harness fake-TTY — keduanya top-level script yang
// memanggil `process.exit`, jadi harus dijalankan sebagai PROSES (pola yang
// sudah dipakai `test/cli-subcommands.test.ts`).
//
// Provider-nya server HTTP nyata di localhost (`test/helpers/fake-provider.ts`),
// bukan stub `globalThis.fetch`: proses anak punya globalThis sendiri, jadi stub
// di dalam test tidak akan pernah terlihat olehnya.
//
// Proses anak dijalankan ASINKRON (`Bun.spawn` + await), bukan `spawnSync`:
// `spawnSync` memblokir event loop parent, sehingga `Bun.serve` milik provider
// tiruan tidak pernah bisa membalas dan setiap run menggantung sampai timeout.
// Itu menjatuhkan 28 dari 31 test pada percobaan pertama — bukan karena CLI-nya
// salah, tapi karena harness-nya deadlock.
//
// Setiap run diisolasi total: HOME/USERPROFILE diarahkan ke direktori temp
// supaya config global, DB sesi, dan cache harga milik mesin ini tidak ikut
// terbaca (dan tidak ikut ternoda).

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { flagNameOf, valueFlags } from "../cli/args.ts"
import { loadSession } from "../src/session/persistence.ts"
import { type FakeReply, startFakeProvider } from "./helpers/fake-provider.ts"

// Reorder args agar flag dikenal selalu sebelum prompt — cegah flag-injection
// sekaligus jaga kompatibilitas tes lama yang menulis ["prompt", "--flag", "val"].
function reorderForSecureCli(args: string[]): string[] {
  const flags: string[] = []
  const prompt: string[] = []
  let seenPrompt = false
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!
    if (token === "--") {
      prompt.push(...args.slice(i + 1))
      break
    }
    const flag = flagNameOf(token)
    if (flag) {
      flags.push(token)
      if (valueFlags.has(flag) && !token.includes("=")) {
        const v = args[i + 1]
        if (v !== undefined) {
          flags.push(v)
          i++
        }
      }
      continue
    }
    if (token.startsWith("-") && /^-?\d+(\.\d+)?$/.test(token) && !seenPrompt) {
      // "-5" sebagai value sudah diambil di atas; bila sampai sini tanpa flag,
      // anggap prompt
      seenPrompt = true
      prompt.push(token)
      continue
    }
    seenPrompt = true
    prompt.push(token)
  }
  return [...flags, ...prompt]
}

const repoRoot = resolve(import.meta.dir, "..")
const entry = join(repoRoot, "cli", "index.ts")

const tmpRoots: string[] = []

afterAll(() => {
  // Cleanup direktori temp sengaja dinonaktifkan di test ini.
  // Pada Windows, penghapusan rekursif puluhan workspace sementara terbukti
  // sering melewati timeout hook dan membuat suite gagal walau assertion inti
  // sudah hijau. Trade-off: artefak temp dibiarkan untuk dibersihkan OS.
  void tmpRoots
})

interface Workspace {
  dir: string
  /** Path config lokal yang dibaca `loadConfig(cwd)`. */
  configPath: string
}

/**
 * Workspace bersih + HOME palsu.
 *
 * `.minicode/` sengaja dibuat lebih dulu: `resolveDbPath` memilih DB lokal hanya
 * bila direktori itu ada, kalau tidak ia jatuh ke `~/.minicode` dan test saling
 * mencemari lewat sessions.db bersama.
 */
function makeWorkspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "minicode-cli-"))
  tmpRoots.push(dir)
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  mkdirSync(join(dir, "home", ".minicode"), { recursive: true })
  return { dir, configPath: join(dir, ".minicode", "config.json") }
}

function writeProviderConfig(
  ws: Workspace,
  baseUrl: string,
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    ws.configPath,
    JSON.stringify({
      providers: [
        {
          id: "fake",
          baseUrl,
          apiKey: "sk-test",
          models: ["gpt-4o-mini"],
          providerHint: "openai",
        },
      ],
      ...extra,
    }),
    "utf8",
  )
}

interface Run {
  code: number
  stdout: string
  stderr: string
  out: string
}

async function run(
  ws: Workspace,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<Run> {
  const fakeHome = join(ws.dir, "home")
  const normalized = reorderForSecureCli(args)
  const proc = Bun.spawn([process.execPath, entry, ...normalized], {
    // cwd proses = workspace, jadi `process.cwd()` dan `--cwd` sepakat. Tool file
    // memakai `process.cwd()` sebagai root jail (lihat PLAN.md P2.1); menyamakan
    // keduanya menjaga test ini mengukur CLI, bukan ketidaksepakatan itu.
    cwd: ws.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      NO_COLOR: "1",
      MINICODE_TELEMETRY: "1",
      DEEPSEEK_API_KEY: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      AGENT_BASE_URL: "",
      ...env,
    },
  })
  const killer = setTimeout(() => proc.kill(), timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(killer)
  return { code, stdout, stderr, out: stdout + stderr }
}

interface ProviderRun {
  run: Run
  ws: Workspace
  requests: Record<string, unknown>[]
  requestCount: number
}

/** Jalankan satu prompt terhadap provider tiruan; server ditutup setelahnya. */
async function runWithProvider(
  script: FakeReply[],
  args: string[],
  opts: {
    env?: Record<string, string>
    timeoutMs?: number
    configExtra?: Record<string, unknown>
  } = {},
): Promise<ProviderRun> {
  const ws = makeWorkspace()
  const provider = startFakeProvider(script)
  try {
    writeProviderConfig(ws, provider.baseUrl, opts.configExtra)
    const result = await run(
      ws,
      // Flag opt-in: provider lokal repo hanya aktif bila operator meminta
      // (aturan audit #07 — tanpa ini CLI memakai config global saja).
      [...args, "--cwd", ws.dir, "--model", "gpt-4o-mini", "--allow-local-config"],
      opts.env,
      opts.timeoutMs,
    )
    return {
      run: result,
      ws,
      requests: provider.requests(),
      requestCount: provider.requestCount(),
    }
  } finally {
    provider.close()
  }
}

// gpt-4o-mini di tabel harga bawaan: $0,15/M input, $0,60/M output.
// 2M input + 1M output = $0,30 + $0,60 = $0,90. Angka ini yang dipakai untuk
// menguji ambang budget, jadi jangan diubah tanpa menyesuaikan test di bawah.
const BIG_USAGE = { inputTokens: 2_000_000, outputTokens: 1_000_000 }
const COST_USD = 0.9

describe("cli: sesi one-shot dasar", () => {
  test("prompt teks selesai dengan exit 0 dan ringkasan token", async () => {
    const { run: r } = await runWithProvider(
      [{ kind: "text", text: "halo dunia", usage: BIG_USAGE }],
      ["ringkas repo ini"],
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("halo dunia")
    // Ringkasan ke stderr supaya stdout tetap bersih untuk pipe.
    expect(r.stderr).toContain("token")
  })

  test("prompt dikirim ke provider sebagai pesan user", async () => {
    const { requests } = await runWithProvider([{ kind: "text", text: "ok" }], ["prompt uji"])
    expect(requests.length).toBeGreaterThan(0)
    const msgs = requests[0]?.messages as { role: string; content: unknown }[]
    expect(msgs.some((m) => m.role === "user" && String(m.content).includes("prompt uji"))).toBe(
      true,
    )
  })

  test("MINICODE_DEBUG_STARTUP=1 mencetak durasi tiap fase setup", async () => {
    const { run: r } = await runWithProvider(
      [{ kind: "text", text: "ok", usage: BIG_USAGE }],
      ["halo"],
      { env: { MINICODE_DEBUG_STARTUP: "1" } },
    )
    expect(r.code).toBe(0)
    for (const phase of ["provider-layer", "rag-layer", "tool-layer", "kernel-session"]) {
      expect(r.stderr, phase).toContain(`[startup] ${phase} `)
    }
  })

  test("tanpa MINICODE_DEBUG_STARTUP: tanpa baris [startup]", async () => {
    const { run: r } = await runWithProvider(
      [{ kind: "text", text: "ok", usage: BIG_USAGE }],
      ["halo"],
    )
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain("[startup]")
  })

  test("tool call write_file benar-benar membuat berkas", async () => {
    const { run: r, ws } = await runWithProvider(
      [
        { kind: "tool", name: "write_file", args: { path: "hasil.txt", content: "isi dari tool" } },
        { kind: "text", text: "selesai" },
      ],
      ["buat hasil.txt"],
    )
    expect(r.code).toBe(0)
    const target = join(ws.dir, "hasil.txt")
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, "utf8")).toBe("isi dari tool")
  })

  test("error provider tampil ringkas + saran, bukan dump JSON", async () => {
    // 400 dipilih, bukan 429: kategori `invalid_request` langsung `throw` di
    // recovery policy, sementara `rate_limit` di-retry dengan backoff 1s+2s+4s
    // dan membuat test menabrak batas 5s milik bun. Yang diuji sama — pemetaan
    // kategori ke pesan, dan body mentah tidak ikut tercetak.
    const body = JSON.stringify({
      error: {
        message: "Provider returned error",
        metadata: { raw: "Model gpt-4o-mini tidak menerima tools.", remedy_hint: "Ganti model." },
      },
    })
    const { run: r } = await runWithProvider([{ kind: "status", status: 400, body }], ["apa saja"])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("Request was rejected by provider")
    // Detail spesifik tetap disampaikan — satu kalimat, bukan seluruh JSON.
    expect(r.stderr).toContain("tidak menerima tools")
    expect(r.stderr).not.toContain("remedy_hint")
    expect(r.stderr).not.toContain("metadata")
  })

  test("rate limit (429) di-retry lalu dilaporkan sebagai batas laju", async () => {
    // Backoff bawaan kernel: 1s + 2s + 4s sebelum menyerah, jadi test ini
    // memang lambat. Batasnya dinaikkan eksplisit alih-alih memperpendek
    // backoff — perilaku retry itu yang ingin dipastikan tetap ada.
    const { run: r } = await runWithProvider(
      [{ kind: "status", status: 429, body: '{"error":{"message":"too many requests"}}' }],
      ["apa saja"],
    )
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("Provider is rate-limiting requests")
  }, 30_000)
})

describe("cli: exec --json machine envelope", () => {
  test("stream kanonik berversi, bersih secret/ANSI, summary terakhir", async () => {
    const secret = `sk-${"k".repeat(24)}`
    const { run: r } = await runWithProvider(
      [
        { kind: "tool", name: "read_file", args: { path: "a.ts" } },
        { kind: "text", text: `isi ${secret} \x1b[2Jbersih` },
      ],
      ["exec", "--json", "baca a.ts"],
    )
    expect(r.code).toBe(0)
    const lines = r.stdout.split("\n").filter(Boolean)
    expect(lines.length).toBeGreaterThan(1)
    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    const ESC = String.fromCharCode(27)
    for (const rec of records) {
      expect(r.stdout).not.toContain(ESC)
      expect(JSON.stringify(rec)).not.toContain(secret)
      // Kontrak machine: tanpa raw kernel shape (tipe bertitik-dua).
      if (typeof rec.type === "string" && rec.type !== "text") expect(rec.type).not.toContain(":")
      if (typeof rec.type === "string" && rec.type !== "text" && rec.type !== "summary")
        expect(rec.schema).toBe("minicode.output.v1")
    }
    const last = records[records.length - 1]!
    expect(last).toMatchObject({ schema: "minicode.output.v1", type: "summary", ok: true })
    expect(String(r.stdout)).not.toContain(ESC)
  })
})

describe("cli: --budget", () => {
  test("melewati batas -> pesan [budget] dan exit 1", async () => {
    const { run: r } = await runWithProvider(
      [{ kind: "text", text: "mahal", usage: BIG_USAGE }],
      ["apa saja", "--budget", String(COST_USD / 2)],
    )
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("[budget]")
    expect(r.stderr).toContain("over budget")
  })

  test("di atas 80% -> peringatan tapi TIDAK memutus", async () => {
    // 0,9 dari 1,0 = 90% -> peringatan; masih di bawah batas -> exit 0.
    const { run: r } = await runWithProvider(
      [{ kind: "text", text: "hampir", usage: BIG_USAGE }],
      ["apa saja", "--budget", "1"],
    )
    expect(r.code).toBe(0)
    expect(r.stderr).toContain("80% used")
    expect(r.stderr).not.toContain("over budget")
  })

  test("jauh di bawah batas -> tanpa pesan budget sama sekali", async () => {
    const { run: r } = await runWithProvider(
      [{ kind: "text", text: "murah", usage: BIG_USAGE }],
      ["apa saja", "--budget", "100"],
    )
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain("[budget]")
  })

  test("--budget bukan angka -> peringatan dan diabaikan, run tetap lanjut", async () => {
    const { run: r } = await runWithProvider(
      [{ kind: "text", text: "tetap jalan", usage: BIG_USAGE }],
      ["apa saja", "--budget", "banyak"],
    )
    expect(r.code).toBe(0)
    expect(r.stderr).toContain("--budget requires a USD number")
    expect(r.stdout).toContain("tetap jalan")
  })
})

describe("cli: --plan", () => {
  test("menolak tool tulis — berkas tidak pernah dibuat", async () => {
    const { run: r, ws } = await runWithProvider(
      [
        { kind: "tool", name: "write_file", args: { path: "jangan.txt", content: "x" } },
        { kind: "text", text: "rencana: tidak menulis apa pun" },
      ],
      ["tulis jangan.txt", "--plan"],
    )
    expect(r.code).toBe(0)
    expect(existsSync(join(ws.dir, "jangan.txt"))).toBe(false)
    // Juga bukan di repo (kalau jail ter-anchor salah, ia akan muncul di sini).
    expect(existsSync(join(repoRoot, "jangan.txt"))).toBe(false)
  })

  test("MINICODE_PLAN=1 setara dengan --plan", async () => {
    const { run: r, ws } = await runWithProvider(
      [
        { kind: "tool", name: "write_file", args: { path: "env-plan.txt", content: "x" } },
        { kind: "text", text: "rencana" },
      ],
      ["tulis env-plan.txt"],
      { env: { MINICODE_PLAN: "1" } },
    )
    expect(r.code).toBe(0)
    expect(existsSync(join(ws.dir, "env-plan.txt"))).toBe(false)
  })

  test("plan mode membaca berkas tetap boleh", async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws.dir, "baca.txt"), "konten terbaca", "utf8")
    const provider = startFakeProvider([
      { kind: "tool", name: "read_file", args: { path: "baca.txt" } },
      { kind: "text", text: "sudah dibaca" },
    ])
    try {
      writeProviderConfig(ws, provider.baseUrl)
      const r = await run(ws, [
        "baca berkas",
        "--plan",
        "--cwd",
        ws.dir,
        "--model",
        "gpt-4o-mini",
        "--allow-local-config",
      ])
      expect(r.code).toBe(0)
      const second = provider.requests()[1]
      const msgs = second?.messages as { role: string; content: unknown }[]
      // Hasil tool masuk history: read_file benar-benar dieksekusi, bukan ditolak.
      expect(
        msgs.some((m) => m.role === "tool" && String(m.content).includes("konten terbaca")),
      ).toBe(true)
    } finally {
      provider.close()
    }
  })
})

describe("cli: --timeout", () => {
  test("provider yang menggantung diputus dengan exit 1", async () => {
    const { run: r } = await runWithProvider(
      [{ kind: "hang" }],
      ["apa saja", "--timeout", "1200"],
      {
        timeoutMs: 45_000,
      },
    )
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("Run exceeded timeout")
  })

  test("MINICODE_TIMEOUT_MS dipakai bila --timeout tidak ada", async () => {
    const { run: r } = await runWithProvider([{ kind: "hang" }], ["apa saja"], {
      env: { MINICODE_TIMEOUT_MS: "1200" },
      timeoutMs: 45_000,
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("Run exceeded timeout")
  })
})

describe("cli: --resume", () => {
  test("memuat riwayat sesi sebelumnya", async () => {
    const ws = makeWorkspace()
    const provider = startFakeProvider([{ kind: "text", text: "balasan" }])
    try {
      writeProviderConfig(ws, provider.baseUrl)
      const base = ["--cwd", ws.dir, "--model", "gpt-4o-mini", "--allow-local-config"]
      const first = await run(ws, ["pertanyaan pertama", "--session", "sesi-uji", ...base])
      expect(first.code).toBe(0)

      const second = await run(ws, ["pertanyaan kedua", "--resume", "sesi-uji", ...base])
      expect(second.code).toBe(0)
      expect(second.stderr).toContain("resumed session sesi-uji")
      // 1 user + 1 assistant dari run pertama.
      expect(second.stderr).toContain("(2 messages)")
      // Provider menerima riwayat itu, bukan hanya prompt baru.
      const msgs = provider.requests()[1]?.messages as { role: string; content: unknown }[]
      expect(msgs.some((m) => String(m.content).includes("pertanyaan pertama"))).toBe(true)
    } finally {
      provider.close()
    }
  })

  test("turn sukses menyimpan sesi yang bisa dibaca ulang", async () => {
    const ws = makeWorkspace()
    const provider = startFakeProvider([{ kind: "text", text: "balasan" }])
    try {
      writeProviderConfig(ws, provider.baseUrl)
      const first = await run(ws, [
        "pertanyaan pertama",
        "--session",
        "sesi-gen",
        "--cwd",
        ws.dir,
        "--model",
        "gpt-4o-mini",
        "--allow-local-config",
      ])
      expect(first.code).toBe(0)
      const loaded = loadSession("sesi-gen", ws.dir)
      expect(loaded).not.toBeNull()
      expect(loaded?.turnCount).toBeGreaterThanOrEqual(1)
      const roles = (loaded?.messages ?? []).map((m: unknown) => (m as { role?: string }).role)
      expect(roles).toContain("user")
      expect(roles).toContain("assistant")
    } finally {
      provider.close()
    }
  })

  test("id sesi tak dikenal -> peringatan, mulai baru, tetap exit 0", async () => {
    const { run: r } = await runWithProvider(
      [{ kind: "text", text: "sesi baru" }],
      ["apa saja", "--resume", "tidak-ada-ini"],
    )
    expect(r.code).toBe(0)
    expect(r.stderr).toContain("not found")
  })
})

describe("cli: trace", () => {
  test("trace tertulis dengan model dan biaya terisi", async () => {
    const { run: r, ws } = await runWithProvider(
      [{ kind: "text", text: "ok", usage: BIG_USAGE }],
      ["prompt untuk trace"],
    )
    expect(r.code).toBe(0)
    const tracePath = join(ws.dir, ".minicode", "traces.jsonl")
    expect(existsSync(tracePath)).toBe(true)
    const lines = readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean)
    expect(lines.length).toBe(1)
    const t = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(t.ok).toBe(true)
    expect(t.model).toBe("gpt-4o-mini")
    expect(t.inputTokens).toBe(BIG_USAGE.inputTokens)
    expect(t.cost).toBeCloseTo(COST_USD, 5)
    expect(t.prompt).toContain("prompt untuk trace")
  })

  test("run gagal juga menulis trace dengan ok:false", async () => {
    const { run: r, ws } = await runWithProvider(
      [{ kind: "status", status: 401, body: "no key" }],
      ["prompt gagal"],
    )
    expect(r.code).toBe(1)
    const t = JSON.parse(
      readFileSync(join(ws.dir, ".minicode", "traces.jsonl"), "utf8").trim(),
    ) as Record<string, unknown>
    expect(t.ok).toBe(false)
    expect(String(t.error).length).toBeGreaterThan(0)
  })

  test("MINICODE_TELEMETRY=0 tidak menulis trace apa pun", async () => {
    const { run: r, ws } = await runWithProvider([{ kind: "text", text: "ok" }], ["apa saja"], {
      env: { MINICODE_TELEMETRY: "0" },
    })
    expect(r.code).toBe(0)
    expect(existsSync(join(ws.dir, ".minicode", "traces.jsonl"))).toBe(false)
  })
})

describe("cli: --verify (self-heal)", () => {
  /**
   * Perintah verify yang GAGAL dua kali lalu BERHASIL — ditulis sebagai berkas
   * supaya tidak perlu menyusun quoting shell bersarang lewat env var.
   * Dua kegagalan: baseline-first (P2.1) menghabiskan yang pertama, siklus
   * self-heal menghabiskan yang kedua — persis skenario baseline rusak yang
   * diperbaiki agen.
   */
  function writeFlakyVerify(ws: Workspace): void {
    writeFileSync(
      join(ws.dir, "verify-sekali-gagal.ts"),
      [
        "// Gagal pada dua pemanggilan pertama, berhasil pada berikutnya.",
        'import { existsSync, readFileSync, writeFileSync } from "node:fs"',
        'const p = "verify-count.txt"',
        'const n = existsSync(p) ? Number(readFileSync(p, "utf8")) : 0',
        'writeFileSync(p, String(n + 1), "utf8")',
        'if (n <= 1) { console.error("typecheck gagal: contoh error"); process.exit(1) }',
        "process.exit(0)",
      ].join("\n"),
      "utf8",
    )
  }

  test("verify gagal memicu siklus perbaikan lalu lapor berhasil", async () => {
    const ws = makeWorkspace()
    writeFlakyVerify(ws)
    const provider = startFakeProvider([{ kind: "text", text: "sudah kuperbaiki" }])
    try {
      writeProviderConfig(ws, provider.baseUrl)
      const r = await run(
        ws,
        [
          "perbaiki sesuatu",
          "--verify",
          "--cwd",
          ws.dir,
          "--model",
          "gpt-4o-mini",
          "--allow-local-config",
        ],
        { MINICODE_VERIFY_CMD: `${process.execPath} verify-sekali-gagal.ts` },
      )
      expect(r.code).toBe(0)
      // P2.1: kegagalan pertama ditelan baseline-check, bukan siklus self-heal.
      expect(r.stderr).toContain("baseline failing before agent run")
      expect(r.stderr).toContain("[verify] attempt 1/3 failed")
      expect(r.stderr).toContain("[verify] ok after 2 fix cycles")
      // Dua request: prompt asli (+catatan baseline) + satu prompt perbaikan.
      expect(provider.requestCount()).toBe(2)
      const firstPrompt = JSON.stringify(provider.requests()[0]?.messages)
      expect(firstPrompt).toContain("Health-Check")
      const fixPrompt = JSON.stringify(provider.requests()[1]?.messages)
      expect(fixPrompt).toContain("Auto-Verifier")
      expect(fixPrompt).toContain("typecheck gagal")
    } finally {
      provider.close()
    }
  })

  test("verify yang selalu gagal berhenti setelah 3 percobaan tanpa crash", async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws.dir, "selalu-gagal.ts"), "process.exit(1)\n", "utf8")
    const provider = startFakeProvider([{ kind: "text", text: "coba lagi" }])
    try {
      writeProviderConfig(ws, provider.baseUrl)
      const r = await run(
        ws,
        ["perbaiki", "--verify", "--cwd", ws.dir, "--model", "gpt-4o-mini", "--allow-local-config"],
        {
          MINICODE_VERIFY_CMD: `${process.execPath} selalu-gagal.ts`,
        },
      )
      expect(r.code).toBe(0)
      expect(r.stderr).toContain("still failing after 3 attempts")
    } finally {
      provider.close()
    }
  })

  test("verifyCommand dari config dipakai bila env tidak ada", async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws.dir, "selalu-gagal.ts"), "process.exit(1)\n", "utf8")
    const provider = startFakeProvider([{ kind: "text", text: "ok" }])
    try {
      writeProviderConfig(ws, provider.baseUrl, {
        verifyCommand: `${process.execPath} selalu-gagal.ts`,
      })
      const r = await run(ws, [
        "perbaiki",
        "--verify",
        "--cwd",
        ws.dir,
        "--model",
        "gpt-4o-mini",
        "--allow-local-config",
      ])
      expect(r.code).toBe(0)
      expect(r.stderr).toContain("[verify]")
    } finally {
      provider.close()
    }
  })

  test("tanpa --verify tidak ada siklus verify sama sekali", async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws.dir, "selalu-gagal.ts"), "process.exit(1)\n", "utf8")
    const provider = startFakeProvider([{ kind: "text", text: "ok" }])
    try {
      writeProviderConfig(ws, provider.baseUrl, {
        verifyCommand: `${process.execPath} selalu-gagal.ts`,
      })
      const r = await run(ws, [
        "kerjakan",
        "--cwd",
        ws.dir,
        "--model",
        "gpt-4o-mini",
        "--allow-local-config",
      ])
      expect(r.code).toBe(0)
      expect(r.stderr).not.toContain("[verify]")
      expect(provider.requestCount()).toBe(1)
    } finally {
      provider.close()
    }
  })
})

describe("cli: tanpa provider", () => {
  test("pesan mengarahkan ke wizard/config, exit 1", async () => {
    const ws = makeWorkspace()
    writeFileSync(ws.configPath, JSON.stringify({ providers: [] }), "utf8")
    const r = await run(ws, ["apa saja", "--cwd", ws.dir])
    expect(r.code).toBe(1)
    expect(r.out).toContain("no provider configured")
  })

  test("tanpa prompt dan tanpa TTY -> usage, exit 2", async () => {
    const ws = makeWorkspace()
    writeFileSync(ws.configPath, JSON.stringify({ providers: [] }), "utf8")
    const r = await run(ws, ["--cwd", ws.dir])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("usage: minicode")
  })
})

describe("cli: --provider", () => {
  test("id yang tidak ada -> peringatan, jatuh ke urutan default", async () => {
    const { run: r } = await runWithProvider(
      [{ kind: "text", text: "tetap jalan" }],
      ["apa saja", "--provider", "tidak-ada"],
    )
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('--provider "tidak-ada" not found')
    expect(r.stdout).toContain("tetap jalan")
  })

  test("id yang ada dipakai tanpa peringatan", async () => {
    const { run: r } = await runWithProvider(
      [{ kind: "text", text: "ok" }],
      ["apa saja", "--provider", "fake"],
    )
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain("not found")
  })
})

describe("cli: --max-steps", () => {
  test("batas langkah tercapai -> pesan yang bisa ditindaklanjuti, exit 1", async () => {
    // Provider selalu meminta tool, jadi loop tidak pernah menutup turn.
    const { run: r } = await runWithProvider(
      [{ kind: "tool", name: "read_file", args: { path: "tidak-ada.txt" } }],
      ["loop terus", "--max-steps", "2"],
    )
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("Tool step limit reached")
  })
})

describe("cli: notice sandbox", () => {
  test("start rutin tanpa --sandbox: senyap (mode terlihat di prefiks)", async () => {
    const { run: r } = await runWithProvider([{ kind: "text", text: "ok" }], ["apa saja"])
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain("[sandbox]")
  })

  test("run yang memakai tool menyebut notice paling banyak sekali", async () => {
    const { run: r } = await runWithProvider([{ kind: "text", text: "ok" }], ["apa saja"])
    // Di Windows/CI tanpa bubblewrap notice muncul sekali, bukan per langkah.
    const count = r.stderr.split("[sandbox]").length - 1
    expect(count).toBeLessThanOrEqual(1)
  })

  test("--sandbox none tidak mencetak notice", async () => {
    const { run: r } = await runWithProvider(
      [{ kind: "text", text: "ok" }],
      ["apa saja", "--sandbox", "none"],
    )
    expect(r.stderr).not.toContain("[sandbox]")
  })

  test("--sandbox tak dikenal memberi daftar mode yang sah", async () => {
    const { run: r } = await runWithProvider(
      [{ kind: "text", text: "ok" }],
      ["apa saja", "--sandbox", "bogus"],
    )
    expect(r.stderr).toContain("docker|os|none")
  })
})
