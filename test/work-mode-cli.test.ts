// Kontrak wiring WorkMode (P12 S2.2) — CLI flag/env, exec, dan ACP.
//
// Slice 2 membuktikan: (1) WorkMode dapat dipilih via --work-mode / env dengan
// prioritas flag > env, (2) nilai invalid TIDAK diam-diam melebar (gagal ke
// EXECUTE + warning), (3) WorkMode diteruskan sampai factory session (ACP).
// Default selalu EXECUTE (kompatibilitas). `--plan` (permission mode) TIDAK
// disamakan dengan WorkMode PLAN — diuji sebagai lapisan terpisah.

import { afterEach, describe, expect, test } from "bun:test"
import { getArg as rawGetArg, resolveWorkModeFlag } from "../cli/args.ts"
import { parseRunParams, runAcpSession } from "../cli/commands/acp.ts"

const getFrom = (argv: string[]) => (name: string) => rawGetArg(argv, name)

const OLD_WM = process.env.MINICODE_WORK_MODE
afterEach(() => {
  if (OLD_WM === undefined) delete process.env.MINICODE_WORK_MODE
  else process.env.MINICODE_WORK_MODE = OLD_WM
})

describe("resolveWorkModeFlag — flag vs env vs default", () => {
  test("tanpa flag & tanpa env → EXECUTE (default, tanpa warning)", () => {
    delete process.env.MINICODE_WORK_MODE
    const r = resolveWorkModeFlag(getFrom([]))
    expect(r.workMode).toBe("EXECUTE")
    expect(r.warning).toBeUndefined()
  })

  test("explicit=false saat tak ada sinyal (dasar transparansi resume D-2)", () => {
    delete process.env.MINICODE_WORK_MODE
    expect(resolveWorkModeFlag(getFrom([])).explicit).toBe(false)
  })

  test("explicit=true saat sinyal diberi (sah ATAU invalid)", () => {
    expect(resolveWorkModeFlag(getFrom(["--work-mode", "DISCUSS"])).explicit).toBe(true)
    process.env.MINICODE_WORK_MODE = "PLAN"
    expect(resolveWorkModeFlag(getFrom([])).explicit).toBe(true)
    // invalid pun tetap "eksplisit": operator sudah menyatakan intent, transisi
    // resume tidak boleh menimpa dengan notice "default EXECUTE" menggandakan
    // warning invalid yang sudah dicetak.
    expect(resolveWorkModeFlag(getFrom(["--work-mode", "YOLO"])).explicit).toBe(true)
  })

  test("flag DISCUSS → DISCUSS (mengalahkan env)", () => {
    process.env.MINICODE_WORK_MODE = "PLAN"
    const r = resolveWorkModeFlag(getFrom(["--work-mode", "DISCUSS"]))
    expect(r.workMode).toBe("DISCUSS")
    expect(r.warning).toBeUndefined()
  })

  test("env PLAN (tanpa flag) → PLAN", () => {
    process.env.MINICODE_WORK_MODE = "PLAN"
    const r = resolveWorkModeFlag(getFrom([]))
    expect(r.workMode).toBe("PLAN")
    expect(r.warning).toBeUndefined()
  })

  test("case-insensitive: flag lowercase diterima", () => {
    const r = resolveWorkModeFlag(getFrom(["--work-mode", "plan"]))
    expect(r.workMode).toBe("PLAN")
  })

  test("nilai invalid → EXECUTE + warning (fail-closed, tidak melebar)", () => {
    const r = resolveWorkModeFlag(getFrom(["--work-mode", "YOLO"]))
    expect(r.workMode).toBe("EXECUTE")
    expect(r.warning).toContain("DISCUSS|PLAN|EXECUTE")
  })
})

describe("parseRunParams — kontrak workMode ACP", () => {
  test("tanpa workMode → default EXECUTE", () => {
    const r = parseRunParams({ prompt: "x" })
    if (!r.ok) throw new Error("unexpected")
    expect(r.value.workMode).toBe("EXECUTE")
  })

  test("workMode DISCUSS/PLAN/EXECUTE diterima", () => {
    for (const wm of ["DISCUSS", "PLAN", "EXECUTE"] as const) {
      const r = parseRunParams({ prompt: "x", workMode: wm })
      if (!r.ok) throw new Error("unexpected")
      expect(r.value.workMode).toBe(wm)
    }
  })

  test("workMode invalid → error (bukan diam default)", () => {
    expect(parseRunParams({ prompt: "x", workMode: "yolo" }).ok).toBe(false)
  })

  test("mode tetap permission mode terpisah dari workMode", () => {
    // mode:"plan" (permission) TIDAK mengubah workMode; keduanya independen.
    const r = parseRunParams({ prompt: "x", mode: "plan", workMode: "DISCUSS" })
    if (!r.ok) throw new Error("unexpected")
    expect(r.value.mode).toBe("plan")
    expect(r.value.workMode).toBe("DISCUSS")
  })
})

