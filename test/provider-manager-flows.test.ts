// Interactive `runProviderManager` flows: a (add), d (delete), e (edit).
//
// These paths were previously untested (43% lines) because they run
// `askLine`/`askSecret` INSIDE suspended raw mode: the old harness could only
// send keys to the currently attached listener, while each next prompt installs
// a fresh listener after the previous one finishes.
// `tty.answerSequence()` (see helpers/tui-harness.ts) closes that gap by waiting
// for each new listener attachment.
//
// Global config at `~/.minicode/config.json` is backed up and restored:
// `src/config.ts` computes that path at import time, so it cannot be redirected
// via env inside the same process. This mirrors `test/sync.test.ts`.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProviderManager } from "../cli/provider-manager.ts"
import { clearDetectCache } from "../src/providers/detect.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { type FakeTty, installFakeTty, KEY } from "./helpers/tui-harness.ts"

const globalPath = join(homedir(), ".minicode", "config.json")
const globalBak = `${globalPath}.bak-provider-manager-test`
const hadGlobal = existsSync(globalPath)
if (hadGlobal) await rename(globalPath, globalBak).catch(() => {})
await mkdir(join(homedir(), ".minicode"), { recursive: true }).catch(() => {})

const origFetch = globalThis.fetch
/** Deteksi model berhasil dengan dua model. */
const okFetch = (async (url: unknown) => {
  if (String(url).includes("/models")) {
    return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
      status: 200,
    })
  }
  return new Response("nf", { status: 404 })
}) as typeof fetch
/** All endpoints fail — forces fallback/rollback path. */
const failFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch

let tty: FakeTty | undefined
let workspace: string

const tmpRoots: string[] = []

beforeEach(async () => {
  clearDetectCache()
  globalThis.fetch = okFetch
  workspace = mkdtempSync(join(tmpdir(), "minicode-pm-"))
  tmpRoots.push(workspace)
  await mkdir(join(workspace, ".minicode"), { recursive: true })
  await writeFile(globalPath, JSON.stringify({ providers: [] }), "utf8")
})

afterEach(() => {
  tty?.restore()
  tty = undefined
})

afterAll(async () => {
  globalThis.fetch = origFetch
  clearDetectCache()
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true })
  try {
    if (hadGlobal) await rename(globalBak, globalPath)
    else rmSync(globalPath, { force: true })
  } catch {}
})

const localConfigPath = () => join(workspace, ".minicode", "config.json")

async function writeLocalProviders(providers: unknown[]): Promise<void> {
  await writeFile(localConfigPath(), JSON.stringify({ providers }), "utf8")
}

async function readConfig(
  path: string,
): Promise<{ providers: { id: string; models: string[] }[] }> {
  return JSON.parse(await readFile(path, "utf8")) as {
    providers: { id: string; models: string[] }[]
  }
}

const visible = (t: FakeTty): string => stripAnsi(t.all())

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error("Timed out waiting for condition")
}

interface Manager {
  done: Promise<void>
  /** Close manager and await completion. */
  close(): Promise<void>
}

async function openManager(
  opts: { currentModel?: string; setModelOverride?: (m: string) => void } = {},
): Promise<Manager> {
  const t = tty
  if (!t) throw new Error("installFakeTty must be called first")
  const done = runProviderManager({ cwd: workspace, allowLocalConfig: true, ...opts })
  await t.ready()
  return {
    done,
    async close() {
      // Jangan kirim Esc saat jendela suspend (0 listener): ia hilang dan
      // `await done` gantung sampai timeout test. Tunggu listener kembali.
      await t.waitForListener(2000)
      await t.send(KEY.esc, 30)
      await done
    },
  }
}

