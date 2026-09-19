// Test handler subcommand IN-PROCESS.
//
// cli-subcommands.test.ts menjalankan biner lewat spawn — itu menguji perilaku
// nyata (exit code, aliran stdout/stderr) tapi proses terpisah tidak terhitung
// coverage dan lambat. Berkas ini memanggil handler langsung: setiap handler
// mengakhiri dengan process.exit(), jadi exit distub menjadi throw sentinel.
//
// Output ditangkap lewat fake TTY, BUKAN captureOutput(): captureOutput memotong
// spasi kanan (jadi assertion lebar kolom tidak valid) dan hanya menangkap
// stdout, sementara pesan `usage:` ditulis ke stderr.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dispatch } from "../cli/router.ts"
import { __resetPricingOverlay } from "../src/policy/pricing.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

// `pricing status` memuat overlay models.dev ke state modul pricing, dan
// findPrice() memakai state itu sebagai default. Tanpa reset, berkas test lain
// yang memanggil costFor() akan memakai harga overlay mesin ini, bukan tabel
// bawaan — hasilnya bergantung urutan berkas test.
afterAll(() => {
  __resetPricingOverlay()
})

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`)
  }
}

const origExit = process.exit
let tty: FakeTty | undefined

beforeEach(() => {
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0)
  }) as unknown as typeof process.exit
})
afterEach(() => {
  process.exit = origExit
  tty?.restore()
  tty = undefined
})

/** Jalankan handler; kembalikan exit code + output (stdout+stderr) bersih. */
async function runHandler(fn: () => Promise<unknown>): Promise<{ code: number; out: string }> {
  tty = installFakeTty({ columns: 120, rows: 40, isTTY: false })
  let code = -1
  try {
    await fn()
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code
    else throw e
  }
  const out = stripAnsi(tty.combined())
  tty.restore()
  tty = undefined
  return { code, out }
}

const getArgFor =
  (args: string[]) =>
  (name: string): string | undefined => {
    const i = args.indexOf(name)
    if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1]
    const eq = args.find((a) => a.startsWith(`${name}=`))
    return eq ? eq.slice(name.length + 1) : undefined
  }

/** Jalankan lewat router, seperti cli/index.ts. */
function runDispatch(args: string[]) {
  return runHandler(() => dispatch(args, getArgFor(args), "GLOBAL HELP"))
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "minicode-cli-"))
  mkdirSync(join(tmp, ".minicode"), { recursive: true })
})
afterEach(() => {
  // SQLite (sessions.db) menahan handle beberapa saat di Windows; kegagalan
  // menghapus temp dir bukan kegagalan yang diuji, jadi jangan dilempar.
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {}
})

describe("router: dispatch", () => {
  test("perintah tak dikenal tidak ditangani (return false)", async () => {
    let handled: boolean | undefined
    await runHandler(async () => {
      handled = await dispatch(["bukan-subcommand"], () => undefined, "H")
    })
    expect(handled).toBe(false)
  })

  test("argumen kosong tidak ditangani", async () => {
    let handled: boolean | undefined
    await runHandler(async () => {
      handled = await dispatch([], () => undefined, "H")
    })
    expect(handled).toBe(false)
  })

  test("setiap subcommand terdaftar mengambil alih dan keluar", async () => {
    for (const cmd of ["stats", "sessions", "skills", "config", "mcp", "pricing", "providers"]) {
      const r = await runDispatch([cmd, "--cwd", tmp])
      expect(r.code).toBeGreaterThanOrEqual(0) // handler memanggil exit
    }
  })
})

describe("stats", () => {
  test("workspace tanpa trace: nol dan menyebut lokasi berkas", async () => {
    const r = await runDispatch(["stats", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain("Runs: 0")
    expect(r.out).toContain("no traces yet")
  })

  test("menghitung agregat dari traces.jsonl", async () => {
    const rows = [
      { ok: true, inputTokens: 100, outputTokens: 20, cost: 0.01, durationMs: 1000 },
      { ok: false, inputTokens: 50, outputTokens: 10, cost: 0.02, durationMs: 3000 },
    ]
    writeFileSync(
      join(tmp, ".minicode", "traces.jsonl"),
      rows.map((r) => JSON.stringify(r)).join("\n"),
      "utf8",
    )
    const r = await runDispatch(["stats", "--cwd", tmp])
    expect(r.out).toContain("Runs: 2")
    expect(r.out).toContain("Resolved: 1/2")
    expect(r.out).toContain("in=150")
    expect(r.out).toContain("out=30")
    expect(r.out).toContain("$0.0300")
    expect(r.out).toContain("2000ms")
  })

  test("baris rusak di traces.jsonl tidak membuat crash", async () => {
    writeFileSync(join(tmp, ".minicode", "traces.jsonl"), "{bukan json}\n", "utf8")
    const r = await runDispatch(["stats", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain("Runs: 0")
  })

  test("step-traces.jsonl tampil sebagai baris Tools + --json memuat steps", async () => {
    const rows = [
      { kind: "tool", step: 0, tool: "bash", ok: false, denied: true, sandbox: "none" },
      { kind: "tool", step: 0, tool: "read_file", ok: true, sandbox: "none" },
      { kind: "step", step: 0, tools: 2, errors: 1 },
    ]
    writeFileSync(
      join(tmp, ".minicode", "step-traces.jsonl"),
      rows.map((r) => JSON.stringify(r)).join("\n"),
      "utf8",
    )
    const r = await runDispatch(["stats", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain("Tools: 2")
    expect(r.out).toContain("Denied: 1 (50.0%)")
    expect(r.out).toContain("bash×1")
  })
})

describe("sessions", () => {
  test("list kosong memberi pesan, bukan tabel kosong", async () => {
    const r = await runDispatch(["sessions", "list", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain("no recorded sessions yet")
  })

  test("export tanpa id = salah pakai (exit 2)", async () => {
    const r = await runDispatch(["sessions", "export", "--cwd", tmp])
    expect(r.code).toBe(2)
    expect(r.out).toContain("usage:")
  })

  test("export id tak dikenal = exit 1 dengan pesan jelas", async () => {
    const r = await runDispatch(["sessions", "export", "not-found", "--cwd", tmp])
    expect(r.code).toBe(1)
    expect(r.out).toContain("not found")
  })

  test("unknown subcommand = exit 2 + sessions help", async () => {
    const r = await runDispatch(["sessions", "bogus", "--cwd", tmp])
    expect(r.code).toBe(2)
    expect(r.out).toContain("unknown sessions subcommand")
    expect(r.out).toContain("minicode sessions")
  })

  test("--help = exit 0", async () => {
    const r = await runDispatch(["sessions", "--help", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain("minicode sessions")
  })

  test("list menampilkan sesi yang tersimpan", async () => {
    const { saveSession } = await import("../src/session/persistence.ts")
    await saveSession("sesi-uji", tmp, undefined, [{ role: "user", content: "hai" }], {
      inputTokens: 1,
    })
    const r = await runDispatch(["sessions", "list", "--cwd", tmp])
    expect(r.out).toContain("sesi-uji")
  })

  test("export mengeluarkan JSON yang bisa di-parse", async () => {
    const { saveSession } = await import("../src/session/persistence.ts")
    await saveSession("sesi-json", tmp, undefined, [{ role: "user", content: "hai" }], {})
    const r = await runDispatch(["sessions", "export", "sesi-json", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(() => JSON.parse(r.out)).not.toThrow()
  })

  test("export --jsonl satu baris per pesan", async () => {
    const { saveSession } = await import("../src/session/persistence.ts")
    await saveSession(
      "sesi-jsonl",
      tmp,
      undefined,
      [
        { role: "user", content: "satu" },
        { role: "assistant", content: "dua" },
      ],
      {},
    )
    const r = await runDispatch(["sessions", "export", "sesi-jsonl", "--jsonl", "--cwd", tmp])
    const lines = r.out.split("\n").filter(Boolean)
    expect(lines.length).toBe(2)
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
  })
})

describe("skills", () => {
  const writeSkill = (name: string, desc: string) => {
    const dir = join(tmp, ".minicode", "skills")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${desc}\n---\n\nIsi skill ${name}.\n`,
      "utf8",
    )
  }

  test("tanpa skill memberi petunjuk lokasi berkas", async () => {
    const r = await runDispatch(["skills", "list", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain(".minicode/skills")
  })

  test("list menampilkan skill dalam tabel sejajar", async () => {
    writeSkill("alpha", "skill pertama")
    writeSkill("beta", "skill kedua dengan deskripsi yang jauh lebih panjang dari yang pertama")
    const r = await runDispatch(["skills", "list", "--cwd", tmp])
    const rows = r.out.split("\n").filter((l) => l.includes("/alpha") || l.includes("/beta"))
    expect(rows.length).toBe(2)
    // Batas keras kolom: kedua baris sama lebar meski deskripsi beda panjang.
    expect(new Set(rows.map((l) => l.length)).size).toBe(1)
  })

  test("show menampilkan isi skill", async () => {
    writeSkill("gamma", "skill ketiga")
    const r = await runDispatch(["skills", "show", "gamma", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain("Isi skill gamma")
  })

  test("show tanpa nama = exit 2", async () => {
    const r = await runDispatch(["skills", "show", "--cwd", tmp])
    expect(r.code).toBe(2)
    expect(r.out).toContain("usage:")
  })

  test("show unknown name = exit 1 + points to list", async () => {
    const r = await runDispatch(["skills", "show", "ghost", "--cwd", tmp])
    expect(r.code).toBe(1)
    expect(r.out).toContain("not found")
    expect(r.out).toContain("skills list")
  })

  test("unknown subcommand = exit 2", async () => {
    const r = await runDispatch(["skills", "bogus", "--cwd", tmp])
    expect(r.code).toBe(2)
    expect(r.out).toContain("unknown skills subcommand")
  })
})

describe("config", () => {
  test("tanpa subcommand = help config, exit 0", async () => {
    const r = await runDispatch(["config"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("minicode config")
    // Bukan HELP global yang diteruskan router.
    expect(r.out).not.toContain("GLOBAL HELP")
  })

  test("unknown subcommand = exit 2", async () => {
    const r = await runDispatch(["config", "bogus"])
    expect(r.code).toBe(2)
    expect(r.out).toContain("unknown subcommand")
  })

  test("mcp/lsp tanpa argumen memberi help masing-masing", async () => {
    const mcp = await runDispatch(["config", "mcp"])
    expect(mcp.code).toBe(0)
    expect(mcp.out).toContain("minicode config mcp")

    const lsp = await runDispatch(["config", "lsp"])
    expect(lsp.code).toBe(0)
    expect(lsp.out).toContain("minicode config lsp")
  })

  test("add tanpa kredensial = exit 2 dengan usage", async () => {
    const r = await runDispatch(["config", "add"])
    expect(r.code).toBe(2)
    expect(r.out).toContain("usage:")
  })

  test("remove tanpa id = exit 2", async () => {
    const r = await runDispatch(["config", "remove"])
    expect(r.code).toBe(2)
    expect(r.out).toContain("usage:")
  })

  test("detect tanpa kredensial = exit 2", async () => {
    const r = await runDispatch(["config", "detect"])
    expect(r.code).toBe(2)
    expect(r.out).toContain("usage:")
  })

  test("mcp add menolak URL non-http", async () => {
    const r = await runDispatch(["config", "mcp", "add", "x", "--url", "ftp://contoh.com"])
    expect(r.code).toBe(2)
    expect(r.out.toLowerCase()).toContain("http")
  })

  test("mcp add rejects malformed URL", async () => {
    const r = await runDispatch(["config", "mcp", "add", "x", "--url", "not-a-url"])
    expect(r.code).toBe(2)
    expect(r.out).toContain("Invalid URL")
  })

  test("mcp add tanpa command maupun url = exit 2", async () => {
    const r = await runDispatch(["config", "mcp", "add", "x"])
    expect(r.code).toBe(2)
    expect(r.out).toContain("usage:")
  })

  test("lsp add tanpa command = exit 2", async () => {
    const r = await runDispatch(["config", "lsp", "add", ".ts"])
    expect(r.code).toBe(2)
    expect(r.out).toContain("usage:")
  })
})

describe("mcp", () => {
  test("tanpa subcommand = help mcp, exit 0", async () => {
    const r = await runDispatch(["mcp"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("minicode mcp")
    expect(r.out).not.toContain("GLOBAL HELP")
  })

  test("unknown subcommand = exit 2", async () => {
    const r = await runDispatch(["mcp", "bogus"])
    expect(r.code).toBe(2)
    expect(r.out).toContain("unknown mcp subcommand")
  })
})

describe("pricing", () => {
  test("no args defaults to status", async () => {
    const r = await runDispatch(["pricing"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("Model pricing")
  })

  test("--help memberi daftar subcommand", async () => {
    const r = await runDispatch(["pricing", "--help"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("minicode pricing")
  })

  test("show tanpa model = exit 2", async () => {
    const r = await runDispatch(["pricing", "show"])
    expect(r.code).toBe(2)
    expect(r.out).toContain("usage:")
  })

  test("show model bawaan menampilkan tarif", async () => {
    const r = await runDispatch(["pricing", "show", "gpt-4o-mini"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("input")
    expect(r.out).toContain("output")
  })

  test("show model tak dikenal menjelaskan cost akan N/A", async () => {
    const r = await runDispatch(["pricing", "show", "model-yang-tidak-ada-sama-sekali"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("N/A")
  })

  test("unknown subcommand = exit 2", async () => {
    const r = await runDispatch(["pricing", "bogus"])
    expect(r.code).toBe(2)
    expect(r.out).toContain("unknown pricing subcommand")
  })
})

describe("providers & models", () => {
  const writeConfig = (providers: unknown[]) => {
    writeFileSync(join(tmp, ".minicode", "config.json"), JSON.stringify({ providers }), "utf8")
  }

  test("tanpa provider memberi petunjuk cara menambah", async () => {
    writeConfig([])
    const r = await runDispatch(["providers", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain("config add")
  })

  test("tabel provider sejajar walau id sangat panjang", async () => {
    writeConfig([
      {
        id: "uji-pendek",
        baseUrl: "https://a/v1",
        apiKey: "k",
        models: ["m"],
        providerHint: "openai",
      },
      {
        id: "uji-provider-dengan-id-yang-sangat-panjang-sekali",
        baseUrl: "https://contoh.example.com/v1/endpoint/panjang",
        apiKey: "k",
        models: ["m1", "m2"],
        providerHint: "openai",
      },
    ])
    const r = await runDispatch(["providers", "--allow-local-config", "--cwd", tmp])
    // loadConfig menggabung global + lokal, jadi saring hanya baris milik test.
    const rows = r.out.split("\n").filter((l) => l.includes("uji-"))
    expect(rows.length).toBe(2)
    expect(new Set(rows.map((l) => l.length)).size).toBe(1)
  })

  test("status kesehatan dibaca dari traces.jsonl", async () => {
    writeConfig([
      { id: "p", baseUrl: "https://a/v1", apiKey: "k", models: ["m"], providerHint: "openai" },
    ])
    writeFileSync(
      join(tmp, ".minicode", "traces.jsonl"),
      `${JSON.stringify({ model: "p::m", ok: false, timestamp: new Date().toISOString() })}\n`,
      "utf8",
    )
    const r = await runDispatch(["providers", "--allow-local-config", "--cwd", tmp])
    expect(r.out).toContain("ERR")
  })

  test("models mendaftar model per provider", async () => {
    writeConfig([
      {
        id: "p",
        baseUrl: "https://a/v1",
        apiKey: "k",
        models: ["alpha", "beta"],
        providerHint: "openai",
      },
    ])
    const r = await runDispatch(["models", "--allow-local-config", "--cwd", tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain("alpha")
    expect(r.out).toContain("beta")
  })

  test("models <id> unknown = exit 1", async () => {
    writeConfig([])
    const r = await runDispatch(["models", "ghost", "--cwd", tmp])
    expect(r.code).toBe(1)
    expect(r.out).toContain("not found")
  })

  test("models --match menyaring", async () => {
    writeConfig([
      {
        id: "p",
        baseUrl: "https://a/v1",
        apiKey: "k",
        models: ["alpha", "beta"],
        providerHint: "openai",
      },
    ])
    const r = await runDispatch([
      "models",
      "p",
      "--match",
      "alp",
      "--allow-local-config",
      "--cwd",
      tmp,
    ])
    expect(r.out).toContain("alpha")
    expect(r.out).not.toContain("beta")
  })

  test("models --match with no result shows message", async () => {
    writeConfig([
      { id: "p", baseUrl: "https://a/v1", apiKey: "k", models: ["alpha"], providerHint: "openai" },
    ])
    const r = await runDispatch([
      "models",
      "p",
      "--match",
      "zzz",
      "--allow-local-config",
      "--cwd",
      tmp,
    ])
    expect(r.out).toContain("no matches")
  })
})
