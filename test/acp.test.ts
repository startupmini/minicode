import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AcpLoop,
  acpErr,
  acpOk,
  createFlight,
  dispatchAcpLine,
  parseAcpLine,
  parseRunParams,
  runAcpSession,
} from "../cli/commands/acp.ts"

// Fase 5: server JSON-RPC stdio minimal untuk IDE (subset, bukan ACP penuh).

describe("acp: parseAcpLine", () => {
  test("baris kosong/null → null", () => {
    expect(parseAcpLine("")).toBeNull()
    expect(parseAcpLine("   \n")).toBeNull()
  })
  test("bukan JSON / tanpa method → null (stream mesin tetap bersih)", () => {
    expect(parseAcpLine("{bukan json")).toBeNull()
    expect(parseAcpLine('{"id":1}')).toBeNull()
    expect(parseAcpLine("[1,2]")).toBeNull()
  })
  test("request valid lolos", () => {
    const r = parseAcpLine('{"id":2,"method":"run","params":{"prompt":"hi"}}')
    expect(r?.id).toBe(2)
    expect(r?.method).toBe("run")
  })
})

describe("acp: framing respons", () => {
  test("acpOk/acpErr satu baris JSON dengan id", () => {
    const ok = JSON.parse(acpOk(3, { ok: true }))
    expect(ok.id).toBe(3)
    expect(ok.result).toMatchObject({ ok: true })
    const err = JSON.parse(acpErr(3, "gagal"))
    expect(err.error.message).toBe("gagal")
  })
})

describe("acp: parseRunParams", () => {
  test("prompt wajib", () => {
    expect(parseRunParams(null).ok).toBe(false)
    expect(parseRunParams({}).ok).toBe(false)
    expect(parseRunParams({ prompt: "  " }).ok).toBe(false)
    const good = parseRunParams({ prompt: "fix it" })
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.value.mode).toBe("auto")
  })
  test("angka harus positif; mode hanya auto/plan", () => {
    expect(parseRunParams({ prompt: "x", maxSteps: 0 }).ok).toBe(false)
    expect(parseRunParams({ prompt: "x", maxSteps: -1 }).ok).toBe(false)
    expect(parseRunParams({ prompt: "x", timeoutMs: NaN }).ok).toBe(false)
    expect(parseRunParams({ prompt: "x", mode: "yolo" }).ok).toBe(false)
    const plan = parseRunParams({ prompt: "x", mode: "plan", maxSteps: 10.9, budget: 0 })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.value.mode).toBe("plan")
      expect(plan.value.maxSteps).toBe(10) // floor, bukan tolak
      expect(plan.value.budget).toBe(0)
    }
  })
})

describe("acp: dispatchAcpLine (loop tanpa stdio)", () => {
  const fakeLoop = (
    over: Partial<AcpLoop> = {},
  ): { loop: AcpLoop; out: string[]; calls: string[] } => {
    const out: string[] = []
    const calls: string[] = []
    const loop: AcpLoop = {
      write: (l) => {
        out.push(l)
      },
      runOne: async () => {
        calls.push("runOne")
      },
      flightActive: () => false,
      cancelFlight: () => false,
      isShuttingDown: () => false,
      beginShutdown: () => {
        calls.push("beginShutdown")
      },
      exit: (c) => {
        calls.push(`exit:${c}`)
      },
      warnMalformed: () => {
        calls.push("warnMalformed")
      },
      ...over,
    }
    return { loop, out, calls }
  }
  const first = (out: string[]): Record<string, unknown> => JSON.parse(out[0]!)

  test("initialize → capabilities", async () => {
    const t = fakeLoop()
    await dispatchAcpLine('{"id":1,"method":"initialize"}', t.loop)
    expect(first(t.out).id).toBe(1)
    expect((first(t.out).result as { server: string }).server).toBe("minicode-acp")
  })
  test("run → delegasi; sibuk/dimati-ditolak", async () => {
    const t = fakeLoop()
    await dispatchAcpLine('{"id":2,"method":"run","params":{"prompt":"x"}}', t.loop)
    expect(t.calls).toEqual(["runOne"])
    const busy = fakeLoop({ flightActive: () => true })
    await dispatchAcpLine('{"id":3,"method":"run","params":{"prompt":"x"}}', busy.loop)
    expect(busy.calls).toEqual([])
    expect((first(busy.out).error as { message: string }).message).toContain("in flight")
    const down = fakeLoop({ isShuttingDown: () => true })
    await dispatchAcpLine('{"id":4,"method":"run","params":{"prompt":"x"}}', down.loop)
    expect((first(down.out).error as { message: string }).message).toContain("shutting down")
  })
  test("cancel true/false; shutdown idle/busy; unknown; rusak", async () => {
    const t = fakeLoop({ cancelFlight: () => true })
    await dispatchAcpLine('{"id":5,"method":"cancel"}', t.loop)
    expect((first(t.out).result as { cancelled: boolean }).cancelled).toBe(true)
    const idle = fakeLoop()
    await dispatchAcpLine('{"id":6,"method":"shutdown"}', idle.loop)
    expect(idle.calls).toEqual(["beginShutdown", "exit:0"])
    const busy = fakeLoop({ flightActive: () => true, cancelFlight: () => true })
    await dispatchAcpLine('{"id":7,"method":"shutdown"}', busy.loop)
    // Sibuk: stop + respons, TANPA exit (exit terjadi di finally sesi).
    expect(busy.calls).toEqual(["beginShutdown"])
    expect((first(busy.out).result as { shuttingDown: boolean }).shuttingDown).toBe(true)
    const unk = fakeLoop()
    await dispatchAcpLine('{"id":8,"method":"bogus"}', unk.loop)
    expect((first(unk.out).error as { message: string }).message).toContain("unknown method")
    const bad = fakeLoop()
    await dispatchAcpLine("{rusak", bad.loop)
    expect(bad.calls).toEqual(["warnMalformed"])
    expect(bad.out).toEqual([])
    const empty = fakeLoop()
    await dispatchAcpLine("   ", empty.loop)
    expect(empty.calls).toEqual([])
  })
})

