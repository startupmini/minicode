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
    const f = fakeFactory()
    const out: string[] = []
    await runAcpSession(2, { prompt: "x" }, depsOf(f, out))
    const opts = f.options() as Record<string, unknown>
    expect(opts.workMode).toBe("EXECUTE")
  })
})
