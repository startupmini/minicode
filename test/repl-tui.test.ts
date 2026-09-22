// Test driver REPL TUI (cli/repl-tui.ts) — loop + dispatch + suspend + exit,
// lewat fake TTY + fake ctx (pola repl-linear.test.ts). Turn agen memakai
// runPromptWithVerify stub (tanpa provider): pemetaan transkrip diuji di
// tui-writers.test.ts, suspend di tui-suspend.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runTuiRepl } from "../cli/repl-tui.ts"
import type { CliSession } from "../cli/setup.ts"
import { setUiWriters } from "../src/ui/assistant/simple.ts"
import { setCompactMode } from "../src/ui/render/detail.ts"
import { setReasoningVisible } from "../src/ui/render/reasoning.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { setTuiSessionUi } from "../src/ui/tui/session.ts"
import { createGridEmulator } from "./helpers/screen-grid.ts"
import { createFakeBus, type FakeTty, installFakeTty, KEY } from "./helpers/tui-harness.ts"

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
    // Jejak shell: prompt yang di-submit tinggal di transkrip seperti PS>.
    // Tepat SATU kemunculan — box input harus sudah di-reset sinkron, kalau
    // tidak teks yang sama tampil dua kali (jejak doc + baris input).
    const after = visible()
    expect(after.split("minicode › halo").length - 1).toBe(1)
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