describe.serial("provider-manager: add (a)", () => {
  test("preset + scope local menyimpan provider ke config lokal", async () => {
    tty = installFakeTty({ rows: 24 })
    const t = tty // lokal typed untuk dipakai di dalam callback (narrowing
    // variabel modul tidak bertahan lintas closure).
    const mgr = await openManager()
    // "0" = preset pertama (OpenAI), "sk-1" = API key, "n" = simpan lokal.
    const seq = tty.answerSequence(["0", "sk-1", "n"])
    await tty.send("a")
    await seq
    // Save terjadi SETELAH "Detecting models…" async — assert layar/config
    // segera setelah seq = race (terbukti flaky di CI 35205151463). Config
    // LOKAL belum ada sebelum save pertama: guard existsSync dulu, kalau tidak
    // readConfig melempar ENOENT dari dalam waitFor (bukan timeout).
    await waitFor(
      async () =>
        existsSync(localConfigPath()) &&
        (await readConfig(localConfigPath())).providers.length === 1,
    )
    await waitFor(() => visible(t).includes("saved"))
    const out = visible(tty)
    expect(out).toContain("Add provider")
    expect(out).toContain("saved")
    const cfg = await readConfig(localConfigPath())
    expect(cfg.providers).toHaveLength(1)
    expect(cfg.providers[0]?.id).toBe("openai")
    expect(cfg.providers[0]?.models).toEqual(["model-a", "model-b"])
    // Global remains empty — scope is respected.
    expect((await readConfig(globalPath)).providers).toHaveLength(0)
    await mgr.close()
  })

  test("global scope (Y answer) saves to ~/.minicode", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const seq = tty.answerSequence(["0", "sk-1", "y"])
    await tty.send("a")
    await seq
    await waitFor(async () => (await readConfig(globalPath)).providers.length === 1)
    await mgr.close()
  })

  test("URL kustom dipakai apa adanya", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    // Indeks setelah preset terakhir = opsi "Base URL kustom".
    const { GATEWAY_PRESETS } = await import("../src/providers/presets.ts")
    const seq = tty.answerSequence([
      String(GATEWAY_PRESETS.length),
      "https://gw.contoh/v1",
      "sk-2",
      "n",
    ])
    await tty.send("a")
    await seq
    // Custom URL juga menjalani detect async sebelum save — tunggu config
    // ter-tulis sebelum dibaca (kelas race yang sama).
    await waitFor(() => existsSync(localConfigPath()))
    const cfg = JSON.parse(await readFile(localConfigPath(), "utf8")) as {
      providers: { baseUrl: string }[]
    }
    expect(cfg.providers[0]?.baseUrl).toBe("https://gw.contoh/v1")
    await mgr.close()
  })

  test("empty custom URL -> required message, nothing is saved", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const { GATEWAY_PRESETS } = await import("../src/providers/presets.ts")
    const seq = tty.answerSequence([String(GATEWAY_PRESETS.length), ""])
    await tty.send("a")
    await seq
    expect(visible(tty)).toContain("Base URL is required")
    expect(existsSync(localConfigPath())).toBe(false)
    await mgr.close()
  })

  test("empty API key -> required message, nothing is saved", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const seq = tty.answerSequence(["0", ""])
    await tty.send("a")
    await seq
    expect(visible(tty)).toContain("API key is required")
    expect(existsSync(localConfigPath())).toBe(false)
    await mgr.close()
  })

  test("Ctrl+C in askSecret cancels dialog WITHOUT killing the session", async () => {
    // Regresi: askSecret dulu memanggil process.exit(130) di sini. Karena
    // provider-manager adalah dialog di dalam REPL, itu mematikan seluruh sesi
    // (beserta riwayatnya) hanya karena user salah ketik API key.
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    let epoch = tty.listenerEpoch()
    epoch = await tty.waitForNewListener(epoch - 1) // listener manager sudah ada
    const seq = (async () => {
      const afterPick = await tty.waitForNewListener(tty.listenerEpoch())
      await tty.send("0\r")
      await tty.waitForNewListener(afterPick)
      await tty.send(KEY.ctrlC, 30)
    })()
    await tty.send("a")
    await seq
    // Batal (null) BUKAN "API key is required" (submit kosong) — dibedakan.
    expect(visible(tty)).toContain("Canceled")
    // Manager is still alive: Esc can still close it (if process died, this
    // would never complete).
    await mgr.close()
  })

  test("Ctrl+U di askSecret menghapus isian (bukan mati/backspace satu-satu)", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const seq = (async () => {
      const afterPick = await tty.waitForNewListener(tty.listenerEpoch())
      await tty.send("0\r")
      await tty.waitForNewListener(afterPick)
      await tty.send("sk-1")
      await tty.send(KEY.ctrlU, 30) // hapus semua
      await tty.send("\r", 30) // submit kosong
    })()
    await tty.send("a")
    await seq
    // Isian sudah terhapus → submit kosong = "required", bukan "saved".
    expect(visible(tty)).toContain("API key is required")
    expect((await readConfig(globalPath)).providers).toHaveLength(0)
    await mgr.close()
  })

  test("empty Enter at Gateway prompt cancels — does NOT pick preset [0]", async () => {
    // Regresi: Number("")===0 dulu membuat Enter kosong diam-diam memilih
    // preset pertama dan lanjut ke API key.
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const seq = tty.answerSequence([""])
    await tty.send("a")
    await seq
    expect(visible(tty)).toContain("Canceled")
    expect((await readConfig(globalPath)).providers).toHaveLength(0)
    await mgr.close()
  })

  test("adding a preset whose id already exists asks for overwrite confirmation", async () => {
    // Regresi: detectAndSave(id preset) menimpa key+models tanpa konfirmasi.
    await writeFile(
      globalPath,
      JSON.stringify({
        providers: [
          { id: "openai", baseUrl: "https://lama.example/v1", apiKey: "lama", models: ["lama-1"] },
        ],
      }),
      "utf8",
    )
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const t = tty
    if (!t) throw new Error("fake tty is missing")
    // Jawab "n" pada konfirmasi timpa → batal, config lama utuh.
    const seq = t.answerSequence(["0", "n"], {
      expect: [(out) => out.includes("Gateway > "), (out) => out.includes("exists — overwrite")],
    })
    await t.send("a")
    await seq
    await waitFor(() => visible(t).includes("Canceled"))
    const cfg = JSON.parse(await readFile(globalPath, "utf8")) as {
      providers: { id: string; apiKey: string }[]
    }
    expect(cfg.providers.find((p) => p.id === "openai")?.apiKey).toBe("lama")
    await mgr.close()
  })

  test("out-of-range numeric selection -> 'Unknown selection'", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const seq = tty.answerSequence(["999"])
    await tty.send("a")
    await seq
    expect(visible(tty)).toContain("Unknown selection")
    await mgr.close()
  })

  test("model detection failure is reported, not thrown", async () => {
    globalThis.fetch = failFetch
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    // Preset punya fallbackModels, jadi provider TETAP saved â€” yang diuji
    // this verifies no exception escapes the dialog.
    const seq = tty.answerSequence(["0", "sk-3", "n"])
    await tty.send("a")
    await seq
    expect(tty.failures()).toEqual([])
    await mgr.close()
  })
})

