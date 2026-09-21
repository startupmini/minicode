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
import { displayWidth } from "../src/ui/render/width.ts"
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
})

describe("model-manager: alur interactive", () => {
  test("lebar kotak TETAP 64 saat navigasi/filter/effort (tak melompat)", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const p = runModelManager({ cwd: workspace, currentModel: "prov::m1" })
    await tty.ready()
    const boxW = () => {
      const top = tty!.screen().find((l) => l.includes("┌")) ?? ""
      return displayWidth(top.trimStart())
    }
    expect(boxW()).toBe(64)
    // Navigasi: seleksi pindah, geometri diam.
    await tty.send(KEY.down)
    expect(boxW()).toBe(64)
    await tty.send(KEY.down) // cap::o3-mini
    expect(boxW()).toBe(64)
    // Effort picker (kotak lain) dibuka lalu dibatalkan → kembali 64.
    await tty.send(KEY.enter, 30)
    await tty.waitForOutput((o) => o.includes("Thinking effort"), 2000)
    await tty.send(KEY.esc, 80)
    await tty.waitForOutput((o) => o.includes("prov::m1"), 2000)
    expect(boxW()).toBe(64)
    // Filter menyusutkan daftar → lebar tetap.
    await tty.send("cap")
    expect(boxW()).toBe(64)
    await tty.send(KEY.esc, 80) // keluar filter
    expect(boxW()).toBe(64)
    await tty.send(KEY.esc, 30) // tutup manager
    await p
  }, 8000)

  test("kursor diparkir di ujung baris search (bukan judul)", async () => {
    // Gagal-di-kode-lama: parkir di baris judul (off-by-one; judul "Models"
    // ditambah belakangan tanpa update offset) lalu di ujung baris (void).
    // Benar: tepat sebelum penanda █ tempat ketikan menempel.
    tty = installFakeTty({ columns: 100, rows: 24 })
    const p = runModelManager({ cwd: workspace, currentModel: "prov::m1" })
    await tty.ready()
    const frame = tty.screen()
    const top0 = frame.findIndex((l) => l.includes("┌"))
    const srow = frame[top0 + 2] ?? ""
    const m = /^ */.exec(srow)
    const leftPad = m ? m[0].length : 0
    // Baris search body[0]: padding + border + spasi + "> " + filter(0) + 1.
    const row = top0 + 1 + 2
    const col = Math.max(1, Math.min(100, leftPad + 2 + 2 + 0 + 1))
    expect(srow).toContain(">")
    expect(tty.all()).toContain(`\x1b[${row};${col}H`)
    await tty.send(KEY.esc, 30)
    await p
  }, 8000)

  test("render awal menampilkan daftar model + tanda active", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({ cwd: workspace, currentModel: "prov::m2" })
    await tty.ready()
    const out = visible()
    // Tanpa judul (dialog mungil): daftar + active cukup membuktikan render.
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
    // Settle >50ms: lone-ESC flush input.ts — Esc berikut ditujukan ke manager
    // yang baru resume, bukan ke picker yang sedang menutup.
    await tty.send(KEY.esc, 80) // batal: kembali ke daftar, tanpa select
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

  test("Ctrl+N diabaikan (fungsi tambah dihapus)", async () => {
    // Fungsi tambah model via Ctrl+N dihapus dari /model (tambah via edit
    // config atau /provider). Kode lama: membuka prompt "Provider > ".
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({ cwd: workspace })
    await tty.ready()
    await tty.send(KEY.ctrlN, 30)
    await tty.send(KEY.ctrlN, 30)
    // Tak ada prompt tambah yang terbuka + manager tetap interaktif.
    expect(visible()).not.toContain("Provider > ")
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30)
    await p
    expect((await readConfig(localConfigPath())).providers[0]?.models).toEqual(["m1", "m2"])
    expect(overrideLog).toEqual([])
  }, 5000)

  test("d menghapus model ter-highlight setelah konfirmasi y", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({ cwd: workspace, currentModel: "prov::m1" })
    await tty.ready()
    await tty.send(KEY.del, 30)
    await tty.waitForOutput((out) => out.includes("Delete model"), 2000)
    await tty.send("y")
    await tty.send(KEY.enter, 30)
    await tty.waitForOutput((out) => out.includes("deleted prov::m1"), 5000)
    expect((await readConfig(localConfigPath())).providers[0]?.models).not.toContain("m1")
    // Render terakhir: daftar tanpa m1. Struk "deleted" tampil sebagai notice
    // (ikut terhapus saat Up me-render ulang) — baca frame segar.
    tty.clear()
    await tty.send(KEY.up, 30)
    const fresh = stripAnsi(tty!.all())
    expect(fresh).toContain("prov::m2")
    expect(fresh).not.toContain("prov::m1")
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30)
    await p
  })

  test("d dengan jawaban selain y membatalkan penghapusan", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({ cwd: workspace, currentModel: "prov::m1" })
    await tty.ready()
    await tty.send(KEY.del, 30)
    await tty.waitForOutput((out) => out.includes("Delete model"), 2000)
    await tty.send("n")
    await tty.send(KEY.enter, 30)
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
    // Settle >50ms (lone-ESC flush): Esc berikut ke manager, bukan ke picker.
    await tty.send(KEY.esc, 80) // batal total
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

  test("menghapus model AKTIF memperingatkan di konfirmasi", async () => {
    tty = installFakeTty({ rows: 24 })
    const p = runModelManager({ cwd: workspace, currentModel: "prov::m1" })
    await tty.ready()
    await tty.send(KEY.del, 30)
    await tty.waitForOutput((out) => out.includes("Delete ACTIVE model"), 2000)
    await tty.send("n")
    await tty.send(KEY.enter, 30)
    expect((await readConfig(localConfigPath())).providers[0]?.models).toContain("m1")
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30)
    await p
  })
})

