// Form dalam popup (src/ui/screens/form.ts): SEMUA input terjadi di dalam
// kotak — tidak satu piksel pun di luar. Gagal-di-kode-lama: add/edit
// provider memakai askLine/console.log di luar kotak.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { openAltScreen, resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { runForm } from "../src/ui/screens/form.ts"
import { installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null
beforeEach(() => setSessionLocale("en"))
afterEach(() => {
  tty?.restore()
  tty = null
  resetAltScreenDepth()
  resetLocaleState()
})

function screen() {
  tty = installFakeTty({ columns: 70, rows: 20 })
  return openAltScreen()
}

describe("runForm", () => {
  test("isi dua field + Enter = submit values", async () => {
    const s = screen()
    const p = runForm(
      {
        title: "Add",
        fields: [
          { id: "url", label: "URL", kind: "text" },
          { id: "key", label: "Key", kind: "secret" },
        ],
      },
      s,
    )
    await tty!.ready()
    await tty!.send("https://a.example")
    await tty!.send(KEY.tab)
    await tty!.send("s3cr3t")
    await tty!.send(KEY.enter)
    const res = await p
    expect(res.cancelled).toBe(false)
    expect(res.values).toEqual({ url: "https://a.example", key: "s3cr3t" })
    s.close()
  })
  test("Esc dua-tahap: tekan-1 bersihkan field, tekan-2 batal (anti-hilang draft)", async () => {
    const s = screen()
    const p = runForm({ title: "X", fields: [{ id: "a", label: "A", kind: "text" }] }, s)
    await tty!.ready()
    await tty!.send("zzz")
    await tty!.send(KEY.esc, 90)
    // Tekan-1: field dibersihkan, form TETAP terbuka.
    expect(tty!.screen().join("\n")).not.toContain("zzz")
    // Tekan-2 (field kosong): batal total.
    await tty!.send(KEY.esc, 90)
    const res = await p
    expect(res.cancelled).toBe(true)
    expect(res.values).toBeUndefined()
    s.close()
  })
  test("secret di-mask di layar", async () => {
    const s = screen()
    const p = runForm({ title: "K", fields: [{ id: "k", label: "Key", kind: "secret" }] }, s)
    await tty!.ready()
    await tty!.send("rahasia")
    const frame = tty!.screen().join("\n")
    expect(frame).not.toContain("rahasia")
    expect(frame).toContain("•")
    await tty!.send(KEY.esc, 90)
    await tty!.send(KEY.esc, 90)
    await p
    s.close()
  })
  test("validasi: kosong ditolak dengan error inline, isi lalu lolos", async () => {
    const s = screen()
    const p = runForm(
      {
        title: "V",
        fields: [
          {
            id: "url",
            label: "URL",
            kind: "text",
            validate: (v) => (v.trim() ? null : "required"),
          },
        ],
      },
      s,
    )
    await tty!.ready()
    await tty!.send(KEY.enter)
    await tty!.waitForOutput((o) => o.includes("required"))
    // Masih terbuka (belum resolve): isi lalu Enter.
    await tty!.send("x")
    await tty!.send(KEY.enter)
    const res = await p
    expect(res.cancelled).toBe(false)
    expect(res.values).toEqual({ url: "x" })
    s.close()
  })
  test("select: Left/Right ganti opsi, Enter simpan", async () => {
    const s = screen()
    const p = runForm(
      {
        title: "S",
        fields: [{ id: "scope", label: "Scope", kind: "select", options: ["global", "local"] }],
      },
      s,
    )
    await tty!.ready()
    await tty!.send(KEY.right)
    await tty!.send(KEY.enter)
    const res = await p
    expect(res.values).toEqual({ scope: "local" })
    s.close()
  })
  test("confirm: y/n toggle, default No", async () => {
    const s = screen()
    const p = runForm({ title: "C", fields: [{ id: "ok", label: "Hapus?", kind: "confirm" }] }, s)
    await tty!.ready()
    expect(tty!.screen().join("\n")).toContain("No")
    await tty!.send("y")
    await tty!.send(KEY.enter)
    const res = await p
    expect(res.values).toEqual({ ok: "y" })
    s.close()
  })
  test("kursor CJK/emoji dihitung per kolom, bukan grapheme", async () => {
    // Gagal-di-kode-lama: "あx" → kolom short 1 per glyph lebar. Kolom absolut
    // = padding(3) + border+spasi(2) + prefix(5) + "あx"(3) + 1 = 14.
    // Bandingkan CUP TERAKHIR (perantara "13" wajar saat "あ" saja).
    const s = screen()
    const p = runForm({ title: "W", fields: [{ id: "k", label: "K", kind: "text" }] }, s)
    await tty!.ready()
    await tty!.send("あ")
    await tty!.send("x")
    const all = tty!.all()
    expect(all).toContain("\x1b[10;14H")
    expect(all.lastIndexOf("\x1b[10;14H")).toBeGreaterThan(all.lastIndexOf("\x1b[10;13H"))
    await tty!.send(KEY.esc, 90)
    await tty!.send(KEY.esc, 90)
    await p
    s.close()
  })
  test("select parkir di ujung baris (kolom pas, clamp layar)", async () => {
    const s = screen()
    const p = runForm(
      {
        title: "S",
        fields: [{ id: "scope", label: "Scope", kind: "select", options: ["global", "local"] }],
      },
      s,
    )
    await tty!.ready()
    // Box 64 di cols 70 → padding 3; contentW (termasuk border) 64 → 3+64+1.
    expect(tty!.all()).toContain(";68H")
    await tty!.send(KEY.esc, 90)
    await p
    s.close()
  })
  test("tidak ada field = batal langsung", async () => {
    const s = screen()
    const res = await runForm({ title: "E", fields: [] }, s)
    expect(res.cancelled).toBe(true)
    s.close()
  })
})