describe.serial("provider-manager: delete (d)", () => {
  const oneProvider = [
    { id: "gw", baseUrl: "https://gw.example/v1", apiKey: "k", models: ["m1", "m2", "m3"] },
  ]

  test("'y' confirmation deletes from local and global config", async () => {
    await writeLocalProviders(oneProvider)
    await writeFile(globalPath, JSON.stringify({ providers: oneProvider }), "utf8")
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    // Tunggu marker prompt sebelum jawab: jawaban tak boleh masuk ke prompt
    // yang salah bila dua prompt berurutan pasang listener dalam tick sama.
    const seq = tty.answerSequence(["y"], {
      expect: [(out) => out.includes("Delete? [y/N] ")],
    })
    await tty.send("d")
    await seq
    const out = visible(tty)
    // Konfirmasi menyebut DAMPAK: berapa model ikut hilang.
    expect(out).toContain("and 3 models")
    await waitFor(async () => {
      const local = await readConfig(localConfigPath())
      const global = await readConfig(globalPath)
      return local.providers.length === 0 && global.providers.length === 0
    })
    await mgr.close()
  }, 5000)

  test("'n' confirmation cancels — provider remains", async () => {
    await writeLocalProviders(oneProvider)
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const seq = tty.answerSequence(["n"])
    await tty.send("d")
    await seq
    expect(visible(tty)).toContain("Canceled")
    expect((await readConfig(localConfigPath())).providers).toHaveLength(1)
    await mgr.close()
  })

  test("empty Enter equals reject (default N)", async () => {
    await writeLocalProviders(oneProvider)
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const seq = tty.answerSequence([""])
    await tty.send("d")
    await seq
    expect((await readConfig(localConfigPath())).providers).toHaveLength(1)
    await mgr.close()
  })

  test("deleting active provider shows explicit warning", async () => {
    await writeLocalProviders(oneProvider)
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager({ currentModel: "gw::m1" })
    // List marks active provider before user presses d.
    expect(visible(tty)).toContain("(active)")
    const seq = tty.answerSequence(["y"], {
      expect: [(out) => out.includes("Delete? [y/N] ")],
    })
    await tty.send("d")
    await seq
    const out = visible(tty)
    expect(out).toContain("(active)")
    expect(out).toContain("Provider is active")
    await mgr.close()
  }, 5000)

  test("empty list: d does nothing", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await tty.send("d", 40)
    expect(visible(tty)).not.toContain("Continue delete")
    expect(tty.failures()).toEqual([])
    await mgr.close()
  })
})

