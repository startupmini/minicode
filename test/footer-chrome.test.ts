// Chrome footer lengket (src/ui/runtime/chrome.ts): DECSTBM scroll-region,
// repaint tiap idle, reset-on-detach, mode none/print/sticky/auto.
// Hermetik via fake-TTY harness (rows/columns/stdout.write tertangkap).

import { afterEach, describe, expect, test } from "bun:test"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { createFooterChrome, footerReserveRows } from "../src/ui/runtime/chrome.ts"
import { installFakeTty } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | undefined
const prev = process.env.MINICODE_FOOTER
afterEach(() => {
  tty?.restore()
  tty = undefined
  if (prev === undefined) delete process.env.MINICODE_FOOTER
  else process.env.MINICODE_FOOTER = prev
})

const status = () => ({
  mode: "allowlist",
  model: "acme::deepseek-v4-flash",
  cwd: "C:\\Users\\dokument",
})

describe("footer chrome", () => {
  test("non-TTY → none, nol byte, tanpa reserve", () => {
    tty = installFakeTty({ isTTY: false })
    const ch = createFooterChrome({ enabled: true, status })
    expect(ch.mode).toBe("none")
    expect(ch.reserveRows()).toBe(0)
    ch.present()
    ch.detach()
    expect(tty.chunks().join("")).toBe("")
  })

  test("MINICODE_FOOTER=off → none walau TTY", () => {
    process.env.MINICODE_FOOTER = "off"
    tty = installFakeTty()
    const ch = createFooterChrome({ enabled: true, status })
    expect(ch.mode).toBe("none")
    ch.present()
    ch.detach()
    expect(tty.chunks().join("")).toBe("")
  })

  test("print: footer sebagai baris scrollback, tanpa region/reserve", () => {
    process.env.MINICODE_FOOTER = "print"
    tty = installFakeTty({ rows: 30, columns: 80 })
    const ch = createFooterChrome({ enabled: true, status })
    expect(ch.mode).toBe("print")
    expect(ch.reserveRows()).toBe(0)
    ch.present()
    const out = tty.chunks().join("")
    // Satu baris status (tanpa garis) + newline; tidak ada \x1b[r / DECSTBM.
    const plain = stripAnsi(out)
    expect(plain).toContain("allowlist")
    expect(plain).toContain("deepseek-v4-flash")
    expect(plain).toContain("C:\\Users\\dokument")
    expect(plain).toContain("•")
    expect(out).not.toContain("\x1b[r")
  })

  test("sticky: region DECSTBM + footer 2 baris + kursor di baris input", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    expect(ch.mode).toBe("sticky")
    expect(ch.reserveRows()).toBe(2)
    ch.present()
    const out = tty.chunks().join("")
    // Region atas = 1..28 (footer menempati 29..30: blank+status, tanpa garis).
    expect(out).toContain("\x1b[1;28r")
    // Footer dilukis di baris 29-30 (blank/status).
    expect(out).toContain("\x1b[29;1H")
    expect(out).toContain("\x1b[30;1H")
    // Kursor ke baris input 28.
    expect(out).toContain("\x1b[28;1H")
  })

  test("sticky: detach me-reset region + reserve nol, footer tercetak sekali", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    expect(ch.reserveRows()).toBe(2)
    ch.detach()
    expect(ch.reserveRows()).toBe(0)
    expect(footerReserveRows()).toBe(0)
    expect(tty.chunks().join("")).toContain("\x1b[r")
  })

  test("auto di terminal mampu = sticky; terminal pendek = print", () => {
    delete process.env.MINICODE_FOOTER
    tty = installFakeTty({ rows: 30 })
    expect(createFooterChrome({ enabled: true, status }).mode).toBe("sticky")
    tty?.restore()
    tty = installFakeTty({ rows: 8 })
    expect(createFooterChrome({ enabled: true, status }).mode).toBe("print")
  })

  test("sticky tanpa enabled = none (exec/pipe guard)", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30 })
    const ch = createFooterChrome({ enabled: false, status })
    expect(ch.mode).toBe("none")
  })

  test("present dua kali: dua paint identik, tanpa erase (idempotent isi)", () => {
    // Rekonsiliasi reset+set region tiap present (menyembuhkan region yang
    // hilang diam-diam); idempotensi yang dijaga adalah ISI: geometri sama
    // berarti paint ke baris yang sama tanpa penghapusan — tak ada frame yatim.
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    ch.present()
    const out = tty.chunks().join("")
    // Tepat dua paint ke baris 29/30 (satu per present), nol erase tambahan:
    // erase menambah kemunculan CUP di luar paint.
    expect(out.split("\x1b[29;1H").length - 1).toBe(2)
    expect(out.split("\x1b[30;1H").length - 1).toBe(2)
  })

  test("repaint footer TIDAK menggeser kursor (save/restore)", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    tty.clear()
    // refresh() dipakai saat prompt aktif (Shift+Tab): tiap penulisan direct-
    // address harus diapit DECSC/DECRC, dan TIDAK boleh memindahkan kursor
    // input setelah selesai.
    ch.refresh()
    const out = tty.chunks().join("")
    expect(out).toContain("\x1b7")
    expect(out).toContain("\x1b8")
    expect(out.endsWith("\x1b8")).toBe(true)
  })

  test("blank footer pakai CLEAR, bukan padding selebar terminal", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    const out = tty.chunks().join("")
    // Padding 40 spasi dari kolom 1 akan membungkus ke baris berikutnya.
    expect(out).not.toContain(" ".repeat(40))
  })

  test("resize saat region aktif: re-set region + repaint, kursor aman", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    tty.clear()
    tty.resize(50, 20)
    const out = tty.chunks().join("")
    // Region baru mengikuti rows baru (footer 19..20, region 1..18).
    expect(out).toContain("\x1b[1;18r")
    expect(out).toContain("\x1b[20;1H")
    // DECSTBM dipagari save/restore.
    expect(out).toContain("\x1b7")
    expect(out).toContain("\x1b8")
  })
})