describe("acp: runAcpSession (sesi injeksi, tanpa provider)", () => {
  interface FakeOpts {
    tokens?: { inputTokens: number; outputTokens: number; totalTokens: number; cost?: number }
    fail?: string
    emitText?: string
    emitTool?: string
    abortMidRun?: boolean
  }
  const fakeFactory = (opts: FakeOpts = {}) => {
    const handlers: ((ev: unknown) => void)[] = []
    let factoryCalls = 0
    let factoryOptions: unknown
    const usageTokens = opts.tokens ?? { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    const createSession = (async (options: unknown) => {
      factoryCalls++
      factoryOptions = options
      return {
        session: {
          events: {
            on: (_t: string, fn: (ev: unknown) => void) => {
              handlers.push(fn)
              return () => {}
            },
          },
          state: { stepCount: 3, turnCount: 1 },
        },
        usage: { getSession: () => ({ ...usageTokens }) },
        modelRef: { current: "fake::m" },
        runPromptWithVerify: async (_p: string, signal?: AbortSignal) => {
          if (opts.abortMidRun) abortNow?.()
          if (signal?.aborted) throw new Error("aborted by test")
          if (opts.fail) throw new Error(opts.fail)
          for (const h of handlers) {
            if (opts.emitTool)
              h({ type: "execution:started", execution: { call: { name: opts.emitTool } } })
            if (opts.emitText) h({ type: "provider:text", text: opts.emitText })
          }
        },
        close: async () => {},
      }
    }) as never
    let abortNow: (() => void) | null = null
    return {
      createSession,
      calls: () => factoryCalls,
      options: () => factoryOptions,
      setAbort: (f: () => void) => (abortNow = f),
    }
  }
  const depsOf = (
    f: ReturnType<typeof fakeFactory>,
    out: string[],
    over: { shouldExit?: boolean; exited?: number[] } = {},
  ) => ({
    write: (l: string) => {
      out.push(l)
    },
    onDone: () => {},
    startFlight: (a: () => void) => f.setAbort(a),
    shouldExit: () => over.shouldExit ?? false,
    exit: (c: number) => {
      over.exited?.push(c)
    },
    createSession: f.createSession as never,
  })

  test("sukses: hasil ok + notifikasi text/tool + token", async () => {
    // Gagal di kode lama: runAcpSession tak ada (hanya spawn yang menutupinya,
    // dan coverage spawn tak dihitung gate).
    const f = fakeFactory({ emitText: "halo dunia", emitTool: "read_file" })
    const out: string[] = []
    await runAcpSession(11, { prompt: "kerjakan" }, depsOf(f, out))
    const notes = out.map((l) => JSON.parse(l))
    const byType = (t: string): Record<string, unknown> => notes.find((n) => n.type === t) ?? {}
    expect(f.options()).toMatchObject({ machineOutput: true })
    expect(byType("text")).toMatchObject({ type: "text", delta: "halo dunia" })
    expect(byType("tool")).toMatchObject({ type: "tool", name: "read_file" })
    const res = notes[notes.length - 1] as { id: number; result: Record<string, unknown> }
    expect(res.id).toBe(11)
    expect(res.result).toMatchObject({ ok: true, tokens: 15, steps: 3, turns: 1 })
    expect(res.result.text).toContain("halo dunia")
  })
  test("budget over + cost unknown → error (bukan ok)", async () => {
    const over = fakeFactory({
      tokens: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 5 },
    })
    const out1: string[] = []
    await runAcpSession(12, { prompt: "x", budget: 1 }, depsOf(over, out1))
    expect(
      (JSON.parse(out1[out1.length - 1]!) as { error: { message: string } }).error.message,
    ).toContain("over budget")
    const unknown = fakeFactory({ tokens: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
    const out2: string[] = []
    await runAcpSession(13, { prompt: "x", budget: 1 }, depsOf(unknown, out2))
    expect(
      (JSON.parse(out2[out2.length - 1]!) as { error: { message: string } }).error.message,
    ).toContain("unknown")
  })
  test("run melempar → error; params invalid → factory tak dipanggil", async () => {
    const f = fakeFactory({ fail: "model meledak" })
    const out: string[] = []
    await runAcpSession(14, { prompt: "x" }, depsOf(f, out))
    expect(
      (JSON.parse(out[out.length - 1]!) as { error: { message: string } }).error.message,
    ).toContain("model meledak")
    const f2 = fakeFactory()
    const out2: string[] = []
    await runAcpSession(15, { prompt: "  " }, depsOf(f2, out2))
    expect(f2.calls()).toBe(0)
    expect((JSON.parse(out2[0]!) as { error: object }).error).toBeTruthy()
  })
  test("abort mid-run → 'run cancelled'; shouldExit → exit(0)", async () => {
    const f = fakeFactory({ abortMidRun: true })
    const out: string[] = []
    const exited: number[] = []
    await runAcpSession(16, { prompt: "x" }, depsOf(f, out, { shouldExit: true, exited }))
    expect((JSON.parse(out[out.length - 1]!) as { error: { message: string } }).error.message).toBe(
      "run cancelled",
    )
    expect(exited).toEqual([0])
  })

  test("cancel menyela run yang berjalan (produksi: dispatch tanpa await)", async () => {
    // Regresi bug nyata: loop for-await sekuensial membuat cancel tak pernah
    // terbaca saat run berjalan. Gagal di kode lama: run selesai normal
    // (cancel antre di stdin) alih-alih "run cancelled".
    const flight = createFlight()
    const out: string[] = []
    const handlers: ((ev: unknown) => void)[] = []
    const blockingFactory = (async () => ({
      session: {
        events: {
          on: (_t: string, fn: (ev: unknown) => void) => {
            handlers.push(fn)
            return () => {}
          },
        },
        state: { stepCount: 0, turnCount: 0 },
      },
      usage: { getSession: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }) },
      modelRef: { current: "fake::m" },
      runPromptWithVerify: async (_p: string, signal?: AbortSignal) => {
        // Blokir sampai di-abort (seperti LLM lambat); pengaman 5 dtk agar
        // suite tak gantung bila wiring cancel rusak.
        await new Promise<void>((_, rej) => {
          signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true })
          setTimeout(() => rej(new Error("never aborted")), 5000)
        })
      },
      close: async () => {},
    })) as never
    const loop: AcpLoop = {
      write: (l) => {
        out.push(l)
      },
      runOne: (id, params) =>
        runAcpSession(id, params, {
          write: (l) => {
            out.push(l)
          },
          onDone: () => flight.clear(),
          startFlight: (a) => flight.start(a),
          shouldExit: () => false,
          exit: () => {},
          createSession: blockingFactory,
        }),
      flightActive: () => flight.active(),
      cancelFlight: () => flight.stop(),
      isShuttingDown: () => false,
      beginShutdown: () => {},
      exit: () => {},
      warnMalformed: () => {},
    }
    // Tiru server event-driven: run didispatch TANPA await, cancel menyusul.
    const running = dispatchAcpLine('{"id":21,"method":"run","params":{"prompt":"lama"}}', loop)
    await new Promise((r) => setTimeout(r, 50)) // beri jalan run mencapai flight
    expect(flight.active()).toBe(true)
    await dispatchAcpLine('{"id":22,"method":"cancel"}', loop)
    await running
    const byId = (id: number): Record<string, unknown> =>
      JSON.parse(out.find((l) => (JSON.parse(l) as { id: number }).id === id)!)
    expect((byId(22).result as { cancelled: boolean }).cancelled).toBe(true)
    expect((byId(21).error as { message: string }).message).toBe("run cancelled")
  })
})