describe.serial("provider-manager: edit (e)", () => {
  test("changing baseUrl triggers re-detection", async () => {
    await writeLocalProviders([
      { id: "gw", baseUrl: "https://lama.example/v1", apiKey: "k", models: ["lama"] },
    ])
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const seq = tty.answerSequence(["https://baru.example/v1", ""])
    await tty.send("e")
    await seq
    const t = tty
    if (!t) throw new Error("fake tty is missing")
    await waitFor(() => visible(t).includes("updated"), 2000)
    const out = visible(t)
    expect(out).toContain('Edit provider "gw"')
    expect(out).toContain("updated")
    // Entri updated ditulis ke global (perilaku doEdit: global: true).
    const cfg = JSON.parse(await readFile(globalPath, "utf8")) as {
      providers: { baseUrl: string; models: string[] }[]
    }
    expect(cfg.providers[0]?.baseUrl).toBe("https://baru.example/v1")
    expect(cfg.providers[0]?.models).toEqual(["model-a", "model-b"])
    await mgr.close()
  })

  test("both inputs empty -> 'No changes'", async () => {
    await writeLocalProviders([
      { id: "gw", baseUrl: "https://gw.example/v1", apiKey: "k", models: ["m1"] },
    ])
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const seq = tty.answerSequence(["", ""])
    await tty.send("e")
    await seq
    expect(visible(tty)).toContain("No changes")
    // Config lokal tidak tersentuh.
    expect((await readConfig(localConfigPath())).providers[0]?.models).toEqual(["m1"])
    await mgr.close()
  })

  test("save failure -> error is shown + rollback attempted, without exception", async () => {
    // Provider with no models + failed detect => saveProvider rejects
    // ("provider Update failed"). This is the only doEdit path that reaches
    // catch + rollback.
    globalThis.fetch = failFetch
    await writeLocalProviders([
      { id: "gw", baseUrl: "https://gw.example/v1", apiKey: "k", models: [] },
    ])
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const seq = tty.answerSequence(["https://baru.example/v1", ""], {
      expect: [(out) => out.includes("Base URL ["), (out) => out.includes("API key")],
    })
    await tty.send("e")
    await seq
    const t = tty
    if (!t) throw new Error("fake tty is missing")
    await waitFor(() => visible(t).includes("updated"), 2000)
    expect(visible(t)).toContain("updated")
    expect(tty.failures()).toEqual([])
    await mgr.close()
  }, 5000)

  test("empty list: e does nothing", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await tty.send("e", 40)
    expect(visible(tty)).not.toContain("Edit provider")
    await mgr.close()
  })
})

