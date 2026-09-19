// Test driver REPL TUI (cli/repl-tui.ts) — loop + dispatch + suspend + exit,
// lewat fake TTY + fake ctx (pola repl-linear.test.ts). Turn agen memakai
// runPromptWithVerify stub (tanpa provider): pemetaan transkrip diuji di
// tui-writers.test.ts, suspend di tui-suspend.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runTuiRepl } from "../cli/repl-tui.ts"
import type { CliSession } from "../cli/setup.ts"
import { setUiWriters } from "../src/ui/assistant/simple.ts"
import { setCompactMode } from "../src/ui/render/detail.ts"
import { setReasoningVisible } from "../src/ui/render/reasoning.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { setTuiSessionUi } from "../src/ui/tui/session.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

class ExitSentinel extends Error {
  code: number | undefined
  constructor(code?: number) {
    super("exit")
    this.code = code
  }
}

let tty: FakeTty | undefined
let origExit: typeof process.exit

beforeEach(() => {
  origExit = process.exit
  process.exit = ((code?: number) => {
    throw new ExitSentinel(code)
  }) as never
})

afterEach(() => {
  process.exit = origExit
  setUiWriters(null)
  setTuiSessionUi(null)
  tty?.restore()
  tty = undefined
  setCompactMode(false)
  setReasoningVisible(false)
  delete process.env.MINICODE_MINIMIZE_TOOL
  delete process.env.MINICODE_MINIMIZE_ANSWER
})

interface Harness {
  ctx: CliSession
  ran: string[]
  closed: boolean
}

function makeHarness(): Harness {
  const h: Harness = { ctx: undefined as unknown as CliSession, ran: [], closed: false }
  const usageRow = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }
  const ctx = {
    session: {
      events: createFakeBus(),
      state: { history: [], turnCount: 0, stepCount: 0 },
      contextTokens: 1024,
    },
    cfg: { providers: [{ id: "prov", providerHint: "openai", models: ["m1"] }] },
    cwd: process.cwd(),
    sessionId: "sess-1",
    modelRef: { current: "prov::m1" },
    effectiveInitialModel: "prov::m1",
    effectiveTimeoutMs: 1000,
    permissionMode: "auto",
    sessionTools: [],
    allLoadedSkills: [],
    usage: {
      get: () => usageRow,
      getSession: () => usageRow,
      reset: () => {},
      modelUsed: () => ({}),
    },
    budget: undefined,
    budgetStrict: false,
    detachSimple: () => {},
    persistCurrent: async () => {},
    runPromptWithVerify: async (prompt: string) => {
      h.ran.push(prompt)
    },
    permissions: {
      getMode: () => "auto",
      setMode: () => {},
    },
    close: async () => {
      h.closed = true
    },
  }
  h.ctx = ctx as unknown as CliSession
  return h
}

const visible = (): string => stripAnsi(tty!.combined())

// Tunggu pompa box TUI (stdin data-listener saat raw mode) stabil.
async function waitForPump(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let stable = 0
  for (;;) {
    if (tty!.promptListeners() >= 1) {
      stable++
      if (stable >= 3) return
    } else {
      stable = 0
    }
    if (Date.now() > deadline) throw new Error("TUI tidak kembali ke prompt")
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function typeLine(line: string): Promise<void> {
  await waitForPump()
  await tty!.send(`${line}\r`, 25)
}

function start(h: Harness): Promise<void> {
  const p = runTuiRepl(h.ctx)
  p.catch(() => {})
  return p
}

describe("REPL TUI: siklus dasar", () => {
  test("masuk alt-screen; prompt menjalankan turn; /exit keluar + info sesi", async () => {
    tty = installFakeTty({ rows: 30, columns: 100 })
    const h = makeHarness()
    const p = start(h)
    await typeLine("halo")
    expect(h.ran).toEqual(["halo"])
    // Jejak shell: prompt yang di-submit tinggal di transkrip seperti PS>
    expect(visible()).toContain("halo")
    // ?1049h adalah sekuens ANSI: asersi di byte mentah (stripAnsi
    // menghapusnya sehingga tak terlihat di `visible()`).
    expect(tty!.all()).toContain("\x1b[?1049h")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    expect(h.closed).toBe(true)
    const done = visible()
    // Tinggalkan alt-screen + info sesi (bukan dump transkrip).
    expect(tty!.all()).toContain("\x1b[?1049l")
    expect(done).toContain("sess-1")
    expect(done).toContain("lanjut: minicode --resume sess-1")
  })

  test("slash asing: did-you-mean masuk dokumen (tanpa capture/suspend)", async () => {
    tty = installFakeTty({ rows: 30, columns: 100 })
    const h = makeHarness()
    const p = start(h)
    await typeLine("/xyzabc")
    expect(visible()).toContain("Unknown command")
    // Pesan murni printOut (dokumen langsung): tanpa leave, tanpa capture.
    const out = tty!.all()
    expect(out.split("\x1b[?1049h").length - 1).toBe(1)
    expect(out).not.toContain("\x1b[?1049l")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("slash builtin: capture ke dokumen (tanpa leave alt-screen)", async () => {
    tty = installFakeTty({ rows: 30, columns: 100 })
    const h = makeHarness()
    const p = start(h)
    await typeLine("/help")
    const out = visible()
    // /help dicetak ke dokumen via capture (bukan buffer utama, bukan suspend).
    expect(out).toContain("Show commands")
    const raw = tty!.all()
    expect(raw.split("\x1b[?1049h").length - 1).toBe(1)
    expect(raw).not.toContain("\x1b[?1049l")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    expect(h.closed).toBe(true)
  })

  test("Ctrl+C sekali idle = copy, dua kali = keluar", async () => {
    tty = installFakeTty({ rows: 30, columns: 100 })
    const h = makeHarness()
    const p = start(h)
    await waitForPump()
    await tty!.send("\x03", 25)
    const out = visible()
    // Buffer turn kosong di harness (tanpa turn nyata): jujur atau copy.
    expect(out.includes("nothing to copy") || out.includes("copied ")).toBe(true)
    await tty!.send("\x03", 25)
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })
})

describe("REPL TUI: paritas perintah inti (port repl-linear)", () => {
  test("/sessoons menyarankan /sessions; /thinking toggle; /expand jujur", async () => {
    tty = installFakeTty({ rows: 30, columns: 100 })
    const h = makeHarness()
    const p = start(h)
    await typeLine("/sessoons")
    expect(visible()).toContain("Did you mean /sessions?")
    await typeLine("/thinking on")
    expect(visible()).toContain("thinking: expanded")
    await typeLine("/thinking")
    expect(visible()).toContain("thinking: minimized")
    await typeLine("/expand")
    expect(visible()).toContain("nothing to expand")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("/minimize, slash sendirian, default minimize", async () => {
    tty = installFakeTty({ rows: 30, columns: 100 })
    const h = makeHarness()
    const p = start(h)
    await waitForPump()
    expect(process.env.MINICODE_MINIMIZE_TOOL).toBe("1")
    expect(process.env.MINICODE_MINIMIZE_ANSWER).toBeUndefined()
    await typeLine("/")
    expect(visible()).toContain("Commands:")
    expect(visible()).not.toContain("Unknown command")
    await typeLine("/minimize")
    expect(visible()).toContain("sections: minimized")
    await typeLine("/minimize bogus")
    expect(visible()).toContain("usage: /minimize")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })
})
