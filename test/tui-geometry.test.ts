// Geometri popup TETAP (kontrak I20/I25): lebar kotak identik di semua frame
// (navigasi, filter, select, error) — tak bernapas. Gagal-di-kode-lama:
// lebar dinamis mengikuti konten membuat kotak melompat.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runModelManager } from "../cli/model-manager.ts"
import { runSetupWizard } from "../cli/wizard.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { runForm } from "../src/ui/screens/form.ts"
import { runPicker } from "../src/ui/screens/picker.ts"
import { installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null
let home: string | undefined
const origHome = process.env.HOME
const origUserProfile = process.env.USERPROFILE

beforeEach(() => setSessionLocale("en"))
afterEach(() => {
  tty?.restore()
  tty = null
  resetAltScreenDepth()
  resetLocaleState()
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

const boxW = (): number => {
  const top = tty!.screen().find((l) => l.includes("┌")) ?? ""
  return displayWidth(top.trimStart())
}

function isolateHome() {
  home = mkdtempSync(join(tmpdir(), "minicode-geo-"))
  process.env.HOME = home
  process.env.USERPROFILE = home
}

describe("geometri popup tetap", () => {
  test("picker: filter panjang/kosong — lebar tetap 64", async () => {
    tty = installFakeTty({ columns: 100, rows: 20 })
    isolateHome()
    const p = runPicker({
      title: "Geo",
      filterable: true,
      items: [{ name: "a", provider: "", value: "a" }],
      onPick: () => {},
      onCancel: () => {},
    })
    await tty!.ready()
    expect(boxW()).toBe(64)
    await tty!.send("query-yang-sangat-panjang-sekali")
    expect(boxW()).toBe(64)
    await tty!.send(KEY.backspace, 30)
    expect(boxW()).toBe(64)
    // Esc dua-tahap: tekan-1 clear filter, tekan-2 keluar.
    await tty!.send(KEY.esc, 90)
    await tty!.send(KEY.esc, 90)
    await p
  })
  test("form: error muncul/hilang — lebar tetap 64", async () => {
    tty = installFakeTty({ columns: 100, rows: 20 })
    const s = await import("../src/ui/runtime/screen.ts")
    const screen = s.openAltScreen()
    const p = runForm(
      {
        title: "Geo",
        fields: [
          { id: "a", label: "A", kind: "text", validate: (v) => (v.trim() ? null : "required") },
        ],
      },
      screen,
    )
    await tty!.ready()
    expect(boxW()).toBe(64)
    // Error inline muncul — geometri diam.
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("required"))
    expect(boxW()).toBe(64)
    await tty!.send("x")
    expect(boxW()).toBe(64)
    await tty!.send(KEY.esc, 90)
    await tty!.send(KEY.esc, 90)
    await p
    screen.close()
  })
  test("model-manager: navigasi + filter — lebar tetap 64", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const ws = mkdtempSync(join(tmpdir(), "minicode-geo-mm-"))
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs")
      mkdirSync(join(ws, ".minicode"), { recursive: true })
      writeFileSync(
        join(ws, ".minicode", "config.json"),
        JSON.stringify({
          providers: [
            { id: "prov", baseUrl: "https://a.test/v1", apiKey: "k", models: ["m1", "m2"] },
          ],
        }),
        "utf8",
      )
      const p = runModelManager({ cwd: ws })
      await tty!.ready()
      expect(boxW()).toBe(64)
      await tty!.send(KEY.down)
      expect(boxW()).toBe(64)
      await tty!.send("prov")
      expect(boxW()).toBe(64)
      await tty!.send(KEY.esc, 90)
      expect(boxW()).toBe(64)
      await tty!.send(KEY.esc, 30)
      await p
    } finally {
      try {
        rmSync(ws, { recursive: true, force: true })
      } catch {}
    }
  })
  test("wizard: step ke step — lebar tetap 64 (picker dan form)", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    isolateHome()
    const p = runSetupWizard()
    await tty!.ready(3000)
    // Step 1: picker gateway.
    expect(boxW()).toBe(64)
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("Base URL"))
    // Step 2: form URL — kotak sama 64.
    expect(boxW()).toBe(64)
    await tty!.send(KEY.esc, 90)
    await tty!.send(KEY.esc, 90)
    await p
  })
})
