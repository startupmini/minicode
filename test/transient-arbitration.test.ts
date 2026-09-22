// Arbitrase terminal transient (statusline.ts): satu owner transient stderr
// pada satu waktu; tulis ASING (non-UI: router/providers/tool warnings) saat
// painter aktif dikomit sebagai baris permanen — tidak hilang tertimpa tick.
// Plus invariant mutual exclusion turn-painter vs wizard-spinner.

import { afterEach, describe, expect, test } from "bun:test"
import { attachTurnStatus, type TurnStatusHandle } from "../src/ui/assistant/turn-status.ts"
import { askLine } from "../src/ui/input/input.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { createSpinner } from "../src/ui/runtime/spinner.ts"
import { beginInteractiveScreen, isTransientPainting } from "../src/ui/runtime/statusline.ts"
import { runPicker } from "../src/ui/screens/picker.ts"
import { createFakeBus, type FakeTty, installFakeTty, KEY } from "./helpers/tui-harness.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ESC = String.fromCharCode(27)
const CONTROL_RE = new RegExp(`[${String.fromCharCode(0x0d)}${ESC}]`)

let tty: FakeTty | undefined

afterEach(() => {
  tty?.restore()
  tty = undefined
})

function startTurnPainter(): { bus: ReturnType<typeof createFakeBus>; status: TurnStatusHandle } {
  tty = installFakeTty({ columns: 80, rows: 24 })
  const bus = createFakeBus()
  const status = attachTurnStatus(bus as never)
  bus.emit("turn:started", { turn: 1 })
  bus.emit("execution:started", {
    execution: { call: { name: "bash", args: { cmd: "npm test" } } },
  })
  return { bus, status }
}

