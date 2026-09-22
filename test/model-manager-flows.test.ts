// Alur interactive `runModelManager` (jalur /model di REPL): pilih, tambah,
// hapus, navigasi. Sebelumnya nol cakupan karena memakai askLine di dalam
// raw mode yang di-suspend — ditutup lewat `tty.answerSequence()` (pola yang
// sama dengan test/provider-manager-flows.test.ts).
//
// Config global di `~/.minicode/config.json` dicadangkan dan dikembalikan:
// `src/config.ts` menghitung path itu saat import, jadi tidak bisa dialihkan
// lewat env dari dalam proses.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { runModelManager } from "../cli/model-manager.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { type FakeTty, installFakeTty, KEY } from "./helpers/tui-harness.ts"

const globalPath = join(homedir(), ".minicode", "config.json")
const globalBak = `${globalPath}.bak-model-manager-test`
const hadGlobal = existsSync(globalPath)
if (hadGlobal) await rename(globalPath, globalBak).catch(() => {})
await mkdir(join(homedir(), ".minicode"), { recursive: true }).catch(() => {})

let tty: FakeTty | undefined
let workspace: string
let overrideLog: string[] = []

const tmpRoots: string[] = []

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "minicode-mm-"))
  tmpRoots.push(workspace)
  await mkdir(join(workspace, ".minicode"), { recursive: true })
  const providers = [
    { id: "prov", baseUrl: "https://api.test/v1", apiKey: "k", models: ["m1", "m2"] },
    // Provider kedua ber-model reasoning agar alur picker effort teruji;
    // m1/m2 sengaja non-keluarga (picker effort dilewati untuknya).
    { id: "cap", baseUrl: "https://cap.test/v1", apiKey: "k", models: ["o3-mini"] },
  ]
  await writeFile(
    join(workspace, ".minicode", "config.json"),
    JSON.stringify({ providers }),
    "utf8",
  )
  await writeFile(globalPath, JSON.stringify({ providers }), "utf8")
  overrideLog = []
})

afterEach(() => {
  tty?.restore()
  tty = undefined
})

afterAll(async () => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true })
  try {
    if (hadGlobal) await rename(globalBak, globalPath)
    else rmSync(globalPath, { force: true })
  } catch {}
})

const localConfigPath = () => join(workspace, ".minicode", "config.json")

async function readConfig(
  path: string,
): Promise<{ providers: { id: string; models: string[] }[] }> {
  return JSON.parse(await readFile(path, "utf8")) as {
    providers: { id: string; models: string[] }[]
  }
}

const visible = () => stripAnsi(tty!.all())

describe("model-manager: non-TTY", () => {
  test("mencetak daftar provider::model tanpa raw mode", async () => {
    tty = installFakeTty({ isTTY: false })
    await runModelManager({ cwd: workspace })
    const out = visible()
    expect(out).toContain("prov::m1")
    expect(out).toContain("prov::m2")
  })

  test("id/model tak terpercaya disanitasi sebelum cetak", async () => {
    // Config lokal (repo tak terpercaya) / hasil probe jaringan bisa memuat
    // escape: `\x1b[2J` di nama model tak boleh membersihkan layar pemanggil.
    await writeFile(
      localConfigPath(),
      JSON.stringify({
        providers: [
          { id: "jahat\x1b[2J", baseUrl: "https://x/v1", apiKey: "k", models: ["m\x1b[?1049h1"] },
        ],
      }),
      "utf8",
    )
    tty = installFakeTty({ isTTY: false })
    await runModelManager({ cwd: workspace, allowLocalConfig: true })
    const raw = tty.all()
    expect(raw).not.toContain("\x1b[2J")
    expect(raw).not.toContain("\x1b[?1049h")
    expect(stripAnsi(raw)).toContain("jahat")
    expect(stripAnsi(raw)).toContain("m")
  })
})

