// Regression macet/hang: tiga jalur yang dilaporkan user di Windows Terminal.
// - picker non-TTY harus fail-closed (panggil onCancel) agar pickEffort tak gantung.
// - manager harus selalu resolve walau setRawMode melempar (ConPTY rusak).
// - self-heal harus meneruskan abort ke turn perbaikan (Ctrl+C mempan).
// Ronde 2: abort saat verify tak boleh menjadi "verify gagal" (self-heal tak
// diminta), picker harus settle di SEMUA jalur catch, spawn ditunggu via
// mekanisme tunggal exit+close+error, sync me-resolve referensi keystore.

import { afterEach, describe, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { waitChildExit } from "../cli/auto-update.ts"
import { __resetKeystoreForTest, setSecret } from "../src/lib/keystore.ts"
import { checkBaseline, runVerify, runWithSelfHeal } from "../src/policy/verifier.ts"
import { resolveDetectApiKey } from "../src/providers/provision.ts"
import { runPicker } from "../src/ui/screens/picker.ts"
import { installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
  __resetKeystoreForTest()
})

describe("hang: picker non-TTY fail-closed", () => {
  test("memanggil onCancel agar pemanggil nested tak menunggu selamanya", async () => {
    tty = installFakeTty({ isTTY: false })
    let canceled = false
    await runPicker({
      title: "Thinking effort",
      items: [{ name: "default", provider: "", value: "default" }],
      onPick: () => {
        throw new Error("non-TTY tak boleh pick")
      },
      onCancel: () => {
        canceled = true
      },
    })
    expect(canceled).toBe(true)
  })
})

describe("hang: self-heal meneruskan abort", () => {
  test("run menerima signal yang diberikan", async () => {
    const seen: (AbortSignal | undefined)[] = []
    const ctrl = new AbortController()
    await runWithSelfHeal(
      "task",
      {
        run: async (_p, s) => {
          seen.push(s)
        },
        verify: async () => ({ ok: true, output: "clean", command: "t" }),
      },
      ctrl.signal,
    )
    expect(seen.length).toBe(1)
    expect(seen[0]).toBe(ctrl.signal)
  })

  test("sudah aborted = tak jalan sama sekali (batal cepat)", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    let runs = 0
    await runWithSelfHeal(
      "task",
      {
        run: async () => {
          runs++
        },
        verify: async () => ({ ok: true, output: "clean", command: "t" }),
      },
      ctrl.signal,
    )
    expect(runs).toBe(0)
  })

  test("abort di tengah siklus menghentikan fix berikutnya", async () => {
    const ctrl = new AbortController()
    const runs: string[] = []
    await runWithSelfHeal(
      "task",
      {
        run: async (p) => {
          runs.push(p)
          // Batal setelah turn pertama (simulasi Ctrl+C saat verify merah).
          ctrl.abort()
        },
        verify: async () => ({ ok: false, output: "err", command: "t" }),
        maxCycles: 3,
      },
      ctrl.signal,
    )
    // Hanya turn awal yang jalan; fix-turn dibatalkan sebelum mulai.
    expect(runs).toEqual(["task"])
  })
})

describe("hang: manager fail-safe saat raw-mode rusak", () => {
  test("model-manager resolve walau setRawMode melempar", async () => {
    tty = installFakeTty()
    // Rusakkan setRawMode SETELAH harness terpasang: entry + suspend sama-sama
    // melempar. Kode lama: finish() -> suspend() melempar -> resolve tak tercapai
    // = gantung selamanya. Kode baru: selalu resolve.
    const stdin = process.stdin as unknown as { setRawMode: (v: boolean) => unknown }
    const orig = stdin.setRawMode
    stdin.setRawMode = () => {
      throw new Error("ConPTY rusak")
    }
    try {
      const { runModelManagerView } = await import("../src/ui/screens/model-manager.ts")
      const p = runModelManagerView({
        initialRows: [{ id: "a::m", active: true }],
        onSelect: () => {},
        loadRows: async () => [{ id: "a::m", active: true }],
        onDelete: async () => [{ id: "a::m", active: true }],
      })
      // Harus settle <2 dtk, bukan gantung.
      await Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error("hang: tak resolve")), 2000)),
      ])
    } finally {
      stdin.setRawMode = orig
    }
  })

  test("provider-manager resolve walau setRawMode melempar + Esc)", async () => {
    tty = installFakeTty()
    const { runProviderManagerView } = await import("../src/ui/screens/provider-manager.ts")
    const p = runProviderManagerView({
      initialRows: [{ id: "p", baseUrl: "https://x", models: 1 }],
      presets: [],
      askScope: false,
      onSelect: () => {},
      loadRows: async () => [{ id: "p", baseUrl: "https://x", models: 1 }],
      onAdd: async () => ({}),
      onDelete: async () => ({}),
      onEditDefaults: async () => null,
      onEditSave: async () => ({}),
    })
    await tty.ready()
    await tty.send(KEY.esc, 20)
    await Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error("hang: tak resolve")), 2000)),
    ])
  })
})