describe("transient arbitration", () => {
  test("tulis asing saat painter aktif dikomit sebagai baris permanen + repaint", async () => {
    const { status } = startTurnPainter()
    await sleep(60)
    tty!.clear()
    // Simulasi penulis non-UI (mis. [warn] dari tool/router) — tulis MENTAH.
    process.stderr.write("[warn] provider x slow\n")
    const raw = tty!.allErr()
    // Dikomit bersih: garis transient dihapus dulu, lalu pesan utuh.
    expect(raw).toContain(`${ESC}[2K[warn] provider x slow`)
    // Painter hidup lagi setelah tulis asing (bukan mati / kehilangan label).
    await sleep(400)
    expect(tty!.allErr()).toContain("bash npm test")
    status.detach()
  }, 4000)

  test("foreign write saat painter aktif TIDAK hilang walau banyak tick", async () => {
    const { status } = startTurnPainter()
    await sleep(60)
    tty!.clear()
    process.stderr.write("[warn] leak-check\n")
    await sleep(500) // banyak tick repaint — pesan harus tetap ada di scrollback
    expect(tty!.allErr()).toContain("[warn] leak-check")
    status.detach()
  }, 4000)

  test("spinner saat turn-painter aktif: warning overlap, tanpa crash", async () => {
    const { status } = startTurnPainter()
    await sleep(60)
    tty!.clear()
    const s = createSpinner("mendeteksi")
    expect(isTransientPainting()).toBe(true)
    expect(tty!.allErr()).toContain("[transient-paint] spinner starts while turn active")
    s.success("selesai")
    await sleep(250)
    // Tidak ada sisa frame animasi setelah stop (tidak ada \r baru).
    const tail = tty!.allErr().split("\n").slice(-4).join("\n")
    expect(tail).not.toContain("\r·")
    status.detach()
  }, 4000)

  test("layar interaktif: painter stderr berhenti selama picker hidup", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const spin = createSpinner("Menyiapkan sesi…")
    await sleep(60)
    expect(tty.allErr()).toContain("Menyiapkan sesi")
    tty.clear()
    // Objek (bukan `let`) agar narrowing TS tak mengunci nilai ke null saat
    // callback dipanggil.
    const picked: { value: string | null } = { value: null }
    const p = runPicker({
      title: "Select gateway",
      items: [{ name: "DeepSeek", provider: "", value: "https://api.deepseek.com" }],
      onPick: (v) => {
        picked.value = v
      },
      onCancel: () => {
        picked.value = null
      },
    })
    await tty.ready()
    // >2 interval spinner: tanpa guard, stderr penuh frame `\r\x1b[2K` yang
    // menghapus baris picker — keluhan asli: prompt wizard tak terlihat dan
    // CLI tampak macet di "Menyiapkan sesi…".
    await sleep(400)
    expect(tty.allErr()).not.toContain("Menyiapkan sesi")
    // Isi layar tetap utuh di stdout pada periode yang sama.
    expect(stripAnsi(tty.all())).toContain("Select gateway")
    await tty.send(KEY.enter, 40)
    await p
    expect(picked.value).toBe("https://api.deepseek.com")
    // Layar lepas → painter hidup lagi (interval-nya tidak pernah dimatikan).
    await sleep(250)
    expect(tty.allErr()).toContain("Menyiapkan sesi")
    spin.stop()
  }, 5000)

  test("layar interaktif: prompt askLine terlihat, spinner tak menimpanya", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const spin = createSpinner("Menyiapkan sesi…")
    await sleep(60)
    tty.clear()
    const p = askLine({ prompt: "Base URL: ", history: [], idleMs: 0 })
    await tty.ready()
    await sleep(300)
    expect(tty.allErr()).not.toContain("Menyiapkan sesi")
    expect(stripAnsi(tty.all())).toContain("Base URL")
    await tty.send("https://x.test\r", 40)
    await expect(p).resolves.toBe("https://x.test")
    await sleep(250)
    expect(tty.allErr()).toContain("Menyiapkan sesi")
    spin.stop()
  }, 5000)

  test("layar bertumpuk: painter hidup hanya setelah release terakhir", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const spin = createSpinner("Menyiapkan sesi…")
    await sleep(60)
    tty.clear()
    const outer = beginInteractiveScreen()
    const inner = beginInteractiveScreen()
    // Release idempoten: dobel-release (cleanup + finally) tak boleh membuat
    // depth negatif — kalau iya, layar berikutnya tak lagi menahan painter.
    outer()
    outer()
    await sleep(300)
    expect(tty.allErr()).not.toContain("Menyiapkan sesi")
    inner()
    await sleep(250)
    expect(tty.allErr()).toContain("Menyiapkan sesi")
    spin.stop()
  }, 5000)

  test("garis status turn ikut diam selama layar interaktif aktif", async () => {
    const { status } = startTurnPainter()
    await sleep(60)
    tty!.clear()
    const end = beginInteractiveScreen()
    await sleep(400)
    expect(tty!.allErr()).not.toContain("bash npm test")
    end()
    await sleep(300)
    expect(tty!.allErr()).toContain("bash npm test")
    status.detach()
  }, 5000)

  test("delayMs: nol byte sebelum delay, frame setelahnya, stop idempoten", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const spin = createSpinner("Checking for updates…", { delayMs: 120, intervalMs: 40 })
    await sleep(60)
    expect(tty.allErr()).not.toContain("Checking")
    await sleep(220)
    expect(tty.allErr()).toContain("Checking")
    spin.stop()
    spin.stop()
    const frames = tty.allErr().split("Checking").length
    await sleep(150)
    expect(tty.allErr().split("Checking").length).toBe(frames)
  }, 5000)

  test("non-TTY: attach & spinner tidak menghasilkan byte kontrol apa pun", async () => {
    tty = installFakeTty({ isTTY: false })
    const bus = createFakeBus()
    const status = attachTurnStatus(bus as never)
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: {} })
    bus.emit("execution:started", {
      execution: { call: { name: "grep", args: { path: "src" } } },
    })
    const s = createSpinner("mendeteksi")
    s.update("mendeteksi ulang")
    s.success("selesai")
    status.detach()
    const raw = tty!.allErr()
    expect(raw).not.toMatch(CONTROL_RE)
    expect(stripAnsi(raw)).toContain("selesai")
  }, 4000)
})
