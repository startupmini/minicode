// PHASE 6AE - normalisasi EOL pada verifikasi vendor.
//
// Test ini menjalankan SCRIPT ASLI (`scripts/vendor-minicore.ts`) terhadap tree
// vendor NYATA di checkout ini. Alasannya sudah berulang kali dibayar di fase
// sebelumnya: "helper teruji" bukan "caller produksi teruji". Test yang hanya
// memanggil `semanticBytes()` akan tetap hijau kalau `hashOf()` berhenti
// memakainya.
//
// [FASE 6AE] CARA KERJA, dan kenapa begini.
//
// Script punya satu env seam: `MINICODE_MINICORE_SOURCE` mengganti SUMBER
// (`../minicore`), tapi target `vendor/minicore` relatif terhadap script dan
// tidak bisa diarahkan. Jadi fixture tidak boleh membuat tree vendor sendiri -
// tidak ada cara Reach itu tanpa menambah seam produksi baru, yang di luar
// scope.
//
// Karena itu arahnya dibalik: yang dikontrol adalah SISI SOURCE, sedangkan sisi
// vendor adalah tree asli checkout ini. Itu justru lebih baik - tidak ada
// fixture buatan yang bisa GREEN sementara tree sebenarnya rusak. Sisi source
// dibangun dengan menyalin file vendor asli lalu, pada kasus EOL, menulisnya
// ulang dengan line ending yang dipilih.
//
// Yang diuji:
//
//   1. Kontrak yang DIPERTAHANKAN - `--check` tetap exit 1 saat vendor benar
//      bocor. Perbaikan sensitivitas EOL tidak boleh mengurangi kemampuan
//      mendeteksi drift.
//   2. LF source vs CRLF vendor (dan sebaliknya) -> dianggap sinkron.
//   3. Perubahan isi satu karakter -> tetap terdeteksi, apa pun EOL-nya.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

const REPO = join(import.meta.dir, "..")
const SCRIPT = join(REPO, "scripts", "vendor-minicore.ts")
const VENDOR = join(REPO, "vendor", "minicore")

/**
 * Daftar file yang sama persis dengan kontrak script
 * (INCLUDE_DIRS=["src"], INCLUDE_FILES=["package.json","LICENSE","test/fakes.ts"]).
 * Disalin di sini dengan sengaja: kalau kontrak script berubah, test ini harus
 * gagal loudly, bukan diam-diam menguji 3 file.
 */
const CONTRACT_DIRS = ["src"]
const CONTRACT_FILES = ["package.json", "LICENSE", "test/fakes.ts"]

function contractFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const e of require("node:fs").readdirSync(dir, { withFileTypes: true }) as {
      name: string
      isDirectory(): boolean
    }[]) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else out.push(relative(VENDOR, full).replace(/\\/g, "/"))
    }
  }
  for (const d of CONTRACT_DIRS) walk(join(VENDOR, d))
  for (const f of CONTRACT_FILES) if (existsSync(join(VENDOR, f))) out.push(f)
  return out.sort()
}

/**
 * Bangun source sementara dari tree vendor asli.
 *
 * `eol` menentukan line ending yang ditulis. Isi logisnya identik dengan
 * vendor, jadi satu-satunya variabel adalah representasi EOL - kecuali
 * `drift`, yang menyisipkan satu perubahan isi pada satu file.
 */
function makeSource(
  name: string,
  opts: { eol: "lf" | "crlf"; drift?: { file: string; from: string; to: string } },
): { root: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), `6ae-vendor-${name}-`))
  const source = join(root, "minicore")
  for (const f of contractFiles()) {
    const body = readFileSync(join(VENDOR, f))
    const isBinary = body.subarray(0, 8000).includes(0)
    let bytes = body
    if (!isBinary) {
      // Normalisasi ke LF dulu, baru ke EOL yang diminta. Urutan ini mencegah
      // CRLF becoming CR+LF saat modulate dari bentuk CRLF.
      const lf = body.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
      bytes = Buffer.from(opts.eol === "crlf" ? lf.replace(/\n/g, "\r\n") : lf, "utf8")
    }
    if (opts.drift && f === opts.drift.file) {
      const text = bytes.toString("utf8")
      if (!text.includes(opts.drift.from)) {
        throw new Error(`drift anchor not found in ${f}: ${JSON.stringify(opts.drift.from)}`)
      }
      bytes = Buffer.from(text.replace(opts.drift.from, opts.drift.to), "utf8")
    }
    const dest = join(source, f)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, bytes)
  }
  return { root, source }
}