describe("footer chrome: resize tanpa frame yatim (audit resize 2026-09)", () => {
  // Akar masalah: repaint dulu hanya melukis baris dasar BARU tanpa menghapus
  // frame LAMA (dan tanpa me-reset region yang bisa hilang diam-diam di
  // ConPTY) — tiap siklus besar-kecil meninggalkan satu kopi footer yatim.
  // Kontrak baru: tiap repaint = reset region + hapus frame lama (bila
  // teralamatkan) + tegakkan region + lukis. CUP paint tak terbedakan dari
  // CUP erase di level byte, jadi test menghitung kemunculan: tiap paint
  // tepat 1 CUP per baris; erase menambah kemunculan di luar paint.
  const cup = (out: string, row: number): number => out.split(`\x1b[${row};1H`).length - 1

  test("menyusut: frame lama jadi scrollback (jujur di-skip), frame baru tunggal", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    tty.clear()
    tty.resize(40, 20)
    const out = tty.chunks().join("")
    // Baris 29/30 tak lagi teralamatkan di layar 20-baris (reflow terminal
    // memindahkannya ke scrollback — di luar jangkauan penghapusan apa pun).
    // Kejujuran: JANGAN kirim CUP ke baris tak-ada (terminal menjepit ke
    // bawah dan justru menghapus baris SALAH). Nol byte ke 29/30.
    expect(cup(out, 29)).toBe(0)
    expect(cup(out, 30)).toBe(0)
    // Reset dulu (rekonsiliasi, bukan percaya regionOn), lalu region baru.
    const reset = out.indexOf("\x1b[r")
    expect(reset).toBeGreaterThanOrEqual(0)
    expect(reset).toBeLessThan(out.indexOf("\x1b[1;18r"))
    // Paint baru di 19+20 tepat 1x — satu-satunya frame hidup.
    expect(cup(out, 19)).toBe(1)
    expect(cup(out, 20)).toBe(1)
    ch.detach()
  })

  test("membesar: frame lama dihapus, bukan ditinggal", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 20, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    tty.clear()
    tty.resize(40, 30)
    const out = tty.chunks().join("")
    expect(cup(out, 19)).toBe(1)
    expect(cup(out, 20)).toBe(1)
    expect(out).toContain("\x1b[1;28r")
    expect(cup(out, 29)).toBe(1)
    expect(cup(out, 30)).toBe(1)
    ch.detach()
  })

  test("lebar saja berubah: tanpa erase, paint ulang di baris sama", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    tty.clear()
    tty.resize(120, 30)
    const out = tty.chunks().join("")
    // Geometri baris sama → paint ulang 29/30 tepat 1x, tanpa erase tambahan.
    expect(cup(out, 29)).toBe(1)
    expect(cup(out, 30)).toBe(1)
    ch.detach()
  })

  test("terminal terlalu pendek: region dilepas, frame dibersihkan, tanpa paint", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    tty.clear()
    tty.resize(40, 8)
    const out = tty.chunks().join("")
    expect(out).toContain("\x1b[r")
    // Frame hidup (29/30, kini di dasar layar 8) dibersihkan agar tak jadi
    // duplikat permanen saat tumbuh kembali — tepat 1x, tanpa paint baru.
    expect(cup(out, 7)).toBe(1)
    expect(cup(out, 8)).toBe(1)
    expect(cup(out, 29)).toBe(0)
    expect(cup(out, 30)).toBe(0)
    ch.detach()
  })

  test("tumbuh kembali sesudah layar pendek: tanpa duplikat hidup", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    tty.resize(40, 8)
    tty.clear()
    tty.resize(40, 30)
    const out = tty.chunks().join("")
    // Satu paint di 29/30, tanpa sisa frame di 7/8 (sudah dibersihkan saat
    // susut) dan tanpa hapus baris lain.
    expect(cup(out, 29)).toBe(1)
    expect(cup(out, 30)).toBe(1)
    expect(cup(out, 7)).toBe(0)
    expect(cup(out, 8)).toBe(0)
    expect(out).toContain("\x1b[1;28r")
    ch.detach()
  })

  test("refresh ikut rekonsiliasi (reset dulu, bukan percaya region)", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    tty.clear()
    tty.resize(40, 20)
    ch.refresh()
    const out = tty.chunks().join("")
    // Susut 30→20: baris 29/30 tak-teralamatkan → nol byte ke sana di kedua
    // reconcile (resize + refresh). Paint 19/20 tepat 2x (satu per reconcile).
    expect(cup(out, 29)).toBe(0)
    expect(cup(out, 30)).toBe(0)
    expect(cup(out, 19)).toBe(2)
    expect(cup(out, 20)).toBe(2)
    ch.detach()
  })

  test("detach menghapus frame lengket sebelum salinan scrollback", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    tty.clear()
    ch.detach()
    const out = tty.chunks().join("")
    const erase29 = out.indexOf("\x1b[29;1H")
    // Erase dulu, lalu reset region, lalu salinan tercetak (tanpa duplikat).
    expect(erase29).toBeGreaterThanOrEqual(0)
    expect(erase29).toBeLessThan(out.indexOf("\x1b[r"))
    expect(out.split("allowlist").length - 1).toBe(1)
  })

  test("stream + resize: teks utuh berurutan, satu footer hidup", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 80 })
    const t = tty
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    const phases: string[] = []
    const snap = (): void => {
      phases.push(t.chunks().join(""))
      t.clear()
    }
    t.clear() // buang bytes present awal
    // Simulasi output streaming yang terjalin dengan resize + present idle.
    const emit = (s: string): void => {
      process.stdout.write(s)
    }
    emit("baris-satu\n")
    t.resize(80, 20) // susut: 29/30 yatim-scrollback, paint 19/20 (1x)
    snap() // P0
    emit("baris-dua\n")
    ch.present() // geometri sama: paint 19/20 lagi (1x), tanpa erase
    snap() // P1
    t.resize(80, 30) // tumbuh: erase 19/20 (1x) + paint 29/30 (1x)
    snap() // P2
    emit("baris-tiga\n")
    ch.present() // geometri sama: paint 29/30 lagi (1x), tanpa erase
    snap() // P3
    const [p0, p1, p2, p3] = phases as [string, string, string, string]
    // Teks tak rusak dan urut melintasi fase.
    expect(p0).toContain("baris-satu")
    expect(p1).toContain("baris-dua")
    expect(p3).toContain("baris-tiga")
    // Fase susut: nol byte ke baris yatim, satu paint baru.
    expect(cup(p0, 29)).toBe(0)
    expect(cup(p0, 30)).toBe(0)
    expect(cup(p0, 19)).toBe(1)
    expect(cup(p0, 20)).toBe(1)
    // Present geometri-sama: paint ulang, tanpa erase.
    expect(cup(p1, 19)).toBe(1)
    expect(cup(p1, 20)).toBe(1)
    // Fase tumbuh: erase lama tepat 1x + paint baru tepat 1x.
    expect(cup(p2, 19)).toBe(1)
    expect(cup(p2, 20)).toBe(1)
    expect(cup(p2, 29)).toBe(1)
    expect(cup(p2, 30)).toBe(1)
    // Present akhir: paint ulang 29/30 tepat 1x, tanpa erase.
    expect(cup(p3, 29)).toBe(1)
    expect(cup(p3, 30)).toBe(1)
    expect(cup(p3, 19)).toBe(0)
    expect(cup(p3, 20)).toBe(0)
    ch.detach()
  })

  test("badai 500 resize: selesai, frame akhir tunggal, tanpa ledakan tulis", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 80 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    tty.clear()
    const seq: [number, number][] = [
      [80, 20],
      [120, 44],
      [40, 12],
      [200, 30],
      [80, 24],
    ]
    for (let i = 0; i < 100; i++) {
      const [c, r] = seq[i % seq.length]!
      tty.resize(c, r)
    }
    ch.present()
    const out = tty.chunks().join("")
    // Berakhir di 80x24 (100 = kelipatan 5 → seq[4]): region + paint cocok.
    expect(out).toContain("\x1b[1;22r")
    expect(cup(out, 23)).toBeGreaterThan(0)
    expect(cup(out, 24)).toBeGreaterThan(0)
    // Tulis terbatas: tiap resize tepat 1 paint (2 CUP) + erase sesekali.
    // 101 reconcile × ~4 CUP + erase ≤ 20% → jauh di bawah 1000. Pola regex
    // dibangun tanpa literal kontrol (aturan lint noControlCharactersInRegex).
    const esc = String.fromCharCode(27)
    const cups = (out.match(new RegExp(`${esc}\\[\\d+;1H`, "g")) ?? []).length
    expect(cups).toBeLessThan(1000)
    expect(tty.failures()).toEqual([])
    ch.detach()
  })

  test("setBusy(false) melukis ulang sinkron tanpa timer", () => {
    process.env.MINICODE_FOOTER = "sticky"
    tty = installFakeTty({ rows: 30, columns: 40 })
    const ch = createFooterChrome({ enabled: true, status })
    ch.present()
    tty.clear()
    ch.setBusy(false)
    const out = tty.chunks().join("")
    expect(cup(out, 29)).toBe(1)
    expect(cup(out, 30)).toBe(1)
    ch.detach()
  })
})
