// Test REPL linier (cli/repl.ts) — loop askLine + dispatch, lewat fake TTY.
// runRepl tidak pernah return sendiri: ia diakhiri process.exit(0). Di test,
// process.exit diganti pelempar sentinel supaya `await runRepl(...)` bisa
// di-assert tanpa mematikan runner.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runRepl } from "../cli/repl.ts"
import type { CliSession } from "../cli/setup.ts"
import { setCompactMode } from "../src/ui/render/detail.ts"
import { setReasoningVisible } from "../src/ui/render/reasoning.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
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
  tty?.restore()
  tty = undefined
  setCompactMode(false)
  setReasoningVisible(false)
  delete process.env.MINICODE_MINIMIZE_TOOL
  delete process.env.MINICODE_MINIMIZE_ANSWER
})

interface Harness {
  ctx: CliSession
  ran: string[] // prompt yang masuk runPromptWithVerify
  closed: boolean
  mode: string // mode terakhir yang diterima permissions.setMode
}

function makeHarness(
  opts: {
    budget?: number
    budgetStrict?: boolean
    cost?: number
    /** cost undefined = model tanpa harga (budget fail-open tanpa strict). */
    unknownCost?: boolean
    skills?: { name: string; description: string; body: string }[]
  } = {},
): Harness {
  const h: Harness = { ctx: undefined as unknown as CliSession, ran: [], closed: false, mode: "" }
  const usageRow = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: opts.unknownCost ? undefined : (opts.cost ?? 0),
  }
  const skills = (opts.skills ?? []).map((s) => ({
    name: s.name,
    description: s.description,
    body: s.body,
    path: `virtual:${s.name}.md`,
  }))
  const ctx = {
    session: { events: createFakeBus(), state: { history: [], turnCount: 0, stepCount: 0 } },
    cfg: { providers: [{ id: "prov", providerHint: "openai", models: ["m1"] }] },
    cwd: process.cwd(),
    sessionId: "sess-1",
    modelRef: { current: "prov::m1" },
    effectiveInitialModel: "prov::m1",
    effectiveTimeoutMs: 1000,
    permissionMode: "auto",
    sessionTools: [],
    allLoadedSkills: skills,
    usage: {
      get: () => usageRow,
      getSession: () => usageRow,
      reset: () => {},
      modelUsed: () => ({}),
    },
    budget: opts.budget,
    budgetStrict: opts.budgetStrict,
    detachSimple: () => {},
    persistCurrent: async () => {},
    runPromptWithVerify: async (prompt: string) => {
      h.ran.push(prompt)
    },
    permissions: {
      getMode: () => "auto",
      setMode: (m: string) => {
        h.mode = m
      },
    },
    close: async () => {
      h.closed = true
    },
  }
  h.ctx = ctx as unknown as CliSession
  return h
}

const visible = (t: FakeTty): string => stripAnsi(t.combined())

