// Invarian aliran stdin: TTY mengalir seumur proses interaktif — TIDAK ADA
// pause() mid-session. Latar: siklus pause→resume berulang mematikan
// pengiriman 'data' selamanya di Bun Windows (daftar tampil tapi semua
// tombol mati, bahkan Ctrl+C). Kepemilikan = siapa yang memegang listener;
// pause hanya di teardown sesi (close()).
//
// Tiap test memata-matai pause() selama satu siklus UI penuh: kode lama
// memanggilnya tepat sekali (askLine/askSecret/picker/manager suspend +
// repl finally) sehingga semuanya gagal di kode lama.

import { afterEach, describe, expect, test } from "bun:test"
import { runPicker } from "../src/ui/screens/picker.ts"
import { installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
})

/** Hitung pemanggilan pause() pada stdin aktif (fake TTY). */
function spyPause(): { count: () => number } {
  const stdin = process.stdin as unknown as { pause: () => unknown }
  const orig = stdin.pause.bind(stdin)
  let n = 0
  stdin.pause = () => {
    n++
    return orig()
  }
  return { count: () => n }
}

async function settled<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("hang: tak resolve")), 2000)),
  ])
}

describe("stdin mengalir: tanpa pause mid-session", () => {
  test("askLine submit tanpa pause", async () => {
    tty = installFakeTty()
    const spy = spyPause()
    const { askLine } = await import("../src/ui/input/input.ts")
    const p = askLine({ prompt: "> ", history: [], idleMs: 0 })
    await tty.ready()
    await tty.send("halo")
    await tty.send(KEY.enter, 30)
    await expect(settled(p)).resolves.toBe("halo")
    expect(spy.count()).toBe(0)
  })

  test("askLine batal tanpa pause", async () => {
    tty = installFakeTty()
    const spy = spyPause()
    const { askLine } = await import("../src/ui/input/input.ts")
    const p = askLine({ prompt: "> ", history: [], idleMs: 0 })
    await tty.ready()
    await tty.send(KEY.ctrlC, 20)
    await expect(settled(p)).resolves.toBeNull()
    expect(spy.count()).toBe(0)
  })

  test("askSecret submit tanpa pause", async () => {
    tty = installFakeTty()
    const spy = spyPause()
    const { askSecret } = await import("../src/ui/input/input.ts")
    const p = askSecret("key: ", { idleMs: 0 })
    await tty.ready()
    await tty.send("s3cr3t")
    await tty.send(KEY.enter, 30)
    await expect(settled(p)).resolves.toBe("s3cr3t")
    expect(spy.count()).toBe(0)
  })

  test("picker Esc tanpa pause", async () => {
    tty = installFakeTty()
    const spy = spyPause()
    let canceled = false
    const p = runPicker({
      title: "t",
      items: [{ name: "a", provider: "", value: "a" }],
      onPick: () => {},
      onCancel: () => {
        canceled = true
      },
    })
    await tty.ready()
    await tty.send(KEY.esc, 20)
    await settled(p)
    expect(canceled).toBe(true)
    expect(spy.count()).toBe(0)
  })

  test("model-manager buka→Esc tanpa pause", async () => {
    tty = installFakeTty()
    const spy = spyPause()
    const { runModelManagerView } = await import("../src/ui/screens/model-manager.ts")
    const p = runModelManagerView({
      initialRows: [{ id: "a::m", active: true }],
      onSelect: () => {},
      loadRows: async () => [{ id: "a::m", active: true }],
      onAdd: async () => [{ id: "a::m", active: true }],
      onDelete: async () => [{ id: "a::m", active: true }],
    })
    await tty.ready()
    await tty.send(KEY.esc, 20)
    await settled(p)
    expect(spy.count()).toBe(0)
  })

  test("provider-manager buka→Esc tanpa pause", async () => {
    tty = installFakeTty()
    const spy = spyPause()
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
    await settled(p)
    expect(spy.count()).toBe(0)
  })

  test("komposisi askLine→picker→askLine tanpa pause sama sekali", async () => {
    tty = installFakeTty()
    const spy = spyPause()
    const { askLine } = await import("../src/ui/input/input.ts")
    const p1 = askLine({ prompt: "> ", history: [], idleMs: 0 })
    await tty.ready()
    await tty.send("satu")
    await tty.send(KEY.enter, 30)
    await expect(settled(p1)).resolves.toBe("satu")
    const p2 = runPicker({
      title: "t",
      items: [{ name: "a", provider: "", value: "a" }],
      onPick: () => {},
      onCancel: () => {},
    })
    await tty.waitForListener()
    await tty.send(KEY.esc, 20)
    await settled(p2)
    const p3 = askLine({ prompt: "> ", history: [], idleMs: 0 })
    await tty.waitForListener()
    await tty.send("dua")
    await tty.send(KEY.enter, 30)
    await expect(settled(p3)).resolves.toBe("dua")
    expect(spy.count()).toBe(0)
  })
})