describe("model-manager: alur interactive", () => {
  test("render awal menampilkan daftar model + tanda active", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({ cwd: workspace, currentModel: "prov::m2" })
    await tty.ready()
    const out = visible()
    expect(out).toContain("Models")
    expect(out).toContain("prov::m1")
    expect(out).toContain("prov::m2")
    expect(out).toContain("active")
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30)
    await p
  }, 5000)

  test("Enter memilih model + picker effort default (tanpa kunci effort)", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({
      cwd: workspace,
      currentModel: "prov::m1",
      setModelOverride: (m) => overrideLog.push(m),
    })
    await tty.ready()
    await tty.send(KEY.down, 20) // highlight prov::m2
    await tty.send(KEY.down, 20) // highlight cap::o3-mini (keluarga reasoning)
    await tty.send(KEY.enter, 30)
    // Enter sekarang membuka picker effort — pilih default
    await tty.waitForOutput((out) => out.includes("Thinking effort"), 2000)
    await tty.send(KEY.enter, 30)
    await p
    expect(overrideLog).toEqual(["cap::o3-mini"])
    // default = hapus kunci (jangan simpan "default" harfiah)
    const cfg = await readConfig(localConfigPath())
    expect(cfg.providers[0]).not.toHaveProperty("reasoningEffort")
  })

  test("Enter + pilih high menyimpan effort ke provider + tetap override", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({
      cwd: workspace,
      currentModel: "prov::m1",
      setModelOverride: (m) => overrideLog.push(m),
    })
    await tty.ready()
    await tty.send(KEY.down, 20) // highlight prov::m2
    await tty.send(KEY.down, 20) // highlight cap::o3-mini
    await tty.send(KEY.enter, 30)
    await tty.waitForOutput((out) => out.includes("Thinking effort"), 2000)
    await tty.send(KEY.down, 20) // low
    await tty.send(KEY.down, 20) // medium
    await tty.send(KEY.down, 20) // high
    await tty.send(KEY.enter, 30)
    await p
    expect(overrideLog).toEqual(["cap::o3-mini"])
    const cfg = await readConfig(localConfigPath())
    expect(cfg.providers[1]?.models).toContain("o3-mini")
    const cap = (cfg.providers as { id: string; reasoningEffort?: string }[]).find(
      (x) => x.id === "cap",
    )
    expect(cap?.reasoningEffort).toBe("high")
  })

  test("Esc di picker effort = batal total (model tak jadi dipilih)", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({
      cwd: workspace,
      currentModel: "cap::o3-mini",
      setModelOverride: (m) => overrideLog.push(m),
    })
    await tty.ready()
    await tty.send(KEY.enter, 30) // pilih cap::o3-mini → picker terbuka
    await tty.waitForOutput((out) => out.includes("Thinking effort"), 2000)
    await tty.send(KEY.esc, 30) // batal: kembali ke daftar, tanpa select
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30) // tutup manager
    await p
    expect(overrideLog).toEqual([])
  })

  test("model tanpa thinking: Enter langsung select, picker dilewati", async () => {
    // m1/m2 bukan keluarga reasoning apa pun → tak ada opsi effort, tak ada
    // picker, effort tersimpan tak disentuh.
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({
      cwd: workspace,
      currentModel: "prov::m1",
      setModelOverride: (m) => overrideLog.push(m),
    })
    await tty.ready()
    await tty.send(KEY.enter, 30) // pilih prov::m1 → langsung selesai
    await p
    expect(overrideLog).toEqual(["prov::m1"])
    expect(visible()).not.toContain("Thinking effort")
    const cfg = await readConfig(localConfigPath())
    expect(cfg.providers[0]).not.toHaveProperty("reasoningEffort")
  })

  test("effort tersimpan di scope asal provider (global), tanpa duplikat lokal", async () => {
    // Provider di global, config lokal ada (isi lain) — regresi shadowing:
    // effort wajib tertulis di file global, bukan salinan di lokal.
    await writeFile(
      globalPath,
      JSON.stringify({
        providers: [
          { id: "prov", baseUrl: "https://api.test/v1", apiKey: "k", models: ["o3-mini"] },
        ],
      }),
      "utf8",
    )
    await writeFile(
      localConfigPath(),
      JSON.stringify({
        providers: [{ id: "lokal", baseUrl: "https://lokal.test/v1", apiKey: "k", models: ["x"] }],
      }),
      "utf8",
    )
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({
      cwd: workspace,
      currentModel: "prov::o3-mini",
      setModelOverride: (m) => overrideLog.push(m),
    })
    await tty.ready()
    await tty.send(KEY.enter, 30)
    await tty.waitForOutput((out) => out.includes("Thinking effort"), 2000)
    await tty.send(KEY.down, 20) // low
    await tty.send(KEY.down, 20) // medium
    await tty.send(KEY.enter, 30)
    await p
    expect(overrideLog).toEqual(["prov::o3-mini"])
    const g = JSON.parse(await readFile(globalPath, "utf8")) as {
      providers: { id: string; reasoningEffort?: string }[]
    }
    expect(g.providers.find((x) => x.id === "prov")?.reasoningEffort).toBe("medium")
    const l = await readConfig(localConfigPath())
    expect(l.providers.some((x) => x.id === "prov")).toBe(false)
  })

  test("a menambah model ke provider via prompt berurutan", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({ cwd: workspace })
    await tty.ready()
    const seq = tty.answerSequence(["prov", "m3"], {
      expect: [(out) => out.includes("Provider > "), (out) => out.includes("Model > ")],
    })
    await tty.send(KEY.ctrlN, 30)
    await seq
    // Tunggu hasil tulis selesai (bukan cuma jawaban terkirim) — di mesin
    // berbeban IO config belum tentu flush saat seq resolve.
    await tty.waitForOutput((out) => out.includes("added prov::m3"), 5000)
    // Model baru harus tersimpan meski output terminal bisa berbeda antar host.
    expect((await readConfig(localConfigPath())).providers[0]?.models).toContain("m3")
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30)
    await p
  }, 5000)

  test("a dengan jawaban kosong tidak menambah apa pun", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({ cwd: workspace })
    await tty.ready()
    const seq = tty.answerSequence(["", ""], {
      expect: [(out) => out.includes("Provider > "), (out) => out.includes("Model > ")],
    })
    await tty.send(KEY.ctrlN, 30)
    await seq
    await tty.waitForOutput((out) => out.includes("Canceled"), 5000)
    expect((await readConfig(localConfigPath())).providers[0]?.models).not.toContain("m3")
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30)
    await p
  })

  test("d menghapus model ter-highlight setelah konfirmasi y", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({ cwd: workspace, currentModel: "prov::m1" })
    await tty.ready()
    const seq = tty.answerSequence(["y"], {
      expect: [(out) => out.includes("[y/N]")],
    })
    await tty.send(KEY.del, 30)
    await seq
    await tty.waitForOutput((out) => out.includes("deleted prov::m1"), 5000)
    expect((await readConfig(localConfigPath())).providers[0]?.models).not.toContain("m1")
    // Render terakhir tidak lagi menampilkan m1 (hanya m2 yang tersisa).
    const lastRender = visible().split("Models").at(-1) ?? ""
    expect(lastRender).toContain("prov::m2")
    expect(lastRender).not.toContain("prov::m1")
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30)
    await p
  })

  test("d dengan jawaban selain y membatalkan penghapusan", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({ cwd: workspace, currentModel: "prov::m1" })
    await tty.ready()
    const seq = tty.answerSequence(["n"], {
      expect: [(out) => out.includes("[y/N]")],
    })
    await tty.send(KEY.del, 30)
    await seq
    await tty.waitForOutput((out) => out.includes("Canceled"), 5000)
    expect((await readConfig(localConfigPath())).providers[0]?.models).toContain("m1")
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30)
    await p
  })

  test("up di batas atas + Esc di picker = tanpa perubahan model", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({
      cwd: workspace,
      currentModel: "cap::o3-mini",
      setModelOverride: (m) => overrideLog.push(m),
      initialFilter: "o3",
    })
    await tty.ready()
    await tty.send(KEY.up, 20) // sudah di atas (satu-satunya baris): tidak melewati 0
    await tty.send(KEY.enter, 30) // buka picker effort
    await tty.waitForOutput((out) => out.includes("Thinking effort"), 2000)
    await tty.send(KEY.esc, 30) // batal total
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30) // keluar mode cari
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30) // tutup manager
    await p
    expect(overrideLog).toEqual([])
  })

  test("Esc menutup tanpa mengubah model", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({
      cwd: workspace,
      setModelOverride: (m) => overrideLog.push(m),
    })
    await tty.ready()
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30)
    await p
    expect(overrideLog).toEqual([])
  })
})