// Kirim baris ke prompt REPL. Tunggu sampai listener askLine (dipasang saat
// raw mode) benar-benar ada dan stabil — selama turn berjalan REPL memakai
// listener non-raw sementara, dan keystroke yang dikirim saat itu hilang.
async function waitForPrompt(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let stable = 0
  for (;;) {
    if (tty!.promptListeners() >= 1) {
      stable++
      if (stable >= 3) return
    } else {
      stable = 0
    }
    if (Date.now() > deadline) throw new Error("REPL tidak kembali ke prompt")
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function typeLine(line: string): Promise<void> {
  await waitForPrompt()
  await tty!.send(`${line}\r`, 25)
}

// Rejection sentinel exit harus tertangani SEJAK AWAL — kalau baru dipasang
// lewat expect(p).rejects setelah keystroke, bun sudah mencatatnya sebagai
// unhandledRejection dan test gagal apa pun assertion-nya.
function start(h: Harness): Promise<void> {
  const p = runRepl(h.ctx)
  p.catch(() => {})
  return p
}

describe("REPL linier: siklus dasar", () => {
  test("prompt biasa menjalankan turn, /exit menutup sesi", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await typeLine("halo")
    expect(h.ran).toEqual(["halo"])
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    expect(h.closed).toBe(true)
    expect(visible(tty)).toContain("Bye.")
  })

  test("/clear menandai tanpa menghapus scrollback", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await typeLine("halo")
    expect(h.ran).toEqual(["halo"])
    await typeLine("/clear")
    const out = visible(tty)
    // Banner penanda baru ada; sesi tetap jalan (bukan clear layar).
    expect(out).toContain("scrollback preserved")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("Ctrl+C dua kali beruntun saat idle keluar", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await waitForPrompt()
    await tty.send(KEY.ctrlC, 25)
    expect(visible(tty)).toContain("^C")
    await waitForPrompt()
    await tty.send(KEY.ctrlC, 25)
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    expect(h.closed).toBe(true)
    expect(h.ran).toEqual([])
  })

  test("Esc di baris kosong membatalkan prompt seperti Ctrl+C", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await waitForPrompt()
    // Esc sekali = batal (^C, nullStreak 1); REPL masih hidup.
    await tty.send(KEY.esc, 25)
    expect(visible(tty)).toContain("^C")
    await waitForPrompt()
    // Esc dua kali beruntun = keluar, sama seperti Ctrl+C dua kali.
    await tty.send(KEY.esc, 25)
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    expect(h.ran).toEqual([])
    expect(h.closed).toBe(true)
  })

  test("Esc pada baris BERISI tidak membatalkan (draf aman)", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await waitForPrompt()
    await tty.send("draf penting", 25)
    await tty.send(KEY.esc, 25)
    // Bukan cancel: tidak ada ^C, dan draf masih bisa dikirim utuh.
    expect(visible(tty)).not.toContain("^C")
    await tty.send("\r", 25)
    expect(h.ran).toEqual(["draf penting"])
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("baris kosong tidak dihitung sebagai cancel", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await typeLine("") // Enter pada baris kosong
    await typeLine("")
    // REPL masih hidup: prompt baru muncul, /exit tetap berfungsi.
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    expect(visible(tty)).not.toContain("^C")
  })

  test("builtin /status mengalir langsung ke scrollback", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await typeLine("/status")
    const out = visible(tty)
    expect(out).toContain("Session sess-1")
    expect(out).toContain("prov::m1")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("perintah tak dikenal memberi pesan, bukan senyap", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await typeLine("/xyz")
    expect(visible(tty)).toContain("Unknown command: /xyz")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("dropdown '/' menawarkan builtin + perintah driver (tanpa /mode)", async () => {
    tty = installFakeTty()
    const h = makeHarness({ skills: [{ name: "revu", description: "d", body: "b" }] })
    const p = start(h)
    await waitForPrompt()
    tty.clear()
    await tty.send("/", 25)
    let out = visible(tty)
    expect(out).toContain("/help")
    // /mode sengaja tak masuk dropdown (Tab/Shift+Tab memutar mode),
    // tapi tetap ada di /help. Cocokkan batas kata: "/model" mengandung "/mode".
    expect(out).not.toMatch(/\/mode[\s\r\n]/)
    expect(out).toContain("/compact")
    // Setelah mengetik lebih jauh, skill ikut tampil di grup sendiri.
    await tty.send("revu", 25)
    out = visible(tty)
    expect(out).toContain("/revu")
    // Kosongkan baris (ctrl+u) sebelum /exit — karakter yang dikirim via
    // tty.send APPEND ke baris yang sedang diedit.
    await tty.send(KEY.ctrlU, 25)
    await typeLine("/help")
    expect(visible(tty)).toContain("/mode")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("skill /nama menjalankan render hasilnya sebagai turn", async () => {
    tty = installFakeTty()
    const h = makeHarness({ skills: [{ name: "revu", description: "d", body: "isi {{args}}" }] })
    const p = start(h)
    await typeLine("/revu review")
    expect(h.ran).toEqual(["isi review"])
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })
})

describe("REPL linier: interupsi busy", () => {
  test("Ctrl+C saat turn berjalan membatalkan, REPL lanjut", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    // Emulasi kernel: session.run menolak saat signal di-abort.
    let busy = false
    ;(h.ctx as { runPromptWithVerify: unknown }).runPromptWithVerify = (
      prompt: string,
      signal?: AbortSignal,
    ) => {
      h.ran.push(prompt)
      busy = true
      return new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 5000)
        signal?.addEventListener("abort", () => {
          clearTimeout(t)
          reject(new Error("aborted"))
        })
      })
    }
    const p = start(h)
    await typeLine("kerja berat")
    // Tunggu turn benar-benar berjalan, lalu potong dengan Ctrl+C mentah.
    while (!busy) await new Promise((r) => setTimeout(r, 5))
    await tty.send("\x03", 30)
    expect(visible(tty)).toContain("(stopped)")
    // REPL masih hidup setelah pembatalan.
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    expect(h.ran).toEqual(["kerja berat"])
  })
})