describe("runAcpSession — workMode diteruskan ke factory session", () => {
  // Pola fakeFactory di test/acp.test.ts: menangkap options yang diteruskan
  // ke createSession untuk membuktikan propagation (bukan hanya field ada).
  const fakeFactory = () => {
    let captured: unknown
    const createSession = (async (options: unknown) => {
      captured = options
      return {
        session: {
          events: { on: () => () => {} },
          state: { stepCount: 1, turnCount: 1 },
        },
        usage: { getSession: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }) },
        modelRef: { current: "fake::m" },
        runPromptWithVerify: async () => {},
        close: async () => {},
      }
    }) as never
    return {
      createSession,
      options: () => captured,
      setAbort: () => {},
      calls: () => 0,
    }
  }
  const depsOf = (f: ReturnType<typeof fakeFactory>, out: string[]) => ({
    write: (l: string) => {
      out.push(l)
    },
    onDone: () => {},
    startFlight: () => f.setAbort(),
    shouldExit: () => false,
    exit: () => {},
    createSession: f.createSession as never,
  })

  test("workMode PLAN diteruskan ke createSession", async () => {
    const f = fakeFactory()
    const out: string[] = []
    await runAcpSession(1, { prompt: "x", workMode: "PLAN" }, depsOf(f, out))
    const opts = f.options() as Record<string, unknown>
    expect(opts.workMode).toBe("PLAN")
    // mode (permission) tetap default auto, tidak ikut berubah jadi plan.
    expect(opts.plan).toBe(false)
  })

  test("tanpa workMode → EXECUTE (kompatibel)", async () => {
    delete process.env.MINICODE_WORK_MODE
    const f = fakeFactory()
    const out: string[] = []
    await runAcpSession(2, { prompt: "x" }, depsOf(f, out))
    const opts = f.options() as Record<string, unknown>
    expect(opts.workMode).toBe("EXECUTE")
    const parsed = JSON.parse(out.at(-1) ?? "{}") as { result?: { workMode?: string } }
    expect(parsed.result?.workMode).toBe("EXECUTE")
  })

  test("Q5=A5: ACP menghormati fallback MINICODE_WORK_MODE dan menggemakan result.workMode", async () => {
    process.env.MINICODE_WORK_MODE = "DISCUSS"
    const f = fakeFactory()
    const out: string[] = []
    const parsedParams = parseRunParams({ prompt: "x" })
    if (!parsedParams.ok) throw new Error("unexpected")
    expect(parsedParams.value.workMode).toBe("DISCUSS")

    await runAcpSession(3, parsedParams.value, depsOf(f, out))
    const opts = f.options() as Record<string, unknown>
    expect(opts.workMode).toBe("DISCUSS")
    const res = JSON.parse(out.at(-1) ?? "{}") as { result?: { workMode?: string } }
    expect(res.result?.workMode).toBe("DISCUSS")
  })
})