describe("model-manager: cari/filter", () => {
  // Buffer harness kumulatif — baca frame TERKINI: clear lalu picu render
  // ulang via Up (clamp di batas, aman: hanya keanggotaan baris yang
  // di-assert, bukan posisi highlight).
  const freshFrame = async () => {
    tty!.clear()
    await tty!.send(KEY.up, 30)
    return stripAnsi(tty!.all())
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
    await tty.waitForOutput((out) => out.includes("prov::m2"), 2000)
    // Baris cari kilat menampilkan query (tanpa label/hitungan).
    expect(await freshFrame()).toContain("> m2")
    const filtered = await freshFrame()
    expect(filtered).toContain("prov::m2")
    expect(filtered).not.toContain("prov::m1")
    // Esc keluar mode cari (manager tetap terbuka).
    await tty.send(KEY.esc, 30)
    const restored = await freshFrame()
    expect(restored).toContain("prov::m1")
    expect(restored).toContain("prov::m2")
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
    await tty.send(KEY.backspace, 30) // hapus x → "m" cocok ketiganya
    const all = await freshFrame()
    expect(all).toContain("prov::m1")
    expect(all).toContain("prov::m2")
    expect(all).toContain("cap::o3-mini")
    await tty.send(KEY.backspace, 30) // query kosong → keluar mode cari
    await tty.send("o", 30)
    await tty.send("3", 30) // filter "o3" → tinggal cap::o3-mini (keluarga reasoning)
    const one = await freshFrame()
    expect(one).toContain("cap::o3-mini")
    expect(one).not.toContain("prov::m1")
    await tty.send(KEY.enter, 30) // pilih satu-satunya baris tersaring
    await tty.waitForOutput((out) => out.includes("Thinking effort"), 2000)
    // Settle >50ms (lone-ESC flush): Esc berikut ke manager, bukan ke picker.
    await tty.send(KEY.esc, 80) // batal effort = batal total
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
    const init = await freshFrame()
    expect(init).toContain("> m2")
    expect(init).toContain("prov::m2")
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
    const nomatch = await freshFrame()
    expect(nomatch).not.toContain("Provider > ")
    expect(nomatch).toContain("No models match")
    // Del tetap menghapus (lihat test lain); tambah via Ctrl+N dihapus.
    await tty.send(KEY.esc, 30) // keluar mode cari
    const restored = await freshFrame()
    expect(restored).toContain("prov::m1")
    await tty.send(KEY.esc, 30) // tutup manager
    await p
    expect(overrideLog).toEqual([])
  }, 8000)
})

