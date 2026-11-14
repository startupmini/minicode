// Form dalam popup (src/ui/screens/form.ts): SEMUA input terjadi di dalam
// kotak — tidak satu piksel pun di luar. Gagal-di-kode-lama: add/edit
// provider memakai askLine/console.log di luar kotak.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { openAltScreen, resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { popupBoxWidth } from "../src/ui/screens/dialog.ts"
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
  test("Esc tekan-1 kembalikan prefill (bukan hapus), tekan-2 batal", async () => {
    // Bug-hunter TUI F-10: prefill edit (mis. URL preset) musnah sekali tekan
    // tanpa undo. Kini tekan-1 = revert ke bawaan, tekan-2 = batal.
    const s = screen()
    const p = runForm(
      {
        title: "E",
        fields: [{ id: "u", label: "U", kind: "text", initial: "https://preset.example" }],
      },
      s,
    )
    await tty!.ready()
    await tty!.send("X")
    expect(tty!.screen().join("\n")).toContain("Xhttps://preset.example")
    await tty!.send(KEY.esc, 90)
    // Prefill kembali utuh, form TETAP terbuka.
    const frame = tty!.screen().join("\n")
    expect(frame).toContain("https://preset.example")
    expect(frame).not.toContain("Xhttps://preset.example")
    await tty!.send(KEY.esc, 90)
    const res = await p
    expect(res.cancelled).toBe(true)
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
    // Gagal-di-kode-lama: "あx" → kolom short 1 per glyph lebar.
    // Kolom absolut = centering-pad + border+spasi(2) + prefix(5) + "K: "(3)
    //                  + "あx"(3) + 1. Padding dihitung dari popupBoxWidth agar
    // test tak patah lagi saat lebar popup berubah (I20 v7.14).
    // Bandingkan CUP TERAKHIR (perantara "24" wajar saat "あ" saja).
    const s = screen()
    const pad = Math.floor((70 - popupBoxWidth(70)) / 2)
    const colA = pad + 10 // "あ" saja
    const colAB = pad + 11 // "あx"
    const p = runForm({ title: "W", fields: [{ id: "k", label: "K", kind: "text" }] }, s)
    await tty!.ready()
    await tty!.send("あ")
    await tty!.send("x")
    const all = tty!.all()
    expect(all).toContain(`\x1b[10;${colAB}H`)
    expect(all.lastIndexOf(`\x1b[10;${colAB}H`)).toBeGreaterThan(
      all.lastIndexOf(`\x1b[10;${colA}H`),
    )
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
    // Kursor parkir di ujung kanan border: centering-pad + lebar kotak + 1.
    // Dihitung dari popupBoxWidth agar test tak patah saat lebar berubah (I20).
    const pad = Math.floor((70 - popupBoxWidth(70)) / 2)
    expect(tty!.all()).toContain(`;${pad + popupBoxWidth(70) + 1}H`)
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

// ── Audit renderer 2026-11-12 ───────────────────────────────────────────────
describe("runForm: temuan audit 2026-11-12", () => {
  test("Tab + teks dalam SATU chunk masuk ke field BARU (pointer field basi)", async () => {
    // Gagal-di-kode-lama: `st` dicapture sebelum loop, jadi Tab yang menggeser
    // `idx` tetap menulis ke field sebelumnya — API key bisa mendarat di URL.
    const s = screen()
    const p = runForm(
      {
        title: "T",
        fields: [
          { id: "a", label: "A", kind: "text" },
          { id: "b", label: "B", kind: "text" },
        ],
      },
      s,
    )
    await tty!.ready()
    await tty!.send(`${KEY.tab}X`)
    await tty!.send(KEY.enter)
    const res = await p
    expect(res.cancelled).toBe(false)
    expect(res.values).toEqual({ a: "", b: "X" })
    s.close()
  })

  test("Esc pada select: tekan-1 kembalikan pilihan bawaan, form tetap terbuka", async () => {
    // Kontrak I21 menyebut SEMUA input teks/pilihan; dulu select/confirm
    // langsung membatalkan seluruh form pada Esc pertama.
    const s = screen()
    const p = runForm(
      {
        title: "S",
        fields: [
          { id: "scope", label: "Scope", kind: "select", options: ["global", "local"], initial: 0 },
          { id: "url", label: "URL", kind: "text" },
        ],
      },
      s,
    )
    await tty!.ready()
    await tty!.send(KEY.right)
    expect(tty!.screen().join("\n")).toContain("local")
    await tty!.send(KEY.esc, 90)
    const frame = tty!.screen().join("\n")
    expect(frame).toContain("global")
    expect(frame).toContain("Scope")
    // Tekan-2 (sudah di nilai bawaan) = batal total.
    await tty!.send(KEY.esc, 90)
    const res = await p
    expect(res.cancelled).toBe(true)
    s.close()
  })

  test("field aktif di luar tinggi kotak tetap terlihat (jendela digeser)", async () => {
    // Gagal-di-kode-lama: kursor diparkir di baris marker/border dan ketikan
    // masuk ke field yang tidak ada di layar.
    tty = installFakeTty({ columns: 70, rows: 10 })
    const s = openAltScreen()
    const fields = Array.from({ length: 10 }, (_, i) => ({
      id: `f${i}`,
      label: `Field ${i}`,
      kind: "text" as const,
    }))
    const p = runForm({ title: "Banyak", fields }, s)
    await tty!.ready()
    for (let i = 0; i < 9; i++) await tty!.send(KEY.tab)
    await tty!.send("ZZMARKERZZ")
    expect(tty!.screen().join("\n")).toContain("ZZMARKERZZ")
    await tty!.send(KEY.esc, 90)
    await tty!.send(KEY.esc, 90)
    await p
    s.close()
  })
})