const HERMETIC_ENV = {
  ...process.env,
  OPENAI_API_KEY: undefined,
  AGENT_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
  TOKENHARBOR_API_KEY: undefined,
  TH_API_KEY: undefined,
}

describe("acp: smoke initialize→shutdown via stdio", () => {
  test("server menjawab capabilities lalu keluar 0 (tanpa provider)", async () => {
    // Hermetic: initialize tak menyentuh provider/config/jaringan.
    const proc = Bun.spawn(["bun", "cli/index.ts", "acp"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
      env: HERMETIC_ENV,
    })
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const lines: string[] = []
    let buf = ""
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += new TextDecoder().decode(value)
        const parts = buf.split("\n")
        buf = parts.pop() ?? ""
        for (const p of parts) if (p.trim()) lines.push(p)
      }
    })()
    const waitFor = async (n: number): Promise<void> => {
      // Tunggu respons ke-n (maks 60 dtk — transpile TS pertama lambat).
      const t0 = Date.now()
      while (lines.length < n && Date.now() - t0 < 60000) {
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    proc.stdin.write('{"id":1,"method":"initialize","params":{"client":"test"}}\n')
    await waitFor(1)
    expect(lines.length).toBeGreaterThan(0)
    const hello = JSON.parse(lines[0]!) as { id: number; result: { server: string } }
    expect(hello.id).toBe(1)
    expect(hello.result.server).toBe("minicode-acp")
    proc.stdin.write('{"id":2,"method":"shutdown"}\n')
    proc.stdin.end()
    const code = await proc.exited
    await pump
    expect(code).toBe(0)
  }, 90000)

  test("run tanpa provider → error JSON (bukan crash); method asing ditolak", async () => {
    // MINICODE_HOME kosong = tanpa provider/config → NoProviderError hermetic.
    const home = await mkdtemp(join(tmpdir(), "minicode-acp-"))
    try {
      const proc = Bun.spawn(["bun", "cli/index.ts", "acp"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: process.cwd(),
        env: { ...HERMETIC_ENV, MINICODE_HOME: home },
      })
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
      const lines: string[] = []
      let buf = ""
      const pump = (async () => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += new TextDecoder().decode(value)
          const parts = buf.split("\n")
          buf = parts.pop() ?? ""
          for (const p of parts) if (p.trim()) lines.push(p)
        }
      })()
      const waitFor = async (n: number): Promise<void> => {
        const t0 = Date.now()
        while (lines.length < n && Date.now() - t0 < 90000) {
          await new Promise((r) => setTimeout(r, 200))
        }
      }
      proc.stdin.write("{bukan json}\n") // diabaikan, stream tetap bersih
      proc.stdin.write('{"id":7,"method":"bogus"}\n')
      await waitFor(1)
      const unknown = JSON.parse(lines[0]!) as { id: number; error: { message: string } }
      expect(unknown.id).toBe(7)
      expect(unknown.error.message).toContain("unknown method")
      proc.stdin.write(
        '{"id":8,"method":"run","params":{"prompt":"halo","maxSteps":1,"timeoutMs":60000}}\n',
      )
      await waitFor(2)
      const failed = JSON.parse(lines[1]!) as { id: number; error: { message: string } }
      expect(failed.id).toBe(8)
      expect(typeof failed.error.message).toBe("string")
      expect(failed.error.message.length).toBeGreaterThan(0)
      proc.stdin.write('{"id":9,"method":"shutdown"}\n')
      proc.stdin.end()
      expect(await proc.exited).toBe(0)
      await pump
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120000)

  test("tulis TERTUNDA setelah startup tetap dilayani (tanpa fallthrough one-shot)", async () => {
    // Regresi bug nyata: handleAcp event-driven return sinkron → dispatch
    // selesai → index.ts membuat sesi one-shot "acp" (NoProviderError, exit 1)
    // yang berlomba dengan stdin. Gagal di kode lama: proses sudah mati
    // sebelum tulis tertunda (exitCode !== null, tulis EPIPE/tanpa respons).
    const home = await mkdtemp(join(tmpdir(), "minicode-acp-"))
    try {
      const proc = Bun.spawn(["bun", "cli/index.ts", "acp"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: process.cwd(),
        env: { ...HERMETIC_ENV, MINICODE_HOME: home },
      })
      // Tunggu startup SELESAI total (transpile + wiring) — server yang benar
      // menunggu selamanya; yang buggy sudah exit 1 via one-shot.
      await new Promise((r) => setTimeout(r, 15000))
      expect(proc.exitCode).toBeNull()
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
      const lines: string[] = []
      let buf = ""
      const pump = (async () => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += new TextDecoder().decode(value)
          const parts = buf.split("\n")
          buf = parts.pop() ?? ""
          for (const p of parts) if (p.trim()) lines.push(p)
        }
      })()
      proc.stdin.write('{"id":31,"method":"bogus"}\n')
      const t0 = Date.now()
      while (lines.length < 1 && Date.now() - t0 < 30000) {
        await new Promise((r) => setTimeout(r, 200))
      }
      expect(lines.length).toBeGreaterThan(0)
      const resp = JSON.parse(lines[0]!) as { id: number; error: { message: string } }
      expect(resp.id).toBe(31)
      expect(resp.error.message).toContain("unknown method")
      proc.stdin.write('{"id":32,"method":"shutdown"}\n')
      proc.stdin.end()
      expect(await proc.exited).toBe(0)
      await pump
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120000)
})
