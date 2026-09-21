// Cabang highlight yang sebelumnya tak tersentuh: Python, shell, JSON, diff, dan
// `formatCodeBlock` (80,43% lines). Semua uji memakai invarian yang sama:
// **highlight tidak boleh mengubah teks**, hanya menambah SGR. Itu satu-satunya
// jaminan yang berarti — warna spesifik bergantung tema dan level warna terminal,
// jadi menguncinya akan membuat test rapuh tanpa menambah kepercayaan.
//
// COLORTERM dipaksa `truecolor`: tanpa itu hasil bergantung apakah stdout runner
// tersambung ke TTY, dan pada level mono seluruh pewarnaan jadi identity sehingga
// test lolos tanpa benar-benar menjalankan cabang pewarnaan.
//
// Sejak warna digate `stdout.isTTY` (output ke pipe/redirect harus polos),
// suite ini men-stub stdout sebagai TTY — yang diuji adalah palet, bukan gate.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { formatCodeBlock, highlightCode } from "../src/ui/render/highlight.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"

const origColorterm = process.env.COLORTERM
const origNoColor = process.env.NO_COLOR

beforeEach(() => {
  process.env.COLORTERM = "truecolor"
  delete process.env.NO_COLOR
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  // Marker "... (N more lines)" dwibahasa — kunci en seperti warna.
  setSessionLocale("en")
})

afterAll(() => {
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
  if (origColorterm == null) delete process.env.COLORTERM
  else process.env.COLORTERM = origColorterm
  if (origNoColor == null) delete process.env.NO_COLOR
  else process.env.NO_COLOR = origNoColor
  resetLocaleState()
})

const ESC = String.fromCharCode(27)
/** Apakah keluaran benar-benar diwarnai (bukan hanya diteruskan apa adanya)? */
function isColored(s: string): boolean {
  return s.includes(ESC)
}

describe("highlight: TypeScript", () => {
  const code = [
    "import { readFileSync } from 'node:fs' // sisi kanan komentar",
    "export class Parser extends Base {",
    "  private count = 42",
    "  async run(): Promise<void> {",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: sampel kode TS yang di-highlight, bukan template
    "    const tpl = `nilai ${this.count}`",
    "    if (tpl === null) return undefined",
    "  }",
    "}",
  ].join("\n")

  test("teks utuh setelah strip", () => {
    expect(stripAnsi(highlightCode(code, "typescript"))).toBe(code)
  })

  test("mewarnai sesuatu (cabang pewarnaan benar-benar jalan)", () => {
    expect(isColored(highlightCode(code, "typescript"))).toBe(true)
  })

  test("komentar `//` mewarnai bagian kanan tanpa mengubah teks", () => {
    const line = "const x = 1 // catatan"
    const out = highlightCode(line, "ts")
    expect(stripAnsi(out)).toBe(line)
    // Bagian komentar harus ikut diwarnai — regresi kalau kode hanya mewarnai
    // token di sisi kiri dan membuang sisanya.
    expect(out.indexOf(ESC)).toBeLessThan(out.length - "catatan".length)
  })

  test("baris yang seluruhnya komentar tetap utuh", () => {
    const line = "// hanya komentar dengan // di tengah"
    expect(stripAnsi(highlightCode(line, "js"))).toBe(line)
  })

  test("literal boolean dan nullish tidak hilang", () => {
    const line = "const flags = [true, false, null, undefined]"
    expect(stripAnsi(highlightCode(line, "tsx"))).toBe(line)
  })

  test("bahasa tak dikenal jatuh ke jalur TS", () => {
    const line = "const x = 1"
    expect(highlightCode(line, "rust")).toBe(highlightCode(line, ""))
  })
})

describe("highlight: Python", () => {
  const code = [
    "import os",
    "class Runner:",
    "    def __init__(self, name: str = 'anon'):",
    "        self.name = name  # komentar akhir baris",
    "        self.count = 3.14",
    "",
    "    async def run(self):",
    "        if self.count is not None and True:",
    "            yield await self.step()",
    "        raise ValueError('gagal')",
  ].join("\n")

  test("teks utuh setelah strip", () => {
    expect(stripAnsi(highlightCode(code, "python"))).toBe(code)
  })

  test("alias `py` sama dengan `python`", () => {
    expect(highlightCode(code, "py")).toBe(highlightCode(code, "python"))
  })

  test("mewarnai keyword, angka, string, dan nama kelas", () => {
    expect(isColored(highlightCode(code, "python"))).toBe(true)
  })

  test("komentar `#` di awal baris tidak menghapus isi", () => {
    const line = "# TODO: perbaiki nanti"
    expect(stripAnsi(highlightCode(line, "python"))).toBe(line)
  })

  test("`#` di dalam string tetap utuh (batas yang diketahui, bukan crash)", () => {
    // Highlighter berbasis regex per-baris memperlakukan `#` sebagai komentar
    // walau di dalam string. Itu salah secara semantik tapi TIDAK boleh mengubah
    // teks — itulah yang dijaga di sini.
    const line = "color = '#ffffff'"
    expect(stripAnsi(highlightCode(line, "python"))).toBe(line)
  })
})