async function waitFor(cond: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe("REPL TUI: /model & /provider native (tanpa overlay)", () => {
  // Overlay manager (stdout mentah + stdin mentah) tak bisa hidup di dalam
  // capture suspend TUI: frame-nya ditangkap lalu disuntik ke dokumen sebagai
  // sampah kontrol. Alur native: daftar statis + promptLine pilih bernomor.
  async function withSeededHome(providers: unknown[], fn: () => Promise<void>): Promise<void> {
    const home = join(
      tmpdir(),
      `minicode-tui-home-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    )
    const prev = process.env.MINICODE_HOME
    process.env.MINICODE_HOME = home
    try {
      await mkdir(join(home, ".minicode"), { recursive: true })
      await writeFile(join(home, ".minicode", "config.json"), JSON.stringify({ providers }), "utf8")
      await fn()
    } finally {
      if (prev === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = prev
      // Windows menahan handle SQLite (WAL/SHM) setelah close — best-effort
      // seperti persistence-ttl/supply-chain: artefak temp dibersihkan OS,
      // bukan bagian assertion.
      try {
        await rm(home, { recursive: true, force: true })
      } catch {}
    }
  }

  const seed = [
    { id: "tmodel", baseUrl: "https://t.example/v1", apiKey: "k", models: ["m1", "o3-mini"] },
    { id: "tempty", baseUrl: "https://e.example/v1", apiKey: "k", models: [] },
  ]

  test("/model: modal + pilih + effort + resi", async () => {
    await withSeededHome(seed, async () => {
      tty = installFakeTty({ rows: 30, columns: 100 })
      const h = makeHarness()
      const p = start(h)
      await typeLine("/model")
      // Modal popup (bukan daftar angka): tunggu baris model tampil.
      await waitFor(() => visible().includes("tmodel::o3-mini"), 5000, "model modal")
      await tty!.send(KEY.down, 30) // highlight o3-mini
      await tty!.send(KEY.enter, 30)
      await waitFor(() => visible().includes("Thinking effort"), 5000, "effort modal")
      await tty!.send(KEY.down, 30) // low
      await tty!.send(KEY.down, 30) // medium
      await tty!.send(KEY.enter, 30)
      await waitFor(() => h.ctx.modelRef.current === "tmodel::o3-mini", 5000, "model override")
      expect(visible()).toContain("tmodel::m1")
      expect(visible()).toContain("tmodel::o3-mini")
      expect(visible()).toContain("model: tmodel::o3-mini")
      // Effort tersimpan ke scope global hermetic (bukan ~/.minicode asli).
      const { loadConfig } = await import("../src/config.ts")
      const cfg = await loadConfig(undefined, {})
      expect(cfg.providers.find((x) => x.id === "tmodel")?.reasoningEffort).toBe("medium")
      await typeLine("/exit")
      await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    })
  })

  test("/model: non-thinking lewati effort; filter; Esc diam", async () => {
    await withSeededHome(seed, async () => {
      tty = installFakeTty({ rows: 30, columns: 100 })
      const h = makeHarness()
      const p = start(h)
      await typeLine("/model")
      await waitFor(() => visible().includes("tmodel::m1"), 5000, "model modal")
      await tty!.send(KEY.enter, 30) // m1 non-thinking → tanpa effort
      await waitFor(() => h.ctx.modelRef.current === "tmodel::m1", 5000, "model override")
      await new Promise((r) => setTimeout(r, 200))
      expect(visible()).not.toContain("Thinking effort")
      await typeLine("/model")
      await waitFor(() => visible().includes("tmodel::o3-mini"), 5000, "model modal 2")
      await tty!.send(KEY.esc, 30) // batal: diam
      await new Promise((r) => setTimeout(r, 200))
      expect(h.ctx.modelRef.current).toBe("tmodel::m1")
      await typeLine("/model")
      await waitFor(() => visible().includes("tmodel::o3-mini"), 5000, "model modal 3")
      await tty!.send("o3", 30) // filter live → tinggal o3-mini
      await tty!.send(KEY.enter, 30)
      await waitFor(() => visible().includes("Thinking effort"), 5000, "effort modal")
      await tty!.send(KEY.esc, 30) // batal effort = keep: model jadi, effort tetap
      await waitFor(() => h.ctx.modelRef.current === "tmodel::o3-mini", 5000, "model override 2")
      const { loadConfig: lc2 } = await import("../src/config.ts")
      const cfg2 = await lc2(undefined, {})
      expect(cfg2.providers.find((x) => x.id === "tmodel")?.reasoningEffort ?? "default").toBe(
        "default",
      )
      await typeLine("/exit")
      await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    })
  })

  test("/model + /provider tanpa provider terkonfigurasi", async () => {
    await withSeededHome([], async () => {
      tty = installFakeTty({ rows: 30, columns: 100 })
      const h = makeHarness()
      const p = start(h)
      await typeLine("/model")
      expect(visible()).toContain("(no models configured)")
      await typeLine("/provider")
      expect(visible()).toContain("(no providers configured)")
      await typeLine("/exit")
      await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    })
  })

  test("/models alias + /model berargumen: modal dengan filter awal", async () => {
    await withSeededHome(seed, async () => {
      tty = installFakeTty({ rows: 30, columns: 100 })
      const h = makeHarness()
      const p = start(h)
      await typeLine("/models o3") // alias + filter awal → tinggal o3-mini
      await waitFor(() => visible().includes("tmodel::o3-mini"), 5000, "model modal")
      await tty!.send(KEY.enter, 30)
      await waitFor(() => visible().includes("Thinking effort"), 5000, "effort modal")
      expect(h.ctx.modelRef.current).toBe("tmodel::o3-mini")
      await tty!.send(KEY.esc, 30) // keep effort
      await typeLine("/exit")
      await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    })
  })

  test("/model modal tahan resize + Ctrl+C batal", async () => {
    await withSeededHome(seed, async () => {
      tty = installFakeTty({ rows: 30, columns: 100 })
      const h = makeHarness()
      const p = start(h)
      await typeLine("/model")
      await waitFor(() => visible().includes("tmodel::o3-mini"), 5000, "model modal")
      tty!.resize(60, 15) // debounce 50ms → invalidate + render ulang
      await new Promise((r) => setTimeout(r, 300))
      expect(visible()).toContain("tmodel::m1") // modal repaint pasca-resize
      expect(tty!.failures()).toEqual([])
      await tty!.send(KEY.ctrlC, 30) // batal via Ctrl+C (paritas Esc)
      await new Promise((r) => setTimeout(r, 200))
      expect(h.ctx.modelRef.current).toBe("prov::m1") // tak berubah
      await typeLine("/exit")
      await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    })
  })
  test("/sessions: modal daftar + Esc batal diam", async () => {
    await withSeededHome([], async () => {
      // cwd harness default = repo (punya .minicode/ sesi NYATA) — arahkan
      // ke dir kosong agar hermetic: tanpa ini daftar membaca DB developer.
      const proj = join(tmpdir(), `minicode-tui-proj-${Date.now()}`)
      await mkdir(proj, { recursive: true })
      try {
        const { saveSession } = await import("../src/session/persistence.ts")
        await saveSession("sess-modal-1", proj, undefined, [{ role: "user", content: "halo" }], {})
        tty = installFakeTty({ rows: 30, columns: 100 })
        const h = makeHarness()
        ;(h.ctx as unknown as { cwd: string }).cwd = proj
        const p = start(h)
        await typeLine("/sessions")
        await waitFor(() => visible().includes("sess-modal-1"), 5000, "sessions modal")
        await tty!.send(KEY.esc, 30) // batal = diam, tanpa respawn
        await new Promise((r) => setTimeout(r, 200))
        await typeLine("/exit")
        await expect(p).rejects.toBeInstanceOf(ExitSentinel)
      } finally {
        await rm(proj, { recursive: true, force: true })
      }
    })
  }, 20000)
  test("/provider: modal + pilih pakai model pertama + tanpa-model", async () => {
    await withSeededHome(seed, async () => {
      tty = installFakeTty({ rows: 30, columns: 100 })
      const h = makeHarness()
      const p = start(h)
      await typeLine("/provider")
      await waitFor(() => visible().includes("tempty (0 models)"), 5000, "provider modal")
      await tty!.send(KEY.enter, 30) // tmodel (pertama) → model pertamanya
      await waitFor(() => h.ctx.modelRef.current === "tmodel::m1", 5000, "model override")
      expect(visible()).toContain("tmodel")
      expect(visible()).toContain("add/edit/delete via minicode config")
      await typeLine("/provider")
      await waitFor(() => visible().includes("tempty (0 models)"), 5000, "provider modal 2")
      await tty!.send(KEY.down, 30) // tempty
      await tty!.send(KEY.enter, 30)
      await waitFor(() => visible().includes("has no models"), 5000, "empty provider")
      expect(h.ctx.modelRef.current).toBe("tmodel::m1")
      await typeLine("/exit")
      await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    })
  })
})

describe("REPL TUI: scroll + resize otomatis", () => {
  test("submit multiline: tiap baris jadi jejak sendiri (tanpa \\n mentah)", async () => {
    // Gagal di kode lama: jejak `minicode › a\nb` satu entri → \n dieksekusi
    // saat paint dan menggeser grid.
    tty = installFakeTty({ rows: 30, columns: 100 })
    const h = makeHarness()
    const grid = createGridEmulator(100, 30)
    const feed = (): void => {
      grid.feed(tty!.chunks().join(""))
      tty!.clear()
    }
    const p = start(h)
    await waitForPump()
    await tty!.send("baris-a", 20)
    await tty!.send("\n", 20)
    await tty!.send("baris-b", 20)
    await tty!.send("\r", 30)
    await waitFor(() => h.ran.includes("baris-a\nbaris-b"), 5000, "turn")
    feed()
    // Dua baris jejak bertumpuk (transkrip 28 baris: 26 kosong + 2 jejak),
    // baris kedua dengan prompt lanjutan.
    const t27 = grid.text(27)
    const t28 = grid.text(28)
    expect(t27).toContain("baris-a")
    expect(t28).toContain("baris-b")
    expect(t27).not.toContain("baris-b")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("PageUp pin + indikator ↑; PageDown di dasar kembali follow", async () => {
    tty = installFakeTty({ rows: 12, columns: 100 })
    const h = makeHarness()
    // Grid emulator membaca byte layar → status AKHIR yang terlihat, bukan
    // log kumulatif (visible() tak bisa membuktikan hilangnya indikator).
    const grid = createGridEmulator(100, 12)
    const feed = (): void => {
      grid.feed(tty!.chunks().join(""))
      tty!.clear()
    }
    const p = start(h)
    for (let i = 0; i < 12; i++) await typeLine(`baris-${i}`)
    feed()
    await tty!.send("\x1b[5~", 30)
    await new Promise((r) => setTimeout(r, 100))
    feed()
    // Baris status = baris 12; pin 2 baris → "↑2".
    expect(grid.text(12)).toContain("↑")
    await tty!.send("\x1b[6~", 30)
    await new Promise((r) => setTimeout(r, 100))
    feed()
    expect(grid.text(12)).not.toContain("↑")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("resize tanpa keypress memicu repaint (debounce)", async () => {
    tty = installFakeTty({ rows: 30, columns: 100 })
    const h = makeHarness()
    const p = start(h)
    await typeLine("hi")
    const cups = () => tty!.all().split("\x1b[30;1H").length - 1
    const before = cups()
    expect(before).toBeGreaterThan(0)
    // Tanpa keypress apa pun: frame basi harus dilukis ulang otomatis.
    tty!.resize(40, 30)
    const t0 = Date.now()
    while (cups() <= before && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(cups()).toBeGreaterThan(before)
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })
})