describe("REPL linier: mode & toggle", () => {
  test("Shift+Tab cycle mode dan mengubah prefix prompt", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await waitForPrompt()
    tty.clear()
    await tty.send(KEY.shiftTab, 25)
    expect(h.mode).toBe("ask") // auto -> ask
    const out = visible(tty)
    // Tanpa baris "mode: ..." baru: prefiks prompt yang menunjukkan mode.
    expect(out).not.toContain("mode:")
    expect(out).toContain("ask ›")
    await waitForPrompt()
    await tty.send(KEY.ctrlC, 20)
    await waitForPrompt()
    await tty.send(KEY.ctrlC, 20)
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("/mode [nama] memilih mode eksplisit", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await typeLine("/mode plan")
    expect(h.mode).toBe("plan")
    expect(visible(tty)).toContain("mode: plan")
    await typeLine("/mode entah")
    expect(visible(tty)).toContain("unknown mode: entah")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("/compact toggle mode ringkas", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await typeLine("/compact")
    expect(visible(tty)).toContain("compact")
    await typeLine("/compact off")
    expect(visible(tty)).toContain("expanded")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("/thinking toggle expand/minimize reasoning", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await typeLine("/thinking")
    expect(visible(tty)).toContain("expanded")
    await typeLine("/thinking off")
    expect(visible(tty)).toContain("minimized")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("/copy tanpa output turn memberitahu, bukan gagal sunyi", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await typeLine("/copy")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("Tab kosong putar semua mode, Tab berisi tetap completion", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await waitForPrompt()
    // Baris kosong + Tab: auto -> ask -> plan -> allowlist -> auto
    // (allow-all dilewati; bukan completion kosong).
    const seq: [string, string][] = [
      ["ask", "ask ›"],
      ["plan", "plan ›"],
      ["allowlist", "allowlist ›"],
      ["auto", "auto ›"],
    ]
    for (const [m, prefix] of seq) {
      await tty.send(KEY.tab, 25)
      expect(h.mode).toBe(m)
      // Tanpa baris "mode: ..." baru: prefiks prompt yang menunjukkan mode.
      expect(visible(tty)).not.toContain("mode:")
      expect(visible(tty)).toContain(prefix)
      await waitForPrompt()
    }
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("Ctrl+T toggle expand/minimize reasoning saat idle", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await waitForPrompt()
    await tty.send(KEY.ctrlT, 25)
    expect(visible(tty)).toContain("thinking: expanded")
    await tty.send(KEY.ctrlT, 25)
    expect(visible(tty)).toContain("thinking: minimized")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("Ctrl+O toggle compact lewat onKey", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await waitForPrompt()
    await tty.send(KEY.ctrlO, 25)
    expect(visible(tty)).toContain("tool call: compact")
    await waitForPrompt()
    await tty.send(KEY.ctrlO, 25)
    expect(visible(tty)).toContain("tool call: expanded")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("/sessions tanpa sesi terdaftar tidak menanyakan pilihan", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    // cwd diarahkan ke workspace dgn .minicode lokal — DB lokal kosong,
    // terlepas dari isi ~/.minicode/sessions.sqlite di mesin test.
    const ws = mkdtempSync(join(tmpdir(), "minicode-repl-nosess-"))
    mkdirSync(join(ws, ".minicode"), { recursive: true })
    ;(h.ctx as { cwd: string }).cwd = ws
    const p = start(h)
    await typeLine("/sessions")
    // listSessions tidak menemukan sesi → tidak ada prompt resume menggantung.
    const out = visible(tty)
    expect(out).toContain("No sessions")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    // DB sqlite lokal masih terbuka di Windows (EBUSY) — biarkan OS membersihkan tmp.
    try {
      rmSync(ws, { recursive: true, force: true })
    } catch {}
  })
})

describe("REPL linier: budget", () => {
  test("lewat batas menolak prompt baru, slash tetap jalan", async () => {
    tty = installFakeTty()
    const h = makeHarness({ budget: 0.1, cost: 0.2 })
    const p = start(h)
    await typeLine("prompt mahal")
    const out = visible(tty)
    expect(out).toContain("[budget]")
    expect(out).toContain("rejected")
    expect(h.ran).toEqual([])
    // Slash command tidak ikut diblokir.
    await typeLine("/status")
    expect(visible(tty)).toContain("Session sess-1")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("strict + cost tak dikenal menolak prompt baru", async () => {
    tty = installFakeTty()
    const h = makeHarness({ budget: 5, budgetStrict: true, unknownCost: true })
    const p = start(h)
    await typeLine("prompt apa saja")
    expect(visible(tty)).toContain("[budget]")
    expect(visible(tty)).toContain("cost unknown")
    expect(h.ran).toEqual([])
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("tanpa strict + cost tak dikenal tetap fail-open", async () => {
    tty = installFakeTty()
    const h = makeHarness({ budget: 5, unknownCost: true })
    const p = start(h)
    await typeLine("prompt jalan")
    expect(h.ran).toEqual(["prompt jalan"])
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })
})

describe("REPL linier: default ringkas", () => {
  test("env unset -> REPL mengaktifkan compact", async () => {
    const prev = process.env.MINICODE_COMPACT
    delete process.env.MINICODE_COMPACT
    try {
      tty = installFakeTty()
      const h = makeHarness()
      const p = start(h)
      await waitForPrompt()
      const { detail } = await import("../src/ui/render/detail.ts")
      expect(detail.compact).toBe(true)
      await typeLine("/exit")
      await expect(p).rejects.toBeInstanceOf(ExitSentinel)
    } finally {
      if (prev === undefined) delete process.env.MINICODE_COMPACT
      else process.env.MINICODE_COMPACT = prev
    }
  })

  test("env eksplisit dihormati (0 tetap expanded, 1 tetap compact)", async () => {
    const prev = process.env.MINICODE_COMPACT
    try {
      for (const [env, want] of [
        ["0", false],
        ["1", true],
      ] as const) {
        process.env.MINICODE_COMPACT = env
        tty = installFakeTty()
        const h = makeHarness()
        const p = start(h)
        await waitForPrompt()
        const { detail } = await import("../src/ui/render/detail.ts")
        expect(detail.compact).toBe(want)
        await typeLine("/exit")
        await expect(p).rejects.toBeInstanceOf(ExitSentinel)
      }
    } finally {
      if (prev === undefined) delete process.env.MINICODE_COMPACT
      else process.env.MINICODE_COMPACT = prev
    }
  })
})

describe("REPL linier: did-you-mean & thinking", () => {
  test("suggestSimilar: typo dekat disarankan, asing tidak", async () => {
    const { suggestSimilar } = await import("../cli/repl.ts")
    const cmds = ["help", "model", "sessions", "resume"]
    expect(suggestSimilar("modle", cmds)).toBe("model")
    expect(suggestSimilar("sessons", cmds)).toBe("sessions")
    expect(suggestSimilar("xyzabc", cmds)).toBeUndefined()
  })

  test("/sessoons menyarankan /sessions", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await typeLine("/sessoons")
    expect(visible(tty)).toContain("Did you mean /sessions?")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("/cost dan /usage = alias /status (satu sumber biaya)", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await typeLine("/cost")
    expect(visible(tty)).toContain("Session sess-1")
    await typeLine("/usage")
    expect(visible(tty)).toContain("Cost:")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("/thinking toggle expand/minimize reasoning (dari dropdown)", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await typeLine("/thinking on")
    expect(visible(tty)).toContain("thinking: expanded")
    await typeLine("/thinking")
    expect(visible(tty)).toContain("thinking: minimized")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("/expand dan /minimize mengontrol section collapse", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    // Tanpa isi buffer: /expand memberitahu jujur, bukan diam.
    await typeLine("/expand")
    expect(visible(tty)).toContain("nothing to expand")
    await typeLine("/minimize")
    expect(visible(tty)).toContain("sections: minimized")
    expect(process.env.MINICODE_MINIMIZE_TOOL).toBe("1")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("slash sendirian membuka /help, bukan unknown command", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await typeLine("/")
    expect(visible(tty)).toContain("Commands:")
    expect(visible(tty)).not.toContain("Unknown command")
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("render prompt dibungkus synchronized output (anti-flicker dropdown)", async () => {
    tty = installFakeTty()
    const h = makeHarness()
    const p = start(h)
    await waitForPrompt()
    // Ketik "/" → dropdown terbuka → satu frame render penuh terjadi.
    await tty.send("/", 25)
    const raw = tty.combined()
    expect(raw).toContain("\x1b[?2026h")
    expect(raw).toContain("\x1b[?2026l")
    // Hapus "/" dulu — kalau tidak, "/exit" menjadi "//exit" (unknown, tak exit).
    await tty.send(KEY.backspace, 25)
    await typeLine("/exit")
    await expect(p).rejects.toBeInstanceOf(ExitSentinel)
  })

  test("applyBusyKey: + / - / Ctrl+T / Ctrl+C selama turn", () => {
    const { applyBusyKey } = require("../cli/repl.ts") as typeof import("../cli/repl.ts")
    expect(applyBusyKey(0x03, "thinking")).toEqual({ action: "abort" })
    expect(applyBusyKey(0x2b, null)).toEqual({
      action: "toggle-section",
      kind: "tool",
      expand: true,
    })
    expect(applyBusyKey(0x3d, "thinking")).toEqual({
      action: "toggle-section",
      kind: "thinking",
      expand: true,
    })
    expect(applyBusyKey(0x2d, "tool")).toEqual({
      action: "toggle-section",
      kind: "tool",
      expand: false,
    })
    expect(applyBusyKey(0x5f, null)).toEqual({
      action: "toggle-section",
      kind: "tool",
      expand: false,
    })
    expect(applyBusyKey(0x14, "thinking")).toEqual({ action: "toggle-thinking" })
    expect(applyBusyKey(0x41, "thinking")).toBeNull()
  })
})