describe("Q4=A4 — --verify & self-heal ditolak fail-closed di DISCUSS/PLAN + dilewati saat transisi runtime", () => {
  test("createCliSession menolak verify=true saat WorkMode DISCUSS atau PLAN (termasuk resume sesi DISCUSS)", async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs")
    const { rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { createCliSession } = await import("../cli/setup.ts")
    const { VerifyWorkModeConflictError } = await import("../src/policy/work-mode.ts")
    const { startFakeProvider } = await import("./helpers/fake-provider.ts")

    const cwd = mkdtempSync(join(tmpdir(), "mc-wm-verify-"))
    const home = mkdtempSync(join(tmpdir(), "mc-wm-verify-home-"))
    const savedMinicodeHome = process.env.MINICODE_HOME
    process.env.MINICODE_HOME = home
    const provider = startFakeProvider([{ kind: "text", text: "ok" }])
    mkdirSync(join(cwd, ".minicode"), { recursive: true })
    writeFileSync(
      join(cwd, ".minicode", "config.json"),
      JSON.stringify({
        providers: [{ id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["m"] }],
      }),
      "utf8",
    )
    const base = {
      cwd,
      allowLocalConfig: true,
      sessionId: "",
      prompt: "uji",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      plan: false,
      allowlist: false,
    }
    try {
      for (const wm of ["DISCUSS", "PLAN"] as const) {
        await expect(
          createCliSession({ ...base, verify: true, workMode: wm, workModeExplicit: true }),
        ).rejects.toBeInstanceOf(VerifyWorkModeConflictError)
      }

      // Simpan sesi DISCUSS, lalu coba --resume dengan --verify tanpa override ke EXECUTE → harus fail-closed!
      const saved = await createCliSession({
        ...base,
        sessionId: "verify-disc-src",
        verify: false,
        workMode: "DISCUSS",
        workModeExplicit: true,
      })
      await saved.persistCurrent({})
      await saved.close()

      await expect(
        createCliSession({
          ...base,
          sessionId: "verify-disc-dst",
          resumeId: "verify-disc-src",
          verify: true,
          workMode: "EXECUTE",
          workModeExplicit: false,
        }),
      ).rejects.toBeInstanceOf(VerifyWorkModeConflictError)
    } finally {
      provider.close()
      if (savedMinicodeHome === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = savedMinicodeHome
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("transisi runtime EXECUTE → PLAN pada sesi --verify melewati eksekusi verify + memberi peringatan", async () => {
    const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs")
    const { rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { createCliSession } = await import("../cli/setup.ts")
    const { startFakeProvider } = await import("./helpers/fake-provider.ts")

    const cwd = mkdtempSync(join(tmpdir(), "mc-wm-verify-rt-"))
    const home = mkdtempSync(join(tmpdir(), "mc-wm-verify-rthome-"))
    const savedMinicodeHome = process.env.MINICODE_HOME
    process.env.MINICODE_HOME = home
    const marker = join(cwd, "verify-ran.txt")
    const provider = startFakeProvider([{ kind: "text", text: "rencana siap" }])
    mkdirSync(join(cwd, ".minicode"), { recursive: true })
    writeFileSync(
      join(cwd, ".minicode", "config.json"),
      JSON.stringify({
        providers: [{ id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["m"] }],
      }),
      "utf8",
    )
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "probe-verify",
        scripts: {
          test: `bun -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`,
        },
      }),
      "utf8",
    )
    const stderrChunks: string[] = []
    const origErr = process.stderr.write.bind(process.stderr)
    let ctx: Awaited<ReturnType<typeof createCliSession>> | undefined
    try {
      ctx = await createCliSession({
        cwd,
        allowLocalConfig: true,
        sessionId: "verify-rt",
        prompt: "awal",
        enterRepl: false,
        verbose: false,
        allowAll: false,
        ask: false,
        plan: false,
        allowlist: false,
        verify: true,
        workMode: "EXECUTE",
        workModeExplicit: true,
      })
      ctx.workModeControl!.setWorkMode("PLAN")
      process.stderr.write = ((c: unknown) => {
        stderrChunks.push(String(c))
        return true
      }) as typeof process.stderr.write
      await ctx.runPromptWithVerify("buat rencana")
      expect(existsSync(marker)).toBe(false)
      expect(stderrChunks.join("")).toContain("[warn] verify skipped in work-mode PLAN")
    } finally {
      process.stderr.write = origErr
      if (ctx) await ctx.close().catch(() => {})
      provider.close()
      if (savedMinicodeHome === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = savedMinicodeHome
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("subproses CLI `exec --json --verify --work-mode PLAN` keluar kode 2 dengan USER_ERROR; flag setelah prompt diperingatkan", async () => {
    const { mkdtempSync } = await import("node:fs")
    const { rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const repoRoot = join(import.meta.dir, "..")
    const cliEntry = join(repoRoot, "cli", "index.ts")
    const cwd = mkdtempSync(join(tmpdir(), "mc-wm-exec-sub-"))
    const home = mkdtempSync(join(tmpdir(), "mc-wm-exec-home-"))
    try {
      // 1) --verify + --work-mode PLAN → exit 2 + JSON USER_ERROR.
      const p1 = Bun.spawn(
        [process.execPath, cliEntry, "exec", "--json", "--verify", "--work-mode", "PLAN", "uji"],
        {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: home, USERPROFILE: home, MINICODE_HOME: home },
        },
      )
      const [out1, , code1] = await Promise.all([
        new Response(p1.stdout).text(),
        new Response(p1.stderr).text(),
        p1.exited,
      ])
      expect(code1).toBe(2)
      const j1 = JSON.parse(out1.trim()) as {
        ok?: boolean
        error?: { category?: string; message?: string }
        workMode?: string
      }
      expect(j1.ok).toBe(false)
      expect(j1.error?.category).toBe("USER_ERROR")
      expect(j1.workMode).toBe("PLAN")

      // 2) `exec` menempatkan `--work-mode DISCUSS` SETELAH prompt → warning eksplisit di stderr (Invariant #6).
      const p2 = Bun.spawn(
        [
          process.execPath,
          cliEntry,
          "exec",
          "--json",
          "--verify",
          "uji prompt",
          "--work-mode",
          "DISCUSS",
        ],
        {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            MINICODE_HOME: home,
            MINICODE_WORK_MODE: "PLAN",
          },
        },
      )
      const [, err2, code2] = await Promise.all([
        new Response(p2.stdout).text(),
        new Response(p2.stderr).text(),
        p2.exited,
      ])
      expect(code2).toBe(2)
      expect(err2).toContain("[warn] ignored flag(s) after the prompt: --work-mode")
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe("Q5=A5 — daemon hosted runtime meneruskan WorkMode & melaporkan workMode di session.list", () => {
  test("startDaemonHostedRuntime menerima --work-mode DISCUSS dan session.list memuat workMode", async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs")
    const { rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { startDaemonHostedRuntime } = await import("../cli/commands/daemon.ts")
    const { issueCapabilityFromEndpoint } = await import("../src/daemon/capability.ts")
    const { DaemonClient } = await import("../src/daemon/client.ts")
    const { readEndpoint } = await import("../src/daemon/discovery.ts")
    const { VerifyWorkModeConflictError } = await import("../src/policy/work-mode.ts")
    const { startFakeProvider } = await import("./helpers/fake-provider.ts")

    const subGetArgFrom = (argv: string[]) => (name: string) => {
      const i = argv.indexOf(name)
      if (i === -1) return undefined
      const v = argv[i + 1]
      return v && !v.startsWith("-") ? v : undefined
    }

    const cwd = mkdtempSync(join(tmpdir(), "mc-wm-daemon-"))
    const home = mkdtempSync(join(tmpdir(), "mc-wm-daemon-home-"))
    const savedMinicodeHome = process.env.MINICODE_HOME
    const savedHome = process.env.HOME
    const savedUserProfile = process.env.USERPROFILE
    process.env.MINICODE_HOME = home
    process.env.HOME = home
    process.env.USERPROFILE = home
    const provider = startFakeProvider([{ kind: "text", text: "ok" }])
    mkdirSync(join(cwd, ".minicode"), { recursive: true })
    mkdirSync(join(home, ".minicode"), { recursive: true })
    writeFileSync(
      join(home, ".minicode", "config.json"),
      JSON.stringify({
        providers: [{ id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["m"] }],
      }),
      "utf8",
    )

    try {
      // 1) --verify + --work-mode DISCUSS pada daemon ditolak fail-closed tanpa meninggalkan zombie host.
      const badArgs = [
        "start",
        "--cwd",
        cwd,
        "--prompt",
        "hi",
        "--verify",
        "--work-mode",
        "DISCUSS",
      ]
      await expect(
        startDaemonHostedRuntime({
          sub: badArgs,
          getArg: subGetArgFrom(badArgs),
          cwd,
        }),
      ).rejects.toBeInstanceOf(VerifyWorkModeConflictError)

      // 2) --work-mode DISCUSS dengan --prompt membangun sesi hosted DISCUSS + terlihat di session.list.
      const okArgs = ["start", "--cwd", cwd, "--prompt", "hi", "--work-mode", "DISCUSS"]
      const started = await startDaemonHostedRuntime({
        sub: okArgs,
        getArg: subGetArgFrom(okArgs),
        cwd,
      })
      try {
        expect(started.workMode).toBe("DISCUSS")
        expect(started.session?.workMode).toBe("DISCUSS")
        const ep = readEndpoint(cwd)
        expect(ep).not.toBeNull()
        const cap = issueCapabilityFromEndpoint(ep!, { scopes: ["read:session"], who: "test" })
        const client = await DaemonClient.connect({
          target: { host: ep!.host, port: ep!.port },
          capability: cap,
          consumer: "test",
        })
        try {
          const res = await client.control("session.list", {}, "wm-list-1")
          expect(res.ok).toBe(true)
          const rows = res.result as Array<{ sid: string; workMode?: string }>
          expect(rows).toHaveLength(1)
          expect(rows[0]?.workMode).toBe("DISCUSS")
        } finally {
          client.close()
        }
      } finally {
        await started.host.shutdown("test-done")
      }
    } finally {
      provider.close()
      if (savedMinicodeHome === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = savedMinicodeHome
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      if (savedUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = savedUserProfile
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
      await rm(home, { recursive: true, force: true }).catch(() => {})
    }
  })
})