describe("highlight: shell", () => {
  const code = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: sampel skrip bash yang di-highlight, bukan template
    'NAME="${1:-dunia}"',
    "for f in $(find . -name '*.ts'); do",
    '  if grep -q TODO "$f"; then',
    '    echo "$f punya TODO" # catatan',
    "  fi",
    "done",
  ].join("\n")

  test("teks utuh setelah strip", () => {
    expect(stripAnsi(highlightCode(code, "bash"))).toBe(code)
  })

  test("semua alias shell memberi hasil sama", () => {
    const base = highlightCode(code, "bash")
    for (const lang of ["sh", "zsh", "shell"]) {
      expect(highlightCode(code, lang)).toBe(base)
    }
  })

  test("mewarnai variabel `$VAR` dan keyword", () => {
    expect(isColored(highlightCode('echo "$HOME"', "sh"))).toBe(true)
  })

  test("flag panjang tidak hilang", () => {
    const line = "curl --silent --location https://example.com"
    expect(stripAnsi(highlightCode(line, "sh"))).toBe(line)
  })

  test("flag shell (-x/--long) diwarnai kuning, bukan polos", () => {
    // Audit TUI P2-4: cabang yellow untuk token "-" mati (tokenizer tak pernah
    // menghasilkan token berawalan "-"). Kode lama: output == input persis.
    const line = "curl --silent -L https://example.com"
    const out = highlightCode(line, "sh")
    expect(stripAnsi(out)).toBe(line)
    expect(out).not.toBe(line) // ada SGR kuning pada flag
    expect(out).toContain("--silent")
    expect(out).toContain("-L")
  })

  test("komentar shell diwarnai tanpa mengubah teks", () => {
    const line = "rm -rf build # bersihkan"
    const out = highlightCode(line, "zsh")
    expect(stripAnsi(out)).toBe(line)
    expect(isColored(out)).toBe(true)
  })
})

describe("highlight: JSON", () => {
  const code = [
    "{",
    '  "name": "minicode",',
    '  "version": 1,',
    '  "ratio": -0.5,',
    '  "aktif": true,',
    '  "kosong": null,',
    '  "tags": ["a", "b"],',
    '  "escaped": "kutip \\" di dalam"',
    "}",
  ].join("\n")

  test("teks utuh setelah strip", () => {
    expect(stripAnsi(highlightCode(code, "json"))).toBe(code)
  })

  test("kunci dan nilai string diwarnai berbeda", () => {
    // Kunci (diikuti `:`) vs nilai string harus memakai slot warna berbeda;
    // kalau sama, cabang `colon` tidak jalan.
    const key = highlightCode('"k":', "json")
    const val = highlightCode('"k"', "json")
    expect(key).not.toBe(val)
  })

  test("angka negatif dan desimal tetap utuh", () => {
    const line = '{"a": -12, "b": 3.5}'
    expect(stripAnsi(highlightCode(line, "json"))).toBe(line)
  })
})

describe("highlight: diff", () => {
  const code = [
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1,4 +1,5 @@",
    " konteks tetap",
    "-baris dibuang",
    "+baris ditambah",
    "",
  ].join("\n")

  test("teks utuh setelah strip", () => {
    expect(stripAnsi(highlightCode(code, "diff"))).toBe(code)
  })

  test("header `---`/`+++` tidak diwarnai sebagai hapus/tambah", () => {
    // Kalau `+++` diwarnai hijau, seluruh header file jadi terlihat seperti
    // penambahan — inilah alasan pengecualian di kode.
    expect(highlightCode("+++ b/x.ts", "diff")).toBe("+++ b/x.ts")
    expect(highlightCode("--- a/x.ts", "diff")).toBe("--- a/x.ts")
  })

  test("baris tambah/hapus/hunk diwarnai", () => {
    expect(isColored(highlightCode("+tambah", "diff"))).toBe(true)
    expect(isColored(highlightCode("-hapus", "diff"))).toBe(true)
    expect(isColored(highlightCode("@@ -1 +1 @@", "diff"))).toBe(true)
  })

  test("baris konteks diteruskan apa adanya", () => {
    expect(highlightCode(" tetap", "diff")).toBe(" tetap")
  })
})

describe("formatCodeBlock", () => {
  test("menomori setiap baris dan menyertakan label bahasa", () => {
    const out = formatCodeBlock("const a = 1\nconst b = 2", "TypeScript")
    const plain = stripAnsi(out)
    expect(plain).toContain("typescript")
    expect(plain).toContain("   1 const a = 1")
    expect(plain).toContain("   2 const b = 2")
  })

  test("tanpa bahasa memakai label 'code'", () => {
    expect(stripAnsi(formatCodeBlock("x", ""))).toContain("code")
  })

  test("maxLines memotong dan melaporkan sisanya", () => {
    const code = Array.from({ length: 10 }, (_, i) => `baris ${i}`).join("\n")
    const plain = stripAnsi(formatCodeBlock(code, "ts", 3))
    expect(plain).toContain("... (7 more lines)")
    expect(plain).not.toContain("baris 9")
    // 3 baris kode + 1 baris keterangan, masing-masing bernomor.
    expect(plain).toContain("   4 ")
    expect(plain).not.toContain("   5 ")
  })

  test("maxLines lebih besar dari jumlah baris tidak memotong", () => {
    const plain = stripAnsi(formatCodeBlock("a\nb", "ts", 50))
    expect(plain).not.toContain("more lines")
  })

  test("nomor baris rata kanan sampai 3 digit", () => {
    const code = Array.from({ length: 100 }, () => "x").join("\n")
    const plain = stripAnsi(formatCodeBlock(code, "ts"))
    expect(plain).toContain("   1 x")
    expect(plain).toContain("  10 x")
    expect(plain).toContain(" 100 x")
  })
})