describe("model-manager: daftar kosong", () => {
  test("pesan no models & Enter tanpa baris TIDAK menutup layar", async () => {
    // Config lokal diutamakan -- kosongkan keduanya.
    await writeFile(localConfigPath(), JSON.stringify({ providers: [] }), "utf8")
    await writeFile(globalPath, JSON.stringify({ providers: [] }), "utf8")
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({
      cwd: workspace,
      setModelOverride: (m) => overrideLog.push(m),
    })
    await tty.ready()
    expect(visible()).toContain("No models configured")
    // Enter di daftar kosong = no-op (footer bilang select, bukan close) —
    // dulu menutup layar; Esc tetap jalan untuk keluar.
    await tty.send(KEY.enter, 30)
    await tty.waitForListener(500)
    await tty.send(KEY.esc, 30)
    await p
    expect(overrideLog).toEqual([])
  })

  test("a + provider tak dikenal menampilkan error, bukan diam", async () => {
    // Regresi: add dengan Provider > typo dulu tak menambah apa pun TANPA
    // pesan — user mengira berhasil.
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({ cwd: workspace })
    await tty.ready()
    const seq = tty.answerSequence(["prov-typo", "m9"], {
      expect: [(out) => out.includes("Provider > "), (out) => out.includes("Model > ")],
    })
    await tty.send(KEY.ctrlN, 30)
    await seq
    await tty.waitForOutput((out) => out.includes("provider not found: prov-typo"), 5000)
    expect(visible()).toContain("provider not found: prov-typo")
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30)
    await p
  }, 5000)

  test("a dengan model yang SUDAH ADA bilang 'already exists', bukan 'added'", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({ cwd: workspace })
    await tty.ready()
    const seq = tty.answerSequence(["prov", "m1"], {
      expect: [(out) => out.includes("Provider > "), (out) => out.includes("Model > ")],
    })
    await tty.send(KEY.ctrlN, 30)
    await seq
    await tty.waitForOutput((out) => out.includes("already exists"), 5000)
    expect(visible()).toContain("already exists")
    expect(visible()).not.toContain("added prov::m1")
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30)
    await p
  }, 5000)

  test("Esc di prompt Provider > membatalkan add tanpa perubahan", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({ cwd: workspace })
    await tty.ready()
    await tty.send(KEY.ctrlN, 30)
    await tty.waitForOutput((out) => out.includes("Provider > "), 2000)
    await tty.send(KEY.esc, 30) // batal prompt (baris kosong)
    await tty.waitForOutput((out) => out.includes("Canceled"), 2000)
    expect((await readConfig(localConfigPath())).providers[0]?.models).toEqual(["m1", "m2"])
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30)
    await p
  }, 5000)

  test("menghapus model AKTIF memperingatkan di konfirmasi", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({ cwd: workspace, currentModel: "prov::m1" })
    await tty.ready()
    const seq = tty.answerSequence(["n"], {
      expect: [(out) => out.includes("Delete ACTIVE model prov::m1")],
    })
    await tty.send(KEY.del, 30)
    await seq
    expect((await readConfig(localConfigPath())).providers[0]?.models).toContain("m1")
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30)
    await p
  })
})

