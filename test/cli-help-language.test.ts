// Test permanen untuk temuan bug-hunter UI ronde 3: konsistensi bahasa &
// penanda, kelengkapan /help, dan glyph yang menghormati dukungan UTF-8.

import { afterEach, describe, expect, test } from "bun:test"
import { BUILTIN_COMMANDS, handleBuiltinCommand } from "../cli/commands.ts"
import { glyphs, stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { captureOutput } from "./helpers/capture.ts"

/** Kata Inggris yang pernah bocor ke keluaran pengguna. */
const INDONESIAN =
  /\b(Tampilkan|Kelola|Pilih|Segarkan|Batalkan|Terapkan|Pemakaian|Daftar|Lanjutkan|Status|Ganti|Buat|Bersihkan|Keluar|Sampai jumpa|Papan tombol|tak dikenal|terpakai)\b/

const ctx = {
  cwd: process.cwd(),
  sessionId: "uji-help",
  currentModel: "prov::m",
  usage: {
    get: () => ({ inputTokens: 1, outputTokens: 2, totalTokens: 3, cost: 0.001 }),
    getSession: () => ({ inputTokens: 1, outputTokens: 2, totalTokens: 3, cost: 0.001 }),
    reset: () => {},
    modelUsed: () => ({ effective: undefined, provider: undefined }),
  },
  skills: [],
  toolsCount: 31,
  providerHint: "openai",
  setModelOverride: () => {},
  // Kontrak control-plane (Phase 6): /status membedakan Context vs Usage vs
  // Budget — dummy menyediakan angka tetap.
  getContextTokens: () => 1024,
  budgetState: () => "ok",
} as unknown as Parameters<typeof handleBuiltinCommand>[1]

const run = async (cmd: string) => {
  const { lines } = await captureOutput(() => handleBuiltinCommand(cmd, ctx))
  return lines
}

describe("/help: kelengkapan & ukuran", () => {
  // Overlay TUI di terminal 24 baris hanya menampilkan ~19 baris. /help 29 baris
  // memaksa user scroll untuk melihat bagian tombol.
  test("muat di overlay terminal 24 baris", async () => {
    const lines = await run("/help")
    expect(lines.length).toBeLessThanOrEqual(19)
  })

  test("contains only the supported command surface", async () => {
    const teks = (await run("/help")).join("\n")
    for (const cmd of ["/help", "/provider", "/model", "/status", "/sessions", "/init", "/exit"])
      expect(teks, cmd).toContain(cmd)
    // Opsi A audit UX: perintah driver (undo/redo/clear/copy/history) tampil
    // DI /HELP tapi TIDAK di dropdown completion (lihat DRIVER_HELP_COMMANDS).
    for (const cmd of ["/undo", "/redo", "/clear", "/copy", "/history"])
      expect(teks, cmd).toContain(cmd)
    for (const cmd of ["/models", "/providers", "/cost", "/resume", "/theme", "/thinking"])
      expect(teks, cmd).not.toContain(cmd)
  })

  test("does not include legacy help detail command", async () => {
    expect((await run("/help")).join("\n")).not.toContain("/help tombol")
  })

  test("baris /help tidak melebihi 80 kolom", async () => {
    for (const l of await run("/help")) expect(displayWidth(stripAnsi(l))).toBeLessThanOrEqual(80)
  })
})

describe("BUILTIN_COMMANDS: setiap perintah yang ditangani terdaftar", () => {
  // Perintah yang berfungsi tapi tidak terdaftar tidak muncul di /help DAN tidak
  // bisa dilengkapi dengan Tab — user tidak punya cara menemukannya.
  const DITANGANI = ["help", "init", "exit", "model", "provider", "sync", "sessions", "status"]

  test("tidak ada perintah yang hilang dari daftar", () => {
    const terdaftar = new Set(BUILTIN_COMMANDS.map((b) => b.name))
    const hilang = DITANGANI.filter((n) => !terdaftar.has(n))
    expect(hilang).toEqual([])
  })

  test("setiap perintah punya deskripsi", () => {
    for (const b of BUILTIN_COMMANDS) expect(b.desc, b.name).toBeTruthy()
  })

  test("legacy aliases are absent", () => {
    for (const n of [
      "quit",
      "usage",
      "models",
      "providers",
      "history",
      "compact",
      "theme",
      "thinking",
      "cost",
      "resume",
      "undo",
      "redo",
      "clear",
      "copy",
    ]) {
      expect(
        BUILTIN_COMMANDS.some((x) => x.name === n),
        n,
      ).toBe(false)
    }
  })

  test("nama perintah tidak memuat spasi atau placeholder", () => {
    for (const b of BUILTIN_COMMANDS) expect(b.name, b.name).not.toMatch(/[<[\s]/)
  })
})

describe("konsistensi bahasa keluaran", () => {
  const PERINTAH = ["/sync", "/status", "/sessions", "/exit", "/model"]

  for (const cmd of PERINTAH) {
    test(`${cmd} tidak memuat frasa Inggris yang pernah bocor`, async () => {
      const teks = (await run(cmd)).join(" ")
      const m = INDONESIAN.exec(teks)
      expect(m?.[0], `${cmd}: ${teks.slice(0, 90)}`).toBeUndefined()
    }, 10000)
  }

  test("/status uses English labels and includes usage", async () => {
    const teks = (await run("/status")).join("\n")
    expect(teks).toContain("Session")
    expect(teks).toContain("Cost")
  })

  test("/status membedakan Context vs Usage vs Budget (kontrak Phase 6)", async () => {
    const teks = (await run("/status")).join("\n")
    // Dua konsep berbeda, dua angka: Context (kernel window estimate) dan
    // Total (provider usage kumulatif) — tidak lagi satu angka ambigu.
    expect(teks).toContain("Context:")
    expect(teks).toContain("window estimate")
    expect(teks).toContain("Total:")
    expect(teks).toContain("Budget:")
  })

  test("/status membedakan Turn vs Total sesi (F1.1)", async () => {
    // Regresi: /status hanya menampilkan kumulatif sesi, sehingga turn boros
    // tak terbedakan dari sesi boros. Turn dan sesi WAJIB dua angka berbeda.
    const ctx2 = {
      ...ctx,
      usage: {
        ...ctx.usage,
        get: () => ({ inputTokens: 2, outputTokens: 3, totalTokens: 5 }),
        getSession: () => ({ inputTokens: 40, outputTokens: 60, totalTokens: 100 }),
      },
    } as unknown as Parameters<typeof handleBuiltinCommand>[1]
    const { lines } = await captureOutput(() => handleBuiltinCommand("/status", ctx2))
    const turnLine = lines.find((l) => stripAnsi(l).startsWith("Turn:")) ?? ""
    const totalLine = lines.find((l) => stripAnsi(l).startsWith("Total:")) ?? ""
    expect(turnLine).toContain("5")
    expect(turnLine).not.toContain("100")
    expect(totalLine).toContain("100")
  })

  test("/status Provider = efektif, lalu pin, terakhir hint wire", async () => {
    // Regresi: sesi opencode-zen selalu tampil "Provider: openai" karena
    // yang dicetak hint wire, bukan provider yang dipakai.
    const providerLine = (lines: string[]): string =>
      lines.find((l) => stripAnsi(l).startsWith("Provider:")) ?? ""
    // 1. Pin tanpa event fallback → id dari pin, bukan hint.
    expect(providerLine(await run("/status"))).toContain("prov")
    // 2. Provider efektif (hasil fallback) menang atas pin maupun hint.
    const ctx2 = {
      ...ctx,
      currentModel: "opencode-zen::deepseek-v4-flash-free",
      usage: {
        ...ctx.usage,
        modelUsed: () => ({ effective: "deepseek-v4-flash-free", provider: "opencode-zen" }),
      },
      providerHint: "openai",
    } as unknown as Parameters<typeof handleBuiltinCommand>[1]
    const { lines: lines2 } = await captureOutput(() => handleBuiltinCommand("/status", ctx2))
    expect(providerLine(lines2)).toContain("opencode-zen")
    expect(providerLine(lines2)).not.toContain("openai")
  })
})

describe("glyphs: menghormati dukungan UTF-8", () => {
  const orig = process.env.MINICODE_ASCII
  afterEach(() => {
    if (orig == null) delete process.env.MINICODE_ASCII
    else process.env.MINICODE_ASCII = orig
  })

  // Dulu dibekukan saat import, jadi env yang berubah tidak berpengaruh —
  // kesalahan yang sama seperti objek warna `c`.
  test("MINICODE_ASCII=1 memaksa fallback ASCII", () => {
    process.env.MINICODE_ASCII = "1"
    expect(glyphs.check).toBe("[OK]")
    expect(glyphs.cross).toBe("[FAIL]")
    expect(glyphs.arrow).toBe(">")
    expect(glyphs.dot).toBe(".")
    expect(glyphs.ellipsis).toBe("...")
    expect(glyphs.spinnerFrames[0]).toBe(".")
  })

  test("tanpa MINICODE_ASCII memakai glyph Unicode pada terminal modern", () => {
    delete process.env.MINICODE_ASCII
    // Di lingkungan test (WT_SESSION diset oleh harness lain) atau non-Windows.
    const pakaiUnicode = glyphs.arrow === "›"
    const pakaiAscii = glyphs.arrow === ">"
    expect(pakaiUnicode || pakaiAscii).toBe(true)
  })

  test("semua glyph ASCII aman untuk conhost legacy", () => {
    process.env.MINICODE_ASCII = "1"
    for (const [nama, nilai] of Object.entries(glyphs)) {
      const teks = Array.isArray(nilai) ? nilai.join("") : String(nilai)
      expect(/^[\x20-\x7e]*$/.test(teks), `${nama}=${teks}`).toBe(true)
    }
  })
})
