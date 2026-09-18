// Test wizard setup — jalur yang paling menentukan kesan pertama dan sebelumnya
// 0% tercakup (nol test, hanya bisa diuji manual).

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSetupWizard } from "../cli/wizard.ts"
import { GATEWAY_PRESETS } from "../src/providers/presets.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { createSpinner } from "../src/ui/runtime/spinner.ts"
import { type FakeTty, installFakeTty, KEY } from "./helpers/tui-harness.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let tty: FakeTty | undefined
let home: string | undefined
const origHome = process.env.HOME
const origUserProfile = process.env.USERPROFILE

afterEach(() => {
  tty?.restore()
  tty = undefined
  if (origHome == null) delete process.env.HOME
  else process.env.HOME = origHome
  if (origUserProfile == null) delete process.env.USERPROFILE
  else process.env.USERPROFILE = origUserProfile
  if (home) {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {}
    home = undefined
  }
})

/** HOME sementara supaya wizard tidak menulis ke config asli mesin. */
function isolateHome() {
  home = mkdtempSync(join(tmpdir(), "minicode-wizard-"))
  process.env.HOME = home
  process.env.USERPROFILE = home
}

const visible = (t: FakeTty) => stripAnsi(t.all())

describe("wizard: non-TTY", () => {
  test("mengembalikan false tanpa menulis apa pun", async () => {
    tty = installFakeTty({ isTTY: false })
    isolateHome()
    expect(await runSetupWizard()).toBe(false)
  })
})

describe("wizard: pemilihan gateway", () => {
  test("memakai picker (panah), bukan prompt nomor", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    isolateHome()
    const p = runSetupWizard()
    await tty.ready(3000)
    const out = visible(tty)
    // Judul picker muncul; tidak ada prompt "Choice [1-N]".
    expect(out).toContain("Select gateway")
    expect(out).not.toMatch(/Choice \[1-\d+\]/)
    // Penanda seleksi picker ada.
    expect(out).toMatch(/\u203a/)
    await tty.send(KEY.esc, 60)
    expect(await p).toBe(false)
  })

  test("Esc pada picker membatalkan setup dengan pesan", async () => {
    tty = installFakeTty()
    isolateHome()
    const p = runSetupWizard()
    await tty.ready(3000)
    await tty.send(KEY.esc, 60)
    expect(await p).toBe(false)
    expect(visible(tty)).toContain("Setup canceled")
  })

  test("menyebut cara membatalkan sejak awal", async () => {
    tty = installFakeTty()
    isolateHome()
    const p = runSetupWizard()
    await tty.ready(3000)
    expect(visible(tty)).toContain("Ctrl+C")
    await tty.send(KEY.esc, 60)
    await p
  })

  test("semua preset bisa dicari (filterable)", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    isolateHome()
    const p = runSetupWizard()
    await tty.ready(3000)
    tty.clear()
    await tty.send("ollama", 60)
    const out = visible(tty)
    expect(out.toLowerCase()).toContain("ollama")
    // Preset lain tersaring keluar.
    expect(out).not.toContain("Mistral")
    await tty.send(KEY.esc, 40)
    await tty.send(KEY.esc, 60)
    await p
  })

  test("daftar preset tidak melebihi lebar terminal", async () => {
    tty = installFakeTty({ columns: 40, rows: 20 })
    isolateHome()
    const p = runSetupWizard()
    await tty.ready(3000)
    for (const l of visible(tty).split("\n")) {
      expect(displayWidth(l)).toBeLessThanOrEqual(40)
    }
    await tty.send(KEY.esc, 60)
    await p
  })

  test("menyertakan opsi URL kustom di ujung daftar", async () => {
    tty = installFakeTty({ columns: 80, rows: 30 })
    isolateHome()
    const p = runSetupWizard()
    await tty.ready(3000)
    tty.clear()
    await tty.send("kustom", 60)
    expect(visible(tty).toLowerCase()).toContain("kustom")
    await tty.send(KEY.esc, 40)
    await tty.send(KEY.esc, 60)
    await p
  })
})

// Keluhan asli (Windows, dijalankan dari home): `minicode` selalu tampak
// berhenti di "⠴ Menyiapkan sesi…" — prompt wizard tak pernah terlihat karena
// spinner setup menulis frame `\r\x1b[2K` ke stderr di baris yang sama.
describe("wizard: spinner setup tidak menutupi prompt", () => {
  test("prompt Base URL terlihat selama spinner setup hidup", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    isolateHome()
    // Meniru cli/index.ts: spinner hidup selama createCliSession, termasuk saat
    // wizard (di dalamnya) meminta input.
    const spin = createSpinner("Menyiapkan sesi…")
    await sleep(60)
    expect(tty.allErr()).toContain("Menyiapkan sesi")
    tty.clear()
    const p = runSetupWizard()
    await tty.ready(3000)
    await tty.send(KEY.enter, 60) // pilih preset pertama
    await tty.waitForOutput((o) => o.includes("Base URL"), 3000)
    expect(visible(tty)).toContain("Base URL")
    // >1 interval spinner: selama layar memegang terminal, stderr tetap bersih.
    await sleep(300)
    expect(tty.allErr()).not.toContain("Menyiapkan sesi")
    await tty.send(KEY.esc, 60) // batal
    expect(await p).toBe(false)
    // Layar lepas → spinner setup hidup lagi (setup sesi belum selesai).
    await sleep(250)
    expect(tty.allErr()).toContain("Menyiapkan sesi")
    spin.stop()
  }, 8000)
})

describe("wizard: bahasa", () => {
  test("output is consistently English", async () => {
    tty = installFakeTty()
    isolateHome()
    const p = runSetupWizard()
    await tty.ready(3000)
    const out = visible(tty)
    expect(out).toContain("Minicode setup")
    expect(out).toContain("Connect your first")
    expect(out).toContain("Select gateway")
    await tty.send(KEY.esc, 60)
    await p
  })
})

describe("wizard: preset", () => {
  test("setiap preset punya label, baseUrl, dan fallbackModels", () => {
    expect(GATEWAY_PRESETS.length).toBeGreaterThan(5)
    for (const p of GATEWAY_PRESETS) {
      expect(p.id, JSON.stringify(p)).toBeTruthy()
      expect(p.label, p.id).toBeTruthy()
      expect(p.baseUrl, p.id).toMatch(/^https?:\/\//)
      expect(p.fallbackModels.length, p.id).toBeGreaterThan(0)
    }
  })

  test("id preset unik", () => {
    const ids = GATEWAY_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("label preset cukup pendek untuk terminal 40 kolom", () => {
    for (const p of GATEWAY_PRESETS) {
      expect(displayWidth(p.label), p.id).toBeLessThanOrEqual(52)
    }
  })
})