describe("hang ronde 2: picker settle di semua jalur gagal", () => {
  test("setRawMode melempar saat setup = resolve + onCancel (bukan gantung)", async () => {
    tty = installFakeTty()
    const stdin = process.stdin as unknown as { setRawMode: (v: boolean) => unknown }
    const orig = stdin.setRawMode
    stdin.setRawMode = () => {
      throw new Error("ConPTY rusak")
    }
    try {
      let canceled = false
      const p = runPicker({
        title: "t",
        items: [{ name: "a", provider: "", value: "a" }],
        onPick: () => {
          throw new Error("tak boleh pick saat setup gagal")
        },
        onCancel: () => {
          canceled = true
        },
      })
      await Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error("hang: tak resolve")), 2000)),
      ])
      expect(canceled).toBe(true)
    } finally {
      stdin.setRawMode = orig
    }
  })
})

describe("hang ronde 2: abort saat verify = batal, bukan gagal", () => {
  test("runVerify pre-aborted melempar AbortError tanpa mengeksekusi", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    // Perintah fiktif: bila exec sempat jalan, errornya BUKAN AbortError —
    // test ini membuktikan pre-check melempar duluan.
    await expect(
      runVerify("definitely-not-a-real-command-xyz", process.cwd(), 30_000, ctrl.signal),
    ).rejects.toThrow("abort")
  })

  test("runVerify abort di tengah exec melempar cepat (tak menunggu timeout)", async () => {
    const rt = JSON.stringify(process.execPath)
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 100)
    const t0 = Date.now()
    await expect(
      runVerify(`${rt} -e "setTimeout(()=>{},8000)"`, process.cwd(), 30_000, ctrl.signal),
    ).rejects.toThrow("abort")
    // Exec 8 dtk dibunuh dalam ~100ms — margin 5 dtk sangat longgar agar tak flaky.
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  test("checkBaseline meneruskan signal + pre-aborted melempar", async () => {
    const seen: (AbortSignal | undefined)[] = []
    const ctrl = new AbortController()
    const ok = { ok: true, output: "clean", command: "t" } as const
    await expect(
      checkBaseline(async (s) => {
        seen.push(s)
        return ok
      }, ctrl.signal),
    ).resolves.toBeNull()
    expect(seen[0]).toBe(ctrl.signal)
    const dead = new AbortController()
    dead.abort()
    await expect(checkBaseline(async () => ok, dead.signal)).rejects.toThrow("abort")
  })

  test("self-heal: verify menerima signal; abort-di-tengah-verify menghentikan tanpa fix", async () => {
    const ctrl = new AbortController()
    const seen: (AbortSignal | undefined)[] = []
    let runs = 0
    let cycles = 0
    await runWithSelfHeal(
      "task",
      {
        run: async () => {
          runs++
        },
        verify: async (s) => {
          seen.push(s)
          // Simulasi Ctrl+C tepat saat verify merah.
          ctrl.abort()
          return { ok: false, output: "err", command: "t" }
        },
        onCycle: () => {
          cycles++
        },
      },
      ctrl.signal,
    )
    expect(seen[0]).toBe(ctrl.signal)
    // Hanya turn awal; abort menang — tanpa onCycle, tanpa fix-turn.
    expect(runs).toBe(1)
    expect(cycles).toBe(0)
  })
})