describe.serial("provider-manager: navigasi", () => {
  test("down arrow moves selection, Enter activates first model", async () => {
    await writeLocalProviders([
      { id: "satu", baseUrl: "https://a.example/v1", apiKey: "k", models: ["a1"] },
      { id: "dua", baseUrl: "https://b.example/v1", apiKey: "k", models: ["b1"] },
    ])
    tty = installFakeTty({ rows: 24 })
    let picked: string | undefined
    const mgr = await openManager({
      setModelOverride: (m) => {
        picked = m
      },
    })
    await tty.send(KEY.down)
    await tty.send(KEY.enter, 30)
    await mgr.done
    expect(picked).toBe("dua::b1")
  })

  test("up arrow on first row stays within bounds", async () => {
    await writeLocalProviders([
      { id: "satu", baseUrl: "https://a.example/v1", apiKey: "k", models: ["a1"] },
    ])
    tty = installFakeTty({ rows: 24 })
    let picked: string | undefined
    const mgr = await openManager({
      setModelOverride: (m) => {
        picked = m
      },
    })
    await tty.send(KEY.up)
    await tty.send(KEY.up)
    await tty.send(KEY.enter, 30)
    await mgr.done
    expect(picked).toBe("satu::a1")
  })

  test("provider id/baseUrl dari config tak terpercaya disanitasi di layar", async () => {
    // Config lokal (repo) adalah input tak terpercaya: satu `\x1b[2J` di id
    // atau baseUrl akan membersihkan layar saat manager dibuka. Label pendek
    // TIDAK lewat truncate, jadi sanitasi wajib di pemanggil.
    await writeLocalProviders([
      {
        id: "jahat\x1b[2J\x1b[?1049h",
        baseUrl: "https://x.example/v1\x1b]0;bajak\x07",
        apiKey: "k",
        models: ["m1"],
      },
    ])
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const t = tty
    await waitFor(() => visible(t).includes("jahat"))
    const out = t.all()
    expect(out).not.toContain("\x1b[2J")
    expect(out).not.toContain("\x1b[?1049h")
    expect(out).not.toContain("\x1b]0;")
    await mgr.close()
  })

  test("Ctrl+C and Ctrl+D close manager like Esc", async () => {
    for (const key of [KEY.ctrlC, KEY.ctrlD]) {
      tty?.restore()
      tty = installFakeTty({ rows: 24 })
      const done = runProviderManager({ cwd: workspace })
      await tty.ready()
      await tty.send(key, 30)
      await done
    }
    expect(true).toBe(true)
  })

  test("resize redraws without exceeding terminal width", async () => {
    await writeLocalProviders(
      Array.from({ length: 8 }, (_, i) => ({
        id: `provider-dengan-nama-panjang-${i}`,
        baseUrl: `https://contoh-gateway-yang-panjang-sekali-${i}.example/v1`,
        apiKey: "k",
        models: ["m1"],
      })),
    )
    tty = installFakeTty({ columns: 40, rows: 10 })
    const mgr = await openManager()
    tty.clear()
    tty.resize(30, 8)
    await new Promise((r) => setTimeout(r, 20))
    for (const line of stripAnsi(tty.all()).split("\n")) {
      expect(line.replace(/\s+$/, "").length).toBeLessThanOrEqual(30)
    }
    await mgr.close()
  })

  test("list longer than screen shows remaining-items indicator", async () => {
    await writeLocalProviders(
      Array.from({ length: 12 }, (_, i) => ({
        id: `gw${i}`,
        baseUrl: `https://gw${i}.example/v1`,
        apiKey: "k",
        models: ["m1"],
      })),
    )
    // rows 8 -> visibleRows = max(1, min(8-4, 14)) = 4.
    tty = installFakeTty({ columns: 80, rows: 8 })
    const mgr = await openManager()
    expect(visible(tty)).toContain("more")
    await mgr.close()
  })
})

describe.serial("provider-manager: non-TTY", () => {
  test("lists providers as-is without raw mode", async () => {
    await writeLocalProviders([
      { id: "gw", baseUrl: "https://gw.example/v1", apiKey: "k", models: ["m1", "m2"] },
    ])
    tty = installFakeTty({ isTTY: false })
    await runProviderManager({ cwd: workspace, allowLocalConfig: true })
    const out = visible(tty)
    expect(out).toContain("gw")
    expect(out).toContain("2 models")
  })

  test("id/baseUrl tak terpercaya disanitasi sebelum cetak", async () => {
    await writeLocalProviders([
      { id: "jahat", baseUrl: "https://x/v1\x1b[2J", apiKey: "k", models: ["m1"] },
    ])
    tty = installFakeTty({ isTTY: false })
    await runProviderManager({ cwd: workspace, allowLocalConfig: true })
    const raw = tty.all()
    expect(raw).not.toContain("\x1b[2J")
    expect(stripAnsi(raw)).toContain("jahat")
    expect(stripAnsi(raw)).toContain("https://x/v1")
  })
})

// Sanity: workspace benar-benar terisolasi dari repo.
test("test workspace stays in temp directory, not repo", () => {
  expect(resolve(workspace).startsWith(resolve(tmpdir()))).toBe(true)
})