describe("model-manager: cari/filter", () => {
  // Buffer harness kumulatif — potong dari header render terakhir ("Models").
  const lastRender = () => {
    const a = stripAnsi(tty!.all())
    return a.slice(a.lastIndexOf("Models"))
  }

  test("filterModelRows: substring case-insensitive, kosong = semua", async () => {
    const { filterModelRows } = await import("../src/ui/screens/model-manager.ts")
    const rows = [
      { id: "openrouter::gpt-4o-mini", active: false },
      { id: "opencode-zen::mimo-v2.5-free", active: false },
      { id: "opencode-zen::Muse-Spark", active: true },
    ]
    expect(filterModelRows(rows, "").map((r) => r.id)).toHaveLength(3)
    expect(filterModelRows(rows, "mimo").map((r) => r.id)).toEqual(["opencode-zen::mimo-v2.5-free"])
    expect(filterModelRows(rows, "ZEN").map((r) => r.id)).toHaveLength(2)
    expect(filterModelRows(rows, "tak-ada")).toEqual([])
  })

  test("ketik langsung menyempitkan daftar; Esc keluar filter; Esc tutup", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({
      cwd: workspace,
      setModelOverride: (m) => overrideLog.push(m),
    })
    await tty.ready()
    await tty.send("m", 30)
    await tty.send("2", 30)
    await tty.waitForOutput((out) => out.includes("Filter:") && out.includes("(1/3)"), 2000)
    expect(lastRender()).toContain("prov::m2")
    expect(lastRender()).not.toContain("prov::m1")
    // Esc keluar mode cari (manager tetap terbuka).
    await tty.send(KEY.esc, 30)
    await tty.send(KEY.up, 30) // paksa render ulang tanpa mengubah state
    expect(lastRender()).not.toContain("Filter:")
    expect(lastRender()).toContain("prov::m1")
    // Esc kedua menutup manager tanpa memilih.
    await tty.send(KEY.esc, 30)
    await p
    expect(overrideLog).toEqual([])
  }, 8000)

  test("backspace mengedit query; Enter di filter memilih baris tersaring", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({
      cwd: workspace,
      setModelOverride: (m) => overrideLog.push(m),
    })
    await tty.ready()
    await tty.send("m", 30)
    await tty.send("x", 30) // tak cocok → "No models match"
    await tty.waitForOutput((out) => out.includes("No models match"), 2000)
    await tty.send(KEY.backspace, 30) // hapus x → "m" cocok keduanya
    await tty.waitForOutput((out) => out.includes("(3/3)"), 2000)
    await tty.send(KEY.backspace, 30) // query kosong → keluar mode cari
    await tty.send("o", 30)
    await tty.send("3", 30) // filter "o3" → tinggal cap::o3-mini (keluarga reasoning)
    await tty.waitForOutput((out) => out.includes("(1/3)"), 2000)
    expect(lastRender()).not.toContain("prov::m1")
    await tty.send(KEY.enter, 30) // pilih satu-satunya baris tersaring
    await tty.waitForOutput((out) => out.includes("Thinking effort"), 2000)
    await tty.send(KEY.esc, 30) // batal effort = batal total
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30) // keluar mode cari
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30) // tutup manager
    await p
    expect(overrideLog).toEqual([])
  }, 10000)

  test("/model <cari> membuka manager dengan filter awal", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({
      cwd: workspace,
      setModelOverride: (m) => overrideLog.push(m),
      initialFilter: "m2",
    })
    await tty.ready()
    await tty.waitForOutput((out) => out.includes("Filter:") && out.includes("(1/3)"), 2000)
    await tty.send(KEY.esc, 30) // keluar mode cari
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30) // tutup manager
    await p
    expect(overrideLog).toEqual([])
  }, 8000)

  test("ketik diawali a/d juga menyaring (bukan shortcut tambah/hapus)", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({
      cwd: workspace,
      setModelOverride: (m) => overrideLog.push(m),
    })
    await tty.ready()
    // "a1": a/d kecil BUKAN lagi shortcut — langsung jadi query.
    // Regresi laporan user: ketik huruf malah membuka prompt "Provider > ".
    await tty.send("a", 30)
    await tty.send("1", 30)
    await tty.waitForOutput((out) => out.includes("Filter:") && out.includes("a1"), 2000)
    expect(lastRender()).not.toContain("Provider > ")
    expect(lastRender()).toContain("No models match")
    // Ctrl+N tetap membuka tambah, Del tetap menghapus (lihat test lain).
    await tty.send(KEY.esc, 30) // keluar mode cari
    await tty.send(KEY.up, 30)
    expect(lastRender()).not.toContain("Filter:")
    await tty.send(KEY.esc, 30) // tutup manager
    await p
    expect(overrideLog).toEqual([])
  }, 8000)
})