describe("model-manager view: Enter gagal tidak menutup manager", () => {
  test("onSelect melempar → pesan tampil + daftar tetap terbuka (bisa Esc)", async () => {
    // Audit TUI P2: kode lama finish() (tutup) saat onSelect/onSetEffort
    // melempar — konteks daftar hilang. Kode baru resume() untuk retry.
    const { runModelManagerView } = await import("../src/ui/screens/model-manager.ts")
    tty = installFakeTty({ rows: 24 })
    const p = runModelManagerView({
      initialRows: [{ id: "a::m", active: true }],
      getEfforts: () => ["default"], // tanpa thinking → select langsung
      onSelect: () => {
        throw new Error("simpan gagal")
      },
      loadRows: async () => [{ id: "a::m", active: true }],
      onDelete: async () => [{ id: "a::m", active: true }],
    })
    await tty.ready()
    await tty.send(KEY.enter, 60)
    await tty.waitForOutput((out) => out.includes("simpan gagal"), 2000)
    // Manager TETAP terbuka (kode lama: listener dilepas → waitForListener
    // timeout 2 dtk → test gagal di kode lama).
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 80)
    await p
  }, 8000)

  test("onSelect gantung → watchdog pulih dalam batas (UI tak mati)", async () => {
    // Gagal-di-kode-lama: network non-kooperatif saat suspend = popup mati
    // (tanpa listener/timer). Watchdog: notice timeout + UI interaktif lagi.
    const { runModelManagerView } = await import("../src/ui/screens/model-manager.ts")
    tty = installFakeTty({ rows: 24 })
    let resolveHung!: () => void
    const hung = new Promise<void>((r) => (resolveHung = r))
    const p = runModelManagerView({
      initialRows: [{ id: "a::m", active: true }],
      getEfforts: () => ["default"],
      onSelect: () => hung,
      loadRows: async () => [{ id: "a::m", active: true }],
      onDelete: async () => [{ id: "a::m", active: true }],
      actionTimeoutMs: 300,
    })
    await tty.ready()
    await tty.send(KEY.enter, 60)
    await tty.waitForOutput((out) => out.includes("timed out"), 5000)
    // UI pulih: listener kembali, Esc menutup normal.
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 80)
    await p
    resolveHung()
  }, 8000)

  test("PgDn/PgUp/Home/End navigasi daftar panjang", async () => {
    // Gagal-di-kode-lama: kondisi paging memakai panjang list sebagai jatah
    // visible → selalu false → PgDn mati. 12 baris, jatah 8.
    const { runModelManagerView } = await import("../src/ui/screens/model-manager.ts")
    tty = installFakeTty({ rows: 24 })
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `m${String(i).padStart(2, "0")}`,
      active: i === 0,
    }))
    let picked = ""
    const p = runModelManagerView({
      initialRows: rows,
      getEfforts: () => ["default"],
      onSelect: (id) => {
        picked = id
      },
      loadRows: async () => rows,
      onDelete: async () => rows,
    })
    await tty.ready()
    await tty.send(KEY.pgDown)
    await tty.send(KEY.pgDown)
    await tty.send(KEY.enter, 60)
    await p
    expect(picked).not.toBe("m00")
  }, 8000)
})