describe("hang ronde 2: waitChildExit mekanisme tunggal", () => {
  const fakeChild = () => {
    const handlers = new Map<string, ((c: number | null) => void)[]>()
    return {
      child: {
        on: (ev: string, fn: (c: number | null) => void) => {
          handlers.set(ev, [...(handlers.get(ev) ?? []), fn])
        },
      } as unknown as ChildProcess,
      emit: (ev: string, code: number | null) => {
        for (const fn of handlers.get(ev) ?? []) fn(code)
      },
    }
  }

  test("resolve dari exit", async () => {
    const f = fakeChild()
    const p = waitChildExit(f.child)
    f.emit("exit", 3)
    await expect(p).resolves.toBe(3)
  })

  test("resolve dari close bila exit tak pernah datang (stdio macet)", async () => {
    const f = fakeChild()
    const p = waitChildExit(f.child)
    f.emit("close", 0)
    await expect(p).resolves.toBe(0)
  })

  test("error = 1", async () => {
    const f = fakeChild()
    const p = waitChildExit(f.child)
    f.emit("error", null)
    await expect(p).resolves.toBe(1)
  })

  test("exit lalu close: yang pertama menang, sekali settle", async () => {
    const f = fakeChild()
    const p = waitChildExit(f.child)
    f.emit("exit", 2)
    f.emit("close", 0)
    await expect(p).resolves.toBe(2)
  })
})

describe("hang ronde 2: sync resolve referensi keystore", () => {
  test("plain lewat apa adanya; keystore hilang = null; keystore ada = secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minicode-ks-"))
    const prevHome = process.env.MINICODE_HOME
    const prevDisable = process.env.MINICODE_KEYSTORE_DISABLE
    process.env.MINICODE_HOME = dir
    // Paksa backend plain agar hermetic di semua OS (tanpa DPAPI asli).
    process.env.MINICODE_KEYSTORE_DISABLE = "1"
    try {
      await expect(resolveDetectApiKey("sk-plain")).resolves.toBe("sk-plain")
      await expect(resolveDetectApiKey("keystore:tak-ada")).resolves.toBeNull()
      await setSecret("u1", "sk-live-abc")
      await expect(resolveDetectApiKey("keystore:u1")).resolves.toBe("sk-live-abc")
    } finally {
      if (prevHome === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = prevHome
      if (prevDisable === undefined) delete process.env.MINICODE_KEYSTORE_DISABLE
      else process.env.MINICODE_KEYSTORE_DISABLE = prevDisable
      __resetKeystoreForTest()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("hang ronde 3: idle-timeout input", () => {
  test("askLine idle = batal (null), bukan gantung", async () => {
    tty = installFakeTty()
    const { askLine } = await import("../src/ui/input/input.ts")
    const p = askLine({ prompt: "> ", history: [], idleMs: 80 })
    await Promise.race([
      expect(p).resolves.toBeNull(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("hang: tak resolve")), 2000)),
    ])
  })

  test("askLine keypress beruntun memperpanjang idle (tak batal prematur)", async () => {
    tty = installFakeTty()
    const { askLine } = await import("../src/ui/input/input.ts")
    let settled = false
    const p = askLine({ prompt: "> ", history: [], idleMs: 120 })
    void p.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await tty.ready()
    // Tiap ketikan me-reset deadline 120ms: pada 250ms (2× deadline awal)
    // prompt WAJIB masih hidup. Kode lama tanpa reset: sudah batal di 120ms.
    await tty.send("a", 5)
    await new Promise((r) => setTimeout(r, 60))
    await tty.send("b", 5)
    await new Promise((r) => setTimeout(r, 60))
    await tty.send("c", 5)
    await new Promise((r) => setTimeout(r, 90))
    expect(settled).toBe(false)
    // Tutup rapi via Ctrl+C (batal).
    await tty.send(KEY.ctrlC, 20)
    await Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error("hang: tak resolve")), 2000)),
    ])
    expect(settled).toBe(true)
  })

  test("askSecret idle = batal (null), bukan gantung", async () => {
    tty = installFakeTty()
    const { askSecret } = await import("../src/ui/input/input.ts")
    const p = askSecret("key: ", { idleMs: 80 })
    await Promise.race([
      expect(p).resolves.toBeNull(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("hang: tak resolve")), 2000)),
    ])
  })
})