/** Jalankan script ASLI. code 0 = sinkron, 1 = TIDAK sinkron. */
function runCheck(source: string): { code: number; out: string } {
  const r = spawnSync("bun", [SCRIPT, "--check"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, MINICODE_MINICORE_SOURCE: source },
  })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

describe("6AE vendor:check - EOL independence at the script boundary", () => {
  // Sanity check pada fixture-nya sendiri: kalau salinan source tidak cocok
  // dengan kontrak script, semua test di bawah mengukur sesuatu yang lain.
  test("the fixture covers exactly the files the script contract hashes", () => {
    const files = contractFiles()
    expect(files.length).toBe(20)
    expect(files).toContain("src/core/index.ts")
    expect(files).toContain("test/fakes.ts")
    expect(files).toContain("package.json")
    expect(files).toContain("LICENSE")
  })

  // ── THE CONTRACT THAT MUST NOT BREAK ───────────────────────────────────────
  //
  // [DESIGN DECISION] These run FIRST and are the most important tests in the
  // file. Every EOL test below is trivially satisfiable by a script that
  // "normalizes until nothing ever mismatches" - that broken script would pass
  // all of them and fail only here. Drift detection is the integrity guarantee;
  // EOL tolerance is the convenience being bought. Pin the guarantee first.
  test("REAL vendor drift is still detected (one changed character)", () => {
    const p = makeSource("drift", {
      eol: "lf",
      drift: { file: "src/core/errors.ts", from: "Error", to: "ErroR" },
    })
    try {
      const r = runCheck(p.source)
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/TIDAK sinkron/)
    } finally {
      rmSync(p.root, { recursive: true, force: true })
    }
  })

  // [DESIGN DECISION] A renamed import is the drift that matters most for this
  // kernel: file count and byte count stay plausible, so a size-only check
  // would wave it through.
  test("REAL vendor drift in an import specifier is detected", () => {
    const p = makeSource("import", {
      eol: "lf",
      drift: { file: "src/core/loop.ts", from: "export", to: "exports" },
    })
    try {
      const r = runCheck(p.source)
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/TIDAK sinkron/)
    } finally {
      rmSync(p.root, { recursive: true, force: true })
    }
  })

  // ── WHY THE NORMALIZER MUST NOT TOUCH INDENTATION ──────────────────────────
  //
  // [FASE 6AE] Test yang membunuh mutan M5 (normalizer yang juga mengikis
  // indentasi), dan keduanya berasal dari kegagalan nyata.
  //
  // Versi pertama dari test ini survived M5, dan itu kelemahannya BUKAN pada
  // mutan - tapi pada testnya. Anchor drift-nya menyisipkan spasi di TENGAH
  // baris (`export type {...} from "./types.ts"`), sehingga ekspresi trim
  // `^\s+` tidak pernah menyentuhnya. Test itu tetap hijau di bawah mutan yang
  // seharusnya ia tangkap, karena ia tidak pernah menguji apa yang diklaimnya.
  //
  // Yang benar adalah mengubah spasi di AWAL baris, di baris yang benar-benar
  // berindensasi. reasoned M5 tidak bisa menyembunyikannya karena `^\s+` di
  // sana. both sides di-trim, dan keduanya berbeda, jadi perbedaan nya tetap
  // terlihat. Perhatikan ini tetap mendeteksi perubahan yang secara semantik
  // TIDAK berarti: itu justru intinya - pin vendor menangkap suntingan byte,
  // bukan perubahan makna.
  test("indentation-only drift at line start is still detected", () => {
    const p = makeSource("indent", {
      eol: "lf",
      // Baris `      const v = (mode as () => unknown)();` di loop.ts - Leading
      // whitespace-nya berubah, sisa baris identik.
      drift: {
        file: "src/core/loop.ts",
        from: "      const v = (mode as () => unknown)();",
        to: "  const v = (mode as () => unknown)();",
      },
    })
    try {
      const r = runCheck(p.source)
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/TIDAK sinkron/)
    } finally {
      rmSync(p.root, { recursive: true, force: true })
    }
  })

  // [DESIGN DECISION] Kasus kedua yang tidak bisa membunuh M5. Baris whitespace-only
  // tidak dapat dibedakan di sini: kalau M5 mengikis `^\s+`, baris
  // `"      "` menjadi `""`, jadi kedua sisi tetap sama dan drift-nya hilang.
  //
  // Ini limit NYATA dari apa yang test bisa buktikan, dan lebih jujur untuk
  // dicatat daripada dihilangkan: ekspresi trim di M5JEKTIF mengikis leading
  // whitespace, dan whitespace-only line TIDAK membawa informasi semantik apa pun
  // dalam TypeScript. Mengubah `  \n` menjadi `\n` adalah perubahan byte tanpa
  // perubahan byte tanpa perubahan makna, jadi tidak ada test yang bisa kill M5
  // lewat sini tanpa membedakan whitespace yang bermakna (indentasi kode) dari
  // tidak. Test pertama di atas melakukan tepat itu.
  //
  // Yang test ini buktikan: line COUNT masih dihitung. Normalisasi EOL tidak
  // boleh menghapus atau menambah baris.
  test("a whitespace-only line added to the vendor changes the line count", () => {
    const p = makeSource("wsline", {
      eol: "crlf",
      drift: {
        file: "src/core/loop.ts",
        from: "  try {",
        to: "      \n  try {",
      },
    })
    try {
      const r = runCheck(p.source)
      // EOL normalization must not erase a line. Whether the trim mutant
      // survives this one is documented above: whitespace-only lines carry no
      // semantic weight, and the meaningful-indentation case is covered by the
      // previous test.
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/TIDAK sinkron/)
    } finally {
      rmSync(p.root, { recursive: true, force: true })
    }
  })

  // [DESIGN DECISION] The failure at 9d79ebb. On a CRLF checkout the vendor
  // tree is CRLF; a byte-exact hash against an LF source reports drift that does
  // not exist. Both directions are checked because normalizing only one side is
  // an easy mistake, and it is mutation M2.
  test("LF source vs THIS checkout's vendor: in sync (both EOL forms, either way)", () => {
    for (const eol of ["lf", "crlf"] as const) {
      const p = makeSource(`eq-${eol}`, { eol })
      try {
        const r = runCheck(p.source)
        const note = `source=${eol} vendor=checkout`
        expect(`${note} code=${r.code}`).toBe(`${note} code=0`)
        expect(`${note} out=${r.out}`).not.toMatch(/TIDAK sinkron/)
        // A real comparison happened - not a skip. "sinkron (N file" means the
        // script actually hashed both sides and agreed.
        expect(`${note} ${r.out}`).toMatch(/sinkron \(\d+ file/)
      } finally {
        rmSync(p.root, { recursive: true, force: true })
      }
    }
  })

  // [DESIGN DECISION] Drift must survive normalization. If a semantic change
  // hidden behind an EOL difference were tolerated, the hash would be comparing
  // something weaker than content.
  test("drift is detected even when the source uses the OPPOSITE EOL from vendor", () => {
    const p = makeSource("drift-mixed", {
      eol: "crlf",
      drift: { file: "src/core/types.ts", from: "export", to: "exporT" },
    })
    try {
      const r = runCheck(p.source)
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/TIDAK sinkron/)
    } finally {
      rmSync(p.root, { recursive: true, force: true })
    }
  })

  // ── THE REAL TREE, NO SEAM AT ALL ──────────────────────────────────────────
  //
  // [DESIGN DECISION] No MINICODE_MINICORE_SOURCE here at all - this is the
  // vendor:check that `package.json` actually invokes. It is the only test that
  // proves the shipped command works on the shipped tree.
  test("the package command `vendor:check` passes against the real tree", () => {
    const r = spawnSync("bun", [SCRIPT, "--check"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 120_000,
    })
    const out = `${r.stdout}${r.stderr}`
    expect(out).not.toMatch(/TIDAK sinkron/)
    expect(r.status).toBe(0)
  })

  test("with no sibling source, the script still exits 0 and reports the tree", () => {
    const r = spawnSync("bun", [SCRIPT, "--check"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, MINICODE_MINICORE_SOURCE: join(tmpdir(), "6ae-does-not-exist-xyz") },
    })
    expect(r.status).toBe(0)
    expect(r.stdout + r.stderr).toMatch(/20 file/)
  })
})
