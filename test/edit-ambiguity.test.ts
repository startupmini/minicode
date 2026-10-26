// edit — keunikan target antara jalur hashline (cepat) dan jalur flexibleMatch
// (Agent B track, 2026-10-22).
//
// Kontrak tool: "oldString must appear exactly once in the file". Jalur
// flexibleMatch menegakkan itu dengan柔性: cocok pertama + cari cocok kedua.
// Jalur hashline (cepat) DULU hanya mencari duplikat SUBSTRING PERSIS, jadi
// needle yang unik-persis tapi ambigu-fuzzy lolos dan blok PERTAMA diedit
// diam-diam.
//
// Contoh yang nyata: needle "\tfoo" pada file "\tfoo\n  foo\n".
//   - subSTRING persis "\tfoo" cuma satu     → pemeriksaan lama lolos
//   - flexibleMatch: exact di baris 1, lalu fuzzy di baris 2 → ambigu
//   - jalur fallback menolak, jalur hashline MENGEDIT DIAM-DIAM
//
// Semua fixture di direktori sementara; isi file selalu diperiksa, supaya
// test tak bisa lolos hanya karena error muncul SETELAH edit yang salah.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { editTool, flexibleMatch } from "../src/tools/edit.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function fixture(name: string, content: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "mc-edit-amb-"))
  dirs.push(dir)
  const file = join(dir, name)
  writeFileSync(file, content, "utf8")
  return { dir, file }
}

async function edit(dir: string, name: string, oldString: string, newString: string) {
  const ctx: any = { signal: new AbortController().signal, cwd: dir }
  return editTool.execute({ path: name, oldString, newString }, ctx)
}

describe("edit — keunikan target (hashline vs flexibleMatch)", () => {
  test("needle unik-persis tapi ambigu-fuzzy DITOLAK, file tak berubah", async () => {
    // Needle "\tfoo" cocok PERSIS hanya di baris 1, tapi cocok FUZZY juga di
    // baris 2 ("  foo" → trim → "foo"). Dua target ⇒ ambigu.
    const { dir, file } = fixture("a.ts", "\tfoo\n  foo\n")
    await expect(edit(dir, "a.ts", "\tfoo", "CHANGED")).rejects.toThrow(/found multiple times/)
    // Isi file WAJIB tetap — bukan "error muncul setelah edit salah".
    expect(readFileSync(file, "utf8")).toBe("\tfoo\n  foo\n")
  })

  test("urutan kebalikan: exact di baris 2, fuzzy di baris 1 — juga DITOLAK", async () => {
    const { dir, file } = fixture("b.ts", "  foo\n\tfoo\n")
    await expect(edit(dir, "b.ts", "  foo", "CHANGED")).rejects.toThrow(/found multiple times/)
    expect(readFileSync(file, "utf8")).toBe("  foo\n\tfoo\n")
  })

  test("duplikat persis tetap DITOLAK (perilaku lama tak berubah)", async () => {
    const { dir, file } = fixture("c.ts", "a a a")
    await expect(edit(dir, "c.ts", "a", "b")).rejects.toThrow(/found multiple times/)
    expect(readFileSync(file, "utf8")).toBe("a a a")
  })

  test("cocok exact yang UNIK tetap bisa diedit", async () => {
    const { dir, file } = fixture("d.ts", "  foo\nbar\n")
    await edit(dir, "d.ts", "  foo", "X")
    expect(readFileSync(file, "utf8")).toBe("X\nbar\n")
  })

  test("target hashline yang UNIK tetap ter-disambiguate dan diedit", async () => {
    // Needle pakai tab; hanya baris 1 yang cocok (baris 2 "bar" beda).
    const { dir, file } = fixture("e.ts", "\tfoo\nbar\n")
    await edit(dir, "e.ts", "\tfoo", "\tNEW")
    expect(readFileSync(file, "utf8")).toBe("\tNEW\nbar\n")
  })

  test("hashline tak valid (beda line-ending) — perilaku lama dipertahankan", async () => {
    // Isi CRLF, needle LF ⇒ `canHashline` false ⇒ jalur hashline dilewati,
    // jalur flexibleMatch mode "crlf" yang menangani, dan line-ending asli
    // harus tetap CRLF.
    const { dir, file } = fixture("f.ts", "foo\r\nbar\r\n")
    await edit(dir, "f.ts", "foo\nbar", "X")
    expect(readFileSync(file, "utf8")).toBe("X\r\n")
  })

  test("needle fuzzy yang UNIK tetap bisa diedit", async () => {
    const { dir, file } = fixture(
      "g.ts",
      "class S {\n    constructor() {\n        this.init();\n    }\n}",
    )
    await edit(dir, "g.ts", "constructor() {\n  this.init();\n}", "X")
    expect(readFileSync(file, "utf8")).toBe("class S {\nX\n}")
  })

  test("kedua jalur menjawab pertanyaan yang sama: tolak ⟺ matcher menemukan ≥2 target", async () => {
    // Kunci kontrak: keputusan edit工具 = keputusan matcher yang sama
    // (flexibleMatch). Untuk tiap kasus, hitung sendiri "berapa target"
    // memakai flexibleMatch, lalu bandingkan dengan hasil tool.
    const cases: [string, string][] = [
      ["\tfoo\n  foo\n", "\tfoo"], // ambigu (exact + fuzzy)
      ["  foo\n\tfoo\n", "  foo"], // ambigu
      ["a a a", "a"], // ambigu (exact + exact)
      ["  foo\nbar\n", "  foo"], // unik
      ["\tfoo\nbar\n", "\tfoo"], // unik
      ["xfoo\n  foo\n", "foo"], // ambigu
      ["dup\ndup\n", "dup"], // ambigu
      ["only\n", "only"], // unik
    ]
    for (const [content, needle] of cases) {
      const name = `h${cases.indexOf(cases.find((c) => c[0] === content && c[1] === needle)!)}.ts`
      const { dir, file } = fixture(name, content)
      const m = flexibleMatch(content, needle)
      const matcherSaysAmbiguous = Boolean(m && flexibleMatch(content.slice(m.end), needle))
      let toolRefused = false
      try {
        await edit(dir, name, needle, "ZZZ")
      } catch (e) {
        toolRefused = /found multiple times/.test((e as Error).message)
      }
      expect(toolRefused, `needle=${JSON.stringify(needle)}`).toBe(matcherSaysAmbiguous)
      // Kalau matcher bilang unik ⇒ file harus benar-benar berubah.
      if (!matcherSaysAmbiguous) expect(readFileSync(file, "utf8")).not.toBe(content)
    }
  })
})