describe("highlight: masukan adversarial", () => {
  const languages = ["typescript", "python", "bash", "json", "diff", ""]

  test("string tak tertutup tidak menghilangkan teks", () => {
    const cases = [
      'const s = "belum ditutup',
      "const s = 'belum ditutup",
      "const s = `template belum ditutup",
      "s = 'python belum ditutup",
      'echo "shell belum ditutup',
      '{"json": "belum ditutup',
    ]
    for (const lang of languages) {
      for (const input of cases) {
        expect(stripAnsi(highlightCode(input, lang))).toBe(input)
      }
    }
  })

  test("kontrol + non-SGR dibuang di hulu (F-04; aman-di-pipeline)", () => {
    // Keputusan lama ("highlight BUKAN sanitasi") dibalik SADAR: tokenizer
    // justru MEMBELAH sekuens SGR (warna sah rusak) dan MELOLOSKAN non-SGR —
    // klaim "tidak membuang byte" sudah bohong. Sanitasi di hulu idempoten
    // bagi pemanggil yang sudah sanitasi (kasus umum: decorateMarkdown).
    for (const lang of languages) {
      expect(highlightCode("a\x1b[2Jb", lang)).not.toContain("\x1b[2J")
      expect(stripAnsi(highlightCode("a\x1b[2Jb", lang))).toBe("ab")
      expect(stripAnsi(highlightCode("a\x07b", lang))).toBe("ab")
      expect(stripAnsi(highlightCode("a\x00b", lang))).toBe("ab")
      // Tab dipertahankan (sanitasi tak menyentuhnya; tokenizer tak merusak).
      expect(highlightCode("a\tb", lang)).toContain("\t")
    }
  })

  test("teks non-ASCII dan emoji utuh (lebar kolom ditangani lapisan lain)", () => {
    const input = 'const pesan = "日本語 dan émoji 🎉 selesai"'
    for (const lang of languages) {
      expect(stripAnsi(highlightCode(input, lang))).toBe(input)
    }
  })

  test("berkas 5.000 karakter selesai dan utuh", () => {
    const line = 'const nilai = "abc"; // catatan panjang untuk menguji throughput'
    const big = Array.from({ length: Math.ceil(5000 / line.length) }, () => line).join("\n")
    expect(big.length).toBeGreaterThan(5000)
    for (const lang of languages) {
      expect(stripAnsi(highlightCode(big, lang))).toBe(big)
    }
  })

  test("satu baris sangat panjang tanpa newline tidak menggantung", () => {
    const long = `x`.repeat(20_000)
    const started = Date.now()
    expect(stripAnsi(highlightCode(long, "typescript"))).toBe(long)
    // Batas longgar: yang dijaga adalah backtracking katastrofik, bukan kecepatan.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("string kosong dan baris kosong berturut-turut", () => {
    for (const lang of languages) {
      expect(highlightCode("", lang)).toBe("")
      expect(stripAnsi(highlightCode("\n\n\n", lang))).toBe("\n\n\n")
    }
  })

  test("CR dibuang (anti-overwrite baris, F-04)", () => {
    // Dulu \r dipertahankan: "hello\rEVIL" menimpa baris di terminal.
    const input = "const a = 1\r\nconst b = 2"
    expect(stripAnsi(highlightCode(input, "ts"))).toBe("const a = 1\nconst b = 2")
  })

  test("escape di dalam kode dibuang sebelum tokenize (F-04)", () => {
    // Tokenizer dulu membelah SGR (warna sah rusak) dan meloloskan non-SGR.
    expect(highlightCode("a\x1b[2Jb", "ts")).not.toContain("\x1b[2J")
    expect(stripAnsi(highlightCode("const \x1b[31mx\x1b[0m = 1", "ts"))).toContain("const x = 1")
  })

  test("NO_COLOR mematikan pewarnaan di semua bahasa", () => {
    process.env.NO_COLOR = "1"
    const code = '{"a": 1}'
    for (const lang of languages) {
      expect(highlightCode(code, lang)).toBe(code)
    }
    expect(stripAnsi(formatCodeBlock("a\nb", "ts"))).toContain("   1 a")
    delete process.env.NO_COLOR
  })

  test("nama bahasa dengan spasi/huruf besar tetap dikenali", () => {
    const code = "def f():\n    pass"
    expect(highlightCode(code, "  PYTHON  ")).toBe(highlightCode(code, "python"))
  })
})
